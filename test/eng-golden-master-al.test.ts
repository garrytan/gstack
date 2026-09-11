import { expect, test } from 'bun:test';
import fixture from './fixtures/eng-golden-master-al.json';
import { evaluateEngSeedCoverage } from './helpers/eng-seeded-coverage';
import type { PlanCountTranscript } from './helpers/plan-count-transcript';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';

const plan = [fixture.required, '## Implementation Tasks\n\n' + fixture.task, fixture.verification, fixture.reviewReport].join('\n\n');
const { start, end } = fixture.provenance.window;
const native = () => structuredClone(fixture.transcript) as PlanCountTranscript;
const evaluate = (p = plan, t = native()) => evaluateEngSeedCoverage(t, p, start, end);

test('the captured golden-master requirement binds a numbered task to an untouched baseline', () => {
  expect(evaluate().regression).toBe('plan');
  expect(evaluate().ok).toBe(true);
});

test('task identities and presentation may vary without changing the required oracle', () => {
  for (const p of [
    plan.replaceAll('T1', 'T23'),
    plan.replace('— legacy —', '— auth/legacy —'),
    plan.replaceAll('golden-master', 'golden master'),
    plan.replace('Capture current outputs', 'Record current outputs'),
    plan.replace('identical behaviour', 'identical behavior'),
    plan.replace('success / expired / revoked / wrong-tenant /\nlogout', 'success / invalid audience / expired'),
    plan + '\n## Assessment of T8\nT8 is cancelled.',
    plan + '\n## Payment regression suite\nThe regression suite is no longer required.',
    plan + '\n## Payment golden-master fixtures\nThe golden-master fixtures are no longer required.',
    plan + '\n## Historical note\n"The legacy regression suite is no longer required."',
    plan.replace(fixture.task, '- [ ] T0 — renderer — Test literal output\n  - Verify: renders "This is a hypothetical example."\n\n' + fixture.task),
  ]) { expect(p).not.toBe(plan); expect(evaluate(p).regression).toBe('plan'); }
});

test('the mandatory declaration, numbered task and linked verification are all necessary', () => {
  for (const p of [
    plan.replace(fixture.required, ''), plan.replace(fixture.task, ''), plan.replace(fixture.verification, ''),
    plan.replace('regression rule, mandatory', 'optional future idea'),
    plan.replace('Capture current outputs', 'Describe proposed outputs'),
    plan.replace('BEFORE any change', 'AFTER the rewrite'),
    plan.replace('assert identical behaviour', 'accept different behaviour'),
    plan.replace('`legacyAuthFlow` golden-master', '`newAuthFlow` golden-master'),
    plan.replace('fixtures for legacyAuthFlow', 'fixtures for newAuthFlow'),
    plan.replace('fixtures for legacyAuthFlow before any change', 'fixtures for legacyAuthFlow after the rewrite'),
    plan.replace('fixtures pass against untouched legacy', 'fixtures pass against modified legacy'),
    plan.replace('rerun after every later task', 'rerun optionally after launch'),
    plan.replace('1. Run T1 fixtures', '1. Run T9 fixtures'),
    plan.replace('2. After each task, rerun the full suite plus T1 fixtures.', '2. After each task, rerun the full suite plus T9 fixtures.'),
    plan.replace('before touching anything; they must pass', 'after rewriting legacy; they may pass'),
    plan.replace('1. Run T1 fixtures', '3. Run T1 fixtures'),
  ]) { expect(p).not.toBe(plan); expect(evaluate(p).regression).toBeUndefined(); }
});

test('source, conditional and optional owners cannot provide current mandatory evidence', () => {
  for (const p of [
    '# Source\n\n' + plan,
    '# Hypothetical example\n\n' + plan,
    'The following is source text only.\n\n' + plan,
    plan.replace(fixture.required, '```md\n' + fixture.required + '\n```'),
    plan.replace(fixture.task, fixture.task.split('\n').map(s => '> ' + s).join('\n')),
    plan.replace(fixture.verification, '```md\n' + fixture.verification + '\n```'),
    plan.replace('**CRITICAL', 'If approved:\n**CRITICAL'),
    plan.replace('**CRITICAL', 'The following is a quoted source excerpt.\n**CRITICAL'),
    plan.replace('**CRITICAL', 'Source excerpt:\n\n**CRITICAL'),
    plan.replace(/Capture current outputs[\s\S]*?no existing coverage\./, claim => '`' + claim + '`'),
    plan.replace(fixture.task, 'If approved:\n' + fixture.task),
    plan.replace(fixture.task, 'The following is a quoted source excerpt.\n' + fixture.task),
    plan.replace('## Implementation Tasks', '## Optional Implementation Tasks'),
    plan.replace('## Verification', '## Quoted Verification'),
    plan.replace('1. Run T1', 'If approved:\n1. Run T1'),
    plan.replace('1. Run T1', 'The following is a quoted source excerpt.\n1. Run T1'),
    plan.replace('1. Run T1', 'Source excerpt:\n\n1. Run T1'),
    plan.replace('  - Verify:', '  If approved:\n  - Verify:'),
  ]) { expect(p).not.toBe(plan); expect(evaluate(p).regression).toBeUndefined(); }
});

test('a previous unrelated task cannot hide a source or conditional prefix', () => {
  for (const prefix of ['If approved:', 'The following is a quoted source excerpt.']) {
    const p = plan.replace(fixture.task, '- [ ] T0 — setup — Prepare fixtures\n  - Verify: setup passes.\n\n' + prefix + '\n' + fixture.task);
    expect(evaluate(p).regression).toBeUndefined();
  }
});

test('the required suite, numbered task, and unchanged verification remain withdrawable', () => {
  for (const p of [
    plan.replace(fixture.required, fixture.required + '\nThis suite is withdrawn.'),
    plan.replace(fixture.task, fixture.task + '\nT1 is cancelled.'),
    plan + '\n## Assessment of T1\nT1 is rejected.',
    plan + '\n## Final regression suite assessment\nThe regression suite is no longer required.',
    plan + '\n## Payment regression suite\nThe legacy regression suite is no longer required.',
    plan.replace(fixture.verification, fixture.verification + '\nThis baseline is no longer required.'),
    plan.replace(fixture.task, fixture.task + '\nCorrection: this unchanged-code verification is withdrawn.'),
    plan.replace(fixture.verification, fixture.verification + '\nCorrection: the T1 rerun is withdrawn.'),
    plan + '\n## Final regression assessment\nThe golden-master fixtures are no longer required.',
    plan + '\n## Payment regression suite\nThe legacy golden-master fixtures are withdrawn.',
    plan.replace('T1 (P1,', 'T1 (optional,'),
  ]) { expect(p).not.toBe(plan); expect(evaluate(p).regression).toBeUndefined(); }
});

test('the four completed owned decisions and final review report remain required', () => {
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

test('only the existing Eng finding-count owner selects these public evidence regressions', () => {
  for (const file of ['test/eng-golden-master-al.test.ts', 'test/fixtures/eng-golden-master-al.json']) {
    expect(selectTests([file], E2E_TOUCHFILES, []).selected).toEqual(['plan-eng-finding-count']);
  }
});
