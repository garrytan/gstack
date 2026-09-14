/**
 * Gap C (v1.46.0.0): parity-baseline-v1.44.1.json integrity check.
 *
 * The v1.44.1 baseline file is the source of every "v1 was X bytes" claim
 * in CHANGELOG.md (v1.46.0.0 entry) and the reference for the per-skill
 * size-budget gate, the parity-suite content invariants, and the published
 * compression numbers. If a contributor (or a sloppy rebase) edits the
 * file, every downstream claim silently becomes unverifiable.
 *
 * This test pins:
 *   1. The file exists.
 *   2. Its top-level `tag` is "v1.44.1" (rejects a rename-by-edit).
 *   3. Its `capturedFromCommit` is the v1.44.1.0 release commit (or earlier
 *      commit on the slim-skill-tokens branch where the baseline was
 *      captured — both are immutable historic SHAs).
 *   4. The headline numbers reported in CHANGELOG.md are present in the
 *      baseline JSON. If someone "fixes" the JSON numbers without updating
 *      CHANGELOG (or vice versa), this surfaces the mismatch.
 *   5. A whitelist of known stable commits — anything else means someone
 *      regenerated the baseline against fresh-current-state, which defeats
 *      the v1→v2 reference contract.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

const REPO_ROOT = path.resolve(import.meta.dir, '..');
const BASELINE_PATH = path.join(REPO_ROOT, 'test', 'fixtures', 'parity-baseline-v1.44.1.json');
const CHANGELOG_PATH = path.join(REPO_ROOT, 'CHANGELOG.md');

/**
 * The baseline was captured at this commit on the slim-skill-tokens branch
 * (commit 74bc8054, just after v2_PLAN.md landed and before any compression
 * work). If the baseline is ever regenerated, this whitelist must change AND
 * the v1.46.0.0 CHANGELOG numbers table must be updated to reflect the new
 * v1.x baseline.
 */
const ALLOWED_BASELINE_COMMITS = new Set([
  '74bc8054',
]);

/**
 * Headline numbers from the v1.46.0.0 CHANGELOG entry. If the baseline JSON
 * is edited, these no longer match and the user's published claims become
 * unverifiable. We assert the baseline still contains these values.
 */
const EXPECTED_v144_NUMBERS = {
  totalSkills: 51,
  totalCorpusBytesMin: 2_900_000, // CHANGELOG says ~2,847 KB (uses Math.round(/1024)); allow ±10K slack
  totalCorpusBytesMax: 2_930_000,
  estTotalCatalogTokensMin: 9_300,
  estTotalCatalogTokensMax: 9_340, // CHANGELOG cites ~9,319
};

describe('parity-baseline-v1.44.1.json integrity (v1→v2 reference)', () => {
  test('file exists at the canonical path', () => {
    expect(fs.existsSync(BASELINE_PATH)).toBe(true);
  });

  test('tag is "v1.44.1" — file was not renamed by edit', () => {
    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8'));
    expect(baseline.tag).toBe('v1.44.1');
  });

  test('capturedFromCommit is on the allowlist (rejects ad-hoc regeneration)', () => {
    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8'));
    if (!ALLOWED_BASELINE_COMMITS.has(baseline.capturedFromCommit)) {
      throw new Error(
        `parity-baseline-v1.44.1.json was captured at commit ${baseline.capturedFromCommit}, ` +
        `not on the allowlist (${[...ALLOWED_BASELINE_COMMITS].join(', ')}).\n` +
        `If you intentionally regenerated the baseline, add the new commit to ` +
        `ALLOWED_BASELINE_COMMITS in test/parity-baseline-integrity.test.ts AND ` +
        `update the v1.46.0.0 CHANGELOG numbers table to match the new baseline.\n` +
        `If you didn't intend to regenerate it, restore the file from git history.`,
      );
    }
  });

  test('totalSkills matches expected (51)', () => {
    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8'));
    expect(baseline.totalSkills).toBe(EXPECTED_v144_NUMBERS.totalSkills);
  });

  test('totalCorpusBytes is within the CHANGELOG-cited range (~2,847 KB)', () => {
    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8'));
    expect(baseline.totalCorpusBytes).toBeGreaterThanOrEqual(EXPECTED_v144_NUMBERS.totalCorpusBytesMin);
    expect(baseline.totalCorpusBytes).toBeLessThanOrEqual(EXPECTED_v144_NUMBERS.totalCorpusBytesMax);
  });

  test('estTotalCatalogTokens matches the CHANGELOG-cited ~9,319', () => {
    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8'));
    expect(baseline.estTotalCatalogTokens).toBeGreaterThanOrEqual(EXPECTED_v144_NUMBERS.estTotalCatalogTokensMin);
    expect(baseline.estTotalCatalogTokens).toBeLessThanOrEqual(EXPECTED_v144_NUMBERS.estTotalCatalogTokensMax);
  });

  test('CHANGELOG v1.46.0.0 entry references this baseline file by path', () => {
    const changelog = fs.readFileSync(CHANGELOG_PATH, 'utf-8');
    // The CHANGELOG entry must mention the baseline file so reviewers know
    // where the numbers come from. If someone edits one without the other,
    // this test surfaces the drift.
    expect(changelog).toContain('parity-baseline-v1.44.1.json');
  });

  test('every per-skill entry has the required shape', () => {
    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8'));
    for (const [skill, entry] of Object.entries(baseline.skills)) {
      const e = entry as Record<string, unknown>;
      expect(typeof e.skill).toBe('string');
      expect(e.skill).toBe(skill);
      expect(typeof e.skillMdBytes).toBe('number');
      expect(typeof e.skillMdLines).toBe('number');
      expect(typeof e.estTokens).toBe('number');
      expect(typeof e.descriptionLen).toBe('number');
      expect(e.skillMdBytes as number).toBeGreaterThan(0);
    }
  });

  test('content hash is stable (catches any byte-level edit)', () => {
    // Pinning the SHA256 of the file content is the strongest possible
    // integrity check. When the baseline file LEGITIMATELY needs to change
    // (rare — e.g. adding new skills since v1.44.1), this test fails with
    // a clear "the hash changed from X to Y; update the constant if
    // intentional" signal. The commit that updates the hash MUST also
    // explain why and update the v1.46.0.0 CHANGELOG numbers if any
    // headline changes.
    //
    // To re-capture: `shasum -a 256 test/fixtures/parity-baseline-v1.44.1.json`
    const buf = fs.readFileSync(BASELINE_PATH);
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    const EXPECTED_HASH = '29da01be6493bb2c7308b072f3066c09bdeb0397cb79ae1c708b5a38850efe46';
    if (hash !== EXPECTED_HASH) {
      throw new Error(
        `parity-baseline-v1.44.1.json content hash changed.\n` +
        `  expected: ${EXPECTED_HASH}\n` +
        `  current:  ${hash}\n` +
        `If you intentionally regenerated the baseline, update EXPECTED_HASH in ` +
        `test/parity-baseline-integrity.test.ts AND justify the change in the ` +
        `commit message AND update the v1.46.0.0 CHANGELOG numbers table.\n` +
        `If you didn't intend to regenerate it, restore the file from git history.`,
      );
    }
  });
});
