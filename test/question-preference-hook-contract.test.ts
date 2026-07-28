/**
 * question-preference-hook output contract (gate, free).
 *
 * The anxiety this kills: Claude Code's PreToolUse contract accepts
 * permissionDecision values `allow` | `deny` | `ask` ONLY — an unknown value
 * fails output validation and aborts the AskUserQuestion call itself. From
 * 2026-07-14 to 2026-07-28 the hook's pass-through path emitted
 * `permissionDecision: 'defer'`, which killed EVERY question in EVERY session
 * ("Stopped — Tool execution was interrupted") while the hook itself exited 0
 * and logged nothing. A broken pass-through is invisible in unit terms and
 * catastrophic in product terms, so the contract is pinned here mechanically:
 *
 *   1. PASS-THROUGH IS SILENCE — a normal unmarked question produces empty
 *      stdout and exit 0. "No opinion" is expressed by emitting nothing, never
 *      by a made-up decision value.
 *   2. ANY EMITTED DECISION IS VALID — every path that does write output must
 *      use a permissionDecision from the allowed set (or omit the key).
 *   3. NON-TARGETS AND GARBAGE STAY SILENT — other tool names and malformed
 *      stdin never produce output that could abort a call.
 *
 * Runs the real hook under bun with a hermetic GSTACK_STATE_ROOT so no user
 * preferences, memory nuggets, or session caches leak into assertions.
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const HOOK = path.resolve(__dirname, '..', 'hosts', 'claude', 'hooks', 'question-preference-hook.ts');
const VALID_DECISIONS = new Set(['allow', 'deny', 'ask']);

function runHook(stdin: string, extraEnv: Record<string, string> = {}) {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qph-contract-'));
  const env: Record<string, string | undefined> = {
    ...process.env,
    GSTACK_STATE_ROOT: stateRoot,
  };
  delete env.CONDUCTOR_WORKSPACE_PATH;
  delete env.CONDUCTOR_PORT;
  Object.assign(env, extraEnv);
  const res = spawnSync('bun', [HOOK], { input: stdin, encoding: 'utf-8', env, timeout: 10_000 });
  fs.rmSync(stateRoot, { recursive: true, force: true });
  return res;
}

function auqPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: 'contract-test',
    hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion',
    tool_use_id: 'toolu_contract',
    cwd: process.cwd(),
    tool_input: {
      questions: [
        {
          question: 'Pick one?',
          header: 'Pick',
          multiSelect: false,
          options: [
            { label: 'A (Recommended)', description: 'first' },
            { label: 'B', description: 'second' },
          ],
        },
      ],
    },
    ...overrides,
  });
}

/** If the hook wrote anything, it must parse and any decision must be valid. */
function assertOutputContract(stdout: string): void {
  if (stdout === '') return;
  const parsed = JSON.parse(stdout);
  const out = parsed.hookSpecificOutput;
  expect(out).toBeDefined();
  if ('permissionDecision' in out) {
    expect(VALID_DECISIONS.has(out.permissionDecision)).toBe(true);
  }
}

describe('question-preference-hook output contract', () => {
  test('pass-through on a normal unmarked question is silent with exit 0', () => {
    const res = runHook(auqPayload());
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
  });

  test('non-AskUserQuestion tools pass through silently', () => {
    const res = runHook(auqPayload({ tool_name: 'Bash' }));
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
  });

  test('malformed stdin passes through silently instead of aborting the call', () => {
    const res = runHook('this is not json{');
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
  });

  test('empty stdin passes through silently', () => {
    const res = runHook('');
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
  });

  test('Conductor transport-avoidance denies with a VALID decision value', () => {
    const res = runHook(auqPayload(), { CONDUCTOR_PORT: '1' });
    expect(res.status).toBe(0);
    expect(res.stdout).not.toBe('');
    const out = JSON.parse(res.stdout).hookSpecificOutput;
    expect(out.permissionDecision).toBe('deny');
    assertOutputContract(res.stdout);
  });

  test('every exercised path satisfies the output contract (no invented decisions)', () => {
    const cases = [
      runHook(auqPayload()),
      runHook(auqPayload({ tool_name: 'mcp__conductor__AskUserQuestion' })),
      runHook(auqPayload(), { CONDUCTOR_PORT: '1' }),
      runHook(auqPayload({ tool_input: { questions: [] } })),
    ];
    for (const res of cases) {
      expect(res.status).toBe(0);
      assertOutputContract(res.stdout);
    }
  });
});
