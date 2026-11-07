/**
 * GST-1699: /ship's token cap meters /ship, not the whole thread tree. A /ship subagent reads the
 * root thread, whose counter also holds the lane's own fix work, background suites and trail
 * reads; on 2026-11-06/07 that spent /ship's cap for it about eight times (#4096-#4101). With
 * --thread the helper reads the whole tools.thread.get result, finds /ship's own tasks row (the
 * parent of a reader this run dispatched, or its GSTACK_SHIP_TASK_TITLE row) and caps that,
 * printing the tree beside it.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
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
  //   why_new=#4098 stopped at 47.1M on the tree while /ship's own row was far lower, and stopped again right after the cap raise (GST-1699); seam=none; no_claim=a note with neither a task title nor readers of its own, which meters the tree by design
  test('lane work outside /ship does not move used=, and the cap does not stop on it', () => {
    const h = fresh();
    const titled = { GSTACK_SHIP_TASK_TITLE: SHIP };
    const s = h.sb(['start', '--record', h.record(), '--mode', 'observe', '--token-cap', '8M', '--thread', snap(h, 100_000_000, [['Subagent 1', SHIP, 5_000_000]])], titled);
    expect(s.code, s.out + s.err).toBe(0);
    const run = h.field(s.out, 'BUDGET_RUN', 'id');
    const pass = h.sb(['note', '--run', run, '--step', '9', '--readers', '1', '--thread',
      snap(h, 140_000_000, [['Subagent 1', SHIP, 10_000_000], ['Subagent 1.1', P1, 3_000_000], ['Subagent 2', 'lane suite', 4_000_000]], [P1])]);
    expect(pass.code, pass.out + pass.err).toBe(0);
    expect(field(pass.out, 'NOTE', 'used')).toBe(5_000_000);
    expect(field(pass.out, 'NOTE', 'tree')).toBe(40_000_000);
    expect(pass.out).toContain('METER: ship (task row Subagent 1');
    const lane = h.sb(['note', '--run', run, '--step', '10', '--thread',
      snap(h, 260_000_000, [['Subagent 1', SHIP, 10_000_000], ['Subagent 1.1', P1, 3_000_000], ['Subagent 2', 'lane suite', 60_000_000]])], titled);
    expect(lane.code, lane.out + lane.err).toBe(0);
    expect(field(lane.out, 'NOTE', 'used')).toBe(5_000_000);
    expect(field(lane.out, 'NOTE', 'tree')).toBe(160_000_000);
    expect(field(lane.out, 'BUDGET', 'used')).toBe(5_000_000);
    expect(lane.out).toMatch(/verdict=continue/);
    const close = h.sb(['close', '--run', run, '--thread', snap(h, 270_000_000, [['Subagent 1', SHIP, 10_000_000], ['Subagent 2', 'lane suite', 70_000_000]])], titled);
    expect(close.code, close.out + close.err).toBe(0);
    expect(close.out).toMatch(/^BUDGET_FINAL: used=5000000 tree=170000000 credits=5000 /m);
  });

  // Value: protects=/ship's own readers and calls still count, so the cap still bounds /ship; fails_when=a reader's or /ship's own spend is left out of used= or readers_tokens;
  //   why_new=metering one row must not lose the readers it dispatches (GST-1699); seam=none; no_claim=readers dispatched by another run
  test("/ship's own readers move used=, readers_tokens comes from their rows, and the cap stops on them", () => {
    const h = fresh();
    const s = h.sb(['start', '--record', h.record(), '--mode', 'observe', '--token-cap', '8M', '--thread', snap(h, 100_000_000, [['Subagent 1', SHIP, 5_000_000]])], { GSTACK_SHIP_TASK_TITLE: SHIP });
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
    const note = h.sb(['note', '--run', run, '--step', '6', '--thread', snap(h, 180_000_000, [['Subagent 3', title, 3_000_000], ['Subagent 1', 'lane fix', 120_000_000]])], { GSTACK_SHIP_TASK_TITLE: title });
    expect(field(note.out, 'NOTE', 'used')).toBe(2_000_000);
    expect(field(note.out, 'NOTE', 'tree')).toBe(80_000_000);
  });

  // Value: protects=a --thread observe start with no --token-cap and no task title keeps the 100M default cap, as main's --reading-from task start did; fails_when=the default reaches a --thread run only through GSTACK_SHIP_TASK_TITLE, which nothing exports, so it runs uncapped;
  //   why_new=/ship targeted re-read of #4107 (lib/ship-budget-cli.ts:300:money): an untitled --thread start ran uncapped where main capped it at 100M; seam=none; no_claim=which row the run meters
  test('a --thread start with no --token-cap and no task title gets the 100M default cap, even in tree fallback', () => {
    const h = fresh();
    const s = h.sb(['start', '--record', h.record(), '--mode', 'observe', '--thread', snap(h, 100_000_000, [['Subagent 1', 'lane fix', 5_000_000]])], { GSTACK_SHIP_TASK_TITLE: '' });
    expect(s.code, s.out + s.err).toBe(0);
    expect(s.out).toContain('METER_FALLBACK');
    expect(s.out).toContain('BUDGET_DEFAULT_CAP: 100M');
    expect(s.out).toContain('admission_cap=100000000');
    for (const cap of ['none', '30M']) {
      const o = fresh();
      const out = o.sb(['start', '--record', o.record(), '--mode', 'observe', '--token-cap', cap, '--thread', snap(o, 100_000_000, [['Subagent 1', 'lane fix', 5_000_000]])]);
      expect(out.code, out.out + out.err).toBe(0);
      expect(out.out).not.toContain('BUDGET_DEFAULT_CAP');
    }
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

  // Value: protects=while /ship's row is missing from a truncated snapshot the reading meters the tree, so used= keeps growing and the cap still stops; fails_when=a missing row holds used= flat, refuses the note, or a later return of the row is rejected;
  //   why_new=/ship fix-check on #4107 (p2/targeted#2) and the Captain's fallback-on-ambiguity rule (GST-1699); seam=none; no_claim=the exact /ship cost while its row is missing
  test('a row missing from a later snapshot meters that reading on the tree, and the cap stops on it', () => {
    const h = fresh();
    const titled = { GSTACK_SHIP_TASK_TITLE: SHIP };
    const s = h.sb(['start', '--record', h.record(), '--mode', 'observe', '--token-cap', '12M', '--thread', snap(h, 100_000_000, [['Subagent 1', SHIP, 5_000_000]])], titled);
    expect(s.code, s.out + s.err).toBe(0);
    const run = h.field(s.out, 'BUDGET_RUN', 'id');
    const seen = h.sb(['note', '--run', run, '--step', '6', '--thread', snap(h, 110_000_000, [['Subagent 1', SHIP, 9_000_000]])], titled);
    expect(field(seen.out, 'NOTE', 'used')).toBe(4_000_000);
    const missing = h.sb(['note', '--run', run, '--step', '9', '--thread', snap(h, 115_000_000, [['Subagent 2', 'lane suite', 1]])], titled);
    expect(missing.code, missing.out + missing.err).toBe(0);
    expect(missing.out).toContain('METER_FALLBACK: 0 rows carry the task title');
    expect(field(missing.out, 'NOTE', 'used')).toBe(9_000_000);
    const back = h.sb(['note', '--run', run, '--step', '10', '--thread', snap(h, 116_000_000, [['Subagent 1', SHIP, 10_000_000]])], titled);
    expect(back.code, back.out + back.err).toBe(0);
    expect(field(back.out, 'NOTE', 'used')).toBe(10_000_000);
    const over = h.sb(['note', '--run', run, '--step', '11', '--thread', snap(h, 121_000_000, [['Subagent 2', 'lane suite', 1]])], titled);
    expect(field(over.out, 'NOTE', 'used')).toBe(15_000_000);
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

  // Value: protects=a second /ship in the same lane finds its own row although an earlier /ship's readers carry the same titles, and counts only its own readers; fails_when=resolve or the readers sum matches rows that existed before the run started;
  //   why_new=/ship on #4107 at 9c15d60 (voices/adversarial-native#1, #2, targeted#1): reader titles are per pass, not per run, so a re-ship metered the tree or an old row; seam=none; no_claim=an earlier reader first listed after this run's start
  test('an earlier /ship\'s same-titled readers neither pick the row nor count as this run\'s readers', () => {
    const h = fresh();
    const s = h.sb(['start', '--record', h.record(), '--mode', 'observe', '--token-cap', '100M', '--thread',
      snap(h, 100_000_000, [['Subagent 1', '/ship PR #4098 at aaa', 9_000_000], ['Subagent 1.1', P1, 3_000_000], ['Subagent 2', SHIP, 1_000_000]])]);
    expect(s.code, s.out + s.err).toBe(0);
    const run = h.field(s.out, 'BUDGET_RUN', 'id');
    const note = h.sb(['note', '--run', run, '--step', '9', '--readers', '1', '--thread',
      snap(h, 130_000_000, [['Subagent 1', '/ship PR #4098 at aaa', 9_000_000], ['Subagent 1.1', P1, 3_000_000], ['Subagent 2', SHIP, 7_000_000], ['Subagent 2.1', P1, 2_000_000]], [P1])]);
    expect(note.code, note.out + note.err).toBe(0);
    expect(note.out).toContain('METER_SCOPE: ship row=Subagent 2');
    expect(field(note.out, 'NOTE', 'used')).toBe(30_000_000);
    expect(field(note.out, 'NOTE', 'readers_tokens')).toBe(2_000_000);
    const next = h.sb(['note', '--run', run, '--step', '11', '--readers', '1', '--thread',
      snap(h, 160_000_000, [['Subagent 1', '/ship PR #4098 at aaa', 9_000_000], ['Subagent 1.1', P1, 3_000_000], ['Subagent 2', SHIP, 10_000_000], ['Subagent 2.1', P1, 2_000_000], ['Subagent 2.2', 'ship r1-p2 outside-voice', 3_000_000]], ['ship r1-p2 outside-voice'])]);
    expect(next.code, next.out + next.err).toBe(0);
    expect(field(next.out, 'NOTE', 'used')).toBe(33_000_000);
    expect(field(next.out, 'NOTE', 'readers_tokens')).toBe(3_000_000);
  });

  // Value: protects=a titled run whose title matches no row, or two rows, meters every reading on the tree, labelled, with no refusal, no stop under the cap and no flat used=; fails_when=a missed or duplicated title meters some other row or refuses the note;
  //   why_new=/ship on #4107 (voices/adversarial-native#4, fix-check#1) and the Captain's fallback-on-ambiguity rule (GST-1699); seam=none; no_claim=which row a missed title meant
  test('a task title that matches no row, or two, meters the tree with METER_FALLBACK', () => {
    for (const rows of [[['Subagent 1', SHIP, 1_000_000]], [['Subagent 1', 'ship #4107 typo', 1_000_000], ['Subagent 2', 'ship #4107 typo', 1_000_000]]] as Row[][]) {
      const h = fresh();
      const env = { GSTACK_SHIP_TASK_TITLE: 'ship #4107 typo' };
      const s = h.sb(['start', '--record', h.record(), '--mode', 'observe', '--token-cap', '100M', '--thread', snap(h, 100_000_000, rows)], env);
      expect(s.code, s.out + s.err).toBe(0);
      expect(s.out).toMatch(/METER_FALLBACK: [02] rows carry the task title/);
      const run = h.field(s.out, 'BUDGET_RUN', 'id');
      const reader = rows.length === 1 ? 'Subagent 1.1' : 'Subagent 2.1';
      const note = h.sb(['note', '--run', run, '--step', '9', '--readers', '1', '--thread', snap(h, 140_000_000, [...rows, [reader, P1, 2_000_000]], [P1])]);
      expect(note.code, note.out + note.err).toBe(0);
      expect(note.out).toMatch(/METER_FALLBACK: [02] rows carry the task title/);
      expect(field(note.out, 'NOTE', 'used')).toBe(40_000_000);
      expect(note.out).toContain('METER: tree (root counter, upper bound)');
    }
  });

  // Value: protects=a replacement /ship subagent's commands (another task title) meter the tree, so the cap keeps binding and nothing is refused; fails_when=the run keeps reading its finished predecessor's row (used= flat) or refuses the replacement's note or resume;
  //   why_new=/ship on #4107 (voices/outside-voice#1, review-p2b/red-team#1) and the Captain's fallback-on-ambiguity rule (GST-1699); seam=none; no_claim=the replacement's exact cost
  test('a note or resume under another task title meters the tree, never refused and never flat', () => {
    const h = fresh();
    const s = h.sb(['start', '--record', h.record(), '--mode', 'observe', '--token-cap', '100M', '--thread', snap(h, 100_000_000, [['Subagent 1', SHIP, 1_000_000]])], { GSTACK_SHIP_TASK_TITLE: SHIP });
    const run = h.field(s.out, 'BUDGET_RUN', 'id');
    const retry = { GSTACK_SHIP_TASK_TITLE: '/ship PR #4098 retry' };
    const note = h.sb(['note', '--run', run, '--step', '9', '--thread', snap(h, 140_000_000, [['Subagent 1', SHIP, 5_000_000], ['Subagent 2', '/ship PR #4098 retry', 30_000_000]])], retry);
    expect(note.code, note.out + note.err).toBe(0);
    expect(note.out).toContain('METER_FALLBACK: this command\'s task title "/ship PR #4098 retry" is not the run\'s');
    expect(field(note.out, 'NOTE', 'used')).toBe(40_000_000);
    const resume = h.sb(['resume', '--run', run, '--thread', snap(h, 150_000_000, [['Subagent 1', SHIP, 5_000_000], ['Subagent 2', '/ship PR #4098 retry', 40_000_000]])], retry);
    expect(resume.code, resume.out + resume.err).toBe(0);
    expect(resume.out).toContain('METER_FALLBACK');
    const after = h.sb(['note', '--run', run, '--step', '10', '--readers', '1', '--thread',
      snap(h, 160_000_000, [['Subagent 1', SHIP, 5_000_000], ['Subagent 2', '/ship PR #4098 retry', 48_000_000], ['Subagent 2.1', P1, 2_000_000]], [P1])]);
    expect(after.code, after.out + after.err).toBe(0);
    expect(after.out).toContain('METER_FALLBACK: the run\'s identity points at Subagent 1, Subagent 2');
    expect(field(after.out, 'NOTE', 'used')).toBe(60_000_000);
  });

  // Value: protects=RECOVER after a budget stop, which resumes in a new /ship subagent under a new title, is accepted and keeps metering (on the tree) from the usage so far; fails_when=the resume is refused, or used= drops or stays flat while the new subagent works;
  //   why_new=/ship on #4107 (review-p2b/red-team#1: the round-1 guard refused every RECOVER) and the Captain's fallback-on-ambiguity rule (GST-1699); seam=none; no_claim=a rebind to the new row, which the rule replaces with the tree
  test('RECOVER under a new task title resumes, carries used= and meters the tree', () => {
    const h = fresh();
    const s = h.sb(['start', '--record', h.record(), '--mode', 'observe', '--token-cap', '8M', '--thread', snap(h, 100_000_000, [['Subagent 1', SHIP, 1_000_000]])], { GSTACK_SHIP_TASK_TITLE: SHIP });
    const run = h.field(s.out, 'BUDGET_RUN', 'id');
    const stop = h.sb(['note', '--run', run, '--step', '9', '--thread', snap(h, 120_000_000, [['Subagent 1', SHIP, 11_000_000]])], { GSTACK_SHIP_TASK_TITLE: SHIP });
    expect(stop.code, stop.out + stop.err).toBe(3);
    expect(field(stop.out, 'NOTE', 'used')).toBe(10_000_000);
    const next = { GSTACK_SHIP_TASK_TITLE: 'ship #4107 at da2ab1e r2d2' };
    const resume = h.sb(['resume', '--run', run, '--token-cap', '60M', '--approved-by', 'garry', '--words', 'do it', '--thread',
      snap(h, 125_000_000, [['Subagent 1', SHIP, 11_000_000], ['Subagent 2', next.GSTACK_SHIP_TASK_TITLE, 500_000]])], next);
    expect(resume.code, resume.out + resume.err).toBe(0);
    expect(resume.out).toContain('METER_FALLBACK');
    const note = h.sb(['note', '--run', run, '--step', '10', '--thread', snap(h, 160_000_000, [['Subagent 1', SHIP, 11_000_000], ['Subagent 2', next.GSTACK_SHIP_TASK_TITLE, 6_500_000]])], next);
    expect(note.code, note.out + note.err).toBe(0);
    expect(field(note.out, 'NOTE', 'used')).toBe(50_000_000);
    expect(note.out).toContain('METER: tree (root counter, upper bound)');
  });

  // Value: protects=a note or close that names neither a task title nor readers of its own meters the tree instead of being refused, and a pass note proves the row by its readers; fails_when=an untitled command is refused, meters the stored title's row unconfirmed, or holds used= flat;
  //   why_new=/ship fix-check on #4107 (fix-check#1: the pass program's untitled note was refused) and the Captain's rule that a missing title means the tree (GST-1699); seam=none; no_claim=which subagent an untitled command runs in
  test('an untitled note or close meters the tree; an untitled pass note meters the row its readers prove', () => {
    const h = fresh();
    const s = h.sb(['start', '--record', h.record(), '--mode', 'observe', '--token-cap', '100M', '--thread', snap(h, 100_000_000, [['Subagent 1', SHIP, 1_000_000]])], { GSTACK_SHIP_TASK_TITLE: SHIP });
    const run = h.field(s.out, 'BUDGET_RUN', 'id');
    const bare = h.sb(['note', '--run', run, '--step', '6', '--thread', snap(h, 110_000_000, [['Subagent 1', SHIP, 2_000_000]])]);
    expect(bare.code, bare.out + bare.err).toBe(0);
    expect(bare.out).toContain('METER_FALLBACK: this command names no task title and no readers of its own');
    expect(field(bare.out, 'NOTE', 'used')).toBe(10_000_000);
    const pass = h.sb(['note', '--run', run, '--step', '9', '--readers', '1', '--thread', snap(h, 120_000_000, [['Subagent 1', SHIP, 4_000_000], ['Subagent 1.1', P1, 1_000_000]], [P1])]);
    expect(pass.code, pass.out + pass.err).toBe(0);
    expect(pass.out).toContain('METER: ship (task row Subagent 1');
    expect(field(pass.out, 'NOTE', 'used')).toBe(20_000_000);
    const next = h.sb(['note', '--run', run, '--step', '10', '--readers', '1', '--thread', snap(h, 150_000_000, [['Subagent 1', SHIP, 7_000_000], ['Subagent 1.1', P1, 1_000_000], ['Subagent 1.2', 'ship r1-p2 outside-voice', 2_000_000]], ['ship r1-p2 outside-voice'])]);
    expect(field(next.out, 'NOTE', 'used')).toBe(23_000_000);
    const close = h.sb(['close', '--run', run, '--thread', snap(h, 160_000_000, [['Subagent 1', SHIP, 7_000_000]])]);
    expect(close.code, close.out + close.err).toBe(0);
    expect(close.out).toMatch(/^BUDGET_FINAL: used=33000000 /m);
  });

  // Value: protects=a titled --thread start hands its later shells the task title through a sourceable file, so DRIVER's phase notes and close meter /ship's row instead of the tree; fails_when=start prints no TITLE_FILE, the file loses a quote in the title, or a note run after sourcing it falls back;
  //   why_new=/ship on #4107 (review-p1/red-team#1): DRIVER and the launch file never carried GSTACK_SHIP_TASK_TITLE, so the row meter rarely engaged (GST-1699); seam=bash sourcing the file; no_claim=that a lane follows DRIVER
  test('a titled start prints a TITLE_FILE that later shells source to meter /ship\'s row', () => {
    const h = fresh();
    const title = "ship #4107 at 76f7a3f it's";
    const s = h.sb(['start', '--record', h.record(), '--mode', 'observe', '--thread', snap(h, 100_000_000, [['Subagent 1', title, 1_000_000]])], { GSTACK_SHIP_TASK_TITLE: title });
    expect(s.code, s.out + s.err).toBe(0);
    const file = /^TITLE_FILE: (\S+) /m.exec(s.out)![1]!;
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const run = h.field(s.out, 'BUDGET_RUN', 'id');
    const next = snap(h, 130_000_000, [['Subagent 1', title, 4_000_000]]);
    const sourced = spawnSync('bash', ['-c', '. "$1" && printf %s "$GSTACK_SHIP_TASK_TITLE"', '_', file], { encoding: 'utf8', timeout: 30_000 });
    expect(sourced.stdout).toBe(title);
    const note = h.sb(['note', '--run', run, '--step', '6', '--thread', next], { GSTACK_SHIP_TASK_TITLE: sourced.stdout });
    expect(note.code, note.out + note.err).toBe(0);
    expect(field(note.out, 'NOTE', 'used')).toBe(3_000_000);
    expect(note.out).not.toContain('METER_FALLBACK');
    const bare = fresh();
    expect(bare.sb(['start', '--record', bare.record(), '--mode', 'observe', '--thread', snap(bare, 100_000_000, [['Subagent 1', title, 1_000_000]])]).out).not.toContain('TITLE_FILE');
  });

  // Value: protects=used= never goes down across any sequence of readings (row identified, tree fallback, row re-identified, another title, a resume in a new or an older subagent), so the cap can over-count but never under-count; fails_when=any reading lowers used=, e.g. a first identification rebasing used= onto one row's growth;
  //   why_new=/ship on #4107 at 76f7a3f and e4becdc (review-p1/specialist-batched#1 and review-p2/red-team#1: the first-identification rebase dropped used= from 41M to 8M); seam=none; no_claim=how far a fallback over-counts
  test('used= never decreases across identified, fallback, re-identified and rebound readings', () => {
    const used = (out: string) => field(out, 'NOTE', 'used');
    const series = (h: Harness, run: string, steps: Array<[Row[], number, string[] | undefined, Record<string, string>]>) => {
      const seen: number[] = [];
      steps.forEach(([rows, tree, dispatched, env], i) => {
        const r = h.sb(['note', '--run', run, '--step', String(6 + i), ...(dispatched ? ['--readers', '1'] : []), '--thread', snap(h, tree, rows, dispatched)], env);
        expect(r.code, r.out + r.err).toBe(0);
        seen.push(used(r.out));
      });
      for (let i = 1; i < seen.length; i++) expect(seen[i], seen.join(',')).toBeGreaterThanOrEqual(seen[i - 1]!);
      return seen;
    };
    const t = fresh();
    const titled = { GSTACK_SHIP_TASK_TITLE: SHIP };
    const ts = t.sb(['start', '--record', t.record(), '--mode', 'observe', '--token-cap', '1000M', '--thread', snap(t, 100_000_000, [['Subagent 1', SHIP, 1_000_000]])], titled);
    const trun = t.field(ts.out, 'BUDGET_RUN', 'id');
    const tseen = series(t, trun, [
      [[['Subagent 1', SHIP, 5_000_000]], 110_000_000, undefined, titled],
      [[['Subagent 1', SHIP, 6_000_000]], 130_000_000, undefined, {}],
      [[['Subagent 1', SHIP, 9_000_000], ['Subagent 1.1', P1, 2_000_000]], 140_000_000, [P1], {}],
      [[['Subagent 1', SHIP, 10_000_000], ['Subagent 2', 'ship retry', 3_000_000]], 150_000_000, undefined, { GSTACK_SHIP_TASK_TITLE: 'ship retry' }],
      [[['Subagent 2', 'ship retry', 4_000_000]], 155_000_000, undefined, titled],
      [[['Subagent 1', SHIP, 12_000_000], ['Subagent 2', 'ship retry', 4_000_000]], 160_000_000, undefined, titled],
      [[['Subagent 1', SHIP, 13_000_000], ['Subagent 2', 'ship retry', 4_000_000]], 161_000_000, undefined, titled],
    ]);
    expect(tseen).toEqual([4_000_000, 24_000_000, 34_000_000, 44_000_000, 49_000_000, 54_000_000, 55_000_000]);
    const u = fresh();
    const us = u.sb(['start', '--record', u.record(), '--mode', 'observe', '--token-cap', '1000M', '--thread', snap(u, 100_000_000, [['Subagent 1', 'ship A', 1_000_000], ['Subagent 3', 'ship old', 5_000_000]])]);
    const urun = u.field(us.out, 'BUDGET_RUN', 'id');
    u.sb(['resume', '--run', urun, '--thread', snap(u, 141_000_000, [['Subagent 1', 'ship A', 41_000_000], ['Subagent 3', 'ship old', 5_000_000]])]);
    const useen = series(u, urun, [
      [[['Subagent 1', 'ship A', 41_000_000], ['Subagent 3', 'ship old', 8_000_000], ['Subagent 3.1', P1, 2_000_000]], 150_000_000, [P1], {}],
      [[['Subagent 1', 'ship A', 41_000_000], ['Subagent 3', 'ship old', 12_000_000], ['Subagent 3.1', P1, 2_000_000], ['Subagent 3.2', 'ship r1-p2 outside-voice', 3_000_000]], 160_000_000, ['ship r1-p2 outside-voice'], {}],
      [[['Subagent 1', 'ship A', 41_000_000], ['Subagent 4', 'ship B', 1_000_000], ['Subagent 4.1', P1, 1_000_000]], 170_000_000, [P1], {}],
    ]);
    expect(useen[0]).toBeGreaterThanOrEqual(48_000_000);
    expect(useen).toEqual([50_000_000, 54_000_000, 64_000_000]);
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
