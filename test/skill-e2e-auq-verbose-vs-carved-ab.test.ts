/**
 * AUQ no-degradation A/B: verbose (full-token) vs carved (slimmed) — periodic,
 * paid, native SDK tool capture.
 *
 * The keystone empirical proof behind the token-reduction work: carving
 * /plan-ceo-review into an 80KB skeleton + on-demand section did NOT degrade the
 * AskUserQuestion it shows the user. Layer 0 (auq-format-always-loaded.test.ts)
 * proves the format SPEC is present in both skeletons deterministically; this
 * proves the model still GENERATES an equal-quality question with the smaller
 * context.
 *
 * Method — identical prompt, two SKILL.md versions, compare:
 *   - CARVED  : this branch's plan-ceo-review/SKILL.md (80KB skeleton) + sections.
 *   - VERBOSE : the frozen pre-carve monolith (137KB) vendored as a fixture.
 * Both are driven to Mode Selection through the real AskUserQuestion tool.
 * Its public permission-callback fields are captured without an answer. We score the 7 decision-brief format elements
 * and grade recommendation substance, then assert the carved version is NOT
 * WORSE than verbose. Relative parity is the bar (absolute compliance is the
 * format-compliance gate test's job).
 *
 * Expectation: carved >= verbose. At the mode-selection AUQ the carved skeleton
 * carries the same {{PREAMBLE}} format spec + Step 0 prose as verbose, with
 * strictly less unrelated review-section text in context.
 */
import { test } from 'bun:test';
import { CAPTURE_LONG_MS } from './helpers/eval-budgets';
import { describeE2ETier } from './helpers/e2e-gate';
import * as fs from 'node:fs';
import {
  setupPlanCeoDir,
  captureModeSelectionAuq,
  scoreAuqFormat,
  carvedSkill,
  verboseSkill,
} from './helpers/auq-sdk-capture';
import { judgeRecommendation } from './helpers/llm-judge';

const describeE2E = describeE2ETier('periodic');
const runId = `auq-ab-${process.env.EVALS_RUN_ID ?? 'local'}`;

async function grade(label: string, dir: string, caseDeadline: number) {
  const text = await captureModeSelectionAuq({ planDir: dir, testName: `auq-ab-${label}`, runId, caseDeadline });
  const fmt = scoreAuqFormat(text);
  let substance = 0;
  let present = false;
  if (text.trim()) {
    try {
      const r = await judgeRecommendation(text);
      substance = r.reason_substance;
      present = r.present;
    } catch { /* judge unavailable */ }
  }
  // eslint-disable-next-line no-console
  console.log(
    `[AUQ-AB ${label}] captured=${text.length}B format=${fmt.present}/${fmt.total} ` +
      `missing=[${fmt.missing.join(',')}] recPresent=${present} substance=${substance}`,
  );
  return { text, fmt, substance };
}

describeE2E('AUQ no-degradation: verbose vs carved (periodic)', () => {
  test(
    'carved plan-ceo-review AUQ is not worse than verbose on the same prompt',
    async () => {
      const caseDeadline = Date.now() + CAPTURE_LONG_MS;
      const dirs: string[] = [];
      const cleanupErrors: unknown[] = [];
      let results: PromiseSettledResult<Awaited<ReturnType<typeof grade>>>[];
      try {
        results = await Promise.allSettled(['CARVED', 'VERBOSE'].map(async label => {
          const skill = label === 'CARVED' ? carvedSkill() : { skillMd: verboseSkill() };
          const dir = setupPlanCeoDir({
            ...skill,
            tmpPrefix: `auq-ab-${label.toLowerCase()}-`,
          });
          dirs.push(dir);
          return grade(label, dir, caseDeadline);
        }));
      } finally {
        for (const dir of dirs) {
          try { fs.rmSync(dir, { recursive: true, force: true }); }
          catch (error) { cleanupErrors.push(error); }
        }
      }
      const [carvedResult, verboseResult] = results;
      if (carvedResult.status === 'rejected' || verboseResult.status === 'rejected' || cleanupErrors.length > 0) {
        throw new AggregateError(
          [...results.flatMap(result => result.status === 'rejected' ? [result.reason] : []), ...cleanupErrors],
          'AUQ A/B capture or cleanup failed',
        );
      }
      const c = carvedResult.value, v = verboseResult.value;

      const summary = [
        `CARVED : format ${c.fmt.present}/${c.fmt.total}, substance ${c.substance}`,
        `VERBOSE: format ${v.fmt.present}/${v.fmt.total}, substance ${v.substance}`,
      ].join('\n');

      // Both must have actually produced a question, else the comparison is
      // vacuous — fail loud with the captures.
      if (!c.text.trim() || !v.text.trim()) {
        throw new Error(
          `A/B inconclusive — a side produced no AUQ capture:\n${summary}\n` +
            `--- carved ---\n${c.text.slice(0, 2000)}\n--- verbose ---\n${v.text.slice(0, 2000)}`,
        );
      }

      const formatRegressed = c.fmt.present < v.fmt.present;
      const substanceRegressed = c.substance < v.substance - 1; // 1-pt judge tolerance
      if (formatRegressed || substanceRegressed) {
        throw new Error(
          `AUQ DEGRADATION carving plan-ceo-review:\n${summary}` +
            (formatRegressed ? `\n  -> carved dropped: [${c.fmt.missing.join(',')}]` : '') +
            (substanceRegressed ? `\n  -> carved substance regressed >1 pt` : '') +
            `\n--- carved AUQ ---\n${c.text}\n--- verbose AUQ ---\n${v.text}`,
        );
      }

      // eslint-disable-next-line no-console
      console.log('[AUQ-AB] NO DEGRADATION:\n' + summary);
    },
    CAPTURE_LONG_MS,
  );
});
