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
 */
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
interface Hit { rule: boolean; shaped: boolean; spans: Array<[number, number]> }

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

/** Each changed line SECRET_LINE matches or the scanner finds a secret-shaped value (not LOW) on, with the spans to show. */
function hits(lines: readonly Line[], file: string): Map<number, Hit> {
  const out = new Map<number, Hit>();
  const at = (k: number) => out.get(k) ?? out.set(k, { rule: false, shaped: false, spans: [] }).get(k)!;
  const changed = lines.flatMap((l, k) => (l.kind === ' ' ? [] : [k]));
  for (const k of changed) {
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

/** One file's excerpt block, or null when no added line matches the secret-line rule (the reason the file was kept). */
function block(file: string, lines: readonly Line[]): string | null {
  const found = hits(lines, file);
  if (![...found].some(([k, h]) => h.rule && lines[k]!.kind === '+')) return null;
  const rows = [...found.keys()].sort((a, b) => a - b);
  const windows: Array<[number, number]> = [];
  for (const k of rows) {
    const [a, b] = [Math.max(0, k - EXCERPT_CONTEXT), Math.min(lines.length - 1, k + EXCERPT_CONTEXT)];
    const last = windows[windows.length - 1];
    if (last && a <= last[1] + 1) last[1] = b; else windows.push([a, b]);
  }
  const rule = rows.filter(k => found.get(k)!.rule).length;
  const changed = lines.filter(l => l.kind !== ' ').length;
  const out = [`### ${file}`, `${rows.length} changed lines matched (${rule} by the secret-line rule, ${rows.length - rule} with a secret-shaped value) out of ${changed}; each is shown with up to ${EXCERPT_CONTEXT} lines of context.`];
  for (const [a, b] of windows) {
    out.push(`@@ -${lines[a]!.old} +${lines[a]!.new} @@`);
    for (let k = a; k <= b; k++) out.push(lines[k]!.kind + shown(lines[k]!.text, found.get(k)));
  }
  return out.join('\n') + '\n';
}

/**
 * The excerpt of `diff` (`git diff --text` under the a/ and b/ prefixes) for the expected `paths`. A section whose path
 * git quoted, that names no expected path or repeats one, that has no matched added line, or whose hunk header or scanner
 * result cannot be read goes whole, and so does any expected path no section was excerpted for.
 */
export function secretExcerpt(diff: string, paths: readonly string[]): SecretExcerpt {
  const want = new Set(paths);
  const unattributed: string[] = [];
  const byFile = new Map<string, { sections: string[]; text: string | null }>();
  for (const section of diff.split(/(?<=\n)(?=diff --git )/).filter(Boolean)) {
    const lines = section.split('\n');
    const h = lines.findIndex(l => l.startsWith('@@'));
    const file = section.startsWith('diff --git ') ? sectionPath(h < 0 ? lines : lines.slice(0, h)) : null;
    if (file === null || !want.has(file)) { unattributed.push(section); continue; }
    const prior = byFile.get(file);
    if (prior) { prior.sections.push(section); prior.text = null; continue; }
    let text: string | null = null;
    try { text = h < 0 ? null : block(file, hunkLines(lines.slice(h))); } catch { text = null; }
    byFile.set(file, { sections: [section], text });
  }
  const files = paths.flatMap(p => { const text = byFile.get(p)?.text; return text ? [{ path: p, text }] : []; });
  const whole = paths.filter(p => !byFile.get(p)?.text);
  const wholeParts = [...unattributed, ...whole.flatMap(p => byFile.get(p)?.sections ?? [])];
  const head = `## Secret-line excerpts (${files.length} files)\nThese files match review_exclude_paths and stay in review only because a changed line reads a credential; the rest of each file is left out like any excluded file. Each excerpt shows every changed line that matches the secret-line rule or holds a secret-shaped value, with up to ${EXCERPT_CONTEXT} lines of context; a line over ${EXCERPT_LINE_MAX} characters shows ${EXCERPT_WINDOW} characters on each side of each match. Review them for credentials that are leaked or handled unsafely.\n\n`;
  return { text: files.length ? head + files.map(f => f.text).join('\n') : '', files, whole, wholeText: wholeParts.join('') };
}
