import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const fixture = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures/native-auto-decide-ag.json'), 'utf8'));
const retry = fixture.attempts[1];
const annotation = retry.transcript.assistantMessages.find((m: any) => m.sessionId === retry.options.sessionId && m.text.includes('Auto-decided')).text;

test('owned native AUTO_DECIDE survives damaged terminal and polls again after scope selection', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'auto-decide-pty-')), cli=path.join(dir,'fake-claude');
  const working=path.join(dir,'repo');fs.mkdirSync(working);
  fs.writeFileSync(cli, `#!/usr/bin/env bun
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),id=args[args.indexOf('--session-id')+1];
fs.writeFileSync(process.env.AUTO_TEST_ARGV,JSON.stringify(args));
let sent=false;
process.stdin.on('data',chunk=>{
  if(sent||!chunk.toString().includes('/plan-ceo-review'))return;sent=true;
  const root=path.join(process.env.CLAUDE_CONFIG_DIR,'projects','fixture');fs.mkdirSync(root,{recursive:true});
  const file=path.join(root,id+'.jsonl'),base=Date.now();
  const record=(type,n,content)=>JSON.stringify({type,isSidechain:false,cwd:process.cwd(),sessionId:id,timestamp:new Date(base+n).toISOString(),message:{role:type,content}});
  const rows=[record('assistant',1,[{type:'tool_use',id:'load',name:'Skill',input:{skill:'plan-ceo-review'}}]),record('user',2,[{type:'tool_result',tool_use_id:'load',content:'loaded',is_error:false}]),record('assistant',3,[{type:'text',text:'I will review the "Auto decision fixture" draft plan pasted here.'}])];
  fs.writeFileSync(file,rows.join('\\n')+'\\n');process.stdout.write('Working on the current review.\\n');
  setTimeout(()=>{fs.appendFileSync(file,record('assistant',Date.now()-base-1,[{type:'text',text:${JSON.stringify(annotation)}}])+'\\n');process.stdout.write('Auto-dcided review mode: HOLD SCOPE. DONE.\\n');},4500);
});
setInterval(()=>{},1000);
`,{mode:0o755});
  try {
    const runner=pathToFileURL(path.join(import.meta.dir,'helpers/claude-pty-runner.ts')).href;
    const childFile=path.join(dir,'observe.ts');
    fs.writeFileSync(childFile,`import {runPlanSkillObservation,resolveClaudeBinary} from ${JSON.stringify(runner)};
if(resolveClaudeBinary()!==process.env.BROWSE_TERMINAL_BINARY)throw new Error('Fake CLI resolution failed');
const obs=await runPlanSkillObservation({skillName:'plan-ceo-review',inPlanMode:true,initialPlanContent:'# Plan: Auto decision fixture\\n\\nReview this current draft.',cwd:${JSON.stringify(working)},extraArgs:['--disallowedTools','AskUserQuestion'],timeoutMs:12000,env:{AUTO_TEST_ARGV:process.env.AUTO_TEST_ARGV}});
console.log(JSON.stringify(obs));
`);
    const child=Bun.spawn([process.execPath,childFile],{cwd:process.cwd(),env:{...process.env,BROWSE_TERMINAL_BINARY:cli,AUTO_TEST_ARGV:path.join(dir,'argv.json'),EVALS_RUN_ID:'native-auto-fake',GSTACK_EVAL_DIR:path.join(dir,'evidence')},stdout:'pipe',stderr:'pipe'});
    const [stdout,stderr,exitCode]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
    expect(exitCode,stderr).toBe(0);const obs=JSON.parse(stdout.trim().split('\n').at(-1)!);
    expect(obs.scopeGateAutoSelectObserved,JSON.stringify(obs)).toBe(true);expect(obs.outcome,JSON.stringify(obs)).toBe('auto_decided');
    const argv=JSON.parse(fs.readFileSync(path.join(dir,'argv.json'),'utf8'));expect(argv.filter((x:string)=>x==='--session-id')).toHaveLength(1);
    expect(argv).toContain('--disallowedTools');expect(argv).toContain('AskUserQuestion');const id=argv[argv.indexOf('--session-id')+1];
    const saved=JSON.parse(fs.readFileSync(path.join(obs.artifactDir,'observation.json'),'utf8'));
    expect(saved.scopeSessionId).toBe(id);expect(saved.nativeAutoDecide.sessionId).toBe(id);
    expect(saved.native.assistantMessages.some((m:any)=>m.sessionId===id&&m.text===annotation)).toBe(true);
    expect(saved.publicTools.some((e:any)=>e.toolUseId==='load'&&e.kind==='result'&&!e.isError)).toBe(true);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
},40000);
