/**
 * autoplan-revise — `gstack-autoplan revise` (plan B1c with the B-core
 * amendments): the run reviews a revised plan in the same run directory.
 * Drift is the Implementation-plan hash (the snapshot sha reviewers bound
 * to), not file bytes: every opened phase whose reviewed hash differs from
 * the revision is reopened (open attempts superseded), plus Eng, whose prompt
 * carries the earlier phases' consensus; phases the revised plan newly puts in
 * scope are added (never removed). Accepted gate changes are discharged only
 * when named: `--incorporates <ids>` binds each id to the old and new hashes
 * and refuses an unchanged plan; `--withdraw <id>` is the owner's journaled
 * decision to drop one. Archives keep `.r<rev>` names with `.v<k>` only on
 * collision. An edit that only incorporates decisions whose source findings
 * are all below High (no user challenge, no newly in-scope phase) applies
 * without re-review: the touched phases' reviewed hash is rebound to the
 * revision and `applied_without_rereview` is journaled; anything unsure
 * reopens. One recoverable transaction: the staged plan and state are
 * written and `revise_intent` journaled before anything moves; `resume`
 * (recoverRevise) completes an interrupted revise from the stage.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { exportRun } from './autoplan-export';
import { applyRenames, approve, closeDraftDirections, finishGate, planReopen } from './autoplan-gate';
import { carryLines, voidPendingCheck } from './autoplan-carry';
import { atCap, escalateLine, pendingDeltas, roundCap, roundOf } from './autoplan-budget';
import { diffStat, lineDiff } from './autoplan-confirm';
import { SETTLEABLE_CHANGES } from './autoplan-reconcile';
import { normalizeRevision, reviewHash, scaffold } from './autoplan-plan-text';
import { parseScopeTokens } from './autoplan-scope';
import { PHASES, detectScope, extractHeading, phaseOrder, type Phase, type ScopeFlags } from './autoplan-prompts';
import { FILES, RunError, journal, now, pendingAmendments, readDecisions, readJournal, readState, voiceRows, writeState, type RunState } from './autoplan-state';

export interface ReviseOptions { out: string; plan?: string; incorporates?: string[]; withdraw?: string[]; settle?: string[]; cwd: string }
export interface ReviseResult { state: RunState; reopened: Phase[]; lines: string[] }

const amendmentLine = (state: RunState) => `AMENDMENTS: pending=${pendingAmendments(state).map(a => a.decision).join(',') || 'none'}`;

/** The revised plan's text as the run reviews it (cut to the run's heading; scaffolded when the run was). */
function revisionText(state: RunState, file: string): string {
  if (!fs.existsSync(file)) throw new RunError('PLAN_SECTIONS_INVALID', `${file}: not found`, 3);
  let text = fs.readFileSync(file, 'utf8');
  if (state.plan_heading) {
    const section = extractHeading(text, state.plan_heading);
    if (section === undefined) throw new RunError('PLAN_SECTIONS_INVALID', `${file}: heading ${JSON.stringify(state.plan_heading)} not found`, 3);
    text = section;
  }
  const diag = scaffold(text);
  if (diag.problem && !(state.scaffolded && diag.text)) throw new RunError('PLAN_SECTIONS_INVALID', `${file}: ${diag.problem}`, 3);
  return diag.text ?? text;
}

function settleAmendments(state: RunState, ids: string[], status: 'incorporated' | 'withdrawn' | 'settled', at: string, extra: Record<string, unknown> = {}): Array<Record<string, unknown>> {
  return ids.map(id => {
    const a = pendingAmendments(state).find(x => x.decision === id)!;
    a.status = status; a.settled_at = at;
    Object.assign(a, extra);
    return { event: `amendment_${status}`, decision: id, ...extra };
  });
}

/** A `--settle`/`--incorporates`/`--withdraw` id: the decision id, or the short item id (`d4`) at the current gate_rev. */
function resolveIds(state: RunState, ids: string[]): string[] {
  return ids.map(id => pendingAmendments(state).find(a => a.decision === id || (a.item === id && a.gate_rev === state.gate_rev))?.decision ?? id);
}

/**
 * `--settle` evidence: a packaging/ordering change settles on the plan the run already reviews, never on an
 * unrevised edit. Alone, the owner's plan file must hash to the active plan, and the active plan must be the one
 * the owner accepted the change on or one a later `revise` recorded (plan_revised). With `--plan` (beside
 * `--incorporates`), it settles on that revision's hash, which the reopened phases then review.
 */
function settleEvidence(state: RunState, ids: string[], revised?: string): { plan_sha256: string; changes: Record<string, string> } {
  const active = reviewHash(fs.readFileSync(state.active_plan, 'utf8'));
  const changes: Record<string, string> = {};
  for (const id of ids) {
    const a = pendingAmendments(state).find(x => x.decision === id)!;
    if (!a.changes || !SETTLEABLE_CHANGES.includes(a.changes)) throw new RunError('AMENDMENT_NOT_SETTLEABLE', `${id} changes ${a.changes ?? 'nothing named'}; only packaging or ordering changes settle without a plan edit`, 3);
    changes[id] = a.changes;
    if (revised || !a.plan_sha256) continue;
    const recorded = [a.plan_sha256, ...readJournal(state.out).filter(r => r.event === 'plan_revised' && r.ts >= a.at).map(r => r.new_plan_sha256 as string)];
    if (!recorded.includes(active)) throw new RunError('AMENDMENT_NOT_SETTLEABLE', `the active plan ${active.slice(0, 12)} is neither the plan ${id} was accepted on (${a.plan_sha256.slice(0, 12)}) nor one revise recorded; revise --plan instead`, 3);
  }
  if (revised) return { plan_sha256: revised, changes };
  let input = '';
  try { input = state.plan_input && fs.existsSync(state.plan_input) ? reviewHash(revisionText(state, state.plan_input)) : active; } catch { /* unreadable: refused below */ }
  if (input !== active) throw new RunError('AMENDMENT_NOT_SETTLEABLE', `the plan file has edits the run has not reviewed (active ${active.slice(0, 12)}, plan file ${input.slice(0, 12) || 'unreadable'}); revise --plan <file> --incorporates <ids> --settle ${ids.join(',')} instead`, 3);
  return { plan_sha256: active, changes };
}

const SEVERITY_ORDER = ['Informational', 'Low', 'Medium', 'High', 'Critical'];
export const BELOW_HIGH = ['Informational', 'Low', 'Medium'];

/**
 * The severity an incorporated decision resolves to: the highest of the findings its gate item named (the
 * decisions.jsonl origin's ids, looked up in that phase's bound rows). `unknown` when the row, its origin or a
 * finding is missing; `challenge` for a user challenge, whose direction change is always re-reviewed.
 */
export function decisionSeverity(state: RunState, decision: string): string {
  const row = readDecisions(state.out).find(d => d.id === decision);
  const [phase, ids] = row?.origin?.split('|') ?? [];
  if (!phase || !ids || !state.phases[phase]?.closed_at) return 'unknown';
  const rows = [...voiceRows(state, phase, 'native'), ...voiceRows(state, phase, 'outside')];
  const found = ids.split('+').filter(id => id && id !== 'null').map(id => rows.find(r => r.id === id));
  if (!found.length || found.some(f => !f)) return 'unknown';
  if (found.some(f => (f as { user_challenge?: boolean }).user_challenge)) return 'challenge';
  return found.map(f => f!.severity).reduce((a, b) => (SEVERITY_ORDER.indexOf(b) > SEVERITY_ORDER.indexOf(a) ? b : a));
}

/** Every accepted change is in: approve, unless a plan delta after a round cap still needs the owner (a new gate revision). */
function approveOrRegate(state: RunState, at: string): string[] {
  if (pendingDeltas(state).length) {
    finishGate(state);
    const carried = carryLines(state);
    if (state.status !== 'gate_pending') return carried;
    const escalate = escalateLine(state);
    return [...carried, `GATE: gate_rev=${state.gate_rev} (a plan change after a round cap needs the owner) render with: gstack-gate render ${path.join(state.out, 'gate.json')}`, ...(escalate ? [escalate] : [])];
  }
  return [...approve(state, at), `APPROVED: gate_rev=${state.gate_rev} (every accepted change is in the plan or settled)`];
}

/** Every accepted change is discharged: the answered gate stands (complete) unless a revise reopened phases still to rerun. */
function finishAmendments(state: RunState, at: string): string[] {
  if (state.status !== 'amend_pending' || pendingAmendments(state).length) return [];
  journal(state.out, { event: 'amendments_settled', gate_rev: state.gate_rev ?? null });
  if (state.phase_order.some(p => !state.phases[p]?.closed_at)) { state.status = 'running'; return []; }
  return approveOrRegate(state, at);
}

export function reviseRun(o: ReviseOptions): ReviseResult {
  const out = path.resolve(o.out);
  const state = readState(out);
  if (['complete', 'incomplete', 'refused'].includes(state.status)) throw new RunError('PHASE_NOT_AWAITING', `run is ${state.status}; revise works on a running or gated run`, 3);
  const amending = state.status === 'amend_pending';
  const pending = pendingAmendments(state).map(a => a.decision);
  const incorporates = resolveIds(state, o.incorporates ?? []), withdraw = resolveIds(state, o.withdraw ?? []), settle = resolveIds(state, o.settle ?? []);
  for (const id of [...incorporates, ...withdraw, ...settle]) {
    if (!pending.includes(id)) throw new RunError('AMENDMENT_UNKNOWN', `${id} is not a pending amendment (pending: ${pending.join(', ') || 'none'})`, 3);
  }
  const at = now();
  if (!o.plan) {
    const evidence = settle.length ? settleEvidence(state, settle) : undefined;
    for (const row of settleAmendments(state, withdraw, 'withdrawn', at, { by: 'owner' })) journal(out, row);
    for (const row of settleAmendments(state, settle, 'settled', at, { plan_sha256: evidence?.plan_sha256 })) journal(out, { ...row, changes: evidence!.changes[row.decision as string] });
    const lines = [...settle.map(id => `SETTLED: ${id} (${evidence!.changes[id]}; plan ${evidence!.plan_sha256.slice(0, 12)} unchanged; nothing reopens)`), amendmentLine(state), ...finishAmendments(state, at)];
    writeState(state);
    return { state, reopened: [], lines };
  }
  const file = path.resolve(o.plan);
  const text = revisionText(state, file);
  let newHash: string;
  try { newHash = reviewHash(text); } catch (e: any) { throw new RunError('PLAN_SECTIONS_INVALID', `${file}: ${e.message}`, 3); }
  const oldHash = reviewHash(fs.readFileSync(state.active_plan, 'utf8'));
  if (incorporates.length && newHash === oldHash) {
    throw new RunError('PLAN_AMEND_PENDING', `the Implementation plan did not change (${oldHash.slice(0, 12)}); incorporating ${incorporates.join(', ')} needs the edit in ${file}`, 3);
  }
  if (settle.length && newHash !== oldHash && !incorporates.length) throw new RunError('AMENDMENT_NOT_SETTLEABLE', `the revised plan changes the Implementation plan (${oldHash.slice(0, 12)} -> ${newHash.slice(0, 12)}) and incorporates nothing; incorporate ${settle.join(', ')} instead of settling`, 3);
  const evidence = settle.length ? settleEvidence(state, settle, newHash) : undefined;
  const k = (state.plan_revision ?? 0) + 1;
  const staging = path.join(out, `.revise-v${k}`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, FILES.active), normalizeRevision(text, state.restore));
  fs.writeFileSync(path.join(staging, FILES.source), text);

  const flags = (state.scope_flags ?? (state.scope.cli_flags ? parseScopeTokens(state.scope.cli_flags, 'run.json') : { ui: state.scope.source === 'flags' ? state.scope.ui : undefined, developerTool: state.scope.developer_tool, agentPrimary: state.scope.agent_primary })) as ScopeFlags;
  const detected = detectScope(path.join(staging, FILES.active), o.cwd, flags, file);
  const order = PHASES.filter(p => state.phase_order.includes(p) || phaseOrder(detected).includes(p));
  const added = order.filter(p => !state.phase_order.includes(p));
  const opened = state.phase_order.filter(p => state.phases[p]?.snapshot);
  const changed = opened.filter(p => state.phases[p]!.snapshot !== newHash);
  const touched = state.phase_order.filter(p => changed.includes(p) || (p === 'eng' && opened.includes('eng') && changed.length > 0));
  // Below-High decisions only, every touched phase closed, nothing newly in scope (no added phase, docs-only still holds): the edit is theirs, so no re-review.
  const severities = incorporates.map(id => [id, decisionSeverity(state, id)] as const);
  const quiet = severities.length > 0 && severities.every(([, sev]) => BELOW_HIGH.includes(sev)) && touched.length > 0 && !added.length
    && touched.every(p => state.phases[p]?.closed_at) && !(state.scope.docs_only && !detected.docs_only);
  // A phase that used its last round is not reopened: the delta becomes an owner gate item, so the cap neither loops nor hides it.
  const capped = quiet ? [] : touched.filter(p => atCap(state, p));
  const reopen = quiet ? [] : touched.filter(p => !capped.includes(p));
  const delta = capped.length || quiet ? diffStat(lineDiff(fs.readFileSync(state.active_plan, 'utf8'), fs.readFileSync(path.join(staging, FILES.active), 'utf8'))) : { added: 0, removed: 0 };
  const atGate = state.status === 'gate_pending' ? state.gate_rev : undefined;
  journal(out, { event: 'revise_intent', k, staging: path.relative(out, staging), plan: file, old_plan_sha256: oldHash, new_plan_sha256: newHash, at_gate_rev: atGate ?? null, incorporates, withdraw, settle });
  voidPendingCheck(state, 'the plan was revised');

  const renames = reopen.length ? planReopen(state, reopen, state.gate_rev ?? 0, `revise v${k}`) : [];
  for (const phase of capped) {
    (state.capped_deltas ??= []).push({ k, phase, round: roundOf(state, phase), cap: roundCap(state, phase)!, old_plan_sha256: oldHash, new_plan_sha256: newHash, ...delta, status: 'pending', at });
    journal(out, { event: 'cap_delta', k, phase, round: roundOf(state, phase), cap: roundCap(state, phase), old_plan_sha256: oldHash, new_plan_sha256: newHash, ...delta });
  }
  for (const p of quiet ? touched : []) {
    const ps = state.phases[p]!;
    (ps.rebound ??= []).push({ k, from: ps.snapshot!, to: newHash, decisions: incorporates, at });
    ps.snapshot = newHash;
  }
  for (const p of added) state.phases[p] = {};
  state.phase_order = order; state.required_phases = order;
  state.scope = { ...detected, ui: detected.ui || state.scope.ui, dx: detected.dx || state.scope.dx };
  if (reopen.length || added.length) state.status = 'running';
  state.plan_input = file; state.plan_source = path.join(out, `plan-source.v${k}.md`); state.plan_revision = k;
  delete state.plan_reality;
  const settled = [...settleAmendments(state, incorporates, 'incorporated', at, { old_plan_sha256: oldHash, new_plan_sha256: newHash }), ...settleAmendments(state, withdraw, 'withdrawn', at, { by: 'owner' }),
    ...settleAmendments(state, settle, 'settled', at, { plan_sha256: evidence?.plan_sha256 }).map(r => ({ ...r, changes: evidence!.changes[r.decision as string] })),
    ...(quiet ? [{ event: 'applied_without_rereview', k, decisions: incorporates, severities: Object.fromEntries(severities), phases: touched, old_plan_sha256: oldHash, new_plan_sha256: newHash }] : [])];
  if (amending) state.status = pendingAmendments(state).length ? 'amend_pending' : state.phase_order.some(p => !state.phases[p]?.closed_at) ? 'running' : pendingDeltas(state).length ? 'gate_pending' : 'complete';
  // A quiet revise that ends at gate_pending still has an earlier capped delta waiting: the owner gets a new gate for it.
  const regate = (capped.length > 0 || quiet) && state.status === 'gate_pending';
  const committed = { event: 'plan_revised', k, plan: file, old_plan_sha256: oldHash, new_plan_sha256: newHash, source_file_sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'), reopened: reopen, added, at_gate_rev: atGate ?? null };
  fs.writeFileSync(path.join(staging, FILES.run), JSON.stringify({ state, renames, committed, settled }, null, 2) + '\n');
  publish(state, staging, renames, committed, settled);
  const lines = [`REVISED: plan=${newHash.slice(0, 12)} reopened=${reopen.join(',') || 'none'}${added.length ? ` added=${added.join(',')}` : ''}${capped.length ? ` capped=${capped.join(',')}` : ''}`,
    ...(quiet ? [`APPLIED: ${incorporates.join(',')} without re-review (below High; plan +${delta.added} -${delta.removed} lines)`] : []), amendmentLine(state)];
  for (const phase of capped) lines.push(`CAPPED: ${phase} used round ${roundOf(state, phase)} of ${roundCap(state, phase)}: not reopened; the gate asks the owner about the unreviewed delta (+${delta.added} -${delta.removed} lines)`);
  if (regate) {
    lines.push(...approveOrRegate(state, at));
    writeState(state);
  }
  if (state.status === 'complete') {
    lines.push(...closeDraftDirections(state, at.slice(0, 10)), `APPROVED: gate_rev=${state.gate_rev} (every accepted change is in the plan or settled)`);
    exportRun(state);
    writeState(state);
  }
  return { state, reopened: reopen, lines };
}

/** The commit half of the transaction; recoverRevise replays it from the stage. Every step is idempotent. */
function publish(state: RunState, staging: string, renames: Array<[string, string]>, committed: Record<string, unknown>, settled: Array<Record<string, unknown>>): void {
  applyRenames(state.out, renames);
  if (process.env.GSTACK_AUTOPLAN_FAULT === 'revise-after-archive') throw new Error('fault injected: revise interrupted after archiving (GSTACK_AUTOPLAN_FAULT, tests only)');
  const stagedActive = path.join(staging, FILES.active);
  if (fs.existsSync(stagedActive)) fs.renameSync(stagedActive, state.active_plan);
  const stagedSource = path.join(staging, FILES.source);
  if (fs.existsSync(stagedSource)) fs.renameSync(stagedSource, state.plan_source);
  exportRun(state);
  writeState(state);
  journal(state.out, committed);
  for (const row of settled) journal(state.out, row);
  fs.rmSync(staging, { recursive: true, force: true });
}

/** `resume`: complete a revise whose intent is journaled without its commit, or record it abandoned when nothing was staged. */
export function recoverRevise(out: string): string[] {
  const rows = readJournal(out);
  const intent = rows.filter(r => r.event === 'revise_intent').pop();
  if (!intent || rows.some(r => (r.event === 'plan_revised' || r.event === 'revise_abandoned') && r.k === intent.k)) return [];
  const staging = path.resolve(out, intent.staging);
  const stagedRun = path.join(staging, FILES.run);
  if (!fs.existsSync(stagedRun)) {
    journal(out, { event: 'revise_abandoned', k: intent.k });
    fs.rmSync(staging, { recursive: true, force: true });
    return [`REVISE_RECOVERED: v${intent.k} abandoned (nothing was published)`];
  }
  const stage = JSON.parse(fs.readFileSync(stagedRun, 'utf8')) as { state: RunState; renames: Array<[string, string]>; committed: Record<string, unknown>; settled: Array<Record<string, unknown>> };
  fs.writeFileSync(path.join(out, FILES.run), JSON.stringify(stage.state, null, 2) + '\n');
  const state = readState(out);
  publish(state, staging, stage.renames, { ...stage.committed, recovered: true }, stage.settled);
  return [`REVISE_RECOVERED: v${intent.k} completed (reopened=${(stage.committed.reopened as string[]).join(',') || 'none'})`];
}
