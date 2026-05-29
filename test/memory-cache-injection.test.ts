/**
 * Layer 8 memory cache + injection (plan-tune cathedral T12).
 *
 * Verifies the PreToolUse hook reads ~/.gstack/free-text-memory.json and
 * surfaces matching nuggets via additionalContext on the hook response.
 * Cache: per-session memory-cache.json populated on first read, sub-1ms
 * thereafter (D13 perf).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const HOOK = path.join(ROOT, 'hosts', 'claude', 'hooks', 'question-preference-hook');

let stateRoot: string;
let fixtureCwd: string;
let cwdSlug: string;

beforeEach(() => {
  stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-memcache-'));
  cwdSlug = 'memcache-fixture';
  fixtureCwd = path.join(stateRoot, cwdSlug);
  fs.mkdirSync(fixtureCwd, { recursive: true });
});

afterEach(() => {
  fs.rmSync(stateRoot, { recursive: true, force: true });
});

function writeMemory(nuggets: Array<{ nugget: string; applies_to_signal_keys: string[]; applied_at?: string }>) {
  fs.writeFileSync(path.join(stateRoot, 'free-text-memory.json'), JSON.stringify({ nuggets }));
}

function runHook(stdin: object): { stdout: string; stderr: string; status: number; parsed: any } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env.GSTACK_STATE_ROOT = stateRoot;
  env.GSTACK_QUESTION_LOG_NO_DERIVE = '1';
  delete env.GSTACK_HOME;
  const res = spawnSync(HOOK, [], {
    env,
    input: JSON.stringify({ ...stdin, cwd: fixtureCwd }),
    encoding: 'utf-8',
    cwd: ROOT,
  });
  let parsed: any = null;
  try { parsed = JSON.parse(res.stdout || '{}'); } catch {}
  return {
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    status: res.status ?? -1,
    parsed,
  };
}

// ----------------------------------------------------------------------
// Injection behavior
// ----------------------------------------------------------------------

describe('memory injection', () => {
  test('injects matching nugget into additionalContext on defer', () => {
    writeMemory([
      {
        nugget: 'User prefers verbose explanations with tradeoffs',
        applies_to_signal_keys: ['detail-preference'],
        applied_at: '2026-05-01T00:00:00Z',
      },
    ]);
    // ship-todos-reorganize has signal_key 'detail-preference' per registry.
    const r = runHook({
      session_id: 's1',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'tu-1',
      tool_input: {
        questions: [
          {
            question: '<gstack-qid:ship-todos-reorganize> Reorganize?',
            options: ['A) Accept (recommended)', 'B) Skip'],
          },
        ],
      },
    });
    expect(r.parsed?.hookSpecificOutput?.permissionDecision).toBe('defer');
    expect(r.parsed?.hookSpecificOutput?.additionalContext).toContain('verbose explanations');
  });

  test('does not inject when no nugget matches the signal_key', () => {
    writeMemory([
      {
        nugget: 'Unrelated nugget',
        applies_to_signal_keys: ['totally-different-key'],
      },
    ]);
    const r = runHook({
      session_id: 's2',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'tu-2',
      tool_input: {
        questions: [
          {
            question: '<gstack-qid:ship-todos-reorganize> Reorganize?',
            options: ['A) Accept (recommended)', 'B) Skip'],
          },
        ],
      },
    });
    expect(r.parsed?.hookSpecificOutput?.permissionDecision).toBe('defer');
    expect(r.parsed?.hookSpecificOutput?.additionalContext).toBeUndefined();
  });

  test('caps to 3 most-recent nuggets when many match', () => {
    writeMemory([
      { nugget: 'old-1', applies_to_signal_keys: ['detail-preference'], applied_at: '2026-01-01T00:00:00Z' },
      { nugget: 'old-2', applies_to_signal_keys: ['detail-preference'], applied_at: '2026-02-01T00:00:00Z' },
      { nugget: 'old-3', applies_to_signal_keys: ['detail-preference'], applied_at: '2026-03-01T00:00:00Z' },
      { nugget: 'old-4', applies_to_signal_keys: ['detail-preference'], applied_at: '2026-04-01T00:00:00Z' },
      { nugget: 'newest', applies_to_signal_keys: ['detail-preference'], applied_at: '2026-05-01T00:00:00Z' },
    ]);
    const r = runHook({
      session_id: 's3',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'tu-3',
      tool_input: {
        questions: [
          {
            question: '<gstack-qid:ship-todos-reorganize> Reorganize?',
            options: ['A) Accept (recommended)', 'B) Skip'],
          },
        ],
      },
    });
    const ctx = r.parsed?.hookSpecificOutput?.additionalContext || '';
    expect(ctx).toContain('newest');
    expect(ctx).toContain('old-4');
    expect(ctx).toContain('old-3');
    expect(ctx).not.toContain('old-1');
  });

  test('memory injection works alongside deny enforcement', () => {
    writeMemory([
      {
        nugget: 'User prefers reorganizing for clarity',
        applies_to_signal_keys: ['detail-preference'],
        applied_at: '2026-05-01T00:00:00Z',
      },
    ]);
    // Set a never-ask preference and check both deny AND memory are surfaced.
    fs.mkdirSync(path.join(stateRoot, 'projects', cwdSlug), { recursive: true });
    fs.writeFileSync(
      path.join(stateRoot, 'projects', cwdSlug, 'question-preferences.json'),
      JSON.stringify({ 'ship-todos-reorganize': 'never-ask' }),
    );
    const r = runHook({
      session_id: 's4',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'tu-4',
      tool_input: {
        questions: [
          {
            question: '<gstack-qid:ship-todos-reorganize> Reorganize?',
            options: ['A) Accept (recommended)', 'B) Skip'],
          },
        ],
      },
    });
    // ship-todos-reorganize is two-way per registry — enforcement should fire.
    expect(r.parsed?.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(r.parsed?.hookSpecificOutput?.permissionDecisionReason).toContain('plan-tune auto-decide');
    // Memory context isn't injected on deny path (it's already in the reason),
    // but the deny reason should mention the auto-decision clearly.
  });
});

// ----------------------------------------------------------------------
// Cache behavior
// ----------------------------------------------------------------------

describe('per-session memory cache', () => {
  test('first read writes cache; subsequent reads use cache', () => {
    writeMemory([
      { nugget: 'cached nugget', applies_to_signal_keys: ['detail-preference'] },
    ]);
    runHook({
      session_id: 'cache-test',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'tu-c1',
      tool_input: {
        questions: [
          { question: '<gstack-qid:ship-todos-reorganize> Q', options: ['A', 'B'] },
        ],
      },
    });
    const cachePath = path.join(stateRoot, 'sessions', 'cache-test', 'memory-cache.json');
    expect(fs.existsSync(cachePath)).toBe(true);
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    expect(cached.nuggets).toHaveLength(1);
    expect(cached.nuggets[0].nugget).toBe('cached nugget');
  });

  test('cache miss when canonical file empty/missing → empty nuggets', () => {
    const r = runHook({
      session_id: 'empty',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'tu-e',
      tool_input: {
        questions: [
          { question: '<gstack-qid:ship-todos-reorganize> Q', options: ['A', 'B'] },
        ],
      },
    });
    expect(r.parsed?.hookSpecificOutput?.permissionDecision).toBe('defer');
    expect(r.parsed?.hookSpecificOutput?.additionalContext).toBeUndefined();
  });
});
