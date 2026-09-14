import { expect, test } from 'bun:test';
import { ceoFirstReviewAUQ, nativePlanCallFingerprint } from './helpers/claude-pty-runner';
import fixture from './fixtures/ceo-sequence-aq.json';
import { E2E_TOUCHFILES } from './helpers/touchfiles-data';

const accepts = (call: any) => ceoFirstReviewAUQ(nativePlanCallFingerprint(call, 0, true));
function changed(edit: (q: any, call: any) => void) {
  const call = structuredClone(fixture.calls[2]!), q = call.questions[0]!;
  const selected = q.options.findIndex(o => o.label === call.answers[q.question]);
  edit(q, call);
  call.answers = { [q.question]: q.options[selected]?.label ?? '' };
  return call;
}
test('exact completed prefix keeps setup and approach before the current sequence finding', () => {
  expect(fixture.calls.map(accepts)).toEqual([false, false, true]);
});
test('equivalent decision identities and explicit current sequencing gaps retain the finding', () => {
  for (const gap of [
    'the plan never defines the sequence or the transaction boundary.',
    'this plan does not specify the order and the commit point.',
  ]) expect(accepts(changed(q => {
    q.question = q.question.replace(/^Project\/branch\/task:.*$/m, 'Project/branch/task: main, PLAN.md; '+gap);
  }))).toBe(true);
  expect(accepts(changed(q => { q.question=q.question.replace(/^D2 —/, 'd19 -');q.header='d19 Order'; }))).toBe(true);
});
test('native completion, matching identities and selected offered answer remain mandatory', () => {
  for (const edit of [
    (_q:any,c:any)=>{c.answered=false;}, (_q:any,c:any)=>{c.failed=true;},
    (_q:any,c:any)=>{c.unansweredQuestionIndices=[0];}, (_q:any,c:any)=>{c.answeredAt='invalid';},
    (q:any)=>{q.header='D3 Sequence';}, (q:any)=>{q.header='D2 Approach';},
    (q:any)=>{q.multiSelect=true;}, (q:any)=>{q.question=q.question.replace('Recommendation: A','Recommendation: Z');},
    (q:any)=>{q.options[1].label=q.options[1].label.replace('B)','A)');},
  ]) expect(accepts(changed(edit))).toBe(false);
  const noAnswer=changed(()=>{});noAnswer.answers={};expect(accepts(noAnswer)).toBe(false);
  const fp=nativePlanCallFingerprint(changed(()=>{}),0,true);
  expect(ceoFirstReviewAUQ({...fp,signature:'foreign:call'})).toBe(false);
  expect(ceoFirstReviewAUQ({...fp,nativeCall:undefined})).toBe(false);
  expect(ceoFirstReviewAUQ({...fp,nativeQuestionIndex:1})).toBe(false);
  expect(ceoFirstReviewAUQ({...fp,options:fp.options.map((o,i)=>i===0?{...o,label:'Foreign choice'}:o)})).toBe(false);
});
test('current metadata cannot be replaced by source, history, conditional or duplicate ownership', () => {
  for(const prefix of ['Source excerpt: ', 'Earlier review assessment: ', 'If approved, ', 'For historical context, ']) {
    expect(accepts(changed(q=>{q.question=q.question.replace('Project/branch/task: ','Project/branch/task: '+prefix);}))).toBe(false);
    expect(accepts(changed(q=>{q.question=q.question.replace('ELI10: ','ELI10: '+prefix);}))).toBe(false);
  }
  for(const edit of [
    (q:any)=>{q.question=q.question.replace('the plan lists','the previous plan lists');},
    (q:any)=>{q.question=q.question.replace('but never fixes','and now defines');},
    (q:any)=>{q.question=q.question.replace(/^Project\/branch\/task:.*$/m,'Project/branch/task: main, PLAN.md; no current sequencing gap.');},
    (q:any)=>{q.question=q.question.replace('\nELI10:','\nSource:\nELI10:');},
    (q:any)=>{q.question=q.question.replace('\nELI10:','\nProject/branch/task: another plan\nELI10:');},
  ]) expect(accepts(changed(edit))).toBe(false);
});
test('current withdrawals and a missing commit-first remedy or opposed risk remain setup', () => {
  for(const status of ['This finding is withdrawn.','This finding is "closed".','There is no current gap.',
    'The gap is resolved.', 'This sequence has been fixed.', 'This transaction boundary is "defined".'])
    expect(accepts(changed(q=>{q.question+='\n'+status;}))).toBe(false);
  for(const edit of [
    (q:any)=>{q.options[0].label='A) Archive the plan (Recommended)';},
    (q:any)=>{q.options[0].description='Source excerpt: '+q.options[0].description;},
    (q:any)=>{q.options[0].description='Transaction: lookup + update, do not commit. Then receipt send.';},
    (q:any)=>{q.options[0].description+=' This remedy is "withdrawn".';},
    (q:any)=>{q.options[2].label='C) Save the report';},
    (q:any)=>{q.options[2].description='Source excerpt: '+q.options[2].description;},
    (q:any)=>{q.options[2].description='Lookup and update with a defined commit point.';},
    (q:any)=>{q.options[2].description+=' This option is cancelled.';},
  ]) expect(accepts(changed(edit))).toBe(false);
});
test('regression paths belong only to the dense CEO owner', () => {
  for (const path of ['test/ceo-sequence-aq.test.ts','test/fixtures/ceo-sequence-aq.json'])
    expect(Object.entries(E2E_TOUCHFILES).filter(([,paths])=>paths.includes(path)).map(([owner])=>owner)).toEqual(['plan-ceo-finding-count']);
  const owner=E2E_TOUCHFILES['plan-ceo-finding-count']!;
  for(let i=0;i<owner.length;i++) {
    expect(Object.hasOwn(owner,i)).toBe(true);
    expect(typeof owner[i]).toBe('string');
  }
});

test('source options, conditional metadata and later contract contradictions cannot own sequencing evidence', () => {
  for(const edit of [
    (q:any)=>{q.options[2].description='> '+q.options[2].description;},
    (q:any)=>{q.options[2].description='~~~\n'+q.options[2].description+'\n~~~';},
    (q:any)=>{q.question=q.question.replace('Project/branch/task: main','Project/branch/task: Assuming approval, main');},
    (q:any)=>{q.question=q.question.replace('Project/branch/task: main','Project/branch/task: Provided approval, main');},
    (q:any)=>{q.question+='\nThis decision is "superseded".';},
    (q:any)=>{q.question+='\nThis sequence is "cancelled".';},
    (q:any)=>{q.question+='\nThis sequence is not current.';},
    (q:any)=>{q.options[0].description+='\nCorrection: the receipt is sent before the payment commit.';},
    (q:any)=>{q.options[2].description+='\nCorrection: this transaction boundary is now defined.';},
  ]) expect(accepts(changed(edit))).toBe(false);
  expect(accepts(changed(q=>{q.question+='\n"Earlier review assessment: This sequence is cancelled."';}))).toBe(true);
  expect(accepts(changed(q=>{q.question+='\nThe archive sequence is cancelled.';}))).toBe(true);
});
