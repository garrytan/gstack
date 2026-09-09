import {describe,expect,test} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fixture from './fixtures/ceo-handoff-y-call.json';
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
