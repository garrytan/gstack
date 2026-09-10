import { expect, test } from 'bun:test';
import { ceoFirstReviewAUQ, ceoStep0Boundary, nativePlanCallFingerprint, planCountQuestionPhase } from './helpers/claude-pty-runner';
import captured from './fixtures/ceo-section-choice-ai.json';
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
