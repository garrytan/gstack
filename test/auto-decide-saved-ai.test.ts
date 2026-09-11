import { expect, test } from 'bun:test';
import { findNativeAutoDecision } from './helpers/native-auto-decide';
import captured from './fixtures/auto-decide-saved-ai.json';
const clone=()=>structuredClone(captured) as any;
const decision=(f=clone())=>findNativeAutoDecision(f.transcript,f.tools,f.options);
const message=(f:any)=>f.transcript.assistantMessages.find((m:any)=>m.text.includes('Auto-decided'));

test('actual saved mode preference annotation is a completed native auto-decision',()=>{
  const f=clone(), result=decision(f);
  expect(result).not.toBeNull();
  expect(result!.option).toBe('HOLD SCOPE');
  expect(message(f).text).toContain(result!.annotation);
  expect(f.transcript.calls).toEqual([]);
});

test('saved preference is bound to this invoked skill and an agreeing current mode',()=>{
  for(const change of [
    (s:string)=>s.replace('`plan-ceo-review-mode`','`plan-design-review-mode`'),
    (s:string)=>s.replace('`plan-ceo-review-mode`','`plan-ceo-review-routing`'),
    (s:string)=>s.replace('**Review mode: HOLD SCOPE.**','**Review mode: SCOPE EXPANSION.**'),
    (s:string)=>s.replace('**Review mode: HOLD SCOPE.**\n\n',''),
    (s:string)=>s.replace('"Select review mode"','"Select report folder"'),
    (s:string)=>s.replace('(your saved preference on','(a proposed preference on'),
    (s:string)=>s.replace('Change with /plan-tune.',''),
    (s:string)=>s.replace('Auto-decided','I will auto-decide'),
  ]) {const f=clone();message(f).text=change(message(f).text);expect(decision(f)).toBeNull();}
});

test('prefixed examples, quotations and hypothetical notices do not assert a current choice',()=>{
  for(const change of [
    (s:string)=>'Example:\n\n'+s,
    (s:string)=>'```text\n'+s+'\n```',
    (s:string)=>s.split('\n').map(l=>'> '+l).join('\n'),
    (s:string)=>s.replace('Heads-up from the preamble: unshipped work on this branch','Heads-up from the preamble: a hypothetical example'),
    (s:string)=>s.replace('Auto-decided "Select','    Auto-decided "Select'),
    (s:string)=>s.replace('Auto-decided "Select','If approved, Auto-decided "Select'),
  ]) {const f=clone();message(f).text=change(message(f).text);expect(decision(f)).toBeNull();}
});

test('failed loads, foreign sessions, actual questions and later withdrawals retain precedence',()=>{
  for(const mutate of [
    (f:any)=>{f.options.sessionId='foreign';},
    (f:any)=>{const use=f.tools.find((t:any)=>t.kind==='use'&&t.name==='Skill');f.tools.find((t:any)=>t.kind==='result'&&t.toolUseId===use.toolUseId).isError=true;},
    (f:any)=>{f.transcript.calls.push({sessionId:f.options.sessionId,toolUseId:'actual-question'});},
    (f:any)=>{f.options.now=Date.parse(message(f).timestamp)-1;},
    (f:any)=>{message(f).text+='\n\nCorrection: I withdraw this decision.';},
    (f:any)=>{message(f).text+='\n\n**Review mode: SCOPE EXPANSION.**';},
  ]) {const f=clone();mutate(f);expect(decision(f)).toBeNull();}
});

import { E2E_TOUCHFILES } from './helpers/touchfiles-data';
test('new evidence inputs retain every native observation caller',()=>{
  const owners=['plan-ceo-review-plan-mode','plan-eng-review-plan-mode','plan-design-review-plan-mode','plan-devex-review-plan-mode','plan-mode-no-op','auto-decide-preserved','conductor-prose'];
  for(const file of ['test/auto-decide-saved-ai.test.ts','test/fixtures/auto-decide-saved-ai.json','test/fixtures/auto-decide-retry-ai.json'])
    expect(Object.entries(E2E_TOUCHFILES).filter(([,paths])=>paths.includes(file)).map(([name])=>name)).toEqual(owners);
});

import retry from './fixtures/auto-decide-retry-ai.json';
test('actual retry mode-decision heading retains its own annotation, excluding prior foreign text',()=>{
  const f:any=structuredClone(retry), actual=decision(f);
  expect(actual).not.toBeNull();expect(actual!.sessionId).toBe(f.options.sessionId);
  expect(actual!.option).toBe('HOLD SCOPE');
  expect(actual!.annotation).toContain('(your preference)');
  const own=f.transcript.assistantMessages.filter((m:any)=>m.sessionId===f.options.sessionId);
  f.transcript.assistantMessages=f.transcript.assistantMessages.filter((m:any)=>m.sessionId!==f.options.sessionId);
  expect(decision(f)).toBeNull();expect(own.length).toBeGreaterThan(0);
});

test('retry heading cannot supply a hypothetical, different decision, or withdrawn selection',()=>{
  for(const change of [
    (s:string)=>'Example:\n\n'+s,
    (s:string)=>s.replace('Review mode for the deterministic','Review mode for the hypothetical'),
    (s:string)=>s.replace('D1 — Review mode','D1 — Report destination'),
    (s:string)=>s.replace('Auto-decided "Review mode:', 'Auto-decided "Report destination:'),
    (s:string)=>s.replace('→ **HOLD SCOPE**','→ **Save a file**'),
    (s:string)=>s+'\n\nCorrection: I withdraw this selection.',
    (s:string)=>s+'\n\n**Review mode: SCOPE EXPANSION.**',
    (s:string)=>s.replace('Heads-up from gstack: there is unshipped work on this branch','Heads-up from gstack: here is an example'),
  ]) {const f:any=structuredClone(retry),m=f.transcript.assistantMessages.find((m:any)=>m.sessionId===f.options.sessionId&&m.text.includes('Auto-decided'));m.text=change(m.text);expect(decision(f)).toBeNull();}
});
