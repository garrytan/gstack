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
const URL_RE = /\bhttps?:\/\/\S+/g;

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

  let s = html;
  s = carve(s, CODE_ZONE_RE);
  s = carve(s, TAG_RE);
  s = carve(s, URL_RE);

  s = transformText(s);

  // Step 2: restore preserved zones.
  // Use a function to avoid $-substitution gotchas.
  s = s.replace(/\u0000SMARTPANTS_PRESERVED_(\d+)\u0000/g, (_, idx) => {
    return preserved[parseInt(idx, 10)] ?? "";
  });

  return s;
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
  let s = text;

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
  s = s.replace(/(^|[\s\(\[\{\-])"/g, "$1\u201c");     // opening "
  s = s.replace(/"/g, "\u201d");                         // remaining " are closing

  // Single quotes (after apostrophe pass):
  s = s.replace(/(^|[\s\(\[\{\-])'/g, "$1\u2018");      // opening '
  s = s.replace(/'/g, "\u2019");                         // remaining ' are closing

  return s;
}
