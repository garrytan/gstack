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

  test('associates Agent verdict text with its tool-use ID without transport metadata or reasoning', () => {
    const lines = [
      { type: 'assistant', message: { content: [
        { type: 'tool_use', id: 'review', name: 'Agent', input: { prompt: 'Review the design.' } },
      ] } },
      { type: 'user', tool_use_result: { content: [
        { type: 'thinking', thinking: 'Private computation must not become tool output.' },
        { type: 'text', text: 'Completeness: missing failure handling.' },
        { type: 'text', text: 'Quality score: 7/10' },
      ] }, message: { content: [
        { type: 'tool_result', tool_use_id: 'review', content: [
          { type: 'text', text: 'Completeness: missing failure handling.\nQuality score: 7/10' },
          { type: 'text', text: 'agentId: child-review\n<usage>duration_ms: 1000</usage>' },
        ] },
      ] } },
    ].map(event => JSON.stringify(event));

    expect(parseNDJSON(lines).toolCalls).toEqual([{
      tool: 'Agent',
      input: { prompt: 'Review the design.' },
      output: 'Completeness: missing failure handling.\nQuality score: 7/10',
    }]);
  });

  test('preserves Task error-result diagnostics as output', () => {
    const lines = [
      { type: 'assistant', message: { content: [
        { type: 'tool_use', id: 'failed-review', name: 'Task', input: {} },
      ] } },
      { type: 'user', message: { content: [
        { type: 'tool_result', tool_use_id: 'failed-review', is_error: true, content: 'Reviewer failed: deadline exceeded.' },
      ] } },
    ].map(event => JSON.stringify(event));

    expect(parseNDJSON(lines).toolCalls[0].output).toBe('Reviewer failed: deadline exceeded.');
  });

  test('flattens only public text blocks from matching message results', () => {
    const lines = [
      { type: 'assistant', message: { content: [
        { type: 'tool_use', id: 'legacy-task', name: 'Task', input: {} },
        { type: 'tool_use', id: 'shell', name: 'Bash', input: { command: 'echo done' } },
      ] } },
      { type: 'user', message: { content: [
        { type: 'tool_result', tool_use_id: 'legacy-task', content: [
          { type: 'text', text: 'Consistency: PASS' },
          { type: 'image', source: { data: 'not-text' } },
          { type: 'thinking', thinking: 'Private computation.' },
          { type: 'redacted_thinking', data: 'opaque' },
          null,
          { type: 'text', text: 123 },
          { type: 'text', text: 'Quality score: 10/10' },
        ] },
        { type: 'tool_result', tool_use_id: 'shell', content: 'done\n' },
      ] } },
    ].map(event => JSON.stringify(event));

    const parsed = parseNDJSON(lines);
    expect(parsed.toolCalls.map(call => call.output)).toEqual([
      'Consistency: PASS\nQuality score: 10/10', 'done\n',
    ]);
    expect(parsed.toolCallCount).toBe(2);
    expect(parsed.turnCount).toBe(1);
  });

  test('leaves missing, unmatched, and malformed results empty', () => {
    const lines = [
      { type: 'assistant', message: { content: [
        { type: 'tool_use', id: 'missing', name: 'Agent', input: {} },
        { type: 'tool_use', id: 'malformed', name: 'Task', input: {} },
        { type: 'tool_use', name: 'Read', input: {} },
      ] } },
      { type: 'user', message: { content: [
        { type: 'tool_result', tool_use_id: 'unknown', content: 'Do not attach to the latest call.' },
        { type: 'tool_result', tool_use_id: 'malformed', content: { text: 'Not a public content block.' } },
        { type: 'tool_result', content: 'No tool-use ID.' },
      ] } },
      { type: 'user', message: { content: 'Not a tool-result array.' } },
    ].map(event => JSON.stringify(event));

    expect(parseNDJSON(lines).toolCalls.map(call => call.output)).toEqual(['', '', '']);
  });

  test('scopes repeated tool-use IDs to the parent so child results cannot replace the parent verdict', () => {
    const lines = [
      { type: 'assistant', parent_tool_use_id: null, message: { content: [
        { type: 'tool_use', id: 'shared', name: 'Agent', input: { prompt: 'Parent review' } },
      ] } },
      { type: 'assistant', parent_tool_use_id: 'shared', message: { content: [
        { type: 'tool_use', id: 'shared', name: 'Read', input: { file_path: '/tmp/design.md' } },
      ] } },
      { type: 'user', parent_tool_use_id: 'shared', message: { content: [
        { type: 'tool_result', tool_use_id: 'shared', content: 'Child file content' },
      ] } },
      { type: 'user', message: { content: [
        { type: 'tool_result', tool_use_id: 'shared', content: 'Parent review verdict' },
      ] } },
      { type: 'user', parent_tool_use_id: 'another-child', message: { content: [
        { type: 'tool_result', tool_use_id: 'shared', content: 'Unrelated child result' },
      ] } },
    ].map(event => JSON.stringify(event));

    const parsed = parseNDJSON(lines);
    expect(parsed.toolCalls.map(call => call.output)).toEqual(['Parent review verdict', 'Child file content']);
    expect(parsed.toolCallCount).toBe(2);
    expect(parsed.turnCount).toBe(2);
  });
});
