import { describe, expect, test } from 'bun:test';
import captured from './fixtures/eng-scope-y-calls.json';
import { engFirstReviewAUQ, engSetupAUQ, engStep0Boundary, nativePlanCallFingerprint, planCountQuestionPhase } from './helpers/claude-pty-runner';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';

const fresh = () => structuredClone(captured[1]!) as NativePlanQuestionCall;
const fp = (c: NativePlanQuestionCall) => nativePlanCallFingerprint(c, 0, false);
const setup = (c: NativePlanQuestionCall) => engSetupAUQ(fp(c));
function question(c: NativePlanQuestionCall, transform: (s: string) => string) {
  const q = c.questions[0]!; const answer = c.answers![q.question]!;
  q.question = transform(q.question); c.answers = {[q.question]: answer}; return c;
}

describe('Y whole-plan complexity setup decision', () => {
  test('the actual accepted-complexity decision remains setup after the review boundary', () => {
    expect(setup(fresh())).toBe(true);
    expect(planCountQuestionPhase(fp(fresh()), true, engStep0Boundary, engFirstReviewAUQ, engSetupAUQ))
      .toEqual({preReview: true, reviewStarted: true});
  });

  test('all seven substantive approvals and TODO obligations stay counted', () => {
    let started = false;
    const phases = captured.map(c => {
      const call = structuredClone(c) as NativePlanQuestionCall;
      const phase = planCountQuestionPhase(fp(call), started, engStep0Boundary, engFirstReviewAUQ, engSetupAUQ);
      started = phase.reviewStarted; return phase.preReview;
    });
    expect(phases).toEqual([true, true, true, false, false, false, false, false, false, false]);
    expect(captured[8]!.questions[0]!.header).toBe('TODO: Diagrams');
    expect(captured[9]!.questions[0]!.header).toBe('TODO: Policy');
  });

  test('either offered scope decision and reordered options remain setup', () => {
    const c = fresh(); c.questions[0]!.options.reverse();
    for (const option of c.questions[0]!.options) {
      c.answers = {[c.questions[0]!.question]: option.label}; expect(setup(c)).toBe(true);
    }
    const varied = question(fresh(), s => s.replace('4 new classes across 12 files', '6 new classes across 20 files'));
    varied.questions[0]!.options[0]!.description = varied.questions[0]!.options[0]!.description.replace('4 classes across 12 files', '6 classes across 20 files');
    expect(setup(varied)).toBe(true);
  });

  test('component remedies, unfinished or conditional scope and additional work do not enter the new arm', () => {
    for (const transform of [
      (s: string) => s.replace('This plan introduces', 'If this plan introduces'),
      (s: string) => s.replace('This plan introduces', 'This component introduces'),
      (s: string) => s.replace('This plan introduces', 'This plan does not introduce'),
      (s: string) => s.replace('Recommend scope reduction before reviewing, or accept the complexity and review as-is?', 'Fix the global cache race before reviewing?'),
      (s: string) => s.replace('review as-is?', 'review as-is? Also approve the cache repair.'),
      (s: string) => s.replace('4 new classes', '0 new classes'),
      (s: string) => s.replace('plan-eng-review-scope-challenge', 'plan-eng-review-arch-shared-cache'),
      (s: string) => s.replace('plan-eng-review-scope-challenge', 'foreign-scope-challenge'),
      (s: string) => s + ' <gstack-qid:plan-eng-review-scope-challenge>',
      (s: string) => '> ' + s,
      (s: string) => '```text\n' + s + '\n```',
    ]) expect(setup(question(fresh(), transform))).toBe(false);
    for (const index of [0, 1]) {
      const c = fresh(); c.questions[0]!.options[index]!.description += ' Also implement the missing cache invalidation guard.';
      expect(setup(c)).toBe(false);
    }
    const mismatched = fresh(); mismatched.questions[0]!.options[0]!.description = mismatched.questions[0]!.options[0]!.description.replace('12 files', '99 files');
    expect(setup(mismatched)).toBe(false);
    for (const c of captured.slice(3)) expect(setup(structuredClone(c) as NativePlanQuestionCall)).toBe(false);
  });

  test('only a matched complete native answer to the closed two-option menu qualifies', () => {
    for (const mutate of [
      (c: NativePlanQuestionCall) => {c.answered = false;},
      (c: NativePlanQuestionCall) => {c.failed = true;},
      (c: NativePlanQuestionCall) => {delete c.failed;},
      (c: NativePlanQuestionCall) => {delete c.unansweredQuestionIndices;},
      (c: NativePlanQuestionCall) => {c.unansweredQuestionIndices = [0];},
      (c: NativePlanQuestionCall) => {c.questions[0]!.multiSelect = true;},
      (c: NativePlanQuestionCall) => {c.questions[0]!.header = 'Architecture';},
      (c: NativePlanQuestionCall) => {c.questions.push(structuredClone(c.questions[0]!));},
      (c: NativePlanQuestionCall) => {c.questions[0]!.options.push(structuredClone(c.questions[0]!.options[0]!));},
      (c: NativePlanQuestionCall) => {c.answers = {[c.questions[0]!.question]: 'unoffered scope decision'};},
    ]) {const c = fresh(); mutate(c); expect(setup(c)).toBe(false);}
    expect(engSetupAUQ({...fp(fresh()), signature: 'foreign:call'})).toBe(false);
    expect(engSetupAUQ({...fp(fresh()), nativeCall: undefined})).toBe(false);
    expect(engSetupAUQ({...fp(fresh()), options: []})).toBe(false);
  });
});
