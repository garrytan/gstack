import { expect, test } from 'bun:test';
import fixture from './fixtures/eng-snapshot-adapter-aj.json';
import { evaluateEngSeedCoverage } from './helpers/eng-seeded-coverage';
import type { PlanCountTranscript } from './helpers/plan-count-transcript';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';

const plan = ['## Tests\n\n### Required tests (write alongside the code, not after)\n\n' + fixture.required,
  '## Implementation Tasks\n\n' + fixture.taskIntro + '\n\n' + fixture.task, fixture.reviewReport].join('\n\n');
const native = () => structuredClone(fixture.transcript) as PlanCountTranscript;
const { start, end } = fixture.provenance.window;
const evaluate = (p = plan, t = native()) => evaluateEngSeedCoverage(t, p, start, end);
const cacheCall = (t: PlanCountTranscript) => t.calls.find(c => c.toolUseId === 'toolu_01RP1Yzt5jbat8STPd4k3bER')!;
function edit(t: PlanCountTranscript, change: (s: string) => string) {
  const c = cacheCall(t), q = c.questions[0]!, answer = c.answers[q.question]!;
  q.question = change(q.question); c.answers = { [q.question]: answer };
}

test('the exact completed adapter race identifies shared-cache ownership in its own explanation', () => {
  expect(evaluate().missing).toEqual([]);
  expect(new Set(Object.values(evaluate().decisions)).size).toBe(4);
});

test('the exact mandatory snapshot, parity and unchanged baseline task establish regression coverage', () => {
  expect(evaluate().regression).toBe('plan');
  expect(evaluate().ok).toBe(true);
  expect(fixture.provenance.historicalPaidFailurePreserved).toBe(true);
});

test('shared-adapter title cannot borrow a cache from source text or unrelated options', () => {
  for (const change of [
    (s: string) => s.replace('on the shared adapter', 'on the logging adapter'),
    (s: string) => s.replace('SessionMint and AuthBroker', 'QueueWorker and AuthBroker'),
    (s: string) => s.replace('write-after-invalidate race', 'completed design documentation'),
    (s: string) => s.replace(/^ELI10: .+$/m, ''),
    (s: string) => s.replace('both services write into the same cache', 'both services read unrelated caches'),
    (s: string) => s.replace('both services write into the same cache', 'both services do not write into the same cache'),
    (s: string) => s.replace(/^ELI10: /m, 'ELI10: If approved, '),
    (s: string) => s.replace(/^ELI10: /m, 'ELI10: The following is a hypothetical example. '),
    (s: string) => s.replace(/^ELI10: (.+)$/m, 'ELI10: "$1"'),
    (s: string) => s.replace(/^ELI10: (.+)$/m, 'ELI10: `$1`'),
    (s: string) => s.replace(/^ELI10: (.+)$/m, '```text\nELI10: $1\n```'),
    (s: string) => s.replace(/^ELI10:/m, 'Source excerpt, not a current finding:\nELI10:'),
    (s: string) => s.replace(/^ELI10:/m, 'If approved:\nELI10:'),
    (s: string) => s.replace(/^Project\/branch\/task: .+$/m, 'Project/branch/task: copied source example; following ELI10 is not a current finding'),
    (s: string) => s + '\nThis issue is withdrawn.',
    (s: string) => s + '\nIssue 1 is rejected.',
    (s: string) => s + '\nThere is no current shared-cache race.',
  ]) { const t = native(); edit(t, change); expect(evaluate(plan, t).missing).toContain('shared-cache'); }
  const t = native(), q = cacheCall(t).questions[0]!;
  q.options = [{ label: 'Archive review' }, { label: 'Pause review' }];
  cacheCall(t).answers = { [q.question]: q.options[0]!.label };
  expect(evaluate(plan, t).missing).toContain('shared-cache');
});

test('the shared-adapter decision retains owned completed native identity and offered answer gates', () => {
  for (const mutate of [
    (t: PlanCountTranscript) => { cacheCall(t).answered = false; },
    (t: PlanCountTranscript) => { cacheCall(t).failed = true; },
    (t: PlanCountTranscript) => { cacheCall(t).sessionId = 'foreign'; },
    (t: PlanCountTranscript) => { cacheCall(t).answeredAt = new Date(start - 1).toISOString(); },
    (t: PlanCountTranscript) => { cacheCall(t).answeredAt = new Date(end + 1).toISOString(); },
    (t: PlanCountTranscript) => { cacheCall(t).answers = {}; },
    (t: PlanCountTranscript) => { const c=cacheCall(t); c.answers = { [c.questions[0]!.question]: 'unoffered' }; },
    (t: PlanCountTranscript) => { cacheCall(t).unansweredQuestionIndices = [0]; },
    (t: PlanCountTranscript) => { t.calls.push(structuredClone(cacheCall(t))); },
  ]) { const t=native(); mutate(t); expect(evaluate(plan,t).ok).toBe(false); }
  for (const choice of cacheCall(native()).questions[0]!.options) {
    const t=native(),c=cacheCall(t);c.answers={[c.questions[0]!.question]:choice.label};
    expect(evaluate(plan,t).missing).toEqual([]);
  }
});

test('snapshot declaration and task must independently bind current legacy behavior and the unchanged baseline', () => {
  for (const p of [
    plan.replace(fixture.required, ''), plan.replace(fixture.task, ''),
    plan.replace('capture current outputs', 'describe future outputs'),
    plan.replace('BEFORE any change', 'AFTER the rewrite'),
    plan.replace('produce identical', 'produce similar'),
    plan.replace('both legacy (flag OFF) and new (flag ON)', 'only the new (flag ON)'),
    plan.replace('Mandatory under', 'Optional under'),
    plan.replace('`legacyAuthFlow` snapshot', '`newAuthFlow` snapshot'),
    plan.replace('Snapshot legacyAuthFlow() behavior', 'Snapshot newAuthFlow() behavior'),
    plan.replace('as regression tests before any change', 'as future examples after deployment'),
    plan.replace('against unmodified legacy code', 'against modified new code'),
    plan.replace('then against flag-OFF route', 'then against flag-ON route'),
    plan.replace('  - Verify: tests pass against', '  - Verify: tests might pass against'),
  ]) { expect(p).not.toBe(plan); expect(evaluate(p).regression,p).toBeUndefined(); }
});

test('source, conditional and withdrawn snapshot instructions do not become required tests', () => {
  for (const p of [
    '# Quoted source\n\n'+plan, '# Hypothetical example\n\n'+plan,
    'The following is a hypothetical example.\n\n'+plan,
    plan.replace(fixture.required, 'If approved:\n'+fixture.required),
    plan.replace(fixture.required, '"'+fixture.required+'"'),
    plan.replace(fixture.required, '`'+fixture.required.replaceAll('`','')+'`'),
    plan.replace(fixture.required, '```\n'+fixture.required+'\n```'),
    plan.replace(fixture.required, fixture.required+'\nThis suite is withdrawn.'),
    plan.replace(fixture.task, fixture.task+'\nT1 is cancelled.'),
    plan+'\n## Assessment of T1\nT1 is rejected.',
    plan+'\n## Regression correction\nThe regression suite is no longer required.',
    plan+'\n## Payment regression suite\nThe legacy regression suite is no longer required.',
    plan+'\n## Final regression suite assessment\nThe regression suite is no longer required.',
    plan.replace(fixture.task, fixture.task+'\n  - Correction: this unchanged-code verification is withdrawn.'),
    plan.replace(fixture.task, 'If approved:\n'+fixture.task),
    plan.replace(fixture.task, '`'+fixture.task.replaceAll('`','')+'`'),
    plan.replace(fixture.task, fixture.task.split('\n').map(s=>'> '+s).join('\n')),
  ]) expect(evaluate(p).regression,p).toBeUndefined();
});

test('task identities and ordinary presentation vary while unrelated rejection and quoted notes remain harmless', () => {
  for (const p of [
    plan.replaceAll('T1','T12'),
    '```\nPrior completed output\n```\n\n'+plan,
    plan.replace('tests/auth —','core/auth —'),
    plan.replace('valid, expired, wrong-audience, wrong-tenant','valid, expired, wrong-issuer, wrong-tenant'),
    plan+'\n## Assessment of T9\nT9 is rejected.',
    plan.replace(fixture.task,fixture.task+'\nOld note: "T1 is cancelled."'),
    plan.replace(fixture.task,fixture.task+'\nOld note: "This unchanged-code verification is withdrawn."'),
    plan+'\n## Historical note\nOld note: "The regression suite is no longer required."',
    plan+'\n## Payment regression suite\nThe regression suite is no longer required.',
  ]) expect(evaluate(p).regression).toBe('plan');
  const t=native();edit(t,s=>s+'\nOld note: "This issue is withdrawn."');
  expect(evaluate(plan,t).missing).toEqual([]);
});

test('the new exact public evidence belongs only to the existing Eng count owner', () => {
  for (const file of ['test/eng-snapshot-adapter-aj.test.ts','test/fixtures/eng-snapshot-adapter-aj.json'])
    expect(selectTests([file],E2E_TOUCHFILES,[]).selected).toEqual(['plan-eng-finding-count']);
});
