/**
 * Test-Promise Audit resolver assertions (#1070).
 *
 * The Plan Completion Audit subagent has to surface TEST-category items
 * that were promised but didn't land. The resolver injects per-language
 * test-file pattern guidance and expands the JSON output contract with
 * `tests_promised`, `tests_landed`, `tests_missing` fields.
 *
 * Pin the format contract here so a future edit to the resolver can't
 * silently drop the test-promise audit instruction.
 */
import { describe, test, expect } from 'bun:test';
import type { TemplateContext } from '../scripts/resolvers/types';
import { HOST_PATHS } from '../scripts/resolvers/types';
import {
  generatePlanCompletionAuditShip,
  generatePlanCompletionAuditReview,
} from '../scripts/resolvers/review';

function makeCtx(skillName: string): TemplateContext {
  return {
    skillName,
    tmplPath: 'test.tmpl',
    host: 'claude',
    paths: HOST_PATHS.claude,
    preambleTier: 4,
  };
}

describe('Plan Completion Audit — Test-Promise section (#1070)', () => {
  test('ship variant includes the Test-Promise Audit instruction', () => {
    const out = generatePlanCompletionAuditShip(makeCtx('ship'));
    expect(out).toContain('Test-Promise Audit');
    // Per-language test patterns must be enumerated so the subagent can
    // grep deterministically across stacks instead of guessing.
    expect(out).toContain('*.test.ts');
    expect(out).toContain('test_*.py');
    expect(out).toContain('*_test.go');
    expect(out).toContain('*_spec.rb');
    // Counters that the parent template parses out of the JSON.
    expect(out).toContain('tests_promised');
    expect(out).toContain('tests_landed');
    expect(out).toContain('tests_missing');
  });

  test('review variant also includes Test-Promise Audit', () => {
    // Review-mode runs without /ship's gating but the subagent should still
    // surface the gap — review's whole job is to call out delivery integrity.
    const out = generatePlanCompletionAuditReview(makeCtx('review'));
    expect(out).toContain('Test-Promise Audit');
    expect(out).toContain('tests_promised');
  });

  test('audit body still has the Item Extraction step that produces TEST items', () => {
    // The Test-Promise Audit only works because Item Extraction tags items
    // by category. Pin the contract: TEST must remain one of the categories.
    const out = generatePlanCompletionAuditShip(makeCtx('ship'));
    expect(out).toContain('CODE | TEST | MIGRATION | CONFIG | DOCS');
  });

  test('Cross-Reference step still classifies DONE/PARTIAL/NOT DONE/CHANGED', () => {
    // The Test-Promise Audit's `landed`/`missing` classification piggybacks
    // on the existing diff cross-reference. If the existing classes
    // disappear, the test-promise output goes with them.
    const out = generatePlanCompletionAuditShip(makeCtx('ship'));
    expect(out).toContain('DONE');
    expect(out).toContain('NOT DONE');
    expect(out).toContain('PARTIAL');
  });
});
