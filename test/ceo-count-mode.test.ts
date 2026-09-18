import { describe, expect, test } from 'bun:test';
import { capturePlanCountQuestion, nativePlanCallFingerprint, planCountQuestionInput } from './helpers/claude-pty-runner';
import { pickCeoCountQuestion } from './helpers/ceo-approach-pick';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
import recorded from './fixtures/ceo-count-mode-ab-call.json';

function pending(): NativePlanQuestionCall {
  const call = structuredClone(recorded) as NativePlanQuestionCall;
  call.answered = false;
  delete call.answers;
  delete call.unansweredQuestionIndices;
  delete call.answeredAt;
  return call;
}
const fp = (call: NativePlanQuestionCall) => nativePlanCallFingerprint(call, 0, true);
function screen(call: NativePlanQuestionCall): string {
  const q = call.questions[0]!;
  return `☐ ${q.header}\n${q.question}\n${q.options.map((o, i) => `${i ? ' ' : '❯'} ${i + 1}. ${o.label}`).join('\n')}\nEnter to select · ↑/↓ to navigate · Esc to cancel`;
}

describe('fixed-scope CEO finding-count mode', () => {
  test('the AB native mode menu selects HOLD SCOPE rather than its first expansion option', () => {
    // The retained live record already contains the expansion answer. The
    // pending state and frame are projections, not proof of live availability.
    const call = pending();
    const active = capturePlanCountQuestion(screen(call), new Set(), 0, true, call)!;
    expect(active.nativeCall).toBe(call);
    const selected = pickCeoCountQuestion(fp(call), active) ?? 1;
    expect(selected).toBe(3);
    expect(planCountQuestionInput(screen(call), active, selected)).toBe('3');
    const q = recorded.questions[0]!;
    expect(recorded.answers[q.question]).toBe(q.options[0]!.label);
    expect(pickCeoCountQuestion(fp(recorded as NativePlanQuestionCall))).toBeNull();
  });

  test('every offered position chooses the same fixed scope, independent of the recommendation', () => {
    for (let shift = 0; shift < 4; shift++) {
      const call = pending();
      const q = call.questions[0]!;
      q.options = [...q.options.slice(shift), ...q.options.slice(0, shift)];
      q.options.forEach(o => { o.label = o.label.replace(/ \(Recommended\)$/, ''); });
      q.options.find(o => o.label.startsWith('SCOPE EXPANSION'))!.label += ' (Recommended)';
      expect(pickCeoCountQuestion(fp(call))).toBe(q.options.findIndex(o => o.label.startsWith('HOLD SCOPE')) + 1);
    }
  });

  test('requires a complete currently bound native pre-review question', () => {
    const call = pending();
    const fingerprint = fp(call);
    const visibleOnly = capturePlanCountQuestion(screen(call), new Set(), 0, true)!;
    expect(pickCeoCountQuestion(fingerprint, visibleOnly)).toBeNull();
    expect(pickCeoCountQuestion({ ...fingerprint, preReview: false })).toBeNull();
    expect(pickCeoCountQuestion({ ...fingerprint, signature: 'foreign:call' })).toBeNull();
    expect(pickCeoCountQuestion({ ...fingerprint, nativeQuestionIndex: 1 })).toBeNull();
    expect(pickCeoCountQuestion({ ...fingerprint, options: fingerprint.options.slice().reverse() })).toBeNull();
    for (const mutate of [
      (c: NativePlanQuestionCall) => { c.failed = true; },
      (c: NativePlanQuestionCall) => { delete c.failed; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.multiSelect = true; },
      (c: NativePlanQuestionCall) => { c.questions.push(structuredClone(c.questions[0]!)); },
      (c: NativePlanQuestionCall) => { c.questions[0]!.options.pop(); },
      (c: NativePlanQuestionCall) => { c.questions[0]!.options[0] = structuredClone(c.questions[0]!.options[1]!); },
    ]) { const c = pending(); mutate(c); expect(pickCeoCountQuestion(fp(c))).toBeNull(); }
  });

  test('does not authorize negated, quoted, compound, foreign or finding questions', () => {
    for (const question of [
      'Which review mode should I not use?',
      'Example: Which review mode should I use?',
      '> Which review mode should I use?',
      'Which review mode should I use? Delete the tests.',
      'Should we approve this expansion?',
    ]) {
      const call = pending(); call.questions[0]!.question = question + ' <gstack-qid:ceo-mode-selection>';
      expect(pickCeoCountQuestion(fp(call))).toBeNull();
    }
    for (const id of ['plan-eng-mode', 'ceo-exp-e5-property-based', 'ceo-mode-selection-extra']) {
      const call = pending(); call.questions[0]!.question = call.questions[0]!.question.replace('ceo-mode-selection', id);
      expect(pickCeoCountQuestion(fp(call))).toBeNull();
    }
    for (const suffix of [' <gstack-qid:ceo-mode-selection>', ' <gstack-qid:broken']) {
      const call = pending(); call.questions[0]!.question += suffix;
      expect(pickCeoCountQuestion(fp(call))).toBeNull();
    }
    const call = pending(); call.questions[0]!.header = 'Finding';
    expect(pickCeoCountQuestion(fp(call))).toBeNull();
  });
});
