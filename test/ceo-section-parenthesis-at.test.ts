import { expect, test } from 'bun:test';
import { ceoFirstReviewAUQ, ceoStep0Boundary, nativePlanCallFingerprint, planCountQuestionPhase } from './helpers/claude-pty-runner';
import { E2E_TOUCHFILES } from './helpers/touchfiles-data';
import captured from './fixtures/ceo-section-parenthesis-at.json';
const call = (): any => structuredClone(captured.calls[1]);
const fp = (value: any) => nativePlanCallFingerprint(value, 0, true);
const matches = (value: any) => ceoFirstReviewAUQ(fp(value));
function edit(value: any, change: (text: string) => string) {
  const q = value.questions[0], answer = value.answers[q.question];
  q.question = change(q.question); value.answers = { [q.question]: answer };
}
test('the exact completed combined section/finding brief opens the retry review', () => {
  const value = call(); expect(matches(value)).toBe(true); expect(value).toEqual(captured.calls[1]);
  let started = false;
  const phases = captured.calls.map(value => {
    const phase = planCountQuestionPhase(fp(value), started, ceoStep0Boundary, ceoFirstReviewAUQ);
    started = phase.reviewStarted; return phase.preReview;
  });
  expect(phases).toEqual([true, false, false, false, false, false, false]);
});
test('decision, section, finding and descriptive header retain separate identities', () => {
  for (const change of [
    (text: string) => text.replace(/^D4/, 'D19'),
    (text: string) => text.replace('Section 1, finding 1', 'Section 7, finding 1').replace('review-s1-', 'review-s7-'),
    (text: string) => text.replace(') — ', ') - '),
  ]) { const value = call(); edit(value, change); expect(matches(value)).toBe(true); }
  for (const header of ['Receipt rescue', 'Error contract', 'Finding 1', 'Issue 1', 'Section 1', 'Section 1 finding 1']) {
    const value = call(); value.questions[0].header = header; expect(matches(value)).toBe(true);
  }
  for (const option of call().questions[0].options) {
    const value = call(); value.answers[value.questions[0].question] = option.label; expect(matches(value)).toBe(true);
  }
});
test('conflicting annotation, qid, header and option identities cannot open review', () => {
  for (const change of [
    (text: string) => text.replace('Section 1, finding 1', 'Section 0, finding 1'),
    (text: string) => text.replace('Section 1, finding 1', 'Section 1, finding 0'),
    (text: string) => text.replace('Section 1, finding 1', 'Section 1, finding 2'),
    (text: string) => text.replace('review-s1-', 'review-s9-'),
    (text: string) => text.replace('plan-ceo-review-s1-', 'plan-eng-review-s1-'),
    (text: string) => text.replace('Section 1, finding 1', 'Section 1, hypothetical finding 1'),
    (text: string) => text.replace(/^Recommendation: 1A/m, 'Recommendation: 9A'),
    (text: string) => text + '\n<gstack-qid:plan-ceo-review-s1-other>',
  ]) { const value = call(); edit(value, change); expect(matches(value)).toBe(false); }
  for (const header of ['Finding 9', 'Finding one', 'Issue 9', 'Section 9', 'Section 1 finding 9', 'Section one', 'Approach']) {
    const value = call(); value.questions[0].header = header; expect(matches(value)).toBe(false);
  }
});
test('only current owned assessments and offered amendments supply coverage', () => {
  for (const change of [
    (text: string) => 'Example: ' + text,
    (text: string) => '> ' + text,
    (text: string) => '```\n' + text + '\n```',
    (text: string) => text.replace('\nProject/branch/task:', '\nSource:\nProject/branch/task:'),
    (text: string) => text.replace('Project/branch/task: ', 'Project/branch/task: If approved, '),
    (text: string) => text.replace(/^ELI10: /m, 'ELI10: If approved, '),
    (text: string) => text.replace(/^ELI10: (.+)$/m, 'ELI10: "$1"'),
    (text: string) => text.replace(/^ELI10: .+$/m, 'ELI10: This handler has no current defect and needs no amendment.'),
    (text: string) => text + '\nThis finding is withdrawn.',
    (text: string) => text + '\nThis finding is "withdrawn".',
    (text: string) => text + '\nThis finding is no longer current.',
  ]) { const value = call(); edit(value, change); expect(matches(value)).toBe(false); }
  for (const prefix of ['Source: ', 'If approved, ', 'This remedy is withdrawn. ']) {
    const value = call(); value.questions[0].options.forEach((option: any) => { option.description = prefix + option.description; });
    expect(matches(value)).toBe(false);
  }
  const history = call(); edit(history, text => text + '\nOld note: "This finding is withdrawn."'); expect(matches(history)).toBe(true);
});
test('native completion and exact same-call options remain required', () => {
  for (const change of [
    (value: any) => { value.answered = false; },
    (value: any) => { value.failed = true; },
    (value: any) => { value.sessionId = ''; },
    (value: any) => { value.toolUseId = ''; },
    (value: any) => { value.answeredAt = 'invalid'; },
    (value: any) => { value.unansweredQuestionIndices = [0]; },
    (value: any) => { value.answers = {}; },
    (value: any) => { value.answers[value.questions[0].question] = 'Foreign answer'; },
    (value: any) => { value.questions[0].multiSelect = true; },
    (value: any) => { value.questions.push(structuredClone(value.questions[0])); },
    (value: any) => { value.questions[0].options[1].description = ''; },
    (value: any) => { value.questions[0].options[1].label = '9B: Foreign amendment'; },
  ]) { const value = call(); change(value); expect(matches(value)).toBe(false); }
  const original = fp(call());
  for (const value of [{ ...original, signature: 'foreign:call' }, { ...original, nativeCall: undefined },
    { ...original, nativeQuestionIndex: 1 }, { ...original, options: original.options.slice(1) }]) expect(ceoFirstReviewAUQ(value)).toBe(false);
});
test('new public artifacts select only CEO finding count', () => {
  for (const file of ['test/ceo-section-parenthesis-at.test.ts', 'test/fixtures/ceo-section-parenthesis-at.json'])
    expect(Object.entries(E2E_TOUCHFILES).filter(([, paths]) => paths.includes(file)).map(([name]) => name)).toEqual(['plan-ceo-finding-count']);
});
