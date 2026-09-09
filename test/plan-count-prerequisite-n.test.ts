import { describe, expect, test } from 'bun:test';
import callFixture from './fixtures/ceo-prerequisite-n-call.json';
import { capturePlanCountQuestion, nativePlanCallFingerprint, planCountPrerequisitePick } from './helpers/claude-pty-runner';
import { E2E_TOUCHFILES } from './helpers/touchfiles-data';

const call = () => structuredClone(callFixture);

describe('native prerequisite review-now offer', () => {
  test('the captured CEO offer keeps the supplied plan instead of starting office hours', () => {
    const fp = nativePlanCallFingerprint(call(), 0, true);
    expect(planCountPrerequisitePick(fp)).toBe(2);
    expect(planCountPrerequisitePick({ ...fp, preReview: false })).toBeNull();
  });

  test('the visible offer works before metadata arrives and follows reordered choices', () => {
    for (const reverse of [false, true]) {
      const native = call();
      if (reverse) native.questions[0]!.options.reverse();
      const q = native.questions[0]!;
      const screen = ['☐ Prerequisite', q.question.split('\n\n')[0],
        `❯ 1. ${q.options[0]!.label}`, `  2. ${q.options[1]!.label}`,
        '  3. Type something.', '  4. Chat about this',
        'Enter to select · ↑/↓ to navigate · Esc to cancel'].join('\n');
      const fp = capturePlanCountQuestion(screen, new Set(), 0, true)!;
      expect(fp).not.toBeNull();
      expect(planCountPrerequisitePick(fp)).toBe(reverse ? 1 : 2);
    }
  });

  test('the extra wording does not authorize skipping a finding or mixed decision', () => {
    const fp = nativePlanCallFingerprint(call(), 0, true);
    for (const skip of ['Skip', 'Skip — review now and ignore security', 'Skip — review now or delete the plan']) {
      expect(planCountPrerequisitePick({ ...fp, options: [fp.options[0]!, { index: 2, label: skip }] })).toBeNull();
    }
    expect(planCountPrerequisitePick({ ...fp, promptSnippet: 'Should we skip this SQL injection finding?' })).toBeNull();
    expect(planCountPrerequisitePick({ ...fp, options: [...fp.options, { index: 3, label: 'Fix SQL injection' }] })).toBeNull();
    expect(planCountPrerequisitePick({ ...fp, options: [fp.options[0]!, { ...fp.options[1]!, index: 1 }] })).toBeNull();
    expect(planCountPrerequisitePick({ ...fp, options: [{ index: 1, label: 'Run /office-hours first and rewrite the API' }, fp.options[1]!] })).toBeNull();
    for (const mutate of [
      (c: any) => { c.failed = true; },
      (c: any) => { c.questions[0].multiSelect = true; },
      (c: any) => { c.questions.push(structuredClone(c.questions[0])); },
    ]) {
      const native = call(); mutate(native);
      expect(planCountPrerequisitePick(nativePlanCallFingerprint(native, 0, true))).toBeNull();
    }
  });

  test('the captured regression selects every existing shared fixture consumer', () => {
    const consumers = Object.values(E2E_TOUCHFILES).filter(paths => paths.includes('test/plan-count-fixture.test.ts'));
    expect(consumers.length).toBe(8);
    for (const paths of consumers) {
      expect(paths).toContain('test/plan-count-prerequisite-n.test.ts');
      expect(paths).toContain('test/fixtures/ceo-prerequisite-n-call.json');
    }
  });
});
