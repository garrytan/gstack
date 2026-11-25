/**
 * The "swiss" print style: make-pdf's default look since GSTA-849.
 *
 * A Swiss-poster layout in the Müller-Brockmann tradition, picked by the
 * owner in blind A/B pairs over today's plain look ("plain" lives in
 * print-css.ts and is untouched by this file). The page is split into two
 * fields: a narrow left field that holds small red sub-headings, and a text
 * column to its right. Section headings run the full width as white type on a
 * black bar whose text starts at the column edge, so every heading, paragraph
 * and list shares one left edge. Tables, code, figures and images use the full
 * width. Readable line length comes from the field, never from wide margins.
 *
 * These rules are appended after the plain rules, so every structural rule
 * (page boxes, chapter breaks, TOC leaders, footnotes, watermark, break-avoid)
 * keeps a single source in print-css.ts.
 */

export type Style = "swiss" | "plain";

export const DEFAULT_STYLE: Style = "swiss";

export const STYLES: readonly Style[] = ["swiss", "plain"];

/** Width of the left field. The text column starts this far into the type area. */
export const SWISS_FIELD_IN = 1.9;

/** Widest text column, so long lines stay readable on legal and tabloid paper. */
const SWISS_COLUMN_MAX_IN = 5.1;

export const SWISS_MARGINS = { top: "0.7in", right: "0.75in", bottom: "0.85in", left: "0.75in" } as const;

export const SWISS_MARGIN_SHORTHAND = `${SWISS_MARGINS.top} ${SWISS_MARGINS.right} ${SWISS_MARGINS.bottom} ${SWISS_MARGINS.left}`;

const RED = "#e30613";
const INK = "#111";
const EXACT = "-webkit-print-color-adjust: exact; print-color-adjust: exact;";

export function swissRules(opts: { cover?: boolean; toc?: boolean } = {}): string {
  return [
    `:root { --swiss-field: ${SWISS_FIELD_IN}in; }`,
    `body { font-size: 11pt; line-height: 15pt; }`,
    `.chapter { display: flow-root; }`,
    `.chapter > * { margin-left: var(--swiss-field); max-width: ${SWISS_COLUMN_MAX_IN}in; }`,
    `.chapter > h1, .chapter > h2, .chapter > table, .chapter > pre, .chapter > figure, .chapter > .page-wide, .chapter > p:has(> img:only-child) { margin-left: 0; max-width: none; clear: left; }`,
    // An h3 with text after it sits absolutely at the top of a wrapper that holds
    // that text, so it always starts on the page where the text starts; the
    // wrapper's min-height (set by render.ts from the heading's length) keeps a
    // long sub-heading clear of the next block.
    `.chapter > .swiss-keep { position: relative; clear: left; margin-left: 0; max-width: none; }`,
    `.chapter > .swiss-keep > h3 { position: absolute; top: 0; left: 0; }`,
    `.chapter > .swiss-keep > :not(h3) { margin-left: var(--swiss-field); max-width: ${SWISS_COLUMN_MAX_IN}in; }`,
    `.chapter > hr { clear: left; height: 0; border: 0; border-top: 0.5pt solid ${INK}; margin: 12pt 0 12pt var(--swiss-field); }`,
    `.chapter > h1 { font-size: 46pt; line-height: 46pt; letter-spacing: -0.035em; font-weight: 700; margin: 0 0 20pt; color: ${RED}; overflow-wrap: anywhere; }`,
    `.chapter > h1 + p { font-size: 15pt; line-height: 20pt; margin-bottom: 18pt; }`,
    `.chapter > h2 { ${EXACT} background: ${INK}; color: #fff; font-size: 17pt; line-height: 20pt; font-weight: 700; letter-spacing: -0.01em; margin: 24pt 0 12pt; padding: 7pt 10pt 8pt var(--swiss-field); overflow-wrap: anywhere; }`,
    // A bar never ends a page: the block after it brings at least three of its lines along.
    `.chapter > h2 + p, .chapter > h2 + blockquote, .chapter > h2 + ul > li:first-child, .chapter > h2 + ol > li:first-child { orphans: 3; }`,
    `.chapter > h3, .chapter > .swiss-keep > h3 { float: left; clear: left; width: calc(var(--swiss-field) - 0.2in); margin: 1pt 0 0 0; break-inside: avoid; font-size: 10pt; line-height: 13pt; font-weight: 700; color: ${RED}; text-transform: none; letter-spacing: 0; overflow-wrap: anywhere; }`,
    // Above a block that cannot split (code, a table, a figure, an image) the
    // sub-heading stays in normal flow, so break-after: avoid still keeps it
    // with that block instead of stranding it at a page foot.
    `.chapter > h3:has(+ pre), .chapter > h3:has(+ table), .chapter > h3:has(+ figure), .chapter > h3:has(+ p > img:only-child) { float: none; margin: 6pt 0 4pt 0; }`,
    // Above a block promoted to a landscape page, the sub-heading takes the same
    // named page, so it prints on that page instead of alone before it.
    `.chapter > h3:has(+ .page-wide) { float: none; margin: 6pt 0 4pt 0; page: wide; }`,
    `.chapter > .swiss-keep > h3 { float: none; }`,
    `p { margin: 0 0 7.5pt; }`,
    `ul, ol { padding-left: 14pt; margin: 0 0 7.5pt; }`,
    `li { margin: 0; line-height: 15pt; }`,
    `table { font-size: 9.5pt; line-height: 13pt; border-top: 2pt solid ${INK}; border-bottom: 2pt solid ${INK}; margin: 6pt 0 15pt; }`,
    `th, td { padding: 4pt 10pt 4pt 0; border-bottom: 0.5pt solid #bbb; }`,
    `th { color: ${RED}; border-bottom: 1pt solid ${INK}; }`,
    `pre { background: none; border: 0; border-left: 3pt solid ${RED}; border-radius: 0; padding: 2pt 0 2pt 10pt; font-size: 9pt; line-height: 12pt; }`,
    `blockquote { border-left: 3pt solid ${RED}; }`,
    `figure.diagram, figure.diagram .diagram-caption { text-align: left; }`,
    `figcaption, .diagram-caption { font-style: normal; font-weight: 700; color: ${RED}; font-size: 9pt; }`,
    opts.cover ? coverRules() : "",
    opts.toc ? `.toc h2 { ${EXACT} background: ${INK}; color: #fff; font-size: 17pt; line-height: 20pt; letter-spacing: -0.01em; text-transform: none; margin: 0 0 18pt; padding: 7pt 10pt 8pt var(--swiss-field); }` : "",
  ].filter(Boolean).join("\n");
}

function coverRules(): string {
  return [
    `.cover { ${EXACT} padding-top: 0; }`,
    `.cover h1.cover-title { ${EXACT} background: ${INK}; color: #fff; font-size: 96pt; line-height: 0.92; letter-spacing: -0.045em; max-width: none; margin: 0 0 18pt; padding: 3.2in 18pt 22pt 18pt; overflow-wrap: anywhere; }`,
    `.cover .cover-subtitle, .cover .cover-meta { margin-left: var(--swiss-field); }`,
    `.cover hr.rule { ${EXACT} width: calc(var(--swiss-field) - 0.2in); border-top: 10pt solid ${RED}; margin: 0 0 14pt var(--swiss-field); }`,
    `.cover .cover-meta { font-size: 13pt; line-height: 18pt; color: ${INK}; }`,
  ].join("\n");
}

/** Screen layer for `--to html`: room for the field on wide screens, one column on phones. */
export function swissScreenCss(): string {
  return [
    `@media screen {`,
    `  body { max-width: 7.5in; }`,
    `}`,
    `@media screen and (max-width: 48em) {`,
    `  .chapter > *, .chapter > hr, .cover .cover-subtitle, .cover .cover-meta, .cover hr.rule { margin-left: 0; max-width: none; }`,
    `  .chapter > h3, .chapter > .swiss-keep > h3 { float: none; position: static; width: auto; margin: 14pt 0 4pt; }`,
    `  .chapter > .swiss-keep { min-height: 0 !important; }`,
    `  .chapter > .swiss-keep > :not(h3) { margin-left: 0; max-width: none; }`,
    `  .chapter > h2, .toc h2 { padding-left: 10pt; }`,
    `  .cover h1.cover-title { font-size: 44pt !important; padding-top: 1in !important; }`,
    `}`,
  ].join("\n");
}

/** Estimated lines an h3 takes in the left field (10pt bold, field width less 0.2in). */
export function swissFieldHeadingLines(text: string): number {
  const widthPt = (SWISS_FIELD_IN - 0.2) * 72;
  let lines = 1;
  let x = 0;
  for (const word of text.trim().split(/\s+/)) {
    const w = Array.from(word).reduce((s, g) => s + glyphEm(g) * 1.06, 0) * 10;
    const space = glyphEm(" ") * 10;
    if (x > 0 && x + w > widthPt) { lines++; x = 0; }
    if (w > widthPt) {
      lines += Math.ceil(w / widthPt) - 1;
      x = w % widthPt;
    } else {
      x += w;
    }
    x += space;
  }
  return lines;
}

const WIDE_CHAR = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]|[\u{1F000}-\u{1FAFF}]/u;
const COVER_SIZES_PT = [96, 84, 72, 60, 48];
const COVER_BLOCK_IN = 5.97;
const COVER_BELOW_BLOCK_IN = 3.48;
const COVER_BLOCK_MIN_IN = 1.5;
const SWISS_LETTER_BOX = { contentWIn: 7, contentHIn: 9.45 };

/** Estimated width of one glyph in ems of bold Helvetica with the cover's tight tracking. */
function glyphEm(ch: string): number {
  if (WIDE_CHAR.test(ch)) return 1;
  if (ch === " ") return 0.28;
  if (/[A-Z0-9]/.test(ch)) return 0.66;
  if (/[iljtf.,:;'!|]/.test(ch)) return 0.3;
  if (/[mwMW]/.test(ch)) return 0.85;
  return 0.55;
}

/** Lines a title takes at a size, or Infinity when one unbreakable word is wider than the block. */
function coverLines(title: string, sizePt: number, widthPt: number): number {
  let lines = 1;
  let x = 0;
  for (const word of title.trim().split(/\s+/)) {
    const glyphs = Array.from(word);
    const wide = glyphs.some((g) => WIDE_CHAR.test(g));
    if (wide) {
      for (const g of glyphs) {
        const w = glyphEm(g) * sizePt;
        if (x + w > widthPt) { lines++; x = 0; }
        x += w;
      }
      x += glyphEm(" ") * sizePt;
      continue;
    }
    const w = glyphs.reduce((s, g) => s + glyphEm(g), 0) * sizePt;
    if (w > widthPt) return Infinity;
    if (x > 0 && x + w > widthPt) { lines++; x = 0; }
    x += w + glyphEm(" ") * sizePt;
  }
  return lines;
}

/**
 * Size the swiss cover title so the black block, the red bar and the meta
 * always fit on page 1 of the actual page box (paper size less margins): the
 * largest size whose estimated lines fit the block, and a top padding that
 * shrinks as the title grows. The 48pt floor still wraps anything longer
 * (overflow-wrap: anywhere), it never clips. The default box is swiss Letter.
 */
export function swissCoverTitle(
  title: string,
  box: { contentWIn: number; contentHIn: number } = SWISS_LETTER_BOX,
): { fontPt: number; padTopIn: number } {
  const widthPt = box.contentWIn * 72 - 58;
  const blockIn = Math.max(COVER_BLOCK_MIN_IN, Math.min(COVER_BLOCK_IN, box.contentHIn - COVER_BELOW_BLOCK_IN));
  const maxTextPt = blockIn * 72 - 56;
  const fontPt = COVER_SIZES_PT.find((s) => coverLines(title, s, widthPt) * s * 0.92 <= maxTextPt)
    ?? COVER_SIZES_PT[COVER_SIZES_PT.length - 1];
  const lines = Math.min(coverLines(title, fontPt, widthPt), Math.max(1, Math.floor(maxTextPt / (fontPt * 0.92))));
  const textIn = (lines * fontPt * 0.92) / 72;
  const padTopIn = Math.round(Math.min(3.2, Math.max(0.4, blockIn - textIn - 0.31)) * 100) / 100;
  return { fontPt, padTopIn };
}
