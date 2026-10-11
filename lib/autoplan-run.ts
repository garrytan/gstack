/**
 * autoplan-run — the unattended /autoplan loop as an explicit, durable state
 * machine (plan B2). The run directory the parent chose (`--out`) holds
 * `run.json` (the B0 manifest, extended with the runner's state), an
 * append-only `attempts.jsonl` journal (dispatch intent before anything
 * else, so a crash is reconcilable), `run.lock` (one writer at a time),
 * `spend.json` (lib/spend-ledger.ts) and every prompt, result and consensus
 * file. `next` prepares the current phase (snapshot, prompts), journals one
 * attempt per pending voice and stops with `awaiting_result`; `submit` binds
 * a reviewer's result (receipt, canonical findings, model family) exactly
 * once, settles its reservation and closes the phase through reconciliation
 * (lib/autoplan-gate.ts) when both voices are terminal; `resume` takes
 * ownership and marks attempts with intent but no terminal record
 * EXECUTION_UNKNOWN, never redispatching them on its own. Thin bin:
 * bin/gstack-autoplan.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { canonicalRows, parseReviewResult } from './autoplan-reconcile';
import { closePhase, finishGate } from './autoplan-gate';
import { PHASES, SNAPSHOT_TOOL, detectScope, extractHeading, phaseOrder, reviewSkillFile, sectionLoadFor, snapshotTool, writePrompts, type Phase, type Scope, type ScopeFlags } from './autoplan-prompts';
import { FILES, RunError, journal, now, readJournal, readState, writeState, type AttemptState, type PhaseState, type RunState, type Voice, type VoiceState } from './autoplan-state';
import type { RunStatus } from './headless-artifacts';
import { sha256File } from './headless-artifacts';
import { familyConflict, modelFamily } from './outside-voice-runner';
import { renderSpend, reserve, settle, summarize, readLedger } from './spend-ledger';

/** Exclusive ownership for one command: a lock whose pid is alive is never stolen; a dead pid's lock is reclaimed. */
export function withRunLock<T>(out: string, fn: () => T, opts: { steal?: boolean } = {}): T {
  fs.mkdirSync(out, { recursive: true });
  const lock = path.join(out, FILES.lock);
  const mine = JSON.stringify({ pid: process.pid, host: os.hostname(), at: now() });
  for (let i = 0; ; i++) {
    try {
      const fd = fs.openSync(lock, 'wx');
      fs.writeSync(fd, mine);
      fs.closeSync(fd);
      break;
    } catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
      let owner: { pid?: number; host?: string; at?: string } = {};
      try { owner = JSON.parse(fs.readFileSync(lock, 'utf8')); } catch { /* unreadable: treat as stale below */ }
      let alive = false;
      if (owner.host === os.hostname() && typeof owner.pid === 'number') {
        try { process.kill(owner.pid, 0); alive = true; } catch (k: any) { alive = k.code === 'EPERM'; }
      } else if (owner.host && owner.host !== os.hostname()) alive = !opts.steal;
      if (alive) throw new RunError('RUN_LOCKED', `pid ${owner.pid} on ${owner.host} since ${owner.at}`, 3);
      try { fs.unlinkSync(lock); } catch { /* raced with its owner's exit */ }
      if (i > 50) throw new RunError('RUN_LOCKED', `could not reclaim ${lock}`, 3);
    }
  }
  try { return fn(); } finally { try { if (fs.readFileSync(lock, 'utf8') === mine) fs.unlinkSync(lock); } catch { /* already gone */ } }
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------
export interface InitOptions { plan: string; out: string; cwd: string; scope?: ScopeFlags; planHeading?: string; outsideEnabled?: boolean; spendCap?: number | null; sessionKind?: string; deadlineMin?: number; light?: boolean; runId?: string }

export function initRun(o: InitOptions): RunState {
  const out = path.resolve(o.out);
  fs.mkdirSync(out, { recursive: true });
  let source = path.resolve(o.plan);
  if (!fs.existsSync(source)) throw new Error(`plan not found: ${source}`);
  if (o.planHeading) {
    const section = extractHeading(fs.readFileSync(source, 'utf8'), o.planHeading);
    if (section === undefined) throw new Error(`heading ${JSON.stringify(o.planHeading)} not found in ${source}`);
    source = path.join(out, FILES.source);
    fs.writeFileSync(source, section);
  }
  const active = path.join(out, FILES.active);
  const restore = path.join(out, FILES.restore);
  const init = snapshotTool(['init', source, active, restore], o.cwd);
  const scope = detectScope(active, o.cwd, o.scope ?? {});
  const order = phaseOrder(scope);
  const run = o.runId ?? `${path.basename(out)}-${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`;
  const phases: Record<string, PhaseState> = {};
  for (const p of PHASES) if (!order.includes(p)) phases[p] = { skipped: p === 'design' ? 'no UI scope detected' : 'no developer-facing scope detected', native: { status: 'skipped' }, outside: { status: 'skipped' } };
  const state: RunState = {
    schema_version: 1, run, status: 'running', required_phases: order, phases, artifacts: {}, revision: 0, out,
    plan_source: init.sourcePlan, active_plan: init.activePlan, restore: init.restorePath, scope, phase_order: order,
    outside_enabled: o.outsideEnabled ?? true, attempt_counter: 0, spend_cap_usd: o.spendCap ?? null,
    session_kind: o.sessionKind ?? process.env.GSTACK_SESSION_KIND ?? 'unattended', host: 'gstack-autoplan', history: [], created_at: now(), updated_at: now(),
    deviations: ['autoplan guard: not enforced by this host; publication order is unverified (GUARD_NOT_INSTALLED)'],
    ...(o.deadlineMin ? { deadline_at: new Date(Date.now() + o.deadlineMin * 60_000).toISOString() } : {}),
    ...(o.light ? { light: true } : {}),
  };
  fs.writeFileSync(path.join(out, 'timing.json'), JSON.stringify({ schema_version: 1, run, phases: [], started_at: now(), session_kind: state.session_kind }, null, 2) + '\n');
  journal(out, { event: 'init', run, plan_source: source, scope, phase_order: order });
  writeState(state);
  return state;
}

// ---------------------------------------------------------------------------
// next
// ---------------------------------------------------------------------------
export function currentPhase(state: RunState): Phase | undefined {
  return state.phase_order.find(p => !state.phases[p]?.closed_at);
}
export function voiceState(state: RunState, phase: Phase, voice: Voice): VoiceState {
  const ps = (state.phases[phase] ??= {});
  return (ps[voice] ??= { status: 'pending' });
}
const openAttempt = (v: VoiceState) => v.attempts?.find(a => a.state === 'dispatched' || a.state === 'execution_unknown');

export interface NextOptions { out: string; cwd: string; estimateUsd?: number; redispatch?: string[] }
export interface NextResult { state: RunState; phase?: Phase; attempts: Array<{ attempt: string; voice: Voice; prompt: string; result: string; model_family: string; new: boolean }>; lines: string[] }

function openPhase(state: RunState, phase: Phase, cwd: string): void {
  const ps = (state.phases[phase] ??= {});
  if (ps.snapshot) return;
  const methodology = snapshotTool(['methodology', phase, reviewSkillFile(phase), state.restore], cwd);
  const snap = snapshotTool(['create', phase, state.active_plan, state.restore, methodology.methodologyPath], cwd);
  const prior: Array<{ phase: string; text: string }> = [];
  if (phase === 'eng') {
    for (const p of state.phase_order) {
      if (p === 'eng' || !state.phases[p]?.closed_at) continue;
      const file = path.join(state.out, `${p}-consensus.md`);
      if (!fs.existsSync(file)) throw new RunError('CONSENSUS_MISSING', `${p} closed without ${p}-consensus.md`, 3);
      prior.push({ phase: p, text: fs.readFileSync(file, 'utf8') });
    }
  }
  const sections = sectionLoadFor(phase, state.scope, state.session_kind === 'unattended' || state.light ? 'light' : 'full');
  const prompts = writePrompts({ phase, snapshot: { nativePrompt: snap.nativePrompt, snapshotPath: snap.snapshotPath, sha256: snap.sha256 }, outDir: state.out, priorConsensus: prior, sections });
  ps.snapshot = snap.sha256; ps.snapshot_dir = path.dirname(snap.snapshotPath); ps.snapshot_path = snap.snapshotPath; ps.methodology = methodology.methodologyPath; ps.opened_at = now();
  ps.sections = { loaded: sections.loaded, skipped: sections.skipped, checklist: !!sections.checklist };
  ps.native = { status: 'pending', attempts: [] };
  ps.outside = state.outside_enabled ? { status: 'pending', attempts: [] } : { status: 'disabled' };
  ps.prompts = prompts;
  journal(state.out, { event: 'phase_opened', phase, snapshot: snap.sha256, prompts });
}

export function nextStep(o: NextOptions): NextResult {
  const state = readState(path.resolve(o.out));
  const lines: string[] = [];
  const result: NextResult = { state, attempts: [], lines };
  if (state.status === 'gate_pending' || state.status === 'complete' || state.status === 'incomplete' || state.status === 'refused') return result;
  if (state.deadline_at && Date.parse(state.deadline_at) < Date.now()) { state.status = 'interrupted'; writeState(state); lines.push(`DEADLINE: passed at ${state.deadline_at}`); return result; }
  const phase = currentPhase(state);
  if (!phase) { finishGate(state); writeState(state); return result; }
  openPhase(state, phase, o.cwd);
  const ps = state.phases[phase]!;
  result.phase = phase;
  lines.push(`PHASE: ${phase} snapshot=${ps.snapshot} order=${state.phase_order.join(',')}`);
  if (ps.sections) lines.push(`Skipped sections: ${ps.sections.skipped.length ? ps.sections.skipped.join(',') : 'none'} (scope: ui=${state.scope.ui ? 'yes' : 'no'},dx=${state.scope.dx ? 'yes' : 'no'},source=${state.scope.source}; checklist=${ps.sections.checklist ? 'loaded' : 'none'})`);
  const prompts = ps.prompts!;
  for (const voice of ['native', 'outside'] as const) {
    const v = voiceState(state, phase, voice);
    if (v.status === 'completed' || v.status === 'disabled' || v.status === 'skipped') continue;
    const open = openAttempt(v);
    if (open?.state === 'execution_unknown') {
      if (!o.redispatch?.includes(open.attempt)) throw new RunError('EXECUTION_UNKNOWN', `${open.attempt} (${phase} ${voice})`, 3);
      open.state = 'superseded'; open.terminal_at = now();
      settle(path.join(state.out, FILES.spend), open.attempt, 'unknown');
      journal(state.out, { event: 'superseded', attempt: open.attempt, phase, voice });
    } else if (open) {
      result.attempts.push({ attempt: open.attempt, voice, prompt: open.prompt, result: open.result, model_family: familyHint(state, voice), new: false });
      continue;
    }
    const attempt = `${state.run}-a${++state.attempt_counter}`;
    const estimate = o.estimateUsd ?? 0;
    try { reserve(path.join(state.out, FILES.spend), attempt, estimate, { cap: state.spend_cap_usd, label: `${phase}/${voice}` }); }
    catch (e: any) { if (e.code === 'SPEND_CAP_EXCEEDED') { state.attempt_counter--; writeState(state); throw new RunError('SPEND_CAP_EXCEEDED', e.message, 3); } throw e; }
    const row: AttemptState = { attempt, state: 'dispatched', prompt: prompts[voice], result: prompts[voice === 'native' ? 'nativeResult' : 'outsideResult'], estimate_usd: estimate, dispatched_at: now() };
    journal(state.out, { event: 'dispatched', attempt, phase, voice, snapshot: ps.snapshot, prompt: row.prompt, prompt_sha256: sha256File(row.prompt), result: row.result, estimate_usd: estimate });
    (v.attempts ??= []).push(row);
    v.attempt = attempt; v.status = 'running';
    result.attempts.push({ attempt, voice, prompt: row.prompt, result: row.result, model_family: familyHint(state, voice), new: true });
  }
  state.status = 'awaiting_result';
  writeState(state);
  for (const a of result.attempts) lines.push(`ATTEMPT: ${a.attempt} phase=${phase} voice=${a.voice} prompt=${a.prompt} result=${a.result} model_family=${a.model_family}${a.new ? '' : ' (open)'}`);
  lines.push(renderSpend(summarize(readLedger(path.join(state.out, FILES.spend)))));
  return result;
}
function familyHint(state: RunState, voice: Voice): string {
  if (voice === 'native') return state.native_model ? `same as ${state.native_model}` : 'the parent’s own model (recorded at submit)';
  return state.native_model ? `not ${modelFamily(state.native_model)}` : 'differs from the native reviewer';
}

// ---------------------------------------------------------------------------
// submit
// ---------------------------------------------------------------------------
export interface SubmitOptions { out: string; phase: string; voice: Voice; result: string; model: string; attempt: string; runner?: string; usageUsd?: number; reconcile?: string; cwd: string }
export interface SubmitResult { state: RunState; closed: boolean; findings: number; lines: string[] }

export function submitResult(o: SubmitOptions): SubmitResult {
  const state = readState(path.resolve(o.out));
  if (!(PHASES as readonly string[]).includes(o.phase)) throw new RunError('PHASE_NOT_AWAITING', `${o.phase} is not a phase`, 3);
  const phase = o.phase as Phase;
  const ps = state.phases[phase];
  const v = ps?.[o.voice];
  if (!ps?.snapshot || !v || ps.closed_at || v.status === 'completed' || v.status === 'disabled' || v.status === 'skipped') throw new RunError('PHASE_NOT_AWAITING', `${phase} ${o.voice} is ${v?.status ?? 'not opened'}`, 3);
  const open = openAttempt(v);
  if (!open || open.attempt !== o.attempt) throw new RunError('ATTEMPT_MISMATCH', `${o.attempt} is not the open attempt for ${phase} ${o.voice}${open ? ` (${open.attempt} is)` : ''}`, 3);
  if (!fs.existsSync(o.result)) throw new RunError('RESULT_RECEIPT_MISSING', `result file not found: ${o.result}`);
  const text = fs.readFileSync(o.result, 'utf8');
  const parsed = parseReviewResult(text, { phase, sha256: ps.snapshot });
  if (!parsed.receipt.ok) throw new RunError('RESULT_RECEIPT_MISSING', parsed.errors[0]!);
  if (!parsed.fenceFound || parsed.errors.length) throw new RunError('RESULT_FINDINGS_MISSING', parsed.errors.join('; '));
  let conflict: string | undefined;
  if (o.voice === 'outside') conflict = familyConflict(o.model, state.native_model);
  else if (state.outside_model) conflict = familyConflict(state.outside_model, o.model);
  else if (modelFamily(o.model) === 'unknown') conflict = `native model ${JSON.stringify(o.model)} has no recognized family`;
  if (conflict) throw new RunError('MODEL_FAMILY_CONFLICT', conflict, 3);

  // Bind: immutable copy, per-voice canonical rows, journal, ledger, manifest. Nothing above this line wrote.
  const bound = open.result;
  const tmp = `${bound}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, bound);
  const rows = canonicalRows(parsed.findings, { run: state.run, phase, voice: o.voice, model: o.model });
  fs.writeFileSync(`${bound}.findings.jsonl`, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  const sha = sha256File(bound);
  journal(state.out, { event: 'submitted', attempt: o.attempt, phase, voice: o.voice, result: bound, result_sha256: sha, model: o.model, runner: o.runner ?? null, findings: rows.length, usage_usd: o.usageUsd ?? 'unknown' });
  settle(path.join(state.out, FILES.spend), o.attempt, o.usageUsd ?? 'unknown');
  open.state = 'submitted'; open.terminal_at = now();
  Object.assign(v, { status: 'completed', model: o.model, provider: o.runner ?? (o.voice === 'native' ? 'host-subagent' : 'unknown'), output: path.basename(bound), result_sha256: sha, findings: rows.length, attempt: o.attempt, usage: { usd: o.usageUsd ?? 'unknown' } } satisfies Partial<VoiceState>);
  state.artifacts[path.basename(bound)] = { path: path.basename(bound), sha256: sha };
  if (o.voice === 'native') state.native_model = o.model; else state.outside_model = o.model;
  const lines = [`BOUND: ${o.attempt} phase=${phase} voice=${o.voice} model=${o.model} findings=${rows.length} sha256=${sha.slice(0, 12)}`];
  const outsideTerminal = ['completed', 'disabled', 'unavailable', 'failed', 'skipped'].includes(String(ps.outside?.status));
  const closed = ps.native?.status === 'completed' && outsideTerminal;
  if (closed) {
    const close = closePhase(state, phase, { overridesFile: o.reconcile });
    lines.push(`PHASE_CLOSED: ${phase} confirmed=${close.consensus.confirmed} disagree=${close.consensus.disagree} new=${close.consensus.new} native_only=${close.consensus.native_only} coverage=${close.consensus.coverage}`);
    if (!currentPhase(state)) finishGate(state); else state.status = 'running';
  } else state.status = 'awaiting_result';
  writeState(state);
  return { state, closed, findings: rows.length, lines };
}

/** Mark the outside voice of the current phase unavailable/failed (the runner could not run); closes the phase if native is bound. */
export function markOutside(out: string, phase: Phase, status: 'unavailable' | 'failed', detail: string): RunState {
  const state = readState(out);
  const v = voiceState(state, phase, 'outside');
  const open = openAttempt(v);
  if (open) { open.state = 'cancelled'; open.terminal_at = now(); settle(path.join(out, FILES.spend), open.attempt, 'unknown'); }
  Object.assign(v, { status, detail });
  journal(out, { event: 'outside_' + status, phase, detail });
  if (state.phases[phase]?.native?.status === 'completed') {
    closePhase(state, phase, {});
    if (!currentPhase(state)) finishGate(state); else state.status = 'running';
  }
  writeState(state);
  return state;
}

// ---------------------------------------------------------------------------
// resume
// ---------------------------------------------------------------------------
export interface ResumeResult { state: RunState; unknown: string[]; rebound: string[]; lines: string[] }

export function resumeRun(out: string): ResumeResult {
  const state = readState(out);
  const rows = readJournal(out);
  const terminal = new Set(rows.filter(r => ['submitted', 'cancelled', 'superseded'].includes(r.event)).map(r => r.attempt));
  const unknown: string[] = [];
  const rebound: string[] = [];
  for (const r of rows) {
    if (r.event !== 'dispatched') continue;
    const ps = state.phases[r.phase];
    const v = ps?.[r.voice as Voice];
    const a = v?.attempts?.find(x => x.attempt === r.attempt);
    if (terminal.has(r.attempt)) {
      // A submit that journaled but died before run.json: re-bind from the journal and the file on disk.
      const sub = rows.find(x => x.event === 'submitted' && x.attempt === r.attempt);
      if (sub && a && a.state !== 'submitted' && fs.existsSync(sub.result) && sha256File(sub.result) === sub.result_sha256) {
        a.state = 'submitted'; a.terminal_at = sub.ts;
        Object.assign(v!, { status: 'completed', model: sub.model, provider: sub.runner ?? 'unknown', output: path.basename(sub.result), result_sha256: sub.result_sha256, findings: sub.findings, attempt: sub.attempt });
        state.artifacts[path.basename(sub.result)] = { path: path.basename(sub.result), sha256: sub.result_sha256 };
        if (r.voice === 'native') state.native_model = sub.model; else state.outside_model = sub.model;
        rebound.push(r.attempt);
      }
      continue;
    }
    if (!a) { (v!.attempts ??= []).push({ attempt: r.attempt, state: 'execution_unknown', prompt: r.prompt, result: r.result, estimate_usd: r.estimate_usd ?? 0, dispatched_at: r.ts }); v!.status = 'running'; }
    else if (a.state === 'dispatched') a.state = 'execution_unknown';
    else continue;
    journal(out, { event: 'execution_unknown', attempt: r.attempt, phase: r.phase, voice: r.voice, by: 'resume' });
    unknown.push(r.attempt);
  }
  for (const phase of state.phase_order) {
    const ps = state.phases[phase];
    if (!ps?.snapshot || ps.closed_at) continue;
    const outsideTerminal = ['completed', 'disabled', 'unavailable', 'failed', 'skipped'].includes(String(ps.outside?.status));
    if (ps.native?.status === 'completed' && outsideTerminal) closePhase(state, phase, {});
  }
  if (!currentPhase(state) && !['gate_pending', 'complete', 'incomplete', 'refused'].includes(state.status)) finishGate(state);
  else if (state.status === 'interrupted' || state.status === 'running' || state.status === 'awaiting_result') {
    const anyOpen = state.phase_order.some(p => (['native', 'outside'] as const).some(v => openAttempt(voiceState(state, p, v))));
    state.status = anyOpen ? 'awaiting_result' : 'running';
  }
  journal(out, { event: 'resumed', unknown, rebound, status: state.status });
  writeState(state);
  const lines = [`RESUMED: run=${state.run} status=${state.status} execution_unknown=${unknown.length} rebound=${rebound.length}`];
  for (const a of unknown) lines.push(`EXECUTION_UNKNOWN: ${a}`);
  return { state, unknown, rebound, lines };
}

export function statusLines(state: RunState): string[] {
  const lines = [`RUN: ${state.run} status=${state.status} revision=${state.revision} out=${state.out}`, `SCOPE: ui=${state.scope.ui} dx=${state.scope.dx} order=${state.phase_order.join(',')} gate_rev=${state.gate_rev ?? 0}`];
  for (const p of PHASES) {
    const ps = state.phases[p];
    if (!ps) { lines.push(`PHASE: ${p} pending`); continue; }
    if (ps.skipped) { lines.push(`PHASE: ${p} skipped (${ps.skipped})`); continue; }
    const v = (voice: Voice) => { const s = ps[voice]; return `${voice}=${s?.status ?? 'pending'}${s?.model ? `:${s.model}` : ''}${s?.attempt ? `@${s.attempt}` : ''}`; };
    lines.push(`PHASE: ${p} ${ps.closed_at ? 'closed' : ps.snapshot ? 'open' : 'pending'} ${v('native')} ${v('outside')}${ps.consensus ? ` confirmed=${(ps.consensus as any).confirmed} disagree=${(ps.consensus as any).disagree} new=${(ps.consensus as any).new}` : ''}`);
  }
  if (fs.existsSync(path.join(state.out, FILES.spend))) lines.push(renderSpend(summarize(readLedger(path.join(state.out, FILES.spend)))));
  return lines;
}
export const TERMINAL: readonly RunStatus[] = ['complete', 'gate_pending', 'incomplete', 'refused', 'interrupted'];
export { SNAPSHOT_TOOL, RunError, FILES, readState, writeState, readJournal, journal };
export type { RunState, Voice, VoiceState, AttemptState };
