import {describe,test,expect} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createFilePermissionRecorder,recordFilePermission,currentFilePermissionEpoch} from './helpers/plan-count-file-permission';
import {createPlanCountPermissionGuard,classifyPlanCountFrame} from './helpers/claude-pty-runner';
import {readPlanCountTranscript} from './helpers/plan-count-transcript';
import captured from './fixtures/plan-count-edit-permission-t.json';
import capturedAc from './fixtures/plan-count-permission-ac.json';
import largeCeo from './fixtures/ceo-report-permission-fb10.json';
import overwriteCaptured from './fixtures/plan-ceo-floor-overwrite-permission.json';

function fixture() {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'count-file-epoch-'));const cwd=path.join(dir,'cwd');fs.mkdirSync(cwd);
 const config=path.join(dir,'.claude');const expected=path.join(dir,'report.md');fs.writeFileSync(expected,'original');
 const recorder=createFilePermissionRecorder(cwd,config,expected)!;const startedAt=Date.now()-1000;
 const screen=captured.screen.replaceAll(captured.expectedPath,expected).replace('../gstack-e2e-plan-ceo-paired-2Rv5Bi/gstack-test-plan-ceo-paired.md','../report.md').replaceAll('gstack-test-plan-ceo-paired.md','report.md');
 const transcript:any={status:'ready',calls:[],assistantMessages:[{sessionId:'main',text:'Reviewing',timestamp:new Date().toISOString()}]};
 const event=(name:string,id:string,extra={})=>({hook_event_name:name,tool_name:'Edit',session_id:'main',tool_use_id:id,cwd,transcript_path:path.join(config,'projects','owned','main.jsonl'),tool_input:{file_path:expected,old_string:'NEVER_SAVE_OLD',new_string:'NEVER_SAVE_NEW'},...extra});
 const record=(name:string,id:string,extra={})=>recordFilePermission(JSON.stringify(event(name,id,extra)),recorder.file,cwd,config,expected);
 const read=()=>currentFilePermissionEpoch(recorder.file,expected,cwd,config,startedAt,transcript,screen);
 return {dir,cwd,config,expected,recorder,startedAt,screen,transcript,event,record,read,close(){recorder.dispose();fs.rmSync(dir,{recursive:true,force:true});}};
}
describe('native repeated report permission identity',()=>{
 test('captured prompt is recognized but unchanged visible-only dedup cannot release its second Edit',()=>{
  expect(classifyPlanCountFrame(captured.screen)).toBe('permission');
  const guard=createPlanCountPermissionGuard();const history='⎿ Wrote32lines\n';
  expect(guard(captured.screen,history)).toBe('grant');
  expect(guard(captured.screen,history)).toBe('handled');
  expect(captured.pendingEditId).toBeNull();
 });
 test('late success and old pane redraw do not release until a distinct current request',()=>{
  const f=fixture();try{
   const guard=createPlanCountPermissionGuard();const input=()=>guard(f.screen,'',f.read());
   expect(input()).toBe('handled');
   f.record('PreToolUse','first');expect(input()).toBe('grant');expect(input()).toBe('handled');
   f.record('PostToolUse','first');expect(input()).toBe('handled');
   f.record('PreToolUse','first');expect(input()).toBe('handled');
   f.record('PreToolUse','second');expect(input()).toBe('grant');expect(input()).toBe('handled');
   f.record('PostToolUse','first');expect(input()).toBe('handled');
   f.record('PostToolUse','second');expect(input()).toBe('handled');
   f.record('PreToolUse','first');expect(input()).toBe('handled');
   expect(fs.readFileSync(f.recorder.file,'utf8')).not.toContain('NEVER_SAVE');
  }finally{f.close();}
 });
 test('failed, missing-result, foreign session/path, mismatched tool and replay cannot release',()=>{
  for(const kind of ['failed','no-result','foreign','other-path','other-tool','sidechain','wrong-cwd']){
   const f=fixture();try{
    const guard=createPlanCountPermissionGuard();const input=()=>guard(f.screen,'',f.read());
    f.record('PreToolUse','first');expect(input()).toBe('grant');
    if(kind==='failed')f.record('PostToolUseFailure','first');
    else if(kind!=='no-result')f.record('PostToolUse','first',kind==='foreign'?{session_id:'foreign'}:kind==='other-path'?{tool_input:{file_path:path.join(f.dir,'other')}}:kind==='other-tool'?{tool_name:'Bash'}:kind==='sidechain'?{agent_id:'child'}:{cwd:'/other'});
    f.record('PreToolUse','second');expect(input(),kind).toBe('handled');
   }finally{f.close();}
  }
 });
 test('scoped current records and viewport are required; other permission policy stays unchanged',()=>{
  const f=fixture();try{
   f.record('PreToolUse','first');const valid=fs.readFileSync(f.recorder.file,'utf8');
   for(const delta of [{sessionId:'foreign'},{cwd:'/other'},{expected:'/other'},{transcriptPath:'/outside/main.jsonl'},{timestamp:new Date(f.startedAt-1).toISOString()},{timestamp:new Date(Date.now()+60000).toISOString()},{pendingId:'main:../escape'}]){
    fs.writeFileSync(f.recorder.file,JSON.stringify({...JSON.parse(valid),...delta}));expect(f.read()).toBeNull();
   }
   fs.writeFileSync(f.recorder.file,valid);
   expect(currentFilePermissionEpoch(f.recorder.file,f.expected,f.cwd,f.config,f.startedAt,f.transcript,'Do you want to create OTHER.md?')).toBeUndefined();
   const guard=createPlanCountPermissionGuard();expect(guard('Do you want to create OTHER.md?\n❯1.Yes\n2.Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)\n3.No\nEsc to cancel · Tab to amend')).toBe('grant');
   fs.unlinkSync(f.recorder.file);fs.symlinkSync(f.expected,f.recorder.file);expect(f.read()).toBeNull();
   expect(createFilePermissionRecorder(f.cwd,f.config,path.parse(f.dir).root+'not-disposable.md')).toBeUndefined();
  }finally{f.close();}
 });
});

test('large report crop verifies only a complete bounded source line and the current owned epoch',()=>{
 const f=fixture();try{
  const screen=largeCeo.viewport.replaceAll(path.dirname(largeCeo.expectedPath),path.dirname(f.expected))
   .replaceAll(path.basename(largeCeo.expectedPath),path.basename(f.expected));
  const prefix=Array.from({length:largeCeo.sourceLine-1},(_,i)=>`preceding line ${i+1}\n`).join('');
  const complete=prefix+largeCeo.priorLine+'\n';
  const report=complete+'tail\n'.repeat(Math.ceil((largeCeo.originalReportBytes-Buffer.byteLength(complete))/5));
  expect(Buffer.byteLength(report)).toBeGreaterThan(64*1024);
  fs.writeFileSync(f.expected,report);f.record('PreToolUse','first');
  const check=()=>currentFilePermissionEpoch(f.recorder.file,f.expected,f.cwd,f.config,f.startedAt,f.transcript,screen);
  expect(check()?.pendingId).toBe('main:first');
  const guard=createPlanCountPermissionGuard();expect(guard(screen,'',check())).toBe('grant');
  expect(guard(screen,'',check())).toBe('handled');
  const valid=fs.readFileSync(f.recorder.file,'utf8');
  for(const delta of [{cwd:'/foreign'},{expected:'/foreign/report.md'},{sessionId:'foreign'},{pendingId:null},{timestamp:new Date(f.startedAt-1).toISOString()}]){
   fs.writeFileSync(f.recorder.file,JSON.stringify({...JSON.parse(valid),...delta}));expect(check()).toBeNull();
  }
  fs.writeFileSync(f.recorder.file,valid);
  for(const content of [
   report.replace(largeCeo.priorLine,'different prior line'),
   'no requested line\n'.repeat(2),
   prefix+'x'.repeat(64*1024)+largeCeo.priorLine+'\n',
   prefix+'x'.repeat(64*1024-Buffer.byteLength(prefix)-Buffer.byteLength(largeCeo.priorLine))+largeCeo.priorLine+'\n',
  ]){fs.writeFileSync(f.expected,content);expect(check()).toBeNull();}
  fs.writeFileSync(f.expected,report);
  const target=f.expected+'.real';fs.renameSync(f.expected,target);fs.symlinkSync(target,f.expected);
  expect(check()).toBeNull();
 }finally{f.close();}
});

for (const variant of ['basic', 'intervening', 'cropped', 'same-basename', 'path-cropped']) test.skipIf(process.platform==='win32')(`real fake CLI grants each current request once: ${variant}`,async()=>{
 const intervening = variant === 'intervening';
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ce-'));const fake=path.join(dir,'fake-claude');const worker=path.join(dir,'worker.ts');const events=path.join(dir,'events.jsonl');const output=path.join(dir,'output.json');const expected=path.join(dir,variant==='same-basename'?'PLAN.md':'report.md');fs.writeFileSync(expected,'original');
 const cropped=capturedAc.rows.find(row=>row.job===5)!;
 let screen=variant==='path-cropped' ? capturedPath.screen.replace(capturedPath.screen.split('\n')[0]!,expected).replaceAll(path.dirname(capturedPath.expected),path.dirname(expected)).replaceAll(path.basename(capturedPath.expected),'report.md')
  : variant==='cropped' ? cropped.screen.replaceAll(path.dirname(cropped.hook.expected),path.dirname(expected)).replaceAll(path.basename(cropped.hook.expected),'report.md')
  : captured.screen.replaceAll(captured.expectedPath,expected).replace('../gstack-e2e-plan-ceo-paired-2Rv5Bi/gstack-test-plan-ceo-paired.md',expected).replaceAll('gstack-test-plan-ceo-paired.md','report.md');
 if(variant==='same-basename')screen=screen.replaceAll(expected,'__ACTIVE_PLAN_PATH__').replaceAll('report.md','PLAN.md');
 screen=screen.split('\n').map(row=>{const cut=row.length>120?row.lastIndexOf(' ',120):-1;return cut>0?row.slice(0,cut)+'\n'+row.match(/^ */)![0]+row.slice(cut+1):row;}).join('\n');
 fs.writeFileSync(fake,`#!${process.execPath}\n`+String.raw`
import * as fs from 'node:fs';import * as path from 'node:path';
const item=JSON.parse(process.env.FILE_EPOCH_CASE);const log=e=>fs.appendFileSync(item.events,JSON.stringify(e)+'\n');
const sid='epoch-main';const nativePath=path.join(process.env.CLAUDE_CONFIG_DIR,'projects','epoch',sid+'.jsonl');fs.mkdirSync(path.dirname(nativePath),{recursive:true});
const native=(role,content,extra={})=>fs.appendFileSync(nativePath,JSON.stringify({cwd:process.cwd(),sessionId:sid,isSidechain:false,timestamp:new Date().toISOString(),message:{role,content},...extra})+'\n');
native('assistant',[{type:'text',text:'Reviewing fixture.'}]);log({type:'start',pid:process.pid,cwd:process.cwd()});
const settings=JSON.parse(process.argv[process.argv.indexOf('--settings')+1]);
if(settings.hooks.PreToolUse[0].matcher!=='^ExitPlanMode$')throw Error('Exit recorder changed');
const hook=async(name,id)=>{
 const entries=(settings.hooks[name]??[]).filter(h=>h.matcher==='^(Write|Edit)$');
 for(const entry of entries){
 const event={hook_event_name:name,tool_name:'Edit',session_id:sid,tool_use_id:id,cwd:process.cwd(),transcript_path:nativePath,tool_input:{file_path:item.activePlan?path.join(process.cwd(),'PLAN.md'):item.expected,old_string:'old',new_string:'new'}};
 const p=Bun.spawn(['bash','-c',entry.hooks[0].command],{stdin:new Blob([JSON.stringify(event)]),stdout:'pipe',stderr:'pipe'});
 const [code,out,err]=await Promise.all([p.exited,new Response(p.stdout).text(),new Response(p.stderr).text()]);if(code||out||err)throw Error('hook was not silent');log({type:'hook',name,id});
 }
};
let stage='startup';const paint=()=>process.stdout.write('\x1b[2J\x1b[H'+item.screen.replaceAll('__ACTIVE_PLAN_PATH__',path.join(process.cwd(),'PLAN.md')).replaceAll('\n','\r\n'));
process.stdin.setRawMode?.(true);process.stdin.on('data',async data=>{
 const input=data.toString();log({type:'input',stage,input});
 if(stage==='startup'){stage='first';await hook('PreToolUse','first');paint();return;}
 if(stage==='old-pane'||stage==='done'){log({type:'unexpected'});return;}
 if(input!=='1\r')throw Error('default permission input changed');
 if(stage==='first'){stage='old-pane';await hook('PostToolUse','first');if(item.intervening){await hook('PreToolUse','automatic');await hook('PostToolUse','automatic');}paint();setTimeout(async()=>{await hook('PreToolUse','second');stage='second';paint();},3200);return;}
 stage='done';await hook('PostToolUse','second');
 const q={header:'Finding',question:'Apply this repair?',options:[{label:'Fix'},{label:'Keep'}]};
 native('assistant',[{type:'tool_use',name:'AskUserQuestion',id:'finding',input:{questions:[q]}}]);native('user',[{type:'tool_result',tool_use_id:'finding',content:'Answered'}],{toolUseResult:{answers:{[q.question]:'Fix'}}});
 process.stdout.write('\x1b[2J\x1b[HDone.\r\n');
});process.on('SIGINT',()=>process.exit(0));process.stdin.resume();
process.stdout.write('PTY_READY:'+item.events+'\x1b[2J\x1b[H');
`);fs.chmodSync(fake,0o755);
 fs.writeFileSync(worker,`import {runPlanSkillCounting} from ${JSON.stringify(pathToFileURL(path.join(import.meta.dir,'helpers/claude-pty-runner.ts')).href)};const o=await runPlanSkillCounting({skillName:'plan-ceo-review',slashCommand:'/plan-ceo-review',followUpPrompt:'Review the disposable fixture.',expectedPlanPath:${JSON.stringify(expected)},isLastStep0AUQ:()=>false,isReviewAUQ:()=>true,reviewCountCeiling:1,timeoutMs:28000,startupReadyMarker:${JSON.stringify('PTY_READY:'+events)},env:{FILE_EPOCH_CASE:${JSON.stringify(JSON.stringify({events,expected,screen,intervening,activePlan:variant==='same-basename'}))}}});await Bun.write(${JSON.stringify(output)},JSON.stringify(o));`);
 const child=Bun.spawn([process.execPath,worker],{env:{...process.env,BROWSE_TERMINAL_BINARY:fake,EVALS_HERMETIC:'1'},stdout:'pipe',stderr:'pipe'});const killer=setTimeout(()=>child.kill('SIGKILL'),33000);
 try{const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);expect(code,out+err).toBe(0);
  const o=JSON.parse(fs.readFileSync(output,'utf8'));expect(o.outcome,JSON.stringify(o)).toBe('ceiling_reached');expect(o.reviewCount).toBe(1);
  const rows=fs.readFileSync(events,'utf8').trim().split('\n').map(l=>JSON.parse(l));expect(rows.filter(e=>e.type==='input').map(e=>e.input)).toEqual(['/plan-ceo-review\r','1\r','1\r']);expect(rows.some(e=>e.type==='unexpected')).toBe(false);
  expect(()=>process.kill(rows[0].pid,0)).toThrow();expect(fs.existsSync(rows[0].cwd)).toBe(false);
 }finally{clearTimeout(killer);child.kill('SIGKILL');if(fs.existsSync(events)){const first=JSON.parse(fs.readFileSync(events,'utf8').split('\n')[0]!);try{process.kill(first.pid,'SIGKILL');}catch{}}fs.rmSync(dir,{recursive:true,force:true});}
},35000);

import capturedPath from './fixtures/plan-count-permission-target-ad-v2.json';
function pathCroppedFixture(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'count-path-cropped-'));
 // Retain the captured relative layout inside this run's disposable temp root.
 const relocate=(value:string)=>value.replaceAll(path.dirname(capturedPath.cwd),dir);
 const cwd=relocate(capturedPath.cwd),config=relocate(capturedPath.config),expected=relocate(capturedPath.expected);
 const screen=relocate(capturedPath.screen),sessionId=capturedPath.sessionId;
 const recorder=createFilePermissionRecorder(cwd,config,expected)!;const startedAt=Date.now()-1000;
 const transcript:any={status:'ready',calls:[],assistantMessages:[{sessionId,text:'Reviewing',timestamp:new Date().toISOString()}]};
 // The public screen/identity are retained; these hook events are synthetic.
 const record=(name:string,id:string)=>recordFilePermission(JSON.stringify({hook_event_name:name,tool_name:'Edit',session_id:sessionId,tool_use_id:id,cwd,transcript_path:path.join(config,'projects','owned',sessionId+'.jsonl'),tool_input:{file_path:expected}}),recorder.file,cwd,config,expected);
 const read=(viewport=screen)=>currentFilePermissionEpoch(recorder.file,expected,cwd,config,startedAt,transcript,viewport);
 return {recorder,startedAt,transcript,record,read,screen,expected,close(){recorder.dispose();fs.rmSync(dir,{recursive:true,force:true});}};
}
test('AD v2 retained path-only heading needs the exact current owned epoch',()=>{
 const f=pathCroppedFixture();try{
  expect(capturedPath.provenance.actualOutcome).toBe('timeout');
  expect(classifyPlanCountFrame(f.screen)).toBe('permission');
  expect(f.read()).toBeNull();f.record('PreToolUse','first');
  expect(f.read()?.pendingId).toBe(capturedPath.sessionId+':first');
  const guard=createPlanCountPermissionGuard();expect(guard(f.screen,'',f.read())).toBe('grant');
  expect(guard(f.screen,'',f.read())).toBe('handled');
 }finally{f.close();}
});

test('AD v2 path-only target retains native success and replay boundaries',()=>{
 const f=pathCroppedFixture();try{
  const guard=createPlanCountPermissionGuard();const read=()=>guard(f.screen,'',f.read());
  f.record('PreToolUse','first');expect(read()).toBe('grant');
  f.record('PostToolUseFailure','first');f.record('PreToolUse','second');expect(read()).toBe('handled');
  f.record('PostToolUse','second');f.record('PreToolUse','third');expect(read()).toBe('handled');
 }finally{f.close();}
 const g=pathCroppedFixture();try{
  const guard=createPlanCountPermissionGuard();g.record('PreToolUse','first');expect(guard(g.screen,'',g.read())).toBe('grant');
  g.record('PostToolUse','first');expect(guard(g.screen,'',g.read())).toBe('handled');
  g.record('PreToolUse','second');expect(guard(g.screen,'',g.read())).toBe('grant');
  g.record('PostToolUse','second');g.record('PreToolUse','first');expect(guard(g.screen,'',g.read())).toBe('handled');
 }finally{g.close();}
});

test('AD v2 path-only heading must agree with full menu target and current metadata',()=>{
 const f=pathCroppedFixture();try{
  f.record('PreToolUse','first');const screen=f.screen,lines=screen.split('\n');
  expect(f.read([f.expected,...lines.slice(1)].join('\n'))?.pendingId).toBe(capturedPath.sessionId+':first');
  const wrong=[
   [' ../sibling/'+path.basename(f.expected),...lines.slice(1)].join('\n'),
   [' '+f.expected+' extra',...lines.slice(1)].join('\n'),
   [lines[0],'/tmp/other/'+path.basename(f.expected),...lines.slice(1)].join('\n'),
   [lines[0],...lines.slice(2)].join('\n'),
   'Example:\n'+screen,'```text\n'+screen,screen+'\nContinue with a different action.',
   screen.replace('❯ 1. Yes','❯ 2. Yes'),screen.replace('Esc to cancel · Tab to amend','Esc to cancel'),
   screen.replace('always allow access to '+path.dirname(f.expected),'always allow access to /tmp/sibling'),
  ];
  for(const altered of wrong){expect(altered).not.toBe(screen);expect(f.read(altered)).toBeNull();}
  const valid=JSON.parse(fs.readFileSync(f.recorder.file,'utf8'));
  for(const delta of [{timestamp:new Date(f.startedAt-1).toISOString()},{sessionId:'foreign'},{pendingId:valid.completedId},{cwd:'/foreign'},{expected:'/foreign'}]){
   fs.writeFileSync(f.recorder.file,JSON.stringify({...valid,...delta}));expect(f.read()).toBeNull();
  }
 }finally{f.close();}
});

import {E2E_TOUCHFILES,selectTests} from './helpers/touchfiles';
import fs_batching_permission_at from 'node:fs';
import os_batching_permission_at from 'node:os';
import path_batching_permission_at from 'node:path';
import captured_batching_permission_at from './fixtures/batching-permission-at.json';
import fixture_design_crop_gutter_ap from './fixtures/design-crop-gutter-ap.json';
import previous_design_crop_gutter_ap from './fixtures/plan-count-crop-ak.json';
import capturedAd_plan_count_permission_ac from './fixtures/plan-count-permission-ad.json';
import capturedAe_plan_count_permission_ac from './fixtures/plan-count-permission-ae.json';
import capturedAh_plan_count_permission_ac from './fixtures/plan-count-permission-ah.json';
import { currentFilePermissionBinding } from './helpers/plan-count-file-permission';
import exact_plan_count_quoted_frame_ak from './fixtures/plan-count-quoted-frame-ak.json';
import owned_plan_count_quoted_frame_ak from './fixtures/plan-count-owned-permission-v.json';
describe('batching-permission-at', () => {
const fs = fs_batching_permission_at;
const os = os_batching_permission_at;
const path = path_batching_permission_at;
const captured = captured_batching_permission_at;
function renderPermissionScreen(expected: string, paths: Pick<typeof path, 'dirname' | 'basename'> = path): string {
 // The capture is already laid out at the runner's 120 columns. Replacing its
 // path must reflow that menu line, otherwise the PTY hard-wraps words in half.
 return captured.screen.split('\n').map(original => {
  const line = original.replaceAll(path.posix.dirname(captured.expectedPath), paths.dirname(expected))
   .replaceAll(path.posix.basename(captured.expectedPath), paths.basename(expected));
  if (line === original || line.length <= 120) return line;
  const indent = /^ */.exec(line)![0], lines: string[] = []; let current = indent;
  for (const word of line.trim().split(/\s+/)) {
   if (indent.length + word.length > 120) throw Error('Fixture path exceeds the permission panel width');
   if (current.length > indent.length && current.length + 1 + word.length > 120) { lines.push(current); current = indent; }
   current += (current.length > indent.length ? ' ' : '') + word;
  }
  return [...lines, current].join('\n');
 }).join('\n');
}

function fixture(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'batch-permission-')),cwd=path.join(dir,'cwd'),config=path.join(dir,'.claude'),expected=path.join(dir,'report.md');fs.mkdirSync(cwd);fs.writeFileSync(expected,'original');
 const recorder=createFilePermissionRecorder(cwd,config,expected)!;const startedAt=Date.now()-1000;
 const screen=renderPermissionScreen(expected);
 const transcript:any={status:'ready',calls:[],assistantMessages:[{sessionId:'synthetic-epoch',text:'Reviewing',timestamp:new Date().toISOString()}]};
 const record=(name:string,id:string,extra={})=>recordFilePermission(JSON.stringify({hook_event_name:name,tool_name:'Edit',session_id:'synthetic-epoch',tool_use_id:id,cwd,transcript_path:path.join(config,'projects','owned','synthetic-epoch.jsonl'),tool_input:{file_path:expected},...extra}),recorder.file,cwd,config,expected);
 const read=()=>currentFilePermissionEpoch(recorder.file,expected,cwd,config,startedAt,transcript,screen);
 return{dir,cwd,config,expected,recorder,screen,transcript,record,read,close(){recorder.dispose();fs.rmSync(dir,{recursive:true,force:true})}};
}

test('retained retry has a valid permission panel and real previous completion without a pending ID',()=>{
 expect(classifyPlanCountFrame(captured.screen)).toBe('permission');expect(captured.priorCompletedEdit[0]!.name).toBe('Edit');expect(captured.priorCompletedEdit[1]!.isError).toBe(false);
 expect(captured.pendingEditId).toBeNull();expect(captured.provenance.originalOutcome).toBe('timeout');expect(captured.provenance.paidOutcomeReclassified).toBe(false);
 const guard=createPlanCountPermissionGuard();expect(guard(captured.screen,captured.lastMatchedDisplayCompletion)).toBe('grant');expect(guard(captured.screen,captured.lastMatchedDisplayCompletion)).toBe('handled');
});

test('a substituted long fixture path reflows the menu without splitting permission words', () => {
 const prefix = '      always allow access to ', suffix = ' for this ';
 const directory = '/' + 'x'.repeat(120 - prefix.length - suffix.length - 3 - 1);
 const rawLine = `${prefix}${directory}${suffix}session`;
 expect(`${rawLine.slice(0, 120)}\n${rawLine.slice(120)}`).toContain('ses\nsion');
 for (const paths of [path.posix, path.win32]) {
  const expected = paths.join(directory, 'report.md');
  const screen = renderPermissionScreen(expected, paths);
  const menu = screen.slice(screen.indexOf(' Do you want to make this edit'));
  expect(menu.split('\n').every(line => line.length <= 120)).toBe(true);
  expect(menu).toContain(paths.dirname(expected));
  expect(menu).toContain('edit to report.md?');
  expect(menu).toMatch(/1\. Yes[\s\S]+2\. Yes,[\s\S]+3\. No/);
  expect(createPlanCountPermissionGuard()(screen, captured.lastMatchedDisplayCompletion)).toBe('grant');
 }
});

test('synthetic hook epochs release only the later exact request after its predecessor succeeds',()=>{
 const f=fixture();try{const guard=createPlanCountPermissionGuard(),input=()=>guard(f.screen,captured.lastMatchedDisplayCompletion,f.read());
 expect(input()).toBe('handled');f.record('PreToolUse','first');expect(input()).toBe('grant');expect(input()).toBe('handled');
 f.record('PostToolUse','first');expect(input()).toBe('handled');f.record('PreToolUse','first');expect(input()).toBe('handled');
 f.record('PreToolUse','second');expect(input()).toBe('grant');expect(input()).toBe('handled');f.record('PostToolUse','first');expect(input()).toBe('handled');
 }finally{f.close()}
});
for(const reason of ['failed','no-result','foreign-session','foreign-path','other-tool','sidechain'])test(`a later matching menu cannot replace ${reason} predecessor evidence`,()=>{
 const f=fixture();try{const guard=createPlanCountPermissionGuard(),input=()=>guard(f.screen,'',f.read());f.record('PreToolUse','first');expect(input()).toBe('grant');
 if(reason==='failed')f.record('PostToolUseFailure','first');else if(reason!=='no-result')f.record('PostToolUse','first',reason==='foreign-session'?{session_id:'foreign'}:reason==='foreign-path'?{tool_input:{file_path:path.join(f.dir,'foreign','report.md')}}:reason==='other-tool'?{tool_name:'Read'}:{agent_id:'child'});
 f.record('PreToolUse','second');expect(input()).toBe('handled');
 }finally{f.close()}
});
test.skipIf(process.platform==='win32')('real fake CLI observes two file epochs without imposing terminal report validation',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'batch-permission-pty-')),fake=path.join(dir,'fake-claude'),worker=path.join(dir,'worker.ts'),events=path.join(dir,'events.jsonl'),output=path.join(dir,'output.json'),expected=path.join(dir,'report.md');fs.writeFileSync(expected,'original');
 const screen=renderPermissionScreen(expected);
 fs.writeFileSync(fake,`#!${process.execPath}\n`+String.raw`
import * as fs from 'node:fs';import * as path from 'node:path';
const item=JSON.parse(process.env.FILE_EPOCH_CASE);const log=e=>fs.appendFileSync(item.events,JSON.stringify(e)+'\n');
const sid='epoch-main';const nativePath=path.join(process.env.CLAUDE_CONFIG_DIR,'projects','epoch',sid+'.jsonl');fs.mkdirSync(path.dirname(nativePath),{recursive:true});
const native=(role,content,extra={})=>fs.appendFileSync(nativePath,JSON.stringify({cwd:process.cwd(),sessionId:sid,isSidechain:false,timestamp:new Date().toISOString(),message:{role,content},...extra})+'\n');
native('assistant',[{type:'text',text:'Reviewing fixture.'}]);log({type:'start',pid:process.pid,cwd:process.cwd()});
const settings=JSON.parse(process.argv[process.argv.indexOf('--settings')+1]);
if(settings.hooks.PreToolUse[0].matcher!=='^ExitPlanMode$')throw Error('Exit recorder changed');
const hook=async(name,id)=>{
 const entries=(settings.hooks[name]??[]).filter(h=>h.matcher==='^(Write|Edit)$');
 if(entries.length!==1)throw Error('Expected exactly one caller-owned file recorder');
 for(const entry of entries){
 const event={hook_event_name:name,tool_name:'Edit',session_id:sid,tool_use_id:id,cwd:process.cwd(),transcript_path:nativePath,tool_input:{file_path:item.activePlan?path.join(process.cwd(),'PLAN.md'):item.expected,old_string:'old',new_string:'new'}};
 const p=Bun.spawn(['bash','-c',entry.hooks[0].command],{stdin:new Blob([JSON.stringify(event)]),stdout:'pipe',stderr:'pipe'});
 const [code,out,err]=await Promise.all([p.exited,new Response(p.stdout).text(),new Response(p.stderr).text()]);if(code||out||err)throw Error('hook was not silent');log({type:'hook',name,id});
 }
};
let stage='startup';const paint=()=>process.stdout.write('\x1b[2J\x1b[H'+item.screen.replaceAll('__ACTIVE_PLAN_PATH__',path.join(process.cwd(),'PLAN.md')).replaceAll('\n','\r\n'));
process.stdin.setRawMode?.(true);process.stdin.on('data',async data=>{
 const input=data.toString();log({type:'input',stage,input});
 if(stage==='startup'){stage='first';await hook('PreToolUse','first');paint();return;}
 if(stage==='old-pane'||stage==='done'){log({type:'unexpected'});return;}
 if(input!=='1\r')throw Error('default permission input changed');
 if(stage==='first'){stage='old-pane';await hook('PostToolUse','first');if(item.intervening){await hook('PreToolUse','automatic');await hook('PostToolUse','automatic');}paint();setTimeout(async()=>{await hook('PreToolUse','second');stage='second';paint();},3200);return;}
 stage='done';await hook('PostToolUse','second');
 const q={header:'Finding',question:'Apply this repair?',options:[{label:'Fix'},{label:'Keep'}]};
 native('assistant',[{type:'tool_use',name:'AskUserQuestion',id:'finding',input:{questions:[q]}}]);native('user',[{type:'tool_result',tool_use_id:'finding',content:'Answered'}],{toolUseResult:{answers:{[q.question]:'Fix'}}});
 process.stdout.write('\x1b[2J\x1b[HCompletion summary\r\n');
});process.on('SIGINT',()=>process.exit(0));process.stdin.resume();process.stdout.write('FILE_EPOCH_READY\r\n');
`);fs.chmodSync(fake,0o755);
 fs.writeFileSync(worker,`import {runPlanSkillCounting} from ${JSON.stringify(pathToFileURL(path.join(import.meta.dir,'helpers/claude-pty-runner.ts')).href)};const o=await runPlanSkillCounting({skillName:'plan-eng-review',slashCommand:'/plan-eng-review',followUpPrompt:'Review this disposable batching fixture.',permissionPlanPath:${JSON.stringify(expected)},startupReadyMarker:'FILE_EPOCH_READY',isLastStep0AUQ:()=>false,isReviewAUQ:()=>true,reviewCountCeiling:2,timeoutMs:28000,env:{FILE_EPOCH_CASE:${JSON.stringify(JSON.stringify({events,expected,screen}))}}});await Bun.write(${JSON.stringify(output)},JSON.stringify(o));`);
 const child=Bun.spawn([process.execPath,worker],{env:{...process.env,BROWSE_TERMINAL_BINARY:fake,EVALS_HERMETIC:'1'},stdout:'pipe',stderr:'pipe'});const killer=setTimeout(()=>child.kill('SIGKILL'),33000);
 try{const[code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);expect(code,out+err).toBe(0);
  const o=JSON.parse(fs.readFileSync(output,'utf8'));expect(o.outcome,JSON.stringify(o)).toBe('completion_summary');expect(o.reviewCount).toBe(1);expect(fs.readFileSync(expected,'utf8')).toBe('original');
  const rows=fs.readFileSync(events,'utf8').trim().split('\n').map(l=>JSON.parse(l));expect(rows.filter(e=>e.type==='input').map(e=>e.input)).toEqual(['/plan-eng-review\r','1\r','1\r']);expect(rows.some(e=>e.type==='unexpected')).toBe(false);
  expect(()=>process.kill(rows[0].pid,0)).toThrow();expect(fs.existsSync(rows[0].cwd)).toBe(false);
 }finally{clearTimeout(killer);child.kill('SIGKILL');if(fs.existsSync(events)){const first=JSON.parse(fs.readFileSync(events,'utf8').split('\n')[0]!);try{process.kill(first.pid,'SIGKILL');}catch{}}fs.rmSync(dir,{recursive:true,force:true});}
},35000);
});

describe('design-crop-gutter-ap', () => {
const fs = fs_batching_permission_at;
const os = os_batching_permission_at;
const path = path_batching_permission_at;
const fixture = fixture_design_crop_gutter_ap;
const previous = previous_design_crop_gutter_ap;
function replay(change:(f:any)=>void=()=>{},input:any=fixture){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'design-gutter-ap-'));
  const expected=path.join(dir,'report.md'),record=path.join(dir,'record.json');
  const f:any={expected,record,cwd:input.cwd,config:input.config,startedAt:input.startedAt,
    screen:input.screen.replaceAll(path.dirname(input.hook.expected),dir).replaceAll(path.basename(input.hook.expected),'report.md'),
    state:{...structuredClone(input.hook),expected},before:input.ownedBefore,transcript:structuredClone(input.transcript),fileKind:'file'};
  try{
    change(f);fs.writeFileSync(record,JSON.stringify(f.state));
    if(f.fileKind==='file')fs.writeFileSync(expected,f.before);
    if(f.fileKind==='directory')fs.mkdirSync(expected);
    if(f.fileKind==='symlink'){const target=path.join(dir,'other.md');fs.writeFileSync(target,f.before);fs.symlinkSync(target,expected);}
    const epoch=currentFilePermissionEpoch(record,f.expected,f.cwd,f.config,f.startedAt,f.transcript,f.screen);
    const guard=createPlanCountPermissionGuard();
    return {epoch,first:guard(f.screen,'',epoch),second:guard(f.screen,'',epoch)};
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
}

test('exact five-column current gutter supplies one owned Edit epoch and one grant',()=>{
  const lines=fixture.screen.split('\n');expect(lines[0]).toMatch(/^ {5}\S/);expect(lines[1]).toBe(' 62  ');
  expect(fixture.ownedBefore.split('\n')[60]!.endsWith(lines[0]!.slice(5))).toBe(true);
  const r=replay();expect(r.epoch).toEqual({pendingId:fixture.hook.pendingId,completedId:fixture.hook.completedId,completedIds:fixture.hook.completedIds});
  expect(r.first).toBe('grant');expect(r.second).toBe('handled');
});

test('prior six-column public crop remains exact and one-time',()=>{
  expect(previous.screen.split('\n')[0]).toMatch(/^ {6}\S/);expect(previous.screen.split('\n')[1]).toBe('  82  ');
  const r=replay(()=>{},previous);expect(r.epoch?.pendingId).toBe(previous.hook.pendingId);expect(r.first).toBe('grant');expect(r.second).toBe('handled');
  // Keep the existing six-space acceptance even when the adjacent numeric
  // row has a different padding; the unchanged original-line guard remains.
  expect(replay(f=>{f.screen=' '+f.screen;}).epoch?.pendingId).toBe(fixture.hook.pendingId);
});

test('padding and line-number width derive the continuation column together',()=>{
  const padded=replay(f=>{f.screen=' '+f.screen;f.screen=f.screen.replace(/^ 62  $/m,'  62  ');});
  expect(padded.epoch?.pendingId).toBe(fixture.hook.pendingId);
  const relocated=replay(f=>{
    f.before='Earlier unchanged line\n'.repeat(38)+f.before;
    f.screen=' '+f.screen;
    f.screen=f.screen.replace(/^ ([1-9]\d*)(  | [+-])/gm,(_:string,n:string,g:string)=>' '+(Number(n)+38)+g);
  });
  expect(relocated.epoch?.pendingId).toBe(fixture.hook.pendingId);
});

test.each([0,3])('a native numbered-row padding of %d derives a matching non-six gutter',padding=>{
  const r=replay(f=>{
    f.screen=' '.repeat(padding+4)+f.screen.slice(5);
    f.screen=f.screen.replace(/^ 62  $/m,' '.repeat(padding)+'62  ');
  });
  expect(r.epoch?.pendingId).toBe(fixture.hook.pendingId);expect(r.first).toBe('grant');
});

test('an ordinary numbered unchanged row remains a numbered row, not a wrapped continuation',()=>{
  const r=replay(f=>{
    f.screen=' 61  '+f.before.split('\n')[60]+'\n'+f.screen.slice(f.screen.indexOf('\n')+1);
  });
  expect(r.epoch?.pendingId).toBe(fixture.hook.pendingId);expect(r.first).toBe('grant');
});

const negatives:Array<[string,(f:any)=>void]>=[
  ['four-space gutter with five-column numbered row',f=>{f.screen=f.screen.slice(1);}],
  ['seven-space gutter with five-column numbered row',f=>{f.screen='  '+f.screen;}],
  ['tab cannot substitute for a native space gutter',f=>{f.screen='\t'+f.screen.slice(1);}],
  ['wrong preceding file line',f=>{f.screen=f.screen.replace(/^ 62  $/m,' 63  ');}],
  ['changed continuation content',f=>{f.screen=f.screen.replace('f2 with icon','foreign with icon');}],
  ['stale before-file bytes',f=>{f.before=f.before.replace('f2 with icon','changed with icon');}],
  ['quoted continuation',f=>{f.screen=f.screen.replace(/^ {5}/,'     > ');}],
  ['two unnumbered continuation rows',f=>{f.screen=f.screen.split('\n')[0]+'\n'+f.screen;}],
  ['next row is an addition, not unchanged context',f=>{f.screen=f.screen.replace(/^ 62  $/m,' 62 +');}],
  ['zero next line',f=>{f.screen=f.screen.replace(/^ 62  $/m,' 00  ');}],
  ['missing current file',f=>{f.fileKind='missing';}],
  ['directory instead of current file',f=>{f.fileKind='directory';}],
  ['required source line beyond the bounded prefix',f=>{f.before='x'.repeat(65537)+f.before;}],
  ['foreign displayed directory',f=>{f.screen=f.screen.replace(path.dirname(f.expected)+' for this session',path.join(path.dirname(f.expected),'foreign')+' for this session');}],
  ['foreign hook target',f=>{f.state.expected+='.foreign';}],
  ['foreign hook cwd',f=>{f.state.cwd+='.foreign';}],
  ['foreign native session',f=>{f.transcript={status:'ready',calls:[],assistantMessages:[{sessionId:'foreign',text:'Current review',timestamp:new Date(f.startedAt).toISOString()}]};}],
  ['missing pending request',f=>{f.state.pendingId=null;}],
  ['completed request cannot reopen',f=>{f.state.completedId=f.state.pendingId;}],
  ['stale request timestamp',f=>{f.state.timestamp=new Date(f.startedAt-1).toISOString();}],
  ['missing menu footer',f=>{f.screen=f.screen.replace('Esc to cancel · Tab to amend','');}],
  ['one-time action changed',f=>{f.screen=f.screen.replace('❯ 1. Yes','❯ 1. Yes, always allow');}],
];
test.each(negatives)('%s cannot obtain a grant',(_,change)=>{
  const r=replay(change);expect(r.epoch).not.toBeTruthy();expect(r.first).not.toBe('grant');
});
test.skipIf(process.platform==='win32')('symlink cannot provide the original line',()=>{expect(replay(f=>{f.fileKind='symlink';}).epoch).toBeNull();});
});

describe('plan-count-crop-ak', () => {
const fs = fs_batching_permission_at;
const os = os_batching_permission_at;
const path = path_batching_permission_at;
const fixture = previous_design_crop_gutter_ap;
function replay(change: (f: any) => void = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-crop-ak-'));
  const expected = path.join(dir, 'report.md'), record = path.join(dir, 'record.json');
  const f: any = { expected, record, screen: fixture.screen.replaceAll(path.dirname(fixture.hook.expected), dir)
    .replaceAll(path.basename(fixture.hook.expected), 'report.md'), state: { ...structuredClone(fixture.hook), expected },
    before: fixture.ownedBefore, cwd: fixture.cwd, config: fixture.config, startedAt: fixture.startedAt,
    transcript: structuredClone(fixture.transcript), fileKind: 'file' };
  try {
    change(f); fs.writeFileSync(record, JSON.stringify(f.state));
    if (f.fileKind === 'file') fs.writeFileSync(expected, f.before);
    if (f.fileKind === 'directory') fs.mkdirSync(expected);
    if (f.fileKind === 'symlink') { const other = path.join(dir, 'other.md'); fs.writeFileSync(other, f.before); fs.symlinkSync(other, expected); }
    const epoch = currentFilePermissionEpoch(record, f.expected, f.cwd, f.config, f.startedAt, f.transcript, f.screen);
    return { epoch, screen: f.screen, guard: createPlanCountPermissionGuard(), run: () => createPlanCountPermissionGuard()(f.screen, '', epoch) };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('actual owned bare continuation uses the preceding original line and grants once', () => {
  const r = replay();
  expect(r.epoch?.pendingId).toBe(fixture.hook.pendingId);
  expect(r.guard(r.screen, '', r.epoch)).toBe('grant');
  expect(r.guard(r.screen, '', r.epoch)).toBe('handled');
});

test('harmless preceding line number relocation keeps the exact content binding', () => {
  const r = replay(f => {
    f.before = 'Added unchanged line\n' + f.before;
    f.screen = f.screen.replace(/^ {0,3}82 +$/m, ' 83  ');
  });
  expect(r.epoch?.pendingId).toBe(fixture.hook.pendingId);
});

const negatives: Array<[string, (f: any) => void]> = [
  ['wrong preceding line', f => { f.screen = f.screen.replace(/^ {0,3}82 +$/m, ' 83  '); }],
  ['unrelated prose continuation', f => { f.screen = f.screen.replace(/^.*\n/, '      Apply this edit now\n'); }],
  ['source quotation continuation', f => { f.screen = f.screen.replace(/^.*\n/, '      > Example: apply this edit now\n'); }],
  ['foreign continuation suffix', f => { f.screen = f.screen.replace('f2 (~7.6:1)', 'foreign (~7.6:1)'); }],
  ['five-space unnumbered gutter', f => { f.screen = f.screen.slice(1); }],
  ['seven-space unnumbered gutter', f => { f.screen = ' ' + f.screen; }],
  ['no following unchanged numbered row', f => { f.screen = f.screen.replace(/^ {0,3}82 +$/m, ' 82 +'); }],
  ['two arbitrary continuation rows', f => { f.screen = f.screen.split('\n')[0] + '\n' + f.screen; }],
  ['missing original file', f => { f.fileKind = 'missing'; }],
  ['directory in place of original file', f => { f.fileKind = 'directory'; }],
  ['required original line beyond the bounded prefix', f => { f.before = 'x'.repeat(65537) + f.before; }],
  ['foreign displayed directory', f => { f.screen = f.screen.replace(path.dirname(f.expected) + ' for this session', path.join(path.dirname(f.expected), 'foreign') + ' for this session'); }],
  ['foreign hook expected path', f => { f.state.expected += '.foreign'; }],
  ['no current native request', f => { f.state.pendingId = null; }],
  ['completed native request', f => { f.state.completedId = f.state.pendingId; }],
  ['stale native timestamp', f => { f.state.timestamp = new Date(f.startedAt - 1).toISOString(); }],
  ['future native timestamp', f => { f.state.timestamp = new Date(Date.now() + 60000).toISOString(); }],
  ['foreign session transcript', f => { f.transcript.assistantMessages[0].sessionId = 'foreign'; }],
  ['unavailable native transcript', f => { f.transcript.status = 'error'; }],
  ['missing complete menu footer', f => { f.screen = f.screen.replace('Esc to cancel · Tab to amend', ''); }],
  ['selected policy change', f => { f.screen = f.screen.replace('❯ 1. Yes', '❯ 1. Yes, always allow'); }],
  ['unrelated prompt prepended', f => { f.screen = '☐ Review this example\n' + f.screen; }],
  ['historical pane is not current viewport', f => { f.screen = 'Waiting for current tool'; }],
];
test.each(negatives)('%s cannot supply an owned epoch', (_, change) => {
  const r = replay(change); expect(r.epoch).not.toBeTruthy(); expect(r.run()).not.toBe('grant');
});
test.skipIf(process.platform === 'win32')('a symlink cannot supply current original content', () => {
  expect(replay(f => { f.fileKind = 'symlink'; }).epoch).toBeNull();
});
});

describe('plan-count-permission-ac', () => {
const captured = capturedAc;
const capturedAd = capturedAd_plan_count_permission_ac;
const capturedAe = capturedAe_plan_count_permission_ac;
const capturedAh = capturedAh_plan_count_permission_ac;
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'count-permission-ac-'));
  const cwd = path.join(dir, 'cwd'), config = path.join(dir, '.claude');
  const expected = path.join(dir, 'report.md'), file = path.join(dir, 'state.json');
  fs.mkdirSync(cwd); const startedAt = Date.now() - 1000;
  const screen = captured.rows[0]!.screen
    .replace('../gstack-e2e-plan-design-3vPM9g/gstack-test-plan-design.md', expected)
    .replaceAll('gstack-test-plan-design.md', 'report.md');
  const transcript: any = { status: 'ready', calls: [], assistantMessages: [{ sessionId: 'main', text: 'Reviewing' }] };
  const record = (name: string, id: string, delta: object = {}) => recordFilePermission(JSON.stringify({
    hook_event_name: name, tool_name: 'Edit', session_id: 'main', tool_use_id: id, cwd,
    transcript_path: path.join(config, 'projects', 'owned', 'main.jsonl'),
    tool_input: { file_path: expected, old_string: 'PRIVATE_OLD', new_string: 'PRIVATE_NEW' }, ...delta,
  }), file, cwd, config, expected);
  const epoch = () => currentFilePermissionEpoch(file, expected, cwd, config, startedAt, transcript, screen);
  return { dir, cwd, config, expected, file, screen, record, epoch,
    close: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('all five actual stalled screens already identify an edit permission', () => {
  for (const row of captured.rows) {
    expect(classifyPlanCountFrame(row.screen), row.attempt).toBe('permission');
    expect(createPlanCountPermissionGuard()(row.screen), row.attempt).toBe('grant');
    expect(row.hook.pendingId).not.toBeNull();
    expect(row.transcriptSessions).toEqual([row.hook.sessionId]);
  }
});

test('an intervening successful edit does not erase the exact previous grant completion', () => {
  const f = fixture(); try {
    const guard = createPlanCountPermissionGuard(), input = () => guard(f.screen, '', f.epoch());
    f.record('PreToolUse', 'granted'); expect(input()).toBe('grant');
    f.record('PostToolUse', 'granted'); expect(input()).toBe('handled');
    f.record('PreToolUse', 'automatic'); f.record('PostToolUse', 'automatic');
    // Old pane is still inert, even after two successful results.
    expect(input()).toBe('handled');
    f.record('PreToolUse', 'next'); expect(input()).toBe('grant'); expect(input()).toBe('handled');
    expect(fs.readFileSync(f.file, 'utf8')).not.toContain('PRIVATE_');
  } finally { f.close(); }
});

test('an unrelated success cannot substitute for failed or missing prior approval completion', () => {
  for (const outcome of ['PostToolUseFailure', 'missing', 'foreign', 'other-path', 'sidechain']) {
    const f = fixture(); try {
      const guard = createPlanCountPermissionGuard(), input = () => guard(f.screen, '', f.epoch());
      f.record('PreToolUse', 'granted'); expect(input()).toBe('grant');
      if (outcome === 'PostToolUseFailure') f.record(outcome, 'granted');
      else if (outcome !== 'missing') f.record('PostToolUse', 'granted', outcome === 'foreign'
        ? { session_id: 'foreign' } : outcome === 'sidechain' ? { agent_id: 'child' }
        : { tool_input: { file_path: path.join(f.dir, 'other.md') } });
      f.record('PreToolUse', 'automatic'); f.record('PostToolUse', 'automatic');
      f.record('PreToolUse', 'next'); expect(input(), outcome).toBe('handled');
      f.record('PreToolUse', 'granted'); expect(input(), outcome).toBe('handled');
    } finally { f.close(); }
  }
});

test('success history rejects malformed, foreign, replayed, and pending IDs', () => {
  const f = fixture(); try {
    f.record('PreToolUse', 'first'); f.record('PostToolUse', 'first'); f.record('PreToolUse', 'next');
    const original = JSON.parse(fs.readFileSync(f.file, 'utf8'));
    for (const completedIds of [['foreign:first'], ['main:../escape'], ['main:next'],
      ['main:first', 'main:first'], Array(129).fill('main:first'), ['main:unseen'], 'main:first']) {
      fs.writeFileSync(f.file, JSON.stringify({ ...original, completedIds }));
      expect(f.epoch()).toBeNull();
    }
  } finally { f.close(); }
});

test('success history is bounded by the existing 128-request recorder limit', () => {
  const f = fixture(); try {
    for (let i = 0; i < 127; i++) { f.record('PreToolUse', `id${i}`); f.record('PostToolUse', `id${i}`); }
    f.record('PreToolUse', 'last'); expect(f.epoch()?.completedIds?.length).toBe(127);
    expect(fs.statSync(f.file).size).toBeLessThan(64 * 1024);
    f.record('PreToolUse', 'overflow'); expect(f.epoch()).toBeNull();
  } finally { f.close(); }
});

test('cropped actual panes bind their full directory and basename to the current native epoch', () => {
  const rows = captured.rows.filter(row => [4, 5].includes(row.job) && !/^ {0,3}Edit file$/m.test(row.screen));
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    const f = fixture(); try {
      const screen = row.screen.replaceAll(path.dirname(row.hook.expected), path.dirname(f.expected))
        .replaceAll(path.basename(row.hook.expected), path.basename(f.expected));
      const read = (value = screen) => currentFilePermissionEpoch(f.file, f.expected, f.cwd, f.config,
        0, { status: 'ready', calls: [], assistantMessages: [{ sessionId: 'main', text: 'Reviewing', timestamp: new Date().toISOString() }] }, value);
      f.record('PreToolUse', 'current');
      expect(read()?.pendingId, row.attempt).toBe('main:current');
      const guard = createPlanCountPermissionGuard();
      expect(guard(screen, '', read())).toBe('grant');
      expect(guard(screen, '', read())).toBe('handled');
      for (const [name, changed] of [
        ['foreign', screen.replace(path.dirname(f.expected), path.join(f.dir, 'foreign'))],
        ['remedy', screen.replace(/always\s+allow\s+access\s+to/, 'remove files from')],
        ['footer', screen.replace('Esc to cancel · Tab to amend', '')],
        ['yes policy', screen.replace(/❯\s*1\.\s*Yes/, '❯ 1. Yes, change policy')],
        ['AUQ', '☐ Finding\n' + screen],
        ['quoted', '> Example:\n' + screen],
        ['wrapped path', screen.replace(path.dirname(f.expected), path.dirname(f.expected) + '\n/other')],
        ['path spaces', screen.replace(path.dirname(f.expected), path.dirname(f.expected) + ' space')],
      ]) {
        expect(changed, name).not.toBe(screen);
        expect(read(changed), name).toBeNull();
      }
      expect(read(screen.replace(path.dirname(f.expected), path.join(f.dir, 'foreign')))).toBeNull();
      f.record('PostToolUse', 'current'); expect(read()).toBeNull();
      f.record('PreToolUse', 'current'); expect(read()).toBeNull();
    } finally { f.close(); }
  }
});
test('a later exact owned binding wins over an earlier same-basename block', () => {
  const f = fixture(); try {
    f.record('PreToolUse', 'current');
    const transcript: any = {status:'ready', calls:[], assistantMessages:[{sessionId:'main', text:'Reviewing'}]};
    const foreign = {file:path.join(f.dir,'foreign-state.json'), expected:path.join(f.dir,'other','report.md')};
    const owned = {file:f.file, expected:f.expected};
    for (const bindings of [[foreign, owned], [owned, foreign]]) {
      const selected = currentFilePermissionBinding(bindings, f.cwd, f.config, 0, transcript, f.screen);
      expect(selected?.binding).toBe(owned);
      expect(selected?.epoch.pendingId).toBe('main:current');
    }
    const blocked = currentFilePermissionBinding([foreign, {...foreign, expected:path.join(f.dir,'another','report.md')}],
      f.cwd, f.config, 0, transcript, f.screen);
    expect(blocked).toBeNull();
    expect(createPlanCountPermissionGuard()(f.screen, '', blocked)).toBe('handled');
    const otherScreen = f.screen.replaceAll('report.md', 'OTHER.md');
    const unrelated = currentFilePermissionBinding([foreign, owned], f.cwd, f.config, 0, transcript, otherScreen);
    expect(unrelated).toBeUndefined();
    expect(createPlanCountPermissionGuard()(otherScreen, '', unrelated)).toBe('grant');
  } finally { f.close(); }
});

// Exact current screens plus content-free native identity from full AD/AE runs.
// The replay projections do not assert these pending writes ever completed.
const cases = [...capturedAd.rows, capturedAe, capturedAh].map(row => ({
  p: row, screen: row.screen, binding: {expected: row.state.expected, state: row.state},
  observation: {transcript: {status: row.transcriptStatus, calls: [],
    assistantMessages: row.transcriptSessions.map(sessionId => ({sessionId}))}},
}));
function adEpoch(c: any, screen = c.screen, state = c.binding.state, delta: any = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-crop-replay-'));
  const file = path.join(dir, 'state.json');
  try {
    // Captures contain POSIX paths. Project their filesystem identity onto the
    // replay host without changing the captured fixture or its menu rendering.
    const nativeState = { ...state, cwd: path.resolve(state.cwd), expected: path.resolve(state.expected),
      transcriptPath: path.resolve(state.transcriptPath) };
    const replayScreen = screen.replaceAll(path.posix.dirname(c.binding.expected),
      path.dirname(path.resolve(c.binding.expected)));
    fs.writeFileSync(file, JSON.stringify(nativeState));
    return currentFilePermissionEpoch(file, path.resolve(delta.expected ?? c.binding.expected), path.resolve(delta.cwd ?? c.p.cwd),
      path.resolve(delta.config ?? c.p.config), delta.startedAt ?? c.p.startUnix * 1000,
      delta.transcript ?? c.observation.transcript, replayScreen);
  } finally { fs.rmSync(dir, {recursive:true, force:true}); }
}
for (const c of cases) {
  test(`actual AD captured current permission ${c.p.pid} returns its exact pending epoch`, () => {
    expect(classifyPlanCountFrame(c.screen)).toBe('permission');
    expect(adEpoch(c)).toEqual({pendingId:c.binding.state.pendingId, completedId:c.binding.state.completedId,
      completedIds:c.binding.state.completedIds});
    const guard = createPlanCountPermissionGuard();
    expect(guard(c.screen, '', adEpoch(c))).toBe('grant');
    expect(guard(c.screen, '', adEpoch(c))).toBe('handled');
  });
  test(`AD isolating the rejected rendering guard ${c.p.pid} preserves native identity`, () => {
    // These are explicitly normalized controls; the actual captured screen is unchanged above.
    const normalized = c.p.pid === capturedAe.pid ? c.screen.replace(/^[╌─━]{3,}[ \t]*\n/, '')
      : c.p.pid === 1332470 ? c.screen.replace('3. Nohift+tab)', '3. No') : c.screen.replace(/^ {4,5}\+/, ' 99 +');
    expect(normalized).not.toBe(c.screen);
    expect(adEpoch(c, normalized)?.pendingId).toBe(c.binding.state.pendingId);
  });
}
for (const c of cases) {
  test(`AD crop ${c.p.pid} rejects foreign, quoted, incomplete and policy-changing menus`, () => {
    const directory = path.dirname(c.binding.expected);
    const changes: [string, string][] = [
      ['foreign directory', c.screen.replace(directory, path.join(directory, 'foreign'))],
      ['split directory', c.screen.replace(directory, directory + '\n/foreign')],
      ['quoted', '> Example:\n' + c.screen],
      ['AUQ', '☐ Review\n' + c.screen],
      ['code fence', '```\n' + c.screen],
      ['missing footer', c.screen.replace('Esc to cancel · Tab to amend', '')],
      ['policy on selected Yes', c.screen.replace('❯ 1. Yes', '❯ 1. Yes, always allow')],
      ['selected No', c.screen.replace('❯ 1. Yes', '  1. Yes').replace('   3. No', ' ❯ 3. No')],
      ['arbitrary No suffix', c.screen.replace(/3\. No(?:hift\+tab\))?/, '3. No; run another command')],
      ['another hint', c.screen.replace(/3\. No(?:hift\+tab\))?/, '3. No(shift+enter)')],
      ['foreign option action', c.screen.replace(/always\s+allow\s+access\s+to/, 'delete files from')],
      ['unrecognized cropped prose', c.screen.replace(/^.*\n/, 'arbitrary text\n')],
    ];
    for (const [name, screen] of changes) {
      expect(screen, name).not.toBe(c.screen);
      expect(adEpoch(c, screen), name).not.toBeTruthy();
      expect(createPlanCountPermissionGuard()(screen, '', adEpoch(c, screen)), name).not.toBe('grant');
    }
  });
  test(`AD crop ${c.p.pid} leaves unrelated-basename permission policy unchanged`, () => {
    const screen = c.screen.replace(path.basename(c.binding.expected), 'OTHER.md');
    expect(adEpoch(c, screen)).toBeUndefined();
    // This is intentionally the existing caller policy for unrelated fixture permissions.
    expect(createPlanCountPermissionGuard()(screen, '', adEpoch(c, screen))).toBe('grant');
  });
  test(`AD crop ${c.p.pid} cannot replace missing, stale, completed or foreign native identity`, () => {
    const original = c.binding.state;
    for (const [name, state, delta] of [
      ['foreign session', {...original, sessionId:'foreign'}, {}],
      ['wrong native transcript', {...original, transcriptPath:path.join(c.p.config, 'projects', 'foreign', 'other.jsonl')}, {}],
      ['completed request', {...original, completedId:original.pendingId}, {}],
      ['no pending request', {...original, pendingId:null}, {}],
      ['unseen pending request', {...original, pendingId:original.sessionId + ':other'}, {}],
      ['stale timestamp', {...original, timestamp:new Date(c.p.startUnix * 1000 - 1).toISOString()}, {}],
      ['future timestamp', {...original, timestamp:new Date(Date.now() + 60_000).toISOString()}, {}],
      ['mixed sessions', original, {transcript:{status:'ready', calls:[], assistantMessages:[{sessionId:original.sessionId},{sessionId:'foreign'}]}}],
      ['unready transcript', original, {transcript:{...c.observation.transcript,status:'unavailable'}}],
    ] as const) {
      expect(adEpoch(c, c.screen, state, delta), name).toBeNull();
    }
  });
}
test('AE crop admits one native divider only', () => {
  const c = cases.find(item => item.p.pid === capturedAe.pid)!;
  const firstLine = c.screen.slice(0, c.screen.indexOf('\n') + 1);
  for (const screen of [firstLine + c.screen, 'unrelated prose\n' + c.screen,
    firstLine + 'Example:\n' + c.screen.slice(firstLine.length),
    c.screen.replace(firstLine, firstLine.trimEnd() + ' extra action\n')]) {
    expect(adEpoch(c, screen)).toBeNull();
    expect(createPlanCountPermissionGuard()(screen, '', adEpoch(c, screen))).not.toBe('grant');
  }
});

test('AH wrapped crop admits four or five spaces with the same owned native epoch', () => {
  const c = cases.find(item => item.p.pid === capturedAh.pid)!;
  expect(c.screen.startsWith('    + ')).toBe(true);
  for (const screen of [c.screen, ` ${c.screen}`, c.screen.replace(/^    \+/, '    -')]) {
    expect(adEpoch(c, screen)?.pendingId).toBe(c.binding.state.pendingId);
    const guard = createPlanCountPermissionGuard();
    expect(guard(screen, '', adEpoch(c, screen))).toBe('grant');
    expect(guard(screen, '', adEpoch(c, screen))).toBe('handled');
  }
  // Cleaning the unselected No paint residue does not establish missing identity.
  const noOnly = c.screen.replace('3. Nohift+tab)', '3. No');
  expect(noOnly).not.toBe(c.screen);
  expect(adEpoch(c, noOnly)?.pendingId).toBe(c.binding.state.pendingId);
});

test('AH continuation crop rejects prose, unsupported gutters and malformed numbered context', () => {
  const c = cases.find(item => item.p.pid === capturedAh.pid)!;
  for (const [name, screen] of [
    ['four-space prose', c.screen.replace(/^.*\n/, '    Apply this edit now\n')],
    ['four-space quoted prose', c.screen.replace(/^.*\n/, '    > Example\n')],
    ['three-space gutter', c.screen.slice(1)],
    ['six-space gutter', `  ${c.screen}`],
    ['no numbered rows', c.screen.replace(/^\s*\d+\s+(?=[+\- ])/gm, '    +')],
    ['one numbered row', c.screen.replace(/^(\s*\d+\s+)(?=[+\- ])/gm,
      (prefix, _group, offset) => offset === c.screen.indexOf(' 79 ') ? prefix : '    +')],
  ]) {
    expect(screen, name).not.toBe(c.screen);
    expect(adEpoch(c, screen), name).toBeNull();
    expect(createPlanCountPermissionGuard()(screen, '', adEpoch(c, screen)), name).not.toBe('grant');
  }
  expect(selectTests(['test/fixtures/plan-count-permission-ah.json'], E2E_TOUCHFILES).selected.sort()).toEqual(
    selectTests(['test/fixtures/plan-count-permission-ae.json'], E2E_TOUCHFILES).selected.sort());
});
});

describe('plan-count-quoted-frame-ak', () => {
const fs = fs_batching_permission_at;
const os = os_batching_permission_at;
const path = path_batching_permission_at;
const exact = exact_plan_count_quoted_frame_ak;
const native = capturedAc;
const owned = owned_plan_count_quoted_frame_ak;
const quote=(s:string)=>s.split('\n').map(row=>'> '+row).join('\n');

// A PTY transports bytes, not command-sized stdin events. Share the framing
// code with the fake CLI so fragmented grants exercise the same receiver.
function commandBuffer(){
 let pending='';
 return (chunk:string)=>{
  pending+=chunk;const commands:string[]=[];let end:number;
  while((end=pending.indexOf('\r'))!==-1){commands.push(pending.slice(0,end+1));pending=pending.slice(end+1);}
  return commands;
 };
}
test('fake CLI preserves command bytes across fragmented and coalesced PTY input',()=>{
 const expected=['/plan-ceo-review\r','1\r'];
 for(const chunks of [expected,['/plan-ceo-review\r','1','\r'],[...expected.join('')],[expected.join('')]]){
  const receive=commandBuffer();expect(chunks.flatMap(receive)).toEqual(expected);
 }
 const receive=commandBuffer();
 expect(receive('1')).toEqual([]);expect(receive('\r2\rtrailing')).toEqual(['1\r','2\r']);
 expect(receive('\r')).toEqual(['trailing\r']); // no unexpected bytes are discarded
});

test('the exact wholly quoted AK pane is handled so the dispatcher sends no fallback',()=>{
 const screen=quote(exact.screen);
 expect(classifyPlanCountFrame(screen)).toBe('permission');
 expect(createPlanCountPermissionGuard()(screen,'',undefined)).toBe('handled');
});
test('quoted whole native frames remain inert across redraw, indentation, CRLF and terminal color',()=>{
 for(const source of [exact.screen,native.rows[0]!.screen,owned.screen])for(const transform of [
  (s:string)=>quote(s),(s:string)=>'\n'+quote(s)+'\n',(s:string)=>quote(s).replace(/^>/gm,'  >'),
  (s:string)=>quote(s).replaceAll('\n','\r\n'),(s:string)=>'\x1b[31m'+quote(s)+'\x1b[0m',
  ]){const s=transform(source),g=createPlanCountPermissionGuard();
   const expected=classifyPlanCountFrame(s)==='permission'?'handled':null;
   expect(g(s,'')).toBe(expected);expect(g(s,'⎿ Wrote 4 lines\n')).toBe(expected);}
});
test('quoted history cannot consume or authorize the current native grant',()=>{
 const s=native.rows[0]!.screen,g=createPlanCountPermissionGuard(),q=quote(s);
 expect(g(q,'')).toBe('handled');expect(g(s,q)).toBe('grant');expect(g(q,s)).toBe('handled');expect(g(s,q)).toBe('handled');
 expect(createPlanCountPermissionGuard()(s,'',null)).toBe('handled');
 expect(createPlanCountPermissionGuard()(s,'',{pendingId:'main:first',completedId:null})).toBe('grant');
 expect(createPlanCountPermissionGuard()(q,'',{pendingId:'main:first',completedId:null})).toBe('handled');
});
test('unquoted current native frames retain their policy even with quote characters in diff text or history',()=>{
 for(const s of native.rows.map(row=>row.screen))expect(createPlanCountPermissionGuard()(s,quote(s))).toBe('grant');
 expect(createPlanCountPermissionGuard()('> An old note\n'+native.rows[0]!.screen,'')).toBe('grant');
 expect(createPlanCountPermissionGuard()('No current pane',quote(exact.screen))).toBeNull();
 expect(createPlanCountPermissionGuard()('> Ordinary quoted prose, without a permission menu')).toBeNull();
});
test.skipIf(process.platform==='win32')('real dispatcher ignores quoted pane then grants the fresh owned native request once',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'count-quoted-frame-')),fake=path.join(dir,'fake-claude'),worker=path.join(dir,'worker.ts'),events=path.join(dir,'events.jsonl'),output=path.join(dir,'result.json'),report=path.join(dir,'report.md');
 fs.writeFileSync(report,'original');
 fs.writeFileSync(fake,`#!${process.execPath}\nconst receive=(${commandBuffer.toString()})();\n`+String.raw`
import fs from 'node:fs';import path from 'node:path';
const item=JSON.parse(process.env.QUOTED_FRAME_CASE),sid='quoted-frame-main',log=e=>fs.appendFileSync(item.events,JSON.stringify(e)+'\n');
const transcript=path.join(process.env.CLAUDE_CONFIG_DIR,'projects','owned',sid+'.jsonl');fs.mkdirSync(path.dirname(transcript),{recursive:true});
const native=(role,content,extra={})=>fs.appendFileSync(transcript,JSON.stringify({cwd:process.cwd(),sessionId:sid,isSidechain:false,timestamp:new Date().toISOString(),message:{role,content},...extra})+'\n');
native('assistant',[{type:'text',text:'Reviewing the owned fixture.'}]);log({type:'start',pid:process.pid,cwd:process.cwd()});
const settings=JSON.parse(process.argv[process.argv.indexOf('--settings')+1]);
const hook=async name=>{for(const entry of settings.hooks[name]??[]){if(entry.matcher!=='^(Write|Edit)$')continue;
 const event={hook_event_name:name,tool_name:'Edit',session_id:sid,tool_use_id:'current',cwd:process.cwd(),transcript_path:transcript,tool_input:{file_path:item.report}};
 const p=Bun.spawn(['bash','-c',entry.hooks[0].command],{stdin:new Blob([JSON.stringify(event)]),stdout:'pipe',stderr:'pipe'});
 const [code,out,err]=await Promise.all([p.exited,new Response(p.stdout).text(),new Response(p.stderr).text()]);if(code||out||err)throw Error('Hook failed');}};
const pane=item.screen.replaceAll('PLAN.md',item.report),paint=s=>process.stdout.write('\x1b[2J\x1b[H'+s.replaceAll('\n','\r\n'));
let stage='startup';process.stdin.setRawMode?.(true);const dispatch=async input=>{
 log({type:'input',stage,input});
 if(stage==='startup'){stage='quoted';paint(item.quotedScreen);setTimeout(async()=>{await hook('PreToolUse');stage='current';paint(pane);},4200);return;}
 if(stage!=='current'){log({type:'unexpected'});return;}
 if(input!=='1\r')throw Error('One-time grant changed');stage='done';await hook('PostToolUse');
 const q={header:'Finding',question:'Apply the reviewed fix?',options:[{label:'Fix'},{label:'Keep'}]};
 native('assistant',[{type:'tool_use',name:'AskUserQuestion',id:'finding',input:{questions:[q]}}]);native('user',[{type:'tool_result',tool_use_id:'finding',content:'Answered'}],{toolUseResult:{answers:{[q.question]:'Fix'}}});paint('Done.\n');
};process.stdin.on('data',async data=>{const chunk=data.toString();log({type:'chunk',stage,input:chunk});for(const input of receive(chunk))await dispatch(input);});process.on('SIGINT',()=>process.exit(0));process.stdin.resume();
process.stdout.write('PTY_READY:'+item.events+'\x1b[2J\x1b[H');
`);fs.chmodSync(fake,0o755);
 // Keep every physical terminal row inside the quote; adding a prefix to an
 // already120-column capture would otherwise wrap an unquoted continuation.
 const quotedScreen=exact.screen.split('\n').flatMap(row=>row.trimEnd().match(/.{1,116}/gu)??['']).map(row=>'> '+row).join('\n');
 const args={skillName:'plan-ceo-review',slashCommand:'/plan-ceo-review',followUpPrompt:'Review the disposable fixture.',expectedPlanPath:report,reviewCountCeiling:1,timeoutMs:25000,startupReadyMarker:'PTY_READY:'+events,env:{QUOTED_FRAME_CASE:JSON.stringify({events,report,screen:owned.screen,quotedScreen})}};
 fs.writeFileSync(worker,`import {runPlanSkillCounting} from ${JSON.stringify(pathToFileURL(path.join(import.meta.dir,'helpers/claude-pty-runner.ts')).href)};const result=await runPlanSkillCounting({...${JSON.stringify(args)},isLastStep0AUQ:()=>false,isReviewAUQ:()=>true});await Bun.write(${JSON.stringify(output)},JSON.stringify(result));`);
 const child=Bun.spawn([process.execPath,worker],{env:{...process.env,BROWSE_TERMINAL_BINARY:fake,EVALS_HERMETIC:'1'},stdout:'pipe',stderr:'pipe'}),timer=setTimeout(()=>child.kill('SIGKILL'),30000);
 try{const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);expect(code,out+err).toBe(0);
  const result=JSON.parse(fs.readFileSync(output,'utf8')),rows=fs.readFileSync(events,'utf8').trim().split('\n').map(s=>JSON.parse(s));
  expect(result.outcome,JSON.stringify({result,rows})).toBe('ceiling_reached');expect(result.reviewCount).toBe(1);
  const chunks=rows.filter(r=>r.type==='chunk');
  expect(chunks.every(r=>['startup','current'].includes(r.stage))).toBe(true);
  expect(chunks.map(r=>r.input).join('')).toBe('/plan-ceo-review\r1\r');
  expect(rows.filter(r=>r.type==='input').map(r=>[r.stage,r.input])).toEqual([['startup','/plan-ceo-review\r'],['current','1\r']]);expect(rows.some(r=>r.type==='unexpected')).toBe(false);
  expect(()=>process.kill(rows[0].pid,0)).toThrow();expect(fs.existsSync(rows[0].cwd)).toBe(false);
 }finally{clearTimeout(timer);child.kill('SIGKILL');await child.exited;
  if(fs.existsSync(events)){const first=JSON.parse(fs.readFileSync(events,'utf8').split('\n')[0]!);try{if(fs.readFileSync('/proc/'+first.pid+'/cmdline','utf8').split('\0').includes(fake))process.kill(first.pid,'SIGKILL');}catch{}}
  fs.rmSync(dir,{recursive:true,force:true});}
},32000);
});

/**
 * plan-ceo-finding-floor, E2E Evals census 42252633016 paid-slice-7-a1 (main cf4d847e): the model rewrote its
 * owned working plan with Write, Claude Code showed a cropped "Do you want to overwrite ...?" diff, and no owned
 * binding came back, so the floor actor left the menu unanswered for 20 s (permission_unanswered). The overwrite
 * now binds like a cropped Create: to the sole pending owned Write, with every visible diff row checked against
 * the current file bytes ('-') and the pending content ('+' and unchanged rows).
 */
describe('cropped overwrite of the owned working plan', () => {
  const captured = overwriteCaptured;
  const sessionId = '61cc3af3-2822-44d8-9003-f1ebf5696b47', id = 'toolu_013g2nXtwb4Kt8Jv8QSr4ku9';

  function fixture(options: {before?: string; content?: string; hookContent?: string} = {}) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'overwrite-pane-')));
    const cwd = path.join(dir, 'cwd'), config = path.join(dir, 'config');
    fs.mkdirSync(cwd);
    const expected = path.join(cwd, captured.basename);
    fs.writeFileSync(expected, options.before ?? captured.before);
    const journal = path.join(config, 'projects', 'owned', sessionId + '.jsonl');
    fs.mkdirSync(path.dirname(journal), {recursive: true});
    const recorder = createFilePermissionRecorder(cwd, config, expected)!;
    const startedAt = Date.now() - 1000, timestamp = new Date().toISOString();
    const input = {file_path: expected, content: options.content ?? captured.content};
    const block = {type: 'tool_use', id, name: 'Write', input};
    const native = (role: string, content: any[]) => ({cwd, sessionId, isSidechain: false, timestamp, message: {role, content}});
    const original = [native('assistant', [{type: 'text', text: 'Updating the working plan.'}, block])];
    const write = (rows: any[]) => fs.writeFileSync(journal, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    write(original);
    recordFilePermission(JSON.stringify({hook_event_name: 'PreToolUse', tool_name: 'Write', session_id: sessionId,
      tool_use_id: id, cwd, transcript_path: journal, tool_input: {...input, content: options.hookContent ?? input.content}}),
      recorder.file, cwd, config, expected);
    const read = (screen = captured.screen) => currentFilePermissionEpoch(recorder.file, expected, cwd, config, startedAt,
      readPlanCountTranscript(config, cwd), screen);
    return {dir, cwd, expected, block, native, original, write, read,
      close() { recorder.dispose(); fs.rmSync(dir, {recursive: true, force: true}); }};
  }

  const lines = captured.screen.split('\n');
  const replaceRow = (screen: string, from: string, to: string) => {
    expect(screen).toContain(from);
    return screen.replace(from, to);
  };

  test('the captured cropped overwrite binds the pending owned Write and grants once', () => {
    expect(lines[0]).toMatch(/^ {6}-oper evidence/);
    expect(captured.screen).toContain(' Do you want to overwrite gstack-test-plan-ceo-floor.md?');
    const f = fixture();
    try {
      const epoch = f.read();
      expect(epoch?.pendingId).toBe(`${sessionId}:${id}`);
      const guard = createPlanCountPermissionGuard();
      expect(guard(captured.screen, '', epoch)).toBe('grant');
      expect(guard(captured.screen, '', epoch)).toBe('handled');
    } finally { f.close(); }
  });

  test('a crop that starts on a numbered row, or on the rule above an uncropped diff, still binds', () => {
    const f = fixture();
    try {
      const from107 = captured.screen.slice(captured.screen.indexOf('  107 +'));
      expect(f.read(from107)?.pendingId).toBe(`${sessionId}:${id}`);
      const fromContext = captured.screen.slice(captured.screen.indexOf('  108  B)'));
      expect(f.read(fromContext)?.pendingId).toBe(`${sessionId}:${id}`);
    } finally { f.close(); }
  });

  test('a full Overwrite file heading names the owned path; a foreign same-basename heading blocks', () => {
    const f = fixture();
    try {
      const heading = (target: string) => ' Overwrite file\n ' + target + '\n' + captured.screen;
      expect(f.read(heading(captured.basename))?.pendingId).toBe(`${sessionId}:${id}`);
      expect(f.read(heading('../elsewhere/' + captured.basename))).toBeNull();
    } finally { f.close(); }
  });

  const screenNegatives: Array<[string, (screen: string) => string]> = [
    ['an added row that is not the pending content', s => replaceRow(s, 'Interview ~10 target developers', 'Interview ~12 target developers')],
    ['a deleted row that is not the current file', s => replaceRow(s, "  107 -Ship the cheaper tier on the team's", "  107 -Ship a cheaper tier on the team's")],
    ['an unchanged row that is not in either file', s => replaceRow(s, '  108  B) Launch now as written', '  108  B) Launch later')],
    ['a shifted line number', s => replaceRow(s, '  109 +Ship', '  110 +Ship')],
    ['a deleted row numbered as the next current line', s => replaceRow(s, '  112 -- Nothing', '  113 -- Nothing')],
    ['a leading tail that is not the anchored current line', s => s.replace('-oper evidence in 1-2 weeks', '-other evidence in 1-2 weeks')],
    ['a wrapped row under the wrong gutter', s => replaceRow(s, '      +eds.', '       +eds.')],
    ['a wrapped row whose marker differs from its numbered row', s => replaceRow(s, '      +eds.', '      -eds.')],
    ['a quoted pane', s => s.split('\n').map(row => '> ' + row).join('\n')],
    ['a Create prompt over an overwrite diff', s => replaceRow(s, 'Do you want to overwrite', 'Do you want to create')],
    ['a changed one-time action', s => replaceRow(s, '❯ 1. Yes', '❯ 2. Yes')],
    ['a missing footer', s => replaceRow(s, 'Esc to cancel · Tab to amend', '')],
  ];
  for (const [name, change] of screenNegatives) test(`${name} cannot bind the overwrite`, () => {
    const f = fixture();
    try {
      const screen = change(captured.screen);
      expect(screen).not.toBe(captured.screen);
      const epoch = f.read(screen);
      expect(epoch).not.toBeTruthy();
      expect(createPlanCountPermissionGuard()(screen, '', epoch)).not.toBe('grant');
    } finally { f.close(); }
  });

  test('a foreign basename in the overwrite prompt leaves other permission policy alone', () => {
    const f = fixture();
    try { expect(f.read(captured.screen.replace('overwrite gstack-test-plan-ceo-floor.md?', 'overwrite other.md?'))).toBeUndefined(); }
    finally { f.close(); }
  });

  test('stale file bytes, a changed hook witness and an unchanged rewrite cannot bind', () => {
    const staleLine = (n: number) => captured.before.split('\n').map((line, i) => i === n - 1 ? line + ' (since changed)' : line).join('\n');
    for (const options of [{before: staleLine(107)}, {before: staleLine(106)}, {before: staleLine(105)},
      {hookContent: captured.content + 'extra'}, {content: captured.before, hookContent: captured.before}]) {
      const f = fixture(options);
      try { expect(f.read(), JSON.stringify(Object.keys(options))).toBeNull(); } finally { f.close(); }
    }
  });

  for (const variant of ['foreign-path', 'second-pending', 'completed', 'wrong-tool', 'wrong-session'])
    test(`an overwrite rejects ${variant} native identity`, () => {
      const f = fixture();
      try {
        const changed = structuredClone(f.block) as any;
        if (variant === 'foreign-path') changed.input.file_path = path.join(f.dir, captured.basename);
        if (variant === 'wrong-tool') changed.name = 'Edit';
        const rows: any[] = [f.native('assistant', [{type: 'text', text: 'Updating the working plan.'}, changed])];
        if (variant === 'second-pending') rows.push(f.native('assistant', [{...f.block, id: 'toolu_second'}]));
        if (variant === 'completed') rows.push(f.native('user', [{type: 'tool_result', tool_use_id: id, content: 'done'}]));
        if (variant === 'wrong-session') rows[0].sessionId = 'foreign';
        f.write(rows);
        expect(f.read()).toBeNull();
      } finally { f.close(); }
    });

  test.skipIf(process.platform === 'win32')('a symlinked owned file cannot supply the current bytes', () => {
    const f = fixture();
    try {
      const target = path.join(f.dir, 'other.md');
      fs.renameSync(f.expected, target);
      fs.symlinkSync(target, f.expected);
      expect(f.read()).toBeNull();
    } finally { f.close(); }
  });
});
