/**
 * AskUserQuestion format-compliance gate (gate, paid, SDK capture).
 *
 * Asserts: /plan-ceo-review's first AskUserQuestion (Step 0F mode selection) is a
 * compliant decision brief — all 7 mandated format elements present, with a
 * substantive recommendation.
 *
 * Why SDK capture, not real-PTY (changed v1.59+): the prior version launched an
 * interactive `claude` PTY and grepped the rendered TUI after stripAnsi. But
 * plan-mode AUQs render as an interactive cursor picker whose cursor-positioning
 * escapes stripAnsi CANNOT faithfully flatten — verified directly: the picker
 * renders fine for a human (cursorSeen=45) but the flattened text drops `ELI10:`
 * and `(recommended)` and `parseNumberedOptions` returns 0. So the old test was
 * grading a lossy projection of the TUI, not the question's actual format, and
 * failed by construction in this environment.
 *
 * This version drives the skill via the SDK $OUT_FILE capture path (the agent
 * writes the verbatim AskUserQuestion it would have shown to a file — clean text,
 * zero rendering loss) and grades that. Same property tested (does the question
 * carry every format element), reliably, environment-independent. The rendering
 * layer is identical across skills/content, so it is not where format regressions
 * hide; the model's composed question is. Shares the engine with the periodic
 * A/B and matrix evals (test/helpers/auq-sdk-capture.ts).
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'node:fs';
import {
  setupPlanCeoDir,
  captureModeSelectionAuq,
  scoreAuqFormat,
  gradeAuqRecommendation,
  carvedSkill,
} from './helpers/auq-sdk-capture';

const shouldRun = !!process.env.EVALS && process.env.EVALS_TIER === 'gate';
const describeE2E = shouldRun ? describe : describe.skip;
const runId = `auq-format-gate-${process.env.EVALS_RUN_ID ?? 'local'}`;

describeE2E('AskUserQuestion format compliance (gate)', () => {
  test(
    "/plan-ceo-review's first AskUserQuestion is a compliant decision brief (7/7 + substance)",
    async () => {
      const carved = carvedSkill();
      const dir = setupPlanCeoDir({
        skillMd: carved.skillMd,
        sectionsFrom: carved.sectionsFrom,
        tmpPrefix: 'auq-format-gate-',
      });

      let text = '';
      try {
        text = await captureModeSelectionAuq({ planDir: dir, testName: 'auq-format-gate', runId });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }

      if (!text.trim()) {
        throw new Error('No AskUserQuestion captured — the skill never reached its mode-selection question.');
      }

      // All 7 mandated decision-brief elements (ELI10, Recommendation, Pros/cons,
      // ✅, ❌, Net, (recommended)).
      const fmt = scoreAuqFormat(text);
      if (fmt.missing.length > 0) {
        throw new Error(
          `AskUserQuestion missing ${fmt.missing.length} mandated format element(s): ` +
            `${fmt.missing.join(', ')}\n--- captured AUQ ---\n${text}`,
        );
      }

      // Mode selection is kind-differentiated → the kind-note must be present and
      // a numeric completeness score must be absent.
      expect(text).toMatch(/options differ in kind/i);

      // Recommendation must be substantive, not boilerplate.
      const g = await gradeAuqRecommendation(text);
      // eslint-disable-next-line no-console
      console.log(
        `[auq-format-gate] format=${fmt.present}/${fmt.total} substance=${g.substance} ` +
          `recPresent=${g.present} literalBecause=${g.hadLiteralBecause}`,
      );
      expect(g.present).toBe(true);
      if (g.substance < 4) {
        throw new Error(
          `Recommendation substance ${g.substance} < 4 (boilerplate/weak):\n--- captured AUQ ---\n${text}`,
        );
      }
    },
    300_000,
  );
});
