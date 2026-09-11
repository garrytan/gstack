import {expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {autoplanBlockingQuestionBoundary, autoplanSetupDecision} from './helpers/autoplan-setup-question';
import {autoplanPhaseCompletions} from './helpers/autoplan-phase-observer';
import {E2E_TOUCHFILES, GLOBAL_TOUCHFILES} from './helpers/touchfiles';
import capture from './fixtures/autoplan-cropped-gate-av.json';
const fixture = (): {screen:string; context:Parameters<typeof autoplanBlockingQuestionBoundary>[1]} => ({screen:capture.screen,
 context:{commandStartedAt:capture.commandStartedAt,viewportCapturedAt:capture.viewportCapturedAt,
 transcript:{status:'ready',calls:[structuredClone(capture.call)],assistantMessages:[]},publicTools:[structuredClone(capture.publicUse)]}});
const call=(f:ReturnType<typeof fixture>)=>f.context.transcript.calls[0]!;
const detect=(f=fixture())=>autoplanBlockingQuestionBoundary(f.screen,f.context);
const expected={sessionId:capture.call.sessionId,toolUseId:capture.call.toolUseId,source:'native'};
const rebind=(f:ReturnType<typeof fixture>)=>{f.context.publicTools[0]!.input!.questions=structuredClone(call(f).questions);};
type Change=(f:ReturnType<typeof fixture>)=>void;

test('exact AV crop proves a human wait without answer, phase credit or evidence mutation',()=>{
 const f=fixture(),before=JSON.stringify(f);expect(detect(f)).toEqual(expected);
 expect(autoplanSetupDecision(f.screen,new Set(),call(f))).toEqual({kind:'unrelated'});
 expect(autoplanPhaseCompletions(f.context.transcript,f.context.commandStartedAt)).toEqual([]);
 expect(call(f).answered).toBe(false);expect(call(f).failed).toBe(false);expect(JSON.stringify(f)).toBe(before);
});
test('wrapping and crop position may vary while the owned excerpt and choices remain exact',()=>{
 const controls:Change[]=[
 f=>{f.screen=f.screen.replace(/\n/g,'\r\n');},f=>{f.screen=f.screen.replace(/^│ /gm,'┃ ');},
 f=>{f.screen=f.screen.replace('wall…','wall-clock time');},
 f=>{f.screen=f.screen.replace('│ Pros / cons:\n','│ Pros /\n│ cons:\n');},
 f=>{f.screen=f.screen.slice(f.screen.indexOf('│ Stakes if'));},
 f=>{call(f).questions[0]!.header='Final approval gate';call(f).questions[0]!.question=call(f).questions[0]!.question.replace('D1 — Final Approval Gate: approve the reviewed plan?','D8 — Final Approval: approve the amended plan?');rebind(f);},
 // A native human wait stays real even if the question body retracts approval.
 f=>{call(f).questions[0]!.question+='\nThis final approval gate is withdrawn.';rebind(f);},
 ];for(const [i,change]of controls.entries()){const f=fixture();change(f);expect(detect(f),String(i)).toEqual(expected);}
});
test('native identity, public use, no acknowledgment, current session and time remain mandatory',()=>{
 const controls:Change[]=[
 f=>{f.context.transcript.status='missing';},f=>{f.context.transcript.status='error';},f=>{f.context.transcript.calls=[];},f=>{f.context.publicTools=[];},
 f=>{call(f).answered=true;},f=>{call(f).failed=true;},f=>{call(f).toolUseId='foreign';},f=>{call(f).sessionId='foreign';},
 f=>{f.context.publicTools[0]!.toolUseId='foreign';},f=>{f.context.publicTools[0]!.sessionId='foreign';},f=>{f.context.publicTools[0]!.name='Read';},
 f=>{f.context.publicTools[0]!.timestamp='bad';},f=>{f.context.publicTools[0]!.timestamp=new Date(f.context.viewportCapturedAt+1).toISOString();},
 f=>{f.context.commandStartedAt=Date.parse(capture.publicUse.timestamp)+1;},f=>{f.context.commandStartedAt=NaN;},f=>{f.context.viewportCapturedAt=Infinity;},
 f=>{f.context.publicTools[0]!.input!.questions=[];},f=>{f.context.publicTools[0]!.input!.questions=[{header:'Foreign',question:'Other?'}];},
 f=>{f.context.publicTools.push(structuredClone(f.context.publicTools[0]!));},
 f=>{f.context.publicTools.push({...f.context.publicTools[0]!,kind:'result',isError:false} as any);},
 f=>{f.context.publicTools.push({...f.context.publicTools[0]!,kind:'result',isError:true} as any);},
 f=>{f.context.transcript.calls.push({...structuredClone(call(f)),toolUseId:'another'});},
 f=>{f.context.transcript.assistantMessages.push({sessionId:'foreign',timestamp:capture.publicUse.timestamp,text:'Unrelated'});},
 f=>{call(f).questions[0]!.multiSelect=true;rebind(f);},f=>{call(f).questions.push(structuredClone(call(f).questions[0]!));rebind(f);},
 f=>{const pending={...structuredClone(call(f)),source:'pre_tool_use' as const};f.context.transcript.calls=[];f.context.transcript.assistantMessages=[{sessionId:pending.sessionId,timestamp:capture.publicUse.timestamp,text:'Preparing'}];f.context.publicTools=[];f.context.pending=pending;},
 ];for(const[i,change]of controls.entries()){const f=fixture();change(f);expect(detect(f),String(i)).toBeNull();}
});
test('copied, ambiguous, partial and mismatched crop displays cannot identify a current gate',()=>{
 const controls:Change[]=[
 f=>{f.screen='Source panel:\n'+f.screen;},f=>{f.screen='│ Source panel:\n'+f.screen;},f=>{f.screen='Example:\n'+f.screen;},
 f=>{f.screen='Historical example:\n'+f.screen;},f=>{f.screen='```text\n'+f.screen;},f=>{f.screen='│ ```text\n'+f.screen;},
 f=>{f.screen='> '+f.screen.replace(/\n/g,'\n> ');},f=>{f.screen='    '+f.screen.replace(/\n/g,'\n    ');},
 f=>{f.screen=f.screen.replace(/^│ /gm,'');},f=>{f.screen=f.screen.slice(f.screen.indexOf('❯ 1.'));},
 f=>{f.screen=f.screen.replace('the confirmation modal','the unrelated confirmation');},f=>{f.screen=f.screen.replace('│ Pros / cons:\n','');},
 f=>{f.screen=f.screen.replace('│ Pros / cons:\n','│ Different question?\n');},f=>{f.screen=f.screen.replace('❯ 1.','  1.');},
 f=>{f.screen=f.screen.replace('  2.','❯ 2.');},f=>{f.screen=f.screen.replace('  2.','  7.');},
 f=>{f.screen=f.screen.replace('1. Approve as-is (recommended)','1. Ship immediately');},
 f=>{f.screen=f.screen.replace('Accept all 117 auto-decisions','Reject all 117 auto-decisions');},
 f=>{f.screen=f.screen.replace('     Accept all 117 auto-decisions and the 4 taste recommendations; write review logs; suggest /ship.\n','');},
 f=>{f.screen=f.screen.replace('  5. Type something.','  5. Submit answers');},f=>{f.screen=f.screen.replace('  6. Chat about this','');},
 f=>{f.screen=f.screen.replace('  6. Chat about this','  6. Chat about this\n  7. Another option');},
 f=>{f.screen=f.screen.replace('Esc to cancel','Esc to');},f=>{f.screen+='Another current panel\n';},
 f=>{f.screen=f.screen.replace('│ Pros / cons:','│ ☐ Other gate\n│ Pros / cons:');},
 f=>{f.screen=f.screen.replace('  5. Type something.','  5. Type something.\nOther confirmation');},
 f=>{f.screen=f.screen.replace('  6. Chat about this','  6. Chat about this\nOther confirmation');},
 f=>{call(f).questions[0]!.header='Setup';rebind(f);},f=>{call(f).questions[0]!.question='Example: '+call(f).questions[0]!.question;rebind(f);},
 f=>{call(f).questions[0]!.question='"'+call(f).questions[0]!.question+'"';rebind(f);},
 ];for(const[i,change]of controls.entries()){const f=fixture();change(f);expect(detect(f),String(i)).toBeNull();}
});
test('unchanged production loop fails as blocked and sends no input while preserving missing phases',async()=>{
 const source=readFileSync(new URL('./skill-e2e-autoplan-chain.test.ts',import.meta.url),'utf8');
 const begin=source.indexOf('            // This new repository offers routing'),end=source.indexOf('\n          }\n        } finally',begin);
 expect(begin).toBeGreaterThan(0);expect(end).toBeGreaterThan(begin);
 const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
 const loop=new AsyncFunction('autoplanBlockingQuestionBoundary','autoplanSetupDecision','ctx',new Bun.Transpiler({loader:'ts'}).transformSync(`
 async function run(){const {commandStartedAt,viewportCapturedAt,transcript,publicTools}=ctx;
 const hits=[],methodologyAudit=['ceo','design','dx','eng'].map(phase=>({phase,passed:true})),pendingSetupQuestion=undefined;
 let outcome='timeout',evidence='',blockedQuestion=null,unsupportedSetup=null;
 const inputs=[],seenSetupQuestions=new Set(),session={send:(s)=>inputs.push(s)},Bun={sleep:async()=>{}};
 const selectPtyNumberedOption=async(_session,n)=>session.send(String(n)+'\\r'),isPlanReadyVisible=()=>false;
 for(const visible of [ctx.screen,ctx.screen]){const viewport=visible;${source.slice(begin,end)}}
 return {outcome,blockedQuestion,hits,inputs};}`)+'return run();');
 const f=fixture(),result=await loop(autoplanBlockingQuestionBoundary,autoplanSetupDecision,{...f.context,screen:f.screen});
 expect(result).toEqual({outcome:'blocked_on_question',blockedQuestion:expected,hits:[],inputs:[]});
 const errorStart=source.indexOf("        if (outcome === 'blocked_on_question')"),errorEnd=source.indexOf("        if (outcome === 'exited'",errorStart);
 const raise=new Function('outcome','hits','blockedQuestion','transcript','artifacts','evidence',new Bun.Transpiler({loader:'ts'}).transformSync(source.slice(errorStart,errorEnd)));
 expect(()=>raise(result.outcome,result.hits,result.blockedQuestion,f.context.transcript,{},f.screen)).toThrow('missing phase markers=[1,2,2.5,3]');
});
test('new fixture and test select only the Autoplan owner',()=>{
 for(const p of ['test/autoplan-cropped-gate-av.test.ts','test/fixtures/autoplan-cropped-gate-av.json']){
 expect(Object.entries(E2E_TOUCHFILES).filter(([,paths])=>paths.includes(p)).map(([name])=>name)).toEqual(['autoplan-chain-pty']);expect(GLOBAL_TOUCHFILES).not.toContain(p);
 }
});
