import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import fixture from './fixtures/coverage-audit-ae.json';
import { coverageAuditVerdict } from './helpers/coverage-audit-evidence';
import { recordE2E } from './helpers/e2e-helpers';
import { E2E_TOUCHFILES, LLM_JUDGE_TOUCHFILES, GLOBAL_TOUCHFILES } from './helpers/touchfiles';
import { selectTests } from './helpers/test-selection';

const clone = <T>(v:T):T => structuredClone(v);
const diagram = '```text\nsrc/billing.ts\n├── processPayment: happy path [TESTED]\n└── refundPayment [UNTESTED]\n```';
function synthetic() {
  const cwd = '/tmp/coverage-audit-evidence-owned';
  const files = {cwd, source:{path:path.join(cwd,'src/billing.ts'),content:fixture.files.source},
    tests:{path:path.join(cwd,'test/billing.test.ts'),content:fixture.files.tests}};
  const transcript:any[] = [{type:'system',subtype:'init',session_id:'parent',cwd}];
  for (const [id,file] of Object.entries({source:files.source,tests:files.tests})) {
    transcript.push({type:'assistant',session_id:'parent',parent_tool_use_id:null,message:{role:'assistant',content:[
      {type:'tool_use',id,name:'Read',input:{file_path:file.path}},
    ]}});
    transcript.push({type:'user',session_id:'parent',parent_tool_use_id:null,message:{role:'user',content:[
      {type:'tool_result',tool_use_id:id,content:file.content},
    ]}});
  }
  return {files,result:{exitReason:'success',browseErrors:[],output:diagram,transcript} as any};
}
const verdict = (s:ReturnType<typeof synthetic>) => coverageAuditVerdict(s.result,s.files);
const block = (s:ReturnType<typeof synthetic>,i:number) => s.result.transcript[i].message.content[0];

describe('coverage audit native evidence',()=>{
  test('all four exact completed public attempts delivered both files and the seeded diagram',()=>{
    expect(fixture.provenance.actualPassedCases).toBe(0);
    for(const row of fixture.rows){
      const files={cwd:row.cwd,source:{path:path.join(row.cwd,'src/billing.ts'),content:fixture.files.source},
        tests:{path:path.join(row.cwd,'test/billing.test.ts'),content:fixture.files.tests}};
      expect(coverageAuditVerdict(row.result as any,files)).toEqual({sourceRead:true,testsRead:true,diagram:true,passed:true,failures:[]});
    }
  });
  test.each([
    '```text\nsrc/billing.ts\n├── refundPayment [UNTESTED]\n└── processPayment: happy path [TESTED]\n```',
    'src/billing.ts\n├── processPayment: happy path [TESTED]\n└── refundPayment [UNTESTED]',
  ])('function order and optional fencing do not change valid coverage evidence: %s', output=>{
    const s=synthetic();s.result.output=output;expect(verdict(s).diagram).toBe(true);
  });
  test('direct Read, literal cat/sed and delivered native line gutters are valid',()=>{
    for(const command of ['cat -n src/billing.ts',"sed -n '1,200p' 'src/billing.ts'",'cat -- "src/billing.ts"']){
      const s=synthetic();Object.assign(block(s,1),{name:'Bash',input:{command}});
      block(s,2).content=fixture.files.source.split('\n').map((line,i)=>`${i+1}\t${line}`).join('\n');
      expect(verdict(s).passed).toBe(true);
    }
    const s=synthetic();block(s,2).content=[{type:'text',text:fixture.files.source.split('\n').map((line,i)=>`${i+1}→${line}`).join('\n')}];
    expect(verdict(s).passed).toBe(true);
  });
  test('each exact source and test file must be successfully delivered',()=>{
    for(const mutate of [
      (s:any)=>{block(s,2).content='src/billing.ts was read';},
      (s:any)=>{block(s,2).content=fixture.files.source.split('\n').slice(0,3).join('\n');},
      (s:any)=>{block(s,2).is_error=true;},
      (s:any)=>{block(s,3).input.file_path=s.files.source.path;},
      (s:any)=>{block(s,4).content=fixture.files.source;},
      (s:any)=>{block(s,1).input.file_path=path.join(s.files.cwd,'other/billing.ts');},
      (s:any)=>{s.files.tests.path=s.files.source.path;},
    ]){const s=synthetic();mutate(s);expect(verdict(s).passed).toBe(false);}
  });
  test('unpaired, repeated, child and foreign events cannot supply parent file evidence',()=>{
    for(const mutate of [
      (s:any)=>{s.result.transcript.splice(1,1);},
      (s:any)=>{[s.result.transcript[1],s.result.transcript[2]]=[s.result.transcript[2],s.result.transcript[1]];},
      (s:any)=>{s.result.transcript[2].session_id='foreign';},
      (s:any)=>{s.result.transcript[2].parent_tool_use_id='agent';},
      (s:any)=>{s.result.transcript[1].parent_tool_use_id='agent';},
      (s:any)=>{s.result.transcript[2].message.role='assistant';},
      (s:any)=>{s.result.transcript.push(clone(s.result.transcript[2]));},
      (s:any)=>{s.result.transcript.push(clone(s.result.transcript[1]));},
      (s:any)=>{s.result.transcript[0].cwd+='/sibling';},
      (s:any)=>{s.result.transcript.push(clone(s.result.transcript[0]));},
      (s:any)=>{s.result.transcript[0].session_id='foreign';},
      (s:any)=>{s.result.transcript[0].type='user';},
      (s:any)=>{s.result.transcript.shift();},
    ]){const s=synthetic();mutate(s);expect(verdict(s).passed).toBe(false);}
  });
  test('quoted metadata, counters and undeclared shell reads do not substitute for actual delivery',()=>{
    for(const command of [
      "echo 'cat src/billing.ts'",'false && cat src/billing.ts','cat src/billing.ts | head -2',
      'cd ../sibling; cat src/billing.ts',"if true; then cat src/billing.ts; fi",'cat "$SOURCE"',
      "cat <<'EOF'\ncat src/billing.ts\nEOF",'f() {\ncat src/billing.ts\n}',
      '(\ncat src/billing.ts\n)',
    ]){const s=synthetic();Object.assign(block(s,1),{name:'Bash',input:{command}});expect(verdict(s).passed).toBe(false);}
    const s=synthetic();s.result.toolCalls=[{tool:'Read',input:{file_path:s.files.source.path}},{tool:'Read',input:{file_path:s.files.tests.path}}];
    s.result.transcript=[s.result.transcript[0],{type:'assistant',session_id:'parent',message:{role:'assistant',content:[{type:'text',text:JSON.stringify(s.result.transcript.slice(1))}]}}];
    expect(verdict(s).sourceRead).toBe(false);expect(verdict(s).testsRead).toBe(false);
  });
  test('a commented read cannot borrow printed bytes; quoted hash paths remain literal',()=>{
    const s=synthetic();
    const command=`printf '${Buffer.from(fixture.files.source).toString('base64')}' | base64 -d; # only printed bytes; cat src/billing.ts`;
    Object.assign(block(s,1),{name:'Bash',input:{command}});
    expect(verdict(s).sourceRead).toBe(false);
    const quoted=synthetic();quoted.files.source.path=path.join(quoted.files.cwd,'src/billing#branch.ts');
    Object.assign(block(quoted,1),{name:'Bash',input:{command:"cat 'src/billing#branch.ts'"}});
    expect(verdict(quoted).sourceRead).toBe(true);
  });
  test('completion and tool errors remain final gate failures despite genuine delivery',()=>{
    for(const exitReason of ['timeout','exit_code_1']){const s=synthetic();s.result.exitReason=exitReason;expect(verdict(s).passed).toBe(false);}
    const s=synthetic();s.result.browseErrors=['read failed'];expect(verdict(s).passed).toBe(false);
  });
  test('coverage markers must belong to the seeded payment and refund functions',()=>{
    for(const output of [
      diagram.replace('[TESTED]','[UNTESTED]'),diagram.replace('[UNTESTED]','[TESTED]'),
      diagram.replace('processPayment','processPaymentExample'),diagram.replace('refundPayment','refundPaymentExample'),
      '```\n├── processPayment: happy path [TESTED]\n└── refundPayment [TESTED]\n└── unrelatedPayment [UNTESTED]\n```',
      '```\n├── processPayment: happy path [TESTED]\n```\n```\n└── refundPayment [UNTESTED]\n```',
    ]){const s=synthetic();s.result.output=output;expect(verdict(s).diagram).toBe(false);}
  });
  test('quoted and nested source examples are not the generated coverage diagram',()=>{
    for(const output of [diagram.split('\n').map(line=>'> '+line).join('\n'), '````markdown\n'+diagram+'\n````']){
      const s=synthetic();s.result.output=output;expect(verdict(s).diagram).toBe(false);
    }
  });
  test.each([
    diagram.replace('[UNTESTED]','[NOT UNTESTED]'),
    diagram.replace('[UNTESTED]','[UNTESTED] is false; this function is fully covered.'),
    'Example only; this diagram is not the audit result.\n'+diagram,
  ])('negated gaps and explicitly labeled examples are not audit findings: %s', output=>{
    const s=synthetic();s.result.output=output;expect(verdict(s).diagram).toBe(false);
  });
  test('collector receives exactly the asserted verdict even when process exit succeeded',()=>{
    for(const valid of [true,false]){
      const s=synthetic();if(!valid)s.result.output='No diagram produced.';
      Object.assign(s.result,{toolCalls:[],duration:1,costEstimate:{estimatedCost:0,turnsUsed:1,estimatedTokens:1}});
      const v=verdict(s),entries:any[]=[];
      recordE2E({addTest:(entry:any)=>entries.push(entry)} as any,'coverage','fixture',s.result,{passed:v.passed,error:v.failures.length?v.failures.join('; '):undefined});
      expect(entries).toHaveLength(1);expect(entries[0].passed).toBe(valid);expect(entries[0].error).toBe(valid?undefined:v.failures.join('; '));
    }
  });
  test('coverage evidence files select their exact registered consumers',()=>{
    for(const file of ['test/helpers/coverage-audit-evidence.ts','test/coverage-audit-evidence.test.ts','test/fixtures/coverage-audit-ae.json']){
      expect(selectTests([file],E2E_TOUCHFILES,GLOBAL_TOUCHFILES).selected.sort()).toEqual(file === 'test/helpers/coverage-audit-evidence.ts' ? ['plan-eng-coverage-audit','review-coverage-audit','ship-coverage-audit'] : ['plan-eng-coverage-audit','review-coverage-audit']);
      expect(selectTests([file],LLM_JUDGE_TOUCHFILES,GLOBAL_TOUCHFILES).selected).toEqual([]);
    }
  });
});
