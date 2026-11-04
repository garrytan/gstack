/**
 * LLM-as-a-Judge evals for generated SKILL.md content.
 *
 * Uses the Anthropic API directly (not Agent SDK) for three targeted checks:
 * QA anti-refusal, cross-skill greptile consistency and the voice directive.
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
import { callJudge, QA_ANTI_REFUSAL_JUDGE_SCHEMA, VOICE_DIRECTIVE_JUDGE_SCHEMA, CROSS_SKILL_CONSISTENCY_JUDGE_SCHEMA, buildQaAntiRefusalJudgePrompt, buildCrossSkillConsistencyJudgePrompt, buildVoiceDirectiveJudgePrompt, judgePanel, judgePanelMean, judgePanelMedian, judgePanelSummary, judgePanelMajority, judgePanelReasoning } from './helpers/llm-judge';
import { LLM_JUDGE_TOUCHFILES } from './helpers/touchfiles';
import { readSkillEffective } from './helpers/skill-startup';
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

describeIfSelected('QA skill quality evals', ['qa/SKILL.md anti-refusal'], () => {
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

// Voice directive eval — tests that the voice section produces the right tone
describeIfSelected('Voice directive eval', ['voice directive tone'], () => {
  testIfSelected('voice directive tone', async () => {
    const t0 = Date.now();
    // Read a tier 2+ skill as loaded (SKILL.md plus its shared preamble) to get the full voice directive in context
    const content = readSkillEffective(path.join(ROOT, 'review', 'SKILL.md'));
    const voiceStart = content.indexOf('## Voice');
    if (voiceStart === -1) {
      throw new Error('Voice section not found in review/SKILL.md or its shared preamble. Was preamble.ts regenerated?');
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

// Module-level afterAll — finalize eval collector after all tests complete
afterAll(() => finalizeEvalCollector(evalCollector));
