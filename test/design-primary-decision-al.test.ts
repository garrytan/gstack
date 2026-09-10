import {describe, expect, test} from 'bun:test';
import fixture from './fixtures/design-primary-decision-al.json';
import {isDesignCountFirstReview} from './helpers/design-count-review';
import type {AskUserQuestionFingerprint} from './helpers/claude-pty-runner';
type FP=AskUserQuestionFingerprint;
type Q=NonNullable<FP['nativeCall']>['questions'][number];
const original=()=>structuredClone(fixture.fingerprint) as unknown as FP;
function edit(change:(q:Q,fp:FP)=>void):FP {
 const fp=original(),c=fp.nativeCall!,q=c.questions[0]!,chosen=q.options.findIndex(o=>o.label===c.answers![q.question]);
 change(q,fp);c.answers={[q.question]:q.options[chosen]!.label};
 fp.options=q.options.map((o,i)=>({index:i+1,label:o.label}));return fp;
}
describe('answered primary-action decision with compact style choices',()=>{
 test('recognizes the exact current native issue independently of its interrogative title',()=>{
  expect(isDesignCountFirstReview(original())).toBe(true);
 });
 const positive:Array<[string,(q:Q,fp:FP)=>void]>=[
  ['different named primary',q=>{q.question=q.question.replaceAll('Save','Submit');q.options=q.options.map(o=>({...o,label:o.label.replaceAll('Save','Submit'),description:o.description?.replaceAll('Save','Submit')}));}],
  ['explicit fill role and foreground',q=>{q.options[0]!.description=q.options[0]!.description!.replace('filled #1d4ed8/white','filled primary #234abc with black text').replace('neutral ghost.','neutral ghost buttons.');}],
  ['actions without header qualification',q=>{q.question=q.question.replace('the header actions','actions');}],
  ['imperative title with the compact style',q=>{q.question=q.question.replace('How should the header actions establish that Save is the primary action','Make Save the visible primary action');}],
  ['interrogative title with expanded style',q=>{q.options[0]!.description='Apply DESIGN.md tokens: Save #1d4ed8 filled with white text; Reset, Cancel, Export neutral ghost.';}],
  ['existing explicit open-gap deferral',q=>{q.options[2]!.description='Decline the fix; gap stays documented and lowers the score.';}],
  ['numeric control count in deferral',q=>{q.options[2]!.description=q.options[2]!.description!.replace('four','4');}],
  ['quoted historical note does not withdraw current amendment',q=>{q.options[0]!.description+=' Prior note: "This amendment is withdrawn."';}],
 ];
 test.each(positive)('%s retains the same owned decision',(_,change)=>expect(isDesignCountFirstReview(edit(change))).toBe(true));
 const negative:Array<[string,(q:Q,fp:FP)=>void]>=[
  ['equality qualified as archived only',q=>{q.question=q.question.replace('look identical.','look identical only in the archived screenshot. Today they are distinct.');}],
  ['amendment relabelled as historical',q=>{q.options[0]!.description+=' This is a historical example, not the current amendment.';}],
  ['amendment explicitly withdrawn',q=>{q.options[0]!.description+=' This amendment is withdrawn.';}],
  ['deferral relabelled as historical',q=>{q.options[2]!.description+=' This is a historical example, not the current deferral.';}],
  ['failed native call',(_,fp)=>{fp.nativeCall!.failed=true;}],
  ['unanswered native call',(_,fp)=>{fp.nativeCall!.answered=false;}],
  ['unbound signature',(_,fp)=>{fp.signature='other:call';}],
  ['missing completion time',(_,fp)=>{delete fp.nativeCall!.answeredAt;}],
  ['competing issue number',q=>{q.header='Issue 2';}],
  ['competing option identity',q=>{q.options[0]!.label='2A Primary + ghost';}],
  ['source-framed question',q=>{q.question='Historical example:\n'+q.question;}],
  ['historical premise',q=>{q.question=q.question.replace('ELI10: Right now','ELI10: Previously');}],
  ['quoted premise',q=>{q.question=q.question.replace('ELI10: Right now','> ELI10: Right now');}],
  ['conditional premise',q=>{q.question=q.question.replace('ELI10: Right now','ELI10: If right now');}],
  ['negated equality',q=>{q.question=q.question.replace('look identical','do not look identical');}],
  ['competing premise',q=>{q.question+='\nELI10: No current hierarchy gap exists.';}],
  ['resolved finding',q=>{q.question+='\nCorrection: this gap is already resolved.';}],
  ['other primary in remedy',q=>{q.options[0]!.description=q.options[0]!.description!.replace('Save filled','Reset filled');}],
  ['no prescribed fill',q=>{q.options[0]!.description=q.options[0]!.description!.replace('filled','outlined');}],
  ['no prescribed foreground',q=>{q.options[0]!.description=q.options[0]!.description!.replace('/white','/unknown');}],
  ['primary also a ghost',q=>{q.options[0]!.description=q.options[0]!.description!.replace('; Reset','; Save, Reset');}],
  ['quoted amendment',q=>{q.options[0]!.description='> '+q.options[0]!.description;}],
  ['conditional amendment',q=>{q.options[0]!.description='If approved later, '+q.options[0]!.description;}],
  ['negated amendment',q=>{q.options[0]!.description='Do not apply: '+q.options[0]!.description;}],
  ['withdrawn amendment',q=>{q.options[0]!.description+=' Correction: do not apply these tokens.';}],
  ['wrong design authority',q=>{q.options[0]!.description=q.options[0]!.description!.replace('Exact DESIGN.md.','Archived example.');}],
  ['no opposed choice',q=>{q.options[2]!.label='1C Export preferences';}],
  ['defer does not retain equality',q=>{q.options[2]!.description=q.options[2]!.description!.replace('identical','distinct');}],
  ['historical deferral',q=>{q.options[2]!.description='Historical source excerpt: '+q.options[2]!.description;}],
  ['conditional deferral',q=>{q.options[2]!.description='If accepted later: '+q.options[2]!.description;}],
  ['deferral closes gap',q=>{q.options[2]!.description+=' Correction: the violation is now closed.';}],
 ];
 test.each(negative)('%s is not completed current-review evidence',(_,change)=>expect(isDesignCountFirstReview(edit(change))).toBe(false));
});
