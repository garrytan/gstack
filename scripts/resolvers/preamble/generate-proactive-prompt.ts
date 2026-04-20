import type { TemplateContext } from '../types';

export function generateProactivePrompt(ctx: TemplateContext): string {
  return `If \`PROACTIVE_PROMPTED\` is \`no\` AND \`TEL_PROMPTED\` is \`yes\`: After telemetry is handled,
ask the user about proactive behavior. Use AskUserQuestion:

> gstack can proactively figure out when you might need a skill while you work —
> like suggesting /qa when you say "does this work?" or /investigate when you hit
> a bug. We recommend keeping this on — it speeds up every part of your workflow.

Options:
- A) Keep it on (recommended)
- B) Turn it off — I'll type /commands myself

If A: run \`${ctx.paths.binDir}/gstack-config set proactive true\`
If B: run \`${ctx.paths.binDir}/gstack-config set proactive false\`

Always run:
\`\`\`bash
touch ~/.gstack/.proactive-prompted
\`\`\`

This only happens once. If \`PROACTIVE_PROMPTED\` is \`yes\`, skip this entirely.`;
}

