/**
 * autoplan-export — the B0 file set written beside the active plan (plan
 * B2): `plan.md` (the `## URGENT, outside this plan` block above the
 * `## Implementation plan` section; warns above 30 KB), `review-record.md`
 * (the `## Review record` section plus the run log: phases, voices, consensus
 * tables, the gate and the GUARD_NOT_INSTALLED line the validator requires),
 * `findings.jsonl`, `tasks.jsonl`, `decisions.jsonl` (already written by the
 * gate), `timing.json`, and `run.json` with every artifact's path and hash
 * and the counts `gstack-artifact validate` checks against the files, plus
 * the reviewer dispatch counts and their relative input-token estimate. The
 * snapshot bin stays unchanged: this is `gstack-autoplan export --out <dir>`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PHASES } from './autoplan-prompts';
import type { ConsensusRecord } from './autoplan-reconcile';
import { decisionId } from './gate-list';
import { readDecisions, readJournal, voiceRows, type DispatchCounts, type RunState, type Voice } from './autoplan-state';
import type { FindingRow, TaskRow } from './headless-artifacts';
import { readJsonl, renderUrgentBlock, sha256File } from './headless-artifacts';

export const PLAN_WARN_BYTES = 30_000;

export function buildTasks(state: RunState, findings: FindingRow[]): TaskRow[] {
  const tasks: TaskRow[] = [];
  const covered = new Set<string>();
  const blockedBy = state.ceo_only ? [] : [decisionId(state.run, state.gate_rev ?? 1, 'p1')];
  let n = 0;
  for (const f of findings as Array<FindingRow & { settled_by?: string }>) {
    if (f.settled_by || covered.has(f.id)) continue;
    if (f.disposition === 'deferred') {
      covered.add(f.id);
      tasks.push({ schema_version: 2, run: state.run, id: `${state.run}-T${++n}`, title: `deferred from ${f.phase}: ${f.title}`, status: 'pending', depends_on: [], findings: [f.id],
        blocked_by: blockedBy, acceptance: f.resolution ? f.resolution : `the build resolves: ${f.title}`, priority: f.severity, ...(f.file ? { files: [f.file] } : {}), item: f.phase });
      continue;
    }
    if (!['Critical', 'High'].includes(f.severity) || f.disposition === 'rejected') continue;
    const twin = typeof f.native_counterpart === 'string' ? f.native_counterpart : findings.find(x => x.native_counterpart === f.id)?.id;
    const ids = twin ? [f.id, twin] : [f.id];
    ids.forEach(id => covered.add(id));
    tasks.push({ schema_version: 2, run: state.run, id: `${state.run}-T${++n}`, title: f.title, status: state.ceo_only ? 'pending' : 'blocked_on_decision', depends_on: [], findings: ids,
      blocked_by: blockedBy, acceptance: f.resolution ? f.resolution : `reviewer re-verifies: ${f.title}`, priority: f.severity, ...(f.file ? { files: [f.file] } : {}), item: f.phase });
  }
  return tasks;
}

/** Aggregate findings across phases and voices, carrying the reconciliation into each row. */
export function aggregateFindings(state: RunState): FindingRow[] {
  const out: FindingRow[] = [];
  for (const phase of state.phase_order) {
    const ps = state.phases[phase];
    if (!ps?.closed_at) continue;
    const consensus = JSON.parse(fs.readFileSync(path.join(state.out, `${phase}-consensus.json`), 'utf8')) as ConsensusRecord;
    const byOutside = new Map(consensus.rows.map(r => [r.outside_id, r]));
    // A phase closed accepted-with-findings: its open rows (and the rows it carried from the round last reviewed) are deferred to the build.
    const deferred = (row: FindingRow) => (ps.deferred && !(row as { settled_by?: string }).settled_by ? { disposition: 'deferred' as const } : {});
    for (const row of voiceRows(state, phase, 'native')) out.push({ ...row, native_counterpart: null, ...deferred(row) });
    for (const row of voiceRows(state, phase, 'outside')) {
      const r = byOutside.get(row.id);
      out.push({ ...row, native_counterpart: r?.disposition === 'unverified' ? null : r?.native_id ?? null, ...(r ? { reconciliation: r.disposition, reconciliation_resolution: r.resolution } : {}), ...deferred(row) } as FindingRow);
    }
    const carried = ps.deferred?.carried_file && path.join(state.out, ps.deferred.carried_file);
    if (carried && fs.existsSync(carried)) out.push(...(readJsonl(carried).rows as unknown as FindingRow[]).map(row => ({ ...row, native_counterpart: null, disposition: 'deferred' as const })));
  }
  return out;
}


export function sections(activePlan: string): { implementation: string; record: string } {
  const text = fs.readFileSync(activePlan, 'utf8');
  const impl = text.indexOf('\n## Implementation plan');
  const rec = text.indexOf('\n## Review record');
  if (impl < 0 || rec < 0 || rec < impl) return { implementation: text, record: '' };
  const implStart = text.indexOf('\n', impl + 1) + 1;
  const recStart = text.indexOf('\n', rec + 1) + 1;
  return { implementation: text.slice(implStart, rec + 1), record: text.slice(recStart) };
}

function runLog(state: RunState, findings: number, tasks: number, decisions: { total: number; pending: number }): string {
  const lines = [
    `### gstack-autoplan run log (run ${state.run}, session_kind ${state.session_kind}, status ${state.status})`,
    '',
    `Host: ${state.host}. Scope: UI ${state.scope.ui ? 'yes' : 'no'} (${state.scope.ui_matches} matches); DX ${state.scope.dx ? 'yes' : 'no'} (${state.scope.dx_matches} term matches${state.scope.developer_tool ? ', developer tool' : ''}${state.scope.agent_primary ? ', agent primary' : ''}). Phase order: ${state.phase_order.join(' → ')}.`,
    ...(state.deviations ?? []).map(d => `Deviation: ${d}`),
    '',
  ];
  for (const phase of PHASES) {
    const ps = state.phases[phase];
    if (!ps) { lines.push(`#### ${phase}: not reached`, ''); continue; }
    if (ps.skipped) { lines.push(`#### ${phase}: skipped (${ps.skipped})`, ''); continue; }
    const voice = (v: 'native' | 'outside') => { const s = ps[v]; return `${v} ${s?.status ?? 'pending'}${s?.model ? ` (model ${s.model}${s.provider ? `, provider ${s.provider}` : ''}, ${s.findings ?? 0} findings, sha256 ${(s.result_sha256 ?? '').slice(0, 12)})` : ''}`; };
    lines.push(`#### ${phase}: ${ps.closed_at ? `closed ${ps.closed_at}` : ps.snapshot ? 'open' : 'pending'}; snapshot ${ps.snapshot ?? '—'}`, '', `- ${voice('native')}`, `- ${voice('outside')}`, '');
    const consensus = path.join(state.out, `${phase}-consensus.md`);
    if (fs.existsSync(consensus)) lines.push('```', fs.readFileSync(consensus, 'utf8').trimEnd(), '```', '');
  }
  for (const h of state.history) lines.push(`Reopened ${h.phase} at gate_rev ${h.gate_rev}: ${h.reason} (${h.at})`);
  if (state.history.length) lines.push('');
  const budget = [
    ...state.phase_order.flatMap(p => { const d = state.phases[p]?.deferred; return d ? [`Deferred ${p} at round ${d.round} (${d.cause}, by ${d.by}): ${d.reason}; ${d.open} open finding(s) carried into tasks.jsonl; owner items: ${d.blockers.join(', ') || 'none'}`] : []; }),
    ...(state.capped_deltas ?? []).map(d => `Plan changed after the ${d.phase} cap (revise v${d.k}, round ${d.round} of ${d.cap}): +${d.added} -${d.removed} lines unreviewed; ${d.status}`),
    ...[...(state.stops ?? []), ...(state.stop ? [state.stop] : [])].map(s => `Stopped ${s.reason} at ${s.at}: cap ${s.cap_usd ?? 'none'}, spent ${s.spent}, reserved ${s.reserved}, unknown ${s.unknown}${s === state.stop ? '' : ' (lifted)'}`),
  ];
  if (budget.length) lines.push(`Budget: max_rounds ${state.max_rounds ?? 'none'}${state.round_grants ? `, grants ${JSON.stringify(state.round_grants)}` : ''}.`, ...budget, '');
  lines.push(`Gate: ${state.ceo_only ? 'none (CEO-only run: ceo-review.md, never approved)' : state.gate_rev ? `gate_rev ${state.gate_rev}, ${decisions.total} decisions (${decisions.pending} pending)${state.gate && typeof (state.gate as any).reply === 'string' ? `; answered "${(state.gate as any).reply}"${typeof (state.gate as any).answered_by === 'string' ? ` answered by ${(state.gate as any).answered_by}` : ''}` : ''}` : 'not reached'}. Findings: ${findings}. Tasks: ${tasks}.`);
  return lines.join('\n') + '\n';
}

export interface ExportResult { warnings: string[]; files: string[] }

/** Every dispatched attempt in attempts.jsonl, whatever became of it; prompt bytes come from the row (older rows: the prompt file if still on disk). */
export function dispatchStats(out: string): { dispatches: DispatchCounts; est_input_tokens: number } {
  const dispatches: DispatchCounts = { total: 0, by_phase: {} };
  let bytes = 0;
  for (const r of readJournal(out)) {
    if (r.event !== 'dispatched') continue;
    const by = (dispatches.by_phase[r.phase] ??= {});
    by[r.voice as Voice] = (by[r.voice as Voice] ?? 0) + 1;
    dispatches.total += 1;
    const file = typeof r.prompt === 'string' ? path.resolve(out, r.prompt) : '';
    bytes += typeof r.prompt_bytes === 'number' ? r.prompt_bytes : file && fs.existsSync(file) ? fs.statSync(file).size : 0;
  }
  return { dispatches, est_input_tokens: Math.round(bytes / 4) };
}
export const dispatchLine = (state: RunState) => `DISPATCHES: ${state.dispatches?.total ?? 0} est_input_tokens=${state.est_input_tokens ?? 0} (relative estimate)`;

/** Write the file set and bind every artifact into run.json (counts and hashes); the caller writes run.json. */
export function exportRun(state: RunState): ExportResult {
  const warnings: string[] = [];
  const { implementation, record } = sections(state.active_plan);
  const findings = aggregateFindings(state);
  const tasks = buildTasks(state, findings);
  const decisions = readDecisions(state.out);
  const write = (name: string, body: string) => {
    const file = path.join(state.out, name);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);
    state.artifacts[name] = { path: name, sha256: sha256File(file) };
    return file;
  };
  const planBody = `${renderUrgentBlock(findings as unknown as Record<string, unknown>[])}\n## Implementation plan\n${implementation}`;
  if (Buffer.byteLength(planBody) > PLAN_WARN_BYTES) warnings.push(`plan.md is ${Buffer.byteLength(planBody)} bytes (> ${PLAN_WARN_BYTES}); reviewers read all of it`);
  const files = [
    write('plan.md', planBody),
    write('review-record.md', `## Review record\n${record.trimEnd()}\n\n${runLog(state, findings.length, tasks.length, { total: decisions.length, pending: decisions.filter(d => d.status === 'pending').length })}`),
    write('findings.jsonl', findings.map(r => JSON.stringify(r)).join('\n') + (findings.length ? '\n' : '')),
    write('tasks.jsonl', tasks.map(r => JSON.stringify(r)).join('\n') + (tasks.length ? '\n' : '')),
  ];
  if (fs.existsSync(path.join(state.out, 'decisions.jsonl'))) { state.artifacts['decisions.jsonl'] = { path: 'decisions.jsonl', sha256: sha256File(path.join(state.out, 'decisions.jsonl')) }; files.push(path.join(state.out, 'decisions.jsonl')); }
  if (fs.existsSync(path.join(state.out, 'timing.json'))) { state.artifacts['timing.json'] = { path: 'timing.json', sha256: sha256File(path.join(state.out, 'timing.json')) }; files.push(path.join(state.out, 'timing.json')); }
  if (fs.existsSync(path.join(state.out, 'gate.json'))) { state.artifacts['gate.json'] = { path: 'gate.json', sha256: sha256File(path.join(state.out, 'gate.json')) }; files.push(path.join(state.out, 'gate.json')); }
  for (const phase of state.phase_order) for (const name of [`${phase}-consensus.md`, `${phase}-consensus.json`]) {
    if (fs.existsSync(path.join(state.out, name))) state.artifacts[name] = { path: name, sha256: sha256File(path.join(state.out, name)) };
  }
  Object.assign(state, dispatchStats(state.out));
  state.counts = { decisions: decisions.length, decisions_pending: decisions.filter(d => d.status === 'pending').length, findings: findings.length, tasks: tasks.length };
  return { warnings, files };
}
