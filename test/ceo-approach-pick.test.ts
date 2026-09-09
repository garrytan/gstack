import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { capturePlanCountQuestion, nativePlanCallFingerprint, planCountQuestionInput } from './helpers/claude-pty-runner';
import { pickCeoCompletionHandoff } from './helpers/ceo-completion-handoff';
import { pickCeoCountQuestion, pickCeoRecommendedApproach } from './helpers/ceo-approach-pick';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
import recorded from './fixtures/ceo-approach-q-call.json';
import pairedRecorded from './fixtures/ceo-approach-q-paired-call.json';
import handoffs from './fixtures/ceo-completion-handoff-m-call.json';

function pending(source: NativePlanQuestionCall = recorded as NativePlanQuestionCall): NativePlanQuestionCall {
  const call = structuredClone(source);
  call.answered = false;
  delete call.answers;
  delete call.unansweredQuestionIndices;
  return call;
}
const fingerprint = (call: NativePlanQuestionCall, preReview = true) => nativePlanCallFingerprint(call, 0, preReview);
function screen(call: NativePlanQuestionCall): string {
  const q = call.questions[0]!;
  return `☐ ${q.header}\n${q.question}\n${q.options.map((o, i) => `${i ? ' ' : '❯'} ${i + 1}. ${o.label}`).join('\n')}\nEnter to select · ↑/↓ to navigate · Esc to cancel`;
}

describe('CEO pre-review approach recommendation', () => {
  test('the exact Q menu changes the old default risk acceptance to its offered recommendation', () => {
    const call = pending();
    const visible = screen(call);
    const active = capturePlanCountQuestion(visible, new Set(), 0, true, call)!;
    expect(active.nativeCall).toBe(call);
    const before = pickCeoCompletionHandoff(fingerprint(call), active) ?? 1;
    const after = pickCeoCountQuestion(fingerprint(call), active) ?? 1;
    expect(before).toBe(1);
    expect(after).toBe(2);
    expect(planCountQuestionInput(visible, active, after)).toBe('2');
    expect(recorded.answers[recorded.questions[0]!.question]).toBe(recorded.questions[0]!.options[0]!.label);
    expect(pickCeoCountQuestion(fingerprint(recorded as NativePlanQuestionCall))).toBeNull();
  });

  test('the paired first native approach uses the same offered recommendation policy', () => {
    const call = pending(pairedRecorded as NativePlanQuestionCall);
    const visible = screen(call);
    const active = capturePlanCountQuestion(visible, new Set(), 0, true, call)!;
    expect(active.nativeCall).toBe(call);
    expect(pickCeoCompletionHandoff(fingerprint(call), active) ?? 1).toBe(1);
    const after = pickCeoCountQuestion(fingerprint(call), active) ?? 1;
    expect(after).toBe(2);
    expect(planCountQuestionInput(visible, active, after)).toBe('2');
    expect(pairedRecorded.answers[pairedRecorded.questions[0]!.question]).toBe(pairedRecorded.questions[0]!.options[0]!.label);
    expect(pickCeoCountQuestion(fingerprint(pairedRecorded as NativePlanQuestionCall))).toBeNull();
  });

  test('paired approach grammar is function-agnostic and follows reordered options', () => {
    const call = pending(pairedRecorded as NativePlanQuestionCall);
    const q = call.questions[0]!;
    q.question = 'D3 — Which implementation approach for the renderWidget() tests? <gstack-qid:plan-ceo-review-impl-approach>';
    q.options = [{ label: 'A) Custom renderer' }, { label: 'B) Existing renderer (Recommended)' }];
    expect(pickCeoRecommendedApproach(fingerprint(call))).toBe(2);
    q.options.reverse();
    expect(pickCeoRecommendedApproach(fingerprint(call))).toBe(1);
  });

  test.each([
    ['non-approach question', 'Should the renderWidget() tests be deleted? <gstack-qid:plan-ceo-review-impl-approach>'],
    ['negated question', 'Which implementation approach should the renderWidget() tests not use? <gstack-qid:plan-ceo-review-impl-approach>'],
    ['negated test subject', 'Which implementation approach for not testing renderWidget()? <gstack-qid:plan-ceo-review-impl-approach>'],
    ['wrong approach identity', 'Which implementation approach for the renderWidget() tests? <gstack-qid:plan-ceo-approach>'],
    ['extra action before question', 'Delete the tests. Which implementation approach for the renderWidget() tests? <gstack-qid:plan-ceo-review-impl-approach>'],
  ])('does not apply paired approach selection to %s', (_name, question) => {
    const call = pending(pairedRecorded as NativePlanQuestionCall);
    call.questions[0]!.question = question;
    expect(pickCeoRecommendedApproach(fingerprint(call))).toBeNull();
  });

  test('recommendation follows actual option position and arbitrary approach content, never seed words', () => {
    for (const order of [[0, 1, 2], [1, 2, 0], [2, 0, 1]]) {
      const call = pending();
      const q = call.questions[0]!;
      const options = [{ label: 'A) Compare two renderers' }, { label: 'B) Existing renderer (Recommended)' }, { label: 'C) Custom renderer' }];
      q.options = order.map(index => options[index]!);
      q.question = 'D1 — Which implementation approach should this plan use? <gstack-qid:plan-ceo-approach>';
      expect(pickCeoRecommendedApproach(fingerprint(call))).toBe(order.indexOf(1) + 1);
    }
  });

  test.each([
    ['no recommendation', (c: NativePlanQuestionCall) => { c.questions[0]!.options[1]!.label = 'B) Secure Baseline'; }],
    ['duplicate recommendation', (c: NativePlanQuestionCall) => { c.questions[0]!.options[0]!.label += ' (Recommended)'; }],
    ['duplicate offered label', (c: NativePlanQuestionCall) => { c.questions[0]!.options[2]!.label = c.questions[0]!.options[1]!.label; }],
    ['negated recommendation', (c: NativePlanQuestionCall) => { c.questions[0]!.options[1]!.label = 'B) Not (Recommended)'; }],
    ['conflicting recommendation', (c: NativePlanQuestionCall) => { c.questions[0]!.options[1]!.label = 'B) Not recommended here (Recommended)'; }],
    ['description-only recommendation', (c: NativePlanQuestionCall) => { c.questions[0]!.options[1]!.label = 'B) Secure Baseline'; c.questions[0]!.options[1]!.description = 'Recommended'; }],
    ['unknown qid', (c: NativePlanQuestionCall) => { c.questions[0]!.question = c.questions[0]!.question.replace('plan-ceo-approach', 'plan-ceo-security'); }],
    ['missing qid', (c: NativePlanQuestionCall) => { c.questions[0]!.question = c.questions[0]!.question.replace('<gstack-qid:plan-ceo-approach>', ''); }],
    ['malformed extra qid', (c: NativePlanQuestionCall) => { c.questions[0]!.question += '<gstack-qid:broken'; }],
    ['duplicate qid', (c: NativePlanQuestionCall) => { c.questions[0]!.question += '<gstack-qid:plan-ceo-approach>'; }],
    ['negated approach question', (c: NativePlanQuestionCall) => { c.questions[0]!.question = c.questions[0]!.question.replace('should this plan use?', 'should this plan not use?'); }],
    ['non-approach question', (c: NativePlanQuestionCall) => { c.questions[0]!.question = 'Should we accept this security risk? <gstack-qid:plan-ceo-approach>'; }],
    ['non-approach header', (c: NativePlanQuestionCall) => { c.questions[0]!.header = 'Review Mode'; }],
    ['multi-select', (c: NativePlanQuestionCall) => { c.questions[0]!.multiSelect = true; }],
    ['mixed packet', (c: NativePlanQuestionCall) => { c.questions.push(structuredClone(c.questions[0]!)); }],
    ['failed native call', (c: NativePlanQuestionCall) => { c.failed = true; }],
  ])('keeps the old caller/default policy for %s', (_name, change) => {
    const call = pending();
    change(call);
    const fp = fingerprint(call);
    expect(pickCeoRecommendedApproach(fp)).toBeNull();
    expect(pickCeoCountQuestion(fp)).toBe(pickCeoCompletionHandoff(fp));
  });

  test('requires current native binding and pre-review phase', () => {
    const call = pending();
    const fp = fingerprint(call);
    expect(pickCeoRecommendedApproach({ ...fp, preReview: false })).toBeNull();
    expect(pickCeoRecommendedApproach({ ...fp, signature: 'foreign:call' })).toBeNull();
    expect(pickCeoRecommendedApproach({ ...fp, nativeQuestionIndex: 1 })).toBeNull();
    expect(pickCeoRecommendedApproach({ ...fp, options: fp.options.slice().reverse() })).toBeNull();
    const visibleOnly = capturePlanCountQuestion(screen(call), new Set(), 0, true)!;
    expect(visibleOnly.nativeCall).toBeUndefined();
    expect(pickCeoCountQuestion(fp, visibleOnly)).toBeNull();
    const foreign = '☐ Finding\nShould we add validation?\n❯ 1. Add fix\n  2. Defer\nEnter to select · ↑/↓ to navigate · Esc to cancel';
    const active = capturePlanCountQuestion(foreign, new Set(), 0, true, call)!;
    expect(active.nativeCall).toBeUndefined();
    expect(pickCeoCountQuestion(fp, active)).toBeNull();
  });

  test('the existing completed-review manual picker still runs after approach selection declines', () => {
    const call = structuredClone(handoffs.calls.at(-1)!) as NativePlanQuestionCall;
    call.answered = false; delete call.answers; delete call.unansweredQuestionIndices;
    const fp = fingerprint(call, false);
    const expected = pickCeoCompletionHandoff(fp);
    expect(expected).not.toBeNull();
    expect(pickCeoCountQuestion(fp)).toBe(expected);
  });

  test('both count callers use the composed picker while leaving first-scope and count predicates intact', () => {
    const caller = readFileSync(join(import.meta.dir, 'skill-e2e-plan-ceo-finding-count.test.ts'), 'utf8');
    expect(caller.match(/pickAUQ: pickCeoCountQuestion/g)).toHaveLength(2);
    expect(caller.match(/isFirstReviewAUQ: ceoFirstReviewAUQ/g)).toHaveLength(2);
    expect(caller).toContain('firstAUQPick: pickSkipInterview');
  });
});
