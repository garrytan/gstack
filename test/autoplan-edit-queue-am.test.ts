import {expect,test} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fixture from './fixtures/autoplan-edit-queue-am.json';
import * as permission from './helpers/autoplan-artifact-permission';
import {readPendingAutoplanArtifact} from './helpers/autoplan-artifact-recorder';
import {readPlanCountTranscript,type NativePublicToolEvent} from './helpers/plan-count-transcript';
import {E2E_TOUCHFILES,selectTests} from './helpers/touchfiles';

function setup(changeRecords?:(records:any[])=>void){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gstack-ap-queue-'));
 const cwd=path.join(dir,path.basename(fixture.cwd)),config=path.join(dir,'config');
 const stateRoot=path.join(dir,'gstack-hermetic-2101964-HvDZyN/skill-home-zgCNxG/.gstack');
 const replace=(text:string)=>text.replaceAll(fixture.stateRoot,stateRoot).replaceAll(fixture.cwd,cwd).replaceAll(fixture.config,config);
 const hook=JSON.parse(replace(JSON.stringify(fixture.hook)));
 const file=hook.pending.file,nativeFile=path.join(config,'projects','owned',hook.sessionId+'.jsonl');hook.pending.transcriptPath=nativeFile;
 fs.mkdirSync(cwd,{recursive:true});fs.mkdirSync(path.dirname(file),{recursive:true});fs.mkdirSync(path.dirname(nativeFile),{recursive:true});
 fs.writeFileSync(file,fixture.before);fs.utimesSync(file,new Date(fixture.now-1000000),new Date(Date.parse(hook.pending.timestamp)-1000));
 const events=JSON.parse(replace(JSON.stringify(fixture.publicTools))) as (NativePublicToolEvent & {messageId?:string;requestId?:string})[];
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

test('the actual active hook binds its published request amid later queued edits and both native prefix forms',()=>{
 const s=setup();try{
  expect(permission.autoplanArtifactPermissionInput(fixture.viewport,s.context,new Set())).toBeNull();
  expect(permission.pendingAutoplanArtifactPermissionInput(fixture.viewport,s.context,new Set())).toBeNull();
  expect(s.context.pending?.toolUseId).toBe(fixture.hook.pending.toolUseId);
  expect(s.invoke()?.signature).toBe(`${fixture.hook.sessionId}:${fixture.hook.pending.toolUseId}`);
  expect(s.invoke()?.file).toBe(s.file);
  expect(s.invoke()?.input).toBe('1\r');
 }finally{s.dispose()}
});

test('the default metadata-only reader continues excluding a published request',()=>{
 const s=setup();try{expect(readPendingAutoplanArtifact(s.hookFile,s.cwd,s.config,s.stateRoot,fixture.commandStartedAt,s.publicTools,fixture.now)).toBeUndefined();}finally{s.dispose()}
});

type Replay=ReturnType<typeof setup>;
const current=(s:Replay)=>s.context.publicTools.find(e=>e.kind==='use'&&e.toolUseId===fixture.hook.pending.toolUseId)!;
const queued=(s:Replay)=>s.context.publicTools.find(e=>e.kind==='use'&&e.toolUseId==='toolu_01SYiANcdq3hLqGxEhDQVNJf')!;
function rejects(cases:Array<[string,(s:Replay)=>void]>){
 for(const [name,change] of cases){const s=setup();try{change(s);expect(s.invoke(),name).toBeNull()}finally{s.dispose()}}
}

test('only exact native message and request identifiers establish queued membership',()=>{
 const s=setup();try{
  expect(current(s).messageId).toBe('msg_011CeuYDnRH9L1Qoom8gBVdc');
  expect(current(s).requestId).toBe('req_011CeuYDk9cAd6Yozh8QnH62');
  expect(queued(s).messageId).toBe(current(s).messageId);
 }finally{s.dispose()}
 for(const change of [
  (r:any)=>{delete r.message.id},(r:any)=>{delete r.requestId},
  (r:any)=>{r.message.id='quoted msg_example'},(r:any)=>{r.requestId='req_'+ 'a'.repeat(161)},
 ]){const s=setup(records=>{for(const r of records)if(r.message.content[0]?.id===fixture.hook.pending.toolUseId)change(r)});try{
  expect(current(s).messageId).toBeUndefined();expect(current(s).requestId).toBeUndefined();expect(s.invoke()).toBeNull();
 }finally{s.dispose()}}
});

test.each(['one native record','equal timestamps'])('ordered later blocks in %s remain queued behind the current hook',shape=>{
 const ids=['toolu_01SYiANcdq3hLqGxEhDQVNJf','toolu_01LgaibBToDfuxGNFBKew9PS','toolu_01VqJFXfD5cfdjiar1gAjpkV'];
 const s=setup(records=>{
  const active=records.find(r=>r.message.content[0]?.id===fixture.hook.pending.toolUseId)!;
  for(let i=records.length-1;i>=0;i--){const r=records[i];if(!ids.includes(r.message.content[0]?.id))continue;
   if(shape==='one native record'){active.message.content.splice(1,0,r.message.content[0]);records.splice(i,1)}
   else r.timestamp=active.timestamp;
  }
 });try{
  const active=current(s),remaining=s.publicTools.filter(e=>e.kind==='use'&&ids.includes(e.toolUseId));
  expect(remaining.map(e=>e.toolUseId)).toEqual(ids);
  expect(remaining.every(e=>e.timestamp===active.timestamp&&e.messageId===active.messageId&&e.requestId===active.requestId)).toBe(true);
  expect(s.invoke()?.signature).toBe(s.hook.sessionId+':'+s.hook.pending.toolUseId);
  // Moving a same-time unresolved block ahead of the current request is not a queued successor.
  const earlier=remaining[0]!,events=s.context.publicTools;events.splice(events.indexOf(earlier),1);events.splice(events.indexOf(active),0,earlier);
  expect(s.invoke()).toBeNull();
 }finally{s.dispose()}
});

test('another batch, session, path, tool, malformed edit or already hooked successor cannot be ignored',()=>{
 rejects([
  ['foreign message',s=>{queued(s).messageId='msg_other'}],
  ['foreign request',s=>{queued(s).requestId='req_other'}],
  ['missing message',s=>{delete queued(s).messageId}],
  ['foreign session',s=>{queued(s).sessionId='foreign'}],
  ['foreign file',s=>{queued(s).input!.file_path=s.file+'.other'}],
  ['queued Write',s=>{queued(s).name='Write'}],
  ['empty old request',s=>{queued(s).input!.old_string=''}],
  ['missing replacement',s=>{delete queued(s).input!.new_string}],
  ['replace all',s=>{queued(s).input!.replace_all=true}],
  ['already hooked',s=>{s.context.pending!.hookSeenIds!.push(queued(s).toolUseId)}],
  ['older unresolved',s=>{s.context.publicTools=s.context.publicTools.filter(e=>!(e.kind==='result'&&e.toolUseId==='toolu_01BbKwZ7JFFdm2FLFdcNQXPq'))}],
 ]);
});

test('current hook identity, completed or failed requests and ordering cannot be overridden',()=>{
 rejects([
  ['foreign pending',s=>{s.context.pending!.sessionId='foreign'}],
  ['wrong current hook',s=>{s.context.pending!.toolUseId=queued(s).toolUseId}],
  ['missing hook',s=>{s.context.pending=undefined}],
  ['missing tombstones',s=>{delete s.context.pending!.hookSeenIds}],
  ['duplicate tombstone',s=>{s.context.pending!.hookSeenIds!.push(fixture.hook.pending.toolUseId)}],
  ['unseen current',s=>{s.context.pending!.hookSeenIds=[]}],
  ['duplicate current',s=>{const at=s.context.publicTools.indexOf(current(s));s.context.publicTools.splice(at,0,structuredClone(current(s)))}],
  ['completion',s=>{s.context.publicTools.push({kind:'result',sessionId:s.hook.sessionId,toolUseId:current(s).toolUseId,timestamp:s.hook.pending.timestamp,isError:false})}],
  ['failure',s=>{s.context.publicTools.push({kind:'result',sessionId:s.hook.sessionId,toolUseId:current(s).toolUseId,timestamp:s.hook.pending.timestamp,isError:true})}],
  ['completed queued',s=>{s.context.publicTools.push({kind:'result',sessionId:s.hook.sessionId,toolUseId:queued(s).toolUseId,timestamp:s.hook.pending.timestamp,isError:false})}],
  ['failed queued',s=>{s.context.publicTools.push({kind:'result',sessionId:s.hook.sessionId,toolUseId:queued(s).toolUseId,timestamp:s.hook.pending.timestamp,isError:true})}],
  ['late predecessor completion',s=>{s.context.publicTools.at(-1)!.timestamp=new Date(Date.parse(s.hook.pending.timestamp)+1).toISOString()}],
  ['no successful predecessor',s=>{for(const e of s.context.publicTools)if(e.kind==='result')e.isError=true}],
  ['out of order',s=>{s.context.publicTools.reverse()}],
  ['future publication',s=>{queued(s).timestamp=new Date(fixture.now+1).toISOString()}],
 ]);
});

test('exact digest and current before file are required independently of the visible subset',()=>{
 rejects([
  ['missing digest',s=>{delete s.context.pending!.editDigest}],
  ['malformed digest',s=>{s.context.pending!.editDigest.version=2}],
  ['different request hash',s=>{s.context.pending!.editDigest.requestSHA256='0'.repeat(64)}],
  ['different before hash',s=>{s.context.pending!.editDigest.beforeSHA256='0'.repeat(64)}],
  ['different old lines',s=>{s.context.pending!.editDigest.oldLineHashes=['0'.repeat(64)]}],
  ['different new lines',s=>{s.context.pending!.editDigest.newLineHashes=['0'.repeat(64)]}],
  ['changed old request',s=>{current(s).input!.old_string+=' '}],
  ['changed replacement',s=>{current(s).input!.new_string+=' '}],
  ['missing current file',s=>{fs.unlinkSync(s.file)}],
  ['changed current file with old mtime',s=>{fs.writeFileSync(s.file,fixture.before+'\nChanged.');fs.utimesSync(s.file,new Date(0),new Date(0))}],
  ['file updated after hook',s=>{fs.utimesSync(s.file,new Date(fixture.now),new Date(fixture.now))}],
  ['stale viewport',s=>{s.context.viewportCapturedAt=Date.parse(s.hook.pending.timestamp)-1}],
  ['stale hook',s=>{s.context.pending!.timestamp=new Date(fixture.commandStartedAt-1).toISOString()}],
  ['future viewport',s=>{s.context.viewportCapturedAt=fixture.now+1}],
  ['unavailable native',s=>{s.context.transcriptStatus='missing'}],
 ]);
 const s=setup();try{
  expect(s.invoke(fixture.viewport,s.context,new Set([s.hook.sessionId+':'+s.hook.pending.toolUseId]))).toBeNull();
  expect(s.invoke(fixture.viewport,s.context,new Set([permission.autoplanArtifactMenuKey(fixture.viewport)]))).toBeNull();
 }finally{s.dispose()}
});

test('invalid, busy, foreign or ambiguous persisted hook state supplies no current authority',()=>{
 for(const change of [
  (s:Replay)=>{fs.writeFileSync(s.hookFile+'.invalid','{"reason":"conflicting_replay"}')},
  (s:Replay)=>{fs.writeFileSync(s.hookFile+'.lock','')},
  (s:Replay)=>{s.hook.pending.transcriptPath=path.join(s.dir,'foreign.jsonl');fs.writeFileSync(s.hookFile,JSON.stringify(s.hook))},
  (s:Replay)=>{s.hook.pending.hookSeenIds=[];fs.writeFileSync(s.hookFile,JSON.stringify(s.hook))},
 ]){const s=setup();try{change(s);expect(readPendingAutoplanArtifact(s.hookFile,s.cwd,s.config,s.stateRoot,fixture.commandStartedAt,s.publicTools,fixture.now,true)).toBeUndefined()}finally{s.dispose()}}
});

test('existing prefix forms compose but cannot hide a competing title, source or malformed current panel',()=>{
 const s=setup();try{
  const first=fixture.viewport.indexOf('● Update('),screen=fixture.viewport.slice(first);
  const titles=screen.match(/^● Update\([^\n]+\)\n/gm)!;
  expect(titles).toHaveLength(4);
  expect(s.invoke(screen)?.input).toBe('1\r');
  expect(s.invoke('\n\n'+screen)?.input).toBe('1\r');
  expect(s.invoke(fixture.viewport.replaceAll(titles[0]!,''))).toBeNull(); // A completed prefix still needs its current tool boundary.
  expect(s.invoke(screen.slice(screen.indexOf('────────────────')))?.input).toBe('1\r');
  let one=screen;for(let n=0;n<3;n++)one=one.replace(titles[0]!,'');
  expect(s.invoke(one.trimStart())?.input).toBe('1\r');
  for(const [name,changed] of [
   ['foreign first title',fixture.viewport.replace(titles[0]!,titles[0]!.replace('user-dashboard.md','foreign.md'))],
   ['quoted whole pane',fixture.viewport.split('\n').map(row=>'> '+row).join('\n')],
   ['source prefix','Example:\n'+fixture.viewport],
   ['arbitrary indented prose','      This is an example.\n'+fixture.viewport],
   ['competing completed panel','● Update(/tmp/foreign.md)\n'+fixture.viewport],
   ['broken wrap kind',fixture.viewport.replace(/^         \+/m,'         -')],
   ['foreign displayed path',fixture.viewport.replace('…2101964-HvDZyN','…foreign')],
   ['wrong menu target',fixture.viewport.replace('user-dashboard.md?','foreign.md?')],
   ['persistent edit mode',fixture.viewport.replace('❯ 1. Yes','❯ 2. Yes')],
   ['malformed no',fixture.viewport.replace('3. No','3. Maybe')],
   ['changed addition',fixture.viewport.replace(/^( {0,3}\d+ \+).*/m,'$1A different current edit')],
  ])expect(s.invoke(changed),name).toBeNull();
 }finally{s.dispose()}
});

test('the new queue regression files select only the Autoplan owner with dense registration',()=>{
 const owner=E2E_TOUCHFILES['autoplan-chain-pty']!;
 for(let i=0;i<owner.length;i++){expect(Object.hasOwn(owner,i)).toBe(true);expect(typeof owner[i]).toBe('string')}
 for(const file of ['test/autoplan-edit-queue-am.test.ts','test/fixtures/autoplan-edit-queue-am.json'])
  expect(selectTests([file],E2E_TOUCHFILES,[]).selected).toEqual(['autoplan-chain-pty']);
});
