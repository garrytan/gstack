import {describe,expect,test} from 'bun:test';
import {engFirstReviewAUQ,engSetupAUQ,engStep0Boundary,nativePlanCallFingerprint,planCountQuestionPhase} from './helpers/claude-pty-runner';
import type {NativePlanQuestionCall} from './helpers/plan-count-transcript';
import fixture from './fixtures/eng-library-hooks-aq.json';
const calls=()=>structuredClone(fixture.calls) as NativePlanQuestionCall[];
const first=()=>calls()[2]!;
const fp=(c=first())=>nativePlanCallFingerprint(c,0,true);
const classify=(c=first())=>engFirstReviewAUQ(fp(c));
function mutate(change:(c:NativePlanQuestionCall)=>void){const c=first();change(c);return c;}
function text(change:(s:string)=>string){return mutate(c=>{const q=c.questions[0]!,answer=c.answers![q.question]!;q.question=change(q.question);c.answers={[q.question]:answer};});}
describe('AQ library-hooks choice opens batching review on its current remedy',()=>{
 test('exact twelve owned calls preserve two setup calls and ten distinct later decisions',()=>{
  let started=false;const rows=calls().map(c=>{const p=planCountQuestionPhase(fp(c),started,engStep0Boundary,engFirstReviewAUQ,engSetupAUQ);started=p.reviewStarted;return p;});
  expect(rows.map(r=>r.preReview)).toEqual([true,true,...Array(10).fill(false)]);
  expect(calls().map(c=>classify(c))).toEqual([false,false,true,...Array(9).fill(false)]);
  expect(classify()).toBe(true);expect(engSetupAUQ(fp())).toBe(false);
 });
 test('issue numbers, option order, worker count and selected opposed choice can vary consistently',()=>{
  const c=first(),q=c.questions[0]!;q.question=q.question.replace('D3 — Architecture issue 1:','D9 — Architecture issue 4:').replaceAll('5 workers','7 workers').replace('Recommendation: 1A','Recommendation: 4A');q.header='Architecture 4';
  for(const o of q.options){o.label=o.label.replace(/^1/,'4');o.description=o.description?.replaceAll('5 copies','7 copies').replace('Five copies','Seven copies').replace('five times','seven times');}q.options.reverse();
  for(const o of q.options){c.answers={[q.question]:o.label};expect(classify(c)).toBe(true);}
 });
 test('a wholly quoted archive cannot displace the current owned assessment',()=>{
  expect(classify(text(s=>s+'\n"Earlier review assessment: This finding is withdrawn."'))).toBe(true);
  expect(classify(mutate(c=>{c.questions[0]!.options[0]!.description+=' "Earlier review assessment: This remedy is withdrawn."';}))).toBe(true);
 });
 test('native answered-call and original menu ownership remain mandatory',()=>{
  for(const change of [(c:NativePlanQuestionCall)=>{c.answered=false;},(c:NativePlanQuestionCall)=>{c.failed=true;},(c:NativePlanQuestionCall)=>{delete c.failed;},(c:NativePlanQuestionCall)=>{delete c.answeredAt;},(c:NativePlanQuestionCall)=>{c.answeredAt='invalid';},(c:NativePlanQuestionCall)=>{c.sessionId='';},(c:NativePlanQuestionCall)=>{c.toolUseId='';},(c:NativePlanQuestionCall)=>{c.answers={};},(c:NativePlanQuestionCall)=>{c.answers={[c.questions[0]!.question]:'unoffered'};},(c:NativePlanQuestionCall)=>{c.answers!['other']='other';},(c:NativePlanQuestionCall)=>{c.unansweredQuestionIndices=[0];},(c:NativePlanQuestionCall)=>{delete c.unansweredQuestionIndices;},(c:NativePlanQuestionCall)=>{c.questions.push(structuredClone(c.questions[0]!));},(c:NativePlanQuestionCall)=>{c.questions[0]!.multiSelect=true;}])expect(classify(mutate(change))).toBe(false);
  for(const f of [{...fp(),signature:'foreign:call'},{...fp(),nativeQuestionIndex:1},{...fp(),nativeCall:undefined},{...fp(),options:[...fp().options].reverse()}])expect(engFirstReviewAUQ(f)).toBe(false);
 });
 test('explicit issue numbers, headers and action identities must agree',()=>{
  for(const c of [text(s=>s.replace('issue 1:','issue 01:')),text(s=>s.replace('issue 1:','issue 0:')),text(s=>s.replace('issue 1:','issue 1.2:')),text(s=>s.replace('D3 —','D03 —')),mutate(c=>{c.questions[0]!.header='Arch 2';}),mutate(c=>{c.questions[0]!.header='Scope';}),mutate(c=>{c.questions[0]!.options[0]!.label='2A: Library hooks + custom backoff fn (recommended)';c.answers={[c.questions[0]!.question]:c.questions[0]!.options[0]!.label};})])expect(classify(c)).toBe(false);
 });
 test('requires unique current context and a current custom-scheduling premise',()=>{
  for(const prefix of ['Source excerpt: ','Earlier review assessment: ','If approved, ','Provided approval, ','Assuming approval, ']){
   expect(classify(text(s=>s.replace('ELI10: ','ELI10: '+prefix)))).toBe(false);
   expect(classify(text(s=>s.replace('Project/branch/task: ','Project/branch/task: '+prefix)))).toBe(false);
  }
  for(const line of ['Source:','Earlier review assessment:','Project/branch/task: other current context','ELI10: The plan rebuilds retry scheduling by hand inside each of 5 workers.'])expect(classify(text(s=>s.replace('ELI10:',line+'\nELI10:')))).toBe(false);
  expect(classify(text(s=>s.replace(/^Project\/branch\/task:.*\n/m,'')))).toBe(false);
  expect(classify(text(s=>s.replace('The plan rebuilds retry scheduling','The plan no longer rebuilds retry scheduling')))).toBe(false);
 });
 test('direct or quoted current withdrawal closes each owning statement',()=>{
  for(const status of ['withdrawn','superseded','resolved','"closed"','“superseded”']){
   expect(classify(text(s=>s+` This finding is ${status}.`))).toBe(false);
   expect(classify(mutate(c=>{c.questions[0]!.options[0]!.description+=` This remedy is ${status}.`;}))).toBe(false);
   expect(classify(mutate(c=>{c.questions[0]!.options[2]!.description+=` This option is ${status}.`;}))).toBe(false);
  }
 });
 test('requires a concrete library-owned retry mechanism and an isolated backoff policy',()=>{
  for(const [from,to] of [['Attempt counting, crash safety, and dashboard visibility come from the library for free.','The library could be evaluated later.'],['The backoff curve lives in one exported function','The backoff curve stays duplicated per worker']])expect(classify(mutate(c=>{c.questions[0]!.options[0]!.description=c.questions[0]!.options[0]!.description!.replace(from,to);}))).toBe(false);
  for(const prefix of ['Source excerpt: ','If approved, ','Earlier review assessment: '])expect(classify(mutate(c=>{c.questions[0]!.options[0]!.description=prefix+c.questions[0]!.options[0]!.description;}))).toBe(false);
  expect(classify(mutate(c=>{c.questions[0]!.options[0]!.label='1A: Start reviewing';c.answers={[c.questions[0]!.question]:c.questions[0]!.options[0]!.label};}))).toBe(false);
 });
 test('unchanged scheduling must retain its current per-worker crash-safety risk',()=>{
  for(const [from,to] of [['Five copies of crash-unsafe scheduling logic','Two copies of crash-unsafe scheduling logic'],['crash-unsafe scheduling logic','crash-safe scheduling logic'],['each drifting independently','all maintained in one shared policy']])expect(classify(mutate(c=>{c.questions[0]!.options[2]!.description=c.questions[0]!.options[2]!.description!.replace(from,to);}))).toBe(false);
  for(const prefix of ['Source excerpt: ','If approved, ','Historical example: '])expect(classify(mutate(c=>{c.questions[0]!.options[2]!.description=prefix+c.questions[0]!.options[2]!.description;}))).toBe(false);
  expect(classify(mutate(c=>{c.questions[0]!.options[2]!.label='1C: Proceed to the next review';}))).toBe(false);
 });
 test('same-owner mechanism, backoff, crash risk and premise cannot contradict their earlier claim',()=>{
  expect(classify(mutate(c=>{c.questions[0]!.options[0]!.description+='\nCorrection: the library will not own attempt counting or crash safety.';}))).toBe(false);
  expect(classify(mutate(c=>{c.questions[0]!.options[0]!.description+='\nCorrection: do not preserve the exported backoff function.';}))).toBe(false);
  expect(classify(mutate(c=>{c.questions[0]!.options[2]!.description+='\nCorrection: the unchanged per-worker scheduler is now crash-safe.';}))).toBe(false);
  expect(classify(text(s=>s+'\nCorrection: retry scheduling no longer runs inside each worker.'))).toBe(false);
 });
});

describe('AY scheduler choices retain the current gap and opposed native remedies', () => {
 const publicCall=(retry=false):NativePlanQuestionCall=>{
  // Minimal excerpts from the two public calls; no transcript/report corpus.
  const question=retry
   ? "D1 — Custom inline backoff scheduler vs the job library's built-in retry hooks\nProject/branch/task: main — background job retry framework (PLAN.md:6-8).\nELI10: The plan says (PLAN.md:6-8) to ignore it and hand-roll a scheduler inside each of the 5 workers, same shape as the library version."
   : "D3 — Issue 1: custom inline scheduler per worker, or the job library's retry hook with a custom curve?\nProject/branch/task: main, PLAN.md §Architecture — background job retry framework.\nELI10: The plan writes its own \"wait, then try again\" loop inside each of the 5 workers. If that process dies mid-wait, the retry is gone and nobody knows.";
  const options=retry?[
   {label:'1A) Library hooks + shared backoff fn (recommended)',description:"Register the library's retry hook in each worker, pass one shared pure backoffDelay(attempt) for the curve. Completeness 9/10."},
   {label:'1B) Custom scheduler as one shared module',description:'Roll your own, but once, with persisted retry state. You own a second job system.'},
   {label:'1C) Proceed as planned (inline in 5 workers)',description:'Keep the plan as written. Completeness 4/10. Retries die with the process; five copies drift.'},
  ]:[
   {label:'1A: Library hook + custom curve (recommended)',description:'✅ Retry state persisted by the library: survives worker crash, deploy, and restart (human: ~1 day / CC: ~20 min).'},
   {label:'1B: Custom inline scheduler as planned',description:'✅ No dependency on library hook semantics. ❌ Retry state lives in process memory: any crash mid-backoff silently drops the job; you rebuild max-attempts, dead-letter, and metrics by hand.'},
   {label:'1C: Hybrid: library hook, but custom scheduler for one worker',description:'Library persistence for 4 workers today; two retry systems remain.'},
  ];
  return {sessionId:'ay-public',toolUseId:retry?'retry':'first',questions:[{header:retry?'Architecture':'Arch 1',question,multiSelect:false,options}],
   answered:true,failed:false,unansweredQuestionIndices:[],answeredAt:'2026-09-11T03:22:05.503Z',answers:{[question]:options[0]!.label}};
 };
 const edit=(retry:boolean,change:(c:NativePlanQuestionCall)=>void)=>{
  const c=publicCall(retry);change(c);
  if(c.answers&&Object.keys(c.answers).length)c.answers={[c.questions[0]!.question]:c.questions[0]!.options[0]!.label};
  return c;
 };
 test('both public forms start review on the same answered native choice',()=>{
  for(const retry of [false,true]){
   const c=publicCall(retry),q=c.questions[0]!;
   for(const o of q.options){c.answers={[q.question]:o.label};expect(classify(c)).toBe(true);}
   expect(engSetupAUQ(fp(c))).toBe(false);
  }
 });
 test('worker counts and native option order may vary consistently',()=>{
  for(const retry of [false,true])expect(classify(edit(retry,c=>{
   const q=c.questions[0]!;q.question=q.question.replace('5 workers','7 workers');
   q.options=q.options.map(o=>({...o,label:o.label.replace('5 workers','7 workers'),description:o.description?.replace('five copies','seven copies')}));
   q.options.reverse();
  }))).toBe(true);
 });
 test('same-owner native completion, metadata and menu are mandatory',()=>{
  const bad:Array<(c:NativePlanQuestionCall)=>void>=[
   c=>{c.answered=false;},c=>{c.failed=true;},c=>{delete c.answeredAt;},c=>{c.answers={};},c=>{c.unansweredQuestionIndices=[0];},
   c=>{c.questions[0]!.header='Routing';},c=>{c.questions[0]!.options[0]!.label='2A: Library hook + custom curve';},
   c=>{c.questions[0]!.question='Source excerpt:\n'+c.questions[0]!.question;},
   c=>{c.questions[0]!.question=c.questions[0]!.question.replace('ELI10: ','ELI10: If approved, ');},
   c=>{c.questions[0]!.question=c.questions[0]!.question.replace('Project/branch/task: ','Project/branch/task: If approved, ');},
   c=>{c.questions[0]!.question=c.questions[0]!.question.replace('ELI10:','> ELI10:');},
   c=>{c.questions[0]!.question+='\nELI10: The plan writes its own loop inside each of the 5 workers.';},
   c=>{c.questions[0]!.question+='\nCorrection: retry scheduling no longer runs inside each worker.';},
  ];
  for(const retry of [false,true])for(const change of bad)expect(classify(edit(retry,change))).toBe(false);
  for(const retry of [false,true])expect(engFirstReviewAUQ({...fp(publicCall(retry)),signature:'foreign:call'})).toBe(false);
 });
 test('the proposed library mechanism cannot borrow from another native option',()=>{
  for(const retry of [false,true]){
   const keep=retry?2:1;
   for(const change of [
    (c:NativePlanQuestionCall)=>{[c.questions[0]!.options[0]!.description,c.questions[0]!.options[keep]!.description]=[c.questions[0]!.options[keep]!.description,c.questions[0]!.options[0]!.description];},
    (c:NativePlanQuestionCall)=>{c.questions[0]!.options[0]!.description='The library could be evaluated later.';},
    (c:NativePlanQuestionCall)=>{c.questions[0]!.options[0]!.description='Source excerpt: '+c.questions[0]!.options[0]!.description;},
    (c:NativePlanQuestionCall)=>{c.questions[0]!.options[0]!.description='"'+c.questions[0]!.options[0]!.description+'"';},
    (c:NativePlanQuestionCall)=>{c.questions[0]!.options[0]!.description+='\nThe library will not own persistence.';},
    (c:NativePlanQuestionCall)=>{c.questions[0]!.options[keep]!.description='Keep the current design; no retries are lost.';},
    (c:NativePlanQuestionCall)=>{c.questions[0]!.options[keep]!.description='If approved, '+c.questions[0]!.options[keep]!.description;},
    (c:NativePlanQuestionCall)=>{c.questions[0]!.options[keep]!.description+='\nThe scheduler is now crash-safe.';},
   ])expect(classify(edit(retry,change))).toBe(false);
  }
  expect(classify(edit(false,c=>{c.questions[0]!.options[0]!.description=c.questions[0]!.options[0]!.description!.replace('survives worker','never survives worker');}))).toBe(false);
  expect(classify(edit(false,c=>{c.questions[0]!.options[1]!.description=c.questions[0]!.options[1]!.description!.replace('silently drops','never drops');}))).toBe(false);
  expect(classify(edit(true,c=>{c.questions[0]!.options[2]!.description=c.questions[0]!.options[2]!.description!.replace('five copies','two copies');}))).toBe(false);
 });
 test('quoted owner status and approval conditions remain current after matched outcomes',()=>{
  for(const retry of [false,true])for(const target of ['question','remedy','unchanged']){
   for(const status of ["This finding is 'withdrawn'.",'This option is conditional on approval.','If approved, proceed with this option.']){
    expect(classify(edit(retry,c=>{
     const q=c.questions[0]!;
     if(target==='question')q.question+='\n'+status;
     else q.options[target==='remedy'?0:retry?2:1]!.description+='\n'+status;
    }))).toBe(false);
   }
  }
 });
 test('approval clauses remain binding after option tradeoffs',()=>{
  for(const retry of [false,true])for(const option of [0,retry?2:1]){
   for(const clause of ['Assuming approval, proceed with this option.','Provided approval, keep this option.']){
    const add=(c:NativePlanQuestionCall,quoted=false)=>{c.questions[0]!.options[option]!.description+=' ❌ Additional integration effort.\n'+(quoted?'"Earlier assessment: '+clause+'"':clause);};
    expect(classify(edit(retry,c=>add(c)))).toBe(false);
    expect(classify(edit(retry,c=>add(c,true)))).toBe(true);
   }
  }
 });
 test('a crash premise cannot erase an owned approval condition',()=>{
  for(const retry of [false,true]){
   expect(classify(edit(retry,c=>{c.questions[0]!.question+='\nIf that process dies, this finding applies only if approved.';}))).toBe(false);
   expect(classify(edit(retry,c=>{c.questions[0]!.question+='\n"Earlier assessment: If that process dies, this finding applies only if approved."';}))).toBe(true);
   expect(classify(edit(retry,c=>{
    const q=c.questions[0]!,consequence='If the worker process crashes, the retry is gone and nobody knows.';
    q.question=retry?q.question+'\n'+consequence:q.question.replace('If that process dies mid-wait, the retry is gone and nobody knows.',consequence);
   }))).toBe(true);
  }
 });
});
