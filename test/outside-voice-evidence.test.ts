import { describe, expect, test } from 'bun:test';
import { claudeOutsideExecutions, codexOutsideExecutions, foundInvoiceAuthorizationDefect } from './helpers/outside-voice-evidence';

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
