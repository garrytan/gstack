import type { TemplateContext } from '../types';

/**
 * Steady-state STATUS-line rules only (token-reduction Phase 2). The upgrade
 * flow, feature discovery, and every one-time onboarding prompt moved into
 * bin/gstack-skill-start's instruction-emission layer — their text is emitted
 * at runtime only when the gate fires, wrapped in GSTACK_INSTRUCTION blocks
 * the fence prose scopes and the model follows.
 */
export function generateUpgradeCheck(ctx: TemplateContext): string {
  return `If \`PROACTIVE\` is \`off\`: suggest no skills unasked, nor ask. \`core\`: only /office-hours, /review, /qa, /gstack-ship. \`all\`: any. Skills the user names or this one invokes run.

If \`SKILL_PREFIX\` is \`true\` use \`/gstack-*\` names; paths stay \`${ctx.paths.skillRoot}/[skill-name]/SKILL.md\`.`;
}
