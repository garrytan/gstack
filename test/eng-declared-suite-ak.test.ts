import { expect, test } from 'bun:test';
import fixture from './fixtures/eng-declared-suite-ak.json';
import { evaluateEngSeedCoverage } from './helpers/eng-seeded-coverage';
import type { PlanCountTranscript } from './helpers/plan-count-transcript';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';

const plan = [fixture.required, '## Implementation Tasks\n\n' + fixture.task, fixture.verification, fixture.reviewReport].join('\n\n');
const { start, end } = fixture.provenance.window;
const native = () => structuredClone(fixture.transcript) as PlanCountTranscript;
const evaluate = (p = plan, t = native()) => evaluateEngSeedCoverage(t, p, start, end);

test('the required characterization suite binds the current legacy oracle, task and both router paths', () => {
  expect(evaluate().regression).toBe('plan');
  expect(evaluate().ok).toBe(true);
});

test('presentation and task/router identity vary without weakening the baseline', () => {
  for (const p of [
    plan.replaceAll('T7', 'T19'),
    plan.replaceAll('routeAuth', 'dispatchAuth'),
    plan.replace('before touching it', 'before refactoring it'),
    plan.replace('capture current inputs and outputs', 'record current inputs and outputs'),
    plan.replaceAll('tests/regression', 'tests/auth-regression'),
    plan.replace('success,\nexpired token, bad signature', 'success,\nexpired token, invalid audience'),
    plan + '\n## Assessment of T12\nT12 is cancelled.',
    plan + '\n## Payment regression suite\nThe regression suite is no longer required.',
    plan.replace(fixture.task, fixture.task + '\nOld note: "T7 is cancelled."'),
    plan + '\n## Historical note\n"The legacy regression suite is no longer required."',
    plan.replace(fixture.task, '- [ ] T6 — tests/renderer — Test display text\n  - Verify: renders the literal text "This is a hypothetical example."\n\n' + fixture.task),
  ]) { expect(p).not.toBe(plan); expect(evaluate(p).regression).toBe('plan'); }
});

test('the declaration and task require current legacy capture on both paths', () => {
  for (const p of [
    plan.replace(fixture.required, ''), plan.replace(fixture.task, ''), plan.replace(fixture.verification, ''),
    plan.replace('mandatory rule, no approval needed', 'optional future idea'),
    plan.replace('before touching it', 'after rewriting it'),
    plan.replace('capture current inputs and outputs', 'describe proposed inputs and outputs'),
    plan.replace('the same suite against `routeAuth` on both flag settings', 'the same suite against `routeAuth` on the new setting'),
    plan.replace('A behavior difference between\npaths is a test failure', 'A behavior difference between\npaths is acceptable'),
    plan.replace('suite for legacyAuthFlow(), run on both router paths', 'suite for newAuthFlow(), run on both router paths'),
    plan.replace('suite passes on legacy before any refactor', 'suite passes on legacy after the refactor'),
    plan.replace('passes on new path before flag enable', 'passes on new path after flag enable'),
  ]) { expect(p).not.toBe(plan); expect(evaluate(p).regression).toBeUndefined(); }
});

test('the comparison uses the unchanged legacy result before the refactor', () => {
  for (const p of [
    plan.replace('on the unmodified code', 'on the modified code'),
    plan.replace('against `legacyAuthFlow()` on the unmodified code', 'against `newAuthFlow()` on the unmodified code'),
    plan.replace('must pass before any refactor lands', 'may pass after the refactor lands'),
    plan.replace('through `routeAuth` with the flag on `new`', 'through `differentRouter` with the flag on `new`'),
    plan.replace('with the flag on `new`', 'with the flag on `legacy`'),
    plan.replace('zero differences', 'accepted differences'),
    plan.replace(/^1\. Run the characterization.+$/m, ''),
    plan.replace(/^3\. Run the characterization.+$/m, ''),
    plan.replace(/^1\. Run the characterization/m, '4. Run the characterization'),
    plan.replace(/^1\. Run the characterization/m, 'If approved:\n1. Run the characterization'),
    plan.replace(/^3\. Run the characterization/m, 'If approved:\n3. Run the characterization'),
  ]) { expect(p).not.toBe(plan); expect(evaluate(p).regression).toBeUndefined(); }
});

test('quoted, proposed and conditional owners cannot provide the current requirement', () => {
  for (const p of [
    '# Source\n\n' + plan,
    '# Hypothetical example\n\n' + plan,
    'The following is source text only.\n\n' + plan,
    plan.replace(fixture.required, '```md\n' + fixture.required + '\n```'),
    plan.replace(fixture.task, fixture.task.split('\n').map(s => '> ' + s).join('\n')),
    plan.replace(fixture.verification, '```md\n' + fixture.verification + '\n```'),
    plan.replace('### REGRESSION', '### Proposed REGRESSION'),
    plan.replace('**Add a characterization', '**If approved, add a characterization'),
    plan.replace('**Add a characterization', 'If approved:\n**Add a characterization'),
    plan.replace(fixture.task, 'If approved:\n' + fixture.task),
    plan.replace('## Implementation Tasks', '## Optional Implementation Tasks'),
    plan.replace('## Verification (end to end)', '## Quoted Verification (end to end)'),
    plan.replace('**Add a characterization', 'The following is a quoted source excerpt.\n**Add a characterization'),
    plan.replace('1. Run the characterization', 'The following is a quoted source excerpt.\n1. Run the characterization'),
    plan.replace('  - Verify: suite passes', '  If approved:\n  - Verify: suite passes'),
  ]) { expect(evaluate(p).regression).toBeUndefined(); }
});

test('the owned suite, numbered task and baseline may be explicitly withdrawn', () => {
  for (const p of [
    plan.replace(fixture.required, fixture.required + '\nThis suite is withdrawn.'),
    plan.replace(fixture.task, fixture.task + '\nT7 is cancelled.'),
    plan + '\n## Assessment of T7\nT7 is rejected.',
    plan + '\n## Final regression suite assessment\nThe regression suite is no longer required.',
    plan + '\n## Payment regression suite\nThe legacy regression suite is no longer required.',
    plan.replace(fixture.verification, fixture.verification + '\nThis baseline is no longer required.'),
    plan.replace(fixture.verification, fixture.verification + '\nSkip the characterization suite.'),
    plan.replace(fixture.task, fixture.task + '\nCorrection: this unchanged-code verification is withdrawn.'),
  ]) expect(evaluate(p).regression).toBeUndefined();
});

for (const prefix of ['If approved:', 'The following is a quoted source excerpt.']) {
  test(`a previous task cannot hide the next task's owning prefix: ${prefix}`, () => {
    const p = plan.replace(fixture.task, '- [ ] T6 — tests/setup — Prepare fixtures\n  - Verify: setup is ready.\n\n' + prefix + '\n' + fixture.task);
    expect(evaluate(p).regression).toBeUndefined();
  });
}

test('all four separate owned decisions and the final review report remain required', () => {
  expect(evaluate().missing).toEqual([]);
  expect(new Set(Object.values(evaluate().decisions)).size).toBe(4);
  expect(evaluate(plan.replace(fixture.reviewReport, '')).ok).toBe(false);
  for (const mutate of [
    (t: PlanCountTranscript) => { t.calls[0]!.answered = false; },
    (t: PlanCountTranscript) => { t.calls[0]!.sessionId = 'foreign'; },
    (t: PlanCountTranscript) => { t.calls[0]!.answeredAt = new Date(start - 1).toISOString(); },
    (t: PlanCountTranscript) => { t.calls[0]!.answeredAt = new Date(end + 1).toISOString(); },
    (t: PlanCountTranscript) => { t.calls.push(structuredClone(t.calls[0]!)); },
  ]) { const t = native(); mutate(t); expect(evaluate(plan, t).ok).toBe(false); }
});

test('the new exact public regression evidence belongs only to the existing Eng count owner', () => {
  for (const file of ['test/eng-declared-suite-ak.test.ts', 'test/fixtures/eng-declared-suite-ak.json']) {
    expect(selectTests([file], E2E_TOUCHFILES, []).selected).toEqual(['plan-eng-finding-count']);
  }
});
