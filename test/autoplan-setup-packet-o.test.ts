import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { autoplanSetupDecision } from './helpers/autoplan-setup-question';
import { E2E_TOUCHFILES } from './helpers/touchfiles';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';

const captured = fs.readFileSync(path.join(import.meta.dir, 'fixtures/autoplan-setup-packet-o-screen.txt'), 'utf8');
const original = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures/autoplan-setup-packet-o-call.json'), 'utf8')) as NativePlanQuestionCall;
const footer = 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel';
function pane(call: NativePlanQuestionCall, index: number, answered: number[] = []) {
  const bar = '← ' + call.questions.map((q,i) => (answered.includes(i) ? '☒ ' : '☐ ') + q.header).join('  ') + ' ✔ Submit →';
  if (index === call.questions.length) return `${bar}\nReview your answers\nReady to submit your answers?\n❯ 1. Submit answers\n  2. Cancel\n${footer}\n`;
  const q = call.questions[index]!;
  return `${bar}\n│ ${q.question}\n` + q.options.map((option,i) => `${i===0?'❯':' '} ${i+1}. ${option.label}`).join('\n') +
    `\n  3. Type something.\n  4. Chat about this\n${footer}\n`;
}
function commit(screen: string, seen: Set<string>, call: NativePlanQuestionCall, expected: string) {
  const before = [...seen]; const action = autoplanSetupDecision(screen, seen, call);
  expect([...seen]).toEqual(before); expect(action).toMatchObject({kind:'input',input:expected});
  if (action.kind !== 'input') throw Error('Expected input');
  for (const key of action.signatures) seen.add(key);
  expect(autoplanSetupDecision(screen,seen,call).kind).toBe('waiting');
  return action;
}

describe('native routing and prerequisite setup packet', () => {
  test('exact O active pane then prerequisite each receive one bound choice, followed by one Submit', () => {
    const seen=new Set<string>();
    commit(captured,seen,original,'1');
    expect(autoplanSetupDecision(pane(original,2,[0,1]),seen,original).kind).toBe('waiting');
    commit(pane(original,1,[0]),seen,original,'1');
    commit(pane(original,2,[0,1]),seen,original,'\r');
    expect(autoplanSetupDecision(captured,new Set(),{...original,answered:true}).kind).toBe('waiting');
  });

  test('question and option order may change without changing the existing choices', () => {
    for (const reverseQuestions of [false,true]) for (const reverseOptions of [false,true]) {
      const call=structuredClone(original);if(reverseQuestions)call.questions.reverse();
      if(reverseOptions)for(const question of call.questions)question.options.reverse();
      const seen=new Set<string>();
      for(let index=0;index<2;index++)commit(pane(call,index,index?[0]:[]),seen,call,reverseOptions?'2':'1');
      commit(pane(call,2,[0,1]),seen,call,'\r');
    }
  });

  test('metadata may persist late, but no tab is answered before the complete packet is known', () => {
    const seen=new Set<string>();
    expect(autoplanSetupDecision(captured,seen).kind).toBe('waiting');expect(seen.size).toBe(0);
    expect(autoplanSetupDecision(pane(original,0).split('\n').slice(1).join('\n'),seen).kind).toBe('waiting');
    expect(autoplanSetupDecision(captured,seen,{...original,questions:[original.questions[0]!]}).kind).toBe('waiting');
    commit(captured,seen,original,'1');
    expect(autoplanSetupDecision(pane(original,2,[0,1]),new Set(),original).kind).toBe('waiting');
  });

  test('every native question must be one unambiguous setup offer', () => {
    for (const mutate of [
      (call:any)=>{call.failed=true;},(call:any)=>{call.answered=true;},(call:any)=>{call.questions[1].multiSelect=true;},
      (call:any)=>{call.questions.push(structuredClone(call.questions[0]));},
      (call:any)=>{call.questions[1]=structuredClone(call.questions[0]);},
      (call:any)=>{call.questions[1].question='Which user experience should the API provide?';},
      (call:any)=>{call.questions[1].question='No design doc exists for /office-hours integration. Should we build X or defer Y?';},
      (call:any)=>{call.questions[0].question+=' Should we delete the archived invoices?';},
      (call:any)=>{call.questions[0].question+=' Also approve deleting the archived invoices before continuing.';},
      (call:any)=>{call.questions[1].question='Should we delete the archived invoices? '+call.questions[1].question;},
      (call:any)=>{call.questions[1].question=call.questions[1].question.replace('— sharper input','and also approve deleting the archived invoices — sharper input');},
      (call:any)=>{call.questions[1].question='No design doc found for this branch. /office-hours produces a design doc — also archive the invoices. Run it first or proceed with standard review?';},
      (call:any)=>{call.questions[1].options[1].label='Run /office-hours first then implement';},
      (call:any)=>{call.questions[1].options[0].label='Skip — implement the feature';},
      (call:any)=>{call.questions[0].question='The plan quotes gstack skill routing rules in CLAUDE.md. Should we build an API router?';},
      (call:any)=>{call.questions[0].options[1].label='No thanks, delete CLAUDE.md';},
      (call:any)=>{call.questions[0].options.push({label:'Implement the feature'});},
    ]) {const call=structuredClone(original);mutate(call);const seen=new Set<string>();
      expect(autoplanSetupDecision(pane(call,0),seen,call).kind).toBe('waiting');expect(seen.size).toBe(0);}
  });

  test('current tab, full offered labels and active panel context must all agree', () => {
    const first=pane(original,0);
    for (const changed of [
      'Example panel:\n'+first, 'Example:\n'+first, 'Quoted source:\n'+first, '```text\n'+first, '~~~~text\n'+first,
      first.split('\n').map(line=>'    '+line).join('\n'), first.split('\n').map(line=>'> '+line).join('\n'),
      first+'\n● Continuing the review.', first+first, first.replace('Esc to cancel','Esc to'),
      first.replace('Prerequisite doc','Other tab'), first.replace(original.questions[0]!.question,'Unrelated question'),
      first.replace('← ', '← Different call '),
      first.replace('1. Add','1. Delete'), first.replace('1. Add','1. [ ] Add'),
      first.replace('  3. Type something.',''), first.replace('  4. Chat about this',''),
      first.replace('❯ 1.','  1.'),first.replace('  2.','❯ 2.'),
      first.replace('  3. Type something.','  3. Implement the feature\n  4. Type something.').replace('  4. Chat about this','  5. Chat about this'),
    ]) expect(autoplanSetupDecision(changed,new Set(),original).kind,changed).toBe('waiting');
    expect(autoplanSetupDecision('```text\nearlier code\n```\n'+first,new Set(),original)).toMatchObject({kind:'input',input:'1'});
    expect(autoplanSetupDecision(pane(original,0,[0]),new Set(),original).kind).toBe('waiting');
  });

  test('Submit requires each actual sent identity, checked tabs, unchanged packet and a current Submit panel', () => {
    const seen=new Set<string>();commit(pane(original,0),seen,original,'1');commit(pane(original,1,[0]),seen,original,'1');
    const submit=pane(original,2,[0,1]);
    for (const changed of [
      pane(original,2,[0]), 'Example panel:\n'+submit,'Example:\n'+submit,'```text\n'+submit,submit+'\n● Finished.',
      submit.replace('Submit answers','Accept implementation'),submit.replace('Ready to submit your answers?','Implement the feature?'),
      submit.replace('  2. Cancel','  2. Cancel\n  3. Deploy'),submit.replace('Esc to cancel','Esc to'),
    ]) expect(autoplanSetupDecision(changed,seen,original).kind,changed).toBe('waiting');
    for (const change of ['session','tool','question','description']) {
      const call=structuredClone(original);
      if(change==='session')call.sessionId+='-other';if(change==='tool')call.toolUseId+='-other';
      if(change==='question')call.questions[0]!.question+=' ';
      if(change==='description')call.questions[0]!.options[0]!.description='Changed';
      expect(autoplanSetupDecision(submit,seen,call).kind).toBe('waiting');
    }
    commit(submit,seen,original,'\r');
  });

  test('packet captures and regression remain paid-selection dependencies', () => {
    for(const file of ['test/autoplan-setup-packet-o.test.ts','test/fixtures/autoplan-setup-packet-o-screen.txt','test/fixtures/autoplan-setup-packet-o-call.json'])
      expect(E2E_TOUCHFILES['autoplan-chain-pty']).toContain(file);
  });
});

test.skipIf(process.platform==='win32')('real PTY native setup packet waits for metadata, answers each visible tab once and submits without a stray digit',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gstack-setup-packet-o-'));const fake=path.join(dir,'fake-claude');
  const worker=path.join(dir,'worker.ts');const resultFile=path.join(dir,'results.json');
  const cases=[false,true].map(late=>({name:late?'late':'early',late,cwd:path.join(dir,late?'late':'early'),
    events:path.join(dir,late?'late.jsonl':'early.jsonl'),release:path.join(dir,late?'late.release':'early.release'),call:original,first:captured}));
  for(const item of cases)fs.mkdirSync(item.cwd);
  fs.writeFileSync(fake,`#!${process.execPath}\n`+String.raw`
import * as fs from 'node:fs';import * as path from 'node:path';
const item=JSON.parse(process.env.PACKET_CASE);const event=value=>fs.appendFileSync(item.events,JSON.stringify(value)+'\n');
const folder=path.join(process.env.CLAUDE_CONFIG_DIR,'projects','fixture');fs.mkdirSync(folder,{recursive:true});
const file=path.join(folder,item.call.sessionId+'.jsonl');let index=0,answers={},published=false,done=false;
const persist=value=>fs.appendFileSync(file,JSON.stringify({sessionId:item.call.sessionId,isSidechain:false,cwd:process.cwd(),timestamp:new Date().toISOString(),...value})+'\n');
const publish=()=>{if(published)return;published=true;persist({type:'assistant',message:{role:'assistant',content:[{type:'tool_use',id:item.call.toolUseId,name:'AskUserQuestion',input:{questions:item.call.questions}}]}});event({kind:'metadata'});process.stdout.write('\r\nMETADATA_READY\r\n');render();};
function render(){const q=item.call.questions;let screen=item.first;
if(index>0){const bar='← '+q.map(question=>(answers[question.question]?'☒ ':'☐ ')+question.header).join('  ')+' ✔ Submit →';
screen=index<q.length?bar+'\n│ '+q[index].question+'\n'+q[index].options.map((o,i)=>(i===0?'❯':' ')+' '+(i+1)+'. '+o.label).join('\n')+'\n  3. Type something.\n  4. Chat about this':bar+'\nReview your answers\nReady to submit your answers?\n❯ 1. Submit answers\n  2. Cancel';
screen+='\nEnter to select · Tab/Arrow keys to navigate · Esc to cancel\n';}
process.stdout.write('\x1b[2J\x1b[H'+screen.replace(/\n/g,'\r\n'));}
event({kind:'startup',pid:process.pid});process.stdin.setRawMode?.(true);process.stdin.resume();
process.stdin.on('data',data=>{const input=data.toString();event({kind:'input',input,index,published});if(!published||done)throw Error('Unexpected input lifecycle');
if(index<2){if(!/^[12]$/.test(input))throw Error('One native digit required');answers[item.call.questions[index].question]=item.call.questions[index].options[Number(input)-1].label;index++;render();}
else{if(input!=='\r')throw Error('Raw Submit required');done=true;persist({type:'user',toolUseResult:{answers},message:{role:'user',content:[{type:'tool_result',tool_use_id:item.call.toolUseId,content:'Answered.'}]}});event({kind:'submitted',answers});process.stdout.write('\x1b[2J\x1b[HNATIVE_PACKET_COMPLETE\r\n');}});
render();if(!item.late)publish();const timer=setInterval(()=>{if(item.late&&fs.existsSync(item.release))publish();},10);
process.on('SIGINT',()=>{clearInterval(timer);process.exit(0);});
`);fs.chmodSync(fake,0o755);
  const url=(name:string)=>pathToFileURL(path.resolve(import.meta.dir,'helpers',name)).href;
  fs.writeFileSync(worker,`
import * as fs from 'node:fs';
import {launchClaudePty,resolveClaudeBinary} from ${JSON.stringify(url('claude-pty-runner.ts'))};
import {autoplanSetupDecision} from ${JSON.stringify(url('autoplan-setup-question.ts'))};
import {readPlanCountTranscript} from ${JSON.stringify(url('plan-count-transcript.ts'))};
if(resolveClaudeBinary()!==${JSON.stringify(fake)})throw Error('Fake binary binding failed before launch');
const results=[];
for(const item of ${JSON.stringify(cases)}){
const session=await launchClaudePty({cwd:item.cwd,observeScreen:true,timeoutMs:15000,env:{PACKET_CASE:JSON.stringify(item)}});
try{
await session.waitFor('Enter to select',{timeoutMs:10000,pollMs:20});const seen=new Set();
if(item.late){const pending=readPlanCountTranscript(session.hermeticConfigDir,item.cwd).calls[0];if(pending)throw Error('Expected missing native packet');
if(autoplanSetupDecision(await session.currentScreen(),seen,pending).kind!=='waiting'||seen.size)throw Error('Guessed before native identity');
fs.writeFileSync(item.release,'release');}
await session.waitFor('METADATA_READY',{timeoutMs:3000,pollMs:20});
const inputs=[];
for(let step=0;step<3;step++){
 const current=await session.currentScreen();const call=readPlanCountTranscript(session.hermeticConfigDir,item.cwd).calls[0];
 const action=autoplanSetupDecision(current,seen,call);
 if(action.kind!=='input')throw Error('Expected input at '+step+': '+JSON.stringify({action,current,call}));
 session.send(action.input);inputs.push(action.input);for(const signature of action.signatures)seen.add(signature);
 if(autoplanSetupDecision(current,seen,call).kind!=='waiting')throw Error('Repeated input on unchanged pane');
 await session.waitFor(step===0?'☒ Routing setup':step===1?'Ready to submit your answers?':'NATIVE_PACKET_COMPLETE',{timeoutMs:3000,pollMs:20});
}
const transcript=readPlanCountTranscript(session.hermeticConfigDir,item.cwd);results.push({name:item.name,inputs,transcript});
}finally{await session.close();}}
fs.writeFileSync(${JSON.stringify(resultFile)},JSON.stringify(results));
`);
  const child=Bun.spawn([process.execPath,worker],{env:{...process.env,BROWSE_TERMINAL_BINARY:fake},stdout:'pipe',stderr:'pipe'});
  const killer=setTimeout(()=>child.kill('SIGKILL'),26000);
  try{
    const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);expect(exit,stdout+stderr).toBe(0);
    const results=JSON.parse(fs.readFileSync(resultFile,'utf8'));expect(results.length).toBe(2);
    for(const [index,result]of results.entries()){
      expect(result.inputs).toEqual(['1','1','\r']);expect(result.transcript.calls.length).toBe(1);expect(result.transcript.calls[0].answered).toBe(true);
      expect(result.transcript.calls[0].answers).toEqual(Object.fromEntries(original.questions.map(q=>[q.question,q.options[0]!.label])));
      const events=fs.readFileSync(cases[index]!.events,'utf8').trim().split('\n').map(line=>JSON.parse(line));
      expect(events.filter(e=>e.kind==='input').map(e=>({input:e.input,index:e.index,published:e.published}))).toEqual([
        {input:'1',index:0,published:true},{input:'1',index:1,published:true},{input:'\r',index:2,published:true}]);
      expect(events.filter(e=>e.kind==='submitted').length).toBe(1);expect(()=>process.kill(events[0].pid,0)).toThrow();
    }
  }finally{
    clearTimeout(killer);child.kill('SIGKILL');for(const item of cases)if(fs.existsSync(item.events)){
      const pid=JSON.parse(fs.readFileSync(item.events,'utf8').split('\n')[0]!).pid;
      if(process.platform==='linux')try{if(fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\0').includes(fake))process.kill(pid,'SIGKILL');}catch{}
    }fs.rmSync(dir,{recursive:true,force:true});
  }
},30000);
