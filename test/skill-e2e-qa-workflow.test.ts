import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { runSkillTest } from './helpers/session-runner';
import {
  ROOT, browseBin, runId, evalsEnabled,
  describeIfSelected, testConcurrentIfSelected,
  copyDirSync, setupBrowseShims, logCost, recordE2E,
  createEvalCollector, finalizeEvalCollector,
} from './helpers/e2e-helpers';
import { startTestServer } from '../browse/test/test-server';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const evalCollector = createEvalCollector('e2e-qa-workflow');

// --- B4: QA skill E2E ---

describeIfSelected('QA skill E2E', ['qa-quick'], () => {
  let qaDir: string;
  let testServer: ReturnType<typeof startTestServer>;

  beforeAll(() => {
    testServer = startTestServer();
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

  testConcurrentIfSelected('qa-quick', async () => {
    const result = await runSkillTest({
      prompt: `B="${browseBin}"

The test server is already running at: ${testServer.url}
Target page: ${testServer.url}/basic.html

Read the file qa/SKILL.md for the QA workflow instructions.
Skip the preamble bash block, lake intro, telemetry, and contributor mode sections — go straight to the QA workflow.

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
    recordE2E(evalCollector, '/qa quick', 'QA skill E2E', result, {
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

// --- QA-Only E2E (report-only, no fixes) ---

describeIfSelected('QA-Only skill E2E', ['qa-only-no-fix'], () => {
  let qaOnlyDir: string;
  let testServer: ReturnType<typeof startTestServer>;

  beforeAll(() => {
    testServer = startTestServer();
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

  testConcurrentIfSelected('qa-only-no-fix', async () => {
    const result = await runSkillTest({
      prompt: `IMPORTANT: The browse binary is already assigned below as B. Do NOT search for it or run the SKILL.md setup block — just use $B directly.

B="${browseBin}"

Read the file qa-only/SKILL.md for the QA-only workflow instructions.
Skip the preamble bash block, lake intro, telemetry, and contributor mode sections — go straight to the QA workflow.

Run a Quick QA test on ${testServer.url}/qa-eval.html
Do NOT use AskUserQuestion — run Quick tier directly.
Write your report to ${qaOnlyDir}/qa-reports/qa-only-report.md`,
      workingDirectory: qaOnlyDir,
      maxTurns: 40,
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
    recordE2E(evalCollector, '/qa-only no-fix', 'QA-Only skill E2E', result, {
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

  testConcurrentIfSelected('qa-fix-loop', async () => {
    const qaFixUrl = `http://127.0.0.1:${qaFixServer!.port}`;

    const result = await runSkillTest({
      prompt: `You have a browse binary at ${browseBin}. Assign it to B variable like: B="${browseBin}"

Read the file qa/SKILL.md for the QA workflow instructions.
Skip the preamble bash block, lake intro, telemetry, and contributor mode sections — go straight to the QA workflow.

Run a Quick-tier QA test on ${qaFixUrl}
The source code for this page is at ${qaFixDir}/index.html — you can fix bugs there.
Do NOT use AskUserQuestion — run Quick tier directly.
Write your report to ${qaFixDir}/qa-reports/qa-report.md

This is a test+fix loop: find bugs, fix them in the source code, commit each fix, and re-verify.`,
      workingDirectory: qaFixDir,
      maxTurns: 40,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
      timeout: 420_000,
      testName: 'qa-fix-loop',
      runId,
    });

    logCost('/qa fix loop', result);
    recordE2E(evalCollector, '/qa fix loop', 'QA Fix Loop E2E', result, {
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
  }, 480_000);
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

  testConcurrentIfSelected('qa-bootstrap', async () => {
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
      timeout: 90_000,
      testName: 'qa-bootstrap',
      runId,
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

    try { fs.rmSync(bsDir, { recursive: true, force: true }); } catch {}
  }, 120_000);
});

// Module-level afterAll — finalize eval collector after all tests complete
afterAll(async () => {
  await finalizeEvalCollector(evalCollector);
});
