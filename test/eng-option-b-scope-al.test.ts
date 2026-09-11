import { expect, test } from 'bun:test';
import { nativeSeededPlanSelection } from './helpers/plan-scope-selection';
import type { NativePublicToolEvent, PlanCountTranscript } from './helpers/plan-count-transcript';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';
import fixture from './fixtures/eng-option-b-scope-al.json';

const input = (attempt = 1) => structuredClone(fixture.attempts[attempt]!.projection);
type Input = ReturnType<typeof input>;
const verdict = (p = input()) => nativeSeededPlanSelection(p.transcript as PlanCountTranscript, p.tools as NativePublicToolEvent[], p.opts);
const declaration = (p: Input) => p.transcript.assistantMessages.find(m => m.text.startsWith("I've selected option B,"))!;

test('both named retry and fresh unique-draft first introduction bind; original outcomes stay intact', () => {
  expect(fixture.attempts.map(a => a.rawScopeGateAutoSelectObserved)).toEqual([false, false]);
  expect(verdict(input(0))).toBe(true);
  expect(verdict(input(1))).toBe(true);
});

test('the named target is necessary; an unnamed option-B notice supplies no selection', () => {
  const p = input(); p.transcript.assistantMessages = p.transcript.assistantMessages.filter(m => m !== declaration(p));
  expect(verdict(p)).toBe(false);
  for (const replacement of ['option A,', 'option C,', 'option B if approved,', 'option B, possibly']) {
    const p = input(); declaration(p).text = declaration(p).text.replace('option B,', replacement); expect(verdict(p)).toBe(false);
  }
  for (const target of ['Unrelated draft', 'branch diff']) {
    const p = input(); declaration(p).text = declaration(p).text.replace('Parallelize unit tests', target); expect(verdict(p)).toBe(false);
  }
});

test('equivalent current wording and consistently renamed title preserve selection', () => {
  for (const change of [
    (s: string) => s.replace("I've", 'I have'),
    (s: string) => s.replace('Next I', 'Next, I'),
    (s: string) => s.replace('reviewing the pasted', 'to review the pasted'),
    (s: string) => s.replace(/\. Next.*$/, '.'),
    (s: string) => s.replace('Design Doc Check, brain context, and context recovery, along with the Aside probe', 'audit for DESIGN.md'),
  ]) { const p = input(); declaration(p).text = change(declaration(p).text); expect(verdict(p)).toBe(true); }
  const p = input(); p.opts.seed = p.opts.seed.replace('Parallelize unit tests', 'Build cache invalidation');
  declaration(p).text = declaration(p).text.replace('Parallelize unit tests', 'Build cache invalidation'); expect(verdict(p)).toBe(true);
});

test('quoted, source, hypothetical, historical and conditional first lines cannot select', () => {
  for (const prefix of ['> ', '    ', '\t', '```\n', 'Source excerpt:\n', 'Historical example only.\n', 'The following is a hypothetical example. ', 'If approved, ', '"']) {
    const p = input(); declaration(p).text = prefix + declaration(p).text; expect(verdict(p)).toBe(false);
  }
});

test('the same successful post-command Skill completion and current native session are required', () => {
  for (const change of [
    (p: Input) => { p.opts.sessionId = 'foreign'; },
    (p: Input) => { p.transcript.status = 'unavailable'; },
    (p: Input) => { p.tools = []; },
    (p: Input) => { p.tools[0]!.input!.skill = 'plan-design-review'; },
    (p: Input) => { p.tools[1]!.isError = true; },
    (p: Input) => { p.tools[1]!.sessionId = 'foreign'; },
    (p: Input) => { p.tools[1]!.toolUseId = 'unrelated'; },
    (p: Input) => { p.opts.commandStartedAt = Date.parse(p.tools[0]!.timestamp) + 1; },
    (p: Input) => { declaration(p).timestamp = new Date(p.opts.commandStartedAt - 1).toISOString(); },
    (p: Input) => { declaration(p).sessionId = 'foreign'; },
    (p: Input) => { p.tools.push(structuredClone(p.tools[1]!)); },
  ]) { const p = input(); change(p); expect(verdict(p)).toBe(false); }
});

test('conditional, questioning and replacement continuations cannot borrow a completed selection', () => {
  for (const change of [
    (s: string) => s.replace('draft plan.', 'draft plan if approved.'),
    (s: string) => s.replace('Next I', 'If approved, I'),
    (s: string) => s.replace('Aside probe.', 'Aside probe?'),
    (s: string) => s.replace('Design Doc Check', 'branch diff review instead'),
    (s: string) => s.replace('Design Doc Check', 'unrelated work'),
  ]) { const p = input(); declaration(p).text = change(declaration(p).text); expect(verdict(p)).toBe(false); }
});

test('same-message or later owned withdrawals and target changes defeat the declaration', () => {
  for (const correction of ['Correction: this selection is withdrawn.', 'This declaration has been retracted.', 'The selected target is now the branch diff.']) {
    for (const placement of ['same-line', 'same-message', 'later']) {
      const p = input(), m = declaration(p);
      if (placement === 'later') p.transcript.assistantMessages.push({ ...m, timestamp: new Date(Date.parse(m.timestamp) + 1000).toISOString(), text: correction });
      else m.text += (placement === 'same-line' ? ' ' : '\n') + correction;
      expect(verdict(p)).toBe(false);
    }
  }
});

test('foreign, historical and literal corrections do not retract a current named selection', () => {
  for (const text of ['> This selection is withdrawn.', 'Source excerpt:\nThis selection is withdrawn.', 'A prior assistant said "This selection is withdrawn."', 'The verification suite is withdrawn.', 'Is this selection withdrawn?']) {
    const p = input(), m = declaration(p); p.transcript.assistantMessages.push({ ...m, timestamp: new Date(Date.parse(m.timestamp) + 1000).toISOString(), text }); expect(verdict(p)).toBe(true);
  }
  const p = input(), m = declaration(p); p.transcript.assistantMessages.push({ ...m, sessionId: 'foreign', text: 'This selection is withdrawn.' }); expect(verdict(p)).toBe(true);
});

test('a later explicit reselection follows the existing currentness rule', () => {
  const p = input(), m = declaration(p); p.transcript.assistantMessages.push({ ...m, timestamp: new Date(Date.parse(m.timestamp) + 1000).toISOString(), text: 'This selection is withdrawn.' }); expect(verdict(p)).toBe(false);
  p.transcript.assistantMessages.push({ ...m, timestamp: new Date(Date.parse(m.timestamp) + 2000).toISOString() }); expect(verdict(p)).toBe(true);
});

test('both new dependencies select exactly the existing five scope observers', () => {
  const expected = selectTests(['test/helpers/plan-scope-selection.ts'], E2E_TOUCHFILES, []).selected;
  expect(expected).toHaveLength(5);
  for (const path of ['test/eng-option-b-scope-al.test.ts', 'test/fixtures/eng-option-b-scope-al.json']) expect(selectTests([path], E2E_TOUCHFILES, []).selected).toEqual(expected);
});

for (const owner of [
  'plan-ceo-review-plan-mode', 'plan-eng-review-plan-mode',
  'plan-design-review-plan-mode', 'plan-devex-review-plan-mode', 'plan-mode-no-op',
]) test(`scope dependency registration is dense for ${owner}`, () => {
  const paths = E2E_TOUCHFILES[owner]!;
  for (let index = 0; index < paths.length; index++) {
    expect(Object.hasOwn(paths, index)).toBe(true);
    expect(typeof paths[index]).toBe('string');
  }
});
