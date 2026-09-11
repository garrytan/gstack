import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EvalCollector } from './helpers/eval-store';
import { claudeOutsideExecutions, codexOutsideExecutions, foundInvoiceAuthorizationDefect, outsideExecutionTranscript } from './helpers/outside-voice-evidence';

const finding = '[P1] invoice.ts removed the owner check, allowing unauthorized access to private invoices.';

describe('cross-harness live eval evidence', () => {
  test('Claude prose claiming Codex ran is not evidence', () => {
    const transcript = [{ type: 'assistant', message: { content: [{ type: 'text', text: `codex exec: ${finding}` }] } }];
    expect(foundInvoiceAuthorizationDefect(claudeOutsideExecutions(transcript), 'codex')).toBe(false);
  });
  test('Claude tool results must match the actual outside tool invocation', () => {
    const transcript = [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'outside', name: 'Bash', input: { command: 'codex exec --json -' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'native', content: finding }] } },
    ];
    expect(foundInvoiceAuthorizationDefect(claudeOutsideExecutions(transcript), 'codex')).toBe(false);
    transcript.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'outside', content: finding }] } } as any);
    expect(foundInvoiceAuthorizationDefect(claudeOutsideExecutions(transcript), 'codex')).toBe(true);
  });
  test('Codex requires completed, successful command execution with findings in its output', () => {
    const event = { type: 'item.completed', item: { type: 'command_execution', command: '"/runtime/bin/gstack-claude-code" --cwd /repo --access none --timeout-ms 1000', aggregated_output: finding, exit_code: 0 } };
    expect(foundInvoiceAuthorizationDefect(codexOutsideExecutions([JSON.stringify(event)]), 'claude-code')).toBe(true);
    for (const invalid of [
      { ...event, type: 'item.started' },
      { ...event, item: { ...event.item, exit_code: 124 } },
      { ...event, item: { ...event.item, aggregated_output: 'OUTSIDE_STATUS: unavailable\n' + finding } },
      { type: 'item.completed', item: { type: 'agent_message', text: finding } },
    ]) expect(foundInvoiceAuthorizationDefect(codexOutsideExecutions([JSON.stringify(invalid)]), 'claude-code')).toBe(false);
  });
});

describe('outside execution artifact retention', () => {
  for (const provider of ['codex', 'claude-code'] as const) {
    test(`${provider} persists full successful and failed results before cleanup`, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-evidence-'));
      try {
        const command = provider === 'codex' ? 'codex exec --json -'
          : '"/runtime/bin/gstack-claude-code" --cwd /repo --access none --timeout-ms 1000';
        const output = 'Review detail\n'.repeat(300) + finding;
        const failedOutput = 'OUTSIDE_STATUS: unavailable\nprovider exited before final response';
        const executions = [
          { command: 'cat /owned/auth.json /owned/config.toml', output: 'UNRELATED_CONFIG_CONTENT', succeeded: true },
          { command, output: failedOutput, succeeded: false },
          { command, output, succeeded: true, unrelated: 'UNRELATED_EVENT_FIELD' },
        ];
        const transcript = outsideExecutionTranscript(executions, provider);
        const collector = new EvalCollector('e2e', dir);
        collector.addTest({ name: `outside-${provider}`, suite: 'outside-voice', tier: 'e2e',
          passed: true, duration_ms: 1, cost_usd: 0, transcript });

        // addTest writes immediately, before disposable host homes/repositories disappear.
        const stored = fs.readFileSync(path.join(dir, '_partial-e2e.json'), 'utf8');
        const entries = JSON.parse(stored).tests[0].transcript;
        expect(entries).toEqual([
          { type: 'outside_execution', provider, command, output: failedOutput, succeeded: false },
          { type: 'outside_execution', provider, command, output, succeeded: true },
        ]);
        expect(entries[1].output.length).toBeGreaterThan(2000);
        expect(stored).not.toContain('UNRELATED_CONFIG_CONTENT');
        expect(stored).not.toContain('UNRELATED_EVENT_FIELD');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test('unrelated providers and host prose never become retained outside executions', () => {
    const unrelated = [{ command: 'codex exec --json -', output: finding, succeeded: true }];
    expect(outsideExecutionTranscript(unrelated, 'claude-code')).toEqual([]);
    expect(outsideExecutionTranscript(claudeOutsideExecutions([
      { type: 'assistant', message: { content: [{ type: 'text', text: `codex exec: ${finding}` }] } },
    ]), 'codex')).toEqual([]);
  });
});
