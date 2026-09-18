import {expect,test} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fixture from './fixtures/design-crop-gutter-ap.json';
import previous from './fixtures/plan-count-crop-ak.json';
import {currentFilePermissionEpoch} from './helpers/plan-count-file-permission';
import {createPlanCountPermissionGuard} from './helpers/claude-pty-runner';
import {E2E_TOUCHFILES,selectTests} from './helpers/touchfiles';

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
  ['oversized current file',f=>{f.before+='x'.repeat(65537);}],
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

test('new public regression dependencies select exactly the existing file-permission owners',()=>{
  for(const file of ['test/design-crop-gutter-ap.test.ts','test/fixtures/design-crop-gutter-ap.json']){
    expect(selectTests([file],E2E_TOUCHFILES).selected.sort()).toEqual(selectTests(['test/helpers/plan-count-file-permission.ts'],E2E_TOUCHFILES).selected.sort());
  }
});
