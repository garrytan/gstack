/**
 * autoplan-budget — the run budget of the unattended runner (field list 2,
 * W5). Review rounds are counted per phase from `state.history` reopen events
 * and capped by `run.json.max_rounds` (default 2 for new unattended runs; a
 * resumed run keeps the value it persisted) plus the
 * owner's per-phase grants at the gate. Unattended runs on Capy reserve a
 * default per-voice estimate for unestimated host attempts, so `--spend-cap`
 * binds. A dispatch the cap refuses stops the run at the terminal `incomplete`
 * status with a structured `stop` object (`reason: budget_exhausted`) and
 * printed recovery commands; `gstack-autoplan budget` journals the owner's cap
 * change and `resume` lifts the stop only after one. Phase close at the cap
 * lives in lib/autoplan-gate.ts (`closeDeferred`); `escalateLine` names the
 * capped phases still holding High or Critical findings.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ANSWERED_BY_RE, type GateItem } from './gate-list';
import { settledIds } from './autoplan-confirm';
import type { ConsensusRecord } from './autoplan-reconcile';
import { FILES, RunError, journal, now, readJournal, voiceRows, type RunState, type RunStop } from './autoplan-state';
import { readLedger, release, setCap, summarize } from './spend-ledger';

export const DEFAULT_MAX_ROUNDS = 2;
/** Reserved per voice for a host-subagent attempt with no `--estimate-usd` in an unattended run with a spend cap or on Capy. */
export const DEFAULT_HOST_ESTIMATE_USD = 5;

/** Round r of a phase: 1 plus the times it was reopened. */
export const roundOf = (state: RunState, phase: string): number => 1 + state.history.filter(h => h.event === 'reopened' && h.phase === phase).length;
/** The phase's round cap: max_rounds plus the owner's grants; null when the run is uncapped. */
export function roundCap(state: RunState, phase: string): number | null {
  return state.max_rounds == null ? null : state.max_rounds + (state.round_grants?.[phase] ?? 0);
}
/** Reopening would pass the cap: the phase has used its last round. */
export const atCap = (state: RunState, phase: string): boolean => { const cap = roundCap(state, phase); return cap !== null && roundOf(state, phase) >= cap; };
/** The phase is about to open past its cap (a rerun-all reply reopened it). */
export const overCap = (state: RunState, phase: string): boolean => { const cap = roundCap(state, phase); return cap !== null && roundOf(state, phase) > cap; };

/** Open High or Critical findings of a closed phase: the deferred counts, else bound rows not settled or answered, an outside row paired (by title or line) with a High or Critical native one counted once. */
function openHigh(state: RunState, phase: string): number {
  const ps = state.phases[phase];
  if (ps?.deferred) return (ps.deferred.counts.High ?? 0) + (ps.deferred.counts.Critical ?? 0);
  const file = path.join(state.out, `${phase}-consensus.json`);
  let rows: ConsensusRecord['rows'] = [];
  try { rows = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as ConsensusRecord).rows : []; } catch {}
  const high = (s: string | undefined) => s === 'High' || s === 'Critical';
  const native = voiceRows(state, phase, 'native');
  const nativeHigh = new Set(native.filter(r => high(r.severity)).map(r => r.id));
  const paired = new Set(rows.filter(r => r.native_id && r.basis !== 'file' && nativeHigh.has(r.native_id)).map(r => r.outside_id));
  const answered = settledIds(state);
  return [...native, ...voiceRows(state, phase, 'outside')]
    .filter(r => !paired.has(r.id) && !(r as { settled_by?: string }).settled_by && !answered.has(r.id) && high(r.severity)).length;
}

/** At the round cap with High or Critical findings still open, more rounds buy nothing: the owner decides. */
export function escalateLine(state: RunState): string | undefined {
  const held = state.phase_order.filter(p => state.phases[p]?.closed_at && atCap(state, p)).map(p => [p, openHigh(state, p)] as const).filter(([, n]) => n > 0);
  return held.length ? `ESCALATE: evidence sufficient, decision needed (${held.map(([p, n]) => `${p}: ${n} High open`).join('; ')})` : undefined;
}

export function roundsLine(state: RunState): string {
  const cell = (p: string) => `${p}=${roundOf(state, p)}/${roundCap(state, p) ?? 'none'}`;
  return `ROUNDS: ${state.phase_order.map(cell).join(' ')} max_rounds=${state.max_rounds ?? 'none'} host_spend=unknown`;
}

/**
 * The estimate one new attempt reserves: the flag, else the run's persisted `--estimate-usd`, else the unattended
 * default when the run has a spend cap or runs on Capy, else 0 (host spend unknown, not admitted). `run` prices its
 * api attempts from the price table instead (NextOptions.price).
 */
export function attemptEstimate(state: RunState, flag: number | undefined, env: NodeJS.ProcessEnv): { usd: number; line?: string } {
  const set = flag ?? state.estimate_usd;
  if (set !== undefined) return { usd: set };
  if (state.session_kind !== 'unattended' || (env.GSTACK_CAPY !== '1' && state.spend_cap_usd === null)) return { usd: 0 };
  return { usd: DEFAULT_HOST_ESTIMATE_USD, line: `ESTIMATE: ${DEFAULT_HOST_ESTIMATE_USD.toFixed(2)} per voice reserved for each host-subagent attempt (unattended default under a spend cap or on Capy; --estimate-usd <n> sets it for the rest of the run); actual host spend stays unknown` };
}

/** Stop the run: terminal `incomplete` with the structured budget_exhausted stop, journaled. Returns the STOP and RECOVER lines. */
export function stopForBudget(state: RunState, phase: string, nextEstimate: number): string[] {
  const s = summarize(readLedger(path.join(state.out, FILES.spend), state.spend_cap_usd));
  const stop: RunStop = {
    reason: 'budget_exhausted', phase, cap_usd: state.spend_cap_usd, max_rounds: state.max_rounds ?? null,
    rounds: Object.fromEntries(state.phase_order.map(p => [p, roundOf(state, p)])), spent: s.spent_usd, reserved: s.reserved_usd,
    unknown: s.unknown_usd, unknown_count: s.unknown_count, next_estimate_usd: nextEstimate, at: now(),
  };
  state.stop = stop;
  state.status = 'incomplete';
  journal(state.out, { event: 'stopped', ...stop });
  return stopLines(state);
}

export function stopLines(state: RunState): string[] {
  const s = state.stop;
  if (!s) return [];
  const rounds = Object.entries(s.rounds).map(([p, r]) => `${p}:${r}/${roundCap(state, p) ?? 'none'}`).join(',');
  return [
    `STOP: reason=${s.reason} phase=${s.phase ?? 'none'} cap=${s.cap_usd === null ? 'none' : s.cap_usd.toFixed(2)} spent=${s.spent.toFixed(2)} reserved=${s.reserved.toFixed(2)} unknown=${s.unknown_count}(${s.unknown.toFixed(2)}) next_estimate=${s.next_estimate_usd.toFixed(2)} rounds=${rounds}`,
    ...recoveryLines(state),
  ];
}

export function recoveryLines(state: RunState): string[] {
  const phase = state.stop?.phase ?? '<phase>';
  return [
    `RECOVER: gstack-autoplan close --out ${state.out} --phase ${phase} --deferred "<reason>" --by <human|agent:<id>>   (close ${phase} accepted-with-findings, deferred to the build)`,
    `RECOVER: gstack-autoplan budget --out ${state.out} --spend-cap <usd> [--max-rounds <n>] --by <human|agent:<id>>, then gstack-autoplan resume --out ${state.out}   (an owner-authorized cap raise)`,
  ];
}

/** Clear the stop into `stops` (its history) and leave the run resumable. */
export function liftStop(state: RunState, why: string): string[] {
  if (!state.stop) return [];
  (state.stops ??= []).push(state.stop);
  delete state.stop;
  state.status = 'running';
  journal(state.out, { event: 'stop_lifted', why });
  return [`STOP_LIFTED: ${why}`];
}

/** `resume` on a budget-stopped run: lifts the stop only when a budget change was journaled after it. */
export function resumeStop(state: RunState): string[] {
  if (state.status !== 'incomplete' || state.stop?.reason !== 'budget_exhausted') return [];
  const at = state.stop.at;
  const raised = readJournal(state.out).some(r => r.event === 'budget_changed' && String(r.ts) >= at);
  if (!raised) return [`STOPPED: budget_exhausted at ${at}; nothing changed the budget since`, ...recoveryLines(state)];
  return liftStop(state, 'budget raised after budget_exhausted');
}

export interface BudgetChange { spendCap?: number; maxRounds?: number; by?: string }

/** `gstack-autoplan budget`: the owner's journaled change of the spend cap and/or the round cap. */
export function changeBudget(state: RunState, o: BudgetChange): string[] {
  if (o.by === undefined || !ANSWERED_BY_RE.test(o.by)) throw new RunError('ANSWER_BY_REQUIRED', `budget records who authorized the change: pass --by human or --by agent:<id> (got ${JSON.stringify(o.by ?? null)})`, 3);
  if (o.spendCap === undefined && o.maxRounds === undefined) throw new RunError('ARTIFACT_SCHEMA', 'budget needs --spend-cap <usd> and/or --max-rounds <n>', 1);
  if (o.maxRounds !== undefined && (!Number.isInteger(o.maxRounds) || o.maxRounds < 1)) throw new RunError('ARTIFACT_SCHEMA', '--max-rounds needs an integer >= 1', 1);
  const change: Record<string, unknown> = { event: 'budget_changed', by: o.by };
  const parts: string[] = [];
  if (o.spendCap !== undefined) {
    change.spend_cap = { from: state.spend_cap_usd, to: o.spendCap };
    parts.push(`spend_cap=${state.spend_cap_usd ?? 'none'}->${o.spendCap}`);
    state.spend_cap_usd = o.spendCap;
    setCap(path.join(state.out, FILES.spend), o.spendCap);
  }
  if (o.maxRounds !== undefined) {
    change.max_rounds = { from: state.max_rounds ?? null, to: o.maxRounds };
    parts.push(`max_rounds=${state.max_rounds ?? 'none'}->${o.maxRounds}`);
    state.max_rounds = o.maxRounds;
  }
  journal(state.out, change);
  const lines = [`BUDGET: ${parts.join(' ')} by=${o.by}`];
  if (state.stop) lines.push(`NEXT: gstack-autoplan resume --out ${state.out}`);
  return lines;
}

/** Reservations with no dispatch journaled (a crash between reserve and journal) are proven never dispatched, so released. */
export function releaseUndispatched(state: RunState): string[] {
  const file = path.join(state.out, FILES.spend);
  const dispatched = new Set(readJournal(state.out).filter(r => r.event === 'dispatched').map(r => r.attempt));
  return readLedger(file).reserved.filter(r => !dispatched.has(r.attempt)).map(r => {
    release(file, r.attempt);
    journal(state.out, { event: 'released_undispatched', attempt: r.attempt, estimate_usd: r.estimate_usd });
    return `RELEASED: ${r.attempt} (never dispatched)`;
  });
}

export const pendingDeltas = (state: RunState) => (state.capped_deltas ?? []).filter(d => d.status === 'pending');

/**
 * The owner's answers to cap items (deferred closes, deferred blockers, capped deltas) once the plan proceeds:
 * `b` grants that phase one more round, journaled as a budget change, and adds it to the reopen set; Eng, which
 * reruns last, gets its own grant unless it already has one;
 * `a` accepts. Capped deltas record which.
 */
export function applyCapChoices(state: RunState, choices: Array<{ item: GateItem; chosen: string }>, reopen: Set<string>, by: string | undefined): string[] {
  const lines: string[] = [];
  const granted = new Set<string>();
  for (const { item, chosen } of choices) {
    const cap = item.cap;
    if (!cap) continue;
    const reopens = chosen === 'b';
    for (const d of pendingDeltas(state)) if (d.phase === cap.phase && (cap.kind !== 'delta' || String(d.k) === cap.ref)) { d.status = reopens ? 'reopened' : 'accepted'; d.decided_at = now(); }
    if (!reopens || granted.has(cap.phase)) continue;
    granted.add(cap.phase);
    (state.round_grants ??= {})[cap.phase] = (state.round_grants[cap.phase] ?? 0) + 1;
    journal(state.out, { event: 'budget_changed', by: by ?? 'gate', round_grant: { phase: cap.phase, cap: roundCap(state, cap.phase) }, item: item.id });
    reopen.add(cap.phase);
    lines.push(`ROUND_GRANTED: ${cap.phase} cap=${roundCap(state, cap.phase)} (${item.id}b by ${by ?? 'gate'})`);
    if (cap.phase === 'eng' || !state.phase_order.includes('eng') || granted.has('eng')) continue;
    granted.add('eng');
    state.round_grants.eng = (state.round_grants.eng ?? 0) + 1;
    journal(state.out, { event: 'budget_changed', by: by ?? 'gate', round_grant: { phase: 'eng', cap: roundCap(state, 'eng') }, item: item.id, reason: `eng reruns after ${cap.phase}` });
    reopen.add('eng');
    lines.push(`ROUND_GRANTED: eng cap=${roundCap(state, 'eng')} (reruns after ${cap.phase}; ${item.id}b by ${by ?? 'gate'})`);
  }
  return lines;
}
