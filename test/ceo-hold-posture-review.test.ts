import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import captured from './fixtures/ceo-hold-proof-fb10.json';
import { buildCeoHoldPostureReview, evaluateCeoHoldPostureReview, type CeoHoldPostureReviewInput } from './helpers/ceo-hold-posture-review';
import { hasNativePostAnswerCeoPosture } from './helpers/ceo-mode-option';
import type { PlanReviewDecisionInput, PlanReviewDecisionJudgment } from './helpers/plan-review-decisions';
import type { NativePublicToolEvent } from './helpers/plan-count-transcript';
import { nativePlanCallFingerprint } from './helpers/claude-pty-runner';
import { CAPTURE_LONG_MS } from './helpers/eval-budgets';

const clone = <T>(x:T):T => structuredClone(x);
const modeId = 'toolu_011gDPgtgAxruNm1iLaWDXf3';
const decisionId = 'toolu_016udcjV6SxTSUzcY1Zd779Z';
const sourceId = 'toolu_01X68yaBUsCX8qdrbVoTE7Xd';
const hold = /\b(rigor|bulletproof|hold\s*scope|maximum\s+rigor)\b/i;
let now:number;
let clock:ReturnType<typeof spyOn>, log:ReturnType<typeof spyOn>;
beforeEach(()=>{ now=Date.parse('2026-09-17T01:02:00.000Z'); clock=spyOn(Date,'now').mockImplementation(()=>now); log=spyOn(console,'log').mockImplementation(()=>{}); });
afterEach(()=>{clock.mockRestore();log.mockRestore();});
function input():CeoHoldPostureReviewInput {
  return {...clone(captured), deadlineAt:captured.selectionStartedAt+240_000} as CeoHoldPostureReviewInput;
}
const decision=(f:CeoHoldPostureReviewInput)=>f.transcript.calls.find(c=>c.toolUseId===decisionId)!;
const mode=(f:CeoHoldPostureReviewInput)=>f.transcript.calls.find(c=>c.toolUseId===modeId)!;
const event=(f:CeoHoldPostureReviewInput,id:string,kind:'use'|'result')=>f.publicTools.find(e=>e.toolUseId===id&&e.kind===kind)!;
function revise(f:CeoHoldPostureReviewInput,change:(q:any)=>void) {
  const call=decision(f),q=call.questions[0]!,selected=q.options.findIndex(o=>o.label===call.answers![q.question]);
  change(q);call.answers={[q.question]:q.options[selected]!.label};
  event(f,decisionId,'use').input={questions:clone(call.questions)};
}
function data(prompt:string):any {
  const m=/BEGIN_UNTRUSTED_([a-f0-9]{32})\n/.exec(prompt)!;
  return JSON.parse(prompt.slice(m.index+m[0].length,prompt.lastIndexOf(`\nEND_UNTRUSTED_${m[1]}`)));
}
function mockAssessment(prompt:string):PlanReviewDecisionJudgment {
  const d=data(prompt);
  return {questions:d.calls.map((c:any,i:number)=>({toolUseId:c.toolUseId,questionIndex:1,kind:i?'finding':'workflow',
    targetIds:i?[d.targets[0].id]:[],independentDecisions:i?1:0,optionActions:[],
    evidence:[{field:'question',optionIndex:null,quote:c.questions[0].question.split('\n')[0]},
      ...(i?[{field:'optionDescription',optionIndex:c.selectedOptions[0],quote:c.questions[0].options[c.selectedOptions[0]-1].description}]:[])],
    reason:i?'Injected test judgment: current requirement proof only. This is not a model result.':'Actual mode selection is workflow.'}))};
}

test('captured retry remains a lexical failure; full original source/native fields feed the existing evaluator unchanged',async()=>{
  const f=input(),original=clone(f);
  expect(hasNativePostAnswerCeoPosture(f.transcript,'HOLD SCOPE',hold,f.selectionStartedAt,f.publicTools,f.source)).toBe(false);
  const review=buildCeoHoldPostureReview(f)!;
  expect(review.plan).toBe(captured.source.content);expect(review.kind).toBe('findings');
  expect(review.floor).toBe(1);expect(review.ceiling).toBe(1);expect(review.deadlineAt).toBe(f.deadlineAt);
  expect(review.fingerprints.map(c=>c.questions)).toEqual([mode(f).questions,decision(f).questions]);
  expect(review.fingerprints.map(c=>c.selectedOptions)).toEqual([[3],[1]]);
  let count=0;
  await evaluateCeoHoldPostureReview(review,async(prompt,model,opts)=>{
    count++;const d=data(prompt);expect(d.plan).toBe(f.source.content);
    expect(d.calls.map((c:any)=>c.questions)).toEqual(review.fingerprints.map(c=>c.questions));
    expect(d.calls.map((c:any)=>c.selectedOptions)).toEqual([[3],[1]]);
    expect(model).toBeUndefined();expect(opts?.max_tokens).toBe(16_384);expect(opts?.signal).toBeInstanceOf(AbortSignal);
    expect(d.targets[0].description).toContain('It must not add a user capability, independently selectable policy, extra measurement objective');
    expect(d.targets[0].description).toContain('Removing or deferring an existing requirement');
    return mockAssessment(prompt);
  });
  expect(count).toBe(1);expect(f).toEqual(original);
});

test('captured first-attempt selected deferral receives no inferred credit or semantic invocation',()=>{
  const first=clone(captured.firstAttempt);now=Date.parse(first.transcript.calls.at(-1)!.answeredAt!)+1;
  expect(first.source.content).toBe(captured.source.content);
  const q=first.transcript.calls.at(-1)!;expect(Object.values(q.answers!)).toEqual(['A) Defer to TODOS.md']);
  expect(first.publicTools.some(e=>e.kind==='use'&&e.name==='Read')).toBe(false);
  expect(()=>buildCeoHoldPostureReview({...first,deadlineAt:first.selectionStartedAt+240_000} as CeoHoldPostureReviewInput))
    .toThrow('complete original source Read/ACK');
});

test.each(['missing transcript','unanswered mode','wrong mode','pending decision','missing decision'])(
  '%s starts no semantic assessment',which=>{
    const f=input();
    if(which==='missing transcript')f.transcript.status='missing';
    if(which==='unanswered mode')mode(f).answered=false;
    if(which==='wrong mode')mode(f).answers={[mode(f).questions[0]!.question]:'SCOPE EXPANSION'};
    if(which==='pending decision'){decision(f).answered=false;delete decision(f).answeredAt;delete decision(f).answers;}
    if(which==='missing decision')f.continuedCallId='foreign:missing';
    expect(buildCeoHoldPostureReview(f)).toBeNull();
  });
const invalid:Array<[string,(f:CeoHoldPostureReviewInput)=>void]>=[
  ['failed decision',f=>{decision(f).failed=true;}],
  ['duplicate decision',f=>{f.transcript.calls.push(clone(decision(f)));}],
  ['foreign session',f=>{decision(f).sessionId='foreign';f.continuedCallId='foreign:'+decisionId;}],
  ['duplicate mode',f=>{f.transcript.calls.push(clone(mode(f)));}],
  ['missing mode ACK',f=>{f.publicTools=f.publicTools.filter(e=>!(e.toolUseId===modeId&&e.kind==='result'));}],
  ['failed mode ACK',f=>{event(f,modeId,'result').isError=true;}],
  ['missing decision ACK',f=>{f.publicTools=f.publicTools.filter(e=>!(e.toolUseId===decisionId&&e.kind==='result'));}],
  ['failed decision ACK',f=>{event(f,decisionId,'result').isError=true;}],
  ['duplicate ACK',f=>{f.publicTools=[...f.publicTools,clone(event(f,decisionId,'result'))];}],
  ['duplicate request',f=>{f.publicTools=[...f.publicTools,clone(event(f,decisionId,'use'))];}],
  ['foreign request fields',f=>{event(f,decisionId,'use').input={questions:mode(f).questions};}],
  ['stale native answer time',f=>{decision(f).answeredAt='2026-09-17T01:01:58.000Z';}],
  ['decision before mode answer',f=>{event(f,decisionId,'use').timestamp=event(f,modeId,'use').timestamp;}],
  ['answer from future',f=>{decision(f).answeredAt=event(f,decisionId,'result').timestamp=new Date(now+1000).toISOString();}],
  ['unoffered selection',f=>{decision(f).answers={[decision(f).questions[0]!.question]:'invented choice'};}],
  ['unanswered tab',f=>{decision(f).unansweredQuestionIndices=[0];}],
  ['multiple questions',f=>{decision(f).questions.push(clone(decision(f).questions[0]!));}],
  ['multi select',f=>revise(f,q=>{q.multiSelect=true;})],
  ['empty question',f=>revise(f,q=>{q.question='';})],
  ['empty header',f=>revise(f,q=>{q.header='';})],
  ['missing option description',f=>revise(f,q=>{delete q.options[0].description;})],
  ['duplicate option labels',f=>revise(f,q=>{q.options[1].label=q.options[0].label;})],
  ['relative source path',f=>{f.source.path='PLAN.md';}],
  ['changed original source bytes',f=>{f.source.content+='\nInvented requirement';}],
  ['foreign native source',f=>revise(f,q=>{q.question=q.question.replace('PLAN.md','OTHER.md');})],
  ['ambiguous native source',f=>revise(f,q=>{q.question=q.question.replace('PLAN.md','PLAN.md and OTHER.md');})],
  ['historical mode context',f=>revise(f,q=>{q.question=q.question.replace('HOLD SCOPE review','previous HOLD SCOPE review');})],
  ['different current mode',f=>revise(f,q=>{q.question=q.question.replace('HOLD SCOPE review','SCOPE EXPANSION review');})],
  ['missing source ACK',f=>{f.publicTools=f.publicTools.filter(e=>!(e.toolUseId===sourceId&&e.kind==='result'));}],
  ['failed source ACK',f=>{event(f,sourceId,'result').isError=true;}],
  ['foreign source ACK',f=>{(event(f,sourceId,'result').file as any).filePath='/foreign/PLAN.md';}],
  ['cropped source content',f=>{(event(f,sourceId,'result').file as any).content=f.source.content.slice(0,80);}],
  ['cropped source lines',f=>{(event(f,sourceId,'result').file as any).numLines=19;}],
  ['late source Read',f=>{event(f,sourceId,'result').timestamp=event(f,decisionId,'result').timestamp;}],
  ['partial Read offset',f=>{event(f,sourceId,'use').input!.offset=2;}],
  ['partial Read limit',f=>{event(f,sourceId,'use').input!.limit=10;}],
  ['second post-mode answer',f=>{const extra=clone(decision(f));extra.toolUseId='extra';f.transcript.calls.push(extra);}],
  ['expired original deadline',f=>{f.deadlineAt=now;}],
  ['invalid original deadline',f=>{f.deadlineAt=NaN;}],
];
test.each(invalid)('%s fails before a judge can run',(_name,mutate)=>{
  const f=input();mutate(f);expect(()=>buildCeoHoldPostureReview(f)).toThrow();
});

test('exact owned absolute source reference has the same authority as its basename',()=>{
  const f=input();
  for(const call of [mode(f),decision(f)]){
    const q=call.questions[0]!,answer=call.answers![q.question];
    q.question=q.question.replace('PLAN.md',f.source.path);call.answers={[q.question]:answer};
    event(f,call.toolUseId,'use').input={questions:clone(call.questions)};
  }
  expect(buildCeoHoldPostureReview(f)!.plan).toBe(f.source.content);
});
test.each(['/foreign/PLAN.md','../PLAN.md','./PLAN.md','file:///foreign/PLAN.md','PLAN.md and /foreign/PLAN.md'])(
  'foreign or relative source declaration %s cannot borrow the owned Read',source=>{
    const f=input();revise(f,q=>{q.question=q.question.replace('PLAN.md',source);});
    expect(()=>buildCeoHoldPostureReview(f)).toThrow('native source context');
  });

test('pinned native omitted multiSelect default remains false without rewriting retained request bytes',()=>{
  const f=input();revise(f,q=>{delete q.multiSelect;});
  const original=clone(f);const review=buildCeoHoldPostureReview(f)!;
  expect(review.fingerprints[1]!.questions![0]!.multiSelect).toBe(false);
  expect(f).toEqual(original);expect(f.transcript.calls.at(-1)!.questions[0]).not.toHaveProperty('multiSelect');
});

test.each(['uncertain','new capability','independent analytics policy','removes requirement','missing target','multiple decisions',
  'invented quote','unselected quote','no question quote','mode supplies target'])(
  'injected negative assessment rejects %s without extra calls',async which=>{
    const review=buildCeoHoldPostureReview(input())!;let count=0;
    await expect(evaluateCeoHoldPostureReview(review,async prompt=>{
      count++;const r=mockAssessment(prompt), row=r.questions[1]!;
      if(['uncertain'].includes(which))Object.assign(row,{kind:'uncertain',targetIds:[],independentDecisions:0});
      if(['new capability','independent analytics policy','removes requirement','missing target'].includes(which)){row.targetIds=[];row.reason=which;}
      if(which==='multiple decisions')row.independentDecisions=2;
      if(which==='invented quote')row.evidence[0]!.quote='invented unsupported promise';
      if(which==='unselected quote'){const q=data(prompt).calls[1].questions[0];row.evidence[1]={field:'optionDescription',optionIndex:2,quote:q.options[1].description};}
      if(which==='no question quote')row.evidence.shift();
      if(which==='mode supplies target'){r.questions[0]!.kind='finding';r.questions[0]!.targetIds=row.targetIds;r.questions[0]!.independentDecisions=1;Object.assign(row,{kind:'workflow',targetIds:[],independentDecisions:0});}
      return r;
    })).rejects.toThrow();expect(count).toBe(1);
  });

test('original first deferral and added measurement capability are distinct uncredited semantic inputs',async()=>{
  const first=captured.firstAttempt.transcript.calls.at(-1)!;
  for(const scenario of ['original deferral','new measurement capability'] as const){
    const review=buildCeoHoldPostureReview(input())!;
    if(scenario==='original deferral'){
      review.fingerprints[1]={...nativePlanCallFingerprint(first,Date.parse(first.answeredAt!),false),toolUseId:first.sessionId+':'+first.toolUseId,
        questions:clone(first.questions),selectedOptions:[1]} as any;
    }else review.fingerprints[1]!.questions![0]!.options[0]!.description='Create a user-facing analytics dashboard and require a new retention policy; call it measurement.';
    await expect(evaluateCeoHoldPostureReview(review,async prompt=>{const r=mockAssessment(prompt);r.questions[1]!.targetIds=[];r.questions[1]!.reason='Injected negative: changes the original obligation rather than supplying its necessary proof.';return r;})).rejects.toThrow();
  }
});

test.each(['provider error','deadline expires'])('%s cannot reset the existing deadline or obtain a second assessment',async scenario=>{
  const review=buildCeoHoldPostureReview(input())!;let calls=0,signal:AbortSignal|undefined;
  await expect(evaluateCeoHoldPostureReview(review,async(prompt,_model,opts)=>{
    calls++;signal=opts!.signal;
    if(scenario==='provider error')throw new Error('injected failed classifier');
    now=review.deadlineAt;return mockAssessment(prompt);
  })).rejects.toThrow();expect(calls).toBe(1);expect(signal!.aborted).toBe(true);
});

// Execute the actual registered callback, with native I/O and the judge replaced
// by captured/mocked boundaries. No paid module is imported, actor created or
// model invoked. The mocked positive proves wiring, not semantic acceptance.
async function registered(scenario:'accept'|'uncertain'|'missing source'|'missing answer'|'lexical pass'|'expansion'){
  const source=fs.readFileSync(path.join(import.meta.dir,'skill-e2e-plan-ceo-mode-routing.test.ts'),'utf8');
  const plan=source.match(/^const PLAN = \[[\s\S]*?^\]\.join\('\\n'\);/m)?.[0];expect(plan).toBeDefined();
  const registration=source.slice(source.indexOf("describeE2E('/plan-ceo-review mode routing (gate)'"));
  expect(registration.startsWith("describeE2E('/plan-ceo-review mode routing (gate)'" )).toBe(true);
  const f=input();now=f.selectionStartedAt-8000;
  const answered=decision(f),pending=clone(answered);pending.answered=false;delete pending.answers;delete pending.answeredAt;pending.unansweredQuestionIndices=[0];
  let stage=0,judges=0,closed=0,cleaned=0;const sends:string[]=[],deadlines:number[]=[];
  const snapshots:string[]=[];const registeredCases:Array<{name:string;run:()=>Promise<void>;timeout:number}>=[];
  const session={hermeticConfigDir:'owned-config',pendingQuestionFile:'owned-pending',exited:()=>false,exitCode:()=>null,
    currentScreen:async()=>stage?'answered decision':'pending decision',visibleSince:()=>'',visibleText:()=>'',rawOutput:()=>'',mark:()=>0,
    send:(s:string)=>{sends.push(s);if(s==='1'){stage=1;now=Date.parse(answered.answeredAt!);}},close:async()=>{closed++;}};
  const read=(_config:string,_cwd:string,emit?:(e:NativePublicToolEvent)=>void)=>{
    const ready=stage===1&&scenario!=='missing answer';
    if(!stage)now=Math.max(now,Date.parse(event(f,decisionId,'use').timestamp)+1);
    const t=clone(f.transcript);t.calls[t.calls.length-1]=ready?clone(answered):clone(pending);
    f.publicTools.filter(e=>!(e.toolUseId===decisionId&&e.kind==='result'&&!ready)&&!(e.toolUseId===sourceId&&scenario==='missing source')).forEach(e=>emit?.(clone(e)));
    return t;
  };
  const c={mode:scenario==='expansion'?'SCOPE EXPANSION':'HOLD SCOPE',postureRe:hold};
  const b={path,CAPTURE_LONG_MS,CASES:[c],EXPANSION_PACING_CALLS:1,
    test:(name:string,run:()=>Promise<void>,timeout:number)=>registeredCases.push({name,run,timeout}),describeE2E:(_s:string,run:()=>void)=>run(),
    Bun:{sleep:async(ms:number)=>{now+=ms;}},Date:{now:()=>now},
    createPlanCountFixture:(plan:string)=>{expect(plan).toBe(captured.source.content);return{cwd:path.dirname(f.source.path),cleanup:()=>{cleaned++;}};},
    launchClaudePty:async()=>session,createPlanCountSnapshotWriter:()=>((args:any)=>{snapshots.push(args.observation.state);return{};}),
    pendingQuestionRecorderStatus:()=>({status:'ready'}),readPendingQuestion:()=>undefined,readPlanCountTranscript:read,
    navigateToModeAskUserQuestion:async()=>({modeIndex:3,visibleAtMode:'captured mode',question:{nativeCall:mode(f)}}),
    planCountQuestionInput:(_v:string,q:any)=>q.nativeCall.toolUseId===modeId?'3':'1',selectPtyNumberedOption:async()=>{throw Error('unexpected legacy key');},
    hasNativePostAnswerCeoPosture:scenario==='lexical pass'||scenario==='expansion'?()=>true:hasNativePostAnswerCeoPosture,
    ceoModeSubmissionInput:()=>null,ceoExpansionPacingReady:()=>false,ceoExpansionPacingChoice:()=>null,
    nextCeoPostureContinuation:(_a:any,_b:any,_c:any,_d:any,_e:any,continued:boolean)=>continued?null:'question',
    capturePlanCountQuestion:()=>({nativeCall:pending}),isPlanReadyVisible:()=>false,isNumberedOptionListVisible:()=>false,
    buildCeoHoldPostureReview,evaluateCeoHoldPostureReview:async(review:PlanReviewDecisionInput)=>{
      deadlines.push(review.deadlineAt);await evaluateCeoHoldPostureReview(review,async prompt=>{judges++;const r=mockAssessment(prompt);if(scenario==='uncertain')Object.assign(r.questions[1]!,{kind:'uncertain',targetIds:[],independentDecisions:0});return r;});
    }};
  const keys=Object.keys(b),js=new Bun.Transpiler({loader:'ts'}).transformSync(`function register(b){const {${keys.join(',')}}=b;${plan}\n${registration}}`);
  new Function(js+';return register;')()(b);expect(registeredCases).toHaveLength(1);
  expect(registeredCases[0]!.name).toBe(`mode "${c.mode}" routes to its distinctive posture`);
  expect(registeredCases[0]!.timeout).toBe(CAPTURE_LONG_MS);
  let error:unknown;try{await registeredCases[0]!.run();}catch(e){error=e;}
  expect(closed).toBe(1);expect(cleaned).toBe(1);
  return{judges,deadlines,sends,snapshots,error,deadline:f.selectionStartedAt+240_000};
}
test.each(['accept','uncertain','missing source','missing answer','lexical pass','expansion'] as const)(
  'actual registered callback: %s preserves one-answer/one-assessment bounds',async scenario=>{
    const r=await registered(scenario);
    expect(r.judges).toBe(scenario==='accept'||scenario==='uncertain'?1:0);
    expect(r.sends.filter(s=>s==='1')).toHaveLength(scenario==='lexical pass'||scenario==='expansion'?0:1);
    if(scenario==='accept'||scenario==='uncertain')expect(r.deadlines).toEqual([r.deadline]);
    if(['accept','lexical pass','expansion'].includes(scenario)){expect(r.error).toBeUndefined();expect(r.snapshots.at(-1)).toBe('posture_confirmed');}
    else{expect(r.error).toBeInstanceOf(Error);expect(r.snapshots.at(-1)).toBe('failed');}
  });
