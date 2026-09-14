import { expect, test } from 'bun:test';
import captured from './fixtures/eng-cache-writes-as.json';
import { engFirstReviewAUQ, engSetupAUQ, engStep0Boundary, nativePlanCallFingerprint, planCountQuestionPhase } from './helpers/claude-pty-runner';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';

const actual = () => structuredClone(captured.call) as NativePlanQuestionCall;
function answered(c: NativePlanQuestionCall, index = 0) {
  c.answers = { [c.questions[0]!.question]: c.questions[0]!.options[index]!.label };
  return nativePlanCallFingerprint(c, 0, true);
}
function allText(edit: (s: string) => string) {
  const c = actual(), q = c.questions[0]!; q.question = edit(q.question);
  for (const o of q.options) { o.label = edit(o.label); o.description = edit(o.description ?? ''); }
  return c;
}

test('the exact completed retry starts review with the current cache ownership decision', () => {
  const c = actual(), before = JSON.stringify(c), fp = nativePlanCallFingerprint(c, 0, true);
  expect(engFirstReviewAUQ(fp)).toBe(true); expect(engSetupAUQ(fp)).toBe(false);
  expect(planCountQuestionPhase(fp, false, engStep0Boundary, engFirstReviewAUQ, engSetupAUQ)).toMatchObject({ preReview: false, reviewStarted: true });
  expect(JSON.stringify(c)).toBe(before); expect(captured.provenance.retrospectivePass).toBe(false);
});

test('all offered choices and consistently renamed actors retain the same review identity', () => {
  for (const reverse of [false, true]) for (let i = 0; i < 3; i++) {
    const c = actual(); if (reverse) c.questions[0]!.options.reverse();
    expect(engFirstReviewAUQ(answered(c, i))).toBe(true);
  }
  for (const [one, two] of [['One', 'Two'], ['$Reader', '_Writer'], ['SessionMint', 'AuthBroker']]) {
    const c = allText(t => t.replaceAll('AuthBroker', '__one__').replaceAll('SessionMint', two).replaceAll('__one__', one));
    expect(engFirstReviewAUQ(answered(c))).toBe(true);
  }
  const c = allText(t => t.replace(/^D2 /, 'D17 ').replace(/\b2([A-C])\b/g, '17$1'));
  expect(engFirstReviewAUQ(answered(c))).toBe(true);
});

test('native completion, session, exact answer and option binding remain mandatory', () => {
  const mutations: Array<(c: NativePlanQuestionCall) => void> = [
    c => { c.answered = false; }, c => { c.failed = true; }, c => { c.answers = {}; },
    c => { c.answers = { [c.questions[0]!.question]: 'unoffered' }; }, c => { c.answers!['foreign'] = 'answer'; },
    c => { c.answeredAt = 'invalid'; }, c => { c.unansweredQuestionIndices = [0]; },
    c => { c.sessionId = ''; }, c => { c.toolUseId = ''; }, c => { c.questions[0]!.multiSelect = true; },
    c => { c.questions.push(structuredClone(c.questions[0]!)); }, c => { c.questions[0]!.options[1]!.label = c.questions[0]!.options[0]!.label; },
  ];
  for (const mutate of mutations) { const c = actual(); mutate(c); expect(engFirstReviewAUQ(nativePlanCallFingerprint(c, 0, true))).toBe(false); }
  const fp = answered(actual());
  expect(engFirstReviewAUQ({ ...fp, signature: 'foreign' })).toBe(false);
  expect(engFirstReviewAUQ({ ...fp, nativeQuestionIndex: 1 })).toBe(false);
  expect(engFirstReviewAUQ({ ...fp, options: [...fp.options].reverse() })).toBe(false);
});

test('title, own context, current assessment and two distinct writers are required', () => {
  for (const edit of [
    (t: string) => 'Source.\n' + t, (t: string) => '> ' + t, (t: string) => '```\n' + t + '\n```',
    (t: string) => t.replace('Who is allowed', 'Who was allowed'),
    (t: string) => t.replace('the auth cache?', 'the billing cache?'),
    (t: string) => t.replace('Project/branch/task:', 'Earlier review:'),
    (t: string) => t.replace('AuthBroker and SessionMint both', 'AuthBroker and AuthBroker both'),
    (t: string) => t.replace('both mutating one backing cache', 'both previously mutating one backing cache'),
    (t: string) => t.replace('ELI10: Two services', 'ELI10: Source. Two services'),
    (t: string) => t.replace('ELI10: Two services', 'ELI10: If approved, two services'),
    (t: string) => t.replace('nothing orders their writes.', 'their writes are serialized.'),
    (t: string) => t.replace('Project/branch/task: ', 'Project/branch/task: Assuming approval, '),
    (t: string) => t.replace('Project/branch/task: ', 'Project/branch/task: Source. '),
    (t: string) => t.replace('Multi-tenant Auth Refactor,', 'Multi-tenant Auth Refactor if approved,'),
  ]) { const c = actual(); c.questions[0]!.question = edit(c.questions[0]!.question); expect(engFirstReviewAUQ(answered(c))).toBe(false); }
  for (const header of ['Scope', 'Issue 1', 'Report', 'Cache examples']) { const c = actual(); c.questions[0]!.header = header; expect(engFirstReviewAUQ(answered(c))).toBe(false); }
});

test('owned current status beats a matching assertion while archived and foreign status does not', () => {
  for (const status of ['withdrawn', 'superseded', 'rejected', 'cancelled', 'closed', 'hypothetical', 'not current', 'no longer current']) {
    for (const [open, close] of [['', ''], ['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’'], ['`', '`']]) {
      for (const target of [-1, 0, 2]) for (const owner of ['This finding', 'D2']) {
        const c = actual(), q = c.questions[0]!, suffix = `\nCorrection: ${owner} is ${open}${status}${close}.`;
        if (target < 0) q.question += suffix; else q.options[target]!.description += suffix;
        expect(engFirstReviewAUQ(answered(c)), `${target}: ${owner} ${open}${status}${close}`).toBe(false);
      }
    }
  }
  for (const tail of ['D29 is withdrawn.', '> This finding is withdrawn.', 'The prior report said "This finding is withdrawn."', 'An archived review recorded this finding is "withdrawn".', 'An archived review recorded this finding is \'withdrawn\'.', '```\nThis finding is withdrawn.\n```']) {
    for (const target of [-1, 0, 2]) { const c = actual(), q = c.questions[0]!;
      if (target < 0) q.question += '\n' + tail; else q.options[target]!.description += '\n' + tail;
      expect(engFirstReviewAUQ(answered(c)), `${target}: ${tail}`).toBe(true);
    }
  }
});

test('a remedy and opposed choice must bind the same current writers and active race', () => {
  for (const index of [0, 2]) for (const prefix of ['Source. ', 'If approved, ', 'Assuming approval, ', 'Historical assessment: ', '> ', '"']) {
    const c = actual(), o = c.questions[0]!.options[index]!; o.description = prefix + o.description + (prefix === '"' ? '"' : '');
    expect(engFirstReviewAUQ(answered(c))).toBe(false);
  }
  for (const index of [0, 1]) for (const name of ['Foreign', 'AuthBroker']) {
    const c = actual(), o = c.questions[0]!.options[index]!; o.description = o.description!.replace('SessionMint', name);
    expect(engFirstReviewAUQ(answered(c))).toBe(false);
  }
  for (const [target, tail] of [
    [-1, 'The services no longer mutate the cache.'], [-1, 'Correction: AuthBroker no longer writes to the cache.'],
    [-1, 'The writes are now serialized.'], [-1, 'The writers are now serialized.'], [2, 'Correction: The writers are now serialized.'], [0, 'Correction: AuthBroker also writes to the cache.'],
    [0, 'The adapter accepts stale writes.'], [0, 'The version check is optional.'],
    [2, 'The race is resolved.'], [2, 'Correction: Do not keep both writers.'],
    [2, 'Only SessionMint writes to the cache.'], [2, 'Both writers no longer mutate the cache.'],
  ] as const) {
    const c = actual(), q = c.questions[0]!; if (target < 0) q.question += '\n' + tail; else q.options[target]!.description += '\n' + tail;
    expect(engFirstReviewAUQ(answered(c)), `${target}: ${tail}`).toBe(false);
  }
  for (const i of [0, 2]) { const c = actual(); c.questions[0]!.options[i]!.label = `2${i ? 'C' : 'A'} Record the report`; expect(engFirstReviewAUQ(answered(c))).toBe(false); }
});

test('new source and exact public fixture select both Eng boundary owners', () => {
  for (const file of ['test/helpers/eng-cache-writer-decision.ts', 'test/eng-cache-writes-as.test.ts', 'test/fixtures/eng-cache-writes-as.json']) {
    expect(selectTests([file], E2E_TOUCHFILES, []).selected.sort()).toEqual(['plan-eng-finding-count', 'plan-eng-multi-finding-batching']);
  }
});
