import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { runSkillTest } from './helpers/session-runner';
import {
  ROOT, browseBin, runId, evalsEnabled,
  describeIfSelected, testConcurrentIfSelected,
  copyDirSync, setupBrowseShims, logCost, recordE2E,
  createEvalCollector, finalizeEvalCollector,
} from './helpers/e2e-helpers';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const evalCollector = createEvalCollector('e2e-deploy');

// --- Land-and-Deploy E2E ---

describeIfSelected('Land-and-Deploy skill E2E', ['land-and-deploy-workflow'], () => {
  let landDir: string;

  beforeAll(() => {
    landDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-land-deploy-'));
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: landDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    fs.writeFileSync(path.join(landDir, 'app.ts'), 'export function hello() { return "world"; }\n');
    fs.writeFileSync(path.join(landDir, 'fly.toml'), 'app = "test-app"\n\n[http_service]\n  internal_port = 3000\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'initial']);

    run('git', ['checkout', '-b', 'feat/add-deploy']);
    fs.writeFileSync(path.join(landDir, 'app.ts'), 'export function hello() { return "deployed"; }\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'feat: update hello']);

    copyDirSync(path.join(ROOT, 'land-and-deploy'), path.join(landDir, 'land-and-deploy'));
  });

  afterAll(() => {
    try { fs.rmSync(landDir, { recursive: true, force: true }); } catch {}
  });

  test('/land-and-deploy detects Fly.io platform and produces deploy report structure', async () => {
    const result = await runSkillTest({
      prompt: `Read land-and-deploy/SKILL.md for the /land-and-deploy skill instructions.

You are on branch feat/add-deploy with changes against main. This repo has a fly.toml
with app = "test-app", indicating a Fly.io deployment.

IMPORTANT: There is NO remote and NO GitHub PR — you cannot run gh commands.
Instead, simulate the workflow:
1. Detect the deploy platform from fly.toml (should find Fly.io, app = test-app)
2. Infer the production URL (https://test-app.fly.dev)
3. Note the merge method would be squash
4. Write the deploy configuration to CLAUDE.md
5. Write a deploy report skeleton to .gstack/deploy-reports/report.md showing the
   expected report structure (PR number: simulated, timing: simulated, verdict: simulated)

Do NOT use AskUserQuestion. Do NOT run gh or fly commands.`,
      workingDirectory: landDir,
      maxTurns: 20,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob'],
      timeout: 120_000,
      testName: 'land-and-deploy-workflow',
      runId,
    });

    logCost('/land-and-deploy', result);
    recordE2E(evalCollector, '/land-and-deploy workflow', 'Land-and-Deploy skill E2E', result);
    expect(result.exitReason).toBe('success');

    const claudeMd = path.join(landDir, 'CLAUDE.md');
    if (fs.existsSync(claudeMd)) {
      const content = fs.readFileSync(claudeMd, 'utf-8');
      const hasFly = content.toLowerCase().includes('fly') || content.toLowerCase().includes('test-app');
      expect(hasFly).toBe(true);
    }

    const reportDir = path.join(landDir, '.gstack', 'deploy-reports');
    expect(fs.existsSync(reportDir)).toBe(true);
  }, 180_000);
});

// --- Canary skill E2E ---

describeIfSelected('Canary skill E2E', ['canary-workflow'], () => {
  let canaryDir: string;

  beforeAll(() => {
    canaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-canary-'));
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: canaryDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    fs.writeFileSync(path.join(canaryDir, 'index.html'), '<h1>Hello</h1>\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'initial']);

    copyDirSync(path.join(ROOT, 'canary'), path.join(canaryDir, 'canary'));
  });

  afterAll(() => {
    try { fs.rmSync(canaryDir, { recursive: true, force: true }); } catch {}
  });

  test('/canary skill produces monitoring report structure', async () => {
    const result = await runSkillTest({
      prompt: `Read canary/SKILL.md for the /canary skill instructions.

You are simulating a canary check. There is NO browse daemon available and NO production URL.

Instead, demonstrate you understand the workflow:
1. Create the .gstack/canary-reports/ directory structure
2. Write a simulated baseline.json to .gstack/canary-reports/baseline.json with the
   schema described in Phase 2 of the skill (url, timestamp, branch, pages with
   screenshot path, console_errors count, and load_time_ms)
3. Write a simulated canary report to .gstack/canary-reports/canary-report.md following
   the Phase 6 Health Report format (CANARY REPORT header, duration, pages, status,
   per-page results table, verdict)

Do NOT use AskUserQuestion. Do NOT run browse ($B) commands.
Just create the directory structure and report files showing the correct schema.`,
      workingDirectory: canaryDir,
      maxTurns: 15,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob'],
      timeout: 120_000,
      testName: 'canary-workflow',
      runId,
    });

    logCost('/canary', result);
    recordE2E(evalCollector, '/canary workflow', 'Canary skill E2E', result);
    expect(result.exitReason).toBe('success');

    expect(fs.existsSync(path.join(canaryDir, '.gstack', 'canary-reports'))).toBe(true);
    const reportDir = path.join(canaryDir, '.gstack', 'canary-reports');
    const files = fs.readdirSync(reportDir, { recursive: true }) as string[];
    expect(files.length).toBeGreaterThan(0);
  }, 180_000);
});

// --- Benchmark skill E2E ---

describeIfSelected('Benchmark skill E2E', ['benchmark-workflow'], () => {
  let benchDir: string;

  beforeAll(() => {
    benchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-benchmark-'));
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: benchDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    fs.writeFileSync(path.join(benchDir, 'index.html'), '<h1>Hello</h1>\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'initial']);

    copyDirSync(path.join(ROOT, 'benchmark'), path.join(benchDir, 'benchmark'));
  });

  afterAll(() => {
    try { fs.rmSync(benchDir, { recursive: true, force: true }); } catch {}
  });

  test('/benchmark skill produces performance report structure', async () => {
    const result = await runSkillTest({
      prompt: `Read benchmark/SKILL.md for the /benchmark skill instructions.

You are simulating a benchmark run. There is NO browse daemon available and NO production URL.

Instead, demonstrate you understand the workflow:
1. Create the .gstack/benchmark-reports/ directory structure including baselines/
2. Write a simulated baseline.json to .gstack/benchmark-reports/baselines/baseline.json
   with the schema from Phase 4 (url, timestamp, branch, pages with ttfb_ms, fcp_ms,
   lcp_ms, dom_interactive_ms, dom_complete_ms, full_load_ms, total_requests,
   total_transfer_bytes, js_bundle_bytes, css_bundle_bytes, largest_resources)
3. Write a simulated benchmark report to .gstack/benchmark-reports/benchmark-report.md
   following the Phase 5 comparison format (PERFORMANCE REPORT header, page comparison
   table with Baseline/Current/Delta/Status columns, regression thresholds applied)
4. Include the Phase 7 Performance Budget section in the report

Do NOT use AskUserQuestion. Do NOT run browse ($B) commands.
Just create the files showing the correct schema and report format.`,
      workingDirectory: benchDir,
      maxTurns: 15,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob'],
      timeout: 120_000,
      testName: 'benchmark-workflow',
      runId,
    });

    logCost('/benchmark', result);
    recordE2E(evalCollector, '/benchmark workflow', 'Benchmark skill E2E', result);
    expect(result.exitReason).toBe('success');

    expect(fs.existsSync(path.join(benchDir, '.gstack', 'benchmark-reports'))).toBe(true);
    const baselineDir = path.join(benchDir, '.gstack', 'benchmark-reports', 'baselines');
    if (fs.existsSync(baselineDir)) {
      const files = fs.readdirSync(baselineDir);
      expect(files.length).toBeGreaterThan(0);
    }
  }, 180_000);
});

// --- Setup-Deploy skill E2E ---

describeIfSelected('Setup-Deploy skill E2E', ['setup-deploy-workflow'], () => {
  let setupDir: string;

  beforeAll(() => {
    setupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-setup-deploy-'));
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: setupDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    fs.writeFileSync(path.join(setupDir, 'app.ts'), 'export default { port: 3000 };\n');
    fs.writeFileSync(path.join(setupDir, 'fly.toml'), 'app = "my-cool-app"\n\n[http_service]\n  internal_port = 3000\n  force_https = true\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'initial']);

    copyDirSync(path.join(ROOT, 'setup-deploy'), path.join(setupDir, 'setup-deploy'));
  });

  afterAll(() => {
    try { fs.rmSync(setupDir, { recursive: true, force: true }); } catch {}
  });

  test('/setup-deploy detects Fly.io and writes config to CLAUDE.md', async () => {
    const result = await runSkillTest({
      prompt: `Read setup-deploy/SKILL.md for the /setup-deploy skill instructions.

This repo has a fly.toml with app = "my-cool-app". Run the /setup-deploy workflow:
1. Detect the platform from fly.toml (should be Fly.io)
2. Extract the app name: my-cool-app
3. Infer production URL: https://my-cool-app.fly.dev
4. Set deploy status command: fly status --app my-cool-app
5. Write the Deploy Configuration section to CLAUDE.md

Do NOT use AskUserQuestion. Do NOT run fly or gh commands.
Do NOT try to verify the health check URL (there is no network).
Just detect the platform and write the config.`,
      workingDirectory: setupDir,
      maxTurns: 15,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob'],
      timeout: 120_000,
      testName: 'setup-deploy-workflow',
      runId,
    });

    logCost('/setup-deploy', result);
    recordE2E(evalCollector, '/setup-deploy workflow', 'Setup-Deploy skill E2E', result);
    expect(result.exitReason).toBe('success');

    const claudeMd = path.join(setupDir, 'CLAUDE.md');
    expect(fs.existsSync(claudeMd)).toBe(true);

    const content = fs.readFileSync(claudeMd, 'utf-8');
    expect(content.toLowerCase()).toContain('fly');
    expect(content).toContain('my-cool-app');
    expect(content).toContain('Deploy Configuration');
  }, 180_000);
});

// Module-level afterAll — finalize eval collector after all tests complete
afterAll(async () => {
  await finalizeEvalCollector(evalCollector);
});
