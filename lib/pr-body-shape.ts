/**
 * pr-body-shape — the shape every PR body takes (R76 as amended 2026-11-15, docs/writing-prs.md): at most three
 * visible lines before anything folded (what changed for a user, why, and anything the reader has to do), every
 * other section folded into a `<details>` block, and the Agent notes section (lib/agent-notes.ts), which holds the
 * /ship receipt, last. /ship and people write `## ` sections; gstack-post folds them on publish (foldSections), so
 * nobody writes HTML by hand. checkBodyShape is the check gstack-post, gstack-plain-title and the Plain title CI check
 * share; a finding refuses only in a repository with `.gstack/plain-titles.json`, and warns everywhere else.
 */
import { AGENT_NOTES_MARKER } from './agent-notes';
import { maskProse } from './prose-lint';

export const VISIBLE_LINES = 3;
export const VISIBLE_CHARS = 600;
export interface BodyFinding { code: 'PLAIN_BODY_REFUSED'; kind: 'visible-lines' | 'unfolded' | 'term' | 'receipt-placement'; match: string; hint: string }

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const closesFence = (fence: string, line: string) => new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`).test(line);
const FOLD_OPEN = /^<details>\s*<summary>([^<]*)<\/summary>\s*$/i;
const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const tagDelta = (line: string) => { const prose = line.replace(/`[^`]*`/g, ''); return (prose.match(/<details\b/gi)?.length ?? 0) - (prose.match(/<\/details>/gi)?.length ?? 0); };

/** One line of a body with what the shape rules need to know about it. */
interface Line { text: string; depth: number; fenced: boolean; notes: boolean; opensFence?: boolean }

/** Every line of the body, marking those inside a code fence, inside a `<details>` block (depth before the line) and from the Agent notes marker on. */
function classify(body: string): Line[] {
  const out: Line[] = [];
  let fence: string | null = null, depth = 0, notes = false;
  for (const text of body.replace(/\r\n?/g, '\n').split('\n')) {
    if (!notes && fence === null && depth === 0 && text.trim() === AGENT_NOTES_MARKER) notes = true;
    const line: Line = { text, depth, fenced: fence !== null, notes };
    out.push(line);
    if (fence !== null) { if (closesFence(fence, text)) fence = null; continue; }
    const open = FENCE_OPEN.exec(text);
    if (open) { fence = open[1]!; line.fenced = true; line.opensFence = true; continue; }
    depth = Math.max(0, depth + tagDelta(text));
  }
  return out;
}

/** HTML comments render as nothing, so they never count as text; the Agent notes marker, itself a comment, is kept. */
const stripComments = (body: string) => body.replace(/<!--[\s\S]*?-->/g, m => (m === AGENT_NOTES_MARKER ? m : m.replace(/[^\n]/g, '')));
const blankRun = (lines: string[]) => { while (lines.length && !lines[0]!.trim()) lines.shift(); while (lines.length && !lines.at(-1)!.trim()) lines.pop(); return lines; };

/**
 * Every top-level `## ` section above the Agent notes marker becomes a fold titled by its heading; the opening above
 * the first heading, existing folds, fenced code, the Agent notes section and anything after it are kept byte for
 * byte. Folding a folded body changes nothing.
 */
export function foldSections(body: string): string {
  const lines = classify(body);
  const out: string[] = [];
  let section: { title: string; body: string[] } | null = null;
  const flush = () => {
    if (!section) return;
    out.push(`<details><summary>${escape(section.title)}</summary>`, '', ...blankRun(section.body), '', '</details>', '');
    section = null;
  };
  for (const l of lines) {
    const heading = !l.notes && !l.fenced && l.depth === 0 ? /^ {0,3}## (.+)$/.exec(l.text) : null;
    if (heading) { flush(); section = { title: heading[1]!.trim(), body: [] }; continue; }
    if (l.notes && section) flush();
    if (section) section.body.push(l.text);
    else out.push(l.text);
  }
  flush();
  return out.join('\n').replace(/\n{3,}(?=<details>)/g, '\n\n').replace(/\n+$/, body.endsWith('\n') ? '\n' : '');
}

/** The inverse of foldSections for top-level folds above the Agent notes marker, so a body merges by section title (lib/gstack-post.ts). */
export function unfoldSections(body: string): string {
  const lines = classify(body);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const open = !l.notes && !l.fenced && l.depth === 0 ? FOLD_OPEN.exec(l.text.trim()) : null;
    const end = open ? lines.findIndex((m, j) => j > i && !m.fenced && m.depth === 1 && m.text.trim() === '</details>') : -1;
    if (!open || end < 0) { out.push(l.text); continue; }
    out.push(`## ${unescape(open[1]!.trim())}`, '', ...blankRun(lines.slice(i + 1, end).map(m => m.text)), '');
    i = end;
    while (i + 1 < lines.length && !lines[i + 1]!.text.trim() && lines[i + 2] && !lines[i + 2]!.notes) i++;
  }
  return out.join('\n');
}

/** The visible opening: the lines above the first fold and the Agent notes marker, HTML comments removed, blank lines dropped; `prose` also drops code blocks, which a commit message never carries. */
export function visibleOpening(body: string, prose = false): string[] {
  const lines = classify(stripComments(body));
  const first = lines.findIndex(l => l.notes || (!l.fenced && l.depth === 0 && /^<details\b/i.test(l.text.trim())));
  return lines.slice(0, first < 0 ? undefined : first).filter(l => !(prose && l.fenced)).map(l => l.text).filter(t => t.trim());
}

/** A whole-word, case-insensitive matcher for a listed word; a space in it matches any run of spaces. */
const wordRe = (term: string) => {
  const t = term.trim();
  const edge = (c: string) => (/[A-Za-z0-9_]/.test(c) ? '\\b' : '');
  return new RegExp(`${edge(t[0]!)}${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}${edge(t.slice(-1))}`, 'gi');
};

/**
 * The shape findings for a body as it will be posted (fold it first): more than VISIBLE_LINES lines or VISIBLE_CHARS
 * characters before the first fold, text outside a fold between the first fold and the Agent notes marker, a listed
 * word anywhere above the marker (code, quotes and URLs skipped), and a receipt outside the Agent notes section or text
 * after it other than a Capy badge.
 */
export function checkBodyShape(body: string, terms: readonly string[] = []): BodyFinding[] {
  const out: BodyFinding[] = [];
  const add = (kind: BodyFinding['kind'], match: string, hint: string) => out.push({ code: 'PLAIN_BODY_REFUSED', kind, match, hint });
  const opening = visibleOpening(body);
  const chars = [...opening.join('\n')].length;
  if (opening.length > VISIBLE_LINES || chars > VISIBLE_CHARS) {
    add('visible-lines', `${opening.length} lines, ${chars} characters before the first fold`, `keep at most ${VISIBLE_LINES} lines and ${VISIBLE_CHARS} characters above the first fold (what changed for a user, why, what the reader has to do); move the rest into a ## section, which gstack-post folds`);
  }
  const lines = classify(stripComments(body));
  const firstFold = lines.findIndex(l => !l.notes && !l.fenced && l.depth === 0 && /^<details\b/i.test(l.text.trim()));
  const loose = firstFold < 0 ? [] : lines.slice(firstFold).filter(l => !l.notes && l.depth === 0 && l.text.trim() && !/^<\/?details\b/i.test(l.text.trim()));
  if (loose.length) add('unfolded', loose[0]!.text.trim().slice(0, 80), 'everything below the opening sits in a fold: put it under a ## heading, which gstack-post folds');
  const notesAt = lines.findIndex(l => l.notes);
  if (lines.some((l, i) => (notesAt < 0 || i < notesAt) && l.opensFence && /^ {0,3}`{3,}gstack-ship-receipt\s*$/.test(l.text))) add('receipt-placement', 'gstack-ship-receipt', 'the /ship receipt belongs in the closing Agent notes section; let gstack-ship-receipt write place it');
  if (notesAt >= 0) {
    const close = lines.findIndex((l, i) => i > notesAt && !l.fenced && l.text.trim() === '</details>' && l.depth === 1);
    const after = close < 0 ? '' : lines.slice(close + 1).map(l => l.text).join('\n').replace(/<a href="https:\/\/capy\.ai\/[\s\S]*?<\/a>/g, '').trim();
    if (after) add('receipt-placement', after.split('\n')[0]!.slice(0, 80), 'the Agent notes section ends the body; move this text above it');
  }
  if (terms.length) {
    const readable = lines.slice(0, notesAt < 0 ? undefined : notesAt).map(l => l.fenced ? '' : l.text).join('\n');
    const masked = maskProse(readable.replace(/<summary>([^<]*)<\/summary>/gi, ' $1 ')).masked.replace(/<[^>]+>/g, ' ').replace(/[^\s()[\]<>"'`]*\/[^\s()[\]<>"'`]*|[\w.-]+\.[A-Za-z][A-Za-z0-9]{0,5}\b/g, m => ' '.repeat(m.length));
    const seen = new Set<string>();
    for (const term of terms) for (const m of masked.matchAll(wordRe(term))) {
      if (seen.has(m[0].toLowerCase())) continue;
      seen.add(m[0].toLowerCase());
      add('term', m[0], 'say what it does for someone using the project, in everyday words (the Agent notes section may keep it)');
    }
  }
  return out;
}

/** One `PLAIN_BODY:` line per finding, in gstack-plain-title's format. */
export function bodyFindingLine(f: BodyFinding, warnOnly: boolean): string {
  const clean = f.match.replace(/[\u0000-\u001f\u007f"]/g, ' ').slice(0, 80);
  return `PLAIN_BODY: ${f.code} ${f.kind} "${clean}" — ${f.hint}${warnOnly ? ' (warning only)' : ''}`;
}
