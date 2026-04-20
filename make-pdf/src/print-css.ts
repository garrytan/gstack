/**
 * Print stylesheet generator.
 *
 * Source of truth: .context/designs/make-pdf-print-reference.html and siblings.
 * Mirror those CSS rules here. The HTML references were approved via
 * /plan-design-review with explicit design decisions locked in the plan:
 *
 *   - Helvetica only (system font, no bundled webfonts — dodges the
 *     per-glyph Tj bug that breaks copy-paste extraction).
 *   - All paragraphs flush-left. No first-line indent, no justify, no
 *     p+p indent. text-align: left everywhere. 12pt margin-bottom.
 *   - Cover page has the same 1in margins as every other page. No flexbox
 *     center, no inset padding, no vertical centering. Distinction comes
 *     from eyebrow + larger title + hairline rule, not from centering.
 *   - `@page :first` suppresses running header/footer but does NOT override
 *     the 1in margin.
 *   - No <link>, no external CSS/fonts — everything inlined.
 *   - CJK fallback: Helvetica, Arial, Hiragino Kaku Gothic ProN, Noto Sans
 *     CJK JP, Microsoft YaHei, sans-serif.
 */

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

  return [
    `@page {`,
    `  size: ${size};`,
    `  margin: ${margin};`,
    runningHeader
      ? `  @top-center { content: "${runningHeader}"; font-family: Helvetica, Arial, sans-serif; font-size: 9pt; color: #666; }`
      : ``,
    `  @bottom-center { content: counter(page) " of " counter(pages); font-family: Helvetica, Arial, sans-serif; font-size: 9pt; color: #666; }`,
    showConfidential
      ? `  @bottom-right { content: "CONFIDENTIAL"; font-family: Helvetica, Arial, sans-serif; font-size: 8pt; color: #aaa; letter-spacing: 0.05em; }`
      : ``,
    `}`,
    ``,
    // Cover page: suppress running header/footer but keep margins.
    `@page :first {`,
    `  @top-center { content: none; }`,
    `  @bottom-center { content: none; }`,
    `  @bottom-right { content: none; }`,
    `}`,
  ].filter(line => line !== "").join("\n");
}

function rootTypography(): string {
  return [
    `html { lang: en; }`,
    `body {`,
    `  font-family: Helvetica, Arial, "Hiragino Kaku Gothic ProN", "Noto Sans CJK JP", "Microsoft YaHei", sans-serif;`,
    `  font-size: 11pt;`,
    `  line-height: 1.5;`,
    `  color: #111;`,
    `  background: white;`,
    `  hyphens: auto;`,
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
    `.cover {`,
    `  page: first;`,
    `  page-break-after: always;`,
    `  break-after: page;`,
    `  text-align: left;`,
    `}`,
    `.cover .eyebrow {`,
    `  font-size: 9pt;`,
    `  letter-spacing: 0.2em;`,
    `  text-transform: uppercase;`,
    `  color: #666;`,
    `  margin: 0 0 36pt;`,
    `}`,
    `.cover h1.cover-title {`,
    `  font-size: 32pt;`,
    `  line-height: 1.15;`,
    `  font-weight: 700;`,
    `  letter-spacing: -0.01em;`,
    `  margin: 0 0 18pt;`,
    `  max-width: 5.5in;`,
    `  text-align: left;`,
    `}`,
    `.cover .cover-subtitle {`,
    `  font-size: 14pt;`,
    `  line-height: 1.4;`,
    `  font-weight: 400;`,
    `  color: #333;`,
    `  margin: 0 0 36pt;`,
    `  max-width: 5in;`,
    `  text-align: left;`,
    `}`,
    `.cover hr.rule {`,
    `  width: 2.5in;`,
    `  height: 0;`,
    `  border: 0;`,
    `  border-top: 1px solid #111;`,
    `  margin: 0 0 18pt 0;`,
    `}`,
    `.cover .cover-meta { font-size: 10pt; line-height: 1.6; color: #333; text-align: left; }`,
    `.cover .cover-meta strong { font-weight: 700; }`,
  ].join("\n");
}

function tocRules(enabled: boolean): string {
  if (!enabled) return "";
  return [
    `.toc { page-break-after: always; break-after: page; }`,
    `.toc h2 {`,
    `  font-size: 13pt;`,
    `  text-transform: uppercase;`,
    `  letter-spacing: 0.15em;`,
    `  color: #666;`,
    `  font-weight: 600;`,
    `  margin: 0 0 0.5in;`,
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
    `  font-size: 11pt;`,
    `  line-height: 2;`,
    `  padding: 4pt 0;`,
    `}`,
    `.toc li .toc-title { flex: 0 0 auto; }`,
    `.toc li .toc-dots { flex: 1 1 auto; border-bottom: 1px dotted #aaa; margin: 0 6pt; transform: translateY(-4pt); }`,
    `.toc li .toc-page { flex: 0 0 auto; color: #666; font-variant-numeric: tabular-nums; }`,
    `.toc li.level-2 { padding-left: 0.35in; font-size: 10pt; }`,
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
    `  font-size: 22pt;`,
    `  line-height: 1.2;`,
    `  font-weight: 700;`,
    `  letter-spacing: -0.01em;`,
    `  margin: 0 0 0.25in;`,
    `  break-after: avoid;`,
    `  page-break-after: avoid;`,
    `}`,
    `h2 { font-size: 15pt; line-height: 1.3; font-weight: 700; margin: 24pt 0 6pt; break-after: avoid; page-break-after: avoid; }`,
    `h3 { font-size: 12pt; line-height: 1.4; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #333; margin: 18pt 0 4pt; break-after: avoid; page-break-after: avoid; }`,
    `h4 { font-size: 11pt; font-weight: 700; margin: 12pt 0 4pt; break-after: avoid; page-break-after: avoid; }`,
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
    `p.lead { font-size: 13pt; line-height: 1.45; color: #222; margin: 0 0 18pt; }`,
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
    `  font-size: 9.5pt;`,
    `  background: #f4f4f4;`,
    `  padding: 1pt 3pt;`,
    `  border-radius: 2pt;`,
    `  border: 0.5pt solid #e4e4e4;`,
    `}`,
    `pre {`,
    `  font-family: "SF Mono", Menlo, Consolas, monospace;`,
    `  font-size: 9pt;`,
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
    `  font-size: 11pt;`,
    `  line-height: 1.5;`,
    `}`,
    `blockquote p { margin-bottom: 6pt; text-align: left; }`,
    `blockquote cite { display: block; margin-top: 6pt; font-style: normal; font-size: 9.5pt; color: #666; letter-spacing: 0.02em; }`,
    `blockquote cite::before { content: "— "; }`,
  ].join("\n");
}

function figureRules(): string {
  return [
    `figure { margin: 12pt 0; }`,
    `figure img { display: block; max-width: 100%; height: auto; }`,
    `figcaption { font-size: 9pt; color: #666; margin-top: 6pt; font-style: italic; }`,
  ].join("\n");
}

function tableRules(): string {
  return [
    `table { width: 100%; border-collapse: collapse; margin: 12pt 0; font-size: 10pt; }`,
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
    `.footnotes { margin-top: 24pt; padding-top: 12pt; border-top: 0.5pt solid #ccc; font-size: 9.5pt; line-height: 1.4; }`,
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
