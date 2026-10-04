/**
 * Carved-skill section loading (PERIODIC, paid): one real run per generic
 * carved skill proves the agent Reads that carve's required sections
 * (test/helpers/carve-section-case.ts). Each case is its own shard
 * (scripts/lib/paid-cases.ts CASE_SHARDED_FILES), with its own case id,
 * pass-rate history and touchfiles; test/carve-section-sharding.test.ts pins
 * that every generic CARVE_GUARDS entry has exactly one case here.
 */
import { test } from 'bun:test';
import { describeE2ETier } from './helpers/e2e-gate';
import { CAPTURE_LONG_MS } from './helpers/eval-budgets';
import { runCarveSectionCase } from './helpers/carve-section-case';

describeE2ETier('periodic')('carve section-loading', () => {
  test('carve-section-loading-browse', () => runCarveSectionCase('browse'), CAPTURE_LONG_MS);
  test('carve-section-loading-codex', () => runCarveSectionCase('codex'), CAPTURE_LONG_MS);
  test('carve-section-loading-design-consultation', () => runCarveSectionCase('design-consultation'), CAPTURE_LONG_MS);
  test('carve-section-loading-design-html', () => runCarveSectionCase('design-html'), CAPTURE_LONG_MS);
  test('carve-section-loading-design-shotgun', () => runCarveSectionCase('design-shotgun'), CAPTURE_LONG_MS);
  test('carve-section-loading-document-release', () => runCarveSectionCase('document-release'), CAPTURE_LONG_MS);
  test('carve-section-loading-land-and-deploy', () => runCarveSectionCase('land-and-deploy'), CAPTURE_LONG_MS);
  test('carve-section-loading-plan-design-review', () => runCarveSectionCase('plan-design-review'), CAPTURE_LONG_MS);
  test('carve-section-loading-plan-devex-review', () => runCarveSectionCase('plan-devex-review'), CAPTURE_LONG_MS);
  test('carve-section-loading-plan-eng-review', () => runCarveSectionCase('plan-eng-review'), CAPTURE_LONG_MS);
  test('carve-section-loading-qa', () => runCarveSectionCase('qa'), CAPTURE_LONG_MS);
  test('carve-section-loading-retro', () => runCarveSectionCase('retro'), CAPTURE_LONG_MS);
  test('carve-section-loading-review', () => runCarveSectionCase('review'), CAPTURE_LONG_MS);
  test('carve-section-loading-setup-gbrain', () => runCarveSectionCase('setup-gbrain'), CAPTURE_LONG_MS);
  test('carve-section-loading-spec', () => runCarveSectionCase('spec'), CAPTURE_LONG_MS);
});
