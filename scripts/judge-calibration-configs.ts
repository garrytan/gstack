/**
 * W2 calibration request configurations, keyed by distinct request (prompt
 * builder, model, max_tokens, stream, effort, thresholds), not by test case.
 * Each config builds prompts through the same builder the eval sends; "old" is
 * today's request and "new" adds only the JSON schema (comparison 1).
 */
import {
  ARM_JUDGE_MODEL, ARM_JUDGE_SCHEMA, buildArmJudgePrompt, parseArmJudgeResponse,
  buildQaWorkflowJudgePrompt, buildQaHealthRubricJudgePrompt, buildQaAntiRefusalJudgePrompt,
  buildCrossSkillConsistencyJudgePrompt, buildVoiceDirectiveJudgePrompt,
  JUDGE_SCORE_SCHEMA, QA_ANTI_REFUSAL_JUDGE_SCHEMA, CROSS_SKILL_CONSISTENCY_JUDGE_SCHEMA,
  VOICE_DIRECTIVE_JUDGE_SCHEMA, VOICE_DIRECTIVE_DIMENSIONS, JUDGE_SCORE_DIMENSIONS, DEFAULT_JUDGE_MAX_TOKENS,
  judgePanelMedian, judgePanelMajority,
} from '../test/helpers/llm-judge';
import { buildWorkflowJudgePrompt, WORKFLOW_JUDGE_RESPONSE_SCHEMA } from '../test/helpers/workflow-judge-input';
import { CLAUDE_FRONTIER_EVAL_MODEL } from '../lib/eval-model';
import type { CalibrationConfig, Verdict } from './judge-calibration';

type Sample = Record<string, unknown>;

/** What production rejects: judgePanelMedian needs finite numbers, judgePanelMajority needs booleans. */
function requireFields(value: unknown, numbers: readonly string[], booleans: readonly string[] = []): void {
  const sample = (value ?? {}) as Sample;
  for (const key of numbers) {
    if (typeof sample[key] !== 'number' || !Number.isFinite(sample[key])) throw new Error(`non-numeric ${key}: ${JSON.stringify(sample[key])}`);
  }
  for (const key of booleans) {
    if (typeof sample[key] !== 'boolean') throw new Error(`non-boolean ${key}: ${JSON.stringify(sample[key])}`);
  }
}

const meets = (median: Record<string, number>, floors: Record<string, number>): Verdict =>
  Object.entries(floors).every(([key, floor]) => median[key]! >= floor) ? 'pass' : 'fail';

const QA_FLOORS = { clarity: 3, completeness: 3, actionability: 4 };
const scoreJudge = (floors: Record<string, number>) => ({
  validate: (value: unknown) => requireFields(value, JUDGE_SCORE_DIMENSIONS),
  verdict: (samples: unknown[]) => meets(judgePanelMedian<string>(samples as Sample[], JUDGE_SCORE_DIMENSIONS), floors),
});

const workflow = (id: string, priority: number, cases: string[], extra: { agentCapability?: 'frontier'; model?: string; floors?: Record<string, number> } = {}): CalibrationConfig => ({
  id, priority, cases,
  model: extra.model ?? CLAUDE_FRONTIER_EVAL_MODEL,
  build: inputs => buildWorkflowJudgePrompt({ judgeContext: inputs.judgeContext!, judgeGoal: inputs.judgeGoal!, agentCapability: extra.agentCapability },
    { files: [], text: inputs.bundle! }),
  oldOptions: { max_tokens: DEFAULT_JUDGE_MAX_TOKENS },
  newOptions: { max_tokens: DEFAULT_JUDGE_MAX_TOKENS, jsonSchema: WORKFLOW_JUDGE_RESPONSE_SCHEMA },
  ...scoreJudge(extra.floors ?? QA_FLOORS),
  estimatedOutputTokens: 1200,
});

export const CALIBRATION_CONFIGS: CalibrationConfig[] = [
  {
    id: 'arm', priority: 1, cases: ['arm-benchmark (skill-e2e-arm-benchmark.test.ts)'], model: ARM_JUDGE_MODEL,
    build: inputs => buildArmJudgePrompt(inputs.task!.trimEnd(), inputs.diff!),
    oldOptions: {},
    newOptions: { jsonSchema: ARM_JUDGE_SCHEMA },
    validate: value => { parseArmJudgeResponse(value); },
    verdict: samples => {
      const scores = samples.map(sample => parseArmJudgeResponse(sample).over_engineering).sort((a, b) => a - b);
      return scores[Math.floor(scores.length / 2)]! <= 1 ? 'pass' : 'fail';
    },
    estimatedOutputTokens: 300,
  },
  {
    id: 'qa-workflow', priority: 2, cases: ['qa/SKILL.md workflow'], model: CLAUDE_FRONTIER_EVAL_MODEL,
    build: inputs => buildQaWorkflowJudgePrompt(inputs.section!),
    oldOptions: {}, newOptions: { jsonSchema: JUDGE_SCORE_SCHEMA },
    ...scoreJudge(QA_FLOORS), estimatedOutputTokens: 1200,
  },
  {
    id: 'qa-health-rubric', priority: 3, cases: ['qa/SKILL.md health rubric'], model: CLAUDE_FRONTIER_EVAL_MODEL,
    build: inputs => buildQaHealthRubricJudgePrompt(inputs.section!),
    oldOptions: {}, newOptions: { jsonSchema: JUDGE_SCORE_SCHEMA },
    ...scoreJudge(QA_FLOORS), estimatedOutputTokens: 1200,
  },
  {
    id: 'qa-anti-refusal', priority: 4, cases: ['qa/SKILL.md anti-refusal'], model: CLAUDE_FRONTIER_EVAL_MODEL,
    build: inputs => buildQaAntiRefusalJudgePrompt(inputs.diffAwareSection!, inputs.rulesSection!),
    oldOptions: {}, newOptions: { jsonSchema: QA_ANTI_REFUSAL_JUDGE_SCHEMA },
    validate: value => requireFields(value, ['confidence'], ['would_browse']),
    verdict: samples => judgePanelMajority<string>(samples as Sample[], 'would_browse')
      && judgePanelMedian<string>(samples as Sample[], ['confidence']).confidence >= 4 ? 'pass' : 'fail',
    estimatedOutputTokens: 1200,
  },
  {
    id: 'cross-skill', priority: 5, cases: ['cross-skill greptile consistency'], model: CLAUDE_FRONTIER_EVAL_MODEL,
    build: inputs => buildCrossSkillConsistencyJudgePrompt(inputs.collected!),
    oldOptions: {}, newOptions: { jsonSchema: CROSS_SKILL_CONSISTENCY_JUDGE_SCHEMA },
    validate: value => requireFields(value, ['score'], ['consistent']),
    verdict: samples => judgePanelMajority<string>(samples as Sample[], 'consistent')
      && judgePanelMedian<string>(samples as Sample[], ['score']).score >= 4 ? 'pass' : 'fail',
    estimatedOutputTokens: 1200,
  },
  {
    id: 'voice', priority: 6, cases: ['voice directive tone'], model: CLAUDE_FRONTIER_EVAL_MODEL,
    build: inputs => buildVoiceDirectiveJudgePrompt(inputs.voiceSection!),
    oldOptions: {}, newOptions: { jsonSchema: VOICE_DIRECTIVE_JUDGE_SCHEMA },
    validate: value => requireFields(value, VOICE_DIRECTIVE_DIMENSIONS),
    verdict: samples => meets(judgePanelMedian<string>(samples as Sample[], VOICE_DIRECTIVE_DIMENSIONS),
      Object.fromEntries(VOICE_DIRECTIVE_DIMENSIONS.map(key => [key, 4]))),
    estimatedOutputTokens: 1200,
  },
  workflow('workflow-default', 7, ['document-release/SKILL.md workflow', 'plan-ceo-review/SKILL.md modes', 'plan-eng-review/SKILL.md sections',
    'plan-design-review/SKILL.md passes', 'design-review/SKILL.md fix loop', 'design-consultation/SKILL.md research',
    'land-and-deploy/SKILL.md workflow', 'canary/SKILL.md monitoring loop', 'benchmark/SKILL.md perf collection',
    'setup-deploy/SKILL.md platform setup', 'sync-gbrain/SKILL.md read-only readiness', 'retro/SKILL.md instructions',
    'qa-only/SKILL.md workflow', 'gstack-upgrade/SKILL.md upgrade flow']),
];
