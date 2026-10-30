/**
 * Result codes for the /ship token budget (bin/gstack-ship-budget, the
 * reservation check in `gstack-review-log --start`) and the fresh-context
 * handoff (lib/ship-handoff.ts), plus the reviewer packets' coverage stop
 * (lib/review-packet-collect.ts). Kept beside lib/result-codes.ts, which spreads
 * this table into RESULT_CODES; the same rules apply: one stable
 * docs/troubleshooting.md anchor, a summary and a fix clause each. The flow is
 * documented in docs/ship-budget.md.
 */
import type { ResultCode } from './result-codes';

export const BUDGET_RESULT_CODES = {
  BUDGET_CAP_REACHED: {
    anchor: 'budget-cap-reached',
    summary: 'the next step or dispatch would push used + open reservations + its projection + the tail and stop reserve past the admission cap, so it did not start',
    fix: 'the run stopped status=incomplete with a resumable record; raising the cap is the owner\'s call: run the printed RECOVER line, whose resume needs --approved-by <who> --words <their words>',
  },
  BUDGET_READING_MISSING: {
    anchor: 'budget-reading-missing',
    summary: 'the Capy meter needs a fresh counter reading and none was passed',
    fix: 'read cost.tokens from tools.thread.get({ thread_id: "this" }) in one execute program and pass it with --reading <n> (ship/sections/budget-handoff.md has the recipe)',
  },
  BUDGET_READING_REJECTED: {
    anchor: 'budget-reading-rejected',
    summary: 'the reading does not fit the run\'s meter contract: it is lower than the last reading of the same epoch, it was passed to a meter that reads its own source, or --prior-reading is above --reading',
    fix: 'pass the counter the run started with (the BUDGET line names meter, unit and epoch); a different meter starts a new epoch through gstack-ship-budget resume --meter <m>',
  },
  BUDGET_METER_UNAVAILABLE: {
    anchor: 'budget-meter-unavailable',
    summary: 'a cap is set and no meter is readable: no --reading, no bound Claude Code session and no --meter estimate',
    fix: 'pass --reading <n> on Capy, --session <id> or --nonce <value> on Claude Code, or --meter estimate to accept the conservative estimate (printed meter=estimate)',
  },
  BUDGET_LEDGER_INVALID: {
    anchor: 'budget-ledger-invalid',
    summary: 'the budget ledger or the record\'s gstack-budget block is missing, unparseable, or from another schema version',
    fix: 'restore it from the Drive checkpoint (gstack-ship-budget resume --run <id>) or rebuild it from the record with resume --record <path> --rebuild-from-record --reading <n>; open reservations are then charged as unknown',
  },
  BUDGET_CHECK_SKIPPED: {
    anchor: 'budget-check-skipped',
    summary: 'a dispatch under a cap started without an unspent reservation id from gstack-ship-budget check, or reused or mismatched one',
    fix: 'run gstack-ship-budget check --run <id> --step <s> --next dispatch:<roles> before the dispatch and pass its RESERVATION id once; a reservation is never created after the fact, so an unreserved dispatch ends the run status=incomplete for the owner to accept',
  },
  REVIEW_COVERAGE_INCOMPLETE: {
    anchor: 'review-coverage-incomplete',
    summary: 'a dispatched reviewer wrote no usable result: its packet output file is missing, empty, or holds neither NO FINDINGS nor a valid finding',
    fix: 'confirm the reviewer stopped, then dispatch its packet again with the same brief and rerun collect; missing coverage is never clean, and a peer cannot replace it',
  },
  HANDOFF_PIN_MOVED: {
    anchor: 'handoff-pin-moved',
    summary: 'the handoff brief no longer matches the tree it was written for: HEAD, the merge base, the working tree or the brief\'s own hash moved',
    fix: 'the child returns status=refused; the parent regenerates the handoff at the current tree (gstack-ship-budget handoff ...) or stops; main moving alone never refuses',
  },
} as const satisfies Record<string, ResultCode>;
