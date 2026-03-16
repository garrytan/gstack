/**
 * LLM-as-Judge evals for new gstack business/comms skills.
 *
 * Evaluates whether each new SKILL.md is clear, complete, and actionable
 * enough for an AI agent to follow as a workflow methodology.
 *
 * Requires: ANTHROPIC_API_KEY + EVALS=1
 * Cost: ~$0.02 per test (~$0.14 total for 6 skills + 1 cross-check)
 * Run: EVALS=1 bun test test/new-skills-llm-eval.test.ts
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { callJudge } from './helpers/llm-judge';
import type { JudgeScore } from './helpers/llm-judge';
import { EvalCollector } from './helpers/eval-store';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const evalsEnabled = !!process.env.EVALS;
const describeEval = evalsEnabled ? describe : describe.skip;
const evalCollector = evalsEnabled ? new EvalCollector('llm-judge') : null;

interface SkillEvalSpec {
  dir: string;
  name: string;
  section: string;
  sectionStart: string;
  context: string;
  minClarity: number;
  minCompleteness: number;
  minActionability: number;
}

const SKILL_EVALS: SkillEvalSpec[] = [
  {
    dir: 'cfo', name: 'cfo',
    section: 'financial analysis methodology',
    sectionStart: '# /cfo',
    context: 'This skill analyzes codebase costs: infrastructure spending, build-vs-buy decisions, technical debt as financial liability, and scaling cost projections.',
    minClarity: 4, minCompleteness: 3, minActionability: 4,
  },
  {
    dir: 'vc', name: 'vc',
    section: 'due diligence methodology',
    sectionStart: '# /vc',
    context: 'This skill performs technical due diligence from a VC perspective: moat analysis, team velocity assessment, architecture scalability, and investment thesis.',
    minClarity: 4, minCompleteness: 3, minActionability: 4,
  },
  {
    dir: 'board', name: 'board',
    section: 'board briefing methodology',
    sectionStart: '# /board',
    context: 'This skill produces executive technology briefings for board meetings: KPI dashboards, strategic alignment, risk/opportunity framing, and governance compliance.',
    minClarity: 4, minCompleteness: 3, minActionability: 4,
  },
  {
    dir: 'media', name: 'media',
    section: 'media narrative methodology',
    sectionStart: '# /media',
    context: 'This skill mines codebases for stories and crafts narratives: product launches, incident communications, competitive positioning for press.',
    minClarity: 4, minCompleteness: 3, minActionability: 4,
  },
  {
    dir: 'comms', name: 'comms',
    section: 'internal communications methodology',
    sectionStart: '# /comms',
    context: 'This skill generates internal communications: weekly updates, incident comms, RFC summaries, all-hands prep, change management, and onboarding materials.',
    minClarity: 4, minCompleteness: 3, minActionability: 4,
  },
  {
    dir: 'pr-comms', name: 'pr-comms',
    section: 'public relations methodology',
    sectionStart: '# /pr-comms',
    context: 'This skill crafts external communications: press releases, crisis communication plans, social media strategy, thought leadership, and media targeting.',
    minClarity: 4, minCompleteness: 3, minActionability: 4,
  },
];

function extractSkillSection(dir: string, startMarker: string): string {
  const content = fs.readFileSync(path.join(ROOT, dir, 'SKILL.md'), 'utf-8');
  const start = content.indexOf(startMarker);
  if (start === -1) return content.slice(content.indexOf('---', 10) + 3);
  return content.slice(start);
}

describeEval('Business skills quality evals', () => {
  for (const spec of SKILL_EVALS) {
    test(`${spec.name}/SKILL.md ${spec.section} scores >= thresholds`, async () => {
      const t0 = Date.now();
      const section = extractSkillSection(spec.dir, spec.sectionStart);

      const scores = await callJudge<JudgeScore>(`You are evaluating the quality of a workflow document for an AI coding agent.

${spec.context}

The agent reads this document to learn its methodology and follow it step-by-step.
It needs to:
1. Understand its persona and cognitive mode
2. Know what analysis to perform and in what order
3. Know what output formats to produce
4. Handle edge cases and conditional logic
5. Produce actionable, structured deliverables

Rate on three dimensions (1-5 scale):
- **clarity** (1-5): Can an agent follow the phases without ambiguity?
- **completeness** (1-5): Are all phases, outputs, and edge cases defined?
- **actionability** (1-5): Can an agent execute this and produce the expected deliverables?

Respond with ONLY valid JSON:
{"clarity": N, "completeness": N, "actionability": N, "reasoning": "brief explanation"}

Here is the ${spec.section} to evaluate:

${section}`);

      console.log(`${spec.name} scores:`, JSON.stringify(scores, null, 2));

      evalCollector?.addTest({
        name: `${spec.name}/SKILL.md quality`,
        suite: 'Business skills quality evals',
        tier: 'llm-judge',
        passed: scores.clarity >= spec.minClarity
          && scores.completeness >= spec.minCompleteness
          && scores.actionability >= spec.minActionability,
        duration_ms: Date.now() - t0,
        cost_usd: 0.02,
        judge_scores: { clarity: scores.clarity, completeness: scores.completeness, actionability: scores.actionability },
        judge_reasoning: scores.reasoning,
      });

      expect(scores.clarity).toBeGreaterThanOrEqual(spec.minClarity);
      expect(scores.completeness).toBeGreaterThanOrEqual(spec.minCompleteness);
      expect(scores.actionability).toBeGreaterThanOrEqual(spec.minActionability);
    }, 30_000);
  }
});

describeEval('Comms skills cross-consistency eval', () => {
  test('media + comms + pr-comms have complementary non-overlapping scopes', async () => {
    const t0 = Date.now();
    const mediaContent = extractSkillSection('media', '# /media').slice(0, 2000);
    const commsContent = extractSkillSection('comms', '# /comms').slice(0, 2000);
    const prContent = extractSkillSection('pr-comms', '# /pr-comms').slice(0, 2000);

    const result = await callJudge<{ complementary: boolean; overlap_score: number; reasoning: string }>(
      `You are evaluating whether three communication-focused AI agent skills have complementary, non-overlapping scopes.

EXPECTED RESPONSIBILITIES:
- /media: Story mining, narrative crafting, competitive positioning (journalist perspective)
- /comms: Internal communications, stakeholder updates, RFC summaries (internal perspective)
- /pr-comms: Press releases, crisis comms, social media strategy (external PR perspective)

These three skills should COMPLEMENT each other, not duplicate. A good division means:
- Each has a distinct audience (media targets journalists, comms targets internal, pr-comms targets public)
- Each has distinct deliverables (media: stories, comms: updates, pr-comms: press releases)
- They can coordinate (share messaging) but don't duplicate work

Here are excerpts from each skill:

--- /media ---
${mediaContent}

--- /comms ---
${commsContent}

--- /pr-comms ---
${prContent}

Evaluate. Respond with ONLY valid JSON:
{"complementary": true/false, "overlap_score": N, "reasoning": "brief"}

overlap_score (1-5): 5 = no overlap, perfect division. 1 = heavily duplicated.`
    );

    console.log('Comms cross-consistency:', JSON.stringify(result, null, 2));

    evalCollector?.addTest({
      name: 'comms skills complementarity',
      suite: 'Comms skills cross-consistency eval',
      tier: 'llm-judge',
      passed: result.complementary && result.overlap_score >= 4,
      duration_ms: Date.now() - t0,
      cost_usd: 0.02,
      judge_scores: { overlap_score: result.overlap_score },
      judge_reasoning: result.reasoning,
    });

    expect(result.complementary).toBe(true);
    expect(result.overlap_score).toBeGreaterThanOrEqual(3);
  }, 30_000);
});

afterAll(async () => {
  if (evalCollector) {
    try { await evalCollector.finalize(); } catch (err) { console.error('Eval save failed:', err); }
  }
});
