import type { TemplateContext } from '../types';

export function generateWritingStyleMigration(ctx: TemplateContext): string {
  return `If \`WRITING_STYLE_PENDING\` is \`yes\`: ask once about writing style:

> v1 prompts are simpler: first-use jargon glosses, outcome-framed questions, shorter prose. Keep default or restore terse?

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

Skip if \`WRITING_STYLE_PENDING\` is \`no\`.`;
}
