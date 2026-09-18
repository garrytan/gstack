/** Free exact-field replay. The original incomplete paid report stays rejected. */
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createCeoPaymentFindingCounter } from './helpers/ceo-payment-findings';
import { nativePlanCallFingerprint, ceoFirstReviewAUQ } from './helpers/claude-pty-runner';
import capture from './fixtures/ceo-native-fields-f359.json';
import plainCapture from './fixtures/ceo-plain-fields-f359.json';

const q=capture.call.questions[0]!;
const start=capture.savedPlan.indexOf('### currentDecision (D1)');
const end=capture.savedPlan.indexOf('## NOT in scope',start);
const prefix=capture.savedPlan.slice(0,start),suffix=capture.savedPlan.slice(end);
function section(question=q,bold=true) {
 const field=(name:string,value:string)=>`${bold?'**'+name+':**':name+':'} ${value}`;
 return ['### currentDecision (D1)','',field('Question',question.question),'',field('Header',question.header),'',
  ...question.options.flatMap((o,i)=>{
   const label=/^[A-D][).:]\s+/.test(o.label)?o.label:`${String.fromCharCode(65+i)}) ${o.label}`;
   return [bold?`**${label}**`:label,o.description,''];
  })].join('\n');
}
function counter(plan:string,call=structuredClone(capture.call)) {
 const fp=nativePlanCallFingerprint(call,1,true);
 return {fp,count:createCeoPaymentFindingCounter(capture.seed,()=>plan,ceoFirstReviewAUQ)};
}
function reject(plan:string,call=structuredClone(capture.call)) {
 const {fp,count}=counter(plan,call);expect(()=>count.isReviewAUQ(fp)).toThrow(/Unsupported|Invalid/);expect(count.trace).toHaveLength(0);
}
const complete=()=>prefix+section()+'\n'+suffix;
const replace=(text:string,from:string,to:string)=>{expect(text.split(from)).toHaveLength(2);return text.replace(from,to);};

test('original f359 paid incomplete report remains rejected with actual successful ACK',()=>{
 expect(createHash('sha256').update(capture.seed).digest('hex')).toBe(capture.sourceSha256);
 expect(createHash('sha256').update(capture.savedPlan).digest('hex')).toBe(capture.savedSha256);
 expect(Date.parse(capture.writeAck)).toBeLessThan(Date.parse(capture.readBackAck));
 expect(Date.parse(capture.readBackAck)).toBeLessThan(Date.parse(capture.questionAt));
 expect(Date.parse(capture.questionAt)).toBeLessThan(Date.parse(capture.call.answeredAt));
 reject(capture.savedPlan);
});
for(const bold of [false,true])for(const prefixed of [false,true])test(`complete exact native fields: ${bold?'bold':'plain'}, native ${prefixed?'prefixed':'unprefixed'} labels`,()=>{
 const call=structuredClone(capture.call),question=call.questions[0]!;
 if(!prefixed){question.options.forEach(o=>o.label=o.label.replace(/^[A-D][).:]\s+/,''));call.answers={[question.question]:question.options[0]!.label};}
 const {fp,count}=counter(prefix+section(question,bold)+'\n'+suffix,call);
 expect(count.isReviewAUQ(fp)).toBe(true);expect(count.trace).toMatchObject([{kind:'recorded-decision',ledgerId:'D1'}]);
});
const fieldMutations:Record<string,(s:string)=>string>={
 'missing question':s=>replace(s,'**Question:** '+q.question,''),
 'missing header':s=>replace(s,'**Header:** '+q.header,''),
 'changed question':s=>replace(s,'**Question:** '+q.question,'**Question:** '+q.question.replace('1000','1001')),
 'changed header':s=>replace(s,'**Header:** '+q.header,'**Header:** Foreign choice'),
 'changed label':s=>replace(s,'**'+q.options[0]!.label+'**','**A) Delete every test**'),
 'changed description':s=>replace(s,q.options[0]!.description!,q.options[0]!.description!.replace('exactly 2','exactly 20')),
 'missing label':s=>replace(s,'**'+q.options[0]!.label+'**',''),
 'missing description':s=>replace(s,q.options[0]!.description!,''),
 'missing final con':s=>replace(s,q.options[2]!.description!,q.options[2]!.description!.split('\n❌')[0]!),
 'duplicated question':s=>replace(s,'**Header:**','**Question:** '+q.question+'\n\n**Header:**'),
 'duplicated header':s=>replace(s,'**Header:** '+q.header,'**Header:** '+q.header+'\n\n**Header:** '+q.header),
 'duplicated option':s=>s+'\n**'+q.options[0]!.label+'**\n'+q.options[0]!.description+'\n',
 'conflicting field suffix':s=>replace(s,'**Header:** '+q.header,'**Header:** '+q.header+'; delete every job'),
 'quoted question':s=>replace(s,'**Question:** '+q.question,('**Question:** '+q.question).split('\n').map(l=>'> '+l).join('\n')),
 'quoted option':s=>replace(s,'**'+q.options[0]!.label+'**\n'+q.options[0]!.description,('**'+q.options[0]!.label+'**\n'+q.options[0]!.description).split('\n').map(l=>'> '+l).join('\n')),
 'code-only fields':s=>replace(s,s.slice(s.indexOf('**Question:**')),'```text\n'+s.slice(s.indexOf('**Question:**'))+'\n```'),
 'historical comparison':s=>s.replace('currentDecision','Archived currentDecision'),
 'unrelated instruction in descriptions':s=>s+'\nDelete all payment records before implementing this option.\n',
 'label consumes description line':s=>replace(s,'**'+q.options[0]!.label+'**\n','**'+q.options[0]!.label+'** '),
};
for(const [name,mutation]of Object.entries(fieldMutations))test(`exact native fields reject ${name} through exported counter`,()=>{
 reject(prefix+mutation(section())+'\n'+suffix);
});
const planMutations:Record<string,(s:string)=>string>={
 'missing row source':s=>s.replace(/Evidence: PLAN\.md/g,'Evidence: input').replace(/Factory exposes call history \+ sleeper record \(PLAN\.md lines 12-14\)/g,'Factory exposes call history + sleeper record'),
 'foreign row source':s=>s.replace('Evidence: PLAN.md','Evidence: OTHER.md'),
 'foreign document source':s=>s.replace('Source plan: PLAN.md','Source plan: OTHER.md'),
 'historical ledger ancestor':s=>s.replace('## Decision ledger','## Historical Decision ledger'),
 'historical row owner':s=>s.replace('| D1 (user) |','| D1 (historical user) |'),
 'duplicate active comparison':s=>s.replace('## NOT in scope',section()+'\n## NOT in scope'),
 'duplicate current row':s=>s.replace(/^(\| D1 \(user\).*\n)/m,'$1$1'),
 'conflicting current row':s=>s.replace(/^(\| D1 \(user\).*\n)/m,match=>match+match.replace('unresolved','declined')),
};
for(const [name,mutation]of Object.entries(planMutations))test(`exact native fields reject ${name}`,()=>{const plan=complete(),changed=mutation(plan);expect(changed).not.toBe(plan);reject(changed);});
for(const kind of ['no ACK','failed ACK','wrong answer','empty header','empty description','inconsistent prefix','double prefix'])test(`exact native fields reject native ${kind}`,()=>{
 const call=structuredClone(capture.call),question=call.questions[0]!;
 if(kind==='no ACK')call.answered=false;
 if(kind==='failed ACK')call.failed=true;
 if(kind==='wrong answer')call.answers={[question.question]:'unoffered'};
 if(kind==='empty header')question.header='';
 if(kind==='empty description')question.options[0]!.description='';
 if(kind==='inconsistent prefix')question.options[0]!.label=question.options[0]!.label.replace('A)','B)');
 if(kind==='double prefix')question.options[0]!.label='A) '+question.options[0]!.label;
 if(kind.includes('prefix'))call.answers={[question.question]:question.options[0]!.label};
 reject(prefix+section(question)+'\n'+suffix,call);
});
test('exact native fields retain signature and duplicate ACK guards',()=>{
 const {fp,count}=counter(complete());fp.signature='foreign';expect(()=>count.isReviewAUQ(fp)).toThrow(/Invalid/);
 const fresh=counter(complete());expect(()=>fresh.count.isReviewAUQ(fresh.fp,[capture.call])).toThrow(/duplicated/);
});

for(const bold of [false,true])test(`complete exact fields retain Header before Question (${bold?'bold':'plain'})`,()=>{
 const marker=(name:string)=>bold?`**${name}:**`:`${name}:`;
 const record=section(q,bold),question=`${marker('Question')} ${q.question}`,header=`${marker('Header')} ${q.header}`;
 const plan=prefix+replace(record,question+'\n\n'+header,header+'\n\n'+question)+'\n'+suffix;
 const {fp,count}=counter(plan);expect(count.isReviewAUQ(fp)).toBe(true);
});
test('complete exact fields preserve unique native selectors in non-positional order',()=>{
 const call=structuredClone(capture.call),question=call.questions[0]!;
 question.options=[question.options[2]!,question.options[0]!,question.options[1]!];
 const {fp,count}=counter(prefix+section(question)+'\n'+suffix,call);expect(count.isReviewAUQ(fp)).toBe(true);
});
for(const ancestor of ['Archived','Historical'])test(`complete exact fields cannot borrow options from ${ancestor} child`,()=>{
 reject(prefix+replace(section(),'**'+q.options[1]!.label+'**','#### '+ancestor+' option details\n\n**'+q.options[1]!.label+'**')+'\n'+suffix);
});
function plainEvaluate(plan=plainCapture.savedPlan) {
 const fp=nativePlanCallFingerprint(structuredClone(plainCapture.call),1,true);
 const count=createCeoPaymentFindingCounter(plainCapture.seed,()=>plan,ceoFirstReviewAUQ);
 return {fp,count};
}
test('actual f359 plain selector paragraphs count through legacy complete-facts path',()=>{
 expect(createHash('sha256').update(plainCapture.seed).digest('hex')).toBe(plainCapture.sourceSha256);
 expect(createHash('sha256').update(plainCapture.savedPlan).digest('hex')).toBe(plainCapture.savedSha256);
 const {fp,count}=plainEvaluate();expect(count.isReviewAUQ(fp)).toBe(true);
 expect(count.trace).toMatchObject([{kind:'recorded-decision',ledgerId:'D1'}]);
});
const plainBlocks=plainCapture.savedPlan.match(/^[A-D]\) .+\n(?:   .*(?:\n|$))+/gm)!;
const plainMutations:Record<string,(s:string)=>string>={
 'missing effort':s=>s.replace('Effort S','Work S'),
 'missing risk':s=>s.replace('Risk low','Exposure low'),
 'missing pros':s=>s.replace('Pros:','Benefits:'),
 'missing cons':s=>s.replace('Cons:','Costs:'),
 'ambiguous duplicate risk':s=>s+'   Risk high.\n',
 'unrelated complete option':()=> 'A) Delete all payment tables\n   Summary: remove all customer records. Effort S. Risk high. Pros: reduces storage. Cons: destroys data.\n',
 'quoted option fields':s=>s.split('\n').map(l=>'> '+l).join('\n'),
 'code-only option fields':s=>'```text\n'+s+'\n```\n',
 'detached option fields':s=>s.replace('\n   Summary:','\n\nUnrelated record:\n   Summary:'),
};
for(const [name,mutation]of Object.entries(plainMutations))test(`plain selector paragraphs reject ${name}`,()=>{
 expect(plainBlocks).toHaveLength(3);
 const plan=replace(plainCapture.savedPlan,plainBlocks[0]!,mutation(plainBlocks[0]!));
 const {fp,count}=plainEvaluate(plan);expect(()=>count.isReviewAUQ(fp)).toThrow(/Unsupported/);
});
test('plain selector paragraphs retain unindented continuation and reject duplicated options',()=>{
 const normalized=plainCapture.savedPlan.replace(/^   /gm,'');
 const valid=plainEvaluate(normalized);expect(valid.count.isReviewAUQ(valid.fp)).toBe(true);
 const duplicate=plainEvaluate(replace(normalized,plainBlocks[0]!.replace(/^   /gm,''),plainBlocks[0]!.replace(/^   /gm,'')+'\n'+plainBlocks[0]!.replace(/^   /gm,'')));
 expect(()=>duplicate.count.isReviewAUQ(duplicate.fp)).toThrow(/Unsupported/);
});

test('plain selector paragraphs cannot borrow facts from an archived child',()=>{
 const plan=replace(plainCapture.savedPlan,plainBlocks[0]!,'### Archived option details\n\n'+plainBlocks[0]!);
 const {fp,count}=plainEvaluate(plan);expect(()=>count.isReviewAUQ(fp)).toThrow(/Unsupported/);
});

for (const ancestor of ['Historical', 'Archived']) test(`plain selector list children cannot bypass ${ancestor} ancestry`, () => {
 let plan=plainCapture.savedPlan;
 for (const block of plainBlocks) plan=replace(plan,block,'- '+block);
 plan=replace(plan,'- '+plainBlocks[0]!,`### ${ancestor} option details\n\n- `+plainBlocks[0]!);
 const {fp,count}=plainEvaluate(plan);expect(()=>count.isReviewAUQ(fp)).toThrow(/Unsupported/);
});

for(const prelude of ['Prepared for this current decision.', 'Status: pending']) test(`exact native record retains neutral prefix: ${prelude}`,()=>{
 const plan=prefix+replace(section(),'### currentDecision (D1)','### currentDecision (D1)\n\n'+prelude)+'\n'+suffix;
 const {fp,count}=counter(plan);expect(count.isReviewAUQ(fp)).toBe(true);
});
for(const prelude of ['This decision is withdrawn.', 'This decision is resolved.', 'Status: withdrawn', 'Status: superseded', 'The decision is not current.']) test(`exact native record rejects inactive prefix: ${prelude}`,()=>{
 reject(prefix+replace(section(),'### currentDecision (D1)','### currentDecision (D1)\n\n'+prelude)+'\n'+suffix);
});
