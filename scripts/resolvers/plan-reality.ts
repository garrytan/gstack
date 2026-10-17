/**
 * Plan reality rows (multi-agent wave D1, release promise P5).
 *
 * {{PLAN_REALITY_ROWS}} and its variants render lib/plan-reality.ts's one row
 * table into the plan-review skills and the autoplan phase files, so the rows a
 * review must carry, the `REALITY:` line a reviewer emits and the check a
 * parent runs never drift apart:
 *
 *   {{PLAN_REALITY_ROWS:eng}} / {{PLAN_REALITY_ROWS:ceo}}
 *       the operative block for an interactive plan review (tier 1 row ids, the
 *       bin that prints every applicable row, the line grammar, the miss rule)
 *   {{PLAN_REALITY_ROWS:deep}}
 *       the full table with each row's incident note, for the deep section
 *   {{PLAN_REALITY_ROWS:autoplan:<phase>}}
 *       one checklist item for an autoplan phase file
 *   {{PLAN_REALITY_ROWS:pregate}}
 *       the Pre-Gate rule: unattended a miss is `incomplete`, never a warning
 *   {{PLAN_REALITY_ROWS:summary}}
 *       the Completion Summary line
 *
 * The rows themselves are printed by `gstack-plan-reality rows` at run time so
 * the zero-headroom skills carry the contract, not eighteen rows of prose.
 */
import type { TemplateContext } from './types';
import { REALITY_LINE_SHAPE, REALITY_ROWS, TIER1_ROW_IDS, renderIncidentTable } from '../../lib/plan-reality';

const BIN = '~/.claude/skills/gstack/bin/gstack-plan-reality';

function phaseFor(ctx: TemplateContext, arg: string | undefined): string {
  if (arg && arg !== 'deep' && arg !== 'summary' && arg !== 'pregate' && arg !== 'autoplan') return arg;
  const m = /^plan-(ceo|eng|devex|design)-review$/.exec(ctx.skillName);
  return m ? (m[1] === 'devex' ? 'dx' : m[1]) : 'eng';
}

export function generatePlanRealityRows(ctx: TemplateContext, args?: string[]): string {
  const mode = args?.[0];
  if (mode === 'deep') {
    return `### Reality rows (why each exists)

Each row is tied to the incident that earned it; its check is what
\`${BIN} rows --phase <p> --deep\` prints. Tier 1 rows are required in every review and never
\`n/a\`; a tier 2 row is required only when the detected scope names its scope (\`--scope\`).

${renderIncidentTable(REALITY_ROWS)}`;
  }
  if (mode === 'summary') return `- Reality rows: ___/___ applicable rows emitted (\`PLAN_REALITY\` line), ___ unverified premises`;
  if (mode === 'pregate') {
    return `Reality rows: each phase's \`PLAN_REALITY: … verdict=complete\` from
\`${BIN} check --phase <ceo|eng> <review-file|->\`. A missing applicable row is \`incomplete\`
in an unattended run, never a warning; interactive runs follow the repair rule above.`;
  }
  if (mode === 'autoplan') {
    return `Reality rows: the loaded skill's \`REALITY:\` lines, one per applicable row;
   \`${BIN} check --phase ${args?.[1] ?? 'ceo'} --plan <reviewed snapshot> <review-file|->\` prints \`PLAN_REALITY: … verdict=complete\` before the phase closes
   (unattended: \`incomplete\` keeps it open).`;
  }
  const phase = phaseFor(ctx, mode);
  return `**Reality rows (required):** run \`${BIN} rows --phase ${phase}\` and work its
rows (tier 1 always, never \`n/a\`: ${TIER1_ROW_IDS.join(', ')}; tier 2 by detected scope, \`--scope <csv>\`).
Every row cites a file:line receipt (with no linked issue, deferred-asks is \`pass\`); the premise table counts \`unverified=<n>\`. End with
one line per row, \`${REALITY_LINE_SHAPE}\`, then run
\`${BIN} check --phase ${phase} <review-file|->\`: a missing row is \`incomplete\`
unattended; interactive runs repair twice, then warn at the gate.`;
}
