import { expect, test } from 'bun:test';
import { hasNativePostAnswerCeoPosture, nativeCeoModeAnswer } from './helpers/ceo-mode-option';
import type { PlanCountTranscript } from './helpers/plan-count-transcript';
import captured from './fixtures/ceo-hold-posture-ag.json';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';

const posture = /\b(rigor|bulletproof|hold\s*scope|maximum\s+rigor)\b/i;
const original = captured.transcript.assistantMessages[0]!.text;
const replay = () => structuredClone(captured.transcript) as PlanCountTranscript;
const matches = (transcript = replay()) => hasNativePostAnswerCeoPosture(
  transcript, 'HOLD SCOPE', posture, captured.selectionStartedAt,
);

test('the captured selected HOLD scope lock and hardening establish posture without a keyword', () => {
  const transcript = replay();
  expect(captured.provenance.actualState).toBe('failed');
  expect(nativeCeoModeAnswer(transcript, 'HOLD SCOPE', captured.selectionStartedAt)?.toolUseId)
    .toBe('toolu_011bt3yabPDSEsPNm97EhqV4');
  expect(posture.test(original)).toBe(false);
  expect(matches(transcript)).toBe(true);
});

test('ordinary current scope declarations preserve the same three obligations', () => {
  for (const text of [
    original.replace("I'm locking", 'I will lock'),
    original.replace("I'm locking", "I'll lock"),
    original.replace("I'm locking", 'We are keeping').replace('the four PLAN.md bullets from approach B', 'the agreed plan')
      .replace('flagging anything beyond', 'treating everything outside').replace('hunting', 'checking'),
    original.replace("I'm locking", 'I am holding').replace('four PLAN.md bullets from approach B', 'PLAN.md requirements')
      .replace('flagging', 'marking').replace('hunting', 'looking'),
    original.replace("I'm", 'I’m').replace('PLAN.md', '**PLAN.md**'),
  ]) {
    const transcript = replay(); transcript.assistantMessages[0]!.text = text;
    expect(matches(transcript)).toBe(true);
  }
});

test('deferred commitments, conditions and quotation cannot establish the current posture', () => {
  for (const text of [
    original.replace("I'm locking", 'I would lock'),
    original.replace("I'm locking", 'I will later lock'),
    'If you approve, ' + original,
    'Later, ' + original,
    'Example only: ' + original,
    'An unproven hypothesis: ' + original,
    'Example only. ' + original,
    '"' + original + '"',
    '> ' + original,
    '```text\n' + original + '\n```',
    '~~~~\n' + original + '\n~~~~',
    'Read(file)\n' + original,
    'The user said: ' + original,
    original.replace('and hunting', 'and not hunting'),
  ]) {
    const transcript = replay(); transcript.assistantMessages[0]!.text = text;
    expect(matches(transcript), text).toBe(false);
  }
});

test('all three obligations refer to the selected current scope', () => {
  for (const text of [
    original.replace('PLAN.md', 'OTHER.md'),
    original.replace('PLAN.md', 'archive/PLAN.md'),
    original.replace('the four PLAN.md bullets from approach B', 'the future expanded plan'),
    original.replace('the four PLAN.md bullets from approach B', 'the two imagined requirements'),
    original.replace('out of scope', 'in scope'),
    original.replace('as out of scope', 'as not out of scope'),
    original.replace('flagging anything beyond that (defaults, sharing, deep links) as out of scope, and ', ''),
    original.replace(/, and hunting[^.]+\./, '.'),
    original.replace('constraints, error handling, UI edge cases, access-rule leaks', 'word choice and formatting'),
    original + ' I am expanding scope to include a new feature.',
    original + ' I am adding extra features to scope.',
  ]) {
    const transcript = replay(); transcript.assistantMessages[0]!.text = text;
    expect(matches(transcript), text).toBe(false);
  }
  const ambiguous = replay();
  const question = ambiguous.calls[0]!.questions[0]!;
  const oldQuestion = question.question;
  question.question = question.question.replace('reviewing PLAN.md', 'reviewing PLAN.md and OTHER.md');
  ambiguous.calls[0]!.answers = { [question.question]: ambiguous.calls[0]!.answers![oldQuestion]! };
  expect(matches(ambiguous)).toBe(false);
});

test('explicit later corrections withdraw scope locking, while quoted examples do not', () => {
  const corrections = [
    'Correction: the previously excluded defaults, sharing, and deep links are now in scope.',
    'Correction: I am no longer locking scope to those requirements.',
    'I am not keeping scope to those requirements.',
    'The formerly excluded additions are in scope.',
  ];
  for (const correction of corrections) {
    const transcript = replay();
    transcript.assistantMessages[0]!.text = original + '\n\n' + correction;
    expect(matches(transcript), correction).toBe(false);
    for (const quote of ['> ' + correction, '```text\n' + correction + '\n```',
      '~~~text\n' + correction + '\n~~~', 'An example of withdrawn wording is: "' + correction + '"']) {
      transcript.assistantMessages[0]!.text = original + '\n\n' + quote;
      expect(matches(transcript), quote).toBe(true);
    }
  }
});

test('only a real selected HOLD answer followed by its own public statement supplies evidence', () => {
  for (const change of [
    (t: PlanCountTranscript) => { t.status = 'missing'; },
    (t: PlanCountTranscript) => { t.calls[0]!.answered = false; },
    (t: PlanCountTranscript) => { t.calls[0]!.failed = true; },
    (t: PlanCountTranscript) => { t.calls[0]!.answeredAt = new Date(captured.selectionStartedAt - 1).toISOString(); },
    (t: PlanCountTranscript) => { t.calls[0]!.answers![t.calls[0]!.questions[0]!.question] = 'Scope Expansion'; },
    (t: PlanCountTranscript) => { t.calls[0]!.answers![t.calls[0]!.questions[0]!.question] = 'Unknown'; },
    (t: PlanCountTranscript) => { t.assistantMessages[0]!.sessionId = 'foreign'; },
    (t: PlanCountTranscript) => { t.assistantMessages[0]!.timestamp = t.calls[0]!.answeredAt!; },
    (t: PlanCountTranscript) => { t.assistantMessages[0]!.timestamp = 'invalid'; },
    (t: PlanCountTranscript) => { t.assistantMessages[0]!.timestamp = new Date(Date.now() + 60_000).toISOString(); },
    (t: PlanCountTranscript) => { t.assistantMessages = []; },
  ]) {
    const transcript = replay(); change(transcript); expect(matches(transcript)).toBe(false);
  }
  const expansion = replay();
  expansion.calls[0]!.answers![expansion.calls[0]!.questions[0]!.question] = 'Scope Expansion';
  expect(hasNativePostAnswerCeoPosture(expansion, 'SCOPE EXPANSION', posture, captured.selectionStartedAt)).toBe(false);
});

test('new evidence controls select only the existing mode paid owner', () => {
  for (const file of ['test/ceo-hold-posture-ag.test.ts', 'test/fixtures/ceo-hold-posture-ag.json']) {
    expect(Object.entries(E2E_TOUCHFILES).filter(([, files]) => files.includes(file)).map(([owner]) => owner))
      .toEqual(['plan-ceo-mode-routing']);
    expect(selectTests([file], E2E_TOUCHFILES, []).selected).toEqual(['plan-ceo-mode-routing']);
  }
});

// Exact public AY parent narration after the answered HOLD SCOPE mode AUQ.
// Its native ownership controls use the existing PLAN.md / approved-approach-B fixture.
const ambiguityNarration = "I'm holding strictly to the plan's approved scope (Approach B, private-only views) and flagging any ambiguities the sketch leaves undecided as targeted questions rather than expanding scope. First up: what happens when a saved view's filters reference something that's been deleted.\n\n";
const ambiguityReplay = () => {
  const transcript = replay();
  transcript.assistantMessages[0]!.text = ambiguityNarration;
  return transcript;
};
const ambiguityMatches = (text = ambiguityNarration) => {
  const transcript = ambiguityReplay(); transcript.assistantMessages[0]!.text = text;
  return matches(transcript);
};

test('approved scope plus targeted ambiguity questions applies HOLD without naming the mode', () => {
  expect(posture.test(ambiguityNarration)).toBe(false);
  expect(ambiguityMatches()).toBe(true);
  for (const text of [
    ambiguityNarration.replace("I'm holding", 'We are keeping'),
    ambiguityNarration.replace("I'm holding", 'I will hold'),
    ambiguityNarration.replace('the sketch leaves undecided', 'in the plan').replace('flagging', 'surfacing'),
    ambiguityNarration.replace("plan's", "PLAN.md's"),
    ambiguityNarration.replace("I'm", 'I’m').replace("plan's", 'plan’s'),
  ]) expect(ambiguityMatches(text), text).toBe(true);
});

test('ambiguity wording must adopt every obligation without quoting, negating or deferring it', () => {
  for (const text of [
    '> ' + ambiguityNarration, '"' + ambiguityNarration.trim() + '"',
    '```text\n' + ambiguityNarration + '```', '~~~text\n' + ambiguityNarration + '~~~',
    'Example only: ' + ambiguityNarration, 'The user said: ' + ambiguityNarration,
    'Read(file)\n' + ambiguityNarration, 'If approved, ' + ambiguityNarration,
    ambiguityNarration.replace("I'm holding", 'I would hold'),
    ambiguityNarration.replace("I'm holding", 'I will later hold'),
    ambiguityNarration.replace("I'm holding", "I'm not holding"),
    ambiguityNarration.replace('and flagging', 'and not flagging'),
    ambiguityNarration.replace('approved scope', 'proposed scope'),
    ambiguityNarration.replace("plan's", "OTHER.md's"),
    ambiguityNarration.replace('private-only views', 'OTHER.md views'),
    ambiguityNarration.replace('Approach B', 'Approach C'),
    ambiguityNarration.replace('as targeted questions rather than expanding scope', 'as optional improvements'),
    ambiguityNarration.replace('rather than expanding scope', 'while expanding scope'),
    ambiguityNarration.replace('ambiguities the sketch leaves undecided', 'word choice and formatting'),
  ]) expect(ambiguityMatches(text), text).toBe(false);
  for (const correction of [
    'I am expanding scope to include sharing.',
    'Correction: I will add defaults to scope.',
    'The previously excluded sharing feature is now in scope.',
    'Correction: I am no longer holding scope to this plan.',
    "Correction: I am not holding strictly to the plan's approved scope.",
    'Correction: I am no longer flagging ambiguities as targeted questions.',
    'Correction: this posture is withdrawn.',
    'This posture is no longer current.',
  ]) {
    expect(ambiguityMatches(ambiguityNarration + correction), correction).toBe(false);
    expect(ambiguityMatches(ambiguityNarration + '> ' + correction), correction).toBe(true);
  }
});

test('ambiguity posture stays bound to the approved plan and its actual native answer', () => {
  for (const change of [
    (t: PlanCountTranscript) => { t.calls[0]!.answered = false; },
    (t: PlanCountTranscript) => { t.calls[0]!.failed = true; },
    (t: PlanCountTranscript) => { t.calls[0]!.answers![t.calls[0]!.questions[0]!.question] = 'Scope Expansion'; },
    (t: PlanCountTranscript) => { t.assistantMessages[0]!.sessionId = 'foreign'; },
    (t: PlanCountTranscript) => { t.assistantMessages[0]!.timestamp = t.calls[0]!.answeredAt!; },
    (t: PlanCountTranscript) => { t.assistantMessages[0]!.timestamp = 'invalid'; },
    (t: PlanCountTranscript) => { t.assistantMessages[0]!.timestamp = new Date(Date.now() + 60_000).toISOString(); },
  ]) { const transcript = ambiguityReplay(); change(transcript); expect(matches(transcript)).toBe(false); }
  for (const [from, to] of [
    ['PLAN.md', 'PLAN.md and OTHER.md'],
    ['approved.', 'not approved.'],
    ['approved.', 'approved if accepted.'],
    ['approved.', 'discussed.'],
  ]) {
    const transcript = ambiguityReplay(); const q = transcript.calls[0]!.questions[0]!;
    const before = q.question; q.question = before.replace(from!, to!);
    transcript.calls[0]!.answers = { [q.question]: transcript.calls[0]!.answers![before]! };
    expect(matches(transcript), to).toBe(false);
  }
});
