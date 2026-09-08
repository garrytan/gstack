import { describe, expect, test } from 'bun:test';
import { capturePlanCountQuestion, ceoStep0Boundary, nativePlanCallFingerprint, planCountQuestionPhase } from './helpers/claude-pty-runner';
import { isCeoCompletionHandoff, pickCeoCompletionHandoff } from './helpers/ceo-completion-handoff';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
import captures from './fixtures/ceo-completion-handoff-calls.json';

type CapturedCall = typeof captures.cases[number]['calls'][number];
function nativeCall(record: CapturedCall, sessionId = 'native-capture'): NativePlanQuestionCall {
  return {
    sessionId, toolUseId: record.toolUseId, answered: true, failed: false,
    questions: [{ header: record.header, question: record.question,
      options: record.options.map(label => ({ label })), multiSelect: false }],
    answers: { [record.question]: record.answer }, unansweredQuestionIndices: [],
  };
}
const handoff = () => nativeCall(captures.cases[0]!.calls.at(-1)!);
const fingerprint = (call: NativePlanQuestionCall) => nativePlanCallFingerprint(call, 0, false);

function replay(calls: NativePlanQuestionCall[], reviewStarted = true) {
  const counts = { step0Count: 0, reviewCount: 0, administrativeCount: 0 };
  const classifications = [];
  for (const call of calls) {
    const fp = fingerprint(call);
    const phase = planCountQuestionPhase(fp, reviewStarted, ceoStep0Boundary,
      // A completion summary can mention defects; even a broad positive
      // first-finding predicate must not promote a handoff into coverage.
      () => true, undefined, isCeoCompletionHandoff);
    if (phase.administrative) counts.administrativeCount++;
    else if (phase.preReview) counts.step0Count++;
    else counts.reviewCount++;
    reviewStarted = phase.reviewStarted;
    classifications.push(phase);
  }
  return { ...counts, reviewStarted, classifications };
}

describe('CEO completion handoff classification and selection', () => {
  test('captured first attempts keep every finding/TODO and exclude only the handoff; substantive retry still fails its band', () => {
    for (const scenario of captures.cases) {
      const calls = scenario.calls.map(c => nativeCall(c, scenario.sessionId));
      const original = structuredClone(calls);
      const result = replay(calls);
      expect(result.reviewCount).toBe(scenario.expectedReviewCount);
      expect(result.administrativeCount).toBe(scenario.name === 'five-retry' ? 0 : 1);
      expect(result.step0Count).toBe(0);
      expect(calls).toEqual(original); // Classification never discards or rewrites native evidence.
      for (const [i, call] of calls.entries()) {
        if (/TODO/i.test(call.questions[0]!.header)) expect(result.classifications[i]!.administrative).toBeUndefined();
      }
    }
    expect(replay(captures.cases[2]!.calls.map(c => nativeCall(c))).reviewCount).toBeGreaterThan(7);
  });
  test('handoff-only replay adds no findings or setup and cannot establish a first finding', () => {
    const result = replay([handoff()], false);
    expect(result).toMatchObject({ step0Count: 0, reviewCount: 0, administrativeCount: 1, reviewStarted: false });
    expect(result.classifications[0]).toEqual({ preReview: false, reviewStarted: false, administrative: 'completion-handoff' });
  });
  test('manual/done action is selected in either option order only while the matching native question is pending', () => {
    for (const reverse of [false, true]) {
      const call = handoff(); call.answered = false; delete call.answers; delete call.unansweredQuestionIndices;
      if (reverse) call.questions[0]!.options.reverse();
      const fp = fingerprint(call);
      expect(pickCeoCompletionHandoff(fp)).toBe(reverse ? 1 : 2);
      expect(isCeoCompletionHandoff(fp)).toBe(false);
    }
    expect(pickCeoCompletionHandoff(fingerprint(handoff()))).toBeNull();
  });
  test('substantive choices mentioning another review retain the normal choice and finding count', () => {
    const call = nativeCall(captures.cases[0]!.calls[0]!);
    call.questions[0]!.question += ' Run /plan-eng-review next after deciding how to fix this issue.';
    call.answers = { [call.questions[0]!.question]: call.questions[0]!.options[0]!.label };
    expect(isCeoCompletionHandoff(fingerprint(call))).toBe(false);
    expect(replay([call]).reviewCount).toBe(1);
    call.answered = false;
    expect(pickCeoCompletionHandoff(fingerprint(call))).toBeNull();
  });
  test('mixed packets and unknown action choices are not classified as an administrative handoff', () => {
    const mixed = handoff();
    const finding = nativeCall(captures.cases[0]!.calls[0]!);
    mixed.questions.push(finding.questions[0]!);
    mixed.answers = { ...mixed.answers, ...finding.answers };
    expect(isCeoCompletionHandoff(fingerprint(mixed))).toBe(false);
    expect(replay([mixed]).reviewCount).toBe(1);
    mixed.answered = false;
    expect(pickCeoCompletionHandoff(fingerprint(mixed))).toBeNull();
    const unknown = handoff(); unknown.questions[0]!.options.push({ label: 'Add another payment test before continuing' });
    expect(isCeoCompletionHandoff(fingerprint(unknown))).toBe(false);
  });
  test('unknown identities and generic skip choices remain counted', () => {
    for (const mutate of [
      (c: NativePlanQuestionCall) => { c.questions[0]!.question += ' <gstack-qid:plan-ceo-security-finding>'; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.header = 'Test gap'; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.options[1]!.label = 'Skip'; },
    ]) {
      const call = handoff(); mutate(call);
      call.answers = { [call.questions[0]!.question]: call.questions[0]!.options[0]!.label };
      expect(isCeoCompletionHandoff(fingerprint(call))).toBe(false);
      expect(replay([call]).reviewCount).toBe(1);
    }
    const call = handoff(); call.answered = false;
    const mismatched = { ...fingerprint(call), signature: 'another-native-call' };
    expect(pickCeoCompletionHandoff(mismatched)).toBeNull();
  });
  test('pending, failed, partial and free-form answers never create an exclusion', () => {
    for (const mutate of [
      (c: NativePlanQuestionCall) => { c.answered = false; },
      (c: NativePlanQuestionCall) => { c.failed = true; },
      (c: NativePlanQuestionCall) => { c.unansweredQuestionIndices = [0]; },
      (c: NativePlanQuestionCall) => { c.answers = {}; },
      (c: NativePlanQuestionCall) => { c.answers = { [c.questions[0]!.question]: 'First add a refund test' }; },
    ]) {
      const call = handoff(); mutate(call);
      expect(isCeoCompletionHandoff(fingerprint(call))).toBe(false);
    }
  });
  test('UI-only and unrelated pending metadata cannot steer the active menu', () => {
    const pending = handoff(); pending.answered = false; delete pending.answers;
    const q = pending.questions[0]!;
    const active = `☐ ${q.header}\n${q.question}\n❯ 1. ${q.options[0]!.label}\n  2. ${q.options[1]!.label}\nEnter to select · ↑/↓ to navigate · Esc to cancel`;
    const bound = capturePlanCountQuestion(active, new Set(), 0, false, pending)!;
    expect(pickCeoCompletionHandoff(fingerprint(pending), bound)).toBe(2);
    const uiOnly = capturePlanCountQuestion(active, new Set(), 0, false)!;
    expect(pickCeoCompletionHandoff(uiOnly)).toBeNull();
    const issue = '☐ Security finding\nChoose how to parameterize the SQL query.\n❯ 1. Fix query\n  2. Add a TODO\nEnter to select · ↑/↓ to navigate · Esc to cancel';
    const unbound = capturePlanCountQuestion(issue, new Set(), 0, false, pending)!;
    expect(unbound.nativeCall).toBeUndefined();
    expect(pickCeoCompletionHandoff(fingerprint(pending), unbound)).toBeNull();
  });
});
