/**
 * Taste engine — end-to-end tests for `gstack-taste-update`.
 *
 * Covers the v1 taste profile contract: schema shape, Laplace-smoothed confidence,
 * 5%/week decay, dimension extraction from reason strings, session cap, schema
 * migration, conflict detection (taste drift), malformed-input recovery.
 *
 * All tests use GSTACK_STATE_DIR pointing at a temp dir so no real home dir is
 * touched. Each test isolates its own state directory.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-taste-update');

interface Preference {
  value: string;
  confidence: number;
  approved_count: number;
  rejected_count: number;
  last_seen: string;
}

interface TasteProfile {
  version: number;
  updated_at: string;
  dimensions: Record<'fonts' | 'colors' | 'layouts' | 'aesthetics', { approved: Preference[]; rejected: Preference[] }>;
  sessions: Array<{ ts: string; action: 'approved' | 'rejected'; variant: string; reason?: string }>;
}

let stateDir: string;
let workdir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taste-state-'));
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'taste-work-'));
  // Initialize a git repo so gstack-taste-update's getSlug() finds a toplevel
  spawnSync('git', ['init', '-b', 'main'], { cwd: workdir, stdio: 'pipe' });
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(workdir, { recursive: true, force: true });
});

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('bun', ['run', BIN, ...args], {
    cwd: workdir,
    env: { ...process.env, GSTACK_STATE_DIR: stateDir, HOME: stateDir },
    encoding: 'utf-8',
    timeout: 10000,
  });
  return {
    status: result.status,
    stdout: result.stdout?.toString() ?? '',
    stderr: result.stderr?.toString() ?? '',
  };
}

function profilePath(): string {
  const slug = path.basename(workdir);
  return path.join(stateDir, 'projects', slug, 'taste-profile.json');
}

function readProfile(): TasteProfile {
  return JSON.parse(fs.readFileSync(profilePath(), 'utf-8'));
}

function writeProfile(p: unknown): void {
  const pp = profilePath();
  fs.mkdirSync(path.dirname(pp), { recursive: true });
  fs.writeFileSync(pp, JSON.stringify(p, null, 2));
}

describe('taste-engine: first-write lifecycle', () => {
  test('approved creates profile with correct v1 schema', () => {
    const r = run(['approved', 'variant-A', '--reason', 'fonts: Geist Sans; colors: emerald']);
    expect(r.status).toBe(0);

    const p = readProfile();
    expect(p.version).toBe(1);
    expect(p.dimensions.fonts.approved).toHaveLength(1);
    expect(p.dimensions.fonts.approved[0].value).toBe('Geist Sans');
    expect(p.dimensions.fonts.approved[0].approved_count).toBe(1);
    expect(p.dimensions.fonts.approved[0].rejected_count).toBe(0);
    // Laplace: 1 / (1 + 0 + 1) = 0.5
    expect(p.dimensions.fonts.approved[0].confidence).toBeCloseTo(0.5, 5);
    expect(p.dimensions.colors.approved[0].value).toBe('emerald');
    expect(p.sessions).toHaveLength(1);
    expect(p.sessions[0].action).toBe('approved');
    expect(p.sessions[0].variant).toBe('variant-A');
  });

  test('rejected bumps rejected_count not approved_count', () => {
    run(['rejected', 'variant-B', '--reason', 'fonts: Comic Sans']);
    const p = readProfile();
    expect(p.dimensions.fonts.rejected).toHaveLength(1);
    expect(p.dimensions.fonts.rejected[0].rejected_count).toBe(1);
    expect(p.dimensions.fonts.rejected[0].approved_count).toBe(0);
    expect(p.dimensions.fonts.approved).toHaveLength(0);
  });

  test('session recorded even when no dimensions extractable from reason', () => {
    const r = run(['approved', 'variant-C']); // no --reason
    expect(r.status).toBe(0);
    const p = readProfile();
    expect(p.sessions).toHaveLength(1);
    for (const dim of ['fonts', 'colors', 'layouts', 'aesthetics'] as const) {
      expect(p.dimensions[dim].approved).toHaveLength(0);
      expect(p.dimensions[dim].rejected).toHaveLength(0);
    }
  });
});

describe('taste-engine: Laplace-smoothed confidence', () => {
  test('repeated approvals raise confidence toward 1', () => {
    for (let i = 0; i < 5; i++) {
      run(['approved', `variant-${i}`, '--reason', 'fonts: Geist Sans']);
    }
    const p = readProfile();
    const pref = p.dimensions.fonts.approved[0];
    expect(pref.approved_count).toBe(5);
    // Laplace: 5 / (5 + 0 + 1) = 0.833
    expect(pref.confidence).toBeCloseTo(5 / 6, 5);
  });

  test('mixed approvals + rejections balance out', () => {
    run(['approved', 'v1', '--reason', 'fonts: Inter']);
    run(['approved', 'v2', '--reason', 'fonts: Inter']);
    run(['rejected', 'v3', '--reason', 'fonts: Inter']);
    const p = readProfile();
    const approved = p.dimensions.fonts.approved[0];
    const rejected = p.dimensions.fonts.rejected[0];
    expect(approved.approved_count).toBe(2);
    expect(approved.rejected_count).toBe(0);
    expect(rejected.rejected_count).toBe(1);
    expect(rejected.approved_count).toBe(0);
  });
});

describe('taste-engine: decay math', () => {
  test('show applies 5%/week decay to stored confidence', () => {
    // Seed with a profile where the single approved font was last_seen 4 weeks ago
    const fourWeeksAgo = new Date(Date.now() - 4 * 7 * 24 * 60 * 60 * 1000).toISOString();
    writeProfile({
      version: 1,
      updated_at: new Date().toISOString(),
      dimensions: {
        fonts: {
          approved: [{ value: 'Aged Font', confidence: 0.8, approved_count: 4, rejected_count: 0, last_seen: fourWeeksAgo }],
          rejected: [],
        },
        colors: { approved: [], rejected: [] },
        layouts: { approved: [], rejected: [] },
        aesthetics: { approved: [], rejected: [] },
      },
      sessions: [],
    });
    const r = run(['show']);
    expect(r.status).toBe(0);
    // After 4 weeks: 0.8 * (0.95)^4 ≈ 0.651
    const expectedConf = 0.8 * Math.pow(0.95, 4);
    const match = r.stdout.match(/Aged Font — conf (\d+\.\d+)/);
    expect(match).toBeTruthy();
    const displayedConf = parseFloat(match![1]);
    expect(displayedConf).toBeCloseTo(expectedConf, 2);
  });

  test('decay never goes below zero', () => {
    // 3 years ≈ 156 weeks. 0.95^156 ≈ 0.00036, well below 0.01.
    const yearsAgo = new Date(Date.now() - 3 * 365 * 24 * 60 * 60 * 1000).toISOString();
    writeProfile({
      version: 1,
      updated_at: new Date().toISOString(),
      dimensions: {
        fonts: {
          approved: [{ value: 'Ancient', confidence: 1.0, approved_count: 1, rejected_count: 0, last_seen: yearsAgo }],
          rejected: [],
        },
        colors: { approved: [], rejected: [] },
        layouts: { approved: [], rejected: [] },
        aesthetics: { approved: [], rejected: [] },
      },
      sessions: [],
    });
    const r = run(['show']);
    expect(r.status).toBe(0);
    const match = r.stdout.match(/Ancient — conf (\d+\.\d+)/);
    expect(match).toBeTruthy();
    const conf = parseFloat(match![1]);
    expect(conf).toBeGreaterThanOrEqual(0);
    expect(conf).toBeLessThan(0.01);
  });
});

describe('taste-engine: dimension extraction', () => {
  test('parses multiple dimensions from one reason string', () => {
    run(['approved', 'v1', '--reason', 'fonts: Geist, IBM Plex; colors: emerald; layouts: grid-12; aesthetics: brutalist']);
    const p = readProfile();
    expect(p.dimensions.fonts.approved.map(x => x.value).sort()).toEqual(['Geist', 'IBM Plex']);
    expect(p.dimensions.colors.approved[0].value).toBe('emerald');
    expect(p.dimensions.layouts.approved[0].value).toBe('grid-12');
    expect(p.dimensions.aesthetics.approved[0].value).toBe('brutalist');
  });

  test('value matching is case-insensitive (first casing wins)', () => {
    run(['approved', 'v1', '--reason', 'fonts: Geist']);
    run(['approved', 'v2', '--reason', 'fonts: GEIST']);
    const p = readProfile();
    // Should merge into a single entry
    expect(p.dimensions.fonts.approved).toHaveLength(1);
    expect(p.dimensions.fonts.approved[0].approved_count).toBe(2);
    // Canonical value is the first-arrival casing. bumpPref() stores value on
    // insert and never overwrites on subsequent bumps.
    expect(p.dimensions.fonts.approved[0].value).toBe('Geist');
  });

  test('unknown dimension labels are silently ignored', () => {
    run(['approved', 'v1', '--reason', 'weather: sunny; mood: happy']);
    const p = readProfile();
    // Session still recorded
    expect(p.sessions).toHaveLength(1);
    // No dimensions populated
    for (const dim of ['fonts', 'colors', 'layouts', 'aesthetics'] as const) {
      expect(p.dimensions[dim].approved).toHaveLength(0);
    }
  });
});

describe('taste-engine: session cap', () => {
  test('sessions truncate to last 50 entries (FIFO)', () => {
    // Seed the profile with 50 existing sessions, then one real CLI call writes
    // the 51st → the oldest must drop. Avoids 55 sequential subprocess spawns.
    const seededSessions = Array.from({ length: 50 }, (_, i) => ({
      ts: new Date(Date.now() - (50 - i) * 1000).toISOString(),
      action: 'approved' as const,
      variant: `seed-${i}`,
    }));
    writeProfile({
      version: 1,
      updated_at: new Date().toISOString(),
      dimensions: {
        fonts: { approved: [], rejected: [] },
        colors: { approved: [], rejected: [] },
        layouts: { approved: [], rejected: [] },
        aesthetics: { approved: [], rejected: [] },
      },
      sessions: seededSessions,
    });
    const r = run(['approved', 'new-one', '--reason', 'fonts: Geist']);
    expect(r.status).toBe(0);
    const p = readProfile();
    expect(p.sessions).toHaveLength(50);
    // The oldest seed (seed-0) must have been evicted FIFO; seed-1 is now first;
    // the new entry is last.
    expect(p.sessions[0].variant).toBe('seed-1');
    expect(p.sessions[48].variant).toBe('seed-49');
    expect(p.sessions[49].variant).toBe('new-one');
  });
});

describe('taste-engine: taste drift conflict detection', () => {
  test('warns when approved value has strong opposite signal', () => {
    // Seed a strong rejected entry: 4 rejections, no approvals → Laplace = 0/5 but that's
    // not > 0.6. Let's seed it directly with confidence 0.8.
    writeProfile({
      version: 1,
      updated_at: new Date().toISOString(),
      dimensions: {
        fonts: {
          approved: [],
          rejected: [{ value: 'Comic Sans', confidence: 0.8, approved_count: 0, rejected_count: 4, last_seen: new Date().toISOString() }],
        },
        colors: { approved: [], rejected: [] },
        layouts: { approved: [], rejected: [] },
        aesthetics: { approved: [], rejected: [] },
      },
      sessions: [],
    });
    const r = run(['approved', 'v1', '--reason', 'fonts: Comic Sans']);
    expect(r.status).toBe(0);
    // "taste drift" note should go to stderr
    expect(r.stderr).toContain('taste drift');
    expect(r.stderr).toContain('Comic Sans');
  });

  test('does NOT warn when signal is weak', () => {
    writeProfile({
      version: 1,
      updated_at: new Date().toISOString(),
      dimensions: {
        fonts: {
          approved: [],
          // Single rejection (< 3) — shouldn't trigger drift warning
          rejected: [{ value: 'Inter', confidence: 0.5, approved_count: 0, rejected_count: 1, last_seen: new Date().toISOString() }],
        },
        colors: { approved: [], rejected: [] },
        layouts: { approved: [], rejected: [] },
        aesthetics: { approved: [], rejected: [] },
      },
      sessions: [],
    });
    const r = run(['approved', 'v1', '--reason', 'fonts: Inter']);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('taste drift');
  });
});

describe('taste-engine: migration', () => {
  test('legacy profile without version gets migrated to v1', () => {
    // Simulate a legacy approved.json-style structure
    writeProfile({
      // no version field
      dimensions: {
        fonts: {
          approved: [{ value: 'Legacy', confidence: 0.7, approved_count: 3, rejected_count: 1, last_seen: new Date().toISOString() }],
          rejected: [],
        },
      },
      sessions: [
        { ts: new Date().toISOString(), action: 'approved', variant: 'legacy-v1' },
      ],
    });

    const r = run(['migrate']);
    expect(r.status).toBe(0);

    const p = readProfile();
    expect(p.version).toBe(1);
    expect(p.dimensions.fonts.approved[0].value).toBe('Legacy');
    expect(p.dimensions.colors).toBeDefined();
    expect(p.dimensions.layouts).toBeDefined();
    expect(p.dimensions.aesthetics).toBeDefined();
    expect(p.sessions).toHaveLength(1);
    expect(p.sessions[0].variant).toBe('legacy-v1');
  });

  test('migration truncates oversized sessions array to last 50', () => {
    const sessions = Array.from({ length: 100 }, (_, i) => ({
      ts: new Date().toISOString(),
      action: 'approved' as const,
      variant: `legacy-${i}`,
    }));
    writeProfile({ dimensions: {}, sessions });
    const r = run(['migrate']);
    expect(r.status).toBe(0);
    const p = readProfile();
    expect(p.sessions).toHaveLength(50);
    expect(p.sessions[0].variant).toBe('legacy-50');
    expect(p.sessions[49].variant).toBe('legacy-99');
  });
});

describe('taste-engine: resilience', () => {
  test('malformed JSON profile falls back to empty and does not crash', () => {
    const pp = profilePath();
    fs.mkdirSync(path.dirname(pp), { recursive: true });
    fs.writeFileSync(pp, '{ this is not json');
    const r = run(['approved', 'v1', '--reason', 'fonts: Geist']);
    // Should succeed (graceful fallback)
    expect(r.status).toBe(0);
    // Warning on stderr
    expect(r.stderr).toContain('WARN');
    // File should now be valid JSON
    const p = readProfile();
    expect(p.version).toBe(1);
    expect(p.dimensions.fonts.approved[0].value).toBe('Geist');
  });

  test('show on nonexistent profile prints empty summary without error', () => {
    const r = run(['show']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('taste-profile.json');
  });

  test('approved without variant arg exits non-zero with usage hint', () => {
    const r = run(['approved']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('Usage');
  });

  test('unknown command exits non-zero', () => {
    const r = run(['banana']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('Usage');
  });
});
