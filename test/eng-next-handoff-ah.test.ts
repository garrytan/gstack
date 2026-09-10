import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import actual from './fixtures/eng-next-handoff-ah.json';
import { isEngCompletionHandoff } from './helpers/eng-completion-handoff';
import { hasNativePlanTerminal, nativePlanCallFingerprint, planCountQuestionPhase } from './helpers/claude-pty-runner';
import type { NativePlanQuestionCall, PlanCountTranscript } from './helpers/plan-count-transcript';
import { isCurrentPlanApprovalScreen } from './helpers/plan-count-pending-exit';
import { E2E_TOUCHFILES, matchGlob } from './helpers/touchfiles';

const call = () => structuredClone(actual.fingerprint.nativeCall) as NativePlanQuestionCall;
const fp = (c = call()) => nativePlanCallFingerprint(c, 0, false);
const accepts = (c = call(), plan = actual.plan) => isEngCompletionHandoff(fp(c), plan);
function question(c: NativePlanQuestionCall, f: (s: string) => string) {
  const q = c.questions[0]!, answer = c.answers![q.question];
  q.question = f(q.question); c.answers = { [q.question]: answer! }; return c;
}

test('actual completed Next navigation is administrative and never starts review', () => {
  expect(accepts()).toBe(true);
  for (const started of [false, true]) {
    expect(planCountQuestionPhase(fp(), started, () => false, undefined, undefined,
      f => isEngCompletionHandoff(f, actual.plan))).toEqual({ preReview: false, reviewStarted: started, administrative: 'completion-handoff' });
  }
});

test('published confirmation and characterization references do not introduce work', () => {
  expect(actual.source.stat.mtimeMs).toBeLessThan(Date.parse(call().answeredAt!));
  expect(accepts(call(), actual.plan.replaceAll('P0', 'P7'))).toBe(true);
  const c = call(); c.questions[0]!.options.reverse();
  expect(accepts(c)).toBe(true);
  c.answers![c.questions[0]!.question] = c.questions[0]!.options[0]!.label;
  expect(accepts(c)).toBe(true);
  expect(accepts(call(), actual.plan.replace('  - Surfaced by: Architecture issue 3 (D7)', '  - Correction: T2 is cancelled.\n  - Surfaced by: Architecture issue 3 (D7)'))).toBe(true);
  expect(accepts(call(), actual.plan.replace('Write characterization tests for `legacyAuthFlow()` before any rewrite', 'Write characterization tests for `legacyAuthFlow()` before any rewrite\nVerify expired and revoked tokens are rejected.'))).toBe(true);
  expect(accepts(call(), actual.plan.replace('Invariants and Latency target above.', 'Invariants and Latency target above.\nKeep a record of rejected alternatives after the author confirms Context.'))).toBe(true);
});

test('incomplete, foreign, ambiguous and changed choices cannot be administrative', () => {
  for (const mutate of [
    (c: NativePlanQuestionCall) => { c.answered = false; },
    (c: NativePlanQuestionCall) => { c.failed = true; },
    (c: NativePlanQuestionCall) => { c.answeredAt = 'invalid'; },
    (c: NativePlanQuestionCall) => { c.unansweredQuestionIndices = [0]; },
    (c: NativePlanQuestionCall) => { c.answers = {}; },
    (c: NativePlanQuestionCall) => { c.answers![c.questions[0]!.question] = 'unoffered'; },
    (c: NativePlanQuestionCall) => { c.questions[0]!.multiSelect = true; },
    (c: NativePlanQuestionCall) => { c.questions.push(structuredClone(c.questions[0]!)); },
    (c: NativePlanQuestionCall) => { c.questions[0]!.options.push({ label: 'Add another requirement' }); },
    (c: NativePlanQuestionCall) => { c.questions[0]!.options[0]!.description += ' Add a new datastore first.'; },
    (c: NativePlanQuestionCall) => { c.questions[0]!.options[1]!.description = 'Change the implementation architecture first.'; },
    (c: NativePlanQuestionCall) => { c.questions[0]!.options[0]!.description = c.questions[0]!.options[0]!.description!.replace('T1', 'T99'); },
  ]) { const c = call(); mutate(c); expect(accepts(c)).toBe(false); }
  expect(isEngCompletionHandoff({ ...fp(), signature: 'foreign:call' }, actual.plan)).toBe(false);
  expect(isEngCompletionHandoff({ ...fp(), nativeQuestionIndex: 1 }, actual.plan)).toBe(false);
  expect(isEngCompletionHandoff({ ...fp(), options: [] }, actual.plan)).toBe(false);
});

test('nonasserted, prospective, conditional and reopened navigation stays substantive', () => {
  for (const text of [
    '> ', 'Example: ', 'An unproven hypothesis. ', '```text\n',
  ]) expect(accepts(question(call(), s => text + s))).toBe(false);
  for (const change of [
    (s: string) => s.replace('all required reviews are complete', 'all required reviews will be complete'),
    (s: string) => s.replace('all required reviews are complete', 'all required reviews are not complete'),
    (s: string) => s.replace('all required reviews are complete', 'all required reviews are complete if more tests pass'),
    (s: string) => s + '\nA new implementation prerequisite is required.',
    (s: string) => s.replace('Recommendation: A', 'Recommendation: C'),
  ]) expect(accepts(question(call(), change))).toBe(false);
});

test('missing, refuted or quoted published prerequisites/tasks cannot be borrowed', () => {
  for (const plan of [
    '', '```markdown\n' + actual.plan + '\n```', actual.plan.split('\n').map(s => '> ' + s).join('\n'),
    actual.plan.replace('## Context', '## Example context'),
    actual.plan.replace('Implementation does not start until the author confirms', 'Implementation starts without the author confirming'),
    actual.plan.replace('### Prerequisite P0', '### Example prerequisite P0'),
    actual.plan.replace('## Implementation Tasks', '## Historical Tasks'),
    actual.plan.replace('Write characterization tests for `legacyAuthFlow()` before any rewrite', 'Write characterization tests after rewriting `legacyAuthFlow()`'),
    actual.plan.replace('**T1 (P1', '**T99 (P1'),
    actual.plan.replace('## Context', 'Example only:\n## Context'),
    actual.plan.replace('## Implementation Tasks', 'Example only:\n## Implementation Tasks'),
    actual.plan.replace('Invariants and Latency target above.', 'Invariants and Latency target above.\nCorrection: Prerequisite P0 is cancelled; the author no longer needs to confirm Context.'),
    actual.plan.replace('Write characterization tests for `legacyAuthFlow()` before any rewrite', 'Write characterization tests for `legacyAuthFlow()` before any rewrite\nCorrection: T1 is cancelled; no characterization tests are required.'),
  ]) expect(accepts(call(), plan)).toBe(false);
});

test('exact final exit/report replay retains all freshness, identity and answer gates', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-eng-next-ah-'));
  const file = path.join(dir, 'reviewed.md');
  const now = Date.now;
  try {
    fs.writeFileSync(file, actual.plan);
    fs.utimesSync(file, actual.source.stat.mtimeMs / 1000, actual.source.stat.mtimeMs / 1000);
    Date.now = () => Date.parse(actual.captureAt);
    const t = structuredClone(actual.transcript) as PlanCountTranscript;
    const id = actual.fingerprint.signature;
    const admin = new Set(accepts() ? [id] : []);
    const check = (v = t, a = admin) => hasNativePlanTerminal(v, file, actual.startedAt, 'plan_ready', a);
    expect(isCurrentPlanApprovalScreen(actual.screen)).toBe(true);
    expect(check()).toBe(true);
    expect(check(t, new Set())).toBe(false);
    expect(check(t, new Set(['foreign:call']))).toBe(false);
    for (const mutate of [
      (v: PlanCountTranscript) => { v.planReadyRequests = []; },
      (v: PlanCountTranscript) => { v.planReadyRequests!.at(-1)!.failed = true; },
      (v: PlanCountTranscript) => { v.planReadyRequests!.at(-1)!.sessionId = 'foreign'; },
      (v: PlanCountTranscript) => { v.planReadyRequests!.at(-1)!.timestamp = '2026-09-10T03:29:40.000Z'; },
      (v: PlanCountTranscript) => { v.planReadyRequests!.at(-1)!.timestamp = new Date(Date.now() + 1).toISOString(); },
      (v: PlanCountTranscript) => { v.calls.at(-1)!.answered = false; },
      (v: PlanCountTranscript) => { v.calls.at(-2)!.answeredAt = '2026-09-10T03:29:00.000Z'; },
    ]) { const v = structuredClone(t); mutate(v); expect(check(v)).toBe(false); }
    fs.writeFileSync(file, actual.plan.replace('NO UNRESOLVED DECISIONS', 'Report still pending'));
    fs.utimesSync(file, actual.source.stat.mtimeMs / 1000, actual.source.stat.mtimeMs / 1000);
    expect(check()).toBe(false);
  } finally { Date.now = now; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('new handoff evidence belongs to its existing paid caller', () => {
  for (const file of ['test/eng-next-handoff-ah.test.ts', 'test/fixtures/eng-next-handoff-ah.json']) {
    const owners = Object.entries(E2E_TOUCHFILES).filter(([, globs]) => globs.some(glob => matchGlob(file, glob))).map(([name]) => name);
    expect(owners).toEqual(['plan-eng-finding-count']);
  }
});
