import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { autoplanSetupDecision } from './helpers/autoplan-setup-question';
import { E2E_TOUCHFILES } from './helpers/touchfiles';

const frame = fs.readFileSync(path.join(import.meta.dir, 'fixtures/autoplan-routing-o-screen.txt'), 'utf8');
const question = {
  header: 'Routing rules',
  question: "gstack works best when your project's CLAUDE.md includes skill routing rules. Add them now?",
  options: [{ label: 'Add routing rules (Recommended)' }, { label: 'Skip for now' }],
};
const native = () => ({ sessionId: 'o-routing', toolUseId: 'routing', answered: false, failed: false, questions: [structuredClone(question)] });

describe('complete routing panel with a temporary decline', () => {
  test('the exact O panel chooses Add once before native persistence and after matching persistence', () => {
    expect(frame).toContain('Invoke skills manually going forward.');
    for (const pending of [undefined, native()]) {
      const seen = new Set<string>();
      const decision = autoplanSetupDecision(frame, seen, pending);
      expect(decision).toMatchObject({ kind: 'input', input: '1' });
      expect(seen.size).toBe(0);
      if (decision.kind !== 'input') throw Error('Expected input');
      for (const signature of decision.signatures) seen.add(signature);
      expect(autoplanSetupDecision(frame, seen, pending).kind).toBe('waiting');
      expect(autoplanSetupDecision(frame, seen, native()).kind).toBe('waiting');
    }
  });

  test('the unambiguous opposed decline does not depend on its description or choice order', () => {
    const withoutDescription = frame.replace(/^\s+Invoke skills manually going forward\..*$/m, '');
    for (const label of ['Skip for now', 'Skip for now (Recommended)', 'SKIP FOR NOW']) {
      const current = withoutDescription.replace('2. Skip for now', '2. ' + label);
      expect(autoplanSetupDecision(current, new Set())).toMatchObject({ kind: 'input', input: '1' });
      const reversed = current.replace('1. Add routing rules (Recommended)', '1. ' + label)
        .replace('2. ' + label, '2. Add routing rules (Recommended)');
      expect(autoplanSetupDecision(reversed, new Set())).toMatchObject({ kind: 'input', input: '2' });
    }
    for (const label of ['Skip', 'No thanks', 'Skip — invoke skills manually', 'Manual only']) {
      expect(autoplanSetupDecision(frame.replace('Skip for now', label), new Set())).toMatchObject({ kind: 'input', input: '1' });
    }
  });

  test('extra actions, unrelated questions and ambiguous offered choices do not acquire input', () => {
    for (const label of ['Skip for now and delete CLAUDE.md', 'Skip for now, implement the feature', 'Skip the review for now', 'Skip for now unless the API changes', 'Ask me after this review']) {
      expect(autoplanSetupDecision(frame.replace('2. Skip for now', '2. ' + label), new Set()).kind, label).not.toBe('input');
    }
    for (const changed of [
      frame.replace(question.question, 'Which product API routing design should we choose?'),
      frame.replace(question.question, 'The plan quotes gstack skill routing rules in CLAUDE.md. Should we build an API router?'),
      frame.replace('1. Add routing rules (Recommended)', '1. Implement routing (Recommended)'),
      frame.replace('2. Skip for now', '2. Add routing rules'),
      frame.replace('3. Type something.', '3. Skip for now\n  4. Type something.').replace('4. Chat about this', '5. Chat about this'),
      frame.replace('3. Type something.', '3. Implement the feature\n  4. Type something.').replace('4. Chat about this', '5. Chat about this'),
    ]) expect(autoplanSetupDecision(changed, new Set()).kind, changed).not.toBe('input');
  });

  test('only the complete current native panel can supply this additional label', () => {
    const panel = frame.slice(frame.indexOf(' ☐ Routing rules'));
    for (const changed of [
      'Example panel:\n' + panel, 'Quoted source:\n' + panel, '```text\n' + panel, '~~~~text\n' + panel,
      panel.split('\n').map(line => '    ' + line).join('\n'), panel.split('\n').map(line => '> ' + line).join('\n'),
      panel + '\n● Continuing the review.', panel.replace('Esc to cancel', 'Esc to'),
      panel.replace('  4. Chat about this', ''), panel.replace('  3. Type something.', ''),
      panel.replace('❯ 1.', '  1.'), panel.replace('  2.', '❯ 2.'),
      panel.replace('1. Add', '1. [ ] Add'), panel.replace(' ☐ Routing rules', '← ☐ Routing rules ✔ Submit →'),
    ]) expect(autoplanSetupDecision(changed, new Set()).kind, changed).not.toBe('input');
    expect(autoplanSetupDecision('```text\nold code\n```\n' + panel, new Set())).toMatchObject({kind:'input',input:'1'});
  });

  test('present metadata cannot be replaced by the visible decline label', () => {
    for (const mutate of [
      (call:any) => {call.failed=true;}, (call:any) => {call.answered=true;},
      (call:any) => {call.questions=[];}, (call:any) => {call.questions.push(structuredClone(question));},
      (call:any) => {call.questions[0].multiSelect=true;}, (call:any) => {call.questions[0].header='Other';},
      (call:any) => {call.questions[0].question='Different question';},
      (call:any) => {call.questions[0].options[1].label='Different choice';},
    ]) {const call=native();mutate(call);expect(autoplanSetupDecision(frame,new Set(),call).kind).not.toBe('input');}
  });
});

test('routing regression inputs remain paid-selection dependencies', () => {
  expect(E2E_TOUCHFILES['autoplan-chain-pty']).toContain('test/autoplan-routing-o.test.ts');
  expect(E2E_TOUCHFILES['autoplan-chain-pty']).toContain('test/fixtures/autoplan-routing-o-screen.txt');
});

test.skipIf(process.platform === 'win32')('real PTY temporary routing decline advances after readiness with exactly one Add digit', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gstack-routing-o-'));
  const fake=path.join(dir,'fake-claude');const worker=path.join(dir,'worker.ts');const output=path.join(dir,'result.json');
  const cases=[false,true].map(early=>({name:early?'early':'deferred',early,frame,question,
    cwd:path.join(dir,early?'early':'deferred'),events:path.join(dir,early?'early.jsonl':'deferred.jsonl')}));
  for(const item of cases)fs.mkdirSync(item.cwd);
  fs.writeFileSync(fake,`#!${process.execPath}\n`+String.raw`
import * as fs from 'node:fs';import * as path from 'node:path';
const item=JSON.parse(process.env.ROUTING_CASE);const event=value=>fs.appendFileSync(item.events,JSON.stringify(value)+'\n');
const folder=path.join(process.env.CLAUDE_CONFIG_DIR,'projects','fixture');fs.mkdirSync(folder,{recursive:true});
const file=path.join(folder,item.name+'.jsonl');
const persist=value=>fs.appendFileSync(file,JSON.stringify({sessionId:item.name,isSidechain:false,cwd:process.cwd(),timestamp:new Date().toISOString(),...value})+'\n');
const use=()=>persist({type:'assistant',message:{role:'assistant',content:[{type:'tool_use',id:'routing',name:'AskUserQuestion',input:{questions:[item.question]}}]}});
event({kind:'startup',pid:process.pid});if(item.early)use();
process.stdin.setRawMode?.(true);process.stdin.resume();
process.stdin.on('data',data=>{event({kind:'input',data:data.toString()});if(!item.early)use();
persist({type:'user',toolUseResult:{answers:{[item.question.question]:'Add routing rules (Recommended)'}},message:{role:'user',content:[{type:'tool_result',tool_use_id:'routing',content:'User has answered your questions: "'+item.question.question+'"="Add routing rules (Recommended)". You can now continue with the user\'s answers in mind.'}]}});
process.stdout.write('\r\nROUTING_ACCEPTED\r\n');});
process.stdout.write('\x1b[2J\x1b[H'+item.frame.replace(/\n/g,'\r\n'));
process.on('SIGINT',()=>process.exit(0));
`);fs.chmodSync(fake,0o755);
  const url=(name:string)=>pathToFileURL(path.resolve(import.meta.dir,'helpers',name)).href;
  fs.writeFileSync(worker,`
import * as fs from 'node:fs';
import {launchClaudePty,resolveClaudeBinary} from ${JSON.stringify(url('claude-pty-runner.ts'))};
import {readPlanCountTranscript} from ${JSON.stringify(url('plan-count-transcript.ts'))};
import {autoplanSetupDecision} from ${JSON.stringify(url('autoplan-setup-question.ts'))};
if(resolveClaudeBinary()!==${JSON.stringify(fake)})throw Error('Fake binary binding failed before launch');
const results=[];
for(const item of ${JSON.stringify(cases)}){
 const session=await launchClaudePty({cwd:item.cwd,observeScreen:true,timeoutMs:15000,env:{ROUTING_CASE:JSON.stringify(item)}});
 try{
  await session.waitFor('Enter to select',{timeoutMs:10000,pollMs:20});
  const screen=await session.currentScreen();const before=readPlanCountTranscript(session.hermeticConfigDir,item.cwd);
  const pending=before.calls.find(call=>!call.answered&&!call.failed);
  if(Boolean(pending)!==item.early)throw Error('Incorrect readiness metadata');
  const seen=new Set();const decision=autoplanSetupDecision(screen,seen,pending);
  if(decision.kind!=='input'||decision.input!=='1')throw Error('Expected Add input: '+JSON.stringify(decision));
  session.send(decision.input);for(const signature of decision.signatures)seen.add(signature);
  await session.waitFor('ROUTING_ACCEPTED',{timeoutMs:3000,pollMs:20});
  const after=readPlanCountTranscript(session.hermeticConfigDir,item.cwd);
  results.push({name:item.name,decision,after,redraw:autoplanSetupDecision(screen,seen,pending).kind,
    answered:autoplanSetupDecision(screen,new Set(),after.calls[0]).kind});
 }finally{await session.close();}
}
fs.writeFileSync(${JSON.stringify(output)},JSON.stringify(results));
`);
  const child=Bun.spawn([process.execPath,worker],{env:{...process.env,BROWSE_TERMINAL_BINARY:fake},stdout:'pipe',stderr:'pipe'});
  const killer=setTimeout(()=>child.kill('SIGKILL'),25000);
  try{
    const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect(exit,stdout+stderr).toBe(0);
    const results=JSON.parse(fs.readFileSync(output,'utf8'));
    expect(results.length).toBe(2);
    for(const [index,result]of results.entries()){
      expect(result.decision).toMatchObject({kind:'input',input:'1'});expect(result.redraw).toBe('waiting');expect(result.answered).toBe('waiting');
      expect(result.after.calls.length).toBe(1);expect(result.after.calls[0].answered).toBe(true);
      expect(result.after.calls[0].answers[question.question]).toBe('Add routing rules (Recommended)');
      const events=fs.readFileSync(cases[index]!.events,'utf8').trim().split('\n').map(line=>JSON.parse(line));
      expect(events.filter(event=>event.kind==='input')).toEqual([{kind:'input',data:'1'}]);
      expect(()=>process.kill(events[0].pid,0)).toThrow();
    }
  }finally{
    clearTimeout(killer);child.kill('SIGKILL');
    for(const item of cases)if(fs.existsSync(item.events)){
      const pid=JSON.parse(fs.readFileSync(item.events,'utf8').split('\n')[0]!).pid;
      if(process.platform==='linux')try{if(fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\0').includes(fake))process.kill(pid,'SIGKILL');}catch{}
    }
    fs.rmSync(dir,{recursive:true,force:true});
  }
},30000);
