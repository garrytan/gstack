import { describe, expect, test } from 'bun:test';
import { nativePlanCallFingerprint } from './helpers/claude-pty-runner';
import { isDevexReviewIssue } from './helpers/devex-count-fixture';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
import recorded from './fixtures/devex-empathy-ab-calls.json';

const calls = () => structuredClone(recorded) as NativePlanQuestionCall[];
const classify = (call: NativePlanQuestionCall) => isDevexReviewIssue(nativePlanCallFingerprint(call, 0, true));
function changeQuestion(call: NativePlanQuestionCall, transform: (text: string) => string): void {
  const q = call.questions[0]!;
  const answer = call.answers![q.question]!;
  q.question = transform(q.question);
  call.answers = { [q.question]: answer };
}

describe('DX delimited empathy accuracy confirmation', () => {
  test('the seven completed AB calls are two setup confirmations and five issue decisions', () => {
    expect(calls().map(classify)).toEqual([false, false, true, true, true, true, true]);
  });

  test('accuracy and correction choices do not approve the defects described in the trace', () => {
    for (const answer of calls()[1]!.questions[0]!.options.map(o => o.label)) {
      const c = calls()[1]!;
      c.answers = { [c.questions[0]!.question]: answer };
      c.questions[0]!.options.reverse();
      changeQuestion(c, text => text.replaceAll('EvalKit', 'RenderKit').replace('Python ML engineer', 'TypeScript frontend developer'));
      expect(classify(c)).toBe(false);
    }
  });

  test('extra obligations outside the delimited journey are still substantive', () => {
    for (const transform of [
      (s: string) => s.replace('Does this match reality?', 'Does this match reality? Also package the missing example.'),
      (s: string) => s.replace("Here's what I think", "Package the missing example. Here's what I think"),
      (s: string) => s.replace('Does this match reality?', 'Should we fix the missing example? Does this match reality?'),
      (s: string) => s.replace('your actual developer experience?', 'your actual developer experience and approve packaging the example?'),
      (s: string) => s.replace(/\n\n---\n\nDoes this match reality\?$/, '\n\n---\n\nRemove the CI gate.\n\nDoes this match reality?'),
      (s: string) => s.replace(/\n\n---\n\nDoes this match reality\?$/, '\n\nDoes this match reality?'),
    ]) { const c = calls()[1]!; changeQuestion(c, transform); expect(classify(c)).toBe(true); }
  });

  test('delimiters cannot hide remedy paragraphs or appended decision clauses', () => {
    for (const extra of [
      'Should we remove the CI gate?',
      'Remove the CI gate.',
      'I recommend packaging the missing example. Do you approve?',
      'I approve removing the CI gate; please apply that change.',
      'I look at the package. Should we add the missing example?',
      'I run the demo; remove the CI gate.',
      'I got results. We should package the missing example.',
      'I found the CI gate. Please disable it.',
      'I see the missing example. I decide to package it.',
      'I got results. We will remove the CI gate.',
      "I check the package. Let's add the missing example.",
      'I see the missing example. Please update the README.',
      'I see the missing example. The plan must include it.',
      'I see the CI gate. Ship a local escape hatch.',
      'I see the CI gate; Update the documentation.',
      'I look at the README. Provide a working command.',
    ]) {
      for (const separator of ['\n\n', ' ']) {
        const c = calls()[1]!;
        changeQuestion(c, text => text.replace(/\n\n---\n\nDoes this match reality\?$/,
          separator + extra + '\n\n---\n\nDoes this match reality?'));
        expect(classify(c)).toBe(true);
      }
    }
  });

  test('a remedy inside an option cannot borrow an accuracy label', () => {
    for (const mutate of [
      (c: NativePlanQuestionCall) => { c.questions[0]!.options[0]!.description += ' Remove the CI gate.'; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.options[1]!.description += ' Package the missing example.'; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.options.push({ label: 'Package the missing example', description: 'Fix the documented quickstart.' }); },
      (c: NativePlanQuestionCall) => { c.questions[0]!.options[0]!.label += ' and remove the CI gate'; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.options[1]!.label = 'Partially wrong — fix the missing example'; },
    ]) {
      const c = calls()[1]!; mutate(c);
      c.answers = { [c.questions[0]!.question]: c.questions[0]!.options[0]!.label };
      expect(classify(c)).toBe(true);
    }
  });

  test('a second answered finding remains one substantive native call', () => {
    const c = calls()[1]!; const issue = calls()[2]!;
    c.questions.push(...issue.questions);
    Object.assign(c.answers!, issue.answers);
    expect(classify(c)).toBe(true);
    delete c.answers![issue.questions[0]!.question];
    c.unansweredQuestionIndices = [1];
    expect(classify(c)).toBe(false);
  });
});
