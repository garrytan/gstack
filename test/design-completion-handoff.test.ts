import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { capturePlanCountQuestion, designStep0Boundary, hasNativePlanTerminal, nativePlanCallFingerprint, planCountQuestionPhase } from './helpers/claude-pty-runner';
import { isDesignCountFirstReview, isDesignCompletionHandoff, pickDesignCountQuestion } from './helpers/design-count-review';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
import captured from './fixtures/design-handoff-l-calls.json';

const calls = () => structuredClone(captured.calls) as NativePlanQuestionCall[];
const handoff = () => calls().at(-1)!;
const fingerprint = (call: NativePlanQuestionCall) => nativePlanCallFingerprint(call, 0, false);

function makePending(call: NativePlanQuestionCall) {
  call.answered = false;
  delete call.answers;
  delete call.unansweredQuestionIndices;
  return call;
}

function activeQuestion(call: NativePlanQuestionCall) {
  const q = call.questions[0]!;
  const visible = `☐ ${q.header}\n${q.question}\n` + q.options.map((option, i) =>
    `${i ? ' ' : '❯'} ${i + 1}. ${option.label}`).join('\n') +
    '\nEnter to select · ↑/↓ to navigate · Esc to cancel';
  return capturePlanCountQuestion(visible, new Set(), 0, false, call)!;
}

describe('Design completed handoff without an offered manual action', () => {
  test('the captured call is administrative, but its missing manual option is never invented', () => {
    const call = handoff();
    expect(isDesignCompletionHandoff(fingerprint(call))).toBe(true);
    expect(pickDesignCountQuestion(fingerprint(call), fingerprint(call))).toBeNull();
    makePending(call);
    expect(isDesignCompletionHandoff(fingerprint(call))).toBe(false);
    expect(pickDesignCountQuestion(fingerprint(call), activeQuestion(call))).toBeNull();
  });

  test('the full captured sequence retains all ten decisions and still exceeds the seven-call ceiling', () => {
    const input = calls();
    const original = structuredClone(input);
    let started = false;
    const counts = { setup: 0, review: 0, administrative: 0 };
    for (const call of input) {
      const phase = planCountQuestionPhase(fingerprint(call), started, designStep0Boundary,
        isDesignCountFirstReview, undefined, isDesignCompletionHandoff);
      started = phase.reviewStarted;
      if (phase.administrative) counts.administrative++;
      else if (phase.preReview) counts.setup++;
      else counts.review++;
    }
    expect(counts).toEqual({ setup: 1, review: 10, administrative: 1 });
    expect(counts.review).toBeGreaterThan(7);
    expect(input).toEqual(original);
  });

  test('an explicit absence of outstanding work remains a closed recap', () => {
    for (const recap of ['No unresolved design decisions.', 'Zero remaining contrast gaps.', 'No gap remains.']) {
      const call = handoff();
      const q = call.questions[0]!;
      q.question = `Design review complete. ${recap} What’s next? <gstack-qid:plan-design-next-steps>`;
      call.answers = { [q.question]: q.options[0]!.label };
      expect(isDesignCompletionHandoff(fingerprint(call))).toBe(true);
    }
  });

  test('an actual manual option is selected in either order only with active native identity', () => {
    for (const reverse of [false, true]) {
      const call = makePending(handoff());
      call.questions[0]!.options.push({ label: "E) Skip — I'll handle next steps manually" });
      if (reverse) call.questions[0]!.options.reverse();
      expect(pickDesignCountQuestion(fingerprint(call), activeQuestion(call))).toBe(reverse ? 1 : 4);
      expect(pickDesignCountQuestion(fingerprint(call), { ...fingerprint(call), signature: 'other' })).toBeNull();
    }
  });

  test('remaining work, mixed actions and unknown identities stay substantive', () => {
    const mutations: Array<(c: NativePlanQuestionCall) => void> = [
      c => { c.questions[0]!.question = c.questions[0]!.question.replace('complete (', 'complete only after resolving contrast ('); },
      c => { c.questions[0]!.question = c.questions[0]!.question.replace('review complete', 'review is not complete'); },
      c => { c.questions[0]!.question = c.questions[0]!.question.replace('7 decisions made', 'one unresolved gap'); },
      c => { c.questions[0]!.question = c.questions[0]!.question.replace('plan-design-next-steps', 'plan-design-contrast-finding'); },
      c => { c.questions[0]!.question += ' <gstack-qid:plan-design-next-steps>'; },
      c => { c.questions[0]!.question = 'Design review complete. One contrast gap remains unresolved. What’s next? <gstack-qid:plan-design-next-steps>'; },
      c => { c.questions[0]!.question = 'Design review complete. One contrast gap remains. What’s next? <gstack-qid:plan-design-next-steps>'; },
      c => { c.questions[0]!.question = 'Design review complete. There is an unresolved contrast gap. What’s next? <gstack-qid:plan-design-next-steps>'; },
      c => { c.questions[0]!.question = c.questions[0]!.question.replace('What', '<gstack-qid malformed What'); },
      c => { c.questions[0]!.header = 'Contrast gap'; },
      c => { c.questions[0]!.options.push({ label: 'Add the missing contrast test' }); },
      c => { c.questions[0]!.options[0]!.label = 'Run /plan-eng-review and fix contrast'; },
      c => { c.questions.push(calls()[1]!.questions[0]!); },
      c => { c.questions[0]!.multiSelect = true; },
    ];
    for (const mutate of mutations) {
      const call = handoff();
      mutate(call);
      call.answers = Object.fromEntries(call.questions.map(q => [q.question, q.options[0]!.label]));
      expect(isDesignCompletionHandoff(fingerprint(call))).toBe(false);
      const phase = planCountQuestionPhase(fingerprint(call), true, designStep0Boundary,
        isDesignCountFirstReview, undefined, isDesignCompletionHandoff);
      expect(phase.administrative).toBeUndefined();
      expect(phase.preReview).toBe(false);
      const pending = fingerprint(makePending(call));
      expect(pickDesignCountQuestion(pending, pending)).toBeNull();
    }
  });

  test('failed, partial, unanswered and free-form results cannot exclude a call', () => {
    const mutations: Array<(c: NativePlanQuestionCall) => void> = [
      c => { c.failed = true; },
      c => { c.answered = false; },
      c => { c.unansweredQuestionIndices = [0]; },
      c => { c.answers = {}; },
      c => { c.answers = { [c.questions[0]!.question]: 'First build a new interaction' }; },
    ];
    for (const mutate of mutations) {
      const call = handoff();
      mutate(call);
      expect(isDesignCompletionHandoff(fingerprint(call))).toBe(false);
    }
  });

  test('the actual late handoff does not stale a valid report, while later real work and failed exits still do', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-handoff-report-'));
    const file = path.join(dir, 'plan.md');
    try {
      fs.writeFileSync(file, '# Reviewed plan\n\n## GSTACK REVIEW REPORT\n\n' +
        '| Review | Status | Findings |\n|---|---|---|\n| Design | complete | resolved |\n\n' +
        'VERDICT: DESIGN CLEARED — eng review required\n\nNO UNRESOLVED DECISIONS\n');
      const input = calls();
      const transcript = { status: 'ready' as const, calls: input, assistantMessages: [],
        planReadyRequests: structuredClone(captured.planReadyRequests) };
      const administrative = new Set(input.filter(c => isDesignCompletionHandoff(fingerprint(c)))
        .map(c => fingerprint(c).signature));
      const written = Date.parse('2026-09-08T23:19:12.049Z') / 1000;
      fs.utimesSync(file, written, written);
      const started = Date.parse('2026-09-08T23:09:43.875Z');
      expect(hasNativePlanTerminal(transcript, file, started, 'plan_ready')).toBe(false);
      expect(hasNativePlanTerminal(transcript, file, started, 'plan_ready', administrative)).toBe(true);
      const stale = Date.parse(input[10]!.answeredAt!) / 1000 - 1;
      fs.utimesSync(file, stale, stale);
      expect(hasNativePlanTerminal(transcript, file, started, 'plan_ready', administrative)).toBe(false);
      fs.utimesSync(file, written, written);
      transcript.planReadyRequests[0]!.failed = true;
      expect(hasNativePlanTerminal(transcript, file, started, 'plan_ready', administrative)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
