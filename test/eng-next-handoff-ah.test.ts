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

function maintenanceRecap() {
  const make = (id: string, header: string, text: string, selected: string, description: string): NativePlanQuestionCall => ({
    sessionId:'maintenance-session', toolUseId:id, questions:[{header,question:text,multiSelect:false,
      options:[{label:selected,description},{label:'Skip',description:'Do not approve this action.'}]}],
    answered:true, failed:false, answers:{[text]:selected}, unansweredQuestionIndices:[], answeredAt:'2026-09-11T00:00:01Z',
  });
  const routing = make('routing','Routing',"Add gstack skill routing rules to CLAUDE.md?",'Add routing rules to CLAUDE.md (recommended)','Append the routing rules after review.');
  const policy = make('policy','TODO 1','D7 — TODO 1: RetryPolicy needs a follow-up.','7A) Add to TODOS.md (recommended)',"Captured in the plan's TODOS section now; write it after exit.");
  const cleanup = make('cleanup','TODO 2','D8 — TODO 2: Remove LegacyBridge after rollout.','8A) Add to TODOS.md (recommended)',"Captured in the plan's TODOS section now; write it after exit.");
  const next = make('next','Next step','D9 — Next steps. Eng review is CLEARED. There is no UI scope. CEO review is optional. What next?',
    'Ready to implement — run /ship when done (recommended)','Exit plan mode with the reviewed plan. Post-exit: append routing rules to CLAUDE.md and create TODOS.md with the two accepted items.');
  next.answeredAt='2026-09-11T00:00:02Z'; next.questions[0]!.options[1]={label:'Run /plan-ceo-review',description:'Optional strategy review.'};
  return {next, prior:[routing,policy,cleanup], plan:'## TODOS\n### Revisit RetryPolicy\nAn approved follow-up.\n### Remove LegacyBridge\nAfter rollout.\n## Implementation Tasks\n'};
}
test('completed navigation can recap earlier approved routing and published TODOs', () => {
  const a=maintenanceRecap(), check=(x= a)=>isEngCompletionHandoff(fp(x.next),x.plan,x.prior);
  expect(check()).toBe(true);
  const renamed=structuredClone(a); renamed.plan=renamed.plan.replaceAll('RetryPolicy','TenantPolicy');
  question(renamed.prior[1]!,s=>s.replaceAll('RetryPolicy','TenantPolicy')); expect(check(renamed)).toBe(true);
  const reworded=structuredClone(a);question(reworded.next,s=>s.replace('D9 — Next steps. Eng review is CLEARED','D14: Next step: Engineering review is complete'));
  reworded.next.questions[0]!.header='Next steps';reworded.next.questions[0]!.options[0]!.description='Exit plan mode with the reviewed plan. After exiting: write TODOS.md with 2 accepted items; add gstack routing rules to CLAUDE.md.';
  expect(check(reworded)).toBe(true);
  const batched=structuredClone(a);batched.prior[1]!.questions.push(...batched.prior[2]!.questions);
  Object.assign(batched.prior[1]!.answers,batched.prior[2]!.answers);batched.prior.pop();expect(check(batched)).toBe(true);
  for(const mutate of [
    (x:typeof a)=>{x.prior.shift();},
    (x:typeof a)=>{x.prior[0]!.sessionId='foreign';},
    (x:typeof a)=>{x.prior[0]!.failed=true;},
    (x:typeof a)=>{x.prior[0]!.answeredAt=x.next.answeredAt;},
    (x:typeof a)=>{x.prior[0]!.unansweredQuestionIndices=[0];},
    (x:typeof a)=>{x.prior.push(structuredClone(x.prior[0]!));},
    (x:typeof a)=>{x.prior[0]!.questions[0]!.options[1]=structuredClone(x.prior[0]!.questions[0]!.options[0]!);},
    (x:typeof a)=>{const revoked=structuredClone(x.prior[0]!);revoked.toolUseId='revoked';revoked.answers![revoked.questions[0]!.question]='Skip';x.prior.push(revoked);},
    (x:typeof a)=>{x.prior[1]!.answers![x.prior[1]!.questions[0]!.question]='Skip';},
    (x:typeof a)=>{x.prior[1]!.questions[0]!.options[0]!.description='A new proposed TODO.';},
    (x:typeof a)=>{question(x.prior[1]!,s=>s+' This approval is withdrawn.');},
    (x:typeof a)=>{question(x.next,s=>'Example: '+s);},
    (x:typeof a)=>{question(x.next,s=>s+' This review is cancelled.');},
    (x:typeof a)=>{question(x.next,s=>s.replace('is CLEARED','will be CLEARED'));},
    (x:typeof a)=>{question(x.next,s=>s+' Only if more tests pass.');},
    (x:typeof a)=>{x.next.questions[0]!.options[0]!.description+=' Add another requirement.';},
    (x:typeof a)=>{x.next.questions[0]!.options[0]!.description=x.next.questions[0]!.options[0]!.description!.replace('two','three');},
    (x:typeof a)=>{x.plan=x.plan.replace('## TODOS','## Historical TODOs');},
    (x:typeof a)=>{x.plan=x.plan.replace('RetryPolicy','OtherPolicy');},
    (x:typeof a)=>{x.plan=x.plan.replace('An approved follow-up.','This TODO is withdrawn.');},
    (x:typeof a)=>{x.plan='```md\n'+x.plan+'\n```';},
  ]){const x=structuredClone(a);mutate(x);expect(check(x)).toBe(false);}
  expect(isEngCompletionHandoff(fp(a.next),a.plan)).toBe(false);
});
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
