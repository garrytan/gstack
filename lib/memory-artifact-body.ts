/** Longest artifact page body gstack-memory-ingest writes, in JS characters. */
export const ARTIFACT_BODY_MAX_CHARS = 200_000;

/**
 * An artifact page's body. A file within the cap is kept whole. Past it, a
 * markdown file keeps its start, and an append-only .jsonl log (timeline,
 * learnings, eureka) keeps its newest complete rows, so the page holds the
 * latest events and never ends in a cut row (#4362).
 */
export function artifactBody(path: string, raw: string, max = ARTIFACT_BODY_MAX_CHARS): string {
  if (raw.length <= max || !path.endsWith(".jsonl")) return raw.slice(0, max);
  const start = raw.length - max;
  if (raw[start - 1] === "\n") return raw.slice(start);
  const nextRow = raw.indexOf("\n", start);
  return nextRow === -1 || nextRow === raw.length - 1 ? raw.slice(0, max) : raw.slice(nextRow + 1);
}
