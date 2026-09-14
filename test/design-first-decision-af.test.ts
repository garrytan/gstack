import { expect, test } from 'bun:test';
import captured from './fixtures/design-first-decision-af.json';
import retryCaptured from './fixtures/design-first-decision-af-retry.json';
import { isDesignCountFirstReview, isDesignCountSetup } from './helpers/design-count-review';
import { designStep0Boundary, nativePlanCallFingerprint, planCountQuestionPhase } from './helpers/claude-pty-runner';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';

function call(): NativePlanQuestionCall {
  return structuredClone(captured.nativeCall) as NativePlanQuestionCall;
}
function answer(c: NativePlanQuestionCall, index = 0) {
  c.answers = { [c.questions[0]!.question]: c.questions[0]!.options[index]!.label };
  return nativePlanCallFingerprint(c, 0, true);
}

test('actual completed Make Save decision starts review before later findings', () => {
  expect(isDesignCountFirstReview(captured)).toBe(true);
  expect(planCountQuestionPhase(captured, false, designStep0Boundary,
    isDesignCountFirstReview, isDesignCountSetup)).toMatchObject({ preReview: false, reviewStarted: true });
});

test('all offered decisions, including keeping the gap, are review decisions', () => {
  for (let index = 0; index < 3; index++) {
    expect(isDesignCountFirstReview(answer(call(), index))).toBe(true);
  }
});

test('the actual retry starts at its first finding with a numbered control header', () => {
  expect(isDesignCountFirstReview(retryCaptured)).toBe(true);
  for (let i = 0; i < 3; i++) {
    const c = structuredClone(retryCaptured.nativeCall) as NativePlanQuestionCall;
    expect(isDesignCountFirstReview(answer(c, i))).toBe(true);
  }
  for (const header of ['Issue 2: Save', 'Issue 1: Reset', 'Issue 1.1: Save', 'Issue 1: Save\nMode']) {
    const c = structuredClone(retryCaptured.nativeCall) as NativePlanQuestionCall;
    c.questions[0]!.header = header;
    expect(isDesignCountFirstReview(answer(c))).toBe(false);
  }
  for (const description of ['Save already complies. Record the completed review.',
    'Save becomes the single filled primary (#1d4ed8, white text); the report describes the buttons.']) {
    const c = structuredClone(retryCaptured.nativeCall) as NativePlanQuestionCall;
    c.questions[0]!.options[0]!.description = description;
    expect(isDesignCountFirstReview(answer(c))).toBe(false);
  }
});

test('number-letter option prefixes accept whitespace and existing punctuation', () => {
  for (const separator of [' ', ') ', '. ']) {
    const c = call();
    for (const option of c.questions[0]!.options) option.label = option.label.replace(/^(1[A-C]) /, '$1' + separator);
    expect(isDesignCountFirstReview(answer(c))).toBe(true);
  }
});

test('a completed native answer remains mandatory', () => {
  for (const mutate of [
    (c: NativePlanQuestionCall) => { c.answered = false; },
    (c: NativePlanQuestionCall) => { c.failed = true; },
    (c: NativePlanQuestionCall) => { c.unansweredQuestionIndices = [0]; },
    (c: NativePlanQuestionCall) => { c.answers = {}; },
    (c: NativePlanQuestionCall) => { c.answers = { [c.questions[0]!.question]: 'unoffered answer' }; },
    (c: NativePlanQuestionCall) => { c.toolUseId = ''; },
    (c: NativePlanQuestionCall) => { c.sessionId = ''; },
  ]) {
    const c = call(); mutate(c);
    expect(isDesignCountFirstReview(nativePlanCallFingerprint(c, 0, true))).toBe(false);
  }
});

test('number, menu and event identity cannot be borrowed from another decision', () => {
  for (const mutate of [
    (c: NativePlanQuestionCall) => { c.questions[0]!.header = 'Issue 2'; },
    (c: NativePlanQuestionCall) => { c.questions[0]!.multiSelect = true; },
    (c: NativePlanQuestionCall) => { c.questions.push(structuredClone(c.questions[0]!)); },
    (c: NativePlanQuestionCall) => { c.questions[0]!.options[2]!.label = c.questions[0]!.options[0]!.label; },
  ]) {
    const c = call(); mutate(c);
    expect(isDesignCountFirstReview(answer(c))).toBe(false);
  }
  for (const mutate of [
    (f: typeof captured) => { f.signature = 'foreign'; },
    (f: typeof captured) => { f.options.reverse(); },
  ]) {
    const f = structuredClone(captured); mutate(f);
    expect(isDesignCountFirstReview(f)).toBe(false);
  }
  expect(isDesignCountFirstReview({ ...captured, nativeQuestionIndex: 1 })).toBe(false);
});

test('quoted examples and workflow-only Issue titles do not start review', () => {
  for (const title of [
    'Example: D1 — Issue 1: Make Save the visible primary action?',
    '> D1 — Issue 1: Make Save the visible primary action?',
    '```\nD1 — Issue 1: Make Save the visible primary action?',
    'D1 — Issue 1: Make outside voices available?',
    'D1 — Issue 1: Fix which review runs next?',
  ]) {
    const c = call(); c.questions[0]!.question = title;
    expect(isDesignCountFirstReview(answer(c))).toBe(false);
  }
});

test('a source citation or Keep fragment cannot replace opposed design choices', () => {
  for (const mutate of [
    (c: NativePlanQuestionCall) => { for (const o of c.questions[0]!.options) o.description = 'Read DESIGN.md before starting.'; },
    (c: NativePlanQuestionCall) => { c.questions[0]!.options[2]!.label = '1Creeps into setup'; },
    (c: NativePlanQuestionCall) => { c.questions[0]!.options[2]!.label = '1C Start reviewing'; },
  ]) {
    const c = call(); mutate(c);
    expect(isDesignCountFirstReview(answer(c))).toBe(false);
  }
});

test('a report or reviewer decision about compliant styles is administrative', () => {
  for (const [title, options] of [
    ['D1 — Issue 1: Make a report about the primary actions?', [
      { label: '1A Record the completed review', description: 'Matches DESIGN.md exactly: primary actions already use the approved styles. Write a report describing that existing result.' },
      { label: '1B Keep the current review report', description: 'Leave the existing report unchanged. No product or implementation decision remains.' },
    ]],
    ['D1 — Issue 1: Make the typography review the next step?', [
      { label: '1A Start the typography reviewer', description: 'Matches DESIGN.md exactly: the existing typography already complies. Ask another reviewer to confirm it.' },
      { label: '1B Keep reviewing manually', description: 'Continue the review without another reviewer. No design change is proposed.' },
    ]],
  ] as const) {
    const c = call();
    c.questions[0]!.question = title;
    c.questions[0]!.options = options.map(option => ({ ...option }));
    expect(isDesignCountFirstReview(answer(c))).toBe(false);
  }
});

test('the alternate primary style remedy must bind the same control and unresolved violation', () => {
  const renamed = call();
  renamed.questions[0]!.question = renamed.questions[0]!.question.replaceAll('Save', 'Submit');
  for (const option of renamed.questions[0]!.options) {
    option.label = option.label.replaceAll('Save', 'Submit');
    option.description = option.description?.replaceAll('Save', 'Submit');
  }
  expect(isDesignCountFirstReview(answer(renamed))).toBe(true);
  for (const mutate of [
    (c: NativePlanQuestionCall) => { c.questions[0]!.options[0]!.description = c.questions[0]!.options[0]!.description!.replace('Save filled', 'Reset filled'); },
    (c: NativePlanQuestionCall) => { c.questions[0]!.options[0]!.description = 'Matches DESIGN.md exactly: the existing buttons already comply. Record the result.'; },
    (c: NativePlanQuestionCall) => { c.questions[0]!.options[2]!.description = 'The current buttons already comply. No unresolved design requirement remains.'; },
  ]) {
    const c = call(); mutate(c);
    expect(isDesignCountFirstReview(answer(c))).toBe(false);
  }
});

test('the regression and retained native call select the affected live workflow', () => {
  for (const file of ['test/design-first-decision-af.test.ts', 'test/fixtures/design-first-decision-af.json', 'test/fixtures/design-first-decision-af-retry.json']) {
    expect(selectTests([file], E2E_TOUCHFILES, []).selected).toEqual(['plan-design-finding-count']);
  }
});
