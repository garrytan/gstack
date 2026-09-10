import {expect, test} from 'bun:test';
import {ceoFirstReviewAUQ, nativePlanCallFingerprint} from './helpers/claude-pty-runner';
import fixture from './fixtures/ceo-decision-prefix-al.json';
import {E2E_TOUCHFILES} from './helpers/touchfiles-data';
const call=(n=0):any=>structuredClone(fixture.calls[n]);
const accepts=(c:any)=>ceoFirstReviewAUQ(nativePlanCallFingerprint(c,0,true));
function text(c:any,fn:(s:string)=>string){const q=c.questions[0],a=c.answers[q.question];q.question=fn(q.question);c.answers={[q.question]:a};}
function menu(c:any,fn:(o:any,i:number)=>void){const q=c.questions[0],i=q.options.findIndex((o:any)=>o.label===c.answers[q.question]);q.options.forEach(fn);c.answers={[q.question]:q.options[i].label};}
test('the actual completed email finding uses decision-prefixed options and a bare recommendation',()=>expect(accepts(call())).toBe(true));
test('the actual completed SQL finding includes a raw SQL qualifier',()=>expect(accepts(call(1))).toBe(true));
test('decision and finding identifiers remain independent when consistently renamed',()=>{
 for(const n of [0,1]){
  for(const dotted of [false,true]){const c=call(n);text(c,s=>s.replace(/^D\d+/,'D27').replace(/\(Finding \d+\)/,`(Finding ${dotted?'8.3':'8'})`));menu(c,o=>{o.label=o.label.replace(/^\d+/,'27')});expect(accepts(c)).toBe(true);}
  const c=call(n);menu(c,o=>{o.label=o.label.replace(/^\d+/,'')});text(c,s=>s.replace("'no error handling on the email leg'",'no error handling on the email leg').replace('a raw SQL fragment','a SQL fragment'));expect(accepts(c)).toBe(true);
  const q=call(n);text(q,s=>s+'\nOld note: "This finding is withdrawn."');expect(accepts(q)).toBe(true);
  const lower=call(n);text(lower,s=>s.replace(/^D/,'d'));expect(accepts(lower)).toBe(true);
 }
});
test('native ownership, offered answers and unambiguous decision identities are mandatory',()=>{
 for(const mutate of [
  (c:any)=>{c.answered=false},(c:any)=>{c.failed=true},(c:any)=>{c.unansweredQuestionIndices=[0]},(c:any)=>{c.sessionId=''},
  (c:any)=>{c.answers={}},(c:any)=>{c.answers[c.questions[0].question]='A'},(c:any)=>{c.questions[0].multiSelect=true},
  (c:any)=>{c.questions[0].header='Finding 9'},(c:any)=>{c.questions[0].header='Approach'},
  (c:any)=>text(c,s=>s.replace(/^D4/,'D9')),
  (c:any)=>menu(c,o=>{o.label=o.label.replace(/^4/,'9')}),
  (c:any)=>menu(c,(o,i)=>{if(i===1)o.label=o.label.replace(/^4/,'9')}),
  (c:any)=>menu(c,(o,i)=>{if(i===1)o.label=o.label.replace(/^4/,'')}),
  (c:any)=>text(c,s=>s.replace(/^Recommendation: A/m,'Recommendation: 9A')),
  (c:any)=>text(c,s=>s.replace(/^Recommendation: A/m,'Recommendation: Z')),
  (c:any)=>menu(c,(o,i)=>{if(i===1)o.label=o.label.replace(/^4B/,'4A')}),
  (c:any)=>{c.questions[0].options[1].description=''},
 ]){const c=call();mutate(c);expect(accepts(c)).toBe(false);}
 const f=nativePlanCallFingerprint(call(),0,true);expect(ceoFirstReviewAUQ({...f,signature:'foreign:tool'})).toBe(false);
});
test('embedded quoted contract terms cannot supply a hypothetical, historical or withdrawn assessment',()=>{
 for(const n of [0,1])for(const fn of [
  (s:string)=>'Source excerpt: '+s,(s:string)=>'> '+s,(s:string)=>'```\n'+s+'\n```',
  (s:string)=>s.replace(/^ELI10: (.+)$/m,'ELI10: "$1"'),
  (s:string)=>s.replace(/^ELI10: /m,'ELI10: If approved, '),
  (s:string)=>s.replace(/^ELI10: /m,'ELI10: Source excerpt. '),
  (s:string)=>s.replace(/^ELI10: /m,'ELI10: The following is a historical source excerpt. '),
  (s:string)=>s.replace(/^ELI10: /m,'ELI10: Previously, '),
  (s:string)=>s+'\nThis finding is withdrawn.',
  (s:string)=>s+'\nNo current defect remains.',
  (s:string)=>s.replace(/^ELI10: .+$/m,'ELI10: The plan sends the email inline with \'no error handling\' only in a historical example.'),
  (s:string)=>s.replace(/^ELI10: .+$/m,'ELI10: The plan does not send the email inline with \'no error handling\'.'),
  (s:string)=>s.replace(/^ELI10: .+$/m,'ELI10: The plan used to paste the user ID straight into a raw SQL fragment. The current query is parameterized.'),
  (s:string)=>s.replace(/^ELI10: .+$/m,'ELI10: A proposed example pastes the user ID string straight into a raw SQL fragment.'),
  (s:string)=>s.replace(/^ELI10: .+$/m,'ELI10: The historical example pastes the user ID string straight into a raw SQL fragment.'),
  (s:string)=>s.replace(/^ELI10: .+$/m,'ELI10: A template pastes the user ID string straight into a raw SQL fragment.'),
  (s:string)=>s.replace(/^ELI10: .+$/m,'ELI10: An unrelated example pastes the user ID string straight into a raw SQL fragment.'),
  (s:string)=>s.replace(/^ELI10: .+$/m,'ELI10: The plan pastes the user ID string straight into a raw SQL fragment only in a hypothetical example.'),
 ]){const c=call(n);text(c,fn);expect(accepts(c)).toBe(false);}
});
test('a substantive current assessment still needs an offered technical amendment',()=>{
 for(const description of ['Archive this report.','If approved: ✅ Rescue named mail exceptions.','Source excerpt: ✅ Rescue named mail exceptions.','❌ Rescue named mail exceptions.','✅ "Rescue named mail exceptions."']){
  const c=call();menu(c,(o,i)=>{o.label=`4${String.fromCharCode(65+i)}: Consider candidate ${i}`;o.description=description});expect(accepts(c)).toBe(false);
 }
});
test('only the existing CEO count owner selects the captured regression',()=>{
 for(const dependency of E2E_TOUCHFILES['plan-ceo-finding-count']) expect(typeof dependency).toBe('string');
 for(const d of ['test/ceo-decision-prefix-al.test.ts','test/fixtures/ceo-decision-prefix-al.json'])expect(Object.entries(E2E_TOUCHFILES).filter(([,v])=>v.includes(d)).map(([k])=>k)).toEqual(['plan-ceo-finding-count']);
});
