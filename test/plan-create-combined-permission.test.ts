import {expect, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {createFilePermissionRecorder, recordFilePermission, currentFilePermissionEpoch} from './helpers/plan-count-file-permission';
import {readPlanCountTranscript} from './helpers/plan-count-transcript';
import {createPlanCountPermissionGuard} from './helpers/claude-pty-runner';
import captures from './fixtures/plan-create-combined-permission-70b.json';

function fixture(captured: typeof captures[number]) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'create-combined-'));
  const cwd=path.join(dir,'owned report directory'), config=path.join(dir,'config');fs.mkdirSync(cwd);
  const expected=path.join(cwd,path.basename(captured.event.input.file_path));
  const sessionId=captured.event.sessionId, id=captured.event.toolUseId;
  const journal=path.join(config,'projects','owned',sessionId+'.jsonl');fs.mkdirSync(path.dirname(journal),{recursive:true});
  const recorder=createFilePermissionRecorder(cwd,config,expected)!;
  const startedAt=Date.now()-1000, timestamp=new Date().toISOString();
  // Only fixture ownership/time are rebound. Source content and viewport remain
  // literal; replace the original directory in the native footer, not its preview.
  const promptAt=captured.screen.indexOf('Do you want to create ');
  const screen=captured.screen.slice(0,promptAt)+captured.screen.slice(promptAt)
    .replaceAll(path.dirname(captured.event.input.file_path),cwd);
  const input={...captured.event.input,file_path:expected};
  const block={type:'tool_use',id,name:'Write',input};
  const native=(role:string,content:any[])=>({cwd,sessionId,isSidechain:false,timestamp,message:{role,content}});
  const original=[native('assistant',[{type:'text',text:'Preparing the review.'},block])];
  const write=(rows:any[])=>fs.writeFileSync(journal,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
  write(original);
  recordFilePermission(JSON.stringify({hook_event_name:'PreToolUse',tool_name:'Write',session_id:sessionId,
    tool_use_id:id,cwd,transcript_path:journal,tool_input:input}),recorder.file,cwd,config,expected);
  const read=(s=screen)=>currentFilePermissionEpoch(recorder.file,expected,cwd,config,startedAt,
    readPlanCountTranscript(config,cwd),s);
  return {dir,cwd,screen,config,expected,sessionId,id,journal,recorder,input,block,native,original,write,read,
    close(){recorder.dispose();fs.rmSync(dir,{recursive:true,force:true});}};
}

for(const captured of captures) {
  test(`${captured.case}: actual combined Create grants the owned pending Write once`,()=>{
    const f=fixture(captured);try {
      const epoch=f.read();expect(epoch?.pendingId).toBe(`${f.sessionId}:${f.id}`);
      const guard=createPlanCountPermissionGuard();
      expect(guard(f.screen,'',epoch)).toBe('grant');
      expect(guard(f.screen,'',epoch)).toBe('handled');
      expect(fs.readFileSync(f.recorder.file,'utf8')).not.toContain(f.input.content);
    }finally{f.close();}
  });

  for(const variant of ['single-line','different-wrap','no-key-hint','standalone'])
  test(`${captured.case}: native option layout ${variant} preserves one-time action`,()=>{
    const f=fixture(captured);try {
      const at=f.screen.indexOf('   2.');const prefix=f.screen.slice(0,at);
      let footer=f.screen.slice(at);
      if(variant==='single-line')footer=footer.replace(/;\s+Yes,\s+and\s+always\s+allow\s+access\s+to\s+/,'; Yes, and always allow access to ');
      if(variant==='different-wrap')footer=footer.replace(/;\s+Yes,\s+and\s+always\s+allow\s+access\s+to\s+/,';\n      Yes, and always\n      allow access to ');
      if(variant==='no-key-hint')footer=footer.replace(/\s*\(shift\+tab\)/,'');
      if(variant==='standalone')footer=footer.replace(/;\s+Yes,\s+and\s+always\s+allow\s+access\s+to\s+[^\r\n]+?\s+for\s+this\s+session/,'');
      expect(f.read(prefix+footer)?.pendingId).toBe(`${f.sessionId}:${f.id}`);
    }finally{f.close();}
  });

  for(const variant of ['foreign-directory','ancestor','relative','traversal','quoted-directory','extra-directory',
    'selected-2','selected-no','missing-no','changed-action','permanent-access','quoted','auq','missing-footer'])
  test(`${captured.case}: combined Create rejects ${variant}`,()=>{
    const f=fixture(captured);try {
      let screen=f.screen;
      if(variant==='foreign-directory')screen=screen.replace(f.cwd,f.cwd+'-foreign');
      if(variant==='ancestor')screen=screen.replace(f.cwd,path.dirname(f.cwd));
      if(variant==='relative')screen=screen.replace(f.cwd,'./owned report directory');
      if(variant==='traversal')screen=screen.replace(f.cwd,f.cwd+'/../owned report directory');
      if(variant==='quoted-directory')screen=screen.replace(f.cwd,'"'+f.cwd+'"');
      if(variant==='extra-directory')screen=screen.replace(f.cwd,f.cwd+' and /foreign');
      if(variant==='selected-2')screen=screen.replace('❯ 1. Yes','  1. Yes').replace('   2. Yes',' ❯ 2. Yes');
      if(variant==='selected-no')screen=screen.replace('❯ 1. Yes','  1. Yes').replace('   3. No',' ❯ 3. No');
      if(variant==='missing-no')screen=screen.replace('3. No','');
      if(variant==='changed-action')screen=screen.replace('1. Yes','1. Yes, always allow');
      if(variant==='permanent-access')screen=screen.replace(/for\s+this\s+session(?=\s*\(shift\+tab\))/,'permanently');
      if(variant==='quoted')screen=screen.split('\n').map(l=>'> '+l).join('\n');
      if(variant==='auq')screen='☐ Finding\n'+screen;
      if(variant==='missing-footer')screen=screen.replace('Esc to cancel · Tab to amend','');
      expect(screen).not.toBe(f.screen);expect(f.read(screen)).toBeFalsy();
    }finally{f.close();}
  });

  for(const variant of ['foreign-path','foreign-id','completed','ambiguous','wrong-tool','wrong-content',
    'missing-journal','wrong-session','completed-replay','conflicting-duplicate'])
  test(`${captured.case}: combined footer cannot override ${variant} native evidence`,()=>{
    const f=fixture(captured);try {
      const changed=structuredClone(f.block);
      if(variant==='foreign-path')changed.input.file_path=path.join(f.dir,path.basename(f.expected));
      if(variant==='foreign-id')changed.id='foreign';
      if(variant==='wrong-tool')changed.name='Edit';
      if(variant==='wrong-content')changed.input.content='unrelated content';
      const rows=[f.native('assistant',[{type:'text',text:'Preparing the review.'},changed])];
      if(variant==='completed')rows.push(f.native('user',[{type:'tool_result',tool_use_id:f.id,content:'done'}]));
      if(variant==='ambiguous')rows.push(f.native('assistant',[{...f.block,id:'foreign'}]));
      if(variant==='completed-replay')rows.push(f.native('user',[{type:'tool_result',tool_use_id:f.id,content:'done'}]),f.native('assistant',[structuredClone(f.block)]));
      if(variant==='conflicting-duplicate')rows.unshift(f.native('assistant',[{...f.block,input:{...f.input,content:'different'}}]));
      if(variant==='wrong-session')rows[0].sessionId='foreign';
      f.write(rows);if(variant==='missing-journal')fs.unlinkSync(f.journal);
      expect(f.read()).toBeNull();
    }finally{f.close();}
  });
}
