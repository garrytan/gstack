import {expect,test} from 'bun:test';
import captured from './fixtures/eng-omitted-select-361c.json';
import {buildEngSeedDecisionInput} from './helpers/eng-seeded-coverage';
import {buildPlanReviewDecisionPrompt} from './helpers/plan-review-decisions';

function input() {
  const calls=structuredClone(captured.calls);
  const times=calls.map(call=>Date.parse(call.answeredAt!));
  // This free check tests schema admission only. A new control deadline does
  // not turn the original paid failure into a semantic or timing pass.
  return buildEngSeedDecisionInput({plan:captured.plan,
    transcript:{status:'ready',calls,assistantMessages:[]},
    startedAt:Math.min(...times)-1,finishedAt:Math.max(...times)+1,deadlineAt:Date.now()+60_000});
}
function payload(prompt:string) {
  const marker=/BEGIN_UNTRUSTED_([a-f0-9]{32})\n/.exec(prompt)!;
  return JSON.parse(prompt.slice(marker.index+marker[0].length,prompt.lastIndexOf(`\nEND_UNTRUSTED_${marker[1]}`)));
}

test('actual acknowledged native omissions receive the pinned false default only in evaluator input',()=>{
  const value=input(),before=structuredClone(value);
  expect(captured.calls.filter(call=>!Object.hasOwn(call.questions[0]!,'multiSelect'))).toHaveLength(8);
  const actual=payload(buildPlanReviewDecisionPrompt(value));
  expect(actual.calls).toHaveLength(10);
  for(let i=0;i<actual.calls.length;i++) {
    expect(actual.calls[i].questions).toEqual(value.fingerprints[i]!.questions!.map(question=>({...question,multiSelect:false})));
    expect(actual.calls[i].selectedOptions).toEqual(value.fingerprints[i]!.selectedOptions);
  }
  expect(value).toEqual(before);
  expect(captured.error).toContain('invalid native question or selected option');
});

for(const invalid of [true,null,'false',0,undefined])test(`explicit malformed/multiple selection stays rejected: ${String(invalid)}`,()=>{
  const value=input();value.fingerprints[0]!.questions![0]!.multiSelect=invalid as any;
  expect(()=>buildPlanReviewDecisionPrompt(value)).toThrow('invalid native question or selected option');
});

test('defaulting does not infer an unoffered answer or fill an omitted selection',()=>{
  for(const invalid of [0,4,undefined]) {
    const value=input();value.fingerprints[0]!.selectedOptions![0]=invalid as any;
    expect(()=>buildPlanReviewDecisionPrompt(value)).toThrow('invalid native question or selected option');
  }
});
