import type { TemplateContext } from '../types';

export function generateWritingStyleMigration(ctx: TemplateContext): string {
  return `If \`WRITING_STYLE_PENDING\` is \`yes\`: You're on the first skill run after upgrading
to gstack v1. Ask the user once about the new default writing style. Use AskUserQuestion:

> v1 prompts = simpler. Technical terms get a one-sentence gloss on first use,
> questions are framed in outcome terms, sentences are shorter.
>
> Keep the new default, or prefer the older tighter prose?

Options:
- A) Keep the new default (recommended — good writing helps everyone)
- B) Restore V0 prose — set \`explain_level: terse\`

If A: leave \`explain_level\` unset (defaults to \`default\`).
If B: run \`${ctx.paths.binDir}/gstack-config set explain_level terse\`.

Always run (regardless of choice):
\`\`\`bash
rm -f ~/.gstack/.writing-style-prompt-pending
touch ~/.gstack/.writing-style-prompted
\`\`\`

This only happens once. If \`WRITING_STYLE_PENDING\` is \`no\`, skip this entirely.`;
}
