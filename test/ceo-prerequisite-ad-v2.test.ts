import {expect,test} from 'bun:test';
import {capturePlanCountQuestion,nativePlanCallFingerprint,planCountPrerequisitePick,planCountQuestionInput} from './helpers/claude-pty-runner';
import {nextCeoModeNavigation} from './helpers/ceo-mode-option';
import type {NativePlanQuestionCall} from './helpers/plan-count-transcript';
import captured from './fixtures/ceo-prerequisite-ad-v2.json';
function pending(){const c=structuredClone(captured.completedCall) as NativePlanQuestionCall;c.answered=false;delete c.answers;delete c.answeredAt;delete c.unansweredQuestionIndices;return c;}
// Native identities and questions are exact; pending panes are synthetic projections.
function pane(c:NativePlanQuestionCall,index:number){const q=c.questions[index]!;return [
 c.questions.length>1?'← '+c.questions.map((v,i)=>`${i<index?'☒':'☐'} ${v.header}`).join(' ')+' ✔ Submit →':'☐ '+q.header,
 q.question,...q.options.map((v,i)=>`${i?' ':'❯'} ${i+1}. ${v.label}`),
 `Enter to select · ${c.questions.length>1?'Tab/Arrow keys':'↑/↓'} to navigate · Esc to cancel`].join('\n');}
function frame(c:NativePlanQuestionCall,index:number){const visible=pane(c,index);return {visible,active:capturePlanCountQuestion(visible,new Set(),0,true,c)!,routing:nativePlanCallFingerprint(c,0,true)};}
test('AD v2 actual comma prerequisite selects standard review on its active native tab',()=>{
 const actual=captured.completedCall,q=actual.questions[2]!;
 expect(actual.answered).toBe(true);expect(actual.failed).toBe(false);expect(actual.answers[q.question]).toBe('Run /office-hours now');
 const c=pending(),f=frame(c,2);expect(f.active.nativeQuestionIndex).toBe(2);
 expect(planCountPrerequisitePick(f.routing,f.active)).toBe(2);
 const a=nextCeoModeNavigation(f.visible,'HOLD SCOPE',new Set(),c);expect(a.kind).toBe('question');
 if(a.kind==='question')expect(planCountQuestionInput(f.visible,a.question,a.index)).toBe('2');
});

test('AD v2 prerequisite presentation and actual order do not choose the action',()=>{
 for(const header of ['Office hours','Design doc','Prerequisite'])for(const reverse of [false,true]){
  const c=pending();c.questions[2]!.header=header;c.questions[2]!.question=c.questions[2]!.question.replace(/^D3 — /,'D41: ');
  if(reverse)c.questions[2]!.options.reverse();const f=frame(c,2);
  expect(planCountPrerequisitePick(f.routing,f.active)).toBe(reverse?1:2);
  for(const index of [0,1]){const other=frame(c,index);expect(planCountPrerequisitePick(other.routing,other.active)).toBeNull();}
 }
 const c=pending();c.questions=[c.questions[2]!];let f=frame(c,0);expect(planCountPrerequisitePick(f.routing,f.active)).toBe(2);
 c.questions[0]!.question='Run /office-hours now or proceed with standard review?\nNo design doc exists for the current feature. The scoped review can begin on the supplied plan.';
 c.questions[0]!.options[0]!.description='Create the design document first; then resume standard review.';
 for(const description of ['Proceed with standard review.','Proceed straight to Step 0 of the review.']){
  c.questions[0]!.options[1]!.description=description;f=frame(c,0);expect(planCountPrerequisitePick(f.routing,f.active)).toBe(2);
 }
});

test('AD v2 prerequisite declines no other task or conditional action',()=>{
 const changes:Array<(c:NativePlanQuestionCall)=>void>=[
  c=>{c.questions[2]!.question=c.questions[2]!.question.replace(/^.*\n/,'Should we deploy the feature now?\n');},
  c=>{c.questions[2]!.question='Example: '+c.questions[2]!.question;},
  c=>{c.questions[2]!.question='> '+c.questions[2]!.question;},
  c=>{c.questions[2]!.question='```text\n'+c.questions[2]!.question+'\n```';},
  c=>{c.questions[2]!.question=c.questions[2]!.question.replace('Run /office-hours first, or proceed with the standard review?','Should we remove authorization? Run /office-hours first, or proceed with the standard review?');},
  c=>{c.questions[2]!.question+=' Approve production deployment?';},
  c=>{c.questions[2]!.question+=' You must run /office-hours first.';},
  c=>{c.questions[2]!.question+=' Standard review is forbidden until /office-hours completes.';},
  c=>{c.questions[2]!.options[1]!.label+=' if the tests pass';},
  c=>{c.questions[2]!.options[0]!.label+=' and rewrite the API';},
  c=>{c.questions[2]!.options[1]!.description='Proceed with standard review after completing /office-hours.';},
  c=>{c.questions[2]!.options[1]!.description='No review will run.';},
  c=>{c.questions[2]!.options[1]!.description='Proceed directly to Step 0 of the CEO review. Remove CI.';},
  c=>{c.questions[2]!.options[0]!.description='Do not run /office-hours.';},
  c=>{c.questions[2]!.options[0]!.description='Build a design doc first, then resume the review. Deploy to production.';},
  c=>{c.questions[2]!.options[1]!.description='';},
  c=>{c.questions[2]!.options.push({label:'Approve deployment'});},
  c=>{c.questions[2]!.multiSelect=true;},
 ];
 for(const change of changes){const c=pending();change(c);const f=frame(c,2);expect(planCountPrerequisitePick(f.routing,f.active)).toBeNull();}
});

test('AD v2 prerequisite requires the active native packet identity',()=>{
 const c=pending(),f=frame(c,2);
 for(const active of [{...f.active,preReview:false},{...f.active,signature:'foreign:tool:question:2'},
  {...f.active,nativeQuestionIndex:0},{...f.active,promptSnippet:'Unrelated question'},
  {...f.active,nativeCall:undefined},{...f.active,options:[...f.active.options].reverse()}])
  expect(planCountPrerequisitePick(f.routing,active)).toBeNull();
 expect(planCountPrerequisitePick({...f.active,nativeCall:undefined})).toBeNull();
 for(const delta of [{answered:true},{failed:true},{sessionId:''},{toolUseId:''}]){const call={...pending(),...delta};const x=frame(call,2);expect(planCountPrerequisitePick(x.routing,x.active)).toBeNull();}
});

import {E2E_TOUCHFILES,selectTests} from './helpers/touchfiles';
test('AD v2 prerequisite regression selects its existing mode workflow',()=>{
 for(const file of ['test/ceo-prerequisite-ad-v2.test.ts','test/fixtures/ceo-prerequisite-ad-v2.json'])
  expect(selectTests([file],E2E_TOUCHFILES,[]).selected).toEqual(['plan-ceo-mode-routing']);
});
