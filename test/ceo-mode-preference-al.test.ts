import {afterAll, beforeAll, expect, test} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {getQuestion} from '../scripts/question-registry';
import {E2E_TOUCHFILES} from './helpers/touchfiles-data';
import {CARVE_GUARDS} from './helpers/carve-guards';
const root=path.resolve(import.meta.dir,'..');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'gstack-ceo-mode-preference-'));
function section(s:string){
 const match=s.match(/^### 0[A-Z]\. Mode Selection\n([\s\S]*?)(?=^### |$(?![\s\S]))/m);
 if(!match)throw new Error('CEO Mode Selection section missing');
 return match[1]!;
}
const rendered=new Map<string,string>();
const env=(state:string)=>({...process.env,GSTACK_HOME:state,GSTACK_STATE_ROOT:state});
beforeAll(()=>{
 for(const host of ['claude','codex']){
  const out=path.join(temp,host),state=path.join(temp,'render-state');
  const result=spawnSync(process.execPath,['run','scripts/gen-skill-docs.ts','--host',host,'--out-dir',out],{cwd:root,env:env(state),encoding:'utf8',timeout:120_000});
  if(result.status!==0)throw new Error(result.stderr||result.stdout);
  rendered.set(host,fs.readFileSync(path.join(out,host==='claude'?'plan-ceo-review':'.agents/skills/gstack-plan-ceo-review','SKILL.md'),'utf8'));
 }
},120_000);
afterAll(()=>fs.rmSync(temp,{recursive:true,force:true}));
function modeId(document:string){
 const ids=[...section(document).matchAll(/`question_id=([^`]+)`/g)].map(m=>m[1]!);
 expect(ids).toHaveLength(1);return ids[0]!;
}
function tuning(document:string){
 return document.split('## Question Tuning (skip entirely if')[1]!.split('\n## ')[0]!;
}
function renderedCheck(host:string,id:string){
 const match=tuning(rendered.get(host)!).match(/`(printf '%s' "<question summary>" \| ([^`]+)\/gstack-question-preference --check "<id>" --summary-stdin)`/)!;
 expect(match).not.toBeNull();
 expect(match[2]).toBe(host==='claude'?'~/.claude/skills/gstack/bin':'$GSTACK_BIN');
 const quote=(value:string)=>"'"+value.replace(/'/g,"'\\''")+"'";
 // Run the rendered command, substituting its documented fields and mapping
 // the host's installed executable location to this isolated checkout.
 return match[1]!.replace('<question summary>','Select the CEO review mode for the current plan.')
  .replace('"<id>"',quote(id))
  .replace(match[2]!+'/gstack-question-preference',quote(path.join(root,'bin/gstack-question-preference')));
}
function checkWithPreference(host:string,preference?:string,writeId?:string){
 const id=modeId(rendered.get(host)!),state=fs.mkdtempSync(path.join(temp,'state-'));
 const run=(args:string[],input?:string)=>spawnSync(path.join(root,'bin/gstack-question-preference'),args,{cwd:root,env:env(state),input,encoding:'utf8',timeout:30_000});
 if(preference){const written=run(['--write',JSON.stringify({question_id:writeId??id,preference,source:'plan-tune'})]);expect(written.status).toBe(0);}
 const result=spawnSync('bash',['-c',renderedCheck(host,id)],{cwd:root,env:env(state),encoding:'utf8',timeout:30_000});
 expect(result.status).toBe(0);return {id,result,run};
}
test('source and both isolated host renders bind the shared check, marker and log to the registered mode identity',()=>{
 const source=fs.readFileSync(path.join(root,'plan-ceo-review/SKILL.md.tmpl'),'utf8');
 for(const document of [source,...rendered.values()]){
  const id=modeId(document),s=section(document);
  expect(getQuestion(id)).toMatchObject({id:'plan-ceo-review-mode',skill:'plan-ceo-review',category:'routing',door_type:'two-way'});
  expect(s).toContain('check `question_id=plan-ceo-review-mode` through the preamble');
  const automatic=s.split('Select the recommendation automatically')[1]!.split('\n')[0]!;
  expect(automatic).toContain('only if that check exits 0 with `AUTO_DECIDE`');
  expect(automatic).toContain('use the automatic handoff in step 4');
  const handoff=s.split('**Mode handoff:**')[1]!;
  expect(handoff).toContain('`'+id+': AUTO_DECIDE`');
  expect(handoff).toContain('Auto-decided review mode → <selected mode> (your preference)');
  const asked=s.split('Without that successful check,')[1]!.split('\n')[0]!;
  expect(asked).toContain('offer all four modes in one AskUserQuestion');
  expect(asked).toContain('**STOP for the answer**');
  expect(asked).toContain('When `QUESTION_TUNING: true`');
  expect(asked).toContain('`<gstack-qid:'+id+'>`');
  const logging=handoff.split('Record mode provenance after the handoff')[1]!.split('If 0D')[0]!.replace(/\s+/g,' ');
  expect(logging).toContain('no question log because none was asked');
  expect(logging).toContain('`'+id+'`, `auto_decided: true`');
  expect(logging).toContain('`auto_decided: false`, including the question ID only when `QUESTION_TUNING: true`');
  expect(s.indexOf('4. **Mode handoff:**')).toBeGreaterThan(s.indexOf('3. Resolve that recommendation:'));
  expect(handoff).toContain('After selection');
  expect(handoff).toContain('send brief chat before tools or further questions');
  expect(s.slice(0,s.indexOf('4. **Mode handoff:**'))).not.toMatch(/\blog (?:with|that ID)\b/);
  expect(handoff.indexOf('Record mode provenance after the handoff')).toBeGreaterThan(handoff.indexOf('- Other selections:'));
  expect(handoff.indexOf("Follow the selected mode's route:")).toBeGreaterThan(handoff.indexOf('Record mode provenance after the handoff'));
  expect(s).not.toContain('plan-ceo-review-mode-selection');
 }
 for(const document of rendered.values()){
  expect(tuning(document)).toContain('<gstack-qid:{question_id}>');
  expect(tuning(document)).toContain('"question_id":"<id>"');
 }
});
test('both rendered canonical checks actually honor a stored never-ask preference',()=>{
 for(const host of rendered.keys()){
  const {result,run}=checkWithPreference(host,'never-ask');
  expect(result.stdout.trim()).toBe('AUTO_DECIDE');
  const wrong=run(['--check','plan-ceo-review-mode-selection','--summary-stdin'],'Select the CEO review mode.');
  expect(wrong.status).toBe(0);expect(wrong.stdout.trim()).toBe('ASK_NORMALLY');
 }
});
test('absent, always-ask and foreign preferences do not authorize either host to select a mode',()=>{
 for(const host of rendered.keys()){
  for(const [preference,id] of [[undefined,undefined],['always-ask',undefined],['never-ask','plan-design-review-mode']] as const){
   expect(checkWithPreference(host,preference,id).result.stdout.trim()).toBe('ASK_NORMALLY');
  }
 }
});
test('only an explicit user selection or enabled successful mode check bypasses asking',()=>{
 for(const document of rendered.values()){
  const s=section(document),q=tuning(document);
  expect(s).toContain('An explicit choice skips steps 2–3');
  expect(s).toContain('When `QUESTION_TUNING: false`, skip the lookup and ask below');
  expect(s).toContain('Otherwise check `question_id=plan-ceo-review-mode` through the preamble');
  expect(s).toContain('Select the recommendation automatically only if that check exits 0 with `AUTO_DECIDE`');
  expect(s).toContain('**STOP for the answer**');
  expect(document).toContain('Question Tuning (skip entirely if `QUESTION_TUNING: false`)');
  expect(q).toContain('`AUTO_DECIDE` means choose the recommended option');
  expect(q).toContain('Auto-decided [summary] → [option] (your preference). Change with /plan-tune.');
  expect(q).toContain('`ASK_NORMALLY` means ask.');
  expect(s).toContain('Selecting a mode does not approve changes');
  expect(document).toContain('Initial pass after 0C: proceed to 0E once required choices are settled');
  expect(s.replace(/\s+/g,' ')).toContain('Preserve 0D approvals and ask about each proposed addition or cut');
  expect(s).toContain('offer all four modes in one AskUserQuestion');
  expect(s).toContain("using step 2's recommendation");
  expect(s).toContain('For >15 planned changed files, recommend SCOPE REDUCTION');
  expect(document).toContain('more than 8 files or more than 2 new classes/services');
  expect(s.replace(/\s+/g,' ')).toContain('ask about each proposed addition or cut, including those prompted by file-count thresholds');
  expect(s).toContain('Count distinct planned file additions, edits and deletions, labeling estimates');
  expect(s).toContain('These modes differ in kind, not coverage; do NOT score completeness');
  expect(document).toContain('Note: options differ in kind, not coverage — no completeness score.');
 }
});
test('the new render/runtime regression belongs to the existing auto-decide owner',()=>{
 expect(Object.entries(E2E_TOUCHFILES).filter(([,v])=>v.includes('test/ceo-mode-preference-al.test.ts')).map(([k])=>k)).toEqual(['auto-decide-preserved']);
});
test('rendered mode contract stays within the existing canonical skeleton cap',()=>{
 // --out-dir changes section-link roots only. Undo that output-location
 // substitution before measuring the same canonical bytes as parity-suite.
 const out=path.join(temp,'claude').replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 const canonical=rendered.get('claude')!.replace(new RegExp(out+'/([^\\s)`"\'*]+/sections/)','g'),(_m,p1)=>'~/.claude/skills/gstack/'+p1);
 const cap=Object.values(CARVE_GUARDS).find(g=>g.skill==='plan-ceo-review')!.maxSkeletonBytes;
 expect(Buffer.byteLength(canonical)).toBeLessThanOrEqual(cap);
});
