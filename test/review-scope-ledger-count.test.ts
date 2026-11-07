/**
 * GST-951: the /ship receipt's review_loop counters (gstack-review-scope summary) missed real blockers three times on
 * 2026-11-02, because summary read only the review-log rows while /ship's readers report through the dispatch ledgers
 * (gstack-review-dispatch collect and judge). Each case below is a minimal reconstruction of that PR's rows and ledgers,
 * built from its public PR body and receipt (the rows and ledgers themselves stayed on the lanes' machines): the rows
 * reproduce the receipt's published counters on the old summary, and the ledgers hold what the PR body says the readers found.
 * Ledgers are written with the real collect and judge, so the parser and judge rules apply as in a run.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { collect, readJsonl, recordJudgment, type JudgedLine, type MergedLine } from '../lib/review-ledger';
import { parseReviewLoop } from '../lib/ship-receipt';
import { cleanup, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/restamp-fixture';

setDefaultTimeout(60_000);
const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

const SINCE = '2026-11-02T01:00:00Z';
const at = (min: number) => new Date(Date.parse(SINCE) + min * 60_000).toISOString();
const review = (min: number, pass: number, findings: object[]) => ({ skill: 'review', via: 'ship', timestamp: at(min), status: findings.length ? 'issues_found' : 'clean', review_scope: 'frozen', pass, findings });
const fixCheck = (min: number, findings: object[]) => ({ skill: 'review-fix-check', via: 'ship', timestamp: at(min), review_scope: 'frozen', findings });
const note = (fp: string, raised_by: string) => ({ fingerprint: fp, severity: 'INFORMATIONAL', action: 'noted', blocking: false, raised_by });

/** One pass directory: each reader's output collected into its ledger, then lead judgment (default: every label kept). */
function pass(dir: string, readers: Array<[string, string]>, judgeWith = (merged: MergedLine[]): JudgedLine[] => merged.map(m => ({ id: m.id, severity: m.label }))): string {
  fs.mkdirSync(dir, { recursive: true });
  const ledger = path.join(dir, 'review-ledger.jsonl');
  const mergedFile = path.join(dir, 'merged.jsonl');
  fs.writeFileSync(mergedFile, '');
  for (const [reader, output] of readers) expect(collect(ledger, reader, output, mergedFile).review).toBe(true);
  const merged = readJsonl<MergedLine>(mergedFile);
  const judged = judgeWith(merged);
  const judgedFile = path.join(dir, 'judged.jsonl');
  fs.writeFileSync(judgedFile, judged.map(j => JSON.stringify(j) + '\n').join(''));
  expect(recordJudgment(ledger, merged, judged, judgedFile, mergedFile).ok).toBe(true);
  return ledger;
}

function branchWith(rows: object[]): FixtureRepo {
  const repo = makeFixtureRepo({ prefix: 'gst951-' });
  repos.push(repo);
  repo.git('checkout', '-qb', 'feat');
  const slug = runBin(repo, 'gstack-slug', ['--get', 'SLUG']).out.trim();
  const logDir = path.join(repo.home, 'projects', slug);
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, 'feat-reviews.jsonl'), rows.map(r => JSON.stringify(r) + '\n').join(''));
  return repo;
}
const summary = (repo: FixtureRepo, ...args: string[]) => runBin(repo, 'gstack-review-scope', ['summary', '--since', SINCE, '--json', ...args]);
const loop = (r: { status: number | null; out: string; err: string }) => { expect(r.err).not.toContain('(REVIEW_SCOPE_'); expect(r.status).toBe(EXIT.ok); return JSON.parse(r.out); };

const CLEAN = 'NO FINDINGS';
const OUTSIDE_CLEAN = 'No issues found in the diff.\nRecommendation: ship because no finding reaches the floor';

describe('GST-951: the receipt counts every blocker the readers found', () => {
  // #3841 (reconstruction; GSTA-203 PR 8 trail rows 9 and 14): Step 11's native adversarial FIXABLE (CRITICAL) finding was
  // fixed in round 2, but no row recorded it (pass 2's row held no findings), so summary printed blocking_found=0 fixed=0 and
  // the lane hand-set blocking_found=1 fixed=1. Its two other findings are the noted pair.
  const ADVERSARIAL_3841 = [
    '1. lib/pregate-clear.ts:140 The receipt stores the raw run URL, not the attempt it judged. FIXABLE',
    '2. lib/pregate.ts:88 The refusal text does not name the attempt. INVESTIGATE',
    '3. docs/pregate.md:12 The docs do not say a rerun replaces the attempt. INVESTIGATE',
    'Recommendation: fix 1 because a later attempt would be judged by the first',
  ].join('\n');
  test('#3841 as /ship logs it: the queued adversarial blocker in pass 2\'s row counts as 1 found and 1 fixed', () => {
    const repo = branchWith([
      review(0, 1, []),
      review(40, 2, [{ fingerprint: 'lib/pregate-clear.ts:140:security', action: 'fixed', raised_by: 'adversarial-native' },
        note('lib/pregate.ts:88:docs', 'adversarial-native'), note('docs/pregate.md:12:docs', 'adversarial-native')]),
    ]);
    const run = path.join(repo.root, 'run');
    pass(path.join(run, 'p1'), [['specialist/testing', CLEAN], ['red-team', CLEAN]]);
    pass(path.join(run, 'p1-voices'), [['outside-voice', OUTSIDE_CLEAN], ['adversarial-native', ADVERSARIAL_3841]]);
    pass(path.join(run, 'p2'), [['specialist/testing', CLEAN], ['red-team', CLEAN]]);
    expect(loop(summary(repo, '--no-ledger'))).toMatchObject({ passes: 2, blocking_found: 0, noted: 2, fixed: 1 });
    const s = loop(summary(repo, '--run', run));
    expect(s).toMatchObject({ passes: 2, blocking_found: 1, noted: 2, fixed: 1, ledgers_read: 3, rounds: 2 });
    expect(s.unrecorded).toBeUndefined();
  });

  test('#3841 as the lane logged it: an adversarial-only blocker counts, and its missing fix record shows as unrecorded', () => {
    const repo = branchWith([
      review(0, 1, []),
      review(40, 2, [note('lib/pregate.ts:88:docs', 'adversarial-native'), note('docs/pregate.md:12:docs', 'adversarial-native')]),
    ]);
    const run = path.join(repo.root, 'run');
    pass(path.join(run, 'p1'), [['specialist/testing', CLEAN], ['red-team', CLEAN]]);
    pass(path.join(run, 'p1-voices'), [['outside-voice', OUTSIDE_CLEAN], ['adversarial-native', ADVERSARIAL_3841]]);
    expect(loop(summary(repo, '--no-ledger'))).toMatchObject({ passes: 2, blocking_found: 0, noted: 2, fixed: 0 });
    const s = loop(summary(repo, '--run', run));
    expect(s).toMatchObject({ passes: 2, blocking_found: 1, noted: 2, fixed: 0, unrecorded: 1, ledgers_read: 2, rounds: 2 });
  });

  // #3838 (reconstruction): the rows reproduce its receipt (passes=2 blocking_found=0 noted=8 fixed=4 fix_checks=3). Pass 2's
  // red-team CRITICAL was logged fixed without classify's blocking stamp; Step 11's native adversarial CRITICAL (CSS
  // image-set loading an outside image) was fixed in 0f61362c1 and no row holds it.
  test('#3838: CRITICALs fixed without a classified row count', () => {
    const repo = branchWith([
      review(0, 1, ['a', 'b', 'c'].map(x => ({ fingerprint: `lib/review-depth.ts:1${x}:style`, severity: 'INFORMATIONAL', action: 'fixed', blocking: false, raised_by: 'security' }))),
      review(50, 2, [{ fingerprint: 'lib/review-depth.ts:212:security', severity: 'CRITICAL', action: 'fixed', raised_by: 'red-team' },
        note('lib/review-depth.ts:220:style', 'red-team'), note('lib/review-depth.ts:230:style', 'red-team')]),
      fixCheck(60, [note('lib/review-depth.ts:240:style', 'fix-check'), note('lib/review-depth.ts:241:style', 'fix-check')]),
      fixCheck(90, [note('lib/review-depth.ts:250:style', 'fix-check')]),
      fixCheck(120, [note('lib/review-depth.ts:260:perf', 'fix-check'), note('lib/review-depth.ts:261:perf', 'fix-check'), note('lib/review-depth.ts:262:perf', 'fix-check')]),
    ]);
    const run = path.join(repo.root, 'run');
    pass(path.join(run, 'p1'), [['specialist/security', '- [INFORMATIONAL] lib/review-depth.ts:1a a CSS escape\n- [INFORMATIONAL] lib/review-depth.ts:1b a zero-padded reference\n- [INFORMATIONAL] lib/review-depth.ts:1c a split handler line'], ['red-team', CLEAN]]);
    pass(path.join(run, 'p2'), [['red-team', '[CRITICAL] lib/review-depth.ts:212 a stray quote hides an external href from the drawing check']]);
    pass(path.join(run, 'p2-voices'), [['outside-voice', OUTSIDE_CLEAN], ['adversarial-native', 'lib/review-depth.ts:300 CSS image-set() loads an outside image. FIXABLE\nRecommendation: fix because the drawing loads a remote URL']]);
    expect(loop(summary(repo, '--no-ledger'))).toMatchObject({ passes: 2, blocking_found: 1, noted: 8, fixed: 4, fix_checks: 3, rounds: 5 });
    const s = loop(summary(repo, '--run', run));
    expect(s).toMatchObject({ passes: 2, blocking_found: 2, deferred: 0, noted: 8, fixed: 4, fix_checks: 3, rounds: 5, unrecorded: 1, ledgers_read: 3 });
  });

  // #3837 (reconstruction): pass 1's row was logged before the outside voice's seven findings were classified, so they sit in the
  // row with no severity, blocking stamp or action; the fix batch under the Captain's exception fixed them, and the receipt said
  // blocking_found=0 fixed=0 noted=11 fix_checks=3.
  test('#3837: blockers logged before classification count', () => {
    const seven = Array.from({ length: 7 }, (_, i) => ({ fingerprint: `lib/inventory.ts:${10 + i}:logic`, raised_by: 'outside-voice' }));
    const repo = branchWith([
      review(0, 1, [...seven, ...Array.from({ length: 9 }, (_, i) => note(`docs/inventory.md:${i + 1}:docs`, 'specialist'))]),
      review(60, 2, [note('lib/inventory.ts:90:docs', 'red-team'), note('lib/inventory.ts:91:docs', 'red-team')]),
      fixCheck(80, []), fixCheck(100, []), fixCheck(120, []),
    ]);
    const run = path.join(repo.root, 'run');
    pass(path.join(run, 'p1'), [['specialist-batched/1', CLEAN], ['red-team', CLEAN]]);
    pass(path.join(run, 'p1-voices'), [['adversarial-native', CLEAN], ['outside-voice', [
      ...seven.map((f, i) => `${i + 1}. ${f.fingerprint.split(':').slice(0, 2).join(':')} finding ${i + 1} Severity: High Blocks: yes`),
      'Recommendation: fix 1-6 because a self-grandfathered row skips every plan rule',
    ].join('\n')]]);
    expect(loop(summary(repo, '--no-ledger'))).toMatchObject({ passes: 2, blocking_found: 0, noted: 11, fixed: 0, fix_checks: 3, rounds: 5 });
    const s = loop(summary(repo, '--run', run));
    expect(s).toMatchObject({ passes: 2, blocking_found: 7, noted: 11, fixed: 0, unrecorded: 7, ledgers_read: 2, rounds: 5 });
    const line = runBin(repo, 'gstack-review-scope', ['summary', '--since', SINCE, '--run', run]);
    expect(line.out.trim()).toBe('REVIEW_LOOP: passes=2 blocking_found=7 deferred=0 noted=11 fixed=0 scope=frozen unrecorded=7 ledgers_read=2 fix_checks=3');
    expect(parseReviewLoop(s)).toMatchObject({ blocking_found: 7, unrecorded: 7, ledgers_read: 2, rounds: 5 });
  });

  test('a blocker both sources hold counts once, and a disposed one is not unrecorded', () => {
    const repo = branchWith([review(0, 1, [{ fingerprint: 'src/a.ts:3:logic', severity: 'CRITICAL', blocking: true, action: 'fixed', raised_by: 'red-team' }])]);
    const run = path.join(repo.root, 'run');
    pass(path.join(run, 'p1'), [['specialist/testing', CLEAN], ['red-team', '[CRITICAL] src/a.ts:3 the guard is inverted']]);
    const s = loop(summary(repo, '--run', run));
    expect(s).toMatchObject({ blocking_found: 1, fixed: 1, ledgers_read: 1 });
    expect(s.unrecorded).toBeUndefined();
  });

  test('a CRITICAL a row classified below the floor is not a blocker; distinct blockers from one reviewer each count', () => {
    const repo = branchWith([review(0, 1, [
      { fingerprint: 'src/a.ts:3:testing', path: 'src/a.ts', line: 3, severity: 'CRITICAL', kind: 'test-gap', blocking: false, action: 'noted', raised_by: 'testing' },
      { fingerprint: 'src/b.ts:9:security', path: 'src/b.ts', line: 9, severity: 'CRITICAL', blocking: true, action: 'fixed', raised_by: 'security' },
      { fingerprint: 'src/c.ts:1:logic', severity: 'CRITICAL', advisory: true, action: 'noted', raised_by: 'security' },
    ])]);
    const run = path.join(repo.root, 'run');
    pass(path.join(run, 'p1'), [['specialist/testing', '[CRITICAL] src/a.ts:3 the denied path has no test\n[CRITICAL] src/d.ts:7 the retry loop never ends']]);
    const s = loop(summary(repo, '--run', run));
    expect(s).toMatchObject({ blocking_found: 2, fixed: 1, noted: 2, unrecorded: 1, ledgers_read: 1 });
  });

  test('Step 11 review cases: a row finding pairs with one ledger CRITICAL; the newest classification and a mapped severity decide; a bare fixed row is a disposition', () => {
    const row = (fp: string, f: object) => ({ fingerprint: fp, ...f });
    const repo = branchWith([
      review(0, 1, [
        row('src/auth.ts:42:testing', { path: 'src/auth.ts', line: 42, severity: 'CRITICAL', kind: 'test-gap', blocking: false, action: 'noted', raised_by: 'testing' }),
        row('src/m.ts:5:state-matrix', { path: 'src/m.ts', line: 5, severity: 'INFORMATIONAL', raw_severity: 'CRITICAL', kind: 'test-gap', blocking: false, action: 'noted', raised_by: 'state-machines' }),
        row('src/f.ts:3:logic', { action: 'fixed', raised_by: 'outside-voice' }),
        row('src/n.ts:8:logic', { severity: 'CRITICAL', raised_by: 'red-team' }),
        row('src/g.ts:7:logic', { action: 'fixed', raised_by: 'core' }),
      ]),
      review(30, 2, [row('src/n.ts:8:logic', { severity: 'CRITICAL', blocking: false, action: 'noted', raised_by: 'red-team' })]),
    ]);
    const run = path.join(repo.root, 'run');
    pass(path.join(run, 'p1'), [
      ['specialist/testing', '[CRITICAL] src/auth.ts:42 the denied path has no test\n[CRITICAL] src/m.ts:5 untested cell'],
      ['outside-voice', '1. src/auth.ts:42 an unauthenticated caller reaches the handler. Severity: High Blocks: yes\n2. src/f.ts:3 the guard is inverted. Blocks: yes\nRecommendation: fix 1 because it is an open handler'],
      ['red-team', '[CRITICAL] src/n.ts:8 looked wrong, classified below the floor later'],
    ], m => [...m.map(l => ({ id: l.id, severity: l.label })), { id: 'lead#1', severity: 'CRITICAL', reason: 'src/g.ts:7 the lead found an unchecked write' }]);
    const s = loop(summary(repo, '--run', run));
    expect(s).toMatchObject({ passes: 2, blocking_found: 3, fixed: 2, unrecorded: 1, ledgers_read: 1 });
  });

  test('round 2 cases: another reviewer at a below-floor line, an extensionless path, one finding in two ledgers, no locus', () => {
    const repo = branchWith([
      review(0, 1, [
        { fingerprint: 'src/auth.ts:42:testing', path: 'src/auth.ts', line: 42, severity: 'CRITICAL', blocking: false, action: 'noted', raised_by: 'testing' },
        { fingerprint: 'bin/gstack-review-scope:262:logic', path: 'bin/gstack-review-scope', line: 262, severity: 'CRITICAL', blocking: true, action: 'fixed', raised_by: 'red-team' },
        { fingerprint: 'x.ts:5:logic', path: 'x.ts', line: 5, severity: 'CRITICAL', blocking: true, action: 'fixed', raised_by: 'red-team' },
      ]),
      fixCheck(30, []),
    ]);
    const run = path.join(repo.root, 'run');
    pass(path.join(run, 'p1'), [
      ['specialist/testing', '[CRITICAL] src/auth.ts:42 the denied path has no test'],
      ['outside-voice', '1. src/auth.ts:42 an unauthenticated caller reaches the handler. Blocks: yes\nRecommendation: fix 1 because it is open'],
      ['red-team', '[CRITICAL] bin/gstack-review-scope:262 the refusal is skipped\n[CRITICAL] x.ts:5 the guard is inverted'],
    ]);
    pass(path.join(run, 'fix-check'), [['fix-check', '[CRITICAL] x.ts:5 the guard is still inverted\n[CRITICAL] the retry loop never ends']]);
    const s = loop(summary(repo, '--run', run));
    expect(s).toMatchObject({ blocking_found: 4, fixed: 2, noted: 1, unrecorded: 2, ledgers_read: 2 });
  });

  test('judgment decides: a folded duplicate counts once, a lead addition counts, a rejected judgment keeps the collected labels', () => {
    const repo = branchWith([review(0, 1, [])]);
    const run = path.join(repo.root, 'run');
    pass(path.join(run, 'fold'), [['red-team', '[CRITICAL] src/a.ts:3 the guard is inverted\n[CRITICAL] src/a.ts:4 the guard is inverted again']],
      m => [{ id: m[0]!.id, severity: 'CRITICAL' }, { id: m[1]!.id, severity: 'CRITICAL', duplicate_of: m[0]!.id }, { id: 'lead#1', severity: 'CRITICAL', reason: 'src/e.ts:2 the lead found an unchecked write' }]);
    expect(loop(summary(repo, '--run', run))).toMatchObject({ blocking_found: 2, unrecorded: 2, ledgers_read: 1 });
    const rejected = path.join(repo.root, 'rejected');
    fs.mkdirSync(rejected);
    const ledger = path.join(rejected, 'review-ledger.jsonl');
    const mergedFile = path.join(rejected, 'merged.jsonl');
    fs.writeFileSync(mergedFile, '');
    collect(ledger, 'red-team', '[CRITICAL] src/a.ts:3 the guard is inverted', mergedFile);
    const merged = readJsonl<MergedLine>(mergedFile);
    const judgedFile = path.join(rejected, 'judged.jsonl');
    fs.writeFileSync(judgedFile, JSON.stringify({ id: merged[0]!.id, severity: 'INFORMATIONAL' }) + '\n');
    expect(recordJudgment(ledger, merged, [{ id: merged[0]!.id, severity: 'INFORMATIONAL' }], judgedFile, mergedFile).ok).toBe(false);
    expect(loop(summary(repo, '--ledger', ledger))).toMatchObject({ blocking_found: 1, unrecorded: 1, ledgers_read: 1 });
  });

  test('summary refuses REVIEW_SCOPE_LEDGER instead of counting without a ledger it needs, and writes nothing', () => {
    const repo = branchWith([review(0, 1, [])]);
    const run = path.join(repo.root, 'run');
    const ledger = pass(path.join(run, 'p1'), [['red-team', '[CRITICAL] src/a.ts:3 the guard is inverted']]);
    const out = path.join(repo.root, 'loop.json');
    const refused = (r: { status: number | null; err: string }, why: string) => { expect(r.status).toBe(EXIT.fail); expect(r.err).toContain('(REVIEW_SCOPE_LEDGER;'); expect(r.err).toContain(why); expect(fs.existsSync(out)).toBe(false); };
    refused(summary(repo, '--out', out), '--no-ledger when no reader ran through gstack-review-dispatch');
    fs.mkdirSync(path.join(repo.root, 'empty'));
    refused(summary(repo, '--run', path.join(repo.root, 'empty'), '--out', out), 'holds no review-ledger.jsonl');
    refused(summary(repo, '--ledger', path.join(run, 'nope.jsonl'), '--out', out), 'is unreadable');
    const judged = path.join(run, 'p1', 'judged.jsonl');
    const kept = fs.readFileSync(judged, 'utf8');
    fs.writeFileSync(judged, kept.replace('CRITICAL', 'INFORMATIONAL'));
    refused(summary(repo, '--ledger', ledger, '--out', out), 'changed since judge');
    fs.writeFileSync(judged, kept);
    fs.rmSync(path.join(run, 'p1', 'merged.jsonl'));
    refused(summary(repo, '--run', run, '--out', out), 'is unreadable');
    refused(summary(repo, '--run', path.join(repo.root, 'nonesuch'), '--out', out), 'ENOENT');
    const bare = summary(repo, '--out', out, '--ledger');
    expect(bare.err).toContain('(REVIEW_SCOPE_INPUT;');
    expect(bare.err).toContain('--ledger needs a file');
    const both = summary(repo, '--run', run, '--no-ledger');
    expect(both.status).toBe(EXIT.fail);
    expect(both.err).toContain('(REVIEW_SCOPE_INPUT;');
  });
});

describe('GST-986 item 5: fix-check passes and their findings count from the ledgers', () => {
  // #3862 (reconstruction from its PR body; GST-963, pin 0ead1ce50): round 1's red-team CRITICAL sat in pass 1's row unclassified,
  // fixed in be9480829; the first granted fix-check found a CRITICAL, fixed in 0ead1ce50; the second fix-check was clean; the
  // targeted reader then raised 2 informational findings. Only pass 1 had a review-log row, so the receipt's tool counters read
  // blocking_found=0 fixed=0 fix_checks=0 and the lane hand-set blocking_found=2 fixed=2 fix_checks=2 (its third, the docs
  // re-check, ran outside the pass program). The outside voice's findings, which GStack Minder ruled below the floor, are left out.
  // Value: protects=a fix-check that ran through gstack-review-dispatch counts as a round, and a blocker a later fix-check
  //   followed counts as fixed, without a review-log row; fails_when=summary counts fix_checks only from rows, or reports such
  //   blockers as unrecorded; seam=gstack-review-scope summary --run; no_claim=noted (a floor ruling lives only in rows)
  test('#3862: two fix-check ledgers count as fix_checks=2, and the blockers they followed count as fixed', () => {
    const repo = branchWith([review(0, 1, [{ fingerprint: 'lib/tree-receipt.ts:120:logic', raised_by: 'red-team' }])]);
    const run = path.join(repo.root, 'run');
    const step = (dir: string, readers: Array<[string, string]>) => { pass(path.join(run, dir), readers); Bun.sleepSync(5); };
    step('p1', [['specialist-batched', CLEAN], ['red-team', '[CRITICAL] lib/tree-receipt.ts:120 the tree receipt floors the branch\'s own stamp row at the gated VERSION']]);
    step('fc1', [['fix-check', '[CRITICAL] lib/ship-queue-train-stamp.ts:88 the train stamp and verify checks pass no baseRef']]);
    step('fc2', [['fix-check', CLEAN]]);
    step('s11', [['targeted', '- [INFORMATIONAL] lib/stamp-only.ts:14 a comment names the old bound\n- [INFORMATIONAL] lib/stamp-only.ts:30 the side argument has no default test']]);
    const s = loop(summary(repo, '--run', run));
    expect(s).toMatchObject({ passes: 1, blocking_found: 2, fixed: 2, fix_checks: 2, rounds: 3, ledgers_read: 4 });
    expect(s.unrecorded).toBeUndefined();
  });

  // Value: protects=a fix-check with both a row and a ledger counts once, and once every fix-check has its row the rows decide
  //   dispositions (a blocker no row disposes stays unrecorded); fails_when=the ledger count adds to the row count, or a logged
  //   fix-check turns undisposed blockers fixed; seam=gstack-review-scope summary --run
  test('a fix-check counted by row and ledger counts once; with its row logged, undisposed blockers stay unrecorded', () => {
    const repo = branchWith([
      review(0, 1, [{ fingerprint: 'lib/a.ts:5:logic', severity: 'CRITICAL', blocking: true, action: 'deferred', raised_by: 'red-team' }]),
      fixCheck(30, []),
    ]);
    const run = path.join(repo.root, 'run');
    const step = (dir: string, readers: Array<[string, string]>) => { pass(path.join(run, dir), readers); Bun.sleepSync(5); };
    step('p1', [['red-team', '[CRITICAL] lib/a.ts:5 a deferred defect outside the diff\n[CRITICAL] lib/b.ts:9 a fixed defect']]);
    step('fc1', [['fix-check', '[CRITICAL] lib/c.ts:3 the fix broke the caller']]);
    const s = loop(summary(repo, '--run', run));
    expect(s).toMatchObject({ passes: 1, blocking_found: 3, deferred: 1, fixed: 0, fix_checks: 1, rounds: 2, unrecorded: 2 });
  });

  // Value: protects=a blocker the last fix-check raises again is not fixed: only a fix-check after its last occurrence follows it
  //   (round 2 outside voice on this PR: the re-raised blocker read blocking_found=1 fixed=1 with nothing unrecorded);
  //   fails_when=an earlier occurrence's follow-up marks it fixed; seam=gstack-review-scope summary --run
  test('a blocker the last fix-check raises again stays unrecorded', () => {
    const repo = branchWith([review(0, 1, [{ fingerprint: 'lib/a.ts:10:logic', raised_by: 'red-team' }])]);
    const run = path.join(repo.root, 'run');
    const step = (dir: string, readers: Array<[string, string]>) => { pass(path.join(run, dir), readers); Bun.sleepSync(5); };
    step('p1', [['red-team', '[CRITICAL] lib/a.ts:10 the cap is never enforced']]);
    step('fc1', [['fix-check', '[CRITICAL] lib/a.ts:10 the cap is still never enforced']]);
    const s = loop(summary(repo, '--run', run));
    expect(s).toMatchObject({ passes: 1, blocking_found: 1, fixed: 0, fix_checks: 1, unrecorded: 1 });
  });

  // GST-1775 (gbrain#8730): a granted fix-check run with out <run>/p4 left its ledger in p4, and its row was logged
  //   pass:2 skill:review-fix-check, so summary named p4 an unbound pass 4 and the receipt carried unbound=1.
  // Value: protects=a fix-check ledger binds to its review-fix-check row whatever its directory is called;
  //   fails_when=a fix-check ledger named p<N> is read as pass N; seam=gstack-review-scope summary --run
  test('a fix-check ledger in a p<N> directory is a fix-check, never an unbound pass N', () => {
    const repo = branchWith([
      review(0, 1, [{ fingerprint: 'lib/a.ts:10:logic', severity: 'CRITICAL', blocking: true, action: 'fixed', raised_by: 'red-team' }]),
      review(20, 2, []),
      { ...fixCheck(40, []), pass: 2 },
    ]);
    const run = path.join(repo.root, 'run');
    const step = (dir: string, readers: Array<[string, string]>) => { pass(path.join(run, dir), readers); Bun.sleepSync(5); };
    step('p1', [['red-team', '[CRITICAL] lib/a.ts:10 the cap is never enforced']]);
    step('p2', [['red-team', CLEAN]]);
    step('p4', [['fix-check', CLEAN]]);
    const r = summary(repo, '--run', run);
    expect(r.err).not.toContain('REVIEW_SCOPE_UNBOUND');
    const s = loop(r);
    expect(s).toMatchObject({ passes: 2, blocking_found: 1, fixed: 1, fix_checks: 1, rounds: 3, ledgers_read: 3 });
    expect(s.unbound).toBeUndefined();
  });
});
