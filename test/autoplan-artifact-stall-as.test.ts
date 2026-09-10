import {expect,test} from 'bun:test';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import fixture from './fixtures/autoplan-artifact-stall-as.json';
import * as permission from './helpers/autoplan-artifact-permission';
import {readPendingAutoplanArtifact,autoplanArtifactRecorderStatus} from './helpers/autoplan-artifact-recorder';
import {readPlanCountTranscript,type NativePublicToolEvent} from './helpers/plan-count-transcript';
import {E2E_TOUCHFILES,selectTests} from './helpers/touchfiles';

function replay() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'gstack-ap-stall-'));
  const runtimeBefore=path.dirname(path.dirname(fixture.stateRoot));
  const runtime=path.join(root,path.basename(runtimeBefore)),cwd=path.join(root,path.basename(fixture.cwd));
  const replace=(value:string)=>value.replaceAll(runtimeBefore,runtime).replaceAll(fixture.cwd,cwd);
  const hook=JSON.parse(replace(JSON.stringify(fixture.hook))),stateRoot=replace(fixture.stateRoot),config=replace(fixture.config);
  const events=JSON.parse(replace(JSON.stringify(fixture.publicTools))) as NativePublicToolEvent[];
  const now=Date.parse(fixture.viewportCapturedAt),startedAt=Date.parse(fixture.commandStartedAt);
  const file=hook.pending.file,nativePlan=events.filter(e=>e.kind==='use'&&e.name==='Edit').at(-1)!.input!.file_path as string;
  for(const [target,content] of [[file,fixture.before],[nativePlan,fixture.nativePlanBefore]]) {
    fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,content);
    const at=new Date(Date.parse(hook.pending.timestamp)-1000);fs.utimesSync(target,at,at);
  }
  fs.mkdirSync(cwd,{recursive:true});fs.mkdirSync(path.dirname(hook.pending.transcriptPath),{recursive:true});
  const records=events.map(e=>({sessionId:e.sessionId,cwd,isSidechain:false,timestamp:e.timestamp,requestId:e.requestId,
    message:{id:e.messageId,role:e.kind==='use'?'assistant':'user',content:e.kind==='use'?[{type:'tool_use',id:e.toolUseId,name:e.name,input:e.input}]:[{type:'tool_result',tool_use_id:e.toolUseId,content:e.content??'',is_error:e.isError}]}}));
  fs.writeFileSync(hook.pending.transcriptPath,records.map(r=>JSON.stringify(r)).join('\n')+'\n');
  const hookFile=path.join(root,'hook.json');fs.writeFileSync(hookFile,JSON.stringify(hook)+'\n');
  const publicTools:NativePublicToolEvent[]=[];const transcript=readPlanCountTranscript(config,cwd,e=>publicTools.push(e));
  const pending=readPendingAutoplanArtifact(hookFile,cwd,config,stateRoot,startedAt,publicTools,now,true);
  const context={cwd,ownedStateRoot:stateRoot,ownedNativePlansRoot:path.join(config,'plans'),commandStartedAt:startedAt,
    now,viewportCapturedAt:now,transcriptStatus:transcript.status,publicTools,pending};
  const viewport=replace(fixture.viewport);
  const invoke=(screen=viewport,ctx=context,seen=new Set<string>())=>permission.publishedAutoplanArtifactPermissionInput(screen,ctx,seen);
  return {root,hook,hookFile,config,file,nativePlan,context,viewport,invoke,dispose:()=>fs.rmSync(root,{recursive:true,force:true})};
}
type Replay=ReturnType<typeof replay>;
const current=(r:Replay)=>r.context.publicTools.find(e=>e.toolUseId===r.hook.pending.toolUseId&&e.kind==='use')!;
const queued=(r:Replay)=>r.context.publicTools.filter(e=>e.kind==='use'&&e.name==='Edit'&&Date.parse(e.timestamp)>Date.parse(r.hook.pending.timestamp));
function reject(cases:Array<[string,(r:Replay)=>void]>) {
  for(const [name,change] of cases){const r=replay();try{change(r);expect(r.invoke(),name).toBeNull()}finally{r.dispose()}}
}

test('the retained pending CEO edit remains distinct from later published native-plan edits',()=>{
  const r=replay();try{
    expect(autoplanArtifactRecorderStatus(r.hookFile,r.context.cwd,r.config,r.context.ownedStateRoot)).toEqual({status:'pending'});
    expect(r.context.pending?.toolUseId).toBe(fixture.hook.pending.toolUseId);
    expect(queued(r)).toHaveLength(2);
    expect(permission.autoplanArtifactPermissionInput(r.viewport,r.context,new Set())).toBeNull();
    expect(permission.pendingAutoplanArtifactPermissionInput(r.viewport,r.context,new Set())).toBeNull();
    expect(r.invoke()).toEqual({input:'1\r',signature:fixture.hook.sessionId+':'+fixture.hook.pending.toolUseId,file:r.file});
    expect(fixture.provenance.retrospectivePass).toBe(false);
    expect(r.invoke(r.viewport,r.context,new Set([r.hook.sessionId+':'+r.hook.pending.toolUseId]))).toBeNull();
    expect(r.invoke(r.viewport,r.context,new Set([permission.autoplanArtifactMenuKey(r.viewport)]))).toBeNull();
  }finally{r.dispose()}
});

test('a bare current panel and its bound redraw labels represent the same one-time permission',()=>{
  const r=replay();try{
    const title=r.viewport.indexOf('● Update('),panel=r.viewport.indexOf('────────────────');
    expect(r.invoke(r.viewport.slice(title))?.input).toBe('1\r');
    expect(r.invoke(r.viewport.slice(panel))?.input).toBe('1\r');
  }finally{r.dispose()}
});

test('only unstarted same-batch publications to the launcher-owned native plans root may wait behind it',()=>{
  reject([
    ['no launcher root',r=>{delete (r.context as any).ownedNativePlansRoot}],
    ['foreign launcher root',r=>{r.context.ownedNativePlansRoot=path.join(r.root,'foreign')}],
    ['foreign message',r=>{queued(r)[0]!.messageId='msg_other'}],
    ['foreign request',r=>{queued(r)[0]!.requestId='req_other'}],
    ['foreign session',r=>{queued(r)[0]!.sessionId='other'}],
    ['foreign target',r=>{queued(r)[0]!.input!.file_path=r.file+'.other'}],
    ['queued Write',r=>{queued(r)[0]!.name='Write'}],
    ['replace-all successor',r=>{queued(r)[0]!.input!.replace_all=true}],
    ['already started successor',r=>{r.context.pending!.hookSeenIds!.push(queued(r)[0]!.toolUseId)}],
    ['successor completion',r=>{const q=queued(r)[0]!;r.context.publicTools.push({kind:'result',sessionId:q.sessionId,toolUseId:q.toolUseId,timestamp:new Date(r.context.now).toISOString(),isError:false})}],
    ['successor failure',r=>{const q=queued(r)[0]!;r.context.publicTools.push({kind:'result',sessionId:q.sessionId,toolUseId:q.toolUseId,timestamp:new Date(r.context.now).toISOString(),isError:true})}],
    ['successor published after viewport',r=>{queued(r)[0]!.timestamp=new Date(r.context.viewportCapturedAt+1).toISOString()}],
    ['missing native plan',r=>{fs.unlinkSync(r.nativePlan)}],
    ['native plan changed after current hook',r=>{fs.utimesSync(r.nativePlan,new Date(r.context.now),new Date(r.context.now))}],
    ['symlink native plan',r=>{const other=path.join(r.root,'other.md');fs.renameSync(r.nativePlan,other);fs.symlinkSync(other,r.nativePlan)}],
    ['successful Read cannot replace native-plan mutation history',r=>{for(const e of r.context.publicTools)if(e.kind==='use'&&e.input?.file_path===r.nativePlan&&Date.parse(e.timestamp)<Date.parse(r.hook.pending.timestamp))e.name='Read'}],
    ['no successful native-plan history',r=>{const ids=new Set(r.context.publicTools.filter(e=>e.input?.file_path===r.nativePlan).map(e=>e.toolUseId));for(const e of r.context.publicTools)if(e.kind==='result'&&ids.has(e.toolUseId))e.isError=true}],
  ]);
});

test('the active hook, current digest, successful owned history and time remain mandatory',()=>{
  reject([
    ['no current hook',r=>{r.context.pending=undefined}],['foreign hook',r=>{r.context.pending!.sessionId='other'}],
    ['wrong current ID',r=>{r.context.pending!.toolUseId=queued(r)[0]!.toolUseId}],
    ['no digest',r=>{delete r.context.pending!.editDigest}],
    ['changed digest',r=>{r.context.pending!.editDigest!.requestSHA256='0'.repeat(64)}],
    ['changed replacement',r=>{current(r).input!.new_string+=' changed'}],
    ['changed current file',r=>{fs.appendFileSync(r.file,'changed');fs.utimesSync(r.file,new Date(0),new Date(0))}],
    ['completed current',r=>{const q=current(r);r.context.publicTools.push({kind:'result',sessionId:q.sessionId,toolUseId:q.toolUseId,timestamp:new Date(r.context.now).toISOString(),isError:false})}],
    ['current file newer than hook',r=>{fs.utimesSync(r.file,new Date(r.context.now),new Date(r.context.now))}],
    ['pending after viewport',r=>{r.context.pending!.timestamp=new Date(r.context.now+1).toISOString()}],
    ['stale hook',r=>{r.context.pending!.timestamp=new Date(r.context.commandStartedAt-1).toISOString()}],
    ['unavailable transcript',r=>{r.context.transcriptStatus='missing'}],
  ]);
  const r=replay();try{
    fs.writeFileSync(r.hookFile+'.invalid','{"reason":"concurrent_pending"}');
    expect(readPendingAutoplanArtifact(r.hookFile,r.context.cwd,r.config,r.context.ownedStateRoot,r.context.commandStartedAt,r.context.publicTools,r.context.now,true)).toBeUndefined();
  }finally{r.dispose()}
});

test('completed output and redraw labels cannot hide a foreign, quoted or persistent-permission panel',()=>{
  const changes:Array<[string,(s:string)=>string]>=[
    ['example prefix',s=>'Example:\n'+s],['quoted whole pane',s=>s.split('\n').map(r=>'> '+r).join('\n')],
    ['arbitrary output',s=>s.replace('"changed": true','"changed": false')],
    ['foreign completed command',s=>s.replace('with-skills/.clau','foreign/.clau')],
    ['missing one redraw',s=>s.replace('● Updated plan','')],['extra redraw',s=>s.replace('● Updated plan','● Updated plan\n● Updated plan')],
    ['arbitrary redraw prose',s=>s.replace('● Updated plan','● Example plan')],
    ['foreign current title',s=>s.replace('Update(~/.gstack/','Update(/foreign/')],
    ['foreign displayed project',s=>s.replace('…-207152-jk89F3/skill-home-bOPSw5/.gstack/projects/gstack-autoplan-chain-kVh2Sb','…projects/foreign')],
    ['different requested addition',s=>s.replace('## Reviewer Concerns','## An unrelated edit')],
    ['wrong menu file',s=>s.replace('user-dashboard.md?','other.md?')],
    ['persistent session approval',s=>s.replace('❯ 1. Yes','❯ 2. Yes')],['trailing prose',s=>s+'\nAnother prompt'],
  ];
  for(const [name,edit] of changes){const r=replay();try{expect(r.invoke(edit(r.viewport)),name).toBeNull()}finally{r.dispose()}}
});

test('only Autoplan discovers the permission regression and its captured fixture',()=>{
  for(const file of ['test/autoplan-artifact-stall-as.test.ts','test/fixtures/autoplan-artifact-stall-as.json'])
    expect(selectTests([file],E2E_TOUCHFILES,[]).selected).toEqual(['autoplan-chain-pty']);
});
