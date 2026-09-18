import {describe,expect,test} from 'bun:test';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {ceoExpansionPacingChoice,ceoExpansionPacingReady,ceoModeSubmissionInput,hasNativePostAnswerCeoPosture,nextCeoModeNavigation,nextCeoPostureContinuation} from './helpers/ceo-mode-option';
import {capturePlanCountQuestion,nativePlanCallFingerprint,planCountPrerequisitePick,planCountQuestionInput,isNumberedOptionListVisible,isPlanReadyVisible} from './helpers/claude-pty-runner';
import {readPlanCountTranscript,type NativePublicToolEvent,type NativePlanQuestionCall} from './helpers/plan-count-transcript';
import captured from './fixtures/ceo-mode-full-ad.json';
import kindCapture from './fixtures/ceo-expansion-posture-kind-dacc.json';
import pauseCapture from './fixtures/ceo-expansion-pause-6714.json';
import {E2E_TOUCHFILES,selectTests} from './helpers/touchfiles';
const pattern=/\b(expansion|10x|delight|dream|cathedral|opt[\s-]?in)\b/i;
function replay(i:number){
 const item=captured.cases[i]!,root=fs.mkdtempSync(path.join(os.tmpdir(),'ceo-full-ad-'));
 fs.mkdirSync(path.join(root,'projects','owned'),{recursive:true});
 fs.writeFileSync(path.join(root,'projects','owned',item.process.sessionId+'.jsonl'),item.records.map(r=>JSON.stringify(r)).join('\n')+'\n');
 const events:NativePublicToolEvent[]=[];
 try{return {item,transcript:readPlanCountTranscript(root,item.process.cwd,e=>events.push(e)),events};}
 finally{fs.rmSync(root,{recursive:true,force:true});}
}
function pending(){const c=structuredClone(replay(0).transcript.calls[0]!);c.answered=false;delete c.answers;delete c.answeredAt;delete c.unansweredQuestionIndices;return c;}
// Full panes projected from exact native questions, not retained historical viewports.
function pane(call:NativePlanQuestionCall,index:number){const q=call.questions[index]!;return [
 call.questions.length>1?'← '+call.questions.map((v,i)=>`${i<index?'☒':'☐'} ${v.header}`).join(' ')+' ✔ Submit →':'☐ '+q.header,
 q.question,...q.options.map((v,i)=>`${i?' ':'❯'} ${i+1}. ${v.label}`),
 `Enter to select · ${call.questions.length>1?'Tab/Arrow keys':'↑/↓'} to navigate · Esc to cancel`].join('\n');}
function frame(c:NativePlanQuestionCall,index:number){const visible=pane(c,index);return {visible,active:capturePlanCountQuestion(visible,new Set(),0,true,c)!,routing:nativePlanCallFingerprint(c,0,true)};}
function match(e= replay(1)){return hasNativePostAnswerCeoPosture(e.transcript,'SCOPE EXPANSION',pattern,e.item.selectedAt!,e.events);}
function rebind(e:ReturnType<typeof replay>){const d=e.transcript.calls[1]!,q=d.questions[0]!;e.events[2]!.input={questions:d.questions};d.answers={[q.question]:q.options[0]!.label};}
describe('full AD mode failures retain their actual outcomes',()=>{
 test('Proposal 1 is a completed scope decision after the actual selected mode',()=>{
  const e=replay(1);expect(e.item.actualState).toBe('failed');expect(e.transcript.calls).toHaveLength(2);expect(e.events).toHaveLength(4);
  expect(e.transcript.calls[1]!.answeredAt).toBe('2026-09-09T18:26:20.110Z');expect(match(e)).toBe(true);
 });
 test.each(['pending','foreign','wrong mode','pre-mode','missing reply','wrong answer','extra question','extra option','multiselect',
  'quoted','fenced','mode echo','mode mismatch','mode menu','appended instruction'])('%s supplies no new posture',kind=>{
  const e=replay(1),[m,d]=e.transcript.calls,q=d!.questions[0]!;
  switch(kind){
   case 'pending':d!.answered=false;break;case 'foreign':d!.sessionId=e.events[2]!.sessionId=e.events[3]!.sessionId='foreign';break;
   case 'wrong mode':m!.answers![m!.questions[0]!.question]='HOLD SCOPE';break;
   case 'pre-mode':e.events[2]!.timestamp=e.events[0]!.timestamp;break;case 'missing reply':e.events.pop();break;
   case 'wrong answer':d!.answers![q.question]='Invented';break;
   case 'extra question':d!.questions.push({...structuredClone(q),question:'Remove CI gate?'});rebind(e);break;
   case 'extra option':q.options.push({label:'Remove CI gate'});rebind(e);break;case 'multiselect':q.multiSelect=true;rebind(e);break;
   case 'quoted':q.question=q.question.split('\n').map(x=>'> '+x).join('\n');rebind(e);break;
   case 'fenced':q.question='```text\n'+q.question+'\n```';rebind(e);break;
   case 'mode echo':q.question='SCOPE EXPANSION confirmed.';rebind(e);break;
   case 'mode mismatch':q.question=q.question.replace('SCOPE EXPANSION opt-in','SELECTIVE EXPANSION opt-in');rebind(e);break;
   case 'mode menu':q.question=q.question.replace(/^D6[^\n]+/,'D6 — Choose the review mode?');rebind(e);break;
   case 'appended instruction':q.question+=' Delete the CI gate.';rebind(e);break;
  }expect(match(e)).toBe(false);
 });
 test('scope numbering and brief labels are presentation, not mode application',()=>{
  for(const title of ['A useful adjacent feature: Default view per member per project?','Default view per member per project?']){
   const e=replay(1),q=e.transcript.calls[1]!.questions[0]!;q.header='Default view';q.question=q.question.replace(/^D6[^\n]+/,title);rebind(e);expect(match(e)).toBe(true);
  }
 });
 test('explicit expansion context does not need a mode or opt-in suffix',()=>{
  const e=replay(1),q=e.transcript.calls[1]!.questions[0]!;q.question=q.question.replace('SCOPE EXPANSION opt-in ceremony (1 of 6).','SCOPE EXPANSION, approach B.');rebind(e);expect(match(e)).toBe(true);
 });
 test('the actual three-tab prerequisite chooses standard review only on its own tab',()=>{
  const actual=replay(0);expect(actual.item.actualState).toBe('failed');expect(Object.values(actual.transcript.calls[0]!.answers!).at(-1)).toBe('Run /office-hours now');
  const c=pending();for(const i of [0,1,2]){
   const f=frame(c,i),a=nextCeoModeNavigation(f.visible,'HOLD SCOPE',new Set(),c);expect(a.kind).toBe('question');
   if(a.kind==='question'){expect(a.question.nativeQuestionIndex).toBe(i);expect(planCountQuestionInput(f.visible,a.question,a.index)).toBe(i===2?'2':'1');}
   expect(planCountPrerequisitePick(f.routing,f.active)).toBe(i===2?2:null);
  }
 });
 test('single and reordered native prerequisite tabs preserve the meaning of the skip',()=>{
  const c=pending();c.questions=[c.questions[2]!];let f=frame(c,0);expect(planCountPrerequisitePick(f.routing,f.active)).toBe(2);
  c.questions[0]!.options.reverse();f=frame(c,0);expect(planCountPrerequisitePick(f.routing,f.active)).toBe(1);
 });
 test.each(['wrong tab','wrong signature','wrong body','wrong order','no metadata','completed','failed','extra action','multiselect','conditional','extra remedy','no description'])('a %s cannot borrow the prerequisite action',kind=>{
  const c=pending();if(kind==='completed')c.answered=true;if(kind==='failed')c.failed=true;
  if(kind==='extra action')c.questions[2]!.options.push({label:'Accept risk'});
  if(kind==='multiselect')c.questions[2]!.multiSelect=true;
  if(kind==='conditional')c.questions[2]!.options[1]!.description+=' if all tests pass.';
  if(kind==='extra remedy')c.questions[2]!.options[1]!.description+=' Remove the CI gate.';
  if(kind==='no description')c.questions[2]!.options[1]!.description='';
  const f=frame(c,2);let a=f.active;
  if(kind==='wrong tab')a={...a,nativeQuestionIndex:0};if(kind==='wrong signature')a={...a,signature:'foreign:tool:question:2'};
  if(kind==='wrong body')a={...a,promptSnippet:'Choose a product direction.'};if(kind==='wrong order')a={...a,options:[...a.options].reverse()};
  if(kind==='no metadata')a={...a,nativeCall:undefined};
  expect(planCountPrerequisitePick(f.routing,a)).toBeNull();
 });
});

describe('full AD HOLD retry completed sequencing rationale',()=>{
 function hold(){const e=replay(2);return {e,decision:e.transcript.calls[2]!,q:e.transcript.calls[2]!.questions[0]!};}
 function matches(e:ReturnType<typeof replay>){return hasNativePostAnswerCeoPosture(e.transcript,'HOLD SCOPE',/\b(rigor|bulletproof|hold\s*scope|maximum\s+rigor)\b/i,e.item.selectedAt!,e.events);}
 function bind(e:ReturnType<typeof replay>){const d=e.transcript.calls[2]!,q=d.questions[0]!;e.events[4]!.input={questions:d.questions};d.answers={[q.question]:q.options[0]!.label};}
 test('the actual completed rationale applies HOLD to work in the previously approved approach',()=>{
  const {e,decision,q}=hold();expect(e.item.actualState).toBe('failed');expect(e.transcript.calls).toHaveLength(3);
  const approach=e.transcript.calls[0]!;expect(Object.values(approach.answers!)).toEqual(['B: ViewState schema (recommended)']);
  expect(approach.questions[0]!.options[0]!.description).toContain('URL params');
  expect(decision.answeredAt).toBe('2026-09-09T18:35:05.273Z');expect(q.question).toContain('not new scope either way');expect(matches(e)).toBe(true);
 });
 test('three and four alternatives still express one completed review decision',()=>{
  for(const count of [3,4]){const {e,q}=hold();q.options.push({label:'Gate URL sync for the pilot'});if(count===4)q.options.push({label:'Run a limited URL sync pilot'});bind(e);expect(matches(e)).toBe(true);}
 });
 test.each(['pending','foreign','before mode','missing reply','failed reply','wrong answer','metadata only','bare echo','other mode',
   'quoted rationale','fenced rationale','duplicate options','extra question','extra instruction','multiselect'])('%s is not completed HOLD rationale',kind=>{
  const {e,decision,q}=hold();
  switch(kind){
   case 'pending':decision.answered=false;break;case 'foreign':decision.sessionId=e.events[4]!.sessionId=e.events[5]!.sessionId='foreign';break;
   case 'before mode':e.events[4]!.timestamp=e.events[0]!.timestamp;break;case 'missing reply':e.events.pop();break;case 'failed reply':e.events[5]!.isError=true;break;
   case 'wrong answer':decision.answers![q.question]='Invented';break;
   case 'metadata only':q.question=q.question.replace(/ELI10:[\s\S]*?\nStakes/,'ELI10: We will implement the URL codec.\nStakes');bind(e);break;
   case 'bare echo':q.question=q.question.replace(/ELI10:[\s\S]*?\nStakes/,'ELI10: HOLD SCOPE confirmed.\nStakes');bind(e);break;
   case 'other mode':q.question=q.question.replace(/HOLD SCOPE/g,'SCOPE EXPANSION');bind(e);break;
   case 'quoted rationale':q.question=q.question.replace('ELI10: Approach','ELI10:\n> Approach');bind(e);break;
   case 'fenced rationale':q.question=q.question.replace('ELI10: Approach','ELI10: ```Approach');bind(e);break;
   case 'duplicate options':q.options[1]!.label=q.options[0]!.label;bind(e);break;
   case 'extra question':decision.questions.push({...structuredClone(q),question:'Remove CI?'});bind(e);break;
   case 'extra instruction':q.question+=' Disable authentication.';bind(e);break;
   case 'multiselect':q.multiSelect=true;bind(e);break;
  }expect(matches(e)).toBe(false);
 });
});

test('the exact full AD regressions select their periodic caller',()=>{
 for(const file of ['test/ceo-mode-full-ad.test.ts','test/fixtures/ceo-mode-full-ad.json']) expect(selectTests([file],E2E_TOUCHFILES,[]).selected).toEqual(['plan-ceo-mode-routing']);
});


describe('completed expansion disposition classes from the retained dacc public questions', () => {
  // Request/answer content is captured. The envelopes and chronology below are
  // synthetic: missing original JSONL timestamps must never become E2E evidence.
  function current(kind: 'retry' | 'meta' | 'unanswered' = 'retry') {
    const e = replay(1), decision = e.transcript.calls[1]!;
    decision.questions = [structuredClone(kind === 'meta' ? kindCapture.firstMetaQuestion
      : kind === 'unanswered' ? kindCapture.firstUnansweredQuestion : kindCapture.retryQuestion)];
    e.events[2]!.input = { questions: decision.questions };
    decision.answers = { [decision.questions[0]!.question]: kind === 'meta'
      ? kindCapture.firstMetaAnswer : kindCapture.retryAnswer };
    if (kind === 'unanswered') { decision.answered = false; delete decision.answers; e.events.pop(); }
    return e;
  }
  function amend(e: ReturnType<typeof current>, fn: (q: NativePlanQuestionCall['questions'][number]) => void) {
    const d=e.transcript.calls[1]!,q=d.questions[0]!,answer=d.answers?.[q.question];
    fn(q);e.events[2]!.input={questions:d.questions};d.answers={[q.question]:answer!};
  }
  test('the exact acknowledged Include content supplies posture in a synthetic ownership envelope', () => {
    const e=current();expect(kindCapture.actualOutcome).toContain('Both EXPANSION attempts failed');
    expect(e.transcript.assistantMessages.every(m=>Date.parse(m.timestamp)<e.item.selectedAt!)).toBe(true);
    expect(match(e)).toBe(true);
  });
  test.each(['canonical three','reordered','curly scenario','coverage scores','defer','cut'] as const)('%s preserves a substantive completed choice', kind => {
    const e=current();amend(e,q=>{
      if(kind==='canonical three'){
        q.options=q.options.slice(0,3).map((o,i)=>({...o,label:["A) Add to this plan's scope (recommended)",'B) Defer to TODOS.md','C) Skip'][i]!}));
      }
      if(kind==='reordered')q.options.reverse();
      if(kind==='curly scenario')q.question=q.question.replace('"can you share your view?"','“can you share your view?”');
      if(kind==='coverage scores')q.question=q.question.replace('Note: options differ in kind, not coverage — no completeness score.','Completeness: A=10/10, B=7/10, C=3/10');
    });
    const d=e.transcript.calls[1]!,q=d.questions[0]!;
    if(kind==='canonical three')d.answers={[q.question]:q.options[0]!.label};
    if(kind==='defer')d.answers={[q.question]:q.options[1]!.label};
    if(kind==='cut')d.answers={[q.question]:q.options[2]!.label};
    expect(match(e)).toBe(true);
  });
  test.each(['meta','unanswered'] as const)('the original %s does not supply completed expansion evidence', kind=>{
    expect(match(current(kind))).toBe(false);
  });
  test.each(['pending','selected pause','only pause','missing core','extra action','duplicate disposition',
    'generic continuation','second question','quoted decision','fenced decision','mixed packet',
    'multiselect','missing comparison','invalid score','both comparison branches','wrong mode','missing reply'] as const)(
    '%s is not a completed expansion decision', kind=>{
      const e=current();amend(e,q=>{
        if(kind==='only pause')q.options=[q.options[3]!];
        if(kind==='missing core')q.options.splice(1,1);
        if(kind==='extra action')q.options[3]!.label='Remove the CI gate';
        if(kind==='duplicate disposition')q.options[3]!.label='Add to scope';
        if(kind==='generic continuation')q.question=q.question.replace(/^D3\.1[^\n]+/,'D3.1 — Continue the review?');
        if(kind==='second question')q.question=q.question.replace('\nStakes if', '\nShould we remove access checks?\nStakes if');
        if(kind==='quoted decision')q.question=q.question.split('\n').map(l=>'> '+l).join('\n');
        if(kind==='fenced decision')q.question='```text\n'+q.question+'\n```';
        if(kind==='multiselect')q.multiSelect=true;
        if(kind==='missing comparison')q.question=q.question.replace('Note: options differ in kind, not coverage — no completeness score.','No comparison.');
        if(kind==='invalid score')q.question=q.question.replace('Note: options differ in kind, not coverage — no completeness score.','Completeness: A=11/10, B=7/10, C=3/10');
        if(kind==='both comparison branches')q.question=q.question.replace('\nNet:','\nCompleteness: A=10/10, B=7/10, C=3/10\nNet:');
      });
      const d=e.transcript.calls[1]!,q=d.questions[0]!;
      if(kind==='pending')d.answered=false;
      if(kind==='selected pause')d.answers={[q.question]:q.options[3]!.label};
      if(kind==='mixed packet'){d.questions.push({...structuredClone(q),question:'Remove access checks?'});e.events[2]!.input={questions:d.questions};}
      if(kind==='wrong mode'){const m=e.transcript.calls[0]!;m.answers={[m.questions[0]!.question]:'HOLD SCOPE'};}
      if(kind==='missing reply')e.events.pop();
      expect(match(e)).toBe(false);
    });
});


describe('owned expansion decisions with a nondecision discussion control', () => {
  function current() {
    const transcript = { status: 'ready' as const, calls: structuredClone(pauseCapture.calls), assistantMessages: [] };
    const events = structuredClone(pauseCapture.events) as NativePublicToolEvent[];
    for (const event of events) if (event.kind === 'use') event.input = { questions: transcript.calls.find(c => c.toolUseId === event.toolUseId)!.questions };
    return { transcript, events };
  }
  function accepted(e = current()) { return hasNativePostAnswerCeoPosture(e.transcript, 'SCOPE EXPANSION', pattern, pauseCapture.selectedAt, e.events); }
  test('the captured completed Add is posture evidence; the unchosen Hold qualifier does not change its action', () => {
    const e = current();
    expect(e.transcript.calls[0]!.answeredAt).toBe('2026-09-15T12:33:17.286Z');
    expect(e.transcript.calls[1]!.answeredAt).toBe('2026-09-15T12:34:22.430Z');
    expect(e.events[2]!.timestamp).toBe('2026-09-15T12:34:20.084Z');
    expect(e.transcript.calls[1]!.answers[e.transcript.calls[1]!.questions[0]!.question]).toBe('Add to scope (recommended)');
    expect(accepted(e)).toBe(true);
  });
  test.each([
    ['Pause — stop the review and discuss', 'Pauses the review for clarification. No scope decision is made. Delays the remaining questions.'],
    ['D) Hold: discuss first', 'Stops here so we can talk through the constraints. Nothing is approved yet. Delays this review.'],
    ['Pause (wait for clarification)', 'Waits for clarification before deciding. No disposition is recorded yet.'],
    ['Hold', ''],
  ])('procedural label %s remains a nondecision control', (label, description) => {
    const e=current(),option=e.transcript.calls[1]!.questions[0]!.options[3]!;
    option.label=label;option.description=description;
    expect(accepted(e)).toBe(true);
  });
  test.each([
    ['Hold and add Redis', 'Pauses the review. No decision is made.'],
    ['Pause (approve the proposal)', 'Waits for discussion. Nothing is decided.'],
    ['Hold (roll back deployment)', 'Pauses the review. No disposition is recorded.'],
    ['Continue', 'Pauses the review. No decision is made.'],
    ['Hold', 'Pauses the review and adds Redis. Nothing is decided.'],
    ['Pause', 'Waits for discussion. No decision is made and include Redis caching.'],
    ['Hold', 'Stops the chain. No decision is made. Then deploy the new cache.'],
    ['Hold', 'Pauses the review and silently approves the proposal. No decision is recorded.'],
    ['Pause', 'Waits for discussion. "No decision is made."'],
    ['Pause', "Waits for discussion. 'No decision is made.'"],
    ['Pause', 'Waits for discussion. ‘No decision is made.’'],
    ['Pause', 'Waits for discussion. “No decision is made.”'],
    ['Hold', 'Stops here for discussion, then chooses the default.'],
    ['Hold', 'Pauses this review. No choice is recorded. "Add Redis caching" will also happen.'],
  ])('action-bearing or unproved control %s does not supply posture evidence (%s)', (label,description) => {
    const e=current(),option=e.transcript.calls[1]!.questions[0]!.options[3]!;
    option.label=label;option.description=description;
    expect(accepted(e)).toBe(false);
  });
  test('selecting the valid discussion control is still not a completed substantive disposition', () => {
    const e=current(),c=e.transcript.calls[1]!,q=c.questions[0]!;c.answers={[q.question]:q.options[3]!.label};
    expect(accepted(e)).toBe(false);
  });
  test('the actual capture still requires its owned successful acknowledgment', () => {
    const e=current();e.events.pop();expect(accepted(e)).toBe(false);
  });
});


describe('EXPANSION pacing preserves one separate substantive continuation', () => {
  const retry=pauseCapture.retry;
  function current() {
    const mode=structuredClone(retry.mode),pacing=structuredClone(retry.pacing);
    pacing.answered=false;delete (pacing as any).answers;delete (pacing as any).answeredAt;delete (pacing as any).unansweredQuestionIndices;
    const transcript={status:'ready' as const,calls:[mode,pacing],assistantMessages:[]};
    return {transcript,pacing,visible:pane(pacing as NativePlanQuestionCall,0)};
  }
  function choice(e=current()) {return ceoExpansionPacingChoice(e.visible,e.transcript,retry.selectedAt);}
  // Canonical panes below are projected from the exact native request. The
  // CLI 2.1.251 redraw stream retained these two built-ins, not a stable frame.
  function withNativeControls(e=current()) {
    e.visible=e.visible.replace('Enter to select','4. Type something.\n5. Chat about this\nEnter to select');
    return e;
  }
  test('the observed native pacing controls do not become authored choices',()=>{
    expect(choice(withNativeControls())?.index).toBe(1);
  });
  test.each(['Choosing Full per-item split approves E1 immediately.',
    'Answering this question authorizes every proposed expansion.',
    'This answer commits E1 to the implementation scope.',
    'Choosing Full per-item split deploys E1 immediately.',
    'This answer ships E1 immediately.',
    'Choosing Full per-item split enables E1.',
    'This answer disables E2.',
    '“Choosing Full per-item split approves E1 immediately.”'])('whole-question scope effect is not pacing: %s',effect=>{
    const e=current();e.pacing.questions[0]!.question=e.pacing.questions[0]!.question.replace('ELI10:',`ELI10: ${effect}`);
    e.visible=pane(e.pacing as NativePlanQuestionCall,0);expect(choice(e)?.index).toBe(0);
  });
  test.each(['unknown action','reordered controls','extra control','mismatched authored option'])('native pacing pane rejects %s',kind=>{
    const e=withNativeControls();
    if(kind==='unknown action')e.visible=e.visible.replace('Type something.','Approve all now.');
    if(kind==='reordered controls')e.visible=e.visible.replace('Type something.','Chat about this').replace('5. Chat about this','5. Type something.');
    if(kind==='extra control')e.visible=e.visible.replace('Enter to select','6. More actions\nEnter to select');
    if(kind==='mismatched authored option')e.visible=e.visible.replace('Full per-item split','Approve all proposals');
    expect(choice(e)?.index).toBe(0);
  });
  test('the captured full-per-item answer preserves scope; pacing alone and actual pending E1 remain negative',()=>{
    const e=current(),pick=choice(e);expect(pick?.index).toBe(1);
    expect(hasNativePostAnswerCeoPosture({status:'ready',calls:[retry.mode,retry.pacing],assistantMessages:[]},'SCOPE EXPANSION',pattern,retry.selectedAt,[])).toBe(false);
    expect(retry.pendingProposal.answered).toBe(false);
    expect(ceoExpansionPacingReady('next screen',e.transcript,pick!,[])).toBe(false);
  });
  test('the preserving option can be reordered or use equivalent individual-walkthrough wording',()=>{
    const e=current(),q=e.pacing.questions[0]!;q.options.reverse();
    q.options[2]!.label='All proposals individually';
    q.options[2]!.description='Each proposal separately with Add / Defer / Skip / Hold. No item is skipped or merged without your approval. Delays the remaining review.';
    e.visible=pane(e.pacing as NativePlanQuestionCall,0);expect(choice(e)?.index).toBe(3);
  });
  test.each(['foreign','unanswered mode','wrong mode','already answered','mixed packet','mismatched viewport','narrowing','bundled approval','quoted assurance','duplicate preserving choice','multiple pending calls'])('%s cannot authorize pacing',kind=>{
    const e=current(),q=e.pacing.questions[0]!,o=q.options[0]!;
    if(kind==='foreign')e.pacing.sessionId='foreign';
    if(kind==='unanswered mode')e.transcript.calls[0]!.answered=false;
    if(kind==='wrong mode')e.transcript.calls[0]!.answers={[e.transcript.calls[0]!.questions[0]!.question]:'HOLD SCOPE'};
    if(kind==='already answered')e.pacing.answered=true;
    if(kind==='mixed packet')e.pacing.questions.push({...structuredClone(q),header:'Extra scope',question:'Approve all proposals now?'});
    if(kind==='narrowing')o.description+=' Add E1 and drop E2 now.';
    if(kind==='bundled approval')o.label='Full per-item split and approve all';
    if(kind==='quoted assurance')o.description=o.description.replace('No proposal is dropped or merged without your say','"No proposal is dropped or merged without your say"');
    if(kind==='duplicate preserving choice')q.options[1]=structuredClone(o);
    if(kind==='multiple pending calls')e.transcript.calls.push({...structuredClone(e.pacing),toolUseId:'another-pending-call'});
    if(kind!=='mismatched viewport')e.visible=pane(e.pacing as NativePlanQuestionCall,0);
    else e.visible=e.visible.replace('Full per-item split','Narrow first');
    if(['foreign','unanswered mode','wrong mode','already answered'].includes(kind))expect(choice(e)).toBeNull();
    else expect(choice(e)?.index).toBe(0);
  });
  test('the pacing transition needs its successful bound ACK and a different current pane',()=>{
    const e=current(),pick=choice(e)!;e.transcript.calls[1]=structuredClone(retry.pacing);
    const c=e.transcript.calls[1]!,events:NativePublicToolEvent[]=[
      {kind:'use',name:'AskUserQuestion',sessionId:c.sessionId,toolUseId:c.toolUseId,timestamp:new Date(Date.parse(c.answeredAt!)-1000).toISOString(),input:{questions:c.questions}},
      {kind:'result',sessionId:c.sessionId,toolUseId:c.toolUseId,timestamp:c.answeredAt!,isError:false},
    ];
    // Request time is synthetic; the captured ACK time and request body are retained.
    expect(ceoExpansionPacingReady('a different current pane',e.transcript,pick,events)).toBe(true);
    expect(ceoExpansionPacingReady(e.visible,e.transcript,pick,events)).toBe(false);
    expect(ceoExpansionPacingReady('a different current pane',e.transcript,pick,events.slice(0,1))).toBe(false);
    events[1]!.isError=true;expect(ceoExpansionPacingReady('a different current pane',e.transcript,pick,events)).toBe(false);
    events[1]!.isError=false;c.answers={[c.questions[0]!.question]:c.questions[0]!.options[1]!.label};
    expect(ceoExpansionPacingReady('a different current pane',e.transcript,pick,events)).toBe(false);
  });
  function acknowledgedProposal() {
    // Derived transition only: pending E1 never received an actual paid ACK.
    // Missing original request times below are explicitly synthetic.
    const mode=structuredClone(retry.mode),proposal=structuredClone(retry.pendingProposal) as NativePlanQuestionCall;
    proposal.answered=true;proposal.answers={[proposal.questions[0]!.question]:proposal.questions[0]!.options[0]!.label};proposal.unansweredQuestionIndices=[];
    proposal.answeredAt=new Date(Date.parse(retry.pacing.answeredAt)+2000).toISOString();
    const transcript={status:'ready' as const,calls:[mode,proposal],assistantMessages:[]};
    const events:NativePublicToolEvent[]=transcript.calls.flatMap(c=>[
      {kind:'use' as const,name:'AskUserQuestion',sessionId:c.sessionId,toolUseId:c.toolUseId,timestamp:new Date(Date.parse(c.answeredAt!)-1000).toISOString(),input:{questions:c.questions}},
      {kind:'result' as const,sessionId:c.sessionId,toolUseId:c.toolUseId,timestamp:c.answeredAt!,isError:false},
    ]);
    return {transcript,events};
  }
  test('a separately acknowledged current proposal establishes scope expansion through its real before/after comparison',()=>{
    const e=acknowledgedProposal();expect(hasNativePostAnswerCeoPosture(e.transcript,'SCOPE EXPANSION',pattern,retry.selectedAt,e.events)).toBe(true);
    expect(hasNativePostAnswerCeoPosture(e.transcript,'SCOPE EXPANSION',/cathedral/i,retry.selectedAt,e.events)).toBe(false);
  });
  test.each(['ordinal/source link','decimal decision identity','before/after paraphrase','defer','skip'])('%s preserves the same current proposal',kind=>{
    const e=acknowledgedProposal(),c=e.transcript.calls[1]!,q=c.questions[0]!;
    if(kind==='ordinal/source link')q.question=q.question.replace('E1: Project-shared views (ledger row S1)','Proposal 1 of 7: E1 — Project-shared views [source](PLAN.md)');
    if(kind==='decimal decision identity')q.question=q.question.replace('D3.1 —','D12.3.1 —');
    if(kind==='before/after paraphrase')q.question=q.question.replace('Today the plan saves a view for one member only. E1 adds','As written, each member keeps private views. E1 would introduce');
    c.answers={[q.question]:q.options[kind==='defer'?1:kind==='skip'?2:0]!.label};e.events[2]!.input={questions:c.questions};
    expect(hasNativePostAnswerCeoPosture(e.transcript,'SCOPE EXPANSION',pattern,retry.selectedAt,e.events)).toBe(true);
  });
  test.each(['pending','missing ACK','wrong proposal identity','no current baseline','vague baseline','second question','quoted comparison','foreign','selected pause'])('%s supplies no proposal completion',kind=>{
    const e=acknowledgedProposal(),c=e.transcript.calls[1]!,q=c.questions[0]!;
    if(kind==='pending')c.answered=false;
    if(kind==='missing ACK')e.events.pop();
    if(kind==='wrong proposal identity')q.question=q.question.replace('E1 adds','E2 adds');
    if(kind==='no current baseline')q.question=q.question.replace('Today the plan saves','Previously an unrelated plan saved');
    if(kind==='vague baseline')q.question=q.question.replace('Today the plan saves a view for one member only.','Today the plan is interesting.');
    if(kind==='second question')q.question=q.question.replace('ELI10:','ELI10: Should we remove access checks?');
    if(kind==='quoted comparison')q.question=q.question.replace('ELI10: Today','ELI10: "Today').replace('Stakes if','"\nStakes if');
    if(kind==='foreign')c.sessionId='foreign';
    c.answers={[q.question]:q.options[kind==='selected pause'?3:0]!.label};e.events[2]!.input={questions:c.questions};
    expect(hasNativePostAnswerCeoPosture(e.transcript,'SCOPE EXPANSION',pattern,retry.selectedAt,e.events)).toBe(false);
  });
});

import completeInventory from './fixtures/ceo-expansion-complete-inventory-6f.json';
describe('complete candidate split is navigation with an actual ACK boundary',()=>{
const f=completeInventory;
const actualFrame=f.viewport;
function state(){const pacing=structuredClone(f.pacing);pacing.answered=false;delete pacing.answers;delete pacing.answeredAt;delete pacing.unansweredQuestionIndices;return{pacing,transcript:{status:'ready' as const,calls:[structuredClone(f.mode),pacing],assistantMessages:[]}};}
function pane(c:any){const q=c.questions[0];return ['☐ '+q.header,q.question,...q.options.map((o:any,i:number)=>`${i?' ':'❯'} ${i+1}. ${o.label}`),'4. Type something.','5. Chat about this','Enter to select · ↑/↓ to navigate · Esc to cancel'].join('\n');}
const verify=(name:string,pass:boolean)=>test(name,()=>expect(pass).toBe(true));
const choose=(e=state(),screen=pane(e.pacing))=>ceoExpansionPacingChoice(screen,e.transcript,f.selectedAt);
verify('actual retained frame selects the complete seven-candidate walkthrough',choose(state(),actualFrame)?.index===1);
for(const [name,mutate]of Object.entries({
 'eight complete candidates':(q:any)=>{q.question=q.question.replaceAll('7 expansion candidates','8 expansion candidates').replace('7 adjacent improvements','8 adjacent improvements').replace('E7 cross-project views.','E7 cross-project views, E8 shared pinned groups.').replaceAll('Seven','Eight');q.options[0].label=q.options[0].label.replace('7 questions','8 questions');q.options[0].description=q.options[0].description.replace('E7','E8');},
 'different proposal prefix':(q:any)=>{q.question=q.question.replace(/\bE(?=\d)/g,'P');q.options.forEach((o:any)=>{o.description=o.description.replace(/\bE(?=\d)/g,'P');});},
 'complete walkthrough label':(q:any)=>{q.options[0].label='A: Complete walkthrough, 7 questions (recommended)';},
 'one per item with explicit range':(q:any)=>{q.options[0].description='One question per item, E1 to E7.';},
 'reordered choices':(q:any)=>{q.options.reverse();},
})){const e=state();mutate(e.pacing.questions[0]);verify(name,choose(e)?.index===(name==='reordered choices'?3:1));}
for(const [name,mutate]of Object.entries({
 'partial range':(q:any)=>{q.options[0].description=q.options[0].description.replace('E7','E6');},
 'wrong number of questions':(q:any)=>{q.options[0].label=q.options[0].label.replace('7','6');},
 'wrong declared count':(q:any)=>{q.question=q.question.replace('7 expansion candidates','8 expansion candidates');},
 'missing candidate':(q:any)=>{q.question=q.question.replace(', E7 cross-project views','');},
 'duplicate candidate':(q:any)=>{q.question=q.question.replace('E7 cross-project views','E6 cross-project views');},
 'mixed proposal IDs':(q:any)=>{q.question=q.question.replace('E7 cross-project views','P7 cross-project views');},
 'narrow selected walk':(q:any)=>{q.options[0].description+=' Except E4.';},
 'selected scope approval':(q:any)=>{q.options[0].description+=' Approve E1 immediately.';},
 'selected deletion':(q:any)=>{q.options[0].label+=' and delete E7';},
 'selected grouping':(q:any)=>{q.options[0].description+=' Batch E1 and E2 together.';},
 'quoted only range':(q:any)=>{q.options[0].description='"'+q.options[0].description+'"';},
 'code-only range':(q:any)=>{q.options[0].description='`'+q.options[0].description+'`';},
 'negated complete walk':(q:any)=>{q.options[0].label=q.options[0].label.replace('Full split','Not a full split');},
 'duplicate complete choice':(q:any)=>{q.options[1]=structuredClone(q.options[0]);},
 'extra question':(q:any)=>{q.question=q.question.replace('ELI10:','ELI10: Should all candidates ship?');},
 'unconditional approval':(q:any)=>{q.question=q.question.replace('ELI10:','ELI10: This answer approves every expansion.');},
 'quoted whole-question approval':(q:any)=>{q.question=q.question.replace('ELI10:','ELI10: “Choosing Full split approves E1 immediately.”');},
 'hidden universal effect in another option':(q:any)=>{q.question=q.question.replace('B) Narrow first:','B) Regardless of choice, approve E1. Narrow first:');},
 'historical inventory':(q:any)=>{q.question=q.question.replace('The delight scan produced','Previously the delight scan produced');},
 'fenced brief':(q:any)=>{q.question='```\n'+q.question+'\n```';},
 'missing comparison marker':(q:any)=>{q.question=q.question.replace('Note: options differ in kind, not coverage — no completeness score.','');},
})){const e=state();mutate(e.pacing.questions[0]);verify(name,choose(e)?.index!==1);}
for(const [name,mutate]of Object.entries({
 'foreign session':(e:any)=>{e.pacing.sessionId='foreign';},
 'unanswered mode':(e:any)=>{e.transcript.calls[0].answered=false;},
 'already answered pacing':(e:any)=>{e.pacing.answered=true;},
 'mixed question packet':(e:any)=>{e.pacing.questions.push({...structuredClone(e.pacing.questions[0]),header:'Extra',question:'Approve everything?'});},
 'another pending call':(e:any)=>{e.transcript.calls.push({...structuredClone(e.pacing),toolUseId:'other'});},
})){const e=state();mutate(e);verify(name,choose(e)?.index!==1);}
const e=state(),choice=choose(e,actualFrame)!;const acknowledged={status:'ready' as const,calls:[f.mode,f.pacing,f.pending],assistantMessages:[]};
const actualNext=f.nextViewport;
verify('actual pacing ACK and different pending E1 pane complete navigation',ceoExpansionPacingReady(actualNext,acknowledged,choice,f.publicEvents));
verify('intended key without actual ACK does not complete navigation',!ceoExpansionPacingReady(actualNext,e.transcript,choice,f.publicEvents));
verify('missing result does not complete navigation',!ceoExpansionPacingReady(actualNext,acknowledged,choice,f.publicEvents.filter((e:any)=>e.kind!=='result')));
verify('failed result does not complete navigation',!ceoExpansionPacingReady(actualNext,acknowledged,choice,f.publicEvents.map((e:any)=>({...e,isError:e.kind==='result'}))));
verify('same old pane does not complete navigation',!ceoExpansionPacingReady(actualFrame,acknowledged,choice,f.publicEvents));
verify('pacing and pending E1 supply no completed posture',!hasNativePostAnswerCeoPosture(acknowledged,'SCOPE EXPANSION',/expansion|10x|delight|dream/i,f.selectedAt,f.publicEvents));
});

describe('candidate inventory cannot approve scope',()=>{
const f=completeInventory;
function state(){const pacing=structuredClone(f.pacing);pacing.answered=false;delete pacing.answers;delete pacing.answeredAt;delete pacing.unansweredQuestionIndices;return{pacing,transcript:{status:'ready' as const,calls:[structuredClone(f.mode),pacing],assistantMessages:[]}};}
function pane(c:any){const q=c.questions[0];return ['☐ '+q.header,q.question,...q.options.map((o:any,i:number)=>`${i?' ':'❯'} ${i+1}. ${o.label}`),'4. Type something.','5. Chat about this','Enter to select · ↑/↓ to navigate · Esc to cancel'].join('\n');}
const mutations={
 'inventory actor grants all candidates':(q:any)=>q.question=q.question.replace('E7 cross-project views.','E7 cross-project views; we approve all seven now.'),
 'inventory item claims current approval':(q:any)=>q.question=q.question.replace('E7 cross-project views.','E7 cross-project views (already approved).'),
 'inventory item has bare approval status':(q:any)=>q.question=q.question.replace('E7 cross-project views.','E7 cross-project views (approved).'),
 'inventory all items are approved':(q:any)=>q.question=q.question.replace('E7 cross-project views.','E7 cross-project views; all seven are approved.'),
 'inventory imperative ship grant':(q:any)=>q.question=q.question.replace('E7 cross-project views.','E7 cross-project views; ship all seven now.'),
 'inventory scope disposition':(q:any)=>q.question=q.question.replace('E7 cross-project views.','E7 cross-project views; all seven are in scope.'),
 'inventory skipped candidate':(q:any)=>q.question=q.question.replace('E7 cross-project views.','E7 cross-project views (deferred).'),
 'title claims inventory approved':(q:any)=>q.question=q.question.replace('How do you want to decide them?','All seven are already approved. How do you want to decide them?'),
 'rationale claims candidates in scope':(q:any)=>q.question=q.question.replace('The delight scan produced','All candidates are in scope. The delight scan produced'),
 'rationale claims prior approval':(q:any)=>q.question=q.question.replace('The delight scan produced','These items have been approved. The delight scan produced'),
};
for (const [name,mutate] of Object.entries(mutations)) test(name,()=>{
  const e=state();mutate(e.pacing.questions[0]);
  expect(ceoExpansionPacingChoice(pane(e.pacing),e.transcript,f.selectedAt)?.index).not.toBe(1);
});
test('descriptive Update and delete feature titles remain supported',()=>{
  expect(ceoExpansionPacingChoice(f.viewport,state().transcript,f.selectedAt)?.index).toBe(1);
});
});

import nativePacing77 from './fixtures/ceo-expansion-pacing-77.json';
describe('complete per-proposal pacing preserves every candidate without granting scope',()=>{
  const f=nativePacing77.completePerProposal;
  function state(){const transcript=structuredClone(f.transcript);return{transcript,pacing:transcript.calls.at(-1)!};}
  function pane(c:any){const q=c.questions[0];return ['☐ '+q.header,q.question,...q.options.map((o:any,i:number)=>`${i?' ':'❯'} ${i+1}. ${o.label}`),'4. Type something.','5. Chat about this','Enter to select · ↑/↓ to navigate · Esc to cancel'].join('\n');}
  function choose(e=state(),screen=pane(e.pacing)){return ceoExpansionPacingChoice(screen,e.transcript as any,f.selectionStartedAt);}
  test('actual parenthesized full inventory binds one question per proposal',()=>{
    const e=state(),choice=choose(e,f.viewport)!;
    expect(choice?.index).toBe(1);
    expect(ceoExpansionPacingReady('Next proposal',e.transcript as any,choice,f.events as any)).toBe(false);
    expect(hasNativePostAnswerCeoPosture(e.transcript as any,'SCOPE EXPANSION',/expansion|10x|delight|dream/i,f.selectionStartedAt,f.events as any)).toBe(false);
  });
  const positive={
    'different complete inventory prefix':(q:any)=>{q.question=q.question.replace(/\bP(?=\d)/g,'E');},
    'numeric and word counts':(q:any)=>{q.question=q.question.replace('Seven expansion','7 expansion').replace('7 independent','seven independent');},
    'colon-delimited independent inventory':(q:any)=>{q.question=q.question.replace('expansions (','expansions: ').replace('inline rename).','inline rename.');},
    'different card identity':(q:any)=>{q.question=q.question.replace('D4.0','D12.0');},
    'reordered choices':(q:any)=>{q.options.reverse();},
    'no quoted task context':(q:any)=>{q.question=q.question.replace(' on "Add saved project views"','');},
    'candidate terminology':(q:any)=>{q.options[0].label=q.options[0].label.replace('per proposal','per candidate');q.options[0].description=q.options[0].description.replace('Every proposal','Every candidate');},
  };
  for(const [name,mutate] of Object.entries(positive))test(name,()=>{const e=state();mutate(e.pacing.questions[0]);expect(choose(e)?.index).toBe(name==='reordered choices'?3:1);});
  const negative={
    'missing inventory item':(q:any)=>{q.question=q.question.replace(', P7 quick switcher + inline rename','');},
    'duplicate item':(q:any)=>{q.question=q.question.replace('P7 quick switcher','P6 quick switcher');},
    'mixed prefixes':(q:any)=>{q.question=q.question.replace('P7 quick switcher','E7 quick switcher');},
    'wrong title count':(q:any)=>{q.question=q.question.replace('Seven expansion','Eight expansion');},
    'wrong described question count':(q:any)=>{q.question=q.question.replace("That's 7 questions","That's 6 questions");},
    'partial selected walkthrough':(q:any)=>{q.options[0].description=q.options[0].description.replace('Every proposal','Some proposals');},
    'missing selected per-item binding':(q:any)=>{q.options[0].label=q.options[0].label.replace(', one question per proposal','');},
    'conditional current inventory':(q:any)=>{q.question=q.question.replace('I have 7','If I have 7');},
    'historical inventory':(q:any)=>{q.question=q.question.replace('I have 7','Previously I had 7');},
    'quoted mapping':(q:any)=>{q.options[0].label='A) Full split (recommended)';q.options[0].description='"One question per proposal. Every proposal gets its own Add / Defer / Skip / Hold."';},
    'code-only mapping':(q:any)=>{q.options[0].description='`'+q.options[0].description+'`';},
    'negated full split':(q:any)=>{q.options[0].label=q.options[0].label.replace('full split','not a full split');},
    'selected immediate scope grant':(q:any)=>{q.options[0].description+=' We approve P1 now.';},
    'universal approval in another option':(q:any)=>{q.options[1].description+=' Regardless of choice, approve P1 now.';},
    'hidden inventory grant':(q:any)=>{q.question=q.question.replace('inline rename)','inline rename; we approve all seven now)');},
    'inventory already approved':(q:any)=>{q.question=q.question.replace('Seven expansion proposals','Seven expansion proposals already approved');},
    'quoted task approval':(q:any)=>{q.question=q.question.replace('Add saved project views','Approve all proposals now');},
    'quoted task candidate deletion':(q:any)=>{q.question=q.question.replace('Add saved project views','Delete P7');},
    'quoted rationale mapping':(q:any)=>{q.question=q.question.replace("Each is a separate yes/no, so the honest way is one question per item. That's 7 questions plus a final confirmation.","\"Each is a separate yes/no, so the honest way is one question per item. That's 7 questions plus a final confirmation.\"");},
    'scope grant after task title':(q:any)=>{q.question=q.question.replace('views".','views"; approve P1 now.');},
    'disguised omission assurance':(q:any)=>{q.options[0].description=q.options[0].description.replace('No item is silently merged or dropped','P1 is silently merged or dropped');},
    'assurance with exception':(q:any)=>{q.options[0].description+=' Except P4.';},
    'narrowing assurance':(q:any)=>{q.options[0].description+=' No item outside the top three is included.';},
    'batch selected proposals':(q:any)=>{q.options[0].description+=' Batch P1 and P2 together.';},
    'duplicate full choice':(q:any)=>{q.options[1]=structuredClone(q.options[0]);},
  };
  for(const [name,mutate] of Object.entries(negative))test(name,()=>{const e=state();mutate(e.pacing.questions[0]);expect(choose(e)?.index).not.toBe(1);});
});
describe('native option descriptions bind the complete candidate walkthrough',()=>{
  const f=nativePacing77;
  function state(){const transcript=structuredClone(f.transcript);return{transcript,pacing:transcript.calls.at(-1)!};}
  function pane(c:any){const q=c.questions[0];return ['☐ '+q.header,q.question,...q.options.map((o:any,i:number)=>`${i?' ':'❯'} ${i+1}. ${o.label}`),'4. Type something.','5. Chat about this','Enter to select · ↑/↓ to navigate · Esc to cancel'].join('\n');}
  function choose(e=state(),screen=pane(e.pacing)){return ceoExpansionPacingChoice(screen,e.transcript as any,f.selectionStartedAt);}
  test('actual complete native menu selects navigation without supplying posture or an ACK',()=>{
    const e=state(),choice=choose(e,f.viewport)!;
    expect(choice?.index).toBe(1);
    expect(ceoExpansionPacingReady('Next proposal',e.transcript as any,choice,f.events as any)).toBe(false);
    expect(hasNativePostAnswerCeoPosture(e.transcript as any,'SCOPE EXPANSION',/expansion|10x|delight|dream/i,f.selectionStartedAt,f.events as any)).toBe(false);
  });
  const positive={
    'numeric count presentation':(q:any)=>{q.question=q.question.replaceAll('Eight','8').replaceAll('eight','8');q.options[0].description=q.options[0].description.replaceAll('Eight','8');},
    'mixed word and numeric counts':(q:any)=>{q.question=q.question.replace('Eight expansion','8 expansion');q.options[0].description=q.options[0].description.replace('Eight sequential','8 sequential');},
    'different complete candidate prefix':(q:any)=>{q.question=q.question.replace(/\bE(?=\d)/g,'P');},
    'different question chain identity':(q:any)=>{q.question=q.question.replace('D4.0','D12.0');q.options[0].description=q.options[0].description.replaceAll('D4.','D12.');},
    'reordered native choices':(q:any)=>{q.options.reverse();},
    'explicit candidate range without duplicated option prose':(q:any)=>{q.options[0].label='A: Full split, 8 questions (recommended)';q.options[0].description='One question per candidate, E1 through E8.';},
    'one per proposal label':(q:any)=>{q.options[0].label=q.options[0].label.replace('one per item','one per proposal');},
    'no prior approach annotation':(q:any)=>{q.question=q.question.replace(', approach C approved','');},
  };
  for(const [name,mutate] of Object.entries(positive))test(name,()=>{
    const e=state();mutate(e.pacing.questions[0]);expect(choose(e)?.index).toBe(name==='reordered native choices'?3:1);
  });
  const negative={
    'hyphenated larger count cannot be read as its last digit':(q:any)=>{q.question=q.question.replaceAll('Eight','Twenty-eight').replaceAll('eight','twenty-eight');q.options[0].description=q.options[0].description.replaceAll('Eight','Twenty-eight');},
    'spaced larger count cannot be read as its last digit':(q:any)=>{q.question=q.question.replaceAll('Eight','Twenty eight').replaceAll('eight','twenty eight');q.options[0].description=q.options[0].description.replaceAll('Eight','Twenty eight');},
    'unsupported tens in title are not a single count':(q:any)=>{q.question=q.question.replace('Eight expansion','Thirty eight expansion');},
    'unsupported tens in inventory are not a single count':(q:any)=>{q.question=q.question.replace('eight candidates:','forty eight candidates:');},
    'unsupported tens in sequence are not a single count':(q:any)=>{q.options[0].description=q.options[0].description.replace('Eight sequential','Ninety eight sequential');},
    'conjoined cardinal is not its last component':(q:any)=>{q.question=q.question.replace('Eight expansion','One hundred and eight expansion');},
    'wrong title count':(q:any)=>{q.question=q.question.replace('Eight expansion','Seven expansion');},
    'wrong inventory count':(q:any)=>{q.question=q.question.replace('eight candidates:','seven candidates:');},
    'missing candidate':(q:any)=>{q.question=q.question.replace(', E8 views feeding digests/dashboards','');},
    'duplicate candidate':(q:any)=>{q.question=q.question.replace('E8 views feeding','E7 views feeding');},
    'foreign candidate prefix':(q:any)=>{q.question=q.question.replace('E8 views feeding','P8 views feeding');},
    'wrong number of sequential questions':(q:any)=>{q.options[0].description=q.options[0].description.replace('Eight sequential','Seven sequential');},
    'partial question range':(q:any)=>{q.options[0].description=q.options[0].description.replace('D4.8','D4.7');},
    'late range start':(q:any)=>{q.options[0].description=q.options[0].description.replace('D4.1','D4.2');},
    'foreign question chain':(q:any)=>{q.options[0].description=q.options[0].description.replaceAll('D4.','D5.');},
    'additional question chain':(q:any)=>{q.options[0].description+=' Then D5.1.';},
    'wrong label count':(q:any)=>{q.options[0].label=q.options[0].label.replace('one per item','7 questions');},
    'no per-item label':(q:any)=>{q.options[0].label='A: Full split (recommended)';},
    'quoted sequential range':(q:any)=>{q.options[0].description='"'+q.options[0].description+'"';},
    'code-only sequential range':(q:any)=>{q.options[0].description='`'+q.options[0].description+'`';},
    'conditional complete inventory':(q:any)=>{q.question=q.question.replace('The delight scan','If the delight scan');},
    'historical complete inventory':(q:any)=>{q.question=q.question.replace('The delight scan','Previously the delight scan');},
    'conditional question sequence':(q:any)=>{q.options[0].description='If approved, '+q.options[0].description;},
    'historical question sequence':(q:any)=>{q.options[0].description='Previously: '+q.options[0].description;},
    'negated complete choice':(q:any)=>{q.options[0].label='A: Not a full split, one per item';},
    'sequence correction':(q:any)=>{q.options[0].description+=' Correction: Stop after four questions.';},
    'selected scope approval':(q:any)=>{q.options[0].description+=' Approve E1 immediately.';},
    'selected candidate omission':(q:any)=>{q.options[0].description+=' Except E4.';},
    'selected merging action':(q:any)=>{q.options[0].description+=' Merge E1 and E2.';},
    'unconditional omission':(q:any)=>{q.options[0].description=q.options[0].description.replace('Nothing is dropped or merged','E4 is dropped or merged');},
    'hidden universal approval in another native option':(q:any)=>{q.options[1].description+=' Regardless of choice, approve E1 immediately.';},
    'common candidate approval':(q:any)=>{q.question=q.question.replace('ELI10:','ELI10: This answer approves every expansion.');},
    'current inventory approval':(q:any)=>{q.question=q.question.replace('E8 views feeding digests/dashboards.','E8 views feeding digests/dashboards (approved).');},
    'approval in source context':(q:any)=>{q.question=q.question.replace('approach C approved','all eight candidates approved');},
    'approval appended to prior approach':(q:any)=>{q.question=q.question.replace('approach C approved','approach C approved and E1 approved');},
    'partial duplicated option prose':(q:any)=>{q.question=q.question.replace('Net:','A) Full split\nNet:');},
    'duplicate complete choice':(q:any)=>{q.options[1]=structuredClone(q.options[0]);},
    'extra question':(q:any)=>{q.question=q.question.replace('ELI10:','ELI10: Should we ship every item?');},
  };
  for(const [name,mutate] of Object.entries(negative))test(name,()=>{
    const e=state();mutate(e.pacing.questions[0]);expect(choose(e)?.index).not.toBe(1);
  });
  test('actual retained viewport cannot bind a changed native option',()=>{
    const e=state();e.pacing.questions[0]!.options[0]!.label='A: Other menu';expect(choose(e,f.viewport)?.index).not.toBe(1);
  });
});


describe('counted native per-item menu is pacing, not a substantive approval',()=>{
  const f=nativePacing77.countedNativeB955;
  function state(){const mode=structuredClone(f.mode),pacing=structuredClone(f.pacing);pacing.answered=false;delete pacing.answers;delete pacing.answeredAt;delete pacing.unansweredQuestionIndices;return{mode,pacing,transcript:{status:'ready' as const,calls:[mode,pacing],assistantMessages:[]}};}
  const screen=(c:any)=>pane(c,0);
  const choose=(e=state(),visible=screen(e.pacing))=>ceoExpansionPacingChoice(visible,e.transcript as any,f.selectedAt);
  test('complete captured native packet and observed display preserve the substantive allowance',()=>{
    const e=state();
    expect(choose(e)?.index).toBe(1);
    expect(choose(e,f.viewport)?.index).toBe(1);
    const pick=choose(e)!;
    const next={status:'ready' as const,calls:[structuredClone(f.mode),structuredClone(f.pacing),structuredClone(f.pending)],assistantMessages:[]};
    const events=f.events.map(v=>v.kind==='use'?{...v,input:{questions:next.calls.find(c=>c.toolUseId===v.toolUseId)!.questions}}:v) as NativePublicToolEvent[];
    expect(ceoExpansionPacingReady(f.nextViewport,next as any,pick,events)).toBe(true);
    expect(hasNativePostAnswerCeoPosture(next as any,'SCOPE EXPANSION',pattern,f.selectedAt,events)).toBe(false);
    expect(nextCeoPostureContinuation(f.nextViewport,next as any,'SCOPE EXPANSION',f.selectedAt,new Set(),false)).toBe('question');
    expect(nextCeoPostureContinuation(f.nextViewport,next as any,'SCOPE EXPANSION',f.selectedAt,new Set(),true)).toBeNull();
    expect(f.pending.answered).toBe(false);
  });
  const positive={
    'question wording describes pacing intent':(q:any)=>{q.question=q.question.replace('Eleven expansion proposals: full per-item chain, narrow first, or batch?','How should we present the eleven expansion proposals: individually or in batches?');},
    'explicit numeric count and independent candidate terminology':(q:any)=>{q.question=q.question.replace('Eleven expansion proposals','11 expansion candidates').replace('11 independent add-ons','eleven independent candidates');},
    'proposals can name natural add/remove changes':(q:any)=>{q.question=q.question.replace('E1 shared visibility','E1 add shared views').replace('E2 versioned payload','E2 remove duplicate controls');},
    'another complete set of explicit identities':(q:any)=>{q.question=q.question.replace(/\bE(?=\d)/g,'P').replaceAll('L3','Q9');},
    'consistent reordered comparison and native options':(q:any)=>{q.options.reverse();},
    'native labels carry letters too':(q:any)=>{q.options.forEach((o:any,i:number)=>{o.label=String.fromCharCode(65+i)+') '+o.label;});},
  };
  for(const[name,change]of Object.entries(positive))test(name,()=>{const e=state();change(e.pacing.questions[0]);expect(choose(e)?.index).toBe(name.startsWith('consistent reordered')?3:1);});
  const negative={
    'missing declared candidate':(q:any)=>{q.question=q.question.replace(', L3 auto-persist last filters','');},
    'duplicate declared identity':(q:any)=>{q.question=q.question.replace('L3 auto-persist last filters','E10 auto-persist last filters');},
    'wrong title count':(q:any)=>{q.question=q.question.replace('Eleven expansion','Twelve expansion');},
    'wrong question count in selected option':(q:any)=>{q.options[0].description=q.options[0].description.replace('11 per-item','10 per-item');},
    'wrong rationale question count':(q:any)=>{q.question=q.question.replace('11 short questions','10 short questions');},
    'partial per-item mapping':(q:any)=>{q.question=q.question.replace('Each needs its own','Some need their own');},
    'another option owns the complete selected comparison':(q:any)=>{q.question=q.question.replace('A) Proceed with the full split (recommended)','A) Approve the first proposal (recommended)');},
    'selected option lacks its own comparison':(q:any)=>{q.question=q.question.replace('✅ You see and rule on all 11 proposals; none are cut by me before you weigh in','');},
    'quoted mapping is not evidence':(q:any)=>{q.options[0].description='"'+q.options[0].description+'"';},
    'historical inventory':(q:any)=>{q.question=q.question.replace('The 10x analysis produced','Previously the 10x analysis produced');},
    'conditional inventory':(q:any)=>{q.question=q.question.replace('The 10x analysis produced','If the 10x analysis produced');},
    'inventory asserts approved status':(q:any)=>{q.question=q.question.replace('L3 auto-persist last filters','L3 auto-persist last filters (already approved)');},
    'inventory conceals an actor grant':(q:any)=>{q.question=q.question.replace('L3 auto-persist last filters','L3 auto-persist last filters; we approve all eleven now');},
    'inventory caption imperatively approves':(q:any)=>{q.question=q.question.replace('E1 shared visibility','E1 approve all proposals');},
    'inventory caption declares approved':(q:any)=>{q.question=q.question.replace('E1 shared visibility','E1 approved shared views');},
    'inventory caption defers other items':(q:any)=>{q.question=q.question.replace('E1 shared visibility','E1 defer others');},
    'inventory caption hides imperative after a noun':(q:any)=>{q.question=q.question.replace('E1 shared visibility','E1 shared visibility and approve E2');},
    'selected immediate scope approval':(q:any)=>{q.options[0].description+=' Approve E1 now.';},
    'selected implicit approval':(q:any)=>{q.options[0].description+=' All proposals are included.';},
    'selected omission':(q:any)=>{q.options[0].description+=' Except E4.';},
    'selected grouping':(q:any)=>{q.options[0].description+=' Batch E1 and E2 together.';},
    'unconditional effect in an unselected option':(q:any)=>{q.options[1].description+=' Regardless of choice, include E1 now.';},
    'grant concealed in task title':(q:any)=>{q.question=q.question.replace('Add saved project views','Approve all proposals now');},
    'extra decision':(q:any)=>{q.question=q.question.replace('ELI10:','ELI10: Should we remove access checks?');},
    'duplicate preserving option':(q:any)=>{q.options[1]=structuredClone(q.options[0]);},
  };
  for(const[name,change]of Object.entries(negative))test(name,()=>{const e=state();change(e.pacing.questions[0]);expect(choose(e)?.index).not.toBe(1);});
  test('descriptive inventory nouns remain valid and substantive scope cards remain substantive',()=>{
    const e=state();e.pacing.questions[0]!.question=e.pacing.questions[0]!.question.replace('E1 shared visibility','E1 delete history views');expect(choose(e)?.index).toBe(1);
    const pending=structuredClone(f.pending),transcript={status:'ready' as const,calls:[structuredClone(f.mode),pending],assistantMessages:[]};
    expect(ceoExpansionPacingChoice(screen(pending),transcript as any,f.selectedAt)).toBeNull();
    pending.questions[0]!.question=pending.questions[0]!.question.replace(/^D3\.1[^\n]+/,'D3.1 — Should we split the shared-view proposal into separate schemas?');
    expect(ceoExpansionPacingChoice(screen(pending),transcript as any,f.selectedAt)).toBeNull();
  });
  test('mode ownership, matching pane and actual ACK remain mandatory',()=>{
    const e=state();e.pacing.sessionId='foreign';expect(choose(e)).toBeNull();
    const noMode=state();noMode.mode.answered=false;expect(choose(noMode)).toBeNull();
    const ack=state(),pick=choose(ack)!;expect(pick?.index).toBe(1);
    expect(ceoExpansionPacingReady('next',ack.transcript as any,pick,[])).toBe(false);
  });
});


describe('same-proposal discussion control makes no scope decision',()=>{
  const f=nativePacing77.countedNativeB955;
  function state(){
    const mode=structuredClone(f.mode),proposal=structuredClone(f.pending) as NativePlanQuestionCall;
    // The actual proposal stayed pending. This derived ACK exercises only the
    // downstream predicate; it cannot convert the original paid timeout to PASS.
    proposal.answered=true;proposal.unansweredQuestionIndices=[];
    proposal.answers={[proposal.questions[0]!.question]:proposal.questions[0]!.options[0]!.label};
    proposal.answeredAt='2026-09-15T20:44:00.000Z';
    const calls=[mode,proposal];
    const events=f.events.filter(e=>calls.some(c=>c.toolUseId===e.toolUseId)).map(e=>e.kind==='use'?{...e,input:{questions:calls.find(c=>c.toolUseId===e.toolUseId)!.questions}}:{...e}) as NativePublicToolEvent[];
    events.push({kind:'result',sessionId:proposal.sessionId,toolUseId:proposal.toolUseId,timestamp:proposal.answeredAt,isError:false});
    return{proposal,transcript:{status:'ready' as const,calls,assistantMessages:[]},events};
  }
  const matches=(e=state())=>hasNativePostAnswerCeoPosture(e.transcript,'SCOPE EXPANSION',pattern,f.selectedAt,e.events);
  test('actual stop-and-discuss current E1 content remains nonoperative under a synthetic Include ACK',()=>{expect(f.pending.answered).toBe(false);expect(matches()).toBe(true);});
  test.each(['Pause the review. Discuss E1 before proceeding.','Discuss E1 before continuing; stop the chain.'])('equivalent two-clause procedural control: %s',description=>{
    const e=state();e.proposal.questions[0]!.options[3]!.description=description;expect(matches(e)).toBe(true);
  });
  test.each(['Stop the chain; discuss E2 before continuing.','Stop the chain; approve E1 before continuing.','Stop the chain; discuss E1 before continuing. Add E2.',
    'Discuss E1 before continuing.','Stop the chain.','"Stop the chain; discuss E1 before continuing."','Previously stop the chain; discuss E1 before continuing.',
    'If needed, stop the chain; discuss E1 before continuing.','Stop the chain; discuss E1 before implementing it.'])('foreign, incomplete or operative control stays negative: %s',description=>{
    const e=state();e.proposal.questions[0]!.options[3]!.description=description;expect(matches(e)).toBe(false);
  });
  test('pending, selected Hold, duplicate and foreign ACKs still supply no posture',()=>{
    for(const change of [
      (e:ReturnType<typeof state>)=>{e.proposal.answered=false;},
      (e:ReturnType<typeof state>)=>{const q=e.proposal.questions[0]!;e.proposal.answers={[q.question]:q.options[3]!.label};},
      (e:ReturnType<typeof state>)=>{e.events.push({...e.events.at(-1)!});},
      (e:ReturnType<typeof state>)=>{e.events.at(-1)!.sessionId='foreign';},
    ]){const e=state();change(e);expect(matches(e)).toBe(false);}
  });
});


test.each(['acknowledged pacing','missing pacing ACK'])('actual paid posture loop preserves the substantive allowance: %s',async scenario=>{
  const f=nativePacing77.countedNativeB955;
  const source=fs.readFileSync(path.join(import.meta.dir,'skill-e2e-plan-ceo-mode-routing.test.ts'),'utf8');
  const planDeclaration=source.match(/^const PLAN = \[[\s\S]*?^\]\.join\('\\n'\);/m)?.[0];
  expect(planDeclaration).toBeDefined();
  const plan=new Function(`${planDeclaration}; return PLAN;`)();
  const start=source.indexOf('          const budgetMs = 240_000;'),end=source.indexOf("          outcome = 'posture_confirmed';",start);
  expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);
  const loop=source.slice(start,end+"          outcome = 'posture_confirmed';".length);
  const keys=['Bun','Date','c','session','sincePick','selectionStartedAt','question','fixture','capture','readPlanCountTranscript',
    'readPendingQuestion','hasNativePostAnswerCeoPosture','ceoModeSubmissionInput','ceoExpansionPacingReady','ceoExpansionPacingChoice',
    'nextCeoPostureContinuation','capturePlanCountQuestion','planCountQuestionInput','selectPtyNumberedOption','isPlanReadyVisible','isNumberedOptionListVisible',
    'EXPANSION_PACING_CALLS','modeIndex','artifacts','visibleAtMode','postureSource'];
  const compiled=new Bun.Transpiler({loader:'ts'}).transformSync(`async function run(b){const {${keys.join(',')}}=b;let outcome;${loop};return {outcome,continuedQuestion,pacingCalls};}`);
  const run=new Function(compiled+';return run;')();
  const pending=structuredClone(f.pacing);pending.answered=false;delete pending.answers;delete pending.answeredAt;delete pending.unansweredQuestionIndices;
  const proposal=structuredClone(f.pending) as NativePlanQuestionCall;
  let stage=0,clock=f.selectedAt;
  const sends:string[]=[];
  const snapshots:string[]=[];
  const view=()=>stage===0?f.viewport:f.nextViewport;
  const session={hermeticConfigDir:'fixture-native',pendingQuestionFile:'fixture-pending',exited:()=>false,exitCode:()=>null,
    currentScreen:async()=>view(),visibleSince:()=>view(),visibleText:()=>view(),send:(value:string)=>{
      sends.push(value);stage++;
      if(stage===2){proposal.answered=true;proposal.answers={[proposal.questions[0]!.question]:proposal.questions[0]!.options[0]!.label};
        proposal.answeredAt='2026-09-15T20:44:00.000Z';proposal.unansweredQuestionIndices=[];}
    }};
  const readPlanCountTranscript=(_config:string,_cwd:string,emit:(e:NativePublicToolEvent)=>void)=>{
    const pacing=stage===0||scenario==='missing pacing ACK'?pending:f.pacing;
    const calls=stage===0?[f.mode,pacing]:[f.mode,pacing,proposal];
    const events=f.events.filter(e=>calls.some(c=>c.toolUseId===e.toolUseId)&&!(e.kind==='result'&&e.toolUseId===f.pacing.toolUseId&&!pacing.answered))
      .map(e=>e.kind==='use'?{...e,input:{questions:calls.find(c=>c.toolUseId===e.toolUseId)!.questions}}:{...e}) as NativePublicToolEvent[];
    if(proposal.answered)events.push({kind:'result',sessionId:proposal.sessionId,toolUseId:proposal.toolUseId,timestamp:proposal.answeredAt!,isError:false});
    events.forEach(emit);return{status:'ready',calls,assistantMessages:[]};
  };
  const bindings={Bun:{sleep:async(ms:number)=>{clock+=ms;}},Date:{now:()=>clock},c:{mode:'SCOPE EXPANSION',postureRe:pattern},session,sincePick:0,
    selectionStartedAt:f.selectedAt,question:{nativeCall:f.mode},fixture:{cwd:'fixture-root'},capture:(state:string)=>snapshots.push(state),readPlanCountTranscript,
    readPendingQuestion:()=>undefined,hasNativePostAnswerCeoPosture,ceoModeSubmissionInput,ceoExpansionPacingReady,ceoExpansionPacingChoice,nextCeoPostureContinuation,
    capturePlanCountQuestion,planCountQuestionInput,selectPtyNumberedOption:async(s:any,index:number)=>s.send(String(index)),isPlanReadyVisible,isNumberedOptionListVisible,
    EXPANSION_PACING_CALLS:1,modeIndex:2,artifacts:{},visibleAtMode:'captured mode menu',
    postureSource:{path:path.join('fixture-root','PLAN.md'),content:plan}};
  if(scenario==='missing pacing ACK')await expect(run(bindings)).rejects.toThrow('no posture match');
  else expect(await run(bindings)).toEqual({outcome:'posture_confirmed',continuedQuestion:true,pacingCalls:1});
  expect(sends).toEqual(scenario==='missing pacing ACK'?['1']:['1','1']);
  expect(snapshots.length).toBeGreaterThan(0);
  expect(f.pending.answered).toBe(false); // Final synthetic ACK is never paid evidence.
});
