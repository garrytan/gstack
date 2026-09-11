import type { TemplateContext } from './types';

const ALLOWED: Record<string, string[]> = {
  review: ['report', 'bounded tracked_write under --fix', 'explicit external_reply under --reply-greptile'],
  ship: ['readiness', 'separately resolved delivery capabilities'],
  'land-and-deploy': ['exact-PR merge', 'configured-target deploy', 'separately resolved rollback'],
  'setup-deploy': ['docs/OPERATIONS.md only'],
};

export function generateWorkflowEffectBoundary(ctx: TemplateContext): string {
  const allowed = ALLOWED[ctx.skillName];
  if (!allowed) return '';
  const list = allowed.map((item) => `- ${item}`).join('\n');
  return `## ECPE workflow effect boundary

Resolve every governed write, Git/provider mutation, external reply, deploy,
rollback, or paid validator immediately before use through the closed authority
adapter. The installed invocation is:

\`GSTACK_ANCHOR_INVOCATION=${ctx.paths.binDir}/gstack-anchor\`

This workflow's closed surface is:
${list}

Missing, stale, mismatched, or consumed scope means zero effect children.
Validation risk may add gates but never grants capabilities. There is no generic
effect flag, persisted grant file, cwd/PATH fallback, or authority inheritance.`;
}
