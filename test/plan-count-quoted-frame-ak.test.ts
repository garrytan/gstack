import {expect,test} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {classifyPlanCountFrame,createPlanCountPermissionGuard} from './helpers/claude-pty-runner';
import exact from './fixtures/plan-count-quoted-frame-ak.json';
import native from './fixtures/plan-count-permission-ac.json';
import owned from './fixtures/plan-count-owned-permission-v.json';
import {E2E_TOUCHFILES,selectTests} from './helpers/touchfiles';
const quote=(s:string)=>s.split('\n').map(row=>'> '+row).join('\n');

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
test('the regression selects exactly the existing permission consumers',()=>{
 for(const dependency of ['test/plan-count-quoted-frame-ak.test.ts','test/fixtures/plan-count-quoted-frame-ak.json'])
  expect(selectTests([dependency],E2E_TOUCHFILES).selected.sort()).toEqual(selectTests(['test/plan-count-permission-ac.test.ts'],E2E_TOUCHFILES).selected.sort());
});

test.skipIf(process.platform==='win32')('real dispatcher ignores quoted pane then grants the fresh owned native request once',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'count-quoted-frame-')),fake=path.join(dir,'fake-claude'),worker=path.join(dir,'worker.ts'),events=path.join(dir,'events.jsonl'),output=path.join(dir,'result.json'),report=path.join(dir,'report.md');
 fs.writeFileSync(report,'original');
 fs.writeFileSync(fake,`#!${process.execPath}\n`+String.raw`
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
let stage='startup';process.stdin.setRawMode?.(true);process.stdin.on('data',async data=>{
 const input=data.toString();log({type:'input',stage,input});
 if(stage==='startup'){stage='quoted';paint(item.quotedScreen);setTimeout(async()=>{await hook('PreToolUse');stage='current';paint(pane);},4200);return;}
 if(stage!=='current'){log({type:'unexpected'});return;}
 if(input!=='1\r')throw Error('One-time grant changed');stage='done';await hook('PostToolUse');
 const q={header:'Finding',question:'Apply the reviewed fix?',options:[{label:'Fix'},{label:'Keep'}]};
 native('assistant',[{type:'tool_use',name:'AskUserQuestion',id:'finding',input:{questions:[q]}}]);native('user',[{type:'tool_result',tool_use_id:'finding',content:'Answered'}],{toolUseResult:{answers:{[q.question]:'Fix'}}});paint('Done.\n');
});process.on('SIGINT',()=>process.exit(0));process.stdin.resume();
`);fs.chmodSync(fake,0o755);
 // Keep every physical terminal row inside the quote; adding a prefix to an
 // already120-column capture would otherwise wrap an unquoted continuation.
 const quotedScreen=exact.screen.split('\n').flatMap(row=>row.trimEnd().match(/.{1,116}/gu)??['']).map(row=>'> '+row).join('\n');
 const args={skillName:'plan-ceo-review',slashCommand:'/plan-ceo-review',followUpPrompt:'Review the disposable fixture.',expectedPlanPath:report,reviewCountCeiling:1,timeoutMs:25000,env:{QUOTED_FRAME_CASE:JSON.stringify({events,report,screen:owned.screen,quotedScreen})}};
 fs.writeFileSync(worker,`import {runPlanSkillCounting} from ${JSON.stringify(pathToFileURL(path.join(import.meta.dir,'helpers/claude-pty-runner.ts')).href)};const result=await runPlanSkillCounting({...${JSON.stringify(args)},isLastStep0AUQ:()=>false,isReviewAUQ:()=>true});await Bun.write(${JSON.stringify(output)},JSON.stringify(result));`);
 const child=Bun.spawn([process.execPath,worker],{env:{...process.env,BROWSE_TERMINAL_BINARY:fake,EVALS_HERMETIC:'1'},stdout:'pipe',stderr:'pipe'}),timer=setTimeout(()=>child.kill('SIGKILL'),30000);
 try{const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);expect(code,out+err).toBe(0);
  const result=JSON.parse(fs.readFileSync(output,'utf8')),rows=fs.readFileSync(events,'utf8').trim().split('\n').map(s=>JSON.parse(s));
  expect(result.outcome,JSON.stringify(result)).toBe('ceiling_reached');expect(result.reviewCount).toBe(1);
  expect(rows.filter(r=>r.type==='input').map(r=>[r.stage,r.input])).toEqual([['startup','/plan-ceo-review\r'],['current','1\r']]);expect(rows.some(r=>r.type==='unexpected')).toBe(false);
  expect(()=>process.kill(rows[0].pid,0)).toThrow();expect(fs.existsSync(rows[0].cwd)).toBe(false);
 }finally{clearTimeout(timer);child.kill('SIGKILL');await child.exited;
  if(fs.existsSync(events)){const first=JSON.parse(fs.readFileSync(events,'utf8').split('\n')[0]!);try{if(fs.readFileSync('/proc/'+first.pid+'/cmdline','utf8').split('\0').includes(fake))process.kill(first.pid,'SIGKILL');}catch{}}
  fs.rmSync(dir,{recursive:true,force:true});}
},32000);
