import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
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

  test('treats a live-but-EPERM process as alive (#1952)', () => {
    // PID 1 (init/launchd) exists but a non-root user can't signal it →
    // process.kill(1, 0) throws EPERM, which means alive, not dead.
    // (Skip when running as root, where signalling PID 1 is permitted.)
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;
    let threwEPERM = false;
    try {
      process.kill(1, 0);
    } catch (err: any) {
      threwEPERM = err?.code === 'EPERM';
    }
    if (threwEPERM) expect(isProcessAlive(1)).toBe(true);
  });

  // Regression tripwire for #1952: isProcessAlive must never spawn a child
  // process to probe a PID. The Windows branch used to shell out to `tasklist`,
  // which Windows gives its own console window — flashing a conhost.exe window
  // every watchdog tick (default 60s) for the whole session. signal-0 is a pure
  // syscall on all platforms (OpenProcess on Windows), so the source must not
  // reintroduce tasklist or a spawn in this probe.
  test('isProcessAlive source spawns nothing (no Windows console flash, #1952)', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'error-handling.ts'),
      'utf-8'
    );
    const start = src.indexOf('export function isProcessAlive');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n}', start));
    expect(body).not.toMatch(/tasklist/i);
    expect(body).not.toMatch(/spawnSync|spawn\(/);
  });
});
