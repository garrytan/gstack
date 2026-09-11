import { describe, expect, test } from 'bun:test';
import { E2E_TOUCHFILES, E2E_TIERS, GLOBAL_TOUCHFILES, LLM_JUDGE_TOUCHFILES } from './helpers/touchfiles-data';
import { selectTests } from './helpers/test-selection';

describe('fake impeccable engine selection', () => {
  const helper = 'test/helpers/fake-impeccable.ts';
  const consumers = [
    'design-html-slop-gate',
    'design-review-detector-shim',
    'design-review-detector-shim-dom',
    'review-design-lite',
  ];

  test('a helper-only edit selects every paid consumer without global expansion', () => {
    const result = selectTests([helper], E2E_TOUCHFILES);
    expect(result.selected.slice().sort()).toEqual(consumers);
    expect(result.reason).toBe('diff');
    expect(result.skipped).toContain('design-consultation-core');
    expect(GLOBAL_TOUCHFILES).not.toContain(helper);
    expect(selectTests([helper], LLM_JUDGE_TOUCHFILES).selected).toEqual([]);
  });

  test('the fake executable and captured output retain the same consumers and tiers', () => {
    for (const changed of ['test/fixtures/fake-impeccable.ts', 'test/fixtures/impeccable-detect-sample.json']) {
      expect(selectTests([changed], E2E_TOUCHFILES).selected.slice().sort()).toEqual(consumers);
    }
    expect(consumers.map(name => [name, E2E_TIERS[name]])).toEqual([
      ['design-html-slop-gate', 'periodic'],
      ['design-review-detector-shim', 'gate'],
      ['design-review-detector-shim-dom', 'gate'],
      ['review-design-lite', 'periodic'],
    ]);
  });
});
