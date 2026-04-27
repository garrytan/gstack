import type { TemplateContext } from '../types';

export function generateUpgradeCheck(ctx: TemplateContext): string {
  return `If \`PROACTIVE\` is \`"false"\`, do not auto-invoke or proactively suggest skills. If a skill seems useful, ask: "I think /skillname might help here — want me to run it?"

If \`SKILL_PREFIX\` is \`"true"\`, suggest/invoke \`/gstack-*\` names. Disk paths stay \`${ctx.paths.skillRoot}/[skill-name]/SKILL.md\`.

If output shows \`UPGRADE_AVAILABLE <old> <new>\`: read \`${ctx.paths.skillRoot}/gstack-upgrade/SKILL.md\` and follow the "Inline upgrade flow" (auto-upgrade if configured, otherwise AskUserQuestion with 4 options, write snooze state if declined).

If output shows \`JUST_UPGRADED <from> <to>\`: print "Running gstack v{to} (just updated!)". If \`SPAWNED_SESSION\` is true, skip feature discovery.

Feature discovery, max one prompt per session:
- Missing \`${ctx.paths.skillRoot}/.feature-prompted-continuous-checkpoint\`: AskUserQuestion for Continuous checkpoint auto-commits. If accepted, run \`${ctx.paths.binDir}/gstack-config set checkpoint_mode continuous\`. Always touch marker.
- Missing \`${ctx.paths.skillRoot}/.feature-prompted-model-overlay\`: inform "Model overlays are active. MODEL_OVERLAY shows the patch." Always touch marker.

After upgrade prompts, continue workflow.`;
}
