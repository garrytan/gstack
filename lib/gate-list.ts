/**
 * gate-list — one gate list instead of four-option sequences (plan B9).
 * A gate list is numbered items, each with a stable id, a recommended default
 * and lettered options; `auto` items take their recommendation when
 * unanswered, `approval` items stay pending until answered. One reply
 * grammar: `all` (every item takes its recommendation), `<id><option>` tokens
 * (`d3b uc1a`), or `all except <tokens>` (the same operation as listing the
 * overrides, so there is no exclusion-vs-override ambiguity). Bare yes/no is
 * ambiguous across multi-option items and is reported as unparsed, never
 * guessed. A reply binds to the gate revision it answers (`gate_rev`).
 * Rendered by bin/gstack-gate; rows land in decisions.jsonl (lib/headless-artifacts.ts).
 */
import type { DecisionRow } from './headless-artifacts';

export interface GateOption { key: string; text: string }
export interface GateItem {
  id: string; title: string; options: GateOption[]; recommended: string; kind: 'auto' | 'approval';
  phase?: string; cost?: string; why?: string;
}
export interface GateList { schema_version: 1; run: string; gate_rev: number; items: GateItem[]; title?: string }

export interface GateChoice { id: string; chosen: string; kind: 'auto' | 'approval'; how: 'recommended' | 'override' | 'auto_default' }
export interface ParsedReply {
  valid: boolean; gate_rev: number; reply: string; choices: GateChoice[]; pending: string[]; unparsed: string[];
  error?: 'GATE_REV_STALE' | 'GATE_REPLY_UNPARSED' | 'GATE_EMPTY';
}

export const PAGE_SIZE = 7;
const ID_RE = /^[a-z]*[0-9]+$/;

export function validateGateList(list: unknown): string[] {
  const problems: string[] = [];
  const g = list as Partial<GateList>;
  if (!g || typeof g !== 'object') return ['gate list is not an object'];
  if (g.schema_version !== 1) problems.push('schema_version must be 1');
  if (typeof g.run !== 'string' || !g.run) problems.push('run is required');
  if (!Number.isInteger(g.gate_rev) || (g.gate_rev as number) < 1) problems.push('gate_rev must be an integer >= 1');
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

/** The `all` resolution: every item takes its recommendation; shown under the list so the reply shape is explicit. */
export function resolveAll(list: GateList): Record<string, string> {
  return Object.fromEntries(list.items.map(i => [i.id, i.recommended]));
}

export function renderGate(list: GateList, page = 1, pageSize = PAGE_SIZE): string {
  const pages = Math.max(1, Math.ceil(list.items.length / pageSize));
  const current = Math.min(Math.max(1, page), pages);
  const start = (current - 1) * pageSize;
  const lines: string[] = [];
  lines.push(`GATE: run=${list.run} gate_rev=${list.gate_rev} items=${list.items.length} page=${current}/${pages}${list.title ? ` — ${list.title}` : ''}`);
  lines.push('');
  list.items.slice(start, start + pageSize).forEach((item, i) => {
    const n = start + i + 1;
    lines.push(`${n}. [${item.id}] ${item.title} (${item.kind}; recommended: ${item.recommended}${item.phase ? `; from ${item.phase}` : ''})`);
    if (item.why) lines.push(`   ${item.why}`);
    for (const o of item.options) lines.push(`   ${item.id}${o.key}) ${o.text}${o.key === item.recommended ? ' (recommended)' : ''}`);
    if (item.cost) lines.push(`   cost: ${item.cost}`);
  });
  lines.push('');
  if (pages > 1) lines.push(`Ids are stable across pages; render page N with \`gstack-gate render <file> --page N\`.`);
  lines.push('Reply with exactly one of: `all` · `<id><option>` tokens, e.g. `' + exampleTokens(list) + '` · `all except <tokens>`.');
  lines.push('Items marked auto take their recommendation if unanswered; approval items stay pending until answered. Bare yes/no is not accepted.');
  lines.push(`Reply binds to gate_rev=${list.gate_rev}. \`all\` resolves to: ${JSON.stringify({ gate_rev: list.gate_rev, choices: resolveAll(list) })}`);
  return lines.join('\n') + '\n';
}

function exampleTokens(list: GateList): string {
  return list.items.slice(0, 2).map(i => `${i.id}${i.options.find(o => o.key !== i.recommended)?.key ?? i.recommended}`).join(' ');
}

/** Tokenize a reply: lowercase, strip separators, merge `<id> <option>` pairs into one token. */
export function tokenize(reply: string, list: GateList): string[] {
  const raw = reply.toLowerCase().replace(/[,;:=)]/g, ' ').split(/\s+/).filter(Boolean);
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
export function parseReply(reply: string, list: GateList, gateRev?: number): ParsedReply {
  const base: ParsedReply = { valid: false, gate_rev: list.gate_rev, reply, choices: [], pending: [], unparsed: [] };
  if (gateRev !== undefined && gateRev !== list.gate_rev) return { ...base, error: 'GATE_REV_STALE' };
  const tokens = tokenize(reply, list);
  if (tokens.length === 0) return { ...base, error: 'GATE_EMPTY' };

  let all = false;
  let rest = tokens;
  if (tokens[0] === 'all') {
    all = true;
    rest = tokens.slice(1);
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
  for (const item of list.items) {
    const chosen = overrides.get(item.id);
    if (chosen !== undefined) choices.push({ id: item.id, chosen, kind: item.kind, how: chosen === item.recommended ? 'recommended' : 'override' });
    else if (all) choices.push({ id: item.id, chosen: item.recommended, kind: item.kind, how: 'recommended' });
    else if (item.kind === 'auto') choices.push({ id: item.id, chosen: item.recommended, kind: item.kind, how: 'auto_default' });
    else pending.push(item.id);
  }
  return { ...base, valid: true, choices, pending };
}

/** decisions.jsonl rows for a gate list (status pending; `applyReply` fills chosen/status). */
export function decisionRows(list: GateList, extra: Partial<DecisionRow> = {}): DecisionRow[] {
  return list.items.map(item => ({
    schema_version: 1, run: list.run, id: `${list.run}-${item.id}`, label: item.id.toUpperCase(), title: item.title,
    options: item.options.map(o => o.key), recommended: item.recommended, kind: item.kind, status: 'pending',
    default_if_unanswered: item.kind === 'auto' ? item.recommended : null, gate_rev: list.gate_rev,
    ...(item.phase ? { phase: item.phase } : {}), ...(item.cost ? { cost: item.cost } : {}), ...extra,
  }));
}

export function applyReply(rows: DecisionRow[], parsed: ParsedReply, answeredAt: string): DecisionRow[] {
  if (!parsed.valid) return rows;
  const byId = new Map(parsed.choices.map(c => [c.id, c]));
  return rows.map(row => {
    const choice = byId.get(row.label?.toLowerCase() ?? '') ?? byId.get(row.id.slice(row.run.length + 1));
    if (!choice || row.gate_rev !== parsed.gate_rev) return row;
    return {
      ...row, chosen: choice.chosen, answered_at: answeredAt, reply: parsed.reply,
      status: choice.how === 'override' ? 'overridden' : 'approved',
    };
  });
}
