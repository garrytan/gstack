/**
 * review-allowlist — the two allowlisted docs paths of a /ship review depth (GST-850, docs/review-policy.md#allowlisted-docs-paths):
 * a new SVG built only from presentational elements and attributes, and a locale resource edit that changes only literal
 * string values. Both read the whole input with index scanners that only move forward, so time is linear in the input,
 * and both fail closed: anything they do not recognize keeps the path code. A leaf module: lib/review-depth.ts decides
 * which paths reach it and folds ALLOWLIST_RULES into DEPTH_RULES.
 */
import { createHash } from 'node:crypto';

export const SVG_ELEMENTS = ['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'title', 'desc', 'defs', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'use', 'symbol', 'marker', 'pattern', 'mask'];
export const SVG_ATTRIBUTES = [
  'xmlns', 'version', 'id', 'class', 'style', 'role', 'lang', 'aria-label', 'aria-hidden', 'aria-labelledby', 'aria-describedby',
  'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy', 'fr', 'dx', 'dy', 'width', 'height', 'd', 'points', 'pathLength',
  'viewBox', 'preserveAspectRatio', 'transform', 'overflow', 'display', 'visibility', 'opacity', 'color',
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-miterlimit', 'paint-order', 'vector-effect', 'shape-rendering', 'text-rendering',
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant', 'text-anchor', 'dominant-baseline', 'alignment-baseline', 'letter-spacing', 'word-spacing', 'text-decoration', 'rotate', 'textLength', 'lengthAdjust',
  'offset', 'stop-color', 'stop-opacity', 'gradientUnits', 'gradientTransform', 'spreadMethod', 'clip-path', 'clip-rule', 'clipPathUnits', 'mask', 'maskUnits', 'maskContentUnits',
  'patternUnits', 'patternContentUnits', 'patternTransform', 'markerWidth', 'markerHeight', 'markerUnits', 'refX', 'refY', 'orient', 'marker-start', 'marker-mid', 'marker-end', 'href',
];
const SVG_NS = 'http://www.w3.org/2000/svg';
const XML_DECL = /^<\?xml version="1\.[01]"(?: encoding="[A-Za-z0-9._-]+")?(?: standalone="(?:yes|no)")?\s*\?>$/;
const NAMED_ENTITY = /^&(?:amp|lt|gt|quot|apos);/;
const FRAGMENT = /^#[A-Za-z_][\w.-]*$/;
const LOCAL_URL = /url\(#[A-Za-z_][\w.-]*\)/g;
const STYLE_VALUE = /^[A-Za-z0-9\s#%.,:;()_+-]*$/;

const isWs = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
const isNameChar = (c: string | undefined) => !!c && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '-');
/** Every & starts one of the five predefined entities: a numeric reference could spell an interpolation or a scheme. */
function entitiesOk(s: string): boolean {
  for (let k = s.indexOf('&'); k >= 0; k = s.indexOf('&', k + 1)) if (!NAMED_ENTITY.test(s.slice(k, k + 8))) return false;
  return true;
}
function textOk(s: string, inside: boolean): boolean {
  if (!inside) { for (const c of s) if (!isWs(c)) return false; return true; }
  return !/[\0-\x08\x0b\x0c\x0e-\x1f]|\{\{|\$\{|\]\]>/.test(s) && entitiesOk(s);
}
function valueOk(element: string, name: string, v: string): boolean {
  if (/[<\\`{}\0-\x1f]|\$\{/.test(v) || !entitiesOk(v)) return false;
  if (name === 'xmlns') return v === SVG_NS;
  if (name === 'href') return element === 'use' && FRAGMENT.test(v);
  if (name === 'style') return STYLE_VALUE.test(v) && !/url\(|expression/i.test(v);
  return !/url\(/i.test(v.replace(LOCAL_URL, ''));
}
/** One start tag's body (between < and >, without a trailing /): the element name, or null when anything is off the allowlist. */
function tagOk(body: string): string | null {
  let k = 0;
  while (k < body.length && isNameChar(body[k]) && body[k] !== '-') k++;
  const name = body.slice(0, k);
  if (!SVG_ELEMENTS.includes(name)) return null;
  const seen = new Set<string>();
  while (k < body.length) {
    if (!isWs(body[k])) return null;
    while (isWs(body[k])) k++;
    if (k >= body.length) break;
    const start = k;
    while (isNameChar(body[k])) k++;
    const attr = body.slice(start, k);
    while (isWs(body[k])) k++;
    if (!SVG_ATTRIBUTES.includes(attr) || seen.has(attr) || body[k] !== '=') return null;
    k++;
    while (isWs(body[k])) k++;
    const q = body[k];
    if (q !== '"' && q !== "'") return null;
    const end = body.indexOf(q, k + 1);
    if (end < 0 || !valueOk(name, attr, body.slice(k + 1, end))) return null;
    seen.add(attr);
    k = end + 1;
  }
  return name;
}

/** Whether a whole SVG file is presentational only: one svg root, allowlisted elements and attributes, no prefixes, scripts, entities, doctype or outside references. */
export function presentationalSvg(text: string): boolean {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  if (text.startsWith('<?xml', i)) {
    const end = text.indexOf('?>', i);
    if (end < 0 || !XML_DECL.test(text.slice(i, end + 2))) return false;
    i = end + 2;
  }
  const stack: string[] = [];
  let roots = 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (!textOk(text.slice(i, lt < 0 ? text.length : lt), stack.length > 0)) return false;
    if (lt < 0) break;
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      const body = text.slice(lt + 4, end);
      if (end < 0 || body.includes('--') || /[<>]/.test(body) || body.startsWith('-')) return false;
      i = end + 3;
      continue;
    }
    const gt = text.indexOf('>', lt);
    if (gt < 0) return false;
    if (text[lt + 1] === '/') {
      let end = gt;
      while (end > lt + 2 && isWs(text[end - 1])) end--;
      if (!stack.length || stack.pop() !== text.slice(lt + 2, end)) return false;
    } else {
      const selfClosing = text[gt - 1] === '/';
      const name = tagOk(text.slice(lt + 1, selfClosing ? gt - 1 : gt));
      if (!name || (!stack.length && (roots++ > 0 || name !== 'svg'))) return false;
      if (!selfClosing) stack.push(name);
      else if (!stack.length) return false;
    }
    i = gt + 1;
  }
  return roots === 1 && stack.length === 0;
}

export const LOCALE_DIR = /(^|\/)(locales?|i18n|l10n|translations?|lang)\//i;
export const LOCALE_FORMATS = ['json', 'arb', 'yaml', 'yml', 'po', 'strings', 'xliff', 'xlf', 'ftl', 'properties'];
const PLACEHOLDER = /\{\{[^{}]*\}\}|\{[^{}]*\}|%(?:[1-9]\d*\$|\([^()]*\))?[-+ #0]*(?:[1-9]\d*)?(?:\.\d+)?[a-zA-Z@]|\$\{[^{}]*\}|\$t\([^()]*\)|@[:.][\w.:-]+|\$[A-Za-z_]\w*/g;
/** Never UI text: markup, an encoded character that could spell markup, a script or link scheme, a template literal. */
const NOT_TEXT = /[<>`]|&(?:lt|gt|#)|\\[^nt"']|%\(/i;
/** A link scheme or a protocol-relative link, read after escapes, whitespace and control characters are removed (a URL parser drops them). */
const LINK = /(?:javascript|vbscript|data):|\/\//i;
/** YAML plain scalars that load as null, a boolean or a number, not a string. */
const YAML_NOT_STRING = /^(?:null|~|true|false|yes|no|on|off|y|n|[-+]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?|0x[0-9a-f]+|0o[0-7]+|[-+]?\.(?:inf|nan))$/i;
/** A locale code as a path segment or a part of the file name: en, fr, pt-BR, zh_Hant. */
const LOCALE_CODE = /^[a-z]{2}(?:[-_][A-Za-z]{2,4})?$/;
const LOCALE_ONLY_FORMATS = ['po', 'strings', 'xliff', 'xlf', 'arb', 'ftl'];
const YAML_PLAIN = /^[A-Za-z0-9][^#:{}[\]&*!|>%@`"'<\\]*$/;
const XLIFF_TARGET = /^(\s*<target(?:\s+state="[a-z-]+")?>)([^<]*)(<\/target>\s*)$/;
const FTL_ENTRY = /^(\s*[.-]?[A-Za-z][\w-]*\s*=\s*)(\S.*)$/;
const PROPERTIES_ENTRY = /^(\s*[A-Za-z0-9_.-]+\s*[=:]\s*)(\S.*)$/;

const skipWs = (s: string, k: number) => { while (s[k] === ' ' || s[k] === '\t') k++; return k; };
/** The index of the quote that closes a string opened before k, or -1; a backslash escapes the next character, or, doubled, two quotes stand for one (YAML single quotes). */
function closeQuote(s: string, k: number, q: string, doubled = false): number {
  while (k < s.length) {
    if (doubled && s[k] === q && s[k + 1] === q) k += 2;
    else if (s[k] === q) return k;
    else k += !doubled && s[k] === '\\' ? 2 : 1;
  }
  return -1;
}
type Entry = { key: string; value: string } | null;
/** "<key>" <sep> "<value>" <tail>: the JSON, ARB and Apple .strings line shape. */
function quotedPair(line: string, sep: string, tail: RegExp): Entry {
  let k = skipWs(line, 0);
  if (line[k] !== '"') return null;
  k = closeQuote(line, k + 1, '"');
  if (k < 0) return null;
  k = skipWs(line, k + 1);
  if (line[k] !== sep) return null;
  k = skipWs(line, k + 1);
  if (line[k] !== '"') return null;
  const end = closeQuote(line, k + 1, '"');
  if (end < 0 || !tail.test(line.slice(end + 1))) return null;
  return { key: line.slice(0, k + 1) + '\0' + line.slice(end), value: line.slice(k + 1, end) };
}
function yamlPair(line: string): Entry {
  const start = skipWs(line, 0);
  let k = start;
  const q = line[k];
  if (q === '"' || q === "'") k = closeQuote(line, k + 1, q, q === "'") + 1;
  else while (k < line.length && /[\w.-]/.test(line[k]!)) k++;
  if (k <= start || line[k] !== ':' || (line[k + 1] !== ' ' && line[k + 1] !== '\t')) return null;
  k = skipWs(line, k + 1);
  const v = line[k];
  let end = line.length;
  while (end > k && isWs(line[end - 1])) end--;
  if (v === '"' || v === "'") {
    const close = closeQuote(line, k + 1, v, v === "'");
    if (close !== end - 1) return null;
    return { key: line.slice(0, k + 1) + '\0' + line.slice(close), value: line.slice(k + 1, close) };
  }
  const plain = line.slice(k, end);
  return YAML_PLAIN.test(plain) && !YAML_NOT_STRING.test(plain) ? { key: line.slice(0, k), value: plain } : null;
}
function poPair(line: string): Entry {
  const m = /^msgstr(?:\[\d+\])? "/.exec(line);
  if (!m) return null;
  const end = closeQuote(line, m[0].length, '"');
  return end >= 0 && /^\s*$/.test(line.slice(end + 1)) ? { key: m[0] + '\0' + line.slice(end), value: line.slice(m[0].length, end) } : null;
}
function regexPair(line: string, r: RegExp): Entry {
  const m = r.exec(line);
  return m ? { key: m[1]! + '\0' + (m[3] ?? ''), value: m[2]! } : null;
}
function entryOf(format: string, line: string): Entry {
  switch (format) {
    case 'json': case 'arb': return quotedPair(line, ':', /^\s*,?\s*$/);
    case 'strings': return quotedPair(line, '=', /^\s*;\s*$/);
    case 'yaml': case 'yml': return yamlPair(line);
    case 'po': return poPair(line);
    case 'xliff': case 'xlf': return regexPair(line, XLIFF_TARGET);
    case 'ftl': return regexPair(line, FTL_ENTRY);
    case 'properties': return /\\\s*$/.test(line) ? null : regexPair(line, PROPERTIES_ENTRY);
  }
  return null;
}
/** The value's placeholders, sorted, or null when it is not plain text (markup, an encoded character, a scheme, an unpaired brace). */
function placeholders(value: string): string | null {
  if (NOT_TEXT.test(value) || LINK.test(value.replace(/\\[nt]|[\s\0-\x1f]/g, ''))) return null;
  const found = value.match(PLACEHOLDER) ?? [];
  if (/[{}]/.test(value.replace(PLACEHOLDER, ''))) return null;
  return found.sort().join('\0');
}

/** The resource format of a path under a locale directory, or null; JSON, YAML and .properties also need a locale code as the parent directory, the file stem or the stem's last . or _ part. */
export function localeFormat(p: string): string | null {
  const ext = /\.([A-Za-z]+)$/.exec(p)?.[1]?.toLowerCase();
  if (!ext || !LOCALE_FORMATS.includes(ext) || !LOCALE_DIR.test(p)) return null;
  const parts = p.split('/');
  const stem = parts[parts.length - 1]!.slice(0, -ext.length - 1);
  return LOCALE_ONLY_FORMATS.includes(ext) || [parts[parts.length - 2] ?? '', stem, stem.split(/[._]/).pop()!].some(s => LOCALE_CODE.test(s)) ? ext : null;
}

/** Whether an edit to a locale resource changes only literal string values: lines pair up with the same key and a changed value (an unchanged pair is a moved key), and each value is plain text with the same placeholders. */
export function localeTextOnly(p: string, removed: readonly string[] = [], added: readonly string[] = []): boolean {
  const format = localeFormat(p);
  if (!format || !added.length || removed.length !== added.length) return false;
  return removed.every((line, n) => {
    const a = entryOf(format, line), b = entryOf(format, added[n]!);
    if (!a || !b || a.key !== b.key || a.value === b.value) return false;
    const ha = placeholders(a.value);
    return ha !== null && ha === placeholders(b.value);
  });
}

/** A hash of the lists and patterns that decide an allowlisted docs path; lib/review-depth.ts folds it into DEPTH_RULES. */
export const ALLOWLIST_RULES = createHash('sha256').update(JSON.stringify({
  SVG_ELEMENTS, SVG_ATTRIBUTES, SVG_NS, LOCALE_FORMATS,
  LOCALE_ONLY_FORMATS,
  patterns: [XML_DECL, NAMED_ENTITY, LINK, YAML_NOT_STRING, LOCALE_CODE, FRAGMENT, LOCAL_URL, STYLE_VALUE, LOCALE_DIR, PLACEHOLDER, NOT_TEXT, YAML_PLAIN, XLIFF_TARGET, FTL_ENTRY, PROPERTIES_ENTRY].map(r => '/' + r.source + '/' + r.flags),
})).digest('hex').slice(0, 16);
