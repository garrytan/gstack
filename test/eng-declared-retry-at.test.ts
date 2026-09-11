import {describe, expect, test} from 'bun:test';
import {engFirstReviewAUQ, engSetupAUQ, nativePlanCallFingerprint} from './helpers/claude-pty-runner';
import type {NativePlanQuestionCall} from './helpers/plan-count-transcript';
import {selectTests} from './helpers/touchfiles';
import {E2E_TOUCHFILES} from './helpers/touchfiles-data';
import captured from './fixtures/eng-declared-retry-at.json';
const first=()=>structuredClone(captured) as NativePlanQuestionCall;
const fp=(c=first())=>nativePlanCallFingerprint(c,0,true);
const classify=(c=first())=>engFirstReviewAUQ(fp(c));
function mutated(fn:(c:NativePlanQuestionCall)=>void){const c=first();fn(c);return c;}
function text(fn:(s:string)=>string){return mutated(c=>{const q=c.questions[0]!,answer=c.answers![q.question]!;q.question=fn(q.question);c.answers={[q.question]:answer};});}
describe('declarative engineering retry choice',()=>{
 test('recognizes the actual answered finding without requiring a question mark',()=>{
  expect(classify()).toBe(true);expect(engSetupAUQ(fp())).toBe(false);
 });
 test('consistent issue numbers, option order and chosen option may vary',()=>{
  const c=first(),q=c.questions[0]!;q.question=q.question.replace('D2 — Issue 1:','D8 — Issue 4:').replace('Recommendation: 1A','Recommendation: 4A');q.header='Issue 4';q.options.forEach(o=>{o.label=o.label.replace(/^1/,'4');});q.options.reverse();
  for(const o of q.options){c.answers={[q.question]:o.label};expect(classify(c)).toBe(true);}
 });
 test('native completion, original menu and response ownership remain mandatory',()=>{
  for(const change of [
   (c:NativePlanQuestionCall)=>{c.answered=false;},(c:NativePlanQuestionCall)=>{c.failed=true;},(c:NativePlanQuestionCall)=>{delete c.failed;},(c:NativePlanQuestionCall)=>{c.answeredAt='invalid';},(c:NativePlanQuestionCall)=>{c.sessionId='';},(c:NativePlanQuestionCall)=>{c.toolUseId='';},(c:NativePlanQuestionCall)=>{c.answers={};},(c:NativePlanQuestionCall)=>{c.answers={[c.questions[0]!.question]:'unoffered'};},(c:NativePlanQuestionCall)=>{c.unansweredQuestionIndices=[0];},(c:NativePlanQuestionCall)=>{c.questions.push(structuredClone(c.questions[0]!));},(c:NativePlanQuestionCall)=>{c.questions[0]!.multiSelect=true;},
  ])expect(classify(mutated(change))).toBe(false);
  for(const f of [{...fp(),signature:'foreign:call'},{...fp(),nativeQuestionIndex:1},{...fp(),options:[...fp().options].reverse()}])expect(engFirstReviewAUQ(f)).toBe(false);
 });
 test('issue identity and report administration cannot substitute for the finding',()=>{
  for(const [a,b] of [['Issue 1:','Issue 0:'],['Issue 1:','Issue 01:'],['Issue 1:','Finding 1:'],['PLAN.md:6-8','PLAN.md:0-8'],['D2 —','D02 —']])expect(classify(text(s=>s.replace(a!,b!)))).toBe(false);
  for(const h of ['Issue 2','Routing','Report','Scope'])expect(classify(mutated(c=>{c.questions[0]!.header=h;}))).toBe(false);
  expect(classify(text(s=>s.replace(/^Project\/branch\/task:.*\n/m,'')))).toBe(false);
  expect(classify(text(s=>s.replace('ELI10:','Project/branch/task: unrelated\nELI10:')))).toBe(false);
  expect(classify(mutated(c=>{c.questions[0]!.options[0]!.label='1A) Continue the review';c.answers={[c.questions[0]!.question]:c.questions[0]!.options[0]!.label};}))).toBe(false);
 });
 test('quoted, hypothetical and closed current findings remain excluded',()=>{
  for(const prefix of ['Source excerpt: ','Earlier review assessment: ','If approved, ','Provided approval, ']){
   expect(classify(text(s=>s.replace('ELI10: ','ELI10: '+prefix)))).toBe(false);
   for(const i of [0,2])expect(classify(mutated(c=>{c.questions[0]!.options[i]!.description=prefix+c.questions[0]!.options[i]!.description;}))).toBe(false);
  }
  for(const status of ['withdrawn','resolved','"closed"','“superseded”']){
   expect(classify(text(s=>s+` This finding is ${status}.`))).toBe(false);
   for(const i of [0,2])expect(classify(mutated(c=>{c.questions[0]!.options[i]!.description+=` This option is ${status}.`;}))).toBe(false);
  }
  expect(classify(text(s=>s+'\n"Earlier review assessment: This finding is withdrawn."'))).toBe(true);
  expect(classify(text(s=>s+'\nCorrection: retry scheduling no longer runs inside each worker.'))).toBe(false);
 });
 test('remedy and unchanged choice each retain their own current consequence',()=>{
  for(const [i,a,b] of [[0,'come from the library','might be evaluated later'],[0,'a pure function, trivially unit-tested','five separate implementations'],[2,'a crash or deploy mid-backoff drops the retry','a crash or deploy preserves every retry']] as const)expect(classify(mutated(c=>{const o=c.questions[0]!.options[i]!;o.description=o.description!.replace(a,b);}))).toBe(false);
  expect(classify(mutated(c=>{c.questions[0]!.options[0]!.description+='\nCorrection: the library will not own persistence.';}))).toBe(false);
  expect(classify(mutated(c=>{c.questions[0]!.options[0]!.description+='\nCorrection: do not use the library retry hook.';}))).toBe(false);
  expect(classify(mutated(c=>{c.questions[0]!.options[2]!.description+='\nCorrection: the per-worker scheduler is now crash-safe.';}))).toBe(false);
 });
 test('fixture changes select only their workflow',()=>{
  for(const f of ['test/eng-declared-retry-at.test.ts','test/fixtures/eng-declared-retry-at.json'])expect(selectTests([f],E2E_TOUCHFILES,[]).selected).toEqual(['plan-eng-multi-finding-batching']);
 });
});

describe('current owner status and approval boundaries',()=>{
const ownedStatusCases:Array<{name:string,expected:boolean,edit:(c:any)=>void}>=[];const add=(name:string,expected:boolean,edit:(c:any)=>void)=>ownedStatusCases.push({name,expected,edit});
const question=(c:any,suffix:string)=>{const q=c.questions[0],answer=c.answers[q.question];q.question+=suffix;c.answers={[q.question]:answer}};
add('exact completed declarative choice',true,()=>{});
for(const owner of ['This finding','Issue 1','D2'])for(const status of ['withdrawn','not current','no longer current'])for(const quote of ['',"'",'‘'])add(`current ${owner} ${quote}${status}`,false,c=>question(c,`\n${owner} is ${quote}${status}${quote==='‘'?'’':quote}.`));
for(const i of [0,2])for(const status of ['withdrawn','not current','no longer current'])for(const quote of ['',"'",'‘'])add(`option ${i} ${quote}${status}`,false,c=>{c.questions[0].options[i].description+=`\nThis option is ${quote}${status}${quote==='‘'?'’':quote}.`});
for(const i of [0,2])for(const condition of ['This option applies only if approved.','This option is conditional on approval.','If approved, proceed with this option.'])add(`option ${i} condition ${condition}`,false,c=>{c.questions[0].options[i].description+='\n'+condition});
for(const condition of ['This finding applies only if approved.','This finding is conditional on approval.'])add('finding condition '+condition,false,c=>question(c,'\n'+condition));
for(const owner of ['Issue 2','D3'])add('foreign closed owner '+owner,true,c=>question(c,`\n${owner} is withdrawn.`));
for(const i of [0,2])add(`quoted historical option${i}`,true,c=>{c.questions[0].options[i].description+='\nEarlier review assessment: "This option is withdrawn."';});
add('quoted historical finding',true,c=>question(c,'\n"Earlier review assessment: This finding is withdrawn."'));
add('quoted title',false,c=>{const q=c.questions[0],a=c.answers[q.question];q.question=q.question.replace(/^(.*)\n/,'"$1"\n');c.answers={[q.question]:a}});
add('absent completion',false,c=>{c.answered=false});add('failed native result',false,c=>{c.failed=true});add('invalid answer time',false,c=>{c.answeredAt='missing'});
add('remedy and unchanged outcomes reversed',false,c=>{const o=c.questions[0].options;[o[0].description,o[2].description]=[o[2].description,o[0].description]});
add('remedy actually declines library persistence',false,c=>{c.questions[0].options[0].description+='\nThe library will not own persistence.'});
add('unchanged is now crash safe',false,c=>{c.questions[0].options[2].description+='\nThe scheduler is now crash-safe.'});
for(const control of ownedStatusCases)test(control.name,()=>{const call=first();control.edit(call);expect(classify(call)).toBe(control.expected);});
});

 test('bold current owners keep their scalar status before source quotes are removed',()=>{
  for(const owner of ['This finding','D2']){
   expect(classify(text(s=>s+`\n**${owner}** is 'withdrawn'.`))).toBe(false);
   expect(classify(text(s=>s+`\n**${owner}** is ‘withdrawn’.`))).toBe(false);
  }
  for(const i of [0,2])expect(classify(mutated(c=>{c.questions[0]!.options[i]!.description+=`\n**This option** is 'withdrawn'.`;}))).toBe(false);
  expect(classify(text(s=>s+'\n"Earlier review assessment: **This finding** is withdrawn."'))).toBe(true);
 });
