import type { TemplateContext } from './types';

/**
 * {{INVOKE_SKILL:skill-name}} — emits prose instructing Claude to read
 * another skill's SKILL.md and follow it, skipping preamble sections.
 *
 * Supports optional skip= parameter for additional sections to skip:
 *   {{INVOKE_SKILL:plan-ceo-review:skip=Outside Voice,Design Outside Voices}}
 */
export function generateInvokeSkill(ctx: TemplateContext, args?: string[]): string {
  const skillName = args?.[0];
  if (!skillName || skillName === '') {
    throw new Error('{{INVOKE_SKILL}} requires a skill name, e.g. {{INVOKE_SKILL:plan-ceo-review}}');
  }

  // Parse optional skip= parameter from args[1+]
  const extraSkips = (args?.slice(1) || [])
    .filter(a => a.startsWith('skip='))
    .flatMap(a => a.slice(5).split(','))
    .map(s => s.trim())
    .filter(Boolean);

  const DEFAULT_SKIPS = [
    'Preamble (run first)',
    'AskUserQuestion Format',
    'Completeness Principle — Boil the Lake',
    'Search Before Building',
    'Contributor Mode',
    'Completion Status Protocol',
    'Telemetry (run last)',
    'Step 0: Detect platform and base branch',
    'Review Readiness Dashboard',
    'Plan File Review Report',
    'Prerequisite Skill Offer',
    'Plan Status Footer',
  ];

  const allSkips = [...DEFAULT_SKIPS, ...extraSkips];

  return `Read the \`/${skillName}\` skill file at \`${ctx.paths.skillRoot}/${skillName}/SKILL.md\` using the Read tool.

**If unreadable:** Skip with "Could not load /${skillName} — skipping." and continue.

Follow its instructions from top to bottom, **skipping these sections** (already handled by the parent skill):
${allSkips.map(s => `- ${s}`).join('\n')}

Execute every other section at full depth. When the loaded skill's instructions are complete, continue with the next step below.`;
}
