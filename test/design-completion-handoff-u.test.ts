import { describe, expect, test } from 'bun:test';
import { designStep0Boundary, nativePlanCallFingerprint, planCountQuestionPhase } from './helpers/claude-pty-runner';
import { isDesignCompletionHandoff, isDesignCountFirstReview, pickDesignCountQuestion } from './helpers/design-count-review';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
import actual from './fixtures/design-handoff-u-calls.json';

const calls = () => structuredClone(actual) as NativePlanQuestionCall[];
const handoff = () => calls().at(-1)!;
const fp = (call: NativePlanQuestionCall) => nativePlanCallFingerprint(call, 0, false);
function answer(call: NativePlanQuestionCall) {
  call.answers = { [call.questions[0]!.question]: call.questions[0]!.options[0]!.label };
  return call;
}
function pending(call: NativePlanQuestionCall) {
  call.answered = false;
  delete call.answers;
  delete call.unansweredQuestionIndices;
  return call;
}

describe('Design completed recap before its required review handoff', () => {
  test('the exact U calls preserve seven issues and classify only the eighth navigation call separately', () => {
    const input = calls();
    const before = structuredClone(input);
    let reviewStarted = false;
    const counts = { setup: 0, review: 0, administrative: 0 };
    for (const call of input) {
      const phase = planCountQuestionPhase(fp(call), reviewStarted, designStep0Boundary,
        isDesignCountFirstReview, undefined, isDesignCompletionHandoff);
      reviewStarted = phase.reviewStarted;
      if (phase.administrative) counts.administrative++;
      else if (phase.preReview) counts.setup++;
      else counts.review++;
    }
    expect(counts).toEqual({ setup: 0, review: 7, administrative: 1 });
    expect(input.slice(0, 7).every(call => !isDesignCompletionHandoff(fp(call)))).toBe(true);
    expect(input).toEqual(before);
  });

  test('the pending exact menu chooses its actual manual option in either order', () => {
    for (const reverse of [false, true]) {
      const call = pending(handoff());
      if (reverse) call.questions[0]!.options.reverse();
      expect(pickDesignCountQuestion(fp(call), fp(call))).toBe(reverse ? 1 : 2);
      expect(isDesignCompletionHandoff(fp(call))).toBe(false);
      expect(pickDesignCountQuestion(fp(call), { ...fp(call), signature: 'foreign:request' })).toBeNull();
    }
  });

  test('completed recap facts vary without changing the native closed-review decision', () => {
    for (const recap of [
      '7 decisions resolved, 6 implementation tasks added, 0 deferred.',
      'All findings resolved. 6 tasks recorded. No deferred issues.',
      'The design review recorded accessibility and form-layout requirements. 7 issues addressed.',
      'This review has approved responsive layout constraints. Zero unresolved decisions.',
    ]) {
      const call = handoff();
      call.questions[0]!.question = `Design review complete (6/10 → 9/10). ${recap} Engineering Review is the required shipping gate. What next? <gstack-qid:plan-design-review-next-step>`;
      expect(isDesignCompletionHandoff(fp(answer(call)))).toBe(true);
      const active = fp(pending(call));
      expect(pickDesignCountQuestion(active, active)).toBe(2);
    }
  });

  test('a closed prefix never hides unfinished work, another decision, source claims or new instructions', () => {
    const invalid = [
      'One contrast gap remains.', '7 decisions unresolved.', '1 deferred issue.',
      'The review is not complete.', 'The review will be complete after contrast is fixed.',
      'The plan claims that all issues are resolved.', 'The design review added a task; configure the missing states.',
      'The design review added a task. Configure the missing states.',
      'The design review added a task and then delete the validation.',
      'The design review added a task — remove the accessibility check.',
      'The design review added a task. Should we fix its contrast?',
      'The design review added a task if the user approves it.',
      'The design review added a task but the contrast is still missing.',
    ];
    for (const text of invalid) {
      const call = handoff();
      call.questions[0]!.question = `Design review complete. ${text} Eng Review is the required shipping gate. What next? <gstack-qid:plan-design-review-next-step>`;
      expect(isDesignCompletionHandoff(fp(answer(call)))).toBe(false);
      const active = fp(pending(call));
      expect(pickDesignCountQuestion(active, active)).toBeNull();
    }
  });

  test('offered action descriptions cannot smuggle new work or conditional closure', () => {
    for (const extra of [
      ' Configure a new layout.', ' Remove the missing test.', ' Pick the unresolved color.',
      ' Then implement the spinner.', ' The review is incomplete.',
      ' Once contrast is fixed, all decisions are resolved.',
      ' Please fix the contrast before proceeding.',
    ]) {
      const call = handoff();
      call.questions[0]!.options[1]!.description += extra;
      expect(isDesignCompletionHandoff(fp(call))).toBe(false);
      const active = fp(pending(call));
      expect(pickDesignCountQuestion(active, active)).toBeNull();
    }
  });

  test('native identity, complete offered answers and the exact binary menu remain required', () => {
    const mutations: Array<(call: NativePlanQuestionCall) => void> = [
      c => { c.failed = true; }, c => { c.answered = false; },
      c => { c.unansweredQuestionIndices = [0]; }, c => { delete c.unansweredQuestionIndices; },
      c => { c.answers = {}; }, c => { c.answers = { [c.questions[0]!.question]: 'repair another issue' }; },
      c => { c.questions[0]!.header = 'Contrast'; }, c => { c.questions[0]!.multiSelect = true; },
      c => { c.questions[0]!.question = c.questions[0]!.question.replace('plan-design-review-next-step', 'plan-ceo-review-next-step'); },
      c => { c.questions[0]!.question += ' <gstack-qid:plan-design-review-next-step>'; },
      c => { c.questions[0]!.options.push({ label: 'Run /plan-ceo-review first' }); },
      c => { c.questions[0]!.options.push(structuredClone(c.questions[0]!.options[1]!)); },
      c => { c.questions[0]!.options[1]!.label += ' and fix contrast'; },
      c => { c.questions[0]!.question = c.questions[0]!.question.replace('Eng review is the required shipping gate.', 'Eng review is optional.'); },
    ];
    for (const mutate of mutations) {
      const call = handoff(); mutate(call);
      expect(isDesignCompletionHandoff(fp(call))).toBe(false);
    }
    expect(isDesignCompletionHandoff({ ...fp(handoff()), nativeCall: undefined })).toBe(false);
    expect(isDesignCompletionHandoff({ ...fp(handoff()), signature: 'foreign:request' })).toBe(false);
  });
});
