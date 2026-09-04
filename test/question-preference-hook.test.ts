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
  // Same reasoning for the spawned markers (#2733): running the suite inside
  // an OpenClaw/spawned-marked session would flip the [conductor] prose deny
  // into the [conductor][spawned] auto-choose deny. Spawned cases opt back in
  // explicitly via extraEnv.
  delete env.OPENCLAW_SESSION;
  delete env.GSTACK_SESSION_KIND;
  env.GSTACK_QUESTION_LOG_NO_DERIVE = '1';
  if (extraEnv) Object.assign(env, extraEnv);
  const res = spawnSync(HOOK, [], {
    env,
    input: JSON.stringify({ ...stdin, cwd: cwd || fixtureCwd }),
    encoding: 'utf-8',
    cwd: ROOT,
    timeout: 30_000,
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
    const res = spawnSync(HOOK, [], { env, input: '', encoding: 'utf-8', timeout: 30_000 });
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

  test('prose deny carries the spawned-subagent escape sentence (#2733)', () => {
    // A per-command env prefix in a subagent's bash can never reach this hook
    // (hooks inherit the harness env), so the deny TEXT must carry the escape
    // hatch — otherwise a marked subagent that slips and calls AUQ is
    // instructed to prose-STOP, recreating the bug through the hook layer.
    const r = runHook({
      session_id: 'c7',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'tu-c7',
      tool_input: {
        questions: [
          { question: '<gstack-qid:test-q> Need approval?', options: ['A) Yes (recommended)', 'B) No'] },
        ],
      },
    }, undefined, CONDUCTOR);
    const reason = r.parsed?.hookSpecificOutput?.permissionDecisionReason ?? '';
    expect(reason).toMatch(/spawned subagent[\s\S]*auto-choose the recommended option/i);
    // Destructive exclusion rides the same sentence (unified semantics).
    expect(reason).toMatch(/destructive or irreversible gate[\s\S]*conservative/i);
  });
});

// ----------------------------------------------------------------------
// Conductor + env-detected spawned: auto-choose deny, not prose (#2733)
// ----------------------------------------------------------------------

describe('Conductor spawned deny (#2733)', () => {
  const Q = {
    questions: [
      { question: '<gstack-qid:test-q> Bump VERSION?', options: ['A) Skip (recommended)', 'B) Bump'] },
    ],
  };

  test('Conductor + OPENCLAW_SESSION → [conductor][spawned] auto-choose deny, not prose', () => {
    const r = runHook(
      { session_id: 's1', tool_name: 'AskUserQuestion', tool_use_id: 'tu-s1', tool_input: Q },
      undefined,
      { CONDUCTOR_PORT: '55070', OPENCLAW_SESSION: '1' },
    );
    expect(r.parsed?.hookSpecificOutput?.permissionDecision).toBe('deny');
    const reason = r.parsed?.hookSpecificOutput?.permissionDecisionReason ?? '';
    expect(reason).toContain('[conductor][spawned]');
    expect(reason).toMatch(/auto-choose the recommended option/i);
    expect(reason).not.toMatch(/reply with a letter/i);
  });

  test('Conductor + GSTACK_SESSION_KIND=spawned env → same auto-choose deny', () => {
    const r = runHook(
      { session_id: 's2', tool_name: 'AskUserQuestion', tool_use_id: 'tu-s2', tool_input: Q },
      undefined,
      { CONDUCTOR_WORKSPACE_PATH: '/Users/x/conductor/ws', GSTACK_SESSION_KIND: 'spawned' },
    );
    expect(r.parsed?.hookSpecificOutput?.permissionDecision).toBe('deny');
    const reason = r.parsed?.hookSpecificOutput?.permissionDecisionReason ?? '';
    expect(reason).toContain('[conductor][spawned]');
    expect(reason).toMatch(/never auto-approve a destructive or irreversible option/i);
  });

  test('Conductor + invalid GSTACK_SESSION_KIND value → prose deny, not spawned (strict-equality fall-through)', () => {
    // spawnedByEnv() mirrors bin/gstack-session-kind step 0: only the exact
    // value "spawned" is honored. A reserved/typo'd value inside Conductor
    // must fall through to the PROSE deny — loosening the comparison to
    // truthiness would auto-choose past a human who IS watching.
    const r = runHook(
      { session_id: 's3', tool_name: 'AskUserQuestion', tool_use_id: 'tu-s3', tool_input: Q },
      undefined,
      { CONDUCTOR_PORT: '55071', GSTACK_SESSION_KIND: 'bogus' },
    );
    expect(r.parsed?.hookSpecificOutput?.permissionDecision).toBe('deny');
    const reason = r.parsed?.hookSpecificOutput?.permissionDecisionReason ?? '';
    expect(reason).not.toContain('[conductor][spawned]');
    expect(reason).toMatch(/reply with a letter/i);
  });

  test('spawned marker WITHOUT Conductor → pass-through (deny branch stays nested under isConductor)', () => {
    // Outside Conductor the tool is reliable; the spawned auto-choose deny is
    // a Conductor-only rescue. Hoisting spawnedByEnv() above isConductor()
    // would deny AUQ in every OpenClaw session regardless of host — pin the
    // nesting.
    const r = runHook(
      {
        session_id: 's4',
        tool_name: 'AskUserQuestion',
        tool_use_id: 'tu-s4',
        tool_input: {
          questions: [
            { question: '<gstack-qid:spawned-nc> Bump VERSION?', options: ['A) Skip (recommended)', 'B) Bump'] },
          ],
        },
      },
      undefined,
      { OPENCLAW_SESSION: '1' },
    );
    expectPassThrough(r);
  });

  test('both hooks source their spawned directive from the shared constant (drift guard)', () => {
    const hooksDir = path.join(ROOT, 'hosts', 'claude', 'hooks');
    for (const f of ['question-preference-hook.ts', 'auq-error-fallback-hook.ts']) {
      const src = fs.readFileSync(path.join(hooksDir, f), 'utf-8');
      expect(src, `${f} must import the shared spawned directive`).toContain("from './spawned-directive'");
    }
  });

  test('spawned deny annotates one-way doors per question (#2733 review)', () => {
    // The auto-choose deny performs no preference lookup, so destructive
    // questions get a deterministic per-question annotation — a destructive
    // option marked (recommended) must not be auto-approved on prose alone.
    const r = runHook(
      {
        session_id: 's3',
        tool_name: 'AskUserQuestion',
        tool_use_id: 'tu-s3',
        tool_input: {
          questions: [
            { question: '<gstack-qid:test-q> Force-push and overwrite the remote branch, deleting its history?', options: ['A) Force-push (recommended)', 'B) Abort'] },
          ],
        },
      },
      undefined,
      { CONDUCTOR_PORT: '55070', OPENCLAW_SESSION: '1' },
    );
    expect(r.parsed?.hookSpecificOutput?.permissionDecision).toBe('deny');
    const reason = r.parsed?.hookSpecificOutput?.permissionDecisionReason ?? '';
    expect(reason).toContain('[conductor][spawned]');
    expect(reason).toMatch(/one-way door detected: Q1/);
    expect(reason).toMatch(/conservative non-destructive option/);
    // The driving env var is named (tamper visibility)...
    expect(reason).toContain('spawned driver: OPENCLAW_SESSION');
    // ...and the machine-resolved gate leaves a forensic record (the deny
    // prevents PostToolUse capture; this branch must log its own events).
    const f = path.join(stateRoot, 'projects', cwdSlug, 'question-log.jsonl');
    const events = fs.existsSync(f)
      ? fs.readFileSync(f, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];
    expect(events.some((e) => e.source === 'spawned-env-deny')).toBe(true);
  });

  test('spawned deny catches a destructive OPTION behind a bland question (codex finding)', () => {
    const r = runHook(
      {
        session_id: 's4',
        tool_name: 'AskUserQuestion',
        tool_use_id: 'tu-s4',
        tool_input: {
          questions: [
            { question: '<gstack-qid:test-q> Proceed with the plan?', options: ['A) Force-push over the remote branch (recommended)', 'B) Abort'] },
          ],
        },
      },
      undefined,
      { CONDUCTOR_PORT: '55070', GSTACK_SESSION_KIND: 'spawned' },
    );
    expect(r.parsed?.hookSpecificOutput?.permissionDecision).toBe('deny');
    const reason = r.parsed?.hookSpecificOutput?.permissionDecisionReason ?? '';
    expect(reason).toMatch(/one-way door detected: Q1/);
    expect(reason).toContain('spawned driver: GSTACK_SESSION_KIND');
  });

  test('cross-surface destructive-policy drift guard: every spawned surface carries the canonical phrase', () => {
    // The conservative-continue destructive policy lives on four surfaces
    // (shared hook constant, AUQ resolver rule, skill-start spawned block,
    // ship dispatch prompt). Phrasings vary; the canonical core must not.
    const surfaces = [
      path.join(ROOT, 'hosts', 'claude', 'hooks', 'spawned-directive.ts'),
      path.join(ROOT, 'hosts', 'claude', 'hooks', 'auq-error-fallback-hook.ts'),
      path.join(ROOT, 'scripts', 'resolvers', 'preamble', 'generate-ask-user-format.ts'),
      path.join(ROOT, 'bin', 'gstack-skill-start'),
      path.join(ROOT, 'ship', 'sections', 'pr-body.md.tmpl'),
    ];
    for (const f of surfaces) {
      const src = fs.readFileSync(f, 'utf-8');
      expect(src, `${path.basename(f)} lost the canonical destructive-policy phrase`).toContain('conservative non-destructive');
    }
  });

  test('spawnedByEnv() parity with bin/gstack-session-kind over the spawned env matrix', () => {
    // spawnedByEnv mirrors session-kind steps 0-1 by hand; this pins the
    // mirror so a new ambient spawned marker added to the script cannot
    // silently leave Conductor-spawned sessions on the prose-STOP path.
    const { spawnedByEnv } = require(path.join(ROOT, 'hosts', 'claude', 'hooks', 'spawned-directive.ts'));
    const BIN = path.join(ROOT, 'bin', 'gstack-session-kind');
    const cases: Array<Record<string, string>> = [
      { OPENCLAW_SESSION: '1' },
      { GSTACK_SESSION_KIND: 'spawned' },
      { GSTACK_SESSION_KIND: 'spawned', GSTACK_HEADLESS: '1' },
      { GSTACK_SESSION_KIND: 'bogus' },
      { GSTACK_SESSION_KIND: 'headless' },
      { CONDUCTOR_PORT: '5' },
      {},
    ];
    for (const env of cases) {
      const scriptKind = spawnSync(BIN, [], {
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
        encoding: 'utf-8',
        timeout: 30_000,
      }).stdout.trim();
      expect(
        spawnedByEnv(env),
        `parity break on env ${JSON.stringify(env)}: script says ${scriptKind}`,
      ).toBe(scriptKind === 'spawned');
    }
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
