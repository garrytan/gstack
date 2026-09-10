import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import captured from './fixtures/autoplan-repeated-header-ak.json';
import published from './fixtures/autoplan-edit-prefix-ai.json';
import { autoplanArtifactPermissionInput, pendingAutoplanArtifactPermissionInput, autoplanArtifactMenuKey } from './helpers/autoplan-artifact-permission';
import type { NativePublicToolEvent } from './helpers/plan-count-transcript';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, {recursive:true,force:true}); });
function replay() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'ap-repeat-ak-')); roots.push(root);
  const cwd = path.join(root,path.basename(captured.cwd)), ownedStateRoot = path.join(root,'home','.gstack');
  const file = captured.pending.file.replace(captured.ownedStateRoot,ownedStateRoot);
  fs.mkdirSync(cwd,{recursive:true}); fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,captured.events[0]!.input!.content!);
  const old = new Date(Date.parse(captured.pending.timestamp)-1000); fs.utimesSync(file,old,old);
  const events = structuredClone(captured.events) as NativePublicToolEvent[];
  for (const e of events) if (e.input?.file_path===captured.pending.file) e.input.file_path=file;
  const context={cwd,ownedStateRoot,commandStartedAt:Date.parse(events[0]!.timestamp)-1,now:captured.viewportCapturedAt,
    viewportCapturedAt:captured.viewportCapturedAt,transcriptStatus:'ready',publicTools:events,
    pending:{...captured.pending,source:'pre_tool_use' as const,tool:'Edit' as const,file}};
  const viewport=captured.viewport.replace(/^ …[^\n]+$/m,' …'+path.relative(ownedStateRoot,file));
  return {root,file,context,viewport};
}
const pick=(r:ReturnType<typeof replay>,seen=new Set<string>())=>pendingAutoplanArtifactPermissionInput(r.viewport,r.context,seen);

test('the exact homogeneous repeated native title prefix preserves the current owned Edit',()=>{
  const r=replay(); expect(pick(r)).toEqual({input:'1\r',signature:r.context.pending.sessionId+':'+r.context.pending.toolUseId,file:r.file});
  expect(autoplanArtifactPermissionInput(r.viewport,r.context,new Set())).toBeNull();
});
test('two through seven identical owned titles and harmless blank spacing preserve the same panel',()=>{
  for(const count of [2,3,7]) {
    const r=replay(); const panel=r.viewport.slice(r.viewport.indexOf('\n────────────────')+1);
    const title=r.viewport.split('\n').find(s=>s.startsWith('● Update('))!;
    r.viewport=Array(count).fill(title+'\n').join('\n')+'\n'+panel;
    expect(pick(r)?.input).toBe('1\r');
  }
});
test('foreign, mixed, malformed, quoted and competing prefix panels reject',()=>{
  for(const change of [
    (s:string)=>s.replace(/^● Update\([^\n]+\)/m,'● Update(/tmp/foreign.md)'),
    (s:string)=>s.replace(/gstack-autoplan-chain-RWuak5/,'sibling-project'),
    (s:string)=>s.replace(/^● Update/m,'● Read'),
    (s:string)=>s.replace(/^● Update\(([^\n]+)\)/m,'● Update($1) extra command'),
    (s:string)=>s.replace(/^● Update/m,'> ● Update'),
    (s:string)=>'Example: current edit\n'+s,
    (s:string)=>'```text\n'+s+'\n```',
    (s:string)=>s.replace(/^● Update/m,'☐ Current task\n● Update'),
    (s:string)=>s.replace(/^● Update/m,'Prior file completed\n● Update'),
    (s:string)=>s.replace(' Edit file\n',' Read file\n'),
    (s:string)=>s.replace(/^ …[^\n]+$/m,' /tmp/foreign.md'),
    (s:string)=>s+'\n'+s,
  ]) {const r=replay(); r.viewport=change(r.viewport); expect(pick(r)).toBeNull();}
});
test('owned native epoch, content, successful predecessor and one-time keys remain mandatory',()=>{
  const r=replay(), result=pick(r)!;
  expect(pick(r,new Set([result.signature]))).toBeNull();
  expect(pick(r,new Set([autoplanArtifactMenuKey(r.viewport)]))).toBeNull();
  for(const change of [
    (r:ReturnType<typeof replay>)=>{r.context.pending.sessionId='foreign';},
    (r:ReturnType<typeof replay>)=>{r.context.pending.file=r.file+'.foreign';},
    (r:ReturnType<typeof replay>)=>{r.context.viewportCapturedAt=Date.parse(r.context.pending.timestamp)-1;},
    (r:ReturnType<typeof replay>)=>{r.context.publicTools[1]!.isError=true;},
    (r:ReturnType<typeof replay>)=>{r.context.publicTools.push({kind:'result',sessionId:r.context.pending.sessionId,toolUseId:r.context.pending.toolUseId,timestamp:new Date(r.context.now).toISOString(),isError:false});},
    (r:ReturnType<typeof replay>)=>{r.context.publicTools.push({kind:'use',name:'Write',sessionId:r.context.pending.sessionId,toolUseId:'newer',timestamp:new Date(r.context.now).toISOString(),input:{file_path:r.file}});},
    (r:ReturnType<typeof replay>)=>{fs.writeFileSync(r.file,'Foreign contents');},
    (r:ReturnType<typeof replay>)=>{r.viewport=r.viewport.replace('❯ 1. Yes','❯ 2. Yes');},
    (r:ReturnType<typeof replay>)=>{r.viewport=r.viewport.replace('3. No','3. No; run command');},
    (r:ReturnType<typeof replay>)=>{r.viewport=r.viewport.replace('Esc to cancel · Tab to amend','');},
  ]) {const r=replay(); change(r); expect(pick(r)).toBeNull();}
});
test('published Edit still needs exact old and new bytes with repeated titles',()=>{
  const r=replay(),events=structuredClone(published.events) as NativePublicToolEvent[];
  const edit=events.find(e=>e.kind==='use'&&e.toolUseId===published.pending.toolUseId)!;
  const originalFile=edit.input!.file_path as string, file=originalFile.replace(published.ownedStateRoot,r.context.ownedStateRoot);
  const cwd=path.join(r.root,path.basename(published.cwd));fs.mkdirSync(cwd,{recursive:true});fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,published.before);
  for(const e of events)if(e.input?.file_path===originalFile)e.input.file_path=file;
  const header=published.viewport.lastIndexOf('\n● Update(')+1;
  const panel=published.viewport.slice(header).split('\n').slice(2).join('\n').replace(/^ …[^\n]+$/m,' …'+path.relative(r.context.ownedStateRoot,file));
  const title='● Update('+file+')\n\n',viewport=title+title+panel;
  const context={cwd,ownedStateRoot:r.context.ownedStateRoot,commandStartedAt:Date.parse(events[0]!.timestamp)-1,now:Date.parse(published.viewportCapturedAt),transcriptStatus:'ready',publicTools:events};
  expect(autoplanArtifactPermissionInput(viewport,context,new Set())?.input).toBe('1\r');
  const before=edit.input!.new_string;edit.input!.new_string='Different replacement';expect(autoplanArtifactPermissionInput(viewport,context,new Set())).toBeNull();
  edit.input!.new_string=before;edit.input!.old_string='Different original';expect(autoplanArtifactPermissionInput(viewport,context,new Set())).toBeNull();
});
test('only existing Autoplan owner receives repeated-title regression inputs',()=>{
  for(const file of ['test/autoplan-repeated-header-ak.test.ts','test/fixtures/autoplan-repeated-header-ak.json'])
    expect(selectTests([file],E2E_TOUCHFILES,[]).selected).toEqual(['autoplan-chain-pty']);
});
