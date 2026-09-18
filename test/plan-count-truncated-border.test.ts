import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import captured from './fixtures/eng-d2-truncated-border-0bcd.json';
import { capturePlanCountQuestion, matchesNativePlanQuestion, planCountQuestionInput } from './helpers/claude-pty-runner';
import { pickEngCountQuestion } from './helpers/eng-count-question-policy';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';

const screen = captured.screen;
const pending = (): NativePlanQuestionCall => structuredClone(captured.call);
const withoutBorder = screen.slice(screen.indexOf('\n') + 1);

test('actual pending Eng D2 truncated pane binds across its native top border', () => {
  expect(createHash('sha256').update(screen).digest('hex')).toBe(captured.provenance.screenSha256);
  const call = pending();
  expect(call.answered).toBe(false);
  expect(call.failed).toBe(false);
  expect(call.toolUseId).toBe('toolu_019jkxRPCtRvqqU7NjFk4dJp');
  expect(call.answers).toBeUndefined();
  // Pinned native pF renders es(question) with the default 2,000-character
  // cap. This exact retained prefix ends before the question's native tail.
  const body = withoutBorder.slice(withoutBorder.indexOf('\n') + 1, withoutBorder.indexOf('❯ 1.'))
    .replace(/^[ \t]*[│┃] ?|[│┃][ \t]*$/gm, '').trim();
  expect(body.replace(/\s+/g, '')).toBe((call.questions[0]!.question.slice(0, 2000) + '…').replace(/\s+/g, ''));
  expect(call.questions[0]!.question.length).toBeGreaterThan(2000);
  expect(matchesNativePlanQuestion(screen, call)).toBe(true);
  const active = capturePlanCountQuestion(screen, new Set(), 0, true, call)!;
  expect(active.nativeCall).toBe(call);
  expect(active.nativeQuestionIndex).toBe(0);
  expect(active.promptSnippet).toBe(`${call.questions[0]!.header} ${call.questions[0]!.question}`);
  expect(active.options.map(option => option.label)).toEqual(call.questions[0]!.options.map(option => option.label));
  const choice = pickEngCountQuestion(call.questions[0]!);
  expect(choice).toBe(1);
  expect(planCountQuestionInput(screen, active, choice)).toBe('1'); // computed only; no native key sent
});

test('removing only native top chrome preserves the previously supported complete prefix', () => {
  expect(screen.endsWith(withoutBorder)).toBe(true);
  expect(matchesNativePlanQuestion(withoutBorder, pending())).toBe(true);
});

for (const [name, visible] of [
  ['CRLF transport', screen.replaceAll('\n', '\r\n')],
  ['blank viewport padding', '\n \n' + screen],
  ['blank rail padding', '│\n' + screen],
] as const) test(`native truncated border preserves ${name}`, () => {
  const call = pending();
  expect(matchesNativePlanQuestion(visible, call)).toBe(true);
  expect(capturePlanCountQuestion(visible, new Set(), 0, true, call)?.nativeCall).toBe(call);
});

const negatives: [string, (value: string) => string][] = [
  ['foreign introduction', value => 'Quoted earlier menu:\n' + value],
  ['foreign introduction inside border', value => value.replace('\n', '\nQuoted earlier menu:\n')],
  ['fenced copy', value => '```text\n' + value + '\n```'],
  ['competing header', value => value.replace(' ☐ Layout', ' ☐ Other\n ☐ Layout')],
  ['foreign header', value => value.replace('☐ Layout', '☐ Other')],
  ['changed visible question prefix', value => value.replace('D2 — Complexity gate', 'D2 — Different gate')],
  ['missing native elision', value => value.replace('❌ two …', '❌ two')],
  ['changed offered label', value => value.replace('1. Simplify class layout', '1. Expand feature scope')],
  ['extra offered action', value => value.replace('4. Type something.', '4. New action')],
  ['missing footer', value => value.replace(' · Esc to cancel', '')],
  ['later prose', value => value + '\nAnother unrelated prompt'],
  ['duplicate border', value => value.split('\n')[0] + '\n' + value],
];
for (const [name, mutate] of negatives) test(`native border cannot authorize ${name}`, () => {
  const changed = mutate(screen), call = pending();
  expect(changed).not.toBe(screen);
  expect(matchesNativePlanQuestion(changed, call)).toBe(false);
  expect(capturePlanCountQuestion(changed, new Set(), 0, true, call)?.nativeCall).toBeUndefined();
});

test('native state and exact author commitment still guard the current answer', () => {
  for (const call of [{ ...pending(), answered: true }, { ...pending(), failed: true }])
    expect(capturePlanCountQuestion(screen, new Set(), 0, true, call)?.nativeCall).toBeUndefined();
  const altered = pending();
  altered.questions[0]!.options[0]!.description += ' Also add cross-request coordination.';
  expect(() => pickEngCountQuestion(altered.questions[0]!)).toThrow('author-owned');
  const seen = new Set<string>(), call = pending();
  const first = capturePlanCountQuestion(screen, seen, 0, true, call);
  expect(first?.nativeCall).toBe(call);
  expect(capturePlanCountQuestion(screen, seen, 1, true, call)).toBeNull();
});
