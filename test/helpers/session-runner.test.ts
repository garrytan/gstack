import { describe, test, expect } from 'bun:test';
import { parseNDJSON } from './session-runner';

// Fixture: minimal NDJSON session (system init, assistant with tool_use, tool result, assistant text, result)
const FIXTURE_LINES = [
  '{"type":"system","subtype":"init","session_id":"test-123"}',
  '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu1","name":"Bash","input":{"command":"echo hello"}}]}}',
  '{"type":"user","tool_use_result":{"tool_use_id":"tu1","stdout":"hello\\n","stderr":""}}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"The command printed hello."}]}}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"Let me also read a file."},{"type":"tool_use","id":"tu2","name":"Read","input":{"file_path":"/tmp/test"}}]}}',
  '{"type":"result","subtype":"success","total_cost_usd":0.05,"num_turns":3,"usage":{"input_tokens":100,"output_tokens":50},"result":"Done."}',
];

describe('parseNDJSON', () => {
  test('parses valid NDJSON with system + assistant + result events', () => {
    const parsed = parseNDJSON(FIXTURE_LINES);
    expect(parsed.transcript).toHaveLength(6);
    expect(parsed.transcript[0].type).toBe('system');
    expect(parsed.transcript[5].type).toBe('result');
  });

  test('extracts tool calls from assistant.message.content[].type === tool_use', () => {
    const parsed = parseNDJSON(FIXTURE_LINES);
    expect(parsed.toolCalls).toHaveLength(2);
    expect(parsed.toolCalls[0]).toEqual({
      tool: 'Bash',
      input: { command: 'echo hello' },
      output: '',
    });
    expect(parsed.toolCalls[1]).toEqual({
      tool: 'Read',
      input: { file_path: '/tmp/test' },
      output: '',
    });
    expect(parsed.toolCallCount).toBe(2);
  });

  test('skips malformed lines without throwing', () => {
    const lines = [
      '{"type":"system"}',
      'this is not json',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}',
      '{incomplete json',
      '{"type":"result","subtype":"success","result":"done"}',
    ];
    const parsed = parseNDJSON(lines);
    expect(parsed.transcript).toHaveLength(3); // system, assistant, result
    expect(parsed.resultLine?.subtype).toBe('success');
  });

  test('skips empty and whitespace-only lines', () => {
    const lines = [
      '',
      '  ',
      '{"type":"system"}',
      '\t',
      '{"type":"result","subtype":"success","result":"ok"}',
    ];
    const parsed = parseNDJSON(lines);
    expect(parsed.transcript).toHaveLength(2);
  });

  test('extracts resultLine from type: "result" event', () => {
    const parsed = parseNDJSON(FIXTURE_LINES);
    expect(parsed.resultLine).not.toBeNull();
    expect(parsed.resultLine.subtype).toBe('success');
    expect(parsed.resultLine.total_cost_usd).toBe(0.05);
    expect(parsed.resultLine.num_turns).toBe(3);
    expect(parsed.resultLine.result).toBe('Done.');
  });

  test('counts turns correctly — one per assistant event, not per text block', () => {
    const parsed = parseNDJSON(FIXTURE_LINES);
    // 3 assistant events in fixture (tool_use, text, text+tool_use)
    expect(parsed.turnCount).toBe(3);
  });

  test('handles empty input', () => {
    const parsed = parseNDJSON([]);
    expect(parsed.transcript).toHaveLength(0);
    expect(parsed.resultLine).toBeNull();
    expect(parsed.turnCount).toBe(0);
    expect(parsed.toolCallCount).toBe(0);
    expect(parsed.toolCalls).toHaveLength(0);
  });

  test('handles assistant event with no content array', () => {
    const lines = [
      '{"type":"assistant","message":{}}',
      '{"type":"assistant"}',
    ];
    const parsed = parseNDJSON(lines);
    expect(parsed.turnCount).toBe(2);
    expect(parsed.toolCalls).toHaveLength(0);
  });

  test('resultLine preserves modelUsage for cost extraction', () => {
    const lines = [
      '{"type":"assistant","message":{"model":"claude-sonnet-4-6","content":[{"type":"text","text":"ok"}]}}',
      JSON.stringify({
        type: 'result', subtype: 'success', total_cost_usd: 0.07,
        num_turns: 1, result: 'Done.',
        usage: { input_tokens: 8, output_tokens: 802 },
        modelUsage: {
          'claude-sonnet-4-6': {
            inputTokens: 8, outputTokens: 802,
            cacheReadInputTokens: 88133, cacheCreationInputTokens: 9223,
            costUSD: 0.07308,
          },
        },
      }),
    ];
    const parsed = parseNDJSON(lines);
    expect(parsed.resultLine).not.toBeNull();
    expect(parsed.resultLine.modelUsage).toBeDefined();
    const usage = parsed.resultLine.modelUsage['claude-sonnet-4-6'];
    expect(usage.inputTokens).toBe(8);
    expect(usage.outputTokens).toBe(802);
    expect(usage.cacheReadInputTokens).toBe(88133);
    expect(usage.costUSD).toBeCloseTo(0.07308);
  });

  test('resultLine without modelUsage has undefined modelUsage', () => {
    const parsed = parseNDJSON(FIXTURE_LINES);
    // Original fixture has no modelUsage on result line
    expect(parsed.resultLine?.modelUsage).toBeUndefined();
  });
});
