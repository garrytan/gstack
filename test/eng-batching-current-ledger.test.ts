import { test, expect } from 'bun:test';
import fs from 'node:fs';
import { createEngBatchingIssueCounter } from './helpers/eng-seeded-coverage';
import { engSetupAUQ, nativePlanCallFingerprint } from './helpers/claude-pty-runner';
const rows = JSON.parse(fs.readFileSync(import.meta.dir + '/fixtures/eng-batching-saved-ledger-b176.json', 'utf8')).frames;
function fixture(index=3) {
 const row=structuredClone(rows[index]);
 return {fp:row.fingerprint,plan:row.preAskPlan};
}
function evaluate(plan:string,fp:any) { return createEngBatchingIssueCounter(()=>plan,engSetupAUQ).isReviewAUQ(fp,[]); }
function owned(plan:string,fp:any,change:(s:string)=>string) {
 const at=plan.indexOf(fp.nativeCall.questions[0].question.split('\n')[0]);
 const start=plan.lastIndexOf('\n### ',at), next=plan.indexOf('\n### ',at);
 const end=next<0?plan.length:next;
 return plan.slice(0,start)+change(plan.slice(start,end))+plan.slice(end);
}
for(const index of [3,4,5,6,7,8,9]) test(`actual pre-ACK D${index+1} passes explicit option ownership`,()=>{
 const {plan,fp}=fixture(index);expect(evaluate(plan,fp)).toBe(true);
});
const mutations:Record<string,(s:string)=>string>={
 'duplicate offered option':s=>s.replace('Options:\n','Options:\nA) unowned extra choice\n'),
 'missing Options':s=>s.replace('Options:\n',''),
 'missing Header':s=>s.replace(/^Header:.*\n/m,''),
 'wrong Header':s=>s.replace(/^Header:.*$/m,'Header: Foreign decision'),
 'duplicate Header':s=>s.replace('Options:\n','Header: Retry mech\nOptions:\n'),
 'duplicate Options after answer':s=>s.replace('Actual answer:','Options:\nActual answer:'),
 'duplicate Actual answer':s=>s.replace('Actual answer:','Actual answer: contradictory\nActual answer:'),
 'stolen question body':s=>s.replace(/^ELI10:.*$/m,'ELI10: Delete the job queue and build a new payment product.'),
 'added current instruction':s=>s.replace('Pros / cons:\n','Delete every job before implementing the selected option.\nPros / cons:\n'),
 'changed deliberation option':s=>s.replace('A) Library retry hooks','A) Delete all retry hooks'),
 'negated deliberation':s=>s.replace('✅ Attempt count','✅ Never persist attempt count'),
 'duplicated deliberation':s=>s.replace('Pros / cons:\n','Pros / cons:\nPros / cons:\n'),
 'foreign source':s=>s.replaceAll('PLAN.md','OTHER.md'),
 'foreign heading':s=>s.replace('### R1:','### Historical R1:'),
 'duplicate state':s=>s.replace('State: pending','State: pending\nState: approved'),
 'duplicate record':s=>s+'\n'+s,
};
for(const [name,mutation] of Object.entries(mutations)) test(`rejects ${name}`,()=>{
 const {plan,fp}=fixture();expect(evaluate(owned(plan,fp,mutation),fp)).toBe(false);
});
for(const name of ['no ACK','failed ACK','wrong selected ACK','foreign signature']) test(`rejects ${name}`,()=>{
 const {plan,fp}=fixture();
 if(name==='no ACK'){fp.nativeCall.answered=false;delete fp.nativeCall.answers;}
 if(name==='failed ACK')fp.nativeCall.failed=true;
 if(name==='wrong selected ACK')fp.nativeCall.answers[fp.nativeCall.questions[0].question]='An unoffered choice';
 if(name==='foreign signature')fp.signature='foreign';
 expect(evaluate(plan,fp)).toBe(false);
});
const gridMutations:Record<string,(s:string)=>string>={
 'duplicate dimension caption':s=>s.replace(/^(\| R4 policy: max attempts.*)$/m,'$1\n$1'),
 'conflicting repeated dimension':s=>s.replace(/^(\| R4 policy: max attempts.*)$/m,'$1\n| R4 policy: max attempts | unspecified | unlimited | unlimited | unlimited |'),
 'normalized repeated dimension':s=>s.replace(/^(\| R4 policy: max attempts.*)$/m,'$1\n| R4 POLICY:  max attempts | unspecified | unlimited | unlimited | unlimited |'),
 'repeated explicit dimension ID':s=>s.replace('R4 policy: max attempts','R4a max attempts').replace('R4 policy: delay cap','R4a delay cap'),
 'missing current dimension':s=>s.replace(/^\| R4 policy:.*\n/gm,''),
 'foreign current dimension':s=>s.replaceAll('| R4 policy:', '| R40 policy:'),
 'wrong Current column':s=>s.replace('| Choice | Current |','| Choice | Historical |'),
 'wrong option order':s=>s.replace('| Choice | Current | A | B | C |','| Choice | Current | B | A | C |'),
};
for(const [name,mutation] of Object.entries(gridMutations)) test(`rejects ${name}`,()=>{
 const {plan,fp}=fixture(5);expect(evaluate(owned(plan,fp,mutation),fp)).toBe(false);
});
test('distinct explicit dimensions retain their IDs',()=>{
 const {plan,fp}=fixture(5);let id=0;
 expect(evaluate(owned(plan,fp,s=>s.replace(/R4 policy:/g,()=>`R4${String.fromCharCode(97+id++)} policy:`)),fp)).toBe(true);
});
test('changed native option cannot borrow the original saved fields',()=>{
 const {plan,fp}=fixture();const q=fp.nativeCall.questions[0];q.options[0].label='Delete every job (recommended)';fp.options[0].label=q.options[0].label;fp.nativeCall.answers[q.question]=q.options[0].label;
 expect(evaluate(plan,fp)).toBe(false);
});

// The explicit Options field is authoritative even when the saved question
// repeats the native pros and cons earlier in the same owned record.
function offered(plan:string,fp:any,change:(s:string)=>string) {
 return owned(plan,fp,record=>{
  const start=record.indexOf('\nOptions:\n'),end=record.indexOf('\nActual answer:',start);
  expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);
  const before=record.slice(start,end),after=change(before);
  expect(after).not.toBe(before);
  return record.slice(0,start)+after+record.slice(end);
 });
}
const offeredMutations:Record<string,(s:string)=>string>={
 'contradictory complete description':s=>s.replace(
  '✅ Attempt count and next-run time persist in the queue, so a worker crash mid-backoff cannot lose the job',
  '❌ Never persist attempt count or next-run time; drop the job whenever the worker crashes.'),
 'missing all option descriptions':s=>s.replace(/^[✅❌].*\n?/gm,''),
 'instruction on Options marker':s=>s.replace('Options:\n','Options: Delete every job before selecting.\n'),
};
for(const [name,mutation] of Object.entries(offeredMutations)) test(`explicit Options rejects ${name}`,()=>{
 const {plan,fp}=fixture();expect(evaluate(offered(plan,fp,mutation),fp)).toBe(false);
});
const offeredRepresentations:Record<string,(s:string)=>string>={
 'bold option labels':s=>s.replace(/^([A-D]\) .+)$/gm,'**$1**'),
 'description whitespace':s=>s.replace(/^([✅❌].*)$/gm,(_,line)=>line.replace(/ /g,'  ')+'\n'),
};
for(const [name,representation] of Object.entries(offeredRepresentations)) test(`explicit Options retains ${name}`,()=>{
 const {plan,fp}=fixture();expect(evaluate(offered(plan,fp,representation),fp)).toBe(true);
});

// Exact public calls and pre-question report bytes from the frozen f359 run.
// Selector formatting may vary; the offered caption, description and owner may not.
const prefixedCapture = JSON.parse(fs.readFileSync(import.meta.dir + '/fixtures/eng-batching-prefixed-ledger-f359.json', 'utf8'));
const prefixedFrame = () => structuredClone(prefixedCapture.frames[3]);
function prefixedEvaluate(frame: any) {
 return evaluate(frame.preAskPlan, nativePlanCallFingerprint(frame.call, 0, true));
}
function changeNativeLabel(frame: any, index: number, next: string) {
 const q=frame.call.questions[0],old=q.options[index].label;
 q.options[index].label=next;
 if(frame.call.answers?.[q.question]===old)frame.call.answers[q.question]=next;
}
function prefixedBlock(frame:any,kind:'deliberations'|'options',change:(s:string)=>string) {
 const fp=nativePlanCallFingerprint(frame.call,0,true);
 frame.preAskPlan=owned(frame.preAskPlan,fp,record=>{
  const start=record.indexOf(kind==='deliberations'?'Pros / cons:\n':'Options:\n');
  const end=record.indexOf(kind==='deliberations'?'Net:':'Actual answer:',start);
  expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);
  const before=record.slice(start,end),after=change(before);expect(after).not.toBe(before);
  return record.slice(0,start)+after+record.slice(end);
 });
}
test('actual prefixed native labels match their single-selector saved deliberations',()=>{
 const frame=prefixedFrame();
 expect(frame.call.answered).toBe(true);expect(frame.call.failed).toBe(false);
 expect(Date.parse(frame.retainedBeforeQuestion.at)).toBeLessThan(Date.parse(frame.questionAt));
 expect(prefixedEvaluate(frame)).toBe(true);
});
for(const delimiter of ['',')','.',':'])test(`copied deliberations retain native selector representation ${delimiter||'unprefixed'}`,()=>{
 const frame=prefixedFrame();
 frame.call.questions[0].options.forEach((option:any,index:number)=>{
  const caption=option.label.replace(/^[A-D][).:]\s+/, '');
  changeNativeLabel(frame,index,delimiter?`${String.fromCharCode(65+index)}${delimiter} ${caption}`:caption);
 });
 expect(prefixedEvaluate(frame)).toBe(true);
});
for(const index of [0,1,2])for(const kind of ['conflicting','repeated','mixed'])test(`rejects ${kind} native selector at offered position ${index+1}`,()=>{
 const frame=prefixedFrame(),old=frame.call.questions[0].options[index].label;
 const own=String.fromCharCode(65+index),other=String.fromCharCode(65+(index+1)%3);
 changeNativeLabel(frame,index,kind==='conflicting'?old.replace(own+')',other+')'):
  kind==='repeated'?`${own}) ${old}`:`${own}) ${other}: ${old.replace(/^[A-D][).:]\s+/, '')}`);
 expect(prefixedEvaluate(frame)).toBe(false);
});
for(const kind of ['deliberations','options'] as const){
 for(const mutation of ['changed description','missing description','repeated selector','conflicting selector'])test(`current ${kind} rejects ${mutation}`,()=>{
  const frame=prefixedFrame();
  prefixedBlock(frame,kind,text=>{
   if(mutation==='changed description')return text.replace('Attempt count, delay and dead-lettering persist','Attempt count, delay and dead-lettering never persist');
   if(mutation==='missing description')return text.replace(/^\s*[✅❌].*\n?/gm,'');
   return text.replace(/^A\) /m,mutation==='repeated selector'?'A) A) ':'A) B) ');
  });
  expect(prefixedEvaluate(frame)).toBe(false);
 });
}
for(const description of ['', '✅ Never persist attempt count. ✅ Drop jobs on a crash. ❌ Loses every pending job.'])test(`native description must remain complete and unchanged: ${description?'changed':'missing'}`,()=>{
 const frame=prefixedFrame();frame.call.questions[0].options[0].description=description;
 expect(prefixedEvaluate(frame)).toBe(false);
});
test('prefixed labels cannot borrow another report owner',()=>{
 const frame=prefixedFrame();frame.preAskPlan=frame.preAskPlan.replaceAll('PLAN.md','OTHER.md');
 expect(prefixedEvaluate(frame)).toBe(false);
});
test('prefixed labels still require the actual offered answer ACK',()=>{
 const frame=prefixedFrame();frame.call.answers[frame.call.questions[0].question]='An unoffered answer';
 expect(prefixedEvaluate(frame)).toBe(false);
});
test('sequential f359 capture preserves setup exclusions and current record identity',()=>{
 let plan='';const counter=createEngBatchingIssueCounter(()=>plan,engSetupAUQ);
 const accepted=prefixedCapture.frames.filter((frame:any,index:number)=>{
  plan=frame.preAskPlan;
  return counter.isReviewAUQ(nativePlanCallFingerprint(frame.call,0,true),prefixedCapture.frames.slice(0,index).map((row:any)=>row.call));
 });
 expect(accepted.map((frame:any)=>frame.call.questions[0].question.split(' — ')[0])).toEqual(['D4','D5','D6','D7','D8','D10','D11','D12','D13']);
 expect(counter.trace.map(row=>row.issue)).toEqual(['record:R1','record:R3','record:R3b','record:R6','record:R7','record:R2','record:R9','record:R4','record:R5']);
 // D9 retains its real unsaved question change; setup and TODOs remain
 // excluded. This uncapped replay proves recognition, not a paid verdict.
});
for(const prefixed of [true,false])for(const order of [[1,0,2],[2,0,1],[2,1,0]])test(`unchanged native choices bind by label across order ${order} (${prefixed?'prefixed':'plain'})`,()=>{
 const frame=prefixedFrame(),q=frame.call.questions[0];
 if(!prefixed)q.options.forEach((option:any,index:number)=>changeNativeLabel(frame,index,option.label.replace(/^[A-D][).:]\s+/,'')));
 q.options=order.map(index=>q.options[index]);expect(prefixedEvaluate(frame)).toBe(true);
});
for(const kind of ['deliberations','options'] as const)test(`unchanged ${kind} preserve unique choices across presentation order`,()=>{
 const frame=prefixedFrame();prefixedBlock(frame,kind,text=>{
  const at=text.search(/^A\) /m),prefix=text.slice(0,at),blocks=text.slice(at).split(/(?=^[A-D]\) )/m);
  expect(blocks).toHaveLength(3);return prefix+[blocks[1],blocks[2],blocks[0]].join('');
 });expect(prefixedEvaluate(frame)).toBe(true);
});
test('captured D9 still rejects its unsaved extra sentence',()=>{
 const frame=structuredClone(prefixedCapture.frames[8]);expect(prefixedEvaluate(frame)).toBe(false);
});
test('synthetic D9 with fully unchanged saved question recognizes B-first presentation',()=>{
 const frame=structuredClone(prefixedCapture.frames[8]);
 const before='Net: how long you want the queue to keep trying on its own before a human is told (A: 1 min, B: 10 min, C: never).';
 expect(frame.preAskPlan).toContain(before+'\n');
 frame.preAskPlan=frame.preAskPlan.replace(before+'\n',before+' Pick Other to supply your own numbers.\n');
 expect(prefixedEvaluate(frame)).toBe(true);
});
for(const id of ['R31b','R31part2'])test(`stable alphanumeric choice ${id} owns its exact record and grid`,()=>{
 const frame=prefixedFrame();frame.preAskPlan=frame.preAskPlan.replace(/\bR1\b/g,id);
 frame.call.questions[0].options.forEach((option:any)=>option.description=option.description.replace(/\bR1\b/g,id));
 expect(prefixedEvaluate(frame)).toBe(true);
});
for(const mutation of ['duplicate record','wrong grid owner','inactive record'])test(`alphanumeric identity rejects ${mutation}`,()=>{
 const frame=prefixedFrame();frame.preAskPlan=frame.preAskPlan.replace(/\bR1\b/g,'R31b');
 frame.call.questions[0].options.forEach((option:any)=>option.description=option.description.replace(/\bR1\b/g,'R31b'));
 const fp=nativePlanCallFingerprint(frame.call,0,true);
 frame.preAskPlan=owned(frame.preAskPlan,fp,record=>mutation==='duplicate record'?record+'\n'+record:
  mutation==='wrong grid owner'?record.replace('| R31b retry','| R31b0 retry'):record.replace('State: pending','State: withdrawn'));
 expect(prefixedEvaluate(frame)).toBe(false);
});
for(const caption of ['Architecture review — findings','Code quality review: risks and decisions','Tests review - coverage gaps','Performance review – current findings'])test(`current owned review section permits descriptive caption ${caption}`,()=>{
 const frame=prefixedFrame();frame.preAskPlan=frame.preAskPlan.replace('### R1:',`## Section 1: ${caption}\n\n### R1:`);
 expect(prefixedEvaluate(frame)).toBe(true);
});
for(const caption of ['Architecture review — historical findings','Architecture review — OTHER.md','Design review — findings','Archived Architecture review — findings'])test(`descriptive section cannot borrow owner ${caption}`,()=>{
 const frame=prefixedFrame();frame.preAskPlan=frame.preAskPlan.replace('### R1:',`## Section 1: ${caption}\n\n### R1:`);
 expect(prefixedEvaluate(frame)).toBe(false);
});
for(const place of ['section','record'])test(`source example prefix rejects ${place} ownership`,()=>{
 const frame=prefixedFrame();frame.preAskPlan=frame.preAskPlan.replace('### R1:',place==='section'?
  'Source example:\n\n## Section 1: Architecture review — findings\n\n### R1:':
  '## Section 1: Architecture review — findings\n\nSource example:\n\n### R1:');
 expect(prefixedEvaluate(frame)).toBe(false);
});
test('unchanged paid ceiling limits sequential replay to seven distinct decisions',()=>{
 let plan='';const counter=createEngBatchingIssueCounter(()=>plan,engSetupAUQ),accepted:string[]=[];
 for(let i=0;i<prefixedCapture.frames.length;i++){
  const frame=prefixedCapture.frames[i];plan=frame.preAskPlan;
  if(counter.isReviewAUQ(nativePlanCallFingerprint(frame.call,0,true),prefixedCapture.frames.slice(0,i).map((row:any)=>row.call)))accepted.push(frame.call.questions[0].question.split(' — ')[0]);
  if(accepted.length===7)break;
 }
 expect(accepted).toEqual(['D4','D5','D6','D7','D8','D10','D11']);
});
