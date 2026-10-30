/**
 * Pre-dispatch enforcement (GSTA-152 build-spec r2 item 1): under a cap,
 * gstack-review-log --start refuses a dispatch without an unspent, one-shot
 * reservation id from gstack-ship-budget check; --finish settles it (its
 * completion receipt, item 7 M2); close audits unreserved dispatches after the
 * fact. Without a cap nothing changes.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RESULT_CODES } from '../lib/result-codes';
import { budgetHarness, type Harness } from './helpers/ship-budget-harness';

const harnesses: Harness[] = [];
const fresh = () => { const h = budgetHarness(); harnesses.push(h); return h; };
afterEach(() => { while (harnesses.length) harnesses.pop()!.cleanup(); });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function capped(h: Harness, cap = '80M') {
  const record = h.record();
  const r = h.sb(['start', '--record', record, '--token-cap', cap, '--reading', '0']);
  expect(r.code).toBe(0);
  return { record, run: h.field(r.out, 'BUDGET_RUN', 'id'), ledger: h.field(r.out, 'BUDGET_RUN', 'ledger') };
}
const reserve = (h: Harness, run: string, next = 'dispatch:specialist,red-team') =>
  h.field(h.sb(['check', '--run', run, '--step', '9', '--next', next, '--reading', '0']).out, 'RESERVATION', 'id');
const startFiles = (h: Harness) => {
  const dirs = fs.existsSync(path.join(h.state, 'projects')) ? fs.readdirSync(path.join(h.state, 'projects')) : [];
  return dirs.flatMap(d => { try { return fs.readdirSync(path.join(h.state, 'projects', d, '.review-starts')); } catch { return []; } });
};

describe('gstack-review-log --start under a token cap', () => {
  test('without a cap, --start behaves exactly as before: one token line, no reservation asked', () => {
    const h = fresh();
    const plain = h.reviewLog(['--start', 'review']);
    expect(plain.code).toBe(0);
    expect(plain.out.trim()).toMatch(UUID);
    expect(plain.err).toBe('');
    const record = h.record();
    expect(h.sb(['start', '--record', record, '--token-cap', 'none', '--reading', '0']).code).toBe(0);
    const still = h.reviewLog(['--start', 'review']);
    expect(still.code).toBe(0);
    expect(still.out.trim()).toMatch(UUID);
    expect(still.err).toBe('');
  });

  test('a skipped admission refuses before launch and captures nothing', () => {
    const h = fresh();
    capped(h);
    const before = startFiles(h).length;
    const r = h.reviewLog(['--start', 'review']);
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
    expect(r.err).toContain('(BUDGET_CHECK_SKIPPED)');
    expect(r.err).toContain('no --reservation');
    expect(r.err.trim()).toEndWith(`; fix: ` + RESULT_CODES.BUDGET_CHECK_SKIPPED.fix + ' (BUDGET_CHECK_SKIPPED)');
    expect(startFiles(h).length).toBe(before);
  });

  test('a mismatched reservation (another run, or a step reservation) refuses', () => {
    const h = fresh();
    const other = capped(h);
    const foreign = reserve(h, other.run);
    const mine = capped(h);
    expect(h.reviewLog(['--start', 'review', '--reservation', foreign]).err).toContain('(mismatched)');
    const stepRes = h.field(h.sb(['check', '--run', mine.run, '--step', '1', '--next', '2', '--reading', '0']).out, 'RESERVATION', 'id');
    const r = h.reviewLog(['--start', 'review', '--reservation', stepRes]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('a step reservation');
    expect(r.err).toContain('(BUDGET_CHECK_SKIPPED)');
  });

  test('a reused reservation refuses; the first use consumes it and --finish settles it', () => {
    const h = fresh();
    const run = capped(h);
    const id = reserve(h, run.run);
    const ok = h.reviewLog(['--start', 'review', '--reservation', id]);
    expect(ok.code).toBe(0);
    const token = ok.out.trim();
    expect(token).toMatch(UUID);
    const again = h.reviewLog(['--start', 'review', '--reservation', id]);
    expect(again.code).toBe(1);
    expect(again.err).toContain('already consumed');
    let row = h.ledger(run.ledger).reservations.find((r: any) => r.id === id);
    expect(row).toMatchObject({ state: 'consumed', token });
    const fin = h.reviewLog([JSON.stringify({ skill: 'review', timestamp: new Date().toISOString(), status: 'clean', issues_found: 0, critical: 0, informational: 0 }), '--finish', token]);
    expect(fin.code).toBe(0);
    row = h.ledger(run.ledger).reservations.find((r: any) => r.id === id);
    expect(row.state).toBe('settled');
    expect(h.sb(['close', '--run', run.run, '--reading', '10']).code).toBe(0);
  });

  test('close prints one BUDGET_CHECK_SKIPPED line per unreserved dispatch and ends incomplete', () => {
    const h = fresh();
    const run = capped(h);
    const row = { skill: 'review', timestamp: new Date(Date.now() + 1000).toISOString(), status: 'clean', issues_found: 0, critical: 0, informational: 0 };
    expect(h.reviewLog([JSON.stringify(row)]).code).toBe(0);
    const close = h.sb(['close', '--run', run.run, '--reading', '10']);
    expect(close.code).toBe(3);
    const skipped = close.out.split('\n').filter(l => l.endsWith('(BUDGET_CHECK_SKIPPED)'));
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toContain('role=review step=9');
    expect(skipped[0]).toContain('spend=unknown');
    expect(close.out).toContain('owner decision');
    expect(close.out.trim().split('\n').at(-1)).toMatch(/^GSTACK_RESULT: skill=ship status=incomplete run=/);
    const accepted = h.sb(['close', '--run', run.run, '--reading', '20', '--approved-by', 'Garry', '--words', 'accept that spend']);
    expect(accepted.code).toBe(0);
    expect(accepted.out).toContain('ACCEPTED: 1 unreserved dispatches by Garry');
  });

  test('a stopped run refuses every later dispatch until resume', () => {
    const h = fresh();
    const run = capped(h, '20M');
    expect(h.sb(['check', '--run', run.run, '--step', '9', '--next', 'dispatch:specialist,red-team', '--reading', '9000000']).code).toBe(3);
    const r = h.reviewLog(['--start', 'review', '--reservation', 'anything']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('(BUDGET_CAP_REACHED)');
  });

  test('a stopped run or a lost ledger does not block a later uncapped review on the branch', () => {
    const h = fresh();
    const run = capped(h, '20M');
    expect(h.sb(['check', '--run', run.run, '--step', '9', '--next', 'dispatch:specialist,red-team', '--reading', '9000000']).code).toBe(3);
    const afterStop = h.reviewLog(['--start', 'review']);
    expect(afterStop.code).toBe(0);
    expect(afterStop.out.trim()).toMatch(UUID);
    const h2 = fresh();
    const lost = capped(h2);
    fs.unlinkSync(lost.ledger);
    const afterLoss = h2.reviewLog(['--start', 'review']);
    expect(afterLoss.code).toBe(0);
    expect(afterLoss.out.trim()).toMatch(UUID);
  });
});
