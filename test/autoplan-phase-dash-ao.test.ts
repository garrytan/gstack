import { expect, test } from 'bun:test';
import fixture from './fixtures/autoplan-phase-dash-ao.json';
import { autoplanPhaseCompletions } from './helpers/autoplan-phase-observer';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';
import type { PlanCountTranscript } from './helpers/plan-count-transcript';

const at = Date.parse(fixture.message.timestamp);
const transcript = (text = fixture.message.text): PlanCountTranscript => ({
  status: 'ready', calls: [], assistantMessages: [{ ...fixture.message, text }],
});
const hits = (text: string) => autoplanPhaseCompletions(transcript(text), at - 1);

test('exact owned DX dash declaration adds only DX at its native timestamp', () => {
  expect(hits(fixture.message.text)).toEqual([{ phase: 2.5, ts: at }]);
  const all = autoplanPhaseCompletions({ status: 'ready', calls: [],
    assistantMessages: fixture.orderedMessages }, fixture.commandLowerBound);
  expect(all).toEqual([...fixture.actualHits, { phase: 2.5, ts: at }]);
  expect(all.map(hit => hit.phase)).toEqual([1, 2, 2.5]);
});

test('em and en dash spacing share the existing completed declaration forms', () => {
  for (const dash of ['—', '–']) for (const before of ['', ' ']) for (const after of ['', ' ']) {
    expect(hits(fixture.message.text.replace('complete—', `complete${before}${dash}${after}`)))
      .toEqual([{ phase: 2.5, ts: at }]);
    for (const phase of [1, 2, 2.5, 3]) for (const state of ['complete', 'completed', 'done', 'finished', 'wrapped up']) {
      expect(hits(`Phase ${phase} is ${state}${before}${dash}${after}Work retained.`))
        .toEqual([{ phase, ts: at }]);
    }
  }
  expect(hits('**Phase 2.5 complete** — Work retained.')).toEqual([{ phase: 2.5, ts: at }]);
});

test('dash continuations cannot turn a conditional, quotation, question or denial into completion', () => {
  for (const dash of ['—', '–']) for (const tail of [
    '', 'if approved.', 'unless the checks fail.', 'when review finishes.',
    'once the reviewer signs off.', 'pending final checks.', 'maybe tomorrow.',
    'perhaps it is complete.', 'would be complete after review.',
    'not complete yet.', 'the phase is not complete.', 'this completion is withdrawn.',
    'actually never finished.', 'this completion is superseded.',
    'provided the remaining checks pass.', 'this completion is rejected.',
    'the completion announcement is retracted.', 'actually incomplete.',
    'the review remains pending.', 'Work retained?', 'is this complete?',
    'Source excerpt: Work retained.', 'Earlier review: Work retained.',
    'the historical example says work is retained.', '"Work retained."',
  ]) expect(hits(`Phase 2.5 complete ${dash} ${tail}`), tail).toEqual([]);
  for (const text of [
    'If approved, Phase 2.5 complete—Work retained.',
    'Phase 2.5 is not complete—Work retained.',
    'Phase 2.5 complete?—Work retained.',
    '> Phase 2.5 complete—Work retained.',
    '"Phase 2.5 complete—Work retained."',
    'Source excerpt:\nPhase 2.5 complete—Work retained.',
    'Example:\nPhase 2.5 complete—Work retained.\nPhase 3 complete—Work retained.',
    '```text\nPhase 2.5 complete—Work retained.\n```',
    '    Phase 2.5 complete—Work retained.',
    '# Phase 2.5 complete—Work retained.',
    'Phase 2.5 (Eng review) complete—Work retained.',
  ]) expect(hits(text), text).toEqual([]);
});

test('dash support keeps ready/current native evidence and first-hit ordering', () => {
  for (const status of ['missing', 'error'] as const) {
    expect(autoplanPhaseCompletions({ ...transcript(), status }, at - 1)).toEqual([]);
  }
  expect(autoplanPhaseCompletions(transcript(), at + 1)).toEqual([]);
  expect(autoplanPhaseCompletions({ ...transcript(), assistantMessages: [
    { ...fixture.message, timestamp: 'invalid' },
  ] }, at - 1)).toEqual([]);
  const later = { ...fixture.message, timestamp: new Date(at + 1).toISOString() };
  expect(autoplanPhaseCompletions({ ...transcript(), assistantMessages: [later, fixture.message] }, at - 1))
    .toEqual([{ phase: 2.5, ts: at }]);
});

test('dash fixture and regression select only the existing AP owner', () => {
  for (const file of ['test/autoplan-phase-dash-ao.test.ts', 'test/fixtures/autoplan-phase-dash-ao.json']) {
    expect(selectTests([file], E2E_TOUCHFILES).selected).toEqual(['autoplan-chain-pty']);
  }
});
