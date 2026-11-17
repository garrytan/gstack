/**
 * GST-2273: docs/review-policy.md promises that a round-2 loop finishes with "an owner-ruled note ... closed and listed", but
 * only a granted fix-check row (finish, GST-2251) ever read the owner's rulings. A full pass (garrytan/gstack#4248) and a Step 11
 * voice (#4266, #4257) kept a finding open after the owner ruled it. A ruling now names one finding by its ledger id
 * (gstack-approvals rule --id) and closes that finding only on the /ship row that read the ruled head. Each case is a public-safe
 * synthetic reconstruction. The negative controls are every wrong close two cross-family audits found in earlier attempts
 * (#4272 at 36ce6ad, #4435 at e34f9b5): main leaves each of those findings unrecorded or UNVERIFIED, and so must this change.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { collect, readJsonl, recordJudgment, type JudgedLine, type MergedLine } from '../lib/review-ledger';
import { cleanup, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/restamp-fixture';

setDefaultTimeout(90_000);
const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

const OWNER = 'Captain GStack Minder (GSTA-36)';
const CARRY = 'lib/carry.ts:30:outside-voice';
const SINCE = '2026-11-09T00:00:00Z';
const BLOCKER = { fingerprint: CARRY, ledger_id: 'p2/outside-voice#1', severity: 'CRITICAL', action: 'skipped', raised_by: 'outside-voice', blocking: true };

function branch(): FixtureRepo {
  const repo = makeFixtureRepo({ prefix: 'gst2273-' });
  repos.push(repo);
  repo.git('checkout', '-qb', 'feat');
  return repo;
}
const commit = (repo: FixtureRepo, file: string, text: string, msg: string) => {
  fs.mkdirSync(path.dirname(path.join(repo.work, file)), { recursive: true });
  fs.writeFileSync(path.join(repo.work, file), text);
  repo.git('add', '-A'); repo.git('commit', '-qm', msg);
  return repo.git('rev-parse', 'HEAD');
};
const ruling = (repo: FixtureRepo, by: '--id' | '--finding', name: string, head: string) =>
  runBin(repo, 'gstack-approvals', ['rule', by, name, '--head', head, '--reason', 'a heuristic check, strictly better than main; listed as a known limit', '--words', 'ship it as a known limit', '--by', OWNER]);
const ruleId = (repo: FixtureRepo, id: string, head: string) => { const r = ruling(repo, '--id', id, head); expect(r.status, r.err).toBe(0); };
const ruleFingerprint = (repo: FixtureRepo, fingerprint: string, head: string) => { const r = ruling(repo, '--finding', fingerprint, head); expect(r.status, r.err).toBe(0); };
/** Log a /ship review row through the real start and finish, so its binding is the one the logger stamps; between runs mid-read. */
function logRow(repo: FixtureRepo, row: Record<string, unknown>, between?: () => void) {
  const start = runBin(repo, 'gstack-review-log', ['--start', String(row.skill)]);
  expect(start.status, start.err).toBe(0);
  between?.();
  const logged = runBin(repo, 'gstack-review-log', [JSON.stringify({ timestamp: new Date().toISOString(), via: 'ship', review_scope: 'frozen', ...row }), '--finish', start.out.trim().split('\n')[0]!]);
  expect(logged.status, logged.err).toBe(0);
}
const freshness = (repo: FixtureRepo, pass: number) => {
  const r = runBin(repo, 'gstack-review-read', []);
  expect(r.status, r.err).toBe(0);
  const rows = r.out.split('---CONFIG---')[0]!.split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l));
  return rows.filter(x => x.skill === 'review' && x.pass === pass).at(-1)?.review_freshness?.status;
};
/** #4248 (GSTA-492): pass 1, a fix, then round 2's full pass blocked only on its findings, logged skipped, at the branch head. */
function pass2(findings: Record<string, unknown>[] = [BLOCKER], between?: (repo: FixtureRepo) => void) {
  const repo = branch();
  const p1 = commit(repo, 'lib/carry.ts', 'export const carry = 1;\n', 'carry the test check');
  const head = commit(repo, 'lib/carry.ts', 'export const carry = 2;\n', 'fix the round-1 findings');
  logRow(repo, { skill: 'review', status: 'issues_found', issues_found: findings.length, critical: findings.length, informational: 0, findings, completed: true, converged: false, pass: 2, range_base: p1 }, between && (() => between(repo)));
  return { repo, p1, head: between ? repo.git('rev-parse', 'HEAD') : head };
}

// Value: protects=an owner's id ruling closes exactly the one finding it names on a round-2 full-pass row, so the pass reads
//   CURRENT and Step 11.5 can bind it; fails_when=gstack-review-read ignores the ruling, or closes a finding the ruling does not
//   name by its ledger id at the head the row read; seam=gstack-review-read through lib/ruled-notes.ts ruledIds and reviewFreshness
describe('an id ruling closes one finding on a round-2 full-pass row (#4248, GST-2273)', () => {
  test('#4248: the pass reads UNVERIFIED until the owner rules its one blocker by ledger id at the stop head, then CURRENT', () => {
    const { repo, head } = pass2();
    expect(freshness(repo, 2)).toBe('UNVERIFIED');
    ruleId(repo, 'p2/outside-voice#1', head);
    expect(freshness(repo, 2)).toBe('CURRENT');
  });

  test('a fingerprint ruling, the only kind main records, closes nothing new', () => {
    const { repo, head } = pass2();
    ruleFingerprint(repo, CARRY, head);
    ruleFingerprint(repo, 'p2/outside-voice#1', head);
    expect(freshness(repo, 2)).toBe('UNVERIFIED');
  });

  test('audit 36ce6ad (fan-out): a fingerprint two findings share closes neither; each closes only by its own ledger id', () => {
    const { repo, head } = pass2([BLOCKER, { ...BLOCKER, ledger_id: 'p2/outside-voice#2' }]);
    ruleFingerprint(repo, CARRY, head);
    expect(freshness(repo, 2)).toBe('UNVERIFIED');
    ruleId(repo, 'p2/outside-voice#1', head);
    expect(freshness(repo, 2)).toBe('UNVERIFIED');
    ruleId(repo, 'p2/outside-voice#2', head);
    expect(freshness(repo, 2)).toBe('CURRENT');
  });

  test('a ledger id two findings on the row share closes neither', () => {
    const { repo, head } = pass2([BLOCKER, { ...BLOCKER, fingerprint: 'lib/carry.ts:31:outside-voice' }]);
    ruleId(repo, 'p2/outside-voice#1', head);
    expect(freshness(repo, 2)).toBe('UNVERIFIED');
  });

  test('audit 36ce6ad (range variant): a ruling at the range_base, between it and the head, or before the read closes nothing', () => {
    const repo = branch();
    const p1 = commit(repo, 'lib/carry.ts', 'export const carry = 1;\n', 'carry the test check');
    const mid = commit(repo, 'lib/carry.ts', 'export const carry = 2;\n', 'a first fix');
    const head = commit(repo, 'lib/carry.ts', 'export const carry = 3;\n', 'a second fix');
    ruleId(repo, 'p2/outside-voice#1', head);
    logRow(repo, { skill: 'review', status: 'issues_found', issues_found: 1, critical: 1, informational: 0, findings: [BLOCKER], completed: true, converged: false, pass: 2, range_base: p1 });
    expect(freshness(repo, 2)).toBe('UNVERIFIED');
    ruleId(repo, 'p2/outside-voice#1', p1);
    ruleId(repo, 'p2/outside-voice#1', mid);
    expect(freshness(repo, 2)).toBe('UNVERIFIED');
  });

  test('a gate finding is never closed by a ruling', () => {
    const { repo, head } = pass2([{ ...BLOCKER, action: 'open', gate: 'test-weakening' }]);
    ruleId(repo, 'p2/outside-voice#1', head);
    expect(freshness(repo, 2)).toBe('UNVERIFIED');
  });

  test('the lane\'s own claim on its row rules nothing', () => {
    const { repo } = pass2([{ ...BLOCKER, ruled: 'note', ruled_by: OWNER, approval: 'a-6512b24672af' }]);
    expect(freshness(repo, 2)).toBe('UNVERIFIED');
  });

  test('an edit after the ruled head still needs review', () => {
    const { repo, head } = pass2();
    ruleId(repo, 'p2/outside-voice#1', head);
    commit(repo, 'lib/carry.ts', 'export const carry = 3;\n', 'edit after the bound head');
    expect(freshness(repo, 2)).toBe('STALE');
  });

  test('a read whose commit moved while it ran (A to B to A) closes nothing, whatever the owner rules', () => {
    const { repo, head } = pass2(undefined, r => {
      commit(r, 'lib/carry.ts', 'export const carry = 9;\n', 'an edit during the read');
      r.git('revert', '--no-edit', 'HEAD');
    });
    ruleId(repo, 'p2/outside-voice#1', head);
    expect(freshness(repo, 2)).toBe('UNVERIFIED');
  });

  test('a bare id, which restarts in every pass, cannot be ruled', () => {
    const { repo, head } = pass2();
    const r = ruling(repo, '--id', 'outside-voice#1', head);
    expect(r.status).not.toBe(0);
    expect(r.err).toContain('is not a ledger id');
  });
});

const CLEAN = 'NO FINDINGS';
const OUTSIDE_CLEAN = 'No issues found in the diff.\nRecommendation: ship because no finding reaches the floor';
const VOICE = ['1. lib/review-grant.ts:49 A date-only timestamp sorts before the grant, so the grant is reused. Severity: Critical Blocks: yes',
  '2. ship/sections/review-army.md.tmpl:262 A fix-check after round 1 logs a null range_base. Severity: Critical Blocks: yes',
  'Recommendation: fix both because each lets a grant bind where it should not'].join('\n');
function ledger(dir: string, readers: Array<[string, string]>): void {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'review-ledger.jsonl'), mergedFile = path.join(dir, 'merged.jsonl'), judgedFile = path.join(dir, 'judged.jsonl');
  fs.writeFileSync(mergedFile, '');
  for (const [reader, output] of readers) expect(collect(file, reader, output, mergedFile).review).toBe(true);
  const merged = readJsonl<MergedLine>(mergedFile);
  const judged: JudgedLine[] = merged.map(m => ({ id: m.id, severity: m.label }));
  fs.writeFileSync(judgedFile, judged.map(j => JSON.stringify(j) + '\n').join(''));
  expect(recordJudgment(file, merged, judged, judgedFile, mergedFile).ok).toBe(true);
}
const rowsFile = (repo: FixtureRepo) => {
  const dir = path.join(repo.home, 'projects', runBin(repo, 'gstack-slug', ['--get', 'SLUG']).out.trim());
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'feat-reviews.jsonl');
};
/**
 * A run whose rows are written as the logger stamps them, at the branch head: pass 1's row read a minute before, and the newest
 * row (the stop row) read while \`ledgers\` collected its passes. Its read starts and ends at the head it names.
 */
function run(rows: Array<Record<string, unknown>>, ledgers: (out: string) => void) {
  const repo = branch();
  const head = commit(repo, 'lib/review-grant.ts', 'export const grant = 1;\n', 'grant one scoped fix-check');
  const out = path.join(repo.root, 'run');
  const from = Date.now() - 1000;
  ledgers(out);
  const to = Date.now() + 1;
  while (Date.now() <= to + 1) { /* the owner rules after the read ends */ }
  const iso = (ms: number) => new Date(ms).toISOString();
  const bound = (r: Record<string, unknown>, i: number) => {
    const [s, e] = i === rows.length - 1 ? [from, to] : [from - 60_000 * (rows.length - i), from - 60_000 * (rows.length - i) + 30_000];
    return { via: 'ship', review_scope: 'frozen', timestamp: iso(s), commit_full: head, review_binding: { state: 'verified', started_at: iso(s), ended_at: iso(e), start_commit: head }, ...r };
  };
  fs.writeFileSync(rowsFile(repo), rows.map((r, i) => JSON.stringify(bound(r, i)) + '\n').join(''));
  return { repo, head, out };
}
const summary = (repo: FixtureRepo, dir: string) => {
  const r = runBin(repo, 'gstack-review-scope', ['summary', '--since', SINCE, '--json', '--run', dir]);
  expect(r.status, r.err).toBe(EXIT.ok);
  return JSON.parse(r.out);
};
const STEP11 = [{ skill: 'review', pass: 1, status: 'clean', findings: [] }, { skill: 'adversarial-review', status: 'issues_found', completed: true, converged: true }];
const voices = (output: string) => (out: string) => {
  ledger(path.join(out, 'p1'), [['red-team', CLEAN]]);
  ledger(path.join(out, 'p1-voices'), [['adversarial-native', CLEAN], ['outside-voice', output]]);
};

// Value: protects=an id ruling closes a Step 11 voice finding no row records, so the receipt's review_loop counts it a noted
//   disclosure instead of unrecorded, and closes nothing it does not name; fails_when=summary ignores id rulings, or a ruling
//   by fingerprint, at another head, from another row or at a shared id closes one; seam=bin/gstack-review-scope summary
describe('an id ruling closes one Step 11 voice finding (#4266, #4257, GST-2273)', () => {
  test('#4266: two outside-voice CRITICALs ruled by ledger id at the Step 11 head are noted, not unrecorded', () => {
    const { repo, head, out } = run(STEP11, voices(VOICE));
    expect(summary(repo, out)).toMatchObject({ blocking_found: 2, noted: 0, unrecorded: 2 });
    ruleId(repo, 'p1-voices/outside-voice#1', head);
    expect(summary(repo, out)).toMatchObject({ noted: 1, unrecorded: 1 });
    ruleId(repo, 'p1-voices/outside-voice#2', head);
    const s = summary(repo, out);
    expect(s).toMatchObject({ blocking_found: 2, noted: 2 });
    expect(s.unrecorded).toBeUndefined();
  });

  test('#4266 as main records it: fingerprint rulings at the Step 11 head close nothing', () => {
    const { repo, head, out } = run(STEP11, voices(VOICE));
    for (const f of ['lib/review-grant.ts:49:outside-voice', 'ship/sections/review-army.md.tmpl:262:outside-voice', 'p1-voices/outside-voice#1', 'outside-voice#2']) ruleFingerprint(repo, f, head);
    expect(summary(repo, out)).toMatchObject({ noted: 0, unrecorded: 2 });
  });

  test('#4257: a Step 9 pass finding the stop row did not read stays unrecorded; the Step 11 one it read is noted', () => {
    const { repo, head, out } = run(STEP11, o => {
      ledger(path.join(o, 'p1'), [['red-team', '1. lib/ci-carry.ts:151 The carry reads a stale attempt. Severity: Critical Blocks: yes\nRecommendation: fix 1']]);
      ledger(path.join(o, 'p1-voices'), [['outside-voice', OUTSIDE_CLEAN], ['adversarial-native', 'lib/run-evidence.ts:172 The gate reads the first attempt. FIXABLE\nRecommendation: fix because a rerun hides the failure']]);
    });
    expect(summary(repo, out)).toMatchObject({ blocking_found: 2, unrecorded: 2 });
    ruleId(repo, 'p1-voices/adversarial-native#1', head);
    expect(summary(repo, out)).toMatchObject({ noted: 1, unrecorded: 1 });
  });

  test('a ruling at an earlier head closes nothing a later Step 11 voice found', () => {
    const repo = branch();
    const head = commit(repo, 'lib/review-grant.ts', 'export const grant = 1;\n', 'grant one scoped fix-check');
    logRow(repo, { skill: 'review', pass: 1, status: 'clean', findings: [], completed: true, converged: true });
    const later = commit(repo, 'lib/review-grant.ts', 'export const grant = 2;\n', 'a round-2 fix');
    const out = path.join(repo.root, 'run');
    logRow(repo, { skill: 'adversarial-review', status: 'issues_found', completed: true, converged: true }, () => voices(VOICE)(out));
    ruleId(repo, 'p1-voices/outside-voice#1', head);
    expect(summary(repo, out)).toMatchObject({ noted: 0, unrecorded: 2 });
    ruleId(repo, 'p1-voices/outside-voice#1', later);
    expect(summary(repo, out)).toMatchObject({ noted: 1, unrecorded: 1 });
  });

  test('audit 36ce6ad: a later review row not run by /ship does not choose the rulings the summary applies', () => {
    const { repo, head, out } = run(STEP11, voices(VOICE));
    const base = repo.git('merge-base', 'main', 'HEAD');
    fs.appendFileSync(rowsFile(repo), JSON.stringify({ skill: 'adversarial-review', timestamp: new Date().toISOString(), commit_full: base, status: 'clean', completed: true, converged: true, review_binding: { state: 'verified', started_at: new Date(Date.now() - 5000).toISOString(), ended_at: new Date(Date.now() - 1).toISOString(), start_commit: base } }) + '\n');
    ruleId(repo, 'p1-voices/outside-voice#1', base);
    expect(summary(repo, out)).toMatchObject({ noted: 0, unrecorded: 2 });
    ruleId(repo, 'p1-voices/outside-voice#1', head);
    expect(summary(repo, out)).toMatchObject({ noted: 1, unrecorded: 1 });
  });

  test('audit 36ce6ad: Step 11 voice findings at one shared line close only by their own ledger ids', () => {
    const { repo, head, out } = run(STEP11, voices(['1. lib/review-grant.ts:49 A date-only timestamp sorts before the grant. Severity: Critical Blocks: yes',
      '2. lib/review-grant.ts:49 The grant id is never checked against the head. Severity: Critical Blocks: yes', 'Recommendation: fix both because each lets a grant bind where it should not'].join('\n')));
    ruleFingerprint(repo, 'lib/review-grant.ts:49:outside-voice', head);
    expect(summary(repo, out)).toMatchObject({ blocking_found: 2, noted: 0, unrecorded: 2 });
    ruleId(repo, 'p1-voices/outside-voice#1', head);
    expect(summary(repo, out)).toMatchObject({ noted: 1, unrecorded: 1 });
  });

  test('a Step 11 voice gate finding no row records stays unrecorded whatever the owner rules; a non-gate one is noted', () => {
    const { repo, head, out } = run(STEP11, voices(['1. test/review-grant.test.ts:12 RH-1 the grant test is skipped, so the gate never runs. Severity: Critical Blocks: yes',
      '2. lib/review-grant.ts:49 A date-only timestamp sorts before the grant. Severity: Critical Blocks: yes', 'Recommendation: fix both because each lets a grant bind where it should not'].join('\n')));
    expect(summary(repo, out)).toMatchObject({ blocking_found: 2, noted: 0, unrecorded: 2 });
    ruleId(repo, 'p1-voices/outside-voice#1', head);
    ruleId(repo, 'p1-voices/outside-voice#2', head);
    ruleFingerprint(repo, 'test/review-grant.test.ts:12:outside-voice', head);
    expect(summary(repo, out)).toMatchObject({ noted: 1, unrecorded: 1 });
  });
});

// The three wrong closes the cross-family audit of #4435 at e34f9b5 demonstrated (handoffs/GSTA-495/sol-audit-4435-e34f9b5.md):
// each fixture logs its row through the real logger and the real approval writer, and main leaves each finding unrecorded.
const FP = 'lib/review-grant.ts:49:outside-voice';
function shipRow(findings: Record<string, unknown>[]) {
  const repo = branch();
  const head = commit(repo, 'lib/review-grant.ts', 'export const grant = 1;\n', 'grant one scoped fix-check');
  logRow(repo, { skill: 'review', pass: 1, status: findings.length ? 'issues_found' : 'clean', issues_found: findings.length, critical: findings.filter(f => f.severity === 'CRITICAL').length, informational: 0, findings, completed: true, converged: true });
  return { repo, head, out: path.join(repo.root, 'run') };
}

// Value: protects=a ruling never closes a finding it does not name at the head it names, or a gate finding (the #4435 audit);
//   fails_when=a paired ledger line's gate is dropped, a fingerprint shared with a nonblocking finding reads as unique, or an old
//   stop row's ruling closes a finding collected after a later commit; seam=bin/gstack-review-scope summary through summarizeReviewLoop
describe('a ruling closes nothing the #4435 audit showed it must not (GST-2273)', () => {
  test('audit e34f9b5 #1: a row finding whose paired ledger line names a gate stays unrecorded under an id ruling', () => {
    const gated = shipRow([{ fingerprint: FP, ledger_id: 'p1/outside-voice#1', severity: 'CRITICAL', raised_by: 'outside-voice', blocking: true }]);
    ledger(path.join(gated.out, 'p1'), [['outside-voice', '1. lib/review-grant.ts:49 RH-1 the grant test is skipped, so the gate never runs. Severity: Critical Blocks: yes\nRecommendation: fix the gate']]);
    expect(summary(gated.repo, gated.out)).toMatchObject({ noted: 0, unrecorded: 1 });
    ruleFingerprint(gated.repo, 'p1/outside-voice#1', gated.head);
    ruleId(gated.repo, 'p1/outside-voice#1', gated.head);
    expect(summary(gated.repo, gated.out)).toMatchObject({ noted: 0, unrecorded: 1 });

    const plain = shipRow([{ fingerprint: FP, ledger_id: 'p1/outside-voice#1', severity: 'CRITICAL', raised_by: 'outside-voice', blocking: true }]);
    ledger(path.join(plain.out, 'p1'), [['outside-voice', '1. lib/review-grant.ts:49 the grant test is skipped. Severity: Critical Blocks: yes\nRecommendation: fix the test']]);
    ruleId(plain.repo, 'p1/outside-voice#1', plain.head);
    const s = summary(plain.repo, plain.out);
    expect(s).toMatchObject({ noted: 1 });
    expect(s.unrecorded).toBeUndefined();
  });

  test('audit e34f9b5 #2: a fingerprint shared with a nonblocking finding closes nothing; the blocker closes by its ledger id', () => {
    const { repo, head, out } = shipRow([
      { fingerprint: FP, ledger_id: 'p1/outside-voice#1', severity: 'CRITICAL', raised_by: 'outside-voice', blocking: true },
      { fingerprint: FP, ledger_id: 'p1/outside-voice#2', severity: 'INFORMATIONAL', action: 'skipped', raised_by: 'outside-voice', blocking: false },
    ]);
    ledger(path.join(out, 'p1'), [['outside-voice', '1. lib/review-grant.ts:49 The grant id is never checked against the head. Severity: Critical Blocks: yes\n2. lib/review-grant.ts:49 The failure text is confusing. Severity: Informational Blocks: no\nRecommendation: fix the head check']]);
    expect(summary(repo, out)).toMatchObject({ noted: 0, unrecorded: 1 });
    ruleFingerprint(repo, FP, head);
    expect(summary(repo, out)).toMatchObject({ noted: 0, unrecorded: 1 });
    ruleId(repo, 'p1/outside-voice#1', head);
    const s = summary(repo, out);
    expect(s).toMatchObject({ noted: 1 });
    expect(s.unrecorded).toBeUndefined();
  });

  test('audit e34f9b5 #3: an old stop row\'s ruling closes no ledger-only finding collected after a later commit', () => {
    const { repo, head, out } = shipRow([]);
    ruleFingerprint(repo, FP, head);
    ruleId(repo, 'p1-voices/outside-voice#1', head);
    commit(repo, 'lib/review-grant.ts', 'export const grant = 2;\n', 'a later fix introduces the grant defect');
    ledger(path.join(out, 'p1'), [['red-team', 'NO FINDINGS']]);
    ledger(path.join(out, 'p1-voices'), [['outside-voice', '1. lib/review-grant.ts:49 A new defect in the later fix bypasses the head check. Severity: Critical Blocks: yes\nRecommendation: fix the later change']]);
    expect(summary(repo, out)).toMatchObject({ noted: 0, unrecorded: 1 });
    ruleId(repo, 'p1-voices/outside-voice#1', head);
    expect(summary(repo, out)).toMatchObject({ noted: 0, unrecorded: 1 });
  });
});
