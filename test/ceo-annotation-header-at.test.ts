import { expect, test } from 'bun:test';
import { ceoFirstReviewAUQ, ceoStep0Boundary, nativePlanCallFingerprint, planCountQuestionPhase } from './helpers/claude-pty-runner';
import { E2E_TOUCHFILES } from './helpers/touchfiles-data';
import captured from './fixtures/ceo-annotation-header-at.json';

const call = (): any => structuredClone(captured.calls[2]);
const fp = (value: any) => nativePlanCallFingerprint(value, 0, true);
const matches = (value: any) => ceoFirstReviewAUQ(fp(value));
function edit(value: any, change: (text: string) => string) {
  const q = value.questions[0], answer = value.answers[q.question];
  q.question = change(q.question);
  value.answers = { [q.question]: answer };
}

test('the exact completed section-annotated mail rescue finding opens review', () => {
  const original = call();
  expect(matches(original)).toBe(true);
  expect(original).toEqual(captured.calls[2]);
  let started = false;
  const phases = captured.calls.map(value => {
    const phase = planCountQuestionPhase(fp(value), started, ceoStep0Boundary, ceoFirstReviewAUQ);
    started = phase.reviewStarted;
    return phase.preReview;
  });
  expect(phases).toEqual([true, true, false, false, false, false, false, false]);
});

test('descriptive headers and matching finding renames preserve the same rich decision', () => {
  for (const header of ['Email rescue', 'Mail failure', 'Receipt retry', 'Finding 2', 'Issue 2', 'F2 rescue']) {
    const value = call(); value.questions[0].header = header;
    expect(matches(value)).toBe(true);
  }
  for (const label of call().questions[0].options.map((option: any) => option.label)) {
    const value = call(); value.answers[value.questions[0].question] = label;
    expect(matches(value)).toBe(true);
  }
  const renamed = call();
  edit(renamed, text => text.replace('Finding 2 (Section 2', 'Finding 9 (Section 2')
    .replace(/^Recommendation: 2A/m, 'Recommendation: 9A'));
  renamed.questions[0].options.forEach((option: any) => { option.label = option.label.replace(/^2/, '9'); });
  renamed.answers = { [renamed.questions[0].question]: renamed.questions[0].options[0].label };
  expect(matches(renamed)).toBe(true);
  const decision = call(); edit(decision, text => text.replace(/^D2/, 'D19'));
  expect(matches(decision)).toBe(true);
});

test('section metadata cannot override conflicting or malformed identities', () => {
  for (const header of ['Finding 9', 'Issue 9', 'F9 rescue', 'Finding 2.1', 'Finding zero', 'Section 9', 'Section 2']) {
    const value = call(); value.questions[0].header = header;
    expect(matches(value)).toBe(false);
  }
  for (const change of [
    (text: string) => text.replace('Finding 2 (Section 2, CRITICAL GAP)', 'Finding 0 (Section 2, CRITICAL GAP)'),
    (text: string) => text.replace('(Section 2, CRITICAL GAP)', '(Section 0, CRITICAL GAP)'),
    (text: string) => text.replace('(Section 2, CRITICAL GAP)', '(Section 2, Historical Example)'),
    (text: string) => text.replace('(Section 2, CRITICAL GAP)', '(Section 2, Quoted Source)'),
    (text: string) => text.replace('(Section 2, CRITICAL GAP)', '(Section 2, CRITICAL GAP) (Section 9)'),
    (text: string) => text.replace('Finding 2 (Section 2, CRITICAL GAP)', 'Finding 2 and Finding 9 (Section 2, CRITICAL GAP)'),
    (text: string) => text.replace('(Section 2, CRITICAL GAP)', '(Section 2)'),
    (text: string) => text.replace(/^Recommendation: 2A/m, 'Recommendation: 9A'),
  ]) { const value = call(); edit(value, change); expect(matches(value)).toBe(false); }
});

test('source, hypothetical, withdrawn or missing assessments do not open review', () => {
  for (const change of [
    (text: string) => 'Example: ' + text,
    (text: string) => '> ' + text,
    (text: string) => '```\n' + text + '\n```',
    (text: string) => text.replace('\nProject/branch/task:', '\nSource:\nProject/branch/task:'),
    (text: string) => text.replace(/^ELI10: /m, 'ELI10: If approved, '),
    (text: string) => text.replace(/^ELI10: /m, 'ELI10: The following is a hypothetical example. '),
    (text: string) => text.replace(/^ELI10: (.+)$/m, 'ELI10: "$1"'),
    (text: string) => text.replace(/^ELI10: .+$/m, 'ELI10: This handler has no current defect and needs no amendment.'),
    (text: string) => text.replace(/^ELI10: .+$/m, 'ELI10: The plan needs no change.'),
    (text: string) => text.replace(/^ELI10: .+$/m, ''),
    (text: string) => text + '\nELI10: Another assessment.',
    (text: string) => text + '\nThis finding is withdrawn.',
    (text: string) => text + '\nThis finding is "withdrawn".',
    (text: string) => text + '\nThis finding is hypothetical.',
    (text: string) => text + '\nThis finding is not current.',
    (text: string) => text + '\nThis finding is no longer current.',
    (text: string) => text + '\nThis finding is "no longer current".',
    (text: string) => text + '\nThis finding is superseded.',
  ]) { const value = call(); edit(value, change); expect(matches(value)).toBe(false); }
  const historical = call(); edit(historical, text => text + '\nOld note: "This finding is withdrawn."');
  expect(matches(historical)).toBe(true);
  const resolvedHistory = call();
  edit(resolvedHistory, text => text.replace(/^(ELI10: .+)$/m, '$1 Old note: "This handler has no current defect and needs no amendment."'));
  expect(matches(resolvedHistory)).toBe(true);
});

test('only current offered remedies can supply the amendment', () => {
  for (const prefix of ['Source: ', 'If approved, ', 'This remedy is withdrawn. ', 'This remedy is "withdrawn". ']) {
    const value = call();
    value.questions[0].options.forEach((option: any) => { option.description = prefix + option.description; });
    expect(matches(value)).toBe(false);
  }
  const report = call();
  report.questions[0].options.forEach((option: any, index: number) => {
    option.label = `2${String.fromCharCode(65 + index)}) Archive the completed report ${index}`;
    option.description = 'Save the completed review for reference.';
  });
  report.answers = { [report.questions[0].question]: report.questions[0].options[0].label };
  expect(matches(report)).toBe(false);
});

test('the completed native identity, offered choice and answer remain required', () => {
  for (const change of [
    (value: any) => { value.answered = false; },
    (value: any) => { value.failed = true; },
    (value: any) => { value.sessionId = ''; },
    (value: any) => { value.toolUseId = ''; },
    (value: any) => { value.unansweredQuestionIndices = [0]; },
    (value: any) => { value.answeredAt = 'invalid'; },
    (value: any) => { value.answers = {}; },
    (value: any) => { value.answers[value.questions[0].question] = 'Foreign answer'; },
    (value: any) => { value.questions[0].multiSelect = true; },
    (value: any) => { value.questions.push(structuredClone(value.questions[0])); },
    (value: any) => { value.questions[0].header = 'Approach'; },
    (value: any) => { value.questions[0].options[1].description = ''; },
    (value: any) => { value.questions[0].options[1].label = '9B) Borrowed amendment'; },
    (value: any) => edit(value, text => text.replace(/^Recommendation: .+$/m, '')),
    (value: any) => edit(value, text => text + '\n<gstack-qid:plan-eng-review-finding>'),
  ]) { const value = call(); change(value); expect(matches(value)).toBe(false); }
  const original = fp(call());
  for (const changed of [
    { ...original, signature: 'foreign:call' },
    { ...original, nativeCall: undefined },
    { ...original, nativeQuestionIndex: 1 },
    { ...original, options: original.options.slice(1) },
  ]) expect(ceoFirstReviewAUQ(changed)).toBe(false);
});

test('new retained inputs belong only to the CEO finding-count workflow', () => {
  for (const file of ['test/ceo-annotation-header-at.test.ts', 'test/fixtures/ceo-annotation-header-at.json']) {
    expect(Object.entries(E2E_TOUCHFILES).filter(([, paths]) => paths.includes(file)).map(([name]) => name))
      .toEqual(['plan-ceo-finding-count']);
  }
});
