/**
 * PreToolUse enforcement hook (plan-tune cathedral T6) — unit tests.
 *
 * Covers:
 *   - never-ask + marker + two-way + clean recommendation → deny+reason
 *   - never-ask + no marker → no decision (D18 marker gate)
 *   - never-ask + one-way → no decision (safety override)
 *   - never-ask + ambiguous recommendation → no decision (D2 refuse-on-ambiguous)
 *   - always-ask → no decision
 *   - no preference → no decision
 *   - project preference wins over global (D8 precedence)
 *   - global preference applies when no project preference set
 *   - mcp__*__AskUserQuestion matcher accepted
 *   - empty stdin → no decision (crash safety)
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

function runHook(stdin: object, cwd?: string, extraEnv?: Record<string, string>): {
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
  // Strip ambient Conductor markers so these cases characterize NON-Conductor
  // behavior deterministically — otherwise running the suite inside Conductor
  // (CONDUCTOR_WORKSPACE_PATH/PORT set) would flip every pass-through into the
  // [conductor] prose deny. The Conductor cases below opt back in explicitly
  // via extraEnv.
  delete env.CONDUCTOR_WORKSPACE_PATH;
  delete env.CONDUCTOR_PORT;
  env.GSTACK_QUESTION_LOG_NO_DERIVE = '1';
  if (extraEnv) Object.assign(env, extraEnv);
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

/** Silent pass-through: no stdout and no permissionDecision. */
function expectNoDecision(r: { stdout: string; parsed: any }): void {
  expect(r.stdout).toBe('');
  expect(r.parsed?.hookSpecificOutput?.permissionDecision).toBeUndefined();
}

// ----------------------------------------------------------------------
// Pass-through paths
// ----------------------------------------------------------------------

describe('passes through (no enforcement)', () => {
  test('no preference set → no decision', () => {
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
    expectNoDecision(r);
  });

  test('marker missing → no decision (D18)', () => {
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
    expectNoDecision(r);
  });

  test('always-ask preference → no decision', () => {
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
    expectNoDecision(r);
  });

  test('empty stdin → no decision (crash safety)', () => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    env.GSTACK_STATE_ROOT = stateRoot;
    const res = spawnSync(HOOK, [], { env, input: '', encoding: 'utf-8' });
    expect(res.status).toBe(0);
    // Crash-safety pass-through: empty stdout only (no permissionDecision).
    expect(res.stdout ?? '').toBe('');
  });

  test('non-AUQ tool_name → no decision (defensive)', () => {
    writeProjectPref('test-q', 'never-ask');
    const r = runHook({ session_id: 's4', tool_name: 'Bash', tool_use_id: 'tu-4', tool_input: {} });
    expectNoDecision(r);
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

  test('one-way door → no decision even with never-ask (safety override)', () => {
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
    expectNoDecision(r);
  });

  test('ambiguous recommendation (two labels) → no decision (D2 refuse-on-ambiguous)', () => {
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
    expectNoDecision(r);
  });

  test('no recommendation marker AND no prose match → no decision', () => {
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
    expectNoDecision(r);
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

  test('project always-ask + global never-ask → no decision (project wins)', () => {
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
    expectNoDecision(r);
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

  // Real failure shape for #2006/#2035/#2292/#2310: non-interactive MCP AUQ
  // with no preference must be silent pass-through (not permissionDecision).
  test('mcp__conductor__AskUserQuestion + no preference → no decision', () => {
    const r = runHook({
      session_id: 's12-passthrough',
      tool_name: 'mcp__conductor__AskUserQuestion',
      tool_use_id: 'tu-12-passthrough',
      tool_input: {
        questions: [
          {
            question: '<gstack-qid:test-q> Need approval?',
            options: ['A) Yes (recommended)', 'B) No'],
          },
        ],
      },
    });
    expect(r.status).toBe(0);
    expectNoDecision(r);
  });
});

// ----------------------------------------------------------------------
// Conductor: deny + prose redirect (transport avoidance, not preference)
// ----------------------------------------------------------------------

describe('Conductor prose redirect', () => {
  const CONDUCTOR = { CONDUCTOR_PORT: '55070' };

  test('two-way, no preference → deny with [conductor] prose directive', () => {
    const r = runHook({
      session_id: 'c1',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'tu-c1',
      tool_input: {
        questions: [
          { question: '<gstack-qid:test-q> Need approval?', options: ['A) Yes (recommended)', 'B) No'] },
        ],
      },
    }, undefined, CONDUCTOR);
    expect(r.parsed?.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(r.parsed?.hookSpecificOutput?.permissionDecisionReason).toContain('[conductor]');
    expect(r.parsed?.hookSpecificOutput?.permissionDecisionReason).toMatch(/do not call askuserquestion/i);
    expect(r.parsed?.hookSpecificOutput?.permissionDecisionReason).toMatch(/reply with a letter/i);
  });

  test('UNMARKED question (modal path) → deny with prose directive', () => {
    const r = runHook({
      session_id: 'c2',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'tu-c2',
      tool_input: {
        questions: [
          { question: 'No marker — an ad-hoc question', options: ['A) Yes (recommended)', 'B) No'] },
        ],
      },
    }, undefined, CONDUCTOR);
    expect(r.parsed?.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(r.parsed?.hookSpecificOutput?.permissionDecisionReason).toContain('[conductor]');
  });

  test('one-way door → deny with prose directive (NOT pass-through — destructive must reach human via prose)', () => {
    const r = runHook({
      session_id: 'c3',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'tu-c3',
      tool_input: {
        questions: [
          {
            question: '<gstack-qid:ship-test-failure-triage> Tests failed.',
            options: ['A) Fix now (recommended)', 'B) Investigate', 'C) Ack and ship'],
          },
        ],
      },
    }, undefined, CONDUCTOR);
    expect(r.parsed?.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(r.parsed?.hookSpecificOutput?.permissionDecisionReason).toContain('[conductor]');
    expect(r.parsed?.hookSpecificOutput?.permissionDecisionReason).toMatch(/typed confirmation/i);
  });

  test('CONDUCTOR_WORKSPACE_PATH alone also triggers the redirect', () => {
    const r = runHook({
      session_id: 'c4',
      tool_name: 'mcp__conductor__AskUserQuestion',
      tool_use_id: 'tu-c4',
      tool_input: {
        questions: [{ question: '<gstack-qid:test-q> Pick?', options: ['A) X (recommended)', 'B) Y'] }],
      },
    }, undefined, { CONDUCTOR_WORKSPACE_PATH: '/Users/x/conductor/ws' });
    expect(r.parsed?.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(r.parsed?.hookSpecificOutput?.permissionDecisionReason).toContain('[conductor]');
  });

  test('PRECEDENCE: full never-ask auto-decide still wins over Conductor prose', () => {
    writeProjectPref('ship-pre-landing-review-fix', 'never-ask');
    const r = runHook({
      session_id: 'c5',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'tu-c5',
      tool_input: {
        questions: [
          {
            question: '<gstack-qid:ship-pre-landing-review-fix> Pre-landing review flagged issue.',
            options: ['A) Fix now (recommended)', 'B) Skip'],
          },
        ],
      },
    }, undefined, CONDUCTOR);
    expect(r.parsed?.hookSpecificOutput?.permissionDecision).toBe('deny');
    // auto-decide reason, NOT the conductor prose reason
    expect(r.parsed?.hookSpecificOutput?.permissionDecisionReason).toContain('plan-tune auto-decide');
    expect(r.parsed?.hookSpecificOutput?.permissionDecisionReason).not.toContain('[conductor]');
  });

  test('non-AUQ tool in Conductor → still no decision (no redirect on unrelated tools)', () => {
    const r = runHook(
      { session_id: 'c6', tool_name: 'Bash', tool_use_id: 'tu-c6', tool_input: {} },
      undefined,
      CONDUCTOR,
    );
    expectNoDecision(r);
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
