import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { runSkillTest } from './helpers/session-runner';
import type { SkillTestResult } from './helpers/session-runner';
import { outcomeJudge } from './helpers/llm-judge';
import { EvalCollector, judgePassed } from './helpers/eval-store';
import type { EvalTestEntry } from './helpers/eval-store';
import { startTestServer } from '../browse/test/test-server';
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

  test('contributor mode files a report on gstack error', async () => {
    const contribDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-contrib-'));
    const logsDir = path.join(contribDir, 'contributor-logs');
    fs.mkdirSync(logsDir, { recursive: true });

    // Extract contributor mode instructions from generated SKILL.md
    const skillMd = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
    const contribStart = skillMd.indexOf('## Contributor Mode');
    const contribEnd = skillMd.indexOf('\n## ', contribStart + 1);
    const contribBlock = skillMd.slice(contribStart, contribEnd > 0 ? contribEnd : undefined);

    const result = await runSkillTest({
      prompt: `You are in contributor mode (_CONTRIB=true).

${contribBlock}

OVERRIDE: Write contributor logs to ${logsDir}/ instead of ~/.gstack/contributor-logs/

Now try this browse command (it will fail — there is no binary at this path):
/nonexistent/path/browse goto https://example.com

This is a gstack issue (the browse binary is missing/misconfigured).
File a contributor report about this issue. Then tell me what you filed.`,
      workingDirectory: contribDir,
      maxTurns: 8,
      timeout: 60_000,
      testName: 'contributor-mode',
      runId,
    });

    logCost('contributor mode', result);
    // Override passed: this test intentionally triggers a browse error (nonexistent binary)
    // so browseErrors will be non-empty — that's expected, not a failure
    recordE2E('contributor mode report', 'Skill E2E tests', result, {
      passed: result.exitReason === 'success',
    });

    // Verify a contributor log was created with expected format
    const logFiles = fs.readdirSync(logsDir).filter(f => f.endsWith('.md'));
    expect(logFiles.length).toBeGreaterThan(0);

    // Verify new reflection-based format
    const logContent = fs.readFileSync(path.join(logsDir, logFiles[0]), 'utf-8');
    expect(logContent).toContain('Hey gstack team');
    expect(logContent).toContain('What I was trying to do');
    expect(logContent).toContain('What happened instead');
    expect(logContent).toMatch(/rating/i);
    // Verify report has repro steps (agent may use "Steps to reproduce", "Repro Steps", etc.)
    expect(logContent).toMatch(/repro|steps to reproduce|how to reproduce/i);
    // Verify report has date/version footer (agent may format differently)
    expect(logContent).toMatch(/date.*2026|2026.*date/i);

    // Clean up
    try { fs.rmSync(contribDir, { recursive: true, force: true }); } catch {}
  }, 90_000);

  test('session awareness adds ELI16 context when _SESSIONS >= 3', async () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-session-'));

    // Set up a git repo so there's project/branch context to reference
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: sessionDir, stdio: 'pipe', timeout: 5000 });
    run('git', ['init']);
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

describeE2E('Review enum completeness E2E', () => {
  let enumDir: string;

  beforeAll(() => {
    enumDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-enum-'));

    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: enumDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init']);
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

describeE2E('QA-Only skill E2E', () => {
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

    run('git', ['init']);
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

describeE2E('QA Fix Loop E2E', () => {
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

    run('git', ['init']);
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

describeE2E('Plan-Eng-Review Test-Plan Artifact E2E', () => {
  let planDir: string;
  let projectDir: string;

  beforeAll(() => {
    planDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-plan-artifact-'));
    const { spawnSync } = require('child_process');
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: planDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init']);
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

Choose SMALL CHANGE mode. Skip any AskUserQuestion calls — this is non-interactive.

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

describeE2E('Base branch detection', () => {
  let baseBranchDir: string;
  const run = (cmd: string, args: string[], cwd: string) =>
    spawnSync(cmd, args, { cwd, stdio: 'pipe', timeout: 5000 });

  beforeAll(() => {
    baseBranchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-basebranch-'));
  });

  afterAll(() => {
    try { fs.rmSync(baseBranchDir, { recursive: true, force: true }); } catch {}
  });

  test('/review detects base branch and diffs against it', async () => {
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

  test('/ship Step 0-1 detects base branch without destructive actions', async () => {
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

  test('/retro detects default branch for git queries', async () => {
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

describeE2E('Document-Release skill E2E', () => {
  let docReleaseDir: string;

  beforeAll(() => {
    docReleaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-doc-release-'));

    // Copy document-release skill files
    copyDirSync(path.join(ROOT, 'document-release'), path.join(docReleaseDir, 'document-release'));

    // Init git repo with initial docs
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: docReleaseDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init']);
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
