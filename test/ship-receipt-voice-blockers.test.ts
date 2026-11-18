/**
 * GST-3075: a /ship receipt written at a stopped head read blocking_found=0 while the second-model review's
 * `Blocks: yes` findings had stopped the run. Step 11's voice findings reached no review-log row (only a later
 * Step 9 row carries queued Step 11 records, and a run that stops after Step 11 logs none), so
 * `gstack-review-scope summary --no-ledger` counted nothing and write recorded the undercount.
 * Synthetic fixture: one clean Step 9 pass, then the Step 11 row as /ship now logs it.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { summarizeReviewLoop } from '../lib/review-scope';
import { extractReceipt, unruledOpenBlockers } from '../lib/ship-receipt';
import { cleanup, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/restamp-fixture';

setDefaultTimeout(60_000);
const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

const SINCE = '2026-11-18T01:00:00Z';
const at = (min: number) => new Date(Date.parse(SINCE) + min * 60_000).toISOString();
const FP = 'src/auth.ts:42:security';
const review = (min: number, pass: number, findings: object[]) => ({ skill: 'review', via: 'ship', timestamp: at(min), status: findings.length ? 'issues_found' : 'clean', review_scope: 'frozen', pass, findings });
const voices = (min: number, findings: object[]) => ({ skill: 'adversarial-review', via: 'ship', timestamp: at(min), status: 'issues_found', source: 'outside-voice', phase: 'adversarial', gate: 'informational', completed: true, findings });
const blocker = { fingerprint: FP, severity: 'CRITICAL', blocking: true, raised_by: 'outside-voice', action: 'open' };
const belowFloor = { fingerprint: FP, severity: 'INFORMATIONAL', blocking: false, raised_by: 'outside-voice', action: 'noted' };

function branchWith(rows: object[]): FixtureRepo {
  const repo = makeFixtureRepo({ prefix: 'gst3075-' });
  repos.push(repo);
  repo.git('checkout', '-qb', 'feat');
  const slug = runBin(repo, 'gstack-slug', ['--get', 'SLUG']).out.trim();
  const logDir = path.join(repo.home, 'projects', slug);
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, 'feat-reviews.jsonl'), rows.map(r => JSON.stringify(r) + '\n').join(''));
  return repo;
}

/** /ship Step 19's two commands: the summary (--no-ledger, as ship/sections/pr-body.md runs it), then write. */
function summaryThenWrite(repo: FixtureRepo) {
  const loopFile = path.join(repo.root, 'review-loop.json');
  const s = runBin(repo, 'gstack-review-scope', ['summary', '--since', SINCE, '--no-ledger', '--out', loopFile]);
  expect(s.status).toBe(EXIT.ok);
  const body = path.join(repo.root, 'body.md');
  fs.writeFileSync(body, '## Summary\n');
  const w = runBin(repo, 'gstack-ship-receipt', ['write', '--pr', '42', '--base', 'main', '--session-kind', 'unattended', '--review-loop', '@' + loopFile, '--body', body]);
  return { loop: JSON.parse(fs.readFileSync(loopFile, 'utf8')), w, body: fs.readFileSync(body, 'utf8') };
}

describe('GST-3075: the receipt counts the voices\' blockers and refuses one still open', () => {
  test('a Blocks: yes voice finding left open at the stop counts in blocking_found, and write refuses with RECEIPT_BLOCKER_OPEN', () => {
    const { loop, w, body } = summaryThenWrite(branchWith([review(0, 1, []), voices(20, [blocker])]));
    expect(loop).toMatchObject({ passes: 1, blocking_found: 1, rounds: 1, open: [FP] });
    expect(w.status).toBe(EXIT.refused);
    expect(w.err).toContain('(RECEIPT_BLOCKER_OPEN; ');
    expect(w.err).toContain('docs/troubleshooting.md#receipt-blocker-open)');
    expect(w.err).toContain(FP);
    expect(w.out).toBe('');
    expect(body).toBe('## Summary\n');
  });

  test('negative control: a Blocks: no voice finding leaves blocking_found at 0 and the receipt is written', () => {
    const { loop, w } = summaryThenWrite(branchWith([review(0, 1, []), voices(20, [belowFloor])]));
    expect(loop).toMatchObject({ passes: 1, blocking_found: 0 });
    expect(loop.open).toBeUndefined();
    expect(w.status).toBe(EXIT.ok);
    expect(extractReceipt(w.out).receipt).toMatchObject({ review_loop: { passes: 1, blocking_found: 0 } });
  });

  test('a voice blocker the next Step 9 pass fixed counts once as found and fixed, and the receipt is written', () => {
    const { loop, w } = summaryThenWrite(branchWith([review(0, 1, []), voices(20, [blocker]), review(40, 2, [{ ...blocker, action: 'fixed' }])]));
    expect(loop).toMatchObject({ passes: 2, blocking_found: 1, fixed: 1, rounds: 2 });
    expect(loop.open).toBeUndefined();
    expect(w.status).toBe(EXIT.ok);
    expect(extractReceipt(w.out).receipt).toMatchObject({ review_loop: { blocking_found: 1, fixed: 1 } });
  });

  test('a voice row is never a pass or a round, a deferred or gate finding is not open, and an owner ruling closes one', () => {
    const s = summarizeReviewLoop([review(0, 1, []), voices(20, [blocker, { fingerprint: 'a.ts:1:gate', severity: 'CRITICAL', blocking: true, gate: 'RH1', action: 'open' }]), { skill: 'review-late-defer', via: 'ship', timestamp: at(30), findings: [{ ...blocker, action: 'deferred' }] }], SINCE);
    expect(s).toMatchObject({ passes: 1, rounds: 1, blocking_found: 2, deferred: 1 });
    expect(s.open).toBeUndefined();
    expect(unruledOpenBlockers({ open: [FP, 'p3/outside-voice#2'] }, [{ finding: FP }])).toEqual(['p3/outside-voice#2']);
    expect(unruledOpenBlockers({ passes: 1 }, [])).toEqual([]);
  });

  test('a blocker a Step 9 row fixed and the next Step 11 row raised again stays open', () => {
    const s = summarizeReviewLoop([review(0, 1, []), voices(20, [blocker]), review(40, 2, [{ ...blocker, action: 'fixed' }]), voices(60, [blocker])], SINCE);
    expect(s).toMatchObject({ passes: 2, blocking_found: 1, open: [FP] });
  });

  test('a fix trailer from before the Step 11 row that raised the blocker again does not close it', () => {
    const rows = [review(0, 1, [{ ...blocker, action: 'fixed' }]), voices(20, [blocker])];
    const s = summarizeReviewLoop(rows, SINCE, [], [], [{ finding: FP, reader: 'outside-voice', commit: 'a'.repeat(40) }]);
    expect(s).toMatchObject({ blocking_found: 1, fixed: 1, open: [FP] });
    expect(summarizeReviewLoop([...rows, review(40, 2, [{ ...blocker, action: 'fixed' }])], SINCE).open).toBeUndefined();
  });

  test('a ruling on the fingerprint closes a blocker that carries a ledger id, and a ruling at another head does not', () => {
    const s = summarizeReviewLoop([review(0, 1, []), voices(20, [{ ...blocker, ledger_id: 'p1/outside-voice#1' }])], SINCE);
    expect(s.open).toEqual([{ id: 'p1/outside-voice#1', fingerprint: FP }]);
    expect(unruledOpenBlockers({ open: s.open }, [{ finding: FP, head: 'abc' }], h => h === 'abc')).toEqual([]);
    expect(unruledOpenBlockers({ open: s.open }, [{ finding: FP, head: 'old' }], h => h === 'abc')).toEqual(['p1/outside-voice#1']);
  });
});
