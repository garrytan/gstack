/**
 * GSTA-258 L4 receipt attribution: a PR body keeps every /ship run's receipt (append-only runs block), and the receipt
 * schema carries K1's no_stop records for L5.
 */
import { describe, expect, test } from 'bun:test';
import { extractReceipt, orderReceipt, placeReceipt, readyTailLines, receiptRuns, RECEIPT_RUNS_KEPT, validateReceipt } from '../lib/ship-receipt';
import type { ShipReceipt } from '../lib/headless-artifacts';

const receipt = (head: string, loop: Partial<NonNullable<ShipReceipt['review_loop']>> = {}): ShipReceipt =>
  orderReceipt({ schema_version: 1, head, base: 'main', version: '1.94.1.0', review_loop: { passes: 1, blocking_found: 0, deferred: 0, ...loop } });

describe('receipt runs block', () => {
  test('a write over a different receipt keeps the old run, oldest first, after the current block in the Agent notes section', () => {
    let body = placeReceipt('## Summary\nprose\n', receipt('a'.repeat(40), { passes: 2, blocking_found: 3, fixed: 3 }));
    body = placeReceipt(body, receipt('b'.repeat(40)));
    body = placeReceipt(body, receipt('c'.repeat(40), { passes: 1 }));
    expect(extractReceipt(body).receipt!.head).toBe('c'.repeat(40));
    expect(receiptRuns(body).map(r => [r.head[0], r.review_loop?.blocking_found])).toEqual([['a', 3], ['b', 0]]);
    expect(body.indexOf('gstack-receipt-runs')).toBeGreaterThan(body.indexOf('<!-- gstack:agent-notes -->'));
    expect(body.indexOf('gstack-receipt-runs')).toBeGreaterThan(body.indexOf('```gstack-ship-receipt'));
    expect(body.indexOf('<!-- gstack:agent-notes -->')).toBeGreaterThan(body.indexOf('## Summary'));
    expect(body.match(/## Summary/g)!.length).toBe(1);
  });

  test('a fence inside a recorded reason never closes the runs block (adversarial p-voices #1)', () => {
    const withReason = (head: string) => orderReceipt({ ...receipt(head, { fix_checks: 1 }), review_loop_exception: { accepted_by: 'Garry', date: '2026-11-03', via: 'x', reason: 'the \x60\x60\x60retry\x60\x60\x60 block is fine', fix_check: { head, findings: 0 } } });
    let body = placeReceipt('## Summary\nprose\n', withReason('b'.repeat(40)));
    body = placeReceipt(body, withReason('c'.repeat(40)));
    body = placeReceipt(body, withReason('d'.repeat(40)));
    expect(receiptRuns(body).map(r => r.head[0])).toEqual(['b', 'c']);
    expect(body.startsWith('## Summary\nprose\n\n<!-- gstack:agent-notes -->\n')).toBe(true);
    expect(body.endsWith('```\n\n</details>\n')).toBe(true);
  });

  test('rewriting the same receipt adds no run, and the block keeps the newest RECEIPT_RUNS_KEPT', () => {
    const same = receipt('d'.repeat(40));
    expect(receiptRuns(placeReceipt(placeReceipt('', same), same))).toEqual([]);
    let body = '';
    for (let i = 0; i < RECEIPT_RUNS_KEPT + 5; i++) body = placeReceipt(body, receipt(i.toString(16).padStart(40, '0')));
    const runs = receiptRuns(body);
    expect(runs.length).toBe(RECEIPT_RUNS_KEPT);
    expect(runs.at(-1)!.head).toBe((RECEIPT_RUNS_KEPT + 3).toString(16).padStart(40, '0'));
  });
});

describe('READY tail (E1: the ready output is the whole READY)', () => {
  const depth = (cls: 'docs' | 'code' | 'gate', risk?: Array<'money' | 'auth' | 'secret' | 'security' | 'data'>) =>
    ({ depth: 'full' as const, class: cls, runtime_lines: 10, rules: 'r', base: 'b', registry: null, gate_scan: { tagged: 0, head: 'h' }, reasons: [], ...(risk ? { risk } : {}) });
  test('a risk-class receipt asks for the cross-family read; any other PR is self-audited', () => {
    expect(readyTailLines({ ...receipt('f'.repeat(40)), review_depth: depth('gate') })[3]).toStartWith('reviewed by <model on another family> (risk class: gate;');
    expect(readyTailLines({ ...receipt('f'.repeat(40)), review_depth: depth('code', ['money']) })[3]).toContain('risk class: money');
    expect(readyTailLines({ ...receipt('f'.repeat(40)), review_depth: depth('docs') })[3]).toBe('self-audited (not a risk class: no cross-family trail read)');
  });
  test('the review loop line carries fixed, unrecorded and unbound from the receipt', () => {
    const lines = readyTailLines(receipt('f'.repeat(40), { passes: 2, blocking_found: 3, fixed: 2, unrecorded: 1, unbound: 1 }));
    expect(lines[0]).toBe('REVIEW_LOOP: passes=2 blocking_found=3 deferred=0 noted=0 fixed=2 unrecorded=1 unbound=1');
    expect(lines.slice(1, 3)).toEqual([expect.stringMatching(/^TRIAL_MERGES: /), 'Attention:']);
    expect(readyTailLines(undefined)[0]).toBe('REVIEW_LOOP: none in the receipt');
    expect(readyTailLines(receipt('f'.repeat(40)))[3]).toStartWith('reviewed by <model on another family> (risk class unknown: the receipt records no review_depth');
  });
});

describe('no_stop receipt field (K1)', () => {
  test('a record per routine stop validates; an unknown class or a missing field does not', () => {
    const ok = orderReceipt({ ...receipt('e'.repeat(40)), no_stop: [{ class: 'pregate-flake-rerun', reason: 'one rerun of test/x.test.ts at the same tree', evidence: 'run 41562764513' }] });
    expect(validateReceipt(ok)).toEqual([]);
    expect(Object.keys(ok).at(-1)).toBe('no_stop');
    expect(validateReceipt({ ...ok, no_stop: [{ class: 'merge-anyway', reason: 'x', evidence: 'y' }] } as any).length).toBeGreaterThan(0);
    expect(validateReceipt({ ...ok, no_stop: [{ class: 'stamp-only-carry', reason: 'x' }] } as any).length).toBeGreaterThan(0);
  });
});
