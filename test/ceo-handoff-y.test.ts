import {describe,expect,test} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fixture from './fixtures/ceo-handoff-y-call.json';
import zFixture from './fixtures/ceo-handoff-z-call.json';
import type {NativePlanQuestionCall} from './helpers/plan-count-transcript';
import {ceoFirstReviewAUQ,ceoStep0Boundary,hasNativePlanTerminal,nativePlanCallFingerprint,planCountQuestionPhase} from './helpers/claude-pty-runner';
import {isCeoCompletionHandoff,pickCeoCompletionHandoff} from './helpers/ceo-completion-handoff';
const actual=()=>structuredClone(fixture.calls.at(-1)!) as NativePlanQuestionCall;
const fp=(c:NativePlanQuestionCall)=>nativePlanCallFingerprint(c,0,false);
const pending=(c:NativePlanQuestionCall)=>{c.answered=false;delete c.answers;delete c.unansweredQuestionIndices;return fp(c);};
function change(c:NativePlanQuestionCall,fn:(s:string)=>string){const q=c.questions[0]!,a=c.answers![q.question]!;q.question=fn(q.question);c.answers={[q.question]:a};return c;}

describe('Y bare next-Eng navigation is administrative, not completion evidence',()=>{
 test('exact four issues remain while a closed next-workflow menu cannot start review',()=>{
  const c=actual();expect(isCeoCompletionHandoff(fp(c))).toBe(true);expect(pickCeoCompletionHandoff(pending(actual()))).toBe(2);
  expect(pickCeoCompletionHandoff(fp(c))).toBeNull();expect(c.answers![c.questions[0]!.question]).toBe('A) Run /plan-eng-review next (recommended)');
  let started=false;let setup=0,review=0,admin=0;
  for(const c of fixture.calls){const p=planCountQuestionPhase(fp(structuredClone(c) as NativePlanQuestionCall),started,ceoStep0Boundary,ceoFirstReviewAUQ,undefined,isCeoCompletionHandoff);started=p.reviewStarted;if(p.administrative)admin++;else if(p.preReview)setup++;else review++;}
  expect({setup,review,admin}).toEqual({setup:2,review:4,admin:1});
  expect(planCountQuestionPhase(fp(actual()),false,ceoStep0Boundary,ceoFirstReviewAUQ,undefined,isCeoCompletionHandoff)).toEqual({preReview:false,reviewStarted:false,administrative:'completion-handoff'});
 });
 test('either offered navigation answer and option order preserve administrative meaning',()=>{
  const c=actual();c.questions[0]!.options.reverse();
  for(const o of c.questions[0]!.options){c.answers={[c.questions[0]!.question]:o.label};expect(isCeoCompletionHandoff(fp(c))).toBe(true);}
  expect(pickCeoCompletionHandoff(pending(c))).toBe(1);
  expect(isCeoCompletionHandoff(fp(change(actual(),s=>s.replace('D7 - Next step: run','D17 — Next review: Run').replace('plan-ceo-review-next-step','plan-ceo-review-next-review'))))).toBe(true);
 });
 test('whole question and description boundaries reject added product work and unfinished choices',()=>{
  for(const fn of [(s:string)=>s.replace('run /plan-eng-review?', 'fix the cache before /plan-eng-review?'),(s:string)=>s.replace('run /plan-eng-review?', 'run /plan-eng-review? Also repair the cache.'),(s:string)=>'> '+s,(s:string)=>'Example: '+s,(s:string)=>s.replace('plan-ceo-review-next-step','foreign-next-step'),(s:string)=>s+' <gstack-qid:plan-ceo-review-next-step>'])expect(isCeoCompletionHandoff(fp(change(actual(),fn)))).toBe(false);
  for(const i of [0,1])for(const extra of [' Also implement a new cache.',' Resolve the remaining CEO decisions first.',' Should we add another requirement?']){const c=actual();c.questions[0]!.options[i]!.description+=extra;expect(isCeoCompletionHandoff(fp(c))).toBe(false);}
  for(const text of ['Resume the unfinished CEO review.','Proceed directly to implementation and add the missing test.','Eng review is optional.']){const c=actual();c.questions[0]!.options[1]!.description=text;expect(isCeoCompletionHandoff(fp(c))).toBe(false);}
 });
 test('native completion, current offered answer and pending identity remain required',()=>{
  for(const mutate of [(c:NativePlanQuestionCall)=>{c.failed=true;},(c:NativePlanQuestionCall)=>{delete c.failed;},(c:NativePlanQuestionCall)=>{delete c.unansweredQuestionIndices;},(c:NativePlanQuestionCall)=>{c.unansweredQuestionIndices=[0];},(c:NativePlanQuestionCall)=>{c.questions[0]!.multiSelect=true;},(c:NativePlanQuestionCall)=>{c.questions[0]!.header='Issue';},(c:NativePlanQuestionCall)=>{c.questions.push(structuredClone(c.questions[0]!));},(c:NativePlanQuestionCall)=>{c.answers={[c.questions[0]!.question]:'Fix another issue'};}]){const c=actual();mutate(c);expect(isCeoCompletionHandoff(fp(c))).toBe(false);}
  expect(isCeoCompletionHandoff({...fp(actual()),signature:'foreign:call'})).toBe(false);expect(isCeoCompletionHandoff({...fp(actual()),options:[]})).toBe(false);
  expect(pickCeoCompletionHandoff({...pending(actual()),nativeCall:undefined})).toBeNull();expect(pickCeoCompletionHandoff({...pending(actual()),signature:'foreign:call'})).toBeNull();
 });
 test('independent fresh report and native Exit still gate completion; menu alone cannot pass',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gstack-handoff-y-free-'));const report=path.join(dir,'report.md');
  try{fs.writeFileSync(report,fixture.report);const calls=structuredClone(fixture.calls) as NativePlanQuestionCall[];const transcript={status:'ready' as const,calls,assistantMessages:[],planReadyRequests:structuredClone(fixture.planReadyRequests)};const handoff=calls.at(-1)!;const admin=new Set([fp(handoff).signature]);const issueAt=Date.parse(calls.at(-2)!.answeredAt!),handoffAt=Date.parse(handoff.answeredAt!);const started=Date.parse(calls[0]!.answeredAt!)-1000;
   // Controlled metadata only: original Y report mtime was not captured.
   const between=(issueAt+handoffAt)/2;fs.utimesSync(report,between/1000,between/1000);
   expect(hasNativePlanTerminal(transcript,report,started,'plan_ready')).toBe(false);expect(hasNativePlanTerminal(transcript,report,started,'plan_ready',admin)).toBe(true);
   fs.utimesSync(report,(issueAt-1)/1000,(issueAt-1)/1000);expect(hasNativePlanTerminal(transcript,report,started,'plan_ready',admin)).toBe(false);
   fs.utimesSync(report,between/1000,between/1000);expect(hasNativePlanTerminal({...transcript,planReadyRequests:[]},report,started,'plan_ready',admin)).toBe(false);
   expect(hasNativePlanTerminal({...transcript,calls:[handoff]},report,started,'plan_ready',admin)).toBe(false);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
 });
});

describe('Z completed CEO with an unrun required Eng gate',()=>{
 const actualZ=()=>structuredClone(zFixture.calls.at(-1)!) as NativePlanQuestionCall;
 const pendingZ=(c=actualZ())=>{c.answered=false;delete c.answers;delete c.answeredAt;delete c.unansweredQuestionIndices;return c;};
 const reject=(c:NativePlanQuestionCall)=>{expect(isCeoCompletionHandoff(fp(c))).toBe(false);expect(pickCeoCompletionHandoff(fp(c))).toBeNull();};
 test('exact six calls preserve two findings; handoff selects the offered manual route',()=>{
  let started=false;const counts={setup:0,review:0,admin:0};
  for(const c of zFixture.calls){const phase=planCountQuestionPhase(fp(c as NativePlanQuestionCall),started,ceoStep0Boundary,ceoFirstReviewAUQ,undefined,isCeoCompletionHandoff);started=phase.reviewStarted;counts[phase.administrative?'admin':phase.preReview?'setup':'review']++;}
  expect(counts).toEqual({setup:3,review:2,admin:1});expect(isCeoCompletionHandoff(fp(actualZ()))).toBe(true);expect(pickCeoCompletionHandoff(fp(pendingZ()))).toBe(2);
  expect(planCountQuestionPhase(fp(actualZ()),false,ceoStep0Boundary,ceoFirstReviewAUQ,undefined,isCeoCompletionHandoff)).toEqual({preReview:false,reviewStarted:false,administrative:'completion-handoff'});
 });
 test('number, typography and option order are not semantic requirements',()=>{
  const c=change(actualZ(),s=>s.replace('D5 —','D27:').replace("hasn't",'has not').replace("What's",'What is'));c.questions[0]!.options.reverse();
  for(const option of c.questions[0]!.options){c.answers={[c.questions[0]!.question]:option.label};expect(isCeoCompletionHandoff(fp(c))).toBe(true);}
  expect(pickCeoCompletionHandoff(fp(pendingZ(c)))).toBe(1);
 });
 test('whole question and role-specific descriptions cannot hide new or conditional work',()=>{
  for(const fn of [(s:string)=>s.replace('CEO Review is CLEAR','If CEO Review is CLEAR'),(s:string)=>s.replace('CEO Review is CLEAR','CEO Review is not CLEAR'),(s:string)=>s.replace('required shipping gate','optional shipping gate'),(s:string)=>s.replace("What's next?","What's next? Also add retries."),(s:string)=>'> '+s,(s:string)=>'Example: '+s,(s:string)=>'```\n'+s+'\n```',(s:string)=>s.replace('plan-ceo-next-review','foreign-next-review'),(s:string)=>s+' <gstack-qid:plan-ceo-next-review>'])reject(change(actualZ(),fn));
  for(const i of [0,1])for(const extra of [' Also implement the missing checks.',' Rotate credentials.',' Should we add a new requirement?',' Once remaining findings are fixed.']){const c=actualZ();c.questions[0]!.options[i]!.description+=extra;reject(c);}
  const swapped=actualZ();[swapped.questions[0]!.options[0]!.description,swapped.questions[0]!.options[1]!.description]=[swapped.questions[0]!.options[1]!.description,swapped.questions[0]!.options[0]!.description];reject(swapped);
  const optional=actualZ();optional.questions[0]!.options[1]!.description=optional.questions[0]!.options[1]!.description!.replace('required before shipping','optional before shipping');reject(optional);
 });
 test('new arm requires explicit native completion and exact producer pending state',()=>{
  const mutations=[(c:NativePlanQuestionCall)=>{delete c.failed;},(c:NativePlanQuestionCall)=>{c.failed=true;},(c:NativePlanQuestionCall)=>{c.sessionId='';},(c:NativePlanQuestionCall)=>{c.toolUseId='';},(c:NativePlanQuestionCall)=>{c.questions[0]!.header='Issue';},(c:NativePlanQuestionCall)=>{c.questions[0]!.multiSelect=true;},(c:NativePlanQuestionCall)=>{c.questions.push(structuredClone(c.questions[0]!));},(c:NativePlanQuestionCall)=>{c.questions[0]!.options.push({label:'Add a repair',description:'Add a new requirement.'});}];
  for(const mutate of mutations){const c=actualZ();mutate(c);reject(c);const p=pendingZ();mutate(p);reject(p);}
  for(const mutate of [(c:NativePlanQuestionCall)=>{delete c.unansweredQuestionIndices;},(c:NativePlanQuestionCall)=>{c.unansweredQuestionIndices=[0];},(c:NativePlanQuestionCall)=>{c.answers={[c.questions[0]!.question]:'Repair first'};}]){const c=actualZ();mutate(c);reject(c);}
  for(const mutate of [(c:NativePlanQuestionCall)=>{delete (c as any).answered;},(c:NativePlanQuestionCall)=>{c.unansweredQuestionIndices=[];},(c:NativePlanQuestionCall)=>{c.unansweredQuestionIndices=[1];},(c:NativePlanQuestionCall)=>{c.answers={};},(c:NativePlanQuestionCall)=>{c.answeredAt='2026-09-09T12:00:00Z';}]){const c=pendingZ();mutate(c);reject(c);}
  const projected=pendingZ();projected.unansweredQuestionIndices=[0];expect(pickCeoCompletionHandoff(fp(projected))).toBe(2);
  for(const variant of [{...fp(pendingZ()),signature:'foreign:call'},{...fp(pendingZ()),options:[]},{...fp(pendingZ()),nativeQuestionIndex:1}])expect(pickCeoCompletionHandoff(variant)).toBeNull();
 });
 test('retained original mtime passes only with the administrative handoff and real Exit',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gstack-handoff-z-free-'));const report=path.join(dir,'report.md');
  try{fs.writeFileSync(report,zFixture.report);const calls=structuredClone(zFixture.calls) as NativePlanQuestionCall[];const transcript={status:'ready' as const,calls,assistantMessages:[],planReadyRequests:structuredClone(zFixture.planReadyRequests)};const admin=new Set(calls.filter(c=>isCeoCompletionHandoff(fp(c))).map(c=>fp(c).signature));const mtime=Number(BigInt(zFixture.reportOriginalMtimeNs))/1e6;fs.utimesSync(report,mtime/1000,mtime/1000);
   expect(hasNativePlanTerminal(transcript,report,zFixture.startedAt,'plan_ready')).toBe(false);expect(hasNativePlanTerminal(transcript,report,zFixture.startedAt,'plan_ready',admin)).toBe(true);
   expect(hasNativePlanTerminal({...transcript,planReadyRequests:[]},report,zFixture.startedAt,'plan_ready',admin)).toBe(false);
   expect(hasNativePlanTerminal({...transcript,calls:[calls.at(-1)!]},report,zFixture.startedAt,'plan_ready',admin)).toBe(false);
   const stale=Date.parse(calls.at(-2)!.answeredAt!)-1;fs.utimesSync(report,stale/1000,stale/1000);expect(hasNativePlanTerminal(transcript,report,zFixture.startedAt,'plan_ready',admin)).toBe(false);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
 });
});
