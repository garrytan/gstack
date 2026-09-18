import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import actual from './fixtures/eng-next-handoff-ah.json';
import { isEngCompletionHandoff } from './helpers/eng-completion-handoff';
import { hasNativePlanTerminal, nativePlanCallFingerprint, planCountQuestionPhase } from './helpers/claude-pty-runner';
import type { NativePlanQuestionCall, PlanCountTranscript } from './helpers/plan-count-transcript';
import { readPlanCountTranscript } from './helpers/plan-count-transcript';
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

const b176 = actual.sourceBoundB176;
const recorded = () => structuredClone(b176.transcript) as PlanCountTranscript;
const recordedCall = () => recorded().calls.at(-1)!;
const recordedPrior = () => recorded().calls.slice(0,-1);
const recordedCheck = (c=recordedCall(),plan=b176.plan,prior=recordedPrior()) =>
  isEngCompletionHandoff(nativePlanCallFingerprint(c,Date.parse(b176.capturedAt),true),plan,prior);
const changedApproval = [
 'D1 approval is revoked.',
 'This decision is reopened.',
 'Routing rules: pending approval.',
];
test.each(changedApproval)('current navigation cannot withdraw its referenced approval: %s',text=>{
 const c=recordedCall();question(c,s=>s+'\n'+text);expect(recordedCheck(c)).toBe(false);
 const option=recordedCall();option.questions[0]!.options[1]!.description+=' '+text;expect(recordedCheck(option)).toBe(false);
 const prior=recordedPrior();question(prior[0]!,s=>s+'\n'+text);expect(recordedCheck(recordedCall(),b176.plan,prior)).toBe(false);
 expect(recordedCheck(recordedCall(),b176.plan+'\n'+text)).toBe(false);
});
test.each([
 'The implementation now requires a production deployment before fixtures.',
 'Implementation needs a production deployment before fixtures.',
 'A production deployment is now required before fixtures.',
 'T2 depends on a production deployment before fixtures.',
])('current navigation cannot add an unbound declarative obligation: %s',text=>{
 const c=recordedCall();question(c,s=>s+'\n'+text);expect(recordedCheck(c)).toBe(false);
 const option=recordedCall();option.questions[0]!.options[1]!.description+=' '+text;expect(recordedCheck(option)).toBe(false);
});
test.each(['Example only:','Sample plan:','Hypothetical:','Source excerpt:'])('report evidence cannot borrow a source-introduced owner: %s',prefix=>{
 for(const heading of ['# Plan:','## GSTACK REVIEW REPORT','## Decision ledger','## Implementation Tasks','## Accepted TODOs','## Implementation order']){
  expect(b176.plan.includes(heading),heading).toBe(true);
  expect(recordedCheck(recordedCall(),b176.plan.replace(heading,prefix+'\n'+heading)),heading).toBe(false);
 }
});
test('an inactive source section cannot own or invalidate the next current sibling',()=>{
 const sample='Source excerpt:\n## Old task illustration\nD1 approval is revoked.\nT99 is an illustration.\n\n';
 expect(recordedCheck(recordedCall(),b176.plan.replace('## Implementation Tasks',sample+'## Implementation Tasks'))).toBe(true);
});
test('both maintenance forms retain the earlier native-answer cardinality and uniqueness checks',()=>{
 for(const mutate of [
  (c:NativePlanQuestionCall)=>{for(let n=0;n<5;n++){const q=structuredClone(c.questions[0]!);q.question+=' extra '+n;c.questions.push(q);c.answers![q.question]=q.options[0]!.label;}},
  (c:NativePlanQuestionCall)=>{for(let n=0;n<4;n++)c.questions[0]!.options.push({label:'Other '+n});},
  (c:NativePlanQuestionCall)=>{c.questions.push(structuredClone(c.questions[0]!));c.answers!['unowned-key']='unused';},
 ]){
  const prior=recordedPrior();mutate(prior[0]!);expect(recordedCheck(recordedCall(),b176.plan,prior)).toBe(false);
  const old=maintenanceRecap();mutate(old.prior[0]!);expect(isEngCompletionHandoff(fp(old.next),old.plan,old.prior)).toBe(false);
 }
});
test('review-discovered current changes and example evidence cannot release the pending exit',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'eng-b176-review-')),file=path.join(dir,'report.md'),now=Date.now;
 try{
  Date.now=()=>Date.parse(b176.capturedAt);
  const examples=[
   {plan:b176.plan,addition:undefined,expected:true},
   {plan:b176.plan,addition:'D1 approval is revoked.',expected:false},
   {plan:b176.plan,addition:'The implementation now requires a production deployment before fixtures.',expected:false},
   {plan:'Example only:\n'+b176.plan,addition:undefined,expected:false},
   {plan:b176.plan.replace('## Implementation Tasks','Example only:\n## Implementation Tasks'),addition:undefined,expected:false},
  ];
  for(const {plan,addition,expected} of examples){
   const t=recorded(),c=t.calls.at(-1)!;if(addition)question(c,s=>s+'\n'+addition);
   const f=nativePlanCallFingerprint(c,Date.parse(b176.capturedAt),true);
   const administrative=new Set(isEngCompletionHandoff(f,plan,t.calls.slice(0,-1))?[f.signature]:[]);
   fs.writeFileSync(file,plan);fs.utimesSync(file,b176.sourceReport.mtimeMs/1000,b176.sourceReport.mtimeMs/1000);
   expect(hasNativePlanTerminal(t,file,b176.startedAt,'plan_ready',administrative)).toBe(expected);
  }
 }finally{Date.now=now;fs.rmSync(dir,{recursive:true,force:true});}
});
test('actual b176 answered navigation recaps owned prior maintenance and the published first task',()=>{
 expect(recordedCheck()).toBe(true);
 expect(b176.originalOutcome).toBe('CANCELLED');
 expect(b176.originalD12PreReview).toBe(true);
 expect(b176.originalNativeTerminal).toBe(false);
 for(const started of [true,false])expect(planCountQuestionPhase(nativePlanCallFingerprint(recordedCall(),Date.parse(b176.capturedAt),true),started,()=>false,undefined,undefined,
  f=>isEngCompletionHandoff(f,b176.plan,recordedPrior()))).toEqual({preReview:false,reviewStarted:started,administrative:'completion-handoff'});
});
test('recorded navigation is keyed by current references, not the observed numbering or optional label',()=>{
 const c=recordedCall();c.questions[0]!.options[1]!.label='Run /plan-ceo-review (optional)';expect(recordedCheck(c)).toBe(true);
 const renamed=JSON.parse(JSON.stringify({c:recordedCall(),plan:b176.plan,prior:recordedPrior()}).replaceAll('D10','D20').replaceAll('D11','D21'));
 expect(recordedCheck(renamed.c,renamed.plan,renamed.prior)).toBe(true);
 const wording=recordedCall();question(wording,s=>s.replace('engineering review is done','engineering review is complete').replace('every finding has an approved fix','all decisions are settled'));
 wording.questions[0]!.options[0]!.description=wording.questions[0]!.options[0]!.description!.replace('start with','begin with').replace('then write','then create');
 expect(recordedCheck(wording)).toBe(true);
});
test.each(['missing-answer','failed','pending-tab','unoffered','future','bad-clock','wrong-fingerprint','wrong-option','extra-question','extra-option','ceo-selected'])('recorded handoff rejects incomplete or conflicting native state: %s',kind=>{
 const c=recordedCall();
 if(kind==='missing-answer'){c.answered=false;c.answers={};}
 if(kind==='failed')c.failed=true;
 if(kind==='pending-tab')c.unansweredQuestionIndices=[0];
 if(kind==='unoffered')c.answers![c.questions[0]!.question]='Unstated route';
 if(kind==='future')c.answeredAt=new Date(Date.now()+60_000).toISOString();
 if(kind==='bad-clock')c.answeredAt='invalid';
 if(kind==='extra-question')c.questions.push(structuredClone(c.questions[0]!));
 if(kind==='extra-option')c.questions[0]!.options.push({label:'Add Redis',description:'New work.'});
 if(kind==='ceo-selected')c.answers![c.questions[0]!.question]=c.questions[0]!.options[1]!.label;
 const f=nativePlanCallFingerprint(c,Date.parse(b176.capturedAt),true);
 if(kind==='wrong-fingerprint')f.signature='foreign:call';
 if(kind==='wrong-option')f.options[0]!.label='Other route';
 expect(isEngCompletionHandoff(f,b176.plan,recordedPrior())).toBe(false);
});
test.each(['future-review','negative-review','conditional-review','historical','quoted','revoked-review','unapproved-finding','new-command','quoted-command','new-prerequisite','unknown-task','wrong-first-task','unapproved-routing','unapproved-todo'])('recorded next-step content cannot hide new or incomplete work: %s',kind=>{
 const c=recordedCall();
 if(kind==='future-review')question(c,s=>s.replace('engineering review is done','engineering review will be done'));
 if(kind==='negative-review')question(c,s=>s.replace('engineering review is done','engineering review is not done'));
 if(kind==='conditional-review')question(c,s=>s.replace('engineering review is done','engineering review is done if new tests pass'));
 if(kind==='historical')question(c,s=>'Historical: '+s);
 if(kind==='quoted')question(c,s=>'> '+s);
 if(kind==='revoked-review')question(c,s=>s+'\nThe engineering review is reopened.');
 if(kind==='unapproved-finding')question(c,s=>s.replace('every finding has an approved fix','not every finding has an approved fix'));
 if(kind==='new-command')question(c,s=>s+'\nThen add a new datastore.');
 if(kind==='quoted-command')c.questions[0]!.options[1]!.description+=' Also "deploy production now".';
 if(kind==='new-prerequisite')question(c,s=>s+'\nA new prerequisite is required before implementation.');
 if(kind==='unknown-task')question(c,s=>s.replace('T1–T9','T1–T99'));
 if(kind==='wrong-first-task')c.questions[0]!.options[0]!.description=c.questions[0]!.options[0]!.description!.replace('T1 fixtures','T2 fixtures');
 if(kind==='unapproved-routing')c.questions[0]!.options[0]!.description=c.questions[0]!.options[0]!.description!.replace('(D1)','(D2)');
 if(kind==='unapproved-todo')c.questions[0]!.options[0]!.description=c.questions[0]!.options[0]!.description!.replace('D10/D11','D10/D99');
 expect(recordedCheck(c),kind).toBe(false);
});
test.each(['missing-routing','missing-todo','failed-answer','foreign-session','future-answer','duplicate-answer','declined-todo','declined-routing','foreign-source','changed-remedy','withdrawn'])('recorded maintenance remains bound to complete earlier approvals: %s',kind=>{
 const prior=recordedPrior();
 if(kind==='missing-routing')prior.shift();
 if(kind==='missing-todo')prior.pop();
 if(kind==='failed-answer')prior.at(-1)!.failed=true;
 if(kind==='foreign-session')prior.at(-1)!.sessionId='foreign';
 if(kind==='future-answer')prior.at(-1)!.answeredAt=recordedCall().answeredAt;
 if(kind==='duplicate-answer')prior.push(structuredClone(prior[0]!));
 if(kind==='declined-todo')prior.at(-1)!.answers![prior.at(-1)!.questions[0]!.question]='Skip — not valuable enough';
 if(kind==='declined-routing')prior[0]!.answers![prior[0]!.questions[0]!.question]="No thanks, I'll invoke skills manually";
 if(kind==='foreign-source')question(prior.at(-1)!,s=>s.replace('PLAN.md','FOREIGN.md'));
 if(kind==='changed-remedy'){const c=prior.find(c=>c.questions[0]!.header==='Wiring')!;c.answers![c.questions[0]!.question]=c.questions[0]!.options[1]!.label;}
 if(kind==='withdrawn')question(prior.at(-1)!,s=>s+'\nThis decision is withdrawn.');
 expect(recordedCheck(recordedCall(),b176.plan,prior),kind).toBe(false);
});
test.each(['foreign-title','foreign-project','foreign-branch','foreign-source','archived','quoted','fenced','duplicate-owner','pending-remedy','changed-answer','missing-todo','wrong-todo-count','missing-task','changed-first-task','late-first-task','incomplete-report','negative-report'])('recorded handoff cannot borrow a foreign or incomplete report: %s',kind=>{
 let plan=b176.plan;
 if(kind==='foreign-title')plan=plan.replaceAll('Multi-tenant Auth Refactor','Different refactor');
 if(kind==='foreign-project')plan=plan.replace('gstack-plan-count-G18mVB','foreign-project');
 if(kind==='foreign-branch')plan=plan.replace('branch main,','branch foreign,');
 if(kind==='foreign-source')plan=plan.replace('Reviewed target: PLAN.md','Reviewed target: FOREIGN.md');
 if(kind==='archived')plan='# Archived\n'+plan.replace(/^# /gm,'## ').replace(/^## /gm,'### ');
 if(kind==='quoted')plan=plan.split('\n').map(line=>'> '+line).join('\n');
 if(kind==='fenced')plan='```md\n'+plan+'\n```';
 if(kind==='duplicate-owner')plan+=plan.split('\n').find(line=>line.startsWith('<!-- Reviewed target:'));
 if(kind==='pending-remedy')plan=plan.replace('State: approved','State: pending');
 if(kind==='changed-answer')plan=plan.replace('Actual answer: A — D7','Actual answer: B — D7');
 if(kind==='missing-todo')plan=plan.replace('### TODO 2:','### Removed 2:');
 if(kind==='wrong-todo-count')plan=plan.replace('### TODO 2:','### TODO 3:');
 if(kind==='missing-task')plan=plan.replace('**T9 (','**T99 (');
 if(kind==='changed-first-task')plan=plan.replace('characterization fixtures for the full R6 input matrix before any rewrite','characterization fixtures after the rewrite');
 if(kind==='late-first-task')plan=plan.replace('1. Record characterization fixtures','2. Record characterization fixtures');
 if(kind==='incomplete-report')plan=plan.replace('NO UNRESOLVED DECISIONS','PENDING DECISIONS');
 if(kind==='negative-report')plan+='\nThe engineering review is not complete.';
 expect(recordedCheck(recordedCall(),plan),kind).toBe(false);
});
test('actual D12 native answer survives parser replay; foreign, missing and failed ACKs do not',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'eng-b176-ack-')), cwd=path.join(dir,'repo'), config=path.join(dir,'config');
 const c=recordedCall(), [use,result]=b176.nativeD12Tools, project=path.join(config,'projects','owned');
 fs.mkdirSync(cwd);fs.mkdirSync(project,{recursive:true});
 const records:any[]=[{sessionId:c.sessionId,cwd,isSidechain:false,timestamp:use!.timestamp,message:{role:'assistant',content:[{type:'tool_use',id:c.toolUseId,name:'AskUserQuestion',input:use!.input}]}},
  {sessionId:c.sessionId,cwd,isSidechain:false,timestamp:result!.timestamp,message:{role:'user',content:[{type:'tool_result',tool_use_id:c.toolUseId,is_error:false,content:result!.content}]},toolUseResult:{answers:c.answers}}];
 try{
  for(const kind of ['actual','missing','foreign','failed','wrong-id','missing-answers','unoffered']){
   const rows=structuredClone(records);
   if(kind==='missing')rows.pop();
   if(kind==='foreign')rows[1].sessionId='foreign';
   if(kind==='failed')rows[1].message.content[0].is_error=true;
   if(kind==='wrong-id')rows[1].message.content[0].tool_use_id='other';
   if(kind==='missing-answers')delete rows[1].toolUseResult;
   if(kind==='unoffered')rows[1].toolUseResult.answers[c.questions[0]!.question]='Unstated route';
   fs.writeFileSync(path.join(project,c.sessionId+'.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
   const parsed=readPlanCountTranscript(config,cwd), parsedCall=parsed.calls[0]!;
   if(kind==='actual')expect(parsedCall).toEqual(c);
   expect(recordedCheck(parsedCall),kind).toBe(kind==='actual');
  }
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('actual pending ExitPlanMode needs the classified recap plus the unchanged fresh report and native gates',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'eng-b176-terminal-')),file=path.join(dir,'report.md'),now=Date.now;
 try{
  Date.now=()=>Date.parse(b176.capturedAt);fs.writeFileSync(file,b176.plan);fs.utimesSync(file,b176.sourceReport.mtimeMs/1000,b176.sourceReport.mtimeMs/1000);
  const t=recorded(),signature=b176.fingerprint.signature;
  const admin=new Set(recordedCheck()?[signature]:[]);
  const check=(transcript=t,administrative=admin)=>hasNativePlanTerminal(transcript,file,b176.startedAt,'plan_ready',administrative);
  expect(isCurrentPlanApprovalScreen(b176.screen)).toBe(true);
  expect(check()).toBe(true);expect(check(t,new Set())).toBe(false);expect(check(t,new Set(['foreign:call']))).toBe(false);
  for(const mutate of [
   (v:PlanCountTranscript)=>{v.planReadyRequests=[];},
   (v:PlanCountTranscript)=>{v.planReadyRequests![0]!.failed=true;},
   (v:PlanCountTranscript)=>{v.planReadyRequests![0]!.sessionId='foreign';},
   (v:PlanCountTranscript)=>{v.planReadyRequests![0]!.timestamp=new Date(Date.now()+1).toISOString();},
   (v:PlanCountTranscript)=>{v.planReadyRequests![0]!.timestamp=v.calls.at(-1)!.answeredAt!;},
   (v:PlanCountTranscript)=>{v.calls.at(-1)!.answered=false;},
   (v:PlanCountTranscript)=>{v.calls.at(-2)!.answeredAt=new Date(b176.sourceReport.mtimeMs+1).toISOString();},
  ]){const v=recorded();mutate(v);expect(check(v)).toBe(false);}
  fs.utimesSync(file,(b176.startedAt-1)/1000,(b176.startedAt-1)/1000);expect(check()).toBe(false);
  fs.writeFileSync(file,b176.plan.replace('NO UNRESOLVED DECISIONS','PENDING'));fs.utimesSync(file,b176.sourceReport.mtimeMs/1000,b176.sourceReport.mtimeMs/1000);expect(check()).toBe(false);
 }finally{Date.now=now;fs.rmSync(dir,{recursive:true,force:true});}
});
