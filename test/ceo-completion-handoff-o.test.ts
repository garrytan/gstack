import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ceoFirstReviewAUQ, ceoStep0Boundary, hasNativePlanTerminal, nativePlanCallFingerprint, planCountQuestionPhase } from './helpers/claude-pty-runner';
import { isCeoCompletionHandoff, pickCeoCompletionHandoff } from './helpers/ceo-completion-handoff';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
import captured from './fixtures/ceo-completion-handoff-o-call.json';

const calls = () => structuredClone(captured.calls) as NativePlanQuestionCall[];
const handoff = () => calls().at(-1)!;
const fingerprint = (call: NativePlanQuestionCall) => nativePlanCallFingerprint(call, 0, false);
const reanswer = (call: NativePlanQuestionCall) => {
  const question = call.questions[0]!;
  call.answers = { [question.question]: question.options[0]!.label };
  return call;
};

describe('closed CEO navigation with the native review-prefixed identity', () => {
  test('the actual six-call sequence preserves setup and both independent findings', () => {
    const original = calls();
    let started = false;
    const counts = { setup: 0, review: 0, administrative: 0 };
    for (const call of original) {
      const phase = planCountQuestionPhase(fingerprint(call), started, ceoStep0Boundary,
        ceoFirstReviewAUQ, undefined, isCeoCompletionHandoff);
      started = phase.reviewStarted;
      if (phase.administrative) counts.administrative++;
      else if (phase.preReview) counts.setup++;
      else counts.review++;
    }
    expect(counts).toEqual({ setup: 3, review: 2, administrative: 1 });
    expect(original).toEqual(calls());
    expect(original.slice(3, 5).map(call => isCeoCompletionHandoff(fingerprint(call)))).toEqual([false, false]);
  });

  test('the offered manual action needs the matching pending native call in either order', () => {
    for (const reverse of [false, true]) {
      const call = handoff();
      call.answered = false;
      delete call.answers;
      delete call.unansweredQuestionIndices;
      if (reverse) call.questions[0]!.options.reverse();
      expect(pickCeoCompletionHandoff(fingerprint(call))).toBe(reverse ? 1 : 2);
      expect(isCeoCompletionHandoff(fingerprint(call))).toBe(false);
      expect(pickCeoCompletionHandoff({ ...fingerprint(call), signature: 'foreign:call' })).toBeNull();
    }
    expect(pickCeoCompletionHandoff(fingerprint(handoff()))).toBeNull();
  });

  test('closed navigation semantics are shared across the bounded review identity family', () => {
    for (const id of ['ceo-review-next-step', 'ceo-review-next-steps', 'ceo-review-next-review', 'ceo-plan-next-steps']) {
      for (const completion of ['done', 'complete', 'cleared']) {
        const call = handoff();
        call.questions[0]!.question = call.questions[0]!.question
          .replace('ceo-review-next-steps', id).replace('CEO review done.', `CEO review ${completion}.`);
        expect(isCeoCompletionHandoff(fingerprint(reanswer(call)))).toBe(true);
      }
    }
    const sequencing = handoff();
    sequencing.questions[0]!.options[1]!.description = 'Once implementation is finished, run /plan-eng-review. After Eng review is complete, proceed to shipping.';
    expect(isCeoCompletionHandoff(fingerprint(sequencing))).toBe(true);
  });

  test('a completed heading cannot conceal unresolved work or a substantive question', () => {
    for (const text of [
      'CEO review is not done. What\'s next?',
      'CEO review done only after fixing the missing authorization test. What\'s next?',
      'CEO review done. Should we add a missing authorization test before Eng?',
      'CEO review done. We should fix the missing authorization test. What\'s next?',
      'CEO review done. Do you want me to fix the missing authorization test? What\'s next?',
      'CEO review done. One contrast issue remains. What\'s next?',
      'CEO review done. Validation is still pending. What\'s next?',
      'CEO review done. Not all findings are resolved. What\'s next?',
      'CEO review done. One test issue is still open. What\'s next?',
      'CEO review done. There are not 0 unresolved decisions. What\'s next?',
      'CEO review done. If the tests pass, what\'s next?',
      'CEO review done. What\'s next? Once the tests pass, all decisions are resolved.',
      'CEO review done. What\'s next? After the authorization tests pass, the review is complete.',
      'CEO review done. What\'s next? The review is complete when authorization tests pass.',
      'CEO review done. What\'s next? Once the tests pass, all decisions will be resolved.',
      'CEO review done. What\'s next? All findings become resolved after the tests pass.',
      'Example: CEO review done. What\'s next?',
    ]) {
      const call = handoff();
      call.questions[0]!.question = call.questions[0]!.question.replace("CEO review done. What's next?", text);
      expect(isCeoCompletionHandoff(fingerprint(reanswer(call))), text).toBe(false);
      call.answered = false;
      expect(pickCeoCompletionHandoff(fingerprint(call)), text).toBeNull();
    }
    for (const description of [
      'Proceed to fix the missing authorization test before Eng.',
      'The contrast gap remains unresolved; handle it manually.',
      'Please add a new regression test before implementation.',
      'We could add a missing regression test before Eng.',
      'Do you want to add a new test before the next review?',
    ]) {
      const call = handoff();
      call.questions[0]!.options[1]!.description = description;
      expect(isCeoCompletionHandoff(fingerprint(call)), description).toBe(false);
    }
  });

  test('failed, partial, malformed, unrelated or mixed native calls remain substantive', () => {
    for (const mutate of [
      (call: NativePlanQuestionCall) => { call.failed = true; },
      (call: NativePlanQuestionCall) => { call.unansweredQuestionIndices = [0]; },
      (call: NativePlanQuestionCall) => { call.questions[0]!.multiSelect = true; },
      (call: NativePlanQuestionCall) => { call.questions.push(calls()[3]!.questions[0]!); },
      (call: NativePlanQuestionCall) => { call.questions[0]!.header = 'Test gap'; },
      (call: NativePlanQuestionCall) => { call.questions[0]!.question = call.questions[0]!.question.replace('ceo-review-next-steps', 'ceo-review-test-gap'); },
      (call: NativePlanQuestionCall) => { call.questions[0]!.question += ' <gstack-qid'; },
      (call: NativePlanQuestionCall) => { call.questions[0]!.question = call.questions[0]!.question.replace('required shipping gate', 'optional review'); },
      (call: NativePlanQuestionCall) => { call.questions[0]!.options[1]!.label = 'Add a missing receipt assertion'; },
    ]) {
      const call = handoff();
      mutate(call);
      expect(isCeoCompletionHandoff(fingerprint(reanswer(call)))).toBe(false);
    }
    const freeform = handoff();
    freeform.answers![freeform.questions[0]!.question] = 'Please add another test first';
    expect(isCeoCompletionHandoff(fingerprint(freeform))).toBe(false);
  });

  test('actual report edits precede the handoff and retain the strict native Exit and freshness checks', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-closed-navigation-'));
    const report = path.join(dir, 'plan.md');
    try {
      fs.writeFileSync(report, captured.reportContent);
      const reportAt = Date.parse(captured.reportUpdate.at(-1)!.timestamp) / 1000;
      fs.utimesSync(report, reportAt, reportAt);
      const transcript = { status: 'ready' as const, calls: calls(), assistantMessages: [],
        planReadyRequests: structuredClone(captured.planReadyRequests) };
      const administrative = new Set(transcript.calls.filter(call => isCeoCompletionHandoff(fingerprint(call)))
        .map(call => `${call.sessionId}:${call.toolUseId}`));
      const startedAt = Date.parse('2026-09-09T01:46:12Z');
      expect(administrative.size).toBe(1);
      expect(hasNativePlanTerminal(transcript, report, startedAt, 'plan_ready')).toBe(false);
      expect(hasNativePlanTerminal(transcript, report, startedAt, 'plan_ready', administrative)).toBe(true);
      transcript.planReadyRequests[0]!.failed = true;
      expect(hasNativePlanTerminal(transcript, report, startedAt, 'plan_ready', administrative)).toBe(false);
      transcript.planReadyRequests = [];
      expect(hasNativePlanTerminal(transcript, report, startedAt, 'plan_ready', administrative)).toBe(false);
      transcript.planReadyRequests = structuredClone(captured.planReadyRequests);
      transcript.calls.push({ ...structuredClone(transcript.calls[3]!), toolUseId: 'new-real-finding',
        answeredAt: transcript.calls.at(-1)!.answeredAt });
      expect(hasNativePlanTerminal(transcript, report, startedAt, 'plan_ready', administrative)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
