/**
 * Cross-platform file permission restriction for sensitive gstack state.
 *
 * Why this exists
 * ----------------
 * POSIX mode bits (`0o600` for files, `0o700` for dirs) are how gstack marks
 * sensitive state files — auth tokens, PTY session state, tab context. On
 * Linux and macOS,
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

let cachedSid: string | null | undefined;

/**
 * Resolve the current user's SID, cached for the process lifetime.
 *
 * Returns null if `whoami` is unavailable or its output cannot be parsed,
 * in which case callers fall back to a domain-qualified account name.
 */
function currentUserSid(): string | null {
  if (cachedSid !== undefined) return cachedSid;
  try {
    // Pin to the System32 binary. A bare `whoami` resolves to the MSYS/Git
    // Bash build under a bash-flavoured PATH, which rejects `/user` — the
    // lookup would then silently fail on one of the most common Windows
    // setups for this tool.
    const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    const out = execFileSync(`${systemRoot}\\System32\\whoami.exe`, ['/user', '/fo', 'csv', '/nh'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const match = out.match(/S-1-[\d-]+/);
    cachedSid = match ? match[0] : null;
  } catch {
    cachedSid = null;
  }
  return cachedSid;
}

/**
 * The principal to hand icacls for "the current user".
 *
 * An unqualified username is ambiguous: on a machine whose hostname equals
 * the username, it fails to resolve to the user account and icacls silently
 * writes an ACE for the machine SID instead. Combined with `/inheritance:r`
 * that leaves a directory whose only ACE matches nobody — locking out the
 * process that just created it.
 *
 * `*<SID>` is icacls' literal-SID form and is immune to that ambiguity.
 * The domain-qualified name is the fallback.
 */
function currentUserPrincipal(): string {
  const sid = currentUserSid();
  if (sid) return `*${sid}`;
  const domain = process.env.USERDOMAIN || os.hostname();
  return `${domain}\\${os.userInfo().username}`;
}

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
      const user = currentUserPrincipal();
      execFileSync(
        'icacls',
        [filePath, '/inheritance:r', '/grant:r', `${user}:(F)`],
        { stdio: 'ignore', windowsHide: true },
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
 * Owner-only hardening is for directories gstack creates and owns. Two
 * pre-existing shapes must never be chmodded, so the POSIX branch refuses
 * them:
 *
 *   - A directory owned by another user. On most hosts the chmod just
 *     fails EPERM, but run as root (or with CAP_FOWNER — containers, CI
 *     sandboxes) it SUCCEEDS and takes the directory away from its owner.
 *   - A shared sticky world-writable directory (`/tmp`, `/var/tmp`).
 *     Callers land here when a state file is configured directly inside
 *     the system temp dir (`BROWSE_STATE_FILE=/tmp/foo.json` makes
 *     `path.dirname()` derive `/tmp` as the state dir). A 0o700 `/tmp`
 *     locks every other process on the machine out of it: access(2)-based
 *     checks (`fs.existsSync`) return EACCES→false machine-wide, even
 *     while stat keeps working for capability-holding processes.
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
      const user = currentUserPrincipal();
      execFileSync(
        'icacls',
        [dirPath, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)(F)`],
        { stdio: 'ignore', windowsHide: true },
      );
    } catch (err) {
      warnIcaclsFailure(dirPath, err);
    }
    return;
  }
  try {
    // fd-anchored check-then-act: statSync + chmodSync resolve the path twice,
    // so a symlink swapped in between would let the chmod land on a directory
    // the check never saw (exactly the CAP_FOWNER hosts this guard exists
    // for). O_NOFOLLOW refuses a symlinked state dir outright; fstat + fchmod
    // pin both the check and the act to the same inode.
    const fd = fs.openSync(
      dirPath,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
    try {
      if (!shouldHardenDir(fs.fstatSync(fd))) {
        warnUnhardenedDirOnce(dirPath);
        return;
      }
      fs.fchmodSync(fd, 0o700);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err: any) {
    // The fd path refuses two shapes the old chmodSync handled, and a silent
    // skip here would quietly lose hardening (the module's own rule is that
    // refusals are never silent):
    //   ELOOP/ENOTDIR — dirPath is a symlink (dotfiles-managed ~/.gstack via
    //     stow/chezmoi). Never follow it blind; warn so the operator knows.
    //   EACCES — an OWNED dir stuck without the read bit (mode 0300/0000)
    //     can't be opened but could always be repaired by plain chmod. Keep
    //     that self-repair: re-check ownership via lstat (no link follow) and
    //     chmod only a real, owned, non-shared directory.
    if (err?.code === 'EACCES') {
      try {
        const st = fs.lstatSync(dirPath);
        if (st.isDirectory() && shouldHardenDir(st)) {
          fs.chmodSync(dirPath, 0o700);
          return;
        }
      } catch { /* fall through to the warning */ }
    }
    if (err?.code === 'ELOOP' || err?.code === 'ENOTDIR' || err?.code === 'EACCES') {
      warnUnhardenedDirOnce(dirPath);
    }
    /* anything else: best-effort, matching the old behavior */
  }
}

/** Owner-only hardening applies to a real dir we own that isn't shared. */
function shouldHardenDir(st: fs.Stats): boolean {
  // chmod authorization is judged on the EFFECTIVE uid; fall back to the
  // real uid where geteuid is unavailable (Windows — unreachable here).
  const uid = process.geteuid?.() ?? process.getuid?.();
  if (st.uid !== uid) return false;
  // sticky + world-writable = shared temp dir (/tmp, /var/tmp) — never ours
  // to restrict. Running as root, treat ANY world-writable dir as shared:
  // root "owns" docker/CI volume mounts (0777, no sticky bit) that other
  // users depend on, and a 0700 there locks them all out.
  if ((st.mode & 0o1002) === 0o1002) return false;
  if (uid === 0 && (st.mode & 0o002) === 0o002) return false;
  return true;
}

// The POSIX refusal must not be silent (the Windows branch already warns when
// icacls misses its hardening target): an operator who points state at a
// shared or foreign-owned directory should learn it was left unhardened.
const unhardenedWarned = new Set<string>();
function warnUnhardenedDirOnce(dirPath: string): void {
  if (unhardenedWarned.has(dirPath)) return;
  unhardenedWarned.add(dirPath);
  // biome-ignore lint/suspicious/noConsole: intentional user-facing warning
  console.warn(
    `[gstack] directory ${dirPath} is shared, symlinked, or owned by another user; ` +
    'gstack left its permissions untouched — use a private, non-symlinked directory for owner-only hardening',
  );
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
 * Windows only: probe whether the current process can actually list the
 * directory. `fs.accessSync` doesn't consult NTFS ACLs on Windows, so a
 * real readdir is the only honest check.
 */
function canListDir(dirPath: string): boolean {
  try { fs.readdirSync(dirPath); return true; } catch { return false; }
}

/**
 * Windows only: repair a broken DACL on a state directory (#1605).
 *
 * `icacls /inheritance:r /grant:r <user>:(F)` is a single command, but the
 * two halves can partially fail: inheritance gets stripped while the user
 * grant doesn't resolve (localized account names, domain accounts, roaming
 * profiles). The result is a DACL with no usable ACE — often just a machine
 * SID — and the client can't read its own state files. `/reset` restores
 * inherited ACLs from the parent, making the directory functional again.
 * Functional-but-unhardened beats hardened-but-unusable.
 */
export function repairBrokenDacl(dirPath: string): void {
  if (process.platform !== 'win32') return;
  try {
    execFileSync('icacls', [dirPath, '/reset', '/T', '/C', '/Q'], { stdio: 'ignore', windowsHide: true });
  } catch (err) {
    warnIcaclsFailure(dirPath, err);
  }
}

/**
 * `mkdir -p` with owner-only directory permissions, cross-platform.
 * Replaces `fs.mkdirSync(path, { recursive: true, mode: 0o700 })` + Windows ACL.
 * Safe to call on an existing directory — re-applies the ACL idempotently,
 * except on directories gstack doesn't own (another user's dir, or a shared
 * sticky world-writable dir like `/tmp`), which are left untouched — see
 * `restrictDirectoryPermissions`.
 *
 * Windows: after applying the restricted ACL, verifies the directory is
 * still listable by this process and repairs a broken DACL (#1605) if not.
 */
export function mkdirSecure(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  restrictDirectoryPermissions(dirPath);
  if (process.platform === 'win32' && !canListDir(dirPath)) {
    repairBrokenDacl(dirPath);
    restrictDirectoryPermissions(dirPath);
    // If re-hardening broke access again, reset once more and leave the
    // directory with inherited ACLs — the client must be able to read
    // its own state.
    if (!canListDir(dirPath)) repairBrokenDacl(dirPath);
  }
}

/**
 * Reset the once-per-process warning gate. Test-only.
 */
export function __resetWarnedForTests(): void {
  warnedOnce = false;
}
