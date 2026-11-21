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
    summary: 'the preregistration file lacks a required section, a section is empty, or the Comparison, Decisions, Scoring or Diagnostics declaration is malformed',
    fix: 'fill every section `gstack-eval-plan prereg --check` names (bars, decisions, arms, comparison, scoring, decoys, stop rules, held-out exposure) before any priced call: at least two decisions with different actions, and a judge from another model family checked against at least 40 labels at kappa 0.6 or better',
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
    summary: 'the Comparison says stack: loaded and the No-gstack arm section is missing, lacks a key (masking:, install: and audit: included), says none for a masking key, or does not give every model its own <model>#no-gstack Arms line',
    fix: 'add `## No-gstack arm` with arms:, inputs:, prompt:, panel:, report:, masking:, install: and audit:, and list each <model>#no-gstack arm under Arms; when no arm loads a skill stack, say stack: none with a why: line',
  },
  EVAL_REPORT_NO_GSTACK_ROW: {
    anchor: 'eval-report-no-gstack-row',
    summary: 'the results file has no single table with a filled row for every arm the preregistration lists, so a no-gstack row is missing or not beside its variants',
    fix: 'put one row per arm identity (each <model>#no-gstack beside its variants) in one markdown table of the results file, then rerun `gstack-eval-plan results --check`; publish no number before it says ok',
  },
  // The result checks (docs/TESTING_INTERNALS.md#result-checks).
  EVAL_JUDGE_UNCHECKED: {
    anchor: 'eval-judge-unchecked',
    summary: 'the preregistration names a model judge, and its hand labels are missing, fewer than the bar, all one class, or agree with the judge below the kappa bar',
    fix: 'label at least the preregistered number of outputs by hand (never held-out rows), write them as {"id", "human", "judge"} JSONL, and pass them with --labels; a judge below its bar is replaced or its numbers are not published',
  },
  EVAL_REPORT_UNPLANTED_ZERO: {
    anchor: 'eval-report-unplanted-zero',
    summary: 'a column of a results table reports a zero, and the preregistration never showed the counter behind it finding a planted case',
    fix: 'declare the counter under ## Diagnostics with a synthetic fixture that plants at least one case (expected 1 or more), run prereg --check --allow-repo-commands, and name the column after the diagnostic',
  },
  EVAL_REPORT_NO_ANSWER_ONLY: {
    anchor: 'eval-report-no-answer-only',
    summary: 'a results table counts failures without an answer-only column beside it, so a rise in failures cannot be compared with the grader\'s own reading',
    fix: 'add a column headed answer-only to the same table, counting failures by the grader\'s rule on the final answer alone, and report both readings',
  },
  // Eval-loop practice R112 (docs/TESTING_INTERNALS.md#eval-loop-checks): a quick look publishes no number.
  EVAL_QUICK_LOOK_NO_NUMBER: {
    anchor: 'eval-quick-look-no-number',
    summary: 'results --check was given a quick look (kind: quick look), which only opens or closes a question and publishes no number',
    fix: 'keep the quick look\'s answer as an opened or closed question; to publish a number, write a counted-run preregistration (prereg --init) and run it through the pilot',
  },
  EVAL_ARM_DUPLICATE: {
    anchor: 'eval-arm-duplicate',
    summary: 'the pilot was given the same arm identity twice, so two arms would share one set of attempts',
    fix: 'give each arm its own identity, <model> or <model>#<loadout> (for example claude-opus-5-5#no-gstack beside claude-opus-5-5); nothing was reserved',
  },
} as const satisfies Record<string, ResultCode>;
