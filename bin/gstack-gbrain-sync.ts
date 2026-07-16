#!/usr/bin/env bun
/**
 * gstack-gbrain-sync — V1 unified sync verb.
 *
 * Orchestrates three storage tiers per plan §"Storage tiering":
 *
 *   1. Code (current repo)         → `gbrain sources add` (idempotent via
 *                                    lib/gbrain-sources.ts) + `gbrain sync
 *                                    --strategy code` (incremental) or
 *                                    `gbrain reindex-code --yes` (--full).
 *                                    NEVER `gbrain import` (markdown only).
 *   2. Transcripts + curated memory → gstack-memory-ingest (typed put_page)
 *   3. Curated artifacts to git    → gstack-brain-sync (existing pipeline)
 *
 * Modes:
 *   --incremental (default) — mtime fast-path; runs all 3 stages with cache hits
 *   --full                  — first-run; full walk + reindex; honest budget per ED2
 *   --dry-run               — preview what would sync; no writes anywhere (incl. state file)
 *
 * Concurrency safety per /plan-eng-review D1:
 *   - Lock file at ~/.gstack/.sync-gbrain.lock (PID + start ts).
 *   - Stale-lock takeover after 5 min (process death).
 *   - State file written via tmp+rename for atomicity.
 *   - Lock released in finally; SIGINT/SIGTERM trapped for cleanup.
 *
 * --watch (V1.5 P0 TODO): file-watcher daemon. NOTE: gbrain v0.25.1 already
 * ships `gbrain sync --watch [--interval N]` and `gbrain sync --install-cron`;
 * when revisited, /sync-gbrain --watch wires through to the gbrain CLI rather
 * than building a gstack-side daemon.
 */

import { existsSync, statSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, renameSync } from "fs";
import { join, dirname } from "path";
import { execSync, spawnSync } from "child_process";
import { homedir, hostname } from "os";
import { createHash } from "crypto";

import "../lib/conductor-env-shim";
import { detectEngineTier, withErrorContext, canonicalizeRemote } from "../lib/gstack-memory-helpers";
import { ensureSourceRegistered, sourcePageCount, parseSourcesList, cycleCompleted, type CycleStatus } from "../lib/gbrain-sources";
import { detectAutopilot, decideSourceRemove, decideCodeSync } from "../lib/gbrain-guards";
import { localEngineStatus, type LocalEngineStatus } from "../lib/gbrain-local-status";
import { buildGbrainEnv, spawnGbrain, execGbrainJson, NEEDS_SHELL_ON_WINDOWS } from "../lib/gbrain-exec";
import { checkOwnedStagingDir } from "../lib/staging-guard";

// ── Types ──────────────────────────────────────────────────────────────────

type Mode = "incremental" | "full" | "dry-run";

export interface CliArgs {
  mode: Mode;
  quiet: boolean;
  noCode: boolean;
  noMemory: boolean;
  noBrainSync: boolean;
  codeOnly: boolean;
  /** Force the source-scoped dream cycle (builds this source's call graph). Always runs. */
  dream: boolean;
  /** Opt out of the dream cycle that `--full` would otherwise auto-run. */
  noDream: boolean;
  /** #1734: opt-in to sync a URL-managed source whose code walk may auto-reclone. */
  allowReclone: boolean;
}

interface CodeStageDetail {
  source_id?: string;
  source_path?: string;
  page_count?: number | null;
  last_imported?: string;
  status?: "ok" | "skipped" | "failed" | "refused-autopilot" | "refused-reclone";
}

interface StageResult {
  name: string;
  ran: boolean;
  ok: boolean;
  duration_ms: number;
  summary: string;
  /**
   * Stage ran and did not error, but the outcome is a degraded no-op the user
   * should know about (e.g. dream completed but the schema pack can't extract
   * code symbols, so the call graph stays empty). Rendered as WARN, counts as
   * ok for the exit code — it's not a failure, just not the happy path.
   */
  warn?: boolean;
  /** Stage-specific structured detail. Code stage carries source_id + page_count. */
  detail?: CodeStageDetail;
}

// ── Constants ──────────────────────────────────────────────────────────────

const HOME = homedir();
const GSTACK_HOME = process.env.GSTACK_HOME || join(HOME, ".gstack");
const STATE_PATH = join(GSTACK_HOME, ".gbrain-sync-state.json");
const LOCK_PATH = join(GSTACK_HOME, ".sync-gbrain.lock");
const STALE_LOCK_MS = 5 * 60 * 1000;

// Dream (call-graph build) is brain-global and runs LOCK-FREE after the sync
// lock releases, so it can't use the sync lock to dedupe across worktrees. A
// dedicated short-TTL marker prevents two worktrees from launching duplicate
// ~35-min global jobs. TTL matches the dream timeout default so a crashed run
// can't wedge the marker longer than one cycle.
const DEFAULT_DREAM_TIMEOUT_MS = 45 * 60 * 1000; // 45min — dream is the slow stage
const DREAM_MARKER_STALE_MS = DEFAULT_DREAM_TIMEOUT_MS;

/**
 * Marker path computed fresh per call (not a module const) so tests can mutate
 * GSTACK_HOME at runtime — same pattern as cacheFilePath() in
 * lib/gbrain-local-status.ts. Avoids the ESM static-import hoist trap where a
 * module-load-time const captures the real ~/.gstack before a test can redirect.
 */
export function dreamMarkerPath(): string {
  return join(process.env.GSTACK_HOME || join(homedir(), ".gstack"), ".dream-in-progress");
}

// Default 35-minute timeout for code-walk + memory-ingest stages. Override via
// GSTACK_SYNC_CODE_TIMEOUT_MS / GSTACK_SYNC_MEMORY_TIMEOUT_MS. Bounds-checked
// in resolveStageTimeoutMs below so wildly-low values don't make resume
// useless and wildly-high values don't mask config typos. See #1611.
const DEFAULT_STAGE_TIMEOUT_MS = 35 * 60 * 1000; // 2_100_000ms = 35min
const MIN_STAGE_TIMEOUT_MS = 60_000;             // 1 minute floor
const MAX_STAGE_TIMEOUT_MS = 86_400_000;         // 24 hour ceiling

/**
 * Parse a stage-timeout env value with bounds validation. Returns the bounded
 * value or the default with a stderr warning if the env was malformed or
 * out-of-range. Exported for the regression test.
 */
export function resolveStageTimeoutMs(
  envValue: string | undefined,
  envName: string,
  defaultMs: number = DEFAULT_STAGE_TIMEOUT_MS,
): number {
  if (envValue === undefined || envValue === "") return defaultMs;
  const n = Number.parseInt(envValue, 10);
  if (!Number.isFinite(n) || Number.isNaN(n) || n <= 0) {
    console.warn(
      `[sync] ${envName}="${envValue}" is not a positive integer; falling back to ${defaultMs}ms`,
    );
    return defaultMs;
  }
  if (n < MIN_STAGE_TIMEOUT_MS) {
    console.warn(
      `[sync] ${envName}=${n} is below the ${MIN_STAGE_TIMEOUT_MS}ms (1min) floor; falling back to ${defaultMs}ms`,
    );
    return defaultMs;
  }
  if (n > MAX_STAGE_TIMEOUT_MS) {
    console.warn(
      `[sync] ${envName}=${n} is above the ${MAX_STAGE_TIMEOUT_MS}ms (24h) ceiling; falling back to ${defaultMs}ms`,
    );
    return defaultMs;
  }
  return n;
}

/**
 * gbrain writes ~/.gbrain/import-checkpoint.json on every import run. If a
 * previous /sync-gbrain hit the timeout (SIGTERM = exit 143), the checkpoint
 * + its staging dir survive on disk. Detect both and let gbrain resume from
 * processedIndex+1 on the next run. If the staging dir is missing/empty/
 * unreadable, fall through to a fresh restage with a one-line warning so the
 * user sees we noticed. See #1611 + plan D1/C1.
 */
interface GbrainCheckpoint {
  dir?: string;
  totalFiles?: number;
  processedIndex?: number;
  completedFiles?: number;
  timestamp?: string;
}

export function readGbrainCheckpoint(): GbrainCheckpoint | null {
  // Read HOME from env so tests can redirect via process.env.HOME = ...
  // (Node/Bun's os.homedir() caches at process start and ignores later
  // mutations.)
  const home = process.env.HOME || homedir();
  const cpPath = join(home, ".gbrain", "import-checkpoint.json");
  if (!existsSync(cpPath)) return null;
  try {
    const raw = readFileSync(cpPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as GbrainCheckpoint;
  } catch {
    // Corrupt JSON — treat as no checkpoint and fall through to fresh restage.
    return null;
  }
}

export type ResumeVerdict =
  | { kind: "no-checkpoint" }
  | { kind: "resume"; stagingDir: string; processedIndex: number; totalFiles: number }
  | { kind: "stale-staging-missing"; stagingDir: string; reason?: string };

/**
 * Decide whether the next memory-ingest run should resume from gbrain's
 * checkpoint or restage from scratch.
 *   - no checkpoint              → run a fresh ingest pass
 *   - checkpoint + staging ok    → resume (gbrain picks up at processedIndex+1)
 *   - checkpoint + staging gone  → warn, fall through to fresh restage
 */
export function decideResume(gstackHome: string = GSTACK_HOME): ResumeVerdict {
  const cp = readGbrainCheckpoint();
  if (!cp || !cp.dir) return { kind: "no-checkpoint" };
  const stagingDir = cp.dir;
  // #1802: only resume into a path we can PROVE is a gstack-minted staging dir.
  // A poisoned checkpoint (dir = repo root, written when an autopilot import was
  // SIGTERM'd while CWD was the repo) would otherwise be adopted as the staging
  // dir and later recursively deleted by cleanupStagingDir(). Fail-closed: any
  // unprovable path restages from scratch (cost: one re-stage; never data loss).
  // Pure decision: return the verdict (with reason) and let the caller log,
  // so we don't double-log the same event from here and the call site.
  const verdict = checkOwnedStagingDir(stagingDir, gstackHome);
  if (!verdict.ok) {
    return { kind: "stale-staging-missing", stagingDir, reason: verdict.reason };
  }
  return {
    kind: "resume",
    stagingDir,
    processedIndex: cp.processedIndex ?? 0,
    totalFiles: cp.totalFiles ?? 0,
  };
}

// ── CLI ────────────────────────────────────────────────────────────────────

function printUsage(): void {
  console.error(`Usage: gstack-gbrain-sync [--incremental|--full|--dry-run] [options]

Modes:
  --incremental        Default. mtime fast-path; ~50ms steady-state.
  --full               First-run; full walk + reindex. Honest ~25-35 min for big Macs (ED2).
  --dry-run            Preview what would sync; no writes anywhere.

Options:
  --quiet              Suppress per-stage output.
  --no-code            Skip the cwd code-import stage.
  --no-memory          Skip the gstack-memory-ingest stage (transcripts + artifacts).
  --no-brain-sync      Skip the gstack-brain-sync git pipeline stage.
  --code-only          Only run the code-import stage (alias for --no-memory --no-brain-sync).
  --dream              Force the source-scoped dream cycle that builds this
                       source's call graph (gbrain code-callers/code-callees).
                       Runs lock-free AFTER the sync stages. ~minutes. Default
                       timeout 45min, override GSTACK_SYNC_DREAM_TIMEOUT_MS.
  --no-dream           Opt out of the dream cycle that --full would auto-run.
  --allow-reclone      Permit the code walk for URL-managed sources (remote_url set)
                       even though gbrain may auto-reclone the working tree (#1734).
  --help               This text.

Stages run in order: code → memory ingest → curated git push, then (lock-free)
the optional dream call-graph build. --full auto-runs dream ONLY when the call
graph was never built; --dream always forces it. Each stage failure is
non-fatal; subsequent stages still run.
`);
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let mode: Mode = "incremental";
  let quiet = false;
  let noCode = false;
  let noMemory = false;
  let noBrainSync = false;
  let codeOnly = false;
  let dream = false;
  let noDream = false;
  let allowReclone = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case "--incremental": mode = "incremental"; break;
      case "--full": mode = "full"; break;
      case "--dry-run": mode = "dry-run"; break;
      case "--quiet": quiet = true; break;
      case "--no-code": noCode = true; break;
      case "--no-memory": noMemory = true; break;
      case "--no-brain-sync": noBrainSync = true; break;
      case "--allow-reclone": allowReclone = true; break;
      case "--code-only":
        codeOnly = true;
        noMemory = true;
        noBrainSync = true;
        break;
      // --dream forces the cycle; --full only chains it at the call site (so
      // --no-dream can override) — do NOT set dream from --full here.
      case "--dream": dream = true; break;
      case "--no-dream": noDream = true; break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
      default:
        console.error(`Unknown argument: ${a}`);
        printUsage();
        process.exit(1);
    }
  }

  return { mode, quiet, noCode, noMemory, noBrainSync, codeOnly, dream, noDream, allowReclone };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function repoRoot(): string | null {
  try {
    const out = execSync("git rev-parse --show-toplevel", { encoding: "utf-8", timeout: 2000 });
    return out.trim();
  } catch {
    return null;
  }
}

function originUrl(): string | null {
  try {
    const out = execSync("git remote get-url origin", { encoding: "utf-8", timeout: 2000 });
    return out.trim();
  } catch {
    return null;
  }
}

/**
 * Derive a host- and worktree-aware source id for the cwd code corpus.
 *
 * Pattern: `gstack-code-<slug>-<hostpathhash8>` where slug comes from origin
 * (org/repo) and hostpathhash8 is the first 8 hex chars of
 * sha1(`${hostname}::${absolute repo path}`). Folding hostname into the hash
 * keeps Conductor worktrees of the same repo as distinct sources on one host
 * AND keeps two machines that share an absolute layout (e.g. chezmoi-managed
 * home dirs against a federated brain) from colliding on each other.
 *
 * Falls back to the repo basename when there is no origin (local repo).
 *
 * `GSTACK_HOSTNAME` env override is honored for deterministic tests; in
 * production paths it is unset and `os.hostname()` is used.
 *
 * gbrain enforces source ids to be 1-32 lowercase alnum chars with
 * optional interior hyphens. `constrainSourceId` handles the 32-char cap
 * with a hashed-tail fallback when the combined slug exceeds budget.
 */
function deriveCodeSourceId(repoPath: string): string {
  const host = process.env.GSTACK_HOSTNAME || hostname();
  const hostPathHash = createHash("sha1").update(`${host}::${repoPath}`).digest("hex").slice(0, 8);
  const remote = canonicalizeRemote(originUrl());
  if (remote) {
    const segs = remote.split("/").filter(Boolean);
    const slugSource = segs.slice(-2).join("-");
    const fullId = constrainSourceId("gstack-code", `${slugSource}-${hostPathHash}`);
    // If the org+repo+hostpathhash fits cleanly (suffix preserved), use it.
    if (fullId.endsWith(`-${hostPathHash}`)) return fullId;
    // Otherwise drop the org prefix and retry with just repo+hostpathhash so
    // the repo name stays readable. If that still doesn't fit,
    // constrainSourceId falls back to a deterministic hash-only form.
    const repoOnly = segs[segs.length - 1] || "repo";
    return constrainSourceId("gstack-code", `${repoOnly}-${hostPathHash}`);
  }
  const base = repoPath.split("/").pop() || "repo";
  return constrainSourceId("gstack-code", `${base}-${hostPathHash}`);
}

/**
 * Pre-pathhash source id, kept for orphan detection only.
 *
 * Earlier /sync-gbrain versions registered `gstack-code-<slug>` (no pathhash
 * suffix). On a multi-worktree repo, those collapsed onto a single source id
 * with last-sync-wins semantics. The new path-keyed id leaves the legacy
 * source orphaned in the brain — federated cross-source search would return
 * stale duplicate hits. We remove the legacy id once, on the first new-format
 * sync from any worktree of this repo, so users don't accumulate orphans.
 */
function deriveLegacyCodeSourceId(repoPath: string): string {
  const remote = canonicalizeRemote(originUrl());
  if (remote) {
    const segs = remote.split("/").filter(Boolean);
    const slugSource = segs.slice(-2).join("-");
    return constrainSourceId("gstack-code", slugSource);
  }
  const base = repoPath.split("/").pop() || "repo";
  return constrainSourceId("gstack-code", base);
}

/**
 * Pre-#1468 path-only-hash source id, kept for hostname-fold migration only.
 *
 * Before the hostname fold, `deriveCodeSourceId` hashed only the absolute
 * repo path: `gstack-code-<slug>-<sha1(path).slice(0,8)>`. After #1468 the
 * hash key is `${hostname}::${path}`, so every existing user's brain has a
 * legacy id that no longer matches what `deriveCodeSourceId` produces. We
 * detect this form once, attempt rename-in-place if the gbrain CLI supports
 * `sources rename`, and otherwise clean up after the new source successfully
 * syncs. Distinct from `deriveLegacyCodeSourceId` (pre-pathhash v1.x form);
 * both probes run.
 */
export function derivePathOnlyHashLegacyId(repoPath: string): string {
  const pathHash = createHash("sha1").update(repoPath).digest("hex").slice(0, 8);
  const remote = canonicalizeRemote(originUrl());
  if (remote) {
    const segs = remote.split("/").filter(Boolean);
    const slugSource = segs.slice(-2).join("-");
    return constrainSourceId("gstack-code", `${slugSource}-${pathHash}`);
  }
  const base = repoPath.split("/").pop() || "repo";
  return constrainSourceId("gstack-code", `${base}-${pathHash}`);
}

/**
 * Feature-check whether the installed gbrain CLI ships `sources rename <old> <new>`.
 *
 * Per the v1.40.0.0 design review: probing `gbrain sources rename --help` and
 * matching for the exact argument shape catches the case where gbrain's
 * `sources` parent help mentions a `rename` subcommand but the CLI doesn't
 * accept the `<old> <new>` form (or vice versa). Cached for the lifetime
 * of the process. As of gbrain 0.35.0.0 this command does not exist, so the
 * function returns false and the migration path falls back to register-new
 * + sync-OK + remove-old.
 */
let _gbrainSupportsRenameCache: boolean | null = null;
export function _resetGbrainSupportsRenameCache(): void {
  _gbrainSupportsRenameCache = null;
}
function gbrainSupportsSourcesRename(env?: NodeJS.ProcessEnv): boolean {
  if (_gbrainSupportsRenameCache !== null) return _gbrainSupportsRenameCache;
  try {
    const r = spawnGbrain(["sources", "rename", "--help"], {
      timeout: 5_000,
      baseEnv: env,
    });
    const out = `${r.stdout || ""}\n${r.stderr || ""}`;
    // Match the exact argument shape: `rename <old> <new>` (with literal
    // angle brackets in usage strings) or `rename OLD NEW`.
    const exact = /sources\s+rename\s+<old>\s+<new>/i.test(out)
      || /sources\s+rename\s+OLD\s+NEW/.test(out)
      || /sources\s+rename\s+<oldId>\s+<newId>/i.test(out);
    _gbrainSupportsRenameCache = exact && r.status === 0;
  } catch {
    _gbrainSupportsRenameCache = false;
  }
  return _gbrainSupportsRenameCache;
}

/**
 * Look up a source's `local_path` from `gbrain sources list --json`.
 * Returns null when the source is absent or the listing fails.
 *
 * `env` is the environment passed to the spawned `gbrain` process; defaults
 * to `process.env`. Tests inject a PATH that points at a gbrain shim so the
 * helper can be exercised without a real gbrain CLI.
 *
 * Shape note: `gbrain sources list --json` returns `{sources: [...]}` (v0.20+);
 * older versions returned a flat array. Accept both for forward/backward compat
 * (mirrors `probeSource`/`sourcePageCount` in lib/gbrain-sources.ts).
 */
export function sourceLocalPath(sourceId: string, env?: NodeJS.ProcessEnv): string | null {
  const raw = execGbrainJson<unknown>(
    ["sources", "list", "--json"],
    { baseEnv: env },
  );
  if (!raw) return null;
  const found = parseSourcesList(raw).find((s) => s.id === sourceId);
  return found?.local_path ?? null;
}

/** Result of `planHostnameFoldMigration` — informs `runCodeImport` of next steps. */
export type HostnameFoldMigration =
  | { kind: "none"; reason: "ids-match" | "no-legacy-source" }
  | { kind: "skipped-path-drift"; oldId: string; oldPath: string; currentPath: string }
  | { kind: "renamed"; oldId: string; newId: string }
  | { kind: "pending-cleanup"; oldId: string };

/**
 * Decide how to migrate from the pre-#1468 path-only-hash source id to the
 * new hostname-fold id.
 *
 * Order:
 *   1. If old == new → no-op.
 *   2. Look up old source's local_path. Absent → no legacy source to migrate.
 *   3. local_path != currentRoot → user moved the repo or two machines share a
 *      hash slot. Skip migration; let the user clean up manually. We will NOT
 *      rename or remove anything; the new source is registered alongside.
 *   4. Otherwise: feature-check `gbrain sources rename`. If supported and the
 *      rename call exits 0 → renamed, pages preserved.
 *   5. Else: pending-cleanup. Caller registers + syncs new source first; only
 *      after sync succeeds with a non-zero page count does it remove the old.
 *      This avoids a data-loss window where the old source is gone before the
 *      new one is verifiably populated.
 */
export function planHostnameFoldMigration(
  currentRoot: string,
  newSourceId: string,
  legacyPathHashId: string,
  env?: NodeJS.ProcessEnv,
): HostnameFoldMigration {
  if (legacyPathHashId === newSourceId) {
    return { kind: "none", reason: "ids-match" };
  }
  const oldPath = sourceLocalPath(legacyPathHashId, env);
  if (oldPath === null) {
    return { kind: "none", reason: "no-legacy-source" };
  }
  if (oldPath !== currentRoot) {
    return {
      kind: "skipped-path-drift",
      oldId: legacyPathHashId,
      oldPath,
      currentPath: currentRoot,
    };
  }
  if (gbrainSupportsSourcesRename(env)) {
    const r = spawnGbrain(["sources", "rename", legacyPathHashId, newSourceId], { baseEnv: env });
    if (r.status === 0) {
      return { kind: "renamed", oldId: legacyPathHashId, newId: newSourceId };
    }
    // Rename failed at runtime — fall through to cleanup path.
  }
  return { kind: "pending-cleanup", oldId: legacyPathHashId };
}

export interface GuardedRemoveResult {
  removed: boolean;
  /** True when a guard refused the remove (autopilot active or unsafe source). */
  skipped: boolean;
  reason: string;
}

/**
 * #1734: run `gbrain sources remove <id> --confirm-destructive` only behind the
 * data-loss guards. Checked immediately before the destructive op (E8: as late
 * as possible) so the autopilot window is as small as we can make it without a
 * gbrain-side lease. Refuses when autopilot is active or when the source is
 * user-managed and gbrain can't keep its storage. Pure side-effect helper; the
 * caller decides whether a skip is fatal (it never is today — removes are
 * best-effort cleanup).
 */
export function safeSourcesRemove(sourceId: string, env?: NodeJS.ProcessEnv): GuardedRemoveResult {
  const ap = detectAutopilot(env);
  if (ap.active) {
    return {
      removed: false,
      skipped: true,
      reason: `autopilot active (${ap.signal}); refusing destructive remove of ${sourceId}. ` +
        `Stop autopilot, then re-run /sync-gbrain.`,
    };
  }
  const decision = decideSourceRemove(sourceId, env);
  if (!decision.allow) {
    return { removed: false, skipped: true, reason: decision.reason };
  }
  const r = spawnGbrain(
    ["sources", "remove", sourceId, "--confirm-destructive", ...decision.extraArgs],
    { baseEnv: env },
  );
  return { removed: r.status === 0, skipped: false, reason: decision.reason };
}

/**
 * Remove an orphaned source. Called only after new-source sync verifies pages
 * exist, so the old source is provably redundant before deletion. Routed through
 * safeSourcesRemove for the #1734 guards.
 */
export function removeOrphanedSource(oldId: string, env?: NodeJS.ProcessEnv): boolean {
  return safeSourcesRemove(oldId, env).removed;
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
function constrainSourceId(prefix: string, raw: string): string {
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

// ── Lock file (D1) ─────────────────────────────────────────────────────────

interface LockInfo {
  pid: number;
  started_at: string;
}

function acquireLock(): boolean {
  mkdirSync(GSTACK_HOME, { recursive: true });
  if (existsSync(LOCK_PATH)) {
    // Check if stale.
    try {
      const stat = statSync(LOCK_PATH);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs > STALE_LOCK_MS) {
        // Stale; take over.
        unlinkSync(LOCK_PATH);
      } else {
        return false;
      }
    } catch {
      // Cannot stat; bail conservatively.
      return false;
    }
  }
  const info: LockInfo = { pid: process.pid, started_at: new Date().toISOString() };
  try {
    writeFileSync(LOCK_PATH, JSON.stringify(info), { encoding: "utf-8", flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

function releaseLock(): void {
  try {
    if (!existsSync(LOCK_PATH)) return;
    const raw = readFileSync(LOCK_PATH, "utf-8");
    const info = JSON.parse(raw) as LockInfo;
    if (info.pid === process.pid) {
      unlinkSync(LOCK_PATH);
    }
  } catch {
    // Best-effort cleanup.
  }
}

/**
 * Acquire the dream marker (`~/.gstack/.dream-in-progress`). Returns false when
 * a FRESH marker already exists (another worktree is mid-dream) — the caller
 * then SKIPs rather than launching a duplicate ~35-min global job. A stale
 * marker (older than DREAM_MARKER_STALE_MS, i.e. a crashed run) is taken over.
 * Mirrors acquireLock but with the dream TTL and its own path.
 */
export function acquireDreamMarker(): boolean {
  const path = dreamMarkerPath();
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    try {
      const stat = statSync(path);
      if (Date.now() - stat.mtimeMs > DREAM_MARKER_STALE_MS) {
        unlinkSync(path);
      } else {
        return false;
      }
    } catch {
      return false;
    }
  }
  const info: LockInfo = { pid: process.pid, started_at: new Date().toISOString() };
  try {
    writeFileSync(path, JSON.stringify(info), { encoding: "utf-8", flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

export function releaseDreamMarker(): void {
  try {
    const path = dreamMarkerPath();
    if (!existsSync(path)) return;
    const info = JSON.parse(readFileSync(path, "utf-8")) as LockInfo;
    if (info.pid === process.pid) unlinkSync(path);
  } catch {
    // Best-effort cleanup.
  }
}

/** Read the pid recorded in a fresh dream marker, for the "already running" message. */
function dreamMarkerPid(): number | null {
  try {
    const info = JSON.parse(readFileSync(dreamMarkerPath(), "utf-8")) as LockInfo;
    return typeof info.pid === "number" ? info.pid : null;
  } catch {
    return null;
  }
}

// ── Stage runners ──────────────────────────────────────────────────────────

/**
 * Build a SKIP result for the code/memory stage when the local engine is
 * not in 'ok' state (per plan D12). Surface the status verbatim so the
 * verdict block tells the user exactly what's wrong without re-probing.
 *
 * Reasons mapped to user-actionable summaries:
 *   no-cli         → "gbrain CLI not on PATH; install via /setup-gbrain"
 *   missing-config → "no local engine; run /setup-gbrain to add local PGLite"
 *   broken-config  → "config file at ~/.gbrain/config.json is malformed; see /setup-gbrain Step 1.5"
 *   broken-db      → "config points at unreachable DB; see /setup-gbrain Step 1.5"
 *   engine-locked  → PGLite is busy; stop its holder or sync outside the live session
 *   timeout        → kept for Record totality; stages PROCEED on timeout (#1964)
 *                    via the gate's warnProbeTimeout path, never this skip.
 */
function skipStageForLocalStatus(
  stage: "code" | "memory" | "dream",
  status: LocalEngineStatus,
  t0: number,
): StageResult {
  const reasons: Record<Exclude<LocalEngineStatus, "ok">, string> = {
    "no-cli": "gbrain CLI not on PATH; install via /setup-gbrain",
    "missing-config":
      "no local engine; run /setup-gbrain to add local PGLite for code search",
    "broken-config":
      "config at ~/.gbrain/config.json is malformed; see /setup-gbrain Step 1.5",
    "broken-db":
      "config points at unreachable DB; see /setup-gbrain Step 1.5",
    "engine-locked":
      "PGLite is busy (often held by gbrain serve); stop the holding process or run /sync-gbrain outside the live Claude session, then retry",
    "timeout":
      "engine probe timed out; raise GSTACK_GBRAIN_PROBE_TIMEOUT_MS if your pooler is slow",
  };
  const reason = reasons[status as Exclude<LocalEngineStatus, "ok">];
  return {
    name: stage,
    ran: false,
    ok: true, // SKIP (per D12) — not a stage failure, just an unsatisfied prerequisite
    duration_ms: Date.now() - t0,
    summary: `skipped — local engine ${status} — ${reason}`,
  };
}

/**
 * "timeout" means the probe hit its deadline with no recognized error — the
 * engine is most likely healthy but slow (#1964: cold pooler connections
 * measured at 6.9-10.7s). Stages proceed; a genuinely-dead engine surfaces
 * its REAL error at the first actual operation instead of a false
 * "config malformed" skip.
 */
function warnProbeTimeout(stage: "code" | "memory" | "dream"): void {
  process.stderr.write(
    `[gstack-gbrain-sync] ${stage}: engine probe timed out — proceeding anyway; ` +
      `raise GSTACK_GBRAIN_PROBE_TIMEOUT_MS if your pooler is slow\n`,
  );
}


async function runCodeImport(args: CliArgs): Promise<StageResult> {
  const t0 = Date.now();
  const root = repoRoot();
  if (!root) {
    return { name: "code", ran: false, ok: true, duration_ms: 0, summary: "skipped (not in git repo)" };
  }

  const sourceId = deriveCodeSourceId(root);

  // dry-run preview always shows the would-do steps, regardless of local
  // engine state. Useful for "what would /sync-gbrain do" without probing
  // the engine.
  if (args.mode === "dry-run") {
    return {
      name: "code",
      ran: false,
      ok: true,
      duration_ms: 0,
      summary: `would: gbrain sources add ${sourceId} --path ${root} --federated; gbrain sync --strategy code --source ${sourceId}; gbrain sources attach ${sourceId}`,
      detail: { source_id: sourceId, source_path: root, status: "skipped" },
    };
  }

  // Split-engine pre-flight (per plan D12): when local engine is not ok, SKIP
  // code stage cleanly. Brain-sync stage still runs because it doesn't depend
  // on local engine. The /sync-gbrain Step 1.5 pre-flight surfaces the user
  // remediation message; this skip just keeps the orchestrator from crashing
  // when the local DB is dead. Skipped on --dry-run (above) since dry-run
  // never actually probes anything.
  const localStatus = localEngineStatus({ noCache: false });
  if (localStatus === "timeout") {
    warnProbeTimeout("code"); // #1964: slow-but-healthy — proceed
  } else if (localStatus !== "ok") {
    return skipStageForLocalStatus("code", localStatus, t0);
  }

  // Step 0a: Best-effort cleanup of pre-pathhash legacy source (v1.x form).
  // Earlier /sync-gbrain versions registered `gstack-code-<slug>` (no path
  // suffix). On a multi-worktree repo, those collapsed onto a single id
  // with last-sync-wins. Federated search would return stale duplicate
  // hits forever if we left the orphan in place. Remove the legacy id once
  // here so users don't accumulate orphans.
  // Failure is non-fatal — we still register the new id below.
  // gbrainEnv seeds DATABASE_URL from gbrain's config so this stage works
  // inside Next.js / Prisma / Rails projects with their own .env.local
  // (codex review #7 — bug fix is wider than #1508 as filed).
  const gbrainEnv = buildGbrainEnv({ announce: !args.quiet });
  const legacyId = deriveLegacyCodeSourceId(root);
  let legacyRemoved = false;
  if (legacyId !== sourceId) {
    // #1734: route through the data-loss guards (autopilot + source-safety).
    const rm = safeSourcesRemove(legacyId, gbrainEnv);
    if (rm.skipped && !args.quiet) {
      console.error(`[sync:code] legacy-source cleanup skipped: ${rm.reason}`);
    }
    if (rm.removed) legacyRemoved = true;
  }

  // Step 0b: Hostname-fold migration (#1414).
  // Before #1468 the source id hashed only the absolute repo path. After the
  // hostname fold, every existing user has a legacy id that no longer matches
  // what deriveCodeSourceId produces. Try rename-in-place first (preserves
  // pages); fall back to register-new → sync-OK → remove-old. Path-drift
  // (user moved the repo, etc.) skips migration with a warning.
  const pathOnlyHashLegacyId = derivePathOnlyHashLegacyId(root);
  const migration = planHostnameFoldMigration(root, sourceId, pathOnlyHashLegacyId, gbrainEnv);
  if (migration.kind === "skipped-path-drift" && !args.quiet) {
    console.error(
      `[sync:code] hostname-fold migration skipped: legacy source ${migration.oldId} `
      + `points at ${migration.oldPath}, current repo is ${migration.currentPath}. `
      + `Clean up manually with: gbrain sources remove ${migration.oldId} --confirm-destructive`,
    );
  } else if (migration.kind === "renamed" && !args.quiet) {
    console.error(`[sync:code] hostname-fold migration: renamed ${migration.oldId} → ${migration.newId} (pages preserved)`);
  }

  // Step 1: Ensure source registered (idempotent). Single source of truth in lib —
  // no synchronous duplicate here (per /codex review #12).
  let registered = false;
  try {
    const result = await ensureSourceRegistered(sourceId, root, { federated: true, env: gbrainEnv });
    registered = result.changed;
  } catch (err) {
    return {
      name: "code",
      ran: true,
      ok: false,
      duration_ms: Date.now() - t0,
      summary: `source registration failed: ${(err as Error).message}`,
      detail: { source_id: sourceId, source_path: root, status: "failed" },
    };
  }

  // Step 2: Always run the page-creating file walk first, then (for --full)
  // a full re-embed.
  //
  // `gbrain reindex-code` only RE-EMBEDS pages that already exist; it never
  // walks the filesystem. On a freshly-registered source (0 pages) a --full
  // run that called reindex-code alone found nothing ("No code pages to
  // reindex"), finished in ~1s, and left the code index permanently empty
  // while still reporting OK. The page-creating walk is `sync --strategy
  // code`, so --full must run it FIRST, then reindex-code, to honor the
  // documented "full walk + reindex" contract for both fresh and populated
  // sources.
  const codeTimeoutMs = resolveStageTimeoutMs(
    process.env.GSTACK_SYNC_CODE_TIMEOUT_MS,
    "GSTACK_SYNC_CODE_TIMEOUT_MS",
  );

  // #1734 guards, checked immediately before the destructive walk (E8):
  //   - autopilot active → refuse (the race that wiped a working tree).
  //   - URL-managed source → the walk can auto-reclone (rm-rf); require
  //     --allow-reclone. Both surface a visible reason and fail the stage so the
  //     verdict shows ERR rather than silently skipping protection.
  const apBeforeWalk = detectAutopilot(gbrainEnv);
  if (apBeforeWalk.active) {
    return {
      name: "code", ran: true, ok: false, duration_ms: Date.now() - t0,
      summary: `refused: gbrain autopilot active (${apBeforeWalk.signal}). Stop autopilot, then re-run /sync-gbrain.`,
      detail: { source_id: sourceId, source_path: root, status: "refused-autopilot" },
    };
  }
  const reclone = decideCodeSync(sourceId, gbrainEnv, args.allowReclone);
  if (!reclone.allow) {
    return {
      name: "code", ran: true, ok: false, duration_ms: Date.now() - t0,
      summary: `refused: ${reclone.reason}`,
      detail: { source_id: sourceId, source_path: root, status: "refused-reclone" },
    };
  }

  const walkResult = spawnGbrain(["sync", "--strategy", "code", "--source", sourceId], {
    stdio: args.quiet ? ["ignore", "ignore", "ignore"] : ["ignore", "inherit", "inherit"],
    timeout: codeTimeoutMs,
    baseEnv: gbrainEnv,
  });

  if (walkResult.status !== 0) {
    return {
      name: "code",
      ran: true,
      ok: false,
      duration_ms: Date.now() - t0,
      summary: `gbrain sync --strategy code --source ${sourceId} exited ${walkResult.status}`,
      detail: { source_id: sourceId, source_path: root, status: "failed" },
    };
  }

  if (args.mode === "full") {
    const reindexResult = spawnGbrain(["reindex-code", "--source", sourceId, "--yes"], {
      stdio: args.quiet ? ["ignore", "ignore", "ignore"] : ["ignore", "inherit", "inherit"],
      timeout: codeTimeoutMs,
      baseEnv: gbrainEnv,
    });

    if (reindexResult.status !== 0) {
      return {
        name: "code",
        ran: true,
        ok: false,
        duration_ms: Date.now() - t0,
        summary: `gbrain reindex-code --source ${sourceId} exited ${reindexResult.status}`,
        detail: { source_id: sourceId, source_path: root, status: "failed" },
      };
    }
  }

  // Step 3: Pin this worktree's CWD to the source via .gbrain-source. Subsequent
  // gbrain code-def / code-refs / code-callers calls from anywhere under <root>
  // route to this source by default — no --source flag needed.
  //
  // If attach fails the whole flow has a silent correctness problem: sync
  // succeeded but unqualified `gbrain code-def` from this worktree will hit
  // the wrong/default source. Treat it as a stage failure (ok=false) so the
  // verdict block surfaces ERR and the user knows to retry rather than
  // trusting stale results.
  const attach = spawnGbrain(["sources", "attach", sourceId], {
    timeout: 10_000,
    cwd: root,
    baseEnv: gbrainEnv,
  });
  const pageCount = sourcePageCount(sourceId, gbrainEnv);

  // Step 4: Deferred hostname-fold cleanup.
  // Only remove the pre-#1468 path-only-hash source NOW that the new source
  // has registered + synced + has pages. Removing before sync would create a
  // data-loss window if sync failed; removing without a page-count check would
  // wipe pages when sync silently no-op'd. This is the codex-review-flagged
  // safety: register → sync → verify → THEN delete.
  let hostnameLegacyRemoved = false;
  if (migration.kind === "pending-cleanup" && pageCount !== null && pageCount > 0) {
    hostnameLegacyRemoved = removeOrphanedSource(migration.oldId, gbrainEnv);
    if (hostnameLegacyRemoved && !args.quiet) {
      console.error(`[sync:code] hostname-fold migration: removed legacy ${migration.oldId} after new source sync verified (page_count=${pageCount})`);
    }
  }

  const legacyParts: string[] = [];
  if (legacyRemoved) legacyParts.push(`removed legacy ${legacyId}`);
  if (migration.kind === "renamed") legacyParts.push(`renamed ${migration.oldId}→${migration.newId}`);
  if (hostnameLegacyRemoved) legacyParts.push(`removed pre-hostname-fold ${migration.kind === "pending-cleanup" ? migration.oldId : ""}`);
  const legacyNote = legacyParts.length > 0 ? `, ${legacyParts.join(", ")}` : "";
  const baseSummary = `${registered ? "registered + " : ""}synced ${sourceId} (page_count=${pageCount ?? "unknown"}${legacyNote})`;

  if (attach.status !== 0) {
    const reason = (attach.stderr || attach.stdout || "").trim().split("\n").pop() || `exit ${attach.status}`;
    return {
      name: "code",
      ran: true,
      ok: false,
      duration_ms: Date.now() - t0,
      summary: `${baseSummary}; attach FAILED (${reason}) — code-def queries from this worktree will hit the default source until /sync-gbrain succeeds`,
      detail: {
        source_id: sourceId,
        source_path: root,
        page_count: pageCount,
        last_imported: new Date().toISOString(),
        status: "failed",
      },
    };
  }

  // v1.29.0.0 changelog promised the per-worktree pin would be ignored in the
  // consuming repo, but the change actually only added .gbrain-source to
  // gstack's own .gitignore. Without the consumer-side entry, the pin gets
  // committed and breaks the per-worktree promise: Conductor sibling worktrees
  // step on each other's pin every time anyone commits (#1384).
  ensureGbrainSourceGitignored(root);

  return {
    name: "code",
    ran: true,
    ok: true,
    duration_ms: Date.now() - t0,
    summary: baseSummary,
    detail: {
      source_id: sourceId,
      source_path: root,
      page_count: pageCount,
      last_imported: new Date().toISOString(),
      status: "ok",
    },
  };
}

/**
 * Ensure `.gbrain-source` is listed in the consumer repo's `.gitignore`.
 *
 * Idempotent: only appends when the entry is not already present (matched on
 * trimmed lines so a leading/trailing whitespace difference doesn't add a
 * second copy). Wraps writes in try/catch so a read-only checkout or weird
 * perms logs a warning and lets the rest of the sync continue.
 */
export function ensureGbrainSourceGitignored(root: string): void {
  const gitignorePath = join(root, ".gitignore");
  try {
    let existing = "";
    try {
      existing = readFileSync(gitignorePath, "utf-8");
    } catch {
      // No .gitignore yet — we'll create it.
    }
    const alreadyIgnored = existing
      .split("\n")
      .some((line) => line.trim() === ".gbrain-source");
    if (alreadyIgnored) {
      return;
    }
    const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    writeFileSync(gitignorePath, existing + sep + ".gbrain-source\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[sync:code] could not add .gbrain-source to ${gitignorePath}: ${msg}`,
    );
  }
}

function runMemoryIngest(args: CliArgs): StageResult {
  const t0 = Date.now();

  if (args.mode === "dry-run") {
    return { name: "memory", ran: false, ok: true, duration_ms: 0, summary: "would: gstack-memory-ingest --probe" };
  }

  // Split-engine pre-flight (per plan D12). gstack-memory-ingest shells out
  // to `gbrain import` which targets the LOCAL engine. When that engine is
  // not ok, SKIP cleanly so brain-sync (the only stage that doesn't depend
  // on local engine) still runs.
  const localStatus = localEngineStatus({ noCache: false });
  if (localStatus === "timeout") {
    warnProbeTimeout("memory"); // #1964: slow-but-healthy — proceed
  } else if (localStatus !== "ok") {
    return skipStageForLocalStatus("memory", localStatus, t0);
  }

  // Resume detection (#1611 / plan D1 + C1). If a previous run hit the
  // timeout and gbrain left ~/.gbrain/import-checkpoint.json plus its staging
  // dir on disk, signal the grandchild via env so it skips the prepare phase
  // and lets `gbrain import` resume from processedIndex+1 against the same
  // staging dir. If the staging dir is gone (disk pressure cleanup, OS
  // reboot, user manual cleanup), warn and fall through to a fresh restage.
  const resume = decideResume();
  const childEnv = buildGbrainEnv({ announce: false });
  if (resume.kind === "resume") {
    console.error(
      `[sync:memory] resuming from gbrain checkpoint (${resume.processedIndex}/${resume.totalFiles} files staged at ${resume.stagingDir})`,
    );
    childEnv.GSTACK_INGEST_RESUME_DIR = resume.stagingDir;
  } else if (resume.kind === "stale-staging-missing") {
    // The reason distinguishes "actually gone" (disk cleanup / reboot) from
    // "refused as unowned" (#1802 poison: the path may still exist on disk).
    // Logging "gone" for a refused poison path misdirects incident diagnosis.
    const why = resume.reason
      ? `staging dir not usable: ${resume.reason}`
      : `staging dir ${resume.stagingDir} gone`;
    console.error(
      `[sync:memory] previous checkpoint stale (${why}), restaging from scratch. ` +
        `Remove ~/.gbrain/import-checkpoint.json to silence.`,
    );
  }

  const ingestPath = join(import.meta.dir, "gstack-memory-ingest.ts");
  const ingestArgs = ["run", ingestPath];
  if (args.mode === "full") ingestArgs.push("--bulk");
  else ingestArgs.push("--incremental");
  if (args.quiet) ingestArgs.push("--quiet");

  // Thread the seeded env into the bun grandchild (codex review #7 — the
  // .env.local footgun affects gstack-memory-ingest.ts too, not just the
  // direct gbrain spawns in this file). The grandchild calls gbrain import
  // internally and must see the DATABASE_URL from gbrain's own config.
  const memoryTimeoutMs = resolveStageTimeoutMs(
    process.env.GSTACK_SYNC_MEMORY_TIMEOUT_MS,
    "GSTACK_SYNC_MEMORY_TIMEOUT_MS",
  );
  const result = spawnSync("bun", ingestArgs, {
    encoding: "utf-8",
    timeout: memoryTimeoutMs,
    env: childEnv,
  });

  // D6: parse [memory-ingest] lines from the child's stderr. ERR-prefixed
  // lines indicate a system-level failure (gbrain crashed or CLI missing)
  // and the child exits non-zero. Per-file failures are summarized in the
  // last non-ERR [memory-ingest] line but do NOT make the verdict ERR.
  const stderrLines = (result.stderr || "").split("\n");
  const memLines = stderrLines.filter((l) => l.includes("[memory-ingest]"));
  const errLine = memLines.find((l) => l.includes("[memory-ingest] ERR"));
  const lastMemLine = memLines.slice(-1)[0];
  const rawSummary = errLine || lastMemLine || "ingest pass complete";
  // Strip the "[memory-ingest] " prefix and any leading "ERR: " for cleaner
  // verdict output. The orchestrator's own formatStage will prefix with OK/ERR.
  const summary = rawSummary
    .replace(/^.*\[memory-ingest\]\s*/, "")
    .replace(/^ERR:\s*/, "");

  const ok = result.status === 0;
  return {
    name: "memory",
    ran: true,
    ok,
    duration_ms: Date.now() - t0,
    summary: ok
      ? summary
      : `${summary}${result.status === null ? " (killed by signal / timeout)" : ` (exit ${result.status})`}`,
  };
}

function runBrainSyncPush(args: CliArgs): StageResult {
  const t0 = Date.now();

  if (args.mode === "dry-run") {
    return { name: "brain-sync", ran: false, ok: true, duration_ms: 0, summary: "would: gstack-brain-sync --discover-new --once" };
  }

  const brainSyncPath = join(import.meta.dir, "gstack-brain-sync");
  if (!existsSync(brainSyncPath)) {
    return { name: "brain-sync", ran: false, ok: true, duration_ms: 0, summary: "skipped (gstack-brain-sync not installed)" };
  }

  // #1731: gstack-brain-sync is a bash shebang script; Windows can't spawn it
  // without a shell, which surfaced as "brain-sync exited undefined".
  spawnSync(brainSyncPath, ["--discover-new"], {
    stdio: args.quiet ? ["ignore", "ignore", "ignore"] : ["ignore", "inherit", "inherit"],
    timeout: 60 * 1000,
    shell: NEEDS_SHELL_ON_WINDOWS,
  });
  const result = spawnSync(brainSyncPath, ["--once"], {
    stdio: args.quiet ? ["ignore", "ignore", "ignore"] : ["ignore", "inherit", "inherit"],
    timeout: 60 * 1000,
    shell: NEEDS_SHELL_ON_WINDOWS,
  });

  return {
    name: "brain-sync",
    ran: true,
    ok: result.status === 0,
    duration_ms: Date.now() - t0,
    summary: result.status === 0 ? "curated artifacts pushed" : `gstack-brain-sync exited ${result.status}`,
  };
}

/**
 * Decide whether the dream (call-graph build) cycle should run. PURE so the
 * gate matrix is unit-testable without spawning a real ~35-min dream.
 *
 *   - explicit --dream → always run (force), regardless of cycle state / --no-code.
 *   - --full → run ONLY when the call graph was never built (cycle === "never"),
 *     and only when not opted out via --no-dream / --no-code. "completed" skips
 *     (edges already built); "unknown" skips (a flaky doctor must not trigger a
 *     surprise 35-min cycle — see gbrain-doctor-overstrict).
 *   - everything else → skip.
 *
 * `cycle` is only consulted on the --full auto path; pass null when forcing.
 */
export function shouldRunDream(args: CliArgs, cycle: CycleStatus | null): boolean {
  if (args.dream) return true;
  if (args.mode === "full" && !args.noDream && !args.noCode) {
    return cycle === "never";
  }
  return false;
}

/**
 * Run `gbrain dream` — the brain-global maintenance cycle whose
 * resolve_symbol_edges phase builds the call graph. Runs LOCK-FREE (called
 * after the sync lock releases) so it never freezes sibling worktrees; the
 * `.dream-in-progress` marker dedupes concurrent dreams instead.
 *
 * Returns a StageResult (never throws). SKIP (ran:false, ok:true) for: dry-run
 * preview, local engine not ok, or a fresh marker present. ERR (ran:true,
 * ok:false) for: non-zero/timeout exit, or a spawn-setup failure (missing
 * binary / malformed env) — a broken install must be visible, not disguised as
 * optional maintenance.
 */
export async function runDream(args: CliArgs): Promise<StageResult> {
  const t0 = Date.now();

  if (args.mode === "dry-run") {
    const root = repoRoot();
    const sourceId = root ? deriveCodeSourceId(root) : null;
    return {
      name: "dream",
      ran: false,
      ok: true,
      duration_ms: 0,
      summary: sourceId
        ? `would: gbrain dream --source ${sourceId}  (build this source's call graph)`
        : "would: gbrain dream  (call-graph build)",
    };
  }

  const localStatus = localEngineStatus({ noCache: false });
  if (localStatus === "timeout") {
    warnProbeTimeout("dream"); // #1964: slow-but-healthy — proceed
  } else if (localStatus !== "ok") {
    return skipStageForLocalStatus("dream", localStatus, t0);
  }

  // Dedupe concurrent dreams across worktrees (lock-free path).
  if (!acquireDreamMarker()) {
    const pid = dreamMarkerPid();
    return {
      name: "dream",
      ran: false,
      ok: true,
      duration_ms: Date.now() - t0,
      summary: `dream already running${pid !== null ? ` (pid ${pid})` : ""} — skipped`,
    };
  }

  try {
    const dreamTimeoutMs = resolveStageTimeoutMs(
      process.env.GSTACK_SYNC_DREAM_TIMEOUT_MS,
      "GSTACK_SYNC_DREAM_TIMEOUT_MS",
      DEFAULT_DREAM_TIMEOUT_MS,
    );

    // Scope the cycle to THIS worktree's code source: `gbrain dream --source <id>`.
    // Verified empirically (not just from `gbrain --help`): plain `gbrain dream`
    // cycles the brain's default source and never runs the source-scoped `extract`
    // phase for our code source, so the call graph for the pinned source stays
    // empty. `gbrain dream --source <id>` runs the per-source cycle (the form
    // `gbrain doctor` recommends for stale sources) and is what actually populates
    // code-callers/code-callees for this worktree. Falls back to plain `dream`
    // only when we can't derive the source id (not in a git repo).
    const root = repoRoot();
    const sourceId = root ? deriveCodeSourceId(root) : null;
    const dreamArgs = sourceId ? ["dream", "--source", sourceId] : ["dream"];

    // spawnGbrain seeds DATABASE_URL from gbrain's config via buildGbrainEnv.
    //
    // We CAPTURE output (pipe) rather than inherit because `gbrain dream` exits 0
    // even when it SKIPS the cycle — when another cycle already holds gbrain's own
    // DB lock (e.g. a running `gbrain autopilot`), it prints "Skipped: another
    // cycle is already running. (locked)" and exits 0. Trusting the exit code
    // alone would falsely report "call graph built". Trade-off: no live streaming
    // for a long cycle; we echo the captured output afterward instead.
    if (!args.quiet) {
      process.stderr.write("[dream] running gbrain cycle (call-graph build; this can take a few minutes)...\n");
    }
    let result: ReturnType<typeof spawnGbrain>;
    try {
      result = spawnGbrain(dreamArgs, {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: dreamTimeoutMs,
        baseEnv: process.env,
        announce: !args.quiet,
      });
    } catch (err) {
      // Spawn-setup failure (missing binary, bad env): ERR, not a benign skip.
      return {
        name: "dream",
        ran: true,
        ok: false,
        duration_ms: Date.now() - t0,
        summary: `gbrain dream failed to start: ${(err as Error).message}`,
      };
    }

    if (result.error) {
      const e = result.error as NodeJS.ErrnoException;
      const why = e.code === "ENOENT" ? "gbrain not on PATH" : e.message;
      return {
        name: "dream",
        ran: true,
        ok: false,
        duration_ms: Date.now() - t0,
        summary: `gbrain dream failed to start: ${why}`,
      };
    }

    const out = `${result.stdout || ""}${result.stderr || ""}`;
    if (!args.quiet && out.trim()) {
      process.stderr.write(out.endsWith("\n") ? out : `${out}\n`);
    }

    if (result.status !== 0) {
      return {
        name: "dream",
        ran: true,
        ok: false,
        duration_ms: Date.now() - t0,
        summary: `gbrain dream exited ${result.status === null ? "null (killed by signal / timeout)" : result.status}`,
      };
    }

    // Exit 0 but the cycle was SKIPPED because gbrain's own lock is held by
    // another cycle (typically `gbrain autopilot`). Report SKIP, not "built" —
    // the graph builds on that other cycle, not this invocation.
    if (/already running|\block(?:ed)?\b|Skipped:/i.test(out)) {
      return {
        name: "dream",
        ran: false,
        ok: true,
        duration_ms: Date.now() - t0,
        summary: "skipped — a gbrain cycle is already running (e.g. autopilot); the call graph builds on that cycle",
      };
    }

    // Exit 0 and the cycle actually ran. Parse the cycle's OWN output to report
    // the truth, not a flat "built": `gbrain dream` exits 0 even when the call
    // graph could not be built, and a misleading "built" turns a multi-minute
    // no-op into a silent dead end. gbrain only surfaces these conditions in the
    // cycle log (there is no pre-flight pack-capability query as of 0.41.x), so
    // string-matching the log is the available signal; an unrecognized log
    // degrades to the generic success summary below.
    const dreamWarn = classifyDreamOutcome(out);
    if (dreamWarn) {
      return {
        name: "dream",
        ran: true,
        ok: true,
        warn: true,
        duration_ms: Date.now() - t0,
        summary: dreamWarn,
      };
    }

    const edges = parseResolvedEdges(out);
    return {
      name: "dream",
      ran: true,
      ok: true,
      duration_ms: Date.now() - t0,
      summary:
        edges !== null
          ? `call graph built (${edges} edge${edges === 1 ? "" : "s"} resolved)`
          : "call graph built (resolve_symbol_edges complete)",
    };
  } finally {
    releaseDreamMarker();
  }
}

/**
 * Parse `<n>` from a `resolve_symbol_edges ... resolved <n>` cycle-log line.
 * Returns null when the line is absent (older gbrain / different pack). The
 * `[^\n]*?` is newline-bounded so it matches the `✓ resolve_symbol_edges ...`
 * summary line, not the bracketed `[cycle.resolve_symbol_edges] start` markers.
 */
export function parseResolvedEdges(out: string): number | null {
  const m = out.match(/resolve_symbol_edges\b[^\n]*?\bresolved\s+(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Inspect a completed (exit-0) `gbrain dream` log and return a WARN summary when
 * the cycle ran but could not actually build the call graph. Returns null on the
 * happy path (caller emits the normal "call graph built" summary). Order matters:
 * the pack-capability gap is the most actionable, so it wins over a 0-edge count
 * (both appear together when the pack lacks the code-symbol phase).
 */
export function classifyDreamOutcome(out: string): string | null {
  // The active schema pack doesn't declare the code-symbol extraction phase, so
  // no symbols are extracted and resolve_symbol_edges has nothing to match.
  if (/does not declare this phase/i.test(out)) {
    return (
      "dream ran, but this source's schema pack does not extract code symbols, " +
      "so the call graph stays empty. Switch this source to a code-aware schema " +
      "pack (`gbrain schema use <pack>`) to enable code-callers/code-callees."
    );
  }
  // The embed phase failed for a missing key; symbols can't index without it.
  if (/embed phase failed/i.test(out) || /requires\s+\S*_API_KEY/i.test(out)) {
    return (
      "dream ran, but the embed phase failed (missing embedding API key), so " +
      "symbols won't index. Ensure the embedding provider's key is set for the " +
      "gbrain process, then re-run /sync-gbrain --dream."
    );
  }
  // Cycle ran and embedded fine, but matched zero call-graph edges.
  if (parseResolvedEdges(out) === 0) {
    return "dream ran but resolved 0 call-graph edges (no code symbols matched for this source yet).";
  }
  return null;
}

// ── State file ─────────────────────────────────────────────────────────────

interface SyncState {
  schema_version: 1;
  last_writer: string;
  last_sync?: string;
  last_full_sync?: string;
  last_stages?: StageResult[];
}

function loadSyncState(): SyncState {
  if (!existsSync(STATE_PATH)) {
    return { schema_version: 1, last_writer: "gstack-gbrain-sync" };
  }
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, "utf-8")) as SyncState;
    if (raw.schema_version === 1) return raw;
  } catch {
    // fall through
  }
  return { schema_version: 1, last_writer: "gstack-gbrain-sync" };
}

/**
 * Atomic state file write per /plan-eng-review D1: write tmp file then rename.
 * rename(2) is atomic on POSIX filesystems.
 */
function saveSyncState(state: SyncState): void {
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    const tmp = `${STATE_PATH}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
    renameSync(tmp, STATE_PATH);
  } catch {
    // non-fatal
  }
}

/**
 * Persist the dream stage result with read-modify-write semantics.
 *
 * Dream runs AFTER the sync lock releases, so a sibling worktree may have
 * written newer state in the meantime. Overwriting the whole file with our
 * pre-dream snapshot + dream result would clobber that sibling's sync. Instead
 * re-read the CURRENT state, replace only the `dream` entry in last_stages, and
 * atomic-rename. (Atomic rename alone isn't race-safe; the re-read + targeted
 * merge is what prevents the clobber.)
 */
function mergeDreamIntoState(dream: StageResult): void {
  const fresh = loadSyncState();
  const others = (fresh.last_stages || []).filter((s) => s.name !== "dream");
  fresh.last_stages = [...others, dream];
  fresh.last_sync = new Date().toISOString();
  saveSyncState(fresh);
}

// ── Output ─────────────────────────────────────────────────────────────────

export function formatStage(s: StageResult): string {
  const status = !s.ran ? "SKIP" : !s.ok ? "ERR" : s.warn ? "WARN" : "OK";
  const dur = s.duration_ms > 0 ? ` (${(s.duration_ms / 1000).toFixed(1)}s)` : "";
  return `  ${status.padEnd(5)} ${s.name.padEnd(12)} ${s.summary}${dur}`;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();

  if (!args.quiet) {
    const engine = detectEngineTier();
    console.error(`[gbrain-sync] mode=${args.mode} engine=${engine.engine}`);
  }

  // Acquire lock (skip on dry-run since dry-run never writes).
  const needsLock = args.mode !== "dry-run";
  let haveLock = false;
  if (needsLock) {
    haveLock = acquireLock();
    if (!haveLock) {
      console.error(
        `[gbrain-sync] another /sync-gbrain is running (lock at ${LOCK_PATH}). ` +
        `If that process died, the lock auto-clears after 5 min, or remove it manually.`
      );
      process.exit(2);
    }
  }

  const cleanup = () => {
    if (haveLock) releaseLock();
  };
  process.on("SIGINT", () => { cleanup(); process.exit(130); });
  process.on("SIGTERM", () => { cleanup(); process.exit(143); });

  let exitCode = 0;
  const stages: StageResult[] = [];
  try {
    const state = loadSyncState();

    if (!args.noCode) {
      stages.push(await withErrorContext("sync:code", () => runCodeImport(args), "gstack-gbrain-sync"));
    }
    if (!args.noMemory) {
      stages.push(await withErrorContext("sync:memory", () => runMemoryIngest(args), "gstack-gbrain-sync"));
    }
    if (!args.noBrainSync) {
      stages.push(await withErrorContext("sync:brain-sync", () => runBrainSyncPush(args), "gstack-gbrain-sync"));
    }

    if (args.mode !== "dry-run") {
      state.last_sync = new Date().toISOString();
      if (args.mode === "full") state.last_full_sync = state.last_sync;
      state.last_stages = stages;
      saveSyncState(state);
    }

    const anyError = stages.some((s) => s.ran && !s.ok);
    exitCode = anyError ? 1 : 0;
  } finally {
    // Release the sync lock BEFORE the dream cycle. Dream is a source-scoped
    // cycle that can run several minutes; holding the machine-wide lock that
    // long would freeze every other worktree's /sync-gbrain. Dream is guarded
    // by its own marker.
    cleanup();
  }

  // ── Dream (call-graph build) — LOCK-FREE, after the sync lock releases ─────
  let dreamStage: StageResult | null = null;
  if (args.mode === "dry-run") {
    // Preview only; never probes doctor or spawns. `--dry-run` and `--full` are
    // mutually exclusive modes (last one wins in parseArgs), so the only dream
    // preview that applies to a dry-run is the explicit --dream force.
    if (args.dream) {
      dreamStage = await runDream(args);
    }
  } else {
    // Resolve cycle state only on the --full auto path (perf: the steady-state
    // incremental sync never pays a doctor subprocess). Explicit --dream forces.
    let cycle: CycleStatus | null = null;
    if (!args.dream && args.mode === "full" && !args.noDream && !args.noCode) {
      const root = repoRoot();
      cycle = root ? cycleCompleted(deriveCodeSourceId(root), process.env) : "unknown";
    }
    if (shouldRunDream(args, cycle)) {
      dreamStage = await runDream(args);
      mergeDreamIntoState(dreamStage);
      if (dreamStage.ran && !dreamStage.ok) exitCode = 1;
    } else if (cycle === "unknown") {
      // --full wanted to auto-build but doctor couldn't confirm the graph state.
      // Surface a WARN-style SKIP so the user knows to run --dream if needed,
      // rather than silently doing nothing (a flaky doctor must not trigger a
      // surprise 35-min run — gbrain-doctor-overstrict).
      dreamStage = {
        name: "dream",
        ran: false,
        ok: true,
        duration_ms: 0,
        summary: "call-graph state unknown (doctor unavailable) — run /sync-gbrain --dream if code-callers returns 0",
      };
    }
  }

  if (!args.quiet || args.mode === "dry-run") {
    const allStages = dreamStage ? [...stages, dreamStage] : stages;
    console.log(`\ngstack-gbrain-sync (${args.mode}):`);
    for (const s of allStages) console.log(formatStage(s));
    const okCount = allStages.filter((s) => s.ok).length;
    const errCount = allStages.filter((s) => !s.ok && s.ran).length;
    console.log(`\n  ${okCount} ok, ${errCount} error, ${allStages.length - okCount - errCount} skipped`);
  }

  process.exit(exitCode);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`gstack-gbrain-sync fatal: ${err instanceof Error ? err.message : String(err)}`);
    releaseLock();
    process.exit(1);
  });
}
