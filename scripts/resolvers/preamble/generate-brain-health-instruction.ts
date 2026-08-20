import type { TemplateContext } from '../types';

export function generateBrainHealthInstruction(ctx: TemplateContext): string {
  if (ctx.host !== 'gbrain' && ctx.host !== 'hermes') return '';
  return `If \`BRAIN_HEALTH\` is shown and the score is below 50, tell the user which checks
failed (shown in the output) and suggest: "Run \\\`gbrain doctor\\\` for full diagnostics."
If the output is not valid JSON or health_score is missing, treat GBrain as unavailable
and proceed without brain features this session.`;
}
