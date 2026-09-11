import { describe, expect, test } from 'bun:test';
import { hasNativePostAnswerCeoPosture, nextCeoPostureContinuation } from './helpers/ceo-mode-option';
import type { PlanCountTranscript } from './helpers/plan-count-transcript';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';
import captured from './fixtures/ceo-barless-submit-ac.json';

const selectedAt = Date.parse(captured.provenance.modeRequestAt);
const questions = captured.projectedQuestions;
const chrome = 'Planning:\n/tmp/owned-plan.md\n─────────────────\n';

function transcript(native = false, count = 3): PlanCountTranscript {
  return { status: 'ready', assistantMessages: [], calls: [structuredClone(captured.modeCall),
    ...(native ? [{ sessionId: captured.modeCall.sessionId, toolUseId: 'projected-pending-call',
      answered: false, failed: false, questions: structuredClone(questions.slice(0, count)) }] : [])] };
}

// Complete projected frames exercise the observed barless layout. The raw
// historical tail is retained separately and is never promoted to a full frame.
function screen(index: number, count = 3): string {
  const current = questions[index]!;
  return chrome + '← ' + questions.slice(0, count).map((q, i) => `${i < index ? '☒' : '☐'} ${q.header}`).join(' ') +
    ' ✔ Submit →\n' + current.question + '\n' + current.options.map((option, i) =>
      `${i === 0 ? '❯' : ''}${i + 1}. ${option.label}`).join('\n') +
    '\nEnter to select · Tab/Arrow keys to navigate · Esc to cancel\n';
}

function summary(count = 3): string {
  return chrome + 'Review your answers\n' + questions.slice(0, count).map(question =>
    `│ ● ${question.question.replaceAll('\n', '\n│ ')}\n│ → ${question.options[0]!.label}\n`).join('\n') +
    '\nReady to submit your answers?\n❯1. Submit answers\n2. Cancel\n';
}

function observed(count = 3, native = false) {
  const t = transcript(native, count), seen = new Set<string>();
  for (let i = 0; i < count; i++) {
    expect(nextCeoPostureContinuation(screen(i, count), t, 'HOLD SCOPE', selectedAt, seen, i > 0)).toBe('question');
  }
  const submit = (visible = summary(count), native = t) =>
    nextCeoPostureContinuation(visible, native, 'HOLD SCOPE', selectedAt, seen, true);
  return { t, seen, submit };
}

describe('bounded CEO barless packet submission', () => {
  test('two through four observed tabs submit once with delayed or eager native identity', () => {
    for (const count of [2, 3, 4]) for (const native of [false, true]) {
      const p = observed(count, native);
      expect(p.submit()).toBe('submission');
      expect(p.submit()).toBeNull();
      expect(p.submit(screen(0, count))).toBeNull();
      expect(hasNativePostAnswerCeoPosture(p.t, 'HOLD SCOPE', /hold\s*scope/i, selectedAt)).toBe(false);
    }
  });

  test('an exact late native packet binds all prior tabs before Submit', () => {
    const p = observed();
    expect(p.submit(summary(), transcript(true))).toBe('submission');
    expect(p.submit(summary(), transcript(true))).toBeNull();
  });

  test.each(['different question', 'different selected answer', 'reordered questions', 'missing question',
    'extra question', 'extra work', 'later assistant prose', 'changed plan chrome', 'missing ready prompt',
    'cancel cursor', 'wrong submit action', 'quoted whole summary', 'no complete summary'])('%s does not submit', mutation => {
    const p = observed();
    let visible = summary();
    if (mutation === 'different question') visible = visible.replace('persisted filters remain readable', 'project billing change');
    if (mutation === 'different selected answer') visible = visible.replace('→ Version and validate (recommended)', '→ Store opaque filters');
    if (mutation === 'reordered questions') {
      const first = questions[0]!.question, second = questions[1]!.question;
      visible = visible.replace(first.replaceAll('\n', '\n│ '), second.replaceAll('\n', '\n│ '));
    }
    if (mutation === 'missing question') visible = summary(2);
    if (mutation === 'extra question') visible = visible.replace('Ready to submit', '● Delete the release branch?\n→ Yes\nReady to submit');
    if (mutation === 'extra work') visible = visible.replace('Ready to submit', 'Also deploy everything.\nReady to submit');
    if (mutation === 'later assistant prose') visible += '\n● Starting another question.';
    if (mutation === 'changed plan chrome') visible = visible.replace('/tmp/owned-plan.md', '/tmp/foreign-plan.md');
    if (mutation === 'missing ready prompt') visible = visible.replace('Ready to submit your answers?', '');
    if (mutation === 'cancel cursor') visible = visible.replace('❯1.', '1.').replace('2. Cancel', '❯2. Cancel');
    if (mutation === 'wrong submit action') visible = visible.replace('Submit answers', 'Approve and deploy');
    if (mutation === 'quoted whole summary') visible = visible.split('\n').map(line => `> ${line}`).join('\n');
    if (mutation === 'no complete summary') visible = captured.actualTruncatedTail;
    expect(p.submit(visible)).toBeNull();
  });

  test('a bare Submit, a skipped tab or another session cannot borrow the observed packet', () => {
    const t = transcript(), seen = new Set<string>();
    expect(nextCeoPostureContinuation(summary(), t, 'HOLD SCOPE', selectedAt, seen, false)).toBeNull();
    expect(nextCeoPostureContinuation(screen(0), t, 'HOLD SCOPE', selectedAt, seen, false)).toBe('question');
    expect(nextCeoPostureContinuation(summary(), t, 'HOLD SCOPE', selectedAt, seen, true)).toBeNull();
    const p = observed();
    const foreign = transcript(); foreign.calls[0]!.sessionId = 'other-session';
    expect(p.submit(summary(), foreign)).toBeNull();
  });

  test.each(['foreign session', 'foreign ID', 'different question', 'different option', 'answered', 'failed', 'new mode answer'])('late native %s refuses Submit', mutation => {
    const p = observed(3, true), t = transcript(true);
    const pending = t.calls[1]!;
    if (mutation === 'foreign session') pending.sessionId = 'other-session';
    if (mutation === 'foreign ID') pending.toolUseId = 'other-pending';
    if (mutation === 'different question') pending.questions[0]!.question += ' Changed.';
    if (mutation === 'different option') pending.questions[0]!.options[0]!.label = 'Deploy everything';
    if (mutation === 'answered') pending.answered = true;
    if (mutation === 'failed') pending.failed = true;
    if (mutation === 'new mode answer') {
      t.calls[0]!.answers![t.calls[0]!.questions[0]!.question] = 'SCOPE EXPANSION';
    }
    expect(p.submit(summary(), t)).toBeNull();
  });

  test('only later native assistant posture after a successful answer supplies coverage', () => {
    const p = observed(3, true);
    expect(p.submit()).toBe('submission');
    expect(hasNativePostAnswerCeoPosture(p.t, 'HOLD SCOPE', /hold\s*scope/i, selectedAt)).toBe(false);
    p.t.calls[1]!.answered = true;
    p.t.calls[1]!.answeredAt = '2026-09-09T16:42:10.000Z';
    p.t.calls[1]!.answers = Object.fromEntries(p.t.calls[1]!.questions.map(q => [q.question, q.options[0]!.label]));
    p.t.calls[1]!.unansweredQuestionIndices = [];
    p.t.assistantMessages.push({ sessionId: captured.modeCall.sessionId, timestamp: '2026-09-09T16:42:11.000Z',
      text: 'HOLD SCOPE: keep the saved-view feature fixed and make its failure handling rigorous.' });
    expect(hasNativePostAnswerCeoPosture(p.t, 'HOLD SCOPE', /hold\s*scope/i, selectedAt)).toBe(true);
  });

  test('the free test and fixture select only the mode-routing workflow', () => {
    for (const file of ['test/ceo-barless-submit.test.ts', 'test/fixtures/ceo-barless-submit-ac.json']) {
      expect(selectTests([file], E2E_TOUCHFILES, []).selected).toEqual(['plan-ceo-mode-routing']);
    }
  });
});
