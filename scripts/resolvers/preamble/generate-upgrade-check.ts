import type { TemplateContext } from '../types';

export function generateUpgradeCheck(ctx: TemplateContext): string {
  return `If \`PROACTIVE\` is \`"false"\`, do not proactively suggest gstack skills AND do not
auto-invoke skills based on conversation context. Only run skills the user explicitly
types (e.g., /qa, /ship). If you would have auto-invoked a skill, instead briefly say:
"I think /skillname might help here — want me to run it?" and wait for confirmation.
The user opted out of proactive behavior.

If \`SKILL_PREFIX\` is \`"true"\`, the user has namespaced skill names. When suggesting
or invoking other gstack skills, use the \`/gstack-\` prefix (e.g., \`/gstack-qa\` instead
of \`/qa\`, \`/gstack-ship\` instead of \`/ship\`). Disk paths are unaffected — always use
\`${ctx.paths.skillRoot}/[skill-name]/SKILL.md\` for reading skill files.

If output shows \`UPGRADE_AVAILABLE <old> <new>\`: read \`${ctx.paths.skillRoot}/gstack-upgrade/SKILL.md\` and follow the "Inline upgrade flow" (auto-upgrade if configured, otherwise AskUserQuestion with 4 options, write snooze state if declined).

If output shows \`JUST_UPGRADED <from> <to>\` AND \`SPAWNED_SESSION\` is NOT set: tell
the user "Running gstack v{to} (just updated!)" and then check for new features to
surface. For each per-feature marker below, if the marker file is missing AND the
feature is plausibly useful for this user, use AskUserQuestion to let them try it.
Fire once per feature per user, NOT once per upgrade.

**In spawned sessions (\`SPAWNED_SESSION\` = "true"): SKIP feature discovery entirely.**
Just print "Running gstack v{to}" and continue. Orchestrators do not want interactive
prompts from sub-sessions.

**Feature discovery markers and prompts** (one at a time, max one per session):

1. \`${ctx.paths.skillRoot}/.feature-prompted-continuous-checkpoint\` →
   Prompt: "Continuous checkpoint auto-commits your work as you go with \`WIP:\` prefix
   so you never lose progress to a crash. Local-only by default — doesn't push
   anywhere unless you turn that on. Want to try it?"
   Options: A) Enable continuous mode, B) Show me first (print the section from
   the preamble Continuous Checkpoint Mode), C) Skip.
   If A: run \`${ctx.paths.binDir}/gstack-config set checkpoint_mode continuous\`.
   Always: \`touch ${ctx.paths.skillRoot}/.feature-prompted-continuous-checkpoint\`

2. \`${ctx.paths.skillRoot}/.feature-prompted-model-overlay\` →
   Inform only (no prompt): "Model overlays are active. \`MODEL_OVERLAY: {model}\`
   shown in the preamble output tells you which behavioral patch is applied.
   Override with \`--model\` when regenerating skills (e.g., \`bun run gen:skill-docs
   --model gpt-5.4\`). Default is claude."
   Always: \`touch ${ctx.paths.skillRoot}/.feature-prompted-model-overlay\`

After handling JUST_UPGRADED (prompts done or skipped), continue with the skill
workflow.`;
}

