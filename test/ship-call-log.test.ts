/**
 * gstack-ship-budget calls --run|--record (GST-1585, GSTA-330 H1): a Capy /ship helper cannot read its own
 * transcript, so every helper reported CALLS: unavailable. The gstack-ship-* bins and the review pass loader
 * now append one row each to the state root's call log, and calls rebuilds the helper's calls from those rows
 * (no added call): phase programs, pass polls, section reads, and the keep-alives that fill the time between.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { countLoggedCalls, type CallRow } from '../lib/ship-call-log';

const BIN_DIR = path.resolve(import.meta.dir, '..', 'bin');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-call-log-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const run = (bin: string, args: string[], state: string) =>
  spawnSync(path.join(BIN_DIR, bin), args, { encoding: 'utf8', timeout: 60_000, env: { ...process.env, GSTACK_STATE_ROOT: state, GSTACK_CAPY: '1', GSTACK_SHIP_CALL_NESTED: '' } });
const rows = (state: string): CallRow[] => fs.readFileSync(path.join(state, 'ship-calls.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const at = (s: string) => `2026-11-06T${s}Z`;
const row = (t: string, bin: string, sub: string, ms = 200, extra: Partial<CallRow> = {}): CallRow => ({ v: 1, bin, sub, start: at(t), ms, exit: 0, ...extra });
// A helper's day, shortened: a phase program, waits, a phase program, a four-call review pass, a section read, a phase program, a queue command.
const DAY: CallRow[] = [
  row('10:00:00.000', 'gstack-ship-budget', 'start', 300),
  row('10:00:01.000', 'gstack-ship-preflight', '', 2000),
  row('10:00:05.000', 'gstack-ship-budget', 'note', 200, { step: '2', reading: 400000, credits: 100 }),
  row('10:00:05.500', 'gstack-ship-parts', 'next', 300),
  row('10:12:00.000', 'gstack-ship-preflight', '', 3000),
  row('10:12:04.000', 'gstack-ship-budget', 'note', 200, { step: '6' }),
  row('10:12:30.000', 'gstack-review-dispatch', 'program', 100),
  row('10:12:31.000', 'gstack-review-dispatch', 'pass', 1500),
  row('10:12:40.000', 'gstack-review-dispatch', 'sent', 100),
  row('10:16:05.000', 'gstack-review-dispatch', 'program', 100),
  row('10:19:45.000', 'gstack-review-dispatch', 'program', 100),
  row('10:23:45.000', 'gstack-review-dispatch', 'program', 100),
  row('10:24:30.000', 'gstack-ship-budget', 'note', 200, { step: '9' }),
  row('10:24:31.000', 'gstack-review-dispatch', 'collect', 500),
  row('10:25:00.000', 'gstack-ship-parts', 'next', 300),
  row('10:25:30.000', 'gstack-ship-budget', 'note', 200, { step: '12' }),
  row('10:40:00.000', 'gstack-ship-queue', 'ready', 4000),
];
const DAY_LINE = `CALLS: source=log calls=9 phase=3 pass=4 section=1 other=1 keepalive_est=7 total_est=16 pass_overhead_s=p50:20,max:40 gaps_over_300s=2 max_gap_s=870 first=${at('10:00:00.000')} last=${at('10:40:00.000')}`;

describe('the call log', () => {
  // Value: protects=a helper's calls are counted from the commands it already runs, so each gstack-ship-* bin and the pass loader must leave one row with its subcommand, step, readings, exit and duration, and a bin a gstack-ship-* bin spawns must not add a second row; fails_when=a bin writes no row on Capy, writes one off Capy (a test's real home), drops --step/--reading/--credits, logs a nested child, or a log write failure changes the command's output or exit;
  //   why_new=every helper reported CALLS: unavailable (GSTA-326 step0.tsv); seam=none; no_claim=which calls a helper makes without running a gstack command (the keep-alive estimate covers those)
  test('each bin appends one row; a failed log write changes nothing', () => {
    const state = fs.mkdtempSync(path.join(tmp, 'state-'));
    const parts = run('gstack-ship-parts', [], state);
    const note = run('gstack-ship-budget', ['note', '--run', 'nope', '--step', '7', '--reading', '5', '--credits', '1.5'], state);
    const loader = run('gstack-review-dispatch', ['program'], state);
    expect(loader.status, loader.stderr).toBe(0);
    const got = rows(state);
    expect(got.map(r => [r.bin, r.sub, r.exit])).toEqual([['gstack-ship-parts', '', Number(parts.status)], ['gstack-ship-budget', 'note', Number(note.status)], ['gstack-review-dispatch', 'program', 0]]);
    expect(got[1]).toMatchObject({ v: 1, step: '7', reading: 5, credits: 1.5 });
    for (const r of got) { expect(Number.isNaN(Date.parse(r.start))).toBe(false); expect(r.ms).toBeGreaterThanOrEqual(0); }
    const blocked = path.join(tmp, 'a-file');
    fs.writeFileSync(blocked, '');
    const again = run('gstack-ship-parts', [], blocked);
    expect([again.status, again.stdout, again.stderr]).toEqual([parts.status, parts.stdout, parts.stderr]);
    const nested = spawnSync(path.join(BIN_DIR, 'gstack-ship-parts'), [], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, GSTACK_STATE_ROOT: state, GSTACK_CAPY: '1', GSTACK_SHIP_CALL_NESTED: '1' } });
    expect(nested.status).toBe(parts.status);
    const offCapy = spawnSync(path.join(BIN_DIR, 'gstack-ship-parts'), [], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, GSTACK_STATE_ROOT: state, GSTACK_CAPY: '', GSTACK_SHIP_CALL_NESTED: '' } });
    expect(offCapy.status).toBe(parts.status);
    expect(rows(state)).toHaveLength(3);
  });
});

describe('countLoggedCalls', () => {
  // Value: protects=the helper's call split: rows join one call while they run back to back, a pass loader opens a call that lasts its 200 s poll, a note closes the program it ends, a lone gstack-ship-parts is a section read, the time between calls is filled at one keep-alive per 200 s plus the measured pass overhead, and gaps over the 300 s cache are flagged; fails_when=a pass's later rows or a program's closing note count as new calls, pass reruns count as keep-alives, or the overhead or gap figures drift;
  //   why_new=the split decides whether a 240 s keep-alive or merged phase calls are worth building (GSTA-330 H1); seam=none; no_claim=the host's billing of a gap
  test('splits phase, pass, section and other calls and estimates the keep-alives between them', () => {
    expect(countLoggedCalls(DAY)).toMatchObject({ calls: 9, phase: 3, pass: 4, section: 1, other: 1, keepaliveEst: 7, passOverhead: [15, 20, 40], idleGaps: 2, maxGapS: 870 });
  });

  test('a program whose note comes more than 5 s after its last command is still one call', () => {
    const c = countLoggedCalls([row('11:00:00.000', 'gstack-ship-preflight', '', 1000), row('11:02:30.000', 'gstack-ship-budget', 'note', 200, { step: '5' })]);
    expect(c).toMatchObject({ calls: 1, phase: 1, other: 0 });
  });

  test('a background row longer than a program does not absorb the calls made while it runs', () => {
    const c = countLoggedCalls([row('10:00:00.000', 'gstack-ship-preflight', '', 1_200_000), row('10:00:02.000', 'gstack-ship-budget', 'note', 300), row('10:04:00.000', 'gstack-ship-parts', 'next', 300), row('10:08:00.000', 'gstack-ship-budget', 'note', 300)]);
    expect(c).toMatchObject({ calls: 3, phase: 2, section: 1, keepaliveEst: 2 });
  });

  test('loaders that are not 200 s poll reruns never set the pass overhead, so the keep-alive estimate stays finite', () => {
    const c = countLoggedCalls([row('10:00:00.000', 'gstack-review-dispatch', 'program', 100), row('10:00:00.300', 'gstack-review-dispatch', 'program', 100), row('10:10:00.000', 'gstack-ship-parts', 'next', 300)]);
    expect(c).toMatchObject({ calls: 3, pass: 2, section: 1, passOverhead: [], keepaliveEst: 3 });
  });

  test('a pass that settles early and notes does not swallow the next phase call', () => {
    const c = countLoggedCalls([row('10:00:00.000', 'gstack-review-dispatch', 'program', 100), row('10:01:00.000', 'gstack-ship-budget', 'note', 200, { step: '9.2' }), row('10:01:40.000', 'gstack-review-dispatch', 'judge', 300), row('10:01:41.000', 'gstack-ship-budget', 'note', 200, { step: '9.4' })]);
    expect(c).toMatchObject({ calls: 2, pass: 1, phase: 1 });
  });
});

describe('gstack-ship-budget calls --record', () => {
  // Value: protects=a helper gets its CALLS line from its own record: the window is the run's start to close, rows outside it are not counted, and --log reads another file; fails_when=calls still demands --events, counts rows outside the run's window, drops the rotated log's rows, prints zero counts for an empty window, or prints a line in another shape;
  //   why_new=Step 22 asked for a CALLS line no Capy helper could produce; seam=none; no_claim=a run whose commands write to another state root
  test('counts the run window from the call log', () => {
    const state = fs.mkdtempSync(path.join(tmp, 'state-'));
    const rec = path.join(state, 'record.md');
    fs.writeFileSync(rec, '# record\n');
    fs.writeFileSync(path.join(state, 'ship-calls.jsonl'), JSON.stringify(row('09:00:00.000', 'gstack-ship-budget', 'note', 200, { step: '1' })) + '\n');
    const start = run('gstack-ship-budget', ['start', '--record', rec, '--mode', 'observe', '--reading', '100', '--credits', '1'], state);
    expect(start.status, start.stderr + start.stdout).toBe(0);
    const note = run('gstack-ship-budget', ['note', '--record', rec, '--step', '2', '--reading', '200', '--credits', '2'], state);
    expect(note.status, note.stderr + note.stdout).toBe(0);
    const close = run('gstack-ship-budget', ['close', '--record', rec, '--reading', '300', '--credits', '3'], state);
    expect(close.status, close.stderr + close.stdout).toBe(0);
    const c = run('gstack-ship-budget', ['calls', '--record', rec], state);
    expect(c.status, c.stderr).toBe(0);
    expect(c.stdout.trim()).toMatch(/^CALLS: source=log calls=1 phase=1 pass=0 section=0 other=0 keepalive_est=0 total_est=1 pass_overhead_s=none gaps_over_300s=0 max_gap_s=0 first=\S+ last=\S+$/);
    const day = path.join(tmp, 'day.jsonl');
    fs.writeFileSync(day, DAY.map(r => JSON.stringify(r)).join('\n') + '\n');
    const d = run('gstack-ship-budget', ['calls', '--log', day, '--since', at('09:00:00.000'), '--until', at('11:00:00.000')], state);
    expect(d.stdout.trim(), d.stderr).toBe(DAY_LINE);
    const rotated = path.join(tmp, 'rotated.jsonl');
    fs.writeFileSync(`${rotated}.1`, DAY.slice(0, 8).map(r => JSON.stringify(r)).join('\n') + '\n');
    fs.writeFileSync(rotated, DAY.slice(8).map(r => JSON.stringify(r)).join('\n') + '\n');
    expect(run('gstack-ship-budget', ['calls', '--log', rotated, '--since', at('09:00:00.000'), '--until', at('11:00:00.000')], state).stdout.trim()).toBe(DAY_LINE);
    const none = path.join(tmp, 'none.jsonl');
    expect(run('gstack-ship-budget', ['calls', '--record', rec, '--log', none], state).stdout.trim()).toBe(`CALLS: unavailable source=log reason=no rows in the run window log=${none}`);
    expect(run('gstack-ship-budget', ['calls'], state).status).toBe(2);
  });
});
