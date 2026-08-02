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
 * Design notes grounded in the real GBrain surface:
 *   - `gbrain sources list --json` intentionally omits remote-management
 *     provenance. Destructive-capable decisions use the read-only
 *     `GBRAIN_SOURCE=default gbrain call sources_list` operation instead and
 *     require an explicit top-level `remote_url` value (string or null).
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
import {
  execGbrainJson,
  execGbrainText,
  NEEDS_SHELL_ON_WINDOWS,
} from "./gbrain-exec";
import {
  parseSourcesListStrict,
  resolveLocalPathForContainment,
  type GbrainSourceRow,
} from "./gbrain-sources";

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
  let rd: string;
  try {
    rd = realpathSync(dir);
  } catch {
    rd = resolve(dir);
  }
  let rp: string;
  try {
    rp = resolveLocalPathForContainment(p, rd);
  } catch {
    return false;
  }
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
  const running = probe.processRunning
    ? probe.processRunning()
    : defaultProcessRunning(env);
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

function defaultProcessRunning(env: NodeJS.ProcessEnv = process.env): boolean {
  // No reliable pgrep on Windows; rely on the lock-file signal there.
  if (process.platform === "win32") return false;
  const r = spawnSync("pgrep", ["-f", "gbrain autopilot"], {
    encoding: "utf-8",
    timeout: 3_000,
    env,
  });
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
 * Require management provenance on every row before it can authorize a
 * destructive-capable operation. A missing field is not equivalent to null:
 * the ordinary CLI list omits it even for URL-managed sources.
 */
function requireManagementRows(rows: GbrainSourceRow[]): GbrainSourceRow[] {
  for (const row of rows) {
    if (!Object.hasOwn(row, "remote_url")) {
      throw new Error(
        "source management provenance is missing (remote_url omitted)",
      );
    }
  }
  return rows;
}

/**
 * Fetch the authoritative read-only source registry, including remote_url.
 * `GBRAIN_SOURCE=default` bypasses repo-controlled `.gbrain-source` resolution
 * on versions that resolve a source for `call`; older v0.28.x versions ignore
 * the unused env while the operation itself remains brain-wide. The call omits
 * a JSON argv item so the Windows `.cmd` shell transport cannot strip JSON
 * quotes. That returns active rows only; a missing row therefore fails closed
 * rather than being treated as a safe absent no-op. GBrain v0.28.2 introduced
 * this public operation; gstack's higher supported-version floor also covers
 * source-scoped dream correctness. Older/unknown surfaces fail closed with an
 * upgrade hint at the decision boundary.
 */
export function fetchSources(
  env: NodeJS.ProcessEnv = process.env,
): GbrainSourceRow[] {
  const registryEnv = { ...env, GBRAIN_SOURCE: "default" };
  const raw = execGbrainJson(["call", "sources_list"], {
    baseEnv: registryEnv,
  });
  if (raw === null) {
    throw new Error(
      "gbrain sources_list returned no JSON; upgrade GBrain to gstack's minimum supported v0.41.38.0 or newer",
    );
  }
  return requireManagementRows(parseSourcesListStrict(raw));
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
 * Allowed: gbrain-managed (inside clones), or path-managed without a remote_url
 * (gbrain's remove won't touch an outside-clones path that it didn't clone).
 * An absent active row is refused because the shell-safe registry call excludes
 * archived rows. --keep-storage is appended whenever supported, as extra armor.
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
    rows = requireManagementRows((opts.fetchRows ?? fetchSources)(env));
  } catch {
    return { allow: false, extraArgs: [], reason: "could not read sources list; refusing remove (fail closed)" };
  }

  const row = rows.find((r) => r.id === sourceId);
  if (!row) {
    return {
      allow: false,
      extraArgs: [],
      reason:
        "source absent from active registry; archived provenance is unproven, refusing remove",
    };
  }

  const remoteUrl = row.remote_url;
  const storageUnproven =
    remoteUrl !== null &&
    (!row.local_path ||
      !clonesDirs(env).some((d) => isInside(row.local_path!, d)));

  if (storageUnproven) {
    if (keepStorage) {
      return { allow: true, extraArgs: ["--keep-storage"], reason: "user-managed; --keep-storage protects files" };
    }
    return {
      allow: false,
      extraArgs: [],
      reason:
        `refusing remove of user-managed or unlocatable source "${sourceId}" ` +
        `(remote_url set, local_path ${row.local_path || "missing"} is not proven inside gbrain clones) — ` +
        `this gbrain has no --keep-storage to ` +
        `protect the working tree. Upgrade gbrain or remove the source manually.`,
    };
  }

  return { allow: true, extraArgs: extra, reason: "gbrain-managed or path-managed without remote_url" };
}

/**
 * Authorize the narrow remove used to repair a path-managed source whose
 * registered directory genuinely drifted. The raw row must still match the
 * snapshot already validated by the caller, and URL-managed sources are
 * deliberately excluded: their remove path may delete a working tree.
 *
 * Unlike the general removal decision, this boundary never resolves the
 * database-provided pathname, so an untrusted UNC/device spelling cannot
 * trigger filesystem or network access during policy evaluation.
 */
export function decidePathManagedDriftRemove(
  sourceId: string,
  expectedLocalPath: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: DecideRemoveOpts = {},
): RemoveDecision {
  // Capability detection may spawn the CLI. Do it before the final source-row
  // snapshot so the destructive call follows that snapshot as closely as the
  // CLI permits (there is no compare-and-delete or source lease).
  const keepStorage = opts.keepStorage ?? gbrainSupportsKeepStorage(env);
  let rows: GbrainSourceRow[];
  try {
    rows = requireManagementRows((opts.fetchRows ?? fetchSources)(env));
  } catch {
    return {
      allow: false,
      extraArgs: [],
      reason: "could not reread sources list; refusing path-drift remove",
    };
  }

  const row = rows.find((candidate) => candidate.id === sourceId);
  if (!row) {
    return {
      allow: false,
      extraArgs: [],
      reason: "source disappeared before path-drift repair",
    };
  }
  if (row.local_path !== expectedLocalPath) {
    return {
      allow: false,
      extraArgs: [],
      reason:
        "registered path changed after validation; refusing path-drift remove",
    };
  }
  if (row.remote_url !== null) {
    return {
      allow: false,
      extraArgs: [],
      reason: "source is URL-managed; automatic path-drift removal is unsafe",
    };
  }

  return {
    allow: true,
    extraArgs: keepStorage ? ["--keep-storage"] : [],
    reason: "validated path-managed source",
  };
}

export interface SyncDecision {
  allow: boolean;
  reason: string;
  /** True only for a proven URL-managed row with explicit --allow-reclone. */
  mayReclone: boolean;
  /** Exact strict-row snapshot used for both path binding and reclone policy. */
  registeredPath?: string;
}

/**
 * Decide whether `sync --strategy code --source <id>` is safe to run.
 *
 * A source with a remote_url can trigger gbrain's auto-reclone, the ungated
 * rm-rf path behind the data loss (gbrain #1526). Require an explicit
 * --allow-reclone opt-in for URL-managed sources. If the row cannot be read,
 * applicability is unprovable and the destructive-capable operation fails
 * closed; retrying after the source registry recovers is safe.
 */
export function decideCodeSync(
  sourceId: string,
  env: NodeJS.ProcessEnv = process.env,
  allowReclone = false,
  fetchRows: (env: NodeJS.ProcessEnv) => GbrainSourceRow[] = fetchSources,
): SyncDecision {
  let rows: GbrainSourceRow[];
  try {
    rows = requireManagementRows(fetchRows(env));
  } catch {
    return {
      allow: false,
      reason:
        "sources unreadable; refusing sync because URL-managed applicability is unprovable",
      mayReclone: false,
    };
  }
  const row = rows.find((r) => r.id === sourceId);
  if (
    !row ||
    typeof row.local_path !== "string" ||
    row.local_path.length === 0
  ) {
    return {
      allow: false,
      reason: `source "${sourceId}" is absent or has no readable local_path; refusing sync`,
      mayReclone: false,
    };
  }
  if (row.remote_url !== null && !allowReclone) {
    return {
      allow: false,
      reason:
        `source "${sourceId}" is URL-managed (remote_url set); sync may auto-reclone and ` +
        `delete the working tree. Re-run /sync-gbrain with --allow-reclone to proceed.`,
      mayReclone: false,
      registeredPath: row.local_path,
    };
  }
  const mayReclone = row.remote_url !== null && allowReclone;
  return {
    allow: true,
    reason: "no remote_url, or reclone explicitly allowed",
    mayReclone,
    registeredPath: row.local_path,
  };
}
