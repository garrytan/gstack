import {expect,test} from 'bun:test';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import fixture from './fixtures/autoplan-rendered-batch-at.json';
import * as permission from './helpers/autoplan-artifact-permission';
import {readPendingAutoplanArtifact} from './helpers/autoplan-artifact-recorder';
import {readPlanCountTranscript,type NativePublicToolEvent} from './helpers/plan-count-transcript';
import {E2E_TOUCHFILES,selectTests} from './helpers/touchfiles';
function replay(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gstack-ap-batch-')),old=path.dirname(path.dirname(fixture.stateRoot));
 const runtime=path.join(root,path.basename(old)),cwd=path.join(root,path.basename(fixture.cwd));
 const replace=(s:string)=>s.replaceAll(old,runtime).replaceAll(fixture.cwd,cwd);
 const hook=JSON.parse(replace(JSON.stringify(fixture.hook))),stateRoot=replace(fixture.stateRoot),config=replace(fixture.config),file=hook.pending.file;
 const events=JSON.parse(replace(JSON.stringify(fixture.publicTools))) as NativePublicToolEvent[];
 const now=Date.parse(fixture.viewportCapturedAt),startedAt=Date.parse(fixture.commandStartedAt);
 fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,fixture.before,{mode:0o644});
 const mtime=Number(BigInt(fixture.targetStat.mtimeNs))/1e9;fs.utimesSync(file,mtime,mtime);fs.mkdirSync(cwd,{recursive:true});fs.mkdirSync(path.dirname(hook.pending.transcriptPath),{recursive:true});
 const records=events.map(e=>({sessionId:e.sessionId,cwd,isSidechain:false,timestamp:e.timestamp,requestId:e.requestId,message:{id:e.messageId,role:e.kind==='use'?'assistant':'user',content:e.kind==='use'?[{type:'tool_use',id:e.toolUseId,name:e.name,input:e.input}]:[{type:'tool_result',tool_use_id:e.toolUseId,content:e.content??'',is_error:e.isError}]}}));
 fs.writeFileSync(hook.pending.transcriptPath,records.map(e=>JSON.stringify(e)).join('\n')+'\n');const hookFile=path.join(root,'hook.json');fs.writeFileSync(hookFile,JSON.stringify(hook));
 const publicTools:NativePublicToolEvent[]=[];const transcript=readPlanCountTranscript(config,cwd,e=>publicTools.push(e));const pending=readPendingAutoplanArtifact(hookFile,cwd,config,stateRoot,startedAt,publicTools,now,true);
 const context={cwd,ownedStateRoot:stateRoot,ownedNativePlansRoot:path.join(config,'plans'),commandStartedAt:startedAt,now,viewportCapturedAt:now,transcriptStatus:transcript.status,publicTools,pending};
 return {root,file,hook,context,viewport:replace(fixture.viewport),dispose:()=>fs.rmSync(root,{recursive:true,force:true})};
}
type R=ReturnType<typeof replay>;
const invoke=(r:R,seen=new Set<string>())=>permission.publishedAutoplanArtifactPermissionInput(r.viewport,r.context,seen);
const current=(r:R)=>r.context.publicTools.find(e=>e.kind==='use'&&e.toolUseId===r.hook.pending.toolUseId)!;
const queued=(r:R)=>r.context.publicTools.filter(e=>e.kind==='use'&&e.name==='Edit'&&e!==current(r)&&!r.context.publicTools.some(x=>x.kind==='result'&&x.toolUseId===e.toolUseId));
const waiting=(r:R)=>r.context.publicTools.find(e=>e.kind==='use'&&e.name==='Bash')!;
const previous=(r:R)=>r.context.publicTools.find(e=>e.kind==='use'&&e.toolUseId==='toolu_0199q2iK6Pa1xTqiZGNqq81u')!;
const complete=(r:R,e:NativePublicToolEvent,isError=false)=>r.context.publicTools.push({kind:'result',sessionId:e.sessionId,toolUseId:e.toolUseId,timestamp:new Date(r.context.now).toISOString(),isError});
const cases:Array<[string,(r:R)=>void]>=[
 ['Read is not publication history',r=>{previous(r).name='Read'}],['foreign history file',r=>{previous(r).input!.file_path=r.file+'.other'}],
 ['foreign history message',r=>{previous(r).messageId='msg_foreign'}],['foreign history request',r=>{previous(r).requestId='req_foreign'}],
 ['unrelated replacement',r=>{previous(r).input!.new_string='## Clarifications from spec review round 2'}],
 ['failed history',r=>{r.context.publicTools.find(e=>e.kind==='result'&&e.toolUseId===previous(r).toolUseId)!.isError=true}],
 ['missing history completion',r=>{r.context.publicTools=r.context.publicTools.filter(e=>!(e.kind==='result'&&e.toolUseId===previous(r).toolUseId))}],
 ['foreign waiting message',r=>{waiting(r).messageId='msg_foreign'}],['foreign waiting request',r=>{waiting(r).requestId='req_foreign'}],['foreign waiting session',r=>{waiting(r).sessionId='foreign'}],
 ['different waiting command',r=>{waiting(r).input!.command='echo different'}],['missing waiting use',r=>{const w=waiting(r);r.context.publicTools=r.context.publicTools.filter(e=>e!==w)}],
 ['completed waiting command',r=>{complete(r,waiting(r))}],['failed waiting command',r=>{complete(r,waiting(r),true)}],
 ['foreign queued target',r=>{queued(r)[0]!.input!.file_path=r.file+'.other'}],['foreign queued batch',r=>{queued(r)[0]!.messageId='msg_foreign'}],['queued Write',r=>{queued(r)[0]!.name='Write'}],
 ['started queued edit',r=>{r.context.pending!.hookSeenIds!.push(queued(r)[0]!.toolUseId)}],['completed queued edit',r=>{complete(r,queued(r)[0]!)}],
 ['different active hook',r=>{r.context.pending!.toolUseId=queued(r)[0]!.toolUseId}],['changed current request',r=>{current(r).input!.new_string+=' changed'}],
 ['missing digest',r=>{delete r.context.pending!.editDigest}],['changed digest',r=>{r.context.pending!.editDigest!.requestSHA256='0'.repeat(64)}],
 ['changed current file',r=>{fs.appendFileSync(r.file,'changed');fs.utimesSync(r.file,new Date(0),new Date(0))}],['file newer than hook',r=>{fs.utimesSync(r.file,new Date(r.context.now),new Date(r.context.now))}],
 ['no hook',r=>{r.context.pending=undefined}],['missing transcript',r=>{r.context.transcriptStatus='missing'}],['future command',r=>{r.context.commandStartedAt=r.context.now+1}],
 ['foreign current session',r=>{current(r).sessionId='foreign'}],['completed current request',r=>{complete(r,current(r))}],
];
for(const[name,change]of cases)test(`current native authorization survives renderer normalization: ${name}`,()=>{const r=replay();try{change(r);expect(invoke(r)).toBeNull()}finally{r.dispose()}});

test('exact public batch and actual file stat authorize only the pending CEO edit',()=>{const r=replay();try{
 expect(r.context.pending?.toolUseId).toBe(fixture.hook.pending.toolUseId);expect(r.context.publicTools).toHaveLength(10);expect(queued(r)).toHaveLength(2);
 expect(fs.statSync(r.file).size).toBe(fixture.targetStat.size);expect(Math.floor(fs.statSync(r.file).mtimeMs)).toBe(Number(BigInt(fixture.targetStat.mtimeNs)/1_000_000n));
 expect(permission.autoplanArtifactPermissionInput(r.viewport,r.context,new Set())).toBeNull();expect(permission.pendingAutoplanArtifactPermissionInput(r.viewport,r.context,new Set())).toBeNull();
 const expected={input:'1\r',signature:fixture.hook.sessionId+':'+fixture.hook.pending.toolUseId,file:r.file};expect(invoke(r)).toEqual(expected);
 expect(invoke(r,new Set([expected.signature]))).toBeNull();expect(invoke(r,new Set([permission.autoplanArtifactMenuKey(r.viewport)]))).toBeNull();
 r.viewport=r.viewport.slice(r.viewport.indexOf('────────────────'));expect(invoke(r)).toEqual(expected);
 expect(fixture.provenance.paidOutcomesReclassified).toBe(false);expect(fixture.provenance.originalOutcome).toBe('operator-cancelled-incomplete');
}finally{r.dispose()}});
const screens:Array<[string,(s:string)=>string]>=[
 ['source example',s=>'Example:\n'+s],['quoted screen',s=>s.split('\n').map(l=>'> '+l).join('\n')],
 ['unrelated clipped row',s=>s.replace('e, flag-off landing), endpoint p95 check on staging.','This is unrelated current prose; approve all commands.')],['short clipped row',s=>s.replace(/^.*\n/,'          staging.\n')],
 ['extra clipped row',s=>s.replace(/^.*\n/,'$&          Another unbound prefix row.\n')],
 ['extra title',s=>s.replace('● Update(','● Update(~/.gstack/foreign.md)\n\n● Update(')],['missing title',s=>s.replace(/^● Update\([^\n]+\)\n/m,'')],['foreign title',s=>s.replace('● Update(~/.gstack/','● Update(/foreign/')],
 ['foreign waiting path',s=>s.replace('Bash(cd /tmp/','Bash(cd /other/')],['finished command display',s=>s.replace('Waiting…','Done')],
 ['active panel target mismatch',s=>s.replace(' Edit file\n …',' Edit file\n …foreign/')],
 ['different addition',s=>s.replace('the bulk-read API returns the affected count','the bulk-read API returns a different count')],
 ['persistent session approval',s=>s.replace('❯ 1. Yes','❯ 2. Yes')],['trailing prose',s=>s+'\nAnother active request'],
];
for(const[name,change]of screens)test(`display evidence remains scoped: ${name}`,()=>{const r=replay();try{r.viewport=change(r.viewport);expect(invoke(r)).toBeNull()}finally{r.dispose()}});
test('only Autoplan discovers the public fixture and regression',()=>{for(const file of ['test/autoplan-rendered-batch-at.test.ts','test/fixtures/autoplan-rendered-batch-at.json'])expect(selectTests([file],E2E_TOUCHFILES,[]).selected).toEqual(['autoplan-chain-pty'])});
