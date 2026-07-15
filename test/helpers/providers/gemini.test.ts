import { describe, test, expect } from 'bun:test';
import { parseGeminiStreamJson, resultFromGeminiStream } from './gemini';

// Current CLI shape (gemini ≥ ~0.11 / stream-json): content + role, tokens under result.stats
// Documented at https://geminicli.com/docs/cli/headless/ and gemini-cli PR #10883.
const CURRENT_CLI_FIXTURE = [
  '{"type":"init","timestamp":"2026-03-20T15:14:46.455Z","session_id":"test-session-123","model":"gemini-2.5-pro"}',
  '{"type":"message","role":"user","content":"Reply with exactly the word: PONG"}',
  '{"type":"message","role":"assistant","content":"PONG","delta":true}',
  '{"type":"result","status":"success","stats":{"input_tokens":24946,"output_tokens":32,"total_tokens":24978}}',
].join('\n');

// Legacy shape: text field, tokens under result.usage
const LEGACY_FIXTURE = [
  '{"type":"message","text":"hello"}',
  '{"type":"tool_use","name":"run_shell_command"}',
  '{"type":"result","usage":{"input_token_count":100,"output_token_count":5},"model":"gemini-2.5-flash"}',
].join('\n');

describe('parseGeminiStreamJson', () => {
  test('current CLI: reads assistant content, ignores user echo, stats tokens, init model', () => {
    const parsed = parseGeminiStreamJson(CURRENT_CLI_FIXTURE);
    expect(parsed.output).toBe('PONG');
    expect(parsed.tokens.input).toBe(24946);
    expect(parsed.tokens.output).toBe(32);
    expect(parsed.modelUsed).toBe('gemini-2.5-pro');
    expect(parsed.toolCalls).toBe(0);
  });

  test('current CLI: user role content must not concat into output', () => {
    const raw = [
      '{"type":"message","role":"user","content":"PROMPT ECHO"}',
      '{"type":"message","role":"assistant","content":"ok","delta":true}',
    ].join('\n');
    const parsed = parseGeminiStreamJson(raw);
    expect(parsed.output).toBe('ok');
    expect(parsed.output).not.toContain('PROMPT ECHO');
  });

  test('legacy: still accepts text + usage.input_token_count', () => {
    const parsed = parseGeminiStreamJson(LEGACY_FIXTURE);
    expect(parsed.output).toBe('hello');
    expect(parsed.tokens.input).toBe(100);
    expect(parsed.tokens.output).toBe(5);
    expect(parsed.toolCalls).toBe(1);
    expect(parsed.modelUsed).toBe('gemini-2.5-flash');
  });

  test('legacy text with role:user is ignored', () => {
    const raw = [
      '{"type":"message","role":"user","text":"echo"}',
      '{"type":"message","role":"assistant","text":"kept"}',
    ].join('\n');
    const parsed = parseGeminiStreamJson(raw);
    expect(parsed.output).toBe('kept');
  });

  test('concatenates multiple assistant content deltas', () => {
    const raw = [
      '{"type":"message","role":"assistant","content":"A","delta":true}',
      '{"type":"message","role":"assistant","content":"B","delta":true}',
    ].join('\n');
    expect(parseGeminiStreamJson(raw).output).toBe('AB');
  });

  test('skips malformed lines without throwing', () => {
    const raw = [
      '{"type":"init","model":"m1"}',
      'not json',
      '{"type":"message","role":"assistant","content":"x","delta":true}',
      '{incomplete',
      '{"type":"result","stats":{"input_tokens":1,"output_tokens":2}}',
    ].join('\n');
    const parsed = parseGeminiStreamJson(raw);
    expect(parsed.output).toBe('x');
    expect(parsed.tokens).toEqual({ input: 1, output: 2 });
    expect(parsed.modelUsed).toBe('m1');
  });

  test('empty / whitespace-only input yields empty parse (no throw)', () => {
    const parsed = parseGeminiStreamJson('');
    expect(parsed.output).toBe('');
    expect(parsed.tokens).toEqual({ input: 0, output: 0 });
    expect(parsed.toolCalls).toBe(0);
    expect(parsed.modelUsed).toBeUndefined();
  });

  test('result.model overrides init.model when both present', () => {
    const raw = [
      '{"type":"init","model":"from-init"}',
      '{"type":"message","role":"assistant","content":"hi"}',
      '{"type":"result","model":"from-result","stats":{"input_tokens":1,"output_tokens":1}}',
    ].join('\n');
    expect(parseGeminiStreamJson(raw).modelUsed).toBe('from-result');
  });
});

describe('resultFromGeminiStream (adapter post-CLI e2e)', () => {
  test('current CLI fixture → success row with PONG + tokens (not $0)', () => {
    const result = resultFromGeminiStream(CURRENT_CLI_FIXTURE, { durationMs: 42 });
    expect(result.error).toBeUndefined();
    expect(result.output).toBe('PONG');
    expect(result.tokens.input).toBe(24946);
    expect(result.tokens.output).toBe(32);
    expect(result.modelUsed).toBe('gemini-2.5-pro');
    expect(result.durationMs).toBe(42);
    // Cost signal: non-zero tokens means estimateCost will not be $0.
    expect(result.tokens.input + result.tokens.output).toBeGreaterThan(0);
  });

  test('legacy text-only success still works', () => {
    const result = resultFromGeminiStream(LEGACY_FIXTURE, { durationMs: 10 });
    expect(result.error).toBeUndefined();
    expect(result.output).toBe('hello');
    expect(result.toolCalls).toBe(1);
  });

  test('empty exit-0 stream → error row, never silent $0 success (#2159)', () => {
    const emptySuccess = [
      '{"type":"init","model":"gemini-2.5-pro"}',
      '{"type":"message","role":"user","content":"hi"}',
      '{"type":"result","status":"success","stats":{"input_tokens":0,"output_tokens":0}}',
    ].join('\n');
    const result = resultFromGeminiStream(emptySuccess, { durationMs: 5 });
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('unknown');
    expect(result.error!.reason).toContain('empty output');
    expect(result.output).toBe('');
    expect(result.modelUsed).toBe('gemini-2.5-pro');
  });

  test('pre-fix bug shape (text field missing, only content) would have been empty — now succeeds', () => {
    // This is the exact failure mode from #2159: content present, no text.
    const result = resultFromGeminiStream(CURRENT_CLI_FIXTURE);
    expect(result.error).toBeUndefined();
    expect(result.output).toBe('PONG');
  });
});
