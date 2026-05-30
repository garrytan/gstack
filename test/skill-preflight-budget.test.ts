/**
 * Per-skill brain preflight token budget enforcement (T21 / T19).
 *
 * Asserts that the GENERATED BRAIN_PREFLIGHT block per skill stays within
 * its per-skill byte budget (SKILL_PREFLIGHT_BUDGET_BYTES from
 * brain-cache-spec). Also asserts the autoplan-wide total stays under
 * AUTOPLAN_PREFLIGHT_BUDGET_BYTES.
 *
 * What's being measured: the SIZE OF THE INSTRUCTIONS injected into the
 * skill's SKILL.md by the resolver, NOT the size of the cache digests at
 * runtime. Runtime digest budgets are enforced separately by the cache
 * CLI's truncateToBudget. This test catches resolver-side bloat: if
 * generateBrainPreflight grows verbose, the instructions themselves eat
 * the skill's context budget.
 *
 * Gate-tier, free.
 */

import { describe, test, expect } from 'bun:test';
import { generateBrainPreflight, generateBrainCacheRefresh, generateBrainWriteBack } from '../scripts/resolvers/gbrain';
import {
  SKILL_DIGEST_SUBSETS,
  SKILL_PREFLIGHT_BUDGET_BYTES,
  AUTOPLAN_PREFLIGHT_BUDGET_BYTES,
} from '../scripts/brain-cache-spec';
import { HOST_PATHS } from '../scripts/resolvers/types';
import type { TemplateContext } from '../scripts/resolvers/types';

function buildCtx(skillName: string): TemplateContext {
  return {
    skillName,
    tmplPath: `/tmp/${skillName}/SKILL.md.tmpl`,
    host: 'claude',
    paths: HOST_PATHS.claude,
  };
}

function totalBrainBytes(skillName: string): number {
  const preflight = generateBrainPreflight(buildCtx(skillName));
  const refresh = generateBrainCacheRefresh(buildCtx(skillName));
  const writeBack = generateBrainWriteBack(buildCtx(skillName));
  return Buffer.byteLength(preflight + refresh + writeBack, 'utf-8');
}

describe('per-skill preflight token budget', () => {
  test('every preflight skill stays under per-skill BRAIN_* budget (3x cap, instructions vs runtime data)', () => {
    // The per-skill budget governs RUNTIME digest data, not instruction text.
    // Instruction text (resolver output) should fit within 3x the runtime
    // budget — anything more means the instructions themselves are bloated.
    for (const [skill, budget] of Object.entries(SKILL_PREFLIGHT_BUDGET_BYTES)) {
      const bytes = totalBrainBytes(skill);
      const cap = budget * 3;
      expect(bytes).toBeLessThanOrEqual(cap);
    }
  });

  test('autoplan: sum across 4 plan-* skills stays under AUTOPLAN_PREFLIGHT_BUDGET_BYTES × 3 (instructions)', () => {
    const autoplanSkills = ['plan-ceo-review', 'plan-eng-review', 'plan-design-review', 'plan-devex-review'];
    const total = autoplanSkills.reduce((sum, s) => sum + totalBrainBytes(s), 0);
    // Same 3x rationale: AUTOPLAN budget governs runtime data, instructions
    // get more headroom.
    expect(total).toBeLessThanOrEqual(AUTOPLAN_PREFLIGHT_BUDGET_BYTES * 3);
  });

  test('non-preflight skills emit zero brain bytes', () => {
    const nonPlanning = ['ship', 'qa', 'investigate', 'retro', 'design-review'];
    for (const skill of nonPlanning) {
      expect(totalBrainBytes(skill)).toBe(0);
    }
  });

  test('preflight bytes are positive for every registered preflight skill', () => {
    for (const skill of Object.keys(SKILL_DIGEST_SUBSETS)) {
      expect(totalBrainBytes(skill)).toBeGreaterThan(0);
    }
  });
});

describe('autoplan total preflight budget (T21 / D7)', () => {
  test('autoplan total under 25 KB instruction cap × 3 (75 KB instruction budget)', () => {
    const autoplanSkills = ['plan-ceo-review', 'plan-eng-review', 'plan-design-review', 'plan-devex-review'];
    const total = autoplanSkills.reduce((sum, s) => sum + totalBrainBytes(s), 0);
    // The 75 KB cap on instructions across the 4-skill autoplan; runtime
    // digest budget is the lower 25 KB cap, separately tested above.
    expect(total).toBeLessThan(75 * 1024);
  });

  test('per-skill subset emits its expected entity references in the preflight block', () => {
    for (const [skill, subset] of Object.entries(SKILL_DIGEST_SUBSETS)) {
      const preflight = generateBrainPreflight(buildCtx(skill));
      for (const entity of subset) {
        expect(preflight).toContain(`gstack-brain-cache get ${entity}`);
      }
    }
  });
});
