import {expect, test} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {autoplanBlockingQuestionBoundary, autoplanSetupDecision} from './helpers/autoplan-setup-question';
import {autoplanPhaseCompletions} from './helpers/autoplan-phase-observer';
import {readPendingQuestion, createPendingQuestionRecorder, recordPendingQuestion} from './helpers/plan-count-pending-question';
import {readPlanCountTranscript} from './helpers/plan-count-transcript';
import {E2E_TOUCHFILES} from './helpers/touchfiles';
import capture from './fixtures/autoplan-final-gate-ao.json';

const fixture = (): {screen:string;context:Parameters<typeof autoplanBlockingQuestionBoundary>[1]} => ({screen:capture.screen, context:{commandStartedAt:capture.commandStartedAt,viewportCapturedAt:capture.observedAt,
  transcript:structuredClone(capture.transcript),publicTools:[structuredClone(capture.gateUse)]}});
const detect = (f=fixture()) => autoplanBlockingQuestionBoundary(f.screen,f.context);
const gateCall = (f:ReturnType<typeof fixture>) => f.context.transcript.calls.find(c => c.toolUseId===capture.call.toolUseId)!;
function rebind(f:ReturnType<typeof fixture>) { f.context.publicTools[0]!.input!.questions=structuredClone(gateCall(f).questions); }

test('exact AO unanswered gate stops observation but supplies no missing phase or approval', () => {
 const f=fixture();const before=JSON.stringify(f);
 expect(detect(f)).toEqual({sessionId:capture.call.sessionId,toolUseId:capture.call.toolUseId,source:'native'});
 expect(autoplanSetupDecision(f.screen,new Set(),gateCall(f)).kind).toBe('unrelated');
 // The separate dash repair recognizes DX; recorded original hits stay historical.
 expect(autoplanPhaseCompletions(f.context.transcript,capture.commandStartedAt)).toEqual([
  ...capture.hits,{phase:2.5,ts:1789042284933},
 ]);
 expect(capture.hits.map(h=>h.phase)).toEqual([1,2]);
 expect(JSON.stringify(f)).toBe(before);
 expect(gateCall(f).answered).toBe(false);
});

test('native question identity, status, chronology and current project are mandatory', () => {
 const controls: Array<(f:ReturnType<typeof fixture>)=>void> = [
  f=>{f.context.transcript.status='missing';}, f=>{f.context.transcript.status='error';},
  f=>{f.context.publicTools=[];}, f=>{f.context.publicTools[0]!.timestamp='invalid';},
  f=>{f.context.commandStartedAt=Date.parse(capture.gateUse.timestamp)+1;},
  f=>{f.context.viewportCapturedAt=Date.parse(capture.gateUse.timestamp)-1;},
  f=>{f.context.publicTools[0]!.sessionId='foreign';}, f=>{f.context.publicTools[0]!.toolUseId='foreign';},
  f=>{f.context.publicTools[0]!.name='Read';},
  f=>{f.context.publicTools[0]!.input!.questions=[null];},
  f=>{f.context.publicTools[0]!.input!.questions=[{header:'Approval',question:'Partial'}];}, f=>{f.context.publicTools[0]!.input!.questions=[];},
  f=>{f.context.publicTools.push(structuredClone(f.context.publicTools[0]!));},
  f=>{f.context.publicTools.push({...f.context.publicTools[0]!,kind:'result',isError:false} as any);},
  f=>{gateCall(f).answered=true;}, f=>{gateCall(f).failed=true;},
  f=>{gateCall(f).sessionId='foreign';}, f=>{gateCall(f).questions[0]!.multiSelect=true;},
  f=>{gateCall(f).questions.push(structuredClone(gateCall(f).questions[0]!));},
  f=>{f.context.transcript.calls.push({...structuredClone(gateCall(f)),toolUseId:'other'});},
  f=>{f.context.commandStartedAt=NaN;},
 ];
 for(const [i,change] of controls.entries()){const f=fixture();change(f);expect(detect(f),String(i)).toBeNull();}
});

function render(f:ReturnType<typeof fixture>) {
 const q=gateCall(f).questions[0]!;rebind(f);
 f.screen=`☐ ${q.header}\n\n${q.question.split('\n').map(s=>'│ '+s).join('\n')}\n\n`+
 q.options.map((o,i)=>`${i===0?'❯ ': '  '}${i+1}. ${o.label}\n${o.description?.split('\n').map(s=>'     '+s).join('\n')??''}`).join('\n')+
 `\n  ${q.options.length+1}. Type something.\n  ${q.options.length+2}. Chat about this\nEnter to select · ↑/↓ to navigate · Esc to cancel`;
}

test('copied, stale and incomplete displays do not prove a current blocking question', () => {
 for(const change of [
  (f:ReturnType<typeof fixture>)=>{f.screen='Source panel:\n'+f.screen;},
  f=>{f.screen='Example:\n'+f.screen;}, f=>{f.screen='```text\n'+f.screen+'\n```';},
  f=>{f.screen=f.screen.split('\n').map(row=>'> '+row).join('\n');},
  f=>{f.screen=f.screen.split('\n').map(row=>'    '+row).join('\n');},
  f=>{f.screen+='\nContinuing the review.';}, f=>{f.screen=f.screen.replace('Esc to cancel','Esc to');},
  f=>{f.screen=f.screen.replace('  6. Chat about this','');},
  f=>{f.screen=f.screen.replace('4. Revise the plan or reject','4. Unmatched current choice');},
  f=>{f.screen=f.screen.replace('D2 — Final Approval','D3 — Final Approval');},
  f=>{f.screen=f.screen.replace('❯ 1.','  1.');},
 ]){const f=fixture();change(f);expect(detect(f)).toBeNull();}
});

test('an actual current human wait remains blocking regardless of source or withdrawn body semantics', () => {
 for(const change of [
  (q:any)=>{q.question=q.question.replace('ELI10: ','ELI10: Source excerpt, not a current assessment: ');},
  (q:any)=>{q.question=q.question.replace('ELI10: ','ELI10: If approved, ');},
  (q:any)=>{q.question=q.question.replace('\nELI10:','\nSource excerpt:\nELI10:');},
  (q:any)=>{q.question+='\nThis final approval gate is cancelled.';},
  (q:any)=>{q.question+=' This approval gate is withdrawn.';},
  (q:any)=>{q.question+='\nCorrection: this final gate is not current.';},
  (q:any)=>{q.question+='\n> Historical note: the old gate was cancelled.';},
  (q:any)=>{q.question='Choose one of these approaches?';q.header='Approach';},
  (q:any)=>{q.question=q.question.replace(/^D2 /,'D9 ');},
  (q:any)=>{q.options[0].label='Start implementation';},
 ]){const f=fixture();change(gateCall(f).questions[0]);render(f);expect(detect(f)?.source).toBe('native');}
});

test('validated owned pending-hook fallback retains stale/foreign/completed rejection', () => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'autoplan-final-gate-'));
 const cwd=path.join(root,path.basename(capture.cwd)),config=path.join(root,'config');
 fs.mkdirSync(cwd,{recursive:true});fs.mkdirSync(path.join(config,'projects','owned'),{recursive:true});
 const transcriptPath=path.join(config,'projects','owned',capture.call.sessionId+'.jsonl');fs.writeFileSync(transcriptPath,'');
 const recorder=createPendingQuestionRecorder(cwd,config),startedAt=Date.now()-10;
 const transcript:any={status:'ready',calls:[],assistantMessages:[{sessionId:capture.call.sessionId,timestamp:new Date(startedAt).toISOString(),text:'Finishing this review.'}]};
 const event={hook_event_name:'PreToolUse',cwd,session_id:capture.call.sessionId,tool_name:'AskUserQuestion',tool_use_id:capture.call.toolUseId,transcript_path:transcriptPath,tool_input:{questions:capture.call.questions}};
 try{
  recordPendingQuestion(JSON.stringify(event),recorder.file,cwd,config);
  const get=(t=transcript,cwdArg=cwd,start=startedAt)=>readPendingQuestion(recorder.file,cwdArg,config,start,t);
  const check=(pending=get(),t=transcript)=>autoplanBlockingQuestionBoundary(capture.screen,{commandStartedAt:startedAt,viewportCapturedAt:Date.now(),transcript:t,publicTools:[],pending});
  expect(check()?.source).toBe('pre_tool_use');
  expect(get(transcript,cwd+'-foreign')).toBeUndefined();
  expect(get(transcript,cwd,Date.now()+1000)).toBeUndefined();
  expect(get({...transcript,assistantMessages:[{...transcript.assistantMessages[0],sessionId:'foreign'}]})).toBeUndefined();
  for(const failed of [false,true]){
   const completed={...transcript,calls:[{...capture.call,answered:!failed,failed}]};
   expect(get(completed)).toBeUndefined();expect(check(undefined,completed)).toBeNull();
  }
  recordPendingQuestion(JSON.stringify({...event,hook_event_name:'PostToolUse'}),recorder.file,cwd,config);
  expect(get()).toBeUndefined();expect(check()).toBeNull();
  // The native route consumes the same cwd-scoped public reader as production.
  // Only this local test envelope is synthetic; question bytes stay exact.
  const record={cwd,sessionId:capture.call.sessionId,isSidechain:false,timestamp:new Date().toISOString(),
    message:{role:'assistant',content:[{type:'tool_use',id:capture.call.toolUseId,name:'AskUserQuestion',input:{questions:capture.call.questions}}]}};
  const native=(owner=cwd)=>{
   const events:any[]=[];const transcript=readPlanCountTranscript(config,owner,e=>events.push(e));
   return autoplanBlockingQuestionBoundary(capture.screen,{commandStartedAt:startedAt,viewportCapturedAt:Date.now(),transcript,publicTools:events});
  };
  fs.writeFileSync(transcriptPath,JSON.stringify(record)+'\n');
  expect(native()?.source).toBe('native');expect(native(cwd+'-foreign')).toBeNull();
  fs.writeFileSync(transcriptPath,JSON.stringify({...record,isSidechain:true})+'\n');expect(native()).toBeNull();
 }finally{recorder.dispose();fs.rmSync(root,{recursive:true,force:true});}
});

test('production loop fails without answering; allowed and repeated setup keep their old behavior', async () => {
 const source=fs.readFileSync(path.join(import.meta.dir,'skill-e2e-autoplan-chain.test.ts'),'utf8');
 const begin=source.indexOf('            // This new repository offers routing');
 const end=source.indexOf('\n          }\n        } finally',begin);
 const block=source.slice(begin,end);expect(begin).toBeGreaterThan(0);expect(end).toBeGreaterThan(begin);
 const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
 const loop=new AsyncFunction('autoplanBlockingQuestionBoundary','autoplanSetupDecision','ctx',
  new Bun.Transpiler({loader:'ts'}).transformSync(`async function observeBoundedLoop(){
   const {methodologyAudit,hits,commandStartedAt,viewportCapturedAt,transcript,publicTools,pendingSetupQuestion,panes}=ctx;
   let outcome='timeout',evidence='',blockedQuestion=null,unsupportedSetup=null;
   const inputs=[],seenSetupQuestions=new Set(),session={send:(s)=>inputs.push(s)},Bun={sleep:async()=>{}};
   const selectPtyNumberedOption=async(_session,n)=>session.send(String(n)+'\\r'),isPlanReadyVisible=()=>false;
   for(const visible of panes){const viewport=visible;${block}}
   return {outcome,blockedQuestion,hits,inputs};}`)+'return observeBoundedLoop();');
 const f=fixture(),ctx={...f.context,panes:[f.screen,f.screen],hits:structuredClone(capture.hits),methodologyAudit:['ceo','design','dx','eng'].map(phase=>({phase,passed:true}))};
 const run=(x=ctx)=>loop(autoplanBlockingQuestionBoundary,autoplanSetupDecision,x);
 const result=await run();expect(result).toMatchObject({outcome:'blocked_on_question',hits:capture.hits,inputs:[]});
 expect(await run({...ctx,methodologyAudit:[{phase:'eng',passed:false}]})).toMatchObject({outcome:'incomplete_methodology',inputs:[]});
 expect(await run({...ctx,publicTools:[]})).toMatchObject({outcome:'timeout',inputs:[]});
 const partial=f.screen.replace('Esc to cancel','Esc to');
 expect(await run({...ctx,panes:[partial,partial]})).toMatchObject({outcome:'timeout',inputs:[]});
 expect(await run({...ctx,panes:[partial,f.screen]})).toMatchObject({outcome:'blocked_on_question',inputs:[]});
 const setup=fixture(),q=gateCall(setup).questions[0]!;
 q.header='Routing';q.question='Add gstack skill routing rules to CLAUDE.md? <gstack-qid:routing-injection>';
 q.options=[{label:'Add routing rules (Recommended)',description:'Add project routing.'},{label:'Skip, invoke manually',description:'Keep manual invocation.'}];render(setup);
 expect(autoplanSetupDecision(setup.screen,new Set(),gateCall(setup))).toMatchObject({kind:'input',input:'1'});
 const repeated=await run({...ctx,...setup.context,panes:[setup.screen,setup.screen]});
 expect(repeated).toMatchObject({outcome:'timeout',blockedQuestion:null,inputs:['1']});
 const complete=[1,2,2.5,3].map((phase,index)=>({phase,ts:capture.commandStartedAt+index+1}));
 expect(await run({...ctx,hits:complete})).toMatchObject({outcome:'chain_complete',inputs:[]});
 const errorStart=source.indexOf("        if (outcome === 'blocked_on_question')");
 const errorEnd=source.indexOf("        if (outcome === 'exited'",errorStart);
 const throwBlocked=new Function('outcome','hits','blockedQuestion','transcript','artifacts','evidence',
  new Bun.Transpiler({loader:'ts'}).transformSync(source.slice(errorStart,errorEnd)));
 expect(()=>throwBlocked(result.outcome,result.hits,result.blockedQuestion,f.context.transcript,{},'actual panel')).toThrow('missing phase markers=[2.5,3]');
 expect(()=>throwBlocked('blocked_on_question',[...ctx.hits,{phase:2.5,ts:capture.observedAt-1}],result.blockedQuestion,f.context.transcript,{},'actual panel')).toThrow('missing phase markers=[3]');
 // Even an impossible caller state with all markers cannot turn this disposition into success.
 expect(()=>throwBlocked('blocked_on_question',complete,result.blockedQuestion,f.context.transcript,{},'actual panel')).toThrow('outcome=blocked_on_question');
 const validation=source.slice(source.indexOf('        // Phase 3 (Eng) MUST have been seen.'),source.indexOf('      } finally {\n        try { fs.rmSync(tempDir',source.indexOf('        // Phase 3 (Eng) MUST have been seen.')));
 const validate=new Function('hits','methodologyAudit','expect','transcript','artifacts','evidence',new Bun.Transpiler({loader:'ts'}).transformSync(validation));
 const check=(hits:any[],audit=ctx.methodologyAudit)=>validate(hits,audit,expect,f.context.transcript,{},'Retained final gate');
 expect(()=>check(ctx.hits)).toThrow('Required phase markers missing');expect(()=>check(complete)).not.toThrow();
 expect(()=>check(complete,[])).toThrow();
 expect(()=>check(complete.map(h=>h.phase===2.5?{...h,ts:capture.commandStartedAt+10}:h))).toThrow();
});

test('only the Autoplan owner adds the exact fixtures and every indexed entry stays dense', () => {
 expect(E2E_TOUCHFILES['autoplan-chain-pty']).toContain('test/autoplan-final-gate-ao.test.ts');
 expect(E2E_TOUCHFILES['autoplan-chain-pty']).toContain('test/fixtures/autoplan-final-gate-ao.json');
 for(const paths of Object.values(E2E_TOUCHFILES))for(let i=0;i<paths.length;i++){
  expect(Object.hasOwn(paths,i)).toBe(true);expect(typeof paths[i]).toBe('string');
 }
});
