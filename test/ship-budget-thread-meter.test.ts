/**
 * GST-1699: /ship's token cap meters /ship, not the whole thread tree. A /ship subagent reads the
 * root thread, whose counter also holds the lane's own fix work, background suites and trail
 * reads; on 2026-11-06/07 that spent /ship's cap for it about eight times (#4096-#4101). With
 * --thread the helper reads the whole tools.thread.get result, finds /ship's own tasks row (the
 * parent of a reader this run dispatched, or its GSTACK_SHIP_TASK_TITLE row) and caps that,
 * printing the tree beside it.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadCalibration, projector, readLedger } from '../lib/ship-budget';
import { budgetHarness, type Harness } from './helpers/ship-budget-harness';

const harnesses: Harness[] = [];
const fresh = () => { const h = budgetHarness(); harnesses.push(h); return h; };
afterEach(() => { while (harnesses.length) harnesses.pop()!.cleanup(); });

type Row = [label: string, title: string, tokens: number];
let n = 0;
function snap(h: Harness, tree: number, rows: Row[], dispatched?: string[]): string {
  const file = path.join(h.root, `thread-${++n}.json`);
  const tasks = rows.map(([label, title, tokens]) => ({ label, title, status: 'working', cost: { tokens, credits: tokens / 1000 } }));
  fs.writeFileSync(file, JSON.stringify({ id: 'jam_root', cost: { tokens: tree, credits: tree / 1000 }, tasks, tasks_total: tasks.length, ...(dispatched ? { dispatched } : {}) }));
  return file;
}
const field = (out: string, line: string, key: string) => Number(new RegExp(`^${line}: .*?\\b${key}=(\\d+)`, 'm').exec(out)?.[1]);
const SHIP = '/ship PR #4098';
const P1 = 'ship r1-p1 specialist';

describe('/ship meters its own tasks row, not the tree (GST-1699)', () => {
  // Value: protects=a lane's own work (its fix calls, background suites, sibling subagents) never moves /ship's used= or spends its cap; fails_when=used= follows the root counter after /ship's row is known;
  //   why_new=#4098 stopped at 47.1M on the tree while /ship's own row was far lower, and stopped again right after the cap raise (GST-1699); seam=none; no_claim=spend before /ship's first reader when no task title names its row (labelled tree fallback)
  test('lane work outside /ship does not move used=, and the cap does not stop on it', () => {
    const h = fresh();
    const s = h.sb(['start', '--record', h.record(), '--mode', 'observe', '--token-cap', '8M', '--thread', snap(h, 100_000_000, [['Subagent 1', SHIP, 5_000_000]])]);
    expect(s.code, s.out + s.err).toBe(0);
    const run = h.field(s.out, 'BUDGET_RUN', 'id');
    const pass = h.sb(['note', '--run', run, '--step', '9', '--readers', '1', '--thread',
      snap(h, 140_000_000, [['Subagent 1', SHIP, 10_000_000], ['Subagent 1.1', P1, 3_000_000], ['Subagent 2', 'lane suite', 4_000_000]], [P1])]);
    expect(pass.code, pass.out + pass.err).toBe(0);
    expect(field(pass.out, 'NOTE', 'used')).toBe(5_000_000);
    expect(field(pass.out, 'NOTE', 'tree')).toBe(40_000_000);
    expect(pass.out).toContain('METER: ship (task row Subagent 1');
    const lane = h.sb(['note', '--run', run, '--step', '10', '--thread',
      snap(h, 260_000_000, [['Subagent 1', SHIP, 10_000_000], ['Subagent 1.1', P1, 3_000_000], ['Subagent 2', 'lane suite', 60_000_000]])]);
    expect(lane.code, lane.out + lane.err).toBe(0);
    expect(field(lane.out, 'NOTE', 'used')).toBe(5_000_000);
    expect(field(lane.out, 'NOTE', 'tree')).toBe(160_000_000);
    expect(field(lane.out, 'BUDGET', 'used')).toBe(5_000_000);
    expect(lane.out).toMatch(/verdict=continue/);
    const close = h.sb(['close', '--run', run, '--thread', snap(h, 270_000_000, [['Subagent 1', SHIP, 10_000_000], ['Subagent 2', 'lane suite', 70_000_000]])]);
    expect(close.code, close.out + close.err).toBe(0);
    expect(close.out).toMatch(/^BUDGET_FINAL: used=5000000 tree=170000000 credits=5000 /m);
  });

  // Value: protects=/ship's own readers and calls still count, so the cap still bounds /ship; fails_when=a reader's or /ship's own spend is left out of used= or readers_tokens;
  //   why_new=metering one row must not lose the readers it dispatches (GST-1699); seam=none; no_claim=readers dispatched by another run
  test("/ship's own readers move used=, readers_tokens comes from their rows, and the cap stops on them", () => {
    const h = fresh();
    const s = h.sb(['start', '--record', h.record(), '--mode', 'observe', '--token-cap', '8M', '--thread', snap(h, 100_000_000, [['Subagent 1', SHIP, 5_000_000]])]);
    const run = h.field(s.out, 'BUDGET_RUN', 'id');
    const p1 = h.sb(['note', '--run', run, '--step', '9', '--readers', '1', '--thread',
      snap(h, 110_000_000, [['Subagent 1', SHIP, 9_000_000], ['Subagent 1.1', P1, 3_000_000]], [P1])]);
    expect(field(p1.out, 'NOTE', 'used')).toBe(4_000_000);
    expect(field(p1.out, 'NOTE', 'readers_tokens')).toBe(3_000_000);
    const p2 = h.sb(['note', '--run', run, '--step', '11', '--readers', '1', '--thread',
      snap(h, 116_000_000, [['Subagent 1', SHIP, 15_000_000], ['Subagent 1.1', P1, 3_000_000], ['Subagent 1.2', 'ship r1-p2 outside-voice', 6_000_000]], ['ship r1-p2 outside-voice'])]);
    expect(field(p2.out, 'NOTE', 'used')).toBe(10_000_000);
    expect(field(p2.out, 'NOTE', 'readers_tokens')).toBe(6_000_000);
    expect(p2.code).toBe(3);
    expect(p2.out).toMatch(/^STOP: reason=budget_exhausted spent=10000000 /m);
  });

  // Value: protects=a brief's GSTACK_SHIP_TASK_TITLE pins /ship's row from the first reading; fails_when=a titled run meters the tree before its first reader;
  //   why_new=captain.md's titled /ship subagent (GST-1699); seam=none; no_claim=none
  test('a task title finds the row at start, so the preflight is metered on /ship alone too', () => {
    const h = fresh();
    const title = 'ship #4098 at 746121d q7x2';
    const s = h.sb(['start', '--record', h.record(), '--mode', 'observe', '--thread', snap(h, 100_000_000, [['Subagent 3', title, 1_000_000], ['Subagent 1', 'lane fix', 50_000_000]])], { GSTACK_SHIP_TASK_TITLE: title });
    expect(s.code, s.out + s.err).toBe(0);
    expect(s.out).toContain('BUDGET_DEFAULT_CAP: 100M');
    expect(s.out).toContain('METER: ship (task row Subagent 3');
    const run = h.field(s.out, 'BUDGET_RUN', 'id');
    const note = h.sb(['note', '--run', run, '--step', '6', '--thread', snap(h, 180_000_000, [['Subagent 3', title, 3_000_000], ['Subagent 1', 'lane fix', 120_000_000]])]);
    expect(field(note.out, 'NOTE', 'used')).toBe(2_000_000);
    expect(field(note.out, 'NOTE', 'tree')).toBe(80_000_000);
  });

  // Value: protects=an untitled --thread start gets no 100M default cap, as on main; fails_when=an untitled start in tree fallback gets the default cap and a lane's preflight work can stop /ship;
  //   why_new=/ship pre-landing review of #4107 reproduced BUDGET_DEFAULT_CAP beside METER_FALLBACK (GST-1699); seam=none; no_claim=a cap once the row is found later
  test('a --thread start in tree fallback with no --token-cap gets no default cap', () => {
    const h = fresh();
    const s = h.sb(['start', '--record', h.record(), '--mode', 'observe', '--thread', snap(h, 100_000_000, [['Subagent 1', 'lane fix', 5_000_000]])]);
    expect(s.code, s.out + s.err).toBe(0);
    expect(s.out).toContain('METER_FALLBACK');
    expect(s.out).not.toContain('BUDGET_DEFAULT_CAP');
    expect(s.out).not.toContain('admission_cap=100000000');
  });

  // Value: protects=a titled /ship keeps the 100M default cap even while its row is not listed yet; fails_when=a titled --thread start whose title matches no listed row runs uncapped;
  //   why_new=/ship fix-check on #4107 (p2/targeted#1): the default followed row resolution, so a titled run with an unresolved row had no cap; seam=none; no_claim=untitled runs, which get no default as on main
  test('a titled --thread start whose row is not listed yet still gets the 100M default cap', () => {
    const h = fresh();
    const s = h.sb(['start', '--record', h.record(), '--mode', 'observe', '--thread', snap(h, 100_000_000, [['Subagent 1', 'lane fix', 5_000_000]])], { GSTACK_SHIP_TASK_TITLE: 'ship #4107 at 6b7f601 z9' });
    expect(s.code, s.out + s.err).toBe(0);
    expect(s.out).toContain('METER_FALLBACK');
    expect(s.out).toContain('BUDGET_DEFAULT_CAP: 100M');
    expect(s.out).toContain('admission_cap=100000000');
  });

  // Value: protects=while /ship's row is missing from a truncated snapshot used= advances by tree growth, so the cap still stops; fails_when=METER_ROW_MISSING holds used= flat and the cap fails open, or the row's return below that upper bound is rejected;
  //   why_new=/ship fix-check on #4107 (p2/targeted#2); seam=none; no_claim=the exact /ship cost while its row is missing
  test('a row missing from a later snapshot advances used= by tree growth, and the cap stops on it', () => {
    const h = fresh();
    const s = h.sb(['start', '--record', h.record(), '--mode', 'observe', '--token-cap', '12M', '--thread', snap(h, 100_000_000, [['Subagent 1', SHIP, 5_000_000]])], { GSTACK_SHIP_TASK_TITLE: SHIP });
    expect(s.code, s.out + s.err).toBe(0);
    const run = h.field(s.out, 'BUDGET_RUN', 'id');
    const seen = h.sb(['note', '--run', run, '--step', '6', '--thread', snap(h, 110_000_000, [['Subagent 1', SHIP, 9_000_000]])]);
    expect(field(seen.out, 'NOTE', 'used')).toBe(4_000_000);
    const missing = h.sb(['note', '--run', run, '--step', '9', '--thread', snap(h, 115_000_000, [['Subagent 2', 'lane suite', 1]])]);
    expect(missing.code, missing.out + missing.err).toBe(0);
    expect(missing.out).toContain('METER_ROW_MISSING: Subagent 1');
    expect(field(missing.out, 'NOTE', 'used')).toBe(9_000_000);
    const back = h.sb(['note', '--run', run, '--step', '10', '--thread', snap(h, 116_000_000, [['Subagent 1', SHIP, 10_000_000]])]);
    expect(back.code, back.out + back.err).toBe(0);
    expect(field(back.out, 'NOTE', 'used')).toBe(9_000_000);
    const over = h.sb(['note', '--run', run, '--step', '11', '--thread', snap(h, 121_000_000, [['Subagent 2', 'lane suite', 1]])]);
    expect(field(over.out, 'NOTE', 'used')).toBe(14_000_000);
    expect(over.code).toBe(3);
    expect(over.out).toMatch(/^STOP: reason=budget_exhausted /m);
  });

  // Value: protects=where /ship's usage cannot be separated the run still caps the tree and says so on every cost line, with the reason; fails_when=a fallback run prints an unlabelled used= or uncaps itself;
  //   why_new=GST-1699 keeps the tree as a labelled fallback; seam=none; no_claim=the exact /ship cost of a root-thread /ship
  test('before its row is found, and for /ship on the root thread, the run meters the tree, labelled with the reason', () => {
    const h = fresh();
    const s = h.sb(['start', '--record', h.record(), '--mode', 'observe', '--token-cap', '50M', '--thread', snap(h, 100_000_000, [['Subagent 1', 'lane fix', 5_000_000]])]);
    expect(s.out).toContain('METER_FALLBACK: no subagent this run created is listed yet');
    const run = h.field(s.out, 'BUDGET_RUN', 'id');
    const note = h.sb(['note', '--run', run, '--step', '9', '--readers', '1', '--thread', snap(h, 120_000_000, [['Subagent 1', 'lane fix', 5_000_000], ['Subagent 2', P1, 3_000_000]], [P1])]);
    expect(note.out).toContain("METER_FALLBACK: this run's readers are top-level subagents");
    expect(field(note.out, 'NOTE', 'used')).toBe(20_000_000);
    expect(note.out).toMatch(/^NOTE: [^\n]*\nMETER: tree \(root counter, upper bound\)$/m);
    expect(h.sb(['note', '--run', run, '--step', '10', '--reading', '130000000']).err).toContain('pass --thread');
  });

  // Value: protects=the RECOVER cap covers every step still to run, not only Step 22 and the stop reserve; fails_when=an observe stop at a labelled step (9.2, judge) names used + Step 22 + reserve;
  //   why_new=#4098's RECOVER named 54.45M at 47.1M used and /ship then needed 66M (GST-1699); seam=lib/ship-budget.ts projector; no_claim=that the priors match any one run
  test('an observe stop names a RECOVER cap that covers the noted step through Step 22 at the run\'s own pace', () => {
    const h = fresh();
    const s = h.sb(['start', '--record', h.record(), '--mode', 'observe', '--token-cap', '20M', '--reading', '1000000', '--credits', '1']);
    const run = h.field(s.out, 'BUDGET_RUN', 'id');
    const stop = h.sb(['note', '--run', run, '--step', '9.2', '--reading', '30000000', '--credits', '30']);
    expect(stop.code).toBe(3);
    const l = readLedger(h.field(s.out, 'BUDGET_RUN', 'ledger'));
    const cal = loadCalibration();
    const p = projector(l, cal);
    const pace = (29_000_000 / p.segment('0.9', '8')) * cal.headroom;
    const left = Math.ceil(p.segment('9', '22') * pace);
    expect(left).toBeGreaterThan(p.segment('22', '22'));
    expect(Number(/^RECOVER: .* --token-cap (\d+)$/m.exec(stop.out)![1])).toBe(29_000_000 + left + p.reserve);
    expect(stop.out).toContain(`REMAINING: steps=9-22 projected=${left} rate=${pace.toFixed(2)} reserve=${p.reserve}`);
  });
});
