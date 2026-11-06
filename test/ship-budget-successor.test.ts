/**
 * GST-1655: a /ship run handed to a successor thread. The successor's counter is
 * another thread's (it starts near zero or at an unrelated cumulative value), so
 * resume --meter-source <its jam id> opens a new meter epoch at its readings while
 * spend already metered carries; a reading that goes backwards within one epoch
 * is still refused.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { budgetHarness, type Harness } from './helpers/ship-budget-harness';

const harnesses: Harness[] = [];
const fresh = () => { const h = budgetHarness(); harnesses.push(h); return h; };
afterEach(() => { while (harnesses.length) harnesses.pop()!.cleanup(); });

/** Thread A's run: started at 40M tokens and 20000 credits, last noted at 80M and 45000. */
function threadA(h: Harness, cap = '200M', source: string[] = ['--meter-source', 'jam_A']) {
  const record = h.record();
  const s = h.sb(['start', '--record', record, '--mode', 'observe', '--token-cap', cap, '--reading', '40M', '--credits', '20000', ...source]);
  expect(s.code).toBe(0);
  const n = h.sb(['note', '--record', record, '--step', '9', '--reading', '80M', '--credits', '45000']);
  expect(n.code).toBe(0);
  return { record, ledger: h.field(s.out, 'BUDGET_RUN', 'ledger') };
}

describe('successor thread resume (GST-1655)', () => {
  test('the same thread: a reading below the last of its epoch is still refused, and nothing changes', () => {
    const h = fresh();
    const a = threadA(h);
    const before = fs.readFileSync(a.ledger, 'utf8');
    for (const args of [['--reading', '3M', '--credits', '50000'], ['--reading', '90M', '--credits', '1500']]) {
      const r = h.sb(['resume', '--record', a.record, '--meter-source', 'jam_A', ...args]);
      expect(r.code).toBe(2);
      expect(r.err).toContain('(BUDGET_READING_REJECTED)');
      expect(r.err).toContain('--meter-source');
    }
    const bare = h.sb(['resume', '--record', a.record, '--reading', '3M', '--credits', '1500']);
    expect(bare.code).toBe(2);
    expect(bare.err).toContain('(BUDGET_READING_REJECTED)');
    expect(fs.readFileSync(a.ledger, 'utf8')).toBe(before);
  });

  test('a successor thread\'s readings open a new epoch at its own baseline; spend carries in tokens and credits', () => {
    const h = fresh();
    const a = threadA(h);
    const r = h.sb(['resume', '--record', a.record, '--meter-source', 'jam_B', '--reading', '3M', '--credits', '1500']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('EPOCH: 2 meter=capy unit=capy-tokens carried_used=40000000 carried_credits=25000 source=jam_B previous_source=jam_A');
    expect(h.field(r.out, 'BUDGET', 'epoch')).toBe('2');
    expect(h.field(r.out, 'BUDGET', 'used')).toBe('40000000');
    expect(h.field(r.out, 'BUDGET', 'credits')).toBe('25000');
    const n = h.sb(['note', '--record', a.record, '--step', '12', '--reading', '10M', '--credits', '6500']);
    expect(n.code).toBe(0);
    expect(h.field(n.out, 'BUDGET', 'used')).toBe('47000000');
    expect(h.field(n.out, 'BUDGET', 'credits')).toBe('30000');
    const back = h.sb(['note', '--record', a.record, '--step', '12', '--reading', '9M', '--credits', '6600']);
    expect(back.code).toBe(2);
    expect(back.err).toContain('below the last reading 10000000 of epoch 2');
    const l = h.ledger(a.ledger);
    expect(l.meter).toMatchObject({ epoch: 2, baseline: 3_000_000, last: 10_000_000, source: 'jam_B' });
    expect(l.epochs).toEqual([expect.objectContaining({ epoch: 1, baseline: 40_000_000, last: 80_000_000, used: 40_000_000, credits: 25000, source: 'jam_A' })]);
    expect(fs.readFileSync(a.record, 'utf8')).toMatch(/epoch=2 baseline=3000000 used=47000000 credits=30000/);
  });

  test('a successor whose counter is above the last reading still gets its own epoch instead of a mixed counter', () => {
    const h = fresh();
    const a = threadA(h);
    const r = h.sb(['resume', '--record', a.record, '--meter-source', 'jam_B', '--reading', '120M', '--credits', '60000']);
    expect(r.code).toBe(0);
    expect(h.field(r.out, 'BUDGET', 'used')).toBe('40000000');
    expect(h.field(r.out, 'BUDGET', 'credits')).toBe('25000');
  });

  test('a ledger that recorded no source treats a named one as a successor; a successor needs both readings', () => {
    const h = fresh();
    const a = threadA(h, '200M', []);
    expect(h.sb(['resume', '--record', a.record, '--meter-source', 'jam_B', '--credits', '1500']).err).toContain('(BUDGET_READING_MISSING)');
    expect(h.sb(['resume', '--record', a.record, '--meter-source', 'jam_B', '--reading', '3M']).err).toContain('(BUDGET_READING_MISSING)');
    const r = h.sb(['resume', '--record', a.record, '--meter-source', 'jam_B', '--reading', '3M', '--credits', '1500']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('source=jam_B previous_source=unrecorded');
  });

  test('the total across epochs trips the hard stop', () => {
    const h = fresh();
    const a = threadA(h, '50M');
    expect(h.sb(['resume', '--record', a.record, '--meter-source', 'jam_B', '--reading', '3M', '--credits', '1500']).code).toBe(0);
    const under = h.sb(['note', '--record', a.record, '--step', '12', '--reading', '13M', '--credits', '2000']);
    expect(under.code).toBe(0);
    expect(h.field(under.out, 'BUDGET', 'used')).toBe('50000000');
    const over = h.sb(['note', '--record', a.record, '--step', '14', '--reading', '13000001', '--credits', '2001']);
    expect(over.code).toBe(3);
    expect(over.out).toMatch(/^STOP: reason=budget_exhausted spent=50000001 /m);
    expect(over.out).toContain('GSTACK_RESULT: skill=ship status=incomplete');
  });

  test('resume --rebuild-from-record takes the same path, with the ledger intact or rebuilt from the record', () => {
    const h = fresh();
    const a = threadA(h);
    const intact = h.sb(['resume', '--record', a.record, '--rebuild-from-record', '--meter-source', 'jam_B', '--reading', '3M', '--credits', '1500']);
    expect(intact.code).toBe(0);
    expect(intact.out).toContain('EPOCH: 2 ');
    expect(h.field(intact.out, 'BUDGET', 'used')).toBe('40000000');

    const b = threadA(h, '50M');
    fs.writeFileSync(b.ledger, '{"kind": "gstack-ship-budget", oops');
    expect(h.sb(['resume', '--record', b.record, '--rebuild-from-record', '--meter-source', 'jam_B', '--reading', '3M']).err).toContain('(BUDGET_READING_MISSING)');
    const rebuilt = h.sb(['resume', '--record', b.record, '--rebuild-from-record', '--meter-source', 'jam_B', '--reading', '3M', '--credits', '1500']);
    expect(rebuilt.code).toBe(0);
    expect(rebuilt.out).toContain('REBUILT:');
    expect(h.field(rebuilt.out, 'BUDGET', 'epoch')).toBe('2');
    expect(h.field(rebuilt.out, 'BUDGET', 'used')).toBe('40000000');
    expect(h.field(rebuilt.out, 'BUDGET', 'credits')).toBe('25000');
    expect(h.ledger(b.ledger).meter.source).toBe('jam_B');
    expect(h.sb(['note', '--record', b.record, '--step', '12', '--reading', '2M', '--credits', '1600']).code).toBe(2);
    const over = h.sb(['note', '--record', b.record, '--step', '12', '--reading', '14M', '--credits', '1600']);
    expect(over.code).toBe(3);
    expect(over.out).toMatch(/^STOP: reason=budget_exhausted spent=51000000 /m);
  });
});
