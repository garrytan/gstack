/** Plan-approval handoff: recommend the runtime-resolved implementation model, never switch to it. */
import { toShellPath, type TemplateContext } from './types';

export function generateImplementationModelHandoff(ctx: TemplateContext): string {
  const provider = ctx.host === 'claude' ? ' --provider anthropic' : ctx.host === 'codex' ? ' --provider openai' : '';
  return `**Implementation model:** relay model/source from \`"${toShellPath(ctx.paths.binDir)}/gstack-models" resolve --role implementation${provider}\`${provider ? '' : ' (one per provider)'}. gstack cannot change this session. Recommend only; no spawn or config edits unless asked. On error, relay its repair, not a model. [Policy setup](https://github.com/garrytan/gstack/blob/main/docs/model-policy.md).`;
}
