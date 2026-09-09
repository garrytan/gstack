import { describe, expect, test } from 'bun:test';
import { capturePlanCountQuestion, ceoFirstReviewAUQ, ceoStep0Boundary, nativePlanCallFingerprint, planCountQuestionPhase } from './helpers/claude-pty-runner';
import { isCeoCompletionHandoff, pickCeoCompletionHandoff } from './helpers/ceo-completion-handoff';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
import captured from './fixtures/ceo-completion-handoff-l-calls.json';

const calls = () => structuredClone(captured.calls) as NativePlanQuestionCall[];
const fingerprint = (call: NativePlanQuestionCall) => nativePlanCallFingerprint(call, 0, false);

describe('CEO closed review with zero unresolved decisions', () => {
  test('the actual final handoff leaves all four independent issue and TODO decisions intact', () => {
    const input = calls();
    const original = structuredClone(input);
    let started = false;
    const counts = { setup: 0, review: 0, administrative: 0 };
    for (const call of input) {
      const phase = planCountQuestionPhase(fingerprint(call), started, ceoStep0Boundary,
        ceoFirstReviewAUQ, undefined, isCeoCompletionHandoff);
      started = phase.reviewStarted;
      if (phase.administrative) counts.administrative++;
      else if (phase.preReview) counts.setup++;
      else counts.review++;
    }
    expect(counts).toEqual({ setup: 4, review: 4, administrative: 1 });
    expect(input.filter(c => /TODO/i.test(c.questions[0]!.header)).every(c =>
      !isCeoCompletionHandoff(fingerprint(c)))).toBe(true);
    expect(input).toEqual(original);
  });

  test('the offered manual action binds to the active native menu in either order', () => {
    for (const reverse of [false, true]) {
      const call = calls().at(-1)!;
      call.answered = false;
      delete call.answers;
      delete call.unansweredQuestionIndices;
      const q = call.questions[0]!;
      if (reverse) q.options.reverse();
      const visible = `☐ ${q.header}\n${q.question}\n` + q.options.map((option, i) =>
        `${i ? ' ' : '❯'} ${i + 1}. ${option.label}`).join('\n') +
        '\nEnter to select · ↑/↓ to navigate · Esc to cancel';
      const active = capturePlanCountQuestion(visible, new Set(), 0, false, call)!;
      expect(pickCeoCompletionHandoff(fingerprint(call), active)).toBe(reverse ? 1 : 2);
      expect(pickCeoCompletionHandoff(fingerprint(call), { ...active, signature: 'other' })).toBeNull();
      expect(isCeoCompletionHandoff(fingerprint(call))).toBe(false);
    }
  });

  test('conditional, unresolved, substantive and unconfirmed variants are not handoffs', () => {
    const mutations: Array<(c: NativePlanQuestionCall) => void> = [
      c => { c.questions[0]!.question = c.questions[0]!.question.replace('0 unresolved', '1 unresolved'); },
      c => { c.questions[0]!.question = c.questions[0]!.question.replace('0 unresolved decisions.', '0 unresolved decisions after fixing receipt assertions.'); },
      c => { c.questions[0]!.question = c.questions[0]!.question.replace('is complete', 'is not complete'); },
      c => { c.questions[0]!.question = c.questions[0]!.question.replace('ceo-next-step-eng-review', 'ceo-security-finding'); },
      c => { c.questions[0]!.header = 'Receipt gap'; },
      c => { c.questions[0]!.options.push({ label: 'Add the missing happy-path assertions' }); },
      c => { c.questions.push(calls()[4]!.questions[0]!); },
      c => { c.failed = true; },
      c => { c.answered = false; },
      c => { c.unansweredQuestionIndices = [0]; },
    ];
    for (const mutate of mutations) {
      const call = calls().at(-1)!;
      mutate(call);
      call.answers = Object.fromEntries(call.questions.map(q => [q.question, q.options[0]!.label]));
      expect(isCeoCompletionHandoff(fingerprint(call))).toBe(false);
    }
    const call = calls().at(-1)!;
    call.answers = { [call.questions[0]!.question]: 'First add another test' };
    expect(isCeoCompletionHandoff(fingerprint(call))).toBe(false);
  });
});
