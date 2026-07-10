/**
 * Resolver regression pin for generateGBrainSaveResults +
 * generateGBrainContextLoad (compressed in v1.50.0.0).
 *
 * Two coverage stories:
 *   1. **Wiring symmetry**: all 5 planning skills (office-hours, plan-ceo-review,
 *      plan-eng-review, plan-design-review, plan-devex-review) get the correct
 *      slug prefix + tag in the emitted save instructions.
 *   2. **Token-budget pin**: post-compression, each block stays under a chars
 *      ceiling so a future "let me just add one more line" refactor doesn't
 *      silently re-inflate the prompt cost back toward the ~1000-token
 *      naive-un-suppression baseline.
 *
 * Gate-tier, free, pure import + render — no host generation, no claude -p.
 */

import { describe, test, expect } from 'bun:test';
import {
  generateGBrainContextLoad,
  generateGBrainSaveResults,
} from '../scripts/resolvers/gbrain';
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

// Per-skill expected slug prefix + tag. If you add a new planning skill,
// add it here AND in scripts/resolvers/gbrain.ts skillSaveMap. If you rename
// one, this test will fail loudly — that's the regression pin working.
const PLANNING_SKILLS: Array<{ skill: string; slugPrefix: string; tag: string; title: string }> = [
  { skill: 'office-hours',       slugPrefix: 'office-hours/',    tag: 'design-doc',    title: 'Office Hours' },
  { skill: 'plan-ceo-review',    slugPrefix: 'ceo-plans/',       tag: 'ceo-plan',      title: 'CEO Plan' },
  { skill: 'plan-eng-review',    slugPrefix: 'eng-reviews/',     tag: 'eng-review',    title: 'Eng Review' },
  { skill: 'plan-design-review', slugPrefix: 'design-reviews/',  tag: 'design-review', title: 'Design Review' },
  { skill: 'plan-devex-review',  slugPrefix: 'devex-reviews/',   tag: 'devex-review',  title: 'Devex Review' },
];

describe('generateGBrainSaveResults — wiring + compression pin', () => {
  test.each(PLANNING_SKILLS)(
    '$skill emits gbrain put $slugPrefix... with $tag tag',
    ({ skill, slugPrefix, tag, title }) => {
      const out = generateGBrainSaveResults(buildCtx(skill));

      // Uses gbrain put (v0.18+ subcommand), not deprecated put_page MCP op.
      expect(out).toContain('gbrain put');
      expect(out).not.toContain('put_page');

      // Per-skill slug prefix is exactly what skillSaveMap declares.
      expect(out).toContain(`"${slugPrefix}<feature-slug>"`);

      // Title prefix + tag match the metadata.
      expect(out).toContain(`title: "${title}:`);
      expect(out).toContain(`tags: [${tag},`);

      // Skip-header is present so agent can short-circuit when gbrain is absent.
      expect(out).toContain('Skip this entire section if `gbrain` is not on PATH');

      // Compact: points to docs/gbrain-write-surfaces.md for full template.
      expect(out).toContain('docs/gbrain-write-surfaces.md');
    },
  );

  test('all 5 planning skills produce output under ~600 chars (~150 tokens)', () => {
    // Token-budget pin. Naive un-suppression would emit ~1000 tokens (~4000 chars)
    // per skill. Compressed target: ~150 tokens (~600 chars). Generous ceiling
    // at 750 chars to leave room for the heredoc structure without inviting a
    // gradual re-inflation of the prose.
    const CEILING_CHARS = 750;
    for (const { skill } of PLANNING_SKILLS) {
      const out = generateGBrainSaveResults(buildCtx(skill));
      if (out.length > CEILING_CHARS) {
        throw new Error(
          `generateGBrainSaveResults('${skill}') emitted ${out.length} chars (~${Math.round(out.length / 4)} tokens), ` +
            `exceeds ceiling of ${CEILING_CHARS} chars (~${Math.round(CEILING_CHARS / 4)} tokens). ` +
            `If you added necessary content, move the verbose prose into ` +
            `docs/gbrain-write-surfaces.md §Save Template (which the agent reads on demand) and ` +
            `keep the inline block as a short pointer + per-skill metadata. ` +
            `See gbrain.ts T4/v1.50.0.0 compression rationale.`,
        );
      }
    }
  });

  test('unmapped skill name falls through to compact generic template', () => {
    const out = generateGBrainSaveResults(buildCtx('no-such-skill'));

    // Generic fallback still emits gbrain put + skip-header + docs pointer.
    expect(out).toContain('gbrain put');
    expect(out).toContain('Skip this entire section if `gbrain` is not on PATH');
    expect(out).toContain('docs/gbrain-write-surfaces.md');

    // Should NOT contain a per-skill slug prefix from the map (would mean we
    // accidentally regressed to the per-skill path for an unmapped skill).
    for (const { slugPrefix } of PLANNING_SKILLS) {
      expect(out).not.toContain(`"${slugPrefix}<feature-slug>"`);
    }
  });
});

describe('generateGBrainContextLoad — compression pin', () => {
  test('emits skip-header and docs pointer, stays under ~500 chars', () => {
    // Same compression discipline as SAVE_RESULTS. Context load was ~350-450
    // tokens before compression; target ~80 tokens (~320 chars). Ceiling
    // generous at 500 chars to leave room for skill-specific suffixes.
    const out = generateGBrainContextLoad(buildCtx('plan-ceo-review'));
    expect(out).toContain('Skip this entire section if `gbrain` is not on PATH');
    expect(out).toContain('docs/gbrain-write-surfaces.md');
    expect(out).toContain('gbrain search');
    expect(out).toContain('gbrain get_page');
    if (out.length > 500) {
      throw new Error(
        `generateGBrainContextLoad emitted ${out.length} chars (~${Math.round(out.length / 4)} tokens), ` +
          `exceeds ceiling of 500 chars (~125 tokens). ` +
          `Move verbose prose to docs/gbrain-write-surfaces.md §Context Load.`,
      );
    }
  });

  test('/investigate gets the data-research routing suffix', () => {
    const out = generateGBrainContextLoad(buildCtx('investigate'));
    expect(out).toContain('data-research');
  });

  test('non-investigate skills do NOT get the data-research suffix', () => {
    for (const { skill } of PLANNING_SKILLS) {
      const out = generateGBrainContextLoad(buildCtx(skill));
      expect(out).not.toContain('data-research');
    }
  });
});
