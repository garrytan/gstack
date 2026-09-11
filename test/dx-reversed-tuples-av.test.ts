import {describe,expect,test} from 'bun:test';
import {devexSeedCoverage} from './helpers/devex-seed-coverage';
import fixture from './fixtures/dx-reversed-tuples-av.json';

const fresh=()=>structuredClone(fixture.call) as any;
const coverage=(call:any)=>devexSeedCoverage({status:'ready',calls:[call],assistantMessages:[]} as any);
const ids=(call:any)=>coverage(call).decisions['reversed-arguments'];
function question(call:any,change:(text:string)=>string){const q=call.questions[0],old=q.question,answer=call.answers[old];q.question=change(old);call.answers={[q.question]:answer};}
function title(call:any,change:(text:string)=>string){question(call,text=>{const [first,...rest]=text.split('\n');return[change(first!),...rest].join('\n');});}
const rejected=(mutate:(call:any)=>void)=>{const call=fresh();mutate(call);expect(ids(call)).toEqual([]);};

describe('DX current named functions with reversed tuple arguments',()=>{
 test('counts the exact completed D7 decision without crediting an entire review',()=>{
  const call=fresh();expect(fixture.provenance.paidOutcomesReclassified).toBe(false);
  expect(ids(call)).toEqual([`${call.sessionId}:${call.toolUseId}`]);
  expect(coverage(call).complete).toBe(false);
  expect(coverage(call).batched).toEqual([]);expect(coverage(call).invalid).toEqual([]);
 });
 test.each(['while','inline code','spacing','no journey label','reverse orientation'])('tuple structure permits %s',form=>{
  const call=fresh();title(call,t=>form==='while'?t.replace(' but ',' while '):form==='inline code'?t.replace('run_eval','`run_eval`').replace('run_batch','`run_batch`').replace('(dataset, evaluator)','`(dataset, evaluator)`').replace('(evaluator, dataset)','`(evaluator, dataset)`'):form==='spacing'?t.replace('(dataset, evaluator)','( dataset , evaluator )').replace('(evaluator, dataset)','( evaluator , dataset )'):form==='no journey label'?t.replace('Journey stage REAL USAGE: ',''):t.replace('(dataset, evaluator)','(evaluator, dataset)').replace('run_batch takes (evaluator, dataset)','run_batch takes (dataset, evaluator)'));
  expect(ids(call)).toHaveLength(1);
 });
 test.each(['same order','different sets','duplicates','unknown parameters','wrong function','negated assertion'])('rejects %s',form=>{
  rejected(call=>title(call,t=>form==='same order'?t.replace('run_batch takes (evaluator, dataset)','run_batch takes (dataset, evaluator)'):form==='different sets'?t.replace('run_batch takes (evaluator, dataset)','run_batch takes (evaluator, records)'):form==='duplicates'?t.replace(/\((?:dataset, evaluator|evaluator, dataset)\)/g,'(dataset, dataset)'):form==='unknown parameters'?t.replace(/dataset/g,'items').replace(/evaluator/g,'callback'):form==='wrong function'?t.replace('run_batch','run_other'):t.replace('run_eval takes','run_eval does not take')));
 });
 test.each(['"','`','> '])('whole quoted/source statement stays non-current: %s',mark=>{
  rejected(call=>title(call,t=>t.replace(/^(D7 — )(.*)$/s,`$1${mark}$2${mark==='> '?'':mark}`)));
 });
 test.each(['Historical assessment.','Source:','Hypothetical scenario.','If approved,','Assuming approval,'])('rejects current evidence introduced as %s',prefix=>{
  rejected(call=>question(call,t=>t.replace('ELI10: ',`ELI10: ${prefix} `)));
 });
 test.each(['withdrawn','rejected','not current','no longer current'])('owned status %s rejects the finding and offered action',status=>{
  for(const quote of ['',"'",'"','`']){
   rejected(call=>question(call,t=>`${t}\nThis finding is ${quote}${status}${quote}.`));
   rejected(call=>{for(const option of call.questions[0].options)option.description+=`\nThis option is ${quote}${status}${quote}.`;});
  }
 });
 test('quoted historical withdrawals do not withdraw the current decision',()=>{
  const call=fresh();question(call,t=>`${t}\nEarlier reviewer said "This finding is withdrawn."`);
  for(const option of call.questions[0].options)option.description+='\nEarlier reviewer said "This option is withdrawn."';
  expect(ids(call)).toHaveLength(1);
 });
 test('current conditional or resolved evidence does not establish an unresolved reversal',()=>{
  for(const status of ['This finding applies if approved.','These functions are now aligned.','run_eval and run_batch now use the same positional order.'])
   rejected(call=>question(call,t=>`${t}\n${status}`));
  for(const status of ['This option applies once approved.','Do not align both functions.','Never change these signatures.'])
   rejected(call=>{for(const option of call.questions[0].options)option.description+=`\n${status}`;});
 });
 test('the current repair must belong to one offered option for these functions',()=>{
  for(const options of [
   [{label:'Align',description:'Review the naming.'},{label:'Document the order',description:'Keep the current functions.'}],
   [{label:'Align order',description:'Change the CLI flags only.'},{label:'Keep both functions',description:'No signature change.'}],
   [{label:'Keep current behavior',description:'Earlier reviewer said "Both functions align argument order."'},{label:'Document the status quo',description:'No implementation change.'}],
  ])rejected(call=>{call.questions[0].options=options;call.answers={[call.questions[0].question]:options[0]!.label};});
 });
 test.each(['unanswered','failed','missing timestamp','pending item','missing answer','foreign answer','duplicate labels','multiple questions'])('does not manufacture native completion: %s',state=>{
  rejected(call=>{if(state==='unanswered')call.answered=false;else if(state==='failed')call.failed=true;else if(state==='missing timestamp')call.answeredAt='';else if(state==='pending item')call.unansweredQuestionIndices=[0];else if(state==='missing answer')call.answers={};else if(state==='foreign answer')call.answers={[call.questions[0].question]:'Unlisted option'};else if(state==='duplicate labels')call.questions[0].options[1].label=call.questions[0].options[0].label;else call.questions.push(structuredClone(call.questions[0]));});
 });
});

// Independent review found that semicolons must retain the same current owner.
test('tuple currentness is preserved at a semicolon boundary',()=>{
 for(const statement of ['This finding is withdrawn.','This finding is "withdrawn".','This finding is `no longer current`.','D7 is withdrawn.','These functions are now aligned.','run_eval and run_batch now use the same positional order.']) {
  rejected(call=>question(call,t=>t+'\nAssessment complete; '+statement));
  for(const history of ['Historical reviewer said "Assessment complete; '+statement.replaceAll('"','')+'"','```\nAssessment complete; '+statement+'\n```']){
   const call=fresh();question(call,t=>t+'\n'+history);expect(ids(call)).toHaveLength(1);
  }
 }
 for(const statement of ['This option is withdrawn.','This option is `no longer current`.','Do not align both functions.']) {
  rejected(call=>{for(const option of call.questions[0].options)option.description+='\nAssessment complete; '+statement;});
  const call=fresh();for(const option of call.questions[0].options)option.description+='\nHistorical reviewer said "Assessment complete; '+statement.replaceAll('"','')+'"';expect(ids(call)).toHaveLength(1);
 }
});
