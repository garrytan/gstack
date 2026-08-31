/**
 * AUQ no-degradation A/B: pre-cut vs post-cut AskUserQuestion Format — periodic,
 * paid, SDK capture.
 *
 * The AskUserQuestion Format preamble section stated several of its rules more
 * than once (the completeness rule three times, the auto-decide marker twice,
 * the tool-not-prose rule three times). The repetition cut removes the
 * duplicate statements while keeping every floor and all 14 format pins
 * (Layer 0, auq-format-always-loaded.test.ts, proves presence deterministically).
 *
 * The risk under test: repetition may be load-bearing for RUNTIME compliance —
 * a model may follow rules better because they repeat. This A/B is the gate
 * that decision rested on (approved 2026-08-25, option A: "the gate outranks
 * the approval"): identical prompt, two renders, and the post-cut AUQ must be
 * NOT WORSE than the pre-cut AUQ on format elements and recommendation
 * substance. Same harness and bar as skill-e2e-auq-verbose-vs-carved-ab.
 *
 *   - PRE  : the pre-cut plan-ceo-review/SKILL.md render, vendored at
 *            test/fixtures/auq-pre-cut-plan-ceo-review-SKILL.md (captured
 *            from branch commit 3263fffe, the last commit before the cut —
 *            vendored because that SHA is branch-local and unreachable from
 *            fresh clones after the squash-merge), with the current
 *            sections/ (the cut touched only the preamble skeleton).
 *   - POST : this worktree's render.
 */
import { test } from 'bun:test';
import { describeE2ETier } from './helpers/e2e-gate';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  setupPlanCeoDir,
  captureModeSelectionAuq,
  scoreAuqFormat,
  carvedSkill,
} from './helpers/auq-sdk-capture';
import { judgeRecommendation } from './helpers/llm-judge';

const describeE2E = describeE2ETier('periodic');
const runId = `auq-cut-ab-${process.env.EVALS_RUN_ID ?? 'local'}`;
const PRE_CUT_FIXTURE = path.join(import.meta.dir, 'fixtures', 'auq-pre-cut-plan-ceo-review-SKILL.md');

async function grade(label: string, dir: string) {
  const text = await captureModeSelectionAuq({ planDir: dir, testName: `auq-cut-ab-${label}`, runId });
  const fmt = scoreAuqFormat(text);
  // null = judge unavailable. Never coerced to 0: a transient judge failure
  // on one side must read as INCONCLUSIVE, not as a fabricated degradation
  // (POST-side failure) or a masked regression (PRE-side failure) — same
  // taxonomy as armJudge's judge_error cells.
  let substance: number | null = null;
  if (text.trim()) {
    try {
      const r = await judgeRecommendation(text);
      substance = r.reason_substance;
    } catch { /* judge unavailable — recorded as null */ }
  }
  // eslint-disable-next-line no-console
  console.log(
    `[AUQ-CUT-AB ${label}] captured=${text.length}B format=${fmt.present}/${fmt.total} ` +
      `missing=[${fmt.missing.join(',')}] substance=${substance ?? 'inconclusive'}`,
  );
  return { text, fmt, substance };
}

describeE2E('AUQ no-degradation: repetition cut (periodic)', () => {
  test(
    'post-cut AskUserQuestion Format render is not worse than pre-cut on the same prompt',
    async () => {
      const post = carvedSkill();
      const postDir = setupPlanCeoDir({
        skillMd: post.skillMd,
        sectionsFrom: post.sectionsFrom,
        tmpPrefix: 'auq-cut-ab-post-',
      });
      const preDir = setupPlanCeoDir({
        skillMd: fs.readFileSync(PRE_CUT_FIXTURE, 'utf-8'),
        sectionsFrom: post.sectionsFrom,
        tmpPrefix: 'auq-cut-ab-pre-',
      });

      let p, q;
      try {
        q = await grade('POST', postDir);
        p = await grade('PRE', preDir);
      } finally {
        fs.rmSync(postDir, { recursive: true, force: true });
        fs.rmSync(preDir, { recursive: true, force: true });
      }

      const summary = [
        `POST: format ${q.fmt.present}/${q.fmt.total}, substance ${q.substance ?? 'inconclusive'}`,
        `PRE : format ${p.fmt.present}/${p.fmt.total}, substance ${p.substance ?? 'inconclusive'}`,
      ].join('\n');

      if (!q.text.trim() || !p.text.trim()) {
        throw new Error(
          `A/B inconclusive — a side produced no AUQ capture:\n${summary}\n` +
            `--- post ---\n${q.text.slice(0, 2000)}\n--- pre ---\n${p.text.slice(0, 2000)}`,
        );
      }

      const formatRegressed = q.fmt.present < p.fmt.present;
      // Substance compares only when BOTH judge calls succeeded; a null on
      // either side logs as inconclusive and the format comparison still gates.
      const substanceComparable = q.substance !== null && p.substance !== null;
      if (!substanceComparable) {
        // eslint-disable-next-line no-console
        console.log('[AUQ-CUT-AB] substance inconclusive (judge error on at least one side) — format elements still compared.');
      }
      const substanceRegressed = substanceComparable && q.substance! < p.substance! - 1; // 1-pt judge tolerance
      if (formatRegressed || substanceRegressed) {
        throw new Error(
          `AUQ DEGRADATION from the repetition cut — the gate outranks the approval; revert the cut:\n${summary}` +
            (formatRegressed ? `\n  -> post-cut dropped: [${q.fmt.missing.join(',')}]` : '') +
            (substanceRegressed ? `\n  -> post-cut substance regressed >1 pt` : '') +
            `\n--- post AUQ ---\n${q.text}\n--- pre AUQ ---\n${p.text}`,
        );
      }

      // eslint-disable-next-line no-console
      console.log('[AUQ-CUT-AB] NO DEGRADATION:\n' + summary);
    },
    600_000,
  );
});
