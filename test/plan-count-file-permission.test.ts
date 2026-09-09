import {describe,test,expect} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createFilePermissionRecorder,recordFilePermission,currentFilePermissionEpoch} from './helpers/plan-count-file-permission';
import {createPlanCountPermissionGuard,classifyPlanCountFrame} from './helpers/claude-pty-runner';
import captured from './fixtures/plan-count-edit-permission-t.json';
import capturedAc from './fixtures/plan-count-permission-ac.json';

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
   const guard=createPlanCountPermissionGuard();expect(guard('Do you want to create OTHER.md?\n❯1.Yes\n2.Yes, and switch to accept edits\n3.No\nEsc to cancel · Tab to amend')).toBe('grant');
   fs.unlinkSync(f.recorder.file);fs.symlinkSync(f.expected,f.recorder.file);expect(f.read()).toBeNull();
   expect(createFilePermissionRecorder(f.cwd,f.config,path.parse(f.dir).root+'not-disposable.md')).toBeUndefined();
  }finally{f.close();}
 });
});

for (const variant of ['basic', 'intervening', 'cropped', 'same-basename']) test.skipIf(process.platform==='win32')(`real fake CLI grants each current request once: ${variant}`,async()=>{
 const intervening = variant === 'intervening';
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'count-edit-pty-'));const fake=path.join(dir,'fake-claude');const worker=path.join(dir,'worker.ts');const events=path.join(dir,'events.jsonl');const output=path.join(dir,'output.json');const expected=path.join(dir,variant==='same-basename'?'PLAN.md':'report.md');fs.writeFileSync(expected,'original');
 const cropped=capturedAc.rows.find(row=>row.job===5)!;
 let screen=variant==='cropped' ? cropped.screen.replaceAll(path.dirname(cropped.hook.expected),path.dirname(expected)).replaceAll(path.basename(cropped.hook.expected),'report.md')
  : captured.screen.replaceAll(captured.expectedPath,expected).replace('../gstack-e2e-plan-ceo-paired-2Rv5Bi/gstack-test-plan-ceo-paired.md',expected).replaceAll('gstack-test-plan-ceo-paired.md','report.md');
 if(variant==='same-basename')screen=screen.replaceAll(expected,'__ACTIVE_PLAN_PATH__').replaceAll('report.md','PLAN.md');
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
`);fs.chmodSync(fake,0o755);
 fs.writeFileSync(worker,`import {runPlanSkillCounting} from ${JSON.stringify(pathToFileURL(path.join(import.meta.dir,'helpers/claude-pty-runner.ts')).href)};const o=await runPlanSkillCounting({skillName:'plan-ceo-review',slashCommand:'/plan-ceo-review',followUpPrompt:'Review the disposable fixture.',expectedPlanPath:${JSON.stringify(expected)},isLastStep0AUQ:()=>false,isReviewAUQ:()=>true,reviewCountCeiling:1,timeoutMs:28000,env:{FILE_EPOCH_CASE:${JSON.stringify(JSON.stringify({events,expected,screen,intervening,activePlan:variant==='same-basename'}))}}});await Bun.write(${JSON.stringify(output)},JSON.stringify(o));`);
 const child=Bun.spawn([process.execPath,worker],{env:{...process.env,BROWSE_TERMINAL_BINARY:fake,EVALS_HERMETIC:'1'},stdout:'pipe',stderr:'pipe'});const killer=setTimeout(()=>child.kill('SIGKILL'),33000);
 try{const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);expect(code,out+err).toBe(0);
  const o=JSON.parse(fs.readFileSync(output,'utf8'));expect(o.outcome,JSON.stringify(o)).toBe('ceiling_reached');expect(o.reviewCount).toBe(1);
  const rows=fs.readFileSync(events,'utf8').trim().split('\n').map(l=>JSON.parse(l));expect(rows.filter(e=>e.type==='input').map(e=>e.input)).toEqual(['/plan-ceo-review\r','1\r','1\r']);expect(rows.some(e=>e.type==='unexpected')).toBe(false);
  expect(()=>process.kill(rows[0].pid,0)).toThrow();expect(fs.existsSync(rows[0].cwd)).toBe(false);
 }finally{clearTimeout(killer);child.kill('SIGKILL');if(fs.existsSync(events)){const first=JSON.parse(fs.readFileSync(events,'utf8').split('\n')[0]!);try{process.kill(first.pid,'SIGKILL');}catch{}}fs.rmSync(dir,{recursive:true,force:true});}
},35000);
