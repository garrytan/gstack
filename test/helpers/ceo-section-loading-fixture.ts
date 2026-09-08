/**
 * Section loading needs a complete, bounded plan, not a finding-count fixture.
 * The former two-bullet plan made a successful review invent key isolation,
 * error, concurrency, observability, rollout, and test contracts in a 38 KB
 * report. Those surrounding contracts are explicit here; the read/write sketch
 * still permits an old in-flight read to refill a key after write invalidation.
 */
export const CACHE_READ_WRITE_SKETCH = `async function readProfile(key) {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const value = await repository.read(key);
  cache.set(key, value);
  return value;
}

async function writeProfile(key, update) {
  const saved = await repository.write(key, update);
  cache.delete(key);
  return saved;
}`;

export const CEO_SECTION_CACHE_PLAN = `# Plan: cache profile summaries in one process

## Measured problem and accepted scope
The existing profile-summary service has one active process. A one-week trace
shows repeated reads of about 900 hot keys: DB CPU is 70%, with read p95 120 ms.
Add a process-local LRU wrapper to the existing repository. Acceptance targets
are at least 60% cache hits, DB CPU below 50%, and read p95 below 60 ms, with the
existing error-rate and correctness SLOs unchanged. This is an internal backend
change with no UI, API, schema, pricing, or developer onboarding change.

## Existing contracts retained
- All reads and writes use this repository in the same process; there are no
  external DB writers. Multi-process operation remains unsupported and startup
  rejects that configuration while caching is enabled.
- Authentication and authorization run before repository access. Keys encode
  the authenticated tenant ID and validated profile ID without ambiguity.
  Values are immutable profile-summary DTOs; secrets and cache keys are never
  logged. Cached results cannot bypass authorization.
- The existing LRU adapter supports 1000 entries, a 16 MiB byte cap, and a
  30-second TTL. Recorded hot data fits those limits. Absent records use a
  distinct sentinel with a 10-second TTL; undefined means a cache miss.
- Cache operations are synchronous and atomic in the single JS event loop.
  On any cache failure the existing adapter bypasses the cache until an empty
  cache is reinitialized; repository errors keep the current typed API error
  mapping. The existing per-key
  single-flight wrapper coalesces simultaneous misses and releases on failure.
- A read already in progress when a write commits may return its earlier DB
  snapshot to that caller. Every read begun after that write completes must
  observe the committed version. TTL expiry is not a substitute for this rule.

## Proposed wrapper integration
Keep the current read-through repository interface and shared adapters. These
are the complete new read/write ordering rules; no additional version checks or
coordination between a cache fill and a write are proposed:

\`\`\`javascript
${CACHE_READ_WRITE_SKETCH}
\`\`\`

## Verification and rollout
Existing repository contract tests cover tenant isolation, key validation,
absence, DB failures, and authorization. New wrapper tests cover hit/miss,
eviction and byte limits, TTL, adapter-failure fallback, successful-write
invalidation, failed-write preservation, and concurrent-miss coalescing.
The rollout uses the existing runtime feature flag: enable for 10% of keys,
then 50%, then all keys after one healthy hour at each stage. Monitor hit/miss,
eviction, cache bytes, fallback errors, DB CPU, and read p95 without raw IDs.
On error-rate or latency regression, disable the flag immediately; both reads
and writes bypass the cache while disabled, and enabling creates an empty cache.
Cold starts remain within the existing DB capacity. The service owner monitors
the rollout and records the results against the acceptance targets.

## Out of scope
Distributed caching, cross-process coherence, prewarming, changing consistency
semantics, or adding new product surfaces. The repository interface preserves a
future replacement path without introducing a general cache framework now.
`;

/** Recognize the seeded concurrency finding across ordinary report wording. */
export function hasStaleFillRaceFinding(report: string): boolean {
  // Ignore quoted source: a copied plan or code sketch is not a finding.
  const prose = report.replace(/```[\s\S]*?```/g, '').replace(/^\s*>.*$/gm, '');
  const blocks = prose.split(/\n\s*\n|\n(?=\s*\|)/);
  return blocks.some((block) => {
    const text = block.replace(/[*_`]/g, '').replace(/\s+/g, ' ')
      .replace(/\bno\s+(?:stale|outdated)\b[^.!?]*(?:[.!?]|$)/gi, '');
    return /\b(?:stale|outdated)\b|\bold(?:er)?\s+(?:value|data|result|version)\b/i.test(text)
      && /\b(?:race|racing|concurrent|concurrency|in[- ]flight|pending)\b/i.test(text)
      && /\b(?:read|fetch|fill|refill|repopulat|insert|store|set)\w*\b/i.test(text)
      && /\b(?:invalidat|evict|write|commit)\w*\b/i.test(text);
  });
}
