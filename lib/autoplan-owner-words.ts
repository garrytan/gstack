/**
 * autoplan-owner-words: the owner's own words a public copy of a run must not
 * carry (GST-1243, GEVA-225). Garry: nothing a person wrote leaves without
 * their click. `ownerWords` collects what the private run recorded in the
 * owner's words: every relayed reply (`owner_reply` on decision rows and on
 * run.json's gate), the words a carried gate reused (run.json `carry.words`),
 * and a reason a human typed when deferring a phase (`close --deferred
 * <reason> --by human`). The gate reply grammar (`reply`, `last_reply`) is
 * the decision code, and `answer_words` are the answering agent's own words,
 * so both stay.
 *
 * `dropOwnerFields` removes those fields from the export's JSON: `owner_reply`
 * anywhere, `words` on a carry record, and a human deferral's `reason`
 * (replaced by the marker, the field is required). `redactOwnerWords` handles
 * text: first the places gstack copies those words verbatim (the CARRIED line,
 * a deferral's titles and log lines), then quotes anywhere.
 *
 * The quote rule. Text is cut into words at whitespace (line breaks included);
 * each word is compared without the punctuation and symbols at its edges
 * (quote marks, `>` blockquote markers, list dashes), NFKC-normalized,
 * lowercased, with curly apostrophes read as straight ones. Only an owner text
 * of at least MIN_WORDS words and MIN_CHARS characters is scanned for: shorter
 * replies ("yes", "do it", "rec except p2b") are common words or the gate
 * grammar, so a scan would redact unrelated prose, and the reply field itself
 * is already dropped. A reply that parsed as gate grammar (`owner_reply_parsed`)
 * is the decision code the export keeps, so it is not scanned for either. A quote is a run of WINDOW consecutive words of an owner
 * text (the whole text when it is shorter), wherever it sits and however it
 * is wrapped; overlapping runs merge into one span, which the marker replaces.
 */
import type { RunState } from './autoplan-state';
import type { DecisionRow } from './headless-artifacts';

export const OWNER_WORDS_MARK = '[owner words redacted]';
export const MIN_WORDS = 5;
export const MIN_CHARS = 20;
export const WINDOW = 8;

export interface OwnerWords { placements: Array<[string, string]>; windows: Map<number, Set<string>> }
export type Span = [number, number];

interface Word { key: string; start: number; end: number }
function words(text: string): Word[] {
  const out: Word[] = [];
  for (const m of text.matchAll(/\S+/g)) {
    const lead = /^[\p{P}\p{S}]*/u.exec(m[0])![0].length;
    const core = m[0].slice(lead).replace(/[\p{P}\p{S}]+$/u, '');
    if (core) out.push({ key: core.normalize('NFKC').replace(/[\u2018\u2019\u02bc]/g, "'").toLowerCase(), start: m.index! + lead, end: m.index! + lead + core.length });
  }
  return out;
}

/** What the private run recorded in the owner's words, and the windows the quote scan looks for. */
export function ownerWords(state: Pick<RunState, 'phases' | 'gate' | 'carry'>, decisions: Array<Pick<DecisionRow, 'owner_reply' | 'owner_reply_parsed'>>): OwnerWords {
  const deferred = Object.values(state.phases ?? {}).flatMap(p => (p?.deferred?.by === 'human' && p.deferred.reason ? [p.deferred.reason] : []));
  const carried = state.carry?.words;
  const texts = [...new Set([...decisions.map(d => d.owner_reply), (state.gate as { owner_reply?: unknown } | undefined)?.owner_reply, carried, ...deferred]
    .filter((t): t is string => typeof t === 'string' && t.trim() !== ''))];
  const placements: Array<[string, string]> = [
    ...(carried ? [[`words=${JSON.stringify(carried)}`, `words=${OWNER_WORDS_MARK}`] as [string, string]] : []),
    ...deferred.flatMap(r => [`deferred: ${r}`, `(${r}; by human)`, `(${r}): `, `, by human): ${r};`].map(s => [s, s.replace(r, () => OWNER_WORDS_MARK)] as [string, string])),
  ];
  const grammar = new Set(decisions.filter(d => d.owner_reply_parsed).map(d => d.owner_reply));
  const windows = new Map<number, Set<string>>();
  for (const t of texts.filter(t => !grammar.has(t))) {
    const keys = words(t).map(w => w.key);
    if (keys.length < MIN_WORDS || keys.join(' ').length < MIN_CHARS) continue;
    const size = Math.min(keys.length, WINDOW);
    const set = windows.get(size) ?? windows.set(size, new Set()).get(size)!;
    for (let i = 0; i + size <= keys.length; i++) set.add(keys.slice(i, i + size).join(' '));
  }
  return { placements, windows };
}

/** Every quote of an owner text in `text`, as merged [start, end) spans. */
export function ownerSpans(text: string, owner: OwnerWords): Span[] {
  const ws = words(text);
  const hits: Span[] = [];
  for (const [size, set] of owner.windows) {
    for (let i = 0; i + size <= ws.length; i++) if (set.has(ws.slice(i, i + size).map(w => w.key).join(' '))) hits.push([ws[i]!.start, ws[i + size - 1]!.end]);
  }
  hits.sort((a, b) => a[0] - b[0]);
  return hits.reduce<Span[]>((out, s) => { const last = out[out.length - 1]; if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]); else out.push([...s]); return out; }, []);
}

/** Replace the verbatim placements, then every quote outside `keep` (code export never rewrites), with the marker. */
export function redactOwnerWords(text: string, owner: OwnerWords, keep: Span[] = []): { text: string; redacted: number } {
  let redacted = 0;
  let out = text;
  for (const [from, to] of owner.placements) { const parts = out.split(from); redacted += parts.length - 1; out = parts.join(to); }
  const spans = ownerSpans(out, owner).filter(([s, e]) => !keep.some(([ks, ke]) => s < ke && e > ks));
  for (const [s, e] of spans.reverse()) out = out.slice(0, s) + OWNER_WORDS_MARK + out.slice(e);
  return { text: out, redacted: redacted + spans.length };
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
