/** Coverage diagrams from the current review testing categories and Eng test-review section.
 * Native successful file delivery supplies read evidence; collector and assertions
 * share the final verdict. Historical Step4.75/Read-count failures remain history.
 */

import { test, expect, beforeAll, afterAll } from 'bun:test';
import { JUDGE_MS, CAPTURE_MS } from './helpers/eval-budgets';
import { runSkillTest } from './helpers/session-runner';
import {
  ROOT, runId,
  describeIfSelected,
  copyDirSync, logCost, recordE2E,
  createEvalCollector, finalizeEvalCollector,
} from './helpers/e2e-helpers';
import { extractSkillBody } from './helpers/skill-fixture';
import { coverageAuditVerdict } from './helpers/coverage-audit-evidence';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const evalCollector = createEvalCollector('e2e-coverage-audit');

// --- Review Coverage Audit E2E ---

describeIfSelected('Review Coverage Audit E2E', ['review-coverage-audit'], () => {
  let reviewCoverageDir: string;

  beforeAll(() => {
    reviewCoverageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-review-coverage-'));

    // Copy review skill files, then replace the SKILL.md with the extracted
    // skill body (extract, don't copy — the checklists/specialists in the
    // dir are small hand-written files and stay whole).
    copyDirSync(path.join(ROOT, 'review'), path.join(reviewCoverageDir, 'review'));
    fs.writeFileSync(
      path.join(reviewCoverageDir, 'review', 'SKILL.md'),
      extractSkillBody(path.join(ROOT, 'review')),
    );

    // Use shared fixture for billing project with coverage gaps
    const { createCoverageAuditFixture } = require('./fixtures/coverage-audit-fixture');
    createCoverageAuditFixture(reviewCoverageDir);
  });

  afterAll(() => {
    try { fs.rmSync(reviewCoverageDir, { recursive: true, force: true }); } catch {}
  });

  test('/review coverage audit produces coverage diagram', async () => {
    const files = { cwd: reviewCoverageDir,
      source: { path: path.join(reviewCoverageDir, 'src/billing.ts'), content: fs.readFileSync(path.join(reviewCoverageDir, 'src/billing.ts'), 'utf8') },
      tests: { path: path.join(reviewCoverageDir, 'test/billing.test.ts'), content: fs.readFileSync(path.join(reviewCoverageDir, 'test/billing.test.ts'), 'utf8') },
    };
    const result = await runSkillTest({
      prompt: `Read review/SKILL.md and review/specialists/testing.md for the review workflow and testing categories.

You are on the feature/billing branch. The base branch is main.
This is a test project — there is no remote, no PR to create.

ONLY audit test coverage using the testing specialist's Missing Negative-Path Tests and Coverage Gaps categories.
Skip all other steps (scope drift, checklist, design review, fix-first, etc.).

The source code is in ${reviewCoverageDir}/src/billing.ts.
Existing tests are in ${reviewCoverageDir}/test/billing.test.ts.

Produce the ASCII coverage diagram showing which code paths are tested and which have gaps.
Output the diagram directly.`,
      workingDirectory: reviewCoverageDir,
      maxTurns: 15,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
      timeout: JUDGE_MS,
      testName: 'review-coverage-audit',
      runId,
    });

    logCost('/review coverage audit', result);
    const verdict = coverageAuditVerdict(result, files);
    recordE2E(evalCollector, '/review coverage audit', 'Review Coverage Audit E2E', result, {
      passed: verdict.passed, error: verdict.failures.length ? verdict.failures.join('; ') : undefined,
    });
    console.log('Coverage audit evidence:', JSON.stringify(verdict));
    expect(verdict.failures).toEqual([]);
  }, CAPTURE_MS);
});

// --- Plan Eng Review Coverage Audit E2E ---

describeIfSelected('Plan Eng Review Coverage Audit E2E', ['plan-eng-coverage-audit'], () => {
  let planCoverageDir: string;

  beforeAll(() => {
    planCoverageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-plan-coverage-'));

    // Copy plan-eng-review skill files, then replace the SKILL.md with the
    // extracted skill body (extract, don't copy).
    copyDirSync(path.join(ROOT, 'plan-eng-review'), path.join(planCoverageDir, 'plan-eng-review'));
    fs.writeFileSync(
      path.join(planCoverageDir, 'plan-eng-review', 'SKILL.md'),
      extractSkillBody(path.join(ROOT, 'plan-eng-review')),
    );

    // Use shared fixture for billing project with coverage gaps
    const { createCoverageAuditFixture } = require('./fixtures/coverage-audit-fixture');
    createCoverageAuditFixture(planCoverageDir);
  });

  afterAll(() => {
    try { fs.rmSync(planCoverageDir, { recursive: true, force: true }); } catch {}
  });

  test('/plan-eng-review coverage audit traces plan codepaths', async () => {
    const files = { cwd: planCoverageDir,
      source: { path: path.join(planCoverageDir, 'src/billing.ts'), content: fs.readFileSync(path.join(planCoverageDir, 'src/billing.ts'), 'utf8') },
      tests: { path: path.join(planCoverageDir, 'test/billing.test.ts'), content: fs.readFileSync(path.join(planCoverageDir, 'test/billing.test.ts'), 'utf8') },
    };
    const result = await runSkillTest({
      prompt: `Read plan-eng-review/SKILL.md and plan-eng-review/sections/review-sections.md for the plan review workflow instructions.

You are on the feature/billing branch. The base branch is main.
This is a test project — there is no remote, no PR to create.

ONLY run the coverage audit and diagram steps under "3. Test review" in plan-eng-review/sections/review-sections.md.
Skip all other steps (architecture, code quality, performance, etc.).

The source code is in ${planCoverageDir}/src/billing.ts.
Existing tests are in ${planCoverageDir}/test/billing.test.ts.

Produce the ASCII coverage diagram showing which code paths are tested and which have gaps.
Output the diagram directly.`,
      workingDirectory: planCoverageDir,
      maxTurns: 15,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
      timeout: JUDGE_MS,
      testName: 'plan-eng-coverage-audit',
      runId,
    });

    logCost('/plan-eng-review coverage audit', result);
    const verdict = coverageAuditVerdict(result, files);
    recordE2E(evalCollector, '/plan-eng-review coverage audit', 'Plan Eng Review Coverage Audit E2E', result, {
      passed: verdict.passed, error: verdict.failures.length ? verdict.failures.join('; ') : undefined,
    });
    console.log('Coverage audit evidence:', JSON.stringify(verdict));
    expect(verdict.failures).toEqual([]);
  }, CAPTURE_MS);
});

// Module-level afterAll — finalize eval collector after all tests complete
afterAll(async () => {
  await finalizeEvalCollector(evalCollector);
});
