import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { docsActorVerdict } from './helpers/docsync-fault-eval';
import type { DocsActorState } from './helpers/docsync-fault-actor';

const CASE = 'ship-docsync-late-result';
const DIR = path.join(import.meta.dir, 'fixtures/detector-corpora', CASE);
const ROOT = path.join(os.tmpdir(), 'docsync-late-result-corpus');
const names = fs.readdirSync(DIR).filter(name => name.endsWith('.json') && name !== 'inventory.json').sort();
const entries = names.map(name => ({ name, raw: fs.readFileSync(path.join(DIR, name), 'utf8') }))
  .map(({ name, raw }) => ({ name, size: Buffer.byteLength(raw), entry: JSON.parse(raw.replaceAll('<ROOT>', JSON.stringify(ROOT).slice(1, -1))) }));
const inventory = JSON.parse(fs.readFileSync(path.join(DIR, 'inventory.json'), 'utf8'));

describe(`${CASE} detector corpus`, () => {
  test('entries are well-formed, bounded, redacted and inventoried', () => {
    expect(entries.some(({ entry }) => entry.expected === 'pass')).toBe(true);
    expect(entries.some(({ entry }) => entry.expected === 'refuse')).toBe(true);
    for (const { name, size, entry } of entries) {
      expect(size, name).toBeLessThanOrEqual(64 * 1024);
      expect(entry.schema).toBe('gstack-detector-corpus/v1');
      expect(entry.case).toBe(CASE);
      expect(entry.detector).toBe('test/helpers/docsync-fault-eval.ts#docsActorVerdict');
      expect(entry.source.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(['passed', 'failed']).toContain(entry.census_outcome);
      expect(['pass', 'refuse']).toContain(entry.expected);
      expect(entry.justification.length).toBeGreaterThan(0);
      expect(JSON.stringify(entry), name).not.toMatch(/\/home\/runner|\/Users\/|sk-[A-Za-z0-9]{8}|ghp_[A-Za-z0-9]{8}/);
      if (entry.derived) {
        const origin = entries.find(other => !other.entry.derived && other.entry.source.run === entry.source.run);
        expect(origin?.entry.expected, `${name} derives from a capture the detector accepts`).toBe('pass');
      } else {
        expect(name).toBe(`${entry.source.run}-t1-${entry.census_outcome === 'passed' ? 'pass' : 'fail'}.json`);
        expect(inventory.find((row: { entry: string | null }) => row.entry === name)?.outcome).toBe(entry.census_outcome);
      }
    }
    for (const row of inventory.filter((row: { entry: string | null }) => row.entry)) expect(names).toContain(row.entry);
    for (const row of inventory.filter((row: { entry: string | null }) => !row.entry)) expect(row.reason).toBeTruthy();
  });

  for (const { name, entry } of entries) {
    test(`${name} → ${entry.expected}`, () => {
      const failures = docsActorVerdict(entry.input.state as DocsActorState, entry.input.report, entry.input.published);
      if (entry.expected === 'pass') expect(failures).toEqual([]);
      else expect(failures.length).toBeGreaterThan(0);
    });
  }
});
