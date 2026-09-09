import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { capturePlanCountQuestion, ceoFirstReviewAUQ, ceoStep0Boundary, hasNativePlanTerminal,
  nativePlanCallFingerprint, planCountQuestionPhase } from './helpers/claude-pty-runner';
import { isCeoCompletionHandoff, pickCeoCompletionHandoff } from './helpers/ceo-completion-handoff';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
import captured from './fixtures/ceo-completion-handoff-m-call.json';
import nextStepCapture from './fixtures/ceo-handoff-n-calls.json';

const calls = () => structuredClone(captured.calls) as NativePlanQuestionCall[];
const handoff = () => calls().at(-1)!;
const fingerprint = (call: NativePlanQuestionCall) => nativePlanCallFingerprint(call, 0, false);

function reanswer(call: NativePlanQuestionCall) {
  call.answers = { [call.questions[0]!.question]: call.questions[0]!.options[0]!.label };
  return call;
}

describe('CEO completion described by a native navigation choice', () => {
  test('the exact seven-call session preserves three setup and three finding decisions', () => {
    let reviewStarted = false;
    const counts = { setup: 0, review: 0, administrative: 0 };
    const original = calls();
    for (const call of original) {
      const phase = planCountQuestionPhase(fingerprint(call), reviewStarted, ceoStep0Boundary,
        ceoFirstReviewAUQ, undefined, isCeoCompletionHandoff);
      reviewStarted = phase.reviewStarted;
      if (phase.administrative) counts.administrative++;
      else if (phase.preReview) counts.setup++;
      else counts.review++;
    }
    expect(counts).toEqual({ setup: 3, review: 3, administrative: 1 });
    expect(original).toEqual(calls());
    expect(original.slice(3, -1).map(call => isCeoCompletionHandoff(fingerprint(call)))).toEqual([false, false, false]);
  });

  test('the active pending handoff selects the actual manual option in either order', () => {
    for (const reverse of [false, true]) {
      const call = handoff();
      call.answered = false;
      delete call.answers;
      delete call.unansweredQuestionIndices;
      const q = call.questions[0]!;
      if (reverse) q.options.reverse();
      const screen = `☐ ${q.header}\n${q.question}\n❯ 1. ${q.options[0]!.label}\n  2. ${q.options[1]!.label}\nEnter to select · ↑/↓ to navigate · Esc to cancel`;
      const active = capturePlanCountQuestion(screen, new Set(), 0, false, call)!;
      expect(active.nativeCall?.toolUseId).toBe(call.toolUseId);
      expect(pickCeoCompletionHandoff(fingerprint(call), active)).toBe(reverse ? 1 : 2);
      expect(isCeoCompletionHandoff(active)).toBe(false);
      expect(pickCeoCompletionHandoff(capturePlanCountQuestion(screen, new Set(), 0, false)!)).toBeNull();
      expect(pickCeoCompletionHandoff(fingerprint(call), { ...active, signature: 'another:call' })).toBeNull();
    }
  });

  test('completion placement is independent of the next-step wording and option order', () => {
    const call = handoff();
    const q = call.questions[0]!;
    q.question = 'D9 — Next steps: The review is done. Where should we go next? <gstack-qid:plan-ceo-review-next-step>';
    q.header = 'Next review';
    q.options[0]!.description = 'Eng review is the required shipping gate.';
    for (const description of [
      'CEO review found 3 specification gaps (all resolved). Continue manually.',
      'The CEO review identified gaps; all findings are resolved. Continue manually.',
      'CEO review is complete with 0 unresolved decisions. Continue manually.',
    ]) {
      q.options[1]!.description = description;
      expect(isCeoCompletionHandoff(fingerprint(reanswer(call)))).toBe(true);
    }
  });

  test('conditional, unfinished, quoted and non-CEO recaps cannot supply completion', () => {
    for (const description of [
      'Eng review is the required shipping gate. CEO review found 3 gaps (all resolved after adding tests).',
      'Eng review is the required shipping gate. If CEO review found 3 gaps (all resolved), continue.',
      'Eng review is the required shipping gate. CEO review found 3 gaps (all resolved); one gap remains.',
      'Eng review is the required shipping gate. CEO review found 3 gaps (all resolved). There is an unresolved test issue.',
      'Eng review is the required shipping gate. The document says "CEO review found 3 gaps (all resolved)."',
      'Eng review is the required shipping gate. Design review found 3 gaps (all resolved).',
      'Eng review is the required shipping gate. CEO review found 3 gaps.',
      'Eng review is the required shipping gate. CEO review found 3 specification gaps (not all resolved).',
      'Eng review is the required shipping gate. CEO review did not find all gaps resolved.',
      'Eng review is the required shipping gate. CEO review found 3 gaps (all resolved). Also add a new test before proceeding.',
      'Eng review is the required shipping gate. CEO review found 3 gaps (all resolved). Please fix the new missing authorization check before proceeding.',
    ]) {
      const call = handoff();
      call.questions[0]!.options[0]!.description = description;
      expect(isCeoCompletionHandoff(fingerprint(call)), description).toBe(false);
      call.answered = false;
      expect(pickCeoCompletionHandoff(fingerprint(call))).toBeNull();
    }
  });

  test('native identity, completion, required gate and exclusively administrative choices remain necessary', () => {
    for (const mutate of [
      (call: NativePlanQuestionCall) => { call.questions[0]!.question = 'Review complete only after fixing tests. What next? <gstack-qid:plan-ceo-review-next-step>'; },
      (call: NativePlanQuestionCall) => { call.questions[0]!.question = 'Should we finish reviewing? <gstack-qid:plan-ceo-review-next-step>'; },
      (call: NativePlanQuestionCall) => { call.questions[0]!.question += ' <gstack-qid:plan-ceo-security-issue>'; },
      (call: NativePlanQuestionCall) => { call.questions[0]!.question = '<gstack-qid broken> ' + call.questions[0]!.question; },
      (call: NativePlanQuestionCall) => { call.questions[0]!.header = 'TODO decision'; },
      (call: NativePlanQuestionCall) => { call.questions[0]!.options[1]!.label = 'Add another TODO'; },
      (call: NativePlanQuestionCall) => { call.questions[0]!.options[0]!.label += ' and fix the missing test'; },
      (call: NativePlanQuestionCall) => { for (const option of call.questions[0]!.options) option.description = option.description?.replaceAll('required', 'optional'); },
      (call: NativePlanQuestionCall) => { call.questions.push(calls()[3]!.questions[0]!); },
      (call: NativePlanQuestionCall) => { call.questions[0]!.multiSelect = true; },
      (call: NativePlanQuestionCall) => { call.failed = true; },
      (call: NativePlanQuestionCall) => { call.unansweredQuestionIndices = [0]; },
      (call: NativePlanQuestionCall) => { call.answered = false; },
    ]) {
      const call = handoff();
      mutate(call);
      expect(isCeoCompletionHandoff(fingerprint(reanswer(call)))).toBe(false);
    }
    const addedWork = handoff();
    addedWork.answers = { [addedWork.questions[0]!.question]: 'First add another payment test' };
    expect(isCeoCompletionHandoff(fingerprint(addedWork))).toBe(false);
  });

  test('the actual report and Exit order permits only the administrative freshness exception', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-native-handoff-'));
    const report = path.join(dir, 'plan.md');
    try {
      fs.writeFileSync(report, captured.report.content);
      const reportAt = Date.parse(captured.report.successfulResult.timestamp) / 1000;
      fs.utimesSync(report, reportAt, reportAt);
      const transcript = { status: 'ready' as const, calls: calls(), assistantMessages: [],
        planReadyRequests: structuredClone(captured.planReadyRequests) };
      const administrative = new Set(transcript.calls.filter(call => isCeoCompletionHandoff(fingerprint(call)))
        .map(call => `${call.sessionId}:${call.toolUseId}`));
      const startedAt = Date.parse('2026-09-09T00:15:27Z');
      expect(administrative.size).toBe(1);
      expect(hasNativePlanTerminal(transcript, report, startedAt, 'plan_ready')).toBe(false);
      expect(hasNativePlanTerminal(transcript, report, startedAt, 'plan_ready', administrative)).toBe(true);
      transcript.planReadyRequests[0]!.failed = true;
      expect(hasNativePlanTerminal(transcript, report, startedAt, 'plan_ready', administrative)).toBe(false);
      transcript.planReadyRequests[0]!.failed = false;
      transcript.calls.push({ ...structuredClone(transcript.calls[3]!), toolUseId: 'new-test-obligation',
        answeredAt: captured.calls.at(-1)!.answeredAt });
      expect(hasNativePlanTerminal(transcript, report, startedAt, 'plan_ready', administrative)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('native next-review navigation with a resolved CEO recap', () => {
  const retryCalls = () => structuredClone(captured.distinctRetry.calls) as NativePlanQuestionCall[];
  const retryHandoff = () => retryCalls().at(-1)!;

  test('the captured retry preserves its four actual findings and the unchanged mechanical band', () => {
    let started = false;
    const counts = { setup: 0, review: 0, administrative: 0 };
    const original = retryCalls();
    for (const call of original) {
      const phase = planCountQuestionPhase(fingerprint(call), started, ceoStep0Boundary,
        ceoFirstReviewAUQ, undefined, isCeoCompletionHandoff);
      started = phase.reviewStarted;
      if (phase.administrative) counts.administrative++;
      else if (phase.preReview) counts.setup++;
      else counts.review++;
    }
    expect(counts).toEqual({ setup: 4, review: 4, administrative: 1 });
    expect(original).toEqual(retryCalls());
    // The transcript contains four individual findings. The unasked dispatcher
    // remedy remains a separate workflow-quality limitation, never a fifth call.
    expect(original.slice(4, -1).every(call => !isCeoCompletionHandoff(fingerprint(call)))).toBe(true);
  });

  test('actual offered manual navigation still requires the matching pending native question', () => {
    for (const reverse of [false, true]) {
      const call = retryHandoff();
      call.answered = false;
      delete call.answers;
      const q = call.questions[0]!;
      if (reverse) q.options.reverse();
      const screen = `☐ ${q.header}\n${q.question}\n❯ 1. ${q.options[0]!.label}\n  2. ${q.options[1]!.label}\nEnter to select · ↑/↓ to navigate · Esc to cancel`;
      const active = capturePlanCountQuestion(screen, new Set(), 0, false, call)!;
      expect(active.nativeCall?.toolUseId).toBe(call.toolUseId);
      expect(pickCeoCompletionHandoff(fingerprint(call), active)).toBe(reverse ? 1 : 2);
      expect(isCeoCompletionHandoff(active)).toBe(false);
      expect(pickCeoCompletionHandoff(capturePlanCountQuestion(screen, new Set(), 0, false)!)).toBeNull();
    }
  });

  test('partial, conditional, quoted or still-open recaps never establish this navigation boundary', () => {
    for (const recap of [
      'This CEO review resolved some security bugs.',
      'This CEO review resolved most security bugs.',
      'This CEO review resolved all but one security bugs.',
      'This CEO review resolved two of three security bugs.',
      'This CEO review only resolved the security bugs.',
      'This CEO review did not resolve the security bugs.',
      'If this CEO review resolved the security bugs, continue.',
      'The document says "This CEO review resolved the security bugs."',
      'This CEO review resolved the security bugs. One issue remains unresolved.',
      'This CEO review resolved the security bugs; validation of that remedy is still pending.',
      'This CEO review resolved the security bugs. Please add a new test first.',
      'This CEO review will resolve the security bugs.',
    ]) {
      const call = retryHandoff();
      call.questions[0]!.options[0]!.description = 'Eng review is the required shipping gate. ' + recap;
      expect(isCeoCompletionHandoff(fingerprint(call)), recap).toBe(false);
      call.answered = false;
      expect(pickCeoCompletionHandoff(fingerprint(call))).toBeNull();
    }
    for (const question of [
      'Should we add a missing authorization test as the next step after this CEO review?',
      'The CEO review did not finish. What is the next step after this CEO review?',
      'Can you first fix the missing authorization check as the next step after this CEO review?',
      'If the CEO review finishes, what is the next step after this CEO review?',
      'Example: What is the next step after this CEO review?',
    ]) {
      const call = retryHandoff();
      call.questions[0]!.question = question + ' <gstack-qid:plan-ceo-next-step>';
      reanswer(call);
      expect(isCeoCompletionHandoff(fingerprint(call)), question).toBe(false);
      call.answered = false;
      expect(pickCeoCompletionHandoff(fingerprint(call)), question).toBeNull();
    }
    for (const mutate of [
      (call: NativePlanQuestionCall) => { call.questions[0]!.question = 'Choose a fix for the missing test <gstack-qid:plan-ceo-next-step>'; },
      (call: NativePlanQuestionCall) => { call.questions[0]!.question = call.questions[0]!.question.replace('plan-ceo-next-step', 'plan-ceo-test-gap'); },
      (call: NativePlanQuestionCall) => { call.questions[0]!.question = call.questions[0]!.question.replace(/ <gstack-qid:[^>]+>/, ''); },
      (call: NativePlanQuestionCall) => { call.questions[0]!.header = 'TODO'; },
      (call: NativePlanQuestionCall) => { call.questions[0]!.options[1]!.label = 'Add a missing receipt assertion'; },
      (call: NativePlanQuestionCall) => { call.questions.push(retryCalls()[4]!.questions[0]!); },
      (call: NativePlanQuestionCall) => { call.failed = true; },
      (call: NativePlanQuestionCall) => { call.unansweredQuestionIndices = [0]; },
    ]) {
      const call = retryHandoff();
      mutate(call);
      expect(isCeoCompletionHandoff(fingerprint(reanswer(call)))).toBe(false);
    }
  });

  test('the final native report edit precedes handoff and still covers every real answer', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-retry-handoff-'));
    const report = path.join(dir, 'plan.md');
    try {
      fs.writeFileSync(report, captured.distinctRetry.reportContent);
      const reportAt = Date.parse(captured.distinctRetry.reportUpdate.at(-1)!.timestamp) / 1000;
      fs.utimesSync(report, reportAt, reportAt);
      const transcript = { status: 'ready' as const, calls: retryCalls(), assistantMessages: [],
        planReadyRequests: structuredClone(captured.distinctRetry.planReadyRequests) };
      const administrative = new Set(transcript.calls.filter(call => isCeoCompletionHandoff(fingerprint(call)))
        .map(call => `${call.sessionId}:${call.toolUseId}`));
      const startedAt = Date.parse('2026-09-09T00:23:30Z');
      expect(administrative.size).toBe(1);
      expect(hasNativePlanTerminal(transcript, report, startedAt, 'plan_ready')).toBe(false);
      expect(hasNativePlanTerminal(transcript, report, startedAt, 'plan_ready', administrative)).toBe(true);
      transcript.planReadyRequests[0]!.failed = true;
      expect(hasNativePlanTerminal(transcript, report, startedAt, 'plan_ready', administrative)).toBe(false);
      transcript.planReadyRequests[0]!.failed = false;
      transcript.calls.push({ ...structuredClone(transcript.calls[4]!), toolUseId: 'new-independent-finding',
        answeredAt: transcript.calls.at(-1)!.answeredAt });
      expect(hasNativePlanTerminal(transcript, report, startedAt, 'plan_ready', administrative)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('CEO completed next-step identity in native option order', () => {
  const input = () => structuredClone(nextStepCapture.calls) as NativePlanQuestionCall[];
  const actual = () => input().at(-1)!;

  test('the complete native sequence retains two setup and four real issue decisions', () => {
    let started = false;
    const counts = { setup: 0, review: 0, administrative: 0 };
    const native = input();
    const original = structuredClone(native);
    for (const call of native) {
      const phase = planCountQuestionPhase(fingerprint(call), started, ceoStep0Boundary,
        ceoFirstReviewAUQ, undefined, isCeoCompletionHandoff);
      started = phase.reviewStarted;
      if (phase.administrative) counts.administrative++;
      else if (phase.preReview) counts.setup++;
      else counts.review++;
    }
    expect(counts).toEqual({ setup: 2, review: 4, administrative: 1 });
    expect(native).toEqual(original);
  });

  test('only the positively bound pending menu selects its offered manual action', () => {
    for (const reverse of [false, true]) {
      const call = actual();
      call.answered = false;
      delete call.answers;
      delete call.unansweredQuestionIndices;
      if (reverse) call.questions[0]!.options.reverse();
      expect(pickCeoCompletionHandoff(fingerprint(call))).toBe(reverse ? 1 : 2);
      expect(isCeoCompletionHandoff(fingerprint(call))).toBe(false);
      expect(pickCeoCompletionHandoff({ ...fingerprint(call), signature: 'other:call' })).toBeNull();
    }
  });

  test('the observed identity cannot excuse unfinished work, a finding or a malformed native call', () => {
    for (const mutate of [
      (call: NativePlanQuestionCall) => { call.questions[0]!.question = call.questions[0]!.question.replace('complete.', 'complete only after fixing authorization.'); },
      (call: NativePlanQuestionCall) => { call.questions[0]!.question = call.questions[0]!.question.replace('complete.', 'complete. One issue remains unresolved.'); },
      (call: NativePlanQuestionCall) => { call.questions[0]!.question = call.questions[0]!.question.replace('complete.', 'complete. Please fix the missing authorization test.'); },
      (call: NativePlanQuestionCall) => { call.questions[0]!.question = call.questions[0]!.question.replace('What next?', 'Should we add a missing authorization test before the next review?'); },
      (call: NativePlanQuestionCall) => { call.questions[0]!.question = call.questions[0]!.question.replace('What next?', 'We should fix the missing authorization test before the next review.'); },
      (call: NativePlanQuestionCall) => { call.questions[0]!.question = call.questions[0]!.question.replace('What next?', 'We should fix the missing authorization test. What next?'); },
      (call: NativePlanQuestionCall) => { call.questions[0]!.question = call.questions[0]!.question.replace('required shipping gate', 'optional review'); },
      (call: NativePlanQuestionCall) => { call.questions[0]!.question = call.questions[0]!.question.replace('ceo-plan-next-steps', 'ceo-plan-test-gap'); },
      (call: NativePlanQuestionCall) => { call.questions[0]!.question += ' <gstack-qid:ceo-plan-next-steps>'; },
      (call: NativePlanQuestionCall) => { call.questions[0]!.header = 'TODO'; },
      (call: NativePlanQuestionCall) => { call.questions[0]!.options[1]!.description = 'Proceed to fix the missing authorization test before Eng review.'; },
      (call: NativePlanQuestionCall) => { call.questions[0]!.options[0]!.label += ' and add a missing test'; },
      (call: NativePlanQuestionCall) => { call.questions.push(input()[2]!.questions[0]!); },
      (call: NativePlanQuestionCall) => { call.questions[0]!.multiSelect = true; },
    ]) {
      const call = actual();
      mutate(call);
      call.answers = Object.fromEntries(call.questions.map(q => [q.question, q.options[0]!.label]));
      expect(isCeoCompletionHandoff(fingerprint(call))).toBe(false);
      call.answered = false;
      expect(pickCeoCompletionHandoff(fingerprint(call))).toBeNull();
    }
    for (const mutate of [
      (call: NativePlanQuestionCall) => { call.failed = true; },
      (call: NativePlanQuestionCall) => { call.unansweredQuestionIndices = [0]; },
      (call: NativePlanQuestionCall) => { call.answers = {}; },
      (call: NativePlanQuestionCall) => { call.answers = { [call.questions[0]!.question]: 'Build another feature' }; },
    ]) {
      const call = actual();
      mutate(call);
      expect(isCeoCompletionHandoff(fingerprint(call))).toBe(false);
    }
  });

  test('the actual report precedes handoff but the captured absent Exit remains incomplete', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-native-next-step-'));
    const report = path.join(dir, 'plan.md');
    try {
      fs.writeFileSync(report, nextStepCapture.report.content);
      const written = Date.parse(nextStepCapture.report.successfulUpdateAt) / 1000;
      fs.utimesSync(report, written, written);
      const calls = input();
      expect(Date.parse(calls.at(-2)!.answeredAt!)).toBeLessThan(written * 1000);
      expect(Date.parse(calls.at(-1)!.answeredAt!)).toBeGreaterThan(written * 1000);
      const transcript = { status: 'ready' as const, calls, assistantMessages: [],
        planReadyRequests: structuredClone(nextStepCapture.planReadyRequests) };
      const admin = new Set([fingerprint(calls.at(-1)!).signature]);
      expect(hasNativePlanTerminal(transcript, report, Date.parse('2026-09-09T01:06:22Z'), 'plan_ready', admin)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
