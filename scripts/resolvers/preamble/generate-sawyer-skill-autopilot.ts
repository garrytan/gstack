import type { TemplateContext } from '../types';

export function generateSawyerSkillAutopilot(ctx: TemplateContext): string {
  return `## Sawyer Skill Autopilot

If \`SAWYER_SKILL_AUTOPILOT\` is \`"suggest"\` or \`"strict"\`, use this local router before guessing which gstack skill comes first or next:

\`\`\`bash
${ctx.paths.binDir}/gstack-sawyer-skill-autopilot --json '{"prompt":"USER_PROMPT_OR_SUMMARY","lastSkill":"SKILL_NAME_IF_ANY","lastOutcome":"OUTCOME_IF_ANY","prState":"OPEN_OR_MERGED_IF_KNOWN","deployStatus":"HEALTHY_OR_UNKNOWN","runtimeProof":"present|missing|unknown","docsChanged":false,"developerFacing":false}'
\`\`\`

Follow the JSON recommendation only within the user's current permission. If it names \`permissionBoundary\` as \`push-pr\`, \`merge-deploy\`, \`live-runtime\`, or \`global-surface\`, stop and ask unless the user already granted that exact permission in this turn.

In \`strict\` mode, do not silently answer around a high-confidence \`invoke\` recommendation. Invoke the named skill when the host exposes a Skill tool; otherwise say which skill should run and what boundary, if any, blocks you. This router recommends only; it never pushes, merges, deploys, sends messages, or edits files.`;
}

