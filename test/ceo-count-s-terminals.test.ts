import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ceoFirstReviewAUQ, ceoStep0Boundary, hasNativePlanTerminal, isQuestionlessNativePlanExit, nativePlanCallFingerprint, planCountQuestionPhase } from './helpers/claude-pty-runner';
import { isCeoCompletionHandoff, pickCeoCompletionHandoff } from './helpers/ceo-completion-handoff';
import type { NativePlanQuestionCall, PlanCountTranscript } from './helpers/plan-count-transcript';
import distinct from './fixtures/ceo-count-s-distinct.json';
import paired from './fixtures/ceo-count-s-paired.json';

const fp = (call: NativePlanQuestionCall) => nativePlanCallFingerprint(call, 0, false);
function replay(calls: NativePlanQuestionCall[]) {
  let started = false;
  const setup = new Set<string>(); const administrative = new Set<string>(); let review = 0;
  for (const call of calls) {
    const fingerprint = fp(call);
    const phase = planCountQuestionPhase(fingerprint, started, ceoStep0Boundary, ceoFirstReviewAUQ, undefined, isCeoCompletionHandoff);
    if (phase.administrative) administrative.add(fingerprint.signature);
    else if (phase.preReview) setup.add(fingerprint.signature);
    else review++;
    started = phase.reviewStarted;
  }
  return { setup, administrative, review };
}
function transcript(capture: typeof distinct | typeof paired): PlanCountTranscript {
  return { status: 'ready', calls: structuredClone(capture.calls) as NativePlanQuestionCall[],
    assistantMessages: [], planReadyRequests: structuredClone(capture.planReadyRequests) };
}
function withReport(capture: typeof distinct | typeof paired, run: (file: string, start: number) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-s-terminal-'));
  const file = path.join(dir, 'report.md');
  fs.writeFileSync(file, capture.report);
  fs.utimesSync(file, capture.reportMtimeMs / 1000, capture.reportMtimeMs / 1000);
  try { run(file, capture.reportMtimeMs - 1000); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

describe('captured S native CEO completion gates', () => {
  test('setup-only exit fails promptly without relaxing report freshness for positive coverage', () => {
    const t = transcript(distinct); const result = replay(t.calls);
    expect(result.setup.size).toBe(4); expect(result.review).toBe(0);
    withReport(distinct, (file, start) => {
      expect(isQuestionlessNativePlanExit(t, file, start, distinct.screen, result.setup)).toBe(true);
      expect(isQuestionlessNativePlanExit(t, file, start, distinct.screen)).toBe(false);
      expect(hasNativePlanTerminal(t, file, start, 'plan_ready')).toBe(false);
      for (const mutate of [
        (v: PlanCountTranscript) => { v.calls[0]!.answered = false; },
        (v: PlanCountTranscript) => { v.calls[0]!.failed = true; },
        (v: PlanCountTranscript) => { v.calls[0]!.sessionId = 'foreign'; },
        (v: PlanCountTranscript) => { v.calls[0]!.answeredAt = 'invalid'; },
        (v: PlanCountTranscript) => { v.calls[0]!.answeredAt = v.planReadyRequests![0]!.timestamp; },
        (v: PlanCountTranscript) => { v.calls[0]!.answers = {}; },
        (v: PlanCountTranscript) => { v.calls[0]!.unansweredQuestionIndices = [0]; },
      ]) {
        const changed = structuredClone(t); mutate(changed);
        expect(isQuestionlessNativePlanExit(changed, file, start, distinct.screen, result.setup)).toBe(false);
      }
      const incomplete = new Set(result.setup); incomplete.delete(fp(t.calls[0]!).signature);
      expect(isQuestionlessNativePlanExit(t, file, start, distinct.screen, incomplete)).toBe(false);
    });
  });

  test('paired review retains two issue approvals and excludes only the completed Eng menu', () => {
    const t = transcript(paired); const before = structuredClone(t); const result = replay(t.calls);
    expect(result.setup.size).toBe(2); expect(result.review).toBe(2); expect(result.administrative.size).toBe(1);
    const pending = structuredClone(t.calls.at(-1)!); pending.answered = false; delete pending.answers;
    expect(pickCeoCompletionHandoff(fp(pending))).toBe(2);
    pending.questions[0]!.options.reverse(); expect(pickCeoCompletionHandoff(fp(pending))).toBe(1);
    expect(t).toEqual(before);
    withReport(paired, (file, start) => {
      expect(hasNativePlanTerminal(t, file, start, 'plan_ready', result.administrative)).toBe(true);
      expect(hasNativePlanTerminal(t, file, start, 'plan_ready')).toBe(false);
      expect(isQuestionlessNativePlanExit(t, file, start, paired.screen, result.setup)).toBe(false);
    });
  });

  test('the same menu cannot hide a new obligation, ambiguous gate, or unverified answer', () => {
    const base = transcript(paired).calls.at(-1)!;
    for (const mutate of [
      (c: NativePlanQuestionCall) => { c.questions[0]!.question = c.questions[0]!.question.replace('It\'s', 'That might become'); },
      (c: NativePlanQuestionCall) => { c.questions[0]!.question += ' First repair authorization.'; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.question = 'Example: ' + c.questions[0]!.question; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.question = c.questions[0]!.question.replace('CLEAN', 'CLEAN once tests pass'); },
      (c: NativePlanQuestionCall) => { c.questions[0]!.options[1]!.description += ' Remove the owner check.'; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.options[1]!.description += ' Change the guarantee to permit old results.'; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.options[1]!.description += ' Tests remain unresolved.'; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.options[1]!.label = 'Fix the missing assertion'; },
      (c: NativePlanQuestionCall) => { c.failed = true; },
      (c: NativePlanQuestionCall) => { c.answered = false; },
    ]) {
      const call = structuredClone(base); mutate(call);
      call.answers = { [call.questions[0]!.question]: call.questions[0]!.options[0]!.label };
      expect(isCeoCompletionHandoff(fp(call))).toBe(false);
    }
    const call = structuredClone(base); call.answers = { [call.questions[0]!.question]: 'First repair the missing test' };
    expect(isCeoCompletionHandoff(fp(call))).toBe(false);
    const pending = structuredClone(base); pending.answered = false;
    expect(pickCeoCompletionHandoff({ ...fp(pending), signature: 'foreign' })).toBeNull();
  });
});
