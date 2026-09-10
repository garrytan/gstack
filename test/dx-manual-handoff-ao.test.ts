import {describe,expect,test} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {hasNativePlanTerminal, classifyPlanCountFrame} from './helpers/claude-pty-runner';
import type {NativePlanQuestionCall,PlanCountTranscript} from './helpers/plan-count-transcript';
import captured from './fixtures/dx-manual-handoff-ao.json';
import {E2E_TOUCHFILES,LLM_JUDGE_TOUCHFILES,GLOBAL_TOUCHFILES} from './helpers/touchfiles-data';

type Edit=(calls:NativePlanQuestionCall[], transcript:PlanCountTranscript, report:string)=>void;
function replay(edit?:Edit){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dx-manual-handoff-ao-'));
 try {
  const report=path.join(dir,'report.md');fs.writeFileSync(report,captured.reportContent);
  const written=captured.provenance.reportMtimeMs/1000;fs.utimesSync(report,written,written);
  const transcript={status:'ready',calls:structuredClone(captured.calls),assistantMessages:[],planReadyRequests:structuredClone(captured.planReadyRequests)} as PlanCountTranscript;
  edit?.(transcript.calls,transcript,report);
  return hasNativePlanTerminal(transcript,report,captured.provenance.startedAt,'plan_ready');
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
}
function change(call:NativePlanQuestionCall,from:string,to:string){
 const q=call.questions[0]!;expect(q.question).toContain(from);
 const selected=call.answers![q.question];q.question=q.question.replace(from,to);call.answers={[q.question]:selected!};
}
describe('AO completed manual DX handoff preserves report freshness',()=>{
 test('shared completion callers register the regression with dense literal paths',()=>{
  for(const owner of ['plan-ceo-finding-count','plan-design-finding-count','plan-eng-finding-count','plan-devex-finding-count']){
   expect(E2E_TOUCHFILES[owner]).toContain('test/dx-manual-handoff-ao.test.ts');
   expect(E2E_TOUCHFILES[owner]).toContain('test/fixtures/dx-manual-handoff-ao.json');
  }
  const arrays=[...Object.values(E2E_TOUCHFILES),...Object.values(LLM_JUDGE_TOUCHFILES),GLOBAL_TOUCHFILES];
  expect(arrays).toHaveLength(210);
  for(const values of arrays)for(let i=0;i<values.length;i++)expect(typeof values[i]).toBe('string');
 });
 test('exact owned report precedes navigation only, with the current Exit gate recognized',()=>{
  expect(captured.calls).toHaveLength(2);expect(captured.events).toHaveLength(4);
  expect(Date.parse(captured.calls[0]!.answeredAt!)).toBeLessThan(captured.provenance.reportMtimeMs);
  expect(Date.parse(captured.calls[1]!.answeredAt!)).toBeGreaterThan(captured.provenance.reportMtimeMs);
  expect(classifyPlanCountFrame(captured.screen)).toBe('plan_ready');
  expect(replay()).toBe(true);
 });
 test('equivalent completed recap and manual roles retain current authority',()=>{
  for(const [from,to] of [
   [' (5/10 -> 8.5/10)',''],
   ['5/10 -> 8.5/10','6/10 → 9/10'],
   ['What should happen next?',"What's next?"],
   ['The DX review found','The DX review identified'],
   ['All are written into the plan as tasks T1 to T9.','All DX decisions and tasks are recorded in the plan.'],
  ])expect(replay(calls=>change(calls[1]!,from!,to!)),to).toBe(true);
  expect(replay(calls=>calls[1]!.questions[0]!.options.reverse())).toBe(true);
  expect(replay(calls=>{const c=calls[1]!;change(c,'Net: hand off now as you asked, or chain the eng review here.','Net: hand off now as you asked, or chain the eng review here.\n> Historical example: add a new task before leaving.');})).toBe(true);
  expect(replay(calls=>{const o=calls[1]!.questions[0]!.options[0]!;o.description=o.description!.replace('Plan exits now with all DX decisions and tasks recorded; nothing else is started.','Exit the plan now with all DX tasks and decisions recorded. No further review is started.');})).toBe(true);
 });
 test('source, conditional or withdrawn completion facts cannot make a stale report current',()=>{
  const edits:Array<[string,string]>=[
   ['D13 — DX review','Source: D13 — DX review'],
   ['DX review complete','DX review is not complete'],
   ['DX review complete','DX review complete only after another decision'],
   ['ELI10: The DX review found','ELI10: Earlier review assessment: The DX review found'],
   ['ELI10: The DX review found','ELI10: If approved, the DX review found'],
   ['All are written into the plan as tasks T1 to T9.','Example: All are written into the plan as tasks T1 to T9.'],
   ['All are written into the plan as tasks T1 to T9.','Previously, all are written into the plan as tasks T1 to T9.'],
   ['All are written into the plan as tasks T1 to T9.','"All are written into the plan as tasks T1 to T9."'],
   ['All are written into the plan as tasks T1 to T9.','All will be written into the plan as tasks T1 to T9.'],
   ['Project/branch/task:','Source:\nProject/branch/task:'],
   ['Project/branch/task: ','Project/branch/task: If approved, '],
   ['Project/branch/task: ','Project/branch/task: Source excerpt, not a current assessment: '],
  ];
  for(const [from,to] of edits)expect(replay(calls=>change(calls[1]!,from,to)),to).toBe(false);
  for(const suffix of [' This review is not complete.',' These tasks are not recorded.',' This review is "withdrawn".',' One DX decision remains unresolved.',' We must fix another issue.',' Add another migration task.',' Should we approve another change?',' <gstack-qid:foreign>']) {
   expect(replay(calls=>{const c=calls[1]!;change(c,c.questions[0]!.question,c.questions[0]!.question+suffix);}),suffix).toBe(false);
  }
 });
 test('selected manual action must close with recorded decisions and no new work',()=>{
  for(const prefix of ['Source: ','Earlier review assessment: ','If approved, ','> '])expect(replay(calls=>{const o=calls[1]!.questions[0]!.options[0]!;o.description=prefix+o.description;}),prefix).toBe(false);
  for(const suffix of [' Also update the plan before exit.',' Run /plan-eng-review now.',' This plan is not complete.',' The tasks are "withdrawn".',' This manual handoff is cancelled.'])expect(replay(calls=>{calls[1]!.questions[0]!.options[0]!.description+=suffix;}),suffix).toBe(false);
  for(const from of ['all DX decisions and tasks recorded','nothing else is started'])expect(replay(calls=>{const o=calls[1]!.questions[0]!.options[0]!;o.description=o.description!.replace(from,'more work remains');}),from).toBe(false);
  for(const index of [1,2])expect(replay(calls=>{const c=calls[1]!,q=c.questions[0]!;c.answers={[q.question]:q.options[index]!.label};})).toBe(false);
 });
 test('completed owned native answer identity remains mandatory',()=>{
  const mutations:Array<(c:NativePlanQuestionCall)=>void>=[
   c=>{c.answered=false;},c=>{c.failed=true;},c=>{c.sessionId='foreign';},c=>{c.toolUseId='';},
   c=>{c.answeredAt='invalid';},c=>{c.answeredAt=new Date(Date.now()+60_000).toISOString();},
   c=>{c.unansweredQuestionIndices=[0];},c=>{delete c.unansweredQuestionIndices;},
   c=>{c.questions[0]!.multiSelect=true;},c=>{c.questions[0]!.header='Issue decision';},
   c=>{c.questions.push(structuredClone(c.questions[0]!));},
   c=>{c.answers={wrong:c.questions[0]!.options[0]!.label};},
   c=>{c.answers![c.questions[0]!.question]='Not an offered answer';},
   c=>{c.answers!.extra='foreign';},
   c=>{c.questions[0]!.options[1]!.label=c.questions[0]!.options[0]!.label;},
  ];
  for(const edit of mutations)expect(replay(calls=>edit(calls[1]!)),edit.toString()).toBe(false);
 });
 test('other modifying answers and complete report/current Exit gates remain unchanged',()=>{
  expect(replay(calls=>{calls[0]!.answeredAt=new Date(captured.provenance.reportMtimeMs+1).toISOString();})).toBe(false);
  expect(replay((_calls,_t,report)=>{const time=Date.parse(captured.calls[0]!.answeredAt!)/1000-1;fs.utimesSync(report,time,time);})).toBe(false);
  expect(replay((_calls,_t,report)=>fs.writeFileSync(report,'# Completion summary\nDone.'))).toBe(false);
  expect(replay((_calls,_t,report)=>fs.unlinkSync(report))).toBe(false);
  for(const mutate of [
   (t:PlanCountTranscript)=>{t.planReadyRequests=[];},
   (t:PlanCountTranscript)=>{t.planReadyRequests![0]!.failed=true;},
   (t:PlanCountTranscript)=>{t.planReadyRequests![0]!.sessionId='foreign';},
   (t:PlanCountTranscript)=>{t.planReadyRequests![0]!.timestamp=captured.calls[1]!.answeredAt!;},
   (t:PlanCountTranscript)=>{t.status='missing';},
  ])expect(replay((_calls,t)=>mutate(t))).toBe(false);
 });
});
