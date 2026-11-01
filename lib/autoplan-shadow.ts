/**
 * autoplan-shadow — shadow mode for the CEO-only decider (GST-537 PR 3,
 * docs/unattended.md#shadow-mode). In a driver run that turned it on at init
 * (`autoplan_shadow on` or GSTACK_AUTOPLAN_SHADOW=1; off by default), every
 * gate the driver publishes gets one hidden model prediction per question,
 * written before anyone answers: action (decide, send_back, hold), pick,
 * confidence, cites and reason, beside the free keep-direction rule's pick.
 * Nothing routes differently and a shadow failure never blocks a gate or an
 * answer. The decider prompt is the frozen, hand-written
 * autoplan/shadow-decider.md (its sha256 is pinned below and on every row).
 *
 * The publication is two-phase so the run lock is never held during the call:
 * `claimShadow` runs under the run lock of the command that wrote the gate and
 * takes a lease (`<run>/shadow/r<rev>.pending`: pid, host, deadline; journaled
 * `shadow_pending`); `runShadow` calls the model with no lock held (each call
 * reserved under its own ledger id labeled `shadow` and journaled
 * `shadow_dispatched` before the send), then retakes the lock with a bounded
 * wait and publishes `<run>/shadow/ceo-only.r<rev>.jsonl` with link (a second
 * writer never overwrites) plus `shadow_recorded` or `shadow_failed`. A live
 * lease makes every other writer pay nothing, and `answer` waits for it
 * (`shadowBeforeAnswer`). Only a dead lease (its pid gone, or past its
 * deadline) is a crash: its dispatched calls settle `unknown`, never released,
 * and `answer` then records the revision with every row `retrospective`.
 * This module is the only one that names the shadow folder's paths; the reader
 * for gstack-evals and the private validate check are in
 * lib/autoplan-shadow-reader.ts.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { extractHeading } from './autoplan-prompts';
import { GSTACK_VERSION } from './autoplan-migrate';
import { withRunLock } from './autoplan-run';
import { FILES, RunError, journal, now, readJournal, readState, voiceRows, type RunState } from './autoplan-state';
import { decisionId, recHash, ruleKept, type GateItem, type GateList } from './gate-list';
import type { FindingRow } from './headless-artifacts';
import { readJsonl } from './headless-artifacts';
import { apiKeyFor, callModel, type ApiCallResult } from './outside-voice-api';
import { modelFamily } from './outside-voice-runner';
import { estimateCostUsd, hasPricing } from './pricing';
import { readLedger, release, reserve, settle, summarize } from './spend-ledger';
import { resolveSourceRoot } from './source-root';
import { readConfigKey } from './state-root';

export const SHADOW_PROMPT_VERSION = 1;
/** sha256 of autoplan/shadow-decider.md at SHADOW_PROMPT_VERSION; a prompt edit bumps both (test/autoplan-shadow.test.ts). */
export const SHADOW_PROMPT_SHA256 = 'e4857932ae831b7a6d933c42c182ccd7711c68338fec6901799264f645589344';
export const DEFAULT_SHADOW_MODEL = 'claude-opus-5-5';
/** One deadline for the call and its one retry. */
export const SHADOW_DEADLINE_MS = 90_000;
export const SHADOW_MAX_TOKENS = 4_000;
/** A reply cut at the output limit is asked once more at this limit, inside the same deadline. */
export const SHADOW_RAISED_MAX_TOKENS = 8_000;
export const SHADOW_SINK = 'autoplan-shadow';
export const SHADOW_CONSENT = 'autoplan_shadow on';
const PLAN_CHARS = 40_000;
const REASON_CHARS = 400;
const RELOCK_MS = 30_000;
const LEASE_GRACE_MS = 30_000;
export const SHADOW_ACTIONS = ['decide', 'send_back', 'hold'] as const;
const ROOT = path.resolve(import.meta.dir, '..');

export const shadowPromptFile = () => path.join(resolveSourceRoot(ROOT), 'autoplan', 'shadow-decider.md');
export const shadowDir = (out: string) => path.join(out, 'shadow');
export const recordFile = (out: string, rev: number) => path.join(shadowDir(out), `ceo-only.r${rev}.jsonl`);
export const RECORD_RE = /^ceo-only\.r(\d+)\.jsonl$/;
const leaseFile = (out: string, rev: number) => path.join(shadowDir(out), `r${rev}.pending`);
const saltFile = (out: string) => path.join(shadowDir(out), 'salt');
const sha256 = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// the switch, fixed at init
// ---------------------------------------------------------------------------
export interface ShadowSwitch { enabled: boolean; model?: string; reason?: string; source: 'env' | 'config' | 'default' }

/**
 * GSTACK_AUTOPLAN_SHADOW (1|on|0|off), else gstack-config autoplan_shadow (default off). On also needs a priced model
 * (autoplan_shadow_model, default claude-opus-5-5), its family's API key, and a run that is neither --no-outside nor
 * CEO-only. Stored in run.json at init and never re-read. The line is printed only when shadow was asked for.
 */
export function shadowSwitch(o: { outsideEnabled: boolean; ceoOnly: boolean }, env: NodeJS.ProcessEnv = process.env): { shadow: ShadowSwitch; line?: string } {
  const fromEnv = !!env.GSTACK_AUTOPLAN_SHADOW?.trim();
  const value = (fromEnv ? env.GSTACK_AUTOPLAN_SHADOW! : readConfigKey('autoplan_shadow', env) ?? '').trim().toLowerCase();
  const source = fromEnv ? 'env' as const : value ? 'config' as const : 'default' as const;
  const label = fromEnv ? `GSTACK_AUTOPLAN_SHADOW=${value}` : `autoplan_shadow ${value}`;
  const off = (reason: string) => ({ shadow: { enabled: false, reason, source }, line: `SHADOW: off (${reason})` });
  if (!value || value === 'off' || value === '0') return { shadow: { enabled: false, reason: source === 'default' ? 'off by default' : label, source } };
  if (value !== 'on' && value !== '1') return off(`${label} is not on or off`);
  if (o.ceoOnly) return off('a CEO-only run writes no gate');
  if (!o.outsideEnabled) return off('--no-outside');
  const model = (readConfigKey('autoplan_shadow_model', env) ?? '').trim() || DEFAULT_SHADOW_MODEL;
  const family = modelFamily(model);
  const keyName = family === 'openai' ? 'OPENAI_API_KEY' : family === 'anthropic' ? 'ANTHROPIC_API_KEY' : `no API transport for family ${family}`;
  if (!apiKeyFor(family, env)) return off(`no API key for ${model} (${keyName})`);
  if (!hasPricing(model)) return off(`${model} has no price in lib/pricing.ts, so --spend-cap cannot bound it`);
  return { shadow: { enabled: true, model, source }, line: `SHADOW: on model=${model} (${label}); one hidden model call per gate page, counted against --spend-cap` };
}

// ---------------------------------------------------------------------------
// the lease
// ---------------------------------------------------------------------------
interface Lease { gate_rev: number; pid: number; host: string; started_at: string; deadline: string; retrospective: boolean }
export interface ShadowClaim { gate_rev: number; retrospective: boolean }

function readLease(out: string, rev: number): Lease | undefined {
  try { return JSON.parse(fs.readFileSync(leaseFile(out, rev), 'utf8')) as Lease; } catch { return undefined; }
}
/** Live: before its deadline plus a grace, and (on this host) its pid still running. */
function leaseLive(l: Lease, at = Date.now()): boolean {
  if (!(at <= Date.parse(l.deadline) + LEASE_GRACE_MS)) return false;
  if (l.host !== os.hostname()) return true;
  try { process.kill(l.pid, 0); return true; } catch (e: any) { return e.code === 'EPERM'; }
}
function dropLease(out: string, rev: number): void {
  const l = readLease(out, rev);
  if (l && l.pid === process.pid && l.host === os.hostname()) fs.rmSync(leaseFile(out, rev), { force: true });
}
const resultRow = (rows: Array<Record<string, any>>, rev: number) => rows.find(r => (r.event === 'shadow_recorded' || r.event === 'shadow_failed') && r.gate_rev === rev);
const callIds = (rows: Array<Record<string, any>>, rev: number) => rows.filter(r => r.event === 'shadow_dispatched' && r.gate_rev === rev).map(r => String(r.attempt));

/** The shadow folder: created on first use; a symlink or a non-directory is refused, never followed. */
function safeDir(out: string): string | undefined {
  const dir = shadowDir(out);
  try {
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink()) return `${dir} is a symlink`;
    if (!st.isDirectory()) return `${dir} is not a directory`;
  } catch (e: any) {
    if (e.code !== 'ENOENT') return `${dir}: ${e.code ?? e.message}`;
    fs.mkdirSync(dir, { mode: 0o700 });
  }
  return undefined;
}

/** A dead lease: its dispatched calls settle unknown at their reservation (they may have been billed), the rest are released. */
function expireLease(out: string, rev: number, rows: Array<Record<string, any>>): void {
  const file = path.join(out, FILES.spend);
  const sent = new Set(callIds(rows, rev));
  const open = readLedger(file).reserved.filter(r => r.attempt.startsWith(`shadow-r${rev}-`));
  for (const r of open) if (sent.has(r.attempt)) settle(file, r.attempt, 'unknown'); else release(file, r.attempt);
  fs.rmSync(leaseFile(out, rev), { force: true });
  journal(out, { event: 'shadow_expired', gate_rev: rev, settled_unknown: open.filter(r => sent.has(r.attempt)).map(r => r.attempt), released: open.filter(r => !sent.has(r.attempt)).map(r => r.attempt) });
}

/**
 * Under the run lock: claim the current gate revision's shadow, or say why not (nothing printed when shadow is off, the
 * run is not at a gate, or the revision already has its result). A live lease means another writer is paying: this one
 * pays nothing. `retrospective` (answer's crash path) claims only a revision whose shadow_pending has no result.
 */
export function claimShadow(out: string, o: { retrospective?: boolean } = {}): { claim?: ShadowClaim; line?: string } {
  const state = readState(out);
  const rev = state.gate_rev;
  if (!state.shadow?.enabled || state.ceo_only || state.status !== 'gate_pending' || !rev) return {};
  const rows = readJournal(out);
  if (resultRow(rows, rev) || fs.existsSync(recordFile(out, rev))) return {};
  const pending = rows.some(r => r.event === 'shadow_pending' && r.gate_rev === rev);
  if (o.retrospective && !pending) return {};
  const unsafe = safeDir(out);
  if (unsafe) {
    journal(out, { event: 'shadow_failed', gate_rev: rev, code: 'unsafe_dir', detail: unsafe });
    return { line: `SHADOW: failed unsafe_dir (${unsafe})` };
  }
  const held = readLease(out, rev);
  if (held && leaseLive(held)) return { line: `SHADOW: pending (gate_rev ${rev} is being recorded by pid ${held.pid} on ${held.host} until ${held.deadline}; this command pays nothing)` };
  if (held || pending) expireLease(out, rev, rows);
  const started = Date.now();
  const lease: Lease = { gate_rev: rev, pid: process.pid, host: os.hostname(), started_at: new Date(started).toISOString(), deadline: new Date(started + SHADOW_DEADLINE_MS + RELOCK_MS).toISOString(), retrospective: !!o.retrospective };
  const staged = `${leaseFile(out, rev)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(staged, JSON.stringify(lease));
  try { fs.linkSync(staged, leaseFile(out, rev)); } catch (e: any) { if (e.code !== 'EEXIST') throw e; return { line: `SHADOW: pending (gate_rev ${rev} was claimed by another writer)` }; } finally { fs.rmSync(staged, { force: true }); }
  journal(out, { event: 'shadow_pending', ...lease });
  return { claim: { gate_rev: rev, retrospective: lease.retrospective } };
}

// ---------------------------------------------------------------------------
// the page: one prompt per gate
// ---------------------------------------------------------------------------
interface PageFinding { id: string; severity: string; title: string }
export interface PageItem { item: GateItem; findings: PageFinding[]; frozen: Record<string, unknown> }
export interface Page { prompt: string; items: PageItem[]; plan_sha256: string; prompt_sha256: string; request_sha256: string }

/** Every finding the gate items can name: both voices of every phase, plus findings a deferred close carried. */
function findingIndex(state: RunState): Map<string, FindingRow> {
  const rows: FindingRow[] = [];
  for (const phase of state.phase_order) {
    rows.push(...voiceRows(state, phase, 'native'), ...voiceRows(state, phase, 'outside'));
    const carried = state.phases[phase]?.deferred?.carried_file;
    if (carried && fs.existsSync(path.join(state.out, carried))) rows.push(...readJsonl(path.join(state.out, carried)).rows as unknown as FindingRow[]);
  }
  return new Map(rows.map(r => [r.id, r]));
}

/** The question as frozen in the record and sent in the prompt; p1 lists every finding the other items name. */
export function buildPage(state: RunState, list: GateList, deciderText: string): Page {
  const index = findingIndex(state);
  const own = (item: GateItem) => (item.origin?.split('|')[1] ?? '').split('+').filter(id => index.has(id));
  const named = [...new Set(list.items.filter(i => i.id !== 'p1').flatMap(own))];
  const items = list.items.map(item => {
    const findings = (item.id === 'p1' ? named : own(item)).map(id => { const f = index.get(id)!; return { id, severity: f.severity, title: f.title.split('\n')[0]!.slice(0, 200) }; });
    const frozen = { id: item.id, item_class: item.item_class ?? null, kind: item.kind, title: item.title, why: item.why ?? null, phase: item.phase ?? null,
      options: item.options.map(o => ({ key: o.key, text: o.text, changes_plan: o.changes_plan ?? null })), recommended: item.recommended, recommended_basis: item.recommended_basis ?? null, findings };
    return { item, findings, frozen };
  });
  const planText = fs.existsSync(state.active_plan) ? fs.readFileSync(state.active_plan, 'utf8') : '';
  const plan = (extractHeading(planText, 'Implementation plan') ?? planText).slice(0, PLAN_CHARS);
  const slots: Record<string, string> = { PLAN: plan, QUESTIONS: '```json\n' + JSON.stringify(items.map(i => i.frozen), null, 2) + '\n```', IDS: items.map(i => i.item.id).join(', ') };
  const prompt = deciderText.replace(/\{\{(PLAN|QUESTIONS|IDS)\}\}/g, (_, k: string) => slots[k]!);
  return { prompt, items, plan_sha256: sha256(planText), prompt_sha256: sha256(deciderText), request_sha256: sha256(prompt) };
}

// ---------------------------------------------------------------------------
// the reply contract
// ---------------------------------------------------------------------------
export type Verdict = { ok: true; action: typeof SHADOW_ACTIONS[number]; pick: string; confidence: number; cites: string[]; reason: string } | { ok: false; why: string };
export interface ParsedPage { byId: Map<string, Verdict>; foreign: string[]; clean: boolean }

function jsonArray(text: string): unknown {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/.exec(text)?.[1];
  for (const candidate of [fenced, text.trim(), text.slice(text.indexOf('['), text.lastIndexOf(']') + 1)]) {
    if (!candidate) continue;
    try { return JSON.parse(candidate); } catch { /* next candidate */ }
  }
  return undefined;
}

/** Exactly one valid object per requested id; a duplicate, omission or invalid field marks that item malformed, a foreign id the page. */
export function parsePage(text: string, items: PageItem[]): ParsedPage {
  const byId = new Map<string, Verdict>();
  const parsed = jsonArray(text);
  if (!Array.isArray(parsed)) {
    for (const i of items) byId.set(i.item.id, { ok: false, why: 'no JSON array in the reply' });
    return { byId, foreign: [], clean: false };
  }
  const want = new Map(items.map(i => [i.item.id, i]));
  const seen = new Map<string, unknown[]>();
  const foreign: string[] = [];
  for (const obj of parsed) {
    const id = (obj as { id?: unknown })?.id;
    if (typeof id === 'string' && want.has(id)) (seen.get(id) ?? seen.set(id, []).get(id)!).push(obj);
    else foreign.push(typeof id === 'string' ? id : JSON.stringify(id ?? null));
  }
  for (const [id, pi] of want) {
    const objs = seen.get(id) ?? [];
    byId.set(id, objs.length === 0 ? { ok: false, why: 'missing' } : objs.length > 1 ? { ok: false, why: 'duplicate' } : verdict(objs[0] as Record<string, unknown>, pi));
  }
  return { byId, foreign, clean: foreign.length === 0 && [...byId.values()].every(v => v.ok) };
}

function verdict(o: Record<string, unknown>, pi: PageItem): Verdict {
  const cites = Array.isArray(o.cites) ? o.cites : null;
  const allowed = new Set(pi.findings.map(f => f.id));
  if (!SHADOW_ACTIONS.includes(o.action as typeof SHADOW_ACTIONS[number])) return { ok: false, why: `action ${JSON.stringify(o.action ?? null)} is not decide, send_back or hold` };
  if (typeof o.pick !== 'string' || !pi.item.options.some(op => op.key === o.pick)) return { ok: false, why: `pick ${JSON.stringify(o.pick ?? null)} is not an option of ${pi.item.id}` };
  if (typeof o.confidence !== 'number' || !Number.isFinite(o.confidence) || o.confidence < 0 || o.confidence > 1) return { ok: false, why: `confidence ${JSON.stringify(o.confidence ?? null)} is not a number from 0 to 1` };
  if (!cites || cites.some(c => typeof c !== 'string' || !allowed.has(c))) return { ok: false, why: `cites ${JSON.stringify(o.cites ?? null)} name a finding outside ${pi.item.id}'s origin` };
  if (typeof o.reason !== 'string' || o.reason.length > REASON_CHARS) return { ok: false, why: `reason is not a string of at most ${REASON_CHARS} characters` };
  return { ok: true, action: o.action as typeof SHADOW_ACTIONS[number], pick: o.pick, confidence: o.confidence, cites: cites as string[], reason: o.reason };
}

/** The 10% audit mark: sha256(salt + decision id) mod 1000 < 100. */
export function auditMark(salt: string, decision: string): boolean {
  return BigInt('0x' + sha256(salt + decision)) % 1000n < 100n;
}

// ---------------------------------------------------------------------------
// the call and the record
// ---------------------------------------------------------------------------
export interface ShadowOutcome { status: 'recorded' | 'failed' | 'dropped'; code?: string; model?: string; usd?: number; malformed?: number; line: string }
export interface RunShadowOptions { env?: NodeJS.ProcessEnv; deadlineMs?: number }
class ShadowFailure extends Error { constructor(public code: string, detail: string) { super(detail); } }
interface Reply { result: ApiCallResult; usd: number | 'unknown'; attempt: string }

/** Classify a callModel error: no key, an HTTP status (not billed, settles 0), or a timeout or network loss (may be billed, settles unknown). */
function failureOf(e: any): { code: string; usd: number | 'unknown' } {
  const msg = String(e?.message ?? e);
  if (/^no API key/.test(msg)) return { code: 'no_key', usd: 0 };
  if (/^(anthropic|openai) \d{3}:/.test(msg)) return { code: 'http', usd: 0 };
  return { code: /timeout|abort/i.test(msg) || e?.name === 'AbortError' || e?.name === 'TimeoutError' ? 'timeout' : 'network', usd: 'unknown' };
}

/**
 * Outside any lock: the page is asked once; a reply cut at the output limit is asked once more at 8,000 tokens, and a
 * malformed one once more as a fresh request; one 90 s deadline covers both. Each call is reserved under its own
 * ledger id (label shadow), journaled shadow_dispatched before the send and settled at its actual usage. Then the
 * lock is retaken with a bounded wait and the record published. Never throws: every failure is an outcome.
 */
export async function runShadow(out: string, claim: ShadowClaim, o: RunShadowOptions = {}): Promise<ShadowOutcome> {
  const env = o.env ?? process.env;
  const deadline = Date.now() + (o.deadlineMs ?? SHADOW_DEADLINE_MS);
  const rev = claim.gate_rev;
  const replies: Reply[] = [];
  try {
    const state = readState(out);
    const list = JSON.parse(fs.readFileSync(path.join(out, 'gate.json'), 'utf8')) as GateList;
    if (list.gate_rev !== rev) throw new ShadowFailure('stale_gate', `gate.json is gate_rev ${list.gate_rev}, the claim is ${rev}`);
    const model = state.shadow!.model!;
    const page = buildPage(state, list, fs.readFileSync(shadowPromptFile(), 'utf8'));
    writeAtomic(path.join(shadowDir(out), `r${rev}.prompt.md`), page.prompt);
    const inputTokens = Math.ceil(Buffer.byteLength(page.prompt) / 3);
    const estimate = (maxTokens: number) => estimateCostUsd({ input: inputTokens, output: maxTokens }, model);
    const ledgerFile = path.join(out, FILES.spend);
    const headroom = summarize(readLedger(ledgerFile, state.spend_cap_usd)).headroom_usd;
    const worst = estimate(SHADOW_MAX_TOKENS) + estimate(SHADOW_RAISED_MAX_TOKENS);
    if (headroom !== null && headroom < worst) throw new ShadowFailure('budget', `headroom ${headroom.toFixed(4)} < ${worst.toFixed(4)} (one call plus its retry)`);
    const ask = async (maxTokens: number): Promise<Reply> => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new ShadowFailure('timeout', `the ${(o.deadlineMs ?? SHADOW_DEADLINE_MS) / 1000} s deadline passed before the call`);
      const attempt = `shadow-r${rev}-${callIds(readJournal(out), rev).length + 1}`;
      try { reserve(ledgerFile, attempt, estimate(maxTokens), { cap: readState(out).spend_cap_usd, label: 'shadow' }); }
      catch (e: any) { throw new ShadowFailure('budget', e.message); }
      journal(out, { event: 'shadow_dispatched', gate_rev: rev, attempt, model, max_tokens: maxTokens, estimate_usd: estimate(maxTokens), retrospective: claim.retrospective });
      let result: ApiCallResult;
      try {
        result = await callModel({ model, prompt: page.prompt, timeoutMs: remaining, env, maxTokens, receipt: { sink: SHADOW_SINK, consent: SHADOW_CONSENT, payloadClass: 'plan-and-gate' } });
      } catch (e: any) {
        const f = failureOf(e);
        settle(ledgerFile, attempt, f.usd);
        throw new ShadowFailure(f.code, String(e?.message ?? e));
      }
      const { input_tokens: inTok, output_tokens: outTok } = result.usage;
      const usd: number | 'unknown' = typeof inTok === 'number' && typeof outTok === 'number' ? estimateCostUsd({ input: inTok, output: outTok }, model) : 'unknown';
      settle(ledgerFile, attempt, usd);
      writeAtomic(path.join(shadowDir(out), `${attempt}.reply.txt`), result.text);
      const reply = { result, usd, attempt };
      replies.push(reply);
      return reply;
    };
    const truncated = (r: Reply) => r.result.stop_reason === 'max_tokens' || r.result.stop_reason === 'length';
    const first = await ask(SHADOW_MAX_TOKENS);
    let parsed: ParsedPage[];
    if (truncated(first)) {
      const raised = await ask(SHADOW_RAISED_MAX_TOKENS);
      if (truncated(raised)) throw new ShadowFailure('truncated', `the reply was cut at ${SHADOW_RAISED_MAX_TOKENS} output tokens`);
      parsed = [parsePage(raised.result.text, page.items)];
    } else {
      parsed = [parsePage(first.result.text, page.items)];
      if (!parsed[0]!.clean) {
        try {
          const retry = await ask(SHADOW_MAX_TOKENS);
          if (!truncated(retry)) parsed.push(parsePage(retry.result.text, page.items));
        } catch (e) { if (!(e instanceof ShadowFailure)) throw e; }
      }
    }
    return publish(out, claim, { rows: shadowRows(out, state, list, page, parsed, replies), model, replies });
  } catch (e: any) {
    const failure = e instanceof ShadowFailure ? e : new ShadowFailure('internal', String(e?.message ?? e));
    return publish(out, claim, { failure, replies });
  }
}

const usdOf = (replies: Reply[]) => (replies.some(r => r.usd === 'unknown') ? 'unknown' as const : Math.round(replies.reduce((s, r) => s + (r.usd as number), 0) * 1e6) / 1e6);

/** One row per gate item: the frozen question, what the model predicted (the retry's verdict when valid, else the first's), the free rule's pick and the audit mark. */
function shadowRows(out: string, state: RunState, list: GateList, page: Page, parsed: ParsedPage[], replies: Reply[]): Array<Record<string, unknown>> {
  const at = now();
  const usage = replies.reduce((u, r) => ({ input_tokens: u.input_tokens + (r.result.usage.input_tokens ?? 0), output_tokens: u.output_tokens + (r.result.usage.output_tokens ?? 0) }), { input_tokens: 0, output_tokens: 0 });
  return page.items.map(({ item, frozen }) => {
    const verdicts = parsed.map(p => p.byId.get(item.id)!);
    const k = verdicts.map((v, i) => [v, i] as const).reverse().find(([v]) => v.ok);
    const decision = decisionId(list.run, list.gate_rev, item.id);
    const base = {
      schema_version: 1, run: list.run, gate_rev: list.gate_rev, decision, item: item.id, item_class: item.item_class ?? null, phase: item.phase ?? null,
      ceo_eligible: item.id === 'p1' || item.phase === 'ceo', item_frozen: frozen, rec_hash: recHash(list), rec_rev: list.rec_rev ?? 0,
      plan_sha256: page.plan_sha256, prompt_version: SHADOW_PROMPT_VERSION, prompt_sha256: page.prompt_sha256, request_sha256: page.request_sha256,
      model: replies[replies.length - 1]?.result.model ?? state.shadow?.model, gstack_version: GSTACK_VERSION, rule_pick: ruleKept(item),
      retrospective: false, page_usage: usage, page_usd: usdOf(replies), recorded_at: at,
    };
    if (!k) return { ...base, status: 'malformed', malformed: (verdicts[verdicts.length - 1] as { why: string }).why, action: null, pick: null, confidence: null, cites: [], reason: null, audit: false };
    const v = k[0] as Extract<Verdict, { ok: true }>;
    return { ...base, status: 'recorded', action: v.action, pick: v.pick, confidence: v.confidence, cites: v.cites, reason: v.reason, reply: k[1] + 1,
      audit: v.action === 'decide' && auditMark(saltOf(out), decision) };
  });
}

/** The per-run audit salt, drawn once into the shadow folder (never run.json). */
function saltOf(out: string): string {
  try { return fs.readFileSync(saltFile(out), 'utf8').trim(); } catch { /* first use */ }
  try { fs.writeFileSync(saltFile(out), crypto.randomBytes(16).toString('hex') + '\n', { flag: 'wx', mode: 0o600 }); } catch (e: any) { if (e.code !== 'EEXIST') throw e; }
  return fs.readFileSync(saltFile(out), 'utf8').trim();
}

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** Under the run lock (a bounded wait, never RUN_LOCKED at once): link the record, journal the result, drop the lease. */
function publish(out: string, claim: ShadowClaim, r: { rows?: Array<Record<string, unknown>>; model?: string; failure?: ShadowFailure; replies: Reply[] }): ShadowOutcome {
  const rev = claim.gate_rev;
  const usd = usdOf(r.replies);
  const attempts = r.replies.map(x => x.attempt);
  try {
    return withRunLock(out, () => {
      const rows = readJournal(out);
      if (fs.existsSync(recordFile(out, rev)) || resultRow(rows, rev)) { dropLease(out, rev); return { status: 'dropped' as const, line: `SHADOW: dropped (gate_rev ${rev} already has its result; this call's cost stays in the ledger)` }; }
      if (r.failure) {
        journal(out, { event: 'shadow_failed', gate_rev: rev, code: r.failure.code, detail: r.failure.message.slice(0, 500), attempts, usd, retrospective: claim.retrospective });
        dropLease(out, rev);
        return { status: 'failed' as const, code: r.failure.code, line: `SHADOW: failed ${r.failure.code}` };
      }
      const salted: Array<Record<string, unknown>> = r.rows!.map(row => ({ ...row, retrospective: claim.retrospective }));
      const text = salted.map(row => JSON.stringify(row)).join('\n') + '\n';
      const final = recordFile(out, rev);
      for (const e of fs.readdirSync(shadowDir(out))) if (e.startsWith(`ceo-only.r${rev}.jsonl.`) && e.endsWith('.tmp')) fs.rmSync(path.join(shadowDir(out), e), { force: true });
      const tmp = `${final}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      fs.writeFileSync(tmp, text, { flag: 'wx' });
      try { fs.linkSync(tmp, final); } catch (e: any) { if (e.code !== 'EEXIST') throw e; dropLease(out, rev); return { status: 'dropped' as const, line: `SHADOW: dropped (gate_rev ${rev} was recorded by another writer)` }; } finally { fs.rmSync(tmp, { force: true }); }
      const malformed = salted.filter(row => row.status === 'malformed').length;
      journal(out, { event: 'shadow_recorded', gate_rev: rev, sha256: sha256(text), model: r.model, usd, items: salted.length, malformed, attempts, retrospective: claim.retrospective });
      dropLease(out, rev);
      const usdText = usd === 'unknown' ? 'unknown' : usd.toFixed(4);
      return { status: 'recorded' as const, model: r.model, usd: usd === 'unknown' ? undefined : usd, malformed,
        line: `SHADOW: recorded model=${r.model} usd=${usdText}${malformed ? ` malformed=${malformed}/${salted.length}` : ''}${claim.retrospective ? ' retrospective' : ''}` };
    }, { waitMs: RELOCK_MS });
  } catch (e: any) {
    const code = e instanceof RunError && e.code === 'RUN_LOCKED' ? 'locked' : 'internal';
    return { status: 'failed', code, line: `SHADOW: failed ${code} (${e?.message ?? e}); the gate stands` };
  }
}

/**
 * Before `answer` takes the lock: wait for a live lease to finish (up to its deadline), then, when the revision has a
 * shadow_pending and still no result (a crash), record it first with every row retrospective. Never throws.
 */
export async function shadowBeforeAnswer(out: string, o: RunShadowOptions = {}): Promise<string[]> {
  try {
    const state = readState(out);
    const rev = state.gate_rev;
    if (!state.shadow?.enabled || state.status !== 'gate_pending' || !rev) return [];
    for (let l = readLease(out, rev); l && leaseLive(l); l = readLease(out, rev)) await sleep(200);
    const rows = readJournal(out);
    if (resultRow(rows, rev) || fs.existsSync(recordFile(out, rev)) || !rows.some(r => r.event === 'shadow_pending' && r.gate_rev === rev)) return [];
    const { claim, line } = withRunLock(out, () => claimShadow(out, { retrospective: true }), { waitMs: RELOCK_MS });
    if (!claim) return line ? [line] : [];
    return [(await runShadow(out, claim, o)).line];
  } catch (e: any) {
    return [`SHADOW: failed internal (${e?.message ?? e}); the answer proceeds`];
  }
}
