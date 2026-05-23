import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

// The sanitizer is module-private in server.ts. Rather than refactor it to a
// separate module just for testing, we extract its source via a regex slice and
// eval it in a fresh function scope. Keeps the production layout untouched.
const SERVER_PATH = path.resolve(import.meta.dir, '..', 'src', 'server.ts');
const SERVER_SRC = fs.readFileSync(SERVER_PATH, 'utf-8');

const fnMatch = SERVER_SRC.match(
  /function sanitizeLoneSurrogates\(str: string\): string \{[\s\S]*?\n\}/
);
if (!fnMatch) throw new Error('Could not locate sanitizeLoneSurrogates in server.ts');

// Strip TS annotations so eval works under plain JS.
const jsSrc = fnMatch[0].replace('(str: string): string', '(str)');
const sanitizeLoneSurrogates = new Function(`${jsSrc}\nreturn sanitizeLoneSurrogates;`)() as (
  s: string,
) => string;

describe('sanitizeLoneSurrogates — unit cases', () => {
  test('passthrough ASCII', () => {
    expect(sanitizeLoneSurrogates('hello')).toBe('hello');
  });

  test('passthrough empty string', () => {
    expect(sanitizeLoneSurrogates('')).toBe('');
  });

  test('preserves valid surrogate pair (U+1F389 🎉)', () => {
    expect(sanitizeLoneSurrogates('hi 🎉')).toBe('hi 🎉');
  });

  test('replaces lone high surrogate mid-string', () => {
    expect(sanitizeLoneSurrogates('a\uD800b')).toBe('a�b');
  });

  test('replaces lone low surrogate mid-string', () => {
    expect(sanitizeLoneSurrogates('a\uDC00b')).toBe('a�b');
  });

  test('replaces trailing lone high at end of string', () => {
    expect(sanitizeLoneSurrogates('a\uD800')).toBe('a�');
  });

  test('replaces leading lone low at start of string', () => {
    expect(sanitizeLoneSurrogates('\uDC00b')).toBe('�b');
  });

  test('replaces two adjacent lone highs', () => {
    expect(sanitizeLoneSurrogates('\uD800\uD800')).toBe('��');
  });

  test('replaces two adjacent lone lows', () => {
    expect(sanitizeLoneSurrogates('\uDC00\uDC00')).toBe('��');
  });

  test('preserves valid pair followed by lone low', () => {
    // 𐀀 = U+10000 = 𐀀, then a separate lone low.
    const input = '𐀀\uDC00';
    const output = sanitizeLoneSurrogates(input);
    // Valid pair intact, trailing lone low replaced.
    expect(output).toBe('𐀀�');
  });

  test('preserves valid pair preceded by lone low', () => {
    const input = '\uDC00𐀀';
    const output = sanitizeLoneSurrogates(input);
    expect(output).toBe('�𐀀');
  });
});

describe('sanitizeLoneSurrogates — bug-repro (D5)', () => {
  // Pin the regression intent: a future refactor that drops sanitization
  // must fail this test even if happy-path tests still pass.
  test('unsanitized lone surrogate causes UTF-8 encode to substitute, sanitized version is stable', () => {
    const badPayload = 'page content\uD800more content';

    // Buffer.from(str, 'utf-8') silently substitutes invalid sequences with
    // EF BF BD (U+FFFD). Round-trip is therefore lossy for lone surrogates.
    const roundTrippedRaw = Buffer.from(badPayload, 'utf-8').toString('utf-8');
    expect(roundTrippedRaw).not.toBe(badPayload); // proves the bug exists pre-sanitize

    // After sanitization the round-trip is stable.
    const sanitized = sanitizeLoneSurrogates(badPayload);
    const roundTrippedSanitized = Buffer.from(sanitized, 'utf-8').toString('utf-8');
    expect(roundTrippedSanitized).toBe(sanitized);
  });

  test('JSON.parse(JSON.stringify(...)) round-trip is stable after sanitization', () => {
    // Anthropic's API path wraps the response body in a tool_result JSON
    // object. JSON.stringify CAN encode a lone surrogate (escapes it), but
    // some downstream consumers reject the resulting body.
    const badPayload = 'before\uD800after';
    const sanitized = sanitizeLoneSurrogates(badPayload);
    const wrapped = JSON.stringify({ content: sanitized });
    const reparsed = JSON.parse(wrapped) as { content: string };
    // .toBe(sanitized) already proves the surrogate was replaced; the
    // additional explicit check below documents the specific code points.
    expect(reparsed.content).toBe(sanitized);
    expect(reparsed.content.charCodeAt(6)).toBe(0xfffd); // � not \uD800
  });
});

describe('sanitizeLoneSurrogates — wiring invariants', () => {
  test('server.ts wraps every command result through handleCommandInternal', () => {
    // The architectural choice is to wrap once at handleCommandInternal so
    // both single-command HTTP and the batch loop inherit. If a future
    // refactor moves sanitization back to handleCommand only, this test
    // fails by detecting the missing wrapper.
    expect(SERVER_SRC).toContain('async function handleCommandInternalImpl(');
    expect(SERVER_SRC).toContain('result: sanitizeLoneSurrogates(cr.result)');
  });

  test('SSE activity feed sanitizes outbound frames via sanitizeReplacer', () => {
    // Replacer must run DURING stringify; post-stringify regex is ineffective
    // because JSON.stringify converts \uD800 → "\\ud800" before our regex sees it.
    expect(SERVER_SRC).toContain('JSON.stringify(entry, sanitizeReplacer)');
  });

  test('SSE inspector stream sanitizes outbound frames via sanitizeReplacer', () => {
    expect(SERVER_SRC).toContain('JSON.stringify(event, sanitizeReplacer)');
  });

  test('sanitizeReplacer is a function defined in server.ts', () => {
    expect(SERVER_SRC).toContain('function sanitizeReplacer(');
  });
});
