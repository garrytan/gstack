/**
 * plan-record — whether a crew PR had its plan step (GST-1751, crew/docs/captain.md#plan-before-build). The brief's
 * `Plan:` line travels in the PR body (gstack-approvals render --plan writes it) and says which case applies:
 *
 *   Plan: approved: <token>    an owner-approved plan: `a-<12 hex>` is an approval row id; a path is an autoplan
 *                              run directory (its run.json names the run); anything else is a run id matched
 *                              against row sources `autoplan:<id>@gate_rev=<n>`
 *   Plan: approved (record r-<12 hex>)
 *                              the public-repo form render --plan writes (GST-1774): an opaque id of one approval row
 *                              (planRecordId), so no run id or path reaches public PR text or the READY note
 *   Plan: exempt: <reason>     one of the exemptions crew/docs/captain.md lists, or `crew:<rule>` for a crew's own
 *   Plan: required             the plan step has not finished
 *
 * The resolver reads every branch's file in the repository's approval store (the state root and each mirror this
 * machine can see), so a row imported under another branch or another lane still counts. A row answered in an
 * agent's own words, a newer gate revision that is not approved, and a ruling or grant row never count as the
 * owner's plan approval. gstack never infers the class from the diff, the title or the changelog: a PR with no line
 * reads as required. A run id, or a row id from an autoplan run, resolves to the newest gate revision imported into the
 * store (gateState), so a revised gate must be imported again before it counts. Callers: gstack-ship-queue ready (writes the record into the READY note), land (checks
 * it), gstack-ship-release finish --plan (/ship) and gstack-approvals render --plan / plan-check.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { agentNotesOrBody } from './agent-notes';
import { locate, type ApprovalRow, type Env } from './approval-record';
import type { ResultCodeName } from './result-codes';
import { isUnavailable, loadPolicyFromBase, type ShipPolicy } from './ship-policy';
import { readConfigKeyWithRoot, resolveStateRoot } from './state-root';

export const PLAN_MODES = ['off', 'warn', 'require'] as const;
export type PlanMode = typeof PLAN_MODES[number];
export const PLAN_RESOLVER_VERSION = 1;
export const EXEMPT_REASONS = ['bug fix', 's1', 'flaky', 'stamp', 'changelog-resolve', 'cap-repin', 'audited-list', 'read-only'] as const;

export type PlanDecl =
  | { kind: 'required'; line: string }
  | { kind: 'approved'; line: string; token: string }
  | { kind: 'exempt'; line: string; reason: string };
export interface PlanRecord { line: string; state: 'approved' | 'exempt'; ref?: string; row_id?: string; row_sha256?: string; reason?: string; resolver: number }
export interface PlanFailure { code: ResultCodeName; message: string; fix: string }
export type PlanResolution = { ok: true; record: PlanRecord; summary: string } | { ok: false; failure: PlanFailure };

const NOT_PLAN_ROW = /\b(ruled_note|gate_disposition|review_loop_grant|review_loop_exception|test_lane_exception)\b/;
const ROW_ID = /^a-[0-9a-f]{12}$/;
const RECORD_ID = /^r-[0-9a-f]{12}$/;
const LOCAL_SOURCE = 'state-root config';

/** The opaque id a public Plan line names instead of a run or row id: one approval row, stable as later rows are added. */
export const planRecordId = (rowId: string) => 'r-' + createHash('sha256').update(`plan-record\0${rowId}`).digest('hex').slice(0, 12);

/** `plan_record` in `<state root>/config.yaml` (gstack-config set plan_record …), read only when the state root is absolute. */
function localPlanMode(env: Env): { mode: PlanMode; source: string } | { ignored: string } | null {
  if (!path.isAbsolute(resolveStateRoot(env))) return null;
  const { value, root } = readConfigKeyWithRoot('plan_record', env);
  if (value === null) return null;
  const where = `${LOCAL_SOURCE} ${root}/config.yaml`;
  return (PLAN_MODES as readonly string[]).includes(value) ? { mode: value as PlanMode, source: where } : { ignored: `${where} plan_record "${value.slice(0, 20)}" ignored (off, warn or require)` };
}

/**
 * The mode in force: the base policy's plan_record when it is warn or require, else a crew opt-in (GSTACK_PLAN_RECORD),
 * else the machine's own plan_record (the untracked source for a repo that commits no .gstack/), else warn in a Capy
 * session, else off. A machine's key never loosens a tracked warn or require.
 */
export function planMode(policyValue: PlanMode | undefined, env: Env): { mode: PlanMode; source: string } {
  if (policyValue && policyValue !== 'off') return { mode: policyValue, source: 'base policy plan_record' };
  const opt = env.GSTACK_PLAN_RECORD;
  if (opt === 'warn' || opt === 'require') return { mode: opt, source: 'GSTACK_PLAN_RECORD' };
  const local = localPlanMode(env);
  if (local && 'mode' in local) return local;
  const ignored = local ? `; ${local.ignored}` : '';
  if (env.GSTACK_CAPY === '1') return { mode: 'warn', source: `Capy crew default${ignored}` };
  return { mode: 'off', source: `default${ignored}` };
}

/** Under off, the one PLAN: line ready, land and finish still print when the machine's key decided the mode or was ignored. */
const offNote = (mode: { mode: PlanMode; source: string }) => (mode.source.includes(LOCAL_SOURCE) ? `PLAN: off [mode off from ${mode.source}]` : undefined);

/**
 * The first `Plan:` line at the start of a line, outside fenced blocks; null when the body has none. A body with an
 * Agent notes section is read there only (lib/agent-notes.ts); a body without one is read whole.
 */
export function parsePlanLine(body: string): PlanDecl | null {
  const notes = agentNotesOrBody(body);
  return planLineIn(notes) ?? (notes === body ? null : planLineIn(body));
}

/** The first Plan line in the text, outside code fences. */
function planLineIn(text: string): PlanDecl | null {
  let fenced = false;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(raw)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const m = /^(?:\*\*)?Plan:(?:\*\*)?\s*(.*)$/.exec(raw.trim());
    if (!m) continue;
    const line = `Plan: ${m[1]!.trim()}`;
    const rest = m[1]!.trim();
    if (!/^(approved|exempt|required)(?=[\s:(]|$)/i.test(rest)) continue;
    const record = /^approved\s*\(\s*record\s+(r-[0-9a-f]{12})\s*\)/i.exec(rest);
    if (record) return { kind: 'approved', line, token: record[1]!.toLowerCase() };
    const approved = /^approved\s*:?\s*(\S+)/i.exec(rest);
    if (approved) return { kind: 'approved', line, token: approved[1]!.replace(/[),.;]+$/, '') };
    const exempt = /^exempt\s*:?\s*(.+)$/i.exec(rest);
    if (exempt) return { kind: 'exempt', line, reason: exempt[1]!.trim() };
    return { kind: 'required', line };
  }
  return null;
}

/** An exemption reason normalized to the list, or null: `bug fix (R65)` is `bug fix`; `crew:<rule>` names a crew's own. */
export function exemptReason(reason: string): string | null {
  const r = reason.replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase();
  if (/^crew:\s*\S/.test(r)) return r.replace(/^crew:\s*/, 'crew:');
  return (EXEMPT_REASONS as readonly string[]).includes(r) ? r : null;
}

/** Every approval row this machine can read for the repository, across branches; null when no store directory exists. */
const isRow = (r: any): r is ApprovalRow => r?.schema_version === 1 && ['id', 'ask', 'by', 'scope', 'pending', 'outcome', 'source', 'recorded_at', 'date'].every(k => typeof r[k] === 'string');

export function readStore(cwd: string, env: Env): { rows: ApprovalRow[]; dirs: string[] } | null {
  const loc = locate({ cwd, env, branch: 'plan-record-probe' });
  if ('code' in loc) return null;
  const dirs = [...new Set([loc.file, loc.mirror, ...(loc.read_also ?? [])].filter((f): f is string => !!f).map(f => path.dirname(f)))].filter(d => fs.existsSync(d));
  const byId = new Map<string, ApprovalRow>();
  const read: string[] = [];
  for (const dir of dirs) {
    let names: string[];
    try { names = fs.readdirSync(dir).filter(n => n.endsWith('.jsonl')); } catch { continue; }
    read.push(dir);
    for (const name of names) {
      let text = '';
      try { text = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }
      for (const l of text.split('\n')) {
        try { const r = JSON.parse(l); if (isRow(r)) byId.set(r.id, r); } catch { /* a torn line is skipped */ }
      }
    }
  }
  return read.length ? { rows: [...byId.values()], dirs: read } : null;
}

const agentWorded = (r: ApprovalRow & { words_by?: string }) => !!r.words_by || /its own decision \(not the owner's words\)/.test(r.by);
const rowSha = (r: ApprovalRow) => createHash('sha256').update(JSON.stringify(r)).digest('hex');

function runIdFor(token: string, cwd: string): string {
  const dir = path.resolve(cwd, token.replace(/^~(?=\/)/, process.env.HOME ?? '~'));
  if (!token.includes('/')) return token;
  try { return String(JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8')).run ?? path.basename(dir)); } catch { return path.basename(dir); }
}

/** Resolve a Plan line against the approval store; `changedOnly` lists the PR's changed paths for the changelog-only exemption. */
export function resolvePlan(decl: PlanDecl | null, o: { cwd: string; env: Env; changed?: string[]; fragmentsDir?: string }): PlanResolution {
  const fragDir = (o.fragmentsDir ?? 'changelog.d').replace(/\/+$/, '') + '/';
  if (!decl && o.changed?.length && o.changed.every(f => f.startsWith(fragDir))) {
    return { ok: true, record: { line: 'Plan: exempt: changelog-only', state: 'exempt', reason: 'changelog-only', resolver: PLAN_RESOLVER_VERSION }, summary: `exempt changelog-only (every changed path is under ${fragDir})` };
  }
  if (!decl) return { ok: false, failure: { code: 'PLAN_RECORD_MISSING', message: 'the PR body has no Plan: line, which reads as Plan: required', fix: "copy the brief's Plan line into the PR body (gstack-approvals render --plan \"<line>\" writes it under ## Approvals): Plan: approved: <run id or row id>, or Plan: exempt: <reason>" } };
  if (decl.kind === 'required') return { ok: false, failure: { code: 'PLAN_NOT_APPROVED', message: `${decl.line}: the plan step has not finished`, fix: 'run /autoplan (--kind feature), relay the gate, answer the owner\'s words into the run and gstack-approvals import --autoplan <run dir>, then set Plan: approved: <run id>' } };
  if (decl.kind === 'exempt') {
    const reason = exemptReason(decl.reason);
    if (!reason) return { ok: false, failure: { code: 'PLAN_EXEMPT_UNKNOWN', message: `${decl.line}: "${decl.reason}" is not an exemption crew/docs/captain.md lists (${EXEMPT_REASONS.join(', ')}, or crew:<rule>)`, fix: 'name a listed exemption from the brief, or plan the change: Plan: required' } };
    return { ok: true, record: { line: decl.line, state: 'exempt', reason, resolver: PLAN_RESOLVER_VERSION }, summary: `exempt ${reason}` };
  }
  try { return resolveApproved(decl, o); } catch (e: any) {
    return { ok: false, failure: { code: 'PLAN_STORE_UNAVAILABLE', message: `${decl.line}: the approval store could not be read (${String(e?.message ?? e).slice(0, 120)})`, fix: 'gstack-approvals list shows what is readable; repair or remove the broken store file, then rerun' } };
  }
}

const UNANSWERED = /^\d+ decision\(s\) unanswered/;

/**
 * An autoplan run's gate as the store records it: its newest imported gate revision, the newest answer to that
 * revision's plan approval, and whether any import of that revision saw no decision left unanswered. A row id from a
 * run stands for this state too, so an older revision's approval never outlives a newer revision.
 */
function gateState(rows: ApprovalRow[], run: string): { row: ApprovalRow } | { code: ResultCodeName; message: string } {
  const prefix = `autoplan:${run}@gate_rev=`;
  const rev = (r: ApprovalRow) => Number(/@gate_rev=(\d+)$/.exec(r.source)?.[1] ?? 0);
  const runRows = rows.filter(r => r.source.startsWith(prefix));
  if (!runRows.length) return { code: 'PLAN_UNRESOLVED', message: `no approval row from autoplan run ${run}` };
  const newest = Math.max(...runRows.map(rev));
  const revRows = runRows.filter(r => rev(r) === newest).sort((a, b) => b.recorded_at.localeCompare(a.recorded_at));
  const decided = revRows.find(r => r.outcome !== 'pending');
  if (!decided) return { code: 'PLAN_NOT_APPROVED', message: `autoplan run ${run} gate_rev ${newest} has no answer to its plan approval yet` };
  if (!revRows.some(r => !UNANSWERED.test(r.pending))) return { code: 'PLAN_NOT_APPROVED', message: `autoplan run ${run} gate_rev ${newest} still has decisions unanswered (${decided.pending})` };
  return { row: decided };
}

/** The approved branch of resolvePlan: a row id or a run id against the store. */
function resolveApproved(decl: Extract<PlanDecl, { kind: 'approved' }>, o: { cwd: string; env: Env }): PlanResolution {
  const store = readStore(o.cwd, o.env);
  if (!store) return { ok: false, failure: { code: 'PLAN_STORE_UNAVAILABLE', message: `${decl.line}: no approval store on this machine (the state root's approvals and every mirror are missing)`, fix: 'run this where the plan was approved, or gstack-approvals sync on the lane machine, then rerun' } };
  let row: ApprovalRow | undefined;
  let ref = decl.token;
  const byRecord = RECORD_ID.test(decl.token);
  if (byRecord || ROW_ID.test(decl.token)) {
    row = store.rows.find(r => (byRecord ? planRecordId(r.id) : r.id) === decl.token);
    if (!row && byRecord) return { ok: false, failure: { code: 'PLAN_UNRESOLVED', message: `${decl.line}: no approval row behind record ${decl.token} in ${store.dirs.join(', ')}${blockRecordIds(store.rows).has(decl.token) ? `; ${decl.token} is the Approvals block's id for a whole record, not a Plan line's` : ''}`, fix: 'paste the Plan line gstack-approvals render --plan printed, run ready where the plan was approved, or gstack-approvals sync, then rerun' } };
    if (!row) return { ok: false, failure: { code: 'PLAN_UNRESOLVED', message: `${decl.line}: no approval row ${decl.token} in ${store.dirs.join(', ')}`, fix: 'record the owner\'s words with gstack-approvals add (or import --autoplan), then cite the row id it prints' } };
    if (NOT_PLAN_ROW.test(row.ask) || NOT_PLAN_ROW.test(row.scope)) return { ok: false, failure: { code: 'PLAN_UNRESOLVED', message: `${decl.line}: row ${byRecord ? `behind ${decl.token}` : row.id} is a ruling or grant, not a plan approval`, fix: 'cite the row that recorded the owner\'s plan approval' } };
  }
  const run = row ? /^autoplan:(.+)@gate_rev=\d+$/.exec(row.source)?.[1] : runIdFor(decl.token, o.cwd);
  if (run) {
    const gate = gateState(store.rows, run);
    const where = byRecord ? `record ${decl.token}` : `autoplan run ${run}`;
    if ('message' in gate) return { ok: false, failure: { code: gate.code, message: `${decl.line}: ${byRecord ? gate.message.replace(`autoplan run ${run}`, where) : gate.message}`, fix: gate.code === 'PLAN_UNRESOLVED' ? `gstack-approvals import --autoplan <the run dir> --by "<owner>" after the owner's answer, then rerun` : 'finish the gate with the owner\'s answer and import it again' } };
    row = gate.row;
    if (!byRecord) ref = run;
  }
  if (!row) return { ok: false, failure: { code: 'PLAN_UNRESOLVED', message: `${decl.line}: no approval row in ${store.dirs.join(', ')}`, fix: 'cite an approval row id or an autoplan run id' } };
  const named = byRecord ? `the row behind ${decl.token}` : `row ${row.id}`;
  if (row.outcome !== 'approved') return { ok: false, failure: { code: 'PLAN_NOT_APPROVED', message: `${decl.line}: ${named}${byRecord ? '' : ` (${row.source})`} is ${row.outcome}`, fix: 'finish the gate with the owner\'s answer and import it again' } };
  if (agentWorded(row)) return { ok: false, failure: { code: 'PLAN_NOT_APPROVED', message: `${decl.line}: ${named} was answered in an agent's own words, not the owner's${byRecord ? '' : ` (${row.by})`}`, fix: 'relay the gate to the owner through the Captain and answer it with their exact words (--owner-reply), then import again' } };
  if (byRecord) {
    const rev = /@gate_rev=(\d+)$/.exec(row.source)?.[1];
    return { ok: true, record: { line: decl.line, state: 'approved', ref, row_sha256: rowSha(row), resolver: PLAN_RESOLVER_VERSION }, summary: `approved ${ref} (${rev ? `gate_rev ${rev}, ` : ''}${row.date})` };
  }
  return { ok: true, record: { line: decl.line, state: 'approved', ref, row_id: row.id, row_sha256: rowSha(row), resolver: PLAN_RESOLVER_VERSION }, summary: `approved ${ref} row=${row.id} (${row.ask.slice(0, 80)}; ${row.by.slice(0, 60)}, ${row.date})` };
}

/** The ids the redacted Approvals block prints for each branch's record (renderRecord), to name a pasted block id. */
function blockRecordIds(rows: ApprovalRow[]): Set<string> {
  const byBranch = new Map<string, string[]>();
  for (const r of rows) byBranch.set(r.branch, [...(byBranch.get(r.branch) ?? []), r.id]);
  return new Set([...byBranch.values()].map(ids => 'r-' + createHash('sha256').update(ids.sort().join('\n')).digest('hex').slice(0, 12)));
}

/** The Plan line render --plan prints on a public or unknown-visibility repo: a resolved approval by record id, any other line as is. */
export function publicPlanLine(decl: PlanDecl, res: PlanResolution): string {
  if (decl.kind !== 'approved' || !res.ok) return decl.line;
  const ref = res.record.ref ?? '';
  return `Plan: approved (record ${RECORD_ID.test(ref) ? ref : planRecordId(res.record.row_id!)})`;
}

/** The READY line for a resolution under a mode. */
export function planLine(res: PlanResolution, mode: { mode: PlanMode; source: string }): string {
  if (res.ok) return `PLAN: ${res.summary}`;
  return `PLAN: ${mode.mode === 'require' ? 'refused' : 'warn'} ${res.failure.message} (${res.failure.code}); fix: ${res.failure.fix} [mode ${mode.mode} from ${mode.source}]`;
}

/** ready's plan step: the PLAN: line, the record for the READY note when it resolved, and the refusal under require. */
export function readyPlan(o: { cwd: string; env: Env; body: string; policyValue?: PlanMode; changed: string[]; fragmentsDir?: string }): { line?: string; record?: PlanRecord; failure?: PlanFailure } {
  const mode = planMode(o.policyValue, o.env);
  const decl = parsePlanLine(o.body);
  if (mode.mode === 'off') {
    const note = offNote(mode);
    const line = note ? { line: note } : {};
    if (!decl) return line;
    try { const res = resolvePlan(decl, { cwd: o.cwd, env: o.env, changed: o.changed, fragmentsDir: o.fragmentsDir }); return res.ok ? { ...line, record: res.record } : line; } catch { return line; }
  }
  const res = resolvePlan(decl, { cwd: o.cwd, env: o.env, changed: o.changed, fragmentsDir: o.fragmentsDir });
  const line = planLine(res, mode);
  if (res.ok) return { line, record: res.record };
  return mode.mode === 'require' ? { line, failure: res.failure } : { line };
}

/** land's plan step: the READY note's record must exist and carry the PR body's current Plan line; land never needs the store. */
export function landPlan(o: { env: Env; policyValue?: PlanMode; record?: PlanRecord; body: string }): { line?: string; failure?: PlanFailure } {
  const mode = planMode(o.policyValue, o.env);
  if (mode.mode === 'off') { const note = offNote(mode); return note ? { line: note } : {}; }
  const current = parsePlanLine(o.body)?.line ?? null;
  const why = !o.record ? 'the READY note carries no plan record'
    : (current ?? 'Plan: exempt: changelog-only') !== o.record.line && !(current === null && o.record.reason === 'changelog-only') ? `the READY note recorded "${o.record.line}" but the PR body now says "${current ?? 'no Plan: line'}"` : null;
  if (!why) return { line: `PLAN: ${o.record!.state} ${o.record!.ref ?? o.record!.reason}${o.record!.row_id ? ` row=${o.record!.row_id}` : ''} (from the READY note)` };
  const failure: PlanFailure = { code: 'QUEUE_PLAN_MISMATCH', message: why, fix: 'the lane puts the brief\'s Plan line in the PR body (gstack-approvals render --plan) and reruns gstack-ship-queue ready --pr <n> at the pin, which records any line that resolves whatever its own mode' };
  return mode.mode === 'require' ? { line: `PLAN: refused ${why} (QUEUE_PLAN_MISMATCH)`, failure } : { line: `PLAN: warn ${why} (QUEUE_PLAN_MISMATCH) [mode ${mode.mode} from ${mode.source}]` };
}

/** /ship finish's plan step (gstack-ship-release finish --plan "<the brief's Plan line>"): the same resolution ready makes, run before the stages. */
export function finishPlan(cwd: string, base: string, line: string | undefined, env: Env = process.env): { line?: string; failure?: PlanFailure } {
  let policy: ShipPolicy | undefined;
  try { const loaded = loadPolicyFromBase(cwd, base); policy = isUnavailable(loaded) ? undefined : loaded.policy; } catch { policy = undefined; }
  const run = (args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  const ref = run(['rev-parse', '--verify', '-q', `origin/${base}`]).status === 0 ? `origin/${base}` : base;
  const changed = run(['diff', '--name-only', `${ref}...HEAD`]).stdout?.split('\n').filter(Boolean) ?? [];
  const body = line ? (/^\s*(\*\*)?Plan:/i.test(line) ? line.trim() : `Plan: ${line.trim()}`) : '';
  return readyPlan({ cwd, env, body, policyValue: policy?.plan_record, changed, fragmentsDir: policy?.changelog_fragments?.dir });
}
