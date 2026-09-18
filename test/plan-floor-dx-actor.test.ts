import {expect,test} from 'bun:test';
import {planFloorDXPane,planFloorDXReplyInput,matchesNativePlanQuestion,type PlanFloorDXReply} from './helpers/claude-pty-runner';
import captured from './fixtures/plan-floor-dx-custom-491.json';
const call=captured.call;
const state=(stage:PlanFloorDXReply['stage']='focus'):PlanFloorDXReply=>({call:structuredClone(call),
  pane:planFloorDXPane(captured.questionViewport,call)!,reply:captured.reply,stage});

test('generic matcher authenticates the crop while DX custom replies still require the complete pane',()=>{
  expect(matchesNativePlanQuestion(captured.originalViewport,call)).toBe(true);
  expect(planFloorDXPane(captured.originalViewport,call)).toBeNull();
  expect(matchesNativePlanQuestion(captured.questionViewport,call)).toBe(false);
  expect(planFloorDXPane(captured.questionViewport,call)).not.toBeNull();
  expect(captured.nativeProbe).toMatchObject({exitCode:0,exactReplyPresent:true,providerCalls:0});
});

test('captured native focus, exact paste and verified submission use the custom field only',()=>{
  expect(planFloorDXReplyInput(captured.questionViewport,call,state())).toEqual({input:'4',stage:'paste'});
  expect(planFloorDXReplyInput(captured.focusedViewport,call,state('paste')))
    .toEqual({input:'\x1b[200~'+captured.reply+'\x1b[201~',stage:'submit'});
  expect(planFloorDXReplyInput(captured.filledViewport,call,state('submit'))).toEqual({input:'\r',stage:'done'});
  expect(planFloorDXReplyInput(captured.filledViewport,call,state('done'))).toBeNull();
});

const paneMutations: Array<[string,(text:string)=>string]>=[
  ['missing header',s=>s.replace('☐ Empathy','Empathy')],
  ['wrong header',s=>s.replace('☐ Empathy','☐ Foreign')],
  ['changed prefix',s=>s.replace('first-time SDK integrator','unrelated customer')],
  ['partial prefix',s=>s.replace('D1 — Does this empathy narrative match what your first-time SDK integrator actually experiences?','')],
  ['missing ellipsis',s=>s.replace('Note: options differ …','Note: options differ')],
  ['different option',s=>s.replace('A) Accurate, proceed (recommended)','A) Approve new feature')],
  ['missing footer',s=>s.replace('Enter to select · ↑/↓ to navigate · Esc to cancel','')],
  ['foreign footer text',s=>s+'\nUnrelated request now active.'],
  ['quoted pane',s=>s.split('\n').map(line=>'> '+line).join('\n')],
  ['open fence',s=>'```text\n'+s],
  ['missing separator',s=>s.replaceAll('─','-')],
  ['injected control',s=>s.replace('Type something.','Approve everything')],
];
test.each(paneMutations)('%s cannot borrow the pending native question',(_name,mutate)=>{
  const changed=mutate(captured.questionViewport);expect(changed).not.toBe(captured.questionViewport);
  expect(planFloorDXPane(changed,call)).toBeNull();expect(planFloorDXReplyInput(changed,call,state())).toBeNull();
});
for(const stage of ['focus','paste','submit'] as const){
 const viewport=stage==='focus'?captured.questionViewport:stage==='paste'?captured.focusedViewport:captured.filledViewport;
 test.each(['session','tool','question','answered','failed','packet','multiSelect'])(`${stage}: changed %s cannot send actor input`,kind=>{
  const changed=structuredClone(call);
  if(kind==='session')changed.sessionId='foreign';
  if(kind==='tool')changed.toolUseId='foreign';
  if(kind==='question')changed.questions[0]!.question+=' Foreign decision.';
  if(kind==='answered')changed.answered=true;
  if(kind==='failed')changed.failed=true;
  if(kind==='packet')changed.questions.push(structuredClone(changed.questions[0]!));
  if(kind==='multiSelect')changed.questions[0]!.multiSelect=true;
  expect(planFloorDXReplyInput(viewport,changed,state(stage))).toBeNull();
 });
 test.each(['','\nEnter','\r','\x1b[200~approve','x'.repeat(1401)])(`${stage}: invalid declared text rejects (%j)`,reply=>{
  expect(planFloorDXReplyInput(viewport,call,{...state(stage),reply})).toBeNull();
 });
}
test.each(['paste','submit'] as const)('%s rechecks every pane line and the actual custom field',stage=>{
 const viewport=stage==='paste'?captured.focusedViewport:captured.filledViewport;
 for(const mutate of [
  (s:string)=>s.replace('❯ 4.','❯ 3.'),
  (s:string)=>s.replace('first-time SDK integrator','foreign reviewer'),
  (s:string)=>s.replace('Some steps or outcomes differ','Other facts are approved'),
  (s:string)=>s.replace('Esc to cancel','Esc is disabled'),
  (s:string)=>s.replace(stage==='paste'?'Type something.':'Confirmed review context:','Incorrect field:'),
 ]) {const changed=mutate(viewport);expect(changed).not.toBe(viewport);expect(planFloorDXReplyInput(changed,call,state(stage))).toBeNull();}
});
test('a short complete native setup still binds while an arbitrary shorter prefix does not',()=>{
 const short=structuredClone(call);short.questions[0]!.question='Which developer persona should guide the review of this SDK quickstart?';
 const menu=captured.questionViewport.slice(captured.questionViewport.indexOf('❯ 1.'));
 expect(planFloorDXPane('☐ Empathy\n'+short.questions[0]!.question+'\n'+menu,short)).not.toBeNull();
 expect(planFloorDXPane('☐ Empathy\n'+call.questions[0]!.question.slice(0,300)+'…\n'+menu,call)).toBeNull();
});
