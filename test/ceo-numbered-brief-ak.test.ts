import { expect, test } from 'bun:test';
import { ceoFirstReviewAUQ, ceoStep0Boundary, nativePlanCallFingerprint, planCountQuestionPhase } from './helpers/claude-pty-runner';
import captured from './fixtures/ceo-numbered-brief-ak.json';
import { E2E_TOUCHFILES } from './helpers/touchfiles-data';

const call = (index = 4): any => structuredClone(captured.calls[index]);
const fp = (c: any) => nativePlanCallFingerprint(c, 0, true);
function edit(c: any, change: (s: string) => string) {
  const q = c.questions[0], answer = c.answers[q.question];
  q.question = change(q.question); c.answers = { [q.question]: answer };
}
function offered(c: any, change: (o: any, i: number) => void) {
  const q = c.questions[0], selected = q.options.findIndex((o: any) => o.label === c.answers[q.question]);
  q.options.forEach(change); c.answers = { [q.question]: q.options[selected].label };
}

for (const [index, name] of [[4, 'email ordering'], [5, 'raw SQL'], [6, 'missing automated tests'], [7, 'N+1 read']] as const) {
  test(`actual completed ${name} brief starts substantive CEO review`, () => {
    expect(ceoFirstReviewAUQ(fp(call(index)))).toBe(true);
  });
}

test('the complete captured phase retains routing and factual clarification as setup', () => {
  let started = false;
  const phases = captured.calls.map(c => {
    const phase = planCountQuestionPhase(fp(c), started, ceoStep0Boundary, ceoFirstReviewAUQ);
    started = phase.reviewStarted;
    return phase.preReview;
  });
  expect(phases).toEqual([true, true, true, true, false, false, false, false]);
  for (const c of captured.calls.slice(0, 4)) expect(ceoFirstReviewAUQ(fp(c))).toBe(false);
});

test('issue ownership survives equivalent separators, optional qids and consistent renumbering', () => {
  for (let index = 4; index < 8; index++) {
    for (const separator of ['—', '–', '-']) {
      const c = call(index); edit(c, s => s.replace(/^D\d+ — /, `D12 ${separator} `).replace(/\s*<gstack-qid:[^>]+>\s*$/, ''));
      expect(ceoFirstReviewAUQ(fp(c))).toBe(true);
    }
    const c = call(index), old = index - 2;
    edit(c, s => s.replace(`Issue ${old}:`, 'Issue 19:').replace(new RegExp('\\b' + old + '([A-Z])\\b', 'g'), '19$1'));
    offered(c, o => { o.label = o.label.replace(/^\d+/, '19'); });
    expect(ceoFirstReviewAUQ(fp(c))).toBe(true);
    c.answers[c.questions[0].question] = c.questions[0].options[2].label;
    expect(ceoFirstReviewAUQ(fp(c))).toBe(true);
  }
});

test('display effort and positive bullet decoration do not change an offered action', () => {
  for (let index = 4; index < 8; index++) for (const change of [
    (s: string) => s.replace(/Human [^.]+\. /, 'Human 2 days / CC 30 minutes. '),
    (s: string) => s.replace(/Human [^.]+\. /, '').replace(/✅ /g, ''),
    (s: string) => s.replace(/✅ /g, '✅   '),
  ]) {
    const c = call(index); offered(c, o => { o.description = change(o.description); });
    expect(ceoFirstReviewAUQ(fp(c))).toBe(true);
  }
  const suite = call(6); offered(suite, o => { o.label = o.label.replace('unit + integration', 'unit and integration'); });
  expect(ceoFirstReviewAUQ(fp(suite))).toBe(true);
});

test('native completion, the offered answer and exact fingerprint remain mandatory', () => {
  for (let index = 4; index < 8; index++) for (const mutate of [
    (c: any) => { c.answered = false; },
    (c: any) => { c.failed = true; },
    (c: any) => { c.unansweredQuestionIndices = [0]; },
    (c: any) => { c.sessionId = ''; },
    (c: any) => { c.toolUseId = ''; },
    (c: any) => { c.answers = {}; },
    (c: any) => { c.answers[c.questions[0].question] = 'Unrelated answer'; },
    (c: any) => { c.questions[0].multiSelect = true; },
    (c: any) => { c.questions.push(structuredClone(c.questions[0])); },
    (c: any) => { c.questions[0].header = 'Approach'; },
    (c: any) => { c.questions[0].options[1].description = ''; },
    (c: any) => { c.questions[0].options[1].label = c.questions[0].options[0].label; },
    (c: any) => edit(c, s => s.replace(/<gstack-qid:[^>]+>/, '<gstack-qid:plan-eng-review-finding>')),
  ]) { const c = call(index); mutate(c); expect(ceoFirstReviewAUQ(fp(c))).toBe(false); }
  for (let index = 4; index < 8; index++) {
    const f = fp(call(index));
    expect(ceoFirstReviewAUQ({ ...f, signature: 'foreign:tool' })).toBe(false);
    expect(ceoFirstReviewAUQ({ ...f, nativeCall: undefined })).toBe(false);
    expect(ceoFirstReviewAUQ({ ...f, options: f.options.slice(1) })).toBe(false);
  }
});

test('a current issue cannot borrow another issue identity or recommendation', () => {
  for (let index = 4; index < 8; index++) for (const mutate of [
    (c: any) => edit(c, s => s.replace(/Issue \d+:/, 'Issue 99:')),
    (c: any) => { c.questions[0].header = 'Finding 99'; },
    (c: any) => { c.questions[0].options[1].label = '99B: Foreign choice'; },
    (c: any) => { c.questions[0].options[1].label = c.questions[0].options[1].label.replace(/B:/, 'A:'); },
    (c: any) => edit(c, s => s.replace(/^Recommendation: \d+[A-Z]/m, 'Recommendation: 99A')),
    (c: any) => edit(c, s => s.replace(/^Recommendation: .+$/m, '')),
    (c: any) => edit(c, s => s + '\nRecommendation: 99A'),
  ]) { const c = call(index); mutate(c); expect(ceoFirstReviewAUQ(fp(c))).toBe(false); }
});

test('source, hypothetical and withdrawn assessments do not start current review', () => {
  for (let index = 4; index < 8; index++) for (const change of [
    (s: string) => 'Example: ' + s,
    (s: string) => '> ' + s,
    (s: string) => '```\n' + s + '\n```',
    (s: string) => s.replace(/^ELI10: (.+)$/m, 'ELI10: "$1"'),
    (s: string) => s.replace(/^ELI10: /m, 'ELI10: If approved, '),
    (s: string) => s.replace(/^ELI10: /m, 'ELI10: Suppose '),
    (s: string) => s.replace(/^ELI10: /m, 'ELI10: The following is a quoted source excerpt. '),
    (s: string) => s.replace(/^ELI10: /m, 'ELI10: The following is a hypothetical example. '),
    (s: string) => s.replace(/^ELI10: .+$/m, ''),
    (s: string) => s + '\nThis issue has been withdrawn.',
    (s: string) => s + `\nIssue ${index - 2} is resolved.`,
    (s: string) => s + '\nNo current issue remains.',
  ]) { const c = call(index); edit(c, change); expect(ceoFirstReviewAUQ(fp(c))).toBe(false); }
  for (let index = 4; index < 8; index++) {
    const c = call(index); edit(c, s => s + '\nOld note: "This issue has been withdrawn."');
    expect(ceoFirstReviewAUQ(fp(c))).toBe(true);
  }
});

test('the new declarative findings still need an asserted current defect', () => {
  for (const [index, title] of [
    [5, 'the lookup does not interpolate request.params.userId into a raw SQL fragment.'],
    [5, 'the lookup no longer interpolates request.params.userId into a raw SQL fragment.'],
    [5, 'the lookup used to interpolate user input into a raw SQL string.'],
    [6, 'automated tests are planned for the new payment handler.'],
    [7, 'the handler no longer fetches each order in a loop (N+1).'],
    [7, 'the handler reads all orders with one query.'],
  ] as const) {
    const c = call(index);
    edit(c, s => s.replace(/^(D\d+ — Issue \d+: ).+$/m, '$1' + title)
      .replace(/^ELI10: .+$/m, title.includes('used to')
        ? 'ELI10: The previous lookup used to interpolate user input into a raw SQL string. The current lookup uses bound parameters and has no injection risk.'
        : 'ELI10: The current implementation satisfies the stated contract.'));
    expect(ceoFirstReviewAUQ(fp(c))).toBe(false);
  }
});

test('only an offered current amendment can supply remedy evidence', () => {
  for (let index = 4; index < 8; index++) for (const description of [
    'Keep this advisory report for reference.',
    'Human ~3h / CC ~15min. ❌ Add bounded error handling.',
    'Human ~3h / CC ~15min. ❌ A prior proposal. Add bounded error handling.',
    'Human ~3h / CC ~15min. ✅ "Add bounded error handling."',
    'Human ~3h / CC ~15min. ✅ If approved, add bounded error handling.',
    'Human ~3h / CC ~15min. ✅ Write the completed report.',
    'Historical source excerpt: ✅ Add bounded error handling.',
    'If approved: ✅ Add bounded error handling.',
    'Hypothetical example: ✅ Add bounded error handling.',
    'The following is a quoted source excerpt. ✅ Add bounded error handling.',
    'The following is a hypothetical example. ✅ Add bounded error handling.',
  ]) {
    const c = call(index);
    offered(c, (o, i) => { o.label = `${index - 2}${String.fromCharCode(65 + i)}: Consider candidate ${i}`; o.description = description; });
    expect(ceoFirstReviewAUQ(fp(c))).toBe(false);
  }
});

test('only the existing CEO finding-count owner selects this regression fixture', () => {
  for (const dependency of ['test/ceo-numbered-brief-ak.test.ts', 'test/fixtures/ceo-numbered-brief-ak.json']) {
    expect(Object.entries(E2E_TOUCHFILES).filter(([, paths]) => paths.includes(dependency)).map(([name]) => name))
      .toEqual(['plan-ceo-finding-count']);
  }
});
