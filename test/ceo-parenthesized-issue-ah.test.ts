import { expect, test } from 'bun:test';
import fixture from './fixtures/ceo-parenthesized-issue-ah.json';
import { ceoFirstReviewAUQ, ceoStep0Boundary, nativePlanCallFingerprint, planCountQuestionPhase } from './helpers/claude-pty-runner';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';

const calls = () => structuredClone(fixture.calls) as NativePlanQuestionCall[];
const fp = (c: NativePlanQuestionCall) => nativePlanCallFingerprint(c, 0, true);
function reanswer(c: NativePlanQuestionCall) {
  c.answers = { [c.questions[0]!.question]: c.questions[0]!.options[0]!.label };
  return c;
}
function changed(original: NativePlanQuestionCall, mutate: (c: NativePlanQuestionCall) => void) {
  const c = structuredClone(original); mutate(c); return reanswer(c);
}

test('both exact completed Issue questions start review with descriptive headers', () => {
  for (const c of calls()) expect(ceoFirstReviewAUQ(fp(c))).toBe(true);
  let started = false;
  const counts = { setup: 0, review: 0 };
  for (const c of [...fixture.setupCalls, ...calls()] as NativePlanQuestionCall[]) {
    const phase = planCountQuestionPhase(fp(c), started, ceoStep0Boundary, ceoFirstReviewAUQ);
    started = phase.reviewStarted;
    counts[phase.preReview ? 'setup' : 'review']++;
  }
  expect(counts).toEqual({ setup: 2, review: 2 });
  expect(fixture.historicalOutcome).toBe('no_review_questions');
});

test('fixture questions and selected answers are exact owned public request/result projections', () => {
  for (const c of calls()) {
    const requests = fixture.publicEvents.filter(e => e.record.message.content.some(b => 'id' in b && b.id === c.toolUseId));
    const results = fixture.publicEvents.filter(e => e.record.message.content.some(b => 'tool_use_id' in b && b.tool_use_id === c.toolUseId));
    expect(requests).toHaveLength(1); expect(results).toHaveLength(1);
    expect(requests[0]!.record.sessionId).toBe(c.sessionId);
    expect(results[0]!.record.sessionId).toBe(c.sessionId);
    const request = requests[0]!.record.message.content.find(b => 'id' in b && b.id === c.toolUseId) as any;
    expect(request.input.questions).toEqual(c.questions);
    const result = results[0]!.record.message.content.find(b => 'tool_use_id' in b && b.tool_use_id === c.toolUseId) as any;
    expect(result.is_error).not.toBe(true);
    expect(result.content).toContain(`"${c.questions[0]!.question}"="${c.answers![c.questions[0]!.question]}"`);
    expect(c.answeredAt).toBe(results[0]!.record.timestamp);
  }
});

test('complete current native identity and actual offered answer remain required', () => {
  for (const original of calls()) {
    for (const mutate of [
      (c: NativePlanQuestionCall) => { c.answered = false; },
      (c: NativePlanQuestionCall) => { c.failed = true; },
      (c: NativePlanQuestionCall) => { c.sessionId = ''; },
      (c: NativePlanQuestionCall) => { c.toolUseId = ''; },
      (c: NativePlanQuestionCall) => { c.answers = {}; },
      (c: NativePlanQuestionCall) => { c.answers = { 'prior question': c.questions[0]!.options[0]!.label }; },
      (c: NativePlanQuestionCall) => { c.answers![c.questions[0]!.question] = 'foreign answer'; },
      (c: NativePlanQuestionCall) => { c.unansweredQuestionIndices = [0]; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.multiSelect = true; },
      (c: NativePlanQuestionCall) => { c.questions.push(structuredClone(c.questions[0]!)); },
    ]) {
      const c = structuredClone(original); mutate(c);
      expect(ceoFirstReviewAUQ(fp(c))).toBe(false);
    }
    expect(ceoFirstReviewAUQ({ ...fp(original), signature: 'foreign:call' })).toBe(false);
    expect(ceoFirstReviewAUQ({ ...fp(original), nativeCall: undefined })).toBe(false);
    expect(ceoFirstReviewAUQ({ ...fp(original), options: [] })).toBe(false);
  }
});

test('title, recommendation, every option and any numbered header share one issue identity', () => {
  for (const original of calls()) {
    const n = /\(Issue (\d+)\)/.exec(original.questions[0]!.question)![1]!;
    for (const header of [`Finding ${n}`, `Issue ${n}`, `F${n}`]) {
      expect(ceoFirstReviewAUQ(fp(changed(original, c => { c.questions[0]!.header = header; })))).toBe(true);
    }
    for (const mutate of [
      (c: NativePlanQuestionCall) => { c.questions[0]!.question = c.questions[0]!.question.replace(/^Recommendation:.*\n/m, ''); },
      (c: NativePlanQuestionCall) => { c.questions[0]!.question = c.questions[0]!.question.replace(/^Recommendation: \d+A/m, 'Recommendation: 99A'); },
      (c: NativePlanQuestionCall) => { c.questions[0]!.question = c.questions[0]!.question.replace(/^Recommendation: \d+A/m, `Recommendation: ${n}Z`); },
      (c: NativePlanQuestionCall) => { c.questions[0]!.options[1]!.label = '99B) Different issue'; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.options[1]!.label = c.questions[0]!.options[0]!.label; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.options[0]!.description = ''; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.header = 'Finding 99'; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.header = 'Finding'; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.question = c.questions[0]!.question.replace(/D\d+ \(Issue \d+\) — /, ''); c.questions[0]!.header = `Issue ${n}`; },
    ]) expect(ceoFirstReviewAUQ(fp(changed(original, mutate)))).toBe(false);
  }
});

test('source, conditional and stale or withdrawn briefs do not start review', () => {
  for (const original of calls()) {
    for (const prefix of ['Example: ', 'If requested: ', '> ', '    ', '```text\n']) {
      expect(ceoFirstReviewAUQ(fp(changed(original, c => { c.questions[0]!.question = prefix + c.questions[0]!.question; })))).toBe(false);
    }
    for (const framing of ['If this hypothetical plan were adopted, ', 'Example: ', 'Historical example only. ', 'Quoted assessment: ']) {
      expect(ceoFirstReviewAUQ(fp(changed(original, c => { c.questions[0]!.question = c.questions[0]!.question.replace('ELI10: ', `ELI10: ${framing}`); })))).toBe(false);
    }
    for (const tail of ['No current defect exists.', 'Correction: this issue is already resolved.', 'This question is only an example.', 'I withdraw this finding.']) {
      expect(ceoFirstReviewAUQ(fp(changed(original, c => { c.questions[0]!.question += '\n' + tail; })))).toBe(false);
    }
    for (const prefix of ['> ', '    ', '```\n']) {
      expect(ceoFirstReviewAUQ(fp(changed(original, c => { c.questions[0]!.question = c.questions[0]!.question.replace(/^ELI10:/m, prefix + 'ELI10:'); })))).toBe(false);
    }
    // Later attributed source text does not withdraw a present decision.
    expect(ceoFirstReviewAUQ(fp(changed(original, c => { c.questions[0]!.question += '\nAn old note said: "No current defect exists."'; })))).toBe(true);
  }
});

test('qid and setup exclusions apply before the new identity form', () => {
  for (const original of calls()) {
    for (const mutate of [
      (c: NativePlanQuestionCall) => { c.questions[0]!.question += ' <gstack-qid:plan-ceo-review-extra>'; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.question = c.questions[0]!.question.replace(/<gstack-qid:[^>]+>/, '<gstack-qid:plan-eng-review-validation>'); },
      (c: NativePlanQuestionCall) => { c.questions[0]!.question = c.questions[0]!.question.replace(/<gstack-qid:[^>]+>/, '<gstack-qid:plan-ceo-review-approach>'); },
      (c: NativePlanQuestionCall) => { c.questions[0]!.question = c.questions[0]!.question.replace(/<gstack-qid:[^>]+>/, '<gstack-qid:plan-ceo-review-mode>'); },
      (c: NativePlanQuestionCall) => { c.questions[0]!.header = 'Approach'; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.options[0]!.label = 'HOLD SCOPE'; },
    ]) expect(ceoFirstReviewAUQ(fp(changed(original, mutate)))).toBe(false);
  }
});

test('identity recognition is independent of observed component and numbering', () => {
  for (const original of calls()) {
    const c = changed(original, c => {
      const q = c.questions[0]!; const n = /\(Issue (\d+)\)/.exec(q.question)![1]!;
      q.header = 'Notification state';
      q.question = q.question.replace(/^D\d+/, 'D24').replace(`(Issue ${n})`, '(Issue 17)')
        .replace(new RegExp(`\\b${n}([ABC])\\b`, 'g'), '17$1')
        .replace(/Stripe/g, 'PaymentProvider').replace(/email/g, 'notification').replace(/userId/g, 'accountKey');
      q.options.forEach(o => { o.label = o.label.replace(new RegExp(`^${n}`), '17'); });
    });
    expect(ceoFirstReviewAUQ(fp(c))).toBe(true);
    c.answers = { [c.questions[0]!.question]: c.questions[0]!.options.at(-1)!.label };
    expect(ceoFirstReviewAUQ(fp(c))).toBe(true);
  }
});

test('new fixture and controls select only their existing CEO count owner', () => {
  for (const file of ['test/ceo-parenthesized-issue-ah.test.ts', 'test/fixtures/ceo-parenthesized-issue-ah.json']) {
    expect(selectTests([file], E2E_TOUCHFILES).selected).toEqual(['plan-ceo-finding-count']);
  }
});

test('numbered administrative, literal-only, hypothetical and withdrawn briefs are not defects', () => {
  for (const original of calls()) {
    for (const mutate of [
      (q: NativePlanQuestionCall['questions'][number]) => {
        const n = /\(Issue (\d+)\)/.exec(q.question)![1]!;
        q.question = q.question.replace(/^(D\d+ \(Issue \d+\) — ).*/, '$1How should we archive this completed review?')
          .replace(/^ELI10:.*$/m, 'ELI10: The review is complete. This choice only saves the finished report.');
        q.options.forEach((o, i) => { o.label = `${n}${String.fromCharCode(65 + i)}) Save report format ${i}`; o.description = 'Store the completed review report.'; });
      },
      (q: NativePlanQuestionCall['questions'][number]) => { q.question += '\nThere is no defect or unresolved issue; this is a historical example.'; },
      (q: NativePlanQuestionCall['questions'][number]) => { q.question = q.question.replace(/^ELI10:.*$/m, 'ELI10: `The plan has no error handling.`'); },
      (q: NativePlanQuestionCall['questions'][number]) => { q.question = q.question.replace(/^(D\d+ \(Issue \d+\) — ).*/, '$1What should happen if a hypothetical future handler lacked error handling?'); },
    ]) {
      const c = changed(original, c => mutate(c.questions[0]!));
      expect(ceoFirstReviewAUQ(fp(c))).toBe(false);
    }
  }
});
