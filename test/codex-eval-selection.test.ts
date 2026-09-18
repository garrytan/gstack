import { describe, expect, test } from 'bun:test';
import { E2E_TIERS, E2E_TOUCHFILES, GLOBAL_TOUCHFILES, selectTests } from './helpers/touchfiles';

function selectedBy(file: string) {
  return selectTests([file], E2E_TOUCHFILES, GLOBAL_TOUCHFILES).selected;
}

describe('Codex eval selection', () => {
  test('recording-helper changes select every recorded Codex case in the periodic tier', () => {
    const selected = selectedBy('test/helpers/codex-eval.ts');
    expect(selected.sort()).toEqual([
      'codex-discover-skill',
      'codex-review-findings',
      'codex-plan-ceo-format-mode',
      'codex-plan-ceo-format-approach',
      'codex-plan-eng-format-coverage',
      'codex-plan-eng-format-kind',
      'codex-sol-scope-termination',
    ].sort());
    expect(selected.every((id) => E2E_TIERS[id] === 'periodic')).toBe(true);
  });

  test('format cases are selected by canonical source and their own test file', () => {
    expect(selectedBy('plan-ceo-review/SKILL.md.tmpl')).toContain('codex-plan-ceo-format-mode');
    expect(selectedBy('plan-ceo-review/SKILL.md.tmpl')).toContain('codex-plan-ceo-format-approach');
    expect(selectedBy('plan-eng-review/SKILL.md.tmpl')).toContain('codex-plan-eng-format-coverage');
    expect(selectedBy('plan-eng-review/SKILL.md.tmpl')).toContain('codex-plan-eng-format-kind');
    expect(selectedBy('test/codex-e2e-plan-format.test.ts').length).toBe(4);
  });

  test('Sol fixture generation changes select its periodic case', () => {
    for (const file of ['test/helpers/sol-skill-fixture.ts', 'test/sol-skill-fixture.test.ts']) {
      expect(selectedBy(file)).toEqual(['codex-sol-scope-termination']);
    }
    expect(E2E_TIERS['codex-sol-scope-termination']).toBe('periodic');
  });

});
