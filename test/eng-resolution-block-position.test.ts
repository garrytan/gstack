import {expect,test} from 'bun:test';
import batching from './fixtures/eng-batching-saved-ledger-b176.json';
import completion from './fixtures/eng-count-c6fc-public.json';
import native from './fixtures/eng-native-packets-b955.json';
import {createEngBatchingIssueCounter,evaluateEngSeedCoverage} from './helpers/eng-seeded-coverage';
import {isEngCompletionHandoff} from './helpers/eng-completion-handoff';
import {engSetupAUQ,nativePlanCallFingerprint} from './helpers/claude-pty-runner';
import type {NativePlanQuestionCall,PlanCountTranscript} from './helpers/plan-count-transcript';

// Change placement only. Indented History states remain historical, and invalid
// duplicate current states are preserved rather than silently reconciled.
function resolutionBlock(plan:string):string {
  return plan.split(/\n(?=### R[1-9]\d*:)/).map(record=>{
    const states=record.match(/^State:.*\n/gm)??[];
    if(!states.length)return record;
    expect(record).toMatch(/^Actual answer:/m);
    return record.replace(/^State:.*\n/gm,'').replace(/^Actual answer:/m,states.join('')+'Actual answer:');
  }).join('\n');
}
const calls=completion.transcript.calls as NativePlanQuestionCall[];
const handoff=(plan:string)=>isEngCompletionHandoff(nativePlanCallFingerprint(calls.at(-1)!,1,false),plan,calls.slice(0,-1));
// The same explicit synthetic reconciliation used by the existing completion
// controls. It never changes the historical paid cancellation's verdict.
const approved=completion.report.split(/\n(?=### R[1-9]\d*:)/).map(record=>record.includes('\nState: pending\n')
  ?record.replace('\nState: pending\n','\n').replace('History: none','History: superseded pre-answer state\n  State: pending'):record).join('\n');

test('completed owned ledger permits State immediately before its actual answer',()=>{
  expect(handoff(approved)).toBe(true);
  expect(handoff(resolutionBlock(approved))).toBe(true);
  expect(completion.actualOutcome).toBe('CANCELLED');
});
test('relocating State cannot approve pending, missing, duplicate or conflicting records',()=>{
  for(const bad of [completion.report,
    approved.replace('State: approved','State: pending'),
    approved.replace('State: approved\n',''),
    approved.replace('State: approved','State: approved\nState: approved'),
    approved.replace('State: approved','State: approved\nState: pending'),
    approved.replace('State: approved','State: rejected'),
  ]) {expect(handoff(bad)).toBe(false);expect(handoff(resolutionBlock(bad))).toBe(false);}
});
test('native seed coverage preserves the complete captured report result after relocation',()=>{
  const h=native.held6bd,t=h.transcript as PlanCountTranscript;
  const check=(plan:string)=>evaluateEngSeedCoverage(t,plan,h.startedAt,h.finishedAt);
  const original=check(h.plan);expect(original.ok).toBe(true);
  expect(check(resolutionBlock(h.plan))).toEqual(original);
});
test('saved native Header and Options remain scoped before the resolution fields',()=>{
  for(const index of [3,4,5,6,7,8,9]) {
    const f=batching.frames[index]!;
    const check=(plan:string)=>createEngBatchingIssueCounter(()=>plan,engSetupAUQ).isReviewAUQ(f.fingerprint,[]);
    expect(check(f.preAskPlan)).toBe(true);
    expect(check(resolutionBlock(f.preAskPlan))).toBe(true);
    for(const state of ['', 'State: pending\nState: pending\n', 'State: pending\nState: approved\n']) {
      const question=f.fingerprint.nativeCall.questions[0]!.question.split('\n')[0]!;
      const at=f.preAskPlan.indexOf(question),start=f.preAskPlan.lastIndexOf('\n### ',at),next=f.preAskPlan.indexOf('\n### ',at);
      expect(at).toBeGreaterThan(0);expect(start).toBeGreaterThanOrEqual(0);
      const end=next<0?f.preAskPlan.length:next,record=f.preAskPlan.slice(start,end);
      expect(record).toContain('State: pending\n');
      const bad=f.preAskPlan.slice(0,start)+record.replace(/^State: pending\n/m,state)+f.preAskPlan.slice(end);
      expect(check(bad)).toBe(false);expect(check(resolutionBlock(bad))).toBe(false);
    }
  }
});
