import { expect, test } from 'bun:test';
import { ceoFirstReviewAUQ, ceoStep0Boundary, nativePlanCallFingerprint, planCountQuestionPhase } from './helpers/claude-pty-runner';
import captured from './fixtures/ceo-finding-brief-ak.json';
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
test('the completed parenthesized finding with letter-only choices starts current review', () => {
  expect(ceoFirstReviewAUQ(fp(call()))).toBe(true);
});
test('the exact retry phase preserves four setup calls then six substantive choices', () => {
  let started = false;
  const phases = captured.calls.map(c => {
    const phase = planCountQuestionPhase(fp(c), started, ceoStep0Boundary, ceoFirstReviewAUQ);
    started = phase.reviewStarted; return phase.preReview;
  });
  expect(phases).toEqual([true, true, true, true, false, false, false, false, false, false]);
});

test('the finding identity is independent of decision number, separator and optional qid', () => {
  for (const change of [
    (s: string) => s.replace(/^D5/, 'D19'),
    (s: string) => s.replace(') — ', ') - '),
    (s: string) => s.replace('Finding 1.1', 'Finding 9.4'),
    (s: string) => s.replace('Finding 1.1', 'Finding 1'),
    (s: string) => s.replace(/\s*<gstack-qid:[^>]+>\s*$/, ''),
    (s: string) => s.replace(/\s*<gstack-qid:[^>]+>\s*$/, '') + '\n<gstack-qid:plan-ceo-review-finding-mail>',
    (s: string) => s.replace('lets any mail failure', 'allows any mail failure'),
  ]) { const c = call(); edit(c, change); expect(ceoFirstReviewAUQ(fp(c))).toBe(true); }
  for (const label of call().questions[0].options.map((o: any) => o.label)) {
    const c = call(); c.answers[c.questions[0].question] = label;
    expect(ceoFirstReviewAUQ(fp(c))).toBe(true);
  }
  const numbered = call(); edit(numbered, s => s.replace(/^Recommendation: A/m, 'Recommendation: 1A'));
  offered(numbered, o => { o.label = o.label.replace(/^([A-Z])\)/, '1$1)'); });
  expect(ceoFirstReviewAUQ(fp(numbered))).toBe(true);
  const header = call(); header.questions[0].header = 'Finding 1.1';
  expect(ceoFirstReviewAUQ(fp(header))).toBe(true);
});

test('competing finding, section, recommendation and offered choice identities are rejected', () => {
  for (const mutate of [
    (c: any) => { c.questions[0].header = 'Finding 1'; },
    (c: any) => { c.questions[0].header = 'Finding 9.1'; },
    (c: any) => { c.questions[0].header = 'Approach'; },
    (c: any) => edit(c, s => s.replace('Finding 1.1', 'Finding 1.0')),
    (c: any) => edit(c, s => s.replace('Finding 1.1', 'Finding 1.1 and Finding 2.1')),
    (c: any) => edit(c, s => s.replace(/^Recommendation: A/m, 'Recommendation: 2A')),
    (c: any) => edit(c, s => s.replace(/^Recommendation: A/m, 'Recommendation: Z')),
    (c: any) => { c.questions[0].options[0].label = '9A) Foreign issue'; c.answers = { [c.questions[0].question]: c.questions[0].options[0].label }; },
    (c: any) => { c.questions[0].options[1].label = 'A) Same choice letter, different action'; },
    (c: any) => { c.questions[0].options[1].label = c.questions[0].options[0].label; },
    (c: any) => edit(c, s => s + '\n<gstack-qid:plan-eng-review-finding-mail>'),
  ]) { const c = call(); mutate(c); expect(ceoFirstReviewAUQ(fp(c))).toBe(false); }
});

test('a current complete assessment cannot come from source, conditions or a withdrawal', () => {
  for (const change of [
    (s: string) => 'Example: ' + s,
    (s: string) => '> ' + s,
    (s: string) => '```\n' + s + '\n```',
    (s: string) => s.replace(/^ELI10: .+$/m, ''),
    (s: string) => s.replace(/^ELI10: (.+)$/m, 'ELI10: "$1"'),
    (s: string) => s.replace(/^ELI10: /m, 'ELI10: If approved, '),
    (s: string) => s.replace(/^ELI10: /m, 'ELI10: The following is a quoted source excerpt. '),
    (s: string) => s.replace(/^ELI10: /m, 'ELI10: The following is a hypothetical example. '),
    (s: string) => s + '\nThis finding is withdrawn.',
    (s: string) => s + '\nFinding 1.1 is rejected.',
    (s: string) => s + '\nNo current defect remains.',
    (s: string) => s.replace(/^ELI10: .+$/m, 'ELI10: The plan no longer lets mail failures escape the handler. The current named rescue keeps them contained.'),
    (s: string) => s.replace(/^ELI10: .+$/m, 'ELI10: The plan used to let mail failures escape the handler. That was the prior behavior.'),
    (s: string) => s.replace(/^ELI10: .+$/m, 'ELI10: The plan does not let mail failures escape the handler.'),
    (s: string) => s.replace(/^ELI10: .+$/m, 'ELI10: Source excerpt: the plan lets mail failures escape the handler.'),
    (s: string) => s.replace(/^ELI10: .+$/m, 'ELI10: Previously, the plan lets mail failures escape the handler.'),
    (s: string) => s.replace(/^ELI10: .+$/m, 'ELI10: The plan lets no mail failure escape the handler.'),
    (s: string) => s.replace(/^ELI10: .+$/m, 'ELI10: The plan allows mail failures to escape only in a historical quoted example.'),
    (s: string) => s.replace(/^ELI10: .+$/m, 'ELI10: Source excerpt. The plan lets mail failures escape the handler.'),
    (s: string) => s.replace(/^ELI10: .+$/m, 'ELI10: The plan allows mail failures to never escape the handler.'),
  ]) { const c = call(); edit(c, change); expect(ceoFirstReviewAUQ(fp(c))).toBe(false); }
  const c = call(); edit(c, s => s + '\nOld note: "Finding 1.1 is rejected."');
  expect(ceoFirstReviewAUQ(fp(c))).toBe(true);
});

test('current finding prose must offer an actual remedy, not an advisory or hypothetical action', () => {
  for (const description of [
    'Archive this review for later.',
    'Historical source excerpt: ✅ Rescue named mail exceptions.',
    'The following is a quoted source excerpt. ✅ Rescue named mail exceptions.',
    'If approved: ✅ Rescue named mail exceptions.',
    '❌ Rescue named mail exceptions.',
    '✅ "Rescue named mail exceptions."',
    '✅ If approved, rescue named mail exceptions.',
  ]) {
    const c = call(); offered(c, (o, i) => { o.label = `${String.fromCharCode(65 + i)}) Consider candidate ${i}`; o.description = description; });
    expect(ceoFirstReviewAUQ(fp(c))).toBe(false);
  }
});

test('the completed native call, exact offered answer and fingerprint remain mandatory', () => {
  for (const mutate of [
    (c: any) => { c.answered = false; },
    (c: any) => { c.failed = true; },
    (c: any) => { c.unansweredQuestionIndices = [0]; },
    (c: any) => { c.sessionId = ''; },
    (c: any) => { c.toolUseId = ''; },
    (c: any) => { c.answers = {}; },
    (c: any) => { c.answers[c.questions[0].question] = 'Unrelated answer'; },
    (c: any) => { c.questions[0].multiSelect = true; },
    (c: any) => { c.questions.push(structuredClone(c.questions[0])); },
    (c: any) => { c.questions[0].options[1].description = ''; },
  ]) { const c = call(); mutate(c); expect(ceoFirstReviewAUQ(fp(c))).toBe(false); }
  const f = fp(call());
  expect(ceoFirstReviewAUQ({ ...f, signature: 'foreign:tool' })).toBe(false);
  expect(ceoFirstReviewAUQ({ ...f, nativeCall: undefined })).toBe(false);
  expect(ceoFirstReviewAUQ({ ...f, options: f.options.slice(1) })).toBe(false);
});

test('retry fixture and controls select only the existing CEO count owner', () => {
  for (const dependency of ['test/ceo-finding-brief-ak.test.ts', 'test/fixtures/ceo-finding-brief-ak.json']) {
    expect(Object.entries(E2E_TOUCHFILES).filter(([, paths]) => paths.includes(dependency)).map(([name]) => name)).toEqual(['plan-ceo-finding-count']);
  }
});
