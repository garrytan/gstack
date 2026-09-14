import { expect, test } from 'bun:test';
import { ceoFirstReviewAUQ, ceoStep0Boundary, nativePlanCallFingerprint, planCountQuestionPhase } from './helpers/claude-pty-runner';
import captured from './fixtures/ceo-annotation-aj.json';
import { E2E_TOUCHFILES } from './helpers/touchfiles-data';

const call = (index = 3): any => structuredClone(captured.cases.paired.calls[index]);
const fp = (c: any) => nativePlanCallFingerprint(c, 0, true);
function edit(c: any, change: (s: string) => string) {
  const q = c.questions[0], answer = c.answers[q.question];
  q.question = change(q.question); c.answers = { [q.question]: answer };
}

test('completed native receipt and retry findings retain identity through section annotations', () => {
  for (const index of [3, 4]) expect(ceoFirstReviewAUQ(fp(call(index)))).toBe(true);
});

test('actual setup remains excluded before the two completed assertion findings', () => {
  let started = false;
  const phases = captured.cases.paired.calls.map(c => {
    const phase = planCountQuestionPhase(fp(c), started, ceoStep0Boundary, ceoFirstReviewAUQ);
    started = phase.reviewStarted;
    return phase.preReview;
  });
  expect(phases).toEqual([true, true, true, false, false]);
  const approach = structuredClone(captured.cases.distinct.calls[2]);
  expect(ceoFirstReviewAUQ(fp(approach))).toBe(false);
});

test('the new captured inputs belong only to the existing CEO count owner', () => {
  for (const dependency of ['test/ceo-annotation-aj.test.ts', 'test/fixtures/ceo-annotation-aj.json']) {
    expect(Object.entries(E2E_TOUCHFILES).filter(([, paths]) => paths.includes(dependency)).map(([name]) => name))
      .toEqual(['plan-ceo-finding-count']);
  }
});

test('section references do not replace finding or native option identity', () => {
  for (const index of [3, 4]) {
    const c = call(index);
    edit(c, s => s.replace(/\(Sections? [^)]+\)/, '(Sections 3, 5 and 8, Error Handling)'));
    expect(ceoFirstReviewAUQ(fp(c))).toBe(true);
    c.answers[c.questions[0].question] = c.questions[0].options[1].label;
    expect(ceoFirstReviewAUQ(fp(c))).toBe(true);
    const renamed = call(index), q = renamed.questions[0], old = String(index - 2);
    edit(renamed, s => s.replace(new RegExp('Finding F' + old), 'Finding F9')
      .replace(new RegExp('^Recommendation: ' + old, 'm'), 'Recommendation: 9')
      .replace(new RegExp('^' + old + '([A-Z][)])', 'gm'), '9$1'));
    q.header = q.header.replace(/^F\d+/, 'F9');
    q.options.forEach((o: any) => { o.label = o.label.replace(/^\d+/, '9'); });
    renamed.answers = { [q.question]: q.options[0].label };
    expect(ceoFirstReviewAUQ(fp(renamed))).toBe(true);
  }
});

test('source frames and conditional or missing assessments cannot supply a current finding', () => {
  for (const index of [3, 4]) for (const change of [
    (s: string) => 'Example: ' + s,
    (s: string) => '> ' + s,
    (s: string) => '```\n' + s + '\n```',
    (s: string) => s.replace(/^ELI10: (.+)$/m, 'ELI10: `$1`'),
    (s: string) => s.replace(/^ELI10: (.+)$/m, 'ELI10: "$1"'),
    (s: string) => s.replace(/^ELI10: /m, 'ELI10: If '),
    (s: string) => s.replace(/^ELI10: /m, 'ELI10: Suppose '),
    (s: string) => s.replace(/^ELI10: .+$/m, ''),
    (s: string) => s + '\nELI10: A second contradictory assessment.',
    (s: string) => s.replace(/: the (success|repeated)/, ': the hypothetical $1'),
    (s: string) => s.replace(/\(Sections? [^)]+\)/, '(Section 6, Quoted Source)'),
    (s: string) => s.replace(/\(Sections? [^)]+\)/, '(Section 6, Historical Example)'),
  ]) { const c = call(index); edit(c, change); expect(ceoFirstReviewAUQ(fp(c))).toBe(false); }
});

test('same-brief withdrawals defeat a finding while attributed historical quotes do not', () => {
  for (const index of [3, 4]) {
    for (const tail of ['This issue is withdrawn.', 'We have withdrawn this finding.',
      'There is no current defect or unresolved issue.', `F${index - 2} is rejected.`]) {
      const c = call(index); edit(c, s => s + '\n' + tail); expect(ceoFirstReviewAUQ(fp(c))).toBe(false);
    }
    const quoted = call(index); edit(quoted, s => s + '\nOld note: "This issue is withdrawn."');
    expect(ceoFirstReviewAUQ(fp(quoted))).toBe(true);
  }
});

test('administrative options and stale action rows do not amend the current contract', () => {
  for (const index of [3, 4]) {
    for (const wording of ['Start review', 'Pause', 'Write the completed report']) {
      const stale = call(index), native = stale.questions[0];
      native.options.forEach((o: any, i: number) => {
        o.label = `${index - 2}${String.fromCharCode(65 + i)}: ${wording}`;
        o.description = wording;
      });
      stale.answers = { [native.question]: native.options[0].label };
      expect(ceoFirstReviewAUQ(fp(stale))).toBe(false);
    }
    const c = call(index), q = c.questions[0];
    q.options.forEach((o: any, i: number) => {
      o.label = `${index - 2}${String.fromCharCode(65 + i)}: Archive the completed report ${i}`;
      o.description = 'Save the completed review for reference.';
    });
    c.answers = { [q.question]: q.options[0].label };
    expect(ceoFirstReviewAUQ(fp(c))).toBe(false);
    const noGap = call(index);
    edit(noGap, s => s.replace(/^D\d+[^\n]+/, `D4 — Finding F${index - 2} (Sections 2 and 6): where should the completed report be stored?`)
      .replace(/^ELI10: .+$/m, 'ELI10: The review is complete and all assertions already enforce the full contract.'));
    expect(ceoFirstReviewAUQ(fp(noGap))).toBe(false);
    const negated = call(index);
    edit(negated, s => s.replace(/asserts only/, 'does not assert only')
      .replace(/^ELI10: .+$/m, 'ELI10: The assertions enforce the complete receipt and retry contracts.'));
    expect(ceoFirstReviewAUQ(fp(negated))).toBe(false);
  }
});

test('completion, recommendation, identity and actual offered options remain required', () => {
  for (const index of [3, 4]) for (const mutate of [
    (c: any) => { c.answered = false; },
    (c: any) => { c.failed = true; },
    (c: any) => { c.unansweredQuestionIndices = [0]; },
    (c: any) => { c.sessionId = ''; },
    (c: any) => { c.answers = {}; },
    (c: any) => { c.answers[c.questions[0].question] = 'Foreign answer'; },
    (c: any) => { c.questions[0].multiSelect = true; },
    (c: any) => { c.questions.push(structuredClone(c.questions[0])); },
    (c: any) => { c.questions[0].header = 'Approach'; },
    (c: any) => { c.questions[0].header = 'Finding 99'; },
    (c: any) => { c.questions[0].options[1].description = ''; },
    (c: any) => { c.questions[0].options[1].label = '99B: Different finding'; },
    (c: any) => edit(c, s => s.replace(/^Recommendation: .+$/m, 'Recommendation: 99Z')),
    (c: any) => edit(c, s => s.replace(/^Recommendation: .+$/m, '')),
    (c: any) => edit(c, s => s + '\n<gstack-qid:plan-eng-review-finding>'),
  ]) { const c = call(index); mutate(c); expect(ceoFirstReviewAUQ(fp(c))).toBe(false); }
  for (const index of [3, 4]) {
    const original = fp(call(index));
    expect(ceoFirstReviewAUQ({ ...original, signature: 'foreign:call' })).toBe(false);
    expect(ceoFirstReviewAUQ({ ...original, nativeCall: undefined })).toBe(false);
    expect(ceoFirstReviewAUQ({ ...original, options: original.options.slice(1) })).toBe(false);
  }
});

test('completed dotted issue briefs retain their full identity and section option binding', () => {
  for (const source of captured.cases.distinct.calls.slice(4)) {
    expect(ceoFirstReviewAUQ(fp(source))).toBe(true);
  }
  let started = false;
  const phases = captured.cases.distinct.calls.map(c => {
    const phase = planCountQuestionPhase(fp(c), started, ceoStep0Boundary, ceoFirstReviewAUQ);
    started = phase.reviewStarted;
    return phase.preReview;
  });
  expect(phases).toEqual([true, true, true, true, false, false, false, false, false]);
});

test('dotted issue syntax never supplies missing current defect or remedy evidence', () => {
  for (const source of captured.cases.distinct.calls.slice(4)) {
    const identity = /\(Issue ([\d.]+)\)/.exec(source.questions[0]!.question)![1]!;
    for (const change of [
      (s: string) => 'Example: ' + s,
      (s: string) => s.replace(/^ELI10: /m, 'ELI10: If '),
      (s: string) => s.replace(/^ELI10: /m, 'ELI10: Historical example: '),
      (s: string) => s.replace(/^ELI10: (.+)$/m, 'ELI10: `$1`'),
      (s: string) => s.replace(/^ELI10: .+$/m, ''),
      (s: string) => s.replace(/^ELI10: .+$/m, 'ELI10: The completed review has no current defect or unresolved issue.'),
      (s: string) => s.replace(/^ELI10: .+$/m, 'ELI10: The existing behavior satisfies every contract and needs no change.'),
      (s: string) => s + '\nThis issue has been resolved.',
      (s: string) => s + `\nIssue ${identity} is rejected.`,
      (s: string) => s.replace(/^Recommendation: \d+[A-Z]/m, 'Recommendation: 99Z'),
      (s: string) => s + '\n<gstack-qid:plan-eng-review-finding>',
    ]) { const c = structuredClone(source); edit(c, change); expect(ceoFirstReviewAUQ(fp(c))).toBe(false); }
    const sourceOnly = structuredClone(source), q = sourceOnly.questions[0]!;
    q.options.forEach((o, i) => { o.label = `${identity.split('.')[0]}${String.fromCharCode(65 + i)}: Archive the completed report ${i}`; o.description = 'Save the completed review.'; });
    sourceOnly.answers = { [q.question]: q.options[0]!.label };
    expect(ceoFirstReviewAUQ(fp(sourceOnly))).toBe(false);
    const quoted = structuredClone(source); edit(quoted, s => s + `\nOld note: "Issue ${identity} is rejected."`);
    expect(ceoFirstReviewAUQ(fp(quoted))).toBe(true);
  }
});

test('dotted identities remain complete while the option prefix names the containing section', () => {
  for (const source of captured.cases.distinct.calls.slice(4)) {
    const identity = /\(Issue ([\d.]+)\)/.exec(source.questions[0]!.question)![1]!;
    for (const mutate of [
      (c: any) => { c.answered = false; },
      (c: any) => { c.failed = true; },
      (c: any) => { c.unansweredQuestionIndices = [0]; },
      (c: any) => { c.answers = {}; },
      (c: any) => { c.answers[c.questions[0].question] = 'Unrelated answer'; },
      (c: any) => { c.questions[0].header = 'Approach'; },
      (c: any) => { c.questions[0].header = `Finding ${identity.split('.')[0]}`; },
      (c: any) => { c.questions[0].header = 'Issue 99.1'; },
      (c: any) => { c.questions[0].options[1].label = '99B: Borrowed option'; },
      (c: any) => { c.questions[0].options[1].description = ''; },
      (c: any) => { c.questions[0].multiSelect = true; },
      (c: any) => { c.questions.push(structuredClone(c.questions[0])); },
      (c: any) => edit(c, s => s.replace(`Issue ${identity}`, 'Issue 1.0')),
    ]) { const c = structuredClone(source); mutate(c); expect(ceoFirstReviewAUQ(fp(c))).toBe(false); }
    const header = structuredClone(source); header.questions[0]!.header = `Finding ${identity}`;
    expect(ceoFirstReviewAUQ(fp(header))).toBe(true);
    const localQid = structuredClone(source); edit(localQid, s => s + '\n<gstack-qid:plan-ceo-review-handler-correctness>');
    expect(ceoFirstReviewAUQ(fp(localQid))).toBe(true);
    expect(ceoFirstReviewAUQ({ ...fp(source), signature: 'foreign:call' })).toBe(false);
    expect(ceoFirstReviewAUQ({ ...fp(source), nativeCall: undefined })).toBe(false);
  }
});


test('an owning assessment declaration cannot relabel source or hypothetical prose as a current finding', () => {
  for (const source of [...captured.cases.paired.calls.slice(3), ...captured.cases.distinct.calls.slice(4)]) {
    for (const frame of [
      'The following is a quoted source excerpt.',
      'The following is a hypothetical example.',
      'This assessment is only a historical example.',
    ]) {
      const c = structuredClone(source);
      edit(c, s => s.replace(/^ELI10: /m, 'ELI10: ' + frame + ' '));
      expect(ceoFirstReviewAUQ(fp(c))).toBe(false);
    }
    const quoted = structuredClone(source);
    edit(quoted, s => s.replace(/^(ELI10: .+)$/m, '$1 Old note: "The following is a hypothetical example."'));
    expect(ceoFirstReviewAUQ(fp(quoted))).toBe(true);
  }
});
