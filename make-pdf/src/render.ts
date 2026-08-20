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
import { applyImageDirectives } from "./image-policy";

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
  // Per-side margins (override `margins`). Must reach the CSS @page rule:
  // when a landscape promotion flips preferCSSPageSize on, the CSS margins
  // are the ones Chromium honors — dropping per-side flags there would
  // silently change the whole document's layout (Codex P2).
  marginTop?: string;
  marginRight?: string;
  marginBottom?: string;
  marginLeft?: string;

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
  // 1. Markdown → HTML (strip a leading YAML frontmatter block first; marked
  //    has no frontmatter awareness and would otherwise render it as a literal
  //    paragraph of body text on its own first page).
  const rawHtml = marked.parse(stripFrontmatter(opts.markdown), { async: false }) as string;

  // 1.5. Image directive suffixes: `![a](x.png){width=50%}` → data-gstack-*
  // attributes. Before the sanitizer (which keeps data- attrs) so the brace
  // text never reaches smartypants or the final page.
  const directedHtml = applyImageDirectives(rawHtml);

  // 2. Sanitize
  const cleanHtml = sanitizeUntrustedHtml(directedHtml);

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
    // Compose per-side margins into the CSS shorthand so @page stays the
    // single source of truth even under preferCSSPageSize.
    margins: composeMargins(opts),
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

  // TOC anchors must resolve: assign id="toc-N" to each H1-H3 in the same
  // order buildTocBlock scans them, or every TOC link is a dead href (masked
  // in PDFs by Chromium outline bookmarks, glaring in --to html). Headings
  // that already carry an id keep it — the ids array records the ACTUAL id
  // per heading so TOC entries always link to something real.
  const anchored = opts.toc ? addHeadingIds(typographicHtml) : { html: typographicHtml, ids: [] };
  const anchoredHtml = anchored.html;

  const tocBlock = opts.toc
    ? buildTocBlock(anchoredHtml, anchored.ids)
    : "";

  // Wrap body in .chapter sections at H1 boundaries if chapter breaks are on.
  const chapterHtml = opts.noChapterBreaks
    ? `<section class="chapter">${anchoredHtml}</section>`
    : wrapChaptersByH1(anchoredHtml);

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
 *   - remote href/xlink:href inside <svg> (and on svg-only elements anywhere)
 *     → "#" (offline posture: no fetch at print time).
 *   - remote CSS fetch vectors in <style> blocks and style attributes
 *     (@import, url(), image-set() with remote string candidates).
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

  // ── Offline-posture fetch vectors (no --allow-network must mean no network
  // at print time; the image inliner covers <img src> only, and must keep
  // seeing remote <img src> so its blocked-remote placeholder still fires) ──

  // Untrusted CSS neutralization. Scoped to <style> blocks and style
  // attributes below so prose/code samples that mention URLs stay untouched.
  //
  // Chromium decodes CSS ident/string escapes (\69 → i, \68 → h) before
  // fetching, so literal patterns alone are bypassable: @\69mport dodges
  // /@import\b/, url("\68ttps://…") dodges the https?://-shaped remote-url
  // pattern, and u\72l(…) dodges the url( prefix itself. Untrusted styling
  // has no legitimate need for escaped url schemes or at-rule names, so any
  // construct carrying a backslash escape is dropped/defanged (fail closed).
  // In style ATTRIBUTES the HTML parser also entity-decodes before the CSS
  // parser runs, so &#92; / &#x5c; / &bsol; spellings of the backslash count
  // as escapes too. (<style> content is raw text — no entity layer there.)
  const CSS_ESCAPE_MARKER = /\\|&#0*92(?![0-9])|&#x0*5c(?![0-9a-f])|&bsol;/i;
  const neutralizeUntrustedCss = (css: string): string => {
    // (a) At-rules whose keyword carries a backslash escape (@\69mport …):
    //     drop the whole statement through `;`, `{`, or end-of-value.
    let out = css.replace(
      /@[-\w\\&#;]*?(?:\\|&#0*92(?![0-9]);?|&#x0*5c(?![0-9a-f]);?|&bsol;)[-\w\\&#;]*[^;{}]*(?:;|\{|$)/gi,
      "");
    // (b) Literal @import is always a fetch (relative ones can't resolve
    //     under load-html either) — drop outright.
    out = out.replace(/@import\b[^;]*(;|$)/gi, "");
    // (c) Any function-like token whose name or arguments carry a backslash
    //     escape → url(#). Covers escaped schemes (url("\68ttps://…")) and
    //     escaped function names (u\72l(…)) in one fail-closed pass. The
    //     end-of-value alternative closes the unterminated-url() dodge:
    //     Chromium's CSS parser closes an open function token at EOF.
    out = out.replace(/[-\w\\&#;][-\w \t\\&#;]*\(\s*[^)]*(?:\)|$)/g, (m) =>
      CSS_ESCAPE_MARKER.test(m) ? "url(#)" : m);
    // (d) Remote url(...) → url(#).
    out = out.replace(
      /url\(\s*(?:&quot;|&#0?39;|&#x27;|["'])?\s*(?:https?:)?\/\/[^)]*(?:\)|$)/gi,
      "url(#)");
    // (e) image-set() / -webkit-image-set() accept BARE quoted URL strings —
    //     no url() token, no backslash — so passes (c)/(d) never fire on
    //     `image-set("https://…" 1x)`. Any image-set whose arguments carry a
    //     remote-scheme quoted string → url(#) (fail closed). Local string
    //     candidates stay; url()-form arguments are already covered by (c)/(d).
    out = out.replace(/(?:-webkit-)?image-set\(\s*[^)]*(?:\)|$)/gi, (m) =>
      /(?:&quot;|&#0?39;|&#x27;|["'])\s*(?:https?:)?\/\//i.test(m) ? "url(#)" : m);
    return out;
  };

  // Raw-HTML <style> blocks. Element content is RAW TEXT — the HTML parser
  // never entity-decodes it — so unlike style attributes below, no entity
  // decode step is needed (or correct) here.
  s = s.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_m, open, css, close) =>
    open + neutralizeUntrustedCss(css) + close);

  // Style ATTRIBUTE values are entity-decoded by the HTML parser before the
  // CSS parser ever runs, so &#104;ttps://… reaches Chromium as https://… and
  // &#47;&#47; as // — dodging every literal pattern above. Decode the value
  // the way the parser will (numeric dec/hex refs with the spec's optional
  // semicolon; the syntax-significant named refs; the legacy semicolonless
  // four), in ONE left-to-right pass so the sanitizer performs exactly the
  // browser's single decode round — decoding recursively would turn a
  // double-encoded &amp;#104; into a live scheme the browser never sees.
  const NAMED_REFS: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
    sol: "/", bsol: "\\", colon: ":", semi: ";", num: "#",
    lpar: "(", rpar: ")", commat: "@", grave: "`",
    Tab: "\t", NewLine: "\n",
  };
  const refCodePoint = (n: number): string =>
    (!Number.isFinite(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff))
      ? "�" : String.fromCodePoint(n);
  const decodeStyleAttrEntities = (v: string): string => v.replace(
    /&(?:#[xX]([0-9a-fA-F]+);?|#(\d+);?|([a-zA-Z]+);|(amp|lt|gt|quot)(?![a-zA-Z0-9=;]))/g,
    (m, hex, dec, named, legacy) => {
      if (hex !== undefined) return refCodePoint(parseInt(hex, 16));
      if (dec !== undefined) return refCodePoint(parseInt(dec, 10));
      if (named !== undefined) return NAMED_REFS[named] ?? m;
      return NAMED_REFS[legacy];
    });

  // Inline style attributes — quoted AND unquoted. HTML spec: an unquoted
  // attribute value runs until whitespace or `>`, so
  // <div style=background:url(https://…)> is live markup Chromium honors;
  // a quoted-only pattern misses it. The value is unquoted, entity-decoded
  // (see above), neutralized in decoded form, then RE-ENCODED and emitted
  // double-quoted — never emit decoded text raw (a decoded `"` would break
  // out of the attribute) and the re-encode also keeps once-decoded text like
  // &#104; inert instead of granting it a second decode round.
  s = s.replace(/(\s+style\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'>][^\s>]*))/gi,
    (_m, pre, dq, sq, uq) => {
      const raw = dq ?? sq ?? uq;
      const cleaned = neutralizeUntrustedCss(decodeStyleAttrEntities(raw));
      return `${pre}"${escapeHtml(cleaned)}"`;
    });

  // SVG remote-fetch vectors: <image href>, <use href>, <feImage href> (and
  // their xlink:href spellings) fetch at print time — the svg handling above
  // only strips <script>, and the javascript:-scheme rewrite doesn't touch a
  // plain https:// href. Fail closed: inside an <svg> block, ANY href /
  // xlink:href whose entity-decoded value is remote (https?:// or //) is
  // rewritten to "#"; local fragment refs (href="#id") and local files stay
  // intact. The tag-scoped second pass catches svg-only elements smuggled
  // through an UNCLOSED <svg> (Chromium auto-closes at EOF and still
  // fetches); outside foreign content those tags are inert or parser-mapped
  // to <img> (href ignored), so the extra pass can't break plain HTML —
  // regular <a href> hyperlinks are untouched (links don't fetch at print).
  const neutralizeRemoteSvgHref = (fragment: string): string =>
    fragment.replace(
      /(\s(?:xlink:)?href\s*=\s*)("([^"]*)"|'([^']*)'|[^\s>]+)/gi,
      (m, pre, val, dq, sq) => {
        // Decode the value the way the HTML parser will (same single-round
        // decode as style attributes above), then drop the tab/newline/CR
        // characters URL parsing ignores, so &#104;ttps and h\nttps count.
        const raw = dq ?? sq ?? String(val);
        const decoded = decodeStyleAttrEntities(raw).replace(/[\t\n\r]/g, "");
        return /^\s*(?:https?:)?\/\//i.test(decoded) ? `${pre}"#"` : m;
      });
  s = s.replace(/<svg\b[\s\S]*?<\/svg>/gi, neutralizeRemoteSvgHref);
  s = s.replace(/<(?:image|use|feimage)\b[^>]*>/gi, neutralizeRemoteSvgHref);

  // srcset with a remote candidate: Chromium prefers srcset over the inlined
  // src, so a remote candidate fetches at print time. Strip the attribute;
  // local/data: srcset values are left alone.
  const remoteSrcsetCandidate = /(?:^|[,\s])\s*(?:https?:)?\/\//i;
  s = s.replace(/\s+srcset\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, (m, val) =>
    remoteSrcsetCandidate.test(String(val).replace(/^["']|["']$/g, "")) ? "" : m);

  // Remote src/poster on media elements (<video poster>, <source src>, …).
  s = s.replace(/<(?:video|audio|source|track)\b[^>]*>/gi, (tag) =>
    tag.replace(
      /(\s(?:src|poster)\s*=\s*)(?:"(?:https?:)?\/\/[^"]*"|'(?:https?:)?\/\/[^']*'|(?:https?:)?\/\/[^\s>]+)/gi,
      '$1"#"',
    ));

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

/**
 * Scan HTML for H1/H2/H3 headings and emit a TOC placeholder.
 * Page numbers are filled in by Paged.js (when --toc is passed and Paged.js
 * polyfill is injected).
 */
function buildTocBlock(html: string, ids: string[] = []): string {
  const headings = extractHeadings(html);
  if (headings.length === 0) return "";

  const items = headings.map((h, i) => {
    const level = h.level >= 2 ? "level-2" : "level-1";
    const id = ids[i] ?? `toc-${i}`;
    return [
      `  <li class="${level}">`,
      `    <span class="toc-title"><a href="#${id}">${escapeHtml(h.text)}</a></span>`,
      `    <span class="toc-dots"></span>`,
      `    <span class="toc-page" data-toc-target="${id}"></span>`,
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
 * Assign id="toc-N" to every H1-H3 in document order — the same order
 * extractHeadings/buildTocBlock use, so anchors and entries line up by index.
 * A heading that already carries an id keeps it, and the returned ids array
 * records the actual id for that slot so the TOC links to the real anchor
 * instead of a nonexistent toc-N.
 */
function addHeadingIds(html: string): { html: string; ids: string[] } {
  const ids: string[] = [];
  const out = html.replace(/<(h[1-3])([^>]*)>/gi, (full, tag: string, attrs: string) => {
    const existing = attrs.match(/\bid\s*=\s*["']([^"']*)["']/i)?.[1];
    if (existing) {
      ids.push(existing);
      return full;
    }
    const id = `toc-${ids.length}`;
    ids.push(id);
    return `<${tag}${attrs} id="${id}">`;
  });
  return { html: out, ids };
}

function extractHeadings(html: string): Array<{ level: number; text: string }> {
  const re = /<(h[1-3])[^>]*>([\s\S]*?)<\/\1>/gi;
  const headings: Array<{ level: number; text: string }> = [];
  let match;
  while ((match = re.exec(html)) !== null) {
    const level = parseInt(match[1].slice(1), 10);
    const text = decodeTextEntities(stripTags(match[2]).trim());
    if (text) headings.push({ level, text });
  }
  return headings;
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
  // A preamble that renders nothing visible (a leading <style> block, an HTML
  // comment) must NOT become its own .chapter. That section would take the
  // `.chapter:first-of-type { break-before: auto }` exception, so the first
  // *real* chapter inherits `break-before: page` and starts on page 2 — leaving
  // a blank page 1. Keep the non-rendering markup (so its styling still applies)
  // but fold it into the first real chapter instead of giving it a page break.
  let carriedPreamble = "";
  if (preamble.trim().length > 0) {
    if (stripNonRendering(preamble).trim().length > 0) {
      chunks.push(`<section class="chapter">${preamble}</section>`);
    } else {
      carriedPreamble = preamble;
    }
  }
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i];
    const end = i + 1 < matches.length ? matches[i + 1] : html.length;
    const body = i === 0 ? carriedPreamble + html.slice(start, end) : html.slice(start, end);
    chunks.push(`<section class="chapter">${body}</section>`);
  }
  return chunks.join("\n");
}

/**
 * Strip leading YAML frontmatter (`---\n...\n---`). Only a block at the very
 * start of the document is removed, so a `---` thematic break elsewhere is
 * untouched.
 */
function stripFrontmatter(md: string): string {
  return md.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "");
}

/**
 * Remove non-rendering markup (style/script blocks, HTML comments) so an
 * otherwise-empty preamble is recognized as visually empty. Used only to decide
 * whether a preamble deserves its own page — the original markup is preserved in
 * the output.
 */
function stripNonRendering(html: string): string {
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
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

/** Compose `margin: top right bottom left` from per-side overrides + base. */
function composeMargins(opts: {
  margins?: string; marginTop?: string; marginRight?: string;
  marginBottom?: string; marginLeft?: string;
}): string | undefined {
  const base = opts.margins ?? "1in";
  if (!opts.marginTop && !opts.marginRight && !opts.marginBottom && !opts.marginLeft) {
    return opts.margins;
  }
  return [
    opts.marginTop ?? base,
    opts.marginRight ?? base,
    opts.marginBottom ?? base,
    opts.marginLeft ?? base,
  ].join(" ");
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

export function escapeHtml(s: string): string {
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
