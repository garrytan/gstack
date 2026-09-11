import { expect, test } from 'bun:test';
import fixture from './fixtures/eng-declared-regression-ai.json';
import { evaluateEngSeedCoverage } from './helpers/eng-seeded-coverage';
import type { PlanCountTranscript } from './helpers/plan-count-transcript';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';

const transcript = fixture.transcript as PlanCountTranscript;
const { start, end } = fixture.provenance.window;
const plan = [
  '## Tests\n\n### CRITICAL regression (mandatory, regression rule)\n\n' + fixture.mandatory,
  '## Implementation Tasks\n\n' + fixture.task,
  '## Verification\n\n' + fixture.verification,
  fixture.reviewReport,
].join('\n\n');
const evaluate = (text = plan, native = transcript) => evaluateEngSeedCoverage(native, text, start, end);
const retryPlan = [
  '## Architecture\n\n' + fixture.retry.legacyHeading + '\n\n' + fixture.retry.legacy,
  '## Tests\n\n' + fixture.retry.heading + '\n\n' + fixture.retry.mandatory,
  '## Implementation Tasks\n\n' + fixture.retry.task,
  fixture.retry.reviewReport,
].join('\n\n');
const evaluateRetry = (text = retryPlan) => evaluateEngSeedCoverage(fixture.retry.transcript as PlanCountTranscript,
  text, fixture.retry.provenance.window.start, fixture.retry.provenance.window.end);

test('actual mandatory suite, numbered task and unchanged baseline bind legacy regression', () => {
  const result = evaluate();
  expect(Object.keys(result.decisions)).toHaveLength(4);
  expect(result.missing).toEqual([]);
  expect(result.regression).toBe('plan');
  expect(result.ok).toBe(true);
  expect(fixture.provenance.retrospectivePass).toBe(false);
});

test('retry same-fixture contract compares new behavior with the unchanged legacy release oracle', () => {
  const result = evaluateRetry();
  expect(result.missing).toEqual([]);
  expect(result.regression).toBe('plan');
  expect(result.ok).toBe(true);
  expect(fixture.retry.provenance.retrospectivePass).toBe(false);
});

test('retry requires an unchanged legacy release oracle and actual result parity', () => {
  for (const text of [
    retryPlan.replace(fixture.retry.legacy, ''),
    retryPlan.replace('stays callable and unchanged this release', 'will be rewritten this release'),
    retryPlan.replace('stays callable and unchanged this release', 'might stay callable and unchanged this release'),
    retryPlan.replace('- A tenant-keyed flag', 'If approved:\n\n- A tenant-keyed flag'),
    retryPlan.replace('- A tenant-keyed flag', 'Unless rejected.\n\n- A tenant-keyed flag'),
    retryPlan.replace('- A tenant-keyed flag', 'Proposed baseline:\n\n- A tenant-keyed flag'),
    retryPlan.replace('legacyAuthFlow()` stays callable', 'newAuthFlow()` stays callable'),
    retryPlan.replace('Run each fixture', 'Run different fixtures'),
    retryPlan.replace('and assert identical `Session` shape on success', 'and document different `Session` shape on success'),
    retryPlan.replace('identical error code on failure', 'similar error code on failure'),
    retryPlan.replace('through `legacyAuthFlow()` and', 'through `newAuthFlow()` and'),
    retryPlan.replace('AuthBroker.authenticate()', 'NewBroker.authenticate()'),
    retryPlan.replace('and AuthBroker, identical', 'and NewBroker, identical'),
    retryPlan.replace('identical Session / error codes', 'identical OtherResponse / error codes'),
    retryPlan.replace('Files: src/auth/authFlow.contract.test.ts', 'Files: src/auth/other.contract.test.ts'),
    retryPlan.replace('suite green on both paths', 'suite green on the new path'),
    retryPlan.replace(fixture.retry.task, ''),
    retryPlan.replace('This test\nis also the gate', 'This optional test\nis also the gate'),
  ]) { expect(text).not.toBe(retryPlan); expect(evaluateRetry(text).regression, text).toBeUndefined(); }
});

test('retry proposals and current withdrawals cannot supply parity coverage', () => {
  for (const text of [
    retryPlan.replace(fixture.retry.mandatory, 'If approved, ' + fixture.retry.mandatory),
    retryPlan.replace(fixture.retry.mandatory, '"' + fixture.retry.mandatory + '"'),
    retryPlan.replace(fixture.retry.mandatory, '```\n' + fixture.retry.mandatory + '\n```'),
    retryPlan.replace(fixture.retry.mandatory, fixture.retry.mandatory + '\nThis test is withdrawn.'),
    retryPlan.replace(fixture.retry.task, fixture.retry.task + '\nT4 is no longer required.'),
    retryPlan.replace(fixture.retry.legacy, fixture.retry.legacy + '\nCorrection: legacyAuthFlow() is changed this release.'),
    retryPlan.replace(fixture.retry.legacy, fixture.retry.legacy.split('\n').map(line => '> ' + line).join('\n')),
    '# Hypothetical example\n\n' + retryPlan,
    '# Proposed work\n\n' + retryPlan,
  ]) { expect(text).not.toBe(retryPlan); expect(evaluateRetry(text).regression, text).toBeUndefined(); }
});

test('consistent retry identities and unrelated negative outcomes retain parity evidence', () => {
  for (const text of [
    retryPlan.replaceAll('AuthBroker', 'SessionBroker').replaceAll('Session', 'Reply'),
    retryPlan.replaceAll('authFlow.contract.test.ts', 'loginFlow.contract.test.js').replaceAll('T4', 'T14'),
    retryPlan.replace(fixture.retry.task, fixture.retry.task + '\n  - Verify revoked tokens are rejected.'),
    retryPlan.replace(fixture.retry.legacy, fixture.retry.legacy + '\nRejected alternatives stay documented.'),
  ]) expect(evaluateRetry(text).regression).toBe('plan');
});

for (const prefix of [
  '# Source\n\n',
  'An unproven hypothesis.\n\n',
  'The following is a hypothetical example.\n\n',
  'The following is source material only, not the current reviewed plan.\n\n',
  '# Current reviewed plan\n\nThe following sections reproduce source material only; they are not requirements of this plan.\n\n',
]) {
  test('first and retry evidence retain enclosing source frame: ' + prefix.trim(), () => {
    expect(evaluate(prefix + plan).regression).toBeUndefined();
    expect(evaluateRetry(prefix + retryPlan).regression).toBeUndefined();
  });
}

test('declaration wording and task identity can vary without changing the required baseline', () => {
  for (const text of [
    plan.replaceAll('T4', 'T12'),
    plan.replace('capture current', 'pin existing'),
    plan.replace('is added as a critical', 'is required as a mandatory'),
    plan.replace('auth/legacy tests — ', 'core/auth — '),
    plan.replace('wrong-audience, wrong-issuer,', 'wrong-audience, wrong-issuer, malformed,'),
    plan.replace(fixture.task, fixture.task + '\n  - Verify expired and revoked tokens are rejected.'),
    plan.replace(fixture.mandatory, fixture.mandatory + '\nKeep a record of rejected alternatives.'),
    '# Historical example\n\nA proposed suite was discussed.\n\n# Current reviewed plan\n\n' + plan,
  ]) expect(evaluate(text).regression, text).toBe('plan');
});

test('declaration, task, target and original baseline cannot lend each other missing evidence', () => {
  for (const text of [
    plan.replace(fixture.mandatory, ''),
    plan.replace(fixture.task, ''),
    plan.replace(fixture.verification, ''),
    plan.replace('suite (T4)', 'suite (T5)'),
    plan.replace('against the untouched', 'against the rewritten'),
    plan.replace('first and commit it green. This is the baseline.', 'after rollout and document it.'),
    plan.replace('capture current', 'describe future'),
    plan.replace('is\nthe oracle the new path is compared to', 'is documentation the new path links to'),
    plan.replace('characterization test suite** for `legacyAuthFlow()`', 'characterization test suite** for `newAuthFlow()`'),
    plan.replace('suite for `legacyAuthFlow()` prior behavior', 'suite for `newAuthFlow()` prior behavior'),
    plan.replace('untouched `legacyAuthFlow()`', 'untouched `newAuthFlow()`'),
  ]) { expect(text).not.toBe(plan); expect(evaluate(text).regression, text).toBeUndefined(); }
});

test('proposals, future work, conditional and quoted declarations are not required coverage', () => {
  for (const text of [
    plan.replace('is added as a critical', 'will be added as a critical'),
    plan.replace('is added as a critical', 'might be added as a critical'),
    plan.replace('is added as a critical', 'is not added as a critical'),
    plan.replace(fixture.mandatory, 'If approved, ' + fixture.mandatory),
    plan.replace(fixture.mandatory, 'Example: ' + fixture.mandatory),
    plan.replace(fixture.mandatory, 'An unproven hypothesis. ' + fixture.mandatory),
    plan.replace(fixture.mandatory, '"' + fixture.mandatory + '"'),
    plan.replace(fixture.mandatory, "'" + fixture.mandatory + "'"),
    plan.replace(fixture.mandatory, fixture.mandatory.split('\n').map(line => '> ' + line).join('\n')),
    plan.replace(fixture.mandatory, '```\n' + fixture.mandatory + '\n```'),
    '# Hypothetical example\n\n' + plan,
    '# Quoted source\n\n' + plan,
    '# Proposed work\n\n' + plan,
    plan.replace('## Verification\n\n1. Run', '## Verification\n\n1. If approved, run'),
  ]) { expect(text).not.toBe(plan); expect(evaluate(text).regression, text).toBeUndefined(); }
});

test('withdrawal of the owned suite, task or baseline prevents credit', () => {
  for (const [from, addition] of [
    [fixture.mandatory, 'This suite is withdrawn.'],
    [fixture.mandatory, 'The characterization suite is not required.'],
    [fixture.mandatory, 'Do not run the suite.'],
    [fixture.task, 'Correction: T4 is cancelled.'],
    [fixture.task, 'This task is deferred.'],
    [fixture.verification, 'Correction: T4 is cancelled.'],
    [fixture.verification, 'Skip the characterization suite.'],
  ]) expect(evaluate(plan.replace(from!, from + '\n' + addition)).regression, addition).toBeUndefined();
});

test('the required suite cannot replace completed distinct native decisions or final report', () => {
  for (let index = 0; index < transcript.calls.length; index++) {
    const native = structuredClone(transcript);
    native.calls.splice(index, 1);
    expect(evaluate(plan, native).ok).toBe(false);
    expect(evaluate(plan, native).missing).toHaveLength(1);
  }
  for (const mutate of [
    (native: PlanCountTranscript) => { native.calls[0]!.failed = true; },
    (native: PlanCountTranscript) => { native.calls[0]!.answeredAt = new Date(start - 1).toISOString(); },
    (native: PlanCountTranscript) => { native.calls[0]!.sessionId = 'foreign-session'; },
    (native: PlanCountTranscript) => { native.calls.push(structuredClone(native.calls[0]!)); },
  ]) {
    const native = structuredClone(transcript); mutate(native);
    expect(evaluate(plan, native).ok).toBe(false);
  }
  expect(evaluate(plan.replace(fixture.reviewReport, '')).problems).toContain('final review report absent or empty');
});

test('public declaration still requires the existing owned time and session interval', () => {
  const native = structuredClone(transcript);
  native.assistantMessages = [{ sessionId: native.calls[0]!.sessionId, timestamp: new Date(start).toISOString(), text: plan }];
  expect(evaluate(fixture.reviewReport, native).regression).toBe('public-narration');
  native.assistantMessages[0]!.timestamp = new Date(start - 1).toISOString();
  expect(evaluate(fixture.reviewReport, native).regression).toBeUndefined();
  native.assistantMessages[0]!.timestamp = new Date(end + 1).toISOString();
  expect(evaluate(fixture.reviewReport, native).regression).toBeUndefined();
  native.assistantMessages[0]!.timestamp = new Date(start).toISOString();
  native.assistantMessages[0]!.sessionId = 'foreign-session';
  expect(evaluate(fixture.reviewReport, native).regression).toBeUndefined();
});

test('new declaration evidence registers only the two existing engineering count owners', () => {
  for (const file of ['test/eng-declared-regression-ai.test.ts', 'test/fixtures/eng-declared-regression-ai.json']) {
    expect(selectTests([file], E2E_TOUCHFILES, []).selected.sort()).toEqual(['plan-eng-finding-count', 'plan-eng-multi-finding-batching']);
  }
});
