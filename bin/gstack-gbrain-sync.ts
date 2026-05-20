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
import { ensureSourceRegistered, sourcePageCount } from "../lib/gbrain-sources";
import { localEngineStatus, type LocalEngineStatus } from "../lib/gbrain-local-status";
import { buildGbrainEnv, spawnGbrain, execGbrainJson } from "../lib/gbrain-exec";

// ── Types ──────────────────────────────────────────────────────────────────

type Mode = "incremental" | "full" | "dry-run";

interface CliArgs {
  mode: Mode;
  quiet: boolean;
  noCode: boolean;
  noMemory: boolean;
  noBrainSync: boolean;
  codeOnly: boolean;
}

interface CodeStageDetail {
  source_id?: string;
  source_path?: string;
  page_count?: number | null;
  last_imported?: string;
  status?: "ok" | "skipped" | "failed";
}

interface StageResult {
  name: string;
  ran: boolean;
  ok: boolean;
  duration_ms: number;
  summary: string;
  /** Stage-specific structured detail. Code stage carries source_id + page_count. */
  detail?: CodeStageDetail;
}

// ── Constants ──────────────────────────────────────────────────────────────

const HOME = homedir();
const GSTACK_HOME = process.env.GSTACK_HOME || join(HOME, ".gstack");
const STATE_PATH = join(GSTACK_HOME, ".gbrain-sync-state.json");
const LOCK_PATH = join(GSTACK_HOME, ".sync-gbrain.lock");
const STALE_LOCK_MS = 5 * 60 * 1000;

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
  --help               This text.

Stages run in order: code → memory ingest → curated git push.
Each stage failure is non-fatal; subsequent stages still run.
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
      case "--code-only":
        codeOnly = true;
        noMemory = true;
        noBrainSync = true;
        break;
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

  return { mode, quiet, noCode, noMemory, noBrainSync, codeOnly };
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
  const list: Array<{ id?: string; local_path?: string }> = Array.isArray(raw)
    ? (raw as Array<{ id?: string; local_path?: string }>)
    : ((raw as { sources?: Array<{ id?: string; local_path?: string }> }).sources ?? []);
  const found = list.find((s) => s.id === sourceId);
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

/**
 * Remove an orphaned source. Called only after new-source sync verifies pages
 * exist, so the old source is provably redundant before deletion.
 *
 * Flag note: existing call sites used `--confirm-destructive` here and
 * `--yes` in `lib/gbrain-sources.ts` — gbrain 0.35.0.0 accepts neither
 * deterministically (the subcommand surface help is generic). We pass
 * `--confirm-destructive` to match the existing call site convention; the
 * flag-helper centralization in commit 4 (lib/gbrain-exec.ts) will resolve
 * the inconsistency across the codebase.
 */
export function removeOrphanedSource(oldId: string, env?: NodeJS.ProcessEnv): boolean {
  const r = spawnGbrain(["sources", "remove", oldId, "--confirm-destructive"], { baseEnv: env });
  return r.status === 0;
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
 */
function skipStageForLocalStatus(
  stage: "code" | "memory",
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
  if (localStatus !== "ok") {
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
    const rm = spawnGbrain(["sources", "remove", legacyId, "--confirm-destructive"], {
      timeout: 30_000,
      baseEnv: gbrainEnv,
    });
    // Treat absent-source as success (clean state). gbrain emits "not found" on
    // missing id; treat any non-zero exit without "not found" as a soft fail.
    if (rm.status === 0) legacyRemoved = true;
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

  // Step 2: Run sync or reindex.
  const syncArgs = args.mode === "full"
    ? ["reindex-code", "--source", sourceId, "--yes"]
    : ["sync", "--strategy", "code", "--source", sourceId];

  const syncResult = spawnGbrain(syncArgs, {
    stdio: args.quiet ? ["ignore", "ignore", "ignore"] : ["ignore", "inherit", "inherit"],
    timeout: 35 * 60 * 1000,
    baseEnv: gbrainEnv,
  });

  if (syncResult.status !== 0) {
    return {
      name: "code",
      ran: true,
      ok: false,
      duration_ms: Date.now() - t0,
      summary: `gbrain ${syncArgs.join(" ")} exited ${syncResult.status}`,
      detail: { source_id: sourceId, source_path: root, status: "failed" },
    };
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
  if (localStatus !== "ok") {
    return skipStageForLocalStatus("memory", localStatus, t0);
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
  const result = spawnSync("bun", ingestArgs, {
    encoding: "utf-8",
    timeout: 35 * 60 * 1000,
    env: buildGbrainEnv({ announce: false }),
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

  spawnSync(brainSyncPath, ["--discover-new"], {
    stdio: args.quiet ? ["ignore", "ignore", "ignore"] : ["ignore", "inherit", "inherit"],
    timeout: 60 * 1000,
  });
  const result = spawnSync(brainSyncPath, ["--once"], {
    stdio: args.quiet ? ["ignore", "ignore", "ignore"] : ["ignore", "inherit", "inherit"],
    timeout: 60 * 1000,
  });

  return {
    name: "brain-sync",
    ran: true,
    ok: result.status === 0,
    duration_ms: Date.now() - t0,
    summary: result.status === 0 ? "curated artifacts pushed" : `gstack-brain-sync exited ${result.status}`,
  };
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

// ── Output ─────────────────────────────────────────────────────────────────

function formatStage(s: StageResult): string {
  const status = !s.ran ? "SKIP" : s.ok ? "OK" : "ERR";
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
  try {
    const state = loadSyncState();
    const stages: StageResult[] = [];

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

    if (!args.quiet || args.mode === "dry-run") {
      console.log(`\ngstack-gbrain-sync (${args.mode}):`);
      for (const s of stages) console.log(formatStage(s));
      const okCount = stages.filter((s) => s.ok).length;
      const errCount = stages.filter((s) => !s.ok && s.ran).length;
      console.log(`\n  ${okCount} ok, ${errCount} error, ${stages.length - okCount - errCount} skipped`);
    }

    const anyError = stages.some((s) => s.ran && !s.ok);
    exitCode = anyError ? 1 : 0;
  } finally {
    cleanup();
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
