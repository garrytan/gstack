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

  testConcurrentIfSelected('land-and-deploy-workflow', async () => {
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
5. Write a deploy report skeleton to .nstack/deploy-reports/report.md showing the
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

    const reportDir = path.join(landDir, '.nstack', 'deploy-reports');
    expect(fs.existsSync(reportDir)).toBe(true);
  }, 180_000);
});

// --- Land-and-Deploy First-Run E2E ---

describeIfSelected('Land-and-Deploy first-run E2E', ['land-and-deploy-first-run'], () => {
  let firstRunDir: string;

  beforeAll(() => {
    firstRunDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-land-first-run-'));
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: firstRunDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    fs.writeFileSync(path.join(firstRunDir, 'app.ts'), 'export function hello() { return "world"; }\n');
    fs.writeFileSync(path.join(firstRunDir, 'fly.toml'), 'app = "first-run-app"\n\n[http_service]\n  internal_port = 3000\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'initial']);

    run('git', ['checkout', '-b', 'feat/first-deploy']);
    fs.writeFileSync(path.join(firstRunDir, 'app.ts'), 'export function hello() { return "first deploy"; }\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'feat: first deploy']);

    copyDirSync(path.join(ROOT, 'land-and-deploy'), path.join(firstRunDir, 'land-and-deploy'));
  });

  afterAll(() => {
    try { fs.rmSync(firstRunDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('land-and-deploy-first-run', async () => {
    const result = await runSkillTest({
      prompt: `Read land-and-deploy/SKILL.md for the /land-and-deploy skill instructions.

You are on branch feat/first-deploy. This is the FIRST TIME running /land-and-deploy
for this project — there is NO land-deploy-confirmed file.

This repo has a fly.toml with app = "first-run-app", indicating a Fly.io deployment.

IMPORTANT: There is NO remote and NO GitHub PR — you cannot run gh commands.
Instead, simulate the Step 1.5 first-run dry-run validation:
1. Detect that this is a FIRST_RUN (no land-deploy-confirmed file)
2. Detect the deploy platform from fly.toml (Fly.io, app = first-run-app)
3. Infer the production URL (https://first-run-app.fly.dev)
4. Build the DEPLOY INFRASTRUCTURE VALIDATION table showing:
   - Platform detected
   - Command validation results (simulated as all passing)
   - Staging detection results (none expected)
   - What will happen steps
5. Write the dry-run report to .nstack/deploy-reports/dry-run-validation.md

Do NOT use AskUserQuestion. Do NOT run gh or fly commands.
Just demonstrate the first-run dry-run output.`,
      workingDirectory: firstRunDir,
      maxTurns: 20,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob'],
      timeout: 120_000,
      testName: 'land-and-deploy-first-run',
      runId,
    });

    logCost('/land-and-deploy first-run', result);
    recordE2E(evalCollector, '/land-and-deploy first-run', 'Land-and-Deploy first-run E2E', result);
    expect(result.exitReason).toBe('success');

    // Verify dry-run report was created
    const reportDir = path.join(firstRunDir, '.nstack', 'deploy-reports');
    expect(fs.existsSync(reportDir)).toBe(true);

    // Check report content mentions platform detection
    const reportFiles = fs.readdirSync(reportDir);
    expect(reportFiles.length).toBeGreaterThan(0);
    const reportContent = fs.readFileSync(path.join(reportDir, reportFiles[0]), 'utf-8');
    const hasPlatform = reportContent.toLowerCase().includes('fly') || reportContent.toLowerCase().includes('first-run-app');
    expect(hasPlatform).toBe(true);
  }, 180_000);
});

// --- Land-and-Deploy Review Gate E2E ---

describeIfSelected('Land-and-Deploy review gate E2E', ['land-and-deploy-review-gate'], () => {
  let reviewDir: string;

  beforeAll(() => {
    reviewDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-land-review-'));
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: reviewDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    fs.writeFileSync(path.join(reviewDir, 'app.ts'), 'export function hello() { return "world"; }\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'initial']);

    // Create 6 more commits to make any review stale
    for (let i = 1; i <= 6; i++) {
      fs.writeFileSync(path.join(reviewDir, `file${i}.ts`), `export const x${i} = ${i};\n`);
      run('git', ['add', '.']);
      run('git', ['commit', '-m', `feat: add file${i}`]);
    }

    copyDirSync(path.join(ROOT, 'land-and-deploy'), path.join(reviewDir, 'land-and-deploy'));
  });

  afterAll(() => {
    try { fs.rmSync(reviewDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('land-and-deploy-review-gate', async () => {
    const result = await runSkillTest({
      prompt: `Read land-and-deploy/SKILL.md for the /land-and-deploy skill instructions.

Focus on Step 3.5a and Step 3.5a-bis (the review staleness check and inline review offer).

This repo has 6 commits since the initial commit. There are NO review logs
(nstack-review-read would return NO_REVIEWS).

Simulate what the readiness gate would show:
1. Run nstack-review-read equivalent (simulate NO_REVIEWS output)
2. Determine review staleness: Eng Review should be "NOT RUN"
3. Note that Step 3.5a-bis would offer an inline review
4. Write a simulated readiness report to .nstack/deploy-reports/readiness-report.md
   showing the review status as NOT RUN with the inline review offer text

Do NOT use AskUserQuestion. Do NOT run gh commands.
Show what the readiness gate output would look like.`,
      workingDirectory: reviewDir,
      maxTurns: 15,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob'],
      timeout: 120_000,
      testName: 'land-and-deploy-review-gate',
      runId,
    });

    logCost('/land-and-deploy review-gate', result);
    recordE2E(evalCollector, '/land-and-deploy review-gate', 'Land-and-Deploy review gate E2E', result);
    expect(result.exitReason).toBe('success');

    // Verify readiness report was created
    const reportDir = path.join(reviewDir, '.nstack', 'deploy-reports');
    expect(fs.existsSync(reportDir)).toBe(true);

    const reportFiles = fs.readdirSync(reportDir);
    expect(reportFiles.length).toBeGreaterThan(0);
    const reportContent = fs.readFileSync(path.join(reportDir, reportFiles[0]), 'utf-8');
    // Should mention review status
    const hasReviewMention = reportContent.toLowerCase().includes('review') ||
                              reportContent.toLowerCase().includes('not run');
    expect(hasReviewMention).toBe(true);
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

  testConcurrentIfSelected('canary-workflow', async () => {
    const result = await runSkillTest({
      prompt: `Read canary/SKILL.md for the /canary skill instructions.

You are simulating a canary check. There is NO browse daemon available and NO production URL.

Instead, demonstrate you understand the workflow:
1. Create the .nstack/canary-reports/ directory structure
2. Write a simulated baseline.json to .nstack/canary-reports/baseline.json with the
   schema described in Phase 2 of the skill (url, timestamp, branch, pages with
   screenshot path, console_errors count, and load_time_ms)
3. Write a simulated canary report to .nstack/canary-reports/canary-report.md following
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

    expect(fs.existsSync(path.join(canaryDir, '.nstack', 'canary-reports'))).toBe(true);
    const reportDir = path.join(canaryDir, '.nstack', 'canary-reports');
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

  testConcurrentIfSelected('benchmark-workflow', async () => {
    const result = await runSkillTest({
      prompt: `Read benchmark/SKILL.md for the /benchmark skill instructions.

You are simulating a benchmark run. There is NO browse daemon available and NO production URL.

Instead, demonstrate you understand the workflow:
1. Create the .nstack/benchmark-reports/ directory structure including baselines/
2. Write a simulated baseline.json to .nstack/benchmark-reports/baselines/baseline.json
   with the schema from Phase 4 (url, timestamp, branch, pages with ttfb_ms, fcp_ms,
   lcp_ms, dom_interactive_ms, dom_complete_ms, full_load_ms, total_requests,
   total_transfer_bytes, js_bundle_bytes, css_bundle_bytes, largest_resources)
3. Write a simulated benchmark report to .nstack/benchmark-reports/benchmark-report.md
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

    expect(fs.existsSync(path.join(benchDir, '.nstack', 'benchmark-reports'))).toBe(true);
    const baselineDir = path.join(benchDir, '.nstack', 'benchmark-reports', 'baselines');
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

  testConcurrentIfSelected('setup-deploy-workflow', async () => {
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
