/**
 * Result codes for gstack-clean (lib/repo-state-clean.ts, #2627). Kept beside
 * lib/result-codes.ts (which spreads this table into RESULT_CODES) so the owner
 * module stays within the module-size ratchet; the same rules apply: one stable
 * docs/troubleshooting.md anchor, a summary and a fix clause each.
 */
import type { ResultCode } from './result-codes';

export const CLEAN_RESULT_CODES = {
  GSTACK_CLEAN_USAGE: {
    anchor: 'gstack-clean-usage',
    summary: 'an unknown flag or a bad --audit-days value; nothing was read or changed',
    fix: 'gstack-clean [--apply] [--audit-days N] [--json], where N is a whole number of days, 1 or more',
  },
  GSTACK_CLEAN_TARGET_REFUSED: {
    anchor: 'gstack-clean-target-refused',
    summary: 'the folder to clean is not a safe per-repo .gstack folder, so nothing was touched',
    fix: 'run gstack-clean inside a git checkout whose .gstack is a real folder (not a symlink) outside the gstack state root, with BROWSE_STATE_FILE unset or naming that folder\'s browse.json',
  },
  GSTACK_CLEAN_PARTIAL: {
    anchor: 'gstack-clean-partial',
    summary: 'one or more removals or cuts failed; the others finished',
    fix: 'rerunning is safe: fix the permissions on each FAILED path or wait for the program holding it, then rerun gstack-clean --apply',
  },
  GSTACK_CLEAN_INTERNAL: {
    anchor: 'gstack-clean-internal',
    summary: 'unexpected gstack-clean failure; the line names the error',
    fix: 'rerun once; if it repeats, report the printed error to the gstack maintainers',
  },
} as const satisfies Record<string, ResultCode>;
