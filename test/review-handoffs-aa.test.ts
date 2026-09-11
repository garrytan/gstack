import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ceo from './fixtures/review-handoff-aa-ceo.json';
import dx from './fixtures/review-handoff-aa-dx.json';
import { ceoFirstReviewAUQ, ceoStep0Boundary, hasNativePlanTerminal, nativePlanCallFingerprint, planCountQuestionPhase } from './helpers/claude-pty-runner';
import { isCeoCompletionHandoff, pickCeoCompletionHandoff } from './helpers/ceo-completion-handoff';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
import { isDevexReviewIssue } from './helpers/devex-count-fixture';

const fp = (call: NativePlanQuestionCall) => nativePlanCallFingerprint(call, 0, false);
const actual = (data = ceo) => structuredClone(data.calls.at(-1)!) as NativePlanQuestionCall;
const pending = (call = actual()) => { call.answered = false; delete call.answers; delete call.answeredAt; delete call.unansweredQuestionIndices; return call; };
function change(call: NativePlanQuestionCall, fn: (text: string) => string) {
  const q = call.questions[0]!, answer = call.answers?.[q.question]; q.question = fn(q.question);
  if (answer !== undefined) call.answers = { [q.question]: answer }; return call;
}
function terminal(data: typeof ceo, mutate?: (calls: NativePlanQuestionCall[], transcript: any) => void, stale = false, onlyHandoff = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-aa-handoff-'));
  try {
    const report = path.join(dir, 'report.md'); fs.writeFileSync(report, data.report);
    const calls = structuredClone(data.calls) as NativePlanQuestionCall[];
    const mtime = Number(BigInt(data.reportOriginalMtimeNs)) / 1e9;
    fs.utimesSync(report, mtime, stale ? Date.parse(calls.at(-2)!.answeredAt!) / 1000 - 1 : mtime);
    const transcript = { status: 'ready' as const, calls: onlyHandoff ? [calls.at(-1)!] : calls, assistantMessages: [], planReadyRequests: structuredClone(data.planReadyRequests) };
    mutate?.(transcript.calls, transcript);
    const admin = new Set(transcript.calls.filter(c => isCeoCompletionHandoff(fp(c))).map(c => fp(c).signature));
    return hasNativePlanTerminal(transcript, report, data.startedAt, 'plan_ready', admin);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

describe('AA exact CEO and DX closed workflow handoffs', () => {
  test('DX preserves all five substantive native decisions and all nine raw calls', () => {
    expect(dx.calls).toHaveLength(9);
    expect(dx.calls.map(c => isDevexReviewIssue(fp(c as NativePlanQuestionCall)))).toEqual([false, false, true, true, true, true, true, false, false]);
  });
  test('CEO has one real finding; closed navigation cannot inflate the paired floor', () => {
    let started = false; const counts = { setup: 0, review: 0, admin: 0 };
    for (const c of ceo.calls) { const p = planCountQuestionPhase(fp(c as NativePlanQuestionCall), started, ceoStep0Boundary, ceoFirstReviewAUQ, undefined, isCeoCompletionHandoff); started = p.reviewStarted; counts[p.administrative ? 'admin' : p.preReview ? 'setup' : 'review']++; }
    expect(counts).toEqual({ setup: 3, review: 1, admin: 1 });
    expect(planCountQuestionPhase(fp(actual()), false, ceoStep0Boundary, ceoFirstReviewAUQ, undefined, isCeoCompletionHandoff).reviewStarted).toBe(false);
    expect(pickCeoCompletionHandoff(fp(pending()))).toBe(2);
    expect(actual().answers![actual().questions[0]!.question]).toBe('A) Run /plan-eng-review next (Recommended)');
  });
  test('both original report mtimes and actual native Exit permit terminal detection', () => {
    expect(terminal(ceo)).toBe(true); expect(terminal(dx)).toBe(true);
    for (const data of [ceo, dx]) {
      expect(terminal(data, (_, t) => { t.planReadyRequests = []; })).toBe(false);
      expect(terminal(data, (_, t) => { t.planReadyRequests[0].failed = true; })).toBe(false);
      expect(terminal(data, (_, t) => { t.planReadyRequests[0].sessionId = 'foreign'; })).toBe(false);
      expect(terminal(data, undefined, true)).toBe(false);
      expect(terminal(data, undefined, false, true)).toBe(false);
    }
  });
  test('offered choices, order and bounded numeric variation remain navigation', () => {
    for (const data of [ceo, dx]) for (let i = 0; i < data.calls.at(-1)!.questions[0]!.options.length; i++) expect(terminal(data, calls => { const c = calls.at(-1)!; c.answers = { [c.questions[0]!.question]: c.questions[0]!.options[i]!.label }; c.questions[0]!.options.reverse(); })).toBe(true);
    const c = pending(); c.questions[0]!.options.reverse(); expect(pickCeoCompletionHandoff(fp(c))).toBe(1);
    expect(terminal(dx, calls => change(calls.at(-1)!, s => s.replace(/\b5\b/g, '7').replace('4/10', '3/10')))).toBe(false); // descriptions must agree with task count
    expect(terminal(dx, calls => { const c = calls.at(-1)!; change(c, s => s.replace(/\b5\b/g, '7').replace('4/10', '3/10')); c.questions[0]!.options.forEach(o => { o.description = o.description?.replace(/\b5\b/g, '7'); }); })).toBe(true);
    expect(terminal(ceo, calls => { const c = calls.at(-1)!; c.questions[0]!.options[0]!.description = c.questions[0]!.options[0]!.description!.replace('10 minutes', '12 minutes'); })).toBe(true);
  });
  test('whole question and every description reject extra product work or conditional closure', () => {
    for (const data of [ceo, dx]) {
      for (const fn of [(s: string) => s + ' Rotate credentials.', (s: string) => s + ' Should we remove retries?', (s: string) => 'Example: ' + s, (s: string) => '> ' + s, (s: string) => '```\n' + s + '\n```', (s: string) => s.replace(/<gstack-qid:[^>]+>/, '<gstack-qid:foreign-navigation>'), (s: string) => s + ' <gstack-qid:plan-ceo-review-next-step>', (s: string) => s.replace('review is done', 'review is not done').replace('Review is complete', 'Review is complete after fixing auth')]) expect(terminal(data, calls => change(calls.at(-1)!, fn))).toBe(false);
      for (let i = 0; i < data.calls.at(-1)!.questions[0]!.options.length; i++) for (const extra of [' Also implement another cache.', ' Rotate credentials.', ' When the remaining issue is resolved.', ' Should we change the API?']) expect(terminal(data, calls => { calls.at(-1)!.questions[0]!.options[i]!.description += extra; })).toBe(false);
      expect(terminal(data, calls => { const o = calls.at(-1)!.questions[0]!.options; [o[0]!.description, o[1]!.description] = [o[1]!.description, o[0]!.description]; })).toBe(false);
      expect(terminal(data, calls => { calls.at(-1)!.questions[0]!.options[0]!.description = 'Eng review is optional.'; })).toBe(false);
    }
  });
  test('explicit successful native completion and one current offered answer are required', () => {
    const mutations: Array<(c: NativePlanQuestionCall) => void> = [c => { delete c.failed; }, c => { c.failed = true; }, c => { c.answered = false; }, c => { delete (c as any).answered; }, c => { c.sessionId = ''; }, c => { c.toolUseId = ''; }, c => { c.questions[0]!.header = 'Issue'; }, c => { c.questions[0]!.multiSelect = true; }, c => { c.questions.push(structuredClone(c.questions[0]!)); }, c => { delete c.unansweredQuestionIndices; }, c => { c.unansweredQuestionIndices = [0]; }, c => { c.answers = { [c.questions[0]!.question]: 'New repair' }; }, c => { c.answers!.foreign = 'yes'; }];
    for (const data of [ceo, dx]) for (const mutate of mutations) expect(terminal(data, calls => mutate(calls.at(-1)!))).toBe(false);
  });
  test('new CEO picker requires exact current pending identity and offered pane', () => {
    for (const mutate of [(c: NativePlanQuestionCall) => { delete c.failed; }, (c: NativePlanQuestionCall) => { delete (c as any).answered; }, (c: NativePlanQuestionCall) => { c.answers = {}; }, (c: NativePlanQuestionCall) => { c.answeredAt = '2026-09-09T13:00:00Z'; }, (c: NativePlanQuestionCall) => { c.unansweredQuestionIndices = []; }, (c: NativePlanQuestionCall) => { c.unansweredQuestionIndices = [1]; }]) { const c = pending(); mutate(c); expect(pickCeoCompletionHandoff(fp(c))).toBeNull(); }
    for (const patch of [{ signature: 'foreign:call' }, { options: [] }, { nativeQuestionIndex: 1 }]) expect(pickCeoCompletionHandoff({ ...fp(pending()), ...patch })).toBeNull();
    const c = pending(); c.unansweredQuestionIndices = [0]; expect(pickCeoCompletionHandoff(fp(c))).toBe(2);
    expect(pickCeoCompletionHandoff(fp(actual()))).toBeNull();
  });
});
