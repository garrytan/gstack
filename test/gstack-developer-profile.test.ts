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
import { SIGNAL_MAP, normalizeToDimensionValue } from '../scripts/psychographic-signals';

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
    // gstack-question-log fires `--derive` in the background after every
    // append, which races the explicit runDev('--derive') a test then makes.
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

  test('contributing_events counts unique rows per dimension (#2625)', () => {
    // plan-eng-review-arch-finding → fix-now writes architecture_care AND
    // risk_tolerance from one row; an ad-hoc row writes nothing.
    for (let i = 0; i < 2; i++) {
      logQuestion({ skill: 'plan-eng-review', question_id: 'plan-eng-review-arch-finding', question_summary: 'arch?', user_choice: 'fix-now', session_id: `s${i}` });
    }
    logQuestion({ skill: 'plan-eng-review', question_id: 'adhoc-unregistered-question', question_summary: 'x', user_choice: 'fix-now', session_id: 's9' });
    runDev('--derive');
    const p = readProfile() as { inferred: { contributing_events: Record<string, number>; signal_events: number } };
    expect(p.inferred.contributing_events).toEqual({
      scope_appetite: 0,
      risk_tolerance: 2,
      detail_preference: 0,
      autonomy: 0,
      architecture_care: 2,
    });
    expect(p.inferred.signal_events).toBe(2);
  });

  test('contributing_events is all zero when no answer matches a signal', () => {
    logQuestion({ skill: 'plan-eng-review', question_id: 'plan-eng-review-arch-finding', question_summary: 'arch?', user_choice: 'not-a-mapped-option', session_id: 's1' });
    runDev('--derive');
    const p = readProfile() as { inferred: { contributing_events: Record<string, number>; sample_size: number } };
    expect(p.inferred.sample_size).toBe(1);
    expect(p.inferred.contributing_events).toEqual({
      scope_appetite: 0,
      risk_tolerance: 0,
      detail_preference: 0,
      autonomy: 0,
      architecture_care: 0,
    });
  });

  test('a choice named after an Object.prototype member or a non-object line is ignored, not fatal', () => {
    logQuestion({ skill: 'plan-eng-review', question_id: 'plan-eng-review-arch-finding', question_summary: 'arch?', user_choice: 'constructor', session_id: 's1' });
    logQuestion({ skill: 'plan-eng-review', question_id: 'plan-eng-review-arch-finding', question_summary: 'arch?', user_choice: 'fix-now', session_id: 's2' });
    const projects = path.join(tmpHome, 'projects');
    for (const slug of fs.readdirSync(projects)) {
      const log = path.join(projects, slug, 'question-log.jsonl');
      if (!fs.existsSync(log)) continue;
      fs.appendFileSync(log, 'null\n');
      fs.appendFileSync(log, JSON.stringify({ skill: 'plan-eng-review', question_id: ['plan-eng-review-arch-finding'], user_choice: 'fix-now' }) + '\n');
      fs.appendFileSync(log, JSON.stringify({ skill: 'plan-eng-review', question_id: 'plan-eng-review-arch-finding', user_choice: ['fix-now'] }) + '\n');
    }
    const r = runDev('--derive');
    expect(r.status).toBe(0);
    const p = readProfile() as { inferred: { contributing_events: Record<string, number>; signal_events: number; sample_size: number } };
    expect(p.inferred.sample_size).toBe(2);
    expect(p.inferred.signal_events).toBe(1);
    expect(p.inferred.contributing_events.architecture_care).toBe(1);
    expect(runDev('--trace', 'architecture_care').stdout).toContain('1 events for architecture_care');
  });
});

// -----------------------------------------------------------------------
// Per-day bound (#2623): one UTC day moves a dimension at most as far as the
// largest single delta in SIGNAL_MAP, whatever session_id the writers log.
// -----------------------------------------------------------------------

describe('gstack-developer-profile per-day bound', () => {
  const CAP = Math.max(...Object.values(SIGNAL_MAP).flatMap((byChoice) => Object.values(byChoice).flat().map((d) => Math.abs(d.delta))));
  const arch = (day: number, user_choice = 'fix-now', extra: Record<string, unknown> = {}) =>
    logQuestion({ skill: 'plan-eng-review', question_id: 'plan-eng-review-arch-finding', question_summary: 'arch?', user_choice, ts: `2026-04-${String(day).padStart(2, '0')}T10:00:00Z`, ...extra });
  const inferred = () => (readProfile() as { inferred: { values: Record<string, number>; contributing_events: Record<string, number> } }).inferred;
  const value = (total: number) => +normalizeToDimensionValue(total).toFixed(3);

  test('the bound is the largest single delta in the signal map', () => {
    expect(CAP).toBe(0.06);
  });

  test('five answers on one day move a dimension by the bound, not by their sum', () => {
    for (let i = 0; i < 5; i++) arch(1, 'fix-now', { session_id: 'one-review' });
    runDev('--derive');
    expect(inferred().values.architecture_care).toBe(value(CAP));
    expect(inferred().values.risk_tolerance).toBe(value(-CAP));
    expect(inferred().contributing_events.architecture_care).toBe(5);
  });

  test('the same five answers on five days are not bounded (negative control)', () => {
    for (let i = 0; i < 5; i++) arch(i + 1, 'fix-now', { session_id: 'one-review' });
    runDev('--derive');
    expect(inferred().values.architecture_care).toBe(value(5 * 0.05));
  });

  test('a second day still moves the dimension after the first day is capped (negative control)', () => {
    for (let i = 0; i < 5; i++) arch(1);
    for (let i = 0; i < 5; i++) arch(2);
    runDev('--derive');
    expect(inferred().values.architecture_care).toBe(value(2 * CAP));
  });

  test('distinct session_ids on one day share the day bound', () => {
    for (let i = 0; i < 5; i++) arch(1, 'fix-now', { session_id: `s${i}` });
    runDev('--derive');
    expect(inferred().values.architecture_care).toBe(value(CAP));
  });

  test('an unsubstituted SESSION_ID placeholder is bounded per day like any other id', () => {
    for (let i = 0; i < 5; i++) arch(1, 'fix-now', { session_id: 'SESSION_ID' });
    for (let i = 0; i < 3; i++) arch(i + 2, 'fix-now', { session_id: 'SESSION_ID' });
    runDev('--derive');
    expect(inferred().values.architecture_care).toBe(value(CAP + 3 * 0.05));
  });

  test('one review logged by both the hook and the agent is bounded once per day', () => {
    for (let i = 0; i < 5; i++) {
      arch(1, 'fix-now', { source: 'hook', tool_use_id: `t${i}`, session_id: 'claude-conversation-uuid' });
      arch(1, 'fix-now', { session_id: '1234-1700000000-ab' });
    }
    runDev('--derive');
    expect(inferred().values.architecture_care).toBe(value(CAP));
    expect(inferred().contributing_events.architecture_care).toBe(10);
  });

  const deriveWestOfUtc = () => {
    const res = spawnSync(BIN_DEV, ['--derive'], {
      env: { ...process.env, GSTACK_HOME: tmpHome, TZ: 'America/Los_Angeles' },
      encoding: 'utf-8',
      cwd: ROOT,
      timeout: 30_000,
    });
    expect(res.status).toBe(0);
  };
  const atTs = (ts: unknown) =>
    logQuestion({ skill: 'plan-eng-review', question_id: 'plan-eng-review-arch-finding', question_summary: 'arch?', user_choice: 'fix-now', ts });

  test('the day is the UTC day of ts, not the local day', () => {
    arch(1, 'fix-now');
    atTs('2026-04-01T20:00:00-08:00');
    deriveWestOfUtc();
    expect(inferred().values.architecture_care).toBe(value(2 * 0.05));
    expect((readProfile() as { inferred: { diversity: { days_span: number } } }).inferred.diversity.days_span).toBe(2);
  });

  test('a ts without a zone is read as UTC', () => {
    atTs('2026-04-01T23:30:00');
    atTs('2026-04-02T00:30:00Z');
    deriveWestOfUtc();
    expect(inferred().values.architecture_care).toBe(value(2 * 0.05));
    expect((readProfile() as { inferred: { diversity: { days_span: number } } }).inferred.diversity.days_span).toBe(2);
  });

  test('a ts with a space separator and no zone is read as UTC', () => {
    atTs('2026-04-01 23:30:00');
    atTs('2026-04-02T00:30:00Z');
    deriveWestOfUtc();
    expect(inferred().values.architecture_care).toBe(value(2 * 0.05));
    expect((readProfile() as { inferred: { diversity: { days_span: number } } }).inferred.diversity.days_span).toBe(2);
  });

  test('rows without an ISO 8601 string ts share one undated bucket', () => {
    const junk: unknown[] = ['not-a-date', 'TS', 'junk 1', 'foo 12', 1775000000];
    for (const ts of junk) expect(atTs(ts)).toBe(0);
    runDev('--derive');
    const p = readProfile() as { inferred: { sample_size: number; contributing_events: Record<string, number>; diversity: { days_span: number } } };
    expect(p.inferred.sample_size).toBe(junk.length);
    expect(p.inferred.contributing_events.architecture_care).toBe(junk.length);
    expect(inferred().values.architecture_care).toBe(value(CAP));
    expect(p.inferred.diversity.days_span).toBe(0);
  });

  test('answers on one day net out before the bound applies', () => {
    arch(1, 'fix-now');
    arch(1, 'accept-risk');
    runDev('--derive');
    expect(inferred().values.architecture_care).toBe(value(0.05 - 0.04));
  });

  test('--trace shows the capped day and a total that matches --derive', () => {
    for (let i = 0; i < 5; i++) arch(1);
    arch(7, 'defer');
    runDev('--derive');
    const r = runDev('--trace', 'architecture_care');
    expect(r.stdout).toContain('6 events for architecture_care');
    expect(r.stdout).toContain('day 2026-04-01: +0.250 capped to +0.060');
    expect(r.stdout).not.toContain('day 2026-04-07');
    expect(r.stdout).toContain(`TOTAL: +0.040 (each UTC day capped at ±${CAP}) → ${inferred().values.architecture_care.toFixed(3)}`);
    const risk = runDev('--trace', 'risk_tolerance');
    expect(risk.stdout).toContain('day 2026-04-01: -0.100 capped to -0.060');
  });

  test('--trace replaces control characters in logged fields', () => {
    for (let i = 0; i < 2; i++) {
      logQuestion({ skill: 'plan-eng-review', question_id: 'plan-eng-review-arch-finding', question_summary: 'arch?', user_choice: 'fix-now', ts: '\u001b\u007f\u009b\nTOTAL: +9.999' });
    }
    const r = runDev('--trace', 'architecture_care');
    expect(r.stdout.split('\n').filter((l) => l.startsWith('TOTAL:'))).toHaveLength(1);
    expect(r.stdout).toContain('  ????TOTAL: +9.999  plan-eng-review-arch-finding');
    expect(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(r.stdout)).toBe(false);
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
// Concurrent writers (#3437). gstack-question-log starts a background
// --derive after every append, and a multi-question AskUserQuestion logs
// several rows at once, so derives overlap each other and /office-hours'
// --log-session. Each subcommand rewrites the whole profile, so every
// read-modify-write holds the profile lock and writes a unique temp file.
// -----------------------------------------------------------------------

async function runDevAsync(...args: string[]): Promise<{ stdout: string; stderr: string; status: number }> {
  const proc = Bun.spawn([BIN_DEV, ...args], {
    env: { ...process.env, GSTACK_HOME: tmpHome },
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => proc.kill(), 60_000);
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { stdout, stderr, status };
}

describe('gstack-developer-profile concurrent writers (#3437)', () => {
  const lockDir = () => path.join(tmpHome, 'developer-profile.json.lock');

  test('--derive does not write through a fixed temp path', () => {
    fs.mkdirSync(path.join(tmpHome, 'developer-profile.json.tmp'));
    const r = runDev('--derive');
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(typeof (readProfile() as { derived_at?: string }).derived_at).toBe('string');
  });

  test('a held profile lock keeps --derive and --log-session from writing', () => {
    expect(runDev('--derive').status).toBe(0);
    const before = fs.readFileSync(path.join(tmpHome, 'developer-profile.json'), 'utf-8');
    fs.mkdirSync(lockDir());
    fs.writeFileSync(path.join(lockDir(), 'owner'), process.pid + '-held\n');
    const env = { ...process.env, GSTACK_HOME: tmpHome, GSTACK_PROFILE_LOCK_TIMEOUT_MS: '300' };
    for (const args of [['--derive'], ['--log-session', JSON.stringify({ date: '2026-10-31', mode: 'builder' })]]) {
      const res = spawnSync(BIN_DEV, args, { env, encoding: 'utf-8', cwd: ROOT, timeout: 30_000 });
      expect(res.status).toBe(5);
      expect(res.stderr).toContain('developer-profile.json.lock');
    }
    expect(fs.readFileSync(path.join(tmpHome, 'developer-profile.json'), 'utf-8')).toBe(before);
    expect(fs.readFileSync(path.join(lockDir(), 'owner'), 'utf-8')).toBe(process.pid + '-held\n');
  });

  test('a stale lock left by a crashed writer is taken over', () => {
    fs.mkdirSync(lockDir());
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lockDir(), old, old);
    const r = runDev('--log-session', JSON.stringify({ date: '2026-10-31', mode: 'builder', project_slug: 'p' }));
    expect(r.status).toBe(0);
    expect((readProfile() as { sessions: unknown[] }).sessions.length).toBe(1);
    expect(fs.existsSync(lockDir())).toBe(false);
  });

  test('a lock whose holder process is gone is taken over at once', () => {
    const gone = spawnSync('true', [], { timeout: 10_000 }).pid;
    fs.mkdirSync(lockDir());
    fs.writeFileSync(path.join(lockDir(), 'owner'), gone + '-crashed\n');
    const env = { ...process.env, GSTACK_HOME: tmpHome, GSTACK_PROFILE_LOCK_TIMEOUT_MS: '300' };
    const res = spawnSync(BIN_DEV, ['--log-session', JSON.stringify({ date: '2026-10-31', mode: 'builder', project_slug: 'p' })], { env, encoding: 'utf-8', cwd: ROOT, timeout: 30_000 });
    expect(res.stderr).toBe('');
    expect(res.status).toBe(0);
    expect((readProfile() as { sessions: unknown[] }).sessions.length).toBe(1);
    expect(fs.existsSync(lockDir())).toBe(false);
  });

  test('a lock older than 5 minutes is taken over even when its pid is alive (pid reuse)', () => {
    fs.mkdirSync(lockDir());
    fs.writeFileSync(path.join(lockDir(), 'owner'), process.pid + '-reused\n');
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(lockDir(), old, old);
    const env = { ...process.env, GSTACK_HOME: tmpHome, GSTACK_PROFILE_LOCK_TIMEOUT_MS: '300' };
    const res = spawnSync(BIN_DEV, ['--log-session', JSON.stringify({ date: '2026-10-31', mode: 'builder', project_slug: 'p' })], { env, encoding: 'utf-8', cwd: ROOT, timeout: 30_000 });
    expect(res.stderr).toBe('');
    expect(res.status).toBe(0);
    expect((readProfile() as { sessions: unknown[] }).sessions.length).toBe(1);
    expect(fs.existsSync(lockDir())).toBe(false);
  });

  test('a takeover already in progress is not repeated', () => {
    const gone = spawnSync('true', [], { timeout: 10_000 }).pid;
    fs.mkdirSync(lockDir());
    fs.writeFileSync(path.join(lockDir(), 'owner'), gone + '-crashed\n');
    fs.mkdirSync(lockDir() + '.takeover');
    const env = { ...process.env, GSTACK_HOME: tmpHome, GSTACK_PROFILE_LOCK_TIMEOUT_MS: '300' };
    const res = spawnSync(BIN_DEV, ['--log-session', JSON.stringify({ date: '2026-10-31', mode: 'builder' })], { env, encoding: 'utf-8', cwd: ROOT, timeout: 30_000 });
    expect(res.status).toBe(5);
    expect(fs.readFileSync(path.join(lockDir(), 'owner'), 'utf-8')).toBe(gone + '-crashed\n');
  });

  test('a takeover that cannot remove the lock still gives up', () => {
    expect(runDev('--derive').status).toBe(0);
    fs.mkdirSync(lockDir());
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lockDir(), old, old);
    fs.chmodSync(tmpHome, 0o555);
    try {
      const env = { ...process.env, GSTACK_HOME: tmpHome, GSTACK_PROFILE_LOCK_TIMEOUT_MS: '300' };
      const res = spawnSync(BIN_DEV, ['--derive'], { env, encoding: 'utf-8', cwd: ROOT, timeout: 10_000 });
      expect(res.signal).toBeNull();
      expect([0, 5]).toContain(res.status ?? -1);
    } finally {
      fs.chmodSync(tmpHome, 0o755);
    }
  }, 20_000);

  test('a relative state root does not leave the lock behind', () => {
    const env = { ...process.env, GSTACK_HOME: 'state' };
    for (const args of [['--derive'], ['--log-session', JSON.stringify({ date: '2026-10-31', mode: 'builder', project_slug: 'p' })]]) {
      const res = spawnSync(BIN_DEV, args, { env, encoding: 'utf-8', cwd: tmpHome, timeout: 30_000 });
      expect(res.stderr).toBe('');
      expect(res.status).toBe(0);
    }
    const p = JSON.parse(fs.readFileSync(path.join(tmpHome, 'state', 'developer-profile.json'), 'utf-8'));
    expect(p.sessions.length).toBe(1);
    expect(typeof p.derived_at).toBe('string');
    expect(fs.existsSync(path.join(tmpHome, 'state', 'developer-profile.json.lock'))).toBe(false);
  });

  test('overlapping derives and log-sessions keep every session and leave valid JSON', async () => {
    for (let i = 0; i < 5; i++) {
      logQuestion({ skill: 'plan-ceo-review', question_id: 'plan-ceo-review-mode', question_summary: 'mode', user_choice: 'expand', session_id: 's' + i });
    }
    expect(runDev('--derive').status).toBe(0);
    const rounds = 6;
    for (let round = 0; round < rounds; round++) {
      const runs = await Promise.all([
        ...Array.from({ length: 6 }, () => runDevAsync('--derive')),
        runDevAsync('--log-session', JSON.stringify({ date: '2026-10-31', mode: 'builder', project_slug: 'round-' + round })),
      ]);
      for (const r of runs) {
        expect(r.stderr).toBe('');
        expect(r.status).toBe(0);
      }
    }
    const p = readProfile() as { sessions: Array<{ project_slug: string }>; inferred: { sample_size: number } };
    expect(p.sessions.map((s) => s.project_slug).sort()).toEqual(Array.from({ length: rounds }, (_, i) => 'round-' + i).sort());
    expect(p.inferred.sample_size).toBe(5);
    expect(fs.readdirSync(tmpHome).filter((f) => f.startsWith('developer-profile.json.'))).toEqual([]);
  }, 120_000);
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


// -----------------------------------------------------------------------
// --reconcile: backfill tenure from office-hours timeline history (#2657)
// -----------------------------------------------------------------------

describe('gstack-developer-profile --reconcile', () => {
  const completed = (ts: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ skill: 'office-hours', event: 'completed', ts, ...extra });

  function writeTimeline(slug: string, lines: string[]) {
    const dir = path.join(tmpHome, 'projects', slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'timeline.jsonl'), lines.join('\n') + '\n');
  }

  function logSession(entry: Record<string, unknown>) {
    expect(runDev('--log-session', JSON.stringify({ mode: 'builder', signal_count: 0, signals: [], ...entry })).status).toBe(0);
  }

  const readKey = (out: string, key: string) => out.match(new RegExp(`^${key}: (.*)$`, 'm'))?.[1];

  test('backfills one row per office-hours completed run and counts it for tenure', () => {
    writeTimeline('alpha', [
      completed('2026-09-01T10:00:00Z'),
      JSON.stringify({ skill: 'office-hours', event: 'started', ts: '2026-09-02T09:00:00Z' }),
      completed('2026-09-02T10:00:00Z'),
      JSON.stringify({ skill: 'review', event: 'completed', ts: '2026-09-03T10:00:00Z' }),
    ]);
    writeTimeline('beta', [completed('2026-09-04T10:00:00Z')]);
    const r = runDev('--reconcile');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('RECONCILE: 3 backfilled from 3 office-hours run(s)');
    const sessions = readProfile().sessions as Array<Record<string, unknown>>;
    expect(sessions).toHaveLength(3);
    expect(sessions[2]).toEqual({
      date: '2026-09-04T10:00:00Z', mode: 'unknown', project_slug: 'beta',
      signal_count: 0, signals: [], backfilled: true,
    });
    const read = runDev('--read').stdout;
    expect(readKey(read, 'SESSION_COUNT')).toBe('3');
    expect(readKey(read, 'TIER')).toBe('welcome_back');
  });

  test('a second run adds nothing and leaves the profile file untouched', () => {
    writeTimeline('alpha', [completed('2026-09-01T10:00:00Z'), completed('2026-09-05T10:00:00Z')]);
    expect(runDev('--reconcile').stdout).toContain('RECONCILE: 2 backfilled');
    const file = path.join(tmpHome, 'developer-profile.json');
    const before = fs.readFileSync(file, 'utf-8');
    const old = new Date('2026-01-01T00:00:00Z');
    fs.utimesSync(file, old, old);
    expect(runDev('--reconcile').stdout).toContain('RECONCILE: 0 backfilled from 2 office-hours run(s)');
    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
    expect(fs.statSync(file).mtimeMs).toBe(old.getTime());
  });

  test('a logged session minutes before the run across an hour boundary covers it, per project', () => {
    logSession({ date: '2026-09-01T10:55:00Z', ts: '2026-09-01T10:55:00Z', project_slug: 'alpha' });
    writeTimeline('alpha', [completed('2026-09-01T11:20:00Z')]);
    writeTimeline('beta', [completed('2026-09-01T11:20:00Z')]);
    expect(runDev('--reconcile').stdout).toContain('RECONCILE: 1 backfilled from 2 office-hours run(s)');
    const backfilled = (readProfile().sessions as Array<Record<string, unknown>>).filter(s => s.backfilled);
    expect(backfilled.map(s => s.project_slug)).toEqual(['beta']);
  });

  test('a long session logged hours before completion is not double-counted; garbage durations are not trusted', () => {
    logSession({ date: '2026-09-01T09:00:00Z', ts: '2026-09-01T09:00:00Z', project_slug: 'alpha' });
    logSession({ date: '2026-09-02T09:00:00Z', ts: '2026-09-02T09:00:00Z', project_slug: 'alpha' });
    writeTimeline('alpha', [
      completed('2026-09-01T12:00:00Z', { duration_s: '11000' }),
      completed('2026-09-02T19:00:00Z', { duration_s: '40000' }),
    ]);
    expect(runDev('--reconcile').stdout).toContain('RECONCILE: 1 backfilled from 2 office-hours run(s)');
    const backfilled = (readProfile().sessions as Array<Record<string, unknown>>).filter(s => s.backfilled);
    expect(backfilled.map(s => s.date)).toEqual(['2026-09-02T19:00:00Z']);
  });

  test('malformed timeline lines are skipped', () => {
    writeTimeline('alpha', ['{not json', 'null', completed('not-a-date'), completed('2026-09-01T10:00:00Z')]);
    const r = runDev('--reconcile');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('RECONCILE: 1 backfilled from 1 office-hours run(s)');
  });

  test('backfilled rows never surface as LAST_*, DESIGN_* or CROSS_PROJECT', () => {
    logSession({
      date: '2026-09-01T10:00:00Z', ts: '2026-09-01T10:00:00Z', project_slug: 'alpha',
      assignment: 'Talk to five users', design_doc: 'docs/alpha-design.md',
    });
    writeTimeline('beta', [completed('2026-09-03T10:00:00Z'), completed('2026-09-04T10:00:00Z')]);
    expect(runDev('--reconcile').stdout).toContain('RECONCILE: 2 backfilled');
    const read = runDev('--read').stdout;
    expect(readKey(read, 'SESSION_COUNT')).toBe('3');
    expect(readKey(read, 'LAST_PROJECT')).toBe('alpha');
    expect(readKey(read, 'LAST_ASSIGNMENT')).toBe('Talk to five users');
    expect(readKey(read, 'LAST_DESIGN_TITLE')).toBe('docs/alpha-design.md');
    expect(readKey(read, 'DESIGN_COUNT')).toBe('1');
    expect(readKey(read, 'CROSS_PROJECT')).toBe('false');
  });

  test('a backfill-only profile reaches welcome_back with empty LAST_*', () => {
    writeTimeline('alpha', [completed('2026-09-01T10:00:00Z')]);
    runDev('--reconcile');
    const read = runDev('--read').stdout;
    expect(readKey(read, 'TIER')).toBe('welcome_back');
    expect(readKey(read, 'LAST_PROJECT')).toBe('');
    expect(readKey(read, 'LAST_ASSIGNMENT')).toBe('');
  });
});
