/**
 * Regression pin for the setup-time gbrain detection → gen-skill-docs
 * override (T2 / v1.50.0.0).
 *
 * The override mechanism lives in scripts/gen-skill-docs.ts: when invoked
 * with --respect-detection, it reads ~/.gstack/gbrain-detection.json and
 * un-suppresses GBRAIN_CONTEXT_LOAD + GBRAIN_SAVE_RESULTS for hosts that
 * statically list them in suppressedResolvers (claude, codex, slate,
 * factory, opencode, openclaw, cursor, kiro).
 *
 * Tests drive gen-skill-docs as a subprocess against a temp GSTACK_HOME
 * with each detection state, then assert what landed in the generated
 * Claude-host SKILL.md. This is end-to-end through the actual override
 * pipeline — no mocking — so it catches regressions in either the loader
 * or the suppressedResolvers filter.
 *
 * Gate-tier, free, ~3-5s per test (gen-skill-docs runs the full skill
 * generation against the real repo; --host claude scopes to one host).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const REPO_ROOT = join(import.meta.dir, '..');

interface FixtureEnv {
  tmpHome: string;
  cleanup: () => void;
}

function makeFixture(detectionJson: string | null): FixtureEnv {
  const tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-detect-test-'));
  if (detectionJson !== null) {
    writeFileSync(join(tmpHome, 'gbrain-detection.json'), detectionJson);
  }
  return {
    tmpHome,
    cleanup: () => {
      try {
        rmSync(tmpHome, { recursive: true, force: true });
      } catch {
        // best effort
      }
    },
  };
}

/**
 * Run gen-skill-docs with --respect-detection and an isolated GSTACK_HOME.
 * Returns the regenerated office-hours/SKILL.md content WITHOUT writing
 * over the committed file: we use --dry-run to keep the working tree
 * clean, then parse the output via re-reading the committed file... no,
 * that doesn't work for dry-run since dry-run doesn't write.
 *
 * Approach: generate to a temp output dir by running gen-skill-docs in a
 * temp checkout. Simpler alternative: actually regenerate, snapshot the
 * file content, then git-checkout the committed version back. We use this
 * since gen-skill-docs doesn't expose an output-path arg.
 */
function regenAndSnapshot(opts: {
  respectDetection: boolean;
  tmpHome: string;
  files: string[];
}): Map<string, string> {
  // Save committed content so we can restore after snapshotting.
  const original = new Map<string, string>();
  for (const f of opts.files) {
    original.set(f, readFileSync(join(REPO_ROOT, f), 'utf-8'));
  }

  const args = [
    'run',
    'scripts/gen-skill-docs.ts',
    '--host',
    'claude',
  ];
  if (opts.respectDetection) args.push('--respect-detection');

  try {
    execFileSync('bun', args, {
      cwd: REPO_ROOT,
      env: { ...process.env, GSTACK_HOME: opts.tmpHome },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });

    // Snapshot the regenerated content.
    const snapshot = new Map<string, string>();
    for (const f of opts.files) {
      snapshot.set(f, readFileSync(join(REPO_ROOT, f), 'utf-8'));
    }
    return snapshot;
  } finally {
    // Always restore so the test leaves the working tree clean.
    for (const [f, content] of original) {
      writeFileSync(join(REPO_ROOT, f), content);
    }
  }
}

describe('gbrain detection override → gen-skill-docs', () => {
  // Single skill probe is enough to assert the override pipeline. The
  // resolver unit test (test/resolvers-gbrain-save-results.test.ts) covers
  // per-skill metadata correctness already.
  // office-hours is carved (v2 plan T9): GBRAIN_CONTEXT_LOAD stays in the
  // skeleton, GBRAIN_SAVE_RESULTS moved into sections/design-and-handoff.md.
  // Probe the union so the detection override is asserted wherever the blocks land.
  const PROBE_FILES = ['office-hours/SKILL.md', 'office-hours/sections/design-and-handoff.md'];
  const probeUnion = (snap: Map<string, string>): string =>
    (snap.get('office-hours/SKILL.md') ?? '') + '\n' + (snap.get('office-hours/sections/design-and-handoff.md') ?? '');

  test('with detected:true, Claude-host SKILL.md gains brain-aware blocks', () => {
    const { tmpHome, cleanup } = makeFixture(
      JSON.stringify({ gbrain_local_status: 'ok', gbrain_on_path: true, gbrain_version: 'test-0.41.0' }),
    );
    try {
      const snap = regenAndSnapshot({
        respectDetection: true,
        tmpHome,
        files: PROBE_FILES,
      });
      const content = probeUnion(snap);

      // GBRAIN_SAVE_RESULTS un-suppressed → resolver output rendered.
      expect(content).toContain('## Save Results to Brain');
      expect(content).toContain('gbrain put "office-hours/');
      expect(content).toContain('Skip this entire section if `gbrain` is not on PATH');

      // GBRAIN_CONTEXT_LOAD also un-suppressed (D6 bundling).
      expect(content).toContain('## Brain Context Load');
    } finally {
      cleanup();
    }
  });

  test('with status "timeout" (slow-but-healthy, #1964), brain blocks render like "ok"', () => {
    const { tmpHome, cleanup } = makeFixture(
      JSON.stringify({ gbrain_local_status: 'timeout', gbrain_on_path: true, gbrain_version: 'test-0.41.0' }),
    );
    try {
      const snap = regenAndSnapshot({
        respectDetection: true,
        tmpHome,
        files: PROBE_FILES,
      });
      const content = probeUnion(snap);

      // A slow engine must not silently suppress brain features — same
      // treatment as "ok" (matches gstack-gbrain-detect --is-ok).
      expect(content).toContain('## Save Results to Brain');
      expect(content).toContain('gbrain put "office-hours/');
    } finally {
      cleanup();
    }
  });

  test('with detected:false (status != "ok"), brain blocks stay suppressed', () => {
    const { tmpHome, cleanup } = makeFixture(
      JSON.stringify({ gbrain_local_status: 'no-cli', gbrain_on_path: false, gbrain_version: null }),
    );
    try {
      const snap = regenAndSnapshot({
        respectDetection: true,
        tmpHome,
        files: PROBE_FILES,
      });
      const content = probeUnion(snap);

      // GBRAIN_SAVE_RESULTS suppressed → no rendered block, no gbrain put line.
      expect(content).not.toContain('gbrain put "office-hours/');
      // Section header from the resolver also absent (resolver returns "").
      // BUT — the BRAIN_CACHE_REFRESH and BRAIN_WRITE_BACK resolvers are NOT
      // gated by detection (host-agnostic), so other "Brain ..." sections may
      // still appear. We only assert the SAVE_RESULTS-specific marker is gone.
    } finally {
      cleanup();
    }
  });

  test('with NO detection file, brain blocks stay suppressed (same as detected:false)', () => {
    const { tmpHome, cleanup } = makeFixture(null);
    try {
      const snap = regenAndSnapshot({
        respectDetection: true,
        tmpHome,
        files: PROBE_FILES,
      });
      const content = probeUnion(snap);
      expect(content).not.toContain('gbrain put "office-hours/');
    } finally {
      cleanup();
    }
  });

  test('without --respect-detection flag, detection file is IGNORED (CI canonical path)', () => {
    // Even if a detection file exists with detected:true, the default
    // `bun run gen:skill-docs` (CI) must produce no-gbrain output so the
    // committed SKILL.md stays reproducible regardless of any developer's
    // local gbrain install state.
    const { tmpHome, cleanup } = makeFixture(
      JSON.stringify({ gbrain_local_status: 'ok', gbrain_on_path: true, gbrain_version: 'test-0.41.0' }),
    );
    try {
      const snap = regenAndSnapshot({
        respectDetection: false,
        tmpHome,
        files: PROBE_FILES,
      });
      const content = probeUnion(snap);
      expect(content).not.toContain('gbrain put "office-hours/');
      expect(content).not.toContain('## Save Results to Brain');
    } finally {
      cleanup();
    }
  });
});
