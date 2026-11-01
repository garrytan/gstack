/**
 * review-ledger — the proof that /ship's reviewers got their briefs unchanged and that the
 * parent changed nothing they returned (GSTA-167 no-loss gate). One JSONL ledger per run:
 *
 *   rendered  a brief gstack-review-dispatch render wrote (role, name, file, sha256)
 *   sent      the prompt a dispatch program actually passed, by hash; a mismatch fails the pass
 *   output    a reader's raw output (sha256), the merged.jsonl ids collect wrote from it, and whether it was a review at all
 *   judgment  each lead-judgment change: an added or promoted finding, with its reason
 *   judge     the verdict on the parent's judged set (ok, or the dropped and downgraded ids)
 *
 * Findings reach merged.jsonl only through collect, with each voice's label as written (a prose line's most severe one,
 * raised by the Severity line below it), except that a prose voice's `Blocks: yes` and the native voice's FIXABLE collect
 * as CRITICAL (GSTA-167 normalizer v2).
 * The parent's judged set may add or promote a finding and may fold a duplicate into one at least
 * as severe; it never drops or downgrades one. verify replays every check from the ledger alone.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isReviewedTreeLine, promptHash, type TreeCheck } from './review-brief';

export interface LedgerEvent { event: 'rendered' | 'sent' | 'output' | 'judgment' | 'judge' | 'program'; [k: string]: unknown }
export const readerKey = (role: string, name?: string) => (name ? `${role}/${name}` : role);

export function appendEvent(ledger: string, e: LedgerEvent): void {
  fs.appendFileSync(ledger, JSON.stringify({ ...e, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
}
export function readLedger(ledger: string): LedgerEvent[] {
  let text: string;
  try { text = fs.readFileSync(ledger, 'utf8'); } catch { return []; }
  return text.split('\n').filter(l => l.trim()).flatMap(l => { try { return [JSON.parse(l) as LedgerEvent]; } catch { return []; } });
}
const lastRendered = (events: LedgerEvent[], reader: string) => [...events].reverse().find(e => e.event === 'rendered' && e.reader === reader);

/** Compare a dispatched prompt with the brief rendered for that reader; records the sent event. */
export function recordSent(ledger: string, reader: string, sentText: string): { ok: boolean; rendered: string | null; sent: string } {
  const r = lastRendered(readLedger(ledger), reader);
  const sent = promptHash(sentText);
  const rendered = typeof r?.sha256 === 'string' ? r.sha256 : null;
  const ok = rendered === sent;
  appendEvent(ledger, { event: 'sent', reader, sha256: sent, rendered, match: ok });
  return { ok, rendered, sent };
}

/** Severity ranks across the voices' vocabularies; a label with no severity (FIXABLE, INVESTIGATE) ranks 0. */
const RANKS: Record<string, number> = { critical: 4, p0: 4, high: 3, p1: 3, medium: 2, p2: 2, informational: 2, low: 1, p3: 1, fixable: 0, investigate: 0 };
export function rank(label: unknown): number | null {
  if (typeof label !== 'string') return null;
  const r = RANKS[label.trim().replace(/^\[|\]$/g, '').toLowerCase()];
  return r === undefined ? null : r;
}
const LABELS = 'CRITICAL|INFORMATIONAL|Critical|Informational|High|HIGH|Medium|MEDIUM|Low|LOW|P[0-3]|FIXABLE|INVESTIGATE';
/** A label anywhere on a line makes it a finding, headings and table rows included: losing a finding costs more than keeping a phantom one, which the judge may fold. */
const ANY_LABEL = new RegExp(`(?<![A-Za-z0-9])(${LABELS})(?![A-Za-z0-9])`);
/** A heading that is only a label ("## High", "**Critical findings**") gives its label to the top-level list items under it, until the next heading or bold-only line. */
const LABEL_HEADING = new RegExp(`^(?:#{1,6}\\s*|\\*\\*)(${LABELS})(?:\\s+(?:findings?|severity|issues?))?\\s*:?\\**\\s*$`);
const HEADING = /^(?:#{1,6}\s|\*\*[^*]+\*\*:?$)/;
const LIST_ITEM = /^(?:[-*+]|\d+[.)])\s+\S/;
const stronger = (a: string, b: string) => ((rank(a) ?? 0) >= (rank(b) ?? 0) ? a : b);
/** A prose voice's `Blocks: yes` (GSTA-167 normalizer v2): the finding is CRITICAL whatever its label; `Blocks: no` never lowers one. */
const BLOCKS_YES = /(?<![A-Za-z0-9])Blocks:?\**:?\s*\**\s*yes(?![A-Za-z0-9])/i;
const ALL_LABELS = new RegExp(ANY_LABEL.source, 'g');
/** A file:line locus ("auth.ts:9"): prose naming one after a finding's fields starts the next finding. */
const LOCUS = /[\w./-]+\.\w+:\d+/;
/** A line that is only a finding's `Severity` or `Blocks` field ("Severity: High", "- Blocks: yes", "Severity High"). */
const META = new RegExp(`^(?:[-*+]\\s+)?\\**\\s*(Severity|Blocks)\\**\\s*(?::|\\s+\\**(?:${LABELS}|yes|no)(?![A-Za-z0-9]))`, 'i');

export interface MergedLine { id: string; reader: string; label: string; raw: string; output_sha256: string }

/**
 * One reader's findings as written: a JSON object per line (severity kept as written); else each prose line carrying a severity or
 * FIXABLE/INVESTIGATE label, at the most severe label on it, and each top-level list item under a label-only heading (the stronger
 * of the two labels). A `Severity` or `Blocks` field line continues the open finding, once per field: `Severity` raises its label,
 * `Blocks: yes` makes it CRITICAL, `Blocks: no` never lowers it; with no finding open it is one, carrying the paragraph's subject.
 * A list item, a heading, a bold or post-blank paragraph at the margin, or a line naming a file:line after the open finding's fields
 * starts the next finding, except an unlabeled, unnumbered bullet with no file:line under a paragraph finding whose fields have not
 * come yet, which is its detail and joins its text (GSTA-196: 4 findings with detail bullets collected as 8). An inline
 * `Blocks: yes` is CRITICAL too. The native voice's FIXABLE collects as CRITICAL; other labels stay as written for lead judgment. When in doubt the parser merges rather than drops: a lost blocker costs the gate.
 */
export function parseFindings(reader: string, output: string): Array<{ label: string; raw: string }> {
  type Finding = { label: string; raw: string; fields: Set<string>; list: boolean };
  const out: Finding[] = [];
  let section: string | null = null;
  let current: Finding | null = null;
  let head = '';
  let gap = false;
  let treeSeen = false;
  const role = reader.split('/')[0];
  const named = (l: string) => (role === 'adversarial-native' && l.toUpperCase() === 'FIXABLE' ? 'CRITICAL' : l);
  const strongest = (t: string) => [...t.matchAll(ALL_LABELS)].map(m => named(m[1]!)).reduce<string | undefined>((a, b) => (a === undefined ? b : stronger(a, b)), undefined);
  const push = (label: string, raw: string, fields: string[] = []): Finding => { const f = { label, raw, fields: new Set(fields), list: LIST_ITEM.test(raw) }; out.push(f); return f; };
  for (const line of output.replace(/\r\n/g, '\n').split('\n')) {
    const t = line.trim();
    if (!t) { gap = true; continue; }
    if (!treeSeen && isReviewedTreeLine(t)) { treeSeen = true; continue; }
    const afterGap = gap;
    gap = false;
    if (/^NO FINDINGS\.?$/.test(t) || /^Recommendation:/i.test(t)) { current = null; continue; }
    const indented = line !== line.trimStart();
    const label = strongest(t);
    const blocks = BLOCKS_YES.test(t);
    const listItem = !indented && LIST_ITEM.test(t);
    const locus = LOCUS.test(t);
    const meta = listItem && locus ? null : META.exec(t);
    if (meta) {
      const field = meta[1]!.toLowerCase();
      if (current && !current.fields.has(field)) {
        current.fields.add(field);
        if (blocks) current.label = 'CRITICAL';
        else if (label) current.label = stronger(current.label, label);
        current.raw += ` | ${t}`;
      } else if (blocks || label) current = push(blocks ? 'CRITICAL' : label!, head ? `${head} | ${t}` : t, [field]);
      else current = null;
      continue;
    }
    const heading = LABEL_HEADING.exec(t);
    if (heading) { section = named(heading[1]!); current = null; head = ''; continue; }
    if (!indented && HEADING.test(t)) { section = null; current = null; }
    if (t.startsWith('{')) {
      try {
        const o = JSON.parse(t) as Record<string, unknown>;
        if (typeof o.severity === 'string') { current = push(o.severity, t); continue; }
      } catch { /* prose that starts with a brace */ }
    }
    const detail = listItem && /^[-*+]\s/.test(t) && !locus && !label && !section && !!current && !current.list && !current.fields.size;
    if (detail && !blocks) { current!.raw += ` | ${t}`; continue; }
    const fresh = (listItem && !detail) || (!indented && !detail && (t.startsWith('**') || afterGap)) || (!!current?.fields.size && locus);
    if (fresh) { current = null; head = t; }
    const inherited = section && listItem ? section : undefined;
    const found = label && inherited ? stronger(inherited, label) : label ?? inherited;
    if (found) { current = push(blocks ? 'CRITICAL' : found, t); if (!indented) head = t; continue; }
    if (blocks && !t.startsWith('{')) {
      if (current) { current.label = 'CRITICAL'; current.raw += ` | ${t}`; continue; }
      current = push('CRITICAL', head && head !== t ? `${head} | ${t}` : t);
      continue;
    }
    if (!fresh && !current && (!LIST_ITEM.test(head) || locus)) head = t;
  }
  return out.map(({ label, raw }) => ({ label, raw }));
}

/**
 * The clean marker each reader's own brief prescribes for a review that found nothing: `NO FINDINGS` alone on a line for the
 * specialists, the batched specialist and the targeted reader (ship/sections/review-army.md, the specialist brief; review/specialists/*.md),
 * the Red Team (its brief in ship/sections/review-army.md) and fix-check (scripts/resolvers/fix-check.ts); the `Recommendation:` line
 * for the outside voice (ship/sections/adversarial.md, the outside prompt); either for the native adversarial voice, whose brief asks
 * for both. A reply with no finding and no marker (a refusal, an empty reply, a reader that never saw the diff) is not a review.
 */
const NO_FINDINGS: [string, RegExp] = ['NO FINDINGS', /^[`*]*NO FINDINGS\.?[`*]*$/];
const RECOMMENDATION: [string, RegExp] = ['Recommendation:', /^[`*]*Recommendation:/i];
const CLEAN_MARKERS: Record<string, Array<[string, RegExp]>> = {
  specialist: [NO_FINDINGS], 'specialist-batched': [NO_FINDINGS], targeted: [NO_FINDINGS], 'red-team': [NO_FINDINGS], 'fix-check': [NO_FINDINGS],
  'adversarial-native': [NO_FINDINGS, RECOMMENDATION], 'outside-voice': [RECOMMENDATION],
};
/** The markers a reader's zero-finding reply may carry; a role outside the brief roles takes either. */
export const cleanMarkers = (reader: string) => CLEAN_MARKERS[reader.split('/')[0]!] ?? [NO_FINDINGS, RECOMMENDATION];
const hasCleanMarker = (reader: string, output: string) => output.replace(/\r\n/g, '\n').split('\n').some(l => cleanMarkers(reader).some(([, re]) => re.test(l.trim())));

/**
 * collect: hash the raw output, append its findings to merged.jsonl and record both; a reply with no finding and no clean marker records
 * review: false. With unavailable (the outside voice only) the output is its failure text, recorded as missing coverage. With a
 * failed tree check (GST-482: the reply reviewed another checkout, or names none) nothing is merged and the output is no review.
 */
export function collect(ledger: string, reader: string, output: string, mergedFile: string, outputFile?: string, unavailable?: string, tree?: TreeCheck): { sha: string; lines: MergedLine[]; review: boolean } {
  const sha = promptHash(output);
  const prior = readLedger(ledger).filter(e => e.event === 'output' && e.reader === reader).length;
  const wrongTree = !unavailable && tree !== undefined && !tree.ok;
  const lines = unavailable || wrongTree ? [] : parseFindings(reader, output).map((f, i) => ({ id: `${reader}#${prior ? `${prior + 1}.` : ''}${i + 1}`, reader, label: f.label, raw: f.raw, output_sha256: sha }));
  const review = !unavailable && !wrongTree && (lines.length > 0 || hasCleanMarker(reader, output));
  fs.appendFileSync(mergedFile, lines.map(l => JSON.stringify(l) + '\n').join(''), { mode: 0o600 });
  appendEvent(ledger, { event: 'output', reader, sha256: sha, file: outputFile ? path.resolve(outputFile) : null, merged: path.resolve(mergedFile), ids: lines.map(l => l.id), review, ...(unavailable ? { unavailable } : {}),
    ...(tree && !unavailable ? { tree: tree.expected, reported_tree: tree.reported, tree_ok: tree.ok } : {}) });
  return { sha, lines, review };
}
/** The outside voice may fail without blocking (ship/sections/adversarial.md): its failure is recorded as unavailable coverage, never as a review. */
export const mayBeUnavailable = (reader: string) => reader.split('/')[0] === 'outside-voice';
const unavailableOutput = (o: LedgerEvent) => typeof o.unavailable === 'string' && mayBeUnavailable(String(o.reader));

export function readJsonl<T>(file: string): T[] {
  return fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as T);
}

export interface JudgedLine { id: string; severity: string; reason?: string; duplicate_of?: string }
export interface Judgment { ok: boolean; dropped: string[]; downgraded: string[]; unexplained: string[]; invalid: string[]; added: string[]; promoted: string[]; folded: string[] }

/** The lead-judgment rule: every merged finding survives at its severity or above; additions and promotions carry a reason. */
export function judge(merged: MergedLine[], judged: JudgedLine[]): Judgment {
  const byId = new Map(judged.map(j => [j.id, j]));
  const mergedIds = new Set(merged.map(m => m.id));
  const res: Judgment = { ok: true, dropped: [], downgraded: [], unexplained: [], invalid: [], added: [], promoted: [], folded: [] };
  for (const j of judged) if (rank(j.severity) === null) res.invalid.push(j.id);
  for (const m of merged) {
    const j = byId.get(m.id);
    if (!j) { res.dropped.push(m.id); continue; }
    const target = j.duplicate_of ? byId.get(j.duplicate_of) : j;
    // A duplicate folds into a different line that stands on its own; a self-fold, a cycle or a chain keeps no survivor.
    if (!target || (j.duplicate_of && (j.duplicate_of === j.id || target.duplicate_of))) { res.dropped.push(m.id); continue; }
    const from = rank(m.label) ?? 0;
    const to = rank(target.severity);
    if (to === null) continue;
    if (to < from) res.downgraded.push(m.id);
    else if (j.duplicate_of) res.folded.push(m.id);
    else if (to > from) { res.promoted.push(m.id); if (!j.reason?.trim()) res.unexplained.push(m.id); }
  }
  for (const j of judged) if (!mergedIds.has(j.id) && !j.duplicate_of) { res.added.push(j.id); if (!j.reason?.trim()) res.unexplained.push(j.id); }
  res.ok = !res.dropped.length && !res.downgraded.length && !res.unexplained.length && !res.invalid.length;
  return res;
}

/** judge, logged: one judgment event per addition and promotion, then the verdict. */
export function recordJudgment(ledger: string, merged: MergedLine[], judged: JudgedLine[], judgedFile: string, mergedFile: string): Judgment {
  const res = judge(merged, judged);
  const given = new Set(merged.map(m => m.id));
  const absent = collectedIds(readLedger(ledger)).filter(id => !given.has(id));
  if (absent.length) { res.dropped.push(...absent); res.ok = false; }
  const byId = new Map(judged.map(j => [j.id, j]));
  const labels = new Map(merged.map(m => [m.id, m.label]));
  if (res.ok) {
    for (const id of res.added) appendEvent(ledger, { event: 'judgment', kind: 'added', id, to: byId.get(id)!.severity, reason: byId.get(id)!.reason });
    for (const id of res.promoted) appendEvent(ledger, { event: 'judgment', kind: 'promoted', id, from: labels.get(id), to: byId.get(id)!.severity, reason: byId.get(id)!.reason });
  }
  appendEvent(ledger, { event: 'judge', ok: res.ok, judged: path.resolve(judgedFile), judged_sha256: promptHash(fs.readFileSync(judgedFile, 'utf8')), merged: path.resolve(mergedFile), merged_ids: merged.map(m => m.id), dropped: res.dropped, downgraded: res.downgraded, unexplained: res.unexplained, invalid: res.invalid, added: res.added.length, promoted: res.promoted.length, folded: res.folded.length });
  return res;
}

/**
 * Whether a recorded output was a review: it has findings, or its file (unchanged since collect) carries the reader's clean marker, so
 * a ledger written before collect recorded the field is judged by the same rule; with no readable file, collect's own review field.
 */
function reviewed(o: LedgerEvent): boolean {
  if (o.tree_ok === false || unavailableOutput(o)) return false;
  if (Array.isArray(o.ids) && o.ids.length) return true;
  let text: string | undefined;
  try { text = typeof o.file === 'string' ? fs.readFileSync(o.file, 'utf8') : undefined; } catch { /* unreadable */ }
  return text !== undefined && promptHash(text) === o.sha256 ? hasCleanMarker(String(o.reader), text) : o.review === true;
}

/** Every id collect recorded, in order. */
const collectedIds = (events: LedgerEvent[]) => events.filter(e => e.event === 'output').flatMap(e => (Array.isArray(e.ids) ? (e.ids as string[]) : []));

export interface VerifyRow { kind: 'BRIEF' | 'OUTPUT' | 'JUDGE'; reader: string; status: string; detail: string }

/** Replay every check from a finished run's ledger: briefs dispatched as rendered, outputs merged as returned, judgment without loss. */
export function verify(ledger: string): { rows: VerifyRow[]; clean: boolean; briefs: number; voided: number; unavailable: number } {
  const events = readLedger(ledger);
  const rows: VerifyRow[] = [];
  const short = (s: unknown) => (typeof s === 'string' ? s.slice(0, 12) : '-');
  // Each render opens one dispatch of its reader (a pass); its sends and outputs run until that reader's next render.
  const renders = events.flatMap((e, i) => (e.event === 'rendered' ? [i] : []));
  const episodes = renders.map((at, n) => {
    const reader = String(events[at]!.reader);
    const next = renders.slice(n + 1).find(j => events[j]!.reader === reader) ?? events.length;
    const nth = renders.slice(0, n + 1).filter(j => events[j]!.reader === reader).length;
    return { at, next, reader, label: nth > 1 ? `${reader}@${nth}` : reader };
  });
  let voided = 0;
  for (const p of episodes) {
    const r = events[p.at]!;
    const inside = events.map((e, i) => ({ e, i })).filter(({ e, i }) => i > p.at && i < p.next && e.reader === p.reader);
    const sent = inside.filter(({ e }) => e.event === 'sent');
    // A later render into the same path overwrote this one's file by design; only the newest render of a path can check it.
    const overwritten = renders.some(j => j > p.at && events[j]!.file === r.file);
    let fileNow = '';
    try { fileNow = !overwritten && typeof r.file === 'string' && fs.existsSync(r.file) ? promptHash(fs.readFileSync(r.file, 'utf8')) : ''; } catch { /* unreadable */ }
    // A mismatched send is void when the reader was re-sent byte-exact before anything was collected from it.
    let mismatched = 0, epVoided = 0;
    for (const s of sent.filter(({ e }) => e.sha256 !== r.sha256)) {
      const after = inside.find(({ e, i }) => i > s.i && (e.event === 'output' || (e.event === 'sent' && e.sha256 === r.sha256)));
      if (after?.e.event === 'sent') epVoided++; else mismatched++;
    }
    voided += epVoided;
    const lastMatch = [...sent].reverse().find(({ e }) => e.sha256 === r.sha256);
    const outputs = lastMatch ? inside.filter(({ e, i }) => e.event === 'output' && i > lastMatch.i) : [];
    const collected = outputs.some(({ e }) => reviewed(e));
    const unavailable = !collected && outputs.some(({ e }) => unavailableOutput(e));
    const status = !sent.length ? 'NOT_SENT' : mismatched ? 'MISMATCH' : collected ? 'MATCH' : unavailable ? 'UNAVAILABLE' : 'NOT_COLLECTED';
    const tampered = fileNow && fileNow !== r.sha256 ? ' file_changed_since_render' : '';
    rows.push({ kind: 'BRIEF', reader: p.label, status: tampered ? 'MISMATCH' : status, detail: `rendered=${short(r.sha256)} sent=${sent.map(({ e }) => short(e.sha256)).join(',') || '-'}${epVoided ? ` voided=${epVoided}` : ''}${outputs.length && !collected && !unavailable ? ' not_reviewed' : ''}${tampered}` });
  }
  for (const [i, o] of events.entries()) {
    if (o.event !== 'output') continue;
    const reader = String(o.reader);
    const p = episodes.find(q => q.reader === reader && q.at < i && i < q.next);
    let status = 'MATCH';
    const notes: string[] = [];
    const lastSent = p ? events.slice(p.at + 1, i).filter(e => e.event === 'sent' && e.reader === reader).at(-1) : undefined;
    if (!p) { status = 'MISMATCH'; notes.push('brief_not_rendered'); }
    else if (!lastSent || lastSent.sha256 !== events[p.at]!.sha256) { status = 'MISMATCH'; notes.push('brief_not_sent_verbatim'); }
    if (typeof o.file === 'string' && fs.existsSync(o.file) && promptHash(fs.readFileSync(o.file, 'utf8')) !== o.sha256) { status = 'MISMATCH'; notes.push('output_file_changed'); }
    const ids = Array.isArray(o.ids) ? (o.ids as string[]) : [];
    let lines: MergedLine[] = [];
    try { lines = typeof o.merged === 'string' ? readJsonl<MergedLine>(o.merged).filter(l => ids.includes(l.id)) : []; } catch { notes.push('merged_unreadable'); status = 'MISMATCH'; }
    if (lines.length !== ids.length) { status = 'MISMATCH'; notes.push(`merged_lines=${lines.length}/${ids.length}`); }
    if (lines.some(l => l.output_sha256 !== o.sha256)) { status = 'MISMATCH'; notes.push('merged_line_from_other_output'); }
    if (status === 'MATCH' && !reviewed(o)) {
      // A non-review the same dispatch later replaced with a review (the brief re-sent verbatim, then answered) is void, counted like a voided send.
      const later = p ? events.slice(i + 1, p.next) : [];
      const review = later.findIndex(e => e.event === 'output' && e.reader === reader && reviewed(e));
      const replaced = review > 0 && later.slice(0, review).some(e => e.event === 'sent' && e.reader === reader && e.sha256 === events[p!.at]!.sha256);
      if (unavailableOutput(o)) { status = 'UNAVAILABLE'; notes.push(`reason=${JSON.stringify(o.unavailable)}`); }
      else if (replaced) { status = 'VOIDED'; voided++; notes.push('replaced_by_a_review'); }
      else if (o.tree_ok === false) { status = 'NOT_REVIEWED'; notes.push(`wrong_tree reported=${JSON.stringify(o.reported_tree)} expected=${JSON.stringify(o.tree)}`); }
      else { status = 'NOT_REVIEWED'; notes.push('no_finding_no_clean_marker'); }
    }
    rows.push({ kind: 'OUTPUT', reader: p?.label ?? reader, status, detail: `sha=${short(o.sha256)} findings=${ids.length}${notes.length ? ' ' + notes.join(' ') : ''}` });
  }
  const lastJudge = events.map(e => e.event).lastIndexOf('judge');
  if (lastJudge >= 0) {
    const v = events[lastJudge]!;
    const notes: string[] = [];
    const late = events.slice(lastJudge + 1).filter(e => e.event === 'output').map(e => String(e.reader));
    if (late.length) notes.push(`output_after_judge=${late.join(',')}`);
    const judgedIds = new Set(Array.isArray(v.merged_ids) ? (v.merged_ids as string[]) : []);
    const missing = collectedIds(events.slice(0, lastJudge)).filter(id => !judgedIds.has(id));
    if (missing.length) notes.push(`merged_ids_missing=${missing.join(',')}`);
    let rerun: Judgment | null = null;
    try {
      const judgedText = fs.readFileSync(String(v.judged), 'utf8');
      if (promptHash(judgedText) !== v.judged_sha256) notes.push('judged_changed_since_judge');
      rerun = judge(readJsonl<MergedLine>(String(v.merged)), readJsonl<JudgedLine>(String(v.judged)));
    } catch { notes.push('judged_or_merged_unreadable'); }
    if (rerun && !rerun.ok) notes.push(`rerun_rejects dropped=${JSON.stringify(rerun.dropped)} downgraded=${JSON.stringify(rerun.downgraded)}`);
    const status = !v.ok ? 'REJECTED' : notes.length ? 'MISMATCH' : 'OK';
    rows.push({ kind: 'JUDGE', reader: '-', status, detail: `dropped=${JSON.stringify(v.dropped)} downgraded=${JSON.stringify(v.downgraded)} added=${v.added} promoted=${v.promoted} folded=${v.folded}${notes.length ? ' ' + notes.join(' ') : ''}` });
  } else if (events.some(e => e.event === 'output')) rows.push({ kind: 'JUDGE', reader: '-', status: 'MISSING', detail: 'outputs were collected but no judged set was checked' });
  const clean = episodes.length > 0 && rows.every(r => ['MATCH', 'OK', 'VOIDED', 'UNAVAILABLE'].includes(r.status));
  return { rows, clean, briefs: episodes.length, voided, unavailable: rows.filter(r => r.kind === 'BRIEF' && r.status === 'UNAVAILABLE').length };
}
