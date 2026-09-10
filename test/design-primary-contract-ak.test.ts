import { describe, expect, test } from 'bun:test';
import fixture from './fixtures/design-primary-contract-ak.json';
import { isDesignCountFirstReview } from './helpers/design-count-review';
import type { AskUserQuestionFingerprint } from './helpers/claude-pty-runner';

type FP = AskUserQuestionFingerprint;
type Question = NonNullable<FP['nativeCall']>['questions'][number];
const original = () => structuredClone(fixture.fingerprint) as unknown as FP;
function edit(change: (q: Question, fp: FP) => void): FP {
  const fp = original(), call = fp.nativeCall!, q = call.questions[0]!;
  const selected = q.options.findIndex(o => o.label === call.answers![q.question]);
  change(q, fp);
  call.answers = { [q.question]: q.options[selected]!.label };
  fp.options = q.options.map((o, i) => ({ index: i + 1, label: o.label }));
  return fp;
}
function replaceText(q: Question, from: string, to: string): void {
  q.question = q.question.replaceAll(from, to);
  q.options = q.options.map(o => ({
    ...o, label: o.label.replaceAll(from, to),
    description: o.description?.replaceAll(from, to),
  }));
}

describe('current primary-action contract from a completed native issue', () => {
  test('the owned Issue 1 is a review decision despite colon-numbered options', () => {
    expect(isDesignCountFirstReview(original())).toBe(true);
  });
  test.each([
    ['renamed primary control', (q: Question) => replaceText(q, 'Save', 'Submit')],
    ['other prescribed color', (q: Question) => replaceText(q, '#1d4ed8', '#234abc')],
    ['numeric button count', (q: Question) => replaceText(q, 'are four identical buttons', 'are 4 identical buttons')],
    ['explicit all button count', (q: Question) => replaceText(q, 'are four identical buttons', 'are all four identical buttons')],
    ['uncounted current equality', (q: Question) => replaceText(q, 'are four identical buttons', 'are identical buttons')],
    ['parenthesized option separators', (q: Question) => {
      q.options = q.options.map(o => ({ ...o, label: o.label.replace(/^1([ABC]):/, '1$1)') }));
    }],
    ['current pro/con decline', (q: Question) => { q.options[2]!.description = '✅ No implementation work now. ✅ No visual retesting. ❌ ' + q.options[2]!.description; }],
    ['same contract with explicit button noun', (q: Question) => {
      q.options[0]!.description = q.options[0]!.description!.replace('neutral ghost.', 'neutral ghost buttons.');
    }],
  ])('%s preserves the actual contract', (_, change) => {
    expect(isDesignCountFirstReview(edit(change))).toBe(true);
  });
  const negatives: Array<[string, (q: Question, fp: FP) => void]> = [
    ['failed call', (_, fp) => { fp.nativeCall!.failed = true; }],
    ['unanswered call', (_, fp) => { fp.nativeCall!.answered = false; }],
    ['pending question', (_, fp) => { fp.nativeCall!.unansweredQuestionIndices = [0]; }],
    ['missing successful answer time', (_, fp) => { delete fp.nativeCall!.answeredAt; }],
    ['invalid answer time', (_, fp) => { fp.nativeCall!.answeredAt = 'unknown'; }],
    ['unowned signature', (_, fp) => { fp.signature = 'other:call'; }],
    ['missing session', (_, fp) => { fp.nativeCall!.sessionId = ''; }],
    ['multiple questions', (q, fp) => { fp.nativeCall!.questions.push(structuredClone(q)); }],
    ['multiple selections', q => { q.multiSelect = true; }],
    ['competing issue header', q => { q.header = 'Issue 2'; }],
    ['competing control header', q => { q.header = 'Issue 1: Cancel'; }],
    ['competing option identity', q => { q.options[0]!.label = q.options[0]!.label.replace('1A:', '2A:'); }],
    ['duplicate options', q => { q.options[1]!.label = q.options[0]!.label; }],
    ['historical assessment', q => replaceText(q, 'ELI10: Right now', 'ELI10: Previously')],
    ['quoted assessment', q => replaceText(q, 'ELI10: Right now', 'ELI10: "Right now')],
    ['conditional assessment', q => replaceText(q, 'ELI10: Right now', 'ELI10: If right now')],
    ['negated equality', q => replaceText(q, 'are four identical buttons', 'are not identical buttons')],
    ['other equal controls', q => replaceText(q, 'Right now Save, Reset', 'Right now Undo, Reset')],
    ['no current assessment', q => { q.question = q.question.replace(/^ELI10:.*\n/m, ''); }],
    ['hypothetical issue', q => { q.question += '\nThis issue is hypothetical.'; }],
    ['withdrawn issue', q => { q.question += '\nIssue 1 has been withdrawn.'; }],
    ['resolved issue', q => { q.question += '\nNo current gap remains.'; }],
    ['amendment only quotes source', q => { q.options[0]!.description = '> ' + q.options[0]!.description; }],
    ['conditional amendment', q => { q.options[0]!.description = 'If approved later, ' + q.options[0]!.description; }],
    ['negated amendment', q => { q.options[0]!.description = 'Do not ' + q.options[0]!.description; }],
    ['other primary amendment', q => { q.options[0]!.description = q.options[0]!.description!.replace('Save #', 'Reset #'); }],
    ['administrative record action', q => { q.options[0]!.description = 'Record the current review in the plan file.'; }],
    ['wrong design authority', q => { q.options[0]!.description = q.options[0]!.description!.replace('DESIGN.md', 'an archived example'); }],
    ['no fill prescribed', q => { q.options[0]!.description = q.options[0]!.description!.replace('filled with', 'outlined with'); }],
    ['no ghost secondary controls', q => { q.options[0]!.description = q.options[0]!.description!.replace('neutral ghost', 'identical filled'); }],
    ['no opposed choice', q => { q.options[2]!.label = '1C: Export settings instead'; }],
    ['opposed choice does not retain the gap', q => { q.options[2]!.description = 'The gap is already fixed; file the report.'; }],
    ['opposed choice withdraws finding', q => { q.options[2]!.description += ' Issue 1 is withdrawn.'; }],
    ['fenced assessment', q => { q.question = q.question.replace(/^(ELI10:.*)$/m, '```text\n$1\n```'); }],
    ['competing assessments', q => { q.question += '\nELI10: Save is already the unique primary action; all secondary controls are ghosts.'; }],
    ['assessment relabelled as history', q => { q.question = q.question.replace(/^(ELI10:.*)$/m, '$1 Correction: the identical-buttons sentence is a historical example, not the current UI.'); }],
    ['primary also styled as secondary', q => { q.options[0]!.description = q.options[0]!.description!.replace('Reset, Cancel, Export neutral ghost.', 'Save, Reset, Cancel, Export neutral ghost.'); }],
    ['later style cancellation', q => { q.options[0]!.description += ' Correction: do not apply these tokens; Save remains identical to the other buttons.'; }],
    ['historical icon-prefixed decline', q => { q.options[2]!.description = 'Historical source excerpt: ❌ ' + q.options[2]!.description; }],
    ['conditional icon-prefixed decline', q => { q.options[2]!.description = 'If approved later: ❌ ' + q.options[2]!.description; }],
    ['historical pro/con decline', q => { q.options[2]!.description = '✅ Historical example: no implementation work. ❌ ' + q.options[2]!.description; }],
    ['conditional pro/con decline', q => { q.options[2]!.description = '✅ If approved later: no implementation work. ❌ ' + q.options[2]!.description; }],
    ['opposed gap later resolved', q => { q.options[2]!.description += ' Correction: this gap is already resolved; no style change is required.'; }],
  ];
  test.each(negatives)('%s is not current completed review evidence', (_, change) => {
    expect(isDesignCountFirstReview(edit(change))).toBe(false);
  });
  test('an unknown answer or mismatched rendered menu cannot supply completion', () => {
    const answer = original();
    answer.nativeCall!.answers = { [answer.nativeCall!.questions[0]!.question]: 'not offered' };
    expect(isDesignCountFirstReview(answer)).toBe(false);
    const menu = original();
    menu.options[0]!.label = 'different visible choice';
    expect(isDesignCountFirstReview(menu)).toBe(false);
  });
});
