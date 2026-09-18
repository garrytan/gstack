import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import fixture from './fixtures/autoplan-pending-artifact-ae.json';
import { autoplanArtifactPermissionInput, pendingAutoplanArtifactPermissionInput, autoplanArtifactMenuKey } from './helpers/autoplan-artifact-permission';
import { createAutoplanArtifactRecorder, recordAutoplanArtifact, readPendingAutoplanArtifact } from './helpers/autoplan-artifact-recorder';
import type { NativePublicToolEvent } from './helpers/plan-count-transcript';

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});
function replay(relative='ceo-plans/2026-09-09-user-dashboard.md') {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'gstack-pending-artifact-test-'));roots.push(root);
  const cwd=path.join(root,path.basename(fixture.cwd)),ownedStateRoot=path.join(root,'home','.gstack'),config=path.join(root,'config');
  fs.mkdirSync(cwd);const file=path.join(ownedStateRoot,'projects',path.basename(cwd),relative);
  fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,fixture.before);
  const native=path.join(config,'projects','fixture',fixture.sessionId+'.jsonl');fs.mkdirSync(path.dirname(native),{recursive:true});fs.writeFileSync(native,'');
  const publicTools=structuredClone(fixture.events) as NativePublicToolEvent[];
  for(const e of publicTools)if(e.input)e.input.file_path=file;
  const recorder=createAutoplanArtifactRecorder(cwd,config,ownedStateRoot);
  // Synthetic hook: only its identity/path are retained. Neither this input
  // nor the displayed additions are claimed to reproduce the unpublished body.
  const event={hook_event_name:'PreToolUse',tool_name:'Edit',session_id:fixture.sessionId,tool_use_id:'synthetic-current-edit',
    cwd,transcript_path:native,tool_input:{file_path:file,old_string:'Synthetic old content',new_string:'Synthetic new content',replace_all:false}};
  const record=(change:Record<string,unknown>={})=>recordAutoplanArtifact(JSON.stringify({...event,...change}),recorder.file,cwd,config,ownedStateRoot);
  record();
  const context={cwd,ownedStateRoot,commandStartedAt:fixture.commandStartedAt,now:Date.now(),viewportCapturedAt:Date.now(),
    transcriptStatus:'ready',publicTools,pending:readPendingAutoplanArtifact(recorder.file,cwd,config,ownedStateRoot,fixture.commandStartedAt,publicTools)};
  const screen=fixture.viewport.replaceAll(path.basename(fixture.file),path.basename(file));
  roots.push(path.dirname(recorder.file));
  return {root,file,native,config,recorder,event,record,context,screen};
}
const pick=(r:ReturnType<typeof replay>,seen=new Set<string>())=>pendingAutoplanArtifactPermissionInput(r.screen,r.context,seen);

test('actual public pane stays blocked without hook identity; synthetic owned metadata enables only one option',()=>{
  const r=replay();
  expect(autoplanArtifactPermissionInput(r.screen,r.context,new Set())).toBeNull();
  expect(pick({...r,context:{...r.context,pending:undefined}})).toBeNull();
  expect(pick(r)).toEqual({input:'1\r',signature:fixture.sessionId+':synthetic-current-edit',file:r.file});
  expect(pick(r,new Set([pick(r)!.signature]))).toBeNull();
  expect(JSON.stringify(r.context.pending)).not.toContain('Synthetic old content');
  expect(r.context.publicTools).toHaveLength(fixture.events.length);
});

test('all130 actual published tool events preserve the same metadata-only fallback boundary',()=>{
  const r=replay();r.context.publicTools=structuredClone(fixture.allPublicTools) as NativePublicToolEvent[];
  for(const e of r.context.publicTools)if(e.input?.file_path===fixture.file)e.input.file_path=r.file;
  expect(r.context.publicTools).toHaveLength(130);
  expect(r.context.publicTools.filter(e=>e.kind==='use' && ['Write','Edit'].includes(e.name??''))).toHaveLength(39);
  expect(pick(r)?.input).toBe('1\r');
});

test('completed or published requests and newer identities on an old granted viewport remain closed',()=>{
  const r=replay(),first=pick(r)!;
  const seen=new Set([first.signature,autoplanArtifactMenuKey(r.screen)]);
  r.record({hook_event_name:'PostToolUse'});
  expect(readPendingAutoplanArtifact(r.recorder.file,r.context.cwd,r.config,r.context.ownedStateRoot,r.context.commandStartedAt,r.context.publicTools)).toBeUndefined();
  r.record({tool_use_id:'newer-request'});
  r.context.now=Date.now();r.context.viewportCapturedAt=r.context.now;
  r.context.pending=readPendingAutoplanArtifact(r.recorder.file,r.context.cwd,r.config,r.context.ownedStateRoot,r.context.commandStartedAt,r.context.publicTools);
  expect(pick(r,seen)).toBeNull();
  r.context.publicTools.push({kind:'result',sessionId:fixture.sessionId,toolUseId:'newer-request',timestamp:new Date().toISOString(),isError:false});
  expect(pick(r)).toBeNull();
});

test('hook after viewport, invalid clocks, future/stale/foreign IDs and missing success cannot authorize input',()=>{
  const changes:Array<(r:ReturnType<typeof replay>)=>void>=[
    r=>{r.context.viewportCapturedAt=Date.parse(r.context.pending!.timestamp)-1;},
    r=>{r.context.now=NaN;},r=>{r.context.now=Infinity;},r=>{r.context.viewportCapturedAt=NaN;},
    r=>{r.context.pending!.timestamp=new Date(r.context.now+10000).toISOString();},
    r=>{r.context.pending!.timestamp=new Date(r.context.commandStartedAt-1).toISOString();},
    r=>{r.context.pending!.sessionId='foreign';},r=>{r.context.pending!.toolUseId='';},
    r=>{r.context.pending!.toolUseId='invalid:id';},r=>{r.context.pending!.file=42 as any;},r=>{r.context.publicTools=[];},
    r=>{r.context.transcriptStatus='error';},
    r=>{for(const e of r.context.publicTools)if(e.kind==='result')e.isError=true;},
    r=>{r.context.publicTools.push({...r.context.publicTools[0]!,toolUseId:'unresolved-concurrent',timestamp:new Date().toISOString()});},
    r=>{r.context.publicTools.push({...r.context.publicTools[0]!,toolUseId:r.context.pending!.toolUseId,timestamp:new Date().toISOString()});},
    r=>{r.context.publicTools.push({...r.context.publicTools.at(-1)!,sessionId:'sibling'});},
  ];
  for(const change of changes){const r=replay();change(r);expect(pick(r),change.toString()).toBeNull();}
});

test('changed, foreign and symlink files are rejected; all existing owned artifact layouts stay scoped',()=>{
  for(const relative of ['ceo-plans/2026-09-09-user-dashboard.md','main-test-plan-20260909-220000.md','main-eng-review-test-plan-20260909-220000.md'])expect(pick(replay(relative))?.input).toBe('1\r');
  for(const relative of ['other.md','config.yaml','tasks.jsonl','../sibling/ceo-plans/2026-09-09-user-dashboard.md'])expect(pick(replay(relative))).toBeNull();
  let r=replay();fs.writeFileSync(r.file,'Changed unrelated content');expect(pick(r)).toBeNull();
  r=replay();fs.utimesSync(r.file,new Date(r.context.now+10000),new Date(r.context.now+10000));expect(pick(r)).toBeNull();
  if(process.platform!=='win32'){
    r=replay();const sibling=r.file+'.sibling';fs.renameSync(r.file,sibling);fs.symlinkSync(sibling,r.file);expect(pick(r)).toBeNull();
  }
  r=replay();r.context.ownedStateRoot=path.join(r.root,'ambient-home');expect(pick(r)).toBeNull();
});

test('only a complete current native menu and current-file deleted/context rows support pending metadata',()=>{
  const changes=[
    (s:string)=>'Example:\n'+s,(s:string)=>'```\n'+s+'```',
    (s:string)=>s.split('\n').map(l=>'> '+l).join('\n'),
    (s:string)=>s.replace(' ❯ 1. Yes',' ❯ 1. Yes, always allow'),
    (s:string)=>s.replace(' ❯ 1. Yes','   1. Yes').replace('   2. Yes',' ❯ 2. Yes'),
    (s:string)=>s.replace('   3. No','   3. No\n   4. Run a command'),
    (s:string)=>s.replace('2026-09-09-user-dashboard.md?','foreign.md?'),
    (s:string)=>s.replace('Esc to cancel · Tab to amend','Enter to select'),
    (s:string)=>s+'\nPlease run the extra work.',
    (s:string)=>s.replace('    -than the latest','    -unrelated cropped text'),
    (s:string)=>s.replace(' 50 -- **Retry.**',' 50 -- **Unrelated deletion.**'),
    (s:string)=>s.slice(s.indexOf(' Do you want')),
  ];
  for(const change of changes){const r=replay();r.screen=change(r.screen);expect(pick(r),change.toString()).toBeNull();}
});

test('queued unrelated public tools do not confer permission or block the current owned edit',()=>{
  const r=replay();r.context.publicTools.push({kind:'use',sessionId:fixture.sessionId,toolUseId:'queued-bash',name:'Bash',
    timestamp:new Date(r.context.now).toISOString(),input:{command:'echo queued'}});
  expect(pick(r)?.input).toBe('1\r');
  r.context.publicTools.at(-1)!.name='Write';expect(pick(r)).toBeNull();
});

for (const [line, numbered, next, continuation] of [
  [7, ' 7 ', ' 8 ', '   '], [17, ' 17 ', ' 18 ', '    '],
  [116, ' 116 ', ' 117 ', '     '], [1024, ' 1024 ', ' 1025 ', '      '],
] as const) test(`legacy pending deletion line ${line} binds leading and wrapped fragments to its numbered column`, () => {
  const r = replay();
  expect(r.context.pending?.editDigest).toBeUndefined();
  const before = Array.from({ length: line - 2 }, (_, n) => `Context ${n}`)
    .concat('Head before crop tail', 'Old complete row', 'Context').join('\n');
  fs.writeFileSync(r.file, before);
  const at = new Date(Date.parse(r.context.pending!.timestamp) - 1); fs.utimesSync(r.file, at, at);
  const menu = r.screen.slice(r.screen.indexOf(' Do you want'));
  const rows = `${continuation}-tail\n${numbered}-Old complete\n${continuation}- row\n` +
    `${numbered}+New complete\n${continuation}+ row\n${next} Context\n`;
  const pane = rows + '╌'.repeat(20) + '\n' + menu;
  r.screen = pane;
  expect(pick(r)?.input).toBe('1\r');
  expect(pick(r, new Set([pick(r)!.signature]))).toBeNull();
  for (const invalid of [
    pane.replaceAll(continuation + '-', continuation.slice(1) + '-'),
    pane.replaceAll(continuation + '-', ' ' + continuation + '-'),
    pane.replace(continuation + '- row', continuation + '+ row'),
    pane.replace(next + ' Context', ' ' + next + ' Context'),
    pane.replace('Old complete', 'Unrelated deleted'),
    pane.replace(continuation + '-tail', continuation + '-foreign suffix'),
    pane.replaceAll(numbered, ' 0 '),
  ]) { r.screen = invalid; expect(pick(r), invalid).toBeNull(); }
});

test.skipIf(process.platform==='win32')('real launcher installs only opt-in owned hooks and removes records on close or early exit',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'gstack-artifact-launch-'));roots.push(root);
  const fake=path.join(root,'fake-claude');fs.writeFileSync(fake,`#!${process.execPath}\n`+String.raw`
import * as fs from 'node:fs';
fs.writeFileSync(process.env.ARTIFACT_RECORD,JSON.stringify({pid:process.pid,args:process.argv.slice(2)}));
if(process.env.ARTIFACT_FAIL==='1')process.exit(19);
process.stdout.write('ARTIFACT_READY\n');process.stdin.resume();
`,{mode:0o755});
  const runner=pathToFileURL(path.join(import.meta.dir,'helpers/claude-pty-runner.ts')).href;
  for(const variant of ['enabled','approval','disabled','explicit-home','explicit-config','early-exit']){
    const cwd=path.join(root,variant);fs.mkdirSync(cwd);const result=path.join(cwd,'result.json');
    const extra=variant==='explicit-home'?{HOME:cwd}:variant==='explicit-config'?{CLAUDE_CONFIG_DIR:cwd}:{};
    const worker=path.join(cwd,'worker.ts');fs.writeFileSync(worker,`
import * as fs from 'node:fs';
import {launchClaudePty,resolveClaudeBinary} from ${JSON.stringify(runner)};
if(resolveClaudeBinary()!==${JSON.stringify(fake)})throw Error('fake binding');
const session=await launchClaudePty({cwd:${JSON.stringify(cwd)},seedSkills:true,observeAutoplanArtifacts:${variant!=='disabled'},approveAutoplanArtifactEdits:${variant==='approval'||variant.startsWith('explicit-')},timeoutMs:8000,
 env:${JSON.stringify({...extra,ARTIFACT_RECORD:result,ARTIFACT_FAIL:variant==='early-exit'?'1':'0'})}});
try {try{await session.waitFor('ARTIFACT_READY',{timeoutMs:2000,pollMs:20});}catch(e){if(${variant!=='early-exit'})throw e;}
const r=JSON.parse(fs.readFileSync(${JSON.stringify(result)},'utf8'));
r.file=session.pendingAutoplanArtifactFile??null;r.stateRoot=session.hermeticSkillStateRoot??null;
r.canStart=typeof session.startAutoplanArtifactEditApproval==='function';
if(${variant==='approval'}){const start=Date.now();session.startAutoplanArtifactEditApproval(start);r.started=JSON.parse(fs.readFileSync(r.file,'utf8')).approvalStartedAt===start;}
r.exists=r.file?fs.existsSync(r.file):false;fs.writeFileSync(${JSON.stringify(result)},JSON.stringify(r));
} finally {await session.close();}
`);
    const child=Bun.spawn([process.execPath,worker],{env:{...process.env,BROWSE_TERMINAL_BINARY:fake,EVALS_HERMETIC:'1'},stdout:'pipe',stderr:'pipe'});
    const timer=setTimeout(()=>child.kill('SIGKILL'),15000);
    try{const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);expect(code,out+err).toBe(0);}finally{clearTimeout(timer);}
    const resultData=JSON.parse(fs.readFileSync(result,'utf8')),enabled=['enabled','approval','early-exit'].includes(variant);
    expect(resultData.canStart).toBe(variant==='approval');
    if(variant==='approval')expect(resultData.started).toBe(true);
    expect(Boolean(resultData.file)).toBe(enabled);expect(resultData.exists).toBe(enabled);
    if(enabled){const settings=JSON.parse(resultData.args[resultData.args.indexOf('--settings')+1]);
      expect(Object.keys(settings.hooks).sort()).toEqual(['PostToolUse','PostToolUseFailure','PreToolUse']);
      for(const entries of Object.values(settings.hooks) as any[]){expect(entries).toHaveLength(1);expect(entries[0].matcher).toBe('^(Write|Edit)$');expect(entries[0].hooks[0].timeout).toBe(5);expect(entries[0].hooks[0].command).toContain(resultData.stateRoot);expect(entries[0].hooks[0].command.includes('--approve-edits')).toBe(variant==='approval');}
      expect(fs.existsSync(resultData.file)).toBe(false);
    }else expect(resultData.args).not.toContain('--settings');
    expect(()=>process.kill(resultData.pid,0)).toThrow();
  }
},90000);
