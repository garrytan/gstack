/**
 * B1 replay corpora contract. Each case directory under
 * test/fixtures/detector-corpora/ holds minimal, redacted detector or actor
 * inputs from named census captures, an inventory of every census in scope
 * (expired artifacts listed as unavailable), and a replay test
 * (test/detector-corpus-<case>.test.ts) that runs the real detector.
 * Stale entries (series identity no longer current) are reported for refresh,
 * never deleted: a fixed false red stays an expected pass with its history.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { scan } from '../lib/redact-engine';
import { caseSeriesIdentitiesV2, treeEntries } from '../scripts/eval-trial-series';

const ROOT = path.resolve(import.meta.dir, '..');
const DIR = path.join(import.meta.dir, 'fixtures', 'detector-corpora');
const REQUIRED = ['shared-libs-plan-callers', 'plan-ceo-section-loading', 'auto-decide-preserved',
  'plan-design-review-plan-mode', 'ship-docsync-late-result'];
const MAX_BYTES = 64 * 1024;
const cases = fs.readdirSync(DIR).filter(name => fs.statSync(path.join(DIR, name)).isDirectory()).sort();
const entries = (c: string) => fs.readdirSync(path.join(DIR, c)).filter(f => f.endsWith('.json') && f !== 'inventory.json').sort()
  .map(file => ({ file, bytes: fs.statSync(path.join(DIR, c, file)).size, raw: fs.readFileSync(path.join(DIR, c, file), 'utf8') }))
  .map(entry => ({ ...entry, json: JSON.parse(entry.raw) }));

test('every required repeat-offender case has a corpus', () => {
  expect(cases).toEqual(expect.arrayContaining(REQUIRED));
});

describe.each(cases)('%s corpus', (c) => {
  const all = entries(c);
  test('has a replay test, at least one expected pass and one expected refusal', () => {
    expect(fs.existsSync(path.join(import.meta.dir, `detector-corpus-${c}.test.ts`))).toBe(true);
    expect(all.some(entry => entry.json.expected === 'pass')).toBe(true);
    expect(all.some(entry => entry.json.expected === 'refuse')).toBe(true);
  });
  test.each(all.map(entry => [entry.file, entry] as const))('%s is a bounded, attributed, credential-free entry', (_file, entry) => {
    const e = entry.json;
    expect(entry.bytes).toBeLessThanOrEqual(MAX_BYTES);
    expect(e).toMatchObject({ schema: 'gstack-detector-corpus/v1', case: c });
    expect(e.detector).toMatch(/^test\/[\w./-]+\.ts#\S+/);
    expect(e.series_identity).toMatch(/^[0-9a-f]{16}$/);
    expect(e.source.run).toMatch(/^\d{8,}$/);
    expect(e.source.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(['periodic', 'gate', 'pr']).toContain(e.source.lane);
    expect(['passed', 'failed']).toContain(e.census_outcome);
    expect(['pass', 'refuse']).toContain(e.expected);
    expect(e.justification.trim().length).toBeGreaterThan(10);
    expect(e.input).toBeDefined();
    // A refusal that no census produced must say how it was derived.
    if (e.expected === 'refuse' && e.census_outcome === 'passed') expect(typeof e.derived).toBe('string');
    const scanned = scan(entry.raw, { repoVisibility: 'private' });
    expect(scanned.oversize).toBe(false);
    expect(scanned.findings.filter(f => f.severity === 'HIGH').map(f => f.id)).toEqual([]);
  });
  test('the inventory lists every census in scope and only existing entries', () => {
    const inventory = JSON.parse(fs.readFileSync(path.join(DIR, c, 'inventory.json'), 'utf8')) as Array<Record<string, unknown>>;
    expect(inventory.length).toBeGreaterThan(0);
    const files = new Set(all.map(entry => entry.file));
    for (const row of inventory) {
      expect(String(row.run)).toMatch(/^\d{8,}$/);
      expect(typeof row.available).toBe('boolean');
      if (row.entry !== null && row.entry !== undefined) expect(files.has(String(row.entry))).toBe(true);
    }
    for (const entry of all.filter(entry => !entry.json.derived)) {
      expect(inventory.some(row => String(row.run) === entry.json.source.run)).toBe(true);
    }
  });
});

test('stale corpus entries are reported for refresh', () => {
  const current = caseSeriesIdentitiesV2(cases, treeEntries(ROOT));
  const stale = cases.flatMap(c => entries(c).filter(entry => entry.json.series_identity !== current[c]!.identity)
    .map(entry => `${c}/${entry.file} (series ${entry.json.series_identity}, current ${current[c]!.identity})`));
  if (stale.length) console.log(`[detector-corpora] ${stale.length} stale entr${stale.length === 1 ? 'y' : 'ies'} (refresh from a current census when one fails):\n  ${stale.join('\n  ')}`);
  expect(Object.keys(current).sort()).toEqual(cases);
});
