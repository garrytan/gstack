/**
 * GSTA-167 (gstack-evals #35, gate class): full-depth Step 9 launched 7 Opus
 * readers in parallel at about 0.76M each, and the shared counter went 13.2M ->
 * 18.5M before the parent's poll saw it. A dispatch batch now prices each reader
 * at max(its projection, the run's measured mean for that role), admits the
 * largest prefix that fits near the cap (ADMIT: k of n), and keeps the rest as
 * remaining until a later check requests them; close flags readers never re-checked.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { loadCalibration, unitConstants } from '../lib/ship-budget';
import { budgetHarness, type Harness } from './helpers/ship-budget-harness';

const cal = loadCalibration();
const K = unitConstants(cal, 'capy-tokens');
const harnesses: Harness[] = [];
const fresh = () => { const h = budgetHarness(); harnesses.push(h); return h; };
afterEach(() => { while (harnesses.length) harnesses.pop()!.cleanup(); });

const READERS = ['specialist', 'specialist', 'specialist', 'specialist', 'specialist', 'red-team', 'adversarial-native'];
const AT_35 = 13_200_000;
/** Room for exactly three readers at the prior above the #35 reading, with 1M to spare. */
const CAP_35 = AT_35 + 3 * K.per_dispatch + K.stop_overhead + 1_000_000;

function start(h: Harness, cap: number) {
  const r = h.sb(['start', '--record', h.record(), '--token-cap', String(cap), '--reading', '0', '--reserve', '0']);
  expect(r.code, r.out + r.err).toBe(0);
  return { run: h.field(r.out, 'BUDGET_RUN', 'id'), ledger: h.field(r.out, 'BUDGET_RUN', 'ledger') };
}
const batch = (h: Harness, run: string, roles: string[], reading: number, extra: string[] = []) =>
  h.sb(['check', '--run', run, '--step', '9', '--next', 'dispatch:' + roles.join(','), '--reading', String(reading), ...extra]);

describe('parallel dispatch admission near the cap', () => {
  test('#35 replay: a 7-reader batch near the cap admits the largest prefix and names the rest', () => {
    const h = fresh();
    const s = start(h, CAP_35);
    const c = batch(h, s.run, READERS, AT_35);
    expect(c.code, c.out + c.err).toBe(0);
    expect(c.out).toMatch(/^ADMIT: 3 of 7 \(remaining=specialist,specialist,red-team,adversarial-native\)/m);
    expect(h.field(c.out, 'BUDGET', 'verdict')).toBe('continue');
    expect(h.field(c.out, 'RESERVATION', 'next')).toBe('dispatch:specialist,specialist,specialist');
    expect(Number(h.field(c.out, 'RESERVATION', 'tokens'))).toBe(3 * K.per_dispatch);
    const r = h.ledger(s.ledger).reservations.find((x: any) => x.kind === 'dispatch');
    expect(r).toMatchObject({ roles: ['specialist', 'specialist', 'specialist'], remaining: ['specialist', 'specialist', 'red-team', 'adversarial-native'] });
  });

  test('a role\'s measured mean overrides a lower projection', () => {
    const h = fresh();
    const s = start(h, 200_000_000);
    let id = h.field(batch(h, s.run, ['red-team'], 0).out, 'RESERVATION', 'id');
    let reading = 3_000_000;
    for (let i = 0; i < 4; i++, reading += 500_000) id = h.field(batch(h, s.run, ['specialist'], reading, ['--returned', id]).out, 'RESERVATION', 'id');
    const c = batch(h, s.run, ['red-team', 'specialist'], reading, ['--returned', id]);
    expect(c.code, c.out + c.err).toBe(0);
    const f = (500_000 / K.per_dispatch) * cal.headroom;
    const specialist = Math.ceil((K.per_dispatch * f) / cal.round_to) * cal.round_to;
    expect(specialist).toBeLessThan(3_000_000);
    expect(Number(h.field(c.out, 'BUDGET', 'projected'))).toBe(3_000_000 + specialist);
  });

  test('when not even the first reader fits, the batch stops as before', () => {
    const h = fresh();
    const s = start(h, CAP_35);
    const c = batch(h, s.run, READERS, CAP_35 - K.stop_overhead - K.per_dispatch + 1);
    expect(c.code).toBe(3);
    expect(c.out).toContain('STOP: reason=budget_exhausted');
    expect(c.out).not.toContain('ADMIT:');
    expect(Number(h.field(c.out, 'BUDGET', 'projected'))).toBe(READERS.length * K.per_dispatch);
    expect(h.ledger(s.ledger).reservations.filter((x: any) => x.kind === 'dispatch')).toHaveLength(0);
  });

  test('the remainder re-check admits after the first readers settle; close flags readers never re-checked', () => {
    const h = fresh();
    const s = start(h, CAP_35);
    const first = h.field(batch(h, s.run, READERS, AT_35).out, 'RESERVATION', 'id');
    expect(h.sb(['settle', '--run', s.run, '--reservation', first, '--reading', String(AT_35 + 3 * 760_000)]).code).toBe(0);
    const rest = batch(h, s.run, READERS.slice(3), AT_35 + 3 * 760_000);
    expect(rest.code, rest.out + rest.err).toBe(0);
    expect(rest.out).not.toContain('ADMIT:');
    expect(h.field(rest.out, 'RESERVATION', 'next')).toBe('dispatch:' + READERS.slice(3).join(','));
    expect(h.ledger(s.ledger).reservations.find((x: any) => x.id === first).remaining).toEqual([]);
    expect(h.sb(['close', '--run', s.run, '--reading', String(AT_35 + 4_000_000)]).code).toBe(0);

    const d = start(h, CAP_35);
    expect(batch(h, d.run, READERS, AT_35).out).toContain('ADMIT: 3 of 7');
    const close = h.sb(['close', '--run', d.run, '--reading', String(AT_35 + 3_000_000)]);
    expect(close.code).toBe(3);
    expect(close.out).toMatch(/^DROPPED: step=9 reservation=\S+ roles=specialist,specialist,red-team,adversarial-native/m);
    expect(close.out.trim().split('\n').at(-1)).toMatch(/^GSTACK_RESULT: skill=ship status=incomplete run=/);
    const accepted = h.sb(['close', '--run', d.run, '--reading', String(AT_35 + 3_000_000), '--approved-by', 'Garry', '--words', 'three readers are enough']);
    expect(accepted.code).toBe(0);
    expect(accepted.out).toContain('ACCEPTED: 0 unreserved dispatches and 1 unfinished batches by Garry');
  });
});
