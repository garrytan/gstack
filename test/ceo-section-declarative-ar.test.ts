import {describe,test,expect} from 'bun:test';
import {ceoFirstReviewAUQ,ceoStep0Boundary,nativePlanCallFingerprint,planCountQuestionPhase} from './helpers/claude-pty-runner';
import type {NativePlanQuestionCall} from './helpers/plan-count-transcript';
import fixture from './fixtures/ceo-section-declarative-ar.json';
const calls=()=>structuredClone(fixture.calls) as NativePlanQuestionCall[],first=()=>calls()[2]!;
const fp=(c=first())=>nativePlanCallFingerprint(c,0,true),classify=(c=first())=>ceoFirstReviewAUQ(fp(c));
const mutate=(fn:(c:NativePlanQuestionCall)=>void)=>{const c=first();fn(c);return c;};
const text=(fn:(s:string)=>string)=>mutate(c=>{const q=c.questions[0]!,a=c.answers![q.question]!;q.question=fn(q.question);c.answers={[q.question]:a};});
const allOptions=(fn:(label:string,description:string)=>{label:string;description:string})=>mutate(c=>{const q=c.questions[0]!,selected=q.options.findIndex(o=>o.label===c.answers![q.question]);q.options=q.options.map(o=>fn(o.label,o.description??''));c.answers={[q.question]:q.options[selected]!.label};});
describe('AR completed declarative Section finding',()=>{
 test('exact public calls enter review after genuine setup',()=>{let started=false;const phases=calls().map(c=>{const p=planCountQuestionPhase(fp(c),started,ceoStep0Boundary,ceoFirstReviewAUQ);started=p.reviewStarted;return p.preReview;});expect(phases).toEqual([true,true,false,false,false]);expect(classify(calls()[0])).toBe(false);expect(classify(calls()[1])).toBe(false);expect(classify(calls()[2])).toBe(true);expect(classify(calls()[3])).toBe(true);});
 test('comma and question punctuation are presentation',()=>{for(const c of [first(),text(s=>s.replace('Section 6, finding','Section 6 finding')),text(s=>s.replace('receipt is truthy\n','receipt is truthy?\n')),text(s=>s.replace('Section 6, finding','Section 6 finding').replace('receipt is truthy\n','receipt is truthy?\n'))])expect(classify(c)).toBe(true);expect(classify(text(s=>s.replace('D3 — Section 6, finding 1:','D8 — Section 2, finding 3:')))).toBe(true);});
 test('native successful completion and exact ownership stay required',()=>{
  for(const fn of [(c:NativePlanQuestionCall)=>{c.sessionId='';},(c:NativePlanQuestionCall)=>{c.toolUseId='';},(c:NativePlanQuestionCall)=>{c.answered=false;},(c:NativePlanQuestionCall)=>{c.failed=true;},(c:NativePlanQuestionCall)=>{delete c.failed;},(c:NativePlanQuestionCall)=>{delete c.answeredAt;},(c:NativePlanQuestionCall)=>{c.answeredAt='invalid';},(c:NativePlanQuestionCall)=>{c.answers={};},(c:NativePlanQuestionCall)=>{c.answers!['foreign']='foreign';},(c:NativePlanQuestionCall)=>{c.answers={[c.questions[0]!.question]:'unoffered'};},(c:NativePlanQuestionCall)=>{c.unansweredQuestionIndices=[0];},(c:NativePlanQuestionCall)=>{delete c.unansweredQuestionIndices;},(c:NativePlanQuestionCall)=>{c.questions.push(structuredClone(c.questions[0]!));},(c:NativePlanQuestionCall)=>{c.questions[0]!.multiSelect=true;}])expect(classify(mutate(fn))).toBe(false);
  for(const f of [{...fp(),signature:'foreign:tool'},{...fp(),nativeQuestionIndex:1},{...fp(),options:fp().options.toReversed()}])expect(ceoFirstReviewAUQ(f)).toBe(false);
 });
 test('malformed identities and setup headers stay closed',()=>{for(const [a,b] of [['D3 —','D0 —'],['D3 —','D03 —'],['Section 6,','Section 06,'],['finding 1:','finding 0:'],['finding 1:','finding 1.2:'],['Section 6,','Section 6,,']])expect(classify(text(s=>s.replace(a,b)))).toBe(false);for(const h of ['Section 7','Finding 9','Routing','Approach'])expect(classify(mutate(c=>{c.questions[0]!.header=h;}))).toBe(false);});
 test('source, conditional and duplicate assessment metadata stay closed',()=>{for(const field of ['Project/branch/task: ','ELI10: '])for(const p of ['Source excerpt: ','Earlier review assessment: ','If approved, '])expect(classify(text(s=>s.replace(field,field+p)))).toBe(false);for(const prefix of ['Source:\n','Earlier review assessment:\n','Project/branch/task: duplicate\n','ELI10: duplicate\n'])expect(classify(text(s=>s.replace('ELI10:',prefix+'ELI10:')))).toBe(false);expect(classify(text(s=>s.replace(/^Project\/branch\/task:.*\n/m,'')))).toBe(false);expect(classify(text(s=>'```\n'+s+'\n```'))).toBe(false);});
 test('withdrawn assessment or source-only options cannot establish a current decision',()=>{expect(classify(text(s=>s+'\nThis finding is withdrawn.'))).toBe(false);expect(classify(text(s=>s+'\nCorrection: this finding is "withdrawn".'))).toBe(false);for(const p of ['Source excerpt: ','If approved, '])expect(classify(allOptions((label,description)=>({label:label.replace(/^([A-Z]\) )/,'$1'+p),description:p+description})))).toBe(false);expect(classify(allOptions((label,description)=>({label,description:description+' This amendment is withdrawn.'})))).toBe(false);expect(classify(allOptions((label)=>({label:label.replace(/^([A-Z]\) ).*/,'$1Keep current assertion'),description:'Leave the current assertion unchanged.'})))).toBe(false);});
 test('superseded or conditional findings and offered actions are not current',()=>{
  for(const status of ['superseded','"superseded"','no longer current','"no longer current"']){
   expect(classify(text(s=>s+'\nThis finding is '+status+'.'))).toBe(false);
   expect(classify(allOptions((label,description)=>({label,description:description+' This amendment is '+status+'.'})))).toBe(false);
  }
  for(const prefix of ['Assuming approval, ','Provided approval, ']){
   expect(classify(text(s=>s.replace('ELI10: ','ELI10: '+prefix)))).toBe(false);
   expect(classify(allOptions((label,description)=>({label,description:prefix+description})))).toBe(false);
  }
  for(const history of ['> This finding is superseded.','Archived note: "This finding is superseded."','Archived note: "This finding is no longer current."','~~~\nThis finding is superseded.\n~~~'])expect(classify(text(s=>s+'\n'+history))).toBe(true);
 });
 test('quoted archive and selected opposed option remain valid',()=>{expect(classify(text(s=>s+'\nArchived note: "This finding is withdrawn."'))).toBe(true);expect(classify(mutate(c=>{const q=c.questions[0]!;c.answers={[q.question]:q.options[2]!.label};}))).toBe(true);});
});
