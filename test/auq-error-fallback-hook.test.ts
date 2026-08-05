/**
 * auq-error-fallback-hook — the OV3:B runtime reliability layer.
 *
 * Two layers of testing:
 *  - PURE functions (isErrorResponse, directiveFor): deterministic, the core logic.
 *  - INTEGRATION: spawn the hook as a PostToolUse process with synthetic stdin and
 *    a controlled env, assert it injects the right directive on an error result and
 *    stays inert on a real answer.
 *
 * NOTE: whether the Claude Code PLATFORM invokes PostToolUse on an MCP
 * transport/missing-result error is unverified (could not force the Conductor
 * bug in a harness — see docs/spikes/claude-code-hook-mutation.md). These tests
 * pin the hook's BEHAVIOR given it is invoked; the platform trigger is the
 * documented residual risk. The hook is inert if never invoked.
 */
import { afterEach, describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  classifyResponse,
  isErrorResponse,
  directiveFor,
} from '../hosts/claude/hooks/auq-error-fallback-hook.ts';

const HOOK = path.resolve(__dirname, '..', 'hosts', 'claude', 'hooks', 'auq-error-fallback-hook.ts');

describe('isErrorResponse — only clear failures, never a real answer', () => {
  test('null / undefined / empty string are failures, but not retryable', () => {
    expect(isErrorResponse(null)).toBe(true);
    expect(isErrorResponse(undefined)).toBe(true);
    expect(isErrorResponse('')).toBe(true);
    expect(isErrorResponse('   ')).toBe(true);
    expect(classifyResponse(null).outcome).toBe('non-retryable-error');
    expect(classifyResponse('').outcome).toBe('non-retryable-error');
  });

  test('the SDK missing-result placeholder is ambiguous, not a host failure', () => {
    expect(isErrorResponse('[Tool result missing due to internal error]')).toBe(false);
    expect(classifyResponse('[Tool result missing due to internal error]').outcome)
      .toBe('ambiguous-placeholder');
    expect(classifyResponse('Tool result missing due to internal error.').outcome)
      .toBe('ambiguous-placeholder');
  });

  test('is_error: true and error-field are failures', () => {
    expect(isErrorResponse({ is_error: true })).toBe(true);
    expect(isErrorResponse({ isError: true })).toBe(true);
    expect(isErrorResponse({ error: 'boom' })).toBe(true);
    expect(isErrorResponse({ content: 'Tool result missing due to internal error' })).toBe(false);
    expect(classifyResponse({ isError: true }).outcome).toBe('non-retryable-error');
  });

  test('classifies every explicit Conductor result shape', () => {
    const response = (code: string, retryable: 'yes' | 'no') => ({
      isError: retryable === 'yes',
      content: [{ type: 'text', text: `Error asking the user a question\nError code: ${code}\nRetryable: ${retryable}` }],
    });
    expect(classifyResponse(response('CONDUCTOR_ASK_USER_QUESTION_DELIVERY_FAILED', 'yes')))
      .toEqual({ outcome: 'retryable-error', code: 'CONDUCTOR_ASK_USER_QUESTION_DELIVERY_FAILED' });
    expect(classifyResponse(response('CONDUCTOR_ASK_USER_QUESTION_MALFORMED_ANSWERS', 'yes')).outcome)
      .toBe('retryable-error');
    expect(classifyResponse(response('CONDUCTOR_ASK_USER_QUESTION_ANSWER_COUNT_MISMATCH', 'yes')).outcome)
      .toBe('retryable-error');
    expect(classifyResponse(response('CONDUCTOR_ASK_USER_QUESTION_SESSION_UNAVAILABLE', 'no')))
      .toEqual({ outcome: 'non-retryable-error', code: 'CONDUCTOR_ASK_USER_QUESTION_SESSION_UNAVAILABLE' });
    expect(classifyResponse(response('CONDUCTOR_ASK_USER_QUESTION_USER_CANCELLED', 'no')))
      .toEqual({ outcome: 'cancelled', code: 'CONDUCTOR_ASK_USER_QUESTION_USER_CANCELLED' });
    expect(classifyResponse(response('CONDUCTOR_ASK_USER_QUESTION_UNKNOWN', 'yes')))
      .toEqual({ outcome: 'non-retryable-error', code: 'CONDUCTOR_ASK_USER_QUESTION_UNKNOWN' });
    expect(classifyResponse(response('CONDUCTOR_ASK_USER_QUESTION_DELIVERY_FAILED', 'no')))
      .toEqual({ outcome: 'non-retryable-error', code: 'CONDUCTOR_ASK_USER_QUESTION_DELIVERY_FAILED' });
  });

  test('a real answer is NOT a failure (no false trigger)', () => {
    expect(isErrorResponse({ answers: [{ option_label: 'A' }] })).toBe(false);
    expect(isErrorResponse({ content: [{ type: 'text', text: 'User responses:\nQuestion 1: A' }] })).toBe(false);
    expect(isErrorResponse('A')).toBe(false);
    // a choice that coincidentally contains "error" must not trip it
    expect(isErrorResponse({ answers: [{ option_label: 'Fix the error' }] })).toBe(false);
    expect(isErrorResponse('Investigate the login error')).toBe(false);
  });

  test('Codex review: narrow detection — generic "error"/"is_error" substrings do NOT trigger', () => {
    // A real answer mentioning "internal error" must not be read as a failure.
    expect(isErrorResponse('Investigate the internal error')).toBe(false);
    // A serialized success payload containing the substring is_error:false must not trigger.
    expect(isErrorResponse('{"is_error": false, "answer": "A"}')).toBe(false);
    expect(isErrorResponse({ is_error: false })).toBe(false);
    expect(isErrorResponse({ content: 'The page had an internal error we fixed' })).toBe(false);
  });
});

describe('directiveFor — per-session-kind instruction', () => {
  test('interactive directive demands the prose triad', () => {
    const d = directiveFor('interactive');
    expect(d).toMatch(/ELI10/);
    expect(d).toMatch(/Completeness: X\/10/);
    expect(d).toMatch(/\(recommended\)/);
    expect(d).toMatch(/reply with a letter/i);
    expect(d).toMatch(/STOP/);
  });

  test('headless directive BLOCKs', () => {
    expect(directiveFor('headless')).toMatch(/BLOCKED — AskUserQuestion unavailable/);
  });

  test('spawned directive auto-chooses', () => {
    expect(directiveFor('spawned')).toMatch(/auto-choose/i);
  });

  test('interactive retry directive retries exactly once without prose', () => {
    const d = directiveFor('interactive', 'retry', 'CONDUCTOR_ASK_USER_QUESTION_DELIVERY_FAILED');
    expect(d).toMatch(/retry the SAME AskUserQuestion exactly once/);
    expect(d).toMatch(/Do not emit prose yet/);
    expect(d).toContain('CONDUCTOR_ASK_USER_QUESTION_DELIVERY_FAILED');
  });
});

/** Spawn the hook with synthetic stdin + controlled env; parse its JSON stdout. */
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function stateRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-auq-fallback-'));
  tempRoots.push(root);
  return root;
}

function runHook(
  stdin: object,
  env: Record<string, string>,
  root = stateRoot(),
): { additionalContext?: string } {
  const res = spawnSync('bun', [HOOK], {
    input: JSON.stringify(stdin),
    encoding: 'utf-8',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', GSTACK_STATE_ROOT: root, ...env },
  });
  const parsed = JSON.parse(res.stdout || '{}');
  return parsed.hookSpecificOutput ?? {};
}

describe('hook integration — invoked as PostToolUse', () => {
  const retryableError = {
    isError: true,
    content: [{
      type: 'text',
      text: 'Error asking the user a question\nError code: CONDUCTOR_ASK_USER_QUESTION_DELIVERY_FAILED\nRetryable: yes',
    }],
  };
  const toolCall = {
    session_id: 'session-1',
    tool_use_id: 'tool-1',
    tool_name: 'mcp__conductor__AskUserQuestion',
    tool_input: { questions: [{ question: 'Pick?', options: ['A', 'B'] }] },
  };

  test('retryable error + headless env → injects BLOCK directive', () => {
    const out = runHook(
      { ...toolCall, tool_response: retryableError },
      { GSTACK_HEADLESS: '1' },
    );
    expect(out.additionalContext).toMatch(/BLOCKED — AskUserQuestion unavailable/);
  });

  test('SDK placeholder stays inert and cannot cause duplicate prose', () => {
    const out = runHook(
      { ...toolCall, tool_response: '[Tool result missing due to internal error]' },
      { CONDUCTOR_PORT: '55010' },
    );
    expect(out.additionalContext).toBeUndefined();
  });

  test('retryable error retries exactly once, then falls back to prose', () => {
    const root = stateRoot();
    const first = runHook(
      { ...toolCall, tool_response: retryableError },
      { CONDUCTOR_PORT: '55010' },
      root,
    );
    expect(first.additionalContext).toMatch(/retry the SAME AskUserQuestion exactly once/);

    const second = runHook(
      { ...toolCall, tool_use_id: 'tool-2', tool_response: retryableError },
      { CONDUCTOR_PORT: '55010' },
      root,
    );
    expect(second.additionalContext).toMatch(/render the decision as a PROSE message/i);
    expect(second.additionalContext).toMatch(/Completeness: X\/10/);
    expect(second.additionalContext).toMatch(/Do not call AskUserQuestion again/);
  });

  test('retry exhaustion survives reordered payload keys and an ambiguous SDK placeholder', () => {
    const root = stateRoot();
    const first = runHook(
      { ...toolCall, tool_response: retryableError },
      { CONDUCTOR_PORT: '55010' },
      root,
    );
    expect(first.additionalContext).toMatch(/retry the SAME AskUserQuestion exactly once/);

    const reorderedInput = {
      questions: [{ options: ['A', 'B'], question: 'Pick?' }],
    };
    const placeholder = runHook(
      {
        ...toolCall,
        tool_use_id: 'tool-2',
        tool_input: reorderedInput,
        tool_response: 'Tool result missing due to internal error.',
      },
      { CONDUCTOR_PORT: '55010' },
      root,
    );
    expect(placeholder.additionalContext).toBeUndefined();

    const exhausted = runHook(
      {
        ...toolCall,
        tool_use_id: 'tool-3',
        tool_input: reorderedInput,
        tool_response: retryableError,
      },
      { CONDUCTOR_PORT: '55010' },
      root,
    );
    expect(exhausted.additionalContext).toMatch(/render the decision as a PROSE message/i);
    expect(exhausted.additionalContext).not.toMatch(/retry the SAME/);
  });

  test.each([
    'CONDUCTOR_ASK_USER_QUESTION_MALFORMED_ANSWERS',
    'CONDUCTOR_ASK_USER_QUESTION_ANSWER_COUNT_MISMATCH',
  ])('%s receives the one allowed retry', (code) => {
    const out = runHook(
      {
        ...toolCall,
        tool_response: {
          isError: true,
          content: [{ type: 'text', text: `Error code: ${code}\nRetryable: yes` }],
        },
      },
      { CONDUCTOR_PORT: '55010' },
    );
    expect(out.additionalContext).toMatch(/retry the SAME AskUserQuestion exactly once/);
    expect(out.additionalContext).toContain(code);
  });

  test('a generic explicit error falls back without retrying', () => {
    const out = runHook(
      { ...toolCall, tool_response: { isError: true, error: 'transport failed' } },
      { CONDUCTOR_PORT: '55010' },
    );
    expect(out.additionalContext).toMatch(/render the decision as a PROSE message/i);
    expect(out.additionalContext).not.toMatch(/retry the SAME/);
  });

  test('successful User responses clears retry exhaustion', () => {
    const root = stateRoot();
    runHook({ ...toolCall, tool_response: retryableError }, { CONDUCTOR_PORT: '55010' }, root);
    const success = runHook(
      { ...toolCall, tool_use_id: 'tool-2', tool_response: { content: [{ type: 'text', text: 'User responses:\nQuestion 1: A' }] } },
      { CONDUCTOR_PORT: '55010' },
      root,
    );
    expect(success.additionalContext).toBeUndefined();
    const nextFailure = runHook(
      { ...toolCall, tool_use_id: 'tool-3', tool_response: retryableError },
      { CONDUCTOR_PORT: '55010' },
      root,
    );
    expect(nextFailure.additionalContext).toMatch(/retry the SAME AskUserQuestion exactly once/);
  });

  test('non-retryable session-unavailable error goes straight to prose', () => {
    const out = runHook(
      {
        ...toolCall,
        tool_response: {
          isError: true,
          content: [{ type: 'text', text: 'Error code: CONDUCTOR_ASK_USER_QUESTION_SESSION_UNAVAILABLE\nRetryable: no' }],
        },
      },
      { CONDUCTOR_PORT: '55010' },
    );
    expect(out.additionalContext).toMatch(/render the decision as a PROSE message/i);
    expect(out.additionalContext).not.toMatch(/retry the SAME/);
  });

  test('user cancellation stays inert and does not retry', () => {
    const out = runHook(
      {
        ...toolCall,
        tool_response: {
          content: [{ type: 'text', text: 'User cancelled the question.\nError code: CONDUCTOR_ASK_USER_QUESTION_USER_CANCELLED\nRetryable: no' }],
        },
      },
      { CONDUCTOR_PORT: '55010' },
    );
    expect(out.additionalContext).toBeUndefined();
  });

  test('error result + spawned env → injects auto-choose directive', () => {
    const out = runHook(
      { tool_name: 'AskUserQuestion', tool_response: { is_error: true } },
      { OPENCLAW_SESSION: '1' },
    );
    expect(out.additionalContext).toMatch(/auto-choose/i);
  });

  test('SUCCESSFUL answer → no injection (inert on real answers)', () => {
    const out = runHook(
      { tool_name: 'AskUserQuestion', tool_response: { answers: [{ option_label: 'A' }] } },
      { GSTACK_HEADLESS: '1' },
    );
    expect(out.additionalContext).toBeUndefined();
  });

  test('non-AUQ tool → defers (no injection)', () => {
    const out = runHook(
      { tool_name: 'Bash', tool_response: null },
      { GSTACK_HEADLESS: '1' },
    );
    expect(out.additionalContext).toBeUndefined();
  });
});
