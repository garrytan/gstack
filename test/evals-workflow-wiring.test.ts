/**
 * Sliced-lane wiring pins for the paid CI workflows — the successor to
 * evals-workflow-matrix.test.ts, which enforced completeness of a
 * hand-enumerated 17-row matrix (and carried KNOWN_MATRIX_GAPS /
 * KNOWN_TIER_UNSET burn-down ratchets for the files that matrix missed).
 * The matrix is deleted: the sliced lane's planner derives the gate census
 * from the runner itself (collectPaidTestFiles + tier selection), so "every
 * gate-hosting file is in the census" is true BY CONSTRUCTION and the
 * burn-down ratchets retired with the rows.
 *
 * What still needs pinning is the WIRING — the yml plumbing that free tests
 * are the only guard for:
 *   - the legacy matrix (and its `needs: evals` serialization) stays deleted,
 *   - planner/executor/report all run tier=gate and agree on the slice count,
 *   - both surviving lanes register skills through the SHARED composite that
 *     carries the fail-fast dangling-symlink/frontmatter verification loop
 *     (the sliced + periodic copies had silently dropped it — the loop was
 *     written after a silent "Unknown command" + 35-min-timeout incident),
 *   - the PR comment survives the matrix-report deletion (it moved into
 *     slices-report, keyed on the same "## E2E Evals" upsert marker).
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(import.meta.dir, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

const evalsYml = read('.github/workflows/evals.yml');
const periodicYml = read('.github/workflows/evals-periodic.yml');
const registerAction = read('.github/actions/register-gstack-skills/action.yml');

/** Slice count the planner emits (`--slices N`) in a workflow source. */
function plannedSlices(source: string): number[] {
  return [...source.matchAll(/--emit-plan\s+\S+\s+--slices\s+(\d+)/g)].map((m) => Number(m[1]));
}

/** The executor matrix's slice list (`slice: [1, 2, ...]`). */
function matrixSlices(source: string): number[][] {
  return [...source.matchAll(/^\s+slice: \[([\d,\s]+)\]\s*$/gm)].map((m) =>
    m[1].split(',').map((n) => Number(n.trim())),
  );
}

describe('evals.yml sliced-lane wiring (post-matrix)', () => {
  test('the legacy matrix job stays deleted', () => {
    // Row-enumeration shapes from the deleted matrix. Any reappearance means
    // someone is re-growing a hand-maintained enumeration next to a lane
    // whose census is derived — the drift class the deletion killed.
    expect(evalsYml).not.toMatch(/^\s+suite:\s*$/m);
    expect(evalsYml).not.toMatch(/^\s+file: test\//m);
    expect(evalsYml).not.toContain('needs: [build-image, evals]');
    expect(evalsYml).not.toMatch(/^\s+needs: evals\s*$/m);
  });

  test('no workflow-level EVALS_TIER env (each command sets its own)', () => {
    // The workflow-level `EVALS_TIER: gate` was dead config once every
    // consumer set its own; a resurrected copy would silently leak gate
    // semantics into steps that must choose explicitly.
    expect(evalsYml).not.toMatch(/^env:[\s\S]{0,120}^\s+EVALS_TIER:/m);
  });

  test('planner, executors, and report all run tier=gate on the shared runner', () => {
    expect(evalsYml).toMatch(/EVALS_TIER=gate bun run scripts\/test-paid-shards\.ts --tier gate --emit-plan/);
    expect(evalsYml).toMatch(/EVALS_TIER=gate bun run scripts\/test-paid-shards\.ts --tier gate --plan .* --slice /);
    expect(evalsYml).toMatch(/EVALS_TIER=gate bun run scripts\/test-paid-shards\.ts --tier gate --report /);
  });

  test('executor matrix slice list matches the planner --slices count', () => {
    const planned = plannedSlices(evalsYml);
    const matrices = matrixSlices(evalsYml);
    expect(planned, 'expected exactly one --emit-plan site in evals.yml').toHaveLength(1);
    expect(matrices, 'expected exactly one slice matrix in evals.yml').toHaveLength(1);
    const n = planned[0];
    expect(matrices[0]).toEqual(Array.from({ length: n }, (_, i) => i + 1));
  });

  test('reconcile exit is captured via PIPESTATUS, never $? after a pipe', () => {
    // GitHub's default run-step shell is `bash -e {0}` with NO pipefail, so
    // `$?` after `... | tee` is tee's exit — always 0. That made the
    // fail-closed reconcile gate silently fail-open (ship review army,
    // 2026-08-31). Both lanes must read PIPESTATUS[0].
    for (const [name, source] of [['evals.yml', evalsYml], ['evals-periodic.yml', periodicYml]] as const) {
      const reconcileBlocks = [...source.matchAll(/--report[^\n]*\| tee[^\n]*\n([\s\S]{0,400}?)GITHUB_OUTPUT/g)];
      expect(reconcileBlocks.length, `${name}: expected a tee'd reconcile step`).toBeGreaterThanOrEqual(1);
      for (const block of reconcileBlocks) {
        expect(block[1], `${name} reconcile captures tee's exit, not the runner's`).toContain('PIPESTATUS[0]');
        expect(block[1]).not.toMatch(/exit=\$\?/);
      }
    }
  });

  test('the PR comment survived the matrix-report deletion (moved to slices-comment)', () => {
    // Keyed on the upsert marker so the migration keeps updating the SAME
    // comment; and the job holding it needs the issues permission (#1802).
    expect(evalsYml).toContain('## E2E Evals');
    expect(evalsYml).toMatch(/pull-requests: write/);
    expect(evalsYml).toMatch(/issues: write/);
  });

  test('the write-token job runs ZERO repo code (token/exec separation)', () => {
    // slices-report executes PR-authored code (bun install + the reconcile
    // runner), so it must hold contents:read ONLY; the write token lives in
    // slices-comment, which may only download artifacts and run jq/gh —
    // $GITHUB_ENV persistence is job-scoped, so this split IS the trust
    // boundary (codex adversarial, 2026-08-31; the matrix-era report job had
    // this property and the consolidation briefly regressed it).
    const commentJob = evalsYml.slice(evalsYml.indexOf('  slices-comment:'));
    expect(commentJob.length).toBeGreaterThan(100);
    expect(commentJob).not.toContain('actions/checkout');
    expect(commentJob).not.toContain('bun install');
    expect(commentJob).not.toMatch(/run: .*bun run/);
    expect(commentJob).not.toContain('uses: ./');
    // No checkout also means no git context: `gh pr comment` resolves the
    // repo FROM git and dies with "not a git repository" here (PR #2746's
    // first run). Every comment call must be explicit-repo REST (gh api).
    expect(commentJob).not.toContain('gh pr comment');
    // And the code-executing report job must NOT hold write scopes.
    const reportJob = evalsYml.slice(evalsYml.indexOf('  slices-report:'), evalsYml.indexOf('  slices-comment:'));
    expect(reportJob).not.toMatch(/pull-requests: write/);
    expect(reportJob).not.toMatch(/issues: write/);
  });
});

describe('evals-periodic.yml sliced-lane wiring', () => {
  test('planner/executor/report tier=periodic and slice counts agree', () => {
    expect(periodicYml).toMatch(/EVALS_TIER=periodic bun run scripts\/test-paid-shards\.ts --tier periodic --emit-plan/);
    expect(periodicYml).toMatch(/EVALS_TIER=periodic bun run scripts\/test-paid-shards\.ts --tier periodic --plan .* --slice /);
    expect(periodicYml).toMatch(/EVALS_TIER=periodic bun run scripts\/test-paid-shards\.ts --tier periodic --report /);
    const planned = plannedSlices(periodicYml);
    const matrices = matrixSlices(periodicYml);
    expect(planned).toHaveLength(1);
    expect(matrices).toHaveLength(1);
    expect(matrices[0]).toEqual(Array.from({ length: planned[0] }, (_, i) => i + 1));
  });
});

describe('shared setup composites (both surviving lanes)', () => {
  test('both lanes register skills through the shared composite', () => {
    for (const [name, source] of [['evals.yml', evalsYml], ['evals-periodic.yml', periodicYml]] as const) {
      expect(source, `${name} must use the register-gstack-skills composite`)
        .toContain('uses: ./.github/actions/register-gstack-skills');
      // No inline re-implementation creeping back beside the composite.
      expect(source, `${name} re-inlines the skill registry instead of using the composite`)
        .not.toContain('ln -snf "$REPO" "$SKILLS_DIR/gstack"');
    }
  });

  test('the register composite carries the fail-fast verification loop', () => {
    // The loop is the POINT of the composite: a dangling symlink or renamed
    // committed target fails in seconds with a named path, never as a wedged
    // PTY session at the shard wall. Pin its load-bearing markers.
    expect(registerAction).toContain('skill registry OK');
    expect(registerAction).toContain('skill-registry target missing');
    expect(registerAction).toContain('gstack root symlink dangles');
    expect(registerAction).toMatch(/grep -m1 "\^name: \$s\\\$"/);
  });

  test('seed/deps/temp composites exist and both lanes use them', () => {
    for (const action of ['seed-claude-config', 'restore-deps', 'fix-bun-temp']) {
      expect(fs.existsSync(path.join(ROOT, '.github', 'actions', action, 'action.yml')), `missing composite: ${action}`).toBe(true);
    }
    for (const [name, source] of [['evals.yml', evalsYml], ['evals-periodic.yml', periodicYml]] as const) {
      expect(source, `${name} must use seed-claude-config`).toContain('uses: ./.github/actions/seed-claude-config');
      expect(source, `${name} must use restore-deps`).toContain('uses: ./.github/actions/restore-deps');
      expect(source, `${name} must use fix-bun-temp`).toContain('uses: ./.github/actions/fix-bun-temp');
    }
  });
});
