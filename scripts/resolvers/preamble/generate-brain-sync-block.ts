/**
 * Artifacts-sync interpretation rules (token-reduction Phase 1).
 *
 * The ~6.8KB of artifacts-sync bash this generator used to inline (gbrain
 * availability hints, remote-MCP detection via claude.json, restore hint,
 * daily pull, queue-depth status) now runs inside `bin/gstack-skill-start`
 * (invoked by the Preamble fence above) and reports through the same STATUS
 * lines it always emitted: the GBrain hint text and the `ARTIFACTS_SYNC:`
 * line. What remains here is the prose the model acts on. The one-time
 * privacy stop-gate moved behind its runtime gate in Phase 2: it now arrives
 * as a GSTACK_INSTRUCTION block from gstack-skill-start when consent is
 * actually pending; this generator only carries the interpretation prose.
 *
 * Skill-END sync is no longer a separate fence: `bin/gstack-skill-end`
 * (invoked by the Telemetry step) drains the queue before logging.
 */
import type { TemplateContext } from '../types';

export function generateBrainSyncBlock(ctx: TemplateContext): string {
  const isBrainHost = ctx.host === 'gbrain' || ctx.host === 'hermes';
  return `## Artifacts Sync (skill start)

The skill-start output above already ran artifacts sync. Act on its lines:
GBrain hint text (if present) tells you when to prefer \`gbrain\` over Grep;
\`ARTIFACTS_SYNC:\` reports sync health (\`off\`, \`mode=... | queue=N\`,
\`remote-mode\`, or a restore hint naming \`gstack-brain-restore\`).

${isBrainHost ? `If output shows \`ARTIFACTS_SYNC: artifacts repo detected\`, offer \`gstack-brain-restore\` via AskUserQuestion; otherwise continue.

` : ''}The one-time privacy stop-gate (artifacts-sync consent) arrives as a
\`GSTACK_INSTRUCTION\` block from skill-start when consent is actually pending
— fire it via AskUserQuestion exactly as the block instructs.`;
}
