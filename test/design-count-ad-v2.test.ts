import {expect,test} from 'bun:test';
import captured from './fixtures/design-count-ad-v2.json';
import {planCountQuestionPhase,designStep0Boundary,nativePlanCallFingerprint} from './helpers/claude-pty-runner';
import {isDesignCountFirstReview,isDesignCountSetup} from './helpers/design-count-review';
test('actual completed ordinary design Issue starts review at the finding, without counting later Eng work',()=>{
 expect(isDesignCountFirstReview(captured.firstFinding)).toBe(true);
 expect(planCountQuestionPhase(captured.firstFinding,false,designStep0Boundary,isDesignCountFirstReview,isDesignCountSetup)).toMatchObject({preReview:false,reviewStarted:true});
});

test('ordinary design finding retains completed native identity and unresolved alternatives',()=>{
 for(const update of [
  (f:any)=>{f.nativeCall.answered=false;},(f:any)=>{f.nativeCall.failed=true;},
  (f:any)=>{f.signature='foreign';},(f:any)=>{f.nativeCall.unansweredQuestionIndices=[0];},
  (f:any)=>{f.nativeCall.answers={};},(f:any)=>{f.nativeCall.questions[0].header='Issue 2';},
  (f:any)=>{f.nativeCall.questions[0].multiSelect=true;},
  (f:any)=>{f.nativeCall.questions[0].question='Example: '+f.nativeCall.questions[0].question;},
  (f:any)=>{f.options.reverse();},
 ]){const f=structuredClone(captured.firstFinding);update(f);expect(isDesignCountFirstReview(f)).toBe(false);}
 const f=structuredClone(captured.firstFinding);const q=f.nativeCall.questions[0]!;const old=q.question;
 q.question=q.question.replace('D4 — ','D38: ');f.nativeCall.answers={[q.question]:f.nativeCall.answers[old]!};
 expect(isDesignCountFirstReview(f)).toBe(true);
});

test('optional gap tags do not decide the finding boundary',()=>{
 for(const replacement of [' (Visual Hierarchy)', '']){const f=structuredClone(captured.firstFinding),q=f.nativeCall.questions[0]!,old=q.question;q.question=q.question.replace(' (G1, Visual Hierarchy)',replacement);f.nativeCall.answers={[q.question]:f.nativeCall.answers[old]!};expect(isDesignCountFirstReview(f)).toBe(true);}
});
import {E2E_TOUCHFILES,selectTests} from './helpers/touchfiles';
test('the retained Design calls select the native cadence workflow',()=>{
 for(const file of ['test/design-count-ad-v2.test.ts','test/fixtures/design-count-ad-v2.json'])
  expect(selectTests([file],E2E_TOUCHFILES,[]).selected).toEqual(['plan-design-finding-count']);
});

test('an Issue label for participation or next-review routing is still setup',()=>{
 for(const [title,labels,description] of [
  ['D4 — Issue 1: how should we address optional outside-review participation?', ['Run outside voices','Defer outside voices'],'Applies independent review to the plan.'],
  ['D4 — Issue 1: how should we resolve which review runs next?', ['Run the engineering review','Defer next reviews'],'Closes the required engineering review gate.'],
 ] as const){const c=structuredClone(captured.firstFinding.nativeCall),q=c.questions[0]!;q.question=title;q.options=labels.map((label,i)=>({label:`1${i?'B':'A'}) ${label}`,description}));c.answers={[title]:q.options[0]!.label};expect(isDesignCountFirstReview(nativePlanCallFingerprint(c,0,true))).toBe(false);}
});
