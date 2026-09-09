import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { designStep0Boundary, hasNativePlanTerminal, nativePlanCallFingerprint, planCountQuestionPhase } from './helpers/claude-pty-runner';
import { isDesignCountFirstReview, isDesignCompletionHandoff, pickDesignCountQuestion } from './helpers/design-count-review';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
import captured from './fixtures/design-handoff-n-calls.json';

const calls = () => structuredClone(captured.calls) as NativePlanQuestionCall[];
const handoff = () => calls().at(-1)!;
const fp = (call: NativePlanQuestionCall) => nativePlanCallFingerprint(call, 0, false);
function pending(call: NativePlanQuestionCall) {
  call.answered = false;
  delete call.answers;
  delete call.unansweredQuestionIndices;
  return call;
}

describe('scored Design completion and required next gate', () => {
  test('the complete native sequence retains all eleven substantive approvals and its separate handoff', () => {
    const input = calls();
    const original = structuredClone(input);
    let started = false;
    const counts = { setup: 0, review: 0, administrative: 0 };
    for (const call of input) {
      const phase = planCountQuestionPhase(fp(call), started, designStep0Boundary,
        isDesignCountFirstReview, undefined, isDesignCompletionHandoff);
      started = phase.reviewStarted;
      if (phase.administrative) counts.administrative++;
      else if (phase.preReview) counts.setup++;
      else counts.review++;
    }
    expect(counts).toEqual({ setup: 0, review: 11, administrative: 1 });
    expect(counts.review).toBeGreaterThan(7);
    expect(input.slice(0, -1).every(call => !isDesignCompletionHandoff(fp(call)))).toBe(true);
    expect(input).toEqual(original);
  });

  test('only the actual manual action is selected, in either offered order', () => {
    for (const reverse of [false, true]) {
      const call = pending(handoff());
      if (reverse) call.questions[0]!.options.reverse();
      expect(pickDesignCountQuestion(fp(call), fp(call))).toBe(reverse ? 1 : 2);
      expect(isDesignCompletionHandoff(fp(call))).toBe(false);
      expect(pickDesignCountQuestion(fp(call), { ...fp(call), signature: 'foreign:call' })).toBeNull();
    }
    const call = pending(handoff());
    call.questions[0]!.options[1] = { label: 'Run /plan-ceo-review first' };
    expect(pickDesignCountQuestion(fp(call), fp(call))).toBeNull();
  });

  test('the retry retains eight real approvals and classifies its required-gate recap separately', () => {
    const input = structuredClone(captured.retry.calls) as NativePlanQuestionCall[];
    expect(input).toHaveLength(9);
    expect(input.slice(0, 8).every(call => !isDesignCompletionHandoff(fp(call)))).toBe(true);
    const call = input.at(-1)!;
    expect(isDesignCompletionHandoff(fp(call))).toBe(true);
    const active = fp(pending(call));
    expect(pickDesignCountQuestion(active, active)).toBe(2);
    call.questions[0]!.question = call.questions[0]!.question.replace('8 implementation tasks ready.', 'Please add a missing contrast test.');
    expect(pickDesignCountQuestion(fp(call), fp(call))).toBeNull();
  });

  test('scores, gate wording or a known identity cannot hide unfinished work or a real choice', () => {
    const mutations: Array<(call: NativePlanQuestionCall) => void> = [
      call => { call.questions[0]!.question = call.questions[0]!.question.replace('complete (', 'complete only after adding contrast ('); },
      call => { call.questions[0]!.question = call.questions[0]!.question.replace('review complete', 'review is not complete'); },
      call => { call.questions[0]!.question = call.questions[0]!.question.replace('9 decisions', 'one unresolved decision'); },
      call => { call.questions[0]!.question = call.questions[0]!.question.replace('The required', 'One contrast gap remains. The required'); },
      call => { call.questions[0]!.question = call.questions[0]!.question.replace('The required next gate is Eng Review', 'The optional next gate is Eng Review'); },
      call => { call.questions[0]!.question = call.questions[0]!.question.replace('run it now?', 'fix the missing contrast test now?'); },
      call => { call.questions[0]!.question = call.questions[0]!.question.replace('plan-design-review-next-step', 'plan-design-review-contrast'); },
      call => { call.questions[0]!.question += ' <gstack-qid:plan-design-review-next-step>'; },
      call => { call.questions[0]!.options[1]!.label = 'Skip — handle manually and add a missing test'; },
      call => { call.questions[0]!.options[1]!.description = 'Please add a missing contrast test before proceeding.'; },
      call => { call.questions[0]!.options[1]!.description = 'Proceed to fix the missing contrast test before the next review.'; },
      call => { call.questions[0]!.options[1]!.description = 'The contrast gap remains unresolved; handle it manually before Eng.'; },
      call => { call.questions[0]!.options.push({ label: 'Add a new typeface TODO' }); },
      call => { call.questions.push(calls()[0]!.questions[0]!); },
      call => { call.questions[0]!.multiSelect = true; },
    ];
    for (const mutate of mutations) {
      const call = handoff();
      mutate(call);
      call.answers = Object.fromEntries(call.questions.map(q => [q.question, q.options[0]!.label]));
      expect(isDesignCompletionHandoff(fp(call))).toBe(false);
      const active = fp(pending(call));
      expect(pickDesignCountQuestion(active, active)).toBeNull();
    }
  });

  test('failed, partial, missing-native and unoffered answers do not exclude a call', () => {
    for (const mutate of [
      (call: NativePlanQuestionCall) => { call.failed = true; },
      (call: NativePlanQuestionCall) => { call.unansweredQuestionIndices = [0]; },
      (call: NativePlanQuestionCall) => { call.answers = {}; },
      (call: NativePlanQuestionCall) => { call.answers = { [call.questions[0]!.question]: 'Build another workflow' }; },
    ]) {
      const call = handoff();
      mutate(call);
      expect(isDesignCompletionHandoff(fp(call))).toBe(false);
    }
    expect(isDesignCompletionHandoff({ ...fp(handoff()), nativeCall: undefined })).toBe(false);
  });

  test('the captured report predates only handoff; absent native Exit still cannot complete', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-scored-handoff-'));
    const file = path.join(dir, 'plan.md');
    try {
      fs.writeFileSync(file, captured.report.content);
      const reportAt = Date.parse(captured.report.successfulUpdateAt) / 1000;
      fs.utimesSync(file, reportAt, reportAt);
      const input = calls();
      const transcript = { status: 'ready' as const, calls: input, assistantMessages: [],
        planReadyRequests: structuredClone(captured.planReadyRequests) };
      const admin = new Set([fp(input.at(-1)!).signature]);
      const start = Date.parse('2026-09-09T01:06:22Z');
      expect(Date.parse(input.at(-2)!.answeredAt!)).toBeLessThan(reportAt * 1000);
      expect(Date.parse(input.at(-1)!.answeredAt!)).toBeGreaterThan(reportAt * 1000);
      expect(hasNativePlanTerminal(transcript, file, start, 'plan_ready', admin)).toBe(false);
      // A controlled later Exit exercises freshness without inventing historical evidence.
      const exit = { sessionId: input[0]!.sessionId, toolUseId: 'controlled-exit',
        timestamp: '2026-09-09T01:19:10Z', failed: false };
      transcript.planReadyRequests.push(exit as never);
      expect(hasNativePlanTerminal(transcript, file, start, 'plan_ready')).toBe(false);
      expect(hasNativePlanTerminal(transcript, file, start, 'plan_ready', admin)).toBe(true);
      exit.failed = true;
      expect(hasNativePlanTerminal(transcript, file, start, 'plan_ready', admin)).toBe(false);
      exit.failed = false;
      const stale = Date.parse(input.at(-2)!.answeredAt!) / 1000 - 1;
      fs.utimesSync(file, stale, stale);
      expect(hasNativePlanTerminal(transcript, file, start, 'plan_ready', admin)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
