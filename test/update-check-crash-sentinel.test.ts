import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// #1974: gstack-update-check runs under set -e, and its "up to date" signal
// is SILENCE — so any unguarded crash used to exit quietly and read as
// up-to-date (a real 45-release silent-staleness incident). The ERR trap must
// convert a crash into a visible CHECK_FAILED line, and the healthy path must
// stay silent.

const ROOT = path.resolve(import.meta.dir, '..');
const SCRIPT = path.join(ROOT, 'bin', 'gstack-update-check');

function run(env: Record<string, string>) {
  return spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 15000,
  });
}

describe('gstack-update-check crash sentinel (#1974)', () => {
  test('a mid-script crash emits CHECK_FAILED instead of silent up-to-date', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-upd-'));
    try {
      // STATE_DIR pointing at a FILE makes the state mkdir fail — an
      // unguarded failure representative of any mid-script crash.
      const asFile = path.join(dir, 'statefile');
      fs.writeFileSync(asFile, '');
      const r = run({ GSTACK_STATE_DIR: asFile, GSTACK_REMOTE_URL: 'file:///dev/null' });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('CHECK_FAILED');
      expect(r.stdout).toContain('UNKNOWN');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('healthy up-to-date path stays silent (no sentinel noise)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-upd-'));
    try {
      const r = run({ GSTACK_STATE_DIR: path.join(dir, 'state'), GSTACK_REMOTE_URL: 'file:///dev/null' });
      expect(r.status).toBe(0);
      expect(r.stdout).not.toContain('CHECK_FAILED');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
