/**
 * ship-budget-cli — the commands of bin/gstack-ship-budget (docs/ship-budget.md):
 * start, check, settle, release, close and resume here; handoff, verify-handoff,
 * return and reconcile in lib/ship-handoff.ts. Every command returns its lines
 * and exit code: 0 continue or delegate, 3 stop (the next step does not start),
 * 2 usage or validation (stderr, with the code, the value and the repair).
 * GSTACK_RESULT is printed only on a stop, an incomplete close and a child's
 * return; the run's real terminal line stays /ship Step 22's.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resultLine } from './result-codes';
import {
  BudgetError, DEFAULT_TAIL, DELEGATE_SEGMENT_CALL, DELEGATE_START_CALL, MAX_CHAIN_DEPTH, METER_CONTRACTS, SEGMENTS, SHIP_STEPS,
  aboveFloor, admits, applyCredits, applyReading, budgetError, creditsUsed, parseCredits, budgetLine, keepsSmallRun, ledgerFileFor, loadCalibration, measureSettled, mintRunId, mutateLedger, newEpoch,
  parseNext, parseRecordBlock, parseStep, parseTokens, pointMarker, projector, readLedger, reserveIn, restoreRun, reviewPaths,
  runDirFor, settleIn, stepProjection, tally, unitConstants, unreservedDispatches, usageError, writeLedger,
  type Ledger, type MeterKind, type Next, type Note,
} from './ship-budget';
import { claudeConfigDir, loadMeterState, newMeterState, nonceSessions, readClaudeUsage, saveMeterState, sessionJournals } from './claude-usage';

export type Opts = Record<string, string | true>;
export interface Outcome { stdout: string[]; exit: number }
export interface Ctx { env: NodeJS.ProcessEnv; cwd: string }

export function parseArgs(argv: string[], values: string[], flags: string[] = []): Opts {
  const out: Opts = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i]!.replace(/^--/, '');
    if (!argv[i]!.startsWith('--')) throw usageError(`unexpected argument '${argv[i]}'`);
    if (flags.includes(name)) { out[name] = true; continue; }
    if (!values.includes(name)) throw usageError(`unknown flag --${name}; valid: ${[...values, ...flags].map(v => '--' + v).join(' ')}`);
    const value = argv[++i];
    if (value === undefined) throw usageError(`--${name} needs a value`);
    out[name] = value;
  }
  return out;
}

export const str = (o: Opts, k: string) => (typeof o[k] === 'string' ? (o[k] as string) : undefined);
export const tokensOpt = (o: Opts, k: string) => (str(o, k) === undefined ? undefined : parseTokens(str(o, k), `--${k}`));
const meterFile = (l: Ledger) => path.join(l.dir, 'claude-meter.json');
/** Whether this command took a fresh reading (Claude Code reads its journals on every command). */
const freshReading = (l: Ledger, o: Opts) => l.meter.contract.meter === 'claude' || str(o, 'reading') !== undefined;

/**
 * Take this command's reading under the run's meter contract; returns the
 * per-call charge when known. On Capy that charge is --reading minus a
 * --prior-reading taken in the previous call; a prior older than the run's last
 * reading spans several calls, so it is ignored (call unknown) with a note.
 */
export function readMeter(l: Ledger, o: Opts, requireReading: boolean, notes: string[] = []): number | null {
  if (str(o, 'credits') !== undefined) applyCredits(l, parseCredits(str(o, 'credits'), '--credits'));
  const reading = tokensOpt(o, 'reading');
  const prior = tokensOpt(o, 'prior-reading');
  const meter = l.meter.contract.meter;
  if (meter !== 'capy') {
    if (reading !== undefined) applyReading(l, reading, 'flag');
    if (meter === 'estimate') return null;
    const state = loadMeterState(meterFile(l)) ?? newMeterState(l.meter.config_dir ?? claudeConfigDir(), l.meter.sessions ?? []);
    const usage = readClaudeUsage(state);
    saveMeterState(meterFile(l), state);
    applyReading(l, usage.total, 'host');
    return usage.lastCall;
  }
  if (reading === undefined) {
    if (requireReading && l.cap !== null && !l.parent_metered) throw budgetError('BUDGET_READING_MISSING', `run ${l.run} meter=capy unit=capy-tokens epoch=${l.meter.epoch}`);
    return null;
  }
  if (prior !== undefined && prior > reading) throw budgetError('BUDGET_READING_REJECTED', `--prior-reading ${prior} is above --reading ${reading}`);
  const last = l.meter.last;
  applyReading(l, reading, 'flag');
  if (prior === undefined) return null;
  if (last !== null && prior < last) {
    notes.push(`CALL_UNKNOWN: --prior-reading ${prior} is older than the run's last reading ${last}; it spans several calls, so the per-call charge is unknown (pass the reading your previous call returned)`);
    return null;
  }
  (l.calls ??= []).push({ epoch: l.meter.epoch, value: reading - prior });
  return reading - prior;
}

/**
 * The dispatch program's reading from right before its readers started
 * (--dispatched-at, with --readers), paired with this command's --reading taken
 * after every reader settled. It is late when another command read the meter
 * after it: the interval then spans a later program, so it measures nothing.
 */
function dispatchedOpt(o: Opts, lastBefore: number | null): { at: number; readers?: number; late: boolean } | undefined {
  const at = tokensOpt(o, 'dispatched-at');
  const raw = str(o, 'readers');
  const readers = raw === undefined ? undefined : Number(raw);
  if (readers !== undefined && !(Number.isInteger(readers) && readers > 0)) throw usageError(`--readers '${raw}' is not a positive integer`);
  if (at === undefined) {
    if (readers !== undefined) throw usageError('--readers needs --dispatched-at <the reading taken right before the readers started>');
    return undefined;
  }
  const reading = tokensOpt(o, 'reading');
  if (reading === undefined) throw usageError('--dispatched-at needs --reading <the reading taken after every reader settled, in the same program>');
  if (at > reading) throw budgetError('BUDGET_READING_REJECTED', `--dispatched-at ${at} is above --reading ${reading}`);
  return { at, ...(readers !== undefined ? { readers } : {}), late: lastBefore !== null && lastBefore > at };
}

/** The stop block: STOP, the resumable RECOVER line and GSTACK_RESULT incomplete; a child also writes its return. */
export function stopLines(l: Ledger, f: { call: number | null; next: string; step: string; projected: number; reason: 'budget_exhausted' | 'context_threshold'; threshold?: number }): string[] {
  l.stopped = { at: new Date().toISOString(), reason: f.reason, step: f.step, next: f.next };
  const t = tally(l);
  const p = projector(l);
  const from = f.next.startsWith('dispatch:') ? f.step : f.next;
  const tailCost = p.segment(from, '22') + p.reserve;
  const lines = [budgetLine(l, { ...f, verdict: 'stop' })];
  if (f.reason === 'budget_exhausted') {
    lines.push(`STOP: reason=budget_exhausted spent=${t.used} reserved=${t.reserved} unknown=${t.unknown} admission_cap=${l.cap} next=${f.next} projected=${f.projected}`,
      resultLine('gstack-ship-budget', 'BUDGET_CAP_REACHED', `next ${f.next} needs ${f.projected} + reserve ${p.reserve}`),
      `RECOVER: /ship --resume ${l.record ?? '<record>'} --token-cap ${t.used + t.reserved + t.unknown + tailCost}`);
  } else {
    lines.push(`STOP: reason=context_threshold call=${f.call ?? 'unknown'} call_floor=${p.floor} above_floor=${aboveFloor(f.call, p.floor) ?? 'unknown'} threshold=${f.threshold ?? DELEGATE_SEGMENT_CALL} next=${f.next} (--delegate never)`,
      `RECOVER: /ship --resume ${l.record ?? '<record>'} in a fresh session`);
  }
  lines.push(`GSTACK_RESULT: skill=ship status=incomplete run=${l.dir}`);
  if (l.role === 'child' && l.parent) writeReturnFile(l.parent.return_file, [`RETURN: handoff=${l.parent.handoff_sha} status=incomplete steps=${l.parent.from}-${l.parent.to} next=${f.next}`, ...lines]);
  return lines;
}

export function writeReturnFile(file: string, lines: string[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
}

/**
 * Admission and the delegate rule for one boundary; reserves the admitted work
 * under a cap (a dispatch batch goes to admitBatch). The rule compares the call's context above the host floor (an
 * unknown charge delegates at a segment boundary, never at start). A light diff
 * whose segment costs less than a child keeps it (keepsSmallRun). A child
 * never stops on it: after a completed step it hands its remaining steps to a
 * grandchild, and before one, at the maximum depth or past its segment it
 * continues with a CONTEXT_HIGH note. Admission still stops anyone.
 */
export function decide(l: Ledger, step: string, next: Next, call: number | null, startThreshold = false, runtimeLines?: number): Outcome {
  if (l.mode === 'observe') return observed(l, step, next.kind === 'dispatch' ? `dispatch:${next.roles.join(',')}` : next.step, call);
  if (next.kind === 'dispatch') return admitBatch(l, step, next.roles, call);
  const p = projector(l);
  const nextId = next.step;
  const { prior, tokens: projected } = p.project(next);
  if (!admits(tally(l), projected, p.reserve, l.cap)) {
    return { stdout: stopLines(l, { call, next: nextId, step, projected, reason: 'budget_exhausted' }), exit: 3 };
  }
  const threshold = startThreshold ? DELEGATE_START_CALL : DELEGATE_SEGMENT_CALL;
  const above = aboveFloor(call, p.floor);
  const boundary = (startThreshold ? next.step === '1' : next.step in SEGMENTS && next.step !== '1');
  const to = l.parent ? l.parent.to : SEGMENTS[next.step]!;
  const small = boundary && !startThreshold ? keepsSmallRun(loadCalibration(l.calibration), { runtimeLines, from: next.step, to, call }) : null;
  const wants = boundary && !small && (above === null ? !startThreshold && !l.parent_metered : above >= threshold);
  const depth = l.depth ?? (l.parent ? 1 : 0);
  const hold = !wants || !l.parent ? undefined
    : !l.steps_done?.length ? 'no step completed since verify-handoff'
    : depth >= MAX_CHAIN_DEPTH ? `chain depth ${depth} is the maximum`
    : l.delegate === 'never' ? '--delegate never'
    : SHIP_STEPS.indexOf(nextId as any) > SHIP_STEPS.indexOf(l.parent.to as any) ? `Step ${nextId} is past this child's Steps ${l.parent.from}-${l.parent.to}` : undefined;
  if (wants && !l.parent && l.delegate === 'never') {
    return { stdout: stopLines(l, { call, next: nextId, step, projected, reason: 'context_threshold', threshold }), exit: 3 };
  }
  if (wants && !hold) {
    return { stdout: [budgetLine(l, { call, next: nextId, projected, verdict: 'delegate' }),
      `DELEGATE: Steps ${next.step}-${to} go to a fresh ${l.parent ? `grandchild (chain depth ${depth + 1})` : 'child'}: gstack-ship-budget handoff --run ${l.run} --from ${next.step} --to ${to} --base origin/<base> (ship/sections/budget-handoff.md)`], exit: 0 };
  }
  const lines = [budgetLine(l, { call, next: nextId, projected, verdict: 'continue' }), ...(small ? [small] : [])];
  if (hold) lines.push(`CONTEXT_HIGH: call=${call ?? 'unknown'} call_floor=${p.floor} above_floor=${above ?? 'unknown'} threshold=${threshold} next=${nextId} depth=${depth}; continuing: ${hold}`);
  if (l.cap !== null) {
    const r = reserveIn(l, { kind: 'step', step, next: nextId, tokens: projected, prior });
    lines.push(`RESERVATION: id=${r.id} next=${nextId} tokens=${projected}`, `RESERVATION_ID: ${r.id}`);
  }
  return { stdout: lines, exit: 0 };
}

/** An observe run's verdict: continue, or the hard stop once used + unknown pass the cap. Nothing is reserved. */
function observed(l: Ledger, step: string, next: string, call: number | null, line?: string): Outcome {
  const t = tally(l);
  const head = line ? [line] : [];
  if (l.cap !== null && t.used + t.unknown > l.cap) return { stdout: [...head, ...stopLines(l, { call, next, step, projected: 0, reason: 'budget_exhausted' })], exit: 3 };
  return { stdout: [...head, budgetLine(l, { call, next, projected: 0, verdict: 'continue' })], exit: 0 };
}

/**
 * A dispatch batch: each reader is priced by projector().reader and the batch is
 * reserved as one sum. When it
 * does not fit, the largest prefix that does is admitted and ADMIT names the
 * rest; the reservation keeps them as `remaining` until a later check of the
 * same step requests them, and close flags any still left. Only a batch whose
 * first reader does not fit stops.
 */
function admitBatch(l: Ledger, step: string, roles: string[], call: number | null): Outcome {
  const p = projector(l);
  const prices = roles.map(p.reader);
  const cost = (k: number) => prices.slice(0, k).reduce((a, b) => a + b, 0);
  const t = tally(l);
  let k = roles.length;
  while (k > 0 && !admits(t, cost(k), p.reserve, l.cap)) k--;
  if (k === 0) return { stdout: stopLines(l, { call, next: `dispatch:${roles.join(',')}`, step, projected: cost(roles.length), reason: 'budget_exhausted' }), exit: 3 };
  const admitted = roles.slice(0, k), remaining = roles.slice(k), nextId = `dispatch:${admitted.join(',')}`;
  const lines = [budgetLine(l, { call, next: nextId, projected: cost(k), verdict: 'continue' })];
  if (remaining.length) lines.push(`ADMIT: ${k} of ${roles.length} (remaining=${remaining.join(',')}); dispatch these ${k} now and re-check --next dispatch:${remaining.join(',')} after they settle`);
  if (l.cap === null) return { stdout: lines, exit: 0 };
  for (const role of roles) {
    const older = l.reservations.find(r => r.step === step && r.remaining?.includes(role));
    older?.remaining!.splice(older.remaining!.indexOf(role), 1);
  }
  const r = reserveIn(l, { kind: 'dispatch', step, next: nextId, tokens: cost(k), prior: p.project({ kind: 'dispatch', roles: admitted }).prior, roles: admitted, ...(remaining.length ? { remaining } : {}) });
  lines.push(`RESERVATION: id=${r.id} next=${nextId} tokens=${cost(k)}`, `RESERVATION_ID: ${r.id}`);
  return { stdout: lines, exit: 0 };
}

/** Bind the Claude Code session: --session <id>, or a nonce echoed once; zero or several matches refuse. */
function bindClaude(o: Opts, env: NodeJS.ProcessEnv): string[] {
  const dir = claudeConfigDir(env);
  const session = str(o, 'session');
  if (session) {
    if (sessionJournals(dir, session).length !== 1) throw budgetError('BUDGET_METER_UNAVAILABLE', `--session ${session}: ${sessionJournals(dir, session).length} journals under ${dir}/projects (need exactly one)`);
    return [session];
  }
  const nonce = str(o, 'nonce');
  if (!nonce) throw budgetError('BUDGET_METER_UNAVAILABLE', `meter=claude needs --session <id>, or echo GSTACK_BUDGET_NONCE=${crypto.randomBytes(8).toString('hex')} once and rerun with --nonce <that value>`);
  const found = nonceSessions(dir, nonce);
  if (found.length !== 1) throw budgetError('BUDGET_METER_UNAVAILABLE', `--nonce ${nonce}: ${found.length} journals under ${dir}/projects contain it (need exactly one)`);
  return found;
}

function pickMeter(o: Opts): MeterKind | undefined {
  const m = str(o, 'meter');
  if (m !== undefined && !['capy', 'claude', 'estimate'].includes(m)) throw usageError(`--meter '${m}' is not capy, claude or estimate`);
  if (m) return m as MeterKind;
  if (str(o, 'reading') !== undefined) return 'capy';
  if (str(o, 'session') || str(o, 'nonce')) return 'claude';
  return undefined;
}

export function cmdStart(argv: string[], ctx: Ctx): Outcome {
  const o = parseArgs(argv, ['token-cap', 'record', 'meter', 'reading', 'credits', 'prior-reading', 'session', 'nonce', 'reserve', 'delegate', 'calibration', 'ledger', 'call-floor', 'mode']);
  const mode = str(o, 'mode') ?? 'admit';
  if (mode !== 'admit' && mode !== 'observe') throw usageError(`--mode '${mode}' is not admit or observe`);
  const record = str(o, 'record');
  if (!record) throw usageError('start needs --record <invocation record path>');
  const rawCap = str(o, 'token-cap') ?? ctx.env.GSTACK_SHIP_TOKEN_CAP;
  const cap = rawCap === undefined || rawCap === 'none' ? null : parseTokens(rawCap, '--token-cap');
  const callFloor = tokensOpt(o, 'call-floor');
  const delegate = str(o, 'delegate') ?? 'auto';
  if (delegate !== 'auto' && delegate !== 'never') throw usageError(`--delegate '${delegate}' is not auto or never`);
  const existing = parseRecordBlock(record);
  if (existing?.ledger && fs.existsSync(existing.ledger) && !readLedger(existing.ledger).closed_at) {
    const l = readLedger(existing.ledger);
    return { stdout: [`BUDGET_RUN: id=${l.run} ledger=${l.file}`, budgetLine(l, { call: null, next: '1', projected: 0, verdict: l.stopped ? 'stop' : 'continue' })], exit: l.stopped ? 3 : 0 };
  }
  const meter = pickMeter(o);
  if (!meter) {
    if (cap !== null) throw budgetError('BUDGET_METER_UNAVAILABLE', 'tried --reading (absent), a Claude Code session (--session/--nonce absent) and --meter estimate (not passed)');
    return { stdout: ['BUDGET: unmetered admission_cap=none (no readable meter: --reading <n> on Capy, --session <id> on Claude Code)'], exit: 0 };
  }
  const run = mintRunId();
  const dir = runDirFor(ctx.env, run);
  const cal = loadCalibration(str(o, 'calibration'));
  const contract = METER_CONTRACTS[meter];
  const paths = reviewPaths(ctx.cwd, ctx.env);
  const sessions = meter === 'claude' ? bindClaude(o, ctx.env) : undefined;
  const l: Ledger = {
    schema_version: 1, kind: 'gstack-ship-budget', run, dir, file: str(o, 'ledger') ?? path.join(dir, 'budget.json'), record: path.resolve(record),
    created_at: new Date().toISOString(), cap, tail: tokensOpt(o, 'reserve') ?? DEFAULT_TAIL, ...(tokensOpt(o, 'reserve') !== undefined ? { tail_explicit: true } : {}),
    stop_overhead: unitConstants(cal, contract.unit).stop_overhead,
    delegate, role: 'parent', meter: { contract, epoch: 1, baseline: 0, last: null, ...(sessions ? { sessions, config_dir: claudeConfigDir(ctx.env) } : {}) },
    epochs: [], carried_used: 0, estimate_used: 0, unknown: 0, next_id: 1, reservations: [], handoffs: [], cap_raises: [],
    marker: paths.marker, review_log: paths.reviewLog, ...(str(o, 'calibration') ? { calibration: path.resolve(str(o, 'calibration')!) } : {}),
    ...(callFloor !== undefined ? { call_floor: callFloor } : {}), ...(mode === 'observe' ? { mode } : {}),
  };
  if (meter === 'capy' && tokensOpt(o, 'reading') === undefined) throw budgetError('BUDGET_READING_MISSING', 'start --meter capy');
  if (meter === 'capy') l.meter.baseline = tokensOpt(o, 'reading')!;
  const call = readMeter(l, o, true);
  if (meter === 'claude') l.meter.baseline = l.meter.last ?? 0;
  const out = decide(l, '0.9', { kind: 'step', step: '1' }, call, true);
  writeLedger(l, ctx.env);
  pointMarker(l.marker, l);
  return { stdout: [`BUDGET_RUN: id=${run} ledger=${l.file}`, ...out.stdout], exit: out.exit };
}

/**
 * check: read the meter, settle what is done (open step reservations, the
 * dispatches named by --returned, and on a step change every dispatch a
 * reviewer consumed), measure them, then admit the next step or dispatch.
 */
export function cmdCheck(argv: string[], ctx: Ctx): Outcome {
  const o = parseArgs(argv, ['run', 'record', 'step', 'next', 'reading', 'credits', 'prior-reading', 'returned', 'dispatched-at', 'readers', 'runtime-lines']);
  const runtimeRaw = str(o, 'runtime-lines');
  if (runtimeRaw !== undefined && !/^\d+$/.test(runtimeRaw)) throw usageError(`--runtime-lines '${runtimeRaw}' is not a line count; pass runtime_lines from gstack-review-plan --json`);
  const step = parseStep(str(o, 'step'));
  const next = parseNext(str(o, 'next'));
  const returned = (str(o, 'returned') ?? '').split(',').filter(Boolean);
  return mutateLedger(ledgerFileFor({ run: str(o, 'run'), record: str(o, 'record') }, ctx.env), ctx.env, l => {
    if (l.closed_at) throw usageError(`run ${l.run} is closed`);
    if (l.stopped) return { stdout: [budgetLine(l, { call: null, next: l.stopped.next, projected: 0, verdict: 'stop' }), `STOP: reason=${l.stopped.reason} at Step ${l.stopped.step}; resume first: gstack-ship-budget resume --record ${l.record}`, `GSTACK_RESULT: skill=ship status=incomplete run=${l.dir}`], exit: 3 };
    const back = returned.map(id => l.reservations.find(r => r.id === id && r.kind === 'dispatch'));
    const bad = returned.filter((_, i) => !back[i]);
    if (bad.length) throw usageError(`--returned ${bad.join(',')} is not a dispatch reservation of run ${l.run}; fix: pass the RESERVATION ids check printed for the reviewers that came back`);
    if (str(o, 'dispatched-at') !== undefined && !back.length) throw usageError('--dispatched-at measures the reservations named by --returned; pass them, or use settle');
    const notes: string[] = [];
    const lastBefore = l.meter.last;
    const dispatched = dispatchedOpt(o, lastBefore);
    const call = readMeter(l, o, true, notes);
    const fresh = freshReading(l, o);
    for (const r of l.reservations) {
      const done = r.kind === 'step' ? r.state === 'open' : r.kind === 'dispatch' && (back.includes(r) || (next.kind === 'step' && r.state === 'consumed'));
      if (done) settleIn(l, r, back.includes(r) && fresh ? { reading: l.meter.last ?? undefined, dispatched } : {});
    }
    const drift = fresh ? measureSettled(l, next.kind === 'step') : [];
    if (l.parent && next.kind === 'step' && SHIP_STEPS.indexOf(step as any) >= SHIP_STEPS.indexOf(l.parent.from as any)) l.steps_done = [...new Set([...(l.steps_done ?? []), step])];
    const out = decide(l, step, next, call, false, runtimeRaw === undefined ? undefined : Number(runtimeRaw));
    return { stdout: [...notes, ...drift, ...out.stdout], exit: out.exit };
  });
}

export function cmdSettle(argv: string[], ctx: Ctx, release = false): Outcome {
  const o = parseArgs(argv, ['run', 'record', 'reservation', ...(release ? [] : ['reading', 'credits', 'dispatched-at', 'readers'])], release ? [] : ['unknown']);
  const id = str(o, 'reservation');
  if (!id) throw usageError(`${release ? 'release' : 'settle'} needs --reservation <id>`);
  return mutateLedger(ledgerFileFor({ run: str(o, 'run'), record: str(o, 'record') }, ctx.env), ctx.env, l => {
    const r = l.reservations.find(x => x.id === id);
    if (!r) throw usageError(`reservation ${id} is not in run ${l.run}`);
    if (release) { if (r.state === 'open') r.state = 'released'; return { stdout: [`RELEASED: id=${id} state=${r.state}`], exit: 0 }; }
    const dispatched = dispatchedOpt(o, l.meter.last);
    readMeter(l, o, false);
    const fresh = freshReading(l, o);
    settleIn(l, r, { unknown: o.unknown === true, cal: loadCalibration(l.calibration), reading: fresh ? l.meter.last ?? undefined : undefined, dispatched });
    return { stdout: [`SETTLED: id=${id} state=${r.state}`, ...(fresh ? measureSettled(l, false) : [])], exit: 0 };
  });
}

export function cmdClose(argv: string[], ctx: Ctx): Outcome {
  const o = parseArgs(argv, ['run', 'record', 'reading', 'credits', 'approved-by', 'words']);
  return mutateLedger(ledgerFileFor({ run: str(o, 'run'), record: str(o, 'record') }, ctx.env), ctx.env, l => {
    readMeter(l, o, false);
    for (const r of l.reservations) if (r.kind === 'step' && r.state === 'open') settleIn(l, r);
    if (freshReading(l, o)) measureSettled(l);
    const t = tally(l);
    const open = l.reservations.filter(r => r.kind === 'dispatch' && r.state === 'consumed').length;
    const credits = creditsUsed(l);
    const lines = [`BUDGET_FINAL: used=${t.used}${credits === null ? '' : ` credits=${credits}`} reserved=${t.reserved} unknown=${t.unknown} admission_cap=${l.cap ?? 'none'} unit=${l.meter.contract.unit} meter=${l.meter.contract.meter} epoch=${l.meter.epoch} open_dispatches=${open}`];
    const sum = (kind: string, k: 'projected' | 'actual') => (l.samples ?? []).filter(s => s.kind === kind).reduce((n, s) => n + s[k], 0);
    const count = (kind: string) => (l.samples ?? []).filter(s => s.kind === kind).length;
    if (l.notes?.length) lines.push(`BUDGET_TIMELINE: ${l.notes.map(noteText).join('; ')}`);
    lines.push(`BUDGET_DRIFT: steps=${count('step')} step_projected=${sum('step', 'projected')} step_actual=${sum('step', 'actual')} dispatches=${count('dispatch')} dispatch_projected=${sum('dispatch', 'projected')} dispatch_actual=${sum('dispatch', 'actual')}`);
    const accepted = new Set((l as any).accepted_skips as string[] | undefined ?? []);
    const skipped = l.cap === null || l.mode === 'observe' ? [] : unreservedDispatches(l).filter(s => !accepted.has(s.started));
    const dropped = l.reservations.filter(r => r.remaining?.length && !accepted.has(r.id));
    if ((skipped.length || dropped.length) && str(o, 'approved-by') && str(o, 'words')) {
      (l as any).accepted_skips = [...accepted, ...skipped.map(s => s.started), ...dropped.map(r => r.id)];
      lines.push(`ACCEPTED: ${skipped.length} unreserved dispatches${dropped.length ? ` and ${dropped.length} unfinished batches` : ''} by ${str(o, 'approved-by')}: "${str(o, 'words')}"`);
    } else if (skipped.length || dropped.length) {
      for (const s of skipped) lines.push(resultLine('gstack-ship-budget', 'BUDGET_CHECK_SKIPPED', `role=${s.skill} step=${s.step} started=${s.started} spend=unknown`));
      for (const r of dropped) lines.push(`DROPPED: step=${r.step} reservation=${r.id} roles=${r.remaining!.join(',')} (ADMIT named them; no later check requested them)`);
      const reason = skipped.length ? 'budget_check_skipped' : 'batch_incomplete';
      l.stopped = { at: new Date().toISOString(), reason, step: '22', next: '22' };
      lines.push(`STOP: reason=${reason} dispatches=${skipped.length}${dropped.length ? ` unfinished_batches=${dropped.length}` : ''}; owner decision: accept ${skipped.length ? 'the unreserved spend' : 'the readers that never ran'} (close --record ${l.record} --approved-by <who> --words <their words>) or rerun them under reservations`,
        `GSTACK_RESULT: skill=ship status=incomplete run=${l.dir}`);
      return { stdout: lines, exit: 3 };
    }
    l.closed_at = new Date().toISOString();
    if (l.marker) { try { fs.unlinkSync(l.marker); } catch {} }
    return { stdout: lines, exit: 0 };
  });
}

const noteText = (n: Note) => `${n.step}${n.label ? `:${n.label}` : ''} used=${n.used}${n.credits === undefined ? '' : ` credits=${n.credits}`}`
  + (n.readers ? ` readers=${n.readers.n} readers_tokens=${n.readers.tokens}${n.readers.credits === undefined ? '' : ` readers_credits=${n.readers.credits}`}` : '');

/**
 * note: record one program's readings (tokens and credits) and, when --dispatched-at
 * brackets them, the readers it dispatched; stop only once used + unknown pass the cap.
 * It reserves, admits and delegates nothing: ship/DRIVER.md's observe runs end every
 * program with it instead of a check at each boundary.
 */
export function cmdNote(argv: string[], ctx: Ctx): Outcome {
  const o = parseArgs(argv, ['run', 'record', 'step', 'label', 'reading', 'credits', 'dispatched-at', 'dispatched-credits', 'readers']);
  const step = parseStep(str(o, 'step'));
  const label = str(o, 'label');
  return mutateLedger(ledgerFileFor({ run: str(o, 'run'), record: str(o, 'record') }, ctx.env), ctx.env, l => {
    if (l.closed_at) throw usageError(`run ${l.run} is closed`);
    if (l.stopped) return { stdout: [budgetLine(l, { call: null, next: l.stopped.next, projected: 0, verdict: 'stop' }), `STOP: reason=${l.stopped.reason} at Step ${l.stopped.step}; resume first: gstack-ship-budget resume --record ${l.record}`, `GSTACK_RESULT: skill=ship status=incomplete run=${l.dir}`], exit: 3 };
    if (l.meter.contract.meter === 'capy' && str(o, 'reading') === undefined) throw budgetError('BUDGET_READING_MISSING', `note --step ${step}: run ${l.run} meter=capy`);
    const dispatched = dispatchedOpt(o, null);
    const before = str(o, 'dispatched-credits') === undefined ? undefined : parseCredits(str(o, 'dispatched-credits'), '--dispatched-credits');
    if (before !== undefined && !dispatched) throw usageError('--dispatched-credits needs --dispatched-at <the token reading taken with it>');
    readMeter(l, o, true);
    const credits = creditsUsed(l);
    const readers = dispatched && l.meter.last !== null ? { n: dispatched.readers ?? 1, tokens: l.meter.last - dispatched.at,
      ...(before !== undefined && l.credits ? { credits: Math.round((l.credits.last - before) * 100) / 100 } : {}) } : undefined;
    const n: Note = { step, ...(label ? { label } : {}), at: new Date().toISOString(), used: tally(l).used, ...(credits === null ? {} : { credits }), ...(readers ? { readers } : {}) };
    (l.notes ??= []).push(n);
    return observed(l, step, label ?? step, null, `NOTE: ${noteText(n)}`);
  });
}

/** resume: re-attach after a stop or a machine change; rebuild or restore a lost ledger; journal a cap raise. */
export function cmdResume(argv: string[], ctx: Ctx): Outcome {
  const o = parseArgs(argv, ['record', 'run', 'reading', 'credits', 'prior-reading', 'meter', 'session', 'nonce', 'token-cap', 'approved-by', 'words'], ['rebuild-from-record']);
  const cap = str(o, 'token-cap');
  if (cap !== undefined && (!str(o, 'approved-by') || !str(o, 'words'))) throw usageError('resume --token-cap needs --approved-by <who> --words <the owner\'s words>; raising the cap is the owner\'s call');
  const lines: string[] = [];
  let file: string;
  const record = str(o, 'record');
  const block = record ? parseRecordBlock(record) : undefined;
  const run = str(o, 'run') ?? block?.run;
  file = block?.ledger ?? ledgerFileFor({ run }, ctx.env);
  if (!fs.existsSync(file) && run) {
    const restored = restoreRun(run, ctx.env);
    if (restored) { file = restored.ledger; lines.push(`RESTORED: ledger=${restored.ledger} record=${restored.record ?? 'none'} from=${restored.from}`); }
  }
  if (o['rebuild-from-record'] === true) {
    try { readLedger(file); } catch { rebuildLedger(file, record, ctx, o); lines.push(`REBUILT: ledger=${file} from=${record}`); }
  }
  const out = mutateLedger(file, ctx.env, l => {
    const meter = pickMeter(o) ?? l.meter.contract.meter;
    if (meter !== l.meter.contract.meter) {
      const sessions = meter === 'claude' ? bindClaude(o, ctx.env) : undefined;
      newEpoch(l, METER_CONTRACTS[meter], meter === 'capy' ? tokensOpt(o, 'reading') ?? 0 : 0);
      if (sessions) { l.meter.sessions = sessions; l.meter.config_dir = claudeConfigDir(ctx.env); try { fs.unlinkSync(path.join(l.dir, 'claude-meter.json')); } catch {} }
      const call = readMeter(l, { ...o, ...(meter === 'capy' ? {} : { reading: undefined as any }) }, false);
      if (meter === 'claude') { l.meter.baseline = l.meter.last ?? 0; }
      void call;
      lines.push(`EPOCH: ${l.meter.epoch} meter=${meter} unit=${l.meter.contract.unit} carried_used=${l.carried_used}`);
    } else readMeter(l, o, false);
    if (cap !== undefined) {
      const to = cap === 'none' ? null : parseTokens(cap, '--token-cap');
      l.cap_raises.push({ from: l.cap, to, by: str(o, 'approved-by')!, words: str(o, 'words')!, at: new Date().toISOString() });
      l.cap = to;
    }
    const was = l.stopped;
    delete l.stopped;
    pointMarker(l.marker, l);
    return [`BUDGET_RUN: id=${l.run} ledger=${l.file}`, `RESUMED: from=${was ? `Step ${was.step} (${was.reason})` : 'running'}`, budgetLine(l, { call: null, next: was?.next ?? '-', projected: 0, verdict: 'continue' })];
  });
  return { stdout: [...lines, ...out], exit: 0 };
}

/** Rebuild a ledger from the record's gstack-budget block; open reservations are charged as unknown. */
function rebuildLedger(file: string, record: string | undefined, ctx: Ctx, o: Opts): void {
  const b = record ? parseRecordBlock(record) : undefined;
  if (!b?.run || !b.meter || !(b.meter in METER_CONTRACTS)) throw budgetError('BUDGET_LEDGER_INVALID', `${record ?? '--record'}: no usable gstack-budget block to rebuild from`);
  const meter = b.meter as MeterKind;
  const reading = tokensOpt(o, 'reading');
  if (meter === 'capy' && reading === undefined) throw budgetError('BUDGET_READING_MISSING', 'resume --rebuild-from-record on meter=capy');
  const num = (k: string) => Number(b[k] ?? 0) || 0;
  const l: Ledger = {
    schema_version: 1, kind: 'gstack-ship-budget', run: b.run, dir: path.dirname(file), file, record: path.resolve(record!),
    created_at: new Date().toISOString(), cap: b.cap === 'none' ? null : num('cap'), tail: num('tail') || DEFAULT_TAIL,
    stop_overhead: unitConstants(loadCalibration(), METER_CONTRACTS[meter].unit).stop_overhead, delegate: 'auto', role: b.role === 'child' ? 'child' : 'parent',
    meter: { contract: METER_CONTRACTS[meter], epoch: num('epoch') + 1, baseline: meter === 'capy' ? reading! : 0, last: meter === 'capy' ? reading! : null },
    epochs: [], carried_used: num('used'), estimate_used: 0, unknown: num('unknown') + num('reserved'), next_id: 1, reservations: [], handoffs: [], cap_raises: [],
    ...(() => { try { return { marker: reviewPaths(ctx.cwd, ctx.env).marker, review_log: reviewPaths(ctx.cwd, ctx.env).reviewLog }; } catch { return {}; } })(),
    ...(b.mode === 'observe' ? { mode: 'observe' as const } : {}),
  };
  if (meter === 'estimate') l.estimate_used = 0;
  fs.mkdirSync(l.dir, { recursive: true, mode: 0o700 });
  writeLedger(l, ctx.env);
}

export { SHIP_STEPS, stepProjection, BudgetError };
