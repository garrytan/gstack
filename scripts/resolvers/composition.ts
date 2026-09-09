import { toShellPath, type TemplateContext } from './types';
import { outsideVoiceRuntime } from './outside-voice';
import * as path from 'path';
import { getHostConfig } from '../../hosts';

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
    'Completeness Principle — Boil the Ocean',
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

/** Autoplan reads methodology from this host's skill registry, not its runtime assets. */
export function generateAutoplanReviewFile(ctx: TemplateContext, args?: string[]): string {
  const skill = args?.[0];
  if (!skill || !['plan-ceo-review', 'plan-design-review', 'plan-devex-review', 'plan-eng-review'].includes(skill)) {
    throw new Error('AUTOPLAN_REVIEW_FILE requires an autoplan review skill');
  }
  if (ctx.host === 'claude') return `\`${ctx.paths.skillRoot}/${skill}/SKILL.md\``;

  const host = getHostConfig(ctx.host);
  const file = `gstack-${skill}/SKILL.md`;
  const local = `${path.posix.dirname(host.localSkillRoot)}/${file}`;
  const global = `~/${path.posix.dirname(host.globalRoot)}/${file}`;
  // Resolve from the discovered entrypoint's directory: GSTACK_ROOT is an
  // independently configurable runtime asset tree, not a skill registry.
  // This also preserves custom CODEX_HOME installations without guessing HOME.
  return `the sibling registry file \`../${file}\`, relative to the installed \`/autoplan\` SKILL.md directory (local: \`${local}\`; global: \`${global}\`${ctx.host === 'codex' ? ', or the corresponding skills directory under CODEX_HOME when configured' : ''})`;
}

/** Resolve once to a literal path; later phase commands run in fresh shells. */
export function generateAutoplanSnapshotTool(ctx: TemplateContext): string {
  return `\`\`\`bash
${outsideVoiceRuntime(ctx)}
bun -e 'console.log(require("fs").realpathSync(process.argv[1]))' "${toShellPath(ctx.paths.binDir)}/gstack-autoplan-snapshot.ts"
\`\`\``;
}
