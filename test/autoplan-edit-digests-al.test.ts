import {test,expect,afterEach} from 'bun:test';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
import fixture from './fixtures/autoplan-edit-digests-al.json';
import {createAutoplanArtifactRecorder,recordAutoplanArtifact,readPendingAutoplanArtifact,autoplanArtifactRecorderStatus} from './helpers/autoplan-artifact-recorder';
import {pendingAutoplanArtifactPermissionInput,autoplanArtifactMenuKey} from './helpers/autoplan-artifact-permission';
import {createAutoplanEditDigest,validAutoplanEditDigest,autoplanEditLineHash} from './helpers/autoplan-artifact-digest';
import type {NativePublicToolEvent} from './helpers/plan-count-transcript';
import {E2E_TOUCHFILES,selectTests} from './helpers/touchfiles';
const cleanups:Array<()=>void>=[];afterEach(()=>{for(const cleanup of cleanups.splice(0))cleanup()});
function replay(record=true) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ap-digest-')),cwd=path.join(root,path.basename(fixture.cwd)),ownedStateRoot=path.join(root,'home','.gstack'),config=path.join(root,'config');
 const file=fixture.pending.file.replace(fixture.ownedStateRoot,ownedStateRoot),transcript=path.join(config,'projects','owned',fixture.pending.sessionId+'.jsonl');
 fs.mkdirSync(cwd,{recursive:true});fs.mkdirSync(path.dirname(file),{recursive:true});fs.mkdirSync(path.dirname(transcript),{recursive:true});fs.writeFileSync(file,fixture.before);fs.writeFileSync(transcript,'');
 const old=new Date(Date.parse(fixture.pending.timestamp)-1000);fs.utimesSync(file,old,old);
 const recorder=createAutoplanArtifactRecorder(cwd,config,ownedStateRoot);cleanups.push(()=>{recorder.dispose();fs.rmSync(root,{recursive:true,force:true})});
 const event={hook_event_name:'PreToolUse',tool_name:'Edit',session_id:fixture.pending.sessionId,tool_use_id:fixture.pending.toolUseId,cwd,transcript_path:transcript,tool_input:{file_path:file,...fixture.reconstructedRequest}};
 const history=structuredClone(fixture.events) as NativePublicToolEvent[];for(const e of history)if(e.input?.file_path===fixture.pending.file)e.input.file_path=file;
 const startedAt=Date.parse(history[0]!.timestamp)-1;
 if(record)recordAutoplanArtifact(JSON.stringify(event),recorder.file,cwd,config,ownedStateRoot);
 const pending=readPendingAutoplanArtifact(recorder.file,cwd,config,ownedStateRoot,startedAt,history);
 const context={cwd,ownedStateRoot,commandStartedAt:startedAt,transcriptStatus:'ready',publicTools:history,pending,viewportCapturedAt:Date.now(),now:Date.now()+1000};
 return {root,file,config,recorder,event,context,viewport:fixture.viewport};
}
const pick=(r:ReturnType<typeof replay>,seen=new Set<string>())=>pendingAutoplanArtifactPermissionInput(r.viewport,r.context,seen);
test('actual added-only three-digit pane rejects without request digests, accepts a separately recorded reconstructed insertion',()=>{
 const r=replay();expect(r.context.pending?.editDigest).toBeDefined();expect(pick(r)?.input).toBe('1\r');
 delete r.context.pending!.editDigest;expect(pick(r)).toBeNull();
 expect(fixture.provenance.reconstruction).toContain('not the original');
});
test('hook persists bounded digests from its input, never request or result text',()=>{
 const r=replay(false),hook=r.recorder.hooks.PreToolUse[0]!.hooks[0]!;
 const child=spawnSync('bash',['-c',hook.command],{input:JSON.stringify({...r.event,tool_response:'PRIVATE_RESULT_SENTINEL'}),encoding:'utf8',timeout:6000});
 expect(child.status).toBe(0);expect(child.stdout).toBe('');expect(child.stderr).toBe('');
 const raw=fs.readFileSync(r.recorder.file,'utf8'),state=JSON.parse(raw);expect(validAutoplanEditDigest(state.pending.editDigest)).toBe(true);
 for(const secret of ['old_string','new_string','PRIVATE_RESULT_SENTINEL','Owner: the user.','Toast stacking ahead'])expect(raw).not.toContain(secret);
 expect(state.pending.editDigest).toEqual(createAutoplanEditDigest(r.file,r.event.tool_input.old_string,r.event.tool_input.new_string));
 expect(fs.statSync(r.recorder.file).size).toBeLessThan(1024*1024);expect(fs.statSync(r.recorder.file).mode&0o777).toBe(0o600);
 const legacy=structuredClone(state);delete legacy.pending.editDigest.clippedAdditions;
 expect(Buffer.byteLength(JSON.stringify(legacy))).toBeLessThan(64*1024);
});
test('digests of a different request cannot authorize the displayed additions',()=>{
 const r=replay();r.context.pending!.editDigest=createAutoplanEditDigest(r.file,'Owner: the user.\n','Owner: the user.\nDifferent requested insertion.\n')!;expect(pick(r)).toBeNull();
 r.context.pending!.editDigest=createAutoplanEditDigest(r.file,r.event.tool_input.old_string,r.event.tool_input.new_string)!;
 r.context.pending!.editDigest.newLineHashes=r.context.pending!.editDigest.oldLineHashes;expect(pick(r)).toBeNull();
});
test('current file hash, native identity, predecessor and single use stay required',()=>{
 const mutations:Array<(r:ReturnType<typeof replay>)=>void>=[
 r=>{r.context.pending!.sessionId='foreign';},r=>{r.context.pending!.file=path.join(r.root,'foreign.md');},
 r=>{r.context.pending!.editDigest!.beforeSHA256='0'.repeat(64);},
 r=>{fs.writeFileSync(r.file,fixture.before+'Changed concurrently.');const old=new Date(0);fs.utimesSync(r.file,old,old);},
 r=>{r.context.pending!.timestamp=new Date(r.context.now+1000).toISOString();},r=>{r.context.viewportCapturedAt=Date.parse(r.context.pending!.timestamp)-1;},
 r=>{r.context.commandStartedAt=r.context.now+1;},r=>{r.context.publicTools[1]!.isError=true;},r=>{r.context.publicTools=[];},
 r=>{r.context.publicTools.push({kind:'result',sessionId:r.context.pending!.sessionId,toolUseId:r.context.pending!.toolUseId,timestamp:new Date(r.context.now).toISOString(),isError:false});},
 r=>{r.context.publicTools.push({kind:'use',name:'Write',sessionId:r.context.pending!.sessionId,toolUseId:'successor',timestamp:new Date(r.context.now).toISOString(),input:{file_path:r.file}});},
 ];for(const change of mutations){const r=replay();change(r);expect(pick(r)).toBeNull()}
 const r=replay();expect(pick(r,new Set([r.context.pending!.sessionId+':'+r.context.pending!.toolUseId]))).toBeNull();expect(pick(r,new Set([autoplanArtifactMenuKey(r.viewport)]))).toBeNull();
});
test('exact three-digit marker column rejects wrong gutters, arbitrary source rows and malformed numbering',()=>{
 for(const change of [
 (s:string)=>s.replace(/^     \+/m,'    +'),(s:string)=>s.replace(/^     \+/m,'      +'),
 (s:string)=>s.replace(/^     \+/m,'     Source: '),(s:string)=>'> quoted example\n'+s,
 (s:string)=>s.replace(/^ 140 /m,'   0 '),(s:string)=>s.replace(/^ 141 /m,' 139 '),
 (s:string)=>s.replace(/^ 140 /m,' 999999999999999999999 '),(s:string)=>s.replace(/^ 140 \+/m,' 140 -'),
 (s:string)=>s.replace('3. No','3. Maybe'),(s:string)=>s.replace('❯ 1. Yes','❯ 2. Yes'),
 (s:string)=>s.replace('2026-09-10-user-dashboard.md?','foreign.md?'),(s:string)=>s+'\nUnrelated prompt',
 ]){const r=replay();r.viewport=change(r.viewport);expect(pick(r)).toBeNull()}
});
test('four-space continuation is accepted only with the matching two-digit numbered gutter',()=>{
 const r=replay();r.viewport=r.viewport.replace(/^ (1[4][0-9]) /gm,(_,n)=>' '+(Number(n)-130)+' ').replace(/^     ([+ -])/gm,'    $1');expect(pick(r)?.input).toBe('1\r');
});
test('original or context rows cannot supply insertion authority',()=>{
 const r=replay(),menu=r.viewport.slice(r.viewport.indexOf('╌'));
 r.context.pending!.editDigest=createAutoplanEditDigest(r.file,'Owner: the user.\n','Owner: the user.\nNew actual request.\n')!;
 r.viewport=' 140 +Owner: the user.\n 141 +Owner: the user.\n'+menu;expect(pick(r)).toBeNull();
 r.viewport=' 140  Owner: the user.\n 141  Owner: the user.\n'+menu;expect(pick(r)).toBeNull();
});
test('malformed, sparse and high-volume persisted digest records fail closed',()=>{
 for(const change of [(d:any)=>{d.version=2},(d:any)=>{d.extra='text'},(d:any)=>{d.beforeSHA256='bad'},(d:any)=>{d.newLineHashes=[]},(d:any)=>{d.newLineHashes=Array(513).fill('a'.repeat(64))},(d:any)=>{d.oldLineHashes[0]=null}]){
  const r=replay(),s=JSON.parse(fs.readFileSync(r.recorder.file,'utf8'));change(s.pending.editDigest);fs.writeFileSync(r.recorder.file,JSON.stringify(s));expect(autoplanArtifactRecorderStatus(r.recorder.file,r.context.cwd,r.config,r.context.ownedStateRoot).status).toBe('invalid');
  r.context.pending!.editDigest=s.pending.editDigest;expect(pick(r)).toBeNull();
 }
 const r=replay(),sparse={...r.context.pending!.editDigest!,newLineHashes:Array(2)};expect(validAutoplanEditDigest(sparse)).toBe(false);
});
test('unavailable or oversized before/request data yields no new digest authority',()=>{
 const r=replay();expect(createAutoplanEditDigest(r.file,'missing original','new')).toBeUndefined();expect(createAutoplanEditDigest(r.file,'Owner: the user.\n','x\n'.repeat(513))).toBeUndefined();
 const link=path.join(r.root,'linked');fs.symlinkSync(r.file,link);expect(createAutoplanEditDigest(link,r.event.tool_input.old_string,r.event.tool_input.new_string)).toBeUndefined();
 fs.writeFileSync(r.file,'x'.repeat(1024*1024+1));expect(createAutoplanEditDigest(r.file,'x','new')).toBeUndefined();fs.unlinkSync(r.file);expect(createAutoplanEditDigest(r.file,'old','new')).toBeUndefined();
});
test('normalization joins display wrapping but keeps changed nonwhitespace bytes distinct',()=>{
 expect(autoplanEditLineHash('same  body\t')).toBe(autoplanEditLineHash('samebody'));expect(autoplanEditLineHash('same body')).not.toBe(autoplanEditLineHash('different body'));
 const r=replay();r.viewport=r.viewport.replace('Toast stacking','Toast stacKING');expect(pick(r)).toBeNull();
});
test('only Autoplan owns the new digest helper and regression evidence',()=>{
 const owner=E2E_TOUCHFILES['autoplan-chain-pty']!;for(let i=0;i<owner.length;i++){expect(Object.hasOwn(owner,i)).toBe(true);expect(typeof owner[i]).toBe('string');}
 for(const file of ['test/helpers/autoplan-artifact-digest.ts','test/autoplan-edit-digests-al.test.ts','test/fixtures/autoplan-edit-digests-al.json'])expect(selectTests([file],E2E_TOUCHFILES,[]).selected).toEqual(['autoplan-chain-pty']);
});
test('identical pending hook replay cannot refresh digest or timestamp',()=>{
 const r=replay(),before=fs.readFileSync(r.recorder.file,'utf8');recordAutoplanArtifact(JSON.stringify(r.event),r.recorder.file,r.context.cwd,r.config,r.context.ownedStateRoot);expect(fs.readFileSync(r.recorder.file,'utf8')).toBe(before);
});
test.each(['changed-new','changed-old','whitespace-only','missing-input','over-limit','replace-all','before-file'])('same pending identity with %s invalidates prior digest authority',kind=>{
 const r=replay(),e=structuredClone(r.event) as any;
 if(kind==='changed-new')e.tool_input.new_string+='A different final action.\n';
 if(kind==='changed-old')e.tool_input.old_string='Owner: the user.';
 if(kind==='whitespace-only')e.tool_input.new_string=e.tool_input.new_string.replace('Owner: the user.','Owner:  the user.');
 if(kind==='missing-input')delete e.tool_input.new_string;
 if(kind==='over-limit')e.tool_input.new_string='new\n'.repeat(513);
 if(kind==='replace-all')e.tool_input.replace_all=true;
 if(kind==='before-file')fs.writeFileSync(r.file,fixture.before+'Unobserved change.');
 recordAutoplanArtifact(JSON.stringify(e),r.recorder.file,r.context.cwd,r.config,r.context.ownedStateRoot);
 expect(autoplanArtifactRecorderStatus(r.recorder.file,r.context.cwd,r.config,r.context.ownedStateRoot)).toEqual({status:'invalid',reason:'conflicting_replay'});
 expect(readPendingAutoplanArtifact(r.recorder.file,r.context.cwd,r.config,r.context.ownedStateRoot,r.context.commandStartedAt,r.context.publicTools,r.context.now)).toBeUndefined();
});

// Synthetic legacy crops use the actual generated PreToolUse subprocess. They
// preserve the frozen deletion/context policy, not new insertion-only authority.
test.each([
 {name:'leading partial deletion',rows:['    -full line',' 11 -Old second',' 12 +New replacement'],removed:'First original full line\nOld second',added:'New replacement'},
 {name:'leading partial context',rows:['     full line',' 11 -Old second',' 12 +New replacement'],removed:'Old second',added:'New replacement'},
 {name:'deletion-only rows',rows:[' 10 -First original full line',' 11 -Old second',' 12  Context'],removed:'First original full line\nOld second\n',added:''},
 {name:'old/new line numbering reset',rows:[' 10 -First original full line',' 11 -Old second',' 10 +New first',' 11 +New second',' 12  Context'],removed:'First original full line\nOld second',added:'New first\nNew second'},
])('recording a digest preserves an owned legacy $name crop',c=>{
 const r=replay(false),before='First original full line\nOld second\nContext\n';
 fs.writeFileSync(r.file,before);const old=new Date(Date.parse(fixture.pending.timestamp)-1000);fs.utimesSync(r.file,old,old);
 for(const e of r.context.publicTools)if(e.name==='Write'&&e.input?.file_path===r.file)e.input.content=before;
 r.event.tool_input.old_string=c.removed;r.event.tool_input.new_string=c.added;
 const child=spawnSync('bash',['-c',r.recorder.hooks.PreToolUse[0]!.hooks[0]!.command],{input:JSON.stringify(r.event),encoding:'utf8',timeout:6000});
 expect(child.status).toBe(0);expect(child.stdout).toBe('');expect(child.stderr).toBe('');
 r.context.pending=readPendingAutoplanArtifact(r.recorder.file,r.context.cwd,r.config,r.context.ownedStateRoot,r.context.commandStartedAt,r.context.publicTools);
 r.context.viewportCapturedAt=Date.now();r.context.now=Date.now()+1000;
 const menu=r.viewport.slice(r.viewport.indexOf('Do you want to make this edit'));
 r.viewport=c.rows.join('\n')+'\n'+'╌'.repeat(20)+'\n'+menu;
 expect(validAutoplanEditDigest(r.context.pending?.editDigest)).toBe(true);
 const digest=structuredClone(r.context.pending!.editDigest!);
 expect(pick(r)?.input).toBe('1\r');
 delete r.context.pending!.editDigest;expect(pick(r)?.input).toBe('1\r');
 r.context.pending!.editDigest={...digest,beforeSHA256:'0'.repeat(64)};expect(pick(r)).toBeNull();
 r.context.pending!.editDigest={...digest,beforeSHA256:'malformed'};expect(pick(r)).toBeNull();
 r.context.pending!.editDigest=digest;
 const viewport=r.viewport;r.viewport=r.viewport.replace(/^((?: {0,3}\d+ | {4})-).*$/gm,'$1Foreign unowned deletion');expect(pick(r)).toBeNull();r.viewport=viewport;
 // The digest's request ownership remains binding through the legacy crop path.
 r.context.pending!.editDigest={...digest,oldLineHashes:[autoplanEditLineHash('Context')]};expect(pick(r)).toBeNull();
 r.context.pending!.editDigest=digest;
 if(c.rows.some(row=>/^[ ]*\d+ \+/.test(row))){
  r.viewport=viewport.replace(/^([ ]*\d+ \+).*$/gm,'$1Context');expect(pick(r)).toBeNull();r.viewport=viewport;
 }
 if(c.name==='leading partial deletion'){
  r.viewport=viewport.replace('    -full line','    -Context');expect(pick(r)).toBeNull();r.viewport=viewport;
 }
 if(c.name==='leading partial context'){
  r.viewport=viewport.replace('     full line','    +full line');expect(pick(r)).toBeNull();r.viewport=viewport;
 }
 fs.unlinkSync(r.file);expect(pick(r)).toBeNull();
});
