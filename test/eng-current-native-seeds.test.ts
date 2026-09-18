import { expect, test } from 'bun:test';
import captured from './fixtures/eng-current-native-seeds-6714.json';
import { evaluateEngSeedCoverage } from './helpers/eng-seeded-coverage';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
const calls = () => structuredClone(captured.calls) as NativePlanQuestionCall[];
const cases = [[3, 'complexity'], [4, 'shared-cache'], [8, 'swallowed-errors'], [12, 'sequential-idp']] as const;
const evaluate = (calls: NativePlanQuestionCall[]) => evaluateEngSeedCoverage({ status: 'ready', calls, assistantMessages: [], planReadyRequests: [] }, '', captured.startedAt, captured.finishedAt);
test('the four actual completed decisions independently cover their own seeds', () => {
  for (const [index, seed] of cases) expect(Object.keys(evaluate([calls()[index]!]).decisions)).toEqual([seed]);
});
test('the cancelled attempt has four decision witnesses but no fabricated final report or regression evidence', () => {
  const input = calls(), before = JSON.stringify(input), result = evaluate(input);
  expect(Object.keys(result.decisions).sort()).toEqual(cases.map(([, seed]) => seed).sort());
  expect(new Set(Object.values(result.decisions)).size).toBe(4);
  expect(result.ok).toBe(false);
  expect(result.problems).toContain('mandatory legacy regression coverage absent');
  expect(result.problems).toContain('final review report absent or empty');
  expect(JSON.stringify(input)).toBe(before);
});
const edit = (index: number, mutate: (q: NativePlanQuestionCall['questions'][number]) => void) => {
  const call = calls()[index]!, q = call.questions[0]!; mutate(q); call.answers = { [q.question]: q.options[0]!.label }; return call;
};
for (const [name, mutate] of Object.entries({
  'quoted source': (q: any) => { q.question = q.question.replace(/^Project\/branch\/task: (.+)$/m, 'Project/branch/task: "$1"'); },
  'historical source': (q: any) => { q.question = q.question.replace('Project/branch/task: ', 'Project/branch/task: Historical example: '); },
  'foreign plan': (q: any) => { q.question = q.question.replaceAll('PLAN.md', 'OTHER.md'); },
  'quoted explanation': (q: any) => { q.question = q.question.replace(/^ELI10: (.+)$/m, 'ELI10: "$1"'); },
  'conditional explanation': (q: any) => { q.question = q.question.replace('ELI10: ', 'ELI10: If approved, '); },
  'withdrawn decision': (q: any) => { q.question += '\nThis decision is withdrawn.'; },
  'withdrawn selected remedy': (q: any) => { q.options[0].description += '\nThis remedy is withdrawn.'; },
  'borrowed repair in Net': (q: any) => { q.question += '\nNet: ' + q.options[0].description; q.options[0].description = 'Discuss the next steps.'; },
})) test('new explained classes reject ' + name, () => {
  for (const [index] of cases.slice(0, 3)) expect(evaluate([edit(index, mutate)]).decisions).toEqual({});
});
test('inventory counts, one backing store, injection ownership and propagated errors remain required', () => {
  const changes = [
    [3, (q: any) => { q.question = q.question.replace('plan adds five new units', 'plan adds six new units'); }],
    [3, (q: any) => { q.options[0].description = q.options[0].description.replace('3 new classes', '4 new classes'); }],
    [3, (q: any) => { q.options[0].description = q.options[0].description.replace('One token layer', 'Two token layers'); }],
    [4, (q: any) => { q.options[0].description = q.options[0].description.replace('passed to both services', 'passed to a different service'); }],
    [4, (q: any) => { q.options[0].description = q.options[0].description.replace('tests pass a fresh one', 'tests share the existing one'); }],
    [8, (q: any) => { q.options[0].description = q.options[0].description.replace('every error logged and propagated', 'some errors logged and propagated'); }],
    [8, (q: any) => { q.options[0].description = q.options[0].description.replace('every error logged and propagated', 'every error logged and swallowed'); }],
  ] as const;
  for (const [index, change] of changes) expect(evaluate([edit(index, change)]).decisions).toEqual({});
});
test('owned R status and header must agree with the native decision', () => {
  for (const [index, id] of [[4, 'R1'], [8, 'R5']] as const) {
    expect(evaluate([edit(index, q => { q.header = 'R99'; })]).decisions).toEqual({});
    expect(evaluate([edit(index, q => { q.question += `\n${id} is withdrawn.`; })]).decisions).toEqual({});
  }
});
test('pending, failed and out-of-window native decisions cannot cover seeds', () => {
  for (const [index] of cases) for (const mutate of [
    (c: NativePlanQuestionCall) => { c.answered = false; },
    (c: NativePlanQuestionCall) => { c.failed = true; },
    (c: NativePlanQuestionCall) => { c.answeredAt = new Date(captured.finishedAt + 1).toISOString(); },
    (c: NativePlanQuestionCall) => { c.answers = { [c.questions[0]!.question]: 'not offered' }; },
  ]) { const call = calls()[index]!; mutate(call); expect(evaluate([call]).decisions).toEqual({}); }
});

test('current owned source filenames cannot be borrowed from suffixes or another directory', () => {
  for (const [index] of cases.slice(0, 3)) for (const file of ['OTHER-PLAN.md', 'archive/PLAN.md', '../PLAN.md'])
    expect(evaluate([edit(index, q => { q.question = q.question.replaceAll('PLAN.md', file); })]).decisions).toEqual({});
});
test('local cancellation of each offered repair overrides earlier positive details', () => {
  for (const [index, veto] of [[3, 'Do not fold TokenStore or RequestPolicy.'], [4, 'Do not inject AuthCache.'], [8, 'Never propagate errors.']] as const) {
    expect(evaluate([edit(index, q => { q.options[0]!.description += '\nCorrection: ' + veto; })]).decisions).toEqual({});
    expect(Object.keys(evaluate([edit(index, q => { q.options[0]!.description += '\nPrior note: "' + veto + '"'; })]).decisions)).toHaveLength(1);
  }
});
