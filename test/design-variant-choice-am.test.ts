import {expect, test} from 'bun:test';
import fixture from './fixtures/design-variant-choice-am.json';
import retry from './fixtures/design-variant-choice-am-retry.json';
import {isDesignCountFirstReview} from './helpers/design-count-review';
import type {AskUserQuestionFingerprint as FP} from './helpers/claude-pty-runner';
type Q=NonNullable<FP['nativeCall']>['questions'][number];
const original=()=>structuredClone(fixture.fingerprint) as unknown as FP;
function edit(change:(q:Q,fp:FP)=>void):FP {
 const fp=original(),c=fp.nativeCall!,q=c.questions[0]!,chosen=q.options.findIndex(o=>o.label===c.answers![q.question]);
 change(q,fp);c.answers={[q.question]:q.options[chosen]!.label};fp.options=q.options.map((o,i)=>({index:i+1,label:o.label}));return fp;
}
test('exact completed primary choice binds the current token contract to existing component variants',()=>expect(isDesignCountFirstReview(original())).toBe(true));
const yes:Array<[string,(q:Q,fp:FP)=>void]>=[
 ['renamed primary',q=>{q.question=q.question.replaceAll('Save','Submit');q.options=q.options.map(o=>({...o,label:o.label.replaceAll('Save','Submit'),description:o.description?.replaceAll('Save','Submit')}));}],
 ['another prescribed color and foreground',q=>{q.question=q.question.replace('#1d4ed8 with white text, about 6.7:1 contrast','#ffcc22 with black text');}],
 ['unqualified action position',q=>{q.question=q.question.replace('single primary action in the header?','single primary action?');}],
 ['one benefit sufficient',q=>{q.options[0]!.description=q.options[0]!.description!.split('\n').slice(1).join('\n');}],
 ['an existing open-gap deferral',q=>{q.options[2]!.description='Leaves a documented DESIGN.md violation in place.';}],
 ['quoted historical note does not cancel current choice',q=>{q.options[0]!.description+=' Prior note: "This amendment is withdrawn."';}],
];
test.each(yes)('%s preserves current owned review',(_,change)=>expect(isDesignCountFirstReview(edit(change))).toBe(true));
const no:Array<[string,(q:Q,fp:FP)=>void]>=[
 ['proposed token contract only',q=>{q.question=q.question.replace('DESIGN.md already says','A proposed example follows. DESIGN.md already says');}],
 ['withdrawn token requirement',q=>{q.question=q.question.replace('This is Design Principle 2:','Correction: this DESIGN.md requirement is withdrawn. This is Design Principle 2:');}],
 ['superseded token contract',q=>{q.question=q.question.replace('This is Design Principle 2:','That token contract is no longer current. This is Design Principle 2:');}],
 ['variant amendment cancelled directly',q=>{q.options[0]!.description+=' Correction: do not use the primary and ghost variants.';}],
 ['variant amendment contradicts its remedy',q=>{q.options[0]!.description+=' The current amendment keeps all four buttons identical.';}],
 ['failed call',(_,f)=>{f.nativeCall!.failed=true;}],
 ['unanswered call',(_,f)=>{f.nativeCall!.answered=false;}],
 ['unbound call',(_,f)=>{f.signature='other:call';}],
 ['missing completion time',(_,f)=>{delete f.nativeCall!.answeredAt;}],
 ['wrong question index',(_,f)=>{f.nativeQuestionIndex=1;}],
 ['unanswered member',(_,f)=>{f.nativeCall!.unansweredQuestionIndices=[0];}],
 ['wrong header identity',q=>{q.header='Issue 2';}],
 ['wrong choice identity',q=>{q.options[0]!.label=q.options[0]!.label.replace('1A','2A');}],
 ['setup framing',q=>{q.header='Routing';}],
 ['source-framed question',q=>{q.question='Historical example:\n'+q.question;}],
 ['historical assessment',q=>{q.question=q.question.replace('ELI10: Right now','ELI10: Previously');}],
 ['conditional assessment',q=>{q.question=q.question.replace('ELI10: Right now','ELI10: If right now');}],
 ['quoted assessment',q=>{q.question=q.question.replace('ELI10:','> ELI10:');}],
 ['negated equality',q=>{q.question=q.question.replace('all look identical','do not look identical');}],
 ['archived-only equality',q=>{q.question=q.question.replace('all look identical.','all look identical only in an archived screenshot.');}],
 ['absent token contract',q=>{q.question=q.question.replace('DESIGN.md already says','Archived notes say');}],
 ['wrong primary contract',q=>{q.question=q.question.replace('says Save is','says Export is');}],
 ['no fill contract',q=>{q.question=q.question.replace('only filled button','outlined button');}],
 ['no foreground contract',q=>{q.question=q.question.replace('with white text','with unknown text');}],
 ['no ghost contract',q=>{q.question=q.question.replace('neutral ghost buttons','also filled buttons');}],
 ['quoted token contract',q=>{q.question=q.question.replace('DESIGN.md already says','"DESIGN.md already says').replace('neutral ghost buttons.','neutral ghost buttons."');}],
 ['conditional token contract',q=>{q.question=q.question.replace('DESIGN.md already says','If DESIGN.md already says');}],
 ['resolved current gap',q=>{q.question+='\nCorrection: the gap is already resolved.';}],
 ['wrong proposed primary',q=>{q.options[0]!.label=q.options[0]!.label.replace('Filled Save','Filled Reset');}],
 ['wrong proposed ghost role',q=>{q.options[0]!.label=q.options[0]!.label.replace('ghost others','filled others');}],
 ['no variant authority',q=>{q.options[0]!.description=q.options[0]!.description!.replace('from DESIGN.md','from an archived example');}],
 ['no variant amendment',q=>{q.options[0]!.description=q.options[0]!.description!.replace('Uses the existing','Mentions the existing');}],
 ['quoted variant amendment',q=>{q.options[0]!.description=q.options[0]!.description!.replace('✅ Uses','> ✅ Uses');}],
 ['conditional variant amendment',q=>{q.options[0]!.description='If approved later:\n'+q.options[0]!.description;}],
 ['conditional benefit prefix',q=>{q.options[0]!.description=q.options[0]!.description!.replace('✅ Save reads','✅ If Save reads');}],
 ['historical variant amendment',q=>{q.options[0]!.description+=' This is a historical example, not the current amendment.';}],
 ['withdrawn amendment',q=>{q.options[0]!.description+=' This amendment is withdrawn.';}],
 ['cancelled style',q=>{q.options[0]!.description+=' Correction: do not apply these styles.';}],
 ['no opposed choice',q=>{q.options[2]!.label='1C Export preferences';}],
 ['deferral no longer retains violation',q=>{q.options[2]!.description=q.options[2]!.description!.replace('Violates DESIGN.md','Matches DESIGN.md');}],
 ['historical deferral',q=>{q.options[2]!.description='Historical source excerpt:\n'+q.options[2]!.description;}],
 ['conditional deferral',q=>{q.options[2]!.description='If accepted later:\n'+q.options[2]!.description;}],
 ['closed deferral',q=>{q.options[2]!.description+=' Correction: the violation is now closed.';}],
];
test.each(no)('%s is not current completed review evidence',(_,change)=>expect(isDesignCountFirstReview(edit(change))).toBe(false));

function retryEdit(change:(q:Q,fp:FP)=>void):FP {
 const fp=structuredClone(retry.fingerprint) as unknown as FP,c=fp.nativeCall!,q=c.questions[0]!;
 const chosen=q.options.findIndex(o=>o.label===c.answers![q.question]);
 change(q,fp);c.answers={[q.question]:q.options[chosen]!.label};
 fp.options=q.options.map((o,i)=>({index:i+1,label:o.label}));return fp;
}
test('retry first decision supplies concrete tokens in the offered label and DESIGN.md authority in its description',()=>{
 expect(isDesignCountFirstReview(retryEdit(()=>{}))).toBe(true);
 expect(retry.provenance.historicalOutcome).toBe('no_review_questions');
});
test('current labelled token choice permits any offered alternate and harmless historical quotes',()=>{
 for(const index of [0,1,2]){
  const fp=retryEdit(q=>{q.question+='\nArchived note: "This requirement was withdrawn."';});
  const c=fp.nativeCall!,q=c.questions[0]!;c.answers={[q.question]:q.options[index]!.label};
  expect(isDesignCountFirstReview(fp)).toBe(true);
 }
 expect(isDesignCountFirstReview(retryEdit(q=>{
  q.question=q.question.replaceAll('Save','Submit');
  q.options=q.options.map(o=>({...o,label:o.label.replaceAll('Save','Submit'),description:o.description?.replaceAll('Save','Submit')}));
 }))).toBe(true);
});
const retryNo:Array<[string,(q:Q,fp:FP)=>void]>=[
 ['wrong offered secondary count',q=>{q.options[0]!.description=q.options[0]!.description!.replace('three neutral ghosts','two neutral ghosts');}],
 ['wrong stated secondary count',q=>{q.question=q.question.replace('other three','other five');}],
 ['consistent but wrong secondary counts',q=>{q.question=q.question.replace('other three','other five');q.options[0]!.description=q.options[0]!.description!.replace('three neutral ghosts','five neutral ghosts');}],
 ['token authority withdrawn',q=>{q.options[0]!.description+=' Correction: these tokens do not match DESIGN.md.';}],
 ['unanswered',(_,f)=>{f.nativeCall!.answered=false;}],
 ['failed',(_,f)=>{f.nativeCall!.failed=true;}],
 ['wrong owner',(_,f)=>{f.signature='foreign:use';}],
 ['missing completion time',(_,f)=>{delete f.nativeCall!.answeredAt;}],
 ['unanswered member',(_,f)=>{f.nativeCall!.unansweredQuestionIndices=[0];}],
 ['wrong issue',q=>{q.header='Issue 2';}],
 ['wrong option issue',q=>{q.options[0]!.label=q.options[0]!.label.replace('1A','2A');}],
 ['non-design pass',q=>{q.question=q.question.replace('Visual Hierarchy','Routing');}],
 ['invalid pass',q=>{q.question=q.question.replace('Pass 1,','Pass 9,');}],
 ['source assessment',q=>{q.question=q.question.replace('\nELI10:','\nSource excerpt:\nELI10:');}],
 ['proposed contract',q=>{q.question=q.question.replace('DESIGN.md already says','A proposed example follows. DESIGN.md already says');}],
 ['withdrawn contract',q=>{q.question+=' Correction: this DESIGN.md requirement is withdrawn.';}],
 ['superseded contract',q=>{q.question+=' That token contract is no longer current.';}],
 ['wrong contract control',q=>{q.question=q.question.replace('says Save is','says Reset is');}],
 ['not an exclusive primary',q=>{q.question=q.question.replace('only filled primary','outlined');}],
 ['not ghost secondaries',q=>{q.question=q.question.replace('neutral ghost buttons','filled buttons');}],
 ['wrong labelled control',q=>{q.options[0]!.label=q.options[0]!.label.replace('Save filled','Reset filled');}],
 ['missing concrete color',q=>{q.options[0]!.label=q.options[0]!.label.replace('#1d4ed8','blue');}],
 ['missing foreground',q=>{q.options[0]!.label=q.options[0]!.label.replace('/white','');}],
 ['missing style authority',q=>{q.options[0]!.description=q.options[0]!.description!.replace('Matches DESIGN.md exactly','Matches a historical example');}],
 ['quoted remedy',q=>{q.options[0]!.description='> '+q.options[0]!.description;}],
 ['conditional remedy',q=>{q.options[0]!.description='If approved: '+q.options[0]!.description;}],
 ['cancelled variants',q=>{q.options[0]!.description+=' Correction: do not use the primary and ghost variants.';}],
 ['contradictory remedy',q=>{q.options[0]!.description+=' The current amendment keeps all four buttons identical.';}],
 ['resolved deferral',q=>{q.options[2]!.description+=' This violation is now resolved.';}],
 ['no remaining violation',q=>{q.options[2]!.description=q.options[2]!.description!.replace('Documented DESIGN.md violation ships','No documented violation ships');}],
];
test.each(retryNo)('retry %s is not positive review evidence',(_,change)=>expect(isDesignCountFirstReview(retryEdit(change))).toBe(false));
