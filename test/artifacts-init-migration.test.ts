// Unit tests for gstack-upgrade/migrations/v1.38.1.0.sh (#1452).
// Verifies idempotent in-place repair of .brain-allowlist,
// .brain-privacy-map.json, and .gitattributes.

import { describe, expect, test, beforeEach } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const MIGRATION = join(REPO_ROOT, 'gstack-upgrade', 'migrations', 'v1.38.1.0.sh');

function setupFakeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mig-v1340-'));
  mkdirSync(join(dir, '.gstack'), { recursive: true });
  return dir;
}

function runMigration(fakeHome: string): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync({
    cmd: ['bash', MIGRATION],
    env: { ...process.env, HOME: fakeHome },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    code: proc.exitCode ?? -1,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

describe('v1.38.1.0 migration', () => {
  test('adds patterns to allowlist before USER ADDITIONS marker', () => {
    const home = setupFakeHome();
    try {
      writeFileSync(join(home, '.gstack', '.brain-allowlist'), [
        'projects/*/learnings.jsonl',
        'projects/*/designs/*.md',
        '# ---- USER ADDITIONS BELOW ---- (survives re-init; above is managed)',
        'projects/*/my-custom.txt',
      ].join('\n') + '\n');

      const r = runMigration(home);
      expect(r.code).toBe(0);

      const content = readFileSync(join(home, '.gstack', '.brain-allowlist'), 'utf-8');
      expect(content).toContain('projects/*/*-design-*.md');
      expect(content).toContain('projects/*/*-test-plan-*.md');
      // New patterns above the user marker
      const designIdx = content.indexOf('projects/*/*-design-*.md');
      const markerIdx = content.indexOf('# ---- USER ADDITIONS BELOW');
      expect(designIdx).toBeLessThan(markerIdx);
      // User customizations below the marker preserved
      expect(content).toContain('projects/*/my-custom.txt');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('adds entries to privacy-map.json via jq (preserves JSON validity)', () => {
    const home = setupFakeHome();
    try {
      writeFileSync(join(home, '.gstack', '.brain-privacy-map.json'), JSON.stringify([
        { pattern: 'projects/*/learnings.jsonl', class: 'artifact' },
        { pattern: 'projects/*/designs/*.md', class: 'artifact' },
      ], null, 2));

      const r = runMigration(home);
      expect(r.code).toBe(0);

      const raw = readFileSync(join(home, '.gstack', '.brain-privacy-map.json'), 'utf-8');
      // Valid JSON (would throw if jq emitted malformed output)
      const parsed = JSON.parse(raw);
      expect(Array.isArray(parsed)).toBe(true);
      const patterns = parsed.map((e: any) => e.pattern);
      expect(patterns).toContain('projects/*/*-design-*.md');
      expect(patterns).toContain('projects/*/*-test-plan-*.md');
      // Class preserved on new entries
      expect(parsed.find((e: any) => e.pattern === 'projects/*/*-design-*.md').class).toBe('artifact');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('adds union-merge rules to gitattributes', () => {
    const home = setupFakeHome();
    try {
      writeFileSync(join(home, '.gstack', '.gitattributes'), [
        '*.jsonl merge=jsonl-append',
        'projects/*/designs/**/*.md merge=union',
      ].join('\n') + '\n');

      const r = runMigration(home);
      expect(r.code).toBe(0);

      const content = readFileSync(join(home, '.gstack', '.gitattributes'), 'utf-8');
      expect(content).toContain('projects/*/*-design-*.md merge=union');
      expect(content).toContain('projects/*/*-test-plan-*.md merge=union');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('is idempotent: re-running on already-patched files is a no-op', () => {
    const home = setupFakeHome();
    try {
      writeFileSync(join(home, '.gstack', '.brain-allowlist'), [
        'projects/*/learnings.jsonl',
        '# ---- USER ADDITIONS BELOW',
      ].join('\n') + '\n');
      writeFileSync(join(home, '.gstack', '.brain-privacy-map.json'), JSON.stringify([
        { pattern: 'projects/*/learnings.jsonl', class: 'artifact' },
      ]));
      writeFileSync(join(home, '.gstack', '.gitattributes'), '*.jsonl merge=jsonl-append\n');

      runMigration(home);
      // Remove the done marker so re-run actually executes
      rmSync(join(home, '.gstack', '.migrations'), { recursive: true, force: true });

      const beforeAllowlist = readFileSync(join(home, '.gstack', '.brain-allowlist'), 'utf-8');
      const beforePrivacy = readFileSync(join(home, '.gstack', '.brain-privacy-map.json'), 'utf-8');
      const beforeAttrs = readFileSync(join(home, '.gstack', '.gitattributes'), 'utf-8');

      runMigration(home);

      const afterAllowlist = readFileSync(join(home, '.gstack', '.brain-allowlist'), 'utf-8');
      const afterPrivacy = readFileSync(join(home, '.gstack', '.brain-privacy-map.json'), 'utf-8');
      const afterAttrs = readFileSync(join(home, '.gstack', '.gitattributes'), 'utf-8');

      expect(afterAllowlist).toBe(beforeAllowlist);
      // jq may re-emit JSON with different whitespace but the parsed content
      // must be identical
      expect(JSON.parse(afterPrivacy)).toEqual(JSON.parse(beforePrivacy));
      expect(afterAttrs).toBe(beforeAttrs);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('repairs privacy-map even when allowlist is missing (per-file independence)', () => {
    const home = setupFakeHome();
    try {
      // No .brain-allowlist; only privacy-map present
      writeFileSync(join(home, '.gstack', '.brain-privacy-map.json'), JSON.stringify([
        { pattern: 'projects/*/learnings.jsonl', class: 'artifact' },
      ]));

      const r = runMigration(home);
      expect(r.code).toBe(0);

      // Privacy-map still patched
      const parsed = JSON.parse(readFileSync(join(home, '.gstack', '.brain-privacy-map.json'), 'utf-8'));
      const patterns = parsed.map((e: any) => e.pattern);
      expect(patterns).toContain('projects/*/*-design-*.md');
      // Allowlist remains absent (we don't create files that weren't there)
      expect(existsSync(join(home, '.gstack', '.brain-allowlist'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('migration marker prevents re-running', () => {
    const home = setupFakeHome();
    try {
      writeFileSync(join(home, '.gstack', '.brain-allowlist'), '# ---- USER ADDITIONS BELOW\n');
      runMigration(home);
      // Confirm marker file exists
      expect(existsSync(join(home, '.gstack', '.migrations', 'v1.38.1.0.done'))).toBe(true);

      // Modify allowlist so we can detect if the migration would re-run
      writeFileSync(join(home, '.gstack', '.brain-allowlist'), '# minimal\n');

      runMigration(home);

      // With the marker present, the migration short-circuits, so the file
      // we just wrote stays unmodified
      expect(readFileSync(join(home, '.gstack', '.brain-allowlist'), 'utf-8')).toBe('# minimal\n');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('handles allowlist without USER ADDITIONS marker (fallback to append)', () => {
    const home = setupFakeHome();
    try {
      writeFileSync(join(home, '.gstack', '.brain-allowlist'), [
        'projects/*/learnings.jsonl',
        'projects/*/designs/*.md',
        // no USER ADDITIONS marker
      ].join('\n') + '\n');

      const r = runMigration(home);
      expect(r.code).toBe(0);

      const content = readFileSync(join(home, '.gstack', '.brain-allowlist'), 'utf-8');
      expect(content).toContain('projects/*/*-design-*.md');
      expect(content).toContain('projects/*/*-test-plan-*.md');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// v1.40.0.0 — `projects/*/*-eng-review-test-plan-*.md` follow-on for #1452.
// v1.38.1.0 shipped the design + test-plan patterns but missed
// /plan-eng-review's filename. Codex review #5 flagged that
// v1.38.1.0's done-marker prevents users who already upgraded from picking
// up #1465's allowlist edit, so v1.40.0.0 needs its own migration.
// ──────────────────────────────────────────────────────────────────────────
const MIGRATION_V1_40 = join(REPO_ROOT, 'gstack-upgrade', 'migrations', 'v1.40.0.0.sh');

function runMigrationV140(fakeHome: string): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync({
    cmd: ['bash', MIGRATION_V1_40],
    env: { ...process.env, HOME: fakeHome },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    code: proc.exitCode ?? -1,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

describe('v1.40.0.0 migration', () => {
  test('adds eng-review-test-plan pattern to allowlist on top of an installed v1.38.1.0 state', () => {
    const home = setupFakeHome();
    try {
      // Simulate post-v1.38.1.0 state: design + test-plan patterns present,
      // done-marker set so the v1.38.1.0 migration wouldn't re-run.
      mkdirSync(join(home, '.gstack', '.migrations'), { recursive: true });
      writeFileSync(join(home, '.gstack', '.migrations', 'v1.38.1.0.done'), '');
      writeFileSync(join(home, '.gstack', '.brain-allowlist'), [
        'projects/*/learnings.jsonl',
        'projects/*/designs/*.md',
        'projects/*/*-design-*.md',
        'projects/*/*-test-plan-*.md',
        '# ---- USER ADDITIONS BELOW ---- (survives re-init; above is managed)',
        'projects/*/my-custom.txt',
      ].join('\n') + '\n');

      const r = runMigrationV140(home);
      expect(r.code).toBe(0);

      const content = readFileSync(join(home, '.gstack', '.brain-allowlist'), 'utf-8');
      expect(content).toContain('projects/*/*-eng-review-test-plan-*.md');
      // New pattern above the user marker.
      const engRevIdx = content.indexOf('projects/*/*-eng-review-test-plan-*.md');
      const markerIdx = content.indexOf('# ---- USER ADDITIONS BELOW');
      expect(engRevIdx).toBeLessThan(markerIdx);
      // User customizations below the marker preserved.
      expect(content).toContain('projects/*/my-custom.txt');
      // v1.40.0.0 done-marker created.
      expect(existsSync(join(home, '.gstack', '.migrations', 'v1.40.0.0.done'))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('adds eng-review-test-plan entry to privacy-map.json via jq', () => {
    const home = setupFakeHome();
    try {
      writeFileSync(join(home, '.gstack', '.brain-privacy-map.json'), JSON.stringify([
        { pattern: 'projects/*/*-design-*.md', class: 'artifact' },
        { pattern: 'projects/*/*-test-plan-*.md', class: 'artifact' },
      ], null, 2));

      const r = runMigrationV140(home);
      expect(r.code).toBe(0);

      const parsed = JSON.parse(readFileSync(join(home, '.gstack', '.brain-privacy-map.json'), 'utf-8'));
      const patterns = parsed.map((e: any) => e.pattern);
      expect(patterns).toContain('projects/*/*-eng-review-test-plan-*.md');
      expect(parsed.find((e: any) => e.pattern === 'projects/*/*-eng-review-test-plan-*.md').class).toBe('artifact');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('adds union-merge rule to gitattributes', () => {
    const home = setupFakeHome();
    try {
      writeFileSync(join(home, '.gstack', '.gitattributes'), [
        'projects/*/*-design-*.md merge=union',
        'projects/*/*-test-plan-*.md merge=union',
      ].join('\n') + '\n');

      const r = runMigrationV140(home);
      expect(r.code).toBe(0);

      const content = readFileSync(join(home, '.gstack', '.gitattributes'), 'utf-8');
      expect(content).toContain('projects/*/*-eng-review-test-plan-*.md merge=union');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('is idempotent: re-running is a no-op', () => {
    const home = setupFakeHome();
    try {
      writeFileSync(join(home, '.gstack', '.brain-allowlist'),
        'projects/*/*-eng-review-test-plan-*.md\n# ---- USER ADDITIONS BELOW ---- (survives re-init; above is managed)\n');

      const r1 = runMigrationV140(home);
      expect(r1.code).toBe(0);

      const r2 = runMigrationV140(home);
      expect(r2.code).toBe(0);

      const content = readFileSync(join(home, '.gstack', '.brain-allowlist'), 'utf-8');
      const occurrences = content.match(/projects\/\*\/\*-eng-review-test-plan-\*\.md/g) || [];
      expect(occurrences.length).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('writes done-marker even when files are missing', () => {
    const home = setupFakeHome();
    try {
      // No allowlist / privacy-map / gitattributes — fresh-init users with
      // no federated artifacts yet. Migration should still mark itself done.
      const r = runMigrationV140(home);
      expect(r.code).toBe(0);
      expect(existsSync(join(home, '.gstack', '.migrations', 'v1.40.0.0.done'))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
