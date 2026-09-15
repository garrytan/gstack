import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { nextCeoPostureContinuation } from './helpers/ceo-mode-option';
import type { PlanCountTranscript } from './helpers/plan-count-transcript';

const selectedAt = Date.parse('2026-09-09T07:57:52Z');
const questions = ['Autosave', 'View tabs', 'Deep links', 'Team views'].map(header => ({
  header, question: `Add ${header.toLowerCase()} to the plan?`, options: [{label:'Add'}, {label:'Defer'}],
}));
function transcript(count = 4, native = false): PlanCountTranscript {
  return {status:'ready', assistantMessages:[], calls:[{
    sessionId:'mode-session', toolUseId:'mode', answered:true, failed:false,
    answeredAt:'2026-09-09T07:57:54Z', unansweredQuestionIndices:[],
    questions:[{header:'Review mode',question:'Which mode?',options:[{label:'HOLD SCOPE'},{label:'SCOPE EXPANSION'}]}],
    answers:{'Which mode?':'SCOPE EXPANSION'},
  }, ...(native ? [{sessionId:'mode-session',toolUseId:'downstream',answered:false,failed:false,questions:structuredClone(questions.slice(0,count))}] : [])]};
}
function screen(next: number, count = 4) {
  const bar = '← ' + questions.slice(0,count).map((q,i)=>(i<next?'☒ ':'☐ ')+q.header).join(' ')+' ✔ Submit →\n';
  return next === count ? bar+'Review your answers\nReady to submit your answers?\n❯1.Submit answers\n2.Cancel\n'
    : bar+questions[next]!.question+'\n❯1.Add\n2.Defer\nEnter to select · Tab/Arrow keys to navigate · Esc to cancel\n';
}
const step = (visible: string, t: PlanCountTranscript, seen: Set<string>, started: boolean) =>
  nextCeoPostureContinuation(visible,t,'SCOPE EXPANSION',selectedAt,seen,started);

describe('one CEO posture continuation means one complete native call',()=>{
  test('two and four tabs complete once with eager or delayed native metadata',()=>{
    for(const count of [2,4]) for(const native of [false,true]) {
      const t=transcript(count,native),seen=new Set<string>();
      for(let i=0;i<count;i++) {
        expect(step(screen(i,count),t,seen,i>0)).toBe('question');
        expect(step(screen(i,count),t,seen,true)).toBeNull();
      }
      expect(step(screen(count,count),t,seen,true)).toBe('submission');
      expect(step(screen(count,count),t,seen,true)).toBeNull();
      expect(step(screen(0,count),t,seen,true)).toBeNull();
      expect(step('☐ New issue\nFix another issue?\n❯1.Fix\n2.Keep',t,seen,true)).toBeNull();
    }
  });
  test('late native metadata binds the existing packet without replaying a tab',()=>{
    const seen=new Set<string>();
    expect(step(screen(0),transcript(),seen,false)).toBe('question');
    expect(step(screen(0),transcript(4,true),seen,true)).toBeNull();
    expect(step(screen(1),transcript(4,true),seen,true)).toBe('question');
    const foreign=transcript(4,true);foreign.calls[1]!.toolUseId='foreign';
    expect(step(screen(2),foreign,seen,true)).toBeNull();
    expect(step(screen(2),transcript(4,true),seen,true)).toBe('question');
  });
  test('changed bars, skipped answers, foreign calls and incomplete panels cannot extend the budget',()=>{
    const invalid = [screen(0),screen(2),screen(4),screen(1).replace('Deep links','Other work'),
      screen(1).replace('Tab/Arrow keys to navigate','navigate'),
      '☐ New issue\nFix another issue?\n❯1.Fix\n2.Keep'];
    for(const visible of invalid) {
      const seen=new Set<string>();expect(step(screen(0),transcript(),seen,false)).toBe('question');
      expect(step(visible,transcript(),seen,true)).toBeNull();
    }
    for(const mutate of [
      (t:PlanCountTranscript)=>{t.calls[1]!.sessionId='foreign';},
      (t:PlanCountTranscript)=>{t.calls[1]!.questions[1]!.question='Unrelated request?';},
      (t:PlanCountTranscript)=>{t.calls[0]!.failed=true;},
      (t:PlanCountTranscript)=>{t.calls[0]!.answers={'Which mode?':'HOLD SCOPE'};},
    ]) {
      const seen=new Set<string>();expect(step(screen(0),transcript(),seen,false)).toBe('question');
      const t=transcript(4,true);mutate(t);
      expect(step(screen(1),t,seen,true)).toBeNull();
    }
    expect(step(screen(1),transcript(),new Set(),false)).toBeNull();
    expect(step(screen(0),transcript(),new Set(),true)).toBeNull();
  });
  test('late metadata at Submit must match every tab and remain pending in the selected session',()=>{
    const mutations: Array<(t: PlanCountTranscript)=>void> = [
      t=>{t.calls[1]!.sessionId='foreign';},
      t=>{t.calls[1]!.questions[0]!.header='Foreign header';},
      t=>{t.calls[1]!.questions[0]!.question='Unrelated request?';},
      t=>{t.calls[1]!.answered=true;},
      t=>{t.calls[1]!.failed=true;},
    ];
    for(const mutate of mutations) {
      const seen=new Set<string>();
      for(let i=0;i<4;i++)expect(step(screen(i),transcript(),seen,i>0)).toBe('question');
      const t=transcript(4,true);mutate(t);
      expect(step(screen(4),t,seen,true)).toBeNull();
    }
    const seen=new Set<string>();
    for(let i=0;i<4;i++)expect(step(screen(i),transcript(),seen,i>0)).toBe('question');
    expect(step(screen(4),transcript(4,true),seen,true)).toBe('submission');
  });
  test('single-question continuation remains one question even if the caller flag is stale',()=>{
    const t=transcript(),seen=new Set<string>();
    const one='☐ Architecture\nGuard the lookup?\n❯1.Add guard\n2.Defer';
    expect(step(one,t,seen,false)).toBe('question');
    expect(step(one.replace('lookup','cache'),t,seen,false)).toBeNull();
    expect(step(screen(0),t,seen,false)).toBeNull();
  });
});

test.skipIf(process.platform==='win32')('real fake CLI flushes native posture only after all four tabs and Submit',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ceo-posture-packet-'));
  const fake=path.join(dir,'fake-claude'),worker=path.join(dir,'worker.ts'),events=path.join(dir,'events.jsonl'),result=path.join(dir,'result.json');
  fs.writeFileSync(fake,`#!${process.execPath}\n`+String.raw`
import fs from 'node:fs';import path from 'node:path';
const item=JSON.parse(process.env.POSTURE_PACKET);const sid='mode-session';
const file=path.join(process.env.CLAUDE_CONFIG_DIR,'projects','fixture',sid+'.jsonl');fs.mkdirSync(path.dirname(file),{recursive:true});
const native=(role,content,extra={})=>fs.appendFileSync(file,JSON.stringify({cwd:process.cwd(),sessionId:sid,isSidechain:false,timestamp:new Date().toISOString(),message:{role,content},...extra})+'\n');
const log=e=>fs.appendFileSync(item.events,JSON.stringify(e)+'\n');
log({type:'start',pid:process.pid});
native('assistant',[{type:'tool_use',id:'mode',name:'AskUserQuestion',input:{questions:[{header:'Mode',question:'Which mode?',options:[{label:'HOLD SCOPE'},{label:'SCOPE EXPANSION'}]}]}}]);
native('user',[{type:'tool_result',tool_use_id:'mode',content:'Answered'}],{toolUseResult:{answers:{'Which mode?':'SCOPE EXPANSION'}}});
let index=0,done=false;
const render=()=>process.stdout.write('\x1b[2J\x1b[H'+item.screens[index].replaceAll('\n','\r\n'));
process.stdin.setRawMode?.(true);process.stdin.on('data',data=>{
 const input=data.toString();log({type:'input',input,index});
 if(done)throw Error('input after completion');
 if(index<4){if(input!=='1')throw Error('native shortcut must not queue Enter');index++;render();return;}
 if(input!=='\r')throw Error('expected Submit');
 native('assistant',[{type:'text',text:'I will explore expansion opportunities that improve saved project views.'},{type:'tool_use',id:'downstream',name:'AskUserQuestion',input:{questions:item.questions}}]);
 native('user',[{type:'tool_result',tool_use_id:'downstream',content:'Answered'}],{toolUseResult:{answers:Object.fromEntries(item.questions.map(q=>[q.question,'Add']))}});
 done=true;process.stdout.write('\x1b[2J\x1b[HPOSTURE_FLUSHED\r\n');
});process.on('SIGINT',()=>process.exit(0));process.stdin.resume();render();
`);fs.chmodSync(fake,0o755);
  const module=(name:string)=>pathToFileURL(path.join(import.meta.dir,'helpers',name)).href;
  fs.writeFileSync(worker,`
import {launchClaudePty,capturePlanCountQuestion,planCountQuestionInput} from ${JSON.stringify(module('claude-pty-runner.ts'))};
import {readPlanCountTranscript} from ${JSON.stringify(module('plan-count-transcript.ts'))};
import {nextCeoPostureContinuation,hasNativePostAnswerCeoPosture} from ${JSON.stringify(module('ceo-mode-option.ts'))};
const start=Date.now(),seen=new Set();let started=false;
const session=await launchClaudePty({cwd:${JSON.stringify(dir)},timeoutMs:7000,observeScreen:true,env:{POSTURE_PACKET:${JSON.stringify(JSON.stringify({events,questions,screens:Array.from({length:5},(_,i)=>screen(i))}))}}});
try {
 await session.waitFor('Autosave',{timeoutMs:2000,pollMs:20});
 const read=()=>readPlanCountTranscript(session.hermeticConfigDir,${JSON.stringify(dir)});
 const before=hasNativePostAnswerCeoPosture(read(),'SCOPE EXPANSION',/expansion/,start);
 while(Date.now()-start<5000){
  const t=read();if(hasNativePostAnswerCeoPosture(t,'SCOPE EXPANSION',/expansion/,start))break;
  const visible=await session.currentScreen();
  const action=nextCeoPostureContinuation(visible,t,'SCOPE EXPANSION',start,seen,started,session.visibleText());
  if(action==='question'){started=true;const pending=t.calls.find(c=>!c.answered&&!c.failed);const fp=capturePlanCountQuestion(visible,new Set(),0,false,pending);session.send(planCountQuestionInput(visible,fp,1));}
  else if(action==='submission')session.send('\\r');
  await Bun.sleep(25);
 }
 const t=read();await Bun.write(${JSON.stringify(result)},JSON.stringify({before,after:hasNativePostAnswerCeoPosture(t,'SCOPE EXPANSION',/expansion/,start),calls:t.calls}));
} finally {await session.close();}
`);
  const child=Bun.spawn([process.execPath,worker],{env:{...process.env,BROWSE_TERMINAL_BINARY:fake,EVALS_HERMETIC:'1'},stdout:'pipe',stderr:'pipe'});
  const timer=setTimeout(()=>child.kill('SIGKILL'),10000);
  try{
    const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect(code,out+err).toBe(0);const r=JSON.parse(fs.readFileSync(result,'utf8'));
    expect(r.before).toBe(false);expect(r.after).toBe(true);
    expect(r.calls).toHaveLength(2);expect(r.calls[1].unansweredQuestionIndices).toEqual([]);
    const rows=fs.readFileSync(events,'utf8').trim().split('\n').map(s=>JSON.parse(s));
    expect(rows.filter(r=>r.type==='input').map(r=>r.input)).toEqual(['1','1','1','1','\r']);
    expect(()=>process.kill(rows[0].pid,0)).toThrow();
  } finally {
    clearTimeout(timer);child.kill('SIGKILL');await child.exited;
    if(fs.existsSync(events))try{
      const pid=JSON.parse(fs.readFileSync(events,'utf8').split('\n')[0]!).pid;
      const argv=process.platform==='linux'?fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\0'):Bun.spawnSync(['ps','-p',String(pid),'-o','command='], { timeout: 1_000 }).stdout.toString().trim().split(/\s+/);
      if(argv.includes(fake))process.kill(pid,'SIGKILL');
    }catch{}
    fs.rmSync(dir,{recursive:true,force:true});
  }
},12000);
