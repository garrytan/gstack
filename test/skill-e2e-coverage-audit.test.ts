/**
 * Coverage-audit E2E — /review and /plan-eng-review coverage-diagram flows.
 *
 * Rehomed VERBATIM from the pre-split monolith (test/skill-e2e.test.ts,
 * deleted on this branch): the monolith's filename never matched the paid
 * glob (`test/skill-e2e-*.test.ts` — note the hyphen), so these two GATE-tier
 * tests (`review-coverage-audit`, `plan-eng-coverage-audit` in E2E_TIERS)
 * silently never executed after the v1.56 split.
 *
 * DRIFT WARNING (attribution for the first paid run after rehoming): the
 * prompts reference "Step 4.75 (Test Coverage Diagram)" in review/SKILL.md
 * and a "Test Coverage Audit" section in plan-eng-review/SKILL.md. NEITHER
 * section exists in the current generated skills — the skills drifted while
 * these tests were zombies. Test bodies are copied faithfully (no behavioral
 * edits), so a failure here indicts the ~8 releases of drift, not the move.
 * The only change vs the monolith bodies: the staged SKILL.md fixtures are
 * extracted via test/helpers/skill-fixture.ts (extractSkillBody — full
 * skill-specific body, shared preamble dropped) per CLAUDE.md
 * "E2E test fixtures: extract, don't copy".
 */

import { test, expect, beforeAll, afterAll } from 'bun:test';
import { runSkillTest } from './helpers/session-runner';
import {
  ROOT, runId,
  describeIfSelected,
  copyDirSync, logCost, recordE2E,
  createEvalCollector, finalizeEvalCollector,
} from './helpers/e2e-helpers';
import { extractSkillBody } from './helpers/skill-fixture';
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

  test('/review Step 4.75 produces coverage diagram', async () => {
    const result = await runSkillTest({
      prompt: `Read the file review/SKILL.md for the review workflow instructions.

You are on the feature/billing branch. The base branch is main.
This is a test project — there is no remote, no PR to create.

ONLY run Step 4.75 (Test Coverage Diagram) from the review workflow.
Skip all other steps (scope drift, checklist, design review, fix-first, etc.).

The source code is in ${reviewCoverageDir}/src/billing.ts.
Existing tests are in ${reviewCoverageDir}/test/billing.test.ts.

Produce the ASCII coverage diagram showing which code paths are tested and which have gaps.
Output the diagram directly.`,
      workingDirectory: reviewCoverageDir,
      maxTurns: 15,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
      timeout: 120_000,
      testName: 'review-coverage-audit',
      runId,
    });

    logCost('/review coverage audit', result);
    recordE2E(evalCollector, '/review Step 4.75 coverage audit', 'Review Coverage Audit E2E', result, {
      passed: result.exitReason === 'success',
    });

    expect(result.exitReason).toBe('success');

    // Check output contains coverage diagram elements
    const output = result.output || '';
    const outputLower = output.toLowerCase();
    const hasGap = outputLower.includes('gap') || outputLower.includes('no test');
    const hasTested = outputLower.includes('tested') || output.includes('✓') || output.includes('★');
    const hasCoverage = outputLower.includes('coverage') || outputLower.includes('paths tested');

    console.log(`Output has GAP markers: ${hasGap}`);
    console.log(`Output has TESTED markers: ${hasTested}`);
    console.log(`Output has coverage summary: ${hasCoverage}`);

    // The agent MUST produce a coverage diagram with gap and tested markers
    expect(hasGap || hasTested).toBe(true);

    // At minimum, the agent should have read the source and test files
    const readCalls = result.toolCalls.filter(tc => tc.tool === 'Read');
    expect(readCalls.length).toBeGreaterThan(0);
  }, 180_000);
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
    const result = await runSkillTest({
      prompt: `Read the file plan-eng-review/SKILL.md for the plan review workflow instructions.

You are on the feature/billing branch. The base branch is main.
This is a test project — there is no remote, no PR to create.

ONLY run the Test Coverage Audit section from the plan review workflow.
Skip all other steps (architecture, code quality, performance, etc.).

The source code is in ${planCoverageDir}/src/billing.ts.
Existing tests are in ${planCoverageDir}/test/billing.test.ts.

Produce the ASCII coverage diagram showing which code paths are tested and which have gaps.
Output the diagram directly.`,
      workingDirectory: planCoverageDir,
      maxTurns: 15,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
      timeout: 120_000,
      testName: 'plan-eng-coverage-audit',
      runId,
    });

    logCost('/plan-eng-review coverage audit', result);
    recordE2E(evalCollector, '/plan-eng-review coverage audit', 'Plan Eng Review Coverage Audit E2E', result, {
      passed: result.exitReason === 'success',
    });

    expect(result.exitReason).toBe('success');

    // Check output contains coverage diagram elements
    const output = result.output || '';
    const outputLower = output.toLowerCase();
    const hasGap = outputLower.includes('gap') || outputLower.includes('no test');
    const hasTested = outputLower.includes('tested') || output.includes('✓') || output.includes('★');
    const hasCoverage = outputLower.includes('coverage') || outputLower.includes('paths tested');

    console.log(`Output has GAP markers: ${hasGap}`);
    console.log(`Output has TESTED markers: ${hasTested}`);
    console.log(`Output has coverage summary: ${hasCoverage}`);

    // The agent MUST produce a coverage diagram with gap and tested markers
    expect(hasGap || hasTested).toBe(true);

    // At minimum, the agent should have read the source and test files
    const readCalls = result.toolCalls.filter(tc => tc.tool === 'Read');
    expect(readCalls.length).toBeGreaterThan(0);
  }, 180_000);
});

// Module-level afterAll — finalize eval collector after all tests complete
afterAll(async () => {
  await finalizeEvalCollector(evalCollector);
});
