/**
 * Tests for lib/llm-summarize.ts — mock fetch, no API calls.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { summarizeSession } from '../lib/llm-summarize';

// Use a temp dir for cache so tests don't pollute real cache
const tmpCacheDir = path.join(os.tmpdir(), `gstack-llm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);

function makeOkResponse(text: string) {
  return new Response(JSON.stringify({
    content: [{ type: 'text', text }],
    usage: { input_tokens: 100, output_tokens: 20 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

// Each test gets unique messages to avoid cache collisions
let testCounter = 0;
function uniqueMessages(base: string = 'test') {
  testCounter++;
  return [
    { display: `${base} prompt ${testCounter} alpha`, timestamp: 1710000000000 + testCounter },
    { display: `${base} prompt ${testCounter} beta`, timestamp: 1710000060000 + testCounter },
  ];
}

describe('summarizeSession', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalApiKey: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalApiKey = process.env.ANTHROPIC_API_KEY;
    // Use temp cache dir and bypass cache for clean tests
    process.env.GSTACK_STATE_DIR = tmpCacheDir;
    process.env.EVAL_CACHE = '0'; // Skip cache reads
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalApiKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
    delete process.env.EVAL_CACHE;
  });

  test('returns null when ANTHROPIC_API_KEY not set', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const result = await summarizeSession(uniqueMessages(), ['Edit']);
    expect(result).toBeNull();
  });

  test('returns null for empty messages', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const result = await summarizeSession([], ['Edit']);
    expect(result).toBeNull();
  });

  test('returns summary on successful API call', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    globalThis.fetch = (() => Promise.resolve(makeOkResponse('Fixed login page CSS.'))) as any;

    const result = await summarizeSession(uniqueMessages('success'), ['Edit', 'Bash']);
    expect(result).toBe('Fixed login page CSS.');
  });

  test('sends correct headers to Anthropic API', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key-123';
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = ((url: string, init: any) => {
      for (const [k, v] of Object.entries(init.headers || {})) {
        capturedHeaders[k] = v as string;
      }
      return Promise.resolve(makeOkResponse('Summary.'));
    }) as any;

    await summarizeSession(uniqueMessages('headers'), null);
    expect(capturedHeaders['x-api-key']).toBe('test-key-123');
    expect(capturedHeaders['anthropic-version']).toBe('2023-06-01');
    expect(capturedHeaders['Content-Type']).toBe('application/json');
  });

  test('retries on 429 with retry-after header', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    let callCount = 0;
    globalThis.fetch = (() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(new Response('', {
          status: 429,
          headers: { 'retry-after': '0' },
        }));
      }
      return Promise.resolve(makeOkResponse('Retry succeeded.'));
    }) as any;

    const result = await summarizeSession(uniqueMessages('retry429'), null);
    expect(result).toBe('Retry succeeded.');
    expect(callCount).toBe(2);
  });

  test('retries on 5xx with backoff', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    let callCount = 0;
    globalThis.fetch = (() => {
      callCount++;
      if (callCount <= 2) {
        return Promise.resolve(new Response('Server Error', { status: 500 }));
      }
      return Promise.resolve(makeOkResponse('Recovered.'));
    }) as any;

    const result = await summarizeSession(uniqueMessages('retry5xx'), ['Read']);
    expect(result).toBe('Recovered.');
    expect(callCount).toBe(3);
  });

  test('returns null on persistent 429', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    globalThis.fetch = (() => Promise.resolve(new Response('', {
      status: 429,
      headers: { 'retry-after': '0' },
    }))) as any;

    const result = await summarizeSession(uniqueMessages('persistent429'), null);
    expect(result).toBeNull();
  });

  test('returns null on 401 without retry', async () => {
    process.env.ANTHROPIC_API_KEY = 'bad-key';
    let callCount = 0;
    globalThis.fetch = (() => {
      callCount++;
      return Promise.resolve(new Response('Unauthorized', { status: 401 }));
    }) as any;

    const result = await summarizeSession(uniqueMessages('auth401'), null);
    expect(result).toBeNull();
    expect(callCount).toBe(1);
  });

  test('returns null on malformed API response', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    globalThis.fetch = (() => Promise.resolve(new Response(
      JSON.stringify({ content: [{ type: 'image', source: {} }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))) as any;

    const result = await summarizeSession(uniqueMessages('malformed'), null);
    expect(result).toBeNull();
  });

  test('truncates long summaries to 500 chars', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const longText = 'a'.repeat(600);
    globalThis.fetch = (() => Promise.resolve(makeOkResponse(longText))) as any;

    const result = await summarizeSession(uniqueMessages('longtext'), null);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(500);
  });
});
