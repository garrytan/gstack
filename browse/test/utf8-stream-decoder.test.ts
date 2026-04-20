/**
 * Regression tests for UTF-8 stream chunk-boundary handling.
 *
 * Background: sidebar-agent previously used per-chunk `Buffer.toString()` on
 * `proc.stdout` data events. When claude emitted non-ASCII text (Korean,
 * Japanese, Chinese, emoji), a multi-byte character that happened to land on
 * a chunk boundary would be mojibake'd — e.g. Korean "합니다" rendered as
 * "핣니다" in the sidebar. These tests pin the fix: chunks split at every
 * byte offset must reassemble to the original string.
 */

import { describe, test, expect } from 'bun:test';
import { createUtf8StreamDecoder } from '../src/utf8-stream-decoder';

function feedSplit(input: Buffer, splitAt: number): string {
  const decoder = createUtf8StreamDecoder();
  let out = decoder.write(input.subarray(0, splitAt));
  out += decoder.write(input.subarray(splitAt));
  out += decoder.end();
  return out;
}

describe('createUtf8StreamDecoder', () => {
  test('preserves Korean text split at every byte boundary', () => {
    // Each Hangul syllable is 3 bytes in UTF-8, so every non-zero offset
    // inside a syllable is a boundary the naive .toString() fix must survive.
    const text = '안녕하세요 합니다';
    const buf = Buffer.from(text, 'utf8');
    for (let i = 0; i <= buf.length; i++) {
      expect(feedSplit(buf, i)).toBe(text);
    }
  });

  test('preserves 4-byte emoji split at every byte boundary', () => {
    const text = 'hi 👋 there 🎉 done';
    const buf = Buffer.from(text, 'utf8');
    for (let i = 0; i <= buf.length; i++) {
      expect(feedSplit(buf, i)).toBe(text);
    }
  });

  test('preserves Japanese and Chinese mix across chunks', () => {
    const text = 'こんにちは 你好 世界';
    const buf = Buffer.from(text, 'utf8');
    for (let i = 0; i <= buf.length; i++) {
      expect(feedSplit(buf, i)).toBe(text);
    }
  });

  test('never emits the U+FFFD replacement char for valid UTF-8', () => {
    const text = '핣'.repeat(100); // dense Korean
    const buf = Buffer.from(text, 'utf8');
    for (let i = 0; i <= buf.length; i++) {
      expect(feedSplit(buf, i)).not.toContain('\uFFFD');
    }
  });

  test('handles many tiny chunks (one byte at a time)', () => {
    const text = 'stream 안녕 🎉 end';
    const buf = Buffer.from(text, 'utf8');
    const decoder = createUtf8StreamDecoder();
    let out = '';
    for (let i = 0; i < buf.length; i++) {
      out += decoder.write(buf.subarray(i, i + 1));
    }
    out += decoder.end();
    expect(out).toBe(text);
  });

  test('ASCII-only input is unaffected', () => {
    const text = '{"type":"text","content":"hello world"}\n';
    const buf = Buffer.from(text, 'utf8');
    for (let i = 0; i <= buf.length; i++) {
      expect(feedSplit(buf, i)).toBe(text);
    }
  });

  test('end() flushes trailing partial sequence as replacement char', () => {
    // If the stream truncates mid-character (process killed), end() should
    // not hold bytes indefinitely. StringDecoder emits U+FFFD for the
    // incomplete tail — acceptable: we prefer a visible marker over lost data.
    const decoder = createUtf8StreamDecoder();
    const partial = Buffer.from('안', 'utf8').subarray(0, 2); // 2 of 3 bytes
    const mid = decoder.write(partial);
    const flushed = decoder.end();
    expect(mid + flushed).toContain('\uFFFD');
  });
});
