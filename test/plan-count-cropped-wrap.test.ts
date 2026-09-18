import {expect,test} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import captured from './fixtures/plan-count-cropped-wrap-6714.json';
import {currentFilePermissionEpoch} from './helpers/plan-count-file-permission';
import {createPlanCountPermissionGuard} from './helpers/claude-pty-runner';

function replay(change:(f:any)=>void=()=>{}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'owned-cropped-wrap-'));
  const expected=path.join(dir,'report.md'),record=path.join(dir,'state.json');
  const f:any={expected,record,cwd:captured.cwd,config:captured.config,startedAt:captured.startedAt,
    screen:captured.screen.replaceAll(path.dirname(captured.hook.expected),dir).replaceAll(path.basename(captured.hook.expected),'report.md'),
    before:captured.ownedBefore,state:{...structuredClone(captured.hook),expected},transcript:structuredClone(captured.transcript),kind:'file'};
  try {
    change(f);fs.writeFileSync(record,JSON.stringify(f.state));
    if(f.kind==='file')fs.writeFileSync(expected,f.before);
    if(f.kind==='directory')fs.mkdirSync(expected);
    if(f.kind==='symlink'){fs.writeFileSync(path.join(dir,'foreign.md'),f.before);fs.symlinkSync(path.join(dir,'foreign.md'),expected);}
    const epoch=currentFilePermissionEpoch(record,f.expected,f.cwd,f.config,f.startedAt,f.transcript,f.screen);
    const guard=createPlanCountPermissionGuard();
    return {epoch,first:guard(f.screen,'',epoch),again:guard(f.screen,'',epoch),screen:f.screen,guard};
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
}

test('actual six wrapped source rows recover the exact pending Edit once',()=>{
  const rows=captured.screen.split('\n');expect(rows[6]).toMatch(/^ 69 -/);
  expect(captured.ownedBefore.split('\n')[67]!.trimEnd().endsWith(rows.slice(0,6).map(r=>r.slice(5).trimEnd()).join(''))).toBe(true);
  expect(captured.pendingEdit.id).toBe(captured.hook.pendingId.split(':')[1]);
  expect(captured.pendingEdit.input.file_path).toBe(captured.hook.expected);
  expect(captured.ownedBefore).toContain(captured.pendingEdit.input.old_string);
  expect(captured.ownedBefore).not.toContain(captured.pendingEdit.input.new_string);
  expect(captured.publicAcknowledgments).toEqual([]);
  const r=replay();expect(r.epoch?.pendingId).toBe(captured.hook.pendingId);expect(r.first).toBe('grant');expect(r.again).toBe('handled');
});

// Synthetic crop positions retain complete exact suffix bytes from the actual line.
test.each([1,2,3,4,5])('the last %d native continuation rows retain current file ownership',count=>{
  const r=replay(f=>{f.screen=f.screen.split('\n').slice(6-count).join('\n');});
  expect(r.epoch?.pendingId).toBe(captured.hook.pendingId);expect(r.first).toBe('grant');
});

test('synthetic unchanged next row uses the same old-file line anchor',()=>{
  const r=replay(f=>{f.screen=f.screen.replace(/^ 69 -/m,' 69  ');});expect(r.epoch?.pendingId).toBe(captured.hook.pendingId);
});

// cf74 batching stopped at an owned Edit because the first physical row ended
// in "so the ". Joining individually trimmed rows changed it to "so thewin".
// Preserve source bytes across any wrap position, including inside whitespace.
const wrappedSource = 'Proof: timing around fetch + recompute is included so the win is measurable after ship.';
test.each([1, 5, 53, 56, 57, 58, 59, 60, 61, wrappedSource.length - 1])(
  'source whitespace survives a native wrap at column %d', split => {
    const r=replay(f=>{
      const source=f.before.split('\n');source[67]=wrappedSource;f.before=source.join('\n');
      f.screen=[wrappedSource.slice(0,split),wrappedSource.slice(split)]
        .map(row=>'     '+row).join('\n')+'\n'+f.screen.split('\n').slice(6).join('\n');
    });
    expect(r.epoch?.pendingId).toBe(captured.hook.pendingId);
    expect(r.first).toBe('grant');expect(r.again).toBe('handled');
  },
);

test('several wrapped whitespace runs stay exact; changes within source text fail',()=>{
  const tails=['Proof: timing ', ' around fetch + ', 'recompute is included so the ', 'win is measurable after ship.'];
  for(const changed of [false,true]){
    const r=replay(f=>{
      const source=f.before.split('\n');source[67]=tails.join('');f.before=source.join('\n');
      const rows=[...tails];if(changed)rows[1]=rows[1]!.replace('fetch','send');
      f.screen=rows.map(row=>'     '+row).join('\n')+'\n'+f.screen.split('\n').slice(6).join('\n');
    });
    expect(Boolean(r.epoch)).toBe(!changed);
    expect(r.first).toBe(changed?'handled':'grant');
  }
});

test.each([0,2,3])('synthetic numeric padding %d derives the matching wrap gutter',padding=>{
  const r=replay(f=>{const rows=f.screen.split('\n');f.screen=rows.map((row:string,i:number)=>i<6?' '.repeat(padding+4)+row.slice(5):row.replace(/^ (69 [ -])/,' '.repeat(padding)+'$1')).join('\n');});
  expect(r.epoch?.pendingId).toBe(captured.hook.pendingId);
});

test('synthetic native success releases only the later pending request',()=>{
  const r=replay();expect(r.first).toBe('grant');
  const old=r.epoch!;const next={...old,pendingId:captured.hook.sessionId+':next'};
  expect(r.guard(r.screen,'',next)).toBe('handled');
  expect(r.guard(r.screen,'',{...next,completedId:old.pendingId,completedIds:[...old.completedIds!,old.pendingId]})).toBe('grant');
  expect(r.guard(r.screen,'',{...next,completedId:old.pendingId,completedIds:[...old.completedIds!,old.pendingId]})).toBe('handled');
});

const negatives:Array<[string,(f:any)=>void]>=[
 ['missing source',f=>{f.kind='missing';}],['source directory',f=>{f.kind='directory';}],
 ['required source line beyond the bounded prefix',f=>{f.before='x'.repeat(65537)+f.before;}],
 ['stale source tail',f=>{f.before=f.before.replace('Architecture section of PLAN.md','Different section of PLAN.md');}],
 ['foreign wrapped text',f=>{f.screen=f.screen.replace('Architecture section of PLAN.md','Different section of PLAN.md');}],
 ['duplicate wrapped row',f=>{f.screen=f.screen.split('\n')[0]+'\n'+f.screen;}],
 ['missing middle row',f=>{const rows=f.screen.split('\n');rows.splice(2,1);f.screen=rows.join('\n');}],
 ['arbitrary source prose prefix',f=>{f.screen='     Apply this edit now\n'+f.screen;}],
 ['quoted rows',f=>{f.screen=f.screen.replace(/^ {5}/gm,'     > ');}],
 ['fenced rows',f=>{f.screen='```text\n'+f.screen;}],
 ['mismatched gutter',f=>{f.screen=f.screen.split('\n').map((r:string,i:number)=>i<6?' '+r:r).join('\n');}],
 ['tab gutter',f=>{f.screen='\t'+f.screen.slice(1);}],
 ['wrong preceding old line',f=>{f.screen=f.screen.replace(/^ 69 -/m,' 70 -');}],
 ['addition alone cannot anchor the old source',f=>{f.screen=f.screen.replace(/^ 69 -/m,' 69 +');}],
 ['foreign menu directory',f=>{f.screen=f.screen.replace('access to '+path.dirname(f.expected),'access to '+path.join(path.dirname(f.expected),'foreign'));}],
 ['conflicting cropped header',f=>{f.screen='../foreign/report.md\n────────\n'+f.screen;}],
 ['foreign hook path',f=>{f.state.expected+='.foreign';}],['foreign hook cwd',f=>{f.state.cwd+='.foreign';}],
 ['foreign session',f=>{f.transcript.calls[0].sessionId='foreign';}],
 ['unavailable native transcript',f=>{f.transcript.status='error';}],
 ['missing pending request',f=>{f.state.pendingId=null;}],
 ['completed request',f=>{f.state.completedId=f.state.pendingId;}],
 ['stale epoch',f=>{f.state.timestamp=new Date(f.startedAt-1).toISOString();}],
 ['future epoch',f=>{f.state.timestamp=new Date(Date.now()+60000).toISOString();}],
 ['missing full footer',f=>{f.screen=f.screen.replace('Esc to cancel · Tab to amend','');}],
 ['changed one-time choice',f=>{f.screen=f.screen.replace('❯ 1. Yes','❯ 1. Yes, always allow');}],
];
test.each(negatives)('%s cannot obtain the owned grant',(_,change)=>{const r=replay(change);expect(r.epoch).not.toBeTruthy();expect(r.first).not.toBe('grant');});
test.skipIf(process.platform==='win32')('symlink cannot provide source ownership',()=>{expect(replay(f=>{f.kind='symlink';}).epoch).toBeNull();});
