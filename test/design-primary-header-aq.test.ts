import {describe,expect,test} from 'bun:test';
import {nativePlanCallFingerprint,planCountQuestionPhase,designStep0Boundary} from './helpers/claude-pty-runner';
import {isDesignCountFirstReview,isDesignCountSetup,isDesignCompletionHandoff} from './helpers/design-count-review';
import {isDesignArtifactGeneration} from './helpers/design-artifact-question';
import type {NativePlanQuestionCall} from './helpers/plan-count-transcript';
import actual from './fixtures/design-primary-header-aq.json';

const calls=()=>structuredClone(actual.calls) as NativePlanQuestionCall[];
const first=()=>calls()[2]!;
const fp=(call=first())=>nativePlanCallFingerprint(call,244227,true);
const classify=(call=first())=>isDesignCountFirstReview(fp(call));
function mutate(fn:(call:NativePlanQuestionCall)=>void){const c=first();fn(c);return c;}
function text(change:(s:string)=>string){return mutate(c=>{const q=c.questions[0]!,answer=c.answers![q.question]!;q.question=change(q.question);c.answers={[q.question]:answer};});}

describe('AQ current primary-header amendment starts Design review',()=>{
 test('exact owned four-call prefix starts on Issue 1 with all question bytes unchanged',()=>{
  let started=false;const phases=calls().map(c=>{const p=planCountQuestionPhase(fp(c),started,designStep0Boundary,isDesignCountFirstReview,isDesignCountSetup,isDesignCompletionHandoff,isDesignArtifactGeneration);started=p.reviewStarted;return p;});
  expect(phases.map(p=>p.preReview)).toEqual([true,true,false,false]);
  expect(phases.every(p=>!p.administrative)).toBe(true);
  expect(classify()).toBe(true);expect(isDesignCountSetup(fp())).toBe(false);expect(isDesignCompletionHandoff(fp())).toBe(false);
 });
 test('consistent control, palette, decision and issue identities can vary',()=>{
  const c=first(),q=c.questions[0]!;q.question=q.question.replaceAll('Save','Submit').replaceAll('#1d4ed8','#123abc').replace('D3 — Issue 1:','D9 — Issue 4:').replaceAll('1A','4A').replaceAll('1B','4B').replaceAll('1C','4C');q.header='Issue 4';
  for(const o of q.options){o.label=o.label.replaceAll('Save','Submit').replace(/^1/,'4');o.description=o.description?.replaceAll('Save','Submit').replaceAll('#1d4ed8','#123abc');}
  q.options.reverse();for(const o of q.options){c.answers={[q.question]:o.label};expect(classify(c)).toBe(true);}
 });
 test('only and single primary-header descriptions retain the same current action',()=>{
  for(const title of ['make Save the single visually primary header action?','make Save the only primary header action?','make Save the single primary header action?','Make Save the only visually primary action in the header?'])expect(classify(text(s=>s.replace('make Save the only visually primary header action?',title)))).toBe(true);
 });
 test('source, historical, conditional and noncurrent assessments cannot start review',()=>{
  for(const prefix of ['Source excerpt: ','Earlier review assessment: ','If approved, ','For historical context, ','Hypothetical example: '])expect(classify(text(s=>s.replace('ELI10: ','ELI10: '+prefix)))).toBe(false);
  for(const heading of ['Source excerpt:','Earlier review assessment:','If approved later:'])expect(classify(text(s=>s.replace('ELI10:',heading+'\nELI10:')))).toBe(false);
  for(const suffix of [' This finding is withdrawn.',' This amendment is "closed".',' This remedy is a historical example, not the current option.',' Correction: this finding is not current.',' This issue is superseded.',' This issue is \"superseded\".'])expect(classify(text(s=>s+suffix))).toBe(false);
 });
 test('current context and assessment owners must be unique',()=>{
  for(const insertion of ['Project/branch/task: other, another project with an archived design.','ELI10: Right now Save, Reset, Cancel and Export look identical.'])expect(classify(text(s=>s.replace('ELI10:',insertion+'\nELI10:')))).toBe(false);
  expect(classify(text(s=>s.replace(/^Project\/branch\/task:.*\n/m,'')))).toBe(false);
  for(const frame of ['If approved,','Provided approval,','Assuming approval,','Earlier review assessment:'])expect(classify(text(s=>s.replace('Project/branch/task: main','Project/branch/task: '+frame+' main')))).toBe(false);
 });
 test('native identity, completion, selected answer and original displayed options stay required',()=>{
  for(const change of [
   (c:NativePlanQuestionCall)=>{c.answered=false;},(c:NativePlanQuestionCall)=>{c.failed=true;},(c:NativePlanQuestionCall)=>{delete c.failed;},
   (c:NativePlanQuestionCall)=>{delete c.answeredAt;},(c:NativePlanQuestionCall)=>{c.answeredAt='invalid';},(c:NativePlanQuestionCall)=>{c.sessionId='';},(c:NativePlanQuestionCall)=>{c.toolUseId='';},
   (c:NativePlanQuestionCall)=>{c.answers={};},(c:NativePlanQuestionCall)=>{c.answers={[c.questions[0]!.question]:'unoffered'};},
   (c:NativePlanQuestionCall)=>{c.unansweredQuestionIndices=[0];},(c:NativePlanQuestionCall)=>{delete c.unansweredQuestionIndices;},
   (c:NativePlanQuestionCall)=>{c.questions[0]!.multiSelect=true;},(c:NativePlanQuestionCall)=>{c.questions.push(structuredClone(c.questions[0]!));}
  ])expect(classify(mutate(change))).toBe(false);
  for(const f of [{...fp(),signature:'foreign:call'},{...fp(),nativeQuestionIndex:1},{...fp(),nativeCall:undefined},{...fp(),options:[...fp().options].reverse()}])expect(isDesignCountFirstReview(f)).toBe(false);
 });
 test('explicit issue identities and setup-only action labels cannot grant review',()=>{
  for(const c of [mutate(c=>{c.questions[0]!.header='Issue 2';}),mutate(c=>{c.questions[0]!.header='Routing';}),text(s=>s.replace('Issue 1:','Issue 01:')),text(s=>s.replace('D3 —','D03 —')),text(s=>s.replace('make Save the only visually primary header action?','start reviewing the header?')),mutate(c=>{c.questions[0]!.options[0]!.label='Start review';c.answers={[c.questions[0]!.question]:'Start review'};})])expect(classify(c)).toBe(false);
 });
 test('the original gap, exact named remedy, and an opposed retained violation are all required',()=>{
  expect(classify(text(s=>s.replace('look identical','no longer look identical')))).toBe(false);
  for(const body of ['Source excerpt: Apply DESIGN.md: Save #1d4ed8 filled white text; Reset, Cancel, Export neutral ghost buttons.','If approved, Apply DESIGN.md: Save #1d4ed8 filled white text; Reset, Cancel, Export neutral ghost buttons.','Apply DESIGN.md: Publish #1d4ed8 filled white text; Reset, Cancel, Export neutral ghost buttons.','Apply DESIGN.md: Save filled; Reset, Cancel, Export ghost.'])expect(classify(mutate(c=>{c.questions[0]!.options[0]!.description=body;}))).toBe(false);
  for(const suffix of [' This amendment is withdrawn.',' This amendment is "closed".',' This remedy is a historical example, not the current option.',' Do not apply these tokens.',' This option is superseded.',' This option is \"superseded\".'])expect(classify(mutate(c=>{c.questions[0]!.options[0]!.description+=suffix;}))).toBe(false);
  for(const body of ['The design is accepted.','Source excerpt: Decline the fix; document the violation as accepted.','If approved, decline the fix; document the violation as accepted.','Decline the fix; document the violation as accepted. This deferral is withdrawn.','Decline the fix; document the violation as accepted. This deferral is superseded.','Decline the fix; document the violation as accepted. This deferral is \"superseded\".'])expect(classify(mutate(c=>{c.questions[0]!.options[2]!.description=body;}))).toBe(false);
  expect(classify(mutate(c=>{c.questions[0]!.options[2]!.label='Proceed with review';}))).toBe(false);
 });
 test('a wholly quoted archival note does not withdraw the current owned decision',()=>{
  expect(classify(text(s=>s+'\n"Earlier review assessment: This finding is withdrawn."'))).toBe(true);
 });
});
