/**
 * W2 calibration request configurations, keyed by distinct request (prompt
 * builder, model, max_tokens, stream, effort, thresholds), not by test case.
 * Each config builds prompts through the same builder the eval sends; "old" is
 * today's request and "new" adds only the JSON schema (comparison 1).
 */
import { ARM_JUDGE_MODEL, ARM_JUDGE_SCHEMA, buildArmJudgePrompt, parseArmJudgeResponse } from '../test/helpers/llm-judge';
import type { CalibrationConfig } from './judge-calibration';

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
];
