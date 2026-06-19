/**
 * gstack-decision-semantic — OPTIONAL gbrain enhancement for decision resurfacing.
 *
 * This is the ONLY decision module that touches gbrain. The reliable core
 * (lib/gstack-decision.ts) has zero gbrain imports and works with gbrain OFF; this
 * module is loaded lazily by `gstack-decision-search` only on `--semantic`, and every
 * path degrades to `null` (caller shows the reliable file results) when gbrain is
 * absent, unconfigured, times out, or returns nothing. It NEVER throws and NEVER
 * hangs (10s spawn timeout). We do not wire core function to this — gbrain is an
 * enhancement, never a dependency (the code-search lesson).
 *
 * Surface reality (verified against gbrain 0.42.x, not guessed):
 *  - `gbrain search "<q>"` prints TEXT lines `[score] slug -- snippet`, NOT JSON
 *    (so we parse the text surface; execGbrainJson would always null here).
 *  - The curated-memory source is the one whose local_path is the gstack brain
 *    worktree (`~/.gstack-brain-worktree`), id `default` by convention — NOT a
 *    `gstack-brain-<user>` id. Scoping search to it keeps code/doc corpora out.
 */

import { spawnGbrain } from "./gbrain-exec";
import { parseSourcesList } from "./gbrain-sources";

const TIMEOUT_MS = 10_000;
const BRAIN_WORKTREE_SUFFIX = ".gstack-brain-worktree";

export interface SemanticHit {
  score: number;
  slug: string;
  snippet: string;
}

/**
 * Resolve the curated-memory source id (the gstack brain worktree). Returns null
 * when gbrain is down/unparseable OR no worktree-backed source is registered — the
 * caller then searches unscoped (best-effort) rather than failing.
 */
export function resolveMemorySourceId(env?: NodeJS.ProcessEnv): string | null {
  const r = spawnGbrain(["sources", "list", "--json"], { baseEnv: env, timeout: TIMEOUT_MS });
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
export function parseSearchHits(stdout: string, minScore: number, limit: number): SemanticHit[] {
  const hits: SemanticHit[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\[([\d.]+)\]\s+(\S+)\s+--\s+(.*)$/);
    if (!m) continue;
    const score = parseFloat(m[1]);
    if (!Number.isFinite(score) || score < minScore) continue;
    hits.push({ score, slug: m[2], snippet: m[3].trim() });
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
): SemanticHit[] | null {
  if (!query.trim()) return null;
  // Require the curated-memory source. If it's absent (gbrain down OR no worktree-backed
  // source), degrade to null rather than searching UNSCOPED — an unscoped search pulls
  // code/doc corpora that would be mislabeled as "related decisions" (Codex finding).
  const sourceId = resolveMemorySourceId(env);
  if (!sourceId) return null;
  const r = spawnGbrain(["search", query, "--source", sourceId], { baseEnv: env, timeout: TIMEOUT_MS });
  if (r.status !== 0) return null; // gbrain down / not on PATH / errored → degrade
  return parseSearchHits(r.stdout || "", minScore, limit);
}
