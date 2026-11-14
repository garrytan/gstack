/**
 * GST-2673: /ship counts review rounds per pull request, across every head and /ship run, from the receipt and the
 * receipt-runs history the PR body already keeps (docs/review-policy.md#rounds-per-pull-request).
 */
import { describe, expect, test } from 'bun:test';
import { driftFromNumstat, placeRunEntry, prReviewHistory, PR_DRIFT_LINES, reviewRoute } from '../lib/pr-review-history';
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

  test('rounds follow R51 (passes plus fix-checks) summed across /ship runs, not the largest run', () => {
    let body = placeReceipt('', receipt(sha('a'), { passes: 1, fix_checks: 1, rounds: 2 }, { run: 'r1' }));
    body = placeReceipt(body, receipt(sha('b'), { passes: 1, fix_checks: 1, rounds: 2 }, { run: 'r2' }));
    const h = prReviewHistory(body);
    expect(h).toMatchObject({ runs: 2, rounds: 4, full: 2, fix_checks: 2, first_full: sha('a'), last_full: sha('b') });
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

  test('the same run written twice counts once', () => {
    let body = placeReceipt('', receipt(sha('a'), { passes: 1, rounds: 1 }, { run: 'r1' }));
    body = placeReceipt(body, receipt(sha('b'), { passes: 1, rounds: 1 }, { run: 'r1' }));
    expect(prReviewHistory(body)).toMatchObject({ rounds: 1, runs: 1 });
  });

  test('a started stub counts its rounds so far until its run writes a receipt, which replaces it', () => {
    let body = placeReceipt('', receipt(sha('a'), { passes: 1, rounds: 1 }, { run: 'r1' }));
    body = placeRunEntry(body, { head: sha('b'), run: 'r2', status: 'started', review_loop: loop({ passes: 1, rounds: 1 }) });
    expect(prReviewHistory(body)).toMatchObject({ rounds: 2, stubs: 1 });
    body = placeRunEntry(body, { head: sha('b'), run: 'r2', status: 'started', review_loop: loop({ passes: 1, fix_checks: 1, rounds: 2 }) });
    expect(receiptRuns(body).filter(r => r.status === 'started').length).toBe(1);
    expect(prReviewHistory(body).rounds).toBe(3);
    body = placeReceipt(body, receipt(sha('c'), { passes: 1, fix_checks: 1, rounds: 2 }, { run: 'r2' }));
    expect(receiptRuns(body).some(r => r.status === 'started')).toBe(false);
    expect(prReviewHistory(body)).toMatchObject({ rounds: 3, stubs: 0, runs: 2 });
  });

  test('a voided stub (an infrastructure failure) counts nothing', () => {
    let body = placeReceipt('', receipt(sha('a'), { passes: 1, rounds: 1 }, { run: 'r1' }));
    body = placeRunEntry(body, { head: sha('b'), run: 'r2', status: 'voided', review_loop: loop({ passes: 1, rounds: 1 }) });
    expect(prReviewHistory(body).rounds).toBe(1);
  });

  test('a stub lands in a body with no receipt yet, inside the Agent notes section', () => {
    const body = placeRunEntry('## Summary\nprose\n', { head: sha('a'), run: 'r1', status: 'started', review_loop: loop({ passes: 1, rounds: 1 }) });
    expect(body.startsWith('## Summary\nprose\n')).toBe(true);
    expect(prReviewHistory(body)).toMatchObject({ rounds: 1, stubs: 1 });
  });

  test('re-check blockers count since the last full round', () => {
    let body = placeReceipt('', receipt(sha('a'), { passes: 1, rounds: 1 }, { run: 'r1' }));
    body = placeRunEntry(body, { head: sha('b'), run: 'recheck-blocked', carry_kind: 'recheck-blocked', carried_from: sha('a') });
    expect(prReviewHistory(body).recheck_blocked).toBe(1);
    body = placeRunEntry(body, { head: sha('c'), run: 'recheck-blocked', carry_kind: 'recheck-blocked', carried_from: sha('a') });
    expect(prReviewHistory(body).recheck_blocked).toBe(2);
    body = placeReceipt(body, receipt(sha('d'), { passes: 1, rounds: 1 }, { run: 'r2' }));
    expect(prReviewHistory(body)).toMatchObject({ recheck_blocked: 0, rounds: 2 });
  });

  test('receiptRun records the carry kind of the latest hop only', () => {
    const r1 = receipt(sha('a'));
    expect(receiptRun(carried(r1, sha('b'), 'test-only change + scoped re-check by x (range-diff 3 lines)')).carry_kind).toBe('recheck');
    expect(receiptRun(carried(r1, sha('b'), 'scoped re-check by x (range-diff 3 lines) + base merge')).carry_kind).toBe('carry');
    expect(receiptRun(r1).carry_kind).toBeUndefined();
  });
});

describe('drift and route', () => {
  test('drift sums the branch\'s own non-merge changes, leaving out tests and release metadata', () => {
    const numstat = ['10\t5\tlib/a.ts', '3\t0\ttest/a.test.ts', '1\t1\tVERSION', '-\t-\tassets/logo.png', '2\t2\tbin/b'].join('\n');
    expect(driftFromNumstat(numstat)).toBe(19);
  });

  test('no prior round: the first full round, as today', () => {
    expect(reviewRoute({ rounds: 0, recheck_blocked: 0 }, { drift: null })).toMatchObject({ route: 'first' });
  });

  test('after a full round a head takes the re-check unless drift, two re-check blockers or a design-change grant say review', () => {
    const h = { rounds: 1, recheck_blocked: 0 };
    expect(reviewRoute(h, { drift: 10 }).route).toBe('recheck');
    expect(reviewRoute(h, { drift: PR_DRIFT_LINES + 1 })).toMatchObject({ route: 'review', reason: expect.stringContaining('drift') });
    expect(reviewRoute({ rounds: 1, recheck_blocked: 2 }, { drift: 10 })).toMatchObject({ route: 'review', reason: expect.stringContaining('re-check') });
    expect(reviewRoute(h, { drift: 10, grant: { kind: 'design-change', approval: 'a-1' } })).toMatchObject({ route: 'review', reason: expect.stringContaining('design-change') });
  });
});
