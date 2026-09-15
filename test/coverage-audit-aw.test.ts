import {describe,expect,test} from 'bun:test';
import {coverageAuditReadEvidence,coverageAuditVerdict} from './helpers/coverage-audit-evidence';
import fixture from './fixtures/coverage-audit-aw.json';
const fresh=(n=0)=>{
 const r=structuredClone(fixture.reads[n]!),files={cwd:r.cwd,source:{path:r.cwd+'/src/billing.ts',content:fixture.source},tests:{path:r.cwd+'/test/billing.test.ts',content:fixture.tests}};
 const transcript:any[]=[{type:'system',subtype:'init',session_id:r.sessionId,cwd:r.cwd},{type:'assistant',session_id:r.sessionId,parent_tool_use_id:null,message:{role:'assistant',content:[{type:'tool_use',id:r.toolUseId,name:'Bash',input:{command:r.command}}]}},{type:'user',session_id:r.sessionId,parent_tool_use_id:null,message:{role:'user',content:[{type:'tool_result',tool_use_id:r.toolUseId,is_error:false,content:r.outputExcerpt}]}}];
 return {files,transcript};
};
const reads=(x:ReturnType<typeof fresh>)=>coverageAuditReadEvidence(x.transcript,x.files);
const diagram=(text:string)=>{const x=fresh();return coverageAuditVerdict({exitReason:'success',browseErrors:[],output:text,transcript:x.transcript} as any,x.files).diagram;};
describe('Coverage audit owned display composition and marker continuations',()=>{
 test.each([0,1,2,3])('credits exact complete public file delivery %i',n=>{
  expect(fixture.provenance.actualCollectorFailuresRetained).toBe(true);expect(reads(fresh(n))).toEqual({sourceRead:true,testsRead:true});
 });
 test.each(['failed result','foreign session','foreign cwd','foreign tool id','sidechain','missing result','repeated result','partial body','forged body'])('rejects %s',form=>{
  for(let n=0;n<4;n++){const x=fresh(n),e=x.transcript[2],b=e.message.content[0];if(form==='failed result')b.is_error=true;else if(form==='foreign session')e.session_id='foreign';else if(form==='foreign cwd')x.transcript[0].cwd+='/other';else if(form==='foreign tool id')b.tool_use_id='foreign';else if(form==='sidechain')e.parent_tool_use_id='parent';else if(form==='missing result')x.transcript.pop();else if(form==='repeated result')x.transcript.push(structuredClone(e));else if(form==='partial body')b.content=b.content.replace(/.*(?:export function processPayment|import \{ describe).*\n/g,'');else b.content='src/billing.ts and test/billing.test.ts were read';expect(reads(x)).toEqual({sourceRead:false,testsRead:false});}
 });
 test.each(['foreign paths','printf forgery','echo escape forgery','expansion','double quoted expansion','awk execution','changed ordered prefix'])('rejects unsupported or unowned command: %s',form=>{
  const n=form==='awk execution'?2:form==='changed ordered prefix'?3:0,x=fresh(n),u=x.transcript[1].message.content[0];u.input.command=form==='foreign paths'?u.input.command.replaceAll('src/billing.ts','other/billing.ts').replaceAll('test/billing.test.ts','other/billing.test.ts'):form==='printf forgery'?"printf 'fixture body'":form==='echo escape forgery'?"echo -e 'fake\\nbody'":form==='expansion'?u.input.command+'; echo $(cat source)':form==='double quoted expansion'?u.input.command+'; echo "$HOME"':form==='awk execution'?u.input.command.replace('{f=1}','{system("cat forged") }'):u.input.command.replace('=== src/billing.ts ===','=== other.ts ===');expect(reads(x)).toEqual({sourceRead:false,testsRead:false});
 });
 test.each([0,1])('accepts the exact public current diagram %i',n=>expect(diagram(fixture.diagrams[n]!.text)).toBe(true));
 test.each(['missing key','inverted checkbox key','withdrawn key','foreign function','quoted source','not covered','not missing'])('rejects contradictory or unowned checkbox coverage: %s',form=>{
  const text=fixture.diagrams[0]!.text;const changed=form==='missing key'?text.replace(/^Legend:.*\n/m,''):form==='inverted checkbox key'?text.replace('[x] tested   [ ] GAP','[x] untested   [ ] tested'):form==='withdrawn key'?text.replace('src/billing.ts\n│','This legend is withdrawn.\nsrc/billing.ts\n│'):form==='foreign function'?text.replaceAll('refundPayment','otherPayment'):form==='quoted source'?'Example only:\n'+text:form==='not covered'?text.replace("[x] 'processes valid payment'","[ ] GAP"):text.replaceAll('[ ] GAP','[x] tested');expect(diagram(changed)).toBe(false);
 });
 test('continuations keep their own row and cannot borrow from prose or a distant column',()=>{
  const text=fixture.diagrams[1]!.text;
  expect(diagram(text.replace('│           [✓] billing.test.ts:6', '│           Earlier example:\n│           [✓] billing.test.ts:6'))).toBe(false);
  expect(diagram(text.replace('│           [✓] billing.test.ts:6', '                                                              [✓] billing.test.ts:6'))).toBe(false);
  expect(diagram(text.replace('│           [✓] billing.test.ts:6', '│           [✗] billing.test.ts:6'))).toBe(false);
  expect(diagram(text.replaceAll('[✗] GAP','[✓] tested').replace('[✗] untested (GAP)','[✗] untested (GAP)'))).toBe(false);
 });
});
