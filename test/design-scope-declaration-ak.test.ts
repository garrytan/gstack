import { expect, test } from 'bun:test';
import { nativeSeededPlanSelection } from './helpers/plan-scope-selection';
import fixture from './fixtures/design-scope-declaration-ak.json';
import type { PlanCountTranscript, NativePublicToolEvent } from './helpers/plan-count-transcript';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';

const input = (attempt = 0) => structuredClone(fixture.attempts[attempt]!.projection);
const verdict = (p = input()) => nativeSeededPlanSelection(p.transcript as PlanCountTranscript, p.tools as NativePublicToolEvent[], p.opts);
const declaration = (p: ReturnType<typeof input>) => p.transcript.assistantMessages.find(m => /^(?:I'll proceed with reviewing|Scope gate confirms plan mode)/.test(m.text))!;

test('both exact owned post-load announcements select the named pasted draft', () => {
  for (let attempt = 0; attempt < 2; attempt++) {
    const p = input(attempt);
    expect(fixture.attempts[attempt]!.rawScopeGateAutoSelectObserved).toBe(false);
    expect(verdict(p)).toBe(true);
  }
});

test('the prior AJ pre-load-only announcement still supplies no selected-plan evidence', () => {
  const p = fixture.priorGenuineFailure.projection;
  expect(nativeSeededPlanSelection(p.transcript as PlanCountTranscript, p.tools as NativePublicToolEvent[], p.opts)).toBe(false);
});

test('target identity and ordinary equivalent current review wording remain bound', () => {
  for (let attempt = 0; attempt < 2; attempt++) {
    const p = input(attempt); p.opts.seed = p.opts.seed.replace('Marketing landing page', 'Account settings');
    p.transcript.assistantMessages.forEach(m => { m.text = m.text.replaceAll('Marketing landing page', 'Account settings'); });
    expect(verdict(p)).toBe(true);
  }
  const p = input(); declaration(p).text = declaration(p).text.replace("I'll proceed", 'I will proceed'); expect(verdict(p)).toBe(true);
});

test('source, historical, quoted, hypothetical and conditional introductions do not select', () => {
  for (let attempt = 0; attempt < 2; attempt++) for (const prefix of [
    '> ', '    ', 'Source excerpt:\n', 'Historical example only.\n', 'The following is hypothetical. ', 'If approved, ', '```\n', '"',
  ]) {
    const p = input(attempt), m = declaration(p); p.transcript.assistantMessages = [m]; m.text = prefix + m.text;
    expect(verdict(p)).toBe(false);
  }
});

test('a different target or conditional scope announcement cannot borrow the draft name', () => {
  for (let attempt = 0; attempt < 2; attempt++) for (const change of [
    (s: string) => s.replaceAll('Marketing landing page', 'Checkout redesign'),
    (s: string) => s.replace(/draft(?: plan)?/, 'draft plan if approved'),
  ]) { const p = input(attempt), m = declaration(p); p.transcript.assistantMessages = [m]; m.text = change(m.text); expect(verdict(p)).toBe(false); }
  for (const prefix of ['Scope gate might confirm plan mode, so', 'Scope gate confirms branch mode, so']) {
    const p = input(1); declaration(p).text = declaration(p).text.replace('Scope gate confirms plan mode, so', prefix); expect(verdict(p)).toBe(false);
  }
});

test('the same successful Skill load and post-command current session remain necessary', () => {
  for (let attempt = 0; attempt < 2; attempt++) for (const change of [
    (p: ReturnType<typeof input>) => { p.opts.sessionId = 'foreign'; },
    (p: ReturnType<typeof input>) => { p.tools[1]!.isError = true; },
    (p: ReturnType<typeof input>) => { p.tools[1]!.toolUseId = 'foreign'; },
    (p: ReturnType<typeof input>) => { p.tools[0]!.input!.skill = 'plan-eng-review'; },
    (p: ReturnType<typeof input>) => { p.opts.commandStartedAt = Date.parse(p.tools[1]!.timestamp) + 1; },
    (p: ReturnType<typeof input>) => { declaration(p).timestamp = new Date(Date.parse(p.tools[1]!.timestamp) - 1).toISOString(); p.transcript.assistantMessages = [declaration(p)]; },
  ]) { const p = input(attempt); change(p); expect(verdict(p)).toBe(false); }
});

test('same-message and later current withdrawals or replacement targets defeat selection', () => {
  for (let attempt = 0; attempt < 2; attempt++) for (const correction of [
    'Correction: this selection is withdrawn.',
    'The selected target is now the branch diff.',
    'This declaration has been retracted.',
  ]) for (const later of [false, true]) {
    const p = input(attempt), m = declaration(p); p.transcript.assistantMessages = [m];
    if (later) p.transcript.assistantMessages.push({ ...m, timestamp: new Date(Date.parse(m.timestamp) + 1000).toISOString(), text: correction });
    else m.text += '\n' + correction;
    expect(verdict(p)).toBe(false);
  }
});

test('literal or foreign corrections preserve the actual declaration and a later reselection is current', () => {
  for (let attempt = 0; attempt < 2; attempt++) {
    const p = input(attempt), m = declaration(p); p.transcript.assistantMessages = [m];
    p.transcript.assistantMessages.push({ ...m, sessionId: 'foreign', text: 'The selected target is now the branch diff.' });
    p.transcript.assistantMessages.push({ ...m, text: '> This selection is withdrawn.' }); expect(verdict(p)).toBe(true);
    p.transcript.assistantMessages.push({ ...m, timestamp: new Date(Date.parse(m.timestamp) + 1000).toISOString(), text: 'This selection is withdrawn.' }); expect(verdict(p)).toBe(false);
    p.transcript.assistantMessages.push({ ...m, timestamp: new Date(Date.parse(m.timestamp) + 2000).toISOString() }); expect(verdict(p)).toBe(true);
  }
});

test('the new evidence dependencies select exactly the existing five scope observers', () => {
  const expected = selectTests(['test/helpers/plan-scope-selection.ts'], E2E_TOUCHFILES, []).selected;
  expect(expected).toHaveLength(5);
  for (const path of ['test/design-scope-declaration-ak.test.ts','test/fixtures/design-scope-declaration-ak.json']) expect(selectTests([path], E2E_TOUCHFILES, []).selected).toEqual(expected);
});
