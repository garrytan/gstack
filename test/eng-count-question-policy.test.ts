import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import captured from './fixtures/eng-count-actor-491.json';
import planningCapture from './fixtures/eng-d2-planning-prelude-4d.json';
import { createEngCountActor, engCountActorRequest, ENG_COUNT_COMMITMENTS, pickEngCountQuestion } from './helpers/eng-count-question-policy';
import { capturePlanCountQuestion, nativePlanCallFingerprint, planCountQuestionInput, planCountPrerequisitePick, matchesNativePlanQuestion, runPlanSkillCounting } from './helpers/claude-pty-runner';
import type { NativeQuestion } from './helpers/plan-skill-questions';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';

const ROOT = path.resolve(import.meta.dir, '..');
const request = engCountActorRequest(captured.seed);
const original = (i: number) => structuredClone(captured.calls[i]!.questions[0]!) as NativeQuestion;
const commitment = (id: string) => {
  const row = ENG_COUNT_COMMITMENTS.find(row => row.id === id);
  if (!row) throw new Error('Unknown test catalog ID '+id);
  return {label:row.label,description:row.description};
};
const question = (ids: readonly string[], source = original(0)) => ({...source, options:ids.map(commitment)});
const offered = (id: string, source = original(0)) => ({...source,options:[commitment(id),{label:'Different recommendation',description:'An arbitrary alternative; this option is not approved.'}]});
const controlled = (i: number) => {
  const q=original(i);q.options[captured.controlledReplacements.replaceIndices[i]!]=commitment(captured.controlledReplacements.selectedIds[i]!);return q;
};
function pending(i = 0, q = controlled(i)): NativePlanQuestionCall {
  return {...structuredClone(captured.calls[i]!), questions:[q], answered:false, failed:false,
    answers:undefined, answeredAt:undefined, unansweredQuestionIndices:[0]};
}
function frame(q: NativeQuestion, packet?: NativeQuestion[], index = 0): string {
  const header = packet ? `← ${packet.map((p,i) => `${i < index ? '☒' : '☐'} ${p.header}`).join(' ')} ✔ Submit →` : `☐ ${q.header}`;
  return `${header}\n${q.question}\n${q.options.map((o,i) => `${i === 0 ? '❯ ' : '  '}${i+1}. ${o.label}\n     ${o.description}`).join('\n')}\n  ${q.options.length+1}. Type something.\n  ${q.options.length+2}. Chat about this\nEnter to select · ${packet ? 'Tab/Arrow keys' : '↑/↓'} to navigate · Esc to cancel`;
}
function owned<T>(run: (cwd: string) => T): T {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-actor-owned-'));
  try { fs.writeFileSync(path.join(cwd,'PLAN.md'),request); return run(cwd); }
  finally { fs.rmSync(cwd, {recursive:true,force:true}); }
}
function active(call = pending()) {
  return {...nativePlanCallFingerprint(call,1,false),nativeQuestionIndex:0};
}

test('original evidence retains thirteen actual option-one answers and the timeout; replacements are controlled', () => {
  expect(captured.provenance.source).toBe('491566889b47a73db0f5b20799a901a80c38d756');
  expect(captured.provenance.outcome).toBe('timeout');
  expect(captured.provenance.noNewBehaviorCredit).toBe(true);
  expect(captured.calls).toHaveLength(13);
  expect(captured.calls.map(c => c.questions[0]!.options.findIndex(o => o.label === c.answers[c.questions[0]!.question]) + 1)).toEqual(Array(13).fill(1));
  expect(original(10).question).toContain('This is new behavior');
  expect(captured.controlledReplacements.qualification).toContain('not recovered original native calls or paid outcomes');
});

for (let i=0;i<13;i++) {
  test(`original D${i+1} cannot borrow newly declared authority`,()=>expect(()=>pickEngCountQuestion(original(i))).toThrow());
  test(`controlled D${i+1} replacement preserves choice intent across reorderings`,()=>{
    const q=controlled(i),chosen=commitment(captured.controlledReplacements.selectedIds[i]!);
    expect(q.options[pickEngCountQuestion(q)-1]).toEqual(chosen);
    q.options.reverse();expect(q.options[pickEngCountQuestion(q)-1]).toEqual(chosen);
    q.options=q.options.slice(1).concat(q.options[0]!);expect(q.options[pickEngCountQuestion(q)-1]).toEqual(chosen);
    expect(q.question).toBe(original(i).question);
  });
}

test('request keeps the entire original seed and leaves analysis, count and legacy regression evidence to the review',()=>{
  expect(request.startsWith(captured.seed+'\n\n')).toBe(true);
  const extra=request.slice(captured.seed.length);
  expect(extra).not.toContain('legacyAuthFlow');expect(extra).not.toContain('baseline');expect(extra).not.toContain('replay');
  expect(extra).toContain('does not require an item to be offered');
  for(const row of ENG_COUNT_COMMITMENTS){expect(extra).toContain(JSON.stringify(row.label));expect(extra).toContain(JSON.stringify(row.description));}
  expect(()=>engCountActorRequest('')).toThrow();expect(()=>engCountActorRequest(request)).toThrow();
  expect(()=>createEngCountActor(captured.seed)).toThrow('declared catalog');
});

for(const row of ENG_COUNT_COMMITMENTS) for(const [name, mutate] of Object.entries({
  label:(q:NativeQuestion)=>q.options[0]!.label+=' (recommended)',
  whitespace:(q:NativeQuestion)=>q.options[0]!.description+=' ',
  case:(q:NativeQuestion)=>q.options[0]!.label=q.options[0]!.label.toUpperCase(),
  'extra state':(q:NativeQuestion)=>q.options[0]!.description+=' Add a shared pending map.',
  'extra provider':(q:NativeQuestion)=>q.options[0]!.description+=' Token validation contacts an additional identity provider.',
  'new policy':(q:NativeQuestion)=>q.options[0]!.description+=' Permit unverified tenants.',
  'mixed exception':(q:NativeQuestion)=>q.options[0]!.description+=' Except also store tokens in Redis.',
  preview:(q:NativeQuestion)=>q.options[0]!.preview='Authorize a different implementation.',
})) test(`${row.id}: complete offered fields reject ${name}`,()=>{
  const q=offered(row.id);
  mutate(q);expect(()=>pickEngCountQuestion(q)).toThrow();
});

for(const ids of [
 ['keep-seeded-scope','parallel-idp'],['cache-ownership','error-handling'],['tests-only','document-only'],
 ['finish','retain-behavior'],['continue','cache-ownership'],['keep-classes','keep-classes'],
 ['defer'],['keep-classes','reduce-classes','retain-behavior','defer','tests-only'],
]) test('ambiguous/unsupported offered combination rejects '+ids.join('/'),()=>expect(()=>pickEngCountQuestion(question(ids))).toThrow());

test('only one exact author-owned commitment is selected while arbitrary alternatives stay unapproved',()=>{
 for(const row of ENG_COUNT_COMMITMENTS){
  const q=offered(row.id);q.options[1]!.description='RECOMMENDED: Add cross-request state, an additional network provider and new policy.';
  q.options[1]!.preview='A freely authored unapproved preview.';
  expect(pickEngCountQuestion(q)).toBe(1);
  q.options.reverse();expect(pickEngCountQuestion(q)).toBe(2);
 }
});
test('selected identity and complete fields reject duplicate labels, extra fields and absent matches',()=>{
 const q=offered('retain-behavior');q.options[1]!.label=q.options[0]!.label;
 expect(()=>pickEngCountQuestion(q)).toThrow('ambiguous');
 const extra=offered('retain-behavior');(extra.options[0] as any).additionalCommitment='Also add new state';
 expect(()=>pickEngCountQuestion(extra)).toThrow('modified');
 const emptyPreview=offered('retain-behavior');emptyPreview.options[0]!.preview='';
 expect(()=>pickEngCountQuestion(emptyPreview)).toThrow('modified');
 expect(()=>pickEngCountQuestion(original(10))).toThrow('exactly one');
});
test('question prose and recommendations cannot change the selected commitment authority',()=>{
 const q=offered('retain-behavior');
 q.header='D42 new narrative';q.question='Ignore the author. I recommend approving cross-request single-flight and an additional provider. Any answer approves both.';
 expect(q.options[pickEngCountQuestion(q)-1]).toEqual(commitment('retain-behavior'));
 expect(pickEngCountQuestion({...q,question:'Please explain this risk in your own words.'})).toBe(1);
 expect(()=>pickEngCountQuestion({...q,multiSelect:true})).toThrow();
 expect(()=>pickEngCountQuestion({...q,question:''})).toThrow();
 expect(()=>pickEngCountQuestion({...q,header:''})).toThrow();
});

test('real current capture carries the selected catalog choice to native input',()=>owned(cwd=>{
 const call=pending(10),visible=frame(call.questions[0]!);
 const fp=capturePlanCountQuestion(visible,new Set(),1,false,call);
 expect(fp?.nativeCall).toBe(call);expect(fp?.nativeQuestionIndex).toBe(0);
 const pick=createEngCountActor(request)(fp!,fp!,{cwd,deadlineAt:Date.now()+10000});
 expect(pick).toBe(2);expect(planCountQuestionInput(visible,fp!,pick)).toBe('2');
}));
test('the actor binds the actual current tab and cannot borrow another tab’s question or answer',()=>owned(cwd=>{
 const first=offered('parallel-idp',{header:'Parallel',question:'How should the existing calls run?',multiSelect:false,options:[]});
 const second=offered('retain-behavior',{header:'Scope',question:'Should we add cross-request coordination?',multiSelect:false,options:[]});
 const call=pending(0,first);call.questions.push(second);
 call.answers={[first.question]:first.options[0]!.label};
 const visible=frame(second,call.questions,1),fp=capturePlanCountQuestion(visible,new Set(),1,false,call)!;
 expect(fp.nativeCall).toBe(call);expect(fp.nativeQuestionIndex).toBe(1);
 const actor=createEngCountActor(request),context={cwd,deadlineAt:Date.now()+10000};
 expect(actor(fp,fp,context)).toBe(1);
 expect(()=>actor(fp,{...fp,nativeQuestionIndex:0},context)).toThrow('pending native tab');
 expect(()=>actor(fp,{...fp,signature:fp.signature.replace(/1$/,'0')},context)).toThrow('pending native tab');
}));
for(const [name,mutate] of Object.entries({
 'missing native':(fp:any)=>delete fp.nativeCall,
 'wrong signature':(fp:any)=>fp.signature='foreign:call',
 'answered':(fp:any)=>fp.nativeCall.answered=true,
 'failed':(fp:any)=>fp.nativeCall.failed=true,
 'answered active tab':(fp:any)=>fp.nativeCall.answers={[fp.nativeCall.questions[0].question]:'answer'},
 'wrong tab':(fp:any)=>fp.nativeQuestionIndex=1,
 'absent tab':(fp:any)=>delete fp.nativeQuestionIndex,
 'partial prompt':(fp:any)=>fp.promptSnippet=fp.promptSnippet.slice(-300),
 'different options':(fp:any)=>fp.options[0].label='Approve anything',
 'missing option':(fp:any)=>fp.options.pop(),
 'wrong indices':(fp:any)=>fp.options[0].index=4,
 'missing session':(fp:any)=>fp.nativeCall.sessionId='',
})) test('native binding rejects '+name,()=>owned(cwd=>{
 const fp=active();mutate(fp);expect(()=>createEngCountActor(request)(fp,fp,{cwd,deadlineAt:Date.now()+10000})).toThrow();
}));
test('request, session, ordinary seed file and deadline remain bound',()=>owned(cwd=>{
 const actor=createEngCountActor(request),fp=active(),context={cwd,deadlineAt:Date.now()+10000};
 expect(actor(fp,fp,context)).toBe(1);
 const other=pending(1);other.sessionId='foreign';const changed=active(other);
 expect(()=>actor(changed,changed,context)).toThrow('pending native tab');
 expect(()=>actor(fp,fp,{cwd,deadlineAt:Date.now()-1})).toThrow('deadline');
 fs.writeFileSync(path.join(cwd,'PLAN.md'),request+'\nnew authority');expect(()=>actor(fp,fp,context)).toThrow('owned request');
 fs.renameSync(path.join(cwd,'PLAN.md'),path.join(cwd,'other.md'));expect(()=>actor(fp,fp,context)).toThrow();
 fs.symlinkSync('other.md',path.join(cwd,'PLAN.md'));expect(()=>actor(fp,fp,context)).toThrow('owned request');
}));

// Execute the actual loop's narrow dispatch region, with its real capture,
// prerequisite, and input functions. No model, timer, UI or acceptance mock is
// involved in proving whether it sends a key or consumes a seen fingerprint.
const runnerSource=fs.readFileSync(path.join(ROOT,'test/helpers/claude-pty-runner.ts'),'utf8');
const dispatchStart=runnerSource.indexOf('      // Dedupe the complete question, not just its answer labels:');
const dispatchEnd=runnerSource.indexOf('      // Give the agent a beat to advance to the next state.',dispatchStart);
if(dispatchStart<0 || dispatchEnd<=dispatchStart)throw Error('Missing actual counting dispatch adapter boundary');
const dispatchBody=runnerSource.slice(dispatchStart,dispatchEnd);
const dispatchFactory=new Function('capturePlanCountQuestion','nativePlanCallFingerprint','planCountPrerequisitePick','planCountQuestionInput','matchesNativePlanQuestion','path',
 new Bun.Transpiler({loader:'ts'}).transformSync(`return async function(opts,frames,pickerContext){
 const seen=new Set(),sent=[],checkpoints=[];let isFirstAUQ=true;const startedAt=Date.now(),boundaryFired=false;
 const defaultPick=opts.defaultPick??1,remainingWork=()=>10000;
 const session={send:key=>sent.push(key),hermeticConfigDir:opts.hermeticConfigDir??null};const selectPtyNumberedOption=async(s,pick)=>s.send(String(pick)+'\\r');
 const planningDirectory=session.hermeticConfigDir?path.join(session.hermeticConfigDir,'plans'):undefined;
 for(const state of frames){const {visible,pending}=state;const newlyMatched=pending&&matchesNativePlanQuestion(visible,pending,planningDirectory);checkpoints.push({seen:seen.size,sent:sent.length});
 ${dispatchBody}
 }
 return {sent,seen:[...seen],checkpoints};
 }`));
const drive=dispatchFactory(capturePlanCountQuestion,nativePlanCallFingerprint,planCountPrerequisitePick,planCountQuestionInput,matchesNativePlanQuestion,path);
const shortQuestion=(id:string)=>offered('parallel-idp',{header:id,question:'Explain the existing request behavior for '+id+'?',multiSelect:false,options:[]});

for (const config of [planningCapture.pendingRecord.configDir, '/tmp/foreign/.claude', undefined])
test('actual Eng dispatch requires the session planning directory: '+String(config), async()=>{
 const record=structuredClone(planningCapture.pendingRecord.pending);
 const call={sessionId:record.sessionId,toolUseId:record.toolUseId,questions:record.questions,answered:false,failed:false};
 let calls=0;
 const result=await drive({hermeticConfigDir:config,requireNativePicker:true,pickAUQ:(_fp,active)=>{
  calls++;expect(active.nativeCall).toBe(call);return pickEngCountQuestion(call.questions[active.nativeQuestionIndex]);
 }},[{visible:planningCapture.screen,pending:call},{visible:planningCapture.screen,pending:call}],{});
 const owned=config===planningCapture.pendingRecord.configDir;
 expect(calls).toBe(owned?1:0);expect(result.sent).toEqual(owned?['1']:[]);
 expect(result.seen.length>0).toBe(owned);
});

test('opt-in unbound multi-tab redraw waits without calling picker or consuming seen state, then answers matched render',async()=>{
 const first=shortQuestion('First'),second=shortQuestion('Second');const call=pending(0,first);call.questions.push(second);
 let calls=0;
 const result=await drive({requireNativePicker:true,pickAUQ:()=>{calls++;return 2;}},[
  {visible:frame(first),pending:call}, {visible:frame(first,call.questions),pending:call},
 ],{cwd:'unused',deadlineAt:Date.now()+10000});
 expect(result.checkpoints).toEqual([{seen:0,sent:0},{seen:0,sent:0}]);expect(calls).toBe(1);expect(result.sent).toEqual(['2']);
 expect(result.seen).toContain(`${call.sessionId}:${call.toolUseId}:question:0`);
});
test('absent native identity and stale single-question render cannot invoke the required actor',async()=>{
 const q=shortQuestion('Current'),other=shortQuestion('Foreign'),call=pending(0,q);let calls=0;
 const result=await drive({requireNativePicker:true,pickAUQ:()=>{calls++;return 1;}},[
  {visible:frame(q)}, {visible:frame(other),pending:call},
 ],{});
 expect(calls).toBe(0);expect(result.sent).toEqual([]);expect(result.seen).toEqual([]);
});
for(const value of [null,undefined])test('bound required picker cannot fall through on '+String(value),async()=>{
 const q=shortQuestion('Current'),call=pending(0,q);let calls=0;
 await expect(drive({requireNativePicker:true,pickAUQ:()=>{calls++;return value;}},[{visible:frame(q),pending:call}],{})).rejects.toThrow('no authorized choice');
 expect(calls).toBe(1);
});
test('the default multi-tab fallback remains unchanged when opt-in is absent',async()=>{
 const q=shortQuestion('First'),call=pending(0,q);call.questions.push(shortQuestion('Second'));let calls=0;
 const result=await drive({pickAUQ:()=>{calls++;return 2;}},[{visible:frame(q),pending:call}],{});
 expect(calls).toBe(0);expect(result.sent).toEqual(['1']);expect(result.seen.length).toBeGreaterThan(0);
});
test('declared optional prerequisite decline precedes catalog authority only on its matched native tab',async()=>{
 const q:NativeQuestion={header:'Office hours',question:'There is no design doc. Run /office-hours or proceed?',multiSelect:false,
 options:[{label:'Run /office-hours first',description:'Produce a design doc.'},{label:'Skip — standard review',description:'Proceed with the supplied plan.'}]};
 const call=pending(0,q);let calls=0;
 const result=await drive({requireNativePicker:true,pickAUQ:()=>{calls++;throw Error('not the catalog');}},[{visible:frame(q),pending:call}],{});
 expect(calls).toBe(0);expect(result.sent).toEqual(['2']);
});
test('opt-in requires a picker before creating any native fixture',async()=>{
 await expect(runPlanSkillCounting({requireNativePicker:true} as any)).rejects.toThrow('requires a declared picker');
});

for(const scenario of ['controlled','original-d11','modified-choice'] as const)test('actual registration declares the finite actor and unchanged terminal budget: '+scenario,async()=>{
 const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'eng-catalog-registration-')));
 const script=path.join(temp,'registered.test.ts'),factsPath=path.join(temp,'facts.json');
 const helper=(name:string)=>path.join(ROOT,'test/helpers',name);
 fs.writeFileSync(script,`
import {describe,expect,mock} from 'bun:test';import * as fs from 'node:fs';import * as path from 'node:path';
import captured from ${JSON.stringify(path.join(ROOT,'test/fixtures/eng-count-actor-491.json'))};
import oldTerminal from ${JSON.stringify(path.join(ROOT,'test/fixtures/eng-fb10-count-public.json'))};
import {ENG_COUNT_COMMITMENTS} from ${JSON.stringify(helper('eng-count-question-policy.ts'))};
import * as imported from ${JSON.stringify(helper('claude-pty-runner.ts'))};const actual={...imported};
const facts={actors:0,judges:0,answers:[],required:false,originalSeed:false,report:''};
const save=()=>fs.writeFileSync(${JSON.stringify(factsPath)},JSON.stringify(facts));
const source=fs.readFileSync(${JSON.stringify(path.join(ROOT,'test/skill-e2e-plan-eng-finding-count.test.ts'))},'utf8');
const terminator=${JSON.stringify("].join('\\n');")};
const a=source.indexOf('const planEng5Findings = '),b=source.indexOf(terminator,a);
if(a<0||b<=a)throw Error('Missing actual original-seed builder');
const seed=new Function(new Bun.Transpiler({loader:'ts'}).transformSync(source.slice(a,b+terminator.length))+';return planEng5Findings;')();
mock.module(${JSON.stringify(helper('e2e-gate.ts'))},()=>({describeE2ETier:t=>{expect(t).toBe('periodic');return describe;}}));
mock.module(${JSON.stringify(helper('eng-seeded-coverage.ts'))},()=>({evaluateEngTerminalReview:async(plan,input)=>{
 facts.judges++;facts.originalSeed=plan===seed(facts.report);save();expect(facts.originalSeed).toBe(true);
 expect(plan).not.toContain('Declared review actor interface');expect(input.deadlineAt).toBeLessThanOrEqual(Date.now()+1_500_000);
 return {administrativeCallIds:[],substantiveCallIds:[]};
}}));
mock.module(${JSON.stringify(helper('claude-pty-runner.ts'))},()=>({...actual,runPlanSkillCounting:async opts=>{
 facts.actors++;facts.required=opts.requireNativePicker;facts.report=opts.expectedPlanPath;save();
 expect(opts.requireNativePicker).toBe(true);expect(opts.observeSetupQuestions).toBe(true);expect(opts.preconfiguredReviewActor).toBe(true);
 expect(opts.defaultPick).toBeUndefined();expect(opts.model).toBeUndefined();expect(opts.reviewCountCeiling).toBe(Infinity);
 expect(opts.timeoutMs).toBeLessThanOrEqual(1_500_000);expect(opts.timeoutMs).toBeGreaterThan(1_499_000);
 expect(opts.env).toEqual({QUESTION_TUNING:'false',EXPLAIN_LEVEL:'default'});
 const original=seed(opts.expectedPlanPath);expect(opts.followUpPrompt.startsWith(original+'\\n\\n')).toBe(true);
 fs.writeFileSync(${JSON.stringify(path.join(temp,'PLAN.md'))},opts.followUpPrompt);
 for(let i=0;i<13;i++){
  const call=structuredClone(captured.calls[i]);call.answered=false;call.failed=false;delete call.answers;delete call.answeredAt;
  const q=call.questions[0];
  if(${JSON.stringify(scenario)}!=='original-d11'||i!==10){const r=ENG_COUNT_COMMITMENTS.find(row=>row.id===captured.controlledReplacements.selectedIds[i]);q.options[captured.controlledReplacements.replaceIndices[i]]={label:r.label,description:r.description};}
  if(${JSON.stringify(scenario)}==='modified-choice'&&i===0)q.options[0].description+=' Contact another provider.';
  const screen='☐ '+q.header+'\\n'+q.question+'\\n'+q.options.map((o,j)=>(j===0?'❯ ':'  ')+(j+1)+'. '+o.label+'\\n     '+o.description).join('\\n')+'\\n  '+(q.options.length+1)+'. Type something.\\n  '+(q.options.length+2)+'. Chat about this\\nEnter to select · ↑/↓ to navigate · Esc to cancel';
  const fp=actual.capturePlanCountQuestion(screen,new Set(),1,false,call);expect(fp?.nativeCall).toBe(call);
  const picked=opts.pickAUQ(fp,fp,{cwd:${JSON.stringify(temp)},deadlineAt:Date.now()+10000});facts.answers.push({i,picked,label:q.options[picked-1].label});save();
 }
 const report=oldTerminal.report.replace('| Review | Skill | Runs | Status | Last run | Notes |','| Review | Trigger | Runs | Status | Why | Findings |');
 fs.writeFileSync(opts.expectedPlanPath,report);
 await opts.evaluateTerminal({transcript:{status:'ready',calls:[],assistantMessages:[]},report,reportMtimeMs:Date.now(),startedAt:Date.now(),finishedAt:Date.now(),deadlineAt:Date.now()+1_500_000});
 return {outcome:'plan_ready',elapsedMs:1,step0Count:0,reviewCount:4,fingerprints:[],transcript:{status:'ready',calls:[],assistantMessages:[]},evidence:'controlled callback transport, no behavioral credit'};
}}));
await import(${JSON.stringify(path.join(ROOT,'test/skill-e2e-plan-eng-finding-count.test.ts'))});
`);
 try{
  const child=Bun.spawn([process.execPath,'test',script],{cwd:ROOT,stdout:'pipe',stderr:'pipe',timeout:10000,
   env:{PATH:process.env.PATH??'',HOME:temp,TMPDIR:temp,TEMP:temp,TMP:temp,EVALS_HERMETIC:'1',GIT_CONFIG_NOSYSTEM:'1'}});
  const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  expect(fs.existsSync(factsPath),out+'\n'+err).toBe(true);
  const facts=JSON.parse(fs.readFileSync(factsPath,'utf8'));
  expect(code,out+'\n'+err).toBe(scenario==='controlled'?0:1);expect(facts.actors).toBe(1);expect(facts.required).toBe(true);
  expect(facts.answers).toHaveLength(scenario==='controlled'?13:scenario==='original-d11'?10:0);
  expect(facts.judges).toBe(scenario==='controlled'?1:0);
  if(scenario==='controlled'){expect(facts.originalSeed).toBe(true);expect(facts.answers[10].label).toBe('Keep current behavior');}
  else expect(err).toContain('exactly one complete author-owned offered commitment');
  expect(fs.existsSync(facts.report)).toBe(false);
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
