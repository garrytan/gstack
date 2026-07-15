/**
 * gbrain-guards — defense-in-depth against gbrain's destructive code paths (#1734).
 *
 * gbrain (the separate CLI gstack shells out to) can rm-rf a user's working tree
 * during an autopilot race (its own bug, upstream gbrain #1526). gstack can't fix
 * that, but it MUST stop treating gbrain's destructive subcommands as safe. These
 * guards gate the two ways the orchestrator can reach destruction:
 *
 *   1. `sources remove --confirm-destructive`  → decideSourceRemove()
 *   2. `sync --strategy code` (can auto-reclone) → decideCodeSync()
 *
 * plus an autopilot-active check (detectAutopilot) that refuses to run destructive
 * ops concurrently with the daemon.
 *
 * Design notes grounded in the real gbrain 0.41.x surface:
 *   - There is NO `--keep-storage` flag and NO structured capability command, and
 *     subcommand `--help` is generic — so capability detection is best-effort and
 *     defaults to "unsupported". When we can't protect a user-managed source's
 *     files, we FAIL CLOSED (refuse the remove) rather than delete unprotected.
 *   - Current gbrain treats GBRAIN_HOME as the parent of `.gbrain`; older
 *     releases treated it as the state directory itself. The live process is
 *     the PRIMARY signal; lock paths for both layouts are secondary.
 *   - We refuse only on an AFFIRMATIVE autopilot signal — inability to introspect
 *     never blocks a normal sync (that would brick the tool).
 *   - Path containment uses realpath so a symlink inside ~/.gbrain/clones can't
 *     smuggle a delete out to a user repo.
 *
 * Pure decision functions; the orchestrator logs the reasons (observability).
 */

import { spawnSync } from "child_process";
import { existsSync, lstatSync, realpathSync, readFileSync } from "fs";
import { homedir } from "os";
import { join, resolve, sep } from "path";
import { execGbrainJson, execGbrainText, NEEDS_SHELL_ON_WINDOWS } from "./gbrain-exec";
import { parseSourcesListStrict, type GbrainSourceRow } from "./gbrain-sources";

function effectiveHome(env: NodeJS.ProcessEnv): string {
  return env.HOME?.trim() || homedir();
}

export function gbrainHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.GBRAIN_HOME?.trim();
  return override ? join(override, ".gbrain") : join(effectiveHome(env), ".gbrain");
}

/** Current gbrain home first, followed by legacy/default compatibility paths. */
function gbrainHomes(env: NodeJS.ProcessEnv = process.env): string[] {
  const override = env.GBRAIN_HOME?.trim();
  return [...new Set([
    gbrainHome(env),
    ...(override ? [override] : []),
    join(effectiveHome(env), ".gbrain"),
  ])];
}

/**
 * Infer the ONE active state layout used for destructive ownership decisions.
 * Current gbrain treats GBRAIN_HOME as a parent; a legacy config directly under
 * GBRAIN_HOME is accepted only when the current nested config is absent.
 * Multi-path probing is deliberately reserved for non-destructive lock checks.
 */
function destructiveGbrainHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.GBRAIN_HOME?.trim();
  if (!override) return join(effectiveHome(env), ".gbrain");
  const current = join(override, ".gbrain");
  if (!existsSync(join(current, "config.json")) && existsSync(join(override, "config.json"))) {
    return override;
  }
  return current;
}

/**
 * Mirror gbrain's ownership invariant: an explicit managed_clone marker, or an
 * exact default clone path for this source. Merely living somewhere below a
 * clones directory never proves ownership.
 */
function isOwnedClone(row: GbrainSourceRow, env: NodeJS.ProcessEnv): boolean {
  if (row.config?.managed_clone === true) return true;
  if (!row.id || !row.local_path) return false;
  const actual = resolve(row.local_path);
  const expected = resolve(join(destructiveGbrainHome(env), "clones", row.id));
  if (actual !== expected) return false;
  try {
    return !lstatSync(actual).isSymbolicLink();
  } catch {
    // A missing legacy default clone still has an exact, source-specific path;
    // there is no filesystem entry for remove to traverse.
    return true;
  }
}

/** True if `p` resolves (symlinks + `..` collapsed) to a location inside `dir`. */
export function isInside(p: string, dir: string): boolean {
  let rp: string;
  let rd: string;
  try { rp = realpathSync(p); } catch { rp = resolve(p); }
  try { rd = realpathSync(dir); } catch { rd = resolve(dir); }
  const base = rd.endsWith(sep) ? rd : rd + sep;
  return rp === rd || rp.startsWith(base);
}

// ── Autopilot detection (E1: multi-signal, affirmative-only) ────────────────

export interface AutopilotStatus {
  active: boolean;
  /** Which signal fired (lock path or "process"), or null when inactive. */
  signal: string | null;
}

export interface AutopilotProbe {
  /** Override the lock-path list (tests). */
  lockPaths?: string[];
  /** Override the live-process check (tests). */
  processRunning?: () => boolean;
}

/**
 * Detect a running gbrain autopilot. Refuse the caller's destructive op only on
 * an affirmative signal; absence of a confirmable mechanism returns inactive so
 * normal syncs are never bricked.
 */
export function detectAutopilot(
  env: NodeJS.ProcessEnv = process.env,
  probe: AutopilotProbe = {},
): AutopilotStatus {
  // Secondary signal: current, legacy, and default lock paths. This remains
  // sufficient on Windows where there is no reliable pgrep fallback.
  const lockPaths = probe.lockPaths ?? gbrainHomes(env).flatMap((home) => [
    join(home, "autopilot.lock"),
    join(home, "autopilot.pid"),
  ]);
  for (const lp of lockPaths) {
    if (!existsSync(lp)) continue;
    // A lock FILE alone is not proof of life — a crashed daemon leaves a stale
    // lock that would otherwise wedge every sync forever (observed: a dead pid
    // refused --full indefinitely). Read the holder pid and check liveness.
    const pid = readLockPid(lp);
    if (pid === null) {
      // Can't introspect (no parseable pid) → stay conservative: treat as active.
      return { active: true, signal: `lock:${lp}` };
    }
    if (isPidAlive(pid)) {
      return { active: true, signal: `lock:${lp} (pid ${pid})` };
    }
    // Stale lock (holder pid is dead): ignore this signal, keep checking. Pure
    // decision function — we do NOT delete the file here; the caller may clean it.
  }
  // Primary signal: a live `gbrain autopilot` process.
  const running = (probe.processRunning ?? defaultProcessRunning)();
  if (running) return { active: true, signal: "process:gbrain autopilot" };
  return { active: false, signal: null };
}

/** Read the holder pid from a lock/pid file. Returns null if no integer pid is present. */
function readLockPid(lockPath: string): number | null {
  try {
    const raw = readFileSync(lockPath, "utf-8").trim();
    // Files seen: a bare pid ("65495"), or JSON like {"pid":65495,...}.
    const m = raw.match(/"pid"\s*:\s*(\d+)/) ?? raw.match(/^(\d+)$/);
    if (!m) return null;
    const pid = Number.parseInt(m[1], 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Liveness via signal 0: no signal sent, just an existence/permission check.
 * ESRCH → dead; EPERM → alive but owned by another user. Cross-host pids are
 * meaningless, but the autopilot lock is same-host by construction.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function defaultProcessRunning(): boolean {
  // No reliable pgrep on Windows; rely on the lock-file signal there.
  if (process.platform === "win32") return false;
  const r = spawnSync("pgrep", ["-f", "gbrain autopilot"], { encoding: "utf-8", timeout: 3_000 });
  return r.status === 0 && (r.stdout || "").trim().length > 0;
}

// ── Capability detection (E4 + Codex: per-process memo, no persistent cache) ─
//
// No structured capability command exists and subcommand --help is generic, so
// --keep-storage support can't be probed reliably; default unsupported. Memoize
// per process (keyed to the resolved gbrain identity) rather than persisting a
// cross-run cache — Codex flagged stale persistent caches, and the probe is cheap.

let _keepStorageMemo: { key: string; value: boolean } | undefined;

function gbrainIdentity(env: NodeJS.ProcessEnv): string {
  const r = spawnSync("gbrain", ["--version"], {
    encoding: "utf-8",
    timeout: 3_000,
    shell: NEEDS_SHELL_ON_WINDOWS,
    env,
  });
  return (r.stdout || "").trim() || "unknown";
}

type GbrainVersion = [number, number, number];

function parseGbrainVersion(identity: string): GbrainVersion | null {
  const match = identity.match(/\b(\d+)\.(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function versionIsBefore(version: GbrainVersion, floor: GbrainVersion): boolean {
  for (let i = 0; i < floor.length; i += 1) {
    if (version[i] > floor[i]) return false;
    if (version[i] < floor[i]) return true;
  }
  return false;
}

/**
 * gbrain 0.26.5 introduced --confirm-destructive for source removal. Older
 * positively identified clients support only --yes. Unknown/new clients stay
 * on the current fail-closed contract; never optimistically downgrade them.
 */
export function gbrainSourceRemoveConfirmationArgs(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return gbrainSourceRemoveConfirmationArgsForIdentity(gbrainIdentity(env));
}

/** Pure identity variant for shell helpers that invoke an explicit GBRAIN_BIN. */
export function gbrainSourceRemoveConfirmationArgsForIdentity(identity: string): string[] {
  const version = parseGbrainVersion(identity);
  return version && versionIsBefore(version, [0, 26, 5])
    ? ["--yes"]
    : ["--confirm-destructive"];
}

/**
 * URL-managed sources first shipped in gbrain 0.28.0. An older, positively
 * identified CLI cannot own a remote clone, so its metadata-free `sources
 * list --json` rows are safe to treat as path-managed. Unknown/new versions
 * stay conservative because they may support `--url` while omitting config.
 */
function gbrainMaySupportUrlSources(env: NodeJS.ProcessEnv): boolean {
  const version = parseGbrainVersion(gbrainIdentity(env));
  return !version || !versionIsBefore(version, [0, 28, 0]);
}

/** `gbrain call --source` landed in 0.31.8; older call surfaces are global. */
function gbrainSupportsScopedCall(env: NodeJS.ProcessEnv): boolean {
  const version = parseGbrainVersion(gbrainIdentity(env));
  // Unknown identities stay on the current, explicitly scoped contract. A
  // failed scoped call then falls back to metadata-free CLI rows and the
  // destructive callers fail closed rather than trusting ambiguous metadata.
  return !version || !versionIsBefore(version, [0, 31, 8]);
}

export function gbrainSupportsKeepStorage(env: NodeJS.ProcessEnv = process.env): boolean {
  const key = gbrainIdentity(env);
  if (_keepStorageMemo && _keepStorageMemo.key === key) return _keepStorageMemo.value;
  let value = false;
  for (const args of [["sources", "remove", "--help"], ["--help"]]) {
    try {
      if (/--keep-storage/.test(execGbrainText(args, { baseEnv: env, timeout: 5_000 }))) {
        value = true;
        break;
      }
    } catch {
      // generic/empty help or non-zero exit → treat as unsupported
    }
  }
  _keepStorageMemo = { key, value };
  return value;
}

/** Test-only: reset the per-process capability memo. */
export function _resetCapabilityMemo(): void {
  _keepStorageMemo = undefined;
}

// ── Destructive-op decisions ────────────────────────────────────────────────

/**
 * Fetch + normalize the source list. Throws on read/parse failure so callers can
 * distinguish "couldn't read" (fail closed) from "empty list" (source absent).
 * Injectable for hermetic tests.
 */
export function fetchSources(env: NodeJS.ProcessEnv = process.env): GbrainSourceRow[] {
  // The public CLI list intentionally omits ownership config. The read-only
  // sources_list operation exposes an authoritative (redacted) remote_url,
  // which is exactly the bit the destructive/reclone guards need. Older gbrain
  // releases may not have `call`; retain the CLI fallback. Metadata-free rows
  // fail closed except on a positively identified pre-0.28 CLI, which predates
  // the URL-managed source surface entirely.
  // First obtain a source id through the non-scoped CLI list. Clear a stale
  // GBRAIN_SOURCE pin; `sources list` does not need source resolution.
  const neutralEnv = { ...env };
  delete neutralEnv.GBRAIN_SOURCE;
  const listed = execGbrainJson(["sources", "list", "--json"], { baseEnv: neutralEnv });
  if (listed === null) throw new Error("gbrain sources list returned no JSON");
  const cliRows = parseSourcesListStrict(listed);
  if (cliRows.length === 0) return [];

  // Current `gbrain call` resolves a source before dispatch, even for global
  // metadata. Pin it explicitly to a source proven by the list above. Releases
  // 0.28.0-0.31.7 already expose URL-managed ownership metadata but predate the
  // `call --source` grammar; their call surface is global and must be invoked
  // without the flag. Unknown identities stay scoped/fail-closed.
  const anchor = cliRows.find((row) => /^[a-z0-9-]{1,32}$/.test(row.id ?? ""));
  if (!anchor?.id) throw new Error("gbrain sources list had no usable source id");
  const callArgs = gbrainSupportsScopedCall(neutralEnv)
    ? ["call", "--source", anchor.id, "sources_list", "{}"]
    : ["call", "sources_list", "{}"];
  const authoritative = execGbrainJson(
    callArgs,
    { baseEnv: neutralEnv },
  );
  if (authoritative === null) {
    // Older clients have no `call` surface. Preserve their CLI rows; callers
    // still apply the version-gated metadata policy below.
    return cliRows;
  }
  return parseSourcesListStrict(authoritative);
}

export interface RemoveDecision {
  allow: boolean;
  /** Extra args to append to `sources remove` (e.g. --keep-storage). */
  extraArgs: string[];
  reason: string;
}

/**
 * Decide whether `sources remove <id>` is safe, and with what flags.
 *
 * Fail-closed cases (allow=false):
 *   - sources list unreadable/unparseable (can't prove the row is safe).
 *   - ownership metadata is unavailable on a CLI that may support URL sources.
 *   - the row is user-managed (remote_url set without an authoritative
 *     managed-clone marker/default path) and gbrain has no --keep-storage.
 *
 * Allowed: absent row (no-op), authoritatively gbrain-managed, or path-managed
 * without a remote_url. --keep-storage is appended whenever supported.
 */
export interface DecideRemoveOpts {
  /** Override capability detection (tests / cached caps). */
  keepStorage?: boolean;
  /** Override the source-list fetch (tests). Throwing simulates a read failure. */
  fetchRows?: (env: NodeJS.ProcessEnv) => GbrainSourceRow[];
  /** Override whether this CLI can create URL-managed sources (tests). */
  urlManagedSources?: boolean;
}

export function decideSourceRemove(
  sourceId: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: DecideRemoveOpts = {},
): RemoveDecision {
  const keepStorage = opts.keepStorage ?? gbrainSupportsKeepStorage(env);
  const extra = keepStorage ? ["--keep-storage"] : [];

  let rows: GbrainSourceRow[];
  try {
    rows = (opts.fetchRows ?? fetchSources)(env);
  } catch {
    return { allow: false, extraArgs: [], reason: "could not read sources list; refusing remove (fail closed)" };
  }

  const row = rows.find((r) => r.id === sourceId);
  if (!row) return { allow: true, extraArgs: extra, reason: "source absent (no-op)" };

  if (!row.config || typeof row.config !== "object") {
    const mayOwnRemoteClone = opts.urlManagedSources ?? gbrainMaySupportUrlSources(env);
    if (!mayOwnRemoteClone) {
      return {
        allow: true,
        extraArgs: extra,
        reason: "legacy gbrain predates URL-managed sources; metadata-free row is path-managed",
      };
    }
    return {
      allow: false,
      extraArgs: [],
      reason: `source "${sourceId}" has no ownership metadata; refusing remove (fail closed)`,
    };
  }

  const remoteUrl = row.config?.remote_url;
  const userManaged = !!remoteUrl && !isOwnedClone(row, env);

  if (userManaged) {
    if (keepStorage) {
      return { allow: true, extraArgs: ["--keep-storage"], reason: "user-managed; --keep-storage protects files" };
    }
    return {
      allow: false,
      extraArgs: [],
      reason:
        `refusing remove of user-managed source "${sourceId}" (remote_url set, local_path ` +
        `${row.local_path} outside gbrain clones) — this gbrain has no --keep-storage to ` +
        `protect the working tree. Upgrade gbrain or remove the source manually.`,
    };
  }

  return { allow: true, extraArgs: extra, reason: "authoritatively gbrain-managed or path-managed" };
}

export interface SyncDecision {
  allow: boolean;
  reason: string;
}

export interface DecideSyncOpts {
  /** Override whether this CLI can create URL-managed sources (tests). */
  urlManagedSources?: boolean;
}

/**
 * Decide whether `sync --strategy code --source <id>` is safe to run.
 *
 * A source with a remote_url can trigger gbrain's auto-reclone, the ungated
 * rm-rf path behind the data loss (gbrain #1526). Require an explicit
 * --allow-reclone opt-in for URL-managed sources. A missing config field is not
 * evidence that the source is path-managed on gbrain >=0.28: current CLI list
 * rows omit ownership config. Only a positively identified pre-0.28 CLI may
 * proceed, because that release line has no URL-managed source surface.
 */
export function decideCodeSync(
  sourceId: string,
  env: NodeJS.ProcessEnv = process.env,
  allowReclone = false,
  fetchRows: (env: NodeJS.ProcessEnv) => GbrainSourceRow[] = fetchSources,
  opts: DecideSyncOpts = {},
): SyncDecision {
  let rows: GbrainSourceRow[];
  try {
    rows = fetchRows(env);
  } catch {
    return allowReclone
      ? { allow: true, reason: "sources unreadable; reclone explicitly allowed" }
      : { allow: false, reason: "sources unreadable; refusing code sync without --allow-reclone" };
  }
  const row = rows.find((r) => r.id === sourceId);
  if (!row) return { allow: true, reason: "source absent (sync will be a no-op/error)" };
  if (!row.config || typeof row.config !== "object") {
    const mayOwnRemoteClone = opts.urlManagedSources ?? gbrainMaySupportUrlSources(env);
    if (!mayOwnRemoteClone) {
      return {
        allow: true,
        reason: "legacy gbrain predates URL-managed sources; metadata-free row is path-managed",
      };
    }
    return allowReclone
      ? { allow: true, reason: "ownership metadata unavailable; reclone explicitly allowed" }
      : {
          allow: false,
          reason: `source "${sourceId}" has no ownership metadata; re-run with --allow-reclone to proceed`,
        };
  }
  if (row?.config?.remote_url && !allowReclone) {
    return {
      allow: false,
      reason:
        `source "${sourceId}" is URL-managed (remote_url set); sync may auto-reclone and ` +
        `delete the working tree. Re-run /sync-gbrain with --allow-reclone to proceed.`,
    };
  }
  return { allow: true, reason: "no remote_url, or reclone explicitly allowed" };
}
