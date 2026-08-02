/**
 * gbrain-sources — TypeScript helper for idempotent gbrain federated source registration.
 *
 * Owns the TypeScript registration boundary used by bin/gstack-gbrain-sync.ts.
 * It evolved from the legacy shell wire-up but intentionally adds canonical,
 * fail-closed path classification before mutation. gbrain has no `sources
 * update` — genuine drift recovery is `sources remove` followed by `sources add`.
 *
 * Per /plan-eng-review D3 (DRY extraction).
 */

import { execFileSync, spawnSync } from "child_process";
import { lstatSync, readlinkSync, realpathSync, statSync } from "fs";
import { posix, win32 } from "path";
import { withErrorContext } from "./gstack-memory-helpers";
import { execGbrainJson, NEEDS_SHELL_ON_WINDOWS } from "./gbrain-exec";

export interface SourceState {
  /** "absent" — id not registered. "match" — id at expected path. "drift" — id at different path. */
  status: "absent" | "match" | "drift";
  /** Path gbrain has registered for this id. Only set when status !== "absent". */
  registered_path?: string;
}

export interface EnsureResult {
  /** True if registration state changed (added or re-registered). False on no-op. */
  changed: boolean;
  /** Final source state after the call. */
  state: SourceState;
}

export interface DirectoryFsOps {
  lstat(path: string): { isSymbolicLink(): boolean };
  readlink(path: string): string;
  realpath(path: string): string;
  stat(path: string): { dev: bigint; ino: bigint; isDirectory(): boolean };
}

const DEFAULT_DIRECTORY_FS_OPS: DirectoryFsOps = {
  lstat: (path) => lstatSync(path),
  readlink: (path) => readlinkSync(path),
  realpath: (path) => realpathSync(path),
  stat: (path) => statSync(path, { bigint: true }),
};

/**
 * One source row returned by GBrain's source-list surfaces. The ordinary
 * `gbrain sources list --json` projection intentionally omits management
 * provenance. The read-only `gbrain call ... sources_list` operation includes
 * top-level `remote_url`; callers that authorize remove/reclone behavior must
 * use that richer surface and require the field to be present.
 */
export interface GbrainSourceRow {
  id?: string;
  local_path?: string | null;
  page_count?: number;
  remote_url?: string | null;
  /** Legacy/foreign projection accepted for read-only compatibility only. */
  config?: { remote_url?: string | null } | null;
}

/**
 * Normalize `gbrain sources list --json` output to an array of source rows.
 *
 * gbrain has shipped two shapes: a wrapped `{ sources: [...] }` object (v0.20+)
 * and, in older/other variants, a bare top-level array. #1576 was a crash when a
 * reader assumed one shape; the parse is centralized here so every reader
 * (probeSource, sourcePageCount, sourceLocalPath) agrees on the shape in ONE
 * place. Returns [] for null/garbage rather than
 * throwing — callers treat "no rows" as absent.
 */
export function parseSourcesList(raw: unknown): GbrainSourceRow[] {
  if (Array.isArray(raw)) return raw as GbrainSourceRow[];
  if (raw && typeof raw === "object" && Array.isArray((raw as { sources?: unknown }).sources)) {
    return (raw as { sources: GbrainSourceRow[] }).sources;
  }
  return [];
}

/** Strict variant for decisions that may authorize add/remove/reclone paths. */
export function parseSourcesListStrict(raw: unknown): GbrainSourceRow[] {
  const rows = Array.isArray(raw)
    ? raw
    : raw &&
        typeof raw === "object" &&
        Array.isArray((raw as { sources?: unknown }).sources)
      ? (raw as { sources: unknown[] }).sources
      : null;
  if (rows === null) {
    throw new Error("gbrain sources list returned an unknown JSON shape");
  }
  for (const row of rows) {
    if (!row || typeof row !== "object") {
      throw new Error("gbrain sources list returned a non-object source row");
    }
    const candidate = row as GbrainSourceRow;
    if (typeof candidate.id !== "string" || candidate.id.length === 0) {
      throw new Error(
        "gbrain sources list returned a source row without a valid id",
      );
    }
    if (
      candidate.local_path !== undefined &&
      candidate.local_path !== null &&
      typeof candidate.local_path !== "string"
    ) {
      throw new Error(
        "gbrain sources list returned a source row with a non-string local_path",
      );
    }
    if (
      candidate.config !== undefined &&
      candidate.config !== null &&
      (typeof candidate.config !== "object" || Array.isArray(candidate.config))
    ) {
      throw new Error(
        "gbrain sources list returned a source row with invalid config",
      );
    }
    const remoteUrl = candidate.remote_url;
    if (
      remoteUrl !== undefined &&
      remoteUrl !== null &&
      typeof remoteUrl !== "string"
    ) {
      throw new Error(
        "gbrain sources list returned a source row with invalid remote_url",
      );
    }
    const legacyRemoteUrl = candidate.config?.remote_url;
    if (
      legacyRemoteUrl !== undefined &&
      legacyRemoteUrl !== null &&
      typeof legacyRemoteUrl !== "string"
    ) {
      throw new Error(
        "gbrain sources list returned a source row with invalid remote_url",
      );
    }
  }
  return rows as GbrainSourceRow[];
}

export interface EnsureOptions {
  /** Pass --federated to `gbrain sources add`. Default false. */
  federated?: boolean;
  /** When status=drift, force a remove+add to update the registered path. Default true. */
  reregister_on_drift?: boolean;
  /**
   * Optional env override for the spawned `gbrain` calls. Production callers
   * leave this unset (inherit process.env). Tests pass a custom env to point
   * at a fake `gbrain` on PATH (Bun's execFileSync does not respect runtime
   * mutations of process.env.PATH unless env is passed explicitly).
   */
  env?: NodeJS.ProcessEnv;
  /** @internal Platform override for path-safety tests. */
  platform?: NodeJS.Platform;
  /** @internal Filesystem seam for no-follow and replacement-race tests. */
  fsOps?: DirectoryFsOps;
  /** @internal Caller-captured identity that must remain current. */
  expected_identity?: CanonicalDirectory;
  /**
   * Guarded removal boundary for true path drift. Callers must enforce the
   * repository's destructive-operation policy; without one, drift repair
   * fails closed before removing the existing source.
   */
  removeSource?: (
    id: string,
    registeredPath: string,
    env?: NodeJS.ProcessEnv,
  ) => void;
  /** @internal Test hook invoked immediately before identity revalidation. */
  beforeMutation?: (
    phase: "before-remove" | "before-add" | "after-add",
  ) => void;
}

export interface CanonicalDirectory {
  rawPath: string;
  canonicalPath: string;
  device: bigint;
  inode: bigint;
}

const SOURCE_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const WINDOWS_SHELL_META_RE = /[&|^%!()"'<>]/;

function assertSafeSourceId(id: string): void {
  if (!SOURCE_ID_RE.test(id)) {
    throw new Error(
      `source id "${id}" is unsafe or invalid; expected 1-32 lowercase alphanumeric characters with interior hyphens`,
    );
  }
}

/** Reject path spellings that are unsafe to resolve at all. */
function assertSafePathSyntax(
  rawPath: string,
  label: string,
  platform: NodeJS.Platform,
): void {
  if (/^[\\\\/]{2}/.test(rawPath)) {
    throw new Error(
      `${label} "${rawPath}" uses a remote or device path namespace; ` +
        "refusing it before filesystem access. Use a local repository path.",
    );
  }
  if (platform !== "win32") {
    // Bun 1.3.x realpath/lstat incorrectly treats a POSIX backslash as a path
    // separator in this execution path. Reject the valid-but-unprovable name
    // instead of canonicalizing a different filesystem object.
    if (rawPath.includes("\\")) {
      throw new Error(
        `${label} "${rawPath}" contains a POSIX backslash filename component that this Bun runtime ` +
          "cannot canonicalize safely; refusing it before filesystem access.",
      );
    }
    return;
  }

  if (
    /^[A-Za-z]:(?![\\\\/])/.test(rawPath) ||
    /^[\\\\/](?![\\\\/])/.test(rawPath)
  ) {
    throw new Error(
      `${label} "${rawPath}" is drive-relative or root-relative on Windows; ` +
        "refusing the ambiguous path before filesystem access.",
    );
  }
}

/** Until the Windows launcher is argv-native, mutation paths must be shell-safe. */
function assertSafeMutationPath(
  rawPath: string,
  platform: NodeJS.Platform,
): void {
  if (platform !== "win32") return;
  if (!isSafeWindowsShellPath(rawPath)) {
    throw new Error(
      `expected source path "${rawPath}" is unsafe for the current Windows GBrain shell transport; ` +
        "source registration unchanged. Use a path without whitespace or cmd.exe metacharacters.",
    );
  }
}

function isSafeWindowsShellPath(rawPath: string): boolean {
  return !(
    WINDOWS_SHELL_META_RE.test(rawPath) ||
    Array.from(rawPath).some((char) => char.trim().length === 0)
  );
}

function pathApi(platform: NodeJS.Platform): typeof posix {
  return platform === "win32" ? win32 : posix;
}

function splitPathComponents(
  rawPath: string,
  platform: NodeJS.Platform,
): string[] {
  return platform === "win32" ? rawPath.split(/[\\/]+/) : rawPath.split(/\/+/);
}

/** Parent traversal is ambiguous when an earlier component may be a link. */
function hasParentTraversal(
  rawPath: string,
  platform: NodeJS.Platform,
): boolean {
  return splitPathComponents(rawPath, platform).some(
    (component) => component === "..",
  );
}

/** A parent segment after a path component may step out through a nested link. */
function hasNestedParentTraversal(
  rawPath: string,
  platform: NodeJS.Platform,
): boolean {
  let sawPathComponent = false;
  for (const component of splitPathComponents(rawPath, platform)) {
    if (component === "" || component === ".") continue;
    if (component === "..") {
      if (sawPathComponent) return true;
      continue;
    }
    sawPathComponent = true;
  }
  return false;
}

function comparableRoot(root: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? root.toLocaleLowerCase("en-US") : root;
}

/** Turn local NT junction targets into normal drive paths; leave remote/device targets rejectable. */
function normalizeLocalLinkTarget(
  target: string,
  platform: NodeJS.Platform,
): string {
  if (platform !== "win32") return target;
  const localNt = target.match(/^(?:\\\\\?\\|\\\?\?\\)([A-Za-z]:[\\/].*)$/);
  return localNt ? localNt[1] : target;
}

/**
 * Inspect an untrusted registered path one component at a time. lstat/readlink
 * sees a symlink or Windows junction without following it, so explicit remote
 * targets and cross-drive aliases are rejected before realpath can traverse
 * them. OS-mounted network filesystems remain an environmental boundary.
 * This is snapshot validation, not handle-bound traversal: a writable ancestor
 * can still change between lstat/readlink, realpath, stat, and the external
 * GBrain reopen; inode reuse is also theoretically possible. Rechecks shrink
 * and diagnose that non-zero race window but cannot make it atomic.
 */
function preflightLocalLinkChain(
  resolvedPath: string,
  expectedRoot: string,
  label: string,
  platform: NodeJS.Platform,
  fsOps: DirectoryFsOps,
): string {
  const path = pathApi(platform);
  const expectedVolume = path.parse(expectedRoot).root;
  const initialVolume = path.parse(resolvedPath).root;
  if (
    comparableRoot(initialVolume, platform) !==
    comparableRoot(expectedVolume, platform)
  ) {
    throw new Error(
      `${label} "${resolvedPath}" is on a different filesystem root from expected "${expectedRoot}"; ` +
        "refusing it before filesystem access. Source registration unchanged.",
    );
  }

  let currentRoot = initialVolume;
  let pending = splitPathComponents(
    resolvedPath.slice(initialVolume.length),
    platform,
  ).filter(Boolean);
  const visited = new Set<string>();
  let linkHops = 0;

  while (pending.length > 0) {
    const component = pending.shift()!;
    const candidate = path.join(currentRoot, component);
    let stat: ReturnType<DirectoryFsOps["lstat"]>;
    try {
      stat = fsOps.lstat(candidate);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return path.join(candidate, ...pending);
      }
      throw err;
    }
    if (!stat.isSymbolicLink()) {
      currentRoot = candidate;
      continue;
    }

    linkHops += 1;
    if (linkHops > 40) {
      throw new Error(
        `${label} "${resolvedPath}" exceeds 40 symbolic-link hops; source registration unchanged.`,
      );
    }

    const rawTarget = fsOps.readlink(candidate);
    const target = normalizeLocalLinkTarget(rawTarget, platform);
    assertSafePathSyntax(target, `${label} link target`, platform);
    if (hasNestedParentTraversal(target, platform)) {
      throw new Error(
        `${label} link target "${rawTarget}" contains parent traversal after a path component; ` +
          "refusing it before filesystem access. Source registration unchanged.",
      );
    }
    const absoluteTarget = path.isAbsolute(target)
      ? path.resolve(target)
      : path.resolve(path.dirname(candidate), target);
    const targetVolume = path.parse(absoluteTarget).root;
    if (
      comparableRoot(targetVolume, platform) !==
      comparableRoot(expectedVolume, platform)
    ) {
      throw new Error(
        `${label} link target "${rawTarget}" crosses filesystem roots; ` +
          "refusing it before filesystem access. Source registration unchanged.",
      );
    }

    // Preserve component case: Windows volumes can enable per-directory case
    // sensitivity. A case-insensitive cycle may take up to the hop cap to
    // reject, but distinct case-sensitive targets must not be conflated.
    const cycleKey = `${absoluteTarget}\0${pending.join("/")}`;
    if (visited.has(cycleKey)) {
      throw new Error(
        `${label} "${resolvedPath}" contains a symbolic-link cycle; source registration unchanged.`,
      );
    }
    visited.add(cycleKey);
    currentRoot = targetVolume;
    pending = [
      ...splitPathComponents(
        absoluteTarget.slice(targetVolume.length),
        platform,
      ).filter(Boolean),
      ...pending,
    ];
  }

  return currentRoot;
}

/**
 * Resolve a database-provided local path for containment checks without first
 * following direct remote/device namespaces or local links to them. Missing
 * suffixes retain their fully expanded lexical spelling; callers can still
 * classify an already-removed managed clone without weakening link handling.
 */
export function resolveLocalPathForContainment(
  rawPath: string,
  trustedRoot: string,
  platform: NodeJS.Platform = process.platform,
  fsOps: DirectoryFsOps = DEFAULT_DIRECTORY_FS_OPS,
): string {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    throw new Error("local path is missing or empty");
  }
  assertSafePathSyntax(rawPath, "local path", platform);
  if (hasParentTraversal(rawPath, platform)) {
    throw new Error("local path contains parent traversal");
  }

  const path = pathApi(platform);
  const resolvedRoot = path.resolve(trustedRoot);
  const resolvedPath = path.resolve(rawPath);
  const inspectedPath = preflightLocalLinkChain(
    resolvedPath,
    resolvedRoot,
    "local path",
    platform,
    fsOps,
  );

  let canonicalPath = inspectedPath;
  try {
    canonicalPath = normalizeLocalLinkTarget(
      fsOps.realpath(inspectedPath),
      platform,
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  assertSafePathSyntax(canonicalPath, "local path canonical path", platform);
  return canonicalPath;
}

/**
 * Resolve and validate one directory without mutating GBrain state.
 * Relative registered paths are anchored to the expected repository root,
 * never to the caller's ambient cwd.
 */
function canonicalDirectory(
  rawPath: string,
  label: string,
  relativeTo?: string,
  recoveryHint = "Inspect the path, then rerun /sync-gbrain.",
  platform: NodeJS.Platform = process.platform,
  fsOps: DirectoryFsOps = DEFAULT_DIRECTORY_FS_OPS,
): CanonicalDirectory {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    throw new Error(
      `${label} "${String(rawPath)}" is missing or empty; source registration unchanged. ${recoveryHint}`,
    );
  }

  assertSafePathSyntax(rawPath, label, platform);
  const path = pathApi(platform);

  const resolvedPath = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(relativeTo ?? process.cwd(), rawPath);

  // Never collapse an untrusted `..` lexically: `link/..` is resolved by the
  // filesystem relative to the link target and can escape or reach a UNC
  // target even when path.resolve() appears to land back at the expected root.
  if (relativeTo !== undefined && hasParentTraversal(rawPath, platform)) {
    throw new Error(
      `${label} "${rawPath}" contains parent traversal; ` +
        `refusing it before filesystem access. Source registration unchanged. ${recoveryHint}`,
    );
  }

  // A relative stored spelling is meaningful only inside the expected
  // repository boundary. Permit normal aliases such as ".", but do not let a
  // database value resolve into an arbitrary sibling before realpath.
  if (relativeTo !== undefined && !path.isAbsolute(rawPath)) {
    const rel = path.relative(relativeTo, resolvedPath);
    if (
      rel === ".." ||
      rel.startsWith(`..${path.sep}`) ||
      path.isAbsolute(rel)
    ) {
      throw new Error(
        `${label} "${rawPath}" escapes expected root "${relativeTo}"; ` +
          `refusing it before filesystem access. Source registration unchanged. ${recoveryHint}`,
      );
    }
  }

  try {
    let inspectedPath = resolvedPath;
    if (relativeTo !== undefined) {
      inspectedPath = preflightLocalLinkChain(
        resolvedPath,
        relativeTo,
        label,
        platform,
        fsOps,
      );
    }
    const canonicalPath = normalizeLocalLinkTarget(
      fsOps.realpath(inspectedPath),
      platform,
    );
    // realpath may expand a short path or traverse a symlink into characters
    // that were absent from the raw spelling; validate what GBrain will receive.
    assertSafePathSyntax(canonicalPath, `${label} canonical path`, platform);
    const stat = fsOps.stat(canonicalPath);
    if (!stat.isDirectory()) {
      throw new Error("not a directory");
    }
    return { rawPath, canonicalPath, device: stat.dev, inode: stat.ino };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${label} "${rawPath}" resolved to "${resolvedPath}" is not an existing directory: ${reason}; ` +
      `source registration unchanged. ${recoveryHint}`,
    );
  }
}

/** Capture the identity of the caller-owned source directory. */
export function canonicalSourceDirectory(
  rawPath: string,
  platform: NodeJS.Platform = process.platform,
  fsOps: DirectoryFsOps = DEFAULT_DIRECTORY_FS_OPS,
): CanonicalDirectory {
  return canonicalDirectory(
    rawPath,
    "expected source path",
    undefined,
    "Inspect or repair the repository path, then rerun /sync-gbrain.",
    platform,
    fsOps,
  );
}

/** Canonical, locally safe directory path for callers that need a cwd. */
export function canonicalSourceDirectoryPath(
  rawPath: string,
  platform: NodeJS.Platform = process.platform,
  fsOps: DirectoryFsOps = DEFAULT_DIRECTORY_FS_OPS,
): string {
  return canonicalSourceDirectory(rawPath, platform, fsOps).canonicalPath;
}

export interface SourcePathBinding {
  /** Canonical path captured by the caller and safe to use as cwd. */
  canonicalPath: string;
  /** Pass the canonical path explicitly (`--repo` / `--dir`) to ignore aliases. */
  useExplicitPath: boolean;
}

/** Safely compare one stored source spelling with a caller-captured directory. */
export function registeredSourceMatchesDirectory(
  registeredPath: string,
  expected: CanonicalDirectory,
  platform: NodeJS.Platform = process.platform,
  fsOps: DirectoryFsOps = DEFAULT_DIRECTORY_FS_OPS,
  requireStableIdentity = false,
): boolean {
  const registered = canonicalDirectory(
    registeredPath,
    `registered source path (expected root "${expected.rawPath}")`,
    expected.canonicalPath,
    "Inspect `gbrain sources list --json` and repair the source path deliberately, then rerun /sync-gbrain.",
    platform,
    fsOps,
  );
  return requireStableIdentity
    ? sameStableDirectoryIdentity(registered, expected)
    : sameDirectoryIdentity(registered, expected);
}

/**
 * Bind a previously validated source row to its canonical directory for the
 * next GBrain filesystem operation. On POSIX, argv transport is native and an
 * explicit canonical path is always safe. On Windows, the current `.cmd`
 * launcher uses a shell: safe paths get the explicit override; unsafe paths
 * may proceed only when the stored spelling is exactly `.` or the canonical
 * absolute path, neither of which leaves a rebindable alias for GBrain to open.
 */
export function bindRegisteredSourcePath(
  registeredPath: string,
  expected: CanonicalDirectory,
  platform: NodeJS.Platform = process.platform,
  fsOps: DirectoryFsOps = DEFAULT_DIRECTORY_FS_OPS,
): SourcePathBinding {
  if (
    !registeredSourceMatchesDirectory(registeredPath, expected, platform, fsOps)
  ) {
    throw new Error(
      `registered source path "${registeredPath}" no longer identifies "${expected.canonicalPath}"; ` +
        "refusing the filesystem operation. Rerun /sync-gbrain.",
    );
  }

  if (platform !== "win32" || isSafeWindowsShellPath(expected.canonicalPath)) {
    return { canonicalPath: expected.canonicalPath, useExplicitPath: true };
  }

  const path = pathApi(platform);
  const safelyCwdRelative =
    !path.isAbsolute(registeredPath) && path.normalize(registeredPath) === ".";
  const exactCanonicalAbsolute =
    path.isAbsolute(registeredPath) &&
    registeredPath === expected.canonicalPath;
  if (!safelyCwdRelative && !exactCanonicalAbsolute) {
    throw new Error(
      `registered source path "${registeredPath}" is an alias, but canonical path ` +
        `"${expected.canonicalPath}" is unsafe for the current Windows GBrain shell transport; ` +
        "refusing to follow a rebindable alias. Repair the registration from a shell-safe path.",
    );
  }
  return { canonicalPath: expected.canonicalPath, useExplicitPath: false };
}

/** Compare filesystem objects without assuming every Windows directory is case-insensitive. */
function sameDirectoryIdentity(
  left: CanonicalDirectory,
  right: CanonicalDirectory,
): boolean {
  // Modern filesystems expose a stable (device, inode/file-id) pair. A few
  // adapters report inode 0; fall back to realpath spelling there rather than
  // falsely treating every directory on the device as identical.
  if (left.inode !== 0n && right.inode !== 0n) {
    return left.device === right.device && left.inode === right.inode;
  }
  return left.canonicalPath === right.canonicalPath;
}

/** Temporal checks require an identity token; a repeated pathname is not proof. */
function sameStableDirectoryIdentity(
  left: CanonicalDirectory,
  right: CanonicalDirectory,
): boolean {
  return (
    left.inode !== 0n &&
    right.inode !== 0n &&
    left.device === right.device &&
    left.inode === right.inode
  );
}

/**
 * Re-stat a previously validated directory around a path-based side effect.
 * The external process still reopens by pathname; this detects observable
 * replacement but is not a zero-window lease or open-handle binding.
 */
export function assertCanonicalDirectoryUnchanged(
  expected: CanonicalDirectory,
  label = "expected source path",
  fsOps: DirectoryFsOps = DEFAULT_DIRECTORY_FS_OPS,
): void {
  try {
    const stat = fsOps.stat(expected.canonicalPath);
    const current: CanonicalDirectory = {
      rawPath: expected.rawPath,
      canonicalPath: expected.canonicalPath,
      device: stat.dev,
      inode: stat.ino,
    };
    if (!stat.isDirectory()) {
      throw new Error("path is no longer a directory");
    }
    if (expected.inode === 0n || current.inode === 0n) {
      throw new Error(
        "stable directory identity is unavailable (inode/file-id is zero)",
      );
    }
    if (!sameStableDirectoryIdentity(current, expected)) {
      throw new Error("directory identity changed");
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${label} "${expected.canonicalPath}" changed after validation: ${reason}; ` +
        "stopping before any further operation. Rerun /sync-gbrain from the intended repository, " +
        "and inspect GBrain source state if registration had already begun.",
    );
  }
}

/**
 * Probe the registration state of a source by id.
 *
 * Errors:
 *   - "gbrain CLI not on PATH" (exit 127) — caller should treat as absent + skip stage.
 *   - "gbrain DB connection failed" — caller should treat as absent + skip stage.
 *   - JSON parse error — propagate via withErrorContext caller.
 */
export function probeSource(id: string, env?: NodeJS.ProcessEnv): SourceState {
  let stdout: string;
  try {
    stdout = execFileSync("gbrain", ["sources", "list", "--json"], {
      encoding: "utf-8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
      env,
      shell: NEEDS_SHELL_ON_WINDOWS, // #1731: gbrain is a .cmd shim on Windows
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer };
    const stderr = e.stderr?.toString() || "";
    if (e.code === "ENOENT" || stderr.includes("command not found")) {
      throw new Error("gbrain CLI not on PATH");
    }
    if (stderr.includes("Cannot connect to database") || stderr.includes("config.json")) {
      throw new Error("gbrain not configured (run /setup-gbrain)");
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`gbrain sources list returned non-JSON output: ${(err as Error).message}`);
  }

  const sources = parseSourcesListStrict(parsed);
  const match = sources.find((s) => s.id === id);
  if (!match) return { status: "absent" };
  return {
    status: "match",
    registered_path: match.local_path ?? undefined,
  };
}

/**
 * Ensure source <id> is registered at <path>. Idempotent.
 *
 * Behavior:
 *   - status=absent  → `gbrain sources add <id> --path <path> [--federated]`, returns changed=true.
 *   - status=match + same canonical directory → no-op, returns changed=false.
 *   - status=match + different canonical directory → `sources remove` + `sources add`, returns changed=true.
 *     (Skip when reregister_on_drift=false; returns changed=false.)
 *   - an absent/non-directory/unresolvable path → throw before remove/add.
 *
 * Caller is responsible for catching errors. The function uses withErrorContext for
 * forensic logging to ~/.gstack/.gbrain-errors.jsonl.
 */
export async function ensureSourceRegistered(
  id: string,
  path: string,
  options: EnsureOptions = {},
): Promise<EnsureResult> {
  const federated = options.federated ?? false;
  const reregister_on_drift = options.reregister_on_drift ?? true;
  const env = options.env;
  const platform = options.platform ?? process.platform;
  const fsOps = options.fsOps ?? DEFAULT_DIRECTORY_FS_OPS;

  return withErrorContext(
    `ensureSourceRegistered:${id}`,
    () => {
      assertSafeSourceId(id);
      const probed = probeSource(id, env);

      // Validate the caller-owned repository before any possible add/remove.
      const registeredContext =
        probed.status === "match"
          ? ` (registered path "${String(probed.registered_path)}")`
          : "";
      const expected = canonicalDirectory(
        path,
        `expected source path${registeredContext}`,
        undefined,
        "Inspect or repair the repository path, then rerun /sync-gbrain.",
        platform,
        fsOps,
      );
      if (options.expected_identity) {
        if (!sameStableDirectoryIdentity(expected, options.expected_identity)) {
          const reason =
            expected.inode === 0n || options.expected_identity.inode === 0n
              ? "stable directory identity is unavailable (inode/file-id is zero)"
              : "directory identity changed";
          throw new Error(
            `expected source path "${expected.canonicalPath}" changed after caller validation: ${reason}; ` +
              "source registration unchanged. Rerun /sync-gbrain from the intended repository.",
          );
        }
      }

      // Disambiguate match-but-different-path by filesystem identity. GBrain may
      // persist a relative spelling such as "."; interpret it from the expected
      // repository root rather than process.cwd so comparison is deterministic.
      let state: SourceState = probed;
      if (probed.status === "match") {
        const registered = canonicalDirectory(
          probed.registered_path ?? "",
          `registered source path (expected root "${expected.rawPath}")`,
          expected.canonicalPath,
          "Inspect `gbrain sources list --json` and repair the source path deliberately, then rerun /sync-gbrain.",
          platform,
          fsOps,
        );
        if (!sameDirectoryIdentity(registered, expected)) {
          state = { status: "drift", registered_path: probed.registered_path };
        }
      }

      if (state.status === "match") {
        return { changed: false, state };
      }

      if (state.status === "drift" && !reregister_on_drift) {
        return { changed: false, state };
      }

      // Only mutation needs to transport the path through cmd.exe on Windows.
      // Exact no-op sources continue to work from ordinary paths with spaces.
      assertSafeMutationPath(expected.canonicalPath, platform);

      // For drift, remove first.
      let removedForDrift = false;
      if (state.status === "drift") {
        if (!options.removeSource) {
          throw new Error(
            `source ${id} is registered to a different directory, but no guarded removal policy was provided; ` +
              "source registration unchanged. Repair the source deliberately, then rerun /sync-gbrain.",
          );
        }
        options.beforeMutation?.("before-remove");
        assertCanonicalDirectoryUnchanged(
          expected,
          "expected source path before remove",
          fsOps,
        );
        try {
          options.removeSource(id, state.registered_path!, env);
          removedForDrift = true;
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          try {
            assertCanonicalDirectoryUnchanged(
              expected,
              "expected source path after failed remove",
              fsOps,
            );
          } catch (identityErr) {
            throw new Error(
              `${(identityErr as Error).message} Guarded remove also failed (${reason}); ` +
                "source state is ambiguous. Inspect `gbrain sources list --json` before retrying.",
            );
          }
          throw new Error(
            `guarded path-drift remove for ${id} failed: ${reason}; source state may have changed. ` +
              "Inspect `gbrain sources list --json` before retrying.",
          );
        }
        assertCanonicalDirectoryUnchanged(
          expected,
          "expected source path after remove",
          fsOps,
        );
        let afterRemove: SourceState;
        try {
          afterRemove = probeSource(id, env);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          throw new Error(
            `guarded path-drift remove for ${id} completed, but the old registration was already removed ` +
              `and the resulting source state could not be confirmed (${reason}). Source state is absent or ` +
              "ambiguous; inspect `gbrain sources list --json` before retrying.",
          );
        }
        if (afterRemove.status !== "absent") {
          throw new Error(
            `guarded path-drift remove for ${id} returned without removing the validated source; ` +
              "source state is ambiguous. Inspect `gbrain sources list --json` before retrying.",
          );
        }
      }

      // Reuse the validated canonical spelling and re-check identity immediately
      // before the path-based write. The external CLI still reopens by pathname.
      options.beforeMutation?.("before-add");
      assertCanonicalDirectoryUnchanged(
        expected,
        "expected source path before add",
        fsOps,
      );
      const addArgs = ["sources", "add", id, "--path", expected.canonicalPath];
      if (federated) addArgs.push("--federated");
      let add: ReturnType<typeof spawnSync>;
      try {
        add = spawnSync("gbrain", addArgs, {
          encoding: "utf-8",
          timeout: 30_000,
          env,
          shell: NEEDS_SHELL_ON_WINDOWS, // #1731: gbrain is a .cmd shim on Windows
        });
      } catch (err) {
        options.beforeMutation?.("after-add");
        assertCanonicalDirectoryUnchanged(
          expected,
          "expected source path after failed add",
          fsOps,
        );
        const priorState = removedForDrift
          ? "The previous drifted registration was already removed"
          : "The source may not have been registered";
        throw new Error(
          `gbrain sources add ${id} failed to start: ${(err as Error).message}. ${priorState}; ` +
            "source state is absent or ambiguous. Inspect `gbrain sources list --json` before retrying.",
        );
      }
      options.beforeMutation?.("after-add");
      assertCanonicalDirectoryUnchanged(
        expected,
        "expected source path after add",
        fsOps,
      );
      if (add.status !== 0) {
        const priorState = removedForDrift
          ? " The previous drifted registration was already removed; source state is now absent or ambiguous."
          : " Source state may be absent or ambiguous.";
        throw new Error(
          `gbrain sources add ${id} failed: ${add.stderr || add.stdout || `exit ${add.status}`}.` +
            `${priorState} Inspect \`gbrain sources list --json\` before retrying.`,
        );
      }

      let confirmed: SourceState;
      try {
        confirmed = probeSource(id, env);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(
          `gbrain sources add ${id} returned success, but persisted state could not be confirmed (${reason}). ` +
            "Source state is ambiguous; inspect `gbrain sources list --json` before retrying.",
        );
      }
      if (
        confirmed.status !== "match" ||
        confirmed.registered_path !== expected.canonicalPath
      ) {
        throw new Error(
          `gbrain sources add ${id} did not persist the validated path "${expected.canonicalPath}"; ` +
            "source state is ambiguous. Inspect `gbrain sources list --json` before retrying.",
        );
      }

      return {
        changed: true,
        state: { status: "match", registered_path: expected.canonicalPath },
      };
    },
    "gbrain-sources",
  );
}

/**
 * Get page_count for a registered source. Returns null if source is absent or if
 * page_count is missing/invalid in the JSON. Used by the verdict block + preamble
 * variant selection.
 */
export function sourcePageCount(id: string, env?: NodeJS.ProcessEnv): number | null {
  let stdout: string;
  try {
    stdout = execFileSync("gbrain", ["sources", "list", "--json"], {
      encoding: "utf-8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
      env,
      shell: NEEDS_SHELL_ON_WINDOWS, // #1731: gbrain is a .cmd shim on Windows
    });
  } catch {
    return null;
  }

  try {
    const match = parseSourcesList(JSON.parse(stdout)).find((s) => s.id === id);
    if (!match) return null;
    if (typeof match.page_count !== "number") return null;
    return match.page_count;
  } catch {
    return null;
  }
}

/**
 * Whether a source's call graph has been built.
 *
 *   "completed" — `gbrain dream` has run a full maintenance cycle, so the
 *                 brain-global `resolve_symbol_edges` phase populated this
 *                 source's call graph (`gbrain code-callers`/`code-callees`
 *                 return edges).
 *   "never"     — a cycle has provably NOT completed for this source.
 *   "unknown"   — doctor is unavailable, unparseable, or reports a failure
 *                 that doesn't name this source. Callers MUST treat unknown
 *                 conservatively (the orchestrator skips auto-dream and WARNs
 *                 rather than launch a ~35-min cycle on a flaky-doctor signal —
 *                 see the `gbrain-doctor-overstrict` learning).
 */
export type CycleStatus = "completed" | "never" | "unknown";

interface DoctorCheck {
  name?: string;
  status?: string;
  message?: string;
}
interface DoctorReport {
  checks?: DoctorCheck[];
}

/**
 * Read `gbrain doctor --json --fast` and decide whether <sourceId>'s call
 * graph is built, by inspecting the `cycle_freshness` check.
 *
 * Decision table (cycle_freshness.status / message):
 *   - ok                                        → "completed"
 *   - fail|warn AND message names <sourceId>    → "never"
 *   - fail|warn AND message omits <sourceId>    → "unknown"  (a real failure
 *       about OTHER sources must not be silently read as completed for us)
 *   - check absent / doctor null / other status → "unknown"
 *
 * `sourceId` is matched as a LITERAL substring (not a regex) so an id with
 * regex metacharacters can never misfire. Routes through `execGbrainJson` so
 * DATABASE_URL is seeded from gbrain's config (consistent with every other
 * gstack-side gbrain call). `env` is the caller's base env (tests inject a
 * shim on PATH).
 */
export function cycleCompleted(sourceId: string, env?: NodeJS.ProcessEnv): CycleStatus {
  const report = execGbrainJson<DoctorReport>(["doctor", "--json", "--fast"], { baseEnv: env });
  if (!report || !Array.isArray(report.checks)) return "unknown";

  const check = report.checks.find((c) => c.name === "cycle_freshness");
  if (!check) return "unknown";

  if (check.status === "ok") return "completed";
  if (check.status === "fail" || check.status === "warn") {
    const msg = check.message || "";
    return msg.includes(sourceId) ? "never" : "unknown";
  }
  return "unknown";
}
