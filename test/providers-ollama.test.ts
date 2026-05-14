/**
 * Unit tests for OllamaAdapter (offline — no live daemon required).
 *
 * Stubs `globalThis.fetch` to assert request shape and response parsing
 * without depending on a running Ollama daemon. Live integration tests
 * would live in test/providers.e2e.test.ts (none present yet).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { OllamaAdapter } from './helpers/providers/ollama';

const REAL_FETCH = globalThis.fetch;
const REAL_OLLAMA_URL = process.env.GSTACK_OLLAMA_URL;
const REAL_OLLAMA_MODEL = process.env.GSTACK_OLLAMA_MODEL;

type FetchStub = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function stubFetch(impl: FetchStub): void {
  (globalThis as { fetch: FetchStub }).fetch = impl;
}

function restoreFetch(): void {
  (globalThis as { fetch: typeof REAL_FETCH }).fetch = REAL_FETCH;
}

describe('OllamaAdapter.available', () => {
  beforeEach(() => {
    delete process.env.GSTACK_OLLAMA_URL;
    delete process.env.GSTACK_OLLAMA_MODEL;
  });
  afterEach(() => {
    restoreFetch();
    if (REAL_OLLAMA_URL !== undefined) process.env.GSTACK_OLLAMA_URL = REAL_OLLAMA_URL;
    if (REAL_OLLAMA_MODEL !== undefined) process.env.GSTACK_OLLAMA_MODEL = REAL_OLLAMA_MODEL;
  });

  test('returns ok when daemon responds with at least one model', async () => {
    stubFetch(async () => new Response(JSON.stringify({ models: [{ name: 'qwen2.5-coder:7b' }] }), { status: 200 }));
    const adapter = new OllamaAdapter();
    const check = await adapter.available();
    expect(check.ok).toBe(true);
  });

  test('returns not-ok with remediation hint when daemon has no models', async () => {
    stubFetch(async () => new Response(JSON.stringify({ models: [] }), { status: 200 }));
    const adapter = new OllamaAdapter();
    const check = await adapter.available();
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/ollama pull/);
  });

  test('returns not-ok when daemon is unreachable', async () => {
    stubFetch(async () => { throw new Error('fetch failed: ECONNREFUSED'); });
    const adapter = new OllamaAdapter();
    const check = await adapter.available();
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/not reachable|Install|ollama serve/);
  });

  test('returns not-ok when daemon returns non-2xx', async () => {
    stubFetch(async () => new Response('Internal error', { status: 500 }));
    const adapter = new OllamaAdapter();
    const check = await adapter.available();
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/HTTP 500/);
  });

  test('honors GSTACK_OLLAMA_URL override', async () => {
    process.env.GSTACK_OLLAMA_URL = 'http://example.local:9999';
    let calledUrl = '';
    stubFetch(async (input) => {
      calledUrl = String(input);
      return new Response(JSON.stringify({ models: [{ name: 'foo' }] }), { status: 200 });
    });
    const adapter = new OllamaAdapter();
    await adapter.available();
    expect(calledUrl).toBe('http://example.local:9999/api/tags');
  });
});

describe('OllamaAdapter.run', () => {
  beforeEach(() => {
    delete process.env.GSTACK_OLLAMA_URL;
    delete process.env.GSTACK_OLLAMA_MODEL;
  });
  afterEach(() => {
    restoreFetch();
    if (REAL_OLLAMA_URL !== undefined) process.env.GSTACK_OLLAMA_URL = REAL_OLLAMA_URL;
    if (REAL_OLLAMA_MODEL !== undefined) process.env.GSTACK_OLLAMA_MODEL = REAL_OLLAMA_MODEL;
  });

  test('parses successful response into RunResult', async () => {
    stubFetch(async () => new Response(JSON.stringify({
      response: 'hello world',
      model: 'qwen2.5-coder:7b',
      prompt_eval_count: 12,
      eval_count: 34,
      done: true,
    }), { status: 200 }));
    const adapter = new OllamaAdapter();
    const res = await adapter.run({ prompt: 'hi', workdir: '/tmp', timeoutMs: 5000 });
    expect(res.output).toBe('hello world');
    expect(res.tokens.input).toBe(12);
    expect(res.tokens.output).toBe(34);
    expect(res.toolCalls).toBe(0);
    expect(res.modelUsed).toBe('qwen2.5-coder:7b');
    expect(res.error).toBeUndefined();
  });

  test('sends correct POST body to /api/generate', async () => {
    let capturedBody: unknown = null;
    let capturedUrl = '';
    stubFetch(async (input, init) => {
      capturedUrl = String(input);
      capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(JSON.stringify({ response: '', eval_count: 0, prompt_eval_count: 0 }), { status: 200 });
    });
    const adapter = new OllamaAdapter();
    await adapter.run({ prompt: 'test prompt', workdir: '/tmp', timeoutMs: 5000, model: 'llama3.2:3b' });
    expect(capturedUrl).toBe('http://localhost:11434/api/generate');
    expect(capturedBody).toEqual({ model: 'llama3.2:3b', prompt: 'test prompt', stream: false });
  });

  test('uses default model when none specified', async () => {
    let capturedModel = '';
    stubFetch(async (_input, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      capturedModel = body.model;
      return new Response(JSON.stringify({ response: '', eval_count: 0, prompt_eval_count: 0 }), { status: 200 });
    });
    const adapter = new OllamaAdapter();
    await adapter.run({ prompt: 'x', workdir: '/tmp', timeoutMs: 5000 });
    expect(capturedModel).toBe('qwen2.5-coder:7b');
  });

  test('honors GSTACK_OLLAMA_MODEL override', async () => {
    process.env.GSTACK_OLLAMA_MODEL = 'custom-model:13b';
    let capturedModel = '';
    stubFetch(async (_input, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      capturedModel = body.model;
      return new Response(JSON.stringify({ response: '', eval_count: 0, prompt_eval_count: 0 }), { status: 200 });
    });
    const adapter = new OllamaAdapter();
    await adapter.run({ prompt: 'x', workdir: '/tmp', timeoutMs: 5000 });
    expect(capturedModel).toBe('custom-model:13b');
  });

  test('returns binary_missing error on ECONNREFUSED', async () => {
    stubFetch(async () => { throw new Error('fetch failed: ECONNREFUSED'); });
    const adapter = new OllamaAdapter();
    const res = await adapter.run({ prompt: 'x', workdir: '/tmp', timeoutMs: 5000 });
    expect(res.error?.code).toBe('binary_missing');
    expect(res.error?.reason).toMatch(/ollama serve/);
    expect(res.output).toBe('');
  });

  test('returns unknown error with helpful message on 404 (model not pulled)', async () => {
    stubFetch(async () => new Response('model "missing" not found', { status: 404 }));
    const adapter = new OllamaAdapter();
    const res = await adapter.run({ prompt: 'x', workdir: '/tmp', timeoutMs: 5000, model: 'missing' });
    expect(res.error?.code).toBe('unknown');
    expect(res.error?.reason).toMatch(/ollama pull missing/);
  });

  test('returns timeout error when fetch is aborted', async () => {
    stubFetch(async (_input, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')));
      });
    });
    const adapter = new OllamaAdapter();
    const res = await adapter.run({ prompt: 'x', workdir: '/tmp', timeoutMs: 50 });
    expect(res.error?.code).toBe('timeout');
  });
});

describe('OllamaAdapter.estimateCost', () => {
  test('returns 0 for known Ollama models', () => {
    const adapter = new OllamaAdapter();
    expect(adapter.estimateCost({ input: 1_000_000, output: 500_000 }, 'qwen2.5-coder:7b')).toBe(0);
    expect(adapter.estimateCost({ input: 1_000_000, output: 500_000 }, 'llama3.2:3b')).toBe(0);
  });
});

describe('OllamaAdapter identity', () => {
  test('exposes stable name and family', () => {
    const adapter = new OllamaAdapter();
    expect(adapter.name).toBe('ollama');
    expect(adapter.family).toBe('ollama');
  });
});
