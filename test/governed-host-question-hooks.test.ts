import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('governed host question hooks', () => {
  test('active governed binding makes both hooks neutral and write-free', () => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'ecpe-hook-')); roots.push(state);
    fs.mkdirSync(path.join(state, 'governed-runs'));
    fs.writeFileSync(path.join(state, 'governed-runs', 'session-1.review.active'), '', { mode: 0o600 });
    const payload = JSON.stringify({ session_id: 'session-1', hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_use_id: 't1', tool_input: { questions: [{ question: 'Proceed? <gstack-qid:proceed>', options: ['Yes (recommended)', 'No'] }] }, tool_response: { answers: { 'Proceed? <gstack-qid:proceed>': 'Yes' } } });
    const root = path.resolve(import.meta.dir, '..');
    for (const hook of ['question-log-hook.ts', 'question-preference-hook.ts']) {
      const result = Bun.spawnSync(['bun', path.join(root, 'hosts/claude/hooks', hook)], { timeout: 30_000, stdin: new TextEncoder().encode(payload), env: { ...process.env, GSTACK_STATE_ROOT: state } });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toBe('');
    }
    expect(fs.readdirSync(state, { recursive: true }).map(String).sort()).toEqual(['governed-runs', 'governed-runs/session-1.review.active']);
  });
});
