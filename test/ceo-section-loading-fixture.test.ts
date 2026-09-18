import lifetimeFixture from './fixtures/ceo-fill-lifetime.json';
import { describe, expect, test } from 'bun:test';
import {
  CACHE_READ_WRITE_SKETCH,
  CEO_SECTION_CACHE_PLAN,
  hasStaleFillRaceFinding,
} from './helpers/ceo-section-loading-fixture';

describe('future-reader vocabulary in the actual AA finding', () => {
  const report = require('node:fs').readFileSync(require('node:path').join(import.meta.dir, 'fixtures/ceo-section-aa-report.md'), 'utf8');
  const paragraph = report.slice(report.indexOf('**S4-1 (CRITICAL'), report.indexOf('\n\nNo UI scope.', report.indexOf('**S4-1 (CRITICAL')));

  test('recognizes the exact complete report and its same-paragraph post-write consequence', () => {
    expect(paragraph).toContain('A read in-flight when a write');
    expect(paragraph).toContain('stale snapshot after `cache.delete` fires');
    expect(paragraph).toContain('future callers with stale data');
    expect(hasStaleFillRaceFinding(paragraph)).toBe(true);
    expect(hasStaleFillRaceFinding(report)).toBe(true);
    expect(hasStaleFillRaceFinding(paragraph.replace('future callers', 'subsequent callers'))).toBe(true);
  });

  test.each(['future reads', 'future requests', 'future callers'])('recognizes a later consumer: %s', reader => {
    expect(hasStaleFillRaceFinding(`An in-flight read inserts a stale snapshot after write invalidation, leaving ${reader} with stale data.`)).toBe(true);
  });

  test.each([
    'An in-flight read inserts a stale snapshot after write invalidation. Future work documents the cache.',
    'An in-flight read inserts a fresh snapshot after write invalidation, leaving future callers with fresh data.',
    'An in-flight read inserts a stale snapshot before write invalidation, leaving future callers with stale data.',
    'A completed read inserts a stale snapshot after write invalidation, leaving future callers with stale data.',
    'An in-flight read returns a stale snapshot after write invalidation to its original pending caller.',
    'An in-flight read inserts a stale snapshot after write invalidation. Future callers seeing stale data is allowed behavior.',
    'An in-flight read inserts a stale snapshot after write invalidation, leaving future callers with stale data. This is the accepted consistency model.',
    'An in-flight read cannot refill stale data after write invalidation. Future callers observe committed data.',
    'An in-flight read inserts a stale snapshot after write invalidation, leaving future callers with stale data. This is not a bug; no guard is required.',
    '> An in-flight read inserts a stale snapshot after write invalidation, leaving future callers with stale data.',
    '```text\nAn in-flight read inserts a stale snapshot after write invalidation, leaving future callers with stale data.\n```',
    'An in-flight read inserts a stale snapshot after write invalidation.\n\n## A different section\nFuture callers need documentation.',
    '* An in-flight read inserts a stale snapshot after write invalidation.\n* Future callers need documentation.',
  ])('retains ordering, stale-value, source and dismissal boundaries: %s', text => {
    expect(hasStaleFillRaceFinding(text)).toBe(false);
  });

  test('the original-caller exception cannot permit the same stale value for future callers', () => {
    expect(hasStaleFillRaceFinding('An in-flight read refills stale data after write invalidation, so new reads see old data. The original pending caller may receive an old snapshot and future callers observe it; this is permitted. Guard cache fills with a generation token.')).toBe(false);
    expect(hasStaleFillRaceFinding('The original pending caller may receive an old snapshot; that return is permitted. However, an in-flight read refills stale data after write invalidation, so future callers violate the contract. Guard cache fills with a generation token.')).toBe(true);
  });
});

describe('restore vocabulary in the actual Y finding', () => {
  const report = require('node:fs').readFileSync(require('node:path').join(import.meta.dir, 'fixtures/ceo-section-y-report.md'), 'utf8');
  const amendment = report.slice(report.indexOf('**AMENDMENT (Finding 1'), report.indexOf('```javascript')).trim();

  test('recognizes the delivered report and its explicit original-invariant failure', () => {
    expect(amendment).toContain('original pseudocode did not satisfy');
    expect(amendment).toContain('in-flight read from restoring a stale cache entry');
    expect(hasStaleFillRaceFinding(amendment)).toBe(true);
    expect(hasStaleFillRaceFinding(report)).toBe(true);
  });

  test.each(['can restore', 'restores', 'restored', 'is restoring'])('recognizes the cache-fill verb %s', verb => {
    expect(hasStaleFillRaceFinding(`An in-flight read ${verb} stale data after write invalidation. A subsequent read sees the old value, violating the contract.`)).toBe(true);
  });

  test.each(['cannot restore', "can't restore", 'never restores', 'does not restore', "doesn't restore", 'will not restore', "won't restore", 'did not restore', "didn't restore", 'is not restoring', "isn't restoring", 'was not restoring', 'has not restored', "hasn't restored", 'had not restored'])('rejects a current prevention assertion: %s', denied => {
    expect(hasStaleFillRaceFinding(`An in-flight read ${denied} stale data after write invalidation. A subsequent read observes the committed value.`)).toBe(false);
  });

  test.each([
    'An in-flight read restores stale data after write invalidation. This is not a defect; no guard is required.',
    'An in-flight read restores stale data after write invalidation. Subsequent stale reads are permitted by the contract.',
    'An in-flight read restores stale data after write invalidation. This is the accepted consistency model.',
    'An in-flight read restores the committed new value after write invalidation. A subsequent read observes it.',
    'The original pending caller receives an old snapshot after the write; that return is permitted.',
    'If deletion throws after a write, a restore operation leaves stale cache data. Log and bypass the adapter.',
    '> An in-flight read restores stale data after write invalidation; a subsequent read violates the contract.',
    '```text\nAn in-flight read restores stale data after write invalidation; a subsequent read violates the contract.\n```',
    '* An in-flight read restores stale data after write invalidation.\n* Telemetry has a bug.',
  ])('preserves dismissal, source and separate-finding boundaries: %s', text => {
    expect(hasStaleFillRaceFinding(text)).toBe(false);
  });
});

describe('pre-write snapshot vocabulary in the actual U finding', () => {
  const report = require('node:fs').readFileSync(require('node:path').join(import.meta.dir, 'fixtures/ceo-section-u-report.md'), 'utf8');
  const paragraph = report.slice(report.indexOf('After T4 the cache correctly reflects'), report.indexOf('**Recommended fix (auto-decided):**')).trim();

  test('recognizes the exact delivered report and its complete asserted paragraph independently of the bad remedy', () => {
    expect(paragraph).toContain('re-populates the cache with the pre-write snapshot');
    expect(paragraph).toContain('This violates the invariant:');
    expect(hasStaleFillRaceFinding(paragraph)).toBe(true);
    expect(hasStaleFillRaceFinding(report)).toBe(true);
  });

  test.each(['pre-write snapshot', 'pre write snapshot', 'pre-write value', 'pre-write data', 'pre-write version'])('recognizes an old snapshot synonym: %s', value => {
    expect(hasStaleFillRaceFinding(`An in-flight read re-populates the cache with the ${value} after write invalidation. A new reader sees it, violating the contract.`)).toBe(true);
  });

  test.each([
    'A pending read returns the pre-write snapshot to its original caller; that return is permitted.',
    'An in-flight read re-populates the cache with the post-write snapshot after invalidation.',
    'The pre-write snapshot expires after 30 seconds. The LRU byte cap is adequate.',
    'If invalidation throws after a write, the cache retains the pre-write snapshot. Log the failure and bypass the cache.',
    'An in-flight read re-populates the cache with the pre-write snapshot after invalidation. This is allowed behavior for subsequent reads.',
    'An in-flight read re-populates the cache with the pre-write snapshot after invalidation. This is the accepted consistency model.',
    'An in-flight read re-populates the cache with the pre-write snapshot after invalidation, so a new reader receives that version. This is the accepted consistency model.',
    'An in-flight read re-populates the cache with the pre-write snapshot after invalidation. It is not a bug; no guard is required.',
    'An in-flight read cannot re-populate the cache with the pre-write snapshot after invalidation. No race remains.',
    '> An in-flight read re-populates the pre-write snapshot after write invalidation; a new read sees it, violating the contract.',
    '```text\nAn in-flight read re-populates the pre-write snapshot after write invalidation; a new read sees it, violating the contract.\n```',
    '* An in-flight read re-populates the pre-write snapshot after invalidation.\n* Telemetry retry handling has a bug.',
  ])('retains original-caller, freshness, dismissal and source boundaries: %s', value => {
    expect(hasStaleFillRaceFinding(value)).toBe(false);
  });

  test('permission for the original caller still cannot excuse a later-reader violation', () => {
    expect(hasStaleFillRaceFinding('The original pending caller may receive the pre-write snapshot; that return is permitted. However, an in-flight read refills the cache with the pre-write snapshot after write invalidation, so a new reader violates the contract. Guard cache fills with a generation token.')).toBe(true);
  });
});

describe('CEO section-loading cache fixture', () => {
  test.each([
    { retires: false, rejects: false },
    { retires: true, rejects: false },
    { retires: true, rejects: true },
  ])('cohort admission is distinct from the actual wrapper fill: %j', async ({ retires, rejects }) => {
    const pending: Array<{ value: string; finish: () => void }> = [];
    const flights = new Map<string, Promise<string>>();
    let stored = 'old';
    const failure = new Error('rolled back');
    const repository = {
      read(key: string) {
        if (flights.has(key)) return flights.get(key)!;
        const value = stored;
        let finish!: () => void;
        const flight = new Promise<string>(resolve => { finish = () => resolve(value); })
          .finally(() => { if (flights.get(key) === flight) flights.delete(key); });
        pending.push({ value, finish }); flights.set(key, flight);
        return flight;
      },
      async write(key: string, value: string) {
        if (rejects) throw failure;
        stored = value;
        if (retires) flights.delete(key);
        return value;
      },
    };
    const cache = new Map<string, string>();
    const { readProfile, writeProfile } = new Function('cache', 'repository',
      CACHE_READ_WRITE_SKETCH + '\nreturn { readProfile, writeProfile };')(cache, repository);
    const earlier = readProfile('tenant:profile');
    if (rejects) await expect(writeProfile('tenant:profile', 'new')).rejects.toBe(failure);
    else await writeProfile('tenant:profile', 'new');
    const later = readProfile('tenant:profile');
    expect(pending).toHaveLength(retires && !rejects ? 2 : 1);
    if (retires && !rejects) {
      pending[1]!.finish();
      expect(await later).toBe('new');
    }
    pending[0]!.finish();
    expect(await earlier).toBe('old');
    if (!retires || rejects) expect(await later).toBe('old');
    // Even correct repository admission cannot stop this exact new sketch
    // from caching its older result after the committed write. Keep that gap.
    expect(await readProfile('tenant:profile')).toBe('old');
    expect(stored).toBe(rejects ? 'old' : 'new');
    expect(CEO_SECTION_CACHE_PLAN).toContain('single-flight wrapper sits inside\n  repository.read');
    expect(CEO_SECTION_CACHE_PLAN).toContain('A committed repository.write retires');
    expect(CEO_SECTION_CACHE_PLAN).toContain('This admission rule does not inspect cache fills');
    expect(CEO_SECTION_CACHE_PLAN).toContain(CACHE_READ_WRITE_SKETCH);
    expect(hasStaleFillRaceFinding(CEO_SECTION_CACHE_PLAN)).toBe(false);
  });

  test('author bounds implementation depth without preapproving the wrapper or weakening required proof', () => {
    expect(CEO_SECTION_CACHE_PLAN).toContain('wrapper itself remains unapproved');
    expect(CEO_SECTION_CACHE_PLAN).toContain('actual\ncontradiction or missing proof must be reported and resolved');
    expect(CEO_SECTION_CACHE_PLAN).toContain('exact data\nstructures, full function bodies and executable test code belong to subsequent\nengineering planning');
    expect(CEO_SECTION_CACHE_PLAN).toContain('not tests already\nimplemented or passing');
    expect(CEO_SECTION_CACHE_PLAN).toContain('Preserve all 11 review outcomes');
    expect(CEO_SECTION_CACHE_PLAN).toContain('full GSTACK REVIEW REPORT');
  });

  test('declared absence decoding and atomic write failure do not add independent wrapper defects', async () => {
    const missing = Object.freeze({ found: false });
    const absent = Symbol('adapter-private absence');
    const stored = new Map<string, unknown>();
    const cache = {
      get: (key: string) => stored.get(key) === absent ? missing : stored.get(key),
      set: (key: string, value: unknown) => stored.set(key, value === missing ? absent : value),
      delete: (key: string) => stored.delete(key),
    };
    const rejected = new Error('atomic write rejected before commit');
    let reads = 0;
    const repository = {
      read: async () => { reads++; return missing; },
      write: async () => { throw rejected; },
    };
    const { readProfile, writeProfile } = new Function('cache', 'repository',
      CACHE_READ_WRITE_SKETCH + '\nreturn { readProfile, writeProfile };')(cache, repository);
    expect(await readProfile('tenant:missing')).toBe(missing);
    expect(stored.get('tenant:missing')).toBe(absent);
    expect(await readProfile('tenant:missing')).toBe(missing);
    expect(reads).toBe(1);
    await expect(writeProfile('tenant:missing', { found: true })).rejects.toBe(rejected);
    expect(await readProfile('tenant:missing')).toBe(missing);
    expect(reads).toBe(1);
    expect(CEO_SECTION_CACHE_PLAN).toContain('every\n  rejected promise guarantees no commit');
    expect(CEO_SECTION_CACHE_PLAN).toContain('cache.get decodes it back to the same absent-result DTO');
    expect(CEO_SECTION_CACHE_PLAN).toContain('cannot fill the new one');
    expect(CEO_SECTION_CACHE_PLAN).toContain('does not coordinate\nan ordinary DB write');
  });

  test.each([false, true])('rollout publication fences admitted old writes: %s', async (fenceWrites) => {
    let stored = 'old';
    let releaseWrite!: () => void;
    const gate = new Promise<void>(resolve => { releaseWrite = resolve; });
    const repository = {
      read: async () => stored,
      write: async (_key: string, value: string) => { await gate; stored = value; return value; },
    };
    const instance = () => new Function('cache', 'repository',
      CACHE_READ_WRITE_SKETCH + '\nreturn { readProfile, writeProfile };')(new Map(), repository);
    const old = instance();
    const writing = old.writeProfile('tenant:profile', 'new');
    let published = false;
    const publish = async () => {
      if (fenceWrites) await writing;
      published = true;
      return instance();
    };
    const publishing = publish();
    await Promise.resolve();
    expect(published).toBe(!fenceWrites);
    if (!fenceWrites) {
      const next = await publishing;
      expect(await next.readProfile('tenant:profile')).toBe('old');
      releaseWrite(); await writing;
      // The initial isolation-only contract still permits a stale new cache.
      expect(await next.readProfile('tenant:profile')).toBe('old');
    } else {
      releaseWrite(); await writing;
      const next = await publishing;
      expect(await next.readProfile('tenant:profile')).toBe('new');
    }
    expect(CEO_SECTION_CACHE_PLAN).toContain('awaits every admitted old-instance write');
    expect(CEO_SECTION_CACHE_PLAN).toContain('fresh single-flight cohort before admitting new work');
  });

  test('an internal store commit still overlaps the unfinished public wrapper write', async () => {
    let stored = 'old';
    let commitWrite!: () => void;
    let wrapperReturned = false;
    const cache = new Map([['tenant:profile', 'old']]);
    const repository = {
      read: async () => stored,
      write: () => new Promise<string>(resolve => {
        commitWrite = () => { stored = 'new'; resolve('new'); };
      }),
    };
    const { readProfile, writeProfile } = new Function('cache', 'repository',
      CACHE_READ_WRITE_SKETCH + '\nreturn { readProfile, writeProfile };')(cache, repository);
    const writing = writeProfile('tenant:profile', 'new').then((value: string) => {
      wrapperReturned = true;
      return value;
    });
    commitWrite();
    expect(stored).toBe('new');
    expect(wrapperReturned).toBe(false);
    // Invocation precedes the wrapper's invalidation/return continuation.
    // Its old cache hit is permitted; a later caller is still protected.
    const overlappingRead = readProfile('tenant:profile');
    await writing;
    expect(wrapperReturned).toBe(true);
    expect(cache.has('tenant:profile')).toBe(false);
    expect(await overlappingRead).toBe('old');
    expect(await readProfile('tenant:profile')).toBe('new');
    const contract = CEO_SECTION_CACHE_PLAN.replace(/\s+/g, ' ');
    expect(contract).toContain("when writeProfile's promise fulfills after cache.delete, not when repository.write commits or resolves");
    expect(contract).toContain('Reads that overlap an unfinished writeProfile may return an earlier snapshot');
  });

  test('an old miss filled before the completed write is correctly invalidated', async () => {
    let stored = 'old';
    let releaseRead!: () => void;
    let first = true;
    const cache = new Map<string, string>();
    const repository = {
      read: () => {
        if (!first) return Promise.resolve(stored);
        first = false;
        const snapshot = stored;
        return new Promise<string>(resolve => { releaseRead = () => resolve(snapshot); });
      },
      write: async (_key: string, value: string) => { stored = value; return value; },
    };
    const { readProfile, writeProfile } = new Function('cache', 'repository',
      CACHE_READ_WRITE_SKETCH + '\nreturn { readProfile, writeProfile };')(cache, repository);
    const earlierRead = readProfile('tenant:profile');
    releaseRead();
    expect(await earlierRead).toBe('old');
    expect(cache.get('tenant:profile')).toBe('old');
    await writeProfile('tenant:profile', 'new');
    expect(stored).toBe('new');
    expect(cache.has('tenant:profile')).toBe(false);
    expect(await readProfile('tenant:profile')).toBe('new');
  });

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


// The native report separates an asserted finding, its ordered trace and its
// explicit contract violation. Detection does not certify the offered fix.
describe('structured native stale-fill finding', () => {
  const report = require('node:fs').readFileSync(require('node:path').join(import.meta.dir, 'fixtures/ceo-section-loading-l-report.md'), 'utf8');
  const finding = report.slice(report.indexOf('**CRITICAL FINDING — Write-then-read stale-set race**'), report.indexOf('**Required fix:**'));
  test('retains the exact positive later-reader finding even though the proposed mitigation is wrong', () => {
    expect(hasStaleFillRaceFinding(report)).toBe(true);
    expect(hasStaleFillRaceFinding(finding)).toBe(true);
  });
  test.each([
    ['standalone trace', finding.slice(finding.indexOf('```'), finding.lastIndexOf('```') + 3)],
    ['quoted finding', finding.split('\n').map((line: string) => '> ' + line).join('\n')],
    ['source example', 'Example of report format:\n' + finding],
    ['outer fenced source', '````text\n' + finding + '\n````'],
    ['explicit accepted trace', finding.replace('This violates the stated invariant:', 'This is not a gap. The following behavior is accepted:')],
    ['negated violation', finding.replace('This violates the stated invariant:', 'This does not violate the stated invariant:')],
    ['separate dismissal', finding + '\nThis is not a defect; no fix is required.\n'],
    ['no new reader', finding.replace(/T3: readProfile[\s\S]*?\n```/, '```')],
    ['reverse ordering', finding.replace('cache.delete(key)', 'cache.get(key)')],
    ['unrelated heading', finding.replace('CRITICAL FINDING', 'EXAMPLE')],
    ...['~~~', '````'].map(fence => ['nontriple fenced violation', finding.replace(/This violates[\s\S]*$/, text => fence + 'text\n' + text + '\n' + fence)]),
    ['unclosed fenced violation', finding.replace('This violates', '```text\nThis violates')],
    ['later named finding', finding.replace('This violates', '**CRITICAL FINDING — unrelated documentation defect**\nThis violates')],
    ['later heading', finding.replace('This violates', '## Unrelated finding\nThis violates')],

  ])('rejects %s', (_name, text) => expect(hasStaleFillRaceFinding(text)).toBe(false));
});


// Actual Q report amended the original contract to accept later stale reads.
// The oracle must not count that permission paragraph as an unresolved defect.
describe('accepted consistency model is not a stale-fill finding', () => {
  const report = require('node:fs').readFileSync(require('node:path').join(import.meta.dir, 'fixtures/ceo-section-loading-q-report.md'), 'utf8');
  const accepted = report.slice(report.indexOf('- **AMENDED (stale-fill race):**'), report.indexOf('\n\n', report.indexOf('- **AMENDED (stale-fill race):**')));
  test('rejects the exact amended consistency paragraph', () => {
    expect(accepted).toMatch(/accepted consistency\s+model/);
    expect(hasStaleFillRaceFinding(accepted)).toBe(false);
  });
  test('rejects the complete Q report that accepts the late-fill race', () => {
    expect(hasStaleFillRaceFinding(report)).toBe(false);
  });
  test.each([
    'An in-flight read refills stale data after write invalidation. A subsequent read sees the old value. This is the accepted consistency model; TTL expiry is the consistency deadline.',
    'An in-flight read refills stale data after write invalidation. A subsequent read sees the old value. This remains the documented consistency contract.',
    'An in-flight read refills stale data after write invalidation. A subsequent read sees the old value. This is an intentional consistency policy.',
  ])('rejects a declared consistency allowance: %s', text => {
    expect(hasStaleFillRaceFinding(text)).toBe(false);
  });
  test.each([
    'An in-flight read refills stale data after write invalidation. A subsequent read sees the old value. Every later read must observe the committed version; this is the accepted consistency model. The stale refill violates that contract.',
    'An in-flight read refills stale data after write invalidation. A subsequent read sees the old value. Every later read must observe the committed version. This is the accepted consistency model. The stale refill violates that contract.',
    'An in-flight read refills stale data after write invalidation. A subsequent read sees the old value, violating the accepted consistency model.',
    'An in-flight read refills stale data after write invalidation. The accepted consistency model requires a subsequent read to observe the committed version; this violates that contract.',
    'An in-flight read refills stale data after write invalidation. A subsequent read sees the old value. This is not the accepted consistency model.',
    'An in-flight read refills stale data after write invalidation. A subsequent read sees the old value. This is not an accepted consistency model.',
  ])('retains an unresolved later-reader violation without demanding a correct remedy: %s', text => {
    expect(hasStaleFillRaceFinding(text)).toBe(true);
  });
});


describe('CEO R report requirement weakening remains rejected', () => {
  test('a race trace followed by acceptance and a weaker guarantee is not an unresolved defect', async () => {
    // Exact delivered R retry report; the existing oracle already rejects it.
    // This pins the policy failure without changing the paid fixture or oracle.
    const report = await Bun.file(new URL('./fixtures/ceo-section-r-rejected-report.md', import.meta.url)).text();
    expect(report).toContain('Every read begun after that write completes must');
    expect(report).toContain('this is an accepted design choice, not a quality gap');
    expect(report).toContain('Verify: new reads see stale value until TTL');
    expect(hasStaleFillRaceFinding(report)).toBe(false);
  });
});

// Exact S output names the original-contract defect but proposes an ineffective
// guard. Detection and remedy correctness remain separate assertions.
describe('S native same-finding ordered trace', () => {
  const report = require('node:fs').readFileSync(require('node:path').join(import.meta.dir, 'fixtures/ceo-section-s-trace-report.md'), 'utf8');
  const finding = report.slice(report.indexOf('### Critical Finding: Stale Re-insertion After Write Invalidation'), report.indexOf('### State Machine: Cache Entry'));
  test('recognizes the exact delivered S finding without certifying its remedy', () => {
    expect(hasStaleFillRaceFinding(report)).toBe(true);
    expect(hasStaleFillRaceFinding(finding)).toBe(true);
    expect(report).toContain('if (cache.get(key) === undefined)');
  });
  test('the same ordered evidence tolerates whitespace and a consistent key name', () => {
    expect(hasStaleFillRaceFinding(finding.replaceAll('(key', '(accountKey').replaceAll('  t', '    t'))).toBe(true);
    expect(hasStaleFillRaceFinding(finding.replaceAll('(key', '($key'))).toBe(true);
  });
  test.each([
    ['optional single-flight label', finding.replace('single-flight → ', '')],
    ['old/stale value vocabulary', finding.replace('OLD snapshot', 'stale value').replace('OLD_VALUE', 'STALE_VALUE').replace('stale value re-inserted', 'old snapshot refilled').replace('next readProfile', 'subsequent readProfile')],
    ['prose payload vocabulary', finding.replace('OLD_VALUE', 'old value').replace('returns stale value', 'returns old snapshot')],
    ['ASCII arrows and compact spacing', finding.replaceAll(' → ', '->').replaceAll(' ← ', '<-')],
    ['trace keyword case', finding.replace(/t[1-6]:[^\n]*/g, (event: string) => event.toLowerCase())],
    ['call whitespace and optional suspension annotation', finding.replaceAll('(key)', '( key )').replace('(key, OLD_VALUE)', '( key , OLD_VALUE )').replaceAll(' (suspends)', '')],
  ])('accepts equivalent %s', (_name, text) => expect(hasStaleFillRaceFinding(text)).toBe(true));
  test.each([
    ['only the trace', finding.slice(finding.indexOf('```'), finding.indexOf('```', finding.indexOf('```') + 3) + 3)],
    ['quoted whole finding', finding.split('\n').map((line: string) => '> ' + line).join('\n')],
    ['indented whole finding', finding.split('\n').map((line: string) => '    ' + line).join('\n')],
    ['source format preface', 'Example of report format:\n' + finding],
    ['outer fenced source', '````text\n' + finding + '\n````'],
    ['missing independent violation', finding.replace('The proposed wrapper violates this invariant.', '')],
    ['negated independent violation', finding.replace('The proposed wrapper violates this invariant.', 'The proposed wrapper does not violate this invariant.')],
    ['unrelated heading', finding.replace('### Critical Finding:', '### Example:')],
    ['separate named finding', finding.replace('Race sequence', '### Another finding\nRace sequence')],
    ['separate bold finding', finding.replace('Race sequence', '**HIGH FINDING — unrelated issue**\nRace sequence')],
    ['missing write completion', finding.replace('DB write completes', 'DB write remains pending')],
    ['no invalidation', finding.replace('cache.delete(key) → writeProfile returns', 'cache.get(key) → writeProfile returns')],
    ['missing late old fill', finding.replace('cache.set(key, OLD_VALUE)', 'cache.set(key, NEW_VALUE)')],
    ['different filled key', finding.replace('cache.set(key, OLD_VALUE)', 'cache.set(otherKey, OLD_VALUE)')],
    ['case-distinct filled key', finding.replace('cache.set(key, OLD_VALUE)', 'cache.set(KEY, OLD_VALUE)')],
    ['different later key', finding.replace('next readProfile(key)', 'next readProfile(otherKey)')],
    ['only original pending reader', finding.replace('next readProfile(key)', 'original pending readProfile(key)')],
    ['later reader misses', finding.replace('cache HIT → returns stale value', 'cache MISS → returns committed value')],
    ['nonviolating trace', finding.replace('← INVARIANT VIOLATED', '← INVARIANT PRESERVED')],
    ['reverse order labels', finding.replace('t3:', 't4:').replace('t4: DB read', 't3: DB read')],
    ['missing event', finding.replace(/^.*t4:.*\n/m, '')],
    ['unclosed trace', finding.replace('```\n\nThe plan says', '\nThe plan says')],
    ['source-code trace fence', finding.replace('```\n  t1:', '```javascript\n  t1:')],
    ['split traces', finding.replace('  t4:', '```\n\n```\n  t4:')],
    ['accepted stale trace', finding + '\nThis stale-read behavior is accepted; no guard is required.\n'],
    ['allowed new-reader consequence', finding + '\nA subsequent stale read is permitted by the amended contract.\n'],
    ['explicit defect dismissal', finding + '\nThis is not a defect; no fix is required.\n'],
  ])('rejects %s', (_name, text) => expect(hasStaleFillRaceFinding(text)).toBe(false));
});

// Actual v2 SDK review identifies the missing fill/write coordination directly.
// The full delivered report is retained in run evidence; this is its exact finding.
describe('explicit uncoordinated cache-fill freshness violation', () => {
  const finding = [
    "**[Amended: D2, D3, D4, D5]** The original sketch had no coordination between a",
    "cache fill and a write and omitted the single-flight wrapper and the absence",
    "sentinel; finding F1 showed that violates the read-after-write rule. The",
    "ordering rules below replace it. `flight` is the existing per-key single-flight",
    "wrapper extended with `invalidate(key)` and `invalidateAll()`; a fill ticket is",
    "`live()` until its key is invalidated. `ProfileNotFound` stands for the",
    "repository's existing typed not-found error class.",
  ].join('\n');
  test('accepts the actual finding without requiring its separate execution diagram', () => {
    expect(hasStaleFillRaceFinding(finding)).toBe(true);
    expect(hasStaleFillRaceFinding('## Proposed wrapper integration\nKeep the current read-through repository interface and shared adapters.\n' + finding)).toBe(true);
  });
  test.each([
    ['current wrapper', finding.replace('original sketch had', 'current wrapper has')],
    ['proposed implementation', finding.replace('original sketch had', 'proposed implementation has')],
    ['freshness contract', finding.replace('read-after-write rule', 'read-after-write contract')],
  ])('recognizes equivalent %s evidence', (_name, text) => expect(hasStaleFillRaceFinding(text)).toBe(true));
  test.each([
    ['no violation asserted', finding.replace('finding F1 showed that violates the read-after-write rule.', '')],
    ['negated violation', finding.replace('that violates', 'that does not violate')],
    ['uncertain violation', finding.replace('that violates', 'that might violate')],
    ['conditional premise', 'If ' + finding],
    ['coordination exists', finding.replace('had no coordination', 'had coordination')],
    ['different operations', finding.replace('cache fill and a write', 'cache hit and a read')],
    ['wrong contract', finding.replace('read-after-write', 'read-before-write')],
    ['dismissed defect', finding + '\n\nThis is not a defect; no fix is required.'],
    ['accepted stale consequence', finding + '\n\nA subsequent stale read is permitted by the amended contract.'],
    ['quoted finding', finding.split('\n').map(line => '> ' + line).join('\n')],
    ['indented finding', finding.split('\n').map(line => '    ' + line).join('\n')],
    ['quoted paragraph', '"' + finding + '"'],
    ['source preface', 'Example of report format:\n' + finding],
    ['separate source preface', 'Example of report format:\n\n' + finding],
    ['backtick source fence', '````text\n' + finding + '\n````'],
    ['tilde source fence', '~~~text\n' + finding + '\n~~~'],
    ['unclosed source fence', '```text\n' + finding],
    ['split unrelated paragraphs', finding.replace('sentinel; finding', 'sentinel.\n\n### Separate issue\nFinding')],
  ])('rejects %s', (_name, text) => expect(hasStaleFillRaceFinding(text)).toBe(false));
});

// Peer counterexamples: embedded, uncertain and hypothetical assertions stay closed.
describe('coordination findings require directly asserted premises and conclusions', () => {
  const premise = 'The original sketch had no coordination between a cache fill and a write. ';
  const claim = 'This violates the read-after-write rule.';
  test('accepts a direct assertion', () => expect(hasStaleFillRaceFinding(premise + claim)).toBe(true));
  test.each([
    ['negated embedded conclusion', premise + 'It is false that this violates the read-after-write rule.'],
    ['unproven conclusion', premise + 'We have not shown that it violates the read-after-write rule.'],
    ['uncertain conclusion', premise + 'It is unclear whether this violates the read-after-write rule.'],
    ['question rather than assertion', premise + claim.replace('.', '?')],
    ['separate issue without blank line', premise + '\n## A different issue\nReplica lag is high. ' + claim],
    ['hypothetical premise', 'Suppose ' + premise + claim],
    ['suggested report', 'A suggested report sentence: ' + premise + claim],
    ['nested unmatched fence', '````text\n' + premise + claim + '\n```\n' + premise + claim + '\n````'],
    ['mismatched fence', '~~~text\n' + premise + claim + '\n```\n' + premise + claim],
  ])('rejects %s', (_name, text) => expect(hasStaleFillRaceFinding(text)).toBe(false));
});

// AM first SDK report, exact public Write53 acknowledged by native result54.
// The original report remains in run evidence; this is its complete asserted paragraph.
describe('reported original coordination violation with an owned finding citation', () => {
  const finding = "`[Amended: F1, F2, F3, F6]` The original sketch stated that no coordination\nbetween a cache fill and a write was proposed. Review showed that sketch\nviolates the retained read-after-write invariant (see F1). The ordering rules\nbelow replace it. They are the complete new read/write ordering rules.";
  test('accepts the exact owned paragraph without requiring its separate amended diagram', () => {
    expect(hasStaleFillRaceFinding(finding)).toBe(true);
    expect(hasStaleFillRaceFinding('## Proposed wrapper integration\n\n' + finding)).toBe(true);
  });
  test('binds the named violation to its original subject and finding identity', () => {
    expect(hasStaleFillRaceFinding(finding.replaceAll('F1', 'F7'))).toBe(true);
    expect(hasStaleFillRaceFinding(finding.replaceAll('sketch', 'wrapper'))).toBe(true);
    expect(hasStaleFillRaceFinding('## Historical example\n\nA copied example.\n\n## Current review\n\n' + finding)).toBe(true);
    expect(hasStaleFillRaceFinding(finding + '\n\n## Assessment of F2\nF2 is rejected.')).toBe(true);
    expect(hasStaleFillRaceFinding(finding + '\n\n## Assessment of F1\n> F1 is rejected.')).toBe(true);
  });
  test.each([
    ['negated missing coordination', finding.replace('no coordination', 'coordination')],
    ['unrelated operations', finding.replace('cache fill and a write', 'cache hit and a read')],
    ['uncertain absence', finding.replace('stated that no', 'might have stated that no')],
    ['unproven violation', finding.replace('Review showed', 'Review may show')],
    ['negated violation', finding.replace('sketch\nviolates', 'sketch\ndoes not violate')],
    ['hypothetical violation', finding.replace('sketch\nviolates', 'sketch\nmight violate')],
    ['wrong contract', finding.replace('read-after-write', 'read-before-write')],
    ['different subject', finding.replace('Review showed that sketch', 'Review showed that wrapper')],
    ['missing finding identity', finding.replace(' (see F1)', '')],
    ['question rather than conclusion', finding.replace('(see F1).', '(see F1)?')],
    ['conditional finding', 'If approved: ' + finding],
    ['historical owner', '## Historical example\n\n' + finding],
    ['source owner', '## Quoted source\n\n' + finding],
    ['hypothetical owner', '## Hypothetical example\n\n' + finding],
    ['explicit source preface', 'The following is a quoted source excerpt.\n\n' + finding],
    ['quoted paragraph', '"' + finding + '"'],
    ['block quote', finding.split('\n').map(line => '> ' + line).join('\n')],
    ['fenced source', '````text\n' + finding + '\n````'],
    ['literal assertion', finding.replace('The original sketch', '`The original sketch').replace('(see F1).', '(see F1).`')],
    ['split unrelated section', finding.replace('Review showed', '\n\n## Another finding\nReview showed')],
    ['direct same-finding withdrawal', finding + '\n\nF1 is rejected.'],
    ['later named same-finding withdrawal', finding + '\n\n## Assessment of F1\nF1 is withdrawn.'],
    ['dismissed defect', finding + '\n\nThis is not a defect; no fix is required.'],
    ['accepted stale consequence', finding + '\n\nA subsequent stale read is permitted by the amended contract.'],
  ])('rejects %s', (_name, text) => expect(hasStaleFillRaceFinding(text)).toBe(false));
});

// Exact public Write at d30620e8, session 59f999d1-de6b-4c67-ae6c-210efa05f0cc,
// toolu_01CWeW6wi4V6YEMNtd5dVdz2 acknowledged at native line 3343.
// PLAN.md SHA-256 577b669134977a17c779765c4a979a5fc1e9bc672cd77948d04d6bf066bfd7ff:
// retained requirement lines 38-40, current amendment 45-50, earlier-caller allowance 229.
// The recorded paid failure remains a failure; these are free detector regressions.
describe('attributed original coordination premise with a current freshness finding', () => {
  const evidence = "- A read already in progress when a write commits may return its earlier DB\n  snapshot to that caller. Every read begun after that write completes must\n  observe the committed version. TTL expiry is not a substitute for this rule.\n\n## Proposed wrapper integration\nKeep the current read-through repository interface and shared adapters.\n**[Amended: D1]** The original sketch stated \"no additional version checks or\ncoordination between a cache fill and a write\". That is withdrawn: the review\nshowed it violates the freshness invariant above (schedule in Section 4). The\naccepted ordering rules are:";
  const allowance = "Waiters coalesced on R1 receive V1 \u2014 permitted by PLAN.md:27-28 (they began before W completed)";
  const withAllowance = (claim = allowance) => evidence + '\n\n## Assessment of D1\n' + claim + '.';
  test('accepts the captured current assertion against its retained requirement', () => {
    expect(hasStaleFillRaceFinding(evidence)).toBe(true);
    expect(hasStaleFillRaceFinding(withAllowance())).toBe(true);
  });
  test('preserves premise ownership through equivalent labels, quotes and rule wording', () => {
    for (const text of [
      evidence.replaceAll('D1', 'F7'),
      evidence.replace('original sketch', 'original wrapper'),
      evidence.replace('original sketch', 'original implementation'),
      evidence.replace('"no additional', '“no additional').replace('a write"', 'a write”'),
      evidence.replace('no additional version checks or\ncoordination', 'no coordination'),
      evidence.replace('That is withdrawn: the review\nshowed it violates', 'This is withdrawn: the review shows it breaks'),
      evidence.replace('freshness invariant above', 'retained read-after-write contract above'),
      evidence.replace('Every read begun', 'Every read started').replace('that write completes', 'the write returns').replace('committed version', 'committed value'),
      evidence.replace(' (schedule in Section 4)', ''),
    ]) expect(hasStaleFillRaceFinding(text)).toBe(true);
  });
  test('requires the original missing coordination and the reviewer current assertion together', () => {
    for (const text of [
      evidence.replace('no additional version checks or\ncoordination', 'coordination'),
      evidence.replace('cache fill and a write', 'cache hit and a read'),
      evidence.replace('original sketch stated', 'original sketch may have stated'),
      evidence.replace('That is withdrawn:', 'That is retained:'),
      evidence.replace('showed it violates', 'did not show it violates'),
      evidence.replace('showed it violates', 'showed another wrapper violates'),
      evidence.replace('showed it violates', 'showed it might violate'),
      evidence.replace('freshness invariant', 'formatting invariant'),
      evidence.replace('Section 4).', 'Section 4)?'),
      evidence.replace('That is withdrawn:', '\n\n## Other finding\nThat is withdrawn:'),
      evidence.replace('That is withdrawn:', '| That is withdrawn:'),
      evidence.replace('**[Amended: D1]**', 'If approved: **[Amended: D1]**'),
    ]) expect(hasStaleFillRaceFinding(text)).toBe(false);
  });
  test('requires a retained current requirement from this plan', () => {
    const finding = evidence.slice(evidence.indexOf('## Proposed wrapper integration'));
    for (const text of [
      finding,
      evidence.replace('Every read begun after that write completes must\n  observe the committed version.', 'Later reads may observe an earlier value.'),
      evidence.replace('must\n  observe', 'might\n  observe'),
      evidence.replace('Every read begun', 'Not every read begun'),
      evidence.replace('## Proposed wrapper integration', 'This rule is withdrawn.\n\n## Proposed wrapper integration'),
      '## Finding F9: unrelated cache\n' + evidence,
      '## Historical source\n' + evidence.slice(0, evidence.indexOf('## Proposed wrapper integration')) + '\n## Current review\n' + finding,
      '> Every read begun after that write completes must observe the committed version.\n\n' + finding,
      '"Every read begun after that write completes must observe the committed version."\n\n' + finding,
      'For another cache. Every read begun after that write completes must observe the committed version.\n\n' + finding,
    ]) expect(hasStaleFillRaceFinding(text)).toBe(false);
  });
  test('does not promote copied, fenced or quoted review assertions', () => {
    for (const text of [
      'Source:\n\n' + evidence,
      'Earlier review:\n\n' + evidence,
      '## Hypothetical example\n' + evidence,
      'The following is a quoted source excerpt.\n\n' + evidence,
      evidence.split('\n').map(line => '> ' + line).join('\n'),
      evidence.split('\n').map(line => '    ' + line).join('\n'),
      '````text\n' + evidence + '\n````',
      '~~~text\n' + evidence + '\n~~~',
      evidence.replace('**[Amended: D1]**', '"Copied sentence. **[Amended: D1]**') + '"',
      evidence.replace('**[Amended: D1]**', 'Example of report format:\n\n**[Amended: D1]**'),
      evidence.replace('That is withdrawn:', '"That is withdrawn:').replace('Section 4).', 'Section 4)."'),
      evidence.replace('The original sketch', '`The original sketch').replace('Section 4).', 'Section 4).`'),
    ]) expect(hasStaleFillRaceFinding(text)).toBe(false);
  });
  test('same-finding rejection and stale-result permission remain failures', () => {
    for (const tail of [
      'D1 is rejected.', 'D1 is "withdrawn".', 'This finding is dismissed.',
      '| D1 | Withdrawn |', '| D1 | "rejected" |',
      'A subsequent stale read is permitted by the amended contract.',
      'This stale-fill behavior is accepted.', 'No coordination is required.',
    ]) expect(hasStaleFillRaceFinding(withAllowance() + '\n\n## Assessment of D1\n' + tail)).toBe(false);
  });
  test('foreign or copied rejections do not override the current finding', () => {
    for (const tail of [
      '## Assessment of D2\nD2 is rejected.',
      '## Assessment of D2\n| D2 | Withdrawn |',
      '## Historical assessment\nD1 is withdrawn.',
      '## Assessment of D1\n> D1 is rejected.',
    ]) expect(hasStaleFillRaceFinding(evidence + '\n\n' + tail)).toBe(true);
  });
  test('coalesced earlier callers may use different symbolic writer and snapshot names', () => {
    for (const text of [
      allowance.replaceAll('R1', 'R17').replaceAll('V1', 'snapshot-A').replaceAll('W ', 'W9 '),
      allowance.replace('Waiters', 'Readers').replace('began', 'started').replace('W completed', 'the write returned'),
      allowance.replace('Waiters coalesced on R1', 'Callers').replace('receive', 'observe').replace('permitted by PLAN.md:27-28', 'allowed'),
    ]) expect(hasStaleFillRaceFinding(withAllowance(text))).toBe(true);
  });
  test('earlier-call allowance cannot credit a later reader, uncertain ordering or a fill', () => {
    for (const text of [
      allowance.replace('before W', 'after W'),
      allowance.replace('they began', 'they never began'),
      allowance.replace('they began', 'they may have begun'),
      allowance.replace('they began', 'another reader began'),
      allowance.replace('before W completed', 'before R2 completed'),
      allowance.replace('Waiters', 'Later readers'),
      allowance.replace('receive V1', 'fill the cache with V1'),
      allowance.replace('receive V1', 'return V1 to later callers'),
      allowance.replace('W completed)', 'W completed only if the write failed)'),
      allowance + ' and later readers may reuse V1',
      allowance + '. A subsequent stale read is permitted',
      allowance + '. The stale cache fill is acceptable',
    ]) expect(hasStaleFillRaceFinding(withAllowance(text))).toBe(false);
  });
});


describe('attributed coordination phrase classes and ownership', () => {
  // Independently written forms: no captured sentence, schedule schema or fixed parenthetical.
  const reports = [
    `## Retained contract
  Any request started after the write returns shall receive the committed value.

  ## Wrapper review
  [Amended: F8] Our original wrapper assumed “cache population proceeds without synchronization with writes”.
  We reject that assumption. Our review established that this approach contradicts the existing freshness guarantee.`,
    `## Existing contract
  All reads that begin after write completion must return the newly committed version.

  ## Implementation review
  [Amended: D4] The proposed implementation specifies "no coordination for writes and cache fills".
  This proposal was rejected. Review found it fails to preserve the read-after-write requirement.`,
    `## Contract retained
  Once a write has completed, new reads must see the value it committed.

  ## Current review
  [Amended: F3] The current sketch states "cache fills and writes run without coordination".
  That sketch breaks the current freshness rule.`,
    `## Required behavior
  The retained requirement: all requests that start after that write finishes are required to receive the committed snapshot.

  ## Current review
  [Amended: D17] Our original implementation assumed "cache repopulation and writes lacked ordering guards".
  That assumption has been retracted. The implementation does not preserve the existing freshness contract.`,
  ];

  for (const [index, report] of reports.entries()) {
    test(`phrase classes recognize independent current review form ${index + 1}`, () => expect(hasStaleFillRaceFinding(report)).toBe(true));
  }

  test('the attributed premise and direct violation need no fixed rejection sentence or above reference', () => {
    expect(hasStaleFillRaceFinding(reports[0]!.replace('We reject that assumption. ', ''))).toBe(true);
    expect(hasStaleFillRaceFinding(reports[1]!.replace('This proposal was rejected. ', ''))).toBe(true);
    expect(hasStaleFillRaceFinding(reports[2]!.replace('That sketch breaks', 'We found that this sketch violates'))).toBe(true);
  });

  test('different finding and artifact subjects cannot borrow the attributed premise', () => {
    for (const text of [
      reports[0]!.replace('We reject that assumption.', 'Another unrelated finding concerns replica lag.'),
      reports[0]!.replace('this approach contradicts', 'another approach contradicts'),
      reports[0]!.replace('this approach contradicts', 'the implementation contradicts'),
      reports[1]!.replace('Review found it fails', 'Review found another issue fails'),
      reports[2]!.replace('That sketch breaks', 'It is unclear whether that sketch breaks'),
      reports[2]!.replace('That sketch breaks', 'It is false that that sketch breaks'),
      reports[2]!.replace('That sketch breaks', 'That sketch does not break'),
    ]) expect(hasStaleFillRaceFinding(text)).toBe(false);
  });

  test('normative freshness rules cannot be replaced by conditional or permissive statements', () => {
    for (const report of reports) {
      for (const text of [
        report.replace(/shall receive|must return|must see|are required to receive/, 'may receive'),
        report.startsWith('## Contract retained') ? report.replace('Once a write has completed', 'Before a write has completed') : report.replace('after', 'before'),
        report.replace('committed value', 'earlier value').replace('newly committed version', 'old version').replace('the value it committed', 'an older snapshot').replace('committed snapshot', 'stale snapshot'),
      ]) expect(hasStaleFillRaceFinding(text)).toBe(false);
    }
  });

  test('quoted current assertions, source owners and split findings remain closed across phrase forms', () => {
    for (const report of reports) {
      const assertion = report.slice(report.lastIndexOf('\n') + 1);
      for (const text of [
        '> ' + report.replaceAll('\n', '\n> '),
        '````text\n' + report + '\n````',
        '## Historical source\n' + report.replaceAll('## ', '### '),
        report.replace(assertion, '"' + assertion + '"'),
        report.replace(assertion, '### Unrelated finding F99\n' + assertion),
      ]) expect(hasStaleFillRaceFinding(text)).toBe(false);
    }
  });

  const finding = reports[0]!;
  const withAllowance = (claim: string) => finding + '\n\n## Assessment of F8\n' + claim;
  const earlierAllowances = [
    'The coalesced readers receive their earlier snapshot; that return is permitted because they started before the write completed.',
    'Readers coalesced on R8 return SNAPSHOT_X (allowed, because each call began before W9 returned).',
    'Waiters that began before write completion are permitted to receive V7.',
  ];

  test('earlier-group permission depends on ownership and chronology rather than exact punctuation', () => {
    for (const claim of earlierAllowances) expect(hasStaleFillRaceFinding(withAllowance(claim))).toBe(true);
  });

  test('earlier-group phrases cannot permit a fill, another caller or uncertain start', () => {
    for (const claim of [
      earlierAllowances[0]!.replace('before the write completed', 'after the write completed'),
      earlierAllowances[0]!.replace('they started', 'another reader started'),
      earlierAllowances[0]!.replace('they started', 'they might have started'),
      earlierAllowances[0]!.replace('receive their earlier snapshot', 'store their earlier snapshot in the cache'),
      earlierAllowances[1]!.replace('each call began', 'some other call began'),
      earlierAllowances[1]!.replace('W9 returned', 'R3 returned'),
      earlierAllowances[2]!.replace('before write completion', 'before another write completed'),
      earlierAllowances[2]!.replace('receive V7', 'return V7 to future callers'),
      earlierAllowances[0]!.replace(/\.$/, ' and future consumers may reuse that snapshot.'),
    ]) expect(hasStaleFillRaceFinding(withAllowance(claim))).toBe(false);
  });

  test('a legitimate earlier group never overrides a same-finding rejection or accepted stale fill', () => {
    for (const allowance of earlierAllowances) {
      expect(hasStaleFillRaceFinding(withAllowance(allowance) + '\nF8 is rejected.')).toBe(false);
      expect(hasStaleFillRaceFinding(withAllowance(allowance) + '\nA later stale read is permitted.')).toBe(false);
      expect(hasStaleFillRaceFinding(withAllowance(allowance) + '\nThis stale-fill behavior is accepted.')).toBe(false);
      expect(hasStaleFillRaceFinding(withAllowance(allowance) + '\n\n## Assessment of F9\nF9 is rejected.')).toBe(true);
    }
  });


  test('current assertions cannot attribute the retained-rule violation to a different finding', () => {
    const report = reports[2]!;
    expect(hasStaleFillRaceFinding(report.replace('freshness rule.', 'freshness rule (see F3).'))).toBe(true);
    expect(hasStaleFillRaceFinding(report.replace('freshness rule.', 'freshness rule (see F9).'))).toBe(false);
    expect(hasStaleFillRaceFinding(report.replace('freshness rule.', 'freshness rule (see D3).'))).toBe(false);
  });
});

describe('current fill-lifetime overlap', () => {
  const lifetime = 'a fill that started before a write and stored after it caches the pre-write snapshot';
  const current = (text: string, suffix = '') => `### Current findings\n\nWithout coordination, ${text}, violating the retained read-after-write rule. ${suffix}`;

  test('captured current lifetime claim is independent of the ambiguous inline schedule', () => {
    expect(hasStaleFillRaceFinding(lifetimeFixture.claim)).toBe(true);
    expect(hasStaleFillRaceFinding(lifetimeFixture.ambiguousFinding)).toBe(false);
  });

  test.each([
    lifetime,
    'the cache fill which began before the write and completed after that write, storing the old value',
    'a fill that begins before a write and finishes after the same write stores the stale data',
    'the original fill starts before this write and completes after that same write caches the pre-write snapshot',
    'the fill began before the write completes and stored after it settles caches the pre-write value',
  ])('recognizes an explicit same-fill lifetime: %s', text => {
    expect(hasStaleFillRaceFinding(current(text))).toBe(true);
  });

  test.each(['F1', 'R7', 'BUG-cache', '17'])('current ownership does not depend on row-ID spelling: %s', id => {
    expect(hasStaleFillRaceFinding(`### Current findings\n\n| ${id} | CRITICAL GAP | ${current(lifetime).split('\n\n')[1]} |`)).toBe(true);
  });

  test.each([
    ['starts after the write', lifetime.replace('started before', 'started after')],
    ['stores before the write', lifetime.replace('stored after', 'stored before')],
    ['different writer', lifetime.replace('after it', 'after another write')],
    ['different filling actor', lifetime.replace('and stored', 'and another fill stored')],
    ['foreign key', lifetime.replace('a fill', 'a fill for another key')],
    ['return to original caller only', lifetime.replace('stored after it caches', 'returned after it with')],
    ['fresh value', lifetime.replace('pre-write snapshot', 'committed snapshot')],
    ['missing start', lifetime.replace('that started before a write and ', '')],
    ['missing late storage', lifetime.replace('and stored after it ', '')],
    ['missing cache storage', lifetime.replace('caches the pre-write snapshot', 'returns the pre-write snapshot')],
    ['explicit conditional', 'if ' + lifetime],
    ['explicit hypothesis', 'hypothetical execution: ' + lifetime],
    ['possible execution only', 'it might be that ' + lifetime],
    ['negated execution', 'it is not true that ' + lifetime],
    ['prevented execution', 'the guard prevents ' + lifetime],
    ['impossible execution', 'it is impossible that ' + lifetime],
    ['quoted execution', '"' + lifetime + '"'],
    ['code literal execution', '`' + lifetime + '`'],
    ['quote cannot join phase fragments', lifetime.replace('and stored after it', 'and "stored after it"')],
    ['second subject cannot inherit write', lifetime.replace('after it', 'after a separate write')],
  ])('rejects incomplete or unasserted overlap: %s', (_name, text) => {
    expect(hasStaleFillRaceFinding(current(text))).toBe(false);
  });

  test.each([
    ['quoted block', current(lifetime).split('\n').map(line => '> ' + line).join('\n')],
    ['fenced block', '```text\n' + current(lifetime) + '\n```'],
    ['unclosed fence', '~~~text\n' + current(lifetime)],
    ['source heading', current(lifetime).replace('Current findings', 'Quoted source')],
    ['historical owner', current(lifetime).replace('Current findings', 'Historical review')],
    ['source introduction', 'Source:\n' + current(lifetime).replace('Current findings', 'Findings')],
    ['accepted staleness', current(lifetime, 'This staleness is the accepted consistency model.')],
    ['later stale read permitted', current(lifetime, 'Later stale reads are permitted by the contract.')],
    ['current prevention', current(lifetime, 'The current wrapper cannot refill old data after invalidation.')],
    ['finding withdrawn', current(lifetime, 'This finding is withdrawn.')],
    ['finding rejected', current(lifetime, 'This finding is rejected.')],
    ['no repair required', current(lifetime, 'No guard is required.')],
  ])('preserves current ownership and dismissal: %s', (_name, text) => {
    expect(hasStaleFillRaceFinding(text)).toBe(false);
  });

  const seeded = () => {
    const events: string[] = [];
    let cached: string | undefined;
    let releaseRead!: () => void;
    const pendingRead = new Promise<string>(resolve => { releaseRead = () => { events.push('DB read v1 completes'); resolve('v1'); }; });
    const cache = {
      get: () => cached,
      set: (_key: string, value: string) => { events.push('cache set ' + value); cached = value; },
      delete: () => { events.push('cache delete'); cached = undefined; },
    };
    const repository = {
      read: () => pendingRead,
      write: async () => { events.push('DB write commits v2'); return 'v2'; },
    };
    const functions = new Function('cache', 'repository', CACHE_READ_WRITE_SKETCH + '\nreturn { readProfile, writeProfile };')(cache, repository);
    return { events, releaseRead, ...functions } as { events: string[]; releaseRead: () => void; readProfile: (key: string) => Promise<string>; writeProfile: (key: string, update: unknown) => Promise<string> };
  };

  test('the actual seeded wrapper can fill a pre-write snapshot when its pending read completes after the writer', async () => {
    const fixture = seeded();
    const original = fixture.readProfile('profile');
    await fixture.writeProfile('profile', {});
    fixture.releaseRead();
    expect(await original).toBe('v1');
    expect(await fixture.readProfile('profile')).toBe('v1');
    expect(fixture.events).toEqual(['DB write commits v2', 'cache delete', 'DB read v1 completes', 'cache set v1']);
  });

  test('the seeded await continuation stores synchronously before a later writer invalidates it', async () => {
    const fixture = seeded();
    const original = fixture.readProfile('profile');
    fixture.releaseRead();
    expect(await original).toBe('v1');
    await fixture.writeProfile('profile', {});
    expect(fixture.events).toEqual(['DB read v1 completes', 'cache set v1', 'DB write commits v2', 'cache delete']);
  });
});


describe('section fixture rollout metrics retain final acceptance without an impossible early-stage gate',()=>{
  test('early-stage hit rate counts admitted requests while aggregate metrics use baseline limits',()=>{
    const requests=9000, admitted=requests*0.1, hits=admitted*0.6;
    const cohortHitRate=hits/admitted, aggregateHitRate=hits/requests;
    expect(cohortHitRate).toBe(0.6); expect(aggregateHitRate).toBe(0.06);
    expect(70*(1-aggregateHitRate)).toBeCloseTo(65.8); // uniform traffic, linear read CPU: above final 50%, below baseline 70%
    expect(CEO_SECTION_CACHE_PLAN).toContain('among requests admitted to the cache path');
    expect(CEO_SECTION_CACHE_PLAN).toContain('tracked separately, not as misses');
    expect(CEO_SECTION_CACHE_PLAN).toContain('DB CPU and read p95 are service-wide metrics, including bypassed requests');
    expect(CEO_SECTION_CACHE_PLAN).toContain('At the 10% and 50% stages');
    expect(CEO_SECTION_CACHE_PLAN).toContain('no worse than their 70%/120 ms pre-rollout baselines');
    expect(CEO_SECTION_CACHE_PLAN).not.toContain('A healthy hour means the stated hit-rate, CPU, latency and error targets hold');
  });
  test('full rollout keeps all original absolute targets and the seeded race still needs repair',()=>{
    expect(CEO_SECTION_CACHE_PLAN).toContain('At 100%, the original');
    expect(CEO_SECTION_CACHE_PLAN).toContain('absolute acceptance targets (DB CPU below 50%, read p95 below 60 ms, hits at');
    expect(CEO_SECTION_CACHE_PLAN).toContain('least 60%) must all hold with unchanged correctness/error SLOs and no alerts');
    expect(CEO_SECTION_CACHE_PLAN).toContain('Every read begun after that write completes must');
    expect(CEO_SECTION_CACHE_PLAN).toContain('TTL expiry is not a substitute for this rule');
    expect(CEO_SECTION_CACHE_PLAN).toContain('no additional version checks or');
    expect(CEO_SECTION_CACHE_PLAN).toContain(CACHE_READ_WRITE_SKETCH);
    expect(CEO_SECTION_CACHE_PLAN).toContain('repository.read returns\n  an immutable absent-result DTO for a missing record, never undefined');
  });
});
