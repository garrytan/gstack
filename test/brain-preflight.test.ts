/**
 * Brain-aware planning resolver tests (T4 / T19).
 *
 * Verifies the three resolvers in scripts/resolvers/gbrain.ts:
 *   - generateBrainPreflight — fires for preflight skills, empty for others
 *   - generateBrainCacheRefresh — same gating
 *   - generateBrainWriteBack — same gating; only weighted skills emit
 *
 * Gate-tier, free, pure import + render.
 */

import { describe, test, expect } from 'bun:test';
import {
  generateBrainPreflight,
  generateBrainCacheRefresh,
  generateBrainWriteBack,
} from '../scripts/resolvers/gbrain';
import { SKILL_DIGEST_SUBSETS } from '../scripts/brain-cache-spec';
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

describe('generateBrainPreflight', () => {
  test('emits content for every registered preflight skill', () => {
    for (const skill of Object.keys(SKILL_DIGEST_SUBSETS)) {
      const out = generateBrainPreflight(buildCtx(skill));
      expect(out.length).toBeGreaterThan(0);
      expect(out).toContain('## Brain Context');
      expect(out).toContain('gstack-brain-cache get');
    }
  });

  test('emits empty string for non-preflight skills (no behavior)', () => {
    const nonPlanning = ['ship', 'qa', 'investigate', 'retro', 'design-review'];
    for (const skill of nonPlanning) {
      expect(generateBrainPreflight(buildCtx(skill))).toBe('');
    }
  });

  test('includes per-skill subset entities (office-hours loads 5 digests)', () => {
    const out = generateBrainPreflight(buildCtx('office-hours'));
    // office-hours loads: product, goals, user-profile, recent-decisions, salience
    expect(out).toContain('product');
    expect(out).toContain('goals');
    expect(out).toContain('user-profile');
    expect(out).toContain('recent-decisions');
    expect(out).toContain('salience');
  });

  test('plan-eng-review loads minimal subset (2 digests)', () => {
    const out = generateBrainPreflight(buildCtx('plan-eng-review'));
    expect(out).toContain('product');
    expect(out).toContain('recent-decisions');
    // Should NOT load brand or developer-persona
    expect(out).not.toContain('gstack-brain-cache get brand');
    expect(out).not.toContain('gstack-brain-cache get developer-persona');
  });

  test('mentions D9 salience privacy in the prose (transparency)', () => {
    const out = generateBrainPreflight(buildCtx('office-hours'));
    expect(out.toLowerCase()).toContain('privacy');
    expect(out.toLowerCase()).toContain('allowlist');
  });

  test('user-profile is loaded WITHOUT --project flag (cross-project)', () => {
    const out = generateBrainPreflight(buildCtx('office-hours'));
    const userProfileLine = out.split('\n').find((l) => l.includes('user-profile')) || '';
    // user-profile is cross-project; the get call should NOT have --project
    // (the only --project mentions on that line are inside the comment, not in the get call)
    const getLine = out.split('\n').find((l) => l.includes('gstack-brain-cache get user-profile')) || '';
    expect(getLine).not.toContain('--project');
  });

  test('per-project entities are loaded WITH --project "$SLUG"', () => {
    const out = generateBrainPreflight(buildCtx('plan-eng-review'));
    expect(out).toContain('--project "$SLUG"');
  });
});

describe('generateBrainCacheRefresh', () => {
  test('emits refresh hook for preflight skills', () => {
    const out = generateBrainCacheRefresh(buildCtx('plan-ceo-review'));
    expect(out).toContain('Background Refresh');
    expect(out).toContain('gstack-brain-cache refresh');
  });

  test('empty for non-preflight skills', () => {
    expect(generateBrainCacheRefresh(buildCtx('ship'))).toBe('');
  });

  test('uses background backgrounding (does not block user)', () => {
    const out = generateBrainCacheRefresh(buildCtx('plan-ceo-review'));
    // Background refresh fires the cache refresh in a detached process
    expect(out).toContain('&');
  });
});

describe('generateBrainWriteBack', () => {
  test('emits write-back block for all 5 weighted preflight skills', () => {
    for (const skill of Object.keys(SKILL_DIGEST_SUBSETS)) {
      const out = generateBrainWriteBack(buildCtx(skill));
      expect(out.length).toBeGreaterThan(0);
      expect(out).toContain('Calibration Write-Back');
      expect(out).toContain('BRAIN_CALIBRATION_WRITEBACK');
    }
  });

  test('empty for non-preflight skills', () => {
    expect(generateBrainWriteBack(buildCtx('ship'))).toBe('');
  });

  test('includes per-skill calibration weight (E5)', () => {
    const ceo = generateBrainWriteBack(buildCtx('plan-ceo-review'));
    expect(ceo).toContain('weight: 0.8'); // SKILL_CALIBRATION_WEIGHTS['plan-ceo-review'] = 0.8

    const office = generateBrainWriteBack(buildCtx('office-hours'));
    expect(office).toContain('weight: 0.9'); // strongest calibration weight

    const design = generateBrainWriteBack(buildCtx('plan-design-review'));
    expect(design).toContain('weight: 0.5'); // weakest (design predictions are noisy)
  });

  test('mentions personal trust policy gate (D11 codex tension)', () => {
    const out = generateBrainWriteBack(buildCtx('plan-ceo-review'));
    expect(out.toLowerCase()).toContain('personal');
    expect(out).toContain('brain_trust_policy');
  });

  test('mentions fallback path when takes_add MCP op unavailable (upstream T8)', () => {
    const out = generateBrainWriteBack(buildCtx('plan-ceo-review'));
    expect(out).toContain('put_page');
    expect(out).toContain('takes');
  });

  test('emits invalidation bash for affected cache digests', () => {
    const out = generateBrainWriteBack(buildCtx('plan-ceo-review'));
    // plan-ceo-review invalidates: product, goals, competitive-intel
    expect(out).toContain('gstack-brain-cache invalidate');
  });
});

describe('resolver registration in index.ts', () => {
  test('BRAIN_PREFLIGHT placeholder is registered', async () => {
    const { RESOLVERS } = await import('../scripts/resolvers/index');
    expect(RESOLVERS.BRAIN_PREFLIGHT).toBeDefined();
    expect(typeof RESOLVERS.BRAIN_PREFLIGHT).toBe('function');
  });

  test('BRAIN_CACHE_REFRESH placeholder is registered', async () => {
    const { RESOLVERS } = await import('../scripts/resolvers/index');
    expect(RESOLVERS.BRAIN_CACHE_REFRESH).toBeDefined();
  });

  test('BRAIN_WRITE_BACK placeholder is registered', async () => {
    const { RESOLVERS } = await import('../scripts/resolvers/index');
    expect(RESOLVERS.BRAIN_WRITE_BACK).toBeDefined();
  });
});
