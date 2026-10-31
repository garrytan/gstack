/**
 * gate-list — one gate list instead of four-option sequences (plan B9).
 * A gate list is numbered items, each with a stable id, a recommended default
 * and lettered options; `auto` items take their recommendation when
 * unanswered, `approval` items stay pending until answered. One reply
 * grammar: `rec` (every item takes its recommendation, plan changes
 * included), `<id><option>` tokens (`d3b uc1a`), or `rec except <tokens>`
 * (the same operation as listing the overrides). `all`, `approve all`,
 * `accept all`, `take all recommendations` and `do it` are silent aliases of `rec`;
 * `as-is` (alias `all as-is`) keeps every direction: each item takes its
 * option that does not change the plan (`changes_plan: false`). Bare yes/no
 * is ambiguous across multi-option items and is reported as unparsed, never
 * guessed. A reply binds to the gate revision it answers (`gate_rev`), and a
 * `rec` reply to the recommendations it saw (`rec_hash`, bumped by
 * `gstack-autoplan recommend`). Earlier answers at the same revision
 * (`prior`) are kept unless a token names the item again: only unresolved
 * items default.
 * Rendered by bin/gstack-gate; rows land in decisions.jsonl (lib/headless-artifacts.ts).
 */
import { createHash } from 'node:crypto';
import type { DecisionRow } from './headless-artifacts';

/** `changes_plan`: choosing this option is an accepted plan change (reopens its phase plus Eng, prints APPLY:). */
export interface GateOption { key: string; text: string; changes_plan?: boolean }
export interface GateItem {
  id: string; title: string; options: GateOption[]; recommended: string; kind: 'auto' | 'approval';
  phase?: string; cost?: string; why?: string;
  /** false: an agent decision; no option reopens a phase. */
  reopens?: boolean;
  /** Why `recommended` (e.g. `both voices; shared proposal`, `plan direction; voices disagree`). */
  recommended_basis?: string; changes?: string;
  /** Set when the relaying parent chose this recommendation (`gstack-autoplan recommend`); shown in the render. */
  recommended_by?: string;
  /** Stable carry-forward identity (phase, finding ids, phase close, snapshot, option text). */
  origin?: string;
  /** Advisory lines rendered under the item (PLAN_REALITY: a plan term with no number, arm list or rule body). */
  flags?: string[];
  /** Answered at an earlier revision on an unchanged proposal from a phase that did not rerun. */
  carried?: { from: string; chosen: string; gate_rev: number };
  /** A round-cap item (lib/autoplan-budget.ts): `b` grants the phase one more round and reopens it. */
  cap?: { phase: string; kind: 'deferred' | 'blocker' | 'delta'; ref?: string };
}
export interface GateList { schema_version: 1; run: string; gate_rev: number; items: GateItem[]; title?: string;
  /** Bumped by every `recommend`, so a `rec` relayed before it no longer matches `recHash`. */
  rec_rev?: number;
  /** The plan's plain-language ask, read from the reviewed plan (lib/captain-brief.ts `buildEli5`); printed first. */
  eli5?: GateEli5;
  /** The one-reviewer check of an unreviewed post-cap delta before a carry (lib/autoplan-carry.ts). */
  carry_check?: { attempt: string; model: string; verdict: 'passed' | 'failed' | 'unavailable'; max_severity: string; findings: number; at: string } }
/** The captain approvals shape (docs/captain.md § Approvals), section text taken from the reviewed plan; '' when absent. */
export interface GateEli5 { summary: string; before_after: string; why: string; cause: string; decisions: string; plan_file_sha256: string }
export const ELI5_FIELDS = [['before_after', 'Before → after'], ['why', 'Why it matters'], ['cause', 'What caused this work'], ['decisions', 'Big decisions']] as const;

export interface GateChoice { id: string; chosen: string; kind: 'auto' | 'approval'; how: 'recommended' | 'override' | 'auto_default'; prior?: boolean }
export interface ParsedReply {
  valid: boolean; gate_rev: number; reply: string; choices: GateChoice[]; pending: string[]; unparsed: string[];
  /** `rec`: the reply took the recommendations (any alias, with or without `except`). */
  mode?: 'rec' | 'as-is' | 'tokens';
  error?: 'GATE_REV_STALE' | 'GATE_REPLY_UNPARSED' | 'GATE_EMPTY';
}

export const PAGE_SIZE = 7;
/** Reply openers that take every recommendation: `rec` and its silent aliases. */
const REC_ALIASES: string[][] = [['rec'], ['all'], ['approve', 'all'], ['accept', 'all'], ['take', 'all', 'recommendations'], ['do', 'it']];
const ID_RE = /^[a-z]*[0-9]+$/;

export function validateGateList(list: unknown): string[] {
  const problems: string[] = [];
  const g = list as Partial<GateList>;
  if (!g || typeof g !== 'object') return ['gate list is not an object'];
  if (g.schema_version !== 1) problems.push('schema_version must be 1');
  if (typeof g.run !== 'string' || !g.run) problems.push('run is required');
  if (!Number.isInteger(g.gate_rev) || (g.gate_rev as number) < 1) problems.push('gate_rev must be an integer >= 1');
  if (g.eli5 !== undefined) {
    if (!g.eli5 || typeof g.eli5 !== 'object') problems.push('eli5 must be an object');
    else for (const k of ['summary', 'before_after', 'why', 'cause', 'decisions', 'plan_file_sha256'] as const) if (typeof g.eli5[k] !== 'string') problems.push(`eli5.${k} must be a string`);
  }
  if (!Array.isArray(g.items) || g.items.length === 0) return [...problems, 'items must be a non-empty array'];
  const seen = new Set<string>();
  g.items.forEach((item, i) => {
    const at = `items[${i}]`;
    if (typeof item.id !== 'string' || !ID_RE.test(item.id)) problems.push(`${at}.id must match [a-z]*[0-9]+ (lowercase label plus a number, e.g. d3, uc1, 12)`);
    else if (seen.has(item.id)) problems.push(`${at}.id ${item.id} is duplicated`); else seen.add(item.id);
    if (typeof item.title !== 'string' || !item.title) problems.push(`${at}.title is required`);
    if (item.kind !== 'auto' && item.kind !== 'approval') problems.push(`${at}.kind must be auto or approval`);
    if (!Array.isArray(item.options) || item.options.length < 2) problems.push(`${at}.options needs at least two options`);
    else {
      const keys = item.options.map(o => o?.key);
      if (keys.some(k => typeof k !== 'string' || !/^[a-z]$/.test(k))) problems.push(`${at}.options[*].key must be one lowercase letter`);
      if (new Set(keys).size !== keys.length) problems.push(`${at}.options keys repeat`);
      if (!keys.includes(item.recommended)) problems.push(`${at}.recommended must be one of its option keys`);
    }
  });
  return problems;
}

/** The recommendations a `rec` reply takes, as a short hash the render prints and `answer --rec-hash` checks. */
export function recHash(list: GateList): string {
  const recs = list.items.map(i => [i.id, i.recommended, i.recommended_basis ?? '', i.recommended_by ?? '']);
  return createHash('sha256').update(JSON.stringify([list.gate_rev, list.rec_rev ?? 0, recs])).digest('hex').slice(0, 12);
}

/** The `GATE_PENDING` hint: exact tokens per pending item, or `rec`. */
export function pendingHint(list: GateList, pending: string[]): string {
  const items = pending.map(id => list.items.find(i => i.id === id)).filter((i): i is GateItem => !!i);
  const tokens = items.map(i => i.options.map(o => `${i.id}${o.key}`).join('|')).join(' ');
  return `reply with ${tokens || 'p1a..p1e'} or rec`;
}

export function renderGate(list: GateList, page = 1, pageSize = PAGE_SIZE): string {
  const pages = Math.max(1, Math.ceil(list.items.length / pageSize));
  const current = Math.min(Math.max(1, page), pages);
  const start = (current - 1) * pageSize;
  const lines: string[] = [];
  lines.push(`GATE: run=${list.run} gate_rev=${list.gate_rev} items=${list.items.length} page=${current}/${pages}${list.title ? ` — ${list.title}` : ''}`);
  lines.push('');
  if (list.eli5 && current === 1) lines.push(...renderEli5(list.eli5), '');
  if (list.carry_check) lines.push(`Carry check ${list.carry_check.attempt}: ${list.carry_check.verdict} (${list.carry_check.model}; ${list.carry_check.findings} finding(s), highest ${list.carry_check.max_severity}).`, '');
  list.items.slice(start, start + pageSize).forEach((item, i) => {
    const n = start + i + 1;
    lines.push(`${n}. [${item.id}] ${item.title} (${item.kind}; recommended: ${item.recommended}${item.recommended_basis ? ` (${item.recommended_basis}${item.recommended_by ? `; set by ${item.recommended_by}` : ''})` : ''}${item.phase ? `; from ${item.phase}` : ''})`);
    if (item.why) lines.push(`   ${item.why}`);
    if (item.carried) lines.push(`   decided at gate_rev ${item.carried.gate_rev}: ${item.id}${item.carried.chosen} (carried forward; name it again to change it)`);
    for (const o of item.options) lines.push(`   ${item.id}${o.key}) ${o.text}${o.key === item.recommended ? ' (recommended)' : ''}`);
    if (item.cost) lines.push(`   cost: ${item.cost}`);
    for (const flag of item.flags ?? []) lines.push(`   flagged: ${flag}`);
  });
  lines.push('');
  if (pages > 1) lines.push(`Ids are stable across pages; render page N with \`gstack-gate render <file> --page N\`, or every page with \`--all\`. Relay every page.`);
  lines.push('Reply with exactly one of: `rec` (default: take every recommendation, plan changes included) · `rec except <tokens>` · `<id><option>` tokens, e.g. `' + exampleTokens(list) + '` · `as-is` (the plan as written).');
  lines.push('Items marked auto take their recommendation if unanswered; approval items stay pending until answered. Bare yes/no is not accepted.');
  const rec = parseReply('rec', list);
  lines.push(`Reply binds to gate_rev=${list.gate_rev} rec_hash=${recHash(list)}. \`rec\` resolves to: ${JSON.stringify({ gate_rev: list.gate_rev, rec_hash: recHash(list), choices: Object.fromEntries(rec.choices.map(c => [c.id, c.chosen])) })}`);
  return lines.join('\n') + '\n';
}

/** The ELI5 block: the summary, then each approvals-shape section under its title. An empty summary says so (CAPTAIN_BRIEF_INCOMPLETE). */
export function renderEli5(e: GateEli5): string[] {
  const lines = e.summary.trim() ? ['ELI5', e.summary.trim()] : [];
  for (const [key, title] of ELI5_FIELDS) if (e[key].trim()) lines.push(...(lines.length ? [''] : []), `${title}:`, e[key].trim());
  return lines;
}

function exampleTokens(list: GateList): string {
  return list.items.slice(0, 2).map(i => `${i.id}${i.options.find(o => o.key !== i.recommended)?.key ?? i.recommended}`).join(' ');
}

/** Tokenize a reply: lowercase, strip separators, merge `<id> <option>` pairs into one token. */
export function tokenize(reply: string, list: GateList): string[] {
  const raw = reply.toLowerCase().replace(/[,;:=)`"'\u2018\u2019\u201c\u201d]/g, ' ').split(/\s+/).filter(Boolean);
  const ids = new Set(list.items.map(i => i.id));
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i]!;
    const next = raw[i + 1];
    if (ids.has(t) && next && /^[a-z]$/.test(next)) { out.push(t + next); i++; continue; }
    out.push(t);
  }
  return out;
}

/**
 * Parse one reply against the list. Returns the resolved choices, the ids
 * still pending (approval items with no answer), and unparsed tokens. Any
 * unparsed token makes the whole reply invalid: nothing is guessed.
 */
export function parseReply(reply: string, list: GateList, gateRev?: number, prior: Record<string, string> = {}): ParsedReply {
  const base: ParsedReply = { valid: false, gate_rev: list.gate_rev, reply, choices: [], pending: [], unparsed: [] };
  if (gateRev !== undefined && gateRev !== list.gate_rev) return { ...base, error: 'GATE_REV_STALE' };
  const tokens = tokenize(reply, list);
  if (tokens.length === 0) return { ...base, error: 'GATE_EMPTY' };

  let rec = false;
  let asIs = false;
  let rest = tokens;
  const lead = REC_ALIASES.find(a => a.every((w, i) => tokens[i] === w));
  if (lead && tokens[lead.length] === 'as-is' && lead.length === 1 && lead[0] === 'all') { asIs = true; rest = tokens.slice(2); }
  else if (lead) { rec = true; rest = tokens.slice(lead.length); }
  else if (tokens[0] === 'as-is') { asIs = true; rest = tokens.slice(1); }
  if (rec || asIs) {
    if (rest[0] === 'except') rest = rest.slice(1);
    else if (rest.length > 0) return { ...base, unparsed: rest, error: 'GATE_REPLY_UNPARSED' };
  }
  const overrides = new Map<string, string>();
  const unparsed: string[] = [];
  for (const token of rest) {
    const m = /^([a-z]*[0-9]+)([a-z])$/.exec(token);
    const item = m ? list.items.find(i => i.id === m[1]) : undefined;
    const option = item?.options.find(o => o.key === m![2]);
    if (!item || !option) { unparsed.push(token); continue; }
    if (overrides.has(item.id) && overrides.get(item.id) !== option.key) { unparsed.push(`${token} (conflicts with ${item.id}${overrides.get(item.id)})`); continue; }
    overrides.set(item.id, option.key);
  }
  if (unparsed.length) return { ...base, unparsed, error: 'GATE_REPLY_UNPARSED' };

  const choices: GateChoice[] = [];
  const pending: string[] = [];
  const how = (item: GateItem, chosen: string) => (chosen === item.recommended ? 'recommended' : 'override') as GateChoice['how'];
  for (const item of list.items) {
    const chosen = overrides.get(item.id);
    const earlier = prior[item.id] ?? item.carried?.chosen;
    if (chosen !== undefined) choices.push({ id: item.id, chosen, kind: item.kind, how: how(item, chosen) });
    else if (earlier !== undefined && item.options.some(o => o.key === earlier)) choices.push({ id: item.id, chosen: earlier, kind: item.kind, how: how(item, earlier), prior: true });
    else if (asIs) { const keep = keepDirection(item); choices.push({ id: item.id, chosen: keep, kind: item.kind, how: how(item, keep) }); }
    else if (rec) choices.push({ id: item.id, chosen: item.recommended, kind: item.kind, how: 'recommended' });
    else if (item.kind === 'auto') choices.push({ id: item.id, chosen: item.recommended, kind: item.kind, how: 'auto_default' });
    else pending.push(item.id);
  }
  return { ...base, valid: true, choices, pending, mode: rec ? 'rec' : asIs ? 'as-is' : 'tokens' };
}

/** The option that keeps the plan's direction: the first with `changes_plan: false`; plan approval `a`; else the recommendation. */
export function keepDirection(item: GateItem): string {
  return item.options.find(o => o.changes_plan === false)?.key ?? (item.id === 'p1' && item.options.some(o => o.key === 'a') ? 'a' : item.recommended);
}

/** The decisions.jsonl id for a gate item. Item ids restart at every gate revision, so revisions after the first carry `r<rev>-`. */
export function decisionId(run: string, gateRev: number, itemId: string): string {
  return gateRev > 1 ? `${run}-r${gateRev}-${itemId}` : `${run}-${itemId}`;
}

/** decisions.jsonl rows for a gate list (status pending; `applyReply` fills chosen/status). */
export function decisionRows(list: GateList, extra: Partial<DecisionRow> = {}): DecisionRow[] {
  return list.items.map(item => ({
    schema_version: 1, run: list.run, id: decisionId(list.run, list.gate_rev, item.id), label: item.id.toUpperCase(), title: item.title,
    options: item.options.map(o => o.key), recommended: item.recommended, kind: item.kind, status: 'pending',
    default_if_unanswered: item.kind === 'auto' ? item.recommended : null, gate_rev: list.gate_rev,
    ...(item.phase ? { phase: item.phase } : {}), ...(item.cost ? { cost: item.cost } : {}),
    ...(item.recommended_basis ? { recommended_basis: item.recommended_basis } : {}), ...(item.changes ? { changes: item.changes } : {}),
    ...(item.origin ? { origin: item.origin } : {}), ...(item.reopens === false ? { source: 'agent' } : {}), ...extra,
  }));
}

/** `--by` values: the owner typing tokens, or an agent relaying or deciding them. */
export const ANSWERED_BY_RE = /^(human|agent:[A-Za-z0-9_.:-]+)$/;

export function applyReply(rows: DecisionRow[], parsed: ParsedReply, answeredAt: string, answeredBy?: string, extra: Partial<DecisionRow> = {}): DecisionRow[] {
  if (!parsed.valid) return rows;
  const byId = new Map(parsed.choices.map(c => [c.id, c]));
  return rows.map(row => {
    const choice = byId.get(row.label?.toLowerCase() ?? '') ?? byId.get(row.id.slice(row.run.length + 1).replace(/^r\d+-/, ''));
    if (!choice || choice.prior || row.gate_rev !== parsed.gate_rev) return row;
    return {
      ...row, chosen: choice.chosen, answered_at: answeredAt, reply: parsed.reply, ...(answeredBy ? { answered_by: answeredBy } : {}), ...extra,
      status: choice.how === 'override' ? 'overridden' : 'approved',
    };
  });
}
