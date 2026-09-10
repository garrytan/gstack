/**
 * Parent/child selection-drift pins for EVALS_SELECTION_JSON.
 *
 * The sharded paid runner computes the diff selection ONCE in the parent
 * (computePaidDiffSelection in scripts/test-paid-shards.ts), serializes it
 * (serializePaidDiffSelection) into every shard child's env, and
 * test/helpers/e2e-helpers.ts adopts it at module load (parseEvalsSelectionJson
 * via resolveModuleSelection) instead of re-deriving it per shard — which,
 * whenever touchfiles-data.ts was in the diff, spawned one bun subprocess PER
 * CHILD to evaluate the old data file (test-selection.ts map-diff path).
 *
 * These pins hold the two sides to IDENTICAL selection decisions across the
 * serialize/parse boundary, and the child to fail-open (local recompute with
 * one stderr warning) on any parse/shape failure.
 */

import { describe, test, expect } from 'bun:test';
import {
  computePaidDiffSelection,
  serializePaidDiffSelection,
  type PaidDiffSelection,
} from '../scripts/test-paid-shards';
import { parseEvalsSelectionJson, resolveModuleSelection } from './helpers/e2e-helpers';

/** The parent's per-test decision shape (PaidDiffSelection.selectedNames). */
const parentWouldRun = (selection: PaidDiffSelection, name: string): boolean =>
  selection.selectedNames === null || selection.selectedNames.has(name);

/** The child's per-test decision shape (testIfSelected / describeIfSelected). */
const childWouldRun = (selected: string[] | null, name: string): boolean =>
  selected === null || selected.includes(name);

const NAMES = ['qa-workflow', 'review-army', 'ship-docsync', 'unmapped-test'];

describe('EVALS_SELECTION_JSON parent -> child propagation', () => {
  test('a concrete selection round-trips to identical decisions', () => {
    const fixture: PaidDiffSelection = {
      selectedNames: new Set(['qa-workflow', 'ship-docsync']),
      reason: 'diff',
      totalTests: 4,
    };
    const parsed = parseEvalsSelectionJson(serializePaidDiffSelection(fixture));
    expect(parsed.selected).toEqual(['qa-workflow', 'ship-docsync']);
    expect(parsed.reason).toBe('diff');
    for (const name of NAMES) {
      expect(childWouldRun(parsed.selected, name), name).toBe(parentWouldRun(fixture, name));
    }
  });

  test('run-all (null) round-trips to null — child runs everything', () => {
    // computePaidDiffSelection is the REAL parent function; EVALS_ALL is its
    // git-free path, so the serializer sees input exactly as produced.
    const selection = computePaidDiffSelection({ EVALS_ALL: '1' } as NodeJS.ProcessEnv);
    expect(selection.selectedNames).toBeNull();
    const parsed = parseEvalsSelectionJson(serializePaidDiffSelection(selection));
    expect(parsed.selected).toBeNull();
    for (const name of NAMES) {
      expect(childWouldRun(parsed.selected, name)).toBe(parentWouldRun(selection, name));
    }
  });

  test('empty selection stays empty — nothing selected is NOT run-all', () => {
    const fixture: PaidDiffSelection = { selectedNames: new Set(), reason: 'diff', totalTests: 4 };
    const parsed = parseEvalsSelectionJson(serializePaidDiffSelection(fixture));
    expect(parsed.selected).toEqual([]);
    for (const name of NAMES) {
      expect(childWouldRun(parsed.selected, name)).toBe(false);
      expect(parentWouldRun(fixture, name)).toBe(false);
    }
  });

  test('parser THROWS on malformed JSON and wrong shapes', () => {
    expect(() => parseEvalsSelectionJson('{"selected": ')).toThrow();
    expect(() => parseEvalsSelectionJson('null')).toThrow();
    expect(() => parseEvalsSelectionJson('[1,2]')).toThrow();
    expect(() => parseEvalsSelectionJson('{"selected": 42}')).toThrow();
    expect(() => parseEvalsSelectionJson('{"selected": ["a", 7]}')).toThrow();
  });

  test('malformed EVALS_SELECTION_JSON falls back to local compute with one stderr warning', () => {
    const warnings: string[] = [];
    let computed = 0;
    const result = resolveModuleSelection(
      '{"selected": 42}',
      () => { computed += 1; return ['locally-computed']; },
      (text) => warnings.push(text),
    );
    expect(result).toEqual(['locally-computed']); // fail-open preserved
    expect(computed).toBe(1);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('EVALS_SELECTION_JSON');
  });

  test('absent env var computes locally, silently (non-sharded entrypoints unchanged)', () => {
    const writes: string[] = [];
    let computed = 0;
    const result = resolveModuleSelection(
      undefined,
      () => { computed += 1; return null; },
      (text) => writes.push(text),
    );
    expect(result).toBeNull();
    expect(computed).toBe(1);
    expect(writes.length).toBe(0);
  });

  test('a valid env var short-circuits local derivation entirely', () => {
    let computed = 0;
    const result = resolveModuleSelection(
      serializePaidDiffSelection({ selectedNames: new Set(['a']), reason: 'diff', totalTests: 1 }),
      () => { computed += 1; return null; },
      () => {},
    );
    expect(result).toEqual(['a']);
    expect(computed).toBe(0); // no git walk, no map-diff bun subprocess
  });
});
