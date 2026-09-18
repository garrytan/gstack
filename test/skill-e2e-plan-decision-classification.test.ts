/** Paid calibration of the semantic oracle, independent of PTY/model skill behavior. */
import { afterAll, expect } from 'bun:test';
import { CAPTURE_LONG_MS, JUDGE_MS } from './helpers/eval-budgets';
import { createEvalCollector, describeIfSelected, testIfSelected } from './helpers/e2e-helpers';
import { callJudge } from './helpers/llm-judge';
import { resolveEvalModel } from '../lib/eval-model';
import { evaluatePlanReviewDecisions, validatePlanReviewDecisionResponse, type PlanReviewDecisionJudgment } from './helpers/plan-review-decisions';
import { planDecisionCalibrations } from './fixtures/plan-decision-classification';

const collector = createEvalCollector('e2e');
const CASE_ID = 'plan-decision-classification';
const describeCalibration = (body: () => void) => describeIfSelected('Plan decision semantic calibration', [CASE_ID], body);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
// The helper appends untrusted judgment JSON after its first diagnostic line.
const primaryFailure = (error: unknown) => message(error).split('\n', 1)[0]!;

describeCalibration(() => {
  testIfSelected(CASE_ID, async () => {
    const startedAt = Date.now();
    // Four sequential JUDGE_MS calls fit the existing multi-capture budget;
    // reserve the final 10 seconds for recording before Bun's outer deadline.
    const deadlineAt = startedAt + CAPTURE_LONG_MS - 10_000;
    const transcript: Array<Record<string, unknown>> = [];
    let failure: unknown;
    let failed = false;
    let exitReason = 'validation_failed';
    try {
      for (const calibration of planDecisionCalibrations()) {
        const input = { ...calibration.input, deadlineAt: Math.min(deadlineAt, Date.now() + JUDGE_MS) };
        const trace: Record<string, unknown> = { case: calibration.name, input, cost: 'unavailable', usage: 'unavailable' };
        transcript.push(trace);
        let responseReceived = false;
        let closed = false;
        let raw: unknown;
        let validationError: unknown;
        let result: ReturnType<typeof validatePlanReviewDecisionResponse> | undefined;
        try {
          // Calibration inspects raw judgments against short, readable fixture
          // IDs, including rejected semantics; preserve that native-ID contract.
          result = await evaluatePlanReviewDecisions(input, async (prompt, model, opts) => {
            trace.prompt = prompt;
            try {
              const returned = await callJudge<unknown>(prompt, model, opts);
              if (!closed) { raw = returned; responseReceived = true; trace.response = returned; }
              return returned;
            } catch (error) {
              if (!closed) {
                trace.providerError = message(error);
                exitReason = opts?.signal?.aborted ? 'timeout' : 'harness_error';
              }
              throw error;
            }
          }, { callIds: 'native' });
        } catch (error) {
          trace.validationError = message(error);
          // A missing/failed provider response is never evidence that a
          // negative semantic fixture was correctly rejected.
          if (Date.now() >= input.deadlineAt) exitReason = 'timeout';
          if (!responseReceived || Date.now() >= input.deadlineAt) throw error;
          validationError = error;
        } finally { closed = true; }
        const judgment = raw as PlanReviewDecisionJudgment;
        expect(Array.isArray(judgment?.questions), calibration.name).toBe(true);
        expect(judgment.questions).toHaveLength(Object.keys(calibration.expected).length);
        for (const row of judgment.questions) {
          const expected = calibration.expected[row.toolUseId];
          expect(expected, `${calibration.name}: ${row.toolUseId}`).toBeDefined();
          expect(row.questionIndex).toBe(1);
          expect(row.kind).toBe(expected.kind);
          expect([...row.targetIds].sort()).toEqual([...expected.targetIds].sort());
          expect(row.independentDecisions).toBe(expected.independentDecisions);
        }
        if (calibration.rejection) {
          expect(validationError, calibration.name).toBeInstanceOf(Error);
          expect(primaryFailure(validationError)).toContain(calibration.rejection);
          // Reuse local shape/evidence/coverage validation on the actual
          // returned judgment; a canned provider exception cannot pass this.
          let replayError: unknown;
          try { validatePlanReviewDecisionResponse(input, raw); } catch (error) { replayError = error; }
          expect(replayError).toBeInstanceOf(Error);
          expect(primaryFailure(replayError)).toContain(calibration.rejection);
        } else {
          if (validationError) throw validationError;
          expect(result!.count).toBe(calibration.count);
          expect(result!.coveredTargetIds).toEqual(input.targets.map(target => target.id));
          if (input.kind === 'scope') for (const row of judgment.questions) {
            expect([...row.optionActions].sort((a, b) => a.optionIndex - b.optionIndex).map(option => option.action)).toEqual(['include', 'defer', 'cut', 'hold']);
          }
        }
        trace.passed = true;
      }
    } catch (error) {
      failed = true;
      failure = error;
    }
    try {
      collector?.addTest({ name: CASE_ID, suite: 'e2e-plan-decision-classification', tier: 'e2e', passed: !failed,
        duration_ms: Date.now() - startedAt, cost_usd: 0, model: resolveEvalModel('judge'), transcript,
        exit_reason: failed ? exitReason : 'success', ...(failed ? { error: message(failure) } : {}),
        judge_reasoning: 'callJudge does not expose cost or usage. cost_usd=0 is a schema placeholder, not measured zero spend; the full corpus and returned judgments are in transcript.' });
    } catch (recordError) {
      if (failed) throw new AggregateError([failure, recordError], 'Calibration and recording failed');
      throw recordError;
    }
    if (failed) throw failure;
  }, CAPTURE_LONG_MS);
});

afterAll(async () => { await collector?.finalize(); });
