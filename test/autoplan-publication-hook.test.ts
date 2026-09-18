import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const ROOT = path.join(import.meta.dir, '..');
const SHIM = path.join(ROOT, 'autoplan/bin/phase-publication-hook');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const input = { hook_event_name: 'PreToolUse', session_id: 'parent', cwd: ROOT,
  transcript_path: path.join(ROOT, 'missing-config/projects/project/parent.jsonl'), tool_name: 'Read',
  tool_use_id: 'current', tool_input: { file_path: path.join(ROOT, 'autoplan/sections/design-phase.md') } };
function run(bytes: string, shim = SHIM, env = process.env) {
  const child = spawnSync('bash', [shim], { input: bytes, encoding: 'utf8', timeout: 8_000,
    env: { ...env, PATH: `${path.dirname(process.execPath)}:${env.PATH ?? ''}` } });
  expect(child.signal).toBeNull(); expect(child.stdout.trim().split('\n')).toHaveLength(1);
  return { child, output: JSON.parse(child.stdout) };
}

describe('Autoplan hook transport', () => {
  test('ordinary project and non-Read tools abstain without a parent journal', () => {
    expect(run(JSON.stringify({ ...input, tool_name: 'Bash' })).output).toEqual({});
    expect(run(JSON.stringify({ ...input, tool_input: { file_path: path.join(ROOT, 'autoplan/sections/phase-close.md') } })).output).toEqual({});
  });
  test('invalid input fails closed with one nested native denial', () => {
    const { child, output } = run('{'); expect(child.status).toBe(0);
    expect(output.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
  });
  test('missing current journal is evidence unavailable, not a claim that publication is missing', () => {
    const { child, output } = run(JSON.stringify(input)); expect(child.status).toBe(0);
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain('no missing-publication conclusion');
  });
  test('missing TypeScript helper cannot silently allow a phase Read', () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'autoplan-hook-missing-')); dirs.push(dir);
    const shim = path.join(dir, 'phase-publication-hook'); fs.copyFileSync(SHIM, shim);
    const { output } = run(JSON.stringify(input), shim);
    expect(output.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain('hook unavailable');
  });
  test('unknown child input does not publish or answer anything', () => {
    const { output } = run(JSON.stringify({ ...input, agent_id: 'reviewer-child' })); expect(output).toEqual({});
  });
});
