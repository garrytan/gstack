import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { hasApprovedStaleFillDecision } from './helpers/ceo-stale-fill-decision';
import { CEO_SECTION_CACHE_PLAN, hasStaleFillRaceFinding } from './helpers/ceo-section-loading-fixture';

const CASE = 'plan-ceo-section-loading';
const dir = path.join(import.meta.dir, 'fixtures', 'detector-corpora', CASE);
const WITNESS = 'expect(hasApprovedStaleFillDecision(output) || hasStaleFillRaceFinding(output)).toBe(true);';

type Entry = {
  schema: string;
  case: string;
  detector: string;
  series_identity: string;
  source: { run: string; sha: string; lane: string; artifact: string; path: string };
  census_outcome: 'passed' | 'failed';
  census_error: string;
  derived?: string;
  expected: 'pass' | 'refuse';
  justification: string;
  input: { report: string };
};
type InventoryRow = { run: string; lane: string; outcome: string; series_identity: string; artifact: string; available: boolean; entry: string | null; reason?: string };

const inventory: InventoryRow[] = JSON.parse(fs.readFileSync(path.join(dir, 'inventory.json'), 'utf8'));
const files = fs.readdirSync(dir).filter(name => name !== 'inventory.json').sort();
const entries = files.map(name => [name, JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as Entry] as const);

describe(`${CASE} detector corpus`, () => {
  test('the corpus replays the exact stale-fill witness the E2E asserts', () => {
    const e2e = fs.readFileSync(path.join(import.meta.dir, 'skill-e2e-plan-ceo-review-section-loading.test.ts'), 'utf8');
    expect(e2e).toContain(WITNESS);
  });

  test('inventory and entry files agree, and each entry is well formed', () => {
    expect(inventory.filter(row => row.entry).map(row => row.entry).sort()).toEqual([...files]);
    for (const row of inventory) if (!row.entry) expect(row.reason, row.run).toBeTruthy();
    for (const [name, entry] of entries) {
      expect(fs.statSync(path.join(dir, name)).size, name).toBeLessThanOrEqual(64 * 1024);
      expect(entry.schema, name).toBe('gstack-detector-corpus/v1');
      expect(entry.case, name).toBe(CASE);
      expect(entry.source.sha, name).toMatch(/^[0-9a-f]{40}$/);
      expect(name.startsWith(`${entry.source.run}-t`), name).toBe(true);
      const row = inventory.find(r => r.entry === name)!;
      expect({ outcome: row.outcome, series: row.series_identity }, name).toEqual({ outcome: entry.census_outcome, series: entry.series_identity });
      expect(entry.justification.trim().length, name).toBeGreaterThan(0);
      expect(entry.input.report, name).not.toMatch(/\/home\/runner|gstack-ceo-secload-/);
    }
  });

  test('holds at least one expected pass and one expected refusal', () => {
    const expected = entries.map(([, entry]) => entry.expected);
    expect(expected).toContain('pass');
    expect(expected).toContain('refuse');
  });

  test.each(entries)('%s replays to its expected result', (_name, entry) => {
    const report = entry.input.report;
    expect(hasApprovedStaleFillDecision(report) || hasStaleFillRaceFinding(report)).toBe(entry.expected === 'pass');
  });

  test('the copied fixture plan is not evidence', () => {
    expect(hasApprovedStaleFillDecision(CEO_SECTION_CACHE_PLAN) || hasStaleFillRaceFinding(CEO_SECTION_CACHE_PLAN)).toBe(false);
  });
});
