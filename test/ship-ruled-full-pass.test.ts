/**
 * GST-2273: docs/review-policy.md promises that a round-2 loop finishes with "an owner-ruled note ... closed and listed", but
 * only a granted fix-check row (finish, GST-2251) ever read the owner's rulings. A full pass (garrytan/gstack#4248) and a Step 11
 * voice (#4266, #4257) kept the finding open after the owner ruled it, and a ruling recorded on another machine showed only to a
 * shell with GSTACK_CAPY=1. Each case below is a public-safe synthetic reconstruction of that PR's shape, with the negative
 * controls the binding rules need: an unruled blocker, a ruling outside the reviewed range, a gate finding, the lane's own claim,
 * an edit after the bound head and a read whose commit moved while it ran.
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
const CARRY = 'lib/ship-carry-tests.ts:30:outside-voice';
const SINCE = '2026-11-09T00:00:00Z';

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
const rule = (repo: FixtureRepo, finding: string, head: string, env: Record<string, string> = {}) =>
  runBin(repo, 'gstack-approvals', ['rule', '--finding', finding, '--head', head, '--reason', 'a heuristic check, strictly better than main; listed as a known limit', '--words', 'ship it as a known limit', '--by', OWNER], env);
/** Log a /ship review row through the real start and finish, so its binding is the one the logger stamps; `between` runs mid-read. */
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

/** #4248 (GSTA-492): pass 1, a fix, then round 2's full pass blocked only on one narrowed outside-voice CRITICAL, logged skipped. */
function pass2(finding: Record<string, unknown> = { fingerprint: CARRY, severity: 'CRITICAL', action: 'skipped', raised_by: 'outside-voice', blocking: true }, between?: (repo: FixtureRepo) => void) {
  const repo = branch();
  const p1 = commit(repo, 'lib/carry.ts', 'export const carry = 1;\n', 'carry the test check');
  const head = commit(repo, 'lib/carry.ts', 'export const carry = 2;\n', 'fix the round-1 findings');
  logRow(repo, { skill: 'review', status: 'issues_found', issues_found: 1, critical: 1, informational: 0, findings: [finding], completed: true, converged: false, pass: 2, range_base: p1 }, between && (() => between(repo)));
  return { repo, p1, head: between ? repo.git('rev-parse', 'HEAD') : head };
}

// Value: protects=an owner ruling closes a finding on a round-2 full-pass row, as docs/review-policy.md promises, so the pass
//   reads CURRENT and Step 11.5 can bind it; fails_when=gstack-review-read ignores the ruling (UNVERIFIED) or closes a finding
//   without one; seam=gstack-review-read through lib/ruled-notes.ts rulingsFor and reviewFreshness
describe('a ruling closes a finding on a round-2 full-pass row (#4248, GST-2273)', () => {
  test('#4248: the pass reads UNVERIFIED until the owner rules its one blocker at the stop head, then CURRENT', () => {
    const { repo, head } = pass2();
    expect(freshness(repo, 2)).toBe('UNVERIFIED');
    expect(rule(repo, CARRY, head).status).toBe(0);
    expect(freshness(repo, 2)).toBe('CURRENT');
  });

  test('a ruling at a head before the pass\'s range_base closes nothing', () => {
    const { repo } = pass2();
    expect(rule(repo, CARRY, repo.git('merge-base', 'main', 'HEAD')).status).toBe(0);
    expect(freshness(repo, 2)).toBe('UNVERIFIED');
  });

  test('a gate finding is never closed by a ruling', () => {
    const { repo, head } = pass2({ fingerprint: CARRY, severity: 'CRITICAL', action: 'open', raised_by: 'outside-voice', blocking: true, gate: 'test-weakening' });
    expect(rule(repo, CARRY, head).status).toBe(0);
    expect(freshness(repo, 2)).toBe('UNVERIFIED');
  });

  test('the lane\'s own claim on its row rules nothing', () => {
    const { repo } = pass2({ fingerprint: CARRY, severity: 'CRITICAL', action: 'skipped', raised_by: 'outside-voice', blocking: true, ruled: 'note', ruled_by: OWNER, approval: 'a-6512b24672af' });
    expect(freshness(repo, 2)).toBe('UNVERIFIED');
  });

  test('an edit after the ruled head still needs review', () => {
    const { repo, head } = pass2();
    expect(rule(repo, CARRY, head).status).toBe(0);
    commit(repo, 'lib/carry.ts', 'export const carry = 3;\n', 'edit after the bound head');
    expect(freshness(repo, 2)).toBe('STALE');
  });

  test('a read whose commit moved while it ran (A to B to A) does not bind, whatever the owner rules', () => {
    const { repo, head } = pass2(undefined, r => {
      commit(r, 'lib/carry.ts', 'export const carry = 9;\n', 'an edit during the read');
      r.git('revert', '--no-edit', 'HEAD');
    });
    expect(rule(repo, CARRY, head).status).toBe(0);
    expect(freshness(repo, 2)).toBe('UNVERIFIED');
  });
});
const CLEAN = 'NO FINDINGS';
const OUTSIDE_CLEAN = 'No issues found in the diff.\nRecommendation: ship because no finding reaches the floor';
const at = (min: number) => new Date(Date.parse(SINCE) + min * 60_000).toISOString();
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
/** A run's rows, written as the logger stamps them: each at the branch head, bound verified. */
function run(rows: Array<Record<string, unknown>>) {
  const repo = branch();
  const head = commit(repo, 'lib/review-grant.ts', 'export const grant = 1;\n', 'grant one scoped fix-check');
  const slug = runBin(repo, 'gstack-slug', ['--get', 'SLUG']).out.trim();
  const dir = path.join(repo.home, 'projects', slug);
  fs.mkdirSync(dir, { recursive: true });
  const bound = (r: Record<string, unknown>, i: number) => ({ via: 'ship', review_scope: 'frozen', timestamp: at(i * 10), commit_full: head, review_binding: { state: 'verified', started_at: at(i * 10) }, ...r });
  fs.writeFileSync(path.join(dir, 'feat-reviews.jsonl'), rows.map((r, i) => JSON.stringify(bound(r, i)) + '\n').join(''));
  return { repo, head, out: path.join(repo.root, 'run') };
}
const summary = (repo: FixtureRepo, dir: string) => {
  const r = runBin(repo, 'gstack-review-scope', ['summary', '--since', SINCE, '--json', '--run', dir]);
  expect(r.status, r.err).toBe(EXIT.ok);
  return JSON.parse(r.out);
};
const VOICE = ['1. lib/review-grant.ts:49 A date-only timestamp sorts before the grant, so the grant is reused. Severity: Critical Blocks: yes',
  '2. ship/sections/review-army.md.tmpl:262 A fix-check after round 1 logs a null range_base. Severity: Critical Blocks: yes',
  'Recommendation: fix both because each lets a grant bind where it should not'].join('\n');

// Value: protects=a ruling closes a Step 11 voice finding no row records, so the receipt's review_loop stops counting it
//   unrecorded and counts it a noted disclosure; fails_when=summary ignores rulings, or a ruling at a head outside the run's
//   rows closes it; seam=bin/gstack-review-scope summary through rulingsFor and summarizeReviewLoop
describe('a ruling closes a Step 11 voice finding (#4266, #4257, GST-2273)', () => {
  test('#4266: two outside-voice CRITICALs ruled by fingerprint at the Step 11 head are noted, not unrecorded', () => {
    const { repo, head, out } = run([{ skill: 'review', pass: 1, status: 'clean', findings: [] }, { skill: 'adversarial-review', status: 'issues_found', completed: true, converged: true }]);
    ledger(path.join(out, 'p1'), [['red-team', CLEAN]]);
    ledger(path.join(out, 'p1-voices'), [['adversarial-native', CLEAN], ['outside-voice', VOICE]]);
    expect(summary(repo, out)).toMatchObject({ blocking_found: 2, noted: 0, unrecorded: 2 });
    for (const f of ['lib/review-grant.ts:49:outside-voice', 'ship/sections/review-army.md.tmpl:262:outside-voice']) expect(rule(repo, f, head).status).toBe(0);
    const s = summary(repo, out);
    expect(s).toMatchObject({ blocking_found: 2, noted: 2 });
    expect(s.unrecorded).toBeUndefined();
  });

  test('#4257: two disproved Step 11 findings no row recorded close by ledger id; one ruling leaves the other unrecorded', () => {
    const { repo, head, out } = run([{ skill: 'review', pass: 1, status: 'clean', findings: [] }, { skill: 'adversarial-review', status: 'issues_found', completed: true, converged: true }]);
    ledger(path.join(out, 'p1'), [['red-team', '1. lib/ci-carry.ts:151 The carry reads a stale attempt. Severity: Critical Blocks: yes\nRecommendation: fix 1']]);
    ledger(path.join(out, 'p1-voices'), [['outside-voice', OUTSIDE_CLEAN], ['adversarial-native', 'lib/run-evidence.ts:172 The gate reads the first attempt. FIXABLE\nRecommendation: fix because a rerun hides the failure']]);
    expect(summary(repo, out)).toMatchObject({ blocking_found: 2, unrecorded: 2 });
    expect(rule(repo, 'p1/red-team#1', head).status).toBe(0);
    expect(summary(repo, out)).toMatchObject({ noted: 1, unrecorded: 1 });
    expect(rule(repo, 'p1-voices/adversarial-native#1', head).status).toBe(0);
    expect(summary(repo, out).unrecorded).toBeUndefined();
  });

  test('a bare ledger id, which restarts in every pass, closes nothing', () => {
    const { repo, head, out } = run([{ skill: 'review', pass: 1, status: 'clean', findings: [] }, { skill: 'adversarial-review', status: 'issues_found', completed: true, converged: true }]);
    ledger(path.join(out, 'p1'), [['red-team', CLEAN]]);
    ledger(path.join(out, 'p1-voices'), [['adversarial-native', CLEAN], ['outside-voice', VOICE]]);
    expect(rule(repo, 'outside-voice#1', head).status).toBe(0);
    expect(summary(repo, out)).toMatchObject({ noted: 0, unrecorded: 2 });
  });

  test('a ruling at an earlier head closes nothing a later Step 11 voice found', () => {
    const { repo, head, out } = run([{ skill: 'review', pass: 1, status: 'clean', findings: [] }]);
    const later = commit(repo, 'lib/review-grant.ts', 'export const grant = 2;\n', 'a round-2 fix');
    const slug = runBin(repo, 'gstack-slug', ['--get', 'SLUG']).out.trim();
    fs.appendFileSync(path.join(repo.home, 'projects', slug, 'feat-reviews.jsonl'), JSON.stringify({ skill: 'adversarial-review', via: 'ship', timestamp: at(30), commit_full: later, status: 'issues_found', completed: true, converged: true, review_binding: { state: 'verified', started_at: at(30) } }) + '\n');
    ledger(path.join(out, 'p1'), [['red-team', CLEAN]]);
    ledger(path.join(out, 'p1-voices'), [['adversarial-native', CLEAN], ['outside-voice', VOICE]]);
    for (const f of ['lib/review-grant.ts:49:outside-voice', 'ship/sections/review-army.md.tmpl:262:outside-voice']) expect(rule(repo, f, head).status).toBe(0);
    expect(summary(repo, out)).toMatchObject({ noted: 0, unrecorded: 2 });
    for (const f of ['lib/review-grant.ts:49:outside-voice', 'ship/sections/review-army.md.tmpl:262:outside-voice']) expect(rule(repo, f, later).status).toBe(0);
    expect(summary(repo, out).unrecorded).toBeUndefined();
  });

  test('a ruling at a head no row of the run read closes nothing', () => {
    const { repo, out } = run([{ skill: 'review', pass: 1, status: 'clean', findings: [] }, { skill: 'adversarial-review', status: 'issues_found', completed: true, converged: true }]);
    ledger(path.join(out, 'p1'), [['red-team', CLEAN]]);
    ledger(path.join(out, 'p1-voices'), [['adversarial-native', CLEAN], ['outside-voice', VOICE]]);
    const base = repo.git('merge-base', 'main', 'HEAD');
    for (const f of ['lib/review-grant.ts:49:outside-voice', 'ship/sections/review-army.md.tmpl:262:outside-voice']) expect(rule(repo, f, base).status).toBe(0);
    expect(summary(repo, out)).toMatchObject({ noted: 0, unrecorded: 2 });
  });
});

// Value: protects=a ruling recorded on the lane's machine reaches the /ship machine through the Drive mirror whether or not the
//   shell set GSTACK_CAPY=1 (#4266 printed RULED_NOTES: none without it); fails_when=the mirror is read only under
//   GSTACK_CAPY=1, or a shell without it writes the Drive; seam=lib/approval-record.ts locate behind gstack-approvals rulings
describe('rulings read the same with or without GSTACK_CAPY=1 (#4266, GST-2273)', () => {
  test('a ruling mirrored from another machine lists with and without GSTACK_CAPY=1', () => {
    const repo = branch();
    const head = commit(repo, 'lib/review-grant.ts', 'export const grant = 1;\n', 'grant one scoped fix-check');
    const home = path.join(repo.root, 'drive-home');
    const drive = path.join(home, '.capy', 'drive', 'project-user-fixture-owner');
    fs.mkdirSync(drive, { recursive: true });
    const lane = { HOME: home, GSTACK_CAPY: '1', GSTACK_STATE_ROOT: path.join(repo.root, 'lane-state'), GSTACK_HOME: path.join(repo.root, 'lane-state') };
    expect(rule(repo, 'lib/review-grant.ts:49:outside-voice', head, lane).status).toBe(0);
    const ship = { HOME: home, GSTACK_STATE_ROOT: path.join(repo.root, 'ship-state'), GSTACK_HOME: path.join(repo.root, 'ship-state') };
    const listed = (env: Record<string, string>) => runBin(repo, 'gstack-approvals', ['rulings'], env).out.trim().split('\n');
    expect(listed({ ...ship, GSTACK_CAPY: '1' })).toEqual([expect.stringMatching(/^Ruled note: lib\/review-grant\.ts:49:outside-voice at /)]);
    expect(listed({ ...ship, GSTACK_CAPY: '' })).toEqual(listed({ ...ship, GSTACK_CAPY: '1' }));
    const before = fs.readdirSync(drive, { recursive: true }).length;
    expect(rule(repo, 'ship/sections/review-army.md.tmpl:262:outside-voice', head, { ...ship, GSTACK_CAPY: '' }).status).toBe(0);
    expect(fs.readdirSync(drive, { recursive: true }).length).toBe(before);
  });
});
