import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { capturePlanCountQuestion, designFirstReviewAUQ, designStep0Boundary, hasNativePlanTerminal, nativePlanCallFingerprint, planCountQuestionPhase } from './helpers/claude-pty-runner';
import { isDesignCountFirstReview, isDesignCompletionHandoff, pickDesignCountQuestion } from './helpers/design-count-review';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
import captured from './fixtures/design-review-j-calls.json';
import numberedPasses from './fixtures/design-review-l-calls.json';
import scoredPasses from './fixtures/design-review-n-calls.json';

const calls = () => structuredClone(captured.calls) as NativePlanQuestionCall[];
const fingerprint = (call: NativePlanQuestionCall) => nativePlanCallFingerprint(call, 0, true);
const handoff = () => calls().at(-1)!;
const numberedCalls = () => structuredClone(numberedPasses.calls) as NativePlanQuestionCall[];
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
  test('numbered native pass decisions retain the first hierarchy approval after learnings setup', () => {
    const input = numberedCalls();
    const original = structuredClone(input);
    const hierarchy = input[1]!;
    expect(hierarchy.questions[0]!.options[0]!.description).toContain('cannot ship all-same-weight buttons');
    expect(hierarchy.questions[0]!.options[1]!.description).toContain('visual hierarchy problem ships as-is');
    expect(isDesignCountFirstReview(fingerprint(input[0]!))).toBe(false);
    expect(isDesignCountFirstReview(fingerprint(hierarchy))).toBe(true);
    expect(replay(input)).toMatchObject({ step0: 1, review: 3, administrative: 0 });
    expect(input).toEqual(original);
  });
  test('numbered pass identity cannot turn actual setup or unrelated questions into findings', () => {
    for (const [header, question] of [
      ['Learnings', 'D1 — Pass 1 (Information Architecture): enable cross-project learnings? <gstack-qid:cross-project-learnings>'],
      ['Focus', 'D2 — Pass 1 (Information Architecture): which review focus should come first? <gstack-qid:plan-design-pass1-focus>'],
      ['Scope', 'D2 — Pass 1 (Information Architecture): reduce scope or review every dimension? <gstack-qid:plan-design-pass1-scope>'],
      ['Outside voices', 'D2 — Pass 1 (Information Architecture): run outside reviewers? <gstack-qid:outside-voices-design>'],
      ['Info Arch', 'D2 — Review Pass 1 (Information Architecture) next? <gstack-qid:plan-design-pass1-save-prominence>'],
      ['Info Arch', 'D2 — Pass 2 (Interaction States): fix the missing pending state? <gstack-qid:plan-design-pass1-save-prominence>'],
      ['Info Arch', 'D2 — Pass 1 (Information Architecture): which planning workflow should run? <gstack-qid:unrelated-workflow>'],
    ]) {
      const call = numberedCalls()[1]!;
      const q = call.questions[0]!;
      q.header = header!;
      q.question = question!;
      call.answers = { [q.question]: q.options[0]!.label };
      expect(isDesignCountFirstReview(fingerprint(call))).toBe(false);
    }
  });
  test('numbered pass decisions still require an answered native question and count a packet once', () => {
    for (const mutate of [
      (call: NativePlanQuestionCall) => { call.answered = false; },
      (call: NativePlanQuestionCall) => { call.failed = true; },
      (call: NativePlanQuestionCall) => { call.answers = {}; },
    ]) {
      const call = numberedCalls()[1]!;
      mutate(call);
      expect(isDesignCountFirstReview(fingerprint(call))).toBe(false);
    }
    const [setup, finding] = numberedCalls();
    setup!.questions.push(finding!.questions[0]!);
    setup!.unansweredQuestionIndices = [1];
    expect(isDesignCountFirstReview(fingerprint(setup!))).toBe(false);
    setup!.answers = { ...setup!.answers, ...finding!.answers };
    setup!.unansweredQuestionIndices = [];
    expect(replay([setup!])).toMatchObject({ step0: 0, review: 1, administrative: 0 });
    expect(isDesignCountFirstReview({ ...fingerprint(finding!), nativeCall: undefined })).toBe(false);
  });
  test('native pass readiness and continuation confirmations do not supply a finding', () => {
    for (const question of [
      'D2 — Pass 1 (Information Architecture): ready to start this pass? <gstack-qid:plan-design-pass1-start>',
      'D2 — Pass 1 (Information Architecture): continue with the review? <gstack-qid:plan-design-pass1-continue>',
    ]) {
      const call = numberedCalls()[1]!;
      const q = call.questions[0]!;
      q.question = question;
      q.options = [{ label: 'Begin' }, { label: 'Not yet' }];
      call.answers = { [question]: 'Begin' };
      expect(isDesignCountFirstReview(fingerprint(call))).toBe(false);
      expect(replay([call])).toMatchObject({ step0: 1, review: 0 });
    }
  });
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


describe('scored native Design pass decisions', () => {
  const actualCalls = () => structuredClone(scoredPasses.calls) as NativePlanQuestionCall[];
  const actual = () => actualCalls()[0]!;
  const answer = (call: NativePlanQuestionCall) => {
    call.answers = Object.fromEntries(call.questions.map(q => [q.question, q.options[0]!.label]));
    return call;
  };

  test('the captured scored first pass retains all eight substantive decisions above the unchanged ceiling', () => {
    const input = actualCalls().slice(0, 8);
    const before = structuredClone(input);
    expect(isDesignCountFirstReview(fingerprint(input[0]!))).toBe(true);
    const result = replay(input);
    expect(result).toMatchObject({ step0: 0, review: 8, administrative: 0 });
    expect(result.review).toBeGreaterThan(7);
    expect(input).toEqual(before);
  });

  test('the complete first attempt retains all eleven issue and TODO approvals before its handoff', () => {
    const input = actualCalls();
    expect(input).toHaveLength(12);
    expect(input[10]!.questions[0]!.header).toContain('TODO');
    expect(replay(input.slice(0, -1))).toMatchObject({ step0: 0, review: 11, administrative: 0 });
  });

  test('the captured retry begins at its explicit missing-spec decision and retains every issue', () => {
    const input = structuredClone(scoredPasses.retry.calls) as NativePlanQuestionCall[];
    const original = structuredClone(input);
    expect(isDesignCountFirstReview(fingerprint(input[0]!))).toBe(true);
    expect(replay(input.slice(0, 8))).toMatchObject({ step0: 0, review: 8, administrative: 0 });
    expect(input).toEqual(original);
  });

  test('named pass identity cannot turn phase readiness or a missing answer into a finding', () => {
    for (const mutate of [
      (call: NativePlanQuestionCall) => { call.questions[0]!.question = 'Pass 1 — Information Architecture: ready to begin? <gstack-qid:plan-design-review-ia-hierarchy>'; },
      (call: NativePlanQuestionCall) => { call.questions[0]!.options = [{ label: 'Begin' }, { label: 'Not yet' }]; },
      (call: NativePlanQuestionCall) => { call.questions[0]!.header = 'Focus'; },
      (call: NativePlanQuestionCall) => { call.questions[0]!.question = 'Example: ' + call.questions[0]!.question; },
      (call: NativePlanQuestionCall) => { call.questions[0]!.question = call.questions[0]!.question.replace('plan-design-review-ia-hierarchy', 'plan-design-review-focus'); },
      (call: NativePlanQuestionCall) => { call.failed = true; },
      (call: NativePlanQuestionCall) => { call.unansweredQuestionIndices = [0]; },
    ]) {
      const call = structuredClone(scoredPasses.retry.calls[0]) as NativePlanQuestionCall;
      mutate(call);
      expect(isDesignCountFirstReview(fingerprint(answer(call)))).toBe(false);
    }
  });

  test('native numeric score and missing-requirement decision do not depend on a D-number', () => {
    for (const prefix of ['Pass 1 (Info Architecture) — 7/10.', 'D2 — Pass 1 (Information Architecture): 7.5/10.']) {
      const call = actual();
      call.questions[0]!.question = call.questions[0]!.question.replace(/^Pass 1 \(Info Architecture\) — 7\/10\./, prefix);
      expect(isDesignCountFirstReview(fingerprint(answer(call)))).toBe(true);
    }
  });

  test('readiness, setup, quoted examples and missing substantive choices cannot start review', () => {
    for (const mutate of [
      (call: NativePlanQuestionCall) => { call.questions[0]!.question = 'Pass 1 (Info Architecture) — 7/10. Ready to start this pass? <gstack-qid:plan-design-review-ia-scan-path>'; },
      (call: NativePlanQuestionCall) => { call.questions[0]!.question = 'Pass 1 (Info Architecture) — 7/10. The plan has no missing requirements. Should I begin this pass? <gstack-qid:plan-design-review-ia-scan-path>'; },
      (call: NativePlanQuestionCall) => { call.questions[0]!.question = 'Example: ' + call.questions[0]!.question; },
      (call: NativePlanQuestionCall) => { call.questions[0]!.question = '> ' + call.questions[0]!.question; },
      (call: NativePlanQuestionCall) => { call.questions[0]!.question = call.questions[0]!.question.replace('plan-design-review-ia-scan-path', 'plan-design-review-focus'); },
      (call: NativePlanQuestionCall) => { call.questions[0]!.question = call.questions[0]!.question.replace('plan-design-review-ia-scan-path', 'unrelated-setup'); },
      (call: NativePlanQuestionCall) => { call.questions[0]!.header = 'Outside voices'; },
      (call: NativePlanQuestionCall) => { call.questions[0]!.options = [{ label: 'Begin' }, { label: 'Not yet' }]; },
    ]) {
      const call = actual();
      mutate(call);
      expect(isDesignCountFirstReview(fingerprint(answer(call)))).toBe(false);
    }
  });

  test('the scored pass needs a successfully answered offered native decision', () => {
    for (const mutate of [
      (call: NativePlanQuestionCall) => { call.answered = false; },
      (call: NativePlanQuestionCall) => { call.failed = true; },
      (call: NativePlanQuestionCall) => { call.answers = {}; },
      (call: NativePlanQuestionCall) => { call.answers = { [call.questions[0]!.question]: 'Unknown free-form request' }; },
      (call: NativePlanQuestionCall) => { call.unansweredQuestionIndices = [0]; },
    ]) {
      const call = actual();
      mutate(call);
      expect(isDesignCountFirstReview(fingerprint(call))).toBe(false);
    }
    const missing = fingerprint(actual());
    delete missing.nativeCall;
    expect(isDesignCountFirstReview(missing)).toBe(false);
  });
});
