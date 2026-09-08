import { describe, expect, test } from 'bun:test';
import {
  CACHE_READ_WRITE_SKETCH,
  CEO_SECTION_CACHE_PLAN,
  hasStaleFillRaceFinding,
} from './helpers/ceo-section-loading-fixture';

describe('CEO section-loading cache fixture', () => {
  test('the exact proposed wrapper retains a reproducible stale-fill race', async () => {
    let releaseRead!: (value: string) => void;
    let stored = 'old';
    const cache = new Map<string, string>();
    const repository = {
      read: () => new Promise<string>((resolve) => { releaseRead = resolve; }),
      write: async (_key: string, value: string) => { stored = value; return value; },
    };
    // Execute the same sketch the live reviewer receives, not a second model
    // of its ordering. Holding the old read exposes the intended interleaving.
    const { readProfile, writeProfile } = new Function('cache', 'repository',
      CACHE_READ_WRITE_SKETCH + '\nreturn { readProfile, writeProfile };')(cache, repository);
    const pending = readProfile('tenant:profile');
    await writeProfile('tenant:profile', 'new');
    releaseRead('old');
    const earlierResult = await pending;
    expect(stored).toBe('new');
    // Returning the earlier snapshot to the already-pending caller is
    // explicitly permitted. Reusing it for this new reader is the defect.
    expect(earlierResult).toBe('old');
    expect(CEO_SECTION_CACHE_PLAN).toContain('Every read begun after that write completes must');
    expect(await readProfile('tenant:profile')).toBe('old');
    expect(CEO_SECTION_CACHE_PLAN).toContain(CACHE_READ_WRITE_SKETCH);
    expect(hasStaleFillRaceFinding(CEO_SECTION_CACHE_PLAN)).toBe(false);
  });

  test.each([
    // Actual finding in the unchanged fixture's successful 38 KB live report.
    '**Missing: What happens to in-flight requests during invalidation?** If a write invalidates a key and 10 requests are simultaneously loading it (cache miss, in-flight DB fetch), all 10 will cache the same value after the invalidation. The invalidated key may get re-populated with a stale value if any of those fetches started before the write. No mention of this race.',
    'P1: An in-flight read can repopulate stale data after a committed write invalidates the key. Guard fills with a generation token.',
    '| Cache fill race | An older value fetched before the write is inserted after eviction, so the next read is stale. | Add a per-key epoch. |',
    '**Invalidation race:** the pending fetch stores an outdated snapshot after cache.delete. Serialize the fill with mutation.',
  ])('recognizes the actual ordering defect: %s', (report) => {
    expect(hasStaleFillRaceFinding(report)).toBe(true);
  });

  test.each([
    'The full review is complete. No issues found.',
    'A stale value expires after 30 seconds. The LRU byte cap is adequate.',
    'If invalidation throws after a write, the cache retains stale data. Log the failure and bypass the cache.',
    'Read and write concurrency is covered. No stale data can be returned.',
    '| Reads | Coalesced concurrent misses |\n| Writes | Invalidation failure leaves stale data |',
    '```javascript\n// An in-flight read can cache stale data after invalidation.\n```',
    '> An in-flight read can cache stale data after invalidation.',
  ])('rejects completion, unrelated text, and quoted source: %s', (report) => {
    expect(hasStaleFillRaceFinding(report)).toBe(false);
  });
});


const CAPTURED_ACCEPTED_RACE_REPORT = `**Shadow paths:**
1. Nil key: Programming error — caught by auth/key-validation before wrapper.
2. Empty key: Same — upstream validation gate.
3. Upstream error: Single-flight releases all waiters with the error. Cache
   not populated. Next request retries DB. Correct.
4. Concurrent write during read in-flight: The plan documents this explicitly.
   The stale read is an accepted invariant, bounded by 30s TTL.

**Async ordering — critical race:**
\`\`\`
  1. Request A: cache.get(key) → miss → enters single-flight
  2. Request B: cache.get(key) → miss → joins single-flight (awaiting)
  3. fn: repository.read(key) → suspend (await)
  4. Write commits → cache.delete(key) [nothing to delete — key not set yet]
  5. repository.read(key) returns OLD snapshot (pre-write)
  6. cache.set(key, OLD_VALUE) ← stale value in cache for up to 30s
  7. Requests A and B both return OLD_VALUE ← accepted by plan
\`\`\`

This is the one documented asymmetry. It is not a gap — it is a named invariant.
The TTL bounds the stale window to 30 seconds.

`;


describe('CEO concurrency finding requires a violation, not an accepted trace', () => {
  test('rejects the captured accepted-invariant report that passed the old keyword oracle', () => {
    expect(hasStaleFillRaceFinding(CAPTURED_ACCEPTED_RACE_REPORT)).toBe(false);
  });

  test.each([
    'An in-flight fetch can refill the cache with old data after a write invalidates it. The next read sees that stale snapshot, violating the post-write contract.',
    'The pending read stores an older value after invalidation.\n\nGuard cache fills with a version check so a later request cannot observe pre-write state.',
    'Returning the old snapshot to the pending caller is permitted. But a late cache.set after concurrent write invalidation exposes stale data to a new reader. Serialize mutation and cache fills.',
    'Returning an old snapshot to the original pending caller is an accepted invariant. But an in-flight read can repopulate stale cache data after write invalidation, so a new reader violates the post-write contract. Guard cache fills with a generation token.',
    'The original caller may receive the old snapshot; that return is permitted. However, a pending fetch refills stale data after write invalidation, breaking consistency for a later reader. Skip the cache fill when its version changed.',
    'An in-flight read can repopulate stale data after write invalidation, so a new reader gets the old value. This is not permitted by the contract. Guard cache fills with a version check.',
    '| Late cache fill | A concurrent read repopulates an outdated result after eviction. | Reject the fill when its generation token changed. |',
  ])('accepts the later-reader consequence or a concrete ordering remedy: %s', report => {
    expect(hasStaleFillRaceFinding(report)).toBe(true);
  });

  test.each([
    'An in-flight read repopulates stale data after write invalidation. This is an accepted invariant bounded by the TTL.',
    'An in-flight read repopulates stale data after write invalidation. This is permitted by the contract; a later read may be stale for 30 seconds.',
    'An in-flight read refills stale data after write invalidation. This is allowed behavior for the next read because the TTL bounds it.',
    'The original caller and the new reader may both observe the old snapshot as an accepted invariant. A pending read refills stale data after write invalidation; no guard is required.',
    'An in-flight read repopulates stale data after write invalidation.\n\nIt is not a gap. No change is needed.',
    'No race: a pending read cannot repopulate stale cache data after write invalidation; the existing version check rejects it.',
    'An in-flight read repopulates stale data after write invalidation, but does not violate the contract. No guard is required.',
    '1. Cache population after a miss is safe.\n2. Concurrent writes can return an older snapshot to their original pending reader.\n3. Guard unrelated network retries.',
    'An in-flight read stores stale data after write invalidation.\n\n**Finding S9:** Guard telemetry delivery with a version token.',
    'An in-flight read stores stale data after write invalidation.\n\nGuard unrelated telemetry delivery with a version token.',
    '1. An in-flight read repopulates stale data after write invalidation.\n2. Telemetry retry handling has a bug.',
    'An in-flight read repopulates stale data after write invalidation.\n\n#2 — Unrelated telemetry delivery bug',
    '* An in-flight read repopulates stale data after write invalidation.\n* Telemetry retry handling has a bug.',
    '> P1: An in-flight read refills stale data after invalidation; a new read gets the old value.',
    '```text\nP1: An in-flight read refills stale data after invalidation; a new read gets the old value.\n```',
  ])('rejects dismissals, negations, unrelated findings and quoted examples: %s', report => {
    expect(hasStaleFillRaceFinding(report)).toBe(false);
  });
});


describe('proposed cache-fill prevention remains an unresolved finding', () => {
  test('an imperative remedy describes the behavior it must prevent', () => {
    expect(hasStaleFillRaceFinding('An in-flight read repopulates stale data after write invalidation. Guard cache fills so pending reads cannot repopulate stale values after invalidation.')).toBe(true);
  });

  test('an existing guard remains a dismissal, not a proposed fix', () => {
    expect(hasStaleFillRaceFinding('An in-flight read cannot repopulate stale data after write invalidation because the existing guard rejects that fill. No race remains.')).toBe(false);
  });

  test('an imperative does not erase a separate explicit dismissal', () => {
    expect(hasStaleFillRaceFinding('An in-flight read repopulates stale data after write invalidation. Guard cache fills so pending reads cannot repopulate stale values after invalidation. This is not a bug; no fix is needed.')).toBe(false);
  });
});
