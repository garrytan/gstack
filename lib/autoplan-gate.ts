/**
 * autoplan-gate — phase close and the final gate of the unattended runner
 * (plan B2, B9, B11). `closePhase` reconciles the outside pass against the
 * native one from canonical ids (lib/autoplan-reconcile.ts), writes the
 * consensus record and the timing row, and marks the phase closed.
 * `finishGate` turns disagreements and user challenges into one gate list
 * (lib/gate-list.ts: `d<n>` auto items, `uc<n>` approval items, `p1` the plan
 * approval), writes decisions.jsonl, tasks.jsonl and the exported files, and
 * leaves the run `gate_pending`: unattended never approves. `answerGate`
 * applies one reply atomically (a stale, conflicting or partial reply writes
 * nothing); a non-recommended choice that changes reviewed content reopens the
 * dependent phases with Eng last, and only a reply that changes nothing
 * reviewed finalizes `run.json.status`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { exportRun } from './autoplan-export';
import { consensusRecord, reconcile, renderConsensus, type ConsensusRecord, type ReconciliationOverride } from './autoplan-reconcile';
import type { Phase } from './autoplan-prompts';
import { RunError, journal as journalRow, now, readDecisions, voiceRows, writeDecisions, type RunState, type VoiceState } from './autoplan-state';
import { phaseClose } from './autoplan-timing';
import { applyReply, decisionRows, parseReply, validateGateList, type GateItem, type GateList } from './gate-list';
import { readJsonl } from './headless-artifacts';
import { closeDraftDirectionsFile, loadBriefInputs } from './owner-brief';

export function loadOverrides(file: string | undefined): ReconciliationOverride[] {
  if (!file) return [];
  const read = readJsonl(file);
  if (read.errors.length) throw new RunError('ARTIFACT_MALFORMED_JSONL', read.errors.map(e => e.message).join('; '));
  return read.rows as unknown as ReconciliationOverride[];
}

function seconds(v: VoiceState | undefined): number | undefined {
  const a = v?.attempts?.find(x => x.state === 'submitted');
  if (!a?.terminal_at) return undefined;
  return Math.max(0, Math.round((Date.parse(a.terminal_at) - Date.parse(a.dispatched_at)) / 1000));
}

/** Reconcile, write `<phase>-consensus.{json,md}`, record timing, mark closed. Override errors throw before any write. */
export function closePhase(state: RunState, phase: Phase, o: { overridesFile?: string }): { consensus: ConsensusRecord } {
  const ps = state.phases[phase]!;
  const native = voiceRows(state, phase, 'native');
  const outside = voiceRows(state, phase, 'outside');
  const rec = reconcile(native, outside, loadOverrides(o.overridesFile));
  if (rec.errors.length) throw new RunError('ARTIFACT_DANGLING_REF', rec.errors.join('; '));
  const consensus = consensusRecord(phase,
    ps.native?.status === 'completed' ? { rows: native, model: ps.native.model } : null,
    ps.outside?.status === 'completed' ? { rows: outside, model: ps.outside.model, provider: ps.outside.provider } : null, rec);
  const md = renderConsensus(consensus, [...native, ...outside]);
  fs.writeFileSync(path.join(state.out, `${phase}-consensus.json`), JSON.stringify(consensus, null, 2) + '\n');
  fs.writeFileSync(path.join(state.out, `${phase}-consensus.md`), md);
  ps.consensus = { confirmed: consensus.confirmed, disagree: consensus.disagree, new: consensus.new, native_only: consensus.native_only, coverage: consensus.coverage };
  ps.closed_at = now();
  const closed = phaseClose(path.join(state.out, 'timing.json'), state.run, phase, { outside_s: seconds(ps.outside), native_s: seconds(ps.native), session_kind: state.session_kind });
  journalRow(state.out, { event: 'phase_closed', phase, consensus: ps.consensus, wall_s: closed.entry.wall_s, analytics: closed.analytics });
  return { consensus };
}

// ---------------------------------------------------------------------------
// the gate list
// ---------------------------------------------------------------------------
const CONTENT_SCOPE: Record<string, string> = { ceo: 'scope', design: 'design', dx: 'dx', eng: 'arch' };

export function buildGate(state: RunState, gateRev: number): GateList {
  const items: GateItem[] = [];
  let d = 0, uc = 0;
  for (const phase of state.phase_order) {
    const ps = state.phases[phase];
    if (!ps?.closed_at) continue;
    const consensus = JSON.parse(fs.readFileSync(path.join(state.out, `${phase}-consensus.json`), 'utf8')) as ConsensusRecord;
    const native = voiceRows(state, phase, 'native');
    const outside = voiceRows(state, phase, 'outside');
    const byId = new Map([...native, ...outside].map(f => [f.id, f]));
    const challenged = new Set<string>();
    for (const row of consensus.rows) {
      const o = byId.get(row.outside_id)!;
      const n = row.native_id ? byId.get(row.native_id) : undefined;
      const bothChallenge = !!(o as any).user_challenge && !!(n as any)?.user_challenge && row.disposition !== 'new';
      if (bothChallenge) {
        challenged.add(o.id); if (n) challenged.add(n.id);
        items.push({ id: `uc${++uc}`, title: `${n?.title ?? o.title} [${row.native_id} + ${row.outside_id}]`, kind: 'approval', recommended: 'a', phase,
          why: `both voices recommend changing your stated direction; blind spot: ${o.title}; cost if wrong: ${o.resolution ?? n?.resolution ?? 'unstated'}`,
          options: [{ key: 'a', text: 'keep your direction (the plan as reviewed)' }, { key: 'b', text: 'accept the change both reviewers recommend' }] });
        continue;
      }
      if (row.disposition === 'disagree') {
        items.push({ id: `d${++d}`, title: `${n!.title} [${row.native_id} vs ${row.outside_id}]`, kind: 'auto', recommended: 'a', phase,
          why: `voices disagree: ${row.resolution}`, cost: `b reopens ${phase}${phase === 'eng' ? '' : ' and eng'}`,
          options: [{ key: 'a', text: `native position (${row.severity.native})` }, { key: 'b', text: `outside position (${row.severity.outside})` }] });
      }
    }
    for (const f of [...native, ...outside]) {
      if (!(f as any).user_challenge || challenged.has(f.id)) continue;
      items.push({ id: `d${++d}`, title: `${f.title} [${f.id}]`, kind: 'auto', recommended: 'a', phase, why: `one voice (${f.voice}) recommends changing your stated direction`,
        cost: `b reopens ${phase}${phase === 'eng' ? '' : ' and eng'}`, options: [{ key: 'a', text: 'keep your direction' }, { key: 'b', text: 'accept the change' }] });
    }
  }
  items.push({ id: 'p1', title: 'Plan approval', kind: 'approval', recommended: 'a',
    options: [{ key: 'a', text: 'approve as-is' }, { key: 'b', text: 'approve with the overrides above' }, { key: 'c', text: 'interrogate (ask questions; stays pending)' }, { key: 'd', text: 'revise the plan (every phase reruns, Eng last)' }, { key: 'e', text: 'reject' }] });
  const list: GateList = { schema_version: 1, run: state.run, gate_rev: gateRev, items, title: '/autoplan final approval gate' };
  const problems = validateGateList(list);
  if (problems.length) throw new Error(`gate list invalid: ${problems.join('; ')}`);
  return list;
}

/** Every phase closed: write the gate list, decisions, tasks and the exported files; the run ends gate_pending. */
export function finishGate(state: RunState): GateList {
  const gateRev = (state.gate_rev ?? 0) + 1;
  const list = buildGate(state, gateRev);
  fs.writeFileSync(path.join(state.out, 'gate.json'), JSON.stringify(list, null, 2) + '\n');
  const kept = readDecisions(state.out).filter(r => r.gate_rev !== gateRev);
  writeDecisions(state.out, [...kept, ...decisionRows(list)]);
  state.gate_rev = gateRev;
  state.status = 'gate_pending';
  state.gate = { rev: gateRev, items: list.items.length, written_at: now() };
  exportRun(state);
  journalRow(state.out, { event: 'gate_written', gate_rev: gateRev, items: list.items.length });
  return list;
}

// ---------------------------------------------------------------------------
// answer
// ---------------------------------------------------------------------------
export interface AnswerResult { state: RunState; applied: boolean; pending: string[]; reopened: Phase[]; outcome: 'complete' | 'gate_pending' | 'reopened' | 'rejected'; lines: string[] }

export function answerGate(state: RunState, gateRev: number, reply: string): AnswerResult {
  const gateFile = path.join(state.out, 'gate.json');
  if (state.status !== 'gate_pending' || !fs.existsSync(gateFile)) throw new RunError('PHASE_NOT_AWAITING', `run is ${state.status}, not gate_pending`, 3);
  const list = JSON.parse(fs.readFileSync(gateFile, 'utf8')) as GateList;
  const parsed = parseReply(reply, list, gateRev);
  if (parsed.error === 'GATE_REV_STALE') throw new RunError('GATE_REV_STALE', `reply names gate_rev=${gateRev}, current gate_rev=${list.gate_rev}`, 3);
  if (!parsed.valid) throw new RunError('GATE_REPLY_UNPARSED', parsed.error === 'GATE_EMPTY' ? 'empty reply' : `unparsed: ${parsed.unparsed.join(', ')}`);
  const choice = (id: string) => parsed.choices.find(c => c.id === id);
  const plan = choice('p1');
  const lines: string[] = [];
  const answeredAt = now();
  if (!plan) {
    // Approval items unanswered: record the auto items, keep the gate pending; nothing reviewed changes.
    writeDecisions(state.out, applyReply(readDecisions(state.out), parsed, answeredAt));
    state.gate = { ...(state.gate ?? {}), last_reply: reply, pending: parsed.pending };
    lines.push(`GATE_PENDING: ${parsed.pending.join(', ')} unanswered (reply with p1a..p1e or all)`);
    return { state, applied: true, pending: parsed.pending, reopened: [], outcome: 'gate_pending', lines };
  }
  const overrides = parsed.choices.filter(c => c.how === 'override' && c.id !== 'p1');
  const reopenSet = new Set<Phase>();
  if (plan.chosen === 'd') state.phase_order.forEach(p => reopenSet.add(p));
  else if (plan.chosen !== 'c' && plan.chosen !== 'e') {
    for (const o of overrides) {
      const item = list.items.find(i => i.id === o.id)!;
      if (item.phase) { reopenSet.add(item.phase as Phase); if (state.phase_order.includes('eng')) reopenSet.add('eng'); }
    }
  }
  writeDecisions(state.out, applyReply(readDecisions(state.out), parsed, answeredAt));
  state.gate = { ...(state.gate ?? {}), answered_at: answeredAt, reply, gate_rev: gateRev, plan: plan.chosen, overrides: overrides.map(o => `${o.id}${o.chosen}`) };
  journalRow(state.out, { event: 'answered', gate_rev: gateRev, reply, plan: plan.chosen, overrides: overrides.map(o => `${o.id}${o.chosen}`), reopen: [...reopenSet] });
  if (plan.chosen === 'c') {
    lines.push(`GATE_PENDING: interrogate recorded; the gate stays at gate_rev=${gateRev}`);
    return { state, applied: true, pending: ['p1'], reopened: [], outcome: 'gate_pending', lines };
  }
  if (plan.chosen === 'e') {
    state.status = 'incomplete';
    (state.deviations ??= []).push(`plan rejected by the owner at gate_rev ${gateRev}`);
    exportRun(state);
    lines.push('REJECTED: run.json.status=incomplete');
    return { state, applied: true, pending: [], reopened: [], outcome: 'rejected', lines };
  }
  if (reopenSet.size === 0) {
    state.status = 'complete';
    lines.push(...closeDraftDirections(state, answeredAt.slice(0, 10)));
    exportRun(state);
    lines.push(`APPROVED: gate_rev=${gateRev} ${overrides.length ? `overrides=${overrides.map(o => `${o.id}${o.chosen}`).join(',')} (none change reviewed content)` : 'as-is'}`);
    return { state, applied: true, pending: [], reopened: [], outcome: 'complete', lines };
  }
  const reopened = state.phase_order.filter(p => reopenSet.has(p));
  reopenPhases(state, reopened, gateRev, `gate_rev ${gateRev}: ${plan.chosen === 'd' ? 'revise' : overrides.map(o => `${o.id}${o.chosen}`).join(',')}`);
  lines.push(`REOPENED: ${reopened.join(',')} (Eng last) reason=${plan.chosen === 'd' ? 'revise' : overrides.map(o => `${o.id}${o.chosen}`).join(',')}`);
  return { state, applied: true, pending: [], reopened, outcome: 'reopened', lines };
}

/** E3 phase-close operation: every `draft direction stands until the owner decides` line in the active plan becomes the decided option and date. */
function closeDraftDirections(state: RunState, date: string): string[] {
  const loaded = loadBriefInputs(state.out);
  if ('error' in loaded) return [];
  const r = closeDraftDirectionsFile(state.active_plan, loaded.inputs, date);
  if (!r.rewrites.length) return [];
  journalRow(state.out, { event: 'draft_directions_closed', rewritten: r.rewrites.length - r.unresolved.length, unresolved: r.unresolved.map(u => u.line) });
  return [`DRAFT_DIRECTIONS: rewritten=${r.rewrites.length - r.unresolved.length} unresolved=${r.unresolved.length}`];
}

/** Archive the reopened phases' bound files under their gate revision and reset them; the gate itself is archived too. */
export function reopenPhases(state: RunState, phases: Phase[], gateRev: number, reason: string): void {
  const archive = (name: string) => {
    const from = path.join(state.out, name);
    if (!fs.existsSync(from)) return;
    const ext = path.extname(name);
    fs.renameSync(from, path.join(state.out, `${name.slice(0, -ext.length || undefined)}.r${gateRev}${ext}`));
  };
  for (const phase of phases) {
    const ps = state.phases[phase] ?? {};
    state.history.push({ event: 'reopened', phase, gate_rev: gateRev, reason, at: now(), previous: ps });
    for (const voice of ['native', 'outside'] as const) {
      const output = ps[voice]?.output;
      if (output) { archive(`${output}.findings.jsonl`); archive(output); delete state.artifacts[output]; }
      archive(`${phase}-${voice}-prompt.md`);
    }
    archive(`${phase}-consensus.json`); archive(`${phase}-consensus.md`);
    delete state.artifacts[`${phase}-consensus.json`]; delete state.artifacts[`${phase}-consensus.md`];
    state.phases[phase] = {};
    journalRow(state.out, { event: 'reopened', phase, gate_rev: gateRev, reason });
  }
  archive('gate.json');
  delete state.artifacts['gate.json'];
  state.status = 'running';
  exportRun(state);
}
