import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { capture } from '../lib/cso/snapshot';
import { CsoError } from '../lib/cso/contracts';
import { newRun } from '../lib/cso/state';

// An unreadable secret-like file (a Claude Code sandbox deny rule such as Read(**/.env*), or a chmod 000 file) is
// already kept out of snapshot/, so start reports it as an unread input instead of aborting the whole audit (#4395).
const roots: string[] = [];
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'cso-unreadable-')); roots.push(p); return p; };
afterEach(() => { for (const p of roots.splice(0)) { try { fs.chmodSync(path.join(p, '.env.example'), 0o600); } catch {} try { fs.chmodSync(path.join(p, 'app.ts'), 0o600); } catch {} fs.rmSync(p, { recursive: true, force: true }); } });
let originalState: string | undefined, state = '';
beforeAll(() => { originalState = process.env.GSTACK_HOME; state = fs.mkdtempSync(path.join(os.tmpdir(), 'cso-unreadable-state-')); process.env.GSTACK_HOME = state; });
afterAll(() => { if (originalState === undefined) delete process.env.GSTACK_HOME; else process.env.GSTACK_HOME = originalState; fs.rmSync(state, { recursive: true, force: true }); });
function git(repo: string, ...args: string[]) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, HOME: repo, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, timeout: 30_000 });
  if (r.status) throw new Error(r.stderr);
}
function repo() {
  const p = tmp();
  git(p, 'init', '-q');
  git(p, 'config', 'user.email', 'fixture@example.test');
  git(p, 'config', 'user.name', 'Fixture');
  fs.writeFileSync(path.join(p, '.env.example'), 'FOO=bar\n');
  fs.writeFileSync(path.join(p, 'app.ts'), 'export const x = 1;\n');
  git(p, 'add', '.');
  git(p, 'commit', '-qm', 'base');
  return p;
}
const permissionsBind = process.platform !== 'win32' && process.getuid?.() !== 0;

describe('cso snapshot with an unreadable secret-like file (#4395)', () => {
  // Value: protects=a tracked .env.example that cannot be opened becomes an unread, withheld input and the capture
  //   continues; fails_when=open's EACCES aborts start with UNSAFE_PATH; why_new=no capture case had an unreadable
  //   file; seam=none
  test.skipIf(!permissionsBind)('a file that cannot be opened is withheld as unread and the capture continues', async () => {
    const p = repo();
    fs.chmodSync(path.join(p, '.env.example'), 0o000);
    const run = newRun(p), m = await capture(p, run.dir);
    const entry = m.entries.find(e => e.path === '.env.example')!;
    expect(entry.originalHash).toBe('not-read');
    expect(entry.executionHash).toBeUndefined();
    expect(entry.transformation).toMatch(/^withheld: .*unreadable \(EACCES\)/);
    expect(fs.existsSync(path.join(run.dir, 'readable', '.env.example'))).toBe(false);
    expect(m.entries.find(e => e.path === 'app.ts')?.executionHash).toBeDefined();
  });

  // Value: protects=the sandbox case, where even lstat is denied (EPERM), is withheld the same way; fails_when=the raw
  //   EPERM escapes and start reports a generic INVALID_SCHEMA; why_new=the case above denies only open;
  //   seam=fs.lstatSync on that one path
  test('a file whose lstat is denied is withheld as unread and the capture continues', async () => {
    const p = repo(), denied = path.join(p, '.env.example'), real = fs.lstatSync;
    const spy = spyOn(fs, 'lstatSync').mockImplementation(((file: any, ...args: any[]) => {
      if (String(file) === denied) throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      return (real as any)(file, ...args);
    }) as any);
    try {
      const m = await capture(p, newRun(p).dir);
      const entry = m.entries.find(e => e.path === '.env.example')!;
      expect([entry.originalHash, entry.bytes]).toEqual(['not-read', 0]);
      expect(entry.transformation).toMatch(/^withheld: .*unreadable \(EPERM\)/);
    } finally { spy.mockRestore(); }
  });

  // Value: protects=an unreadable ordinary source file still stops the capture, so the exemption covers only paths
  //   already excluded as secrets; fails_when=any unreadable file is silently withheld; why_new=the exemption is new; seam=none
  test.skipIf(!permissionsBind)('an unreadable ordinary source file still refuses', async () => {
    const p = repo();
    fs.chmodSync(path.join(p, 'app.ts'), 0o000);
    const error = await capture(p, newRun(p).dir).then(() => null, e => e);
    expect(error).toBeInstanceOf(CsoError);
    expect((error as CsoError).code).toBe('UNSAFE_PATH');
  });

  // Value: protects=an ordinary source file whose lstat is denied still stops the capture; fails_when=the lstat catch
  //   drops its exclusion check and silently withholds app.ts; why_new=the lstat exemption is new; seam=fs.lstatSync on that one path
  test('an ordinary source file whose lstat is denied still refuses', async () => {
    const p = repo(), denied = path.join(p, 'app.ts'), real = fs.lstatSync;
    const spy = spyOn(fs, 'lstatSync').mockImplementation(((file: any, ...args: any[]) => {
      if (String(file) === denied) throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      return (real as any)(file, ...args);
    }) as any);
    try {
      const error = await capture(p, newRun(p).dir).then(() => null, e => e);
      expect((error as NodeJS.ErrnoException | null)?.code).toBe('EPERM');
    } finally { spy.mockRestore(); }
  });

  // Value: protects=a withheld lstat-denied path that becomes readable before the end of capture is a race, not a pass;
  //   fails_when=the end-of-capture re-check accepts a path it can now stat; why_new=the re-check is new;
  //   seam=fs.lstatSync on that one path, denied on every call but the last (counted from a fully denied capture)
  test('an lstat-denied secret that becomes readable before the end of capture is a SNAPSHOT_RACE', async () => {
    const p = repo(), denied = path.join(p, '.env.example'), real = fs.lstatSync;
    let calls = 0, allow = Infinity;
    const spy = spyOn(fs, 'lstatSync').mockImplementation(((file: any, ...args: any[]) => {
      if (String(file) === denied && ++calls < allow) throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      return (real as any)(file, ...args);
    }) as any);
    try {
      await capture(p, newRun(p).dir);
      allow = calls;
      calls = 0;
      const error = await capture(p, newRun(p).dir).then(() => null, e => e);
      expect(error).toBeInstanceOf(CsoError);
      expect((error as CsoError).code).toBe('SNAPSHOT_RACE');
    } finally { spy.mockRestore(); }
  });
});
