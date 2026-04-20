import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { runSkillTest } from './helpers/session-runner';
import { outcomeJudge, callJudge } from './helpers/llm-judge';
import { judgePassed } from './helpers/eval-store';
import {
  ROOT, runId, evalsEnabled, selectedTests, hasApiKey,
  describeIfSelected, testConcurrentIfSelected,
  copyDirSync, logCost, recordE2E, dumpOutcomeDiagnostic,
  createEvalCollector, finalizeEvalCollector,
} from './helpers/e2e-helpers';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * /qa-headless eval suite.
 *
 * Covers the 9 acceptance scenarios from PLAN-qa-headless.md:
 * 1. shape detection (gate)         — deterministic across 7 fixtures
 * 2. python-cron motivating case    — runs end-to-end, asserts summary line
 * 3. dry-run proposal               — no --dry-run flag → skill proposes one
 * 4. boot requirements              — missing env / DB → loud prereq error
 * 5. empty-diff fallback            — no diff → repo scan + user picks
 * 6. trigger discovery              — argparse spec parsed, args surfaced
 * 7. async capture                  — httpx.AsyncClient → respx, not responses
 * 8. celery sync                    — task.apply(), no broker boot
 * 9. regression (gate)              — golden-diff against frozen output
 */

const evalCollector = createEvalCollector('e2e-qa-headless');
const FIXTURE_ROOT = path.join(ROOT, 'test', 'fixtures', 'qa-headless');

// Outcome evals need ANTHROPIC_API_KEY for the LLM judge
const describeOutcome = (evalsEnabled && hasApiKey) ? describe : describe.skip;

const allTestNames = [
  'qa-headless-shape-detection',
  'qa-headless-python-cron',
  'qa-headless-dry-run-proposal',
  'qa-headless-boot-requirements',
  'qa-headless-empty-diff',
  'qa-headless-trigger-discovery',
  'qa-headless-async-capture',
  'qa-headless-celery-sync',
  'qa-headless-regression',
];
const anySelected = selectedTests === null || allTestNames.some(t => selectedTests!.includes(t));

(anySelected ? describeOutcome : describe.skip)('/qa-headless E2E', () => {
  let workRoot: string;

  beforeAll(() => {
    workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-headless-e2e-'));
  });

  afterAll(() => {
    try { fs.rmSync(workRoot, { recursive: true, force: true }); } catch {}
  });

  /**
   * Sets up a fresh workdir with the qa-headless skill + a fixture dir copied in.
   * Returns the workdir path and the copied fixture dir.
   */
  function setupWorkdir(label: string, fixtureSubdir: string): { workDir: string; fixturePath: string; reportDir: string } {
    const workDir = fs.mkdtempSync(path.join(workRoot, `${label}-`));
    copyDirSync(path.join(ROOT, 'qa-headless'), path.join(workDir, 'qa-headless'));
    const fixtureSrc = path.join(FIXTURE_ROOT, fixtureSubdir);
    const fixtureDest = path.join(workDir, 'fixture');
    copyDirSync(fixtureSrc, fixtureDest);
    const reportDir = path.join(workDir, 'reports');
    fs.mkdirSync(reportDir, { recursive: true });
    return { workDir, fixturePath: fixtureDest, reportDir };
  }

  // ─── 1. Shape detection (deterministic, gate-tier) ─────────────────

  testConcurrentIfSelected('qa-headless-shape-detection', async () => {
    const { workDir, reportDir } = setupWorkdir('shape-detection', '');
    // Copy ALL fixtures (skill classifies each)
    copyDirSync(FIXTURE_ROOT, path.join(workDir, 'fixtures'));
    const reportPath = path.join(reportDir, 'classifications.json');

    const result = await runSkillTest({
      prompt: `You are running a focused subset of /qa-headless: SHAPE DETECTION ONLY.

Read the skill at ${workDir}/qa-headless/SKILL.md (focus on Phase 1 — Detect Feature Shape and the markers in qa-headless/references/framework-detection.md).

For EACH file listed below, classify its shape (one of: cron, queue worker, webhook handler, notifier, CLI, ETL) and detect its language.

Files to classify:
- ${workDir}/fixtures/py-cron-slack/run_call_digest.py
- ${workDir}/fixtures/py-cron-slack-no-dryrun/run_call_digest.py
- ${workDir}/fixtures/py-worker-celery/tasks.py
- ${workDir}/fixtures/py-webhook-handler/main.py
- ${workDir}/fixtures/py-async-httpx/notifier.py
- ${workDir}/fixtures/node-worker-bullmq/worker.js
- ${workDir}/fixtures/ruby-notifier-activejob/digest_notifier_job.rb
- ${workDir}/fixtures/go-cmd-notifier/main.go

Write the result to ${reportPath} as a JSON array of objects with this exact shape:
[
  {"path": "py-cron-slack/run_call_digest.py", "shape": "cron", "language": "python"},
  ...
]

Use ONLY these shape values: "cron", "queue worker", "webhook handler", "notifier", "CLI", "ETL".
Use ONLY these language values: "python", "node", "ruby", "go".

Do NOT run the scripts. Just READ them and classify based on imports + structural markers.`,
      workingDirectory: workDir,
      maxTurns: 30,
      timeout: 240_000,
      testName: 'qa-headless-shape-detection',
      runId,
    });

    logCost('/qa-headless shape-detection', result);

    if (result.exitReason !== 'success' && result.exitReason !== 'error_max_turns') {
      throw new Error(`shape-detection: unexpected exit reason: ${result.exitReason}`);
    }

    expect(fs.existsSync(reportPath)).toBe(true);
    const classifications = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
    const groundTruth = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'qa-headless-shape-detection-ground-truth.json'), 'utf-8'),
    );

    let correct = 0;
    for (const expected of groundTruth.expected_classifications) {
      const actual = classifications.find((c: any) =>
        c.path.endsWith(expected.path) || expected.path.endsWith(c.path)
      );
      if (actual && actual.shape === expected.shape && actual.language === expected.language) {
        correct++;
      }
    }

    recordE2E(evalCollector, '/qa-headless shape-detection', '/qa-headless E2E', result, {
      passed: correct >= groundTruth.minimum_correct,
      correct,
      total: groundTruth.total,
    } as any);

    expect(correct).toBeGreaterThanOrEqual(groundTruth.minimum_correct);
  }, 300_000);

  // ─── Helper for LLM-judged behavior tests ─────────────────────────

  async function runBehaviorEval(opts: {
    label: string;
    fixtureSubdir: string;
    groundTruthFile: string;
    prompt: (workDir: string, fixturePath: string, reportPath: string) => string;
    maxTurns?: number;
    timeoutMs?: number;
  }) {
    const { workDir, fixturePath, reportDir } = setupWorkdir(opts.label, opts.fixtureSubdir);
    const reportPath = path.join(reportDir, 'qa-headless-report.md');

    const result = await runSkillTest({
      prompt: opts.prompt(workDir, fixturePath, reportPath),
      workingDirectory: workDir,
      maxTurns: opts.maxTurns ?? 40,
      timeout: opts.timeoutMs ?? 300_000,
      testName: opts.label,
      runId,
    });

    logCost(`/qa-headless ${opts.label}`, result);

    if (result.exitReason !== 'success' && result.exitReason !== 'error_max_turns') {
      throw new Error(`${opts.label}: unexpected exit reason: ${result.exitReason}`);
    }

    let report: string | null = null;
    if (fs.existsSync(reportPath)) {
      report = fs.readFileSync(reportPath, 'utf-8');
    } else if (result.output && result.output.length > 100) {
      report = result.output;
    }

    if (!report) {
      dumpOutcomeDiagnostic(workDir, opts.label, '(no report)', { error: 'missing report' });
      recordE2E(evalCollector, `/qa-headless ${opts.label}`, '/qa-headless E2E', result, { error: 'no report' } as any);
      throw new Error(`No report file at ${reportPath}`);
    }

    const groundTruth = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'test', 'fixtures', opts.groundTruthFile), 'utf-8'),
    );

    const judgeResult = await outcomeJudge(groundTruth, report);
    console.log(`${opts.label}:`, JSON.stringify(judgeResult, null, 2));

    recordE2E(evalCollector, `/qa-headless ${opts.label}`, '/qa-headless E2E', result, {
      passed: judgePassed(judgeResult, groundTruth),
      detection_rate: judgeResult.detection_rate,
      false_positives: judgeResult.false_positives,
      detected_bugs: judgeResult.detected,
      missed_bugs: judgeResult.missed,
    } as any);

    if (judgeResult.detection_rate < groundTruth.minimum_detection ||
        judgeResult.false_positives > groundTruth.max_false_positives) {
      dumpOutcomeDiagnostic(workDir, opts.label, report, judgeResult);
    }

    expect(judgeResult.detection_rate).toBeGreaterThanOrEqual(groundTruth.minimum_detection);
    expect(judgeResult.false_positives).toBeLessThanOrEqual(groundTruth.max_false_positives);
  }

  // ─── 2. Python cron motivating case ──────────────────────────────

  testConcurrentIfSelected('qa-headless-python-cron', async () => {
    await runBehaviorEval({
      label: 'qa-headless-python-cron',
      fixtureSubdir: 'py-cron-slack',
      groundTruthFile: 'qa-headless-python-cron-ground-truth.json',
      prompt: (workDir, fixturePath, reportPath) => `Read ${workDir}/qa-headless/SKILL.md and run the FULL /qa-headless workflow against:
  Target: ${fixturePath}/run_call_digest.py
  Trigger args: --date=2026-04-15 --dry-run

Detect the shape, discover trigger args, check boot prerequisites (none — pure stdlib + requests),
use the existing --dry-run flag, capture the Slack POSTs, render Block Kit as a structured tree,
and write a report to ${reportPath}.

The script's expected summary output is: "5 groups, 9 calls, 1 unrouted, Block Kit valid, ship-ready"
Verify your run produces this summary and include it in the report.`,
    });
  }, 360_000);

  // ─── 3. Dry-run proposal ─────────────────────────────────────────

  testConcurrentIfSelected('qa-headless-dry-run-proposal', async () => {
    await runBehaviorEval({
      label: 'qa-headless-dry-run-proposal',
      fixtureSubdir: 'py-cron-slack-no-dryrun',
      groundTruthFile: 'qa-headless-dry-run-proposal-ground-truth.json',
      prompt: (workDir, fixturePath, reportPath) => `Read ${workDir}/qa-headless/SKILL.md, focus on Phase 4 (Find or Propose a Dry-Run Harness).

Target: ${fixturePath}/run_call_digest.py

This script POSTs to Slack with NO --dry-run flag. /qa-headless must:
1. Detect the absence of dry-run
2. Propose a unified diff that adds one
3. NOT execute the script unmodified (would actually POST)

Write a report to ${reportPath} explaining what you detected and what diff you would propose. Include the proposed diff in the report. Do NOT actually invoke requests.post — that would hit a real Slack URL.`,
    });
  }, 360_000);

  // ─── 4. Boot requirements ─────────────────────────────────────────

  testConcurrentIfSelected('qa-headless-boot-requirements', async () => {
    await runBehaviorEval({
      label: 'qa-headless-boot-requirements',
      fixtureSubdir: 'py-webhook-handler',
      groundTruthFile: 'qa-headless-boot-requirements-ground-truth.json',
      prompt: (workDir, fixturePath, reportPath) => `Read ${workDir}/qa-headless/SKILL.md, focus on Phase 3 (Detect Boot Requirements).

Target: ${fixturePath}/main.py

This script imports sqlite3 and reads DB_PATH from env. Without DB_PATH set, /qa-headless must:
1. Static-scan the file and detect sqlite3 + DB_PATH env var
2. Check (live probe or env check) that DB_PATH is unset
3. Surface a clear pre-run error naming the missing prerequisite
4. NOT run the script with a guessed default

Write a report to ${reportPath} explaining what prerequisites you detected, which are missing, and the exact error message you would surface. Treat DB_PATH as unset (do not set it).`,
    });
  }, 360_000);

  // ─── 5. Empty diff fallback ───────────────────────────────────────

  testConcurrentIfSelected('qa-headless-empty-diff', async () => {
    await runBehaviorEval({
      label: 'qa-headless-empty-diff',
      fixtureSubdir: 'py-cron-slack',
      groundTruthFile: 'qa-headless-empty-diff-ground-truth.json',
      prompt: (workDir, fixturePath, reportPath) => `Read ${workDir}/qa-headless/SKILL.md, focus on Phase 1's empty-diff fallback.

Scenario: user is on a branch with NO uncommitted changes and NO diff vs main. They run /qa-headless to test a cron that has been live for months.

Working directory contains: ${fixturePath}/
Files in fixture: run_call_digest.py, Procfile, README.md

Without any diff hint, /qa-headless must:
1. Detect that diff is empty
2. Scan the repo for cron-like / worker-like / CLI-like entry points
3. Present candidates to the user (in your case: write the candidates list to ${reportPath})
4. NOT silently dead-end with "nothing to QA"

Write a report to ${reportPath} listing the entry-point candidates you found and which one you would propose the user picks. Include your scanning approach (which directories / file patterns you looked for).`,
    });
  }, 360_000);

  // ─── 6. Trigger discovery ─────────────────────────────────────────

  testConcurrentIfSelected('qa-headless-trigger-discovery', async () => {
    await runBehaviorEval({
      label: 'qa-headless-trigger-discovery',
      fixtureSubdir: 'py-cron-slack',
      groundTruthFile: 'qa-headless-trigger-discovery-ground-truth.json',
      prompt: (workDir, fixturePath, reportPath) => `Read ${workDir}/qa-headless/SKILL.md, focus on Phase 2 (Discover Trigger Inputs).

Target: ${fixturePath}/run_call_digest.py

Parse the argparse spec. Identify all args (required vs optional, with defaults).
Propose an exact invocation command that /qa-headless would run.

Write your discovery output to ${reportPath} including:
- Each arg discovered with its type, default, and help text
- The proposed invocation command (full python ... line)
- Which args you auto-filled vs which would need the user to provide`,
    });
  }, 360_000);

  // ─── 7. Async capture ─────────────────────────────────────────────

  testConcurrentIfSelected('qa-headless-async-capture', async () => {
    await runBehaviorEval({
      label: 'qa-headless-async-capture',
      fixtureSubdir: 'py-async-httpx',
      groundTruthFile: 'qa-headless-async-capture-ground-truth.json',
      prompt: (workDir, fixturePath, reportPath) => `Read ${workDir}/qa-headless/SKILL.md, focus on Phase 5 (Capture Side Effects) and qa-headless/references/capture-libs.md.

Target: ${fixturePath}/notifier.py

This file uses httpx.AsyncClient (NOT plain requests, NOT sync httpx). /qa-headless must:
1. Detect the async httpx.AsyncClient import
2. Select an async-capable mock library (respx is the right answer)
3. NOT pick 'responses' (which would silently miss async calls)

Write a report to ${reportPath} explaining:
- What HTTP client you detected and whether it's sync or async
- Which capture library you would select and why
- Why other libraries (responses, requests-mock) would be wrong here`,
    });
  }, 360_000);

  // ─── 8. Celery sync invocation ────────────────────────────────────

  testConcurrentIfSelected('qa-headless-celery-sync', async () => {
    await runBehaviorEval({
      label: 'qa-headless-celery-sync',
      fixtureSubdir: 'py-worker-celery',
      groundTruthFile: 'qa-headless-celery-sync-ground-truth.json',
      prompt: (workDir, fixturePath, reportPath) => `Read ${workDir}/qa-headless/SKILL.md, focus on Phase 2 (queue worker invocation).

Target: ${fixturePath}/tasks.py

This file defines a Celery task with @shared_task. /qa-headless must invoke it SYNCHRONOUSLY using .apply() — NOT .delay() (which needs a Redis broker + running celery worker process).

Write a report to ${reportPath} explaining:
- The task signature you discovered
- The exact synchronous invocation: send_user_notification.apply(args=[...], kwargs={...})
- Why you chose .apply() over .delay() / starting a broker
- What kwargs you would pass (including dry_run=True)`,
    });
  }, 360_000);

  // ─── 9. Regression (gate-tier) ────────────────────────────────────

  testConcurrentIfSelected('qa-headless-regression', async () => {
    const { workDir, fixturePath, reportDir } = setupWorkdir('regression', 'py-cron-slack');
    const reportPath = path.join(reportDir, 'qa-headless-report.md');

    const result = await runSkillTest({
      prompt: `Read ${workDir}/qa-headless/SKILL.md and run the full workflow against:
  Target: ${fixturePath}/run_call_digest.py --date=2026-04-15 --dry-run

You may invoke the script with: python ${fixturePath}/run_call_digest.py --date=2026-04-15 --dry-run

Capture the printed summary line. Write a report to ${reportPath} that includes the exact summary line printed by the script in a code block.`,
      workingDirectory: workDir,
      maxTurns: 30,
      timeout: 240_000,
      testName: 'qa-headless-regression',
      runId,
    });

    logCost('/qa-headless regression', result);

    expect(fs.existsSync(reportPath)).toBe(true);
    const report = fs.readFileSync(reportPath, 'utf-8');
    const golden = fs.readFileSync(
      path.join(FIXTURE_ROOT, 'py-cron-slack', 'golden.txt'),
      'utf-8',
    ).trim();

    recordE2E(evalCollector, '/qa-headless regression', '/qa-headless E2E', result, {
      passed: report.includes(golden),
      golden,
    } as any);

    expect(report).toContain(golden);
  }, 300_000);
});

afterAll(async () => {
  await finalizeEvalCollector(evalCollector);
});
