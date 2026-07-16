/**
 * Print stylesheet generator.
 *
 * Source of truth: .context/designs/make-pdf-print-reference.html and siblings.
 * Mirror those CSS rules here. The HTML references were approved via
 * /plan-design-review with explicit design decisions locked in the plan:
 *
 *   - Helvetica first, with Liberation Sans as a metric-compatible Linux
 *     fallback (Helvetica and Arial aren't installed on most Linux distros;
 *     Liberation Sans ships via the fonts-liberation package and Playwright's
 *     install-deps). No bundled webfonts — dodges the per-glyph Tj bug that
 *     breaks copy-paste extraction.
 *   - All paragraphs flush-left. No first-line indent, no justify, no
 *     p+p indent. text-align: left everywhere. 12pt margin-bottom.
 *   - Cover page (v1.58.0.0 poster revision, user-directed): 56pt title,
 *     13pt meta, padding-top 1.4in for poster placement. Still no flexbox
 *     and no vertical centering; the inset is a deliberate top-third drop.
 *     (Supersedes the original "no inset padding" lock from the first
 *     /plan-design-review — the 32pt cover read as too small in print.)
 *   - `@page :first` suppresses running header/footer but does NOT override
 *     the 1in margin.
 *   - No <link>, no external CSS/fonts — everything inlined.
 *   - CJK fallback: Helvetica, Liberation Sans, Arial, Hiragino Kaku Gothic
 *     ProN, Noto Sans CJK JP, Microsoft YaHei, sans-serif.
 *   - Emoji fallback: the body and @top-center running-header stacks end in an
 *     emoji family group ("Apple Color Emoji", "Segoe UI Emoji", "Noto Color
 *     Emoji"), placed BEFORE the generic `sans-serif` so Chromium has a glyph
 *     source for emoji code points instead of emitting .notdef tofu (▯). The
 *     @bottom-* margin boxes hold only counters / a fixed "CONFIDENTIAL"
 *     string, so they get no emoji families. On Linux this requires an
 *     installed color-emoji font — `setup` installs fonts-noto-color-emoji.
 *
 * Font stacks are composed from the constants below so each family list has a
 * single source of truth (DRY) and every stack stays in sync.
 */

// Metric-compatible sans stack: Helvetica (macOS), Liberation Sans (Linux,
// ships via fonts-liberation), Arial (Windows). Shared by every text surface.
const SANS_STACK = `Helvetica, "Liberation Sans", Arial`;
// CJK fallback families, appended to the body stack only.
const CJK_STACK = `"Hiragino Kaku Gothic ProN", "Noto Sans CJK JP", "Microsoft YaHei"`;
// Color-emoji families: Apple (macOS), Segoe (Windows), Noto (Linux).
const EMOJI_FAMILIES = `"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"`;

export interface PrintCssOptions {
  // Document structure
  cover?: boolean;
  toc?: boolean;
  noChapterBreaks?: boolean;

  // Branding
  watermark?: string;
  confidential?: boolean;

  // Header (running title, top of page)
  runningHeader?: string;

  // Page size (in CSS `@page size:` terms)
  pageSize?: "letter" | "a4" | "legal" | "tabloid";

  // Margins (default 1in)
  margins?: string;

  // Whether to render "N of M" page numbers in the @page @bottom-center rule.
  // Default true. Set false to suppress CSS numbering (used when the caller
  // supplies a custom Chromium footerTemplate, or when --no-page-numbers).
  pageNumbers?: boolean;
}

/**
 * Produce a CSS block (no <style> wrapper) for inline injection.
 */
export function printCss(opts: PrintCssOptions = {}): string {
  const size = opts.pageSize ?? "letter";
  const margin = opts.margins ?? "1in";
  const hasWatermark = typeof opts.watermark === "string" && opts.watermark.length > 0;

  return [
    pageRules(size, margin, opts),
    rootTypography(),
    coverRules(opts.cover === true),
    tocRules(opts.toc === true),
    chapterRules(opts.noChapterBreaks === true),
    blockRules(),
    inlineRules(),
    codeRules(),
    quoteRules(),
    figureRules(),
    tableRules(),
    listRules(),
    footnoteRules(),
    hasWatermark ? watermarkRules() : "",
    breakAvoidRules(),
  ].filter(Boolean).join("\n\n");
}

function pageRules(size: string, margin: string, opts: PrintCssOptions): string {
  const runningHeader = escapeCssString(opts.runningHeader ?? "");
  const showConfidential = opts.confidential !== false;
  const showPageNumbers = opts.pageNumbers !== false;

  return [
    `@page {`,
    `  size: ${size};`,
    `  margin: ${margin};`,
    runningHeader
      ? `  @top-center { content: "${runningHeader}"; font-family: ${SANS_STACK}, ${EMOJI_FAMILIES}, sans-serif; font-size: 9pt; color: #666; }`
      : ``,
    showPageNumbers
      ? `  @bottom-center { content: counter(page) " of " counter(pages); font-family: ${SANS_STACK}, sans-serif; font-size: 9pt; color: #666; }`
      : ``,
    showConfidential
      ? `  @bottom-right { content: "CONFIDENTIAL"; font-family: ${SANS_STACK}, sans-serif; font-size: 8pt; color: #aaa; letter-spacing: 0.05em; }`
      : ``,
    `}`,
    ``,
    // Cover page: suppress running header/footer but keep margins.
    `@page :first {`,
    `  @top-center { content: none; }`,
    `  @bottom-center { content: none; }`,
    `  @bottom-right { content: none; }`,
    `}`,
    ``,
    // Landscape named page for promoted wide diagrams/images (image-policy).
    // Chromium-only — exactly the engine this pipeline always prints with.
    // Honored only when the print call passes preferCSSPageSize (orchestrator
    // sets it when a promotion exists). Vertical centering is NOT done here —
    // image-policy emits a computed inline margin-top instead (see the
    // .page-wide comment below for why).
    `@page wide {`,
    `  size: ${size} landscape;`,
    `  margin: ${margin};`,
    `}`,
    // No explicit break-before/after (the page-name CHANGE already forces a
    // break on both sides) and NO height/flex centering: a flex .page-wide
    // with min-height fragments into a phantom empty landscape page in
    // Chromium (landscape-gate counted 5 pages for 3 promotions; bisected to
    // min-height at any value). Vertical centering is done by image-policy
    // instead — it knows each promoted block's aspect ratio and emits an
    // inline margin-top, which fragmentation handles fine.
    `.page-wide {`,
    `  page: wide;`,
    `  text-align: center;`,
    `}`,
    // width: 100% stretch is intentional for promoted content: auto-promoted
    // rasters are >=~1600px (≈190dpi at the 9in landscape box — prints fine),
    // and a directive-forced small image is the user's explicit call.
    `.page-wide img, .page-wide svg { width: 100%; height: auto; max-width: none; }`,
    `.page-wide figure.diagram > svg { max-width: none; }`,
  ].filter(line => line !== "").join("\n");
}

/**
 * Screen layer appended for `--to html` exports. The print CSS stays the
 * source of truth; this only makes the same document readable in a browser
 * (centered measure, padding, no print-only chapter breaks forcing scroll
 * gaps). Print output is unaffected — media-scoped.
 */
export function screenCss(): string {
  return [
    `@media screen {`,
    // ~42em at 12pt ≈ 70-75 characters per line — the readable ceiling.
    `  body { max-width: 42em; margin: 0 auto; padding: 2.5em 1.5em; }`,
    `  .chapter { break-before: auto; }`,
    `  .watermark { display: none; }`,
    `  figure.diagram { overflow-x: auto; }`,
    // Page numbers only exist in print; hide the empty spans + dot leaders.
    `  .toc li .toc-page, .toc li .toc-dots { display: none; }`,
    `}`,
  ].join("\n");
}

function rootTypography(): string {
  return [
    `html { lang: en; }`,
    // Zero image truncation, ever: every image caps at the content box,
    // whatever element it lives in. Markdown images render as <p><img> (no
    // figure), so a figure-scoped cap alone lets a 1900px screenshot run off
    // the page edge. .page-wide deliberately overrides to fill its landscape
    // box — still bounded, never clipped.
    `img { max-width: 100%; height: auto; }`,
    `body {`,
    `  font-family: ${SANS_STACK}, ${CJK_STACK}, ${EMOJI_FAMILIES}, sans-serif;`,
    `  font-size: 12pt;`,
    `  line-height: 1.5;`,
    `  color: #111;`,
    `  background: white;`,
    // No auto-hyphenation: it puts real "dif-\nferent" breaks into the PDF
    // text layer, and clean copy-paste is the product contract (the
    // combined-gate caught this the moment 12pt body made lines wrap).
    // Left-aligned rag doesn't need hyphenation.
    `  hyphens: manual;`,
    `  font-variant-ligatures: common-ligatures;`,
    `  font-kerning: normal;`,
    `  text-rendering: geometricPrecision;`,
    `  margin: 0;`,
    `  padding: 0;`,
    `}`,
  ].join("\n");
}

function coverRules(enabled: boolean): string {
  if (!enabled) return "";
  return [
    // Poster scale: the cover is the one page where type should feel huge.
    `.cover {`,
    `  page: first;`,
    `  page-break-after: always;`,
    `  break-after: page;`,
    `  text-align: left;`,
    `  padding-top: 1.4in;`,
    `}`,
    `.cover .eyebrow {`,
    `  font-size: 11pt;`,
    `  letter-spacing: 0.2em;`,
    `  text-transform: uppercase;`,
    `  color: #666;`,
    `  margin: 0 0 36pt;`,
    `}`,
    `.cover h1.cover-title {`,
    `  font-size: 56pt;`,
    `  line-height: 1.08;`,
    `  font-weight: 700;`,
    `  letter-spacing: -0.02em;`,
    `  margin: 0 0 24pt;`,
    `  max-width: 6in;`,
    `  text-align: left;`,
    `}`,
    `.cover .cover-subtitle {`,
    `  font-size: 18pt;`,
    `  line-height: 1.35;`,
    `  font-weight: 400;`,
    `  color: #333;`,
    `  margin: 0 0 36pt;`,
    `  max-width: 5.5in;`,
    `  text-align: left;`,
    `}`,
    `.cover hr.rule {`,
    `  width: 2.5in;`,
    `  height: 0;`,
    `  border: 0;`,
    `  border-top: 1.5px solid #111;`,
    `  margin: 0 0 24pt 0;`,
    `}`,
    `.cover .cover-meta { font-size: 13pt; line-height: 1.6; color: #333; text-align: left; }`,
    `.cover .cover-meta strong { font-weight: 700; }`,
  ].join("\n");
}

function tocRules(enabled: boolean): string {
  if (!enabled) return "";
  return [
    `.toc { page-break-after: always; break-after: page; }`,
    `.toc h2 {`,
    `  font-size: 16pt;`,
    `  text-transform: uppercase;`,
    `  letter-spacing: 0.15em;`,
    `  color: #444;`,
    `  font-weight: 700;`,
    `  margin: 0 0 0.4in;`,
    `}`,
    `.toc ol {`,
    `  list-style: none;`,
    `  padding: 0;`,
    `  margin: 0;`,
    `}`,
    `.toc li {`,
    `  display: flex;`,
    `  align-items: baseline;`,
    `  gap: 0.25in;`,
    `  font-size: 12pt;`,
    `  line-height: 1.7;`,
    `  padding: 3pt 0;`,
    `}`,
    `.toc li .toc-title { flex: 0 0 auto; }`,
    `.toc li .toc-dots { flex: 1 1 auto; border-bottom: 1px dotted #aaa; margin: 0 6pt; transform: translateY(-4pt); }`,
    `.toc li .toc-page { flex: 0 0 auto; color: #666; font-variant-numeric: tabular-nums; }`,
    `.toc li.level-2 { padding-left: 0.35in; font-size: 11pt; }`,
    `.toc li a { color: inherit; text-decoration: none; }`,
  ].join("\n");
}

function chapterRules(noChapterBreaks: boolean): string {
  const breakRule = noChapterBreaks
    ? `/* chapter breaks disabled */`
    : [
        `.chapter { break-before: page; page-break-before: always; }`,
        `.chapter:first-of-type { break-before: auto; page-break-before: auto; }`,
      ].join("\n");
  return [
    breakRule,
    `h1 {`,
    `  font-size: 26pt;`,
    `  line-height: 1.2;`,
    `  font-weight: 700;`,
    `  letter-spacing: -0.01em;`,
    `  margin: 0 0 0.25in;`,
    `  break-after: avoid;`,
    `  page-break-after: avoid;`,
    `}`,
    `h2 { font-size: 18pt; line-height: 1.3; font-weight: 700; margin: 26pt 0 8pt; break-after: avoid; page-break-after: avoid; }`,
    `h3 { font-size: 13.5pt; line-height: 1.4; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #333; margin: 20pt 0 5pt; break-after: avoid; page-break-after: avoid; }`,
    `h4 { font-size: 12pt; font-weight: 700; margin: 14pt 0 5pt; break-after: avoid; page-break-after: avoid; }`,
  ].join("\n");
}

function blockRules(): string {
  // Flush-left paragraphs, no indent, 12pt gap. No justify.
  // Rule from the plan's "Body paragraph rule (post-review fix)".
  return [
    `p {`,
    `  margin: 0 0 12pt;`,
    `  text-align: left;`,
    `  widows: 3;`,
    `  orphans: 3;`,
    `}`,
    `p:first-child { margin-top: 0; }`,
    `p.lead { font-size: 14pt; line-height: 1.45; color: #222; margin: 0 0 18pt; }`,
  ].join("\n");
}

function inlineRules(): string {
  return [
    `a {`,
    `  color: #0055cc;`,
    `  text-decoration: underline;`,
    `  text-decoration-thickness: 0.5pt;`,
    `  text-underline-offset: 1.5pt;`,
    `}`,
    `strong { font-weight: 700; }`,
    `em { font-style: italic; }`,
  ].join("\n");
}

function codeRules(): string {
  return [
    `code {`,
    `  font-family: "SF Mono", Menlo, Consolas, monospace;`,
    `  font-size: 10.5pt;`,
    `  background: #f4f4f4;`,
    `  padding: 1pt 3pt;`,
    `  border-radius: 2pt;`,
    `  border: 0.5pt solid #e4e4e4;`,
    `}`,
    `pre {`,
    `  font-family: "SF Mono", Menlo, Consolas, monospace;`,
    `  font-size: 10pt;`,
    `  line-height: 1.4;`,
    `  background: #f7f7f5;`,
    `  padding: 10pt 12pt;`,
    `  border: 0.5pt solid #e0e0e0;`,
    `  border-radius: 3pt;`,
    `  margin: 12pt 0;`,
    `  overflow: hidden;`,
    `  white-space: pre-wrap;`,
    `}`,
    `pre code { background: none; border: 0; padding: 0; font-size: inherit; }`,
    // highlight.js minimal palette (kept neutral, prints well)
    `.hljs-keyword { color: #8b0000; font-weight: 500; }`,
    `.hljs-string { color: #0d6608; }`,
    `.hljs-comment { color: #888; font-style: italic; }`,
    `.hljs-function, .hljs-title { color: #0044aa; }`,
    `.hljs-number { color: #a64d00; }`,
  ].join("\n");
}

function quoteRules(): string {
  return [
    `blockquote {`,
    `  margin: 12pt 0;`,
    `  padding: 0 0 0 18pt;`,
    `  border-left: 2pt solid #111;`,
    `  color: #333;`,
    `  font-size: 12pt;`,
    `  line-height: 1.5;`,
    `}`,
    `blockquote p { margin-bottom: 6pt; text-align: left; }`,
    `blockquote cite { display: block; margin-top: 6pt; font-style: normal; font-size: 10pt; color: #666; letter-spacing: 0.02em; }`,
    `blockquote cite::before { content: "— "; }`,
  ].join("\n");
}

function figureRules(): string {
  return [
    `figure { margin: 12pt 0; }`,
    `figure img { display: block; max-width: 100%; height: auto; }`,
    `figcaption { font-size: 10pt; color: #666; margin-top: 6pt; font-style: italic; }`,
    // Diagram figures (diagram-prepass): rendered mermaid/excalidraw SVG.
    // SVGs scale to the content box and never split across pages.
    `figure.diagram { break-inside: avoid; text-align: center; }`,
    `figure.diagram > svg { max-width: 100%; height: auto; }`,
    `figure.diagram .diagram-caption { text-align: center; }`,
    // Diagnostic block for a fence that failed to render — loud, boxed,
    // unmistakably an error (never silent raw code).
    `figure.diagram-error { border: 1.5pt solid #b00020; padding: 8pt 10pt; text-align: left; }`,
    `figure.diagram-error .diagram-error-title { font-weight: 700; color: #b00020; font-style: normal; margin: 0 0 6pt; }`,
    `figure.diagram-error .diagram-error-detail { font-size: 8.5pt; white-space: pre-wrap; margin: 0; }`,
    // Missing local image placeholder (non-strict mode).
    `.image-missing { display: inline-block; border: 1pt dashed #b00020; color: #b00020; padding: 4pt 8pt; font-size: 9pt; }`,
  ].join("\n");
}

function tableRules(): string {
  return [
    `table { width: 100%; border-collapse: collapse; margin: 12pt 0; font-size: 11pt; }`,
    `th, td { border-bottom: 0.5pt solid #ccc; padding: 5pt 8pt; text-align: left; vertical-align: top; }`,
    `th { font-weight: 700; border-bottom: 1pt solid #111; background: transparent; }`,
  ].join("\n");
}

function listRules(): string {
  return [
    `ul, ol { margin: 0 0 12pt 0; padding-left: 20pt; }`,
    `li { margin-bottom: 3pt; line-height: 1.45; }`,
    `li > ul, li > ol { margin-top: 3pt; margin-bottom: 0; }`,
  ].join("\n");
}

function footnoteRules(): string {
  return [
    `.footnote-ref { font-size: 0.75em; vertical-align: super; line-height: 0; text-decoration: none; color: #0055cc; }`,
    `.footnotes { margin-top: 24pt; padding-top: 12pt; border-top: 0.5pt solid #ccc; font-size: 10pt; line-height: 1.4; }`,
    `.footnotes ol { padding-left: 18pt; }`,
  ].join("\n");
}

function watermarkRules(): string {
  return [
    `.watermark {`,
    `  position: fixed;`,
    `  top: 50%;`,
    `  left: 50%;`,
    `  transform: translate(-50%, -50%) rotate(-30deg);`,
    `  font-size: 140pt;`,
    `  font-weight: 700;`,
    `  color: rgba(200, 0, 0, 0.06);`,
    `  letter-spacing: 0.08em;`,
    `  pointer-events: none;`,
    `  z-index: 9999;`,
    `  user-select: none;`,
    `  white-space: nowrap;`,
    `}`,
  ].join("\n");
}

function breakAvoidRules(): string {
  return `blockquote, pre, code, table, figure, li, .keep-together { break-inside: avoid; page-break-inside: avoid; }`;
}

function escapeCssString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}
