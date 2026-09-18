import {describe, expect, test} from 'bun:test';
import fixture from './fixtures/eng-architecture-cache-av-calls.json';
import {engFirstReviewAUQ, engSetupAUQ, engStep0Boundary, nativePlanCallFingerprint, planCountQuestionPhase} from './helpers/claude-pty-runner';
import type {NativePlanQuestionCall} from './helpers/plan-count-transcript';
import {E2E_TOUCHFILES} from './helpers/touchfiles-data';
const fresh=()=>structuredClone(fixture.call) as NativePlanQuestionCall;
const fp=(c:NativePlanQuestionCall)=>nativePlanCallFingerprint(c,0,true);
const accepted=(c:NativePlanQuestionCall)=>engFirstReviewAUQ(fp(c));
type Q=NativePlanQuestionCall['questions'][number];
function edit(change:(q:Q,c:NativePlanQuestionCall)=>void){const c=fresh(),q=c.questions[0]!;change(q,c);c.answers={[q.question]:q.options[0]!.label};return c;}

describe('declarative architecture issue owns the current cache mutation decision',()=>{
 test('the exact completed public decision establishes review before the counter records it',()=>{
  const c=fresh(),before=JSON.stringify(c);
  expect(c.toolUseId).toBe('toolu_0147MKgbsvnFruWMDXzQUGVv');
  expect(c.answeredAt).toBe('2026-09-10T23:03:42.025Z');
  expect(accepted(c)).toBe(true);
  expect(engSetupAUQ(fp(c))).toBe(false);
  expect(planCountQuestionPhase(fp(c),false,engStep0Boundary,engFirstReviewAUQ,engSetupAUQ)).toEqual({preReview:false,reviewStarted:true});
  expect(JSON.stringify(c)).toBe(before);
 });
 test('actor and cache renaming, citation changes, decision ordinals and offered deferral keep meaning',()=>{
  const rename=JSON.parse(JSON.stringify(fresh()).replaceAll('AuthBroker','CredentialReader').replaceAll('SessionMint','SessionWriter').replaceAll('AuthCache','TenantCache'));
  expect(accepted(rename)).toBe(true);
  expect(accepted(edit(q=>{q.question=q.question.replaceAll('PLAN.md:19-20','docs/REVISED.md:31-33').replaceAll('PLAN.md:10','docs/REVISED.md:12');}))).toBe(true);
  expect(accepted(edit(q=>{q.header='Arch 7';q.question=q.question.replace('D3 — Architecture issue 1','D22 — Architecture issue 7').replace(/\b1([ABC])\b/g,'7$1');q.options.forEach(o=>{o.label=o.label.replace(/^1/,'7');});}))).toBe(true);
  expect(accepted(edit(q=>{q.question=q.question.replace('unserialized mutations\n','unserialized mutations.\n');}))).toBe(true);
  expect(accepted(edit(q=>q.options.reverse()))).toBe(true);
  for(const option of fresh().questions[0]!.options){const c=fresh();c.answers={[c.questions[0]!.question]:option.label};expect(accepted(c)).toBe(true);}
 });
 test('the common native completion and identity gates remain necessary',()=>{
  for(const mutation of [
   (c:NativePlanQuestionCall)=>{c.answered=false;},(c:NativePlanQuestionCall)=>{c.failed=true;},
   (c:NativePlanQuestionCall)=>{delete c.answeredAt;},(c:NativePlanQuestionCall)=>{c.answeredAt='invalid';},
   (c:NativePlanQuestionCall)=>{c.unansweredQuestionIndices=[0];},(c:NativePlanQuestionCall)=>{c.answers={};},
   (c:NativePlanQuestionCall)=>{c.answers={[c.questions[0]!.question]:'unoffered'};},
   (c:NativePlanQuestionCall)=>{c.questions[0]!.multiSelect=true;},
   (c:NativePlanQuestionCall)=>{c.questions.push(structuredClone(c.questions[0]!));},
  ]){const c=fresh();mutation(c);expect(accepted(c)).toBe(false);}
  for(const mutation of [
   (f:ReturnType<typeof fp>)=>{f.signature='foreign:request';},(f:ReturnType<typeof fp>)=>{f.nativeCall!.sessionId='foreign';},
   (f:ReturnType<typeof fp>)=>{f.nativeCall!.toolUseId='foreign';},(f:ReturnType<typeof fp>)=>{f.nativeQuestionIndex=1;},
   (f:ReturnType<typeof fp>)=>{f.options.reverse();},
  ]){const f=fp(fresh());mutation(f);expect(engFirstReviewAUQ(f)).toBe(false);}
 });
 test('finding metadata and the current shared-cache premise must agree',()=>{
  for(const mutation of [
   (q:Q)=>{q.header='Arch 2';},(q:Q)=>{q.header='Scope';},
   (q:Q)=>{q.options[0]!.label=q.options[0]!.label.replace(/^1A/,'2A');},
   (q:Q)=>{q.question=q.question.replace('global mutable AuthCache','global mutable OtherCache');},
   (q:Q)=>{q.question=q.question.replace('has AuthBroker and SessionMint','has AuthBroker and AuthBroker');},
   (q:Q)=>{q.question=q.question.replace('nothing serializes','the queue serializes');},
   (q:Q)=>{q.question=q.question.replace('ELI10: PLAN.md','ELI10: If approved, PLAN.md');},
   (q:Q)=>{q.question=q.question.replace(/^ELI10: (.+)$/m,'ELI10: "$1"');},
   (q:Q)=>{q.question=q.question.replace(/^ELI10: (.+)$/m,'> ELI10: $1');},
   (q:Q)=>{q.question='Source example:\n'+q.question;},
   (q:Q)=>{q.question='```text\n'+q.question+'\n```';},
   (q:Q)=>{q.question+='\nELI10: No current race remains.';},
   (q:Q)=>{q.question=q.question.replace('Picture SessionMint','Picture OtherWriter');},
   (q:Q)=>{q.question=q.question.replace('refreshed token for tenant A','refreshed token for tenant B');},
  ])expect(accepted(edit(mutation))).toBe(false);
 });
 test('the same offered remedy must inject the named cache, serialize its writes and require tenant identity',()=>{
  for(const mutation of [
   (q:Q)=>{q.options[0]!.label=q.options[0]!.label.replace('Inject AuthCache','Inject OtherCache');},
   (q:Q)=>{q.options[0]!.label=q.options[0]!.label.replace('by constructor','through a global export');},
   (q:Q)=>{q.options[0]!.label=q.options[0]!.label.replace('owns all writes','accepts unowned writes');},
   (q:Q)=>{q.options[0]!.label=q.options[0]!.label.replace('serializes per tenant key','leaves writes unordered');},
   (q:Q)=>{q.options[0]!.label=q.options[0]!.label.replace('requires tenant context','allows missing tenant context');},
   (q:Q)=>{q.options[0]!.description=q.options[0]!.description!.replace('run in order through one owner','run concurrently through both services');},
   (q:Q)=>{q.options[0]!.description=q.options[0]!.description!.replace('fresh AuthCache per case','shared AuthCache for all cases');},
   (q:Q)=>{q.options[0]!.description=q.options[0]!.description!.replace('No method accepts a call without','Every method accepts a call without');},
   (q:Q)=>{q.options[0]!.description='Historical example: '+q.options[0]!.description;},
   (q:Q)=>{q.options[0]!.description='If approved: '+q.options[0]!.description;},
   (q:Q)=>{q.options[0]!.description='> '+q.options[0]!.description;},
   (q:Q)=>{q.options[0]!.description+='\nAuthBroker still writes directly.';},
   (q:Q)=>{q.options[0]!.description+='\nSerialization is optional.';},
  ])expect(accepted(edit(mutation))).toBe(false);
 });
 test('the opposed choice must actually leave the current race open',()=>{
  for(const mutation of [
   (q:Q)=>{q.options[2]!.label='1C: Resolve the race';},
   (q:Q)=>{q.options[2]!.description='The cache is already safe and serialized.';},
   (q:Q)=>{q.options[2]!.description='Historical example: '+q.options[2]!.description;},
   (q:Q)=>{q.options[2]!.description+='\nAuthCache is already serialized.';},
   (q:Q)=>{q.options[2]!.description+='\nOnly AuthBroker writes.';},
   (q:Q)=>{q.options[1]!.description+='\nOnly AuthBroker writes.';},
   (q:Q)=>{q.question+='\nAuthCache now serializes all writes.';},
   (q:Q)=>{q.question+='\nOnly SessionMint writes.';},
   (q:Q)=>{q.question+='\nDo not inject this cache.';},
  ])expect(accepted(edit(mutation))).toBe(false);
 });
 test('owned current statuses and approvals override the earlier finding across scalar quote forms',()=>{
  for(const target of [-1,0,1,2])for(const owner of ['This finding','D3','Architecture issue 1'])for(const suffix of [" is 'withdrawn'.",' is “no longer current”.',' is `unproven`.',' is optional.',' requires approval.']){
   const c=edit(q=>{const text='\nAssessment complete; '+owner+suffix;if(target<0)q.question+=text;else q.options[target]!.description+=text;});
   expect(accepted(c)).toBe(false);
  }
  for(const target of [-1,0,2])for(const text of ['\nPrior note: "This finding is withdrawn."','\n> This finding is withdrawn.','\nA previous reviewer said `This finding is withdrawn.`','\nOtherCache is already serialized.']){
   expect(accepted(edit(q=>{if(target<0)q.question+=text;else q.options[target]!.description+=text;}))).toBe(true);
  }
 });
 test('the exact public fixture and focused regression select only the Eng finding-count workflow',()=>{
  for(const dependency of ['test/eng-architecture-cache-av.test.ts','test/fixtures/eng-architecture-cache-av-calls.json']){
   expect(Object.entries(E2E_TOUCHFILES).filter(([,paths])=>paths.includes(dependency)).map(([name])=>name)).toEqual(['plan-eng-finding-count']);
  }
 });
});
