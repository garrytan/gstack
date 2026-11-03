/**
 * autoplan-owner-words: the owner's own words a public copy of a run must not
 * carry (GST-1243, GEVA-225). Garry: nothing a person wrote leaves without
 * their click.
 *
 * What counts. `ownerWords` reads the private run and collects every owner
 * reply it ever recorded: `owner_reply` on decision rows, on run.json's gate
 * and on every `answered` journal row (attempts.jsonl keeps replies a later
 * answer at the same gate replaced), the words a carried gate reused, and a
 * reason a human gave for `close --deferred <reason> --by human`. A reply that
 * parsed as gate grammar (`owner_reply_parsed`) is the decision code and is
 * not scanned for; `reply` and the agent's own `answer_words` stay.
 *
 * Fields. `dropOwnerFields` removes `owner_reply` anywhere, `words` on a
 * carry record, and replaces a human deferral's `reason` with the marker.
 *
 * Placements. gstack renders a human deferral reason and carried words into
 * fixed strings (DEFERRAL_RENDERINGS below, one per template in
 * lib/autoplan-gate.ts and lib/autoplan-export.ts; test/autoplan-owner-words
 * ratchets that list). Each is matched with its own delimiters on both sides,
 * so a one-word reason never rewrites a longer one that starts with it.
 *
 * Quotes. Text is normalized with an offset map back to the original: HTML
 * entities decoded, zero-width characters dropped, a hyphen-newline wrap
 * joined, a Markdown link target dropped, and contractions split ("don't"
 * reads "do not"). Words are runs of Unicode letters, marks and digits with
 * inner apostrophes; everything else separates them. Words compare NFKC and
 * lowercased. A reply of 1 or 2 words is not scanned for (codes and grammar;
 * the reply field itself is dropped). A reply of MIN_TOKENS (3) or more is a
 * quote wherever it appears whole, at word boundaries; from WINDOW (8) words,
 * any WINDOW consecutive words of it are a quote too. A quote then extends
 * over the neighboring words that are also words of that reply, so no owner
 * word is left on either side. The redaction replaces the original
 * characters from the first quoted word to the last.
 *
 * Echoes. A quoted window (or whole short reply) is not the owner's words when
 * the same words were already recorded before the reply, in text the owner
 * didn't write: the plan at each earlier gate, those gates' items, and the
 * reviewer results bound before it (`prior`). Those words stay; new words
 * around them are still redacted.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readDecisions, readJournal, type RunState } from './autoplan-state';

export const OWNER_WORDS_MARK = '[owner words redacted]';
export const MIN_TOKENS = 3;
export const WINDOW = 8;

export type Span = [number, number];
export interface OwnerSource { text: string; parsed?: boolean; prior?: string[] }
interface Indexed { keys: string[]; set: Set<string>; prior: string }
export interface OwnerWords { replies: Indexed[]; placements: RegExp[] }

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d', shy: '', zwj: '', zwnj: '' };
const CONTRACTIONS: Record<string, string[]> = { "won't": ['will', 'not'], "can't": ['can', 'not'], "shan't": ['shall', 'not'] };
const SUFFIXES: Array<[string, string]> = [["n't", 'not'], ["'re", 'are'], ["'ve", 'have'], ["'ll", 'will'], ["'m", 'am']];

const ENTITY = /&(#\d+|#x[0-9a-f]+|[a-z]+);/iy;
const LINK_TARGET = /\]\([^\s)]*\)/y;
const WRAP = /-[ \t]*\r?\n[ \t>]*(?=[\p{L}\p{N}])/uy;
const sticky = (re: RegExp, text: string, at: number) => { re.lastIndex = at; return re.exec(text); };

interface Token { key: string; start: number; end: number }
/** Words of `text` with their original [start, end) offsets, after the normalization the header describes. */
export function tokens(text: string): Token[] {
  let norm = '';
  const from: number[] = [], to: number[] = [];
  const push = (s: string, a: number, b: number) => { for (let k = 0; k < s.length; k++) { norm += s[k]; from.push(a); to.push(b); } };
  for (let i = 0; i < text.length;) {
    const c = text[i]!;
    const e = c === '&' ? sticky(ENTITY, text, i) : null;
    const code = e?.[1]!.startsWith('#') ? (e[1]![1]?.toLowerCase() === 'x' ? parseInt(e[1]!.slice(2), 16) : parseInt(e[1]!.slice(1), 10)) : undefined;
    const decoded = e ? (code !== undefined ? (code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : undefined) : ENTITIES[e[1]!.toLowerCase()]) : undefined;
    if (e && decoded !== undefined) { push(decoded, i, i + e[0].length); i += e[0].length; continue; }
    if (/[\u200b-\u200d\u2060\ufeff\u00ad]/.test(c)) { i++; continue; }
    const l = c === ']' ? sticky(LINK_TARGET, text, i) : null;
    if (l) { push(' ', i, i + l[0].length); i += l[0].length; continue; }
    const w = c === '-' && /[\p{L}\p{N}]/u.test(norm.slice(-1)) ? sticky(WRAP, text, i) : null;
    if (w) { i += w[0].length; continue; }
    push(c, i, i + 1);
    i++;
  }
  const out: Token[] = [];
  for (const m of norm.matchAll(/[\p{L}\p{M}\p{N}]+(?:['\u2019\u02bc][\p{L}\p{M}\p{N}]+)*/gu)) {
    const start = from[m.index!]!, end = to[m.index! + m[0].length - 1]!;
    const key = m[0].normalize('NFKC').replace(/[\u2019\u02bc]/g, "'").toLowerCase();
    const suffix = SUFFIXES.find(([s]) => key.endsWith(s) && key.length > s.length);
    const parts = CONTRACTIONS[key] ?? (suffix ? [key.slice(0, -suffix[0].length), suffix[1]] : [key]);
    for (const k of parts) out.push({ key: k, start, end });
  }
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Where gstack renders a human's deferral reason (R): the voice detail, the consensus head, the gate title, a blocker's why, the run log. */
const DEFERRAL_RENDERINGS = (r: string) => [`^deferred: (${r})$`, `\\((${r}); by human\\)`, `accepted-with-findings at round \\d+ \\((${r})\\): `, `closed deferred \\((${r})\\) with this finding open`, `, by human\\): (${r}); \\d+ open finding`];

/** The scan index for owner replies (1-2 word and grammar replies skipped), deferral reasons and carried words. */
export function ownerIndex(replies: OwnerSource[], o: { deferred?: OwnerSource[]; carried?: string[] } = {}): OwnerWords {
  const keysOf = (texts: string[]) => ` ${texts.map(t => tokens(t).map(k => k.key).join(' ')).join(' \u0001 ')} `;
  const seen = new Set<string>();
  const indexed = [...replies, ...(o.deferred ?? [])].flatMap(s => {
    const keys = tokens(s.text).map(t => t.key);
    if (s.parsed || keys.length < MIN_TOKENS || seen.has(keys.join(' '))) return [];
    seen.add(keys.join(' '));
    return [{ keys, set: new Set(keys), prior: keysOf(s.prior ?? []) }];
  });
  const placements = [
    ...(o.deferred ?? []).flatMap(d => DEFERRAL_RENDERINGS(escape(d.text))),
    ...(o.carried ?? []).map(w => `words=(${escape(JSON.stringify(w))})(?= by=|$)`),
  ].map(p => new RegExp(p, 'gd'));
  return { replies: indexed, placements };
}

/** Every owner-words span in `text` (placements, then quotes less echoes), merged, as original [start, end) offsets. */
export function ownerSpans(text: string, owner: OwnerWords): Span[] {
  const spans: Span[] = [];
  for (const re of owner.placements) for (const m of text.matchAll(re)) spans.push([m.indices![1]![0], m.indices![1]![1]]);
  if (owner.replies.length) {
    const ts = tokens(text);
    const keys = ts.map(t => t.key);
    for (const r of owner.replies) {
      const size = Math.min(r.keys.length, WINDOW);
      const windows = new Set<string>();
      for (let j = 0; j + size <= r.keys.length; j++) windows.add(r.keys.slice(j, j + size).join(' '));
      const quoted = new Set<number>(), echo = new Set<number>();
      for (let i = 0; i + size <= keys.length; i++) {
        const run = keys.slice(i, i + size).join(' ');
        if (!windows.has(run)) continue;
        for (let k = i; k < i + size; k++) (r.prior.includes(` ${run} `) ? echo : quoted).add(k);
      }
      for (const k of [...quoted]) {
        for (let a = k - 1; a >= 0 && r.set.has(keys[a]!) && !echo.has(a) && !quoted.has(a); a--) quoted.add(a);
        for (let b = k + 1; b < keys.length && r.set.has(keys[b]!) && !echo.has(b) && !quoted.has(b); b++) quoted.add(b);
      }
      const marked = [...quoted].filter(k => !echo.has(k)).sort((x, y) => x - y);
      for (let s = 0; s < marked.length;) {
        let e = s;
        while (e + 1 < marked.length && marked[e + 1] === marked[e]! + 1) e++;
        spans.push([ts[marked[s]!]!.start, ts[marked[e]!]!.end]);
        s = e + 1;
      }
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  return spans.reduce<Span[]>((out, s) => { const last = out[out.length - 1]; if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]); else out.push([...s]); return out; }, []);
}

/** Replace every owner-words span outside `keep` (code export never rewrites) with the marker. */
export function redactOwnerWords(text: string, owner: OwnerWords, keep: Span[] = []): { text: string; redacted: number } {
  const spans = ownerSpans(text, owner).filter(([s, e]) => !keep.some(([ks, ke]) => s < ke && e > ks));
  let out = text;
  for (const [s, e] of [...spans].reverse()) out = out.slice(0, s) + OWNER_WORDS_MARK + out.slice(e);
  return { text: out, redacted: spans.length };
}

/** Drop the owner-word fields from a JSON value: `owner_reply`, a carry record's `words`, a human deferral's `reason`. */
export function dropOwnerFields(value: unknown): { value: unknown; dropped: number } {
  let dropped = 0;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== 'object') return v;
    const o: Record<string, unknown> = { ...(v as Record<string, unknown>) };
    if ('owner_reply' in o) { delete o.owner_reply; dropped++; }
    if ('verdict' in o && typeof o.words === 'string') { delete o.words; dropped++; }
    if (o.by === 'human' && typeof o.reason === 'string' && 'cause' in o) { o.reason = OWNER_WORDS_MARK; dropped++; }
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, walk(x)]));
  };
  return { value: walk(value), dropped };
}

/** Every owner reply and human deferral reason the private run at `state.out` recorded, each with the text recorded before it. */
export function ownerWords(state: Pick<RunState, 'out' | 'phases' | 'gate' | 'carry'>): OwnerWords {
  const out = state.out;
  const journal = readJournal(out);
  const read = (name: string) => { try { return fs.readFileSync(path.join(out, name), 'utf8'); } catch { return undefined; } };
  const strings = (v: unknown): string[] => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []);
  const gateText = (rev: number) => {
    const archived = read(`gate.r${rev}.json`);
    const current = read('gate.json');
    const gate = archived ?? (current && JSON.parse(current).gate_rev === rev ? current : undefined);
    return gate ? strings(JSON.parse(gate).items).join('\n') : '';
  };
  const gates = journal.filter(r => r.event === 'gate_written' && typeof r.gate_rev === 'number').map(r => ({ at: String(r.ts), text: [read(`plan-at-gate.r${r.gate_rev}.md`) ?? '', gateText(r.gate_rev)].join('\n') }));
  const bound = journal.filter(r => r.event === 'submitted' && typeof r.result === 'string').map(r => ({ at: String(r.ts), text: read(path.basename(r.result)) ?? '' }));
  const prior = (at: string | undefined) => (at ? [...gates, ...bound].filter(x => x.at < at).map(x => x.text) : []);

  const byText = new Map<string, { at?: string; parsed: boolean }>();
  const note = (text: unknown, at: unknown, parsed: unknown) => {
    if (typeof text !== 'string' || !text.trim()) return;
    const was = byText.get(text);
    const when = typeof at === 'string' ? at : undefined;
    byText.set(text, { at: was?.at && (!when || was.at < when) ? was.at : when, parsed: !!was?.parsed || parsed === true });
  };
  for (const r of journal) note(r.owner_reply, r.ts, r.owner_reply_parsed);
  for (const d of readDecisions(out)) note(d.owner_reply, d.answered_at, d.owner_reply_parsed);
  const gate = state.gate as { owner_reply?: unknown; answered_at?: unknown; owner_reply_parsed?: unknown } | undefined;
  note(gate?.owner_reply, gate?.answered_at, gate?.owner_reply_parsed);
  note(state.carry?.words, undefined, false);

  const deferred = new Map<string, string | undefined>();
  for (const r of journal) if (r.event === 'phase_deferred' && r.by === 'human' && typeof r.reason === 'string') deferred.set(r.reason, deferred.get(r.reason) ?? String(r.ts));
  for (const p of Object.values(state.phases ?? {})) if (p?.deferred?.by === 'human' && p.deferred.reason && !deferred.has(p.deferred.reason)) deferred.set(p.deferred.reason, p.deferred.at);

  return ownerIndex([...byText].map(([text, r]) => ({ text, parsed: r.parsed, prior: prior(r.at) })), {
    deferred: [...deferred].map(([text, at]) => ({ text, prior: prior(at) })),
    carried: state.carry?.words ? [state.carry.words] : [],
  });
}
