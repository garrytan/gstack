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
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as path from 'path';
import { isErrorResponse, directiveFor } from '../hosts/claude/hooks/auq-error-fallback-hook.ts';

const HOOK = path.resolve(__dirname, '..', 'hosts', 'claude', 'hooks', 'auq-error-fallback-hook.ts');

describe('isErrorResponse — only clear failures, never a real answer', () => {
  test('null / undefined / empty string are failures', () => {
    expect(isErrorResponse(null)).toBe(true);
    expect(isErrorResponse(undefined)).toBe(true);
    expect(isErrorResponse('')).toBe(true);
    expect(isErrorResponse('   ')).toBe(true);
  });

  test('the Conductor missing-result string is a failure', () => {
    expect(isErrorResponse('[Tool result missing due to internal error]')).toBe(true);
  });

  test('is_error: true / error-field / sentinel-in-content are failures', () => {
    expect(isErrorResponse({ is_error: true })).toBe(true);
    expect(isErrorResponse({ isError: true })).toBe(true);
    expect(isErrorResponse({ error: 'boom' })).toBe(true);
    expect(isErrorResponse({ content: 'Tool result missing due to internal error' })).toBe(true);
  });

  test('a real answer is NOT a failure (no false trigger)', () => {
    expect(isErrorResponse({ answers: [{ option_label: 'A' }] })).toBe(false);
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
});

/** Spawn the hook with synthetic stdin + controlled env; parse its JSON stdout. */
function runHook(stdin: object, env: Record<string, string>): { additionalContext?: string } {
  const res = spawnSync('bun', [HOOK], {
    input: JSON.stringify(stdin),
    encoding: 'utf-8',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
  });
  const parsed = JSON.parse(res.stdout || '{}');
  return parsed.hookSpecificOutput ?? {};
}

describe('hook integration — invoked as PostToolUse', () => {
  test('error result + headless env → injects BLOCK directive', () => {
    const out = runHook(
      { tool_name: 'mcp__conductor__AskUserQuestion', tool_response: '[Tool result missing due to internal error]' },
      { GSTACK_HEADLESS: '1' },
    );
    expect(out.additionalContext).toMatch(/BLOCKED — AskUserQuestion unavailable/);
  });

  test('error result + interactive env → injects prose-triad directive', () => {
    const out = runHook(
      { tool_name: 'AskUserQuestion', tool_response: null },
      { CONDUCTOR_PORT: '55010' },
    );
    expect(out.additionalContext).toMatch(/render the decision as a PROSE message/i);
    expect(out.additionalContext).toMatch(/Completeness: X\/10/);
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
