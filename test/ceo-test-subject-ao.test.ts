import { expect, test } from 'bun:test';
import { ceoFirstReviewAUQ, ceoStep0Boundary, planCountQuestionPhase, type AskUserQuestionFingerprint } from './helpers/claude-pty-runner';
import { E2E_TOUCHFILES } from './helpers/touchfiles-data';
import fixture from './fixtures/ceo-test-subject-ao.json';
const calls=fixture.fingerprints as AskUserQuestionFingerprint[];
const actual=calls[1]!;
function change(edit:(q:any, call:any, fp:any)=>void) {
  const fp=structuredClone(actual),call=fp.nativeCall!,q=call.questions[0]!;
  const selected=q.options.findIndex(o=>o.label===call.answers?.[q.question]);
  edit(q,call,fp);
  call.answers={[q.question]:q.options[selected]?.label??''};
  fp.options=q.options.map((o,i)=>({index:i+1,label:o.label}));
  return fp;
}
test('the completed affected-Test question starts review from its current ELI10 assertion gap',()=>{
  expect(calls.map(ceoFirstReviewAUQ)).toEqual([false,true,false]);
  let review=false;
  expect(calls.map(fp=>{const phase=planCountQuestionPhase(fp,review,ceoStep0Boundary,ceoFirstReviewAUQ);review=phase.reviewStarted;return phase.preReview;})).toEqual([true,false,false]);
});
test('structural Test identity permits ordinary question and separator variations',()=>{
  for(const title of [
    'D4 — Test 1: choose its assertion?',
    'D4 — Test 1 — which assertion belongs here?',
    'D4 - Test 1 (successful charge): what must this test verify?',
    'd4 — Test 1 (successful charge): assertion choice?',
    'D4 — Test 1 what should the expected result be?',
  ]) expect(ceoFirstReviewAUQ(change(q=>{q.question=q.question.replace(/^[^\n]+/,title);}))).toBe(true);
  expect(ceoFirstReviewAUQ(change(q=>{
    q.question=q.question.replace(/^D4/,'D17').replace(/\b4([A-C])\b/g,'17$1');
    q.options=q.options.map((o:any)=>({...o,label:o.label.replace(/^4/,'17')}));
  }))).toBe(true);
});
test('test headers, competing finding IDs and uniform foreign decision choices cannot borrow the assessment',()=>{
  for(const header of ['Test 2','Finding 1','Issue 1','Approach']) expect(ceoFirstReviewAUQ(change(q=>{q.header=header;}))).toBe(false);
  expect(ceoFirstReviewAUQ(change(q=>{q.question=q.question.replace('Test 1 (successful charge)','Test 1 (Finding 2)');}))).toBe(false);
  expect(ceoFirstReviewAUQ(change(q=>{
    q.question=q.question.replace(/\b4([A-C])\b/g,'8$1');q.options=q.options.map((o:any)=>({...o,label:o.label.replace(/^4/,'8')}));
  }))).toBe(false);
});
test('explicit Test and decision identifiers must be anchored integers with one test owner',()=>{
  for(const header of ['Test 0','Test 01','Test 1.2']) expect(ceoFirstReviewAUQ(change(q=>{q.header=header;}))).toBe(false);
  for(const decision of ['D0','D04']) expect(ceoFirstReviewAUQ(change(q=>{q.question=q.question.replace(/^D4/,decision);}))).toBe(false);
  expect(ceoFirstReviewAUQ(change(q=>{q.question=q.question.replace('Test 1 (successful charge)','Test 1 (Test 2)');}))).toBe(false);
  for(const header of ['Receipt assertion','Test contract','Test 1: receipt assertion']) expect(ceoFirstReviewAUQ(change(q=>{q.header=header;}))).toBe(true);
  expect(ceoFirstReviewAUQ(change(q=>{q.question=q.question.replace('Test 1 (successful charge)','Test 1 ("Test 2" is an archive label)');}))).toBe(true);
});
test('the owned weak assertion must remain current and outside quoted or conditional source frames',()=>{
  for(const intro of ['Source excerpt: ','Earlier review assessment: ','If approved later, ']) expect(ceoFirstReviewAUQ(change(q=>{
    q.question=q.question.replace('The planned test only checks',intro+'The planned test only checks');
  }))).toBe(false);
  for(const intro of ['Source excerpt follows. ','Earlier review assessment follows. ','If approved later. ']) expect(ceoFirstReviewAUQ(change(q=>{
    q.question=q.question.replace('The planned test only checks',intro+'The planned test only checks');
  }))).toBe(false);
  expect(ceoFirstReviewAUQ(change(q=>{q.question=q.question.replace('The planned test only checks','The planned test no longer only checks');}))).toBe(false);
  expect(ceoFirstReviewAUQ(change(q=>{q.question=q.question.replace('The planned test only checks that the receipt is truthy.','"The planned test only checks that the receipt is truthy."');}))).toBe(false);
});
test('direct current withdrawals stay effective while a quoted historical note stays harmless',()=>{
  for(const text of ['This finding is withdrawn.','This assessment is "closed".','Correction: this explanation is not current.']) expect(ceoFirstReviewAUQ(change(q=>{q.question+='\n'+text;}))).toBe(false);
  expect(ceoFirstReviewAUQ(change(q=>{q.question=q.question.replace('\nELI10:','\nArchive note: "Source: this finding is withdrawn."\nELI10:');}))).toBe(true);
});
test('the complete current amendment belongs to an offered option',()=>{
  for(const prefix of ['Source excerpt: ','Historical example: ','If approved later: ']) expect(ceoFirstReviewAUQ(change(q=>{
    for(const o of q.options)o.description=prefix+o.description;
  }))).toBe(false);
  for(const text of [' This amendment is withdrawn.',' This amendment is "closed".',' This remedy is a historical example, not the current option.']) expect(ceoFirstReviewAUQ(change(q=>{
    for(const o of q.options)o.description+=text;
  }))).toBe(false);
  expect(ceoFirstReviewAUQ(change(q=>{q.options[0].label='4A: Keep the truthy assertion (recommended)';}))).toBe(false);
});
test('native completion, exact answer, index and menu identity remain required',()=>{
  for(const edit of [
    (_q:any,c:any)=>{c.answered=false;},(_q:any,c:any)=>{c.failed=true;},
    (_q:any,c:any)=>{delete c.answeredAt;},(_q:any,c:any)=>{c.unansweredQuestionIndices=[0];},
    (_q:any,_c:any,fp:any)=>{fp.signature='foreign:tool';},
    (_q:any,_c:any,fp:any)=>{fp.nativeQuestionIndex=1;},(q:any)=>{q.multiSelect=true;},
  ]) expect(ceoFirstReviewAUQ(change(edit))).toBe(false);
  const wrongAnswer=change(()=>{});wrongAnswer.nativeCall!.answers={};expect(ceoFirstReviewAUQ(wrongAnswer)).toBe(false);
  const wrongMenu=change(()=>{});wrongMenu.options[0]!.label='Foreign menu';expect(ceoFirstReviewAUQ(wrongMenu)).toBe(false);
});
test('new inputs belong only to the dense CEO finding owner',()=>{
  for(const file of ['test/ceo-test-subject-ao.test.ts','test/fixtures/ceo-test-subject-ao.json']) expect(Object.entries(E2E_TOUCHFILES).filter(([,paths])=>paths.includes(file)).map(([owner])=>owner)).toEqual(['plan-ceo-finding-count']);
  for(const paths of Object.values(E2E_TOUCHFILES))for(let i=0;i<paths.length;i++)expect(Object.hasOwn(paths,i)&&typeof paths[i]==='string').toBe(true);
});
