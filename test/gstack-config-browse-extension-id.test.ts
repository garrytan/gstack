/**
 * browse_extension_id (D1): the one override for which Chrome extension the
 * browse daemon trusts on /extension-token and the terminal-agent /ws. It
 * lives only in gstack-config (never an env var a project .env could set),
 * defaults to empty (gstack's published extension), and rejects anything
 * that is not a Chrome extension ID.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const CONFIG_BIN = path.join(path.resolve(import.meta.dir, '..'), 'bin', 'gstack-config');
const ID = 'abcdefghijklmnopabcdefghijklmnop';
let state: string;

function cfg(args: string[]) {
  const r = spawnSync('bash', [CONFIG_BIN, ...args], {
    encoding: 'utf-8', timeout: 30_000,
    env: { ...process.env, HOME: state, GSTACK_STATE_ROOT: state, GSTACK_HOME: state },
  });
  return { code: r.status ?? -1, out: (r.stdout ?? '').trim(), err: r.stderr ?? '' };
}

beforeEach(() => { state = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-cfg-extid-')); });
afterEach(() => { fs.rmSync(state, { recursive: true, force: true }); });

describe('browse_extension_id config key (D1)', () => {
  test('is a known key whose default is empty (exit 0)', () => {
    expect(cfg(['get', 'browse_extension_id'])).toMatchObject({ code: 0, out: '' });
  });

  test('a Chrome extension ID round-trips and "" clears it', () => {
    expect(cfg(['set', 'browse_extension_id', ID]).code).toBe(0);
    expect(cfg(['get', 'browse_extension_id']).out).toBe(ID);
    expect(cfg(['set', 'browse_extension_id', '']).code).toBe(0);
    expect(cfg(['get', 'browse_extension_id'])).toMatchObject({ code: 0, out: '' });
  });

  test('a value that is not an extension ID is rejected and the stored one kept', () => {
    cfg(['set', 'browse_extension_id', ID]);
    for (const bad of ['*', 'chrome-extension://' + ID, ID.toUpperCase(), ID.slice(1), ID + 'a', 'abcdefghijklmnopqrstuvwxyzabcdef']) {
      const r = cfg(['set', 'browse_extension_id', bad]);
      expect(r.code, bad).toBe(1);
      expect(r.err).toContain('Existing value left unchanged');
    }
    expect(cfg(['get', 'browse_extension_id']).out).toBe(ID);
  });

  test('appears in list and defaults', () => {
    expect(cfg(['list']).out).toMatch(/browse_extension_id:\s+\(default\)/);
    expect(cfg(['defaults']).out).toMatch(/browse_extension_id:/);
  });
});
