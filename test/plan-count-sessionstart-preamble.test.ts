import {afterEach, expect, test} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readPlanCountTranscript, readOwnedClaudePublicTranscript, type NativePublicToolEvent} from '../lib/claude-public-transcript';

// At startup Claude Code writes a chain of SessionStart hook attachments from a
// null root, and parents the first user message on the last of them.
const dirs:string[]=[];
afterEach(()=>{for(const d of dirs.splice(0))fs.rmSync(d,{recursive:true,force:true});});
const uuid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const sid='session-owned',cwd='/fixture/repo',time='2026-09-30T20:13:09.603Z';
const base=(n:number,parent:number|null)=>({sessionId:sid,cwd,isSidechain:false,uuid:uuid(n),
 parentUuid:parent===null?null:uuid(parent),timestamp:time});
const hook=(n:number,parent:number|null)=>({...base(n,parent),type:'attachment',
 attachment:{type:'hook_success',hookName:'SessionStart:startup',hookEvent:'SessionStart',exitCode:0}});
const msg=(n:number,parent:number|null,role:string,content:any)=>({...base(n,parent),type:role,message:{role,content}});
const autoplan='<command-message>autoplan</command-message>\n<command-name>/autoplan</command-name>';
function conversation(parent:number|null):any[]{return [
 {...msg(10,parent,'user',autoplan),origin:{kind:'human'},promptId:uuid(80)},
 msg(11,10,'assistant',[{type:'tool_use',id:'read-owned',name:'Read',input:{file_path:'/fixture/plan.md'}}]),
 msg(12,11,'user',[{type:'tool_result',tool_use_id:'read-owned',content:'Plan.'}]),
];}
const preamble=()=>[hook(1,null),hook(2,1),hook(3,2)];
const withPreamble=()=>[...preamble(),...conversation(3)];
function write(records:any[]){
 const config=fs.mkdtempSync(path.join(os.tmpdir(),'sessionstart-'));dirs.push(config);
 const project=path.join(config,'projects','owned');fs.mkdirSync(project,{recursive:true});
 const file=path.join(project,sid+'.jsonl');
 fs.writeFileSync(file,records.map(r=>JSON.stringify(r)).join('\n')+'\n');
 return {config,file};
}
function legacy(records:any[]){
 const {config}=write(records);const events:NativePublicToolEvent[]=[];
 readPlanCountTranscript(config,cwd,e=>events.push(e));return events;
}
const owned=(records:any[])=>readOwnedClaudePublicTranscript(write(records).file,cwd,sid);
const uses=(events:{kind:string}[])=>events.filter(e=>e.kind==='use'||e.kind==='result').length;

test('a SessionStart hook preamble is transparent to session ownership',()=>{
 const plain=owned(conversation(null)),hooked=owned(withPreamble());
 expect(hooked.transcript.status).toBe('ready');
 expect(hooked).toEqual(plain);
 expect(hooked.events.find(e=>e.kind==='user_turn')).toMatchObject({autoplan:true});
 expect(legacy(withPreamble())).toEqual(legacy(conversation(null)));
 expect(uses(legacy(withPreamble()))).toBe(2);
});
test('the scan keeps following the session across a cwd change after the preamble',()=>{

 expect(uses(legacy(moved(withPreamble())))).toBe(2);
 expect(uses(owned(moved(withPreamble())).events)).toBe(2);
});
test('a preamble flushed after its child keeps ownership',()=>{
 const r=withPreamble();expect(owned([r[3],r[2],r[0],r[1],...r.slice(4)])).toEqual(owned(r));
});

for(const [name,change] of Object.entries({
 'non-SessionStart hook':(r:any[])=>r[1].attachment.hookEvent='UserPromptSubmit',
 'attachment without hook event':(r:any[])=>delete r[1].attachment,
 'assistant anchored on the preamble':(r:any[])=>r[1].message={role:'assistant',content:[]},
 'foreign preamble cwd':(r:any[])=>r[1].cwd='/another/fixture',
 'sidechain preamble':(r:any[])=>r[1].isSidechain=true,
 'agent preamble':(r:any[])=>r[1].agentId='reviewer-child',
 'foreign preamble session':(r:any[])=>r[1].sessionId='foreign-session',
 'dangling preamble root':(r:any[])=>r[0].parentUuid=uuid(99),
 'missing preamble link':(r:any[])=>r.splice(1,1),
 'cyclic preamble':(r:any[])=>r[0].parentUuid=uuid(3),
 'competing root on the preamble':(r:any[])=>r.push({...msg(20,3,'user','second root')}),
 'competing null root':(r:any[])=>r.push({...msg(21,null,'user','second root')}),
})) test(`${name} supplies no ownership`,()=>{
 const r=withPreamble();change(r);
 expect(uses(owned(r).events)).toBe(0);
});

const moved=(r:any[])=>{for(const x of r.slice(-2))x.cwd='/fixture/elsewhere';return r;};
for(const [name,change] of Object.entries({
 'non-SessionStart hook':(r:any[])=>r[1].attachment.hookEvent='UserPromptSubmit',
 'foreign preamble cwd':(r:any[])=>r[1].cwd='/another/fixture',
 'sidechain preamble':(r:any[])=>r[1].isSidechain=true,
 'agent preamble':(r:any[])=>r[1].agentId='reviewer-child',
 'foreign preamble session':(r:any[])=>r[1].sessionId='foreign-session',
 'dangling preamble root':(r:any[])=>r[0].parentUuid=uuid(99),
 'cyclic preamble':(r:any[])=>r[0].parentUuid=uuid(3),
})) test(`${name} cannot carry the scan across a cwd change`,()=>{
 const r=moved(withPreamble());change(r);expect(uses(legacy(r))).toBe(0);
});
