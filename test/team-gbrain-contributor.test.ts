import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { generateBrainSyncBlock } from '../scripts/resolvers/preamble/generate-brain-sync-block';
import { HOST_PATHS } from '../scripts/resolvers/types';

const ROOT = join(import.meta.dir, '..');
const CONFIG = join(ROOT, 'bin', 'gstack-config');
const SYNC = join(ROOT, 'bin', 'gstack-brain-sync');
let tempRoot: string;

function run(bin: string, args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  return spawnSync(bin, args, {
    cwd: opts.cwd || ROOT,
    encoding: 'utf8',
    env: { ...process.env, HOME: tempRoot, GSTACK_HOME: tempRoot, ...(opts.env || {}) },
  });
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'team-gbrain-contributor-'));
});

afterEach(() => rmSync(tempRoot, { recursive: true, force: true }));

describe('shared GBrain contributor mode', () => {
  test('renders the serialized pull helper at skill start', () => {
    const out = generateBrainSyncBlock({
      skillName: 'ship',
      tmplPath: '/tmp/ship/SKILL.md.tmpl',
      host: 'claude',
      paths: HOST_PATHS.claude,
    });
    expect(out).toContain('if _BRAIN_PULL_OUTPUT=$("$_BRAIN_SYNC_BIN" --pull-if-due 2>&1)');
    expect(out).toContain('printf \'%s\\n\' "$_BRAIN_PULL_OUTPUT"');
    expect(out).not.toContain('--pull-if-due 2>/dev/null');
  });

  test('configures safe defaults and preserves explicit contributor scope', () => {
    let result = run(CONFIG, ['configure-brain-trust', 'personal']);
    expect(result.status).toBe(0);
    expect(run(CONFIG, ['get', 'artifacts_sync_mode']).stdout.trim()).toBe('full');

    run(CONFIG, ['set', 'artifacts_sync_mode', 'off']);
    result = run(CONFIG, ['configure-brain-trust', 'shared-contributor']);
    expect(result.status).toBe(0);
    expect(run(CONFIG, ['get', 'artifacts_sync_mode']).stdout.trim()).toBe('artifacts-only');

    run(CONFIG, ['set', 'artifacts_sync_mode', 'full']);
    run(CONFIG, ['configure-brain-trust', 'shared-contributor']);
    expect(run(CONFIG, ['get', 'artifacts_sync_mode']).stdout.trim()).toBe('full');

    run(CONFIG, ['configure-brain-trust', 'shared']);
    expect(run(CONFIG, ['get', 'artifacts_sync_mode']).stdout.trim()).toBe('off');
  });

  test('executes contributor pull boundaries and stamps only success', () => {
    const artifacts = join(tempRoot, 'artifacts');
    const remote = join(tempRoot, 'remote.git');
    mkdirSync(artifacts);
    run('git', ['init', '--bare', '-q', '-b', 'main', remote]);
    run('git', ['init', '-q', '-b', 'main'], { cwd: artifacts });
    run('git', ['config', 'user.email', 'test@example.com'], { cwd: artifacts });
    run('git', ['config', 'user.name', 'Test'], { cwd: artifacts });
    writeFileSync(join(artifacts, 'seed.md'), 'seed\n');
    run('git', ['add', 'seed.md'], { cwd: artifacts });
    run('git', ['commit', '-q', '-m', 'seed'], { cwd: artifacts });
    run('git', ['remote', 'add', 'origin', remote], { cwd: artifacts });
    run('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: artifacts });

    const fakeBin = join(tempRoot, 'fake-bin');
    mkdirSync(fakeBin);
    const realDate = Bun.which('date') || '/bin/date';
    writeFileSync(join(fakeBin, 'date'), `#!/usr/bin/env bash\nif [ "\${1:-}" = "+%s" ]; then echo 1000; else exec "${realDate}" "$@"; fi\n`);
    chmodSync(join(fakeBin, 'date'), 0o755);
    const syncEnv = {
      GSTACK_HOME: artifacts,
      PATH: `${fakeBin}:${process.env.PATH || ''}`,
    };
    const cfg = (args: string[]) => run(CONFIG, args, { cwd: artifacts, env: syncEnv });
    const pull = () => run(SYNC, ['--pull-if-due'], { cwd: artifacts, env: syncEnv });
    const stamp = join(artifacts, '.brain-last-pull');

    cfg(['configure-brain-trust', 'shared-contributor']);
    writeFileSync(stamp, '701\n'); // age 299
    pull();
    expect(readFileSync(stamp, 'utf8').trim()).toBe('701');

    writeFileSync(stamp, '700\n'); // age 300
    pull();
    expect(readFileSync(stamp, 'utf8').trim()).toBe('1000');

    cfg(['configure-brain-trust', 'personal']);
    writeFileSync(stamp, '700\n'); // personal TTL is one day
    pull();
    expect(readFileSync(stamp, 'utf8').trim()).toBe('700');

    cfg(['configure-brain-trust', 'shared-contributor']);
    writeFileSync(stamp, 'malformed\n');
    pull();
    expect(readFileSync(stamp, 'utf8').trim()).toBe('1000');

    rmSync(stamp, { force: true });
    run('git', ['remote', 'set-url', 'origin', join(tempRoot, 'missing.git')], { cwd: artifacts });
    const failed = pull();
    expect(failed.status).toBe(1);
    expect(existsSync(stamp)).toBe(false);
    expect(failed.stderr).toContain('artifact pull failed');
    expect(JSON.parse(readFileSync(join(artifacts, '.brain-sync-status.json'), 'utf8')).status).toBe('pull_failed');
  });

  test('shared read-only and unset policies cannot drain or push queued artifacts', () => {
    const artifacts = join(tempRoot, 'artifacts');
    mkdirSync(join(artifacts, '.git'), { recursive: true });
    const queueDir = join(artifacts, '.brain-queue.d');
    mkdirSync(queueDir, { recursive: true });
    const queued = join(queueDir, '1.json');
    writeFileSync(queued, '{"file":"projects/x/plans/a.md"}\n');
    const gatedEnv = { GSTACK_HOME: artifacts };

    run(CONFIG, ['set', 'brain_trust_policy@local', 'shared'], { env: gatedEnv });
    run(CONFIG, ['set', 'artifacts_sync_mode', 'full'], { env: gatedEnv });
    expect(run(SYNC, ['--once'], { env: gatedEnv }).status).toBe(0);
    expect(existsSync(queued)).toBe(true);

    run(CONFIG, ['set', 'brain_trust_policy@local', 'unset'], { env: gatedEnv });
    expect(run(SYNC, ['--once'], { env: gatedEnv }).status).toBe(0);
    expect(existsSync(queued)).toBe(true);
  });

  test('setup distinguishes contributor access from shared read-only access', () => {
    const setup = readFileSync(join(ROOT, 'setup-gbrain', 'SKILL.md.tmpl'), 'utf8');
    expect(setup).toContain('Shared contributor');
    expect(setup).toContain('Shared read-only');
    expect(setup).toContain('artifacts_sync_mode artifacts-only');
  });

  test('team guide requires server-side indexing after pushes', () => {
    const docs = readFileSync(join(ROOT, 'docs', 'gbrain-sync.md'), 'utf8');
    expect(docs).toContain('Configure the shared GBrain service to index');
    expect(docs).toContain('webhook or a short server-side pull schedule');
  });
});
