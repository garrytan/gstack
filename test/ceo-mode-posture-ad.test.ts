import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hasNativePostAnswerCeoPosture, nativeCeoModeAnswer } from './helpers/ceo-mode-option';
import { readPlanCountTranscript, type NativePublicToolEvent } from './helpers/plan-count-transcript';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';
import captured from './fixtures/ceo-mode-posture-ad.json';

const patterns = {
  'HOLD SCOPE': /\b(rigor|bulletproof|hold\s*scope|maximum\s+rigor)\b/i,
  'SCOPE EXPANSION': /\b(expansion|10x|delight|dream|cathedral|opt[\s-]?in)\b/i,
};
function replay(index: number, change?: (rows: any[]) => void) {
  const item = captured.cases[index]!;
  const rows = structuredClone(item.records);
  change?.(rows);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-posture-ad-'));
  const project = path.join(dir, 'projects', 'owned');
  fs.mkdirSync(project, {recursive:true});
  fs.writeFileSync(path.join(project, item.process.sessionId+'.jsonl'), rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
  const events: NativePublicToolEvent[]=[];
  try { return {item, transcript:readPlanCountTranscript(dir,item.process.cwd,event=>events.push(event)),events}; }
  finally { fs.rmSync(dir,{recursive:true,force:true}); }
}
function matches(e: ReturnType<typeof replay>) {
  const mode=e.item.mode as keyof typeof patterns;
  return hasNativePostAnswerCeoPosture(e.transcript,mode,patterns[mode],e.item.selectedAt,e.events);
}
function rebind(e: ReturnType<typeof replay>) {
  const decision=e.transcript.calls[1]!;
  e.events[2]!.input={questions:decision.questions};
  decision.answers={[decision.questions[0]!.question]:decision.questions[0]!.options[0]!.label};
}

for (const index of [0,1]) describe(`${captured.cases[index]!.mode} actual completed mode application`,()=>{
  test('the exact mode answer and concrete scope decision supply posture without finalized prose',()=>{
    const e=replay(index);
    expect(e.item.actualFailure.state).toBe('failed');
    expect(e.transcript.calls.map(call=>call.toolUseId)).toEqual([e.item.modeToolUseId,e.item.decisionToolUseId]);
    expect(nativeCeoModeAnswer(e.transcript,e.item.mode as keyof typeof patterns,e.item.selectedAt)?.toolUseId).toBe(e.item.modeToolUseId);
    expect(e.transcript.assistantMessages.every(message=>Date.parse(message.timestamp)<e.item.selectedAt)).toBe(true);
    expect(matches(e)).toBe(true);
    expect(hasNativePostAnswerCeoPosture(e.transcript,e.item.mode as keyof typeof patterns,patterns[e.item.mode as keyof typeof patterns],e.item.selectedAt)).toBe(false);
  });
  test.each(['wrong selected mode','pending mode','failed mode','answer before selection','pending decision','failed decision',
    'foreign session','pre-mode request','reply before request','reply before selection','reply timestamp mismatch','wrong tool','missing request','missing reply','failed public reply','duplicate request','duplicate reply',
    'request mismatch','unknown answer','extra question','extra option','multiselect','quoted decision','fenced decision',
    'mere mode mention','extra obligation','extra imperative','option imperative'])('%s cannot supply posture',failure=>{
    const e=replay(index);const [mode,decision]=e.transcript.calls;const q=decision!.questions[0]!;
    switch(failure){
      case 'wrong selected mode':mode!.answers![mode!.questions[0]!.question]=index===0?'SCOPE EXPANSION':'HOLD SCOPE';break;
      case 'pending mode':mode!.answered=false;break;
      case 'failed mode':mode!.failed=true;break;
      case 'answer before selection':mode!.answeredAt=new Date(e.item.selectedAt-1).toISOString();break;
      case 'pending decision':decision!.answered=false;break;
      case 'failed decision':decision!.failed=true;break;
      case 'foreign session':decision!.sessionId=e.events[2]!.sessionId=e.events[3]!.sessionId='foreign';break;
      case 'pre-mode request':e.events[2]!.timestamp=e.events[0]!.timestamp;break;
      case 'reply before request':decision!.answeredAt=e.events[3]!.timestamp=new Date(Date.parse(e.events[2]!.timestamp)-1).toISOString();break;
      case 'reply before selection':decision!.answeredAt=e.events[3]!.timestamp=new Date(e.item.selectedAt-1).toISOString();break;
      case 'reply timestamp mismatch':e.events[3]!.timestamp=new Date(Date.parse(decision!.answeredAt!)+1).toISOString();break;
      case 'wrong tool':e.events[2]!.name='Read';break;
      case 'missing request':e.events.splice(2,1);break;
      case 'missing reply':e.events.splice(3,1);break;
      case 'failed public reply':e.events[3]!.isError=true;break;
      case 'duplicate request':e.events.push({...e.events[2]!});break;
      case 'duplicate reply':e.events.push({...e.events[3]!});break;
      case 'request mismatch':e.events[2]!.input={questions:[]};break;
      case 'unknown answer':decision!.answers![q.question]='Unrecognized';break;
      case 'extra question':decision!.questions.push({...structuredClone(q),header:'Also',question:'Also remove the CI gate?'});rebind(e);break;
      case 'extra option':q.options.push({label:'Remove the CI gate',description:'A separate obligation.'});rebind(e);break;
      case 'multiselect':q.multiSelect=true;rebind(e);break;
      case 'quoted decision':q.question=q.question.split('\n').map(line=>'> '+line).join('\n');rebind(e);break;
      case 'fenced decision':q.question='```text\n'+q.question+'\n```';rebind(e);break;
      case 'mere mode mention':q.question=`D6 — Continue the review?\nSelected ${e.item.mode}.`;rebind(e);break;
      case 'extra obligation':q.question+=' Also, should we remove the CI gate?';rebind(e);break;
      case 'extra imperative':q.question+=' Also remove the CI gate.';rebind(e);break;
      case 'option imperative':q.options[0]!.description+=' Please remove the CI gate.';rebind(e);break;
    }
    expect(matches(e),failure).toBe(false);
  });
  test.each(['Delete the CI gate.', 'Ship the new endpoint now.', 'After that, disable authentication.'])('an instruction appended after the final comparison is not part of the scope brief: %s', extra=>{
    const e=replay(index);const q=e.transcript.calls[1]!.questions[0]!;
    q.question+=' '+extra;rebind(e);expect(matches(e)).toBe(false);
  });
  test('foreign, sidechain, missing and failed native records do not become completed evidence',()=>{
    for(const change of [(rows:any[])=>{rows[3].cwd='/foreign';},(rows:any[])=>{rows[3].isSidechain=true;},
      (rows:any[])=>{rows.pop();},(rows:any[])=>{rows[4].message.content[0].is_error=true;}]) expect(matches(replay(index,change))).toBe(false);
  });
});

test('HOLD requires the explicit out-of-scope deferral and its selected defer answer',()=>{
  for(const change of [(q:any)=>{q.question=q.question.replace('Under HOLD SCOPE, keep or defer','Under HOLD SCOPE, automatically add');},
    (q:any)=>{q.question=q.question.replace('not in the plan text','required by the plan text');},
    (q:any)=>{q.question=q.question.replace('pure additions, not repairs to meet a stated invariant','repairs needed to meet a stated invariant');},
    (q:any)=>{q.options[0].label='Keep all three (recommended)';},
    (q:any)=>{q.options[1].label='Remove CI gate';}]){
    const e=replay(0);change(e.transcript.calls[1]!.questions[0]);rebind(e);expect(matches(e)).toBe(false);
  }
  const e=replay(0);const q=e.transcript.calls[1]!.questions[0]!;
  e.transcript.calls[1]!.answers={[q.question]:q.options[1]!.label};expect(matches(e)).toBe(false);
});

test('completed expansion decisions require application of the selected mode',()=>{
  for(const change of [(q:any)=>{q.question='D6 — Continue the review?\nSelected SCOPE EXPANSION.';},
    (q:any)=>{q.question=q.question.replace('SCOPE EXPANSION mode','SELECTIVE EXPANSION mode');},
    (q:any)=>{q.question=q.question.replace('SCOPE EXPANSION mode','HOLD SCOPE mode');},
    (q:any)=>{q.options[1].label='Enable telemetry';}]){
    const e=replay(1);change(e.transcript.calls[1]!.questions[0]);rebind(e);expect(matches(e)).toBe(false);
  }
});

test('the new replay controls and fixture select the actual periodic mode-routing caller',()=>{
  for(const file of ['test/ceo-mode-posture-ad.test.ts','test/fixtures/ceo-mode-posture-ad.json'])
    expect(selectTests([file],E2E_TOUCHFILES,[]).selected).toEqual(['plan-ceo-mode-routing']);
});
