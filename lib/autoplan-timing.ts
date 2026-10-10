/**
 * autoplan-timing — wall time per phase and a pre-run estimate (plan B10).
 * `phase-close` records each phase's start, end, outside-voice and native
 * wall time to the run's timing.json (lib/headless-artifacts.ts `timing` v1)
 * and appends one row per phase to <state root>/analytics/autoplan-timing.jsonl
 * (the same file `gstack-artifact ack` appends to). On an ephemeral state
 * root (GSTACK_EPHEMERAL=1) the analytics append is skipped with an explicit
 * line; timing.json in the run directory is always written. Phase 0 prints
 * an estimate: the median of the last 10 recorded runs per phase, or
 * `no history`. Thin bin: bin/gstack-autoplan-timing.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TimingFile, TimingPhase } from './headless-artifacts';
import { resolveStateRoot } from './state-root';

export const TIMING_SKIPPED_LINE = 'timing: analytics skipped (state root is ephemeral; set GSTACK_STATE_ROOT)';
export const HISTORY_WINDOW = 10;

export function analyticsPath(env: Record<string, string | undefined> = process.env): string {
  return path.join(resolveStateRoot(env), 'analytics', 'autoplan-timing.jsonl');
}
export function isEphemeral(env: Record<string, string | undefined> = process.env): boolean {
  return env.GSTACK_EPHEMERAL === '1';
}

export function readTiming(file: string, run: string): TimingFile {
  if (!fs.existsSync(file)) return { schema_version: 1, run, phases: [] };
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as TimingFile;
  if (parsed.schema_version !== 1) throw new Error(`${file}: schema_version ${parsed.schema_version} is not 1`);
  return { ...parsed, phases: Array.isArray(parsed.phases) ? parsed.phases : [] };
}
function writeTiming(file: string, timing: TimingFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(timing, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
function secondsBetween(a: string | undefined, b: string): number | undefined {
  if (!a) return undefined;
  const ms = Date.parse(b) - Date.parse(a);
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : undefined;
}

/** Record the run start (Phase 0) without opening a phase; later closes measure from it. */
export function runStart(file: string, run: string, now = new Date()): TimingFile {
  const timing = readTiming(file, run);
  timing.started_at ??= now.toISOString();
  writeTiming(file, timing);
  return timing;
}

export function phaseStart(file: string, run: string, phase: string, now = new Date()): TimingPhase {
  const timing = readTiming(file, run);
  const at = now.toISOString();
  timing.started_at ??= at;
  const existing = timing.phases.find(p => p.phase === phase && !p.ended_at);
  const entry: TimingPhase = existing ?? { phase };
  entry.started_at = at;
  if (!existing) timing.phases.push(entry);
  writeTiming(file, timing);
  return entry;
}

export interface CloseOptions { outside_s?: number; native_s?: number; session_kind?: string; now?: Date; env?: Record<string, string | undefined>; analytics?: string }
export interface CloseResult { entry: TimingPhase; total_wall_s: number; analytics: 'appended' | 'skipped_ephemeral' }

export function phaseClose(file: string, run: string, phase: string, opts: CloseOptions = {}): CloseResult {
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;
  const timing = readTiming(file, run);
  const at = now.toISOString();
  let entry = timing.phases.find(p => p.phase === phase && !p.ended_at);
  if (!entry) {
    // Phases run sequentially: without an explicit start, this phase began
    // when the previous one ended, else when the run started.
    const previous = timing.phases.filter(p => p.ended_at).map(p => p.ended_at!).sort().pop();
    entry = { phase, started_at: previous ?? timing.started_at ?? at };
    timing.phases.push(entry);
  }
  entry.ended_at = at;
  entry.wall_s = secondsBetween(entry.started_at, at) ?? 0;
  if (opts.outside_s !== undefined) entry.outside_s = opts.outside_s;
  if (opts.native_s !== undefined) entry.native_s = opts.native_s;
  timing.total_wall_s = secondsBetween(timing.started_at, at) ?? timing.phases.reduce((n, p) => n + (p.wall_s ?? 0), 0);
  if (opts.session_kind) timing.session_kind = opts.session_kind;
  writeTiming(file, timing);
  if (isEphemeral(env)) return { entry, total_wall_s: timing.total_wall_s, analytics: 'skipped_ephemeral' };
  const target = opts.analytics ?? analyticsPath(env);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.appendFileSync(target, JSON.stringify({
    event: 'phase', run, phase, wall_s: entry.wall_s, outside_s: entry.outside_s ?? null, native_s: entry.native_s ?? null,
    ts: at, session_kind: timing.session_kind ?? opts.session_kind ?? null,
  }) + '\n');
  return { entry, total_wall_s: timing.total_wall_s, analytics: 'appended' };
}

export function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

export interface PhaseEstimate { phase: string; median_s?: number; samples: number }
/** Median wall time of the last `window` recorded closes per phase; `samples: 0` means no history. */
export function estimate(analytics: string, phases: string[], window = HISTORY_WINDOW): PhaseEstimate[] {
  const history = new Map<string, number[]>();
  if (fs.existsSync(analytics)) {
    for (const line of fs.readFileSync(analytics, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let row: any;
      try { row = JSON.parse(line); } catch { continue; }
      if (row.event !== 'phase' || typeof row.phase !== 'string' || typeof row.wall_s !== 'number') continue;
      history.set(row.phase, [...(history.get(row.phase) ?? []), row.wall_s]);
    }
  }
  return phases.map(phase => {
    const recent = (history.get(phase) ?? []).slice(-window);
    return { phase, median_s: median(recent), samples: recent.length };
  });
}

export function formatDuration(s: number): string {
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
}

export function renderEstimate(estimates: PhaseEstimate[]): string {
  const parts = estimates.map(e => e.samples === 0 ? `${e.phase} no history` : `${e.phase} ~${formatDuration(e.median_s!)} (n=${e.samples})`);
  const known = estimates.filter(e => e.samples > 0);
  const total = known.length === estimates.length && known.length > 0
    ? ` | total ~${formatDuration(known.reduce((n, e) => n + e.median_s!, 0))}`
    : known.length > 0 ? ` | total: partial history` : '';
  return `ESTIMATE: ${parts.join(' | ')}${total}`;
}

/** The final-report line: actual whole-cycle time next to the Phase 0 estimate. */
export function renderSummary(timing: TimingFile, estimates?: PhaseEstimate[]): string {
  const phases = timing.phases.filter(p => p.ended_at && p.wall_s !== undefined)
    .map(p => `${p.phase} ${formatDuration(p.wall_s!)}${p.outside_s !== undefined ? ` (outside ${formatDuration(p.outside_s)})` : ''}`);
  const est = estimates?.filter(e => e.samples > 0);
  const estimated = est && est.length === estimates!.length && est.length > 0 ? formatDuration(est.reduce((n, e) => n + e.median_s!, 0)) : 'no history';
  return `CYCLE: actual ${formatDuration(timing.total_wall_s ?? 0)} (estimate ${estimated}) | ${phases.join(' | ') || 'no phases closed'}`;
}
