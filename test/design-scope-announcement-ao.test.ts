import { expect, test } from 'bun:test';
import captured from './fixtures/design-scope-announcement-ao.json';
import { nativeSeededPlanSelection } from './helpers/plan-scope-selection';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';
import type { PlanCountTranscript, NativePublicToolEvent } from './helpers/plan-count-transcript';

const input = () => structuredClone(captured.projection);
type Input = ReturnType<typeof input>;
const announcement = (p: Input) => p.transcript.assistantMessages.find(m => m.sessionId === p.opts.sessionId && m.text.startsWith("I'll auto-select"))!;
const verdict = (p: Input) => nativeSeededPlanSelection(p.transcript as PlanCountTranscript, p.tools as NativePublicToolEvent[], p.opts);

test('the exact owned post-load option B announcement selects the seeded title', () => {
  expect(captured.rawScopeGateAutoSelectObserved).toBe(false);
  expect(verdict(input())).toBe(true);
});

test('equivalent explicit selection words and balanced title quotes retain identity', () => {
  for (const prefix of ["I'll auto-select", 'I will auto-select', "I'll auto select"]) {
    for (const title of ['Marketing landing page', '"Marketing landing page"', '“Marketing landing page”', '`Marketing landing page`']) {
      const p = input(), m = announcement(p);
      m.text = m.text.replace("I'll auto-select", prefix).replace('Marketing landing page', title);
      expect(verdict(p)).toBe(true);
    }
  }
  const p = input(), m = announcement(p);
  p.opts.seed = p.opts.seed.replace('Marketing landing page', 'Account settings');
  m.text = m.text.replace('Marketing landing page', 'Account settings');
  expect(verdict(p)).toBe(true);
});

const rejected: Array<[string, (p: Input) => void]> = [
  ['wrong option', p => { announcement(p).text = announcement(p).text.replace('option B', 'option A'); }],
  ['wrong target', p => { announcement(p).text = announcement(p).text.replace('Marketing landing page', 'Account settings'); }],
  ['target prefix only', p => { announcement(p).text = announcement(p).text.replace('page draft', 'page experiment draft'); }],
  ['conditional selection', p => { announcement(p).text = 'If approved: ' + announcement(p).text; }],
  ['source selection', p => { announcement(p).text = 'Source excerpt:\n' + announcement(p).text; }],
  ['quoted selection', p => { announcement(p).text = '> ' + announcement(p).text; }],
  ['wholly quoted selection', p => { announcement(p).text = '"' + announcement(p).text + '"'; }],
  ['unbalanced target quotes', p => { announcement(p).text = announcement(p).text.replace('Marketing landing page', '"Marketing landing page'); }],
  ['question instead of assertion', p => { announcement(p).text = announcement(p).text.replace(/\.$/, '?'); }],
  ['conditional tail', p => { announcement(p).text = announcement(p).text.replace(', running', ' if approved, running'); }],
  ['cancelled selection', p => { announcement(p).text += '\nCorrection: this selection is withdrawn.'; }],
  ['quoted status cancellation', p => { announcement(p).text += '\nThis selection is "withdrawn".'; }],
  ['replaced target', p => { announcement(p).text += '\nThe selected target is now the branch diff.'; }],
  ['pre-load announcement', p => { announcement(p).timestamp = new Date(Date.parse(p.tools[1]!.timestamp) - 1).toISOString(); }],
  ['foreign announcement', p => { announcement(p).sessionId = 'foreign'; }],
  ['foreign load result', p => { p.tools[1]!.sessionId = 'foreign'; }],
  ['failed skill load', p => { p.tools[1]!.isError = true; }],
  ['wrong skill', p => { p.tools[0]!.input!.skill = 'plan-eng-review'; }],
  ['late command start', p => { p.opts.commandStartedAt = Date.parse(p.tools[1]!.timestamp) + 1; }],
  ['multiple seed titles', p => { p.opts.seed += '\n# Another plan\n'; }],
];
test.each(rejected)('%s supplies no scope selection', (_, change) => {
  const p = input(); change(p); expect(verdict(p)).toBe(false);
});

test('quoted historical or foreign withdrawals do not replace the current selection', () => {
  for (const correction of ['> This selection is withdrawn.', 'Historical note: "This selection is withdrawn."']) {
    const p = input(); announcement(p).text += '\n' + correction; expect(verdict(p)).toBe(true);
  }
  const p = input(), m = announcement(p);
  p.transcript.assistantMessages.push({ ...m, sessionId: 'foreign', text: 'This selection is withdrawn.' });
  expect(verdict(p)).toBe(true);
});

test('a later current withdrawal invalidates selection until a later reselection', () => {
  const p = input(), m = announcement(p);
  p.transcript.assistantMessages.push({ ...m, timestamp: new Date(Date.parse(m.timestamp) + 1000).toISOString(), text: 'This selection is withdrawn.' });
  expect(verdict(p)).toBe(false);
  p.transcript.assistantMessages.push({ ...m, timestamp: new Date(Date.parse(m.timestamp) + 2000).toISOString() });
  expect(verdict(p)).toBe(true);
});

test('both regression sources select the same five existing scope observers', () => {
  const expected = selectTests(['test/helpers/plan-scope-selection.ts'], E2E_TOUCHFILES, []).selected;
  expect(expected).toHaveLength(5);
  for (const path of ['test/design-scope-announcement-ao.test.ts', 'test/fixtures/design-scope-announcement-ao.json']) {
    expect(selectTests([path], E2E_TOUCHFILES, []).selected).toEqual(expected);
  }
});
