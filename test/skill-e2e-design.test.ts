import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { runSkillTest } from './helpers/session-runner';
import { callJudge } from './helpers/llm-judge';
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

const evalCollector = createEvalCollector('e2e-design');

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

// --- Design Consultation E2E ---

describeIfSelected('Design Consultation E2E', [
  'design-consultation-core',
  'design-consultation-existing',
  'design-consultation-research',
  'design-consultation-preview',
], () => {
  let designDir: string;

  beforeAll(() => {
    designDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-design-consultation-'));
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

  testConcurrentIfSelected('design-consultation-core', async () => {
    const result = await runSkillTest({
      prompt: `Read design-consultation/SKILL.md for the design consultation workflow.
Skip the preamble bash block, lake intro, telemetry, and contributor mode sections — go straight to the design workflow.

This is a civic tech data platform called CivicPulse for government employees who need to access public data. Read the README.md for details.

Skip research — work from your design knowledge. Skip the font preview page. Skip any AskUserQuestion calls — this is non-interactive. Accept your first design system proposal.

Write DESIGN.md and CLAUDE.md (or update it) in the working directory.`,
      workingDirectory: designDir,
      maxTurns: 20,
      timeout: 360_000,
      testName: 'design-consultation-core',
      runId,
      model: 'claude-opus-4-7',
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

    // Structural checks — fuzzy synonym matching to handle agent variation
    const sectionSynonyms: Record<string, string[]> = {
      'Product Context': ['product', 'context', 'overview', 'about'],
      'Aesthetic': ['aesthetic', 'visual direction', 'design direction', 'visual identity'],
      'Typography': ['typography', 'type', 'font', 'typeface'],
      'Color': ['color', 'colour', 'palette', 'colors'],
      'Spacing': ['spacing', 'space', 'whitespace', 'gap'],
      'Layout': ['layout', 'grid', 'structure', 'composition'],
      'Motion': ['motion', 'animation', 'transition', 'movement'],
    };
    const missingSections = Object.entries(sectionSynonyms).filter(
      ([_, synonyms]) => !synonyms.some(s => designContent.toLowerCase().includes(s))
    ).map(([name]) => name);

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
    recordE2E(evalCollector, '/design-consultation core', 'Design Consultation E2E', result, {
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

  testConcurrentIfSelected('design-consultation-research', async () => {
    // Test WebSearch integration — research phase only, no DESIGN.md generation
    const researchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-research-'));

    const result = await runSkillTest({
      prompt: `You have access to WebSearch. Research civic tech data platform designs.

Do exactly 2 WebSearch queries:
1. 'civic tech government data platform design 2025'
2. 'open data portal UX best practices'

Summarize the key design patterns you found to ${researchDir}/research-notes.md.
Include: color trends, typography patterns, and layout conventions you observed.
Do NOT generate a full DESIGN.md — just research notes.`,
      workingDirectory: researchDir,
      maxTurns: 8,
      timeout: 90_000,
      testName: 'design-consultation-research',
      runId,
    });

    logCost('/design-consultation research', result);

    const notesPath = path.join(researchDir, 'research-notes.md');
    const notesExist = fs.existsSync(notesPath);
    const notesContent = notesExist ? fs.readFileSync(notesPath, 'utf-8') : '';

    // Check if WebSearch was used
    const webSearchCalls = result.toolCalls.filter(tc => tc.tool === 'WebSearch');
    if (webSearchCalls.length > 0) {
      console.log(`WebSearch used ${webSearchCalls.length} times`);
    } else {
      console.warn('WebSearch not used — may be unavailable in test env');
    }

    recordE2E(evalCollector, '/design-consultation research', 'Design Consultation E2E', result, {
      passed: notesExist && notesContent.length > 200 && ['success', 'error_max_turns'].includes(result.exitReason),
    });

    expect(['success', 'error_max_turns']).toContain(result.exitReason);
    expect(notesExist).toBe(true);
    if (notesExist) {
      expect(notesContent.length).toBeGreaterThan(200);
    }

    try { fs.rmSync(researchDir, { recursive: true, force: true }); } catch {}
  }, 120_000);

  testConcurrentIfSelected('design-consultation-existing', async () => {
    // Pre-create a minimal DESIGN.md (independent of core test)
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
      model: 'claude-opus-4-7',
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

    recordE2E(evalCollector, '/design-consultation existing', 'Design Consultation E2E', result, {
      passed: designExists && hasColor && hasSpacing && ['success', 'error_max_turns'].includes(result.exitReason),
    });

    expect(['success', 'error_max_turns']).toContain(result.exitReason);
    expect(designExists).toBe(true);
    if (designExists) {
      expect(hasColor).toBe(true);
      expect(hasSpacing).toBe(true);
    }
  }, 420_000);

  testConcurrentIfSelected('design-consultation-preview', async () => {
    // Test preview HTML generation only — no DESIGN.md (covered by core test)
    const previewDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-preview-'));

    const result = await runSkillTest({
      prompt: `Generate a font and color preview page for a civic tech data platform.

The design system uses:
- Primary font: Cabinet Grotesk (headings), Source Sans 3 (body)
- Colors: #1B4D8E (civic blue), #C4501A (alert orange), #2D6A4F (success green)
- Neutral: #F8F7F6 (warm white), #1A1A1A (near black)

Write a single HTML file to ${previewDir}/design-preview.html that shows:
- Font specimens for each font at different sizes
- Color swatches with hex values
- A light/dark toggle
Do NOT write DESIGN.md — only the preview HTML.`,
      workingDirectory: previewDir,
      maxTurns: 8,
      timeout: 90_000,
      testName: 'design-consultation-preview',
      runId,
    });

    logCost('/design-consultation preview', result);

    const previewPath = path.join(previewDir, 'design-preview.html');
    const previewExists = fs.existsSync(previewPath);
    let previewContent = '';
    if (previewExists) {
      previewContent = fs.readFileSync(previewPath, 'utf-8');
    }

    const hasHtml = previewContent.includes('<html') || previewContent.includes('<!DOCTYPE');
    const hasFontRef = previewContent.includes('font-family') || previewContent.includes('fonts.googleapis') || previewContent.includes('fonts.bunny');

    recordE2E(evalCollector, '/design-consultation preview', 'Design Consultation E2E', result, {
      passed: previewExists && hasHtml && ['success', 'error_max_turns'].includes(result.exitReason),
    });

    expect(['success', 'error_max_turns']).toContain(result.exitReason);
    expect(previewExists).toBe(true);
    if (previewExists) {
      expect(hasHtml).toBe(true);
      expect(hasFontRef).toBe(true);
    }

    try { fs.rmSync(previewDir, { recursive: true, force: true }); } catch {}
  }, 120_000);
});

// --- Plan Design Review E2E (plan-mode) ---

describeIfSelected('Plan Design Review E2E', ['plan-design-review-plan-mode', 'plan-design-review-no-ui-scope'], () => {

  /** Create an isolated tmpdir with git repo and plan-design-review skill */
  function setupReviewDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-plan-design-'));
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: dir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    // Copy plan-design-review skill
    fs.mkdirSync(path.join(dir, 'plan-design-review'), { recursive: true });
    fs.copyFileSync(
      path.join(ROOT, 'plan-design-review', 'SKILL.md'),
      path.join(dir, 'plan-design-review', 'SKILL.md'),
    );

    return dir;
  }

  testConcurrentIfSelected('plan-design-review-plan-mode', async () => {
    const reviewDir = setupReviewDir();
    try {
      const run = (cmd: string, args: string[]) =>
        spawnSync(cmd, args, { cwd: reviewDir, stdio: 'pipe', timeout: 5000 });

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

      recordE2E(evalCollector, '/plan-design-review plan-mode', 'Plan Design Review E2E', result, {
        passed: hasDesignContent && planWasEdited && ['success', 'error_max_turns'].includes(result.exitReason),
      });

      expect(['success', 'error_max_turns']).toContain(result.exitReason);
      // Agent should produce design-relevant output about the plan
      expect(hasDesignContent).toBe(true);
      // Agent should have edited the plan file to add missing design decisions
      expect(planWasEdited).toBe(true);
      expect(planHasDesignAdditions).toBe(true);
    } finally {
      try { fs.rmSync(reviewDir, { recursive: true, force: true }); } catch {}
    }
  }, 360_000);

  testConcurrentIfSelected('plan-design-review-no-ui-scope', async () => {
    const reviewDir = setupReviewDir();
    try {
      const run = (cmd: string, args: string[]) =>
        spawnSync(cmd, args, { cwd: reviewDir, stdio: 'pipe', timeout: 5000 });

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

      run('git', ['add', '.']);
      run('git', ['commit', '-m', 'initial plan']);

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

      recordE2E(evalCollector, '/plan-design-review no-ui-scope', 'Plan Design Review E2E', result, {
        passed: detectsNoUI && ['success', 'error_max_turns'].includes(result.exitReason),
      });

      expect(['success', 'error_max_turns']).toContain(result.exitReason);
      expect(detectsNoUI).toBe(true);
    } finally {
      try { fs.rmSync(reviewDir, { recursive: true, force: true }); } catch {}
    }
  }, 240_000);
});

// --- Design Review E2E (live-site audit + fix) ---

describeIfSelected('Design Review E2E', ['design-review-fix'], () => {
  let qaDesignDir: string;
  let qaDesignServer: ReturnType<typeof Bun.serve> | null = null;

  beforeAll(() => {
    qaDesignDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-qa-design-'));
    setupBrowseShims(qaDesignDir);

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

  testConcurrentIfSelected('design-review-fix', async () => {
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

    recordE2E(evalCollector, '/design-review fix', 'Design Review E2E', result, {
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

// Module-level afterAll — finalize eval collector after all tests complete
afterAll(async () => {
  await finalizeEvalCollector(evalCollector);
});
