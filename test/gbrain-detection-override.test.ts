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
 * with each detection state, rendering into an isolated --out-dir (never
 * writing the working tree), then assert what landed in the rendered
 * Claude-host SKILL.md. This is end-to-end through the actual override
 * pipeline — no mocking — so it catches regressions in either the loader
 * or the suppressedResolvers filter.
 *
 * Gate-tier, free, ~3-5s per test (gen-skill-docs runs the full skill
 * generation against the real repo; --host claude scopes to one host).
 */

import { describe, test, expect } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
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
 * Run gen-skill-docs with --respect-detection and an isolated GSTACK_HOME,
 * rendering into a fresh --out-dir. The working tree is never written: the
 * generator reads its inputs (templates, resolvers) from the repo but lands
 * every output in the temp dir, which we snapshot and delete. This replaced
 * the old mutate-then-restore approach (which regenerated the committed
 * files in place and only restored the probe files, leaving every OTHER
 * generated file rewritten — a partial-restore hazard for concurrent
 * readers).
 */
function regenAndSnapshot(opts: {
  respectDetection: boolean;
  tmpHome: string;
  files: string[];
}): Map<string, string> {
  const outDir = mkdtempSync(join(tmpdir(), 'gbrain-detect-out-'));

  const args = [
    'run',
    'scripts/gen-skill-docs.ts',
    '--host',
    'claude',
    '--out-dir',
    outDir,
  ];
  if (opts.respectDetection) args.push('--respect-detection');

  try {
    execFileSync('bun', args, {
      cwd: REPO_ROOT,
      env: { ...process.env, GSTACK_HOME: opts.tmpHome },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });

    // Snapshot the rendered content from the out-dir.
    const snapshot = new Map<string, string>();
    for (const f of opts.files) {
      snapshot.set(f, readFileSync(join(outDir, f), 'utf-8'));
    }
    return snapshot;
  } finally {
    rmSync(outDir, { recursive: true, force: true });
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

  test('with status "engine-locked" (PGLite single-writer, #2456), brain blocks render like "ok"', () => {
    const { tmpHome, cleanup } = makeFixture(
      JSON.stringify({
        gbrain_local_status: 'engine-locked',
        gbrain_on_path: true,
        gbrain_version: 'test-0.42.26',
      }),
    );
    try {
      const snap = regenAndSnapshot({
        respectDetection: true,
        tmpHome,
        files: PROBE_FILES,
      });
      const content = probeUnion(snap);

      // PGLite is single-writer: a live `gbrain serve` (the recommended
      // /setup-gbrain default spawns one at session start) legitimately owns
      // the embedded DB. gbrain is installed and healthy — a transient lock
      // must not silently strip brain blocks (same reasoning as "timeout").
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
