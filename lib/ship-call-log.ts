/**
 * ship-call-log — the /ship helper's calls, counted from the commands it already runs (GST-1585,
 * GSTA-330 H1). A Capy helper cannot read its own transcript, so on Capy (GSTACK_CAPY=1) every gstack-ship-*
 * bin and the pass loader (`gstack-review-dispatch`) append one row to <state root>/ship-calls.jsonl when they exit, and
 * `gstack-ship-budget calls --run|--record` rebuilds the helper's calls from those rows: no added call.
 *
 * Rows join one call while they run back to back (each starts within 5 s of the last one's end); a row longer
 * than a program (a background lane or finish) ends where it starts, so it never absorbs the calls made while it runs. A pass
 * loader (`gstack-review-dispatch program`) opens a call that polls up to 200 s after its first line, so
 * review rows and notes join it until it notes; a program's closing `note` joins it up to 230 s after its
 * first row. A call with a loader is a pass poll, one with a note a phase program, one with only
 * gstack-ship-parts a section read, anything else other. Calls that run no gstack command (a `wait`, an
 * edit) leave no row: the time between calls, outside a pass, is filled at one keep-alive per 200 s plus
 * the median pass overhead (the time a 200 s poll rerun adds past its 200 s, never below 0; a pass that noted, or a
 * loader that starts under 200 s after the last one, is no rerun).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveStateRoot } from './state-root';

export interface CallRow { v: 1; bin: string; sub: string; step?: string; reading?: number; credits?: number; start: string; ms: number; exit: number }
export interface LoggedCalls {
  calls: number; phase: number; pass: number; section: number; other: number; keepaliveEst: number;
  passOverhead: number[]; idleGaps: number; maxGapS: number; first: string | null; last: string | null;
}

const NESTED = 'GSTACK_SHIP_CALL_NESTED';
const ROTATE_BYTES = 8 * 1024 * 1024;
const JOIN_MS = 5_000;
const POLL_S = 200;
const PROGRAM_MS = 230_000;
const DEFAULT_OVERHEAD_S = 15;
const CACHE_TTL_S = 300;

export const callLogFile = (env: NodeJS.ProcessEnv) => path.join(resolveStateRoot(env), 'ship-calls.jsonl');

/** Register this bin's row, written at exit, on Capy only (GSTACK_CAPY=1 from the launch file); a bin another gstack-ship-* bin spawned writes none. A failed write never changes the command. */
export function logShipCall(bin: string, argv: string[] = process.argv.slice(2)): void {
  if (process.env.GSTACK_CAPY !== '1' || process.env[NESTED] === '1') return;
  process.env[NESTED] = '1';
  const started = Date.now();
  const flag = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
  const num = (name: string) => { const v = Number(flag(name)); return flag(name) !== undefined && Number.isFinite(v) ? v : undefined; };
  process.on('exit', code => {
    try {
      const row: CallRow = { v: 1, bin, sub: argv[0] && !argv[0].startsWith('-') ? argv[0] : '', start: new Date(started).toISOString(), ms: Date.now() - started, exit: code };
      const step = flag('step'), reading = num('reading'), credits = num('credits');
      if (step !== undefined) row.step = step;
      if (reading !== undefined) row.reading = reading;
      if (credits !== undefined) row.credits = credits;
      const file = callLogFile(process.env);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if ((fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0) > ROTATE_BYTES) fs.renameSync(file, `${file}.1`);
      fs.appendFileSync(file, JSON.stringify(row) + '\n');
    } catch { /* counting must never break the command */ }
  });
}

export function readCallLog(file: string): CallRow[] {
  return [`${file}.1`, file].filter(f => fs.existsSync(f)).flatMap(f => fs.readFileSync(f, 'utf8').split('\n')).flatMap(line => {
    try { const r = JSON.parse(line); return r?.v === 1 && typeof r.start === 'string' && !Number.isNaN(Date.parse(r.start)) ? [r as CallRow] : []; } catch { return []; }
  });
}

interface Call { start: number; end: number; loader: boolean; note: boolean; partsOnly: boolean }
const isLoader = (r: CallRow) => r.bin === 'gstack-review-dispatch' && r.sub === 'program';
const isNote = (r: CallRow) => r.bin === 'gstack-ship-budget' && r.sub === 'note';

export function countLoggedCalls(rows: readonly CallRow[], window: { since?: string; until?: string } = {}): LoggedCalls {
  const since = window.since ? Date.parse(window.since) : -Infinity, until = window.until ? Date.parse(window.until) : Infinity;
  const inWindow = rows.map(r => ({ r, s: Date.parse(r.start), ms: Math.max(0, r.ms) }))
    .filter(x => x.s <= until && x.s + x.ms >= since).sort((a, b) => a.s - b.s);
  const calls: Call[] = [];
  for (const { r, s, ms } of inWindow) {
    const e = ms > PROGRAM_MS ? s : s + ms;
    const cur = calls[calls.length - 1];
    const joins = cur && !isLoader(r) && (s <= cur.end + JOIN_MS
      || (cur.loader && !cur.note && s <= cur.start + PROGRAM_MS)
      || (isNote(r) && !cur.note && !cur.partsOnly && s <= cur.start + PROGRAM_MS));
    if (!joins) { calls.push({ start: s, end: e, loader: isLoader(r), note: isNote(r), partsOnly: r.bin === 'gstack-ship-parts' }); continue; }
    cur.end = Math.max(cur.end, e);
    cur.loader ||= isLoader(r);
    cur.note ||= isNote(r);
    cur.partsOnly &&= r.bin === 'gstack-ship-parts';
  }
  const kind = (c: Call) => c.loader ? 'pass' : c.note ? 'phase' : c.partsOnly ? 'section' : 'other';
  const passOverhead: number[] = [];
  let idleGaps = 0, maxGapS = 0;
  for (let k = 1; k < calls.length; k++) {
    const gap = Math.round((calls[k]!.start - calls[k - 1]!.start) / 1000);
    if (gap > CACHE_TTL_S) idleGaps++;
    maxGapS = Math.max(maxGapS, gap);
    if (calls[k]!.loader && calls[k - 1]!.loader && !calls[k - 1]!.note && gap >= POLL_S - JOIN_MS / 1000) passOverhead.push(Math.max(0, gap - POLL_S));
  }
  const sorted = [...passOverhead].sort((a, b) => a - b);
  const cycle = POLL_S + Math.max(0, sorted.length ? sorted[Math.ceil(sorted.length / 2) - 1]! : DEFAULT_OVERHEAD_S);
  let keepaliveEst = 0;
  for (let k = 1; k < calls.length; k++) {
    if (calls[k]!.loader && calls[k - 1]!.loader) continue;
    keepaliveEst += Math.round(Math.max(0, calls[k]!.start - calls[k - 1]!.end) / 1000 / cycle);
  }
  const count = (k: string) => calls.filter(c => kind(c) === k).length;
  const iso = (ms: number | undefined) => ms === undefined ? null : new Date(ms).toISOString();
  return { calls: calls.length, phase: count('phase'), pass: count('pass'), section: count('section'), other: count('other'), keepaliveEst,
    passOverhead, idleGaps, maxGapS, first: iso(calls[0]?.start), last: iso(calls[calls.length - 1]?.start) };
}

export function loggedCallsLine(c: LoggedCalls): string {
  const sorted = [...c.passOverhead].sort((a, b) => a - b);
  const overhead = sorted.length ? `p50:${sorted[Math.ceil(sorted.length / 2) - 1]},max:${sorted[sorted.length - 1]}` : 'none';
  return `CALLS: source=log calls=${c.calls} phase=${c.phase} pass=${c.pass} section=${c.section} other=${c.other} keepalive_est=${c.keepaliveEst} total_est=${c.calls + c.keepaliveEst} pass_overhead_s=${overhead} gaps_over_300s=${c.idleGaps} max_gap_s=${c.maxGapS} first=${c.first ?? 'none'} last=${c.last ?? 'none'}`;
}
