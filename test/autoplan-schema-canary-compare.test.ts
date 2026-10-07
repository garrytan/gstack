/** CEO-13: the canary's comparison passes the documented strip and fails an injected one (free). */
import { describe, expect, test } from 'bun:test';
import { schemaDrift, type HookPayload } from './helpers/schema-canary';
import { SCHEMA_STRIPPED, nativeToolInput } from '../autoplan/bin/phase-publication-hook.ts';
import captured from './fixtures/claude-agent-payload-2.1.292.json';

const cwd = '/repo';
const read: HookPayload = { tool_name: 'Read', tool_use_id: 'toolu_read', cwd, tool_input: { file_path: '/repo/note.txt' } };
const agent = (input: Record<string, unknown>): HookPayload => ({ tool_name: 'Agent', tool_use_id: 'toolu_agent', cwd, tool_input: input });
const journal = (agentInput: Record<string, unknown>) =>
  new Map<string, Record<string, unknown>>([['toolu_read', { file_path: 'note.txt' }], ['toolu_agent', agentInput]]);

describe('autoplan-schema-canary comparison', () => {
  test('the guard documents exactly one strip, and its comparison drops only that key from the captured inputs', () => {
    expect(SCHEMA_STRIPPED).toEqual({ Agent: ['run_in_background'] });
    const { payloadInput, journalInput } = captured.forcedRunInBackground;
    expect(nativeToolInput(journalInput, cwd, 'Agent')).toEqual(nativeToolInput(payloadInput, cwd, 'Agent'));
    expect(nativeToolInput(journalInput, cwd, 'Read')).not.toEqual(nativeToolInput(payloadInput, cwd, 'Read'));
  });

  test('2.1.292 as captured: run_in_background stripped from the payload is the documented strip', () => {
    const { payloadInput, journalInput } = captured.forcedRunInBackground;
    expect(schemaDrift([read, agent(payloadInput)], journal(journalInput))).toEqual([]);
  });

  test('an injected strip of another key fails', () => {
    const { payloadInput, journalInput } = captured.forcedRunInBackground;
    const { description: _gone, ...stripped } = payloadInput;
    const problems = schemaDrift([read, agent(stripped)], journal(journalInput));
    expect(problems.join('\n')).toContain('differ from journal keys');
    expect(problems.join('\n')).toContain("the guard's comparison does not match");
  });

  test('a payload key outside the guard allowlist fails, and so does a missing tool', () => {
    const input = { ...captured.forcedRunInBackground.payloadInput, isolation: 'worktree' };
    expect(schemaDrift([read, agent(input)], journal(input)).join('\n')).toContain('outside the guard allowlist: isolation');
    expect(schemaDrift([agent(captured.forcedRunInBackground.payloadInput)], journal(captured.forcedRunInBackground.journalInput)))
      .toEqual(['no Read payload was recorded']);
  });
});
