import { describe, expect, test } from 'bun:test';
import { devexSeedCoverage } from './helpers/devex-seed-coverage';
import type { NativePlanQuestionCall, PlanCountTranscript } from './helpers/plan-count-transcript';
import fixture from './fixtures/dx-signature-identity-ak.json';
import { E2E_TOUCHFILES, matchGlob } from './helpers/touchfiles';

function transcript(): PlanCountTranscript {
  return { status: 'ready', calls: [structuredClone(fixture.call) as NativePlanQuestionCall], assistantMessages: [] };
}
function found(t: PlanCountTranscript) { return devexSeedCoverage(t).decisions['reversed-arguments'].length > 0; }
function question(t: PlanCountTranscript, change: (text: string) => string) {
  const c = t.calls[0]!, q = c.questions[0]!, selected = c.answers![q.question]!;
  q.question = change(q.question); c.answers = { [q.question]: selected };
}

describe('DX argument identities in the current decision explanation', () => {
  test('the actual completed D5 decision identifies the reversed seed without supplying the other four', () => {
    const t = transcript(), result = devexSeedCoverage(t);
    expect(found(t)).toBe(true);
    expect(result.decisions['reversed-arguments']).toEqual([`${fixture.call.sessionId}:${fixture.call.toolUseId}`]);
    expect(result.complete).toBe(false);
    expect(result.missing).toHaveLength(4);
  });
  test('inline signature formatting and source line-number changes preserve the same current identities', () => {
    for (const change of [
      (s: string) => s.replace('lines 5-9', 'lines 12–16'),
      (s: string) => s.replaceAll('`run_eval(dataset, evaluator)`', 'run_eval(dataset, evaluator)').replaceAll('`run_batch(evaluator, dataset)`', 'run_batch(evaluator, dataset)'),
      (s: string) => s.replace('Journey stage REAL USAGE: ', ''),
    ]) { const t = transcript(); question(t, change); expect(found(t)).toBe(true); }
  });
  test('same-order, foreign-function, missing-signature and borrowed-body evidence is insufficient', () => {
    for (const change of [
      (s: string) => s.replace('run_batch(evaluator, dataset)', 'run_batch(dataset, evaluator)'),
      (s: string) => s.replace('run_batch(evaluator, dataset)', 'run_many(evaluator, dataset)'),
      (s: string) => s.replace('run_eval(dataset, evaluator)', 'run_score(dataset, evaluator)'),
      (s: string) => s.replace(' and `run_batch(evaluator, dataset)`', ''),
      (s: string) => s.replace('ELI10: docs/api.md lines 5-9 define', 'ELI10: Another issue is worth discussing. docs/api.md lines 5-9 define'),
      (s: string) => s.replace('the two public functions take the same two arguments in opposite positional order. How should the plan fix the signatures?', 'Should the report mention both public functions?'),
    ]) { const t = transcript(); question(t, change); expect(found(t)).toBe(false); }
  });
  test('quoted, historical, hypothetical and conditional explanations cannot supply current identity', () => {
    for (const intro of ['Source excerpt: ', 'If approved: ', 'Historically, ', 'The following is a hypothetical example. ', '`', '> ']) {
      const t = transcript(); question(t, s => s.replace('ELI10: ', `ELI10: ${intro}`)); expect(found(t)).toBe(false);
    }
    for (const prefix of ['Source excerpt:\n', 'If approved:\n', 'Historical example:\n', '```\n']) {
      const t = transcript(); question(t, s => s.replace('ELI10:', `${prefix}ELI10:`)); expect(found(t)).toBe(false);
    }
    for (const phrase of ['used to define', 'would define', 'do not define']) {
      const t = transcript(); question(t, s => s.replace('lines 5-9 define', `lines 5-9 ${phrase}`)); expect(found(t)).toBe(false);
    }
    const t = transcript(); question(t, s => s.replace('on `main`; reviewing', 'on `main`; the following is a quoted source example, not a current finding; reviewing'));
    expect(found(t)).toBe(false);
  });
  test('same-finding withdrawals and corrected current order defeat the new route', () => {
    for (const tail of [
      'Correction: this finding is withdrawn.',
      'The argument-order issue is already resolved.',
      'These signatures are historical, not current.',
      'There is no argument-order defect.',
      'run_eval and run_batch now use the same positional order.',
    ]) { const t = transcript(); question(t, s => `${s}\n\n${tail}`); expect(found(t)).toBe(false); }
  });
  test('later literal quotations do not retract the actual decision', () => {
    for (const tail of [
      '> Correction: this finding is withdrawn.',
      'Old note: "The argument-order issue is already resolved."',
      '```\nThese signatures are historical, not current.\n```',
      'If this fix is accepted, the argument-order issue is already resolved in the proposed API.',
    ]) { const t = transcript(); question(t, s => `${s}\n\n${tail}`); expect(found(t)).toBe(true); }
  });
  test('the title and each inline signature must be asserted, with both new order and swap guard in one offered action', () => {
    for (const change of [
      (s: string) => s.replace('D5 — Journey', 'D5 — `Journey').replace('signatures?\n', 'signatures?`\n'),
      (s: string) => s.replace('`run_eval(dataset, evaluator)`', '`run_eval(dataset, evaluator)'),
    ]) { const t = transcript(); question(t, change); expect(found(t)).toBe(false); }
    for (const change of [
      (s: string) => s.replace('Both become', 'If approved, both become'),
      (s: string) => s.replace('Both become', 'Quoted source: Both become'),
      (s: string) => s.replace('(dataset, evaluator)', '(evaluator, dataset)'),
      (s: string) => s.replace('raise a call-site `TypeError`', 'raise a generic error'),
      (s: string) => s.replace('naming the swapped argument and the fix', 'without naming the swapped argument or a fix'),
    ]) {
      const t = transcript(); t.calls[0]!.questions[0]!.options[0]!.description = change(t.calls[0]!.questions[0]!.options[0]!.description!);
      expect(found(t)).toBe(false);
    }
  });
  test('a competing explanation or direct finding, explanation or offered-action withdrawal gives no credit', () => {
    for (const change of [
      (s: string) => s + '\nELI10: The public functions already use the same positional order; this is not a current defect.',
      (s: string) => s.replace(/^(ELI10:.*)$/m, '$1 Correction: this explanation is historical source material, not the current API.'),
      (s: string) => s + '\nCorrection: this argument-order issue is resolved.',
    ]) { const t = transcript(); question(t, change); expect(found(t)).toBe(false); }
    const t = transcript(); t.calls[0]!.questions[0]!.options[0]!.description += ' Correction: do not change either signature or add a swap guard.';
    expect(found(t)).toBe(false);
    const quoted = transcript(); question(quoted, s => s + '\n```\nELI10: The public functions already use the same positional order.\n```');
    quoted.calls[0]!.questions[0]!.options[0]!.description += '\nOld note: "Correction: do not change either signature or add a swap guard."';
    expect(found(quoted)).toBe(true);
  });
  test('the offered corrective option is required, while choosing a genuine alternate or defer remains a decision', () => {
    const t = transcript(), c = t.calls[0]!, q = c.questions[0]!;
    for (const option of q.options) { c.answers = { [q.question]: option.label }; expect(found(t)).toBe(true); }
    q.options = q.options.slice(2); c.answers = { [q.question]: q.options[0]!.label };
    expect(found(t)).toBe(false);
  });
  test('pending, failed, stale-answer, repeated identity and mixed-session native records stay invalid', () => {
    const mutations: Array<(t: PlanCountTranscript) => void> = [
      t => { t.calls[0]!.answered = false; }, t => { t.calls[0]!.failed = true; },
      t => { t.calls[0]!.unansweredQuestionIndices = [0]; }, t => { t.calls[0]!.answeredAt = 'invalid'; },
      t => { t.calls[0]!.answers = { 'A different question': t.calls[0]!.questions[0]!.options[0]!.label }; },
      t => { t.calls[0]!.questions[0]!.multiSelect = true; },
    ];
    for (const change of mutations) { const t = transcript(); change(t); expect(found(t)).toBe(false); }
    const duplicated = transcript(); duplicated.calls.push(structuredClone(duplicated.calls[0]!));
    expect(devexSeedCoverage(duplicated).invalid.length).toBeGreaterThan(0);
    const foreign = transcript(); foreign.calls.push({ ...structuredClone(foreign.calls[0]!), sessionId: 'foreign', toolUseId: 'foreign' });
    expect(devexSeedCoverage(foreign).invalid.length).toBeGreaterThan(0);
  });
  test('only the DX count owner gains the live regression test and public fixture', () => {
    for (const file of ['test/dx-signature-identity-ak.test.ts', 'test/fixtures/dx-signature-identity-ak.json']) {
      expect(Object.entries(E2E_TOUCHFILES).filter(([, deps]) => deps.some(p => matchGlob(file, p))).map(([name]) => name)).toEqual(['plan-devex-finding-count']);
    }
  });
});
