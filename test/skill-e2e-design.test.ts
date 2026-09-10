import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { CAPTURE_MS, CAPTURE_LONG_MS } from './helpers/eval-budgets';
import { runSkillTest, type SkillTestResult } from './helpers/session-runner';
import { callJudge } from './helpers/llm-judge';
import {
  ROOT, runId, evalsEnabled, selectedTests,
  describeIfSelected, testConcurrentIfSelected,
  copyDirSync, logCost, recordE2E,
  createEvalCollector, finalizeEvalCollector, browseBin,
} from './helpers/e2e-helpers';
import { asideAvailable } from './helpers/aside-available';
import { installFakeImpeccable, DETECT_SAMPLE } from './helpers/fake-impeccable';
import { sliceBetween } from './helpers/skill-fixture';
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

    // Copy design-consultation skill — INCLUDING sections/. The skill has
    // been carved since v1.57.0.0 (e722c5bf): Phases 3-6, where the DESIGN.md
    // structure (the "AESTHETIC: [direction]" proposal template) is
    // prescribed, live in sections/proposal-and-preview.md behind a STOP-read.
    // Without the dir the agent improvises structure from the skeleton
    // ("Visual thesis" vocabulary) and the section-synonym check becomes a
    // coin flip (observed: CI run 33090283032 failed both attempts with
    // "no sections dir" in the trace; the skeleton-only pass on 32899975845
    // was lucky vocabulary).
    fs.mkdirSync(path.join(designDir, 'design-consultation'), { recursive: true });
    fs.copyFileSync(
      path.join(ROOT, 'design-consultation', 'SKILL.md'),
      path.join(designDir, 'design-consultation', 'SKILL.md'),
    );
    fs.cpSync(
      path.join(ROOT, 'design-consultation', 'sections'),
      path.join(designDir, 'design-consultation', 'sections'),
      { recursive: true },
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
      timeout: CAPTURE_LONG_MS,
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
      // Widened 2026-08-27: two CI runs produced judge-praised DESIGN.md files
      // that articulated the direction as "design principles" / "design
      // language" prose without any of the original four literals (run
      // 33090283032, both attempts; inputs identical to the prior passing
      // run 32899975845 — vocabulary variance, not a generation regression).
      // Widened again 2026-09-08: the open DESIGN.md format's Overview opens with a
      // "Creative North Star" and "Key characteristics" instead of an Aesthetic
      // Direction heading (the judge passed both CI attempts on the vocabulary).
      'Aesthetic': ['aesthetic', 'visual direction', 'design direction', 'visual identity', 'design language', 'visual language', 'design principle', 'look and feel', 'art direction', 'north star', 'key characteristics', '## overview'],
      'Typography': ['typography', 'type', 'font', 'typeface'],
      'Color': ['color', 'colour', 'palette', 'colors'],
      'Spacing': ['spacing', 'space', 'whitespace', 'gap'],
      'Layout': ['layout', 'grid', 'structure', 'composition'],
      'Motion': ['motion', 'animation', 'transition', 'movement', 'easing', 'duration', 'micro-interaction'],
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
      // join() so a failure names the offending section(s) — a bare
      // toHaveLength(0) failure never prints WHICH synonym set missed.
      expect(missingSections.join(', ')).toBe('');
    }
    if (claudeExists) {
      const claude = fs.readFileSync(claudePath, 'utf-8');
      expect(claude.toLowerCase()).toContain('design.md');
    }
  }, CAPTURE_LONG_MS);

  testConcurrentIfSelected('design-consultation-research', async () => {
    // Research phase only, no DESIGN.md generation. Web research runs in Aside
    // first, WebSearch second ({{ASIDE_RESEARCH}}, rendered into
    // design-consultation/SKILL.md). With Aside live the agent MUST search
    // through `aside exec` — a straight-to-WebSearch run is the ordering bug
    // this case pins. Without Aside (CI, or GSTACK_SKIP_ASIDE=1) it must use
    // the WebSearch tool, or say the fallback sentence when that is missing
    // too, and write the notes from in-distribution knowledge. Either way the
    // notes file must exist.
    const researchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-research-'));

    // Extract only the research contract (CLAUDE.md: extract, don't copy). The tree's
    // SKILL.md unless GSTACK_E2E_DOCS_ROOT points at a `gen:skill-docs --out-dir` render.
    const skill = fs.readFileSync(path.join(process.env.GSTACK_E2E_DOCS_ROOT || ROOT, 'design-consultation', 'SKILL.md'), 'utf-8');
    const sectionStart = skill.indexOf('## Web research runs in Aside');
    if (sectionStart < 0) throw new Error('design-consultation/SKILL.md has no "Web research runs in Aside" section — regenerate with: bun run gen:skill-docs');
    const sectionEnd = skill.indexOf('\n## ', sectionStart + 1);
    fs.writeFileSync(path.join(researchDir, 'research-contract.md'), skill.slice(sectionStart, sectionEnd > sectionStart ? sectionEnd : undefined));
    const live = asideAvailable();

    const result = await runSkillTest({
      prompt: `Read ${researchDir}/research-contract.md first and follow it exactly: it says how web research runs in this project.

Research civic tech data platform designs. Run exactly 2 research queries:
1. 'civic tech government data platform design 2025'
2. 'open data portal UX best practices'

Summarize the key design patterns you found to ${researchDir}/research-notes.md.
Include: color trends, typography patterns, and layout conventions you observed.
Do NOT generate a full DESIGN.md — just research notes.`,
      workingDirectory: researchDir,
      maxTurns: 10,
      allowedTools: ['Bash', 'Read', 'Write', 'WebSearch'],
      // 300s, not 90s: saturated-runner class (same as review-dashboard-via /
      // retro-base-branch). PR #2533 CI observed the sibling preview test at
      // 0 turns/$0.00 for 93s x3 attempts — session up, first completion
      // queued past the budget under concurrent API load. 90s budgets cannot
      // absorb one slow first completion; 300s is the repo's standard floor
      // for CI SDK tests. Outer timeout below rises to 360s for headroom.
      timeout: CAPTURE_MS,
      testName: 'design-consultation-research',
      runId,
    });

    logCost('/design-consultation research', result);

    const notesPath = path.join(researchDir, 'research-notes.md');
    const notesExist = fs.existsSync(notesPath);
    const notesContent = notesExist ? fs.readFileSync(notesPath, 'utf-8') : '';

    // Aside live: research went through `aside exec` in a Bash tool call (WebSearch
    // alone is the wrong order). Aside absent: WebSearch tool, or the fallback sentence.
    const asideExecCalls = result.toolCalls.filter(tc => tc.tool === 'Bash' && /\baside exec\b/.test(String(tc.input?.command ?? '')));
    const webSearchCalls = result.toolCalls.filter(tc => tc.tool === 'WebSearch');
    const searched = asideExecCalls.length > 0 || webSearchCalls.length > 0;
    // Neither: the agent SAID the fallback. Assistant text blocks only — the
    // contract file the agent Reads contains the same sentence, so tool_result
    // content must not count.
    const assistantText = result.transcript
      .filter((e: any) => e?.type === 'assistant')
      .flatMap((e: any) => (e.message?.content ?? []).filter((c: any) => c?.type === 'text').map((c: any) => String(c.text)))
      .join('\n');
    const saidFallback = assistantText.includes('Search unavailable');
    const researchOk = live ? asideExecCalls.length > 0 : (searched || saidFallback);
    console.log(`aside exec issued ${asideExecCalls.length} times; WebSearch called ${webSearchCalls.length} times; Aside live: ${live}; fallback said: ${saidFallback}`);

    recordE2E(evalCollector, '/design-consultation research', 'Design Consultation E2E', result, {
      passed: researchOk && notesExist && notesContent.length > 200 && ['success', 'error_max_turns'].includes(result.exitReason),
    });

    expect(['success', 'error_max_turns']).toContain(result.exitReason);
    if (live) expect(asideExecCalls.length).toBeGreaterThan(0);
    else expect(searched || saidFallback).toBe(true);
    expect(notesExist).toBe(true);
    if (notesExist) {
      expect(notesContent.length).toBeGreaterThan(200);
    }

    try { fs.rmSync(researchDir, { recursive: true, force: true }); } catch {}
  }, CAPTURE_LONG_MS);

  testConcurrentIfSelected('design-consultation-existing', async () => {
    // Pre-create a LEGACY-format DESIGN.md (gstack's pre-spec shape, no marker) so
    // Phase 0's format check has a real decision to make.
    fs.writeFileSync(path.join(designDir, 'DESIGN.md'), `# Design System — CivicPulse

## Product Context
- **What this is:** Civic data platform

## Aesthetic Direction
- **Direction:** Industrial/Utilitarian

## Typography
- **Body:** system-ui

## Color
- **Primary:** #1D4ED8
`);

    const result = await runSkillTest({
      prompt: `Read design-consultation/SKILL.md for the design consultation workflow.

There is already a DESIGN.md in this repo. Update it with a complete design system for CivicPulse, a civic tech data platform for government employees.

Run Phase 0's DESIGN.md format check exactly as written (the gstack bin directory is ${ROOT}/bin). Skip research. Skip font preview. Skip any AskUserQuestion calls — this is non-interactive: where the skill asks whether to convert the legacy file, take option A (convert) without asking.`,
      workingDirectory: designDir,
      maxTurns: 20,
      timeout: CAPTURE_LONG_MS,
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

    // Phase 0 format decision: the check ran, and the file left behind is either
    // converted to the open format (marker on line 2) or explicitly kept legacy
    // (marker on line 1). Either is the persisted-choice contract; "neither" is the bug.
    const bash = result.toolCalls.filter(c => c.tool === 'Bash').map(c => String(c.input?.command ?? ''));
    const ranCheck = bash.some(c => c.includes('gstack-design-md.ts check'));
    const marked = /^---\n# gstack: design-md-format=spec/.test(designContent) || designContent.startsWith('<!-- gstack: design-md-format=legacy-keep -->');
    console.log(`design-consultation-existing: ranCheck=${ranCheck} marked=${marked}`);

    recordE2E(evalCollector, '/design-consultation existing', 'Design Consultation E2E', result, {
      passed: designExists && hasColor && hasSpacing && ranCheck && marked && ['success', 'error_max_turns'].includes(result.exitReason),
    });

    expect(['success', 'error_max_turns']).toContain(result.exitReason);
    expect(ranCheck).toBe(true);
    expect(marked).toBe(true);
    expect(designExists).toBe(true);
    if (designExists) {
      expect(hasColor).toBe(true);
      expect(hasSpacing).toBe(true);
    }
  }, CAPTURE_LONG_MS);

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
      // 300s, not 90s: this is the test that failed 3x at 0 turns/$0.00/93s
      // on PR #2533 CI — see the research test's comment for the class.
      timeout: CAPTURE_MS,
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
  }, CAPTURE_LONG_MS);
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
    { const _sec = path.join(ROOT, 'plan-design-review', 'sections'); if (fs.existsSync(_sec)) fs.cpSync(_sec, path.join(dir, 'plan-design-review', 'sections'), { recursive: true }); }

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
        timeout: CAPTURE_MS,
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
  }, CAPTURE_LONG_MS);

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
        timeout: CAPTURE_MS,
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
  }, CAPTURE_MS);
});

// --- Design Review E2E (live-site audit + fix) ---

/**
 * Concatenated tool_result text from the stream-json transcript. runSkillTest
 * leaves toolCalls[].output empty, and the agent's Bash INPUT also contains
 * the sentinel string — only the tool_result proves the script printed it.
 */
function toolOutput(result: SkillTestResult): string {
  const parts: string[] = [];
  for (const e of result.transcript) {
    if (e?.type !== 'user') continue;
    for (const item of e.message?.content ?? []) {
      if (item?.type !== 'tool_result') continue;
      parts.push(typeof item.content === 'string' ? item.content : JSON.stringify(item.content ?? ''));
    }
  }
  return parts.join('\n');
}

// /design-review drives the Aside browser; without it the skill's BROWSER SETUP stops at
// NEEDS_ASIDE, so the block self-skips (CI runners have no Aside).
describeIfSelected('Design Review E2E', ['design-review-fix'], () => {
  // bun runs describe.skip callbacks too — probe only when this block is actually selected,
  // so an unrelated eval run never pays the up-to-30s `aside repl` probe.
  const selected = evalsEnabled && (selectedTests === null || selectedTests.includes('design-review-fix'));
  if (selected && !asideAvailable()) { test.skip('needs Aside', () => {}); return; }

  let qaDesignDir: string;
  let qaDesignServer: ReturnType<typeof Bun.serve> | null = null;

  beforeAll(() => {
    qaDesignDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-qa-design-'));

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
      prompt: `The Aside browser is installed and running. Read design-review/SKILL.md for the design review + fix workflow and follow its BROWSER SETUP section: drive the browser with \`aside repl\` scripts shaped exactly like its cookbook. Do not look for any other browser binary.

Review the site at ${serverUrl}. Use --quick mode. Skip any AskUserQuestion calls — this is non-interactive. Fix up to 3 issues max. Write your report to ./design-audit.md.`,
      workingDirectory: qaDesignDir,
      maxTurns: 30,
      timeout: CAPTURE_LONG_MS,
      testName: 'design-review-fix',
      runId,
    });

    logCost('/design-review fix', result);

    const reportPath = path.join(qaDesignDir, 'design-audit.md');
    const reportExists = fs.existsSync(reportPath);

    // Check if any design fix commits were made
    const gitLog = spawnSync('git', ['log', '--oneline'], {
      cwd: qaDesignDir, stdio: 'pipe', timeout: 30_000,
    });
    const commits = gitLog.stdout.toString().trim().split('\n');
    const designFixCommits = commits.filter((c: string) => c.includes('style(design)'));

    // The agent must actually drive Aside: an `aside repl` Bash call, a printed sentinel
    // (from a tool_result, never the input), and no reach for the retired browse binary.
    const bashCommands = result.toolCalls
      .filter(t => t.tool === 'Bash')
      .map(t => String(t.input?.command ?? ''));
    const droveAside = bashCommands.some(c => /aside repl/.test(c));
    const sentinelPrinted = /GSTACK_STEP_OK/.test(toolOutput(result));
    const usedBrowseBin = bashCommands.some(c => /browse\/dist\/browse|\$B /.test(c));

    recordE2E(evalCollector, '/design-review fix', 'Design Review E2E', result, {
      passed: ['success', 'error_max_turns'].includes(result.exitReason) && droveAside && sentinelPrinted && !usedBrowseBin,
    });

    // Accept error_max_turns — the fix loop is complex
    expect(['success', 'error_max_turns']).toContain(result.exitReason);
    expect(droveAside).toBe(true);
    expect(sentinelPrinted).toBe(true);
    expect(usedBrowseBin).toBe(false);

    // Report and commits are best-effort — log what happened
    if (reportExists) {
      const report = fs.readFileSync(reportPath, 'utf-8');
      console.log(`Design audit report: ${report.length} chars`);
    } else {
      console.warn('No design-audit.md generated');
    }
    console.log(`Design fix commits: ${designFixCommits.length}`);
  }, CAPTURE_LONG_MS);
});

// Module-level afterAll — finalize eval collector after all tests complete
afterAll(async () => {
  await finalizeEvalCollector(evalCollector);
});

// --- Design detector (impeccable engine shim) E2E ---
//
// The user-installed impeccable engine is stood in for by test/fixtures/
// fake-impeccable.ts (prints the captured detect --json sample, exit 2),
// reached through IMPECCABLE_BIN from OUTSIDE the temp repo (the wrapper
// ignores an in-repo IMPECCABLE_BIN by design). The skill text the agent reads
// is the extracted Setup detector block + Phase 0 (+ the Phase 3 DOM-dump
// section for the DOM case), never the 1,500-line SKILL.md, with the installed
// bin path pointed at THIS checkout so the test does not depend on ~/.claude.


/** design-review's detector prose with the installed bin/lib paths rewritten to this checkout. */
function detectorSkillText(sections: Array<[string, string]>): string {
  const full = fs.readFileSync(path.join(ROOT, 'design-review', 'SKILL.md'), 'utf-8');
  return sections.map(([a, b]) => sliceBetween(full, a, b)).join('\n\n---\n\n')
    .replaceAll('$HOME/.claude/skills/gstack', ROOT)
    .replaceAll('~/.claude/skills/gstack', ROOT);
}

function makeFakeEngine(): string {
  return installFakeImpeccable('skill-e2e-fake-impeccable-').dir;
}

describeIfSelected('Design review detector shim E2E', ['design-review-detector-shim', 'design-review-detector-shim-dom'], () => {
  let repoDir: string;
  let engineDir: string;
  let server: ReturnType<typeof Bun.serve> | null = null;

  beforeAll(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-detector-shim-'));
    const run = (cmd: string, args: string[]) => spawnSync(cmd, args, { cwd: repoDir, stdio: 'pipe', timeout: 5000 });
    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(repoDir, 'index.html'), '<h1>Clean</h1>\n');
    fs.writeFileSync(path.join(repoDir, 'styles.css'), 'body { font-size: 16px; }\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'initial']);
    run('git', ['checkout', '-b', 'feature/landing']);
    fs.writeFileSync(path.join(repoDir, 'index.html'), fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'review-eval-design-slop.html'), 'utf-8'));
    fs.writeFileSync(path.join(repoDir, 'styles.css'), fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'review-eval-design-slop.css'), 'utf-8'));
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'add landing page']);
    engineDir = makeFakeEngine();
    fs.writeFileSync(
      path.join(repoDir, 'design-review-detector.md'),
      detectorSkillText([
        ['**Design detector (optional, deterministic):**', '**Create output directories:**'],
        ['**Phase 0: mechanical scan**', '## Phases 1-6'],
      ]),
    );
    fs.writeFileSync(
      path.join(repoDir, 'design-review-dom-dump.md'),
      detectorSkillText([['### DOM dump (DOM mode only', '### Auth Detection']]),
    );
  });

  afterAll(() => {
    server?.stop(true);
    try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(engineDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('design-review-detector-shim', async () => {
    const result = await runSkillTest({
      prompt: `You are in a git repo on branch feature/landing with changes against main (the base branch).
Read design-review-detector.md: it is the Setup "Design detector" block and "Phase 0: mechanical scan" from /design-review.
This is a diff-aware run with no URL, so it is SOURCE mode. Run the probe, then the Phase 0 source-mode scan with base main, exactly as written (use --host claude).
Do not run any browser step, do not fix anything, do not run npx.
Then write ${repoDir}/detector-output.md: one FINDING-NNN row per rule in the DETECT_TOP block, each tagged with its [rule-id] and the printed impact, plus the first line the probe printed.`,
      workingDirectory: repoDir,
      maxTurns: 15,
      timeout: CAPTURE_MS,
      testName: 'design-review-detector-shim',
      runId,
      env: { IMPECCABLE_BIN: path.join(engineDir, 'impeccable'), IMPECCABLE_FAKE_OUTPUT: DETECT_SAMPLE },
    });

    logCost('/design-review detector shim (source)', result);
    recordE2E(evalCollector, '/design-review detector shim', 'Design review detector shim E2E (source mode)', result);
    expect(result.exitReason).toBe('success');

    const bash = result.toolCalls.filter(c => c.tool === 'Bash').map(c => String(c.input?.command ?? ''));
    expect(bash.some(c => c.includes('gstack-design-detect.ts probe'))).toBe(true);
    expect(bash.some(c => /gstack-design-detect\.ts scan --changed main/.test(c))).toBe(true);
    expect(bash.some(c => c.includes('npx impeccable'))).toBe(false);
    // The sentinel is evidence in the tool output and the report, not something the
    // agent must repeat in its closing message.
    const toolOutputs = result.toolCalls.map(c => String(c.output ?? '')).join('\n');
    const outPath = path.join(repoDir, 'detector-output.md');
    expect(fs.existsSync(outPath)).toBe(true);
    const out = fs.readFileSync(outPath, 'utf-8');
    expect(toolOutputs.includes('IMPECCABLE_READY') || out.includes('IMPECCABLE_READY')).toBe(true);
    expect(out).toContain('FINDING-001');
    expect(out).toContain('[ai-color-palette]');
    expect(out).toContain('[low-contrast]');
  }, CAPTURE_MS);

  // DOM mode needs a browser engine for the dump: gstack's own browse binary
  // (CI builds it with build:gates). Self-skips when it is absent, like the
  // other render gates.
  testConcurrentIfSelected(
    'design-review-detector-shim-dom',
    async () => {
      if (!fs.existsSync(browseBin)) {
        console.log('design-review-detector-shim (dom mode): browse binary absent, skipping (build it with bun run build:gates)');
        return;
      }
      const site = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-detector-site-'));
      fs.copyFileSync(path.join(ROOT, 'test', 'fixtures', 'review-eval-design-slop.html'), path.join(site, 'index.html'));
      fs.copyFileSync(path.join(ROOT, 'test', 'fixtures', 'review-eval-design-slop.css'), path.join(site, 'styles.css'));
      server = Bun.serve({
        hostname: '127.0.0.1', port: 0,
        fetch(req) {
          const p = new URL(req.url).pathname.replace(/^\//, '') || 'index.html';
          const f = path.join(site, p);
          return fs.existsSync(f) ? new Response(Bun.file(f)) : new Response('not found', { status: 404 });
        },
      });
      const url = `http://127.0.0.1:${server.port}/index.html`;
      const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-detector-report-'));
      const gstackHome = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-detector-home-'));
      // REPORT_DIR must sit under <gstack home>/projects/<slug>/designs/ for the wrapper's allow-list.
      const allowed = path.join(gstackHome, 'projects', 'shim', 'designs', 'design-audit-20260908');
      fs.mkdirSync(path.join(allowed, 'dom', 'run1'), { recursive: true });
      // The agent's $B commands and this test's cleanup share ONE daemon, scoped to this run.
      const browseState = path.join(gstackHome, 'browse.json');
      try {
        const result = await runSkillTest({
          prompt: `Read design-review-detector.md (the /design-review detector block + Phase 0) and design-review-dom-dump.md (the Phase 3 DOM dump section).
The target is the URL ${url}, so this is DOM mode: never scan source files.
Aside is NOT available; use the fallback browser engine: $B is ${browseBin}. Run "$B goto ${url}" first, then follow the fallback-engine DOM dump steps exactly as written, with {page} = home, REPORT_DIR=${allowed}, RUN_ID=run1, and --host claude. Then run the single scan over ${allowed}/dom/run1 and write ${allowed}/detector-output.md with one FINDING-NNN row per rule in the DETECT_TOP block, each tagged [rule-id], and the line "static scan of the rendered DOM; cross-origin CSS not resolved".
Do not run npx. Do not fix anything.`,
          workingDirectory: repoDir,
          maxTurns: 25,
          timeout: CAPTURE_LONG_MS,
          testName: 'design-review-detector-shim-dom',
          runId,
          env: { IMPECCABLE_BIN: path.join(engineDir, 'impeccable'), IMPECCABLE_FAKE_OUTPUT: DETECT_SAMPLE, GSTACK_HOME: gstackHome, BROWSE_STATE_FILE: browseState },
        });
        logCost('/design-review detector shim (dom)', result);
        recordE2E(evalCollector, '/design-review detector shim (dom)', 'Design review detector shim E2E (DOM mode)', result);
        expect(result.exitReason).toBe('success');
        const bash = result.toolCalls.filter(c => c.tool === 'Bash').map(c => String(c.input?.command ?? ''));
        expect(bash.some(c => c.includes('dom-dump.js') && c.includes('--out') && c.includes('--raw'))).toBe(true); // $B js '('"$_DUMP"')()' with the file spliced in
        expect(bash.some(c => /gstack-design-detect\.ts scan /.test(c) && c.includes('dom/run1'))).toBe(true);
        expect(bash.some(c => /gstack-design-detect\.ts scan --changed/.test(c))).toBe(false);
        const dumps = fs.readdirSync(path.join(allowed, 'dom', 'run1')).filter(f => f.endsWith('.dom.html'));
        expect(dumps.length).toBeGreaterThan(0);
        expect(fs.readFileSync(path.join(allowed, 'dom', 'run1', dumps[0]), 'utf-8')).toContain('data-gstack-dom-css');
        const out = fs.readFileSync(path.join(allowed, 'detector-output.md'), 'utf-8');
        expect(out).toContain('[ai-color-palette]');
        expect(out).toContain('static scan of the rendered DOM');
      } finally {
        server?.stop(true); server = null;
        try { spawnSync(browseBin, ['stop'], { stdio: 'pipe', timeout: 10_000, env: { ...process.env, BROWSE_STATE_FILE: browseState } }); } catch {}
        for (const d of [site, reportDir, gstackHome]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
      }
    },
    CAPTURE_LONG_MS,
  );
});

describeIfSelected('Design HTML slop gate E2E', ['design-html-slop-gate'], () => {
  let workDir: string;
  let engineDir: string;

  beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-html-gate-'));
    const run = (cmd: string, args: string[]) => spawnSync(cmd, args, { cwd: workDir, stdio: 'pipe', timeout: 5000 });
    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);
    const css = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'review-eval-design-slop.css'), 'utf-8');
    const html = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'review-eval-design-slop.html'), 'utf-8')
      .replace('<link rel="stylesheet" href="styles.css">', `<style>\n${css}\n</style>`);
    fs.writeFileSync(path.join(workDir, 'finalized.html'), html);
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'finalized html']);
    engineDir = makeFakeEngine();
    const full = fs.readFileSync(path.join(ROOT, 'design-html', 'SKILL.md'), 'utf-8');
    const text = [
      sliceBetween(full, '**Design detector (optional, deterministic):**', '## Step 0: Input Detection'),
      sliceBetween(full, '### Slop Gate (bounded, never a loop)', '### Verification Screenshots'),
    ].join('\n\n---\n\n').replaceAll('$HOME/.claude/skills/gstack', ROOT).replaceAll('~/.claude/skills/gstack', ROOT);
    fs.writeFileSync(path.join(workDir, 'design-html-gate.md'), text);
  });

  afterAll(() => {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(engineDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('design-html-slop-gate', async () => {
    const result = await runSkillTest({
      prompt: `Read design-html-gate.md: the /design-html detector probe block and its "Slop Gate (bounded, never a loop)" step.
finalized.html in this directory is the finished page. Run the probe (--host claude), then the slop gate on finalized.html exactly as written: one surgical fix pass over the non-advisory findings, one rescan, then stop.
Write ${workDir}/gate-output.md listing what you fixed and every remaining finding as accepted-with-reason, each tagged with its [rule-id]. Do not take screenshots, do not run npx, do not scan more than twice.`,
      workingDirectory: workDir,
      maxTurns: 20,
      timeout: CAPTURE_MS,
      testName: 'design-html-slop-gate',
      runId,
      env: { IMPECCABLE_BIN: path.join(engineDir, 'impeccable'), IMPECCABLE_FAKE_OUTPUT: DETECT_SAMPLE },
    });

    logCost('/design-html slop gate', result);
    recordE2E(evalCollector, '/design-html slop gate', 'Design HTML slop gate E2E', result);
    expect(result.exitReason).toBe('success');
    const scans = result.toolCalls.filter(c => c.tool === 'Bash' && /gstack-design-detect\.ts scan /.test(String(c.input?.command ?? '')));
    expect(scans.length).toBeGreaterThanOrEqual(1);
    expect(scans.length).toBeLessThanOrEqual(2);
    const outPath = path.join(workDir, 'gate-output.md');
    expect(fs.existsSync(outPath)).toBe(true);
    const out = fs.readFileSync(outPath, 'utf-8').toLowerCase();
    expect(out).toContain('ai-color-palette');
    expect(out).toContain('accepted');
  }, CAPTURE_MS);
});
