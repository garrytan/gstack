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
  });
  return {
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    status: res.status ?? -1,
  };
}

function logQuestion(payload: Record<string, unknown>): number {
  const res = spawnSync(BIN_LOG, [JSON.stringify(payload)], {
    env: { ...process.env, GSTACK_HOME: tmpHome },
    encoding: 'utf-8',
    cwd: ROOT,
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
