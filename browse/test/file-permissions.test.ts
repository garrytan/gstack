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
 *   - Every `mode & 0o777` bitmask assertion is platform-guarded: Windows
 *     fakes POSIX mode bits (chmod is ~a no-op; dirs stat as 0o777), so a
 *     bitmask expectation on win32 tests the runner, not our code. Symlink
 *     fixtures are created in try/catch — Windows runners without Developer
 *     Mode / admin can't create symlinks, and the test skips gracefully.
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

  test('on POSIX, leaves a shared sticky world-writable dir untouched', () => {
    if (process.platform === 'win32') return;
    // Simulates /tmp: sticky + world-writable. Hardening a shared dir to
    // 0o700 locks every other user on the machine out of it, so the helper
    // must refuse — even when the caller owns the dir (root / CAP_FOWNER
    // hosts are where the chmod would actually succeed).
    const d = path.join(tmpDir, 'shared-tmp');
    fs.mkdirSync(d);
    // System chmod, not fs.chmodSync: Bun masks the sticky bit off chmod/
    // mkdir modes, so 0o1777 through the fs API lands as 0o777.
    Bun.spawnSync(['chmod', '1777', d]);
    expect(fs.statSync(d).mode & 0o7777).toBe(0o1777); // fixture took
    restrictDirectoryPermissions(d);
    expect(fs.statSync(d).mode & 0o7777).toBe(0o1777);
  });

  test('on POSIX, leaves a directory owned by another user untouched', () => {
    if (process.platform === 'win32') return;
    const d = path.join(tmpDir, 'foreign');
    fs.mkdirSync(d, { mode: 0o755 });
    // Only constructible where chown to a foreign uid succeeds (root /
    // CAP_CHOWN — containers, CI sandboxes). Elsewhere the chown throws
    // and there's nothing to assert; bail.
    try { fs.chownSync(d, process.getuid!() + 1, fs.statSync(d).gid); } catch { return; }
    restrictDirectoryPermissions(d);
    expect(fs.statSync(d).mode & 0o777).toBe(0o755);
  });

  test('on Windows, does not throw on an existing directory', () => {
    if (process.platform !== 'win32') return;
    const d = path.join(tmpDir, 'subdir');
    fs.mkdirSync(d);
    expect(() => restrictDirectoryPermissions(d)).not.toThrow();
  });

  test('warns and skips a symlinked dir without throwing', () => {
    const real = path.join(tmpDir, 'real-target');
    fs.mkdirSync(real);
    if (process.platform !== 'win32') {
      // chmod, not mkdir({ mode }), so a restrictive umask can't skew the
      // starting bits we later assert were left untouched.
      fs.chmodSync(real, 0o755);
    }
    const link = path.join(tmpDir, 'linked');
    try {
      fs.symlinkSync(real, link, 'dir');
    } catch {
      // Windows runners without Developer Mode / admin can't create
      // symlinks (house pattern: security-audit-r2.test.ts skips the same
      // way). Nothing to test without the link.
      // biome-ignore lint/suspicious/noConsole: test-skip diagnostics
      console.warn('Skipping: symlink creation failed (no symlink privilege)');
      return;
    }

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    try {
      expect(() => restrictDirectoryPermissions(link)).not.toThrow();
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.some((w) => w.includes('symlink'))).toBe(true);

    // The skip must leave the link target untouched. Mode bits are only
    // meaningful on POSIX — Windows fakes stat().mode (dirs report 0o777
    // no matter what), so asserting 0o755 there fails on runner semantics,
    // not on our behavior. The no-throw + warn + still-usable checks are
    // the meaningful win32 contract.
    if (process.platform !== 'win32') {
      expect(fs.statSync(real).mode & 0o777).toBe(0o755);
    }
    expect(() => fs.readdirSync(real)).not.toThrow();
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

  test('does not chmod a pre-existing shared sticky dir (the /tmp state-dir case)', () => {
    if (process.platform === 'win32') return;
    // BROWSE_STATE_FILE=/tmp/foo.json derives stateDir=/tmp, and every
    // daemon boot runs mkdirSecure(stateDir). The mkdir is a no-op on the
    // existing dir; the permission re-apply must be one too — chmodding the
    // real /tmp to 0o700 breaks fs.existsSync (access(2) → EACCES) for
    // every process on the machine until something restores 1777.
    const d = path.join(tmpDir, 'shared-tmp');
    fs.mkdirSync(d);
    // System chmod: Bun's fs API masks the sticky bit off modes (see the
    // restrictDirectoryPermissions sticky-dir test).
    Bun.spawnSync(['chmod', '1777', d]);
    expect(fs.statSync(d).mode & 0o7777).toBe(0o1777); // fixture took
    mkdirSecure(d);
    expect(fs.statSync(d).mode & 0o7777).toBe(0o1777);
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
// Symlinked state dir (dotfiles-managed ~/.gstack via stow/chezmoi): the
// fd-anchored path refuses to follow it (O_NOFOLLOW) — the refusal must warn,
// never throw, and never chmod the symlink target. POSIX-branch behavior:
// Windows takes the icacls branch and has no POSIX modes (stat reports 0o666),
// so gate like the sibling tests above.
test('restrictDirectoryPermissions warns and skips a symlinked dir without throwing', () => {
  if (process.platform === 'win32') return;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-symlink-'));
  const target = path.join(base, 'real');
  const link = path.join(base, 'link');
  fs.mkdirSync(target, { mode: 0o755 });
  fs.symlinkSync(target, link);
  // Capture the actual post-umask mode rather than assuming 0o755 — a strict
  // umask (077) would legitimately yield 0o700 at creation time.
  const modeBefore = fs.statSync(target).mode & 0o777;
  try {
    expect(() => restrictDirectoryPermissions(link)).not.toThrow();
    // Target permissions untouched — the link was never followed.
    expect(fs.statSync(target).mode & 0o777).toBe(modeBefore);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

