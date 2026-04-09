import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { runSkillTest } from './helpers/session-runner';
import {
  ROOT, browseBin, runId, evalsEnabled, selectedTests,
  describeIfSelected, testConcurrentIfSelected,
  copyDirSync, setupBrowseShims, logCost, recordE2E,
  createEvalCollector, finalizeEvalCollector,
} from './helpers/e2e-helpers';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const evalCollector = createEvalCollector('e2e-review');

// --- B5: Review skill E2E ---

describeIfSelected('Review skill E2E', ['review-sql-injection'], () => {
  let reviewDir: string;

  beforeAll(() => {
    reviewDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-review-'));

    // Pre-build a git repo with a vulnerable file on a feature branch (decision 5A)
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

  testConcurrentIfSelected('review-sql-injection', async () => {
    const result = await runSkillTest({
      prompt: `You are in a git repo on a feature branch with changes against main.
Read review-SKILL.md for the review workflow instructions.
Also read review-checklist.md and apply it.
Skip the preamble bash block, lake intro, telemetry, and contributor mode sections — go straight to the review.
Run /review on the current diff (git diff main...HEAD).
Write your review findings to ${reviewDir}/review-output.md`,
      workingDirectory: reviewDir,
      maxTurns: 20,
      timeout: 180_000,
      testName: 'review-sql-injection',
      runId,
    });

    logCost('/review', result);
    recordE2E(evalCollector, '/review SQL injection', 'Review skill E2E', result);
    expect(result.exitReason).toBe('success');

    // Verify the review output mentions SQL injection-related findings
    const reviewOutputPath = path.join(reviewDir, 'review-output.md');
    if (fs.existsSync(reviewOutputPath)) {
      const reviewContent = fs.readFileSync(reviewOutputPath, 'utf-8').toLowerCase();
      const hasSqlContent =
        reviewContent.includes('sql') ||
        reviewContent.includes('injection') ||
        reviewContent.includes('sanitiz') ||
        reviewContent.includes('parameteriz') ||
        reviewContent.includes('interpolat') ||
        reviewContent.includes('user_input') ||
        reviewContent.includes('unsanitized');
      expect(hasSqlContent).toBe(true);
    }
  }, 210_000);
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

  testConcurrentIfSelected('review-enum-completeness', async () => {
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
    recordE2E(evalCollector, '/review enum completeness', 'Review enum completeness E2E', result);
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

describeIfSelected('Review design lite E2E', ['review-design-lite'], () => {
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

  testConcurrentIfSelected('review-design-lite', async () => {
    const result = await runSkillTest({
      prompt: `You are in a git repo on branch feature/add-landing-page with changes against main.
Read review-SKILL.md for the review workflow instructions.
Read review-checklist.md for the code review checklist.
Read review-design-checklist.md for the design review checklist.
Run /review on the current diff (git diff main...HEAD).

Skip the preamble bash block, lake intro, telemetry, and contributor mode sections — go straight to the review.

The diff adds a landing page with CSS and HTML. Check for both code issues AND design anti-patterns.
Write your review findings to ${designDir}/review-output.md

Important: The design checklist should catch issues like blacklisted fonts, small font sizes, outline:none, !important, AI slop patterns (purple gradients, generic hero copy, 3-column feature grid), etc.`,
      workingDirectory: designDir,
      maxTurns: 35,
      timeout: 240_000,
      testName: 'review-design-lite',
      runId,
    });

    logCost('/review design lite', result);
    recordE2E(evalCollector, '/review design lite', 'Review design lite E2E', result);
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
  }, 300_000);
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
  }, 120_000);

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
      timeout: 150_000,
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
    const destructiveTools = result.toolCalls.filter(tc =>
      tc.tool === 'Bash' && typeof tc.input === 'string' &&
      (tc.input.includes('git push') || tc.input.includes('gh pr create'))
    );
    expect(destructiveTools).toHaveLength(0);
  }, 180_000);

  testConcurrentIfSelected('retro-base-branch', async () => {
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
    recordE2E(evalCollector, '/retro default branch detection', 'Base branch detection', result, {
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

// --- Retro E2E ---

describeIfSelected('Retro E2E', ['retro'], () => {
  let retroDir: string;

  beforeAll(() => {
    retroDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-retro-'));
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

  testConcurrentIfSelected('retro', async () => {
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
      model: 'claude-opus-4-6',
    });

    logCost('/retro', result);
    recordE2E(evalCollector, '/retro', 'Retro E2E', result, {
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
    // nstack-review-read reads from ~/.nstack/projects/$SLUG/$BRANCH-reviews.jsonl
    // For the test, we'll write a mock nstack-review-read script that returns our test data
    const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const reviewData = [
      `{"skill":"plan-eng-review","timestamp":"${timestamp}","status":"clean","unresolved":0,"critical_gaps":0,"issues_found":0,"mode":"FULL_REVIEW","via":"autoplan","commit":"${commit}"}`,
      `{"skill":"plan-ceo-review","timestamp":"${timestamp}","status":"clean","unresolved":0,"critical_gaps":0,"mode":"SELECTIVE_EXPANSION","via":"autoplan","commit":"${commit}"}`,
      `{"skill":"codex-plan-review","timestamp":"${timestamp}","status":"clean","source":"codex","commit":"${commit}"}`,
    ].join('\n');

    // Write a mock nstack-review-read that returns our test data
    const mockBinDir = path.join(dashDir, '.mock-bin');
    fs.mkdirSync(mockBinDir, { recursive: true });
    fs.writeFileSync(path.join(mockBinDir, 'nstack-review-read'), [
      '#!/usr/bin/env bash',
      `echo '${reviewData.split('\n').join("'\necho '")}'`,
      'echo "---CONFIG---"',
      'echo "false"',
      'echo "---HEAD---"',
      `echo "${commit}"`,
    ].join('\n'));
    fs.chmodSync(path.join(mockBinDir, 'nstack-review-read'), 0o755);

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

Instead of running ~/.claude/skills/nstack/bin/nstack-review-read, run this mock: ${mockBinDir}/nstack-review-read

Parse the output and display the dashboard table. Pay attention to:
1. The "via" field in entries — show source attribution (e.g., "via /autoplan")
2. The codex-plan-review entry — it should populate the Outside Voice row
3. Since Eng Review IS clear, there should be NO gate blocking — just display the dashboard

Skip the preamble, lake intro, telemetry, and all other ship steps.
Write the dashboard output to ${dashDir}/dashboard-output.md`,
      workingDirectory: dashDir,
      maxTurns: 12,
      timeout: 180_000,
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
  }, 240_000);
});

// Module-level afterAll — finalize eval collector after all tests complete
afterAll(async () => {
  await finalizeEvalCollector(evalCollector);
});
