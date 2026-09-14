// Lone Unicode surrogate sanitization.
//
// Lone surrogates (\uD800-\uDFFF without a matching pair) are valid UTF-16
// but invalid UTF-8, so JSON.stringify produces output the Claude API rejects
// with HTTP 400 "no low surrogate in string". Page captures from real-world
// HTML hit this when content contains broken emoji bytes or mid-emoji splits.
//
// Two sanitizers are needed because both forms appear in browse responses:
//   - Raw UTF-16 surrogates in text/plain bodies (pre-stringify state).
//   - JSON \uXXXX escape sequences after JSON.stringify already ran.
// Both replace lone surrogates with U+FFFD (replacement character).

const LONE_SURROGATE_HIGH = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g;
const LONE_SURROGATE_LOW = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function stripLoneSurrogates(s: string): string {
  return s.replace(LONE_SURROGATE_HIGH, '�').replace(LONE_SURROGATE_LOW, '�');
}

/**
 * JSON.stringify replacer that strips lone UTF-16 surrogates from string
 * values before they get escape-encoded. Pair with stringify when the
 * consumer will JSON.parse the payload back into JS strings (SSE clients
 * do this). Required at every JSON/SSE egress that ships page-content-derived
 * fields — see CLAUDE.md "Unicode sanitization at server egress".
 *
 * The replacer must run INSIDE the encoding pipeline: post-stringify regex
 * is a no-op because JSON.stringify has already converted \uD800 into the
 * literal escape text "\\ud800" before a regex could see the surrogate.
 */
export function sanitizeReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'string' ? stripLoneSurrogates(value) : value;
}

// Matches \uD8XX-\uDFXX escape text where the pair is not completed by an
// adjacent \uDC00-\uDFFF (high) or preceded by \uD800-\uDBFF (low).
const LONE_SURROGATE_HIGH_ESCAPE = /\\u[Dd][89ABab][0-9A-Fa-f]{2}(?!\\u[Dd][C-Fc-f][0-9A-Fa-f]{2})/g;
const LONE_SURROGATE_LOW_ESCAPE = /(?<!\\u[Dd][89ABab][0-9A-Fa-f]{2})\\u[Dd][C-Fc-f][0-9A-Fa-f]{2}/g;

export function stripLoneSurrogateEscapes(s: string): string {
  return s.replace(LONE_SURROGATE_HIGH_ESCAPE, '\\uFFFD').replace(LONE_SURROGATE_LOW_ESCAPE, '\\uFFFD');
}

// Pick the right sanitizer based on whether the body has already been JSON-stringified.
// For application/json bodies, run both passes: raw first (in case the JSON encoder
// emitted surrogates as-is rather than escaping), then escape-text.
export function sanitizeBody(body: string, isJson: boolean): string {
  return isJson ? stripLoneSurrogateEscapes(stripLoneSurrogates(body)) : stripLoneSurrogates(body);
}
