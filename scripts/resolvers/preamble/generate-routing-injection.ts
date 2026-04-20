import type { TemplateContext } from '../types';

export function generateRoutingInjection(ctx: TemplateContext): string {
  return `If \`HAS_ROUTING\` is \`no\` AND \`ROUTING_DECLINED\` is \`false\` AND \`PROACTIVE_PROMPTED\` is \`yes\`:
Check if a CLAUDE.md file exists in the project root. If it does not exist, create it.

Use AskUserQuestion:

> gstack works best when your project's CLAUDE.md includes skill routing rules.
> This tells Claude to use specialized workflows (like /ship, /investigate, /qa)
> instead of answering directly. It's a one-time addition, about 15 lines.

Options:
- A) Add routing rules to CLAUDE.md (recommended)
- B) No thanks, I'll invoke skills manually

If A: Append this section to the end of CLAUDE.md:

\`\`\`markdown

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke checkpoint
- Code quality, health check → invoke health
\`\`\`

Then commit the change: \`git add CLAUDE.md && git commit -m "chore: add gstack skill routing rules to CLAUDE.md"\`

If B: run \`${ctx.paths.binDir}/gstack-config set routing_declined true\`
Say "No problem. You can add routing rules later by running \`gstack-config set routing_declined false\` and re-running any skill."

This only happens once per project. If \`HAS_ROUTING\` is \`yes\` or \`ROUTING_DECLINED\` is \`true\`, skip this entirely.`;
}

