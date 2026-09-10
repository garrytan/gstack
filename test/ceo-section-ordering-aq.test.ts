import {describe,test,expect} from 'bun:test';
import {ceoFirstReviewAUQ,ceoStep0Boundary,nativePlanCallFingerprint,planCountQuestionPhase} from './helpers/claude-pty-runner';
import type {NativePlanQuestionCall} from './helpers/plan-count-transcript';
import fixture from './fixtures/ceo-section-ordering-aq.json';
const calls=()=>structuredClone(fixture.calls) as NativePlanQuestionCall[];const first=()=>calls()[2]!;
const fp=(c=first())=>nativePlanCallFingerprint(c,0,true);const classify=(c=first())=>ceoFirstReviewAUQ(fp(c));
function mutate(fn:(c:NativePlanQuestionCall)=>void){const c=first();fn(c);return c;}
function text(fn:(s:string)=>string){return mutate(c=>{const q=c.questions[0]!,a=c.answers![q.question]!;q.question=fn(q.question);c.answers={[q.question]:a};});}
describe('AQ owned Section architecture ordering brief',()=>{
 test('exact seven calls open review at D4 and retain prior setup',()=>{let started=false;const phases=calls().map(c=>{const p=planCountQuestionPhase(fp(c),started,ceoStep0Boundary,ceoFirstReviewAUQ);started=p.reviewStarted;return p.preReview;});expect(phases).toEqual([true,true,false,false,false,false,false]);expect(classify()).toBe(true);});
 test('separate counters, choice order and selected option remain valid',()=>{const c=text(s=>s.replace('D4 — Section 1 (Architecture), issue 1:','D9 — Section 3 (Architecture), issue 2:').replace(/\b1([ABC])\b/g,'2$1')),q=c.questions[0]!;for(const o of q.options)o.label=o.label.replace(/^1/,'2');q.options.reverse();for(const o of q.options){c.answers={[q.question]:o.label};expect(classify(c)).toBe(true);}});
 test('quoted archive and conditional consequences do not cancel current evidence',()=>{expect(classify(text(s=>s+'\nArchived note: "This finding is withdrawn."'))).toBe(true);expect(classify(mutate(c=>{c.questions[0]!.options[0]!.description+=' "Earlier review assessment: This remedy is withdrawn."';}))).toBe(true);});
 test('native completion and menu ownership remain required',()=>{
  for(const fn of [(c:NativePlanQuestionCall)=>{c.sessionId='';},(c:NativePlanQuestionCall)=>{c.toolUseId='';},(c:NativePlanQuestionCall)=>{c.answered=false;},(c:NativePlanQuestionCall)=>{c.failed=true;},(c:NativePlanQuestionCall)=>{delete c.failed;},(c:NativePlanQuestionCall)=>{delete c.answeredAt;},(c:NativePlanQuestionCall)=>{c.answeredAt='invalid';},(c:NativePlanQuestionCall)=>{c.answers={};},(c:NativePlanQuestionCall)=>{c.answers!['foreign']='foreign';},(c:NativePlanQuestionCall)=>{c.answers={[c.questions[0]!.question]:'unoffered'};},(c:NativePlanQuestionCall)=>{c.unansweredQuestionIndices=[0];},(c:NativePlanQuestionCall)=>{delete c.unansweredQuestionIndices;},(c:NativePlanQuestionCall)=>{c.questions.push(structuredClone(c.questions[0]!));},(c:NativePlanQuestionCall)=>{c.questions[0]!.multiSelect=true;}])expect(classify(mutate(fn))).toBe(false);
  for(const f of [{...fp(),signature:'foreign:tool'},{...fp(),nativeQuestionIndex:1},{...fp(),options:fp().options.toReversed()}])expect(ceoFirstReviewAUQ(f)).toBe(false);
 });
 test('malformed or competing identities and setup headers fail closed',()=>{
  for(const [a,b] of [['D4 —','D04 —'],['Section 1 (','Section 01 ('],['issue 1:','issue 0:'],['issue 1:','issue 1.2:'],['(Architecture)','(Source excerpt)']])expect(classify(text(s=>s.replace(a,b)))).toBe(false);
  for(const h of ['Section 9','Issue 9','Section 01','Routing','Approach'])expect(classify(mutate(c=>{c.questions[0]!.header=h;}))).toBe(false);
  expect(classify(mutate(c=>{c.questions[0]!.options[0]!.label=c.questions[0]!.options[0]!.label.replace('1A)','2A)');c.answers={[c.questions[0]!.question]:c.questions[0]!.options[0]!.label};}))).toBe(false);
 });
 test('unique current context and assessment cannot come from source or a conditional',()=>{
  for(const p of ['Source excerpt: ','Earlier review assessment: ','If approved, ','Provided approval, ','Assuming approval, '])for(const field of ['Project/branch/task: ','ELI10: '])expect(classify(text(s=>s.replace(field,field+p)))).toBe(false);
  for(const p of ['Source:\n','Earlier review assessment:\n','Project/branch/task: duplicate\n','ELI10: duplicate\n'])expect(classify(text(s=>s.replace('ELI10:',p+'ELI10:')))).toBe(false);
  expect(classify(text(s=>s.replace(/^Project\/branch\/task:.*\n/m,'')))).toBe(false);
 });
 test('current gap and actual commit-then-notify action stay mandatory',()=>{
  expect(classify(text(s=>s.replace('but never says whether the email runs inside the database transaction or after it commits','and explicitly specifies that email follows the database commit')))).toBe(false);
  for(const [a,b] of [['COMMIT, then call the mail client','call the mail client, then COMMIT'],['Load user and orders, assign payment_status=paid and PaymentIntent ID, COMMIT, then call the mail client','Record this plan as complete'],['Mail failure can never roll back a committed payment','Mail failure can roll back the payment']])expect(classify(mutate(c=>{const o=c.questions[0]!.options[0]!;o.description=o.description!.replace(a,b);}))).toBe(false);
  expect(classify(mutate(c=>{c.questions[0]!.options[0]!.label='1A) Save the review';c.answers={[c.questions[0]!.question]:c.questions[0]!.options[0]!.label};}))).toBe(false);
 });
 test('direct current status and action cancellation close their owners',()=>{
  for(const s of ['withdrawn','superseded','"closed"','“withdrawn”']){expect(classify(text(t=>t+` This finding is ${s}.`))).toBe(false);expect(classify(mutate(c=>{c.questions[0]!.options[0]!.description+=` This amendment is ${s}.`;}))).toBe(false);}
  expect(classify(mutate(c=>{c.questions[0]!.options[0]!.description+=' Correction: do not commit before sending email.';}))).toBe(false);
  expect(classify(text(s=>s+' Correction: this ordering gap is resolved.'))).toBe(false);
 });
 test('source or conditional options cannot supply the amendment',()=>{for(const p of ['Source excerpt: ','Earlier review assessment: ','If approved, ','Provided approval, ']){expect(classify(mutate(c=>{c.questions[0]!.options[0]!.description=p+c.questions[0]!.options[0]!.description;}))).toBe(false);expect(classify(mutate(c=>{const q=c.questions[0]!;q.options[0]!.label=q.options[0]!.label.replace('1A) ','1A) '+p);c.answers={[q.question]:q.options[0]!.label};}))).toBe(false);}});
});
