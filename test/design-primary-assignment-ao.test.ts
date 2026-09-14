import { expect, test } from 'bun:test';
import captured from './fixtures/design-primary-assignment-ao.json';
import { isDesignCountFirstReview, isDesignCountSetup } from './helpers/design-count-review';
import { designStep0Boundary, planCountQuestionPhase } from './helpers/claude-pty-runner';
import type { AskUserQuestionFingerprint as Fingerprint } from './helpers/claude-pty-runner';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';

type Question = NonNullable<Fingerprint['nativeCall']>['questions'][number];
function edit(change: (q: Question) => void): Fingerprint {
  const fp = structuredClone(captured.fingerprints[0]) as Fingerprint;
  const call = fp.nativeCall!, q = call.questions[0]!;
  const selected = q.options.findIndex(o => o.label === call.answers![q.question]);
  change(q);
  call.answers = { [q.question]: q.options[selected]!.label };
  fp.options = q.options.map((o, i) => ({ index: i + 1, label: o.label }));
  return fp;
}

test('the exact style assignment begins review before the following pending-state decision', () => {
  let started = false;
  const phases = captured.fingerprints.map(raw => {
    const phase = planCountQuestionPhase(raw as Fingerprint, started, designStep0Boundary,
      isDesignCountFirstReview, isDesignCountSetup);
    started = phase.reviewStarted;
    return phase;
  });
  expect(phases).toEqual([
    { preReview: false, reviewStarted: true },
    { preReview: false, reviewStarted: true },
  ]);
  expect(captured.fingerprints.map(fp => fp.preReview)).toEqual([true, true]);
});

test('assignment whitespace and current deferral phrasing compose', () => {
  for (const separator of [' = ', '=', ' =']) {
    for (const action of ['Leave', 'Keep']) {
      for (const debt of ['debt', 'an open issue']) {
        expect(isDesignCountFirstReview(edit(q => {
          q.options[0]!.description = q.options[0]!.description!.replaceAll(' = ', separator);
          q.options[2]!.description = q.options[2]!.description!.replace('Leave the header', `${action} the header`)
            .replace('as debt.', `as ${debt}.`);
        }))).toBe(true);
      }
    }
  }
});

test('the named control and offered answer may change without changing the review phase', () => {
  expect(isDesignCountFirstReview(edit(q => {
    q.question = q.question.replaceAll('Save', 'Submit');
    q.options = q.options.map(o => ({ label: o.label.replaceAll('Save', 'Submit'),
      description: o.description?.replaceAll('Save', 'Submit') }));
  }))).toBe(true);
  for (const selected of [0, 1, 2]) {
    const fp = edit(() => {}), q = fp.nativeCall!.questions[0]!;
    fp.nativeCall!.answers = { [q.question]: q.options[selected]!.label };
    expect(isDesignCountFirstReview(fp)).toBe(true);
  }
});

const rejected: Array<[string, (q: Question) => void]> = [
  ['withdrawn contract', q => { q.question += '\nThis DESIGN.md contract is "withdrawn".'; }],
  ['superseded contract', q => { q.question += '\nThis contract is "superseded".'; }],
  ['wrong primary', q => { q.options[0]!.description = q.options[0]!.description!.replace('Save =', 'Reset ='); }],
  ['primary also ghost', q => { q.options[0]!.description = q.options[0]!.description!.replace('Reset/Cancel/Export =', 'Save/Cancel/Export ='); }],
  ['no primary foreground', q => { q.options[0]!.description = q.options[0]!.description!.replace(' with white text', ''); }],
  ['no ghost treatment', q => { q.options[0]!.description = q.options[0]!.description!.replace('neutral ghost Buttons', 'filled Buttons'); }],
  ['no current authority', q => { q.options[0]!.description = q.options[0]!.description!.replace('per DESIGN.md', 'per a draft proposal'); }],
  ['conditional assignment', q => { q.options[0]!.description = 'If approved later: ' + q.options[0]!.description; }],
  ['historical assignment', q => { q.options[0]!.description = 'Historical example: ' + q.options[0]!.description; }],
  ['quoted assignment', q => { q.options[0]!.description = '> ' + q.options[0]!.description; }],
  ['cancelled assignment', q => { q.options[0]!.description += '\nCorrection: do not apply these styles.'; }],
  ['rejected assignment', q => { q.options[0]!.description += '\nThis amendment is "rejected".'; }],
  ['no opposed option', q => { q.options[2]!.label = '1C Configure Export'; }],
  ['no documented violation', q => { q.options[2]!.description = q.options[2]!.description!.replace('Ships a known DESIGN.md violation', 'Satisfies DESIGN.md'); }],
  ['no remaining primary gap', q => { q.options[2]!.description = q.options[2]!.description!.replace('stays undiscoverable', 'becomes obvious'); }],
  ['conditional deferral', q => { q.options[2]!.description = 'If approved later: ' + q.options[2]!.description; }],
  ['historical deferral', q => { q.options[2]!.description = 'Historical example: ' + q.options[2]!.description; }],
  ['quoted deferral', q => { q.options[2]!.description = '> ' + q.options[2]!.description; }],
  ['cancelled deferral', q => { q.options[2]!.description += '\nThis deferral is "cancelled".'; }],
  ['cancelled header instruction', q => { q.options[2]!.description += '\nCorrection: do not leave the header unchanged.'; }],
  ['cancelled keep instruction', q => { q.options[2]!.description += '\nCorrection: do not keep the header unchanged.'; }],
  ['resolved violation', q => { q.options[2]!.description += '\nThis violation is now resolved.'; }],
  ['conditional benefit', q => { q.options[2]!.description = q.options[2]!.description!.replace('✅ Zero implementation', '✅ If approved later: zero implementation'); }],
];
test.each(rejected)('%s cannot start review', (_, change) => {
  expect(isDesignCountFirstReview(edit(change))).toBe(false);
});

test('a quoted historical cancellation does not cancel the current deferral', () => {
  expect(isDesignCountFirstReview(edit(q => {
    q.options[2]!.description += '\nHistorical note: "Correction: do not leave the header unchanged."';
  }))).toBe(true);
});

test('unfinished or foreign native calls cannot start review', () => {
  const incomplete = edit(() => {}); incomplete.nativeCall!.answered = false;
  expect(isDesignCountFirstReview(incomplete)).toBe(false);
  const foreign = edit(() => {}); foreign.signature = 'foreign:tool';
  expect(isDesignCountFirstReview(foreign)).toBe(false);
});

test('the retry regression maps only to the existing Design workflow owner', () => {
  for (const file of ['test/design-primary-assignment-ao.test.ts', 'test/fixtures/design-primary-assignment-ao.json']) {
    expect(selectTests([file], E2E_TOUCHFILES, []).selected).toEqual(['plan-design-finding-count']);
  }
});
