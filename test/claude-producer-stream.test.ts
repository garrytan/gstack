import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeStreamState, consumeClaudeStreamLine, resultFromClaudeStream, runClaudeProducerStream } from './helpers/providers/claude-stream';

// The event shapes claude 2.1.263 prints with -p --output-format stream-json --verbose --include-partial-messages.
const start = (id: string, input: number, cached = 7) => ({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id, usage: { input_tokens: input, output_tokens: 1, cache_read_input_tokens: cached } } } });
const delta = (output: number) => ({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: output } } });
const stop = { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_stop' } };
const text = (id: string, value: string) => ({ type: 'assistant', message: { id, content: [{ type: 'text', text: value }], usage: { input_tokens: 1, output_tokens: 1 } } });
const result = (extra: Record<string, unknown>) => ({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, result: 'REPORT', usage: { input_tokens: 2001, output_tokens: 201, cache_read_input_tokens: 14 }, ...extra });
const lines = (...events: unknown[]) => events.map(event => JSON.stringify(event));

const fixtures: string[] = [];
afterEach(() => { for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true }); });
const stub = (body: string) => {
  const directory = mkdtempSync(join(tmpdir(), 'claude-stream-')); fixtures.push(directory);
  const script = join(directory, 'claude');
  writeFileSync(script, `#!/bin/sh\ncat > /dev/null\n${body}\n`, { mode: 0o755 });
  return { script, directory };
};
const printf = (events: unknown[]) => lines(...events).map(line => `printf '%s\\n' '${line}'`).join('\n');

describe('Claude producer stream accounting', () => {
  test('counts every message from its stream usage, including one a kill interrupted', () => {
    const state = claudeStreamState();
    for (const line of lines(start('a', 1000), text('a', 'first note'), delta(100), stop, start('b', 1001), text('b', 'second note'), delta(40))) consumeClaudeStreamLine(state, line);
    const killed = resultFromClaudeStream(state, { model: 'claude-test', durationMs: 5, error: { code: 'timeout', reason: 'exceeded 5ms' } });
    expect(killed).toMatchObject({ tokens: { input: 2001, output: 140, cached: 14 }, toolCalls: 2, output: 'second note', error: { code: 'timeout' }, modelUsed: 'claude-test' });
  });

  test('takes usage and turns from the final result and keeps the paid result contract', () => {
    const state = claudeStreamState();
    for (const line of lines(start('a', 1000), delta(100), stop, result({}))) consumeClaudeStreamLine(state, line);
    expect(resultFromClaudeStream(state, { model: 'claude-test', durationMs: 5 })).toEqual({ output: 'REPORT', tokens: { input: 2001, output: 201, cached: 14 }, durationMs: 5, toolCalls: 2, modelUsed: 'claude-test' });
    for (const ending of [[], [result({ result: '  ' })], [result({ result: 7 })], [result({ is_error: true })], [result({ subtype: 'error_max_turns' })]]) {
      const partial = claudeStreamState();
      for (const line of lines(start('a', 10), delta(3), stop, ...ending)) consumeClaudeStreamLine(partial, line);
      const outcome = resultFromClaudeStream(partial, { model: 'claude-test', durationMs: 1 });
      expect(outcome).toMatchObject({ output: '', error: { code: 'unknown', reason: 'empty or invalid output from claude CLI (exit 0)' } });
      expect(outcome.tokens.input).toBeGreaterThan(0);
    }
  });

  test.skipIf(process.platform === 'win32')('a timed-out run returns the usage and last text it streamed before the kill', async () => {
    const { script, directory } = stub(`${printf([start('a', 1000), text('a', 'investigating'), delta(100), stop, start('b', 1001), delta(9)])}\nsleep 30`);
    const began = Date.now();
    const outcome = await runClaudeProducerStream(script, ['-p'], { input: 'go', cwd: directory, env: { PATH: '/usr/bin:/bin' }, timeoutMs: 1500, model: 'claude-test' });
    expect(Date.now() - began).toBeLessThan(10_000);
    expect(outcome).toMatchObject({ output: 'investigating', tokens: { input: 2001, output: 109, cached: 14 }, toolCalls: 2, error: { code: 'timeout', reason: 'exceeded 1500ms' } });
  });

  test.skipIf(process.platform === 'win32')('keeps the failed-command reason shape and the stream usage on a nonzero exit', async () => {
    const { script, directory } = stub(`${printf([result({ is_error: true, result: 'Invalid API key', usage: { input_tokens: 0, output_tokens: 0 } })])}\nexit 1`);
    const outcome = await runClaudeProducerStream(script, ['-p', '--model', 'm'], { input: 'go', cwd: directory, env: { PATH: '/usr/bin:/bin' }, timeoutMs: 5000, model: 'claude-test' });
    expect(outcome.error?.code).toBe('unknown');
    expect(outcome.error?.reason.startsWith(`Command failed: ${script} -p --model m`)).toBe(true);
    expect(outcome.tokens).toEqual({ input: 0, output: 0, cached: 0 });
  });

  test.skipIf(process.platform === 'win32')('a clean exit with a final result succeeds', async () => {
    const { script, directory } = stub(printf([start('a', 10), delta(2), stop, result({})]));
    const outcome = await runClaudeProducerStream(script, [], { input: 'go', cwd: directory, env: { PATH: '/usr/bin:/bin' }, timeoutMs: 5000, model: 'claude-test' });
    expect(outcome).toMatchObject({ output: 'REPORT', tokens: { input: 2001, output: 201, cached: 14 }, toolCalls: 2 });
    expect(outcome.error).toBeUndefined();
  });
});
