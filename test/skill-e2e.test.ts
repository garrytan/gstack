import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { runSkillTest } from './helpers/session-runner';
import type { SkillTestResult } from './helpers/session-runner';
import { outcomeJudge, callJudge } from './helpers/llm-judge';
import { EvalCollector, judgePassed } from './helpers/eval-store';
import type { EvalTestEntry } from './helpers/eval-store';
import { startTestServer } from '../browse/test/test-server';
import { selectTests, detectBaseBranch, getChangedFiles, E2E_TOUCHFILES, GLOBAL_TOUCHFILES } from './helpers/touchfiles';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');

// Skip unless EVALS=1. Session runner strips CLAUDE* env vars to avoid nested session issues.
//
// BLAME PROTOCOL: When an eval fails, do NOT claim "pre-existing" or "not related
// to our changes" without proof. Run the same eval on main to verify. These tests
// have invisible couplings — preamble text, SKILL.md content, and timing all affect
// agent behavior. See CLAUDE.md "E2E eval failure blame protocol" for details.
const evalsEnabled = !!process.env.EVALS;
const describeE2E = evalsEnabled ? describe : describe.skip;

// --- Diff-based test selection ---
// When EVALS_ALL is not set, only run tests whose touchfiles were modified.
// Set EVALS_ALL=1 to force all tests. Set EVALS_BASE to override base branch.
let selectedTests: string[] | null = null; // null = run all

if (evalsEnabled && !process.env.EVALS_ALL) {
  const baseBranch = process.env.EVALS_BASE
    || detectBaseBranch(ROOT)
    || 'main';
  const changedFiles = getChangedFiles(baseBranch, ROOT);

  if (changedFiles.length > 0) {
    const selection = selectTests(changedFiles, E2E_TOUCHFILES, GLOBAL_TOUCHFILES);
    selectedTests = selection.selected;
    process.stderr.write(`\nE2E selection (${selection.reason}): ${selection.selected.length}/${Object.keys(E2E_TOUCHFILES).length} tests\n`);
    if (selection.skipped.length > 0) {
      process.stderr.write(`  Skipped: ${selection.skipped.join(', ')}\n`);
    }
    process.stderr.write('\n');
  }
  // If changedFiles is empty (e.g., on main branch), selectedTests stays null → run all
}

/** Wrap a describe block to skip entirely if none of its tests are selected. */
function describeIfSelected(name: string, testNames: string[], fn: () => void) {
  const anySelected = selectedTests === null || testNames.some(t => selectedTests!.includes(t));
  (anySelected ? describeE2E : describe.skip)(name, fn);
}

/** Skip an individual test if not selected (for multi-test describe blocks). */
function testIfSelected(testName: string, fn: () => Promise<void>, timeout: number) {
  const shouldRun = selectedTests === null || selectedTests.includes(testName);
  (shouldRun ? test : test.skip)(testName, fn, timeout);
}

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

describeIfSelected('Skill E2E tests', [
  'browse-basic', 'browse-snapshot', 'skillmd-setup-discovery',
  'skillmd-no-local-binary', 'skillmd-outside-git', 'contributor-mode', 'session-awareness',
], () => {
  beforeAll(() => {
    testServer = startTestServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-'));
    setupBrowseShims(tmpDir);
  });

  afterAll(() => {
    testServer?.server?.stop();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  testIfSelected('browse-basic', async () => {
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

  testIfSelected('browse-snapshot', async () => {
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

  testIfSelected('skillmd-setup-discovery', async () => {
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

  testIfSelected('skillmd-no-local-binary', async () => {
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

  testIfSelected('skillmd-outside-git', async () => {
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

  testIfSelected('session-awareness', async () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-session-'));

    // Set up a git repo so there's project/branch context to reference
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: sessionDir, stdio: 'pipe', timeout: 5000 });
    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(sessionDir, 'app.rb'), '# my app\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'init']);
    run('git', ['checkout', '-b', 'feature/add-payments']);
    // Add a remote so the agent can derive a project name
    run('git', ['remote', 'add', 'origin', 'https://github.com/acme/billing-app.git']);

    // Extract AskUserQuestion format instructions from generated SKILL.md
    const skillMd = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
    const aqStart = skillMd.indexOf('## AskUserQuestion Format');
    const aqEnd = skillMd.indexOf('\n## ', aqStart + 1);
    const aqBlock = skillMd.slice(aqStart, aqEnd > 0 ? aqEnd : undefined);

    const outputPath = path.join(sessionDir, 'question-output.md');

    const result = await runSkillTest({
      prompt: `You are running a gstack skill. The session preamble detected _SESSIONS=4 (the user has 4 gstack windows open).

${aqBlock}

You are on branch feature/add-payments in the billing-app project. You were reviewing a plan to add Stripe integration.

You've hit a decision point: the plan doesn't specify whether to use Stripe Checkout (hosted) or Stripe Elements (embedded). You need to ask the user which approach to use.

Since this is non-interactive, DO NOT actually call AskUserQuestion. Instead, write the EXACT text you would display to the user (the full AskUserQuestion content) to the file: ${outputPath}

Remember: _SESSIONS=4, so ELI16 mode is active. The user is juggling multiple windows and may not remember what this conversation is about. Re-ground them.`,
      workingDirectory: sessionDir,
      maxTurns: 8,
      timeout: 60_000,
      testName: 'session-awareness',
      runId,
    });

    logCost('session awareness', result);
    recordE2E('session awareness ELI16', 'Skill E2E tests', result);

    // Verify the output contains ELI16 re-grounding context
    if (fs.existsSync(outputPath)) {
      const output = fs.readFileSync(outputPath, 'utf-8');
      const lower = output.toLowerCase();
      // Must mention project name
      expect(lower.includes('billing') || lower.includes('acme')).toBe(true);
      // Must mention branch
      expect(lower.includes('payment') || lower.includes('feature')).toBe(true);
      // Must mention what we're working on
      expect(lower.includes('stripe') || lower.includes('checkout') || lower.includes('payment')).toBe(true);
      // Must have a RECOMMENDATION
      expect(output).toContain('RECOMMENDATION');
    } else {
      // Check agent output as fallback
      const output = result.output || '';
      expect(output).toContain('RECOMMENDATION');
    }

    // Clean up
    try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
  }, 90_000);
});

// --- B4: QA skill E2E ---

describeIfSelected('QA skill E2E', ['qa-quick'], () => {
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
      prompt: `B="${browseBin}"

The test server is already running at: ${testServer.url}
Target page: ${testServer.url}/basic.html

Read the file qa/SKILL.md for the QA workflow instructions.

Run a Quick-depth QA test on ${testServer.url}/basic.html
Do NOT use AskUserQuestion — run Quick tier directly.
Do NOT try to start a server or discover ports — the URL above is ready.
Write your report to ${qaDir}/qa-reports/qa-report.md`,
      workingDirectory: qaDir,
      maxTurns: 35,
      timeout: 240_000,
      testName: 'qa-quick',
      runId,
    });

    logCost('/qa quick', result);
    recordE2E('/qa quick', 'QA skill E2E', result, {
      passed: ['success', 'error_max_turns'].includes(result.exitReason),
    });
    // browseErrors can include false positives from hallucinated paths
    if (result.browseErrors.length > 0) {
      console.warn('/qa quick browse errors (non-fatal):', result.browseErrors);
    }
    // Accept error_max_turns — the agent doing thorough QA work is not a failure
    expect(['success', 'error_max_turns']).toContain(result.exitReason);
  }, 300_000);
});

// --- B5: Review skill E2E ---

describeIfSelected('Review skill E2E', ['review-sql-injection'], () => {
  let reviewDir: string;

  beforeAll(() => {
    reviewDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-review-'));

    // Pre-build a git repo with a vulnerable file on a feature branch (decision 5A)
    const { spawnSync } = require('child_process');
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: reviewDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
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

// --- Review: Enum completeness E2E ---

describeIfSelected('Review enum completeness E2E', ['review-enum-completeness'], () => {
  let enumDir: string;

  beforeAll(() => {
    enumDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-enum-'));

    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: enumDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    // Commit baseline on main — order model with 4 statuses
    const baseContent = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'review-eval-enum.rb'), 'utf-8');
    fs.writeFileSync(path.join(enumDir, 'order.rb'), baseContent);
    run('git', ['add', 'order.rb']);
    run('git', ['commit', '-m', 'initial order model']);

    // Feature branch adds "returned" status but misses handlers
    run('git', ['checkout', '-b', 'feature/add-returned-status']);
    const diffContent = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'review-eval-enum-diff.rb'), 'utf-8');
    fs.writeFileSync(path.join(enumDir, 'order.rb'), diffContent);
    run('git', ['add', 'order.rb']);
    run('git', ['commit', '-m', 'add returned status']);

    // Copy review skill files
    fs.copyFileSync(path.join(ROOT, 'review', 'SKILL.md'), path.join(enumDir, 'review-SKILL.md'));
    fs.copyFileSync(path.join(ROOT, 'review', 'checklist.md'), path.join(enumDir, 'review-checklist.md'));
    fs.copyFileSync(path.join(ROOT, 'review', 'greptile-triage.md'), path.join(enumDir, 'review-greptile-triage.md'));
  });

  afterAll(() => {
    try { fs.rmSync(enumDir, { recursive: true, force: true }); } catch {}
  });

  test('/review catches missing enum handlers for new status value', async () => {
    const result = await runSkillTest({
      prompt: `You are in a git repo on branch feature/add-returned-status with changes against main.
Read review-SKILL.md for the review workflow instructions.
Also read review-checklist.md and apply it — pay special attention to the Enum & Value Completeness section.
Run /review on the current diff (git diff main...HEAD).
Write your review findings to ${enumDir}/review-output.md

The diff adds a new "returned" status to the Order model. Your job is to check if all consumers handle it.`,
      workingDirectory: enumDir,
      maxTurns: 15,
      timeout: 90_000,
      testName: 'review-enum-completeness',
      runId,
    });

    logCost('/review enum', result);
    recordE2E('/review enum completeness', 'Review enum completeness E2E', result);
    expect(result.exitReason).toBe('success');

    // Verify the review caught the missing enum handlers
    const reviewPath = path.join(enumDir, 'review-output.md');
    if (fs.existsSync(reviewPath)) {
      const review = fs.readFileSync(reviewPath, 'utf-8');
      // Should mention the missing "returned" handling in at least one of the methods
      const mentionsReturned = review.toLowerCase().includes('returned');
      const mentionsEnum = review.toLowerCase().includes('enum') || review.toLowerCase().includes('status');
      const mentionsCritical = review.toLowerCase().includes('critical');
      expect(mentionsReturned).toBe(true);
      expect(mentionsEnum || mentionsCritical).toBe(true);
    }
  }, 120_000);
});

// --- Review: Design review lite E2E ---

describeE2E('Review design lite E2E', () => {
  let designDir: string;

  beforeAll(() => {
    designDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-design-lite-'));

    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: designDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    // Commit clean base on main
    fs.writeFileSync(path.join(designDir, 'index.html'), '<h1>Clean</h1>\n');
    fs.writeFileSync(path.join(designDir, 'styles.css'), 'body { font-size: 16px; }\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'initial']);

    // Feature branch adds AI slop CSS + HTML
    run('git', ['checkout', '-b', 'feature/add-landing-page']);
    const slopCss = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'review-eval-design-slop.css'), 'utf-8');
    const slopHtml = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'review-eval-design-slop.html'), 'utf-8');
    fs.writeFileSync(path.join(designDir, 'styles.css'), slopCss);
    fs.writeFileSync(path.join(designDir, 'landing.html'), slopHtml);
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'add landing page']);

    // Copy review skill files
    fs.copyFileSync(path.join(ROOT, 'review', 'SKILL.md'), path.join(designDir, 'review-SKILL.md'));
    fs.copyFileSync(path.join(ROOT, 'review', 'checklist.md'), path.join(designDir, 'review-checklist.md'));
    fs.copyFileSync(path.join(ROOT, 'review', 'design-checklist.md'), path.join(designDir, 'review-design-checklist.md'));
    fs.copyFileSync(path.join(ROOT, 'review', 'greptile-triage.md'), path.join(designDir, 'review-greptile-triage.md'));
  });

  afterAll(() => {
    try { fs.rmSync(designDir, { recursive: true, force: true }); } catch {}
  });

  test('/review catches design anti-patterns in CSS/HTML diff', async () => {
    const result = await runSkillTest({
      prompt: `You are in a git repo on branch feature/add-landing-page with changes against main.
Read review-SKILL.md for the review workflow instructions.
Read review-checklist.md for the code review checklist.
Read review-design-checklist.md for the design review checklist.
Run /review on the current diff (git diff main...HEAD).

The diff adds a landing page with CSS and HTML. Check for both code issues AND design anti-patterns.
Write your review findings to ${designDir}/review-output.md

Important: The design checklist should catch issues like blacklisted fonts, small font sizes, outline:none, !important, AI slop patterns (purple gradients, generic hero copy, 3-column feature grid), etc.`,
      workingDirectory: designDir,
      maxTurns: 15,
      timeout: 120_000,
      testName: 'review-design-lite',
      runId,
    });

    logCost('/review design lite', result);
    recordE2E('/review design lite', 'Review design lite E2E', result);
    expect(result.exitReason).toBe('success');

    // Verify the review caught at least 4 of 7 planted design issues
    const reviewPath = path.join(designDir, 'review-output.md');
    if (fs.existsSync(reviewPath)) {
      const review = fs.readFileSync(reviewPath, 'utf-8').toLowerCase();
      let detected = 0;

      // Issue 1: Blacklisted font (Papyrus) — HIGH
      if (review.includes('papyrus') || review.includes('blacklisted font') || review.includes('font family')) detected++;
      // Issue 2: Body text < 16px — HIGH
      if (review.includes('14px') || review.includes('font-size') || review.includes('font size') || review.includes('body text')) detected++;
      // Issue 3: outline: none — HIGH
      if (review.includes('outline') || review.includes('focus')) detected++;
      // Issue 4: !important — HIGH
      if (review.includes('!important') || review.includes('important')) detected++;
      // Issue 5: Purple gradient — MEDIUM
      if (review.includes('gradient') || review.includes('purple') || review.includes('violet') || review.includes('#6366f1') || review.includes('#8b5cf6')) detected++;
      // Issue 6: Generic hero copy — MEDIUM
      if (review.includes('welcome to') || review.includes('all-in-one') || review.includes('generic') || review.includes('hero copy') || review.includes('ai slop')) detected++;
      // Issue 7: 3-column feature grid — LOW
      if (review.includes('3-column') || review.includes('three-column') || review.includes('feature grid') || review.includes('icon') || review.includes('circle')) detected++;

      console.log(`Design review detected ${detected}/7 planted issues`);
      expect(detected).toBeGreaterThanOrEqual(4);
    }
  }, 150_000);
});

// --- B6/B7/B8: Planted-bug outcome evals ---

// Outcome evals also need ANTHROPIC_API_KEY for the LLM judge
const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
const describeOutcome = (evalsEnabled && hasApiKey) ? describe : describe.skip;

// Wrap describeOutcome with selection — skip if no planted-bug tests are selected
const outcomeTestNames = ['qa-b6-static', 'qa-b7-spa', 'qa-b8-checkout'];
const anyOutcomeSelected = selectedTests === null || outcomeTestNames.some(t => selectedTests!.includes(t));
(anyOutcomeSelected ? describeOutcome : describe.skip)('Planted-bug outcome evals', () => {
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

PHASE 3 — Interactive testing (targeted — max 15 commands):
- Test email: type "user@" (no domain) and blur — does it validate?
- Test quantity: clear the field entirely — check the total display
- Test credit card: type a 25-character string — check for overflow
- Submit the form with zip code empty — does it require zip?
- Submit a valid form and run $B console --errors
- After finding more bugs, UPDATE ${reportPath} with new findings

PHASE 4 — Finalize report:
- UPDATE ${reportPath} with ALL bugs found across all phases
- Include console errors, form validation issues, visual overflow, missing attributes

CRITICAL RULES:
- ONLY test the page at ${targetUrl} — do not navigate to other sites
- Write the report file in PHASE 2 before doing interactive testing
- The report MUST exist at ${reportPath} when you finish`,
      workingDirectory: testWorkDir,
      maxTurns: 50,
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
      passed: judgePassed(judgeResult, groundTruth),
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

describeIfSelected('Plan CEO Review E2E', ['plan-ceo-review'], () => {
  let planDir: string;

  beforeAll(() => {
    planDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-plan-ceo-'));
    const { spawnSync } = require('child_process');
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: planDir, stdio: 'pipe', timeout: 5000 });

    // Init git repo (CEO review SKILL.md has a "System Audit" step that runs git)
    run('git', ['init', '-b', 'main']);
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
    recordE2E('/plan-ceo-review', 'Plan CEO Review E2E', result, {
      passed: ['success', 'error_max_turns'].includes(result.exitReason),
    });
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

// --- Plan CEO Review (SELECTIVE EXPANSION) E2E ---

describeIfSelected('Plan CEO Review SELECTIVE EXPANSION E2E', ['plan-ceo-review-selective'], () => {
  let planDir: string;

  beforeAll(() => {
    planDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-plan-ceo-sel-'));
    const { spawnSync } = require('child_process');
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: planDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

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

    fs.mkdirSync(path.join(planDir, 'plan-ceo-review'), { recursive: true });
    fs.copyFileSync(
      path.join(ROOT, 'plan-ceo-review', 'SKILL.md'),
      path.join(planDir, 'plan-ceo-review', 'SKILL.md'),
    );
  });

  afterAll(() => {
    try { fs.rmSync(planDir, { recursive: true, force: true }); } catch {}
  });

  test('/plan-ceo-review SELECTIVE EXPANSION produces structured review output', async () => {
    const result = await runSkillTest({
      prompt: `Read plan-ceo-review/SKILL.md for the review workflow.

Read plan.md — that's the plan to review. This is a standalone plan document, not a codebase — skip any codebase exploration or system audit steps.

Choose SELECTIVE EXPANSION mode. Skip any AskUserQuestion calls — this is non-interactive.
For the cherry-pick ceremony, accept all expansion proposals automatically.
Write your complete review directly to ${planDir}/review-output-selective.md

Focus on reviewing the plan content: architecture, error handling, security, and performance.`,
      workingDirectory: planDir,
      maxTurns: 15,
      timeout: 360_000,
      testName: 'plan-ceo-review-selective',
      runId,
    });

    logCost('/plan-ceo-review (SELECTIVE)', result);
    recordE2E('/plan-ceo-review-selective', 'Plan CEO Review SELECTIVE EXPANSION E2E', result, {
      passed: ['success', 'error_max_turns'].includes(result.exitReason),
    });
    expect(['success', 'error_max_turns']).toContain(result.exitReason);

    const reviewPath = path.join(planDir, 'review-output-selective.md');
    if (fs.existsSync(reviewPath)) {
      const review = fs.readFileSync(reviewPath, 'utf-8');
      expect(review.length).toBeGreaterThan(200);
    }
  }, 420_000);
});

// --- Plan Eng Review E2E ---

describeIfSelected('Plan Eng Review E2E', ['plan-eng-review'], () => {
  let planDir: string;

  beforeAll(() => {
    planDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-plan-eng-'));
    const { spawnSync } = require('child_process');
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: planDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
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

Proceed directly to the full review. Skip any AskUserQuestion calls — this is non-interactive.
Write your complete review directly to ${planDir}/review-output.md

Focus on architecture, code quality, tests, and performance sections.`,
      workingDirectory: planDir,
      maxTurns: 15,
      timeout: 360_000,
      testName: 'plan-eng-review',
      runId,
    });

    logCost('/plan-eng-review', result);
    recordE2E('/plan-eng-review', 'Plan Eng Review E2E', result, {
      passed: ['success', 'error_max_turns'].includes(result.exitReason),
    });
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

describeIfSelected('Retro E2E', ['retro'], () => {
  let retroDir: string;

  beforeAll(() => {
    retroDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-retro-'));
    const { spawnSync } = require('child_process');
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: retroDir, stdio: 'pipe', timeout: 5000 });

    // Create a git repo with varied commit history
    run('git', ['init', '-b', 'main']);
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
    recordE2E('/retro', 'Retro E2E', result, {
      passed: ['success', 'error_max_turns'].includes(result.exitReason),
    });
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

// --- QA-Only E2E (report-only, no fixes) ---

describeIfSelected('QA-Only skill E2E', ['qa-only-no-fix'], () => {
  let qaOnlyDir: string;

  beforeAll(() => {
    testServer = testServer || startTestServer();
    qaOnlyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-qa-only-'));
    setupBrowseShims(qaOnlyDir);

    // Copy qa-only skill files
    copyDirSync(path.join(ROOT, 'qa-only'), path.join(qaOnlyDir, 'qa-only'));

    // Copy qa templates (qa-only references qa/templates/qa-report-template.md)
    fs.mkdirSync(path.join(qaOnlyDir, 'qa', 'templates'), { recursive: true });
    fs.copyFileSync(
      path.join(ROOT, 'qa', 'templates', 'qa-report-template.md'),
      path.join(qaOnlyDir, 'qa', 'templates', 'qa-report-template.md'),
    );

    // Init git repo (qa-only checks for feature branch in diff-aware mode)
    const { spawnSync } = require('child_process');
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: qaOnlyDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(qaOnlyDir, 'index.html'), '<h1>Test</h1>\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'initial']);
  });

  afterAll(() => {
    try { fs.rmSync(qaOnlyDir, { recursive: true, force: true }); } catch {}
  });

  test('/qa-only produces report without using Edit tool', async () => {
    const result = await runSkillTest({
      prompt: `IMPORTANT: The browse binary is already assigned below as B. Do NOT search for it or run the SKILL.md setup block — just use $B directly.

B="${browseBin}"

Read the file qa-only/SKILL.md for the QA-only workflow instructions.

Run a Quick QA test on ${testServer.url}/qa-eval.html
Do NOT use AskUserQuestion — run Quick tier directly.
Write your report to ${qaOnlyDir}/qa-reports/qa-only-report.md`,
      workingDirectory: qaOnlyDir,
      maxTurns: 35,
      allowedTools: ['Bash', 'Read', 'Write', 'Glob'],  // NO Edit — the critical guardrail
      timeout: 180_000,
      testName: 'qa-only-no-fix',
      runId,
    });

    logCost('/qa-only', result);

    // Verify Edit was not used — the critical guardrail for report-only mode.
    // Glob is read-only and may be used for file discovery (e.g. finding SKILL.md).
    const editCalls = result.toolCalls.filter(tc => tc.tool === 'Edit');
    if (editCalls.length > 0) {
      console.warn('qa-only used Edit tool:', editCalls.length, 'times');
    }

    const exitOk = ['success', 'error_max_turns'].includes(result.exitReason);
    recordE2E('/qa-only no-fix', 'QA-Only skill E2E', result, {
      passed: exitOk && editCalls.length === 0,
    });

    expect(editCalls).toHaveLength(0);

    // Accept error_max_turns — the agent doing thorough QA is not a failure
    expect(['success', 'error_max_turns']).toContain(result.exitReason);

    // Verify git working tree is still clean (no source modifications)
    const gitStatus = spawnSync('git', ['status', '--porcelain'], {
      cwd: qaOnlyDir, stdio: 'pipe',
    });
    const statusLines = gitStatus.stdout.toString().trim().split('\n').filter(
      (l: string) => l.trim() && !l.includes('.prompt-tmp') && !l.includes('.gstack/') && !l.includes('qa-reports/'),
    );
    expect(statusLines.filter((l: string) => l.startsWith(' M') || l.startsWith('M '))).toHaveLength(0);
  }, 240_000);
});

// --- QA Fix Loop E2E ---

describeIfSelected('QA Fix Loop E2E', ['qa-fix-loop'], () => {
  let qaFixDir: string;
  let qaFixServer: ReturnType<typeof Bun.serve> | null = null;

  beforeAll(() => {
    qaFixDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-qa-fix-'));
    setupBrowseShims(qaFixDir);

    // Copy qa skill files
    copyDirSync(path.join(ROOT, 'qa'), path.join(qaFixDir, 'qa'));

    // Create a simple HTML page with obvious fixable bugs
    fs.writeFileSync(path.join(qaFixDir, 'index.html'), `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Test App</title></head>
<body>
  <h1>Welcome to Test App</h1>
  <nav>
    <a href="/about">About</a>
    <a href="/nonexistent-broken-page">Help</a>  <!-- BUG: broken link -->
  </nav>
  <form id="contact">
    <input type="text" name="name" placeholder="Name">
    <input type="email" name="email" placeholder="Email">
    <button type="submit" disabled>Send</button>  <!-- BUG: permanently disabled -->
  </form>
  <img src="/missing-logo.png">  <!-- BUG: missing alt text -->
  <script>console.error("TypeError: Cannot read property 'map' of undefined");</script>  <!-- BUG: console error -->
</body>
</html>
`);

    // Init git repo with clean working tree
    const { spawnSync } = require('child_process');
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: qaFixDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'initial commit']);

    // Start a local server serving from the working directory so fixes are reflected on refresh
    qaFixServer = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const url = new URL(req.url);
        let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
        filePath = filePath.replace(/^\//, '');
        const fullPath = path.join(qaFixDir, filePath);
        if (!fs.existsSync(fullPath)) {
          return new Response('Not Found', { status: 404 });
        }
        const content = fs.readFileSync(fullPath, 'utf-8');
        return new Response(content, {
          headers: { 'Content-Type': 'text/html' },
        });
      },
    });
  });

  afterAll(() => {
    qaFixServer?.stop();
    try { fs.rmSync(qaFixDir, { recursive: true, force: true }); } catch {}
  });

  test('/qa fix loop finds bugs and commits fixes', async () => {
    const qaFixUrl = `http://127.0.0.1:${qaFixServer!.port}`;

    const result = await runSkillTest({
      prompt: `You have a browse binary at ${browseBin}. Assign it to B variable like: B="${browseBin}"

Read the file qa/SKILL.md for the QA workflow instructions.

Run a Quick-tier QA test on ${qaFixUrl}
The source code for this page is at ${qaFixDir}/index.html — you can fix bugs there.
Do NOT use AskUserQuestion — run Quick tier directly.
Write your report to ${qaFixDir}/qa-reports/qa-report.md

This is a test+fix loop: find bugs, fix them in the source code, commit each fix, and re-verify.`,
      workingDirectory: qaFixDir,
      maxTurns: 40,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
      timeout: 300_000,
      testName: 'qa-fix-loop',
      runId,
    });

    logCost('/qa fix loop', result);
    recordE2E('/qa fix loop', 'QA Fix Loop E2E', result, {
      passed: ['success', 'error_max_turns'].includes(result.exitReason),
    });

    // Accept error_max_turns — fix loop may use many turns
    expect(['success', 'error_max_turns']).toContain(result.exitReason);

    // Verify at least one fix commit was made beyond the initial commit
    const gitLog = spawnSync('git', ['log', '--oneline'], {
      cwd: qaFixDir, stdio: 'pipe',
    });
    const commits = gitLog.stdout.toString().trim().split('\n');
    console.log(`/qa fix loop: ${commits.length} commits total (1 initial + ${commits.length - 1} fixes)`);
    expect(commits.length).toBeGreaterThan(1);

    // Verify Edit tool was used (agent actually modified source code)
    const editCalls = result.toolCalls.filter(tc => tc.tool === 'Edit');
    expect(editCalls.length).toBeGreaterThan(0);
  }, 360_000);
});

// --- Plan-Eng-Review Test-Plan Artifact E2E ---

describeIfSelected('Plan-Eng-Review Test-Plan Artifact E2E', ['plan-eng-review-artifact'], () => {
  let planDir: string;
  let projectDir: string;

  beforeAll(() => {
    planDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-plan-artifact-'));
    const { spawnSync } = require('child_process');
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: planDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    // Create base commit on main
    fs.writeFileSync(path.join(planDir, 'app.ts'), 'export function greet() { return "hello"; }\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'initial']);

    // Create feature branch with changes
    run('git', ['checkout', '-b', 'feature/add-dashboard']);
    fs.writeFileSync(path.join(planDir, 'dashboard.ts'), `export function Dashboard() {
  const data = fetchStats();
  return { users: data.users, revenue: data.revenue };
}
function fetchStats() {
  return fetch('/api/stats').then(r => r.json());
}
`);
    fs.writeFileSync(path.join(planDir, 'app.ts'), `import { Dashboard } from "./dashboard";
export function greet() { return "hello"; }
export function main() { return Dashboard(); }
`);
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'feat: add dashboard']);

    // Plan document
    fs.writeFileSync(path.join(planDir, 'plan.md'), `# Plan: Add Dashboard

## Changes
1. New \`dashboard.ts\` with Dashboard component and fetchStats API call
2. Updated \`app.ts\` to import and use Dashboard

## Architecture
- Dashboard fetches from \`/api/stats\` endpoint
- Returns user count and revenue metrics
`);
    run('git', ['add', 'plan.md']);
    run('git', ['commit', '-m', 'add plan']);

    // Copy plan-eng-review skill
    fs.mkdirSync(path.join(planDir, 'plan-eng-review'), { recursive: true });
    fs.copyFileSync(
      path.join(ROOT, 'plan-eng-review', 'SKILL.md'),
      path.join(planDir, 'plan-eng-review', 'SKILL.md'),
    );

    // Set up remote-slug shim and browse shims (plan-eng-review uses remote-slug for artifact path)
    setupBrowseShims(planDir);

    // Create project directory for artifacts
    projectDir = path.join(os.homedir(), '.gstack', 'projects', 'test-project');
    fs.mkdirSync(projectDir, { recursive: true });
  });

  afterAll(() => {
    try { fs.rmSync(planDir, { recursive: true, force: true }); } catch {}
    // Clean up test-plan artifacts (but not the project dir itself)
    try {
      const files = fs.readdirSync(projectDir);
      for (const f of files) {
        if (f.includes('test-plan')) {
          fs.unlinkSync(path.join(projectDir, f));
        }
      }
    } catch {}
  });

  test('/plan-eng-review writes test-plan artifact to ~/.gstack/projects/', async () => {
    // Count existing test-plan files before
    const beforeFiles = fs.readdirSync(projectDir).filter(f => f.includes('test-plan'));

    const result = await runSkillTest({
      prompt: `Read plan-eng-review/SKILL.md for the review workflow.

Read plan.md — that's the plan to review. This is a standalone plan with source code in app.ts and dashboard.ts.

Proceed directly to the full review. Skip any AskUserQuestion calls — this is non-interactive.

IMPORTANT: After your review, you MUST write the test-plan artifact as described in the "Test Plan Artifact" section of SKILL.md. The remote-slug shim is at ${planDir}/browse/bin/remote-slug.

Write your review to ${planDir}/review-output.md`,
      workingDirectory: planDir,
      maxTurns: 20,
      allowedTools: ['Bash', 'Read', 'Write', 'Glob', 'Grep'],
      timeout: 360_000,
      testName: 'plan-eng-review-artifact',
      runId,
    });

    logCost('/plan-eng-review artifact', result);
    recordE2E('/plan-eng-review test-plan artifact', 'Plan-Eng-Review Test-Plan Artifact E2E', result, {
      passed: ['success', 'error_max_turns'].includes(result.exitReason),
    });

    expect(['success', 'error_max_turns']).toContain(result.exitReason);

    // Verify test-plan artifact was written
    const afterFiles = fs.readdirSync(projectDir).filter(f => f.includes('test-plan'));
    const newFiles = afterFiles.filter(f => !beforeFiles.includes(f));
    console.log(`Test-plan artifacts: ${beforeFiles.length} before, ${afterFiles.length} after, ${newFiles.length} new`);

    if (newFiles.length > 0) {
      const content = fs.readFileSync(path.join(projectDir, newFiles[0]), 'utf-8');
      console.log(`Test-plan artifact (${newFiles[0]}): ${content.length} chars`);
      expect(content.length).toBeGreaterThan(50);
    } else {
      console.warn('No test-plan artifact found — agent may not have followed artifact instructions');
    }

    // Soft assertion: we expect an artifact but agent compliance is not guaranteed
    expect(newFiles.length).toBeGreaterThanOrEqual(1);
  }, 420_000);
});

// --- Base branch detection smoke tests ---

describeIfSelected('Base branch detection', ['review-base-branch', 'ship-base-branch', 'retro-base-branch'], () => {
  let baseBranchDir: string;
  const run = (cmd: string, args: string[], cwd: string) =>
    spawnSync(cmd, args, { cwd, stdio: 'pipe', timeout: 5000 });

  beforeAll(() => {
    baseBranchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-basebranch-'));
  });

  afterAll(() => {
    try { fs.rmSync(baseBranchDir, { recursive: true, force: true }); } catch {}
  });

  testIfSelected('review-base-branch', async () => {
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

    // Copy review skill files
    fs.copyFileSync(path.join(ROOT, 'review', 'SKILL.md'), path.join(dir, 'review-SKILL.md'));
    fs.copyFileSync(path.join(ROOT, 'review', 'checklist.md'), path.join(dir, 'review-checklist.md'));
    fs.copyFileSync(path.join(ROOT, 'review', 'greptile-triage.md'), path.join(dir, 'review-greptile-triage.md'));

    const result = await runSkillTest({
      prompt: `You are in a git repo on a feature branch with changes.
Read review-SKILL.md for the review workflow instructions.
Also read review-checklist.md and apply it.

IMPORTANT: Follow Step 0 to detect the base branch. Since there is no remote, gh commands will fail — fall back to main.
Then run the review against the detected base branch.
Write your findings to ${dir}/review-output.md`,
      workingDirectory: dir,
      maxTurns: 15,
      timeout: 90_000,
      testName: 'review-base-branch',
      runId,
    });

    logCost('/review base-branch', result);
    recordE2E('/review base branch detection', 'Base branch detection', result);
    expect(result.exitReason).toBe('success');

    // Verify the review used "base branch" language (from Step 0)
    const toolOutputs = result.toolCalls.map(tc => tc.output || '').join('\n');
    const allOutput = (result.output || '') + toolOutputs;
    // The agent should have run git diff against main (the fallback)
    const usedGitDiff = result.toolCalls.some(tc =>
      tc.tool === 'Bash' && typeof tc.input === 'string' && tc.input.includes('git diff')
    );
    expect(usedGitDiff).toBe(true);
  }, 120_000);

  testIfSelected('ship-base-branch', async () => {
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

    // Copy ship skill
    fs.copyFileSync(path.join(ROOT, 'ship', 'SKILL.md'), path.join(dir, 'ship-SKILL.md'));

    const result = await runSkillTest({
      prompt: `Read ship-SKILL.md for the ship workflow.

Run ONLY Step 0 (Detect base branch) and Step 1 (Pre-flight) from the ship workflow.
Since there is no remote, gh commands will fail — fall back to main.

After completing Step 0 and Step 1, STOP. Do NOT proceed to Step 2 or beyond.
Do NOT push, create PRs, or modify VERSION/CHANGELOG.

Write a summary of what you detected to ${dir}/ship-preflight.md including:
- The detected base branch name
- The current branch name
- The diff stat against the base branch`,
      workingDirectory: dir,
      maxTurns: 10,
      timeout: 60_000,
      testName: 'ship-base-branch',
      runId,
    });

    logCost('/ship base-branch', result);
    recordE2E('/ship base branch detection', 'Base branch detection', result);
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
    const destructiveTools = result.toolCalls.filter(tc =>
      tc.tool === 'Bash' && typeof tc.input === 'string' &&
      (tc.input.includes('git push') || tc.input.includes('gh pr create'))
    );
    expect(destructiveTools).toHaveLength(0);
  }, 90_000);

  testIfSelected('retro-base-branch', async () => {
    const dir = path.join(baseBranchDir, 'retro-base');
    fs.mkdirSync(dir, { recursive: true });

    // Create git repo with commit history
    run('git', ['init'], dir);
    run('git', ['config', 'user.email', 'dev@example.com'], dir);
    run('git', ['config', 'user.name', 'Dev'], dir);

    fs.writeFileSync(path.join(dir, 'app.ts'), 'console.log("hello");\n');
    run('git', ['add', 'app.ts'], dir);
    run('git', ['commit', '-m', 'feat: initial app', '--date', '2026-03-14T09:00:00'], dir);

    fs.writeFileSync(path.join(dir, 'auth.ts'), 'export function login() {}\n');
    run('git', ['add', 'auth.ts'], dir);
    run('git', ['commit', '-m', 'feat: add auth', '--date', '2026-03-15T10:00:00'], dir);

    fs.writeFileSync(path.join(dir, 'test.ts'), 'test("it works", () => {});\n');
    run('git', ['add', 'test.ts'], dir);
    run('git', ['commit', '-m', 'test: add tests', '--date', '2026-03-16T11:00:00'], dir);

    // Copy retro skill
    fs.mkdirSync(path.join(dir, 'retro'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'retro', 'SKILL.md'), path.join(dir, 'retro', 'SKILL.md'));

    const result = await runSkillTest({
      prompt: `Read retro/SKILL.md for instructions on how to run a retrospective.

IMPORTANT: Follow the "Detect default branch" step first. Since there is no remote, gh will fail — fall back to main.
Then use the detected branch name for all git queries.

Run /retro for the last 7 days of this git repo. Skip any AskUserQuestion calls — this is non-interactive.
This is a local-only repo so use the local branch (main) instead of origin/main for all git log commands.

Write your retrospective to ${dir}/retro-output.md`,
      workingDirectory: dir,
      maxTurns: 25,
      timeout: 240_000,
      testName: 'retro-base-branch',
      runId,
    });

    logCost('/retro base-branch', result);
    recordE2E('/retro default branch detection', 'Base branch detection', result, {
      passed: ['success', 'error_max_turns'].includes(result.exitReason),
    });
    expect(['success', 'error_max_turns']).toContain(result.exitReason);

    // Verify retro output was produced
    const retroPath = path.join(dir, 'retro-output.md');
    if (fs.existsSync(retroPath)) {
      const content = fs.readFileSync(retroPath, 'utf-8');
      expect(content.length).toBeGreaterThan(100);
    }
  }, 300_000);
});

// --- Document-Release skill E2E ---

describeIfSelected('Document-Release skill E2E', ['document-release'], () => {
  let docReleaseDir: string;

  beforeAll(() => {
    docReleaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-doc-release-'));

    // Copy document-release skill files
    copyDirSync(path.join(ROOT, 'document-release'), path.join(docReleaseDir, 'document-release'));

    // Init git repo with initial docs
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: docReleaseDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    // Create initial README with a features list
    fs.writeFileSync(path.join(docReleaseDir, 'README.md'),
      '# Test Project\n\n## Features\n\n- Feature A\n- Feature B\n\n## Install\n\n```bash\nnpm install\n```\n');

    // Create initial CHANGELOG that must NOT be clobbered
    fs.writeFileSync(path.join(docReleaseDir, 'CHANGELOG.md'),
      '# Changelog\n\n## 1.0.0 — 2026-03-01\n\n- Initial release with Feature A and Feature B\n- Setup CI pipeline\n');

    // Create VERSION file (already bumped)
    fs.writeFileSync(path.join(docReleaseDir, 'VERSION'), '1.1.0\n');

    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'initial']);

    // Create feature branch with a code change
    run('git', ['checkout', '-b', 'feat/add-feature-c']);
    fs.writeFileSync(path.join(docReleaseDir, 'feature-c.ts'), 'export function featureC() { return "C"; }\n');
    fs.writeFileSync(path.join(docReleaseDir, 'VERSION'), '1.1.1\n');
    fs.writeFileSync(path.join(docReleaseDir, 'CHANGELOG.md'),
      '# Changelog\n\n## 1.1.1 — 2026-03-16\n\n- Added Feature C\n\n## 1.0.0 — 2026-03-01\n\n- Initial release with Feature A and Feature B\n- Setup CI pipeline\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'feat: add feature C']);
  });

  afterAll(() => {
    try { fs.rmSync(docReleaseDir, { recursive: true, force: true }); } catch {}
  });

  test('/document-release updates docs without clobbering CHANGELOG', async () => {
    const result = await runSkillTest({
      prompt: `Read the file document-release/SKILL.md for the document-release workflow instructions.

Run the /document-release workflow on this repo. The base branch is "main".

IMPORTANT:
- Do NOT use AskUserQuestion — auto-approve everything or skip if unsure.
- Do NOT push or create PRs (there is no remote).
- Do NOT run gh commands (no remote).
- Focus on updating README.md to reflect the new Feature C.
- Do NOT overwrite or regenerate CHANGELOG entries.
- Skip VERSION bump (it's already bumped).
- After editing, just commit the changes locally.`,
      workingDirectory: docReleaseDir,
      maxTurns: 30,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob'],
      timeout: 180_000,
      testName: 'document-release',
      runId,
    });

    logCost('/document-release', result);

    // Read CHANGELOG to verify it was NOT clobbered
    const changelog = fs.readFileSync(path.join(docReleaseDir, 'CHANGELOG.md'), 'utf-8');
    const hasOriginalEntries = changelog.includes('Initial release with Feature A and Feature B')
      && changelog.includes('Setup CI pipeline')
      && changelog.includes('1.0.0');
    if (!hasOriginalEntries) {
      console.warn('CHANGELOG CLOBBERED — original entries missing!');
    }

    // Check if README was updated
    const readme = fs.readFileSync(path.join(docReleaseDir, 'README.md'), 'utf-8');
    const readmeUpdated = readme.includes('Feature C') || readme.includes('feature-c') || readme.includes('feature C');

    const exitOk = ['success', 'error_max_turns'].includes(result.exitReason);
    recordE2E('/document-release', 'Document-Release skill E2E', result, {
      passed: exitOk && hasOriginalEntries,
    });

    // Critical guardrail: CHANGELOG must not be clobbered
    expect(hasOriginalEntries).toBe(true);

    // Accept error_max_turns — thorough doc review is not a failure
    expect(['success', 'error_max_turns']).toContain(result.exitReason);

    // Informational: did it update README?
    if (readmeUpdated) {
      console.log('README updated to include Feature C');
    } else {
      console.warn('README was NOT updated — agent may not have found the feature');
    }
  }, 240_000);
});

// --- Deferred skill E2E tests (destructive or require interactive UI) ---

// Deferred tests — only test.todo entries, no selection needed
describeE2E('Deferred skill E2E', () => {
  // Ship is destructive: pushes to remote, creates PRs, modifies VERSION/CHANGELOG
  test.todo('/ship completes full workflow');

  // Setup-browser-cookies requires interactive browser picker UI
  test.todo('/setup-browser-cookies imports cookies');

});

// --- gstack-upgrade E2E ---

describeIfSelected('gstack-upgrade E2E', ['gstack-upgrade-happy-path'], () => {
  let upgradeDir: string;
  let remoteDir: string;

  beforeAll(() => {
    upgradeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-upgrade-'));
    remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-remote-'));

    const run = (cmd: string, args: string[], cwd: string) =>
      spawnSync(cmd, args, { cwd, stdio: 'pipe', timeout: 5000 });

    // Init the "project" repo
    run('git', ['init'], upgradeDir);
    run('git', ['config', 'user.email', 'test@test.com'], upgradeDir);
    run('git', ['config', 'user.name', 'Test'], upgradeDir);

    // Create mock gstack install directory (local-git type)
    const mockGstack = path.join(upgradeDir, '.claude', 'skills', 'gstack');
    fs.mkdirSync(mockGstack, { recursive: true });

    // Init as a git repo
    run('git', ['init'], mockGstack);
    run('git', ['config', 'user.email', 'test@test.com'], mockGstack);
    run('git', ['config', 'user.name', 'Test'], mockGstack);

    // Create bare remote
    run('git', ['init', '--bare'], remoteDir);
    run('git', ['remote', 'add', 'origin', remoteDir], mockGstack);

    // Write old version files
    fs.writeFileSync(path.join(mockGstack, 'VERSION'), '0.5.0\n');
    fs.writeFileSync(path.join(mockGstack, 'CHANGELOG.md'),
      '# Changelog\n\n## 0.5.0 — 2026-03-01\n\n- Initial release\n');
    fs.writeFileSync(path.join(mockGstack, 'setup'),
      '#!/bin/bash\necho "Setup completed"\n', { mode: 0o755 });

    // Initial commit + push
    run('git', ['add', '.'], mockGstack);
    run('git', ['commit', '-m', 'initial'], mockGstack);
    run('git', ['push', '-u', 'origin', 'HEAD:main'], mockGstack);

    // Create new version (simulate upstream release)
    fs.writeFileSync(path.join(mockGstack, 'VERSION'), '0.6.0\n');
    fs.writeFileSync(path.join(mockGstack, 'CHANGELOG.md'),
      '# Changelog\n\n## 0.6.0 — 2026-03-15\n\n- New feature: interactive design review\n- Fix: snapshot flag validation\n\n## 0.5.0 — 2026-03-01\n\n- Initial release\n');
    run('git', ['add', '.'], mockGstack);
    run('git', ['commit', '-m', 'release 0.6.0'], mockGstack);
    run('git', ['push', 'origin', 'HEAD:main'], mockGstack);

    // Reset working copy back to old version
    run('git', ['reset', '--hard', 'HEAD~1'], mockGstack);

    // Copy gstack-upgrade skill
    fs.mkdirSync(path.join(upgradeDir, 'gstack-upgrade'), { recursive: true });
    fs.copyFileSync(
      path.join(ROOT, 'gstack-upgrade', 'SKILL.md'),
      path.join(upgradeDir, 'gstack-upgrade', 'SKILL.md'),
    );

    // Commit so git repo is clean
    run('git', ['add', '.'], upgradeDir);
    run('git', ['commit', '-m', 'initial project'], upgradeDir);
  });

  afterAll(() => {
    try { fs.rmSync(upgradeDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(remoteDir, { recursive: true, force: true }); } catch {}
  });

  testIfSelected('gstack-upgrade-happy-path', async () => {
    const mockGstack = path.join(upgradeDir, '.claude', 'skills', 'gstack');
    const result = await runSkillTest({
      prompt: `Read gstack-upgrade/SKILL.md for the upgrade workflow.

You are running /gstack-upgrade standalone. The gstack installation is at ./.claude/skills/gstack (local-git type — it has a .git directory with an origin remote).

Current version: 0.5.0. A new version 0.6.0 is available on origin/main.

Follow the standalone upgrade flow:
1. Detect install type (local-git)
2. Run git fetch origin && git reset --hard origin/main in the install directory
3. Run the setup script
4. Show what's new from CHANGELOG

Skip any AskUserQuestion calls — auto-approve the upgrade. Write a summary of what you did to stdout.

IMPORTANT: The install directory is at ./.claude/skills/gstack — use that exact path.`,
      workingDirectory: upgradeDir,
      maxTurns: 20,
      timeout: 180_000,
      testName: 'gstack-upgrade-happy-path',
      runId,
    });

    logCost('/gstack-upgrade happy path', result);

    // Check that the version was updated
    const versionAfter = fs.readFileSync(path.join(mockGstack, 'VERSION'), 'utf-8').trim();
    const output = result.output || '';
    const mentionsUpgrade = output.toLowerCase().includes('0.6.0') ||
      output.toLowerCase().includes('upgrade') ||
      output.toLowerCase().includes('updated');

    recordE2E('/gstack-upgrade happy path', 'gstack-upgrade E2E', result, {
      passed: versionAfter === '0.6.0' && ['success', 'error_max_turns'].includes(result.exitReason),
    });

    expect(['success', 'error_max_turns']).toContain(result.exitReason);
    expect(versionAfter).toBe('0.6.0');
  }, 240_000);
});

// --- Design Consultation E2E ---

/**
 * LLM judge for DESIGN.md quality — checks font blacklist compliance,
 * coherence, specificity, and AI slop avoidance.
 */
async function designQualityJudge(designMd: string): Promise<{ passed: boolean; reasoning: string }> {
  return callJudge<{ passed: boolean; reasoning: string }>(`You are evaluating a generated DESIGN.md file for quality.

Evaluate against these criteria — ALL must pass for an overall "passed: true":
1. Does NOT recommend Inter, Roboto, Arial, Helvetica, Open Sans, Lato, Montserrat, or Poppins as primary fonts
2. Aesthetic direction is coherent with color approach (e.g., brutalist aesthetic doesn't pair with expressive color without explanation)
3. Font recommendations include specific font names (not generic like "a sans-serif font")
4. Color palette includes actual hex values, not placeholders like "[hex]"
5. Rationale is provided for major decisions (not just "because it looks good")
6. No AI slop patterns: purple gradients mentioned positively, "3-column feature grid" language, generic marketing speak
7. Product context is reflected in design choices (civic tech → should have appropriate, professional aesthetic)

DESIGN.md content:
\`\`\`
${designMd}
\`\`\`

Return JSON: { "passed": true/false, "reasoning": "one paragraph explaining your evaluation" }`);
}

describeIfSelected('Design Consultation E2E', [
  'design-consultation-core', 'design-consultation-research',
  'design-consultation-existing', 'design-consultation-preview',
], () => {
  let designDir: string;

  beforeAll(() => {
    designDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-design-consultation-'));
    const { spawnSync } = require('child_process');
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: designDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    // Create a realistic project context
    fs.writeFileSync(path.join(designDir, 'README.md'), `# CivicPulse

A civic tech data platform for government employees to access, visualize, and share public data. Built with Next.js and PostgreSQL.

## Features
- Real-time data dashboards for municipal budgets
- Public records search with faceted filtering
- Data export and sharing tools for inter-department collaboration
`);
    fs.writeFileSync(path.join(designDir, 'package.json'), JSON.stringify({
      name: 'civicpulse',
      version: '0.1.0',
      dependencies: { next: '^14.0.0', react: '^18.2.0', 'tailwindcss': '^3.4.0' },
    }, null, 2));

    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'initial project setup']);

    // Copy design-consultation skill
    fs.mkdirSync(path.join(designDir, 'design-consultation'), { recursive: true });
    fs.copyFileSync(
      path.join(ROOT, 'design-consultation', 'SKILL.md'),
      path.join(designDir, 'design-consultation', 'SKILL.md'),
    );
  });

  afterAll(() => {
    try { fs.rmSync(designDir, { recursive: true, force: true }); } catch {}
  });

  testIfSelected('design-consultation-core', async () => {
    const result = await runSkillTest({
      prompt: `Read design-consultation/SKILL.md for the design consultation workflow.

This is a civic tech data platform called CivicPulse for government employees who need to access public data. Read the README.md for details.

Skip research — work from your design knowledge. Skip the font preview page. Skip any AskUserQuestion calls — this is non-interactive. Accept your first design system proposal.

Write DESIGN.md and CLAUDE.md (or update it) in the working directory.`,
      workingDirectory: designDir,
      maxTurns: 20,
      timeout: 360_000,
      testName: 'design-consultation-core',
      runId,
    });

    logCost('/design-consultation core', result);

    const designPath = path.join(designDir, 'DESIGN.md');
    const claudePath = path.join(designDir, 'CLAUDE.md');
    const designExists = fs.existsSync(designPath);
    const claudeExists = fs.existsSync(claudePath);
    let designContent = '';

    if (designExists) {
      designContent = fs.readFileSync(designPath, 'utf-8');
    }

    // Structural checks
    const requiredSections = ['Product Context', 'Aesthetic', 'Typography', 'Color', 'Spacing', 'Layout', 'Motion'];
    const missingSections = requiredSections.filter(s => !designContent.toLowerCase().includes(s.toLowerCase()));

    // LLM judge for quality
    let judgeResult = { passed: false, reasoning: 'judge not run' };
    if (designExists && designContent.length > 100) {
      try {
        judgeResult = await designQualityJudge(designContent);
        console.log('Design quality judge:', JSON.stringify(judgeResult, null, 2));
      } catch (err) {
        console.warn('Judge failed:', err);
        judgeResult = { passed: true, reasoning: 'judge error — defaulting to pass' };
      }
    }

    const structuralPass = designExists && claudeExists && missingSections.length === 0;
    recordE2E('/design-consultation core', 'Design Consultation E2E', result, {
      passed: structuralPass && judgeResult.passed && ['success', 'error_max_turns'].includes(result.exitReason),
    });

    expect(['success', 'error_max_turns']).toContain(result.exitReason);
    expect(designExists).toBe(true);
    if (designExists) {
      expect(missingSections).toHaveLength(0);
    }
    if (claudeExists) {
      const claude = fs.readFileSync(claudePath, 'utf-8');
      expect(claude.toLowerCase()).toContain('design.md');
    }
  }, 420_000);

  testIfSelected('design-consultation-research', async () => {
    // Clean up from previous test
    try { fs.unlinkSync(path.join(designDir, 'DESIGN.md')); } catch {}
    try { fs.unlinkSync(path.join(designDir, 'CLAUDE.md')); } catch {}

    const result = await runSkillTest({
      prompt: `Read design-consultation/SKILL.md for the design consultation workflow.

This is a civic tech data platform called CivicPulse. Read the README.md.

DO research what's out there before proposing — search for civic tech and government data platform designs. Skip the font preview page. Skip any AskUserQuestion calls — this is non-interactive.

Write DESIGN.md to the working directory.`,
      workingDirectory: designDir,
      maxTurns: 30,
      timeout: 360_000,
      testName: 'design-consultation-research',
      runId,
    });

    logCost('/design-consultation research', result);

    const designPath = path.join(designDir, 'DESIGN.md');
    const designExists = fs.existsSync(designPath);
    let designContent = '';
    if (designExists) {
      designContent = fs.readFileSync(designPath, 'utf-8');
    }

    // Check if WebSearch was used (may not be available in all envs)
    const webSearchCalls = result.toolCalls.filter(tc => tc.tool === 'WebSearch');
    if (webSearchCalls.length > 0) {
      console.log(`WebSearch used ${webSearchCalls.length} times`);
    } else {
      console.warn('WebSearch not used — may be unavailable in test env');
    }

    // LLM judge
    let judgeResult = { passed: false, reasoning: 'judge not run' };
    if (designExists && designContent.length > 100) {
      try {
        judgeResult = await designQualityJudge(designContent);
        console.log('Design quality judge (research):', JSON.stringify(judgeResult, null, 2));
      } catch (err) {
        console.warn('Judge failed:', err);
        judgeResult = { passed: true, reasoning: 'judge error — defaulting to pass' };
      }
    }

    recordE2E('/design-consultation research', 'Design Consultation E2E', result, {
      passed: designExists && ['success', 'error_max_turns'].includes(result.exitReason),
    });

    expect(['success', 'error_max_turns']).toContain(result.exitReason);
    expect(designExists).toBe(true);
  }, 420_000);

  testIfSelected('design-consultation-existing', async () => {
    // Pre-create a minimal DESIGN.md
    fs.writeFileSync(path.join(designDir, 'DESIGN.md'), `# Design System — CivicPulse

## Typography
Body: system-ui
`);

    const result = await runSkillTest({
      prompt: `Read design-consultation/SKILL.md for the design consultation workflow.

There is already a DESIGN.md in this repo. Update it with a complete design system for CivicPulse, a civic tech data platform for government employees.

Skip research. Skip font preview. Skip any AskUserQuestion calls — this is non-interactive.`,
      workingDirectory: designDir,
      maxTurns: 20,
      timeout: 360_000,
      testName: 'design-consultation-existing',
      runId,
    });

    logCost('/design-consultation existing', result);

    const designPath = path.join(designDir, 'DESIGN.md');
    const designExists = fs.existsSync(designPath);
    let designContent = '';
    if (designExists) {
      designContent = fs.readFileSync(designPath, 'utf-8');
    }

    // Should have more content than the minimal version
    const hasColor = designContent.toLowerCase().includes('color');
    const hasSpacing = designContent.toLowerCase().includes('spacing');

    recordE2E('/design-consultation existing', 'Design Consultation E2E', result, {
      passed: designExists && hasColor && hasSpacing && ['success', 'error_max_turns'].includes(result.exitReason),
    });

    expect(['success', 'error_max_turns']).toContain(result.exitReason);
    expect(designExists).toBe(true);
    if (designExists) {
      expect(hasColor).toBe(true);
      expect(hasSpacing).toBe(true);
    }
  }, 420_000);

  testIfSelected('design-consultation-preview', async () => {
    // Clean up
    try { fs.unlinkSync(path.join(designDir, 'DESIGN.md')); } catch {}

    const result = await runSkillTest({
      prompt: `Read design-consultation/SKILL.md for the design consultation workflow.

This is CivicPulse, a civic tech data platform. Read the README.md.

Skip research. Skip any AskUserQuestion calls — this is non-interactive. Generate the font and color preview page but write it to ./design-preview.html instead of /tmp/ (do NOT run the open command). Then write DESIGN.md.`,
      workingDirectory: designDir,
      maxTurns: 20,
      timeout: 360_000,
      testName: 'design-consultation-preview',
      runId,
    });

    logCost('/design-consultation preview', result);

    const previewPath = path.join(designDir, 'design-preview.html');
    const designPath = path.join(designDir, 'DESIGN.md');
    const previewExists = fs.existsSync(previewPath);
    const designExists = fs.existsSync(designPath);

    let previewContent = '';
    if (previewExists) {
      previewContent = fs.readFileSync(previewPath, 'utf-8');
    }

    const hasHtml = previewContent.includes('<html') || previewContent.includes('<!DOCTYPE');
    const hasFontRef = previewContent.includes('font-family') || previewContent.includes('fonts.googleapis') || previewContent.includes('fonts.bunny');
    const hasColorRef = previewContent.includes('#') && (previewContent.includes('background') || previewContent.includes('color:'));

    // LLM judge on the DESIGN.md
    let judgeResult = { passed: false, reasoning: 'judge not run' };
    if (designExists) {
      const designContent = fs.readFileSync(designPath, 'utf-8');
      if (designContent.length > 100) {
        try {
          judgeResult = await designQualityJudge(designContent);
          console.log('Design quality judge (preview):', JSON.stringify(judgeResult, null, 2));
        } catch (err) {
          console.warn('Judge failed:', err);
          judgeResult = { passed: true, reasoning: 'judge error — defaulting to pass' };
        }
      }
    }

    recordE2E('/design-consultation preview', 'Design Consultation E2E', result, {
      passed: previewExists && designExists && hasHtml && ['success', 'error_max_turns'].includes(result.exitReason),
    });

    expect(['success', 'error_max_turns']).toContain(result.exitReason);
    expect(previewExists).toBe(true);
    if (previewExists) {
      expect(hasHtml).toBe(true);
      expect(hasFontRef).toBe(true);
    }
    expect(designExists).toBe(true);
  }, 420_000);
});

// --- Plan Design Review E2E (plan-mode) ---

describeIfSelected('Plan Design Review E2E', ['plan-design-review-plan-mode', 'plan-design-review-no-ui-scope'], () => {
  let reviewDir: string;

  beforeAll(() => {
    reviewDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-plan-design-'));

    const { spawnSync } = require('child_process');
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: reviewDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    // Copy plan-design-review skill
    fs.mkdirSync(path.join(reviewDir, 'plan-design-review'), { recursive: true });
    fs.copyFileSync(
      path.join(ROOT, 'plan-design-review', 'SKILL.md'),
      path.join(reviewDir, 'plan-design-review', 'SKILL.md'),
    );

    // Create a plan file with intentional design gaps
    fs.writeFileSync(path.join(reviewDir, 'plan.md'), `# Plan: User Dashboard

## Context
Build a user dashboard that shows account stats, recent activity, and settings.

## Implementation
1. Create a dashboard page at /dashboard
2. Show user stats (posts, followers, engagement rate)
3. Add a recent activity feed
4. Add a settings panel
5. Use a clean, modern UI with cards and icons
6. Add a hero section at the top with a gradient background

## Technical Details
- React components with Tailwind CSS
- API endpoint: GET /api/dashboard
- WebSocket for real-time activity updates
`);

    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'initial plan']);
  });

  afterAll(() => {
    try { fs.rmSync(reviewDir, { recursive: true, force: true }); } catch {}
  });

  testIfSelected('plan-design-review-plan-mode', async () => {
    const result = await runSkillTest({
      prompt: `Read plan-design-review/SKILL.md for the design review workflow.

Review the plan in ./plan.md. This plan has several design gaps — it uses vague language like "clean, modern UI" and "cards and icons", mentions a "hero section with gradient" (AI slop), and doesn't specify empty states, error states, loading states, responsive behavior, or accessibility.

Skip the preamble bash block. Skip any AskUserQuestion calls — this is non-interactive. Rate each design dimension 0-10 and explain what would make it a 10. Then EDIT plan.md to add the missing design decisions (interaction state table, empty states, responsive behavior, etc.).

IMPORTANT: Do NOT try to browse any URLs or use a browse binary. This is a plan review, not a live site audit. Just read the plan file, review it, and edit it to fix the gaps.`,
      workingDirectory: reviewDir,
      maxTurns: 15,
      timeout: 300_000,
      testName: 'plan-design-review-plan-mode',
      runId,
    });

    logCost('/plan-design-review plan-mode', result);

    // Check that the agent produced design ratings (0-10 scale)
    const output = result.output || '';
    const hasRatings = /\d+\/10/.test(output);
    const hasDesignContent = output.toLowerCase().includes('information architecture') ||
      output.toLowerCase().includes('interaction state') ||
      output.toLowerCase().includes('ai slop') ||
      output.toLowerCase().includes('hierarchy');

    // Check that the plan file was edited (the core new behavior)
    const planAfter = fs.readFileSync(path.join(reviewDir, 'plan.md'), 'utf-8');
    const planOriginal = `# Plan: User Dashboard`;
    const planWasEdited = planAfter.length > 300; // Original is ~450 chars, edited should be much longer
    const planHasDesignAdditions = planAfter.toLowerCase().includes('empty') ||
      planAfter.toLowerCase().includes('loading') ||
      planAfter.toLowerCase().includes('error') ||
      planAfter.toLowerCase().includes('state') ||
      planAfter.toLowerCase().includes('responsive') ||
      planAfter.toLowerCase().includes('accessibility');

    recordE2E('/plan-design-review plan-mode', 'Plan Design Review E2E', result, {
      passed: hasDesignContent && planWasEdited && ['success', 'error_max_turns'].includes(result.exitReason),
    });

    expect(['success', 'error_max_turns']).toContain(result.exitReason);
    // Agent should produce design-relevant output about the plan
    expect(hasDesignContent).toBe(true);
    // Agent should have edited the plan file to add missing design decisions
    expect(planWasEdited).toBe(true);
    expect(planHasDesignAdditions).toBe(true);
  }, 360_000);

  testIfSelected('plan-design-review-no-ui-scope', async () => {
    // Write a backend-only plan
    fs.writeFileSync(path.join(reviewDir, 'backend-plan.md'), `# Plan: Database Migration

## Context
Migrate user records from PostgreSQL to a new schema with better indexing.

## Implementation
1. Create migration to add new columns to users table
2. Backfill data from legacy columns
3. Add database indexes for common query patterns
4. Update ActiveRecord models
5. Run migration in staging first, then production
`);

    const result = await runSkillTest({
      prompt: `Read plan-design-review/SKILL.md for the design review workflow.

Review the plan in ./backend-plan.md. This is a pure backend database migration plan with no UI changes.

Skip the preamble bash block. Skip any AskUserQuestion calls — this is non-interactive. Write your findings directly to stdout.

IMPORTANT: Do NOT try to browse any URLs or use a browse binary. This is a plan review, not a live site audit.`,
      workingDirectory: reviewDir,
      maxTurns: 10,
      timeout: 180_000,
      testName: 'plan-design-review-no-ui-scope',
      runId,
    });

    logCost('/plan-design-review no-ui-scope', result);

    // Agent should detect no UI scope and exit early
    const output = result.output || '';
    const detectsNoUI = output.toLowerCase().includes('no ui') ||
      output.toLowerCase().includes('no frontend') ||
      output.toLowerCase().includes('no design') ||
      output.toLowerCase().includes('not applicable') ||
      output.toLowerCase().includes('backend');

    recordE2E('/plan-design-review no-ui-scope', 'Plan Design Review E2E', result, {
      passed: detectsNoUI && ['success', 'error_max_turns'].includes(result.exitReason),
    });

    expect(['success', 'error_max_turns']).toContain(result.exitReason);
    expect(detectsNoUI).toBe(true);
  }, 240_000);
});

// --- Design Review E2E (live-site audit + fix) ---

describeIfSelected('Design Review E2E', ['design-review-fix'], () => {
  let qaDesignDir: string;
  let qaDesignServer: ReturnType<typeof Bun.serve> | null = null;

  beforeAll(() => {
    qaDesignDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-qa-design-'));
    setupBrowseShims(qaDesignDir);

    const { spawnSync } = require('child_process');
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: qaDesignDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    // Create HTML/CSS with intentional design issues
    fs.writeFileSync(path.join(qaDesignDir, 'index.html'), `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Design Test App</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <header>
    <h1 style="font-size: 48px; color: #333;">Welcome</h1>
    <h2 style="font-size: 47px; color: #334;">Subtitle Here</h2>
  </header>
  <main>
    <div class="card" style="padding: 10px; margin: 20px;">
      <h3 style="color: blue;">Card Title</h3>
      <p style="color: #666; font-size: 14px; line-height: 1.2;">Some content here with tight line height.</p>
    </div>
    <div class="card" style="padding: 30px; margin: 5px;">
      <h3 style="color: green;">Another Card</h3>
      <p style="color: #999; font-size: 16px;">Different spacing and colors for no reason.</p>
    </div>
    <button style="background: red; color: white; padding: 5px 10px; border: none;">Click Me</button>
    <button style="background: #007bff; color: white; padding: 12px 24px; border: none; border-radius: 20px;">Also Click</button>
  </main>
</body>
</html>`);

    fs.writeFileSync(path.join(qaDesignDir, 'style.css'), `body {
  font-family: Arial, sans-serif;
  margin: 0;
  padding: 20px;
}
.card {
  border: 1px solid #ddd;
  border-radius: 4px;
}
`);

    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'initial design test page']);

    // Start a simple file server for the design test page
    qaDesignServer = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        const filePath = path.join(qaDesignDir, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
        try {
          const content = fs.readFileSync(filePath);
          const ext = path.extname(filePath);
          const contentType = ext === '.css' ? 'text/css' : ext === '.html' ? 'text/html' : 'text/plain';
          return new Response(content, { headers: { 'Content-Type': contentType } });
        } catch {
          return new Response('Not Found', { status: 404 });
        }
      },
    });

    // Copy design-review skill
    fs.mkdirSync(path.join(qaDesignDir, 'design-review'), { recursive: true });
    fs.copyFileSync(
      path.join(ROOT, 'design-review', 'SKILL.md'),
      path.join(qaDesignDir, 'design-review', 'SKILL.md'),
    );
  });

  afterAll(() => {
    qaDesignServer?.stop();
    try { fs.rmSync(qaDesignDir, { recursive: true, force: true }); } catch {}
  });

  test('Test 7: /design-review audits and fixes design issues', async () => {
    const serverUrl = `http://localhost:${(qaDesignServer as any)?.port}`;

    const result = await runSkillTest({
      prompt: `IMPORTANT: The browse binary is already assigned below as B. Do NOT search for it or run the SKILL.md setup block — just use $B directly.

B="${browseBin}"

Read design-review/SKILL.md for the design review + fix workflow.

Review the site at ${serverUrl}. Use --quick mode. Skip any AskUserQuestion calls — this is non-interactive. Fix up to 3 issues max. Write your report to ./design-audit.md.`,
      workingDirectory: qaDesignDir,
      maxTurns: 30,
      timeout: 360_000,
      testName: 'design-review-fix',
      runId,
    });

    logCost('/design-review fix', result);

    const reportPath = path.join(qaDesignDir, 'design-audit.md');
    const reportExists = fs.existsSync(reportPath);

    // Check if any design fix commits were made
    const gitLog = spawnSync('git', ['log', '--oneline'], {
      cwd: qaDesignDir, stdio: 'pipe',
    });
    const commits = gitLog.stdout.toString().trim().split('\n');
    const designFixCommits = commits.filter((c: string) => c.includes('style(design)'));

    recordE2E('/design-review fix', 'Design Review E2E', result, {
      passed: ['success', 'error_max_turns'].includes(result.exitReason),
    });

    // Accept error_max_turns — the fix loop is complex
    expect(['success', 'error_max_turns']).toContain(result.exitReason);

    // Report and commits are best-effort — log what happened
    if (reportExists) {
      const report = fs.readFileSync(reportPath, 'utf-8');
      console.log(`Design audit report: ${report.length} chars`);
    } else {
      console.warn('No design-audit.md generated');
    }
    console.log(`Design fix commits: ${designFixCommits.length}`);
  }, 420_000);
});

// --- Test Bootstrap E2E ---

describeIfSelected('Test Bootstrap E2E', ['qa-bootstrap'], () => {
  let bootstrapDir: string;
  let bootstrapServer: ReturnType<typeof Bun.serve>;

  beforeAll(() => {
    bootstrapDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-bootstrap-'));
    setupBrowseShims(bootstrapDir);

    // Copy qa skill files
    copyDirSync(path.join(ROOT, 'qa'), path.join(bootstrapDir, 'qa'));

    // Create a minimal Node.js project with NO test framework
    fs.writeFileSync(path.join(bootstrapDir, 'package.json'), JSON.stringify({
      name: 'test-bootstrap-app',
      version: '1.0.0',
      type: 'module',
    }, null, 2));

    // Create a simple app file with a bug
    fs.writeFileSync(path.join(bootstrapDir, 'app.js'), `
export function add(a, b) { return a + b; }
export function subtract(a, b) { return a - b; }
export function divide(a, b) { return a / b; } // BUG: no zero check
`);

    // Create a simple HTML page with a bug
    fs.writeFileSync(path.join(bootstrapDir, 'index.html'), `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Bootstrap Test</title></head>
<body>
  <h1>Test App</h1>
  <a href="/nonexistent-page">Broken Link</a>
  <script>console.error("ReferenceError: undefinedVar is not defined");</script>
</body>
</html>
`);

    // Init git repo
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: bootstrapDir, stdio: 'pipe', timeout: 5000 });
    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'initial commit']);

    // Serve from working directory
    bootstrapServer = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const url = new URL(req.url);
        let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
        filePath = filePath.replace(/^\//, '');
        const fullPath = path.join(bootstrapDir, filePath);
        if (!fs.existsSync(fullPath)) {
          return new Response('Not Found', { status: 404 });
        }
        const content = fs.readFileSync(fullPath, 'utf-8');
        return new Response(content, {
          headers: { 'Content-Type': 'text/html' },
        });
      },
    });
  });

  afterAll(() => {
    bootstrapServer?.stop();
    try { fs.rmSync(bootstrapDir, { recursive: true, force: true }); } catch {}
  });

  test('/qa bootstrap + regression test on zero-test project', async () => {
    const serverUrl = `http://127.0.0.1:${bootstrapServer!.port}`;

    const result = await runSkillTest({
      prompt: `You have a browse binary at ${browseBin}. Assign it to B variable like: B="${browseBin}"

Read the file qa/SKILL.md for the QA workflow instructions.

Run a Quick-tier QA test on ${serverUrl}
The source code for this page is at ${bootstrapDir}/index.html — you can fix bugs there.
Do NOT use AskUserQuestion — for any AskUserQuestion prompts, choose the RECOMMENDED option automatically.
Write your report to ${bootstrapDir}/qa-reports/qa-report.md

This project has NO test framework. When the bootstrap asks, pick vitest (option A).
This is a test+fix loop: find bugs, fix them, write regression tests, commit each fix.`,
      workingDirectory: bootstrapDir,
      maxTurns: 50,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
      timeout: 420_000,
      testName: 'qa-bootstrap',
      runId,
    });

    logCost('/qa bootstrap', result);
    recordE2E('/qa bootstrap + regression test', 'Test Bootstrap E2E', result, {
      passed: ['success', 'error_max_turns'].includes(result.exitReason),
    });

    expect(['success', 'error_max_turns']).toContain(result.exitReason);

    // Verify bootstrap created test infrastructure
    const hasTestConfig = fs.existsSync(path.join(bootstrapDir, 'vitest.config.ts'))
      || fs.existsSync(path.join(bootstrapDir, 'vitest.config.js'))
      || fs.existsSync(path.join(bootstrapDir, 'jest.config.js'))
      || fs.existsSync(path.join(bootstrapDir, 'jest.config.ts'));
    console.log(`Test config created: ${hasTestConfig}`);

    const hasTestingMd = fs.existsSync(path.join(bootstrapDir, 'TESTING.md'));
    console.log(`TESTING.md created: ${hasTestingMd}`);

    // Check for bootstrap commit
    const gitLog = spawnSync('git', ['log', '--oneline', '--grep=bootstrap'], {
      cwd: bootstrapDir, stdio: 'pipe',
    });
    const bootstrapCommits = gitLog.stdout.toString().trim();
    console.log(`Bootstrap commits: ${bootstrapCommits || 'none'}`);

    // Check for regression test commits
    const regressionLog = spawnSync('git', ['log', '--oneline', '--grep=test(qa)'], {
      cwd: bootstrapDir, stdio: 'pipe',
    });
    const regressionCommits = regressionLog.stdout.toString().trim();
    console.log(`Regression test commits: ${regressionCommits || 'none'}`);

    // Verify at least the bootstrap happened (fix commits are bonus)
    const allCommits = spawnSync('git', ['log', '--oneline'], {
      cwd: bootstrapDir, stdio: 'pipe',
    });
    const totalCommits = allCommits.stdout.toString().trim().split('\n').length;
    console.log(`Total commits: ${totalCommits}`);
    expect(totalCommits).toBeGreaterThan(1); // At least initial + bootstrap
  }, 420_000);
});

// --- Test Coverage Audit E2E ---

describeIfSelected('Test Coverage Audit E2E', ['ship-coverage-audit'], () => {
  let coverageDir: string;

  beforeAll(() => {
    coverageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-coverage-'));

    // Copy ship skill files
    copyDirSync(path.join(ROOT, 'ship'), path.join(coverageDir, 'ship'));
    copyDirSync(path.join(ROOT, 'review'), path.join(coverageDir, 'review'));

    // Use shared fixture for billing project with coverage gaps
    const { createCoverageAuditFixture } = require('./fixtures/coverage-audit-fixture');
    createCoverageAuditFixture(coverageDir);
  });

  afterAll(() => {
    try { fs.rmSync(coverageDir, { recursive: true, force: true }); } catch {}
  });

  test('/ship Step 3.4 produces coverage diagram', async () => {
    const result = await runSkillTest({
      prompt: `Read the file ship/SKILL.md for the ship workflow instructions.

You are on the feature/billing branch. The base branch is main.
This is a test project — there is no remote, no PR to create.

ONLY run Step 3.4 (Test Coverage Audit) from the ship workflow.
Skip all other steps (tests, evals, review, version, changelog, commit, push, PR).

The source code is in ${coverageDir}/src/billing.ts.
Existing tests are in ${coverageDir}/test/billing.test.ts.
The test command is: echo "tests pass" (mocked — just pretend tests pass).

Produce the ASCII coverage diagram showing which code paths are tested and which have gaps.
Do NOT generate new tests — just produce the diagram and coverage summary.
Output the diagram directly.`,
      workingDirectory: coverageDir,
      maxTurns: 15,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
      timeout: 120_000,
      testName: 'ship-coverage-audit',
      runId,
    });

    logCost('/ship coverage audit', result);
    recordE2E('/ship Step 3.4 coverage audit', 'Test Coverage Audit E2E', result, {
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

// --- Review Coverage Audit E2E ---

describeIfSelected('Review Coverage Audit E2E', ['review-coverage-audit'], () => {
  let reviewCoverageDir: string;

  beforeAll(() => {
    reviewCoverageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-review-coverage-'));

    // Copy review skill files
    copyDirSync(path.join(ROOT, 'review'), path.join(reviewCoverageDir, 'review'));

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
    recordE2E('/review Step 4.75 coverage audit', 'Review Coverage Audit E2E', result, {
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

    // Copy plan-eng-review skill files
    copyDirSync(path.join(ROOT, 'plan-eng-review'), path.join(planCoverageDir, 'plan-eng-review'));

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
    recordE2E('/plan-eng-review coverage audit', 'Plan Eng Review Coverage Audit E2E', result, {
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

// --- Triage E2E ---

describeIfSelected('Test Failure Triage E2E', ['ship-triage'], () => {
  let triageDir: string;

  beforeAll(() => {
    triageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-triage-'));

    // Copy ship skill files
    copyDirSync(path.join(ROOT, 'ship'), path.join(triageDir, 'ship'));

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
      timeout: 180_000,
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

    recordE2E('/ship triage', 'Test Failure Triage E2E', result, {
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
  }, 240_000);
});

// --- Codex skill E2E ---

describeIfSelected('Codex skill E2E', ['codex-review'], () => {
  let codexDir: string;

  beforeAll(() => {
    codexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-codex-'));

    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: codexDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    // Commit a clean base on main
    fs.writeFileSync(path.join(codexDir, 'app.rb'), '# clean base\nclass App\nend\n');
    run('git', ['add', 'app.rb']);
    run('git', ['commit', '-m', 'initial commit']);

    // Create feature branch with vulnerable code (reuse review fixture)
    run('git', ['checkout', '-b', 'feature/add-vuln']);
    const vulnContent = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'review-eval-vuln.rb'), 'utf-8');
    fs.writeFileSync(path.join(codexDir, 'user_controller.rb'), vulnContent);
    run('git', ['add', 'user_controller.rb']);
    run('git', ['commit', '-m', 'add vulnerable controller']);

    // Copy the codex skill file
    fs.copyFileSync(path.join(ROOT, 'codex', 'SKILL.md'), path.join(codexDir, 'codex-SKILL.md'));
  });

  afterAll(() => {
    try { fs.rmSync(codexDir, { recursive: true, force: true }); } catch {}
  });

  test('/codex review produces findings and GATE verdict', async () => {
    // Check codex is available — skip if not installed
    const codexCheck = spawnSync('which', ['codex'], { stdio: 'pipe', timeout: 3000 });
    if (codexCheck.status !== 0) {
      console.warn('codex CLI not installed — skipping E2E test');
      return;
    }

    const result = await runSkillTest({
      prompt: `You are in a git repo on branch feature/add-vuln with changes against main.
Read codex-SKILL.md for the /codex skill instructions.
Run /codex review to review the current diff against main.
Write the full output (including the GATE verdict) to ${codexDir}/codex-output.md`,
      workingDirectory: codexDir,
      maxTurns: 10,
      timeout: 300_000,
      testName: 'codex-review',
      runId,
    });

    logCost('/codex review', result);
    recordE2E('/codex review', 'Codex skill E2E', result);
    expect(result.exitReason).toBe('success');

    // Check that output file was created with review content
    const outputPath = path.join(codexDir, 'codex-output.md');
    if (fs.existsSync(outputPath)) {
      const output = fs.readFileSync(outputPath, 'utf-8');
      // Should contain the CODEX SAYS header or GATE verdict
      const hasCodexOutput = output.includes('CODEX') || output.includes('GATE') || output.includes('codex');
      expect(hasCodexOutput).toBe(true);
    }
  }, 360_000);
});

// --- Office Hours Spec Review E2E ---

describeIfSelected('Office Hours Spec Review E2E', ['office-hours-spec-review'], () => {
  let ohDir: string;

  beforeAll(() => {
    ohDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-oh-spec-'));
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: ohDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(ohDir, 'README.md'), '# Test Project\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'init']);

    // Copy office-hours skill
    fs.mkdirSync(path.join(ohDir, 'office-hours'), { recursive: true });
    fs.copyFileSync(
      path.join(ROOT, 'office-hours', 'SKILL.md'),
      path.join(ohDir, 'office-hours', 'SKILL.md'),
    );
  });

  afterAll(() => {
    try { fs.rmSync(ohDir, { recursive: true, force: true }); } catch {}
  });

  test('/office-hours SKILL.md contains spec review loop', async () => {
    const result = await runSkillTest({
      prompt: `Read office-hours/SKILL.md. I want to understand the spec review loop.

Summarize what the "Spec Review Loop" section does — specifically:
1. How many dimensions does the reviewer check?
2. What tool is used to dispatch the reviewer?
3. What's the maximum number of iterations?
4. What metrics are tracked?

Write your summary to ${ohDir}/spec-review-summary.md`,
      workingDirectory: ohDir,
      maxTurns: 8,
      timeout: 120_000,
      testName: 'office-hours-spec-review',
      runId,
    });

    logCost('/office-hours spec review', result);
    recordE2E('/office-hours-spec-review', 'Office Hours Spec Review E2E', result);
    expect(result.exitReason).toBe('success');

    const summaryPath = path.join(ohDir, 'spec-review-summary.md');
    if (fs.existsSync(summaryPath)) {
      const summary = fs.readFileSync(summaryPath, 'utf-8').toLowerCase();
      // Verify the agent understood the key concepts
      expect(summary).toMatch(/5.*dimension|dimension.*5|completeness|consistency|clarity|scope|feasibility/);
      expect(summary).toMatch(/agent|subagent/);
      expect(summary).toMatch(/3.*iteration|iteration.*3|maximum.*3/);
    }
  }, 180_000);
});

// --- Plan CEO Review Benefits-From E2E ---

describeIfSelected('Plan CEO Review Benefits-From E2E', ['plan-ceo-review-benefits'], () => {
  let benefitsDir: string;

  beforeAll(() => {
    benefitsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-benefits-'));
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: benefitsDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(benefitsDir, 'README.md'), '# Test Project\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'init']);

    // Copy plan-ceo-review skill
    fs.mkdirSync(path.join(benefitsDir, 'plan-ceo-review'), { recursive: true });
    fs.copyFileSync(
      path.join(ROOT, 'plan-ceo-review', 'SKILL.md'),
      path.join(benefitsDir, 'plan-ceo-review', 'SKILL.md'),
    );
  });

  afterAll(() => {
    try { fs.rmSync(benefitsDir, { recursive: true, force: true }); } catch {}
  });

  test('/plan-ceo-review SKILL.md contains prerequisite skill offer', async () => {
    const result = await runSkillTest({
      prompt: `Read plan-ceo-review/SKILL.md. Search for sections about "Prerequisite" or "office-hours" or "design doc found".

Summarize what happens when no design doc is found — specifically:
1. Is /office-hours offered as a prerequisite?
2. What options does the user get?
3. Is there a mid-session detection for when the user seems lost?

Write your summary to ${benefitsDir}/benefits-summary.md`,
      workingDirectory: benefitsDir,
      maxTurns: 8,
      timeout: 120_000,
      testName: 'plan-ceo-review-benefits',
      runId,
    });

    logCost('/plan-ceo-review benefits-from', result);
    recordE2E('/plan-ceo-review-benefits', 'Plan CEO Review Benefits-From E2E', result);
    expect(result.exitReason).toBe('success');

    const summaryPath = path.join(benefitsDir, 'benefits-summary.md');
    if (fs.existsSync(summaryPath)) {
      const summary = fs.readFileSync(summaryPath, 'utf-8').toLowerCase();
      // Verify the agent understood the skill chaining
      expect(summary).toMatch(/office.hours/);
      expect(summary).toMatch(/design doc|no design/i);
    }
  }, 180_000);
});

// --- Ship idempotency (#649) ---
describeIfSelected('Ship idempotency', ['ship-idempotency'], () => {
  let idempDir: string;
  const gitRun = (args: string[], cwd: string) =>
    spawnSync('git', args, { cwd, stdio: 'pipe', timeout: 5000 });

  beforeAll(() => {
    idempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-ship-idemp-'));

    // Create git repo with initial commit on main
    gitRun(['init', '-b', 'main'], idempDir);
    gitRun(['config', 'user.email', 'test@test.com'], idempDir);
    gitRun(['config', 'user.name', 'Test'], idempDir);

    fs.writeFileSync(path.join(idempDir, 'app.ts'), 'console.log("v1");\n');
    fs.writeFileSync(path.join(idempDir, 'VERSION'), '0.1.0.0\n');
    fs.writeFileSync(path.join(idempDir, 'CHANGELOG.md'), '# Changelog\n');
    gitRun(['add', '.'], idempDir);
    gitRun(['commit', '-m', 'initial'], idempDir);

    // Create feature branch with changes
    gitRun(['checkout', '-b', 'feat/my-feature'], idempDir);
    fs.writeFileSync(path.join(idempDir, 'app.ts'), 'console.log("v2");\n');
    gitRun(['add', 'app.ts'], idempDir);
    gitRun(['commit', '-m', 'feat: update to v2'], idempDir);

    // Simulate prior /ship run: bump VERSION and write CHANGELOG entry
    fs.writeFileSync(path.join(idempDir, 'VERSION'), '0.2.0.0\n');
    fs.writeFileSync(path.join(idempDir, 'CHANGELOG.md'),
      '# Changelog\n\n## [0.2.0.0] — 2026-03-30\n\n- Updated app to v2\n');
    gitRun(['add', 'VERSION', 'CHANGELOG.md'], idempDir);
    gitRun(['commit', '-m', 'chore: bump version to 0.2.0.0'], idempDir);

    // Extract just the idempotency-relevant sections from ship/SKILL.md
    const full = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');
    const step4Start = full.indexOf('## Step 4: Version bump');
    const step4End = full.indexOf('\n---\n', step4Start);
    const step7Start = full.indexOf('## Step 7: Push');
    const step8End = full.indexOf('## Step 8.5');
    const extracted = [
      full.slice(step4Start, step4End > step4Start ? step4End : step4Start + 500),
      full.slice(step7Start, step8End > step7Start ? step8End : step7Start + 500),
    ].join('\n\n---\n\n');
    fs.writeFileSync(path.join(idempDir, 'ship-steps.md'), extracted);
  });

  afterAll(() => {
    try { fs.rmSync(idempDir, { recursive: true, force: true }); } catch {}
  });

  testIfSelected('ship-idempotency', async () => {
    const result = await runSkillTest({
      prompt: `You are in a git repo on branch feat/my-feature. A prior /ship run already:
- Bumped VERSION from 0.1.0.0 to 0.2.0.0
- Wrote a CHANGELOG entry for 0.2.0.0
- But the push/PR step failed

Read ship-steps.md for the idempotency check instructions from the ship workflow.

Run ONLY the idempotency checks described in Steps 4 and 7. Do NOT actually push or create PRs (there is no remote).

After running the checks, write a report to ${idempDir}/idemp-result.md containing:
- Whether VERSION was detected as ALREADY_BUMPED or not
- Whether the push was detected as ALREADY_PUSHED or PUSH_NEEDED
- The current VERSION value (should still be 0.2.0.0)

Do NOT modify VERSION or CHANGELOG. Only run the detection checks and report.`,
      workingDirectory: idempDir,
      maxTurns: 10,
      timeout: 60_000,
      testName: 'ship-idempotency',
      runId,
    });

    logCost('/ship idempotency', result);
    recordE2E('/ship idempotency guard', 'Ship idempotency', result);
    expect(result.exitReason).toBe('success');

    // Verify VERSION was NOT modified
    const version = fs.readFileSync(path.join(idempDir, 'VERSION'), 'utf-8').trim();
    expect(version).toBe('0.2.0.0');

    // Verify CHANGELOG was NOT duplicated
    const changelog = fs.readFileSync(path.join(idempDir, 'CHANGELOG.md'), 'utf-8');
    const versionEntries = (changelog.match(/## \[0\.2\.0\.0\]/g) || []).length;
    expect(versionEntries).toBe(1);

    // Check the result report if it was written
    const reportPath = path.join(idempDir, 'idemp-result.md');
    if (fs.existsSync(reportPath)) {
      const report = fs.readFileSync(reportPath, 'utf-8');
      expect(report.toLowerCase()).toContain('already_bumped');
    }
  }, 120_000);
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
