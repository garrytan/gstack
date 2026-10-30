/**
 * ship-budget — the /ship token budget (GSTA-152, docs/ship-budget.md): an
 * ADMISSION cap on a token ledger, never a hard ceiling. A step or dispatch
 * starts only when used + open reservations + unknown charges + its projection
 * + the parent's tail reserve + the stop overhead fits under the cap; the
 * overshoot is bounded by the misprojection of work already admitted.
 *
 * The ledger is its own schema (build-spec r2 item 7, the "reuse only
 * withFileLock" choice): one JSON file per run under
 * <state root>/ship-runs/<run>/budget.json (mode 0600), mutated only under
 * lib/spend-ledger.ts's withFileLock, so lib/autoplan-budget.ts's USD ledger is
 * untouched. Meters are versioned contracts (unit, host field, scope,
 * descendants, epoch); a reading lower than the last one of its epoch is
 * rejected and a meter change opens a new epoch that keeps prior usage. Under a
 * cap, start writes a per-branch marker next to the review log so
 * gstack-review-log --start refuses a dispatch without an unspent reservation;
 * without a cap no marker exists and review-log behaves as before. Commands:
 * lib/ship-budget-cli.ts; handoffs: lib/ship-handoff.ts.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { withFileLock } from './spend-ledger';
import { resolveStateRoot } from './state-root';
import { resultLine, type ResultCodeName } from './result-codes';
import { capyDriveFolder } from './autoplan-checkpoint';
import { BIN_DIR, runScriptSync } from './script-invocation';
import type { Role } from './review-depth';

export const SHIP_STEPS = ['0.9', '1', '2', '3', '4', '5', '6', '6.5', '7', '8', '9', '10', '11', '11.5', '12', '13', '14', '14.5', '15', '16', '17', '18', '19', '20', '21', '22'] as const;
export const DISPATCH_ROLES = ['specialist', 'red-team', 'adversarial-native', 'outside-voice', 'fix-check'] as const satisfies readonly Role[];
type MissingRole = Exclude<Role, typeof DISPATCH_ROLES[number]>;
const ROLES_COMPLETE: [MissingRole] extends [never] ? true : never = true;
void ROLES_COMPLETE;
/**
 * D3: per-call context above the host's per-call floor (GSTA-167) that runs the
 * whole /ship in a fresh child, and the one that delegates a heavy segment.
 */
export const DELEGATE_START_CALL = 100_000;
export const DELEGATE_SEGMENT_CALL = 150_000;
/** Handoffs between the root run and the deepest child; a run at this depth continues instead of handing off. */
export const MAX_CHAIN_DEPTH = 3;
/** Segment boundaries (before Step 7, before Step 12) and the last step each segment runs. */
export const SEGMENTS: Record<string, string> = { '1': '22', '7': '11.5', '12': '22' };
export const DEFAULT_TAIL = 2_000_000;
const DIFF_REVIEW_STEP: Record<string, string> = { review: '9', 'review-fix-check': '9', 'design-review-lite': '9', 'adversarial-review': '11', 'codex-review': '11' };

export type MeterKind = 'capy' | 'claude' | 'estimate';
export interface MeterContract { version: 1; meter: MeterKind; unit: string; host_field: string; scope: 'root' | 'session' | 'run'; descendants: boolean }
export const METER_CONTRACTS: Record<MeterKind, MeterContract> = {
  capy: { version: 1, meter: 'capy', unit: 'capy-tokens', host_field: 'tools.thread.get({ thread_id: "this" }).cost.tokens', scope: 'root', descendants: true },
  claude: { version: 1, meter: 'claude', unit: 'claude-usage-tokens', host_field: 'journal message.usage input+cache_creation+cache_read+output, max per (message.id, requestId)', scope: 'session', descendants: true },
  estimate: { version: 1, meter: 'estimate', unit: 'estimate-tokens', host_field: 'lib/ship-budget-calibration.json projections', scope: 'run', descendants: true },
};

export interface Reservation {
  id: string; kind: 'step' | 'dispatch' | 'child'; step: string; next: string; roles?: string[]; tokens: number; at: string;
  state: 'open' | 'consumed' | 'settled' | 'released'; token?: string; started_at?: string; settled_at?: string;
  prior?: number; reading_at?: number | null; epoch?: number; actual?: number; unseen?: boolean; remaining?: string[];
}
export interface Sample { id: string; kind: 'step' | 'dispatch'; epoch: number; prior: number; projected: number; actual: number }
export interface Handoff {
  n: number; sha: string; file: string; from: string; to: string; sub_cap: number; reservation: string; reading_at: number | null;
  epoch: number; return_file: string; reconciled_at?: string; status?: string; child_used?: number; depth?: number;
}
export interface Ledger {
  schema_version: 1; kind: 'gstack-ship-budget'; run: string; dir: string; file: string; record?: string; created_at: string;
  cap: number | null; tail: number; stop_overhead: number; delegate: 'auto' | 'never'; role: 'parent' | 'child';
  parent?: { run: string; ledger: string; handoff_sha: string; from: string; to: string; return_file: string };
  meter: { contract: MeterContract; epoch: number; baseline: number; last: number | null; last_at?: string; sessions?: string[]; config_dir?: string };
  epochs: Array<{ epoch: number; contract: MeterContract; baseline: number; last: number | null; used: number }>;
  carried_used: number; estimate_used: number; unknown: number; next_id: number;
  reservations: Reservation[]; handoffs: Handoff[];
  cap_raises: Array<{ from: number | null; to: number | null; by: string; words: string; at: string }>;
  marker?: string; review_log?: string; calibration?: string; samples?: Sample[]; tail_explicit?: boolean;
  call_floor?: number; depth?: number; steps_done?: string[];
  stopped?: { at: string; reason: string; step: string; next: string }; closed_at?: string;
}

/** A refusal: exit 2 for usage and validation (stderr), exit 3 for a stop. */
export class BudgetError extends Error {
  constructor(public code: ResultCodeName | 'usage', message: string, public exit = 2) { super(message); }
}
export const budgetError = (code: ResultCodeName, detail: string, exit = 2) => new BudgetError(code, resultLine('gstack-ship-budget', code, detail), exit);
export const usageError = (detail: string) => new BudgetError('usage', `gstack-ship-budget: ${detail} (usage)`);

export function parseTokens(raw: string | undefined, flag: string): number {
  const m = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec((raw ?? '').trim());
  if (!m) throw usageError(`${flag} '${raw ?? ''}' is not a token count; fix: pass an integer or a k/M suffix, e.g. 25M or 400k`);
  const scale = m[2]!.toLowerCase() === 'k' ? 1e3 : m[2]!.toLowerCase() === 'm' ? 1e6 : 1;
  return Math.round(Number(m[1]) * scale);
}

export function parseStep(raw: string | undefined, flag = '--step'): string {
  if (raw && (SHIP_STEPS as readonly string[]).includes(raw)) return raw;
  throw usageError(`${flag} '${raw ?? ''}' is not a ship step id; valid: ${SHIP_STEPS.join(', ')}; fix: use a step number from ship/SKILL.md.tmpl`);
}

export type Next = { kind: 'step'; step: string } | { kind: 'dispatch'; roles: string[] };
export function parseNext(raw: string | undefined): Next {
  if (raw?.startsWith('dispatch:')) {
    const roles = raw.slice('dispatch:'.length).split(',').filter(Boolean);
    const bad = roles.filter(r => !(DISPATCH_ROLES as readonly string[]).includes(r));
    if (roles.length === 0 || bad.length) throw usageError(`--next '${raw}' names unknown roles (${bad.join(', ') || 'none given'}); valid: ${DISPATCH_ROLES.join(', ')}; fix: list the plan's roles, e.g. dispatch:specialist,red-team`);
    return { kind: 'dispatch', roles };
  }
  return { kind: 'step', step: parseStep(raw, '--next') };
}

export interface Calibration {
  schema_version: 1; headroom: number; round_to: number;
  observations: Record<string, Array<{ run: string; value: number; source: string }>>;
  constants: Record<'per_call' | 'per_dispatch' | 'stop_overhead', number>;
  step_calls: Record<string, number>; step_dispatches: Record<string, number>; segment_dispatches: Record<string, number>;
  units: Record<string, { fit?: string; seeded_from?: string; why?: string; call_floor?: number; call_floor_observed?: number | null; call_floor_why?: string }>;
}
export const CALIBRATION_FILE = path.join(import.meta.dir, 'ship-budget-calibration.json');

/** Conservative fit (plan item 8): the largest observation times the headroom, rounded up. */
export function fitConstant(values: number[], headroom: number, roundTo: number): number {
  return Math.ceil((Math.max(...values) * headroom) / roundTo) * roundTo;
}

export function loadCalibration(file = CALIBRATION_FILE): Calibration {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as Calibration; }
  catch (e: any) { throw usageError(`--calibration ${file} is unreadable: ${e.message}`); }
}

/** Constants for a unit: its own fit, or the unit it was seeded from (calibration is per meter). */
export function unitConstants(cal: Calibration, unit: string): Calibration['constants'] {
  const entry = cal.units[unit];
  if (!entry) throw usageError(`calibration has no entry for unit ${unit}`);
  return entry.seeded_from ? unitConstants(cal, entry.seeded_from) : cal.constants;
}

export function stepProjection(cal: Calibration, unit: string, step: string): number {
  const k = unitConstants(cal, unit);
  return (cal.step_calls[step] ?? cal.step_calls.default ?? 0) * k.per_call + (cal.step_dispatches[step] ?? 0) * k.per_dispatch;
}

export function projection(cal: Calibration, unit: string, next: Next): number {
  return next.kind === 'dispatch' ? next.roles.length * unitConstants(cal, unit).per_dispatch : stepProjection(cal, unit, next.step);
}

/** How many recent measurements of a kind the run's factor looks at (GST-101). */
export const SAMPLE_WINDOW = 3;
const roundUp = (n: number, to: number) => Math.ceil(n / to) * to;

/**
 * The run's own factor for steps or dispatches: the largest actual/prior ratio
 * among its last SAMPLE_WINDOW measurements times the calibration headroom, or
 * null before the first measurement (the prior applies until then).
 */
export function measuredFactor(l: Ledger, cal: Calibration, kind: Sample['kind']): number | null {
  const rows = (l.samples ?? []).filter(s => s.kind === kind && s.epoch === l.meter.epoch && s.actual > 0 && s.prior > 0).slice(-SAMPLE_WINDOW);
  return rows.length ? Math.max(...rows.map(s => s.actual / s.prior)) * cal.headroom : null;
}

/**
 * Projections calibrated by the run's measured factors. The tail reserve scales
 * with the step factor unless --reserve set it; the stop overhead keeps its
 * calibrated fit so a run always has room to stop. `floor` is the host's
 * per-call floor: start --call-floor, else the unit's calibrated value.
 * `reader` prices one dispatch reader at max(its projection, the run's mean
 * measured cost for that role over settled dispatch reservations).
 */
export function projector(l: Ledger, cal: Calibration = loadCalibration(l.calibration)) {
  const unit = l.meter.contract.unit;
  const step = measuredFactor(l, cal, 'step'), dispatch = measuredFactor(l, cal, 'dispatch');
  const scale = (n: number, f: number | null) => (f === null ? n : roundUp(n * f, cal.round_to));
  const project = (next: Next) => {
    const prior = projection(cal, unit, next);
    return { prior, tokens: scale(prior, next.kind === 'dispatch' ? dispatch : step) };
  };
  const segment = (from: string, to: string) => SHIP_STEPS.slice(SHIP_STEPS.indexOf(from as any), SHIP_STEPS.indexOf(to as any) + 1)
    .reduce((sum, s) => sum + project({ kind: 'step', step: s }).tokens + (cal.segment_dispatches[s] ?? 0) * project({ kind: 'dispatch', roles: ['specialist'] }).tokens, 0);
  const label = (f: number | null) => (f === null ? 'prior' : f.toFixed(3));
  const measured = new Map<string, number[]>();
  for (const r of l.reservations) {
    if (r.kind !== 'dispatch' || r.actual === undefined || r.unseen || r.epoch !== l.meter.epoch) continue;
    for (const role of r.roles ?? []) measured.set(role, [...(measured.get(role) ?? []), r.actual / r.roles!.length]);
  }
  const reader = (role: string) => {
    const seen = measured.get(role) ?? [];
    return Math.max(project({ kind: 'dispatch', roles: [role] }).tokens, seen.length ? Math.ceil(seen.reduce((a, b) => a + b, 0) / seen.length) : 0);
  };
  return { project, segment, reader, reserve: (l.tail_explicit ? l.tail : scale(l.tail, step)) + l.stop_overhead, label: `step:${label(step)},dispatch:${label(dispatch)}`,
    floor: l.call_floor ?? cal.units[unit]?.call_floor ?? 0 };
}

/**
 * Measure settled reservations against the current (fresh) reading: a step
 * from its reading to now; settled dispatches as one group from the earliest
 * of their readings, split by role. A charge the meter cannot see (settled
 * --unknown, or a Claude-metered outside voice) is never measured. Returns one
 * DRIFT line per measurement.
 */
export function measureSettled(l: Ledger): string[] {
  const last = l.meter.last;
  if (last === null) return [];
  const pending = l.reservations.filter(r => r.state === 'settled' && r.kind !== 'child' && r.actual === undefined && !r.unseen
    && typeof r.reading_at === 'number' && r.epoch === l.meter.epoch && last >= r.reading_at);
  const dispatches = pending.filter(r => r.kind === 'dispatch');
  const from = Math.min(...dispatches.map(r => r.reading_at!));
  const roles = dispatches.reduce((n, r) => n + (r.roles?.length ?? 1), 0);
  return pending.map(r => {
    const actual = r.kind === 'dispatch' ? Math.round(((last - from) * (r.roles?.length ?? 1)) / roles) : last - r.reading_at!;
    r.actual = actual;
    (l.samples ??= []).push({ id: r.id, kind: r.kind as Sample['kind'], epoch: l.meter.epoch, prior: r.prior ?? r.tokens, projected: r.tokens, actual });
    return `DRIFT: id=${r.id} kind=${r.kind} next=${r.next} projected=${r.tokens} actual=${actual} ratio=${(actual / Math.max(1, r.tokens)).toFixed(2)}`;
  });
}

/** Steps from..to inclusive plus their usual reviewer batches at the prior: a child's segment estimate. */
export function segmentEstimate(cal: Calibration, unit: string, from: string, to: string): number {
  const i = SHIP_STEPS.indexOf(from as any), j = SHIP_STEPS.indexOf(to as any);
  const k = unitConstants(cal, unit);
  return SHIP_STEPS.slice(i, j + 1).reduce((sum, s) => sum + stepProjection(cal, unit, s) + (cal.segment_dispatches[s] ?? 0) * k.per_dispatch, 0);
}

export const runDirFor = (env: NodeJS.ProcessEnv, run: string) => path.join(resolveStateRoot(env), 'ship-runs', run);
export function mintRunId(now = new Date()): string {
  return `ship-${now.toISOString().replace(/[-:]/g, '').slice(0, 15)}-${crypto.randomBytes(3).toString('hex')}`;
}

export function readLedger(file: string): Ledger {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e: any) { throw budgetError('BUDGET_LEDGER_INVALID', `${file}: ${e.code === 'ENOENT' ? 'missing' : e.message}`); }
  let parsed: any;
  try { parsed = JSON.parse(text); }
  catch (e: any) { throw budgetError('BUDGET_LEDGER_INVALID', `${file}: schema_version unknown, parse error: ${e.message}`); }
  if (parsed?.kind !== 'gstack-ship-budget' || parsed.schema_version !== 1) {
    throw budgetError('BUDGET_LEDGER_INVALID', `${file}: schema_version ${JSON.stringify(parsed?.schema_version)} kind ${JSON.stringify(parsed?.kind)}, expected 1 gstack-ship-budget`);
  }
  return parsed as Ledger;
}

function writePrivate(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function writeLedger(ledger: Ledger, env: NodeJS.ProcessEnv = process.env): void {
  writePrivate(ledger.file, JSON.stringify(ledger, null, 2) + '\n');
  if (ledger.record) writeRecordBlock(ledger.record, ledger);
  mirrorRun(ledger, env);
}

/** One locked read-modify-write of a ledger. */
export function mutateLedger<T>(file: string, env: NodeJS.ProcessEnv, fn: (l: Ledger) => T): T {
  return withFileLock(file, () => {
    const ledger = readLedger(file);
    const out = fn(ledger);
    writeLedger(ledger, env);
    return out;
  });
}

function childUsed(l: Ledger, r: Reservation): number {
  const h = l.handoffs.find(x => x.reservation === r.id);
  if (!h || h.reading_at === null || h.epoch !== l.meter.epoch || l.meter.last === null) return 0;
  return Math.max(0, l.meter.last - h.reading_at);
}

/** used, open reservations (an open child counts max(sub_cap, child_used), never both) and unknown charges. */
export function tally(l: Ledger): { used: number; reserved: number; unknown: number } {
  const metered = l.meter.contract.meter === 'estimate' ? l.estimate_used : Math.max(0, (l.meter.last ?? l.meter.baseline) - l.meter.baseline);
  let reserved = 0;
  for (const r of l.reservations) {
    if (r.state !== 'open' && r.state !== 'consumed') continue;
    reserved += r.kind === 'child' ? Math.max(0, r.tokens - childUsed(l, r)) : r.tokens;
  }
  return { used: l.carried_used + metered, reserved, unknown: l.unknown };
}

/** The admission rule; exactly at the cap is admitted. */
export function admits(t: { used: number; reserved: number; unknown: number }, projected: number, reserve: number, cap: number | null): boolean {
  return cap === null || t.used + t.reserved + t.unknown + projected + reserve <= cap;
}

export function budgetLine(l: Ledger, f: { call: number | null; next: string; projected: number; verdict: string }): string {
  const t = tally(l);
  const p = projector(l);
  return `BUDGET: used=${t.used} reserved=${t.reserved} unknown=${t.unknown} admission_cap=${l.cap ?? 'none'} tail=${p.reserve} unit=${l.meter.contract.unit} meter=${l.meter.contract.meter} epoch=${l.meter.epoch} call=${f.call ?? 'unknown'} call_floor=${p.floor} above_floor=${aboveFloor(f.call, p.floor) ?? 'unknown'} next=${f.next} projected=${f.projected} calibration=${p.label} verdict=${f.verdict}`;
}

/** The per-call context above the host floor that the delegate thresholds compare; null when the charge is unknown. */
export const aboveFloor = (call: number | null, floor: number) => (call === null ? null : Math.max(0, call - floor));

export function reserveIn(l: Ledger, r: Omit<Reservation, 'id' | 'at' | 'state'>): Reservation {
  const row: Reservation = { ...r, id: `${l.run}-r${l.next_id++}`, at: new Date().toISOString(), state: 'open', reading_at: l.meter.last, epoch: l.meter.epoch };
  l.reservations.push(row);
  return row;
}

/** Settle at completion: the meter already holds the spend; estimate and unseen charges are booked here. */
export function settleIn(l: Ledger, r: Reservation, opts: { unknown?: boolean; cal?: Calibration } = {}): void {
  if (r.state === 'settled' || r.state === 'released') return;
  r.state = 'settled';
  r.settled_at = new Date().toISOString();
  if (opts.unknown) { l.unknown += r.tokens; r.unseen = true; return; }
  if (l.meter.contract.meter === 'estimate') { l.estimate_used += r.tokens; return; }
  const unseen = l.meter.contract.meter === 'claude' ? (r.roles ?? []).filter(x => x === 'outside-voice').length : 0;
  if (unseen && r.roles?.length) { l.unknown += Math.round((r.tokens * unseen) / r.roles.length); r.unseen = true; }
}

/** Validate and store one meter reading against the run's contract. */
export function applyReading(l: Ledger, value: number | null, source: 'flag' | 'host'): void {
  const meter = l.meter.contract.meter;
  if (value === null) return;
  if (source === 'flag' && meter !== 'capy') throw budgetError('BUDGET_READING_REJECTED', `--reading ${value} passed to meter=${meter} (unit ${l.meter.contract.unit}), which reads its own source`);
  const floor = l.meter.last ?? l.meter.baseline;
  if (value < floor) throw budgetError('BUDGET_READING_REJECTED', `reading ${value} is below the last reading ${floor} of epoch ${l.meter.epoch} (meter=${meter} unit=${l.meter.contract.unit})`);
  l.meter.last = value;
  l.meter.last_at = new Date().toISOString();
}

/** A meter change: close the epoch (its usage carries) and start the next at the new baseline. */
export function newEpoch(l: Ledger, contract: MeterContract, baseline: number): void {
  const metered = l.meter.contract.meter === 'estimate' ? l.estimate_used : Math.max(0, (l.meter.last ?? l.meter.baseline) - l.meter.baseline);
  l.epochs.push({ epoch: l.meter.epoch, contract: l.meter.contract, baseline: l.meter.baseline, last: l.meter.last, used: metered });
  l.carried_used += metered;
  l.estimate_used = 0;
  l.meter = { contract, epoch: l.meter.epoch + 1, baseline, last: baseline };
}

const BLOCK = /```gstack-budget\n[\s\S]*?\n```\n?/;
export function recordBlock(l: Ledger): string {
  const t = tally(l);
  const open = l.handoffs.filter(h => !h.reconciled_at).map(h => h.sha).join(',') || 'none';
  return `run=${l.run} ledger=${l.file} role=${l.role} cap=${l.cap ?? 'none'} tail=${l.tail} unit=${l.meter.contract.unit} meter=${l.meter.contract.meter} epoch=${l.meter.epoch} baseline=${l.meter.baseline} used=${t.used} reserved=${t.reserved} unknown=${t.unknown} stop=${l.stopped?.reason ?? 'none'} handoff=${open}`;
}

/** The record's fenced gstack-budget block: written by the bin, never by the agent. */
export function writeRecordBlock(record: string, l: Ledger): void {
  const fenced = '```gstack-budget\n' + recordBlock(l) + '\n```\n';
  let text = '';
  try { text = fs.readFileSync(record, 'utf8'); } catch {}
  const next = BLOCK.test(text) ? text.replace(BLOCK, fenced) : `${text}${text && !text.endsWith('\n') ? '\n' : ''}${text ? '\n' : ''}${fenced}`;
  writePrivate(record, next);
}

export function parseRecordBlock(record: string): Record<string, string> | undefined {
  let text: string;
  try { text = fs.readFileSync(record, 'utf8'); } catch { return undefined; }
  const m = BLOCK.exec(text);
  if (!m) return undefined;
  const body = m[0].split('\n')[1] ?? '';
  return Object.fromEntries(body.split(/\s+/).filter(Boolean).map(kv => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
}

/** Resolve --run or --record to a ledger file; never by branch or working directory. */
export function ledgerFileFor(o: { run?: string; record?: string }, env: NodeJS.ProcessEnv): string {
  if (o.record) {
    const block = parseRecordBlock(o.record);
    if (!block?.ledger) throw budgetError('BUDGET_LEDGER_INVALID', `${o.record}: no gstack-budget block (run gstack-ship-budget start --record ${o.record} first)`);
    return block.ledger;
  }
  if (o.run) {
    if (!/^[A-Za-z0-9._-]+$/.test(o.run)) throw usageError(`--run '${o.run}' is not a run id`);
    return path.join(runDirFor(env, o.run), 'budget.json');
  }
  throw usageError('pass --run <id> or --record <path>; runs are never found by branch or directory');
}

/** SLUG and BRANCH exactly as gstack-review-log sees them (bin/gstack-slug). */
export function reviewPaths(cwd: string, env: NodeJS.ProcessEnv): { marker: string; reviewLog: string } {
  const r = runScriptSync(path.join(BIN_DIR, 'gstack-slug'), [], { cwd, env, encoding: 'utf8', timeout: 30_000 });
  const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(r.stdout ?? '')?.[1]?.trim();
  const slug = get('SLUG'), branch = get('BRANCH');
  if (r.status !== 0 || !slug || !branch) throw usageError(`cannot resolve the project slug and branch in ${cwd} (bin/gstack-slug exit ${r.status})`);
  const dir = path.join(resolveStateRoot(env), 'projects', slug);
  return { marker: path.join(dir, `${branch}-ship-budget.json`), reviewLog: path.join(dir, `${branch}-reviews.jsonl`) };
}

export function pointMarker(marker: string | undefined, l: Ledger): void {
  if (!marker) return;
  if (l.cap === null) { try { fs.unlinkSync(marker); } catch {} return; }
  writePrivate(marker, JSON.stringify({ run: l.run, ledger: l.file }) + '\n');
}

function activeLedger(marker: string): Ledger | undefined {
  let pointer: { ledger?: string };
  try { pointer = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch (e: any) { if (e.code === 'ENOENT') return undefined; throw e; }
  const l = pointer.ledger && fs.existsSync(pointer.ledger) ? readLedger(pointer.ledger) : undefined;
  return l && l.cap !== null && !l.closed_at ? l : undefined;
}

/**
 * gstack-review-log --start under a cap: the dispatch needs an unspent, one-shot
 * dispatch reservation of the active run, consumed atomically with the start
 * capture. No marker (no cap), a marker whose ledger is gone, or a stopped run
 * started without --reservation (a later uncapped review on the branch) runs
 * capture() exactly as before.
 */
export function admitReviewStart(marker: string, reservation: string | undefined, capture: () => string, env: NodeJS.ProcessEnv = process.env): string {
  const active = activeLedger(marker);
  if (!active || (active.stopped && !reservation)) return capture();
  return mutateLedger(active.file, env, l => {
    const fix = `run gstack-ship-budget check --run ${l.run} --step <s> --next dispatch:<roles> and pass --reservation <id>`;
    if (l.stopped) throw new BudgetError('BUDGET_CAP_REACHED', resultLine('gstack-review-log', 'BUDGET_CAP_REACHED', `run ${l.run} stopped at Step ${l.stopped.step}: ${l.stopped.reason}`), 1);
    if (!reservation) throw new BudgetError('BUDGET_CHECK_SKIPPED', resultLine('gstack-review-log', 'BUDGET_CHECK_SKIPPED', `no --reservation under the ${l.cap} cap of run ${l.run}; ${fix}`), 1);
    const r = l.reservations.find(x => x.id === reservation);
    if (!r || r.kind !== 'dispatch') throw new BudgetError('BUDGET_CHECK_SKIPPED', resultLine('gstack-review-log', 'BUDGET_CHECK_SKIPPED', `reservation ${reservation} is ${r ? `a ${r.kind} reservation` : 'not in'} run ${l.run}${r ? '' : ' (mismatched)'}; ${fix}`), 1);
    if (r.state !== 'open') throw new BudgetError('BUDGET_CHECK_SKIPPED', resultLine('gstack-review-log', 'BUDGET_CHECK_SKIPPED', `reservation ${reservation} is already ${r.state}${r.token ? ` by start ${r.token}` : ''} (one-shot); ${fix}`), 1);
    const out = capture();
    r.state = 'consumed';
    r.token = out.split('\n')[0]!.trim();
    r.started_at = new Date().toISOString();
    return out;
  });
}

/**
 * gstack-review-log --finish TOKEN: the pass is over, so settle the reservation
 * that start consumed and every other dispatch reservation started in the same
 * step (a pass logs one row even when its reviewers were admitted one by one).
 */
export function settleReviewFinish(marker: string, token: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const active = activeLedger(marker);
  if (!active || !active.reservations.some(r => r.token === token && r.state === 'consumed')) return undefined;
  return mutateLedger(active.file, env, l => {
    const r = l.reservations.find(x => x.token === token && x.state === 'consumed');
    if (!r) return undefined;
    const pass = l.reservations.filter(x => x.kind === 'dispatch' && x.state === 'consumed' && x.step === r.step);
    for (const x of pass) settleIn(l, x);
    return pass.map(x => x.id).join(',');
  });
}

/** close's audit: review-log rows of this run with no reservation consumed before they started. */
export function unreservedDispatches(l: Ledger): Array<{ skill: string; step: string; started: string }> {
  if (!l.review_log) return [];
  let lines: string[];
  try { lines = fs.readFileSync(l.review_log, 'utf8').split('\n').filter(Boolean); } catch { return []; }
  const reservedStarts = new Set(l.reservations.filter(r => r.started_at).map(r => r.token));
  const out: Array<{ skill: string; step: string; started: string }> = [];
  for (const line of lines) {
    let row: any;
    try { row = JSON.parse(line); } catch { continue; }
    const step = DIFF_REVIEW_STEP[row?.skill];
    const started = row?.review_binding?.started_at ?? row?.timestamp;
    if (!step || typeof started !== 'string' || Date.parse(started) < Date.parse(l.created_at)) continue;
    const startFile = l.reservations.find(r => r.started_at && r.token && Math.abs(Date.parse(r.started_at) - Date.parse(started)) < 5_000);
    if (!startFile || !reservedStarts.has(startFile.token)) out.push({ skill: row.skill, step, started });
  }
  return out;
}

/** Where run checkpoints go: GSTACK_SHIP_BUDGET_CHECKPOINT_DIR, else the private project-user Drive folder on Capy. */
export function checkpointDir(env: NodeJS.ProcessEnv): string | undefined {
  if (env.GSTACK_SHIP_BUDGET_CHECKPOINT_DIR) return env.GSTACK_SHIP_BUDGET_CHECKPOINT_DIR;
  const folder = capyDriveFolder(env);
  return folder ? path.join(path.dirname(folder), 'ship-budget') : undefined;
}

const sha256 = (text: string | Buffer) => crypto.createHash('sha256').update(text).digest('hex');

/** Mirror the ledger and record, bound to the run id and their hashes. */
export function mirrorRun(l: Ledger, env: NodeJS.ProcessEnv): void {
  const dir = checkpointDir(env);
  if (!dir) return;
  const into = path.join(dir, l.run);
  const ledgerText = fs.readFileSync(l.file);
  writePrivate(path.join(into, 'budget.json'), ledgerText.toString());
  let recordSha: string | null = null;
  if (l.record && fs.existsSync(l.record)) {
    const recordText = fs.readFileSync(l.record);
    writePrivate(path.join(into, 'record.md'), recordText.toString());
    recordSha = sha256(recordText);
  }
  writePrivate(path.join(into, 'binding.json'), JSON.stringify({ run: l.run, ledger: l.file, record: l.record ?? null, ledger_sha256: sha256(ledgerText), record_sha256: recordSha }, null, 2) + '\n');
}

/** Restore a run's ledger and record from its checkpoint when the original paths are gone. */
export function restoreRun(run: string, env: NodeJS.ProcessEnv): { ledger: string; record: string | null; from: string } | undefined {
  const dir = checkpointDir(env);
  if (!dir) return undefined;
  const from = path.join(dir, run);
  let binding: any;
  try { binding = JSON.parse(fs.readFileSync(path.join(from, 'binding.json'), 'utf8')); } catch { return undefined; }
  const ledgerText = fs.readFileSync(path.join(from, 'budget.json'));
  if (binding.run !== run || sha256(ledgerText) !== binding.ledger_sha256 || JSON.parse(ledgerText.toString()).run !== run) {
    throw budgetError('BUDGET_LEDGER_INVALID', `checkpoint ${from} is not bound to run ${run} (identity or sha256 mismatch)`);
  }
  writePrivate(binding.ledger, ledgerText.toString());
  if (binding.record && binding.record_sha256) {
    const recordText = fs.readFileSync(path.join(from, 'record.md'));
    if (sha256(recordText) !== binding.record_sha256) throw budgetError('BUDGET_LEDGER_INVALID', `checkpoint record ${from}/record.md sha256 mismatch`);
    if (!fs.existsSync(binding.record)) writePrivate(binding.record, recordText.toString());
  }
  return { ledger: binding.ledger, record: binding.record, from };
}
