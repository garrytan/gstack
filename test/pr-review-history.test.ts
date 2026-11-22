/**
 * GST-2673: /ship counts review rounds per pull request, across every head and /ship run, from the receipt and the
 * receipt-runs history the PR body already keeps (docs/review-policy.md#rounds-per-pull-request).
 */
import { describe, expect, test } from 'bun:test';
import { historyLine, placeRunEntry, prReviewHistory, reviewRoute } from '../lib/pr-review-history';
import { mergeBodySections } from '../lib/gstack-post';
import { orderReceipt, placeReceipt, receiptRun, receiptRuns } from '../lib/ship-receipt';
import type { ShipReceipt } from '../lib/headless-artifacts';

const sha = (c: string) => c.repeat(40);
const loop = (l: Partial<NonNullable<ShipReceipt['review_loop']>>) => ({ passes: 1, blocking_found: 0, deferred: 0, ...l });
const receipt = (head: string, l: Partial<NonNullable<ShipReceipt['review_loop']>> = {}, extra: Partial<ShipReceipt> = {}): ShipReceipt =>
  orderReceipt({ schema_version: 1, head, base: 'main', version: '1.0.0.0', review_loop: loop(l), ...extra });
const carried = (r: ShipReceipt, head: string, reason: string): ShipReceipt =>
  orderReceipt({ ...r, head, carry: { from: r.carry?.from ?? r.head, reason, product_patch_id: 'x', changed_paths: [], merge_commits: 0, range_diff: '', covers: [], reruns: [] } });

describe('prReviewHistory', () => {
  test('a body with no receipt has no history', () => {
    expect(prReviewHistory('## Summary\nprose\n')).toMatchObject({ rounds: 0, full: 0, runs: 0, first_full: null, source: 'pr-body' });
  });

  test('rounds follow R51 (passes, never fix-checks) summed across /ship runs, not the largest run', () => {
    let body = placeReceipt('', receipt(sha('a'), { passes: 1, fix_checks: 1, rounds: 2 }, { run: 'r1' }));
    body = placeReceipt(body, receipt(sha('b'), { passes: 1, fix_checks: 1, rounds: 2 }, { run: 'r2' }));
    const h = prReviewHistory(body);
    expect(h).toMatchObject({ runs: 2, rounds: 2, full: 2, fix_checks: 2, first_full: sha('a'), last_full: sha('b') });
  });

  test('a scoped pass 2 is a round but not a full round', () => {
    const h = prReviewHistory(placeReceipt('', receipt(sha('a'), { passes: 2, scoped: 1, rounds: 2 })));
    expect(h).toMatchObject({ rounds: 2, full: 1, scoped: 1 });
  });

  test('a carried receipt repeats its run\'s loop and adds no round; a re-check carry counts as a re-check', () => {
    const r1 = receipt(sha('a'), { passes: 1, rounds: 1 }, { run: 'r1' });
    let body = placeReceipt('', r1);
    const c1 = carried(r1, sha('b'), 'scoped re-check by anthropic/claude-opus-5-5 (range-diff 40 lines)');
    body = placeReceipt(body, c1);
    body = placeReceipt(body, carried(c1, sha('c'), 'test-only change'));
    expect(receiptRuns(body).map(r => r.carry_kind ?? 'run')).toEqual(['run', 'recheck']);
    expect(prReviewHistory(body)).toMatchObject({ rounds: 1, full: 1, rechecks: 1, runs: 1, heads: 3 });
  });

  test('the same run written twice at one head counts once; a run id reused at another head counts again (gstack-evals#406)', () => {
    let body = placeReceipt('', receipt(sha('a'), { passes: 1, rounds: 1 }, { run: 'r1' }));
    body = placeReceipt(body, receipt(sha('a'), { passes: 1, rounds: 1, deferred: 1 }, { run: 'r1' }));
    expect(prReviewHistory(body)).toMatchObject({ rounds: 1, runs: 1 });
    body = placeReceipt(body, receipt(sha('b'), { passes: 1, rounds: 1 }, { run: 'r1' }));
    expect(prReviewHistory(body)).toMatchObject({ rounds: 2, runs: 2 });
  });

  test('a started stub counts its rounds so far until its run writes a receipt, which replaces it', () => {
    let body = placeReceipt('', receipt(sha('a'), { passes: 1, rounds: 1 }, { run: 'r1' }));
    body = placeRunEntry(body, { head: sha('b'), run: 'r2', status: 'started', review_loop: loop({ passes: 1, rounds: 1 }) });
    expect(prReviewHistory(body)).toMatchObject({ rounds: 2, stubs: 1 });
    body = placeRunEntry(body, { head: sha('b'), run: 'r2', status: 'started', review_loop: loop({ passes: 1, fix_checks: 1, rounds: 2 }) });
    expect(receiptRuns(body).filter(r => r.status === 'started').length).toBe(1);
    expect(prReviewHistory(body).rounds).toBe(2);
    body = placeReceipt(body, receipt(sha('c'), { passes: 1, fix_checks: 1, rounds: 2 }, { run: 'r2' }));
    expect(receiptRuns(body).some(r => r.status === 'started')).toBe(false);
    expect(prReviewHistory(body)).toMatchObject({ rounds: 2, stubs: 0, runs: 2 });
  });

  test('a voided stub (an infrastructure failure) counts nothing', () => {
    let body = placeReceipt('', receipt(sha('a'), { passes: 1, rounds: 1 }, { run: 'r1' }));
    body = placeRunEntry(body, { head: sha('b'), run: 'r2', status: 'voided', review_loop: loop({ passes: 1, rounds: 1 }) });
    expect(prReviewHistory(body).rounds).toBe(1);
  });

  test('a receipt written without a run keeps the stubs of other runs', () => {
    let body = placeReceipt('', receipt(sha('a'), { passes: 1, rounds: 1 }, { run: 'r1' }));
    body = placeRunEntry(body, { head: sha('b'), run: 'r2', status: 'started', review_loop: loop({ passes: 1, rounds: 1 }) });
    body = placeReceipt(body, receipt(sha('c'), { passes: 1, rounds: 1 }));
    expect(prReviewHistory(body)).toMatchObject({ stubs: 1, full: 3 });
  });

  test('a /ship body post keeps the live runs block, so history still counts every run (GST-2706)', () => {
    let live = placeReceipt('## Summary\nprose\n', receipt(sha('a'), { passes: 1, rounds: 1 }, { run: 'r1' }));
    live = placeRunEntry(live, { head: sha('b'), run: 'r2', status: 'started', review_loop: loop({ passes: 1, rounds: 1 }) });
    live = placeRunEntry(live, { head: sha('b'), run: 'r3', status: 'started', review_loop: loop({ passes: 1, rounds: 1 }) });
    const composed = placeReceipt('## Summary\nnew prose\n', receipt(sha('c'), { passes: 1, rounds: 1 }, { run: 'r2' }));
    const posted = mergeBodySections(live, composed).body;
    expect(posted).toContain('new prose');
    expect(prReviewHistory(posted)).toMatchObject({ full: 3, runs: 2, stubs: 1, last_full: sha('c') });
    expect(receiptRuns(posted).map(r => r.run)).toEqual(['r3', 'r1']);
    expect(prReviewHistory(mergeBodySections(posted, composed).body)).toEqual(prReviewHistory(posted));
  });

  // Value: protects=the PR's review count from a posted body whose notes carry their own runs blocks: the reader takes the
  //   first block it finds, so one placed before the receipt would replace the real history (Sol audit of #4365, GST-2707);
  //   fails_when=keepRuns removes only the first incoming block, or returns the file's history when the live body has none;
  //   seam=none (mergeBodySections); no_claim=the gh round trip
  test('a /ship body post drops every runs block it brings and keeps only the live history (GST-2707)', () => {
    const fake = (c: string) => '```gstack-receipt-runs\n' + JSON.stringify({ head: sha(c), run: `fake-${c}`, review_loop: loop({ passes: 0, rounds: 0 }) }) + '\n```\n';
    const composed = placeReceipt('## Summary\nnew prose\n', receipt(sha('c'), { passes: 1, rounds: 1 }, { run: 'r2' }));
    const injected = composed.replace('```gstack-ship-receipt', fake('d') + '\n' + fake('e') + '\n```gstack-ship-receipt');
    expect(receiptRuns(injected).map(r => r.run)).toEqual(['fake-d']);
    let live = placeReceipt('## Summary\nprose\n', receipt(sha('a'), { passes: 1, rounds: 1 }, { run: 'r1' }));
    live = placeRunEntry(live, { head: sha('b'), run: 'r3', status: 'started', review_loop: loop({ passes: 1, rounds: 1 }) });
    const posted = mergeBodySections(live, injected).body;
    expect(prReviewHistory(posted)).toMatchObject({ full: 3, runs: 2, stubs: 1, last_full: sha('c') });
    expect(receiptRuns(posted).map(r => r.run)).toEqual(['r3', 'r1']);
    expect(posted.match(/```gstack-receipt-runs/g)).toHaveLength(1);
    expect(prReviewHistory(mergeBodySections(posted, injected).body)).toEqual(prReviewHistory(posted));
    const fresh = mergeBodySections('## Summary\nprose\n', injected).body;
    expect(fresh).not.toContain('gstack-receipt-runs');
    expect(prReviewHistory(fresh)).toMatchObject({ full: 1, runs: 1, stubs: 0 });
  });

  // Value: protects=a PR's started stubs when a post's Agent notes carry no receipt yet (the body between a Step 9 stub and
  //   the receipt write); fails_when=keepRuns drops the live runs block, or lets a block the file brings stand in for it;
  //   seam=none (mergeBodySections); no_claim=the gh round trip
  test('a post whose notes hold no receipt keeps the live stubs and none of its own runs blocks (GST-2707)', () => {
    const live = placeRunEntry('## Summary\nprose\n', { head: sha('b'), run: 'r3', status: 'started', review_loop: loop({ passes: 1, rounds: 1 }) });
    expect(mergeBodySections(live, live).body).toBe(live);
    const fake = '```gstack-receipt-runs\n' + JSON.stringify({ head: sha('d'), run: 'fake-d', review_loop: loop({ passes: 0, rounds: 0 }) }) + '\n```\n';
    const injected = live.replace('```gstack-receipt-runs', fake + '\n```gstack-receipt-runs');
    expect(receiptRuns(injected).map(r => r.run)).toEqual(['fake-d']);
    const posted = mergeBodySections(live, injected).body;
    expect(receiptRuns(posted).map(r => r.run)).toEqual(['r3']);
    expect(prReviewHistory(posted)).toEqual(prReviewHistory(live));
  });

  test('a stub lands in a body with no receipt yet, inside the Agent notes section', () => {
    const body = placeRunEntry('## Summary\nprose\n', { head: sha('a'), run: 'r1', status: 'started', review_loop: loop({ passes: 1, rounds: 1 }) });
    expect(body.startsWith('## Summary\nprose\n')).toBe(true);
    expect(prReviewHistory(body)).toMatchObject({ rounds: 1, stubs: 1 });
  });

  test('receiptRun records the carry kind of the latest hop only', () => {
    const r1 = receipt(sha('a'));
    expect(receiptRun(carried(r1, sha('b'), 'test-only change + scoped re-check by x (range-diff 3 lines)')).carry_kind).toBe('recheck');
    expect(receiptRun(carried(r1, sha('b'), 'scoped re-check by x (range-diff 3 lines) + base merge')).carry_kind).toBe('carry');
    expect(receiptRun(r1).carry_kind).toBeUndefined();
  });
});

describe('route (F1: the merge head gets a full review; a re-check is advice only)', () => {
  test('no prior full round: the first full round, as today', () => {
    expect(reviewRoute({ full: 0 })).toMatchObject({ route: 'first' });
  });

  test('after one full round a new head gets a fresh full review, its last before merge, never the re-check', () => {
    expect(reviewRoute({ full: 1 })).toMatchObject({ route: 'final', reason: expect.stringContaining('round 2 of 2') });
  });

  test('at the cap a new head gets one read-only full review; an extra-round grant buys a round with its fix round', () => {
    expect(reviewRoute({ full: 2 })).toMatchObject({ route: 'read-only', reason: expect.stringContaining('no fix round') });
    expect(reviewRoute({ full: 3 }).route).toBe('read-only');
    expect(reviewRoute({ full: 2 }, { grant: 'a-1' })).toMatchObject({ route: 'final', reason: expect.stringContaining('a-1') });
    expect(reviewRoute({ full: 3 }, { grant: 'a-1' }).route).toBe('read-only');
  });

  test('a re-check carry from an old receipt adds no full round, so it never moves the route', () => {
    const r1 = receipt(sha('a'), { passes: 1, rounds: 1 }, { run: 'r1' });
    const body = placeReceipt(placeReceipt('', r1), carried(r1, sha('b'), 'scoped re-check by x (range-diff 3 lines)'));
    expect(reviewRoute(prReviewHistory(body)).route).toBe('final');
  });

  test('the history line carries no drift or re-check-blocker fields', () => {
    const line = historyLine('7', prReviewHistory(placeReceipt('', receipt(sha('a'), { passes: 1, rounds: 1 }))));
    expect(line).toStartWith('PR_REVIEW_HISTORY: pr=#7 rounds=1 cap=2 full=1 ');
    expect(line).not.toMatch(/drift|recheck_blocked/);
  });
});
