import { expect, test } from 'bun:test';
import { ceoFirstReviewAUQ, ceoStep0Boundary, planCountQuestionPhase, type AskUserQuestionFingerprint } from './helpers/claude-pty-runner';
import { isCeoCompletionHandoff } from './helpers/ceo-completion-handoff';
import { E2E_TOUCHFILES } from './helpers/touchfiles-data';
import fixture from './fixtures/ceo-current-omission-ap.json';

const calls = fixture.fingerprints as AskUserQuestionFingerprint[];
const first = calls[3]!;
const originalClause = 'The plan also does not say whether the email runs inside or after the DB transaction.';
function change(edit: (q: any, call: any, fp: any) => void) {
  const copy = structuredClone(first), call = copy.nativeCall!, q = call.questions[0]!;
  const selected = q.options.findIndex(o => o.label === call.answers?.[q.question]);
  edit(q, call, copy);
  call.answers = { [q.question]: q.options[selected]?.label ?? '' };
  copy.options = q.options.map((o, i) => ({ index: i + 1, label: o.label }));
  return copy;
}
test('the exact failed retry begins review at its current missing transaction contract', () => {
  expect(calls.map(ceoFirstReviewAUQ)).toEqual([false, false, false, true, false, false, false]);
  let started = false;
  const phases = calls.map(fp => { const p = planCountQuestionPhase(fp, started, ceoStep0Boundary, ceoFirstReviewAUQ, undefined, isCeoCompletionHandoff); started = p.reviewStarted; return p; });
  expect(fixture.actualCounts).toEqual({ setup: 7, review: 0 });
  expect(phases.map(p => p.preReview)).toEqual([true, true, true, false, false, false, false]);
  expect(phases.filter(p => !p.preReview && !p.administrative)).toHaveLength(4);
});
test('optional also and equivalent present-tense current owners preserve omission meaning', () => {
  for (const phrase of ['The plan does not say whether', "This plan also doesn't say whether", 'This plan does not say whether'])
    expect(ceoFirstReviewAUQ(change(q => { q.question = q.question.replace('The plan also does not say whether', phrase); }))).toBe(true);
  expect(ceoFirstReviewAUQ(change(q => { q.question = q.question.replace('D2 —', 'D19 —'); }))).toBe(true);
  expect(ceoFirstReviewAUQ(change(q => { q.question = q.question.replace('\nELI10:', '\nArchive note: "Source: this finding is withdrawn."\nELI10:'); }))).toBe(true);
  expect(ceoFirstReviewAUQ(change(q => { q.question = q.question.replace(originalClause, '"Source: this finding is withdrawn." ' + originalClause); }))).toBe(true);
});
test('source, conditional and historical declarations cannot supply the missing contract', () => {
  for (const prefix of ['Source: ', 'If approved, ', 'Previously, ', 'Earlier review assessment: ', 'The following is hypothetical. ']) {
    expect(ceoFirstReviewAUQ(change(q => { q.question = q.question.replace(originalClause, prefix + originalClause); }))).toBe(false);
    expect(ceoFirstReviewAUQ(change(q => { q.question = q.question.replace('ELI10: ', 'ELI10: ' + prefix); }))).toBe(false);
    expect(ceoFirstReviewAUQ(change(q => { q.question = q.question.replace('Project/branch/task: ', 'Project/branch/task: ' + prefix); }))).toBe(false);
  }
  for (const prefix of ['Source:', 'Earlier review assessment:', 'If approved:'])
    expect(ceoFirstReviewAUQ(change(q => { q.question = q.question.replace('\nELI10:', '\n' + prefix + '\nELI10:'); }))).toBe(false);
  for (const wrapped of ['"' + originalClause + '"', '`' + originalClause + '`', '> ' + originalClause, '```' + originalClause + '```'])
    expect(ceoFirstReviewAUQ(change(q => { q.question = q.question.replace(originalClause, wrapped); }))).toBe(false);
  for (const replacement of ['The previous plan also did not say whether', 'The plan now says whether', 'The example plan also does not say whether'])
    expect(ceoFirstReviewAUQ(change(q => { q.question = q.question.replace('The plan also does not say whether', replacement); }))).toBe(false);
});
test('the current omission and offered amendment must remain in force', () => {
  for (const status of ['This finding is withdrawn.', 'This issue is "rejected".', 'Correction: this contract is not current.', 'There is no current gap.'])
    expect(ceoFirstReviewAUQ(change(q => { q.question += '\n' + status; }))).toBe(false);
  for (const prefix of ['Source excerpt: ', 'If approved later: ', 'Earlier review assessment: '])
    expect(ceoFirstReviewAUQ(change(q => { for (const option of q.options) option.description = prefix + option.description; }))).toBe(false);
  for (const status of ['This amendment is withdrawn.', 'This remedy is "cancelled".'])
    expect(ceoFirstReviewAUQ(change(q => { for (const option of q.options) option.description += '\n' + status; }))).toBe(false);
  expect(ceoFirstReviewAUQ(change(q => { q.options = [{ label: 'A) Keep existing behavior', description: 'Leave the implementation unchanged.' }, { label: 'B) Archive the report', description: 'Save the review text.' }]; }))).toBe(false);
});
test('a current native completion, selected answer and consistent decision are still required', () => {
  for (const edit of [
    (_q: any, c: any) => { c.answered = false; }, (_q: any, c: any) => { c.failed = true; },
    (_q: any, c: any) => { c.unansweredQuestionIndices = [0]; }, (_q: any, c: any) => { delete c.answeredAt; },
    (_q: any, _c: any, f: any) => { f.signature = 'foreign:call'; }, (_q: any, _c: any, f: any) => { f.nativeQuestionIndex = 1; },
    (q: any) => { q.multiSelect = true; }, (q: any) => { q.header = 'Approach'; }, (q: any) => { q.header = 'Issue 99'; },
    (q: any) => { q.question = q.question.replace('D2 —', 'D02 —'); },
    (q: any) => { q.question = q.question.replace('Recommendation: A', 'Recommendation: Z'); },
    (q: any) => { q.question = q.question.replace('Recommendation: A', 'Recommendation: 9A'); for (const option of q.options) option.label = '9' + option.label; },
    (q: any) => { q.options[1].label = q.options[1].label.replace('B)', '3B)'); },
    (q: any) => { q.question = q.question.replace('plan-ceo-review-email-rescue', 'plan-ceo-review-setup'); },
    (q: any) => { q.question = q.question.replace('ELI10: ', 'ELI10 omitted: '); },
    (q: any) => { q.question = q.question.replace(/\nProject\/branch\/task:[^\n]+/, ''); },
  ]) expect(ceoFirstReviewAUQ(change(edit))).toBe(false);
  const noAnswer = structuredClone(first); noAnswer.nativeCall!.answers = {}; expect(ceoFirstReviewAUQ(noAnswer)).toBe(false);
  const menu = structuredClone(first); menu.options[0]!.label = 'Unowned'; expect(ceoFirstReviewAUQ(menu)).toBe(false);
  expect(ceoFirstReviewAUQ({ ...first, nativeCall: undefined })).toBe(false);
});
test('only the existing dense CEO finding owner selects the retry regression', () => {
  for (const path of ['test/ceo-current-omission-ap.test.ts', 'test/fixtures/ceo-current-omission-ap.json'])
    expect(Object.entries(E2E_TOUCHFILES).filter(([, files]) => files.includes(path)).map(([owner]) => owner)).toEqual(['plan-ceo-finding-count']);
  const paths = E2E_TOUCHFILES['plan-ceo-finding-count']!;
  for (let i = 0; i < paths.length; i++) { expect(Object.hasOwn(paths, i)).toBe(true); expect(typeof paths[i]).toBe('string'); }
});
