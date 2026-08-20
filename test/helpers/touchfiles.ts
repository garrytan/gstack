/**
 * Diff-based test selection for E2E and LLM-judge evals — compatibility facade.
 *
 * This module is split into three files:
 *
 *   - ./touchfiles-data.ts — the four touchfile/tier maps (E2E_TOUCHFILES,
 *     E2E_TIERS, LLM_JUDGE_TOUCHFILES, GLOBAL_TOUCHFILES), LITERALS ONLY.
 *     Map-diff selection evaluates OLD git versions of that file standalone
 *     to diff the maps across commits, so it must stay importable pure data
 *     (zero imports, zero executable logic).
 *   - ./test-selection.ts — the logic: matchGlob, detectBaseBranch,
 *     getChangedFiles, selectTests.
 *   - this facade — re-exports everything so the ~dozen existing import
 *     sites (e2e-helpers, eval-select, e2e-tier-alignment, paid-test-set,
 *     the *-e2e test files, …) keep importing from './touchfiles' unchanged.
 *
 * test/touchfiles-facade.test.ts pins the shape: the literal-only tripwire
 * on the data file, and export parity (every export of both halves is
 * re-exported here by identity).
 */

export {
  E2E_TOUCHFILES,
  E2E_TIERS,
  LLM_JUDGE_TOUCHFILES,
  GLOBAL_TOUCHFILES,
} from './touchfiles-data';

export {
  matchGlob,
  detectBaseBranch,
  getChangedFiles,
  selectTests,
  diffTouchfileMaps,
  diffTouchfileMapsCore,
  TOUCHFILES_DATA_PATH,
} from './test-selection';

export type {
  TouchfileMaps,
  MapDiffCause,
  MapDiffOutcome,
} from './test-selection';
