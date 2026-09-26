/**
 * bin/gstack-developer-profile — subcommand behavior tests.
 *
 * Covers:
 * - --read (legacy /office-hours KEY: VALUE format, with defaults when no profile)
 * - --migrate (idempotent; preserves sessions + signals_accumulated)
 * - --derive (recomputes inferred from question-log events)
 * - --trace <dim> (shows contributing events)
 * - --gap (declared vs inferred)
 * - --vibe (archetype match from inferred)
 * - --check-mismatch (threshold behavior; requires 10+ samples)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import { QUESTIONS } from '../scripts/question-registry';
import { SIGNAL_MAP } from '../scripts/psychographic-signals';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN_DEV = path.join(ROOT, 'bin', 'gstack-developer-profile');
const BIN_LOG = path.join(ROOT, 'bin', 'gstack-question-log');

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-test-'));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function runDev(...args: string[]): { stdout: string; stderr: string; status: number } {
  const res = spawnSync(BIN_DEV, args, {
    env: { ...process.env, GSTACK_HOME: tmpHome },
    encoding: 'utf-8',
    cwd: ROOT,
    timeout: 30_000,
  });
  return {
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    status: res.status ?? -1,
  };
}

function logQuestion(payload: Record<string, unknown>): number {
  const res = spawnSync(BIN_LOG, [JSON.stringify(payload)], {
    // gstack-question-log fires `--derive` in the background (nohup) after every
    // append. Those writes land on developer-profile.json via tmp+rename, so
    // they race the explicit runDev('--derive') a test then makes — observed as
    // an intermittently EMPTY stdout from the foreground derive. This env var
    // exists for exactly this case; without it, any test that logs several rows
    // and then derives is flaky by construction.
    env: { ...process.env, GSTACK_HOME: tmpHome, GSTACK_QUESTION_LOG_NO_DERIVE: '1' },
    encoding: 'utf-8',
    cwd: ROOT,
    timeout: 30_000,
  });
  return res.status ?? -1;
}

function writeLegacyProfile(sessions: Array<Record<string, unknown>>) {
  const content = sessions.map((s) => JSON.stringify(s)).join('\n') + '\n';
  fs.writeFileSync(path.join(tmpHome, 'builder-profile.jsonl'), content);
}

function readProfile(): Record<string, unknown> {
  const file = path.join(tmpHome, 'developer-profile.json');
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

// -----------------------------------------------------------------------
// --read (defaults + compat)
// -----------------------------------------------------------------------

describe('gstack-developer-profile --read', () => {
  test('emits defaults when no profile exists (creates stub)', () => {
    const r = runDev('--read');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('SESSION_COUNT: 0');
    expect(r.stdout).toContain('TIER: introduction');
    expect(r.stdout).toContain('CROSS_PROJECT: false');
  });

  test('creates a stub profile file when missing', () => {
    runDev('--read');
    const file = path.join(tmpHome, 'developer-profile.json');
    expect(fs.existsSync(file)).toBe(true);
    const p = readProfile();
    expect(p.schema_version).toBe(1);
  });

  test('omits --read flag and still returns default output', () => {
    const r = runDev();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('TIER:');
  });
});

// -----------------------------------------------------------------------
// --migrate (legacy jsonl → unified profile)
// -----------------------------------------------------------------------

describe('gstack-developer-profile --migrate', () => {
  test('migrates 3 sessions with signals, resources, topics', () => {
    writeLegacyProfile([
      {
        date: '2026-03-01',
        mode: 'builder',
        project_slug: 'alpha',
        signals: ['taste', 'agency'],
        resources_shown: ['https://a.example'],
        topics: ['onboarding'],
        design_doc: '/tmp/a.md',
        assignment: 'watch 3 users',
      },
      {
        date: '2026-03-10',
        mode: 'startup',
        project_slug: 'beta',
        signals: ['named_users', 'pushback', 'taste'],
        resources_shown: ['https://b.example'],
        topics: ['fit'],
        design_doc: '/tmp/b.md',
        assignment: 'interview 5',
      },
      {
        date: '2026-04-01',
        mode: 'builder',
        project_slug: 'alpha',
        signals: ['agency'],
        resources_shown: [],
        topics: ['iter'],
        design_doc: '/tmp/c.md',
        assignment: 'ship v1',
      },
    ]);

    const r = runDev('--migrate');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('migrated 3 sessions');

    const p = readProfile() as {
      sessions: Array<{ project_slug: string; signals: string[] }>;
      signals_accumulated: Record<string, number>;
      resources_shown: string[];
      topics: string[];
    };

    expect(p.sessions.length).toBe(3);
    // Accumulated signals are correctly tallied
    expect(p.signals_accumulated.taste).toBe(2);
    expect(p.signals_accumulated.agency).toBe(2);
    expect(p.signals_accumulated.named_users).toBe(1);
    expect(p.signals_accumulated.pushback).toBe(1);
    expect(p.resources_shown.length).toBe(2);
    expect(p.topics.length).toBe(3);
  });

  test('idempotent — second migrate is no-op when profile exists', () => {
    writeLegacyProfile([{ date: '2026-03-01', mode: 'builder', project_slug: 'x', signals: ['taste'] }]);
    runDev('--migrate');
    const p1 = readProfile();
    const r2 = runDev('--migrate');
    expect(r2.stdout).toMatch(/no legacy file|already migrated/);
    const p2 = readProfile();
    // Sessions count should be identical — migration didn't duplicate
    expect((p1 as any).sessions.length).toBe((p2 as any).sessions.length);
  });

  test('archives legacy file after successful migration', () => {
    writeLegacyProfile([{ date: '2026-03-01', mode: 'builder', project_slug: 'x', signals: [] }]);
    runDev('--migrate');
    // Legacy file should be renamed to *.migrated-<timestamp>
    const files = fs.readdirSync(tmpHome);
    const archived = files.filter((f) => f.startsWith('builder-profile.jsonl.migrated-'));
    expect(archived.length).toBe(1);
    // Original name should no longer exist
    expect(fs.existsSync(path.join(tmpHome, 'builder-profile.jsonl'))).toBe(false);
  });

  test('no-op when no legacy file exists', () => {
    const r = runDev('--migrate');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('no legacy file');
  });
});

// -----------------------------------------------------------------------
// --read tier calculation
// -----------------------------------------------------------------------

describe('gstack-developer-profile tier calculation', () => {
  test('1-3 sessions → welcome_back', () => {
    writeLegacyProfile([
      { date: 'x', mode: 'builder', project_slug: 'a', signals: [] },
      { date: 'x', mode: 'builder', project_slug: 'a', signals: [] },
      { date: 'x', mode: 'builder', project_slug: 'a', signals: [] },
    ]);
    runDev('--migrate');
    const r = runDev('--read');
    expect(r.stdout).toContain('TIER: welcome_back');
  });

  test('4-7 sessions → regular', () => {
    const sessions = Array.from({ length: 5 }, () => ({
      date: 'x',
      mode: 'builder',
      project_slug: 'a',
      signals: [],
    }));
    writeLegacyProfile(sessions);
    runDev('--migrate');
    const r = runDev('--read');
    expect(r.stdout).toContain('TIER: regular');
  });

  test('8+ sessions → inner_circle', () => {
    const sessions = Array.from({ length: 9 }, () => ({
      date: 'x',
      mode: 'builder',
      project_slug: 'a',
      signals: [],
    }));
    writeLegacyProfile(sessions);
    runDev('--migrate');
    const r = runDev('--read');
    expect(r.stdout).toContain('TIER: inner_circle');
  });
});

// -----------------------------------------------------------------------
// --derive: inferred dimensions from question-log events
// -----------------------------------------------------------------------

describe('gstack-developer-profile --derive', () => {
  test('derive with no events yields neutral (0.5) dimensions', () => {
    runDev('--derive');
    const p = readProfile() as {
      inferred: { values: Record<string, number>; sample_size: number };
    };
    expect(p.inferred.sample_size).toBe(0);
    expect(p.inferred.values.scope_appetite).toBeCloseTo(0.5, 2);
  });

  test('derive nudges scope_appetite upward after expand choices', () => {
    for (let i = 0; i < 5; i++) {
      expect(
        logQuestion({
          skill: 'plan-ceo-review',
          question_id: 'plan-ceo-review-mode',
          question_summary: 'mode?',
          user_choice: 'expand',
          session_id: `s${i}`,
          ts: `2026-04-0${i + 1}T10:00:00Z`,
        }),
      ).toBe(0);
    }
    runDev('--derive');
    const p = readProfile() as {
      inferred: { values: Record<string, number>; sample_size: number; diversity: Record<string, number> };
    };
    expect(p.inferred.sample_size).toBe(5);
    expect(p.inferred.values.scope_appetite).toBeGreaterThan(0.5);
    expect(p.inferred.diversity.question_ids_covered).toBe(1);
    expect(p.inferred.diversity.skills_covered).toBe(1);
  });

  test('derive nudges scope_appetite downward after reduce choices', () => {
    for (let i = 0; i < 3; i++) {
      logQuestion({
        skill: 'plan-ceo-review',
        question_id: 'plan-ceo-review-mode',
        question_summary: 'mode?',
        user_choice: 'reduce',
        session_id: `s${i}`,
      });
    }
    runDev('--derive');
    const p = readProfile() as { inferred: { values: Record<string, number> } };
    expect(p.inferred.values.scope_appetite).toBeLessThan(0.5);
  });

  test('derive is recomputable — same input, same output', () => {
    for (let i = 0; i < 3; i++) {
      logQuestion({
        skill: 'plan-ceo-review',
        question_id: 'plan-ceo-review-mode',
        question_summary: 'mode?',
        user_choice: 'expand',
        session_id: `s${i}`,
      });
    }
    runDev('--derive');
    const v1 = (readProfile() as any).inferred.values;
    runDev('--derive');
    const v2 = (readProfile() as any).inferred.values;
    expect(v1).toEqual(v2);
  });

  // ---------------------------------------------------------------------
  // Registry-independent autonomy signal — WIRING only.
  // The formula lives in test/plan-tune.test.ts; these prove derive and trace
  // actually call it and agree with each other.
  // ---------------------------------------------------------------------

  /** Path of the project question-log inside the temp GSTACK_HOME. */
  function logPath(): string {
    const projects = path.join(tmpHome, 'projects');
    const slug = fs.readdirSync(projects)[0];
    return path.join(projects, slug, 'question-log.jsonl');
  }

  /**
   * Append pre-formed rows straight to the log.
   *
   * Bulk cases here exercise --derive, not the log writer's validation, and
   * spawning gstack-question-log 260 times costs ~28s against <1s for a single
   * write. Semantics-sensitive cases still go through logQuestion so that
   * followed_recommendation is computed by the binary that owns it.
   */
  function appendRows(rows: Array<Record<string, unknown>>) {
    // Seed via the real binary so the slug directory and file exist.
    logQuestion({
      skill: 'ship',
      question_id: 'seed-row',
      question_summary: 'seed',
      user_choice: 'accept',
      session_id: 'seed',
    });
    const body = rows.map((r) => JSON.stringify({ ts: '2026-04-01T10:00:00Z', ...r })).join('\n') + '\n';
    fs.appendFileSync(logPath(), body);
  }

  function bulk(n: number, row: Record<string, unknown>): Array<Record<string, unknown>> {
    return Array.from({ length: n }, (_, i) => ({ ...row, session_id: `b${i}` }));
  }

  function logFollowed(n: number, followed: number, extra: Record<string, unknown> = {}) {
    for (let i = 0; i < n; i++) {
      logQuestion({
        skill: 'ship',
        question_id: 'adhoc-recommendation-case',
        question_summary: 'q',
        user_choice: i < followed ? 'accept' : 'reject',
        recommended: 'accept',
        session_id: `s${i}`,
        ts: `2026-04-01T10:00:0${i % 10}Z`,
        ...extra,
      });
    }
  }

  test('derive moves autonomy off 0.5 when the user follows recommendations', () => {
    logFollowed(30, 30);
    runDev('--derive');
    const p = readProfile() as { inferred: { values: Record<string, number> } };
    expect(p.inferred.values.autonomy).toBeGreaterThan(0.5);
    // Other dimensions are untouched by this signal.
    expect(p.inferred.values.scope_appetite).toBeCloseTo(0.5, 2);
  });

  test('derive moves autonomy below 0.5 when the user overrides recommendations', () => {
    logFollowed(30, 0);
    runDev('--derive');
    const p = readProfile() as { inferred: { values: Record<string, number> } };
    expect(p.inferred.values.autonomy).toBeLessThan(0.5);
  });

  test('derive is idempotent with the recommendation signal applied', () => {
    logFollowed(30, 28);
    runDev('--derive');
    const v1 = (readProfile() as any).inferred.values;
    runDev('--derive');
    const v2 = (readProfile() as any).inferred.values;
    expect(v1).toEqual(v2);
  });

  test('derive writes contributing_events and derivation_version', () => {
    // The point of these fields: an inferred 0.5 with 0 contributors means
    // "no evidence", not "balanced evidence". Without them the two are
    // indistinguishable, which is how a dead pipeline hid behind a healthy
    // sample_size for two months.
    //
    // MUTATE THIS by deleting the contributing_events write; this reds.
    logFollowed(25, 25);
    runDev('--derive');
    const p = readProfile() as {
      inferred: {
        contributing_events: Record<string, number>;
        derivation_version: string;
        sample_size: number;
      };
    };
    expect(p.inferred.contributing_events.autonomy).toBe(25);
    // A dimension with no evidence reports 0, not a missing key.
    expect(p.inferred.contributing_events.scope_appetite).toBe(0);
    expect(p.inferred.derivation_version).toBeTruthy();
  });

  test('contributing_events counts UNIQUE ROWS, never signal applications', () => {
    // A single row can apply several deltas. Counting applications would
    // overstate the evidence, which is the opposite of this field's purpose.
    //
    // The fixture MUST exercise the registry path, not just the rate signal:
    // an earlier version of this test used rate-only rows, so the registry
    // contributor count was 0 and multiplying it by anything changed nothing.
    // 'review-fix-now' applies deltas to more than one dimension from ONE row,
    // which is exactly the over-count this guards.
    const multiDimId = Object.values(QUESTIONS).find((q) => {
      if (!q.signal_key) return false;
      const choices = SIGNAL_MAP[q.signal_key] ?? {};
      return Object.values(choices).some((ds) => ds.length > 1);
    });
    expect(multiDimId).toBeDefined();
    const choice = Object.entries(SIGNAL_MAP[multiDimId!.signal_key!])
      .find(([, ds]) => ds.length > 1)![0];

    appendRows(
      bulk(10, {
        skill: multiDimId!.skill,
        question_id: multiDimId!.id,
        user_choice: choice,
        recommended: choice,
        followed_recommendation: true,
        source: 'agent',
      }),
    );
    runDev('--derive');
    const p = readProfile() as {
      inferred: { contributing_events: Record<string, number>; sample_size: number };
    };
    // Sanity: the registry path really did contribute here, or the assertion
    // below would pass vacuously the way the old fixture did.
    const touched = Object.values(p.inferred.contributing_events).filter((n) => n > 0);
    expect(touched.length).toBeGreaterThanOrEqual(2);
    for (const n of Object.values(p.inferred.contributing_events)) {
      expect(n).toBeLessThanOrEqual(p.inferred.sample_size);
    }
  });

  test('auto-decided rows do not feed the autonomy signal', () => {
    // Guards the feedback loop: the preference hook auto-picks the
    // recommendation, so counting it as delegation evidence would let the
    // dimension that licenses auto-deciding inflate itself.
    logFollowed(30, 30, { source: 'auto-decided' });
    runDev('--derive');
    const p = readProfile() as {
      inferred: { values: Record<string, number>; contributing_events: Record<string, number> };
    };
    expect(p.inferred.values.autonomy).toBeCloseTo(0.5, 2);
    expect(p.inferred.contributing_events.autonomy).toBe(0);
  });

  test('rows without a recommendation contribute nothing', () => {
    // No `recommended` field means gstack-question-log computes no
    // followed_recommendation, so there is nothing for the signal to read.
    for (let i = 0; i < 20; i++) {
      logQuestion({
        skill: 'ship',
        question_id: 'adhoc-no-recommendation',
        question_summary: 'q',
        user_choice: 'accept',
        session_id: `s${i}`,
      });
    }
    runDev('--derive');
    const p = readProfile() as {
      inferred: { values: Record<string, number>; contributing_events: Record<string, number> };
    };
    expect(p.inferred.values.autonomy).toBeCloseTo(0.5, 2);
    expect(p.inferred.contributing_events.autonomy).toBe(0);
  });

  test('REGRESSION: registry autonomy rows are excluded from the rate tally', () => {
    // totals.autonomy is written by BOTH the per-event SIGNAL_MAP path and the
    // O(1) rate aggregate, so one decision could feed it twice. Precedence:
    // a row already counted by the registry path is excluded from the rate.
    //
    // N=200, not N=1: a single-event check measures coefficient size, not
    // interaction at scale. One /plan-eng-review session produces ~5 mapped
    // events, so 200 is roughly forty sessions — a real steady state.
    //
    // MUTATE THIS by deleting the countedByRegistry() check in
    // isRecommendationEligible; the eligible count jumps to 260 and this reds.
    appendRows([
      ...bulk(200, {
        skill: 'land-and-deploy',
        question_id: 'land-and-deploy-merge-confirm',
        user_choice: 'apply-fix',
        recommended: 'apply-fix',
        followed_recommendation: true,
        source: 'agent',
      }),
      ...bulk(60, {
        skill: 'ship',
        question_id: 'adhoc-rate-evidence',
        user_choice: 'reject',
        recommended: 'accept',
        followed_recommendation: false,
        source: 'hook',
      }),
    ]);

    const r = runDev('--derive');
    expect(r.stdout).toContain('60 recommendation-eligible');

    const p = readProfile() as {
      inferred: { values: Record<string, number>; contributing_events: Record<string, number> };
    };
    // 200 registry rows + 60 rate rows = 260 UNIQUE rows touching autonomy.
    expect(p.inferred.contributing_events.autonomy).toBe(260);
  });

  test('KNOWN LIMITATION: the per-event registry path still swamps the rate signal', () => {
    // This pins a bug we are NOT fixing in this change, so that the day someone
    // does fix it, this test reds and they re-baseline deliberately.
    //
    // normalizeToDimensionValue is a sigmoid over an ACCUMULATED total, so the
    // per-event path grows without bound: 200 'decision-autonomy' events at
    // +0.04 total 8.0, and sigmoid(3 * 8.0) is 1.0 to float precision.
    // Precedence stops the same ROW being counted twice; it does nothing about
    // volume. Measured: with 200 mapped events pointing one way and 60 rate
    // rows pointing the OTHER way, the derived value is 1.0 — while the rate
    // evidence alone would read 0.190. The signal is not merely diluted, it is
    // erased, and the conclusion flips.
    //
    // The real fix is to normalize per-event accumulation (a mean, or damping)
    // so no dimension can saturate. That re-prices every delta in
    // psychographic-signals.ts and belongs in its own change.
    appendRows([
      ...bulk(200, {
        skill: 'land-and-deploy',
        question_id: 'land-and-deploy-merge-confirm',
        user_choice: 'apply-fix',
        recommended: 'apply-fix',
        followed_recommendation: true,
        source: 'agent',
      }),
      ...bulk(60, {
        skill: 'ship',
        question_id: 'adhoc-rate-evidence',
        user_choice: 'reject',
        recommended: 'accept',
        followed_recommendation: false,
        source: 'hook',
      }),
    ]);
    runDev('--derive');
    const p = readProfile() as { inferred: { values: Record<string, number> } };
    expect(p.inferred.values.autonomy).toBe(1);
  });

  test('derive reports the recommendation-eligible count on stdout', () => {
    logFollowed(12, 12);
    const r = runDev('--derive');
    expect(r.stdout).toContain('12 recommendation-eligible');
  });

  test('derive ignores events for questions not in registry (ad-hoc ids)', () => {
    logQuestion({
      skill: 'plan-ceo-review',
      question_id: 'adhoc-unregistered-question',
      question_summary: 'mystery',
      user_choice: 'anything',
      session_id: 's1',
    });
    runDev('--derive');
    const p = readProfile() as { inferred: { values: Record<string, number>; sample_size: number } };
    // Sample size counts the log entry, but no signal delta applied
    expect(p.inferred.sample_size).toBe(1);
    expect(p.inferred.values.scope_appetite).toBeCloseTo(0.5, 2);
  });
});

// -----------------------------------------------------------------------
// --trace
// -----------------------------------------------------------------------

describe('gstack-developer-profile --trace <dim>', () => {
  test('shows contributing events with delta values', () => {
    for (let i = 0; i < 3; i++) {
      logQuestion({
        skill: 'plan-ceo-review',
        question_id: 'plan-ceo-review-mode',
        question_summary: 'mode?',
        user_choice: 'expand',
        session_id: `s${i}`,
      });
    }
    const r = runDev('--trace', 'scope_appetite');
    expect(r.stdout).toContain('3 events for scope_appetite');
    expect(r.stdout).toContain('plan-ceo-review-mode');
    expect(r.stdout).toContain('expand');
  });

  test('reports no contributions for untouched dimension', () => {
    logQuestion({
      skill: 'plan-ceo-review',
      question_id: 'plan-ceo-review-mode',
      question_summary: 'x',
      user_choice: 'expand',
      session_id: 's1',
    });
    const r = runDev('--trace', 'autonomy');
    expect(r.stdout).toContain('no events contribute to autonomy');
  });

  test('names the aggregate for autonomy instead of reporting no events', () => {
    // Without this, --trace autonomy would still say "no events contribute"
    // while --profile showed a moved number — the explain tool disagreeing
    // with the thing it explains.
    for (let i = 0; i < 25; i++) {
      logQuestion({
        skill: 'ship',
        question_id: 'adhoc-recommendation-case',
        question_summary: 'q',
        user_choice: 'accept',
        recommended: 'accept',
        session_id: `s${i}`,
      });
    }
    const r = runDev('--trace', 'autonomy');
    expect(r.stdout).toContain('25 events for autonomy');
    expect(r.stdout).toContain('followed_recommendation');
    expect(r.stdout).toContain('25/25');
    expect(r.stdout).not.toContain('no events contribute');
  });

  test('trace and derive agree on the eligible count', () => {
    // Two separate bun -e blocks read the log. If the eligibility rule ever
    // drifts between them, the explain tool lies about the derived number.
    for (let i = 0; i < 18; i++) {
      logQuestion({
        skill: 'ship',
        question_id: 'adhoc-recommendation-case',
        question_summary: 'q',
        user_choice: i < 15 ? 'accept' : 'reject',
        recommended: 'accept',
        session_id: `s${i}`,
      });
    }
    const traced = runDev('--trace', 'autonomy');
    expect(traced.stdout).toContain('15/18');
    runDev('--derive');
    const p = readProfile() as { inferred: { contributing_events: Record<string, number> } };
    expect(p.inferred.contributing_events.autonomy).toBe(18);
  });

  test('errors without dimension argument', () => {
    const r = runDev('--trace');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('missing dimension');
  });
});

// -----------------------------------------------------------------------
// --gap
// -----------------------------------------------------------------------

describe('gstack-developer-profile --gap', () => {
  test('gap is empty when nothing is declared', () => {
    runDev('--read');
    const r = runDev('--gap');
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.gap).toEqual({});
  });

  test('gap computed when declared and inferred both present', () => {
    runDev('--read');
    const file = path.join(tmpHome, 'developer-profile.json');
    const p = readProfile() as any;
    p.declared = { scope_appetite: 0.8 };
    p.inferred.values.scope_appetite = 0.55;
    fs.writeFileSync(file, JSON.stringify(p));
    const r = runDev('--gap');
    const out = JSON.parse(r.stdout);
    expect(out.gap.scope_appetite).toBeCloseTo(0.25, 2);
  });
});

// -----------------------------------------------------------------------
// --vibe (archetype match)
// -----------------------------------------------------------------------

describe('gstack-developer-profile --vibe', () => {
  test('returns archetype name and description', () => {
    runDev('--read');
    const r = runDev('--vibe');
    expect(r.status).toBe(0);
    const lines = r.stdout.trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(1);
    // Default profile (all 0.5) is closest to Builder-Coach or Polymath
    expect(lines[0].length).toBeGreaterThan(0);
  });
});

// -----------------------------------------------------------------------
// --check-mismatch
// -----------------------------------------------------------------------

describe('gstack-developer-profile --check-mismatch', () => {
  test('reports insufficient data when < 10 events', () => {
    runDev('--read');
    const r = runDev('--check-mismatch');
    expect(r.stdout).toContain('not enough data');
  });

  test('reports no mismatch when declared tracks inferred closely', () => {
    runDev('--read');
    const file = path.join(tmpHome, 'developer-profile.json');
    const p = readProfile() as any;
    p.declared = { scope_appetite: 0.5, architecture_care: 0.5 };
    p.inferred.sample_size = 20;
    fs.writeFileSync(file, JSON.stringify(p));
    const r = runDev('--check-mismatch');
    expect(r.stdout).toContain('MISMATCH: none');
  });

  test('flags dimensions with gap > 0.3 when enough data', () => {
    runDev('--read');
    const file = path.join(tmpHome, 'developer-profile.json');
    const p = readProfile() as any;
    p.declared = { scope_appetite: 0.9, autonomy: 0.2 };
    p.inferred.values.scope_appetite = 0.4;
    p.inferred.values.autonomy = 0.8;
    p.inferred.sample_size = 25;
    fs.writeFileSync(file, JSON.stringify(p));
    const r = runDev('--check-mismatch');
    expect(r.stdout).toContain('2 dimension(s) disagree');
    expect(r.stdout).toContain('scope_appetite');
    expect(r.stdout).toContain('autonomy');
  });
});

// -----------------------------------------------------------------------
// Error handling
// -----------------------------------------------------------------------

describe('gstack-developer-profile errors', () => {
  test('unknown subcommand exits non-zero', () => {
    const r = runDev('--not-a-real-subcommand');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('unknown subcommand');
  });
});

// -----------------------------------------------------------------------
// --log-session — the #1671 fix: writer that matches the reader.
// -----------------------------------------------------------------------

describe('gstack-developer-profile --log-session (#1671 fix)', () => {
  test('regression: read-write-read sequence on fresh $HOME promotes to welcome_back', () => {
    // First --read creates an empty stub (this is the bug-shape on current main).
    const r1 = runDev('--read');
    expect(r1.stdout).toContain('SESSION_COUNT: 0');
    expect(r1.stdout).toContain('TIER: introduction');

    // Office-hours writes a session via the new subcommand.
    const r2 = runDev('--log-session', JSON.stringify({
      date: '2026-05-23T00:00:00Z',
      mode: 'startup',
      project_slug: 'test',
      signal_count: 2,
      signals: ['s1', 's2'],
    }));
    expect(r2.status).toBe(0);

    // Second --read sees the session — this is what was broken.
    const r3 = runDev('--read');
    expect(r3.stdout).toContain('SESSION_COUNT: 1');
    expect(r3.stdout).toContain('TIER: welcome_back');
    expect(r3.stdout).toContain('LAST_PROJECT: test');
    expect(r3.stdout).toContain('TOTAL_SIGNAL_COUNT: 2');
  });

  test('aggregates signals across multiple sessions', () => {
    runDev('--log-session', JSON.stringify({
      date: '2026-05-20T00:00:00Z', mode: 'startup', project_slug: 'p', signals: ['a', 'b'],
    }));
    runDev('--log-session', JSON.stringify({
      date: '2026-05-21T00:00:00Z', mode: 'startup', project_slug: 'p', signals: ['a', 'c'],
    }));
    const p = readProfile() as { sessions: unknown[]; signals_accumulated: Record<string, number> };
    expect(p.sessions.length).toBe(2);
    expect(p.signals_accumulated).toEqual({ a: 2, b: 1, c: 1 });
  });

  test('aggregates resources_shown and topics as deduped unions', () => {
    runDev('--log-session', JSON.stringify({
      date: '2026-05-20T00:00:00Z', mode: 'resources', project_slug: 'p',
      resources_shown: ['url1', 'url2'], topics: ['ai'],
    }));
    runDev('--log-session', JSON.stringify({
      date: '2026-05-21T00:00:00Z', mode: 'resources', project_slug: 'p',
      resources_shown: ['url2', 'url3'], topics: ['ai', 'eng'],
    }));
    const p = readProfile() as { resources_shown: string[]; topics: string[] };
    expect(p.resources_shown.sort()).toEqual(['url1', 'url2', 'url3']);
    expect(p.topics.sort()).toEqual(['ai', 'eng']);
  });

  test('silently skips invalid JSON input (matches gstack-timeline-log pattern)', () => {
    const r = runDev('--log-session', 'not-json');
    expect(r.status).toBe(0); // silent skip, not error
    const file = path.join(tmpHome, 'developer-profile.json');
    expect(fs.existsSync(file)).toBe(false); // no stub created either
  });

  test('silently skips JSON missing required fields', () => {
    const r = runDev('--log-session', JSON.stringify({ foo: 'bar' }));
    expect(r.status).toBe(0);
    const file = path.join(tmpHome, 'developer-profile.json');
    expect(fs.existsSync(file)).toBe(false);
  });

  test('injects ts field if missing', () => {
    runDev('--log-session', JSON.stringify({
      date: '2026-05-23T00:00:00Z', mode: 'startup', project_slug: 'p',
    }));
    const p = readProfile() as { sessions: Array<{ ts: string }> };
    expect(p.sessions[0].ts).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test('preserves user-set ts field if provided', () => {
    runDev('--log-session', JSON.stringify({
      date: '2026-05-23T00:00:00Z', mode: 'startup', project_slug: 'p',
      ts: '2026-05-23T12:34:56Z',
    }));
    const p = readProfile() as { sessions: Array<{ ts: string }> };
    expect(p.sessions[0].ts).toBe('2026-05-23T12:34:56Z');
  });

  test('do_read picks LAST_* from real sessions, not from a trailing mode:resources entry', () => {
    // The Phase 6 resources auto-append happens AFTER the real session in the
    // same /office-hours invocation. Without the mode filter, that resources
    // entry would clobber LAST_PROJECT/LAST_ASSIGNMENT/LAST_DESIGN_TITLE for
    // the next session.
    runDev('--log-session', JSON.stringify({
      date: '2026-05-20T00:00:00Z',
      mode: 'startup',
      project_slug: 'realproj',
      assignment: 'real assignment text',
      design_doc: 'plans/real.md',
    }));
    runDev('--log-session', JSON.stringify({
      date: '2026-05-20T01:00:00Z',
      mode: 'resources',
      project_slug: 'realproj',
      assignment: '',
      design_doc: '',
      resources_shown: ['url1'],
    }));

    const r = runDev('--read');
    expect(r.stdout).toContain('LAST_PROJECT: realproj');
    expect(r.stdout).toContain('LAST_ASSIGNMENT: real assignment text');
    expect(r.stdout).toContain('LAST_DESIGN_TITLE: plans/real.md');
    // Resources still aggregate into RESOURCES_SHOWN.
    expect(r.stdout).toContain('RESOURCES_SHOWN: url1');
  });
});

// -----------------------------------------------------------------------
// SESSION_COUNT / TIER / NUDGE_ELIGIBLE must ignore mode:resources entries.
//
// Phase 6 of /office-hours auto-appends one (or more) mode:resources bookkeeping
// entries every run, to dedupe which founder-resource links the user has seen.
// Those are not sessions. Counting them inflated SESSION_COUNT (and therefore
// TIER) and pushed NUDGE_ELIGIBLE over its threshold from bookkeeping alone —
// e.g. a single real session plus three closings reported as tier `regular`
// with the builder->founder nudge armed.
// -----------------------------------------------------------------------

describe('gstack-developer-profile resources entries do not inflate count/tier/nudge', () => {
  function logStartup(extra: Record<string, unknown> = {}) {
    return runDev('--log-session', JSON.stringify({
      date: '2026-05-20T00:00:00Z', mode: 'startup', project_slug: 'p',
      signal_count: 5, signals: ['a', 'b', 'c', 'd', 'e'], ...extra,
    }));
  }
  function logResources(i: number) {
    return runDev('--log-session', JSON.stringify({
      date: '2026-05-20T01:00:00Z', mode: 'resources', project_slug: 'p',
      resources_shown: [`url${i}`],
    }));
  }

  test('SESSION_COUNT counts only real sessions, not resources entries', () => {
    logStartup();
    logResources(1);
    logResources(2);
    logResources(3);
    const r = runDev('--read');
    expect(r.stdout).toContain('SESSION_COUNT: 1');
    expect(r.stdout).toContain('TIER: welcome_back');
  });

  test('TIER is not bumped to regular by resources bookkeeping', () => {
    // 3 real sessions = welcome_back; adding resources entries must not reach the
    // 4-session `regular` threshold.
    logStartup();
    logStartup();
    logStartup();
    for (let i = 0; i < 4; i++) logResources(i);
    const r = runDev('--read');
    expect(r.stdout).toContain('SESSION_COUNT: 3');
    expect(r.stdout).toContain('TIER: welcome_back');
  });

  test('NUDGE_ELIGIBLE stays false when builder-session bar is unmet despite resources noise', () => {
    // One startup session carrying 5 signals, plus resources entries. builderSessions
    // (mode === "builder") is 0, so the nudge must not arm regardless of signal count.
    logStartup();
    logResources(1);
    logResources(2);
    logResources(3);
    const r = runDev('--read');
    expect(r.stdout).toContain('NUDGE_ELIGIBLE: false');
  });

  test('NUDGE_ELIGIBLE arms on 3 real builder sessions with enough signals', () => {
    runDev('--log-session', JSON.stringify({
      date: '2026-05-20T00:00:00Z', mode: 'builder', project_slug: 'p', signals: ['a', 'b'],
    }));
    runDev('--log-session', JSON.stringify({
      date: '2026-05-21T00:00:00Z', mode: 'builder', project_slug: 'p', signals: ['c', 'd'],
    }));
    runDev('--log-session', JSON.stringify({
      date: '2026-05-22T00:00:00Z', mode: 'builder', project_slug: 'p', signals: ['e'],
    }));
    logResources(1); // bookkeeping must not change the verdict either way
    const r = runDev('--read');
    expect(r.stdout).toContain('NUDGE_ELIGIBLE: true');
  });

  // Boundary cases around the two `>=` gates, so a future >= → > regression
  // (or a re-loosening of the builder filter) is caught, not just the happy path.
  function logBuilder(signals: string[], day = 20) {
    return runDev('--log-session', JSON.stringify({
      date: `2026-05-${day}T00:00:00Z`, mode: 'builder', project_slug: 'p', signals,
    }));
  }

  test('NUDGE_ELIGIBLE stays false at 2 builder sessions (below the 3-session gate)', () => {
    logBuilder(['a', 'b', 'c'], 20);
    logBuilder(['d', 'e', 'f'], 21); // 6 signals total — signal gate met, session gate is not
    logResources(1);
    const r = runDev('--read');
    expect(r.stdout).toContain('NUDGE_ELIGIBLE: false');
  });

  test('NUDGE_ELIGIBLE stays false at 3 builder sessions with too few signals', () => {
    logBuilder(['a'], 20);
    logBuilder(['b'], 21);
    logBuilder(['c', 'd'], 22); // 4 signals total — session gate met, signal gate (>=5) is not
    const r = runDev('--read');
    expect(r.stdout).toContain('NUDGE_ELIGIBLE: false');
  });

  test('TIER reaches regular at 4 real sessions even when resources entries are present', () => {
    logStartup();
    logStartup();
    logStartup();
    logStartup();
    for (let i = 0; i < 5; i++) logResources(i);
    const r = runDev('--read');
    expect(r.stdout).toContain('SESSION_COUNT: 4');
    expect(r.stdout).toContain('TIER: regular');
  });

  test('TIER stays regular at 7 real sessions and crosses to inner_circle at 8 (resources ignored)', () => {
    // Upper-tier boundary: the >=8 inner_circle gate must key off real sessions
    // only, so a pile of resources bookkeeping can never tip a regular into the
    // inner circle, and 8 genuine sessions still reach it.
    for (let i = 0; i < 7; i++) logStartup();
    for (let i = 0; i < 6; i++) logResources(i); // 13 raw rows; pre-fix would read inner_circle
    let r = runDev('--read');
    expect(r.stdout).toContain('SESSION_COUNT: 7');
    expect(r.stdout).toContain('TIER: regular');

    logStartup(); // 8th real session
    r = runDev('--read');
    expect(r.stdout).toContain('SESSION_COUNT: 8');
    expect(r.stdout).toContain('TIER: inner_circle');
  });

  test('CROSS_PROJECT ignores a trailing resources entry on a different project', () => {
    // The last two REAL sessions are the same project, so CROSS_PROJECT is false.
    // A trailing resources row carrying a different project_slug must not become
    // the `last` entry and flip CROSS_PROJECT true off bookkeeping.
    logStartup({ project_slug: 'samep' });
    logStartup({ project_slug: 'samep' });
    runDev('--log-session', JSON.stringify({
      date: '2026-05-20T02:00:00Z', mode: 'resources', project_slug: 'otherp',
      resources_shown: ['url1'],
    }));
    const r = runDev('--read');
    expect(r.stdout).toContain('CROSS_PROJECT: false');
    expect(r.stdout).toContain('LAST_PROJECT: samep');
  });
});

