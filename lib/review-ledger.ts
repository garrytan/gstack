/**
 * review-ledger — the proof that /ship's reviewers got their briefs unchanged and that the
 * parent changed nothing they returned (GSTA-167 no-loss gate). One JSONL ledger per run:
 *
 *   rendered  a brief gstack-review-dispatch render wrote (role, name, file, sha256)
 *   sent      the prompt a dispatch program actually passed, by hash; a mismatch fails the pass
 *   output    a reader's raw output (sha256) and the merged.jsonl ids collect wrote from it
 *   judgment  each lead-judgment change: an added or promoted finding, with its reason
 *   judge     the verdict on the parent's judged set (ok, or the dropped and downgraded ids)
 *
 * Findings reach merged.jsonl only through collect, with each voice's label exactly as written.
 * The parent's judged set may add or promote a finding and may fold a duplicate into one at least
 * as severe; it never drops or downgrades one. verify replays every check from the ledger alone.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promptHash } from './review-brief';

export interface LedgerEvent { event: 'rendered' | 'sent' | 'output' | 'judgment' | 'judge'; [k: string]: unknown }
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
export function rank(label: string): number | null {
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

export interface MergedLine { id: string; reader: string; label: string; raw: string; output_sha256: string }

/** One reader's findings as written: a JSON object per line (severity kept as written); else each prose line carrying a severity or FIXABLE/INVESTIGATE label, and each top-level list item under a label-only heading (the stronger of the two labels). */
export function parseFindings(reader: string, output: string): Array<{ label: string; raw: string }> {
  const out: Array<{ label: string; raw: string }> = [];
  let section: string | null = null;
  for (const line of output.replace(/\r\n/g, '\n').split('\n')) {
    const t = line.trim();
    if (!t || /^NO FINDINGS\.?$/.test(t) || /^Recommendation:/i.test(t)) continue;
    const heading = LABEL_HEADING.exec(t);
    if (heading) { section = heading[1]!; continue; }
    if (line === line.trimStart() && HEADING.test(t)) section = null;
    if (t.startsWith('{')) {
      try {
        const o = JSON.parse(t) as Record<string, unknown>;
        if (typeof o.severity === 'string') { out.push({ label: o.severity, raw: t }); continue; }
      } catch { /* prose that starts with a brace */ }
    }
    const inline = ANY_LABEL.exec(t)?.[1];
    const inherited = section && line === line.trimStart() && LIST_ITEM.test(t) ? section : undefined;
    const label = inline && inherited ? stronger(inherited, inline) : inline ?? inherited;
    if (label) out.push({ label, raw: t });
  }
  return out;
}

/** collect: hash the raw output, append its findings to merged.jsonl and record both. */
export function collect(ledger: string, reader: string, output: string, mergedFile: string, outputFile?: string): { sha: string; lines: MergedLine[] } {
  const sha = promptHash(output);
  const prior = readLedger(ledger).filter(e => e.event === 'output' && e.reader === reader).length;
  const lines = parseFindings(reader, output).map((f, i) => ({ id: `${reader}#${prior ? `${prior + 1}.` : ''}${i + 1}`, reader, label: f.label, raw: f.raw, output_sha256: sha }));
  fs.appendFileSync(mergedFile, lines.map(l => JSON.stringify(l) + '\n').join(''), { mode: 0o600 });
  appendEvent(ledger, { event: 'output', reader, sha256: sha, file: outputFile ? path.resolve(outputFile) : null, merged: path.resolve(mergedFile), ids: lines.map(l => l.id) });
  return { sha, lines };
}

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

/** Every id collect recorded, in order. */
const collectedIds = (events: LedgerEvent[]) => events.filter(e => e.event === 'output').flatMap(e => (Array.isArray(e.ids) ? (e.ids as string[]) : []));

export interface VerifyRow { kind: 'BRIEF' | 'OUTPUT' | 'JUDGE'; reader: string; status: string; detail: string }

/** Replay every check from a finished run's ledger: briefs dispatched as rendered, outputs merged as returned, judgment without loss. */
export function verify(ledger: string): { rows: VerifyRow[]; clean: boolean; briefs: number; voided: number } {
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
    const collected = !!lastMatch && inside.some(({ e, i }) => e.event === 'output' && i > lastMatch.i);
    const status = !sent.length ? 'NOT_SENT' : mismatched ? 'MISMATCH' : collected ? 'MATCH' : 'NOT_COLLECTED';
    const tampered = fileNow && fileNow !== r.sha256 ? ' file_changed_since_render' : '';
    rows.push({ kind: 'BRIEF', reader: p.label, status: tampered ? 'MISMATCH' : status, detail: `rendered=${short(r.sha256)} sent=${sent.map(({ e }) => short(e.sha256)).join(',') || '-'}${epVoided ? ` voided=${epVoided}` : ''}${tampered}` });
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
  const clean = episodes.length > 0 && rows.every(r => r.status === 'MATCH' || r.status === 'OK');
  return { rows, clean, briefs: episodes.length, voided };
}
