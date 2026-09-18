import {expect,test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {createHash} from 'node:crypto';
import {createFilePermissionRecorder,currentFilePermissionEpoch,currentFilePermissionBinding} from './helpers/plan-count-file-permission';
import {readPlanCountTranscript} from './helpers/plan-count-transcript';
import {createPlanCountPermissionGuard,isPermissionDialogVisible,classifyPlanCountFrame} from './helpers/claude-pty-runner';
import captured from './fixtures/plan-edit-cropped-permission-1579.json';

function fixture(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cropped-edit-')),cwd=path.join(dir,'owned'),config=path.join(dir,'config');fs.mkdirSync(cwd);
 const expected=path.join(cwd,path.basename(captured.hook.expected)),sid=captured.hook.sessionId,id=captured.pendingEdit.toolUseId;
 const journal=path.join(config,'projects','owned',sid+'.jsonl');fs.mkdirSync(path.dirname(journal),{recursive:true});
 const recorder=createFilePermissionRecorder(cwd,config,expected)!;
 const state={...captured.hook,cwd,expected,transcriptPath:journal};
 fs.writeFileSync(recorder.file,JSON.stringify(state));fs.writeFileSync(expected,captured.priorWrite.input.content);
 const input={...captured.pendingEdit.input,file_path:expected},block={type:'tool_use',id,name:'Edit',input};
 const native=(role:string,content:any[])=>({cwd,sessionId:sid,isSidechain:false,timestamp:captured.pendingEdit.timestamp,message:{role,content}});
 const rows=[native('assistant',[{type:'text',text:'Updating the owned report.'},block])];
 const write=(value:any[]=rows)=>fs.writeFileSync(journal,value.map(r=>JSON.stringify(r)).join('\n')+'\n');write();
 const transcript=()=>readPlanCountTranscript(config,cwd);
 const read=(screen=captured.screen)=>currentFilePermissionEpoch(recorder.file,expected,cwd,config,captured.commandStartedAt,transcript(),screen);
 return {dir,cwd,config,expected,sid,id,journal,recorder,state,input,block,native,rows,write,read,transcript,
  close(){recorder.dispose();fs.rmSync(dir,{recursive:true,force:true});}};
}

test('actual cropped ordinary Edit binds its current public request and grants only once',()=>{
 const f=fixture();try{
  expect(createHash('sha256').update(captured.screen).digest('hex')).toBe(captured.screenSha256);
  expect(captured.pendingEdit.input.old_string).toBe('## Onboarding flow (under review, as supplied)');
  expect(f.read()?.pendingId).toBe(captured.hook.pendingId);
  const owned=currentFilePermissionBinding([{file:f.recorder.file,expected:f.expected}],f.cwd,f.config,captured.commandStartedAt,f.transcript(),captured.screen);
  expect(owned?.epoch.pendingId).toBe(captured.hook.pendingId);
  const guard=createPlanCountPermissionGuard();expect(guard(captured.screen,'',f.read())).toBe('grant');
  expect(guard(captured.screen,'',f.read())).toBe('handled');
 }finally{f.close();}
});

test('the new cropped class never becomes an unowned generic permission grant',()=>{
 expect(isPermissionDialogVisible(captured.screen)).toBe(false);
 expect(classifyPlanCountFrame(captured.screen)).not.toBe('permission');
 expect(createPlanCountPermissionGuard()(captured.screen)).not.toBe('grant');
 expect(createPlanCountPermissionGuard()(captured.screen,'',null)).not.toBe('grant');
});

test.each(['pending','already-applied'])('a partial added-row crop retains the current Edit location: %s',mode=>{
 const f=fixture();try{
  const start=captured.screen.indexOf(' 40 +'),end=captured.screen.indexOf(' 81 +');
  const footer=captured.screen.slice(captured.screen.lastIndexOf('\n╌'));
  const screen=captured.screen.slice(start,end)+footer;
  if(mode==='already-applied')fs.writeFileSync(f.expected,captured.priorWrite.input.content.replace(f.input.old_string,f.input.new_string));
  if(mode==='already-applied')expect(f.read(screen)).toBeNull();
  else expect(f.read(screen)?.pendingId).toBe(f.state.pendingId);
 }finally{f.close();}
});

for(const [index,line] of captured.screen.split('\n').entries())if(/^ {4,5}[+\-]/.test(line))
test(`the captured wrapped diff crop at viewport row ${index+1} binds its complete visible suffix`,()=>{
 const f=fixture();try{
  const screen=captured.screen.split('\n').slice(index).join('\n');
  expect(f.read(screen)?.pendingId).toBe(f.state.pendingId);
  expect(createPlanCountPermissionGuard()(screen,'',f.read(screen))).toBe('grant');
  expect(f.read(screen.replace(line,line+' changed'))).toBeNull();
 }finally{f.close();}
});

test.each(['crlf','without-hint','wrapped-menu'])(`owned ordinary Edit supports native %s layout`,mode=>{
 const f=fixture();try{let screen=captured.screen;
  if(mode==='crlf')screen=screen.replaceAll('\n','\r\n');
  if(mode==='without-hint')screen=screen.replace(' (shift+tab)','');
  if(mode==='wrapped-menu')screen=screen.replace('file edits and common file commands','file edits and\n      common file commands');
  expect(f.read(screen)?.pendingId).toBe(f.state.pendingId);
  expect(createPlanCountPermissionGuard()(screen,'',f.read(screen))).toBe('grant');
 }finally{f.close();}
});

test.each(['missing-journal','wrong-session','foreign-path','foreign-id','wrong-tool','completed','failed','completed-replay','ambiguous','conflicting-use','changed-old','changed-new'])(`crop cannot override %s native evidence`,mode=>{
 const f=fixture();try{const block=structuredClone(f.block),rows:any[]=[f.native('assistant',[{type:'text',text:'Updating.'},block])];
  if(mode==='wrong-session')rows[0].sessionId='foreign';
  if(mode==='foreign-path')block.input.file_path=path.join(f.dir,path.basename(f.expected));
  if(mode==='foreign-id')block.id='other';
  if(mode==='wrong-tool')block.name='Write';
  if(mode==='changed-old')block.input.old_string='Different current source';
  if(mode==='changed-new')block.input.new_string=block.input.new_string.replace('empathy narrative','different narrative');
  if(['completed','failed','completed-replay'].includes(mode))rows.push(f.native('user',[{type:'tool_result',tool_use_id:f.id,content:'done',is_error:mode==='failed'}]));
  if(mode==='completed-replay')rows.push(f.native('assistant',[f.block]));
  if(mode==='ambiguous')rows.push(f.native('assistant',[{...f.block,id:'other'}]));
  if(mode==='conflicting-use')rows.unshift(f.native('assistant',[{...f.block,input:{...f.input,new_string:'Different input'}}]));
  f.write(rows);if(mode==='missing-journal')fs.unlinkSync(f.journal);
  expect(f.read()).toBeNull();expect(createPlanCountPermissionGuard()(captured.screen,'',f.read())).not.toBe('grant');
 }finally{f.close();}
});

test.each(['foreign-cwd','foreign-config','completed-epoch','stale','future','linked-state','linked-target','linked-parent','different-source','ambiguous-source'])(`cropped Edit rejects %s ownership`,mode=>{
 const f=fixture();try{let state:any={...f.state};
  if(mode==='foreign-cwd')state.cwd=f.dir;
  if(mode==='foreign-config')state.transcriptPath=path.join(f.dir,'foreign','projects','owned',f.sid+'.jsonl');
  if(mode==='completed-epoch')state.completedId=state.pendingId;
  if(mode==='stale')state.timestamp=new Date(captured.commandStartedAt-1).toISOString();
  if(mode==='future')state.timestamp=new Date(Date.now()+60000).toISOString();
  fs.writeFileSync(f.recorder.file,JSON.stringify(state));
  if(mode==='linked-state'){fs.renameSync(f.recorder.file,f.recorder.file+'.real');fs.symlinkSync(f.recorder.file+'.real',f.recorder.file);}
  if(mode==='linked-target'){fs.renameSync(f.expected,f.expected+'.real');fs.symlinkSync(f.expected+'.real',f.expected);}
  if(mode==='linked-parent'){fs.renameSync(f.cwd,f.cwd+'.real');fs.symlinkSync(f.cwd+'.real',f.cwd);}
  if(mode==='different-source')fs.writeFileSync(f.expected,'Different source.');
  if(mode==='ambiguous-source')fs.appendFileSync(f.expected,'\n'+f.input.old_string);
  expect(f.read()).toBeNull();
 }finally{f.close();}
});

test.each(['foreign-basename','foreign-header','quoted','fenced','auq','old-menu','missing-footer','selected-other','changed-action','added-choice','changed-preview','wrong-number','partial-footer','plain-prose'])(`cropped Edit rejects %s viewport`,mode=>{
 const f=fixture();try{let screen=captured.screen;
  if(mode==='foreign-basename')screen=screen.replace(path.basename(f.expected),'foreign.md');
  if(mode==='foreign-header')screen='/foreign/'+path.basename(f.expected)+'\n'+screen;
  if(mode==='quoted')screen=screen.split('\n').map(l=>'> '+l).join('\n');
  if(mode==='fenced')screen='```text\n'+screen;
  if(mode==='auq')screen='☐ Review\n'+screen;
  if(mode==='old-menu')screen='❯ 1. Old\n  2. Other\n'+screen;
  if(mode==='missing-footer')screen=screen.replace('Esc to cancel · Tab to amend','');
  if(mode==='selected-other')screen=screen.replace('❯ 1. Yes','  1. Yes').replace('   2.',' ❯ 2.');
  if(mode==='changed-action')screen=screen.replace('1. Yes','1. Yes, approve all');
  if(mode==='added-choice')screen=screen.replace('   3. No','   3. No\n   4. Other');
  if(mode==='changed-preview')screen=screen.replace('empathy narrative','different narrative');
  if(mode==='wrong-number')screen=screen.replace(' 30 +',' 31 +');
  if(mode==='partial-footer')screen=screen.replace('Tab to amend','Tab to');
  if(mode==='plain-prose')screen='Here is an example:\n'+screen;
  expect(f.read(screen)).toBeFalsy();
  expect(createPlanCountPermissionGuard()(screen,'',f.read(screen))).not.toBe('grant');
 }finally{f.close();}
});
