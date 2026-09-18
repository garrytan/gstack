import { expect, test } from 'bun:test';
import fixture from './fixtures/eng-cache-owner-an.json';
import { engFirstReviewAUQ, engStep0Boundary, engSetupAUQ, planCountQuestionPhase } from './helpers/claude-pty-runner';
import type { AskUserQuestionFingerprint as Fingerprint } from './helpers/claude-pty-runner';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';

type Question = NonNullable<Fingerprint['nativeCall']>['questions'][number];
const original = () => structuredClone(fixture.fingerprint) as Fingerprint;
function edit(change: (question: Question) => void): Fingerprint {
  const fp = original(), call = fp.nativeCall!, question = call.questions[0]!;
  const selected = question.options.findIndex(option => option.label === call.answers![question.question]);
  change(question);
  call.answers = { [question.question]: question.options[selected]!.label };
  fp.options = question.options.map((option, index) => ({ index: index + 1, label: option.label }));
  return fp;
}

test('an owned cache-ownership decision starts review with actors named in the current assessment', () => {
  expect(engFirstReviewAUQ(original())).toBe(true);
  expect(planCountQuestionPhase(original(), false, engStep0Boundary, engFirstReviewAUQ, engSetupAUQ))
    .toMatchObject({ preReview: false, reviewStarted: true });
  expect(fixture.fingerprint.preReview).toBe(true);
});

test('review identity survives equivalent headers, actor names and an offered opposing answer', () => {
  for (const header of ['Cache owner', 'Cache ownership', 'Shared cache', 'Issue 1', 'Architecture 1'])
    expect(engFirstReviewAUQ(edit(question => { question.header = header; }))).toBe(true);
  expect(engFirstReviewAUQ(edit(question => {
    question.question = question.question.replaceAll('AuthBroker', 'SessionOwner').replaceAll('SessionMint', 'TokenMinter');
    question.options = question.options.map(option => ({ ...option,
      description: option.description?.replaceAll('AuthBroker', 'SessionOwner').replaceAll('SessionMint', 'TokenMinter') }));
  }))).toBe(true);
  for (const option of original().nativeCall!.questions[0]!.options) {
    const fp = original(), call = fp.nativeCall!;
    call.answers = { [call.questions[0]!.question]: option.label };
    expect(engFirstReviewAUQ(fp)).toBe(true);
  }
  expect(engFirstReviewAUQ(edit(question => { question.question += '\nHistorical note: "This finding is withdrawn."'; }))).toBe(true);
});

const rejected: Array<[string, (question: Question) => void]> = [
  ['setup header', q => { q.header = 'Outside voices'; }],
  ['foreign issue identity', q => { q.header = 'Issue 2'; }],
  ['historical title', q => { q.question = 'Historical example:\n' + q.question; }],
  ['source assessment', q => { q.question = q.question.replace('\nELI10:', '\nSource:\nELI10:'); }],
  ['conditional project', q => { q.question = q.question.replace('Project/branch/task: ', 'Project/branch/task: If approved: '); }],
  ['quoted current premise', q => { q.question = q.question.replace(/ELI10: ([^\n]+)/, 'ELI10: "$1"'); }],
  ['conditional current premise', q => { q.question = q.question.replace('ELI10: AuthBroker', 'ELI10: If AuthBroker'); }],
  ['only one actual actor', q => { q.question = q.question.replace('AuthBroker and SessionMint', 'AuthBroker and AuthBroker'); }],
  ['current writes negated', q => { q.question = q.question.replace('both write into', 'neither writes into'); }],
  ['withdrawn finding', q => { q.question += '\nThis finding is withdrawn.'; }],
  ['rejected numbered issue', q => { q.question += '\nIssue 1 is rejected.'; }],
  ['assessment no longer current', q => { q.question += '\nThis assessment is not current.'; }],
  ['foreign writer', q => { q.options[0]!.description = q.options[0]!.description!.replace('Only AuthBroker writes', 'Only OtherService writes'); }],
  ['foreign producer', q => { q.options[0]!.description = q.options[0]!.description!.replace('SessionMint returns', 'OtherService returns'); }],
  ['same writer and producer', q => { q.options[0]!.description = q.options[0]!.description!.replace('SessionMint returns', 'AuthBroker returns'); }],
  ['quoted remedy', q => { q.options[0]!.description = '> ' + q.options[0]!.description; }],
  ['conditional remedy', q => { q.options[0]!.description = 'If approved: ' + q.options[0]!.description; }],
  ['cancelled remedy', q => { q.options[0]!.description += ' This remedy is cancelled.'; }],
  ['explicitly rejected injection', q => { q.options[0]!.description += ' Correction: do not inject the adapter.'; }],
  ['no opposed action', q => { q.options[2]!.label = 'C) Run another review'; }],
  ['quoted deferral', q => { q.options[2]!.description = '> ' + q.options[2]!.description; }],
  ['conditional deferral', q => { q.options[2]!.description = 'If approved: ' + q.options[2]!.description; }],
  ['no retained race', q => { q.options[2]!.description = q.options[2]!.description!.replace('Race stays open', 'Race is closed'); }],
  ['rejected opposed action', q => { q.options[2]!.description += ' This option is rejected.'; }],
  ['withdrawn single-writer requirement', q => { q.options[0]!.description += ' The single-writer requirement is withdrawn.'; }],
  ['producer also writes', q => { q.options[0]!.description += ' Correction: SessionMint will also write directly to the cache.'; }],
  ['retained race closed', q => { q.options[2]!.description += ' Correction: the race is now closed.'; }],
];
test.each(rejected)('%s does not establish the first review decision', (_, change) => {
  expect(engFirstReviewAUQ(edit(change))).toBe(false);
});

test('native ownership, completion, answer alignment and dense menus remain required', () => {
  const invalid: Array<(fp: Fingerprint) => void> = [
    fp => { fp.nativeCall!.answered = false; }, fp => { fp.nativeCall!.failed = true; },
    fp => { fp.signature = 'foreign:call'; }, fp => { fp.nativeQuestionIndex = 1; },
    fp => { fp.nativeCall!.unansweredQuestionIndices = [0]; },
    fp => { delete fp.nativeCall!.answeredAt; }, fp => { fp.nativeCall!.answers = {}; },
    fp => { fp.options.reverse(); },
  ];
  for (const change of invalid) {
    const fp = original(); change(fp);
    expect(engFirstReviewAUQ(fp)).toBe(false);
  }
});

test('new source dependencies select only the affected engineering workflow', () => {
  for (const path of ['test/eng-cache-owner-an.test.ts', 'test/fixtures/eng-cache-owner-an.json'])
    expect(selectTests([path], E2E_TOUCHFILES, []).selected).toEqual(['plan-eng-finding-count']);
});
