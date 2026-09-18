import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFakeBunCli } from './helpers/fake-bun-cli';
import { fakePlanSeedPrelude } from './helpers/fake-plan-seed';

const fixture = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures/native-auto-decide-ag.json'), 'utf8'));
const retry = fixture.attempts[1];
const annotation = retry.transcript.assistantMessages.find((m: any) => m.sessionId === retry.options.sessionId && m.text.includes('Auto-decided')).text;

test('owned native AUTO_DECIDE survives damaged terminal and polls again after scope selection', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'auto-decide-pty-'));
  const working=path.join(dir,'repo');fs.mkdirSync(working);
  const cli = createFakeBunCli(path.join(dir,'fake-claude'), fakePlanSeedPrelude() + `
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),id=args[args.indexOf('--session-id')+1];
fs.writeFileSync(process.env.AUTO_TEST_ARGV,JSON.stringify(args));
let sent=false;
process.on('gstack-seeded-slash',chunk=>{
  if(sent||!chunk.toString().includes('/plan-ceo-review'))return;sent=true;
  const root=path.join(process.env.CLAUDE_CONFIG_DIR,'projects','fixture');fs.mkdirSync(root,{recursive:true});
  const file=path.join(root,id+'.jsonl'),base=Date.now();
  const record=(type,n,content)=>JSON.stringify({type,isSidechain:false,cwd:process.cwd(),sessionId:id,timestamp:new Date(base+n).toISOString(),message:{role:type,content}});
  const rows=[record('assistant',1,[{type:'tool_use',id:'load',name:'Skill',input:{skill:'plan-ceo-review'}}]),record('user',2,[{type:'tool_result',tool_use_id:'load',content:'loaded',is_error:false}]),record('assistant',3,[{type:'text',text:'I will review the "Auto decision fixture" draft plan pasted here.'}])];
  fs.writeFileSync(file,rows.join('\\n')+'\\n');process.stdout.write('Working on the current review.\\n');
  setTimeout(()=>{fs.appendFileSync(file,record('assistant',Date.now()-base-1,[{type:'text',text:${JSON.stringify(annotation)}}])+'\\n');process.stdout.write('Auto-dcided review mode: HOLD SCOPE. DONE.\\n');},2500);
});
setInterval(()=>{},1000);
`);
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

import structuredMode from './fixtures/auto-decide-structured-77.json';
import stateMode from './fixtures/auto-decide-state-cab3.json';
test('actual completed slash-mode evidence reaches auto_decided before an idle terminal judge fallback', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-structured-pty-'));
  const working = path.join(dir, 'repo'); fs.mkdirSync(working);
  const events = [
    ...structuredMode.tools.map(e => ({ timestamp: e.timestamp, type: e.kind === 'use' ? 'assistant' : 'user',
      content: e.kind === 'use'
        ? [{ type: 'tool_use', id: e.toolUseId, name: e.name, input: e.input }]
        : [{ type: 'tool_result', tool_use_id: e.toolUseId, content: e.content, is_error: e.isError }] })),
    ...structuredMode.transcript.assistantMessages.filter(m => Date.parse(m.timestamp) >= structuredMode.options.commandStartedAt)
      .map(m => ({ timestamp: m.timestamp, type: 'assistant', content: [{ type: 'text', text: m.text }] })),
  ].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const cli = createFakeBunCli(path.join(dir, 'fake-claude'), fakePlanSeedPrelude() + `
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),id=args[args.indexOf('--session-id')+1];
let sent=false;
process.on('gstack-seeded-slash',chunk=>{
  if(sent||!chunk.toString().includes('/plan-ceo-review'))return;sent=true;
  const root=path.join(process.env.CLAUDE_CONFIG_DIR,'projects','fixture');fs.mkdirSync(root,{recursive:true});
  const base=Date.now();
  setTimeout(()=>{
    const rows=${JSON.stringify(events)}.map((row,index)=>JSON.stringify({type:row.type,isSidechain:false,cwd:process.cwd(),sessionId:id,timestamp:new Date(base+index+1).toISOString(),message:{role:row.type,content:row.content}}));
    fs.writeFileSync(path.join(root,id+'.jsonl'),rows.join('\\n')+'\\n');
    process.stdout.write('Finished the requested step. Idle.\\n');
  },1200);
});
setInterval(()=>{},1000);
`);
  try {
    const runner = pathToFileURL(path.join(import.meta.dir, 'helpers/claude-pty-runner.ts')).href;
    const childFile = path.join(dir, 'observe.ts');
    fs.writeFileSync(childFile, `import {runPlanSkillObservation,resolveClaudeBinary} from ${JSON.stringify(runner)};
if(resolveClaudeBinary()!==process.env.BROWSE_TERMINAL_BINARY)throw new Error('Fake CLI resolution failed');
const obs=await runPlanSkillObservation({skillName:'plan-ceo-review',inPlanMode:true,initialPlanContent:'# Plan: Auto decision fixture\\n\\nReview this current draft.',cwd:${JSON.stringify(working)},extraArgs:['--disallowedTools','AskUserQuestion'],timeoutMs:12000});
console.log(JSON.stringify(obs));
`);
    const child = Bun.spawn([process.execPath, childFile], { cwd: process.cwd(), env: {
      ...process.env, BROWSE_TERMINAL_BINARY: cli, EVALS_RUN_ID: 'structured-auto-fake', GSTACK_EVAL_DIR: path.join(dir, 'evidence'),
    }, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exitCode, stderr).toBe(0); const observation = JSON.parse(stdout.trim().split('\n').at(-1)!);
    expect(observation.outcome, JSON.stringify(observation)).toBe('auto_decided');
    expect(observation.proseAUQEverObserved).toBe(false);
    expect(observation.waitingEverObserved).toBe(false);
    expect(observation.nativeAutoDecide.skillToolUseId).toBeUndefined();
    expect(observation.nativeAutoDecide.questionLogToolUseId).toBe('toolu_01XGmQfqrq5rmsfNNuqGJj5q');
    const saved = JSON.parse(fs.readFileSync(path.join(observation.artifactDir, 'observation.json'), 'utf8'));
    expect(saved.native.calls).toEqual([]);
    expect(saved.nativeAutoDecide.option).toBe('HOLD SCOPE');
    expect(saved.publicTools.some((e: any) => e.name === 'Skill')).toBe(false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}, 40000);

test('owned state append and captured public declaration reach auto_decided through the actual observer', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'auto-state-pty-')));
  const working = path.join(dir, 'repo'), state = path.join(dir, 'state'); fs.mkdirSync(working);
  const project = path.join(state, 'projects', 'fixture'); fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'question-preferences.json'), JSON.stringify({ 'plan-ceo-review-mode': 'never-ask' }));
  const events = [
    ...stateMode.tools.map(e => ({ timestamp: e.timestamp, type: e.kind === 'use' ? 'assistant' : 'user',
      content: e.kind === 'use' ? [{ type: 'tool_use', id: e.toolUseId, name: e.name, input: e.input }]
        : [{ type: 'tool_result', tool_use_id: e.toolUseId, content: e.content, is_error: e.isError }] })),
    ...stateMode.transcript.assistantMessages.filter(m => Date.parse(m.timestamp) >= stateMode.options.commandStartedAt)
      .map(m => ({ timestamp: m.timestamp, type: 'assistant', content: [{ type: 'text', text: m.text }] })),
  ].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const logUse = stateMode.tools.find(e => e.input?.command?.includes('gstack-question-log'))!;
  const record = JSON.parse(/gstack-question-log '(\{[^\n]*\})'/.exec(logUse.input!.command)![1]!);
  const logAckIndex = events.findIndex(e => e.content.some(c => 'tool_use_id' in c && c.tool_use_id === logUse.toolUseId));
  expect(logAckIndex).toBeGreaterThan(0);
  const cli = createFakeBunCli(path.join(dir, 'fake-claude'), fakePlanSeedPrelude() + `
const fs=require('node:fs'),path=require('node:path');
if(process.env.DISABLE_AUTOUPDATER!=='1'||process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC!=='1')throw new Error('Pinned launch flags lost');
const args=process.argv.slice(2),id=args[args.indexOf('--session-id')+1];
process.once('gstack-seeded-slash',()=>{
  const root=path.join(process.env.CLAUDE_CONFIG_DIR,'projects','fixture');fs.mkdirSync(root,{recursive:true});
  const base=Date.now();
  setTimeout(()=>{
    const rows=${JSON.stringify(events)}.map((row,index)=>JSON.stringify({type:row.type,isSidechain:false,cwd:process.cwd(),sessionId:id,timestamp:new Date(base+index+1).toISOString(),message:{role:row.type,content:row.content}}));
    fs.writeFileSync(path.join(root,id+'.jsonl'),rows.join('\\n')+'\\n');
    fs.writeFileSync(${JSON.stringify(path.join(project, 'question-log.jsonl'))},JSON.stringify({...${JSON.stringify(record)},source:'agent',ts:new Date(base+${logAckIndex}+1).toISOString()})+'\\n');
    process.stdout.write('Finished the requested step. Idle.\\n');
  },1200);
});
setInterval(()=>{},1000);
`);
  try {
    const runner = pathToFileURL(path.join(import.meta.dir, 'helpers/claude-pty-runner.ts')).href;
    const childFile = path.join(dir, 'observe.ts');
    fs.writeFileSync(childFile, `import {runPlanSkillObservation} from ${JSON.stringify(runner)};
const obs=await runPlanSkillObservation({skillName:'plan-ceo-review',inPlanMode:true,initialPlanContent:'# Plan: Auto decision fixture\\nReview this draft.',cwd:${JSON.stringify(working)},extraArgs:['--disallowedTools','AskUserQuestion'],timeoutMs:12000,
autoDecisionState:{stateRoot:${JSON.stringify(state)},projectSlug:'fixture'},env:{GSTACK_STATE_ROOT:${JSON.stringify(state)},DISABLE_AUTOUPDATER:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'}});
console.log(JSON.stringify(obs));`);
    const child = Bun.spawn([process.execPath, childFile], { cwd: process.cwd(), env: {
      ...process.env, BROWSE_TERMINAL_BINARY: cli, EVALS_RUN_ID: 'owned-state-auto-fake', GSTACK_EVAL_DIR: path.join(dir, 'evidence'),
    }, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exitCode, stderr).toBe(0); const observation = JSON.parse(stdout.trim().split('\n').at(-1)!);
    expect(observation.outcome, JSON.stringify(observation)).toBe('auto_decided');
    expect(observation.waitingEverObserved).toBe(false);
    fs.rmSync(state, { recursive: true, force: true });
    const saved = JSON.parse(fs.readFileSync(path.join(observation.artifactDir, 'observation.json'), 'utf8'));
    expect(saved.nativeAutoDecide.stateRecord).toMatchObject(record);
    expect(saved.nativeAutoDecide.option).toBe('HOLD SCOPE');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}, 40000);
