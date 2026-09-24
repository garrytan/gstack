/**
 * AskUserQuestion format-compliance gate (gate, paid, native SDK tool capture).
 *
 * Drives the real four-mode question through AskUserQuestion, then captures its
 * exact public permission-callback fields without answering. The 12-turn/240s
 * capture keeps its original bounds. Grades remain all 7 decision-brief format
 * elements and recommendation substance >=4; capture is not workflow completion.
 */
import { test, expect } from 'bun:test';
import { CAPTURE_MS } from './helpers/eval-budgets';
import { describeE2ETier } from './helpers/e2e-gate';
import * as fs from 'node:fs';
import {
  setupPlanCeoDir,
  captureModeSelectionAuq,
  scoreAuqFormat,
  gradeAuqRecommendation,
  carvedSkill,
} from './helpers/auq-sdk-capture';

const describeE2E = describeE2ETier('gate');
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
    CAPTURE_MS,
  );
});
