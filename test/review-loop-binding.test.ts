/**
 * GST-1168: the receipt's review counts bind by finding id. Each case is a shape a real /ship run produced
 * (GBEV-3 gbrain-evals#310, GEVA-223 gstack-evals#174, #3906 at 9417c7d, #3892/#3903/#3911); before the fix
 * the summary paired rows and ledgers by path:line only and dropped rows it could not place without a word.
 */
import { describe, expect, test } from 'bun:test';
import { parseFixTrailers, reviewLoopLine, summarizeReviewLoop, type LedgerPass } from '../lib/review-scope';
import type { LedgerBlocker } from '../lib/review-ledger';

const SINCE = '2026-11-02T10:00:00.000Z';
const at = (min: number) => new Date(Date.parse(SINCE) + min * 60_000).toISOString();
const row = (skill: string, min: number, findings: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
  ({ skill, via: 'ship', review_scope: 'frozen', review_binding: { started_at: at(min) }, findings, ...extra });
const blocker = (pass: string, id: string, locus: string | null): LedgerBlocker => ({ id, locus, key: `${pass}/${id}` });
const pass = (min: number, ids: string[], fixCheck = false): LedgerPass => ({ started: Date.parse(at(min)), fixCheck, ids });

describe('review loop counts bind by finding id (GST-1168)', () => {
  test('GBEV-3: a deferred finding logged late counts once and a fix-check never marks it fixed', () => {
    const rows = [
      row('review', 1, [{ fingerprint: 'src/a.ts:10:correctness', severity: 'CRITICAL', action: 'fixed', blocking: true, raised_by: 'adversarial-native', ledger_id: 'p1/adversarial-native#1' }]),
      row('review-late-defer', 30, [{ fingerprint: 'src/b.ts:20:security', severity: 'CRITICAL', action: 'deferred', issue: 311, blocking: true, raised_by: 'adversarial-native', ledger_id: 'p1/adversarial-native#2' }]),
    ];
    const ledgers = [[blocker('p1', 'adversarial-native#1', 'src/a.ts:10'), blocker('p1', 'adversarial-native#2', 'src/b.ts:21')], []];
    const s = summarizeReviewLoop(rows, SINCE, ledgers, [pass(0, ['p1/adversarial-native#1', 'p1/adversarial-native#2']), pass(20, ['fc/fix-check#1'], true)]);
    expect({ found: s.blocking_found, fixed: s.fixed, deferred: s.deferred, unrecorded: s.unrecorded }).toEqual({ found: 2, fixed: 1, deferred: 1, unrecorded: undefined });
  });

  test('GEVA-223: native findings with no path:line pair with their rows by ledger_id', () => {
    const ids = Array.from({ length: 9 }, (_, i) => `adversarial-native#${i + 1}`);
    const findings = [
      ...ids.map((id, i) => ({ fingerprint: `lib/x.ts:${10 * (i + 1)}:correctness`, severity: 'CRITICAL', action: 'fixed', blocking: true, raised_by: 'adversarial-native', ledger_id: `p1/${id}` })),
      ...Array.from({ length: 6 }, (_, i) => ({ fingerprint: `lib/y.ts:${i + 1}:style`, severity: 'INFORMATIONAL', action: 'noted', blocking: false, raised_by: 'specialist' })),
    ];
    const s = summarizeReviewLoop([row('review', 1, findings)], SINCE, [ids.map(id => blocker('p1', id, null))], [pass(0, ids.map(id => `p1/${id}`))]);
    expect({ found: s.blocking_found, fixed: s.fixed, noted: s.noted, unrecorded: s.unrecorded }).toEqual({ found: 9, fixed: 9, noted: 6, unrecorded: undefined });
  });

  test('#3906: fixes named by Review-Finding trailers count even when no row recorded the findings', () => {
    const ledger = [1, 2, 3].map(n => blocker('p1', `red-team#${n}`, `lib/auth.ts:${25 + 15 * n}`));
    const trailers = parseFixTrailers('9417c7d0000000000000000000000000000000000', ['p1/red-team#1 reader=red-team', 'p1/red-team#2 reader=red-team', 'p1/red-team#3 reader=red-team']);
    const s = summarizeReviewLoop([row('review', 1, [])], SINCE, [ledger], [pass(0, ledger.map(b => b.key!))], trailers);
    expect({ found: s.blocking_found, fixed: s.fixed, unrecorded: s.unrecorded }).toEqual({ found: 3, fixed: 3, unrecorded: undefined });
    expect(reviewLoopLine(s)).toContain('fixed=3');
  });

  test('#3892/#3903/#3911: a row with no start token and no readable time is named unbound, never dropped silently', () => {
    const tokenless = { skill: 'review', via: 'ship', pass: 2, timestamp: 'TIMESTAMP', findings: [{ fingerprint: 'lib/q.ts:7:correctness', severity: 'CRITICAL', action: 'fixed', blocking: true }] };
    const s = summarizeReviewLoop([row('review', 1, []), tokenless], SINCE);
    expect(s.unbound).toEqual(['row review pass=2: no start token and no readable timestamp, so it cannot be placed in this run']);
    expect(reviewLoopLine(s)).toContain('unbound=1');
  });

  test('a ledger_id no ledger collected and a trailer naming nothing are unbound with their names', () => {
    const rows = [row('review', 1, [{ fingerprint: 'lib/z.ts:3:correctness', severity: 'CRITICAL', action: 'fixed', blocking: true, raised_by: 'specialist', ledger_id: 'p9/specialist#4' }])];
    const s = summarizeReviewLoop(rows, SINCE, [[]], [pass(0, [])], parseFixTrailers('abc1234def567', ['p1/targeted#2 reader=targeted', 'no-reader-field']));
    expect(s.unbound).toEqual([
      'ledger_id p9/specialist#4: no dispatch ledger of this run collected it',
      "trailer abc1234def56 Review-Finding: p1/targeted#2 reader=targeted: names no finding this run's rows or ledgers hold",
    ]);
  });

  test('GBEV-3: a voided pass (its ledger never judged, no row names it) is left out by name, and the restarted pass counts alone', () => {
    const rows = [row('review', 30, [{ fingerprint: 'src/a.ts:10:correctness', severity: 'CRITICAL', action: 'fixed', blocking: true, raised_by: 'red-team', ledger_id: 'p2/red-team#1' }], { pass: 2 })];
    const ledgers = [[blocker('p1', 'red-team#1', 'src/a.ts:10'), blocker('p1', 'red-team#2', 'src/c.ts:5')], [blocker('p2', 'red-team#1', 'src/a.ts:10')]];
    const passes = [{ ...pass(0, ['p1/red-team#1', 'p1/red-team#2']), name: 'p1', judged: false }, { ...pass(20, ['p2/red-team#1']), name: 'p2', judged: true }];
    const s = summarizeReviewLoop(rows, SINCE, ledgers, passes);
    expect({ found: s.blocking_found, fixed: s.fixed, unrecorded: s.unrecorded, unbound: s.unbound }).toEqual({ found: 1, fixed: 1, unrecorded: undefined, unbound: undefined });
    expect(s.voided).toEqual(['pass p1: its ledger was never judged and no review-log row names it (an abandoned pass), so its 2 collected findings are left out']);
  });

  test('an unjudged fix-check ledger with no row still counts as a fix-check, never voided', () => {
    const rows = [row('review', 20, [], { pass: 1 })];
    const passes = [{ ...pass(0, ['p1/red-team#1']), name: 'p1', judged: true }, { ...pass(40, ['fc/fix-check#1'], true), name: 'fc', judged: false }];
    const s = summarizeReviewLoop(rows, SINCE, [[], []], passes);
    expect(s.voided).toBeUndefined();
    expect(s.fix_checks).toBe(1);
  });

  test('the last pass is never voided: an unjudged pass no later pass replaced keeps its blockers', () => {
    const ledgers = [[blocker('p1', 'red-team#1', 'src/a.ts:10')]];
    const s = summarizeReviewLoop([], SINCE, ledgers, [{ ...pass(0, ['p1/red-team#1']), name: 'p1', judged: false }]);
    expect(s.voided).toBeUndefined();
    expect(s.blocking_found).toBe(1);
  });

  test('a judged pass with no row is still named unbound, never voided', () => {
    const rows = [row('review', 30, [], { pass: 2 })];
    const s = summarizeReviewLoop(rows, SINCE, [[blocker('p1', 'red-team#1', 'src/a.ts:10')], []], [{ ...pass(0, ['p1/red-team#1']), name: 'p1', judged: true }, { ...pass(20, []), name: 'p2', judged: true }]);
    expect(s.voided).toBeUndefined();
    expect(s.unbound).toEqual(['pass 1 (ledger p1): no review-log row, so its fixes and dispositions cannot be counted']);
  });

  test('#3911 at 4340ed4c: a fix-check row written twice counts once, and pass 1 with no row is named', () => {
    const fc = { skill: 'review-fix-check', via: 'ship', pass: 2, commit: '4340ed4c', review_binding: { started_at: at(40) }, findings: [{ fingerprint: 'lib/p.ts:9:correctness', severity: 'CRITICAL', action: 'fixed', blocking: true, raised_by: 'fix-check', ledger_id: 'fc/fix-check#1' }] };
    const rows = [row('review', 20, [], { pass: 2, commit: '1111111' }), fc, { ...fc }];
    const passes = [{ ...pass(0, []), name: 'p1' }, { ...pass(20, []), name: 'p2' }, { ...pass(40, ['fc/fix-check#1'], true), name: 'fc' }];
    const s = summarizeReviewLoop(rows, SINCE, [[], [], [blocker('fc', 'fix-check#1', 'lib/p.ts:9')]], passes);
    expect({ passes: s.passes, fix_checks: s.fix_checks, found: s.blocking_found, fixed: s.fixed }).toEqual({ passes: 1, fix_checks: 1, found: 1, fixed: 1 });
    expect(s.unbound).toEqual(['pass 1 (ledger p1): no review-log row, so its fixes and dispositions cannot be counted']);
  });

  test('a fingerprint trailer binds a finding that also carries a ledger_id (outside voice #2)', () => {
    const rows = [row('review', 1, [{ fingerprint: 'src/auth.ts:10:correctness', severity: 'CRITICAL', blocking: true, raised_by: 'red-team', ledger_id: 'p1/red-team#1' }])];
    const s = summarizeReviewLoop(rows, SINCE, [[blocker('p1', 'red-team#1', 'src/auth.ts:10')]], [pass(0, ['p1/red-team#1'])], parseFixTrailers('abc', ['src/auth.ts:10:correctness reader=red-team']));
    expect({ fixed: s.fixed, unrecorded: s.unrecorded, unbound: s.unbound }).toEqual({ fixed: 1, unrecorded: undefined, unbound: undefined });
  });

  test('rows without ledger_id keep pairing by path:line, as before', () => {
    const rows = [row('review', 1, [{ fingerprint: 'src/a.ts:10:correctness', severity: 'CRITICAL', action: 'fixed', blocking: true, raised_by: 'specialist' }])];
    const s = summarizeReviewLoop(rows, SINCE, [[blocker('p1', 'specialist/security#1', 'src/a.ts:10')]]);
    expect({ found: s.blocking_found, fixed: s.fixed, unrecorded: s.unrecorded, unbound: s.unbound }).toEqual({ found: 1, fixed: 1, unrecorded: undefined, unbound: undefined });
  });
});
