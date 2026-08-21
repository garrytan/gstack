import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { safeUnlink, safeKill, isProcessAlive, warnOnce, errText, _resetWarnOnce } from '../src/error-handling';

/** Capture console.error for the duration of `fn`. */
function captureStderr(fn: () => void): string[] {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.join(' ')); };
  try {
    fn();
  } finally {
    console.error = original;
  }
  return lines;
}

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
});

describe('warnOnce', () => {
  test('reports the message and the error detail', () => {
    _resetWarnOnce();
    const lines = captureStderr(() => warnOnce('k1', '[test] state write failed', new Error('EACCES: denied')));
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('[test] state write failed');
    expect(lines[0]).toContain('EACCES: denied');
  });

  test('warns only once per key so hot paths cannot flood the log', () => {
    _resetWarnOnce();
    const lines = captureStderr(() => {
      warnOnce('hot', '[test] first');
      warnOnce('hot', '[test] second');
      warnOnce('other', '[test] different key');
    });
    expect(lines.length).toBe(2);
    expect(lines[0]).toBe('[test] first');
    expect(lines[1]).toBe('[test] different key');
  });

  test('omits the detail suffix when no error is supplied', () => {
    _resetWarnOnce();
    const lines = captureStderr(() => warnOnce('nodetail', '[test] plain'));
    expect(lines[0]).toBe('[test] plain');
  });
});

describe('errText', () => {
  test('uses the Error message', () => {
    expect(errText(new Error('boom'))).toBe('boom');
  });

  test('stringifies non-Error throws', () => {
    expect(errText('plain string')).toBe('plain string');
    expect(errText(42)).toBe('42');
  });
});
