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

import { describe, test, expect, afterAll } from 'bun:test';
import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs';
import * as path from 'path';
import { callJudge, judge } from './helpers/llm-judge';
import type { JudgeScore } from './helpers/llm-judge';
import { EvalCollector } from './helpers/eval-store';
import { selectTests, detectBaseBranch, getChangedFiles, LLM_JUDGE_TOUCHFILES, GLOBAL_TOUCHFILES } from './helpers/touchfiles';

const ROOT = path.resolve(import.meta.dir, '..');
// Run when EVALS=1 is set (requires ANTHROPIC_API_KEY in env)
const evalsEnabled = !!process.env.EVALS;
const describeEval = evalsEnabled ? describe : describe.skip;

// Eval result collector
const evalCollector = evalsEnabled ? new EvalCollector('llm-judge') : null;

// --- Diff-based test selection ---
let selectedTests: string[] | null = null;

if (evalsEnabled && !process.env.EVALS_ALL) {
  const baseBranch = process.env.EVALS_BASE
    || detectBaseBranch(ROOT)
    || 'main';
  const changedFiles = getChangedFiles(baseBranch, ROOT);

  if (changedFiles.length > 0) {
    const selection = selectTests(changedFiles, LLM_JUDGE_TOUCHFILES, GLOBAL_TOUCHFILES);
    selectedTests = selection.selected;
    process.stderr.write(`\nLLM-judge selection (${selection.reason}): ${selection.selected.length}/${Object.keys(LLM_JUDGE_TOUCHFILES).length} tests\n`);
    if (selection.skipped.length > 0) {
      process.stderr.write(`  Skipped: ${selection.skipped.join(', ')}\n`);
    }
    process.stderr.write('\n');
  }
}

/** Wrap a describe block to skip if none of its tests are selected. */
function describeIfSelected(name: string, testNames: string[], fn: () => void) {
  const anySelected = selectedTests === null || testNames.some(t => selectedTests!.includes(t));
  (anySelected ? describeEval : describe.skip)(name, fn);
}

/** Skip an individual test if not selected (for multi-test describe blocks). */
function testIfSelected(testName: string, fn: () => Promise<void>, timeout: number) {
  const shouldRun = selectedTests === null || selectedTests.includes(testName);
  (shouldRun ? test : test.skip)(testName, fn, timeout);
}

describeIfSelected('LLM-as-judge quality evals', [
  'command reference table', 'snapshot flags reference',
  'browse/SKILL.md reference', 'setup block', 'regression vs baseline',
], () => {
  testIfSelected('command reference table', async () => {
    const t0 = Date.now();
    const content = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
    const start = content.indexOf('## Command Reference');
    const end = content.indexOf('## Tips');
    const section = content.slice(start, end);

    const scores = await judge('command reference table', section);
    console.log('Command reference scores:', JSON.stringify(scores, null, 2));

    evalCollector?.addTest({
      name: 'command reference table',
      suite: 'LLM-as-judge quality evals',
      tier: 'llm-judge',
      passed: scores.clarity >= 4 && scores.completeness >= 4 && scores.actionability >= 4,
      duration_ms: Date.now() - t0,
      cost_usd: 0.02,
      judge_scores: { clarity: scores.clarity, completeness: scores.completeness, actionability: scores.actionability },
      judge_reasoning: scores.reasoning,
    });

    expect(scores.clarity).toBeGreaterThanOrEqual(4);
    expect(scores.completeness).toBeGreaterThanOrEqual(4);
    expect(scores.actionability).toBeGreaterThanOrEqual(4);
  }, 30_000);

  testIfSelected('snapshot flags reference', async () => {
    const t0 = Date.now();
    const content = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
    const start = content.indexOf('## Snapshot System');
    const end = content.indexOf('## Command Reference');
    const section = content.slice(start, end);

    const scores = await judge('snapshot flags reference', section);
    console.log('Snapshot flags scores:', JSON.stringify(scores, null, 2));

    evalCollector?.addTest({
      name: 'snapshot flags reference',
      suite: 'LLM-as-judge quality evals',
      tier: 'llm-judge',
      passed: scores.clarity >= 4 && scores.completeness >= 4 && scores.actionability >= 4,
      duration_ms: Date.now() - t0,
      cost_usd: 0.02,
      judge_scores: { clarity: scores.clarity, completeness: scores.completeness, actionability: scores.actionability },
      judge_reasoning: scores.reasoning,
    });

    expect(scores.clarity).toBeGreaterThanOrEqual(4);
    expect(scores.completeness).toBeGreaterThanOrEqual(4);
    expect(scores.actionability).toBeGreaterThanOrEqual(4);
  }, 30_000);

  testIfSelected('browse/SKILL.md reference', async () => {
    const t0 = Date.now();
    const content = fs.readFileSync(path.join(ROOT, 'browse', 'SKILL.md'), 'utf-8');
    const start = content.indexOf('## Snapshot Flags');
    const section = content.slice(start);

    const scores = await judge('browse skill reference (flags + commands)', section);
    console.log('Browse SKILL.md scores:', JSON.stringify(scores, null, 2));

    evalCollector?.addTest({
      name: 'browse/SKILL.md reference',
      suite: 'LLM-as-judge quality evals',
      tier: 'llm-judge',
      passed: scores.clarity >= 4 && scores.completeness >= 4 && scores.actionability >= 4,
      duration_ms: Date.now() - t0,
      cost_usd: 0.02,
      judge_scores: { clarity: scores.clarity, completeness: scores.completeness, actionability: scores.actionability },
      judge_reasoning: scores.reasoning,
    });

    expect(scores.clarity).toBeGreaterThanOrEqual(4);
    expect(scores.completeness).toBeGreaterThanOrEqual(4);
    expect(scores.actionability).toBeGreaterThanOrEqual(4);
  }, 30_000);

  testIfSelected('setup block', async () => {
    const t0 = Date.now();
    const content = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
    const setupStart = content.indexOf('## SETUP');
    const setupEnd = content.indexOf('## IMPORTANT');
    const section = content.slice(setupStart, setupEnd);

    const scores = await judge('setup/binary discovery instructions', section);
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

    // Setup block is intentionally minimal (binary discovery only).
    // SKILL_DIR is inferred from context, so judge sometimes scores 3.
    expect(scores.actionability).toBeGreaterThanOrEqual(3);
    expect(scores.clarity).toBeGreaterThanOrEqual(3);
  }, 30_000);

  testIfSelected('regression vs baseline', async () => {
    const t0 = Date.now();
    const generated = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
    const genStart = generated.indexOf('## Command Reference');
    const genEnd = generated.indexOf('## Tips');
    const genSection = generated.slice(genStart, genEnd);

    const baseline = `## Command Reference

### Navigation
| Command | Description |
|---------|-------------|
| \`goto <url>\` | Navigate to URL |
| \`back\` / \`forward\` | History navigation |
| \`reload\` | Reload page |
| \`url\` | Print current URL |

### Interaction
| Command | Description |
|---------|-------------|
| \`click <sel>\` | Click element |
| \`fill <sel> <val>\` | Fill input |
| \`select <sel> <val>\` | Select dropdown |
| \`hover <sel>\` | Hover element |
| \`type <text>\` | Type into focused element |
| \`press <key>\` | Press key (Enter, Tab, Escape) |
| \`scroll [sel]\` | Scroll element into view |
| \`wait <sel>\` | Wait for element (max 10s) |
| \`wait --networkidle\` | Wait for network to be idle |
| \`wait --load\` | Wait for page load event |

### Inspection
| Command | Description |
|---------|-------------|
| \`js <expr>\` | Run JavaScript |
| \`css <sel> <prop>\` | Computed CSS |
| \`attrs <sel>\` | Element attributes |
| \`is <prop> <sel>\` | State check (visible/hidden/enabled/disabled/checked/editable/focused) |
| \`console [--clear\\|--errors]\` | Console messages (--errors filters to error/warning) |`;

    const client = new Anthropic();
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `You are comparing two versions of CLI documentation for an AI coding agent.

VERSION A (baseline — hand-maintained):
${baseline}

VERSION B (auto-generated from source):
${genSection}

Which version is better for an AI agent trying to use these commands? Consider:
- Completeness (more commands documented? all args shown?)
- Clarity (descriptions helpful?)
- Coverage (missing commands in either version?)

Respond with ONLY valid JSON:
{"winner": "A" or "B" or "tie", "reasoning": "brief explanation", "a_score": N, "b_score": N}

Scores are 1-5 overall quality.`,
      }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`Judge returned non-JSON: ${text.slice(0, 200)}`);
    const result = JSON.parse(jsonMatch[0]);
    console.log('Regression comparison:', JSON.stringify(result, null, 2));

    evalCollector?.addTest({
      name: 'regression vs baseline',
      suite: 'LLM-as-judge quality evals',
      tier: 'llm-judge',
      passed: result.b_score >= result.a_score,
      duration_ms: Date.now() - t0,
      cost_usd: 0.02,
      judge_scores: { a_score: result.a_score, b_score: result.b_score },
      judge_reasoning: result.reasoning,
    });

    expect(result.b_score).toBeGreaterThanOrEqual(result.a_score);
  }, 30_000);
});

// --- Part 7: QA skill quality evals (C6) ---

describeIfSelected('QA skill quality evals', ['qa/SKILL.md workflow', 'qa/SKILL.md health rubric', 'qa/SKILL.md anti-refusal'], () => {
  const qaContent = fs.readFileSync(path.join(ROOT, 'qa', 'SKILL.md'), 'utf-8');

  testIfSelected('qa/SKILL.md workflow', async () => {
    const t0 = Date.now();
    const start = qaContent.indexOf('## Workflow');
    const end = qaContent.indexOf('## Health Score Rubric');
    const section = qaContent.slice(start, end);

    const scores = await callJudge<JudgeScore>(`You are evaluating the quality of a QA testing workflow document for an AI coding agent.

The agent reads this document to learn how to systematically QA test a web application. The workflow references
a headless browser CLI ($B commands) that is documented separately — do NOT penalize for missing CLI definitions.
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
    const start = qaContent.indexOf('## Health Score Rubric');
    const section = qaContent.slice(start);

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
    // Extract both the diff-aware mode section and Important Rules section
    const diffAwareStart = qaContent.indexOf('### Diff-aware');
    const diffAwareEnd = qaContent.indexOf('### Full');
    const rulesStart = qaContent.indexOf('## Important Rules');
    const rulesEnd = qaContent.indexOf('## Framework-Specific');
    const diffAwareSection = qaContent.slice(diffAwareStart, diffAwareEnd);
    const rulesSection = qaContent.slice(rulesStart, rulesEnd);

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

// --- Part 7: Baseline score pinning (C9) ---

describeIfSelected('Baseline score pinning', ['baseline score pinning'], () => {
  const baselinesPath = path.join(ROOT, 'test', 'fixtures', 'eval-baselines.json');

  testIfSelected('baseline score pinning', async () => {
    const t0 = Date.now();
    if (!fs.existsSync(baselinesPath)) {
      console.log('No baseline file found — skipping pinning check');
      return;
    }

    const baselines = JSON.parse(fs.readFileSync(baselinesPath, 'utf-8'));
    const regressions: string[] = [];

    const skillContent = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
    const cmdStart = skillContent.indexOf('## Command Reference');
    const cmdEnd = skillContent.indexOf('## Tips');
    const cmdSection = skillContent.slice(cmdStart, cmdEnd);
    const cmdScores = await judge('command reference table', cmdSection);

    for (const dim of ['clarity', 'completeness', 'actionability'] as const) {
      if (cmdScores[dim] < baselines.command_reference[dim]) {
        regressions.push(`command_reference.${dim}: ${cmdScores[dim]} < baseline ${baselines.command_reference[dim]}`);
      }
    }

    if (process.env.UPDATE_BASELINES) {
      baselines.command_reference = {
        clarity: cmdScores.clarity,
        completeness: cmdScores.completeness,
        actionability: cmdScores.actionability,
      };
      fs.writeFileSync(baselinesPath, JSON.stringify(baselines, null, 2) + '\n');
      console.log('Updated eval baselines');
    }

    const passed = regressions.length === 0;
    evalCollector?.addTest({
      name: 'baseline score pinning',
      suite: 'Baseline score pinning',
      tier: 'llm-judge',
      passed,
      duration_ms: Date.now() - t0,
      cost_usd: 0.02,
      judge_scores: { clarity: cmdScores.clarity, completeness: cmdScores.completeness, actionability: cmdScores.actionability },
      judge_reasoning: passed ? 'All scores at or above baseline' : regressions.join('; '),
    });

    if (!passed) {
      throw new Error(`Score regressions detected:\n${regressions.join('\n')}`);
    }
  }, 60_000);
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

  const content = fs.readFileSync(path.join(ROOT, opts.skillPath), 'utf-8');
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
      judgeContext: 'a post-deploy canary monitoring workflow using a headless browser daemon',
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
      judgeContext: 'a performance regression detection workflow using browser-based Web Vitals measurement',
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

// Module-level afterAll — finalize eval collector after all tests complete
afterAll(async () => {
  if (evalCollector) {
    try {
      await evalCollector.finalize();
    } catch (err) {
      console.error('Failed to save eval results:', err);
    }
  }
});
