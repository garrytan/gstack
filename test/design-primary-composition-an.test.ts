import { expect, test } from 'bun:test';
import captured from './fixtures/design-primary-composition-an.json';
import { isDesignCountFirstReview, isDesignCountSetup } from './helpers/design-count-review';
import { designStep0Boundary, planCountQuestionPhase } from './helpers/claude-pty-runner';
import type { AskUserQuestionFingerprint as Fingerprint } from './helpers/claude-pty-runner';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';

type Question = NonNullable<Fingerprint['nativeCall']>['questions'][number];
const original = () => structuredClone(captured.fingerprint) as Fingerprint;
function edit(change: (question: Question) => void): Fingerprint {
  const fp = original(), call = fp.nativeCall!, question = call.questions[0]!;
  const chosen = question.options.findIndex(option => option.label === call.answers![question.question]);
  change(question);
  call.answers = { [question.question]: question.options[chosen]!.label };
  fp.options = question.options.map((option, index) => ({ index: index + 1, label: option.label }));
  return fp;
}

test('the exact completed first Issue starts the existing review phase', () => {
  const fp = original();
  expect(isDesignCountFirstReview(fp)).toBe(true);
  expect(planCountQuestionPhase(fp, false, designStep0Boundary, isDesignCountFirstReview, isDesignCountSetup))
    .toEqual({ preReview: false, reviewStarted: true });
  // The old run's observation is retained; this is a prospective replay.
  expect(captured.fingerprint.preReview).toBe(true);
});

test('primary qualifiers and authority position compose independently of wording', () => {
  for (const qualifier of ['single', 'single filled', 'only', 'only filled', 'visible']) {
    for (const authority of ['Apply DESIGN.md: ', 'Apply DESIGN.md tokens: ', 'suffix']) {
      const fp = edit(question => {
        question.question = question.question.replace('single filled primary', `${qualifier} primary`);
        const style = question.options[0]!.description!.replace('Apply DESIGN.md: ', '');
        question.options[0]!.description = authority === 'suffix' ? `${style} Exact DESIGN.md.` : authority + style;
      });
      expect(isDesignCountFirstReview(fp)).toBe(true);
    }
  }
});

test('an offered alternate answer, renamed control, and numeric retained count preserve the decision', () => {
  for (const option of original().nativeCall!.questions[0]!.options) {
    const fp = original(), call = fp.nativeCall!;
    call.answers = { [call.questions[0]!.question]: option.label };
    expect(isDesignCountFirstReview(fp)).toBe(true);
  }
  expect(isDesignCountFirstReview(edit(question => {
    question.question = question.question.replaceAll('Save', 'Submit');
    question.options = question.options.map(option => ({
      label: option.label.replaceAll('Save', 'Submit'),
      description: option.description?.replaceAll('Save', 'Submit').replace('four header buttons', '4 buttons'),
    }));
  }))).toBe(true);
});

const rejected: Array<[string, (question: Question) => void]> = [
  ['foreign issue header', q => { q.header = 'Issue 2'; }],
  ['reviewer setup title', q => { q.question = q.question.replace('Make Save the single filled primary action in the header', 'Run outside design voices'); }],
  ['historical question', q => { q.question = 'Historical example:\n' + q.question; }],
  ['source-framed assessment', q => { q.question = q.question.replace('\nELI10:', '\nSource excerpt:\nELI10:'); }],
  ['quoted assessment', q => { q.question = q.question.replace('\nELI10:', '\n> ELI10:'); }],
  ['conditional assessment', q => { q.question = q.question.replace('ELI10: Right now', 'ELI10: If right now'); }],
  ['unequal current controls', q => { q.question = q.question.replace('look identical', 'do not look identical'); }],
  ['withdrawn finding', q => { q.question += '\nThis issue is withdrawn.'; }],
  ['missing style authority', q => { q.options[0]!.description = q.options[0]!.description!.replace('Apply DESIGN.md: ', ''); }],
  ['wrong named primary', q => { q.options[0]!.description = q.options[0]!.description!.replace('Save filled', 'Reset filled'); }],
  ['missing foreground', q => { q.options[0]!.description = q.options[0]!.description!.replace('/white', ''); }],
  ['missing ghost treatment', q => { q.options[0]!.description = q.options[0]!.description!.replace('neutral ghost buttons', 'filled buttons'); }],
  ['primary also offered as ghost', q => { q.options[0]!.description = q.options[0]!.description!.replace('; Reset', '; Save'); }],
  ['conditional amendment', q => { q.options[0]!.description = 'If approved later: ' + q.options[0]!.description; }],
  ['quoted amendment', q => { q.options[0]!.description = '> ' + q.options[0]!.description; }],
  ['cancelled amendment', q => { q.options[0]!.description += ' Correction: do not apply these styles.'; }],
  ['no opposed choice', q => { q.options[2]!.label = '1C Configure Export'; }],
  ['wrong retained count', q => { q.options[2]!.description = q.options[2]!.description!.replace('four', 'three'); }],
  ['conditional deferral', q => { q.options[2]!.description = 'If approved later: ' + q.options[2]!.description; }],
  ['historical deferral', q => { q.options[2]!.description = 'Historical example: ' + q.options[2]!.description; }],
  ['resolved deferral', q => { q.options[2]!.description += ' The gap is now resolved.'; }],
  ['conditional project metadata', q => { q.question = q.question.replace('Project/branch/task: ', 'Project/branch/task: If approved: '); }],
  ['rejected current issue', q => { q.question += '\nIssue 1 is rejected.'; }],
  ['cancelled current issue', q => { q.question += '\nThis issue is cancelled.'; }],
  ['rejected amendment', q => { q.options[0]!.description += ' This amendment is rejected.'; }],
  ['styles no longer current', q => { q.options[0]!.description += ' Correction: these styles are not current.'; }],
  ['rejected opposed option', q => { q.options[2]!.description += ' This option is rejected.'; }],
  ['cancelled retained buttons', q => { q.options[2]!.description += ' Correction: do not keep all four buttons identical.'; }],
  ['quoted rejected current issue', q => { q.question += '\nThis issue is "rejected".'; }],
  ['quoted cancelled amendment', q => { q.options[0]!.description += ' This amendment is "cancelled".'; }],
  ['quoted styles no longer current', q => { q.options[0]!.description += ' Correction: these styles are "not current".'; }],
  ['quoted rejected opposed option', q => { q.options[2]!.description += ' This option is "rejected".'; }],
];
test.each(rejected)('%s cannot start review', (_, change) => {
  expect(isDesignCountFirstReview(edit(change))).toBe(false);
});

test('quoted historical withdrawal does not cancel the current issue', () => {
  expect(isDesignCountFirstReview(edit(q => { q.question += '\nHistorical note: "This issue is withdrawn."'; }))).toBe(true);
});

test('recognition still requires an owned, completed and aligned native answer', () => {
  const invalid: Array<(fp: Fingerprint) => void> = [
    fp => { fp.nativeCall!.answered = false; },
    fp => { fp.nativeCall!.failed = true; },
    fp => { fp.signature = 'foreign:tool'; },
    fp => { fp.nativeQuestionIndex = 1; },
    fp => { fp.nativeCall!.unansweredQuestionIndices = [0]; },
    fp => { delete fp.nativeCall!.answeredAt; },
    fp => { fp.nativeCall!.answers = {}; },
    fp => { fp.options.reverse(); },
  ];
  for (const change of invalid) {
    const fp = original(); change(fp);
    expect(isDesignCountFirstReview(fp)).toBe(false);
  }
});

test('the regression and public fixture select the affected Design workflow', () => {
  for (const path of ['test/design-primary-composition-an.test.ts', 'test/fixtures/design-primary-composition-an.json'])
    expect(selectTests([path], E2E_TOUCHFILES, []).selected).toEqual(['plan-design-finding-count']);
});
