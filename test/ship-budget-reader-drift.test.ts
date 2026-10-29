/**
 * GSTA-167 PR 3a: dispatch drift is measured per reader and only to the reading
 * a dispatch was settled with when it returned, never across the parent's own
 * work; the parent's interleaved calls stay in the step's sample. The per-call
 * charge takes a prior reading from the previous call only. Replays
 * gstack-evals #36 (a six-reader batch taught a 2.041 factor and priced the Red
 * Team at 15.17M, a false STOP with 14.4M of sub-cap unused) and #34 (the Red
 * Team's reservation interval covered the child's own review and QA, and a
 * prior reading six calls old fired CONTEXT_HIGH at call=1068386); evidence in
 * handoffs/GSTA-167/replay-36.md and replay-34.md in the GStack Minder drive.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadCalibration, unitConstants } from '../lib/ship-budget';
import { budgetHarness, type Harness } from './helpers/ship-budget-harness';

const cal = loadCalibration();
const K = unitConstants(cal, 'capy-tokens');
const harnesses: Harness[] = [];
const fresh = () => { const h = budgetHarness(); harnesses.push(h); return h; };
afterEach(() => { while (harnesses.length) harnesses.pop()!.cleanup(); });

/** Opus medium readers on #34/#36 cost about 1.7M each (replay-36: ~1.69M per specialist). */
const READER = 1_690_000;
const SIX = Array(6).fill('specialist');
const roundUp = (n: number) => Math.ceil(n / cal.round_to) * cal.round_to;
/** The per-reader price after a measured batch: the prior times actual/(prior x readers) times the headroom. */
const priced = (actual: number, readers: number) => roundUp(K.per_dispatch * ((actual / (K.per_dispatch * readers)) * cal.headroom));

function start(h: Harness, cap: number, reading = 0) {
  const r = h.sb(['start', '--record', h.record(), '--token-cap', String(cap), '--reading', String(reading), '--reserve', '0']);
  expect(r.code, r.out + r.err).toBe(0);
  return { run: h.field(r.out, 'BUDGET_RUN', 'id'), ledger: h.field(r.out, 'BUDGET_RUN', 'ledger') };
}
function ok(h: Harness, args: string[]) {
  const r = h.sb(args);
  expect(r.code, r.out + r.err).toBe(0);
  return r;
}
const check = (h: Harness, run: string, step: string, next: string, reading: number, extra: string[] = []) =>
  ok(h, ['check', '--run', run, '--step', step, '--next', next, '--reading', String(reading), ...extra]);

describe('per-reader dispatch drift (#36)', () => {
  test('#36 replay: six readers measured at their return price the Red Team per reader, so it is admitted instead of a 15.17M STOP', () => {
    const h = fresh();
    const cap = 35_244_164;
    const s = start(h, cap);
    let reading = 10_710_000;
    const first = check(h, s.run, '9', 'dispatch:' + SIX.join(','), reading);
    expect(first.out).toMatch(/^ADMIT: 2 of 6 /m);
    const r1 = h.field(first.out, 'RESERVATION', 'id');
    expect(h.reviewLog(['--start', 'review', '--reservation', r1]).code).toBe(0);
    reading += 2 * READER;
    const rest = check(h, s.run, '9', 'dispatch:' + SIX.slice(2).join(','), reading, ['--returned', r1]);
    expect(rest.out).toMatch(new RegExp(`^DRIFT: id=${r1} kind=dispatch next=dispatch:specialist,specialist projected=${2 * K.per_dispatch} actual=${2 * READER} ratio=0\\.23$`, 'm'));
    expect(rest.out).not.toContain('ADMIT:');
    expect(Number(h.field(rest.out, 'BUDGET', 'projected'))).toBe(4 * priced(2 * READER, 2));
    const r2 = h.field(rest.out, 'RESERVATION', 'id');
    reading += 4 * READER;
    const red = check(h, s.run, '9', 'dispatch:red-team', reading, ['--returned', r2]);
    expect(h.field(red.out, 'BUDGET', 'verdict')).toBe('continue');
    expect(Number(h.field(red.out, 'BUDGET', 'projected'))).toBe(priced(2 * READER, 2));
    expect(Number(h.field(red.out, 'BUDGET', 'projected'))).toBeLessThan(3_000_000);
    expect(red.out).not.toContain('STOP:');
  });

  test('a measured role prices its next reader at the larger of the per-reader projection and its per-reader mean', () => {
    const h = fresh();
    const s = start(h, 200_000_000);
    const a = h.field(check(h, s.run, '9', 'dispatch:' + SIX.join(','), 0).out, 'RESERVATION', 'id');
    const b = check(h, s.run, '9', 'dispatch:red-team', 6 * READER, ['--returned', a]);
    const r = h.ledger(s.ledger).reservations.find((x: any) => x.id === a);
    expect(r.actual).toBe(6 * READER);
    expect(Number(h.field(b.out, 'BUDGET', 'projected'))).toBe(priced(6 * READER, 6));
    const red = h.field(b.out, 'RESERVATION', 'id');
    const heavy = 3_910_000;
    const c = check(h, s.run, '9', 'dispatch:red-team,specialist', 6 * READER + heavy, ['--returned', red]);
    const factor = Math.max(READER / K.per_dispatch, heavy / K.per_dispatch) * cal.headroom;
    expect(Number(h.field(c.out, 'BUDGET', 'projected'))).toBe(Math.max(roundUp(K.per_dispatch * factor), heavy) + Math.max(roundUp(K.per_dispatch * factor), READER));
  });
});

describe('a dispatch is measured to its return, never across the parent\'s own work (#34)', () => {
  test('#34 replay: a Red Team settled by the step change after the child\'s review and QA is UNMEASURED, so the voices keep the per-reader factor', () => {
    const h = fresh();
    const s = start(h, 200_000_000);
    check(h, s.run, '8', '9', 3_500_000);
    const specialists = h.field(check(h, s.run, '9', 'dispatch:' + SIX.join(','), 4_000_000).out, 'RESERVATION', 'id');
    expect(h.reviewLog(['--start', 'review', '--reservation', specialists]).code).toBe(0);
    let reading = 4_000_000 + 6 * READER;
    const redCheck = check(h, s.run, '9', 'dispatch:red-team', reading, ['--returned', specialists]);
    const red = h.field(redCheck.out, 'RESERVATION', 'id');
    expect(h.reviewLog(['--start', 'review', '--reservation', red]).code).toBe(0);
    reading += READER + 3_000_000;
    const step = check(h, s.run, '9', '10', reading);
    expect(step.out).toMatch(new RegExp(`^UNMEASURED: id=${red} kind=dispatch next=dispatch:red-team reason=settled_without_reading$`, 'm'));
    expect(step.out).not.toMatch(new RegExp(`^DRIFT: id=${red} `, 'm'));
    expect(step.out).toMatch(/^UNMEASURED: id=\S+ kind=step next=9 reason=dispatch_unmeasured$/m);
    expect(h.ledger(s.ledger).reservations.find((x: any) => x.id === red)).toMatchObject({ state: 'settled', unmeasured: true });
    check(h, s.run, '10', '11', reading + 400_000);
    const voices = check(h, s.run, '11', 'dispatch:adversarial-native,outside-voice', reading + 800_000);
    expect(Number(h.field(voices.out, 'BUDGET', 'projected'))).toBe(2 * priced(6 * READER, 6));
  });

  test('settled with a reading at its return, the Red Team measures only its own interval; the parent\'s QA after it lands in Step 9\'s sample', () => {
    const h = fresh();
    const s = start(h, 200_000_000);
    check(h, s.run, '8', '9', 3_500_000);
    const red = h.field(check(h, s.run, '9', 'dispatch:red-team', 4_000_000).out, 'RESERVATION', 'id');
    expect(h.reviewLog(['--start', 'review', '--reservation', red]).code).toBe(0);
    const settled = ok(h, ['settle', '--run', s.run, '--reservation', red, '--reading', String(4_000_000 + READER)]);
    expect(settled.out).toMatch(new RegExp(`^DRIFT: id=${red} kind=dispatch next=dispatch:red-team projected=${K.per_dispatch} actual=${READER} ratio=0\\.23$`, 'm'));
    const step = check(h, s.run, '9', '10', 4_000_000 + READER + 3_000_000);
    expect(step.out).toMatch(/^DRIFT: id=\S+ kind=step next=9 projected=\d+ actual=3500000 ratio=\d+\.\d\d$/m);
    expect(step.out).not.toContain('UNMEASURED:');
  });

  test('--finish settles the pass without a reading, so its dispatches are UNMEASURED and the factor stays at the prior', () => {
    const h = fresh();
    const s = start(h, 200_000_000);
    const id = h.field(check(h, s.run, '9', 'dispatch:' + SIX.join(','), 0).out, 'RESERVATION', 'id');
    const token = h.reviewLog(['--start', 'review', '--reservation', id]).out.trim();
    const row = JSON.stringify({ skill: 'review', timestamp: new Date().toISOString(), status: 'clean', issues_found: 0, critical: 0, informational: 0 });
    expect(h.reviewLog([row, '--finish', token]).code).toBe(0);
    const next = check(h, s.run, '9', 'dispatch:red-team', 6 * READER + 5_000_000);
    expect(next.out).toMatch(new RegExp(`^UNMEASURED: id=${id} kind=dispatch `, 'm'));
    expect(h.field(next.out, 'BUDGET', 'calibration')).toEndWith('dispatch:prior');
    expect(Number(h.field(next.out, 'BUDGET', 'projected'))).toBe(K.per_dispatch);
  });
});

describe('the per-call charge takes a prior reading from the previous call only (#34)', () => {
  test('a prior reading older than the run\'s last reading is ignored: call=unknown, never a six-call span', () => {
    const h = fresh();
    const s = start(h, 60_000_000, 1_000_000);
    check(h, s.run, '4', '5', 8_900_000);
    const stale = check(h, s.run, '5', '6', 9_162_515, ['--prior-reading', '8094129']);
    expect(h.field(stale.out, 'BUDGET', 'call')).toBe('unknown');
    expect(stale.out).toMatch(/^CALL_UNKNOWN: --prior-reading 8094129 is older than the run's last reading 8900000; /m);
    expect(stale.out).not.toContain('1068386');
    const fine = check(h, s.run, '6', '6.5', 9_450_000, ['--prior-reading', '9162515']);
    expect(h.field(fine.out, 'BUDGET', 'call')).toBe('287485');
    expect(fine.out).not.toContain('CALL_UNKNOWN');
  });

  test('#34 replay: a child passing the parent\'s handoff reading as its prior gets call=unknown, not 1068386', () => {
    const h = fresh();
    const s = start(h, 400_000_000, 2_110_477);
    const ho = ok(h, ['handoff', '--run', s.run, '--from', '7', '--to', '11.5', '--base', 'origin/main', '--reading', '8094129']);
    const brief = ho.out.match(/^HANDOFF: (\S+) /m)![1]!;
    const v = ok(h, ['verify-handoff', '--in', brief, '--reading', '8800000']);
    const child = h.field(v.out, 'BUDGET_RUN', 'id');
    const c = check(h, child, '6.5', '7', 9_162_515, ['--prior-reading', '8094129']);
    expect(h.field(c.out, 'BUDGET', 'call')).toBe('unknown');
    expect(c.out).not.toContain('call=1068386');
  });
});

describe('the budget section states both contracts', () => {
  const tmpl = fs.readFileSync(path.join(import.meta.dir, '..', 'ship', 'sections', 'budget-handoff.md.tmpl'), 'utf8');
  test('the meter read happens inside the same program as the gstack-ship-budget command, never as its own call', () => {
    expect(tmpl).not.toContain('pass the earlier value');
    expect(tmpl).toMatch(/same (?:execute )?program as the\s+(?:`)?gstack-ship-budget(?:`)? command, never (?:as )?its own call/);
    expect(tmpl).toMatch(/--prior-reading[\s\S]{0,200}previous call/);
    expect(tmpl).toMatch(/older than the run's last reading is ignored/);
  });
  test('a batch names one role per reader and each reader is settled with a reading when it returns', () => {
    expect(tmpl).toMatch(/one role per (?:reader|`DISPATCH:` line)/);
    expect(tmpl).toMatch(/Settle each reader when it returns[\s\S]{0,200}--reservation <id> --reading <n>/);
    expect(tmpl).toMatch(/Only these are measured: `--finish` or a step change settles without a reading/);
  });
});
