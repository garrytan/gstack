import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { autoplanArtifactPermissionInput, pendingAutoplanArtifactPermissionInput, autoplanArtifactMenuKey } from './helpers/autoplan-artifact-permission';
import type { NativePublicToolEvent } from './helpers/plan-count-transcript';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';
import captured from './fixtures/autoplan-edit-header-ag.json';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, {recursive:true,force:true}); });
function replay() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-edit-header-')); roots.push(root);
  const cwd = path.join(root,path.basename(captured.cwd));
  const ownedStateRoot = path.join(root,'home','.gstack');
  const file = captured.pending.file.replace(captured.ownedStateRoot,ownedStateRoot);
  fs.mkdirSync(cwd,{recursive:true}); fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,captured.before);
  const beforeTime = new Date(Date.parse(captured.pending.timestamp)-1000);
  fs.utimesSync(file,beforeTime,beforeTime);
  const publicTools = structuredClone(captured.events) as NativePublicToolEvent[];
  for (const event of publicTools) if (event.input?.file_path === captured.pending.file) event.input.file_path = file;
  const pending = {...captured.pending,file,source:'pre_tool_use' as const,tool:'Edit' as const};
  const context = {cwd,ownedStateRoot,commandStartedAt:Date.parse(publicTools[0]!.timestamp)-1,
    now:Date.parse(captured.viewportCapturedAt),viewportCapturedAt:Date.parse(captured.viewportCapturedAt),
    transcriptStatus:'ready',publicTools,pending};
  const viewport = captured.viewport.replace(/^ (…[^\n]+)$/m,' …'+file.slice(root.length+1));
  return {root,file,context,viewport};
}
const pick = (r:ReturnType<typeof replay>, seen = new Set<string>()) =>
  pendingAutoplanArtifactPermissionInput(r.viewport,r.context,seen);

test('the captured native edit header preserves the current owned hook and diff', () => {
  const r = replay();
  expect(r.context.publicTools).toHaveLength(88);
  expect(autoplanArtifactPermissionInput(r.viewport,r.context,new Set())).toBeNull();
  expect(pick(r)).toEqual({input:'1\r',signature:captured.pending.sessionId+':'+captured.pending.toolUseId,file:r.file});
});

test('exact absolute paths, full owned suffixes and launcher-owned aliases bind the same one-time request', () => {
  for (const absoluteTitle of [false,true]) for (const displayedPath of ['cropped','absolute','relative']) {
    const r = replay();
    if (absoluteTitle) r.viewport = r.viewport.replace(/^([●⏺] Update\()[^\n]+(?=\)$)/m,'$1'+r.file);
    if (displayedPath === 'absolute') r.viewport = r.viewport.replace(/^ …[^\n]+$/m,' '+r.file);
    if (displayedPath === 'relative') r.viewport = r.viewport.replace(/^ …[^\n]+$/m,' …'+path.relative(r.context.ownedStateRoot,r.file));
    const result = pick(r); expect(result?.input).toBe('1\r');
    expect(pick(r,new Set([result!.signature]))).toBeNull();
    expect(pick(r,new Set([autoplanArtifactMenuKey(r.viewport)]))).toBeNull();
  }
});

test('a retained header does not permit unrelated, ambiguous or quoted prefix rows', () => {
  const changes = [
    (s:string) => s.replace('● Update(', '● Write('),
    (s:string) => s.replace(/^● Update\([^\n]+\)/, '● Update(/tmp/foreign.md)'),
    (s:string) => s.replace('~/.gstack/projects/', '~/.gstack/../projects/'),
    (s:string) => s.replace(/(^ …[^\n]+)dashboard.md/m, '$1other.md'),
    (s:string) => s.replace(/^ …[^\n]+$/m, ' …2026-09-10-user-dashboard.md'),
    (s:string) => s.replace(/^ …[^\n]+$/m, ' …projects/sibling/ceo-plans/2026-09-10-user-dashboard.md'),
    (s:string) => s.replace(' Edit file', ' Read file'),
    (s:string) => s.replace(' Edit file', ' Run this first\n Edit file'),
    (s:string) => s.replace(' Edit file', ' Edit file\n Edit file'),
    (s:string) => 'Example:\n'+s,
    (s:string) => '> '+s.replaceAll('\n','\n> '),
    (s:string) => '```text\n'+s+'\n```',
    (s:string) => s+'\nRun another action.',
    (s:string) => s.replace(' ❯ 1. Yes',' ❯ 1. Yes, always allow'),
    (s:string) => s.replace('to 2026-09-10-user-dashboard.md?','to sibling.md?'),
  ];
  for (const change of changes) { const r=replay(); r.viewport=change(r.viewport); expect(pick(r),change.toString()).toBeNull(); }
});

test('framed edits retain stale, wrong-tool, foreign-path and success-history gates', () => {
  const changes: Array<(r:ReturnType<typeof replay>)=>void> = [
    r=>{r.context.pending.tool='Write' as 'Edit';},
    r=>{r.context.pending.sessionId='foreign';},
    r=>{r.context.pending.file=r.file+'.sibling';},
    r=>{r.context.viewportCapturedAt=Date.parse(r.context.pending.timestamp)-1;},
    r=>{r.context.pending.timestamp=new Date(r.context.now+1000).toISOString();},
    r=>{r.context.publicTools.push({kind:'result',sessionId:r.context.pending.sessionId,toolUseId:r.context.pending.toolUseId,timestamp:new Date(r.context.now).toISOString(),isError:false});},
    r=>{r.context.publicTools.push({kind:'use',sessionId:r.context.pending.sessionId,toolUseId:'unresolved-other',name:'Write',timestamp:new Date(r.context.now).toISOString(),input:{file_path:r.file}});},
    r=>{for(const event of r.context.publicTools) if(event.kind==='result') event.isError=true;},
    r=>{fs.writeFileSync(r.file,'Unrelated replacement content');},
    r=>{fs.utimesSync(r.file,new Date(r.context.now+1000),new Date(r.context.now+1000));},
  ];
  for(const change of changes) { const r=replay();change(r);expect(pick(r),change.toString()).toBeNull(); }
});

test('the same header works for fully published synthetic Edit inputs without replacing their comparison', () => {
  const r = replay();
  const oldString = captured.before.split('\n')[0]!;
  const newString = oldString+' (revised)';
  const lines = r.viewport.split('\n');
  const menu = r.viewport.slice(r.viewport.indexOf(' Do you want'));
  r.viewport = lines.slice(0,6).join('\n')+'\n 1 -'+oldString+'\n 1 +'+newString+'\n────────\n'+menu;
  r.context.publicTools.push({kind:'use',sessionId:r.context.pending.sessionId,toolUseId:r.context.pending.toolUseId,
    name:'Edit',timestamp:r.context.pending.timestamp,input:{file_path:r.file,old_string:oldString,new_string:newString}});
  expect(pendingAutoplanArtifactPermissionInput(r.viewport,r.context,new Set())).toBeNull();
  expect(autoplanArtifactPermissionInput(r.viewport,r.context,new Set())?.input).toBe('1\r');
  r.context.publicTools.at(-1)!.input!.new_string='Different unpublished replacement';
  expect(autoplanArtifactPermissionInput(r.viewport,r.context,new Set())).toBeNull();
});

test('the new native header evidence selects only the existing Autoplan paid case', () => {
  for(const file of ['test/autoplan-edit-header-ag.test.ts','test/fixtures/autoplan-edit-header-ag.json']) {
    expect(Object.entries(E2E_TOUCHFILES).filter(([,files])=>files.includes(file)).map(([owner])=>owner)).toEqual(['autoplan-chain-pty']);
    expect(selectTests([file],E2E_TOUCHFILES,[]).selected).toEqual(['autoplan-chain-pty']);
  }
});
