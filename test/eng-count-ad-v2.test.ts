import { describe, expect, test } from 'bun:test';
import captured from './fixtures/eng-count-ad-v2.json';
import { engFirstReviewAUQ, engSetupAUQ, engStep0Boundary, nativePlanCallFingerprint, planCountQuestionPhase } from './helpers/claude-pty-runner';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
import { isEngCompletionHandoff } from './helpers/eng-completion-handoff';
import { E2E_TOUCHFILES, matchGlob } from './helpers/touchfiles';

const firstCalls = captured.cases.first.calls as NativePlanQuestionCall[];
const retryCalls = captured.cases.retry.calls as NativePlanQuestionCall[];
const catalog = captured.reviewedTasks.lines.join('\n');
const issue = () => structuredClone(retryCalls[3]!);
const handoff = () => structuredClone(firstCalls.at(-1)!);
const fp = (call: NativePlanQuestionCall) => nativePlanCallFingerprint(call, 0, true);
const isFirst = (call: NativePlanQuestionCall) => engFirstReviewAUQ(fp(call));
const isHandoff = (call: NativePlanQuestionCall, plan = catalog) => isEngCompletionHandoff(fp(call), plan);
function changeQuestion(call: NativePlanQuestionCall, change: (s: string) => string) {
  const q = call.questions[0]!, answer = call.answers?.[q.question];
  q.question = change(q.question); call.answers = answer ? { [q.question]: answer } : {}; return call;
}
function census(calls: NativePlanQuestionCall[]) {
  let reviewStarted = false;
  const counts = { setup: 0, review: 0, administrative: 0 };
  const phases = calls.map(call => {
    const phase = planCountQuestionPhase(fp(call), reviewStarted, engStep0Boundary, engFirstReviewAUQ, engSetupAUQ,
      current => isEngCompletionHandoff(current, catalog));
    reviewStarted = phase.reviewStarted;
    counts[phase.administrative ? 'administrative' : phase.preReview ? 'setup' : 'review']++;
    return phase;
  });
  return { counts, phases };
}

describe('Eng AD v2 completed native count evidence', () => {
  test('first attempt retains seven substantive decisions and separates the completed D9 handoff', () => {
    const { counts, phases } = census(firstCalls);
    expect(counts).toEqual({ setup: 4, review: 7, administrative: 1 });
    expect(phases.slice(4, 11).every(p => !p.preReview && !p.administrative)).toBe(true);
    expect(firstCalls[9]!.questions[0]!.question).toContain('TODO 1');
    expect(firstCalls[10]!.questions[0]!.question).toContain('TODO 2');
    expect(phases[11]!.administrative).toBe('completion-handoff');
    expect(captured.cases.first.actual.outcome).toBe('ceiling_reached');
    expect(captured.cases.first.actual.reviewCount).toBe(8);
  });

  test('retry ordinary Issue identity starts review without qids, retaining its later TODO', () => {
    const { counts, phases } = census(retryCalls);
    expect(counts).toEqual({ setup: 3, review: 6, administrative: 0 });
    expect(phases.slice(3).every(p => !p.preReview && !p.administrative)).toBe(true);
    for (const call of retryCalls.slice(3, 8)) expect(isFirst(call)).toBe(true);
    expect(retryCalls[8]!.questions[0]!.question).toContain('TODO 1');
    expect(captured.cases.retry.actual.reviewCount).toBe(0);
  });

  test('the prior successful plan Write already contains the exact referenced task and regression step', () => {
    expect(captured.reviewedTasks.isError).toBe(false);
    expect(Date.parse(captured.reviewedTasks.replyAt)).toBeLessThan(Date.parse(handoff().answeredAt!));
    expect(captured.reviewedTasks.lines).toHaveLength(10);
    expect(captured.reviewedTasks.lines[2]).toContain('Record regression characterization fixtures before any change');
    expect(isHandoff(handoff())).toBe(true);
    // The menu's Tasks JSONL claim is not independently verified by this fixture.
    expect(captured.provenance.privateThinkingInspected).toBe(false);
  });

  test('ordinary issue presentation can vary while completed identity and section number remain bound', () => {
    for (const title of ['Issue 1', 'Finding 1.2 (D17)', 'D42 — Issue 1']) {
      const call = changeQuestion(issue(), s => s.replace('Issue 1 (D4)', title).replace('AuthCache', 'SessionCache'));
      call.questions[0]!.header = title.includes('1.2') ? 'Architecture 1.2' : 'Architecture 1';
      call.questions[0]!.options.reverse();
      for (const option of call.questions[0]!.options) {
        call.answers = { [call.questions[0]!.question]: option.label };
        expect(isFirst(call)).toBe(true);
      }
    }
  });

  test('setup, quoted or mismatched section identities do not start review', () => {
    for (const header of ['Scope', 'Approach', 'Next steps', 'Arch 2', 'Example Arch 1', 'TODO 1']) {
      const call = issue(); call.questions[0]!.header = header; expect(isFirst(call)).toBe(false);
    }
    for (const change of [
      (s: string) => '> ' + s,
      (s: string) => 'Example: ' + s,
      (s: string) => '```text\n' + s + '\n```',
      (s: string) => s.replace('Issue 1 (D4)', 'Issue 2 (D4)'),
      (s: string) => s + ' <gstack-qid:plan-eng-setup>',
    ]) expect(isFirst(changeQuestion(issue(), change))).toBe(false);
    for (const call of [...firstCalls.slice(0, 4), ...retryCalls.slice(0, 3)]) expect(isFirst(call)).toBe(false);
  });

  test('an Issue heading alone cannot turn a confirmation or report action into a finding', () => {
    for (const body of [
      'No defect remains in the cache. Proceed with the next section?',
      'The cache already serializes writes. Confirm this is accurate?',
      'Should I save the reviewed plan now?',
      'Add a section to the reviewed plan?',
      'Serialize the reviewed plan as JSON for the handoff?',
      'Add the completed tests to this report?',
    ]) {
      const c = changeQuestion(issue(), () => 'Issue 1 (D4) — ' + body);
      c.questions[0]!.options = [
        { label: 'Yes', description: 'Confirm this statement; no new implementation work.' },
        { label: 'No', description: 'Do not confirm; no new implementation work.' },
      ];
      c.answers = { [c.questions[0]!.question]: 'Yes' };
      expect(isFirst(c)).toBe(false);
    }
    const c = issue();
    c.questions[0]!.options = [{ label: 'Yes', description: 'Confirm; no new work.' }, { label: 'No', description: 'Decline; no new work.' }];
    c.answers = { [c.questions[0]!.question]: 'Yes' };
    expect(isFirst(c)).toBe(false);
  });

  test('new first-finding and handoff paths require exact completed native identity and answer', () => {
    for (const factory of [issue, handoff]) {
      const classify = factory === issue ? isFirst : isHandoff;
      for (const mutate of [
        (c: NativePlanQuestionCall) => { c.answered = false; },
        (c: NativePlanQuestionCall) => { c.failed = true; },
        (c: NativePlanQuestionCall) => { delete c.failed; },
        (c: NativePlanQuestionCall) => { c.sessionId = ''; },
        (c: NativePlanQuestionCall) => { c.toolUseId = ''; },
        (c: NativePlanQuestionCall) => { delete c.answeredAt; },
        (c: NativePlanQuestionCall) => { c.answeredAt = 'invalid'; },
        (c: NativePlanQuestionCall) => { c.unansweredQuestionIndices = [0]; },
        (c: NativePlanQuestionCall) => { delete c.unansweredQuestionIndices; },
        (c: NativePlanQuestionCall) => { c.questions[0]!.multiSelect = true; },
        (c: NativePlanQuestionCall) => { c.questions.push(structuredClone(c.questions[0]!)); },
        (c: NativePlanQuestionCall) => { c.questions[0]!.options[1]!.label = c.questions[0]!.options[0]!.label; },
        (c: NativePlanQuestionCall) => { c.answers = {}; },
        (c: NativePlanQuestionCall) => { c.answers = { [c.questions[0]!.question]: 'Unoffered' }; },
        (c: NativePlanQuestionCall) => { c.answers!.foreign = 'Foreign'; },
      ]) { const c = factory(); mutate(c); expect(classify(c)).toBe(false); }
      const classifyFp = factory === issue ? engFirstReviewAUQ : (f: ReturnType<typeof fp>) => isEngCompletionHandoff(f, catalog);
      expect(classifyFp({ ...fp(factory()), signature: 'foreign:call' })).toBe(false);
      expect(classifyFp({ ...fp(factory()), nativeCall: undefined })).toBe(false);
      expect(classifyFp({ ...fp(factory()), nativeQuestionIndex: 1 })).toBe(false);
      expect(classifyFp({ ...fp(factory()), options: [] })).toBe(false);
      const wrong = fp(factory()); wrong.options[0]!.index = 2; expect(classifyFp(wrong)).toBe(false);
    }
  });

  test('closed handoff accepts either offered action and order, but cannot start or satisfy a review', () => {
    const call = handoff(); call.questions[0]!.options.reverse();
    for (const option of call.questions[0]!.options) {
      call.answers = { [call.questions[0]!.question]: option.label };
      expect(isHandoff(call)).toBe(true);
    }
    expect(census([call]).counts).toEqual({ setup: 0, review: 0, administrative: 1 });
    expect(census([call]).phases[0]!.reviewStarted).toBe(false);
  });

  test('new task references or a missing, contradicted, or incomplete reviewed catalog remain substantive', () => {
    for (const plan of ['', catalog.replace('**T10 ', '**T11 '), catalog + '\n' + captured.reviewedTasks.lines[2],
      catalog.replace('Record regression', 'Do not record regression'), catalog.replace('Record regression', 'Discuss regression')]) {
      expect(isHandoff(handoff(), plan)).toBe(false);
    }
    for (const change of [
      (s: string) => s.replace('T1–T10', 'T1–T11'),
      (s: string) => s.replace('T1–T10', 'T2–T10'),
      (s: string) => s.replace('record T3', 'record T4'),
      (s: string) => s + ' Also add a new migration before shipping.',
      (s: string) => s.replace('implement T1–T10', 'approve and implement T1–T10'),
    ]) { const c = handoff(); c.questions[0]!.options[0]!.description = change(c.questions[0]!.options[0]!.description); expect(isHandoff(c)).toBe(false); }
  });

  test('conditional closure, extra decisions, appended new work and quoted navigation are never discounted', () => {
    for (const change of [
      (s: string) => s.replace('Eng Review is CLEAR', 'Eng Review will be CLEAR after fixing the race'),
      (s: string) => s.replace('Eng Review is CLEAR', 'Eng Review is not CLEAR'),
      (s: string) => s.replace('What next?', 'What next? Also approve deleting the migration?'),
      (s: string) => s + '\nCreate another cache before the next review.',
      (s: string) => '> ' + s,
      (s: string) => '```text\n' + s + '\n```',
    ]) expect(isHandoff(changeQuestion(handoff(), change))).toBe(false);
    const c = handoff(); c.questions[0]!.options[1]!.description += ' Remove the CI gate first.'; expect(isHandoff(c)).toBe(false);
    const label = handoff(); label.questions[0]!.options[0]!.label += ' and rewrite auth';
    label.answers = { [label.questions[0]!.question]: label.questions[0]!.options[0]!.label }; expect(isHandoff(label)).toBe(false);
    const header = handoff(); header.questions[0]!.header = 'Issue 9'; expect(isHandoff(header)).toBe(false);
  });

  test('new evidence selects precisely its affected existing paid workflows', () => {
    const selected = (path: string) => Object.entries(E2E_TOUCHFILES).filter(([, patterns]) => patterns.some(p => matchGlob(path, p))).map(([name]) => name).sort();
    for (const path of ['test/eng-count-ad-v2.test.ts', 'test/fixtures/eng-count-ad-v2.json']) {
      expect(selected(path)).toEqual(['plan-eng-finding-count', 'plan-eng-multi-finding-batching']);
    }
    expect(selected('test/helpers/eng-completion-handoff.ts')).toEqual(['plan-eng-finding-count']);
  });
});
