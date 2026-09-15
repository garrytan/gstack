import { describe, expect, test } from 'bun:test';
import captured from './fixtures/devex-review-o-calls.json';
import retry from './fixtures/devex-output-o-retry-call.json';
import { isDevexReviewIssue } from './helpers/devex-count-fixture';
import { nativePlanCallFingerprint } from './helpers/claude-pty-runner';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
import { E2E_TOUCHFILES } from './helpers/touchfiles';

const calls = () => structuredClone(captured.calls) as NativePlanQuestionCall[];
const fp = (call: NativePlanQuestionCall) => nativePlanCallFingerprint(call, 0, true);
describe('documented expected-output gaps are substantive DX decisions', () => {
  test('all eleven actual O calls retain two setup and nine substantive decisions', () => {
    const original=calls();
    expect(original.map(call=>isDevexReviewIssue(fp(call)))).toEqual([false,false,true,true,true,true,true,true,true,true,true]);
    expect(original).toEqual(calls());
    // The later migration note and demo exemption are additional offered
    // changes, not retroactively included in earlier selected options.
    expect(original[3]!.answers![original[3]!.questions[0]!.question]).toContain('EVALKIT_SKIP_CI_CHECK');
    expect(original[10]!.questions[0]!.header).toBe('TODO: Demo CI exemption');
  });

  test('the actual README output decision is counted before or after the review boundary', () => {
    const fingerprint=fp(calls()[7]!);fingerprint.promptSnippet='Short diagnostic text';
    for(const preReview of [true,false])expect(isDevexReviewIssue({...fingerprint,preReview})).toBe(true);
  });

  test('equivalent output-documentation gaps do not depend on an issue number', () => {
    for(const question of [
      'The quickstart has no expected output, so developers cannot recognize a successful run.',
      'Expected output is absent from the documentation. Add an example of a successful command?',
      'The README does not show the output to expect. Should we document the success signal?',
    ]) {
      const call=calls()[7]!;call.questions[0]!.header='Documentation gap';call.questions[0]!.question=question;
      call.answers={[question]:call.questions[0]!.options[0]!.label};expect(isDevexReviewIssue(fp(call))).toBe(true);
    }
  });

  test('missing answers, confirmation-only options and references to working output do not count', () => {
    const actual=calls()[7]!;
    for(const mutate of [
      (call:NativePlanQuestionCall)=>{call.answered=false;},
      (call:NativePlanQuestionCall)=>{call.answers={};},
      (call:NativePlanQuestionCall)=>{call.questions[0]!.header='Empathy check';},
      (call:NativePlanQuestionCall)=>{call.questions[0]!.options=[{label:'Read the documentation'},{label:'Continue the review'}];},
      (call:NativePlanQuestionCall)=>{const q=call.questions[0]!;q.question='The README already documents the expected output. Which file should I inspect next?';call.answers={[q.question]:q.options[0]!.label};},
      (call:NativePlanQuestionCall)=>{const q=call.questions[0]!;q.question='Which documentation should I inspect next?';call.answers={[q.question]:q.options[0]!.label};},
    ]) {const call=structuredClone(actual);mutate(call);expect(isDevexReviewIssue(fp(call))).toBe(false);}
    const partial=calls()[1]!;partial.questions.push(actual.questions[0]!);partial.unansweredQuestionIndices=[1];
    expect(isDevexReviewIssue(fp(partial))).toBe(false);
  });

  test('the actual retry sample-demo output proposal is the same documentation gap', () => {
    const call=structuredClone(retry.call) as NativePlanQuestionCall;
    expect(isDevexReviewIssue(fp(call))).toBe(true);
    expect(call.questions[0]!.options[0]!.label).toContain('Add to plan: include sample demo output in README');
    for (const question of [
      'The README shows no example output, so success is unspecified.',
      'Sample demo output is missing from the quickstart documentation.',
    ]) {const next=structuredClone(call);next.questions[0]!.question=question;next.answers={[question]:next.questions[0]!.options[0]!.label};expect(isDevexReviewIssue(fp(next))).toBe(true);}
    for (const question of [
      'The README already shows sample demo output. Which documentation should I read next?',
      'Should we inspect example output in the README?',
      'README expected output is not missing.',
      'README already shows expected output; the missing item is a changelog.',
      'No expected output is missing from README.',
      'The README has no missing expected output. Should we show another example?',
      'No sample demo output is missing from README. Should we show another example?',
    ]) {const next=structuredClone(call);next.questions[0]!.question=question;next.answers={[question]:next.questions[0]!.options[0]!.label};expect(isDevexReviewIssue(fp(next))).toBe(false);}
    call.questions[0]!.options=[{label:'Read the README'},{label:'Continue the review'}];
    expect(isDevexReviewIssue(fp(call))).toBe(false);
  });

  test('the captured documentation regression remains a paid dependency', () => {
    for(const file of ['test/devex-output-o.test.ts','test/fixtures/devex-review-o-calls.json','test/fixtures/devex-output-o-retry-call.json'])
      expect(E2E_TOUCHFILES['plan-devex-finding-count']).toContain(file);
  });
});
