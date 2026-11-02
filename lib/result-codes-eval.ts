/**
 * Result codes for the /eval-plan preregistration (bin/gstack-eval-plan prereg
 * --check, the priced pilot's arm list). Kept beside lib/result-codes.ts, which
 * spreads this table into RESULT_CODES; the same rules apply: one stable
 * docs/troubleshooting.md anchor, a summary and a fix clause each. The
 * no-gstack arm rule is documented in docs/TESTING_INTERNALS.md#no-gstack-arm.
 */
import type { ResultCode } from './result-codes';

export const EVAL_RESULT_CODES = {
  PREREG_INCOMPLETE: {
    anchor: 'prereg-incomplete',
    summary: 'the preregistration file lacks a required section, a section is empty, or the Comparison or Diagnostics declaration is malformed',
    fix: 'fill every section `gstack-eval-plan prereg --check` names (bars, arms, comparison, decoys, stop rules, held-out exposure) before any priced call',
  },
  // Field list 2 (2026-10-16), W8: preregistered diagnostics run before the freeze commit.
  PREREG_DIAGNOSTIC_UNTESTED: {
    anchor: 'prereg-diagnostic-untested',
    summary: 'the declared summarizer, run on the declared synthetic fixture, did not report every preregistered diagnostic at its expected count',
    fix: 'fix the summarizer or the declared definition (expected count, fixture) until every PREREG_DIAGNOSTIC line says ok, then commit the freeze; never freeze a diagnostic the summarizer has not counted',
  },
  // Garry, 2026-10-31: "all of our head to head tests have to test no gstack from here".
  PREREG_NO_GSTACK_ARM: {
    anchor: 'prereg-no-gstack-arm',
    summary: 'the Comparison says stack: loaded and the No-gstack arm section is missing, lacks a key, or does not give every model its own <model>#no-gstack Arms line',
    fix: 'add `## No-gstack arm` with arms:, inputs:, prompt:, panel: and report:, and list each <model>#no-gstack arm under Arms; when no arm loads a skill stack, say stack: none with a why: line',
  },
  EVAL_REPORT_NO_GSTACK_ROW: {
    anchor: 'eval-report-no-gstack-row',
    summary: 'the results file has no single table with a filled row for every arm the preregistration lists, so a no-gstack row is missing or not beside its variants',
    fix: 'put one row per arm identity (each <model>#no-gstack beside its variants) in one markdown table of the results file, then rerun `gstack-eval-plan results --check`; publish no number before it says ok',
  },
  EVAL_ARM_DUPLICATE: {
    anchor: 'eval-arm-duplicate',
    summary: 'the pilot was given the same arm identity twice, so two arms would share one set of attempts',
    fix: 'give each arm its own identity, <model> or <model>#<loadout> (for example claude-opus-5-5#no-gstack beside claude-opus-5-5); nothing was reserved',
  },
} as const satisfies Record<string, ResultCode>;
