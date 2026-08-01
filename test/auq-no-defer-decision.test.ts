/**
 * Tripwire: no PreToolUse hook may emit `permissionDecision: 'defer'`.
 *
 * WHY THIS EXISTS
 * ---------------
 * `defer` reads like a harmless "I have no opinion, let the tool run" no-op. It is
 * not. In Claude Code, a PreToolUse hook returning `defer`:
 *
 *   - in an INTERACTIVE session  → is warned about and ignored (tool runs). Harmless.
 *   - in a NON-INTERACTIVE session (print mode / headless / spawned agent), when the
 *     tool call is solo in its batch → emits `hook_deferred_tool` and returns WITHOUT
 *     EXECUTING THE TOOL.
 *
 * Because our matcher is scoped to `(AskUserQuestion|mcp__.*__AskUserQuestion)` and an
 * AskUserQuestion call is almost always solo, the second path meant EVERY question in
 * every headless/spawned session died as "Tool execution was interrupted" — with no
 * error, no log line, and no hint that a hook was responsible. It reproduced 100% of
 * the time and was invisible to `bun test`, because the unit tests asserted the broken
 * value rather than the observable behavior.
 *
 * The correct way to express "no opinion" is to OMIT `permissionDecision` entirely.
 * Claude Code branches on `if (hookSpecificOutput.permissionDecision)`, so an absent
 * field falls through to the normal permission flow in BOTH modes. `additionalContext`
 * is delivered on a separate event and still works without a decision field.
 *
 * `deny` remains valid and is untouched — the auto-decide and Conductor prose paths
 * still rely on it.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const HOOK_DIR = path.join(ROOT, 'hosts', 'claude', 'hooks');
const TEST_DIR = path.join(ROOT, 'test');
const HOOK = path.join(HOOK_DIR, 'question-preference-hook');

/** Strip line and block comments so prose explaining the ban doesn't trip the ban. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('PreToolUse hooks never emit permissionDecision=defer', () => {
  test('no hook source contains a live defer decision', () => {
    const offenders: string[] = [];
    for (const file of fs.readdirSync(HOOK_DIR)) {
      if (!file.endsWith('.ts')) continue;
      const code = stripComments(
        fs.readFileSync(path.join(HOOK_DIR, file), 'utf-8'),
      );
      if (/permissionDecision\s*:\s*['"`]defer['"`]/.test(code)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  // The original bug survived a fully green suite because 14 assertions across
  // three test files asserted `toBe('defer')`. The tests encoded the bug as the
  // spec, so fixing the hook looked like breaking the tests. Ban the assertion.
  test('no test re-encodes the defer decision as expected behavior', () => {
    const offenders: string[] = [];
    for (const file of fs.readdirSync(TEST_DIR)) {
      if (!file.endsWith('.test.ts') || file === path.basename(import.meta.file)) continue;
      const code = stripComments(fs.readFileSync(path.join(TEST_DIR, file), 'utf-8'));
      if (/permissionDecision\s*\)?\s*\.toBe\(\s*['"`]defer['"`]\s*\)/.test(code)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('question-preference-hook pass-through emits no decision', () => {
  let stateRoot: string;
  let fixtureCwd: string;

  beforeEach(() => {
    stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-nodefer-'));
    fixtureCwd = path.join(stateRoot, 'fixture-slug');
    fs.mkdirSync(path.join(stateRoot, 'projects', 'fixture-slug'), { recursive: true });
    fs.mkdirSync(fixtureCwd, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  });

  function run(stdin: string): Record<string, any> {
    // Hermetic env, mirroring test/question-preference-hook.test.ts. Without
    // this the hook reads the operator's real preference files (a stored
    // never-ask could produce a deny) and, inside Conductor, the ambient
    // CONDUCTOR_* markers flip every pass-through into the [conductor] prose
    // deny. Either would fail this test for a reason unrelated to the invariant.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    env.GSTACK_STATE_ROOT = stateRoot;
    delete env.GSTACK_HOME;
    delete env.CONDUCTOR_WORKSPACE_PATH;
    delete env.CONDUCTOR_PORT;
    env.GSTACK_QUESTION_LOG_NO_DERIVE = '1';

    // Empty stdin must stay byte-empty; the crash-safety path is what's under test.
    const input = stdin
      ? JSON.stringify({ ...JSON.parse(stdin), cwd: fixtureCwd })
      : stdin;

    const res = spawnSync(HOOK, [], {
      env,
      input,
      encoding: 'utf-8',
      cwd: ROOT,
      timeout: 15000,
    });
    expect(res.status).toBe(0);
    return JSON.parse(res.stdout);
  }

  const auq = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion',
    tool_input: {
      questions: [
        {
          question: 'Which approach?',
          header: 'Approach',
          multiSelect: false,
          options: [
            { label: 'A', description: 'first' },
            { label: 'B', description: 'second' },
          ],
        },
      ],
    },
  });

  test.each([
    ['plain AskUserQuestion with no stored preference', auq],
    ['empty stdin (crash safety)', ''],
    [
      'non-AUQ tool (defensive)',
      JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} }),
    ],
  ])('%s → hookSpecificOutput carries no permissionDecision', (_label, stdin) => {
    const out = run(stdin);
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
    // The key must be ABSENT, not present-and-undefined — a serialized
    // `"permissionDecision": null` would still hit Claude Code's validator.
    expect('permissionDecision' in out.hookSpecificOutput).toBe(false);
  });
});
