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
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { canonicalRows, parseReceipt, parseRecordFindings, parseReviewResult, type CanonicalFinding } from './autoplan-reconcile';
import { amendmentSteps, applyGuidance, closeDeferred, closePhase, finishGate } from './autoplan-gate';
import { carryLines } from './autoplan-carry';
import { GSTACK_VERSION } from './autoplan-migrate';
import { driftLine, normalizeFindingFile, reviewHash, scaffold } from './autoplan-plan-text';
import { PHASES, SNAPSHOT_TOOL, attemptFile, bindPromptResult, detectScope, driverFile, extractHeading, phaseOrder, reviewSkillFile, scopeLines, scopeSourceLabel, sectionLoadFor, snapshotTool, writePrompts, type Phase, type Scope, type ScopeFlags } from './autoplan-prompts';
import { recoverRevise } from './autoplan-revise';
import { FILES, RunError, journal, now, pendingAmendments, readDecisions, readJournal, readState, voiceTerminal, writeState, type AttemptState, type PhaseState, type RunState, type Voice, type VoiceState } from './autoplan-state';
import { checkPlanReality, checkRealityRows, PLAN_REALITY_CHECKER } from './plan-reality';
import type { RunStatus } from './headless-artifacts';
import { sha256File } from './headless-artifacts';
import { outsideConsent } from './outside-consent';
import { familyConflict, modelFamily } from './outside-voice-runner';
import { renderSpend, reserve, settle, summarize, readLedger } from './spend-ledger';
import { DEFAULT_MAX_ROUNDS, attemptEstimate, overCap, resumeStop, roundCap, roundOf, roundsLine, stopForBudget, stopLines } from './autoplan-budget';
import { annotateConfirm, confirmBlock } from './autoplan-confirm';

/** An unreadable run.lock younger than this is a lock some other gstack is still writing, never a stale one. */
const LOCK_WRITE_GRACE_MS = 30_000;

/** Exclusive ownership for one command: a lock whose pid is alive is never stolen; a dead pid's lock is reclaimed. */
export function withRunLock<T>(out: string, fn: () => T, opts: { steal?: boolean } = {}): T {
  fs.mkdirSync(out, { recursive: true });
  const lock = path.join(out, FILES.lock);
  const mine = JSON.stringify({ pid: process.pid, host: os.hostname(), at: now() });
  const staged = `${lock}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(staged, mine);
  for (let i = 0; ; i++) {
    try {
      fs.linkSync(staged, lock);
      fs.unlinkSync(staged);
      break;
    } catch (e: any) {
      if (e.code !== 'EEXIST') { fs.rmSync(staged, { force: true }); throw e; }
      let owner: { pid?: number; host?: string; at?: string } = {};
      let unreadable = false;
      try { owner = JSON.parse(fs.readFileSync(lock, 'utf8')); } catch { unreadable = true; }
      let alive = false;
      if (unreadable) {
        try { alive = Date.now() - fs.statSync(lock).mtimeMs < LOCK_WRITE_GRACE_MS; } catch { /* gone: retry the link */ }
      } else if (owner.host === os.hostname() && typeof owner.pid === 'number') {
        try { process.kill(owner.pid, 0); alive = true; } catch (k: any) { alive = k.code === 'EPERM'; }
      } else if (owner.host && owner.host !== os.hostname()) alive = !opts.steal;
      if (alive) { fs.rmSync(staged, { force: true }); throw new RunError('RUN_LOCKED', unreadable ? `${lock} is being written by another command` : `pid ${owner.pid} on ${owner.host} since ${owner.at}`, 3); }
      try { fs.unlinkSync(lock); } catch { /* raced with its owner's exit */ }
      if (i > 50) { fs.rmSync(staged, { force: true }); throw new RunError('RUN_LOCKED', `could not reclaim ${lock}`, 3); }
    }
  }
  try { return fn(); } finally { try { if (fs.readFileSync(lock, 'utf8') === mine) fs.unlinkSync(lock); } catch { /* already gone */ } }
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------
export interface InitOptions { plan: string; out: string; cwd: string; scope?: ScopeFlags; planHeading?: string; outsideEnabled?: boolean; spendCap?: number | null; sessionKind?: string; deadlineMin?: number; light?: boolean; runId?: string; scaffold?: boolean; maxRounds?: number; carryForward?: boolean; carryCheckCapUsd?: number }

/** `lines` receives what init itself reports (SCAFFOLDED:). A plan with one section heading missing refuses, or with `scaffold` is reviewed from a scaffolded copy. */
export function initRun(o: InitOptions, lines: string[] = []): RunState {
  const out = path.resolve(o.out);
  const input = path.resolve(o.plan);
  let source = input;
  if (!fs.existsSync(source)) throw new Error(`plan not found: ${source}`);
  let scaffolded = false;
  if (o.planHeading) {
    const section = extractHeading(fs.readFileSync(source, 'utf8'), o.planHeading);
    if (section === undefined) throw new Error(`heading ${JSON.stringify(o.planHeading)} not found in ${source}`);
    fs.mkdirSync(out, { recursive: true });
    source = path.join(out, FILES.source);
    fs.writeFileSync(source, section);
  } else {
    const diag = scaffold(fs.readFileSync(source, 'utf8'));
    if (diag.problem && (!o.scaffold || !diag.text)) throw new RunError('PLAN_SECTIONS_INVALID', `${source}: ${diag.problem}`, 3);
    if (diag.text) {
      fs.mkdirSync(out, { recursive: true });
      source = path.join(out, FILES.source);
      fs.writeFileSync(source, diag.text);
      scaffolded = true;
      lines.push(`SCAFFOLDED: added "${diag.added}" (copy at ${source}; ${input} unchanged)`);
    }
  }
  fs.mkdirSync(out, { recursive: true });
  const active = path.join(out, FILES.active);
  const restore = path.join(out, FILES.restore);
  const init = snapshotTool(['init', source, active, restore], o.cwd);
  const scope = detectScope(active, o.cwd, o.scope ?? {}, path.resolve(o.plan));
  const order = phaseOrder(scope);
  const run = o.runId ?? `${path.basename(out)}-${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`;
  // codex_reviews gates the outside voice here, before any dispatch: a refusal is a terminal not_run outcome per phase.
  const consent = (o.outsideEnabled ?? true) ? outsideConsent({ userInvoked: false }) : undefined;
  const consentMissing = consent && !consent.allowed ? consent.lines[0] : undefined;
  const sessionKind = o.sessionKind ?? process.env.GSTACK_SESSION_KIND ?? 'unattended';
  const phases: Record<string, PhaseState> = {};
  for (const p of PHASES) if (!order.includes(p)) phases[p] = { skipped: scope.docs_only ? 'docs-only plan' : p === 'design' ? 'no UI scope detected' : 'no developer-facing scope detected', native: { status: 'skipped' }, outside: { status: 'skipped' } };
  const state: RunState = {
    schema_version: 1, run, status: 'running', required_phases: order, phases, artifacts: {}, revision: 0, out,
    plan_source: init.sourcePlan, active_plan: init.activePlan, restore: init.restorePath, scope, phase_order: order,
    outside_enabled: (o.outsideEnabled ?? true) && !consentMissing, attempt_counter: 0, spend_cap_usd: o.spendCap ?? null,
    ...(consentMissing ? { outside_not_run: { reason: 'consent_missing', detail: consentMissing } } : {}),
    session_kind: sessionKind, host: 'gstack-autoplan', max_rounds: o.maxRounds ?? (sessionKind === 'unattended' ? DEFAULT_MAX_ROUNDS : null), history: [], created_at: now(), updated_at: now(),
    deviations: ['autoplan guard: not enforced by this host; publication order is unverified (GUARD_NOT_INSTALLED)'],
    ...(o.deadlineMin ? { deadline_at: new Date(Date.now() + o.deadlineMin * 60_000).toISOString() } : {}),
    ...(o.light ? { light: true } : {}),
    gstack_version: GSTACK_VERSION, plan_input: input, scope_flags: { ...(o.scope ?? {}) },
    ...(o.planHeading ? { plan_heading: o.planHeading } : {}), ...(scaffolded ? { scaffolded: true } : {}),
    ...(o.carryForward === false ? { carry_forward: false } : {}), ...(o.carryCheckCapUsd !== undefined ? { carry_check_cap_usd: o.carryCheckCapUsd } : {}),
  };
  fs.writeFileSync(path.join(out, 'timing.json'), JSON.stringify({ schema_version: 1, run, phases: [], started_at: now(), session_kind: state.session_kind }, null, 2) + '\n');
  journal(out, { event: 'init', run, plan_source: source, scope, phase_order: order, ...(consentMissing ? { outside: 'not_run', reason: 'consent_missing' } : {}) });
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
  // Every later phase reviews with its closed predecessors' consensus as data
  // (not only Eng): a DX or design reviewer who never saw the CEO consensus
  // re-raises what the CEO phase already reconciled (field gate rev 2).
  const prior: Array<{ phase: string; text: string }> = [];
  for (const p of state.phase_order) {
    if (p === phase) break;
    if (!state.phases[p]?.closed_at) continue;
    const file = path.join(state.out, `${p}-consensus.md`);
    if (!fs.existsSync(file)) throw new RunError('CONSENSUS_MISSING', `${p} closed without ${p}-consensus.md`, 3);
    prior.push({ phase: p, text: fs.readFileSync(file, 'utf8') });
  }
  const sections = sectionLoadFor(phase, state.scope, state.session_kind === 'unattended' || state.light ? 'light' : 'full');
  const decided = (state.gate_rev ?? 0) >= 1 ? readDecisions(state.out).filter(r => r.chosen != null && r.status !== 'pending')
    .map(r => `r${r.gate_rev} ${(r.label ?? r.id).toLowerCase()}${r.chosen} ${r.title}${r.chosen_text ? ` -> ${r.chosen_text}` : ''}`) : [];
  const confirm = confirmBlock(state, phase, snap.snapshotPath, roundOf(state, phase));
  const prompts = writePrompts({ phase, snapshot: { nativePrompt: snap.nativePrompt, snapshotPath: snap.snapshotPath, sha256: snap.sha256 }, outDir: state.out, priorConsensus: prior, sections, decided, confirm: confirm?.text });
  if (confirm) ps.confirm = confirm.confirm;
  ps.snapshot = snap.sha256; ps.snapshot_dir = path.dirname(snap.snapshotPath); ps.snapshot_path = snap.snapshotPath; ps.methodology = methodology.methodologyPath; ps.opened_at = now();
  ps.sections = { loaded: sections.loaded, skipped: sections.skipped, checklist: !!sections.checklist };
  ps.native = { status: 'pending', attempts: [] };
  const notRun = state.outside_not_run as { reason: string; detail: string } | undefined;
  ps.outside = phase === 'ceo' && state.scope.docs_only ? { status: 'disabled', outcome: 'not_run', reason: 'docs_only', detail: 'docs-only plan: CEO runs the native voice only; Eng keeps both voices' }
    : state.outside_enabled ? { status: 'pending', attempts: [] }
    : notRun ? { status: 'disabled', outcome: 'not_run', reason: notRun.reason, detail: notRun.detail } : { status: 'disabled' };
  ps.prompts = prompts;
  journal(state.out, { event: 'phase_opened', phase, snapshot: snap.sha256, prompts: Object.fromEntries(Object.entries(prompts).map(([k, p]) => [k, path.relative(state.out, p)])) });
}

/** The first next's price line: the most the review can reserve at this scope and round cap (a reservation total, not a spend ceiling). */
export function reviewEstimateLine(state: RunState, perVoiceUsd: number): string {
  const voices = state.phase_order.map(p => (!state.outside_enabled || (p === 'ceo' && state.scope.docs_only) ? 1 : 2));
  const perRound = voices.reduce((a, b) => a + b, 0);
  const rounds = state.max_rounds ?? null;
  const per = perVoiceUsd > 0 ? perVoiceUsd.toFixed(2) : 'unknown';
  const attempts = rounds === null ? `${perRound} per round, rounds uncapped` : `<=${perRound * rounds}`;
  const total = rounds === null || perVoiceUsd <= 0 ? 'unknown' : `<=${(perRound * rounds * perVoiceUsd).toFixed(2)}`;
  return `REVIEW_ESTIMATE: phases=${state.phase_order.join(',')} voices=${voices.join('+')} rounds${rounds === null ? '=uncapped' : `<=${rounds}`} attempts${attempts.startsWith('<=') ? attempts : `=${attempts}`} per_voice=${per} reservations${total === 'unknown' ? '=unknown' : total} (a reservation total, not a spend ceiling; actual host spend stays unknown; round grants at the gate add more)`;
}

export function nextStep(o: NextOptions): NextResult {
  const state = readState(path.resolve(o.out));
  const lines: string[] = [];
  const result: NextResult = { state, attempts: [], lines };
  if (state.status === 'incomplete' && state.stop) { lines.push(...stopLines(state)); return result; }
  if (state.status === 'gate_pending' || state.status === 'complete' || state.status === 'incomplete' || state.status === 'refused') return result;
  if (state.deadline_at && Date.parse(state.deadline_at) < Date.now()) { state.status = 'interrupted'; writeState(state); lines.push(`DEADLINE: passed at ${state.deadline_at}`); return result; }
  const pending = pendingAmendments(state).map(a => a.decision);
  if (pending.length) {
    const each = pendingAmendments(state).map(a => `APPLY ${a.item ?? a.decision}: ${applyGuidance(a)}`).join('; ');
    throw new RunError('PLAN_AMEND_PENDING', `accepted at the gate but not in the plan: ${pending.join(', ')} (${each}); ${amendmentSteps(state, state.out)} (or --withdraw <id>)`, 3);
  }
  let phase = currentPhase(state);
  while (phase && !state.phases[phase]?.snapshot && overCap(state, phase)) {
    lines.push(...closeDeferred(state, phase, { reason: `round cap: round ${roundOf(state, phase)} would pass max ${roundCap(state, phase)}`, by: 'runner', cause: 'cap' }).lines);
    phase = currentPhase(state);
  }
  if (!phase) { finishGate(state); lines.push(...carryLines(state)); writeState(state); return result; }
  const first = !state.phase_order.some(p => state.phases[p]?.snapshot);
  openPhase(state, phase, o.cwd);
  const ps = state.phases[phase]!;
  result.phase = phase;
  lines.push(`PHASE: ${phase} snapshot=${ps.snapshot} order=${state.phase_order.join(',')}`);
  const drift = driftLine(state, 'PLAN_CHANGED');
  if (drift) lines.push(drift);
  if (first) lines.push(...scopeLines(state.scope), `DRIVER: ${driverFile()}`);
  if (ps.outside?.reason === 'consent_missing') lines.push(`OUTSIDE: ${phase} not_run reason=consent_missing`, String(ps.outside.detail));
  if (ps.outside?.reason === 'docs_only') lines.push(`OUTSIDE: ${phase} not_run reason=docs_only (native voice only)`);
  if (ps.sections) lines.push(`Skipped sections: ${ps.sections.skipped.length ? ps.sections.skipped.join(',') : 'none'} (scope: ui=${state.scope.ui ? 'yes' : 'no'},dx=${state.scope.dx ? 'yes' : 'no'},source=${scopeSourceLabel(state.scope)}; checklist=${ps.sections.checklist ? 'loaded' : 'none'})`);
  const prompts = ps.prompts!;
  const estimate = attemptEstimate(state, o.estimateUsd, process.env);
  if (estimate.line) lines.push(estimate.line);
  if (first) lines.push(reviewEstimateLine(state, estimate.usd));
  const fresh = (['native', 'outside'] as const).filter(voice => { const v = voiceState(state, phase!, voice); const open = openAttempt(v); return !voiceTerminal(v) && (!open || (open.state === 'execution_unknown' && o.redispatch?.includes(open.attempt))); });
  const before = summarize(readLedger(path.join(state.out, FILES.spend), state.spend_cap_usd));
  if (state.spend_cap_usd !== null && fresh.length && before.worst_case_usd + fresh.length * estimate.usd > state.spend_cap_usd + 1e-9) {
    const stop = stopForBudget(state, phase, fresh.length * estimate.usd);
    writeState(state);
    throw new RunError('SPEND_CAP_EXCEEDED', `spent ${before.spent_usd} + reserved ${before.reserved_usd} + unknown ${before.unknown_usd} + ${fresh.length} x estimate ${estimate.usd} > cap ${state.spend_cap_usd}; the run stopped incomplete (budget_exhausted)`, 3, { status: 'incomplete', lines: [...lines, ...stop] });
  }
  for (const voice of ['native', 'outside'] as const) {
    const v = voiceState(state, phase, voice);
    if (voiceTerminal(v)) continue;
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
    try { reserve(path.join(state.out, FILES.spend), attempt, estimate.usd, { cap: state.spend_cap_usd, label: `${phase}/${voice}` }); }
    catch (e: any) { if (e.code === 'SPEND_CAP_EXCEEDED') { state.attempt_counter--; writeState(state); throw new RunError('SPEND_CAP_EXCEEDED', e.message, 3); } throw e; }
    const row: AttemptState = { attempt, state: 'dispatched', prompt: prompts[voice], result: path.join(state.out, attemptFile(phase, voice, attempt.slice(state.run.length + 1), 'md')), estimate_usd: estimate.usd, dispatched_at: now() };
    bindPromptResult(row.prompt, row.result);
    journal(state.out, { event: 'dispatched', attempt, phase, voice, snapshot: ps.snapshot, prompt: path.relative(state.out, row.prompt), prompt_sha256: sha256File(row.prompt), prompt_bytes: fs.statSync(row.prompt).size, result: path.relative(state.out, row.result), estimate_usd: estimate.usd });
    (v.attempts ??= []).push(row);
    v.attempt = attempt; v.status = 'running';
    result.attempts.push({ attempt, voice, prompt: row.prompt, result: row.result, model_family: familyHint(state, voice), new: true });
  }
  state.status = 'awaiting_result';
  writeState(state);
  for (const a of result.attempts) lines.push(`ATTEMPT: ${a.attempt} phase=${phase} voice=${a.voice} prompt=${a.prompt} result=${a.result} model_family=${a.model_family}${a.new ? '' : ' (open)'}`);
  lines.push(renderSpend(summarize(readLedger(path.join(state.out, FILES.spend)))), roundsLine(state));
  return result;
}
function familyHint(state: RunState, voice: Voice): string {
  if (voice === 'native') return state.native_model ? `same as ${state.native_model}` : 'the parent’s own model (recorded at submit)';
  return state.native_model ? `not ${modelFamily(state.native_model)}` : 'differs from the native reviewer';
}

// ---------------------------------------------------------------------------
// submit
// ---------------------------------------------------------------------------
export interface SubmitOptions {
  out: string; phase: string; voice: Voice; model?: string; cwd: string; runner?: string; usageUsd?: number; reconcile?: string;
  /** Exactly one of: a canonical result, a hand-run record, or a terminal outside outcome. */
  result?: string; record?: string; unavailable?: string; failed?: string;
  /** Optional when exactly one attempt is open for the phase and voice; required for an attested bind. */
  attempt?: string; attest?: string;
}
export interface SubmitResult { state: RunState; closed: boolean; findings: number; lines: string[] }

/** Report-only PLAN_REALITY on the active plan, once per Implementation-plan hash and checker (revise clears it). */
function recordPlanReality(state: RunState): string[] {
  let text: string;
  try { text = fs.readFileSync(state.active_plan, 'utf8'); } catch { return []; }
  const sha = reviewHash(text);
  if (state.plan_reality?.plan_sha256 === sha && state.plan_reality.checker === PLAN_REALITY_CHECKER) return [];
  const rows = checkRealityRows(text, { phase: 'plan', sessionKind: state.session_kind });
  const plan = checkPlanReality(text, { sessionKind: state.session_kind });
  const verdict = rows.verdict !== 'complete' ? rows.verdict : plan.verdict;
  state.plan_reality = { plan_sha256: sha, checker: PLAN_REALITY_CHECKER, verdict, line: `${rows.line}; ${plan.line}` };
  journal(state.out, { event: 'plan_reality', plan_sha256: sha, checker: PLAN_REALITY_CHECKER, verdict });
  return [`${rows.line} (report only)`, `${plan.line} (report only)`, ...plan.numberLines];
}

function resolveAttempt(v: VoiceState, attempt: string | undefined, phase: string, voice: Voice): AttemptState {
  const open = openAttempt(v);
  if (!open || (attempt !== undefined && open.attempt !== attempt)) {
    throw new RunError('ATTEMPT_MISMATCH', `${attempt ?? '(none given)'} is not the open attempt for ${phase} ${voice}${open ? ` (${open.attempt} is)` : ''}`, 3);
  }
  return open;
}

/** The record's receipt and findings: a matching INPUT line binds verified; none binds only on --attest with --attempt, never across a later revise. */
function readRecord(state: RunState, phase: Phase, open: AttemptState, o: SubmitOptions, text: string): { findings: CanonicalFinding[]; source: VoiceState['findings_source']; receipt: 'verified' | 'attested' } {
  const receipt = parseReceipt(text, { phase, sha256: state.phases[phase]!.snapshot! });
  if (receipt.present && !receipt.ok) throw new RunError('RESULT_RECEIPT_MISSING', receipt.error!);
  if (!receipt.present) {
    if (!o.attest) throw new RunError('RESULT_RECEIPT_MISSING', `${o.record} has no INPUT: ${phase} <sha256> line; bind it on your word with --attest "<reason>" --attempt ${open.attempt}, or have the reviewer start with the INPUT line its prompt names`);
    if (!o.attempt) throw new RunError('ATTEMPT_MISMATCH', `an attested bind names its attempt: pass --attempt ${open.attempt}`, 3);
    const revised = readJournal(state.out).find(r => r.event === 'plan_revised' && String(r.ts) > open.dispatched_at);
    if (revised) throw new RunError('RESULT_RECEIPT_MISSING', `the plan was revised after ${open.attempt} was dispatched (${revised.ts}); an attestation cannot say which plan was read: redispatch with gstack-autoplan next --redispatch, or bind a record with the INPUT line`);
  }
  const parsed = parseRecordFindings(text);
  if (parsed.errors.length) throw new RunError('RESULT_FINDINGS_MISSING', parsed.errors.join('; '));
  return { findings: parsed.findings, source: parsed.source, receipt: receipt.present ? 'verified' : 'attested' };
}

export function submitResult(o: SubmitOptions): SubmitResult {
  const state = readState(path.resolve(o.out));
  if (!(PHASES as readonly string[]).includes(o.phase)) throw new RunError('PHASE_NOT_AWAITING', `${o.phase} is not a phase`, 3);
  const phase = o.phase as Phase;
  const ps = state.phases[phase];
  const v = ps?.[o.voice];
  if (ps?.skipped) throw new RunError('PHASE_NOT_AWAITING', `${phase} is skipped (${ps.skipped})`, 3);
  if (!ps?.snapshot) throw new RunError('PHASE_NOT_AWAITING', `${phase} has not been opened; run gstack-autoplan next --out ${state.out} first`, 3);
  if (!v || ps.closed_at || voiceTerminal(v)) throw new RunError('PHASE_NOT_AWAITING', `${phase} ${o.voice} is ${v?.status ?? 'not opened'}`, 3);
  if (o.unavailable !== undefined || o.failed !== undefined) {
    const lines = closeOutside(state, phase, o.unavailable !== undefined ? 'unavailable' : 'failed', (o.unavailable ?? o.failed)!);
    writeState(state);
    return { state, closed: !!ps.closed_at, findings: 0, lines };
  }
  const open = resolveAttempt(v, o.attempt, phase, o.voice);
  const file = (o.record ?? o.result)!;
  const owner = new RegExp(`^${phase}-${o.voice}\\.(a\\d+)\\.md$`).exec(path.basename(file));
  if (owner && path.dirname(path.resolve(file)) === state.out && `${state.run}-${owner[1]}` !== open.attempt) {
    throw new RunError('ATTEMPT_MISMATCH', `${path.basename(file)} is the result path of ${state.run}-${owner[1]}, not of the open attempt ${open.attempt} (result=${open.result})`, 3);
  }
  if (!fs.existsSync(file)) throw new RunError('RESULT_RECEIPT_MISSING', `result file not found: ${file}`);
  const text = fs.readFileSync(file, 'utf8');
  let bind: ReturnType<typeof readRecord>;
  if (o.record) bind = readRecord(state, phase, open, o, text);
  else {
    const parsed = parseReviewResult(text, { phase, sha256: ps.snapshot });
    if (!parsed.receipt.ok) throw new RunError('RESULT_RECEIPT_MISSING', parsed.errors[0]!);
    if (!parsed.fenceFound || parsed.errors.length) throw new RunError('RESULT_FINDINGS_MISSING', parsed.errors.join('; '));
    bind = { findings: parsed.findings, source: 'fence', receipt: 'verified' };
  }
  const model = o.model!;
  let conflict: string | undefined;
  if (o.voice === 'outside') conflict = familyConflict(model, state.native_model);
  else if (state.outside_model) conflict = familyConflict(state.outside_model, model);
  else if (modelFamily(model) === 'unknown') conflict = `native model ${JSON.stringify(model)} has no recognized family`;
  if (conflict) throw new RunError('MODEL_FAMILY_CONFLICT', conflict, 3);

  // Bind: a sealed copy of the reviewer's bytes under an attempt-owned name the reviewer never writes, per-voice
  // canonical rows, journal, ledger, manifest. Nothing above this line wrote; a later edit of `file` changes nothing bound.
  const bound = path.join(state.out, attemptFile(phase, o.voice, open.attempt.slice(state.run.length + 1), 'bound.md'));
  const tmp = `${bound}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, process.platform === 'win32' ? {} : { mode: 0o444 });
  fs.renameSync(tmp, bound);
  if (process.env.GSTACK_AUTOPLAN_FAULT === 'submit-after-seal') throw new Error('fault injected: submit interrupted after sealing (GSTACK_AUTOPLAN_FAULT, tests only)');
  const planFiles = [ps.snapshot_path, ps.snapshot_path && path.join(path.dirname(ps.snapshot_path), 'source-implementation.md'), state.active_plan].filter((p): p is string => !!p);
  const pathCtx = { cwd: o.cwd, planFiles, planSource: state.plan_source, planName: path.basename(state.plan_input ?? state.plan_source) };
  const round = roundOf(state, phase);
  const rows = canonicalRows(bind.findings.map(f => { const { file, line, ...rest } = f; return { ...rest, ...normalizeFindingFile({ file, line }, pathCtx) }; }), { run: state.run, phase, voice: o.voice, model, round });
  const confirm = round > 1 ? annotateConfirm(state, phase, rows, { planName: pathCtx.planName, planSource: state.plan_source, snapshotPath: ps.snapshot_path! }) : undefined;
  fs.writeFileSync(`${bound}.findings.jsonl`, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  const sha = sha256File(bound);
  const provider = o.runner ?? 'host-subagent';
  const receipt = { receipt: bind.receipt, findings_source: bind.source, reviewed_sha256: ps.snapshot, ...(bind.receipt === 'attested' ? { attest_reason: o.attest } : {}) };
  journal(state.out, { event: 'submitted', attempt: open.attempt, phase, voice: o.voice, result: path.basename(bound), result_sha256: sha, model, runner: provider, findings: rows.length, usage_usd: o.usageUsd ?? 'unknown', ...receipt });
  settle(path.join(state.out, FILES.spend), open.attempt, o.usageUsd ?? 'unknown');
  open.state = 'submitted'; open.terminal_at = now();
  Object.assign(v, { status: 'completed', model, provider, output: path.basename(bound), result_sha256: sha, findings: rows.length, attempt: open.attempt, usage: { usd: o.usageUsd ?? 'unknown' }, ...receipt } satisfies Partial<VoiceState>);
  if (bind.receipt === 'attested') (state.deviations ??= []).push(`receipt attested: ${phase} ${o.voice} ${open.attempt} bound from a hand-run record without a reviewer receipt (snapshot ${ps.snapshot.slice(0, 12)}; reason: ${o.attest})`);
  state.artifacts[path.basename(bound)] = { path: path.basename(bound), sha256: sha };
  if (o.voice === 'native') state.native_model = model; else state.outside_model = model;
  const lines = [`BOUND: ${open.attempt} phase=${phase} voice=${o.voice} model=${model} findings=${rows.length} sha256=${sha.slice(0, 12)} receipt=${bind.receipt}${confirm ? ` round=${round} correlated=${confirm.correlated} settled=${confirm.settled}` : ''}`];
  lines.push(...recordPlanReality(state));
  const closed = ps.native?.status === 'completed' && voiceTerminal(ps.outside);
  if (closed) lines.push(...closeAndAdvance(state, phase, o.reconcile));
  else state.status = 'awaiting_result';
  writeState(state);
  return { state, closed, findings: rows.length, lines };
}

function closeAndAdvance(state: RunState, phase: Phase, reconcile?: string): string[] {
  const close = closePhase(state, phase, { overridesFile: reconcile });
  const gated = !currentPhase(state);
  if (gated) finishGate(state); else state.status = 'running';
  return [`PHASE_CLOSED: ${phase} confirmed=${close.consensus.confirmed}${close.consensus.unverified ? ` unverified=${close.consensus.unverified}` : ''} disagree=${close.consensus.disagree} new=${close.consensus.new} native_only=${close.consensus.native_only} coverage=${close.consensus.coverage}`, ...(gated ? carryLines(state) : [])];
}

/**
 * Record the outside voice of `phase` unavailable or failed: its open attempt
 * is cancelled and the outcome journaled with that attempt id before the
 * manifest is written (resume replays it); closes the phase when native is bound.
 */
export function closeOutside(state: RunState, phase: Phase, status: 'unavailable' | 'failed', detail: string): string[] {
  const v = voiceState(state, phase, 'outside');
  const open = openAttempt(v);
  journal(state.out, { event: 'outside_' + status, phase, attempt: open?.attempt ?? null, detail });
  if (open) { open.state = 'cancelled'; open.terminal_at = now(); settle(path.join(state.out, FILES.spend), open.attempt, 'unknown'); }
  Object.assign(v, { status, detail });
  const lines = [`OUTSIDE: ${phase} ${status} (${detail})`];
  if (state.phases[phase]?.native?.status === 'completed') lines.push(...closeAndAdvance(state, phase));
  else if (state.status !== 'gate_pending') state.status = 'awaiting_result';
  return lines;
}

/** Mark the outside voice of the current phase unavailable/failed (the runner could not run); closes the phase if native is bound. */
export function markOutside(out: string, phase: Phase, status: 'unavailable' | 'failed', detail: string): RunState {
  const state = readState(out);
  closeOutside(state, phase, status, detail);
  writeState(state);
  return state;
}

// ---------------------------------------------------------------------------
// resume
// ---------------------------------------------------------------------------
export interface ResumeResult { state: RunState; unknown: string[]; rebound: string[]; lines: string[] }

export function resumeRun(out: string): ResumeResult {
  const recovered = recoverRevise(out);
  const state = readState(out);
  const rows = readJournal(out);
  const terminal = new Set(rows.filter(r => ['submitted', 'cancelled', 'superseded', 'outside_unavailable', 'outside_failed', 'attempt_deferred'].includes(r.event)).map(r => r.attempt));
  const unknown: string[] = [];
  const rebound: string[] = [];
  // An outside outcome journaled before its manifest write: replay it onto the attempt it names, never onto a later round.
  for (const r of rows) {
    if (r.event !== 'outside_unavailable' && r.event !== 'outside_failed') continue;
    const ps = state.phases[r.phase];
    const v = ps?.outside;
    const a = v?.attempts?.find(x => x.attempt === r.attempt);
    if (!a || !v || voiceTerminal(v) || ps.closed_at) continue;
    if (a.state === 'dispatched' || a.state === 'execution_unknown') { a.state = 'cancelled'; a.terminal_at = r.ts; }
    Object.assign(v, { status: r.event.slice('outside_'.length), detail: r.detail });
  }
  for (const r of rows) {
    if (r.event !== 'dispatched') continue;
    const ps = state.phases[r.phase];
    const v = ps?.[r.voice as Voice];
    const a = v?.attempts?.find(x => x.attempt === r.attempt);
    if (terminal.has(r.attempt)) {
      // A submit that journaled but died before run.json: re-bind from the journal and the file on disk.
      const sub = rows.find(x => x.event === 'submitted' && x.attempt === r.attempt);
      const result = sub && path.resolve(out, sub.result);
      if (sub && result && a && a.state !== 'submitted' && fs.existsSync(result) && sha256File(result) === sub.result_sha256) {
        a.state = 'submitted'; a.terminal_at = sub.ts;
        Object.assign(v!, { status: 'completed', model: sub.model, provider: sub.runner ?? 'unknown', output: path.basename(result), result_sha256: sub.result_sha256, findings: sub.findings, attempt: sub.attempt,
          ...(sub.receipt ? { receipt: sub.receipt, findings_source: sub.findings_source, reviewed_sha256: sub.reviewed_sha256, ...(sub.attest_reason ? { attest_reason: sub.attest_reason } : {}) } : {}) });
        state.artifacts[path.basename(result)] = { path: path.basename(result), sha256: sub.result_sha256 };
        if (r.voice === 'native') state.native_model = sub.model; else state.outside_model = sub.model;
        rebound.push(r.attempt);
      }
      continue;
    }
    if (!a) { (v!.attempts ??= []).push({ attempt: r.attempt, state: 'execution_unknown', prompt: path.resolve(out, r.prompt), result: path.resolve(out, r.result), estimate_usd: r.estimate_usd ?? 0, dispatched_at: r.ts }); v!.status = 'running'; }
    else if (a.state === 'dispatched') a.state = 'execution_unknown';
    else continue;
    journal(out, { event: 'execution_unknown', attempt: r.attempt, phase: r.phase, voice: r.voice, by: 'resume' });
    unknown.push(r.attempt);
  }
  for (const phase of state.phase_order) {
    const ps = state.phases[phase];
    if (!ps?.snapshot || ps.closed_at) continue;
    if (ps.native?.status === 'completed' && voiceTerminal(ps.outside)) closePhase(state, phase, {});
  }
  const stopped = resumeStop(state);
  const gated = !currentPhase(state) && !['gate_pending', 'amend_pending', 'complete', 'incomplete', 'refused'].includes(state.status);
  if (gated) finishGate(state);
  else if (state.status === 'interrupted' || state.status === 'running' || state.status === 'awaiting_result') {
    const anyOpen = state.phase_order.some(p => (['native', 'outside'] as const).some(v => openAttempt(voiceState(state, p, v))));
    state.status = anyOpen ? 'awaiting_result' : 'running';
  }
  journal(out, { event: 'resumed', unknown, rebound, status: state.status });
  writeState(state);
  const lines = [...recovered, ...stopped, ...(gated ? carryLines(state) : []), `RESUMED: run=${state.run} status=${state.status} execution_unknown=${unknown.length} rebound=${rebound.length}`];
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
    lines.push(`PHASE: ${p} ${ps.closed_at ? (ps.deferred ? `closed-deferred(${ps.deferred.reason})` : 'closed') : ps.snapshot ? 'open' : 'pending'} ${v('native')} ${v('outside')}${ps.consensus ? ` confirmed=${(ps.consensus as any).confirmed} disagree=${(ps.consensus as any).disagree} new=${(ps.consensus as any).new}` : ''}`);
  }
  for (const a of pendingAmendments(state)) lines.push(`AMEND_PENDING: ${a.decision} ${a.item ?? ''}${a.changes ? ` changes=${a.changes}` : ''} -> ${applyGuidance(a)}`);
  for (const p of state.phase_order) for (const voice of ['native', 'outside'] as const) {
    const open = state.phases[p]?.[voice] && openAttempt(state.phases[p]![voice]!);
    if (open) lines.push(`PENDING: ${open.attempt} phase=${p} voice=${voice} result=${open.result}`);
  }
  if (fs.existsSync(path.join(state.out, FILES.spend))) lines.push(renderSpend(summarize(readLedger(path.join(state.out, FILES.spend)))));
  lines.push(roundsLine(state), ...stopLines(state));
  for (const d of state.capped_deltas ?? []) lines.push(`CAPPED_DELTA: v${d.k} ${d.phase} +${d.added} -${d.removed} ${d.status}`);
  return lines;
}
export const TERMINAL: readonly RunStatus[] = ['complete', 'gate_pending', 'amend_pending', 'incomplete', 'refused', 'interrupted'];
export { SNAPSHOT_TOOL, RunError, FILES, readState, writeState, readJournal, journal };
export type { RunState, Voice, VoiceState, AttemptState };
