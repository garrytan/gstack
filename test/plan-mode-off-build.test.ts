/**
 * Unit tests for the --plan-mode=off flag (#3168).
 *
 * `--plan-mode=off` drops the "## Plan Mode Safe Operations" +
 * "## Skill Invocation During Plan Mode" preamble block from generated
 * skills, for hosts and users who never enter plan mode. Default builds
 * (planMode undefined or true) keep the block byte-identically.
 *
 * Pure-function tests against the resolvers — fast, free, no subprocess.
 */

import { describe, test, expect } from 'bun:test';
import type { TemplateContext } from '../scripts/resolvers/types';
import { generatePlanModeInfo, generateCompletionStatus } from '../scripts/resolvers/preamble/generate-completion-status';
import { generatePreamble } from '../scripts/resolvers/preamble';

function makeCtx(planMode?: boolean, tier: number = 4): TemplateContext {
  return {
    skillName: 'test-skill',
    tmplPath: '/tmp/test/SKILL.md.tmpl',
    host: 'claude',
    paths: {
      skillRoot: '~/.claude/skills/gstack',
      localSkillRoot: '.claude/skills',
      binDir: '~/.claude/skills/gstack/bin',
      browseDir: '~/.claude/skills/gstack/browse/dist',
      designDir: '~/.claude/skills/gstack/design/dist',
      makePdfDir: '~/.claude/skills/gstack/make-pdf/dist',
    },
    preambleTier: tier,
    planMode,
  };
}

describe('plan-mode off — generatePlanModeInfo', () => {
  test('planMode undefined: emits both plan-mode sections (default behavior)', () => {
    const out = generatePlanModeInfo(makeCtx(undefined));
    expect(out).toContain('## Plan Mode Safe Operations');
    expect(out).toContain('## Skill Invocation During Plan Mode');
  });

  test('planMode true: emits both plan-mode sections', () => {
    const out = generatePlanModeInfo(makeCtx(true));
    expect(out).toContain('## Plan Mode Safe Operations');
    expect(out).toContain('## Skill Invocation During Plan Mode');
  });

  test('planMode false: returns empty string', () => {
    expect(generatePlanModeInfo(makeCtx(false))).toBe('');
  });

  test('planMode false: no plan-mode heading survives', () => {
    const out = generatePlanModeInfo(makeCtx(false));
    expect(out).not.toContain('Plan Mode Safe Operations');
    expect(out).not.toContain('Skill Invocation During Plan Mode');
  });
});

describe('plan-mode off — generatePreamble integration', () => {
  test('default tier-2 preamble includes the plan-mode block', () => {
    const out = generatePreamble(makeCtx(undefined, 2));
    expect(out).toContain('## Plan Mode Safe Operations');
    expect(out).toContain('## Skill Invocation During Plan Mode');
  });

  test('planMode false tier-2 preamble drops the plan-mode block', () => {
    const out = generatePreamble(makeCtx(false, 2));
    expect(out).not.toContain('## Plan Mode Safe Operations');
    expect(out).not.toContain('## Skill Invocation During Plan Mode');
  });

  test('planMode false preamble is measurably smaller than default', () => {
    const defaultLen = generatePreamble(makeCtx(undefined, 2)).length;
    const offLen = generatePreamble(makeCtx(false, 2)).length;
    // The plan-mode block is ~1.8 KB; assert at least 1 KB saved.
    expect(defaultLen - offLen).toBeGreaterThan(1024);
  });

  test('planMode undefined preamble is byte-identical to planMode true', () => {
    expect(generatePreamble(makeCtx(undefined, 2))).toBe(generatePreamble(makeCtx(true, 2)));
  });

  test('planMode false: PLAN MODE EXCEPTION markers inside skill bodies still apply (completion status keeps its telemetry exception)', () => {
    const out = generateCompletionStatus(makeCtx(false));
    expect(out).toContain('PLAN MODE EXCEPTION — ALWAYS RUN');
  });
});
