import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { callJudge } from './helpers/llm-judge';
import { WORKFLOW_JUDGE_RESPONSE_SCHEMA } from './helpers/workflow-judge-input';

const scores = { clarity: 4, completeness: 4, actionability: 4, reasoning: 'Complete workflow with explicit gates.' };
let originalKey: string | undefined;
let transport: ReturnType<typeof spyOn>;
let diagnostics: ReturnType<typeof spyOn>;
beforeEach(() => {
  originalKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-only-key';
  transport = spyOn(globalThis, 'fetch');
  diagnostics = spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  transport.mockRestore(); diagnostics.mockRestore();
  if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalKey;
});

function response(stopReason = 'end_turn', text: string | null = JSON.stringify(scores)) {
  const events = [
    { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-fable-5-1',
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 99023, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'PRIVATE_THINKING' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'PRIVATE_SIGNATURE' } },
    { type: 'content_block_stop', index: 0 },
    ...(text === null ? [] : [
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } },
      { type: 'content_block_stop', index: 1 },
    ]),
    { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 65536 } },
    { type: 'message_stop' },
  ];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } });
}

test('the pinned SDK refuses a default nonstreaming 64k request before network access', async () => {
  transport.mockImplementation(() => { throw new Error('Unexpected network access'); });
  await expect(callJudge('score the whole bundle', 'claude-fable-5-1', { max_tokens: 65_536 }))
    .rejects.toThrow('Streaming is required');
  expect(transport).not.toHaveBeenCalled();
});

test('effort reaches the wire beside the response schema and is absent unless requested', async () => {
  transport.mockImplementation(async () => response());
  await callJudge('score the whole bundle', 'claude-fable-5-1', {
    max_tokens: 65_536, stream: true, jsonSchema: WORKFLOW_JUDGE_RESPONSE_SCHEMA, effort: 'medium',
  });
  await callJudge('score the whole bundle', 'claude-fable-5-1', { max_tokens: 65_536, stream: true, effort: 'medium' });
  await callJudge('score the whole bundle', 'claude-fable-5-1', { max_tokens: 65_536, stream: true });
  const bodies = transport.mock.calls.map((call: any[]) => JSON.parse(call[1].body));
  expect(bodies[0].output_config).toEqual({ format: { type: 'json_schema', schema: WORKFLOW_JUDGE_RESPONSE_SCHEMA }, effort: 'medium' });
  expect(bodies[1].output_config).toEqual({ effort: 'medium' });
  expect(bodies[2]).not.toHaveProperty('output_config');
  for (const body of bodies) expect(body).not.toHaveProperty('thinking');
});

test('the real SDK streams 64k requests and parses only completed public text', async () => {
  transport.mockResolvedValue(response());
  expect(await callJudge('score the whole bundle', 'claude-fable-5-1', {
    max_tokens: 65_536, stream: true, jsonSchema: WORKFLOW_JUDGE_RESPONSE_SCHEMA,
  })).toEqual(scores);
  expect(transport).toHaveBeenCalledTimes(1);
  const request = transport.mock.calls[0][1];
  expect(JSON.parse(request.body)).toEqual({ model: 'claude-fable-5-1', max_tokens: 65_536,
    output_config: { format: { type: 'json_schema', schema: WORKFLOW_JUDGE_RESPONSE_SCHEMA } },
    messages: [{ role: 'user', content: 'score the whole bundle' }], stream: true });
  expect(new Headers(request.headers).has('anthropic-beta')).toBe(false);
  expect(diagnostics).not.toHaveBeenCalled();
});

test('streamed truncation and refusal retain public evidence but never partial scores or private thinking', async () => {
  for (const [stopReason, text] of [['max_tokens', '{"clarity":4'], ['max_tokens', null], ['refusal', null]] as const) {
    transport.mockResolvedValue(response(stopReason, text));
    await expect(callJudge('score the whole bundle', 'claude-fable-5-1', {
      max_tokens: 65_536, stream: true, jsonSchema: WORKFLOW_JUDGE_RESPONSE_SCHEMA,
    })).rejects.toThrow(stopReason === 'max_tokens' ? 'truncated at max_tokens=65536' : 'provider refused');
    const diagnostic = diagnostics.mock.calls.at(-1)![0];
    expect(diagnostic).not.toContain('PRIVATE_');
    expect(JSON.parse(diagnostic)).toMatchObject({ stopReason, textBlocks: text === null ? [] : [text] });
  }
});

test('streaming retains the caller abort signal instead of extending its deadline', async () => {
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  transport.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    started();
  }));
  const controller = new AbortController();
  const pending = callJudge('score the whole bundle', 'claude-fable-5-1', {
    max_tokens: 65_536, stream: true, jsonSchema: WORKFLOW_JUDGE_RESPONSE_SCHEMA, signal: controller.signal,
  });
  const failure = new Error('Original workflow walltime elapsed');
  const rejected = pending.catch(error => error);
  await ready;
  controller.abort(failure);
  expect(await rejected).toBe(failure);
  expect(transport).toHaveBeenCalledTimes(1);
});

test('a judge aborted mid-stream retains what it had received, as counts without content', async () => {
  const encoder = new TextEncoder();
  const partial = [
    { type: 'message_start', message: { id: 'msg_stalled', type: 'message', role: 'assistant', model: 'claude-fable-5-1',
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 99023, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'PRIVATE_THINKING' } },
  ];
  let delivered!: () => void;
  const received = new Promise<void>(resolve => { delivered = resolve; });
  transport.mockImplementation(async (_url: string, init: RequestInit) => {
    const chunks = partial.map(event => encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
    return new Response(new ReadableStream({
      start(stream) {
        init.signal!.addEventListener('abort', () => stream.error(init.signal!.reason), { once: true });
      },
      pull(stream) {
        const chunk = chunks.shift();
        if (chunk) stream.enqueue(chunk);
        else delivered();
      },
    }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream', 'request-id': 'req_stalled' } });
  });
  const controller = new AbortController();
  const rejected = callJudge('score the whole bundle', 'claude-fable-5-1', {
    max_tokens: 65_536, stream: true, jsonSchema: WORKFLOW_JUDGE_RESPONSE_SCHEMA, signal: controller.signal,
  }).catch(error => error);
  await received;
  const failure = new Error('ship/SKILL.md workflow exceeded its workflow judge work deadline');
  controller.abort(failure);
  expect(await rejected).toBe(failure);
  expect(diagnostics).toHaveBeenCalledTimes(1);
  const diagnostic = diagnostics.mock.calls[0]![0];
  expect(diagnostic).not.toContain('PRIVATE_');
  const event = JSON.parse(diagnostic);
  expect(event).toMatchObject({ type: 'llm-judge-aborted', model: 'claude-fable-5-1', stream: true, attempts: 1,
    httpRequests: 1, httpStatuses: [200], retryWaitsMs: [], block: 'thinking', thinkingChars: 'PRIVATE_THINKING'.length, textChars: 0,
    messageId: 'msg_stalled', requestId: 'req_stalled', reason: failure.message });
  expect(event.firstEventMs).toBeGreaterThanOrEqual(0);
  expect(event.lastEventMs).toBeGreaterThanOrEqual(event.firstEventMs); // gstack-timing-ok: ordering of two recorded offsets, not an elapsed-time bound
  expect(event.elapsedMs).toBeGreaterThanOrEqual(event.lastEventMs); // gstack-timing-ok: ordering of two recorded offsets, not an elapsed-time bound
});

test('a stream that never sent an event is retained as such, and provider errors without an abort are not', async () => {
  let sent!: () => void;
  const requested = new Promise<void>(resolve => { sent = resolve; });
  transport.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    sent();
  }));
  const controller = new AbortController();
  const rejected = callJudge('score', 'claude-fable-5-1', { max_tokens: 65_536, stream: true, signal: controller.signal }).catch(error => error);
  await requested;
  controller.abort(new Error('deadline'));
  await rejected;
  expect(JSON.parse(diagnostics.mock.calls[0]![0])).toMatchObject({ type: 'llm-judge-aborted', httpRequests: 1,
    httpStatuses: [], connectedMs: null, firstEventMs: null, lastEventMs: null, block: null, thinkingChars: 0, messageId: null, requestId: null, reason: 'deadline' });

  diagnostics.mockClear();
  transport.mockResolvedValue(new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'boom' } }),
    { status: 500, headers: { 'content-type': 'application/json', 'x-should-retry': 'false' } }));
  await expect(callJudge('score', 'claude-fable-5-1', { max_tokens: 65_536, stream: true, signal: new AbortController().signal })).rejects.toThrow();
  expect(diagnostics).not.toHaveBeenCalled();
});

test('a deadline after headers but before any event retains the connection and its request id', async () => {
  let reading!: () => void;
  const connected = new Promise<void>(resolve => { reading = resolve; });
  transport.mockImplementation(async (_url: string, init: RequestInit) => new Response(new ReadableStream({
    start(stream) { init.signal!.addEventListener('abort', () => stream.error(init.signal!.reason), { once: true }); },
    pull() { reading(); return new Promise<void>(() => {}); },
  }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream', 'request-id': 'req_quiet' } }));
  const controller = new AbortController();
  const rejected = callJudge('score', 'claude-fable-5-1', { max_tokens: 65_536, stream: true, signal: controller.signal }).catch(error => error);
  await connected;
  controller.abort(new Error('deadline'));
  await rejected;
  const event = JSON.parse(diagnostics.mock.calls[0]![0]);
  expect(event).toMatchObject({ httpRequests: 1, httpStatuses: [200], requestId: 'req_quiet', firstEventMs: null, block: null });
  expect(event.connectedMs).toBeGreaterThanOrEqual(0);
});

test('SDK-internal 429 retries are counted, so throttling never reads as a silent stream', async () => {
  let resent!: () => void;
  const retried = new Promise<void>(resolve => { resent = resolve; });
  transport.mockResolvedValueOnce(new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }),
    { status: 429, headers: { 'content-type': 'application/json', 'retry-after-ms': '1' } }));
  transport.mockImplementationOnce((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    resent();
  }));
  const controller = new AbortController();
  const rejected = callJudge('score', 'claude-fable-5-1', { max_tokens: 65_536, stream: true, signal: controller.signal }).catch(error => error);
  await retried;
  controller.abort(new Error('deadline'));
  await rejected;
  expect(JSON.parse(diagnostics.mock.calls[0]![0])).toMatchObject({ attempts: 1, httpRequests: 2, httpStatuses: [429],
    retryWaitsMs: [], connectedMs: null, firstEventMs: null });
});

test('an event the diagnostic cannot read never changes the judge result', async () => {
  const unreadable = response();
  const body = (await unreadable.text()).replace('"thinking":"PRIVATE_THINKING"', '"thinking":null');
  transport.mockResolvedValue(new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
  expect(await callJudge('score the whole bundle', 'claude-fable-5-1', {
    max_tokens: 65_536, stream: true, jsonSchema: WORKFLOW_JUDGE_RESPONSE_SCHEMA,
  })).toEqual(scores);
});

test('an abort reason is retained at most 200 characters long', async () => {
  transport.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
  }));
  const controller = new AbortController();
  const rejected = callJudge('score', 'claude-fable-5-1', { max_tokens: 65_536, stream: true, signal: controller.signal }).catch(error => error);
  controller.abort(new Error('x'.repeat(500)));
  await rejected;
  expect(JSON.parse(diagnostics.mock.calls[0]![0]).reason).toBe('x'.repeat(200));
});
