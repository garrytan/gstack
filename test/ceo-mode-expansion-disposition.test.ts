import {describe,expect,test} from 'bun:test';
import captured from './fixtures/ceo-expansion-disposition-77.json';
import {hasNativePostAnswerCeoPosture} from './helpers/ceo-mode-option';
import type {NativePlanQuestionCall,NativePublicToolEvent,PlanCountTranscript} from './helpers/plan-count-transcript';
const posture=/\b(expansion|10x|delight|dream|cathedral|opt[\s-]?in)\b/i;
function evidence(){
 const calls=[structuredClone(captured.selected),structuredClone(captured.proposal)] as NativePlanQuestionCall[];
 const events=captured.eventTimes.map(e=>{
  const call=calls.find(c=>c.toolUseId===e.toolUseId)!;
  return e.kind==='use'?{...e,sessionId:call.sessionId,name:'AskUserQuestion',input:{questions:call.questions}}:
   {...e,sessionId:call.sessionId,isError:false,content:captured.resultContentById[e.toolUseId as keyof typeof captured.resultContentById]};
 }) as NativePublicToolEvent[];
 const transcript:PlanCountTranscript={status:'ready',calls,assistantMessages:[]};
 return {transcript,events,proposal:calls[1]!,selected:calls[0]!};
}
function label(v:ReturnType<typeof evidence>,text:string){
 const q=v.proposal.questions[0]!;q.options[0]!.label=text;v.proposal.answers={[q.question]:text};
}
const accepted=(v:ReturnType<typeof evidence>)=>hasNativePostAnswerCeoPosture(v.transcript,'SCOPE EXPANSION',posture,captured.selectionStartedAt,v.events);
describe('completed expansion disposition targets the current plan',()=>{
 test('actual acknowledged shared-views proposal is current expansion posture',()=>{
  const v=evidence();expect(v.proposal.answered).toBe(true);
  expect(v.proposal.answers?.[v.proposal.questions[0]!.question]).toBe('A) Add to this plan (recommended)');
  expect(accepted(v)).toBe(true);
 });
 test.each(['Include','Include in scope','Include in this plan','Include in the plan’s scope','Add to scope','Add to this plan','Add to the plan','Add to this plan’s scope'])('same-plan inclusion disposition: %s',text=>{
  const v=evidence();label(v,text+' (recommended)');expect(accepted(v)).toBe(true);
 });
 test.each(['Add to another plan','Add to that plan','Add to this plan after deployment','Include if tests pass','Do not add to this plan','Defer adding to this plan','Propose adding to this plan','Add to this plan and delete the API','Add to scope; approve production','Include in the other plan','Include in this plan but skip authorization'])('does not infer inclusion from %s',text=>{
  const v=evidence();label(v,text);expect(accepted(v)).toBe(false);
 });
 test('explicit exclusion of this plan still fails even with an inclusion phrase nearby',()=>{
  const v=evidence();label(v,'Add to another plan (not this plan)');expect(accepted(v)).toBe(false);
 });
 test('pending, failed, missing, duplicate or foreign acknowledgments give no posture credit',()=>{
  const variants=[
   (v:ReturnType<typeof evidence>)=>{v.proposal.answered=false;},
   (v:ReturnType<typeof evidence>)=>{v.proposal.failed=true;},
   (v:ReturnType<typeof evidence>)=>{v.events.pop();},
   (v:ReturnType<typeof evidence>)=>{v.events.push({...v.events.at(-1)!});},
   (v:ReturnType<typeof evidence>)=>{v.events.at(-1)!.sessionId='foreign-session';},
   (v:ReturnType<typeof evidence>)=>{v.proposal.answeredAt='2026-09-15T17:14:00.000Z';},
  ];
  for(const mutate of variants){const v=evidence();mutate(v);expect(accepted(v)).toBe(false);}
 });
 test('a different selected mode, bare mode echo, or unbound request remains insufficient',()=>{
  const wrong=evidence();wrong.selected.answers={[wrong.selected.questions[0]!.question]:'HOLD SCOPE'};expect(accepted(wrong)).toBe(false);
  const echo=evidence();echo.proposal.questions[0]!.question='SCOPE EXPANSION confirmed.';expect(accepted(echo)).toBe(false);
  const foreign=evidence();foreign.events[2]={...foreign.events[2]!,input:{questions:[]}};expect(accepted(foreign)).toBe(false);
 });
});

describe('named Add proposal owns its current scope comparison',()=>{
 const f=captured.namedAddProposal;
 function state(){const selected=structuredClone(f.selected),proposal=structuredClone(f.proposal);return{selected,proposal,transcript:{status:'ready' as const,calls:[selected,proposal],assistantMessages:[]},events:structuredClone(f.events) as NativePublicToolEvent[]};}
 function change(v:ReturnType<typeof state>,fn:(q:NativePlanQuestionCall['questions'][number])=>void){
  const q=v.proposal.questions[0]!,answer=v.proposal.answers![q.question]!;fn(q);v.proposal.answers={[q.question]:answer};
  const request=v.events.find(e=>e.kind==='use'&&e.toolUseId===v.proposal.toolUseId)!;if(request.kind==='use')request.input={questions:v.proposal.questions};
 }
 const matches=(v:ReturnType<typeof state>)=>hasNativePostAnswerCeoPosture(v.transcript,'SCOPE EXPANSION',posture,f.selectionStartedAt,v.events);
 test('actual E1 title and current same-feature explanation demonstrate expansion after its ACK',()=>{expect(matches(state())).toBe(true);});
 const positives={
  'other explicit current marker':(q:any)=>{q.question=q.question.replace('Right now','Currently');},
  'other feature and scope with the same owned comparison':(q:any)=>{q.question=q.question.replaceAll('project-shared views','workspace-shared bookmarks').replaceAll('Shared views','Shared bookmarks').replaceAll('private views','private bookmarks').replaceAll('a view for','a bookmark for').replaceAll('whole project','whole workspace');},
  'title without repeated baseline':(q:any)=>{q.question=q.question.replace(' alongside private views','');},
  'same current named proposal with another identity':(q:any)=>{q.question=q.question.replace('E1:','E12:');},
 };
 for(const [name,fn]of Object.entries(positives))test(name,()=>{const v=state();change(v,fn);expect(matches(v)).toBe(true);});
 const negatives={
  'unrelated title feature':(q:any)=>{q.question=q.question.replace('project-shared views','project-shared reports');},
  'foreign scope modifier':(q:any)=>{q.question=q.question.replace('project-shared','organization-shared');},
  'unrelated baseline object':(q:any)=>{q.question=q.question.replace('a view for one member only','a bookmark for one member only');},
  'no current limited baseline':(q:any)=>{q.question=q.question.replace('Right now the plan saves a view for one member only.','The project has a task list.');},
  'contradictory alongside baseline':(q:any)=>{q.question=q.question.replace('alongside private views','alongside public views');},
  'no operative same-feature explanation':(q:any)=>{q.question=q.question.replace('Shared views let','Shared reports let');},
  'quoted feature explanation':(q:any)=>{q.question=q.question.replace('Shared views let','"Shared views let').replace('nobody else rebuilds it.','nobody else rebuilds it."');},
  'conditional feature explanation':(q:any)=>{q.question=q.question.replace('Shared views let','If approved, shared views let');},
  'negated feature capability':(q:any)=>{q.question=q.question.replace('Shared views let','Shared views do not let');},
  'withdrawn current proposal':(q:any)=>{q.question=q.question.replace('Stakes if','This proposal is withdrawn.\nStakes if');},
  'historical baseline':(q:any)=>{q.question=q.question.replace('Right now','Previously');},
  'historical whole comparison':(q:any)=>{q.question=q.question.replace('ELI10:','ELI10: Historical example.');},
  'wrong selected-mode context':(q:any)=>{q.question=q.question.replace('Project/branch/task:','Project/branch/task: HOLD SCOPE;');},
  'extra decision':(q:any)=>{q.question=q.question.replace('ELI10:','ELI10: Should we replace billing?');},
  'incomplete comparison':(q:any)=>{q.question=q.question.replace('Completeness:','Notes:');},
  'foreign plan inclusion':(q:any)=>{q.options[0].label='Add to another plan (recommended)';},
 };
 for(const [name,fn]of Object.entries(negatives))test(name,()=>{const v=state();change(v,fn);expect(matches(v)).toBe(false);});
 test('no pending, duplicate, foreign or missing native ACK can supply posture',()=>{
  for(const mutation of [(v:ReturnType<typeof state>)=>{v.proposal.answered=false;},(v:ReturnType<typeof state>)=>{v.events.pop();},(v:ReturnType<typeof state>)=>{v.events.push(structuredClone(v.events.at(-1)!));},(v:ReturnType<typeof state>)=>{v.events.at(-1)!.sessionId='foreign';}]){const v=state();mutation(v);expect(matches(v)).toBe(false);}
 });
});


describe('procedural pause in a complete acknowledged expansion decision',()=>{
 const f=captured.proceduralPauseB0ca;
 function state(){
  const selected=structuredClone(f.selected),proposal=structuredClone(f.proposal);
  const calls=[selected,proposal] as NativePlanQuestionCall[];
  const events=f.eventTimes.map(e=>{const call=calls.find(c=>c.toolUseId===e.toolUseId)!;
   return e.kind==='use'?{...e,sessionId:call.sessionId,name:'AskUserQuestion',input:{questions:call.questions}}:
    {...e,sessionId:call.sessionId,isError:false,content:f.resultContentById[e.toolUseId as keyof typeof f.resultContentById]};
  }) as NativePublicToolEvent[];
  return{selected,proposal,events,transcript:{status:'ready' as const,calls,assistantMessages:[]}};
 }
 const matches=(v:ReturnType<typeof state>)=>hasNativePostAnswerCeoPosture(v.transcript,'SCOPE EXPANSION',posture,Date.parse(v.selected.answeredAt!)-1,v.events);
 test('actual Add ACK supplies posture with an unselected procedural pause control',()=>{
  const v=state();expect(v.proposal.answers?.[v.proposal.questions[0]!.question]).toBe('Add to scope (recommended)');
  expect(matches(v)).toBe(true);
 });
 const pause='Pause this review to discuss the permission model. ';
 const waiting=' Remaining proposals wait until we resume.';
 function description(v:ReturnType<typeof state>,text:string){v.proposal.questions[0]!.options[3]!.description=text;}
 test.each([
  'No current proposal is decided during this pause.',
  'No candidate is resolved under pressure.',
  'No scope decision is made during discussion.',
  'No current disposition is recorded now.',
  'This proposal remains undecided.',
  'The current item stays pending.',
 ])('a current no-disposition assurance is owned by the paused ceremony: %s',assurance=>{
  const v=state();description(v,pause+assurance+waiting);expect(matches(v)).toBe(true);
 });
 test('equivalent active procedural clauses preserve the same pending disposition',()=>{
  const v=state();description(v,'This ceremony is paused for discussion. No current proposal is decided. Remaining candidates remain pending.');expect(matches(v)).toBe(true);
 });
 test.each([
  'No other proposal is decided.',
  'No proposal is mentioned.',
  'No tests are decided.',
  'Previously, no proposal is decided.',
  'No proposal is decided for another project.',
  'No proposal is decided if we agree.',
  'No proposal is decided tomorrow.',
  '"No proposal is decided."',
  '`No proposal is decided.`',
  'No proposal is decided unless we approve E1.',
  'No proposal is decided. Approve E1 now.',
  'No proposal is decided. We decide this proposal now.',
  'No proposal is decided. E1 is already included in scope.',
  'No proposal is decided. "Approve all remaining proposals."',
 ])('foreign, conditional, quoted or operative scope is not a procedural pause: %s',assurance=>{
  const v=state();description(v,pause+assurance+waiting);expect(matches(v)).toBe(false);
 });
 test.each([
  'No proposal is decided. Remaining proposals wait.',
  'Pause the review to discuss the model. No proposal is decided.',
  'Do not pause the review to discuss the model. No proposal is decided. Remaining proposals wait.',
  'Pause the review to discuss the model if we agree. No proposal is decided. Remaining proposals wait.',
  'Pause the review to discuss the model. No proposal is decided. Remaining proposals wait unless we resume.',
 ])('all three current procedural clauses must agree: %s',text=>{
  const v=state();description(v,text);expect(matches(v)).toBe(false);
 });
 test('discussing resolution mechanics does not itself resolve a proposal',()=>{
  const v=state();description(v,'Pause this review to discuss how we resolve permission ambiguity. No proposal is decided. Remaining proposals wait.');
  expect(matches(v)).toBe(true);
 });
 test('selecting the pause itself grants no posture credit or scope',()=>{
  const v=state(),q=v.proposal.questions[0]!;v.proposal.answers={[q.question]:q.options[3]!.label};expect(matches(v)).toBe(false);
 });
 test.each([
  'Resolve all remaining proposals.',
  'Resolves every current proposal.',
  'Resolve E1.',
  'Resolving this current proposal.',
  'We will resolve every candidate.',
  '"Resolve all current proposals."',
  'This proposal is now decided.',
  'E1 is resolved.',
  'Current proposal status: "decided".',
  'This review is no longer paused.',
  'The ceremony has resumed.',
  'Current review status: "active".',
 ])('a later current status cannot contradict the procedural pause: %s',correction=>{
  const v=state();description(v,pause+'No proposal is decided.'+waiting+' '+correction);expect(matches(v)).toBe(false);
 });
 test('native identity, full ACK and the selected current Add target remain required',()=>{
  for(const change of [
   (v:ReturnType<typeof state>)=>{v.proposal.answered=false;},
   (v:ReturnType<typeof state>)=>{v.events.pop();},
   (v:ReturnType<typeof state>)=>{v.events.push(structuredClone(v.events.at(-1)!));},
   (v:ReturnType<typeof state>)=>{v.events.at(-1)!.sessionId='foreign';},
   (v:ReturnType<typeof state>)=>{v.proposal.questions[0]!.options[0]!.label='Add to another plan (recommended)';},
   (v:ReturnType<typeof state>)=>{v.proposal.questions[0]!.options[3]!.label='Hold and approve E1';},
  ]){const v=state();change(v);expect(matches(v)).toBe(false);}
 });
});
