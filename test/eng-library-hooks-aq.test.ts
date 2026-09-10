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
