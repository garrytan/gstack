import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { nextCeoPostureContinuation, hasNativePostAnswerCeoPosture } from './helpers/ceo-mode-option';
import type { NativePlanQuestionCall, PlanCountTranscript } from './helpers/plan-count-transcript';
import { createPendingQuestionRecorder, recordPendingQuestion, pendingQuestionRecorderStatus } from './helpers/plan-count-pending-question';

const packet = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures/autoplan-setup-packet-o-call.json'), 'utf8')) as NativePlanQuestionCall;
const captured = fs.readFileSync(path.join(import.meta.dir, 'fixtures/autoplan-setup-packet-o-screen.txt'), 'utf8');

test('bounded content-free status distinguishes incomplete publication from permanently invalid capture', () => {
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'gstack-pending-status-')), config=path.join(cwd,'.claude');
  const native=path.join(config,'projects','fixture',packet.sessionId+'.jsonl');
  fs.mkdirSync(path.dirname(native),{recursive:true});fs.writeFileSync(native,'');
  const event={hook_event_name:'PreToolUse',tool_name:'AskUserQuestion',session_id:packet.sessionId,
    tool_use_id:packet.toolUseId,cwd,transcript_path:native,tool_input:{questions:packet.questions}};
  const recorder=createPendingQuestionRecorder(cwd,config);
  try {
    expect(pendingQuestionRecorderStatus(undefined,cwd,config)).toEqual({status:'disabled'});
    expect(pendingQuestionRecorderStatus(path.join(cwd,'missing'),cwd,config)).toEqual({status:'missing'});
    expect(pendingQuestionRecorderStatus(recorder.file,cwd,config)).toEqual({status:'idle'});
    fs.writeFileSync(recorder.file+'.lock','');
    expect(pendingQuestionRecorderStatus(recorder.file,cwd,config)).toEqual({status:'busy'});
    fs.unlinkSync(recorder.file+'.lock');
    recordPendingQuestion(JSON.stringify(event),recorder.file,cwd,config);
    expect(pendingQuestionRecorderStatus(recorder.file,cwd,config)).toEqual({status:'pending'});
    recordPendingQuestion(JSON.stringify({...event,tool_use_id:'another-pending'}),recorder.file,cwd,config);
    const retained=pendingQuestionRecorderStatus(recorder.file,cwd,config);
    expect(retained).toEqual({status:'invalid',reason:'concurrent_pending'});
    expect(JSON.stringify(retained)).not.toContain(cwd);
    expect(JSON.stringify(retained)).not.toContain(packet.questions[0]!.question);
    recorder.dispose();
    expect(retained).toEqual({status:'invalid',reason:'concurrent_pending'});
    for (const [input,reason] of [['{','invalid_event'],['x'.repeat(128*1024+1),'input_overflow']]) {
      const bad=createPendingQuestionRecorder(cwd,config);
      try { recordPendingQuestion(input!,bad.file,cwd,config);
        expect(pendingQuestionRecorderStatus(bad.file,cwd,config)).toEqual({status:'invalid',reason});
        recordPendingQuestion(JSON.stringify(event),bad.file,cwd,config);
        expect(pendingQuestionRecorderStatus(bad.file,cwd,config)).toEqual({status:'invalid',reason});
      } finally { bad.dispose(); }
    }
  } finally {recorder.dispose();fs.rmSync(cwd,{recursive:true,force:true});}
});

test('pending mode continuation does not stand in for a successful mode answer or posture', () => {
  const question = {header:'Review mode', question:'Which review mode?', options:[
    {label:'SCOPE EXPANSION'}, {label:'SELECTIVE EXPANSION'}, {label:'HOLD SCOPE'}, {label:'SCOPE REDUCTION'}]};
  const selected: NativePlanQuestionCall = {sessionId:'owned', toolUseId:'mode', questions:[question], answered:true,
    failed:false, answers:{[question.question]:'HOLD SCOPE'}, unansweredQuestionIndices:[], answeredAt:new Date(1000).toISOString()};
  const pending = {sessionId:'owned', toolUseId:'followup', answered:false, failed:false, source:'pre_tool_use' as const,
    questions:[{header:'Current behavior', question:'Which contract should remain?', options:[{label:'Keep scope'}, {label:'Expand scope'}]}]};
  const screen = '☐ Current behavior\nWhich contract should remain?\n❯ 1. Keep scope\n  2. Expand scope\nEnter to select · ↑/↓ to navigate · Esc to cancel';
  const transcript: PlanCountTranscript = {status:'ready', calls:[selected], assistantMessages:[]};
  expect(nextCeoPostureContinuation(screen, {...transcript, calls:[]}, 'HOLD SCOPE', 999, new Set(), false, screen, pending)).toBeNull();
  expect(nextCeoPostureContinuation(screen, {...transcript, calls:[{...selected, answered:false}]}, 'HOLD SCOPE', 999, new Set(), false, screen, pending)).toBeNull();
  expect(hasNativePostAnswerCeoPosture(transcript, 'HOLD SCOPE', /rigor/, 999)).toBe(false);
  expect(nextCeoPostureContinuation(screen, transcript, 'HOLD SCOPE', 999, new Set(), false, screen, pending)).toBe('question');
  expect(nextCeoPostureContinuation(screen, transcript, 'HOLD SCOPE', 999, new Set(), false, screen,
    {...pending, sessionId:'foreign'})).toBeNull();
  expect(transcript.calls).toEqual([selected]);
  expect(hasNativePostAnswerCeoPosture(transcript, 'HOLD SCOPE', /rigor/, 999)).toBe(false);

  const batch = {...pending, questions:[pending.questions[0]!,
    {header:'Validation', question:'Which check should remain?', options:[{label:'Keep tests'}, {label:'Expand tests'}]}]};
  const pane = (index: number) => {
    const bar = '← ' + batch.questions.map((q,i)=>(i<index?'☒ ':'☐ ')+q.header).join('  ') + ' ✔ Submit →';
    const body = index < 2 ? batch.questions[index]!.question + '\n' + batch.questions[index]!.options.map((o,i)=>(i===0?'❯':' ')+' '+(i+1)+'. '+o.label).join('\n')
      : 'Review your answers\nReady to submit your answers?\n❯ 1. Submit answers\n  2. Cancel';
    return bar+'\n'+body+'\nEnter to select · Tab/Arrow keys to navigate · Esc to cancel';
  };
  const seen = new Set<string>();
  expect(nextCeoPostureContinuation(pane(0), transcript, 'HOLD SCOPE', 999, seen, false, pane(0), batch)).toBe('question');
  expect(nextCeoPostureContinuation(pane(1), transcript, 'HOLD SCOPE', 999, seen, true, pane(1))).toBeNull();
  expect(nextCeoPostureContinuation(pane(1), transcript, 'HOLD SCOPE', 999, seen, true, pane(1), structuredClone(batch))).toBe('question');
  expect(nextCeoPostureContinuation(pane(2), transcript, 'HOLD SCOPE', 999, seen, true, pane(2), structuredClone(batch))).toBe('submission');
  expect(nextCeoPostureContinuation(pane(2), transcript, 'HOLD SCOPE', 999, seen, true, pane(2), batch)).toBeNull();
  expect(transcript.calls).toEqual([selected]);
});

function identity(pid: number): string | null {
  try { return execFileSync('ps', ['-p',String(pid),'-o','lstart=','-o','command='], {encoding:'utf8',timeout:5000}).trim(); }
  catch { return null; }
}

test.skipIf(process.platform === 'win32')('opt-in hook supplies full pending packet before publication; only actual JSONL results add answered coverage', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-pending-question-pty-'));
  const fake = path.join(dir, 'fake-claude'), worker = path.join(dir, 'worker.ts'), result = path.join(dir, 'results.json');
  const workerTemp = path.join(dir, 'tmp'); fs.mkdirSync(workerTemp);
  const helper = (name: string) => pathToFileURL(path.join(import.meta.dir, 'helpers', name)).href;
  fs.writeFileSync(fake, `#!${process.execPath}\n` + String.raw`
import * as fs from 'node:fs'; import * as path from 'node:path'; import {execFileSync} from 'node:child_process';
const item=JSON.parse(process.env.QUESTION_REPLAY), cwd=process.cwd(), call=item.call;
const record=value=>fs.appendFileSync(path.join(cwd,'events.jsonl'),JSON.stringify(value)+'\n');
record({kind:'pid',pid:process.pid,identity:execFileSync('ps',['-p',String(process.pid),'-o','lstart=','-o','command='],{encoding:'utf8',timeout:5000}).trim()});
const config=process.env.CLAUDE_CONFIG_DIR, native=path.join(config,'projects',path.basename(cwd),call.sessionId+'.jsonl');
fs.mkdirSync(path.dirname(native),{recursive:true});
const persist=(role,content,extra={})=>fs.appendFileSync(native,JSON.stringify({cwd,sessionId:call.sessionId,isSidechain:false,timestamp:new Date().toISOString(),message:{role,content},...extra})+'\n');
persist('assistant',[{type:'text',text:'I am preparing the repository setup questions.'}]);
const at=process.argv.indexOf('--settings'); const settings=at<0?null:JSON.parse(process.argv[at+1]);
record({kind:'settings',settings});
async function hook(event) {
  const entries=settings?.hooks[event]?.filter(e=>e.matcher==='^AskUserQuestion$')??[];
  if(!entries.length)return;
  if(entries.length!==1||entries[0].hooks.length!==1||entries[0].hooks[0].timeout!==5)throw Error('wrong AUQ hook scope');
  const payload={hook_event_name:event,tool_name:'AskUserQuestion',session_id:call.sessionId,tool_use_id:call.toolUseId,cwd,transcript_path:native,tool_input:{questions:call.questions}};
  const p=Bun.spawn(['bash','-c',entries[0].hooks[0].command],{stdin:new Blob([JSON.stringify(payload)]),stdout:'pipe',stderr:'pipe'});
  const [code,out,err]=await Promise.all([p.exited,new Response(p.stdout).text(),new Response(p.stderr).text()]);
  record({kind:'hook',event,code,out,err}); if(code||out||err)throw Error('observer changed tool response');
}
await hook('PreToolUse');
if(item.crash)process.exit(19);
let index=0,done=false;const answers={};
function render(){const q=call.questions;let screen=item.first;
if(index){const bar='← '+q.map(question=>(answers[question.question]?'☒ ':'☐ ')+question.header).join('  ')+' ✔ Submit →';
screen=index<q.length?bar+'\n│ '+q[index].question+'\n'+q[index].options.map((o,i)=>(i===0?'❯':' ')+' '+(i+1)+'. '+o.label).join('\n')+'\n  3. Type something.\n  4. Chat about this':bar+'\nReview your answers\nReady to submit your answers?\n❯ 1. Submit answers\n  2. Cancel';
screen+='\nEnter to select · Tab/Arrow keys to navigate · Esc to cancel\n';}
process.stdout.write('\x1b[2J\x1b[H'+screen.replace(/\n/g,'\r\n'));}
process.stdin.setRawMode?.(true);process.stdin.resume();
process.stdin.on('data',async data=>{const input=data.toString();record({kind:'input',input,index});
if(!settings||done)throw Error('unexpected input');
if(index<call.questions.length){if(input!=='1')throw Error('wrong native digit');answers[call.questions[index].question]=call.questions[index].options[0].label;index++;render();return;}
if(input!=='\r')throw Error('Submit must be one Enter');done=true;
await hook('PostToolUse');await hook('PreToolUse');
persist('assistant',[{type:'tool_use',id:call.toolUseId,name:'AskUserQuestion',input:{questions:call.questions}}]);
persist('user',[{type:'tool_result',tool_use_id:call.toolUseId,content:'Answered.'}],{toolUseResult:{answers}});
process.stdout.write('\x1b[2J\x1b[HNATIVE_PACKET_COMPLETE\r\n');});
render();process.on('SIGINT',()=>process.exit(0));
`, {mode:0o755});
  fs.writeFileSync(worker, `
import * as fs from 'node:fs'; import * as path from 'node:path'; import * as os from 'node:os';
import {launchClaudePty,resolveClaudeBinary} from ${JSON.stringify(helper('claude-pty-runner.ts'))};
import {readPlanCountTranscript} from ${JSON.stringify(helper('plan-count-transcript.ts'))};
import {readPendingQuestion} from ${JSON.stringify(helper('plan-count-pending-question.ts'))};
import {autoplanSetupDecision} from ${JSON.stringify(helper('autoplan-setup-question.ts'))};
if(resolveClaudeBinary()!==${JSON.stringify(fake)})throw Error('fake CLI binding failed');
const root=${JSON.stringify(dir)},results=[];
for(const enabled of [false,true]){
const cwd=path.join(root,String(enabled));fs.mkdirSync(cwd);const startedAt=Date.now();
const session=await launchClaudePty({cwd,observeScreen:true,observeSetupQuestions:enabled,observePlanReady:enabled,
  observeFilePermissions:enabled?[path.join(os.tmpdir(),'report.md')]:undefined,timeoutMs:10000,
  env:{QUESTION_REPLAY:JSON.stringify({call:${JSON.stringify(packet)},first:${JSON.stringify(captured)}})}});
const owned=session.pendingQuestionFile;
try{await session.waitFor('Enter to select',{timeoutMs:5000,pollMs:20});
const transcript=()=>readPlanCountTranscript(session.hermeticConfigDir,cwd);
const pending=()=>readPendingQuestion(owned,cwd,session.hermeticConfigDir,startedAt,transcript());
if(transcript().calls.length)throw Error('unpublished packet manufactured JSONL coverage');
const seen=new Set(),inputs=[],first=await session.currentScreen();
if(autoplanSetupDecision(first,new Set()).kind!=='waiting')throw Error('partial panel unexpectedly authorized input');
if(enabled){
if(pending()?.source!=='pre_tool_use'||pending()?.answered)throw Error('pending source was lost or counted as answer');
for(let step=0;step<3;step++){
 const current=await session.currentScreen(),call=pending();
 if(!call||transcript().calls.length)throw Error('pending identity lost or premature coverage');
 const action=autoplanSetupDecision(current,seen,call);
 if(action.kind!=='input')throw Error('full native packet not navigable: '+JSON.stringify({action,current,call}));
 for(const key of action.signatures)seen.add(key);
 if(autoplanSetupDecision(current,seen,call).kind!=='waiting')throw Error('redraw repeated input');
 inputs.push(action.input);session.send(action.input);
 await session.waitFor(step===0?'☒ '+call.questions[0].header:step===1?'Ready to submit your answers?':'NATIVE_PACKET_COMPLETE',{timeoutMs:3000,pollMs:20});
}
if(pending())throw Error('completed replay reopened pending identity');
if(transcript().calls.length!==1||!transcript().calls[0].answered)throw Error('actual successful native result absent');
}else if(owned||pending())throw Error('recorder enabled by default');
results.push({enabled,inputs,native:transcript()});
}finally{await session.close();}
if(owned&&fs.existsSync(path.dirname(owned)))throw Error('normal close leaked recorder');
}
const cwd=path.join(root,'crash');fs.mkdirSync(cwd);
const crashed=await launchClaudePty({cwd,observeSetupQuestions:true,timeoutMs:5000,
env:{QUESTION_REPLAY:JSON.stringify({call:${JSON.stringify(packet)},first:${JSON.stringify(captured)},crash:true})}});
const owned=crashed.pendingQuestionFile;
while(!crashed.exited())await Bun.sleep(20);
if(crashed.exitCode()!==19||!fs.existsSync(owned))throw Error('crash did not execute recorder');
await crashed.close();if(fs.existsSync(path.dirname(owned)))throw Error('crashed close leaked recorder');
const spawn=Bun.spawn;Bun.spawn=()=>{throw Error('simulated spawn failure');};let rejected=false;
try{await launchClaudePty({cwd,observeSetupQuestions:true});}catch(e){rejected=String(e).includes('simulated spawn failure');}finally{Bun.spawn=spawn;}
if(!rejected||fs.readdirSync(os.tmpdir()).some(n=>n.startsWith('gstack-pending-question-')))throw Error('spawn failure leaked recorder');
fs.writeFileSync(${JSON.stringify(result)},JSON.stringify(results));
`);
  const child = Bun.spawn([process.execPath, worker], {env:{...process.env,TMPDIR:workerTemp,
    BROWSE_TERMINAL_BINARY:fake,EVALS_HERMETIC:'1'},stdout:'pipe',stderr:'pipe'});
  const timer = setTimeout(() => child.kill('SIGKILL'), 22000);
  try {
    const [code,out,err] = await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect(code,out+err).toBe(0);
    const results=JSON.parse(fs.readFileSync(result,'utf8'));
    expect(results.map((r:any)=>({enabled:r.enabled,inputs:r.inputs,calls:r.native.calls.length}))).toEqual([
      {enabled:false,inputs:[],calls:0},{enabled:true,inputs:['1','1','\r'],calls:1}]);
    for(const enabled of [false,true]) {
      const events=fs.readFileSync(path.join(dir,String(enabled),'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
      const settings=events.find(e=>e.kind==='settings').settings;
      expect(settings?.hooks.PreToolUse.map((h:any)=>h.matcher)??[]).toEqual(enabled?['^ExitPlanMode$','^(Write|Edit)$','^AskUserQuestion$']:[]);
      expect(events.filter(e=>e.kind==='hook').every(e=>e.code===0&&e.out===''&&e.err==='')).toBe(true);
      expect(events.filter(e=>e.kind==='input').map(e=>e.input)).toEqual(enabled?['1','1','\r']:[]);
      expect(identity(events[0].pid)).toBeNull();
    }
  } finally {
    clearTimeout(timer);child.kill('SIGKILL');
    for(const name of ['false','true','crash']) {
      const file=path.join(dir,name,'events.jsonl');if(!fs.existsSync(file))continue;
      const first=JSON.parse(fs.readFileSync(file,'utf8').split('\n')[0]!);
      if(first.kind==='pid'&&first.identity?.includes(fake)&&identity(first.pid)===first.identity) {
        try{process.kill(first.pid,'SIGKILL');}catch{/* already exited */}
      }
    }
    fs.rmSync(dir,{recursive:true,force:true});
  }
},25000);
