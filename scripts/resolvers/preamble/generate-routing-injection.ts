import type { TemplateContext } from '../types';

export function generateRoutingInjection(ctx: TemplateContext): string {
  return `If \`HAS_ROUTING\` is \`no\` AND \`ROUTING_DECLINED\` is \`false\` AND \`PROACTIVE_PROMPTED\` is \`yes\`:
Check if a CLAUDE.md file exists in the project root. If it does not exist, create it.

Use AskUserQuestion:

> gstack works best when your project's CLAUDE.md includes skill routing rules.

Options:
- A) Add routing rules to CLAUDE.md (recommended)
- B) No thanks, I'll invoke skills manually

If A: Append this section to the end of CLAUDE.md:

\`\`\`markdown

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
\`\`\`

Then commit the change: \`git add CLAUDE.md && git commit -m "chore: add gstack skill routing rules to CLAUDE.md"\`

If B: run \`${ctx.paths.binDir}/gstack-config set routing_declined true\` and say they can re-enable with \`gstack-config set routing_declined false\`.

This only happens once per project. Skip if \`HAS_ROUTING\` is \`yes\` or \`ROUTING_DECLINED\` is \`true\`.`;
}
