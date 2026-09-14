import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hasNativePlanTerminal } from './helpers/claude-pty-runner';
import type { NativePlanQuestionCall, PlanCountTranscript } from './helpers/plan-count-transcript';
import fixture from './fixtures/devex-handoff-o-call.json';

function replay(mutate?: (call: NativePlanQuestionCall, transcript: PlanCountTranscript) => void): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-native-handoff-'));
  const report = path.join(dir, 'review.md');
  const transcript = structuredClone(fixture.transcript) as PlanCountTranscript;
  const call = transcript.calls.at(-1)!;
  mutate?.(call, transcript);
  fs.writeFileSync(report, fixture.report);
  const writtenAt = Date.parse(fixture.reportWrite.resultAt);
  fs.utimesSync(report, writtenAt / 1000, writtenAt / 1000);
  try {
    return hasNativePlanTerminal(transcript, report,
      Date.parse(fixture.startedAt), 'plan_ready');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('actual completed DX navigation preserves the prior full report and all thirteen native calls', () => {
  expect(fixture.transcript.calls).toHaveLength(13);
  expect(fixture.transcript.calls.every(call => call.answered && !call.failed)).toBe(true);
  expect(fixture.reportWrite.failed).toBe(false);
  expect(replay()).toBe(true);
});

test('closed navigation cannot hide a real new issue, unfinished review, or conditional closure', () => {
  const variants = [
    (q: any) => { q.header = 'New finding'; },
    (q: any) => { q.question = q.question.replace('D11 — What next?', 'D11 — Should we fix the missing authorization check?'); },
    (q: any) => { q.question = q.question.replace('The DX review is done.', 'The DX review is not done.'); },
    (q: any) => { q.question = q.question.replace('The DX review is done.', 'The DX review is done only after tests pass.'); },
    (q: any) => { q.question += '\nOne documentation gap remains unresolved.'; },
    (q: any) => { q.question += '\nPlease fix the missing authorization check first.'; },
    (q: any) => { q.question += '\nShould we add the missing test?'; },
    (q: any) => { q.question += '\nOnce the tests pass, the DX review will be complete.'; },
    (q: any) => { q.question += '\nAll decisions resolved after tests pass.'; },
    (q: any) => { q.question += '\nDX review complete after tests pass.'; },
    (q: any) => { q.question += '\nWe could fix the missing authorization check before Eng.'; },
    (q: any) => { q.question = q.question.replace('ELI10: The DX review is done.', '```text\nThe DX review is done.\n```'); },
    (q: any) => { q.question = q.question.replace('ELI10: The DX review is done.', '```text\nThe DX review is done.'); },
    (q: any) => { q.question = q.question.replace('ELI10: The DX review is done.', '> The DX review is done.'); },
    (q: any) => { q.options[2].description = 'Proceed to fix the missing contrast test before Eng.'; },
    (q: any) => { q.options[2].description = 'One issue remains unresolved; handle it manually.'; },
    (q: any) => { q.options[2].label = 'C) Add the missing test'; },
    (q: any) => { q.options.push({ label: 'D) Add a migration guide', description: 'A new required deliverable.' }); },
    (q: any) => { q.question = q.question.replace('plan-devex-review-next-steps', 'plan-devex-review-new-issue'); },
    (q: any) => { q.question += '\n<gstack-qid:broken'; },
    (q: any) => { q.multiSelect = true; },
  ];
  for (const mutate of variants) {
    expect(replay(call => {
      const question = call.questions[0]!;
      mutate(question);
      // Keep a real offered answer after text mutations so the semantic guard,
      // rather than a stale answer key, is what must reject the altered call.
      call.answers = { [question.question]: question.options[0]!.label };
    }), String(mutate)).toBe(false);
  }
});

test('native failure, offered answer, report freshness and real Exit remain required', () => {
  expect(replay(call => { call.answered = false; })).toBe(false);
  expect(replay(call => { call.failed = true; })).toBe(false);
  expect(replay(call => { call.unansweredQuestionIndices = [0]; })).toBe(false);
  expect(replay(call => { call.answers = { [call.questions[0]!.question]: 'Add a new test first' }; })).toBe(false);
  expect(replay((_call, transcript) => { transcript.planReadyRequests = []; })).toBe(false);
  expect(replay((_call, transcript) => { transcript.planReadyRequests![0]!.failed = true; })).toBe(false);
  expect(replay((_call, transcript) => { transcript.planReadyRequests![0]!.sessionId = 'foreign'; })).toBe(false);
  expect(replay((_call, transcript) => {
    transcript.calls[11]!.answeredAt = new Date(Date.parse(fixture.reportWrite.resultAt) + 1000).toISOString();
  })).toBe(false);
});

test('pure navigation preserves actual option order and ordinary next-review sequencing', () => {
  expect(replay(call => { call.questions[0]!.options.reverse(); })).toBe(true);
  expect(replay(call => {
    const q = call.questions[0]!;
    q.options[0]!.description += ' After Eng review is complete, proceed to implementation.';
  })).toBe(true);
});
