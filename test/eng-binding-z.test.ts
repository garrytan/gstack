import { describe, expect, test } from 'bun:test';
import captured from './fixtures/eng-binding-z-calls.json';
import { engFirstReviewAUQ, engSetupAUQ, engStep0Boundary, nativePlanCallFingerprint, planCountQuestionPhase } from './helpers/claude-pty-runner';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';

const fresh = () => structuredClone(captured[1]!) as NativePlanQuestionCall;
const fp = (c: NativePlanQuestionCall) => nativePlanCallFingerprint(c, 0, true);
const first = (c: NativePlanQuestionCall) => engFirstReviewAUQ(fp(c));
function question(c: NativePlanQuestionCall, transform: (s: string) => string) {
  const q = c.questions[0]!; const answer = c.answers![q.question]!;
  q.question = transform(q.question); c.answers = {[q.question]: answer}; return c;
}

describe('Z Eng dependency binding starts substantive review', () => {
  test('the actual cache dependency decision starts review without an issue label', () => {
    expect(engSetupAUQ(fp(fresh()))).toBe(false);
    expect(first(fresh())).toBe(true);
    expect(planCountQuestionPhase(fp(fresh()), false, engStep0Boundary, engFirstReviewAUQ, engSetupAUQ))
      .toEqual({preReview: false, reviewStarted: true});
  });

  test('the exact six native calls preserve one setup and all five review obligations', () => {
    let started = false;
    const phases = captured.map(c => {
      const p = planCountQuestionPhase(fp(structuredClone(c) as NativePlanQuestionCall), started, engStep0Boundary, engFirstReviewAUQ, engSetupAUQ);
      started = p.reviewStarted; return p.preReview;
    });
    expect(phases).toEqual([true, false, false, false, false, false]);
    expect(first(structuredClone(captured[0]!) as NativePlanQuestionCall)).toBe(false);
    expect(captured[5]!.questions[0]!.header).toBe('TODO: Timeout');
  });

  test('either offered choice, reordering and a different component retain issue identity', () => {
    const c = fresh(); c.questions[0]!.options.reverse();
    for (const option of c.questions[0]!.options) {
      c.answers = {[c.questions[0]!.question]: option.label}; expect(first(c)).toBe(true);
    }
    const varied = question(fresh(), s => s.replace('AuthBroker', 'SessionGateway').replace('D2', 'D7'));
    for (const option of varied.questions[0]!.options) option.description = option.description.replaceAll('AuthBroker', 'SessionGateway');
    expect(first(varied)).toBe(true);
  });

  test('requires a complete native call and exact offered answer and fingerprint', () => {
    for (const mutate of [
      (c: NativePlanQuestionCall) => { c.answered = false; },
      (c: NativePlanQuestionCall) => { c.failed = true; },
      (c: NativePlanQuestionCall) => { delete c.failed; },
      (c: NativePlanQuestionCall) => { delete c.unansweredQuestionIndices; },
      (c: NativePlanQuestionCall) => { c.unansweredQuestionIndices = [0]; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.multiSelect = true; },
      (c: NativePlanQuestionCall) => { c.questions.push(structuredClone(c.questions[0]!)); },
      (c: NativePlanQuestionCall) => { c.questions[0]!.options.push(structuredClone(c.questions[0]!.options[0]!)); },
      (c: NativePlanQuestionCall) => { c.questions[0]!.options[1]!.label = c.questions[0]!.options[0]!.label; },
      (c: NativePlanQuestionCall) => { c.answers = {}; },
      (c: NativePlanQuestionCall) => { c.answers = {[c.questions[0]!.question]: 'Foreign answer'}; },
    ]) { const c = fresh(); mutate(c); expect(first(c)).toBe(false); }
    expect(engFirstReviewAUQ({...fp(fresh()), signature: 'foreign:call'})).toBe(false);
    expect(engFirstReviewAUQ({...fp(fresh()), nativeCall: undefined})).toBe(false);
    expect(engFirstReviewAUQ({...fp(fresh()), options: []})).toBe(false);
    const mismatch = fp(fresh()); mismatch.options[0]!.label = 'foreign'; expect(engFirstReviewAUQ(mismatch)).toBe(false);
    const wrongIndex = fp(fresh()); wrongIndex.options[0]!.index = 2; expect(engFirstReviewAUQ(wrongIndex)).toBe(false);
  });

  test('setup, foreign, hypothetical, quoted and mixed questions cannot open review', () => {
    for (const header of ['Scope', 'Approach', 'Next review', 'Onboarding']) {
      const c = fresh(); c.questions[0]!.header = header; expect(first(c)).toBe(false);
    }
    for (const transform of [
      (s: string) => s.replace('Architecture:', 'Approach:'),
      (s: string) => s.replace('How should AuthBroker', 'If needed, how should AuthBroker'),
      (s: string) => s.replace('AuthBroker access', 'the whole plan access'),
      (s: string) => s.replace('plan-eng-cache-binding', 'plan-eng-setup'),
      (s: string) => s.replace('plan-eng-cache-binding', 'foreign-cache-binding'),
      (s: string) => s.replace(/ <gstack-qid:[^>]+>/, ''),
      (s: string) => s + ' <gstack-qid:plan-eng-cache-binding>',
      (s: string) => s + ' Approve the release too.',
      (s: string) => '> ' + s,
      (s: string) => '```text\n' + s + '\n```',
    ]) expect(first(question(fresh(), transform))).toBe(false);
  });

  test('both descriptions must affirm the existing dependency and remedy without extra obligations', () => {
    for (const [index, transform] of [
      [0, (s: string) => s.replace('Eliminates module-level mutable state entirely.', 'Does not eliminate module-level mutable state.')],
      [0, (s: string) => s.replace('Eliminates module-level mutable state entirely.', 'If shared state exists, eliminates it.')],
      [0, (s: string) => s.replace('AuthBroker receives', 'DifferentComponent receives')],
      [1, (s: string) => s.replace('same pattern as the current plan', 'unlike the current plan')],
      [1, (s: string) => s.replace('makes tests require module-level mocking', 'does not make tests require module-level mocking')],
      [1, (s: string) => s.replace('AuthBroker imports', 'DifferentComponent imports')],
      [0, (s: string) => s + ' Also grant every tenant access.'],
      [1, (s: string) => s + ' Also approve the missing timeout policy.'],
      [0, (s: string) => '> ' + s],
      [1, (s: string) => '```text\n' + s + '\n```'],
    ] as const) {
      const c = fresh(); const option = c.questions[0]!.options[index]!;
      option.description = transform(option.description ?? ''); expect(first(c)).toBe(false);
    }
    const c = fresh(); c.questions[0]!.options[0]!.label = 'Run /office-hours';
    c.answers = {[c.questions[0]!.question]: 'Run /office-hours'}; expect(first(c)).toBe(false);
  });
});
