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
   for(const owner of ['This finding','This decision',`D${i===0?1:5}`])rejected(i,c=>question(c,s=>`${s}\n${bold}${owner}${bold} is ${open}${status}${close}.`));
   rejected(i,c=>options(c,o=>{o.description+=`\n${bold}This option${bold} is ${open}${status}${close}.`;}));
  }
 });
 test.each([0,1])('own conditional approval and withdrawn corrections close family %i',i=>{
  for(const status of ['This finding applies only if the user agrees.','This finding proceeds once approved.'])rejected(i,c=>question(c,s=>s+'\n'+status));
  for(const status of ['This option proceeds once approved.','This remedy applies only if the user agrees.','Do not '+(i===0?'cut AuthCache and TokenStore.':'split or flatten the function.')])rejected(i,c=>options(c,o=>{o.description+='\n'+status;}));
 });
 test.each([0,1])('foreign and quoted historical withdrawals do not close family %i',i=>{
  const c=fresh(i);question(c,s=>s+'\nD99 is withdrawn.\nEarlier reviewer said "This finding is withdrawn." Earlier reviewer said "This decision is withdrawn."');
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

// Exact public AZ question; synthetic identity/time only, without recrediting the failed run.
const step0InventoryQuestion = {
  "question": "D3 — Step 0 complexity check: reduce the plan's moving parts, or proceed as-is?\nProject/branch/task: main, eng-reviewing PLAN.md (Multi-tenant Auth Refactor).\nELI10: PLAN.md:35-36 says this touches 12 files and adds 4 new classes (TokenStore, SessionMint, AuthCache, RequestPolicy) plus the AuthBroker service. That trips the complexity smell (8+ files or 2+ new classes). PLAN.md:7-13 also says an existing cache adapter already keys tokens by tenant, evicts, and invalidates on logout/revocation/suspension, and AuthCache is just a facade over it. So TokenStore looks like a second token store next to the one you already have, and RequestPolicy is a class for logic that currently has one consumer. Fewer new nouns means fewer places a tenant-isolation bug can hide and a smaller diff to review.\nStakes if we pick wrong: over-reduce and you re-add a class mid-implementation; under-reduce and you maintain two token stores with two invalidation stories, which is exactly how cross-tenant cache leaks start.\nRecommendation: A because the existing adapter already does what TokenStore describes, and RequestPolicy can start as a plain function and become a class when a second caller appears (engineered enough, not over-engineered).\nNote: options differ in kind, not coverage — no completeness score. Caveat: I cannot read the source here, so if TokenStore holds something the adapter does not (refresh tokens, mint receipts), say so and keep it.\nNet: 3 new classes with one backing store vs. 4 classes and a duplicate store vs. no facade at all.",
  "header": "Scope",
  "multiSelect": false,
  "options": [
    {
      "label": "A) Reduce: cut TokenStore, demote RequestPolicy (recommended)",
      "description": "✅ One token store, one invalidation story: the existing adapter behind the AuthCache facade. (human: ~1 day less / CC: ~10 min less)\n✅ AuthCache facade stays as the single seam where the shared-state fix lands in Section 1.\n❌ If TokenStore was meant to hold data the adapter cannot key, you add it back later. ~8 files, 3 new classes."
    },
    {
      "label": "B) Proceed as-is: 4 classes, 12 files",
      "description": "✅ No re-planning; every component named in the plan ships in this PR. (human: ~1 week / CC: ~1 hr)\n✅ RequestPolicy as a class is ready for a second consumer on day one.\n❌ Two token-holding components (TokenStore + adapter) means two invalidation paths to keep consistent under tenant suspension."
    },
    {
      "label": "C) Reduce harder: no AuthCache facade, inject adapter directly",
      "description": "✅ Smallest diff: 2 new services, ~6 files, zero new cache classes. (human: ~3 days / CC: ~30 min)\n✅ Both services depend on the adapter interface the existing tests already cover.\n❌ Loses the one place to serialize mutations and add tenant-scoped guards; both services must re-implement that themselves."
    }
  ]
};

function step0InventoryCall(): NativePlanQuestionCall {
 const q=structuredClone(step0InventoryQuestion);
 return {sessionId:'step0-inventory',toolUseId:'owned-decision',questions:[q],answered:true,failed:false,
  answers:{[q.question]:q.options[0]!.label},unansweredQuestionIndices:[],answeredAt:new Date(start+1000).toISOString()};
}
const inventorySeed=(c:NativePlanQuestionCall)=>evaluate([c]).decisions.complexity;
test('a current Step 0 decision owns its inventory and reduction in the explanation',()=>{
 expect(inventorySeed(step0InventoryCall())).toBe('step0-inventory:owned-decision');
 for(const option of step0InventoryQuestion.options){const c=step0InventoryCall();c.answers={[c.questions[0]!.question]:option.label};expect(inventorySeed(c)).toBeDefined();}
 const c=step0InventoryCall();question(c,s=>s.replace('touches 12 files','touches 13 files'));options(c,o=>{o.label=o.label.replace('12 files','13 files');});expect(inventorySeed(c)).toBeDefined();
 question(c,s=>s+'\nD99 is withdrawn.\nEarlier reviewer said "This finding is withdrawn." Earlier reviewer said "This decision is withdrawn."');expect(inventorySeed(c)).toBeDefined();
});
test('Step 0 inventory, present overlap, and a current single-option reduction are required',()=>{
 for(const [before,after] of [
  ['says this touches','might touch'],['adds 4 new classes','adds 5 new classes'],
  ['(TokenStore, SessionMint, AuthCache, RequestPolicy)','(TokenStore, SessionMint, AuthCache, TokenStore)'],
  ['plus the AuthBroker service','plus another service'],['already keys tokens by tenant','might someday key tokens by tenant'],
  ['AuthCache is just a facade over it','AuthCache has independent policy rules'],
  ['looks like a second token store next to the one you already have','stores different data from the adapter'],
  ['currently has one consumer','already has two consumers'],['ELI10: ','ELI10: Source: '],
  ['ELI10: ','ELI10: Historical assessment. '],['ELI10: ','ELI10: If approved, '],['ELI10: ','ELI10: If the user approves, '],
 ]){const c=step0InventoryCall();question(c,s=>s.replace(before!,after!));expect(inventorySeed(c)).toBeUndefined();}
 for(const transform of [(s:string)=>s.replace(/^ELI10: (.*)$/m,'ELI10: "$1"'),(s:string)=>s.replace(/^ELI10:.*$/m,'ELI10: General naming discussion.'),
  (s:string)=>s+'\nThis decision applies only if the user agrees.',(s:string)=>s+'\nTokenStore now has a documented independent purpose.',(s:string)=>s+'\nRequestPolicy now has a second consumer.']){
  const c=step0InventoryCall();question(c,transform);expect(inventorySeed(c)).toBeUndefined();
 }
 for(const change of [
  (c:NativePlanQuestionCall)=>{c.questions[0]!.options[0]!.label='A) Keep TokenStore (recommended)';},
  (c:NativePlanQuestionCall)=>{c.questions[0]!.options[0]!.description='Choose later.';},
  (c:NativePlanQuestionCall)=>{const q=c.questions[0]!;q.options[1]!.description=q.options[0]!.description;q.options[0]!.description='Choose later.';},
  (c:NativePlanQuestionCall)=>{c.questions[0]!.options[1]!.label='B) Proceed as-is: 5 classes, 12 files';},
  (c:NativePlanQuestionCall)=>{c.questions[0]!.options[1]!.description='There is one storage layer already.';},
  (c:NativePlanQuestionCall)=>{c.questions[0]!.options[0]!.description='Source:\n'+c.questions[0]!.options[0]!.description;},
  (c:NativePlanQuestionCall)=>{c.questions[0]!.options[0]!.description+='\nDo not cut TokenStore.';},
  (c:NativePlanQuestionCall)=>{c.questions[0]!.options[0]!.description+='\nThis remedy proceeds once approved.';},
 ]){const c=step0InventoryCall();change(c);c.answers={[c.questions[0]!.question]:c.questions[0]!.options[0]!.label};expect(inventorySeed(c)).toBeUndefined();}
});
test('current scalar statuses and completed native ownership still gate the Step 0 decision',()=>{
 for(const scalar of ['withdrawn',"'no longer current'",'`no longer current`','conditional on approval'])for(const owner of ['finding','decision','repair','opposed']){
  const c=step0InventoryCall();if(owner==='finding'||owner==='decision')question(c,s=>s+`\nThis ${owner} is ${scalar}.`);
  else c.questions[0]!.options[owner==='repair'?0:1]!.description+=`\nThis option is ${scalar}.`;
  expect(inventorySeed(c)).toBeUndefined();
 }
 for(const change of [(c:NativePlanQuestionCall)=>{c.answered=false;},(c:NativePlanQuestionCall)=>{c.failed=true;},(c:NativePlanQuestionCall)=>{c.answers={};},(c:NativePlanQuestionCall)=>{c.answeredAt=new Date(end+1).toISOString();}]){
  const c=step0InventoryCall();change(c);expect(inventorySeed(c)).toBeUndefined();
 }
});

// Meaning-preserving wording keeps the same inventory, overlap and opposed repairs.
test('the Step 0 relations do not depend on the original paragraph or option prose',()=>{
 const c=step0InventoryCall();question(c,s=>s.replace('complexity check: reduce','complexity decision: simplify')
  .replace('says this touches 12 files and adds 4 new classes','changes 12 files and introduces 4 new classes')
  .replace('an existing cache adapter already keys','the current adapter keys').replace('AuthCache is just a facade over it','AuthCache remains a facade for that adapter')
  .replace('TokenStore looks like a second token store next to the one you already have','TokenStore duplicates the current adapter token storage')
  .replace('RequestPolicy is a class for logic that currently has one consumer','RequestPolicy serves a single consumer'));
 const q=c.questions[0]!;q.options[0]!.label='A) Remove TokenStore; make RequestPolicy a plain function';q.options[0]!.description='Keep the current adapter as the single backing store behind AuthCache.';
 q.options[1]!.label='B) Keep the plan';q.options[1]!.description='Retain 4 classes across 12 files, with two invalidation paths.';c.answers={[q.question]:q.options[0]!.label};
 expect(inventorySeed(c)).toBeDefined();
});
