import {test,expect} from 'bun:test';
import * as fs from 'node:fs';import * as os from 'node:os';import * as path from 'node:path';
import {pathToFileURL} from 'node:url';
import {classifyPlanCountFrame,createPlanCountPermissionGuard} from './helpers/claude-pty-runner';
import capture from './fixtures/plan-count-owned-permission-v.json';
test('actual V owned-plan Edit pane is a one-time permission, not a review finding',()=>{
 expect(capture.events.map(e=>e.block.type)).toEqual(['tool_use','tool_result','tool_use']);
 expect(capture.events[0]!.block.id).not.toBe(capture.events[2]!.block.id);
 expect(classifyPlanCountFrame(capture.screen)).toBe('permission');
 const guard=createPlanCountPermissionGuard();expect(guard(capture.screen,'')).toBe('grant');expect(guard(capture.screen,'')).toBe('handled');
});
test('new permission grammar requires matching file pane and complete native permission footer',()=>{
 const panel=capture.screen.slice(capture.screen.indexOf(' Edit file\n'));
 for(const screen of [panel.replace(' Edit file\n PLAN.md\n',''),panel.replace(' Edit file\n PLAN.md',' Edit file\n OTHER.md'),panel.replace('Esc to cancel · Tab to amend','Esc to cancel'),panel.replace('   3. No','   3. Keep working'),'Example:\n'+panel,'```text\n'+panel,'☐ File policy\n'+panel,panel.replace(' ❯ 1. Yes','   1. Yes')]){
  expect(createPlanCountPermissionGuard()(screen,''),screen).not.toBe('grant');expect(classifyPlanCountFrame(screen),screen).not.toBe('permission');
 }
});
test.skipIf(process.platform==='win32')('real fake CLI binds only report and owned PLAN epochs across redraws and path switches',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'owned-plan-epoch-')),fake=path.join(dir,'fake-claude'),worker=path.join(dir,'worker.ts'),events=path.join(dir,'events.jsonl'),output=path.join(dir,'result.json'),report=path.join(dir,'report.md');fs.writeFileSync(report,'original');
 fs.writeFileSync(fake,`#!${process.execPath}\n`+String.raw`
import * as fs from 'node:fs';import * as path from 'node:path';
const item=JSON.parse(process.env.OWNED_EPOCH_CASE),sid='owned-main';const log=row=>fs.appendFileSync(item.events,JSON.stringify(row)+'\n');const plan=path.join(process.cwd(),'PLAN.md');
const nativePath=path.join(process.env.CLAUDE_CONFIG_DIR,'projects','owned',sid+'.jsonl');fs.mkdirSync(path.dirname(nativePath),{recursive:true});
const native=(role,content,extra={})=>fs.appendFileSync(nativePath,JSON.stringify({cwd:process.cwd(),sessionId:sid,isSidechain:false,timestamp:new Date().toISOString(),message:{role,content},...extra})+'\n');
native('assistant',[{type:'text',text:'Reviewing fixture.'}]);
const settings=JSON.parse(process.argv[process.argv.indexOf('--settings')+1]);if(settings.hooks.PreToolUse[0].matcher!=='^ExitPlanMode$')throw Error('Exit hook changed');
log({type:'start',pid:process.pid,cwd:process.cwd(),hookCount:settings.hooks.PreToolUse.filter(h=>h.matcher==='^(Write|Edit)$').length});
const hook=async(name,id,target)=>{
 const event={hook_event_name:name,tool_name:'Edit',session_id:sid,tool_use_id:id,cwd:process.cwd(),transcript_path:nativePath,tool_input:{file_path:target,old_string:'DO_NOT_RETAIN_OLD',new_string:'DO_NOT_RETAIN_NEW'}};
 for(const entry of settings.hooks[name]??[]){if(entry.matcher!=='^(Write|Edit)$')continue;const p=Bun.spawn(['bash','-c',entry.hooks[0].command],{stdin:new Blob([JSON.stringify(event)]),stdout:'pipe',stderr:'pipe'});const [code,out,err]=await Promise.all([p.exited,new Response(p.stdout).text(),new Response(p.stderr).text()]);if(code||out||err)throw Error('hook not silent');}
 log({type:'hook',name,id,target});
};
let stage='startup';const paint=target=>process.stdout.write('\x1b[2J\x1b[H'+item.screen.replaceAll('PLAN.md',target).replaceAll('\n','\r\n'));const request=async(id,target)=>{await hook('PreToolUse',id,target);stage=id;paint(target);};
process.stdin.setRawMode?.(true);process.stdin.on('data',async data=>{
 const input=data.toString();log({type:'input',stage,input});if(stage==='startup'){await request('report1',item.report);return;}
 if(stage.startsWith('wait')||stage==='done'){log({type:'unexpected'});return;}if(input!=='1\r')throw Error('one-time input changed');
 if(stage==='report1'){await hook('PostToolUse','report1',item.report);await request('plan1',plan);return;}
 if(stage==='plan1'){stage='wait-old-plan';await hook('PostToolUse','plan1',plan);paint(plan);setTimeout(async()=>{await hook('PreToolUse','plan1',plan);await hook('PreToolUse','foreign',path.join(process.cwd(),'OTHER.md'));paint(plan);},1000);setTimeout(async()=>{await request('plan2',plan);},3200);return;}
 if(stage==='plan2'){stage='wait-old-report';await hook('PostToolUse','plan2',plan);paint(item.report);setTimeout(async()=>{await request('report2',item.report);},3200);return;}
 await hook('PostToolUse','report2',item.report);stage='done';const q={header:'Finding',question:'Apply the reviewed fix?',options:[{label:'Fix'},{label:'Keep'}]};native('assistant',[{type:'tool_use',name:'AskUserQuestion',id:'finding',input:{questions:[q]}}]);native('user',[{type:'tool_result',tool_use_id:'finding',content:'Answered'}],{toolUseResult:{answers:{[q.question]:'Fix'}}});process.stdout.write('\x1b[2J\x1b[HDone.\r\n');
});process.on('SIGINT',()=>process.exit(0));process.stdin.resume();
`);fs.chmodSync(fake,0o755);
 const args={skillName:'plan-ceo-review',slashCommand:'/plan-ceo-review',followUpPrompt:'Review this owned fixture.',expectedPlanPath:report,reviewCountCeiling:1,timeoutMs:37000,env:{OWNED_EPOCH_CASE:JSON.stringify({events,report,screen:capture.screen})}};
 fs.writeFileSync(worker,`import {runPlanSkillCounting} from ${JSON.stringify(pathToFileURL(path.join(import.meta.dir,'helpers/claude-pty-runner.ts')).href)};const result=await runPlanSkillCounting({...${JSON.stringify(args)},isLastStep0AUQ:()=>false,isReviewAUQ:()=>true});await Bun.write(${JSON.stringify(output)},JSON.stringify(result));`);
 const child=Bun.spawn([process.execPath,worker],{env:{...process.env,BROWSE_TERMINAL_BINARY:fake,EVALS_HERMETIC:'1'},stdout:'pipe',stderr:'pipe'}),killer=setTimeout(()=>child.kill('SIGKILL'),42000);
 try{const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);expect(code,out+err).toBe(0);const result=JSON.parse(fs.readFileSync(output,'utf8'));expect(result.outcome,JSON.stringify(result)).toBe('ceiling_reached');expect(result.reviewCount).toBe(1);const rows=fs.readFileSync(events,'utf8').trim().split('\n').map(l=>JSON.parse(l));expect(rows[0].hookCount).toBe(2);expect(rows.filter(r=>r.type==='input').map(r=>[r.stage,r.input])).toEqual([['startup','/plan-ceo-review\r'],['report1','1\r'],['plan1','1\r'],['plan2','1\r'],['report2','1\r']]);expect(rows.some(r=>r.type==='unexpected')).toBe(false);expect(()=>process.kill(rows[0].pid,0)).toThrow();expect(fs.existsSync(rows[0].cwd)).toBe(false);
 }finally{
  clearTimeout(killer);child.kill('SIGKILL');await child.exited;
  if(fs.existsSync(events)){
   const first=JSON.parse(fs.readFileSync(events,'utf8').split('\n')[0]!);
   try{
    const owned=process.platform==='linux'
     ? fs.readFileSync(`/proc/${first.pid}/cmdline`,'utf8').split('\0').includes(fake)
     : Bun.spawnSync(['ps','-p',String(first.pid),'-o','args='],{timeout:1000}).stdout.toString().includes(fake);
    if(owned)process.kill(first.pid,'SIGKILL');
   }catch{}
  }
  fs.rmSync(dir,{recursive:true,force:true});
 }
},45000);
