/**
 * Markdown → HTML renderer. Pure function, no I/O, no Playwright.
 *
 * Pipeline:
 *   1. marked parses markdown → HTML
 *   2. Sanitize: strip <script>, <iframe>, <object>, <embed>, <link>,
 *      <meta>, <base>, <form>, and all on* event handlers + javascript:
 *      URLs. (Codex round 2 #9: untrusted markdown can embed raw HTML.)
 *   3. Smartypants transform (code/URL-safe).
 *   4. Assemble full HTML document with print CSS inlined and
 *      semantic structure (cover, TOC placeholder, body).
 */

import { marked } from "marked";
import { smartypants } from "./smartypants";
import { printCss, type PrintCssOptions } from "./print-css";

export interface RenderOptions {
  markdown: string;

  // Document-level metadata (used for cover, PDF metadata, running header).
  title?: string;
  author?: string;
  date?: string;                  // ISO or human string
  subtitle?: string;

  // Features
  cover?: boolean;
  toc?: boolean;
  watermark?: string;
  noChapterBreaks?: boolean;
  confidential?: boolean;         // default: true

  // Page layout
  pageSize?: "letter" | "a4" | "legal" | "tabloid";
  margins?: string;

  // Footer behavior. pageNumbers defaults to true. When footerTemplate is set,
  // CSS page numbers are suppressed so the custom Chromium footer wins cleanly.
  pageNumbers?: boolean;
  footerTemplate?: string;
}

export interface RenderResult {
  html: string;                   // full HTML document, ready for $B load-html
  printCss: string;               // for debugging / preview
  bodyHtml: string;               // just the rendered body (tests, snapshots)
  meta: {
    title: string;
    author: string;
    date: string;
    wordCount: number;
  };
}

/**
 * Pure renderer. No side effects.
 */
export function render(opts: RenderOptions): RenderResult {
  // 1. Markdown → HTML
  const rawHtml = marked.parse(opts.markdown, { async: false }) as string;

  // 2. Sanitize
  const cleanHtml = sanitizeUntrustedHtml(rawHtml);

  // 3. Decode common entities so smartypants can match raw " and '.
  //    marked HTML-encodes quotes in text ("hello" → &quot;hello&quot;);
  //    without decoding, smartypants' regex never fires. These get re-encoded
  //    implicitly by the browser's HTML parser downstream, and for the ones
  //    that should stay as curly-quote Unicode, that IS the final form.
  const decoded = decodeTypographicEntities(cleanHtml);

  // 4. Smartypants (code-safe)
  const typographicHtml = smartypants(decoded);

  // 4. Derive metadata (title from first H1 if not provided)
  const derivedTitle = opts.title ?? extractFirstHeading(typographicHtml) ?? "Document";
  const derivedAuthor = opts.author ?? "";
  const derivedDate = opts.date ?? formatToday();

  // 5. Build CSS
  // CSS is the single source of truth for page numbers (Chromium native
  // numbering is always off in orchestrator). If the caller supplied a custom
  // footerTemplate, suppress CSS page numbers too so their footer wins.
  const showPageNumbers = opts.pageNumbers !== false && !opts.footerTemplate;
  const cssOptions: PrintCssOptions = {
    cover: opts.cover,
    toc: opts.toc,
    noChapterBreaks: opts.noChapterBreaks,
    watermark: opts.watermark,
    confidential: opts.confidential !== false,
    runningHeader: derivedTitle,
    pageSize: opts.pageSize,
    margins: opts.margins,
    pageNumbers: showPageNumbers,
  };
  const css = printCss(cssOptions);

  // 6. Assemble document
  const coverBlock = opts.cover
    ? buildCoverBlock({
        title: derivedTitle,
        subtitle: opts.subtitle,
        author: derivedAuthor,
        date: derivedDate,
      })
    : "";

  // Assign stable ids to body headings so the TOC's `#toc-N` anchors and
  // `data-toc-target` spans resolve to a real element. Headings that already
  // declare an id keep it; the TOC points at whatever id the heading carries.
  // Only worth doing when a TOC is requested (the ids exist solely for it).
  const { html: bodyHtml, headings: tocHeadings } = opts.toc
    ? annotateHeadingIds(typographicHtml)
    : { html: typographicHtml, headings: [] };

  const tocBlock = opts.toc
    ? buildTocBlock(tocHeadings)
    : "";

  // Wrap body in .chapter sections at H1 boundaries if chapter breaks are on.
  const chapterHtml = opts.noChapterBreaks
    ? `<section class="chapter">${bodyHtml}</section>`
    : wrapChaptersByH1(bodyHtml);

  const watermarkBlock = opts.watermark
    ? `<div class="watermark">${escapeHtml(opts.watermark)}</div>`
    : "";

  const fullHtml = [
    `<!doctype html>`,
    `<html lang="en">`,
    `<head>`,
    `<meta charset="utf-8">`,
    `<title>${escapeHtml(derivedTitle)}</title>`,
    derivedAuthor ? `<meta name="author" content="${escapeHtml(derivedAuthor)}">` : ``,
    `<style>`,
    css,
    `</style>`,
    `</head>`,
    `<body>`,
    watermarkBlock,
    coverBlock,
    tocBlock,
    chapterHtml,
    `</body>`,
    `</html>`,
  ].filter(Boolean).join("\n");

  return {
    html: fullHtml,
    printCss: css,
    bodyHtml: typographicHtml,
    meta: {
      title: derivedTitle,
      author: derivedAuthor,
      date: derivedDate,
      wordCount: countWords(stripTags(typographicHtml)),
    },
  };
}

/**
 * Decode the HTML entities that marked emits for text-node quotes/apostrophes.
 * Only the four that matter for smartypants — leaves &amp; alone because it
 * can be legitimately doubled (&amp;amp;) and we don't want to double-decode.
 */
function decodeTypographicEntities(html: string): string {
  return html
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'");
}

// ─── Sanitizer ────────────────────────────────────────────────────────

/**
 * Strip dangerous HTML from markdown-produced output.
 *
 * We can't use DOMPurify (server-side; adds a jsdom dep). A conservative
 * regex sanitizer is fine for this use case because:
 *   1. marked produces structured HTML (never malformed)
 *   2. we only need to strip a fixed blacklist of elements + attrs
 *   3. the output goes through Chromium's parser again, which normalizes
 *
 * What's stripped:
 *   - <script>, <iframe>, <object>, <embed>, <link>, <meta>, <base>, <form>
 *     (and their content).
 *   - on* event handler attributes (onclick, ONCLICK, etc.).
 *   - href/src with javascript: scheme.
 *   - <svg> tags with <script> inside them.
 */
export function sanitizeUntrustedHtml(html: string): string {
  let s = html;

  // Elements to remove entirely (including content).
  const DANGER_TAGS = [
    "script", "iframe", "object", "embed", "link", "meta", "base", "form",
    "applet", "frame", "frameset",
  ];
  for (const tag of DANGER_TAGS) {
    const re = new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}>`, "gi");
    s = s.replace(re, "");
    // Self-closing / unclosed variants
    const selfRe = new RegExp(`<${tag}\\b[^>]*/?>`, "gi");
    s = s.replace(selfRe, "");
  }

  // SVG <script>
  s = s.replace(/<svg([^>]*)>([\s\S]*?)<\/svg>/gi, (_, attrs, body) => {
    return `<svg${attrs}>${body.replace(/<script\b[\s\S]*?<\/script>/gi, "")}</svg>`;
  });

  // Event handler attributes (on* in any case).
  s = s.replace(/\s+on[a-zA-Z]+\s*=\s*"[^"]*"/gi, "");
  s = s.replace(/\s+on[a-zA-Z]+\s*=\s*'[^']*'/gi, "");
  s = s.replace(/\s+on[a-zA-Z]+\s*=\s*[^\s>]+/gi, "");

  // javascript: URLs in href/src/action/formaction
  s = s.replace(
    /(\s(?:href|src|action|formaction|xlink:href)\s*=\s*)(?:"javascript:[^"]*"|'javascript:[^']*'|javascript:[^\s>]+)/gi,
    '$1"#"',
  );

  // srcdoc attribute (iframe escape hatch — already stripped via iframe above,
  // but defense-in-depth).
  s = s.replace(/\s+srcdoc\s*=\s*"[^"]*"/gi, "");
  s = s.replace(/\s+srcdoc\s*=\s*'[^']*'/gi, "");

  // style="url(javascript:..)" — strip javascript: inside style attrs.
  s = s.replace(/url\(\s*javascript:[^)]*\)/gi, "url(#)");

  return s;
}

// ─── Cover / TOC / Chapter helpers ────────────────────────────────────

function buildCoverBlock(opts: {
  title: string;
  subtitle?: string;
  author?: string;
  date: string;
}): string {
  const title = escapeHtml(opts.title);
  const subtitle = opts.subtitle ? escapeHtml(opts.subtitle) : "";
  const author = opts.author ? escapeHtml(opts.author) : "";
  const date = escapeHtml(opts.date);
  return [
    `<section class="cover">`,
    `  <h1 class="cover-title">${title}</h1>`,
    subtitle ? `  <p class="cover-subtitle">${subtitle}</p>` : ``,
    `  <hr class="rule">`,
    `  <div class="cover-meta">`,
    author ? `    <div><strong>${author}</strong></div>` : ``,
    `    <div>${date}</div>`,
    `  </div>`,
    `</section>`,
  ].filter(Boolean).join("\n");
}

interface TocHeading {
  level: number;
  text: string;
  id: string;
}

/**
 * Emit a TOC placeholder from headings that already carry ids (assigned by
 * annotateHeadingIds). Each entry's `#id` anchor and `data-toc-target` span
 * resolve to the matching body heading. Page numbers are filled in by Paged.js
 * (when --toc is passed and the Paged.js polyfill is injected), which needs the
 * target heading to exist with the referenced id before it can count pages.
 */
function buildTocBlock(headings: TocHeading[]): string {
  if (headings.length === 0) return "";

  const items = headings.map((h) => {
    const level = h.level >= 2 ? "level-2" : "level-1";
    return [
      `  <li class="${level}">`,
      `    <span class="toc-title"><a href="#${h.id}">${escapeHtml(h.text)}</a></span>`,
      `    <span class="toc-dots"></span>`,
      `    <span class="toc-page" data-toc-target="${h.id}"></span>`,
      `  </li>`,
    ].join("\n");
  }).join("\n");

  return [
    `<section class="toc">`,
    `  <h2>Contents</h2>`,
    `  <ol>`,
    items,
    `  </ol>`,
    `</section>`,
  ].join("\n");
}

/**
 * Walk H1-H3 headings in document order, assigning each a stable id the TOC can
 * link to. A heading that already declares an `id` keeps it (the TOC points at
 * the existing id); a heading with no id gets `id="toc-N"` injected, where N is
 * its document-order index. Returns the rewritten HTML plus the heading list
 * (level, decoded text, resolved id) for buildTocBlock to consume, so anchors
 * and targets are guaranteed to agree.
 */
function annotateHeadingIds(html: string): { html: string; headings: TocHeading[] } {
  const headings: TocHeading[] = [];
  let i = 0;
  const out = html.replace(
    /<(h[1-3])([^>]*)>([\s\S]*?)<\/\1>/gi,
    (whole, tag: string, attrs: string, inner: string) => {
      const level = parseInt(tag.slice(1), 10);
      const text = decodeTextEntities(stripTags(inner).trim());
      // Empty headings carry no TOC entry; leave them untouched.
      if (!text) return whole;
      const idx = i++;
      const existing = attrs.match(/\bid\s*=\s*["']([^"']*)["']/i);
      if (existing) {
        headings.push({ level, text, id: existing[1] });
        return whole;
      }
      const id = `toc-${idx}`;
      headings.push({ level, text, id });
      return `<${tag}${attrs} id="${id}">${inner}</${tag}>`;
    },
  );
  return { html: out, headings };
}

/**
 * Wrap H1-rooted sections in <section class="chapter">. When chapter breaks
 * are on (default), CSS `.chapter { break-before: page }` fires between them.
 */
function wrapChaptersByH1(html: string): string {
  // Split on H1 openings. Everything before the first H1 is a preamble.
  const h1Re = /<h1\b[^>]*>/gi;
  const matches: number[] = [];
  let m;
  while ((m = h1Re.exec(html)) !== null) {
    matches.push(m.index);
  }
  if (matches.length === 0) {
    return `<section class="chapter">${html}</section>`;
  }
  const chunks: string[] = [];
  const preamble = html.slice(0, matches[0]);
  if (preamble.trim().length > 0) {
    chunks.push(`<section class="chapter">${preamble}</section>`);
  }
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i];
    const end = i + 1 < matches.length ? matches[i + 1] : html.length;
    chunks.push(`<section class="chapter">${html.slice(start, end)}</section>`);
  }
  return chunks.join("\n");
}

function extractFirstHeading(html: string): string | null {
  const m = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  return m ? decodeTextEntities(stripTags(m[1]).trim()) : null;
}

/**
 * Decode HTML entities in plain text extracted from rendered HTML. Distinct
 * from decodeTypographicEntities (which runs on in-pipeline HTML and preserves
 * &amp; because &amp;amp; can be legitimate there). This runs on text destined
 * for <title>, cover, and TOC entries where &amp; MUST become & or escapeHtml
 * produces &amp;amp;.
 *
 * Amp-last ordering: input "&amp;#169;" decodes to "&#169;" in the named pass,
 * then the numeric pass decodes "&#169;" to "©". Decoding &amp; first would
 * produce "&#169;" and the numeric pass would consume it — different end state
 * but risks double-decode on inputs like "&amp;lt;".
 */
function decodeTextEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(w => w.length > 0).length;
}

function formatToday(): string {
  const now = new Date();
  return now.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}
