/**
 * changelog-check — CHANGELOG re-heading and checks for gstack-restamp (C2)
 * and the tree receipt (C3). A restamp moves the PR's section (`[Unreleased]`
 * or the version currently stamped on the branch) to the top under the new
 * version, above its predecessor's entry. Duplicate version headings beyond
 * those the base branch already carries, and a top entry that is not VERSION,
 * are errors. The tree receipt uses
 * `normalizeChangelog` to accept a heading move as a stamp, never a change.
 */
import type { ResultCodeName } from './result-codes';

export interface ChangelogSection {
  /** The heading line as written. */
  heading: string;
  version: string | null;
  unreleased: boolean;
  /** Line offsets into the file (heading inclusive, end exclusive). */
  start: number;
  end: number;
  lines: string[];
}
export interface ParsedChangelog { header: string[]; sections: ChangelogSection[] }
export interface ChangelogError { code: ResultCodeName; path: string; message: string }

const HEADING_RE = /^##\s+(\[)?(?:v)?(\d+(?:\.\d+){1,3}|Unreleased|unreleased)\]?(?:\s*[-–—]\s*(\S.*))?\s*$/;

export function headingVersion(line: string): { version: string | null; unreleased: boolean } | null {
  const m = HEADING_RE.exec(line);
  if (!m) return null;
  const token = m[2]!;
  if (token.toLowerCase() === 'unreleased') return { version: null, unreleased: true };
  return { version: token, unreleased: false };
}

export function parseChangelog(text: string): ParsedChangelog {
  const lines = text.split('\n');
  const starts: number[] = [];
  lines.forEach((l, i) => { if (headingVersion(l)) starts.push(i); });
  const header = lines.slice(0, starts[0] ?? lines.length);
  const sections = starts.map((start, k) => {
    const end = starts[k + 1] ?? lines.length;
    const hv = headingVersion(lines[start]!)!;
    return { heading: lines[start]!, version: hv.version, unreleased: hv.unreleased, start, end, lines: lines.slice(start, end) };
  });
  return { header, sections };
}

/**
 * Duplicate headings, and (when `expectedTop` is given) the top entry equals
 * VERSION. `base` holds readings of the base branch's CHANGELOG (the base tip,
 * and the commit the PR's own lines are counted from): a heading it already carries N
 * times may appear N times here (history the PR inherited and may not
 * rewrite); only an occurrence beyond that count is a duplicate the PR
 * introduced. The count is per heading, not per section body: an inherited
 * copy the PR edits or replaces is caught by the train's released-history
 * checks (`ownEntryAboveMain`, `changelogDamage`), not here.
 */
export function checkChangelog(text: string, expectedTop: string | null, file = 'CHANGELOG.md', base: string[] = []): ChangelogError[] {
  const errors: ChangelogError[] = [];
  const parsed = parseChangelog(text);
  const key = (s: ChangelogSection) => (s.unreleased ? 'Unreleased' : s.version!);
  const inherited = new Map<string, number>();
  for (const reading of base) {
    const counts = new Map<string, number>();
    for (const s of parseChangelog(reading).sections) counts.set(key(s), (counts.get(key(s)) ?? 0) + 1);
    for (const [k, n] of counts) inherited.set(k, Math.max(inherited.get(k) ?? 0, n));
  }
  const seen = new Map<string, number[]>();
  for (const s of parsed.sections) {
    const k = key(s);
    const starts = seen.get(k) ?? [];
    const allowed = Math.max(1, inherited.get(k) ?? 0);
    if (starts.length >= allowed) {
      const where = allowed > 1 ? `headed ${starts.length + 1} times (the base carries it ${allowed} times; first at line ${starts[0]! + 1})` : `already headed at line ${starts[0]! + 1}`;
      errors.push({ code: 'CHANGELOG_DUPLICATE_HEADING', path: `${file}:${s.start + 1}`, message: `${k} ${where}` });
    }
    seen.set(k, [...starts, s.start]);
  }
  if (expectedTop) {
    const top = parsed.sections[0];
    if (!top) errors.push({ code: 'CHANGELOG_TOP_MISMATCH', path: file, message: `no entry; expected ${expectedTop} at the top` });
    else if (top.unreleased || top.version !== expectedTop) errors.push({ code: 'CHANGELOG_TOP_MISMATCH', path: `${file}:${top.start + 1}`, message: `top entry is ${top.unreleased ? '[Unreleased]' : top.version}, VERSION is ${expectedTop}` });
  }
  return errors;
}

function renderHeading(like: string, version: string, date: string): string {
  const bracket = /^##\s+\[/.test(like);
  const vPrefix = /^##\s+\[?v\d/.test(like);
  const dash = /\s+[–—]\s+/.exec(like)?.[0]?.trim() ?? '-';
  const token = `${vPrefix ? 'v' : ''}${version}`;
  return `## ${bracket ? `[${token}]` : token} - ${date}`.replace(' - ', ` ${dash} `);
}

export interface ReheadResult { text: string; moved: boolean; from: string; to: string; error?: ChangelogError }

/**
 * Move the PR's section to the top under `to`. `from` is the version the
 * branch currently carries (its own earlier stamp) or null; `[Unreleased]`
 * is taken first. Idempotent: a top section already headed `to` is a no-op.
 */
export function reheadChangelog(text: string, opts: { from: string | null; to: string; date: string; file?: string }): ReheadResult {
  const file = opts.file ?? 'CHANGELOG.md';
  const parsed = parseChangelog(text);
  const already = parsed.sections.find(s => s.version === opts.to);
  if (already && parsed.sections[0] === already) return { text, moved: false, from: opts.to, to: opts.to };
  const unreleased = parsed.sections.find(s => s.unreleased);
  const own = opts.from ? parsed.sections.find(s => s.version === opts.from) : undefined;
  const section = unreleased ?? own ?? already;
  if (!section) {
    return { text, moved: false, from: opts.from ?? 'Unreleased', to: opts.to, error: { code: 'CHANGELOG_SECTION_MISSING', path: file, message: `no [Unreleased]${opts.from ? ` or ${opts.from}` : ''} section` } };
  }
  const dup = parsed.sections.filter(s => s !== section && (s.unreleased ? section.unreleased : s.version === section.version));
  if (dup.length) {
    return { text, moved: false, from: section.unreleased ? 'Unreleased' : section.version!, to: opts.to, error: { code: 'CHANGELOG_DUPLICATE_HEADING', path: `${file}:${dup[0]!.start + 1}`, message: `${section.unreleased ? 'Unreleased' : section.version} is headed twice` } };
  }
  const body = section.lines.slice(1);
  const newHeading = renderHeading(section.heading, opts.to, opts.date);
  const rest = parsed.sections.filter(s => s !== section).flatMap(s => s.lines);
  const header = [...parsed.header];
  while (header.length && header[header.length - 1] === '') header.pop();
  const out = [...header, ...(header.length ? [''] : []), newHeading, ...body];
  const trimmed = [...out];
  while (trimmed.length && trimmed[trimmed.length - 1] === '') trimmed.pop();
  const joined = [...trimmed, '', ...rest].join('\n');
  return { text: joined.endsWith('\n') ? joined : joined + '\n', moved: true, from: section.unreleased ? 'Unreleased' : section.version!, to: opts.to };
}

/**
 * Receipt normalization: version headings are replaced by a placeholder and
 * sections are compared as an order-independent multiset of lines, so a
 * heading move or re-heading is a stamp and any other edited byte is a change.
 */
export function normalizeChangelog(text: string): string {
  const parsed = parseChangelog(text);
  const sections = parsed.sections.map(s => ['## <version>', ...s.lines.slice(1)].join('\n').replace(/\n+$/, '')).sort();
  return [parsed.header.join('\n').replace(/\n+$/, ''), ...sections].join('\n\u0000');
}

/**
 * A merged-in head's CHANGELOG, however its conflict was resolved: why it is
 * not main's CHANGELOG with the PR's own entry above it, or null. Main's
 * header and every main section must follow unchanged and in order, at least
 * one section must sit above them (a CHANGELOG equal to main's has lost the
 * entry the gate carried), and those sections may hold only lines the PR itself added (`authored`,
 * the + lines of its pin's CHANGELOG diff), so a hand resolve can drop
 * damage but never add text the train gate did not carry.
 */
export function ownEntryAboveMain(head: string, main: string, authored: ReadonlySet<string>): string | null {
  const h = parseChangelog(head);
  const m = parseChangelog(main);
  const trim = (lines: string[]) => { const out = [...lines]; while (out.length && !out[out.length - 1]!.trim()) out.pop(); return out.join('\n'); };
  if (trim(h.header) !== trim(m.header)) return 'the header differs from main';
  const own = h.sections.length - m.sections.length;
  if (own < 0) return `it has ${h.sections.length} sections, main has ${m.sections.length}`;
  const moved = m.sections.findIndex((s, i) => trim(s.lines) !== trim(h.sections[own + i]!.lines));
  if (moved >= 0) return `main's ${m.sections[moved]!.heading.trim()} is not carried unchanged below the PR's entry`;
  if (own === 0) return "it is main's CHANGELOG unchanged, with no entry of the PR's own above it";
  const mainKeys = new Set(m.sections.map(s => s.version ?? 'Unreleased'));
  const clash = h.sections.slice(0, own).find(s => mainKeys.has(s.version ?? 'Unreleased'));
  if (clash) return `${clash.heading.trim()} is headed twice`;
  const added = h.sections.slice(0, own).flatMap(s => s.lines.slice(1)).find(l => l.trim() && !authored.has(l));
  return added === undefined ? null : `the PR's entry holds a line its pin never added: ${JSON.stringify(added.slice(0, 80))}`;
}

const MIN_BLOCK_CHARS = 12;

/** Paragraph blocks of a section's entry text (heading lines dropped), long enough to identify one entry. */
function entryBlocks(s: ChangelogSection): string[] {
  const blocks: string[] = [];
  let run: string[] = [];
  const flush = () => { const text = run.join('\n').trim(); if (text.length >= MIN_BLOCK_CHARS) blocks.push(text); run = []; };
  for (const line of s.lines.slice(1)) {
    if (!line.trim() || line.startsWith('#')) flush();
    else run.push(line);
  }
  flush();
  return blocks;
}

/**
 * Why one side of a CHANGELOG merge damaged released history, or null. A
 * side damages it when it lacks a released heading the merge base carries
 * (dropped, or renamed), or when a section only that side carries holds a
 * paragraph of a released entry the other side carries (a released heading
 * replaced, so its body reads as part of the section above it; #3345).
 */
export function changelogDamage(ours: string, theirs: string, base?: string): string | null {
  const sides = [{ name: 'ours', parsed: parseChangelog(ours) }, { name: 'theirs', parsed: parseChangelog(theirs) }];
  const key = (s: ChangelogSection) => (s.unreleased ? 'Unreleased' : s.version!);
  if (base !== undefined) {
    const released = parseChangelog(base).sections.filter(s => !s.unreleased).map(key);
    for (const side of sides) {
      const has = new Set(side.parsed.sections.map(key));
      const missing = released.find(v => !has.has(v));
      if (missing) return `${side.name} drops released heading ${missing} that the merge base carries`;
    }
  }
  for (const [i, side] of sides.entries()) {
    const other = sides[1 - i]!.parsed.sections;
    const otherKeys = new Set(other.map(key));
    const releasedText = new Map<string, string>();
    for (const s of other.filter(s => !s.unreleased)) for (const b of entryBlocks(s)) releasedText.set(b, s.version!);
    for (const s of side.parsed.sections.filter(s => !otherKeys.has(key(s)))) {
      const hit = entryBlocks(s).find(b => releasedText.has(b));
      if (hit) return `${side.name}'s ${key(s)} section holds released ${releasedText.get(hit)} text (${JSON.stringify(hit.slice(0, 60))}); a released heading was dropped or renamed`;
    }
  }
  return null;
}

const SIMILAR = 0.5;
const GATE_INTEGRITY_RE = /^###\s+Gate integrity\s*$/;

/** The characters two lines share at their start and end (together never more than the shorter line). */
function commonEnds(a: string, b: string): { p: number; s: number } {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < Math.min(a.length, b.length) - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return { p, s };
}

/** Whether one line is an edit of the other: half or more of the longer one is shared at its ends, or the shorter is wholly kept (an extension). */
function isEdit(a: string, b: string): boolean {
  const strip = (l: string) => l.trim().replace(/^[-*]\s+/, '');
  const [x, y] = [strip(a), strip(b)];
  const { p, s } = commonEnds(x, y);
  const min = Math.min(x.length, y.length);
  return p + s >= Math.max(x.length, y.length) * SIMILAR || (min >= 3 && p + s === min);
}

/** The fragments an edit replaced, widened to word boundaries and to at least one word on each side. */
function fragments(removed: string, added: string): { old: string; new: string } {
  const { p, s } = commonEnds(removed, added);
  let from = removed.slice(0, p).search(/\S*$/);
  let keep = s - (/^\S*/.exec(removed.slice(removed.length - s))?.[0].length ?? 0);
  const cut = () => ({ old: removed.slice(from, removed.length - keep).trim(), new: added.slice(from, added.length - keep).trim() });
  let f = cut();
  while ((!f.old || !f.new) && (from > 0 || keep > 0)) {
    from = Math.max(0, removed.slice(0, from).search(/\S+\s*$/));
    keep -= /^\s*\S*/.exec(removed.slice(removed.length - keep))?.[0].length ?? keep;
    f = cut();
  }
  return f.old && f.new ? f : { old: removed.trim(), new: added.trim() };
}

/**
 * A stacked child whose parent squash-merged and was released since the fork
 * (GSTA-96, train 24: #3453 after #3434 became 1.91.276.0). `ours`'
 * `[Unreleased]` still holds the parent's entry as the child forked it, maybe
 * edited, while `theirs` carries that entry under a released heading the
 * merge base lacks. The parent's lines leave the child's section; each line
 * the child changed inside them becomes a correction bullet under the child's
 * own `### Gate integrity` (the convention #3453's entry used for its parent),
 * so no wording the gate carried is lost and the released entry below stays
 * byte for byte main's. A line the child inserted between two of the parent's
 * lines counts as an addition to the parent's entry, unless that would leave
 * the child nothing of its own: then the inserted lines are the child's entry
 * (#3613 put its only bullet at the top of #3595's `### Changed` list), and a
 * line meant as an amendment to the parent lands there too. Null when the
 * shape is something else: no single `[Unreleased]` on our side, no released
 * entry of theirs the base lacks whose text our section holds, nothing of the
 * child's own left either way, or a child entry that repeats a released
 * parent line (a reordered or duplicated bullet is a hand resolve).
 */
export function carryReleasedParent(ours: string, theirs: string, base: string): { text: string; notes: string[] } | null {
  return carryWith(ours, theirs, base, true) ?? carryWith(ours, theirs, base, false);
}

function carryWith(ours: string, theirs: string, base: string, insertsJoinParent: boolean): { text: string; notes: string[] } | null {
  const a = parseChangelog(ours);
  const unreleased = a.sections.filter(s => s.unreleased);
  if (unreleased.length !== 1) return null;
  const baseKeys = new Set(parseChangelog(base).sections.map(s => s.version ?? 'Unreleased'));
  const content = (l: string) => Boolean(l.trim()) && !l.startsWith('#');
  let lines = unreleased[0]!.lines.slice(1);
  const notes: string[] = [];
  const bullets: string[] = [];
  let carried = false;
  const parentLines = new Set<string>();
  for (const parent of parseChangelog(theirs).sections.filter(s => !s.unreleased && !baseKeys.has(s.version!))) {
    const pl = parent.lines.slice(1);
    const ownBlocks = entryBlocks({ ...unreleased[0]!, lines: ['', ...lines] });
    if (!entryBlocks(parent).some(b => ownBlocks.includes(b))) continue;
    carried = true;
    for (const l of pl) if (content(l)) parentLines.add(l);
    // LCS over content lines only: blanks and sub-headings recur in both entries and would anchor wrongly.
    const lcs = Array.from({ length: pl.length + 1 }, () => new Uint32Array(lines.length + 1));
    for (let i = pl.length - 1; i >= 0; i--) for (let j = lines.length - 1; j >= 0; j--) {
      lcs[i]![j] = pl[i] === lines[j] && content(pl[i]!) ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
    const parentAt = new Set<number>();
    const hunks: Array<{ removed: string[]; added: number[] }> = [{ removed: [], added: [] }];
    for (let i = 0, j = 0; i < pl.length || j < lines.length;) {
      if (i < pl.length && j < lines.length && pl[i] === lines[j] && content(pl[i]!)) { parentAt.add(j); i++; j++; hunks.push({ removed: [], added: [] }); }
      else if (i < pl.length && (j === lines.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) { if (content(pl[i]!)) hunks.at(-1)!.removed.push(pl[i]!); i++; }
      else { if (content(lines[j]!)) hunks.at(-1)!.added.push(j); j++; }
    }
    const v = parent.version!;
    const strip = (l: string) => l.trim().replace(/^[-*]\s+/, '');
    hunks.forEach((h, k) => {
      for (const removed of h.removed) {
        const best = h.added.find(j => isEdit(removed, lines[j]!));
        if (best !== undefined) {
          h.added.splice(h.added.indexOf(best), 1);
          parentAt.add(best);
          const f = fragments(removed, lines[best]!);
          bullets.push(`- Correction to the ${v} entry below: "${f.old}" should read "${f.new}".`);
          notes.push(`${v}: "${f.old}" -> "${f.new}"`);
        } else {
          bullets.push(`- Correction to the ${v} entry below: "${strip(removed)}" no longer applies.`);
          notes.push(`${v}: dropped "${strip(removed).slice(0, 60)}"`);
        }
      }
      // Lines added between two of the parent's own lines, or after its last beside an edit there, belong to its entry; the rest are the child's.
      if (insertsJoinParent && k > 0 && (k < hunks.length - 1 || h.removed.length)) for (const j of h.added) {
        parentAt.add(j);
        bullets.push(`- Addition to the ${v} entry below: ${strip(lines[j]!)}`);
        notes.push(`${v}: added "${strip(lines[j]!).slice(0, 60)}"`);
      }
    });
    lines = lines.filter((_, j) => !parentAt.has(j));
  }
  if (!carried) return null;
  // Sub-headings left without content, then runs of blank lines, then the edges.
  const kept: string[] = [];
  lines.forEach((l, j) => {
    if (l.startsWith('#')) { const next = lines.slice(j + 1).find(x => x.trim()); if (!next || next.startsWith('#')) return; }
    if (!l.trim() && (!kept.length || !kept.at(-1)!.trim())) return;
    kept.push(l);
  });
  while (kept.length && !kept.at(-1)!.trim()) kept.pop();
  if (!kept.some(content)) return null;
  if (kept.some(l => content(l) && parentLines.has(l))) return null;
  if (bullets.length) {
    const at = kept.findIndex(l => GATE_INTEGRITY_RE.test(l));
    if (at < 0) kept.push('', '### Gate integrity', ...bullets);
    else {
      let end = kept.findIndex((l, j) => j > at && l.startsWith('#'));
      if (end < 0) end = kept.length;
      while (end > at + 1 && !kept[end - 1]!.trim()) end--;
      kept.splice(end, 0, ...bullets);
    }
  }
  const section = { ...unreleased[0]!, lines: [unreleased[0]!.heading, '', ...kept, ''] };
  const out = [...a.header, ...a.sections.flatMap(s => (s === unreleased[0] ? section.lines : s.lines))].join('\n');
  return { text: out.endsWith('\n') ? out : out + '\n', notes };
}

/**
 * Gate-ahead merge of two CHANGELOGs that conflict textually but not
 * semantically: the predecessor's header and sections, with the branch's own
 * sections (those the predecessor lacks, by heading) placed first. When the
 * branch's top section carries the same version heading as a predecessor
 * section with a different body (both took the same tentative stamp), the
 * branch's entry is kept under `[Unreleased]` so the restamp re-heads it.
 * Both sides carrying `[Unreleased]` is a real conflict and returns null, and
 * so is damage to released history (`changelogDamage`): null means a hand
 * resolve, never a merge that carries the damage through. With `base`, a
 * stacked child whose parent was released since the fork is first rewritten
 * by `carryReleasedParent`; `mergeChangelogsWithNotes` returns what it
 * carried.
 */
export function mergeChangelogs(ours: string, theirs: string, base?: string): string | null {
  return mergeChangelogsWithNotes(ours, theirs, base).text;
}

export function mergeChangelogsWithNotes(ours: string, theirs: string, base?: string): { text: string | null; notes: string[] } {
  const carry = base !== undefined ? carryReleasedParent(ours, theirs, base) : null;
  if (carry) ours = carry.text;
  const notes = carry?.notes ?? [];
  if (changelogDamage(ours, theirs, base)) return { text: null, notes };
  const a = parseChangelog(ours);
  const b = parseChangelog(theirs);
  const key = (s: ChangelogSection) => (s.unreleased ? 'Unreleased' : s.version!);
  const entryText = (s: ChangelogSection) => s.lines.slice(1).join('\n').replace(/\n+$/, '');
  const top = a.sections[0];
  if (top && !top.unreleased && b.sections.some(s => key(s) === key(top) && entryText(s) !== entryText(top))) {
    const heading = /^##\s+\[/.test(top.heading) ? '## [Unreleased]' : '## Unreleased';
    a.sections[0] = { ...top, unreleased: true, version: null, heading, lines: [heading, ...top.lines.slice(1)] };
  }
  const theirKeys = new Set(b.sections.map(key));
  const ownOnly = a.sections.filter(s => !theirKeys.has(key(s)));
  if (a.sections.filter(s => s.unreleased).length > 1) return { text: null, notes };
  if (a.sections.some(s => s.unreleased) && b.sections.some(s => s.unreleased)) return { text: null, notes };
  const header = [...b.header];
  while (header.length && header[header.length - 1] === '') header.pop();
  const body = [...ownOnly, ...b.sections].flatMap(s => { const lines = [...s.lines]; while (lines.length && lines[lines.length - 1] === '') lines.pop(); return [...lines, '']; });
  return { text: [...header, ...(header.length ? [''] : []), ...body].join('\n').replace(/\n+$/, '\n'), notes };
}
