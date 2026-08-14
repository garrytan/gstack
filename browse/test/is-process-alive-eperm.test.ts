/**
 * isProcessAlive tri-state (agent-browser U7).
 *
 * The zombie-lock bug was isProcessAlive treating EPERM (process exists but we
 * can't signal it) as dead, so cleanup skipped a live Chromium holding the
 * profile SingletonLock. EPERM must read as ALIVE; only ESRCH is dead.
 */

import { describe, it, expect } from 'bun:test';

import { isProcessAlive } from '../src/error-handling';

describe('isProcessAlive', () => {
  it('reports the current process as alive', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('reports a non-existent pid (ESRCH) as dead', () => {
    // A pid that will not exist; process.kill throws ESRCH.
    expect(isProcessAlive(2_147_483_646)).toBe(false);
  });

  it('reports pid 1 (EPERM for non-root) as alive, not dead', () => {
    // On Unix, pid 1 (launchd/init) exists but an unprivileged process cannot
    // signal it → EPERM. Pre-fix this returned false (the zombie bug). Skip if
    // somehow running as root, where kill(1,0) succeeds instead of EPERM.
    if (process.platform === 'win32') return;
    const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    if (isRoot) return;
    expect(isProcessAlive(1)).toBe(true);
  });
});
