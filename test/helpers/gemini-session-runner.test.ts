import { describe, test, expect } from 'bun:test';
import { parseGeminiJSONL } from './gemini-session-runner';

// Fixture: actual Gemini CLI stream-json output with tool use
const FIXTURE_LINES = [
  '{"type":"init","timestamp":"2026-03-20T15:14:46.455Z","session_id":"test-session-123","model":"auto-gemini-3"}',
  '{"type":"message","timestamp":"2026-03-20T15:14:46.456Z","role":"user","content":"list the files"}',
  '{"type":"message","timestamp":"2026-03-20T15:14:49.650Z","role":"assistant","content":"I will list the files.","delta":true}',
  '{"type":"tool_use","timestamp":"2026-03-20T15:14:49.690Z","tool_name":"run_shell_command","tool_id":"cmd_1","parameters":{"command":"ls"}}',
  '{"type":"tool_result","timestamp":"2026-03-20T15:14:49.931Z","tool_id":"cmd_1","status":"success","output":"file1.ts\\nfile2.ts"}',
  '{"type":"message","timestamp":"2026-03-20T15:14:51.945Z","role":"assistant","content":"Here are the files.","delta":true}',
  '{"type":"result","timestamp":"2026-03-20T15:14:52.030Z","status":"success","stats":{"total_tokens":27147,"input_tokens":26928,"output_tokens":87,"cached":0,"duration_ms":5575,"tool_calls":1}}',
];

describe('parseGeminiJSONL', () => {
  test('extracts session ID from init event', () => {
    const parsed = parseGeminiJSONL(FIXTURE_LINES);
    expect(parsed.sessionId).toBe('test-session-123');
  });

  test('concatenates assistant message deltas into output', () => {
    const parsed = parseGeminiJSONL(FIXTURE_LINES);
    expect(parsed.output).toBe('I will list the files.Here are the files.');
  });

  test('ignores user messages', () => {
    const lines = [
      '{"type":"message","role":"user","content":"this should be ignored"}',
      '{"type":"message","role":"assistant","content":"this should be kept","delta":true}',
    ];
    const parsed = parseGeminiJSONL(lines);
    expect(parsed.output).toBe('this should be kept');
  });

  test('extracts tool names from tool_use events', () => {
    const parsed = parseGeminiJSONL(FIXTURE_LINES);
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0]).toBe('run_shell_command');
  });

  test('extracts total tokens from result stats', () => {
    const parsed = parseGeminiJSONL(FIXTURE_LINES);
    expect(parsed.tokens).toBe(27147);
  });

  test('skips malformed lines without throwing', () => {
    const lines = [
      '{"type":"init","session_id":"ok"}',
      'this is not json',
      '{"type":"message","role":"assistant","content":"hello","delta":true}',
      '{incomplete json',
      '{"type":"result","status":"success","stats":{"total_tokens":100}}',
    ];
    const parsed = parseGeminiJSONL(lines);
    expect(parsed.sessionId).toBe('ok');
    expect(parsed.output).toBe('hello');
    expect(parsed.tokens).toBe(100);
  });

  test('skips empty and whitespace-only lines', () => {
    const lines = [
      '',
      '  ',
      '{"type":"init","session_id":"s1"}',
      '\t',
      '{"type":"result","status":"success","stats":{"total_tokens":50}}',
    ];
    const parsed = parseGeminiJSONL(lines);
    expect(parsed.sessionId).toBe('s1');
    expect(parsed.tokens).toBe(50);
  });

  test('handles empty input', () => {
    const parsed = parseGeminiJSONL([]);
    expect(parsed.output).toBe('');
    expect(parsed.toolCalls).toHaveLength(0);
    expect(parsed.tokens).toBe(0);
    expect(parsed.sessionId).toBeNull();
  });

  test('handles missing fields gracefully', () => {
    const lines = [
      '{"type":"init"}',                              // no session_id
      '{"type":"message","role":"assistant"}',         // no content
      '{"type":"tool_use"}',                           // no tool_name
      '{"type":"result","status":"success"}',          // no stats
    ];
    const parsed = parseGeminiJSONL(lines);
    expect(parsed.sessionId).toBeNull();
    expect(parsed.output).toBe('');
    expect(parsed.toolCalls).toHaveLength(0);
    expect(parsed.tokens).toBe(0);
  });

  test('handles multiple tool_use events', () => {
    const lines = [
      '{"type":"tool_use","tool_name":"run_shell_command","tool_id":"cmd_1","parameters":{"command":"ls"}}',
      '{"type":"tool_use","tool_name":"read_file","tool_id":"cmd_2","parameters":{"path":"foo.ts"}}',
      '{"type":"tool_use","tool_name":"run_shell_command","tool_id":"cmd_3","parameters":{"command":"cat bar.ts"}}',
    ];
    const parsed = parseGeminiJSONL(lines);
    expect(parsed.toolCalls).toEqual(['run_shell_command', 'read_file', 'run_shell_command']);
  });
});
