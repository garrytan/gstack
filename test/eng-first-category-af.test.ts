import { expect, test } from 'bun:test';
import captured from './fixtures/eng-first-category-af.json';
import { engFirstReviewAUQ, engSetupAUQ, engStep0Boundary, nativePlanCallFingerprint, planCountQuestionPhase } from './helpers/claude-pty-runner';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';

const actual = () => structuredClone(captured.fingerprint.nativeCall) as NativePlanQuestionCall;

test('actual completed Architecture issue starts review', () => {
  const fp = nativePlanCallFingerprint(actual(), 0, true);
  expect(engFirstReviewAUQ(fp)).toBe(true);
  expect(engSetupAUQ(fp)).toBe(false);
  expect(planCountQuestionPhase(fp, false, engStep0Boundary, engFirstReviewAUQ, engSetupAUQ))
    .toMatchObject({ preReview: false, reviewStarted: true });
  expect(captured.provenance.retrospectivePass).toBe(false);
});

function answer(c: NativePlanQuestionCall, index = 0) {
  c.answers = {[c.questions[0]!.question]: c.questions[0]!.options[index]!.label};
  return nativePlanCallFingerprint(c, 0, true);
}

test('all offered choices and menu orders remain substantive decisions', () => {
  for (const reverse of [false, true]) for (let index = 0; index < 3; index++) {
    const c = actual(); if (reverse) c.questions[0]!.options.reverse();
    expect(engFirstReviewAUQ(answer(c, index))).toBe(true);
  }
});

test('identifier spelling, writer order and matching issue numbers are incidental', () => {
  for (const [left, right] of [['TenantReader', 'SessionWriter'], ['Z_store', '$AStore'], ['SessionMint', 'AuthBroker']]) {
    const c = actual(); const q = c.questions[0]!;
    q.question = q.question.replace('AuthBroker and SessionMint', `${left} and ${right}`);
    expect(engFirstReviewAUQ(answer(c))).toBe(true);
  }
  for (const kind of ['Issue', 'Finding']) {
    const c = actual(); c.questions[0]!.question = c.questions[0]!.question.replace('D4 — Issue 1', `D87 — ${kind} 12.3`);
    c.questions[0]!.header = `${kind} 12.3`;
    expect(engFirstReviewAUQ(answer(c))).toBe(true);
  }
});

test('native completion, timestamp, answer and menu identity remain mandatory', () => {
  const mutations: Array<(c: NativePlanQuestionCall) => void> = [
    c => { c.answered = false; }, c => { c.failed = true; }, c => { c.answers = {}; },
    c => { c.answers = {[c.questions[0]!.question]: 'not offered'}; },
    c => { c.questions[0]!.question += ' changed'; },
    c => { c.unansweredQuestionIndices = [0]; }, c => { c.answeredAt = 'invalid'; },
    c => { c.sessionId = ''; }, c => { c.toolUseId = ''; },
    c => { c.questions[0]!.multiSelect = true; },
    c => { c.questions.push(structuredClone(c.questions[0]!)); },
    c => { c.questions[0]!.options[1]!.label = c.questions[0]!.options[0]!.label; },
  ];
  for (const mutate of mutations) {
    const c = actual(); mutate(c); expect(engFirstReviewAUQ(nativePlanCallFingerprint(c, 0, true))).toBe(false);
  }
  const fp = nativePlanCallFingerprint(actual(), 0, true);
  expect(engFirstReviewAUQ({...fp,signature:'foreign'})).toBe(false);
  expect(engFirstReviewAUQ({...fp,nativeQuestionIndex:1})).toBe(false);
  expect(engFirstReviewAUQ({...fp,options:[...fp.options].reverse()})).toBe(false);
});

test('administrative, TODO, uncertain and quoted contexts cannot borrow technical labels', () => {
  const base = actual().questions[0]!.question.split('\n')[0]!;
  const titles = [
    'D4 — Issue 1 (Architecture): Record the completed review in TODOs?',
    'D4 — Issue 1 (Architecture): Confirm that the shared cache review is complete?',
    'D4 — Issue 1 (Architecture): Which review runs next?',
    base.replace('AuthBroker and SessionMint both mutate', 'If AuthBroker and SessionMint both mutate'),
    base.replace('AuthBroker and SessionMint', 'AuthBroker and AuthBroker'),
    base.replace('with no owner and no serialization', 'with an owner and per-key serialization'),
    'Example: ' + base, '> ' + base, '```\n' + base,
    base.replace('How should shared-state access be structured?', 'Should the review report record this finding?'),
  ];
  for (const title of titles) {
    const c = actual(); c.questions[0]!.question = title;
    expect(engFirstReviewAUQ(answer(c))).toBe(false);
  }
  for (const header of ['Issue 2', 'Issue 1.2', 'TODOs', 'Setup', 'Next review']) {
    const c = actual(); c.questions[0]!.header = header;
    expect(engFirstReviewAUQ(answer(c))).toBe(false);
  }
});

test('opposed implementation choices cannot be replaced by report or workflow choices', () => {
  for (const labels of [
    ['Record in report', 'Defer the report', 'Keep the report'],
    ['Run Eng next', 'Run Design next', 'Keep reviewing manually'],
  ]) {
    const c = actual(); c.questions[0]!.options.forEach((o, i) => {o.label = labels[i]!;});
    expect(engFirstReviewAUQ(answer(c))).toBe(false);
  }
  const c = actual(); c.questions[0]!.options[0]!.description = '';
  expect(engFirstReviewAUQ(answer(c))).toBe(false);
});

test('regression evidence selects only the two affected Eng count owners', () => {
  for (const file of ['test/eng-first-category-af.test.ts', 'test/fixtures/eng-first-category-af.json']) {
    const owners = Object.entries(E2E_TOUCHFILES).filter(([, files]) => files.includes(file)).map(([owner])=>owner).sort();
    expect(owners).toEqual(['plan-eng-finding-count', 'plan-eng-multi-finding-batching']);
    expect(selectTests([file], E2E_TOUCHFILES, []).selected.sort()).toEqual(owners);
  }
});
