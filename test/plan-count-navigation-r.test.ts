import { describe, expect, test } from 'bun:test';
import { capturePlanCountQuestion, nativePlanCallFingerprint, planCountPrerequisitePick, planCountQuestionInput } from './helpers/claude-pty-runner';
import { pickCeoCountQuestion } from './helpers/ceo-approach-pick';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
import paired from './fixtures/ceo-approach-r-call.json';
import distinct from './fixtures/ceo-approach-r-distinct-call.json';
import prerequisite from './fixtures/dx-prerequisite-r-call.json';

function pending(source: NativePlanQuestionCall): NativePlanQuestionCall {
  const call = structuredClone(source);
  call.answered = false;
  delete call.answers;
  delete call.unansweredQuestionIndices;
  delete call.answeredAt;
  return call;
}
function frame(call: NativePlanQuestionCall) {
  const q = call.questions[0]!;
  const visible = `☐ ${q.header}\n${q.question}\n${q.options.map((o, i) => `${i ? ' ' : '❯'} ${i + 1}. ${o.label}`).join('\n')}\nEnter to select · ↑/↓ to navigate · Esc to cancel`;
  const active = capturePlanCountQuestion(visible, new Set(), 0, true, call)!;
  return { visible, active, routing: nativePlanCallFingerprint(call, 0, true) };
}

describe('captured R planning navigation', () => {
  test('distinct CEO selects its third recommended approach without seed-word matching', () => {
    const call = pending(distinct as NativePlanQuestionCall);
    const { visible, active, routing } = frame(call);
    expect(distinct.answers[distinct.questions[0]!.question]).toBe(distinct.questions[0]!.options[0]!.label);
    const pick = pickCeoCountQuestion(routing, active) ?? 1;
    expect(pick).toBe(3);
    expect(planCountQuestionInput(visible, active, pick)).toBe('3');
  });

  test('paired CEO follows the offered recommendation instead of accepting vague assertions', () => {
    const call = pending(paired as NativePlanQuestionCall);
    const { visible, active, routing } = frame(call);
    expect(active.nativeCall).toBe(call);
    expect(paired.answers[paired.questions[0]!.question]).toBe(paired.questions[0]!.options[0]!.label);
    const pick = pickCeoCountQuestion(routing, active) ?? 1;
    expect(pick).toBe(2);
    expect(planCountQuestionInput(visible, active, pick)).toBe('2');
  });

  test('DX declines its optional office-hours detour using the full native option meaning', () => {
    const call = pending(prerequisite as NativePlanQuestionCall);
    const { visible, active, routing } = frame(call);
    expect(active.nativeCall).toBe(call);
    expect(prerequisite.answers[prerequisite.questions[0]!.question]).toBe(prerequisite.questions[0]!.options[0]!.label);
    const pick = planCountPrerequisitePick(routing, active) ?? 1;
    expect(pick).toBe(2);
    expect(planCountQuestionInput(visible, active, pick)).toBe('2');
  });

  test('CEO routing id and selector wording vary independently of option content and order', () => {
    for (const id of ['plan-ceo-approach', 'plan-ceo-review-approach', 'plan-ceo-approach-selection', 'plan-ceo-review-approach-selection']) {
      for (const verb of ['use', 'follow']) {
        const call = pending(paired as NativePlanQuestionCall);
        call.questions[0]!.question = `Which implementation approach should this plan ${verb}? <gstack-qid:${id}>`;
        call.questions[0]!.options = [{ label: 'Existing renderer (Recommended)' }, { label: 'Custom renderer' }];
        const { active, routing } = frame(call);
        expect(pickCeoCountQuestion(routing, active)).toBe(1);
      }
    }
  });

  test('short prerequisite labels require the current native question and affirmative review action', () => {
    for (const change of [
      (c: NativePlanQuestionCall) => { c.questions[0]!.options[1]!.description = ''; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.options[1]!.description = 'Do not proceed with standard DX POLISH review.'; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.options[1]!.description = 'Accept the finding and proceed with standard DX POLISH review.'; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.options[1]!.description = 'Accept this security finding. Proceed with standard DX POLISH review.'; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.options[1]!.description = 'Proceed with standard DX POLISH review after running /office-hours first.'; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.options[1]!.description = 'Proceed with standard DX POLISH review? No, run /office-hours first.'; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.options[1]!.description = 'Proceed with standard DX POLISH review. Accept the security risk.'; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.options[1]!.description = 'Plan scope is already precise. Proceed with standard DX POLISH review if the tests pass.'; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.options.push({ label: 'Accept this security finding' }); },
      (c: NativePlanQuestionCall) => { c.questions[0]!.multiSelect = true; },
      (c: NativePlanQuestionCall) => { c.questions.push(structuredClone(c.questions[0]!)); },
      (c: NativePlanQuestionCall) => { c.answered = true; },
      (c: NativePlanQuestionCall) => { c.failed = true; },
    ]) {
      const call = pending(prerequisite as NativePlanQuestionCall);
      change(call);
      const fp = nativePlanCallFingerprint(call, 0, true);
      expect(planCountPrerequisitePick(fp)).toBeNull();
    }
    const call = pending(prerequisite as NativePlanQuestionCall);
    const { active, routing, visible } = frame(call);
    expect(planCountPrerequisitePick(routing, { ...active, preReview: false })).toBeNull();
    expect(planCountPrerequisitePick(routing, { ...active, signature: 'stale:question' })).toBeNull();
    expect(planCountPrerequisitePick(routing, { ...active, nativeQuestionIndex: 1 })).toBeNull();
    expect(planCountPrerequisitePick(routing, { ...active, options: active.options.slice().reverse() })).toBeNull();
    const visibleOnly = capturePlanCountQuestion(visible, new Set(), 0, true)!;
    expect(visibleOnly.nativeCall).toBeUndefined();
    expect(planCountPrerequisitePick(routing, visibleOnly)).toBeNull();
    call.questions[0]!.options.reverse();
    const reordered = frame(call);
    expect(planCountPrerequisitePick(reordered.routing, reordered.active)).toBe(1);
  });

  test('a bare short label uses its bound unconditional review meaning', () => {
    const call = pending(prerequisite as NativePlanQuestionCall);call.questions[0]!.options[1]!.label='Skip';
    const {active,routing}=frame(call);expect(planCountPrerequisitePick(routing,active)).toBe(2);
  });

  test('short labels allow only a benign plan-scope premise plus the unconditional review action', () => {
    for (const description of ['Proceed with standard review.', 'Proceed with standard DX review', 'The plan is clear. Proceed with standard DX POLISH review.', 'Plan scope is already precise. Proceed with standard DX POLISH review.']) {
      const call = pending(prerequisite as NativePlanQuestionCall);
      call.questions[0]!.options[1]!.description = description;
      const { active, routing } = frame(call);
      expect(planCountPrerequisitePick(routing, active)).toBe(2);
    }
  });
});
