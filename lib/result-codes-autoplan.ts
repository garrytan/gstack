/**
 * Result codes for the CEO-only driver run (`gstack-autoplan next --ceo-only`,
 * lib/autoplan-ceo-only.ts). Kept beside lib/result-codes.ts, which spreads
 * this table into RESULT_CODES; the same rules apply: one stable
 * docs/troubleshooting.md anchor, a summary and a fix clause each. The run is
 * documented in docs/unattended.md#ceo-only-runs.
 */
import type { ResultCode } from './result-codes';

export const AUTOPLAN_RESULT_CODES = {
  CEO_ONLY_CONFLICT: {
    anchor: 'ceo-only-conflict',
    summary: '--ceo-only was combined with a flag that adds a phase (--ui, --developer-tool, --agent-primary), or a plan\'s scope marker names it',
    fix: 'drop the conflicting flag, or run without --ceo-only for the full review; --ceo-only goes on the command line of the first next only, never in a gstack-autoplan-scope marker',
  },
  CEO_ONLY_AFTER_INIT: {
    anchor: 'ceo-only-after-init',
    summary: 'next --ceo-only named a run directory that already holds a full review run',
    fix: 'a run keeps the mode it started with: pass --ceo-only on the first next with a new --out directory',
  },
  CEO_ONLY_NO_GATE: {
    anchor: 'ceo-only-no-gate',
    summary: 'the command needs a gate or an approvable run, and a CEO-only run has neither: it ends status=reviewed and is never approved',
    fix: 'read <run dir>/ceo-review.md; to get a gate and an approval, start a full review with gstack-autoplan next --out <new dir> --plan <file> (no --ceo-only)',
  },
} as const satisfies Record<string, ResultCode>;
