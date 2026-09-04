/**
 * LLM-as-a-Judge evals for generated SKILL.md quality.
 *
 * Uses the Anthropic API directly (not Agent SDK) to evaluate whether
 * generated command docs are clear, complete, and actionable for an AI agent.
 *
 * Requires: ANTHROPIC_API_KEY env var (or EVALS=1 with key already set)
 * Run: EVALS=1 bun run test:eval
 *
 * Cost: ~$0.05-0.15 per run (sonnet)
 */

import { afterAll, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { callJudge, judge } from './helpers/llm-judge';
import type { JudgeScore } from './helpers/llm-judge';
import { LLM_JUDGE_TOUCHFILES } from './helpers/touchfiles';
// Runs when EVALS=1 is set (requires ANTHROPIC_API_KEY in env) — the EVALS
// gate lives in the shared describeIfSelected. Selection machinery is shared
// with the E2E suite; only the touchfiles table (LLM_JUDGE_TOUCHFILES, passed
// explicitly below) differs. No EVALS_TIER filter applies here — LLM-judge
// tests have no E2E_TIERS entries and run in both tier lanes.
import {
  ROOT,
  computeDiffSelection,
  createEvalCollector,
  finalizeEvalCollector,
  describeIfSelected as describeIfSelectedShared,
  testConcurrentIfSelected,
} from './helpers/e2e-helpers';

// Eval result collector
const evalCollector = createEvalCollector('llm-judge');

// --- Diff-based test selection (LLM_JUDGE_TOUCHFILES, not the E2E table) ---
const selectedTests = computeDiffSelection(LLM_JUDGE_TOUCHFILES, 'LLM-judge');

/** Wrap a describe block to skip if none of THIS FILE's tests are selected. */
function describeIfSelected(name: string, testNames: string[], fn: () => void) {
  describeIfSelectedShared(name, testNames, fn, selectedTests);
}

/** Per-test gate against this file's selection (concurrent, as before). */
function testIfSelected(testName: string, fn: () => Promise<void>, timeout: number) {
  testConcurrentIfSelected(testName, fn, timeout, selectedTests);
}

describeIfSelected('LLM-as-judge quality evals', ['setup block'], () => {
  testIfSelected('setup block', async () => {
    const t0 = Date.now();
    // browse/SKILL.md carries the Aside contract ({{ASIDE_SETUP}}). Judge the
    // detection block — probe + the three outcomes — up to the driving rules.
    const content = fs.readFileSync(path.join(ROOT, 'browse', 'SKILL.md'), 'utf-8');
    const setupStart = content.indexOf('## BROWSER SETUP (Aside');
    const setupEnd = content.indexOf('### Rules for driving a real browser', setupStart);
    if (setupStart < 0 || setupEnd < 0) throw new Error('browse/SKILL.md: Aside BROWSER SETUP block not found — regenerate with: bun run gen:skill-docs');
    const section = content.slice(setupStart, setupEnd);

    const scores = await judge('Aside browser detection / readiness instructions', section);
    console.log('Setup block scores:', JSON.stringify(scores, null, 2));

    evalCollector?.addTest({
      name: 'setup block',
      suite: 'LLM-as-judge quality evals',
      tier: 'llm-judge',
      passed: scores.actionability >= 3 && scores.clarity >= 3,
      duration_ms: Date.now() - t0,
      cost_usd: 0.02,
      judge_scores: { clarity: scores.clarity, completeness: scores.completeness, actionability: scores.actionability },
      judge_reasoning: scores.reasoning,
    });

    // The detection block is intentionally minimal (probe + three outcomes);
    // the judge sometimes scores 3 because the driving rules live below it.
    expect(scores.actionability).toBeGreaterThanOrEqual(3);
    expect(scores.clarity).toBeGreaterThanOrEqual(3);
  }, 30_000);

});

// --- Part 7: QA skill quality evals (C6) ---

/**
 * QA carve (token-reduction Phase 4): the '## Modes', '## Workflow',
 * '## Health Score Rubric', '## Framework-Specific Guidance', and
 * '## Important Rules' blocks moved from qa/SKILL.md into the generated
 * on-demand section qa/sections/qa-patterns.md. Monolith-tolerant: falls back
 * to the skeleton when the section file doesn't exist (pre-carve checkout).
 */
function readQaPatterns(): string {
  const sectionPath = path.join(ROOT, 'qa', 'sections', 'qa-patterns.md');
  return fs.existsSync(sectionPath)
    ? fs.readFileSync(sectionPath, 'utf-8')
    : fs.readFileSync(path.join(ROOT, 'qa', 'SKILL.md'), 'utf-8');
}

/** Slice out of the qa-patterns section, guarded non-empty: judging an empty
 * slice would silently pass garbage to the judge. */
function sliceQaPatterns(startHeader: string, endHeader?: string): string {
  const content = readQaPatterns();
  const start = content.indexOf(startHeader);
  if (start < 0) throw new Error(`qa/sections/qa-patterns.md: "${startHeader}" not found — regenerate with: bun run gen:skill-docs`);
  const end = endHeader ? content.indexOf(endHeader, start) : -1;
  const section = end > start ? content.slice(start, end) : content.slice(start);
  if (section.trim().length < 200) {
    throw new Error(`qa/sections/qa-patterns.md slice at "${startHeader}" is empty/stub — regenerate with: bun run gen:skill-docs`);
  }
  return section;
}

describeIfSelected('QA skill quality evals', ['qa/SKILL.md workflow', 'qa/SKILL.md health rubric', 'qa/SKILL.md anti-refusal'], () => {
  testIfSelected('qa/SKILL.md workflow', async () => {
    const t0 = Date.now();
    const section = sliceQaPatterns('## Workflow', '## Health Score Rubric');

    const scores = await callJudge<JudgeScore>(`You are evaluating the quality of a QA testing workflow document for an AI coding agent.

The agent reads this document to learn how to systematically QA test a web application. The workflow references
the Aside browser driver (\`aside repl\` scripts) whose contract and cookbook are documented separately in the skill's BROWSER SETUP section — do NOT penalize for missing driver definitions.
Instead, evaluate whether the workflow itself is clear, complete, and actionable.

Rate on three dimensions (1-5 scale):
- **clarity** (1-5): Can an agent follow the step-by-step phases without ambiguity?
- **completeness** (1-5): Are all phases, decision points, and outputs well-defined?
- **actionability** (1-5): Can an agent execute the workflow and produce the expected deliverables?

Respond with ONLY valid JSON:
{"clarity": N, "completeness": N, "actionability": N, "reasoning": "brief explanation"}

Here is the QA workflow to evaluate:

${section}`);
    console.log('QA workflow scores:', JSON.stringify(scores, null, 2));

    evalCollector?.addTest({
      name: 'qa/SKILL.md workflow',
      suite: 'QA skill quality evals',
      tier: 'llm-judge',
      passed: scores.clarity >= 4 && scores.completeness >= 3 && scores.actionability >= 4,
      duration_ms: Date.now() - t0,
      cost_usd: 0.02,
      judge_scores: { clarity: scores.clarity, completeness: scores.completeness, actionability: scores.actionability },
      judge_reasoning: scores.reasoning,
    });

    expect(scores.clarity).toBeGreaterThanOrEqual(4);
    // Completeness scores 3 when judge notes the health rubric is in a separate
    // section (the eval only passes the Workflow section, not the full document).
    expect(scores.completeness).toBeGreaterThanOrEqual(3);
    expect(scores.actionability).toBeGreaterThanOrEqual(4);
  }, 30_000);

  testIfSelected('qa/SKILL.md health rubric', async () => {
    const t0 = Date.now();
    const section = sliceQaPatterns('## Health Score Rubric');

    const scores = await callJudge<JudgeScore>(`You are evaluating a health score rubric that an AI agent must follow to compute a numeric QA score.

The agent uses this rubric after QA testing a website. It needs to:
1. Understand each scoring category and what counts as a deduction
2. Apply the weights correctly to compute a final score out of 100
3. Produce a consistent, reproducible score

Rate on three dimensions (1-5 scale):
- **clarity** (1-5): Are the categories, deduction criteria, and weights unambiguous?
- **completeness** (1-5): Are all edge cases and scoring boundaries defined?
- **actionability** (1-5): Can an agent compute a correct score from this rubric alone?

Respond with ONLY valid JSON:
{"clarity": N, "completeness": N, "actionability": N, "reasoning": "brief explanation"}

Here is the rubric to evaluate:

${section}`);
    console.log('QA health rubric scores:', JSON.stringify(scores, null, 2));

    evalCollector?.addTest({
      name: 'qa/SKILL.md health rubric',
      suite: 'QA skill quality evals',
      tier: 'llm-judge',
      passed: scores.clarity >= 4 && scores.completeness >= 3 && scores.actionability >= 4,
      duration_ms: Date.now() - t0,
      cost_usd: 0.02,
      judge_scores: { clarity: scores.clarity, completeness: scores.completeness, actionability: scores.actionability },
      judge_reasoning: scores.reasoning,
    });

    expect(scores.clarity).toBeGreaterThanOrEqual(4);
    expect(scores.completeness).toBeGreaterThanOrEqual(3);
    expect(scores.actionability).toBeGreaterThanOrEqual(4);
  }, 30_000);

  testIfSelected('qa/SKILL.md anti-refusal', async () => {
    const t0 = Date.now();
    // Extract both the diff-aware mode section and Important Rules section.
    // (Pre-carve this sliced '## Important Rules' → '## Framework-Specific',
    // which was EMPTY — Framework-Specific precedes Important Rules — so the
    // judge only ever saw excerpt 1. The section-file slice fixes that: rules
    // run to the end of qa-patterns.md, so rule 12 "Never refuse to use the
    // browser" now actually reaches the judge.)
    const diffAwareSection = sliceQaPatterns('### Diff-aware', '### Full');
    const rulesSection = sliceQaPatterns('## Important Rules');

    const result = await callJudge<{ would_browse: boolean; fallback_behavior: string; confidence: number; reasoning: string }>(`You are evaluating whether a QA testing skill document would cause an AI agent to USE THE BROWSER or REFUSE to use the browser in a specific scenario.

SCENARIO:
A user runs /qa (a browser-based QA testing skill). The branch diff shows ONLY prompt template files and config file changes — no routes, views, controllers, components, or CSS were changed. The changes are "purely backend" with no obvious UI surface.

QUESTION: Based on the document excerpts below, would the agent open the browser and test the application, or would it decline/refuse to browse and suggest running evals or unit tests instead?

DOCUMENT EXCERPT 1 (Diff-aware mode instructions):
${diffAwareSection}

DOCUMENT EXCERPT 2 (Important Rules):
${rulesSection}

Respond with ONLY valid JSON:
{
  "would_browse": true or false,
  "fallback_behavior": "description of what the agent would do when no UI pages are identified from the diff",
  "confidence": N (1-5, how confident you are in your answer),
  "reasoning": "brief explanation"
}

Rules:
- would_browse should be true if the document instructs the agent to always use the browser regardless of diff content
- would_browse should be false if the document allows the agent to skip browser testing for non-UI changes
- confidence: 5 = document is unambiguous, 1 = document is unclear or contradictory`);

    console.log('QA anti-refusal result:', JSON.stringify(result, null, 2));

    evalCollector?.addTest({
      name: 'qa/SKILL.md anti-refusal',
      suite: 'QA skill quality evals',
      tier: 'llm-judge',
      passed: result.would_browse === true && result.confidence >= 4,
      duration_ms: Date.now() - t0,
      cost_usd: 0.02,
      judge_scores: { would_browse: result.would_browse ? 1 : 0, confidence: result.confidence },
      judge_reasoning: result.reasoning,
    });

    expect(result.would_browse).toBe(true);
    expect(result.confidence).toBeGreaterThanOrEqual(4);
  }, 30_000);
});

// --- Part 7: Cross-skill consistency judge (C7) ---

describeIfSelected('Cross-skill consistency evals', ['cross-skill greptile consistency'], () => {
  testIfSelected('cross-skill greptile consistency', async () => {
    const t0 = Date.now();
    const reviewContent = fs.readFileSync(path.join(ROOT, 'review', 'SKILL.md'), 'utf-8');
    const shipContent = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');
    const triageContent = fs.readFileSync(path.join(ROOT, 'review', 'greptile-triage.md'), 'utf-8');
    const retroContent = fs.readFileSync(path.join(ROOT, 'retro', 'SKILL.md'), 'utf-8');

    const extractGrepLines = (content: string, filename: string) => {
      const lines = content.split('\n')
        .filter(l => /greptile|history\.md|REMOTE_SLUG/i.test(l))
        .map(l => l.trim());
      return `--- ${filename} ---\n${lines.join('\n')}`;
    };

    const collected = [
      extractGrepLines(reviewContent, 'review/SKILL.md'),
      extractGrepLines(shipContent, 'ship/SKILL.md'),
      extractGrepLines(triageContent, 'review/greptile-triage.md'),
      extractGrepLines(retroContent, 'retro/SKILL.md'),
    ].join('\n\n');

    const result = await callJudge<{ consistent: boolean; issues: string[]; score: number; reasoning: string }>(`You are evaluating whether multiple skill configuration files implement the same data architecture consistently.

INTENDED ARCHITECTURE:
- greptile-history has TWO paths: per-project (~/.gstack/projects/{slug}/greptile-history.md) and global (~/.gstack/greptile-history.md)
- /review and /ship WRITE to BOTH paths (per-project for suppressions, global for retro aggregation)
- /review and /ship delegate write mechanics to greptile-triage.md
- /retro READS from the GLOBAL path only (it aggregates across all projects)
- REMOTE_SLUG derivation should be consistent across files that use it

Below are greptile-related lines extracted from each skill file:

${collected}

Evaluate consistency. Respond with ONLY valid JSON:
{
  "consistent": true/false,
  "issues": ["issue 1", "issue 2"],
  "score": N,
  "reasoning": "brief explanation"
}

score (1-5): 5 = perfectly consistent, 1 = contradictory`);

    console.log('Cross-skill consistency:', JSON.stringify(result, null, 2));

    evalCollector?.addTest({
      name: 'cross-skill greptile consistency',
      suite: 'Cross-skill consistency evals',
      tier: 'llm-judge',
      passed: result.consistent && result.score >= 4,
      duration_ms: Date.now() - t0,
      cost_usd: 0.02,
      judge_scores: { consistency_score: result.score },
      judge_reasoning: result.reasoning,
    });

    expect(result.consistent).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(4);
  }, 30_000);
});

// --- Workflow SKILL.md quality evals (10 new tests for 100% coverage) ---

/**
 * DRY helper for workflow SKILL.md judge tests.
 * Extracts a section from a SKILL.md file and judges its quality as an agent workflow.
 */
async function runWorkflowJudge(opts: {
  testName: string;
  suite: string;
  skillPath: string;
  startMarker: string;
  endMarker: string | null;
  judgeContext: string;
  judgeGoal: string;
  thresholds?: { clarity: number; completeness: number; actionability: number };
}) {
  const t0 = Date.now();
  const defaults = { clarity: 4, completeness: 3, actionability: 4 };
  const thresholds = { ...defaults, ...opts.thresholds };

  // Read the skeleton + sections UNION so carved skills (v2 plan T9) still
  // expose markers that moved into sections/*.md (e.g. plan-eng's "## Review
  // Sections" + "## CRITICAL RULE", plan-design's 7 passes). Without this the
  // slice markers vanish from the skeleton and the judge scores empty content.
  let content = fs.readFileSync(path.join(ROOT, opts.skillPath), 'utf-8');
  const secDir = path.join(ROOT, path.dirname(opts.skillPath), 'sections');
  const sectionBodies: string[] = [];
  if (fs.existsSync(secDir)) {
    for (const f of fs.readdirSync(secDir).sort()) {
      if (f.endsWith('.md') && !f.endsWith('.md.tmpl')) {
        const body = fs.readFileSync(path.join(secDir, f), 'utf-8');
        sectionBodies.push(body);
        content += '\n' + body;
      }
    }
  }
  const startIdx = content.indexOf(opts.startMarker);
  if (startIdx === -1) throw new Error(`Start marker not found in ${opts.skillPath}: "${opts.startMarker}"`);

  let section: string;
  if (opts.endMarker) {
    const endIdx = content.indexOf(opts.endMarker, startIdx);
    if (endIdx === -1) throw new Error(`End marker not found in ${opts.skillPath}: "${opts.endMarker}"`);
    section = content.slice(startIdx, endIdx);
  } else {
    section = content.slice(startIdx);
  }

  // Two carve shapes exist. plan-eng/plan-design moved the MARKERS into the
  // section files, so the slice above already reaches the carved content.
  // document-release instead keeps its markers in the skeleton and carves the
  // workflow BODY (Steps 2-9 → sections/release-body.md) AFTER the endMarker,
  // so the marker slice drops it. Re-append any carved section the window
  // excluded, so the judge always sees the full workflow the agent executes.
  for (const body of sectionBodies) {
    const head = body.trim().slice(0, 120);
    if (head && !section.includes(head)) section += '\n' + body;
  }

  const scores = await callJudge<JudgeScore>(`You are evaluating the quality of ${opts.judgeContext} for an AI coding agent.

The agent reads this document to learn ${opts.judgeGoal}. It references external tools and files
that are documented separately — do NOT penalize for missing external definitions.

Rate on three dimensions (1-5 scale):
- **clarity** (1-5): Can an agent follow the instructions without ambiguity?
- **completeness** (1-5): Are all steps, decision points, and outputs well-defined?
- **actionability** (1-5): Can an agent execute this workflow and produce the expected deliverables?

Respond with ONLY valid JSON:
{"clarity": N, "completeness": N, "actionability": N, "reasoning": "brief explanation"}

Here is the document to evaluate:

${section}`);

  console.log(`${opts.testName} scores:`, JSON.stringify(scores, null, 2));

  evalCollector?.addTest({
    name: opts.testName,
    suite: opts.suite,
    tier: 'llm-judge',
    passed: scores.clarity >= thresholds.clarity && scores.completeness >= thresholds.completeness && scores.actionability >= thresholds.actionability,
    duration_ms: Date.now() - t0,
    cost_usd: 0.02,
    judge_scores: { clarity: scores.clarity, completeness: scores.completeness, actionability: scores.actionability },
    judge_reasoning: scores.reasoning,
  });

  expect(scores.clarity).toBeGreaterThanOrEqual(thresholds.clarity);
  expect(scores.completeness).toBeGreaterThanOrEqual(thresholds.completeness);
  expect(scores.actionability).toBeGreaterThanOrEqual(thresholds.actionability);
}

// Block 1: Ship & Release skills
describeIfSelected('Ship & Release skill evals', ['ship/SKILL.md workflow', 'document-release/SKILL.md workflow'], () => {
  testIfSelected('ship/SKILL.md workflow', async () => {
    await runWorkflowJudge({
      testName: 'ship/SKILL.md workflow',
      suite: 'Ship & Release skill evals',
      skillPath: 'ship/SKILL.md',
      startMarker: '# Ship:',
      endMarker: '## Important Rules',
      judgeContext: 'a ship/release workflow document',
      judgeGoal: 'how to create a PR: merge base branch, run tests, review diff, bump version, update changelog, push, and open PR',
    });
  }, 30_000);

  testIfSelected('document-release/SKILL.md workflow', async () => {
    await runWorkflowJudge({
      testName: 'document-release/SKILL.md workflow',
      suite: 'Ship & Release skill evals',
      skillPath: 'document-release/SKILL.md',
      startMarker: '# Document Release:',
      endMarker: '## Important Rules',
      judgeContext: 'a post-ship documentation update workflow',
      judgeGoal: 'how to audit and update project documentation after code ships: README, ARCHITECTURE, CONTRIBUTING, CLAUDE.md, CHANGELOG, TODOS',
    });
  }, 30_000);
});

// Block 2: Plan Review skills
describeIfSelected('Plan Review skill evals', [
  'plan-ceo-review/SKILL.md modes', 'plan-eng-review/SKILL.md sections', 'plan-design-review/SKILL.md passes',
], () => {
  testIfSelected('plan-ceo-review/SKILL.md modes', async () => {
    await runWorkflowJudge({
      testName: 'plan-ceo-review/SKILL.md modes',
      suite: 'Plan Review skill evals',
      skillPath: 'plan-ceo-review/SKILL.md',
      startMarker: '## Step 0: Nuclear Scope Challenge',
      endMarker: '## Review Sections',
      judgeContext: 'a CEO/founder plan review framework with 4 scope modes',
      judgeGoal: 'how to conduct a CEO-perspective plan review: challenge scope, select a mode (Expansion, Selective Expansion, Hold Scope, Reduction), then review sections interactively',
    });
  }, 30_000);

  testIfSelected('plan-eng-review/SKILL.md sections', async () => {
    await runWorkflowJudge({
      testName: 'plan-eng-review/SKILL.md sections',
      suite: 'Plan Review skill evals',
      skillPath: 'plan-eng-review/SKILL.md',
      startMarker: '## BEFORE YOU START:',
      endMarker: '## CRITICAL RULE',
      judgeContext: 'an engineering plan review framework with 4 review sections',
      judgeGoal: 'how to review a plan for architecture quality, code quality, test coverage, and performance — walking through each section interactively with AskUserQuestion',
    });
  }, 30_000);

  testIfSelected('plan-design-review/SKILL.md passes', async () => {
    await runWorkflowJudge({
      testName: 'plan-design-review/SKILL.md passes',
      suite: 'Plan Review skill evals',
      skillPath: 'plan-design-review/SKILL.md',
      startMarker: '## Review Sections',
      endMarker: '## CRITICAL RULE',
      judgeContext: 'a design plan review framework with 7 review passes',
      judgeGoal: 'how to review a plan for design quality using a 0-10 rating method: rate each dimension, explain what a 10 looks like, edit the plan to fix gaps, then re-rate',
    });
  }, 30_000);
});

// Block 3: Design skills
describeIfSelected('Design skill evals', ['design-review/SKILL.md fix loop', 'design-consultation/SKILL.md research'], () => {
  testIfSelected('design-review/SKILL.md fix loop', async () => {
    await runWorkflowJudge({
      testName: 'design-review/SKILL.md fix loop',
      suite: 'Design skill evals',
      skillPath: 'design-review/SKILL.md',
      startMarker: '## Phase 7:',
      endMarker: '## Additional Rules',
      judgeContext: 'a design audit triage and fix loop workflow',
      judgeGoal: 'how to triage design issues by severity, fix them atomically in source code, commit each fix, and re-verify with before/after screenshots',
    });
  }, 30_000);

  testIfSelected('design-consultation/SKILL.md research', async () => {
    await runWorkflowJudge({
      testName: 'design-consultation/SKILL.md research',
      suite: 'Design skill evals',
      skillPath: 'design-consultation/SKILL.md',
      startMarker: '## Phase 1:',
      endMarker: '## Phase 4:',
      judgeContext: 'a design consultation research and proposal workflow',
      judgeGoal: 'how to gather product context, research the competitive landscape, and produce a complete design system proposal with typography, color, spacing, and motion specifications',
    });
  }, 30_000);
});

// Block 4: Deploy skills
describeIfSelected('Deploy skill evals', [
  'land-and-deploy/SKILL.md workflow', 'canary/SKILL.md monitoring loop',
  'benchmark/SKILL.md perf collection', 'setup-deploy/SKILL.md platform setup',
], () => {
  testIfSelected('land-and-deploy/SKILL.md workflow', async () => {
    await runWorkflowJudge({
      testName: 'land-and-deploy/SKILL.md workflow',
      suite: 'Deploy skill evals',
      skillPath: 'land-and-deploy/SKILL.md',
      startMarker: '## Step 1: Pre-flight',
      endMarker: '## Important Rules',
      judgeContext: 'a merge-deploy-verify workflow for landing PRs to production',
      judgeGoal: 'how to merge a PR via GitHub CLI, wait for CI and deploy workflows (with platform-specific strategies for Fly.io/Render/Vercel/Netlify), run canary health checks on production, and offer revert if something breaks — with timing data logged for retrospectives',
    });
  }, 30_000);

  testIfSelected('canary/SKILL.md monitoring loop', async () => {
    await runWorkflowJudge({
      testName: 'canary/SKILL.md monitoring loop',
      suite: 'Deploy skill evals',
      skillPath: 'canary/SKILL.md',
      startMarker: '### Phase 2: Baseline Capture',
      endMarker: '## Important Rules',
      judgeContext: 'a post-deploy canary monitoring workflow driving the Aside browser via aside repl scripts',
      judgeGoal: 'how to capture baseline screenshots and metrics before deploy, run a continuous monitoring loop checking each page every 60 seconds for console errors and performance regressions, fire alerts with evidence (screenshots), and produce a health report with per-page status and verdict',
    });
  }, 30_000);

  testIfSelected('benchmark/SKILL.md perf collection', async () => {
    await runWorkflowJudge({
      testName: 'benchmark/SKILL.md perf collection',
      suite: 'Deploy skill evals',
      skillPath: 'benchmark/SKILL.md',
      startMarker: '### Phase 3: Performance Data Collection',
      endMarker: '## Important Rules',
      judgeContext: 'a performance regression detection workflow using browser-based Web Vitals measurement, driven through the Aside browser',
      judgeGoal: 'how to collect real performance metrics (TTFB, FCP, LCP, bundle sizes, request counts) via performance.getEntries(), compare against baselines with regression thresholds, produce a performance report with delta analysis, and track trends over time',
    });
  }, 30_000);

  testIfSelected('setup-deploy/SKILL.md platform setup', async () => {
    await runWorkflowJudge({
      testName: 'setup-deploy/SKILL.md platform setup',
      suite: 'Deploy skill evals',
      skillPath: 'setup-deploy/SKILL.md',
      startMarker: '### Step 2: Detect platform',
      endMarker: '## Important Rules',
      judgeContext: 'a deployment configuration setup workflow that detects deploy platforms and writes config to CLAUDE.md',
      judgeGoal: 'how to detect deploy platforms (Fly.io, Render, Vercel, Netlify, Heroku, GitHub Actions, custom), gather platform-specific configuration (URLs, status commands, health checks, custom hooks), and persist everything to CLAUDE.md for future automated use',
    });
  }, 30_000);
});

// Block 5: Other skills
describeIfSelected('Other skill evals', [
  'retro/SKILL.md instructions', 'qa-only/SKILL.md workflow', 'gstack-upgrade/SKILL.md upgrade flow',
], () => {
  testIfSelected('retro/SKILL.md instructions', async () => {
    await runWorkflowJudge({
      testName: 'retro/SKILL.md instructions',
      suite: 'Other skill evals',
      skillPath: 'retro/SKILL.md',
      startMarker: '## Instructions',
      endMarker: '## Compare Mode',
      judgeContext: 'an engineering retrospective data gathering and analysis workflow',
      judgeGoal: 'how to gather git metrics (commit history, test counts, work patterns), analyze them, produce a structured retro report with praise, growth areas, and trend tracking',
    });
  }, 30_000);

  testIfSelected('qa-only/SKILL.md workflow', async () => {
    await runWorkflowJudge({
      testName: 'qa-only/SKILL.md workflow',
      suite: 'Other skill evals',
      skillPath: 'qa-only/SKILL.md',
      startMarker: '## Workflow',
      endMarker: '## Important Rules',
      judgeContext: 'a report-only QA testing workflow',
      judgeGoal: 'how to systematically QA test a web application and produce a structured report with health score, screenshots, and repro steps — without fixing anything',
    });
  }, 30_000);

  testIfSelected('gstack-upgrade/SKILL.md upgrade flow', async () => {
    await runWorkflowJudge({
      testName: 'gstack-upgrade/SKILL.md upgrade flow',
      suite: 'Other skill evals',
      skillPath: 'gstack-upgrade/SKILL.md',
      startMarker: '## Inline upgrade flow',
      endMarker: '## Standalone usage',
      judgeContext: 'a version upgrade detection and execution workflow',
      judgeGoal: 'how to detect install type, compare versions, back up current install, upgrade via git or fresh clone, run setup, and show what changed',
    });
  }, 30_000);
});

// Voice directive eval — tests that the voice section produces the right tone
describeIfSelected('Voice directive eval', ['voice directive tone'], () => {
  testIfSelected('voice directive tone', async () => {
    const t0 = Date.now();
    // Read a tier 2+ skill to get the full voice directive in context
    const content = fs.readFileSync(path.join(ROOT, 'review', 'SKILL.md'), 'utf-8');
    const voiceStart = content.indexOf('## Voice');
    if (voiceStart === -1) {
      throw new Error('Voice section not found in review/SKILL.md. Was preamble.ts regenerated?');
    }
    const voiceEnd = content.indexOf('\n## ', voiceStart + 1);
    const voiceSection = content.slice(voiceStart, voiceEnd > 0 ? voiceEnd : voiceStart + 3000);

    const result = await callJudge<{
      directness: number;
      concreteness: number;
      avoids_corporate: number;
      avoids_ai_vocabulary: number;
      connects_user_outcomes: number;
      reasoning: string;
    }>(`You are evaluating a voice directive for an AI coding assistant framework called GStack.
Score each dimension 1-5 where 5 is excellent:

1. directness: Does it instruct the agent to be direct, lead with the point, take positions?
2. concreteness: Does it instruct the agent to name specific files, commands, line numbers, real numbers?
3. avoids_corporate: Does it explicitly ban corporate/formal/academic tone and provide alternatives?
4. avoids_ai_vocabulary: Does it ban AI-tell words and phrases with specific lists?
5. connects_user_outcomes: Does it instruct the agent to connect technical work to real user experience?

Return JSON only:
{"directness": N, "concreteness": N, "avoids_corporate": N, "avoids_ai_vocabulary": N, "connects_user_outcomes": N, "reasoning": "..."}

THE VOICE DIRECTIVE:
${voiceSection}`);

    console.log('Voice directive scores:', JSON.stringify(result, null, 2));

    evalCollector?.addTest({
      name: 'voice directive tone',
      suite: 'Voice directive eval',
      tier: 'llm-judge',
      passed: result.directness >= 4 && result.concreteness >= 4 && result.avoids_corporate >= 4
        && result.avoids_ai_vocabulary >= 4 && result.connects_user_outcomes >= 4,
      duration_ms: Date.now() - t0,
      cost_usd: 0.02,
      judge_scores: {
        directness: result.directness,
        concreteness: result.concreteness,
        avoids_corporate: result.avoids_corporate,
        avoids_ai_vocabulary: result.avoids_ai_vocabulary,
        connects_user_outcomes: result.connects_user_outcomes,
      },
      judge_reasoning: result.reasoning,
    });

    expect(result.directness).toBeGreaterThanOrEqual(4);
    expect(result.concreteness).toBeGreaterThanOrEqual(4);
    expect(result.avoids_corporate).toBeGreaterThanOrEqual(4);
    expect(result.avoids_ai_vocabulary).toBeGreaterThanOrEqual(4);
    expect(result.connects_user_outcomes).toBeGreaterThanOrEqual(4);
  }, 30_000);
});

// Module-level afterAll — finalize eval collector after all tests complete
afterAll(() => finalizeEvalCollector(evalCollector));
