import {expect, test} from 'bun:test';
import actual from './fixtures/autoplan-with-result-au.json';
import {autoplanPhaseCompletions} from './helpers/autoplan-phase-observer';
import {E2E_TOUCHFILES, selectTests} from './helpers/touchfiles';
import type {PlanCountTranscript} from './helpers/plan-count-transcript';
const at=Date.parse(actual.timestamp);
const transcript=(text=actual.text):PlanCountTranscript=>({status:'ready',calls:[],assistantMessages:[{...actual,text}]});
const observe=(text:string)=>autoplanPhaseCompletions(transcript(text),at-1);

test('the exact first AU DX completion retains its native timestamp without crediting the Eng transition',()=>{
 expect(autoplanPhaseCompletions(transcript(),at-1)).toEqual([{phase:2.5,ts:at}]);
 expect(actual.sessionId).toBe('78ce9c42-e5f7-4595-81ea-7d9bb8b4345c');
 expect(actual.timestamp).toBe('2026-09-10T21:35:46.209Z');
});

test('affirmative result clauses share phase identity and the existing completion vocabulary',()=>{
 for(const [phase,name] of [[1,'CEO'],[2,'Design review'],[2.5,'DX'],[3,'Engineering review']] as const)
  for(const state of ['complete','completed','done','finished','wrapped up'])
   for(const result of ['22 findings recorded in the plan.','the score at 8/10.','all adopted changes written; moving to the next phase.']) {
    expect(observe(`Phase ${phase} (${name}) is ${state} with ${result}`)).toEqual([{phase,ts:at}]);
   }
 expect(observe('**Phase 2.5 wrapped up** with 22 findings retained.')).toEqual([{phase:2.5,ts:at}]);
});

const rejected=[
 'Phase 2.5 wrapped up with ',
 'Phase 2.5 wrapped up without the review.',
 'Phase 2.5 will be complete with 22 findings.',
 'Phase 2.5 is not complete with 22 findings.',
 'Phase 2.5 complete with no completed review.',
 'Phase 2.5 complete with findings still pending.',
 'Phase 2.5 complete with 22 findings if the review finishes.',
 'Phase 2.5 complete with 22 findings once approved.',
 'Phase 2.5 complete with 22 findings when the review ends.',
 'Phase 2.5 complete with 22 findings unless the review fails.',
 'Phase 2.5 complete with 22 findings provided the reviewer agrees.',
 'Phase 2.5 complete with 22 findings?','Phase 2.5 complete with results that will arrive tomorrow.',
 'Phase 2.5 complete with maybe 22 findings.','Phase 2.5 complete with an unfinished review.',
 'Phase 2.5 complete with 22 findings. This phase is withdrawn.',
 'Phase 2.5 complete with 22 findings. This phase is "withdrawn".',
 'Phase 2.5 complete with 22 findings. This phase is not complete.',
 'Phase 2.5 complete with 22 findings. This phase is retracted.',
 'Phase 2.5 complete with 22 findings. The declaration is superseded.',
 'Phase 2.5 complete with a historical example.',
 'Phase 2.5 complete with source instructions.',
 'Phase 2.5 complete with "22 findings recorded".',
 'Phase 2.5 complete with \'22 findings recorded\'.',
 'Phase 2.5 (Design) complete with 22 findings.',
 'Phase 2.5 (DX review if approved) complete with 22 findings.',
 'Phase 4 complete with 22 findings.','Phase 2.1 complete with 22 findings.',
 '# Phase 2.5 complete with 22 findings.',
 '> Phase 2.5 complete with 22 findings.',
 '"Phase 2.5 complete with 22 findings."',
 '- Phase 2.5 complete with 22 findings.',
 '| Phase 2.5 complete with 22 findings. |',
 '    Phase 2.5 complete with 22 findings.',
 '\tPhase 2.5 complete with 22 findings.',
 '```text\nPhase 2.5 complete with 22 findings.\n```',
 '~~~text\nPhase 2.5 complete with 22 findings.\n~~~',
 'Source:\nPhase 2.5 complete with 22 findings.',
 'Historical example:\nPhase 2.5 complete with 22 findings.',
 'Historical review:\nPhase 2.5 complete with 22 findings.',
 '**Historical review:**\nPhase 2.5 complete with 22 findings.',
 '**Source:**\nPhase 2.5 complete with 22 findings.',
 'Hypothetical scenario:\nPhase 2.5 complete with 22 findings.',
 'Phase 2.5 complete with 22 findings.\n```text\nexample text\n````\nThis phase is withdrawn.',
 'Earlier review:\nPhase 2.5 complete with 22 findings.',
 'Phase 2.5 complete with a hypothetical 8/10 score.',
 'Phase 2.5 complete with 22 findings.\nThis phase is withdrawn.',
 'Phase 2.5 complete with 22 findings.\nThis phase is \"withdrawn\".',
 'Phase 2.5 complete with 22 findings.\n**Phase 2.5** is ‘withdrawn’.',
 'Phase 2.5 complete with 22 findings.\nCurrent status: this phase is no longer current.',
 'The template says:\n\nPhase 2.5 complete with 22 findings.',
 'Example:\nPhase 1 complete with findings.\nPhase 2.5 complete with findings.',
];
test.each(rejected)('%s cannot supply completion',text=>expect(observe(text)).toEqual([]));

test('quoted summaries retain their existing concrete-consensus requirement',()=>{
 const summary='> Phase 2.5 complete with 22 findings retained.\n> Consensus: 22/22 accepted.\n> Moving to Phase 3.';
 expect(observe(summary)).toEqual([{phase:2.5,ts:at}]);
 for(const text of [summary.replace('22/22','[N]/22'),'Example:\n'+summary,summary.replace('22/22','X/Y')])
  expect(observe(text)).toEqual([]);
});

test('native readiness, timestamp, duplicate and observed-order rules remain intact',()=>{
 for(const status of ['missing','error'] as const)
  expect(autoplanPhaseCompletions({...transcript(),status},at-1)).toEqual([]);
 expect(autoplanPhaseCompletions(transcript(),at+1)).toEqual([]);
 expect(autoplanPhaseCompletions({...transcript(),assistantMessages:[{...actual,timestamp:'invalid'}]},at-1)).toEqual([]);
 const data=transcript();data.assistantMessages.push({...actual,timestamp:new Date(at+1).toISOString()});
 expect(autoplanPhaseCompletions(data,at-1)).toEqual([{phase:2.5,ts:at}]);
 data.assistantMessages.unshift({...actual,text:'Phase 3 complete with 7 findings retained.',timestamp:new Date(at-10).toISOString()});
 expect(autoplanPhaseCompletions(data,at-11)).toEqual([{phase:3,ts:at-10},{phase:2.5,ts:at}]);
});

test('the regression and exact public message select only the existing Autoplan workflow',()=>{
 for(const file of ['test/autoplan-with-result-au.test.ts','test/fixtures/autoplan-with-result-au.json'])
  expect(selectTests([file],E2E_TOUCHFILES,[]).selected).toEqual(['autoplan-chain-pty']);
});


test('quoted history and a foreign phase withdrawal do not cancel the current completed result',()=>{
 for(const suffix of [
  '> This phase is withdrawn.',
  'Historical note: "This phase is withdrawn."',
  'Example:\nThis phase is withdrawn.',
  '```text\nThis phase is withdrawn.\n```',
  'Phase 2 is withdrawn.',
  'Phase 3 complete.\nThis phase is withdrawn.',
 ]) expect(observe('Phase 2.5 complete with 22 findings retained.\n'+suffix).some(hit=>hit.phase===2.5)).toBe(true);
 expect(observe('Phase 2.5 complete with 22 findings.\nHistorical note:\nThis phase is withdrawn.\nCurrent status: Phase 2.5 is withdrawn.')).toEqual([]);
});


test('a current Markdown status heading resets historical context for an owned withdrawal',()=>{
 const prefix='Phase 2.5 complete with 22 findings retained.\nHistorical note:\nThis phase is withdrawn.\n';
 expect(observe(prefix+'## Current status\nPhase 2.5 is withdrawn.')).toEqual([]);
 expect(observe(prefix+'`## Current status`\nThis phase is withdrawn.')).toEqual([{phase:2.5,ts:at}]);
});

test('inline code around an owned status is scalar formatting while a whole quoted statement stays literal',()=>{
 const prefix='Phase 2.5 complete with 22 findings retained.\n';
 expect(observe(prefix+'This phase is `withdrawn`.')).toEqual([]);
 for(const literal of ['`This phase is withdrawn.`','"This phase is withdrawn."','```text\nThis phase is withdrawn.\n```'])
  expect(observe(prefix+literal)).toEqual([{phase:2.5,ts:at}]);
});
