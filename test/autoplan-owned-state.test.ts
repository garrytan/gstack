import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createNativeReviewState, ownedNativeReviewStateRoot } from './helpers/plan-count-fixture';
import { createAutoplanArtifactRecorder, autoplanArtifactRecorderStatus } from './helpers/autoplan-artifact-recorder';
import { readPlanCountTranscript, type NativePublicToolEvent } from './helpers/plan-count-transcript';
import captured from './fixtures/autoplan-owned-state-edit.json';

const cleanups:Array<()=>void>=[];
afterEach(()=>{for(const cleanup of cleanups.splice(0).reverse())cleanup();});
function state(){const s=createNativeReviewState();cleanups.push(s.cleanup);return s;}
function temp(){const r=fs.mkdtempSync(path.join(os.tmpdir(),'gstack-autoplan-owned-state-test-'));cleanups.push(()=>fs.rmSync(r,{recursive:true,force:true}));return r;}

test('only the live constructor object owns its state; fields, copies and sibling state confer no authority',()=>{
  const first=state(),second=state();
  expect(Object.keys(first).sort()).toEqual(['cleanup','env']);
  expect(ownedNativeReviewStateRoot(first,first.env)).toBe(first.env.GSTACK_HOME);
  for(const invalid of [{...first}, {env:first.env,cleanup(){}},second])
    expect(()=>ownedNativeReviewStateRoot(invalid,first.env)).toThrow();
  first.cleanup();
  expect(()=>ownedNativeReviewStateRoot(first,first.env)).toThrow();
  expect(ownedNativeReviewStateRoot(second,second.env)).toBe(second.env.GSTACK_HOME);
});

for(const key of ['GSTACK_HOME','GSTACK_STATE_ROOT'])test(`${key} cannot redirect an owned artifact grant`,()=>{
  const s=state(),foreign=temp();
  for(const value of [undefined,'',foreign,s.env.GSTACK_HOME+'/../'+path.basename(s.env.GSTACK_HOME)])
    expect(()=>ownedNativeReviewStateRoot(s,{...s.env,[key]:value})).toThrow();
});

for(const kind of ['replacement','symlink'])test.skipIf(process.platform==='win32'&&kind==='symlink')(`${kind} state directory cannot reuse constructor ownership`,()=>{
  const s=state(),root=s.env.GSTACK_HOME!,moved=root+'.original',foreign=temp();
  fs.renameSync(root,moved);
  try{
    if(kind==='symlink')fs.symlinkSync(foreign,root);else fs.mkdirSync(root);
    expect(()=>ownedNativeReviewStateRoot(s,s.env)).toThrow();
  }finally{fs.rmSync(root,{recursive:true,force:true});fs.renameSync(moved,root);}
});

// Captured public input is replayed in a new disposable root. Shift only paths
// and the wall clock; native IDs, request bytes and acknowledgment order stay exact.
for(const kind of ['owned','legacy','unanswered','failed','foreign','changed','completed'])test(`captured pending Edit ${kind} keeps native acknowledgment and containment gates`,()=>{
  const s=state(),root=temp(),cwd=path.join(root,'gstack-autoplan-chain-S3FSi5'),config=path.join(root,'config');fs.mkdirSync(cwd);
  const oldRoot=captured.file.slice(0,captured.file.indexOf('/projects/'));
  const file=path.join(s.env.GSTACK_HOME!,path.relative(oldRoot,captured.file));
  fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,captured.before);
  const events=JSON.parse(JSON.stringify(captured.events).replaceAll(oldRoot,s.env.GSTACK_HOME!)) as NativePublicToolEvent[];
  const current=events.at(-1)!,now=Date.now(),delta=now-1000-Date.parse(current.timestamp),started=captured.commandStartedAt+delta;
  for(const e of events)e.timestamp=new Date(Date.parse(e.timestamp)+delta).toISOString();
  fs.utimesSync(file,new Date(now-2000),new Date(now-2000));
  if(kind==='unanswered')for(let i=events.length-1;i>=0;i--)if(events[i]!.kind==='result')events.splice(i,1);
  if(kind==='failed')for(const e of events)if(e.kind==='result')e.isError=true;
  if(kind==='foreign')current.input!.file_path=path.join(root,'foreign.md');
  if(kind==='completed')events.push({kind:'result',sessionId:current.sessionId,toolUseId:current.toolUseId,timestamp:new Date(now-500).toISOString(),isError:false});
  const native=path.join(config,'projects','fixture',current.sessionId+'.jsonl');fs.mkdirSync(path.dirname(native),{recursive:true});
  fs.writeFileSync(native,events.map(e=>JSON.stringify({cwd,sessionId:e.sessionId,isSidechain:false,timestamp:e.timestamp,requestId:e.requestId,
    message:e.kind==='use'?{role:'assistant',id:e.messageId,content:[{type:'tool_use',id:e.toolUseId,name:e.name,input:e.input}]}:
      {role:'user',content:[{type:'tool_result',tool_use_id:e.toolUseId,content:e.content,is_error:e.isError}]}})+'\n').join(''));
  const grantRoot=kind==='legacy'?path.join(root,'legacy'):ownedNativeReviewStateRoot(s,s.env);fs.mkdirSync(grantRoot,{recursive:true});
  const originalClock=Date.now;Date.now=()=>started;
  let recorder:ReturnType<typeof createAutoplanArtifactRecorder>;
  try{recorder=createAutoplanArtifactRecorder(cwd,config,grantRoot,true);recorder.startEditApproval!(started);}finally{Date.now=originalClock;}
  cleanups.push(recorder.dispose);
  const event={hook_event_name:'PreToolUse',tool_name:'Edit',session_id:current.sessionId,tool_use_id:current.toolUseId,cwd,transcript_path:native,tool_input:{...current.input}};
  if(kind==='changed')event.tool_input.new_string='Not the published Edit';
  const before=fs.readFileSync(file),journal=fs.readFileSync(native);
  const r=spawnSync('bash',['-c',recorder.hooks.PreToolUse[0]!.hooks[0]!.command],{cwd,input:JSON.stringify(event),encoding:'utf8',timeout:6000});
  expect(r.error).toBeUndefined();expect(r.status).toBe(0);expect(r.stderr).toBe('');
  expect(r.stdout?JSON.parse(r.stdout).hookSpecificOutput.permissionDecision:null).toBe(kind==='owned'?'allow':null);
  expect(fs.readFileSync(file)).toEqual(before);expect(fs.readFileSync(native)).toEqual(journal);
  const publicTools:NativePublicToolEvent[]=[];const transcript=readPlanCountTranscript(config,cwd,e=>publicTools.push(e));
  expect(transcript.calls).toHaveLength(0);
  expect(publicTools.some(e=>e.kind==='result'&&e.toolUseId===current.toolUseId)).toBe(kind==='completed');
  if(kind==='owned')expect(autoplanArtifactRecorderStatus(recorder.file,cwd,config,grantRoot)).toEqual({status:'pending'});
  if(kind==='legacy')expect(autoplanArtifactRecorderStatus(recorder.file,cwd,config,grantRoot)).toEqual({status:'idle'});
});

test.skipIf(process.platform==='win32')('real launcher binds explicit caller state to hook and actor while defaults and invalid overrides stay separate',async()=>{
  const root=temp(),fake=path.join(root,'fake-claude');
  fs.writeFileSync(fake,`#!${process.execPath}\n`+String.raw`
import fs from 'node:fs';
fs.writeFileSync(process.env.STATE_RESULT,JSON.stringify({pid:process.pid,args:process.argv.slice(2),home:process.env.GSTACK_HOME,state:process.env.GSTACK_STATE_ROOT}));
process.stdout.write('STATE_READY\n');process.stdin.resume();
`,{mode:0o755});
  const runner=pathToFileURL(path.join(import.meta.dir,'helpers/claude-pty-runner.ts')).href;
  const owner=pathToFileURL(path.join(import.meta.dir,'helpers/plan-count-fixture.ts')).href;
  for(const variant of ['owned','legacy','ambient-only','forged','mismatch-home','mismatch-state','explicit-home','explicit-config','not-observed','disposed']){
    const cwd=path.join(root,variant);fs.mkdirSync(cwd);const result=path.join(cwd,'result.json'),worker=path.join(cwd,'worker.ts');
    const valid=['owned','legacy','ambient-only'].includes(variant);
    fs.writeFileSync(worker,`
import fs from 'node:fs';
import {launchClaudePty,resolveClaudeBinary} from ${JSON.stringify(runner)};
import {createNativeReviewState} from ${JSON.stringify(owner)};
if(resolveClaudeBinary()!==${JSON.stringify(fake)})throw Error('fake binding');
const state=createNativeReviewState(),variant=${JSON.stringify(variant)};
const env={...(variant==='legacy'?{}:state.env),STATE_RESULT:${JSON.stringify(result)}};
if(variant==='mismatch-home')env.GSTACK_HOME=${JSON.stringify(cwd)};
if(variant==='mismatch-state')env.GSTACK_STATE_ROOT=${JSON.stringify(cwd)};
if(variant==='explicit-home')env.HOME=${JSON.stringify(cwd)};
if(variant==='explicit-config')env.CLAUDE_CONFIG_DIR=${JSON.stringify(cwd)};
if(variant==='disposed')state.cleanup();
let session;
try{
 try{session=await launchClaudePty({cwd:${JSON.stringify(cwd)},seedSkills:true,observeAutoplanArtifacts:variant!=='not-observed',approveAutoplanArtifactEdits:true,
   ...(variant==='legacy'||variant==='ambient-only'?{}:{autoplanArtifactState:variant==='forged'?{...state}:state}),env,timeoutMs:8000});}
 catch(error){if(${valid})throw error;fs.writeFileSync(${JSON.stringify(result)},JSON.stringify({rejected:true,message:String(error)}));}
 if(session){
   if(!${valid})throw Error('invalid state launched');
   await session.waitFor('STATE_READY',{timeoutMs:2000,pollMs:20});
   const r=JSON.parse(fs.readFileSync(${JSON.stringify(result)},'utf8'));
   r.file=session.pendingAutoplanArtifactFile;r.actor=session.autoplanArtifactStateRoot;r.legacy=session.hermeticSkillStateRoot;
   r.qa=session.autoplanEngTestPlanStateRoot;
   r.metadata=JSON.parse(fs.readFileSync(r.file,'utf8'));r.caller=state.env.GSTACK_HOME;
   fs.writeFileSync(${JSON.stringify(result)},JSON.stringify(r));
 }
}finally{await session?.close();state.cleanup();}
`);
    const child=Bun.spawn([process.execPath,worker],{env:{...process.env,BROWSE_TERMINAL_BINARY:fake,EVALS_HERMETIC:'1'},stdout:'pipe',stderr:'pipe'});
    const timer=setTimeout(()=>child.kill('SIGKILL'),15000);
    try{const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);expect(code,out+err).toBe(0);}finally{clearTimeout(timer);}
    const r=JSON.parse(fs.readFileSync(result,'utf8'));
    if(!valid){expect(r.rejected).toBe(true);expect(r.pid).toBeUndefined();continue;}
    expect(r.actor).toBe(r.metadata.stateRoot);
    if(variant==='owned'){expect(r.actor).toBe(r.caller);expect(r.home).toBe(r.actor);expect(r.state).toBe(r.actor);expect(r.legacy).not.toBe(r.actor);}
    else {expect(r.actor).toBe(r.legacy);expect(r.actor).not.toBe(r.caller);}
    expect(r.qa).toBe(variant==='owned'?r.legacy:undefined);
    expect(r.metadata.engTestPlanRoot).toBe(r.qa);
    const settings=JSON.parse(r.args[r.args.indexOf('--settings')+1]);
    for(const entries of Object.values(settings.hooks) as any[])expect(entries[0].hooks[0].command).toContain(r.actor);
    expect(r.args[r.args.indexOf('--add-dir',r.args.indexOf('--add-dir')+1)+1]).toBe(r.legacy);
    expect(fs.existsSync(r.file)).toBe(false);expect(()=>process.kill(r.pid,0)).toThrow();
  }
},90000);
