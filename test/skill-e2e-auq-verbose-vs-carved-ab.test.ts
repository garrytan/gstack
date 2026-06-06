/**
 * AUQ no-degradation A/B: verbose (full-token) vs carved (slimmed) — periodic,
 * paid, SDK capture.
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
 *   - VERBOSE : the pre-carve monolith (137KB) read from git (ab66193e^).
 * Both are driven to Step 0F mode selection via the SDK $OUT_FILE capture path
 * (clean text, no TTY mangling). We score the 7 decision-brief format elements
 * and grade recommendation substance, then assert the carved version is NOT
 * WORSE than verbose. Relative parity is the bar (absolute compliance is the
 * format-compliance gate test's job).
 *
 * Expectation: carved >= verbose. At the mode-selection AUQ the carved skeleton
 * carries the same {{PREAMBLE}} format spec + Step 0 prose as verbose, with
 * strictly less unrelated review-section text in context.
 */
import { describe, test } from 'bun:test';
import * as fs from 'node:fs';
import {
  setupPlanCeoDir,
  captureModeSelectionAuq,
  scoreAuqFormat,
  carvedSkill,
  verboseSkill,
} from './helpers/auq-sdk-capture';
import { judgeRecommendation } from './helpers/llm-judge';

const shouldRun = !!process.env.EVALS && process.env.EVALS_TIER === 'periodic';
const describeE2E = shouldRun ? describe : describe.skip;
const runId = `auq-ab-${process.env.EVALS_RUN_ID ?? 'local'}`;

async function grade(label: string, dir: string) {
  const text = await captureModeSelectionAuq({ planDir: dir, testName: `auq-ab-${label}`, runId });
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
      const carved = carvedSkill();
      const carvedDir = setupPlanCeoDir({
        skillMd: carved.skillMd,
        sectionsFrom: carved.sectionsFrom,
        tmpPrefix: 'auq-ab-carved-',
      });
      const verboseDir = setupPlanCeoDir({
        skillMd: verboseSkill(),
        tmpPrefix: 'auq-ab-verbose-',
      });

      let c, v;
      try {
        c = await grade('CARVED', carvedDir);
        v = await grade('VERBOSE', verboseDir);
      } finally {
        fs.rmSync(carvedDir, { recursive: true, force: true });
        fs.rmSync(verboseDir, { recursive: true, force: true });
      }

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
    600_000,
  );
});
