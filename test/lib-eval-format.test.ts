/**
 * Tests for lib/eval-format.ts — standard eval result validation and normalization.
 */

import { describe, test, expect } from 'bun:test';
import {
  validateEvalResult,
  normalizeFromLegacy,
  normalizeToLegacy,
} from '../lib/eval-format';
import type { StandardEvalResult } from '../lib/eval-format';
import type { EvalResult } from '../test/helpers/eval-store';

function makeValidStandard(): StandardEvalResult {
  return {
    schema_version: 1,
    version: '0.3.3',
    git_branch: 'main',
    git_sha: 'abc1234',
    timestamp: '2025-05-01T12:00:00Z',
    hostname: 'test-host',
    tier: 'e2e',
    total: 2,
    passed: 1,
    failed: 1,
    total_cost_usd: 1.50,
    duration_seconds: 120,
    all_results: [
      { name: 'test-a', suite: 'core', tier: 'e2e', passed: true, duration_ms: 60000, cost_usd: 0.75 },
      { name: 'test-b', suite: 'core', tier: 'e2e', passed: false, duration_ms: 60000, cost_usd: 0.75 },
    ],
  };
}

function makeLegacy(): EvalResult {
  return {
    schema_version: 1,
    version: '0.3.3',
    branch: 'main',
    git_sha: 'abc1234',
    timestamp: '2025-05-01T12:00:00Z',
    hostname: 'test-host',
    tier: 'e2e',
    total_tests: 2,
    passed: 1,
    failed: 1,
    total_cost_usd: 1.50,
    total_duration_ms: 120000,
    tests: [
      { name: 'test-a', suite: 'core', tier: 'e2e', passed: true, duration_ms: 60000, cost_usd: 0.75, turns_used: 5 },
      { name: 'test-b', suite: 'core', tier: 'e2e', passed: false, duration_ms: 60000, cost_usd: 0.75, detection_rate: 3 },
    ],
  };
}

describe('lib/eval-format', () => {
  describe('validateEvalResult', () => {
    test('accepts valid standard result', () => {
      const result = validateEvalResult(makeValidStandard());
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    test('rejects null', () => {
      const result = validateEvalResult(null);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('non-null object');
    });

    test('rejects non-object', () => {
      const result = validateEvalResult('not an object');
      expect(result.valid).toBe(false);
    });

    test('reports missing required fields', () => {
      const result = validateEvalResult({});
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(5);
      expect(result.errors.some(e => e.includes('schema_version'))).toBe(true);
      expect(result.errors.some(e => e.includes('git_branch'))).toBe(true);
    });

    test('reports wrong types', () => {
      const bad = { ...makeValidStandard(), schema_version: 'not a number' };
      const result = validateEvalResult(bad);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('schema_version') && e.includes('number'))).toBe(true);
    });

    test('rejects non-array all_results', () => {
      const bad = { ...makeValidStandard(), all_results: 'not an array' };
      const result = validateEvalResult(bad);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('all_results') && e.includes('array'))).toBe(true);
    });

    test('validates test entry names', () => {
      const bad = { ...makeValidStandard(), all_results: [{ passed: true }] };
      const result = validateEvalResult(bad);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('name'))).toBe(true);
    });

    test('validates test entry passed field', () => {
      const bad = { ...makeValidStandard(), all_results: [{ name: 'test', passed: 'yes' }] };
      const result = validateEvalResult(bad);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('passed') && e.includes('boolean'))).toBe(true);
    });
  });

  describe('normalizeFromLegacy', () => {
    test('maps all fields correctly', () => {
      const standard = normalizeFromLegacy(makeLegacy());
      expect(standard.git_branch).toBe('main');
      expect(standard.total).toBe(2);
      expect(standard.duration_seconds).toBe(120);
      expect(standard.all_results.length).toBe(2);
      expect(standard.all_results[0].turns_used).toBe(5);
      expect(standard.all_results[1].detection_rate).toBe(3);
    });

    test('preserves optional fields when present', () => {
      const legacy = makeLegacy();
      legacy._partial = true;
      const standard = normalizeFromLegacy(legacy);
      expect(standard._partial).toBe(true);
    });

    test('omits optional fields when absent', () => {
      const standard = normalizeFromLegacy(makeLegacy());
      expect(standard.all_results[0].detection_rate).toBeUndefined();
      expect(standard.all_results[1].turns_used).toBeUndefined();
    });
  });

  describe('normalizeToLegacy', () => {
    test('maps all fields correctly', () => {
      const legacy = normalizeToLegacy(makeValidStandard());
      expect(legacy.branch).toBe('main');
      expect(legacy.total_tests).toBe(2);
      expect(legacy.total_duration_ms).toBe(120000);
      expect(legacy.tests.length).toBe(2);
    });

    test('round-trip preserves data', () => {
      const original = makeLegacy();
      const roundTrip = normalizeToLegacy(normalizeFromLegacy(original));
      expect(roundTrip.branch).toBe(original.branch);
      expect(roundTrip.total_tests).toBe(original.total_tests);
      expect(roundTrip.passed).toBe(original.passed);
      expect(roundTrip.failed).toBe(original.failed);
      expect(roundTrip.total_cost_usd).toBe(original.total_cost_usd);
      expect(roundTrip.tests.length).toBe(original.tests.length);
      expect(roundTrip.tests[0].name).toBe(original.tests[0].name);
      expect(roundTrip.tests[0].turns_used).toBe(original.tests[0].turns_used);
    });
  });
});
