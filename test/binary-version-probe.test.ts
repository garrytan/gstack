import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// #2595: setup and gstack-doctor detect Smart App Control by launching each
// compiled binary with --version. Each entry must answer before any server
// start, discovery scan or network call, or the probe would misclassify a
// healthy build. Runs the source entries; the compiled binaries embed them.
const ROOT = path.resolve(import.meta.dir, '..');
const tmps: string[] = [];
afterEach(() => { for (const t of tmps.splice(0)) fs.rmSync(t, { recursive: true, force: true }); });

function runVersion(entry: string) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-version-probe-'));
  tmps.push(tmp);
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  const r = spawnSync(process.execPath, ['run', path.join(ROOT, entry), '--version'], {
    cwd: tmp,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      BROWSE_STATE_FILE: path.join(tmp, 'state', '.gstack', 'browse.json'),
      GSTACK_STATE_ROOT: path.join(tmp, 'gstack-state'),
      HTTPS_PROXY: 'http://127.0.0.1:9',
      HTTP_PROXY: 'http://127.0.0.1:9',
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { ...r, tmp, home };
}

describe('compiled-binary entries answer --version early (#2595)', () => {
  for (const entry of ['browse/src/cli.ts', 'browse/src/find-browse.ts', 'design/src/cli.ts', 'make-pdf/src/cli.ts', 'bin/gstack-global-discover.ts']) {
    test(`${entry} --version exits 0 with one line and no side effects`, () => {
      const r = runVersion(entry);
      expect(r.status).toBe(0);
      expect(r.stdout.trim().split('\n')).toHaveLength(1);
      expect(r.stdout.trim()).not.toBe('');
      expect(r.stderr).not.toContain('Starting server');
      expect(r.stderr).not.toMatch(/Unknown|Usage/);
      expect(fs.existsSync(path.join(r.tmp, 'state'))).toBe(false);
      expect(fs.existsSync(path.join(r.tmp, 'gstack-state'))).toBe(false);
      // `bun run` itself may create its runtime cache under the home; the entry writes nothing.
      expect(fs.readdirSync(r.home).filter(name => name !== '.bun' && name !== 'AppData')).toEqual([]);
    });
  }

  test('find-browse --version does not search for browse', () => {
    expect(runVersion('browse/src/find-browse.ts').stdout).not.toContain('browse/dist/browse');
  });

  test('gstack-global-discover --version prints the checkout VERSION', () => {
    const version = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
    expect(runVersion('bin/gstack-global-discover.ts').stdout.trim()).toBe(version);
  });
});
