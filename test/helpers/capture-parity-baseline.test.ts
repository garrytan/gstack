/**
 * Unit tests for parity baseline capture.
 *
 * Free. Reads the live repo state via captureBaseline() and asserts
 * shape + invariants, not specific numbers (which drift release-over-release).
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { captureBaseline, diffBaselines, type ParityBaseline } from './capture-parity-baseline';

const REPO_ROOT = path.resolve(import.meta.dir, '..', '..');

describe('capture-parity-baseline', () => {
  test('produces a shaped baseline for the current repo', () => {
    const baseline = captureBaseline({ repoRoot: REPO_ROOT, tag: 'unit-test' });
    expect(baseline.tag).toBe('unit-test');
    expect(baseline.totalSkills).toBeGreaterThan(20);
    expect(baseline.totalCorpusBytes).toBeGreaterThan(100_000);
    expect(baseline.topHeaviest.length).toBeGreaterThan(0);
    expect(baseline.topHeaviest.length).toBeLessThanOrEqual(10);
    expect(baseline.topHeaviest[0]!.skillMdBytes).toBeGreaterThan(0);
    // Top 1 should be ≥ Top 2 (sort invariant)
    if (baseline.topHeaviest.length >= 2) {
      expect(baseline.topHeaviest[0]!.skillMdBytes).toBeGreaterThanOrEqual(
        baseline.topHeaviest[1]!.skillMdBytes,
      );
    }
  });

  test('each skill entry has byte + line + token estimates', () => {
    const baseline = captureBaseline({ repoRoot: REPO_ROOT });
    for (const skill of Object.values(baseline.skills)) {
      expect(skill.skillMdBytes).toBeGreaterThan(0);
      expect(skill.skillMdLines).toBeGreaterThan(0);
      expect(skill.estTokens).toBeGreaterThan(0);
      // ~4 chars/token heuristic
      expect(skill.estTokens).toBeCloseTo(skill.skillMdBytes / 4, -2);
    }
  });

  test('diffBaselines returns expected deltas', () => {
    const before: ParityBaseline = {
      tag: 'before',
      capturedAt: '2026-01-01T00:00:00Z',
      capturedFromCommit: 'abc',
      capturedFromBranch: 'main',
      totalSkills: 2,
      totalCorpusBytes: 1000,
      estTotalCatalogTokens: 100,
      topHeaviest: [],
      skills: {
        foo: { skill: 'foo', skillMdBytes: 600, skillMdLines: 10, estTokens: 150, tmplBytes: 300, descriptionLen: 50, hasGateEval: true, hasPeriodicEval: false },
        bar: { skill: 'bar', skillMdBytes: 400, skillMdLines: 8, estTokens: 100, tmplBytes: 200, descriptionLen: 30, hasGateEval: false, hasPeriodicEval: false },
      },
    };
    const after: ParityBaseline = {
      ...before,
      tag: 'after',
      totalCorpusBytes: 700,
      estTotalCatalogTokens: 60,
      skills: {
        foo: { ...before.skills.foo!, skillMdBytes: 400 },
        bar: { ...before.skills.bar!, skillMdBytes: 300 },
      },
    };
    const diff = diffBaselines(before, after);
    expect(diff.totalCorpusDelta).toBe(-300);
    expect(diff.totalCorpusDeltaPct).toBeCloseTo(-30, 1);
    expect(diff.catalogTokensDelta).toBe(-40);
    expect(diff.perSkill.length).toBe(2);
    // Sorted by abs delta descending
    expect(diff.perSkill[0]!.skill).toBe('foo');
    expect(diff.perSkill[0]!.deltaBytes).toBe(-200);
    expect(diff.perSkill[1]!.skill).toBe('bar');
  });

  test('v1.44.1 baseline file exists with expected shape', () => {
    const baselinePath = path.join(REPO_ROOT, 'test', 'fixtures', 'parity-baseline-v1.44.1.json');
    expect(fs.existsSync(baselinePath)).toBe(true);
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8')) as ParityBaseline;
    expect(baseline.tag).toBe('v1.44.1');
    expect(baseline.totalSkills).toBeGreaterThan(40);
    // Document the v1.44.1 snapshot as the v1→v2 baseline reference.
    // Compression in v1.45+ should drop totalCorpusBytes; this assertion
    // anchors the "v1 was XX MB" claim in the CHANGELOG to a real file.
    expect(baseline.totalCorpusBytes).toBeGreaterThan(2_000_000);
  });
});
