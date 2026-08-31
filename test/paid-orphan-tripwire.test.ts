/**
 * No paid-gated test file may sit outside PAID_TEST_GLOBS.
 *
 * The orphan class this kills (found 2026-08): a file whose source gates on
 * EVALS/tier (so the free suite loads it as describe.skip) but whose NAME
 * doesn't match the paid globs (so no paid lane ever selects it) can never
 * execute anywhere — forever, silently. Four files were in that state
 * (codex-e2e-plan-format, codex-e2e-recommendation-substance,
 * llm-judge-recommendation, carve-section-loading), and the tripwire built
 * for the adjacent class (test/evals-workflow-matrix.test.ts) couldn't see
 * them because it filters on isPaidTestFile() FIRST.
 *
 * Detection is over source text, so meta-tests and helpers that mention the
 * gate patterns need reasoned exemptions (same convention as
 * test/egress-receipt-wiring.test.ts's SCANNER_EXEMPT).
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { isPaidTestFile } from './helpers/paid-test-set';

const ROOT = path.resolve(__dirname, '..');

/** Files that legitimately mention gate patterns without being paid tests. */
const SCANNER_EXEMPT = new Map<string, string>([
  // The gate helpers themselves and their free unit tests:
  ['test/helpers/e2e-gate.ts', 'defines the gate predicates'],
  // Meta-tests that quote gate-pattern strings to test classification:
  ['test/helpers/e2e-gate.unit.test.ts', 'free unit test OF the gate predicates (env stubbed)'],
  ['test/paid-shards.test.ts', 'quotes tier-guard strings as classification fixtures'],
  ['test/evals-workflow-matrix.test.ts', 'parses tier guards out of matrix files'],
  ['test/e2e-tier-alignment.test.ts', 'parses tier guards to enforce alignment'],
  ['test/paid-orphan-tripwire.test.ts', 'this scanner'],
]);

/**
 * Source shapes that mean "this file self-gates on the paid env":
 * the shared helpers, or a direct EVALS/EVALS_TIER env read.
 */
const GATE_PATTERNS = [
  /\bdescribeE2ETier\s*\(/,
  /\be2eTierEnabled\s*\(/,
  /process\.env\.EVALS\b/,
];

function trackedTestFiles(): string[] {
  const out = spawnSync('git', ['ls-files', '*.test.ts'], { cwd: ROOT, encoding: 'utf-8' });
  if (out.status !== 0) throw new Error(`git ls-files failed: ${out.stderr}`);
  return out.stdout.split('\n').filter(Boolean);
}

describe('paid orphan tripwire', () => {
  test('every EVALS/tier-gated test file is inside PAID_TEST_GLOBS (or exempt with a reason)', () => {
    const files = trackedTestFiles();
    expect(files.length).toBeGreaterThan(100); // scan-rot guard

    const orphans: string[] = [];
    for (const rel of files) {
      if (isPaidTestFile(rel)) continue;
      if (SCANNER_EXEMPT.has(rel)) continue;
      const source = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
      const hit = GATE_PATTERNS.find((p) => p.test(source));
      if (hit) orphans.push(`${rel} (matches ${hit})`);
    }
    expect(orphans,
      'paid-gated test files OUTSIDE the paid globs can never run in any lane. '
      + 'Fix: extend PAID_TEST_GLOBS in test/helpers/paid-test-set.ts (and mirror '
      + 'package.json), or add a reasoned SCANNER_EXEMPT entry if the file only '
      + `mentions the patterns:\n${orphans.join('\n')}`,
    ).toEqual([]);
  });

  test('exemption entries stay real (stale entries must be deleted)', () => {
    for (const [rel] of SCANNER_EXEMPT) {
      expect(fs.existsSync(path.join(ROOT, rel)), `stale SCANNER_EXEMPT entry: ${rel}`).toBe(true);
    }
  });
});
