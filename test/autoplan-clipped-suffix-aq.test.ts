import {test,expect,afterEach} from 'bun:test';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import fixture from './fixtures/autoplan-clipped-suffix-aq.json';
import {createAutoplanEditDigest,validAutoplanEditDigest,matchesAutoplanDigestRows} from './helpers/autoplan-artifact-digest';
import {createAutoplanArtifactRecorder,recordAutoplanArtifact,readPendingAutoplanArtifact,autoplanArtifactRecorderStatus} from './helpers/autoplan-artifact-recorder';
import {pendingAutoplanArtifactPermissionInput,autoplanArtifactMenuKey} from './helpers/autoplan-artifact-permission';
import {E2E_TOUCHFILES} from './helpers/touchfiles-data';
const cleanup:Array<()=>void>=[];afterEach(()=>{for(const f of cleanup.splice(0))f()});
function replay(before=fixture.before,removed=fixture.request.old_string,added=fixture.request.new_string){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ap-suffix-')),cwd=path.join(root,path.basename(fixture.cwd)),config=path.join(root,'config'),stateRoot=path.join(root,'home/.gstack');
 const file=fixture.hook.pending.file.replace(fixture.stateRoot,stateRoot),native=path.join(config,'projects/owned',fixture.hook.sessionId+'.jsonl');
 fs.mkdirSync(cwd,{recursive:true});fs.mkdirSync(path.dirname(file),{recursive:true});fs.mkdirSync(path.dirname(native),{recursive:true});fs.writeFileSync(native,'');fs.writeFileSync(file,before);fs.utimesSync(file,new Date(0),new Date(0));
 const recorder=createAutoplanArtifactRecorder(cwd,config,stateRoot);cleanup.push(()=>{recorder.dispose();fs.rmSync(root,{recursive:true,force:true})});
 const event={hook_event_name:'PreToolUse',tool_name:'Edit',session_id:fixture.hook.sessionId,tool_use_id:fixture.hook.pending.toolUseId,cwd,transcript_path:native,tool_input:{file_path:file,old_string:removed,new_string:added}};
 recordAutoplanArtifact(JSON.stringify(event),recorder.file,cwd,config,stateRoot);
 const publicTools=structuredClone(fixture.publicTools) as any[];for(const e of publicTools)if(e.input)e.input.file_path=file;
 const commandStartedAt=Date.parse(publicTools[0].timestamp)-1;
 const pending=readPendingAutoplanArtifact(recorder.file,cwd,config,stateRoot,commandStartedAt,publicTools);
 const context={cwd,ownedStateRoot:stateRoot,commandStartedAt,transcriptStatus:'ready',publicTools,pending,now:Date.now()+1000,viewportCapturedAt:Date.now()};
 const invoke=(viewport=fixture.viewport,seen=new Set<string>())=>pendingAutoplanArtifactPermissionInput(viewport,context,seen);
 return {root,cwd,config,stateRoot,file,recorder,event,context,invoke};
}
const menu=fixture.viewport.slice(fixture.viewport.indexOf('╌'));
const panel=(rows:string[])=>rows.join('\n')+'\n'+menu;
test('exact current clipped pane requires new recorded suffix commitments and preserves original request bytes',()=>{
 const r=replay(),digest=r.context.pending!.editDigest!;
 expect(digest.beforeSHA256).toBe(fixture.provenance.beforeSHA256);expect(digest.requestSHA256).toBe(fixture.provenance.requestSHA256);
 expect(digest.oldLineHashes).toEqual(fixture.hook.pending.editDigest.oldLineHashes);expect(digest.newLineHashes).toEqual(fixture.hook.pending.editDigest.newLineHashes);
 expect(digest.clippedAdditions?.status).toBe('complete');expect(r.invoke()?.input).toBe('1\r');
 delete digest.clippedAdditions;expect(r.invoke()).toBeNull();expect(r.invoke(fixture.viewport.split('\n').slice(1).join('\n'))?.input).toBe('1\r');
 expect(fixture.provenance.actualCoverage).toContain('no phase credit');
});
test('first, middle and last changed lines support full120-column crops and following context',()=>{
 const lines=Array.from({length:32},(_,i)=>'Line '+i+' '+String.fromCharCode(65+i%26).repeat(180));
 const r=replay('Heading\nAnchor\nAfter one\nAfter two\n','Anchor',lines.join('\n'));
 expect(r.context.pending!.editDigest!.clippedAdditions?.status).toBe('complete');
 for(const i of [0,15,31]){
  const row=i+2,tail=lines[i]!.slice(-114),next=i+1<lines.length?`${row+1} +${lines[i+1]}`:`${row+1}  After one`,second=i+2<lines.length?`${row+2} +${lines[i+2]}`:`${row+2}  ${i+1<lines.length?'After one':'After two'}`;
  const column=String(row+1).length+2;
  const viewport=panel([' '.repeat(column)+'+'+tail,' '+next,' '+second]);
  expect(r.invoke(viewport)?.input).toBe('1\r');expect(r.invoke(viewport.replace(tail,'foreign'+tail))).toBeNull();
 }
 expect(fs.statSync(r.recorder.file).size).toBeLessThan(1024*1024);
});
test('exact suffix, corresponding line, next line and complete crop content are all mandatory',()=>{
 for(const change of [
  (s:string)=>s.replace(/^     \+t\./,'     +x.'), (s:string)=>s.replace(/^     \+t\./,'     +t!'),
  (s:string)=>s.replace(/^     \+t\./,'    +t.'),(s:string)=>s.replace(/^     \+t\./,'      +t.'),
  (s:string)=>s.replace(/^     \+t\./,'     -t.'),(s:string)=>s.replace(/^     \+t\./,'     Source: t.'),
  (s:string)=>s.replace(/^ 139 /m,' 140 '),(s:string)=>s.replace('Snapshot consistency','Foreign consistency'),
  (s:string)=>s.replace('authoritative gate','unrequested gate'),(s:string)=>'> source\n'+s,
  (s:string)=>s.replace('3. No','3. Maybe'),(s:string)=>s.replace('❯ 1. Yes','❯ 2. Yes'),
  (s:string)=>s+'\nUnrelated menu',
 ]){const r=replay();expect(r.invoke(change(fixture.viewport))).toBeNull()}
});
test('wrong digest, file, current native history and previously seen menu remain denied',()=>{
 for(const edit of [
  (r:any)=>{r.context.pending.sessionId='foreign';},(r:any)=>{r.context.pending.editDigest.beforeSHA256='0'.repeat(64);},
  (r:any)=>{r.context.pending.editDigest.clippedAdditions.lines[0].lineHash='0'.repeat(64);},
  (r:any)=>{r.context.publicTools[1].isError=true;},(r:any)=>{r.context.publicTools=[];},
  (r:any)=>{r.context.viewportCapturedAt=Date.parse(r.context.pending.timestamp)-1;},
  (r:any)=>{fs.appendFileSync(r.file,'changed');fs.utimesSync(r.file,new Date(0),new Date(0));},
  (r:any)=>{r.context.pending.file=r.file.replace('user-dashboard','foreign-dashboard');},
  (r:any)=>{r.context.publicTools.push({kind:'use',name:'Edit',sessionId:r.context.pending.sessionId,toolUseId:'queued',timestamp:new Date().toISOString(),input:{file_path:r.file}});},
 ]){const r=replay();edit(r);expect(r.invoke()).toBeNull()}
 const r=replay();expect(r.invoke(fixture.viewport,new Set([autoplanArtifactMenuKey(fixture.viewport)]))).toBeNull();expect(r.invoke(fixture.viewport,new Set([r.context.pending!.sessionId+':'+r.context.pending!.toolUseId]))).toBeNull();
});
test('suffix commitments are not body persistence and current replay cannot retain stale hashes',()=>{
 const r=replay(),raw=fs.readFileSync(r.recorder.file,'utf8');for(const text of ['old_string','new_string','Preconditions heading','Snapshot consistency'])expect(raw).not.toContain(text);
 recordAutoplanArtifact(JSON.stringify(r.event),r.recorder.file,r.cwd,r.config,r.stateRoot);expect(fs.readFileSync(r.recorder.file,'utf8')).toBe(raw);
 r.event.tool_input.new_string+='changed';recordAutoplanArtifact(JSON.stringify(r.event),r.recorder.file,r.cwd,r.config,r.stateRoot);
 expect(autoplanArtifactRecorderStatus(r.recorder.file,r.cwd,r.config,r.stateRoot)).toEqual({status:'invalid',reason:'conflicting_replay'});
});
test('legacy digest replay is harmless and partial-edge requests do not manufacture suffix authority',()=>{
 const r=replay(),state=JSON.parse(fs.readFileSync(r.recorder.file,'utf8'));delete state.pending.editDigest.clippedAdditions;
 fs.writeFileSync(r.recorder.file,JSON.stringify(state)+'\n');const raw=fs.readFileSync(r.recorder.file,'utf8');recordAutoplanArtifact(JSON.stringify(r.event),r.recorder.file,r.cwd,r.config,r.stateRoot);expect(fs.readFileSync(r.recorder.file,'utf8')).toBe(raw);
 const q=replay('Prefix Anchor suffix\nAfter one\nAfter two\n','Anchor','New');expect(q.context.pending!.editDigest!.clippedAdditions).toBeUndefined();
});
test('malformed, sparse, tampered and excessive suffix records fail closed',()=>{
 for(const edit of [
  (c:any)=>{c.version=2;},(c:any)=>{c.extra=true;},(c:any)=>{c.startLine=0;},(c:any)=>{c.lines=Array(2);},
  (c:any)=>{c.lines[0].suffixHashes=Array(2);},(c:any)=>{c.lines[0].suffixHashes=Array(257).fill('0'.repeat(64));},
  (c:any)=>{c.lines[0].nextLineHash='0'.repeat(64);},(c:any)=>{c.lines[0].line++;},
 ]){const r=replay(),d=r.context.pending!.editDigest!;edit(d.clippedAdditions);expect(validAutoplanEditDigest(d)).toBe(false);expect(r.invoke()).toBeNull()}
 const r=replay(),c=r.context.pending!.editDigest!.clippedAdditions;if(c?.status!=='complete')throw Error('missing');const target=c.lines.find(x=>x.line===138)!;target.suffixHashes[1]='0'.repeat(64);expect(r.invoke()).toBeNull();
});
test('overflow is explicit for every crop while complete-row legacy authority remains intact',()=>{
 const lines=Array.from({length:40},(_,i)=>'Line '+i+' '+String.fromCharCode(65+i%26).repeat(300));const r=replay('Anchor\nAfter one\nAfter two\n','Anchor',lines.join('\n'));const d=r.context.pending!.editDigest!;
 expect(d.clippedAdditions).toEqual({version:1,status:'overflow'});expect(validAutoplanEditDigest(d)).toBe(true);
 for(const i of [0,20,39]){const n=i+1,next=i+1<lines.length?lines[i+1]:'After one',last=i+2<lines.length?lines[i+2]:'After two';expect(matchesAutoplanDigestRows([' '.repeat(String(n+1).length+2)+'+'+lines[i]!.slice(-114),` ${n+1} +${next}`,` ${n+2} +${last}`],Buffer.from('Anchor\nAfter one\nAfter two\n'),d)).toBe(false)}
 expect(matchesAutoplanDigestRows([' 1 +'+lines[0],' 2 +'+lines[1]],Buffer.from('Anchor\nAfter one\nAfter two\n'),d)).toBe(true);
});
test('new regression files register only the actual Autoplan owner',()=>{
 for(const p of ['test/autoplan-clipped-suffix-aq.test.ts','test/fixtures/autoplan-clipped-suffix-aq.json'])expect(Object.entries(E2E_TOUCHFILES).filter(([,files])=>files.includes(p)).map(([owner])=>owner)).toEqual(['autoplan-chain-pty']);
});
