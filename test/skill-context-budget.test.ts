import { describe, expect, test } from 'bun:test';
import * as path from 'path';
import {
  collectSkillContextBudget,
  evaluateSkillContextBudget,
  parseSkillFrontmatter,
  SKILL_CONTEXT_BUDGETS,
} from '../scripts/skill-context-budget';

const ROOT = path.resolve(import.meta.dir, '..');

describe('skill context budget', () => {
  test('collects visible skill execution and discovery metrics', () => {
    const report = collectSkillContextBudget(ROOT);

    expect(report.visibleSkills.length).toBeGreaterThanOrEqual(40);
    expect(report.totals.visibleBytes).toBeGreaterThan(1_000_000);
    expect(report.totals.visibleApproxTokens).toBeGreaterThan(200_000);
    expect(report.totals.visibleDescriptionChars).toBeGreaterThan(1_000);
    expect(report.eagerCatalog.chars).toBeGreaterThan(report.totals.visibleDescriptionChars);
    expect(report.eagerCatalog.lines.length).toBe(report.visibleSkills.length);
    expect(report.totals.visibleDescriptionChars).toBeLessThanOrEqual(8_500);
    expect(report.eagerCatalog.chars).toBeLessThanOrEqual(11_000);
  });

  test('current generated skills stay below the hard execution ceiling', () => {
    const report = collectSkillContextBudget(ROOT);
    const evaluation = evaluateSkillContextBudget(report);

    const hardErrors = evaluation.errors.filter(error => error.code === 'skill-hard-ceiling');
    expect(hardErrors).toEqual([]);
    for (const skill of report.visibleSkills) {
      expect(skill.bytes).toBeLessThanOrEqual(SKILL_CONTEXT_BUDGETS.skillHardBytes);
    }
  });

  test('check mode has no hard errors in the current checkout', () => {
    const report = collectSkillContextBudget(ROOT);
    const evaluation = evaluateSkillContextBudget(report);

    expect(evaluation.errors).toEqual([]);
    expect(evaluation.warnings.length).toBeGreaterThan(0);
  });

  test('frontmatter parser handles inline and block descriptions', () => {
    const inline = parseSkillFrontmatter(
      `---\nname: demo\ndescription: Small demo skill.\npreamble-tier: 2\n---\n# Demo\n`,
      'inline/SKILL.md',
    );
    expect(inline.name).toBe('demo');
    expect(inline.description).toBe('Small demo skill.');
    expect(inline.preambleTier).toBe(2);

    const block = parseSkillFrontmatter(
      `---\nname: demo\ndescription: |\n  First line.\n  Second line.\n---\n# Demo\n`,
      'block/SKILL.md',
    );
    expect(block.description).toBe('First line.\nSecond line.');
  });
});
