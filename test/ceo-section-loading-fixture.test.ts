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
    await pending;
    expect(stored).toBe('new');
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
