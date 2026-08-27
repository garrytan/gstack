import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

const ROOT = join(import.meta.dir, '..');
const BIN = join(ROOT, 'bin');
const PUT = join(BIN, 'gstack-gbrain-put');
const CONFIG = join(BIN, 'gstack-config');

let home: string;
let calls: string;

function env(extra: Record<string, string> = {}) {
  return {
    ...process.env,
    HOME: home,
    GSTACK_HOME: home,
    USER: 'Alice Test',
    PATH: `${join(home, 'bin')}:${process.env.PATH || ''}`,
    ...extra,
  };
}

function config(...args: string[]) {
  return spawnSync(CONFIG, args, { encoding: 'utf8', env: env(), cwd: ROOT });
}

function put(args: string[], extra: Record<string, string> = {}) {
  return spawnSync(PUT, args, { encoding: 'utf8', env: env(extra), cwd: ROOT });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gstack-gbrain-put-'));
  calls = join(home, 'gbrain-call.json');
  const binDir = join(home, 'bin');
  mkdirSync(binDir, { recursive: true });
  const fake = `#!/usr/bin/env bash
python3 - "$@" <<'PYEOF'
import json, os, sys
with open(os.environ['GBRAIN_CALLS'], 'w') as f:
    json.dump(sys.argv[1:], f)
PYEOF
`;
  writeFileSync(join(binDir, 'gbrain'), fake);
  chmodSync(join(binDir, 'gbrain'), 0o755);
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('gstack-gbrain-put trust enforcement', () => {
  test('personal writes preserve the normal slug', () => {
    config('set', 'brain_trust_policy@local', 'personal');
    const result = put(['--slug', 'office-hours/pixel-fund', '--content', 'body'], { GBRAIN_CALLS: calls });
    expect(result.status).toBe(0);
    const argv = JSON.parse(readFileSync(calls, 'utf8')) as string[];
    expect(argv.slice(0, 2)).toEqual(['put', 'office-hours/pixel-fund']);
    expect(argv[2]).toBe('--content');
    expect(argv[3]).toBe('body');
  });

  test('shared-contributor namespaces and attributes artifact writes', () => {
    config('set', 'brain_trust_policy@local', 'shared-contributor');
    const content = '---\ntitle: Test\n---\nBody';
    const result = put(['--slug', 'releases/widget', '--content', content], { GBRAIN_CALLS: calls });
    expect(result.status).toBe(0);
    const argv = JSON.parse(readFileSync(calls, 'utf8')) as string[];
    expect(argv[1]).toBe('contributors/alice-test/releases/widget');
    expect(argv[3]).toContain('contributor: alice-test');
    expect(JSON.parse(result.stdout).frontmatterAdded).toBe(true);
  });

  test('shared-contributor overwrites spoofed attribution in leading frontmatter', () => {
    config('set', 'brain_trust_policy@local', 'shared-contributor');
    const content = '---\ntitle: Test\ncontributor: mallory\n---\nBody\ncontributor: body-text';
    const result = put(['--slug', 'releases/widget', '--content', content], { GBRAIN_CALLS: calls });
    expect(result.status).toBe(0);
    const argv = JSON.parse(readFileSync(calls, 'utf8')) as string[];
    const frontmatter = argv[3].split('\n').slice(1, -3).join('\n');
    expect(Bun.YAML.parse(frontmatter)).toEqual({ contributor: 'alice-test', title: 'Test' });
    expect(argv[3]).not.toContain('contributor: mallory');
    expect(argv[3]).toContain('contributor: body-text');
  });

  test('shared-contributor removes quoted contributor keys before attribution', () => {
    config('set', 'brain_trust_policy@local', 'shared-contributor');
    const content = '---\n"contributor": mallory\n\'contributor\': eve\ntitle: Test\n---\nBody';
    const result = put(['--slug', 'releases/widget', '--content', content], { GBRAIN_CALLS: calls });
    expect(result.status).toBe(0);
    const argv = JSON.parse(readFileSync(calls, 'utf8')) as string[];
    expect(argv[3]).toContain('contributor: alice-test');
    expect(argv[3]).not.toContain('mallory');
    expect(argv[3]).not.toContain('eve');
  });

  test('shared-contributor normalizes semantic YAML contributor keys', () => {
    config('set', 'brain_trust_policy@local', 'shared-contributor');
    for (const encoded of ['"contri\\u0062utor": mallory', '!!str contributor: mallory']) {
      const content = `---\n${encoded}\ntitle: Test\n---\nBody`;
      const result = put(['--slug', 'releases/widget', '--content', content], { GBRAIN_CALLS: calls });
      expect(result.status).toBe(0);
      const argv = JSON.parse(readFileSync(calls, 'utf8')) as string[];
      const lines = argv[3].split('\n');
      const end = lines.findIndex((line, index) => index > 0 && line === '---');
      const parsed = Bun.YAML.parse(lines.slice(1, end).join('\n'));
      expect(parsed).toEqual({ contributor: 'alice-test', title: 'Test' });
      expect(argv[3]).not.toContain('mallory');
    }
  });

  test('shared-contributor refuses malformed frontmatter instead of writing', () => {
    config('set', 'brain_trust_policy@local', 'shared-contributor');
    const result = put(['--slug', 'releases/widget', '--content', '---\n[not-a-mapping]\n---\nBody'], { GBRAIN_CALLS: calls });
    expect(result.status).toBe(4);
    expect(result.stderr).toContain('could not safely normalize');
  });

  test('shared-contributor skips personal calibration writes', () => {
    config('set', 'brain_trust_policy@local', 'shared-contributor');
    const result = put(['--slug', 'takes/bet', '--content', 'secretless', '--kind', 'calibration']);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).action).toBe('skip');
  });

  test('shared read-only requires approval and unset requires setup', () => {
    config('set', 'brain_trust_policy@local', 'shared');
    const shared = put(['--slug', 'releases/widget', '--content', 'body', '--dry-run']);
    expect(shared.status).toBe(3);
    expect(JSON.parse(shared.stdout).action).toBe('approval-required');
    const approved = put(['--slug', 'releases/widget', '--content', 'body', '--approved', '--dry-run']);
    expect(approved.status).toBe(0);
    expect(JSON.parse(approved.stdout).action).toBe('write');

    config('set', 'brain_trust_policy@local', 'unset');
    const unset = put(['--slug', 'releases/widget', '--content', 'body', '--dry-run']);
    expect(unset.status).toBe(4);
    expect(JSON.parse(unset.stdout).action).toBe('setup-required');
  });

  test('malformed endpoint configuration never inherits local personal trust', () => {
    config('set', 'brain_trust_policy@local', 'personal');
    writeFileSync(join(home, '.claude.json'), '{broken');
    const result = put(['--slug', 'releases/widget', '--content', 'body', '--dry-run']);
    expect(result.status).toBe(4);
    expect(JSON.parse(result.stdout).policy).toBe('unset');
  });

  test('configured remote entry without a URL never inherits local personal trust', () => {
    config('set', 'brain_trust_policy@local', 'personal');
    writeFileSync(join(home, '.claude.json'), JSON.stringify({
      mcpServers: { gbrain: { type: 'http', url: '' } },
    }));
    const result = put(['--slug', 'releases/widget', '--content', 'body', '--dry-run']);
    expect(result.status).toBe(4);
    expect(JSON.parse(result.stdout).policy).toBe('unset');
  });
});
