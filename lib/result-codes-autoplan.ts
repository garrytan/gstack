/**
 * Result codes for the CEO-only driver run (`gstack-autoplan next --ceo-only`,
 * lib/autoplan-ceo-only.ts) and its shadow-mode reader (`gstack-autoplan shadow`,
 * lib/autoplan-shadow-reader.ts). Kept beside lib/result-codes.ts, which spreads
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
    summary: 'answer, recommend, revise and approvals import need a gate or an approvable run, and a CEO-only run has neither: it ends status=reviewed and is never approved',
    fix: 'read <run dir>/ceo-review.md; to get a gate and an approval, start a full review with gstack-autoplan next --out <new dir> --plan <file> (no --ceo-only)',
  },
  SHADOW_BEFORE_ANSWER: {
    anchor: 'shadow-before-answer',
    summary: 'gstack-autoplan shadow skipped a gate revision whose plan approval is unanswered or answered c (interrogate): the export pairs predictions with answers, so it waits for the owner',
    fix: 'answer the gate (gstack-autoplan answer --gate-rev <n> ...), then run gstack-autoplan shadow again; answered revisions of the same run still export',
  },
  // GST-1243: the public copy of an autoplan run never carries the owner's own words.
  ARTIFACT_OWNER_WORDS: {
    anchor: 'artifact-owner-words',
    summary: 'a public copy of an autoplan run still quotes the owner\'s own words: a relayed gate reply, carried words or a human\'s deferral reason the private run recorded',
    fix: 'export with `gstack-autoplan export --out <run> --public <dir>`, which drops those fields and redacts quotes of them in prose; a quote inside a code span or fence in the plan is never rewritten, so edit the plan, revise, and export again',
  },
} as const satisfies Record<string, ResultCode>;
