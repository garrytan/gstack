/**
 * PreToolUse enforcement hook (plan-tune cathedral T6) — unit tests.
 *
 * Covers:
 *   - never-ask + marker + two-way + clean recommendation → deny+reason
 *   - never-ask + no marker → defer (D18 marker gate)
 *   - never-ask + one-way → defer (safety override)
 *   - never-ask + ambiguous recommendation → defer (D2 refuse-on-ambiguous)
 *   - always-ask → defer
 *   - no preference → defer
 *   - project preference wins over global (D8 precedence)
 *   - global preference applies when no project preference set
 *   - mcp__*__AskUserQuestion matcher accepted
 *   - empty stdin → defer (crash safety)
 *   - auto-decided event logged via gstack-question-log (PostToolUse won't fire)
 *   - auto-decided marker written to ~/.gstack/sessions/<id>/.auto-decided-<tool_use_id>
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const HOOK = path.join(ROOT, 'hosts', 'claude', 'hooks', 'question-preference-hook');

let stateRoot: string;
let cwdSlug: string;

let fixtureCwd: string;

beforeEach(() => {
  stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-prefhook-'));
  cwdSlug = 'fixture-slug';
  fs.mkdirSync(path.join(stateRoot, 'projects', cwdSlug), { recursive: true });
  // Real directory that the hook can chdir() into. gstack-slug derives the
  // slug from the basename of this cwd (no .git => basename fallback path).
  fixtureCwd = path.join(stateRoot, cwdSlug);
  fs.mkdirSync(fixtureCwd, { recursive: true });
});

afterEach(() => {
  fs.rmSync(stateRoot, { recursive: true, force: true });
});

function writeProjectPref(questionId: string, preference: string): void {
  const f = path.join(stateRoot, 'projects', cwdSlug, 'question-preferences.json');
  let prefs: Record<string, string> = {};
  if (fs.existsSync(f)) prefs = JSON.parse(fs.readFileSync(f, 'utf-8'));
  prefs[questionId] = preference;
  fs.writeFileSync(f, JSON.stringify(prefs, null, 2));
}

function writeGlobalPref(questionId: string, preference: string): void {
  const f = path.join(stateRoot, 'global-question-preferences.json');
  let prefs: Record<string, string> = {};
  if (fs.existsSync(f)) prefs = JSON.parse(fs.readFileSync(f, 'utf-8'));
  prefs[questionId] = preference;
  fs.writeFileSync(f, JSON.stringify(prefs, null, 2));
}

function runHook(stdin: object, cwd?: string): {
  stdout: string;
  stderr: string;
  status: number;
  parsed: any;
} {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env.GSTACK_STATE_ROOT = stateRoot;
  delete env.GSTACK_HOME;
  env.GSTACK_QUESTION_LOG_NO_DERIVE = '1';
  const res = spawnSync(HOOK, [], {
    env,
    input: JSON.stringify({ ...stdin, cwd: cwd || fixtureCwd }),
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

function autoDecidedEvents(): Array<Record<string, unknown>> {
  const f = path.join(stateRoot, 'projects', cwdSlug, 'question-log.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs
    .readFileSync(f, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.source === 'auto-decided');
}

// ----------------------------------------------------------------------
// Defer paths
// ----------------------------------------------------------------------

describe('defers (no enforcement)', () => {
  test('no preference set → defer', () => {
    const r = runHook({
      session_id: 's1',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'tu-1',
      tool_input: {
        questions: [
          { question: '<gstack-qid:test-q> Need approval?', options: ['A) Yes (recommended)', 'B) No'] },
        ],
      },
    });
    expect(r.status).toBe(0);
    expect(r.parsed?.hookSpecificOutput?.permissionDecision).toBe('defer');
  });

  test('marker missing → defer (D18)', () => {
    writeProjectPref('test-q', 'never-ask');
    const r = runHook({
      session_id: 's2',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'tu-2',
      tool_input: {
        questions: [
          { question: 'No marker here', options: ['A) Yes (recommended)', 'B) No'] },
        ],
      },
    });
    expect(r.parsed?.hookSpecificOutput?.permissionDecision).toBe('defer');
  });

  test('always-ask preference → defer', () => {
    writeProjectPref('test-q', 'always-ask');
    const r = runHook({
      session_id: 's3',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'tu-3',
      tool_input: {
        questions: [
          { question: '<gstack-qid:test-q> Yes?', options: ['A) Yes (recommended)', 'B) No'] },
        ],
      },
    });
    expect(r.parsed?.hookSpecificOutput?.permissionDecision).toBe('defer');
  });

  test('empty stdin → defer (crash safety)', () => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    env.GSTACK_STATE_ROOT = stateRoot;
    const res = spawnSync(HOOK, [], { env, input: '', encoding: 'utf-8' });
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout || '{}');
    expect(parsed.hookSpecificOutput?.permissionDecision).toBe('defer');
  });

  test('non-AUQ tool_name → defer (defensive)', () => {
    writeProjectPref('test-q', 'never-ask');
    const r = runHook({ session_id: 's4', tool_name: 'Bash', tool_use_id: 'tu-4', tool_input: {} });
    expect(r.parsed?.hookSpecificOutput?.permissionDecision).toBe('defer');
  });
});

// ----------------------------------------------------------------------
// Enforcement paths (deny+reason)
// ----------------------------------------------------------------------

describe('enforces never-ask preferences', () => {
  test('marker + never-ask + two-way + clean recommendation → deny', () => {
    writeProjectPref('ship-pre-landing-review-fix', 'never-ask');
    const r = runHook({
      session_id: 's5',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'tu-5',
      tool_input: {
        questions: [
          {
            question:
              '<gstack-qid:ship-pre-landing-review-fix> Pre-landing review flagged issue.',
            options: ['A) Fix now (recommended)', 'B) Skip'],
          },
        ],
      },
    });
    expect(r.parsed?.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(r.parsed?.hookSpecificOutput?.permissionDecisionReason).toContain('plan-tune auto-decide');
    expect(r.parsed?.hookSpecificOutput?.permissionDecisionReason).toContain('Fix now');
  });

  test('one-way door → defer even with never-ask (safety override)', () => {
    writeProjectPref('ship-test-failure-triage', 'never-ask');
    const r = runHook({
      session_id: 's6',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'tu-6',
      tool_input: {
        questions: [
          {
            question: '<gstack-qid:ship-test-failure-triage> Tests failed.',
            options: ['A) Fix now (recommended)', 'B) Investigate', 'C) Ack and ship'],
          },
        ],
      },
    });
    expect(r.parsed?.hookSpecificOutput?.permissionDecision).toBe('defer');
  });

  test('ambiguous recommendation (two labels) → defer (D2 refuse-on-ambiguous)', () => {
    writeProjectPref('ship-pre-landing-review-fix', 'never-ask');
    const r = runHook({
      session_id: 's7',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'tu-7',
      tool_input: {
        questions: [
          {
            question: '<gstack-qid:ship-pre-landing-review-fix> Ambiguous',
            options: ['A) Fix now (recommended)', 'B) Skip (recommended)'],
          },
        ],
      },
    });
    expect(r.parsed?.hookSpecificOutput?.permissionDecision).toBe('defer');
  });

  test('no recommendation marker AND no prose match → defer', () => {
    writeProjectPref('ship-pre-landing-review-fix', 'never-ask');
    const r = runHook({
      session_id: 's8',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'tu-8',
      tool_input: {
        questions: [
          {
            question: '<gstack-qid:ship-pre-landing-review-fix> No rec',
            options: ['A) Foo', 'B) Bar'],
          },
        ],
      },
    });
    expect(r.parsed?.hookSpecificOutput?.permissionDecision).toBe('defer');
  });
});

// ----------------------------------------------------------------------
// Precedence (D8)
// ----------------------------------------------------------------------

describe('precedence: project wins over global (D8)', () => {
  test('project never-ask + global always-ask → enforce never-ask', () => {
    writeProjectPref('ship-pre-landing-review-fix', 'never-ask');
    writeGlobalPref('ship-pre-landing-review-fix', 'always-ask');
    const r = runHook({
      session_id: 's9',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'tu-9',
      tool_input: {
        questions: [
          {
            question: '<gstack-qid:ship-pre-landing-review-fix> P?',
            options: ['A) Fix (recommended)', 'B) Skip'],
          },
        ],
      },
    });
    expect(r.parsed?.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  test('only global never-ask → enforce (fallback path)', () => {
    writeGlobalPref('ship-pre-landing-review-fix', 'never-ask');
    const r = runHook({
      session_id: 's10',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'tu-10',
      tool_input: {
        questions: [
          {
            question: '<gstack-qid:ship-pre-landing-review-fix> P?',
            options: ['A) Fix (recommended)', 'B) Skip'],
          },
        ],
      },
    });
    expect(r.parsed?.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  test('project always-ask + global never-ask → defer (project wins)', () => {
    writeProjectPref('ship-pre-landing-review-fix', 'always-ask');
    writeGlobalPref('ship-pre-landing-review-fix', 'never-ask');
    const r = runHook({
      session_id: 's11',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'tu-11',
      tool_input: {
        questions: [
          {
            question: '<gstack-qid:ship-pre-landing-review-fix> P?',
            options: ['A) Fix (recommended)', 'B) Skip'],
          },
        ],
      },
    });
    expect(r.parsed?.hookSpecificOutput?.permissionDecision).toBe('defer');
  });
});

// ----------------------------------------------------------------------
// MCP matcher acceptance
// ----------------------------------------------------------------------

describe('MCP variant', () => {
  test('mcp__conductor__AskUserQuestion accepted and enforced', () => {
    writeProjectPref('ship-pre-landing-review-fix', 'never-ask');
    const r = runHook({
      session_id: 's12',
      tool_name: 'mcp__conductor__AskUserQuestion',
      tool_use_id: 'tu-12',
      tool_input: {
        questions: [
          {
            question: '<gstack-qid:ship-pre-landing-review-fix> P?',
            options: ['A) Fix (recommended)', 'B) Skip'],
          },
        ],
      },
    });
    expect(r.parsed?.hookSpecificOutput?.permissionDecision).toBe('deny');
  });
});

// ----------------------------------------------------------------------
// Auto-decided event logging (since PostToolUse never fires on deny)
// ----------------------------------------------------------------------

describe('auto-decided event tagging', () => {
  test('logs source=auto-decided event when enforcing', () => {
    writeProjectPref('ship-pre-landing-review-fix', 'never-ask');
    runHook({
      session_id: 's13',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'tu-13',
      tool_input: {
        questions: [
          {
            question: '<gstack-qid:ship-pre-landing-review-fix> P?',
            options: ['A) Fix (recommended)', 'B) Skip'],
          },
        ],
      },
    }, fixtureCwd);
    const events = autoDecidedEvents();
    expect(events.length).toBe(1);
    expect(events[0].question_id).toBe('ship-pre-landing-review-fix');
    expect(events[0].user_choice).toContain('Fix');
    expect(events[0].tool_use_id).toBe('tu-13');
  });

  test('writes .auto-decided-<tool_use_id> marker for PostToolUse coordination', () => {
    writeProjectPref('ship-pre-landing-review-fix', 'never-ask');
    runHook({
      session_id: 's14',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'tu-14',
      tool_input: {
        questions: [
          {
            question: '<gstack-qid:ship-pre-landing-review-fix> P?',
            options: ['A) Fix (recommended)', 'B) Skip'],
          },
        ],
      },
    });
    const markerPath = path.join(stateRoot, 'sessions', 's14', '.auto-decided-tu-14');
    expect(fs.existsSync(markerPath)).toBe(true);
  });
});
