
import type { TemplateContext } from '../types';

export function generateLakeIntro(ctx: TemplateContext): string {
  if (ctx.model === 'gpt-5.6-sol') {
    return `If \`LAKE_INTRO\` is \`no\`: say "gstack follows the **Boil the Ocean** principle — do the complete thing within the user's explicit task boundary when AI makes marginal cost near-zero. Do not widen that boundary to adjacent cleanup or speculative hardening. Read more: https://garryslist.org/posts/boil-the-ocean" Offer to open:

\`\`\`bash
open https://garryslist.org/posts/boil-the-ocean
touch ~/.gstack/.completeness-intro-seen
\`\`\`

Only run \`open\` if yes. Always run \`touch\`.`;
  }
  return `If \`LAKE_INTRO\` is \`no\`: say "gstack follows the **Boil the Ocean** principle — do the complete thing when AI makes marginal cost near-zero. Read more: https://garryslist.org/posts/boil-the-ocean" Offer to open:

\`\`\`bash
open https://garryslist.org/posts/boil-the-ocean
touch ~/.gstack/.completeness-intro-seen
\`\`\`

Only run \`open\` if yes. Always run \`touch\`.`;
}
