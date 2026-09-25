import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import captures from './fixtures/plan-floor-dx-target-7b57bf0d4.json';
import { buildPlanFloorReviewPrompt, judgePlanFloorReview, type PlanFloorReview } from './helpers/plan-floor-review';
import { selectTests, E2E_TOUCHFILES, LLM_JUDGE_TOUCHFILES, GLOBAL_TOUCHFILES } from './helpers/touchfiles';

const currentPromptHashesByCapture = new Map([
  ['ece7a66b8219574177e67200f492c0a40ed73a2a22ae3cad2a3549bd861af652', '03156a21a0cbabdeb2a29ed61686851d5ba7eba71fdf4bb854cb7867837e33b9'],
  ['9b13e8f33683ee266fbf6b7760fc973c7cd10509356d857517db5bc6315eb9bb', '8764eaa5ed2ad55a5bee80c9ffc96a82705248365acfdb15ab123e31e77cf858'],
]);

for (const capture of captures.captures) {
  test(`captured DX target ${capture.attempt} evaluates the complete native option without lexical false negatives`, () => {
    expect(createHash('sha256').update(buildPlanFloorReviewPrompt(capture.input as PlanFloorReview)).digest('hex'))
      .toBe(currentPromptHashesByCapture.get(capture.inputSha256));
    for (const reversed of [false, true]) {
      const input = structuredClone(capture.input);
      if (reversed) input.candidate.question.options.reverse();
      let calls = 0;
      const result = judgePlanFloorReview(input as PlanFloorReview, {
        binary: 'fake', model: 'unchanged-warmup', deadlineAt: Date.now() + 60_000,
        invoke: (() => { calls++; throw Error('A current target choice must not need a model assessment'); }) as any,
      });
      expect(calls).toBe(0);
      expect(result.kind).toBe('finding');
      expect(result.seedQuote).toBe('Step 7: register an API key by emailing the team.');
      expect(result.questionQuote).toBe(input.candidate.question.question.split('\n')[0]!.slice(5));
      expect(result.optionQuote).toBe(input.candidate.question.options[result.optionIndex! - 1]!.label);
      expect(result.reason).toContain('remedies remain undecided');
    }
  });

  test(`captured DX target ${capture.attempt} keeps numerical comparisons separate from non-target authority`, () => {
    for (const contrast of ['instead of my estimate', 'rather than an estimate', 'in place of an estimate']) {
      const input = structuredClone(capture.input);
      input.candidate.question.options.at(-1)!.description = `Supply a measured target number ${contrast}; this requests context, not implementation.`;
      let calls = 0;
      const result = judgePlanFloorReview(input as PlanFloorReview, {
        binary: 'fake', model: 'unchanged-warmup', deadlineAt: Date.now() + 60_000,
        invoke: (() => { calls++; throw Error('Numerical comparison is not a new action'); }) as any,
      });
      expect(calls).toBe(0);
      expect(result.kind).toBe('finding');
    }
  });

  test(`captured DX target ${capture.attempt} rejects redirected, unowned and action-bearing alternatives`, () => {
    const changes: Array<[string, (input: typeof capture.input) => void]> = [
      ['unrelated option', input => { input.candidate.question.options[0] = { label: 'Blue interface', description: 'Change the colors.' }; }],
      ['approval in a target option', input => { input.candidate.question.options[0]!.description = 'Approve a release instead of measuring the current target.'; }],
      ['approval in the context option', input => { input.candidate.question.options.at(-1)!.description = 'Supply a target and deploy the service.'; }],
      ['substitution without an object', input => { input.candidate.question.options[0]!.description = 'Choose a different product instead.'; }],
      ['substitution of the target', input => { input.candidate.question.options[0]!.description = 'Choose a different product instead of this TTHW target.'; }],
      ['substitution for measuring the target', input => { input.candidate.question.options.at(-1)!.description = 'Choose a different product instead of measuring the current target.'; }],
      ['alternative to the target', input => { input.candidate.question.options[0]!.description = 'Choose a different product rather than the time target.'; }],
      ['replacement of the target', input => { input.candidate.question.options[0]!.description = 'Choose a different product in place of the target.'; }],
      ['foreign plan', input => { input.candidate.question.question = input.candidate.question.question.replaceAll('PLAN.md', 'OTHER.md'); }],
      ['closed finding', input => { input.candidate.question.question += '\nThis finding is no longer current.'; }],
      ['historical option', input => { input.candidate.question.options[0]!.description = 'Historical target, withdrawn.'; }],
      ['foreign seed', input => { input.seed = 'A different plan with no onboarding flow.'; }],
    ];
    for (const [name, change] of changes) {
      const input = structuredClone(capture.input);
      change(input);
      let calls = 0;
      const result = judgePlanFloorReview(input as PlanFloorReview, {
        binary: 'fake', model: 'unchanged-warmup', deadlineAt: Date.now() + 60_000,
        invoke: ((_file, _args, opts) => {
          calls++;
          expect(opts.input, name).toBe(buildPlanFloorReviewPrompt(input as PlanFloorReview));
          return { status: 0, stdout: JSON.stringify({ kind: 'uncertain', seedId: null,
            questionId: null, optionId: null, reason: 'Controlled nonfinding assessment.' }), stderr: '' };
        }) as any,
      });
      expect(calls, name).toBe(1);
      expect(result.kind, name).toBe('uncertain');
    }
  });
}

test('target-option regression inputs select the registered floor callbacks', () => {
  for (const file of ['test/plan-floor-target-options.test.ts', 'test/fixtures/plan-floor-dx-target-7b57bf0d4.json']) {
    expect(selectTests([file], E2E_TOUCHFILES, GLOBAL_TOUCHFILES).selected.sort()).toEqual([
      'plan-ceo-finding-floor', 'plan-design-finding-floor', 'plan-devex-finding-floor', 'plan-eng-finding-floor',
    ]);
    expect(selectTests([file], LLM_JUDGE_TOUCHFILES, GLOBAL_TOUCHFILES).selected).toEqual([]);
  }
});
