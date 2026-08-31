/**
 * CI eval-matrix completeness tripwire — kills the silent-skip class where a
 * gate-tier test exists in the repo but the hand-enumerated matrix in
 * .github/workflows/evals.yml never runs it, so "gate tier blocks merge" is
 * quietly false in CI. This has happened before (see the "rehomed from the
 * deleted pre-split monolith" comment in evals.yml) and was found again on
 * PR #2700: nine gate-hosting files absent from the matrix, plus matrix rows
 * whose whole-file tier guards can never fire because the Run step exported
 * no EVALS_TIER.
 *
 * Ratchet, not amnesty: the KNOWN_* lists below enumerate the PRE-EXISTING
 * gaps with reasons, so no NEW gap can land while the backlog burns down
 * (same pattern as SCANNER_EXEMPT in egress-receipt-wiring). If you fix a
 * listed gap (add its matrix row / tier property), this test FAILS until you
 * remove the entry — stale exemptions are enforced, not decorative.
 *
 * Wiring pinned:
 *  - every matrix `file:` path exists on disk (no stale rows),
 *  - every gate-hosting paid file (whole-file gate self-gate, or named in the
 *    dep list of a gate-tier E2E_TOUCHFILES key) appears in the matrix or in
 *    KNOWN_MATRIX_GAPS,
 *  - every matrix file with a whole-file tier guard has a matching row-level
 *    `tier:` property (else the suite self-skips and the job is hollow-green)
 *    or sits in KNOWN_TIER_UNSET.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { E2E_TOUCHFILES, E2E_TIERS } from './helpers/touchfiles-data';
import { isPaidTestFile } from './helpers/paid-test-set';

const ROOT = path.join(import.meta.dir, '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'evals.yml');

/**
 * Pre-existing gate-hosting files with no matrix row (found 2026-08-26,
 * PR #2700). Adding a row activates real paid runs on every PR — a cost and
 * flake-surface decision per file, tracked in TODOS.md ("CI gate-lane
 * hollow-coverage burn-down"). Fix = add a matrix row (plus `tier: gate` when
 * the file is whole-file gated), then DELETE the entry here.
 */
const KNOWN_MATRIX_GAPS = new Set([
  'test/skill-e2e-ask-user-question-format-compliance.test.ts',
  'test/skill-e2e-hermetic-canary.test.ts',
  'test/skill-e2e-ios.test.ts',
  'test/skill-e2e-plan-ceo-finding-floor.test.ts',
  'test/skill-e2e-plan-ceo-plan-mode.test.ts',
  'test/skill-e2e-plan-design-with-ui.test.ts',
  'test/skill-e2e-plan-devex-finding-floor.test.ts',
  'test/skill-e2e-plan-devex-plan-mode.test.ts',
  // Exposed by the 2026-08 dep-list self-registration sweep: these eight had
  // zero gate-key dep-list membership before it, so the census never saw
  // them as gate-hosting. Their gate tests run in NO CI lane today. The
  // paid-lane re-platform (test-paid-shards.ts as the CI engine) runs every
  // gate-tier file by construction and retires this whole ratchet.
  'test/skill-e2e-cso.test.ts',
  'test/skill-e2e-diagram.test.ts',
  'test/skill-e2e-learnings.test.ts',
  'test/skill-e2e-plan-tune.test.ts',
  'test/skill-e2e-plan-tune-cathedral.test.ts',
  'test/skill-e2e-review-army.test.ts',
  'test/skill-e2e-session-intelligence.test.ts',
  'test/skill-e2e-skillify.test.ts',
]);

/**
 * Matrix files whose whole-file tier guard has no matching row `tier:`
 * property. Burned down to empty 2026-08-29: the vestigial codex/gemini rows
 * were deleted (periodic-tier files, zero tests per PR) and
 * e2e-pty-plan-smoke gained its `tier: gate`. The ratchet stays so a future
 * row/file tier mismatch fails the suite instead of shipping hollow green.
 */
const KNOWN_TIER_UNSET = new Map<string, string>([]);

interface MatrixRow {
  name: string;
  files: string[];
  tier?: string;
}

/** Parse the `matrix: suite:` rows (name / file / optional tier) from evals.yml. */
function parseMatrixRows(source: string): MatrixRow[] {
  const rows: MatrixRow[] = [];
  let current: MatrixRow | null = null;
  for (const line of source.split('\n')) {
    const name = line.match(/^\s+- name: (\S+)\s*$/);
    if (name) {
      if (current) rows.push(current);
      current = { name: name[1], files: [] };
      continue;
    }
    if (!current) continue;
    const file = line.match(/^\s+file: (.+?)\s*$/);
    if (file) current.files.push(...file[1].trim().split(/\s+/));
    const tier = line.match(/^\s+tier: (\S+)\s*$/);
    if (tier) current.tier = tier[1];
    // `steps:` ends the strategy block — stop before step-level keys leak in.
    if (/^\s{4}steps:\s*$/.test(line)) break;
  }
  if (current) rows.push(current);
  return rows.filter((r) => r.files.length > 0);
}

const wholeFileTier = (source: string): string | null => {
  const m =
    /\b(?:describeE2ETier|e2eTierEnabled)\(\s*['"`](gate|periodic)['"`]/.exec(source) ||
    /EVALS_TIER\s*===\s*['"`](gate|periodic)['"`]/.exec(source);
  return m ? m[1] : null;
};

const workflowSource = fs.readFileSync(WORKFLOW, 'utf-8');
const rows = parseMatrixRows(workflowSource);
const matrixFiles = new Map<string, MatrixRow>();
for (const row of rows) for (const f of row.files) matrixFiles.set(f, row);

const paidFiles = fs
  .readdirSync(path.join(ROOT, 'test'))
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => `test/${f}`)
  .filter(isPaidTestFile);

describe('evals.yml matrix completeness (gate-lane silent-skip tripwire)', () => {
  test('matrix parse sanity: rows and known suites present', () => {
    expect(rows.length).toBeGreaterThanOrEqual(15);
    expect(matrixFiles.has('test/skill-e2e-workflow.test.ts')).toBe(true);
    expect(matrixFiles.has('test/skill-e2e-ship-docsync.test.ts')).toBe(true);
  });

  test('every matrix file exists on disk', () => {
    const missing = [...matrixFiles.keys()].filter(
      (f) => !fs.existsSync(path.join(ROOT, f))
    );
    expect(missing).toEqual([]);
  });

  test('every gate-hosting paid file is in the matrix (or the documented backlog)', () => {
    const gaps: string[] = [];
    for (const file of paidFiles) {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf-8');
      const declaresGate = wholeFileTier(source) === 'gate';
      const inGateDeps = Object.entries(E2E_TOUCHFILES).some(
        ([key, deps]) =>
          (E2E_TIERS as Record<string, string>)[key] === 'gate' &&
          (deps as string[]).includes(file)
      );
      if (!declaresGate && !inGateDeps) continue;
      if (matrixFiles.has(file) || KNOWN_MATRIX_GAPS.has(file)) continue;
      gaps.push(file);
    }
    expect(
      gaps,
      `Gate-hosting test file(s) missing from the evals.yml matrix — CI will ` +
        `never run them and "gate tier blocks merge" becomes silently false. ` +
        `Add a matrix row (with tier: gate when the file is whole-file gated). ` +
        `Do NOT extend KNOWN_MATRIX_GAPS for new files.`
    ).toEqual([]);
  });

  test('matrix rows for whole-file-gated files carry a matching tier property', () => {
    const mismatches: string[] = [];
    for (const [file, row] of matrixFiles) {
      if (!fs.existsSync(path.join(ROOT, file))) continue;
      const declared = wholeFileTier(fs.readFileSync(path.join(ROOT, file), 'utf-8'));
      if (!declared) continue;
      if (row.tier === declared) continue;
      if (KNOWN_TIER_UNSET.get(file) === declared && row.tier === undefined) continue;
      mismatches.push(`${file} declares '${declared}' but row '${row.name}' has tier: ${row.tier ?? 'unset'}`);
    }
    expect(
      mismatches,
      `A whole-file tier guard with no matching row tier means the suite ` +
        `self-skips and the CI job reports a hollow green. Set tier: <declared> ` +
        `on the row (the Run step exports it as EVALS_TIER).`
    ).toEqual([]);
  });

  test('burn-down lists hold only live gaps (ratchet cleanup enforcement)', () => {
    const staleGaps = [...KNOWN_MATRIX_GAPS].filter(
      (f) => matrixFiles.has(f) || !fs.existsSync(path.join(ROOT, f))
    );
    expect(
      staleGaps,
      'Entry fixed or file removed — delete it from KNOWN_MATRIX_GAPS.'
    ).toEqual([]);
    const staleTiers = [...KNOWN_TIER_UNSET.entries()].filter(([f, declared]) => {
      const row = matrixFiles.get(f);
      if (!row) return true; // row deleted — entry no longer applies
      if (row.tier === declared) return true; // fixed — entry must go
      if (!fs.existsSync(path.join(ROOT, f))) return true;
      return wholeFileTier(fs.readFileSync(path.join(ROOT, f), 'utf-8')) !== declared;
    });
    expect(
      staleTiers.map(([f]) => f),
      'Entry fixed, row removed, or guard changed — delete it from KNOWN_TIER_UNSET.'
    ).toEqual([]);
  });
});
