import { describe, expect, test } from 'bun:test';
import captured from './fixtures/eng-count-ad-v2.json';
import type { NativePlanQuestionCall, PlanCountTranscript } from './helpers/plan-count-transcript';
import { ENG_DECISION_SEEDS, evaluateEngSeedCoverage } from './helpers/eng-seeded-coverage';
import { E2E_TOUCHFILES, matchGlob } from './helpers/touchfiles';

// Exact public decisions reused from the existing fixture. The report below is
// a synthetic assembly of its retained task catalog, not a claim that the old run passed.
const calls = captured.cases.first.calls as NativePlanQuestionCall[];
const indices = [2, 4, 6, 8];
const start = Date.parse('2026-09-09T19:00:00Z'), end = Date.parse('2026-09-09T19:30:00Z');
const report = '# Reviewed plan\n\n' + captured.reviewedTasks.lines.join('\n') + '\n\n## GSTACK REVIEW REPORT\nEng review complete.\n';
const transcript = (): PlanCountTranscript => ({ status: 'ready', calls: structuredClone(calls), assistantMessages: [] });
const evaluate = (t = transcript(), p = report) => evaluateEngSeedCoverage(t, p, start, end);
function question(call: NativePlanQuestionCall, text: string) {
  const answer = call.answers![call.questions[0]!.question]!;
  call.questions[0]!.question = text; call.answers = { [text]: answer };
}

describe('Eng seeded coverage from completed native decisions', () => {
  test('four separate decisions plus the auto-added regression cover all five seeds regardless of total count', () => {
    const result = evaluate();
    expect(result.ok).toBe(true);
    expect(Object.keys(result.decisions)).toEqual([...ENG_DECISION_SEEDS]);
    expect(new Set(Object.values(result.decisions)).size).toBe(4);
    expect(result.regression).toBe('plan');
    // Historical evidence remains a failure, never a retroactive live pass.
    expect(captured.cases.first.actual.outcome).toBe('ceiling_reached');
    expect(captured.cases.first.actual.reviewCount).toBeGreaterThan(7);
    const t = transcript();
    for (let i = 0; i < 12; i++) {
      const extra = structuredClone(calls[7]!); extra.toolUseId += `-extra-${i}`; t.calls.push(extra);
    }
    expect(evaluate(t).ok).toBe(true);
  });

  test('every offered choice is coverage, including rejecting or deferring the recommended change', () => {
    for (const index of indices) for (const option of calls[index]!.questions[0]!.options) {
      const t = transcript(), call = t.calls[index]!;
      call.questions[0]!.options.reverse();
      call.answers = { [call.questions[0]!.question]: option.label };
      expect(evaluate(t).ok).toBe(true);
    }
    const t = transcript(), c = t.calls[4]!;
    c.questions[0]!.options.push({ label: 'Defer the cache change', description: 'Accept the stated risk for this release.' });
    c.answers = { [c.questions[0]!.question]: 'Defer the cache change' };
    expect(evaluate(t).ok).toBe(true);
  });

  test('presentation numbers and headings do not establish or remove seed identity', () => {
    const t = transcript();
    for (const index of indices) {
      const c = t.calls[index]!; c.questions[0]!.header = 'Decision';
      question(c, c.questions[0]!.question.replace(/^D\d+ — Issue \d+(?: \([^)]+\))?[: ]*/, 'Decision: '));
    }
    expect(evaluate(t).ok).toBe(true);
  });

  test('a direct seeded action question can use terse Yes/No choices', () => {
    const titles = [
      'Should we reduce the four new classes spread across twelve files?',
      'Should we inject the shared global AuthCache?',
      'Should we split validateAndDispatch to remove its nested swallowing catches?',
      'Should we parallelize the five sequential IDP calls?',
    ];
    for (const answer of ['Yes', 'No']) {
      const t = transcript();
      indices.forEach((index, n) => {
        const c = t.calls[index]!; question(c, titles[n]!);
        c.questions[0]!.options = [{ label: 'Yes' }, { label: 'No' }];
        c.answers = { [c.questions[0]!.question]: answer };
      });
      expect(evaluate(t).ok).toBe(true);
      indices.forEach((index, n) => {
        const administrative = structuredClone(t);
        const c = administrative.calls[index]!;
        question(c, titles[n]!.replace('Should we ', 'Should we document how to '));
        expect(evaluate(administrative).missing).toContain(ENG_DECISION_SEEDS[n]!);
      });
    }
  });

  test('omitting each seed remains missing even when unrelated completed decisions are plentiful', () => {
    for (let n = 0; n < indices.length; n++) {
      const t = transcript(); t.calls.splice(indices[n]!, 1);
      expect(evaluate(t).missing).toContain(ENG_DECISION_SEEDS[n]!);
      expect(evaluate(t).ok).toBe(false);
    }
  });

  test('batched questions or one combined approval cannot supply four distinct decisions', () => {
    const t = transcript(), combined = structuredClone(calls[2]!);
    combined.questions = indices.map(i => structuredClone(calls[i]!.questions[0]!));
    combined.answers = Object.fromEntries(indices.map(i => Object.entries(calls[i]!.answers!)[0]!));
    t.calls = [combined]; expect(evaluate(t).missing).toHaveLength(4);
    combined.questions = [structuredClone(calls[2]!.questions[0]!)];
    question(combined, indices.map(i => calls[i]!.questions[0]!.question.split('\n')[0]).join(' '));
    combined.questions[0]!.options = [
      { label: 'Reduce classes, inject cache, split errors and parallelize IDP', description: 'Approve all four changes.' },
      { label: 'Keep all four unchanged', description: 'Reject every change.' },
    ];
    combined.answers = { [combined.questions[0]!.question]: combined.questions[0]!.options[0]!.label };
    expect(evaluate(t).missing).toHaveLength(4);
  });

  test('pending, failed, stale, foreign, malformed or unoffered replies provide no decision credit', () => {
    for (const mutate of [
      (c: NativePlanQuestionCall) => { c.answered = false; },
      (c: NativePlanQuestionCall) => { c.failed = true; },
      (c: NativePlanQuestionCall) => { delete c.failed; },
      (c: NativePlanQuestionCall) => { c.answers = {}; },
      (c: NativePlanQuestionCall) => { c.answers = { [c.questions[0]!.question]: 'not offered' }; },
      (c: NativePlanQuestionCall) => { c.answers!.foreign = 'Yes'; },
      (c: NativePlanQuestionCall) => { c.answeredAt = 'invalid'; },
      (c: NativePlanQuestionCall) => { c.answeredAt = new Date(start - 1).toISOString(); },
      (c: NativePlanQuestionCall) => { c.answeredAt = new Date(end + 1).toISOString(); },
      (c: NativePlanQuestionCall) => { c.sessionId = 'foreign'; },
      (c: NativePlanQuestionCall) => { c.toolUseId = ''; },
      (c: NativePlanQuestionCall) => { c.unansweredQuestionIndices = [0]; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.multiSelect = true; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.options[1]!.label = c.questions[0]!.options[0]!.label; },
    ]) {
      const t = transcript(); mutate(t.calls[4]!); expect(evaluate(t).ok).toBe(false);
    }
    const duplicate = transcript(); duplicate.calls.push(structuredClone(duplicate.calls[4]!));
    expect(evaluate(duplicate).ok).toBe(false);
    const missing = transcript(); missing.status = 'missing'; expect(evaluate(missing).ok).toBe(false);
  });

  test('quoted examples, resolved defects and option-only references cannot impersonate a seeded issue', () => {
    for (const prefix of ['> ', 'Example: ', '```text\n', 'Hypothetical: ', 'No defect remains: ']) {
      const t = transcript(); question(t.calls[4]!, prefix + t.calls[4]!.questions[0]!.question);
      expect(evaluate(t).missing).toContain('shared-cache');
    }
    const t = transcript(); question(t.calls[4]!, 'Which format should the final report use?');
    expect(evaluate(t).missing).toContain('shared-cache');
  });

  test('mandatory regression evidence requires an affirmative legacy task or scoped public narration', () => {
    const base = '## GSTACK REVIEW REPORT\nEng complete.\n';
    for (const text of [
      'legacyAuthFlow will be rewritten; no regression test for prior behavior is planned.',
      'Do not add legacyAuthFlow regression characterization fixtures.',
      'Defer adding legacyAuthFlow regression characterization fixtures.',
      'Maybe add legacyAuthFlow regression characterization fixtures.',
      '"Add legacyAuthFlow regression characterization fixtures before changes."',
      'Example: Add legacyAuthFlow regression characterization fixtures before changes.',
      'It is unclear whether to add legacyAuthFlow regression characterization fixtures before changes.',
      'We would add legacyAuthFlow regression characterization fixtures before changes.',
      'Add a report paragraph describing legacyAuthFlow regression characterization fixtures before changes.',
      'Record a note about legacyAuthFlow regression characterization fixtures before changes.',
      'Add regression characterization tests for newAuthFlow before changes; legacyAuthFlow is only mentioned in release notes.',
      'Record regression characterization fixtures for newAuthFlow before changes. The legacyAuthFlow documentation was updated.',
      'Add tests for legacyAuthFlow before changes; newAuthFlow gets regression characterization fixtures.',
      'legacyAuthFlow — Add regression characterization tests for newAuthFlow before changes.',
      '> Add legacyAuthFlow regression characterization fixtures before changes.',
      '```\nAdd legacyAuthFlow regression characterization fixtures before changes.\n```',
    ]) expect(evaluate(transcript(), text + '\n\n' + base).ok).toBe(false);
    expect(evaluate(transcript(), 'Add regression characterization tests for legacyAuthFlow before changes.\n\n' + base).regression).toBe('plan');
    const t = transcript(); t.assistantMessages.push({ sessionId: calls[0]!.sessionId, timestamp: new Date(end - 1).toISOString(),
      text: 'Added legacyAuthFlow regression characterization fixtures before the rewrite.' });
    expect(evaluate(t, base).regression).toBe('public-narration');
    t.assistantMessages[0]!.sessionId = 'foreign'; expect(evaluate(t, base).ok).toBe(false);
    t.assistantMessages[0]!.sessionId = calls[0]!.sessionId;
    t.assistantMessages[0]!.timestamp = new Date(start - 1).toISOString(); expect(evaluate(t, base).ok).toBe(false);
    expect(evaluate(transcript(), captured.reviewedTasks.lines.join('\n')).ok).toBe(false);
    expect(evaluate(transcript(), report.replace('Eng review complete.', '')).ok).toBe(false);
  });

  test('new local evidence dependencies select only this Eng paid case', () => {
    for (const file of ['test/helpers/eng-seeded-coverage.ts', 'test/eng-seeded-coverage.test.ts']) {
      expect(Object.entries(E2E_TOUCHFILES).filter(([, patterns]) => patterns.some(p => matchGlob(file, p))).map(([key]) => key))
        .toEqual(['plan-eng-finding-count']);
    }
  });
});
