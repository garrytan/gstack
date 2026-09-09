import {expect,test} from 'bun:test';
import fixture from './fixtures/eng-seeded-packet-ae.json';
import {evaluateEngSeedCoverage} from './helpers/eng-seeded-coverage';
import type {NativePlanQuestionCall,PlanCountTranscript} from './helpers/plan-count-transcript';
import {E2E_TOUCHFILES,selectTests} from './helpers/touchfiles';
const packet=()=>structuredClone(fixture.packet) as NativePlanQuestionCall;
const start=Date.parse('2026-09-09T21:34:00Z'),end=Date.parse('2026-09-09T21:45:00Z');
const report=(body='')=>'# Review\n\n'+body+'\n\n## GSTACK REVIEW REPORT\nEng review complete.\n';
const transcript=(call=packet()):PlanCountTranscript=>({status:'ready',calls:[call],assistantMessages:[]});
const evaluate=(call=packet(),body='')=>evaluateEngSeedCoverage(transcript(call),report(body),start,end);
test('an actual answered complexity decision stays evidence beside an unrelated setup question',()=>{
 const result=evaluate();expect(result.decisions.complexity).toBe(fixture.packet.sessionId+':'+fixture.packet.toolUseId);
 expect(result.missing).toEqual(['shared-cache','swallowed-errors','sequential-idp']);
});
test('the exact required legacy regression paragraph establishes the mandatory pre-rewrite obligation',()=>{
 expect(evaluate(packet(),fixture.requiredTest).regression).toBe('plan');
});

test('any offered answers and tab order retain the one completed seed decision',()=>{
 for (const scope of fixture.packet.questions[0]!.options) for (const setup of fixture.packet.questions[1]!.options) {
  const c=packet();c.answers={[c.questions[0]!.question]:scope.label,[c.questions[1]!.question]:setup.label};
  c.questions.reverse();expect(evaluate(c).decisions.complexity).toBe(c.sessionId+':'+c.toolUseId);
 }
});

test('every tab must have a distinct question and a completed valid offered answer',()=>{
 for (const mutate of [
  (c:NativePlanQuestionCall)=>{delete c.answers![c.questions[1]!.question]},
  (c:NativePlanQuestionCall)=>{c.answers![c.questions[1]!.question]='unoffered'},
  (c:NativePlanQuestionCall)=>{c.answers!.foreign='Yes'},
  (c:NativePlanQuestionCall)=>{c.unansweredQuestionIndices=[1]},
  (c:NativePlanQuestionCall)=>{c.answered=false},
  (c:NativePlanQuestionCall)=>{c.failed=true},
  (c:NativePlanQuestionCall)=>{c.questions[1]!.multiSelect=true},
  (c:NativePlanQuestionCall)=>{c.questions[1]!.options[1]!.label=c.questions[1]!.options[0]!.label},
  (c:NativePlanQuestionCall)=>{c.questions[1]!.question=c.questions[0]!.question;c.answers={[c.questions[0]!.question]:c.questions[0]!.options[0]!.label}},
  (c:NativePlanQuestionCall)=>{const q=c.questions[1]!;delete c.answers![q.question];q.question='';c.answers!['']=q.options[0]!.label},
  (c:NativePlanQuestionCall)=>{c.answeredAt=new Date(start-1).toISOString()},
  (c:NativePlanQuestionCall)=>{c.answeredAt=new Date(end+1).toISOString()},
 ]) {const c=packet();mutate(c);expect(evaluate(c).decisions.complexity).toBeUndefined()}
 const t=transcript();t.calls.push(structuredClone(t.calls[0]!));
 expect(evaluateEngSeedCoverage(t,report(fixture.requiredTest),start,end).decisions).toEqual({});
 t.calls[1]!.toolUseId+='-foreign';t.calls[1]!.sessionId='foreign';
 expect(evaluateEngSeedCoverage(t,report(fixture.requiredTest),start,end).decisions).toEqual({});
});

test('different seeds still need different native call IDs',()=>{
 const c=packet();const old=c.questions[1]!.question;
 c.questions[1]={header:'Cache',question:'Should we inject the shared global AuthCache?',options:[{label:'Yes'},{label:'No'}]};
 delete c.answers![old];c.answers![c.questions[1]!.question]='No';
 const result=evaluate(c,fixture.requiredTest);
 expect(result.decisions).toEqual({});expect(result.missing).toHaveLength(4);
 // Two independent answers cannot turn the same native call into two seeds.
 expect(result.ok).toBe(false);
});

test('required characterization binds the prior behavior and same assertions to legacyAuthFlow',()=>{
 const exact=fixture.requiredTest;
 const variants=[
  exact.replaceAll('legacyAuthFlow','newAuthFlow'),
  exact.replace('behavior of `legacyAuthFlow()`','behavior of `newAuthFlow()`'),
  exact.replace('Before the rewrite','After the rewrite'),
  exact.replace('capture the current','maybe capture the current'),
  exact.replace('capture the current','do not capture the current'),
  exact.replace('must pass the\n  same assertions','may use different assertions'),
  exact.replace('The rewritten path','The rewritten newAuthFlow path'),
  exact+' Do not add these tests.',
  exact+' No regression tests are required.',
  'Example: '+exact,
  '> '+exact.replaceAll('\n','\n> '),
  '```text\n'+exact+'\n```',
  exact.replace('Before the rewrite, capture','If a rewrite is needed, capture'),
 ];
 for (const text of variants) expect(evaluate(packet(),text).regression).toBeUndefined();
 expect(evaluate(packet(),exact.replace('regression test','characterization test').replace('Before the rewrite','Before the refactor').replace('capture the current','record the existing')).regression).toBe('plan');
});

test('the new compact evidence and controls select only the Eng seeded coverage case',()=>{
 for (const file of ['test/eng-seeded-packet-ae.test.ts','test/fixtures/eng-seeded-packet-ae.json'])
  expect(selectTests([file],E2E_TOUCHFILES,[]).selected).toEqual(['plan-eng-finding-count']);
});

const retry=()=>structuredClone(fixture.retryPacket) as NativePlanQuestionCall;
const retryEvaluate=(call=retry(),body=fixture.retryRequiredTask)=>evaluateEngSeedCoverage(
 {status:'ready',calls:[call],assistantMessages:[]},report(body),start,Date.parse('2026-09-09T22:00:00Z'));
test('the retry same-cache writer decision counts with every offered answer',()=>{
 for(const option of fixture.retryPacket.questions[0]!.options){
  const call=retry();call.answers={[call.questions[0]!.question]:option.label};
  expect(retryEvaluate(call).decisions['shared-cache']).toBe(call.sessionId+':'+call.toolUseId);
 }
});
test('the retry directly required characterization suite is mandatory regression evidence',()=>{
 expect(retryEvaluate().regression).toBe('plan');
});

test('same-cache evidence stays in the issue title and requires completed actionable choices',()=>{
 const titles=[
  'The two services read the same documentation. Confirm cache performance measurements?',
  'The two services read unrelated cache entries. What is the cache read timeout?',
  '> '+fixture.retryPacket.questions[0]!.question.split('\n')[0],
 ];
 for(const title of titles){
  const c=retry(),q=c.questions[0]!;q.question=title+'\n'+q.question.split('\n').slice(1).join('\n');
  c.answers={[q.question]:q.options[0]!.label};expect(retryEvaluate(c).decisions['shared-cache']).toBeUndefined();
 }
 for(const change of ['pending','unoffered','administrative']){
  const c=retry(),q=c.questions[0]!;
  if(change==='pending')c.answered=false;
  else if(change==='unoffered')c.answers={[q.question]:'none'};
  else {q.options=[{label:'Continue'},{label:'Stop'}];c.answers={[q.question]:'Continue'}}
  expect(retryEvaluate(c).decisions['shared-cache']).toBeUndefined();
 }
});
test('suite instructions still bind actual legacy regression work before the rewrite',()=>{
 const exact=fixture.retryRequiredTask;
 for(const text of [
  exact.replaceAll('legacyAuthFlow','newAuthFlow'),
  exact.replace('Write characterization suite','Write report about a characterization suite'),
  exact.replace('Write characterization suite','Maybe write characterization suite'),
  exact.replace('Write characterization suite','Do not write characterization suite'),
  exact.replace('suite before any rewrite','suite for newAuthFlow before any rewrite'),
  exact.replace('characterization suite before any rewrite','suite after the rewrite'),
  '> '+exact,'```text\n'+exact+'\n```',
 ])expect(retryEvaluate(retry(),text).regression).toBeUndefined();
});
