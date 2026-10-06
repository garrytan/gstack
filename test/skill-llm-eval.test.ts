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
import { JUDGE_MS } from './helpers/eval-budgets';
import * as fs from 'fs';
import * as path from 'path';
import { callJudge, judge, JudgeRefusalError, JUDGE_SCORE_SCHEMA, QA_ANTI_REFUSAL_JUDGE_SCHEMA, VOICE_DIRECTIVE_JUDGE_SCHEMA, CROSS_SKILL_CONSISTENCY_JUDGE_SCHEMA, buildQaWorkflowJudgePrompt, buildQaHealthRubricJudgePrompt, buildQaAntiRefusalJudgePrompt, buildCrossSkillConsistencyJudgePrompt, buildVoiceDirectiveJudgePrompt, DEFAULT_JUDGE_MAX_TOKENS, judgePanel, judgePanelMean, judgePanelMedian, judgePanelSummary, judgePanelMajority, judgePanelReasoning, JUDGE_SCORE_DIMENSIONS } from './helpers/llm-judge';
import { ASK_QUESTIONS_HEADING, ENG_REVIEW_EXCERPT } from './helpers/workflow-excerpt';
import type { JudgeScore } from './helpers/llm-judge';
import { readWorkflowJudgeInput, buildWorkflowJudgePrompt, QA_DISCOVERY_REFERENCES, WORKFLOW_JUDGE_RESPONSE_SCHEMA, type WorkflowJudgeInput } from './helpers/workflow-judge-input';
import { BROWSE_JUDGE_FLOORS, browseJudgeFloorsMet, prepareWorkflowJudgeCache, validWorkflowJudgeScore } from './helpers/workflow-judge-cache';
import { buildCookieWorkflowJudgeInput, COOKIE_WORKFLOW_JUDGE } from './helpers/cookie-workflow-judge-input';
import { getCookieWorkflowManualReview, type ManualJudgeReview } from './helpers/cookie-workflow-manual-review';
import { resolveEvalModel } from '../lib/eval-model';
import type { EvalCacheValue } from '../scripts/eval-input-cache';
import { LLM_JUDGE_TOUCHFILES } from './helpers/touchfiles';
// Runs when EVALS=1 is set (requires ANTHROPIC_API_KEY in env) — the EVALS
// gate lives in the shared describeIfSelected. Selection machinery is shared
// with the E2E suite; only the touchfiles table (LLM_JUDGE_TOUCHFILES, passed
// explicitly below) differs. No EVALS_TIER filter applies here — LLM-judge
// tests have no E2E_TIERS entries and run in both tier lanes.
import {
  ROOT,
  computeDiffSelection,
  resolveModuleSelection,
  createEvalCollector,
  finalizeEvalCollector,
  describeIfSelected as describeIfSelectedShared,
  testConcurrentIfSelected,
} from './helpers/e2e-helpers';

// Eval result collector
const evalCollector = createEvalCollector('llm-judge');

/**
 * Browse carve (token-reduction Phase 4): the '## Snapshot Flags' and
 * '## Full Command List' reference blocks moved from browse/SKILL.md into the
 * generated on-demand section browse/sections/command-list.md ('## Snapshot
 * Flags' first, then '## Full Command List'). '## SETUP', '## Core QA
 * Patterns', and '## CSS Inspector' stay in the skeleton. Non-empty guard:
 * judging an empty slice would silently pass garbage to the judge.
 */
function readBrowseCommandSection(): string {
  const p = path.join(ROOT, 'browse', 'sections', 'command-list.md');
  const content = fs.readFileSync(p, 'utf-8');
  if (!content.includes('## Snapshot Flags') || !content.includes('## Full Command List')) {
    throw new Error(
      `${p} is missing the expected headers — regenerate with: bun run gen:skill-docs`,
    );
  }
  return content;
}

/** Slice a section out of the command-list section file, guarded non-empty. */
function sliceBrowseSection(startHeader: string): string {
  const content = readBrowseCommandSection();
  const start = content.indexOf(startHeader);
  if (start < 0) throw new Error(`browse/sections/command-list.md: "${startHeader}" not found`);
  const section = content.slice(start);
  if (section.trim().length < 200) {
    throw new Error(`browse/sections/command-list.md slice at "${startHeader}" is empty/stub — regenerate with: bun run gen:skill-docs`);
  }
  return section;
}

// --- Diff-based test selection (LLM_JUDGE_TOUCHFILES, not the E2E table) ---
const selectedTests = resolveModuleSelection(
  process.env.EVALS ? process.env.EVALS_JUDGE_SELECTION_JSON : undefined,
  () => computeDiffSelection(LLM_JUDGE_TOUCHFILES, 'LLM-judge'),
);

/** Wrap a describe block to skip if none of THIS FILE's tests are selected. */
function describeIfSelected(name: string, testNames: string[], fn: () => void) {
  describeIfSelectedShared(name, testNames, fn, selectedTests);
}

/** Per-test gate against this file's selection (concurrent, as before). */
function testIfSelected(testName: string, fn: () => Promise<void>, timeout: number) {
  testConcurrentIfSelected(testName, fn, timeout, selectedTests);
}

describeIfSelected('LLM-as-judge quality evals', [
  'browse/SKILL.md reference', 'setup block',
], () => {
  testIfSelected('browse/SKILL.md reference', async () => {
    const t0 = Date.now();
    // Browse carve: snapshot flags + the full command list are the whole
    // generated section file; one judge grades the union. Scores are also
    // compared with test/fixtures/eval-baselines.json and the difference is
    // recorded (UPDATE_BASELINES=1 rewrites it); only the floors gate.
    const section = sliceBrowseSection('## Snapshot Flags');

    const samples = await judgePanel(() => judge('browse skill reference (flags + commands)', section));
    const { median: scores, mean } = judgePanelSummary(samples, JUDGE_SCORE_DIMENSIONS);
    console.log('Browse SKILL.md panel:', JSON.stringify({ gate: 'median', median: scores, mean, samples }, null, 2));

    const baselinesPath = path.join(ROOT, 'test', 'fixtures', 'eval-baselines.json');
    const baselines = JSON.parse(fs.readFileSync(baselinesPath, 'utf-8'));
    const regressions = (['clarity', 'completeness', 'actionability'] as const)
      .filter(dim => scores[dim] < baselines.browse_skill[dim])
      .map(dim => `browse_skill.${dim}: ${scores[dim]} < baseline ${baselines.browse_skill[dim]}`);
    if (process.env.UPDATE_BASELINES) {
      baselines.browse_skill = { clarity: scores.clarity, completeness: scores.completeness, actionability: scores.actionability };
      fs.writeFileSync(baselinesPath, JSON.stringify(baselines, null, 2) + '\n');
      console.log('Updated eval baselines');
    }

    evalCollector?.addTest({
      name: 'browse/SKILL.md reference',
      suite: 'LLM-as-judge quality evals',
      tier: 'llm-judge',
      passed: browseJudgeFloorsMet(scores),
      duration_ms: Date.now() - t0,
      cost_usd: 0.02 * samples.length,
      judge_scores: { clarity: scores.clarity, completeness: scores.completeness, actionability: scores.actionability },
      judge_reasoning: regressions.length ? `${judgePanelReasoning(samples)} | ${regressions.join('; ')}` : judgePanelReasoning(samples),
    });

    expect(scores.clarity).toBeGreaterThanOrEqual(BROWSE_JUDGE_FLOORS.clarity);
    expect(scores.completeness).toBeGreaterThanOrEqual(BROWSE_JUDGE_FLOORS.completeness);
    expect(scores.actionability).toBeGreaterThanOrEqual(BROWSE_JUDGE_FLOORS.actionability);
  }, JUDGE_MS);

  testIfSelected('setup block', async () => {
    const t0 = Date.now();
    // P2 (v1.2.0): the browse setup block moved from the root router to browse/SKILL.md.
    const content = fs.readFileSync(path.join(ROOT, 'browse', 'SKILL.md'), 'utf-8');
    // The setup block is the Aside contract ('## BROWSER SETUP (Aside ...') with
    // the browse binary as fallback; older renders headed it '## SETUP'. Slice
    // from whichever heading is present to the next H2.
    let setupStart = content.indexOf('## BROWSER SETUP');
    if (setupStart < 0) setupStart = content.indexOf('## SETUP');
    const setupEnd = content.indexOf('\n## ', setupStart + 3);
    if (setupStart < 0 || setupEnd < 0) throw new Error('browse/SKILL.md: setup block not found — regenerate with: bun run gen:skill-docs');
    const section = content.slice(setupStart, setupEnd);

    const samples = await judgePanel(() => judge('setup/binary discovery instructions', section));
    const { median: scores, mean } = judgePanelSummary(samples, JUDGE_SCORE_DIMENSIONS);
    console.log('Setup block panel:', JSON.stringify({ gate: 'median', median: scores, mean, samples }, null, 2));

    evalCollector?.addTest({
      name: 'setup block',
      suite: 'LLM-as-judge quality evals',
      tier: 'llm-judge',
      passed: scores.actionability >= 3 && scores.clarity >= 3,
      duration_ms: Date.now() - t0,
      cost_usd: 0.02 * samples.length,
      judge_scores: { clarity: scores.clarity, completeness: scores.completeness, actionability: scores.actionability },
      judge_reasoning: judgePanelReasoning(samples),
    });

    // Setup block is intentionally minimal (binary discovery only).
    // SKILL_DIR is inferred from context, so judge sometimes scores 3.
    expect(scores.actionability).toBeGreaterThanOrEqual(3);
    expect(scores.clarity).toBeGreaterThanOrEqual(3);
  }, JUDGE_MS);

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
    const section = readWorkflowJudgeInput({ root: ROOT, skillPath: 'qa/SKILL.md',
      startMarker: '# /qa: Test', endMarker: null,
      // qa-patterns.md loads both browser assets; judges penalized their absence.
      references: ['qa/templates/functional-report-template.md', 'qa/templates/qa-report-template.md', 'qa/references/issue-taxonomy.md'] }).text;

    const samples = await judgePanel(() => callJudge<JudgeScore>(buildQaWorkflowJudgePrompt(section)));
    const { median: scores, mean } = judgePanelSummary(samples, JUDGE_SCORE_DIMENSIONS);
    console.log('QA workflow panel:', JSON.stringify({ gate: 'median', median: scores, mean, samples }, null, 2));

    evalCollector?.addTest({
      name: 'qa/SKILL.md workflow',
      suite: 'QA skill quality evals',
      tier: 'llm-judge',
      passed: scores.clarity >= 3 && scores.completeness >= 3 && scores.actionability >= 4,
      duration_ms: Date.now() - t0,
      cost_usd: 0.02 * samples.length,
      judge_scores: { clarity: scores.clarity, completeness: scores.completeness, actionability: scores.actionability },
      judge_reasoning: judgePanelReasoning(samples),
    });

    expect(scores.clarity).toBeGreaterThanOrEqual(3);
    // Completeness scores 3 when judge notes the health rubric is in a separate
    // section (the eval only passes the Workflow section, not the full document).
    expect(scores.completeness).toBeGreaterThanOrEqual(3);
    expect(scores.actionability).toBeGreaterThanOrEqual(4);
  }, JUDGE_MS);

  testIfSelected('qa/SKILL.md health rubric', async () => {
    const t0 = Date.now();
    const section = sliceQaPatterns('## Health Score Rubric');

    const samples = await judgePanel(() => callJudge<JudgeScore>(buildQaHealthRubricJudgePrompt(section), undefined, { jsonSchema: JUDGE_SCORE_SCHEMA }));
    const { median: scores, mean } = judgePanelSummary(samples, JUDGE_SCORE_DIMENSIONS);
    console.log('QA health rubric panel:', JSON.stringify({ gate: 'median', median: scores, mean, samples }, null, 2));

    evalCollector?.addTest({
      name: 'qa/SKILL.md health rubric',
      suite: 'QA skill quality evals',
      tier: 'llm-judge',
      passed: scores.clarity >= 3 && scores.completeness >= 3 && scores.actionability >= 4,
      duration_ms: Date.now() - t0,
      cost_usd: 0.02 * samples.length,
      judge_scores: { clarity: scores.clarity, completeness: scores.completeness, actionability: scores.actionability },
      judge_reasoning: judgePanelReasoning(samples),
    });

    expect(scores.clarity).toBeGreaterThanOrEqual(3);
    expect(scores.completeness).toBeGreaterThanOrEqual(3);
    expect(scores.actionability).toBeGreaterThanOrEqual(4);
  }, JUDGE_MS);

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

    const samples = await judgePanel(() => callJudge<{ would_browse: boolean; fallback_behavior: string; confidence: number; reasoning: string }>(buildQaAntiRefusalJudgePrompt(diffAwareSection, rulesSection), undefined, { jsonSchema: QA_ANTI_REFUSAL_JUDGE_SCHEMA }));
    const result = { would_browse: judgePanelMajority(samples, 'would_browse'), ...judgePanelMedian(samples, ['confidence'] as const) };

    console.log('QA anti-refusal panel:', JSON.stringify({ gate: 'median', result, mean: judgePanelMean(samples, ['confidence'] as const), samples }, null, 2));

    evalCollector?.addTest({
      name: 'qa/SKILL.md anti-refusal',
      suite: 'QA skill quality evals',
      tier: 'llm-judge',
      passed: result.would_browse === true && result.confidence >= 4,
      duration_ms: Date.now() - t0,
      cost_usd: 0.02 * samples.length,
      judge_scores: { would_browse: result.would_browse ? 1 : 0, confidence: result.confidence },
      judge_reasoning: judgePanelReasoning(samples),
    });

    expect(result.would_browse).toBe(true);
    expect(result.confidence).toBeGreaterThanOrEqual(4);
  }, JUDGE_MS);
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

    const samples = await judgePanel(() => callJudge<{ consistent: boolean; issues: string[]; score: number; reasoning: string }>(buildCrossSkillConsistencyJudgePrompt(collected), undefined, { jsonSchema: CROSS_SKILL_CONSISTENCY_JUDGE_SCHEMA }));
    const result = { consistent: judgePanelMajority(samples, 'consistent'), ...judgePanelMedian(samples, ['score'] as const) };

    console.log('Cross-skill consistency panel:', JSON.stringify({ gate: 'median', result, mean: judgePanelMean(samples, ['score'] as const), samples }, null, 2));

    evalCollector?.addTest({
      name: 'cross-skill greptile consistency',
      suite: 'Cross-skill consistency evals',
      tier: 'llm-judge',
      passed: result.consistent && result.score >= 4,
      duration_ms: Date.now() - t0,
      cost_usd: 0.02 * samples.length,
      judge_scores: { consistency_score: result.score },
      judge_reasoning: judgePanelReasoning(samples),
    });

    expect(result.consistent).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(4);
  }, JUDGE_MS);
});

// --- Workflow SKILL.md quality evals (10 new tests for 100% coverage) ---

/**
 * DRY helper for workflow SKILL.md judge tests.
 * Extracts a section from a SKILL.md file and judges its quality as an agent workflow.
 */
// Keep model work at JUDGE_MS. Only terminal recording/cache I/O gets grace.
const WORKFLOW_JUDGE_RECORD_MS = 5_000;
const WORKFLOW_JUDGE_TEST_MS = JUDGE_MS + 10_000;
const workflowJudgeAttempts = new Map<string, { attempt: number; cancel(): void }>();

async function runWorkflowJudge(opts: {
  testName: string;
  suite: string;
  skillPath: string;
  startMarker: string;
  endMarker: string | RegExp | null;
  references?: readonly string[];
  judgeContext: string;
  judgeGoal: string;
  agentCapability?: 'frontier';
  schemaTransport?: boolean;
  compactReasoning?: boolean;
  maxTokens?: number;
  stream?: boolean;
  effort?: 'medium';
  model?: string;
  thresholds?: { clarity: number; completeness: number; actionability: number };
  readInput?: () => WorkflowJudgeInput;
}) {
  const started = performance.now();
  const previous = workflowJudgeAttempts.get(opts.testName);
  previous?.cancel();
  const attempt = (previous?.attempt ?? 0) + 1;
  const controller = new AbortController();
  const workDeadline = started + JUDGE_MS;
  let stage: 'input' | 'judge' | 'validation' | 'recording' = 'input';
  let finalized = false;
  let samples: JudgeScore[] | undefined;
  let scores: Record<typeof JUDGE_SCORE_DIMENSIONS[number], number> | undefined;
  let manualReview: ManualJudgeReview | undefined;
  let customInputMetadata: { prompt: string; model: string } | undefined;
  let reused: ReturnType<ReturnType<typeof prepareWorkflowJudgeCache>['lookup']> = null;
  let timer: ReturnType<typeof setTimeout>;
  let rejectStopped: (error: Error) => void;
  const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
  const deadlineError = () => Object.assign(new Error(`${opts.testName} exceeded its workflow judge ${stage === 'recording' ? 'recording' : 'work'} deadline`), { name: 'WorkflowJudgeDeadline' });
  const deadline = () => workDeadline + (stage === 'recording' ? WORKFLOW_JUDGE_RECORD_MS : 0);
  const active = () => !finalized && workflowJudgeAttempts.get(opts.testName) === state
    && performance.now() < deadline();
  const finish = (passed: boolean, error?: unknown) => {
    if (finalized) return;
    finalized = true;
    clearTimeout(timer);
    if (!passed) controller.abort(error);
    evalCollector?.addTest({
      name: opts.testName, suite: opts.suite, tier: 'llm-judge', passed, attempt,
      duration_ms: Math.max(0, performance.now() - started),
      cost_usd: reused || !samples ? 0 : 0.02 * samples.length,
      execution: reused ? 'reused' : 'executed',
      ...customInputMetadata,
      ...(manualReview ? { manual_review: manualReview } : {}),
      ...(reused ? { reused_from: { input_key: reused.reuse.key, run_id: reused.reuse.source.runId,
        revision: reused.reuse.source.revision, completed_at: new Date(reused.reuse.source.completedAt).toISOString() } } : {}),
      ...(scores ? { judge_scores: { clarity: scores.clarity, completeness: scores.completeness, actionability: scores.actionability } } : {}),
      ...(samples ? { judge_reasoning: judgePanelReasoning(samples) } : {}),
      ...(passed ? {} : { exit_reason: error instanceof JudgeRefusalError ? 'provider_refusal'
        : error instanceof Error && error.name === 'WorkflowJudgeDeadline' ? 'timeout'
        : error instanceof Error && error.name === 'WorkflowJudgeSuperseded' ? 'cancelled'
        : stage === 'validation' ? 'validation_failed' : 'harness_error',
      error: `${error instanceof Error ? error.message : String(error)}${samples ? '' : error instanceof JudgeRefusalError
        ? '\nNo automated score; provider refusal usage retained when manually accepted; cost unavailable.'
        : '\nNo completed model response; cost and usage unavailable.'}` }),
    });
  };
  const stop = (error: Error) => {
    if (finalized) return;
    try { finish(false, error); } finally { rejectStopped(error); }
  };
  const state = { attempt, cancel: () => stop(performance.now() >= deadline() ? deadlineError()
    : Object.assign(new Error(`${opts.testName} attempt superseded by retry`), { name: 'WorkflowJudgeSuperseded' })) };
  // Register before any input read: a failed fixture read is still attempt one.
  workflowJudgeAttempts.set(opts.testName, state);
  const checkActive = () => {
    if (!active()) {
      if (!finalized) stop(deadlineError());
      throw controller.signal.reason ?? deadlineError();
    }
  };
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => stop(deadlineError()), Math.max(0, deadline() - performance.now())); };
  arm();

  // registered attempt -> bounded request -> unchanged assertions -> terminal record
  // Timeout/retry finalizes once; late provider continuations cannot publish evidence.
  const work = async () => {
    checkActive();
    const thresholds = { clarity: 3, completeness: 3, actionability: 4, ...opts.thresholds };
    const input = opts.readInput ? opts.readInput() : readWorkflowJudgeInput({ root: ROOT, skillPath: opts.skillPath,
      startMarker: opts.startMarker, endMarker: opts.endMarker, references: opts.references });
    checkActive();
    const prompt = buildWorkflowJudgePrompt(opts, input);
    if (opts.readInput) customInputMetadata = { prompt, model: resolveEvalModel('judge', opts.model) };
    const cache = prepareWorkflowJudgeCache({ ...opts, root: ROOT, thresholds, prompt, attempt });
    checkActive();
    reused = cache.lookup();
    checkActive();
    stage = 'judge';
    const maxTokens = opts.maxTokens ?? DEFAULT_JUDGE_MAX_TOKENS;
    let result: JudgeScore[];
    try {
      result = reused?.samples ?? await judgePanel(() => callJudge<JudgeScore>(prompt, opts.model, { signal: controller.signal, max_tokens: maxTokens,
        ...(opts.stream ? { stream: true } : {}),
        ...(opts.schemaTransport ? { jsonSchema: WORKFLOW_JUDGE_RESPONSE_SCHEMA } : {}),
        ...(opts.effort ? { effort: opts.effort } : {}) }));
    } catch (error) {
      checkActive();
      if (error instanceof JudgeRefusalError && customInputMetadata) {
        const approved = getCookieWorkflowManualReview(ROOT, { testName: opts.testName, prompt,
          model: customInputMetadata.model, maxTokens, thresholds, attempt }, error.refusal);
        checkActive();
        if (approved) {
          manualReview = approved;
          console.log(`[workflow-judge] ${opts.testName}: MANUAL ACCEPTANCE, no automated score; ${approved.approval.approval_url}`);
          finish(false, error);
          return;
        }
      }
      throw error;
    }
    checkActive();
    samples = result;
    console.log(`[workflow-judge] ${opts.testName}: ${reused ? `reused ${reused.reuse.source.runId} @ ${reused.reuse.source.revision} (${new Date(reused.reuse.source.completedAt).toISOString()})` : 'executed'}`);
    stage = 'validation';
    if (opts.compactReasoning && !samples.every(sample => validWorkflowJudgeScore(sample as unknown as EvalCacheValue, { clarity: 1, completeness: 1, actionability: 1 }, true))) {
      throw new Error('Workflow judge violated the compact response contract');
    }
    scores = judgePanelMedian(samples, JUDGE_SCORE_DIMENSIONS);
    console.log(`${opts.testName} panel:`, JSON.stringify({ gate: 'median', median: scores, mean: judgePanelMean(samples, JUDGE_SCORE_DIMENSIONS), samples }, null, 2));
    expect(scores.clarity).toBeGreaterThanOrEqual(thresholds.clarity);
    expect(scores.completeness).toBeGreaterThanOrEqual(thresholds.completeness);
    expect(scores.actionability).toBeGreaterThanOrEqual(thresholds.actionability);
    checkActive();
    stage = 'recording';
    arm();
    const discardReceipt = reused ? undefined : cache.publish(samples, active);
    try { checkActive(); finish(true); }
    catch (error) { discardReceipt?.(); throw error; }
  };
  try { await Promise.race([work(), stopped]); }
  catch (error) {
    const failure = finalized ? controller.signal.reason ?? error
      : performance.now() >= deadline() ? deadlineError() : error;
    if (!finalized) finish(false, failure);
    throw failure;
  }
}

// Block 1: Ship & Release skills
describeIfSelected('Ship & Release skill evals', ['ship/SKILL.md workflow', 'document-release/SKILL.md workflow'], () => {
  testIfSelected('ship/SKILL.md workflow', async () => {
    await runWorkflowJudge({
      testName: 'ship/SKILL.md workflow',
      schemaTransport: true,
      compactReasoning: true,
      maxTokens: 65_536,
      stream: true,
      // Default effort thought past JUDGE_MS in 3 of 18 measured samples; medium kept all 18 under 80 s.
      effort: 'medium',
      suite: 'Ship & Release skill evals',
      agentCapability: 'frontier',
      // The contract now precedes platform detection; keep the complete workflow.
      skillPath: 'ship/SKILL.md',
      startMarker: '# Ship:',
      endMarker: '## Important Rules',
      references: QA_DISCOVERY_REFERENCES,
      judgeContext: 'a ship/release workflow document',
      judgeGoal: 'how to create a PR: merge base, test, review and explore changed behavior, handle required blocked checks, bump metadata, finish and vet every-ship documentation, then verify stable inputs, push and create/update the PR with visible QA and docs outcomes',
    });
  }, WORKFLOW_JUDGE_TEST_MS);

  testIfSelected('document-release/SKILL.md workflow', async () => {
    await runWorkflowJudge({
      testName: 'document-release/SKILL.md workflow',
      schemaTransport: true,
      suite: 'Ship & Release skill evals',
      skillPath: 'document-release/SKILL.md',
      startMarker: '# Document Release:',
      endMarker: '## Important Rules',
      judgeContext: 'a release documentation audit workflow',
      judgeGoal: 'how to audit relevant nested docs and authored sources; in ship-owned mode complete a bounded docs-only audit and return a typed result without Git/metadata authority, while standalone mode retains its approval and publication protections',
    });
  }, WORKFLOW_JUDGE_TEST_MS);
});

// Block 2: Plan Review skills
describeIfSelected('Plan Review skill evals', [
  'plan-ceo-review/SKILL.md modes', 'plan-eng-review/SKILL.md sections', 'plan-design-review/SKILL.md passes',
], () => {
  testIfSelected('plan-ceo-review/SKILL.md modes', async () => {
    await runWorkflowJudge({
      testName: 'plan-ceo-review/SKILL.md modes',
      schemaTransport: true,
      suite: 'Plan Review skill evals',
      skillPath: 'plan-ceo-review/SKILL.md',
      startMarker: '## Step 0: Nuclear Scope Challenge',
      endMarker: '## Review Sections',
      judgeContext: 'a CEO/founder plan review framework with 4 scope modes',
      judgeGoal: 'how to conduct a CEO-perspective plan review: challenge scope, select a mode (Expansion, Selective Expansion, Hold Scope, Reduction), then review sections interactively',
    });
  }, WORKFLOW_JUDGE_TEST_MS);

  testIfSelected('plan-eng-review/SKILL.md sections', async () => {
    await runWorkflowJudge({
      testName: 'plan-eng-review/SKILL.md sections',
      schemaTransport: true,
      suite: 'Plan Review skill evals',
      skillPath: ENG_REVIEW_EXCERPT.skillPath,
      startMarker: '# Plan Review Mode',
      endMarker: null,
      judgeContext: 'an engineering plan review framework with 4 review sections',
      judgeGoal: 'how to review a plan for architecture quality, code quality, test coverage, and performance — walking through each section interactively with AskUserQuestion',
    });
  }, WORKFLOW_JUDGE_TEST_MS);

  testIfSelected('plan-design-review/SKILL.md passes', async () => {
    await runWorkflowJudge({
      testName: 'plan-design-review/SKILL.md passes',
      schemaTransport: true,
      suite: 'Plan Review skill evals',
      skillPath: 'plan-design-review/SKILL.md',
      startMarker: '## Review Sections',
      endMarker: ASK_QUESTIONS_HEADING,
      judgeContext: 'a design plan review framework with 7 review passes',
      judgeGoal: 'how to review a plan for design quality using a 0-10 rating method: rate each dimension, explain what a 10 looks like, edit the plan to fix gaps, then re-rate',
    });
  }, WORKFLOW_JUDGE_TEST_MS);
});

// Block 3: Design skills
describeIfSelected('Design skill evals', ['design-review/SKILL.md fix loop', 'design-consultation/SKILL.md research'], () => {
  testIfSelected('design-review/SKILL.md fix loop', async () => {
    await runWorkflowJudge({
      testName: 'design-review/SKILL.md fix loop',
      schemaTransport: true,
      suite: 'Design skill evals',
      skillPath: 'design-review/SKILL.md',
      startMarker: '## Phase 7:',
      endMarker: '## Additional Rules',
      judgeContext: 'a design audit triage and fix loop workflow',
      judgeGoal: 'how to triage design issues by severity, fix them atomically in source code, commit each fix, and re-verify with before/after screenshots',
    });
  }, WORKFLOW_JUDGE_TEST_MS);

  testIfSelected('design-consultation/SKILL.md research', async () => {
    await runWorkflowJudge({
      testName: 'design-consultation/SKILL.md research',
      schemaTransport: true,
      suite: 'Design skill evals',
      skillPath: 'design-consultation/SKILL.md',
      startMarker: '## Phase 0:',
      endMarker: '## Phase 4:',
      judgeContext: 'a design consultation research and proposal workflow',
      judgeGoal: 'how to gather product context, research the competitive landscape, and produce a complete design system proposal with typography, color, spacing, and motion specifications',
    });
  }, WORKFLOW_JUDGE_TEST_MS);
});

// Block 4: Deploy skills
describeIfSelected('Deploy skill evals', [
  'land-and-deploy/SKILL.md workflow', 'canary/SKILL.md monitoring loop',
  'benchmark/SKILL.md perf collection', 'setup-deploy/SKILL.md platform setup',
], () => {
  testIfSelected('land-and-deploy/SKILL.md workflow', async () => {
    await runWorkflowJudge({
      testName: 'land-and-deploy/SKILL.md workflow',
      schemaTransport: true,
      suite: 'Deploy skill evals',
      skillPath: 'land-and-deploy/SKILL.md',
      startMarker: '## Step 1: Pre-flight',
      endMarker: '## Important Rules',
      judgeContext: 'a merge-deploy-verify workflow for landing PRs to production',
      judgeGoal: 'how to merge a PR via GitHub CLI, wait for CI and deploy workflows (with platform-specific strategies for Fly.io/Render/Vercel/Netlify), run canary health checks on production, and offer revert if something breaks — with timing data logged for retrospectives',
    });
  }, WORKFLOW_JUDGE_TEST_MS);

  testIfSelected('canary/SKILL.md monitoring loop', async () => {
    await runWorkflowJudge({
      testName: 'canary/SKILL.md monitoring loop',
      schemaTransport: true,
      suite: 'Deploy skill evals',
      skillPath: 'canary/SKILL.md',
      startMarker: '### Phase 2: Baseline Capture',
      endMarker: '## Important Rules',
      judgeContext: 'a post-deploy canary monitoring workflow driving a real browser (Aside first, the gstack headless browser as fallback)',
      judgeGoal: 'how to capture baseline screenshots and metrics before deploy, run a continuous monitoring loop checking each page every 60 seconds for console errors and performance regressions, fire alerts with evidence (screenshots), and produce a health report with per-page status and verdict',
    });
  }, WORKFLOW_JUDGE_TEST_MS);

  testIfSelected('benchmark/SKILL.md perf collection', async () => {
    await runWorkflowJudge({
      testName: 'benchmark/SKILL.md perf collection',
      schemaTransport: true,
      suite: 'Deploy skill evals',
      skillPath: 'benchmark/SKILL.md',
      startMarker: '### Phase 3: Performance Data Collection',
      endMarker: '## Important Rules',
      judgeContext: 'a performance regression detection workflow using browser-based Web Vitals measurement (Aside first, the gstack headless browser as fallback)',
      judgeGoal: 'how to collect real performance metrics (TTFB, FCP, LCP, bundle sizes, request counts) via performance.getEntries(), compare against baselines with regression thresholds, produce a performance report with delta analysis, and track trends over time',
    });
  }, WORKFLOW_JUDGE_TEST_MS);

  testIfSelected('setup-deploy/SKILL.md platform setup', async () => {
    await runWorkflowJudge({
      testName: 'setup-deploy/SKILL.md platform setup',
      schemaTransport: true,
      suite: 'Deploy skill evals',
      skillPath: 'setup-deploy/SKILL.md',
      startMarker: '### Step 2: Detect platform',
      endMarker: '## Important Rules',
      judgeContext: 'a deployment configuration setup workflow that detects deploy platforms and writes config to CLAUDE.md',
      judgeGoal: 'how to detect deploy platforms (Fly.io, Render, Vercel, Netlify, Heroku, GitHub Actions, custom), gather platform-specific configuration (URLs, status commands, health checks, custom hooks), and persist everything to CLAUDE.md for future automated use',
    });
  }, WORKFLOW_JUDGE_TEST_MS);
});

// Block 5: Other skills
describeIfSelected('Other skill evals', [
  'retro/SKILL.md instructions', 'qa-only/SKILL.md workflow', 'review/SKILL.md workflow', 'gstack-upgrade/SKILL.md upgrade flow',
  'sync-gbrain/SKILL.md read-only readiness',
], () => {
  testIfSelected('review/SKILL.md workflow', async () => {
    await runWorkflowJudge({
      testName: 'review/SKILL.md workflow',
      suite: 'Other skill evals',
      skillPath: 'review/SKILL.md',
      startMarker: '## Step 0: Detect platform and base branch',
      endMarker: null,
      references: [...QA_DISCOVERY_REFERENCES, 'review/checklist.md', 'review/specialists/testing.md'],
      judgeContext: 'a pre-landing review with bounded exploratory QA',
      judgeGoal: 'how to review and explore changed behavior even for small diffs without a plan or server, preserve report-only discovery and the test_stub ASK gate, handle incomplete probes honestly, and rerun affected evidence after approved repairs',
      agentCapability: 'frontier',
      // This ~64k-token bundle is the largest workflow input. Thinking and the answer share max_tokens:
      // at default effort, 24 measured samples used up to 6.9k output tokens and a CI sample spent all
      // 8192 without an answer. The ship-sized streaming cap removes truncation; effort stays default.
      maxTokens: 65_536,
      stream: true,
    });
  }, WORKFLOW_JUDGE_TEST_MS);

  testIfSelected('sync-gbrain/SKILL.md read-only readiness', async () => {
    await runWorkflowJudge({
      testName: 'sync-gbrain/SKILL.md read-only readiness',
      schemaTransport: true,
      suite: 'Other skill evals',
      skillPath: 'sync-gbrain/SKILL.md',
      startMarker: '## Step 4: Refresh',
      endMarker: '## Concurrency note',
      judgeContext: 'a source-scoped gbrain readiness and guidance workflow',
      judgeGoal: 'how to verify the pinned worktree source using only bounded reads, preserve guidance when the read is unknown, and report the verdict without creating or deleting pages',
    });
  }, WORKFLOW_JUDGE_TEST_MS);

  testIfSelected('retro/SKILL.md instructions', async () => {
    await runWorkflowJudge({
      testName: 'retro/SKILL.md instructions',
      schemaTransport: true,
      suite: 'Other skill evals',
      skillPath: 'retro/SKILL.md',
      startMarker: '## Instructions',
      endMarker: '## Tone',
      judgeContext: 'an engineering retrospective data gathering and analysis workflow',
      judgeGoal: 'how to gather git metrics (commit history, test counts, work patterns), analyze them, produce a structured retro report with praise, growth areas, and trend tracking',
    });
  }, WORKFLOW_JUDGE_TEST_MS);

  testIfSelected('qa-only/SKILL.md workflow', async () => {
    await runWorkflowJudge({
      testName: 'qa-only/SKILL.md workflow',
      schemaTransport: true,
      suite: 'Other skill evals',
      skillPath: 'qa-only/SKILL.md',
      startMarker: '# /qa-only:',
      endMarker: null,
      references: QA_DISCOVERY_REFERENCES.filter(file => file !== 'qa/sections/exploratory.md'),
      judgeContext: 'a report-only QA testing workflow',
      judgeGoal: 'how to select browser/native functional/mixed targets, explore safely with repository tools, report exact contract evidence and coverage limits, conditionally load browser/DX instructions and never mutate product/tests/Git through any tool',
    });
  }, WORKFLOW_JUDGE_TEST_MS);

  testIfSelected('gstack-upgrade/SKILL.md upgrade flow', async () => {
    await runWorkflowJudge({
      testName: 'gstack-upgrade/SKILL.md upgrade flow',
      schemaTransport: true,
      suite: 'Other skill evals',
      skillPath: 'gstack-upgrade/SKILL.md',
      startMarker: '## Inline upgrade flow',
      endMarker: '## Standalone usage',
      judgeContext: 'a version upgrade detection and execution workflow',
      judgeGoal: 'how to detect install type, compare versions, back up current install, upgrade via git or fresh clone, run setup, and show what changed',
    });
  }, WORKFLOW_JUDGE_TEST_MS);
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

    const samples = await judgePanel(() => callJudge<{
      directness: number;
      concreteness: number;
      avoids_corporate: number;
      avoids_ai_vocabulary: number;
      connects_user_outcomes: number;
      reasoning: string;
    }>(buildVoiceDirectiveJudgePrompt(voiceSection), undefined, { jsonSchema: VOICE_DIRECTIVE_JUDGE_SCHEMA }));
    const { median: result, mean } = judgePanelSummary(samples, ['directness', 'concreteness', 'avoids_corporate', 'avoids_ai_vocabulary', 'connects_user_outcomes'] as const);

    console.log('Voice directive panel:', JSON.stringify({ gate: 'median', median: result, mean, samples }, null, 2));

    evalCollector?.addTest({
      name: 'voice directive tone',
      suite: 'Voice directive eval',
      tier: 'llm-judge',
      passed: result.directness >= 4 && result.concreteness >= 4 && result.avoids_corporate >= 4
        && result.avoids_ai_vocabulary >= 4 && result.connects_user_outcomes >= 4,
      duration_ms: Date.now() - t0,
      cost_usd: 0.02 * samples.length,
      judge_scores: {
        directness: result.directness,
        concreteness: result.concreteness,
        avoids_corporate: result.avoids_corporate,
        avoids_ai_vocabulary: result.avoids_ai_vocabulary,
        connects_user_outcomes: result.connects_user_outcomes,
      },
      judge_reasoning: judgePanelReasoning(samples),
    });

    expect(result.directness).toBeGreaterThanOrEqual(4);
    expect(result.concreteness).toBeGreaterThanOrEqual(4);
    expect(result.avoids_corporate).toBeGreaterThanOrEqual(4);
    expect(result.avoids_ai_vocabulary).toBeGreaterThanOrEqual(4);
    expect(result.connects_user_outcomes).toBeGreaterThanOrEqual(4);
  }, JUDGE_MS);
});

describeIfSelected('Cookie setup workflow quality', ['setup-browser-cookies/SKILL.md workflow'], () => {
  testIfSelected('setup-browser-cookies/SKILL.md workflow', async () => {
    await runWorkflowJudge({
      testName: 'setup-browser-cookies/SKILL.md workflow',
      suite: 'Cookie setup workflow quality',
      skillPath: 'setup-browser-cookies/SKILL.md',
      startMarker: '# Setup Browser Cookies',
      endMarker: null,
      ...COOKIE_WORKFLOW_JUDGE,
      readInput: () => buildCookieWorkflowJudgeInput(ROOT),
    });
  }, WORKFLOW_JUDGE_TEST_MS);
});

// Module-level afterAll — finalize eval collector after all tests complete
afterAll(() => finalizeEvalCollector(evalCollector));
