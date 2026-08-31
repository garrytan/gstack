import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { JUDGE_MS, CAPTURE_MS } from './helpers/eval-budgets';
import { runSkillTest } from './helpers/session-runner';
import {
  ROOT, browseBin, runId, evalsEnabled, selectedTests,
  describeIfSelected, testConcurrentIfSelected,
  copyDirSync, setupBrowseShims, logCost, recordE2E,
  createEvalCollector, finalizeEvalCollector,
} from './helpers/e2e-helpers';
import { extractSkillSections, REVIEW_E2E_SECTIONS } from './helpers/skill-fixture';
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

    // Review skill files — extract only the core review workflow sections
    // (CLAUDE.md: "E2E test fixtures: extract, don't copy").
    fs.writeFileSync(
      path.join(reviewDir, 'review-SKILL.md'),
      extractSkillSections(path.join(ROOT, 'review'), REVIEW_E2E_SECTIONS),
    );
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
      timeout: CAPTURE_MS,
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
  }, CAPTURE_MS);
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

    // Review skill files — extracted sections, not the full 1870-line file.
    fs.writeFileSync(
      path.join(enumDir, 'review-SKILL.md'),
      extractSkillSections(path.join(ROOT, 'review'), REVIEW_E2E_SECTIONS),
    );
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
      timeout: JUDGE_MS,
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
  }, JUDGE_MS);
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

    // Review skill files — extracted sections, not the full 1870-line file.
    // The design checks come from review-design-checklist.md (copied whole,
    // it is a 134-line checklist, not a generated SKILL.md).
    fs.writeFileSync(
      path.join(designDir, 'review-SKILL.md'),
      extractSkillSections(path.join(ROOT, 'review'), REVIEW_E2E_SECTIONS),
    );
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
      timeout: CAPTURE_MS,
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
  }, CAPTURE_MS);
});

// Base branch detection tests for review/ship + the Review Dashboard Via
// Attribution describe live in test/skill-e2e-review-attribution.test.ts.
// Retro tests (retro, retro-base-branch) live in test/skill-e2e-retro.test.ts.
// Split so CI's per-file matrix can run them in parallel.

// Module-level afterAll — finalize eval collector after all tests complete
afterAll(async () => {
  await finalizeEvalCollector(evalCollector);
});
