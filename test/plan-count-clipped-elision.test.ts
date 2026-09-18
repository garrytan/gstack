import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import captured from './fixtures/eng-d1-clipped-elision-1579.json';
import planningCapture from './fixtures/eng-d2-planning-prelude-4d.json';
import { capturePlanCountQuestion, matchesNativePlanQuestion, parseNumberedOptions, planCountQuestionInput } from './helpers/claude-pty-runner';
import { pickEngCountQuestion } from './helpers/eng-count-question-policy';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';

const screen = captured.screen;
function pending(): NativePlanQuestionCall {
  const record = structuredClone(captured.pendingRecord.pending);
  return { sessionId: record.sessionId, toolUseId: record.toolUseId,
    questions: record.questions, answered: false, failed: false };
}
const cursor = screen.indexOf('❯ 1.');
const body = screen.slice(0, cursor);
const menu = screen.slice(cursor);
const compact = (value: string) => value.replace(/\s+/g, '');

test('actual pending Eng D1 binds after native elision and viewport clipping compose', () => {
  expect(createHash('sha256').update(screen).digest('hex')).toBe(captured.provenance.screenSha256);
  const call = pending();
  expect(call.toolUseId).toBe('toolu_013bZVkNzZX27USs6kSBK6a5');
  expect(body).not.toMatch(/[☐□]/);
  expect(call.questions[0]!.question.length).toBe(2462);
  const visible = compact(body.replace(/^[ \t]*[│┃] ?|[│┃][ \t]*$/gm, '').trim());
  expect(compact(call.questions[0]!.question).endsWith(visible)).toBe(false);
  expect(compact(call.questions[0]!.question.slice(0, 2000) + '…').endsWith(visible)).toBe(true);
  expect(parseNumberedOptions(screen).slice(0, 3).map(row => row.label)).toEqual(call.questions[0]!.options.map(row => row.label));
  expect(pickEngCountQuestion(call.questions[0]!)).toBe(1);
  expect(matchesNativePlanQuestion(screen, call)).toBe(true);
  const active = capturePlanCountQuestion(screen, new Set(), 0, true, call)!;
  expect(active.nativeCall).toBe(call);
  expect(active.nativeQuestionIndex).toBe(0);
  expect(active.promptSnippet).toBe(`${call.questions[0]!.header} ${call.questions[0]!.question}`);
  expect(planCountQuestionInput(screen, active, 1)).toBe('1'); // computed only; no native key sent
});

for (const [name, visible] of [
  ['CRLF transport', screen.replaceAll('\n', '\r\n')],
  ['blank viewport padding', '\n \n' + screen],
  ['blank rail padding', '│\n' + screen],
  ['further viewport clipping', screen.slice(screen.indexOf('\n') + 1)],
] as const) test(`clipped native elision preserves ${name}`, () => {
  const call = pending();
  expect(matchesNativePlanQuestion(visible, call)).toBe(true);
  expect(capturePlanCountQuestion(visible, new Set(), 0, true, call)?.nativeCall).toBe(call);
});

const negatives: [string, (value: string) => string][] = [
  ['foreign introduction', value => 'Quoted earlier menu:\n' + value],
  ['fenced copy', value => '```text\n' + value + '\n```'],
  ['competing header', value => '☐ Other\n' + value],
  ['earlier menu', value => '❯ 1. Old option\n' + value],
  ['changed visible body', value => value.replace('Project/branch/task:', 'Unrelated/branch/task:')],
  ['missing elision', value => value.replace('DRY sme…', 'DRY sme')],
  ['invented body suffix', value => value.replace('DRY sme…', 'DRY smell and extra work…')],
  ['changed offered label', value => value.replace('1. Simplify class layout', '1. Expand feature scope')],
  ['reordered offered labels', value => value.replace('1. Simplify class layout', '1. Keep all five as proposed').replace('2. Keep all five as proposed', '2. Simplify class layout')],
  ['extra offered action', value => value.replace('4. Type something.', '4. New action')],
  ['missing footer', value => value.replace(' · Esc to cancel', '')],
  ['later prose', value => value + '\nAnother unrelated prompt'],
  ['options only', value => value.slice(cursor)],
  ['short common suffix', () => '│ a DRY sme…\n\n' + menu],
];
for (const [name, mutate] of negatives) test(`clipped elision cannot authorize ${name}`, () => {
  const changed = mutate(screen), call = pending();
  expect(changed).not.toBe(screen);
  expect(matchesNativePlanQuestion(changed, call)).toBe(false);
  expect(capturePlanCountQuestion(changed, new Set(), 0, true, call)?.nativeCall).toBeUndefined();
});

test('clipped native display uses the pinned UTF-16 boundary and tab substitution', () => {
  const call = pending();
  const prefix = 'Hidden first line\n' + 'a'.repeat(1999 - 'Hidden first line\n'.length - 1) + '\n';
  expect(prefix.length).toBe(1999);
  call.questions[0]!.question = prefix + '😀' + 'unrendered tail'.repeat(40);
  const visible = '│ ' + prefix.slice('Hidden first line\n'.length, 1400) + '\n│ ' + prefix.slice(1400) + '…\n\n' + menu;
  expect(matchesNativePlanQuestion(visible, call)).toBe(true);
  expect(matchesNativePlanQuestion(visible.replace('…', '\uD83D…'), call)).toBe(false);
  const tabCall = pending();
  tabCall.questions[0]!.question = tabCall.questions[0]!.question.replace('Project/branch/task: ', 'Project/branch/task:\t');
  expect(matchesNativePlanQuestion(screen, tabCall)).toBe(true);
});

test('the clipped prefix cannot borrow another elision boundary', () => {
  const longer = pending(), shorter = pending();
  longer.questions[0]!.question = 'X' + longer.questions[0]!.question;
  shorter.questions[0]!.question = shorter.questions[0]!.question.slice(1);
  expect(matchesNativePlanQuestion(screen, longer)).toBe(false);
  expect(matchesNativePlanQuestion(screen, shorter)).toBe(false);
});

test('an elided packet must match exactly one current native tab', () => {
  const call = pending(), other = structuredClone(call.questions[0]!);
  other.question = other.question.replace('Project/branch/task:', 'Other/branch/task:');
  call.questions.unshift(other);
  const pane = screen.replace('↑/↓ to navigate', 'Tab/Arrow keys to navigate');
  expect(matchesNativePlanQuestion(pane, call)).toBe(true);
  expect(capturePlanCountQuestion(pane, new Set(), 0, true, call)?.nativeQuestionIndex).toBe(1);
  call.questions[0] = structuredClone(call.questions[1]!);
  expect(matchesNativePlanQuestion(pane, call)).toBe(false);
});

test('pending state, exact commitment and deduplication remain required', () => {
  for (const call of [{ ...pending(), answered: true }, { ...pending(), failed: true }])
    expect(capturePlanCountQuestion(screen, new Set(), 0, true, call)?.nativeCall).toBeUndefined();
  const altered = pending();
  altered.questions[0]!.options[0]!.description += ' Also add cross-request coordination.';
  expect(() => pickEngCountQuestion(altered.questions[0]!)).toThrow('author-owned');
  const seen = new Set<string>(), call = pending();
  expect(capturePlanCountQuestion(screen, seen, 0, true, call)?.nativeCall).toBe(call);
  expect(capturePlanCountQuestion(screen, seen, 1, true, call)).toBeNull();
});

// The native CLI, not the model, prepends this plan-mode path block. Its
// basename is not independently witnessed: authority is limited to a direct
// Markdown child of the same session's isolated native plans directory.
const planningDirectory = planningCapture.pendingRecord.configDir + '/plans';
const planningScreen = planningCapture.screen;
const planningPane = planningScreen.slice(planningScreen.indexOf('─'));
const planningPath = planningScreen.slice(0, planningScreen.indexOf('─')).trimEnd().replaceAll('\n', '').slice('Planning: '.length);
function planningPending(): NativePlanQuestionCall {
  const record = structuredClone(planningCapture.pendingRecord.pending);
  return { sessionId: record.sessionId, toolUseId: record.toolUseId,
    questions: record.questions, answered: false, failed: false };
}
const withPlanning = (file: string, columns = 120) =>
  Bun.wrapAnsi('Planning: ' + file, columns, {hard:true,trim:false}).split('\n').map((row, index) =>
    (index && row.startsWith(' ') && Bun.stringWidth(row.slice(1)) > 0 ? row.slice(1) : row).trimEnd()).join('\n') + '\n' +
  planningPane.replace(/^─+/, '─'.repeat(columns));

test('actual owned Planning prelude binds the exact pending elided Eng D2', () => {
  expect(createHash('sha256').update(planningScreen).digest('hex')).toBe(planningCapture.provenance.screenSha256);
  expect(planningCapture.provenance.outcome).toBe('cancelled_confirmed_harness_stall');
  expect(withPlanning(planningPath)).toBe(planningScreen);
  const call = planningPending();
  expect(call.toolUseId).toBe('toolu_019V1fM5pvSC8bHaLVJgznms');
  expect(pickEngCountQuestion(call.questions[0]!)).toBe(1);
  expect(matchesNativePlanQuestion(planningScreen, call, planningDirectory)).toBe(true);
  const fp = capturePlanCountQuestion(planningScreen, new Set(), 0, true, call, planningDirectory)!;
  expect(fp.nativeCall).toBe(call);
  expect(fp.nativeQuestionIndex).toBe(0);
  expect(planCountQuestionInput(planningScreen, fp, 1)).toBe('1'); // computed only
});

for (const [name, visible, directory] of [
  ['unwrapped path', withPlanning(planningPath, 160), planningDirectory],
  ['three physical path rows', withPlanning(planningPath, 60), planningDirectory],
  ['native leading rule', '─'.repeat(120) + '\n' + planningScreen, planningDirectory],
  ['CRLF and blank viewport padding', '\r\n \r\n' + planningScreen.replaceAll('\n', '\r\n'), planningDirectory],
  ['another direct Markdown basename', withPlanning(planningDirectory + '/second_native-plan.md'), planningDirectory],
  ['spaces in the owned config path', withPlanning('/tmp/owned workspace/.claude/plans/native-plan.md', 40), '/tmp/owned workspace/.claude/plans'],
  ['wide characters in the owned config path', withPlanning('/tmp/工作区/.claude/plans/native-plan.md', 40), '/tmp/工作区/.claude/plans'],
  ['native soft-row space removal', withPlanning('/tmp/' + 'x'.repeat(15) + ' workspace/.claude/plans/native.md', 30), '/tmp/' + 'x'.repeat(15) + ' workspace/.claude/plans'],
] as const) test(`owned native Planning prelude supports ${name}`, () => {
  const call = planningPending();
  expect(matchesNativePlanQuestion(visible, call, directory)).toBe(true);
  expect(capturePlanCountQuestion(visible, new Set(), 0, true, call, directory)?.nativeCall).toBe(call);
});

for (const [name, visible, directory] of [
  ['absent ownership context', planningScreen, undefined],
  ['foreign session config', planningScreen, '/tmp/other-session/.claude/plans'],
  ['relative ownership context', planningScreen, 'plans'],
  ['sibling directory', withPlanning(planningDirectory + '-other/native.md'), planningDirectory],
  ['nested child', withPlanning(planningDirectory + '/nested/native.md'), planningDirectory],
  ['parent traversal', withPlanning(planningDirectory + '/../plans/native.md'), planningDirectory],
  ['dot traversal', withPlanning(planningDirectory + '/./native.md'), planningDirectory],
  ['non-Markdown path', withPlanning(planningDirectory + '/native.txt'), planningDirectory],
  ['quoted path', withPlanning('"' + planningPath + '"'), planningDirectory],
  ['quoted block', planningScreen.split('\n').map(row => '> ' + row).join('\n'), planningDirectory],
  ['open fence', '```text\n' + planningScreen, planningDirectory],
  ['extra leading prose', 'Earlier question:\n' + planningScreen, planningDirectory],
  ['extra prose after path', planningScreen.replace('\n─', '\nPlease choose now.\n─'), planningDirectory],
  ['blank gap before native rule', planningScreen.replace('\n─', '\n\n─'), planningDirectory],
  ['foreign native header', planningScreen.replace('☐ Structure', '☐ Other'), planningDirectory],
  ['changed current body', planningScreen.replace('Class arrangement:', 'Unrelated arrangement:'), planningDirectory],
  ['changed offered label', planningScreen.replace('1. Simplify class layout', '1. Add new product behavior'), planningDirectory],
  ['missing footer', planningScreen.replace(' · Esc to cancel', ''), planningDirectory],
  ['later prose', planningScreen + '\nAnother question', planningDirectory],
  ['wrong wrap width', planningScreen.replace(/^─+/m, '─'.repeat(119)), planningDirectory],
  ['invented early wrap', planningScreen.replace('Planning: /tmp/', 'Planning: /\ntmp/'), planningDirectory],
  ['mismatched leading rule', '─'.repeat(119) + '\n' + planningScreen, planningDirectory],
] as const) test(`native Planning prelude rejects ${name}`, () => {
  const call = planningPending();
  expect(matchesNativePlanQuestion(visible, call, directory)).toBe(false);
  expect(capturePlanCountQuestion(visible, new Set(), 0, true, call, directory)?.nativeCall).toBeUndefined();
});

test('Planning chrome never changes pending state, commitment policy or deduplication', () => {
  for (const call of [{...planningPending(),answered:true}, {...planningPending(),failed:true}])
    expect(capturePlanCountQuestion(planningScreen, new Set(), 0, true, call, planningDirectory)?.nativeCall).toBeUndefined();
  const altered = planningPending();
  altered.questions[0]!.options[0]!.description += ' Add cross-request behavior.';
  expect(() => pickEngCountQuestion(altered.questions[0]!)).toThrow('author-owned');
  const call = planningPending(), seen = new Set<string>();
  expect(capturePlanCountQuestion(planningScreen, seen, 0, true, call, planningDirectory)?.nativeCall).toBe(call);
  expect(capturePlanCountQuestion(planningScreen, seen, 1, true, call, planningDirectory)).toBeNull();
  expect(matchesNativePlanQuestion(planningPane, call)).toBe(true);
});
