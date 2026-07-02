import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { safeUnlink, safeKill, isProcessAlive } from '../src/error-handling';

describe('safeUnlink', () => {
  test('removes an existing file', () => {
    const tmp = path.join(os.tmpdir(), `test-safeUnlink-${Date.now()}`);
    fs.writeFileSync(tmp, 'hello');
    safeUnlink(tmp);
    expect(fs.existsSync(tmp)).toBe(false);
  });

  test('ignores ENOENT (file does not exist)', () => {
    expect(() => safeUnlink('/tmp/nonexistent-file-' + Date.now())).not.toThrow();
  });

  test('rethrows non-ENOENT errors', () => {
    // Attempt to unlink a directory — throws EPERM/EISDIR
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-safeUnlink-'));
    expect(() => safeUnlink(dir)).toThrow();
    fs.rmdirSync(dir);
  });
});

describe('safeKill', () => {
  test('sends signal to a running process', () => {
    // signal 0 is a no-op existence check — safe to send to self
    expect(() => safeKill(process.pid, 0)).not.toThrow();
  });

  test('ignores ESRCH (process does not exist)', () => {
    // PID 99999999 is extremely unlikely to exist
    expect(() => safeKill(99999999, 0)).not.toThrow();
  });
});

describe('isProcessAlive', () => {
  test('returns true for current process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  test('returns false for non-existent process', () => {
    expect(isProcessAlive(99999999)).toBe(false);
  });

  test('returns true for a live but unsignallable process (EPERM ⇒ alive)', () => {
    // PID 4 = System on Windows, PID 1 = init/launchd on POSIX. Both are
    // always alive; signalling them as an unprivileged user throws EPERM,
    // which must read as "alive" (as root/admin the probe just succeeds).
    const protectedPid = process.platform === 'win32' ? 4 : 1;
    expect(isProcessAlive(protectedPid)).toBe(true);
  });

  test('never spawns a subprocess (no tasklist on Windows)', () => {
    // Static tripwire: the pre-#2151 Windows branch shelled out to
    // `tasklist`, which flashed a console window from console-less daemons
    // on every watchdog tick (#1952) and silently reported live agents as
    // dead when tasklist exceeded its timeout — triggering split-brain
    // respawns (#2151). signal-0 is a pure syscall on every platform.
    const src = fs.readFileSync(
      path.resolve(import.meta.dir, '..', 'src', 'error-handling.ts'),
      'utf-8',
    );
    // Reject only actual invocations — the doc comment on isProcessAlive
    // may mention tasklist when explaining what the signal-0 probe replaced.
    expect(src).not.toMatch(/spawnSync\s*\(\s*\[?\s*['"]tasklist/);
    expect(src).not.toMatch(/spawn\s*\(\s*\[?\s*['"]tasklist/);
  });
});
