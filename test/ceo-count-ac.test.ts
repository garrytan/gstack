import { expect, test } from 'bun:test';
import captured from './fixtures/ceo-count-ac-calls.json';
import later from './fixtures/ceo-count-ac-later-calls.json';
import { ceoFirstReviewAUQ, ceoStep0Boundary, nativePlanCallFingerprint, planCountQuestionPhase } from './helpers/claude-pty-runner';
import { isCeoCompletionHandoff, pickCeoCompletionHandoff } from './helpers/ceo-completion-handoff';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';

const calls = () => structuredClone(captured.calls) as NativePlanQuestionCall[];
const fp = (c: NativePlanQuestionCall) => nativePlanCallFingerprint(c, 0, true);
const finding = () => calls()[2]!;
const handoff = () => calls()[3]!;
function reanswer(c: NativePlanQuestionCall) {
  c.answers = { [c.questions[0]!.question]: c.questions[0]!.options[0]!.label };
  return c;
}
function pending(c = handoff()) {
  c.answered = false; delete c.answers; delete c.answeredAt;
  c.unansweredQuestionIndices = [0]; return c;
}

test('the actual paired attempt has one finding and remains below its two-finding floor', () => {
  let started = false;
  const counts = { setup: 0, review: 0, administrative: 0 };
  for (const c of calls()) {
    const phase = planCountQuestionPhase(fp(c), started, ceoStep0Boundary, ceoFirstReviewAUQ,
      undefined, isCeoCompletionHandoff);
    started = phase.reviewStarted;
    counts[phase.administrative ? 'administrative' : phase.preReview ? 'setup' : 'review']++;
  }
  expect(counts).toEqual({ setup: 2, review: 1, administrative: 1 });
  expect(counts.review).toBeLessThan(2);
  expect(calls()[1]!.answers).toEqual(captured.calls[1]!.answers);
});

test('qidless explicit Findings need a completed matching native decision', () => {
  expect(ceoFirstReviewAUQ(fp(finding()))).toBe(true);
  for (const mutate of [
    (c: NativePlanQuestionCall) => { c.answered = false; },
    (c: NativePlanQuestionCall) => { c.failed = true; },
    (c: NativePlanQuestionCall) => { c.answers = {}; },
    (c: NativePlanQuestionCall) => { c.unansweredQuestionIndices = [0]; },
    (c: NativePlanQuestionCall) => { c.answers = { [c.questions[0]!.question]: 'unoffered answer' }; },
    (c: NativePlanQuestionCall) => { c.questions.push(structuredClone(c.questions[0]!)); },
  ]) {
    const c = finding(); mutate(c); expect(ceoFirstReviewAUQ(fp(c))).toBe(false);
  }
  expect(ceoFirstReviewAUQ({ ...fp(finding()), signature: 'foreign:call' })).toBe(false);
  expect(ceoFirstReviewAUQ({ ...fp(finding()), nativeCall: undefined })).toBe(false);
  expect(ceoFirstReviewAUQ({ ...fp(finding()), options: [] })).toBe(false);
});

test('setup recaps, quoted titles and foreign qids cannot start a review', () => {
  for (const prefix of ['Example: ', '> ', '"', '```\n']) {
    const c = finding(); c.questions[0]!.question = prefix + c.questions[0]!.question;
    expect(ceoFirstReviewAUQ(fp(reanswer(c)))).toBe(false);
  }
  for (const header of ['Approach', 'Mode', 'Next review', 'Setup']) {
    const c = finding(); c.questions[0]!.header = header;
    expect(ceoFirstReviewAUQ(fp(c))).toBe(false);
  }
  for (const id of ['plan-eng-review-finding', 'plan-ceo-review-mode', 'broken']) {
    const c = finding(); c.questions[0]!.question += ` <gstack-qid:${id}>`;
    expect(ceoFirstReviewAUQ(fp(reanswer(c)))).toBe(false);
  }
  expect(ceoFirstReviewAUQ(fp(calls()[1]!))).toBe(false);
  expect(ceoFirstReviewAUQ(fp(handoff()))).toBe(false);
});

test('the exact administrative menu chooses manual without awarding completion coverage', () => {
  expect(isCeoCompletionHandoff(fp(handoff()))).toBe(true);
  expect(pickCeoCompletionHandoff(fp(pending()))).toBe(2);
  const c = pending(); c.questions[0]!.options.reverse();
  expect(pickCeoCompletionHandoff(fp(c))).toBe(1);
  expect(isCeoCompletionHandoff(fp(c))).toBe(false);
  expect(pickCeoCompletionHandoff(fp(handoff()))).toBeNull();
});

test('appended obligations and altered navigation context remain substantive', () => {
  for (const extra of [' Also add another test.', ' Fix the missing auth check.',
    ' Once the outstanding gap is resolved.', ' Decide whether to add retry support?',
    ' The CEO review is not complete.']) {
    for (const target of ['question', 'run', 'manual']) {
      const c = handoff(), q = c.questions[0]!;
      if (target === 'question') q.question += extra;
      else q.options[target === 'run' ? 0 : 1]!.description += extra;
      expect(isCeoCompletionHandoff(fp(reanswer(c)))).toBe(false);
      expect(pickCeoCompletionHandoff(fp(pending(c)))).toBeNull();
    }
  }
  for (const mutate of [
    (c: NativePlanQuestionCall) => { c.failed = true; },
    (c: NativePlanQuestionCall) => { c.questions[0]!.multiSelect = true; },
    (c: NativePlanQuestionCall) => { c.questions.push(structuredClone(c.questions[0]!)); },
    (c: NativePlanQuestionCall) => { c.questions[0]!.question = c.questions[0]!.question.replace('complete and clean', 'not complete'); },
    (c: NativePlanQuestionCall) => { c.questions[0]!.options[1]!.label = 'Add another test'; },
  ]) { const c = handoff(); mutate(c); expect(isCeoCompletionHandoff(fp(reanswer(c)))).toBe(false); }
  expect(pickCeoCompletionHandoff({ ...fp(pending()), signature: 'foreign:call' })).toBeNull();
  expect(pickCeoCompletionHandoff({ ...fp(pending()), options: [] })).toBeNull();
});

test('the paired transcript regression remains selected from both new files', () => {
  for (const file of ['test/ceo-count-ac.test.ts', 'test/fixtures/ceo-count-ac-calls.json']) {
    expect(selectTests([file], E2E_TOUCHFILES).selected).toContain('plan-ceo-finding-count');
  }
});


test('later actual calls count explicit Issue and sectioned Finding titles without crediting a terminal', () => {
  for (const [key, expected] of [['distinct', { setup: 4, review: 5 }], ['pairedRetry', { setup: 4, review: 4 }]] as const) {
    let started = false;
    const count = { setup: 0, review: 0 };
    for (const c of structuredClone(later[key].nativeCalls) as NativePlanQuestionCall[]) {
      const phase = planCountQuestionPhase(fp(c), started, ceoStep0Boundary, ceoFirstReviewAUQ);
      started = phase.reviewStarted;
      count[phase.preReview ? 'setup' : 'review']++;
    }
    expect(count).toEqual(expected);
  }
  // These attempts were stalled on file permission; count correction supplies
  // no terminal, written report or complete methodology evidence.
  expect(later.distinct.observedOutcome).toBe('timeout');
  expect(later.pairedRetry.observedOutcome).toBe('running');
});

test('numbered Issue/sectioned Finding titles must agree with their native header', () => {
  for (const source of [later.distinct.nativeCalls[4]!, later.pairedRetry.nativeCalls[4]!]) {
    const c = structuredClone(source) as NativePlanQuestionCall;
    expect(ceoFirstReviewAUQ(fp(c))).toBe(true);
    for (const header of ['Issue 7.2', 'Finding 9', 'Mode', 'Next review']) {
      c.questions[0]!.header = header;
      expect(ceoFirstReviewAUQ(fp(c))).toBe(false);
    }
  }
  expect(selectTests(['test/fixtures/ceo-count-ac-later-calls.json'], E2E_TOUCHFILES).selected).toContain('plan-ceo-finding-count');
});
