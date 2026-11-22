/**
 * review-secret-excerpt — what pass readers see of a file review_exclude_paths matches and keeps only because a changed
 * line reads a credential (lib/review-exclude.ts reason secret-line, GST-1447). Results PRs that capture model requests hold
 * system prompts naming `${…_API_KEY}` and keychain commands; inlined whole, 75 such files were 12.9 MB against the 2 MB
 * reader ceiling (harness-evals #269). The excerpt holds every changed line SECRET_LINE matches or the credential scanner
 * finds a secret-shaped value on, with EXCERPT_CONTEXT diff lines around each, the path and the counts, and only the excerpt
 * counts toward REVIEW_DIFF_MAX_BYTES. A line longer than EXCERPT_LINE_MAX shows EXCERPT_WINDOW characters on each side of
 * every match. It fails closed: a section it cannot tie to one expected path, one with no matched added line (the keep
 * reason the excerpt stands in for), and one whose hunks or scanner result cannot be read come back whole, and readSelection
 * inlines every file on any other throw.
 *
 * An allowlisted data file kept only for single-line gate tags (lib/review-exclude.ts gateData, GST-3273:
 * captured agent sessions quoting lint pragmas or env checks; on harness-evals#494, main's whole reader diff was 12.26 MB) gets the same excerpt,
 * plus every changed line lineTags tags, under its own heading that names the tags. Such a file with no tagged line here
 * goes whole, and so does one whose tagged line runs past EXCERPT_LINE_MAX with no idiom span to show. Every changed line
 * holding a credential value by the caller's secretLine rule (lib/review-exclude.ts secretValueSpans, the secret-line keep
 * reason) is shown too, with a window around each credential name and the 200 characters its value may start in, so an
 * excerpt never leaves out the value a file was kept for; a line past EXCERPT_LINE_MAX whose value only the credential scan
 * finds, and that the scan here does not place, sends its file whole.
 */
import { lineTags } from './gate-diff/tags';
import { scan } from './redact-engine';
import { SECRET_LINE } from './review-risk';

export const EXCERPT_CONTEXT = 3;
export const EXCERPT_LINE_MAX = 400;
export const EXCERPT_WINDOW = 160;
/** The most bytes one scanner call reads; a single changed line past the scanner's own 1 MiB cap sends its file whole. */
const SCAN_CHUNK_BYTES = 512 * 1024;
/** Lines each chunk after the first repeats from the one before, so a label the scanner needs nearby is read with its value. */
const SCAN_OVERLAP_BYTES = 1024;

/** `text` is the excerpt readers get ('' when no file was excerpted); `whole` lists the paths it could not excerpt and `wholeText` their diff sections. */
export interface SecretExcerpt { text: string; files: Array<{ path: string; text: string }>; whole: string[]; wholeText: string }

interface Line { kind: string; text: string; old: number; new: number }
interface Hit { rule: boolean; shaped: boolean; gate: string[]; spans: Array<[number, number]> }

const GLOBAL = SECRET_LINE.map(r => new RegExp(r.source, r.flags.includes('g') ? r.flags : r.flags + 'g'));

/** The path a section's ---/+++ header names under the a/ and b/ prefixes, or null when git quoted it or printed none. */
function sectionPath(head: readonly string[]): string | null {
  const plus = head.find(l => l.startsWith('+++ '));
  const minus = head.find(l => l.startsWith('--- '));
  const side = plus && plus !== '+++ /dev/null' ? plus.slice(4) : minus && minus !== '--- /dev/null' ? minus.slice(4) : '';
  const p = side.replace(/\t$/, '');
  return /^[ab]\//.test(p) ? p.slice(2) : null;
}

function hunkLines(body: readonly string[]): Line[] {
  const out: Line[] = [];
  let old = 0, nu = 0;
  for (const l of body) {
    if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (!m) throw new Error(`unreadable hunk header: ${l.slice(0, 80)}`);
      old = Number(m[1]); nu = Number(m[2]);
    } else if (l[0] === '+') out.push({ kind: '+', text: l.slice(1), old, new: nu++ });
    else if (l[0] === '-') out.push({ kind: '-', text: l.slice(1), old: old++, new: nu });
    else if (l[0] === ' ') out.push({ kind: ' ', text: l.slice(1), old: old++, new: nu++ });
  }
  return out;
}

/** Each changed line SECRET_LINE matches, the scanner finds a secret-shaped value (not LOW) on, or lineTags tags or secretLine reads as a credential value (added lines), with the spans to show. */
function hits(lines: readonly Line[], file: string, secretLine?: (file: string, line: string) => Array<[number, number]> | null): Map<number, Hit> {
  const out = new Map<number, Hit>();
  const at = (k: number) => out.get(k) ?? out.set(k, { rule: false, shaped: false, gate: [], spans: [] }).get(k)!;
  const changed = lines.flatMap((l, k) => (l.kind === ' ' ? [] : [k]));
  for (const k of changed) {
    if (lines[k]!.kind === '+') {
      const text = lines[k]!.text.replace(/\r$/, '');
      const g = lineTags(text, file);
      if (g.tags.length) {
        if (text.length > EXCERPT_LINE_MAX && !g.spans.length) throw new Error(`a gate-tagged line in ${file} has no span to show`);
        const h = at(k);
        h.gate = g.tags;
        h.spans.push(...g.spans.map(([a, b]) => [a - EXCERPT_WINDOW, b + EXCERPT_WINDOW] as [number, number]));
      }
    }
    for (const r of GLOBAL) {
      r.lastIndex = 0;
      for (let m = r.exec(lines[k]!.text); m; m = r.exec(lines[k]!.text)) {
        const h = at(k);
        h.rule = true;
        h.spans.push([m.index - EXCERPT_WINDOW, m.index + m[0].length + EXCERPT_WINDOW]);
        if (!m[0]) r.lastIndex++;
      }
    }
  }
  const size = (k: number) => Buffer.byteLength(lines[k]!.text) + 1;
  for (let from = 0; from < lines.length;) {
    let to = from, bytes = 0;
    while (to < lines.length && (to === from || bytes + size(to) <= SCAN_CHUNK_BYTES)) bytes += size(to++);
    const chunk = lines.slice(from, to);
    for (const f of scan(chunk.map(l => l.text).join('\n'), { processEnv: {}, sourcePath: file }).findings) {
      if (f.id.startsWith('engine.')) throw new Error(`the credential scanner did not read ${file}: ${f.id}`);
      if (f.category !== 'secret' || f.severity === 'LOW') continue;
      if (!chunk[f.line - 1]) throw new Error(`a scanner finding in ${file} names line ${f.line} of ${chunk.length}`);
      const k = from + f.line - 1;
      if (lines[k]!.kind === ' ') continue;
      const h = at(k);
      h.shaped = true;
      h.spans.push([f.col - 1 - EXCERPT_WINDOW, f.col - 1 + 2 * EXCERPT_WINDOW]);
    }
    if (to >= lines.length) break;
    let back = to, overlap = 0;
    while (back - 1 > from && overlap < SCAN_OVERLAP_BYTES) overlap += size(--back);
    from = back;
  }
  for (const k of changed) {
    const spans = lines[k]!.kind === '+' ? secretLine?.(file, lines[k]!.text) : null;
    if (!spans) continue;
    const scanned = out.get(k)?.shaped === true;
    const h = at(k);
    h.shaped = true;
    h.spans.push(...spans.map(([a, b]) => [a - EXCERPT_WINDOW, b + EXCERPT_WINDOW] as [number, number]));
    if (lines[k]!.text.length > EXCERPT_LINE_MAX && !spans.length && !scanned) throw new Error(`a credential line in ${file} has no match to show`);
  }
  return out;
}

/** A line as shown: whole up to EXCERPT_LINE_MAX; past it, the windows around its matches, or its start when it has none. */
function shown(text: string, h: Hit | undefined): string {
  if (text.length <= EXCERPT_LINE_MAX) return text;
  if (!h) return `${text.slice(0, EXCERPT_LINE_MAX)} … [${text.length - EXCERPT_LINE_MAX} more characters]`;
  const spans: Array<[number, number]> = [];
  for (const [a, b] of h.spans.map(([a, b]) => [Math.max(0, a), Math.min(text.length, b)] as [number, number]).sort((x, y) => x[0] - y[0])) {
    const last = spans[spans.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b); else spans.push([a, b]);
  }
  const body = spans.map(([a, b]) => text.slice(a, b)).join(' … ');
  return `${spans[0]![0] > 0 ? '… ' : ''}${body}${spans[spans.length - 1]![1] < text.length ? ' …' : ''} [a line of ${text.length} characters, shown around each match]`;
}

/** One file's excerpt block and whether gate tags earned it, or null when no added line matches the secret-line rule or carries a gate tag (the reasons the file was kept). */
function block(file: string, lines: readonly Line[], secretLine?: (file: string, line: string) => Array<[number, number]> | null): { text: string; gate: boolean } | null {
  const found = hits(lines, file, secretLine);
  if (![...found].some(([k, h]) => (h.rule || h.gate.length > 0) && lines[k]!.kind === '+')) return null;
  const rows = [...found.keys()].sort((a, b) => a - b);
  const windows: Array<[number, number]> = [];
  for (const k of rows) {
    const [a, b] = [Math.max(0, k - EXCERPT_CONTEXT), Math.min(lines.length - 1, k + EXCERPT_CONTEXT)];
    const last = windows[windows.length - 1];
    if (last && a <= last[1] + 1) last[1] = b; else windows.push([a, b]);
  }
  const rule = rows.filter(k => found.get(k)!.rule).length;
  const gated = rows.filter(k => found.get(k)!.gate.length > 0);
  const shaped = rows.filter(k => found.get(k)!.shaped && !found.get(k)!.rule).length;
  const tags = [...new Set(gated.flatMap(k => found.get(k)!.gate))].sort();
  const changed = lines.filter(l => l.kind !== ' ').length;
  const gate = gated.length ? `, ${gated.length} tagged by the gate scan: ${tags.join(', ')}` : '';
  const out = [`### ${file}`, `${rows.length} changed lines matched (${rule} by the secret-line rule, ${gated.length ? shaped : rows.length - rule} with a secret-shaped value${gate}) out of ${changed}; each is shown with up to ${EXCERPT_CONTEXT} lines of context.`];
  for (const [a, b] of windows) {
    out.push(`@@ -${lines[a]!.old} +${lines[a]!.new} @@`);
    for (let k = a; k <= b; k++) out.push(lines[k]!.kind + shown(lines[k]!.text, found.get(k)));
  }
  return { text: out.join('\n') + '\n', gate: gated.length > 0 };
}

/**
 * The excerpt of `diff` (`git diff --text` under the a/ and b/ prefixes) for the expected `paths`. A section whose path
 * git quoted, that names no expected path or repeats one, that has no matched added line, or whose hunk header or scanner
 * result cannot be read goes whole, and so does any expected path no section was excerpted for.
 */
export function secretExcerpt(diff: string, paths: readonly string[], secretLine?: (file: string, line: string) => Array<[number, number]> | null): SecretExcerpt {
  const want = new Set(paths);
  const unattributed: string[] = [];
  const byFile = new Map<string, { sections: string[]; text: string | null; gate?: boolean }>();
  for (const section of diff.split(/(?<=\n)(?=diff --git )/).filter(Boolean)) {
    const lines = section.split('\n');
    const h = lines.findIndex(l => l.startsWith('@@'));
    const file = section.startsWith('diff --git ') ? sectionPath(h < 0 ? lines : lines.slice(0, h)) : null;
    if (file === null || !want.has(file)) { unattributed.push(section); continue; }
    const prior = byFile.get(file);
    if (prior) { prior.sections.push(section); prior.text = null; continue; }
    let b: { text: string; gate: boolean } | null = null;
    try { b = h < 0 ? null : block(file, hunkLines(lines.slice(h)), secretLine); } catch { b = null; }
    byFile.set(file, { sections: [section], text: b?.text ?? null, gate: b?.gate });
  }
  const files = paths.flatMap(p => { const text = byFile.get(p)?.text; return text ? [{ path: p, text }] : []; });
  const whole = paths.filter(p => !byFile.get(p)?.text);
  const wholeParts = [...unattributed, ...whole.flatMap(p => byFile.get(p)?.sections ?? [])];
  const secret = files.filter(f => !byFile.get(f.path)!.gate);
  const gate = files.filter(f => byFile.get(f.path)!.gate);
  const head = `## Secret-line excerpts (${secret.length} files)\nThese files match review_exclude_paths and stay in review only because a changed line reads a credential; the rest of each file is left out like any excluded file. Each excerpt shows every changed line that matches the secret-line rule or holds a secret-shaped value, with up to ${EXCERPT_CONTEXT} lines of context; a line over ${EXCERPT_LINE_MAX} characters shows ${EXCERPT_WINDOW} characters on each side of each match. Review them for credentials that are leaked or handled unsafely.\n\n`;
  const gateHead = `## Gate-tagged data excerpts (${gate.length} files)\nThese data files match review_exclude_paths and stay in review only because the gate scan tagged changed lines by their content (a suppression pragma, an env check, a skipped test, a placeholder, a swallowed exception or a gate bypass, often quoted inside captured agent output); the rest of each file is left out like any excluded file. Each excerpt shows every changed line the gate scan's line rules tag, every line that matches the secret-line rule or holds a secret-shaped value, and the tags, with up to ${EXCERPT_CONTEXT} lines of context; a line over ${EXCERPT_LINE_MAX} characters shows ${EXCERPT_WINDOW} characters on each side of each match. Review each tagged line as you would a gate-tagged hunk, and say whether it weakens a check or only records one.\n\n`;
  const parts = [...(secret.length ? [head + secret.map(f => f.text).join('\n')] : []), ...(gate.length ? [gateHead + gate.map(f => f.text).join('\n')] : [])];
  return { text: parts.join('\n'), files, whole, wholeText: wholeParts.join('') };
}
