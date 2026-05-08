import { describe, test, expect } from 'bun:test';
import {
  shouldSpawnXvfb,
  isOurXvfb,
  readPidStartTime,
  readPidCmdline,
  cleanupXvfb,
  pickFreeDisplay,
  isDisplayFree,
} from '../src/xvfb';

const HAS_XVFB = (() => {
  if (process.platform !== 'linux') return false;
  const result = Bun.spawnSync(['which', 'Xvfb'], { stdout: 'pipe', stderr: 'pipe' });
  return result.exitCode === 0;
})();

describe('shouldSpawnXvfb', () => {
  test('skips when not headed', () => {
    const d = shouldSpawnXvfb({}, 'linux');
    expect(d.spawn).toBe(false);
    expect(d.reason).toContain('not headed');
  });

  test('skips on macOS even when headed', () => {
    const d = shouldSpawnXvfb({ BROWSE_HEADED: '1' }, 'darwin');
    expect(d.spawn).toBe(false);
    expect(d.reason).toContain('darwin');
  });

  test('skips on Windows even when headed', () => {
    const d = shouldSpawnXvfb({ BROWSE_HEADED: '1' }, 'win32');
    expect(d.spawn).toBe(false);
    expect(d.reason).toContain('win32');
  });

  test('skips on Linux when DISPLAY already set', () => {
    const d = shouldSpawnXvfb({ BROWSE_HEADED: '1', DISPLAY: ':0' }, 'linux');
    expect(d.spawn).toBe(false);
    expect(d.reason).toContain('DISPLAY=:0');
  });

  test('skips on Linux when WAYLAND_DISPLAY set (codex F2)', () => {
    const d = shouldSpawnXvfb({ BROWSE_HEADED: '1', WAYLAND_DISPLAY: 'wayland-0' }, 'linux');
    expect(d.spawn).toBe(false);
    expect(d.reason).toContain('Wayland');
  });

  test('spawns on Linux + headed + no DISPLAY/WAYLAND_DISPLAY', () => {
    const d = shouldSpawnXvfb({ BROWSE_HEADED: '1' }, 'linux');
    expect(d.spawn).toBe(true);
  });
});

describe('isOurXvfb (PID validation)', () => {
  test('returns false when pid is 0', () => {
    expect(isOurXvfb(0, 'whatever')).toBe(false);
  });

  test('returns false when startTime is empty', () => {
    expect(isOurXvfb(process.pid, '')).toBe(false);
  });

  test('returns false when cmdline does not contain Xvfb', () => {
    // Current bun process is not Xvfb. PID-correct, cmdline-wrong → reject.
    const myStart = readPidStartTime(process.pid);
    expect(isOurXvfb(process.pid, myStart)).toBe(false);
  });

  test('returns false when start-time differs (PID reuse defense)', () => {
    // Even if we somehow had the right PID, a stale start-time means it's a
    // different process. We never fake the cmdline test, so this assertion
    // is structural: the function must not pass on stale start-time alone.
    expect(isOurXvfb(process.pid, 'Mon Jan  1 00:00:00 1970')).toBe(false);
  });
});

describe('readPidStartTime', () => {
  test('returns non-empty for current process', () => {
    if (process.platform === 'win32') return; // ps not available
    const t = readPidStartTime(process.pid);
    expect(t.length).toBeGreaterThan(0);
  });

  test('returns empty string for nonexistent PID', () => {
    expect(readPidStartTime(99999999)).toBe('');
  });
});

describe('readPidCmdline', () => {
  test('returns non-empty for current process on Linux', () => {
    if (process.platform !== 'linux') return; // /proc unavailable
    const c = readPidCmdline(process.pid);
    expect(c.length).toBeGreaterThan(0);
  });

  test('returns empty for nonexistent PID', () => {
    expect(readPidCmdline(99999999)).toBe('');
  });
});

describe('cleanupXvfb', () => {
  test('no-op when pid is 0', () => {
    expect(() => cleanupXvfb({ pid: 0, startTime: '', display: ':99' })).not.toThrow();
  });

  test('no-op when not our Xvfb (won\'t kill unrelated process)', () => {
    // Pass the current bun process's PID + a stale start-time. cleanupXvfb
    // should refuse to send signals because cmdline doesn't match Xvfb.
    expect(() => cleanupXvfb({
      pid: process.pid,
      startTime: 'Mon Jan  1 00:00:00 1970',
      display: ':99',
    })).not.toThrow();
    // The current process is still alive after the no-op cleanup attempt.
    expect(process.kill(process.pid, 0)).toBe(true);
  });
});

describe('pickFreeDisplay (Xvfb installed)', () => {
  test.skipIf(!HAS_XVFB)('returns a number in the requested range', () => {
    const n = pickFreeDisplay(99, 105);
    if (n != null) {
      expect(n).toBeGreaterThanOrEqual(99);
      expect(n).toBeLessThanOrEqual(105);
    }
    // null means all displays in range are busy — also valid.
  });

  test.skipIf(!HAS_XVFB)('isDisplayFree returns boolean', () => {
    const result = isDisplayFree(99);
    expect(typeof result).toBe('boolean');
  });
});

describe('xvfb spawn → cleanup round trip (Linux + Xvfb only)', () => {
  test.skipIf(!HAS_XVFB)('spawn, validate ownership, cleanup', async () => {
    const { spawnXvfb } = await import('../src/xvfb');
    const display = pickFreeDisplay(99, 110);
    if (display == null) {
      // No free display in range — skip.
      return;
    }
    const handle = await spawnXvfb(display);
    try {
      expect(handle.pid).toBeGreaterThan(0);
      expect(handle.display).toBe(`:${display}`);
      expect(handle.startTime.length).toBeGreaterThan(0);
      // Validation should pass.
      expect(isOurXvfb(handle.pid, handle.startTime)).toBe(true);
    } finally {
      handle.close();
      // After cleanup, our Xvfb should be gone.
      await new Promise((r) => setTimeout(r, 200));
      expect(isOurXvfb(handle.pid, handle.startTime)).toBe(false);
    }
  });
});
