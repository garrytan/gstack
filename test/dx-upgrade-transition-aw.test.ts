import {describe,expect,test} from 'bun:test';
import {devexSeedCoverage} from './helpers/devex-seed-coverage';
import fixture from './fixtures/dx-upgrade-transition-aw.json';
const fresh=()=>structuredClone(fixture.call) as any;
const coverage=(call:any)=>devexSeedCoverage({status:'ready',calls:[call],assistantMessages:[]} as any);
const ids=(call:any)=>coverage(call).decisions['breaking-upgrade'];
function question(call:any,change:(text:string)=>string){const q=call.questions[0],old=q.question,answer=call.answers[old];q.question=change(old);call.answers={[q.question]:answer};}
const rejected=(mutate:(call:any)=>void)=>{const c=fresh();mutate(c);expect(ids(c)).toEqual([]);};
describe('DX named method transition with owned missing compatibility',()=>{
 test('counts the exact acknowledged question without crediting a whole review',()=>{
  const c=fresh();expect(fixture.provenance.paidOutcomesReclassified).toBe(false);expect(ids(c)).toEqual([`${c.sessionId}:${c.toolUseId}`]);expect(coverage(c).complete).toBe(false);
 });
 test.each(['plain identifiers','different question wording','different source citation','removes old method'])('accepts %s',form=>{
  const c=fresh();question(c,t=>form==='plain identifiers'?t.replaceAll('`',''):form==='different question wording'?t.replace('Give v1 users a soft landing when','Protect existing users when'):form==='different source citation'?t.replace('docs/api.md lines 15-18 say version 2','The current release specification'):t.replace('deletes the old name immediately','removes the old method immediately'));expect(ids(c)).toHaveLength(1);
 });
 test.each(['foreign old method','foreign new method','missing explanation','second explanation','missing removal','missing compatibility gap','negated rename','conditional explanation','conditional title'])('rejects %s',form=>{
  rejected(c=>question(c,t=>form==='foreign old method'?t.replace('ELI10: docs/api.md lines 15-18 say version 2 renames `Client.evaluate()`','ELI10: docs/api.md lines 15-18 say version 2 renames `Client.score()`'):form==='foreign new method'?t.replace('to `Client.run()` and deletes','to `Client.score()` and deletes'):form==='missing explanation'?t.replace(/^ELI10:.*\n/m,''):form==='second explanation'?t+'\nELI10: Another competing explanation.':form==='missing removal'?t.replace('deletes the old name immediately','keeps the old name available'):form==='missing compatibility gap'?t.replace('with no compatibility alias','with a compatibility alias'):form==='negated rename'?t.replace('version 2 renames','version 2 does not rename'):form==='conditional explanation'?t.replace('ELI10: ','ELI10: If approved, '):t.replace('Give v1 users','If accepted, give v1 users')));
 });
 test.each(['Source:','Historical assessment.','Hypothetical scenario.','Assuming approval,'])('rejects an explanation introduced as %s',prefix=>{
  rejected(c=>question(c,t=>t.replace('ELI10: ',`ELI10: ${prefix} `)));
 });
 test.each(['"','`','> '])('rejects a whole quoted explanation or question: %s',mark=>{
  const end=mark==='> '?'':mark;
  // A whole inline-code quotation cannot itself contain nested backticks.
  if(mark==='`') { rejected(c=>question(c,t=>t.replaceAll('`','').replace(/^(ELI10: )(.*)$/m,'$1`$2`'))); rejected(c=>question(c,t=>t.replaceAll('`','').replace(/^(D6 — )(.*)$/m,'$1`$2`'))); return; }
  rejected(c=>question(c,t=>t.replace(/^(ELI10: )(.*)$/m,`$1${mark}$2${end}`)));
  rejected(c=>question(c,t=>t.replace(/^(D6 — )(.*)$/m,`$1${mark}$2${end}`)));
 });
 test('current status and approval conditions retain their owner across punctuation',()=>{
  for(const prefix of ['\n','\nAssessment complete; '])for(const quote of ['',"'",'"','`']){
   rejected(c=>question(c,t=>`${t}${prefix}This finding is ${quote}withdrawn${quote}.`));
   rejected(c=>question(c,t=>`${t}${prefix}D6 is ${quote}no longer current${quote}.`));
   rejected(c=>{for(const o of c.questions[0].options)o.description+=`${prefix}This option is ${quote}withdrawn${quote}.`;});
  }
  rejected(c=>question(c,t=>`${t}\nThis finding applies once approved.`));
  rejected(c=>{for(const o of c.questions[0].options)o.description+='\nThis option applies after approval.';});
 });
 test('history and foreign decision statuses do not cancel this current decision',()=>{
  const c=fresh();question(c,t=>`${t}\nEarlier reviewer said "This finding is withdrawn."\nD9 is withdrawn.`);for(const o of c.questions[0].options)o.description+='\nEarlier reviewer said "This option is withdrawn."';expect(ids(c)).toHaveLength(1);
 });
 test('current named resolution contradicts the gap while quoted history does not',()=>{
  for(const resolution of ['Client.evaluate() is now a compatibility alias.','`Client.evaluate()` is already a deprecated alias.']) {
   rejected(c=>question(c,t=>`${t}\nCorrection: ${resolution}`));
   const c=fresh();question(c,t=>`${t}\nEarlier reviewer said "${resolution.replaceAll('`','')}"`);expect(ids(c)).toHaveLength(1);
  }
 });
 test('one offered action must contain the compatibility repair',()=>{
  for(const options of [
   [{label:'Keep the removal',description:'No bridge.'},{label:'Delay the release',description:'More review time.'}],
   [{label:'Keep an alias',description:'One method.'},{label:'Write a warning and migration note',description:'Keep the hard removal.'}],
   [{label:'Source: Alias + warning',description:'Historical proposal.'},{label:'Keep the removal',description:'No bridge.'}],
  ])rejected(c=>{c.questions[0].options=options;c.answers={[c.questions[0].question]:options[0]!.label};});
  rejected(c=>{for(const o of c.questions[0].options)o.description+='\nDo not keep a compatibility alias.';});
 });
 test.each(['unanswered','failed','missing timestamp','pending item','missing answer','foreign answer','duplicate labels','multiple questions'])('preserves native completion: %s',state=>{
  rejected(c=>{if(state==='unanswered')c.answered=false;else if(state==='failed')c.failed=true;else if(state==='missing timestamp')c.answeredAt='';else if(state==='pending item')c.unansweredQuestionIndices=[0];else if(state==='missing answer')c.answers={};else if(state==='foreign answer')c.answers={[c.questions[0].question]:'Unlisted option'};else if(state==='duplicate labels')c.questions[0].options[1].label=c.questions[0].options[0].label;else c.questions.push(structuredClone(c.questions[0]));});
 });
});

// Independent review: negative/foreign compatibility wording is not a repair.
test('transition requires an affirmative alias action for the named method',()=>{
 for(const options of [
  [{label:'Remove it',description:'No alias, warning, or migration guide.'},{label:'Remove it later',description:'Delay hard removal one month.'}],
  [{label:'Keep the Payment alias + warning',description:'Payment.evaluate() stays as a deprecated alias; no Client compatibility.'},{label:'Remove the Client method',description:'Hard removal.'}],
  fresh().questions[0].options.slice(2),
  [{label:'Alias with warning',description:'Do not keep Client.evaluate() as a compatibility alias.'},{label:'Remove it',description:'Hard removal.'}],
 ])rejected(c=>{c.questions[0].options=options;c.answers={[c.questions[0].question]:options[0]!.label};});
 const c=fresh();c.questions[0].options[0].description='Keep Client.evaluate() as a compatibility alias with a warning and migration guide.';expect(ids(c)).toHaveLength(1);
});
