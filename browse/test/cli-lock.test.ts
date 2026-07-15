import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { acquireServerLock } from '../src/cli';

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
  test('logs non-EEXIST open failures instead of reporting phantom lock contention', () => {
    withTempDir((dir) => {
      const lockPath = path.join(dir, 'missing-parent', 'browse.json.lock');
      const { result, messages } = captureErrors(() => acquireServerLock(lockPath));

      expect(result).toBeNull();
      expect(messages.join('\n')).toContain('unexpected ENOENT while opening');
      expect(messages.join('\n')).toContain(lockPath);
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

  test('logs holder PID read failures with code and lock path', () => {
    withTempDir((dir) => {
      const lockPath = path.join(dir, 'browse.json.lock');
      fs.mkdirSync(lockPath);

      const { result, messages } = captureErrors(() => acquireServerLock(lockPath));

      expect(result).toBeNull();
      expect(messages.join('\n')).toContain('unexpected EISDIR while reading holder PID from');
      expect(messages.join('\n')).toContain(lockPath);
    });
  });

  test('removes stale lock and reacquires it', () => {
    withTempDir((dir) => {
      const lockPath = path.join(dir, 'browse.json.lock');
      fs.writeFileSync(lockPath, 'not-a-pid\n');

      const release = acquireServerLock(lockPath);

      expect(release).toBeFunction();
      expect(fs.readFileSync(lockPath, 'utf-8').trim()).toBe(String(process.pid));
      release?.();
      expect(fs.existsSync(lockPath)).toBe(false);
    });
  });
});
