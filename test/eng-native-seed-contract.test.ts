import {expect, test} from 'bun:test';
import captured from './fixtures/eng-native-seed-contract-6f.json';
import goldenDeclaration from './fixtures/eng-legacy-declaration-90f.json';
import idpChoice from './fixtures/eng-idp-choice-90f.json';
import {evaluateEngSeedCoverage, isEngSeedDecisionAUQ} from './helpers/eng-seeded-coverage';
import {isEngCompletionHandoff} from './helpers/eng-completion-handoff';
import structureChoice from './fixtures/eng-structure-choice-90f.json';
import nativePackets from './fixtures/eng-native-packets-b955.json';

const held6bd=nativePackets.held6bd;
const heldStructure=()=>structuredClone(held6bd.transcript.calls.find(c=>c.toolUseId==='toolu_01C1daapitaDzziNHqrVQ9qb')!);
const heldStructureResult=(c=heldStructure())=>evaluateEngSeedCoverage({status:'ready',calls:[c],assistantMessages:[]},'',held6bd.startedAt,held6bd.finishedAt).decisions;
const changeHeldStructure=(edit:(q:any)=>void)=>{const c=heldStructure(),q=c.questions[0]!,chosen=q.options.findIndex(o=>o.label===c.answers[q.question]);edit(q);c.answers={[q.question]:q.options[chosen]!.label};return c;};
test('held6bd structure: actual independently answered four-to-three store consolidation',()=>expect(heldStructureResult()).toEqual({complexity:'8351cb8b-b2d3-424a-8420-137a5ea5be83:toolu_01C1daapitaDzziNHqrVQ9qb'}));
for(const [name,edit] of Object.entries({
 'same components named as classes':(q:any)=>{q.question=q.question.replace('four things:','four classes:');q.options.forEach((o:any)=>o.label=o.label.replace('components','classes'));},
 'explicit duplicate responsibility':(q:any)=>{q.question=q.question.replace('TokenStore is never described, and its name says it does what the adapter already does.','TokenStore has no documented purpose. Its name duplicates the existing adapter\'s job.');},
 'same owned facade responsibility':(q:any)=>{q.options[0].description=q.options[0].description.replace('Exactly one place owns tenant-key construction and invalidation calls on top of the existing adapter','One facade owns tenant-key construction and invalidation over the existing adapter');},
}))test('held6bd structure class accepts '+name,()=>expect(heldStructureResult(changeHeldStructure(edit)).complexity).toBeDefined());
for(const [name,edit] of Object.entries({
 'wrong fold destination':(q:any)=>{q.options[0].label=q.options[0].label.replace('into AuthCache','into OtherCache');},
 'two different current inventories':(q:any)=>{q.question=q.question.replace('Stakes if','ELI10: The plan adds three components: AuthBroker, SessionMint, AuthCache.\nStakes if');},
 'current duplicate claim retracted':(q:any)=>{q.question+='\nCorrection: TokenStore does not duplicate the adapter.';},
 'current responsibility independent':(q:any)=>{q.question+='\nCorrection: TokenStore has a documented independent contract.';},
 'new independent work':(q:any)=>{q.options[0].description+=' Also add Redis.';},
 'subordinate new work':(q:any)=>{q.options[0].description+=' Fold TokenStore while disabling tenant validation.';},
 'same-option negated owner':(q:any)=>{q.options[0].description+=' No single facade owns invalidation.';},
}))test('held6bd structure class rejects '+name,()=>expect(heldStructureResult(changeHeldStructure(edit))).toEqual({}));

test('held6bd historical native/seed gates and current report-bottom assertions',()=>{
 const h=structuredClone(held6bd),t=h.transcript as PlanCountTranscript;
 const source=fs.readFileSync(path.join(import.meta.dir,'skill-e2e-plan-eng-finding-count.test.ts'),'utf8');
 const start=source.indexOf("        if (!['plan_ready', 'completion_summary'].includes(obs.outcome))"),end=source.indexOf('        // A native completion summary',start);
 expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);
 const validate=new Function('fs','planPath','obs','assertReviewReportAtBottom',new Bun.Transpiler({loader:'ts'}).transformSync(source.slice(start,end)));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'eng-held-captured-')),file=path.join(dir,'report.md'),now=Date.now;
 try{
  Date.now=()=>h.finishedAt;
  // Only this synthetic file receives the captured timestamp. The owned paid
  // report and its cancelled outcome remain immutable.
  const write=(body=h.plan)=>{fs.writeFileSync(file,body);fs.utimesSync(file,h.reportMtimeMs/1000,h.reportMtimeMs/1000);};write();
  const admin=new Set<string>();let reviews=0;
  t.calls.forEach((call,index)=>{const fp=nativePlanCallFingerprint(call,0,false);if(isEngCompletionHandoff(fp,h.plan,t.calls.slice(0,index)))admin.add(fp.signature);if(isEngSeedDecisionAUQ(fp,t.calls.slice(0,index),h.startedAt,h.finishedAt))reviews++;});
  expect([...admin]).toEqual(['8351cb8b-b2d3-424a-8420-137a5ea5be83:toolu_01Jzx8JVh6SV9sLe9RgMP7GF']);expect(reviews).toBe(4);
  expect(hasNativePlanTerminal(t,file,h.startedAt,'plan_ready',admin)).toBe(true);
  expect(hasNativePlanTerminal(t,file,h.startedAt,'plan_ready',new Set())).toBe(false);
  const obs={outcome:'plan_ready',transcript:t,reviewCount:reviews,step0Count:0,fingerprints:[],elapsedMs:h.finishedAt-h.startedAt,evidence:'Captured public native ExitPlanMode'};
  // The original deterministic export remains a historical compatibility
  // check. New semantic acceptance is tested through the actual registered
  // PTY path in eng-semantic-terminal; these old reports receive no new credit.
  const check=(input=obs)=>{
    validate(fs,file,input,assertReviewReportAtBottom);
    if(!evaluateEngSeedCoverage(input.transcript,fs.readFileSync(file,'utf8'),h.startedAt,h.finishedAt).ok) throw Error('SEED COVERAGE FAIL');
  };
  expect(()=>check()).not.toThrow();
  expect(()=>check({...obs,outcome:'cancelled'})).toThrow('finding-count FAILED');
  for(const mutate of [
   (copy:PlanCountTranscript)=>{copy.planReadyRequests=[];},
   (copy:PlanCountTranscript)=>{copy.planReadyRequests![0]!.failed=true;},
   (copy:PlanCountTranscript)=>{copy.calls[6]!.answeredAt=t.calls.at(-1)!.answeredAt;},
   (copy:PlanCountTranscript)=>{copy.calls[6]!.answered=false;copy.calls[6]!.unansweredQuestionIndices=[0];},
  ]){const copy=structuredClone(t);mutate(copy);expect(hasNativePlanTerminal(copy,file,h.startedAt,'plan_ready',admin)).toBe(false);}
  const missing=structuredClone(obs);missing.transcript.calls=missing.transcript.calls.filter(c=>c.toolUseId!=='toolu_01C1daapitaDzziNHqrVQ9qb');expect(()=>check(missing)).toThrow('SEED COVERAGE FAIL');
  write(h.plan.replace('suite green on unmodified legacy body','suite red on unmodified legacy body'));expect(()=>check()).toThrow('SEED COVERAGE FAIL');
  write(h.plan+'\n## Unreviewed work\n');expect(()=>check()).toThrow('D19 FAIL');
  expect(h.actualOutcome).toBe('cancelled_no_pass_or_failure_credit');
 }finally{Date.now=now;fs.rmSync(dir,{recursive:true,force:true});}
});
for(const [name,edit] of Object.entries({
 'numeric inventory':(q:any)=>{q.question=q.question.replace('four things:','4 components:');},
 'independent title':(q:any)=>{q.question=q.question.replace(q.question.split('\n')[0],'D23 — Which component arrangement should the token layer use?');},
 'reordered options':(q:any)=>{q.options.reverse();},
 'historical contradiction':(q:any)=>{q.question+='\nEarlier note: "TokenStore now has an independent purpose."';},
}))test('held6bd structure accepts '+name,()=>expect(heldStructureResult(changeHeldStructure(edit)).complexity).toBeDefined());
for(const [name,edit] of Object.entries({
 'foreign source':(q:any)=>{q.question=q.question.replaceAll('PLAN.md','OTHER.md');},
 'same-basename foreign source':(q:any)=>{q.question=q.question.replaceAll('PLAN.md','archive/PLAN.md');},
 'duplicated source':(q:any)=>{q.question+='\nProject/branch/task: OTHER.md';},
 'quoted explanation':(q:any)=>{q.question=q.question.replace(/^ELI10: (.+)$/m,'ELI10: "$1"');},
 'conditional evidence':(q:any)=>{q.question=q.question.replace('ELI10: ','ELI10: If approved, ');},
 'withdrawn choice':(q:any)=>{q.question+='\nThis decision is withdrawn.';},
 'reopened choice':(q:any)=>{q.question+='\nThis decision is "reopened".';},
 'false count':(q:any)=>{q.question=q.question.replace('four things:','five things:');},
 'duplicate inventory':(q:any)=>{q.question=q.question.replace('AuthBroker, SessionMint, AuthCache, and TokenStore','AuthBroker, SessionMint, AuthCache, and AuthCache');},
 'foreign retained service':(q:any)=>{q.options[0].label=q.options[0].label.replace('SessionMint','OtherService');},
 'equal counts':(q:any)=>{q.options[0].label=q.options[0].label.replace('3 components:','4 components:');},
 'no keep alternative':(q:any)=>{q.options[1]={label:'Discuss storage',description:'No arrangement.'};},
 'no fold':(q:any)=>{q.options[0].label=q.options[0].label.replace('(fold TokenStore into AuthCache)','');},
 'remedy borrowed':(q:any)=>{q.options[1].description+=' '+q.options[0].description;q.options[0].description='Undecided storage.';},
 'quoted remedy':(q:any)=>{q.options[0].description='"'+q.options[0].description+'"';},
 'independent current store':(q:any)=>{q.question+='\nCorrection: TokenStore now has a documented independent purpose.';},
 'store retained':(q:any)=>{q.options[0].description+=' But keep TokenStore as a separate class.';},
 'negated fold':(q:any)=>{q.options[0].description+=' Do not fold TokenStore.';},
 'declarative negated fold':(q:any)=>{q.options[0].description+=' This option never folds TokenStore into AuthCache.';},
 'adapter replaced':(q:any)=>{q.options[0].description+=' Replace the existing adapter.';},
 'foreign remedy':(q:any)=>{q.options[0].description+=' This remedy applies to another project.';},
}))test('held6bd structure rejects '+name,()=>expect(heldStructureResult(changeHeldStructure(edit))).toEqual({}));
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {nativePlanCallFingerprint, assertReviewReportAtBottom, classifyPlanCountFrame, hasNativePlanTerminal, isQuestionlessNativePlanExit} from './helpers/claude-pty-runner';
import type {NativePlanQuestionCall, PlanCountTranscript} from './helpers/plan-count-transcript';

const transcript=()=>structuredClone(captured.transcript) as PlanCountTranscript;
const evaluate=(calls=transcript().calls, plan=captured.report)=>evaluateEngSeedCoverage(
  {...transcript(),calls,assistantMessages:[]},plan,captured.startedAt,captured.finishedAt);
const seeds=[[4,'complexity'],[5,'shared-cache'],[7,'swallowed-errors'],[9,'sequential-idp']] as const;

test('current counted alternatives own a complexity reduction without borrowing the preceding fold',()=>{
  const call=structuredClone(structureChoice.calls[1]) as NativePlanQuestionCall;
  const result=evaluateEngSeedCoverage({status:'ready',calls:[call],assistantMessages:[]},'',0,Date.parse(structureChoice.captureAt));
  expect(result.decisions).toEqual({complexity:`${call.sessionId}:${call.toolUseId}`});
});

const structureCall=()=>structuredClone(structureChoice.calls[1]) as NativePlanQuestionCall;
const structureResult=(call=structureCall())=>evaluateEngSeedCoverage({status:'ready',calls:[call],assistantMessages:[]},'',0,Date.parse(structureChoice.captureAt));
const alterStructure=(edit:(q:NativePlanQuestionCall['questions'][number])=>void)=>{
  const call=structureCall();edit(call.questions[0]!);
  call.answers={[call.questions[0]!.question]:call.questions[0]!.options[0]!.label};return call;
};
for(const [name,edit] of Object.entries({
  'renamed title':(q:any)=>{q.question=q.question.replace('Which class/module arrangement for the remaining new units?','Which structure should the remaining components use?');},
  'classes instead of units':(q:any)=>{q.options.forEach((o:any)=>{o.label=o.label.replace(' units:',' classes:');});},
  'reordered inventory':(q:any)=>{q.question=q.question.replace('AuthBroker, SessionMint, AuthCache and RequestPolicy','RequestPolicy, AuthCache, AuthBroker and SessionMint');},
  'reordered choices':(q:any)=>{q.options.reverse();},
  'word counts':(q:any)=>{q.options[0].label=q.options[0].label.replace('3 units:','Three components:');q.options[1].label=q.options[1].label.replace('4 units:','Four components:');},
  'quoted old withdrawal':(q:any)=>{q.question+='\nEarlier note: "D6 is reopened."';},
  'prior fold omitted':(q:any)=>{q.question=q.question.replace('after D4 (strangler) and D5 (TokenStore folded), ','').replace('drops the new-unit count from 5 to 3','drops the remaining class count from 4 to 3');},
}))test('current structure comparison accepts '+name,()=>expect(structureResult(alterStructure(edit)).decisions.complexity).toBeDefined());
for(const [name,edit] of Object.entries({
  'foreign plan':(q:any)=>{q.question=q.question.replaceAll('PLAN.md','OTHER.md');},
  'foreign plan directory':(q:any)=>{q.question=q.question.replaceAll('PLAN.md','archive/PLAN.md');},
  'quoted current source':(q:any)=>{q.question=q.question.replace(/^Project\/branch\/task: (.+)$/m,'Project/branch/task: "$1"');},
  'historical source':(q:any)=>{q.question=q.question.replace('Project/branch/task: ','Project/branch/task: Historical example: ');},
  'quoted explanation':(q:any)=>{q.question=q.question.replace(/^ELI10: (.+)$/m,'ELI10: "$1"');},
  'missing current inventory':(q:any)=>{q.question=q.question.replace('AuthBroker, SessionMint, AuthCache and RequestPolicy','the previous classes');},
  'foreign current component':(q:any)=>{q.question=q.question.replace('AuthCache and RequestPolicy','OtherCache and RequestPolicy');},
  'duplicated current component':(q:any)=>{q.question=q.question.replace('AuthBroker, SessionMint, AuthCache and RequestPolicy','AuthBroker, SessionMint, AuthBroker and RequestPolicy');},
  'no current lifecycle defect':(q:any)=>{q.question=q.question.replace('so a class adds ceremony without adding safety','so either approach is equally necessary');},
  'independent current lifecycle':(q:any)=>{q.question+='\nCorrection: RequestPolicy now requires an independent lifecycle.';},
  'missing baseline option':(q:any)=>{q.options[1].label='Discuss the arrangement';},
  'reversed option counts':(q:any)=>{q.options[0].label=q.options[0].label.replace('3 units:','4 units:');q.options[1].label=q.options[1].label.replace('4 units:','3 units:');},
  'equal option counts':(q:any)=>{q.options[0].label=q.options[0].label.replace('3 units:','4 units:');},
  'duplicate reduced inventory':(q:any)=>{q.options[0].label=q.options[0].label.replace('AuthBroker, SessionMint, AuthCache','AuthBroker, SessionMint, AuthBroker');},
  'foreign reduced component':(q:any)=>{q.options[0].label=q.options[0].label.replace('AuthCache','OtherCache');},
  'unrelated removed component':(q:any)=>{q.options[0].label=q.options[0].label.replace('AuthBroker, SessionMint, AuthCache','RequestPolicy, SessionMint, AuthCache');},
  'pure function borrowed from other option':(q:any)=>{q.options[1].description+=' Pure function.';q.options[0].description=q.options[0].description.replace('pure function','method');},
  'pure function borrowed from question':(q:any)=>{q.question+='\nNet: use a pure function.';q.options[0].description=q.options[0].description.replace('pure function','method');},
  'quoted reduced remedy':(q:any)=>{q.options[0].label='"'+q.options[0].label+'"';q.options[0].description='"'+q.options[0].description.replaceAll('\n',' ')+'"';},
  'negated conversion':(q:any)=>{q.options[0].description+='\nDo not convert RequestPolicy.';},
  'retained lifecycle':(q:any)=>{q.options[0].description+='\nRequestPolicy still retains its lifecycle.';},
  'retained class':(q:any)=>{q.options[0].description+='\nRequestPolicy is still a class.';},
  'mutable result':(q:any)=>{q.options[0].description+='\nThe result is not an immutable type.';},
  'deferred remedy':(q:any)=>{q.options[0].description+='\nThis remedy is deferred.';},
  'quoted deferred remedy':(q:any)=>{q.options[0].description+='\nThis remedy is "deferred".';},
  'reopened decision':(q:any)=>{q.question+='\nD6 is reopened.';},
  'quoted reopened decision':(q:any)=>{q.question+='\nD6 is "reopened".';},
  'withdrawn decision':(q:any)=>{q.question+='\nThis decision is withdrawn.';},
  'conditional decision':(q:any)=>{q.question=q.question.replace('ELI10: ','ELI10: If approved, ');},
}))test('current structure comparison rejects '+name,()=>expect(structureResult(alterStructure(edit)).decisions).toEqual({}));
test('structure decision needs its own current native completion and stable guard identity',()=>{
  const call=structureCall(),finished=Date.parse(structureChoice.captureAt);
  const guard=(c=call,prior:NativePlanQuestionCall[]=[])=>isEngSeedDecisionAUQ(nativePlanCallFingerprint(c,0,true),prior,0,finished);
  expect(guard()).toBe(true);
  expect(guard(call,[structuredClone(structureChoice.calls[0]) as NativePlanQuestionCall])).toBe(true);
  expect(guard(call,[call])).toBe(false);
  for(const edit of [(c:any)=>{c.answered=false;},(c:any)=>{c.failed=true;},(c:any)=>{c.answers={};},(c:any)=>{c.unansweredQuestionIndices=[0];},(c:any)=>{c.answeredAt=new Date(finished+1).toISOString();}]){
    const invalid=structureCall();edit(invalid);expect(guard(invalid)).toBe(false);expect(structureResult(invalid).decisions).toEqual({});
  }
  const alien=structuredClone(structureChoice.calls[0]) as NativePlanQuestionCall;alien.sessionId+='-foreign';expect(guard(call,[alien])).toBe(false);
  const both=structureCall();both.questions.push(transcript().calls[5]!.questions[0]!);both.answers={...both.answers,...transcript().calls[5]!.answers};
  expect(guard(both)).toBe(false);expect(structureResult(both).decisions).toEqual({});
});
const idpCall=()=>structuredClone(idpChoice.call) as NativePlanQuestionCall;
const idpResult=(call=idpCall())=>evaluateEngSeedCoverage({status:'ready',calls:[call],assistantMessages:[]},'',0,Date.parse(idpChoice.captureAt));
const alterIdp=(edit:(q:NativePlanQuestionCall['questions'][number])=>void)=>{
  const call=idpCall();edit(call.questions[0]!);
  call.answers={[call.questions[0]!.question]:call.questions[0]!.options[0]!.label};return call;
};
test('IDP choice owns its current sequential defect and concurrent bounded remedy',()=>{
  const call=idpCall();expect(idpResult(call).decisions).toEqual({'sequential-idp':`${call.sessionId}:${call.toolUseId}`});
});
for(const [name,edit] of Object.entries({
  'numeric count':(q:any)=>{q.question=q.question.replaceAll('five','5');},
  'current ordering vocabulary':(q:any)=>{q.question=q.question.replace('Today the five checks run one after another','Currently the five calls run sequentially');},
  'plain Promise.all with same timeout':(q:any)=>{q.options[0].label=q.options[0].label.replace('Promise.allSettled','Promise.all');},
  'reordered choices':(q:any)=>{q.options.reverse();},
  'timeout in same description':(q:any)=>{q.options[0].description+=' Every call has a per-call timeout of 2000 ms.';q.options[0].label=q.options[0].label.replace(' + per-call timeout (default 2000 ms)','');},
  'quoted earlier cancellation':(q:any)=>{q.question+='\nEarlier note: "D13 is deferred."';},
  'planned future concurrency':(q:any)=>{q.question+='\nUnder the proposed option, the five IDP calls run concurrently.';},
  'parallel scheduling title':(q:any)=>{q.question=q.question.replace('issued concurrently','issued in parallel');},
}))test('IDP choice accepts '+name,()=>expect(idpResult(alterIdp(edit)).decisions['sequential-idp']).toBeDefined());
for(const [name,edit] of Object.entries({
  'foreign source':(q:any)=>{q.question=q.question.replaceAll('PLAN.md','OTHER.md');},
  'foreign source directory':(q:any)=>{q.question=q.question.replaceAll('PLAN.md','archive/PLAN.md');},
  'quoted source':(q:any)=>{q.question=q.question.replace(/^Project\/branch\/task: (.+)$/m,'Project/branch/task: "$1"');},
  'historical source':(q:any)=>{q.question=q.question.replace('Project/branch/task: ','Project/branch/task: Historical example: ');},
  'quoted current defect':(q:any)=>{q.question=q.question.replace(/^ELI10: (.+)$/m,'ELI10: "$1"');},
  'unrelated title':(q:any)=>{q.question=q.question.replace('How should the five IDP validation calls be issued concurrently?','Which monitoring dashboard should we use?');},
  'dependent source calls':(q:any)=>{q.question=q.question.replace('five independent IDP calls','five dependent IDP calls');},
  'missing current ordering':(q:any)=>{q.question=q.question.replace('Today the five checks run one after another','The five checks have no specified ordering');},
  'reversed current ordering':(q:any)=>{q.question=q.question.replace('Today the five checks run one after another','Today the five checks run concurrently');},
  'current parallel correction':(q:any)=>{q.question+='\nCorrection: the five IDP calls already run concurrently.';},
  'current dependency correction':(q:any)=>{q.question+='\nCorrection: the IDP calls are not independent.';},
  'no offered timeout':(q:any)=>{q.options[0]={label:'Promise.allSettled',description:'Launch all calls concurrently and report every result.'};},
  'timeout borrowed from sequential choice':(q:any)=>{q.options[0]={label:'Promise.allSettled',description:'Launch all calls concurrently and report every result.'};q.options[2].description+=' Per-call timeout 2000 ms.';},
  'timeout borrowed from question':(q:any)=>{q.options[0]={label:'Promise.allSettled',description:'Launch all calls concurrently and report every result.'};q.question+='\nRecommendation: per-call timeout.';},
  'only sequential timeout remedy':(q:any)=>{q.options[0]={label:'Keep the five calls sequential with per-call timeout',description:'Run each call after the previous call completes.'};},
  'same-option no timeout':(q:any)=>{q.options[0].description+='\nCorrection: no per-call timeout.';},
  'same-option sequential correction':(q:any)=>{q.options[0].description+='\nCorrection: keep the five calls sequential.';},
  'same-option no concurrency':(q:any)=>{q.options[0].description+='\nDo not use Promise.allSettled.';},
  'same-option negated timeout addition':(q:any)=>{q.options[0].description+='\nDo not add a per-call timeout.';},
  'same-option calls remain sequential':(q:any)=>{q.options[0].description+='\nCorrection: The IDP calls remain sequential.';},
  'parallel title foreign source':(q:any)=>{q.question=q.question.replace('issued concurrently','issued in parallel').replaceAll('PLAN.md','OTHER.md');},
  'parallel title without timeout':(q:any)=>{q.question=q.question.replace('issued concurrently','issued in parallel');q.options[0]={label:'Promise.allSettled',description:'Launch all calls concurrently and report every result.'};},
  'parallel title sequential correction':(q:any)=>{q.question=q.question.replace('issued concurrently','issued in parallel');q.options[0].description+='\nCorrection: The IDP calls remain sequential.';},
  'quoted offered remedy':(q:any)=>{q.options[0].label='"'+q.options[0].label+'"';q.options[0].description='"'+q.options[0].description.replaceAll('\n',' ')+'"';},
  'conditional remedy':(q:any)=>{q.options[0].description='If approved, '+q.options[0].description;},
  'withdrawn decision':(q:any)=>{q.question+='\nD13 is withdrawn.';},
  'reopened decision':(q:any)=>{q.question+='\nD13 is reopened.';},
  'scalar quoted deferred decision':(q:any)=>{q.question+='\nD13 is "deferred".';},
  'deferred offered remedy':(q:any)=>{q.options[0].description+='\nThis remedy is deferred.';},
  'scalar quoted pending remedy':(q:any)=>{q.options[0].description+='\nThis remedy is "pending".';},
}))test('IDP choice rejects '+name,()=>expect(idpResult(alterIdp(edit)).decisions).toEqual({}));
test('IDP choice requires its own completed native answer and distinct seed identity',()=>{
  const call=idpCall(),finished=Date.parse(idpChoice.captureAt);
  const guard=(c=call,prior:NativePlanQuestionCall[]=[])=>isEngSeedDecisionAUQ(nativePlanCallFingerprint(c,0,true),prior,0,finished);
  expect(guard()).toBe(true);expect(guard(call,[call])).toBe(false);
  for(const edit of [(c:any)=>{c.answered=false;},(c:any)=>{c.failed=true;},(c:any)=>{c.answers={};},(c:any)=>{c.unansweredQuestionIndices=[0];},(c:any)=>{c.answeredAt=new Date(finished+1).toISOString();}]){
    const invalid=idpCall();edit(invalid);expect(guard(invalid)).toBe(false);expect(idpResult(invalid).decisions).toEqual({});
  }
  const foreign=structuredClone(transcript().calls[5]) as NativePlanQuestionCall;foreign.sessionId+='-foreign';expect(guard(call,[foreign])).toBe(false);
  const bundled=idpCall();bundled.questions.push(transcript().calls[5]!.questions[0]!);bundled.answers={...bundled.answers,...transcript().calls[5]!.answers};
  expect(guard(bundled)).toBe(false);expect(idpResult(bundled).decisions).toEqual({});
});
for(const [index,seed] of seeds) test('actual native decision owns '+seed,()=>{
  expect(Object.keys(evaluate([transcript().calls[index]!],'').decisions)).toEqual([seed]);
});
test('actual final callback assertions pass without changing the recorded failed attempt',()=>{
  expect(captured.originalOutcome).toBe('no_review_questions');
  expect(captured.originalCounts).toEqual({review:0,setup:14});
  const result=evaluate();
  expect(result.ok).toBe(true);
  expect(new Set(Object.values(result.decisions)).size).toBe(4);
  expect(result.regression).toBe('plan');
  expect(assertReviewReportAtBottom(captured.report).ok).toBe(true);
});

const change=(index:number,edit:(q:NativePlanQuestionCall['questions'][number])=>void)=>{
  const c=transcript().calls[index]!,q=c.questions[0]!;edit(q);c.answers={[q.question]:q.options[0]!.label};return c;
};
for(const [name,edit] of Object.entries({
  'quoted provenance':(q:any)=>{q.question=q.question.replace(/^Project\/branch\/task: (.+)$/m,'Project/branch/task: "$1"');},
  'source history':(q:any)=>{q.question=q.question.replace('Project/branch/task: ','Project/branch/task: Historical example: ');},
  'foreign source':(q:any)=>{q.question=q.question.replaceAll('PLAN.md','OTHER.md');},
  'foreign suffix':(q:any)=>{q.question=q.question.replaceAll('PLAN.md','OTHER-PLAN.md');},
  'foreign directory':(q:any)=>{q.question=q.question.replaceAll('PLAN.md','archive/PLAN.md');},
  'quoted explanation':(q:any)=>{q.question=q.question.replace(/^ELI10: (.+)$/m,'ELI10: "$1"');},
  'conditional explanation':(q:any)=>{q.question=q.question.replace('ELI10: ','ELI10: If approved, ');},
  'withdrawn question':(q:any)=>{q.question+='\nThis decision is withdrawn.';},
  'withdrawn remedy':(q:any)=>{q.options[0].description+='\nThis remedy is withdrawn.';},
  'quoted inactive status':(q:any)=>{q.question+='\nThis decision is "withdrawn".';},
  'remedy borrowed from Net':(q:any)=>{q.question+='\nNet: '+q.options[0].description;q.options[0].description='Discuss the next steps.';},
  'quoted remedy':(q:any)=>{q.options[0].label='"'+q.options[0].label+'"';q.options[0].description='"'+q.options[0].description.replaceAll('\n',' ')+'"';},
})) test('source-bound semantic classes reject '+name,()=>{
  for(const [index] of seeds.slice(0,3))expect(evaluate([change(index,edit)],'').decisions).toEqual({});
});
for(const [index,label,edit] of [
  [4,'inventory count',(q:any)=>{q.question=q.question.replace('five new building blocks','six new building blocks');}],
  [4,'second store',(q:any)=>{q.options[0].description=q.options[0].description.replace('One owner for cached token state; no second store','Two owners for cached token state; a second store');}],
  [4,'retained class independence',(q:any)=>{q.question+='\nTokenStore already has a documented independent purpose.';}],
  [5,'other service',(q:any)=>{q.options[0].label=q.options[0].label.replace('pass to both constructors','pass to another constructor');}],
  [5,'shared test instance',(q:any)=>{q.options[0].description=q.options[0].description.replace('fresh AuthCache','shared AuthCache');}],
  [5,'already repaired cache',(q:any)=>{q.question+='\nThe services are already injected.';}],
  [7,'partial mapping',(q:any)=>{q.options[0].label=q.options[0].label.replace('each error class','some error classes');}],
  [7,'fail open',(q:any)=>{q.options[0].label=q.options[0].label.replace('fail closed','fail open');}],
  [7,'swallowed errors',(q:any)=>{q.options[0].description=q.options[0].description.replace('nothing is silently swallowed','errors are silently swallowed');}],
  [7,'already repaired function',(q:any)=>{q.question+='\nvalidateAndDispatch() already no longer swallows failures.';}],
] as const)test('same-option remedy requires '+label,()=>expect(evaluate([change(index,edit)],'').decisions).toEqual({}));

test('semantic wording and type names do not require the captured sentence',()=>{
  const edits=[
    [4,(q:any)=>{q.question=q.question.replace('five new building blocks','5 new components').replace('TokenStore is never described','TokenStore is undefined');q.options[0].label=q.options[0].label.replace('Consolidate:','Merge:').replace('typed value/config','config');}],
    [5,(q:any)=>{q.options[0].label=q.options[0].label.replace('AuthCache once','one AuthCache').replace('pass to both constructors','injected to both services');q.options[0].description=q.options[0].description.replace('fresh AuthCache','isolated instance');}],
    [7,(q:any)=>{q.options[0].label=q.options[0].label.replace('AuthFailure','RejectedAuth').replace('one boundary catch','single catch at the boundary');}],
  ] as const;
  for(const [index,edit] of edits)expect(Object.keys(evaluate([change(index,edit)],'').decisions)).toHaveLength(1);
});

test('historical seed guard remains available while the actual callback uses one terminal assessment',()=>{
  const source=fs.readFileSync(path.join(import.meta.dir,'skill-e2e-plan-eng-finding-count.test.ts'),'utf8');
  const guard=(fp:any,prior:NativePlanQuestionCall[])=>isEngSeedDecisionAUQ(fp,prior,captured.startedAt,captured.finishedAt);
  const calls=transcript().calls;
  expect(calls.filter((c,i)=>guard(nativePlanCallFingerprint(c,0,true),calls.slice(0,i)))).toHaveLength(4);
  expect(source).not.toContain('createEngBatchingIssueCounter');
  expect(source).toContain('evaluateEngTerminalReview(followUpPrompt');
  expect(source).not.toContain('isReviewAUQ:');
  expect(source).not.toContain('isCompletionHandoffAUQ:');
  expect(source).toContain('assertReviewReportAtBottom(planContent)');
  expect(source).toContain('reviewCountCeiling: Infinity');
  expect(source).toContain('const deadlineAt = startedAt + 1_500_000');
  expect(source).toContain('timeoutMs: deadlineAt - Date.now()');
  expect(source).toContain('approveEngTestPlanEdits: true');
  expect(source).toContain('preconfiguredReviewActor: true');
  expect(source).toContain('evaluateTerminal: async input =>');
});
test('native guard rejects incomplete, unowned, duplicate and foreign calls',()=>{
  const c=transcript().calls[4]!;
  const guard=(call=c,prior:NativePlanQuestionCall[]=[],edit=(fp:any)=>{})=>{
    const fp=nativePlanCallFingerprint(call,0,true);edit(fp);
    return isEngSeedDecisionAUQ(fp,prior,captured.startedAt,captured.finishedAt);
  };
  expect(guard()).toBe(true);
  for(const [start,end] of [[NaN,captured.finishedAt],[0,Infinity],[captured.finishedAt,captured.startedAt]])expect(isEngSeedDecisionAUQ(nativePlanCallFingerprint(c,0,true),[],start,end)).toBe(false);
  for(const edit of [(c:any)=>{c.answered=false;},(c:any)=>{c.failed=true;},(c:any)=>{c.answeredAt=new Date(captured.startedAt-1).toISOString();},
    (c:any)=>{c.answeredAt=new Date(captured.finishedAt+1).toISOString();},(c:any)=>{c.answers={};}]){
    const bad=structuredClone(c);edit(bad);expect(guard(bad)).toBe(false);
  }
  for(const edit of [(fp:any)=>{delete fp.nativeCall;},(fp:any)=>{fp.signature+='-foreign';},(fp:any)=>{fp.options[0].label='forged';},
    (fp:any)=>{fp.nativeQuestionIndex=1;}])expect(guard(c,[],edit)).toBe(false);
  expect(guard(c,[c])).toBe(false);
  const foreign=structuredClone(c);foreign.sessionId+='-foreign';expect(guard(c,[foreign])).toBe(false);
  const reask=structuredClone(c);reask.toolUseId+='-reasked';expect(guard(reask,[c])).toBe(false);
  const combined=structuredClone(c);combined.questions.push(transcript().calls[5]!.questions[0]!);
  combined.answers={...combined.answers,...transcript().calls[5]!.answers};expect(guard(combined)).toBe(false);
});

const declaration=/^\*\*CRITICAL regression contract \(D9\):\*\*.+$/m.exec(captured.report)![0];
const baselineTask=/^- \[ \] \*\*T1[^\n]+\n(?:  - [^\n]+\n?)+/m.exec(captured.report)![0];
const minimalBaseline=()=>`# Current reviewed plan\n\n## Tests\n${declaration}\n\n## Implementation Tasks\n${baselineTask}`;
const regression=(plan:string)=>evaluate([],plan).regression;
const goldenPlan = () => goldenDeclaration.report;
const goldenContract = /^\*\*Regression contract[^\n]*\n.*?(?=\n\n)/ms.exec(goldenPlan())![0];
const goldenTask = /^- \[ \] \*\*T9[^\n]*\n(?:  - [^\n]+\n?)+/m.exec(goldenPlan())![0];
const goldenLedger = goldenPlan().slice(goldenPlan().indexOf('### R5:'));
test('the final 90f declaration binds named legacy outcomes to its required task and unchanged baseline', () => {
  expect(goldenDeclaration.reportSha256).toBe('d4ae545eec013da903b5b3c0b459f9f8d2543ea838001271bd7c82b27ac848c3');
  expect(goldenDeclaration.originalOutcome).toBe('seed_coverage_failed');
  expect(goldenDeclaration.nativeCall.toolUseId).toBe('toolu_01DszoYCjnkNfCj5FxaZJsjQ');
  expect(goldenDeclaration.nativeCall.answered).toBe(true);
  expect(regression(goldenPlan())).toBe('plan');
});
for (const [name, edit] of Object.entries({
  'missing declaration': (s:string) => s.replace(goldenContract, ''),
  'missing task': (s:string) => s.replace(goldenTask, ''),
  'missing ledger': (s:string) => s.replace(goldenLedger, ''),
  'missing required status': (s:string) => s.replace('R5, D11, Iron Rule', 'R5, D11'),
  'negated required status': (s:string) => s.replace('R5, D11, Iron Rule', 'R5, D11, not Iron Rule'),
  'optional declaration': (s:string) => s.replace('Regression contract (', 'Optional regression contract ('),
  'conditional capture': (s:string) => s.replace('fixtures pinning current', 'fixtures if approved pinning current'),
  'future outcome oracle': (s:string) => s.replace('pinning current outputs', 'pinning proposed outputs'),
  'foreign legacy target': (s:string) => s.replaceAll('legacyAuthFlow', 'otherAuthFlow'),
  'wrong reviewed source': (s:string) => s.replace('Reviewed target: `PLAN.md`', 'Reviewed target: `OTHER.md`'),
  'wrong reviewed branch': (s:string) => s.replace('on `main`', 'on `feature`'),
  'conflicting reviewed source': (s:string) => s + '\n## Current ownership\nReviewed target: OTHER.md on main\n',
  'foreign finding source': (s:string) => s.replaceAll('PLAN.md:', 'archive/PLAN.md:'),
  'noncritical finding': (s:string) => s.replace('Finding: T1, P1 CRITICAL', 'Finding: T1, P2'),
  'negated critical finding': (s:string) => s.replace('Finding: T1, P1 CRITICAL', 'Finding: T1, P1 not CRITICAL'),
  'pending ownership': (s:string) => s.replace('State: approved', 'State: pending'),
  'duplicate owner': (s:string) => s + '\n' + goldenLedger,
  'wrong record owner': (s:string) => s.replace('### R5:', '### R15:'),
  'duplicate finding': (s:string) => s.replace('State: approved', 'Finding: T1, P1 CRITICAL, PLAN.md:14\nState: approved'),
  'different decision answer': (s:string) => s.replace('A (D11)', 'A (D12)'),
  'selected option omits characterization': (s:string) => s.replace('Actual answer: A', 'Actual answer: B'),
  'selected option has negated characterization': (s:string) => s.replace('Options: A) Characterization', 'Options: A) No characterization'),
  'duplicate offered identity': (s:string) => s.replace('; B) Parity + routing only', '; A) Parity + routing only'),
  'missing named preservation': (s:string) => s.replace(/^Behavior to preserve.+$/m, ''),
  'flagged outcome ownership': (s:string) => s.replace('Behavior to preserve (legacy tenants, flag off)', 'Behavior to preserve (flagged tenants, flag on)'),
  'missing accepted scope': (s:string) => s.replace(/^Accepted scope:.+$/m, ''),
  'conditional accepted scope': (s:string) => s.replace('Accepted scope: (1)', 'Accepted scope: If approved, (1)'),
  'wrong task decision': (s:string) => s.replace('Tests — T1 (PLAN.md:14-16, :27-28), D11', 'Tests — T1 (PLAN.md:14-16, :27-28), D12'),
  'mixed task decisions': (s:string) => s.replace('Tests — T1 (PLAN.md:14-16, :27-28), D11', 'Tests — T1 (PLAN.md:14-16, :27-28), D11, D12'),
  'foreign task source': (s:string) => s.replace('Tests — T1 (PLAN.md:14-16', 'Tests — T1 (archive/PLAN.md:14-16'),
  'negated critical task': (s:string) => s.replace('T9 (P1 CRITICAL', 'T9 (P1 not CRITICAL'),
  'noncritical task': (s:string) => s.replace('T9 (P1 CRITICAL', 'T9 (P2'),
  'negated task': (s:string) => s.replace('Write the `legacyAuthFlow`', 'Do not write the `legacyAuthFlow`'),
  'optional task': (s:string) => s.replace('Write the `legacyAuthFlow`', 'Optionally write the `legacyAuthFlow`'),
  'task count alone': (s:string) => s.replace('Write the `legacyAuthFlow` characterization suite (6 golden fixtures)', 'Create a suite (6 golden fixtures)'),
  'wrong task count': (s:string) => s.replace('suite (6 golden fixtures)', 'suite (5 golden fixtures)'),
  'missing task files': (s:string) => s.replace(/^  - Files:.+$/m, ''),
  'foreign task files': (s:string) => s.replace('legacyAuthFlow.characterization.test', 'otherAuthFlow.characterization.test'),
  'missing task verification': (s:string) => s.replace(/^  - Verify:.+$/m, ''),
  'different baseline': (s:string) => s.replace('unmodified main', 'unmodified feature'),
  'modified baseline': (s:string) => s.replace('unmodified main', 'modified main'),
  'post-refactor baseline': (s:string) => s.replace('before any refactor lands', 'after any refactor lands'),
  'negated baseline': (s:string) => s.replace('suite green on', 'suite not green on'),
  'conditional baseline': (s:string) => s.replace('suite green on', 'if convenient, suite green on'),
  'duplicate task': (s:string) => s.replace(goldenTask, goldenTask + '\n' + goldenTask),
  'neighbor task baseline': (s:string) => s.replace('  - Verify:', '- [ ] **T99** — Other tests\n  - Verify:'),
  'quoted declaration': (s:string) => s.replace(goldenContract, goldenContract.split('\n').map(l => '> ' + l).join('\n')),
  'fenced task': (s:string) => s.replace(goldenTask, '```\n' + goldenTask + '\n```'),
  'historical ledger': (s:string) => s.replace('## Review ledger', '## Historical review ledger'),
  'task withdrawal': (s:string) => s + '\n## Current amendments\nT9 is withdrawn.\n',
  'decision withdrawal': (s:string) => s + '\n## Current amendments\nD11 is withdrawn.\n',
  'record withdrawal': (s:string) => s + '\n## Current amendments\nR5 is withdrawn.\n',
  'baseline reversed': (s:string) => s + '\n## Current amendments\nlegacyAuthFlow will be changed before T9.\n',
})) test('owned legacy declaration rejects ' + name, () => expect(regression(edit(goldenPlan()))).toBeUndefined());
for (const outcome of ['valid', 'expired', 'revoked', 'malformed token', 'suspended tenant', 'IDP unavailable']) {
  for (const owner of ['declaration', 'preservation', 'scope']) test('owned legacy declaration retains ' + outcome + ' in ' + owner, () => {
    const source = goldenPlan();
    const field = owner === 'declaration' ? goldenContract : owner === 'preservation'
      ? /^Behavior to preserve.+$/m.exec(source)![0] : /^Accepted scope:.+$/m.exec(source)![0];
    const mutated = field.replace(new RegExp('\\b' + outcome + '(?:s)?(?:[,;] )?'), '');
    expect(mutated).not.toBe(field);
    expect(regression(source.replace(field, mutated))).toBeUndefined();
  });
}
test('owned legacy declarations support equivalent oracle verbs, selected identities and optional function parentheses', () => {
  for (const verb of ['recording existing', 'capturing prior']) expect(regression(goldenPlan().replace('pinning current', verb))).toBe('plan');
  expect(regression(goldenPlan().replace('Options: A)', 'Options: D)').replace('Actual answer: A (D11)', 'Actual answer: D (D11)'))).toBe('plan');
  expect(regression(goldenPlan().replaceAll('`legacyAuthFlow`', '`legacyAuthFlow()`').replace('Write the', 'Implement the')
    .replace('suite green on unmodified main before any refactor lands', 'suite passes on untouched main before the rewrite begins'))).toBe('plan');
  expect(regression(goldenPlan() + '\n## Other suite\nBilling characterization suite is withdrawn.\n')).toBe('plan');
});
test('the captured legacy contract and its owned task are sufficient without unrelated report text',()=>expect(regression(minimalBaseline())).toBe('plan'));
for(const [name,edit] of Object.entries({
  'missing declaration':(s:string)=>s.replace(declaration,''),
  'missing task':(s:string)=>s.replace(baselineTask,''),
  'foreign target':(s:string)=>s.replaceAll('legacyAuthFlow','otherAuthFlow'),
  'missing baseline verification':(s:string)=>s.replace(/^  - Verify:.+$/m,''),
  'modified baseline':(s:string)=>s.replace('unmodified `main`','modified `main`'),
  'different baseline':(s:string)=>s.replace('unmodified `main`','unmodified `feature`'),
  'wrong task decision':(s:string)=>s.replace('R4/D9 CRITICAL','R4/D99 CRITICAL'),
  'different outcome count':(s:string)=>s.replace('suite (7 outcomes','suite (6 outcomes'),
  'different verification count':(s:string)=>s.replace('each of the 7 outcomes','each of the 6 outcomes'),
  'baseline after wrap':(s:string)=>s.replace('BEFORE the Phase 1 flag wrap','AFTER the Phase 1 flag wrap'),
  'task after wrap':(s:string)=>s.replace('before any flag wrap','after any flag wrap'),
  'negated write':(s:string)=>s.replace('Write the `legacyAuthFlow()`','Do not write the `legacyAuthFlow()`'),
  'negated land':(s:string)=>s.replace('land it green','do not land it green'),
  'conditional task':(s:string)=>s.replace('Write the `legacyAuthFlow()`','If approved, write the `legacyAuthFlow()`'),
  'quoted declaration':(s:string)=>s.replace(declaration,'"'+declaration+'"'),
  'quoted task':(s:string)=>s.replace(baselineTask,'"'+baselineTask.trim().replaceAll('\n',' ')+'"'),
  'historical section':(s:string)=>s.replace('## Tests','## Historical Tests'),
  'conditional declaration':(s:string)=>s.replace('characterization suite at','if approved, characterization suite at'),
  'quoted document':(s:string)=>'Quoted source material only:\n'+s.replace('# Current reviewed plan','# Report'),
  'task cancellation':(s:string)=>s+'\n## Current amendments\nT1 is withdrawn.\n',
  'decision cancellation':(s:string)=>s+'\n## Current amendments\nD9 is "withdrawn".\n',
  'verification cancellation':(s:string)=>s+'\n## Current amendments\nThis verification is optional.\n',
  'reversed implementation order':(s:string)=>s+'\n## Current amendments\nlegacyAuthFlow() will be changed before T1.\n',
}))test('legacy baseline rejects '+name,()=>expect(regression(edit(minimalBaseline()))).toBeUndefined());
test('legacy baseline accepts equivalent mandatory verbs, preserves quoted history and other suite ownership',()=>{
  expect(regression(minimalBaseline().replace('CRITICAL regression contract','Required regression contract').replace('Written and green','Implemented and green').replace('land it green','land it passing'))).toBe('plan');
  expect(regression(minimalBaseline()+'\n## Current amendments\nEarlier note: "T1 is withdrawn."\n')).toBe('plan');
  expect(regression(minimalBaseline()+'\n## Billing regression suite\nThis suite is withdrawn.\n')).toBe('plan');
});
test('final assertion gate still rejects missing seeds, missing legacy coverage and missing report',()=>{
  for(const [index,seed] of seeds){const input=transcript().calls.filter((_,i)=>i!==index);expect(evaluate(input).missing).toContain(seed);expect(evaluate(input).ok).toBe(false);}
  expect(evaluate(transcript().calls,'## GSTACK REVIEW REPORT\nEng complete.\n').ok).toBe(false);
  expect(evaluate(transcript().calls,minimalBaseline()).ok).toBe(false);
});

for(const [index,verb] of [[4,'consolidate'],[5,'inject'],[7,'map']] as const)test('same-option explicit cancellation rejects '+verb,()=>{
  expect(evaluate([change(index,q=>{q.options[0]!.description+='\nCorrection: Do not '+verb+' this remedy.';})],'').decisions).toEqual({});
});

test('historical native exit/seed gates retain current report-bottom assertions',()=>{
  const source=fs.readFileSync(path.join(import.meta.dir,'skill-e2e-plan-eng-finding-count.test.ts'),'utf8');
  const start=source.indexOf("        if (!['plan_ready', 'completion_summary'].includes(obs.outcome))"),end=source.indexOf('        // A native completion summary',start);
  expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);
  const validate=new Function('fs','planPath','obs','assertReviewReportAtBottom',
    new Bun.Transpiler({loader:'ts'}).transformSync(source.slice(start,end)));
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'eng-seed-native-')),file=path.join(dir,'report.md');
  try{
    const write=(body=captured.report)=>{fs.writeFileSync(file,body);fs.utimesSync(file,captured.reportMtimeMs/1000,captured.reportMtimeMs/1000);};write();
    expect(createHash('sha256').update(captured.report).digest('hex')).toBe(captured.reportSha256);
    const t=transcript(),nonReview=new Set<string>();let review=0;
    t.calls.forEach((call,i)=>{const fp=nativePlanCallFingerprint(call,0,true);if(isEngSeedDecisionAUQ(fp,t.calls.slice(0,i),captured.startedAt,captured.finishedAt))review++;else nonReview.add(fp.signature);});
    const frame=classifyPlanCountFrame(captured.screen);
    expect(frame).toBe('plan_ready');expect(review).toBe(4);
    expect(hasNativePlanTerminal(t,file,captured.startedAt,'plan_ready')).toBe(true);
    expect(isQuestionlessNativePlanExit(t,file,captured.startedAt,captured.screen,new Set(t.calls.map(c=>`${c.sessionId}:${c.toolUseId}`)))).toBe(true);
    expect(isQuestionlessNativePlanExit(t,file,captured.startedAt,captured.screen,nonReview)).toBe(false);
    const obs={outcome:frame,transcript:t,reviewCount:review,step0Count:nonReview.size,fingerprints:[],elapsedMs:0,evidence:captured.screen};
    const check=(input=obs)=>{
      validate(fs,file,input,assertReviewReportAtBottom);
      if(!evaluateEngSeedCoverage(input.transcript,fs.readFileSync(file,'utf8'),captured.startedAt,captured.finishedAt).ok) throw Error('SEED COVERAGE FAIL');
    };
    expect(()=>check()).not.toThrow();
    expect(()=>check({...obs,outcome:'no_review_questions' as any})).toThrow('finding-count FAILED');
    const missing={...obs,transcript:{...t,calls:t.calls.filter((_,i)=>i!==4)}};expect(()=>check(missing)).toThrow('SEED COVERAGE FAIL');
    write('## GSTACK REVIEW REPORT\nEng complete.\n');expect(()=>check()).toThrow('SEED COVERAGE FAIL');
    write(captured.report+'\n## Work after report\nExtra\n');expect(()=>check()).toThrow('D19 FAIL');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

for(const [index,claim] of [
  [4,'Correction: A second store still remains.'],
  [5,'Correction: Do not inject AuthCache.'],
  [5,'Correction: Tests do not get a fresh AuthCache.'],
  [5,'Correction: Tests share one AuthCache.'],
  [7,'Correction: Not every failure class has a named outcome.'],
  [7,'Correction: Errors are still swallowed.'],
  [7,'Correction: Some errors are silently ignored.'],
] as const)test('a current contradictory remedy cannot retain earlier positive words: '+claim,()=>{
  expect(evaluate([change(index,q=>{q.options[0]!.description+='\n'+claim;})],'').decisions).toEqual({});
  expect(Object.keys(evaluate([change(index,q=>{q.options[0]!.description+='\nEarlier note: "'+claim+'"';})],'').decisions)).toHaveLength(1);
});

for(const outcomes of [', denied','denied, denied '])test('legacy outcomes cannot use empty or duplicate labels: '+outcomes,()=>{
  const plan=minimalBaseline().replace(/one test per current outcome: [^.]+\./,'one test per current outcome: '+outcomes+'.')
    .replaceAll('7 outcomes','2 outcomes');
  expect(regression(plan)).toBeUndefined();
});

for(const status of ['deferred','not required','not needed','superseded','no longer needed'])test('current baseline ownership respects '+status,()=>{
  for(const id of ['T1','D9']){
    expect(regression(minimalBaseline()+`\n## Current amendments\n${id} is ${status}.\n`)).toBeUndefined();
    expect(regression(minimalBaseline()+`\n## Current amendments\n${id} is "${status}".\n`)).toBeUndefined();
    expect(regression(minimalBaseline()+`\n## Current amendments\nEarlier note: "${id} is ${status}."\n`)).toBe('plan');
  }
});


// Current choice identity is in the title; current defect and exact inventory
// belong to this same native question's source and explanation.
import currentChoiceCab3 from './fixtures/eng-current-choice-cab3.json';

const countedCf74 = (index: number) => structuredClone(currentChoiceCab3.currentCountCf74.calls[index]) as NativePlanQuestionCall;
const countedResultCf74 = (call: NativePlanQuestionCall) => evaluateEngSeedCoverage(
  {status:'ready', calls:[call], assistantMessages:[]}, '', currentChoiceCab3.currentCountCf74.startedAt, currentChoiceCab3.currentCountCf74.finishedAt).decisions;
const countedChangeCf74 = (index:number, edit:(q:NativePlanQuestionCall['questions'][number])=>void) => {
  const c=countedCf74(index), old=c.questions[0]!.question, answer=c.answers![old]!;
  edit(c.questions[0]!);c.answers={[c.questions[0]!.question]:c.questions[0]!.options.some(o=>o.label===answer)?answer:c.questions[0]!.options[0]!.label};return c;
};
for(const [index,name] of [[0,'current undefined-class removal'],[1,'current facade reduction']] as const)
  test('cf74 counted complexity: '+name+' uses its complete current question and one offered alternative',()=>{
    const c=countedCf74(index);expect(countedResultCf74(c)).toEqual({complexity:`${c.sessionId}:${c.toolUseId}`});
    expect(isEngSeedDecisionAUQ(nativePlanCallFingerprint(c,0,true),[],currentChoiceCab3.currentCountCf74.startedAt,currentChoiceCab3.currentCountCf74.finishedAt)).toBe(true);
  });
function countedCheckCf74(index:number,name:string,expected:boolean,edit:(q:NativePlanQuestionCall['questions'][number])=>void) {
  test(`cf74 counted complexity ${index}: ${name}`,()=>{
    const c=countedChangeCf74(index,edit);
    expect(countedResultCf74(c)).toEqual(expected?{complexity:`${c.sessionId}:${c.toolUseId}`}:{ });
  });
}
for(const index of [0,1]) {
  for(const [name,edit] of Object.entries({
    'foreign source':(q:any)=>{q.question=q.question.replaceAll('PLAN.md','OTHER.md');},
    'same-basename foreign path':(q:any)=>{q.question=q.question.replaceAll('PLAN.md','archive/PLAN.md');},
    'duplicate source':(q:any)=>{q.question+='\nProject/branch/task: OTHER.md';},
    'only quoted source':(q:any)=>{q.question=q.question.replace(/^Project\/branch\/task: (.+)$/m,'Project/branch/task: "$1"');},
    'quoted explanation':(q:any)=>{q.question=q.question.replace(/^ELI10: (.+)$/m,'ELI10: "$1"');},
    'single-quoted explanation':(q:any)=>{q.question=q.question.replace(/^ELI10: (.+)$/m,"ELI10: '$1'");},
    'historical explanation':(q:any)=>{q.question=q.question.replace('ELI10: ','ELI10: Historical example: ');},
    'quoted title':(q:any)=>{q.question=q.question.replace(/^([^\n]+)/,'"$1"');},
    'conditional choice':(q:any)=>{q.question+='\nThis decision applies only if approved.';},
    'withdrawn choice':(q:any)=>{q.question+='\nThis decision is withdrawn.';},
    'quoted current withdrawn choice':(q:any)=>{q.question+='\nThis decision is "withdrawn".';},
    'reopened choice':(q:any)=>{q.question+='\nThis decision is reopened.';},
    'missing current explanation':(q:any)=>{q.question=q.question.replace(/^ELI10: .+$/m,'ELI10: A general design discussion.');},
  })) countedCheckCf74(index,name,false,edit);
  const reduction=(q:any)=>q.options.find((o:any)=>/^(?:Defer TokenStore|Drop the facade)/.test(o.label));
  for(const [name,edit] of Object.entries({
    'quoted complete remedy':(q:any)=>{const o=reduction(q);o.description='"'+o.description+'"';},
    'withdrawn remedy':(q:any)=>{reduction(q).description+='\nThis remedy is withdrawn.';},
    'quoted current withdrawn remedy':(q:any)=>{reduction(q).description+='\nThis option is "withdrawn".';},
    'conditional remedy':(q:any)=>{reduction(q).description+='\nThis remedy applies only if approved.';},
    'foreign remedy':(q:any)=>{reduction(q).description+='\nThis remedy applies to another project.';},
    'adapter replacement':(q:any)=>{reduction(q).description+='\nReplace the existing adapter.';},
    'subordinate extra work':(q:any)=>{reduction(q).description+='\nWhile implementing a new database.';},
    'same option adds another feature':(q:any)=>{reduction(q).description+='\nAlso add a new persistence engine.';},
    'descriptive negated removal':(q:any)=>{reduction(q).description+='\nThis option never drops '+(index===0?'TokenStore.':'the facade.');},
    'imperative negated removal':(q:any)=>{reduction(q).description+='\nDo not drop '+(index===0?'TokenStore.':'the facade.');},
    'only history contains remedy':(q:any)=>{const o=reduction(q);o.description='Earlier note: "'+o.description+'"';},
  })) countedCheckCf74(index,name,false,edit);
  for(const [name,edit] of Object.entries({
    'options may reorder':(q:any)=>{q.options.reverse();},
    'decision number may change':(q:any)=>{q.question=q.question.replace(/^D\d+/,'D77');},
    'current question can cite earlier quoted history':(q:any)=>{q.question+='\nEarlier note: "This decision is withdrawn."';},
    'formatting does not own the evidence':(q:any)=>{q.question=q.question.replaceAll('`','');},
  })) countedCheckCf74(index,name,true,edit);
}
for(const [name,edit] of Object.entries({
  'mismatched baseline count':(q:any)=>{q.question=q.question.replace('12 files, 4 new classes','12 files, 5 new classes');},
  'missing current baseline count':(q:any)=>{q.question=q.question.replace('12 files, 4 new classes','an unspecified scope');},
  'duplicate baseline count':(q:any)=>{q.question=q.question.replace('12 files, 4 new classes','12 files, 4 new classes; 12 files, 5 new classes');},
  'no stated contract gap':(q:any)=>{q.question=q.question.replace('without saying what it stores that the adapter does not','with a documented persistence contract');},
  'foreign component has the missing contract':(q:any)=>{q.question=q.question.replace('class called TokenStore (PLAN.md:35)','class called OtherStore (PLAN.md:35)');},
  'existing adapter does not store tokens':(q:any)=>{q.question=q.question.replace('adapter stores tokens','adapter does not store tokens');},
  'existing adapter does not expire tokens':(q:any)=>{q.question=q.question.replace('evicts expired ones','retains expired ones');},
  'current independent responsibility':(q:any)=>{q.question+='\nCorrection: TokenStore has a documented independent persistence purpose.';},
  'already removed from current refactor':(q:any)=>{q.question+='\nCorrection: TokenStore is already removed from this refactor.';},
  'no current keep option':(q:any)=>{q.options[1].label='Discuss storage';},
  'keep option actually removes class':(q:any)=>{q.options[1].description+='\nAlso remove TokenStore.';},
  'removal offers no smaller count':(q:any)=>{q.options[0].description=q.options[0].description.replace('Drops one of the 4 new classes','Keeps all 4 new classes');},
  'same-option negated count':(q:any)=>{q.options[0].description=q.options[0].description.replace('Drops one of the 4 new classes','Never drops one of the 4 new classes');},
  'same-option retained class':(q:any)=>{q.options[0].description+='\nTokenStore remains in this refactor.';},
  'adapter ownership moved to keep option':(q:any)=>{const s='One token source of truth: the retained adapter behind the AuthCache facade.';q.options[0].description=q.options[0].description.replace(s,'No current storage choice.');q.options[1].description+=' '+s;},
  'adapter ownership negated':(q:any)=>{q.options[0].description=q.options[0].description.replace('One token source of truth','Not one token source of truth');},
})) countedCheckCf74(0,name,false,edit);
for(const [name,edit] of Object.entries({
  'wrong total count':(q:any)=>{q.question=q.question.replace('four new types:', 'five new types:');},
  'wrong grouped service count':(q:any)=>{q.question=q.question.replace('two services (AuthBroker, SessionMint)','three services (AuthBroker, SessionMint)');},
  'duplicate grouped service':(q:any)=>{q.question=q.question.replace('two services (AuthBroker, SessionMint)','two services (AuthBroker, AuthBroker)');},
  'foreign current service':(q:any)=>{q.question=q.question.replace('two services (AuthBroker, SessionMint)','two services (AuthBroker, OtherService)');},
  'independent current facade':(q:any)=>{q.question+='\nCorrection: AuthCache now has independent behavior.';},
  'no current facade behavior gap':(q:any)=>{q.question=q.question.replace('it adds no behavior of its own','it owns independent policy behavior');},
  'quoted gap only':(q:any)=>{q.question=q.question.replace('so it adds no behavior of its own','so "it adds no behavior of its own"');},
  'smaller-count arithmetic wrong':(q:any)=>{q.options[1].description=q.options[1].description.replace('Three new types instead of four','Two new types instead of four');},
  'before-count arithmetic wrong':(q:any)=>{q.options[1].description=q.options[1].description.replace('Three new types instead of four','Three new types instead of five');},
  'negated smaller count':(q:any)=>{q.options[1].description=q.options[1].description.replace('Three new types instead of four','Not three new types instead of four');},
  'current keep count contradicts baseline':(q:any)=>{q.options[0].description=q.options[0].description.replace('carrying 3 new ones','carrying 2 new ones');},
  'no keep option':(q:any)=>{q.options[0].label='Discuss interfaces';},
  'keep option removes facade':(q:any)=>{q.options[0].description+='\nAlso drop the facade.';},
  'smaller alternative retains facade':(q:any)=>{q.options[1].description+='\nKeep the AuthCache facade.';},
  'direct adapter action only in another option':(q:any)=>{q.options[1].label='Drop the facade';q.options[0].description+=' Use the adapter directly.';},
  'count only in another option':(q:any)=>{const s='Three new types instead of four';q.options[1].description=q.options[1].description.replace(s,'A different arrangement');q.options[0].description+=' '+s;},
  'existing adapter tests not retained':(q:any)=>{q.options[1].description=q.options[1].description.replace("adapter's existing tests",'new implementation tests');},
})) countedCheckCf74(1,name,false,edit);
countedCheckCf74(0,'equivalent current question and numeric baseline',true,q=>{
  q.question=q.question.replace('Does TokenStore stay in this refactor, or is it cut/deferred?','Keep TokenStore in this refactor or remove it?').replace('12 files, 4 new classes','12 files, four new classes');
});
countedCheckCf74(1,'flat explicit inventory and numeric reduction',true,q=>{
  q.question=q.question.replace('four new types: two services (AuthBroker, SessionMint), RequestPolicy, and AuthCache.','4 new classes: AuthBroker, SessionMint, RequestPolicy, and AuthCache.');
  q.options[1]!.description=q.options[1]!.description!.replace('Three new types instead of four','3 new classes instead of 4');
});
countedCheckCf74(0,'duplicate current metadata count is ambiguous',false,q=>{q.question=q.question.replace('12 files, 4 new classes','12 files, 4 new classes; 12 files, 4 new classes');});
countedCheckCf74(0,'later contradictory removal count cannot borrow earlier reduction',false,q=>{q.options[0]!.description+=' Drops one of the 5 new classes.';});
countedCheckCf74(1,'duplicate complete current inventory is ambiguous',false,q=>{q.question=q.question.replace('ELI10: ','ELI10: The plan adds four new types: AuthBroker, SessionMint, RequestPolicy, and AuthCache. ');});
countedCheckCf74(1,'later contradictory option count stays operative',false,q=>{q.options[1]!.description+=' Four new types instead of four.';});
test('cf74 counted complexity keeps complete native ACK and distinct-seed requirements',()=>{
  const x=currentChoiceCab3.currentCountCf74, c=countedCf74(0), fp=nativePlanCallFingerprint(c,0,true);
  for(const option of c.questions[0]!.options){c.answers={[c.questions[0]!.question]:option.label};expect(countedResultCf74(c).complexity).toBeDefined();}
  expect(isEngSeedDecisionAUQ(fp,[countedCf74(0)],x.startedAt,x.finishedAt)).toBe(false);
  expect(isEngSeedDecisionAUQ(nativePlanCallFingerprint(countedCf74(1),0,true),[countedCf74(0)],x.startedAt,x.finishedAt)).toBe(false);
  for(const edit of [(c:any)=>{c.answered=false;},(c:any)=>{c.failed=true;},(c:any)=>{c.answers={};},(c:any)=>{c.unansweredQuestionIndices=[0];},(c:any)=>{c.answeredAt=new Date(x.finishedAt+1).toISOString();}]){const v=countedCf74(0);edit(v);expect(countedResultCf74(v)).toEqual({});}
  const packet=countedCf74(0),other=countedCf74(1);packet.questions.push(other.questions[0]!);packet.answers![other.questions[0]!.question]=other.answers![other.questions[0]!.question]!;
  expect(countedResultCf74(packet)).toEqual({});
});
const cab3Call=(index:number)=>structuredClone(currentChoiceCab3.calls[index]) as NativePlanQuestionCall;
const cab3Result=(c:NativePlanQuestionCall)=>evaluateEngSeedCoverage({status:'ready',calls:[c],assistantMessages:[]},'',0,Date.parse(currentChoiceCab3.captureAt)).decisions;
const cab3Change=(index:number,edit:(q:NativePlanQuestionCall['questions'][number])=>void)=>{const c=cab3Call(index);edit(c.questions[0]!);c.answers={[c.questions[0]!.question]:c.questions[0]!.options[0]!.label};return c;};
for(const [index,seed] of [[0,'complexity'],[1,'swallowed-errors']] as const){
  test('cab3 current owned choice identifies '+seed,()=>{
    const c=cab3Call(index);expect(cab3Result(c)).toEqual({[seed]:`${c.sessionId}:${c.toolUseId}`});
    expect(isEngSeedDecisionAUQ(nativePlanCallFingerprint(c,0,true),[],0,Date.parse(currentChoiceCab3.captureAt))).toBe(true);
    for(const option of c.questions[0]!.options){c.answers={[c.questions[0]!.question]:option.label};expect(cab3Result(c)[seed]).toBeDefined();}
  });
  test('cab3 current choice preserves formatting, ordering and historical examples: '+seed,()=>{
    for(const edit of [
      (q:any)=>{q.question=q.question.replaceAll('`','');},
      (q:any)=>{q.options.reverse();},
      (q:any)=>{q.question+='\nEarlier note: "This decision is withdrawn."';},
      (q:any)=>{q.question=q.question.replace(/^D\d+ — /,'D42: ');},
    ])expect(cab3Result(cab3Change(index,edit))[seed]).toBeDefined();
  });
  test('cab3 current choice requires its own source and current evidence: '+seed,()=>{
    for(const edit of [
      (q:any)=>{q.question=q.question.replaceAll('PLAN.md','OTHER.md');},
      (q:any)=>{q.question=q.question.replaceAll('PLAN.md','archive/PLAN.md');},
      (q:any)=>{q.question=q.question.replace(/^Project\/branch\/task: (.+)$/m,'Project/branch/task: "$1"');},
      (q:any)=>{q.question=q.question.replace('Project/branch/task: ','Project/branch/task: Historical example: ');},
      (q:any)=>{q.question=q.question.replace(/^ELI10: (.+)$/m,'ELI10: "$1"');},
      (q:any)=>{q.question=q.question.replace('ELI10: ','ELI10: If approved, ');},
      (q:any)=>{q.question+='\nThis decision is withdrawn.';},
      (q:any)=>{q.question+='\nThis decision is "reopened".';},
      (q:any)=>{q.question+='\nThis finding applies only if approved.';},
      (q:any)=>{q.question=q.question.replace(/^([^\n]+)/,'"$1"');},
    ]){const c=cab3Change(index,edit);expect(cab3Result(c),JSON.stringify(c.questions)).toEqual({});}
  });
  test('cab3 current choice cannot borrow an option or bypass native completion: '+seed,()=>{
    for(const edit of [
      (q:any)=>{q.options[0].description='No current remedy.';},
      (q:any)=>{q.options[0].description='"'+q.options[0].description.replaceAll('\n',' ')+'"';},
      (q:any)=>{q.options[0].description+='\nThis remedy is withdrawn.';},
      (q:any)=>{q.options[0].description+='\nThis remedy is "deferred".';},
      (q:any)=>{q.options[0].description+='\nThis remedy applies only if approved.';},
    ])expect(cab3Result(cab3Change(index,edit))).toEqual({});
    for(const edit of [(c:any)=>{c.answered=false;},(c:any)=>{c.failed=true;},(c:any)=>{c.answers={};},(c:any)=>{c.unansweredQuestionIndices=[0];},(c:any)=>{c.questions[0].multiSelect=true;}]){const c=cab3Call(index);edit(c);expect(cab3Result(c)).toEqual({});}
  });
}
test('cab3 store consolidation proves the current inventory and one fewer store',()=>{
 for(const edit of [
   (q:any)=>{q.question=q.question.replace('four components:','4 components:');q.options[0].label=q.options[0].label.replace('3 components:','three components:');q.options[1].label=q.options[1].label.replace('4 components:','four components:');},
   (q:any)=>{q.question=q.question.replace('Component arrangement: keep TokenStore as a separate class, or fold it into AuthCache?','How should the TokenStore and AuthCache components be arranged?');},
   (q:any)=>{q.options[0].label=q.options[0].label.replace('drop TokenStore','remove TokenStore');},
 ])expect(cab3Result(cab3Change(0,edit)).complexity).toBeDefined();
 for(const edit of [
   (q:any)=>{q.question=q.question.replace('four components:','five components:');},
   (q:any)=>{q.question=q.question.replace('AuthCache, and TokenStore.','AuthCache, and OtherStore.');},
   (q:any)=>{q.options[0].label=q.options[0].label.replace('3 components:','4 components:');},
   (q:any)=>{q.options[1].label=q.options[1].label.replace('4 components:','3 components:');},
   (q:any)=>{q.options[0].label=q.options[0].label.replace('AuthCache; drop','AuthBroker; drop');},
   (q:any)=>{q.options[0].label=q.options[0].label.replace('drop TokenStore','keep TokenStore');},
   (q:any)=>{q.options[0].description+='\nDo not remove TokenStore.';},
   (q:any)=>{q.options[0].description+='\nTokenStore remains a separate store.';},
   (q:any)=>{q.question+='\nCorrection: TokenStore has an independent persistence purpose.';},
   (q:any)=>{q.question=q.question.replace("a third layer doing the adapter's job",'an independent component with a separate contract');},
 ])expect(cab3Result(cab3Change(0,edit))).toEqual({});
});
test('cab3 typed error choice owns both visible known outcomes and unknown propagation',()=>{
 for(const edit of [
   (q:any)=>{q.question=q.question.replace('quietly eat one kind of error','silently swallow one error class');},
   (q:any)=>{q.options[0].label=q.options[0].label.replace('AuthResult','AuthOutcome');},
   (q:any)=>{q.options[0].description=q.options[0].description.replace('Unknown errors propagate','Unknown failures are rethrown');},
 ])expect(cab3Result(cab3Change(1,edit))['swallowed-errors']).toBeDefined();
 for(const edit of [
   (q:any)=>{q.question=q.question.replace('quietly eat one kind of error','explicitly surface each error');},
   (q:any)=>{q.question+='\nCorrection: validateAndDispatch() no longer swallows failures.';},
   (q:any)=>{q.options[0].description=q.options[0].description.replace('Unknown errors propagate','Unknown errors are swallowed');},
   (q:any)=>{q.options[0].description=q.options[0].description.replace('Every known error class becomes a visible outcome','Some known error classes are ignored');},
   (q:any)=>{q.options[0].description+='\nNot every known error class becomes a visible outcome.';},
   (q:any)=>{q.options[0].description+='\nDo not propagate unknown errors.';},
   (q:any)=>{q.options[0].description+='\nErrors are still swallowed.';},
   (q:any)=>{q.options[0].description+='\nThis remedy applies to another function.';},
   (q:any)=>{q.options[1].description+=' Unknown errors propagate.';q.options[0].description=q.options[0].description.replace('Unknown errors propagate','Unknown errors are unspecified');},
 ])expect(cab3Result(cab3Change(1,edit))).toEqual({});
});


test('cab3 choice attribution cannot bypass guards through a more explicit title',()=>{
 for(const [index,title] of [[0,'Component classes: keep TokenStore separate, or fold it into AuthCache?'],[1,'Rewrite validateAndDispatch() to fix nested swallowed errors, or add logs?']] as const){
  expect(cab3Result(cab3Change(index,q=>{q.question=q.question.replace(/^D\d+ — [^\n]+/,'D20 — '+title);}))[index===0?'complexity':'swallowed-errors']).toBeDefined();
  for(const suffix of ['\nThis decision is withdrawn.','\nThis decision is "reopened".']) expect(cab3Result(cab3Change(index,q=>{q.question=q.question.replace(/^D\d+ — [^\n]+/,'D20 — '+title)+suffix;}))).toEqual({});
  expect(cab3Result(cab3Change(index,q=>{q.question=q.question.replace(/^D\d+ — [^\n]+/,'D20 — '+title).replaceAll('PLAN.md','OTHER.md');}))).toEqual({});
 }
});
test('cab3 owned remedies reject explicit contradictory retention and silent errors',()=>{
 for(const [index,tail] of [[0,'Keep TokenStore as a separate store.'],[0,'Retain TokenStore as a separate class.'],[1,'Known errors are still hidden.'],[1,'Unknown errors do not propagate.']] as const){
  expect(cab3Result(cab3Change(index,q=>{q.options[0]!.description+='\n'+tail;}))).toEqual({});
  expect(cab3Result(cab3Change(index,q=>{q.options[0]!.description+='\nEarlier note: "'+tail+'"';}))[index===0?'complexity':'swallowed-errors']).toBeDefined();
 }
});

// A whole-candidate scope question can remove one current undefined class;
// it need not restate an arrangement decision or borrow a later cumulative count.
const wholeCandidate=()=>structuredClone(currentChoiceCab3.wholeCandidateRetry.call) as NativePlanQuestionCall;
const wholeFinished=Date.parse(currentChoiceCab3.wholeCandidateRetry.captureAt);
const wholeResult=(call=wholeCandidate())=>evaluateEngSeedCoverage({status:'ready',calls:[call],assistantMessages:[]},'',0,wholeFinished).decisions;
const wholeChange=(edit:(q:NativePlanQuestionCall['questions'][number])=>void)=>{const c=wholeCandidate();edit(c.questions[0]!);c.answers={[c.questions[0]!.question]:c.questions[0]!.options[0]!.label};return c;};
test('whole-candidate complexity: actual owned class removal needs no prior or later decision',()=>{
 const c=wholeCandidate();expect(wholeResult(c)).toEqual({complexity:`${c.sessionId}:${c.toolUseId}`});
 expect(isEngSeedDecisionAUQ(nativePlanCallFingerprint(c,0,true),[],0,wholeFinished)).toBe(true);
 for(const option of c.questions[0]!.options){c.answers={[c.questions[0]!.question]:option.label};expect(wholeResult(c).complexity).toBeDefined();}
});
test('whole-candidate complexity: presentation and equivalent current alternatives preserve identity',()=>{
 for(const edit of [
  (q:any)=>{q.question=q.question.replaceAll('`','');},
  (q:any)=>{q.question=q.question.replace('TokenStore: keep it in this PR, or defer/cut it?','TokenStore: include it in the current PR or remove it?');},
  (q:any)=>{q.question=q.question.replace('one of 4 new classes','one of four new classes');},
  (q:any)=>{q.options.reverse();},
  (q:any)=>{q.question=q.question.replace(/^D4 — /,'D42: ');},
  (q:any)=>{q.question+='\nEarlier note: "TokenStore has an independent persistence purpose."';},
 ])expect(wholeResult(wholeChange(edit)).complexity).toBeDefined();
});
test('whole-candidate complexity: current source, baseline and defect cannot be borrowed',()=>{
 for(const edit of [
  (q:any)=>{q.question=q.question.replaceAll('PLAN.md','OTHER.md');},
  (q:any)=>{q.question=q.question.replaceAll('PLAN.md','archive/PLAN.md');},
  (q:any)=>{q.question=q.question.replace(/^Project\/branch\/task: (.+)$/m,'Project/branch/task: "$1"');},
  (q:any)=>{q.question=q.question.replace('Project/branch/task: ','Project/branch/task: Historical example: ');},
  (q:any)=>{q.question=q.question.replace(/^ELI10: (.+)$/m,'ELI10: "$1"');},
  (q:any)=>{q.question=q.question.replace('ELI10: ','ELI10: If approved, ');},
  (q:any)=>{q.question=q.question.replace(/^([^\n]+)/,'"$1"');},
  (q:any)=>{q.question=q.question.replace('one of 4 new classes','one of 1 new classes');},
  (q:any)=>{q.question=q.question.replace('as one of 4 new classes','as an existing class');},
  (q:any)=>{q.question=q.question.replace('but never says what it does','and defines its independent persistence contract');},
  (q:any)=>{q.question=q.question.replace('already stores tokens keyed by','does not store tokens keyed by');},
  (q:any)=>{q.question+='\nCorrection: TokenStore has a documented independent persistence purpose.';},
  (q:any)=>{q.question+='\nCorrection: TokenStore is already removed from this PR.';},
  (q:any)=>{q.question+='\nThis decision is reopened.';},
  (q:any)=>{q.question+='\nThis decision is "reopened".';},
  (q:any)=>{q.question+='\nThis finding applies only if approved.';},
 ])expect(wholeResult(wholeChange(edit))).toEqual({});
});
test('whole-candidate complexity: removal and retained store belong to the same current option',()=>{
 const reductions=(q:any)=>q.options.filter((o:any)=>/^(?:B|C)\)/.test(o.label));
 for(const edit of [
  (q:any)=>{for(const o of reductions(q))o.description='No current remedy.';},
  (q:any)=>{for(const o of reductions(q))o.description='"'+o.description.replaceAll('\n',' ')+'"';},
  (q:any)=>{for(const o of reductions(q))o.description+='\nThis remedy is withdrawn.';},
  (q:any)=>{for(const o of reductions(q))o.description+='\nDo not remove TokenStore.';},
  (q:any)=>{for(const o of reductions(q))o.description+='\nTokenStore remains in this PR.';},
  (q:any)=>{for(const o of reductions(q))o.description+='\nThis remedy applies only if approved.';},
  (q:any)=>{q.options[0].description='Removes this class from the PR.';q.options[2].description='Adapter remains the single source of truth for cached tokens.';},
  (q:any)=>{q.options=q.options.filter((o:any)=>!o.label.startsWith('A) Include'));},
  (q:any)=>{for(const o of q.options)o.label=o.label.replace(/Defer|Cut/g,'Keep');},
 ])expect(wholeResult(wholeChange(edit))).toEqual({});
});
test('whole-candidate complexity: native completion, session ownership and one-seed deduplication remain required',()=>{
 const c=wholeCandidate(),guard=(x=c,prior:NativePlanQuestionCall[]=[])=>isEngSeedDecisionAUQ(nativePlanCallFingerprint(x,0,true),prior,0,wholeFinished);
 expect(guard()).toBe(true);expect(guard(c,[c])).toBe(false);
 for(const edit of [(x:any)=>{x.answered=false;},(x:any)=>{x.failed=true;},(x:any)=>{x.answers={};},(x:any)=>{x.unansweredQuestionIndices=[0];},(x:any)=>{x.answeredAt=new Date(wholeFinished+1).toISOString();}]){const x=wholeCandidate();edit(x);expect(guard(x)).toBe(false);expect(wholeResult(x)).toEqual({});}
 const foreign=wholeCandidate();foreign.sessionId+='-foreign';foreign.toolUseId+='-other';expect(guard(c,[foreign])).toBe(false);
 const other=wholeCandidate();other.toolUseId+='-other';expect(guard(c,[other])).toBe(false);
});

for(const tail of ['This option never removes an undefined class from this PR.','This is not one fewer file/class.'])
 test('whole-candidate complexity: declarative negation '+tail,()=>{
  const x=wholeChange(q=>{for(const o of q.options.filter(o=>/^(?:B|C)\)/.test(o.label)))o.description=tail+' Adapter remains the single source of truth for cached tokens.';});
  expect(wholeResult(x)).toEqual({});
 });


// Original packet identities and every answer are retained. Single-question
// projections below isolate semantic controls; they never re-credit the paid run.
const packet = (n:number) => structuredClone(nativePackets.calls[n]) as NativePlanQuestionCall;
const packetResult = (calls:NativePlanQuestionCall[]) => evaluateEngSeedCoverage(
  {status:'ready',calls,assistantMessages:[]},'',nativePackets.startedAt,nativePackets.finishedAt);
const packetGuard = (c:NativePlanQuestionCall,prior:NativePlanQuestionCall[]=[]) => isEngSeedDecisionAUQ(
  nativePlanCallFingerprint(c,0,true),prior,nativePackets.startedAt,nativePackets.finishedAt);
const singlePacketQuestion = (n:number,index:number) => {
  const c=packet(n),q=c.questions[index]!;
  c.questions=[q];c.answers={[q.question]:c.answers![q.question]!};return c;
};
const editedPacketQuestion=(n:number,index:number,edit:(q:NativePlanQuestionCall['questions'][number])=>void)=>{
  const c=singlePacketQuestion(n,index),q=c.questions[0]!,chosen=q.options.findIndex(o=>o.label===c.answers![q.question]);
  edit(q);c.answers={[q.question]:q.options[chosen]!.label};return c;
};

test('b955 native packets: actual whole-call options authenticate one seed with independently answered unrelated tabs',()=>{
  const c=packet(1),fp=nativePlanCallFingerprint(c,0,true);
  expect(fp.options).toHaveLength(c.questions.reduce((n,q)=>n+q.options.length,0));
  expect(packetResult([c]).decisions['shared-cache']).toBe(`${c.sessionId}:${c.toolUseId}`);
  expect(packetGuard(c)).toBe(true);
  for(const position of [0,fp.options.length-1]){
    const bad=structuredClone(fp);bad.options[position]!.label='forged option';
    expect(isEngSeedDecisionAUQ(bad,[],nativePackets.startedAt,nativePackets.finishedAt)).toBe(false);
  }
  const firstOnly={...fp,options:fp.options.slice(0,c.questions[0]!.options.length)};
  expect(isEngSeedDecisionAUQ(firstOnly,[],nativePackets.startedAt,nativePackets.finishedAt)).toBe(false);
  const reordered=packet(1);reordered.questions.reverse();expect(packetGuard(reordered)).toBe(true);
});

test('b955 native packets: current structure alternatives offer a real reduction with unchanged feature choices',()=>{
  const c=packet(0);expect(packetGuard(c)).toBe(true);
  expect(packetResult([c]).decisions).toEqual({complexity:`${c.sessionId}:${c.toolUseId}`});
});
test('b955 native packets: original error question owns each swallowed class and an offered flatten/typed/rethrow remedy',()=>{
  const c=singlePacketQuestion(2,0);expect(packetGuard(c)).toBe(true);
  expect(packetResult([c]).decisions).toEqual({'swallowed-errors':`${c.sessionId}:${c.toolUseId}`});
});
test('b955 native packets: one acknowledged packet containing two seeds cannot supply either distinct decision',()=>{
  const c=packet(2);expect(packetGuard(c)).toBe(false);expect(packetResult([c]).decisions).toEqual({});
  const actual=packetResult([packet(0),packet(1),c]);
  expect(Object.keys(actual.decisions).sort()).toEqual(['complexity','shared-cache']);
  expect(actual.missing).toEqual(['swallowed-errors','sequential-idp']);
  expect(nativePackets.originalOutcome).toBe('no_review_questions');
});
for(const [name,edit] of Object.entries({
  'foreign PLAN path':(q:any)=>{q.question=q.question.replaceAll('PLAN.md','archive/PLAN.md');},
  'foreign primary source':(q:any)=>{q.question=q.question.replace('PLAN.md Multi-tenant Auth Refactor','OTHER.md Other Refactor; compare PLAN.md Multi-tenant Auth Refactor');},
  'quoted source':(q:any)=>{q.question=q.question.replace(/^Project\/branch\/task: (.+)$/m,'Project/branch/task: "$1"');},
  'historical source':(q:any)=>{q.question=q.question.replace('Project/branch/task: ','Project/branch/task: Historical example: ');},
  'quoted explanation':(q:any)=>{q.question=q.question.replace(/^ELI10: (.+)$/m,'ELI10: "$1"');},
  'duplicated source':(q:any)=>{q.question+='\nProject/branch/task: OTHER.md';},
  'conditional finding':(q:any)=>{q.question=q.question.replace('ELI10: ','ELI10: If approved, ');},
  'withdrawn decision':(q:any)=>{q.question+='\nThis decision is withdrawn.';},
  'current quoted withdrawal':(q:any)=>{q.question+='\nThis decision is "withdrawn".';},
  'reopened decision':(q:any)=>{q.question+='\nThis decision is reopened.';},
}))test('b955 native packets reject '+name,()=>{
  for(const [n,index] of [[0,0],[2,0]])expect(packetResult([editedPacketQuestion(n!,index!,edit)]).decisions).toEqual({});
});
for(const [name,edit] of Object.entries({
  'numeric counts in explanation':(q:any)=>{q.question=q.question.replace('A) three classes:','A) 3 classes:').replace('B) two classes:','B) 2 classes:');},
  'renamed structure title':(q:any)=>{q.question=q.question.replace(q.question.split('\n')[0],'D7 — Which component arrangement preserves the accepted feature choices?');},
  'reordered native options':(q:any)=>{q.options.reverse();},
  'historical contradiction inert':(q:any)=>{q.question+='\nEarlier note: "AuthCache now has independent behavior."';},
}))test('b955 structure comparison accepts '+name,()=>expect(packetResult([editedPacketQuestion(0,0,edit)]).decisions.complexity).toBeDefined());
for(const [name,edit] of Object.entries({
  'no fixed feature choices':(q:any)=>{q.question=q.question.replace('deliver the same features (D4-D6 held fixed, legacy flow untouched behind a flag)','deliver different features');},
  'foreign retained service':(q:any)=>{q.question=q.question.replaceAll('SessionMint','OtherService');},
  'no current facade':(q:any)=>{q.question=q.question.replace('AuthCache as the one facade over the existing adapter','a new component with an unknown role');},
  'equal option counts':(q:any)=>{q.options[1].label=q.options[1].label.replace('2 classes','3 classes');},
  'mismatched body count':(q:any)=>{q.question=q.question.replace('B) two classes:','B) three classes:');},
  'no offered reduction':(q:any)=>{q.options[1]={label:'B) Discuss the cache',description:'No change yet.'};},
  'no same-option adapter reuse':(q:any)=>{q.options[1].label=q.options[1].label.replace('services use adapter directly','new services');q.options[1].description='Unspecified behavior.';},
  'remedy borrowed from unselected option':(q:any)=>{q.options[0].description+=' Services use adapter directly.';q.options[1].label='B) 2 classes';q.options[1].description='Unspecified behavior.';},
  'foreign comparison letter':(q:any)=>{q.question=q.question.replace('B) two classes:','Z) two classes:');},
  'native baseline is another component':(q:any)=>{q.options[0].label=q.options[0].label.replace('AuthCache facade','ForeignCache wrapper');},
  'foreign offered remedy':(q:any)=>{q.options[1].description+=' This remedy applies to another project.';},
  'same-option retains facade':(q:any)=>{q.options[1].description+=' Correction: Keep the AuthCache facade.';},
  'matching explanation retains facade':(q:any)=>{q.question=q.question.replace('C) one service:', 'But keep the AuthCache facade. C) one service:');},
  'matching explanation cancels drop':(q:any)=>{q.question=q.question.replace('C) one service:', 'Do not drop the facade. C) one service:');},
  'same-option negated removal':(q:any)=>{q.options[1].description+=' Do not drop the facade.';},
  'same-option replaced adapter':(q:any)=>{q.options[1].description+=' Replace the existing adapter.';},
  'same-option withdrawn':(q:any)=>{q.options[1].description+=' This option is withdrawn.';},
  'independent current facade':(q:any)=>{q.question+='\nCorrection: AuthCache now has independent behavior.';},
  'unapproved additional feature':(q:any)=>{q.question+='\nCorrection: The smaller arrangement changes the accepted feature choices.';},
}))test('b955 structure comparison rejects '+name,()=>expect(packetResult([editedPacketQuestion(0,0,edit)]).decisions).toEqual({}));
for(const [name,edit] of Object.entries({
  'current defect equivalent wording':(q:any)=>{q.question=q.question.replace('where each catch quietly eats one kind of error','where every catch silently swallows a different error class');},
  'typed error name changes':(q:any)=>{q.options[0].label=q.options[0].label.replace('AuthError','ValidationFailure');},
  'same-option propagation wording':(q:any)=>{q.options[0].label=q.options[0].label.replace('rethrow','propagate');},
  'reordered options':(q:any)=>{q.options.reverse();},
  'historical correction inert':(q:any)=>{q.question+='\nEarlier note: "validateAndDispatch() no longer swallows failures."';},
}))test('b955 current error choice accepts '+name,()=>expect(packetResult([editedPacketQuestion(2,0,edit)]).decisions['swallowed-errors']).toBeDefined());
for(const [name,edit] of Object.entries({
  'non-swallowing current behavior':(q:any)=>{q.question=q.question.replace('where each catch quietly eats one kind of error','where every catch already surfaces each error');},
  'typed name alone':(q:any)=>{q.options[0]={label:'A) Typed AuthError',description:'Add the named type.'};},
  'no propagation':(q:any)=>{q.options[0].label=q.options[0].label.replace(', rethrow','');},
  'no flattening':(q:any)=>{q.options[0].label=q.options[0].label.replace('Flatten + ','');q.options[0].description=q.options[0].description.replace('Function shrinks to sequential named steps','Function remains deeply nested');},
  'partial classes':(q:any)=>{q.options[0].description=q.options[0].description.replace('Each former swallowed class','Some former swallowed classes');},
  'missing typed result':(q:any)=>{q.options[0].description=q.options[0].description.replace('becomes a typed error','is logged');},
  'borrowed class coverage':(q:any)=>{q.options[1].description+=' '+q.options[0].description;q.options[0].description='Add the named type.';},
  'quoted remedy':(q:any)=>{q.options[0].label='"'+q.options[0].label+'"';q.options[0].description='"'+q.options[0].description+'"';},
  'negated propagation':(q:any)=>{q.options[0].description+=' Do not rethrow errors.';},
  'declarative negation':(q:any)=>{q.options[0].description+=' This option does not rethrow errors.';},
  'errors still swallowed':(q:any)=>{q.options[0].description+=' Correction: Errors are still swallowed.';},
  'incomplete mapping':(q:any)=>{q.options[0].description+=' Not every failure class has a named outcome.';},
  'partial former swallowed classes':(q:any)=>{q.options[0].description+=' Only some former swallowed classes become a typed error.';},
  'negated former class coverage':(q:any)=>{q.options[0].description+=' Not every previously swallowed class becomes a typed error.';},
  'foreign remedy':(q:any)=>{q.options[0].description+=' This remedy applies to another function.';},
  'withdrawn remedy':(q:any)=>{q.options[0].description+=' This option is withdrawn.';},
  'already fixed current source':(q:any)=>{q.question+='\nCorrection: validateAndDispatch() now rethrows every error.';},
}))test('b955 current error choice rejects '+name,()=>expect(packetResult([editedPacketQuestion(2,0,edit)]).decisions).toEqual({}));
test('b955 whole-call adapter keeps native completion and fingerprint integrity checks',()=>{
  for(const edit of [(c:any)=>{c.answered=false;},(c:any)=>{c.failed=true;},(c:any)=>{delete c.answers[c.questions[1].question];c.unansweredQuestionIndices=[1];},(c:any)=>{c.answers[c.questions[2].question]='Not offered';},(c:any)=>{c.answeredAt=new Date(nativePackets.finishedAt+1).toISOString();}]){
    const c=packet(1);edit(c);expect(packetGuard(c)).toBe(false);
  }
  const c=packet(1);expect(packetGuard(c,[c])).toBe(false);
  const foreign=packet(0);foreign.sessionId+='-foreign';expect(packetGuard(c,[foreign])).toBe(false);
  const reask=packet(1);reask.toolUseId+='-reask';expect(packetGuard(reask,[c])).toBe(false);
});
