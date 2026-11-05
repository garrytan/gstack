/**
 * W2 calibration request configurations, keyed by distinct request (prompt
 * builder, model, max_tokens, stream, effort, thresholds), not by test case.
 * Each config builds prompts through the same builder the eval sends; "old" is
 * today's request and "new" adds only the JSON schema (comparison 1).
 */
import {
  ARM_JUDGE_MODEL, ARM_JUDGE_SCHEMA, buildArmJudgePrompt, parseArmJudgeResponse,
  buildQaAntiRefusalJudgePrompt, buildCrossSkillConsistencyJudgePrompt, buildVoiceDirectiveJudgePrompt,
  QA_ANTI_REFUSAL_JUDGE_SCHEMA, CROSS_SKILL_CONSISTENCY_JUDGE_SCHEMA,
  VOICE_DIRECTIVE_JUDGE_SCHEMA, VOICE_DIRECTIVE_DIMENSIONS,
  judgePanelMedian, judgePanelMajority,
} from '../test/helpers/llm-judge';
import { CLAUDE_JUDGE_EVAL_MODEL } from '../lib/eval-model';
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
    id: 'qa-anti-refusal', priority: 4, cases: ['qa/SKILL.md anti-refusal'], model: CLAUDE_JUDGE_EVAL_MODEL,
    build: inputs => buildQaAntiRefusalJudgePrompt(inputs.diffAwareSection!, inputs.rulesSection!),
    oldOptions: {}, newOptions: { jsonSchema: QA_ANTI_REFUSAL_JUDGE_SCHEMA },
    validate: value => requireFields(value, ['confidence'], ['would_browse']),
    verdict: samples => judgePanelMajority<string>(samples as Sample[], 'would_browse')
      && judgePanelMedian<string>(samples as Sample[], ['confidence']).confidence >= 4 ? 'pass' : 'fail',
    estimatedOutputTokens: 1200,
  },
  {
    id: 'cross-skill', priority: 5, cases: ['cross-skill greptile consistency'], model: CLAUDE_JUDGE_EVAL_MODEL,
    build: inputs => buildCrossSkillConsistencyJudgePrompt(inputs.collected!),
    oldOptions: {}, newOptions: { jsonSchema: CROSS_SKILL_CONSISTENCY_JUDGE_SCHEMA },
    validate: value => requireFields(value, ['score'], ['consistent']),
    verdict: samples => judgePanelMajority<string>(samples as Sample[], 'consistent')
      && judgePanelMedian<string>(samples as Sample[], ['score']).score >= 4 ? 'pass' : 'fail',
    estimatedOutputTokens: 1200,
  },
  {
    id: 'voice', priority: 6, cases: ['voice directive tone'], model: CLAUDE_JUDGE_EVAL_MODEL,
    build: inputs => buildVoiceDirectiveJudgePrompt(inputs.voiceSection!),
    oldOptions: {}, newOptions: { jsonSchema: VOICE_DIRECTIVE_JUDGE_SCHEMA },
    validate: value => requireFields(value, VOICE_DIRECTIVE_DIMENSIONS),
    verdict: samples => meets(judgePanelMedian<string>(samples as Sample[], VOICE_DIRECTIVE_DIMENSIONS),
      Object.fromEntries(VOICE_DIRECTIVE_DIMENSIONS.map(key => [key, 4]))),
    estimatedOutputTokens: 1200,
  },
];
