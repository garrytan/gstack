/**
 * Unit tests for browse/src/file-permissions.ts
 *
 * Strategy:
 *   - POSIX assertions check fs.statSync.mode bits directly (cheap, reliable,
 *     runs on every CI config).
 *   - Windows assertions don't check ACLs (that'd require parsing icacls
 *     output, which is brittle across Windows versions / locales). Instead
 *     we verify the helper doesn't throw and the file ends up accessible
 *     to the current user — the "doesn't crash, file still usable"
 *     contract the callers rely on.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  restrictFilePermissions,
  restrictDirectoryPermissions,
  writeSecureFile,
  appendSecureFile,
  mkdirSecure,
  __resetWarnedForTests,
} from '../src/file-permissions';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-perms-'));
  __resetWarnedForTests();
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('restrictFilePermissions', () => {
  test('on POSIX, sets file mode to 0o600', () => {
    if (process.platform === 'win32') return;
    const p = path.join(tmpDir, 'secret');
    fs.writeFileSync(p, 'token');
    fs.chmodSync(p, 0o644); // start world-readable to prove the call mutates it
    restrictFilePermissions(p);
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
  });

  test('on Windows, does not throw on an existing file', () => {
    if (process.platform !== 'win32') return;
    const p = path.join(tmpDir, 'secret');
    fs.writeFileSync(p, 'token');
    expect(() => restrictFilePermissions(p)).not.toThrow();
    // File remains readable by the caller — core contract.
    expect(fs.readFileSync(p, 'utf8')).toBe('token');
  });

  test('on Windows, does not throw when icacls fails (bad path)', () => {
    if (process.platform !== 'win32') return;
    // icacls emits an error for a nonexistent path; helper must swallow.
    expect(() => restrictFilePermissions(path.join(tmpDir, 'nonexistent'))).not.toThrow();
  });
});

describe('restrictDirectoryPermissions', () => {
  test('on POSIX, sets directory mode to 0o700', () => {
    if (process.platform === 'win32') return;
    const d = path.join(tmpDir, 'subdir');
    fs.mkdirSync(d, { mode: 0o755 });
    restrictDirectoryPermissions(d);
    expect(fs.statSync(d).mode & 0o777).toBe(0o700);
  });

  test('on Windows, does not throw on an existing directory', () => {
    if (process.platform !== 'win32') return;
    const d = path.join(tmpDir, 'subdir');
    fs.mkdirSync(d);
    expect(() => restrictDirectoryPermissions(d)).not.toThrow();
  });
});

describe('writeSecureFile', () => {
  test('writes the payload and restricts permissions atomically', () => {
    const p = path.join(tmpDir, 'data');
    writeSecureFile(p, 'hello');
    expect(fs.readFileSync(p, 'utf8')).toBe('hello');
    if (process.platform !== 'win32') {
      expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    }
  });

  test('accepts Buffer payloads', () => {
    const p = path.join(tmpDir, 'buffer');
    writeSecureFile(p, Buffer.from([0xde, 0xad, 0xbe, 0xef]));
    const out = fs.readFileSync(p);
    expect(out.length).toBe(4);
    expect(out[0]).toBe(0xde);
  });

  test('overwrites existing file', () => {
    const p = path.join(tmpDir, 'existing');
    fs.writeFileSync(p, 'old', { mode: 0o644 });
    writeSecureFile(p, 'new');
    expect(fs.readFileSync(p, 'utf8')).toBe('new');
  });
});

describe('appendSecureFile', () => {
  test('appends to a new file and sets owner-only permissions', () => {
    const p = path.join(tmpDir, 'log');
    appendSecureFile(p, 'line1\n');
    expect(fs.readFileSync(p, 'utf8')).toBe('line1\n');
    if (process.platform !== 'win32') {
      expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    }
  });

  test('appends without re-applying ACL on subsequent writes', () => {
    const p = path.join(tmpDir, 'log');
    appendSecureFile(p, 'line1\n');
    appendSecureFile(p, 'line2\n');
    expect(fs.readFileSync(p, 'utf8')).toBe('line1\nline2\n');
  });
});

describe('mkdirSecure', () => {
  test('creates directory with owner-only mode (POSIX)', () => {
    if (process.platform === 'win32') return;
    const d = path.join(tmpDir, 'nested', 'deep');
    mkdirSecure(d);
    expect(fs.statSync(d).isDirectory()).toBe(true);
    expect(fs.statSync(d).mode & 0o777).toBe(0o700);
  });

  test('is idempotent — safe to call on existing directory', () => {
    const d = path.join(tmpDir, 'dir');
    mkdirSecure(d);
    expect(() => mkdirSecure(d)).not.toThrow();
  });

  test('recursive behavior: creates intermediate directories', () => {
    const d = path.join(tmpDir, 'a', 'b', 'c');
    mkdirSecure(d);
    expect(fs.existsSync(path.join(tmpDir, 'a'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'a', 'b'))).toBe(true);
    expect(fs.existsSync(d)).toBe(true);
  });
});
