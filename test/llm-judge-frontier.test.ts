import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import Anthropic from '@anthropic-ai/sdk';
import { armJudge, callJudge } from './helpers/llm-judge';

describe('frontier Claude judge compatibility', () => {
  let originalKey: string | undefined;
  let create: ReturnType<typeof spyOn>;
  let diagnostics: ReturnType<typeof spyOn>;

  beforeEach(() => {
    originalKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-only-key';
    create = spyOn(Anthropic.Messages.prototype, 'create');
    diagnostics = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    create.mockRestore();
    diagnostics.mockRestore();
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  });

  test('parses JSON text after an omitted-thinking block', async () => {
    create.mockResolvedValue({ content: [
      { type: 'thinking', thinking: '', signature: 'fixture' },
      { type: 'text', text: '{"score":4}' },
    ] } as never);
    expect(await callJudge('score this', 'claude-fable-5-1')).toEqual({ score: 4 });
    expect(create.mock.calls[0][0].max_tokens).toBe(8192);
    expect(diagnostics).not.toHaveBeenCalled();
  });

  test('retains complete public response on malformed JSON and fails without another request', async () => {
    // Synthetic malformed response: the actual failed provider text was not retained.
    const textBlocks = ['{"questions":[{"toolUseId":"c1","reason":"' + 'evidence '.repeat(500) + '"', '}]'];
    create.mockResolvedValue({
      id: 'msg_fixture', _request_id: 'req_fixture', model: 'test-judge-model', stop_reason: 'end_turn',
      content: [
        { type: 'thinking', thinking: 'PRIVATE_THINKING', signature: 'PRIVATE_SIGNATURE' },
        ...textBlocks.map(text => ({ type: 'text', text })),
        { type: 'redacted_thinking', data: 'PRIVATE_REDACTED' },
      ],
      usage: { input_tokens: 120, output_tokens: 90, cache_creation_input_tokens: 10, cache_read_input_tokens: 20,
        server_tool_use: { ignored: true }, thinking: 'PRIVATE_NESTED' },
    } as never);
    const controller = new AbortController();
    let failure: unknown;
    try { await callJudge('classify the supplied evidence', 'test-judge-model', { signal: controller.signal, max_tokens: 16_384 }); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(SyntaxError);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]).toEqual([{
      model: 'test-judge-model', max_tokens: 16_384,
      messages: [{ role: 'user', content: 'classify the supplied evidence' }],
    }, { signal: controller.signal }]);
    expect(diagnostics).toHaveBeenCalledTimes(1);
    expect(JSON.parse(diagnostics.mock.calls[0][0])).toEqual({
      type: 'llm-judge-response-parse-error', responseId: 'msg_fixture', requestId: 'req_fixture',
      model: 'test-judge-model', stopReason: 'end_turn',
      usage: { input_tokens: 120, output_tokens: 90, cache_creation_input_tokens: 10, cache_read_input_tokens: 20 },
      textBlocks, error: { name: 'SyntaxError', message: (failure as Error).message },
    });
    expect(diagnostics.mock.calls[0][0]).not.toContain('PRIVATE_');
  });

  test('retains non-JSON text without inventing a judgment or leaking non-scalar metadata', async () => {
    const text = 'No JSON object. ' + 'Public response '.repeat(100);
    create.mockResolvedValue({
      id: { secret: 'PRIVATE_ID' }, _request_id: ['PRIVATE_REQUEST'],
      content: [{ type: 'text', text }], usage: { input_tokens: { secret: 'PRIVATE_USAGE' } },
    } as never);
    await expect(callJudge('score this', 'test-judge-model')).rejects.toThrow('Judge returned non-JSON');
    expect(create).toHaveBeenCalledTimes(1);
    expect(diagnostics).toHaveBeenCalledTimes(1);
    const retained = JSON.parse(diagnostics.mock.calls[0][0]);
    expect(retained.textBlocks).toEqual([text]);
    expect(retained.responseId).toBeNull();
    expect(retained.requestId).toBeNull();
    expect(retained.usage.input_tokens).toBeNull();
    expect(diagnostics.mock.calls[0][0]).not.toContain('PRIVATE_');
  });

  test('preserves an explicit output budget', async () => {
    create.mockResolvedValue({ content: [{ type: 'text', text: '{"score":5}' }] } as never);
    await callJudge('score this', 'claude-sonnet-4-6', { max_tokens: 2048 });
    expect(create.mock.calls[0][0].max_tokens).toBe(2048);
  });

  test('rejects token exhaustion even when a partial answer contains valid JSON', async () => {
    create.mockResolvedValue({
      stop_reason: 'max_tokens',
      content: [{ type: 'text', text: '{"score":4}' }],
    } as never);
    await expect(callJudge('score this', 'claude-fable-5-1', { max_tokens: 1024 }))
      .rejects.toThrow('Judge response truncated at max_tokens=1024');
    expect(diagnostics).not.toHaveBeenCalled();
  });

  test('keeps text-only responses and explicit model options working', async () => {
    create.mockResolvedValue({ content: [{ type: 'text', text: '{"score":5}' }] } as never);
    expect(await callJudge('score this', 'claude-sonnet-4-6', { temperature: 0 })).toEqual({ score: 5 });
    expect(create.mock.calls[0][0]).toMatchObject({ model: 'claude-sonnet-4-6', temperature: 0 });
  });

  test('rejects responses without JSON text', async () => {
    create.mockResolvedValue({ content: [{ type: 'thinking', thinking: '', signature: 'fixture' }] } as never);
    await expect(callJudge('score this', 'claude-fable-5-1')).rejects.toThrow('Judge returned non-JSON');
  });

  test('structured JSON is opt-in and preserves request options and quoted values', async () => {
    const jsonSchema = { type: 'object', properties: { score: { type: 'integer' }, reason: { type: 'string' } },
      required: ['score', 'reason'], additionalProperties: false };
    const answer = { score: 4, reason: 'Quotes "inside" a value, literal } { braces, and café.' };
    const controller = new AbortController();
    create.mockResolvedValue({ stop_reason: 'end_turn', content: [
      { type: 'thinking', thinking: 'PRIVATE_THINKING', signature: 'PRIVATE_SIGNATURE' },
      { type: 'text', text: '  ' + JSON.stringify(answer) + '\n' },
    ] } as never);
    expect(await callJudge('classify the supplied evidence', 'claude-fable-5-1', {
      signal: controller.signal, max_tokens: 16_384, jsonSchema,
    })).toEqual(answer);
    expect(create.mock.calls).toEqual([[{
      model: 'claude-fable-5-1', max_tokens: 16_384,
      output_config: { format: { type: 'json_schema', schema: jsonSchema } },
      messages: [{ role: 'user', content: 'classify the supplied evidence' }],
    }, { signal: controller.signal }]]);
    expect(diagnostics).not.toHaveBeenCalled();
  });

  test('structured responses parse the full text while default callers retain brace extraction', async () => {
    const jsonSchema = { type: 'object', properties: { score: { type: 'integer' } }, required: ['score'], additionalProperties: false };
    for (const text of ['Summary: {"score":4}', '```json\n{"score":4}\n```', '{"score":4} trailing prose', '{"score":']) {
      create.mockClear(); diagnostics.mockClear();
      create.mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text }] } as never);
      await expect(callJudge('score this', 'claude-fable-5-1', { jsonSchema })).rejects.toBeInstanceOf(SyntaxError);
      expect(create).toHaveBeenCalledTimes(1);
      expect(JSON.parse(diagnostics.mock.calls[0][0]).textBlocks).toEqual([text]);
    }
    create.mockClear(); diagnostics.mockClear();
    create.mockResolvedValue({ content: [{ type: 'text', text: 'Summary: {"score":4} done.' }] } as never);
    expect(await callJudge('score this', 'claude-fable-5-1')).toEqual({ score: 4 });
    expect(create.mock.calls[0][0]).not.toHaveProperty('output_config');
    expect(diagnostics).not.toHaveBeenCalled();
  });

  test('structured refusals and incomplete stops never return even valid JSON', async () => {
    const jsonSchema = { type: 'object', properties: { score: { type: 'integer' } }, required: ['score'], additionalProperties: false };
    for (const stop_reason of ['refusal', 'max_tokens', 'stop_sequence', 'tool_use', null]) {
      create.mockClear(); diagnostics.mockClear();
      create.mockResolvedValue({ stop_reason, content: [{ type: 'text', text: '{"score":4}' }] } as never);
      await expect(callJudge('score this', 'claude-fable-5-1', { max_tokens: 16_384, jsonSchema }))
        .rejects.toThrow(stop_reason === 'max_tokens' ? 'truncated at max_tokens=16384' : 'Structured judge did not complete');
      expect(create).toHaveBeenCalledTimes(1);
    }
  });

  test('arm judge sends no unsupported temperature to Fable', async () => {
    create.mockResolvedValue({ content: [
      { type: 'thinking', thinking: '', signature: 'fixture' },
      { type: 'text', text: '{"over_engineering":0,"construct":"none","reasoning":"Scoped change"}' },
    ] } as never);
    expect((await armJudge('ticket', '+ requested change')).over_engineering).toBe(0);
    const request = create.mock.calls[0][0];
    expect(request.model).toBe('claude-fable-5-1');
    expect(request).not.toHaveProperty('temperature');
  });
});
