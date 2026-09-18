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

  test('the captured prerequisite regression selects its exact counting and mode consumers', () => {
    // Floor checks also seed a plan, but never pick a prerequisite answer.
    const expected = [
      'autoplan-chain-pty', 'plan-ceo-finding-count', 'plan-ceo-mode-routing',
      'plan-ceo-split-overflow', 'plan-design-finding-count', 'plan-design-with-ui-scope', 'plan-devex-finding-count',
      'plan-eng-finding-count', 'plan-eng-multi-finding-batching',
    ].sort();
    for (const dependency of ['test/plan-count-prerequisite-n.test.ts', 'test/fixtures/ceo-prerequisite-n-call.json', 'test/fixtures/eng-prerequisite-77.json']) {
      const consumers = Object.entries(E2E_TOUCHFILES).filter(([, paths]) => paths.includes(dependency));
      expect(consumers.map(([name]) => name).sort()).toEqual(expected);
      for (const [, paths] of consumers) {
        expect(paths).toContain('test/helpers/plan-count-fixture.ts');
        expect(paths).toContain('test/plan-count-fixture.test.ts');
      }
    }
  });
});


import engPrerequisite77 from './fixtures/eng-prerequisite-77.json';
import { planCountQuestionInput } from './helpers/claude-pty-runner';
import { nextCeoModeNavigation } from './helpers/ceo-mode-option';
import { autoplanSetupDecision } from './helpers/autoplan-setup-question';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';

function engPrerequisitePending(): NativePlanQuestionCall {
  const native = structuredClone(engPrerequisite77.completedCall) as NativePlanQuestionCall;
  native.answered = false;
  delete native.answers;
  delete native.answeredAt;
  delete native.unansweredQuestionIndices;
  return native;
}
// Exact public native question/options; the active pending viewport is synthetic.
function engPrerequisiteFrame(native: NativePlanQuestionCall, index = 0) {
  const q = native.questions[index]!;
  const screen = [native.questions.length > 1
    ? '← ' + native.questions.map((question, i) => `${i < index ? '☒' : '☐'} ${question.header}`).join(' ') + ' ✔ Submit →'
    : `☐ ${q.header}`, q.question,
    ...q.options.map((option, i) => `${i ? ' ' : '❯'} ${i + 1}. ${option.label}`),
    `Enter to select · ${native.questions.length > 1 ? 'Tab/Arrow keys' : '↑/↓'} to navigate · Esc to cancel`,
  ].join('\n');
  const active = capturePlanCountQuestion(screen, new Set(), 0, true, native)!;
  return { screen, active, routing: nativePlanCallFingerprint(native, 0, true) };
}

describe('optional Office Hours decision briefs', () => {
  test('actual acknowledged detour is preserved; the current caller should choose standard review', () => {
    const actual = engPrerequisite77.completedCall;
    expect(actual.answered).toBe(true);
    expect(actual.answers[actual.questions[0]!.question]).toBe('Run /office-hours now');
    const { screen, active, routing } = engPrerequisiteFrame(engPrerequisitePending());
    // This is runPlanSkillCounting's exact precedence with no caller override.
    const pick = planCountPrerequisitePick(routing, active) ?? 1;
    expect(pick).toBe(2);
    expect(planCountQuestionInput(screen, active, pick)).toBe('2');
    const ceo = nextCeoModeNavigation(screen, 'HOLD SCOPE', new Set(), active.nativeCall);
    expect(ceo.kind).toBe('question');
    if (ceo.kind === 'question') expect(ceo.index).toBe(2);
    expect(autoplanSetupDecision(screen, new Set(), active.nativeCall).kind).toBe('input');
  });

  test('optional action is independent of header, numbering, recommendation and order', () => {
    for (const reverse of [false, true]) for (const recommended of ['run', 'skip', 'neither']) {
      const native = engPrerequisitePending(), q = native.questions[0]!;
      q.header = 'Before review';
      q.question = q.question.replace(/^D2 — /, 'D41: ').replace(/Recommendation: B[^\n]*/, recommended === 'run' ? 'Recommendation: A because deeper context helps.' : 'Recommendation: B because the supplied plan is reviewable.');
      q.options[0]!.label = 'Run /office-hours first' + (recommended === 'run' ? ' (Recommended)' : '');
      q.options[1]!.label = 'Skip, proceed with standard review' + (recommended === 'skip' ? ' (Recommended)' : '');
      if (reverse) q.options.reverse();
      const { active, routing } = engPrerequisiteFrame(native);
      expect(planCountPrerequisitePick(routing, active)).toBe(reverse ? 1 : 2);
    }
  });

  test('the complete native offer supports equivalent description structure and premise placement', () => {
    for (const title of [
      'Run /office-hours now, or proceed with standard review?\nNo design doc exists for this branch.',
      'No design doc found: run /office-hours first, or proceed with the standard review?',
    ]) for (const bullet of ['✅', '- ✅', '* ✅']) {
      const native = engPrerequisitePending(), q = native.questions[0]!;
      q.question = title + '\nThe supplied plan is ready for review.';
      q.options[0]!.description = `${bullet} Creates a design document with the problem and alternatives.\n❌ Delays the engineering review while the prerequisite runs.`;
      q.options[1]!.description = `${bullet} Proceeds directly with standard review of the supplied plan.\n❌ The review has less background about the original premise.`;
      const { active, routing } = engPrerequisiteFrame(native);
      expect(planCountPrerequisitePick(routing, active)).toBe(2);
    }
  });

  test('native pros and cons may be inline or multiline without changing the action', () => {
    for (const separator of [' ', '\n', '\r\n']) {
      const native = engPrerequisitePending();
      for (const option of native.questions[0]!.options) option.description = option.description!.split('\n').join(separator);
      const { active, routing } = engPrerequisiteFrame(native);
      expect(planCountPrerequisitePick(routing, active)).toBe(2);
    }
  });

  const invalid: Array<[string, (q: NativePlanQuestionCall['questions'][number]) => void]> = [
    ['quoted question', q => { q.question = '> ' + q.question; }],
    ['example question', q => { q.question = 'Example: ' + q.question; }],
    ['fenced question', q => { q.question = '```text\n' + q.question + '\n```'; }],
    ['unrelated current question', q => { q.question = 'Should we remove authorization?\n' + q.question; }],
    ['additional approval question', q => { q.question += '\nApprove deployment?'; }],
    ['mandatory prerequisite', q => { q.question += '\nYou must run /office-hours first.'; }],
    ['blocked review', q => { q.question += '\nStandard review is blocked until /office-hours completes.'; }],
    ['conditional skip label', q => { q.options[1]!.label += ' if the tests pass'; }],
    ['extra run action', q => { q.options[0]!.label += ' and rewrite the API'; }],
    ['missing skip meaning', q => { q.options[1]!.description = ''; }],
    ['negated review action', q => { q.options[1]!.description = '✅ Do not proceed with standard review.'; }],
    ['retracted review action', q => { q.options[1]!.description += '\n❌ No review will run.'; }],
    ['conditional review action', q => { q.options[1]!.description = '✅ Proceed with standard review after completing /office-hours.'; }],
    ['conditional corroboration', q => { q.options[1]!.description += '\n✅ First run /office-hours to establish the baseline.'; }],
    ['substantive action appended', q => { q.options[1]!.description += '\n✅ Remove CI.'; }],
    ['substantive action inline', q => { q.options[1]!.description = '✅ Proceed with standard review. Accept the security risk.'; }],
    ['additive skip action', q => { q.options[1]!.description = '✅ Proceed with standard review and deploy to production.\n❌ Less premise context.'; }],
    ['subordinate skip action', q => { q.options[1]!.description = '✅ Proceed with standard review while deleting the API.\n❌ Less premise context.'; }],
    ['additive run action', q => { q.options[0]!.description = '✅ Produces a design doc and deletes the API.\n❌ Delays the review.'; }],
    ['subordinate run action', q => { q.options[0]!.description = '✅ Produces a design doc while disabling CI.\n❌ Delays the review.'; }],
    ['unrelated run approval', q => { q.options[0]!.description += '\n✅ Deploy to production.'; }],
    ['run negated', q => { q.options[0]!.description = '✅ Do not run /office-hours.'; }],
    ['run retracted', q => { q.options[0]!.description += '\n❌ Do not produce a design doc.'; }],
    ['foreign premise', q => { q.question = q.question.replace('No design doc found.', 'The archived example had no design doc.'); }],
    ['extra choice', q => { q.options.push({ label: 'Approve deployment' }); }],
    ['checkbox', q => { q.multiSelect = true; }],
  ];
  for (const [name, mutate] of invalid) test(`does not decline ${name}`, () => {
    const native = engPrerequisitePending(); mutate(native.questions[0]!);
    const { active, routing } = engPrerequisiteFrame(native);
    expect(planCountPrerequisitePick(routing, active)).toBeNull();
  });

  test('only the pending owned active tab can supply the complete native brief', () => {
    const native = engPrerequisitePending(), frame = engPrerequisiteFrame(native);
    for (const active of [
      { ...frame.active, preReview: false }, { ...frame.active, signature: 'foreign:tool' },
      { ...frame.active, nativeQuestionIndex: 3 }, { ...frame.active, nativeCall: undefined },
      { ...frame.active, promptSnippet: 'A different current question' },
      { ...frame.active, options: [...frame.active.options].reverse() },
    ]) expect(planCountPrerequisitePick(frame.routing, active)).toBeNull();
    for (const delta of [{ answered: true }, { failed: true }, { sessionId: '' }, { toolUseId: '' }]) {
      const changed = { ...engPrerequisitePending(), ...delta }, f = engPrerequisiteFrame(changed);
      expect(planCountPrerequisitePick(f.routing, f.active)).toBeNull();
    }
    expect(planCountPrerequisitePick({ ...frame.active, nativeCall: undefined })).toBeNull();
    native.questions.unshift({ header: 'Unrelated', question: 'Should we deploy?', options: [{ label: 'Deploy' }, { label: 'Defer' }], multiSelect: false });
    const own = engPrerequisiteFrame(native, 1), other = engPrerequisiteFrame(native, 0);
    expect(planCountPrerequisitePick(own.routing, own.active)).toBe(2);
    expect(planCountPrerequisitePick(other.routing, other.active)).toBeNull();
  });
});
