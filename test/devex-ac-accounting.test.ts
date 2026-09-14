import { describe, expect, test } from 'bun:test';
import { nativePlanCallFingerprint } from './helpers/claude-pty-runner';
import { isDevexReviewIssue } from './helpers/devex-count-fixture';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
import captured from './fixtures/devex-ac-first-attempt-calls.json';

const calls = () => structuredClone(captured) as NativePlanQuestionCall[];
const classify = (call: NativePlanQuestionCall) => isDevexReviewIssue(nativePlanCallFingerprint(call, 0, true));
function changeQuestion(call: NativePlanQuestionCall, transform: (text: string) => string): void {
  const q = call.questions[0]!;
  const answer = call.answers![q.question]!;
  q.question = transform(q.question);
  call.answers = { [q.question]: answer };
}

describe('AC DX accounting preserves all accepted obligations', () => {
  test('D4 confirms accuracy, D12 approves a real repair, and the failed attempt still contains eight issues', () => {
    const actual = calls().map(classify);
    expect(actual).toEqual([false, false, false, false, true, true, true, true, true, true, false, true, true]);
    expect(actual.filter(Boolean)).toHaveLength(8);
    expect(actual.filter(Boolean).length).toBeGreaterThan(7);
  });

  test('all three accuracy/correction choices and their order remain observational', () => {
    for (const option of calls()[3]!.questions[0]!.options) {
      const c = calls()[3]!;
      c.answers = { [c.questions[0]!.question]: option.label };
      c.questions[0]!.options.reverse();
      changeQuestion(c, text => text.replaceAll('EvalKit', 'RenderKit').replaceAll('ML engineer', 'backend developer'));
      expect(classify(c)).toBe(false);
    }
  });

  test('the structured frame cannot hide a request in any of its sections', () => {
    const obligations = [
      'Should we remove the CI gate?', 'Remove the CI gate.',
      'I recommend packaging the missing example. Do you approve?',
      'I approve removing the CI gate; please apply that change.',
      'I see the missing example. Please update the README.',
      'I see the missing example. The plan must include it.',
      'I see the CI gate. Ship a local escape hatch.',
      'I look at the README. Provide a working command.',
    ];
    for (const extra of obligations) for (const where of ['headline', 'preamble', 'body', 'closing']) {
      const c = calls()[3]!;
      changeQuestion(c, text => {
        if (where === 'headline') return text.replace('today?', `today? ${extra}`);
        if (where === 'preamble') return text.replace('\n\nNARRATIVE', ` ${extra}\n\nNARRATIVE`);
        if (where === 'body') return text.replace('I open the README.', `I open the README. ${extra}`);
        return text + ` ${extra}`;
      });
      expect(classify(c), `${where}: ${extra}`).toBe(true);
    }
    for (const extra of [', remove the CI gate', ' and ship a local escape hatch', '; the plan must include a keyless path']) {
      const c = calls()[3]!;
      changeQuestion(c, text => text.replace('I open the README.', `I open the README${extra}.`));
      expect(classify(c)).toBe(true);
    }
  });

  test('each full option description, title, and frame boundary is required', () => {
    for (const mutate of [
      (c: NativePlanQuestionCall) => { c.questions[0]!.options[0]!.description += ' Remove the CI gate.'; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.options[1]!.description += ' Please update the README.'; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.options[2]!.description += ' The plan must package the example.'; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.options[0]!.label += ' and ship now'; },
      (c: NativePlanQuestionCall) => { delete c.questions[0]!.options[0]!.description; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.options.push({label: 'Fix the CI gate', description: 'Approve the repair.'}); },
      (c: NativePlanQuestionCall) => { c.questions[0]!.header = 'CI gate'; },
      (c: NativePlanQuestionCall) => changeQuestion(c, text => text.replace('NARRATIVE (', 'PROPOSAL (')),
      (c: NativePlanQuestionCall) => changeQuestion(c, text => text.replace('Recommendation: A because every step', 'Recommendation: A because we should fix every step')),
    ]) {
      const c = calls()[3]!; mutate(c);
      c.answers = { [c.questions[0]!.question]: c.questions[0]!.options[0]!.label };
      expect(classify(c)).toBe(true);
    }
  });

  test('a second answered issue stays substantive while a pending issue contributes no coverage', () => {
    const c = calls()[3]!; const issue = calls()[4]!;
    c.questions.push(...issue.questions); Object.assign(c.answers!, issue.answers);
    expect(classify(c)).toBe(true);
    delete c.answers![issue.questions[0]!.question]; c.unansweredQuestionIndices = [1];
    expect(classify(c)).toBe(false);
  });

  test('the accepted keyless-demo obligation is independent of option position and score', () => {
    const c = calls()[11]!;
    c.questions[0]!.options.reverse();
    changeQuestion(c, text => text.replace('3/10 today', '5/10 today').replaceAll('EVALKIT_API_KEY', 'RENDERKIT_API_KEY'));
    expect(classify(c)).toBe(true);
  });

  test('pending, failed, unbound, unselected and quoted keyless-demo proposals supply no accepted-obligation credit', () => {
    for (const mutate of [
      (c: NativePlanQuestionCall) => { c.answered = false; },
      (c: NativePlanQuestionCall) => { c.failed = true; },
      (c: NativePlanQuestionCall) => { delete c.failed; },
      (c: NativePlanQuestionCall) => { c.unansweredQuestionIndices = [0]; },
      (c: NativePlanQuestionCall) => { delete c.unansweredQuestionIndices; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.multiSelect = true; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.header = 'Review mode'; },
      (c: NativePlanQuestionCall) => { c.answers = { [c.questions[0]!.question]: c.questions[0]!.options[1]!.label }; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.options[0]!.description = 'Confirm that the demo already works without a key.'; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.options.push(structuredClone(c.questions[0]!.options[0]!)); },
      (c: NativePlanQuestionCall) => changeQuestion(c, text => '> ' + text),
      (c: NativePlanQuestionCall) => changeQuestion(c, text => text.replace('should the golden path', 'should not the golden path')),
      (c: NativePlanQuestionCall) => changeQuestion(c, text => text.replace('reads install, set', 'does not read install, set')),
      (c: NativePlanQuestionCall) => changeQuestion(c, text => text + ' <gstack-qid:review-mode>'),
    ]) { const c = calls()[11]!; mutate(c); expect(classify(c)).toBe(false); }
    const fp = nativePlanCallFingerprint(calls()[11]!, 0, true);
    expect(isDevexReviewIssue({ ...fp, signature: 'foreign:call' })).toBe(false);
    expect(isDevexReviewIssue({ ...fp, options: [] })).toBe(false);
    expect(isDevexReviewIssue({ ...fp, nativeCall: undefined })).toBe(false);
  });
});
