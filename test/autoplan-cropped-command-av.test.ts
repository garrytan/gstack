import {expect,test} from 'bun:test';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import fixture from './fixtures/autoplan-cropped-command-av.json';
import * as permission from './helpers/autoplan-artifact-permission';
import {E2E_TOUCHFILES,LLM_JUDGE_TOUCHFILES,selectTests} from './helpers/touchfiles';
type Context=Parameters<typeof permission.publishedAutoplanArtifactPermissionInput>[1];
function replay(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gstack-cropped-command-'));
 const replace=(s:string)=>s.replaceAll(path.dirname(fixture.context.cwd),root);
 const context=JSON.parse(replace(JSON.stringify(fixture.context))) as Context;
 const nativePlan=replace(fixture.nativePlan.path),file=context.pending!.file;
 for(const [name,body,mtime] of [[file,fixture.before,fixture.beforeMtimeMs],[nativePlan,fixture.nativePlan.text,fixture.nativePlan.mtimeMs]] as const){
  fs.mkdirSync(path.dirname(name),{recursive:true});fs.writeFileSync(name,body);fs.utimesSync(name,mtime/1000,mtime/1000);
 }
 fs.mkdirSync(context.cwd,{recursive:true});
 return {root,file,nativePlan,context,viewport:replace(fixture.viewport),dispose:()=>fs.rmSync(root,{recursive:true,force:true})};
}
type Replay=ReturnType<typeof replay>;
const invoke=(r:Replay,seen=new Set<string>())=>permission.publishedAutoplanArtifactPermissionInput(r.viewport,r.context,seen);
const current=(r:Replay)=>r.context.publicTools.find(e=>e.kind==='use'&&e.toolUseId===r.context.pending!.toolUseId)!;
const queued=(r:Replay)=>r.context.publicTools.find(e=>e.kind==='use'&&e.name==='Edit'&&e.input?.file_path===r.nativePlan&&
 !r.context.publicTools.some(result=>result.kind==='result'&&result.toolUseId===e.toolUseId))!;
const bash=(r:Replay)=>r.context.publicTools.find(e=>e.kind==='use'&&e.name==='Bash')!;
const complete=(r:Replay,e:ReturnType<typeof bash>,isError=false)=>r.context.publicTools.push({kind:'result',sessionId:e.sessionId,
 toolUseId:e.toolUseId,timestamp:new Date(r.context.now!).toISOString(),isError,content:'completed'});
const panel=(r:Replay)=>r.viewport.slice(r.viewport.search(/^[─╌]{8,}\n {0,3}Edit file/m));
const show=(r:Replay,command:string,rows=[command])=>{bash(r).input!.command=command;r.viewport='  ⎿  $ '+rows.join('\n     ')+'\n\n'+panel(r)};

test('the retained captionless queued command grants only the current digest-bound Edit',()=>{const r=replay();try{
 expect(r.context.publicTools).toHaveLength(7);
 expect(createHash('sha256').update(fs.readFileSync(r.file)).digest('hex')).toBe(fixture.beforeSha256);
 const expected={input:'1\r',signature:fixture.context.pending.sessionId+':'+fixture.context.pending.toolUseId,file:r.file};
 expect(permission.autoplanArtifactPermissionInput(r.viewport,r.context,new Set())).toBeNull();
 expect(permission.pendingAutoplanArtifactPermissionInput(r.viewport,r.context,new Set())).toBeNull();
 expect(invoke(r)).toEqual(expected);
 expect(invoke(r,new Set([expected.signature]))).toBeNull();
 expect(invoke(r,new Set([permission.autoplanArtifactMenuKey(r.viewport)]))).toBeNull();
 r.viewport=panel(r);expect(invoke(r)).toEqual(expected);
 expect(fixture.provenance.paidOutcomesReclassified).toBe(false);
}finally{r.dispose()}});

for(const [name,change] of [
 ['single row',(r:Replay)=>show(r,bash(r).input!.command)],
 ['different soft wrap',(r:Replay)=>{const command=bash(r).input!.command as string;const at=command.indexOf(' && ');show(r,command,[command.slice(0,at),command.slice(at+1)])}],
 ['CRLF renderer',(r:Replay)=>{r.viewport=r.viewport.replaceAll('\n','\r\n')}],
 ['nonbreaking native gutter',(r:Replay)=>{r.viewport=r.viewport.replace('⎿  $','⎿\u00a0 $')}],
 ['quoted argument with literal spaces',(r:Replay)=>show(r,"printf '%s' 'two  words'")],
 ['soft wrap inside a quoted argument',(r:Replay)=>show(r,"printf '%s' 'two words'",["printf '%s' 'two","words'"])],
] as const)test(`complete public command binding accepts ${name}`,()=>{const r=replay();try{change(r);expect(invoke(r)?.signature).toBe(`${r.context.pending!.sessionId}:${r.context.pending!.toolUseId}`)}finally{r.dispose()}});

const identityCases:Array<[string,(r:Replay)=>void]>=[
 ['missing Bash publication',r=>{r.context.publicTools=r.context.publicTools.filter(e=>e!==bash(r))}],
 ['foreign Bash message',r=>{bash(r).messageId='msg_foreign'}],['foreign Bash request',r=>{bash(r).requestId='req_foreign'}],
 ['foreign Bash session',r=>{bash(r).sessionId='foreign'}],['Bash with no identity',r=>{bash(r).toolUseId=''}],
 ['different command',r=>{bash(r).input!.command+=' && echo other'}],['missing command',r=>{delete bash(r).input!.command}],
 ['multiline command',r=>{bash(r).input!.command+='\n'}],['control byte in command',r=>{bash(r).input!.command+='\x1b'}],
 ['another tool name',r=>{bash(r).name='Read'}],['started command',r=>{r.context.pending!.hookSeenIds!.push(bash(r).toolUseId)}],
 ['completed command',r=>complete(r,bash(r))],['failed command',r=>complete(r,bash(r),true)],
 ['ambiguous queued commands',r=>{r.context.publicTools.push({...structuredClone(bash(r)),toolUseId:'toolu_duplicate'})}],
 ['second unmatched queued command',r=>{r.context.publicTools.push({...structuredClone(bash(r)),toolUseId:'toolu_other',input:{command:'echo other'}})}],
 ['command after viewport',r=>{r.context.viewportCapturedAt=Date.parse(bash(r).timestamp)-1}],
 ['command before queued Edit',r=>{const e=bash(r),q=queued(r),at=r.context.publicTools.indexOf(q);e.timestamp=current(r).timestamp;r.context.publicTools.pop();r.context.publicTools.splice(at,0,e)}],
 ['no queued mutation',r=>{const q=queued(r);r.context.publicTools=r.context.publicTools.filter(e=>e!==q)}],
 ['foreign queued mutation path',r=>{queued(r).input!.file_path='/tmp/foreign.md'}],
 ['foreign queued message',r=>{queued(r).messageId='msg_foreign'}],['foreign queued request',r=>{queued(r).requestId='req_foreign'}],
 ['queued Write',r=>{queued(r).name='Write'}],['queued replace all',r=>{queued(r).input!.replace_all=true}],
 ['started queued Edit',r=>{r.context.pending!.hookSeenIds!.push(queued(r).toolUseId)}],
 ['completed queued Edit',r=>complete(r,queued(r))],
 ['failed native-plan history',r=>{const previous=r.context.publicTools.find(e=>e.kind==='use'&&e.input?.file_path===r.nativePlan&&e!==queued(r))!;r.context.publicTools.find(e=>e.kind==='result'&&e.toolUseId===previous.toolUseId)!.isError=true}],
 ['Read is not native-plan mutation history',r=>{r.context.publicTools.find(e=>e.kind==='use'&&e.input?.file_path===r.nativePlan&&e!==queued(r))!.name='Read'}],
 ['native plan modified after hook',r=>{fs.utimesSync(r.nativePlan,new Date(r.context.now!),new Date(r.context.now!))}],
 ['foreign native-plan root',r=>{r.context.ownedNativePlansRoot=path.join(r.root,'foreign')}],
 ['missing hook',r=>{r.context.pending=undefined}],['missing current publication',r=>{const c=current(r);r.context.publicTools=r.context.publicTools.filter(e=>e!==c)}],
 ['foreign current message',r=>{current(r).messageId='msg_foreign'}],['foreign current request',r=>{current(r).requestId='req_foreign'}],
 ['foreign current session',r=>{current(r).sessionId='foreign'}],['completed current Edit',r=>complete(r,current(r))],
 ['current request changed',r=>{current(r).input!.new_string+=' changed'}],
 ['missing digest',r=>{delete r.context.pending!.editDigest}],['wrong request digest',r=>{r.context.pending!.editDigest!.requestSHA256='0'.repeat(64)}],
 ['wrong before digest',r=>{r.context.pending!.editDigest!.beforeSHA256='0'.repeat(64)}],
 ['file changed',r=>{fs.appendFileSync(r.file,'changed');fs.utimesSync(r.file,0,0)}],
 ['file modified after hook',r=>{fs.utimesSync(r.file,new Date(r.context.now!),new Date(r.context.now!))}],
 ['missing native transcript',r=>{r.context.transcriptStatus='missing'}],['wrong pending identity',r=>{r.context.pending!.toolUseId='toolu_other'}],
 ['failed archive history',r=>{r.context.publicTools.find(e=>e.kind==='result')!.isError=true}],
 ['command before launched review',r=>{r.context.commandStartedAt=r.context.now!+1}],
];
for(const[name,change]of identityCases)test(`caption crop retains native authority: ${name}`,()=>{const r=replay();try{change(r);expect(invoke(r)).toBeNull()}finally{r.dispose()}});

const displayCases:Array<[string,(r:Replay)=>void]>=[
 ['example introduction',r=>{r.viewport='Example:\n'+r.viewport}],['historical introduction',r=>{r.viewport='Historical screen:\n'+r.viewport}],
 ['quoted display',r=>{r.viewport=r.viewport.split('\n').map(line=>'> '+line).join('\n')}],
 ['fenced display',r=>{r.viewport='```text\n'+r.viewport+'\n```'}],
 ['caption instead of native cropped prefix',r=>{r.viewport='● Approve everything\n'+r.viewport}],
 ['missing dollar marker',r=>{r.viewport=r.viewport.replace('⎿  $','⎿  ')}],
 ['different command prefix',r=>{r.viewport=r.viewport.replace('mkdir -p','mkdir -m 777 -p')}],
 ['truncated command',r=>{r.viewport=r.viewport.replace('&& echo logged','…')}],
 ['extra command suffix',r=>{r.viewport=r.viewport.replace('&& echo logged','&& echo logged; echo other')}],
 ['missing wrapped row',r=>{r.viewport=r.viewport.split('\n').filter((_,i)=>i!==1).join('\n')}],
 ['blank row in command',r=>{r.viewport=r.viewport.replace('\n     +%','\n\n     +%')}],
 ['extra non-command row',r=>{r.viewport=r.viewport.replace('\n     \n','\n     completed successfully\n')}],
 ['second dollar command',r=>{r.viewport=r.viewport.replace('\n     \n','\n  ⎿  $ echo other\n')}],
 ['Bash approval menu',r=>{r.viewport='Bash command permission\nDo you want to run this command?\n'+r.viewport}],
 ['duplicate Edit panel',r=>{r.viewport+=panel(r)}],
 ['foreign Edit target',r=>{r.viewport=r.viewport.replace('gstack-autoplan-chain-ZdZS9F','gstack-autoplan-chain-foreign')}],
 ['altered added diff row',r=>{r.viewport=r.viewport.replace('server clock','attacker clock')}],
 ['persistent permission selected',r=>{r.viewport=r.viewport.replace('❯ 1. Yes','❯ 2. Yes')}],
 ['trailing unrelated prose',r=>{r.viewport+='\nAnother current request'}],
 ['within-row quoted whitespace contradiction',r=>{show(r,"printf '%s' 'two  words'");r.viewport=r.viewport.replace('two  words','two words')}],
 ['within-row unquoted whitespace contradiction',r=>{r.viewport=r.viewport.replace('mkdir -p','mkdir  -p')}],
];
for(const[name,change]of displayCases)test(`caption crop rejects unrelated display: ${name}`,()=>{const r=replay();try{change(r);expect(invoke(r)).toBeNull()}finally{r.dispose()}});

test('only Autoplan selects the public fixture and focused regression',()=>{
 for(const file of ['test/autoplan-cropped-command-av.test.ts','test/fixtures/autoplan-cropped-command-av.json']){
  expect(selectTests([file],E2E_TOUCHFILES,[]).selected).toEqual(['autoplan-chain-pty']);
  expect(selectTests([file],LLM_JUDGE_TOUCHFILES,[]).selected).toEqual([]);
 }
});
