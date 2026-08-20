// Unit tests for browse/src/sanitize.ts (#1440).
// Covers stripLoneSurrogates (raw UTF-16) and stripLoneSurrogateEscapes
// (\uXXXX escape text) used by the response chokepoints.

import { describe, expect, test } from 'bun:test';
import { stripLoneSurrogates, stripLoneSurrogateEscapes, sanitizeBody } from '../src/sanitize';

describe('stripLoneSurrogates', () => {
  test('replaces lone high surrogate with U+FFFD', () => {
    const lone = '\uD800x';
    const out = stripLoneSurrogates(lone);
    expect(out).toBe('�x');
  });

  test('replaces lone low surrogate with U+FFFD', () => {
    const lone = 'x\uDC00';
    expect(stripLoneSurrogates(lone)).toBe('x�');
  });

  test('leaves valid surrogate pairs (emoji) unchanged', () => {
    const smiley = '😀'; // U+1F600 = 😀
    expect(stripLoneSurrogates(smiley)).toBe(smiley);
  });

  test('empty string is unchanged', () => {
    expect(stripLoneSurrogates('')).toBe('');
  });

  test('mixed valid + lone surrogates', () => {
    const input = `a\uD800b😀c\uDC00d`;
    const out = stripLoneSurrogates(input);
    expect(out).toBe(`a�b😀c�d`);
  });

  test('clean text passes through unchanged', () => {
    const text = 'The quick brown fox jumps over 13 lazy dogs.';
    expect(stripLoneSurrogates(text)).toBe(text);
  });

  test('high surrogate immediately followed by high surrogate replaces both individually', () => {
    const input = '\uD800\uD801'; // two lone highs in a row, neither paired
    const out = stripLoneSurrogates(input);
    expect(out).toBe('��');
  });
});

describe('stripLoneSurrogateEscapes', () => {
  test('replaces lone high surrogate ESCAPE with \\uFFFD', () => {
    const json = '{"name":"\\uD800"}';
    expect(stripLoneSurrogateEscapes(json)).toBe('{"name":"\\uFFFD"}');
  });

  test('replaces lone low surrogate ESCAPE with \\uFFFD', () => {
    const json = '{"name":"\\uDC00"}';
    expect(stripLoneSurrogateEscapes(json)).toBe('{"name":"\\uFFFD"}');
  });

  test('leaves valid escape pair unchanged', () => {
    // 😀 = 😀 — must NOT be touched
    const json = '{"emoji":"\\uD83D\\uDE00"}';
    expect(stripLoneSurrogateEscapes(json)).toBe(json);
  });

  test('mixed escape pairs and lone escapes', () => {
    const json = '{"a":"\\uD800","b":"\\uD83D\\uDE00","c":"\\uDC00"}';
    expect(stripLoneSurrogateEscapes(json)).toBe('{"a":"\\uFFFD","b":"\\uD83D\\uDE00","c":"\\uFFFD"}');
  });

  test('clean JSON passes through unchanged', () => {
    const json = '{"results":[{"status":200,"command":"text"}]}';
    expect(stripLoneSurrogateEscapes(json)).toBe(json);
  });

  test('case-insensitive matching: \\uD8aa works like \\uD8AA', () => {
    expect(stripLoneSurrogateEscapes('\\uD8aa')).toBe('\\uFFFD');
  });
});

describe('sanitizeBody', () => {
  test('text/plain body: applies raw-surrogate strip only', () => {
    const input = `pre\uD800post`;
    expect(sanitizeBody(input, false)).toBe(`pre�post`);
  });

  test('JSON body: applies both raw and escape passes', () => {
    // Both raw and escape variants in the same body
    const input = `{"raw":"\uD800","esc":"\\uD800"}`;
    const out = sanitizeBody(input, true);
    expect(out).toBe(`{"raw":"�","esc":"\\uFFFD"}`);
  });

  test('clean text/plain body unchanged', () => {
    const text = 'Hello world\nLine 2';
    expect(sanitizeBody(text, false)).toBe(text);
  });

  test('clean JSON body unchanged', () => {
    const json = '{"ok":true}';
    expect(sanitizeBody(json, true)).toBe(json);
  });
});

describe('perf smoke', () => {
  test('1MB of clean text sanitizes in <500ms', () => {
    const big = 'A'.repeat(1024 * 1024);
    const start = performance.now();
    const out = stripLoneSurrogates(big);
    const elapsed = performance.now() - start;
    expect(out.length).toBe(big.length);
    expect(elapsed).toBeLessThan(500);
  });
});
