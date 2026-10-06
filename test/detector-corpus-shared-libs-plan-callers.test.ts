/** Replays every stored shared-libs-plan-callers census question through the real fixture actor. */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createSharedPlanReuseSelector } from './helpers/shared-libs-plan-actor';

const CASE = 'shared-libs-plan-callers';
const DIR = path.join(import.meta.dir, 'fixtures', 'detector-corpora', CASE);
const inventory: any[] = JSON.parse(fs.readFileSync(path.join(DIR, 'inventory.json'), 'utf8'));
const entries = fs.readdirSync(DIR).filter(file => file !== 'inventory.json' && file.endsWith('.json')).sort()
  .map(file => ({ file, size: fs.statSync(path.join(DIR, file)).size, entry: JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8')) }));

describe(`${CASE} replay corpus`, () => {
  test('corpus holds census passes and refusals, each pinned to its source and size-capped', () => {
    expect(entries.some(({ entry }) => entry.expected === 'pass')).toBe(true);
    expect(entries.some(({ entry }) => entry.expected === 'refuse')).toBe(true);
    for (const { file, size, entry } of entries) {
      expect(size).toBeLessThanOrEqual(64 * 1024);
      expect(entry.schema).toBe('gstack-detector-corpus/v1');
      expect(entry.case).toBe(CASE);
      expect(entry.detector).toBe('test/helpers/shared-libs-plan-actor.ts#createSharedPlanReuseSelector');
      expect(entry.source.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(['passed', 'failed']).toContain(entry.census_outcome);
      expect(entry.justification.length).toBeGreaterThan(0);
      expect(file.startsWith(`${entry.source.run}-t`)).toBe(true);
      expect(JSON.stringify(entry.input)).not.toMatch(/\/home\/runner|\/Users\//);
    }
  });

  test('inventory names an existing entry for every available run', () => {
    const files = new Set(entries.map(({ file }) => file));
    for (const row of inventory) {
      if (row.available && row.entry) expect(files.has(row.entry)).toBe(true);
      if (!row.entry) expect(row.reason).toBeTruthy();
    }
  });

  // CI's eval image (git 2.43) recorded every census entry on gstack-safe-git's
  // unsupported-Git fallback; a git >= 2.44 image reads history and HEAD.
  test('each entry names its git path, and both the fallback and supported shapes are covered', () => {
    for (const { file, entry } of entries) {
      expect(['fallback', 'supported'], file).toContain(entry.git_path);
      expect(entry.git_path_evidence.trim().length, file).toBeGreaterThan(20);
    }
    for (const shape of ['fallback', 'supported']) {
      expect(entries.some(({ entry }) => entry.git_path === shape && entry.expected === 'pass'), shape).toBe(true);
      expect(entries.some(({ entry }) => entry.git_path === shape && entry.expected === 'refuse'), shape).toBe(true);
    }
  });

  test('the actor reads no git-path-specific text', () => {
    const source = fs.readFileSync(path.join(import.meta.dir, 'helpers', 'shared-libs-plan-actor.ts'), 'utf8');
    expect(source).not.toMatch(/local history|history unavailable|HEAD unknown|unsupported[- ]Git|no-lazy-fetch|safe-git/i);
    const pass = entries.find(({ file }) => file === '37193478719-t1-supported-git-pass.json')!.entry;
    const source37193478719 = entries.find(({ file }) => file === '37193478719-t1-pass.json')!.entry;
    expect(pass.expected_answer).toBe(source37193478719.expected_answer);
  });

  test.each(entries.map(({ file, entry }) => [file, entry] as const))('%s', (_file, entry) => {
    const choose = createSharedPlanReuseSelector();
    if (entry.expected === 'refuse') {
      expect(() => choose(entry.input)).toThrow(`${CASE} actor: `);
      return;
    }
    expect(choose(entry.input)).toEqual({ [entry.input.questions[0].question]: entry.expected_answer });
  });
});
