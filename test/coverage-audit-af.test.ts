import { expect, test } from 'bun:test';
import { coverageAuditVerdict } from './helpers/coverage-audit-evidence';
import fixture from './fixtures/coverage-audit-af.json';
import { E2E_TOUCHFILES } from './helpers/touchfiles';
import { posix, win32 } from 'node:path';
import { coverageAuditReadEvidence } from './helpers/coverage-audit-evidence';

const actual = (index: number) => structuredClone(fixture.rows[index]!);
const files = (row: typeof fixture.rows[number]) => ({cwd:row.cwd,
  source:{path:`${row.cwd}/src/billing.ts`,content:fixture.files.source},
  tests:{path:`${row.cwd}/test/billing.test.ts`,content:fixture.files.tests}});
for (let i=0;i<fixture.rows.length;i++) test(`AF exact public coverage audit ${i+1} binds delivered files and seeded diagram`, () => {
  const row=actual(i); expect(coverageAuditVerdict(row.result, files(row))).toEqual({sourceRead:true,testsRead:true,diagram:true,passed:true,failures:[]});
});

function delivered(command: string, mutate?: (events: any[]) => void) {
  const row=actual(2), session=row.sessionId;
  const transcript:any[]=[
    {type:'system',subtype:'init',session_id:session,cwd:row.cwd},
    {type:'assistant',session_id:session,parent_tool_use_id:null,message:{role:'assistant',content:[{type:'tool_use',id:'read-pair',name:'Bash',input:{command}}]}},
    {type:'user',session_id:session,parent_tool_use_id:null,message:{role:'user',content:[{type:'tool_result',tool_use_id:'read-pair',is_error:false,content:fixture.files.source+'\n----\n'+fixture.files.tests}]}},
  ];
  mutate?.(transcript);
  return coverageAuditVerdict({...row.result,transcript},files(row));
}
const both = 'cat -n src/billing.ts && cat -n test/billing.test.ts';

test('recorded POSIX and Windows paths bind reads independently of the replay host', () => {
  for (const [cwd, paths] of [['/owned/repo', posix], ['C:\\owned\\repo', win32]] as const) {
    const owned = {cwd, source:{path:paths.join(cwd,'src/billing.ts'),content:fixture.files.source},
      tests:{path:paths.join(cwd,'test/billing.test.ts'),content:fixture.files.tests}};
    const transcript = [
      {type:'system',subtype:'init',session_id:'owned',cwd},
      {type:'assistant',session_id:'owned',message:{role:'assistant',content:[{type:'tool_use',id:'pair',name:'Bash',input:{command:both}}]}},
      {type:'user',session_id:'owned',message:{role:'user',content:[{type:'tool_result',tool_use_id:'pair',is_error:false,content:fixture.files.source+'\n'+fixture.files.tests}]}},
    ];
    expect(coverageAuditReadEvidence(transcript,owned)).toEqual({sourceRead:true,testsRead:true});
    expect(coverageAuditReadEvidence(transcript,{...owned,source:{...owned.source,path:paths.join(cwd,'../foreign.ts')}}))
      .toEqual({sourceRead:false,testsRead:false});
    expect(coverageAuditReadEvidence(transcript,{...owned,source:{...owned.source,path:cwd+paths.sep+'src'+paths.sep+'..'+paths.sep+'src'+paths.sep+'billing.ts'}}))
      .toEqual({sourceRead:false,testsRead:false});
  }
});

test('AF complete literal reads permit a successful chain and one leading owned cwd assertion', () => {
  const cwd=actual(2).cwd;
  for (const command of [both, `cd ${cwd}; cat -n src/billing.ts; cat -n test/billing.test.ts`, `cd '${cwd}' && ${both}`, 'cat -n src/billing.ts; echo ----; cat -n test/billing.test.ts']) {
    const v=delivered(command); expect(v.sourceRead).toBe(true); expect(v.testsRead).toBe(true); expect(v.passed).toBe(true);
  }
});

test('AF the new conditional-chain grammar conservatively rejects mixed separators', () => {
  const v=delivered(`cd ${actual(2).cwd}; ${both}`);
  expect(v.sourceRead).toBe(false); expect(v.testsRead).toBe(false);
});

test('AF read recognition rejects foreign or midstream cwd changes and nonliteral targets', () => {
  const cwd=actual(2).cwd;
  for (const command of [`cd /foreign; ${both}`, `cat -n src/billing.ts; cd /foreign; cat -n test/billing.test.ts`,
    `cat -n src/billing.ts; cd ${cwd}; cat -n test/billing.test.ts`, `cd "$PWD"; ${both}`, `cd ${cwd}/..; ${both}`]) {
    const v=delivered(command); expect(v.sourceRead).toBe(false); expect(v.testsRead).toBe(false);
  }
});

test('AF a printed, conditional or skipped read cannot borrow delivered-looking file contents', () => {
  for (const command of [`false && ${both}`, `if false; then ${both}; fi`, `echo '${both}'`, `exit; ${both}`,
    `# ${both}`, `cat <<'EOF'\n${both}\nEOF`, `(${both})`, `f() { ${both}; }`, `printf '%s' '${both}'`,
    `printf expected; false && ${both}; true`, `${both} > result.txt`]) {
    const v=delivered(command); expect(v.sourceRead).toBe(false); expect(v.testsRead).toBe(false);
  }
});

test('AF an owned cwd does not authorize mutations or interpreters around a read', () => {
  for (const neighbor of ['rm -f src/billing.ts', 'python3 -c "pass"', 'echo fake > src/billing.ts',
    'grep data backup.txt | tee src/billing.ts', 'git diff --output=src/billing.ts',
    "git diff '--output=src/billing.ts'", "git diff --output'='src/billing.ts",
    'git diff --out=src/billing.ts', 'git diff --ext-diff']) {
    const result = delivered(`cd ${actual(2).cwd}; ${neighbor}; cat src/billing.ts; cat test/billing.test.ts`);
    expect(result.sourceRead).toBe(false); expect(result.testsRead).toBe(false);
  }
});

test('AF added command forms retain exact parent request/result success and delivered-content binding', () => {
  const mutations:Array<(events:any[])=>void>=[
    e=>{e[0].cwd='/foreign';}, e=>{e[2].session_id='foreign';},
    e=>{e[1].parent_tool_use_id='child';}, e=>{e[2].message.content[0].is_error=true;},
    e=>{e[2].message.content[0].tool_use_id='unpaired';},
    e=>{e[2].message.content[0].content='The two filenames were read.';},
  ];
  for (const mutate of mutations) { const v=delivered(both,mutate); expect(v.sourceRead).toBe(false); expect(v.testsRead).toBe(false); }
  const onlySource=delivered(both,e=>{e[2].message.content[0].content=fixture.files.source;});
  expect(onlySource.sourceRead).toBe(true); expect(onlySource.testsRead).toBe(false);
});

const flat = (legend = 'Legend: [✓] tested   [✗] GAP') => `\`\`\`text\n${legend}\nprocessPayment(amount, currency)\n├── [✓] happy path USD\nrefundPayment(paymentId, reason)\n└── [✗] happy path refund\n\`\`\``;
function diagram(output:string) { const row=actual(0);return coverageAuditVerdict({...row.result,output},files(row)).diagram; }

test('AF flat function roots and same-block legend symbols preserve seeded coverage ownership', () => {
  expect(diagram(flat())).toBe(true);
  expect(diagram(flat().replaceAll('✓','✔').replaceAll('✗','✘'))).toBe(true);
  expect(diagram(flat().replace('processPayment(amount, currency)\n├── [✓] happy path USD\nrefundPayment(paymentId, reason)\n└── [✗] happy path refund',
    'refundPayment(paymentId, reason)\n├── [✗] happy path refund\nprocessPayment(amount, currency)\n└── [✓] happy path USD'))).toBe(true);
});

test('AF symbol-only markers need an unambiguous legend in their own diagram block', () => {
  for (const output of [flat(''),flat('Legend: [✓] GAP   [✗] tested'),flat('Legend: [✓] tested   [✗] tested'),
    flat('Legend: [✓] tested   [✗] GAP   [✗] tested'),
    `\`\`\`text\nLegend: [✓] tested   [✗] GAP\n\`\`\`\n${flat('')}`]) expect(diagram(output)).toBe(false);
});

test('AF flat roots cannot borrow another function subtree or a quoted/example diagram', () => {
  for (const output of [
    flat().replace('├── [✓] happy path USD','├── untested amount guard\nunrelatedHelper()\n└── [✓] happy path USD'),
    flat().replace('refundPayment(paymentId, reason)','unrelatedRefund(paymentId, reason)'),
    flat().replace('processPayment(amount, currency)','processPaymentOther(amount, currency)'),
    flat().split('\n').map(line=>'> '+line).join('\n'),
    '````markdown\n'+flat()+'\n````',
    flat().replace('Legend:','Example diagram:\nLegend:'),
  ]) expect(diagram(output)).toBe(false);
});

test('AF a legend cannot override an explicitly negated marker on its own branch', () => {
  for (const output of [
    flat().replace('[✗] happy path refund','not [✗] happy path refund'),
    flat().replace('[✗] happy path refund','[✗] is false; this branch is tested'),
    flat().replace('[✓] happy path USD','not [✓] happy path USD'),
  ]) expect(diagram(output)).toBe(false);
});

test('AF coverage fixtures and controls select only the two existing coverage-audit owners', () => {
  for (const file of ['test/coverage-audit-af.test.ts','test/fixtures/coverage-audit-af.json']) {
    expect(Object.entries(E2E_TOUCHFILES).filter(([,paths])=>paths.includes(file)).map(([name])=>name).sort()).toEqual(['plan-eng-coverage-audit','review-coverage-audit']);
  }
});


test('AF symbol gaps retain affirmative legend ownership and reject same-branch contradictions', () => {
  for (const output of [
    flat().replace('[✗] happy path refund', '[✗] happy path refund (marker is incorrect; this branch is fully tested)'),
    flat().replace('[✗] happy path refund', '[✗] happy path refund — no coverage gap exists'),
    flat('An unproven hypothesis: [✓] tested   [✗] GAP'),
    flat("The source says '[✓] tested   [✗] GAP'"),
  ]) expect(diagram(output)).toBe(false);
  expect(diagram(flat())).toBe(true);
  expect(diagram(flat('[✓] tested   [✗] GAP'))).toBe(true);
  expect(diagram(flat('src/billing.ts — test coverage map          [✓] tested   [✗] GAP'))).toBe(true);
});
