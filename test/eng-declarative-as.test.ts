import { expect, test } from 'bun:test';
import captured from './fixtures/eng-declarative-as.json';
import { engFirstReviewAUQ, engSetupAUQ, engStep0Boundary, nativePlanCallFingerprint, planCountQuestionPhase } from './helpers/claude-pty-runner';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';

const actual = () => structuredClone(captured.call) as NativePlanQuestionCall;
function answered(c: NativePlanQuestionCall, index = 0) {
  c.answers = { [c.questions[0]!.question]: c.questions[0]!.options[index]!.label };
  return nativePlanCallFingerprint(c, 0, true);
}
function edit(replace: (text: string) => string) {
  const c = actual(), q = c.questions[0]!;
  q.question = replace(q.question);
  q.options.forEach(o => { o.label = replace(o.label); o.description = replace(o.description ?? ''); });
  return c;
}

test('a completed declarative cache issue starts review without a question mark or qid', () => {
  const fp = answered(actual());
  expect(engFirstReviewAUQ(fp)).toBe(true);
  expect(engSetupAUQ(fp)).toBe(false);
  expect(planCountQuestionPhase(fp, false, engStep0Boundary, engFirstReviewAUQ, engSetupAUQ)).toMatchObject({ preReview: false, reviewStarted: true });
  expect(captured.provenance.retrospectivePass).toBe(false);
});

test('all answers, option orders, identifiers and consistent ordinals qualify', () => {
  for (const reverse of [false, true]) for (let i = 0; i < 3; i++) {
    const c = actual(); if (reverse) c.questions[0]!.options.reverse();
    expect(engFirstReviewAUQ(answered(c, i))).toBe(true);
  }
  for (const name of ['TenantCache', '$Shared', '_Store']) expect(engFirstReviewAUQ(answered(edit(t => t.replaceAll('AuthCache', name))))).toBe(true);
  for (const [one, two] of [['First', 'Second'], ['Z_store', '$Reader'], ['SessionMint', 'AuthBroker']]) {
    expect(engFirstReviewAUQ(answered(edit(t => t.replaceAll('AuthBroker', '__first__').replaceAll('SessionMint', two).replaceAll('__first__', one))))).toBe(true);
  }
  for (const kind of ['Issue', 'Finding']) expect(engFirstReviewAUQ(answered(edit(t => t.replace('Issue 1 ', `${kind} 17 `).replace(/\b1([A-C])\b/g, '17$1'))))).toBe(true);
});

test('native completion and matching answered menu remain required', () => {
  const mutations: Array<(c: NativePlanQuestionCall) => void> = [
    c => { c.answered = false; }, c => { c.failed = true; }, c => { c.answers = {}; },
    c => { c.answers = { [c.questions[0]!.question]: 'unoffered' }; }, c => { c.answers!['foreign'] = 'answer'; },
    c => { c.answeredAt = 'invalid'; }, c => { c.unansweredQuestionIndices = [0]; },
    c => { c.sessionId = ''; }, c => { c.toolUseId = ''; }, c => { c.questions[0]!.multiSelect = true; },
    c => { c.questions.push(structuredClone(c.questions[0]!)); },
    c => { c.questions[0]!.options[1]!.label = c.questions[0]!.options[0]!.label; },
  ];
  for (const mutate of mutations) { const c = actual(); mutate(c); expect(engFirstReviewAUQ(nativePlanCallFingerprint(c, 0, true))).toBe(false); }
  const fp = answered(actual());
  expect(engFirstReviewAUQ({ ...fp, signature: 'foreign' })).toBe(false);
  expect(engFirstReviewAUQ({ ...fp, nativeQuestionIndex: 1 })).toBe(false);
  expect(engFirstReviewAUQ({ ...fp, options: [...fp.options].reverse() })).toBe(false);
});

test('the brief must own a current architecture assessment and distinct writers', () => {
  const changes = [
    (t: string) => 'Example: ' + t, (t: string) => '> ' + t, (t: string) => '```\n' + t + '\n```',
    (t: string) => t.replace('Section 1 Architecture', 'Section 1 Administration'),
    (t: string) => t.replace('ELI10: Two services', 'ELI10: If two services'),
    (t: string) => t.replace('ELI10: Two services', 'ELI10: Source example: Two services'),
    (t: string) => t.replace('AuthBroker and SessionMint share', 'AuthBroker and AuthBroker share'),
    (t: string) => t.replace('share a global mutable', 'used to share a global mutable'),
    (t: string) => t.replace('writes can interleave', 'writes are serialized').replace('no ordering', 'per-key ordering'),
    (t: string) => t.replace('Project/branch/task:', 'Historical assessment:'),
  ];
  for (const change of changes) { const c = actual(); c.questions[0]!.question = change(c.questions[0]!.question); expect(engFirstReviewAUQ(answered(c))).toBe(false); }
  for (const header of ['Setup', 'TODOs', 'Issue 2', 'Review report']) { const c = actual(); c.questions[0]!.header = header; expect(engFirstReviewAUQ(answered(c))).toBe(false); }
});

test('same-decision withdrawals and contrary current state invalidate the issue', () => {
  for (const status of ['withdrawn', 'superseded', 'rejected', 'cancelled', 'resolved', 'closed', 'not current', 'no longer current']) {
    for (const literal of [status, `"${status}"`, `“${status}”`, `'${status}'`, `‘${status}’`, '`' + status + '`']) for (const target of ['question', 'remedy', 'unchanged']) {
      const c = actual(), q = c.questions[0]!, suffix = ` This finding is ${literal}.`;
      if (target === 'question') q.question += suffix; else q.options[target === 'remedy' ? 0 : 2]!.description += suffix;
      expect(engFirstReviewAUQ(answered(c))).toBe(false);
    }
  }
  for (const contradiction of ['The cache is no longer global.', 'The services no longer mutate shared state.', 'No current risk remains.']) {
    const c = actual(); c.questions[0]!.question += '\n' + contradiction; expect(engFirstReviewAUQ(answered(c))).toBe(false);
  }
});

test('technical options cannot be quoted, hypothetical, mismatched or cancelled', () => {
  for (const index of [0, 2]) for (const frame of ['Example: ', 'If approved: ', 'Source excerpt: ', '> ']) {
    const c = actual(); c.questions[0]!.options[index]!.description = frame + c.questions[0]!.options[index]!.description;
    expect(engFirstReviewAUQ(answered(c))).toBe(false);
  }
  for (const [index, suffix] of [[0, ' Correction: Do not remove the module-level export.'], [0, ' The module export remains.'], [0, ' Writes remain unordered.'], [2, ' Correction: Do not proceed as written.'], [2, ' The race is resolved.']] as const) {
    const c = actual(); c.questions[0]!.options[index]!.description += suffix; expect(engFirstReviewAUQ(answered(c))).toBe(false);
  }
  for (const index of [0, 2]) { const c = actual(); c.questions[0]!.options[index]!.label = '1' + (index ? 'C' : 'A') + ') Record in report'; expect(engFirstReviewAUQ(answered(c))).toBe(false); }
  const c = actual(); c.questions[0]!.options[0]!.description = c.questions[0]!.options[0]!.description!.replaceAll('AuthCache', 'UnrelatedCache');
  expect(engFirstReviewAUQ(answered(c))).toBe(false);
});

test('new boundary regressions select the two Eng count owners', () => {
  for (const file of ['test/eng-declarative-as.test.ts', 'test/fixtures/eng-declarative-as.json']) expect(selectTests([file], E2E_TOUCHFILES, []).selected.sort()).toEqual(['plan-eng-finding-count', 'plan-eng-multi-finding-batching']);
});


test('current named-owner contradictions are distinct from foreign and archived references', () => {
  for (const statement of ['AuthCache is no longer global.', 'AuthCache is no longer mutable.', 'AuthBroker no longer mutates the cache.', 'SessionMint no longer writes to the cache.', 'D4 is withdrawn.', 'Correction: This finding is withdrawn.', 'Correction: Issue 1 is "withdrawn".', 'Correction: AuthCache is no longer global.', "Issue 1 is 'withdrawn'.", 'This finding is “withdrawn”.']) {
    for (const boundary of ['\n', '; ']) {
      const c = actual(); c.questions[0]!.question += boundary + statement;
      expect(engFirstReviewAUQ(answered(c))).toBe(false);
    }
  }
  for (const statement of ['Issue 19 is withdrawn.', 'D42 is withdrawn.', 'AnotherCache is no longer global.', 'An archived review recorded this finding is "withdrawn".', "An archived review recorded this finding is 'withdrawn'.", 'The prior report said "This finding is withdrawn."', '> This finding is withdrawn.']) {
    const c = actual(); c.questions[0]!.question += '\n' + statement;
    expect(engFirstReviewAUQ(answered(c))).toBe(true);
  }
  for (const replacement of ['an unrelated billing cache', 'a different cache', 'an OtherCache']) {
    const c = actual(); c.questions[0]!.options[2]!.description = c.questions[0]!.options[2]!.description!.replace('an auth cache', replacement);
    expect(engFirstReviewAUQ(answered(c))).toBe(false);
  }
  const c = actual(); c.questions[0]!.options[2]!.description = c.questions[0]!.options[2]!.description!.replace('an auth cache', 'an AuthCache');
  expect(engFirstReviewAUQ(answered(c))).toBe(true);
});


test('the unchanged option cannot contradict its own remaining cache risk', () => {
  for (const statement of ['Correction: The writers are now serialized.', 'AuthCache is no longer global.', 'The cache is removed.']) {
    const c = actual(); c.questions[0]!.options[2]!.description += '\n' + statement;
    expect(engFirstReviewAUQ(answered(c))).toBe(false);
  }
});
