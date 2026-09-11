import { expect, test } from 'bun:test';
import { ceoFirstReviewAUQ, ceoStep0Boundary, planCountQuestionPhase, type AskUserQuestionFingerprint } from './helpers/claude-pty-runner';
import { isCeoCompletionHandoff } from './helpers/ceo-completion-handoff';
import { E2E_TOUCHFILES } from './helpers/touchfiles-data';
import fixture from './fixtures/ceo-declarative-premise-ap.json';

const calls = fixture.fingerprints as AskUserQuestionFingerprint[];
const first = calls[2]!;
function change(fp: AskUserQuestionFingerprint, edit: (q: any, call: any, fp: any) => void) {
  const copy = structuredClone(fp), call = copy.nativeCall!, q = call.questions[0]!;
  const selected = q.options.findIndex(o => o.label === call.answers?.[q.question]);
  edit(q, call, copy);
  call.answers = { [q.question]: q.options[selected]?.label ?? '' };
  copy.options = q.options.map((o, i) => ({ index: i + 1, label: o.label }));
  return copy;
}

test('the exact completed defect premises start review; later calls use unchanged phase continuation', () => {
  expect(calls.map(ceoFirstReviewAUQ)).toEqual([false, false, true, true, false, false]);
  let started = false;
  const phases = calls.map(fp => {
    const phase = planCountQuestionPhase(fp, started, ceoStep0Boundary, ceoFirstReviewAUQ, undefined, isCeoCompletionHandoff);
    started = phase.reviewStarted;
    return phase;
  });
  expect(fixture.actualCounts).toEqual({ setup: 6, review: 0 });
  expect(phases.map(p => p.preReview)).toEqual([true, true, false, false, false, false]);
  expect(phases.filter(p => !p.preReview && !p.administrative)).toHaveLength(4);
});

test('current metadata, premise and explanation cannot borrow quoted, historical or conditional authority', () => {
  for (const fp of calls.slice(2, 4)) {
    for (const prefix of ['Source:', 'Earlier review assessment:', 'If approved:', 'Example:'])
      expect(ceoFirstReviewAUQ(change(fp, q => { q.question = q.question.replace('\nELI10:', '\n' + prefix + '\nELI10:'); }))).toBe(false);
    for (const prefix of ['If approved, ', 'Source excerpt: ', 'Earlier review assessment: ', 'The following is a hypothetical example. ', 'Previously, ', 'Formerly, ']) {
      expect(ceoFirstReviewAUQ(change(fp, q => { q.question = q.question.replace('ELI10: ', 'ELI10: ' + prefix); }))).toBe(false);
      expect(ceoFirstReviewAUQ(change(fp, q => { q.question = q.question.replace('Project/branch/task: ', 'Project/branch/task: ' + prefix); }))).toBe(false);
    }
    for (const replacement of ['Source: The ', 'If approved, the ', 'The historical ', 'The quoted ', 'The previously '])
      expect(ceoFirstReviewAUQ(change(fp, q => { q.question = q.question.replace('— The ', '— ' + replacement); }))).toBe(false);
    for (const wrap of [(s: string) => `"${s}"`, (s: string) => '`' + s + '`', (s: string) => '> ' + s])
      expect(ceoFirstReviewAUQ(change(fp, q => { const title = q.question.split('\n')[0]; q.question = q.question.replace(title, wrap(title)); }))).toBe(false);
    expect(ceoFirstReviewAUQ(change(fp, q => { q.question = q.question.replace(/\nProject\/branch\/task:[^\n]+/, ''); }))).toBe(false);
  }
});

test('a current finding and its offered amendments cannot be withdrawn', () => {
  for (const fp of calls.slice(2, 4)) {
    for (const status of ['This finding is withdrawn.', 'This issue is "rejected".', 'Correction: this assessment is not current.', 'There is no current gap.'])
      expect(ceoFirstReviewAUQ(change(fp, q => { q.question += '\n' + status; }))).toBe(false);
    for (const prefix of ['Source excerpt: ', 'If approved later: ', 'Previously, ', 'Formerly, '])
      expect(ceoFirstReviewAUQ(change(fp, q => { for (const option of q.options) option.description = prefix + option.description; }))).toBe(false);
    for (const status of ['This amendment is withdrawn.', 'This remedy is "cancelled".'])
      expect(ceoFirstReviewAUQ(change(fp, q => { for (const option of q.options) option.description += '\n' + status; }))).toBe(false);
    expect(ceoFirstReviewAUQ(change(fp, q => { for (const option of q.options) option.description = JSON.stringify(option.description); }))).toBe(false);
    expect(ceoFirstReviewAUQ(change(fp, q => { q.question = q.question.replace('\nELI10:', '\nArchive note: "Source: this finding is withdrawn."\nELI10:'); }))).toBe(true);
  }
});

test('statement-only and administrative menus are not review decisions', () => {
  expect(ceoFirstReviewAUQ(change(first, q => { q.question = q.question.replace(' How should the handler treat a mail failure?', ''); }))).toBe(false);
  expect(ceoFirstReviewAUQ(change(first, q => { q.question = q.question.replace(' How should the handler treat a mail failure?', ' Record this in the report.'); }))).toBe(false);
  expect(ceoFirstReviewAUQ(change(first, q => {
    q.options = [
      { label: '2A) Keep the existing implementation', description: 'Leave current behavior unchanged.' },
      { label: '2B) Archive the report', description: 'Save the existing review text.' },
    ];
  }))).toBe(false);
  expect(ceoFirstReviewAUQ(change(first, q => { q.header = 'Approach'; }))).toBe(false);
});

test('the native completion, selected answer and issue identities stay bound', () => {
  for (const edit of [
    (_q: any, c: any) => { c.answered = false; },
    (_q: any, c: any) => { c.failed = true; },
    (_q: any, c: any) => { c.unansweredQuestionIndices = [0]; },
    (_q: any, c: any) => { delete c.answeredAt; },
    (_q: any, c: any) => { c.answeredAt = 'not-a-time'; },
    (_q: any, _c: any, f: any) => { f.signature = 'foreign:call'; },
    (_q: any, _c: any, f: any) => { f.nativeQuestionIndex = 1; },
    (q: any) => { q.multiSelect = true; },
    (q: any) => { q.header = 'Issue 99'; },
    (q: any) => { q.header = 'Issue 0'; },
    (q: any) => { q.header = 'Issue 02'; },
    (q: any) => { q.question = q.question.replace('(Issue 2)', '(Issue 0)'); },
    (q: any) => { q.question = q.question.replace('D4 (', 'D04 ('); },
    (q: any) => { q.question = q.question.replace('Recommendation: 2A', 'Recommendation: 9A'); },
    (q: any) => { q.options[1].label = q.options[1].label.replace('2B)', '3B)'); },
  ]) expect(ceoFirstReviewAUQ(change(first, edit))).toBe(false);
  const wrongAnswer = structuredClone(first); wrongAnswer.nativeCall!.answers = {};
  expect(ceoFirstReviewAUQ(wrongAnswer)).toBe(false);
  const wrongMenu = structuredClone(first); wrongMenu.options[0]!.label = 'Foreign';
  expect(ceoFirstReviewAUQ(wrongMenu)).toBe(false);
  expect(ceoFirstReviewAUQ({ ...first, nativeCall: undefined })).toBe(false);
});

test('equivalent current wording and descriptive or matching issue headers preserve the decision', () => {
  for (const header of ['Email contract', 'Issue 2', 'Finding 2'])
    expect(ceoFirstReviewAUQ(change(first, q => { q.header = header; }))).toBe(true);
  for (const separator of ['—', '–', '-'])
    expect(ceoFirstReviewAUQ(change(first, q => { q.question = q.question.replace('D4 (Issue 2) —', `D19 (Issue 2) ${separator}`); }))).toBe(true);
  expect(ceoFirstReviewAUQ(change(first, q => { q.question = q.question.replace('How should the handler treat a mail failure?', 'Which handling should the current implementation use?'); }))).toBe(true);
  expect(ceoFirstReviewAUQ(change(calls[3]!, q => { q.question = q.question.replace('request.params.userId', 'payload.accountId'); }))).toBe(true);
});

test('the regression fixture is registered only to the dense CEO finding owner', () => {
  for (const path of ['test/ceo-declarative-premise-ap.test.ts', 'test/fixtures/ceo-declarative-premise-ap.json'])
    expect(Object.entries(E2E_TOUCHFILES).filter(([, files]) => files.includes(path)).map(([owner]) => owner)).toEqual(['plan-ceo-finding-count']);
  const paths = E2E_TOUCHFILES['plan-ceo-finding-count']!;
  for (let i = 0; i < paths.length; i++) { expect(Object.hasOwn(paths, i)).toBe(true); expect(typeof paths[i]).toBe('string'); }
});
