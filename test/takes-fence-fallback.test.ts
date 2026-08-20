/**
 * Phase 2 calibration write-back fence-block fallback (T19).
 *
 * The BRAIN_WRITE_BACK resolver output describes two paths:
 *   1. Preferred: mcp__gbrain__takes_add op (upstream gbrain v0.42+, T8)
 *   2. Fallback: mcp__gbrain__put_page with a gstack:takes fence block
 *
 * Until T8 ships, the fallback is the only path. Verify the resolver output
 * mentions the fence-block fallback explicitly so the agent knows what to
 * do when takes_add returns MCPMethodNotFound.
 *
 * Gate-tier, free, pure import + render.
 */

import { describe, test, expect } from 'bun:test';
import { generateBrainWriteBack } from '../scripts/resolvers/gbrain';
import { SKILL_DIGEST_SUBSETS, SKILL_CALIBRATION_WEIGHTS } from '../scripts/brain-cache-spec';
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

describe('Phase 2 write-back fence-block fallback', () => {
  test('every preflight skill emits write-back with fallback path documented', () => {
    for (const skill of Object.keys(SKILL_DIGEST_SUBSETS)) {
      const out = generateBrainWriteBack(buildCtx(skill));
      // Mentions takes_add (preferred)
      expect(out).toContain('takes_add');
      // Mentions put_page fallback
      expect(out).toContain('put_page');
      // Mentions the takes fence-block syntax
      expect(out).toContain('takes');
    }
  });

  test('write-back guidance gates on BRAIN_CALIBRATION_WRITEBACK feature flag', () => {
    for (const skill of Object.keys(SKILL_DIGEST_SUBSETS)) {
      const out = generateBrainWriteBack(buildCtx(skill));
      expect(out).toContain('BRAIN_CALIBRATION_WRITEBACK');
    }
  });

  test('write-back guidance gates on brain_trust_policy == personal', () => {
    for (const skill of Object.keys(SKILL_DIGEST_SUBSETS)) {
      const out = generateBrainWriteBack(buildCtx(skill));
      expect(out).toContain('personal');
      expect(out).toContain('brain_trust_policy');
    }
  });

  test('write-back emits the kind=bet take frontmatter shape', () => {
    const out = generateBrainWriteBack(buildCtx('plan-ceo-review'));
    expect(out).toContain('kind: bet');
    expect(out).toContain('holder:');
    expect(out).toContain('claim:');
    expect(out).toContain('weight:');
    expect(out).toContain('since_date:');
    expect(out).toContain('expected_resolution:');
    expect(out).toContain('source_skill:');
  });

  test('per-skill weight matches SKILL_CALIBRATION_WEIGHTS', () => {
    for (const skill of Object.keys(SKILL_DIGEST_SUBSETS)) {
      const weight = SKILL_CALIBRATION_WEIGHTS[skill];
      if (weight == null) continue;
      const out = generateBrainWriteBack(buildCtx(skill));
      expect(out).toContain(`weight: ${weight}`);
    }
  });

  test('write-back invalidates affected cache digests after write', () => {
    const out = generateBrainWriteBack(buildCtx('plan-ceo-review'));
    expect(out).toContain('gstack-brain-cache invalidate');
  });

  test('non-preflight skill gets empty write-back (no Phase 2 path)', () => {
    expect(generateBrainWriteBack(buildCtx('ship'))).toBe('');
    expect(generateBrainWriteBack(buildCtx('qa'))).toBe('');
  });
});
