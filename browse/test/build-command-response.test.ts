// Unit test for buildCommandResponse — the exported response builder that
// sanitizes lone Unicode surrogates at the HTTP boundary (#1440, D7 + D13).
//
// The function is exported from server.ts specifically so we can test it
// without spinning up a Bun server. Codex flagged in D13 finding 14 that
// "mock cr.result" wasn't testable when handleCommand was the only entry
// point; this refactor solves that.

import { describe, expect, test } from 'bun:test';
import { buildCommandResponse } from '../src/server';

describe('buildCommandResponse', () => {
  test('sanitizes lone surrogates in text/plain body', async () => {
    const cr = { status: 200, result: `pre\uD800post`, json: false };
    const res = buildCommandResponse(cr as any);
    expect(res.headers.get('content-type')).toBe('text/plain');
    expect(await res.text()).toBe(`pre�post`);
  });

  test('sanitizes lone escape sequences in application/json body', async () => {
    // cr.result is already JSON-stringified by handleCommand callers when
    // cr.json=true. Surrogate escape sequences in the stringified form must
    // be neutralized.
    const cr = { status: 200, result: '{"name":"\\uD800"}', json: true };
    const res = buildCommandResponse(cr as any);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.text()).toBe('{"name":"\\uFFFD"}');
  });

  test('non-string cr.result passes through unchanged', async () => {
    // Some commands return Buffers or other ArrayBuffer-shaped bodies (e.g.
    // screenshots). Sanitizer must NOT touch them.
    const buf = new Uint8Array([1, 2, 3, 4]);
    const cr = { status: 200, result: buf, json: false };
    const res = buildCommandResponse(cr as any);
    // body returned verbatim; reading as array buffer should give same bytes
    const out = new Uint8Array(await res.arrayBuffer());
    expect(out.length).toBe(4);
    expect(out[0]).toBe(1);
    expect(out[3]).toBe(4);
  });

  test('clean text passes through unchanged', async () => {
    const cr = { status: 200, result: 'Hello, world!', json: false };
    const res = buildCommandResponse(cr as any);
    expect(await res.text()).toBe('Hello, world!');
  });

  test('status code propagates', async () => {
    const cr = { status: 404, result: 'Not found', json: false };
    const res = buildCommandResponse(cr as any);
    expect(res.status).toBe(404);
  });

  test('extra headers propagate', async () => {
    const cr = { status: 200, result: 'ok', json: false, headers: { 'X-Custom': 'value' } };
    const res = buildCommandResponse(cr as any);
    expect(res.headers.get('x-custom')).toBe('value');
  });

  test('JSON error body with lone surrogate is sanitized', async () => {
    // Errors set cr.json=true; a stringified error containing surrogates would
    // still crash the API without this sanitization.
    const cr = { status: 500, result: '{"error":"crash at \\uDC00 byte"}', json: true };
    const res = buildCommandResponse(cr as any);
    expect(await res.text()).toBe('{"error":"crash at \\uFFFD byte"}');
  });
});
