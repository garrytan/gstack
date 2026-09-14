import { expect, test } from 'bun:test';
import captured from './fixtures/ceo-count-w-paired.json';
import { ceoFirstReviewAUQ, ceoStep0Boundary, nativePlanCallFingerprint, planCountQuestionPhase } from './helpers/claude-pty-runner';

test('native CEO briefs with the defect below the title start review; one batched call stays one', () => {
  let started = false;
  let count = 0;
  for (const [i, call] of captured.calls.entries()) {
    const fingerprint = nativePlanCallFingerprint(call, i, true);
    const phase = planCountQuestionPhase(fingerprint, started, ceoStep0Boundary, ceoFirstReviewAUQ);
    expect(phase.preReview).toBe(false);
    started = phase.reviewStarted;
    if (!phase.preReview) count++;
  }
  expect(count).toBe(3);
  expect(captured.calls[2].questions[0].multiSelect).toBe(true);
  expect(Object.values(captured.calls[2].answers)).toHaveLength(1);
});

test.each([0, 1])('actual body finding %i is recognized even without a previous mode answer', i => {
  expect(ceoFirstReviewAUQ(nativePlanCallFingerprint(captured.calls[i], i, true))).toBe(true);
});

test('body evidence cannot replace an answered native decision or identify a setup recap as review', () => {
  const mutations: Array<(call: typeof captured.calls[0]) => void> = [
    call => { call.answers = {}; },
    call => { call.questions[0].question = call.questions[0].question.split('\n')[0]; },
    call => { call.questions[0].question = call.questions[0].question.replace('plan-ceo-review-failure-sig', 'plan-ceo-review-approach'); },
    call => { call.questions[0].header = 'Approach'; },
    call => { call.questions[0].header = 'Next steps'; },
    call => { call.questions[0].options[0].label = 'HOLD SCOPE (Recommended)'; },
    call => { call.questions[0].question = call.questions[0].question.replace(/<gstack-qid:[^>]+>/, ''); },
    call => { call.questions[0].question = call.questions[0].question.replace('D1 —', 'Context:'); },
  ];
  for (const mutate of mutations) {
    const call = structuredClone(captured.calls[0]);
    const originalQuestion = call.questions[0].question;
    mutate(call);
    if (call.questions[0].question !== originalQuestion) {
      call.answers = { [call.questions[0].question]: Object.values(call.answers)[0] };
    }
    expect(ceoFirstReviewAUQ(nativePlanCallFingerprint(call, 0, true)), JSON.stringify(call)).toBe(false);
  }
});

test.each([
  'ELI10: The plan has no missing requirements or unspecified behavior. This is a readiness check.',
  'ELI10: The previous plan had missing tests. Those gaps are resolved and the current plan is complete. Start the review now?',
  'ELI10: Here is a quotation from the training example, not a current finding:\n> The plan has missing tests.\n\nContinue to the review?',
  'ELI10: Training example: "The plan does not specify the failure contract." The current plan is complete; this is only a readiness check.',
  'ELI10: Training example: “The plan does not specify the failure contract.” The current plan is complete.',
  'ELI10: Training example: `The plan does not specify the failure contract.` The current plan is complete.',
  'ELI10: Training example:\n```text\nThe plan does not specify the failure contract.\n```\nThe current plan is complete.',
  'ELI10: Training example:\n~~~text\nThe plan does not specify the failure contract.\n~~~\nThe current plan is complete.',
  'ELI10: If the plan does not specify the failure contract, we would add it. The current plan already specifies it; this is a readiness check.',
  'ELI10: It is not true that the plan does not specify the failure contract. The current plan is complete.',
])('negated, resolved and quoted gaps do not start review: %s', body => {
  const call = structuredClone(captured.calls[0]);
  call.questions[0].question = 'D1 — Ready to continue? <gstack-qid:plan-ceo-review-readiness>\n\n' + body;
  // Even a plan-amendment option cannot turn a quotation or closed issue into
  // evidence of a current defect. Retain the actual offered/answered option.
  call.answers = { [call.questions[0].question]: call.questions[0].options[0].label };
  expect(ceoFirstReviewAUQ(nativePlanCallFingerprint(call, 0, true))).toBe(false);
});

test('a current omission mentioned during setup needs an actual remedy choice', () => {
  const call = structuredClone(captured.calls[0]);
  call.questions[0].options = [
    {label:'Start review', description:'Begin the existing review workflow.'},
    {label:'Pause', description:'Wait before beginning.'},
  ];
  call.answers = { [call.questions[0].question]: 'Start review' };
  expect(ceoFirstReviewAUQ(nativePlanCallFingerprint(call, 0, true))).toBe(false);
});
