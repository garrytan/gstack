import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { capturePlanCountQuestion, ceoFirstReviewAUQ, ceoStep0Boundary, hasNativePlanTerminal, nativePlanCallFingerprint, planCountQuestionPhase } from './helpers/claude-pty-runner';
import { isCeoCompletionHandoff, pickCeoCompletionHandoff } from './helpers/ceo-completion-handoff';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
import captures from './fixtures/ceo-completion-handoff-calls.json';
import currentHandoffs from './fixtures/ceo-completion-handoff-j-calls.json';
import kHandoffs from './fixtures/ceo-completion-handoff-k-calls.json';
import rCalls from './fixtures/ceo-completion-handoff-r-calls.json';
import tHandoff from './fixtures/ceo-completion-handoff-t-call.json';
import uHandoff from './fixtures/ceo-completion-handoff-u-call.json';
import vHandoff from './fixtures/ceo-completion-handoff-v-call.json';

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

describe('V closed CEO recap with a resolved-gap count', () => {
  const actual = () => structuredClone(vHandoff.calls.at(-1)!) as NativePlanQuestionCall;
  const pending = (call: NativePlanQuestionCall) => {
    call.answered = false; delete call.answers; delete call.unansweredQuestionIndices;
    return fingerprint(call);
  };
  test('actual navigation stays outside the two issue decisions and selects manual', () => {
    expect(replay(structuredClone(vHandoff.calls) as NativePlanQuestionCall[], false, ceoFirstReviewAUQ))
      .toMatchObject({ step0Count: 3, reviewCount: 2, administrativeCount: 1 });
    expect(isCeoCompletionHandoff(fingerprint(actual()))).toBe(true);
    expect(pickCeoCompletionHandoff(pending(actual())) ?? 1).toBe(2);
    const reordered = actual(); reordered.questions[0]!.options.reverse();
    expect(pickCeoCompletionHandoff(pending(reordered))).toBe(1);
  });
  test('the actual report is fresh after issue decisions but before this navigation', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-v-handoff-'));
    try {
      const report = path.join(dir, 'report.md'); fs.writeFileSync(report, vHandoff.reportContent);
      const written = vHandoff.provenance.reportMtimeMs / 1000; fs.utimesSync(report, written, written);
      const calls = structuredClone(vHandoff.calls) as NativePlanQuestionCall[];
      const transcript = { status: 'ready' as const, calls, assistantMessages: [], planReadyRequests: vHandoff.planReadyRequests };
      const admin = new Set(calls.filter(c => isCeoCompletionHandoff(fingerprint(c))).map(c => `${c.sessionId}:${c.toolUseId}`));
      const start = Date.parse('2026-09-09T08:42:53Z');
      expect(hasNativePlanTerminal(transcript, report, start, 'plan_ready', admin)).toBe(true);
      calls.at(-2)!.answeredAt = new Date(vHandoff.provenance.reportMtimeMs + 1).toISOString();
      expect(hasNativePlanTerminal(transcript, report, start, 'plan_ready', admin)).toBe(false);
    } finally { fs.rmSync(dir, {recursive:true,force:true}); }
  });
  test('the new recap cannot hide incomplete review, another remedy or altered gate', () => {
    const edits: Array<(call: NativePlanQuestionCall) => void> = [
      c => { c.questions[0]!.question = c.questions[0]!.question.replace('0 critical gaps','1 critical gap'); },
      c => { c.questions[0]!.question = c.questions[0]!.question.replace('gaps resolved','gaps unresolved'); },
      c => { c.questions[0]!.question = c.questions[0]!.question.replace('is complete','is complete only after tests pass'); },
      c => { c.questions[0]!.question += ' Repair the missing authorization test.'; },
      c => { c.questions[0]!.question += ' Should we remove the owner check?'; },
      c => { c.questions[0]!.options[0]!.description += ' Delete the failing test.'; },
      c => { c.questions[0]!.options[1]!.description = 'The CEO review is NOT CLEARED until its gaps are resolved.'; },
      c => { c.questions[0]!.question = c.questions[0]!.question.replace('required shipping gate','optional review'); },
      c => { c.questions[0]!.header = 'New finding'; },
      c => { c.questions[0]!.options[1]!.label = 'Implement a new feature'; },
    ];
    for (const edit of edits) {
      const c = actual(); edit(c); c.answers = {[c.questions[0]!.question]:c.questions[0]!.options[0]!.label};
      expect(isCeoCompletionHandoff(fingerprint(c))).toBe(false);
      expect(pickCeoCompletionHandoff(pending(c))).toBeNull();
    }
  });
  test('completed identity, offered answer and single question remain required', () => {
    for (const edit of [
      (c: NativePlanQuestionCall) => { c.failed = true; },
      (c: NativePlanQuestionCall) => { delete c.unansweredQuestionIndices; },
      (c: NativePlanQuestionCall) => { c.answers = {[c.questions[0]!.question]:'Add a new task'}; },
      (c: NativePlanQuestionCall) => { c.questions.push(structuredClone(c.questions[0]!)); },
    ]) { const c=actual();edit(c);expect(isCeoCompletionHandoff(fingerprint(c))).toBe(false); }
    expect(pickCeoCompletionHandoff({...pending(actual()),signature:'foreign:call'})).toBeNull();
    expect(pickCeoCompletionHandoff({...pending(actual()),nativeCall:undefined})).toBeNull();
  });
});

describe('U completed CEO metadata navigation with scoped review explanations', () => {
  const captured = () => structuredClone(uHandoff.calls.at(-1)!) as NativePlanQuestionCall;
  const pending = (call: NativePlanQuestionCall) => {
    const copy = structuredClone(call); copy.answered = false; delete copy.answers; delete copy.unansweredQuestionIndices;
    return fingerprint(copy);
  };
  test('the actual six-call stream retains two issues and selects the offered manual stop', () => {
    const calls = structuredClone(uHandoff.calls) as NativePlanQuestionCall[];
    expect(replay(calls, false, ceoFirstReviewAUQ)).toMatchObject({ step0Count: 3, reviewCount: 2, administrativeCount: 1 });
    expect(isCeoCompletionHandoff(fingerprint(captured()))).toBe(true);
    expect(pickCeoCompletionHandoff(pending(captured())) ?? 1).toBe(2);
    expect(calls).toEqual(uHandoff.calls);
  });
  test('native identity, completed answer and real option order remain required', () => {
    const call = captured(); call.questions[0]!.options.reverse();
    expect(pickCeoCompletionHandoff(pending(call))).toBe(1);
    expect(pickCeoCompletionHandoff(fingerprint(call))).toBeNull();
    expect(pickCeoCompletionHandoff({ ...pending(call), signature: 'foreign:call' })).toBeNull();
    expect(pickCeoCompletionHandoff({ ...pending(call), nativeCall: undefined })).toBeNull();
    for (const mutate of [
      (c: NativePlanQuestionCall) => { c.failed = true; },
      (c: NativePlanQuestionCall) => { delete c.failed; },
      (c: NativePlanQuestionCall) => { c.answered = false; },
      (c: NativePlanQuestionCall) => { c.unansweredQuestionIndices = [0]; },
      (c: NativePlanQuestionCall) => { delete c.unansweredQuestionIndices; },
      (c: NativePlanQuestionCall) => { c.answers = { [c.questions[0]!.question]: 'Fix one more issue first' }; },
    ]) { const c = captured(); mutate(c); expect(isCeoCompletionHandoff(fingerprint(c))).toBe(false); }
  });
  test('unfinished, conditional, quoted and additional-work descriptions remain substantive', () => {
    for (const extra of [
      'Delete the failing regression test before Eng.', 'Remove the owner check before Eng.',
      'Change the guarantee to permit old results.', 'Rewrite the acceptance criteria before shipping.',
      'Repair the missing authorization test.', 'We may repair the missing authorization test.',
      'All findings become resolved after the tests pass.', 'There is an outstanding authorization gap.',
      'Should we add another test before Eng?', 'Stakes if we pick wrong: delete the owner check.',
      'No UI scope was detected, so the CEO review is not complete.',
    ]) {
      const c = captured(); c.questions[0]!.options[1]!.description += ' ' + extra;
      expect(isCeoCompletionHandoff(fingerprint(c))).toBe(false);
      expect(pickCeoCompletionHandoff(pending(c))).toBeNull();
    }
    for (const [from, to] of [
      ['The CEO review is done.', 'The CEO review is not done.'],
      ['The CEO review is done.', 'The CEO review is done if tests pass.'],
      ['Two assertion spec gaps were caught and resolved.', 'Not all assertion spec gaps were resolved.'],
      ['Two assertion spec gaps were caught and resolved.', 'Two assertion spec gaps remain unresolved.'],
      ['No UI scope was detected, so a design review is not needed.', 'The CEO review is not needed.'],
      ['No UI scope was detected, so a design review is not needed.', 'No UI scope was detected, so a design review is not complete.'],
      ['Stakes if we pick wrong:', 'The CEO review is complete only if we pick correctly:'],
    ]) {
      const c = captured(); const q = c.questions[0]!; const old = q.question; q.question = old.replace(from!, to!);
      c.answers = { [q.question]: c.answers![old]! };
      expect(isCeoCompletionHandoff(fingerprint(c))).toBe(false);
      expect(pickCeoCompletionHandoff(pending(c))).toBeNull();
    }
    for (const prefix of ['> ', '```text\n', 'Example: ']) {
      const c = captured(); c.questions[0]!.options[1]!.description = prefix + c.questions[0]!.options[1]!.description;
      expect(isCeoCompletionHandoff(fingerprint(c))).toBe(false);
    }
    for (const mutate of [
      (c: NativePlanQuestionCall) => { c.questions[0]!.question = 'Should we fix the missing authorization check?'; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.header = 'Authorization gap'; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.question += ' <gstack-qid:ceo-security-finding>'; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.options[1]!.label = 'Repair authorization before Eng'; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.options.push({ label: 'Add a new TODO' }); },
    ]) { const c = captured(); mutate(c); expect(isCeoCompletionHandoff(fingerprint(c))).toBe(false); expect(pickCeoCompletionHandoff(pending(c))).toBeNull(); }
  });
  test('metadata headings cannot shelter an extra obligation or conditional completion', () => {
    for (const extra of ['Delete the owner check.', 'Remove the failing regression.', 'Change the guarantee.',
      'Rewrite the acceptance criteria.', 'All decisions are resolved after the tests pass.',
      'Should we approve one more issue?', 'The CEO review is not complete.']) {
      const c = captured(); const q = c.questions[0]!; const old = q.question;
      q.question += ' ' + extra; c.answers = { [q.question]: c.answers![old]! };
      expect(isCeoCompletionHandoff(fingerprint(c))).toBe(false);
      expect(pickCeoCompletionHandoff(pending(c))).toBeNull();
    }
  });
  test('the retained pending Exit and report still require fresh substantive decisions', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-u-handoff-')); const file = path.join(dir, 'plan.md');
    try {
      fs.writeFileSync(file, uHandoff.reportContent);
      fs.utimesSync(file, uHandoff.reportAtMs / 1000, uHandoff.reportAtMs / 1000);
      const calls = structuredClone(uHandoff.calls) as NativePlanQuestionCall[];
      const transcript = { status: 'ready' as const, calls, assistantMessages: [], planReadyRequests: [{
        sessionId: uHandoff.pendingExit.sessionId, toolUseId: uHandoff.pendingExit.toolUseId,
        timestamp: uHandoff.pendingExit.timestamp, failed: false, source: 'pre_tool_use' as const,
      }] };
      const admin = new Set(calls.filter(c => isCeoCompletionHandoff(fingerprint(c))).map(c => `${c.sessionId}:${c.toolUseId}`));
      expect(hasNativePlanTerminal(transcript, file, uHandoff.startedAtMs, 'plan_ready')).toBe(false);
      expect(hasNativePlanTerminal(transcript, file, uHandoff.startedAtMs, 'plan_ready', admin)).toBe(true);
      transcript.planReadyRequests[0]!.failed = true;
      expect(hasNativePlanTerminal(transcript, file, uHandoff.startedAtMs, 'plan_ready', admin)).toBe(false);
      transcript.planReadyRequests[0]!.failed = false;
      transcript.planReadyRequests[0]!.sessionId = 'foreign-session';
      expect(hasNativePlanTerminal(transcript, file, uHandoff.startedAtMs, 'plan_ready', admin)).toBe(false);
      transcript.planReadyRequests[0]!.sessionId = uHandoff.pendingExit.sessionId;
      calls[3]!.answeredAt = new Date(uHandoff.reportAtMs + 1000).toISOString();
      expect(hasNativePlanTerminal(transcript, file, uHandoff.startedAtMs, 'plan_ready', admin)).toBe(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('T completed CEO next-review navigation', () => {
  const captured = () => structuredClone(tHandoff.calls.at(-1)!) as NativePlanQuestionCall;
  const pending = (call: NativePlanQuestionCall) => {
    const copy = structuredClone(call); copy.answered = false; delete copy.answers; delete copy.unansweredQuestionIndices;
    return fingerprint(copy);
  };
  test('the actual nine-call stream retains five issues and selects the offered manual stop', () => {
    const calls = structuredClone(tHandoff.calls) as NativePlanQuestionCall[];
    expect(replay(calls, false, ceoFirstReviewAUQ)).toMatchObject({ step0Count: 3, reviewCount: 5, administrativeCount: 1 });
    expect(isCeoCompletionHandoff(fingerprint(captured()))).toBe(true);
    expect(pickCeoCompletionHandoff(pending(captured())) ?? 1).toBe(2);
    expect(calls).toEqual(tHandoff.calls);
  });
  test('native identity, completed answer and real option order remain required', () => {
    const call = captured(); call.questions[0]!.options.reverse();
    expect(pickCeoCompletionHandoff(pending(call))).toBe(1);
    expect(pickCeoCompletionHandoff(fingerprint(call))).toBeNull();
    expect(pickCeoCompletionHandoff({ ...pending(call), signature: 'foreign:call' })).toBeNull();
    expect(pickCeoCompletionHandoff({ ...pending(call), nativeCall: undefined })).toBeNull();
    for (const mutate of [
      (c: NativePlanQuestionCall) => { c.failed = true; },
      (c: NativePlanQuestionCall) => { c.answered = false; },
      (c: NativePlanQuestionCall) => { c.unansweredQuestionIndices = [0]; },
      (c: NativePlanQuestionCall) => { delete c.unansweredQuestionIndices; },
      (c: NativePlanQuestionCall) => { c.answers = { [c.questions[0]!.question]: 'Fix one more issue first' }; },
    ]) { const c = captured(); mutate(c); expect(isCeoCompletionHandoff(fingerprint(c))).toBe(false); }
  });
  test('unfinished, conditional, quoted and additional-work descriptions remain substantive', () => {
    for (const extra of [
      'Delete the failing regression test before Eng.', 'Remove the owner check before Eng.',
      'Change the guarantee to permit old results.', 'Rewrite the acceptance criteria before shipping.',
      'Repair the missing authorization test.', 'We may repair the missing authorization test.',
      'All findings become resolved after the tests pass.', 'There is an outstanding authorization gap.',
      'Should we add another test before Eng?',
    ]) {
      const c = captured(); c.questions[0]!.options[1]!.description += ' ' + extra;
      expect(isCeoCompletionHandoff(fingerprint(c))).toBe(false);
      expect(pickCeoCompletionHandoff(pending(c))).toBeNull();
    }
    for (const replacement of ['resolved some findings', 'did not resolve all findings', 'will resolve all findings after tests pass']) {
      const c = captured(); c.questions[0]!.options[1]!.description = c.questions[0]!.options[1]!.description!.replace('resolved all findings', replacement);
      expect(isCeoCompletionHandoff(fingerprint(c))).toBe(false);
    }
    for (const prefix of ['> ', '```text\n', 'Example: ']) {
      const c = captured(); c.questions[0]!.options[1]!.description = prefix + c.questions[0]!.options[1]!.description;
      expect(isCeoCompletionHandoff(fingerprint(c))).toBe(false);
    }
    for (const mutate of [
      (c: NativePlanQuestionCall) => { c.questions[0]!.question = 'Should we fix the missing authorization check?'; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.header = 'Authorization gap'; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.question += ' <gstack-qid:ceo-security-finding>'; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.options[1]!.label = 'Repair authorization before Eng'; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.options.push({ label: 'Add a new TODO' }); },
    ]) { const c = captured(); mutate(c); expect(isCeoCompletionHandoff(fingerprint(c))).toBe(false); expect(pickCeoCompletionHandoff(pending(c))).toBeNull(); }
  });
  test('the retained pending Exit and report still require fresh substantive decisions', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-t-handoff-')); const file = path.join(dir, 'plan.md');
    try {
      fs.writeFileSync(file, tHandoff.reportContent);
      fs.utimesSync(file, tHandoff.reportAtMs / 1000, tHandoff.reportAtMs / 1000);
      const calls = structuredClone(tHandoff.calls) as NativePlanQuestionCall[];
      const transcript = { status: 'ready' as const, calls, assistantMessages: [], planReadyRequests: [{
        sessionId: tHandoff.pendingExit.sessionId, toolUseId: tHandoff.pendingExit.toolUseId,
        timestamp: tHandoff.pendingExit.timestamp, failed: false, source: 'pre_tool_use' as const,
      }] };
      const admin = new Set(calls.filter(c => isCeoCompletionHandoff(fingerprint(c))).map(c => `${c.sessionId}:${c.toolUseId}`));
      expect(hasNativePlanTerminal(transcript, file, tHandoff.startedAtMs, 'plan_ready')).toBe(false);
      expect(hasNativePlanTerminal(transcript, file, tHandoff.startedAtMs, 'plan_ready', admin)).toBe(true);
      transcript.planReadyRequests[0]!.failed = true;
      expect(hasNativePlanTerminal(transcript, file, tHandoff.startedAtMs, 'plan_ready', admin)).toBe(false);
      transcript.planReadyRequests[0]!.failed = false;
      transcript.planReadyRequests[0]!.sessionId = 'foreign-session';
      expect(hasNativePlanTerminal(transcript, file, tHandoff.startedAtMs, 'plan_ready', admin)).toBe(false);
      transcript.planReadyRequests[0]!.sessionId = tHandoff.pendingExit.sessionId;
      calls[3]!.answeredAt = new Date(tHandoff.reportAtMs + 1000).toISOString();
      expect(hasNativePlanTerminal(transcript, file, tHandoff.startedAtMs, 'plan_ready', admin)).toBe(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('native direct Eng/manual handoff with described CEO closure', () => {
  const captured = () => structuredClone(rCalls.at(-1)!) as NativePlanQuestionCall;
  const pending = (call: NativePlanQuestionCall) => {
    const copy = structuredClone(call); copy.answered = false; delete copy.answers;
    delete copy.unansweredQuestionIndices;
    return fingerprint(copy);
  };
  test('actual R calls retain zero findings and choose offered manual instead of starting Eng', () => {
    const calls = structuredClone(rCalls) as NativePlanQuestionCall[];
    expect(replay(calls, false, ceoFirstReviewAUQ)).toMatchObject({ step0Count: 3, reviewCount: 0, administrativeCount: 1, reviewStarted: true });
    expect(replay(calls, false, ceoFirstReviewAUQ).reviewCount).toBeLessThan(2); // Existing paired floor still fails.
    expect(isCeoCompletionHandoff(fingerprint(captured()))).toBe(true);
    expect(pickCeoCompletionHandoff(pending(captured())) ?? 1).toBe(2);
    expect(calls).toEqual(rCalls);
  });
  test('manual choice follows real option order and still requires pending native identity', () => {
    const call = captured(); call.questions[0]!.options.reverse();
    expect(pickCeoCompletionHandoff(pending(call))).toBe(1);
    expect(pickCeoCompletionHandoff(fingerprint(call))).toBeNull();
    expect(pickCeoCompletionHandoff({ ...pending(call), signature: 'foreign-call' })).toBeNull();
    expect(pickCeoCompletionHandoff({ ...pending(call), nativeCall: undefined })).toBeNull();
    call.failed = true;
    expect(pickCeoCompletionHandoff(pending(call))).toBeNull();
  });
  test('same native menu retains every incomplete, conditional, quoted or substantive obligation', () => {
    const changes: Array<(c: NativePlanQuestionCall) => void> = [
      c => { c.questions[0]!.question = 'Should we fix the missing authorization test before the next review?'; },
      c => { c.questions[0]!.question += ' First repair the missing assertion.'; },
      c => { c.questions[0]!.question = 'The review did not finish. ' + c.questions[0]!.question; },
      c => { c.questions[0]!.header = 'Authorization gap'; },
      c => { c.questions[0]!.question += ' <gstack-qid:ceo-security-finding>'; },
      c => { c.questions[0]!.options[1]!.label = 'Skip'; },
      c => { c.questions[0]!.options[1]!.label = 'Repair authorization before Eng'; },
      c => { c.questions[0]!.options.push({ ...c.questions[0]!.options[1]! }); },
      c => { c.questions[0]!.options.push({ label: 'Run /plan-design-review' }); },
      c => { c.questions[0]!.options[1]!.description = 'The CEO review is not clear.'; },
      c => { c.questions[0]!.options[1]!.description = 'The CEO review remains incomplete.'; },
      c => { c.questions[0]!.options[1]!.description = 'The CEO review is clear once tests pass.'; },
      c => { c.questions[0]!.options[1]!.description = 'Once tests pass, the CEO review will be clear.'; },
      c => { c.questions[0]!.options[1]!.description += ' All findings become resolved after tests pass.'; },
      c => { c.questions[0]!.options[1]!.description += ' The contrast gap remains unresolved.'; },
      c => { c.questions[0]!.options[1]!.description += ' Not all decisions are resolved.'; },
      c => { c.questions[0]!.options[1]!.description += ' Repair the missing authorization test.'; },
      c => { c.questions[0]!.options[1]!.description += ' Recommendation: repair the missing assertion.'; },
      c => { c.questions[0]!.options[1]!.description += ' We may repair the missing assertion.'; },
      c => { c.questions[0]!.options[1]!.description += ' We must add the authorization test.'; },
      c => { c.questions[0]!.options[1]!.description += ' Delete the failing regression test before Eng.'; },
      c => { c.questions[0]!.options[1]!.description += ' Remove the owner check before Eng.'; },
      c => { c.questions[0]!.options[1]!.description += ' Change the guarantee to permit old results.'; },
      c => { c.questions[0]!.options[1]!.description += ' Rewrite the acceptance criteria before shipping.'; },
      c => { c.questions[0]!.options[1]!.description += ' Do you want me to fix the missing test?'; },
      c => { c.questions[0]!.options[1]!.description = 'Example: The CEO review is clear.'; },
      c => { c.questions[0]!.options[1]!.description = '> The CEO review is clear.'; },
      c => { c.questions[0]!.options[1]!.description = '```text\nThe CEO review is clear.'; },
    ];
    for (const change of changes) {
      const call = captured(); change(call);
      call.answers = { [call.questions[0]!.question]: call.questions[0]!.options[0]!.label };
      expect(isCeoCompletionHandoff(fingerprint(call))).toBe(false);
      expect(pickCeoCompletionHandoff(pending(call))).toBeNull();
    }
  });
  test('an unconditional completed recap permits next Eng sequencing but no failed or free-form answer', () => {
    const call = captured();
    call.questions[0]!.options[1]!.description = 'The CEO review is complete. Run /plan-eng-review after implementation and before shipping.';
    expect(isCeoCompletionHandoff(fingerprint(call))).toBe(true);
    expect(pickCeoCompletionHandoff(pending(call))).toBe(2);
    call.answers = { [call.questions[0]!.question]: 'First fix the missing receipt assertion' };
    expect(isCeoCompletionHandoff(fingerprint(call))).toBe(false);
    call.answers = { [call.questions[0]!.question]: call.questions[0]!.options[0]!.label };
    call.unansweredQuestionIndices = [0];
    expect(isCeoCompletionHandoff(fingerprint(call))).toBe(false);
  });
});

function replay(calls: NativePlanQuestionCall[], reviewStarted = true, firstReview = (_fp: ReturnType<typeof fingerprint>) => true) {
  const counts = { step0Count: 0, reviewCount: 0, administrativeCount: 0 };
  const classifications = [];
  for (const call of calls) {
    const fp = fingerprint(call);
    const phase = planCountQuestionPhase(fp, reviewStarted, ceoStep0Boundary,
      // A completion summary can mention defects; even a broad positive
      // first-finding predicate must not promote a handoff into coverage.
      firstReview, undefined, isCeoCompletionHandoff);
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


describe('native CEO completed handoffs with deferred implementation', () => {
  test('captured full sessions keep all substantive questions and classify only the final handoff', () => {
    for (const scenario of kHandoffs.cases) {
      const calls = structuredClone(scenario.calls) as NativePlanQuestionCall[];
      const original = structuredClone(calls);
      const result = replay(calls, false, ceoFirstReviewAUQ);
      expect(result).toMatchObject({ step0Count: scenario.expectedSetupCount,
        reviewCount: scenario.expectedReviewCount, administrativeCount: 1 });
      expect(result.classifications.slice(0, -1).every(p => !p.administrative)).toBe(true);
      expect(calls).toEqual(original);
    }
  });

  test('active native handoffs choose manual in either order, never implementation or another review', () => {
    for (const scenario of kHandoffs.cases) for (const reverse of [false, true]) {
      const call = structuredClone(scenario.calls.at(-1)!) as NativePlanQuestionCall;
      call.answered = false; delete call.answers; delete call.unansweredQuestionIndices;
      const q = call.questions[0]!;
      if (reverse) q.options.reverse();
      const options = q.options.map((option, i) => `${i === 0 ? '❯' : ' '} ${i + 1}. ${option.label}`).join('\n');
      const screen = `☐ ${q.header}\n${q.question}\n${options}\nEnter to select · ↑/↓ to navigate · Esc to cancel`;
      const bound = capturePlanCountQuestion(screen, new Set(), 0, false, call)!;
      expect(bound.nativeCall?.toolUseId).toBe(call.toolUseId);
      expect(pickCeoCompletionHandoff(fingerprint(call), bound)).toBe(q.options.findIndex(o => /handle.*manually/i.test(o.label)) + 1);
      expect(isCeoCompletionHandoff(bound)).toBe(false);
      const uiOnly = capturePlanCountQuestion(screen, new Set(), 0, false)!;
      expect(pickCeoCompletionHandoff(uiOnly)).toBeNull();
    }
  });

  test('conditional declarations and new implementation obligations remain substantive', () => {
    for (const scenario of kHandoffs.cases) for (const question of [
      'ELI10: If the CEO review is done and the plan is cleared, choose the next step.',
      'ELI10: The CEO review is done only after resolving the test gap.',
      'ELI10: The CEO review is done and the plan is cleared after you add retry tests.',
      'ELI10: The CEO review is not done and the plan is not cleared.',
    ]) {
      const call = structuredClone(scenario.calls.at(-1)!) as NativePlanQuestionCall;
      call.questions[0]!.question = question + ' The required shipping gate is an Eng Review.';
      call.answers = { [call.questions[0]!.question]: call.questions[0]!.options[0]!.label };
      expect(isCeoCompletionHandoff(fingerprint(call))).toBe(false);
    }
    for (const option of [
      { label: 'Implement now, eng review later', description: 'Add the missing receipt test, then implement.' },
      { label: 'Implement now, eng review later', description: 'Implement the approved tasks and add a new receipt assertion before the next review.' },
      { label: 'Implement now, eng review later', description: 'The plan has no approved tasks; decide the missing error contract during implementation.' },
      { label: 'Implement new retry behavior now, eng review later', description: 'The plan already has approved tasks.' },
      { label: 'Add another TODO before implementing', description: 'Use the approved plan.' },
    ]) {
      const call = structuredClone(kHandoffs.cases[0]!.calls.at(-1)!) as NativePlanQuestionCall;
      call.questions[0]!.options[1] = option;
      expect(isCeoCompletionHandoff(fingerprint(call))).toBe(false);
      call.answered = false;
      expect(pickCeoCompletionHandoff(fingerprint(call))).toBeNull();
    }
  });

  test('a real native approval after the completed report still requires all substantive answers in that report', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-k-handoff-'));
    const file = path.join(dir, 'plan.md');
    try {
      for (const scenario of kHandoffs.cases) {
        fs.writeFileSync(file, '# Plan\n\n## GSTACK REVIEW REPORT\n\n' +
          '| Review | Runs | Status | Findings |\n|---|---|---|---|\n| CEO | 1 | COMPLETE | 4 |\n\n' +
          'VERDICT: CEO CLEARED\n\nNO UNRESOLVED DECISIONS\n');
        fs.utimesSync(file, scenario.reportAtMs / 1000, scenario.reportAtMs / 1000);
        const calls = structuredClone(scenario.calls) as NativePlanQuestionCall[];
        const transcript = { status: 'ready' as const, calls, assistantMessages: [],
          planReadyRequests: structuredClone(scenario.planReadyRequests) };
        const admin = new Set(calls.filter(c => isCeoCompletionHandoff(fingerprint(c))).map(c => `${c.sessionId}:${c.toolUseId}`));
        const startedAt = Date.parse('2026-09-08T22:17:54Z');
        expect(admin.size).toBe(1);
        expect(hasNativePlanTerminal(transcript, file, startedAt, 'plan_ready')).toBe(false);
        expect(hasNativePlanTerminal(transcript, file, startedAt, 'plan_ready', admin)).toBe(true);
        transcript.planReadyRequests[0]!.failed = true;
        expect(hasNativePlanTerminal(transcript, file, startedAt, 'plan_ready', admin)).toBe(false);
        transcript.planReadyRequests[0]!.failed = false;
        calls.splice(-1, 0, { ...structuredClone(calls[2]!), toolUseId: 'new-substantive-answer',
          answeredAt: new Date(scenario.reportAtMs + 1000).toISOString() });
        expect(hasNativePlanTerminal(transcript, file, startedAt, 'plan_ready', admin)).toBe(false);
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
