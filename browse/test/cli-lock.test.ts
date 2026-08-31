/**
 * #1084 diagnostics — merged-design shape.
 *
 * Main's smell wave pinned a log-and-return-null acquireServerLock; this
 * branch keeps the typed ServerLockError + bounded-retry design (fully pinned
 * in server-lock-errors.test.ts). This file re-expresses the non-redundant
 * assertion intents from the wave's test against the kept design:
 *   - unexpected open failures surface the REAL errno + lock path (typed
 *     throw), never phantom "another process holds the lock" contention;
 *   - holder-PID read failures surface errno + lock path the same way;
 *   - genuine live contention stays SILENT (null return, no stderr noise).
 * Exact duplicates of server-lock-errors.test.ts coverage (stale-lock
 * reacquire, ENOENT self-heal, EACCES throw) are deliberately not repeated.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { acquireServerLock, ServerLockError } from '../src/cli';

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-lock-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function captureErrors<T>(fn: () => T): { result: T; messages: string[] } {
  const original = console.error;
  const messages: string[] = [];
  console.error = (...args: unknown[]) => {
    messages.push(args.map(String).join(' '));
  };
  try {
    return { result: fn(), messages };
  } finally {
    console.error = original;
  }
}

describe('browse CLI server lock diagnostics (#1084)', () => {
  test('unexpected open failures throw ServerLockError with the real errno — not phantom lock contention', () => {
    if (process.platform === 'win32') return; // ENOTDIR errno mapping differs on Windows
    withTempDir((dir) => {
      // A FILE where a directory is expected: open('wx') fails ENOTDIR — an
      // errno that is neither contention (EEXIST) nor the self-healing
      // missing-dir case (ENOENT). The old code's bare catch would have
      // reported "another process holds the lock" forever.
      const blocker = path.join(dir, 'blocker');
      fs.writeFileSync(blocker, 'not a directory\n');
      const lockPath = path.join(blocker, 'browse.json.lock');

      let thrown: any = null;
      try {
        acquireServerLock(lockPath);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ServerLockError);
      expect(thrown.code).toBe('ENOTDIR');
      expect(thrown.message).toContain('E_SERVER_LOCK (ENOTDIR)');
      expect(thrown.message).toContain(lockPath);
    });
  });

  test('returns null silently when a live process holds the lock', () => {
    withTempDir((dir) => {
      const lockPath = path.join(dir, 'browse.json.lock');
      fs.writeFileSync(lockPath, `${process.pid}\n`);

      const { result, messages } = captureErrors(() => acquireServerLock(lockPath));

      expect(result).toBeNull();
      expect(messages).toEqual([]);
    });
  });

  test('holder PID read failures throw ServerLockError with code and lock path', () => {
    withTempDir((dir) => {
      // Lock path exists but is a DIRECTORY: open('wx') → EEXIST (looks like
      // contention), then the holder-PID read fails EISDIR. The kept design
      // surfaces that errno + path in a typed error instead of retrying or
      // reporting phantom contention.
      const lockPath = path.join(dir, 'browse.json.lock');
      fs.mkdirSync(lockPath);

      let thrown: any = null;
      try {
        acquireServerLock(lockPath);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ServerLockError);
      expect(thrown.code).toBe('EISDIR');
      expect(thrown.message).toContain('E_SERVER_LOCK (EISDIR)');
      expect(thrown.message).toContain(lockPath);
    });
  });
});
