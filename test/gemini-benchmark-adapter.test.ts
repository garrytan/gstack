import { describe, expect, test } from 'bun:test';
import { parseGeminiStreamJson } from '../lib/model-benchmark/providers/gemini';

describe('parseGeminiStreamJson', () => {
  test('parses the current Gemini CLI content/stats schema', () => {
    const raw = [
      JSON.stringify({ type: 'init', model: 'auto' }),
      JSON.stringify({ type: 'message', role: 'user', content: 'ignore me' }),
      JSON.stringify({ type: 'message', role: 'assistant', content: 'real output' }),
      JSON.stringify({ type: 'tool_use', tool_name: 'read_file' }),
      JSON.stringify({
        type: 'result',
        stats: {
          input_tokens: 101,
          output_tokens: 17,
          models: { 'gemini-3.1-flash-lite': { api: { totalRequests: 1 } } },
        },
      }),
    ].join('\n');

    expect(parseGeminiStreamJson(raw)).toEqual({
      output: 'real output',
      tokens: { input: 101, output: 17 },
      toolCalls: 1,
      modelUsed: 'gemini-3.1-flash-lite',
    });
  });

  test('retains compatibility with legacy text/usage fields', () => {
    const raw = [
      JSON.stringify({ type: 'init', model: 'gemini-2.5-pro' }),
      JSON.stringify({ type: 'message', role: 'assistant', text: 'legacy output' }),
      JSON.stringify({
        type: 'result',
        usage: { input_token_count: 23, output_token_count: 5 },
      }),
      '{malformed',
    ].join('\n');

    expect(parseGeminiStreamJson(raw)).toEqual({
      output: 'legacy output',
      tokens: { input: 23, output: 5 },
      toolCalls: 0,
      modelUsed: 'gemini-2.5-pro',
    });
  });
});
