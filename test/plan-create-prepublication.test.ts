import {expect,test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {createHash} from 'node:crypto';
import {createFilePermissionRecorder,recordFilePermission,currentFilePermissionEpoch,readPendingWriteInput} from './helpers/plan-count-file-permission';
import {readPlanCountTranscript} from './helpers/plan-count-transcript';
import {createPlanCountPermissionGuard} from './helpers/claude-pty-runner';
import {createPlanCountSnapshotWriter} from './helpers/plan-count-artifacts';
import captured from './fixtures/plan-create-prepublication-491.json';

function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gstack-prewrite-'));const cwd=path.join(root,'owned'),config=path.join(root,'config');fs.mkdirSync(cwd);
 const expected=path.join(cwd,path.basename(captured.originalHook.expected)),sid=captured.originalHook.sessionId;
 const id=captured.originalHook.pendingId.slice(sid.length+1),journal=path.join(config,'projects','owned',sid+'.jsonl');fs.mkdirSync(path.dirname(journal),{recursive:true});
 const startedAt=Date.now()-1000;const recorder=createFilePermissionRecorder(cwd,config,expected)!;
 const input={file_path:expected,content:captured.controlledWriteContent};
 const native=(role:string,content:any[])=>({cwd,sessionId:sid,isSidechain:false,timestamp:new Date().toISOString(),message:{role,content}});
 const base=[native('assistant',[{type:'text',text:'Preparing the requested review.'}])];
 const write=(rows:any[])=>fs.writeFileSync(journal,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');write(base);
 const hook=(kind='PreToolUse',toolId=id,toolInput:any=input,extra={})=>recordFilePermission(JSON.stringify({hook_event_name:kind,tool_name:'Write',session_id:sid,tool_use_id:toolId,cwd,transcript_path:journal,tool_input:toolInput,...extra}),recorder.file,cwd,config,expected);
 const screen=captured.originalScreen.replaceAll(path.dirname(captured.originalHook.expected),cwd);
 const read=()=>currentFilePermissionEpoch(recorder.file,expected,cwd,config,startedAt,readPlanCountTranscript(config,cwd),screen);
 const block=(toolId=id,toolInput:any=input,name='Write')=>({type:'tool_use',id:toolId,name,input:toolInput});
 const sidecar=recorder.file+'.write.json';
 return {root,cwd,config,expected,sid,id,journal,recorder,input,native,base,write,hook,screen,read,block,sidecar,startedAt,close(){recorder.dispose();fs.rmSync(root,{recursive:true,force:true});}};
}

test('owned current Write prepublication input authenticates the captured cropped Create once',()=>{
 const f=fixture();try{
  f.hook();expect(f.read()?.pendingId).toBe(`${f.sid}:${f.id}`);
  const guard=createPlanCountPermissionGuard();expect(guard(f.screen,'',f.read())).toBe('grant');expect(guard(f.screen,'',f.read())).toBe('handled');
  const state=JSON.parse(fs.readFileSync(f.recorder.file,'utf8')),bytes=fs.readFileSync(f.sidecar);
  expect(state.writeInputSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  expect(JSON.parse(bytes.toString()).input).toEqual(f.input);
  expect(fs.readFileSync(f.recorder.file,'utf8')).not.toContain(f.input.content);
  expect(fs.statSync(f.sidecar).mode&0o777).toBe(0o600);
 }finally{f.close();}
});

test('original content-free capture alone supplies no missing argument or permission credit',()=>{
 const f=fixture();try{f.hook();const state=JSON.parse(fs.readFileSync(f.recorder.file,'utf8'));delete state.writeInputSha256;fs.writeFileSync(f.recorder.file,JSON.stringify(state));fs.rmSync(f.sidecar,{force:true});expect(f.read()).toBeNull();}finally{f.close();}
});

test.each(['other-pending','completed','changed-hidden-input','different-tool','conflicting-duplicate'])(`prepublication cannot override %s public native evidence`,mode=>{
 const f=fixture();try{f.hook();let rows:any[]=[...f.base];
  if(mode==='other-pending')rows.push(f.native('assistant',[f.block('different')]));
  if(mode==='completed')rows.push(f.native('user',[{type:'tool_result',tool_use_id:f.id,content:'done'}]));
  if(mode==='changed-hidden-input')rows.push(f.native('assistant',[f.block(f.id,{...f.input,content:f.input.content.replace(/^.*$/m,'Changed invisible first line')})]));
  if(mode==='different-tool')rows.push(f.native('assistant',[f.block(f.id,f.input,'Read')]));
  if(mode==='conflicting-duplicate')rows.push(f.native('assistant',[f.block(),f.block(f.id,{...f.input,content:'different'})]));
  f.write(rows);expect(f.read()).toBeNull();
 }finally{f.close();}
});

test('matching published Write retains the existing route and exact input agreement',()=>{
 const f=fixture();try{f.hook();f.write([...f.base,f.native('assistant',[f.block()])]);expect(f.read()?.pendingId).toBe(`${f.sid}:${f.id}`);}finally{f.close();}
});

test.each(['missing','changed-bytes','linked','wrong-current-id','foreign-target'])(`invalid %s witness fails closed`,mode=>{
 const f=fixture();try{f.hook();
  if(mode==='missing')fs.unlinkSync(f.sidecar);
  if(mode==='changed-bytes')fs.appendFileSync(f.sidecar,' ');
  if(mode==='linked'){const copy=f.sidecar+'.copy';fs.copyFileSync(f.sidecar,copy);fs.unlinkSync(f.sidecar);fs.symlinkSync(copy,f.sidecar);}
  if(mode==='wrong-current-id'||mode==='foreign-target'){
   const witness=JSON.parse(fs.readFileSync(f.sidecar,'utf8'));
   if(mode==='wrong-current-id')witness.pendingId=`${f.sid}:different`;else witness.input.file_path=f.expected+'-foreign';
   const bytes=JSON.stringify(witness);fs.writeFileSync(f.sidecar,bytes);const state=JSON.parse(fs.readFileSync(f.recorder.file,'utf8'));state.writeInputSha256=createHash('sha256').update(bytes).digest('hex');fs.writeFileSync(f.recorder.file,JSON.stringify(state));
  }expect(f.read()).toBeNull();
 }finally{f.close();}
});

test('completion and replay cannot retain or reopen a Write witness; a later failed-save recovery is fresh',()=>{
 const f=fixture();try{f.hook();f.hook('PostToolUseFailure');expect(f.read()).toBeNull();expect(fs.existsSync(f.sidecar)).toBe(false);f.hook();expect(f.read()).toBeNull();f.hook('PreToolUse','recovery');expect(f.read()?.pendingId).toBe(`${f.sid}:recovery`);f.hook('PostToolUse','recovery');expect(fs.existsSync(f.sidecar)).toBe(false);f.hook('PreToolUse','recovery');expect(f.read()).toBeNull();}finally{f.close();}
});

test('overlapping uncompleted hook epochs never borrow the most recently captured Write',()=>{
 const f=fixture();try{f.hook();f.hook('PreToolUse','second');expect(f.read()).toBeNull();f.hook('PostToolUse','second');f.hook('PreToolUse','third');expect(f.read()).toBeNull();}finally{f.close();}
});


test('conflicting repeated current hook arguments invalidate the witness without reopening its ID',()=>{
 const f=fixture();try{
  f.hook();f.hook();expect(f.read()?.pendingId).toBe(`${f.sid}:${f.id}`);
  f.hook('PreToolUse',f.id,{...f.input,content:f.input.content+'\nchanged hidden tail'});
  expect(f.read()).toBeNull();
  f.hook();expect(f.read()).toBeNull();
  f.hook('PostToolUseFailure');f.hook();expect(f.read()).toBeNull();
  f.hook('PreToolUse','fresh');expect(f.read()?.pendingId).toBe(`${f.sid}:fresh`);
 }finally{f.close();}
});

test.each(['cwd','target','config','stale','future','linked-state','oversized-state','oversized-witness'])(`standalone witness reader rejects %s ownership or bounds`,mode=>{
 const f=fixture();try{
  f.hook();let cwd=f.cwd,expected=f.expected,config:string|null=f.config,startedAt=f.startedAt;
  if(mode==='cwd')cwd+='-foreign';
  if(mode==='target')expected+='-foreign';
  if(mode==='config')config+='-foreign';
  if(mode==='stale')startedAt=Date.now()+1000;
  if(mode==='future'){
   const state=JSON.parse(fs.readFileSync(f.recorder.file,'utf8'));
   state.timestamp=new Date(Date.now()+60_000).toISOString();fs.writeFileSync(f.recorder.file,JSON.stringify(state));
  }
  if(mode==='linked-state'){
   fs.renameSync(f.recorder.file,f.recorder.file+'.copy');fs.symlinkSync(f.recorder.file+'.copy',f.recorder.file);
  }
  if(mode==='oversized-state')fs.truncateSync(f.recorder.file,64*1024+1);
  if(mode==='oversized-witness')fs.truncateSync(f.sidecar,4*1024*1024+1);
  expect(readPendingWriteInput(f.recorder.file,expected,cwd,config,startedAt)).toBeUndefined();
 }finally{f.close();}
});

test.each(['foreign-session','sidechain','foreign-target','foreign-journal'])(`foreign %s hook cannot supply the cropped Create input`,mode=>{
 const f=fixture();try{
  const extra:any={};let input:any=f.input;
  if(mode==='foreign-session')extra.session_id='foreign';
  if(mode==='sidechain')extra.agent_id='foreign';
  if(mode==='foreign-target')input={...input,file_path:f.expected+'-foreign'};
  if(mode==='foreign-journal')extra.transcript_path=path.join(f.root,'foreign.jsonl');
  f.hook('PreToolUse',f.id,input,extra);expect(f.read()).toBeNull();expect(fs.existsSync(f.sidecar)).toBe(false);
 }finally{f.close();}
});

test('oversized actual hook input fails closed without a witness',()=>{
 const f=fixture();try{
  f.hook('PreToolUse',f.id,{...f.input,content:'x'.repeat(4*1024*1024)});
  expect(f.read()).toBeNull();expect(fs.existsSync(f.sidecar)).toBe(false);
 }finally{f.close();}
});

test('legacy published Write metadata remains sufficient without a sidecar',()=>{
 const f=fixture();try{
  f.hook();const state=JSON.parse(fs.readFileSync(f.recorder.file,'utf8'));
  delete state.writeInputSha256;fs.writeFileSync(f.recorder.file,JSON.stringify(state));fs.unlinkSync(f.sidecar);
  f.write([...f.base,f.native('assistant',[f.block()])]);expect(f.read()?.pendingId).toBe(`${f.sid}:${f.id}`);
 }finally{f.close();}
});

// Execute only the actual count capture assembly with its real reader/writer.
// This is not a full counting-loop execution; existing count throw/timeout tests
// separately prove that the lifecycle invokes capture before fixture disposal.
test('count capture assembly retains exact prepublication input through refresh, throw and fixture cleanup',()=>{
 const f=fixture(),evalDir=fs.mkdtempSync(path.join(os.tmpdir(),'count-write-retention-'));
 try {
  f.hook();const expected=readPendingWriteInput(f.recorder.file,f.expected,f.cwd,f.config,f.startedAt);
  expect(expected).toBeDefined();
  const source=fs.readFileSync(path.join(import.meta.dir,'helpers/claude-pty-runner.ts'),'utf8');
  const start=source.indexOf('  const capture = (observation: object) => saveSnapshot({',source.indexOf('export async function runPlanSkillCounting('));
  const end=source.indexOf('\n  });',start);
  expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);
  const code=new Bun.Transpiler({loader:'ts'}).transformSync(source.slice(start,end+6)+'\nreturn capture;');
  const capture=new Function('saveSnapshot','opts','ownedFilePermissions','readPendingWriteInput','fixture','session','startedAt','viewport',code)(
   createPlanCountSnapshotWriter({EVALS_RUN_ID:'count-prepublication-free',GSTACK_EVAL_DIR:evalDir}),
   {skillName:'plan-eng-review'},[{file:f.recorder.file,expected:f.expected}],readPendingWriteInput,
   {cwd:f.cwd},{hermeticConfigDir:f.config,rawOutput:()=>f.screen,visibleText:()=>f.screen},f.startedAt,f.screen);
  const progress=capture({state:'in_progress'});
  const thrown=capture({state:'threw',error:'controlled caller interruption'});
  expect(thrown.artifactDir).toBe(progress.artifactDir);expect(thrown.artifactError).toBeUndefined();
  f.close();
  const saved=JSON.parse(fs.readFileSync(path.join(thrown.artifactDir,'observation.json'),'utf8'));
  expect(saved.state).toBe('threw');expect(saved.error).toBe('controlled caller interruption');
  expect(saved.pendingWriteInputs).toEqual([expected]);expect(fs.existsSync(f.recorder.file)).toBe(false);
  expect(fs.readFileSync(path.join(thrown.artifactDir,'terminal.screen.log'),'utf8')).toBe(f.screen);
  expect(fs.statSync(path.join(thrown.artifactDir,'observation.json')).mode&0o777).toBe(0o600);
 }finally{f.close();fs.rmSync(evalDir,{recursive:true,force:true});}
});
