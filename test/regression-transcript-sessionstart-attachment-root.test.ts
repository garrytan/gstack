import {afterEach, expect, test} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readPlanCountTranscript, type NativePublicToolEvent} from './helpers/plan-count-transcript';
import {readOwnedClaudePublicTranscript} from '../lib/claude-public-transcript';

// Sessions with SessionStart hooks journal message-less attachment records
// before the first user turn, so that turn's parentUuid is an attachment, not
// null. Ownership must root through that preamble instead of reporting the
// transcript missing (which made every guarded /autoplan phase entry fail).
const dirs:string[]=[];
afterEach(()=>{for(const d of dirs.splice(0))fs.rmSync(d,{recursive:true,force:true});});
const uuid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const sid='session-hooked',cwd='/fixture/repo',time='2026-09-24T18:00:00.000Z';
const base=(n:number,parent:number|null)=>({sessionId:sid,cwd,isSidechain:false,uuid:uuid(n),
 parentUuid:parent===null?null:uuid(parent),timestamp:time});
const attachment=(n:number,parent:number|null,kind='hook_success')=>({...base(n,parent),type:'attachment',
 attachment:{type:kind,hookEvent:'SessionStart'}});
const message=(n:number,parent:number|null,role:string,content:any[])=>({...base(n,parent),type:role,message:{role,content}});
const use={type:'tool_use',id:'read-hooked',name:'Read',input:{file_path:'/fixture/plan.md'}};
function rows():any[]{return [
 {type:'permission-mode',permissionMode:'plan',sessionId:sid},
 attachment(1,null),attachment(2,1),attachment(3,2,'hook_additional_context'),
 message(4,3,'user',[{type:'text',text:'Run the review.'}]),
 message(5,4,'assistant',[use]),
];}
function write(records:any[]){
 const config=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'plan-hooked-')));dirs.push(config);
 const project=path.join(config,'projects','owned');fs.mkdirSync(project,{recursive:true});
 const journal=path.join(project,sid+'.jsonl');
 fs.writeFileSync(journal,records.map(r=>JSON.stringify(r)).join('\n')+'\n');
 return {config,journal};
}

test('a SessionStart attachment preamble roots the first user turn for ordinary readers',()=>{
 const {config}=write(rows());const events:NativePublicToolEvent[]=[];
 const transcript=readPlanCountTranscript(config,cwd,e=>events.push(e));
 expect(transcript.status).toBe('ready');
 expect(events.map(e=>e.toolUseId)).toContain('read-hooked');
});

test('the owned native reader accepts the same preamble',()=>{
 const {journal}=write(rows());
 const {transcript,events}=readOwnedClaudePublicTranscript(journal,cwd,sid);
 expect(transcript.status).toBe('ready');
 expect(events.some(e=>e.kind==='use'&&e.toolUseId==='read-hooked')).toBe(true);
});

for(const [name,change] of Object.entries({
 'preamble with a message':(r:any[])=>{r[2].message={role:'assistant',content:[]};},
 'broken preamble chain':(r:any[])=>{r[2].parentUuid=uuid(99);},
 'foreign preamble cwd':(r:any[])=>{r[1].cwd='/another/fixture';},
 'non-attachment preamble':(r:any[])=>{r[2].type='system';},
 'assistant first turn':(r:any[])=>{r[4].message.role='assistant';},
})) test(`owned reader stays closed on ${name}`,()=>{
 const r=rows();change(r);const {journal}=write(r);
 const {events}=readOwnedClaudePublicTranscript(journal,cwd,sid);
 expect(events.some(e=>e.kind==='use'&&e.toolUseId==='read-hooked')).toBe(false);
});
