import {afterEach, expect, test} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readPlanCountTranscript, type NativePublicToolEvent} from './helpers/plan-count-transcript';
import {auditAutoplanMethodReads} from './helpers/autoplan-method-read-audit';
import {autoplanPhaseCompletions} from './helpers/autoplan-phase-observer';

const dirs:string[]=[];
afterEach(()=>{for(const d of dirs.splice(0))fs.rmSync(d,{recursive:true,force:true});});
const uuid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const sid='session-owned',cwd='/fixture/repo',archive='/fixture/state/project/ceo-plans';
const time='2026-09-11T01:23:54.673Z';
const record=(n:number,parent:number|null,where=cwd,role='assistant',content:any[]=[])=>({
 sessionId:sid,cwd:where,isSidechain:false,uuid:uuid(n),parentUuid:parent===null?null:uuid(parent),
 timestamp:time,message:{role,content},
});
const use={type:'tool_use',id:'read-owned',name:'Read',input:{file_path:'/fixture/state/methodology.md',offset:1,limit:2}};
const file={filePath:'/fixture/state/methodology.md',startLine:1,numLines:2,totalLines:2,content:'Review every phase.\nPreserve ownership.'};
function rows():any[]{return [
 record(1,null,cwd,'user',[{type:'text',text:'Run the review.'}]),
 {...record(2,1),message:undefined,type:'attachment'},
 record(3,2,archive,'assistant',[use]),
 {...record(4,3,archive,'user',[{type:'tool_result',tool_use_id:'read-owned',content:'Public Read output.'}]),toolUseResult:{file}},
 record(5,4,archive,'assistant',[{type:'text',text:'Phase 1 complete.'}]),
 record(6,5,cwd,'assistant',[{type:'tool_use',id:'dispatch',name:'Agent',input:{prompt:'You are the independent DESIGN reviewer for this phase.\nRead the bound methodology.'}}]),
];}
function read(records:any[],options:{partial?:boolean,name?:string}={}){
 const config=fs.mkdtempSync(path.join(os.tmpdir(),'plan-cwd-'));dirs.push(config);
 const project=path.join(config,'projects','owned');fs.mkdirSync(project,{recursive:true});
 const journal=path.join(project,(options.name??sid)+'.jsonl');
 const bytes=records.map(r=>JSON.stringify(r)).join('\n')+(options.partial?'':'\n');fs.writeFileSync(journal,bytes);
 const events:NativePublicToolEvent[]=[];const transcript=readPlanCountTranscript(config,cwd,e=>events.push(e));
 expect(fs.readFileSync(journal,'utf8')).toBe(bytes);
 return {events,transcript};
}
const methodology={phase:'design',path:file.filePath,content:file.content,lines:2,bytes:Buffer.byteLength(file.content),sha256:createHash('sha256').update(file.content).digest('hex')};
const designAudit=(events:NativePublicToolEvent[])=>auditAutoplanMethodReads(events,()=>methodology).find(a=>a.phase==='design');

test('same native ancestry survives cwd changes and retains exact methodology delivery',()=>{
 const {events,transcript}=read(rows());
 expect(events.map(e=>e.toolUseId)).toEqual(['read-owned','read-owned','dispatch']);
 expect(designAudit(events)?.passed).toBe(true);
 expect(autoplanPhaseCompletions(transcript,0)).toEqual([{phase:1,ts:Date.parse(time)}]);
});
test('the directory name is not an allowlist and returning to the original cwd keeps the chain',()=>{
 const r=rows();for(const x of r)if(x.cwd===archive)x.cwd='/different/owned/work-directory';
 r.push(record(7,6,'/another/directory','assistant',[{type:'text',text:'Phase 2 complete.'}]));
 expect(autoplanPhaseCompletions(read(r).transcript,0).map(x=>x.phase)).toEqual([1,2]);
});

for(const [name,change] of Object.entries({
 'missing origin':(r:any[])=>r.shift(),
 'foreign origin':(r:any[])=>r[0].cwd='/another/fixture',
 'assistant origin':(r:any[])=>r[0].message.role='assistant',
 'non-root origin':(r:any[])=>r[0].parentUuid=uuid(99),
 'missing root UUID':(r:any[])=>delete r[0].uuid,
 'invalid root UUID':(r:any[])=>r[0].uuid='root',
 'sidechain origin':(r:any[])=>r[0].isSidechain=true,
 'agent origin':(r:any[])=>r[0].agentId='child',
 'invalid origin time':(r:any[])=>r[0].timestamp='unknown',
 'disconnected branch':(r:any[])=>r[2].parentUuid=uuid(99),
 'foreign branch session':(r:any[])=>r[2].sessionId='another-session',
 'sidechain branch':(r:any[])=>r[2].isSidechain=true,
 'agent branch':(r:any[])=>r[2].agentId='child',
 'relative branch cwd':(r:any[])=>r[2].cwd='relative-directory',
 'missing branch cwd':(r:any[])=>delete r[2].cwd,
 'invalid branch time':(r:any[])=>r[2].timestamp='unknown',
 'missing branch UUID':(r:any[])=>delete r[2].uuid,
 'duplicate root UUID':(r:any[])=>r[2].uuid=r[0].uuid,
 'missing attachment link':(r:any[])=>r.splice(1,1),
}))test(`${name} cannot supply changed-cwd evidence`,()=>{
 const r=rows();change(r);const {events,transcript}=read(r);
 expect(events.some(e=>e.toolUseId==='read-owned')).toBe(false);
 expect(autoplanPhaseCompletions(transcript,0)).toEqual([]);
 expect(designAudit(events)?.passed).toBe(false);
});

test('a later matching root cannot rebind a session that began in another fixture',()=>{
 const r=rows();r.unshift(record(99,null,'/another/fixture','user'));
 expect(read(r).events.some(e=>e.toolUseId==='read-owned')).toBe(false);
});
test('legacy records without native ancestry retain exact-cwd scoping',()=>{
 const r=rows();for(const x of r){delete x.uuid;delete x.parentUuid;}
 const x=read(r);expect(x.events.map(e=>e.toolUseId)).toEqual(['dispatch']);
 expect(autoplanPhaseCompletions(x.transcript,0)).toEqual([]);
});
test('filename and session identity remain bound',()=>{
 expect(read(rows(),{name:'foreign'}).transcript.status).toBe('missing');
});
test('an incomplete final record cannot supply a changed-cwd completion',()=>{
 const r=rows().slice(0,5);expect(autoplanPhaseCompletions(read(r,{partial:true}).transcript,0)).toEqual([]);
});
test('a changed-cwd question packet still counts once and preserves unanswered tabs',()=>{
 const questions=['First decision?','Second decision?'].map(question=>({header:'Decision',question,options:[{label:'A'},{label:'B'}]}));
 const r=rows();r.push(record(7,6,archive,'assistant',[{type:'tool_use',id:'ask',name:'AskUserQuestion',input:{questions}}]),
  {...record(8,7,archive,'user',[{type:'tool_result',tool_use_id:'ask',content:'Answered first tab.'}]),toolUseResult:{answers:{'First decision?':'A'}}});
 const t=read(r).transcript;expect(t.calls).toHaveLength(1);expect(t.calls[0].answered).toBe(true);
 expect(t.calls[0].unansweredQuestionIndices).toEqual([1]);expect(t.calls[0].questions).toEqual(questions);
});
test('a changed-cwd failed plan approval remains failed',()=>{
 const r=rows();r.push(record(7,6,archive,'assistant',[{type:'tool_use',id:'exit',name:'ExitPlanMode',input:{}}]),
  record(8,7,archive,'user',[{type:'tool_result',tool_use_id:'exit',content:'Not approved.',is_error:true}]));
 const t=read(r).transcript;expect(t.planReadyRequests).toHaveLength(1);expect(t.planReadyRequests![0].failed).toBe(true);expect(t.calls).toEqual([]);
});
for(const [name,change] of Object.entries({
 'foreign file path':(r:any[])=>r[3].toolUseResult={file:{...file,filePath:'/other/methodology.md'}},
 'incorrect content':(r:any[])=>r[3].toolUseResult={file:{...file,content:'Omitted required instructions.'}},
 'error result':(r:any[])=>r[3].message.content[0].is_error=true,
 'wrong result id':(r:any[])=>r[3].message.content[0].tool_use_id='another-tool',
 'future result':(r:any[])=>r[3].timestamp='2026-09-11T02:00:00.000Z',
}))test(`cwd continuation does not bypass ${name}`,()=>{
 const r=rows();change(r);expect(designAudit(read(r).events)?.passed).toBe(false);
});
