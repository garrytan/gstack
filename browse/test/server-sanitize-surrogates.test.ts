import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

// The sanitizer used to be module-private in server.ts (extracted here via a
// regex slice + eval). It now lives in sanitize.ts as the single source of
// truth for server.ts, sse-helpers.ts, and the read/snapshot pipeline — so
// this suite imports the canonical export and pins the server.ts wiring.
import { stripLoneSurrogates as sanitizeLoneSurrogates } from '../src/sanitize';

const SERVER_PATH = path.resolve(import.meta.dir, '..', 'src', 'server.ts');
const SERVER_SRC = fs.readFileSync(SERVER_PATH, 'utf-8');

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
    expect(SERVER_SRC).toContain('result: stripLoneSurrogates(cr.result)');
  });

  test('SSE activity feed routes outbound frames through createSseEndpoint', () => {
    // v1.51 refactor: /activity/stream no longer inlines its own
    // ReadableStream/sanitizer wiring; it routes through createSseEndpoint
    // which applies sanitizeReplacer to every JSON.stringify. The grep
    // pins both halves of the contract: the endpoint uses the helper,
    // and the helper does the sanitization.
    const activityBlock = SERVER_SRC.match(
      /if \(url\.pathname === '\/activity\/stream'\)[\s\S]*?createSseEndpoint\(/,
    );
    expect(activityBlock).not.toBeNull();
  });

  test('SSE inspector stream routes outbound frames through createSseEndpoint', () => {
    // Same v1.51 refactor invariant for /inspector/events.
    const inspectorBlock = SERVER_SRC.match(
      /if \(url\.pathname === '\/inspector\/events'[\s\S]*?createSseEndpoint\(/,
    );
    expect(inspectorBlock).not.toBeNull();
  });

  test('createSseEndpoint applies sanitizeReplacer to every JSON.stringify', () => {
    // The helper is the single source of truth for SSE sanitization now.
    // If a future refactor moves stringify off the replacer (e.g. someone
    // adds a fast-path encode), this test fails and the surrogate-escape
    // class regresses across every SSE endpoint at once.
    const helperPath = path.resolve(import.meta.dir, '..', 'src', 'sse-helpers.ts');
    const helperSrc = fs.readFileSync(helperPath, 'utf-8');
    expect(helperSrc).toContain('JSON.stringify(');
    expect(helperSrc).toContain('sanitizeReplacer');
    // The replacer is the canonical export from sanitize.ts — not a private
    // copy. Re-confirms the helper is wired to the canonical sanitizer, not
    // a drift'd duplicate.
    expect(helperSrc).toContain("import { sanitizeReplacer } from './sanitize'");
  });

  test('sanitizeReplacer is the canonical export wrapping stripLoneSurrogates', () => {
    // Single source of truth: sanitize.ts defines the one replacer, and it
    // must wrap the shared stripLoneSurrogates (a fast-path rewrite that
    // stops sanitizing string values would regress every JSON egress at once).
    const sanitizePath = path.resolve(import.meta.dir, '..', 'src', 'sanitize.ts');
    const sanitizeSrc = fs.readFileSync(sanitizePath, 'utf-8');
    expect(sanitizeSrc).toContain('export function sanitizeReplacer(');
    expect(sanitizeSrc).toContain(
      "typeof value === 'string' ? stripLoneSurrogates(value) : value",
    );
  });

  test('server.ts imports sanitizeReplacer for non-SSE JSON egress and still uses it', () => {
    // server.ts used to define its own private sanitizeReplacer for the
    // non-SSE JSON egress paths (/pty-inject-scan, /memory snapshot, etc.).
    // It now imports the canonical one — and must still pass it at those
    // JSON.stringify egress sites.
    expect(SERVER_SRC).toMatch(/import \{[^}]*sanitizeReplacer[^}]*\} from '\.\/sanitize'/);
    expect(SERVER_SRC).not.toContain('function sanitizeReplacer(');
    expect(SERVER_SRC).toContain(', sanitizeReplacer)');
  });
});
