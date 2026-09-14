import { expect, test } from 'bun:test';
import captured from './fixtures/design-primary-treatment-ao.json';
import { isDesignCountFirstReview, isDesignCountSetup } from './helpers/design-count-review';
import { designStep0Boundary, planCountQuestionPhase } from './helpers/claude-pty-runner';
import type { AskUserQuestionFingerprint as Fingerprint } from './helpers/claude-pty-runner';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';

type Question = NonNullable<Fingerprint['nativeCall']>['questions'][number];
const original = () => structuredClone(captured.fingerprints[0]) as Fingerprint;
function edit(change: (q: Question) => void): Fingerprint {
  const fp = original(), call = fp.nativeCall!, q = call.questions[0]!;
  const selected = q.options.findIndex(o => o.label === call.answers![q.question]);
  change(q);
  call.answers = { [q.question]: q.options[selected]!.label };
  fp.options = q.options.map((o, i) => ({ index: i + 1, label: o.label }));
  return fp;
}

test('the exact first primary-treatment decision starts review and retains the following decision', () => {
  expect(isDesignCountFirstReview(original())).toBe(true);
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

test('equivalent primary qualifiers, singular filled treatment and authority compose', () => {
  for (const qualifier of ['visible', 'visually', 'single filled']) {
    for (const treatment of ['one filled button', 'single filled primary', 'one filled primary button']) {
      for (const authority of ['per DESIGN.md', 'exactly as DESIGN.md specifies']) {
        expect(isDesignCountFirstReview(edit(q => {
          q.question = q.question.replace('visually primary', `${qualifier} primary`);
          q.options[0]!.description = q.options[0]!.description!
            .replace('one filled button', treatment).replace('per DESIGN.md', authority);
        }))).toBe(true);
      }
    }
  }
});

test('a different control or an opposed answer preserves the current decision', () => {
  expect(isDesignCountFirstReview(edit(q => {
    q.question = q.question.replaceAll('Save', 'Submit');
    q.options = q.options.map(o => ({ label: o.label.replaceAll('Save', 'Submit'),
      description: o.description?.replaceAll('Save', 'Submit') }));
  }))).toBe(true);
  for (const option of original().nativeCall!.questions[0]!.options) {
    const fp = original(), call = fp.nativeCall!;
    call.answers = { [call.questions[0]!.question]: option.label };
    expect(isDesignCountFirstReview(fp)).toBe(true);
  }
});

const rejected: Array<[string, (q: Question) => void]> = [
  ['foreign header', q => { q.header = 'Issue 2'; }],
  ['workflow title', q => { q.question = q.question.replace('Make Save the visually primary action in the header', 'Run outside design voices'); }],
  ['historical question', q => { q.question = 'Historical example:\n' + q.question; }],
  ['source assessment', q => { q.question = q.question.replace('\nELI10:', '\nSource excerpt:\nELI10:'); }],
  ['quoted assessment', q => { q.question = q.question.replace('\nELI10:', '\n> ELI10:'); }],
  ['conditional assessment', q => { q.question = q.question.replace('ELI10: Right now', 'ELI10: If right now'); }],
  ['no current equal-weight gap', q => { q.question = q.question.replace('all look identical', 'do not look identical'); }],
  ['withdrawn contract', q => { q.question += '\nThis DESIGN.md contract is withdrawn.'; }],
  ['quoted withdrawn contract', q => { q.question += '\nThis DESIGN.md contract is "withdrawn".'; }],
  ['superseded requirement', q => { q.question += '\nThis requirement is superseded.'; }],
  ['quoted superseded requirement', q => { q.question += '\nThis requirement is \"superseded\".'; }],
  ['rejected contract', q => { q.question += '\nThis DESIGN.md contract is rejected.'; }],
  ['quoted cancelled contract', q => { q.question += '\nThis DESIGN.md contract is \"cancelled\".'; }],
  ['withdrawn issue', q => { q.question += '\nThis issue is withdrawn.'; }],
  ['quoted rejected issue', q => { q.question += '\nThis issue is "rejected".'; }],
  ['wrong named primary', q => { q.options[0]!.description = q.options[0]!.description!.replace('Save becomes', 'Reset becomes'); }],
  ['primary also ghost', q => { q.options[0]!.description = q.options[0]!.description!.replace('; Reset,', '; Save,'); }],
  ['missing foreground', q => { q.options[0]!.description = q.options[0]!.description!.replace(', white text', ''); }],
  ['missing ghost treatment', q => { q.options[0]!.description = q.options[0]!.description!.replace('neutral ghost buttons', 'filled buttons'); }],
  ['missing style authority', q => { q.options[0]!.description = q.options[0]!.description!.replace('per DESIGN.md', 'per a future proposal'); }],
  ['conditional amendment', q => { q.options[0]!.description = 'If approved later: ' + q.options[0]!.description; }],
  ['quoted amendment', q => { q.options[0]!.description = '> ' + q.options[0]!.description; }],
  ['cancelled amendment', q => { q.options[0]!.description += '\nCorrection: do not apply these styles.'; }],
  ['quoted rejected amendment', q => { q.options[0]!.description += '\nThis amendment is "rejected".'; }],
  ['no opposed choice', q => { q.options[2]!.label = '1C Configure Export'; }],
  ['opposed gap closed', q => { q.options[2]!.description = q.options[2]!.description!.replace('gap stays open', 'gap is closed'); }],
  ['historical opposed choice', q => { q.options[2]!.description = 'Historical example: ' + q.options[2]!.description; }],
  ['conditional opposed choice', q => { q.options[2]!.description = 'If approved later: ' + q.options[2]!.description; }],
  ['quoted opposed choice', q => { q.options[2]!.description = '> ' + q.options[2]!.description; }],
  ['resolved gap', q => { q.options[2]!.description += '\nThe gap is now resolved.'; }],
  ['quoted rejected opposed choice', q => { q.options[2]!.description += '\nThis option is "rejected".'; }],
];
test.each(rejected)('%s does not start review', (_, change) => {
  expect(isDesignCountFirstReview(edit(change))).toBe(false);
});

test('a wholly quoted historical cancellation does not withdraw this requirement', () => {
  expect(isDesignCountFirstReview(edit(q => {
    q.question += '\nHistorical note: "This DESIGN.md contract is withdrawn."';
  }))).toBe(true);
});

test('recognition requires the same completed native identity and offered answer', () => {
  for (const change of [
    (fp: Fingerprint) => { fp.nativeCall!.answered = false; },
    (fp: Fingerprint) => { fp.nativeCall!.failed = true; },
    (fp: Fingerprint) => { fp.signature = 'foreign:tool'; },
    (fp: Fingerprint) => { fp.nativeQuestionIndex = 1; },
    (fp: Fingerprint) => { fp.nativeCall!.unansweredQuestionIndices = [0]; },
    (fp: Fingerprint) => { delete fp.nativeCall!.answeredAt; },
    (fp: Fingerprint) => { fp.nativeCall!.answers = {}; },
    (fp: Fingerprint) => { fp.options.reverse(); },
  ]) {
    const fp = original(); change(fp);
    expect(isDesignCountFirstReview(fp)).toBe(false);
  }
});

test('both source regressions select the existing Design workflow owner', () => {
  for (const file of ['test/design-primary-treatment-ao.test.ts', 'test/fixtures/design-primary-treatment-ao.json']) {
    expect(selectTests([file], E2E_TOUCHFILES, []).selected).toEqual(['plan-design-finding-count']);
  }
});
