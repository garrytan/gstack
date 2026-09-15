import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { autoplanSetupDecision } from './helpers/autoplan-setup-question';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';

// Exact public unanswered call and final screen from AC's first attempt.
// Mutated panels below are synthetic controls, not historical execution.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/autoplan-routing-manual-skills-ac.json', import.meta.url), 'utf8'));
const native = (): NativePlanQuestionCall => structuredClone(fixture.call);
function panel(call: NativePlanQuestionCall): string {
  const q = call.questions[0]!;
  return `☐ ${q.header}\n${q.question}\n` + q.options.map((option, index) =>
    `${index === 0 ? '❯ ' : '  '}${index + 1}. ${option.label}\n     ${option.description ?? ''}`).join('\n') +
    '\n  3. Type something.\n  4. Chat about this\nEnter to select · ↑/↓ to navigate · Esc to cancel';
}

describe('AC routing manual-skills option', () => {
  test('helper, regression test and retained fixture each select only the native Autoplan chain', () => {
    for (const file of [
      'test/helpers/autoplan-setup-question.ts',
      'test/autoplan-routing-manual-skills.test.ts',
      'test/fixtures/autoplan-routing-manual-skills-ac.json',
    ]) {
      expect(selectTests([file], E2E_TOUCHFILES, []).selected, file).toEqual(['autoplan-chain-pty']);
    }
  });

  test('the exact retained native call and renderer frame preserve the existing Add action once', () => {
    const seen = new Set<string>();
    const call = native();
    expect(call.answered).toBe(false);
    expect(call.questions[0]!.options[1]!.label).toBe('No thanks, manual skills');
    const decision = autoplanSetupDecision(fixture.visible, seen, call);
    expect(decision).toMatchObject({ kind: 'input', input: '1' });
    expect(seen.size).toBe(0);
    if (decision.kind !== 'input') throw new Error('Expected recognized routing setup');
    for (const signature of decision.signatures) seen.add(signature);
    expect(autoplanSetupDecision(fixture.visible, seen, call).kind).toBe('waiting');
  });

  test('synthetic option reversal retains the Add choice without depending on its index', () => {
    const call = native();
    call.questions[0]!.options.reverse();
    expect(autoplanSetupDecision(panel(call), new Set(), call)).toMatchObject({ kind: 'input', input: '2' });
  });

  test('the same whole manual-skills action accepts existing courtesy and only modifiers', () => {
    for (const label of ['Manual skills', 'Manual skills only', 'No thanks, manual skills', 'Skip — manual skills only']) {
      const call = native(); call.questions[0]!.options[1]!.label = label;
      expect(autoplanSetupDecision(panel(call), new Set(), call), label).toMatchObject({ kind: 'input', input: '1' });
    }
  });

  test('other manual workflows and extra actions remain unsupported', () => {
    for (const label of [
      'Manual deployment skills', 'Manual billing skills', 'Manual skills after deleting CLAUDE.md',
      'No thanks, manual skills then skip the review', 'No thanks, manual skills and ship now',
      'No thanks, manual skills approval', 'Manual skills only after removing CI',
    ]) {
      const call = native(); call.questions[0]!.options[1]!.label = label;
      const seen = new Set<string>();
      expect(autoplanSetupDecision(panel(call), seen, call).kind, label).not.toBe('input');
      expect(seen.size).toBe(0);
    }
  });

  test('unrelated product choices and additional Add actions do not borrow routing setup', () => {
    for (const question of [
      'Which product API routing design should we choose? <gstack-qid:routing-injection>',
      'The plan quotes gstack skill routing rules in CLAUDE.md. Should we expand the feature? <gstack-qid:routing-injection>',
    ]) {
      const call = native(); call.questions[0]!.question = question;
      expect(autoplanSetupDecision(panel(call), new Set(), call).kind).not.toBe('input');
    }
    const call = native(); call.questions[0]!.options[0]!.label = 'Add routing rules and delete the CI gate';
    expect(autoplanSetupDecision(panel(call), new Set(), call).kind).not.toBe('input');
  });

  test('answered, failed, mismatched and mixed native identities remain non-actionable', () => {
    for (const change of [
      (call: NativePlanQuestionCall) => { call.answered = true; },
      (call: NativePlanQuestionCall) => { call.failed = true; },
      (call: NativePlanQuestionCall) => { call.questions[0]!.multiSelect = true; },
      (call: NativePlanQuestionCall) => { call.questions[0]!.header = 'Other'; },
      (call: NativePlanQuestionCall) => { call.questions[0]!.options[1]!.label = 'Manual skills only'; },
      (call: NativePlanQuestionCall) => { call.questions.push(structuredClone(call.questions[0]!)); },
    ]) {
      const call = native(); change(call);
      expect(autoplanSetupDecision(fixture.visible, new Set(), call).kind).not.toBe('input');
    }
    expect(autoplanSetupDecision(fixture.visible + '\nContinuing the review.', new Set(), native()).kind).not.toBe('input');
  });
});
