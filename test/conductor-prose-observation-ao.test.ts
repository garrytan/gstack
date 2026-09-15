import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import * as predicates from './helpers/claude-pty-runner';
import { E2E_TOUCHFILES } from './helpers/touchfiles-data';
import fixture from './fixtures/conductor-prose-ao.json';

const partial=fixture.publicDecisionTail;
// This next frame is synthetic; the retained live attempt ended during A.
const complete=partial+'\nB) Keep all four components and define cache invalidation before implementation.\nReply with A or B.';
async function observe(frames:string[],verdict:'waiting'|'working',required?:boolean){
  const source=fs.readFileSync(path.join(import.meta.dir,'helpers/claude-pty-runner.ts'),'utf8');
  const start=source.indexOf('export async function runPlanSkillObservation('),end=source.indexOf('\n// ─',start);
  expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);
  const js=new Bun.Transpiler({loader:'ts'}).transformSync(source.slice(start,end).replace('export async function','async function')+'\nreturn runPlanSkillObservation;');
  let clock=0,tick=-1,closed=0,judged=0;
  const current=()=>frames[Math.min(Math.max(tick,0),frames.length-1)]!;
  const args:Record<string,unknown>={path,process:{cwd:()=>'/synthetic-owned'},Date:{now:()=>clock},randomUUID:()=> 'owned',
    Bun:{sleep:async(ms:number)=>{if(ms===2000){tick++;clock+=61000;}else clock+=ms;}},
    launchClaudePty:async()=>({send:()=>{},mark:()=>0,exited:()=>false,visibleSince:current,rawOutput:current,currentScreen:async()=>current(),hermeticConfigDir:null,close:async()=>{closed++;}}),
    createPlanCountSnapshotWriter:()=>()=>({}),logPtySnapshot:()=>{},
    isProseAUQVisible:predicates.isProseAUQVisible,isPlanReadyVisible:predicates.isPlanReadyVisible,
    isScopeGateQuestionVisible:predicates.isScopeGateQuestionVisible,isScopeGateAutoSelectVisible:predicates.isScopeGateAutoSelectVisible,
    classifyVisible:predicates.classifyVisible,extractPlanFilePath:predicates.extractPlanFilePath,findNativeAutoDecision:()=>null,
    judgePtyState:()=>{judged++;return {state:verdict,reasoning:'synthetic fixed verdict'};},
  };
  const run=new Function(...Object.keys(args),js)(...Object.values(args));
  const obs=await run({skillName:'plan-eng-review',initialPlanContent:'# Plan: Required draft',timeoutMs:300000,...(required===undefined?{}:{requireProseEvidence:required})});
  expect(closed).toBe(1);
  return {obs,polls:tick+1,judged};
}

test('a judge waiting on the exact partial Conductor brief cannot stop a prose-required observation',async()=>{
  expect(fixture.actualFlags.proseAUQEverObserved).toBe(false);expect(fixture.actualFlags.waitingEverObserved).toBe(true);
  expect(predicates.isProseAUQVisible(partial)).toBe(false);expect(predicates.isProseAUQVisible(complete)).toBe(true);
  const {obs,polls,judged}=await observe([partial,complete],'waiting',true);
  expect(polls).toBe(2);expect(judged).toBe(1);expect(obs.outcome).toBe('asked');
  expect(obs.proseAUQEverObserved).toBe(true);expect(obs.waitingEverObserved).toBe(true);
});
test('partial-only judge waiting reaches the existing budget without gaining prose fallback credit',async()=>{
  const {obs,polls,judged}=await observe([partial],'waiting',true);
  expect(polls).toBe(5);expect(judged).toBe(5);expect(obs.outcome).toBe('timeout');
  expect(obs.proseAUQEverObserved).toBe(false);expect(obs.waitingEverObserved).toBe(true);
});
test('the prose requirement does not alter completed questions or deterministic failure precedence',async()=>{
  const done=await observe([complete],'waiting',true);
  expect(done.obs.outcome).toBe('asked');expect(done.obs.proseAUQEverObserved).toBe(true);expect(done.judged).toBe(0);
  const wrote=await observe(['⏺ Write(/tmp/foreign-output.md)'],'waiting',true);
  expect(wrote.obs.outcome).toBe('silent_write');expect(wrote.obs.proseAUQEverObserved).toBe(false);expect(wrote.judged).toBe(0);
});
test('other callers retain the original judge waiting behavior',async()=>{
  for(const required of [undefined,false]){
    const {obs,polls}=await observe([partial,complete],'waiting',required);
    expect(polls).toBe(1);expect(obs.outcome).toBe('asked');expect(obs.proseAUQEverObserved).toBe(false);expect(obs.waitingEverObserved).toBe(true);
  }
  const working=await observe([partial],'working',true);
  expect(working.obs.outcome).toBe('timeout');expect(working.obs.waitingEverObserved).toBe(false);
});
test('the actual Conductor caller requests prose evidence and retains its independent assertion',()=>{
  const caller=fs.readFileSync(path.join(import.meta.dir,'skill-e2e-conductor-prose.test.ts'),'utf8');
  expect(caller).toContain('requireProseEvidence: true');
  expect(caller).toContain('expect(obs.proseAUQEverObserved).toBe(true)');
  for(const p of ['test/conductor-prose-observation-ao.test.ts','test/fixtures/conductor-prose-ao.json'])expect(Object.entries(E2E_TOUCHFILES).filter(([,paths])=>paths.includes(p)).map(([owner])=>owner)).toEqual(['conductor-prose']);
});
