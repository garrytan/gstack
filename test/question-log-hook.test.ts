/**
 * PostToolUse hook (plan-tune cathedral T5) — unit tests.
 *
 * Feeds the hook synthetic Claude Code hook payloads via stdin and asserts
 * the resulting question-log.jsonl reflects the right schema. Covers:
 *   - Marker-first question_id (D18 progressive markers)
 *   - Hash fallback when no marker
 *   - source=hook tagging
 *   - source=auq-other when free_text present
 *   - Dedup on (source, tool_use_id) composite (D3)
 *   - Hook exits 0 even on malformed input (never blocks user session)
 *   - mcp__*__AskUserQuestion matcher acceptance
 *   - "(recommended)" label parse → recommended field populated
 *   - Refuse-on-ambiguous: two (recommended) labels → recommended omitted
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const HOOK = path.join(ROOT, 'hosts', 'claude', 'hooks', 'question-log-hook');

let stateRoot: string;

beforeEach(() => {
  stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-hooklog-'));
  // Pre-create slug-resolved project dir so the bin's gstack-slug doesn't
  // recompute every time.
});

afterEach(() => {
  fs.rmSync(stateRoot, { recursive: true, force: true });
});

function runHook(stdin: object): { stdout: string; stderr: string; status: number } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env.GSTACK_STATE_ROOT = stateRoot;
  delete env.GSTACK_HOME;
  env.GSTACK_QUESTION_LOG_NO_DERIVE = '1';
  const res = spawnSync(HOOK, [], {
    env,
    input: JSON.stringify(stdin),
    encoding: 'utf-8',
    cwd: ROOT,
  });
  return {
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    status: res.status ?? -1,
  };
}

function readLog(): Array<Record<string, unknown>> {
  const projectDirs = fs.existsSync(path.join(stateRoot, 'projects'))
    ? fs.readdirSync(path.join(stateRoot, 'projects'))
    : [];
  const all: Array<Record<string, unknown>> = [];
  for (const d of projectDirs) {
    const f = path.join(stateRoot, 'projects', d, 'question-log.jsonl');
    if (!fs.existsSync(f)) continue;
    const lines = fs.readFileSync(f, 'utf-8').trim().split('\n').filter(Boolean);
    for (const l of lines) {
      try {
        all.push(JSON.parse(l));
      } catch {
        // skip malformed
      }
    }
  }
  return all;
}

// ----------------------------------------------------------------------
// Native AskUserQuestion capture
// ----------------------------------------------------------------------

describe('PostToolUse hook (native AskUserQuestion)', () => {
  test('captures one event per question with source=hook and tool_use_id', () => {
    const r = runHook({
      session_id: 'sess1',
      hook_event_name: 'PostToolUse',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'tu-1',
      tool_input: {
        questions: [
          {
            question: 'D1 — Test capture\nRecommendation: A',
            options: ['A) Accept (recommended)', 'B) Reject'],
            multiSelect: false,
          },
        ],
      },
      tool_response: {
        answers: [{ option_label: 'A) Accept (recommended)' }],
      },
      cwd: ROOT,
    });
    expect(r.status).toBe(0);
    const events = readLog();
    expect(events.length).toBe(1);
    expect(events[0].source).toBe('hook');
    expect(events[0].tool_use_id).toBe('tu-1');
    expect(events[0].session_id).toBe('sess1');
    expect(typeof events[0].question_id).toBe('string');
    expect((events[0].question_id as string).startsWith('hook-')).toBe(true);
    expect(events[0].user_choice).toContain('Accept');
    // Recommended parsed from (recommended) label
    expect(events[0].recommended).toContain('Accept');
  });

  test('marker-first question_id when <gstack-qid:foo> present', () => {
    runHook({
      session_id: 'sess2',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'tu-2',
      tool_input: {
        questions: [
          {
            question: 'D2 — Marker test <gstack-qid:ship-test-failure-triage>\nRecommendation: A',
            options: ['A) Fix now (recommended)', 'B) Investigate', 'C) Ack and ship'],
          },
        ],
      },
      tool_response: { answers: [{ option_label: 'A) Fix now (recommended)' }] },
      cwd: ROOT,
    });
    const events = readLog();
    expect(events.length).toBe(1);
    expect(events[0].question_id).toBe('ship-test-failure-triage');
    // Marker stripped from summary
    expect((events[0].question_summary as string).includes('<gstack-qid:')).toBe(false);
  });
});

// ----------------------------------------------------------------------
// MCP AskUserQuestion variant (Conductor)
// ----------------------------------------------------------------------

describe('PostToolUse hook (mcp__*__AskUserQuestion variant)', () => {
  test('accepts mcp__conductor__AskUserQuestion tool_name', () => {
    const r = runHook({
      session_id: 'sess3',
      tool_name: 'mcp__conductor__AskUserQuestion',
      tool_use_id: 'tu-3',
      tool_input: {
        questions: [{ question: 'Test', options: ['A', 'B'] }],
      },
      tool_response: { answers: [{ option_label: 'A' }] },
      cwd: ROOT,
    });
    expect(r.status).toBe(0);
    expect(readLog().length).toBe(1);
  });

  test('ignores unrelated tool_name (defensive)', () => {
    const r = runHook({
      session_id: 'sess4',
      tool_name: 'Bash',
      tool_use_id: 'tu-4',
      tool_input: {},
      cwd: ROOT,
    });
    expect(r.status).toBe(0);
    expect(readLog().length).toBe(0);
  });
});

// ----------------------------------------------------------------------
// Free-text capture (Layer 8 dream cycle)
// ----------------------------------------------------------------------

describe('PostToolUse hook (free-text "Other" responses)', () => {
  test('source=auq-other and free_text populated when user types free text', () => {
    runHook({
      session_id: 'sess5',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'tu-5',
      tool_input: {
        questions: [{ question: 'D5 — Other test', options: ['A', 'B'] }],
      },
      tool_response: {
        answers: [
          {
            option_label: 'Other',
            free_text: 'I always include tests with new features',
          },
        ],
      },
      cwd: ROOT,
    });
    const events = readLog();
    expect(events.length).toBe(1);
    expect(events[0].source).toBe('auq-other');
    expect(events[0].free_text).toContain('always include tests');
  });
});

// ----------------------------------------------------------------------
// Dedup
// ----------------------------------------------------------------------

describe('PostToolUse hook (dedup on source + tool_use_id)', () => {
  test('second fire with same (source, tool_use_id) is dropped', () => {
    const payload = {
      session_id: 'sess6',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'tu-6',
      tool_input: { questions: [{ question: 'Dedup test', options: ['A'] }] },
      tool_response: { answers: [{ option_label: 'A' }] },
      cwd: ROOT,
    };
    runHook(payload);
    runHook(payload);
    expect(readLog().length).toBe(1);
  });
});

// ----------------------------------------------------------------------
// Refuse-on-ambiguous (D2 safety)
// ----------------------------------------------------------------------

describe('PostToolUse hook (recommended parser safety)', () => {
  test('two (recommended) labels → recommended field omitted', () => {
    runHook({
      session_id: 'sess7',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'tu-7',
      tool_input: {
        questions: [
          {
            question: 'Ambiguous test',
            options: ['A) Foo (recommended)', 'B) Bar (recommended)'],
          },
        ],
      },
      tool_response: { answers: [{ option_label: 'A) Foo (recommended)' }] },
      cwd: ROOT,
    });
    const events = readLog();
    expect(events.length).toBe(1);
    expect(events[0].recommended).toBeUndefined();
  });
});

// ----------------------------------------------------------------------
// Crash safety
// ----------------------------------------------------------------------

describe('PostToolUse hook (crash safety)', () => {
  test('exits 0 on empty stdin', () => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    env.GSTACK_STATE_ROOT = stateRoot;
    env.GSTACK_QUESTION_LOG_NO_DERIVE = '1';
    const res = spawnSync(HOOK, [], { env, input: '', encoding: 'utf-8' });
    expect(res.status).toBe(0);
  });

  test('exits 0 on malformed JSON', () => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    env.GSTACK_STATE_ROOT = stateRoot;
    env.GSTACK_QUESTION_LOG_NO_DERIVE = '1';
    const res = spawnSync(HOOK, [], {
      env,
      input: 'not json',
      encoding: 'utf-8',
    });
    expect(res.status).toBe(0);
    // Error logged to hook-errors.log
    const errLog = path.join(stateRoot, 'hook-errors.log');
    expect(fs.existsSync(errLog)).toBe(true);
    expect(fs.readFileSync(errLog, 'utf-8')).toContain('stdin parse failed');
  });
});
