/**
 * GSTA-167 PR 3a: dispatch drift is measured per reader and only from the
 * dispatch program's reading right before its readers started (--dispatched-at)
 * to the one it was settled with after they returned, never across the parent's
 * own work; the parent's interleaved calls stay in the step's sample. The per-call
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
    let at = reading;
    reading += 2 * READER;
    const rest = check(h, s.run, '9', 'dispatch:' + SIX.slice(2).join(','), reading, ['--returned', r1, '--dispatched-at', String(at)]);
    expect(rest.out).toMatch(new RegExp(`^DRIFT: id=${r1} kind=dispatch next=dispatch:specialist,specialist projected=${2 * K.per_dispatch} actual=${2 * READER} ratio=0\\.23$`, 'm'));
    expect(rest.out).not.toContain('ADMIT:');
    expect(Number(h.field(rest.out, 'BUDGET', 'projected'))).toBe(4 * priced(2 * READER, 2));
    const r2 = h.field(rest.out, 'RESERVATION', 'id');
    at = reading;
    reading += 4 * READER;
    const red = check(h, s.run, '9', 'dispatch:red-team', reading, ['--returned', r2, '--dispatched-at', String(at)]);
    expect(h.field(red.out, 'BUDGET', 'verdict')).toBe('continue');
    expect(Number(h.field(red.out, 'BUDGET', 'projected'))).toBe(priced(2 * READER, 2));
    expect(Number(h.field(red.out, 'BUDGET', 'projected'))).toBeLessThan(3_000_000);
    expect(red.out).not.toContain('STOP:');
  });

  test('a measured role prices its next reader at the larger of the per-reader projection and its per-reader mean', () => {
    const h = fresh();
    const s = start(h, 200_000_000);
    const a = h.field(check(h, s.run, '9', 'dispatch:' + SIX.join(','), 0).out, 'RESERVATION', 'id');
    const b = check(h, s.run, '9', 'dispatch:red-team', 6 * READER, ['--returned', a, '--dispatched-at', '0']);
    const r = h.ledger(s.ledger).reservations.find((x: any) => x.id === a);
    expect(r.actual).toBe(6 * READER);
    expect(Number(h.field(b.out, 'BUDGET', 'projected'))).toBe(priced(6 * READER, 6));
    const red = h.field(b.out, 'RESERVATION', 'id');
    const heavy = 3_910_000;
    const c = check(h, s.run, '9', 'dispatch:red-team,specialist', 6 * READER + heavy, ['--returned', red, '--dispatched-at', String(6 * READER)]);
    const factor = Math.max(READER / K.per_dispatch, heavy / K.per_dispatch) * cal.headroom;
    expect(Number(h.field(c.out, 'BUDGET', 'projected'))).toBe(Math.max(roundUp(K.per_dispatch * factor), heavy) + Math.max(roundUp(K.per_dispatch * factor), READER));
  });
});

describe('a dispatch is measured to its return, never across the parent\'s own work (#34)', () => {
  test('#34 replay: a Red Team settled by the step change after the child\'s review and QA is UNMEASURED, so the voices keep the per-reader factor', () => {
    const h = fresh();
    const s = start(h, 200_000_000);
    check(h, s.run, '8', '9', 3_500_000, ['--prior-reading', '3400000']);
    const specialists = h.field(check(h, s.run, '9', 'dispatch:' + SIX.join(','), 4_000_000).out, 'RESERVATION', 'id');
    expect(h.reviewLog(['--start', 'review', '--reservation', specialists]).code).toBe(0);
    let reading = 4_000_000 + 6 * READER;
    const redCheck = check(h, s.run, '9', 'dispatch:red-team', reading, ['--returned', specialists, '--dispatched-at', '4000000']);
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
    check(h, s.run, '8', '9', 3_500_000, ['--prior-reading', '3400000']);
    const red = h.field(check(h, s.run, '9', 'dispatch:red-team', 4_000_000).out, 'RESERVATION', 'id');
    expect(h.reviewLog(['--start', 'review', '--reservation', red]).code).toBe(0);
    const settled = ok(h, ['settle', '--run', s.run, '--reservation', red, '--dispatched-at', '4000000', '--reading', String(4_000_000 + READER)]);
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

/**
 * GSTA-167 PR 3, replay 2 on gstack-evals #36 (handoffs/GSTA-167/replay2-36.md): the
 * batched reader's reservation r5 was settled only at the next --returned check
 * (17.72M -> 27.01M), so its interval held the child's own core review, QA and
 * build, and the Red Team was priced at 7.43M x 1.875 = 13.94M: a false STOP with
 * 14.8M of sub-cap unused. Only the dispatch program's own pair (read right before
 * the readers start, again after they all settle) measures now.
 */
describe("only the dispatch program's reading pair measures readers (replay 2, #36)", () => {
  const R5 = { cap: 34_044_378, spent: 19_258_962, reserved: 17_720_000, settled: 27_010_000 };
  const childStart = (h: Harness) => start(h, R5.cap, R5.settled - R5.spent);

  test('r5 replay: settled at the next --returned check with no dispatch reading, r5 is UNMEASURED and the Red Team keeps the prior, not 13.94M', () => {
    const h = fresh();
    const s = childStart(h);
    const r5 = h.field(check(h, s.run, '9', 'dispatch:specialist', R5.reserved).out, 'RESERVATION', 'id');
    expect(h.reviewLog(['--start', 'review', '--reservation', r5]).code).toBe(0);
    const red = check(h, s.run, '9', 'dispatch:red-team', R5.settled, ['--returned', r5]);
    expect(red.out).toMatch(new RegExp(`^UNMEASURED: id=${r5} kind=dispatch next=dispatch:specialist reason=no_dispatch_reading$`, 'm'));
    expect(red.out).not.toMatch(/^DRIFT: id=\S+ kind=dispatch /m);
    expect(h.field(red.out, 'BUDGET', 'used')).toBe(String(R5.spent));
    expect(h.field(red.out, 'BUDGET', 'verdict')).toBe('continue');
    expect(Number(h.field(red.out, 'BUDGET', 'projected'))).toBe(K.per_dispatch);
    expect(red.out).not.toContain('STOP:');
  });

  test("the dispatch program's pair measures only the readers and prices the next reader from that measurement", () => {
    const h = fresh();
    const s = childStart(h);
    const r5 = h.field(check(h, s.run, '9', 'dispatch:specialist', R5.reserved).out, 'RESERVATION', 'id');
    const before = R5.settled - 1_510_000;
    const settled = ok(h, ['settle', '--run', s.run, '--reservation', r5, '--dispatched-at', String(before), '--reading', String(R5.settled), '--readers', '1']);
    expect(settled.out).toMatch(new RegExp(`^DRIFT: id=${r5} kind=dispatch next=dispatch:specialist projected=${K.per_dispatch} actual=1510000 `, 'm'));
    const red = check(h, s.run, '9', 'dispatch:red-team', R5.settled);
    expect(Number(h.field(red.out, 'BUDGET', 'projected'))).toBe(priced(1_510_000, 1));
    expect(h.field(red.out, 'BUDGET', 'verdict')).toBe('continue');
  });

  test('the learned factor never prices a reader above the larger of the prior and the clean per-reader mean', () => {
    const h = fresh();
    const s = start(h, 400_000_000);
    const id = h.field(check(h, s.run, '9', 'dispatch:specialist', 1_000_000).out, 'RESERVATION', 'id');
    const actual = 2 * K.per_dispatch;
    ok(h, ['settle', '--run', s.run, '--reservation', id, '--dispatched-at', '1000000', '--reading', String(1_000_000 + actual), '--readers', '1']);
    const red = check(h, s.run, '9', 'dispatch:red-team', 1_000_000 + actual);
    expect(priced(actual, 1)).toBeGreaterThan(actual);
    expect(Number(h.field(red.out, 'BUDGET', 'projected'))).toBe(actual);
  });

  test('a dispatch reading older than another command\'s reading is UNMEASURED (a later program), and one above the settle reading is refused', () => {
    const h = fresh();
    const s = childStart(h);
    const r5 = h.field(check(h, s.run, '9', 'dispatch:specialist', R5.reserved).out, 'RESERVATION', 'id');
    const late = ok(h, ['settle', '--run', s.run, '--reservation', r5, '--dispatched-at', String(R5.reserved - 1), '--reading', String(R5.settled)]);
    expect(late.out).toMatch(new RegExp(`^UNMEASURED: id=${r5} kind=dispatch next=dispatch:specialist reason=reading_between$`, 'm'));
    const r6 = h.field(check(h, s.run, '9', 'dispatch:red-team', R5.settled).out, 'RESERVATION', 'id');
    const bad = h.sb(['settle', '--run', s.run, '--reservation', r6, '--dispatched-at', String(R5.settled + 2), '--reading', String(R5.settled + 1)]);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('BUDGET_READING_REJECTED');
    expect(h.sb(['settle', '--run', s.run, '--reservation', r6, '--readers', '2', '--reading', String(R5.settled + 1)]).code).toBe(2);
  });

  test('--readers splits the pair\'s interval per reader for the role mean', () => {
    const h = fresh();
    const s = start(h, 200_000_000);
    const id = h.field(check(h, s.run, '9', 'dispatch:specialist,specialist', 1_000_000).out, 'RESERVATION', 'id');
    ok(h, ['settle', '--run', s.run, '--reservation', id, '--dispatched-at', '1000000', '--reading', '4000000', '--readers', '2']);
    expect(h.ledger(s.ledger).reservations.find((x: any) => x.id === id)).toMatchObject({ actual: 3_000_000, readers: 2, dispatched_at: 1_000_000 });
    const next = check(h, s.run, '9', 'dispatch:specialist', 4_000_000);
    expect(Number(h.field(next.out, 'BUDGET', 'projected'))).toBe(priced(3_000_000, 2));
  });

  test('--next takes plain roles only: a role@bytes item is refused', () => {
    const h = fresh();
    const s = start(h, 200_000_000);
    const r = h.sb(['check', '--run', s.run, '--step', '9', '--next', 'dispatch:specialist@40000', '--reading', '0']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('names unknown roles');
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
    const ho = ok(h, ['handoff', '--run', s.run, '--from', '9', '--to', '11.5', '--base', 'origin/main', '--reading', '8094129']);
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
  // Value: protects=no gstack prose tells the agent to read the meter in a call of its own (each such call costs a full context, about 0.2M on #34/#36); fails_when=capy SKILL.md keeps "one execute program returning only that number" or the section asks for a meter-only call;
  //   why_new=the template test above never read the Capy skill; seam=none; no_claim=how often an agent obeys the prose
  test('the Capy skill reads the meter inside the budget command\'s program and names no meter-only call', () => {
    const capy = fs.readFileSync(path.join(import.meta.dir, '..', 'capy', 'skill', 'gstack', 'SKILL.md'), 'utf8');
    const caps = capy.slice(capy.indexOf('Token caps on /ship'), capy.indexOf('/ship on Capy is about a dozen calls'));
    expect(caps.length).toBeGreaterThan(0);
    expect(caps).not.toContain('returning only that number');
    expect(caps).toMatch(/inside the same (?:execute )?program as the\s+`gstack-ship-budget` command/);
    for (const text of [capy, tmpl]) expect(text).not.toMatch(/read it again in your next call|meter-only call(?!s? (?:is|are) never)/);
  });
  // Value: protects=each review pass (and Step 11, and the Step 14.5 audit) is one execute program in a fixed order, so the readers' reading pair brackets only them and no plan, start, poll or later batch costs its own parent call, and each reviewer's brief is copied from its section; fails_when=the order breaks (a start after the readers are created, a note before the poll, the plan after the dispatch) or the Capy paragraph goes back to one program per batch or stops copying the section's brief;
  //   why_new=no test reads the pass order; seam=none; no_claim=the model's adherence (GSTA-167 replay 5: arm D walked Steps 9-9.4 in 27 calls)
  test('a review pass is one execute program: plan, review-log --start, BEFORE, create, poll, note with the pair, collect (Capy, observe mode); the admission-mode section keeps check and settle', () => {
    const capy = fs.readFileSync(path.join(import.meta.dir, '..', 'capy', 'skill', 'gstack', 'SKILL.md'), 'utf8');
    const pass = capy.slice(capy.indexOf('/ship on Capy is about a dozen calls'), capy.indexOf('## Plan, approve, ship'));
    expect(pass).toContain('Each review pass and Step 11 is one call to the checked-in pass program');
    expect(pass).toContain('gstack-review-dispatch program');
    expect(pass).not.toMatch(/one execute program per batch/);
    expect(pass).toContain('prompts verbatim from their sections');
    expect(fs.readFileSync(path.join(import.meta.dir, '..', 'ship', 'DRIVER.md'), 'utf8').replace(/\s+/g, ' ')).toContain('never walks the dispatch steps call by call');
    // GSTA-167 calls PR 2: the order now lives in the program the loader runs unchanged.
    const program = fs.readFileSync(path.join(import.meta.dir, '..', 'lib', 'capy-review-pass.js'), 'utf8');
    for (const s of ['tools.subagent.list', 'tools.subagent.get']) expect(program).toContain(s);
    const order = ["bin, 'pass'", 'gstack-review-log --start', "' sent --ledger '", "' --before '", "mark(r.reader, 'intent'", 'tools.subagent.create', 'gstack-ship-budget note', '--dispatched-at', "'OUTPUT: '"];
    const block = tmpl.slice(tmpl.indexOf('**One program per review pass.**'));
    const tmplOrder = ['gstack-review-plan', 'check --step <n> --next dispatch:<roles>', 'gstack-review-log --start', 'BEFORE', 'AFTER', 'gstack-ship-budget settle', 'the collect'];
    for (const [text, want] of [[program, order], [block, tmplOrder]] as const) {
      const at = want.map(o => text.indexOf(o));
      expect(at.every(i => i >= 0), want.filter((_, k) => at[k]! < 0).join(',')).toBe(true);
      expect([...at].sort((a, b) => a - b)).toEqual(at);
    }
  });
  test('a batch names one role per reader and is settled with the dispatch program\'s own reading pair', () => {
    expect(tmpl).toMatch(/one role per (?:reader|`DISPATCH:` line)/);
    expect(tmpl).toMatch(/Settle each batch in the program that dispatched it[\s\S]{0,300}--dispatched-at <before> --reading <after> --readers <n>/);
    expect(tmpl).toMatch(/Only that pair is measured: `check --returned`, a settle from a later\s+program \(no `--dispatched-at`\), `--finish` or a step change settles without measuring/);
  });
});
