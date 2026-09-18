import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import capture from './fixtures/eng-task-pause-navigation-f359.json';
import { isEngCompletionHandoff } from './helpers/eng-completion-handoff';
import { nativePlanCallFingerprint, hasNativePlanTerminal, planCountQuestionPhase } from './helpers/claude-pty-runner';
import type { NativePlanQuestionCall, PlanCountTranscript } from './helpers/plan-count-transcript';
const actual=()=>({call:structuredClone(capture.transcript.calls.at(-1)!) as NativePlanQuestionCall,prior:structuredClone(capture.transcript.calls.slice(0,-1)) as NativePlanQuestionCall[],plan:capture.plan});
type Case=ReturnType<typeof actual>;
const accepts=(x=actual())=>isEngCompletionHandoff(nativePlanCallFingerprint(x.call,0,false),x.plan,x.prior);
function question(call:NativePlanQuestionCall, change:(s:string)=>string){const q=call.questions[0]!,answer=call.answers![q.question]!;q.question=change(q.question);call.answers={[q.question]:answer};}
function replace(s:string,from:string,to:string){expect(s.split(from)).toHaveLength(2);return s.replace(from,to);}
function check(name:string,want:boolean,change?:(x:Case)=>void){test('published task/pause navigation: '+name,()=>{const x=actual();change?.(x);expect(accepts(x)).toBe(want);});}
check('actual D11 prior approvals, current report and task graph',true);
test('captured report ownership and pre-navigation freshness remain exact',()=>{
 expect(createHash('sha256').update(capture.plan).digest('hex')).toBe(capture.reportSource.sha256);
 const x=actual();expect(capture.reportSource.mtimeMs).toBeLessThan(Date.parse(x.call.answeredAt!));
 expect(capture.reportSource.mtimeMs).toBeGreaterThan(Math.max(...x.prior.map(c=>Date.parse(c.answeredAt!))));
 expect(x.prior).toHaveLength(10);
 for(const started of [false,true])expect(planCountQuestionPhase(nativePlanCallFingerprint(x.call,0,false),started,()=>false,undefined,undefined,f=>isEngCompletionHandoff(f,x.plan,x.prior))).toEqual({preReview:false,reviewStarted:started,administrative:'completion-handoff'});
});
check('the pause answer is also completed navigation',true,x=>{x.call.answers={[x.call.questions[0]!.question]:x.call.questions[0]!.options[1]!.label};});
check('native option order carries no selector assumption',true,x=>{x.call.questions[0]!.options.reverse();for(const c of x.prior)c.questions[0]!.options.reverse();});
check('parallel order, plus separators, ASCII arrows, and dash label are presentation',true,x=>{question(x.call,s=>s.replace('T1/T2/T3 in parallel, then T4 → T5 → T6, then T7 last','T3 + T1 + T2 in parallel, then T4 -> T5 -> T6 -> T7 last'));const q=x.call.questions[0]!,old=q.options[0]!.label;q.options[0]!.label=old.replace(', run',' — run');x.call.answers={[q.question]:q.options[0]!.label};});
check('shared step tasks may stay sequential in either dependency-safe order',true,x=>question(x.call,s=>s.replace('T4 → T5','T5 → T4')));
check('dispatch history annotation may be absent with one current approved state',true,x=>{x.plan=x.plan.replaceAll('State: approved (was pending at dispatch; see Actual answer)\n','');});
for(const [name,mutate] of Object.entries({
 'missing prior calls':(x:Case)=>{x.prior=[];},
 'missing routing answer':(x:Case)=>{x.prior.shift();},
 'missing TODO answer':(x:Case)=>{x.prior.pop();},
 'foreign prior session':(x:Case)=>{x.prior[0]!.sessionId='foreign';},
 'duplicated prior identity':(x:Case)=>{x.prior.push(structuredClone(x.prior[0]!));},
 'duplicated prior decision ID':(x:Case)=>{const c=structuredClone(x.prior[0]!);c.toolUseId+='-duplicate';x.prior.push(c);},
 'prior ACK failed':(x:Case)=>{x.prior[0]!.failed=true;},
 'prior ACK unanswered':(x:Case)=>{x.prior[0]!.answered=false;},
 'prior ACK late':(x:Case)=>{x.prior[0]!.answeredAt=x.call.answeredAt;},
 'prior ACK unknown answer':(x:Case)=>{const c=x.prior[0]!;c.answers={[c.questions[0]!.question]:'Unknown'};},
 'prior extra question':(x:Case)=>{const c=x.prior[0]!;c.questions.push(structuredClone(c.questions[0]!));},
 'routing declined':(x:Case)=>{const c=x.prior[0]!;c.answers={[c.questions[0]!.question]:c.questions[0]!.options[1]!.label};},
 'TODO approves implementation instead':(x:Case)=>{const c=x.prior.at(-1)!;c.answers={[c.questions[0]!.question]:c.questions[0]!.options[2]!.label};},
 'remedy selected differently':(x:Case)=>{const c=x.prior[5]!;c.answers={[c.questions[0]!.question]:c.questions[0]!.options[1]!.label};},
 'scope selected differently':(x:Case)=>{const c=x.prior[3]!;c.answers={[c.questions[0]!.question]:c.questions[0]!.options[1]!.label};},
 'navigation ACK unanswered':(x:Case)=>{x.call.answered=false;},
 'navigation ACK failed':(x:Case)=>{x.call.failed=true;},
 'navigation ACK invalid time':(x:Case)=>{x.call.answeredAt='bad';},
 'navigation unanswered indices':(x:Case)=>{x.call.unansweredQuestionIndices=[0];},
 'navigation unoffered answer':(x:Case)=>{x.call.answers={[x.call.questions[0]!.question]:'Unknown'};},
 'navigation multiple questions':(x:Case)=>{x.call.questions.push(structuredClone(x.call.questions[0]!));},
 'navigation multiple selections':(x:Case)=>{x.call.questions[0]!.multiSelect=true;},
 'navigation third action':(x:Case)=>{x.call.questions[0]!.options.push({label:'Build a different cache',description:'Add Redis.'});},
 'foreign navigation target':(x:Case)=>{question(x.call,s=>s.replace('reviewing PLAN.md','reviewing OTHER.md'));},
 'foreign earlier target':(x:Case)=>{question(x.prior[0]!,s=>s.replace('reviewing PLAN.md','reviewing OTHER.md'));},
 'foreign branch':(x:Case)=>{question(x.call,s=>s.replace(' on main,',' on other,'));},
 'foreign plan title':(x:Case)=>{x.plan=replace(x.plan,'# Plan: Multi-tenant Auth Refactor (reviewed)','# Plan: Another Refactor (reviewed)');},
 'duplicated plan owner':(x:Case)=>{x.plan+='\n'+x.plan.split('\n').find(l=>l.startsWith('Reviewed target:'))+'\n';},
 'historical plan':(x:Case)=>{x.plan='# Historical plan\n\n'+x.plan.replace(/^#/,'##').replace(/^## /gm,'### ');},
 'quoted plan':(x:Case)=>{x.plan=x.plan.split('\n').map(l=>'> '+l).join('\n');},
 'fenced plan':(x:Case)=>{x.plan='```md\n'+x.plan+'\n```';},
 'historical ledger':(x:Case)=>{x.plan=replace(x.plan,'## Decision ledger','## Historical decision ledger');},
 'historical descendant row':(x:Case)=>{x.plan=replace(x.plan,'### R1:','### Archived records\n\n#### R1:');},
 'source-introduced ledger':(x:Case)=>{x.plan=replace(x.plan,'## Decision ledger','Example only:\n\n## Decision ledger');},
 'missing report':(x:Case)=>{x.plan=x.plan.slice(0,x.plan.indexOf('## GSTACK REVIEW REPORT'));},
 'duplicate report':(x:Case)=>{x.plan+='\n'+x.plan.slice(x.plan.indexOf('## GSTACK REVIEW REPORT'));},
 'unresolved report':(x:Case)=>{x.plan=replace(x.plan,'NO UNRESOLVED DECISIONS','1 unresolved decision\n\nNO UNRESOLVED DECISIONS');},
 'current row pending':(x:Case)=>{x.plan=x.plan.replace('State: approved\n','State: pending\n');},
 'contradictory current states':(x:Case)=>{x.plan=x.plan.replace('State: approved\n','State: approved\nState: rejected\n');},
 'duplicate current states':(x:Case)=>{x.plan=x.plan.replace('State: approved\n','State: approved\nState: approved\n');},
 'missing readiness':(x:Case)=>{x.plan=x.plan.replace('**Approval readiness: PASS.**','Approval not recorded.');},
 'changed readiness answer':(x:Case)=>{x.plan=x.plan.replace('Checked IDs: R1 (D6 → A)','Checked IDs: R1 (D6 → B)');},
 'missing saved selected answer':(x:Case)=>{x.plan=x.plan.replace('Actual answer: **A — Constructor injection from a composition root**','Actual answer missing: **A — Constructor injection from a composition root**');},
 'changed saved native question':(x:Case)=>{x.plan=x.plan.replace('Question D6:\nD6 — How do','Question D6:\nD6 — Why do');},
 'missing saved TODO':(x:Case)=>{x.plan=x.plan.replace('## TODOS.md (not persisted in plan mode; write after exit)','## Other notes');},
 'changed saved TODO subject':(x:Case)=>{x.plan=x.plan.replace('- **Single-flight dedupe for concurrent same-token validations**','- **Build a new cache**');},
 'missing referenced task':(x:Case)=>{x.plan=x.plan.replace('**T2 (','**T22 (');},
 'duplicated catalog task':(x:Case)=>{x.plan=x.plan.replace('**T2 (','**T1 (');},
 'foreign task module':(x:Case)=>{x.plan=x.plan.replace('— auth/cache — Build','— other/cache — Build');},
 'step cannot bind the task module':(x:Case)=>{x.plan=x.plan.replace('| auth/cache/, tests/auth/cache/ |','| other/cache/, tests/auth/cache/ |');},
 'graph forward dependency':(x:Case)=>{x.plan=x.plan.replace('| S2, S3 |','| S2, S6 |');},
 'graph duplicated step':(x:Case)=>{x.plan=x.plan.replace('| S2 `AuthCache`','| S1 `AuthCache`');},
 'graph missing final step':(x:Case)=>{x.plan=x.plan.replace(/^\| S6 .+\n/gm,'');},
 'graph unknown dependency':(x:Case)=>{x.plan=x.plan.replace('| S2, S3 |','| S2, S99 |');},
 'graph duplicate dependency':(x:Case)=>{x.plan=x.plan.replace('| S2, S3 |','| S2, S2 |');},
 'menu unknown task':(x:Case)=>{question(x.call,s=>s.replace('T1/T2/T3','T1/T2/T33'));},
 'menu duplicate task':(x:Case)=>{question(x.call,s=>s.replace('T1/T2/T3','T1/T2/T2'));},
 'menu reversed dependency':(x:Case)=>{question(x.call,s=>s.replace('T4 → T5 → T6, then T7','T6 → T5 → T4, then T7'));},
 'menu parallel shared step':(x:Case)=>{question(x.call,s=>s.replace('T4 → T5','T4/T5 in parallel'));},
 'menu perf before regression':(x:Case)=>{question(x.call,s=>s.replace('T6, then T7','T7, then T6'));},
 'omitted ordinary task disguised as auxiliary':(x:Case)=>{x.plan=replace(x.plan,'  - Verify: diagrams match final code in the same commit','  - Verify: diagrams match final code in a later commit');},
 'auxiliary foreign prerequisite':(x:Case)=>{x.plan=x.plan.replace('before T7 merges','before T99 merges');},
 'renamed maintenance owner':(x:Case)=>{question(x.call,s=>s.replace('Routing rules (D1)','Routing rules (D2)'));},
 'renamed TODO owner':(x:Case)=>{question(x.call,s=>s.replace('TODOS.md (D10)','TODOS.md (D9)'));},
}))check(name,false,mutate);
for(const text of [
 'D1 approval is revoked.', 'D10 decision is reopened.', 'D6 is pending.', 'The review is incomplete.',
 'Every decision is unanswered.', 'The engineering review is complete if more tests pass.',
 'Add Redis before implementation.', 'Start building while rewriting the cache.',
 'Routing rules must also enable telemetry.', 'A new implementation dependency is required.',
 'Drop tasks T8 and T9.', 'Run ./deploy now.', '"Delete the tenant database."',
])check('appended substantive/current correction: '+text,false,x=>question(x.call,s=>s+'\n'+text));
for(const index of [0,1])check('option '+index+' cannot append new work',false,x=>{x.call.questions[0]!.options[index]!.description+=' Add a new datastore first.';});
check('later native withdrawal overrides the earlier routing grant',false,x=>{const c=structuredClone(x.prior[0]!);c.toolUseId+='-withdraw';c.answeredAt='2026-09-16T07:01:00.000Z';question(c,s=>s.replace(/^D1 —/,'D20 —')+'\nD1 approval is revoked.');x.prior.push(c);});
test('handoff alone never supplies a native terminal or refreshes modifying answers',()=>{
 const x=actual(),fp=nativePlanCallFingerprint(x.call,0,false),admin=new Set(accepts(x)?[fp.signature]:[]);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gstack-eng-task-pause-')),file=path.join(dir,'reviewed.md'),now=Date.now;
 try {
  fs.writeFileSync(file,x.plan);fs.utimesSync(file,capture.reportSource.mtimeMs/1000,capture.reportSource.mtimeMs/1000);
  Date.now=()=>Date.parse('2026-09-16T07:04:00.000Z');
  const t=structuredClone(capture.transcript) as PlanCountTranscript;
  const check=(v=t,a=admin)=>hasNativePlanTerminal(v,file,Date.parse('2026-09-16T06:40:00.000Z'),'plan_ready',a);
  expect(check()).toBe(false); // Actual capture precedes the native exit.
  // The later retained native exit is real; this is a gate replay, not a
  // replacement verdict for the original paid timeout/failure.
  expect(createHash('sha256').update(JSON.stringify(t.calls)).digest('hex')).toBe(capture.terminalCapture.callsSha256);
  t.planReadyRequests=structuredClone(capture.terminalCapture.planReadyRequests);
  t.assistantMessages=structuredClone(capture.terminalCapture.assistantMessages);
  expect(check()).toBe(true);expect(check(t,new Set())).toBe(false);expect(check(t,new Set(['foreign:call']))).toBe(false);
  for(const mutate of [
   (v:PlanCountTranscript)=>{v.planReadyRequests![0]!.failed=true;},
   (v:PlanCountTranscript)=>{v.planReadyRequests![0]!.sessionId='foreign';},
   (v:PlanCountTranscript)=>{v.planReadyRequests![0]!.timestamp=x.call.answeredAt!;},
   (v:PlanCountTranscript)=>{v.planReadyRequests=[];},
   (v:PlanCountTranscript)=>{v.calls[5]!.answeredAt=x.call.answeredAt;},
   (v:PlanCountTranscript)=>{v.calls[5]!.answered=false;v.calls[5]!.unansweredQuestionIndices=[0];},
  ]){const v=structuredClone(t);mutate(v);expect(check(v)).toBe(false);}
 }finally{Date.now=now;fs.rmSync(dir,{recursive:true,force:true});}
});

check('matching task and graph module names may change together',true,x=>{x.plan=x.plan.replace('— auth/cache — Build','— auth/state — Build').replace('| auth/cache/, tests/auth/cache/ |','| auth/state/, tests/auth/cache/ |');});
check('ambiguous contiguous task-to-step binding is rejected',false,x=>{x.plan=x.plan.replace('| auth/broker/, auth/session/, app bootstrap |','| auth/broker/, auth/session/, app bootstrap, tests/auth/ |').replace('| tests/auth/, auth/ (legacy removal) |','| auth/broker/, auth/session/, app bootstrap, tests/auth/ |');});
check('first-run or substantive heading is not completion',false,x=>question(x.call,s=>s.replace('Next step after this eng review?','Choose the auth architecture?')));
test('native signature and rendered options cannot replace the captured choice',()=>{
 const x=actual(),fp=nativePlanCallFingerprint(x.call,0,false);
 expect(isEngCompletionHandoff({...fp,signature:'foreign:call'},x.plan,x.prior)).toBe(false);
 expect(isEngCompletionHandoff({...fp,nativeQuestionIndex:1},x.plan,x.prior)).toBe(false);
 expect(isEngCompletionHandoff({...fp,options:[]},x.plan,x.prior)).toBe(false);
});

check('additional pending non-remedy decision cannot hide outside current R rows',false,x=>{x.plan=replace(x.plan,'### Test-depth note (no question needed)','### D20: Unanswered extra decision\nState: pending\n\n### Test-depth note (no question needed)');});
check('readiness cannot change an approved scope selector',false,x=>{x.plan=replace(x.plan,'scope D4 → A, D5 → A','scope D4 → B, D5 → A');});
check('readiness cannot invent an answered TODO',false,x=>{x.plan=replace(x.plan,'; TODO D10 → A.','; TODO D20 → A.');});
