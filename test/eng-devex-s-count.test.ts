import { describe, expect, test } from 'bun:test';
import actual from './fixtures/eng-devex-s-first-calls.json';
import retry from './fixtures/eng-devex-s-retry-calls.json';
import { nativePlanCallFingerprint, engFirstReviewAUQ, engStep0Boundary, engSetupAUQ, planCountQuestionPhase } from './helpers/claude-pty-runner';
import { isDevexReviewIssue } from './helpers/devex-count-fixture';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
const fp = (call: NativePlanQuestionCall) => nativePlanCallFingerprint(call, 0, true);
const copy = (call: unknown) => structuredClone(call) as NativePlanQuestionCall;
function changeQuestion(call: NativePlanQuestionCall, transform: (s: string) => string) {
  const q = call.questions[0]!; const answer = call.answers![q.question]!;
  q.question = transform(q.question); call.answers = { [q.question]: answer }; return call;
}

describe('S completed native review accounting', () => {
  test('DX keeps all five real approvals including unnamed package file and CI/TTHW contradiction', () => {
    expect(actual.devex.calls.map(call => isDevexReviewIssue(fp(copy(call))))).toEqual([true, true, true, true, true]);
  });
  test('retry keeps empathy/scope setup and all distinct issues/TODOs', () => {
    expect(retry.devex.calls.map(call => isDevexReviewIssue(fp(copy(call))))).toEqual([false, true, true, true, true, true]);
    let started = false;
    expect(retry.eng.calls.map(call => { const phase = planCountQuestionPhase(fp(copy(call)), started, engStep0Boundary, engFirstReviewAUQ, engSetupAUQ); started = phase.reviewStarted; return phase.preReview; })).toEqual([true, false, false, false, false, false, false]);
  });
  test('Eng scope remains setup; first architecture remedy opens review including the later TODO', () => {
    let started = false;
    const phases = actual.eng.calls.map(call => {
      const phase = planCountQuestionPhase(fp(copy(call)), started, engStep0Boundary, engFirstReviewAUQ, engSetupAUQ);
      started = phase.reviewStarted; return phase.preReview;
    });
    expect(phases).toEqual([true, false, false, false, false, false]);
    expect(engFirstReviewAUQ(fp(copy(actual.eng.calls[0])))).toBe(false);
    expect(engFirstReviewAUQ(fp(copy(actual.eng.calls[1])))).toBe(true);
  });
  for (const [name, original, predicate] of [
    ['DX quickstart', actual.devex.calls[0], isDevexReviewIssue],
    ['DX CI/TTHW', actual.devex.calls[1], isDevexReviewIssue],
    ['Eng architecture', actual.eng.calls[1], engFirstReviewAUQ],
    ['DX retry CI repair', retry.devex.calls[2], isDevexReviewIssue],
  ] as const) {
    test(`${name} requires complete native offered-answer identity`, () => {
      for (const mutate of [
        (c: NativePlanQuestionCall) => { c.failed = true; },
        (c: NativePlanQuestionCall) => { c.answered = false; },
        (c: NativePlanQuestionCall) => { c.unansweredQuestionIndices = [0]; },
        (c: NativePlanQuestionCall) => { delete c.unansweredQuestionIndices; },
        (c: NativePlanQuestionCall) => { c.answers = {}; },
        (c: NativePlanQuestionCall) => { c.answers = { [c.questions[0]!.question]: 'Unrelated answer' }; },
        (c: NativePlanQuestionCall) => { c.questions[0]!.multiSelect = true; },
        (c: NativePlanQuestionCall) => { c.questions.push(copy(original).questions[0]!); },
        (c: NativePlanQuestionCall) => { c.questions[0]!.options.push({ ...c.questions[0]!.options[0]! }); },
      ]) { const c = copy(original); mutate(c); expect(predicate(fp(c))).toBe(false); }
      const duplicateId = changeQuestion(copy(original), s => s + ' <gstack-qid:second>'); expect(predicate(fp(duplicateId))).toBe(false);
      const foreign = fp(copy(original)); foreign.signature = 'foreign:call'; expect(predicate(foreign)).toBe(false);
      const screen = fp(copy(original)); delete screen.nativeCall;
      // The legacy text-only API already recognizes the retry's full CI prose.
      // This change adds no text-only credit; the counter consumes native calls.
      expect(predicate(screen)).toBe(name === 'DX retry CI repair');
    });
    test(`${name} does not convert setup or navigation into an approval`, () => {
      for (const suffix of ['mode', 'setup', 'next-steps', 'scope', 'routing', 'prerequisite']) {
        const c = changeQuestion(copy(original), s => s.replace(/<gstack-qid:[^>]+>/, `<gstack-qid:plan-${name.startsWith('DX') ? 'devex-review' : 'eng-arch'}-${suffix}>`));
        expect(predicate(fp(c))).toBe(false);
      }
      const c = changeQuestion(copy(original), s => name === 'DX retry CI repair'
        ? s.replace(/^.*$/m, 'Which benchmark tier should we use? <gstack-qid:plan-devex-review-tthw-ci-block>')
        : s.replace(/How should [^?]+\?/i, 'Should we begin the review?'));
      expect(predicate(fp(c))).toBe(false);
    });
  }
  test('DX does not count resolved or generic benchmark recaps', () => {
    expect(isDevexReviewIssue(fp(changeQuestion(copy(actual.devex.calls[0]), s => s.replace("doesn't exist", 'already exists'))))).toBe(false);
    expect(isDevexReviewIssue(fp(changeQuestion(copy(actual.devex.calls[0]), s => s.replace('quickstart points to', 'quickstart no longer points to'))))).toBe(false);
    expect(isDevexReviewIssue(fp(changeQuestion(copy(actual.devex.calls[1]), s => s.replace('these are mutually exclusive', 'these are not mutually exclusive'))))).toBe(false);
    expect(isDevexReviewIssue(fp(changeQuestion(copy(actual.devex.calls[1]), s => s.replace('with no skip path', 'with a working skip path'))))).toBe(false);
  });
  test('retry benchmark confirmation or resolved target cannot count as a new repair', () => {
    expect(isDevexReviewIssue(fp(changeQuestion(copy(retry.devex.calls[2]), s => s.replace('target unreachable', 'target reachable'))))).toBe(false);
    const c = copy(retry.devex.calls[2]); c.questions[0]!.options[0]!.label = 'Keep the existing target (Recommended)'; c.answers = { [c.questions[0]!.question]: c.questions[0]!.options[0]!.label };
    expect(isDevexReviewIssue(fp(c))).toBe(false);
  });
  test('Eng requires a concrete asserted defect and a direct repair decision', () => {
    const c = copy(actual.eng.calls[1]); c.questions[0]!.header = 'Scope'; expect(engFirstReviewAUQ(fp(c))).toBe(false);
    expect(engFirstReviewAUQ(fp(changeQuestion(copy(actual.eng.calls[1]), s => s.replace('is a race condition', 'is not a race condition'))))).toBe(false);
    expect(engFirstReviewAUQ(fp(changeQuestion(copy(actual.eng.calls[1]), s => s.replace('Architecture: ', 'Architecture: It is false that '))))).toBe(false);
    expect(engFirstReviewAUQ(fp(changeQuestion(copy(actual.eng.calls[1]), s => s.replace('is a race condition', 'is a design preference'))))).toBe(false);
    expect(engFirstReviewAUQ(fp(changeQuestion(copy(actual.eng.calls[1]), s => s.replace('shared mutable AuthCache via module-level export', 'a mutable RequestRegistry'))))).toBe(true);
  });
});
