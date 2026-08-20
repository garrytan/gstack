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
  repairBrokenDacl,
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

  test('on Windows, the directory stays usable by the calling process', () => {
    if (process.platform !== 'win32') return;
    const d = path.join(tmpDir, 'still-usable');
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'before'), 'x');

    restrictDirectoryPermissions(d);

    // Regression: an unqualified username passed to icacls can resolve to
    // the machine SID rather than the user account. Combined with
    // /inheritance:r that leaves a directory whose only ACE matches nobody,
    // so the process that just "secured" it can no longer enumerate or
    // write to it. icacls still reports success, so a not-toThrow assertion
    // sails straight past it — hence these access checks.
    expect(() => fs.readdirSync(d)).not.toThrow();
    expect(fs.readdirSync(d)).toContain('before');
    expect(() => fs.writeFileSync(path.join(d, 'after'), 'y')).not.toThrow();
    expect(fs.readFileSync(path.join(d, 'after'), 'utf8')).toBe('y');
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

  test('on Windows, the created directory stays usable by the caller', () => {
    if (process.platform !== 'win32') return;
    // The state-dir path that broke: mkdirSecure() creates .gstack/, hardens
    // it, and the very next thing the daemon does is write a lockfile inside.
    const d = path.join(tmpDir, 'state', '.gstack');
    mkdirSecure(d);
    expect(() => fs.writeFileSync(path.join(d, 'browse.json.lock'), '1')).not.toThrow();
    expect(fs.readdirSync(d)).toContain('browse.json.lock');
  });

  test('recursive behavior: creates intermediate directories', () => {
    const d = path.join(tmpDir, 'a', 'b', 'c');
    mkdirSecure(d);
    expect(fs.existsSync(path.join(tmpDir, 'a'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'a', 'b'))).toBe(true);
    expect(fs.existsSync(d)).toBe(true);
  });

  test('created directory is listable by the creating process', () => {
    // #1605 contract: whatever ACL hardening happens, the client must be
    // able to read its own state dir immediately after creation.
    const d = path.join(tmpDir, 'state');
    mkdirSecure(d);
    fs.writeFileSync(path.join(d, 'browse.json'), '{}');
    expect(fs.readdirSync(d)).toContain('browse.json');
  });
});

describe('repairBrokenDacl', () => {
  test('is a no-op on non-Windows platforms', () => {
    if (process.platform === 'win32') return;
    const d = path.join(tmpDir, 'dir');
    fs.mkdirSync(d);
    expect(() => repairBrokenDacl(d)).not.toThrow();
  });

  test('on Windows, does not throw and directory stays listable', () => {
    if (process.platform !== 'win32') return;
    const d = path.join(tmpDir, 'dir');
    fs.mkdirSync(d);
    expect(() => repairBrokenDacl(d)).not.toThrow();
    expect(() => fs.readdirSync(d)).not.toThrow();
  });

  test('on Windows, swallows icacls failure on a nonexistent path', () => {
    if (process.platform !== 'win32') return;
    expect(() => repairBrokenDacl(path.join(tmpDir, 'nonexistent'))).not.toThrow();
  });
});
