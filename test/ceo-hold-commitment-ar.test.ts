import { expect, test } from 'bun:test';
import { hasNativePostAnswerCeoPosture, nativeCeoModeAnswer } from './helpers/ceo-mode-option';
import type { PlanCountTranscript } from './helpers/plan-count-transcript';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';
import captured from './fixtures/ceo-hold-commitment-ar.json';

const posture = /\b(rigor|bulletproof|hold\s*scope|maximum\s+rigor)\b/i;
const original = captured.transcript.assistantMessages[0]!.text;
const replay = () => structuredClone(captured.transcript) as PlanCountTranscript;
const matches = (transcript = replay()) => hasNativePostAnswerCeoPosture(
  transcript, 'HOLD SCOPE', posture, captured.selectionStartedAt,
);
const withText = (text: string) => { const t = replay(); t.assistantMessages[0]!.text = text; return matches(t); };

test('the actual failed attempt adopted HOLD through scope, hardening and exclusion', () => {
  expect(captured.provenance.actualState).toBe('failed');
  expect(nativeCeoModeAnswer(replay(), 'HOLD SCOPE', captured.selectionStartedAt)?.toolUseId)
    .toBe('toolu_01E1HnYjRCz79826bo7nNnoK');
  expect(posture.test(original)).toBe(false);
  expect(matches()).toBe(true);
  // This is prospective posture recognition, not evidence of completed work.
  for (const prefix of ["I'm keeping", 'I am keeping', 'I will keep', "We'll keep", 'We will keep', 'We are keeping']) {
    expect(withText(original.replace("I'll keep", prefix)), prefix).toBe(true);
  }
  expect(withText(original.replace("I'll", 'I’ll').replace("PLAN.md's", 'PLAN.md’s'))).toBe(true);
});

test('explicitly future, conditional and quoted statements are not adopted current posture', () => {
  for (const text of [
    original.replace("I'll keep", 'I will later keep'),
    original.replace("I'll keep", 'I will eventually keep'),
    original.replace("I'll keep", 'I would keep'),
    original.replace("I'll keep", 'I may keep'),
    original.replace("I'll keep", "I'll not keep"),
    original.replace('scope fixed', 'scope tomorrow fixed'),
    original.replace('production visibility', 'production visibility next week'),
    original.replace('production visibility', 'production visibility tomorrow'),
    ...['after approval', 'once approved', 'when approved', 'after launch', 'pending approval', 'subject to approval'].map(when =>
      original.replace('production visibility', 'production visibility ' + when)),
    'Later, ' + original, 'If you approve, ' + original,
    'Hypothetical scenario. ' + original, 'Example only: ' + original,
    '"' + original + '"', '> ' + original,
    '```text\n' + original + '\n```', '~~~text\n' + original + '\n~~~',
    'Read(file)\n' + original, 'The user said: ' + original,
  ]) expect(withText(text), text).toBe(false);
});

test('all three obligations remain concrete and bound to the selected plan', () => {
  for (const [from, to] of [
    ['PLAN.md', 'OTHER.md'], ['PLAN.md', 'archive/PLAN.md'],
    ["PLAN.md's four bullets plus the approved schema", 'the future expanded plan'],
    ['plus the approved schema', 'plus a new unapproved schema'],
    [', pressure-testing every stated behavior for failure modes, errors, tests, and production visibility', ''],
    ['errors, tests, and production visibility', 'word choice and formatting'],
    ['while deferring anything extra rather than adding it silently', 'while adding anything extra'],
    ['while deferring', 'while not deferring'], ['pressure-testing', 'not pressure-testing'],
  ]) expect(withText(original.replace(from!, to!)), from).toBe(false);
  for (const contextChange of [
    (text: string) => text.replace('PLAN.md', 'PLAN.md and OTHER.md'),
    (text: string) => text.replace('schema) approved', 'schema) not approved'),
    (text: string) => text.replace('schema) approved', 'schema) discussed'),
    ...['approved if the user agrees', 'approved once migration finishes', 'approved pending migration', 'approved subject to migration'].map(status =>
      (text: string) => text.replace('schema) approved', 'schema) ' + status)),
  ]) {
    const t = replay(); const q = t.calls[0]!.questions[0]!; const prior = q.question;
    q.question = contextChange(q.question); t.calls[0]!.answers = { [q.question]: t.calls[0]!.answers![prior]! };
    expect(matches(t)).toBe(false);
  }
});

test('current corrections withdraw a commitment; quoted corrections do not', () => {
  for (const correction of [
    'Correction: I will expand scope to include defaults.',
    'Correction: I will not keep scope fixed to these requirements.',
    'Correction: I am no longer keeping scope to those requirements.',
    'The formerly excluded additions are in scope.',
  ]) {
    expect(withText(original + '\n\n' + correction), correction).toBe(false);
    for (const quote of ['> ' + correction, '```text\n' + correction + '\n```', '~~~text\n' + correction + '\n~~~', 'A quotation: "' + correction + '"']) {
      expect(withText(original + '\n\n' + quote), quote).toBe(true);
    }
  }
});

test('native selection, session and timestamp evidence remain required', () => {
  for (const change of [
    (t: PlanCountTranscript) => { t.status = 'missing'; },
    (t: PlanCountTranscript) => { t.calls[0]!.answered = false; },
    (t: PlanCountTranscript) => { t.calls[0]!.failed = true; },
    (t: PlanCountTranscript) => { t.calls[0]!.answeredAt = new Date(captured.selectionStartedAt - 1).toISOString(); },
    (t: PlanCountTranscript) => { t.calls[0]!.answers![t.calls[0]!.questions[0]!.question] = 'Scope expansion'; },
    (t: PlanCountTranscript) => { t.calls[0]!.answers![t.calls[0]!.questions[0]!.question] = 'Unknown'; },
    (t: PlanCountTranscript) => { t.assistantMessages[0]!.sessionId = 'foreign'; },
    (t: PlanCountTranscript) => { t.assistantMessages[0]!.timestamp = t.calls[0]!.answeredAt!; },
    (t: PlanCountTranscript) => { t.assistantMessages[0]!.timestamp = 'invalid'; },
    (t: PlanCountTranscript) => { t.assistantMessages[0]!.timestamp = new Date(Date.now() + 60_000).toISOString(); },
    (t: PlanCountTranscript) => { t.assistantMessages = []; },
  ]) { const t = replay(); change(t); expect(matches(t)).toBe(false); }
});

test('new posture evidence selects the existing mode owner', () => {
  for (const file of ['test/ceo-hold-commitment-ar.test.ts', 'test/fixtures/ceo-hold-commitment-ar.json']) {
    expect(selectTests([file], E2E_TOUCHFILES, []).selected).toEqual(['plan-ceo-mode-routing']);
  }
});
