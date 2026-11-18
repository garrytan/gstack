/**
 * hosts/claude/hooks/destructive-guard-hook (GST-3110): /careful's destructive-command check as an every-session
 * PreToolUse hook. Its decisions are check-careful.sh's own; an ask names the hook and its off switch, a deny does
 * not; the destructive_guard switch (env, then config, then SWITCH_DEFAULT) turns it off.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SWITCH_DEFAULT } from '../lib/skill-route';
import { ASK_NOTE } from '../hosts/claude/hooks/destructive-guard-hook.ts';

const ROOT = path.resolve(import.meta.dir, '..');
const SHIM = path.join(ROOT, 'hosts', 'claude', 'hooks', 'destructive-guard-hook');
const CHECK = path.join(ROOT, 'careful', 'bin', 'check-careful.sh');

let state = '';
beforeEach(() => { state = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-dguard-')); });
afterEach(() => fs.rmSync(state, { recursive: true, force: true }));

const payload = (command: string, tool = 'Bash') => JSON.stringify({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command } });
const run = (file: string, input: string, env: Record<string, string> = {}) => {
  const r = spawnSync('bash', [file], { input, env: { PATH: process.env.PATH ?? '', HOME: state, GSTACK_STATE_ROOT: state, ...env }, encoding: 'utf8', timeout: 30_000 });
  return { code: r.status, stdout: (r.stdout ?? '').trim(), stderr: r.stderr ?? '' };
};
const decision = (stdout: string) => JSON.parse(stdout).hookSpecificOutput ?? {};

describe('destructive-guard hook', () => {
  test('on by default: an ask keeps check-careful.sh\'s reason and adds the hook and its off switch', () => {
    expect(SWITCH_DEFAULT.destructive_guard).toBe('on');
    const hooked = run(SHIM, payload('rm -rf /var/data'));
    const direct = run(CHECK, payload('rm -rf /var/data'));
    expect(hooked.code).toBe(0);
    expect(decision(hooked.stdout).permissionDecision).toBe('ask');
    expect(decision(hooked.stdout).permissionDecisionReason).toBe(`${decision(direct.stdout).permissionDecisionReason} ${ASK_NOTE}`);
    expect(ASK_NOTE).toContain('gstack-config set destructive_guard off');
  });

  test('a deny is check-careful.sh\'s deny, unchanged, and never names the off switch to the model', () => {
    const hooked = run(SHIM, payload('rm -rf /'));
    expect(hooked.stdout).toBe(run(CHECK, payload('rm -rf /')).stdout);
    expect(decision(hooked.stdout).permissionDecision).toBe('deny');
    expect(hooked.stdout).not.toContain('destructive_guard');
  });

  test('safe commands and the PowerShell tool pass through as check-careful.sh decides', () => {
    expect(run(SHIM, payload('git status')).stdout).toBe(run(CHECK, payload('git status')).stdout);
    expect(decision(run(SHIM, payload('Remove-Item -Recurse -Force C:\\proj', 'PowerShell')).stdout).permissionDecision).toBe('ask');
  });

  test('an interactive session (the claude CLI) gets the ask', () => {
    const r = run(SHIM, payload('rm -rf /var/data'), { CLAUDE_CODE_ENTRYPOINT: 'cli' });
    expect(decision(r.stdout).permissionDecision).toBe('ask');
  });

  test('an interactive Agent SDK host (Conductor, CLAUDE_CODE_ENTRYPOINT=sdk-ts) still gets the ask', () => {
    const r = run(SHIM, payload('rm -rf /var/data'), { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CONDUCTOR_WORKSPACE_PATH: '/tmp/conductor-ws' });
    expect(decision(r.stdout).permissionDecision).toBe('ask');
  });

  test('claude -p and headless sessions get a warning and no decision, so nothing waits on an answer; a deny stays a deny', () => {
    const reason = decision(run(CHECK, payload('rm -rf /var/data')).stdout).permissionDecisionReason;
    for (const env of [{ CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }, { GSTACK_HEADLESS: '1' }] as Record<string, string>[]) {
      const r = run(SHIM, payload('rm -rf /var/data'), env);
      expect(r.code).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.hookSpecificOutput).toBeUndefined();
      expect(out.systemMessage).toBe(`${reason} ${ASK_NOTE} Allowed without asking: this headless session has nobody to answer.`);
      expect(decision(run(SHIM, payload('rm -rf /'), env).stdout).permissionDecision).toBe('deny');
    }
  });

  test('off in env or config prints nothing; env on wins over config off', () => {
    expect(run(SHIM, payload('rm -rf /var/data'), { GSTACK_DESTRUCTIVE_GUARD: 'off' })).toEqual({ code: 0, stdout: '', stderr: '' });
    fs.writeFileSync(path.join(state, 'config.yaml'), 'destructive_guard: off\n');
    expect(run(SHIM, payload('rm -rf /var/data'))).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(decision(run(SHIM, payload('rm -rf /var/data'), { GSTACK_DESTRUCTIVE_GUARD: 'on' }).stdout).permissionDecision).toBe('ask');
  });
});
