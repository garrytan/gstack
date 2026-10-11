/**
 * changelog-check — CHANGELOG re-heading and checks for gstack-restamp (C2)
 * and the tree receipt (C3). A restamp moves the PR's section (`[Unreleased]`
 * or the version currently stamped on the branch) to the top under the new
 * version, above its predecessor's entry. Duplicate version headings and a
 * top entry that is not VERSION are errors. The tree receipt uses
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

/** Duplicate headings, and (when `expectedTop` is given) the top entry equals VERSION. */
export function checkChangelog(text: string, expectedTop: string | null, file = 'CHANGELOG.md'): ChangelogError[] {
  const errors: ChangelogError[] = [];
  const parsed = parseChangelog(text);
  const seen = new Map<string, number>();
  for (const s of parsed.sections) {
    const key = s.unreleased ? 'Unreleased' : s.version!;
    if (seen.has(key)) errors.push({ code: 'CHANGELOG_DUPLICATE_HEADING', path: `${file}:${s.start + 1}`, message: `${key} already headed at line ${seen.get(key)! + 1}` });
    else seen.set(key, s.start);
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
 * Gate-ahead merge of two CHANGELOGs that conflict textually but not
 * semantically: the predecessor's header and sections, with the branch's own
 * sections (those the predecessor lacks, by heading) placed first. Both sides
 * carrying `[Unreleased]` is a real conflict and returns null.
 */
export function mergeChangelogs(ours: string, theirs: string): string | null {
  const a = parseChangelog(ours);
  const b = parseChangelog(theirs);
  const key = (s: ChangelogSection) => (s.unreleased ? 'Unreleased' : s.version!);
  const theirKeys = new Set(b.sections.map(key));
  const ownOnly = a.sections.filter(s => !theirKeys.has(key(s)));
  if (a.sections.some(s => s.unreleased) && b.sections.some(s => s.unreleased)) return null;
  const header = [...b.header];
  while (header.length && header[header.length - 1] === '') header.pop();
  const body = [...ownOnly, ...b.sections].flatMap(s => { const lines = [...s.lines]; while (lines.length && lines[lines.length - 1] === '') lines.pop(); return [...lines, '']; });
  return [...header, ...(header.length ? [''] : []), ...body].join('\n').replace(/\n+$/, '\n');
}
