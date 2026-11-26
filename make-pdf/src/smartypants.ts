/**
 * Inline typographic transform (smartypants).
 *
 * Converts ASCII typography to real Unicode:
 *   "quoted"     → "quoted"    (U+201C/U+201D)
 *   'quoted'     → 'quoted'    (U+2018/U+2019)
 *   don't        → don't       (apostrophe: U+2019)
 *   --           → —           (em dash U+2014)
 *   ...          → …           (ellipsis U+2026)
 *
 * Critical: must NOT touch code, URLs, or HTML attributes. The Codex round
 * 2 review flagged this specifically — smartypants run over a fenced code
 * block corrupts the code and tokens inside tag attributes can break
 * parsing.
 *
 * This operates on HTML (marked already produced it) and walks text nodes
 * only via a lightweight regex that recognizes code/pre/URL zones and
 * skips them entirely.
 */

const CODE_ZONE_RE = /<(pre|code|script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;
const TAG_RE = /<[^>]+>/g;
// \u0000 is the placeholder sentinel (see PLACEHOLDER below). It must be
// excluded here: URLs are carved AFTER tags, so a URL sitting flush against
// a tag (`<a href="...">https://ex.com</a>`) would otherwise let \S+ swallow
// the placeholder standing in for `</a>` — that placeholder then never
// restores (restore is a single pass) and the tag is lost.
const URL_RE = /\bhttps?:\/\/[^\s\u0000]+/g;

/**
 * Apply smartypants to an HTML string. Zones that should not be touched:
 *   - <pre>, <code>, <script>, <style> blocks (content unchanged)
 *   - HTML tags themselves (attributes unchanged)
 *   - URLs (http:// and https:// spans unchanged)
 */
export function smartypants(html: string): string {
  // Step 1: split into preserved + transformed zones.
  // Preserved zones: code/pre/script/style, tags, URLs.
  // We carve them out with placeholder tokens, transform the rest, and
  // splice them back.
  const preserved: string[] = [];
  const PLACEHOLDER = (i: number) => `\u0000SMARTPANTS_PRESERVED_${i}\u0000`;

  const carve = (source: string, pattern: RegExp): string => {
    return source.replace(pattern, (match) => {
      const idx = preserved.length;
      preserved.push(match);
      return PLACEHOLDER(idx);
    });
  };

  let s = html.replace(/\u0000/g, "");  // drop stray input NUL (can't forge a placeholder)
  s = carve(s, CODE_ZONE_RE);
  s = carve(s, TAG_RE);
  s = carve(s, URL_RE);

  s = transformSegments(s, preserved);

  // Step 2: restore preserved zones.
  // Use a function to avoid $-substitution gotchas.
  s = s.replace(/\u0000SMARTPANTS_PRESERVED_(\d+)\u0000/g, (_, idx) => {
    return preserved[parseInt(idx, 10)] ?? "";
  });

  return s;
}

const PLACEHOLDER_SPLIT_RE = /(\u0000SMARTPANTS_PRESERVED_\d+\u0000)/;
const BLOCK_TAG_RE = /^<\/?(?:address|article|aside|blockquote|br|caption|dd|div|dl|dt|figcaption|figure|footer|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)\b/i;
const INLINE_TAG_RE = /^<\/?(?:a|abbr|b|cite|del|dfn|em|i|ins|mark|q|s|small|span|strong|sub|sup|u)\b/i;
const QUOTE_START_RE = /^(?:["']|&quot;|&#39;|&apos;|&#x27;)/;
const OPENING_CONTEXT_RE = /[\s\(\[\{\-\uff1a\uff08\u3010\u300c\u300e\u3008\u300a]/;

/**
 * Transform each run of text between placeholders, reading a quote at the
 * start of a run by the visible text before it: a block tag (<p>, <li>, <h1>)
 * or the start of the document opens, an inline tag that wraps text (<em>,
 * <a>) is skipped, and anything else (code, a URL, an image, an unknown tag)
 * counts as a word. A run that starts with a quote is transformed behind a
 * one-character prefix that stands for that context; any other run keeps the
 * placeholder's own character before it, so "--flag" at the start of a cell
 * stays as it was, and a run that ends before a placeholder keeps that
 * character after it, so "wait --" before a tag does too. No rule changes the
 * character before or after its match, so both come back unchanged and are cut.
 */
function transformSegments(s: string, preserved: string[]): string {
  let context = " ";
  const parts = s.split(PLACEHOLDER_SPLIT_RE);
  return parts.map((part, i) => {
    if (i % 2 === 1) {
      const zone = preserved[parseInt(part.slice("\u0000SMARTPANTS_PRESERVED_".length), 10)] ?? "";
      if (BLOCK_TAG_RE.test(zone)) context = " ";
      else if (!INLINE_TAG_RE.test(zone)) context = "x";
      return part;
    }
    if (!part) return part;
    const prefix = QUOTE_START_RE.test(part) ? context : i === 0 ? "" : "\u0000";
    const suffix = i < parts.length - 1 ? "\u0000" : "";
    const out = transformText(prefix + part + suffix).slice(prefix.length, suffix ? -1 : undefined);
    context = OPENING_CONTEXT_RE.test(part[part.length - 1]!) ? " " : "x";
    return out;
  }).join("");
}

/**
 * Transform plain text (no HTML, no code, no URLs).
 *
 * Order matters:
 *   1. Triple dots first (so they don't collide with later apostrophes)
 *   2. Em dashes (two hyphens → em dash)
 *   3. Apostrophes (contractions + possessives)
 *   4. Double quotes (open/close pairing)
 *   5. Single quotes (open/close pairing — after apostrophes)
 */
function transformText(text: string): string {
  // marked writes text quotes as entities. Read them as quotes here, in text
  // only: every quote below becomes a curly one, so none can come out as
  // attribute or tag syntax however a tag was split.
  let s = text
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'");

  // Ellipsis: three literal dots (with optional spaces) → …
  s = s.replace(/\.\s?\.\s?\./g, "\u2026");

  // Em dash: -- → —. Require space or word-char boundary on both sides so
  // we don't mangle ARGV-style flags in prose like `--verbose`.
  s = s.replace(/(\w|\s)--(\w|\s)/g, "$1\u2014$2");
  // Standalone --  at start/end
  s = s.replace(/^--\s/gm, "\u2014 ");
  s = s.replace(/\s--$/gm, " \u2014");

  // Apostrophes in contractions and possessives.
  // "don't", "it's", "they're", "Garry's"
  s = s.replace(/(\w)'(\w)/g, "$1\u2019$2");

  // Double quotes: open if preceded by whitespace/bol, close if preceded
  // by word char or punctuation.
  s = s.replace(/(^|[\s\(\[\{\-\uff1a\uff08\u3010\u300c\u300e\u3008\u300a])"/g, "$1\u201c");     // opening "
  s = s.replace(/"/g, "\u201d");                         // remaining " are closing

  // Single quotes (after apostrophe pass):
  s = s.replace(/(^|[\s\(\[\{\-\uff1a\uff08\u3010\u300c\u300e\u3008\u300a])'/g, "$1\u2018");      // opening '
  s = s.replace(/'/g, "\u2019");                         // remaining ' are closing

  return s;
}
