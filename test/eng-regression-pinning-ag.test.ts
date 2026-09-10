import { expect, test } from 'bun:test';
import fixture from './fixtures/eng-regression-pinning-ag.json';
import { evaluateEngSeedCoverage } from './helpers/eng-seeded-coverage';
import type { PlanCountTranscript } from './helpers/plan-count-transcript';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';
const transcript = fixture.transcript as PlanCountTranscript;
const started = Math.min(...transcript.calls.map(c => Date.parse(c.answeredAt!))) - 1;
const finished = Date.parse(fixture.finishedAt);
const evaluate = (task: string) => evaluateEngSeedCoverage(transcript,
  task + '\n\n## GSTACK REVIEW REPORT\nCoverage fixture.\n', started, finished);

test('actual required characterization task pins existing legacy behavior before other work', () => {
  expect(evaluate(fixture.requiredTask).ok).toBe(true);
  expect(evaluate(fixture.requiredTask).regression).toBe('plan');
  expect(fixture.requiredTask).toContain('before any other task lands');
  expect(fixture.observedOutcome).toBe('plan_ready');
  expect(fixture.observedFailure).toBe('mandatory legacy regression coverage absent');
});

test('pinning instruction must target current legacy behavior, not borrow names from notes', () => {
  const task = fixture.requiredTask.split('\n')[0]!;
  for (const text of [
    task.replace('legacyAuthFlow()', 'newAuthFlow()') + '; legacyAuthFlow is mentioned in notes.',
    task.replace('pinning', 'describing'),
    task.replace('current behavior', 'future behavior'),
    task.replace('Write characterization tests', 'Write a report about characterization tests'),
    task.replace('Write characterization tests', 'Do not write characterization tests'),
    task.replace('Write characterization tests', 'Maybe write characterization tests'),
    '> ' + task,
    '\"' + task + '\"',
    '```\n' + task + '\n```',
    task.replace('Write characterization tests', 'If approved, write characterization tests'),
  ]) expect(evaluate(text).regression, text).toBeUndefined();
  for (const tense of ['current', 'existing', 'prior']) {
    expect(evaluate(task.replace('current behavior', tense + ' behavior')).regression).toBe('plan');
  }
});

test('regression task cannot replace absent distinct decisions or a final report', () => {
  const missing = structuredClone(transcript); missing.calls = [];
  expect(evaluateEngSeedCoverage(missing, fixture.requiredTask, started, finished).ok).toBe(false);
  expect(evaluateEngSeedCoverage(transcript, fixture.requiredTask, started, finished).problems).toContain('final review report absent or empty');
});

test('the new regression evidence selects the affected engineering count owners', () => {
  for (const file of ['test/eng-regression-pinning-ag.test.ts', 'test/fixtures/eng-regression-pinning-ag.json']) {
    expect(selectTests([file], E2E_TOUCHFILES, []).selected.sort()).toEqual(['plan-eng-finding-count', 'plan-eng-multi-finding-batching']);
  }
});
