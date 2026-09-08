import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { capturePlanCountQuestion, ceoStep0Boundary, hasNativePlanTerminal, nativePlanCallFingerprint, planCountQuestionPhase } from './helpers/claude-pty-runner';
import { isCeoCompletionHandoff, pickCeoCompletionHandoff } from './helpers/ceo-completion-handoff';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
import captures from './fixtures/ceo-completion-handoff-calls.json';
import currentHandoffs from './fixtures/ceo-completion-handoff-j-calls.json';

type CapturedCall = typeof captures.cases[number]['calls'][number];
function nativeCall(record: CapturedCall, sessionId = 'native-capture'): NativePlanQuestionCall {
  return {
    sessionId, toolUseId: record.toolUseId, answered: true, failed: false,
    questions: [{ header: record.header, question: record.question,
      options: record.options.map(label => ({ label })), multiSelect: false }],
    answers: { [record.question]: record.answer }, unansweredQuestionIndices: [],
  };
}
const handoff = () => nativeCall(captures.cases[0]!.calls.at(-1)!);
const fingerprint = (call: NativePlanQuestionCall) => nativePlanCallFingerprint(call, 0, false);

function replay(calls: NativePlanQuestionCall[], reviewStarted = true) {
  const counts = { step0Count: 0, reviewCount: 0, administrativeCount: 0 };
  const classifications = [];
  for (const call of calls) {
    const fp = fingerprint(call);
    const phase = planCountQuestionPhase(fp, reviewStarted, ceoStep0Boundary,
      // A completion summary can mention defects; even a broad positive
      // first-finding predicate must not promote a handoff into coverage.
      () => true, undefined, isCeoCompletionHandoff);
    if (phase.administrative) counts.administrativeCount++;
    else if (phase.preReview) counts.step0Count++;
    else counts.reviewCount++;
    reviewStarted = phase.reviewStarted;
    classifications.push(phase);
  }
  return { ...counts, reviewStarted, classifications };
}

describe('CEO completion handoff classification and selection', () => {
  test('captured first attempts keep every finding/TODO and exclude only the handoff; substantive retry still fails its band', () => {
    for (const scenario of captures.cases) {
      const calls = scenario.calls.map(c => nativeCall(c, scenario.sessionId));
      const original = structuredClone(calls);
      const result = replay(calls);
      expect(result.reviewCount).toBe(scenario.expectedReviewCount);
      expect(result.administrativeCount).toBe(scenario.name === 'five-retry' ? 0 : 1);
      expect(result.step0Count).toBe(0);
      expect(calls).toEqual(original); // Classification never discards or rewrites native evidence.
      for (const [i, call] of calls.entries()) {
        if (/TODO/i.test(call.questions[0]!.header)) expect(result.classifications[i]!.administrative).toBeUndefined();
      }
    }
    expect(replay(captures.cases[2]!.calls.map(c => nativeCall(c))).reviewCount).toBeGreaterThan(7);
  });
  test('handoff-only replay adds no findings or setup and cannot establish a first finding', () => {
    const result = replay([handoff()], false);
    expect(result).toMatchObject({ step0Count: 0, reviewCount: 0, administrativeCount: 1, reviewStarted: false });
    expect(result.classifications[0]).toEqual({ preReview: false, reviewStarted: false, administrative: 'completion-handoff' });
  });
  test('manual/done action is selected in either option order only while the matching native question is pending', () => {
    for (const reverse of [false, true]) {
      const call = handoff(); call.answered = false; delete call.answers; delete call.unansweredQuestionIndices;
      if (reverse) call.questions[0]!.options.reverse();
      const fp = fingerprint(call);
      expect(pickCeoCompletionHandoff(fp)).toBe(reverse ? 1 : 2);
      expect(isCeoCompletionHandoff(fp)).toBe(false);
    }
    expect(pickCeoCompletionHandoff(fingerprint(handoff()))).toBeNull();
  });
  test('substantive choices mentioning another review retain the normal choice and finding count', () => {
    const call = nativeCall(captures.cases[0]!.calls[0]!);
    call.questions[0]!.question += ' Run /plan-eng-review next after deciding how to fix this issue.';
    call.answers = { [call.questions[0]!.question]: call.questions[0]!.options[0]!.label };
    expect(isCeoCompletionHandoff(fingerprint(call))).toBe(false);
    expect(replay([call]).reviewCount).toBe(1);
    call.answered = false;
    expect(pickCeoCompletionHandoff(fingerprint(call))).toBeNull();
  });
  test('mixed packets and unknown action choices are not classified as an administrative handoff', () => {
    const mixed = handoff();
    const finding = nativeCall(captures.cases[0]!.calls[0]!);
    mixed.questions.push(finding.questions[0]!);
    mixed.answers = { ...mixed.answers, ...finding.answers };
    expect(isCeoCompletionHandoff(fingerprint(mixed))).toBe(false);
    expect(replay([mixed]).reviewCount).toBe(1);
    mixed.answered = false;
    expect(pickCeoCompletionHandoff(fingerprint(mixed))).toBeNull();
    const unknown = handoff(); unknown.questions[0]!.options.push({ label: 'Add another payment test before continuing' });
    expect(isCeoCompletionHandoff(fingerprint(unknown))).toBe(false);
  });
  test('unknown identities and generic skip choices remain counted', () => {
    for (const mutate of [
      (c: NativePlanQuestionCall) => { c.questions[0]!.question += ' <gstack-qid:plan-ceo-security-finding>'; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.header = 'Test gap'; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.options[1]!.label = 'Skip'; },
    ]) {
      const call = handoff(); mutate(call);
      call.answers = { [call.questions[0]!.question]: call.questions[0]!.options[0]!.label };
      expect(isCeoCompletionHandoff(fingerprint(call))).toBe(false);
      expect(replay([call]).reviewCount).toBe(1);
    }
    const call = handoff(); call.answered = false;
    const mismatched = { ...fingerprint(call), signature: 'another-native-call' };
    expect(pickCeoCompletionHandoff(mismatched)).toBeNull();
  });
  test('pending, failed, partial and free-form answers never create an exclusion', () => {
    for (const mutate of [
      (c: NativePlanQuestionCall) => { c.answered = false; },
      (c: NativePlanQuestionCall) => { c.failed = true; },
      (c: NativePlanQuestionCall) => { c.unansweredQuestionIndices = [0]; },
      (c: NativePlanQuestionCall) => { c.answers = {}; },
      (c: NativePlanQuestionCall) => { c.answers = { [c.questions[0]!.question]: 'First add a refund test' }; },
    ]) {
      const call = handoff(); mutate(call);
      expect(isCeoCompletionHandoff(fingerprint(call))).toBe(false);
    }
  });
  test('UI-only and unrelated pending metadata cannot steer the active menu', () => {
    const pending = handoff(); pending.answered = false; delete pending.answers;
    const q = pending.questions[0]!;
    const active = `☐ ${q.header}\n${q.question}\n❯ 1. ${q.options[0]!.label}\n  2. ${q.options[1]!.label}\nEnter to select · ↑/↓ to navigate · Esc to cancel`;
    const bound = capturePlanCountQuestion(active, new Set(), 0, false, pending)!;
    expect(pickCeoCompletionHandoff(fingerprint(pending), bound)).toBe(2);
    const uiOnly = capturePlanCountQuestion(active, new Set(), 0, false)!;
    expect(pickCeoCompletionHandoff(uiOnly)).toBeNull();
    const issue = '☐ Security finding\nChoose how to parameterize the SQL query.\n❯ 1. Fix query\n  2. Add a TODO\nEnter to select · ↑/↓ to navigate · Esc to cancel';
    const unbound = capturePlanCountQuestion(issue, new Set(), 0, false, pending)!;
    expect(unbound.nativeCall).toBeUndefined();
    expect(pickCeoCompletionHandoff(fingerprint(pending), unbound)).toBeNull();
  });
});


describe('completed CEO handoff with native next-step identity', () => {
  function capturedHandoff(): NativePlanQuestionCall {
    const question = 'D7 — CEO review is complete. Run /plan-eng-review next (the required shipping gate)? <gstack-qid:plan-ceo-review-next-step>';
    return {
      sessionId: 'e10cf0b4-525b-442d-9c2a-7a48d6b39f50',
      toolUseId: 'toolu_01FmkkRpoE3s6Y93KX6zLN1q',
      answered: true,
      failed: false,
      questions: [{
        question,
        header: 'Next review',
        multiSelect: false,
        options: [
          { label: 'Run /plan-eng-review next (recommended)' },
          { label: "Skip — I'll handle reviews manually" },
        ],
      }],
      answers: { [question]: 'Run /plan-eng-review next (recommended)' },
      unansweredQuestionIndices: [],
    };
  }

  test('captured completed-review menu is administrative and retains every independent finding and TODO', () => {
    const calls = captures.cases[1]!.calls.slice(0, -1).map(c => nativeCall(c));
    const result = replay([...calls, capturedHandoff()]);
    expect(result).toMatchObject({ reviewCount: 4, administrativeCount: 1, step0Count: 0 });
    expect(result.classifications.slice(0, -1).every(p => !p.administrative)).toBe(true);
  });

  test('only the positively bound pending handoff selects manual, in either option order', () => {
    for (const reverse of [false, true]) {
      const call = capturedHandoff();
      call.answered = false;
      delete call.answers;
      if (reverse) call.questions[0]!.options.reverse();
      expect(pickCeoCompletionHandoff(fingerprint(call))).toBe(reverse ? 1 : 2);
      expect(isCeoCompletionHandoff(fingerprint(call))).toBe(false);
    }
  });

  test('incomplete review, missing gate, findings, mixed choices, and unoffered answers stay substantive', () => {
    for (const mutate of [
      (c: NativePlanQuestionCall) => { c.questions[0]!.question = c.questions[0]!.question.replace('is complete', 'has an unresolved test gap'); },
      (c: NativePlanQuestionCall) => { c.questions[0]!.question = c.questions[0]!.question.replace('required shipping gate', 'optional follow-up'); },
      (c: NativePlanQuestionCall) => { c.questions[0]!.question = c.questions[0]!.question.replace('plan-ceo-review-next-step', 'plan-ceo-security-finding'); },
      (c: NativePlanQuestionCall) => { c.questions[0]!.header = 'TODO: email queue'; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.options.push({ label: 'Add missing staging validation to this plan' }); },
    ]) {
      const call = capturedHandoff();
      mutate(call);
      call.answers = { [call.questions[0]!.question]: call.questions[0]!.options[0]!.label };
      expect(isCeoCompletionHandoff(fingerprint(call))).toBe(false);
      expect(replay([call]).reviewCount).toBe(1);
    }
    const call = capturedHandoff();
    call.answers = { [call.questions[0]!.question]: 'First add the missing retry test' };
    expect(isCeoCompletionHandoff(fingerprint(call))).toBe(false);
  });
});


const CAPTURED_PAIRED_RETRY_CALLS: NativePlanQuestionCall[] = [
  {
    "sessionId": "eaedca8a-f52b-4739-a559-3f330e10b3c6",
    "toolUseId": "toolu_01CG8hh817d7CvFk9kH5ZFW4",
    "questions": [
      {
        "question": "D6 — Section 2 finding: the 502 failure path test's assertion is under-specified. What does 'fails clean' mean as an observable outcome? <gstack-qid:plan-ceo-fails-clean>",
        "header": "502 failure mode",
        "multiSelect": false,
        "options": [
          {
            "label": "Specify the exception type in the plan (Recommended)",
            "description": "Update the plan to name the exception class processPayment() raises after 502 exhaustion (e.g. 'assert raises Stripe::APIConnectionError' or 'assert raises PaymentFailedError'). The test must assert a concrete observable: the exception class, not just 'something goes wrong.' Effort: add 1 line to the plan. Verify: test fails with wrong exception type.",
            "preview": "REMEDY:\n  Plan change: add to item 2 under ## Tests:\n  'The 502 test must assert the specific exception class\n   (or nil return, or error struct) processPayment() raises\n   after retry exhaustion. The test factory already exposes\n   mock call history; the test should also assert exactly 2\n   charge attempts and 1 backoff sleep call.'\n\nWhy: without this, the implementer will write\n  expect { processPayment() }.not_to raise_error\nwhich passes on the wrong behavior (swallowed exception)."
          },
          {
            "label": "Accept 'fails clean' as implementation-determined",
            "description": "Trust the implementer to look at processPayment() and assert whatever behavior they find. The test is still useful. Risk: if processPayment() silently swallows the error (no raise, no return value), the test will pass even when payment silently fails."
          }
        ]
      }
    ],
    "answered": true,
    "failed": false,
    "answers": {
      "D6 — Section 2 finding: the 502 failure path test's assertion is under-specified. What does 'fails clean' mean as an observable outcome? <gstack-qid:plan-ceo-fails-clean>": "Specify the exception type in the plan (Recommended)"
    },
    "unansweredQuestionIndices": [],
    "answeredAt": "2026-09-08T20:57:40.308Z"
  },
  {
    "sessionId": "eaedca8a-f52b-4739-a559-3f330e10b3c6",
    "toolUseId": "toolu_01Bc1mwoqXgNQK7NVx8MA21L",
    "questions": [
      {
        "question": "D7 — Section 4 finding: the happy path assertion 'correct receipt is generated' needs to be field-specific to be a correctness test. <gstack-qid:plan-ceo-receipt-fields>",
        "header": "Receipt assertion",
        "multiSelect": false,
        "options": [
          {
            "label": "Add field-level assertion requirement to the plan (Recommended)",
            "description": "Update the plan: the happy path test must assert specific receipt fields (at minimum: amount matches charged amount, stripe_charge_id matches the mock's returned charge ID). Prevents the test from being just a nil-check smoke test. Effort: add 1 line to the plan. Verify: test fails if receipt has wrong charge ID.",
            "preview": "REMEDY:\n  Plan change: add to item 1 under ## Tests:\n  'The happy path test must assert field-level receipt\n   correctness: at minimum, the receipt amount equals the\n   charged amount and the receipt stripe_charge_id matches\n   the charge ID returned by the Stripe mock.\n   assert receipt.amount == expected_amount\n   assert receipt.stripe_charge_id == mock_charge.id'\n\nWhy: 'assert receipt is generated' is a smoke test.\n  It passes even if receipt contains wrong amount or\n  no charge ID, which is the correctness we care about."
          },
          {
            "label": "Accept 'correct receipt generated' as-is",
            "description": "Leave it to the implementer. Risk: a future refactor that breaks receipt field accuracy (e.g., amount in wrong currency unit) could pass the test silently."
          }
        ]
      }
    ],
    "answered": true,
    "failed": false,
    "answers": {
      "D7 — Section 4 finding: the happy path assertion 'correct receipt is generated' needs to be field-specific to be a correctness test. <gstack-qid:plan-ceo-receipt-fields>": "Add field-level assertion requirement to the plan (Recommended)"
    },
    "unansweredQuestionIndices": [],
    "answeredAt": "2026-09-08T20:58:04.465Z"
  },
  {
    "sessionId": "eaedca8a-f52b-4739-a559-3f330e10b3c6",
    "toolUseId": "toolu_014MYMCNbEGQfNYwqFkQQmKm",
    "questions": [
      {
        "question": "D8 — TODO candidate: test the orphaned-payment scenario (receipt-builder fails after Stripe charge succeeds). Add to TODOS.md? <gstack-qid:plan-ceo-todo-orphaned-payment>",
        "header": "TODO: orphaned payment",
        "multiSelect": false,
        "options": [
          {
            "label": "Add to TODOS.md (Recommended)",
            "description": "Stripe charge succeeds, then receipt-builder throws — processPayment() returns an error to the caller. If the caller retries, the card gets charged twice. The existing receipt-builder regression tests cover receipt-builder itself, but nothing tests processPayment()'s behavior in this specific sequence. P2, M effort (human: ~1h / CC: ~8min).",
            "preview": "TODO entry:\n  What: Test orphaned-payment scenario in processPayment()\n  Why: Stripe charge succeeds, receipt-builder throws,\n       caller retries → double charge. No test covers this.\n  Where: payment test factory already supports this setup.\n  Effort: M (human ~1h / CC ~8min)\n  Priority: P2\n  Depends on: this PR (test infra in place)"
          },
          {
            "label": "Skip — not valuable enough",
            "description": "The receipt-builder regression tests provide sufficient coverage. Double-charge scenario is handled by idempotency keys at the Stripe level."
          },
          {
            "label": "Build it now in this PR",
            "description": "Add a third test case to this PR: receipt-builder throws after successful charge — assert processPayment() returns the expected error and Stripe mock shows only 1 charge attempt (no retry on receipt failure). Expands scope from HOLD SCOPE decision."
          }
        ]
      }
    ],
    "answered": true,
    "failed": false,
    "answers": {
      "D8 — TODO candidate: test the orphaned-payment scenario (receipt-builder fails after Stripe charge succeeds). Add to TODOS.md? <gstack-qid:plan-ceo-todo-orphaned-payment>": "Add to TODOS.md (Recommended)"
    },
    "unansweredQuestionIndices": [],
    "answeredAt": "2026-09-08T20:59:02.919Z"
  },
  {
    "sessionId": "eaedca8a-f52b-4739-a559-3f330e10b3c6",
    "toolUseId": "toolu_019ppgizjxzRiJd2QXPV7rYQ",
    "questions": [
      {
        "question": "D9 — CEO review complete. Run /plan-eng-review next? <gstack-qid:plan-ceo-next-review>",
        "header": "Next review",
        "multiSelect": false,
        "options": [
          {
            "label": "Run /plan-eng-review next (Recommended)",
            "description": "Eng review is the required shipping gate. It covers architecture, code quality, and test correctness at the code level — what the CEO review doesn't dig into. The 2 spec gaps found here (exception type, receipt fields) should be verified at the code level too."
          },
          {
            "label": "Skip — handle reviews manually",
            "description": "Proceed without running eng review now. You can run it later with /plan-eng-review. Note: eng review is the only gate that blocks shipping by default."
          }
        ]
      }
    ],
    "answered": true,
    "failed": false,
    "answers": {
      "D9 — CEO review complete. Run /plan-eng-review next? <gstack-qid:plan-ceo-next-review>": "Run /plan-eng-review next (Recommended)"
    },
    "unansweredQuestionIndices": [],
    "answeredAt": "2026-09-08T21:03:34.802Z"
  }
];


describe('completed CEO next-review declaration and final report order', () => {
  test('canonical identity alone never replaces actual completion and the next-review header', () => {
    for (const mutate of [
      (call: NativePlanQuestionCall) => { call.questions[0]!.question = 'Should we finish reviewing? <gstack-qid:plan-ceo-next-steps>'; },
      (call: NativePlanQuestionCall) => { call.questions[0]!.header = 'New security issue'; },
    ]) {
      const call = structuredClone(CAPTURED_PAIRED_RETRY_CALLS.at(-1)!);
      call.questions[0]!.question = call.questions[0]!.question.replace('plan-ceo-next-review', 'plan-ceo-next-steps');
      call.questions[0]!.options[1]!.label = "Skip — I'll handle reviews manually";
      mutate(call);
      call.answers = { [call.questions[0]!.question]: call.questions[0]!.options[0]!.label };
      expect(isCeoCompletionHandoff(fingerprint(call))).toBe(false);
    }
  });

  test('the captured retry keeps its three findings/TODOs and recognizes only the completed handoff', () => {
    expect(replay(structuredClone(CAPTURED_PAIRED_RETRY_CALLS))).toMatchObject({
      reviewCount: 3, administrativeCount: 1, step0Count: 0,
    });
    const call = structuredClone(CAPTURED_PAIRED_RETRY_CALLS.at(-1)!);
    call.answered = false;
    delete call.answers;
    expect(pickCeoCompletionHandoff(fingerprint(call))).toBe(2);
    call.questions[0]!.options.reverse();
    expect(pickCeoCompletionHandoff(fingerprint(call))).toBe(1);
  });

  test('a report written before the administrative handoff can reach the real plan-approval gate', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-handoff-order-'));
    const file = path.join(dir, 'plan.md');
    try {
      fs.writeFileSync(file, '# Plan\n\n## GSTACK REVIEW REPORT\n\n' +
        '| Review | Runs | Status | Findings |\n|---|---|---|---|\n| CEO | 1 | COMPLETE | 3 |\n\n' +
        'VERDICT: CEO CLEARED\n\nNO UNRESOLVED DECISIONS\n');
      // Native Write succeeded at this time, before the final handoff. The
      // live inode was cleaned up; this fixture replays that observed order.
      const reportAt = Date.parse('2026-09-08T21:01:38.295Z') / 1000;
      fs.utimesSync(file, reportAt, reportAt);
      const calls = structuredClone(CAPTURED_PAIRED_RETRY_CALLS);
      const transcript = {
        status: 'ready' as const,
        calls,
        assistantMessages: [],
        planReadyRequests: [{
          sessionId: calls[0]!.sessionId,
          toolUseId: 'toolu_01XK7amzoCx4VTm1r2bHdtsH',
          timestamp: '2026-09-08T21:03:46.725Z',
          failed: false,
        }],
      };
      const admin = new Set(calls.filter(call => isCeoCompletionHandoff(fingerprint(call)))
        .map(call => `${call.sessionId}:${call.toolUseId}`));
      const startedAt = Date.parse('2026-09-08T20:51:50Z');
      expect(admin.size).toBe(1);
      expect(hasNativePlanTerminal(transcript, file, startedAt, 'plan_ready')).toBe(false);
      expect(hasNativePlanTerminal(transcript, file, startedAt, 'plan_ready', admin)).toBe(true);
      transcript.planReadyRequests[0]!.failed = true;
      expect(hasNativePlanTerminal(transcript, file, startedAt, 'plan_ready', admin)).toBe(false);
      transcript.planReadyRequests[0]!.failed = false;
      // A new substantive answer after the Write remains a freshness boundary.
      calls.splice(-1, 0, { ...structuredClone(calls[0]!), toolUseId: 'later-substantive-fix',
        answeredAt: '2026-09-08T21:03:00.000Z' });
      expect(hasNativePlanTerminal(transcript, file, startedAt, 'plan_ready', admin)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});


describe('captured CEO next-step prefixes and immediate review menus', () => {
  test('next-step prefixes and a CLEAN declaration still identify only the completed handoff', () => {
    for (const scenario of currentHandoffs.cases) {
      const call = structuredClone(scenario.nativeCall) as NativePlanQuestionCall;
      const before = structuredClone(call);
      expect(replay([call])).toMatchObject({ reviewCount: 0, administrativeCount: 1, step0Count: 0 });
      expect(call).toEqual(before);
    }
  });

  test('the bound pending menu selects the offered manual action in either order', () => {
    for (const scenario of currentHandoffs.cases) for (const reverse of [false, true]) {
      const call = structuredClone(scenario.nativeCall) as NativePlanQuestionCall;
      call.answered = false; delete call.answers; delete call.unansweredQuestionIndices;
      if (reverse) call.questions[0]!.options.reverse();
      const q = call.questions[0]!;
      const active = `☐ ${q.header}\n${q.question}\n❯ 1. ${q.options[0]!.label}\n  2. ${q.options[1]!.label}\nEnter to select · ↑/↓ to navigate · Esc to cancel`;
      const bound = capturePlanCountQuestion(active, new Set(), 0, false, call)!;
      expect(bound.nativeCall?.toolUseId).toBe(call.toolUseId);
      expect(pickCeoCompletionHandoff(fingerprint(call), bound)).toBe(reverse ? 1 : 2);
      expect(isCeoCompletionHandoff(bound)).toBe(false);
      const uiOnly = capturePlanCountQuestion(active, new Set(), 0, false)!;
      expect(pickCeoCompletionHandoff(uiOnly)).toBeNull();
    }
  });

  test('conditional completion, substantive actions, and mismatched identities still cannot authorize a handoff', () => {
    for (const scenario of currentHandoffs.cases) for (const mutate of [
      (c: NativePlanQuestionCall) => { c.questions[0]!.question = 'Next steps: If the CEO review is complete, should we run the next review? Eng review is the required shipping gate.'; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.question = 'Next steps: The CEO review is not complete. Eng review is the required shipping gate.'; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.question = 'Next steps: CEO review is CLEAN only after fixing this security gap. Eng review is the required shipping gate.'; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.header = 'Security finding'; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.options[0]!.label += ' and implement the fixes'; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.options.push({ label: 'Add missing retry coverage to TODOS.md' }); },
    ]) {
      const call = structuredClone(scenario.nativeCall) as NativePlanQuestionCall;
      mutate(call);
      call.answers = { [call.questions[0]!.question]: call.questions[0]!.options[0]!.label };
      expect(isCeoCompletionHandoff(fingerprint(call))).toBe(false);
      expect(replay([call]).reviewCount).toBe(1);
      call.answered = false; delete call.answers;
      expect(pickCeoCompletionHandoff(fingerprint(call))).toBeNull();
    }
    for (const scenario of currentHandoffs.cases) {
      const call = structuredClone(scenario.nativeCall) as NativePlanQuestionCall;
      call.answered = false;
      expect(pickCeoCompletionHandoff({ ...fingerprint(call), signature: 'other-session:other-call' })).toBeNull();
    }
  });
});
