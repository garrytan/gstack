/**
 * /ship test-failure ownership triage E2E.
 *
 * Rehomed VERBATIM from the pre-split monolith (test/skill-e2e.test.ts,
 * deleted on this branch): the monolith's filename never matched the paid
 * glob (`test/skill-e2e-*.test.ts` — note the hyphen), so this GATE-tier
 * test (`ship-triage` in E2E_TIERS) silently never executed after the
 * v1.56 split.
 *
 * DRIFT WARNING (attribution for the first paid run after rehoming): the
 * prompt references "Test Failure Ownership Triage (Steps T1-T4)" — no
 * such section exists in the current generated ship/SKILL.md (the skill
 * drifted while this test was a zombie). The body is copied faithfully
 * (no behavioral edits), so a failure here indicts the drift, not the
 * move. The only change vs the monolith body: the staged ship/SKILL.md is
 * extracted via test/helpers/skill-fixture.ts (extractSkillBody — full
 * skill-specific body, shared preamble dropped) per CLAUDE.md
 * "E2E test fixtures: extract, don't copy".
 */

import { test, expect, beforeAll, afterAll } from 'bun:test';
import { CAPTURE_MS } from './helpers/eval-budgets';
import { runSkillTest } from './helpers/session-runner';
import {
  ROOT, runId,
  describeIfSelected,
  copyDirSync, logCost, recordE2E,
  createEvalCollector, finalizeEvalCollector,
} from './helpers/e2e-helpers';
import { extractSkillBody } from './helpers/skill-fixture';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const evalCollector = createEvalCollector('e2e-triage');

// --- Triage E2E ---

describeIfSelected('Test Failure Triage E2E', ['ship-triage'], () => {
  let triageDir: string;

  beforeAll(() => {
    triageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-triage-'));

    // Copy ship skill files, then replace the SKILL.md with the extracted
    // skill body (extract, don't copy).
    copyDirSync(path.join(ROOT, 'ship'), path.join(triageDir, 'ship'));
    fs.writeFileSync(
      path.join(triageDir, 'ship', 'SKILL.md'),
      extractSkillBody(path.join(ROOT, 'ship')),
    );

    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: triageDir, stdio: 'pipe', timeout: 5000 });

    // Init git repo
    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    // Create a project with a pre-existing test failure on main
    fs.writeFileSync(path.join(triageDir, 'package.json'), JSON.stringify({
      name: 'triage-test-app',
      version: '1.0.0',
      scripts: { test: 'node test/run.js' },
    }, null, 2));

    fs.mkdirSync(path.join(triageDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(triageDir, 'test'), { recursive: true });

    // Source with a bug that exists on main (pre-existing)
    fs.writeFileSync(path.join(triageDir, 'src', 'math.js'), `
module.exports = {
  add: (a, b) => a + b,
  divide: (a, b) => a / b,  // BUG: no zero-division check (pre-existing)
};
`);

    // Test file that catches the pre-existing bug
    fs.writeFileSync(path.join(triageDir, 'test', 'math.test.js'), `
const { add, divide } = require('../src/math');

// This test passes
if (add(2, 3) !== 5) { console.error('FAIL: add(2,3) should be 5'); process.exit(1); }
console.log('PASS: add');

// This test FAILS — pre-existing bug (divide by zero returns Infinity, not an error)
try {
  const result = divide(10, 0);
  if (result === Infinity) { console.error('FAIL: divide(10,0) should throw, got Infinity'); process.exit(1); }
} catch(e) {
  console.log('PASS: divide zero check');
}
`);

    // Test runner — each test in a subprocess so one failure doesn't kill the other
    fs.writeFileSync(path.join(triageDir, 'test', 'run.js'), `
const { execSync } = require('child_process');
const path = require('path');
let failures = 0;
for (const f of ['math.test.js', 'string.test.js']) {
  try {
    execSync('node ' + path.join(__dirname, f), { stdio: 'inherit' });
  } catch (e) {
    failures++;
  }
}
if (failures > 0) process.exit(1);
`);

    // Commit on main with the pre-existing bug
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'initial: math utils with tests']);

    // Create feature branch
    run('git', ['checkout', '-b', 'feature/string-utils']);

    // Add new code with a new bug (in-branch)
    fs.writeFileSync(path.join(triageDir, 'src', 'string.js'), `
module.exports = {
  capitalize: (s) => s.charAt(0).toUpperCase() + s.slice(1),
  reverse: (s) => s.split('').reverse().join(''),
  truncate: (s, len) => s.substring(0, len),  // BUG: no null check (in-branch)
};
`);

    // Add test that catches the in-branch bug
    fs.writeFileSync(path.join(triageDir, 'test', 'string.test.js'), `
const { capitalize, reverse, truncate } = require('../src/string');

if (capitalize('hello') !== 'Hello') { console.error('FAIL: capitalize'); process.exit(1); }
console.log('PASS: capitalize');

if (reverse('abc') !== 'cba') { console.error('FAIL: reverse'); process.exit(1); }
console.log('PASS: reverse');

// This test FAILS — in-branch bug (null input causes TypeError)
try {
  truncate(null, 5);
  console.log('PASS: truncate null');
} catch(e) {
  console.error('FAIL: truncate(null, 5) threw: ' + e.message);
  process.exit(1);
}
`);

    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'feat: add string utilities']);
  });

  afterAll(() => {
    try { fs.rmSync(triageDir, { recursive: true, force: true }); } catch {}
  });

  test('/ship triage correctly classifies in-branch vs pre-existing failures', async () => {
    const result = await runSkillTest({
      prompt: `Read the file ship/SKILL.md for the ship workflow instructions.

You are on the feature/string-utils branch. The base branch is main.
This is a test project — there is no remote, no PR to create.

Run the tests first:
\`\`\`bash
cd ${triageDir} && node test/run.js
\`\`\`

The tests will fail. Now run ONLY the Test Failure Ownership Triage (Steps T1-T4) from the ship workflow.

For each failing test, classify it as:
- **In-branch**: caused by changes on this branch (feature/string-utils)
- **Pre-existing**: existed before this branch (present on main)

Use git diff origin/main...HEAD (or git diff main...HEAD since there's no remote) to determine which files changed on this branch.

Output your classification for each failure clearly, labeling each as "IN-BRANCH" or "PRE-EXISTING" with your reasoning.

This is a solo repo (REPO_MODE=solo). For pre-existing failures, recommend fixing now.`,
      workingDirectory: triageDir,
      maxTurns: 20,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
      timeout: CAPTURE_MS,
      testName: 'ship-triage',
      runId,
    });

    logCost('/ship triage', result);

    const output = result.output || '';
    const outputLower = output.toLowerCase();

    // The triage should identify the string/truncate failure as in-branch
    const hasInBranch = outputLower.includes('in-branch') || outputLower.includes('in branch') || outputLower.includes('introduced');
    // The triage should identify the math/divide failure as pre-existing
    const hasPreExisting = outputLower.includes('pre-existing') || outputLower.includes('pre existing') || outputLower.includes('existed before');

    console.log(`Output identifies IN-BRANCH failures: ${hasInBranch}`);
    console.log(`Output identifies PRE-EXISTING failures: ${hasPreExisting}`);

    // Check that the string/truncate bug is classified as in-branch
    const mentionsTruncate = outputLower.includes('truncate') || outputLower.includes('string');
    const mentionsDivide = outputLower.includes('divide') || outputLower.includes('math');

    console.log(`Mentions truncate/string (in-branch bug): ${mentionsTruncate}`);
    console.log(`Mentions divide/math (pre-existing bug): ${mentionsDivide}`);

    // Verify BOTH failure classes are exercised (not just detected):
    // The test runner must have actually run both test files
    const ranMathTest = output.includes('math.test') || output.includes('FAIL: divide');
    const ranStringTest = output.includes('string.test') || output.includes('FAIL: truncate');
    console.log(`Ran math test file (pre-existing failure): ${ranMathTest}`);
    console.log(`Ran string test file (in-branch failure): ${ranStringTest}`);

    recordE2E(evalCollector, '/ship triage', 'Test Failure Triage E2E', result, {
      passed: result.exitReason === 'success' && hasInBranch && hasPreExisting,
      has_in_branch_classification: hasInBranch,
      has_pre_existing_classification: hasPreExisting,
      mentions_truncate: mentionsTruncate,
      mentions_divide: mentionsDivide,
      ran_both_test_files: ranMathTest && ranStringTest,
    });

    expect(result.exitReason).toBe('success');
    // Must classify at least one failure as in-branch AND one as pre-existing
    expect(hasInBranch).toBe(true);
    expect(hasPreExisting).toBe(true);
    // Must mention the specific bugs
    expect(mentionsTruncate).toBe(true);
    expect(mentionsDivide).toBe(true);
    // Must have actually run both test files (exercises both failure classes)
    expect(ranMathTest).toBe(true);
    expect(ranStringTest).toBe(true);
  }, CAPTURE_MS);
});

// Module-level afterAll — finalize eval collector after all tests complete
afterAll(async () => {
  await finalizeEvalCollector(evalCollector);
});
