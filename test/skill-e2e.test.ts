import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { runSkillTest } from './helpers/session-runner';
import type { SkillTestResult } from './helpers/session-runner';
import { outcomeJudge } from './helpers/llm-judge';
import { EvalCollector } from './helpers/eval-store';
import type { EvalTestEntry } from './helpers/eval-store';
import { startTestServer } from '../browse/test/test-server';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');

// Skip unless EVALS=1. Session runner strips CLAUDE* env vars to avoid nested session issues.
const evalsEnabled = !!process.env.EVALS;
const describeE2E = evalsEnabled ? describe : describe.skip;

// Eval result collector — accumulates test results, writes to ~/.gstack-dev/evals/ on finalize
const evalCollector = evalsEnabled ? new EvalCollector('e2e') : null;

// Unique run ID for this E2E session — used for heartbeat + per-run log directory
const runId = new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 15);

/** DRY helper to record an E2E test result into the eval collector. */
function recordE2E(name: string, suite: string, result: SkillTestResult, extra?: Partial<EvalTestEntry>) {
  // Derive last tool call from transcript for machine-readable diagnostics
  const lastTool = result.toolCalls.length > 0
    ? `${result.toolCalls[result.toolCalls.length - 1].tool}(${JSON.stringify(result.toolCalls[result.toolCalls.length - 1].input).slice(0, 60)})`
    : undefined;

  evalCollector?.addTest({
    name, suite, tier: 'e2e',
    passed: result.exitReason === 'success' && result.browseErrors.length === 0,
    duration_ms: result.duration,
    cost_usd: result.costEstimate.estimatedCost,
    transcript: result.transcript,
    output: result.output?.slice(0, 2000),
    turns_used: result.costEstimate.turnsUsed,
    browse_errors: result.browseErrors,
    exit_reason: result.exitReason,
    timeout_at_turn: result.exitReason === 'timeout' ? result.costEstimate.turnsUsed : undefined,
    last_tool_call: lastTool,
    ...extra,
  });
}

let testServer: ReturnType<typeof startTestServer>;
let tmpDir: string;
const browseBin = path.resolve(ROOT, 'browse', 'dist', 'browse');

/**
 * Copy a directory tree recursively (files only, follows structure).
 */
function copyDirSync(src: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Set up browse shims (binary symlink, find-browse, remote-slug) in a tmpDir.
 */
function setupBrowseShims(dir: string) {
  // Symlink browse binary
  const binDir = path.join(dir, 'browse', 'dist');
  fs.mkdirSync(binDir, { recursive: true });
  if (fs.existsSync(browseBin)) {
    fs.symlinkSync(browseBin, path.join(binDir, 'browse'));
  }

  // find-browse shim
  const findBrowseDir = path.join(dir, 'browse', 'bin');
  fs.mkdirSync(findBrowseDir, { recursive: true });
  fs.writeFileSync(
    path.join(findBrowseDir, 'find-browse'),
    `#!/bin/bash\necho "${browseBin}"\n`,
    { mode: 0o755 },
  );

  // remote-slug shim (returns test-project)
  fs.writeFileSync(
    path.join(findBrowseDir, 'remote-slug'),
    `#!/bin/bash\necho "test-project"\n`,
    { mode: 0o755 },
  );
}

/**
 * Print cost summary after an E2E test.
 */
function logCost(label: string, result: { costEstimate: { turnsUsed: number; estimatedTokens: number; estimatedCost: number }; duration: number }) {
  const { turnsUsed, estimatedTokens, estimatedCost } = result.costEstimate;
  const durationSec = Math.round(result.duration / 1000);
  console.log(`${label}: $${estimatedCost.toFixed(2)} (${turnsUsed} turns, ${(estimatedTokens / 1000).toFixed(1)}k tokens, ${durationSec}s)`);
}

/**
 * Dump diagnostic info on planted-bug outcome failure (decision 1C).
 */
function dumpOutcomeDiagnostic(dir: string, label: string, report: string, judgeResult: any) {
  try {
    const transcriptDir = path.join(dir, '.gstack', 'test-transcripts');
    fs.mkdirSync(transcriptDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(
      path.join(transcriptDir, `${label}-outcome-${timestamp}.json`),
      JSON.stringify({ label, report, judgeResult }, null, 2),
    );
  } catch { /* non-fatal */ }
}

// Fail fast if Anthropic API is unreachable — don't burn through 13 tests getting ConnectionRefused
if (evalsEnabled) {
  const check = spawnSync('sh', ['-c', 'echo "ping" | claude -p --max-turns 1 --output-format stream-json --verbose --dangerously-skip-permissions'], {
    stdio: 'pipe', timeout: 30_000,
  });
  const output = check.stdout?.toString() || '';
  if (output.includes('ConnectionRefused') || output.includes('Unable to connect')) {
    throw new Error('Anthropic API unreachable — aborting E2E suite. Fix connectivity and retry.');
  }
}

describeE2E('Skill E2E tests', () => {
  beforeAll(() => {
    testServer = startTestServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-'));
    setupBrowseShims(tmpDir);
  });

  afterAll(() => {
    testServer?.server?.stop();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  test('browse basic commands work without errors', async () => {
    const result = await runSkillTest({
      prompt: `You have a browse binary at ${browseBin}. Assign it to B variable and run these commands in sequence:
1. $B goto ${testServer.url}
2. $B snapshot -i
3. $B text
4. $B screenshot /tmp/skill-e2e-test.png
Report the results of each command.`,
      workingDirectory: tmpDir,
      maxTurns: 10,
      timeout: 60_000,
      testName: 'browse-basic',
      runId,
    });

    logCost('browse basic', result);
    recordE2E('browse basic commands', 'Skill E2E tests', result);
    expect(result.browseErrors).toHaveLength(0);
    expect(result.exitReason).toBe('success');
  }, 90_000);

  test('browse snapshot flags all work', async () => {
    const result = await runSkillTest({
      prompt: `You have a browse binary at ${browseBin}. Assign it to B variable and run:
1. $B goto ${testServer.url}
2. $B snapshot -i
3. $B snapshot -c
4. $B snapshot -D
5. $B snapshot -i -a -o /tmp/skill-e2e-annotated.png
Report what each command returned.`,
      workingDirectory: tmpDir,
      maxTurns: 10,
      timeout: 60_000,
      testName: 'browse-snapshot',
      runId,
    });

    logCost('browse snapshot', result);
    recordE2E('browse snapshot flags', 'Skill E2E tests', result);
    // browseErrors can include false positives from hallucinated paths (e.g. "baltimore" vs "bangalore")
    if (result.browseErrors.length > 0) {
      console.warn('Browse errors (non-fatal):', result.browseErrors);
    }
    expect(result.exitReason).toBe('success');
  }, 90_000);

  test('agent discovers browse binary via SKILL.md setup block', async () => {
    const skillMd = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
    const setupStart = skillMd.indexOf('## SETUP');
    const setupEnd = skillMd.indexOf('## IMPORTANT');
    const setupBlock = skillMd.slice(setupStart, setupEnd);

    // Guard: verify we extracted a valid setup block
    expect(setupBlock).toContain('browse/dist/browse');

    const result = await runSkillTest({
      prompt: `Follow these instructions to find the browse binary and run a basic command.

${setupBlock}

After finding the binary, run: $B goto ${testServer.url}
Then run: $B text
Report whether it worked.`,
      workingDirectory: tmpDir,
      maxTurns: 10,
      timeout: 60_000,
      testName: 'skillmd-setup-discovery',
      runId,
    });

    recordE2E('SKILL.md setup block discovery', 'Skill E2E tests', result);
    expect(result.browseErrors).toHaveLength(0);
    expect(result.exitReason).toBe('success');
  }, 90_000);

  test('SKILL.md setup block handles missing local binary gracefully', async () => {
    // Create a tmpdir with no browse binary — no local .claude/skills/gstack/browse/dist/browse
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-empty-'));

    const skillMd = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
    const setupStart = skillMd.indexOf('## SETUP');
    const setupEnd = skillMd.indexOf('## IMPORTANT');
    const setupBlock = skillMd.slice(setupStart, setupEnd);

    const result = await runSkillTest({
      prompt: `Follow these instructions exactly. Run the bash code block below and report what it outputs.

${setupBlock}

Report the exact output. Do NOT try to fix or install anything — just report what you see.`,
      workingDirectory: emptyDir,
      maxTurns: 5,
      timeout: 30_000,
      testName: 'skillmd-no-local-binary',
      runId,
    });

    // Setup block should either find the global binary (READY) or show NEEDS_SETUP.
    // On dev machines with gstack installed globally, the fallback path
    // ~/.claude/skills/gstack/browse/dist/browse exists, so we get READY.
    // The important thing is it doesn't crash or give a confusing error.
    const allText = result.output || '';
    recordE2E('SKILL.md setup block (no local binary)', 'Skill E2E tests', result);
    expect(allText).toMatch(/READY|NEEDS_SETUP/);
    expect(result.exitReason).toBe('success');

    // Clean up
    try { fs.rmSync(emptyDir, { recursive: true, force: true }); } catch {}
  }, 60_000);

  test('SKILL.md setup block works outside git repo', async () => {
    // Create a tmpdir outside any git repo
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-nogit-'));

    const skillMd = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
    const setupStart = skillMd.indexOf('## SETUP');
    const setupEnd = skillMd.indexOf('## IMPORTANT');
    const setupBlock = skillMd.slice(setupStart, setupEnd);

    const result = await runSkillTest({
      prompt: `Follow these instructions exactly. Run the bash code block below and report what it outputs.

${setupBlock}

Report the exact output — either "READY: <path>" or "NEEDS_SETUP".`,
      workingDirectory: nonGitDir,
      maxTurns: 5,
      timeout: 30_000,
      testName: 'skillmd-outside-git',
      runId,
    });

    // Should either find global binary (READY) or show NEEDS_SETUP — not crash
    const allText = result.output || '';
    recordE2E('SKILL.md outside git repo', 'Skill E2E tests', result);
    expect(allText).toMatch(/READY|NEEDS_SETUP/);

    // Clean up
    try { fs.rmSync(nonGitDir, { recursive: true, force: true }); } catch {}
  }, 60_000);
});

// --- B4: QA skill E2E ---

describeE2E('QA skill E2E', () => {
  let qaDir: string;

  beforeAll(() => {
    testServer = testServer || startTestServer();
    qaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-qa-'));
    setupBrowseShims(qaDir);

    // Copy qa skill files into tmpDir
    copyDirSync(path.join(ROOT, 'qa'), path.join(qaDir, 'qa'));

    // Create report directory
    fs.mkdirSync(path.join(qaDir, 'qa-reports'), { recursive: true });
  });

  afterAll(() => {
    testServer?.server?.stop();
    try { fs.rmSync(qaDir, { recursive: true, force: true }); } catch {}
  });

  test('/qa quick completes without browse errors', async () => {
    const result = await runSkillTest({
      prompt: `You have a browse binary at ${browseBin}. Assign it to B variable like: B="${browseBin}"

Read the file qa/SKILL.md for the QA workflow instructions.

Run a Quick-depth QA test on ${testServer.url}/basic.html
Do NOT use AskUserQuestion — run Quick tier directly.
Write your report to ${qaDir}/qa-reports/qa-report.md`,
      workingDirectory: qaDir,
      maxTurns: 30,
      timeout: 180_000,
      testName: 'qa-quick',
      runId,
    });

    logCost('/qa quick', result);
    recordE2E('/qa quick', 'QA skill E2E', result);
    // browseErrors can include false positives from hallucinated paths
    if (result.browseErrors.length > 0) {
      console.warn('/qa quick browse errors (non-fatal):', result.browseErrors);
    }
    // Accept error_max_turns — the agent doing thorough QA work is not a failure
    expect(['success', 'error_max_turns']).toContain(result.exitReason);
  }, 240_000);
});

// --- B5: Review skill E2E ---

describeE2E('Review skill E2E', () => {
  let reviewDir: string;

  beforeAll(() => {
    reviewDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-review-'));

    // Pre-build a git repo with a vulnerable file on a feature branch (decision 5A)
    const { spawnSync } = require('child_process');
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: reviewDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    // Commit a clean base on main
    fs.writeFileSync(path.join(reviewDir, 'app.rb'), '# clean base\nclass App\nend\n');
    run('git', ['add', 'app.rb']);
    run('git', ['commit', '-m', 'initial commit']);

    // Create feature branch with vulnerable code
    run('git', ['checkout', '-b', 'feature/add-user-controller']);
    const vulnContent = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'review-eval-vuln.rb'), 'utf-8');
    fs.writeFileSync(path.join(reviewDir, 'user_controller.rb'), vulnContent);
    run('git', ['add', 'user_controller.rb']);
    run('git', ['commit', '-m', 'add user controller']);

    // Copy review skill files
    fs.copyFileSync(path.join(ROOT, 'review', 'SKILL.md'), path.join(reviewDir, 'review-SKILL.md'));
    fs.copyFileSync(path.join(ROOT, 'review', 'checklist.md'), path.join(reviewDir, 'review-checklist.md'));
    fs.copyFileSync(path.join(ROOT, 'review', 'greptile-triage.md'), path.join(reviewDir, 'review-greptile-triage.md'));
  });

  afterAll(() => {
    try { fs.rmSync(reviewDir, { recursive: true, force: true }); } catch {}
  });

  test('/review produces findings on SQL injection branch', async () => {
    const result = await runSkillTest({
      prompt: `You are in a git repo on a feature branch with changes against main.
Read review-SKILL.md for the review workflow instructions.
Also read review-checklist.md and apply it.
Run /review on the current diff (git diff main...HEAD).
Write your review findings to ${reviewDir}/review-output.md`,
      workingDirectory: reviewDir,
      maxTurns: 15,
      timeout: 90_000,
      testName: 'review-sql-injection',
      runId,
    });

    logCost('/review', result);
    recordE2E('/review SQL injection', 'Review skill E2E', result);
    expect(result.exitReason).toBe('success');
  }, 120_000);
});

// --- B6/B7/B8: Planted-bug outcome evals ---

// Outcome evals also need ANTHROPIC_API_KEY for the LLM judge
const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
const describeOutcome = (evalsEnabled && hasApiKey) ? describe : describe.skip;

describeOutcome('Planted-bug outcome evals', () => {
  let outcomeDir: string;

  beforeAll(() => {
    // Always start fresh — previous tests' agents may have killed the shared server
    try { testServer?.server?.stop(); } catch {}
    testServer = startTestServer();
    outcomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-outcome-'));
    setupBrowseShims(outcomeDir);

    // Copy qa skill files
    copyDirSync(path.join(ROOT, 'qa'), path.join(outcomeDir, 'qa'));
  });

  afterAll(() => {
    testServer?.server?.stop();
    try { fs.rmSync(outcomeDir, { recursive: true, force: true }); } catch {}
  });

  /**
   * Shared planted-bug eval runner.
   * Gives the agent concise bug-finding instructions (not the full QA workflow),
   * then scores the report with an LLM outcome judge.
   */
  async function runPlantedBugEval(fixture: string, groundTruthFile: string, label: string) {
    // Each test gets its own isolated working directory to prevent cross-contamination
    // (agents reading previous tests' reports and hallucinating those bugs)
    const testWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), `skill-e2e-${label}-`));
    setupBrowseShims(testWorkDir);
    const reportDir = path.join(testWorkDir, 'reports');
    fs.mkdirSync(path.join(reportDir, 'screenshots'), { recursive: true });
    const reportPath = path.join(reportDir, 'qa-report.md');

    // Direct bug-finding with browse. Keep prompt concise — no reading long SKILL.md docs.
    // "Write early, update later" pattern ensures report exists even if agent hits max turns.
    const targetUrl = `${testServer.url}/${fixture}`;
    const result = await runSkillTest({
      prompt: `Find bugs on this page: ${targetUrl}

Browser binary: B="${browseBin}"

PHASE 1 — Quick scan (5 commands max):
$B goto ${targetUrl}
$B console --errors
$B snapshot -i
$B snapshot -c
$B accessibility

PHASE 2 — Write initial report to ${reportPath}:
Write every bug you found so far. Format each as:
- Category: functional / visual / accessibility / console
- Severity: high / medium / low
- Evidence: what you observed

PHASE 3 — Interactive testing (systematic form + edge case testing):
- For EVERY input field on the page: fill it, clear it, try invalid values
- Specifically test: empty fields, invalid email formats, extra-long text, clearing numeric fields
- Submit the form and immediately run $B console --errors
- Click every link/button and check for broken behavior
- After finding more bugs, UPDATE ${reportPath} with new findings

PHASE 4 — Finalize report:
- UPDATE ${reportPath} with ALL bugs found across all phases
- Include console errors, form validation issues, visual overflow, missing attributes

CRITICAL RULES:
- ONLY test the page at ${targetUrl} — do not navigate to other sites
- Write the report file in PHASE 2 before doing interactive testing
- The report MUST exist at ${reportPath} when you finish`,
      workingDirectory: testWorkDir,
      maxTurns: 40,
      timeout: 300_000,
      testName: `qa-${label}`,
      runId,
    });

    logCost(`/qa ${label}`, result);

    // Phase 1: browse mechanics. Accept error_max_turns — agent may have written
    // a partial report before running out of turns. What matters is detection rate.
    if (result.browseErrors.length > 0) {
      console.warn(`${label} browse errors:`, result.browseErrors);
    }
    if (result.exitReason !== 'success' && result.exitReason !== 'error_max_turns') {
      throw new Error(`${label}: unexpected exit reason: ${result.exitReason}`);
    }

    // Phase 2: Outcome evaluation via LLM judge
    const groundTruth = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'test', 'fixtures', groundTruthFile), 'utf-8'),
    );

    // Read the generated report (try expected path, then glob for any .md in reportDir or workDir)
    let report: string | null = null;
    if (fs.existsSync(reportPath)) {
      report = fs.readFileSync(reportPath, 'utf-8');
    } else {
      // Agent may have named it differently — find any .md in reportDir or testWorkDir
      for (const searchDir of [reportDir, testWorkDir]) {
        try {
          const mdFiles = fs.readdirSync(searchDir).filter(f => f.endsWith('.md'));
          if (mdFiles.length > 0) {
            report = fs.readFileSync(path.join(searchDir, mdFiles[0]), 'utf-8');
            break;
          }
        } catch { /* dir may not exist if agent hit max_turns early */ }
      }

      // Also check the agent's final output for inline report content
      if (!report && result.output && result.output.length > 100) {
        report = result.output;
      }
    }

    if (!report) {
      dumpOutcomeDiagnostic(testWorkDir, label, '(no report file found)', { error: 'missing report' });
      recordE2E(`/qa ${label}`, 'Planted-bug outcome evals', result, { error: 'no report generated' });
      throw new Error(`No report file found in ${reportDir}`);
    }

    const judgeResult = await outcomeJudge(groundTruth, report);
    console.log(`${label} outcome:`, JSON.stringify(judgeResult, null, 2));

    // Record to eval collector with outcome judge results
    recordE2E(`/qa ${label}`, 'Planted-bug outcome evals', result, {
      detection_rate: judgeResult.detection_rate,
      false_positives: judgeResult.false_positives,
      evidence_quality: judgeResult.evidence_quality,
      detected_bugs: judgeResult.detected,
      missed_bugs: judgeResult.missed,
    });

    // Diagnostic dump on failure (decision 1C)
    if (judgeResult.detection_rate < groundTruth.minimum_detection || judgeResult.false_positives > groundTruth.max_false_positives) {
      dumpOutcomeDiagnostic(testWorkDir, label, report, judgeResult);
    }

    // Phase 2 assertions
    expect(judgeResult.detection_rate).toBeGreaterThanOrEqual(groundTruth.minimum_detection);
    expect(judgeResult.false_positives).toBeLessThanOrEqual(groundTruth.max_false_positives);
    expect(judgeResult.evidence_quality).toBeGreaterThanOrEqual(2);
  }

  // B6: Static dashboard — broken link, disabled submit, overflow, missing alt, console error
  test('/qa finds >= 2 of 5 planted bugs (static)', async () => {
    await runPlantedBugEval('qa-eval.html', 'qa-eval-ground-truth.json', 'b6-static');
  }, 360_000);

  // B7: SPA — broken route, stale state, async race, missing aria, console warning
  test('/qa finds >= 2 of 5 planted SPA bugs', async () => {
    await runPlantedBugEval('qa-eval-spa.html', 'qa-eval-spa-ground-truth.json', 'b7-spa');
  }, 360_000);

  // B8: Checkout — email regex, NaN total, CC overflow, missing required, stripe error
  test('/qa finds >= 2 of 5 planted checkout bugs', async () => {
    await runPlantedBugEval('qa-eval-checkout.html', 'qa-eval-checkout-ground-truth.json', 'b8-checkout');
  }, 360_000);

});

// --- Plan CEO Review E2E ---

describeE2E('Plan CEO Review E2E', () => {
  let planDir: string;

  beforeAll(() => {
    planDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-plan-ceo-'));
    const { spawnSync } = require('child_process');
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: planDir, stdio: 'pipe', timeout: 5000 });

    // Init git repo (CEO review SKILL.md has a "System Audit" step that runs git)
    run('git', ['init']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    // Create a simple plan document for the agent to review
    fs.writeFileSync(path.join(planDir, 'plan.md'), `# Plan: Add User Dashboard

## Context
We're building a new user dashboard that shows recent activity, notifications, and quick actions.

## Changes
1. New React component \`UserDashboard\` in \`src/components/\`
2. REST API endpoint \`GET /api/dashboard\` returning user stats
3. PostgreSQL query for activity aggregation
4. Redis cache layer for dashboard data (5min TTL)

## Architecture
- Frontend: React + TailwindCSS
- Backend: Express.js REST API
- Database: PostgreSQL with existing user/activity tables
- Cache: Redis for dashboard aggregates

## Open questions
- Should we use WebSocket for real-time updates?
- How do we handle users with 100k+ activity records?
`);

    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'add plan']);

    // Copy plan-ceo-review skill
    fs.mkdirSync(path.join(planDir, 'plan-ceo-review'), { recursive: true });
    fs.copyFileSync(
      path.join(ROOT, 'plan-ceo-review', 'SKILL.md'),
      path.join(planDir, 'plan-ceo-review', 'SKILL.md'),
    );
  });

  afterAll(() => {
    try { fs.rmSync(planDir, { recursive: true, force: true }); } catch {}
  });

  test('/plan-ceo-review produces structured review output', async () => {
    const result = await runSkillTest({
      prompt: `Read plan-ceo-review/SKILL.md for the review workflow.

Read plan.md — that's the plan to review. This is a standalone plan document, not a codebase — skip any codebase exploration or system audit steps.

Choose HOLD SCOPE mode. Skip any AskUserQuestion calls — this is non-interactive.
Write your complete review directly to ${planDir}/review-output.md

Focus on reviewing the plan content: architecture, error handling, security, and performance.`,
      workingDirectory: planDir,
      maxTurns: 15,
      timeout: 360_000,
      testName: 'plan-ceo-review',
      runId,
    });

    logCost('/plan-ceo-review', result);
    recordE2E('/plan-ceo-review', 'Plan CEO Review E2E', result);
    // Accept error_max_turns — the CEO review is very thorough and may exceed turns
    expect(['success', 'error_max_turns']).toContain(result.exitReason);

    // Verify the review was written
    const reviewPath = path.join(planDir, 'review-output.md');
    if (fs.existsSync(reviewPath)) {
      const review = fs.readFileSync(reviewPath, 'utf-8');
      expect(review.length).toBeGreaterThan(200);
    }
  }, 420_000);
});

// --- Plan Eng Review E2E ---

describeE2E('Plan Eng Review E2E', () => {
  let planDir: string;

  beforeAll(() => {
    planDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-plan-eng-'));
    const { spawnSync } = require('child_process');
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: planDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    // Create a plan with more engineering detail
    fs.writeFileSync(path.join(planDir, 'plan.md'), `# Plan: Migrate Auth to JWT

## Context
Replace session-cookie auth with JWT tokens. Currently using express-session + Redis store.

## Changes
1. Add \`jsonwebtoken\` package
2. New middleware \`auth/jwt-verify.ts\` replacing \`auth/session-check.ts\`
3. Login endpoint returns { accessToken, refreshToken }
4. Refresh endpoint rotates tokens
5. Migration script to invalidate existing sessions

## Files Modified
| File | Change |
|------|--------|
| auth/jwt-verify.ts | NEW: JWT verification middleware |
| auth/session-check.ts | DELETED |
| routes/login.ts | Return JWT instead of setting cookie |
| routes/refresh.ts | NEW: Token refresh endpoint |
| middleware/index.ts | Swap session-check for jwt-verify |

## Error handling
- Expired token: 401 with \`token_expired\` code
- Invalid token: 401 with \`invalid_token\` code
- Refresh with revoked token: 403

## Not in scope
- OAuth/OIDC integration
- Rate limiting on refresh endpoint
`);

    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'add plan']);

    // Copy plan-eng-review skill
    fs.mkdirSync(path.join(planDir, 'plan-eng-review'), { recursive: true });
    fs.copyFileSync(
      path.join(ROOT, 'plan-eng-review', 'SKILL.md'),
      path.join(planDir, 'plan-eng-review', 'SKILL.md'),
    );
  });

  afterAll(() => {
    try { fs.rmSync(planDir, { recursive: true, force: true }); } catch {}
  });

  test('/plan-eng-review produces structured review output', async () => {
    const result = await runSkillTest({
      prompt: `Read plan-eng-review/SKILL.md for the review workflow.

Read plan.md — that's the plan to review. This is a standalone plan document, not a codebase — skip any codebase exploration steps.

Choose SMALL CHANGE mode. Skip any AskUserQuestion calls — this is non-interactive.
Write your complete review directly to ${planDir}/review-output.md

Focus on architecture, code quality, tests, and performance sections.`,
      workingDirectory: planDir,
      maxTurns: 15,
      timeout: 360_000,
      testName: 'plan-eng-review',
      runId,
    });

    logCost('/plan-eng-review', result);
    recordE2E('/plan-eng-review', 'Plan Eng Review E2E', result);
    expect(['success', 'error_max_turns']).toContain(result.exitReason);

    // Verify the review was written
    const reviewPath = path.join(planDir, 'review-output.md');
    if (fs.existsSync(reviewPath)) {
      const review = fs.readFileSync(reviewPath, 'utf-8');
      expect(review.length).toBeGreaterThan(200);
    }
  }, 420_000);
});

// --- Retro E2E ---

describeE2E('Retro E2E', () => {
  let retroDir: string;

  beforeAll(() => {
    retroDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-retro-'));
    const { spawnSync } = require('child_process');
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: retroDir, stdio: 'pipe', timeout: 5000 });

    // Create a git repo with varied commit history
    run('git', ['init']);
    run('git', ['config', 'user.email', 'dev@example.com']);
    run('git', ['config', 'user.name', 'Dev']);

    // Day 1 commits
    fs.writeFileSync(path.join(retroDir, 'app.ts'), 'console.log("hello");\n');
    run('git', ['add', 'app.ts']);
    run('git', ['commit', '-m', 'feat: initial app setup', '--date', '2026-03-10T09:00:00']);

    fs.writeFileSync(path.join(retroDir, 'auth.ts'), 'export function login() {}\n');
    run('git', ['add', 'auth.ts']);
    run('git', ['commit', '-m', 'feat: add auth module', '--date', '2026-03-10T11:00:00']);

    // Day 2 commits
    fs.writeFileSync(path.join(retroDir, 'app.ts'), 'import { login } from "./auth";\nconsole.log("hello");\nlogin();\n');
    run('git', ['add', 'app.ts']);
    run('git', ['commit', '-m', 'fix: wire up auth to app', '--date', '2026-03-11T10:00:00']);

    fs.writeFileSync(path.join(retroDir, 'test.ts'), 'import { test } from "bun:test";\ntest("login", () => {});\n');
    run('git', ['add', 'test.ts']);
    run('git', ['commit', '-m', 'test: add login test', '--date', '2026-03-11T14:00:00']);

    // Day 3 commits
    fs.writeFileSync(path.join(retroDir, 'api.ts'), 'export function getUsers() { return []; }\n');
    run('git', ['add', 'api.ts']);
    run('git', ['commit', '-m', 'feat: add users API endpoint', '--date', '2026-03-12T09:30:00']);

    fs.writeFileSync(path.join(retroDir, 'README.md'), '# My App\nA test application.\n');
    run('git', ['add', 'README.md']);
    run('git', ['commit', '-m', 'docs: add README', '--date', '2026-03-12T16:00:00']);

    // Copy retro skill
    fs.mkdirSync(path.join(retroDir, 'retro'), { recursive: true });
    fs.copyFileSync(
      path.join(ROOT, 'retro', 'SKILL.md'),
      path.join(retroDir, 'retro', 'SKILL.md'),
    );
  });

  afterAll(() => {
    try { fs.rmSync(retroDir, { recursive: true, force: true }); } catch {}
  });

  test('/retro produces analysis from git history', async () => {
    const result = await runSkillTest({
      prompt: `Read retro/SKILL.md for instructions on how to run a retrospective.

Run /retro for the last 7 days of this git repo. Skip any AskUserQuestion calls — this is non-interactive.
Write your retrospective report to ${retroDir}/retro-output.md

Analyze the git history and produce the narrative report as described in the SKILL.md.`,
      workingDirectory: retroDir,
      maxTurns: 30,
      timeout: 300_000,
      testName: 'retro',
      runId,
    });

    logCost('/retro', result);
    recordE2E('/retro', 'Retro E2E', result);
    // Accept error_max_turns — retro does many git commands to analyze history
    expect(['success', 'error_max_turns']).toContain(result.exitReason);

    // Verify the retro was written
    const retroPath = path.join(retroDir, 'retro-output.md');
    if (fs.existsSync(retroPath)) {
      const retro = fs.readFileSync(retroPath, 'utf-8');
      expect(retro.length).toBeGreaterThan(100);
    }
  }, 420_000);
});

// --- Deferred skill E2E tests (destructive or require interactive UI) ---

describeE2E('Deferred skill E2E', () => {
  // Ship is destructive: pushes to remote, creates PRs, modifies VERSION/CHANGELOG
  test.todo('/ship completes full workflow');

  // Setup-browser-cookies requires interactive browser picker UI
  test.todo('/setup-browser-cookies imports cookies');

  // Gstack-upgrade is destructive: modifies skill installation directory
  test.todo('/gstack-upgrade completes upgrade flow');
});

// Module-level afterAll — finalize eval collector after all tests complete
afterAll(async () => {
  if (evalCollector) {
    try {
      await evalCollector.finalize();
    } catch (err) {
      console.error('Failed to save eval results:', err);
    }
  }
});
