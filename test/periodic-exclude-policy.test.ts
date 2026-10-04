/**
 * The periodic exclude list is a set of DECISIONS, not a place tests go to
 * die: every entry names a real file (a deleted/renamed file must drop its
 * entry) and carries a non-empty reason + tracking pointer (the re-entry
 * condition lives there). The runner surfaces each exclusion per run, and
 * removing an entry re-activates the file on the next weekly lane.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { CASE_CI_EXCLUDE, CASE_QUARANTINE, EVAL_POLICY, PERIODIC_CI_EXCLUDE } from './helpers/periodic-exclude-data';
import { E2E_TOUCHFILES } from './helpers/touchfiles';
import { quarantinePolicyProblems } from '../scripts/eval-flake-rank';
import { isPaidTestFile } from './helpers/paid-test-set';
import { buildRunManifest, CASE_SHARDED_FILES, expandCaseShards, fileCaseRegistration, partitionCaseExclusions, selectPaidTestFiles, shardCaseId, shardFile } from '../scripts/test-paid-shards';

const ROOT = path.resolve(__dirname, '..');

describe('periodic exclude policy', () => {
  test('every entry names a real paid file and carries reason + tracking', () => {
    const entries = Object.entries(PERIODIC_CI_EXCLUDE);
    expect(entries.length).toBeGreaterThan(0);
    for (const [file, meta] of entries) {
      expect(fs.existsSync(path.join(ROOT, file)), `stale exclude entry: ${file}`).toBe(true);
      expect(isPaidTestFile(file), `${file} is not a paid file — exclusion is meaningless`).toBe(true);
      expect(meta.reason.length, `${file}: empty reason`).toBeGreaterThan(20);
      expect(meta.tracking.length, `${file}: empty tracking pointer`).toBeGreaterThan(5);
    }
  });

  test('exclusions apply to the periodic tier only, with the reason surfaced', () => {
    const files = Object.keys(PERIODIC_CI_EXCLUDE);
    const periodic = selectPaidTestFiles(files, 'periodic');
    expect(periodic.selected).toEqual([]);
    for (const { reason } of periodic.excluded) {
      expect(reason).toStartWith('excluded: ');
      expect(reason).toContain('[');
    }
    // Gate tier ignores the list (these files are periodic-tier anyway; the
    // list must never leak into gate semantics).
    const gate = selectPaidTestFiles(files, 'gate');
    for (const { reason } of gate.excluded) {
      expect(reason).not.toStartWith('excluded: ');
    }
  });

  test('case exclusions name a registered case of a case-sharded file and carry reason + tracking', () => {
    const entries = Object.entries(CASE_CI_EXCLUDE);
    expect(entries.length).toBeGreaterThan(0);
    for (const [key, meta] of entries) {
      const file = shardFile(key), id = shardCaseId(key);
      expect(CASE_SHARDED_FILES, `${key}: not a case-sharded file`).toContain(file);
      expect(id !== null && E2E_TOUCHFILES[id]?.includes(file), `${key}: not a registered case of ${file}`).toBe(true);
      expect(meta.reason.length, `${key}: empty reason`).toBeGreaterThan(20);
      expect(meta.tracking.length, `${key}: empty tracking pointer`).toBeGreaterThan(5);
    }
  });

  test('an excluded case is an excluded manifest entry with its reason, never a planned empty case shard', () => {
    for (const [key] of Object.entries(CASE_CI_EXCLUDE)) {
      const tiers = (['gate', 'periodic', 'marathon'] as const).filter(tier => expandCaseShards([shardFile(key)], tier).includes(key));
      expect(tiers.length, `${key} belongs to no tier`).toBeGreaterThan(0);
      for (const tier of tiers) {
        const { runnable, excluded } = partitionCaseExclusions(expandCaseShards([shardFile(key)], tier));
        expect(runnable).not.toContain(key);
        expect(excluded.find(entry => entry.file === key)?.reason).toStartWith('excluded: ');
        const manifest = buildRunManifest({ tier, sliceBudgetMs: 540_000, jobs: 2, evalsAll: true, env: { EVALS_ALL: '1' } });
        const entry = manifest.entries.find(entry => entry.file === key)!;
        expect(entry).toMatchObject({ status: 'excluded', slice: 0 });
        expect(entry.reason).toContain(CASE_CI_EXCLUDE[key]!.tracking);
      }
    }
  });
});

describe('eval verdict policy (pre-registered)', () => {
  test('EVAL_POLICY carries exactly the approved constants; a change needs re-approval and a version bump', () => {
    // v2: approved 2026-10-04 (D1, docs/test-audit-2026-10.md); only identity and history changed.
    expect(EVAL_POLICY).toEqual({
      version: 2,
      panel: { n: 3, k: 2 },
      quarantine: { entry: { rate: 0.95, minTrials: 10 }, exit: { rate: 0.97, minTrials: 10 }, capFraction: 0.10, expiryWeeklyRuns: 8 },
      judge: { samples: 3 },
      drift: { fisherAlpha: 0.05, fisherMinPerSide: 6 },
      infraRedispatch: 1,
    });
  });

  test('every CASE_QUARANTINE entry is a diagnosed, dated, non-product blocking case within the tier cap', () => {
    expect(quarantinePolicyProblems(CASE_QUARANTINE).map(problem => problem.message)).toEqual([]);
  });

  test('a quarantined case runs as isolated trial shards: its files register it literally', () => {
    for (const id of Object.keys(CASE_QUARANTINE)) {
      const files = (E2E_TOUCHFILES[id] ?? []).filter(file => /^test\/[^/]+\.test\.ts$/.test(file) && isPaidTestFile(file));
      expect(files.length, `${id}: no paid file registers it`).toBeGreaterThan(0);
      for (const file of files) {
        expect(fileCaseRegistration(file, fs.readFileSync(path.join(ROOT, file), 'utf8')).known, `${id}: ${file} registration must be statically known`).toBe(true);
      }
    }
  });
});
