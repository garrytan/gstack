/** Current /review testing-specialist and /plan-eng-review test-review audits.
 * Both use source-extracted instructions and the same billing coverage fixture.
 * The diagram is an explicit user request for the targeted /review specialist;
 * /review no longer has the historical Step 4.75 coverage-diagram section.
 */
import { afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { JUDGE_MS, CAPTURE_MS } from './helpers/eval-budgets';
import { runSkillTest } from './helpers/session-runner';
import { ROOT, runId, describeIfSelected, testIfSelected, copyDirSync, logCost,
  createEvalCollector, finalizeEvalCollector } from './helpers/e2e-helpers';
import { extractSkillBody } from './helpers/skill-fixture';
import { createCoverageAuditFixture } from './fixtures/coverage-audit-fixture';
import type { CoverageFile } from './helpers/coverage-audit';
import { coverageAuditVerdict } from './helpers/coverage-audit-evidence';
import { runRecordedOfficeHoursAttempt, OFFICE_HOURS_BUN_GRACE_MS } from './helpers/office-hours-attempt';
import { resolveEvalModel } from '../lib/eval-model';

const evalCollector = createEvalCollector('e2e');
const CASES = [
  { id: 'review-coverage-audit', skill: 'review', suite: 'Review Coverage Audit E2E',
    instructions: `Read review/SKILL.md and review/sections/review-army.md for the current review workflow.
Apply ONLY the testing specialist checklist in review/specialists/testing.md to the supplied source and tests.
This is a targeted --testing request, even though this fixture has no branch diff.
Run that checklist directly; do not dispatch other specialists or perform fixes.` },
  { id: 'plan-eng-coverage-audit', skill: 'plan-eng-review', suite: 'Plan Eng Review Coverage Audit E2E',
    instructions: `Read plan-eng-review/SKILL.md and plan-eng-review/sections/review-sections.md.
Run ONLY section "3. Test review": codepath tracing and the ASCII coverage diagram.
For this targeted audit, treat the two supplied billing functions as the proposed codepaths.
Skip architecture, code quality, performance, test generation and all other workflow steps.` },
] as const;

for (const entry of CASES) describeIfSelected(entry.suite, [entry.id], () => {
  testIfSelected(entry.id, async () => {
    let cwd: string | undefined;
    let files: CoverageFile[] = [];
    try {
      await runRecordedOfficeHoursAttempt({
        collector: evalCollector, name: entry.id, suite: entry.suite,
        model: process.env.EVALS_MODEL ?? resolveEvalModel('capture'),
        // Keep the original 300s Bun cap and 120s runner work budget. Reuse the
        // existing helper's bounded abort/drain/record reserve inside that cap.
        budgetMs: CAPTURE_MS - OFFICE_HOURS_BUN_GRACE_MS,
        run: async signal => {
          cwd = fs.mkdtempSync(path.join(os.tmpdir(), `skill-e2e-${entry.skill}-coverage-`));
          copyDirSync(path.join(ROOT, entry.skill), path.join(cwd, entry.skill));
          fs.writeFileSync(path.join(cwd, entry.skill, 'SKILL.md'), extractSkillBody(path.join(ROOT, entry.skill)));
          createCoverageAuditFixture(cwd);
          files = ['src/billing.ts', 'test/billing.test.ts'].map(relative => {
            const file = path.join(cwd!, relative);
            // Fresh per attempt, outside the prompt. Seeing the complete file
            // with this marker proves actual tool output rather than guessing.
            fs.appendFileSync(file, `\n// coverage-read-evidence: ${randomUUID()}\n`);
            return { path: file, content: fs.readFileSync(file, 'utf8') };
          });
          return runSkillTest({
            prompt: `${entry.instructions}

You are on the feature/billing branch. The base branch is main.
This is a test project — there is no remote, no PR to create.
The source code is in ${cwd}/src/billing.ts.
Existing tests are in ${cwd}/test/billing.test.ts.

Produce the ASCII coverage diagram showing which code paths are tested and which have gaps.
Output the diagram directly, name both billing functions, and include a coverage summary.
Do not modify the supplied source or tests.`,
            workingDirectory: cwd, maxTurns: 15,
            allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
            timeout: JUDGE_MS, testName: entry.id, runId, signal,
          });
        },
        validate: result => {
          logCost(entry.id, result);
          const verdict = coverageAuditVerdict(result, { cwd: cwd!, source: files[0]!, tests: files[1]! });
          console.log('Coverage audit evidence:', JSON.stringify(verdict));
          if (!verdict.passed) throw new Error(`Coverage audit: ${verdict.failures.join('; ')}`);
        },
      });
    } finally {
      // Each configured retry owns a fresh fixture and fresh read markers.
      if (cwd) try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
    }
  }, CAPTURE_MS);
});

afterAll(async () => { await finalizeEvalCollector(evalCollector); });
