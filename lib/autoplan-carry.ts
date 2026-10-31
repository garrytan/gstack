/**
 * autoplan-carry — carry the owner's last answer to a later gate revision (GSTA-155,
 * docs/unattended.md#carry-forward). When a gate_rev N+1 asks nothing the owner has not
 * already decided, the runner answers it with the owner's recorded gate_rev N words instead
 * of a second round trip, and records that it did (decisions.jsonl `carried_gate_from`,
 * journal `gate_carried`, `<out>/decisions.tsv`). It never invents an answer: every
 * carried answer is the owner's own earlier words, and every refusal says which condition failed.
 *
 * A carry needs all of: carry not turned off (`--no-carry-forward`); gate_rev N approved (p1 a or b)
 * with the owner's words recorded, and not itself a carry; every change accepted at N
 * incorporated or settled; the plan file unchanged since the gate or the revise that took those
 * changes, and the reviewed plan equal to it; no open urgent finding; and every new item already
 * carried. Two kinds of new item do not block: items a "do it" covers (the owner's words are
 * "do it": an auto item that changes no scope, cost or direction and is no round grant), and a
 * capped-delta item recommending "accept", which first gets one reviewer on just the delta
 * (`CARRY_CHECK:`, answered with `gstack-autoplan check`); a High or Critical finding there
 * means no carry, and the gate goes to the owner as before.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { attemptEstimate } from './autoplan-budget';
import { lineDiff } from './autoplan-confirm';
import { answerGate } from './autoplan-gate';
import { driftLine } from './autoplan-plan-text';
import { BOUNDARY, RESULT_FORMAT, REVIEWER_TRAILER } from './autoplan-prompts';
import { parseReviewResult } from './autoplan-reconcile';
import { FILES, RunError, journal, now, readDecisions, readJournal, readState, writeDecisions, writeState, type RunState } from './autoplan-state';
import { appendTrailRow } from './decision-trail';
import { decisionId, parseReply, type GateItem, type GateList } from './gate-list';
import { readJsonl } from './headless-artifacts';
import { modelFamily } from './outside-voice-runner';
import { release, reserve, settle } from './spend-ledger';

export const DEFAULT_CARRY_CHECK_CAP_USD = 5;
const HIGH = ['Critical', 'High'];
const DO_IT = /^\s*(?:(?![^:]*\bcaptain\b)[a-z]+(?: [a-z]+){0,2}:\s*)?do it[\s.!]*$/i;
/** The owner's verbatim words are a "do it" (optionally after their name), not a Captain's words or an item token (`p3b: do it`) naming one. */
export const isDoIt = (words: string | undefined): boolean => !!words && DO_IT.test(words);

export interface CarryCheck {
  attempt: string; prompt: string; result: string; delta_sha256: string; items: string[]; estimate_usd: number;
  status: 'dispatched' | 'passed' | 'failed' | 'unavailable'; model?: string; max_severity?: string; findings?: number; at: string;
}
export interface CarryRecord {
  gate_rev: number; from_gate_rev?: number; verdict: 'carried' | 'refused' | 'check_pending';
  reason: string; words?: string; under_do_it?: string[]; check?: CarryCheck; lines: string[]; at: string;
}

const sha256 = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const planFile = (state: RunState) => state.plan_input ?? state.plan_source;
const fileSha = (file: string) => (fs.existsSync(file) ? sha256(fs.readFileSync(file)) : undefined);
export const atGateCopy = (out: string, rev: number) => path.join(out, `plan-at-gate.r${rev}.md`);

/** What finishGate journals beside gate_written: the plan file's bytes and a copy of the reviewed plan the owner is asked about. */
export function gateEvidence(state: RunState, rev: number): { source_file_sha256?: string } {
  if (fs.existsSync(state.active_plan)) fs.copyFileSync(state.active_plan, atGateCopy(state.out, rev));
  return { source_file_sha256: fileSha(planFile(state)) };
}

/** The lines the latest carry decision printed, for the command that wrote this gate revision. */
export function carryLines(state: RunState): string[] {
  const c = state.carry;
  return c && c.gate_rev === state.gate_rev ? c.lines : [];
}

function record(state: RunState, c: Omit<CarryRecord, 'at'>): CarryRecord {
  const full = { ...c, at: now() };
  state.carry = full;
  journal(state.out, { event: c.verdict === 'carried' ? 'gate_carried' : c.verdict === 'check_pending' ? 'carry_check_dispatched' : 'carry_refused', gate_rev: c.gate_rev, from_gate_rev: c.from_gate_rev ?? null, reason: c.reason, ...(c.under_do_it?.length ? { under_do_it: c.under_do_it } : {}), ...(c.check ? { check: c.check.attempt, check_status: c.check.status } : {}) });
  appendTrailRow(path.join(state.out, 'decisions.tsv'), ['gate', c.verdict === 'carried' ? `carried gate_rev ${c.gate_rev} from gate_rev ${c.from_gate_rev}` : c.verdict === 'check_pending' ? `delta check before carrying gate_rev ${c.gate_rev}` : `no carry for gate_rev ${c.gate_rev}`,
    c.reason, c.check ? path.basename(c.check.result) : 'decisions.jsonl', c.check?.status ?? c.verdict]);
  return full;
}
const refuse = (state: RunState, rev: number, from: number | undefined, reason: string) => record(state, { gate_rev: rev, from_gate_rev: from, verdict: 'refused', reason, lines: [`CARRY: no (${reason})`] });

/** Drop a delta check still waiting for its reviewer (the owner answered, the plan was revised, a new gate was written) and release its reservation. */
export function voidPendingCheck(state: RunState, why: string): string[] {
  const c = state.carry;
  if (c?.verdict !== 'check_pending' || !c.check) return [];
  release(path.join(state.out, FILES.spend), c.check.attempt);
  const out = refuse(state, c.gate_rev, c.from_gate_rev, `delta check ${c.check.attempt} void: ${why}`);
  out.check = { ...c.check, status: 'unavailable' };
  return out.lines;
}

/** The reviewed plan's changes since the copy taken when the owner was asked at `rev`, and their hash. */
function deltaSince(state: RunState, rev: number): { diff: string; sha: string } | undefined {
  const before = atGateCopy(state.out, rev);
  if (!fs.existsSync(before)) return undefined;
  const diff = lineDiff(fs.readFileSync(before, 'utf8'), fs.readFileSync(state.active_plan, 'utf8')).filter(l => l.op !== ' ').map(l => `${l.op} ${l.text}`).join('\n');
  return { diff, sha: sha256(diff) };
}

interface Source { id: string; gate_rev: number; words: string; by?: string }
type Plan = { source: Source; doIt: GateItem[]; deltas: GateItem[] } | { reason: string; from?: number };

/** Every condition but the delta check; returns why not, or what the carry takes. */
function assess(state: RunState, prev: GateList, list: GateList): Plan {
  const from = prev.gate_rev;
  if (state.carry_forward === false) return { reason: 'carry-forward is off for this run (--no-carry-forward)', from };
  const p1 = readDecisions(state.out).find(r => r.gate_rev === from && (r.label ?? '').toLowerCase() === 'p1');
  if (!p1 || p1.status === 'pending' || !p1.answered_at) return { reason: `gate_rev ${from} was not answered`, from };
  const unanswered = readDecisions(state.out).find(r => r.gate_rev === from && r.status === 'pending');
  if (unanswered) return { reason: `gate_rev ${from} left ${unanswered.label ?? unanswered.id} unanswered`, from };
  if (p1.chosen !== 'a' && p1.chosen !== 'b') return { reason: `gate_rev ${from} answer was p1${p1.chosen}, not an approval`, from };
  if (p1.carried_gate_from) return { reason: `gate_rev ${from} was itself carried; the owner answers this one`, from };
  if (parseReply(p1.reply ?? '', prev).mode !== 'rec') return { reason: `gate_rev ${from} was answered with item tokens, not rec or "do it"`, from };
  const words = p1.owner_reply ?? (p1.answered_by === 'human' ? p1.reply : undefined);
  if (!words?.trim()) return { reason: `no owner words recorded at gate_rev ${from}`, from };
  const amendments = (state.amendments ?? []).filter(a => a.gate_rev === from);
  const open = amendments.find(a => a.status !== 'incorporated' && a.status !== 'settled');
  if (open) return { reason: `accepted change ${open.decision} is ${open.status}`, from };
  const journalRows = readJournal(state.out);
  const at = journalRows.map(r => r.event === 'gate_written' && r.gate_rev === from).lastIndexOf(true);
  let expected: string | undefined = at >= 0 ? journalRows[at]!.source_file_sha256 : undefined;
  for (const r of journalRows.slice(at + 1)) if (r.event === 'plan_revised') expected = r.source_file_sha256;
  if (!expected) return { reason: 'no plan evidence recorded for the gate or the revise (a run written before carry-forward)', from };
  if (fileSha(planFile(state)) !== expected) return { reason: `the plan file ${path.basename(planFile(state))} changed after the owner's answer or the revise that took it`, from };
  if (driftLine(state, 'PLAN_SOURCE_CHANGED')) return { reason: 'the reviewed plan differs from the plan file', from };
  const urgent = readJsonl(path.join(state.out, 'findings.jsonl')).rows.find(r => (r.urgent === true || r.outside_plan === true) && !r.settled_by);
  if (urgent) return { reason: `urgent finding open: ${String(urgent.title ?? urgent.id)}`, from };
  const doIt: GateItem[] = []; const deltas: GateItem[] = [];
  for (const item of list.items) {
    if (item.id === 'p1' || item.carried) continue;
    const option = item.options.find(o => o.key === item.recommended);
    if (item.cap?.kind === 'delta' && !option?.changes_plan && item.recommended === 'a') { deltas.push(item); continue; }
    if (isDoIt(words) && item.kind === 'auto' && !item.cap && !option?.changes_plan && !['scope', 'cost', 'direction'].includes(item.changes ?? '')) { doIt.push(item); continue; }
    return { reason: `new item ${item.id}: ${item.title}`, from };
  }
  return { source: { id: p1.id, gate_rev: from, words, by: p1.answered_by }, doIt, deltas };
}

/** Called by finishGate once gate_rev N+1 is written (status gate_pending): carry, set up the delta check, or say why not. */
export function evaluateCarry(state: RunState, prev: GateList | undefined, list: GateList): CarryRecord | undefined {
  voidPendingCheck(state, `gate_rev ${list.gate_rev} was written`);
  if (!prev || list.gate_rev < 2) return undefined;
  try {
    const plan = assess(state, prev, list);
    if ('reason' in plan) return refuse(state, list.gate_rev, plan.from, plan.reason);
    if (plan.deltas.length) return dispatchCheck(state, prev, list, plan);
    return carry(state, list, plan.source, plan.doIt, plan.deltas);
  } catch (e: any) {
    if (readDecisions(state.out).some(r => r.gate_rev === list.gate_rev && r.answered_at && !r.carried_from)) throw e;
    return refuse(state, list.gate_rev, prev.gate_rev, `error: ${e instanceof RunError ? `${e.detail} (${e.code})` : e?.message ?? e}`);
  }
}

function dispatchCheck(state: RunState, prev: GateList, list: GateList, plan: Extract<Plan, { source: Source }>): CarryRecord {
  const rev = list.gate_rev;
  const cap = state.carry_check_cap_usd ?? DEFAULT_CARRY_CHECK_CAP_USD;
  const estimate = attemptEstimate(state, undefined, process.env).usd;
  if (estimate > cap) return refuse(state, rev, prev.gate_rev, `delta check estimate ${estimate.toFixed(2)} is over the per-gate cap ${cap.toFixed(2)} (--carry-check-cap)`);
  const delta = deltaSince(state, prev.gate_rev);
  if (!delta) return refuse(state, rev, prev.gate_rev, `no copy of the plan the owner answered at gate_rev ${prev.gate_rev}`);
  const current = fs.readFileSync(state.active_plan, 'utf8');
  const { diff, sha: deltaSha } = delta;
  const attempt = `${state.run}-c${rev}`;
  const prompt = path.join(state.out, `carry-check-g${rev}-prompt.md`);
  const result = path.join(state.out, `carry-check-g${rev}.md`);
  try { reserve(path.join(state.out, FILES.spend), attempt, estimate, { cap: state.spend_cap_usd, label: 'carry-check' }); }
  catch (e: any) { return refuse(state, rev, prev.gate_rev, `delta check does not fit the run's spend cap: ${e?.message ?? e}`); }
  const accepted = (state.amendments ?? []).filter(a => a.gate_rev === prev.gate_rev).map(a => `- ${a.title} -> ${a.text}`).join('\n') || '- (none recorded)';
  fs.writeFileSync(prompt, [BOUNDARY, '',
    `You are checking one edit to a reviewed plan before gstack reuses the owner's approval of gate_rev ${prev.gate_rev} for gate_rev ${rev}. The owner accepted these changes:`, accepted, '',
    'The plan was edited after that answer, but the phases that would re-review the edit were at their round cap, so no reviewer has read it. Read the delta and say whether it implements the accepted changes, adds nothing the owner did not accept (scope, cost or direction), and leaves the plan correct. Rate a finding High or Critical only when the edit adds an unaccepted change, contradicts an accepted one, or would make the plan fail a test, break production, or lose data or secrets; anything else is Medium or lower.', '',
    `Delta (reviewed plan at gate_rev ${prev.gate_rev} -> now; + added, - removed; SHA-256 ${deltaSha}):`, '```diff', diff, '```', '',
    'The complete current plan follows as context.', '', current,
    REVIEWER_TRAILER, RESULT_FORMAT('carry-check', deltaSha, result)].join('\n'));
  const check: CarryCheck = { attempt, prompt, result, delta_sha256: deltaSha, items: plan.deltas.map(i => i.id), estimate_usd: estimate, status: 'dispatched', at: now() };
  const family = state.native_model ? `not ${modelFamily(state.native_model)}` : 'differs from the plan reviewers where available';
  return record(state, { gate_rev: rev, from_gate_rev: prev.gate_rev, verdict: 'check_pending', words: plan.source.words, under_do_it: plan.doIt.map(i => i.id), check,
    reason: `only an unreviewed post-cap delta is new (${check.items.join(',')}); one reviewer reads it first`,
    lines: [`CARRY_CHECK: attempt=${attempt} items=${check.items.join(',')} prompt=${prompt} result=${result} model_family=${family} estimate=${estimate.toFixed(2)} cap=${cap.toFixed(2)}`,
      `NEXT: dispatch one reviewer on the prompt, then gstack-autoplan check --out ${state.out} --attempt ${attempt} --result ${result} --model <id> (or --unavailable "<reason>" to relay the gate as today)`] });
}

function carry(state: RunState, list: GateList, source: Source, doIt: GateItem[], deltas: GateItem[], check?: CarryCheck): CarryRecord {
  const rev = list.gate_rev;
  const p1 = list.items.find(i => i.id === 'p1')!;
  const reply = list.items.map(i => `${i.id}${i.id === 'p1' ? p1.recommended : i.carried?.chosen ?? i.recommended}`).join(' ');
  const reason = [doIt.length || deltas.length ? '' : 'no new choice', doIt.length ? `"do it" covers ${doIt.map(i => i.id).join(',')}` : '', deltas.length ? `delta check passed on ${deltas.map(i => i.id).join(',')}` : '',
    'plan unchanged since the accepted changes'].filter(Boolean).join('; ');
  const answered = answerGate(state, rev, reply, 'agent:gstack-autoplan', { carry: { from: source.id, gate_rev: source.gate_rev, words: source.words, by: source.by, reason } });
  const marks = new Map<string, Record<string, string>>([...doIt.map(i => [decisionId(list.run, rev, i.id), { carried_under: 'do it' }] as const), ...deltas.map(i => [decisionId(list.run, rev, i.id), { carry_check: check?.attempt ?? '' }] as const)]);
  if (marks.size) writeDecisions(state.out, readDecisions(state.out).map(r => (marks.has(r.id) ? { ...r, ...marks.get(r.id) } : r)));
  const lines = [`CARRIED: gate_rev=${rev} <- gate_rev=${source.gate_rev} words=${JSON.stringify(source.words)} by=${source.by ?? 'unknown'} reason=${reason}`,
    ...doIt.map(i => `CARRIED_UNDER_DO_IT: ${i.id} ${i.title} -> ${i.options.find(o => o.key === i.recommended)?.text ?? i.recommended} (the owner has not seen this item)`),
    ...answered.lines];
  return record(state, { gate_rev: rev, from_gate_rev: source.gate_rev, verdict: 'carried', reason, words: source.words, under_do_it: doIt.map(i => i.id), ...(check ? { check } : {}), lines });
}

export interface CheckOptions { out: string; attempt?: string; result?: string; model?: string; unavailable?: string; sameFamily?: string }

/** `gstack-autoplan check`: bind the delta reviewer's result (or its absence) and carry, or leave the gate for the owner. */
export function submitCarryCheck(o: CheckOptions): { state: RunState; lines: string[] } {
  const state = readState(path.resolve(o.out));
  const c = state.carry;
  if (!c || c.verdict !== 'check_pending' || !c.check || state.status !== 'gate_pending' || c.gate_rev !== state.gate_rev) throw new RunError('PHASE_NOT_AWAITING', `no delta check is pending (run is ${state.status}, gate_rev=${state.gate_rev ?? 'none'})`, 3);
  const check = c.check;
  if (o.attempt !== check.attempt) throw new RunError('ATTEMPT_MISMATCH', `pass --attempt ${check.attempt}`, 3);
  const stale = readDecisions(state.out).some(r => r.gate_rev === c.gate_rev && r.answered_at && !r.carried_from) ? `the owner answered gate_rev ${c.gate_rev}`
    : deltaSince(state, c.from_gate_rev ?? 0)?.sha !== check.delta_sha256 ? 'the plan changed after the delta check was dispatched' : undefined;
  if (stale) {
    const lines = voidPendingCheck(state, stale);
    writeState(state);
    return { state, lines };
  }
  const gateFile = path.join(state.out, 'gate.json');
  const list = JSON.parse(fs.readFileSync(gateFile, 'utf8')) as GateList;
  const spend = path.join(state.out, FILES.spend);
  let out: CarryRecord;
  if (o.unavailable !== undefined) {
    release(spend, check.attempt);
    list.carry_check = { attempt: check.attempt, model: 'none', verdict: 'unavailable', max_severity: 'none', findings: 0, at: now() };
    fs.writeFileSync(gateFile, JSON.stringify(list, null, 2) + '\n');
    out = refuse(state, c.gate_rev, c.from_gate_rev, `delta check unavailable: ${o.unavailable}`);
    out.check = { ...check, status: 'unavailable' };
  } else {
    if (!o.result || !o.model) throw new RunError('RESULT_RECEIPT_MISSING', 'check needs --result <file> and --model <id>, or --unavailable "<reason>"', 3);
    if (!fs.existsSync(o.result)) throw new RunError('RESULT_RECEIPT_MISSING', `result file not found: ${o.result}`);
    const family = modelFamily(o.model);
    const author = state.native_model ? modelFamily(state.native_model) : undefined;
    if (!o.sameFamily && (family === 'unknown' || family === author)) throw new RunError('MODEL_FAMILY_CONFLICT', `${o.model} is ${family === 'unknown' ? 'of no recognized family' : `the plan reviewers' family (${family})`}; use another family, or pass --same-family "<why none is available>"`, 3);
    const text = fs.readFileSync(o.result, 'utf8');
    const parsed = parseReviewResult(text, { phase: 'carry-check', sha256: check.delta_sha256 });
    if (!parsed.receipt.ok) throw new RunError('RESULT_RECEIPT_MISSING', parsed.errors[0]!);
    if (!parsed.fenceFound || parsed.errors.length) throw new RunError('RESULT_FINDINGS_MISSING', parsed.errors.join('; '));
    fs.writeFileSync(path.join(state.out, `carry-check-g${c.gate_rev}.bound.md`), text, process.platform === 'win32' ? {} : { mode: 0o444 });
    settle(spend, check.attempt, 'unknown');
    const order = ['Informational', 'Low', 'Medium', 'High', 'Critical'];
    const max = parsed.findings.map(f => String(f.severity)).reduce((a, b) => (order.indexOf(b) > order.indexOf(a) ? b : a), 'none');
    const blocking = parsed.findings.find(f => HIGH.includes(String(f.severity)));
    const done: CarryCheck = { ...check, status: blocking ? 'failed' : 'passed', model: o.model, max_severity: max, findings: parsed.findings.length, at: now() };
    list.carry_check = { attempt: check.attempt, model: o.model + (o.sameFamily ? ` (same family: ${o.sameFamily})` : ''), verdict: blocking ? 'failed' : 'passed', max_severity: max, findings: parsed.findings.length, at: done.at };
    if (blocking) for (const item of list.items) if (check.items.includes(item.id)) (item.flags ??= []).push(`carry check ${o.model}: ${blocking.severity} ${blocking.title}`);
    fs.writeFileSync(gateFile, JSON.stringify(list, null, 2) + '\n');
    if (blocking) {
      out = refuse(state, c.gate_rev, c.from_gate_rev, `delta check found ${blocking.severity}: ${blocking.title}`);
      out.check = done;
    } else {
      const plan = assess(state, { ...list, gate_rev: c.from_gate_rev! } as GateList, list);
      if ('reason' in plan) { out = refuse(state, c.gate_rev, c.from_gate_rev, plan.reason); out.check = done; }
      else {
        out = carry(state, list, plan.source, plan.doIt, plan.deltas, done);
        out.lines.unshift(`CARRY_CHECK: passed attempt=${check.attempt} model=${o.model} findings=${done.findings} highest=${max}`);
      }
    }
  }
  writeState(state);
  return { state, lines: out.lines };
}
