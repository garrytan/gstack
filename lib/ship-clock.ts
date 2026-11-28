/**
 * ship-clock — a driven /ship's 100-minute stop and its call count, in code instead of prose (ship/DRIVER.md).
 * Measured conductors made 121-308 calls against the driver's 9 to 12, and 10 of 12 ran past its 100-minute stop
 * (handoffs/ship-conductor-cost-2026-11-16), so the limits now print. An observe-mode run measures its active time from
 * the ledger's start, or from the resume that followed a time stop; the first `gstack-ship-budget note` or
 * `gstack-ship-phase run` past 100 active minutes stops the run and writes its state (head, review passes, next act) to
 * <ledger dir>/stop.json, so the next session starts from that file and the record, not from memory.
 * Active time (GST-4109) is wall time minus parked time: any stretch over PARKED_AFTER_MS with no gstack call in the call
 * log is the lane parked on CI, a Captain or a ruling, so only its first PARKED_AFTER_MS count. A run that keeps calling
 * gstack (a runaway pass or phase loop) never parks, so it still stops at 100 minutes; with no call log (off Capy) the
 * clock is wall time.
 * Calls come from the call log (lib/ship-call-log.ts): the calls that ran a gstack command plus its keep-alive
 * estimate; quick calls that run no gstack command are not in it.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ledgerFileFor, readLedger, type Ledger } from './ship-budget';
import { callLogFile, countLoggedCalls, pendingRow, readCallLog } from './ship-call-log';

export const TIME_LIMIT_MIN = 100;
export const STOP_FILE = 'stop.json';

/** The call log's idle line (lib/ship-call-log.ts, a gap that outlives the prompt cache): a longer stretch with no gstack call is parked past it. */
export const PARKED_AFTER_MS = 300_000;

export const clockFrom = (l: Pick<Ledger, 'created_at' | 'clock_from'>) => l.clock_from ?? l.created_at;

/**
 * The run's clock in minutes since clockFrom: wall, parked (each stretch between call-log rows, or from the clock's start to the first
 * row and from the last row to now, past PARKED_AFTER_MS) and active (wall minus parked), which the 100-minute stop compares. Every
 * row on this state root counts, a row lasting as long as it ran, and this process's own pending row too. With no row in the window
 * (no call log: off Capy) the clock is wall time and source is wall.
 */
export function runClock(l: Pick<Ledger, 'created_at' | 'clock_from'>, env: NodeJS.ProcessEnv, now = Date.now()): { active: number; wall: number; parked: number; source: 'log' | 'wall' } {
  const from = Date.parse(clockFrom(l));
  const wall = Math.max(0, now - from);
  const self = pendingRow();
  const spans = [...readCallLog(callLogFile(env)), ...(self ? [self] : [])]
    .map(r => [Date.parse(r.start), Date.parse(r.start) + Math.max(0, r.ms)] as const)
    .filter(([s, e]) => e >= from && s <= now).map(([s, e]) => [Math.max(s, from), Math.min(e, now)] as const).sort((a, b) => a[0] - b[0]);
  if (!spans.length) return { active: wall / 60_000, wall: wall / 60_000, parked: 0, source: 'wall' };
  let parked = 0, cursor = from;
  for (const [s, e] of [...spans, [now, now] as const]) {
    parked += Math.max(0, s - cursor - PARKED_AFTER_MS);
    cursor = Math.max(cursor, e);
  }
  return { active: (wall - parked) / 60_000, wall: wall / 60_000, parked: parked / 60_000, source: 'log' };
}

/**
 * Calls whose rows start after `since` (and at or before `until`): the log's calls plus its keep-alive estimate.
 * Counting rows by start keeps two back-to-back windows from sharing a row. At the run's start (`fromRunStart`) a row
 * still running at `since` counts too: the call that ran `gstack-ship-budget start` began before the ledger existed.
 * This process's own row, written only at its exit, counts as if written. Null when the window holds none.
 */
export function callsSince(env: NodeJS.ProcessEnv, since: string, until?: string, fromRunStart = false): number | null {
  const from = Date.parse(since), to = until ? Date.parse(until) : Infinity;
  const self = pendingRow();
  const rows = [...readCallLog(callLogFile(env)), ...(self ? [self] : [])].filter(r => { const s = Date.parse(r.start); return s <= to && (s > from || (fromRunStart && s + Math.max(0, r.ms) >= from)); });
  if (!rows.length) return null;
  const c = countLoggedCalls(rows);
  return c.calls + c.keepaliveEst;
}

/** A run's calls from its budget record, start to now (gstack-ship-receipt write --budget-record); null when the log holds none. */
export function runCalls(record: string, env: NodeJS.ProcessEnv): number | null {
  return callsSince(env, readLedger(ledgerFileFor({ record }, env)).created_at, undefined, true);
}

const HEADING = /^\s*(?:[-*]\s*)?(?:#+\s*)?(?:\*\*)?(Release|Decisions|Reviews|Checks|Documentation|Next steps)(?:\*\*)?:?(?:\*\*)?(?:\s|$)/;

/** The record's next act: the last line under its Next steps heading (one of the six lib/ship-handoff.ts names), else null. */
export function nextAct(record: string | undefined): string | null {
  if (!record) return null;
  let text: string;
  try { text = fs.readFileSync(record, 'utf8'); } catch { return null; }
  const lines = text.split('\n');
  const at = lines.findIndex(l => HEADING.exec(l)?.[1] === 'Next steps');
  if (at < 0) return null;
  const end = lines.findIndex((l, i) => i > at && (HEADING.test(l) || l.startsWith('```')));
  const body = lines.slice(at + 1, end < 0 ? lines.length : end).map(l => l.replace(/^\s*[-*]\s*/, '').trim())
    .filter(l => l && !l.startsWith('<!--'));
  return body.at(-1) ?? null;
}

const oneLine = (s: string) => s.replace(/[\x00-\x1f\x7f]+/g, ' ').slice(0, 300);

/**
 * The time stop: null while an observe-mode run is within 100 active minutes (runClock; or already stopped or closed); past them it
 * marks the ledger stopped, writes stop.json and returns the STOP block. The caller persists the ledger (mutateLedger).
 */
export function timeStop(l: Ledger, cwd: string, step: string, env: NodeJS.ProcessEnv, now = Date.now(), fallbackNext = `resume, then continue after Step ${step}`): string[] | null {
  if (l.mode !== 'observe' || l.stopped || l.closed_at) return null;
  const clock = runClock(l, env, now);
  const min = clock.active;
  if (!(min > TIME_LIMIT_MIN)) return null;
  const at = new Date(now).toISOString();
  const g = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', timeout: 15_000 });
  const head = g.status === 0 ? g.stdout.trim() : 'unknown';
  const rounds = (l.notes ?? []).filter(n => n.step === '9' && n.readers).length;
  const next = nextAct(l.record) ?? fallbackNext;
  const calls = callsSince(env, l.created_at, at, true);
  const file = path.join(l.dir, STOP_FILE);
  const state = { schema_version: 1, kind: 'gstack-ship-stop', reason: 'past_100_minutes', run: l.run, record: l.record ?? null, at,
    clock_from: clockFrom(l), elapsed_min: Math.floor(clock.wall), active_min: Math.floor(min), parked_min: Math.floor(clock.parked), clock_source: clock.source, step, head, rounds, next, calls };
  fs.mkdirSync(l.dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  l.stopped = { at, reason: 'past_100_minutes', step, next };
  return [
    `STOP: past 100 minutes (${Math.floor(min)} active min since ${clockFrom(l)}, ${Math.floor(clock.parked)} min parked) head=${head.slice(0, 12)} rounds=${rounds} calls=${calls ?? 'unknown'} next=${oneLine(next)} state=${file}`,
    `RECOVER: hand ${file} to the next session; it runs gstack-ship-budget resume --record ${l.record ?? '<record>'} (the clock restarts), then reruns the phase that stopped`,
    `GSTACK_RESULT: skill=ship status=incomplete run=${l.dir}`,
  ];
}
