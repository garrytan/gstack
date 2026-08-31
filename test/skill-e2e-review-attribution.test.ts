import { expect, beforeAll, afterAll } from 'bun:test';
import { JUDGE_MS, CAPTURE_MS, CAPTURE_LONG_MS } from './helpers/eval-budgets';
import { runSkillTest } from './helpers/session-runner';
import {
  ROOT, runId,
  describeIfSelected, testConcurrentIfSelected,
  logCost, recordE2E,
  createEvalCollector, finalizeEvalCollector,
} from './helpers/e2e-helpers';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const evalCollector = createEvalCollector('e2e-review-attribution');

// --- Base branch detection smoke tests ---

describeIfSelected('Base branch detection', ['review-base-branch', 'ship-base-branch'], () => {
  let baseBranchDir: string;
  const run = (cmd: string, args: string[], cwd: string) =>
    spawnSync(cmd, args, { cwd, stdio: 'pipe', timeout: 5000 });

  beforeAll(() => {
    baseBranchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-basebranch-'));
  });

  afterAll(() => {
    try { fs.rmSync(baseBranchDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('review-base-branch', async () => {
    const dir = path.join(baseBranchDir, 'review-base');
    fs.mkdirSync(dir, { recursive: true });

    // Create git repo with a feature branch off main
    run('git', ['init'], dir);
    run('git', ['config', 'user.email', 'test@test.com'], dir);
    run('git', ['config', 'user.name', 'Test'], dir);

    fs.writeFileSync(path.join(dir, 'app.rb'), '# clean base\nclass App\nend\n');
    run('git', ['add', 'app.rb'], dir);
    run('git', ['commit', '-m', 'initial commit'], dir);

    // Create feature branch with a change
    run('git', ['checkout', '-b', 'feature/test-review'], dir);
    fs.writeFileSync(path.join(dir, 'app.rb'), '# clean base\nclass App\n  def hello; "world"; end\nend\n');
    run('git', ['add', 'app.rb'], dir);
    run('git', ['commit', '-m', 'feat: add hello method'], dir);

    // Extract only Step 0 (base branch detection) + minimal review instructions
    // Full SKILL.md is ~1500 lines — copying it causes the agent to spend all turns reading
    const full = fs.readFileSync(path.join(ROOT, 'review', 'SKILL.md'), 'utf-8');
    const step0Start = full.indexOf('## Step 0: Detect platform and base branch');
    const step1Start = full.indexOf('## Step 1: Check branch');
    const step1End = full.indexOf('---', step1Start + 10);
    const extracted = full.slice(step0Start, step1End > step1Start ? step1End : step1Start + 500);
    fs.writeFileSync(path.join(dir, 'review-SKILL.md'), extracted);

    const result = await runSkillTest({
      prompt: `You are in a git repo on a feature branch with changes.
Read review-SKILL.md for the base branch detection instructions.

IMPORTANT: Follow Step 0 to detect the base branch. Since there is no remote, gh commands will fail — fall back to main.
Then run git diff against the detected base branch and write a brief review.
Write your findings to ${dir}/review-output.md`,
      workingDirectory: dir,
      maxTurns: 15,
      timeout: JUDGE_MS,
      testName: 'review-base-branch',
      runId,
    });

    logCost('/review base-branch', result);
    recordE2E(evalCollector, '/review base branch detection', 'Base branch detection', result);
    expect(result.exitReason).toBe('success');

    // Verify the review used "base branch" language (from Step 0)
    const toolOutputs = result.toolCalls.map(tc => tc.output || '').join('\n');
    const allOutput = (result.output || '') + toolOutputs;
    // The agent should have run git diff against main (the fallback)
    const usedGitDiff = result.toolCalls.some(tc => {
      if (tc.tool !== 'Bash') return false;
      const cmd = typeof tc.input === 'string' ? tc.input : tc.input?.command || JSON.stringify(tc.input);
      return cmd.includes('git diff');
    });
    expect(usedGitDiff).toBe(true);
  }, JUDGE_MS);

  testConcurrentIfSelected('ship-base-branch', async () => {
    const dir = path.join(baseBranchDir, 'ship-base');
    fs.mkdirSync(dir, { recursive: true });

    // Create git repo with feature branch
    run('git', ['init'], dir);
    run('git', ['config', 'user.email', 'test@test.com'], dir);
    run('git', ['config', 'user.name', 'Test'], dir);

    fs.writeFileSync(path.join(dir, 'app.ts'), 'console.log("v1");\n');
    run('git', ['add', 'app.ts'], dir);
    run('git', ['commit', '-m', 'initial'], dir);

    run('git', ['checkout', '-b', 'feature/ship-test'], dir);
    fs.writeFileSync(path.join(dir, 'app.ts'), 'console.log("v2");\n');
    run('git', ['add', 'app.ts'], dir);
    run('git', ['commit', '-m', 'feat: update to v2'], dir);

    // Extract only Step 0 (base branch detection) from ship/SKILL.md
    // (copying the full 1900-line file causes agent context bloat and flaky timeouts)
    const fullShipSkill = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');
    const step0Start = fullShipSkill.indexOf('## Step 0: Detect platform and base branch');
    const step0End = fullShipSkill.indexOf('## Step 1: Pre-flight');
    const shipSection = fullShipSkill.slice(step0Start, step0End > step0Start ? step0End : undefined);
    fs.writeFileSync(path.join(dir, 'ship-SKILL.md'), shipSection);

    const result = await runSkillTest({
      prompt: `Read ship-SKILL.md. It contains Step 0 (Detect base branch) from the ship workflow.

Run the base branch detection. Since there is no remote, gh commands will fail — fall back to main.

Then run git diff and git log against the detected base branch.

Write a summary to ${dir}/ship-preflight.md including:
- The detected base branch name
- The current branch name
- The diff stat against the base branch`,
      workingDirectory: dir,
      maxTurns: 18,
      timeout: CAPTURE_MS,
      testName: 'ship-base-branch',
      runId,
    });

    logCost('/ship base-branch', result);
    recordE2E(evalCollector, '/ship base branch detection', 'Base branch detection', result);
    expect(result.exitReason).toBe('success');

    // Verify preflight output was written
    const preflightPath = path.join(dir, 'ship-preflight.md');
    if (fs.existsSync(preflightPath)) {
      const content = fs.readFileSync(preflightPath, 'utf-8');
      expect(content.length).toBeGreaterThan(20);
      // Should mention the branch name
      expect(content.toLowerCase()).toMatch(/main|base/);
    }

    // Verify no destructive actions — no push, no PR creation
    // session-runner records tool inputs as OBJECTS ({command} for Bash) —
    // a typeof-string filter here matches nothing and the assertion can
    // never fail, even against a real `git push`.
    const destructiveTools = result.toolCalls.filter(tc => {
      if (tc.tool !== 'Bash') return false;
      const command = typeof tc.input === 'string'
        ? tc.input
        : ((tc.input as { command?: string })?.command ?? JSON.stringify(tc.input ?? {}));
      return command.includes('git push') || command.includes('gh pr create');
    });
    expect(destructiveTools).toHaveLength(0);
  }, CAPTURE_MS);
});

// --- Review Dashboard Via Attribution E2E ---

describeIfSelected('Review Dashboard Via Attribution', ['review-dashboard-via'], () => {
  let dashDir: string;

  beforeAll(() => {
    dashDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-dashboard-via-'));
    const run = (cmd: string, args: string[], cwd = dashDir) =>
      spawnSync(cmd, args, { cwd, stdio: 'pipe', timeout: 5000 });

    // Create git repo with feature branch
    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    fs.writeFileSync(path.join(dashDir, 'app.ts'), 'console.log("v1");\n');
    run('git', ['add', 'app.ts']);
    run('git', ['commit', '-m', 'initial']);

    run('git', ['checkout', '-b', 'feature/dashboard-test']);
    fs.writeFileSync(path.join(dashDir, 'app.ts'), 'console.log("v2");\n');
    run('git', ['add', 'app.ts']);
    run('git', ['commit', '-m', 'feat: update']);

    // Get HEAD commit for review entries
    const headResult = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: dashDir, stdio: 'pipe' });
    const commit = headResult.stdout.toString().trim();

    // Pre-populate review log with autoplan-sourced entries
    // gstack-review-read reads from ~/.gstack/projects/$SLUG/$BRANCH-reviews.jsonl
    // For the test, we'll write a mock gstack-review-read script that returns our test data
    const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const reviewData = [
      `{"skill":"plan-eng-review","timestamp":"${timestamp}","status":"clean","unresolved":0,"critical_gaps":0,"issues_found":0,"mode":"FULL_REVIEW","via":"autoplan","commit":"${commit}"}`,
      `{"skill":"plan-ceo-review","timestamp":"${timestamp}","status":"clean","unresolved":0,"critical_gaps":0,"mode":"SELECTIVE_EXPANSION","via":"autoplan","commit":"${commit}"}`,
      `{"skill":"codex-plan-review","timestamp":"${timestamp}","status":"clean","source":"codex","commit":"${commit}"}`,
    ].join('\n');

    // Write a mock gstack-review-read that returns our test data
    const mockBinDir = path.join(dashDir, '.mock-bin');
    fs.mkdirSync(mockBinDir, { recursive: true });
    fs.writeFileSync(path.join(mockBinDir, 'gstack-review-read'), [
      '#!/usr/bin/env bash',
      `echo '${reviewData.split('\n').join("'\necho '")}'`,
      'echo "---CONFIG---"',
      'echo "false"',
      'echo "---HEAD---"',
      `echo "${commit}"`,
    ].join('\n'));
    fs.chmodSync(path.join(mockBinDir, 'gstack-review-read'), 0o755);

    // Extract only the Review Readiness Dashboard section from ship/SKILL.md
    // (copying the full 1900-line file causes agent context bloat and timeouts)
    const fullSkill = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');
    const dashStart = fullSkill.indexOf('## Review Readiness Dashboard');
    const dashEnd = fullSkill.indexOf('\n---\n', dashStart);
    const dashSection = fullSkill.slice(dashStart, dashEnd > dashStart ? dashEnd : undefined);
    fs.writeFileSync(path.join(dashDir, 'ship-SKILL.md'), dashSection);
  });

  afterAll(() => {
    try { fs.rmSync(dashDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('review-dashboard-via', async () => {
    const mockBinDir = path.join(dashDir, '.mock-bin');

    const result = await runSkillTest({
      prompt: `Read ship-SKILL.md. You only need to run the Review Readiness Dashboard section.

Instead of running ~/.claude/skills/gstack/bin/gstack-review-read, run this mock: ${mockBinDir}/gstack-review-read

Parse the output and display the dashboard table. Pay attention to:
1. The "via" field in entries — show source attribution (e.g., "via /autoplan")
2. The codex-plan-review entry — it should populate the Outside Voice row
3. Since Eng Review IS clear, there should be NO gate blocking — just display the dashboard

Skip the preamble, lake intro, telemetry, and all other ship steps.
Write the dashboard output to ${dashDir}/dashboard-output.md`,
      workingDirectory: dashDir,
      maxTurns: 12,
      // 360s, third ratchet of the same contention story: 180s deterministic
      // 0-turn timeouts (PR #2472) → 300s; then PR #2593 hit 302s timeouts
      // on attempt 2 in two consecutive runs while five sibling rounds
      // passed — the queue-behind-siblings startup tax under 40-way in-shard
      // concurrency is real and marginal at 300s. Same headroom its
      // contention-class sibling (retro-base-branch) already carries. Outer
      // bun timeout below rises to 480s to keep headroom over the inner.
      timeout: 360_000,
      testName: 'review-dashboard-via',
      runId,
    });

    logCost('/ship dashboard-via', result);
    recordE2E(evalCollector, '/ship review dashboard via attribution', 'Dashboard via field', result);
    expect(result.exitReason).toBe('success');

    // Check dashboard output for via attribution
    const dashPath = path.join(dashDir, 'dashboard-output.md');
    const allOutput = [
      result.output || '',
      ...result.toolCalls.map(tc => tc.output || ''),
    ].join('\n').toLowerCase();

    // Verify via attribution appears somewhere (conversation or file)
    let dashContent = '';
    if (fs.existsSync(dashPath)) {
      dashContent = fs.readFileSync(dashPath, 'utf-8').toLowerCase();
    }
    const combined = allOutput + dashContent;

    // Should mention autoplan attribution
    expect(combined).toMatch(/autoplan/);
    // Should show eng review as CLEAR (it has a clean entry)
    expect(combined).toMatch(/clear/i);
    // Should NOT contain AskUserQuestion gate (no blocking)
    const gateQuestions = result.toolCalls.filter(tc =>
      tc.tool === 'mcp__conductor__AskUserQuestion' ||
      (tc.tool === 'AskUserQuestion')
    );
    // Ship dashboard should not gate when eng review is clear
    expect(gateQuestions).toHaveLength(0);
  }, CAPTURE_LONG_MS);
});

// Module-level afterAll — finalize eval collector after all tests complete
afterAll(async () => {
  await finalizeEvalCollector(evalCollector);
});
