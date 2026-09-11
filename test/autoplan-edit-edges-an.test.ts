import { capturedPathRebaser } from './helpers/captured-paths';
import {expect,test} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fixture from './fixtures/autoplan-edit-edges-an.json';
import * as permission from './helpers/autoplan-artifact-permission';
import {readPendingAutoplanArtifact} from './helpers/autoplan-artifact-recorder';
import {createAutoplanEditDigest} from './helpers/autoplan-artifact-digest';
import {readPlanCountTranscript,type NativePublicToolEvent} from './helpers/plan-count-transcript';
import {E2E_TOUCHFILES,selectTests} from './helpers/touchfiles';

function setup(changeRecords?:(records:any[])=>void){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gstack-ap-edges-'));
 const cwd=path.join(dir,path.basename(fixture.cwd)),config=path.join(dir,'config');
 const stateRoot=path.join(dir,'gstack-hermetic-2546450-gfwm4G/skill-home-k7zGB1/.gstack');
 const rebase=capturedPathRebaser([[fixture.stateRoot,stateRoot],[fixture.cwd,cwd],[fixture.config,config]]);
 const hook=rebase.json(fixture.hook);
 const file=hook.pending.file,nativeFile=path.join(config,'projects','owned',hook.sessionId+'.jsonl');hook.pending.transcriptPath=nativeFile;
 fs.mkdirSync(cwd,{recursive:true});fs.mkdirSync(path.dirname(file),{recursive:true});fs.mkdirSync(path.dirname(nativeFile),{recursive:true});
 fs.writeFileSync(file,fixture.before);fs.utimesSync(file,new Date(fixture.now-1000000),new Date(Date.parse(hook.pending.timestamp)-1000));
 const events=rebase.json(fixture.publicTools) as (NativePublicToolEvent & {messageId?:string;requestId?:string})[];
 const records=events.map(e=>({sessionId:e.sessionId,cwd,isSidechain:false,timestamp:e.timestamp,requestId:e.requestId,message:{id:e.messageId,role:e.kind==='use'?'assistant':'user',content:e.kind==='use'?[{type:'tool_use',id:e.toolUseId,name:e.name,input:e.input}]:[{type:'tool_result',tool_use_id:e.toolUseId,content:'',is_error:e.isError}]}}));
 changeRecords?.(records);
 fs.writeFileSync(nativeFile,records.map(r=>JSON.stringify(r)).join('\n')+'\n');
 const hookFile=path.join(dir,'hook.json');fs.writeFileSync(hookFile,JSON.stringify(hook)+'\n');
 const publicTools:NativePublicToolEvent[]=[];const native=readPlanCountTranscript(config,cwd,e=>publicTools.push(e));
 const pending=(readPendingAutoplanArtifact as any)(hookFile,cwd,config,stateRoot,fixture.commandStartedAt,publicTools,fixture.now,true);
 const context={cwd,ownedStateRoot:stateRoot,commandStartedAt:fixture.commandStartedAt,now:fixture.now,viewportCapturedAt:fixture.now,transcriptStatus:native.status,publicTools,pending};
 const invoke=(screen=fixture.viewport,ctx:any=context,seen=new Set<string>())=>(permission as any).publishedAutoplanArtifactPermissionInput?.(screen,ctx,seen)??null;
 return {dir,cwd,config,stateRoot,hook,hookFile,file,nativeFile,publicTools,context,invoke,dispose:()=>fs.rmSync(dir,{recursive:true,force:true})};
}


test('exact published Edit keeps unchanged suffixes in complete native preview rows',()=>{
 const s=setup();try{
  expect(s.context.pending?.toolUseId).toBe(fixture.hook.pending.toolUseId);
  expect(permission.autoplanArtifactPermissionInput(fixture.viewport,s.context,new Set())).toBeNull();
  expect(permission.pendingAutoplanArtifactPermissionInput(fixture.viewport,s.context,new Set())).toBeNull();
  expect(s.invoke()).toEqual({input:'1\r',signature:s.hook.sessionId+':'+s.hook.pending.toolUseId,file:s.file});
 }finally{s.dispose()}
});

type Replay=ReturnType<typeof setup>;
const current=(s:Replay)=>s.context.publicTools.find(e=>e.kind==='use'&&e.toolUseId===fixture.hook.pending.toolUseId)!;
const queued=(s:Replay)=>s.context.publicTools.filter(e=>e.kind==='use'&&e.name==='Edit'&&e.toolUseId!==fixture.hook.pending.toolUseId).at(-1)!;
function panel(s:Replay,rows:string[]){const bar='─'.repeat(120);return `${bar}\n Edit file\n ${s.file}\n${bar}\n${rows.join('\n')}\n${bar}\n Do you want to make this edit to ${path.basename(s.file)}?\n ❯ 1. Yes\n   2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)\n   3. No\n\n Esc to cancel · Tab to amend\n`;}
function request(s:Replay,before:string,old:string,replacement:string){
 fs.writeFileSync(s.file,before);fs.utimesSync(s.file,new Date(0),new Date(Date.parse(s.hook.pending.timestamp)-1000));
 const input=current(s).input!;input.old_string=old;input.new_string=replacement;
 s.context.pending!.editDigest=createAutoplanEditDigest(s.file,old,replacement)!;
}

test('unique request edges reconstruct exact prefix, suffix, newline and file boundaries',()=>{
 const cases:Array<[string,string,string,string,string[]]>=[
  ['both edges','prefix OLD suffix\n','OLD','NEW',[' 1 -prefix OLD suffix',' 1 +prefix NEW suffix']],
  ['file start','OLD suffix\n','OLD','NEW',[' 1 -OLD suffix',' 1 +NEW suffix']],
  ['file end','prefix OLD','OLD','NEW',[' 1 -prefix OLD',' 1 +prefix NEW']],
  ['line start','head\nOLD suffix\n','OLD','NEW',[' 2 -OLD suffix',' 2 +NEW suffix']],
  ['multiline edges','prefix first\nsecond suffix\n','first\nsecond','one\ntwo',[' 1 -prefix first',' 2 -second suffix',' 1 +prefix one',' 2 +two suffix']],
  ['trailing newline','prefix OLD\nnext\n','OLD\n','NEW\n',[' 1 -prefix OLD',' 1 +prefix NEW',' 2  next']],
  ['leading newline','head\nOLD suffix\n','\nOLD','\nNEW',[' 1  head',' 2 -OLD suffix',' 2 +NEW suffix']],
  ['insert newline','prefix OLD suffix\n','OLD','NEW\nNEXT',[' 1 -prefix OLD suffix',' 1 +prefix NEW',' 2 +NEXT suffix']],
  ['remove middle text','keep token tail\n','token ','',[' 1 -keep token tail',' 1 +keep tail']],
 ];
 for(const [name,before,old,replacement,rows] of cases){const s=setup();try{request(s,before,old,replacement);expect(s.invoke(panel(s,rows))?.input,name).toBe('1\r');}finally{s.dispose()}}
});

test('viewport edges must be exact unchanged file bytes and cannot come from queued edits',()=>{
 const s=setup();try{
  expect(s.invoke(fixture.viewport.replaceAll('the envelope becomes the response','the envelope leaks a secret'))).toBeNull();
  request(s,'prefix OLD suffix\n','OLD','NEW');
  for(const rows of [
   [' 1 -foreign OLD suffix',' 1 +foreign NEW suffix'],
   [' 1 -prefix OLD forged',' 1 +prefix NEW forged'],
   [' 1 -prefix OLD suffix',' 1 +prefix UNREQUESTED suffix'],
   [' 1 -prefix OLD suffix',' 1 +prefix NEW suffix',' 2 +queued sibling change'],
   [' 1  prefix OLD suffix',' 1 +prefix OLD suffix'],
  ])expect(s.invoke(panel(s,rows))).toBeNull();
  // A repeated old snippet must not select an arbitrary copy even when the pane matches one.
  request(s,'prefix OLD suffix\nanother OLD line\n','OLD','NEW');
  expect(s.context.pending!.editDigest).toBeUndefined();
  expect(s.invoke(panel(s,[' 1 -prefix OLD suffix',' 1 +prefix NEW suffix']))).toBeNull();
  const direct={...s.context,publicTools:s.context.publicTools.filter(e=>e.toolUseId===current(s).toolUseId||e.kind==='result'||e.toolUseId===fixture.publicTools[0]!.toolUseId)};
  expect(permission.autoplanArtifactPermissionInput(panel(s,[' 1 -prefix OLD suffix',' 1 +prefix NEW suffix']),direct,new Set())).toBeNull();
 }finally{s.dispose()}
});

test('exact digest, current ownership and batch authority stay mandatory for the actual partial-line pane',()=>{
 const cases:Array<[string,(s:Replay)=>void]>=[
  ['before digest',s=>{s.context.pending!.editDigest.beforeSHA256='0'.repeat(64)}],
  ['request digest',s=>{s.context.pending!.editDigest.requestSHA256='0'.repeat(64)}],
  ['changed file',s=>{fs.appendFileSync(s.file,'\nChanged');fs.utimesSync(s.file,new Date(0),new Date(0))}],
  ['changed request',s=>{current(s).input!.new_string+=' '}],
  ['stale hook',s=>{s.context.pending!.timestamp=new Date(fixture.commandStartedAt-1).toISOString()}],
  ['stale viewport',s=>{s.context.viewportCapturedAt=Date.parse(s.hook.pending.timestamp)-1}],
  ['foreign session',s=>{s.context.pending!.sessionId='foreign'}],
  ['foreign file',s=>{current(s).input!.file_path=s.file+'.other'}],
  ['foreign queued batch',s=>{queued(s).requestId='req_foreign'}],
  ['hooked queued sibling',s=>{s.context.pending!.hookSeenIds!.push(queued(s).toolUseId)}],
  ['no successful prior write',s=>{for(const e of s.context.publicTools)if(e.kind==='result')e.isError=true}],
  ['completed current request',s=>{s.context.publicTools.push({kind:'result',sessionId:s.hook.sessionId,toolUseId:current(s).toolUseId,timestamp:s.hook.pending.timestamp,isError:false})}],
 ];
 for(const [name,change] of cases){const s=setup();try{change(s);expect(s.invoke(),name).toBeNull()}finally{s.dispose()}}
 const s=setup();try{
  expect(s.invoke(fixture.viewport,s.context,new Set([s.hook.sessionId+':'+s.hook.pending.toolUseId]))).toBeNull();
  expect(s.invoke(fixture.viewport,s.context,new Set([permission.autoplanArtifactMenuKey(fixture.viewport)]))).toBeNull();
  expect(s.invoke('Source excerpt:\n'+fixture.viewport)).toBeNull();
  expect(s.invoke(fixture.viewport.split('\n').map(row=>'> '+row).join('\n'))).toBeNull();
  expect(s.invoke(fixture.viewport.replace('❯ 1. Yes','❯ 2. Yes'))).toBeNull();
  expect(s.invoke(fixture.viewport.replace('3. No','3. Maybe'))).toBeNull();
 }finally{s.dispose()}
});

test('the partial-line fixture and tests register only the Autoplan owner densely',()=>{
 const owner=E2E_TOUCHFILES['autoplan-chain-pty']!;
 expect(Object.keys(owner)).toHaveLength(owner.length);
 expect(Array.from(owner).every(x=>typeof x==='string')).toBe(true);
 for(const file of ['test/autoplan-edit-edges-an.test.ts','test/fixtures/autoplan-edit-edges-an.json'])
  expect(selectTests([file],E2E_TOUCHFILES,[]).selected).toEqual(['autoplan-chain-pty']);
});
