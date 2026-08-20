/**
 * PreToolUse enforcement hook (plan-tune cathedral T6) — unit tests.
 *
 * Covers:
 *   - never-ask + marker + two-way + clean recommendation → deny+reason
 *   - never-ask + no marker → pass-through (D18 marker gate)
 *   - never-ask + one-way → pass-through (safety override)
 *   - never-ask + ambiguous recommendation → pass-through (D2 refuse-on-ambiguous)
 *   - always-ask → pass-through
 *   - no preference → pass-through
 *   - project preference wins over global (D8 precedence)
 *   - global preference applies when no project preference set
 *   - mcp__*__AskUserQuestion matcher accepted
 *   - empty stdin → pass-through (crash safety)
 *
 * Pass-through contract (#2035/#2006): exit 0 + EXACTLY empty stdout, or
 * additionalContext-only hookSpecificOutput — never a permissionDecision.
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
  // (CONDUCTOR_WORKSPACE_PATH/PORT set) would flip every defer into the
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

/**
 * #2035/#2006 contract: pass-through (abstain) is exit 0 with EXACTLY empty
 * stdout — never a permissionDecision. 'defer' is a real PreToolUse value,
 * but its semantics are pause-for-external-resumption (CC v2.1.89+), so
 * emitting it orphans the tool call in interactive sessions. Exact-empty
 * (not trim) is deliberate: whitespace on stdout is still hook output, and a
 * garbage/partial write must fail this assertion rather than slip past an
 * optional-chained parse.
 */
function expectPassThrough(r: { status: number; stdout: string }): void {
  expect(r.status).toBe(0);
  expect(r.stdout).toBe('');
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

describe('passes through (no enforcement)', () => {
  test('no preference set → pass-through (empty stdout, no permissionDecision)', () => {
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
    expectPassThrough(r);
  });

  test('marker missing → pass-through (D18)', () => {
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
    expectPassThrough(r);
  });

  test('always-ask preference → pass-through', () => {
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
    expectPassThrough(r);
  });

  test('empty stdin → pass-through (crash safety)', () => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    env.GSTACK_STATE_ROOT = stateRoot;
    const res = spawnSync(HOOK, [], { env, input: '', encoding: 'utf-8' });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
  });

  test('non-AUQ tool_name → pass-through (defensive)', () => {
    writeProjectPref('test-q', 'never-ask');
    const r = runHook({ session_id: 's4', tool_name: 'Bash', tool_use_id: 'tu-4', tool_input: {} });
    expectPassThrough(r);
  });

  // #2035 tripwire: no non-deny/non-allow path may EVER put the string
  // "permissionDecision" on stdout. Emitting one on a pass-through path (any
  // value — 'defer' included) hands the platform a decision where the hook
  // has none, and 'defer' specifically pauses the call for a resumption that
  // never comes in interactive sessions.
  test('pass-through stdout never contains "permissionDecision" (#2035)', () => {
    const paths = [
      runHook({
        session_id: 's-trip-1',
        tool_name: 'AskUserQuestion',
        tool_use_id: 'tu-trip-1',
        tool_input: {
          questions: [
            { question: '<gstack-qid:test-q> Approve?', options: ['A) Yes (recommended)', 'B) No'] },
          ],
        },
      }),
      runHook({ session_id: 's-trip-2', tool_name: 'Bash', tool_use_id: 'tu-trip-2', tool_input: {} }),
      runHook({ session_id: 's-trip-3', tool_name: 'AskUserQuestion', tool_use_id: 'tu-trip-3', tool_input: { questions: [] } }),
    ];
    for (const r of paths) {
      expect(r.status).toBe(0);
      expect(r.stdout).not.toContain('"permissionDecision"');
    }
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

  test('one-way door → pass-through even with never-ask (safety override)', () => {
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
    expectPassThrough(r);
  });

  test('ambiguous recommendation (two labels) → pass-through (D2 refuse-on-ambiguous)', () => {
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
    expectPassThrough(r);
  });

  test('no recommendation marker AND no prose match → pass-through', () => {
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
    expectPassThrough(r);
  });

  // #2024: unregistered ids used to default straight to two-way without ever
  // consulting the keyword classifier — an ad-hoc DESTRUCTIVE question with a
  // stored never-ask preference auto-decided. The hook now falls back to
  // classifyQuestion on the question text when the registry lookup misses.
  test('unregistered id + never-ask + destructive text → pass-through (keyword net fires, #2024)', () => {
    writeProjectPref('adhoc-credential-cleanup', 'never-ask');
    const r = runHook({
      session_id: 's-kw-1',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'tu-kw-1',
      tool_input: {
        questions: [
          {
            question: '<gstack-qid:adhoc-credential-cleanup> Reset my secret and proceed?',
            options: ['A) Yes (recommended)', 'B) No'],
          },
        ],
      },
    });
    expectPassThrough(r);
  });

  test('unregistered id + never-ask + benign text → still deny (auto-decide unchanged)', () => {
    writeProjectPref('adhoc-credential-cleanup', 'never-ask');
    const r = runHook({
      session_id: 's-kw-2',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'tu-kw-2',
      tool_input: {
        questions: [
          {
            question: '<gstack-qid:adhoc-credential-cleanup> Reorganize the TODOs file?',
            options: ['A) Yes (recommended)', 'B) No'],
          },
        ],
      },
    });
    expect(r.parsed?.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(r.parsed?.hookSpecificOutput?.permissionDecisionReason).toContain('plan-tune auto-decide');
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

  test('project always-ask + global never-ask → pass-through (project wins)', () => {
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
    expectPassThrough(r);
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

  test('one-way door → deny with prose directive (NOT defer — destructive must reach human via prose)', () => {
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

  test('non-AUQ tool in Conductor → still pass-through (no redirect on unrelated tools)', () => {
    const r = runHook(
      { session_id: 'c6', tool_name: 'Bash', tool_use_id: 'tu-c6', tool_input: {} },
      undefined,
      CONDUCTOR,
    );
    expectPassThrough(r);
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
