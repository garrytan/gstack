import {expect, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {createFilePermissionRecorder, recordFilePermission, currentFilePermissionEpoch} from './helpers/plan-count-file-permission';
import {readPlanCountTranscript} from './helpers/plan-count-transcript';
import {createPlanCountPermissionGuard} from './helpers/claude-pty-runner';
import captured from './fixtures/plan-create-permission-361c.json';

function fixture() {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'create-pane-'));
  const cwd=path.join(dir,'cwd'), config=path.join(dir,'config');fs.mkdirSync(cwd);
  const expected=path.join(cwd,path.basename(captured.event.input.file_path));
  const sessionId=captured.event.sessionId, id=captured.event.toolUseId;
  const journal=path.join(config,'projects','owned',sessionId+'.jsonl');fs.mkdirSync(path.dirname(journal),{recursive:true});
  const recorder=createFilePermissionRecorder(cwd,config,expected)!;
  const startedAt=Date.now()-1000, timestamp=new Date().toISOString();
  const input={...captured.event.input,file_path:expected};
  const block={type:'tool_use',id,name:'Write',input};
  const native=(role:string,content:any[])=>({cwd,sessionId,isSidechain:false,timestamp,message:{role,content}});
  const original=[native('assistant',[{type:'text',text:'Preparing the review.'},block])];
  const write=(rows:any[])=>fs.writeFileSync(journal,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
  write(original);
  recordFilePermission(JSON.stringify({hook_event_name:'PreToolUse',tool_name:'Write',session_id:sessionId,
    tool_use_id:id,cwd,transcript_path:journal,tool_input:input}),recorder.file,cwd,config,expected);
  const read=(screen=captured.screen)=>currentFilePermissionEpoch(recorder.file,expected,cwd,config,startedAt,
    readPlanCountTranscript(config,cwd),screen);
  return {dir,cwd,config,expected,sessionId,id,journal,recorder,startedAt,input,block,native,original,write,read,
    close(){recorder.dispose();fs.rmSync(dir,{recursive:true,force:true});}};
}

test('captured cropped Create binds the pending public Write and grants only once',()=>{
  const f=fixture();try {
    const epoch=f.read();expect(epoch?.pendingId).toBe(`${f.sessionId}:${f.id}`);
    const guard=createPlanCountPermissionGuard();expect(guard(captured.screen,'',epoch)).toBe('grant');
    expect(guard(captured.screen,'',epoch)).toBe('handled');
    expect(fs.readFileSync(f.recorder.file,'utf8')).not.toContain('Decision ledger');
  }finally{f.close();}
});

for(const variant of ['leading-padding','later-row','wrapped-first-row','alternate-rule','optional-key-hint'])
test(`cropped Create supports ${variant} without weakening native binding`,()=>{
  const f=fixture();try {
    let screen=captured.screen;
    if(variant==='leading-padding')screen='\n\n'+screen;
    if(variant==='later-row')screen=screen.slice(screen.indexOf('  39 '));
    if(variant==='wrapped-first-row')screen=screen.slice(screen.indexOf('      |\n'));
    if(variant==='alternate-rule')screen=screen.replaceAll('╌','─').replace('·','•');
    if(variant==='optional-key-hint')screen=screen.replace(' (shift+tab)','');
    expect(f.read(screen)?.pendingId).toBe(`${f.sessionId}:${f.id}`);
  }finally{f.close();}
});

test('identical public use repeats do not change the current native identity',()=>{
  const f=fixture();try {
    f.write([...f.original,f.native('assistant',[structuredClone(f.block)])]);
    expect(f.read()?.pendingId).toBe(`${f.sessionId}:${f.id}`);
  }finally{f.close();}
});

for(const variant of ['foreign-path','foreign-id','completed','ambiguous','wrong-tool','wrong-content','missing-journal','wrong-session',
  'completed-replay','conflicting-duplicate'])
test(`cropped Create rejects ${variant} native identity`,()=>{
  const f=fixture();try {
    const changed=structuredClone(f.block);
    if(variant==='foreign-path')changed.input.file_path=path.join(f.dir,path.basename(f.expected));
    if(variant==='foreign-id')changed.id='foreign';
    if(variant==='wrong-tool')changed.name='Edit';
    if(variant==='wrong-content')changed.input.content='unrelated content';
    const rows=[f.native('assistant',[{type:'text',text:'Preparing the review.'},changed])];
    if(variant==='completed')rows.push(f.native('user',[{type:'tool_result',tool_use_id:f.id,content:'done'}]));
    if(variant==='ambiguous')rows.push(f.native('assistant',[{...f.block,id:'foreign',input:{...f.input,file_path:path.join(f.dir,path.basename(f.expected))}}]));
    if(variant==='completed-replay')rows.push(f.native('user',[{type:'tool_result',tool_use_id:f.id,content:'done'}]),
      f.native('assistant',[structuredClone(f.block)]));
    if(variant==='conflicting-duplicate')rows.unshift(f.native('assistant',[
      {...f.block,input:{...f.input,file_path:path.join(f.dir,path.basename(f.expected))}}]));
    if(variant==='wrong-session')rows[0].sessionId='foreign';
    f.write(rows);
    if(variant==='missing-journal')fs.unlinkSync(f.journal);
    expect(f.read()).toBeNull();
  }finally{f.close();}
});

for(const variant of ['foreign-basename','quoted','auq','missing-footer','missing-no','changed-preview','only-one-row'])
test(`cropped Create rejects ${variant} viewport`,()=>{
  const f=fixture();try {
    let screen=captured.screen;
    if(variant==='foreign-basename')screen=screen.replace(path.basename(f.expected),'foreign.md');
    if(variant==='quoted')screen=screen.split('\n').map(l=>'> '+l).join('\n');
    if(variant==='auq')screen='☐ Finding\n'+screen;
    if(variant==='missing-footer')screen=screen.replace('Esc to cancel · Tab to amend','');
    if(variant==='missing-no')screen=screen.replace('3. No','');
    if(variant==='changed-preview')screen=screen.replace('Decision ledger','Unrelated contents');
    if(variant==='only-one-row')screen=screen.slice(screen.indexOf('  46 '));
    expect(f.read(screen)).toBeFalsy();
  }finally{f.close();}
});
