// lib/design-md.ts — read and write DESIGN.md in the open DESIGN.md format.
//
// Implements the DESIGN.md specification (google-labs-code/design.md, Google LLC,
// Apache-2.0): YAML front matter carrying the design tokens, a markdown body in
// eight canonical `##` sections. See NOTICE.md. Pure module: no I/O, no imports
// from scripts/; bin/gstack-design-md.ts and design/src/memory.ts do the file work.
//
//   text ──► parseDesignMd ──► DesignMdDoc { frontmatterText (bytes preserved), frontmatter, marker,
//                                             preamble, sections[] }
//        ──► detectFormat   ──► spec | legacy | unknown | missing (+ reason)
//        ──► convertLegacy  ──► gstack's pre-spec DESIGN.md (Product Context, Aesthetic Direction,
//                               Typography, Color, Spacing, Layout, Motion, Decisions Log) becomes
//                               tokens + canonical sections; Motion and Decisions Log survive as extras
//        ──► upsertSection  ──► body-only splice on the parsed doc (files gstack writes from scratch)
//        ──► renderDesignMd ──► marker, front matter, preamble, canonical sections in order, extras
//   text ──► spliceSection / insertMarker ──► text-level edits of a file the USER owns: one section
//                                             body or one marker line changes; the BOM, the majority
//                                             line ending, and every other line survive (the `mark`
//                                             verb, the design binary's extraction section). A file
//                                             with an unclosed fence is refused (DesignMdEditRefused).
//        ──► tokensFlat     ──► "colors.primary" → "#F59E0B"; {path} refs resolved to primitives
//
// Format marker (the user's one-time conversion answer, persisted in the file):
//   spec files:   line 1 `---`, line 2 `# gstack: design-md-format=spec` (a YAML comment, so
//                 parsers that require `---` on line 1 keep working)
//   legacy files: line 1 `<!-- gstack: design-md-format=legacy-keep -->`

import { SENTINEL } from './design-detect-contract';

export const CANONICAL_SECTIONS = [
  'Overview', 'Colors', 'Typography', 'Layout', 'Elevation & Depth', 'Shapes', 'Components', "Do's and Don'ts",
] as const;
export type CanonicalSection = (typeof CANONICAL_SECTIONS)[number];

/** Spec aliases (and a few punctuation variants) → canonical heading. */
export const SECTION_ALIASES: Record<string, CanonicalSection> = {
  'brand & style': 'Overview',
  'brand and style': 'Overview',
  'layout & spacing': 'Layout',
  'layout and spacing': 'Layout',
  'elevation': 'Elevation & Depth',
  'elevation and depth': 'Elevation & Depth',
  "do's and don'ts": "Do's and Don'ts",
  'dos and donts': "Do's and Don'ts",
  "do’s and don’ts": "Do's and Don'ts",
};

export const TOKEN_GROUPS = ['colors', 'typography', 'rounded', 'spacing', 'components'] as const;
export type TokenGroup = (typeof TOKEN_GROUPS)[number];

export const FORMAT_MARKER_PREFIX = 'gstack: design-md-format=';
export const FORMAT_CHOICES = ['spec', 'legacy-keep'] as const;
export type FormatChoice = (typeof FORMAT_CHOICES)[number];
const MARKER_RE_BODY = FORMAT_MARKER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(' + FORMAT_CHOICES.join('|') + ')';
/** `<!-- gstack: design-md-format=... -->` on line 1 (legacy files) */
const LEGACY_MARKER_RE = new RegExp('^<!--[ \\t]*' + MARKER_RE_BODY + '[ \\t]*-->\\n?');
/** `# gstack: design-md-format=...` as a YAML comment inside the front matter (spec files) */
// `[ \\t]*$`, never `\\s*$`: a multi-line match would swallow the blank line after the marker.
const YAML_MARKER_RE = new RegExp('^# ' + MARKER_RE_BODY + '[ \\t]*$', 'm');
/** The marker line inside front matter, newline included (renderDesignMd drops it before re-emitting the marker itself). */
const YAML_MARKER_LINE_RE = new RegExp(YAML_MARKER_RE.source + '\\n', 'm');
/** A front matter opener immediately followed by the marker line (insertMarker replaces the old choice). */
const FRONTMATTER_OPEN_WITH_MARKER_RE = new RegExp('^---\\n' + YAML_MARKER_RE.source.replace(/^\^/, '') + '\\n', 'm');
/** Maximum `{path}` reference hops before a chain counts as a cycle. */
export const TOKEN_REF_MAX_HOPS = 8;
/** Headings that mark gstack's pre-spec file by themselves (either one is enough evidence of a legacy shape). */
export const LEGACY_IDENTITY_HEADINGS = ['Product Context', 'Aesthetic Direction'] as const;
export type DesignMdFormat = 'spec' | 'legacy' | 'unknown' | 'missing';
/** Machine-readable reason for an `unknown` (or `missing`) verdict; `reason` is the prose. */
export type FormatCode = 'spec' | 'legacy' | 'missing' | 'frontmatter-unparsable' | 'ambiguous' | 'no-token-groups' | 'no-shape';

/** Headings that identify gstack's pre-spec DESIGN.md. */
export const LEGACY_HEADINGS = [...LEGACY_IDENTITY_HEADINGS, 'Color', 'Spacing', 'Decisions Log'];

export interface Section {
  heading: string;
  /** canonical name when the heading (or an alias) is one of the eight */
  canonical?: CanonicalSection;
  /** body text between this heading and the next `##`, without the trailing blank run */
  body: string;
}

export interface DesignMdDoc {
  /** raw YAML between the fences, bytes preserved (null when no front matter) */
  frontmatterText: string | null;
  /** parsed YAML (null when absent or unparsable) */
  frontmatter: Record<string, unknown> | null;
  frontmatterError?: string;
  marker: FormatChoice | null;
  /** text between the front matter (or file start) and the first `##` heading, trimmed */
  preamble: string;
  sections: Section[];
}

// ── Parsing ──────────────────────────────────────────────────────────────────

function canonicalFor(heading: string): CanonicalSection | undefined {
  const key = heading.trim().toLowerCase();
  const direct = CANONICAL_SECTIONS.find(c => c.toLowerCase() === key);
  return direct ?? SECTION_ALIASES[key];
}

function parseYaml(text: string): { value: Record<string, unknown> | null; error?: string } {
  try {
    const v = (Bun as unknown as { YAML: { parse(s: string): unknown } }).YAML.parse(text);
    if (v === null || v === undefined) return { value: {} };
    if (typeof v !== 'object' || Array.isArray(v)) return { value: null, error: 'front matter is not a mapping' };
    return { value: v as Record<string, unknown> };
  } catch (e) {
    return { value: null, error: (e as Error).message.split('\n')[0].slice(0, 200) };
  }
}

/** A UTF-8 byte-order mark (Windows editors write one); text-level editors keep it at byte 0. */
const BOM = '\uFEFF';

export function parseDesignMd(text: string): DesignMdDoc {
  const src = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  let rest = src;
  let marker: FormatChoice | null = null;
  let frontmatterText: string | null = null;
  let frontmatter: Record<string, unknown> | null = null;
  let frontmatterError: string | undefined;

  const legacyMarker = rest.match(LEGACY_MARKER_RE);
  if (legacyMarker) {
    marker = legacyMarker[1] as FormatChoice;
    rest = rest.slice(legacyMarker[0].length);
  }
  if (rest.startsWith('---\n')) {
    // The closing fence is a whole line of `---` (trailing spaces allowed, an editor artifact); a value line like `---x` is not one.
    const close = /^---[ \t]*$/m.exec(rest.slice(4));
    if (close) {
      frontmatterText = rest.slice(4, 4 + close.index);
      const m = frontmatterText.match(YAML_MARKER_RE);
      if (m) marker = m[1] as FormatChoice;
      const parsed = parseYaml(frontmatterText);
      frontmatter = parsed.value;
      frontmatterError = parsed.error;
      rest = rest.slice(4 + close.index + close[0].length + 1);
    }
  }

  const lines = rest.split('\n');
  const { heads } = headingLines(lines);
  const preambleLines = lines.slice(0, heads[0]?.index ?? lines.length);
  const sections: Section[] = heads.map((h, k) => {
    const canonical = canonicalFor(h.heading);
    const body = lines.slice(h.index + 1, heads[k + 1]?.index ?? lines.length).join('\n').replace(/\s+$/, '');
    return { heading: h.heading, ...(canonical ? { canonical } : {}), body };
  });
  return { frontmatterText, frontmatter, frontmatterError, marker, preamble: preambleLines.join('\n').trim(), sections };
}

/**
 * The `## ` headings of a body, with code fences skipped: the one section-
 * boundary rule, shared by parseDesignMd and spliceSection so they cannot drift.
 * Markdown semantics: an unclosed fence runs to the end of the file, so nothing
 * after it is a heading. Readers accept that; spliceSection refuses to edit such
 * a file (`unclosedFence`), because "which section" is ambiguous there.
 */
function headingLines(lines: string[]): { heads: Array<{ index: number; heading: string }>; unclosedFence: boolean } {
  const heads: Array<{ index: number; heading: string }> = [];
  let fence: string | null = null; // the opener's characters (``` or ~~~); only the same kind closes it
  for (let i = 0; i < lines.length; i++) {
    const f = lines[i].match(/^(```|~~~)/);
    if (f && fence === null) { fence = f[1]; continue; }
    if (f && fence === f[1]) { fence = null; continue; }
    if (fence !== null) continue;
    const h = lines[i].match(/^## (.+?)\s*$/);
    if (h) heads.push({ index: i, heading: h[1] });
  }
  return { heads, unclosedFence: fence !== null };
}

/** Thrown by the text-level editors when the file cannot be edited safely (an unclosed code fence). The bins print it as DESIGN_MD_EDIT_REFUSED and leave the file unchanged. */
export class DesignMdEditRefused extends Error {
  constructor(reason: string) { super(`${SENTINEL.DESIGN_MD_EDIT_REFUSED}: ${reason}; file unchanged`); this.name = 'DesignMdEditRefused'; }
}

/** Does a section heading name the requested section? By canonical name when the request has one, else by exact (case-insensitive) heading. */
function headingMatches(heading: string, wanted: string, canonical: CanonicalSection | null): boolean {
  return canonical ? canonicalFor(heading) === canonical : heading.trim().toLowerCase() === wanted.trim().toLowerCase();
}

/** The file's majority line ending; text-level editors restore it so a CRLF file stays CRLF (a lone stray CRLF in an LF file does not flip the file). */
function eolOf(text: string): string {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

// ── Format detection ─────────────────────────────────────────────────────────

export function isLegacyGstackFormat(doc: DesignMdDoc): boolean {
  const headings = new Set(doc.sections.map(s => s.heading.trim().toLowerCase()));
  const hits = LEGACY_HEADINGS.filter(h => headings.has(h.toLowerCase())).length;
  return doc.frontmatterText === null && hits >= 2;
}

export function hasSpecFrontmatter(doc: DesignMdDoc): boolean {
  if (!doc.frontmatter) return false;
  return TOKEN_GROUPS.some(g => g in doc.frontmatter!) || 'name' in doc.frontmatter;
}

export function detectFormat(doc: DesignMdDoc | null): { format: DesignMdFormat; code: FormatCode; reason?: string } {
  if (!doc) return { format: 'missing', code: 'missing' };
  if (doc.frontmatterText !== null && doc.frontmatter === null) {
    return { format: 'unknown', code: 'frontmatter-unparsable', reason: `front matter does not parse: ${doc.frontmatterError ?? 'unknown error'}` };
  }
  const spec = hasSpecFrontmatter(doc);
  const identity = new Set<string>(LEGACY_IDENTITY_HEADINGS.map(h => h.toLowerCase()));
  const legacyHeadings = doc.sections.some(s => identity.has(s.heading.trim().toLowerCase()));
  if (spec && legacyHeadings) return { format: 'unknown', code: 'ambiguous', reason: 'ambiguous (legacy headings and front matter both present)' };
  if (spec) return { format: 'spec', code: 'spec' };
  if (isLegacyGstackFormat(doc)) return { format: 'legacy', code: 'legacy' };
  if (doc.frontmatterText !== null) return { format: 'unknown', code: 'no-token-groups', reason: 'front matter carries none of the five token groups' };
  return { format: 'unknown', code: 'no-shape', reason: 'no front matter and no gstack legacy headings' };
}

// ── YAML block emitter ───────────────────────────────────────────────────────

function needsQuotes(s: string): boolean {
  // Control characters (an LLM-extracted font family with an embedded newline) must
  // go through the double-quoted form: a bare multi-line scalar does not parse back.
  // `\s#` too: a plain scalar ending in ` #F59E0B` would parse back as a comment. YAML 1.2 also
  // reads 0x1F / 0o17 / .inf / .nan as numbers, so those shapes are quoted as well.
  return s === '' || /[\x00-\x1f\x7f]/.test(s) || /^[\s#&*!|>'"%@`{[\]},:?-]|[:#]\s|\s#|\s$|^(true|false|null|yes|no|on|off|~)$|^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$|^0[xob][0-9a-f_]+$|^[-+]?\.(inf|nan)$/i.test(s);
}

function yamlScalar(v: unknown): string {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v === null || v === undefined) return '""';
  const s = String(v);
  return needsQuotes(s) ? JSON.stringify(s) : s;
}

/** Block-style YAML for nested mappings of scalars (Bun.YAML.stringify emits flow style). */
export function emitYamlBlock(obj: Record<string, unknown>, indent = 0): string {
  const pad = ' '.repeat(indent);
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = needsQuotes(k) ? JSON.stringify(k) : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out.push(`${pad}${key}:`);
      out.push(emitYamlBlock(v as Record<string, unknown>, indent + 2));
    } else if (Array.isArray(v)) {
      out.push(`${pad}${key}:`);
      for (const item of v) {
        if (item !== null && typeof item === 'object') throw new TypeError('emitYamlBlock: array items must be scalars (a nested object would be written as "[object Object]")');
        out.push(`${pad}  - ${yamlScalar(item)}`);
      }
    } else {
      out.push(`${pad}${key}: ${yamlScalar(v)}`);
    }
  }
  return out.join('\n');
}

// ── Rendering ────────────────────────────────────────────────────────────────

export interface RenderOptions {
  /** emit fresh front matter from `frontmatter` instead of the preserved bytes (convert only) */
  emitFrontmatter?: boolean;
}

export function renderDesignMd(doc: DesignMdDoc, opts: RenderOptions = {}): string {
  const parts: string[] = [];
  const fm = opts.emitFrontmatter && doc.frontmatter ? emitYamlBlock(doc.frontmatter) + '\n' : doc.frontmatterText;
  if (fm !== null) {
    const body = fm.replace(YAML_MARKER_LINE_RE, '');
    parts.push('---');
    if (doc.marker) parts.push(`# ${FORMAT_MARKER_PREFIX}${doc.marker}`);
    parts.push(body.replace(/\n$/, ''));
    parts.push('---');
    if (doc.preamble) parts.push('', doc.preamble);
  } else {
    if (doc.marker) parts.push(`<!-- ${FORMAT_MARKER_PREFIX}${doc.marker} -->`);
    if (doc.preamble) parts.push(doc.preamble);
  }
  // Spec order is a spec-file property. A legacy or unknown file keeps its own
  // order (Typography and Layout are canonical names, but re-sorting a file the
  // user chose to keep legacy would rewrite it behind their back).
  const specShaped = fm !== null;
  const ordered = specShaped
    ? [
      ...CANONICAL_SECTIONS.map(c => doc.sections.find(s => s.canonical === c)).filter((s): s is Section => Boolean(s)),
      ...doc.sections.filter(s => !s.canonical),
    ]
    : doc.sections;
  for (const s of ordered) {
    parts.push('', `## ${specShaped ? (s.canonical ?? s.heading) : s.heading}`);
    if (s.body.trim()) parts.push('', s.body.trim());
  }
  return parts.join('\n').replace(/^\n+/, '') + '\n';
}

/**
 * Text-level section splice: replace the body of `## <heading>` (matched by
 * canonical name or exact heading) or append the section at the end. Every other
 * byte of the file, front matter included, is untouched. This is what a tool
 * that edits a file the user owns should use; renderDesignMd is for files gstack
 * writes from scratch (convert, skeletons).
 */
export function spliceSection(text: string, heading: string, body: string): string {
  const bom = text.startsWith(BOM) ? BOM : '';
  const eol = eolOf(text);
  const src = text.slice(bom.length).replace(/\r\n/g, '\n');
  const canonical = canonicalFor(heading);
  const lines = src.split('\n');
  const { heads, unclosedFence } = headingLines(lines);
  if (unclosedFence) throw new DesignMdEditRefused('unclosed code fence (```) makes the section boundaries ambiguous');
  const k = heads.findIndex(h => headingMatches(h.heading, heading, canonical));
  const block = `## ${canonical ?? heading}\n\n${body.replace(/\s+$/, '')}\n`;
  let out: string;
  if (k === -1) {
    out = src.replace(/\s*$/, '') + '\n\n' + block;
  } else {
    const start = heads[k].index;
    const end = heads[k + 1]?.index ?? lines.length;
    const before = lines.slice(0, start).join('\n');
    const after = lines.slice(end).join('\n');
    out = before + (before ? '\n' : '') + block + (after.trim() ? '\n' + after.replace(/^\n+/, '') : '');
  }
  return bom + (eol === '\n' ? out : out.replace(/\n/g, eol));
}

/**
 * Text-level marker insertion: a YAML comment on line 2 of a file that opens
 * with front matter, an HTML comment on line 1 otherwise. Replaces an existing
 * marker; every other byte is untouched.
 */
export function insertMarker(text: string, choice: FormatChoice): string {
  const bom = text.startsWith(BOM) ? BOM : '';
  const eol = eolOf(text);
  const src = text.slice(bom.length).replace(/\r\n/g, '\n');
  const stripped = src.replace(LEGACY_MARKER_RE, '');
  let out: string;
  // Front matter, not "starts with ---": a legacy file opening with a horizontal rule gets the HTML comment.
  if (parseDesignMd(stripped).frontmatterText !== null) {
    const withoutOld = stripped.replace(FRONTMATTER_OPEN_WITH_MARKER_RE, '---\n');
    out = withoutOld.replace(/^---\n/, `---\n# ${FORMAT_MARKER_PREFIX}${choice}\n`);
  } else {
    out = `<!-- ${FORMAT_MARKER_PREFIX}${choice} -->\n` + stripped;
  }
  return bom + (eol === '\n' ? out : out.replace(/\n/g, eol));
}

/** Replace or add a section; canonical names slot into spec order, extras append. Body-only: front matter bytes untouched. */
export function upsertSection(doc: DesignMdDoc, heading: string, body: string): DesignMdDoc {
  const canonical = canonicalFor(heading);
  const sections = doc.sections.map(s => ({ ...s }));
  const idx = sections.findIndex(s => headingMatches(s.heading, heading, canonical));
  const next: Section = { heading: canonical ?? heading, ...(canonical ? { canonical } : {}), body: body.replace(/\s+$/, '') };
  if (idx >= 0) sections[idx] = next; else sections.push(next);
  return { ...doc, sections };
}

// ── Tokens ───────────────────────────────────────────────────────────────────

export interface FlatTokens {
  tokens: Record<string, string>;
  errors: string[];
}

/** Flatten the five token groups to dotted paths; resolve `{path}` references to primitives. */
export function tokensFlat(frontmatter: Record<string, unknown> | null): FlatTokens {
  const tokens: Record<string, string> = {};
  const errors: string[] = [];
  if (!frontmatter) return { tokens, errors };
  const raw: Record<string, unknown> = {};
  const walk = (prefix: string, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(prefix ? `${prefix}.${k}` : k, x);
    } else if (v !== null && v !== undefined && !Array.isArray(v)) {
      raw[prefix] = v;
    }
  };
  for (const g of TOKEN_GROUPS) if (g in frontmatter) walk(g, frontmatter[g]);
  const groups = new Set(Object.keys(raw).map(k => k.split('.').slice(0, -1).join('.')).filter(Boolean));
  for (const [k, v] of Object.entries(raw)) {
    const s = String(v);
    const ref = s.match(/^\{([a-zA-Z0-9_.-]+)\}$/);
    if (!ref) { tokens[k] = s; continue; }
    const target = ref[1];
    if (target === k) { errors.push(`${SENTINEL.DESIGN_MD_TOKEN_REF_INVALID}: {${target}} (self-reference)`); continue; }
    if (groups.has(target) || TOKEN_GROUPS.includes(target as TokenGroup)) { errors.push(`${SENTINEL.DESIGN_MD_TOKEN_REF_INVALID}: {${target}} (refers to a group, not a primitive)`); continue; }
    let seen = 0;
    let cur: unknown = raw[target];
    let curKey = target;
    while (typeof cur === 'string' && /^\{[a-zA-Z0-9_.-]+\}$/.test(cur) && seen < TOKEN_REF_MAX_HOPS) {
      curKey = cur.slice(1, -1);
      cur = raw[curKey];
      seen++;
    }
    if (cur === undefined) { errors.push(`${SENTINEL.DESIGN_MD_TOKEN_REF_INVALID}: {${target}} (no such token)`); continue; }
    if (typeof cur === 'string' && /^\{/.test(cur)) { errors.push(`${SENTINEL.DESIGN_MD_TOKEN_REF_INVALID}: {${target}} (reference cycle)`); continue; }
    tokens[k] = String(cur);
  }
  return { tokens, errors };
}

// ── Legacy conversion ────────────────────────────────────────────────────────

/** kebab-case token key from a human label */
export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'token';
}

/** Legacy Color bullets whose label names a strategy or a mode, not a color. */
const NOT_COLOR_LABELS = new Set(['approach', 'semantic', 'dark mode', 'light mode', 'neutrals', 'contrast', 'strategy']);

function bullets(body: string): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  for (const line of body.split('\n')) {
    const m = line.match(/^\s*-\s+\*\*(.+?):?\*\*:?\s*(.*)$/);
    if (m) out.push({ key: m[1].trim().replace(/:$/, ''), value: m[2].trim() });
  }
  return out;
}

const HEX = /#[0-9a-fA-F]{3,8}\b/;

function sectionBody(doc: DesignMdDoc, heading: string): string | undefined {
  return doc.sections.find(s => s.heading.trim().toLowerCase() === heading.toLowerCase())?.body;
}

function firstFontName(value: string): string | undefined {
  const m = value.match(/^([A-Z][A-Za-z0-9 ]+?)(?:\s*\(|\s+—|\s+-\s|,|$)/);
  return m ? m[1].trim() : undefined;
}

/**
 * Convert gstack's pre-spec DESIGN.md into the open format. Product Context and
 * Aesthetic Direction fold into Overview; Typography roles become
 * typography.display/body/label/mono; Color hexes become colors; the Spacing
 * scale becomes spacing; the Layout border radii become rounded; everything else
 * (Motion, Decisions Log, Grain Texture, ...) survives as an extra section in
 * its original order. Idempotent: converting the render again changes nothing.
 */
export function convertLegacy(doc: DesignMdDoc, opts: { name?: string } = {}): DesignMdDoc {
  // A heading the conversion consumes must be unique, or a second body would be silently dropped.
  const counts = new Map<string, number>();
  for (const s of doc.sections) counts.set(s.heading.trim().toLowerCase(), (counts.get(s.heading.trim().toLowerCase()) ?? 0) + 1);
  for (const h of [...LEGACY_HEADINGS, 'Typography', 'Layout', 'Colors']) {
    if ((counts.get(h.toLowerCase()) ?? 0) > 1) throw new DesignMdEditRefused(`legacy heading "## ${h}" appears more than once`);
  }
  if (counts.has('color') && counts.has('colors')) throw new DesignMdEditRefused('both "## Color" and "## Colors" are present');
  const title = doc.preamble.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const name = opts.name ?? (title ? title.replace(/^Design System\s*[—–-]\s*/i, '').trim() : 'Design System');
  const fm: Record<string, unknown> = { name };

  const overview: string[] = [];
  const product = sectionBody(doc, 'Product Context');
  const aesthetic = sectionBody(doc, 'Aesthetic Direction');
  if (product) overview.push(product.trim());
  if (aesthetic) overview.push(aesthetic.trim());

  // Typography
  const typo = sectionBody(doc, 'Typography');
  const typography: Record<string, Record<string, string>> = {};
  if (typo) {
    const roleMap: Array<[RegExp, string]> = [
      [/^display/i, 'display'], [/^hero/i, 'display'], [/^body/i, 'body'], [/^ui/i, 'label'], [/^label/i, 'label'],
      [/^data/i, 'mono'], [/^code/i, 'mono'], [/^mono/i, 'mono'],
    ];
    for (const b of bullets(typo)) {
      const role = roleMap.find(([re]) => re.test(b.key))?.[1];
      if (!role || typography[role]) continue;
      if (/same as/i.test(b.value)) { const src = b.value.match(/same as (\w+)/i)?.[1]?.toLowerCase(); if (src && typography[src]) typography[role] = { ...typography[src] }; continue; }
      const family = firstFontName(b.value);
      if (!family) continue;
      const t: Record<string, string> = { fontFamily: family };
      if (role === 'mono') t.fontFeature = 'tnum';
      typography[role] = t;
    }
  }
  if (Object.keys(typography).length) fm.typography = typography;

  // Colors
  const color = sectionBody(doc, 'Color') ?? sectionBody(doc, 'Colors');
  const colors: Record<string, string> = {};
  if (color) {
    for (const line of color.split('\n')) {
      const hex = line.match(HEX)?.[0];
      if (!hex) continue;
      const label = (line.match(/\*\*(.+?):?\*\*/)?.[1] ?? line.match(/^\s*-\s*([^:]+):/)?.[1])?.replace(/:$/, '').trim();
      if (!label || NOT_COLOR_LABELS.has(label.toLowerCase())) continue;
      const key = slug(label);
      if (!(key in colors)) colors[key] = hex;
    }
    // semantic line: "success #22C55E, warning #F59E0B, ..."
    const semantic = color.match(/\*\*Semantic:\*\*\s*(.+)$/m)?.[1];
    if (semantic) for (const m of semantic.matchAll(/([a-z]+)\s+(#[0-9a-fA-F]{3,8})/g)) if (!(m[1] in colors)) colors[m[1]] = m[2];
  }
  if (Object.keys(colors).length) fm.colors = colors;

  // Spacing scale "2xs(2px) xs(4px) ..."
  const spacingBody = sectionBody(doc, 'Spacing');
  const spacing: Record<string, string> = {};
  if (spacingBody) {
    const scale = spacingBody.match(/\*\*Scale:\*\*\s*(.+)$/m)?.[1];
    if (scale) for (const m of scale.matchAll(/([0-9a-z]+)\(([^)]+)\)/g)) spacing[m[1]] = /px|rem|em$/.test(m[2]) ? m[2] : `${m[2]}px`;
  }
  if (Object.keys(spacing).length) fm.spacing = spacing;

  // Border radius "sm:4px, md:8px, lg:12px, full:9999px"
  const layoutBody = sectionBody(doc, 'Layout');
  const rounded: Record<string, string> = {};
  if (layoutBody) {
    const radius = layoutBody.match(/\*\*Border radius:\*\*\s*(.+)$/m)?.[1];
    if (radius) for (const m of radius.matchAll(/([a-z0-9]+):\s*([0-9.]+(?:px|rem|em))/g)) rounded[m[1]] = m[2];
  }
  if (Object.keys(rounded).length) fm.rounded = rounded;

  const consumed = new Set([...LEGACY_IDENTITY_HEADINGS.map(h => h.toLowerCase()), 'typography', 'color', 'colors', 'spacing', 'layout']);
  const sections: Section[] = [];
  sections.push({ heading: 'Overview', canonical: 'Overview', body: overview.join('\n\n') || '(no product context recorded)' });
  if (color) sections.push({ heading: 'Colors', canonical: 'Colors', body: color.trim() });
  if (typo) sections.push({ heading: 'Typography', canonical: 'Typography', body: typo.trim() });
  const layoutParts = [layoutBody?.trim(), spacingBody ? `### Spacing\n${spacingBody.trim()}` : undefined].filter(Boolean) as string[];
  if (layoutParts.length) sections.push({ heading: 'Layout', canonical: 'Layout', body: layoutParts.join('\n\n') });
  for (const s of doc.sections) {
    if (consumed.has(s.heading.trim().toLowerCase())) continue;
    sections.push(s.canonical ? { ...s } : { heading: s.heading, body: s.body });
  }
  return {
    frontmatterText: emitYamlBlock(fm) + '\n',
    frontmatter: fm,
    marker: 'spec',
    preamble: doc.preamble, // the title line and any intro prose under it survive verbatim
    sections,
  };
}

/** A minimal spec-format document (used when a tool must create DESIGN.md from scratch). */
export function specSkeleton(name: string, frontmatter: Record<string, unknown>, sections: Array<{ heading: string; body: string }>): DesignMdDoc {
  const fm = { name, ...frontmatter };
  const doc: DesignMdDoc = { frontmatterText: emitYamlBlock(fm) + '\n', frontmatter: fm, marker: 'spec', preamble: `# ${name}`, sections: [] };
  return sections.reduce((d, s) => upsertSection(d, s.heading, s.body), doc);
}
