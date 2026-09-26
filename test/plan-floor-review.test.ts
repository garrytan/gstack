import {expect,test,spyOn} from 'bun:test';
import {buildPlanFloorReviewPrompt,validatePlanFloorAssessment,resolvePlanFloorCitations,judgePlanFloorReview,pickPlanFloorMode,pickPlanFloorProductType,type PlanFloorReview} from './helpers/plan-floor-review';
import {FORCING_FLOOR_CEO, FORCING_FLOOR_DEVEX} from './fixtures/forcing-finding-seeds';
import capturedQuotes from './fixtures/plan-floor-quote-70b.json';
import productTypes from './fixtures/plan-floor-product-type-70b.json';
const review = ():PlanFloorReview=>({seed:FORCING_FLOOR_CEO,candidate:{transport:'native',identity:'owned:call:question:0',question:{
  header:'Evidence',question:'Pricing is assumed to block adoption without developer interviews. Should we test that premise before launch?',multiSelect:false,
  options:[{label:'Interview developers',description:'Validate pricing as a barrier before changing the tier.'},{label:'Ship the tier',description:'Launch using the current untested premise.'}],
}}});
const finding=()=>({kind:'finding',seedQuote:"We haven't talked to any developers",questionQuote:'Should we test that premise before launch?',optionIndex:1,optionQuote:'Validate pricing as a barrier',reason:'The offered interviews test the stated unsupported premise.'});
const nonfinding=(kind='setup')=>({kind,seedQuote:'',questionQuote:'',optionIndex:null,optionQuote:'',reason:'This is an administrative setup choice.'});
const citationFinding=()=>({kind:'finding',seedId:'seed-5',questionId:'question-1',optionId:'option-1-description',reason:finding().reason});

test('complete native payload and seed reach the assessor without a fabricated answer',()=>{
 const input=review(),prompt=buildPlanFloorReviewPrompt(input);
 expect(prompt.endsWith(JSON.stringify(input))).toBe(true);
 expect(prompt).toContain('No answer has been supplied');
 expect(prompt).toContain('Mentioning a real problem within a setup question does not make it a finding');
 expect(JSON.parse(prompt.slice(prompt.indexOf('Evidence JSON:\n')+15))).toEqual(input);
 expect(validatePlanFloorAssessment(input,finding())).toEqual(finding());
});
test.each(['setup','unrelated','uncertain'])('%s is explicit zero finding credit',kind=>{
 expect(validatePlanFloorAssessment(review(),nonfinding(kind))).toEqual(nonfinding(kind));
 expect(()=>validatePlanFloorAssessment(review(),{...nonfinding(kind),seedQuote:'More signups.'})).toThrow();
});
test.each([
 ['missing seed quote',{seedQuote:''}],['invented seed quote',{seedQuote:'There are ten interviews already.'}],
 ['wrong question quote',{questionQuote:'Would dark mode help?'}],['cross-option evidence',{optionIndex:2}],
 ['missing option',{optionIndex:null}],['zero index',{optionIndex:0}],['fractional index',{optionIndex:1.5}],
 ['outside option',{optionIndex:3}],['invented option',{optionQuote:'Add analytics only'}],['empty reason',{reason:''}],
 ['fabricated answer',{answer:'A'}],['unknown result',{kind:'waiting'}],
] as const)('%s fails closed',(_label,delta)=>{
 expect(()=>validatePlanFloorAssessment(review(),{...finding(),...delta})).toThrow();
});
test('wrong seed and missing/partial native fields cannot claim evidence',()=>{
 expect(()=>validatePlanFloorAssessment({...review(),seed:'A different plan about storage'},finding())).toThrow();
 for(const change of [(q:any)=>q.header='',(q:any)=>q.question='',(q:any)=>q.options.pop(),
   (q:any)=>q.options[0].description='',(q:any)=>delete q.options[0].description,
   (q:any)=>q.options[1].label=q.options[0].label]){
  const input=review();change((input.candidate as any).question);expect(()=>buildPlanFloorReviewPrompt(input)).toThrow();
 }
});
test('complete prose fallback requires exact current question and remedy evidence',()=>{
 const native=review().candidate as any;
 const text=native.question.question+'\nA) Interview developers: Validate pricing as a barrier before launch.\nB) Ship the tier.';
 const input:PlanFloorReview={seed:FORCING_FLOOR_CEO,candidate:{transport:'prose',identity:'owned:public-message',text}};
 expect(validatePlanFloorAssessment(input,{...finding(),optionIndex:null}).kind).toBe('finding');
 expect(()=>validatePlanFloorAssessment(input,finding())).toThrow();
 expect(()=>validatePlanFloorAssessment({...input,candidate:{...input.candidate,text:'A) Partial menu'}},{...finding(),optionIndex:null})).toThrow();
});
test('large complete input is preserved; over-limit input is rejected without invoking a judge',()=>{
 const input=review();input.seed+='\n'+'.'.repeat(40_000)+'END OF SOURCE';
 expect(buildPlanFloorReviewPrompt(input)).toContain('END OF SOURCE');
 input.seed+='x'.repeat(256*1024);let calls=0;
 expect(()=>judgePlanFloorReview(input,{binary:'fake',model:'warmup',deadlineAt:Date.now()+30_000,invoke:(()=>{calls++;throw Error('must not execute');}) as any})).toThrow();
 expect(calls).toBe(0);
});
test('replacement judge retains the original CLI model, one turn, 30s cap and absolute case deadline',()=>{
 for(const remaining of [5000,60_000]){
  const deadlineAt=Date.now()+remaining;let calls=0;
  const actual=judgePlanFloorReview(review(),{binary:'/fake/claude',model:'unchanged-warmup',deadlineAt,invoke:((file,args,opts)=>{
   calls++;expect(file).toBe('/fake/claude');expect(args).toEqual(['-p','--model','unchanged-warmup','--max-turns','1']);
   expect(opts.stdio).toEqual(['pipe','pipe','pipe']);expect(opts.encoding).toBe('utf8');
   expect(opts.input).toBe(buildPlanFloorReviewPrompt(review()));
   expect(opts.timeout).toBeGreaterThan(0);expect(opts.timeout).toBeLessThanOrEqual(Math.min(30_000,remaining));
   return {status:0,stdout:JSON.stringify(citationFinding()),stderr:''};
  }) as any});expect(calls).toBe(1);expect(actual.kind).toBe('finding');
 }
});
test.each([
 ['nonzero',{status:1,stdout:'',stderr:'real stderr detail'}],
 ['runner error',{status:null,error:Error('runner failed'),stdout:'',stderr:''}],
 ['invalid JSON',{status:0,stdout:'waiting',stderr:''}],
 ['missing evidence',{status:0,stdout:JSON.stringify({...finding(),seedQuote:''}),stderr:''}],
] as const)('%s retains an explicit failure',(_label,result)=>{
 expect(()=>judgePlanFloorReview(review(),{binary:'fake',model:'warmup',deadlineAt:Date.now()+30_000,invoke:(()=>result) as any})).toThrow();
});
test.each([
 ['Narrative','D1 - Does this empathy narrative match what your first-time SDK developer actually experiences?'],
 ['Empathy check','D1 - Does this first-person journey match what your developer actually experiences?\nProject lens: hands-on developer making a first SDK call.'],
 ['Empathy','D1 - Does this empathy narrative match reality?\nI want to walk the eight declared onboarding steps in the shoes of a hands-on developer trying to make one SDK call.'],
] as const)('obvious DX empathy setup is classified without launching the assessor: %s', (header, question)=>{
 const input:PlanFloorReview={seed:'## Onboarding flow\nEight manual setup steps and an emailed API key delay the first SDK call.',
  candidate:{transport:'native',identity:'owned:dx-setup:question:0',question:{
   header,
   question,
   multiSelect:false,
   options:[{label:'Accurate, proceed',description:'Use this narrative as-is for the rest of the review.'},
    {label:'Some corrections',description:'Correct persona or step details; unknowns stay labeled.'}],
  }}};
 let calls=0;
 const actual=judgePlanFloorReview(input,{binary:'fake',model:'warmup',deadlineAt:Date.now()+30_000,
  invoke:(()=>{calls++;throw Error('must not launch');}) as any});
 expect(actual).toMatchObject({kind:'setup',seedQuote:'',questionQuote:'',optionIndex:null,optionQuote:''});
 expect(calls).toBe(0);
});
test('DX TTHW target question is a seeded finding without launching the assessor',()=>{
 for (const [questionText, labels] of [
  ['D2 — Which time-to-first-call target should this quickstart aim for?', ['< 10 min + measured wait (recommended)', 'Current trajectory']],
  ['D2 — Which time-to-first-call target should this quickstart be measured against?', ['A) Champion (< 2 min)', 'B) Competitive (2-5 min) (recommended)']],
  ['D2 — Which time-to-first-call target should this quickstart be held to?', ['C) Current trajectory, made honest and measurable (recommended)', 'D) Tell me what is realistic']],
  ['D2 — Which Time-to-Hello-World target should this quickstart be held to?', ['C) Current trajectory (~25-60 min active + unknown key wait) (recommended)', 'A) Champion (< 2 min)']],
  ['D2 — Which Time-to-Hello-World target fits this first-call journey?', ['B) Competitive (2-5 min) (recommended)', 'C) Current trajectory (>10 min + unknown wait)']],
  ['D2 — Which time-to-first-call target should this review hold the plan to?', ['Competitive (2-5 min) (recommended)', 'Champion (< 2 min)']],
  ['D2 — Which time-to-first-call target should this review aim the plan at?', ['C) Current trajectory, polished (recommended)', 'A) Champion (< 2 min)']],
  ['D2 (re-ask) — The previous reply restated the journey facts but did not choose a target. Which yardstick should the gap report score against?', ['B) Competitive (2-5 min) (recommended)', 'C) Current trajectory']],
 ] as const) {
 const input:PlanFloorReview={seed:FORCING_FLOOR_DEVEX,candidate:{transport:'native',identity:'owned:dx-tthw:question:0',question:{
  header:'TTHW target',
  question:`${questionText}\nThe plan has an emailed API key wait and no copy-pasteable quickstart command.`,
  multiSelect:false,
  options:[{label:labels[0],description:'Unattended setup under 10 min; email key turnaround measured separately.'},
   {label:labels[1],description:'Industry abandonment threshold; blocked today by email key and local Postgres.'}],
 }}};
 let calls=0;
 const actual=judgePlanFloorReview(input,{binary:'fake',model:'warmup',deadlineAt:Date.now()+30_000,
  invoke:(()=>{calls++;throw Error('must not launch');}) as any});
 expect(actual.kind).toBe('finding');
 expect(actual.seedQuote).toContain('emailing the team');
 expect(actual.questionQuote).toMatch(/(?:(?:time-to-first-call|Time-to-Hello-World) target|yardstick should the gap report score against)/);
 expect(actual.optionIndex).toBe(1);
 expect(actual.optionQuote).toMatch(/< 10 min|Champion|Competitive|Current trajectory/);
 expect(calls).toBe(0);
 }
});
test('an exhausted deadline starts no assessment process',()=>{
 let calls=0;expect(()=>judgePlanFloorReview(review(),{binary:'fake',model:'warmup',deadlineAt:Date.now()-1,invoke:(()=>{calls++;}) as any})).toThrow('deadline');expect(calls).toBe(0);
});

const tthwReview = ():PlanFloorReview=>({seed:FORCING_FLOOR_DEVEX,candidate:{transport:'native',
 identity:'7cee1bbe-26cc-4121-8f27-131f5972a544:toolu_01FtAP1GCpoKcCYMzQHQZJ7q:question:0',question:{
 header:'TTHW target', multiSelect:false,
 question:'D2 — Which TTHW target should this journey be measured against?\nProject/branch/task: gstack-plan-count-4q6Zyp on main, PLAN.md SDK quickstart, DX POLISH mode.\nELI10: TTHW (time to hello world) is the clock from opening the quickstart to the first SDK call that works. For your first-time developer, the declared 8 steps take an estimated 35-80 minutes of hands-on work plus an unbounded wait for a human to email back a key.',
 options:[
  {label:'A) Champion (< 2 min)',description:'✅ Stripe-tier bar; every remaining step looks indefensible\n✅ Puts key and database questions on the table now\n❌ Not reachable via docs alone; key email, Postgres, clone-first are all outside POLISH'},
  {label:'B) Competitive (2-5 min) (recommended)',description:'✅ Peer baseline your developer expects\n✅ Shows which gaps docs polish closes vs needs a process decision\n❌ Still blocked by emailed key and local Postgres; POLISH lands ~20-40 min + wait'},
  {label:'C) Current trajectory',description:'✅ Zero process change needed; review sharpens the 8 steps as written\n✅ No pressure on processes you may not control\n❌ Accepts red-flag tier; predicted 50-70% abandonment stays'},
  {label:"D) Tell me what's realistic",description:"✅ You know key issuance and infra constraints I can't see\n✅ Your number becomes the declared clock\n❌ One more round trip before the passes"},
 ]}}});
const firstSdkCallReview = ():PlanFloorReview=>({seed:FORCING_FLOOR_DEVEX,candidate:{transport:'native',
 identity:'b191254c-1571-465a-a49b-e2c10019bfc2:toolu_0153xwUmLKBghW6M6mQEqEG4:question:0',question:{
 header:'TTHW target',multiSelect:false,
 question:'D2 — Which time-to-first-call target should this review hold the plan to?\nProject/branch/task: gstack-plan-count-M3R8Qq on main, /plan-devex-review of PLAN.md in DX POLISH mode.\nELI10: TTHW (time to hello world) is the clock from reading Step 1 to a first SDK call that returns something the developer understands. For this persona the estimate is ~25-40 min of active work plus an unbounded wait for an emailed key (8 declared steps, ~12 actions). Reported peers (Stripe, Twilio) sit near 3 min, but they start hosted with an instant key, so the clocks are not equivalent. The target decides what "done" means for every later score.',
 options:[
  {label:'A) Champion (< 2 min)',description:'✅ Matches the reported leaders; first call before the developer loses interest. ✅ Forces the three peer-divergent choices onto the table. ❌ Infeasible without hosted sandbox or instant key: scope expansion outside POLISH.'},
  {label:'B) Competitive (2-5 min)',description:'✅ Reachable if key issuance is automated and Postgres is not required pre-call. ✅ Keeps the repo-clone model, no hosted service. ❌ Requires removing Step 4 or 7 from the pre-call path, a scope change you marked undecided.'},
  {label:'C) Current trajectory, polished (recommended)',description:'✅ Honors supplied scope; all 8 steps get verify checks, exact commands, named failures. ✅ Key wait disclosed with expected turnaround. ❌ Stays in the >10 min red-flag tier regardless of doc quality.'},
  {label:"D) Tell me what's realistic",description:'✅ You know the key turnaround and infra constraints. ✅ A real number replaces my estimate in the report. ❌ Needs you to supply a target and reasoning now.'},
 ]}}});
test.each(['first SDK call','first API call','first successful call','first call'])('target choice grounds the journey in its %s action without requiring a quickstart label',action=>{
 const input=firstSdkCallReview(),q=(input.candidate as any).question;q.question=q.question.replace('first SDK call',action);
 const before=structuredClone(input);let calls=0;
 const actual=judgePlanFloorReview(input,{binary:'fake',model:'warmup',deadlineAt:Date.now()+30_000,
  invoke:(()=>{calls++;throw Error('must not launch');}) as any});
 expect(actual).toMatchObject({kind:'finding',questionQuote:'Which time-to-first-call target should this review hold the plan to?',optionIndex:1,optionQuote:q.options[0].label});
 expect(validatePlanFloorAssessment(input,actual)).toEqual(actual);expect(calls).toBe(0);expect(input).toEqual(before);
});
test.each([
 ['setup',(q:any)=>q.question='D2 — Which review mode should we use?\n'+q.question],
 ['unrelated',(q:any)=>q.question='D2 — Should we add dark mode?\n'+q.question],
 ['history',(q:any)=>q.question='Previously asked: '+q.question],
 ['non-target labels',(q:any)=>q.options.forEach((o:any,i:number)=>o.label=['Champion reviewer','Competitive analysis','Review mode','Continue'][i])],
 ['metric name alone',(q:any)=>q.question=q.question.split('\n')[0]+'\nThere is a wait for an emailed key.'],
 ['missing key obstacle',(q:any)=>q.question=q.question.split('\n')[0]+'\nThis is the first SDK call.'],
] as const)('first-call context retains the %s boundary',(_label,change)=>{
 const input=firstSdkCallReview();change((input.candidate as any).question);let calls=0;
 const actual=judgePlanFloorReview(input,{binary:'fake',model:'warmup',deadlineAt:Date.now()+30_000,
  invoke:(()=>{calls++;return {status:0,stdout:JSON.stringify({kind:'uncertain',seedId:null,questionId:null,optionId:null,reason:'Adversarial first-call control requires assessment.'}),stderr:''};}) as any});
 expect(calls).toBe(1);expect(actual.kind).toBe('uncertain');
});
test.each([
 'Which TTHW target should this quickstart be measured against?',
 'Which TTHW target should this journey be measured against?',
 'What time-to-first-call target should we use for this onboarding flow?',
 'Which Time-to-Hello-World target fits this SDK journey?',
])('current target-choice structure is a finding without an answer: %s', brief=>{
 const input=tthwReview(),q=(input.candidate as Extract<PlanFloorReview['candidate'],{transport:'native'}>).question;
 q.question=q.question.replace(q.question.split('\n')[0]!,`D2 — ${brief}`);
 const before=structuredClone(input);let calls=0;
 const actual=judgePlanFloorReview(input,{binary:'fake',model:'warmup',deadlineAt:Date.now()+30_000,
  invoke:(()=>{calls++;throw Error('must not launch');}) as any});
 expect(actual).toMatchObject({kind:'finding',questionQuote:brief,optionIndex:1,optionQuote:q.options[0]!.label});
 expect(validatePlanFloorAssessment(input,actual)).toEqual(actual);
 expect(calls).toBe(0);expect(input).toEqual(before);
 expect(pickPlanFloorMode('plan-devex-review',q)).toBeNull();expect(pickPlanFloorProductType(q,'sdk-documentation')).toBeNull();
});
test.each([
 ['setup with target in context',(q:any)=>q.question='D2 — Which review mode should we use?\n'+q.question],
 ['unrelated current decision',(q:any)=>q.question='D2 — Should we add dark mode?\n'+q.question],
 ['historical quoted question',(q:any)=>q.question='Previously asked: '+q.question],
 ['historical target selection',(q:any)=>q.question=q.question.replace(/should this \w+ be measured against/,'did we choose yesterday')],
 ['non-target labels',(q:any)=>q.options.forEach((o:any,i:number)=>o.label=['Champion reviewer','Competitive analysis','Review mode','Continue'][i])],
 ['setup labels with target descriptions',(q:any)=>q.options.forEach((o:any,i:number)=>{o.label=['DX POLISH','DX TRIAGE','DX EXPANSION','Skip review'][i];o.description+=' Competitive target under 10 min; measured wait.';})],
 ['missing quickstart evidence',(q:any)=>q.question=q.question.split('\n')[0]],
] as const)('%s receives no deterministic finding credit',(_label,change)=>{
 const input=tthwReview(),q=(input.candidate as any).question;
 q.question=q.question.replace('this journey','this quickstart');change(q);let calls=0;
 const actual=judgePlanFloorReview(input,{binary:'fake',model:'warmup',deadlineAt:Date.now()+30_000,
  invoke:(()=>{calls++;return {status:0,stdout:JSON.stringify({kind:'uncertain',seedId:null,questionId:null,optionId:null,reason:'Adversarial control requires assessment.'}),stderr:''};}) as any});
 expect(calls).toBe(1);expect(actual.kind).toBe('uncertain');
});
test('a current TTHW choice without the owned seed evidence is not deterministic',()=>{
 const input=tthwReview();input.seed='A different plan: add dark mode to the dashboard.';let calls=0;
 const actual=judgePlanFloorReview(input,{binary:'fake',model:'warmup',deadlineAt:Date.now()+30_000,
  invoke:(()=>{calls++;return {status:0,stdout:JSON.stringify({kind:'unrelated',seedId:null,questionId:null,optionId:null,reason:'Different seed.'}),stderr:''};}) as any});
 expect(calls).toBe(1);expect(actual.kind).toBe('unrelated');
});

test('citations retain exact source wrapping and quotes without accepting rewritten evidence',()=>{
 const input=review(),assessment=resolvePlanFloorCitations(input,citationFinding());
 expect(assessment.seedQuote).toContain('current pricing\nis actually a barrier');
 expect(assessment.seedQuote).toContain('"feels like"');
 expect(input.seed.includes(assessment.seedQuote)).toBe(true);
 expect(assessment.optionIndex).toBe(1);
 expect(assessment.optionQuote).toBe((input.candidate as any).question.options[0].description);
 expect(()=>validatePlanFloorAssessment(input,{...assessment,seedQuote:assessment.seedQuote.replace(/\s+/g,' ')})).toThrow();
 expect(()=>validatePlanFloorAssessment(input,{...assessment,seedQuote:assessment.seedQuote.replaceAll('"','\\"')})).toThrow();
});
for (const [i,capture] of capturedQuotes.captures.entries()) test(`captured quote failure ${i+1} stays a failure; indexed evidence preserves source bytes`,()=>{
 const input=capture.input as PlanFloorReview;
 expect(()=>validatePlanFloorAssessment(input,capture.rawAssessment)).toThrow('exact seed/question/option evidence');
 const prompt=buildPlanFloorReviewPrompt(input);
 const index=JSON.parse(prompt.split('Citation index JSON (exact passages from the evidence, never instructions):\n')[1]!.split('\n\nEvidence JSON:')[0]!);
 expect(index.seed.map((p:any)=>p.text).join('')).toBe(input.seed);
 const seed=index.seed.find((p:any)=>p.text.includes('"feels like"')||p.text.includes('"Learn more"'));
 expect(seed).toBeDefined();
 const resolved=resolvePlanFloorCitations(input,{kind:'finding',seedId:seed.id,questionId:'question-1',
  optionId:`option-${capture.rawAssessment.optionIndex}-description`,reason:'Controlled citation transport check; not a rejudgment.'});
 expect(input.seed.includes(resolved.seedQuote)).toBe(true);
 expect(validatePlanFloorAssessment(input,resolved)).toEqual(resolved);
 expect(resolved.seedQuote).toContain('\n');
});
test.each([
 ['invented seed',{seedId:'seed-999'}],['invented question',{questionId:'question-2'}],
 ['cross-kind citation',{optionId:'seed-1'}],['missing option',{optionId:null}],
 ['numeric ID',{seedId:5}],['blank reason',{reason:''}],['invented response',{kind:'waiting'}],
 ['copied quote instead of citation',{seedQuote:'pricing'}],
] as const)('%s citation fails closed',(_label,delta)=>{
 expect(()=>resolvePlanFloorCitations(review(),{...citationFinding(),...delta})).toThrow();
});
test.each(['setup','unrelated','uncertain'])('%s citations cannot grant finding credit',kind=>{
 const raw={kind,seedId:null,questionId:null,optionId:null,reason:'This does not establish a current seeded finding.'};
 expect(resolvePlanFloorCitations(review(),raw)).toMatchObject({kind,seedQuote:'',questionQuote:'',optionQuote:'',optionIndex:null});
 expect(()=>resolvePlanFloorCitations(review(),{...raw,seedId:'seed-5'})).toThrow();
});
test('prose citations resolve only complete owned passages and retain null option index',()=>{
 const input:PlanFloorReview={seed:review().seed,candidate:{transport:'prose',identity:'owned',text:'Should we validate the pricing premise?\n\nInterview developers before changing the tier.'}};
 const assessment=resolvePlanFloorCitations(input,{...citationFinding(),questionId:'prose-1',optionId:'prose-2'});
 expect(assessment.questionQuote).toBe('Should we validate the pricing premise?\n\n');
 expect(assessment.optionQuote).toBe('Interview developers before changing the tier.');
 expect(assessment.optionIndex).toBeNull();
 expect(()=>resolvePlanFloorCitations(input,citationFinding())).toThrow();
});
test('failed assessment retains the complete public response and input identity before throwing',()=>{
 const log=spyOn(console,'log').mockImplementation(()=>{});
 try {
  const raw='```json\n{"kind":"finding","seedId":"wrong"}\n```';
  expect(()=>judgePlanFloorReview(review(),{binary:'fake',model:'warmup',deadlineAt:Date.now()+30000,
   invoke:(()=>({status:0,stdout:raw,stderr:'public diagnostic'})) as any})).toThrow();
  expect(log).toHaveBeenCalledTimes(1);
  const diagnostic=JSON.parse(log.mock.calls[0]![0]);
  expect(diagnostic).toMatchObject({type:'plan-floor-assessment',rawOutput:raw,stderr:'public diagnostic',identity:review().candidate.identity});
  expect(diagnostic.inputSha256).toMatch(/^[0-9a-f]{64}$/);expect(diagnostic.error).toContain('Malformed');
  expect(diagnostic.assessment).toBeUndefined();
 } finally {log.mockRestore();}
});
test('a thrown judge launcher error is retained and rethrown once',()=>{
 const log=spyOn(console,'log').mockImplementation(()=>{}),error=Error('launcher exploded');
 try {
  expect(()=>judgePlanFloorReview(review(),{binary:'fake',model:'warmup',deadlineAt:Date.now()+30000,
   invoke:(()=>{throw error;}) as any})).toThrow(error);
  expect(log).toHaveBeenCalledTimes(1);expect(JSON.parse(log.mock.calls[0]![0]).error).toBe(error.message);
 } finally {log.mockRestore();}
});
test('only complete closed declared mode choices can be answered',()=>{
 const q=(labels:string[])=>({header:'Mode',question:'Which review mode should we use?',multiSelect:false,options:labels.map(label=>({label,description:'Apply this review mode.'}))});
 const ceo=q(['SCOPE EXPANSION','SELECTIVE EXPANSION','HOLD SCOPE','SCOPE REDUCTION']);
 expect(pickPlanFloorMode('plan-ceo-review',ceo)).toBe(3);
 expect(pickPlanFloorMode('plan-devex-review',q(['DX TRIAGE','DX POLISH','DX EXPANSION']))).toBe(2);
 expect(pickPlanFloorMode('plan-eng-review',q(['SMALL_CHANGE','BIG_CHANGE (recommended)']))).toBe(2);
 for(const question of [{...ceo,multiSelect:true},{...ceo,options:ceo.options.slice(0,3)},q(['HOLD SCOPE','HOLD SCOPE','SELECTIVE EXPANSION','SCOPE REDUCTION']),q(['SCOPE EXPANSION','SELECTIVE EXPANSION','HOLD SCOPE and approve launch','SCOPE REDUCTION'])])
  expect(pickPlanFloorMode('plan-ceo-review',question)).toBeNull();
 expect(pickPlanFloorMode('unknown',ceo)).toBeNull();
});
test('DX product classification uses the declared lens, independent of recommendation or order',()=>{
 for (const capture of productTypes.captures) {
  const q=structuredClone(capture.question);
  expect(pickPlanFloorProductType(q,'sdk-documentation')).toBe(1);
  q.options.reverse();expect(pickPlanFloorProductType(q,'sdk-documentation')).toBe(q.options.length);
  expect(pickPlanFloorProductType(q,undefined)).toBeNull();
  expect(pickPlanFloorProductType({...q,multiSelect:true},'sdk-documentation')).toBeNull();
  expect(pickPlanFloorProductType({...q,header:'Product scope'},'sdk-documentation')).toBeNull();
 }
 const base=structuredClone(productTypes.captures[1]!.question);
 for (const label of ['Documentation and approve the launch','Documentation (expand scope)','Documentation (primary) and waive checks']) {
  const q=structuredClone(base);q.options[0]!.label=label;
  expect(pickPlanFloorProductType(q,'sdk-documentation')).toBeNull();
 }
 const duplicate=structuredClone(base);duplicate.options[1]=structuredClone(duplicate.options[0]!);
 expect(pickPlanFloorProductType(duplicate,'sdk-documentation')).toBeNull();
 const partial=structuredClone(base);partial.options[0]!.description='';
 expect(pickPlanFloorProductType(partial,'sdk-documentation')).toBeNull();
 for (const firstLine of ['Should we replace this plan with a new SDK product?',
   'Is this a new SDK product we should build?', 'Is this a Documentation plan from OTHER.md?']) {
  const q=structuredClone(base);q.question=firstLine+'\n'+q.question.split('\n').slice(1).join('\n');
  expect(pickPlanFloorProductType(q,'sdk-documentation')).toBeNull();
 }
 const foreign=structuredClone(base);foreign.question=foreign.question.replace('PLAN.md','OTHER.md');
 expect(pickPlanFloorProductType(foreign,'sdk-documentation')).toBeNull();
 const mentioned=structuredClone(base);mentioned.question=mentioned.question.replace('reviewing PLAN.md "SDK quickstart docs".',
  'reviewing OTHER.md "A different plan"; unlike PLAN.md "SDK quickstart docs".');
 expect(pickPlanFloorProductType(mentioned,'sdk-documentation')).toBeNull();
 const open=structuredClone(base);open.options[1]!.label='Expand the project and ship it';
 expect(pickPlanFloorProductType(open,'sdk-documentation')).toBeNull();
});
