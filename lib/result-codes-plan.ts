/**
 * Result codes for the plan reviews' fact checks and task lists: the REALITY:
 * receipt check (gstack-plan-reality), the office-hours reviewer's --help probe
 * and gstack-tasks. Kept beside lib/result-codes.ts, which spreads this table
 * into RESULT_CODES; the same rules apply: one stable docs/troubleshooting.md
 * anchor, a summary and a fix clause each.
 */
import type { ResultCode } from './result-codes';

export const PLAN_RESULT_CODES = {
  OFFICE_HOURS_PROBE_REFUSED: {
    anchor: 'office-hours-probe-refused',
    summary: 'the office-hours spec reviewer asked to run `--help` for a command outside the probe allowlist',
    fix: 'leave the claim unverified and check it from source (Read or Grep in the repository); only gstack bins and the listed read-only CLIs on PATH, outside the repository, can be probed',
  },
  TASKS_SUPERSEDE_REFUSED: {
    anchor: 'tasks-supersede-refused',
    summary: 'gstack-tasks refused a task list that did not validate (a supersede --keep, or an add row), so no list was moved or written',
    fix: 'write the list with `gstack-tasks start` and one `gstack-tasks add` per task (--files a JSON array of strings), then rerun supersede with --keep naming it',
  },
  REALITY_RECEIPT_UNRESOLVED: {
    anchor: 'reality-receipt-unresolved',
    summary: 'a `REALITY:` receipt names a file the checkout does not have, or a line past its end',
    fix: 'open the cited file and cite the line that holds the evidence; when the evidence lives in another checkout, pass `--root <dir>` for it',
  },
} as const satisfies Record<string, ResultCode>;
