/**
 * UTF-8 stream decoder for child-process stdout/stderr.
 *
 * Per-chunk `Buffer.toString('utf8')` corrupts multi-byte characters
 * (Korean, Japanese, Chinese, emoji, etc.) when a code-point straddles a
 * chunk boundary — the partial bytes decode to U+FFFD and the next chunk
 * starts mid-sequence. StringDecoder buffers partial code units across
 * chunks so decoded strings round-trip the original bytes.
 *
 * Pure ASCII streams are unaffected: every byte is a complete code point.
 *
 * This is a thin wrapper around the built-in StringDecoder rather than a
 * direct usage at the call site so the contract (write/end) can be
 * unit-tested in isolation — see browse/test/utf8-stream-decoder.test.ts,
 * which splits multi-byte text at every byte offset to pin the behavior.
 */

import { StringDecoder } from 'string_decoder';

export function createUtf8StreamDecoder(): {
  write(chunk: Buffer): string;
  end(): string;
} {
  const decoder = new StringDecoder('utf8');
  return {
    write: (chunk) => decoder.write(chunk),
    end: () => decoder.end(),
  };
}
