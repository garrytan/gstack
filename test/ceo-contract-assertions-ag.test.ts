import { expect, test } from 'bun:test';
import captured from './fixtures/ceo-contract-assertions-ag.json';
import retry from './fixtures/ceo-contract-assertions-ag-retry.json';
import { ceoFirstReviewAUQ, ceoStep0Boundary, nativePlanCallFingerprint, planCountQuestionPhase } from './helpers/claude-pty-runner';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';

const calls = () => structuredClone(captured.calls) as NativePlanQuestionCall[];
const fp = (call: NativePlanQuestionCall) => nativePlanCallFingerprint(call, 0, true);
function reanswer(call: NativePlanQuestionCall) {
  call.answers = { [call.questions[0]!.question]: call.questions[0]!.options[0]!.label };
  return call;
}

test('actual declarative assertion defects start review after routing and approach', () => {
  let started = false;
  const counts = { setup: 0, review: 0 };
  for (const call of calls()) {
    const phase = planCountQuestionPhase(fp(call), started, ceoStep0Boundary, ceoFirstReviewAUQ);
    started = phase.reviewStarted;
    counts[phase.preReview ? 'setup' : 'review']++;
  }
  expect(counts).toEqual({ setup: 2, review: 2 });
  for (const call of calls().slice(2)) expect(ceoFirstReviewAUQ(fp(call))).toBe(true);
  // Correct classification cannot retroactively complete the original paid run.
  expect(captured.observedOutcome).toBe('no_review_questions');
  expect(captured.observedReviewCount).toBe(0);
});

test('assertion briefs still require completed native identity and their actual remedy', () => {
  for (const original of calls().slice(2)) {
    for (const mutate of [
      (c: NativePlanQuestionCall) => { c.answered = false; },
      (c: NativePlanQuestionCall) => { c.failed = true; },
      (c: NativePlanQuestionCall) => { c.answers = {}; },
      (c: NativePlanQuestionCall) => { c.unansweredQuestionIndices = [0]; },
      (c: NativePlanQuestionCall) => { c.questions.push(structuredClone(c.questions[0]!)); },
      (c: NativePlanQuestionCall) => { c.questions[0]!.header = 'Issue 99'; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.header = 'Approach'; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.question = c.questions[0]!.question.replace(/Recommendation: \d[A-Z]/, 'Recommendation: 99Z'); },
      (c: NativePlanQuestionCall) => { c.questions[0]!.options.forEach((o, i) => { o.label = `${i + 1}A) Keep`; o.description = 'Keep the saved report.'; }); },
    ]) {
      const call = structuredClone(original); mutate(call);
      if (call.answers && Object.keys(call.answers).length) reanswer(call);
      expect(ceoFirstReviewAUQ(fp(call))).toBe(false);
    }
    expect(ceoFirstReviewAUQ({ ...fp(original), signature: 'foreign:call' })).toBe(false);
    expect(ceoFirstReviewAUQ({ ...fp(original), options: [] })).toBe(false);
  }
});

test('historical, hypothetical, quoted and withdrawn assertion problems are not current findings', () => {
  for (const original of calls().slice(2)) {
    for (const prefix of ['If ', 'Example: ', 'Whether ', 'Unless ']) {
      const call = structuredClone(original);
      call.questions[0]!.question = call.questions[0]!.question.replace(/(Issue \d+: )/, `$1${prefix}`);
      expect(ceoFirstReviewAUQ(fp(reanswer(call)))).toBe(false);
    }
    for (const replacement of [
      'test 2 can detect all retry or backoff regressions',
      'test 2 previously could not detect retry or backoff regressions',
      'test 1 does not accept any truthy value as a correct receipt',
      '"test 2 cannot detect retry or backoff regressions"',
    ]) {
      const call = structuredClone(original);
      call.questions[0]!.question = call.questions[0]!.question.replace(/(Issue \d+: )[^\n]+/, `$1${replacement}`);
      expect(ceoFirstReviewAUQ(fp(reanswer(call)))).toBe(false);
    }
    const withdrawn = structuredClone(original);
    withdrawn.questions[0]!.question = withdrawn.questions[0]!.question.replace(/(ELI10:[^\n]+)/, '$1 No current defect exists.');
    expect(ceoFirstReviewAUQ(fp(reanswer(withdrawn)))).toBe(false);
  }
});

test('the captured assertion regression selects the existing CEO count eval', () => {
  for (const file of ['test/ceo-contract-assertions-ag.test.ts', 'test/fixtures/ceo-contract-assertions-ag.json']) {
    expect(selectTests([file], E2E_TOUCHFILES).selected).toContain('plan-ceo-finding-count');
  }
});


test('actual retry contract wording recognizes its first repair and counts three review decisions', () => {
  let started = false;
  const counts = { setup: 0, review: 0 };
  for (const call of structuredClone(retry.calls) as NativePlanQuestionCall[]) {
    const phase = planCountQuestionPhase(fp(call), started, ceoStep0Boundary, ceoFirstReviewAUQ);
    started = phase.reviewStarted;
    counts[phase.preReview ? 'setup' : 'review']++;
  }
  expect(counts).toEqual({ setup: 2, review: 3 });
  for (const original of retry.calls.slice(2, 4)) {
    const call = structuredClone(original) as NativePlanQuestionCall;
    expect(ceoFirstReviewAUQ(fp(call))).toBe(true);
    call.answers = { [call.questions[0]!.question]: call.questions[0]!.options.at(-1)!.label };
    expect(ceoFirstReviewAUQ(fp(call))).toBe(true);
  }
  expect(retry.observedOutcome).toBe('no_review_questions');
  expect(retry.observedReviewCount).toBe(0);
  expect(selectTests(['test/fixtures/ceo-contract-assertions-ag-retry.json'], E2E_TOUCHFILES).selected).toContain('plan-ceo-finding-count');
});

test('already complete assertions and layout-only choices do not invent a defect', () => {
  const cases = [
    [2, 'D2 — Issue 1: test 2 cannot detect retry regressions (historical assessment)', 'The assertion gap was fixed yesterday. The current test pins the retry count and delay; this choice only arranges the already complete tests.'],
    [3, 'D3 — Issue 2: test 1 accepts any truthy value as specified by its success contract', 'The contract intentionally accepts every truthy success marker. The current assertion covers the contract completely; this choice only arranges the existing test.'],
  ] as const;
  for (const [index, title, explanation] of cases) {
    const call = calls()[index]!;
    const q = call.questions[0]!;
    q.question = `${title}\nELI10: ${explanation}\nRecommendation: A`;
    q.options = [{ label: 'A) Use a table-driven layout', description: 'Use a table-driven layout for the existing assertions.' }, { label: 'B) Keep the existing layout', description: 'Keep the existing assertions in place.' }];
    expect(ceoFirstReviewAUQ(fp(reanswer(call)))).toBe(false);
  }
});

test('retry assertion brief keeps native identity, exact contract and repair requirements', () => {
  for (const original of retry.calls.slice(2, 4)) {
    for (const mutate of [
      (c: NativePlanQuestionCall) => { c.answered = false; },
      (c: NativePlanQuestionCall) => { c.failed = true; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.header = 'Finding 99'; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.question = 'Example: ' + c.questions[0]!.question; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.question = c.questions[0]!.question.replace('but the contract is', 'but there is no contract for'); },
      (c: NativePlanQuestionCall) => { c.questions[0]!.question = c.questions[0]!.question.replace(/^ELI10:.*$/m, 'ELI10: The current assertion covers the contract completely.'); },
      (c: NativePlanQuestionCall) => { c.questions[0]!.question = c.questions[0]!.question.replace('Fix the assertion?', 'Save the report?'); },
      (c: NativePlanQuestionCall) => { c.questions[0]!.options.forEach(o => { o.label = o.label.replace(/\).*/, ') Use the existing layout'); o.description = 'Use the existing layout.'; }); },
    ]) {
      const call = structuredClone(original) as NativePlanQuestionCall;
      mutate(call);
      expect(ceoFirstReviewAUQ(fp(reanswer(call)))).toBe(false);
    }
  }
});


test('one offered option must repair the assertion rather than borrow report and layout actions', () => {
  for (const original of [...captured.calls.slice(2), ...retry.calls.slice(2, 4)]) {
    for (const administrative of ['Verify the saved report', 'Assert the full report', 'Pin the exact saved plan', 'Verify the expected layout']) {
      const call = structuredClone(original) as NativePlanQuestionCall;
      const q = call.questions[0]!;
      const prefix = /^([1-9]\d*)?[A-Z]/.exec(q.options[0]!.label)![1] ?? '';
      q.options = [
        { label: `${prefix}A) ${administrative}`, description: administrative + '.' },
        { label: `${prefix}B) Use a table-driven layout`, description: 'Use a table-driven layout for the existing assertions.' },
      ];
      expect(ceoFirstReviewAUQ(fp(reanswer(call)))).toBe(false);
    }
  }
});


test('administrative report qualifiers cannot strengthen the unchanged assertion clause', () => {
  for (const suffix of [' and include a full report.', '; write an exact report.', '. Save the complete plan.']) {
    const call = calls()[2]!;
    const q = call.questions[0]!;
    q.options = [
      { label: '1A) Assert the error class only', description: 'Assert the error class only' + suffix },
      { label: '1B) Keep the current test', description: 'Leave the current rejection-only assertion unchanged.' },
    ];
    expect(ceoFirstReviewAUQ(fp(reanswer(call)))).toBe(false);
  }
});


test('each assertion clause owns its strong qualifier and actual assertion target', () => {
  for (const suffix of [' and verify the full report.', ' and check the full report.', ' with a full report.', ' with a complete saved plan.']) {
    const call = calls()[2]!;
    call.questions[0]!.options = [
      { label: '1A) Assert the error class only', description: 'Assert the error class only' + suffix },
      { label: '1B) Keep the current test', description: 'Leave the current rejection-only assertion unchanged.' },
    ];
    expect(ceoFirstReviewAUQ(fp(reanswer(call)))).toBe(false);
  }
  for (const description of ['Assert the rejection class and exactly two Stripe attempts.', 'Assert the error class only and assert exactly two Stripe attempts.']) {
    const call = calls()[2]!;
    call.questions[0]!.options[0]!.label = '1A) Strengthen the assertions';
    call.questions[0]!.options[0]!.description = description;
    call.questions[0]!.options = [call.questions[0]!.options[0]!, { label: '1B) Keep the current test', description: 'Leave the rejection-only assertion unchanged.' }];
    expect(ceoFirstReviewAUQ(fp(reanswer(call)))).toBe(true);
  }
});
