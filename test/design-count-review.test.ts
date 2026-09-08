import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { capturePlanCountQuestion, designFirstReviewAUQ, designStep0Boundary, hasNativePlanTerminal, nativePlanCallFingerprint, planCountQuestionPhase } from './helpers/claude-pty-runner';
import { isDesignCountFirstReview, isDesignCompletionHandoff, pickDesignCountQuestion } from './helpers/design-count-review';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
import captured from './fixtures/design-review-j-calls.json';

const calls = () => structuredClone(captured.calls) as NativePlanQuestionCall[];
const fingerprint = (call: NativePlanQuestionCall) => nativePlanCallFingerprint(call, 0, true);
const handoff = () => calls().at(-1)!;
function pending(call = handoff()) {
  call.answered = false;
  delete call.answers;
  delete call.unansweredQuestionIndices;
  return call;
}
function replay(input: NativePlanQuestionCall[], first = isDesignCountFirstReview) {
  let started = false;
  const counts = { step0: 0, review: 0, administrative: 0 };
  const phases = [];
  for (const call of input) {
    const phase = planCountQuestionPhase(fingerprint(call), started, designStep0Boundary,
      first, undefined, isDesignCompletionHandoff);
    if (phase.administrative) counts.administrative++;
    else if (phase.preReview) counts.step0++;
    else counts.review++;
    started = phase.reviewStarted;
    phases.push(phase);
  }
  return { ...counts, started, phases };
}

describe('Design count native review phases and completion handoff', () => {
  test('captured J calls retain three actual findings, including the TODO; this still fails the four-finding floor', () => {
    const input = calls(); const original = structuredClone(input);
    expect(replay(input, designFirstReviewAUQ).review).toBe(0);
    const result = replay(input);
    expect(result).toMatchObject({ step0: 1, review: 3, administrative: 1 });
    expect(result.review).toBeLessThan(4);
    expect(result.phases.slice(1, 4).every(p => !p.preReview && !p.administrative)).toBe(true);
    expect(input).toEqual(original);
  });
  test('completion-only cannot establish or satisfy review coverage', () => {
    expect(replay([handoff()])).toMatchObject({ step0: 0, review: 0, administrative: 1, started: false });
  });
  test('an actual pass finding starts review without a numbered heading or prescribed question ID', () => {
    for (const call of calls().slice(1, 4)) expect(isDesignCountFirstReview(fingerprint(call))).toBe(true);
    expect(isDesignCountFirstReview(fingerprint(calls()[0]!))).toBe(false);
    expect(isDesignCountFirstReview(fingerprint(handoff()))).toBe(false);
  });
  test('pending, failed or skipped finding tabs cannot establish a review boundary', () => {
    const finding = calls()[1]!;
    for (const mutate of [
      (c: NativePlanQuestionCall) => { c.answered = false; },
      (c: NativePlanQuestionCall) => { c.failed = true; },
      (c: NativePlanQuestionCall) => { c.answers = {}; },
    ]) {
      const call = structuredClone(finding); mutate(call);
      expect(isDesignCountFirstReview(fingerprint(call))).toBe(false);
    }
    const partial = calls()[0]!;
    partial.questions.push(finding.questions[0]!); partial.unansweredQuestionIndices = [1];
    expect(isDesignCountFirstReview(fingerprint(partial))).toBe(false);
    partial.answers = { ...partial.answers, ...finding.answers }; partial.unansweredQuestionIndices = [];
    expect(isDesignCountFirstReview(fingerprint(partial))).toBe(true);
    expect(replay([partial]).review).toBe(1); // One native call, not one count per tab.
  });
  test('setup and generic pass mentions are not positive finding evidence', () => {
    for (const question of [
      'Review all seven passes. Which design dimension should get attention first?',
      'Pass 7 is complete. What should run next?',
      'Pass 7 found the design focus options. Which review focus do you prefer? <gstack-qid:plan-design-review-focus>',
    ]) {
      const call = calls()[1]!; const q = call.questions[0]!; q.question = question;
      call.answers = { [question]: q.options[0]!.label };
      expect(isDesignCountFirstReview(fingerprint(call))).toBe(false);
    }
    expect(isDesignCountFirstReview({ ...fingerprint(calls()[1]!), nativeCall: undefined })).toBe(false);
  });
  test('manual navigation is selected in both orders only for the active matching native handoff', () => {
    for (const reverse of [false, true]) {
      const call = pending(); if (reverse) call.questions[0]!.options.reverse();
      const q = call.questions[0]!;
      const visible = `☐ ${q.header}\n${q.question}\n` + q.options.map((o, i) => `${i === 0 ? '❯' : ' '} ${i + 1}. ${o.label}`).join('\n') + '\nEnter to select · ↑/↓ to navigate · Esc to cancel';
      const active = capturePlanCountQuestion(visible, new Set(), 0, true, call)!;
      expect(pickDesignCountQuestion(fingerprint(call), active)).toBe(reverse ? 1 : 4);
      expect(isDesignCompletionHandoff(fingerprint(call))).toBe(false);
      const uiOnly = capturePlanCountQuestion(visible, new Set(), 0, true)!;
      expect(pickDesignCountQuestion(fingerprint(call), uiOnly)).toBeNull();
      const other = capturePlanCountQuestion('☐ Contrast finding\nHow should we fix the low contrast?\n❯ 1. Fix it\n  2. Add a TODO\nEnter to select · ↑/↓ to navigate · Esc to cancel', new Set(), 0, true, call)!;
      expect(pickDesignCountQuestion(fingerprint(call), other)).toBeNull();
    }
    const completed = fingerprint(handoff());
    expect(pickDesignCountQuestion(completed, completed)).toBeNull();
  });
  test('mixed or unknown calls keep their substantive count and default choice', () => {
    for (const mutate of [
      (c: NativePlanQuestionCall) => { c.questions.push(calls()[1]!.questions[0]!); },
      (c: NativePlanQuestionCall) => { c.questions[0]!.options.push({ label: 'Add a contrast regression test now' }); },
      (c: NativePlanQuestionCall) => { c.questions[0]!.header = 'Error summary'; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.question = 'Should we fix this gap before running /plan-eng-review? <gstack-qid:plan-design-review-next-step>'; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.question += ' <gstack-qid:settings-contrast-finding>'; },
    ]) {
      const call = handoff(); mutate(call);
      call.answers = Object.fromEntries(call.questions.map(q => [q.question, q.options[0]!.label]));
      expect(isDesignCompletionHandoff(fingerprint(call))).toBe(false);
      const phase = planCountQuestionPhase(fingerprint(call), true, designStep0Boundary, isDesignCountFirstReview, undefined, isDesignCompletionHandoff);
      expect(phase.administrative).toBeUndefined(); expect(phase.preReview).toBe(false);
      const active = fingerprint(pending(call));
      expect(pickDesignCountQuestion(active, active)).toBeNull();
    }
  });
  test('failed, partial, unmatched and free-form handoff answers never create administrative coverage', () => {
    for (const mutate of [
      (c: NativePlanQuestionCall) => { c.answered = false; },
      (c: NativePlanQuestionCall) => { c.failed = true; },
      (c: NativePlanQuestionCall) => { c.unansweredQuestionIndices = [0]; },
      (c: NativePlanQuestionCall) => { c.answers = {}; },
      (c: NativePlanQuestionCall) => { c.answers = { [c.questions[0]!.question]: 'First fix another contrast issue' }; },
    ]) {
      const call = handoff(); mutate(call);
      expect(isDesignCompletionHandoff(fingerprint(call))).toBe(false);
    }
    const mismatched = { ...fingerprint(pending()), signature: 'unrelated-call' };
    expect(pickDesignCountQuestion(mismatched, mismatched)).toBeNull();
  });
  test('conditional or negative completion is a remaining finding, even with the known navigation labels', () => {
    for (const declaration of [
      'Design review complete only after fixing contrast.',
      'Design review complete if the remaining contrast gap is fixed.',
      'Design review is not complete.',
      'Design review complete (after fixing contrast).',
    ]) {
      const call = handoff(); const q = call.questions[0]!;
      q.question = `${declaration} What’s next? <gstack-qid:plan-design-review-next-step>`;
      call.answers = { [q.question]: q.options[0]!.label };
      expect(isDesignCompletionHandoff(fingerprint(call))).toBe(false);
      const active = fingerprint(pending(call));
      expect(pickDesignCountQuestion(active, active)).toBeNull();
    }
    for (const declaration of ['Design review complete.', 'Design review is complete!', 'Design review complete (10/10).']) {
      const call = handoff(); const q = call.questions[0]!;
      q.question = `${declaration} What’s next? <gstack-qid:plan-design-review-next-step>`;
      call.answers = { [q.question]: q.options[0]!.label };
      expect(isDesignCompletionHandoff(fingerprint(call))).toBe(true);
    }
  });
  test('the existing outside opt-out keeps precedence under the composed caller policy', () => {
    const question = 'Want outside design voices before the detailed review? <gstack-qid:outside-voices-design>';
    const call: NativePlanQuestionCall = { sessionId: 'outside', toolUseId: 'opt-in', answered: false,
      questions: [{ header: 'Outside voices', question, multiSelect: false,
        options: [{ label: 'Yes, run outside design voices' }, { label: 'No, proceed without (Recommended)' }] }] };
    const fp = fingerprint(call);
    expect(pickDesignCountQuestion(fp, fp)).toBe(2);
    expect(isDesignCompletionHandoff(fp)).toBe(false);
  });
  test('captured handoff timing does not make a completed report stale; a missing substantive update still does', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-handoff-report-'));
    const file = path.join(dir, 'plan.md');
    try {
      fs.writeFileSync(file, '# Reviewed plan\n\n## GSTACK REVIEW REPORT\n\n' +
        '| Review | Status | Findings |\n|---|---|---|\n| Design | complete | resolved |\n\n' +
        'VERDICT: DESIGN CLEARED — eng review required\n\nNO UNRESOLVED DECISIONS\n');
      const input = calls();
      const transcript = { status: 'ready' as const, calls: input, assistantMessages: [],
        planReadyRequests: [{ sessionId: input[0]!.sessionId,
          toolUseId: 'toolu_01G1mgoSTfmimd7QpazqTNa2', timestamp: '2026-09-08T21:51:11.927Z', failed: false }] };
      const administrative = new Set(input.filter(c => isDesignCompletionHandoff(fingerprint(c))).map(c => fingerprint(c).signature));
      const written = Date.parse('2026-09-08T21:49:47.841Z') / 1000;
      fs.utimesSync(file, written, written);
      const start = Date.parse('2026-09-08T21:40:28.504Z');
      expect(hasNativePlanTerminal(transcript, file, start, 'plan_ready')).toBe(false);
      expect(hasNativePlanTerminal(transcript, file, start, 'plan_ready', administrative)).toBe(true);
      expect(replay(input).review).toBe(3); // Terminal evidence never creates the missing seed approvals.
      const stale = Date.parse(input[3]!.answeredAt!) / 1000 - 1;
      fs.utimesSync(file, stale, stale);
      expect(hasNativePlanTerminal(transcript, file, start, 'plan_ready', administrative)).toBe(false);
      const incomplete = structuredClone(transcript); incomplete.calls[3]!.answered = false;
      expect(hasNativePlanTerminal(incomplete, file, start, 'plan_ready', administrative)).toBe(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
