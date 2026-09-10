import {describe,expect,test} from 'bun:test';
import {engFirstReviewAUQ,engSetupAUQ,engStep0Boundary,nativePlanCallFingerprint,planCountQuestionPhase} from './helpers/claude-pty-runner';
import type {NativePlanQuestionCall} from './helpers/plan-count-transcript';
import fixture from './fixtures/eng-injected-export-aq.json';
const calls=()=>structuredClone(fixture.calls) as NativePlanQuestionCall[];
const first=()=>calls()[1]!;
const fp=(c=first())=>nativePlanCallFingerprint(c,0,true);
const classify=(c=first())=>engFirstReviewAUQ(fp(c));
function mutate(change:(c:NativePlanQuestionCall)=>void){const c=first();change(c);return c;}
function text(change:(s:string)=>string){return mutate(c=>{const q=c.questions[0]!,answer=c.answers![q.question]!;q.question=change(q.question);c.answers={[q.question]:answer};});}
describe('AQ current injected-export architecture decision',()=>{
 test('exact eight owned calls start review only at D2 and preserve scope first',()=>{
  let started=false;const rows=calls().map(c=>{const p=planCountQuestionPhase(fp(c),started,engStep0Boundary,engFirstReviewAUQ,engSetupAUQ);started=p.reviewStarted;return p;});
  expect(rows.map(r=>r.preReview)).toEqual([true,false,false,false,false,false,false,false]);
  expect(classify()).toBe(true);expect(engSetupAUQ(fp())).toBe(false);
  expect(calls().map(c=>classify(c))).toEqual([false,true,false,false,false,false,false,false]);
 });
 test('consistent named actors, cache, issue and decision numbers may vary',()=>{
  const c=first(),q=c.questions[0]!;
  const rename=(s:string)=>s.replaceAll('AuthCache','TokenStore').replaceAll('AuthBroker','LoginReader').replaceAll('SessionMint','SessionWriter').replace('D2 — Issue 1:','D8 — Issue 3:');
  q.question=rename(q.question);q.header='Architecture 3';for(const o of q.options){o.label=rename(o.label).replace(/^1/,'3');o.description=rename(o.description??'');}
  q.options.reverse();for(const o of q.options){c.answers={[q.question]:o.label};expect(classify(c)).toBe(true);}
 });
 test('the current global premise admits Today and both constructor actor orders',()=>{
  expect(classify(text(s=>s.replace('Right now the cache','Today the cache')))).toBe(true);
  expect(classify(mutate(c=>{c.questions[0]!.options[0]!.description=c.questions[0]!.options[0]!.description!.replace('AuthBroker and SessionMint constructors','SessionMint and AuthBroker constructors');}))).toBe(true);
 });
 test('requires complete single-question native ownership and an offered answer',()=>{
  for(const change of [(c:NativePlanQuestionCall)=>{c.answered=false;},(c:NativePlanQuestionCall)=>{c.failed=true;},(c:NativePlanQuestionCall)=>{delete c.failed;},(c:NativePlanQuestionCall)=>{delete c.answeredAt;},(c:NativePlanQuestionCall)=>{c.answeredAt='not a date';},(c:NativePlanQuestionCall)=>{c.sessionId='';},(c:NativePlanQuestionCall)=>{c.toolUseId='';},(c:NativePlanQuestionCall)=>{c.answers={};},(c:NativePlanQuestionCall)=>{c.answers={[c.questions[0]!.question]:'unoffered'};},(c:NativePlanQuestionCall)=>{c.answers!['other']='other';},(c:NativePlanQuestionCall)=>{c.unansweredQuestionIndices=[0];},(c:NativePlanQuestionCall)=>{delete c.unansweredQuestionIndices;},(c:NativePlanQuestionCall)=>{c.questions.push(structuredClone(c.questions[0]!));},(c:NativePlanQuestionCall)=>{c.questions[0]!.multiSelect=true;}])expect(classify(mutate(change))).toBe(false);
  for(const f of [{...fp(),signature:'foreign:call'},{...fp(),nativeQuestionIndex:1},{...fp(),nativeCall:undefined},{...fp(),options:[...fp().options].reverse()}])expect(engFirstReviewAUQ(f)).toBe(false);
 });
 test('issue, header and option identities must match without malformed explicit numbers',()=>{
  for(const c of [text(s=>s.replace('Issue 1:','Issue 01:')),text(s=>s.replace('Issue 1:','Issue 0:')),text(s=>s.replace('Issue 1:','Issue 1.2:')),text(s=>s.replace('D2 —','D02 —')),mutate(c=>{c.questions[0]!.header='Arch 2';}),mutate(c=>{c.questions[0]!.header='Scope';}),mutate(c=>{c.questions[0]!.options[0]!.label='2A: Inject AuthCache (recommended)';c.answers={[c.questions[0]!.question]:c.questions[0]!.options[0]!.label};}),mutate(c=>{c.questions[0]!.options[2]!.label=c.questions[0]!.options[1]!.label;})])expect(classify(c)).toBe(false);
 });
 test('only one current metadata and assessment owner can supply the premise',()=>{
  for(const prefix of ['Source excerpt: ','Earlier review assessment: ','If approved, ','Provided this is approved, ','Historical example: '])expect(classify(text(s=>s.replace('ELI10: ','ELI10: '+prefix)))).toBe(false);
  for(const prefix of ['Source: ','Earlier review assessment: ','If approved, ','Provided this is approved, '])expect(classify(text(s=>s.replace('Project/branch/task: ','Project/branch/task: '+prefix)))).toBe(false);
  for(const line of ['Source excerpt:','Earlier review assessment:','Project/branch/task: a different current project','ELI10: Right now the cache is a global variable that two different services reach into and change.'])expect(classify(text(s=>s.replace('ELI10:',line+'\nELI10:')))).toBe(false);
  expect(classify(text(s=>s.replace(/^Project\/branch\/task:.*\n/m,'')))).toBe(false);
  expect(classify(text(s=>s.replace('a global variable that two different services reach into and change','no longer a global variable that two different services reach into and change')))).toBe(false);
 });
 test('same-owner withdrawn, superseded and quoted-status claims close the question',()=>{
  for(const status of ['withdrawn','superseded','resolved','rejected','cancelled','not current','"closed"','“superseded”'])for(const subject of ['This finding','This amendment','This assessment'])expect(classify(text(s=>s+`\n${subject} is ${status}.`))).toBe(false);
  expect(classify(text(s=>s+'\nThis remedy is a historical example, not the current option.'))).toBe(false);
  expect(classify(text(s=>s+'\n"Earlier review assessment: This finding is withdrawn."'))).toBe(true);
 });
 test('requires the named composition-root injection, removal and isolation test',()=>{
  for(const [from,to] of [['Construct one AuthCache','Construct one ForeignCache'],['AuthBroker and SessionMint constructors','AuthBroker and ForeignWriter constructors'],['AuthBroker and SessionMint constructors','AuthBroker and AuthBroker constructors'],['delete the module-level export','keep the module-level export'],['add a test that two service instances with separate caches never observe each other','tests can be added later']])expect(classify(mutate(c=>{c.questions[0]!.options[0]!.description=c.questions[0]!.options[0]!.description!.replace(from,to);}))).toBe(false);
  for(const prefix of ['Source excerpt: ','If approved, ','Earlier review assessment: '])expect(classify(mutate(c=>{c.questions[0]!.options[0]!.description=prefix+c.questions[0]!.options[0]!.description;}))).toBe(false);
  for(const suffix of [' This amendment is withdrawn.',' This remedy is "superseded".',' This option is not current.',' This remedy is a historical example, not the current option.'])expect(classify(mutate(c=>{c.questions[0]!.options[0]!.description+=suffix;}))).toBe(false);
 });
 test('an actual opposed unchanged global and persistent risk are required',()=>{
  for(const [from,to] of [['Accept the shared global as-is.','Remove the shared global.'],['tenant leakage risk stays','tenant leakage risk is resolved']])expect(classify(mutate(c=>{c.questions[0]!.options[2]!.description=c.questions[0]!.options[2]!.description!.replace(from,to);}))).toBe(false);
  for(const prefix of ['Source excerpt: ','If approved, ','Historical example: '])expect(classify(mutate(c=>{c.questions[0]!.options[2]!.description=prefix+c.questions[0]!.options[2]!.description;}))).toBe(false);
  for(const suffix of [' This option is withdrawn.',' This deferral is "superseded".',' This unchanged risk is resolved.'])expect(classify(mutate(c=>{c.questions[0]!.options[2]!.description+=suffix;}))).toBe(false);
  expect(classify(mutate(c=>{c.questions[0]!.options[2]!.label='1C: Start reviewing';}))).toBe(false);
 });
});


test('AQ direct premise and action withdrawals supersede the earlier positive clauses',()=>{
 expect(classify(text(s=>s.replace('Project/branch/task: main','Project/branch/task: Assuming approval, main')))).toBe(false);
 expect(classify(mutate(c=>{c.questions[0]!.options[0]!.description+=' Correction: do not delete the module-level export.';}))).toBe(false);
 expect(classify(mutate(c=>{c.questions[0]!.options[2]!.description+=' Correction: do not accept the shared global as-is.';}))).toBe(false);
 expect(classify(text(s=>s+' Correction: this cache no longer has a module-level mutable export.'))).toBe(false);
});
