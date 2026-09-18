import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CARVE_GUARDS } from './helpers/carve-guards';
import { isPaidTestFile } from './helpers/paid-test-set';
import { CAPTURE_LONG_MS } from './helpers/eval-budgets';
import { buildRunManifest, DEFAULT_SHARD_TIMEOUT_MS, retriesForFiles, selectPaidTestFiles } from '../scripts/test-paid-shards';

describe('carved-skill cases each get a complete paid process budget', () => {
  const files = fs.readdirSync(import.meta.dir).filter(name => /^carve-section-loading-.*\.test\.ts$/.test(name));
  test('every generic registry entry has exactly one periodic wrapper and no external entry does', () => {
    const covered = files.flatMap(file => {
      const source = fs.readFileSync(path.join(import.meta.dir, file), 'utf8');
      expect(source).toContain("describeE2ETier('periodic')");
      const calls = [...source.matchAll(/registerCarveSectionCase\('([^']+)'\)/g)];
      expect(calls).toHaveLength(1);
      expect(isPaidTestFile('test/' + file)).toBe(true);
      return calls.map(match => match[1]);
    });
    expect(covered.sort()).toEqual(Object.values(CARVE_GUARDS).filter(guard => guard.behavioral !== 'external').map(guard => guard.skill).sort());
    expect(new Set(covered).size).toBe(covered.length);
    expect(selectPaidTestFiles(files.map(file => 'test/' + file), 'periodic').selected).toHaveLength(files.length);
    expect(selectPaidTestFiles(files.map(file => 'test/' + file), 'gate').selected).toHaveLength(0);
  });
  test('all configured retries plus teardown fit even with within-shard concurrency one', () => {
    for (const file of files) {
      const attempts = retriesForFiles(['test/' + file]) + 1;
      expect(CAPTURE_LONG_MS * attempts + 10_000).toBeLessThan(DEFAULT_SHARD_TIMEOUT_MS);
    }
  });
  test('explicit skill scope selects one process and records why the others are excluded', () => {
    const discovered = files.map(file => 'test/' + file);
    const env = { GSTACK_CARVE_SKILL: ' review ', EVALS_ALL: '1' };
    const root = path.resolve(import.meta.dir, '..');
    const result = selectPaidTestFiles(discovered, 'periodic', root, env);
    expect(result.selected).toEqual(['test/carve-section-loading-review.test.ts']);
    expect(result.excluded).toHaveLength(discovered.length - 1);
    expect(result.excluded.every(entry => entry.reason.includes('GSTACK_CARVE_SKILL=review'))).toBe(true);
    const manifest = buildRunManifest({ tier: 'periodic', sliceCount: 2, evalsAll: true, discovered, env, rootDir: root });
    expect(manifest.entries.filter(entry => entry.status === 'planned').map(entry => entry.file)).toEqual(result.selected);
    expect(manifest.entries.filter(entry => entry.status === 'excluded')).toHaveLength(result.excluded.length);
    expect(() => selectPaidTestFiles(discovered, 'periodic', root, { GSTACK_CARVE_SKILL: 'typo' })).toThrow('no generic section-loading wrapper');
  });
});
