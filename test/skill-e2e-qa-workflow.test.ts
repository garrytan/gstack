import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { JUDGE_MS, CAPTURE_MS, CAPTURE_LONG_MS } from './helpers/eval-budgets';
import { runSkillTest, SESSION_DRAIN_GRACE_MS } from './helpers/session-runner';
import { registerBootstrapRetention } from './helpers/bootstrap-retention';
import { stopQaOnlyBrowser } from './helpers/qa-only-cleanup';
import { getProjectEvalDir } from './helpers/eval-store';
import { assertQaBrowserDeadline, assertQaBrowserPreparation, assertQaBrowserCheckpoints, qaDeadlineShellPolicy } from './helpers/qa-browser-deadline-evidence';
import { resolveEvalModel } from '../lib/eval-model';
import {
  ROOT, browseBin, runId, evalsEnabled, selectedTests,
  describeIfSelected, testConcurrentIfSelected,
  copyDirSync, setupBrowseShims, logCost, recordE2E,
  createEvalCollector, finalizeEvalCollector,
} from './helpers/e2e-helpers';
import { asideAvailable } from './helpers/aside-available';
import { startTestServer } from '../browse/test/test-server';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const evalCollector = createEvalCollector('e2e-qa-workflow');

// /qa and /qa-only drive the Aside browser first and fall back to the gstack
// browse binary. The browser-driving describes need one of the two — a live
// Aside or a built browse/dist/browse (CI builds it, so the Linux lane runs
// the fallback path). Neither → skip, never fail. qa-bootstrap opens no
// browser and is not gated.
const browserSelected = evalsEnabled && (asideAvailable() || fs.existsSync(browseBin)) ? selectedTests : [];

// The skill's BROWSER SETUP decides Aside vs fallback; the prompt only tells the
// agent where the fallback binary is (the hermetic HOME has no global install).
const browserPrompt = (skillMd: string) =>
  `Follow the BROWSER SETUP section in ${skillMd} exactly: it probes for Aside first and falls back to the gstack browse binary. If it falls back, the browse binary is at ${browseBin} (B="${browseBin}"; find-browse is shimmed under browse/bin in this directory). Do not look for any other browser. The trusted deadline guard for this owned installation is ${path.join(ROOT, 'bin', 'gstack-qa-deadline')}; use that exact absolute path for G, not an ambient installation. Keep its deadline.json in the caller-owned qa-reports directory, and never replace or edit it directly.`;

// --- B4: QA skill E2E ---

describeIfSelected('QA skill E2E', ['qa-quick'], () => {
  let qaDir: string;
  let testServer: ReturnType<typeof startTestServer>;

  beforeAll(() => {
    testServer = startTestServer();
    qaDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'skill-e2e-qa-'));
    setupBrowseShims(qaDir);

    // Copy qa skill files into tmpDir
    copyDirSync(path.join(ROOT, 'qa'), path.join(qaDir, 'qa'));

    // Create report directory
    fs.mkdirSync(path.join(qaDir, 'qa-reports'), { recursive: true });

    for (const args of [['init', '-b', 'main'], ['config', 'user.email', 'test@test.com'], ['config', 'user.name', 'Test'],
      ['add', '.'], ['commit', '-m', 'initial']]) {
      const git = spawnSync('git', args, { cwd: qaDir, stdio: 'pipe', timeout: 5000 });
      if (git.error) throw git.error;
      if (git.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${git.stderr}`);
    }
  });

  afterAll(() => {
    testServer?.server?.stop();
    try { fs.rmSync(qaDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('qa-quick', async () => {
    const result = await runSkillTest({
      prompt: `${browserPrompt('qa/SKILL.md')}

The test server is already running at: ${testServer.url}
Target page: ${testServer.url}/basic.html

Read the file qa/SKILL.md for the QA workflow instructions.
qa is a carved skill: when SKILL.md tells you to Read ~/.claude/skills/gstack/qa/sections/<file>, read qa/sections/<file> in this working directory instead (same content, local copy).
Skip the preamble bash block, lake intro, telemetry, and contributor mode sections — go straight to the QA workflow.

Run a Quick-depth QA test on ${testServer.url}/basic.html
This fixture is one static page with two same-origin navigation links (/page1, /page2) and one external link; Quick scope is that page and its two same-origin links.
As the caller, I set a 30-second total probe limit for this run (shorter than Browser Quick's own budget), so start the deadline with SECONDS=30.
Write concise checkpoints and a concise report, retaining required evidence, scores and untested-coverage fields; cite evidence IDs instead of repeating commands.
Do NOT use AskUserQuestion — run Quick tier directly.
Do NOT try to start a server or discover ports — the URL above is ready.
Write your report to ${qaDir}/qa-reports/qa-report.md`,
      workingDirectory: qaDir,
      maxTurns: 35,
      timeout: CAPTURE_MS,
      testName: 'qa-quick',
      runId,
    });

    logCost('/qa quick', result);
    recordE2E(evalCollector, '/qa quick', 'QA skill E2E', result, {
      passed: ['success', 'error_max_turns'].includes(result.exitReason),
    });
    // browseErrors can include false positives from hallucinated paths
    if (result.browseErrors.length > 0) {
      console.warn('/qa quick browse errors (non-fatal):', result.browseErrors);
    }
    // Accept error_max_turns — the agent doing thorough QA work is not a failure
    expect(['success', 'error_max_turns']).toContain(result.exitReason);
  }, CAPTURE_MS + SESSION_DRAIN_GRACE_MS + 5_000);
}, browserSelected);

// --- QA-Only E2E (report-only, no fixes) ---

describeIfSelected('QA-Only skill E2E', ['qa-only-no-fix'], () => {
  const finalizeMs = SESSION_DRAIN_GRACE_MS + 5_000;
  let attempt = 0;
  testConcurrentIfSelected('qa-only-no-fix', async () => {
    const started = Date.now();
    const remainingWorkMs = () => {
      const remaining = started + CAPTURE_MS - Date.now();
      if (remaining <= 0) throw new Error('QA-only work budget exhausted');
      return remaining;
    };
    const attemptRunId = `${process.env.EVALS_RUN_ID ?? runId}-qa-only-${process.pid}-${++attempt}`;
    let qaOnlyDir: string | undefined;
    let testServer: ReturnType<typeof startTestServer> | undefined;
    let result: Awaited<ReturnType<typeof runSkillTest>> | undefined;
    let passed = false;
    let failure: unknown;
    try {
      qaOnlyDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'skill-e2e-qa-only-'));
      testServer = startTestServer();
      setupBrowseShims(qaOnlyDir);
      copyDirSync(path.join(ROOT, 'qa-only'), path.join(qaOnlyDir, 'qa-only'));
      copyDirSync(path.join(ROOT, 'qa', 'sections'), path.join(qaOnlyDir, 'qa', 'sections'));
      copyDirSync(path.join(ROOT, 'qa', 'templates'), path.join(qaOnlyDir, 'qa', 'templates'));

      const run = (cmd: string, args: string[]) => {
        const command = spawnSync(cmd, args, { cwd: qaOnlyDir, stdio: 'pipe', timeout: 5000 });
        if (command.error) throw command.error;
        expect(command.status, command.stderr.toString()).toBe(0);
      };
      run('git', ['init', '-b', 'main']);
      run('git', ['config', 'user.email', 'test@test.com']);
      run('git', ['config', 'user.name', 'Test']);
      fs.copyFileSync(path.join(ROOT, 'browse/test/fixtures/qa-only.html'), path.join(qaOnlyDir, 'index.html'));
      fs.copyFileSync(path.join(ROOT, 'test/fixtures/qa-only-browser-probe.ts'), path.join(qaOnlyDir, 'fixture-browser-probe.ts'));
      run('git', ['add', '.']);
      run('git', ['commit', '-m', 'initial']);
      fs.mkdirSync(path.join(qaOnlyDir, 'qa-reports/screenshots'), { recursive: true });
      const deadlinePolicy = qaDeadlineShellPolicy(qaOnlyDir, path.join(ROOT, 'bin/gstack-qa-deadline'), browseBin);

      result = await runSkillTest({
        prompt: `${browserPrompt('qa-only/SKILL.md')}

Read the file qa-only/SKILL.md for the QA-only workflow instructions.
The qa-only/ and qa/ directories here are the owned installed skill assets for this run, not product-directory substitutes. Resolve installed qa/gstack-qa section references (including ~/.claude/skills/gstack/qa/sections/<file>) to ${qaOnlyDir}/qa/sections/<file>, qa-only/gstack-qa-only section references to ${qaOnlyDir}/qa-only/sections/<file>, and qa template references to ${qaOnlyDir}/qa/templates/<file>. Do not discover or read an ambient skill installation.
Skip the preamble bash block, lake intro, telemetry, and contributor mode sections — go straight to the QA workflow.

Run a Quick QA test on ${testServer.url}/qa-only.html
This fixture has one static homepage, one console error, no links or user journeys, and no test framework. Its index.html is an exact copy of the served page. Scope this run to homepage load and console health; do not expand into navigation, form, visual-design or framework-discovery audits.
Write one concise charter and a concise report, retaining required evidence, scores and untested-coverage fields. Use short factual summaries and evidence IDs instead of repeating full commands or the charter in multiple sections.
Use the supplied read-only browser probe for the baseline and any replay, as this child command after the guard's --: bash -c 'bun "${path.join(qaOnlyDir, 'fixture-browser-probe.ts')}" "${browseBin}" "${testServer.url}/qa-only.html" "${path.join(qaOnlyDir, 'qa-reports/screenshots/initial.png')}"'
Run it inside the deadline guard. It navigates, reads console errors and saves the screenshot, returning one JSON object with actual command outputs and exit codes. Preserve that decoded object in checkpoints. This case tests report-only authority and provenance; terminal-text framing is covered separately by deterministic regressions.
For a replay, pass a fresh screenshot filename in the same screenshots directory; the probe refuses to overwrite earlier evidence.
Do NOT use AskUserQuestion — run Quick tier directly.
Use ${qaOnlyDir}/qa-reports as the caller-owned directory for all reports, checkpoints and screenshots.
${deadlinePolicy.prompt}
Run guarded calls sequentially, waiting for each result before dispatching the next call.
Write your report to ${qaOnlyDir}/qa-reports/qa-only-report.md`,
        workingDirectory: qaOnlyDir,
        maxTurns: 40,
        allowedTools: ['Bash', 'Read', 'Write', 'Glob'],
        tools: ['Bash', 'Read', 'Write', 'Glob'],
        timeout: remainingWorkMs(),
        testName: 'qa-only-no-fix',
        runId: attemptRunId,
        publicStreamDiagnostics: true,
      });

      logCost('/qa-only', result);
      const editCalls = result.toolCalls.filter(tc => tc.tool === 'Edit');
      if (editCalls.length > 0) {
        console.warn('qa-only used Edit tool:', editCalls.length, 'times');
      }
      expect(editCalls).toHaveLength(0);
      expect(['success', 'error_max_turns']).toContain(result.exitReason);

      const gitStatus = spawnSync('git', ['status', '--porcelain'], {
        cwd: qaOnlyDir, stdio: 'pipe', timeout: 30_000,
      });
      if (gitStatus.error) throw gitStatus.error;
      expect(gitStatus.status, gitStatus.stderr.toString()).toBe(0);
      const statusLines = gitStatus.stdout.toString().trim().split('\n').filter(
        (l: string) => l.trim() && !l.includes('.prompt-tmp') && !l.includes('.gstack/') && !l.includes('qa-reports/'),
      );
      expect(statusLines).toHaveLength(0);
      assertQaBrowserDeadline(result.toolCalls, {
        directory: qaOnlyDir, guard: path.join(ROOT, 'bin/gstack-qa-deadline'), browse: browseBin,
        started, ended: Date.now(),
      });
      assertQaBrowserPreparation(result.transcript, {
        directory: qaOnlyDir, guard: path.join(ROOT, 'bin/gstack-qa-deadline'),
      });
      assertQaBrowserCheckpoints(result.transcript, {
        directory: qaOnlyDir, guard: path.join(ROOT, 'bin/gstack-qa-deadline'), browse: browseBin,
      });
      passed = true;
    } catch (error) {
      failure = error;
    } finally {
      let artifactFailure: unknown;
      const fail = (error: unknown, stage: string) => {
        failure = failure ? new AggregateError([failure, error], `QA-only attempt and ${stage} failed: ${failure instanceof Error ? failure.message : failure}; ${error instanceof Error ? error.message : error}`) : error;
        passed = false;
      };
      try {
        if (qaOnlyDir && fs.existsSync(path.join(qaOnlyDir, 'qa-reports'))) {
          const artifactDir = path.join(path.dirname(getProjectEvalDir()), 'e2e-runs', attemptRunId);
          fs.mkdirSync(artifactDir, { recursive: true });
          fs.cpSync(path.join(qaOnlyDir, 'qa-reports'), path.join(artifactDir, 'qa-reports'), { recursive: true });
        }
      } catch (error) {
        artifactFailure = error;
        fail(error, 'artifact preservation');
      }
      let browserStopped = false;
      try {
        if (qaOnlyDir) await stopQaOnlyBrowser(qaOnlyDir, Math.min(4_000, started + CAPTURE_MS + finalizeMs - Date.now() - 1_000));
        browserStopped = true;
      } catch (error) {
        fail(error, 'browser cleanup');
      }
      try {
        testServer?.server.stop();
        if (qaOnlyDir && browserStopped && !artifactFailure) fs.rmSync(qaOnlyDir, { recursive: true, force: true });
      } catch (error) {
        fail(error, 'fixture cleanup');
      }
      const error = failure instanceof Error ? failure.message : String(failure ?? 'QA-only attempt did not complete');
      try {
        if (result) {
          const billed = typeof result.transcript.findLast(event => event.type === 'result')?.total_cost_usd === 'number';
          recordE2E(evalCollector, '/qa-only no-fix', 'QA-Only skill E2E', result, {
            passed, ...(passed ? {} : { error: billed ? error : `${error}\nNo terminal billing result; actual cost is unknown.` }),
          });
        } else {
          evalCollector?.addTest({
            name: '/qa-only no-fix', suite: 'QA-Only skill E2E', tier: 'e2e', passed: false,
            duration_ms: Date.now() - started, cost_usd: 0,
            model: process.env.EVALS_MODEL ?? resolveEvalModel('capture'),
            exit_reason: 'harness_error',
            error: `${error}\nRunner returned no result; cost and usage unavailable.`,
          });
        }
      } catch (recordError) {
        fail(recordError, 'recording');
      }
      if (failure) throw failure;
    }
  }, CAPTURE_MS + finalizeMs);
}, browserSelected);

// --- QA Fix Loop E2E ---

describeIfSelected('QA Fix Loop E2E', ['qa-fix-loop'], () => {
  // Separate the existing process drain and recording from the work ceiling.
  const finalizeMs = SESSION_DRAIN_GRACE_MS + 5_000;
  testConcurrentIfSelected('qa-fix-loop', async () => {
    const started = Date.now();
    const remainingWorkMs = () => {
      const remaining = started + CAPTURE_LONG_MS - Date.now();
      if (remaining <= 0) throw new Error('QA fix-loop work budget exhausted');
      return remaining;
    };
    const qaFixDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'skill-e2e-qa-fix-'));
    let qaFixServer: ReturnType<typeof Bun.serve> | null = null;
    let result: Awaited<ReturnType<typeof runSkillTest>> | undefined;
    let passed = false;
    let failure: unknown;
    // Bun retries the body: each attempt owns fresh source, server and cleanup.
    try {
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
          if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
            return new Response('Not Found', { status: 404 });
          }
          const content = fs.readFileSync(fullPath, 'utf-8');
          return new Response(content, {
            headers: { 'Content-Type': 'text/html' },
          });
        },
      });

      const initial = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: qaFixDir, stdio: 'pipe', timeout: 5000 });
      if (initial.status !== 0) throw new Error('QA fixture initial commit failed');
      const initialCommit = initial.stdout.toString().trim();
      const qaFixUrl = `http://127.0.0.1:${qaFixServer!.port}`;

      result = await runSkillTest({
        prompt: `${browserPrompt('qa/SKILL.md')}

Read the file qa/SKILL.md for the QA workflow instructions.
qa is a carved skill: when SKILL.md tells you to Read ~/.claude/skills/gstack/qa/sections/<file>, read qa/sections/<file> in this working directory instead (same content, local copy).
Skip the preamble bash block, lake intro, telemetry, and contributor mode sections — go straight to the QA workflow.

Run a Quick-tier QA test on ${qaFixUrl}
The source code for this page is at ${qaFixDir}/index.html — use the Edit tool for source fixes; keep Bash for browser and git commands.
Do NOT use AskUserQuestion — run Quick tier directly.
Write your report to ${qaFixDir}/qa-reports/qa-report.md

This is a test+fix loop: find bugs, fix them in the source code, commit each fix, and re-verify.`,
        workingDirectory: qaFixDir,
        maxTurns: 40,
        allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
        timeout: remainingWorkMs(),
        testName: 'qa-fix-loop',
        runId,
      });

      logCost('/qa fix loop', result);

      // Accept error_max_turns — fix loop may use many turns
      expect(['success', 'error_max_turns']).toContain(result.exitReason);

      // Verify at least one fix commit was made beyond the initial commit
      const gitLog = spawnSync('git', ['log', '--oneline'], {
        cwd: qaFixDir, stdio: 'pipe', timeout: Math.min(30_000, remainingWorkMs()),
      });
      const commits = gitLog.stdout.toString().trim().split('\n');
      console.log(`/qa fix loop: ${commits.length} commits total (1 initial + ${commits.length - 1} fixes)`);
      expect(commits.length).toBeGreaterThan(1);

      // Require a committed change to the seeded source, independent of tool.
      const sourceDiff = spawnSync('git', ['diff', '--exit-code', initialCommit, 'HEAD', '--', 'index.html'], {
        cwd: qaFixDir, stdio: 'pipe', timeout: 30_000,
      });
      expect(sourceDiff.status).toBe(1);
      expect(sourceDiff.stdout.toString().trim().length).toBeGreaterThan(0);
      passed = true;
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      // Record only after the existing assertions settle; a process can finish
      // successfully while its fixture assertions fail.
      try {
        const error = passed ? undefined : failure instanceof Error ? failure.message : String(failure);
        if (result) {
          recordE2E(evalCollector, '/qa fix loop', 'QA Fix Loop E2E', result, {
            passed, ...(passed ? {} : { error }),
          });
        } else {
          evalCollector?.addTest({
            name: '/qa fix loop', suite: 'QA Fix Loop E2E', tier: 'e2e', passed: false,
            duration_ms: Date.now() - started, cost_usd: 0,
            model: process.env.EVALS_MODEL ?? resolveEvalModel('capture'),
            exit_reason: 'harness_error',
            error: `${error}\nRunner returned no result; cost and usage unavailable.`,
          });
        }
      } catch (recordError) {
        if (!passed) throw new AggregateError([failure, recordError], 'QA fix-loop attempt and recording failed');
        throw recordError;
      } finally {
        qaFixServer?.stop();
        try { fs.rmSync(qaFixDir, { recursive: true, force: true }); } catch {}
      }
    }
  }, CAPTURE_LONG_MS + finalizeMs);
}, browserSelected);

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

  testConcurrentIfSelected('qa-bootstrap', async () => {
    const bootstrapDeadline = Date.now() + JUDGE_MS;
    // Test ONLY the bootstrap phase — install vitest, create config, write one test
    const bsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-bs-'));

    // Minimal Node.js project with no test framework
    fs.writeFileSync(path.join(bsDir, 'package.json'), JSON.stringify({
      name: 'bootstrap-test-app', version: '1.0.0', type: 'module',
    }, null, 2));
    fs.writeFileSync(path.join(bsDir, 'app.js'), `
export function add(a, b) { return a + b; }
export function subtract(a, b) { return a - b; }
export function divide(a, b) { return a / b; }
`);

    // Init git repo
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: bsDir, stdio: 'pipe', timeout: 5000 });
    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'initial']);

    const retention = process.env.GSTACK_BOOTSTRAP_RETENTION
      ? registerBootstrapRetention(bsDir, process.env.EVALS_RUN_ID || runId, { deadline: bootstrapDeadline })
      : undefined;
    let bootstrapFailure: unknown;
    try {
      const result = await runSkillTest({
        prompt: `This is a Node.js project with no test framework. It has a package.json and app.js with simple functions (add, subtract, divide).

Set up a test framework:
1. Install vitest: bun add -d vitest
2. Create vitest.config.ts with a minimal config
3. Write one test file (app.test.js) that tests the add() function
4. Run the test to verify it passes
5. Create TESTING.md explaining how to run tests

Do NOT fix any bugs. Do NOT use AskUserQuestion — just pick vitest.`,
        workingDirectory: bsDir,
        maxTurns: 12,
        allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob'],
        timeout: JUDGE_MS,
        testName: 'qa-bootstrap',
        runId,
        ...(retention ? { nativeLifecycle: retention.lifecycle } : {}),
      });

      logCost('/qa bootstrap', result);

      const hasTestConfig = fs.existsSync(path.join(bsDir, 'vitest.config.ts'))
        || fs.existsSync(path.join(bsDir, 'vitest.config.js'));
      const hasTestFile = fs.readdirSync(bsDir).some(f => f.includes('.test.'));
      const hasTestingMd = fs.existsSync(path.join(bsDir, 'TESTING.md'));

      recordE2E(evalCollector, '/qa bootstrap', 'Test Bootstrap E2E', result, {
        passed: hasTestConfig && ['success', 'error_max_turns'].includes(result.exitReason),
      });

      expect(['success', 'error_max_turns']).toContain(result.exitReason);
      expect(hasTestConfig).toBe(true);
      console.log(`Test config: ${hasTestConfig}, Test file: ${hasTestFile}, TESTING.md: ${hasTestingMd}`);
    } catch (error) {
      bootstrapFailure = error;
      throw error;
    } finally {
      try {
        if (retention) retention.cleanup();
        else { try { fs.rmSync(bsDir, { recursive: true, force: true }); } catch {} }
      }
      catch (error) {
        if (bootstrapFailure) throw new AggregateError([bootstrapFailure, error], 'bootstrap assertion and retention failed');
        throw error;
      }
    }
  }, JUDGE_MS);
});

// Module-level afterAll — finalize eval collector after all tests complete.
// Explicit 60s timeout: finalize does a JSON save + cross-run comparison and
// has been observed at 6.26s, past bun's 5s default hook timeout.
afterAll(async () => {
  await finalizeEvalCollector(evalCollector);
}, 60_000);
