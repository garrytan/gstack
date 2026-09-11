import { expect, test } from 'bun:test';
import { ceoFirstReviewAUQ, ceoStep0Boundary, nativePlanCallFingerprint, planCountQuestionPhase } from './helpers/claude-pty-runner';
import captured from './fixtures/ceo-section-choice-ai.json';
import metadataCaptured from './fixtures/ceo-metadata-brief-ax.json';
import { E2E_TOUCHFILES } from './helpers/touchfiles-data';

function call(index = 4): any {
  const source = structuredClone(captured.calls[index]!);
  return { sessionId: source.sessionId, toolUseId: source.toolUseId, questions: source.questions,
    answered: true, failed: false, unansweredQuestionIndices: [], answeredAt: source.answeredAt,
    answers: Object.fromEntries(source.questions.map((q, i) => [q.question, source.answers[i]])) };
}
const fp = (c: any) => nativePlanCallFingerprint(c, 0, true);
function edit(c: any, change: (text: string) => string) {
  const q = c.questions[0], answer = c.answers[q.question];
  q.question = change(q.question); c.answers = { [q.question]: answer };
}

test('exact captured section choices start review; preceding actual setup does not', () => {
  let started = false; const classified: boolean[] = [];
  for (let i = 0; i < captured.calls.length; i++) {
    const question = fp(call(i));
    expect(ceoFirstReviewAUQ(question)).toBe(captured.calls[i]!.expectedFirstReview);
    const phase = planCountQuestionPhase(question, started, ceoStep0Boundary, ceoFirstReviewAUQ);
    started = phase.reviewStarted; classified.push(phase.preReview);
  }
  expect(classified).toEqual([true, true, true, true, false, false, false, false, false]);
});

test('an offered alternative and a quoted historical withdrawal retain current review identity', () => {
  const alternative = call(); alternative.answers[alternative.questions[0].question] = alternative.questions[0].options[1].label;
  expect(ceoFirstReviewAUQ(fp(alternative))).toBe(true);
  const quoted = call(); edit(quoted, s => s + '\nHistorical quote: "This issue has been resolved."');
  expect(ceoFirstReviewAUQ(fp(quoted))).toBe(true);
});

test.each([
  ['pending', (c: any) => { c.answered = false; }],
  ['failed', (c: any) => { c.failed = true; }],
  ['unanswered index', (c: any) => { c.unansweredQuestionIndices = [0]; }],
  ['missing session', (c: any) => { c.sessionId = ''; }],
  ['missing tool id', (c: any) => { c.toolUseId = ''; }],
  ['unoffered answer', (c: any) => { c.answers[c.questions[0].question] = 'Not offered'; }],
  ['missing answer', (c: any) => { c.answers = {}; }],
  ['mixed packet', (c: any) => { c.questions.push(structuredClone(c.questions[0])); }],
  ['multi-select', (c: any) => { c.questions[0].multiSelect = true; }],
  ['duplicate options', (c: any) => { c.questions[0].options[1] = structuredClone(c.questions[0].options[0]); }],
  ['missing description', (c: any) => { c.questions[0].options[1].description = ''; }],
  ['option identity', (c: any) => { c.questions[0].options[1].label = '1B) Other'; }],
  ['section mismatch', (c: any) => edit(c, s => s.replace('Section 1 Architecture.', 'Section 2 Architecture.'))],
  ['recommendation mismatch', (c: any) => edit(c, s => s.replace('Recommendation: A', 'Recommendation: B'))],
  ['missing stakes', (c: any) => edit(c, s => s.replace(/^Stakes if we pick wrong:.*$/m, ''))],
  ['duplicate assessment', (c: any) => edit(c, s => s + '\nELI10: A second competing assessment.')],
  ['quoted assessment', (c: any) => edit(c, s => s.replace(/^ELI10: (.+)$/m, 'ELI10: "$1"'))],
  ['fenced context', (c: any) => edit(c, s => s.replace(/^(Project\/branch\/task:.*)$/m, '```\n$1\n```'))],
  ['Suppose assessment', (c: any) => edit(c, s => s.replace('ELI10: The plan', 'ELI10: Suppose the plan'))],
  ['single quoted assessment', (c: any) => edit(c, s => s.replace(/^ELI10: (.+)$/m, "ELI10: '$1'"))],
  ['current withdrawal', (c: any) => edit(c, s => s + '\nThis issue is withdrawn.')],
  ['completed withdrawal', (c: any) => edit(c, s => s + '\nWe have withdrawn this finding.')],
  ['conditional assessment', (c: any) => edit(c, s => s.replace('ELI10: The plan', 'ELI10: If the plan'))],
  ['withdrawn issue', (c: any) => edit(c, s => s + '\nWe withdraw this finding.')],
  ['resolved issue', (c: any) => edit(c, s => s + '\nThis issue has been resolved.')],
  ['administrative report', (c: any) => edit(c, s => s.replace(/^.*\n/, '1A — Should the completed review report be saved?\n'))],
  ['setup header', (c: any) => { c.questions[0].header = 'Setup'; }],
  ['borrowed qid', (c: any) => edit(c, s => s + '\n<gstack-qid:plan-ceo-review-example>')],
])('rejects %s despite numbered review prose', (_name, mutate) => {
  const c = call(); mutate(c); expect(ceoFirstReviewAUQ(fp(c))).toBe(false);
});

test('fingerprints cannot borrow another native call or its options', () => {
  const original = fp(call());
  expect(ceoFirstReviewAUQ({ ...original, signature: 'other:tool' })).toBe(false);
  expect(ceoFirstReviewAUQ({ ...original, nativeCall: undefined })).toBe(false);
  expect(ceoFirstReviewAUQ({ ...original, options: original.options.slice(1) })).toBe(false);
});

test('the regression inputs belong to the existing paid CEO case', () => {
  expect(E2E_TOUCHFILES['plan-ceo-finding-count']).toContain('test/ceo-section-choice-ai.test.ts');
  expect(E2E_TOUCHFILES['plan-ceo-finding-count']).toContain('test/fixtures/ceo-section-choice-ai.json');
});

test('coherent finished-note destination is administrative, despite matching section and choice', () => {
  const c = call(), q = c.questions[0];
  q.header = 'Destination';
  q.question = '1A — Which storage location should hold these notes?\nProject/branch/task: main, Stripe payment webhook plan, Section 1 Architecture.\nELI10: The review is finished; these notes can be saved in either folder for convenience.\nStakes if we pick wrong: People may have to look in a second folder.\nRecommendation: A because the existing folder is easier to find.';
  q.options = [{label:'A) Save beside the plan',description:'Keeps the finished notes together.'},{label:'B) Save in another folder',description:'Keeps finished notes separate.'}];
  c.answers = {[q.question]: q.options[0].label};
  expect(ceoFirstReviewAUQ(fp(c))).toBe(false);
});

test('conditional stakes remain valid when the assessment asserts the current gap', () => {
  const c = call(); edit(c, s => s.replace('Stakes if we pick wrong:', 'Stakes if we pick wrong: Suppose there were an issue.'));
  expect(ceoFirstReviewAUQ(fp(c))).toBe(true);
});

test('negated gaps and administrative missing fields cannot borrow review identity', () => {
  const negated = call(); edit(negated, s => s.replace(/^ELI10: .+$/m, 'ELI10: The transaction order is not unspecified. The plan guarantees commit before email.'));
  expect(ceoFirstReviewAUQ(fp(negated))).toBe(false);
  const admin = call(), q = admin.questions[0];
  q.header = 'Destination';
  q.question = '1A — Which storage location should hold these notes?\nProject/branch/task: main, Stripe payment webhook plan, Section 1 Architecture.\nELI10: These finished notes have a missing storage location.\nStakes if we pick wrong: People may look in the wrong folder.\nRecommendation: A because a notes folder is easy to find.';
  q.options = [{label:'A) Add a notes folder',description:'Save the finished notes together.'},{label:'B) Use the existing folder',description:'No new folder.'}];
  admin.answers = {[q.question]: q.options[0].label};
  expect(ceoFirstReviewAUQ(fp(admin))).toBe(false);
});

function metadataCall(): any {
  const c = structuredClone(metadataCaptured.call);
  return { ...c, answered: true, failed: false, unansweredQuestionIndices: [],
    answers: { [c.questions[0]!.question]: metadataCaptured.answer } };
}

test('AX ordinary D-number question keeps its exact completed review identity', () => {
  const c = metadataCall(), before = JSON.stringify(c);
  expect(ceoFirstReviewAUQ(fp(c))).toBe(true);
  expect(planCountQuestionPhase(fp(c), false, ceoStep0Boundary, ceoFirstReviewAUQ)).toMatchObject({ preReview: false, reviewStarted: true });
  expect(JSON.stringify(c)).toBe(before);
  expect(E2E_TOUCHFILES['plan-ceo-finding-count']).toContain('test/fixtures/ceo-metadata-brief-ax.json');
});

test('decision counter, review name and an alternative selection do not dictate the finding', () => {
  const c = metadataCall(); edit(c, s => s.replace(/^D5 /, 'D17 ').replace('Section 2 (Error & Rescue Map)', 'Section 3 (Failure Handling)'));
  c.answers[c.questions[0].question] = c.questions[0].options[1].label;
  expect(ceoFirstReviewAUQ(fp(c))).toBe(true);
  edit(c, s => s + '\nHistorical quote: "This finding is withdrawn."');
  expect(ceoFirstReviewAUQ(fp(c))).toBe(true);
});

test('metadata cannot replace native completion, current context or a real defect', () => {
  for (const mutate of [
    (c: any) => { c.answered = false; },
    (c: any) => { c.failed = true; },
    (c: any) => { c.answeredAt = 'not a date'; },
    (c: any) => { c.unansweredQuestionIndices = [0]; },
    (c: any) => { c.answers = { other: metadataCaptured.answer }; },
    (c: any) => { c.questions[0].header = 'Setup'; },
    (c: any) => { c.questions[0].header = 'Section 9'; },
    (c: any) => edit(c, s => s.replace('Section 2 (Error & Rescue Map)', 'Section 2 (Error & Rescue Map), Section 3 (Security)')),
    (c: any) => edit(c, s => s.replace('of the CEO review', 'of an earlier CEO review')),
    (c: any) => edit(c, s => s.replace(/^Project\/branch\/task: (.*)$/m, 'Project/branch/task: If approved, $1')),
    (c: any) => edit(c, s => s.replace(/^Project\/branch\/task:.*\n/m, '')),
    (c: any) => edit(c, s => s.replace(/^ELI10: (.*)$/m, 'ELI10: "$1"')),
    (c: any) => edit(c, s => s.replace(/^ELI10: .+$/m, 'ELI10: The handler has no current defect and needs no amendment.')),
    (c: any) => edit(c, s => s.replace(/^ELI10: .+$/m, 'ELI10: The handler commits before mail and already rescues every required error.')),
    (c: any) => edit(c, s => s.replace('ELI10: After', 'ELI10: Hypothetical example: after')),
    (c: any) => edit(c, s => s + '\nThis finding is withdrawn.'),
    (c: any) => edit(c, s => s + '; This finding is `no longer current`.'),
    (c: any) => edit(c, s => s + '\nThis finding is unproven.'),
  ]) {
    const c = metadataCall(); mutate(c); expect(ceoFirstReviewAUQ(fp(c))).toBe(false);
  }
  expect(ceoFirstReviewAUQ({ ...fp(metadataCall()), signature: 'foreign:call' })).toBe(false);
});

test('a missing or withdrawn offered remedy cannot borrow metadata or an old assessment', () => {
  for (const mutate of [
    (c: any) => { c.questions[0].options = [{ label: 'A: Keep the current handler', description: 'No code change.' }, { label: 'B: Save the review notes', description: 'Archive the current report.' }]; c.answers = { [c.questions[0].question]: c.questions[0].options[0].label }; },
    (c: any) => { c.questions[0].options[0].description += '; This option is `withdrawn`.'; c.questions[0].options[2].description += '\nThis option is withdrawn.'; },
    (c: any) => { c.questions[0].options.forEach((o: any) => { o.description = 'Hypothetical example. ' + o.description; }); },
  ]) {
    const c = metadataCall(); mutate(c); expect(ceoFirstReviewAUQ(fp(c))).toBe(false);
  }
});

function metadataRetryCall(): any {
  const c = structuredClone(metadataCaptured.retry.call);
  return { ...c, answered: true, failed: false, unansweredQuestionIndices: [],
    answers: { [c.questions[0]!.question]: metadataCaptured.retry.answer } };
}

test('the separately failed AX retry binds its Issue annotation, bare choices and named plan', () => {
  const c = metadataRetryCall(), before = JSON.stringify(c);
  expect(ceoFirstReviewAUQ(fp(c))).toBe(true);
  expect(planCountQuestionPhase(fp(c), false, ceoStep0Boundary, ceoFirstReviewAUQ))
    .toMatchObject({ preReview: false, reviewStarted: true });
  expect(JSON.stringify(c)).toBe(before);
  c.answers[c.questions[0].question] = c.questions[0].options[2].label;
  expect(ceoFirstReviewAUQ(fp(c))).toBe(true);
});

test('a reviewed filename and section identity can be consistently renamed', () => {
  const c = metadataRetryCall();
  edit(c, s => s.replace(/^D4 /, 'D12 ').replace(/Issue 2\.1/, 'Issue 8.3')
    .replace('Section 2 (Error & Rescue Map)', 'Section 8 (Notification Handling)')
    .replace(/PLAN\.md/g, 'plans/checkout-flow.md'));
  expect(ceoFirstReviewAUQ(fp(c))).toBe(true);
  edit(c, s => s + '\nHistorical quote: "This issue is withdrawn."');
  expect(ceoFirstReviewAUQ(fp(c))).toBe(true);
  edit(c, s => s.replace(/\s*<gstack-qid:[^>]+>/, ''));
  expect(ceoFirstReviewAUQ(fp(c))).toBe(true);
});

test('retry metadata cannot borrow a foreign section, plan, source or incomplete native call', () => {
  for (const [index, mutate] of [
    (c: any) => { c.answered = false; },
    (c: any) => { c.failed = true; },
    (c: any) => { c.answeredAt = 'unknown'; },
    (c: any) => { c.unansweredQuestionIndices = [0]; },
    (c: any) => { c.questions[0].header = 'Issue 8.1'; },
    (c: any) => edit(c, s => s.replace('Issue 2.1', 'Issue 3.1')),
    (c: any) => edit(c, s => s.replace('Section 2 (Error & Rescue Map)', 'Section 3 (Security)')),
    (c: any) => edit(c, s => s.replace('CEO review of PLAN.md,', 'CEO review of DIFFERENT.md,')),
    (c: any) => edit(c, s => s.replace("PLAN.md says 'no error handling on the email leg'", "OTHER.md says 'no error handling on the email leg'")),
    (c: any) => edit(c, s => s.replace('CEO review of PLAN.md,', 'Historical CEO review of PLAN.md,')),
    (c: any) => edit(c, s => s.replace(/^Project\/branch\/task: (.+)$/m, 'Project/branch/task: If approved, $1')),
    (c: any) => edit(c, s => s.replace(/^ELI10: (.+)$/m, 'ELI10: "$1"')),
    (c: any) => edit(c, s => s.replace('ELI10: The handler', 'ELI10: Source excerpt: the handler')),
    (c: any) => edit(c, s => s.replace('PLAN.md says', 'If approved, PLAN.md says')),
    (c: any) => edit(c, s => s.replace('PLAN.md says', 'PLAN.md does not say')),
    (c: any) => edit(c, s => s.replace('plan-ceo-review-mail-rescue', 'plan-ceo-review-setup')),
    (c: any) => edit(c, s => s + '\n<gstack-qid:plan-ceo-review-other>'),
  ].entries()) {
    const c = metadataRetryCall(); mutate(c); expect(ceoFirstReviewAUQ(fp(c)), `retry mutation ${index}`).toBe(false);
  }
});

test('current withdrawal and a withdrawn offered amendment override the retry brief', () => {
  for (const change of [
    (s: string) => s + '\nThis issue is withdrawn.',
    (s: string) => s + '; This finding is `no longer current`.',
    (s: string) => s + '\nIssue 2.1 is withdrawn.',
    (s: string) => s.replace(/^ELI10: .+$/m, 'ELI10: The handler has no current defect and needs no amendment.'),
  ]) {
    const c = metadataRetryCall(); edit(c, change); expect(ceoFirstReviewAUQ(fp(c))).toBe(false);
  }
  const c = metadataRetryCall(); c.questions[0].options[0].description += '; This option is `withdrawn`.';
  expect(ceoFirstReviewAUQ(fp(c))).toBe(false);
});
