import type { TemplateContext } from '../types';

export function generateConfusionProtocol(ctx?: TemplateContext): string {
  if (ctx?.explainLevel === 'terse') return '';
  return `## Confusion Protocol

For high-stakes ambiguity (architecture, data model, destructive scope, missing context), STOP. Name it in one sentence, present 2-3 options with tradeoffs, and ask. Do not use for routine coding or obvious changes.`;
}
