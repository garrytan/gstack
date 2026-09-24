import { expect, test } from 'bun:test';
import captured from './fixtures/design-count-current-pass.json';
import { nativePlanCallFingerprint, planCountQuestionPhase, designStep0Boundary } from './helpers/claude-pty-runner';
import { isDesignCountFirstReview, isDesignCountSetup, isDesignCompletionHandoff } from './helpers/design-count-review';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
const calls = () => structuredClone(captured.calls) as NativePlanQuestionCall[];
const fingerprint = (call: NativePlanQuestionCall) => nativePlanCallFingerprint(call, 0, true);
const accepts = (call: NativePlanQuestionCall) => isDesignCountFirstReview(fingerprint(call));
test('the first current design issue starts review with its actual native answer and no Net summary', () => {
  const call = calls()[3]!;
  for (const option of call.questions[0]!.options) {
    call.answers = { [call.questions[0]!.question]: option.label };
    expect(accepts(call)).toBe(true);
  }
});
test('all observed substantive calls count, including extra findings and the TODO proposal', () => {
  const input = calls(), before = JSON.stringify(input);
  let started = false;
  const phases = input.map(call => {
    const phase = planCountQuestionPhase(fingerprint(call), started, designStep0Boundary,
      isDesignCountFirstReview, isDesignCountSetup, isDesignCompletionHandoff);
    started = phase.reviewStarted;
    return phase;
  });
  expect(phases.map(p => p.preReview)).toEqual([true, true, true, false, false, false, false, false, false, false, false, false]);
  // Nine decisions exceed the paid case's existing ceiling of seven.
  expect(phases.filter(p => !p.preReview && !p.administrative)).toHaveLength(9);
  expect(JSON.stringify(input)).toBe(before);
});
const invalid = {
  'foreign file': (q: any) => { q.question = q.question.replace('of the Account settings plan.', 'of OTHER.md.'); },
  'quoted owner': (q: any) => { q.question = q.question.replace('Pass 1 (Information Architecture) of the Account settings plan.', '"Pass 1 (Information Architecture) of the Account settings plan."'); },
  'historical owner': (q: any) => { q.question = q.question.replace('Project/branch/task: ', 'Project/branch/task: Historical example: '); },
  'setup owner': (q: any) => { q.question = q.question.replace('Project/branch/task: ', 'Project/branch/task: Review setup phase; '); },
  'quoted assertion': (q: any) => { q.question = q.question.replace(/^ELI10: (.*)$/m, 'ELI10: "$1"'); },
  'conditional assertion': (q: any) => { q.question = q.question.replace('ELI10: ', 'ELI10: If approved later, '); },
  'different native identity': (q: any) => { q.header = 'Issue 99'; },
  'missing remedy': (q: any) => { q.options[0].description = 'We can discuss this later.'; },
  'foreign opposition without a withdrawal': (q: any) => { q.options[2].description = "Another Issue 99 violates DESIGN.md's stated primary treatment."; },
  'foreign plan without a filename': (q: any) => { q.question = q.question.replace('Account settings plan', 'unrelated plan'); },
  'unowned opposition': (q: any) => { q.options[2].description = 'Another issue violates DESIGN.md, this issue is resolved.'; },
  'missing current opposition': (q: any) => { q.options[2].description = 'This menu remains available.'; },
  'withdrawn decision': (q: any) => { q.question += '\nD4 is withdrawn.'; },
  'quoted withdrawn status': (q: any) => { q.question += '\nThis finding is "withdrawn".'; },
  'foreign recommendation': (q: any) => { q.question = q.question.replace('Recommendation: 1A', 'Recommendation: 99A'); },
};
for (const [name, mutate] of Object.entries(invalid)) test('count still rejects ' + name, () => {
  const call = calls()[3]!, q = call.questions[0]!;
  mutate(q); call.answers = { [q.question]: q.options[0]!.label };
  expect(accepts(call)).toBe(false);
});
test('pending, failed, foreign and unoffered native acknowledgments never establish review', () => {
  for (const mutate of [
    (c: NativePlanQuestionCall) => { c.answered = false; },
    (c: NativePlanQuestionCall) => { c.failed = true; },
    (c: NativePlanQuestionCall) => { delete c.answeredAt; },
    (c: NativePlanQuestionCall) => { c.unansweredQuestionIndices = [0]; },
    (c: NativePlanQuestionCall) => { c.answers = { [c.questions[0]!.question]: 'not offered' }; },
  ]) { const call = calls()[3]!; mutate(call); expect(accepts(call)).toBe(false); }
  const fp = fingerprint(calls()[3]!); fp.signature = 'foreign:call'; expect(isDesignCountFirstReview(fp)).toBe(false);
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { designCountExistingInteractionStates } from './helpers/design-count-fixture';
test('both fixture documents define existing error layout and export behavior while preserving all five gaps', () => {
  const source = readFileSync(join(import.meta.dir, 'skill-e2e-plan-design-finding-count.test.ts'), 'utf8');
  expect(source).toContain("import { designCountExistingInteractionStates as existingInteractionStates } from './helpers/design-count-fixture';");
  const start = source.indexOf('const designSystem = ');
  const end = source.indexOf("describeE2E(", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const build = new Function('existingInteractionStates', new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end) + '\nreturn { designSystem, plan: planDesign5Findings("/owned/review.md") };'));
  const { designSystem, plan } = build(designCountExistingInteractionStates);
  for (const text of [designSystem, plan]) {
    expect(text).toContain('The existing ErrorSummary mounts in the status/error area below the action\ngroup and above Profile.');
    expect(text).toContain('Retry wraps below the text as a full-width 44px ghost button');
    expect(text).toContain('account-settings-YYYY-MM-DD.json');
    expect(text).toContain('outside the live region');
  }
  for (const name of ['Visual Hierarchy', 'Spacing', 'Typography', 'Color', 'Motion']) expect(plan).toContain('## ' + name);
  expect(plan).toContain('same size, weight, and color');
  expect(plan).toContain('no consistent vertical rhythm');
  expect(plan).toContain('14px, 16px, and 18px');
});
