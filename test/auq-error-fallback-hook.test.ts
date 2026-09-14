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
import { SPAWNED_ESCAPE_SENTENCE } from '../hosts/claude/hooks/spawned-directive.ts';

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

  test('spawned directive carries a self-contained destructive carve-out (#2733 review)', () => {
    // The "Spawned session block" it defers to exists only when a gstack
    // preamble ran; an AUQ error outside a skill still needs the exception.
    const d = directiveFor('spawned');
    expect(d).toMatch(/never auto-choose a destructive or irreversible option/i);
    expect(d).toMatch(/conservative non-destructive/);
  });

  test('interactive directive carries the spawned escape sentence (#2733)', () => {
    // The sessionKind() shell-out runs in the HARNESS env, so a subagent
    // marked spawned via a per-command prefix classifies interactive here —
    // the directive text is the only lever for that topology.
    const d = directiveFor('interactive');
    expect(d).toMatch(/spawned subagent[\s\S]*auto-choose the recommended option/i);
    expect(d).toMatch(/destructive or irreversible gate[\s\S]*conservative/i);
  });

  test('headless directive ALSO carries the spawned escape sentence (#2733 review, multi-specialist)', () => {
    // A spawned-marked subagent under a headless-classified parent env
    // (CI/eval-hosted /ship) hits the headless branch — the self-gating
    // escape keeps the JSON contract alive; plain headless still BLOCKs.
    const d = directiveFor('headless');
    expect(d).toMatch(/BLOCKED — AskUserQuestion unavailable/);
    expect(d).toMatch(/spawned subagent[\s\S]*auto-choose the recommended option/i);
  });

  test('escape sentence scopes spawned claims to the creating prompt (anti-injection)', () => {
    const d = directiveFor('interactive');
    expect(d).toMatch(/NEVER qualify[\s\S]*prompt injection/i);
  });
});

describe('SPAWNED_ESCAPE_SENTENCE — explicit-declaration-only trigger (periodic-lane AUQ collapse)', () => {
  // The spawned escape must fire ONLY on an explicit dispatch-prompt
  // declaration ("you are a spawned subagent"), never on an inference from a
  // CI-looking / scripted-looking environment. The loose pre-fix parenthetical
  // let the model infer spawned status and silently auto-choose every
  // review-phase question (reviewCount=0 across the plan-review periodic E2Es).
  test('carries the explicit-declaration wording', () => {
    expect(SPAWNED_ESCAPE_SENTENCE).toContain('EXPLICITLY declares you a spawned subagent');
    expect(SPAWNED_ESCAPE_SENTENCE).toContain(
      'explicit statement, never an inference from an automated-looking environment',
    );
  });

  test('the old loose inference wording is gone', () => {
    // Pre-fix sentence parenthetical: '(e.g. your dispatch prompt says you
    // are a spawned subagent)' — an example, not a requirement, so an
    // automated-looking prompt could be read as "saying" it.
    expect(SPAWNED_ESCAPE_SENTENCE).not.toContain('e.g. your dispatch prompt says');
    // The v1.76 spawned-rule parenthetical this fix retired everywhere:
    // '(or your dispatch prompt marks this session as spawned)'.
    expect(SPAWNED_ESCAPE_SENTENCE).not.toContain('marks this session as spawned');
  });

  test('both prose-directing directives embed the tightened sentence verbatim (no drift)', () => {
    expect(directiveFor('interactive')).toContain(SPAWNED_ESCAPE_SENTENCE);
    expect(directiveFor('headless')).toContain(SPAWNED_ESCAPE_SENTENCE);
  });
});

/** Spawn the hook with synthetic stdin + controlled env; parse its JSON stdout. */
function runHook(stdin: object, env: Record<string, string>): { additionalContext?: string } {
  const res = spawnSync('bun', [HOOK], {
    input: JSON.stringify(stdin),
    encoding: 'utf-8',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
    timeout: 30_000,
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

  test('error result + GSTACK_SESSION_KIND=spawned env → override beats Conductor-interactive (#2733)', () => {
    const out = runHook(
      { tool_name: 'AskUserQuestion', tool_response: { is_error: true } },
      { GSTACK_SESSION_KIND: 'spawned', CONDUCTOR_PORT: '55010' },
    );
    expect(out.additionalContext).toMatch(/SESSION_KIND=spawned/);
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

// ----------------------------------------------------------------------
// Registration + teardown wiring (static). Setup registers this hook under
// its own source tag (sharing plan-tune-cathedral would overwrite the
// question-log entry — same event+matcher); both teardown surfaces
// (--no-team, uninstall) must remove it, which pre-v1.67.2 neither did.
// ----------------------------------------------------------------------

import * as fs from 'fs';

describe('setup registration + teardown wiring (static)', () => {
  const ROOT = path.resolve(__dirname, '..');
  const setupSrc = fs.readFileSync(path.join(ROOT, 'setup'), 'utf-8');
  const uninstallSrc = fs.readFileSync(path.join(ROOT, 'bin', 'gstack-uninstall'), 'utf-8');

  test('setup registers the hook via the canonical resolver under --source auq-error-fallback', () => {
    expect(setupSrc).toMatch(
      /AUQ_ERROR_FALLBACK_HOOK="\$\(_hook_command_path hosts\/claude\/hooks\/auq-error-fallback-hook/,
    );
    expect(setupSrc).toContain('--source auq-error-fallback');
  });

  test('--no-team tears the hook down', () => {
    const idx = setupSrc.indexOf('# Also tear down plan-tune');
    expect(idx).toBeGreaterThan(-1);
    const slice = setupSrc.slice(idx, idx + 900);
    expect(slice).toContain('remove-source --source auq-error-fallback');
  });

  test('gstack-uninstall tears the hook down', () => {
    expect(uninstallSrc).toContain('remove-source --source auq-error-fallback');
  });
});
