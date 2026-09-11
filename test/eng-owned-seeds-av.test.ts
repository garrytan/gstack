import { describe, expect, test } from 'bun:test';
import { evaluateEngSeedCoverage } from './helpers/eng-seeded-coverage';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';
import fixture from './fixtures/eng-owned-seeds-av.json';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
const start = Date.parse('2026-09-10T23:12:00Z'), end = Date.parse('2026-09-10T23:25:00Z');
const fresh = (i: number) => structuredClone(fixture.calls[i]!) as NativePlanQuestionCall;
const evaluate = (calls: NativePlanQuestionCall[]) => evaluateEngSeedCoverage({status:'ready',calls,assistantMessages:[]}, '', start, end);
const seeds = ['complexity', 'swallowed-errors'] as const;
function question(c: NativePlanQuestionCall, change: (s: string) => string) {
 const q = c.questions[0]!, answer = c.answers[q.question]!; q.question = change(q.question); c.answers = {[q.question]:answer};
}
function rejected(i: number, change: (c: NativePlanQuestionCall) => void) {
 const c = fresh(i); change(c); expect(evaluate([c]).decisions[seeds[i]!]).toBeUndefined();
}
function options(c: NativePlanQuestionCall, change: (o: NativePlanQuestionCall['questions'][number]['options'][number]) => void) {
 const q = c.questions[0]!; q.options.forEach(change); c.answers = {[q.question]:q.options[0]!.label};
}

describe('Eng current decomposition and post-rewrite error choices', () => {
 test('two exact public completed decisions repair only their separate seeds', () => {
  expect(fixture.provenance.paidOutcomesReclassified).toBe(false);
  expect(evaluate([fresh(0),fresh(1)]).decisions).toEqual(Object.fromEntries(seeds.map((seed,i) => [seed,`${fixture.calls[i]!.sessionId}:${fixture.calls[i]!.toolUseId}`])));
  expect(evaluate([fresh(0),fresh(1)]).ok).toBe(false);
  expect(evaluate([fresh(0),fresh(1)]).missing).toEqual(['shared-cache','sequential-idp']);
 });
 test.each([0,1])('every offered answer is a completed decision for family %i', i => {
  for(const option of fixture.calls[i]!.questions[0]!.options) {
   const c=fresh(i);c.answers={[c.questions[0]!.question]:option.label};
   expect(evaluate([c]).decisions[seeds[i]!]).toBe(`${c.sessionId}:${c.toolUseId}`);
  }
 });
 test('consistent component counts and literal function identifiers are permitted', () => {
  const c=fresh(0);question(c,s=>s.replace('5-component','6-component').replace(' + RequestPolicy.',' + RequestPolicy + TenantPolicy.').replace('five new pieces','6 new pieces'));
  options(c,o=>{o.label=o.label.replace('keep 3','keep 4');});expect(evaluate([c]).decisions.complexity).toBeDefined();
  const e=fresh(1);question(e,s=>s.replaceAll('validateAndDispatch()','`validateAndDispatch()`'));
  expect(evaluate([e]).decisions['swallowed-errors']).toBeDefined();
 });
 test.each([0,1])('own explanation and metadata are required for family %i', i => {
  for(const change of [
   (s:string)=>s.replace(/^ELI10:.*\n/m,''),
   (s:string)=>s.replace(/^ELI10:.*$/m,'ELI10: This is a general naming discussion.'),
   (s:string)=>s.replace(/^Project\/branch\/task:.*\n/m,''),
   (s:string)=>s.replace('ELI10: ','ELI10: Source: '),
   (s:string)=>s.replace('ELI10: ','ELI10: Hypothetical scenario. '),
   (s:string)=>s.replace('ELI10: ','ELI10: If approved, '),
   (s:string)=>s.replace('Project/branch/task: ','Project/branch/task: Historical assessment. '),
   (s:string)=>s+'\nELI10: A competing explanation.',
   (s:string)=>s.replace(/^ELI10: (.*)$/m,'ELI10: "$1"'),
   (s:string)=>s.replace(/^ELI10: (.*)$/m,'> ELI10: $1'),
   (s:string)=>s.replace(/^ELI10: (.*)$/m,'```\nELI10: $1\n```'),
  ])rejected(i,c=>question(c,change));
 });
 test.each([0,1])('quoted, historical and conditional title material stays non-current for family %i',i=>{
  for(const wrapper of ['`','"','> ','Historical: ','If approved, '])rejected(i,c=>question(c,s=>s.replace(/^(D\d+ — )(.*)$/m,`$1${wrapper}$2${['`','"'].includes(wrapper)?wrapper:''}`)));
 });
 test('decomposition owns the same inventory, redundant wrappers and selected remedy',()=>{
  for(const change of [
   (s:string)=>s.replace('5-component','6-component'),
   (s:string)=>s.replace('five new pieces','four new pieces'),
   (s:string)=>s.replace(' + TokenStore + RequestPolicy.',' + TokenStore + TokenStore.'),
   (s:string)=>s.replace('AuthCache is described as a facade','OtherCache is described as a facade'),
   (s:string)=>s.replace('with no new rules','with new policy rules'),
   (s:string)=>s.replace('TokenStore is never described at all','TokenStore has a documented independent purpose'),
  ])rejected(0,c=>question(c,change));
  for(const change of [
   (o:any)=>{o.label=o.label.replace('AuthCache + TokenStore','AuthCache + OtherStore');},
   (o:any)=>{o.label=o.label.replace('keep 3','keep 5');},
   (o:any)=>{o.description=o.description.replace('AuthBroker and SessionMint depend','AuthBroker and OtherService depend');},
   (o:any)=>{o.description=o.description.replace('no facade, no second store','a second facade and store');},
  ])rejected(0,c=>options(c,change));
 });
 test('error repair owns the current swallowing function and explicit surfaced failures',()=>{
  for(const change of [
   (s:string)=>s.replace('validateAndDispatch() is 60','otherFunction() is 60'),
   (s:string)=>s.replace('is 60 lines','was 60 lines'),
   (s:string)=>s.replace('is 60 lines','might be 60 lines'),
   (s:string)=>s.replace('each swallow a different error class','each rethrow every error class'),
   (s:string)=>s.replace('When an auth function catches an error and quietly moves on','When a logging function catches a formatting warning and continues'),
  ])rejected(1,c=>question(c,change));
  rejected(1,c=>options(c,o=>{o.description=(o.description??'').replace('unknown errors deny','unknown errors allow').replace('every failure is logged and surfaced','some failures are ignored');}));
 });
 test.each([0,1])('owned scalar statuses, including Markdown, close family %i',i=>{
  for(const status of ['withdrawn','no longer current','hypothetical','resolved'])for(const [open,close]of [['',''],['"','"'],["'","'"],['‘','’'],['`','`']])for(const bold of ['', '**']) {
   for(const owner of ['This finding',`D${i===0?1:5}`])rejected(i,c=>question(c,s=>`${s}\n${bold}${owner}${bold} is ${open}${status}${close}.`));
   rejected(i,c=>options(c,o=>{o.description+=`\n${bold}This option${bold} is ${open}${status}${close}.`;}));
  }
 });
 test.each([0,1])('own conditional approval and withdrawn corrections close family %i',i=>{
  for(const status of ['This finding applies only if the user agrees.','This finding proceeds once approved.'])rejected(i,c=>question(c,s=>s+'\n'+status));
  for(const status of ['This option proceeds once approved.','This remedy applies only if the user agrees.','Do not '+(i===0?'cut AuthCache and TokenStore.':'split or flatten the function.')])rejected(i,c=>options(c,o=>{o.description+='\n'+status;}));
 });
 test.each([0,1])('foreign and quoted historical withdrawals do not close family %i',i=>{
  const c=fresh(i);question(c,s=>s+'\nD99 is withdrawn.\nEarlier reviewer said "This finding is withdrawn."');
  options(c,o=>{o.description+='\nEarlier reviewer said "This option is withdrawn."';});
  expect(evaluate([c]).decisions[seeds[i]!]).toBeDefined();
 });
 test.each([0,1])('remedy evidence cannot move between different offered choices for family %i',i=>{
  rejected(i,c=>{const q=c.questions[0]!,repair=q.options[0]!.description;for(const o of q.options)o.description='Choose the details later.';q.options[2]!.description=repair;});
  rejected(i,c=>options(c,o=>{o.description='Source:\n'+o.description;}));
 });
 test.each([0,1])('native completion and time bounds remain required for family %i',i=>{
  for(const change of [
   (c:NativePlanQuestionCall)=>{c.answered=false;},(c:NativePlanQuestionCall)=>{c.failed=true;},
   (c:NativePlanQuestionCall)=>{c.answers={};},(c:NativePlanQuestionCall)=>{c.answers={[c.questions[0]!.question]:'Unlisted'};},
   (c:NativePlanQuestionCall)=>{c.unansweredQuestionIndices=[0];},(c:NativePlanQuestionCall)=>{c.sessionId='';},
   (c:NativePlanQuestionCall)=>{c.answeredAt=new Date(start-1).toISOString();},(c:NativePlanQuestionCall)=>{c.answeredAt=new Date(end+1).toISOString();},
   (c:NativePlanQuestionCall)=>{c.questions[0]!.options[1]!.label=c.questions[0]!.options[0]!.label;},
  ])rejected(i,change);
 });
 test('different seeds cannot borrow one native identity',()=>{
  const c=fresh(0),e=fresh(1);c.questions.push(e.questions[0]!);c.answers={...c.answers,...e.answers};expect(evaluate([c]).decisions).toEqual({});
  expect(evaluate([fresh(0),fresh(0)]).decisions).toEqual({});
  e.sessionId='foreign';expect(evaluate([fresh(0),e]).decisions).toEqual({});
 });
 test('new dependency entries select only the Eng finding-count workflow',()=>{
  for(const file of ['test/eng-owned-seeds-av.test.ts','test/fixtures/eng-owned-seeds-av.json'])expect(selectTests([file],E2E_TOUCHFILES,[]).selected).toEqual(['plan-eng-finding-count']);
 });
});

test('current named-object resolutions supersede the owned defect',()=>{
 const resolutions = [
  [0,'AuthCache now has independent policy rules, and TokenStore now has a documented independent purpose.'],
  [0,'AuthCache now has independent policy rules.'],
  [0,'TokenStore now has a documented independent purpose.'],
  [1,'validateAndDispatch() now rethrows every error and no longer swallows failures.'],
  [1,'validateAndDispatch() no longer swallows failures.'],
 ] as const;
 for(const [i,resolution]of resolutions) {
  for(const prefix of ['\nCorrection: ','\nAssessment complete; '])rejected(i,c=>question(c,s=>s+prefix+resolution));
  for(const [open,close] of [['"','"'],["'","'"],['‘','’'],['`','`']]){
   const c=fresh(i);question(c,s=>s+'\nEarlier reviewer said '+open+'Correction: '+resolution+close);
   expect(evaluate([c]).decisions[seeds[i]!]).toBeDefined();
  }
 }
 const scope=fresh(0);question(scope,s=>s+'\nvalidateAndDispatch() now rethrows every error.');expect(evaluate([scope]).decisions.complexity).toBeDefined();
 const errors=fresh(1);question(errors,s=>s+'\nAuthCache now has independent policy rules.');expect(evaluate([errors]).decisions['swallowed-errors']).toBeDefined();
});
