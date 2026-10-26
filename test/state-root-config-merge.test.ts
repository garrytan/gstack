/**
 * Privacy and egress opt-outs never become more permissive when the state
 * root moves (W1): merged keys and trust-policy deny tiers take the most
 * restrictive value across the resolved root and $HOME/.gstack. These are the
 * dedicated merge tests, so they unset GSTACK_TEST_LEGACY_ROOT (test-setup.ts)
 * and use a fake HOME instead.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readConfigKey } from '../lib/state-root';
import { repoPolicyTier, repoPolicyTierBatch } from '../lib/gbrain-repo-policy-client';

const ROOT = path.resolve(import.meta.dir, '..');
const CONFIG = path.join(ROOT, 'bin', 'gstack-config');
const POLICY = path.join(ROOT, 'bin', 'gstack-gbrain-repo-policy');

let tmp: string, home: string, legacy: string, resolved: string, env: Record<string, string>;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gstack merge's-"));
  home = path.join(tmp, 'home');
  legacy = path.join(home, '.gstack');
  resolved = path.join(tmp, 'custom');
  fs.mkdirSync(legacy, { recursive: true });
  fs.mkdirSync(resolved, { recursive: true });
  env = {
    ...(process.env as Record<string, string>),
    HOME: home, GSTACK_HOME: resolved, GSTACK_STATE_ROOT: '', GSTACK_STATE_DIR: '', CLAUDE_PLUGIN_DATA: '',
  };
  delete env.GSTACK_TEST_LEGACY_ROOT;
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function config(args: string[], extra: Record<string, string> = {}) {
  return spawnSync('bash', [CONFIG, ...args], { env: { ...env, ...extra }, encoding: 'utf-8', timeout: 20_000 });
}

describe('merged config keys', () => {
  test('a restrictive $HOME/.gstack only applies when GSTACK_TEST_LEGACY_ROOT does not redirect the second root', () => {
    fs.writeFileSync(path.join(legacy, 'config.yaml'), 'telemetry: off\n');
    fs.writeFileSync(path.join(resolved, 'config.yaml'), 'telemetry: community\n');
    expect(config(['get', 'telemetry']).stdout).toBe('off');
    const emptyLegacy = path.join(tmp, 'empty-legacy');
    fs.mkdirSync(emptyLegacy);
    expect(config(['get', 'telemetry'], { GSTACK_TEST_LEGACY_ROOT: emptyLegacy }).stdout).toBe('community');
    expect(readConfigKey('telemetry', { ...env, GSTACK_TEST_LEGACY_ROOT: emptyLegacy })).toBe('community');
    expect(readConfigKey('telemetry', env)).toBe('off');
  });

  test('codex_reviews: disabled in $HOME/.gstack survives a later unrelated set in a different resolved root', () => {
    fs.writeFileSync(path.join(legacy, 'config.yaml'), 'codex_reviews: disabled\n');
    expect(config(['set', 'explain_level', 'terse']).status).toBe(0);
    expect(config(['set', 'codex_reviews', 'enabled']).status).toBe(0);
    expect(config(['get', 'codex_reviews']).stdout).toBe('disabled');
  });

  test('proactive: true in the resolved root wins even when $HOME/.gstack says false (not a merged key)', () => {
    fs.writeFileSync(path.join(legacy, 'config.yaml'), 'proactive: false\n');
    expect(config(['set', 'proactive', 'true']).status).toBe(0);
    expect(config(['get', 'proactive']).stdout).toBe('true');
  });

  test('set names the receiving root and the overriding root, and the printed command changes the merged value', () => {
    fs.writeFileSync(path.join(legacy, 'config.yaml'), 'codex_reviews: disabled\n');
    const r = config(['set', 'codex_reviews', 'enabled']);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain(`gstack-config: set codex_reviews in ${resolved}/config.yaml, but codex_reviews is still 'disabled': ${legacy}/config.yaml sets that more restrictive value`);
    expect(r.stderr).toContain('docs/state-root.md');
    const fix = r.stderr.split('\n').find((l) => l.startsWith('fix: '))!;
    const quoted = (v: string) => spawnSync('bash', ['-c', 'printf %q "$1"', '_', v], { encoding: 'utf-8', timeout: 20_000 }).stdout;
    expect(fix).toContain(`GSTACK_STATE_ROOT=${quoted(legacy)} `);
    const command = fix.slice('fix: '.length).replace(/ \(https:.*\)$/, '');
    expect(spawnSync('bash', ['-c', command], { env, encoding: 'utf-8', timeout: 20_000 }).status).toBe(0);
    expect(config(['get', 'codex_reviews']).stdout).toBe('enabled');
  });

  test('the printed recovery command runs from an install path containing a space and an apostrophe', () => {
    const install = path.join(tmp, "inst all's", 'bin');
    fs.cpSync(path.join(ROOT, 'bin'), install, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'config.yaml'), 'codex_reviews: disabled\n');
    const r = spawnSync('bash', [path.join(install, 'gstack-config'), 'set', 'codex_reviews', 'enabled'], { env, encoding: 'utf-8', timeout: 20_000 });
    expect(r.status).toBe(0);
    const fix = r.stderr.split('\n').find((l) => l.startsWith('fix: '))!;
    const command = fix.slice('fix: '.length).replace(/ \(https:.*\)$/, '');
    const ran = spawnSync('bash', ['-c', command], { env, encoding: 'utf-8', timeout: 20_000 });
    expect(ran.stderr).toBe('');
    expect(ran.status).toBe(0);
    expect(config(['get', 'codex_reviews']).stdout).toBe('enabled');
  });

  test('a set with no overriding root stays silent', () => {
    fs.writeFileSync(path.join(legacy, 'config.yaml'), 'telemetry: anonymous\n');
    const r = config(['set', 'telemetry', 'off']);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  test('list shows the winning root for merged keys and a disagreement line when root variables differ', () => {
    fs.writeFileSync(path.join(legacy, 'config.yaml'), 'telemetry: off\n');
    fs.writeFileSync(path.join(resolved, 'config.yaml'), 'telemetry: community\nproactive: false\n');
    const plain = config(['list']).stdout;
    expect(plain).toContain(`telemetry:               off (set, ${legacy})`);
    expect(plain).toContain('proactive:               false (set)');
    expect(plain).not.toContain('root-selecting variables disagree');
    // Two variables naming the same directory agree, even when the path contains spaces.
    expect(config(['list'], { GSTACK_STATE_ROOT: resolved }).stdout).not.toContain('root-selecting variables disagree');
    const other = path.join(tmp, 'other');
    const disagree = config(['list'], { GSTACK_STATE_DIR: other }).stdout;
    expect(disagree).toContain(`# note: root-selecting variables disagree: GSTACK_HOME=${resolved} GSTACK_STATE_DIR=${other}; using ${resolved} (GSTACK_HOME wins).`);
    expect(disagree).toContain('gstack-paths --explain');
  });
});

describe('trust-policy deny tiers merge through bin/gstack-gbrain-repo-policy', () => {
  const url = 'https://github.com/acme/secret';
  function policy(args: string[], input?: string) {
    return spawnSync('bash', [POLICY, ...args], { env, input, encoding: 'utf-8', timeout: 20_000 });
  }

  test('a deny in $HOME/.gstack wins over read-write in the resolved root, for get, get --batch and the client', () => {
    expect(policy(['set', url, 'read-write']).status).toBe(0);
    fs.writeFileSync(path.join(legacy, 'gbrain-repo-policy.json'), JSON.stringify({ _schema_version: 2, 'github.com/acme/secret': 'deny' }));
    expect(policy(['get', url]).stdout.trim()).toBe('deny');
    expect(policy(['get', '--batch'], `${url}\nhttps://github.com/acme/other\n`).stdout).toBe('deny\nnone\n');
    expect(repoPolicyTier(url, env).tier).toBe('deny');
    expect(repoPolicyTierBatch([url], env).get(url)?.tier).toBe('deny');
  });

  test('a legacy store alone still denies, and a legacy read-write never loosens the resolved tier', () => {
    fs.writeFileSync(path.join(legacy, 'gbrain-repo-policy.json'), JSON.stringify({ _schema_version: 2, 'github.com/acme/secret': 'deny', 'github.com/acme/open': 'read-write' }));
    expect(repoPolicyTier(url, env).tier).toBe('deny');
    expect(policy(['get', '--batch'], `${url}\n`).stdout).toBe('deny\n');
    expect(policy(['set', 'https://github.com/acme/open', 'read-only']).status).toBe(0);
    expect(policy(['get', 'https://github.com/acme/open']).stdout.trim()).toBe('read-only');
    expect(fs.readFileSync(path.join(legacy, 'gbrain-repo-policy.json'), 'utf-8')).toContain('"read-write"');
  });
});

describe('test preload hermeticity', () => {
  test('bun test strips an inherited GSTACK_STATE_ROOT / GSTACK_STATE_DIR with one line each, and redirects the legacy root', () => {
    const probe = path.join(tmp, 'probe.test.ts');
    fs.writeFileSync(probe, [
      "import { test, expect } from 'bun:test';",
      "import { resolveStateRoot } from '" + path.join(ROOT, 'lib', 'state-root.ts').replace(/\\/g, '/') + "';",
      "test('probe', () => {",
      "  expect(process.env.GSTACK_STATE_ROOT).toBeUndefined();",
      "  expect(process.env.GSTACK_STATE_DIR).toBeUndefined();",
      "  expect(process.env.GSTACK_TEST_LEGACY_ROOT).toBeTruthy();",
      "  expect(resolveStateRoot()).toBe(process.env.GSTACK_HOME);",
      "});",
    ].join('\n'));
    const r = spawnSync('bun', ['test', '--preload', path.join(ROOT, 'test-setup.ts'), probe], {
      cwd: tmp,
      env: { ...env, GSTACK_HOME: resolved, GSTACK_STATE_ROOT: path.join(tmp, 'ambient'), GSTACK_STATE_DIR: path.join(tmp, 'ambient2') },
      encoding: 'utf-8',
      timeout: 60_000,
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('test-setup: stripped inherited GSTACK_STATE_ROOT; tests isolate state via GSTACK_HOME');
    expect(r.stderr).toContain('test-setup: stripped inherited GSTACK_STATE_DIR; tests isolate state via GSTACK_HOME');
    expect(r.stderr.match(/test-setup: stripped/g)?.length).toBe(2);
  });

  test('bun test strips an inherited brain URL, so a spread process.env never reaches a gbrain child', () => {
    const probe = path.join(tmp, 'probe.test.ts');
    fs.writeFileSync(probe, [
      "import { test, expect } from 'bun:test';",
      "import { spawnSync } from 'child_process';",
      "test('probe', () => {",
      "  const r = spawnSync('sh', ['-c', 'echo \"${GBRAIN_DATABASE_URL:-unset} ${GBRAIN_DIRECT_DATABASE_URL:-unset} ${DATABASE_URL:-unset} ${GBRAIN_HOME:-unset}\"'], { env: { ...process.env }, encoding: 'utf-8' });",
      "  expect(r.stdout.trim()).toBe('unset unset unset unset');",
      "});",
    ].join('\n'));
    const r = spawnSync('bun', ['test', '--preload', path.join(ROOT, 'test-setup.ts'), probe], {
      cwd: tmp,
      env: {
        ...env,
        GBRAIN_DATABASE_URL: 'postgresql://live-brain.invalid/brain',
        GBRAIN_DIRECT_DATABASE_URL: 'postgresql://live-brain.invalid:5432/brain',
        DATABASE_URL: 'postgresql://live-app.invalid/app',
        GBRAIN_HOME: home,
      },
      encoding: 'utf-8',
      timeout: 60_000,
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('test-setup: stripped inherited GBRAIN_DATABASE_URL');
  });
});
