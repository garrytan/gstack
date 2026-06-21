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
 *   - The autopilot lock filename isn't documented and (gbrain #1226) ignores
 *     GBRAIN_HOME, so the live `gbrain autopilot` process is the PRIMARY signal;
 *     known lock paths under both the configured home and ~/.gbrain are secondary.
 *   - We refuse only on an AFFIRMATIVE autopilot signal — inability to introspect
 *     never blocks a normal sync (that would brick the tool).
 *   - Path containment uses realpath so a symlink inside ~/.gbrain/clones can't
 *     smuggle a delete out to a user repo.
 *
 * Pure decision functions; the orchestrator logs the reasons (observability).
 */

import { spawnSync } from "child_process";
import { existsSync, realpathSync, readFileSync } from "fs";
import { homedir } from "os";
import { join, resolve, sep } from "path";
import { execGbrainJson, execGbrainText, NEEDS_SHELL_ON_WINDOWS } from "./gbrain-exec";
import { parseSourcesList, type GbrainSourceRow } from "./gbrain-sources";

export function gbrainHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.GBRAIN_HOME || join(homedir(), ".gbrain");
}

/**
 * Directories gbrain owns and may delete safely. A source whose local_path
 * resolves inside one of these is gbrain-managed; outside = user-managed and
 * must be protected. Both the configured home and the default ~/.gbrain are
 * checked because gbrain #1226 shows home-resolution is inconsistent.
 */
function clonesDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...new Set([join(gbrainHome(env), "clones"), join(homedir(), ".gbrain", "clones")])];
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
  // Secondary signal: known lock files. gbrain #1226 — the lock ignores
  // GBRAIN_HOME, so check both the configured home and the default ~/.gbrain.
  const lockPaths = probe.lockPaths ?? [
    join(gbrainHome(env), "autopilot.lock"),
    join(homedir(), ".gbrain", "autopilot.lock"),
    join(gbrainHome(env), "autopilot.pid"),
    join(homedir(), ".gbrain", "autopilot.pid"),
  ];
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
  const raw = execGbrainJson(["sources", "list", "--json"], { baseEnv: env });
  if (raw === null) throw new Error("gbrain sources list returned no JSON");
  return parseSourcesList(raw);
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
 *   - the row is user-managed (remote_url set AND local_path outside gbrain's
 *     clones) and gbrain has no --keep-storage to protect the files.
 *
 * Allowed: absent row (no-op), gbrain-managed (inside clones), or path-managed
 * without a remote_url (gbrain's remove won't touch an outside-clones path that
 * it didn't clone). --keep-storage is appended whenever supported, as extra armor.
 */
export interface DecideRemoveOpts {
  /** Override capability detection (tests / cached caps). */
  keepStorage?: boolean;
  /** Override the source-list fetch (tests). Throwing simulates a read failure. */
  fetchRows?: (env: NodeJS.ProcessEnv) => GbrainSourceRow[];
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

  const remoteUrl = row.config?.remote_url;
  const userManaged =
    !!remoteUrl && !!row.local_path && !clonesDirs(env).some((d) => isInside(row.local_path!, d));

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

  return { allow: true, extraArgs: extra, reason: "gbrain-managed or path-managed without remote_url" };
}

export interface SyncDecision {
  allow: boolean;
  reason: string;
}

/**
 * Decide whether `sync --strategy code --source <id>` is safe to run.
 *
 * A source with a remote_url can trigger gbrain's auto-reclone, the ungated
 * rm-rf path behind the data loss (gbrain #1526). Require an explicit
 * --allow-reclone opt-in for URL-managed sources. Read failure here is NOT
 * itself destructive, so it fails open (proceed) — the autopilot guard, checked
 * first, is the primary protection against the race that caused the loss.
 */
export function decideCodeSync(
  sourceId: string,
  env: NodeJS.ProcessEnv = process.env,
  allowReclone = false,
  fetchRows: (env: NodeJS.ProcessEnv) => GbrainSourceRow[] = fetchSources,
): SyncDecision {
  let rows: GbrainSourceRow[];
  try {
    rows = fetchRows(env);
  } catch {
    return { allow: true, reason: "sources unreadable; proceeding (sync read is non-destructive)" };
  }
  const row = rows.find((r) => r.id === sourceId);
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
