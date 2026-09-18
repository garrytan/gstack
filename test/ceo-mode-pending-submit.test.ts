import { expect, test } from 'bun:test';
import captured from './fixtures/ceo-mode-pending-submit.json';
import { ceoModeSubmissionInput, hasNativePostAnswerCeoPosture } from './helpers/ceo-mode-option';

const clone = <T>(value: T): T => structuredClone(value);
const attempt = () => {
  const transcript = clone(captured.native), selected = clone(transcript.calls[0]!);
  const seen = new Set<string>();
  return { transcript, selected, seen, run: (screen = captured.screen) =>
    ceoModeSubmissionInput(screen, selected, 'SCOPE EXPANSION', transcript, seen) };
};

test('actual multi-tab mode packet requires Submit before its native answer can exist', () => {
  const a = attempt();
  expect(a.selected.answered).toBe(false);
  expect(hasNativePostAnswerCeoPosture(a.transcript, 'SCOPE EXPANSION', /expansion/i, captured.selectionStartedAt)).toBe(false);
  expect(a.run()).toBe('\r');
  expect(a.run()).toBeNull();
  expect(a.selected.answered).toBe(false); // No fabricated result or posture credit.
  expect(hasNativePostAnswerCeoPosture(a.transcript, 'SCOPE EXPANSION', /expansion/i, captured.selectionStartedAt)).toBe(false);
});

for (const [name, change] of Object.entries({
  'wrong chosen mode': (s: string) => s.replace('→ SCOPE EXPANSION', '→ HOLD SCOPE'),
  'foreign question': (s: string) => s.replace('Which review mode for the saved-views plan?', 'Which plan should be deployed?'),
  'unoffered answer': (s: string) => s.replace('→ Add routing rules (recommended)', '→ Deploy to production'),
  'unanswered tab': (s: string) => s.replace('☒ Routing', '☐ Routing'),
  'foreign tab': (s: string) => s.replace('☒ Routing', '☒ Deploy'),
  'incomplete body': (s: string) => s.replace(/ │   ELI10:.*\n/, ''),
  'missing review heading': (s: string) => s.replace('Review your answers', ''),
  'cancel focused': (s: string) => s.replace('❯ 1. Submit answers\n  2. Cancel', '  1. Submit answers\n❯ 2. Cancel'),
  'another pending menu': (s: string) => s + '\n❯ 1. Delete everything\n2. Cancel',
  'quoted example': (s: string) => 'Example:\n' + s,
  'fenced source': (s: string) => '```text\n' + s + '\n```',
  'blockquote': (s: string) => s.split('\n').map(line => '> ' + line).join('\n'),
})) test(`mode packet rejects ${name}`, () => expect(attempt().run(change(captured.screen))).toBeNull());

for (const [name, mutate] of Object.entries({
  'native already answered': (a: ReturnType<typeof attempt>) => { a.transcript.calls[0]!.answered = true; },
  'native failed': (a: ReturnType<typeof attempt>) => { a.transcript.calls[0]!.failed = true; },
  'foreign native call': (a: ReturnType<typeof attempt>) => { a.transcript.calls[0]!.toolUseId = 'other-call'; },
  'foreign native session': (a: ReturnType<typeof attempt>) => { a.transcript.calls[0]!.sessionId = 'other-session'; },
  'changed native question': (a: ReturnType<typeof attempt>) => { a.transcript.calls[0]!.questions[1]!.question += 'Changed.'; },
  'missing native call': (a: ReturnType<typeof attempt>) => { a.transcript.calls = []; },
  'duplicate native call': (a: ReturnType<typeof attempt>) => { a.transcript.calls.push(clone(a.transcript.calls[0]!)); },
})) test(`mode packet rejects ${name}`, () => { const a = attempt(); mutate(a); expect(a.run()).toBeNull(); });

test('only acknowledged answer followed by real current posture supplies coverage', () => {
  const a = attempt(); expect(a.run()).toBe('\r');
  const call = a.transcript.calls[0]!;
  call.answered = true; Object.assign(call, {answeredAt: new Date(captured.selectionStartedAt + 1000).toISOString(),
    unansweredQuestionIndices: [], answers: Object.fromEntries(call.questions.map((q, i) => [q.question, q.options[i === 1 ? 1 : 0]!.label]))});
  expect(a.run()).toBeNull();
  expect(hasNativePostAnswerCeoPosture(a.transcript, 'SCOPE EXPANSION', /expansion/i, captured.selectionStartedAt)).toBe(false);
  a.transcript.assistantMessages.push({sessionId:call.sessionId, timestamp:new Date(captured.selectionStartedAt + 2000).toISOString(),
    text:'SCOPE EXPANSION: explore sharing and defaults, and ask before adding each to this plan.'});
  expect(hasNativePostAnswerCeoPosture(a.transcript, 'SCOPE EXPANSION', /expansion/i, captured.selectionStartedAt)).toBe(true);
});

for (const [name, mutate] of Object.entries({
  'captured answer already final': (a: ReturnType<typeof attempt>) => { a.selected.answered = true; },
  'captured call failed': (a: ReturnType<typeof attempt>) => { a.selected.failed = true; },
  'captured owner missing': (a: ReturnType<typeof attempt>) => { a.selected.sessionId = ''; },
  'native metadata error': (a: ReturnType<typeof attempt>) => { a.transcript.status = 'error' as any; },
  'checkbox question': (a: ReturnType<typeof attempt>) => { a.selected.questions[0]!.multiSelect = true; },
})) test(`mode packet rejects ${name}`, () => { const a = attempt(); mutate(a); expect(a.run()).toBeNull(); });
