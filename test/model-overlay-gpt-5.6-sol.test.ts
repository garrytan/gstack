import { describe, expect, test } from 'bun:test';
import { resolveModel } from '../scripts/models';
import { generateModelOverlay, readOverlay } from '../scripts/resolvers/model-overlay';
import { generateCompletenessSection } from '../scripts/resolvers/preamble/generate-completeness-section';
import { generateLakeIntro } from '../scripts/resolvers/preamble/generate-lake-intro';
import { generateSetupCommand } from '../scripts/resolvers/utility';
import type { TemplateContext } from '../scripts/resolvers/types';

function ctx(model: TemplateContext['model']): TemplateContext {
  return {
    skillName: 'investigate',
    tmplPath: 'investigate/SKILL.md.tmpl',
    host: 'codex',
    paths: {
      skillRoot: '$GSTACK_ROOT',
      localSkillRoot: '.agents/skills/gstack',
      binDir: '$GSTACK_BIN',
      browseDir: '$GSTACK_BROWSE',
      designDir: '$GSTACK_DESIGN',
      makePdfDir: '$GSTACK_MAKE_PDF',
    },
    preambleTier: 3,
    model,
  };
}

describe('GPT-5.6 Sol model profile', () => {
  test('only the exact Sol ID selects the Sol profile', () => {
    expect(resolveModel('gpt-5.6-sol')).toBe('gpt-5.6-sol');
    expect(resolveModel('gpt-5.6-terra')).toBe('gpt');
    expect(resolveModel('gpt-5.6-luna')).toBe('gpt');
    expect(resolveModel('gpt-5.6-sol-preview')).toBe('gpt');
    expect(resolveModel('gpt-5.7')).toBe('gpt');
  });

  test('standalone overlay does not inherit generic GPT completion bias', () => {
    const raw = readOverlay('gpt-5.6-sol');
    expect(raw).toContain('The explicit task is the lake');
    expect(raw).toContain('one clean relevant verification pass');
    expect(raw).toContain('report-only');
    expect(raw).not.toContain('{{INHERIT:gpt}}');
    expect(raw).not.toContain('make your best judgment and proceed');
  });

  test('wrapper gives scope interpretation precedence but preserves concrete gates', () => {
    const out = generateModelOverlay(ctx('gpt-5.6-sol'));
    expect(out).toContain('disambiguate scope');
    expect(out).toContain('Concrete skill workflow steps');
    expect(out).toContain('Never use this patch to skip a concrete requirement');
  });

  test('completeness and first-run copy stay inside the explicit task boundary', () => {
    const completeness = generateCompletenessSection(ctx('gpt-5.6-sol'));
    const intro = generateLakeIntro(ctx('gpt-5.6-sol'));
    expect(completeness).toContain("inside the user's explicit task boundary");
    expect(completeness).toContain('report them, do not implement them');
    expect(completeness).toContain('all relevant in-scope edge cases');
    expect(intro).toContain("within the user's explicit task boundary");
    expect(intro).toContain('Do not widen that boundary');
  });

  test('generic GPT copy remains unchanged', () => {
    const generic = generateModelOverlay(ctx('gpt'));
    const completeness = generateCompletenessSection(ctx('gpt'));
    const intro = generateLakeIntro(ctx('gpt'));
    expect(generic).toContain('make your best judgment and proceed');
    expect(completeness).toContain('the complete thing is the goal');
    expect(intro).toContain('do the complete thing when AI makes marginal cost near-zero');
    expect(intro).not.toContain('Do not widen that boundary');
  });

  test('terse mode still suppresses the completeness section for Sol', () => {
    // Terse short-circuits before the Sol branch — a check-order flip would
    // ship Sol completeness prose to terse users (a token regression).
    expect(generateCompletenessSection({ ...ctx('gpt-5.6-sol'), explainLevel: 'terse' })).toBe('');
  });
});

describe('SETUP_COMMAND resolver', () => {
  test('claude keeps bare ./setup; every other host reinstalls itself', () => {
    expect(generateSetupCommand({ ...ctx('claude'), host: 'claude' })).toBe('./setup');
    expect(generateSetupCommand({ ...ctx('gpt'), host: 'codex' })).toBe('./setup --host codex');
    expect(generateSetupCommand({ ...ctx('claude'), host: 'kiro' })).toBe('./setup --host kiro');
    expect(generateSetupCommand({ ...ctx('claude'), host: 'factory' })).toBe('./setup --host factory');
  });
});
