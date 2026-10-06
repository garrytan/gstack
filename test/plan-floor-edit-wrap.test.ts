import {expect,test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {createHash} from 'node:crypto';
import {createFilePermissionRecorder,currentFilePermissionEpoch} from './helpers/plan-count-file-permission';
import {readPlanCountTranscript} from './helpers/plan-count-transcript';
import {createPlanCountPermissionGuard} from './helpers/claude-pty-runner';
import captured from './fixtures/plan-floor-edit-wrap-37176835584.json';

// PR run 37176835584: the floor's owned Edit menu stayed on screen until the
// 600 s timeout because unchanged rows soft-wrap under a gutter with a blank
// marker column, which the cropped-preview parser refused.
function fixture(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'floor-edit-wrap-')),cwd=path.join(dir,'owned'),config=path.join(dir,'config');fs.mkdirSync(cwd);
 const expected=path.join(cwd,captured.basename),sid='46bdc2d6-b244-41d6-a97d-2694f1639cb2',id='toolu_floorEditWrap37176835584';
 const journal=path.join(config,'projects','owned',sid+'.jsonl');fs.mkdirSync(path.dirname(journal),{recursive:true});
 const recorder=createFilePermissionRecorder(cwd,config,expected)!;
 const startedAt=Date.now()-60_000,timestamp=new Date(startedAt+1000).toISOString();
 fs.writeFileSync(recorder.file,JSON.stringify({cwd,expected,sessionId:sid,transcriptPath:journal,seenIds:[`${sid}:${id}`],
  pendingId:`${sid}:${id}`,completedId:null,completedIds:[],timestamp}));
 fs.writeFileSync(expected,captured.priorWrite);
 const block={type:'tool_use',id,name:'Edit',input:{...captured.pendingEdit,file_path:expected}};
 fs.writeFileSync(journal,JSON.stringify({cwd,sessionId:sid,isSidechain:false,timestamp,message:{role:'assistant',content:[{type:'text',text:'Updating the effort estimate.'},block]}})+'\n');
 const read=(screen=captured.screen)=>currentFilePermissionEpoch(recorder.file,expected,cwd,config,startedAt,readPlanCountTranscript(config,cwd),screen);
 return {pendingId:`${sid}:${id}`,expected,read,close(){recorder.dispose();fs.rmSync(dir,{recursive:true,force:true});}};
}

test('the captured floor viewport with wrapped unchanged rows binds the owned Edit and grants once',()=>{
 expect(createHash('sha256').update(captured.screen).digest('hex')).toBe(captured.screenSha256);
 expect(captured.screen).toMatch(/^ {6}man: ~4-6 weeks/m);
 const f=fixture();try{
  expect(f.read()?.pendingId).toBe(f.pendingId);
  const guard=createPlanCountPermissionGuard();
  expect(guard(captured.screen,'',f.read())).toBe('grant');
  expect(guard(captured.screen,'',f.read())).toBe('handled');
 }finally{f.close();}
});

test('a trimmed empty unchanged row is still compared with its source line',()=>{
 const f=fixture();try{
  expect(f.read(captured.screen.replace(/^ 212 +$/m,' 212'))?.pendingId).toBe(f.pendingId);
  expect(f.read(captured.screen.replace(/^ 212 +$/m,' 212  stray'))).toBeNull();
 }finally{f.close();}
});

test.each([
 ['changed wrapped unchanged row',(s:string)=>s.replace('man: ~4-6 weeks','man: ~9 weeks')],
 ['extra wrapped unchanged row',(s:string)=>s.replace(/^( {6}man: [^\n]*\n)/m,'$1      injected text\n')],
 ['wrapped unchanged row after an added row',(s:string)=>s.replace(/\n( 210 )/,'\n      stray\n$1')],
 ['four-column unchanged wrap',(s:string)=>s.replace(/^ {6}man:/m,'    man:')],
 ['quoted unchanged wrap',(s:string)=>s.replace(/^ {6}man:/m,'      > man:')],
 ['changed numbered unchanged row',(s:string)=>s.replace(' 210  C) Smoke-test intent',' 210  C) Smoke-test demand')],
 ['changed added row',(s:string)=>s.replace('+rwise redirect','+rwise ignore')],
])('%s is refused',(_,change)=>{
 const f=fixture();try{
  const screen=change(captured.screen);expect(screen).not.toBe(captured.screen);
  expect(f.read(screen)).toBeNull();
  expect(createPlanCountPermissionGuard()(screen,'',f.read(screen))).not.toBe('grant');
 }finally{f.close();}
});
