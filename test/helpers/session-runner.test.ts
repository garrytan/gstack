import { describe, test, expect } from 'bun:test';
import { deriveExitReason, parseNDJSON } from './session-runner';

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

  test('counts a Codex command only once when both item.started and item.completed are present', () => {
    const lines = [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"turn.started"}',
      '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc pwd","aggregated_output":"","exit_code":null,"status":"in_progress"}}',
      '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc pwd","aggregated_output":"/tmp\\n","exit_code":0,"status":"completed"}}',
      '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":2,"output_tokens":3}}',
    ];

    const parsed = parseNDJSON(lines);
    expect(parsed.toolCallCount).toBe(1);
    expect(parsed.toolCalls).toEqual([
      {
        tool: 'Bash',
        input: { command: '/bin/zsh -lc pwd' },
        output: '/tmp\n',
      },
    ]);
  });

  test('preserves the final completed agent message after turn.completed', () => {
    const lines = [
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Final response."}}',
      '{"type":"turn.completed","usage":{"input_tokens":20,"cached_input_tokens":5,"output_tokens":4}}',
    ];

    const parsed = parseNDJSON(lines);
    expect(parsed.resultLine).toMatchObject({
      subtype: 'success',
      result: 'Final response.',
      usage: {
        input_tokens: 20,
        cache_read_input_tokens: 5,
        output_tokens: 4,
      },
    });
  });

  test('records failed turns without discarding the error payload', () => {
    const lines = [
      '{"type":"turn.started"}',
      '{"type":"turn.failed","error":{"message":"approval denied","code":"approval_denied"}}',
    ];

    const parsed = parseNDJSON(lines);
    expect(parsed.resultLine).toMatchObject({
      subtype: 'error',
      is_error: true,
      error: {
        message: 'approval denied',
        code: 'approval_denied',
      },
    });
  });

  test('keeps completed Codex tool items in stable completion order across command and MCP calls', () => {
    const lines = [
      '{"type":"turn.started"}',
      '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"echo first","aggregated_output":"","exit_code":null,"status":"in_progress"}}',
      '{"type":"item.started","item":{"id":"item_2","type":"mcp_tool_call","server":"docs","tool":"search","arguments":{"q":"codex"},"status":"in_progress"}}',
      '{"type":"item.completed","item":{"id":"item_2","type":"mcp_tool_call","server":"docs","tool":"search","arguments":{"q":"codex"},"result":{"hits":2},"status":"completed"}}',
      '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"echo first","aggregated_output":"first\\n","exit_code":0,"status":"completed"}}',
    ];

    const parsed = parseNDJSON(lines);
    expect(parsed.toolCalls).toEqual([
      {
        tool: 'docs:search',
        input: { q: 'codex' },
        output: JSON.stringify({ hits: 2 }),
      },
      {
        tool: 'Bash',
        input: { command: 'echo first' },
        output: 'first\n',
      },
    ]);
  });
});

describe('deriveExitReason', () => {
  test('preserves timeout even when a prior agent message looked successful', () => {
    expect(deriveExitReason(true, 0, { subtype: 'success', result: 'partial' })).toBe('timeout');
  });

  test('classifies structured API errors over process exit code', () => {
    expect(deriveExitReason(false, 0, { is_error: true, error: { message: 'boom' } })).toBe('error_api');
  });

  test('falls back to exit code when no structured result is present', () => {
    expect(deriveExitReason(false, 137, null)).toBe('exit_code_137');
  });
});
