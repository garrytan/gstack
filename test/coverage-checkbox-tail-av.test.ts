import {expect,test} from 'bun:test';
import fixture from './fixtures/coverage-checkbox-tail-av.json';
import {coverageAuditReadEvidence,coverageAuditVerdict} from './helpers/coverage-audit-evidence';
import {E2E_TOUCHFILES,LLM_JUDGE_TOUCHFILES,selectTests} from './helpers/touchfiles';
const both={sourceRead:true,testsRead:true}, neither={sourceRead:false,testsRead:false};
const fresh=(i=0)=>{const row=structuredClone(fixture.attempts[i]!) as any;return{row,use:row.result.transcript[1].message.content[0],ack:row.result.transcript[2].message.content[0]};};
const reads=(mutate:(s:ReturnType<typeof fresh>)=>void=()=>{})=>{const s=fresh();mutate(s);return coverageAuditReadEvidence(s.row.result.transcript,s.row.files);};
const base='```text\nprocessPayment(amount, currency)\n├── happy return success [x]\nrefundPayment(paymentId, reason)\n└── happy return refunded [ ]\nLegend: [x] tested [ ] no test\n```';
const diagram=(output:string)=>{const {row}=fresh();return coverageAuditVerdict({...row.result,output},row.files).diagram;};

test('both exact public attempts now provide their delivered files and owned checkbox diagram',()=>{
 expect(fixture.provenance.paidOutcomesReclassified).toBe(false);
 for(const row of fixture.attempts){expect(row.provenance.recordedPassed).toBe(false);expect(coverageAuditVerdict(row.result as any,row.files)).toEqual({...both,diagram:true,passed:true,failures:[]});}
});

test('mixed display tail accepts only the two ordered owned reads and literal separators',()=>{
 expect(reads()).toEqual(both);
 for(const revision of ['HEAD','HEAD~1','main..HEAD'])expect(reads(s=>{s.use.input.command=s.use.input.command.replace('main..HEAD',revision).replace('diff main','diff '+revision);})).toEqual(both);
 expect(reads(s=>{s.use.input.command=s.use.input.command.replaceAll('echo ====','echo ----');s.ack.content=s.ack.content.replaceAll('====','----');})).toEqual(both);
 expect(reads(s=>{s.use.input.command=s.use.input.command.replace('src/billing.ts',"'src/billing.ts'").replace('test/billing.test.ts','"test/billing.test.ts"');})).toEqual(both);
 expect(reads(s=>{s.ack.content=[{type:'text',text:s.ack.content}];})).toEqual(both);
 expect(reads(s=>{s.ack.content+='\nabc1234 harmless commit subject\n src/billing.ts | 2 ++\n 1 file changed, 2 insertions(+)';})).toEqual(both);
});

test.each([
 'false && cat -n src/billing.ts && cat -n test/billing.test.ts && git log --oneline main..HEAD; git diff main --stat',
 'cat -n src/billing.ts && false && cat -n test/billing.test.ts && git log --oneline main..HEAD; git diff main --stat',
 'cat -n fake.ts && cat -n test/billing.test.ts && git log --oneline main..HEAD; git diff main --stat',
 'cat -n src/billing.ts && cat -n src/billing.ts && git log --oneline main..HEAD; git diff main --stat',
 'cat -n src/billing.ts && cat -n test/billing.test.ts; git log --oneline main..HEAD; git diff main --stat',
 'cat -n src/billing.ts; cat -n test/billing.test.ts && git log --oneline main..HEAD; git diff main --stat',
])('a failed, skipped, duplicate or unrelated read cannot borrow display-tail success: %s',command=>{
 expect(reads(s=>{s.use.input.command=command;})).toEqual(neither);
});

test.each([
 ['git log --oneline main..HEAD','git log --format=%B main..HEAD'],
 ['git log --oneline main..HEAD','git log --oneline --output=src/billing.ts main..HEAD'],
 ['git log --oneline main..HEAD','git -c core.pager=evil log --oneline main..HEAD'],
 ['git diff main --stat','git diff --ext-diff main --stat'],
 ['git diff main --stat','git diff --no-index main --stat'],
 ['git diff main --stat','git diff main --stat; echo extra'],
 ['git diff main --stat','git diff main --stat > src/billing.ts'],
 ['echo ====','echo replacement'],['echo ====','printf ===='],['echo ====','echo -e "\\nreplacement"'],
 ['cat -n src/billing.ts','cat -n src/billing.ts > test/billing.test.ts'],
 ['cat -n src/billing.ts','cat -n $(echo src/billing.ts)'],
 ['cat -n src/billing.ts','rm src/billing.ts'],
])('replacement output or mutation stays outside the closed display-tail form', (old,next)=>{
 expect(reads(s=>{s.use.input.command=s.use.input.command.replace(old,next);})).toEqual(neither);
});

test('the native result must deliver exact ordered complete reads, even when Git hides a prefix failure',()=>{
 for(const mutate of [
  (s:ReturnType<typeof fresh>)=>{s.ack.is_error=true;},
  (s:ReturnType<typeof fresh>)=>{s.ack.content='cat: src/billing.ts: No such file\n'+s.ack.content;},
  (s:ReturnType<typeof fresh>)=>{s.ack.content=s.ack.content.replace('====\n','====\ncat: test/billing.test.ts: Permission denied\n');},
  (s:ReturnType<typeof fresh>)=>{s.ack.content=s.row.files.source.content;},
  (s:ReturnType<typeof fresh>)=>{s.ack.content=s.row.files.tests.content;},
  (s:ReturnType<typeof fresh>)=>{s.ack.content=s.ack.content.replace("return { status: 'success', amount, currency };","return undefined;");},
  (s:ReturnType<typeof fresh>)=>{const parts=s.ack.content.split('====');s.ack.content=parts[1]+'===='+parts[0]+'====';},
  (s:ReturnType<typeof fresh>)=>{s.row.result.transcript[2].session_id='foreign';},
  (s:ReturnType<typeof fresh>)=>{s.row.result.transcript[2].parent_tool_use_id='child';},
  (s:ReturnType<typeof fresh>)=>{s.ack.tool_use_id='foreign';},
  (s:ReturnType<typeof fresh>)=>{s.row.result.transcript.push(structuredClone(s.row.result.transcript[2]));},
 ])expect(reads(mutate)).toEqual(neither);
});

test('checkbox legends permit current synonyms, pair order, above/below placement and case',()=>{
 for(const legend of ['Legend: [x] tested [ ] no test','Legend [x] covered by an existing test; [ ] no test reaches this path','Legend: [ ] untested | [X] covered'])expect(diagram(base.replace('Legend: [x] tested [ ] no test',legend))).toBe(true);
 expect(diagram(base.replaceAll('[x]','[X]'))).toBe(true);
 expect(diagram(base.replace('Legend: [x] tested [ ] no test\n','').replace('processPayment','Legend: [x] tested [ ] no test\nprocessPayment'))).toBe(true);
});

test.each(['','> Legend: [x] tested [ ] no test','"Legend: [x] tested [ ] no test"','Source: Legend: [x] tested [ ] no test','If approved, Legend: [x] tested [ ] no test','Legend: [x] untested [ ] covered','Legend: [x] tested [ ] covered','Legend: [x] tested [x] no test','Legend: [x] tested [ ] no test except refunds','Legend: [x] tested [ ] no test\nLegend: [x] untested [ ] covered'])('missing or contradictory checkbox key gives no diagram coverage: %s',legend=>{
 expect(diagram(base.replace('Legend: [x] tested [ ] no test',legend))).toBe(false);
});

test('checkbox meanings cannot come from another block, stale key, or source declaration',()=>{
 expect(diagram('```\nLegend: [x] tested [ ] no test\n```\n'+base.replace('Legend: [x] tested [ ] no test\n',''))).toBe(false);
 for(const status of ['withdrawn','`no longer current`',"'superseded'",'“rejected”'])for(const boundary of ['\n','\nAssessment complete; '])expect(diagram(base.replace('\n```',boundary+'This legend is '+status+'.\n```'))).toBe(false);
 for(const statement of ['  This legend is withdrawn.','**This legend** is `no longer current`.','This legend applies only if approved.'])expect(diagram(base.replace('\n```','\n'+statement+'\n```'))).toBe(false);
 expect(diagram(base.replace('\n```','\nEarlier reviewer said "This legend is withdrawn."\n```'))).toBe(true);
 expect(diagram(base.replace('\n```','\n> Earlier note; This legend is withdrawn.\n```'))).toBe(true);
 for(const prefix of ['Source:','Historical note:','Hypothetical:'])expect(diagram(base.replace('Legend:',prefix+'\nLegend:'))).toBe(false);
});

test('checkbox states retain final correction, function subtree and column ownership',()=>{
 expect(diagram(base.replace('success [x]','success [ ] -> [x]'))).toBe(true);
 expect(diagram(base.replace('refunded [ ]','refunded [x] → [ ]'))).toBe(true);
 for(const [old,next]of [['success [x]','success [x] [ ]'],['refunded [ ]','refunded [ ] [x]'],['success [x]','success not [x]'],['refunded [ ]','refunded [ ] is incorrect'],['success [x]','success never covered [x]'],['refunded [ ]','refunded no coverage gaps [ ]'],['success [x]','success [x] -> [ ]'],['refunded [ ]','refunded [ ] → [x]'],['success [x]','success    ├── [x]'],['refunded [ ]','refunded    └── [ ]']])expect(diagram(base.replace(old!,next!))).toBe(false);
 for(const name of ['processPayment','refundPayment'])expect(diagram(base.replace(name,'unrelated'))).toBe(false);
 expect(diagram(base.replace('└── happy','otherFunction()\n└── happy'))).toBe(false);
 expect(diagram(base.split('\n').map(l=>'> '+l).join('\n'))).toBe(false);
 expect(diagram('````markdown\n'+base+'\n````')).toBe(false);
 expect(diagram('Example:\n'+base)).toBe(false);
});

test('all three existing coverage consumers are selected without judge expansion',()=>{
 for(const file of ['test/coverage-checkbox-tail-av.test.ts','test/fixtures/coverage-checkbox-tail-av.json']){
  expect(selectTests([file],E2E_TOUCHFILES,[]).selected.sort()).toEqual(['plan-eng-coverage-audit','review-coverage-audit','ship-coverage-audit']);
  expect(selectTests([file],LLM_JUDGE_TOUCHFILES,[]).selected).toEqual([]);
 }
});
