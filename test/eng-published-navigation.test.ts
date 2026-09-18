import {expect,test} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import a from './fixtures/eng-published-navigation.json';
import {isEngCompletionHandoff} from './helpers/eng-completion-handoff';
import {evaluateEngSeedCoverage} from './helpers/eng-seeded-coverage';
import {nativePlanCallFingerprint,hasNativePlanTerminal,planCountQuestionPhase} from './helpers/claude-pty-runner';
import type {NativePlanQuestionCall,PlanCountTranscript} from './helpers/plan-count-transcript';
import heldPackets from './fixtures/eng-native-packets-b955.json';
import retryPacket from './fixtures/eng-a689-retry-public.json';
import countPacket from './fixtures/eng-69193-count-public.json';
import e366Packet from './fixtures/eng-e366-count-public.json';
const e366Navigation=()=>({plan:e366Packet.report,call:structuredClone(e366Packet.calls.at(-1)!) as NativePlanQuestionCall,priorCalls:structuredClone(e366Packet.calls.slice(0,-1)) as NativePlanQuestionCall[]});
function e366Check(name:string,expected:boolean,edit?:(x:ReturnType<typeof e366Navigation>)=>void){test('current native navigation: '+name,()=>{const x=e366Navigation(),before=JSON.stringify(x);edit?.(x);if(edit)expect(JSON.stringify(x)).not.toBe(before);expect(isEngCompletionHandoff(nativePlanCallFingerprint(x.call,0,false),x.plan,x.priorCalls)).toBe(expected);});}
function e366Record(x:ReturnType<typeof e366Navigation>,id:number,edit:(s:string)=>string){x.plan=x.plan.replace(new RegExp(`^### R${id}:[\\s\\S]*?(?=^### |^## |$(?![\\s\\S]))`,'m'),edit);}
e366Check('actual D11 and unchanged owned report is administrative',true);
test('current native navigation supplies no complete-report acceptance',()=>{
 const x=e366Navigation();
 expect(isEngCompletionHandoff(nativePlanCallFingerprint(x.call,0,false),x.plan,x.priorCalls)).toBe(true);
 const coverage=evaluateEngSeedCoverage({status:'ready',calls:[...x.priorCalls,x.call],assistantMessages:[],planReadyRequests:[]},x.plan,Date.parse(e366Packet.windowStart),Date.parse(e366Packet.windowEnd));
 expect(coverage.ok).toBe(false);
 expect(coverage.problems).toContain('mandatory legacy regression coverage absent');
});

e366Check('TODO same prefix cannot append new work',false,x=>{x.plan=x.plan.replace('- What: per-key in-flight promise map;','- What: per-key in-flight promise map; also add customer analytics;');});
e366Check('TODO same prefix cannot change inside constraint',false,x=>{x.plan=x.plan.replace('- What: per-key in-flight promise map;','- What: per-key in-flight promise map inside SessionMint;');});
e366Check('TODO same prefix cannot change where constraint',false,x=>{x.plan=x.plan.replace('- What: flag-gated shadow mode;','- What: flag-gated shadow mode where the new flow decides;');});
e366Check('readiness appended current withdrawal rejected',false,x=>{x.plan=x.plan.replace('No remedy was implemented; the plan text above reflects only approved values.','No remedy was implemented; the plan text above reflects only approved values.\nCorrection: R3 is revoked.');});

e366Check('duplicate readiness assertion rejected',false,x=>{x.plan=x.plan.replace('### Approval readiness: PASS','Approval readiness: PASS\n### Approval readiness: PASS');});
e366Check('readiness later withdrawal rejected',false,x=>{x.plan=x.plan.replace('### Approval readiness: PASS','### Approval readiness: PASS\nCorrection: R3 is revoked.');});
e366Check('readiness wrong native range rejected',false,x=>{x.plan=x.plan.replace("user's actual answer (D1–D10)","user's actual answer (D1–D9)");});
e366Check('disconnected conflicting Eng row rejected',false,x=>{x.plan=x.plan.replace('OUTSIDE COVERAGE:','| Eng Review | ISSUES OPEN | 1 run | 1 critical gap |\n\nOUTSIDE COVERAGE:');});
e366Check('foreign recap artifact rejected',false,x=>{x.call.questions[0]!.options[0]!.description=x.call.questions[0]!.options[0]!.description!.replace('TODOS.md','OTHER.md');});
e366Check('unbound TODO recap rejected',false,x=>{x.call.questions[0]!.options[0]!.description=x.call.questions[0]!.options[0]!.description!.replace('two TODOS.md entries','new TODOS.md entries');});

e366Check('option order is immaterial',true,x=>x.call.questions[0]!.options.reverse());
e366Check('native CEO choice remains navigation',true,x=>{const q=x.call.questions[0]!;x.call.answers={[q.question]:q.options[1]!.label};});
e366Check('report role order is immaterial',true,x=>{x.plan=x.plan.replace(/^(\|[^\n]+\|)$/gm,line=>{const c=line.split('|').slice(1,-1);return c.length===4?'|'+[c[0],c[2],c[3],c[1]].join('|')+'|':line;});});
e366Check('canonical Findings role also binds',true,x=>{x.plan=x.plan.replace('| Key finding |','| Findings |');});
e366Check('current History does not revoke approval',true,x=>e366Record(x,3,s=>s.replace('History: none.','History: R3 is revoked.')));
for(const [name,edit] of Object.entries({
 'unanswered handoff':(x:ReturnType<typeof e366Navigation>)=>{x.call.answered=false;},
 'failed handoff':(x:ReturnType<typeof e366Navigation>)=>{x.call.failed=true;},
 'unknown selected label':(x:ReturnType<typeof e366Navigation>)=>{x.call.answers={[x.call.questions[0]!.question]:'Other'};},
 'header alone':(x:ReturnType<typeof e366Navigation>)=>question(x,_=>'D11 — Where next?'),
 'missing earlier call':(x:ReturnType<typeof e366Navigation>)=>{x.priorCalls.splice(3,1);},
 'duplicated earlier identity':(x:ReturnType<typeof e366Navigation>)=>{x.priorCalls[3]!.toolUseId=x.priorCalls[2]!.toolUseId;},
 'foreign earlier session':(x:ReturnType<typeof e366Navigation>)=>{x.priorCalls[3]!.sessionId='foreign';},
 'later earlier answer':(x:ReturnType<typeof e366Navigation>)=>{x.priorCalls[3]!.answeredAt=x.call.answeredAt;},
 'foreign current title':(x:ReturnType<typeof e366Navigation>)=>question(x,s=>s.replace('Multi-tenant Auth Refactor','Foreign')),
 'foreign current branch':(x:ReturnType<typeof e366Navigation>)=>question(x,s=>s.replace('main —','foreign —')),
 'foreign current source':(x:ReturnType<typeof e366Navigation>)=>question(x,s=>s.replace('(PLAN.md)','(OTHER.md)')),
 'duplicate current source':(x:ReturnType<typeof e366Navigation>)=>question(x,s=>s.replace('(PLAN.md)','(PLAN.md OTHER.md)')),
 'foreign target':(x:ReturnType<typeof e366Navigation>)=>{x.plan=x.plan.replace('Reviewed target: `PLAN.md`','Reviewed target: `OTHER.md`');},
 'foreign target title':(x:ReturnType<typeof e366Navigation>)=>{x.plan=x.plan.replace('("Plan: Multi-tenant Auth Refactor")','("Plan: Other")');},
 'foreign target branch':(x:ReturnType<typeof e366Navigation>)=>{x.plan=x.plan.replace('branch `main`, commit','branch `other`, commit');},
 'foreign wrapper':(x:ReturnType<typeof e366Navigation>)=>{x.plan=x.plan.replace('# Plan: Multi-tenant Auth Refactor','# Plan: Other');},
 'duplicate wrapper':(x:ReturnType<typeof e366Navigation>)=>{x.plan='# Plan: Other\n'+x.plan;},
 'duplicate target':(x:ReturnType<typeof e366Navigation>)=>{x.plan=x.plan.replace('## Context',x.plan.split('\n')[2]+'\n## Context');},
 'missing current record':(x:ReturnType<typeof e366Navigation>)=>e366Record(x,3,_=>''),
 'missing initial summary':(x:ReturnType<typeof e366Navigation>)=>e366Record(x,0,_=>''),
 'unknown initial acceptance':(x:ReturnType<typeof e366Navigation>)=>e366Record(x,0,s=>s.replace(/^Accepted scope: .+$/m,'Accepted scope: approved')),
 'changed initial offered label':(x:ReturnType<typeof e366Navigation>)=>e366Record(x,0,s=>s.replace('B) 4 units','B) 10 units')),
 'changed initial selected class':(x:ReturnType<typeof e366Navigation>)=>e366Record(x,0,s=>s.replace('Accepted scope: AuthBroker','Accepted scope: AnotherBroker')),
 'changed initial function':(x:ReturnType<typeof e366Navigation>)=>e366Record(x,0,s=>s.replace('`decideAccess(claims, ctx)`','`other(claims, ctx)`')),
 'changed initial fold':(x:ReturnType<typeof e366Navigation>)=>e366Record(x,0,s=>s.replace('TokenStore folds into AuthCache.','TokenStore folds into OtherCache.')),
 'extra initial work':(x:ReturnType<typeof e366Navigation>)=>e366Record(x,0,s=>s.replace('No other remedy approved','Add Redis. No other remedy approved')),
 'initial summary later correction':(x:ReturnType<typeof e366Navigation>)=>e366Record(x,0,s=>s.replace('Structure only; all other remedies stayed pending.','Correction: add Redis. Structure only; all other remedies stayed pending.')),
 'missing readiness':(x:ReturnType<typeof e366Navigation>)=>{x.plan=x.plan.replace('### Approval readiness: PASS','### Result: PASS');},
 'wrong readiness range':(x:ReturnType<typeof e366Navigation>)=>{x.plan=x.plan.replace('Every record R0–R9','Every record R0–R8');},
 'conflicting readiness':(x:ReturnType<typeof e366Navigation>)=>{x.plan=x.plan.replace('### Approval readiness: PASS','Approval readiness: FAIL\n### Approval readiness: PASS');},
 'current withdrawal':(x:ReturnType<typeof e366Navigation>)=>question(x,s=>s+'\nR3 is revoked.'),
 'quoted current withdrawal':(x:ReturnType<typeof e366Navigation>)=>question(x,s=>s+'\nR3 is "revoked".'),
 'new task':(x:ReturnType<typeof e366Navigation>)=>{x.call.questions[0]!.options[0]!.description+=' Start T10.';},
 'missing task':(x:ReturnType<typeof e366Navigation>)=>{x.plan=x.plan.replace('**T4 (','**T44 (');},
 'extra catalog task':(x:ReturnType<typeof e366Navigation>)=>{x.plan=x.plan.replace('## Implementation Tasks','## Implementation Tasks\n- [ ] **T10 (P1)** — Add Redis');},
 'withdrawn task':(x:ReturnType<typeof e366Navigation>)=>{x.plan=x.plan.replace('  - Files: test/auth/legacy','  - Correction: T1 is withdrawn.\n  - Files: test/auth/legacy');},
 'new ready work':(x:ReturnType<typeof e366Navigation>)=>{x.call.questions[0]!.options[0]!.description+=' Also add Redis.';},
 'new optional work':(x:ReturnType<typeof e366Navigation>)=>{x.call.questions[0]!.options[1]!.description+=' Then rewrite the router.';},
 'new quoted work':(x:ReturnType<typeof e366Navigation>)=>question(x,s=>s+'\nAlso "add Redis".'),
 'new dependency':(x:ReturnType<typeof e366Navigation>)=>question(x,s=>s+'\nT1 depends on T9.'),
 'new task ordering':(x:ReturnType<typeof e366Navigation>)=>question(x,s=>s+'\nT8 before T1.'),
 'missing graph step':(x:ReturnType<typeof e366Navigation>)=>{x.plan=x.plan.replace(/^\| 4 AuthBroker.+\n/m,'');},
 'unknown graph dependency':(x:ReturnType<typeof e366Navigation>)=>{x.plan=x.plan.replace('| 2, 3 |','| 2, 99 |');},
 'wrong graph launch':(x:ReturnType<typeof e366Navigation>)=>{x.plan=x.plan.replace('launch A, B, C in parallel','launch A, B in parallel');},
 'reordered dependent graph step':(x:ReturnType<typeof e366Navigation>)=>{x.plan=x.plan.replace('4 → 6 → 7 → 8 → 9','6 → 4 → 7 → 8 → 9');},
 'new TODO count':(x:ReturnType<typeof e366Navigation>)=>{x.call.questions[0]!.options[0]!.description=x.call.questions[0]!.options[0]!.description!.replace('two TODOS.md entries','three TODOS.md entries');},
 'changed TODO disposition':(x:ReturnType<typeof e366Navigation>)=>{const c=x.priorCalls[8]!,q=c.questions[0]!;c.answers={[q.question]:q.options[1]!.label};},
 'missing TODO entry':(x:ReturnType<typeof e366Navigation>)=>{x.plan=x.plan.replace(/^\*\*TODO 2 [^]*?(?=^## Unresolved decisions)/m,'');},
 'changed TODO proposal':(x:ReturnType<typeof e366Navigation>)=>{x.plan=x.plan.replace('- What: per-key in-flight promise map;','- What: add customer analytics;');},
 'missing report':(x:ReturnType<typeof e366Navigation>)=>{x.plan=x.plan.slice(0,x.plan.indexOf('## GSTACK REVIEW REPORT'));},
 'historical report':(x:ReturnType<typeof e366Navigation>)=>{x.plan='## Historical example\n'+x.plan.replace(/^# /gm,'### ');},
 'fenced report':(x:ReturnType<typeof e366Navigation>)=>{x.plan='```md\n'+x.plan+'\n```';},
 'trailing report prose':(x:ReturnType<typeof e366Navigation>)=>{x.plan+='\nstatus ready\n';},
 'missing sentinel':(x:ReturnType<typeof e366Navigation>)=>{x.plan=x.plan.replace('NO UNRESOLVED DECISIONS','Unresolved status');},
 'current critical gap':(x:ReturnType<typeof e366Navigation>)=>{x.plan=x.plan.replace('12 issues, 0 critical gaps (','12 issues, 1 critical gap (');},
 'duplicate status role':(x:ReturnType<typeof e366Navigation>)=>{x.plan=x.plan.replace('| Key finding |','| Status |');},
 'duplicate findings role':(x:ReturnType<typeof e366Navigation>)=>{x.plan=x.plan.replace('| Runs | Key finding |','| Findings | Key finding |');},
 'missing runs role':(x:ReturnType<typeof e366Navigation>)=>{x.plan=x.plan.replace('| Runs |','| Effort |');},
 'missing findings role':(x:ReturnType<typeof e366Navigation>)=>{x.plan=x.plan.replace('| Key finding |','| Commentary |');},
 'conflicting status row':(x:ReturnType<typeof e366Navigation>)=>{x.plan=x.plan.replace('| Design Review |','| Eng Review | ISSUES OPEN | 1 | 1 critical gap |\n| Design Review |');},
 'duplicate Eng row':(x:ReturnType<typeof e366Navigation>)=>{const row=x.plan.match(/^\| Eng Review \|.+$/m)![0];x.plan=x.plan.replace(row,row+'\n'+row);},
 'wrong reported decision count':(x:ReturnType<typeof e366Navigation>)=>{x.plan=x.plan.replace('10 decisions approved (D1–D10)','9 decisions approved (D1–D10)');},
}))e366Check('rejects '+name,false,edit);
for(const id of [1,3,5,8,9]){
 e366Check(`record R${id} current State required`,false,x=>e366Record(x,id,s=>s.replace('State: approved','State: pending')));
 e366Check(`record R${id} duplicate state rejected`,false,x=>e366Record(x,id,s=>s.replace('State: approved','State: approved\nState: approved')));
 e366Check(`record R${id} exact question required`,false,x=>e366Record(x,id,s=>s.replace(x.priorCalls[id]!.questions[0]!.question,'Summary only.')));
 e366Check(`record R${id} exact header required`,false,x=>e366Record(x,id,s=>s.replace(/^Header: .+$/m,'Header: Other')));
 e366Check(`record R${id} exact option description required`,false,x=>e366Record(x,id,s=>s.replace(x.priorCalls[id]!.questions[0]!.options[1]!.description!,'Another option description')));
 e366Check(`record R${id} native answer reference required`,false,x=>e366Record(x,id,s=>s.replace('user answer to D'+(id+1),'user answer to D99')));
}
for(const suffix of ['-extra','/extra','.ts','?mode=extra'])e366Check('rejects command suffix '+suffix,false,x=>{x.call.questions[0]!.options[1]!.description+=` Run /plan-ceo-review${suffix}.`;});


const countNavigation=()=>({plan:countPacket.report,call:structuredClone(countPacket.calls.at(-1)!) as NativePlanQuestionCall,priorCalls:structuredClone(countPacket.calls.slice(0,-1)) as NativePlanQuestionCall[]});
function countNavigationCheck(name:string,expected:boolean,edit?:(x:ReturnType<typeof countNavigation>)=>void){test('owned conditional navigation: '+name,()=>{const x=countNavigation(), before=JSON.stringify(x);edit?.(x);if(edit)expect(JSON.stringify(x)).not.toBe(before);expect(isEngCompletionHandoff(nativePlanCallFingerprint(x.call,0,false),x.plan,x.priorCalls)).toBe(expected);});}
function countRecord(x:ReturnType<typeof countNavigation>,id:number,edit:(s:string)=>string){
 x.plan=x.plan.replace(new RegExp(`^### [SRT]${id}:[\\s\\S]*?(?=^### [SRT][1-9]\\d*:|^## |$(?![\\s\\S]))`,'m'),edit);
}
countNavigationCheck('actual D10 and unchanged complete owned report',true);
countNavigationCheck('optional Design selected',true,x=>{const q=x.call.questions[0]!;x.call.answers={[q.question]:q.options[1]!.label};});
countNavigationCheck('route order is immaterial',true,x=>x.call.questions[0]!.options.reverse());
countNavigationCheck('matching reviewed wrapper and original title',true,x=>{x.plan=x.plan.replace('# Reviewed Plan: Multi-tenant Auth Refactor','# Plan: Multi-tenant Auth Refactor').replace('\n# Plan: Multi-tenant Auth Refactor','');});
countNavigationCheck('current History is inert',true,x=>countRecord(x,6,s=>s.replace('History: none','History: R6 is revoked.')));
countNavigationCheck('header alone cannot establish readiness',false,x=>question(x,_=>'D10 — Next step?'));
for(const [name,edit] of Object.entries({
 'unanswered D10':(x:ReturnType<typeof countNavigation>)=>{x.call.answered=false;},
 'failed D10':(x:ReturnType<typeof countNavigation>)=>{x.call.failed=true;},
 'unknown native selection':(x:ReturnType<typeof countNavigation>)=>{x.call.answers={[x.call.questions[0]!.question]:'Other'};},
 'missing prior call':(x:ReturnType<typeof countNavigation>)=>{x.priorCalls.splice(2,1);},
 'foreign prior session':(x:ReturnType<typeof countNavigation>)=>{x.priorCalls[2]!.sessionId='other';},
 'late prior answer':(x:ReturnType<typeof countNavigation>)=>{x.priorCalls[2]!.answeredAt=x.call.answeredAt;},
 'foreign branch':(x:ReturnType<typeof countNavigation>)=>question(x,s=>s.replace('main —','other —')),
 'foreign current title':(x:ReturnType<typeof countNavigation>)=>question(x,s=>s.replace('Multi-tenant Auth Refactor','Other Refactor')),
 'foreign original title':(x:ReturnType<typeof countNavigation>)=>{x.plan=x.plan.replace('# Plan: Multi-tenant Auth Refactor','# Plan: Other');},
 'foreign reviewed title':(x:ReturnType<typeof countNavigation>)=>{x.plan=x.plan.replace('# Reviewed Plan: Multi-tenant Auth Refactor','# Reviewed Plan: Other');},
 'duplicate wrapper':(x:ReturnType<typeof countNavigation>)=>{x.plan='# Reviewed Plan: Multi-tenant Auth Refactor\n'+x.plan;},
 'foreign source':(x:ReturnType<typeof countNavigation>)=>{x.plan=x.plan.replace('Reviewed target: `PLAN.md`','Reviewed target: `OTHER.md`');},
 'foreign resolved source':(x:ReturnType<typeof countNavigation>)=>{x.plan=x.plan.replace('/gstack-plan-count-VjWQw7/PLAN.md','/gstack-plan-count-VjWQw7/OTHER.md');},
 'missing report':(x:ReturnType<typeof countNavigation>)=>{x.plan=x.plan.slice(0,x.plan.indexOf('## GSTACK REVIEW REPORT'));},
 'missing ledger':(x:ReturnType<typeof countNavigation>)=>{x.plan=x.plan.replace('## Decision ledger','## Archived ledger');},
 'quoted report':(x:ReturnType<typeof countNavigation>)=>{x.plan='```md\n'+x.plan+'\n```';},
 'historical report':(x:ReturnType<typeof countNavigation>)=>{x.plan='## Historical example\n'+x.plan.replace(/^# /gm,'### ');},
 'new unresolved decision':(x:ReturnType<typeof countNavigation>)=>{x.plan=x.plan.replace('NO UNRESOLVED DECISIONS','ONE UNRESOLVED DECISION');},
 'critical gap':(x:ReturnType<typeof countNavigation>)=>{x.plan=x.plan.replace('33 test gaps), 0 critical gaps','33 test gaps), 1 critical gap');},
 'revoked R6':(x:ReturnType<typeof countNavigation>)=>countRecord(x,6,s=>s.replace('State: approved','State: revoked')),
 'duplicate R6 state':(x:ReturnType<typeof countNavigation>)=>countRecord(x,6,s=>s.replace('State: approved','State: approved\nState: approved')),
 'wrong saved selection':(x:ReturnType<typeof countNavigation>)=>countRecord(x,6,s=>s.replace('Actual answer: A','Actual answer: B')),
 'wrong saved caption':(x:ReturnType<typeof countNavigation>)=>countRecord(x,6,s=>s.replace('A (D6 answer','A — "Other" (D6 answer')),
 'wrong readiness answer':(x:ReturnType<typeof countNavigation>)=>{x.plan=x.plan.replace('R6 (D6→A)','R6 (D6→B)');},
 'missing substantive question':(x:ReturnType<typeof countNavigation>)=>countRecord(x,6,s=>s.replace(x.priorCalls[5]!.questions[0]!.question,'Regression summary.')),
 'missing substantive header':(x:ReturnType<typeof countNavigation>)=>countRecord(x,6,s=>s.replace(/^Header: .+\n/m,'')),
 'changed substantive option description':(x:ReturnType<typeof countNavigation>)=>countRecord(x,6,s=>s.replace('Record legacyAuthFlow','Record otherFlow')),
 'scope summary on substantive record':(x:ReturnType<typeof countNavigation>)=>countRecord(x,6,s=>s.replace(x.priorCalls[5]!.questions[0]!.question,'(initial scope selector) "Regression?"')),
 'TODO changed to implementation':(x:ReturnType<typeof countNavigation>)=>{const c=x.priorCalls[6]!,q=c.questions[0]!;c.answers={[q.question]:q.options[2]!.label};},
 'TODO missing disposition':(x:ReturnType<typeof countNavigation>)=>countRecord(x,7,s=>s.replace('Accepted scope: TODO recorded','Accepted scope: Implementation approved')),
 'TODO invented option':(x:ReturnType<typeof countNavigation>)=>countRecord(x,7,s=>s.replace('B) Skip','B) Add Redis')),
 'omitted task':(x:ReturnType<typeof countNavigation>)=>{x.plan=x.plan.replace('**T4 (','**T44 (');},
 'new task':(x:ReturnType<typeof countNavigation>)=>{x.plan=x.plan.replace('## Implementation Tasks','## Implementation Tasks\n- [ ] **T10 (P1)** — Add Redis');},
 'unknown lane':(x:ReturnType<typeof countNavigation>)=>{x.call.questions[0]!.options[0]!.description=x.call.questions[0]!.options[0]!.description!.replace('C (RequestPolicy)','Z (RequestPolicy)');},
 'start blocked lane':(x:ReturnType<typeof countNavigation>)=>{x.call.questions[0]!.options[0]!.description=x.call.questions[0]!.options[0]!.description!.replace('C (RequestPolicy)','D (TokenStore)');},
 'start dependent lane':(x:ReturnType<typeof countNavigation>)=>{x.call.questions[0]!.options[0]!.description=x.call.questions[0]!.options[0]!.description!.replace('C (RequestPolicy)','E (composition)');},
 'omit blocked condition':(x:ReturnType<typeof countNavigation>)=>{x.call.questions[0]!.options[0]!.description=x.call.questions[0]!.options[0]!.description!.replace(/ ❌ TokenStore lane.+/,'');},
 'foreign blocked subject':(x:ReturnType<typeof countNavigation>)=>{x.call.questions[0]!.options[0]!.description=x.call.questions[0]!.options[0]!.description!.replace('TokenStore lane','AuthCache lane');},
 'unconditional published blocked lane':(x:ReturnType<typeof countNavigation>)=>{x.plan=x.plan.replace('A + B + C (+ D when TokenStore is defined)','A + B + C + D');},
 'dependency cycle':(x:ReturnType<typeof countNavigation>)=>{x.plan=x.plan.replace('| T4 recorded |','| T3 recorded |');},
 'missing prerequisite':(x:ReturnType<typeof countNavigation>)=>{x.plan=x.plan.replace('T4 → T3','T3 → T4');},
 'new ready action':(x:ReturnType<typeof countNavigation>)=>{x.call.questions[0]!.options[0]!.description+=' Also add Redis.';},
 'new optional action':(x:ReturnType<typeof countNavigation>)=>{x.call.questions[0]!.options[1]!.description+=' Then rewrite the router.';},
 'new quoted action':(x:ReturnType<typeof countNavigation>)=>question(x,s=>s+'\nAlso "add Redis".'),
 'new lane start':(x:ReturnType<typeof countNavigation>)=>{x.call.questions[0]!.options[1]!.description+=' Start lane D now.';},
 'new gate obligation':(x:ReturnType<typeof countNavigation>)=>question(x,s=>s+'\nA migration must run before implementation.'),
 'current approval withdrawn':(x:ReturnType<typeof countNavigation>)=>question(x,s=>s+'\nR6 is revoked.'),
 'conditional completion':(x:ReturnType<typeof countNavigation>)=>question(x,s=>s.replace('eng review CLEAR','eng review CLEAR if the next test passes')),
}))countNavigationCheck('rejects '+name,false,edit);
for(const suffix of ['-extra','/extra','.ts','?mode=extra'])countNavigationCheck('rejects Design command '+suffix,false,x=>{x.call.questions[0]!.options[1]!.description+=` Run /plan-design-review${suffix}.`;});
for(const id of [1,2]) {
 countNavigationCheck(`initial scope ${id} preserves labels despite summarized descriptions`,true,x=>countRecord(x,id,s=>s.replace(/^(?:Remove the Promise|AuthBroker, SessionMint)[^\n]+/m,'Summary of the offered scope.')));
 countNavigationCheck(`initial scope ${id} cannot lose accepted scope`,false,x=>countRecord(x,id,s=>s.replace(/^Accepted scope: .+$/m,'Accepted scope: Approved.')));
 countNavigationCheck(`initial scope ${id} cannot change offered label`,false,x=>countRecord(x,id,s=>s.replace(/^B\) .+$/m,'B) Build another service')));
}
countNavigationCheck('initial deferral cannot silently keep feature',false,x=>countRecord(x,1,s=>s.replace('removed from this refactor','kept in this refactor')));
countNavigationCheck('initial structure cannot lose selected author condition',false,x=>countRecord(x,2,s=>s.replace(/; plan must state .+$/m,'')));
countNavigationCheck('initial structure cannot waive condition after approval',false,x=>countRecord(x,2,s=>s.replace('History: none','The author input condition is waived.\nHistory: none')));
countNavigationCheck('current blocked condition cannot be waived',false,x=>question(x,s=>s+'\nThe author input condition is waived.'));
countNavigationCheck('new Design route command sentence punctuation',true,x=>{x.call.questions[0]!.options[1]!.description+=' Run /plan-design-review.';});
countNavigationCheck('explicit navigation disclaimer cannot bypass title',false,x=>{question(x,s=>s+'\nNavigation only; approves no new implementation changes.');x.plan=x.plan.replace('# Plan: Multi-tenant Auth Refactor','# Plan: Other');});
countNavigationCheck('withdrawn graph prerequisite is not readiness',false,x=>{x.plan=x.plan.replace('blocked on author input','author input waived');});
countNavigationCheck('wrong blocked task author is not readiness',false,x=>{x.plan=x.plan.replace("Author writes `TokenStore`'s responsibility","Author writes `AnotherStore`'s responsibility");});
countNavigationCheck('initial action header cannot recast substantive approval',false,x=>{const c=x.priorCalls[2]!;c.questions[0]!.header='D3 scope';countRecord(x,3,s=>s.replace('Header: D3 cache DI','Header: D3 scope').replace(c.questions[0]!.question,'(initial scope selector) "'+c.questions[0]!.question.split('\n')[0]!.replace(/^D3 — /,'')+'"'));});
countNavigationCheck('bold current fields bind the same actual state',true,x=>countRecord(x,6,s=>s.replace(/^State:/m,'**State:**').replace(/^Accepted scope:/m,'**Accepted scope:**')));
countNavigationCheck('bold scope cannot conceal unknown acceptance',false,x=>countRecord(x,6,s=>s.replace(/^Accepted scope: .+$/m,'**Accepted scope:** unknown')));
countNavigationCheck('current deferral reversal cannot borrow earlier scope',false,x=>countRecord(x,1,s=>s.replace('History: none','Correction: Promise.all stays in this refactor.\nHistory: none')));
countNavigationCheck('historical deferral reversal remains inert',true,x=>countRecord(x,1,s=>s.replace('History: none','History: Promise.all stays in this refactor.')));
countNavigationCheck('later native deferral reversal stays current',false,x=>question(x,s=>s+'\nCorrection: Promise.all stays in this refactor.'));
for(const id of [7,8,9]) {
 countNavigationCheck(`TODO ${id} cannot borrow unrelated recorded topic`,false,x=>countRecord(x,id,s=>s.replace(/^### T[1-9]\d*: TODO — .+$/m,`### T${id}: TODO — Add customer analytics`)));
 countNavigationCheck(`TODO ${id} cannot borrow another native question`,false,x=>{const c=x.priorCalls[id-1]!;question({call:c},s=>s.replace(/^D[1-9]\d* — TODO: .+$/m,`D${id} — TODO: Add customer analytics?`));});
}
countNavigationCheck('TODO cannot borrow missing proposal heading',false,x=>{x.plan=x.plan.replace('### Cache IDP discovery metadata and JWKS per issuer, then re-evaluate parallelization','### Add customer analytics');});
countNavigationCheck('TODO cannot borrow changed proposal action',false,x=>{x.plan=x.plan.replace('**What:** Add per-issuer caches for OIDC discovery','**What:** Add customer analytics to track shopping carts');});
countNavigationCheck('TODO cannot borrow duplicate proposal',false,x=>{const proposal=x.plan.slice(x.plan.indexOf('### Cache IDP discovery metadata and JWKS per issuer'),x.plan.indexOf('### Remove `auth.brokerFlow`'));x.plan=x.plan.replace('### Bound the AuthCache entry count',proposal+'### Bound the AuthCache entry count');});
countNavigationCheck('other-topic deferral correction is inert',true,x=>countRecord(x,1,s=>s.replace('History: none','Correction: Customer analytics stays in this refactor.\nHistory: none')));
countNavigationCheck('historical native deferral correction is inert',true,x=>question(x,s=>s+'\nEarlier note: "Promise.all stays in this refactor."'));
for(const topic of ['', 'Cache'])countNavigationCheck('TODO short caption cannot prove identity '+JSON.stringify(topic),false,x=>countRecord(x,7,s=>s.replace(/^### T7: TODO — .+$/m,'### T7: TODO — '+topic)));
countNavigationCheck('example proposal cannot supply current TODO',false,x=>{x.plan=x.plan.replace('### Cache IDP discovery metadata and JWKS per issuer','Example:\n### Cache IDP discovery metadata and JWKS per issuer');});
countNavigationCheck('quoted proposal cannot supply current TODO',false,x=>{x.plan=x.plan.replace('### Cache IDP discovery metadata and JWKS per issuer','## Historical examples\n### Cache IDP discovery metadata and JWKS per issuer');});
countNavigationCheck('TODO without native What cannot bind a proposal',false,x=>{question({call:x.priorCalls[6]!},s=>s.replace(/^What: .+\n/m,''));});
countNavigationCheck('TODO with duplicate native What cannot bind a proposal',false,x=>{question({call:x.priorCalls[6]!},s=>s+'\nWhat: Add customer analytics.');});
countNavigationCheck('TODO with duplicate saved What cannot bind a proposal',false,x=>{x.plan=x.plan.replace('**What:** Add per-issuer caches','**What:** Add customer analytics.\n**What:** Add per-issuer caches');});
const retryNavigation=()=>({plan:retryPacket.report,call:structuredClone(retryPacket.calls.at(-1)!) as NativePlanQuestionCall,priorCalls:structuredClone(retryPacket.calls.slice(0,-1)) as NativePlanQuestionCall[]});
function retryNavigationCheck(name:string,expected:boolean,edit?:(x:ReturnType<typeof retryNavigation>)=>void){test('retry native ledger navigation: '+name,()=>{const x=retryNavigation();edit?.(x);expect(isEngCompletionHandoff(nativePlanCallFingerprint(x.call,0,false),x.plan,x.priorCalls)).toBe(expected);});}
retryNavigationCheck('actual Ready/CEO/DevEx menu with nine approved records',true);
function retryRecord(x:ReturnType<typeof retryNavigation>,id:number,edit:(s:string)=>string){
 x.plan=x.plan.replace(new RegExp(`^### R${id}:[\\s\\S]*?(?=^### R[1-9]\\d*:|^## |$(?![\\s\\S]))`,'m'),edit);
}
retryNavigationCheck('reordered offered review routes',true,x=>x.call.questions[0]!.options.reverse());
for(const index of [1,2])retryNavigationCheck('optional review selected '+index,true,x=>{const q=x.call.questions[0]!;x.call.answers={[q.question]:q.options[index]!.label};});
for(const command of ['/ship','/plan-ceo-review','/plan-devex-review']){
 retryNavigationCheck('exact review command with sentence punctuation '+command,true,x=>{x.call.questions[0]!.options[2]!.description+=` Run ${command}.`;});
 for(const suffix of ['-extra','/extra','.ts','?mode=extra'])retryNavigationCheck('rejects command token '+command+suffix,false,x=>{x.call.questions[0]!.options[2]!.description+=` Run ${command}${suffix}.`;});
}
retryNavigationCheck('equivalent current settled assertion',true,x=>question(x,s=>s.replace('every open call was decided','all decisions are answered')));
retryNavigationCheck('initial scope and TODO can retain full native questions',true,x=>{
 for(const id of [1,2,7,8,9])retryRecord(x,id,s=>s.replace(new RegExp(`^Question D${id}: .+$`,'m'),`Question D${id}:\n${x.priorCalls[id-1]!.questions[0]!.question}`));
});
retryNavigationCheck('parallel lane declaration order is immaterial',true,x=>{x.plan=x.plan.replace('Launch A + B + C in parallel','Launch C + A + B in parallel');});
retryNavigationCheck('prior record history cannot revoke its current approval',true,x=>retryRecord(x,6,s=>s.replace('History: none','History: R6 is withdrawn.')));
retryNavigationCheck('explicit historical quoted withdrawal remains inert',true,x=>question(x,s=>s+'\nEarlier note: "R3 is revoked."'));
retryNavigationCheck('explicit navigation disclaimer retains the owned title',true,x=>question(x,s=>s+'\nNavigation only; approves no new implementation changes.'));
for(const [name,edit] of Object.entries({
 'foreign title':(s:string)=>s.replace('# Plan: Multi-tenant Auth Refactor (reviewed)','# Plan: Foreign Task (reviewed)'),
 'duplicate title':(s:string)=>s.replace('# Plan: Multi-tenant Auth Refactor (reviewed)','# Plan: Multi-tenant Auth Refactor (reviewed)\n# Plan: Foreign Task'),
 'missing title':(s:string)=>s.replace('# Plan: Multi-tenant Auth Refactor (reviewed)\n',''),
}))retryNavigationCheck('explicit disclaimer cannot bypass '+name,false,x=>{question(x,s=>s+'\nNavigation only; approves no new implementation changes.');x.plan=edit(x.plan);});
retryNavigationCheck('independent source path uses the same native owner',true,x=>{
 x.plan=x.plan.replaceAll('PLAN.md','AUTH-PLAN.md');
 for(const call of x.priorCalls)question({call},s=>s.replaceAll('PLAN.md','AUTH-PLAN.md'));
});
for(const [name,edit] of Object.entries({
 'unanswered navigation':(x:ReturnType<typeof retryNavigation>)=>{x.call.answered=false;x.call.unansweredQuestionIndices=[0];},
 'failed navigation':(x:ReturnType<typeof retryNavigation>)=>{x.call.failed=true;},
 'missing native acknowledgment':(x:ReturnType<typeof retryNavigation>)=>{delete x.call.answeredAt;},
 'unknown selected navigation':(x:ReturnType<typeof retryNavigation>)=>{x.call.answers={[x.call.questions[0]!.question]:'Other'};},
 'missing prior answer':(x:ReturnType<typeof retryNavigation>)=>{x.priorCalls[2]!.answered=false;x.priorCalls[2]!.unansweredQuestionIndices=[0];},
 'failed prior answer':(x:ReturnType<typeof retryNavigation>)=>{x.priorCalls[2]!.failed=true;},
 'missing prior timestamp':(x:ReturnType<typeof retryNavigation>)=>{delete x.priorCalls[2]!.answeredAt;},
 'late prior approval':(x:ReturnType<typeof retryNavigation>)=>{x.priorCalls[2]!.answeredAt=x.call.answeredAt;},
 'foreign prior session':(x:ReturnType<typeof retryNavigation>)=>{x.priorCalls[2]!.sessionId='foreign';},
 'duplicate native identity':(x:ReturnType<typeof retryNavigation>)=>{x.priorCalls[2]!.toolUseId=x.priorCalls[1]!.toolUseId;},
 'missing prior native call':(x:ReturnType<typeof retryNavigation>)=>{x.priorCalls.splice(2,1);},
 'changed native selection':(x:ReturnType<typeof retryNavigation>)=>{const c=x.priorCalls[2]!,q=c.questions[0]!;c.answers={[q.question]:q.options[1]!.label};},
 'foreign current branch':(x:ReturnType<typeof retryNavigation>)=>question(x,s=>s.replace(' on main —',' on other —')),
 'foreign current title':(x:ReturnType<typeof retryNavigation>)=>question(x,s=>s.replace('Multi-tenant Auth Refactor plan','Other Refactor plan')),
 'foreign reviewed source':(x:ReturnType<typeof retryNavigation>)=>{x.plan=x.plan.replace('Reviewed target: `PLAN.md`','Reviewed target: `OTHER.md`');},
 'duplicate current owner':(x:ReturnType<typeof retryNavigation>)=>question(x,s=>s+'\nProject/branch/task: other on main — Other plan, eng review CLEAR.'),
 'foreign native and saved owner':(x:ReturnType<typeof retryNavigation>)=>{const c=x.priorCalls[2]!,old=c.questions[0]!.question;question({call:c},s=>s.replace('main — PLAN.md','other — PLAN.md'));x.plan=x.plan.replace(old,c.questions[0]!.question);},
 'conflicting native source':(x:ReturnType<typeof retryNavigation>)=>{const c=x.priorCalls[2]!,old=c.questions[0]!.question;question({call:c},s=>s.replace('structure fixed','OTHER.md applies; structure fixed'));x.plan=x.plan.replace(old,c.questions[0]!.question);},
 'no settled decisions':(x:ReturnType<typeof retryNavigation>)=>question(x,s=>s.replace('every open call was decided','some open calls remain')),
 'conditional completion':(x:ReturnType<typeof retryNavigation>)=>question(x,s=>s.replace('eng review CLEAR','eng review CLEAR if another test passes')),
 'quoted completion':(x:ReturnType<typeof retryNavigation>)=>question(x,s=>s.replace('eng review CLEAR','"eng review CLEAR"').replace('all relevant reviews are complete','all relevant reviews have a report')),
 'current completion withdrawn':(x:ReturnType<typeof retryNavigation>)=>question(x,s=>s+'\nThe engineering review is withdrawn.'),
 'current no longer clear':(x:ReturnType<typeof retryNavigation>)=>question(x,s=>s+'\nThe review is no longer clear.'),
 'current newly unresolved count':(x:ReturnType<typeof retryNavigation>)=>question(x,s=>s+'\nThere are 2 unresolved decisions.'),
 'revoked current record':(x:ReturnType<typeof retryNavigation>)=>retryRecord(x,6,s=>s.replace('State: approved','State: revoked')),
 'unknown accepted scope':(x:ReturnType<typeof retryNavigation>)=>retryRecord(x,6,s=>s.replace(/^Accepted scope: .+$/m,'Accepted scope: unknown')),
 'conditional accepted scope':(x:ReturnType<typeof retryNavigation>)=>retryRecord(x,6,s=>s.replace('Accepted scope: ','Accepted scope: If approved, ')),
 'missing accepted scope':(x:ReturnType<typeof retryNavigation>)=>retryRecord(x,6,s=>s.replace(/^Accepted scope: .+\n/m,'')),
 'duplicate current state':(x:ReturnType<typeof retryNavigation>)=>retryRecord(x,6,s=>s.replace('State: approved','State: approved\nState: approved')),
 'changed saved answer':(x:ReturnType<typeof retryNavigation>)=>retryRecord(x,6,s=>s.replace('Actual answer: A —','Actual answer: B —')),
 'missing saved header':(x:ReturnType<typeof retryNavigation>)=>retryRecord(x,6,s=>s.replace(/^Header: .+\n/m,'')),
 'changed saved option':(x:ReturnType<typeof retryNavigation>)=>retryRecord(x,6,s=>s.replace('Record legacyAuthFlow() outcomes for 10 scenarios','Record new-path outcomes for 10 scenarios')),
 'incomplete substantive question':(x:ReturnType<typeof retryNavigation>)=>retryRecord(x,6,s=>s.replace(x.priorCalls[5]!.questions[0]!.question,'Regression summary only.')),
 'substantive summary borrowed from selector rules':(x:ReturnType<typeof retryNavigation>)=>retryRecord(x,6,s=>s.replace(`Question D6:\n${x.priorCalls[5]!.questions[0]!.question}`,'Question D6: How do we prove AuthBroker matches legacyAuthFlow() before the flag reaches 100%?')),
 'wrong summarized scope question':(x:ReturnType<typeof retryNavigation>)=>retryRecord(x,1,s=>s.replace('Question D1: Defer','Question D1: Implement')),
 'wrong readiness answer':(x:ReturnType<typeof retryNavigation>)=>{x.plan=x.plan.replace('R6 (D6=A)','R6 (D6=B)');},
 'missing current record':(x:ReturnType<typeof retryNavigation>)=>retryRecord(x,6,_=>''),
 'later approval withdrawal':(x:ReturnType<typeof retryNavigation>)=>{const c=x.priorCalls[7]!,old=c.questions[0]!.question;question({call:c},s=>s+'\nD3 is revoked.');x.plan=x.plan.replace(old,c.questions[0]!.question);},
 'quoted withdrawal in current navigation':(x:ReturnType<typeof retryNavigation>)=>question(x,s=>s+'\nCorrection: R3 is "revoked".'),
 'historical whole catalog':(x:ReturnType<typeof retryNavigation>)=>{x.plan='## Historical example\n'+x.plan.replace(/^# Plan:/,'### Plan:');},
 'fenced whole report':(x:ReturnType<typeof retryNavigation>)=>{x.plan='```md\n'+x.plan+'\n```';},
 'missing report':(x:ReturnType<typeof retryNavigation>)=>{x.plan=x.plan.slice(0,x.plan.indexOf('## GSTACK REVIEW REPORT'));},
 'unresolved report':(x:ReturnType<typeof retryNavigation>)=>{x.plan=x.plan.replace('NO UNRESOLVED DECISIONS','One decision unresolved');},
 'current critical gap in Eng row':(x:ReturnType<typeof retryNavigation>)=>{x.plan=x.plan.replace('| 44 issues, 0 critical gaps |','| 44 issues, 2 critical gaps |');},
 'new ready implementation':(x:ReturnType<typeof retryNavigation>)=>{x.call.questions[0]!.options[0]!.description+=' Also add Redis.';},
 'new CEO implementation':(x:ReturnType<typeof retryNavigation>)=>{x.call.questions[0]!.options[1]!.description+=' Then rewrite the router.';},
 'new DevEx implementation':(x:ReturnType<typeof retryNavigation>)=>{x.call.questions[0]!.options[2]!.description+=' Also create a new adapter.';},
 'quoted implementation':(x:ReturnType<typeof retryNavigation>)=>question(x,s=>s+'\nAlso "add Redis" before implementation.'),
 'deployment approval':(x:ReturnType<typeof retryNavigation>)=>question(x,s=>s+'\nApprove deployment.'),
 'new arbitrary command':(x:ReturnType<typeof retryNavigation>)=>{x.call.questions[0]!.options[2]!.description+=' Run ./deploy.sh.';},
 'new task reference':(x:ReturnType<typeof retryNavigation>)=>{x.call.questions[0]!.options[0]!.description=x.call.questions[0]!.options[0]!.description!.replace('T1–T9','T1–T10');},
 'missing interior task':(x:ReturnType<typeof retryNavigation>)=>{x.plan=x.plan.replace('**T4 (','**T44 (');},
 'new catalog obligation':(x:ReturnType<typeof retryNavigation>)=>{x.plan=x.plan.replace('## Implementation Tasks','## Implementation Tasks\n- [ ] **T10 (P1)** — Add Redis');},
 'task withdrawal':(x:ReturnType<typeof retryNavigation>)=>{x.plan=x.plan.replace('  - Verify: boundary tests:','  - Correction: T2 is withdrawn.\n  - Verify: boundary tests:');},
 'skipped task':(x:ReturnType<typeof retryNavigation>)=>question(x,s=>s+'\nSkip T1.'),
 'changed prerequisite':(x:ReturnType<typeof retryNavigation>)=>question(x,s=>s+'\nT1 depends on T9.'),
 'changed task order':(x:ReturnType<typeof retryNavigation>)=>question(x,s=>s+'\nT3 before T1.'),
 'wrong lane count':(x:ReturnType<typeof retryNavigation>)=>{x.call.questions[0]!.options[0]!.description=x.call.questions[0]!.options[0]!.description!.replace('3 lanes','4 lanes');},
 'unknown lane in menu':(x:ReturnType<typeof retryNavigation>)=>question(x,s=>s+'\nLanes A+B then Z.'),
 'changed launch grouping':(x:ReturnType<typeof retryNavigation>)=>{x.plan=x.plan.replace('Launch A + B + C in parallel','Launch A + B in parallel');},
 'missing graph step':(x:ReturnType<typeof retryNavigation>)=>{x.plan=x.plan.replace(/^\| S4 .+\n/m,'');},
 'unknown dependency':(x:ReturnType<typeof retryNavigation>)=>{x.plan=x.plan.replace('| S5, S6 |','| S5, S99 |');},
 'dependency after consumer':(x:ReturnType<typeof retryNavigation>)=>{x.plan=x.plan.replace('S4 → S5 → S7','S5 → S4 → S7');},
 'parallel consumer of another lane':(x:ReturnType<typeof retryNavigation>)=>{x.plan=x.plan.replace('| auth/broker, auth/errors | S1 |','| auth/broker, auth/errors | S1, S3 |');},
}))retryNavigationCheck('rejects '+name,false,edit);
test('retry navigation binds its own fingerprint and independent native exit evidence',()=>{
 const x=retryNavigation(),fp=nativePlanCallFingerprint(x.call,0,false);
 expect(isEngCompletionHandoff({...fp,signature:'foreign:call'},x.plan,x.priorCalls)).toBe(false);
 expect(isEngCompletionHandoff({...fp,nativeQuestionIndex:1},x.plan,x.priorCalls)).toBe(false);
 expect(isEngCompletionHandoff({...fp,options:fp.options.slice(0,2)},x.plan,x.priorCalls)).toBe(false);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'eng-retry-navigation-')),file=path.join(dir,'report.md');
 try{
  fs.writeFileSync(file,x.plan);const at=retryPacket.provenance.report.mtimeMs;fs.utimesSync(file,at/1000,at/1000);
  const transcript:PlanCountTranscript={status:'ready',calls:[...x.priorCalls,x.call],assistantMessages:[],planReadyRequests:structuredClone(retryPacket.planReadyRequests)};
  const admin=new Set([fp.signature]),start=Date.parse(retryPacket.windowStart);
  const check=(t=transcript,ids=admin)=>hasNativePlanTerminal(t,file,start,'plan_ready',ids);
  expect(isEngCompletionHandoff(fp,x.plan,x.priorCalls)).toBe(true);expect(check()).toBe(true);
  expect(planCountQuestionPhase(fp,true,()=>false,undefined,undefined,()=>true).administrative).toBe('completion-handoff');
  expect(check(transcript,new Set())).toBe(false);expect(check(transcript,new Set(['foreign:call']))).toBe(false);
  for(const edit of [
   (t:PlanCountTranscript)=>{t.planReadyRequests=[];},
   (t:PlanCountTranscript)=>{t.planReadyRequests![0]!.failed=true;},
   (t:PlanCountTranscript)=>{t.planReadyRequests![0]!.sessionId='foreign';},
   (t:PlanCountTranscript)=>{t.planReadyRequests![0]!.timestamp=new Date(start-1).toISOString();},
   (t:PlanCountTranscript)=>{t.calls[5]!.answeredAt=x.call.answeredAt;},
  ]){const t=structuredClone(transcript);edit(t);expect(check(t)).toBe(false);}
  fs.writeFileSync(file,'## GSTACK REVIEW REPORT\n');fs.utimesSync(file,at/1000,at/1000);expect(check()).toBe(false);
  // Replaying public events tests the detector; it cannot promote the paid run.
  expect(retryPacket.originalOutcome).toBe('timeout');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
const heldNavigation=()=>{const h=structuredClone(heldPackets.held6bd);return {...h,call:h.transcript.calls.at(-1)!,priorCalls:h.transcript.calls.slice(0,-1)};};
function heldNavigationCheck(name:string,expected:boolean,edit?:(x:any)=>void){test('held6bd navigation '+name,()=>{const x=heldNavigation();edit?.(x);expect(isEngCompletionHandoff(nativePlanCallFingerprint(x.call,0,false),x.plan,x.priorCalls)).toBe(expected);});}
heldNavigationCheck('actual completed owned menu',true);
heldNavigationCheck('reordered options',true,x=>x.call.questions[0].options.reverse());
heldNavigationCheck('optional CEO chosen',true,x=>x.call.answers[x.call.questions[0].question]=x.call.questions[0].options[1].label);
heldNavigationCheck('equivalent no-change scope',true,x=>question(x,s=>s.replace('nothing here changes the plan or its tasks','the plan and its tasks remain unchanged')));
heldNavigationCheck('equivalent settled status',true,x=>question(x,s=>s.replace('0 unresolved decisions','no unresolved decisions')));
heldNavigationCheck('historical completion correction is inert',true,x=>question(x,s=>s+'\nEarlier note: "The review is no longer clear."'));
for(const [name,edit] of Object.entries({
 'foreign branch':(x:any)=>question(x,s=>s.replace('main, PLAN.md','other, PLAN.md')),
 'foreign source':(x:any)=>question(x,s=>s.replace('main, PLAN.md','main, OTHER.md')),
 'foreign title':(x:any)=>{x.plan=x.plan.replace('# Plan: Multi-tenant Auth Refactor','# Plan: Other Refactor');},
}))heldNavigationCheck('owned current catalog cannot bypass '+name+' with legacy disclaimer',false,x=>{question(x,s=>s+'\nIt does not change implementation.');edit(x);});
for(const [name,edit] of Object.entries({
 'current no-longer-complete correction':(x:any)=>question(x,s=>s+'\nCorrection: The review is no longer clear.'),
 'current newly unresolved count':(x:any)=>question(x,s=>s+'\nCorrection: There are 2 unresolved decisions.'),
 'duplicate reviewed target':(x:any)=>{x.plan=x.plan.replace('Reviewed target:', 'Reviewed target: `OTHER.md` (repo root, branch `main`)\nReviewed target:');},
 'conflicting source in metadata':(x:any)=>question(x,s=>s.replace('; eng review CLEAR','; OTHER.md applies; eng review CLEAR')),
 'implementation approval':(x:any)=>{x.call.questions[0].options[0].description+=' Also approve deployment.';},
 'deployment action':(x:any)=>{x.call.questions[0].options[1].description+=' Then deploy to production.';},
}))heldNavigationCheck('current class rejects '+name,false,edit);
for(const [name,edit] of Object.entries({
 'foreign primary plan':(x:any)=>question(x,s=>s.replace('main, PLAN.md','main, OTHER.md')),
 'foreign branch':(x:any)=>question(x,s=>s.replace('main, PLAN.md','other, PLAN.md')),
 'foreign title':(x:any)=>{x.plan=x.plan.replace('# Plan: Multi-tenant Auth Refactor','# Plan: Another Refactor');},
 'duplicate source':(x:any)=>question(x,s=>s+'\nProject/branch/task: main, OTHER.md "Other"'),
 'comparison does not own source':(x:any)=>question(x,s=>s.replace('main, PLAN.md','main, OTHER.md Other; compare PLAN.md')),
 'foreign reviewed target':(x:any)=>{x.plan=x.plan.replace('Reviewed target: `PLAN.md`','Reviewed target: `OTHER.md`');},
 'unanswered':(x:any)=>{x.call.answered=false;x.call.unansweredQuestionIndices=[0];},
 'missing ACK':(x:any)=>{delete x.call.answeredAt;},
 'unpublished interior task':(x:any)=>{x.plan=x.plan.replace('**T3 (','**T33 (');},
 'new task':(x:any)=>question(x,s=>s.replace('T1-T9','T1-T10')),
 'current incomplete':(x:any)=>question(x,s=>s+'\nCorrection: The review is incomplete.'),
 'current reopened':(x:any)=>question(x,s=>s+'\nCorrection: One decision is reopened.'),
 'current quoted status':(x:any)=>question(x,s=>s+'\nCorrection: The review is "pending".'),
 'conditional completion':(x:any)=>question(x,s=>s.replace('eng review CLEAR','eng review CLEAR if more tests pass')),
 'report unresolved':(x:any)=>{x.plan=x.plan.replace('NO UNRESOLVED DECISIONS','One unresolved decision');},
 'quoted report':(x:any)=>{x.plan='```md\n'+x.plan+'\n```';},
 'new ready action':(x:any)=>{x.call.questions[0].options[0].description+=' Also add Redis.';},
 'new optional action':(x:any)=>{x.call.questions[0].options[1].description+=' Then replace the database.';},
 'new arbitrary command':(x:any)=>{x.call.questions[0].options[0].description+=' Run ./deploy.sh.';},
 'new quoted command':(x:any)=>{x.call.questions[0].options[0].description+=' Also "write a cache adapter".';},
 'explicit wrong lane':(x:any)=>{x.call.questions[0].options[0].description+=' Lanes A then Z.';},
}))heldNavigationCheck('rejects '+name,false,edit);
const plan=a.plan;
function check(name:string,expected:boolean,mutate?:(x:any)=>void) {
 test(name,()=>{
  const x={call:structuredClone(a.call),plan};mutate?.(x);
  const fp=nativePlanCallFingerprint(x.call,0,false);
  expect(isEngCompletionHandoff(fp,x.plan,a.priorCalls)).toBe(expected);
 });
}
function question(x:any,f:(s:string)=>string) {const q=x.call.questions[0],answer=x.call.answers[q.question];q.question=f(q.question);x.call.answers={[q.question]:answer};}
check('actual captured acknowledged D16 + acknowledged report',true);
check('reordered ready and optional review choices',true,x=>x.call.questions[0].options.reverse());
check('optional review answer changes route, not report',true,x=>x.call.answers[x.call.questions[0].question]=x.call.questions[0].options[1].label);
check('plural native navigation header',true,x=>x.call.questions[0].header='Next steps');
check('independent decision ordinal',true,x=>question(x,s=>s.replace('D16 —','D27:')));
check('different task count is bound to same catalog',true,x=>{question(x,s=>s.replaceAll('T1–T10','T1–T9'));x.call.questions[0].options[0].description=x.call.questions[0].options[0].description.replace('T1–T10','T1–T9');});
check('new task reference',false,x=>{question(x,s=>s.replaceAll('T1–T10','T1–T11'));x.call.questions[0].options[0].description=x.call.questions[0].options[0].description.replace('T1–T10','T1–T11');});
check('different existing task subsets remain a recap',true,x=>question(x,s=>s.replaceAll('T1–T10','T2–T9')));
check('changed lane order',false,x=>x.call.questions[0].options[0].description=x.call.questions[0].options[0].description.replace('A+B, then C+D','C+D, then A+B'));
check('changed lane grouping',false,x=>x.call.questions[0].options[0].description=x.call.questions[0].options[0].description.replace('A+B, then C+D','A+C, then B+D'));
check('unpublished lane',false,x=>x.call.questions[0].options[0].description=x.call.questions[0].options[0].description.replace('then E','then F'));
check('task withdrawn in own current task',false,x=>x.plan=x.plan.replace('  - Verify: matrix green against legacy; replayed green against new path before swap','  - Correction: T1 is withdrawn.'));
check('missing published task',false,x=>x.plan=x.plan.replace('**T3 (P1,','**T99 (P1,'));
check('quoted whole plan',false,x=>x.plan=x.plan.split('\n').map((s:string)=>'> '+s).join('\n'));
check('fenced whole plan',false,x=>x.plan='```markdown\n'+x.plan+'\n```');
check('foreign historical task heading',false,x=>x.plan=x.plan.replace('## Implementation Tasks','## Historical Implementation Tasks'));
check('incomplete report',false,x=>x.plan=x.plan.replace('NO UNRESOLVED DECISIONS','Unresolved decisions pending'));
check('missing report',false,x=>x.plan=x.plan.slice(0,x.plan.indexOf('## GSTACK REVIEW REPORT')));
check('reopened report',false,x=>x.plan=x.plan.replace('CLEAR (mode: SCOPE_REDUCED)','NOT CLEARED'));
check('unanswered native call',false,x=>{x.call.answered=false;x.call.unansweredQuestionIndices=[0];});
check('failed native call',false,x=>x.call.failed=true);
check('unoffered answer',false,x=>x.call.answers[x.call.questions[0].question]='Do something else');
check('missing acknowledgment',false,x=>delete x.call.answeredAt);
check('multiselect',false,x=>x.call.questions[0].multiSelect=true);
check('bundled substantive question',false,x=>x.call.questions.push(structuredClone(a.priorCalls[0].questions[0])));
check('new requirement option',false,x=>x.call.questions[0].options.push({label:'Add another datastore'}));
check('implementation option disguised as navigation',false,x=>x.call.questions[0].options[0].label+=' and add Redis');
check('new action in ready description',false,x=>x.call.questions[0].options[0].description+=' Add a datastore first.');
check('new action in optional description',false,x=>x.call.questions[0].options[1].description+=' Install a new cache before review.');
check('new obligation in metadata',false,x=>question(x,s=>s+'\nA new dependency is required before implementation.'));
check('conditional closure',false,x=>question(x,s=>s.replace('review is done','review will be done')));
check('withdrawn closure',false,x=>question(x,s=>s.replace('review is done','review is not done')));
check('quoted question',false,x=>question(x,s=>'> '+s));

check('fully reworded brief and descriptions, same actions and catalog',true,x=>{
 question(x,_=>"D27: What is the next workflow?\nThe engineering review is complete. This only selects the next workflow; it does not authorize any implementation change. Tasks T1 through T10 are ready. The approved sequence is lanes A+B then C+D then E. A further CEO review is optional. All required reviews are clear.\nChoose the implementation route or the optional strategy review.");
 x.call.questions[0].options[0].description='The reviewed tasks T1 to T10 are ready. The current implementation plan remains unchanged. No further engineering approval is needed.';
 x.call.questions[0].options[1].description='An optional strategy review offers another perspective. The engineering result remains clear; the cost is one more review.';
});
check('different clause order and wrapping',true,x=>{
 question(x,s=>s.replace('This is navigation only; it approves no implementation change.','It does not modify implementation. This is routing only.').replace('The engineering review is done and logged clean:','The Eng review is finished and logged clean:').replaceAll('T1–T10','T1 through T10'));
 x.call.questions[0].options[0].description='T1–T10 are already covered by the reviewed plan; lanes A+B then C+D then E. The Eng review is clear and all decisions are settled.';
 x.call.questions[0].options[1].description='A CEO strategy review remains optional. It costs another review cycle and adds perspective.';
});
check('same tasks and renamed published lanes',true,x=>{
 for(const [old,neo] of [['A','V'],['B','W'],['C','X'],['D','Y'],['E','Z']]) {
  x.plan=x.plan.replaceAll('Lane '+old+':','Lane '+neo+':');
 }
 x.plan=x.plan.replace('launch A + B in parallel worktrees; merge. Launch C + D in parallel; merge. Then E.','launch V + W in parallel worktrees; merge. Launch X + Y in parallel; merge. Then Z.');
 x.call.questions[0].options[0].description=x.call.questions[0].options[0].description.replace('A+B, then C+D, then E','V+W, then X+Y, then Z');
});
check('a later new-work command after a no-change assertion still fails',false,x=>question(x,s=>s+' Also externalize token state into Redis.'));
check('current review is only conditionally complete',false,x=>question(x,s=>s.replace('The engineering review is done','The engineering review is done if we add caching')));
check('quoted completion does not supply present closure',false,x=>question(x,s=>s.replace('The engineering review is done','Historical: The engineering review is done')));


test('the real completed navigation preserves freshness only for its own acknowledged answer',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'eng-published-navigation-')),file=path.join(dir,'review.md');
 try {
  fs.writeFileSync(file,plan);const at=Date.parse(a.reportWriteAt);fs.utimesSync(file,at/1000,at/1000);
  const call=structuredClone(a.call) as NativePlanQuestionCall;
  const fp=nativePlanCallFingerprint(call,0,false),isHandoff=isEngCompletionHandoff(fp,plan,a.priorCalls as NativePlanQuestionCall[]);
  for(const started of [false,true])expect(planCountQuestionPhase(fp,started,()=>false,undefined,undefined,()=>isHandoff))
    .toEqual({preReview:false,reviewStarted:started,administrative:'completion-handoff'});
  const transcript:PlanCountTranscript={status:'ready',calls:[...structuredClone(a.priorCalls),call] as NativePlanQuestionCall[],assistantMessages:[],planReadyRequests:structuredClone(a.planReadyRequests)};
  const admin=new Set(isHandoff?[fp.signature]:[]),check=(t=transcript,ids=admin)=>hasNativePlanTerminal(t,file,Date.parse(a.startedAt),'plan_ready',ids);
  expect(check()).toBe(true);expect(check(transcript,new Set())).toBe(false);expect(check(transcript,new Set(['foreign:call']))).toBe(false);
  for(const mutate of [
   (t:PlanCountTranscript)=>{t.calls[0]!.answeredAt=call.answeredAt;},
   (t:PlanCountTranscript)=>{t.calls[1]!.answered=false;t.calls[1]!.unansweredQuestionIndices=[0];},
   (t:PlanCountTranscript)=>{t.planReadyRequests=[];},
   (t:PlanCountTranscript)=>{t.planReadyRequests![0]!.failed=true;},
   (t:PlanCountTranscript)=>{t.planReadyRequests![0]!.sessionId='foreign';},
  ]){const t=structuredClone(transcript);mutate(t);expect(check(t)).toBe(false);}
  fs.writeFileSync(file,'## GSTACK REVIEW REPORT\n');fs.utimesSync(file,at/1000,at/1000);expect(check()).toBe(false);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

for (const conjunction of ['and', 'but', 'then']) check(`a nonmodifying clause cannot hide ${conjunction} an implementation command`, false, x =>
  question(x, s => s.replace('it approves no implementation change.', `it approves no implementation change ${conjunction} add Redis caching.`)));
for (const [open, close] of [['"', '"'], ['“', '”']]) {
  check(`a wholly ${open}quoted${close} question cannot assert current closure`, false, x => question(x, s => open + s + close));
  check(`quoted ${open}completion${close} alone does not establish current closure`, false, x => question(x, s => s.replace('The engineering review is done and logged clean', open + 'The engineering review is done and logged clean' + close).replace('the Eng gate is the only required one and it is CLEAR', 'there is an engineering gate').replace('all required reviews are complete', 'the task catalog is available')));
}

for (const [open, close] of [['"', '"'], ['“', '”'], ["'", "'"], ['‘', '’']]) {
  for (const template of ['The implementation requirement is COMMAND.', 'Also COMMAND before implementation.']) {
    check(`raw ${open}quoted work${close} remains a veto: ${template}`, false, x =>
      question(x, s => s + '\n' + template.replace('COMMAND', open + 'add Redis caching' + close)));
  }
}


import currentMenu from './fixtures/eng-completed-navigation-cab3.json';
function currentMenuCheck(name:string,expected:boolean,mutate?:(x:any)=>void) {
 test(`completed current menu: ${name}`,()=>{
  const x=structuredClone(currentMenu);mutate?.(x);
  expect(isEngCompletionHandoff(nativePlanCallFingerprint(x.call,0,false),x.plan,x.priorCalls)).toBe(expected);
 });
}
currentMenuCheck('actual D19 ready versus optional CEO with published task references',true);
currentMenuCheck('reordered options and independent ordinal',true,x=>{x.call.questions[0].options.reverse();question(x,s=>s.replace('D19 —','D31:'));});
currentMenuCheck('equivalent current decision-only routing',true,x=>question(x,s=>s.replace('The only question left is whether to start building or first get a strategy-level second look.','Only the next workflow remains: implementation or an optional strategy review.')));
currentMenuCheck('explicit lane sequence must still match the published sequence',true,x=>{x.call.questions[0].options[0].description=x.call.questions[0].options[0].description.replace('ordered with lanes','ordered with lanes A then B then C');x.plan=x.plan.replace('Execution: launch A and B in parallel worktrees. Merge both. Then C.','Execution: launch A; then B; then C.');});
for(const [name,mutate] of Object.entries({
 'unanswered':(x:any)=>{x.call.answered=false;x.call.unansweredQuestionIndices=[0];},
 'failed':(x:any)=>{x.call.failed=true;},
 'unknown answer':(x:any)=>{x.call.answers[x.call.questions[0].question]='Other';},
 'missing ACK':(x:any)=>{delete x.call.answeredAt;},
 'bundled work question':(x:any)=>{x.call.questions.push(structuredClone(x.priorCalls[3].questions[0]));},
 'new task':(x:any)=>{x.call.questions[0].options[0].description=x.call.questions[0].options[0].description.replace('T1-T9','T1-T10');},
 'missing task':(x:any)=>{x.plan=x.plan.replace('**T6 (','**T99 (');},
 'unpublished lane':(x:any)=>{x.call.questions[0].options[0].description+=' Lanes A then Z.';},
 'changed lane grouping':(x:any)=>{x.call.questions[0].options[0].description+=' Lanes A+C then B.';},
 'missing current report':(x:any)=>{x.plan=x.plan.slice(0,x.plan.indexOf('## GSTACK REVIEW REPORT'));},
 'reopened report':(x:any)=>{x.plan=x.plan.replace('CLEAR (PLAN)','NOT CLEARED');},
 'quoted report':(x:any)=>{x.plan='```md\n'+x.plan+'\n```';},
 'historical catalog':(x:any)=>{x.plan=x.plan.replace('## Implementation Tasks','## Historical tasks');},
 'withdrawn task':(x:any)=>{x.plan=x.plan.replace('  - Verify: six scenarios green for both implementations before any tenant is allowlisted','  - Correction: T6 is withdrawn.');},
 'foreign plan title':(x:any)=>{x.plan=x.plan.replace('# Plan: Multi-tenant Auth Refactor (reviewed)','# Plan: Different Auth Refactor (reviewed)');},
 'quoted completion':(x:any)=>{question(x,s=>s.replace('Eng Review CLEAR','"Eng Review CLEAR"'));},
 'conditional completion':(x:any)=>{question(x,s=>s.replace('Eng Review CLEAR','Eng Review CLEAR if more tests pass'));},
 'negative completion':(x:any)=>{question(x,s=>s.replace('Eng Review CLEAR','Eng Review not CLEAR'));},
 'other decision remains':(x:any)=>{question(x,s=>s.replace('The only question left is whether','Another question is whether'));},
 'new work in ready label':(x:any)=>{x.call.questions[0].options[0].label+=' and add Redis';},
 'new work in ready description':(x:any)=>{x.call.questions[0].options[0].description+=' Also add Redis.';},
 'new work in CEO description':(x:any)=>{x.call.questions[0].options[1].description+=' Then rewrite the router.';},
 'new requirement in brief':(x:any)=>{question(x,s=>s+'\nA new dependency is required.');},
 'additional imperative':(x:any)=>{question(x,s=>s+'\nAlso externalize token state into Redis.');},
 'quoted imperative':(x:any)=>{question(x,s=>s+'\nAlso "add Redis" before implementation.');},
 'subordinate action':(x:any)=>{question(x,s=>s+'\nStart building while deleting the old database.');},
}))currentMenuCheck(name,false,mutate);

test('current completed D19 alone is administrative; report and other answers retain exact freshness',()=>{
 const x=structuredClone(currentMenu), dir=fs.mkdtempSync(path.join(os.tmpdir(),'eng-current-menu-')),file=path.join(dir,'review.md');
 const now=Date.now;
 try {
  Date.now=()=>Date.parse(x.captureAt);fs.writeFileSync(file,x.plan);fs.utimesSync(file,x.reportMtimeMs/1000,x.reportMtimeMs/1000);
  const fp=nativePlanCallFingerprint(x.call,0,false),admin=new Set(isEngCompletionHandoff(fp,x.plan,x.priorCalls)?[fp.signature]:[]);
  const transcript:PlanCountTranscript={status:'ready',calls:[...x.priorCalls,x.call],assistantMessages:[],planReadyRequests:x.planReadyRequests};
  const check=(t=transcript,ids=admin)=>hasNativePlanTerminal(t,file,x.startedAt,'plan_ready',ids);
  expect(check()).toBe(true);expect(check(transcript,new Set())).toBe(false);expect(check(transcript,new Set(['foreign:call']))).toBe(false);
  for(const mutate of [
   (t:PlanCountTranscript)=>{t.calls[0]!.answeredAt=x.call.answeredAt;},
   (t:PlanCountTranscript)=>{t.calls[0]!.answered=false;t.calls[0]!.unansweredQuestionIndices=[0];},
   (t:PlanCountTranscript)=>{t.planReadyRequests=[];},
   (t:PlanCountTranscript)=>{t.planReadyRequests![0]!.failed=true;},
   (t:PlanCountTranscript)=>{t.planReadyRequests![0]!.sessionId='foreign';},
  ]){const t=structuredClone(transcript);mutate(t);expect(check(t)).toBe(false);}
 }finally{Date.now=now;fs.rmSync(dir,{recursive:true,force:true});}
});

for(const action of ['adding Redis','rewriting the router','replacing the database','dropping a table','building a second service'])
 currentMenuCheck(`subordinate new work: ${action}`,false,x=>question(x,s=>s+'\nStart building while '+action+'.'));
for(const status of ['Not every decision is answered.', 'Some decisions remain open.', 'One decision is unresolved.'])
 currentMenuCheck(`current unresolved decision: ${status}`,false,x=>question(x,s=>s+'\nCorrection: '+status));
currentMenuCheck('quoted historical decision status is not a current withdrawal',true,x=>question(x,s=>s+'\nEarlier note: "One decision is unresolved."'));
currentMenuCheck('quoted current scalar status still withdraws completion',false,x=>question(x,s=>s+'\nCorrection: One decision is "unresolved".'));

function investigationCheck(name:string,expected:boolean,mutate?:(x:any)=>void){
 test('approved investigation recap: '+name,()=>{const x=structuredClone(currentMenu.pendingInvestigationRetry);mutate?.(x);expect(isEngCompletionHandoff(nativePlanCallFingerprint(x.call,0,false),x.plan,x.priorCalls)).toBe(expected);});
}
investigationCheck('actual D15 repeats the earlier owned investigation without approving cache work',true);
investigationCheck('option order and independent navigation ordinal',true,x=>{x.call.questions[0].options.reverse();question(x,s=>s.replace('D15 —','D32:'));});
investigationCheck('the inapplicable Design option may be absent',true,x=>{x.call.questions[0].options=x.call.questions[0].options.filter((o:any)=>!o.label.includes('/plan-design-review'));});
investigationCheck('historical quoted withdrawal cannot erase current owned approval',true,x=>{x.plan=x.plan.replace('## GSTACK REVIEW REPORT','Earlier note: "R6 is withdrawn."\n\n## GSTACK REVIEW REPORT');});
for(const [name,mutate] of Object.entries({
 'missing earlier approval':(x:any)=>{x.priorCalls=[];},
 'foreign session approval':(x:any)=>{x.priorCalls[0].sessionId+='-foreign';},
 'unanswered approval':(x:any)=>{x.priorCalls[0].answered=false;},
 'failed approval':(x:any)=>{x.priorCalls[0].failed=true;},
 'late approval':(x:any)=>{x.priorCalls[0].answeredAt=x.call.answeredAt;},
 'changed selected approval':(x:any)=>{const c=x.priorCalls[0];c.answers={[c.questions[0].question]:c.questions[0].options[1].label};},
 'a later same-row decision supersedes approval':(x:any)=>{const c=structuredClone(x.priorCalls[0]);c.toolUseId+='-later';c.answeredAt=x.priorCalls[1].answeredAt;x.priorCalls.push(c);},
 'foreign earlier source':(x:any)=>{const c=x.priorCalls[0],q=c.questions[0],a=c.answers[q.question];q.question=q.question.replaceAll('PLAN.md','OTHER.md');c.answers={[q.question]:a};},
 'unknown navigation answer':(x:any)=>{x.call.answers={[x.call.questions[0].question]:'Other'};},
 'unanswered navigation':(x:any)=>{x.call.answered=false;},
 'selected further review':(x:any)=>{x.call.answers={[x.call.questions[0].question]:x.call.questions[0].options[1].label};},
 'foreign reviewed plan':(x:any)=>{x.plan=x.plan.replace('# Plan: Multi-tenant Auth Refactor','# Plan: Different Refactor');},
 'foreign ledger source':(x:any)=>{x.plan=x.plan.replace('confidence 5/10, PLAN.md:31','confidence 5/10, OTHER.md:31');},
 'historical ledger':(x:any)=>{x.plan=x.plan.replace('## Decision ledger','## Historical decision ledger');},
 'quoted ledger':(x:any)=>{x.plan=x.plan.replace('### R6: Per-issuer IDP metadata caching','> ### R6: Per-issuer IDP metadata caching');},
 'changed current ledger answer':(x:any)=>{x.plan=x.plan.replace('Actual answer: C) Investigate before choosing (D12)','Actual answer: A) Apply now (D12)');},
 'implementation is now approved':(x:any)=>{x.plan=x.plan.replace('No cache implementation approved.','Cache implementation is approved.');},
 'approved instead of pending ledger':(x:any)=>{x.plan=x.plan.replace('State: pending (Investigate)','State: approved');},
 'another unresolved footer item':(x:any)=>{x.plan+='- R7 / D13 — another pending implementation decision (T7)\n';},
 'missing current report':(x:any)=>{x.plan=x.plan.slice(0,x.plan.indexOf('## GSTACK REVIEW REPORT'));},
 'unpublished task':(x:any)=>{x.plan=x.plan.replace('**T6 (P2','**T66 (P2');},
 'task loses followup':(x:any)=>{x.plan=x.plan.replace('Verify: table complete; R6 re-asked','Verify: table complete');},
 'task authorizes new cache work':(x:any)=>{x.plan=x.plan.replace('Verify: table complete; R6 re-asked','Verify: table complete; R6 re-asked\n  - Also implement the metadata cache.');},
 'later current task withdrawal':(x:any)=>{x.plan=x.plan.replace('## GSTACK REVIEW REPORT','T6 is withdrawn.\n\n## GSTACK REVIEW REPORT');},
 'later current issue reopening':(x:any)=>{x.plan=x.plan.replace('## GSTACK REVIEW REPORT','R6 is reopened.\n\n## GSTACK REVIEW REPORT');},
 'larger task catalog in menu':(x:any)=>{x.call.questions[0].options[0].description=x.call.questions[0].options[0].description.replace('10 tasks','11 tasks');},
 'larger lane catalog in menu':(x:any)=>{x.call.questions[0].options[0].description=x.call.questions[0].options[0].description.replace('4 parallel lanes','5 parallel lanes');},
 'new work in current question':(x:any)=>{question(x,s=>s+'\nAlso deploy to production.');},
 'new work in selected option':(x:any)=>{x.call.questions[0].options[0].description+=' Also implement the metadata cache.';},
 'new work in unselected option':(x:any)=>{x.call.questions[0].options[1].description+=' Also approve the metadata cache.';},
 'quoted current new work':(x:any)=>{question(x,s=>s+'\nAlso "add Redis" before implementation.');},
}))investigationCheck(name,false,mutate);
investigationCheck('consistent distinct issue, task, decision and project identities',true,x=>{
 const replace=(s:string)=>s.replaceAll('R6','R16').replaceAll('D12','D22').replace(/\bT6\b/g,'T26').replaceAll('Multi-tenant Auth Refactor','Tenant Validation Migration');
 x.plan=replace(x.plan);question(x,replace);
 x.call.questions[0].options.forEach((o:any)=>{o.description=replace(o.description);});
 x.priorCalls=x.priorCalls.map((c:any)=>{const v={call:c};question(v,replace);c.questions[0].header=replace(c.questions[0].header);return c;});
});
investigationCheck('equivalent completion and routing prose need no seven-line envelope',true,x=>{
 question(x,s=>s.replace('The engineering review is done','The eng review is finished').replace('every P1 fix is approved','all P1 remedies are approved').replace('The remaining choice is whether another review pass adds value before coding starts.','The only remaining choice is the next workflow.').replace('\nStakes if we pick wrong:', '\n\nTradeoff:'));
});
investigationCheck('published investigation fields may reorder',true,x=>{
 x.plan=x.plan.replace('  - Files: this plan, "The 5 IDP calls" table\n  - Verify: table complete; R6 re-asked','  - Verify: table complete; R6 re-asked\n  - Files: this plan, "The 5 IDP calls" table');
});
for(const [name,mutate] of Object.entries({
 'current approved-scope additive implementation':(x:any)=>{x.plan=x.plan.replace('No cache implementation approved.','No cache implementation approved. Also deploy the metadata cache.');},
 'current approved-scope reverses its own approval':(x:any)=>{x.plan=x.plan.replace('No cache implementation approved.','No cache implementation approved. Correction: cache implementation is approved.');},
 'current quoted issue withdrawal':(x:any)=>{x.plan=x.plan.replace('## GSTACK REVIEW REPORT','R6 is "withdrawn".\n\n## GSTACK REVIEW REPORT');},
 'quoted source title cannot own current review':(x:any)=>{x.plan=x.plan.replace('# Plan: Multi-tenant Auth Refactor (reviewed)','> # Plan: Multi-tenant Auth Refactor (reviewed)');},
 'later report has another pending state':(x:any)=>{x.plan=x.plan.replace('## Implementation Tasks','### R7: Another issue\nState: pending (Investigate)\n\n## Implementation Tasks');},
 'current task is moved to a different source':(x:any)=>{x.plan=x.plan.replace('Files: this plan, "The 5 IDP calls" table','Files: OTHER.md, "The 5 IDP calls" table');},
 'inventory table is inconsistent with accepted scope':(x:any)=>{x.plan=x.plan.replace('Files: this plan, "The 5 IDP calls" table','Files: this plan, "Users to delete" table');},
 'current task contains a subordinate action':(x:any)=>{x.plan=x.plan.replace('sequence any dependent pair; feeds R6','sequence any dependent pair while deploying the cache; feeds R6');},
 'prior offered investigation adds implementation':(x:any)=>{x.priorCalls[0].questions[0].options[0].description+=' Also deploy the cache.';},
 'navigation claims a new implementation approval':(x:any)=>{question(x,s=>s+'\nCache implementation is now approved.');},
}))investigationCheck(name,false,mutate);

test('approved investigation recap preserves every independent native terminal requirement',()=>{
 const x=structuredClone(currentMenu.pendingInvestigationRetry),dir=fs.mkdtempSync(path.join(os.tmpdir(),'eng-investigation-menu-')),file=path.join(dir,'review.md'),now=Date.now;
 try{
  Date.now=()=>Date.parse(x.captureAt);fs.writeFileSync(file,x.plan);fs.utimesSync(file,x.reportMtimeMs/1000,x.reportMtimeMs/1000);
  const fp=nativePlanCallFingerprint(x.call,0,false),admin=new Set(isEngCompletionHandoff(fp,x.plan,x.priorCalls)?[fp.signature]:[]);
  const transcript:PlanCountTranscript={status:'ready',calls:[...x.priorCalls,x.call],assistantMessages:[],planReadyRequests:x.planReadyRequests};
  const check=(t=transcript,ids=admin)=>hasNativePlanTerminal(t,file,x.startedAt,'plan_ready',ids);
  expect(check()).toBe(true);expect(check(transcript,new Set())).toBe(false);expect(check(transcript,new Set(['foreign:call']))).toBe(false);
  for(const mutate of [
   (t:PlanCountTranscript)=>{t.calls[1]!.answeredAt=x.call.answeredAt;}, // unrelated TODO is still modifying
   (t:PlanCountTranscript)=>{t.calls[0]!.answeredAt=x.call.answeredAt;},
   (t:PlanCountTranscript)=>{t.calls.at(-1)!.answered=false;t.calls.at(-1)!.unansweredQuestionIndices=[0];},
   (t:PlanCountTranscript)=>{t.planReadyRequests=[];},
   (t:PlanCountTranscript)=>{t.planReadyRequests![0]!.timestamp=x.priorCalls[0]!.answeredAt;},
   (t:PlanCountTranscript)=>{t.planReadyRequests![0]!.failed=true;},
   (t:PlanCountTranscript)=>{t.planReadyRequests![0]!.sessionId='foreign';},
  ]){const t=structuredClone(transcript);mutate(t);expect(check(t)).toBe(false);}
  expect(fs.statSync(file).mtimeMs).toBeCloseTo(x.reportMtimeMs,0);
  fs.writeFileSync(file,'## GSTACK REVIEW REPORT\n');fs.utimesSync(file,x.reportMtimeMs/1000,x.reportMtimeMs/1000);expect(check()).toBe(false);
 }finally{Date.now=now;fs.rmSync(dir,{recursive:true,force:true});}
});
for(const option of [0,1])for(const command of ['Also drop the token table.','Then run ./deploy.sh.','Also replace the database.','Also enable the new cache.'])
 investigationCheck(`peer command boundary option ${option}: ${command}`,false,x=>{x.call.questions[0].options[option].description+=' '+command;});
investigationCheck('foreign required followup cannot borrow the owned reask exception',false,x=>{question(x,s=>s+'\nR7 must be re-asked after T6.');});
investigationCheck('foreign current target cannot borrow the named comparison',false,x=>question(x,s=>s.replace('on main, Multi-tenant Auth Refactor plan.','on main, Different Refactor plan; compare Multi-tenant Auth Refactor plan.')));
investigationCheck('foreign prior target cannot borrow a source comparison',false,x=>{const c=x.priorCalls[0];question({call:c},s=>s.replace('`main`, PLAN.md Multi-tenant Auth Refactor;','`main`, OTHER.md Different Refactor; compare PLAN.md Multi-tenant Auth Refactor;'));});
investigationCheck('every interior task in the recapped range must be published',false,x=>{x.plan=x.plan.replace('**T3 (P1','**T33 (P1');});
for(const verb of ['write','record','capture','switch','refactor','expand','reduce','alter'])for(const option of [0,1])
 investigationCheck(`complete existing action class ${verb} option ${option}`,false,x=>{x.call.questions[0].options[option].description+=` Also ${verb} the implementation.`;});
for(const status of ['The review is incomplete.','The review is unfinished.','The review is not done.','The review is not complete.','The review is done if the investigation finishes.','R6 is a blocker.','R6 is now blocking.','The investigation is a blocker.','The investigation is no longer optional.'])
 investigationCheck(`current completion and nonblocking status: ${status}`,false,x=>question(x,s=>s+'\nCorrection: '+status));
for(const status of ['R6 is a blocker.','R6 is now blocking.','R6 is no longer optional.'])
 investigationCheck(`later report correction remains authoritative: ${status}`,false,x=>{x.plan=x.plan.replace('## GSTACK REVIEW REPORT','Correction: '+status+'\n\n## GSTACK REVIEW REPORT');});
investigationCheck('owned scope cannot withdraw investigation without restating issue ID',false,x=>{x.plan=x.plan.replace('History: none','Correction: The investigation is cancelled.\nHistory: none');});
investigationCheck('historical quoted incomplete review remains inert',true,x=>question(x,s=>s+'\nEarlier note: "The review is incomplete."'));
investigationCheck('historical quoted blocker remains inert',true,x=>{x.plan=x.plan.replace('## GSTACK REVIEW REPORT','Earlier note: "R6 is a blocker."\n\n## GSTACK REVIEW REPORT');});
for(const status of ['The review is pending.','The review is reopened.','The review is withdrawn.','The review is superseded.','The review is cancelled.','The review is rejected.','The review is complete only after the investigation.','Not every P1 fix is approved.','All P1 fixes are not approved.','R6 is required before implementation.','R6 is "a blocker".'])
 investigationCheck(`complete current-state class: ${status}`,false,x=>question(x,s=>s+'\nCorrection: '+status));
investigationCheck('later native explicitly reopens the owned issue outside the issue-title grammar',false,x=>{const c=x.priorCalls[1];question({call:c},s=>s+'\nCorrection: R6 is reopened.');});
investigationCheck('later native explicitly approves implementation for the owned issue',false,x=>{const c=x.priorCalls[1];question({call:c},s=>s+'\nCorrection: R6 implementation is approved.');});
investigationCheck('later unrelated reference to owned issue is inert',true,x=>{const c=x.priorCalls[1];question({call:c},s=>s+'\nR6 remains the previously approved investigation.');});
investigationCheck('later historical quoted reopening is inert',true,x=>{const c=x.priorCalls[1];question({call:c},s=>s+'\nEarlier note: "R6 is reopened."');});
investigationCheck('an unrelated previously approved task stays approved',true,x=>{x.plan=x.plan.replace('## GSTACK REVIEW REPORT','T2 implementation is approved.\n\n## GSTACK REVIEW REPORT');});


const currentLedgerCf74 = currentMenu.currentLedgerCf74;
const ledgerNavigationCf74 = (name: 'first' | 'retry', reconcile = false) => {
  const x = structuredClone(currentLedgerCf74[name]);
  const call = x.transcript.calls.at(-1)!;
  if (reconcile) {
    expect((x.plan.match(/^State: pending$/gm) ?? []).length).toBe(6);
    x.plan = x.plan.replace(/^State: pending$/gm, 'State: approved');
  }
  return { ...x, call, priorCalls: x.transcript.calls.slice(0, -1) };
};
const ledgerHandoffCf74 = (x: ReturnType<typeof ledgerNavigationCf74>) =>
  isEngCompletionHandoff(nativePlanCallFingerprint(x.call, 0, false), x.plan, x.priorCalls);
test('cf74 current ledger preserves both actual contradictory handoffs as negatives', () => {
  expect(ledgerHandoffCf74(ledgerNavigationCf74('first'))).toBe(false);
  expect(ledgerHandoffCf74(ledgerNavigationCf74('retry'))).toBe(false);
  expect(ledgerHandoffCf74(ledgerNavigationCf74('first', true))).toBe(false);
});
test('cf74 counterfactual reconciled current states permit reviewed issues-open navigation only', () => {
  const x = ledgerNavigationCf74('retry', true);
  expect(ledgerHandoffCf74(x)).toBe(true);
  expect(x.plan).toContain('| ISSUES OPEN |');
  expect(x.plan).toContain('NO UNRESOLVED DECISIONS');
});

function ledgerCheckCf74(name: string, expected: boolean, edit: (x: ReturnType<typeof ledgerNavigationCf74>) => void) {
  test('cf74 current-ledger navigation ' + name, () => {
    const x = ledgerNavigationCf74('retry', true); edit(x); expect(ledgerHandoffCf74(x)).toBe(expected);
  });
}
for (const [name, edit] of Object.entries({
  'one decision still pending': (x:any) => { x.plan=x.plan.replace('State: approved','State: pending'); },
  'missing current State': (x:any) => { x.plan=x.plan.replace('State: approved\n',''); },
  'missing State cannot borrow another row duplicate': (x:any) => { x.plan=x.plan.replace('State: approved\n','').replace('State: approved','State: approved\nState: approved'); },
  'duplicate current State': (x:any) => { x.plan=x.plan.replace('State: approved','State: approved\nState: approved'); },
  'quoted State cannot approve': (x:any) => { x.plan=x.plan.replace('State: approved','State: "approved"'); },
  'quoted current row': (x:any) => { x.plan=x.plan.replace('### R3:', '> ### R3:'); },
  'archived current row': (x:any) => { x.plan=x.plan.replace('### R3:', '### Archived R3:'); },
  'withdrawn ledger owner': (x:any) => { x.plan=x.plan.replace('## Decision ledger','## Withdrawn Decision ledger'); },
  'quoted entire ledger': (x:any) => { x.plan=x.plan.replace(/(## Decision ledger[\s\S]*?)(?=## Review output)/, (s:string)=>s.split('\n').map(l=>'> '+l).join('\n')); },
  'missing actual answer': (x:any) => { x.plan=x.plan.replace(/^Actual answer:.*\n/m,''); },
  'different actual answer': (x:any) => { x.plan=x.plan.replace('Actual answer: Defer TokenStore (D4)','Actual answer: Keep TokenStore (D4)'); },
  'duplicate actual answer': (x:any) => { x.plan=x.plan.replace('Actual answer: Defer TokenStore (D4)','Actual answer: Defer TokenStore (D4)\nActual answer: Defer TokenStore (D4)'); },
  'missing accepted scope': (x:any) => { x.plan=x.plan.replace(/^Accepted scope:.*\n/m,''); },
  'missing approval reference': (x:any) => { x.plan=x.plan.replace('Actual answer: Defer TokenStore (D4)','Actual answer: Defer TokenStore'); },
  'foreign approval reference': (x:any) => { x.plan=x.plan.replace('Actual answer: Defer TokenStore (D4)','Actual answer: Defer TokenStore (D44)'); },
  'readiness missing a current record': (x:any) => { x.plan=x.plan.replace('PASS — S1 (D4), ', 'PASS — '); },
  'readiness claims an unpublished record': (x:any) => { x.plan=x.plan.replace('PASS — S1 (D4)', 'PASS — R99 (D99), S1 (D4)'); },
  'current scope withdrawal': (x:any) => { x.plan=x.plan.replace('### R4:', 'Correction: R3 scope is withdrawn.\n\n### R4:'); },
  'current quoted state correction': (x:any) => { x.plan=x.plan.replace('### R4:', 'Correction: State is "pending".\n\n### R4:'); },
  'missing prior answer': (x:any) => { x.priorCalls[3].answered=false; },
  'failed prior answer': (x:any) => { x.priorCalls[3].failed=true; },
  'unacknowledged prior answer': (x:any) => { delete x.priorCalls[3].answeredAt; },
  'foreign prior session': (x:any) => { x.priorCalls[3].sessionId='foreign'; },
  'duplicate native identity': (x:any) => { x.priorCalls.push(structuredClone(x.priorCalls[3])); },
  'duplicate native decision ID': (x:any) => { question({call:x.priorCalls[4]},(s:string)=>s.replace(/^D5/, 'D4')); },
  'prior answer after navigation': (x:any) => { x.priorCalls[3].answeredAt=x.call.answeredAt; },
  'different prior selected option': (x:any) => { const c=x.priorCalls[3],q=c.questions[0];c.answers[q.question]=q.options[1].label; },
  'prior mixed question packet': (x:any) => { const c=x.priorCalls[3];c.questions.push(structuredClone(c.questions[0])); },
  'later native reopens owned decision': (x:any) => { question({call:x.priorCalls[12]},(s:string)=>s+'\nCorrection: R3 is reopened.'); },
  'later native withdraws accepted scope': (x:any) => { question({call:x.priorCalls[12]},(s:string)=>s+'\nCorrection: D9 approval is revoked.'); },
  'foreign current source': (x:any) => { question(x,(s:string)=>s.replace('of PLAN.md finished','of OTHER.md finished; compare PLAN.md')); },
  'foreign current branch': (x:any) => { question(x,(s:string)=>s.replace('task: main;', 'task: other;')); },
  'foreign current report title': (x:any) => { x.plan=x.plan.replace('# Plan: Multi-tenant Auth Refactor', '# Plan: Other plan'); },
  'foreign current target': (x:any) => { x.plan=x.plan.replace('Reviewed target: `PLAN.md`', 'Reviewed target: `OTHER.md`'); },
  'duplicate current target': (x:any) => { x.plan=x.plan.replace('Reviewed target:', 'Reviewed target: `OTHER.md` ("Other") in repo, branch `main`.\nReviewed target:'); },
  'foreign prior target with expected comparison': (x:any) => { question({call:x.priorCalls[6]},(s:string)=>s.replace('Architecture on PLAN.md', 'Architecture on OTHER.md; compare PLAN.md')); },
  'quoted metadata cannot own source': (x:any) => { question(x,(s:string)=>s.replace('Project/branch/task:', '> Project/branch/task:')); },
  'missing interior task': (x:any) => { x.plan=x.plan.replace('**T3 (', '**T33 ('); },
  'duplicate published task': (x:any) => { x.plan=x.plan.replace('**T3 (', '**T2 ('); },
  'new task range': (x:any) => { x.call.questions[0].options[0].description=x.call.questions[0].options[0].description.replace('T1-T10','T1-T11'); },
  'incorrect task count': (x:any) => { question(x,(s:string)=>s.replace('the 10 tasks','the 11 tasks')); },
  'withdrawn current task': (x:any) => { x.plan=x.plan.replace('**T3 (', '**T3 withdrawn ('); },
  'wrong lane ordering': (x:any) => { x.call.questions[0].options[0].description=x.call.questions[0].options[0].description.replace('A+B parallel, then C+D','C+D parallel, then A+B'); },
  'stronger parallelism': (x:any) => { x.call.questions[0].options[0].description=x.call.questions[0].options[0].description.replace('A+B parallel, then C+D','A+B+C+D parallel'); },
  'foreign lane': (x:any) => { x.call.questions[0].options[0].description=x.call.questions[0].options[0].description.replace('then E)', 'then Z)'); },
  'missing lane owner': (x:any) => { x.plan=x.plan.replace('Lane C:', 'Group C:'); },
  'historical-only lane order': (x:any) => { x.plan=x.plan.replace('Execution order:', '> Execution order:'); },
  'report still has an unresolved decision': (x:any) => { x.plan=x.plan.replace('0 unresolved decisions. eng review required.', '1 unresolved decision. eng review required.'); },
  'false clear with critical gaps': (x:any) => { x.plan=x.plan.replace('| ISSUES OPEN |', '| CLEAR |'); },
  'report current completion withdrawn': (x:any) => { x.plan=x.plan.replace('NO UNRESOLVED DECISIONS','Correction: The review is withdrawn.\nNO UNRESOLVED DECISIONS'); },
  'missing unresolved sentinel': (x:any) => { x.plan=x.plan.replace('NO UNRESOLVED DECISIONS',''); },
  'new missing maintenance reference': (x:any) => { x.call.questions[0].options[0].description=x.call.questions[0].options[0].description.replace('(D1)', '(D99)'); },
  'wrong maintenance approval kind': (x:any) => { x.call.questions[0].options[0].description=x.call.questions[0].options[0].description.replace('(D1)', '(D3)'); },
  'unapproved routing choice': (x:any) => { const c=x.priorCalls[0],q=c.questions[0];c.answers[q.question]=q.options[1].label; },
  'unapproved TODO choice': (x:any) => { const c=x.priorCalls[12],q=c.questions[0];c.answers[q.question]=q.options[1].label; },
  'maintenance task lacks owning reference': (x:any) => { x.plan=x.plan.replace('preamble D1','preamble D99').replace('CLAUDE.md (D1)','CLAUDE.md (D99)'); },
  'extra work borrowed from task reference': (x:any) => { x.call.questions[0].options[1].description=x.call.questions[0].options[1].description.replace('a written problem statement', 'a deployed production database'); },
})) ledgerCheckCf74(name,false,edit);
for(const verb of ['add','append','remove','drop','replace','enable','write','record','capture','switch','refactor','expand','reduce','alter','deploy','approve','run'])
  for(const option of [0,1]) ledgerCheckCf74(`new ${verb} command in option ${option}`,false,x=>{x.call.questions[0]!.options[option]!.description+=` Also ${verb} ./production.`;});
for(const correction of ['The review is incomplete.','The review is not complete.','The review is no longer complete.','If the review is complete, proceed.','The review is complete if the task lands.','There is 1 unresolved decision.','Not every decision is answered.','Decision R3 is pending.'])
  ledgerCheckCf74('current status '+correction,false,x=>question(x,s=>s+'\nCorrection: '+correction));
ledgerCheckCf74('quoted command cannot hide extra work',false,x=>question(x,s=>s+'\nAlso "add a cache" before implementing.'));
ledgerCheckCf74('ordinary historical incomplete status is inert',true,x=>question(x,s=>s+'\nEarlier note: "The review is incomplete."'));
ledgerCheckCf74('native options may reorder',true,x=>x.call.questions[0]!.options.reverse());
ledgerCheckCf74('navigation can omit approved maintenance recap',true,x=>{x.call.questions[0]!.options[0]!.description=x.call.questions[0]!.options[0]!.description!.replace(/ ✅ First two edits after exit:[^.]+CLAUDE\.md \(D1\) and create TODOS\.md \(D13\)\./,'');});
ledgerCheckCf74('parallel lane names may reorder within the same group',true,x=>{x.call.questions[0]!.options[0]!.description=x.call.questions[0]!.options[0]!.description!.replace('A+B parallel, then C+D','B+A parallel, then D+C');});
ledgerCheckCf74('section depth follows the published hierarchy',true,x=>{x.plan=x.plan.replace('### Worktree parallelization strategy','## Worktree parallelization strategy');});
ledgerCheckCf74('coherent arbitrary decision, task, branch and plan identities',true,x=>{
  const transform=(s:string)=>s.replace(/\bD(\d+)\b/g,(_,n)=>'D'+(+n+20)).replace(/\bT(\d+)\b/g,(_,n)=>'T'+(+n+30))
    .replaceAll('PLAN.md','SPEC.md').replaceAll('Multi-tenant Auth Refactor','Account Policy Migration').replace(/\bmain\b/g,'topic');
  x.plan=transform(x.plan);question(x,transform);x.call.questions[0]!.options.forEach(o=>{o.description=transform(o.description??'');});
  x.priorCalls.forEach(c=>question({call:c},transform));
});
ledgerCheckCf74('final question cannot repeat an earlier decision identity',false,x=>question(x,s=>s.replace(/^D14/,'D13')));
ledgerCheckCf74('later routing approval withdrawal stays operative',false,x=>question({call:x.priorCalls.at(-1)!},s=>s+'\nCorrection: D1 approval is withdrawn.'));
ledgerCheckCf74('published routing approval withdrawal stays operative',false,x=>{x.plan=x.plan.replace('## GSTACK REVIEW REPORT','D1 approval is revoked.\n\n## GSTACK REVIEW REPORT');});
ledgerCheckCf74('historical quoted routing withdrawal is inert',true,x=>question({call:x.priorCalls.at(-1)!},s=>s+'\nEarlier note: "D1 approval is withdrawn."'));

test('cf74 reconciled navigation retains independent native freshness and exit requirements',()=>{
  const x=ledgerNavigationCf74('retry',true), dir=fs.mkdtempSync(path.join(os.tmpdir(),'eng-current-ledger-terminal-')), file=path.join(dir,'review.md'), now=Date.now;
  try {
    const t=x.transcript as PlanCountTranscript;
    Date.now=()=>Date.parse(t.planReadyRequests!.at(-1)!.timestamp)+1000;
    fs.writeFileSync(file,x.plan);fs.utimesSync(file,x.report.mtimeMs/1000,x.report.mtimeMs/1000);
    const fp=nativePlanCallFingerprint(x.call,0,false), admin=new Set(ledgerHandoffCf74(x)?[fp.signature]:[]);
    const check=(v=t,ids=admin)=>hasNativePlanTerminal(v,file,x.startedAt,'plan_ready',ids);
    expect(check()).toBe(true);expect(check(t,new Set())).toBe(false);expect(check(t,new Set(['foreign:call']))).toBe(false);
    for(const change of [
      (v:PlanCountTranscript)=>{v.planReadyRequests=[];},
      (v:PlanCountTranscript)=>{v.planReadyRequests![0]!.failed=true;},
      (v:PlanCountTranscript)=>{v.planReadyRequests![0]!.sessionId='foreign';},
      (v:PlanCountTranscript)=>{v.planReadyRequests![0]!.timestamp=x.priorCalls[0]!.answeredAt!;},
      (v:PlanCountTranscript)=>{v.calls.at(-1)!.answered=false;v.calls.at(-1)!.unansweredQuestionIndices=[0];},
      (v:PlanCountTranscript)=>{v.calls[6]!.answeredAt=x.call.answeredAt;},
      (v:PlanCountTranscript)=>{v.calls[0]!.answeredAt=x.call.answeredAt;},
    ]){const v=structuredClone(t);change(v);expect(check(v)).toBe(false);}
    expect(fs.statSync(file).mtimeMs).toBeCloseTo(x.report.mtimeMs,0);
    fs.writeFileSync(file,'## GSTACK REVIEW REPORT\n');fs.utimesSync(file,x.report.mtimeMs/1000,x.report.mtimeMs/1000);expect(check()).toBe(false);
  } finally { Date.now=now;fs.rmSync(dir,{recursive:true,force:true}); }
});

import current6aef from './fixtures/eng-6aef-count-public.json';
const current6aefNavigation=()=>({plan:current6aef.report,call:structuredClone(current6aef.calls.at(-1)!) as NativePlanQuestionCall,priorCalls:structuredClone(current6aef.calls.slice(0,-1)) as NativePlanQuestionCall[]});
function current6aefCheck(name:string,expected:boolean,edit?:(x:ReturnType<typeof current6aefNavigation>)=>void){test('6aef navigation: '+name,()=>{const x=current6aefNavigation(),before=JSON.stringify(x);edit?.(x);if(edit)expect(JSON.stringify(x)!==before).toBe(true);expect(isEngCompletionHandoff(nativePlanCallFingerprint(x.call,0,false),x.plan,x.priorCalls)).toBe(expected);});}
function current6aefRecord(x:ReturnType<typeof current6aefNavigation>,id:number,edit:(s:string)=>string){const before=x.plan;x.plan=x.plan.replace(new RegExp(`^### R${id}:[\\s\\S]*?(?=^### |^## |$(?![\\s\\S]))`,'m'),edit);expect(x.plan!==before).toBe(true);}
current6aefCheck('original complete public navigation is administrative',true);
current6aefCheck('outside review choice remains navigation',true,x=>{const q=x.call.questions[0]!;x.call.answers={[q.question]:q.options[1]!.label};});
current6aefCheck('option order remains native',true,x=>x.call.questions[0]!.options.reverse());
current6aefCheck('unnumbered header remains navigation',true,x=>{x.call.questions[0]!.header='Next step';});
current6aefCheck('historical approval withdrawal is inert',true,x=>current6aefRecord(x,2,s=>s.replace('History: none','History: R2 is revoked.')));
current6aefCheck('historical deferred feature reversal is inert',true,x=>current6aefRecord(x,1,s=>s.replace('History: none','History: Promise.all stays in this refactor.')));
for(const [name,edit] of Object.entries({
  'foreign navigation ordinal':(x:ReturnType<typeof current6aefNavigation>)=>{x.call.questions[0]!.header='D99 Next step';},
  'header alone':(x:ReturnType<typeof current6aefNavigation>)=>question(x,_=>'D9 — Next step?'),
  'unanswered navigation':(x:ReturnType<typeof current6aefNavigation>)=>{x.call.answered=false;},
  'unselected label':(x:ReturnType<typeof current6aefNavigation>)=>{x.call.answers={[x.call.questions[0]!.question]:'Other'};},
  'missing earlier answer':(x:ReturnType<typeof current6aefNavigation>)=>{x.priorCalls[0]!.answers={};},
  'foreign earlier session':(x:ReturnType<typeof current6aefNavigation>)=>{x.priorCalls[0]!.sessionId='foreign';},
  'duplicate earlier identity':(x:ReturnType<typeof current6aefNavigation>)=>{x.priorCalls[1]!.toolUseId=x.priorCalls[0]!.toolUseId;},
  'foreign earlier source':(x:ReturnType<typeof current6aefNavigation>)=>{x.priorCalls[0]!.questions[0]!.question=x.priorCalls[0]!.questions[0]!.question.replace('PLAN.md','OTHER.md');},
  'missing target':(x:ReturnType<typeof current6aefNavigation>)=>{x.plan=x.plan.replace('Review target:','Unowned target:');},
  'foreign target source':(x:ReturnType<typeof current6aefNavigation>)=>{x.plan=x.plan.replace('Review target: `PLAN.md`','Review target: `OTHER.md`');},
  'foreign target title':(x:ReturnType<typeof current6aefNavigation>)=>{x.plan=x.plan.replace('("Plan: Multi-tenant Auth Refactor")','("Plan: Other")');},
  'foreign target branch':(x:ReturnType<typeof current6aefNavigation>)=>{x.plan=x.plan.replace('branch `main`, commit','branch `other`, commit');},
  'duplicate wrapper':(x:ReturnType<typeof current6aefNavigation>)=>{x.plan='# Plan: Other\n'+x.plan;},
  'foreign original title':(x:ReturnType<typeof current6aefNavigation>)=>{x.plan=x.plan.replace('# Plan: Multi-tenant Auth Refactor','# Plan: Other');},
  'wrong answer reference':(x:ReturnType<typeof current6aefNavigation>)=>current6aefRecord(x,3,s=>s.replace('(D3 answer)','(D2 answer)')),
  'wrong selected answer caption':(x:ReturnType<typeof current6aefNavigation>)=>current6aefRecord(x,3,s=>s.replace('Actual answer: B) Pure function module','Actual answer: B) Keep as a class')),
  'missing initial scope':(x:ReturnType<typeof current6aefNavigation>)=>current6aefRecord(x,1,s=>s.replace(/^Accepted scope: .+$/m,'Accepted scope: approved')),
  'initial foreign header ordinal':(x:ReturnType<typeof current6aefNavigation>)=>{x.priorCalls[2]!.questions[0]!.header='D99 RequestPolicy';},
  'initial deferral loses prerequisite':(x:ReturnType<typeof current6aefNavigation>)=>current6aefRecord(x,1,s=>s.replace('once regression tests and flattened error handling exist','without regression tests')),
  'initial deferral currently reversed':(x:ReturnType<typeof current6aefNavigation>)=>current6aefRecord(x,1,s=>s.replace('History: none','Correction: Promise.all stays in this refactor.\nHistory: none')),
  'initial adapter changes owner':(x:ReturnType<typeof current6aefNavigation>)=>current6aefRecord(x,2,s=>s.replace('AuthBroker.validateAndDispatch()','ForeignBroker.validateAndDispatch()')),
  'initial adapter loses proof before delete':(x:ReturnType<typeof current6aefNavigation>)=>current6aefRecord(x,2,s=>s.replace('after production proves equivalence','before production proves equivalence')),
  'initial function changes class count':(x:ReturnType<typeof current6aefNavigation>)=>current6aefRecord(x,3,s=>s.replace('Class count 5 → 4','Class count 5 → 14')),
  'initial function adds work':(x:ReturnType<typeof current6aefNavigation>)=>current6aefRecord(x,3,s=>s.replace('Class count 5 → 4.','Class count 5 → 4. Add Redis.')),
  'initial conditional implementation now approved':(x:ReturnType<typeof current6aefNavigation>)=>current6aefRecord(x,4,s=>s.replace('No implementation approved.','Implementation is approved.')),
  'initial conditional responsibility missing':(x:ReturnType<typeof current6aefNavigation>)=>current6aefRecord(x,4,s=>s.replace('required (responsibility,','required (')),
  'substantive saved question changed':(x:ReturnType<typeof current6aefNavigation>)=>current6aefRecord(x,5,s=>s.replace('ELI10:','Explanation:')),
  'substantive saved header changed':(x:ReturnType<typeof current6aefNavigation>)=>current6aefRecord(x,6,s=>s.replace('Header:','Caption:')),
  'substantive description changed':(x:ReturnType<typeof current6aefNavigation>)=>current6aefRecord(x,7,s=>s.replace('Characterization tests against current','Characterization tests after changes to')),
  'current state revoked':(x:ReturnType<typeof current6aefNavigation>)=>current6aefRecord(x,8,s=>s.replace('State: approved','State: revoked')),
  'missing readiness':(x:ReturnType<typeof current6aefNavigation>)=>{x.plan=x.plan.replace('**Approval readiness:','**Review status:');},
  'duplicate readiness':(x:ReturnType<typeof current6aefNavigation>)=>{x.plan=x.plan.replace('**Approval readiness:','Approval readiness: PASS\n**Approval readiness:');},
  'readiness wrong letter':(x:ReturnType<typeof current6aefNavigation>)=>{x.plan=x.plan.replace('R3 (D3 → B)','R3 (D3 → A)');},
  'readiness missing reference':(x:ReturnType<typeof current6aefNavigation>)=>{x.plan=x.plan.replace('R3 (D3 → B), ','');},
  'readiness current reversal':(x:ReturnType<typeof current6aefNavigation>)=>{x.plan=x.plan.replace('**Approval readiness: PASS.**','**Approval readiness: PASS.** R3 is revoked.');},
  'wrong stated decision count':(x:ReturnType<typeof current6aefNavigation>)=>{x.plan=x.plan.replace('- **VERDICT:** ENG CLEARED','9 decisions approved\n- **VERDICT:** ENG CLEARED');},
  'missing task':(x:ReturnType<typeof current6aefNavigation>)=>{x.plan=x.plan.replace('**T2 (','**T22 (');},
  'extra task':(x:ReturnType<typeof current6aefNavigation>)=>{x.plan=x.plan.replace('## Implementation Tasks','## Implementation Tasks\n- [ ] **T8 (P1)** — Add Redis');},
  'withdrawn task':(x:ReturnType<typeof current6aefNavigation>)=>{x.plan=x.plan.replace('Must be green before T5.','Must be green before T5. T1 is withdrawn.');},
  'before dependency reversed':(x:ReturnType<typeof current6aefNavigation>)=>question(x,s=>s.replace('before T5 (adapter)','after T5 (adapter)')),
  'before dependency removed':(x:ReturnType<typeof current6aefNavigation>)=>{x.plan=x.plan.replace('Must be green before T5.','May run after T5.');},
  'independent task actually depends':(x:ReturnType<typeof current6aefNavigation>)=>{x.plan=x.plan.replace('| — (grep for duplicate deny logic first, C3) |','| 1 |');},
  'independent task module changed':(x:ReturnType<typeof current6aefNavigation>)=>{x.plan=x.plan.replace('  - Files: `auth/requestPolicy.ts`','  - Files: `auth/otherPolicy.ts`');},
  'conditional task loses blocker':(x:ReturnType<typeof current6aefNavigation>)=>{x.plan=x.plan.replace('(blocks any TokenStore code)','(TokenStore can proceed)');},
  'unknown graph dependency':(x:ReturnType<typeof current6aefNavigation>)=>{x.plan=x.plan.replace('| 2, 3 |','| 2, 99 |');},
  'changed lane count':(x:ReturnType<typeof current6aefNavigation>)=>question(x,s=>s.replace('5 worktree lanes','6 worktree lanes')),
  'new launch schedule':(x:ReturnType<typeof current6aefNavigation>)=>{x.call.questions[0]!.options[0]!.description+=' Launch lanes A and D now.';},
  'new ready action':(x:ReturnType<typeof current6aefNavigation>)=>{x.call.questions[0]!.options[0]!.description+=' Also add Redis.';},
  'new outside action':(x:ReturnType<typeof current6aefNavigation>)=>{x.call.questions[0]!.options[1]!.description+=' Then rewrite the router.';},
  'outside configuration different':(x:ReturnType<typeof current6aefNavigation>)=>{x.call.questions[0]!.options[1]!.description=x.call.questions[0]!.options[1]!.description!.replace('codex_reviews enabled','model Other');},
  'outside command suffix':(x:ReturnType<typeof current6aefNavigation>)=>{x.call.questions[0]!.options[1]!.description=x.call.questions[0]!.options[1]!.description!.replace('/plan-eng-review','/plan-eng-review-extra');},
  'outside stale disabled state':(x:ReturnType<typeof current6aefNavigation>)=>{x.plan=x.plan.replace(/^(\| Outside Review \|[^\n]+)$/m,s=>s.replace('DISABLED','CLEAN'));},
  'missing final sentinel':(x:ReturnType<typeof current6aefNavigation>)=>{x.plan=x.plan.replace('NO UNRESOLVED DECISIONS','No pending');},
  'conflicting Eng report row':(x:ReturnType<typeof current6aefNavigation>)=>{x.plan=x.plan.replace('- **VERDICT:** ENG CLEARED','| Eng Review | Always | Required | 1 | ISSUES OPEN | 1 critical gap |\n\n- **VERDICT:** ENG CLEARED');},
}))current6aefCheck(name,false,edit);

current6aefCheck('before task prose cannot override missing graph prerequisite',false,x=>{x.plan=x.plan.replace('| 1, 4 |','| 4 |');});
current6aefCheck('before task prose cannot override reversed graph prerequisite',false,x=>{x.plan=x.plan.replace('| 1, 4 |','| 4, 7 |');});
current6aefCheck('before task prose cannot override reversed execution phases',false,x=>{x.plan=x.plan.replace('Launch A + B + C in parallel worktrees. Merge all three. Then launch D and E in parallel.','Launch D and E in parallel worktrees. Merge both. Then launch A+B+C in parallel.');});
current6aefCheck('independent task claims require distinct lanes',false,x=>{x.plan=x.plan.replace('Lane B: step 2 (','Lane B: step 2 → step 3 (').replace('Lane C: step 3 (','Lane C: step 4 (').replace('Lane D: step 4 → step 6 → step 7 (','Lane D: step 6 → step 7 (');});
