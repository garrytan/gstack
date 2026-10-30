/**
 * autoplan-gate — phase close and the final gate of the unattended runner
 * (plan B2, B9, B11). `closePhase` reconciles the outside pass against the
 * native one from canonical ids (lib/autoplan-reconcile.ts), writes the
 * consensus record and the timing row, and marks the phase closed.
 * `finishGate` turns disagreements and user challenges into one gate list
 * (lib/gate-list.ts: `d<n>` auto items, `uc<n>` approval items, `p1` the plan
 * approval), writes decisions.jsonl, tasks.jsonl and the exported files, and
 * leaves the run `gate_pending`: unattended never approves. `answerGate`
 * applies one reply atomically (a stale or conflicting reply writes nothing;
 * a partial one records its answers and keeps the gate); a chosen option that
 * changes the plan (`changes_plan`) reopens the dependent phases with Eng last
 * and is recorded as a pending amendment, and only a reply that changes
 * nothing reviewed finalizes `run.json.status`. Rerun gates turn challenges
 * that name no scope, cost or direction into agent decisions, and answers to
 * unchanged proposals from phases that did not rerun carry forward.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { exportRun } from './autoplan-export';
import { driftLine, reviewHash } from './autoplan-plan-text';
import { consensusRecord, reconcile, remedyKey, renderConsensus, SETTLEABLE_CHANGES, type ConsensusRecord, type ReconciliationOverride, type ReconciliationRow } from './autoplan-reconcile';
import type { Phase } from './autoplan-prompts';
import { FILES, RunError, journal as journalRow, now, readDecisions, voiceRows, voiceTerminal, writeDecisions, type Amendment, type RunState, type VoiceState } from './autoplan-state';
import { applyCapChoices, pendingDeltas, releaseUndispatched, roundCap, roundOf } from './autoplan-budget';
import { evaluateCarry, gateEvidence, voidPendingCheck } from './autoplan-carry';
import { buildEli5, capyRelayLine } from './captain-brief';
import { previousReview, reviewRows, settledIds } from './autoplan-confirm';
import { phaseClose } from './autoplan-timing';
import { ANSWERED_BY_RE, applyReply, decisionId, decisionRows, keepDirection, parseReply, pendingHint, recHash, validateGateList, type GateChoice, type GateItem, type GateList, type GateOption, type ParsedReply } from './gate-list';
import type { FindingRow } from './headless-artifacts';
import { readJsonl, sha256File } from './headless-artifacts';
import { closeDraftDirectionsFile, loadBriefInputs } from './owner-brief';
import { vaguePlanTerms } from './plan-reality';
import { settle } from './spend-ledger';

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
  ps.consensus = { confirmed: consensus.confirmed, unverified: consensus.unverified, disagree: consensus.disagree, new: consensus.new, native_only: consensus.native_only, coverage: consensus.coverage };
  ps.closed_at = now();
  const closed = phaseClose(path.join(state.out, 'timing.json'), state.run, phase, { outside_s: seconds(ps.outside), native_s: seconds(ps.native), session_kind: state.session_kind });
  journalRow(state.out, { event: 'phase_closed', phase, consensus: ps.consensus, wall_s: closed.entry.wall_s, analytics: closed.analytics });
  return { consensus };
}

const severityText = (counts: Record<string, number>) => Object.entries(counts).filter(([, n]) => n).map(([s, n]) => `${s}=${n}`).join(' ') || 'none';
type OpenRow = FindingRow & { urgent?: boolean; user_challenge?: boolean; settled_by?: string };

/**
 * Close `phase` accepted-with-findings (field list 2, W5): at the round cap, or by the owner (`close --deferred`).
 * Open voices become skipped. Their dispatched or execution-unknown attempts are settled `unknown` at their
 * reservation (a deferred review may still have run and been billed); only reservations with no journaled dispatch
 * are released. The consensus file is written from the bound voices so export, validate and resume work. Open
 * findings (this round's bound rows plus the unanswered rows of the round last reviewed) carry into
 * tasks.jsonl and the gate; Critical, urgent and user-challenge findings become owner approval items.
 */
export function closeDeferred(state: RunState, phase: Phase, o: { reason: string; by: string; cause: 'cap' | 'owner' }): { lines: string[]; blockers: string[] } {
  const ps = (state.phases[phase] ??= {});
  const at = now();
  for (const voice of ['native', 'outside'] as const) {
    const v = (ps[voice] ??= { status: 'pending' });
    for (const a of v.attempts ?? []) {
      if (a.state !== 'dispatched' && a.state !== 'execution_unknown') continue;
      a.state = 'deferred'; a.terminal_at = at;
      settle(path.join(state.out, FILES.spend), a.attempt, 'unknown');
      journalRow(state.out, { event: 'attempt_deferred', attempt: a.attempt, phase, voice, reason: o.reason });
    }
    if (!voiceTerminal(v)) Object.assign(v, { status: 'skipped', detail: `deferred: ${o.reason}` });
  }
  const lines = releaseUndispatched(state);
  const native = voiceRows(state, phase, 'native'), outside = voiceRows(state, phase, 'outside');
  const consensus = consensusRecord(phase, ps.native?.status === 'completed' ? { rows: native, model: ps.native.model } : null,
    ps.outside?.status === 'completed' ? { rows: outside, model: ps.outside.model, provider: ps.outside.provider } : null, reconcile(native, outside, []));
  const answered = settledIds(state);
  const current: OpenRow[] = [...native, ...outside];
  const ids = new Set(current.map(r => r.id));
  const earlier: OpenRow[] = reviewRows(state, previousReview(state, phase)).filter(r => !answered.has(r.id) && !ids.has(r.id));
  const rows = [...current, ...earlier];
  let carried: string | undefined;
  if (earlier.length) {
    carried = `${phase}-deferred.findings.jsonl`;
    fs.writeFileSync(path.join(state.out, carried), earlier.map(r => JSON.stringify({ ...r, disposition: 'deferred' })).join('\n') + '\n');
    state.artifacts[carried] = { path: carried, sha256: sha256File(path.join(state.out, carried)) };
  }
  const open = rows.filter(r => !r.settled_by && !answered.has(r.id));
  const counts = Object.fromEntries(['Critical', 'High', 'Medium', 'Low', 'Informational'].map(s => [s, open.filter(r => r.severity === s).length]));
  const blockers = open.filter(r => r.severity === 'Critical' || r.urgent || r.user_challenge).map(r => r.id);
  const round = roundOf(state, phase);
  ps.deferred = { reason: o.reason, by: o.by, cause: o.cause, at, round, counts, ...(carried ? { carried_file: carried } : {}), blockers, open: open.length };
  const head = `DEFERRED: ${phase} closed accepted-with-findings at round ${round} (${o.reason}; by ${o.by}); open findings: ${severityText(counts)}; ${blockers.length ? `owner items: ${blockers.join(', ')}` : 'no Critical, urgent or user-challenge finding, so no owner item'}\n\n`;
  fs.writeFileSync(path.join(state.out, `${phase}-consensus.json`), JSON.stringify({ ...consensus, deferred: ps.deferred }, null, 2) + '\n');
  fs.writeFileSync(path.join(state.out, `${phase}-consensus.md`), head + renderConsensus(consensus, [...native, ...outside]));
  ps.consensus = { confirmed: consensus.confirmed, unverified: consensus.unverified, disagree: consensus.disagree, new: consensus.new, native_only: consensus.native_only, coverage: consensus.coverage, deferred: true };
  ps.closed_at = at;
  journalRow(state.out, { event: 'phase_deferred', phase, ...ps.deferred });
  lines.push(`PHASE_DEFERRED: ${phase} round=${round}/${roundCap(state, phase) ?? 'none'} by=${o.by} open=${open.length} (${severityText(counts)}) blockers=${blockers.join(',') || 'none'} reason=${JSON.stringify(o.reason)}`);
  return { lines, blockers };
}

/** The round-cap items: one per deferred phase, one per deferred blocker, one per capped plan delta. */
function capItems(state: RunState, next: { d: () => string; uc: () => string }): GateItem[] {
  const items: GateItem[] = [];
  const push = (item: GateItem, ids: string) => items.push({ ...item, origin: ['cap', ids, optionHash(item.options)].join('|') });
  const reopen = (phase: string) => ({ key: 'b', text: `reopen ${phase} for one more round (an owner budget raise${phase === 'eng' ? '' : '; Eng reruns last'})`, changes_plan: false });
  for (const phase of state.phase_order) {
    const def = state.phases[phase]?.deferred;
    if (!def) continue;
    const rows: OpenRow[] = [...voiceRows(state, phase, 'native'), ...voiceRows(state, phase, 'outside'),
      ...(def.carried_file ? readJsonl(path.join(state.out, def.carried_file)).rows as unknown as OpenRow[] : [])];
    push({ id: next.d(), title: `${phase} closed accepted-with-findings at round ${def.round} (${def.reason}): ${def.open} open finding(s), ${severityText(def.counts)}, carried into tasks.jsonl`,
      kind: 'auto', recommended: 'a', phase, cap: { phase, kind: 'deferred' }, why: `closed deferred by ${def.by}`, cost: `b grants ${phase} one more round`,
      options: [{ key: 'a', text: 'accept with findings, deferred to the build', changes_plan: false }, reopen(phase)] }, `deferred-${phase}`);
    for (const id of def.blockers) {
      const f = rows.find(r => r.id === id);
      if (!f) continue;
      const risk = f.severity === 'Critical' || f.urgent;
      push({ id: next.uc(), title: `${f.severity}${f.urgent ? ' urgent' : ''}${f.user_challenge ? ' user challenge' : ''} left open when ${phase} closed deferred: ${f.title} [${id}]`,
        kind: 'approval', recommended: risk ? 'b' : 'a', recommended_basis: risk ? 'an open Critical or urgent finding' : 'plan direction; a user challenge', phase, cap: { phase, kind: 'blocker', ref: id },
        why: `${phase} closed deferred (${def.reason}) with this finding open; only you can accept it`,
        options: [{ key: 'a', text: 'carry it into the build as a blocking task (you accept the risk)', changes_plan: false }, reopen(phase)] }, id);
    }
  }
  for (const delta of pendingDeltas(state)) {
    push({ id: next.uc(), title: `plan changed after ${delta.phase} cap: unreviewed delta (+${delta.added} -${delta.removed} lines, ${delta.old_plan_sha256.slice(0, 12)} -> ${delta.new_plan_sha256.slice(0, 12)})`,
      kind: 'approval', recommended: 'a', recommended_basis: 'the run budget; the delta is reviewed during the build', phase: delta.phase, cap: { phase: delta.phase, kind: 'delta', ref: String(delta.k) },
      why: `revise v${delta.k} changed the plan after ${delta.phase} used round ${delta.round} of ${delta.cap}, so ${delta.phase} never reviewed it`,
      options: [{ key: 'a', text: 'accept the unreviewed delta into the approved plan', changes_plan: false }, reopen(delta.phase)] }, `delta-${delta.k}`);
  }
  return items;
}

// ---------------------------------------------------------------------------
// the gate list
// ---------------------------------------------------------------------------
const CONTENT_SCOPE: Record<string, string> = { ceo: 'scope', design: 'design', dx: 'dx', eng: 'arch' };
const optionHash = (options: GateOption[]) => createHash('sha256').update(JSON.stringify(options.map(o => [o.key, o.text]))).digest('hex').slice(0, 16);
const KEEP = (text: string): GateOption => ({ key: 'a', text, changes_plan: false });


/**
 * A user challenge both voices raised recommends the change only with an
 * explicit, coherent shared proposal: the finding reconciled `confirmed`,
 * both name the same `changes`, and either the parent's reconcile override
 * states one proposal for both or both voices wrote the same remedy. Title
 * similarity and file:line proximity only associate the findings; anything
 * weaker keeps the plan's direction, and the basis says why. Option b shows
 * the remedies verbatim.
 */
export function challengeDefault(row: ReconciliationRow, n: FindingRow | undefined, o: FindingRow): { recommended: 'a' | 'b'; basis: string; text: string } {
  const nf = n as (FindingRow & { changes?: string }) | undefined, of = o as FindingRow & { changes?: string };
  const remedies = row.proposal ? ` (shared proposal: ${row.proposal})`
    : nf?.resolution || of.resolution ? ` (native: ${nf?.resolution ?? 'no remedy stated'}; outside: ${of.resolution ?? 'no remedy stated'})` : '';
  const text = `accept the change both reviewers recommend${remedies}`;
  const keep = (basis: string) => ({ recommended: 'a' as const, basis: `plan direction; ${basis}`, text });
  if (row.disposition === 'unverified') return keep(row.resolution.startsWith('same title, a remedy is missing') ? 'a remedy is missing' : row.resolution.startsWith('same title') ? 'remedies differ; no shared proposal' : 'same location, agreement unverified');
  if (row.disposition !== 'confirmed') return keep('voices disagree');
  if (!nf?.changes || !of.changes) return keep('no shared changes value');
  if (nf.changes !== of.changes) return keep('voices name different changes');
  if (row.proposal) return { recommended: 'b', basis: 'both voices; shared proposal', text };
  if (!nf.resolution || !of.resolution) return keep('a remedy is missing');
  if (remedyKey(nf.resolution) !== remedyKey(of.resolution)) return keep('remedies differ; no shared proposal');
  return { recommended: 'b', basis: 'both voices; same remedy', text };
}

/** A rerun challenge naming no scope, cost or direction: the agent's own decision, recorded, reopening nothing. */
function agentDecision(id: string, title: string, phase: string, why: string): GateItem {
  return { id, title, kind: 'auto', recommended: 'a', phase, reopens: false, why: `${why}; it names no scope, cost or direction change, so on a rerun it is the agent's decision`,
    cost: 'agent decision; b is recorded, no phase reruns', options: [KEEP('keep your direction'), { key: 'b', text: 'accept the change (agent decision; no phase reruns)', changes_plan: false }] };
}

export function buildGate(state: RunState, gateRev: number): GateList {
  const items: GateItem[] = [];
  let d = 0, uc = 0;
  for (const phase of state.phase_order) {
    const ps = state.phases[phase];
    if (!ps?.closed_at || ps.deferred) continue;
    const consensus = JSON.parse(fs.readFileSync(path.join(state.out, `${phase}-consensus.json`), 'utf8')) as ConsensusRecord;
    const native = voiceRows(state, phase, 'native');
    const outside = voiceRows(state, phase, 'outside');
    const byId = new Map([...native, ...outside].map(f => [f.id, f]));
    const reran = gateRev > 1 && state.history.some(h => h.event === 'reopened' && h.phase === phase);
    const origin = (ids: string, options: GateOption[]) => [phase, ids, ps.closed_at, ps.snapshot, optionHash(options)].join('|');
    const push = (item: GateItem, ids: string) => items.push({ ...item, origin: origin(ids, item.options) });
    const challenged = new Set<string>();
    for (const row of consensus.rows) {
      const o = byId.get(row.outside_id)! as FindingRow & { user_challenge?: boolean; changes?: string; settled_by?: string };
      if (o.settled_by) continue;
      const n = (row.native_id ? byId.get(row.native_id) : undefined) as (FindingRow & { user_challenge?: boolean; changes?: string }) | undefined;
      const ids = `${row.native_id}+${row.outside_id}`;
      if (o.user_challenge && n?.user_challenge && row.disposition !== 'new') {
        challenged.add(o.id); challenged.add(n.id);
        const title = `${n.title} [${row.native_id} + ${row.outside_id}]`;
        if (reran && !n.changes && !o.changes) { push(agentDecision(`d${++d}`, title, phase, 'both voices recommend changing your stated direction'), ids); continue; }
        const def = challengeDefault(row, n, o);
        push({ id: `uc${++uc}`, title, kind: 'approval', recommended: def.recommended, recommended_basis: def.basis, phase, ...(n.changes ?? o.changes ? { changes: n.changes ?? o.changes } : {}),
          why: `both voices recommend changing your stated direction; blind spot: ${o.title}; cost if wrong: ${o.resolution ?? n.resolution ?? 'unstated'}`,
          options: [KEEP('keep your direction (the plan as reviewed)'), { key: 'b', text: def.text, changes_plan: true }] }, ids);
        continue;
      }
      if (row.disposition === 'disagree') {
        push({ id: `d${++d}`, title: `${n!.title} [${row.native_id} vs ${row.outside_id}]`, kind: 'auto', recommended: 'a', phase,
          why: `voices disagree: ${row.resolution}`, cost: `b reopens ${phase}${phase === 'eng' ? '' : ' and eng'}`,
          options: [{ key: 'a', text: `native position (${row.severity.native})`, changes_plan: false }, { key: 'b', text: `outside position (${row.severity.outside})`, changes_plan: true }] }, ids);
      }
    }
    for (const f of [...native, ...outside] as Array<FindingRow & { user_challenge?: boolean; changes?: string; settled_by?: string }>) {
      if (!f.user_challenge || challenged.has(f.id) || f.settled_by) continue;
      const why = `one voice (${f.voice}) recommends changing your stated direction`;
      if (reran && !f.changes) { push(agentDecision(`d${++d}`, `${f.title} [${f.id}]`, phase, why), f.id); continue; }
      push({ id: `d${++d}`, title: `${f.title} [${f.id}]`, kind: 'auto', recommended: 'a', phase, why, ...(f.changes ? { changes: f.changes } : {}),
        cost: `b reopens ${phase}${phase === 'eng' ? '' : ' and eng'}`, options: [KEEP('keep your direction'), { key: 'b', text: 'accept the change', changes_plan: true }] }, f.id);
    }
  }
  items.push(...capItems(state, { d: () => `d${++d}`, uc: () => `uc${++uc}` }));
  items.push(planApproval(state, items));
  const list: GateList = { schema_version: 1, run: state.run, gate_rev: gateRev, items, title: '/autoplan final approval gate', rec_rev: 0,
    ...(fs.existsSync(state.active_plan) ? { eli5: buildEli5(fs.readFileSync(state.active_plan, 'utf8'), state.active_plan) } : {}) };
  const problems = validateGateList(list);
  if (problems.length) throw new Error(`gate list invalid: ${problems.join('; ')}`);
  return list;
}

/** The p1 plan-approval item: recommends `b` when any item's recommendation changes the plan, with PLAN_REALITY flags. */
function planApproval(state: RunState, items: GateItem[]): GateItem {
  const changes = items.filter(i => i.id !== 'p1' && i.options.find(o => o.key === i.recommended)?.changes_plan).map(i => `${i.id}${i.recommended}`);
  const planFile = fs.existsSync(state.plan_source) ? state.plan_source : state.active_plan;
  const flags = vaguePlanTerms(fs.readFileSync(planFile, 'utf8')).map(v => `PLAN_REALITY ${JSON.stringify(v.phrase)} has no number, arm list or rule body (${path.basename(state.plan_input ?? planFile)}:${v.line}: ${v.text.length > 120 ? `${v.text.slice(0, 117)}...` : v.text}) (report only)`);
  return { id: 'p1', title: 'Plan approval', kind: 'approval', recommended: changes.length ? 'b' : 'a', ...(flags.length ? { flags } : {}),
    options: [{ key: 'a', text: 'approve as-is' }, { key: 'b', text: changes.length ? `approve with the recommended changes: ${changes.join(', ')}` : 'approve with the overrides above' },
      { key: 'c', text: 'interrogate (ask questions; stays pending)' },
      { key: 'd', text: `rerun every phase on the current plan, Eng last (to review an edited plan instead: gstack-autoplan revise --out ${state.out} --plan <file>)` }, { key: 'e', text: 'reject' }] };
}

/**
 * `gstack-autoplan recommend`: the relaying parent sets one item's recommendation before relay, with its basis and
 * provenance. The plan-approval item and decisions.jsonl follow, and `rec_rev` bumps so a `rec` rendered earlier is
 * refused (GATE_REC_STALE) until the gate is rendered and relayed again.
 */
export function recommendGate(state: RunState, gateRev: number, itemId: string, option: string, basis: string, by: string): string[] {
  const gateFile = path.join(state.out, 'gate.json');
  if (state.status !== 'gate_pending' || !fs.existsSync(gateFile)) throw new RunError('PHASE_NOT_AWAITING', `run is ${state.status}, not gate_pending`, 3);
  const list = JSON.parse(fs.readFileSync(gateFile, 'utf8')) as GateList;
  if (gateRev !== list.gate_rev) throw new RunError('GATE_REV_STALE', `--gate-rev ${gateRev}, current gate_rev=${list.gate_rev}`, 3);
  const item = list.items.find(i => i.id === itemId);
  if (!item || item.id === 'p1' || !item.options.some(o => o.key === option)) throw new RunError('GATE_REPLY_UNPARSED', `${itemId}${option} names no item option a recommendation can take (p1 follows the items)`);
  Object.assign(item, { recommended: option, recommended_basis: basis, recommended_by: by });
  const p1 = planApproval(state, list.items);
  list.items = list.items.map(i => (i.id === 'p1' ? p1 : i));
  list.rec_rev = (list.rec_rev ?? 0) + 1;
  fs.writeFileSync(gateFile, JSON.stringify(list, null, 2) + '\n');
  const updated = new Map([item, p1].map(i => [decisionId(list.run, gateRev, i.id), i]));
  writeDecisions(state.out, readDecisions(state.out).map(r => {
    const i = updated.get(r.id);
    if (!i) return r;
    return { ...r, recommended: i.recommended, ...(i.kind === 'auto' ? { default_if_unanswered: i.recommended } : {}), ...(i.recommended_basis ? { recommended_basis: i.recommended_basis } : {}), ...(i.recommended_by ? { recommended_by: i.recommended_by } : {}) };
  }));
  const hash = recHash(list);
  journalRow(state.out, { event: 'recommended', gate_rev: gateRev, item: itemId, option, basis, by, rec_rev: list.rec_rev, rec_hash: hash });
  exportRun(state);
  return [`RECOMMENDED: ${itemId}${option} by=${by} basis=${JSON.stringify(basis)} p1=${p1.recommended} rec_hash=${hash}`,
    `RELAY: gstack-gate render ${gateFile} --all (a rec rendered before this is refused; answer with --rec-hash ${hash})`,
    ...[capyRelayLine(state.out)].filter((l): l is string => !!l)];
}

/** The gate list the owner last answered: gate.json, or its archive (`gate.r<rev>[.v<k>].json`) once a reopen moved it. */
function previousGate(out: string, rev: number): GateList | undefined {
  if (rev < 1) return undefined;
  const re = new RegExp(`^gate\\.r${rev}(?:\\.v(\\d+))?\\.json$`);
  const archived = fs.readdirSync(out).map(f => [f, re.exec(f)] as const).filter(([, m]) => m).sort((a, b) => Number(b[1]![1] ?? 1) - Number(a[1]![1] ?? 1)).map(([f]) => f);
  for (const name of ['gate.json', ...archived]) {
    const file = path.join(out, name);
    if (!fs.existsSync(file)) continue;
    const list = JSON.parse(fs.readFileSync(file, 'utf8')) as GateList;
    if (list.gate_rev === rev) return list;
  }
  return undefined;
}

/**
 * Every phase closed: write the gate list, decisions, tasks and the exported files; the run ends gate_pending. Unchanged
 * answered proposals carry forward, and a later revision that asks nothing new carries the owner's last answer
 * (lib/autoplan-carry.ts; its lines are on `carryLines(state)`).
 */
export function finishGate(state: RunState): GateList {
  const gateRev = (state.gate_rev ?? 0) + 1;
  const gateFile = path.join(state.out, 'gate.json');
  const prev = previousGate(state.out, state.gate_rev ?? 0);
  const list = buildGate(state, gateRev);
  const kept = readDecisions(state.out).filter(r => r.gate_rev !== gateRev);
  const answered = new Map(kept.filter(r => r.origin && r.chosen != null && r.status !== 'pending').map(r => [r.origin!, r]));
  for (const item of list.items) {
    const prev = item.origin ? answered.get(item.origin) : undefined;
    if (prev && item.options.some(o => o.key === prev.chosen)) item.carried = { from: prev.carried_from ?? prev.id, chosen: prev.chosen!, gate_rev: prev.gate_rev };
  }
  fs.writeFileSync(gateFile, JSON.stringify(list, null, 2) + '\n');
  const rows = decisionRows(list).map(row => {
    const item = list.items.find(i => decisionId(list.run, gateRev, i.id) === row.id)!;
    if (!item.carried) return row;
    const prev = answered.get(item.origin!)!;
    return { ...row, chosen: item.carried.chosen, status: item.carried.chosen === item.recommended ? 'approved' as const : 'overridden' as const,
      answered_at: prev.answered_at, reply: prev.reply, carried_from: item.carried.from, ...(prev.chosen_text ? { chosen_text: prev.chosen_text } : {}) };
  });
  writeDecisions(state.out, [...kept, ...rows]);
  state.gate_rev = gateRev;
  state.status = 'gate_pending';
  state.gate = { rev: gateRev, items: list.items.length, written_at: now() };
  exportRun(state);
  journalRow(state.out, { event: 'gate_written', gate_rev: gateRev, items: list.items.length, carried: list.items.filter(i => i.carried).map(i => i.id), ...gateEvidence(state, gateRev) });
  evaluateCarry(state, prev, list);
  return list;
}

// ---------------------------------------------------------------------------
// answer
// ---------------------------------------------------------------------------
export interface AnswerResult { state: RunState; applied: boolean; pending: string[]; reopened: Phase[]; outcome: 'complete' | 'gate_pending' | 'reopened' | 'rejected' | 'amend_pending'; lines: string[] }
export interface AnswerOptions {
  /** The rec_hash of the render the owner saw; required for a `rec` reply once `recommend` changed the gate. */
  recHash?: string;
  /** The owner's verbatim words; required for every `--by agent:<id>` answer. */
  ownerReply?: string;
  /** A whole-gate carry (lib/autoplan-carry.ts): the earlier p1 decision and the owner's words it reuses. Replaces ownerReply and its re-parse. */
  carry?: { from: string; gate_rev: number; words: string; by?: string; reason: string };
}

/** How an accepted plan change is discharged: a packaging/ordering change settles without a plan edit. */
export function applyGuidance(a: Pick<Amendment, 'changes' | 'item'>): string {
  return a.changes && SETTLEABLE_CHANGES.includes(a.changes) ? `no plan edit needed: revise --settle ${a.item}` : 'edit the plan, then revise';
}

/** The revise steps that discharge the pending amendments: settle the packaging/ordering changes first, then edit for the rest. */
export function amendmentSteps(state: RunState, out: string): string {
  const pending = (state.amendments ?? []).filter(a => a.status === 'pending');
  const settle = pending.filter(a => applyGuidance(a).startsWith('no plan edit')).map(a => a.item ?? a.decision);
  const edit = pending.filter(a => !applyGuidance(a).startsWith('no plan edit')).map(a => a.decision);
  return [settle.length ? `gstack-autoplan revise --out ${out} --settle ${settle.join(',')}` : '',
    edit.length ? `edit the plan, then gstack-autoplan revise --out ${out} --plan ${state.plan_input ?? state.plan_source} --incorporates ${edit.join(',')}` : ''].filter(Boolean).join('; then ');
}

/** The owner's words must not contradict the relayed tokens: when they parse, both must resolve to the same choices. */
function checkOwnerReply(list: GateList, gateRev: number, prior: Record<string, string>, relayed: ParsedReply, ownerReply: string): boolean {
  const owner = parseReply(ownerReply, list, gateRev, prior);
  if (!owner.valid) return false;
  const choices = (p: ParsedReply) => JSON.stringify(p.choices.map(c => [c.id, c.chosen]).sort());
  if (choices(owner) !== choices(relayed) || owner.pending.join() !== relayed.pending.join()) {
    throw new RunError('GATE_OWNER_REPLY_MISMATCH', `the owner's reply ${JSON.stringify(ownerReply)} resolves to ${owner.choices.map(c => `${c.id}${c.chosen}`).join(' ')}${owner.pending.length ? ` (pending ${owner.pending.join(',')})` : ''}; the relayed reply resolves to ${relayed.choices.map(c => `${c.id}${c.chosen}`).join(' ')}${relayed.pending.length ? ` (pending ${relayed.pending.join(',')})` : ''}`, 3);
  }
  return true;
}

/**
 * Apply one reply. Earlier answers at this revision stand unless named again;
 * the gate stays pending until every approval settles. A chosen option with
 * `changes_plan` is an accepted plan change: it prints `APPLY:` and becomes a
 * pending amendment (status `amend_pending`); nothing reopens here. `revise`
 * reopens exactly the phases whose reviewed plan changed, and `revise
 * --settle` discharges a packaging/ordering change without an edit.
 */
export function answerGate(state: RunState, gateRev: number, reply: string, answeredBy?: string, o: AnswerOptions = {}): AnswerResult {
  const gateFile = path.join(state.out, 'gate.json');
  if (state.status !== 'gate_pending' || !fs.existsSync(gateFile)) throw new RunError('PHASE_NOT_AWAITING', `run is ${state.status}, not gate_pending`, 3);
  if (answeredBy !== undefined && !ANSWERED_BY_RE.test(answeredBy)) throw new RunError('ANSWER_BY_REQUIRED', `--by ${JSON.stringify(answeredBy)} is neither human nor agent:<id>`, 3);
  if (answeredBy === undefined && state.session_kind === 'unattended') throw new RunError('ANSWER_BY_REQUIRED', 'an unattended run records who answered; pass --by human or --by agent:<id>', 3);
  if (answeredBy?.startsWith('agent:') && o.ownerReply === undefined && !o.carry) throw new RunError('OWNER_REPLY_REQUIRED', `${answeredBy} relayed or decided this reply; pass the owner's words verbatim with --owner-reply "<text>" (or --owner-reply - / --owner-reply-file <path>)`, 3);
  const list = JSON.parse(fs.readFileSync(gateFile, 'utf8')) as GateList;
  const rows = readDecisions(state.out);
  const prior = Object.fromEntries(rows.filter(r => r.gate_rev === list.gate_rev && r.chosen != null && r.status !== 'pending' && r.label).map(r => [r.label!.toLowerCase(), r.chosen!]));
  const parsed = parseReply(reply, list, gateRev, prior);
  if (parsed.error === 'GATE_REV_STALE') throw new RunError('GATE_REV_STALE', `reply names gate_rev=${gateRev}, current gate_rev=${list.gate_rev}`, 3);
  if (!parsed.valid) throw new RunError('GATE_REPLY_UNPARSED', parsed.error === 'GATE_EMPTY' ? 'empty reply' : `unparsed: ${parsed.unparsed.join(', ')}`);
  const currentHash = recHash(list);
  if (o.recHash !== undefined && o.recHash !== currentHash) throw new RunError('GATE_REC_STALE', `--rec-hash ${o.recHash} was rendered before the recommendations changed; current rec_hash=${currentHash}`, 3);
  if (parsed.mode === 'rec' && list.rec_rev === undefined && o.recHash === undefined) throw new RunError('GATE_REC_STALE', `this gate was written before \`rec\`/\`all\` took plan changes (gate.json has no rec_rev), so the owner saw a different meaning; render it again (gstack-gate render ${gateFile} --all), relay it, and answer with --rec-hash ${currentHash}, or reply with explicit <id><option> tokens`, 3);
  if (parsed.mode === 'rec' && (list.rec_rev ?? 0) > 0 && o.recHash === undefined) throw new RunError('GATE_REC_STALE', `recommend changed this gate (rec_rev=${list.rec_rev}); pass --rec-hash from the render the owner saw (current rec_hash=${currentHash})`, 3);
  const ownerParsed = o.ownerReply !== undefined && !o.carry ? checkOwnerReply(list, gateRev, prior, parsed, o.ownerReply) : undefined;
  const provenance = o.carry ? { owner_reply: o.carry.words, carried_gate_from: o.carry.from, carried_gate_rev: o.carry.gate_rev, carry_reason: o.carry.reason, ...(o.carry.by ? { carried_answered_by: o.carry.by } : {}) }
    : o.ownerReply !== undefined ? { owner_reply: o.ownerReply, owner_reply_parsed: ownerParsed } : {};
  const itemOf = (id: string) => list.items.find(i => i.id === id)!;
  const optionOf = (c: GateChoice) => itemOf(c.id).options.find(o => o.key === c.chosen)!;
  const plan = parsed.choices.find(c => c.id === 'p1');
  const lines: string[] = o.carry ? [] : voidPendingCheck(state, `the owner answered gate_rev ${gateRev}`);
  const answeredAt = now();
  const record = () => writeDecisions(state.out, applyReply(rows, parsed, answeredAt, answeredBy, provenance).map(r => {
    const c = r.gate_rev === list.gate_rev && r.chosen && !r.chosen_text ? itemOf((r.label ?? '').toLowerCase())?.options.find(o => o.key === r.chosen) : undefined;
    return c ? { ...r, chosen_text: c.text } : r;
  }));
  if (!plan || parsed.pending.length) {
    // Approvals unanswered: record what was answered, keep the gate pending; nothing reviewed changes.
    record();
    const pending = parsed.pending.length ? parsed.pending : ['p1'];
    state.gate = { ...(state.gate ?? {}), last_reply: reply, pending };
    lines.push(`GATE_PENDING: ${pending.join(', ')} unanswered (${pendingHint(list, pending)})`);
    return { state, applied: true, pending, reopened: [], outcome: 'gate_pending', lines };
  }
  const proceeds = plan.chosen !== 'c' && plan.chosen !== 'e';
  const carried = (c: GateChoice) => itemOf(c.id).carried?.chosen === c.chosen;
  const changing = proceeds ? parsed.choices.filter(c => c.id !== 'p1' && !carried(c) && itemOf(c.id).reopens !== false && (optionOf(c).changes_plan ?? c.how === 'override')) : [];
  const tokens = (cs: GateChoice[]) => cs.map(c => `${c.id}${c.chosen}`);
  const overrides = parsed.choices.filter(c => c.how === 'override' && c.id !== 'p1');
  const reopenSet = new Set<Phase>(plan.chosen === 'd' ? state.phase_order : []);
  record();
  state.gate = { ...(state.gate ?? {}), answered_at: answeredAt, reply, gate_rev: gateRev, plan: plan.chosen, overrides: tokens(overrides), ...(answeredBy ? { answered_by: answeredBy } : {}), ...provenance };
  const answerClass = plan.chosen !== 'a' && plan.chosen !== 'b' ? `p1${plan.chosen}` : changing.length ? 'plan-changes' : overrides.length ? 'overrides' : 'as-recommended';
  journalRow(state.out, { event: 'answered', gate_rev: gateRev, reply, plan: plan.chosen, answer_class: answerClass, overrides: tokens(overrides), changes: tokens(changing), reopen: [...reopenSet], ...(answeredBy ? { answered_by: answeredBy } : {}), ...provenance });
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
  lines.push(...applyCapChoices(state, parsed.choices.filter(c => !carried(c)).map(c => ({ item: itemOf(c.id), chosen: c.chosen })), reopenSet as Set<string>, answeredBy));
  const acceptedPlan = changing.length ? reviewHash(fs.readFileSync(state.active_plan, 'utf8')) : '';
  for (const c of changing) {
    const item = itemOf(c.id);
    const amendment: Amendment = { decision: decisionId(state.run, gateRev, c.id), title: item.title, chosen: c.chosen, text: optionOf(c).text, gate_rev: gateRev, status: 'pending', at: answeredAt,
      item: c.id, ...(item.changes ? { changes: item.changes } : {}), ...(item.phase ? { phase: item.phase } : {}), plan_sha256: acceptedPlan };
    (state.amendments ??= []).push(amendment);
    journalRow(state.out, { event: 'amendment_pending', decision: amendment.decision, gate_rev: gateRev, ...(item.changes ? { changes: item.changes } : {}) });
    lines.push(`APPLY: ${amendment.decision} ${item.title} -> ${amendment.text}; ${applyGuidance(amendment)}`);
  }
  if (reopenSet.size) {
    const reopened = state.phase_order.filter(p => reopenSet.has(p));
    reopenPhases(state, reopened, gateRev, `gate_rev ${gateRev}: revise`);
    if (changing.length) state.status = 'amend_pending';
    lines.push(`REOPENED: ${reopened.join(',')} (Eng last) reason=revise`);
    const drift = driftLine(state, 'PLAN_SOURCE_CHANGED');
    if (drift) lines.push(drift);
    return { state, applied: true, pending: [], reopened, outcome: 'reopened', lines };
  }
  if (changing.length) {
    state.status = 'amend_pending';
    exportRun(state);
    lines.push(`AMEND_PENDING: ${changing.length} accepted change(s) not yet in the plan; nothing reopens until revise`);
    return { state, applied: true, pending: [], reopened: [], outcome: 'amend_pending', lines };
  }
  lines.push(...approve(state, answeredAt));
  const notes = overrides.filter(o => o.chosen !== keepDirection(itemOf(o.id)));
  lines.push(`APPROVED: gate_rev=${gateRev} ${notes.length ? `overrides=${tokens(notes).join(',')} (none change reviewed content)` : 'as-is'}`);
  return { state, applied: true, pending: [], reopened: [], outcome: 'complete', lines };
}

/** The run is approved: status complete, draft directions closed, files exported. */
export function approve(state: RunState, at: string): string[] {
  state.status = 'complete';
  const lines = closeDraftDirections(state, at.slice(0, 10));
  exportRun(state);
  return lines;
}

/** E3 phase-close operation: every `draft direction stands until the owner decides` line in the active plan becomes the decided option and date. */
export function closeDraftDirections(state: RunState, date: string): string[] {
  const loaded = loadBriefInputs(state.out);
  if ('error' in loaded) return [];
  const r = closeDraftDirectionsFile(state.active_plan, loaded.inputs, date);
  if (!r.rewrites.length) return [];
  journalRow(state.out, { event: 'draft_directions_closed', rewritten: r.rewrites.length - r.unresolved.length, unresolved: r.unresolved.map(u => u.line) });
  return [`DRAFT_DIRECTIONS: rewritten=${r.rewrites.length - r.unresolved.length} unresolved=${r.unresolved.length}`];
}

/** `<stem>.r<rev><ext>`, or `<stem>.r<rev>.v<k><ext>` when that name is taken: an archive is never overwritten. */
export function archiveName(out: string, name: string, gateRev: number, taken: Set<string>): string {
  const ext = path.extname(name);
  const stem = name.slice(0, -ext.length || undefined);
  for (let k = 1; ; k++) {
    const candidate = `${stem}.r${gateRev}${k > 1 ? `.v${k}` : ''}${ext}`;
    if (!taken.has(candidate) && !fs.existsSync(path.join(out, candidate))) { taken.add(candidate); return candidate; }
  }
}

/**
 * Reset the reopened phases in `state` (history, superseded open attempts,
 * artifacts) and return the archive renames still to perform, so a caller can
 * journal them before touching the directory (revise's transaction).
 */
export function planReopen(state: RunState, phases: Phase[], gateRev: number, reason: string): Array<[string, string]> {
  const taken = new Set<string>();
  const renames: Array<[string, string]> = [];
  const archive = (name: string) => { if (fs.existsSync(path.join(state.out, name))) renames.push([name, archiveName(state.out, name, gateRev, taken)]); };
  for (const phase of phases) {
    const ps = state.phases[phase] ?? {};
    state.history.push({ event: 'reopened', phase, gate_rev: gateRev, reason, at: now(), previous: ps });
    for (const voice of ['native', 'outside'] as const) {
      for (const a of ps[voice]?.attempts ?? []) {
        if (a.state !== 'dispatched' && a.state !== 'execution_unknown') continue;
        a.state = 'superseded'; a.terminal_at = now();
        settle(path.join(state.out, FILES.spend), a.attempt, 'unknown');
        journalRow(state.out, { event: 'superseded', attempt: a.attempt, phase, voice, reason });
      }
      const output = ps[voice]?.output;
      // A sealed copy is attempt-owned and immutable: it stays in place and bound; only a pre-seal output (bound at the result path) is archived.
      if (output && !output.endsWith('.bound.md')) { archive(`${output}.findings.jsonl`); archive(output); delete state.artifacts[output]; }
      archive(`${phase}-${voice}-prompt.md`);
    }
    archive(`${phase}-consensus.json`); archive(`${phase}-consensus.md`);
    delete state.artifacts[`${phase}-consensus.json`]; delete state.artifacts[`${phase}-consensus.md`];
    state.phases[phase] = {};
    journalRow(state.out, { event: 'reopened', phase, gate_rev: gateRev, reason });
  }
  archive('gate.json');
  delete state.artifacts['gate.json'];
  return renames;
}

/** Perform archive renames; a rename already done (source gone, target present) is skipped, so a recovery can replay the list. */
export function applyRenames(out: string, renames: Array<[string, string]>): void {
  for (const [from, to] of renames) {
    if (fs.existsSync(path.join(out, to))) continue;
    if (fs.existsSync(path.join(out, from))) fs.renameSync(path.join(out, from), path.join(out, to));
  }
}

/** Archive the reopened phases' bound files under their gate revision and reset them; the gate itself is archived too. */
export function reopenPhases(state: RunState, phases: Phase[], gateRev: number, reason: string): void {
  applyRenames(state.out, planReopen(state, phases, gateRev, reason));
  state.status = 'running';
  exportRun(state);
}
