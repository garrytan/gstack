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
