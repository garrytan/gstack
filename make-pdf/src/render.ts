/**
 * Markdown → HTML renderer. Pure function, no I/O, no browser.
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
import { DEFAULT_STYLE, printCss, resolveMargins, type PrintCssOptions, type Style } from "./print-css";
import { swissCoverTitle, swissFieldHeadingLines } from "./style-swiss";
import { applyImageDirectives } from "./image-policy";
import { contentHeightInches, contentWidthInches, DIAGRAM_SLOT_PREFIX } from "./diagram-prepass";

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

  // Look: "swiss" (default) or "plain".
  style?: Style;

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
  html: string;                   // full HTML document, staged and printed through the browser
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

  // 3. Smartypants (code-safe). It reads marked's quote entities
  //    (&quot;, &#39;) in text as quotes and curls them; tags, code and URLs
  //    keep theirs, so a decoded quote can never end an attribute value that
  //    the sanitizer above has already checked.
  const typographicHtml = smartypants(cleanHtml);

  // 4. Derive metadata (title from first H1 if not provided)
  const derivedTitle = opts.title ?? extractFirstHeading(typographicHtml) ?? "Document";
  const derivedAuthor = opts.author ?? "";
  const derivedDate = opts.date ?? formatToday();

  // 5. Build CSS
  // CSS is the single source of truth for page numbers (Chromium native
  // numbering is always off in orchestrator). If the caller supplied a custom
  // footerTemplate, suppress CSS page numbers too so their footer wins.
  const showPageNumbers = opts.pageNumbers !== false && !opts.footerTemplate;
  const style = opts.style ?? DEFAULT_STYLE;
  const pageBox = resolveMargins(opts, style);
  const cssOptions: PrintCssOptions = {
    style,
    cover: opts.cover,
    toc: opts.toc,
    noChapterBreaks: opts.noChapterBreaks,
    watermark: opts.watermark,
    confidential: opts.confidential !== false,
    runningHeader: derivedTitle,
    pageSize: opts.pageSize,
    // Compose per-side margins into the CSS shorthand so @page stays the
    // single source of truth even under preferCSSPageSize.
    margins: composeMargins(pageBox),
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
        style,
        box: { contentWIn: contentWidthInches(pageBox), contentHIn: contentHeightInches(pageBox) },
      })
    : "";

  // TOC anchors must resolve: one heading inventory supplies both the TOC
  // entry labels and their link targets, so an entry can never point at a
  // different heading (an empty heading or a reused id used to shift them).
  const anchored = opts.toc ? anchorHeadings(typographicHtml) : { html: typographicHtml, entries: [] };
  const anchoredHtml = anchored.html;

  const tocBlock = opts.toc ? buildTocBlock(anchored.entries) : "";

  const laidOutHtml = style === "swiss" ? keepFieldHeadingsWithText(anchoredHtml) : anchoredHtml;

  // Wrap body in .chapter sections at H1 boundaries if chapter breaks are on.
  const chapterHtml = opts.noChapterBreaks
    ? `<section class="chapter">${laidOutHtml}</section>`
    : wrapChaptersByH1(laidOutHtml);

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
  // smartypants drops U+0000 after this runs, which would join on\u0000error
  // or java\u0000script: back together, so check the string without it.
  // A removal can also join what was around it (<scr onx="a"ipt> becomes
  // <script>), so repeat the pass until nothing changes, and print the page
  // as text if it never settles.
  let s = html.replace(/\u0000/g, "");
  for (let i = 0; i < 8; i++) {
    const next = sanitizePass(s);
    if (next === s) return s;
    s = next;
  }
  return escapeHtml(s);
}

/**
 * Whether the text at offset starts an attribute of the tag that contains it,
 * read the way the browser's tokenizer reads that tag from its "<": not
 * inside a name or a value, and the tag not yet closed.
 */
function startsAttribute(str: string, offset: number): boolean {
  const tagStart = str.lastIndexOf("<", offset);
  if (tagStart === -1 || !/[a-zA-Z]/.test(str[tagStart + 1] ?? "")) return false;
  const endsAtSpace = /\s/.test(str[offset] ?? "");
  let i = tagStart + 1;
  while (i < offset && !/[\s/>]/.test(str[i]!)) i++;
  while (i < offset) {
    if (/[\s/]/.test(str[i]!)) { i++; continue; }
    if (str[i] === ">") return false;
    while (i < offset && !/[\s/>=]/.test(str[i]!)) i++;
    if (i === offset) return endsAtSpace;
    let j = i;
    while (j < offset && /\s/.test(str[j]!)) j++;
    if (str[j] !== "=") continue;
    j++;
    while (j < offset && /\s/.test(str[j]!)) j++;
    if (j >= offset) return false;
    const q = str[j];
    if (q === '"' || q === "'") {
      const close = str.indexOf(q, j + 1);
      if (close === -1 || close >= offset) return false;
      i = close + 1;
      continue;
    }
    while (j < offset && !/[\s>]/.test(str[j]!)) j++;
    if (j === offset) return endsAtSpace;
    i = j;
  }
  return true;
}

function sanitizePass(html: string): string {
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

  // Event handler attributes (on* in any case). The browser starts an
  // attribute name after whitespace, a "/" or a closing quote
  // (<img src="x"/onerror=…>, <img src="x"onerror=…>), so all four count.
  // An unquoted value stops at a quote or "<": marked writes a quote inside
  // an attribute as &quot;, so the next straight quote closes the attribute
  // this handler text sits in, and the next "<" starts a tag (text such as
  // `a/onset=2` in a code span sits right before </code>). Eating either
  // would leave an attribute or element open. The value may be empty, so the
  // handler's name is always removed, even before a value that starts with
  // "<" (onerror=<!--&#10;… runs its second line). Matching runs over the
  // whole page, text included, so "/on…=" inside a URL or code goes too.
  // A quoted value goes with its name only when it holds no "<" or ">":
  // otherwise the quote may belong to a later element, so the last rule
  // removes just the name and the rest stays where it was. A value holding
  // ">" but no "<" also goes when the handler starts an attribute of the tag
  // it sits in (<div onclick="a > b" class="x">); inside another attribute's
  // value (title="docs/onload='x">…') the quote may be text, so it stays.
  s = s.replace(/(?:\s+|(?<=[/"']))on[a-zA-Z]+\s*=\s*"[^"<>]*"/gi, "");
  s = s.replace(/(?:\s+|(?<=[/"']))on[a-zA-Z]+\s*=\s*'[^'<>]*'/gi, "");
  s = s.replace(/(?:\s+|(?<=[/"']))on[a-zA-Z]+\s*=\s*(?:"[^"<]*"|'[^'<]*')/gi, (m, offset: number, str: string) =>
    startsAttribute(str, offset) ? "" : m);
  s = s.replace(/(?:\s+|(?<=[/"']))on[a-zA-Z]+\s*=\s*[^\s>"'`<]*/gi, "");

  // javascript: URLs in href/src/action/formaction (same attribute starts).
  s = s.replace(
    /([\s/"']\s*(?:href|src|action|formaction|xlink:href)\s*=\s*)(?:"javascript:[^"<>]*"|'javascript:[^'<>]*')/gi,
    '$1"#"',
  );
  // Any other javascript: value (unquoted, or quoted around "<" or ">") loses
  // only its scheme, so no quote is added or removed. A numeric reference
  // with more digits after 58 or 3a is another character, not a colon.
  s = s.replace(/([\s/"']\s*(?:href|src|action|formaction|xlink:href)\s*=\s*["']?[\s\x01-\x20]*)javascript(?::|&colon;|&#0*58(?![0-9]);?|&#x0*3a(?![0-9a-f]);?)/gi, "$1#");

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

  // javascript: spelled the way only the browser reads it: entity letters
  // (&#106;avascript:), or a tab or line break anywhere in the scheme, which
  // URL parsing drops (java&Tab;script:). Decode the start of each URL
  // attribute value as the parser will, drop tabs and line breaks, and when
  // it is still javascript: put "#" in front, which makes the whole value a
  // fragment. Only the name and the opening quote are matched, so a quote
  // that really closes an earlier attribute can't hide a later value, and no
  // quote is added or removed. A value longer than the window that is still
  // nothing but padding and the start of "javascript:" counts as one.
  s = s.replace(/(?<=[\s/"'])(\s*(?:href|src|action|formaction|xlink:href)\s*=\s*)(["']?)/gi,
    (m, pre, q, offset: number, str: string) => {
      const start = offset + m.length;
      let end = q ? str.indexOf(q, start) : str.slice(start, start + 2048).search(/[\s>]/);
      end = end === -1 ? str.length : q ? end : start + end;
      const truncated = end - start > 2048;
      let value = str.slice(start, Math.min(end, start + 2048));
      if (truncated) value = value.replace(/&[#\w]*$/, "");
      const url = decodeStyleAttrEntities(value).replace(/[\t\n\r]/g, "").replace(/^[\x00-\x20]+/, "").toLowerCase();
      const live = url.startsWith("javascript:") || (truncated && "javascript:".startsWith(url));
      return live ? `${pre}${q}#` : m;
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

/**
 * swiss sets an h3 in the left field beside the text that follows it. A float
 * does not move with that text: when orphans push a paragraph to the next
 * page, a floated sub-heading stays behind at the page foot. So the h3 and the
 * paragraph, list or quote right after it go in <div class="swiss-keep">,
 * where the CSS pins the h3 to the wrapper's top and the wrapper starts where
 * the text does. min-height keeps a sub-heading longer than its text clear of
 * the next block. (Code, tables, figures, image-only paragraphs and diagrams,
 * which are still placeholder paragraphs here, need no wrapper: the CSS keeps
 * the h3 in normal flow above them.) Each <br> in the heading starts a new
 * line of that estimate. Only top-level
 * blocks are paired: an h3 inside raw HTML, a quote or a list item is not in
 * the field, and the CSS that positions the wrapper applies only at the top.
 */
export function keepFieldHeadingsWithText(html: string): string {
  const blocks = topLevelBlocks(html);
  const out: string[] = [];
  let last = 0;
  for (let i = 0; i + 1 < blocks.length; i++) {
    const [h3, next] = [blocks[i], blocks[i + 1]];
    if (h3.tag !== "h3" || !/^(p|ul|ol|blockquote)$/.test(next.tag)) continue;
    if (html.slice(h3.end, next.start).trim() !== "") continue;
    const text = html.slice(next.start, next.end);
    if (next.tag === "p" && /^<p\b[^>]*>[^<]*<img\b[^>]*>[^<]*<\/p>$/i.test(text)) continue;
    if (next.tag === "p" && new RegExp(`^<p>\\s*${DIAGRAM_SLOT_PREFIX}[0-9a-f]+-\\d+\\s*</p>$`).test(text)) continue;
    const heading = html.slice(h3.start, h3.end);
    const lines = heading.split(/<br\b[^>]*>/i).reduce((n, line) => n + swissFieldHeadingLines(stripTags(line)), 0);
    const minPt = lines * 13 + 2;
    out.push(html.slice(last, h3.start), `<div class="swiss-keep" style="min-height: ${minPt}pt;">${html.slice(h3.start, next.end)}</div>`);
    last = next.end;
    i++;
  }
  out.push(html.slice(last));
  return out.join("");
}

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

/**
 * Spans of the top-level elements in a fragment. Comments are skipped, void
 * tags open nothing, a close tag with no matching open tag is ignored, and a
 * close tag closes whatever it left open, so unbalanced raw HTML cannot leave
 * the rest of the document nested.
 */
function topLevelBlocks(html: string): Array<{ tag: string; start: number; end: number }> {
  const blocks: Array<{ tag: string; start: number; end: number }> = [];
  const stack: string[] = [];
  let start = 0;
  const token = /<!--[\s\S]*?(?:-->|$)|<(\/?)([a-zA-Z][\w-]*)\b[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = token.exec(html)) !== null) {
    if (!m[2]) continue;
    const tag = m[2].toLowerCase();
    if (m[1]) {
      const at = stack.lastIndexOf(tag);
      if (at < 0) continue;
      stack.length = at;
      if (at === 0) blocks.push({ tag, start, end: token.lastIndex });
      continue;
    }
    if (VOID_TAGS.has(tag) || m[0].endsWith("/>")) continue;
    if ((tag === "li" || tag === "p") && stack[stack.length - 1] === tag) stack.pop();
    if (stack.length === 0) start = m.index;
    stack.push(tag);
  }
  return blocks;
}

function buildCoverBlock(opts: {
  title: string;
  subtitle?: string;
  author?: string;
  date: string;
  style: Style;
  box: { contentWIn: number; contentHIn: number };
}): string {
  const title = escapeHtml(opts.title);
  const size = opts.style === "swiss" ? swissCoverTitle(opts.title, opts.box) : undefined;
  const titleStyle = size ? ` style="font-size: ${size.fontPt}pt; padding-top: ${size.padTopIn}in;"` : "";
  const subtitle = opts.subtitle ? escapeHtml(opts.subtitle) : "";
  const author = opts.author ? escapeHtml(opts.author) : "";
  const date = escapeHtml(opts.date);
  return [
    `<section class="cover">`,
    `  <h1 class="cover-title"${titleStyle}>${title}</h1>`,
    subtitle ? `  <p class="cover-subtitle">${subtitle}</p>` : ``,
    `  <hr class="rule">`,
    `  <div class="cover-meta">`,
    author ? `    <div><strong>${author}</strong></div>` : ``,
    `    <div>${date}</div>`,
    `  </div>`,
    `</section>`,
  ].filter(Boolean).join("\n");
}

export interface TocEntry {
  level: number;
  text: string;
  /** The id the heading carries in the output (decoded text, not attribute-escaped). */
  id: string;
}

/**
 * Emit the TOC. Each entry links to its heading's id; the empty
 * `.toc-page` span is filled with the printed page number by
 * toc-pages.ts after the PDF has been laid out (PDF output only).
 */
function buildTocBlock(entries: TocEntry[]): string {
  if (entries.length === 0) return "";

  const items = entries.map((h) => {
    const level = h.level >= 2 ? "level-2" : "level-1";
    const id = escapeHtml(h.id);
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

const ID_ATTR = /(\sid\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

/**
 * The single heading inventory behind the TOC. Every H1-H3 with visible text
 * becomes one entry, in document order, and the entry's id is the id that
 * heading owns in the output:
 *   - a heading whose own id is the FIRST element with that id keeps it;
 *   - a heading with no id, or with an id an earlier element already owns
 *     (fragment links resolve to the first owner), gets a fresh `toc-N` that
 *     no element in the document uses.
 * Headings without text get no entry and no id, so they cannot shift the
 * entries after them.
 */
export function anchorHeadings(html: string): { html: string; entries: TocEntry[] } {
  const firstOwner = new Map<string, number>();
  for (const m of html.matchAll(/<[a-zA-Z][^>]*>/g)) {
    const id = attrId(m[0]);
    if (id !== null && !firstOwner.has(id)) firstOwner.set(id, m.index!);
  }
  let next = 0;
  const freshId = (): string => {
    while (firstOwner.has(`toc-${next}`)) next++;
    const id = `toc-${next++}`;
    firstOwner.set(id, -1);
    return id;
  };

  const entries: TocEntry[] = [];
  const out = html.replace(
    /<(h[1-3])\b([^>]*)>([\s\S]*?)<\/\1>/gi,
    (full, tag: string, attrs: string, inner: string, offset: number) => {
      const text = decodeTextEntities(stripTags(inner).trim());
      if (!text) return full;
      const level = parseInt(tag.slice(1), 10);
      const existing = attrId(`<${tag}${attrs}>`);
      if (existing !== null && firstOwner.get(existing) === offset) {
        entries.push({ level, text, id: existing });
        return full;
      }
      const id = freshId();
      entries.push({ level, text, id });
      const newAttrs = ID_ATTR.test(attrs)
        ? attrs.replace(ID_ATTR, (_m, pre: string) => `${pre}"${id}"`)
        : `${attrs} id="${id}"`;
      return `<${tag}${newAttrs}>${inner}</${tag}>`;
    },
  );
  return { html: out, entries };
}

/** The decoded value of a tag's `id` attribute (not `data-id`), or null when absent or empty. */
function attrId(tag: string): string | null {
  const m = tag.match(ID_ATTR);
  const id = m ? decodeTextEntities(m[2] ?? m[3] ?? m[4] ?? "") : "";
  return id || null;
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
 * from smartypants, which reads only quote entities, only in text, and leaves
 * &amp; alone because &amp;amp; can be legitimate there. This runs on text destined
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
