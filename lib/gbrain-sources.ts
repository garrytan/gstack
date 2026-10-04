/**
 * gbrain-sources — TypeScript helper for idempotent gbrain federated source registration.
 *
 * Mirrors the bash logic in bin/gstack-gbrain-source-wireup:204-310 but in a form
 * importable by other TS callers (currently bin/gstack-gbrain-sync.ts; future
 * callers welcome). gbrain has no `sources update` — drift recovery is
 * `sources remove` followed by `sources add`.
 *
 * Per /plan-eng-review D3 (DRY extraction).
 */

import { execFileSync, spawnSync } from "child_process";
import { createHash } from "crypto";
import { realpathSync } from "fs";
import { dirname } from "path";
import { withErrorContext } from "./gstack-memory-helpers";
import { execGbrainJson, gbrainChildCwd, gbrainInvocation, spawnGbrain } from "./gbrain-exec";
import {
  detectAutopilot,
  decideSourceRemove,
  type AutopilotProbe,
  type DecideRemoveOpts,
} from "./gbrain-guards";

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

/**
 * One row of `gbrain sources list --json`. `config.remote_url` distinguishes
 * URL-managed sources (gbrain owns the clone, may auto-reclone) from
 * path-managed ones (user owns the working tree) — load-bearing for the #1734
 * destructive-op guards.
 */
export interface GbrainSourceRow {
  id?: string;
  local_path?: string;
  page_count?: number;
  config?: { remote_url?: string | null } | null;
}

/**
 * Normalize `gbrain sources list --json` output to an array of source rows.
 *
 * gbrain has shipped two shapes: a wrapped `{ sources: [...] }` object (v0.20+)
 * and, in older/other variants, a bare top-level array. #1576 was a crash when a
 * reader assumed one shape; the parse is centralized here so every reader
 * (probeSource, sourcePageCount, sourceLocalPath, the #1734 remote_url audit)
 * agrees on the shape in ONE place. Returns [] for null/garbage rather than
 * throwing — callers treat "no rows" as absent.
 */
export function parseSourcesList(raw: unknown): GbrainSourceRow[] {
  if (Array.isArray(raw)) return raw as GbrainSourceRow[];
  if (raw && typeof raw === "object" && Array.isArray((raw as { sources?: unknown }).sources)) {
    return (raw as { sources: GbrainSourceRow[] }).sources;
  }
  return [];
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
  /**
   * #1734 test hooks for the drift-remove guards. Production callers leave
   * these unset (real autopilot detection + real remove decision). Tests pin
   * them so a live autopilot on the dev machine can't flip test outcomes.
   */
  autopilotProbe?: AutopilotProbe;
  removeDecision?: DecideRemoveOpts;
}

/**
 * Path equality with realpath normalization (macOS /tmp -> /private/tmp,
 * symlinked worktrees). A registered path that resolves to the same real
 * directory is NOT drift — declaring it drift triggers a destructive
 * remove+add and a full re-index for a no-op (#1985 reporter hit the remove
 * on an unmoved repo).
 */
function samePath(registered: string | undefined, requested: string): boolean {
  if (!registered) return false;
  if (registered === requested) return true;
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return real(registered) === real(requested);
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
    const inv = gbrainInvocation(["sources", "list", "--json"]);
    stdout = execFileSync(inv.cmd, inv.argv, {
      encoding: "utf-8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
      env,
      cwd: gbrainChildCwd(undefined, env),
      shell: inv.shell, // #1731: gbrain is a .cmd shim on Windows (+#2471 quoting)
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

  const sources = parseSourcesList(parsed);
  const match = sources.find((s) => s.id === id);
  if (!match) return { status: "absent" };
  return {
    status: "match",
    registered_path: match.local_path,
  };
}

/**
 * Ensure source <id> is registered at <path>. Idempotent.
 *
 * Behavior:
 *   - status=absent  → `gbrain sources add <id> --path <path> [--federated]`, returns changed=true.
 *   - status=match + same path → no-op, returns changed=false.
 *   - status=match + different path → `sources remove --confirm-destructive` + `sources add`, returns changed=true.
 *     (Skip when reregister_on_drift=false; returns changed=false.)
 *
 * Caller is responsible for catching errors. The function uses withErrorContext for
 * forensic logging to ~/.gstack/.gbrain-errors.jsonl.
 */
export async function ensureSourceRegistered(
  id: string,
  path: string,
  options: EnsureOptions = {}
): Promise<EnsureResult> {
  const federated = options.federated ?? false;
  const reregister_on_drift = options.reregister_on_drift ?? true;
  const env = options.env;

  return withErrorContext(`ensureSourceRegistered:${id}`, () => {
    const probed = probeSource(id, env);

    // Disambiguate match-but-different-path (realpath-normalized: a symlink
    // alias of the same directory is a match, not drift).
    let state: SourceState = probed;
    if (probed.status === "match" && !samePath(probed.registered_path, path)) {
      state = { status: "drift", registered_path: probed.registered_path };
    }

    if (state.status === "match") {
      return { changed: false, state };
    }

    if (state.status === "drift" && !reregister_on_drift) {
      return { changed: false, state };
    }

    // For drift, remove first.
    //
    // #1985: gbrain >= 0.42 gates `sources remove` behind --confirm-destructive
    // (`--yes` alone no longer suppresses the data-loss prompt). Without it the
    // remove fails with "To proceed, pass --confirm-destructive", which surfaces
    // as "source registration failed" and aborts the whole /sync-gbrain code
    // stage for any source that has drifted to a new path. This matches the
    // flag the orchestrator's own safeSourcesRemove() already passes.
    if (state.status === "drift") {
      // Loud drift observability: if this line shows up on every sync for some
      // environment, drift is perpetual there and the reindex-in-place design
      // from #1985 should be promoted (drop+rebuild re-embeds the full index).
      console.error(
        `[gbrain-sources] drift: ${id} registered at ${state.registered_path} -> re-registering at ${path}`,
      );

      // #1734: this remove deletes the source's pages/chunks/embeddings, so it
      // runs only behind the same data-loss guards as the orchestrator's
      // safeSourcesRemove(). A refusal is FATAL here (not best-effort): without
      // the remove the add cannot proceed, and returning changed=false would
      // silently hide the drifted registration.
      const ap = detectAutopilot(env ?? process.env, options.autopilotProbe ?? {});
      if (ap.active) {
        throw new Error(
          `refusing drift re-register of ${id}: autopilot active (${ap.signal}). ` +
            `Stop autopilot, then re-run /sync-gbrain.`,
        );
      }
      const decision = decideSourceRemove(id, env ?? process.env, options.removeDecision ?? {});
      if (!decision.allow) {
        throw new Error(`refusing drift re-register of ${id}: ${decision.reason}`);
      }

      const rmInv = gbrainInvocation(["sources", "remove", id, "--yes", "--confirm-destructive", ...decision.extraArgs]);
      const rm = spawnSync(rmInv.cmd, rmInv.argv, {
        encoding: "utf-8",
        timeout: 30_000,
        env,
        cwd: gbrainChildCwd(undefined, env),
        shell: rmInv.shell, // #1731: gbrain is a .cmd shim on Windows (+#2471 quoting)
      });
      if (rm.status !== 0) {
        throw new Error(`gbrain sources remove ${id} failed: ${rm.stderr || rm.stdout || `exit ${rm.status}`}`);
      }
    }

    // Add. `path` is a user repo path — the #2471 space-in-path victim; the
    // invocation seam quotes it for cmd.exe's re-parse.
    const addArgs = ["sources", "add", id, "--path", path];
    if (federated) addArgs.push("--federated");
    const addInv = gbrainInvocation(addArgs);
    const add = spawnSync(addInv.cmd, addInv.argv, {
      encoding: "utf-8",
      timeout: 30_000,
      env,
      cwd: gbrainChildCwd(undefined, env),
      shell: addInv.shell, // #1731: gbrain is a .cmd shim on Windows (+#2471 quoting)
    });
    if (add.status !== 0) {
      throw new Error(`gbrain sources add ${id} failed: ${add.stderr || add.stdout || `exit ${add.status}`}`);
    }

    return {
      changed: true,
      state: { status: "match", registered_path: path },
    };
  }, "gbrain-sources");
}

/**
 * Get page_count for a registered source. Returns null if source is absent or if
 * page_count is missing/invalid in the JSON. Used by the verdict block + preamble
 * variant selection.
 */
export function sourcePageCount(id: string, env?: NodeJS.ProcessEnv): number | null {
  let stdout: string;
  try {
    const inv = gbrainInvocation(["sources", "list", "--json"]);
    stdout = execFileSync(inv.cmd, inv.argv, {
      encoding: "utf-8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
      env,
      cwd: gbrainChildCwd(undefined, env),
      shell: inv.shell, // #1731: gbrain is a .cmd shim on Windows (+#2471 quoting)
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
 * Read `gbrain doctor --json --scope=brain` and decide whether <sourceId>'s
 * call graph is built, by inspecting the `cycle_freshness` check.
 *
 * B9 (#2918): `doctor --fast` skips every DB check, cycle_freshness
 * included, so the old --fast read was always "unknown". `--scope=brain`
 * keeps the DB checks and skips only the skill-file walk. doctor exits 1
 * when any check fails, so the JSON is read whatever the exit code.
 *
 * Decision table (cycle_freshness.status / the issue naming <sourceId>):
 *   - ok                                         → "completed"
 *   - names <sourceId>: "never completed"         → "never"
 *   - names <sourceId>: "last cycled Nh ago"      → "completed" (it cycled; just stale)
 *   - fail|warn that omits <sourceId>             → "unknown" (never mask other sources)
 *   - check absent                                → "unknown", why: not exposed
 *   - no report                                   → "unknown", why: doctor unavailable
 *
 * `sourceId` is matched as a LITERAL substring (not a regex).
 */
export function readCycleStatus(sourceId: string, env?: NodeJS.ProcessEnv): { status: CycleStatus; why?: string } {
  const r = spawnGbrain(["doctor", "--json", "--scope=brain"], { baseEnv: env, timeout: 120_000 });
  let report: DoctorReport | null = null;
  try {
    report = JSON.parse(r.stdout || "null") as DoctorReport;
  } catch {}
  if (!report || !Array.isArray(report.checks)) return { status: "unknown", why: "gbrain doctor returned no report" };

  const check = report.checks.find((c) => c.name === "cycle_freshness");
  if (!check) return { status: "unknown", why: "installed gbrain does not expose cycle_freshness" };
  if (check.status === "ok") return { status: "completed" };
  if (check.status !== "fail" && check.status !== "warn") return { status: "unknown" };
  const issue = (check.message || "").split("; ").find((m) => m.includes(`'${sourceId}'`)) ?? "";
  if (issue.includes("never completed")) return { status: "never" };
  if (issue.includes("last cycled")) return { status: "completed" };
  return { status: "unknown" };
}

export function cycleCompleted(sourceId: string, env?: NodeJS.ProcessEnv): CycleStatus {
  return readCycleStatus(sourceId, env).status;
}

/**
 * Build a gbrain-valid source id (1-32 lowercase alnum + interior hyphens). Sanitizes
 * `raw`, prefixes with `prefix`, and falls back to a hashed-tail form when total length
 * would exceed 32 chars.
 *
 * Truncation cuts on hyphen boundaries (whole-word units) from the right, never
 * mid-word. Inputs like "drummerms-av-sow-wiz-skill-270c0001" produce
 * "${prefix}-270c0001-<hash>", not "${prefix}-kill-270c0001-<hash>".
 */
export function constrainSourceId(prefix: string, raw: string): string {
  const MAX = 32;
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  // Empty slug after sanitize (e.g. raw was all non-alnum like "___") would
  // produce "${prefix}-" which fails gbrain's validator on the trailing
  // hyphen. Fall back to a deterministic hash of the original input so the
  // result is stable across runs of the same repo.
  if (!slug) {
    const hash = createHash("sha1").update(raw || "_empty").digest("hex").slice(0, 6);
    return `${prefix}-${hash}`;
  }
  const full = `${prefix}-${slug}`;
  if (full.length <= MAX) return full;
  const hash = createHash("sha1").update(slug).digest("hex").slice(0, 6);
  // Total budget: prefix + "-" + tail + "-" + hash
  const tailBudget = MAX - prefix.length - 2 - hash.length;
  if (tailBudget < 1) return `${prefix}-${hash}`;
  // Cut on hyphen boundaries instead of mid-word. Walk tokens from the right,
  // accumulating until adding the next token would exceed tailBudget. This
  // preserves readable suffixes (pathhash, repo name) and avoids embarrassing
  // mid-word artifacts like "skill" → "kill".
  const tokens = slug.split("-").filter(Boolean);
  const kept: string[] = [];
  let len = 0;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const add = kept.length === 0 ? tokens[i].length : tokens[i].length + 1;
    if (len + add > tailBudget) break;
    kept.unshift(tokens[i]);
    len += add;
  }
  const tail = kept.join("-");
  return tail ? `${prefix}-${tail}-${hash}` : `${prefix}-${hash}`;
}

// ── Gone worktree sources (A6, #2688) ──────────────────────────────────────

/** A gstack code source whose registered path is missing on this machine. */
export interface UnavailableSource {
  path: string;
  /** Consecutive syncs that found the path missing. */
  misses: number;
  since: string;
}

/** What gstack knew about a code source the last time it synced it here. */
export interface CodeSourceRecord {
  path: string;
  /** Canonical origin remote ("" for a repo without one). */
  remote: string;
  /** Absolute git common dir of the repository the worktree belongs to. */
  git_common_dir: string | null;
}

/**
 * Track gstack code sources whose path is missing. Absence on this machine
 * is not proof a source is dead (machines sharing a federated brain register
 * their own paths), so this only counts consecutive misses for the explicit
 * prune command and reports each newly unavailable source once.
 */
export function trackUnavailableSources(
  rows: GbrainSourceRow[],
  prev: Record<string, UnavailableSource>,
  exists: (p: string) => boolean,
  now: string,
): { next: Record<string, UnavailableSource>; newlyUnavailable: string[] } {
  const next: Record<string, UnavailableSource> = {};
  const newlyUnavailable: string[] = [];
  for (const r of rows) {
    if (!r.id?.startsWith("gstack-code-") || !r.local_path || exists(r.local_path)) continue;
    const before = prev[r.id];
    next[r.id] = { path: r.local_path, misses: (before?.misses ?? 0) + 1, since: before?.since ?? now };
    if (!before) newlyUnavailable.push(r.id);
  }
  return { next, newlyUnavailable };
}

export interface PruneContext {
  unavailable: Record<string, UnavailableSource>;
  /** Records from earlier syncs on this machine, by source id. */
  records: Record<string, CodeSourceRecord>;
  /** The current checkout's repository, a candidate owner for its deleted worktrees. */
  current: CodeSourceRecord | null;
  /** deriveCodeSourceId() for an explicit path and remote, on this host. */
  deriveId: (path: string, remote: string) => string;
  exists: (p: string) => boolean;
  readableDir: (p: string) => boolean;
  /** Whether `git worktree list` in the common dir still lists the path; null when git failed. */
  worktreeListed: (gitCommonDir: string, path: string) => boolean | null;
}

/**
 * Decide whether `gstack-gbrain-sync --prune-gone-worktrees` may remove a
 * source. Its indexed pages may be the only copy of uncommitted work, so
 * every condition must hold: the path is gone for two consecutive syncs, its
 * parent is readable (not an unmounted volume), recomputing
 * deriveCodeSourceId() for the path on this host yields the id (this machine
 * created it), and the repository still exists but no longer lists the
 * worktree.
 */
export function decidePrune(id: string, path: string, ctx: PruneContext): { remove: boolean; reason: string } {
  if (ctx.exists(path)) return { remove: false, reason: "path exists" };
  const parent = dirname(path);
  if (!ctx.readableDir(parent)) return { remove: false, reason: `parent directory ${parent} is not readable (unmounted volume?)` };
  const misses = ctx.unavailable[id]?.misses ?? 0;
  if (misses < 2) return { remove: false, reason: `path missing on ${misses} sync(s) so far; needs 2 consecutive syncs` };
  const record = [ctx.records[id], ctx.current].find((r) => r && ctx.deriveId(path, r.remote) === id);
  if (!record) {
    return { remove: false, reason: "not proven to be this machine's source (its id does not recompute from this host and path)" };
  }
  if (!record.git_common_dir || !ctx.exists(record.git_common_dir)) {
    return { remove: false, reason: `its repository (${record.git_common_dir ?? "unknown git dir"}) is not available to confirm the worktree was removed` };
  }
  const listed = ctx.worktreeListed(record.git_common_dir, path);
  if (listed === null) return { remove: false, reason: "git worktree list failed" };
  if (listed) return { remove: false, reason: "git still lists this worktree (run `git worktree prune` if it was deleted)" };
  return { remove: true, reason: `missing on ${misses} syncs; created on this host; ${record.git_common_dir} no longer lists it` };
}
