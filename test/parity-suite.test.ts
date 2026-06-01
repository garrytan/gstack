/**
 * Cathedral parity suite — gate-tier (free, structural + content checks).
 *
 * Runs every PARITY_INVARIANTS check against the current SKILL.md output
 * vs the v1.53.0.0 baseline. Failures get an actionable, per-skill report
 * showing missing phrases, missing headings, and size ratios.
 *
 * Baseline rebased v1.44.1 → v1.53.0.0: the brain-aware-planning releases
 * (v1.49–v1.52) plus the v1.53 redaction guard pushed five planning skills
 * past the 5% ratchet on the frozen v1.44.1 anchor. Rebasing absorbs that
 * legitimate growth at HEAD while keeping the per-skill 1.05 ratio so future
 * bloat is still caught. Historical v1.44.1 / v1.46.0.0 / v1.47.0.0 baselines
 * are retained in test/fixtures/ for the v1→v2 audit trail.
 *
 * Periodic-tier LLM-judge parity (paid) lands in Phase B (v2.0.0.0)
 * alongside the sections/ extraction. Plumbing is in parity-harness.ts.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { runParityChecks, PARITY_INVARIANTS } from './helpers/parity-harness';
import type { ParityBaseline } from './helpers/capture-parity-baseline';

const REPO_ROOT = path.resolve(import.meta.dir, '..');
const BASELINE_PATH = path.join(REPO_ROOT, 'test', 'fixtures', 'parity-baseline-v1.53.0.0.json');

describe('parity suite vs v1.53.0.0 baseline (gate, free)', () => {
  test('baseline exists', () => {
    expect(fs.existsSync(BASELINE_PATH)).toBe(true);
  });

  test('all PARITY_INVARIANTS pass', () => {
    const baseline: ParityBaseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8'));
    const report = runParityChecks({
      repoRoot: REPO_ROOT,
      baseline,
      invariants: PARITY_INVARIANTS,
    });

    // eslint-disable-next-line no-console
    console.log(
      `[parity] ${report.passed}/${report.totalChecks} skills passed parity vs ${baseline.tag}`,
    );

    if (report.failed === 0) return;

    const failureMessages = report.details
      .filter(d => !d.passed)
      .map(d => `  ${d.skill}:\n    - ${d.failures.join('\n    - ')}`)
      .join('\n');
    throw new Error(
      `${report.failed} skill(s) failed parity checks vs ${baseline.tag}:\n${failureMessages}`,
    );
  });
});
