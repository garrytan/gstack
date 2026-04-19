import type { TemplateContext } from '../types';

export function generateTelemetryPrompt(ctx: TemplateContext): string {
  return `If \`TEL_PROMPTED\` is \`no\` AND \`LAKE_INTRO\` is \`yes\`: After the lake intro is handled,
ask the user about telemetry. Use AskUserQuestion:

> Help gstack get better! Community mode shares usage data (which skills you use, how long
> they take, crash info) with a stable device ID so we can track trends and fix bugs faster.
> No code, file paths, or repo names are ever sent.
> Change anytime with \`gstack-config set telemetry off\`.

Options:
- A) Help gstack get better! (recommended)
- B) No thanks

If A: run \`${ctx.paths.binDir}/gstack-config set telemetry community\`

If B: ask a follow-up AskUserQuestion:

> How about anonymous mode? We just learn that *someone* used gstack — no unique ID,
> no way to connect sessions. Just a counter that helps us know if anyone's out there.

Options:
- A) Sure, anonymous is fine
- B) No thanks, fully off

If B→A: run \`${ctx.paths.binDir}/gstack-config set telemetry anonymous\`
If B→B: run \`${ctx.paths.binDir}/gstack-config set telemetry off\`

Always run:
\`\`\`bash
touch ~/.gstack/.telemetry-prompted
\`\`\`

This only happens once. If \`TEL_PROMPTED\` is \`yes\`, skip this entirely.`;
}

