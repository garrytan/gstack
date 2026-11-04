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
 * Quotes. Text is read in two views, each with an offset map back to the
 * original. Both decode JSON string escapes (\n, \u2019) and HTML entities (an
 * accented-letter name such as &eacute; reads as its letter, any other unknown
 * name as a space), drop format characters by category (\p{Cf},
 * variation selectors, the combining grapheme joiner), read an HTML tag name as
 * a space and join a hyphen-newline wrap. The rendered view reads a whole tag,
 * attributes included, as a space, and also drops HTML
 * comments, footnote markers, reference definitions and link targets and
 * titles, keeping link text; the raw view keeps those as words, so owner words
 * inside a comment or a title are found too. A reply is indexed in both views,
 * so the words of a link target it gave are found as well. Contractions split: "don't" reads
 * "do not", "can't" and "cannot" read "can not", "it's" "it is", "I'd" "I
 * would", and -n't, -'re, -'ve, -'ll, -'d, -'m likewise. Words are runs of
 * Unicode letters, marks and digits with inner apostrophes; everything else
 * separates them. Words compare NFKC and lowercased. A reply of 1 or 2 words is
 * not scanned for (codes and grammar; the reply field itself is dropped). A
 * reply of MIN_TOKENS (3) or more is a quote wherever it appears whole, at word
 * boundaries; from WINDOW (8) words, any WINDOW consecutive words of it are a
 * quote too. A quote then extends over the neighboring words that are also
 * words of that reply, so no owner word is left on either side. The redaction
 * replaces the original characters from the first quoted word to the last.
 *
 * Echoes. A quoted window (or whole short reply) is not the owner's words when
 * the same words were already recorded before the reply, in text the owner
 * didn't write: the plan at each earlier gate, those gates' items, and the
 * reviewer results bound before it (`prior`). Those words stay. Each run of
 * MIN_TOKENS or more reply words left between echoed windows is a needle of
 * its own (whole, and by WINDOW from WINDOW words), so the words a reply added
 * to an echo are redacted wherever they are quoted, with or without the echo.
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

/** A normalized string with, per UTF-16 unit, the original [from, to) range it came from. */
interface Mapped { s: string; from: number[]; to: number[] }
type Piece = string | [number, number];
/** Rewrite each match of `re` as its pieces: a string (mapped to the whole match) or a kept [start, end) range, whose edges take the match's edges. */
function pass(m: Mapped, re: RegExp, pieces: (x: RegExpMatchArray) => Piece[]): Mapped {
  const out: Mapped = { s: '', from: [], to: [] };
  const copy = (a: number, b: number) => { out.s += m.s.slice(a, b); for (let k = a; k < b; k++) { out.from.push(m.from[k]!); out.to.push(m.to[k]!); } };
  let last = 0;
  for (const x of m.s.matchAll(re)) {
    const a = x.index!, b = a + x[0].length;
    if (b === a) continue;
    copy(last, a);
    for (const piece of pieces(x)) {
      if (typeof piece !== 'string') {
        copy(piece[0], piece[1]);
        if (piece[1] > piece[0]) { out.from[out.s.length - (piece[1] - piece[0])] = m.from[a]!; out.to[out.s.length - 1] = m.to[b - 1]!; }
        continue;
      }
      for (let k = 0; k < piece.length; k++) { out.s += piece[k]; out.from.push(m.from[a]!); out.to.push(m.to[b - 1]!); }
    }
    last = b;
  }
  copy(last, m.s.length);
  return out;
}

/** Common punctuation and spaces, and every HTML named entity for a format character (U+00AD, U+200B-U+200F, U+2060-U+2063). */
const NAMED: Record<string, number> = { amp: 0x26, lt: 0x3c, gt: 0x3e, quot: 0x22, apos: 0x27, nbsp: 0xa0, mdash: 0x2014, ndash: 0x2013, hellip: 0x2026, lsquo: 0x2018, rsquo: 0x2019, ldquo: 0x201c, rdquo: 0x201d, shy: 0xad, zerowidthspace: 0x200b, negativeverythinspace: 0x200b, negativethinspace: 0x200b, negativemediumspace: 0x200b, negativethickspace: 0x200b, zwnj: 0x200c, zwj: 0x200d, lrm: 0x200e, rlm: 0x200f, nobreak: 0x2060, applyfunction: 0x2061, af: 0x2061, invisibletimes: 0x2062, it: 0x2062, invisiblecomma: 0x2063, ic: 0x2063 };
/** A named entity for an accented Latin letter (eacute, Ntilde, ccedil): the base letter and its combining mark. */
const ACCENT: Record<string, string> = { acute: '\u0301', grave: '\u0300', circ: '\u0302', uml: '\u0308', tilde: '\u0303', ring: '\u030a', cedil: '\u0327', caron: '\u030c', macr: '\u0304', breve: '\u0306', ogon: '\u0328', dot: '\u0307' };
const LETTERS: Record<string, string> = { szlig: 'ß', aelig: 'æ', AElig: 'Æ', oslash: 'ø', Oslash: 'Ø', eth: 'ð', ETH: 'Ð', thorn: 'þ', THORN: 'Þ', oelig: 'œ', OElig: 'Œ' };
const namedEntity = (name: string): string | undefined => {
  const code = NAMED[name.toLowerCase()];
  if (code !== undefined) return String.fromCodePoint(code);
  const accent = /^([A-Za-z])([a-z]+)$/.exec(name);
  return LETTERS[name] ?? (accent && ACCENT[accent[2]!] ? (accent[1]! + ACCENT[accent[2]!]).normalize('NFC') : undefined);
};
const JSON_ESCAPES: Record<string, string> = { n: ' ', r: ' ', t: ' ', b: ' ', f: ' ', '"': '"', '\\': '\\', '/': '/' };
/** What a rendered page doesn't show as words: HTML comments, reference definitions, footnote markers, link targets and titles. */
const RENDERED: Array<[RegExp, (x: RegExpMatchArray) => Piece[]]> = [
  [/<!--[\s\S]*?-->/g, () => [' ']],
  [/^[ \t]*\[[^\]\n]+\]:[ \t]*\S+(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?[ \t]*$/gm, () => [' ']],
  [/\[\^[^\]\s]+\]/g, () => [' ']],
  [/\[([^\]\n]*)\](?:\[[^\]\n]*\]|\((?:[^()\s]|\([^()\s]*\))*(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*\))/gd, x => [' ', x.indices![1]!, ' ']],
];

/** The text words are read from, in the raw or the rendered view (the header's Quotes paragraph). */
function normalize(text: string, rendered: boolean): Mapped {
  let m: Mapped = { s: text, from: Array.from({ length: text.length }, (_, i) => i), to: Array.from({ length: text.length }, (_, i) => i + 1) };
  m = pass(m, /\\(?:u([0-9a-fA-F]{4})|([nrtbf"\\/]))/g, x => [x[1] ? String.fromCharCode(parseInt(x[1], 16)) : JSON_ESCAPES[x[2]!]!]);
  m = pass(m, /&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z][a-z0-9]*));/gi, x => {
    if (x[3]) return [namedEntity(x[3]) ?? ' '];
    const code = x[1] ? parseInt(x[1], 10) : parseInt(x[2]!, 16);
    return [code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' '];
  });
  m = pass(m, /[\p{Cf}\p{Variation_Selector}\u034f]/gu, () => []);
  m = pass(m, rendered ? /<\/?[A-Za-z](?:[^<>]*>|[\w:-]*)/g : /<\/?[A-Za-z][\w:-]*/g, () => [' ']);
  if (rendered) for (const [re, pieces] of RENDERED) m = pass(m, re, pieces);
  return pass(m, /(?<=[\p{L}\p{N}])-[ \t]*\r?\n[ \t>]*(?=[\p{L}\p{N}])/gu, () => []);
}

const WHOLE: Record<string, string[]> = { "can't": ['can', 'not'], cannot: ['can', 'not'], "won't": ['will', 'not'], "shan't": ['shall', 'not'] };
const SUFFIXES: Array<[string, string]> = [["n't", 'not'], ["'re", 'are'], ["'ve", 'have'], ["'ll", 'will'], ["'d", 'would'], ["'m", 'am']];
/** Pronouns whose -'s reads "is"; on any other word it is a possessive and stays. */
const IS_BASES = new Set(['it', 'that', 'there', 'here', 'what', 'who', 'where', 'he', 'she']);

interface Token { key: string; start: number; end: number }
/** Words of `text` in the rendered (default) or raw view, with their original [start, end) offsets. */
export function tokens(text: string, rendered = true): Token[] {
  const m = normalize(text, rendered);
  const out: Token[] = [];
  for (const w of m.s.matchAll(/[\p{L}\p{M}\p{N}]+(?:['\u2019\u02bc][\p{L}\p{M}\p{N}]+)*/gu)) {
    const start = m.from[w.index!]!, end = m.to[w.index! + w[0].length - 1]!;
    const key = w[0].normalize('NFKC').replace(/[\u2019\u02bc]/g, "'").toLowerCase();
    const suffix = SUFFIXES.find(([s]) => key.endsWith(s) && key.length > s.length);
    const parts = WHOLE[key] ?? (key.endsWith("'s") && IS_BASES.has(key.slice(0, -2)) ? [key.slice(0, -2), 'is'] : suffix ? [key.slice(0, -suffix[0].length), suffix[1]] : [key]);
    for (const k of parts) out.push({ key: k, start, end });
  }
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Where gstack renders a human's deferral reason (R): the voice detail, the consensus head, the gate title, a blocker's why, the run log. */
const DEFERRAL_RENDERINGS = (r: string) => [`^deferred: (${r})$`, `\\((${r}); by human\\)`, `accepted-with-findings at round \\d+ \\((${r})\\): `, `closed deferred \\((${r})\\) with this finding open`, `, by human\\): (${r}); \\d+ open finding`];

/**
 * The scan index: each owner reply and deferral reason of MIN_TOKENS+ words (grammar skipped), each run of MIN_TOKENS+
 * of its words between echoed windows, and the placements of deferral reasons and carried words.
 */
export function ownerIndex(replies: OwnerSource[], o: { deferred?: OwnerSource[]; carried?: string[] } = {}): OwnerWords {
  const keysOf = (texts: string[]) => ` ${texts.flatMap(t => [tokens(t, false), tokens(t)].map(ts => ts.map(k => k.key).join(' '))).join(' \u0001 ')} `;
  const seen = new Set<string>();
  const indexed: Indexed[] = [];
  const add = (keys: string[], prior: string) => {
    if (keys.length < MIN_TOKENS || seen.has(keys.join(' '))) return;
    seen.add(keys.join(' '));
    indexed.push({ keys, set: new Set(keys), prior });
  };
  for (const s of [...replies, ...(o.deferred ?? [])]) {
    if (s.parsed) continue;
    const prior = keysOf(s.prior ?? []);
    for (const rendered of [true, false]) {
      const keys = tokens(s.text, rendered).map(t => t.key);
      add(keys, prior);
      const size = Math.min(keys.length, WINDOW);
      const echo = new Set<number>();
      for (let j = 0; j + size <= keys.length; j++) if (prior.includes(` ${keys.slice(j, j + size).join(' ')} `)) for (let k = j; k < j + size; k++) echo.add(k);
      for (let j = 0; echo.size && j < keys.length;) {
        let k = j;
        while (k < keys.length && !echo.has(k)) k++;
        if (k > j) add(keys.slice(j, k), prior);
        j = k + 1;
      }
    }
  }
  const placements = [
    ...(o.deferred ?? []).flatMap(d => DEFERRAL_RENDERINGS(escape(d.text))),
    ...(o.carried ?? []).map(w => `words=(${escape(JSON.stringify(w))})(?= by=|$)`),
  ].map(p => new RegExp(p, 'gd'));
  return { replies: indexed, placements };
}

/** Every owner-words span in `text` (placements, then quotes less echoes, in both views), merged, as original [start, end) offsets. */
export function ownerSpans(text: string, owner: OwnerWords): Span[] {
  const spans: Span[] = [];
  for (const re of owner.placements) for (const m of text.matchAll(re)) spans.push([m.indices![1]![0], m.indices![1]![1]]);
  for (const ts of owner.replies.length ? [tokens(text, false), tokens(text)] : []) {
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
