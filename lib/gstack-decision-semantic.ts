/**
 * gstack-decision-semantic — OPTIONAL gbrain enhancement for decision resurfacing.
 *
 * This is the ONLY decision module that touches gbrain. The reliable core
 * (lib/gstack-decision.ts) has zero gbrain imports and works with gbrain OFF; this
 * module is loaded lazily by `gstack-decision-search` only on `--semantic`, and every
 * path degrades to `null` (caller shows the reliable file results) when gbrain is
 * absent, unconfigured, times out, or returns nothing. It NEVER throws and NEVER
 * hangs beyond one shared 30s recall budget. We do not wire core function to this — gbrain is an
 * enhancement, never a dependency (the code-search lesson).
 *
 * Surface reality (verified against gbrain 0.42.x, not guessed):
 *  - `gbrain search "<q>"` prints TEXT lines `[score] slug -- snippet`, NOT JSON
 *    (so we parse the text surface; execGbrainJson would always null here).
 *  - The curated-memory source is the one whose local_path is the gstack brain
 *    worktree (`~/.gstack-brain-worktree`). Its id is derived from the artifacts
 *    remote when possible, then resolved from the source list as a fallback.
 *    Scoping search to it keeps code/doc corpora out.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { spawnGbrain } from "./gbrain-exec";
import { parseSourcesList } from "./gbrain-sources";

const TOTAL_TIMEOUT_MS = 30_000;
const BRAIN_WORKTREE_SUFFIX = ".gstack-brain-worktree";
const SOURCE_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export interface SemanticHit {
  score: number;
  sourceId: string;
  slug: string;
  snippet: string;
}

function normalizedSourceId(value: string): string | null {
  const normalized = value
    .toLowerCase()
    .replace(/\.git\/?$/, "")
    .split(/[\\/]/)
    .pop()!
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32)
    .replace(/-$/g, "");
  return SOURCE_ID_RE.test(normalized) ? normalized : null;
}

/**
 * Resolve the source id from the same local metadata written by the artifacts
 * setup path. This avoids a slow `gbrain sources list` on the guided router's
 * hot path while remaining fail-closed: the derived id is still passed through
 * `--source`, never used for an unscoped search.
 */
export function deriveMemorySourceId(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.GSTACK_BRAIN_SOURCE_ID?.trim();
  if (explicit) return normalizedSourceId(explicit);

  const home = env.HOME;
  if (!home) return null;
  const worktree = env.GSTACK_BRAIN_WORKTREE || join(home, BRAIN_WORKTREE_SUFFIX);
  if (!existsSync(worktree)) return null;

  for (const name of [".gstack-artifacts-remote.txt", ".gstack-brain-remote.txt"]) {
    try {
      const firstLine = readFileSync(join(home, name), "utf8").split(/\r?\n/, 1)[0]?.trim();
      if (firstLine) return normalizedSourceId(firstLine);
    } catch {
      // Missing/unreadable metadata falls through to the authoritative source list.
    }
  }
  return null;
}

/**
 * Resolve the curated-memory source id (the gstack brain worktree). Returns null
 * when gbrain is down/unparseable OR no worktree-backed source is registered.
 */
export function resolveMemorySourceId(
  env?: NodeJS.ProcessEnv,
  timeoutMs = TOTAL_TIMEOUT_MS,
): string | null {
  const derived = deriveMemorySourceId(env);
  if (derived) return derived;
  const r = spawnGbrain(["sources", "list", "--json"], { baseEnv: env, timeout: timeoutMs });
  if (r.status !== 0) return null;
  let rows;
  try {
    rows = parseSourcesList(JSON.parse(r.stdout || "null"));
  } catch {
    return null;
  }
  const atWorktree = rows.filter(
    (s) => typeof s.local_path === "string" && s.local_path.endsWith(BRAIN_WORKTREE_SUFFIX),
  );
  const pick = atWorktree.find((s) => s.id === "default") ?? atWorktree[0];
  return pick?.id ?? null;
}

/**
 * Parse gbrain search's text output into scored hits. Lines look like:
 *   `[0.4361] slug -- snippet text...`
 * Non-matching lines (banners, blanks) are skipped. Exported for deterministic
 * unit testing of the parser without a live gbrain.
 */
export function parseSearchHits(
  stdout: string,
  minScore: number,
  limit: number,
  sourceId = "unknown",
): SemanticHit[] {
  const hits: SemanticHit[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\[([\d.]+)\]\s+(\S+)\s+--\s+(.*)$/);
    if (!m) continue;
    const score = parseFloat(m[1]);
    if (!Number.isFinite(score) || score < minScore) continue;
    hits.push({ score, sourceId, slug: m[2], snippet: m[3].trim() });
  }
  return hits.slice(0, limit);
}

/**
 * Semantic recall over the curated-memory source. Returns parsed hits, or `null`
 * when gbrain is unavailable / errors (caller MUST degrade to the reliable file
 * results on null). An empty array means gbrain ran but found nothing relevant
 * (e.g. memory not synced yet) — also honest, distinct from null. Never throws,
 * never hangs.
 */
export function semanticRecall(
  query: string,
  env?: NodeJS.ProcessEnv,
  minScore = 0.1,
  limit = 3,
  totalTimeoutMs = TOTAL_TIMEOUT_MS,
): SemanticHit[] | null {
  if (!query.trim()) return null;
  const startedAt = Date.now();
  // Require the curated-memory source. If it's absent (gbrain down OR no worktree-backed
  // source), degrade to null rather than searching UNSCOPED — an unscoped search pulls
  // code/doc corpora that would be mislabeled as "related decisions" (Codex finding).
  const sourceId = resolveMemorySourceId(env, Math.min(10_000, Math.ceil(totalTimeoutMs / 3)));
  if (!sourceId) return null;
  const remainingMs = totalTimeoutMs - (Date.now() - startedAt);
  if (remainingMs <= 0) return null;
  const r = spawnGbrain([
    "search", query,
    "--source", sourceId,
    "--limit", String(limit),
    "--snippet-chars", "100",
  ], { baseEnv: env, timeout: remainingMs });
  if (r.status !== 0) return null; // gbrain down / not on PATH / errored → degrade
  return parseSearchHits(r.stdout || "", minScore, limit, sourceId);
}
