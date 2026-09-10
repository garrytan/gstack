import { describe, expect, test } from 'bun:test';
import { ceoFirstReviewAUQ, ceoStep0Boundary, nativePlanCallFingerprint, planCountQuestionPhase } from './helpers/claude-pty-runner';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
import fixture from './fixtures/ceo-transaction-contract-ar.json';

const calls = () => structuredClone(fixture.calls) as NativePlanQuestionCall[];
const first = () => calls()[2]!;
const fp = (call = first()) => nativePlanCallFingerprint(call, 0, true);
const classify = (call = first()) => ceoFirstReviewAUQ(fp(call));
const mutate = (fn: (call: NativePlanQuestionCall) => void) => { const call = first(); fn(call); return call; };
const prose = (fn: (text: string) => string) => mutate(call => {
  const q = call.questions[0]!, answer = call.answers![q.question]!;
  q.question = fn(q.question); call.answers = { [q.question]: answer };
});
const option = (at: number, fn: (o: NativePlanQuestionCall['questions'][number]['options'][number]) => void) => mutate(call => {
  const q = call.questions[0]!, selected = q.options.findIndex(o => o.label === call.answers![q.question]);
  fn(q.options[at]!); call.answers = { [q.question]: q.options[selected]!.label };
});

describe('AR current transaction decision', () => {
  test('the exact transaction decision starts review after setup', () => {
    let started = false;
    const phases = calls().map(call => {
      const phase = planCountQuestionPhase(fp(call), started, ceoStep0Boundary, ceoFirstReviewAUQ);
      started = phase.reviewStarted; return phase.preReview;
    });
    expect(phases).toEqual([true, true, false, false, false, false, false, false]);
    expect(calls().map(classify)).toEqual([false, false, true, false, false, false, false, false]);
  });
  test('title wording and ordinal punctuation do not supply semantics', () => {
    expect(classify(prose(s => s.replace('Where does the user update commit relative to the email call?', 'When should the update commit before the email call?')))).toBe(true);
    expect(classify(mutate(c => { c.questions[0]!.header = 'Transaction boundary'; }))).toBe(true);
    expect(classify(mutate(c => {
      const q = c.questions[0]!, answer = c.answers![q.question]!;
      q.options.forEach(o => { o.label = o.label.replace(/^3([A-Z]) /, '3$1) '); });
      c.answers = { [q.question]: answer.replace(/^3([A-Z]) /, '3$1) ') };
    }))).toBe(true);
    expect(classify(prose(s => s + '\nArchived note: "This finding is withdrawn."'))).toBe(true);
    expect(classify(mutate(c => { const q = c.questions[0]!; c.answers = { [q.question]: q.options[1]!.label }; }))).toBe(true);
  });
  test('a complete owned successful answer is required', () => {
    for (const change of [
      (c: NativePlanQuestionCall) => { c.sessionId = ''; }, (c: NativePlanQuestionCall) => { c.toolUseId = ''; },
      (c: NativePlanQuestionCall) => { c.answered = false; }, (c: NativePlanQuestionCall) => { c.failed = true; },
      (c: NativePlanQuestionCall) => { delete c.failed; }, (c: NativePlanQuestionCall) => { delete c.answeredAt; },
      (c: NativePlanQuestionCall) => { c.answeredAt = 'invalid'; }, (c: NativePlanQuestionCall) => { c.unansweredQuestionIndices = [0]; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.multiSelect = true; }, (c: NativePlanQuestionCall) => { c.answers = {}; },
      (c: NativePlanQuestionCall) => { c.questions.push(structuredClone(c.questions[0]!)); },
    ]) expect(classify(mutate(change))).toBe(false);
    for (const fingerprint of [{ ...fp(), signature: 'foreign' }, { ...fp(), nativeQuestionIndex: 1 }, { ...fp(), options: fp().options.toReversed() }])
      expect(ceoFirstReviewAUQ(fingerprint)).toBe(false);
  });
  test('decision, header, recommendation and offered ordinals agree', () => {
    for (const change of [(s: string) => s.replace('D3 —', 'D0 —'), (s: string) => s.replace('D3 —', 'D03 —'), (s: string) => s.replace('Recommendation: 3A', 'Recommendation: 4A')])
      expect(classify(prose(change))).toBe(false);
    for (const header of ['Routing', 'Approach', 'D4 Txn boundary', 'D03 Txn boundary', 'Source Txn boundary'])
      expect(classify(mutate(c => { c.questions[0]!.header = header; }))).toBe(false);
    for (const label of ['03A Commit update, then email', '4A Commit update, then email', '3A) 4A Commit update, then email'])
      expect(classify(option(0, o => { o.label = label; }))).toBe(false);
  });
  test('a unique current context and assessment are required', () => {
    for (const field of ['Project/branch/task: ', 'ELI10: ']) for (const prefix of ['Source excerpt: ', 'Earlier review assessment: ', 'If approved, ', 'Assuming approval, '])
      expect(classify(prose(s => s.replace(field, field + prefix)))).toBe(false);
    for (const prefix of ['Source excerpt:\n', 'Project/branch/task: duplicate\n', 'ELI10: duplicate\n'])
      expect(classify(prose(s => s.replace('ELI10:', prefix + 'ELI10:')))).toBe(false);
    expect(classify(prose(s => s.replace(/^Project\/branch\/task:.*\n/m, '')))).toBe(false);
    expect(classify(prose(s => '```\n' + s + '\n```'))).toBe(false);
  });
  test('the missing boundary must remain current and unresolved', () => {
    expect(classify(prose(s => s.replace('but never says whether', 'and explicitly specifies whether')))).toBe(false);
    expect(classify(prose(s => s.replace('The plan says', 'Earlier review assessment follows. The plan says')))).toBe(false);
    for (const tail of ['This finding is withdrawn.', 'This transaction boundary is now specified.', 'Correction: this transaction boundary is "resolved".'])
      expect(classify(prose(s => s + '\n' + tail))).toBe(false);
  });
  test('one current amendment owns order and rollback safety', () => {
    for (const replacement of ['before commit, inside any DB transaction', 'after commit, inside the DB transaction'])
      expect(classify(option(0, o => { o.description = o.description!.replace('after commit, outside any DB transaction', replacement); }))).toBe(false);
    expect(classify(option(0, o => { o.description = o.description!.replace('can never roll back paid status', 'can roll back paid status'); }))).toBe(false);
    expect(classify(option(0, o => { o.description = o.description!.replace('Lookup and update commit in one transaction;', 'No transactional update is planned;'); }))).toBe(false);
    expect(classify(option(0, o => { o.label = '3A Write the final report'; }))).toBe(false);
    for (const prefix of ['Source excerpt: ', 'If approved, '])
      expect(classify(option(0, o => { o.description = prefix + o.description; }))).toBe(false);
    for (const tail of ['This amendment is "withdrawn".', 'Correction: do not commit the update before email.'])
      expect(classify(option(0, o => { o.description += ' ' + tail; }))).toBe(false);
  });
  test('new transaction syntax rejects stale and conditional evidence', () => {
    for (const prefix of ['Assuming approval, ', 'Provided approval, ']) {
      expect(classify(prose(s => s.replace('ELI10: ', 'ELI10: ' + prefix)))).toBe(false);
      expect(classify(option(0, o => { o.description = prefix + o.description; }))).toBe(false);
      expect(classify(option(1, o => { o.description = prefix + o.description; }))).toBe(false);
    }
    for (const status of ['superseded', '"superseded"', '"resolved"', 'no longer current', '"no longer current"']) {
      expect(classify(prose(s => s + '\nThis finding is ' + status + '.'))).toBe(false);
      expect(classify(option(0, o => { o.description += ' This amendment is ' + status + '.'; }))).toBe(false);
      expect(classify(option(1, o => { o.description += ' This option is ' + status + '.'; }))).toBe(false);
    }
    for (const history of ['> This finding is superseded.', 'Archived note: "This finding is superseded."', 'Archived note: "This finding is no longer current."', '~~~\nThis finding is superseded.\n~~~'])
      expect(classify(prose(s => s + '\n' + history))).toBe(true);
    for (const convert of [(s: string) => '> ' + s, (s: string) => '"' + s + '"', (s: string) => '`' + s + '`']) {
      expect(classify(option(0, o => { o.description = convert(o.description!); }))).toBe(false);
      expect(classify(option(1, o => { o.description = convert(o.description!); }))).toBe(false);
    }
  });
  test('the opposed option owns the unchanged risk', () => {
    expect(classify(option(1, o => { o.description = 'The transaction shape is safe and fully specified.'; }))).toBe(false);
    expect(classify(option(1, o => { o.description = 'Source excerpt: ' + o.description; }))).toBe(false);
    expect(classify(option(1, o => { o.description += ' This option is withdrawn.'; }))).toBe(false);
  });
});
