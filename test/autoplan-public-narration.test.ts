import {expect,test} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readPlanCountTranscript,type NativePublicToolEvent} from './helpers/plan-count-transcript';
import {autoplanPhaseCompletions} from './helpers/autoplan-phase-observer';
import fixture from './fixtures/autoplan-public-narration-ad.json';
import {E2E_TOUCHFILES,selectTests} from './helpers/touchfiles';

const at=Date.parse(fixture.provenance.timestamp);
function read(blocks: unknown[]= [fixture.block],delta: any={},complete=true) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'public-narration-')),cwd=path.join(dir,'repo');
 const project=path.join(dir,'projects','owned');fs.mkdirSync(project,{recursive:true});
 const record={cwd,isSidechain:false,sessionId:fixture.provenance.sessionId,
  timestamp:fixture.provenance.timestamp,uuid:fixture.provenance.uuid,
  message:{role:'assistant',content:blocks},...delta};
 const file=path.join(project,fixture.provenance.sessionId+'.jsonl');
 fs.writeFileSync(file,JSON.stringify(record)+(complete?'\n':''));
 const tools:NativePublicToolEvent[]=[];
 try{return {transcript:readPlanCountTranscript(dir,cwd,event=>tools.push(event)),tools};}
 finally{fs.rmSync(dir,{recursive:true,force:true});}
}

test('actual public server narration is projected at its original session and timestamp',()=>{
 const {transcript,tools}=read();
 expect(transcript.assistantMessages).toEqual([{sessionId:fixture.provenance.sessionId,
  timestamp:fixture.provenance.timestamp,text:fixture.block.thinking}]);
 expect(transcript.calls).toEqual([]);expect(tools).toEqual([]);
 expect(autoplanPhaseCompletions(transcript,at-1)).toEqual([{phase:1,ts:at}]);
});
test('actual Phase 1 is done declaration independently matches the phase marker',()=>{
 expect(autoplanPhaseCompletions({status:'ready',calls:[],assistantMessages:[{
  sessionId:fixture.provenance.sessionId,timestamp:fixture.provenance.timestamp,
  text:fixture.block.thinking}]},at-1)).toEqual([{phase:1,ts:at}]);
});

// Minimal synthetic protobuf envelopes exercise public-tag classification only.
// No opaque native signature or untagged model text is stored in this fixture.
const vi=(n:number):number[]=>{const bytes:number[]=[];do{const b=n%128;n=Math.floor(n/128);bytes.push(b+(n?128:0));}while(n);return bytes;};
const field=(n:number,body:Uint8Array)=>Buffer.from([...vi(n*8+2),...vi(body.length),...body]);
const tagged=(kind='narration')=>field(2,field(1,field(8,Buffer.from(kind))));
const summary=(signature=fixture.block.signature,thinking=fixture.block.thinking)=>({type:'thinking',thinking,signature});
const encode=(bytes:Uint8Array)=>Buffer.from(bytes).toString('base64');

test('unknown or malformed signature envelopes never become public narration',()=>{
 const invalid:unknown[]=[undefined,null,'',4,'narration','%%%',' '+fixture.block.signature,
  fixture.block.signature+'=',encode(tagged('reasoning')),encode(tagged('Narration')),
  encode(field(1,field(1,field(8,Buffer.from('narration'))))),
  encode(field(2,field(2,field(8,Buffer.from('narration'))))),
  encode(field(2,field(1,field(7,Buffer.from('narration'))))),
  encode(tagged().subarray(0,-1)),encode(Buffer.from([0x12,0x80])),
  encode(Buffer.from([0x12,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0x7f])),
  encode(Buffer.concat([tagged(),Buffer.from([0])])),
  encode(Buffer.concat([tagged(),Buffer.from([0x0f])])),
  encode(Buffer.concat([tagged(),tagged('reasoning')])),
  encode(field(2,Buffer.concat([field(1,field(8,Buffer.from('narration'))),field(1,field(8,Buffer.from('reasoning')))]))),
  encode(field(2,field(1,Buffer.concat([field(8,Buffer.from('narration')),field(8,Buffer.from('reasoning'))])))),
  encode(field(2,field(1,Buffer.concat([field(8,Buffer.from('narration')),field(8,Buffer.from('narration'))])))),
  encode(Buffer.concat([tagged(),field(3,Buffer.alloc(64*1024))])),
 ];
 for(const signature of invalid){
  const {transcript,tools}=read([{...summary(),signature}]);
  expect(transcript.assistantMessages,JSON.stringify(signature)?.slice(0,80)).toEqual([]);
  expect(transcript.calls).toEqual([]);expect(tools).toEqual([]);
 }
});
test('supported unrelated envelope fields preserve an exact public tag',()=>{
 const bytes=Buffer.concat([Buffer.from([0x08,0x01]),tagged(),field(3,Buffer.from('opaque'))]);
 expect(read([summary(encode(bytes))]).transcript.assistantMessages[0]?.text).toBe(fixture.block.thinking);
});
test('private, empty and wrong-kind blocks remain outside the public projection',()=>{
 for(const block of [{type:'thinking',thinking:'SYNTHETIC_PRIVATE_TEXT'},
  {...summary(),signature:encode(tagged('reasoning')),thinking:'SYNTHETIC_PRIVATE_TEXT'},
  {...summary(),thinking:''},{...summary(),thinking:'  '},{...summary(),thinking:7},
  {...summary(),type:'redacted_thinking'},{...summary(),type:'tool_result'},
  {type:'thinking',thinking:'SYNTHETIC_PRIVATE_TEXT',block_kind:'narration'}]){
  expect(read([block]).transcript.assistantMessages).toEqual([]);
 }
});
test('parent role, cwd, native filename and complete valid timestamp remain required',()=>{
 for(const delta of [{cwd:'/foreign'},{sessionId:'foreign'},
  {isSidechain:true},{isSidechain:undefined},{timestamp:'invalid'},
  {timestamp:null},{message:{role:'user',content:[fixture.block]}},
  {message:{role:'system',content:[fixture.block]}}]){
  expect(read([fixture.block],delta).transcript.assistantMessages).toEqual([]);
 }
 expect(read([fixture.block],{},false).transcript.assistantMessages).toEqual([]);
});
test('public narration does not manufacture questions, replies or plan approval',()=>{
 const {transcript,tools}=read([summary(),{type:'text',text:'Ordinary assistant prose.'},
  {type:'thinking',thinking:'SYNTHETIC_PRIVATE_TEXT'},
  {type:'tool_use',id:'actual-read',name:'Read',input:{file_path:'/owned/PLAN.md'}}]);
 expect(transcript.assistantMessages.map(m=>m.text)).toEqual([fixture.block.thinking,'Ordinary assistant prose.']);
 expect(transcript.calls).toEqual([]);expect(transcript.planReadyRequests).toBeUndefined();
 expect(tools.map(e=>[e.kind,e.toolUseId,e.name])).toEqual([['use','actual-read','Read']]);
});
function hits(text:string,start=at-1,timestamp=fixture.provenance.timestamp){
 return autoplanPhaseCompletions({status:'ready',calls:[],assistantMessages:[{
  sessionId:fixture.provenance.sessionId,timestamp,text}]},start);
}
test('new done declarations retain exact phase numbers, punctuation and timestamps',()=>{
 for(const phase of [1,2,2.5,3])for(const tail of ['', '.', ': Work retained.', '. Work retained.']){
  expect(hits(`Phase ${phase} is done${tail}`)).toEqual([{phase,ts:at}]);
 }
 expect(hits('**Phase 1 is done.**')).toEqual([{phase:1,ts:at}]);
 expect(hits(fixture.block.thinking,at+1)).toEqual([]);
 expect(hits(fixture.block.thinking,at-1,'invalid')).toEqual([]);
 expect(hits('Phase 1 complete. Work retained.')).toEqual([{phase:1,ts:at}]);
});
test('source examples, questions, promises and quoted done markers are not phase completion',()=>{
 for(const text of ['Phase 1 is done?', 'Phase 1 is done eventually', 'Phase 1 is not done.',
  'Once Phase 1 is done, continue.', 'Phase 1 will be done.', 'Phase 4 is done.',
  'Phase 2.1 is done.', '# Phase 1 is done.', '> Phase 1 is done.',
  '- Phase 1 is done.', '| Phase 1 is done. |', '    Phase 1 is done.',
  '```text\nPhase 1 is done.\n```', '~~~text\nPhase 1 is done.\n~~~',
  'Example:\nPhase 1 is done.\nPhase 2 is done.',
  'Emit phase-transition summary: Phase 1 is done.',
  '**Phase 1 is done** if the tests pass.']) expect(hits(text),text).toEqual([]);
});
test('phase ordering and duplicate collapse use native time rather than polling order',()=>{
 const t={status:'ready' as const,calls:[],assistantMessages:[
  {sessionId:'parent',timestamp:new Date(at+20).toISOString(),text:'Phase 2 is done.'},
  {sessionId:'parent',timestamp:new Date(at+10).toISOString(),text:fixture.block.thinking},
  {sessionId:'parent',timestamp:new Date(at+30).toISOString(),text:'Phase 1 is done.'}]};
 expect(autoplanPhaseCompletions(t,at)).toEqual([{phase:1,ts:at+10},{phase:2,ts:at+20}]);
});

test('public narration changes select every existing shared native-reader consumer',()=>{
 const reader=selectTests(['test/helpers/plan-count-transcript.ts'],E2E_TOUCHFILES).selected.sort();
 expect(reader).toHaveLength(8);expect(reader).toContain('autoplan-chain-pty');
 expect(reader).toContain('plan-ceo-mode-routing');
 for(const file of ['test/autoplan-public-narration.test.ts','test/fixtures/autoplan-public-narration-ad.json'])
  expect(selectTests([file],E2E_TOUCHFILES).selected.sort()).toEqual(reader);
});
