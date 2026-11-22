/**
 * State-root isolation guard (GST-1659). A guarded test file must keep every
 * write under its own temp roots whatever the parent shell exported. Each file
 * runs in a child `bun test` with no bunfig preload (test-setup.ts strips two
 * state-root variables, but only for runs that load this repository's
 * bunfig.toml), with GSTACK_STATE_ROOT, GSTACK_HOME, GSTACK_STATE_DIR, a live
 * CLAUDE_PLUGIN_DATA and HOME each pointed at a sentinel directory holding a
 * config.yaml. It passes only when the file's tests pass and every sentinel is
 * byte-for-byte unchanged. Spawn helpers: test/helpers/state-root-isolation.ts.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { bunIsolationArgs } from '../lib/bun-isolation';
import { tree } from './helpers/install-fixture';

const ROOT = path.resolve(import.meta.dir, '..');
const GUARDED = ['test/update-channel.test.ts', 'test/update-channel-setup.test.ts', 'test/outside-voice-preflight.test.ts'];
const SENTINELS: Record<string, string> = { GSTACK_STATE_ROOT: 'state-root', GSTACK_HOME: 'gstack-home', GSTACK_STATE_DIR: 'state-dir', CLAUDE_PLUGIN_DATA: 'plugin-data', HOME: 'home' };

const bases: string[] = [];
afterEach(() => { for (const b of bases.splice(0)) fs.rmSync(b, { recursive: true, force: true }); });

const flatten = (node: unknown, prefix = ''): Record<string, string> =>
  node !== null && typeof node === 'object' && !('link' in node)
    ? Object.assign({}, ...Object.entries(node).map(([name, child]) => flatten(child, prefix + name + '/')))
    : { [prefix.slice(0, -1)]: JSON.stringify(node) };

/** Run one test file with the whole state-root chain and HOME exported to sentinels; report its exit code and every sentinel path it changed. */
async function runUnderSentinels(file: string) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-sentinel-')));
  bases.push(base);
  const env: Record<string, string> = { ...(process.env as Record<string, string>), CLAUDE_PLUGIN_ROOT: '/plugins/gstack', USERPROFILE: path.join(base, 'home'),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(os.tmpdir(), 'gstack-sentinel-bun-cache') };
  for (const [name, dir] of Object.entries(SENTINELS)) {
    env[name] = path.join(base, dir);
    const config = path.join(base, dir, name === 'HOME' ? '.gstack' : '', 'config.yaml');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, 'telemetry: off\n');
  }
  const before = flatten(tree(base));
  const child = Bun.spawn([process.execPath, ...bunIsolationArgs(), 'test', file], { cwd: ROOT, env, stdout: 'pipe', stderr: 'pipe', timeout: 300_000 });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const after = flatten(tree(base));
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(k => before[k] !== after[k]).sort();
  return { code, changed, output: stdout + stderr };
}

describe.skipIf(process.platform === 'win32')('state-root isolation guard', () => {
  // Value: protects=each guarded file passes with every state-root variable and HOME exported, and leaves all of them untouched; fails_when=a spawn in the
  // file inherits the parent's GSTACK_STATE_ROOT, GSTACK_HOME, GSTACK_STATE_DIR, CLAUDE_PLUGIN_DATA or HOME and writes the user's real config (GST-1659);
  // why_new=test-setup.ts hid the leak only for runs that load bunfig.toml; seam=sentinel directories stand in for the user's state roots;
  // no_claim=files not in GUARDED, and writes outside the chain and HOME
  for (const file of GUARDED) {
    test(`${file} passes and writes nothing to an exported state root or HOME`, async () => {
      const r = await runUnderSentinels(file);
      expect(r.changed, r.output).toEqual([]);
      expect(r.code, r.output).toBe(0);
    }, 330_000);
  }

  // Value: protects=the guard sees a write through an inherited state root; fails_when=the sentinel diff or the exported chain stops detecting the
  // original bug (gstack-config set on the inherited environment); why_new=negative control for the guard above; seam=a planted test file; no_claim=none
  test('a planted test that runs gstack-config set on the inherited environment is caught writing the exported GSTACK_STATE_ROOT', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-sentinel-planted-')));
    bases.push(dir);
    const planted = path.join(dir, 'planted-leak.test.ts');
    fs.writeFileSync(planted, `import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
test('leaks', () => {
  expect(spawnSync(${JSON.stringify(path.join(ROOT, 'bin', 'gstack-config'))}, ['set', 'update_channel', 'stable'], { timeout: 30_000 }).status).toBe(0);
});
`);
    const r = await runUnderSentinels(planted);
    expect(r.code, r.output).toBe(0);
    expect(r.changed).toEqual(['state-root/config.yaml']);
  }, 60_000);
});
