/** Plan-approval handoff: recommend the runtime-resolved implementation model, never switch to it. */
import { toShellPath, type TemplateContext } from './types';

export function generateImplementationModelHandoff(ctx: TemplateContext): string {
  const provider = ctx.host === 'claude' ? ' --provider anthropic' : ctx.host === 'codex' ? ' --provider openai' : '';
  return `**Implementation model:** relay the model and source from \`"${toShellPath(ctx.paths.binDir)}/gstack-models" resolve --role implementation${provider}\`${provider ? '' : ' (one per provider)'}. A recommendation only; gstack cannot change this session. Switch nothing, start or spawn nothing, edit no config unless asked. On error relay its repair, not a model.`;
}
