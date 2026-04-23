/**
 * Cross-platform file permission restriction for sensitive gstack state.
 *
 * Why this exists
 * ----------------
 * POSIX mode bits (`0o600` for files, `0o700` for dirs) are how gstack marks
 * sensitive state files — auth tokens, canary tokens, chat history, agent
 * queue, device salt, per-tab security decisions. On Linux and macOS,
 * `fs.chmodSync(path, 0o600)` and `fs.writeFileSync(path, data, { mode: 0o600 })`
 * do exactly what you'd hope: the file ends up readable and writable only
 * by the owning user, no access for group / other.
 *
 * On Windows, both calls are effectively no-ops. NTFS uses ACLs, not POSIX
 * mode bits, and Node's fs module doesn't translate. So on every Windows
 * install, sensitive gstack state files inherit whatever ACL the parent
 * directory grants — typically user-full + inherited admin-full. That's
 * fine on a single-user laptop but leaks on:
 *
 *   - Self-hosted CI runners (GitHub Actions / GitLab / Jenkins agents
 *     running as a different service account on the same box — they can
 *     read developer state)
 *   - Shared development machines (agencies, studios, lab machines)
 *   - Multi-tenant servers with shared home directories
 *   - Malware running as the same user (no in-user-account isolation)
 *
 * This module wraps the platform-correct call. POSIX: chmod. Windows:
 * icacls with inheritance break + explicit user grant. Failures on either
 * platform are best-effort — the filesystem is still functional if ACL
 * restriction fails; we just don't hit the intended hardening target.
 *
 * Warning behavior: to avoid spamming the console on a machine where
 * icacls is unavailable (rare — it ships in System32 on every Windows
 * version since 7), we log the first failure per process and stay silent
 * afterward. The warning includes the advice "sensitive files may be
 * readable by other accounts on this machine" so operators know to audit
 * their runner / share setup.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';

let warnedOnce = false;

function warnIcaclsFailure(fsPath: string, err: unknown): void {
  if (warnedOnce) return;
  warnedOnce = true;
  const msg = err instanceof Error ? err.message : String(err);
  // biome-ignore lint/suspicious/noConsole: intentional user-facing warning
  console.warn(
    `[gstack] Failed to restrict Windows ACL on ${fsPath}: ${msg}\n` +
    `  Sensitive files may be readable by other accounts on this machine.\n` +
    `  This warning appears once per process; subsequent failures are silent.`
  );
}

/**
 * Restrict a file to owner-only access (POSIX 0o600 equivalent).
 *
 * POSIX: `fs.chmodSync(path, 0o600)`. Idempotent if the file was already
 * written with `{ mode: 0o600 }`, so safe to call regardless.
 *
 * Windows: invokes `icacls /inheritance:r /grant:r <user>:(F)` to remove
 * any inherited ACLs and replace the ACL with a single entry granting the
 * current user full control.
 */
export function restrictFilePermissions(filePath: string): void {
  if (process.platform === 'win32') {
    try {
      const user = os.userInfo().username;
      execFileSync(
        'icacls',
        [filePath, '/inheritance:r', '/grant:r', `${user}:(F)`],
        { stdio: 'ignore' },
      );
    } catch (err) {
      warnIcaclsFailure(filePath, err);
    }
    return;
  }
  try { fs.chmodSync(filePath, 0o600); } catch { /* best-effort */ }
}

/**
 * Restrict a directory to owner-only access (POSIX 0o700 equivalent),
 * with new children inheriting the restricted ACL.
 *
 * POSIX: `fs.chmodSync(path, 0o700)`. Idempotent if the dir was already
 * created with `{ mode: 0o700 }`.
 *
 * Windows: `icacls /inheritance:r /grant:r <user>:(OI)(CI)(F)`. The
 * `(OI)(CI)` flags make new files (OI = object inherit) and subdirs
 * (CI = container inherit) inherit the single-user-full ACL — important
 * because child creations in `fs.writeFileSync(...)` without explicit
 * `restrictFilePermissions` still end up owner-only.
 */
export function restrictDirectoryPermissions(dirPath: string): void {
  if (process.platform === 'win32') {
    try {
      const user = os.userInfo().username;
      execFileSync(
        'icacls',
        [dirPath, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)(F)`],
        { stdio: 'ignore' },
      );
    } catch (err) {
      warnIcaclsFailure(dirPath, err);
    }
    return;
  }
  try { fs.chmodSync(dirPath, 0o700); } catch { /* best-effort */ }
}

/**
 * Write a file and restrict it to owner-only access, cross-platform.
 * Replaces `fs.writeFileSync(path, data, { mode: 0o600 })` + Windows ACL.
 */
export function writeSecureFile(
  filePath: string,
  data: string | NodeJS.ArrayBufferView,
): void {
  fs.writeFileSync(filePath, data, { mode: 0o600 });
  restrictFilePermissions(filePath);
}

/**
 * Append to a file with owner-only permissions, cross-platform.
 * Replaces `fs.appendFileSync(path, data, { mode: 0o600 })` + Windows ACL.
 *
 * ACL is applied only on first write — subsequent appends are fire-and-forget
 * (no need to re-run icacls on every log line).
 */
export function appendSecureFile(
  filePath: string,
  data: string | NodeJS.ArrayBufferView,
): void {
  const existed = fs.existsSync(filePath);
  fs.appendFileSync(filePath, data, { mode: 0o600 });
  if (!existed) restrictFilePermissions(filePath);
}

/**
 * `mkdir -p` with owner-only directory permissions, cross-platform.
 * Replaces `fs.mkdirSync(path, { recursive: true, mode: 0o700 })` + Windows ACL.
 * Safe to call on an existing directory — re-applies the ACL idempotently.
 */
export function mkdirSecure(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  restrictDirectoryPermissions(dirPath);
}

/**
 * Reset the once-per-process warning gate. Test-only.
 */
export function __resetWarnedForTests(): void {
  warnedOnce = false;
}
