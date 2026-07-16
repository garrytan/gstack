/**
 * AUQ consistency — same prompt, N runs, stable format + substance (periodic).
 *
 * The user's core anxiety: AUQ is fine one run and broken the next — sometimes
 * no ELI10, sometimes no recommendation, sometimes minimal context. A single
 * snapshot can't see drift. This drives the carved /plan-ceo-review mode-selection
 * AUQ N times via the SDK capture path (clean text, no TTY mangling) and asserts
 * the decision-brief format holds EVERY time and substance never craters.
 *
 * Pass bar:
 *   - Format: no element present in one run may be missing in another (that IS
 *     the inconsistency the user feels).
 *   - Substance: every run >= 3, spread (max-min) <= 2.
 *
 * Reports per-run scores so drift is visible even on a pass. Periodic tier
 * (N SDK runs, ~$0.50-1 each).
 */
import { describe, test } from 'bun:test';
import * as fs from 'node:fs';
import {
  setupPlanCeoDir,
  captureModeSelectionAuq,
  AUQ_FORMAT_ELEMENTS,
  carvedSkill,
} from './helpers/auq-sdk-capture';
import { judgeRecommendation } from './helpers/llm-judge';

const shouldRun = !!process.env.EVALS && process.env.EVALS_TIER === 'periodic';
const describeE2E = shouldRun ? describe : describe.skip;
const N_RUNS = Number(process.env.AUQ_CONSISTENCY_RUNS ?? '3');
const runId = `auq-consistency-${process.env.EVALS_RUN_ID ?? 'local'}`;

describeE2E('AUQ consistency across runs (periodic)', () => {
  test(
    `carved /plan-ceo-review AUQ format + substance stable across ${N_RUNS} runs`,
    async () => {
      const runs: Array<{ i: number; present: Set<string>; substance: number; empty: boolean }> = [];

      for (let i = 0; i < N_RUNS; i++) {
        const carved = carvedSkill();
        const dir = setupPlanCeoDir({
          skillMd: carved.skillMd,
          sectionsFrom: carved.sectionsFrom,
          tmpPrefix: `auq-consistency-${i}-`,
        });
        let text = '';
        try {
          text = await captureModeSelectionAuq({ planDir: dir, testName: `auq-consistency-${i}`, runId });
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
        const present = new Set(AUQ_FORMAT_ELEMENTS.filter(e => e.re.test(text)).map(e => e.field));
        let substance = 0;
        if (text.trim()) {
          try {
            substance = (await judgeRecommendation(text)).reason_substance;
          } catch { /* judge unavailable */ }
        }
        runs.push({ i, present, substance, empty: !text.trim() });
        // eslint-disable-next-line no-console
        console.log(
          `[AUQ-consistency run ${i + 1}/${N_RUNS}] present=${present.size}/${AUQ_FORMAT_ELEMENTS.length} ` +
            `missing=[${AUQ_FORMAT_ELEMENTS.filter(e => !present.has(e.field)).map(e => e.field).join(',')}] ` +
            `substance=${substance}${runs[i]?.empty ? ' (EMPTY CAPTURE)' : ''}`,
        );
      }

      const problems: string[] = [];

      const anyEmpty = runs.filter(r => r.empty).map(r => r.i + 1);
      if (anyEmpty.length > 0) problems.push(`run(s) produced no AUQ at all: ${anyEmpty.join(',')}`);

      // Inconsistency = an element present in SOME run but missing in another.
      const everPresent = new Set<string>();
      for (const r of runs) for (const f of r.present) everPresent.add(f);
      for (const f of everPresent) {
        const runsMissing = runs.filter(r => !r.present.has(f)).map(r => r.i + 1);
        if (runsMissing.length > 0) problems.push(`format element "${f}" missing in run(s) ${runsMissing.join(',')}`);
      }

      const subs = runs.map(r => r.substance);
      const minSub = Math.min(...subs);
      const maxSub = Math.max(...subs);
      if (minSub < 3) problems.push(`a run cratered: min substance ${minSub} < 3`);
      if (maxSub - minSub > 2) problems.push(`substance unstable: spread ${maxSub - minSub} > 2 (${subs.join(',')})`);

      if (problems.length > 0) {
        throw new Error(
          `AUQ inconsistency across ${N_RUNS} runs:\n` +
            problems.map(p => `  - ${p}`).join('\n') +
            `\nper-run: ` +
            runs.map(r => `[${r.i + 1}] fmt=${r.present.size}/${AUQ_FORMAT_ELEMENTS.length} sub=${r.substance}`).join(' '),
        );
      }

      // eslint-disable-next-line no-console
      console.log(
        `[AUQ-consistency] STABLE across ${N_RUNS} runs: all ${AUQ_FORMAT_ELEMENTS.length} ` +
          `format elements every run; substance ${minSub}-${maxSub}`,
      );
    },
    N_RUNS * 300_000 + 60_000,
  );
});
