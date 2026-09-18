import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import * as evidence from './helpers/coverage-audit-evidence';
import { JUDGE_MS, CAPTURE_MS } from './helpers/eval-budgets';
import { E2E_TOUCHFILES } from './helpers/touchfiles-data';
import fixture from './fixtures/ship-coverage-audit-af.json';
import { randomUUID } from 'node:crypto';
import { validateCoverageAudit } from './helpers/coverage-audit';
import { runRecordedOfficeHoursAttempt, OFFICE_HOURS_BUN_GRACE_MS } from './helpers/office-hours-attempt';

const source = fs.readFileSync(path.join(import.meta.dir, 'skill-e2e-workflow.test.ts'), 'utf8');
async function runCaller(index: number, change?: (result: any) => void, bindAttempt = true) {
  const row = structuredClone(fixture.rows[index]!); change?.(row.result);
  const block = source.slice(source.indexOf("describeIfSelected('Test Coverage Audit E2E'"), source.indexOf('// --- Codex skill E2E ---'));
  const js = new Bun.Transpiler({loader:'ts'}).transformSync(block);
  const files = new Map<string,string>(), setup: Function[] = [], cleanup: Function[] = [], callbacks: Function[] = [], records: any[] = [], invocations: any[] = [];
  const removed: string[] = [];
  const virtualFs = {mkdtempSync:()=>row.cwd,mkdirSync:()=>{},writeFileSync:(p:string,v:string)=>files.set(p,v),
    appendFileSync:(p:string,v:string)=>{expect(files.has(p)).toBe(true);files.set(p,files.get(p)!+v);},
    readFileSync:(p:string)=>{expect(files.has(p)).toBe(true);return files.get(p)!;},rmSync:(p:string)=>removed.push(p)};
  const collector = { addTest: (entry: any) => records.push(entry) };
  const args:Record<string,any> = { describeIfSelected:(_title:string,_names:string[],fn:Function)=>fn(),
    beforeAll:(fn:Function)=>setup.push(fn),afterAll:(fn:Function)=>cleanup.push(fn),
    testConcurrentIfSelected:(_name:string,fn:Function,timeout:number)=>{expect(timeout).toBe(CAPTURE_MS);callbacks.push(fn);},
    fs:virtualFs,os:{tmpdir:()=>'/tmp'},path:path.posix,ROOT:'/synthetic-gstack',copyDirSync:()=>{},spawnSync:()=>({status:0}),
    createCoverageAuditFixture:(cwd:string)=>{
      files.set(cwd+'/src/billing.ts',fixture.files.source);files.set(cwd+'/test/billing.test.ts',fixture.files.tests);
    },
    extractSkillBody:()=> 'synthetic ship instructions', randomUUID, validateCoverageAudit,
    runRecordedOfficeHoursAttempt, OFFICE_HOURS_BUN_GRACE_MS, resolveEvalModel:()=> 'synthetic-model',
    runSkillTest:async (opts:any)=>{
      invocations.push(opts);
      const delivered = [
        [fixture.files.source, files.get(row.cwd+'/src/billing.ts')!],
        [fixture.files.tests, files.get(row.cwd+'/test/billing.test.ts')!],
      ];
      for(const [original,current] of delivered) {
        expect(current).toStartWith(original);
        expect(current.slice(original.length)).toMatch(/^\n\/\/ coverage-read-evidence: [a-f0-9-]{36}\n$/);
      }
      // This is a synthetic replay of public event structure, not a new verdict
      // for the historical attempts. Rebind only complete delivered bodies to
      // the current fixture; keep recorded ownership, IDs, commands and output.
      if(bindAttempt) for(const event of row.result.transcript as any[]) {
        if(event.type !== 'user') continue;
        for(const block of event.message?.content ?? []) if(block.type === 'tool_result' && typeof block.content === 'string') {
          let content=block.content.replace(/^ *\d+(?:\t|→)/gm,'');
          for(const [original,current] of delivered) content=content.replaceAll(original.trim(),current.trim());
          block.content=content;
        }
      }
      return { duration: 1, toolCalls: [], model: 'synthetic-model', firstResponseMs: 1, maxInterTurnMs: 0,
        costEstimate: { estimatedCost: 0, turnsUsed: 1, estimatedTokens: 0 }, ...row.result };
    },runId:'synthetic-run',JUDGE_MS,CAPTURE_MS,
    logCost:()=>{},evalCollector:collector,expect,console:{log:()=>{}},
  };
  new Function(...Object.keys(args),js)(...Object.values(args));
  for(const fn of setup) await fn();
  expect(callbacks).toHaveLength(1);
  let thrown:unknown;try{await callbacks[0]!();}catch(error){thrown=error;}
  for(const fn of cleanup) await fn();
  expect(invocations).toHaveLength(1);expect(invocations[0].workingDirectory).toBe(row.cwd);
  expect(invocations[0].maxTurns).toBe(15);expect(invocations[0].timeout).toBe(JUDGE_MS);
  expect(invocations[0].signal).toBeInstanceOf(AbortSignal);
  expect(records).toHaveLength(1);
  expect(records[0].name).toBe('ship-coverage-audit');expect(records[0].tier).toBe('e2e');
  expect(removed).toEqual([row.cwd]);
  return {thrown,record:records[0]};
}

test('AF ship first completed Bash read pair satisfies the actual caller',async()=>{
  const r=await runCaller(0);expect(r.thrown).toBeUndefined();expect(r.record.passed).toBe(true);
});
test('AF ship retry completed Bash read pair satisfies the actual caller',async()=>{
  const r=await runCaller(1);expect(r.thrown).toBeUndefined();expect(r.record.passed).toBe(true);
});
test('AF ship real timeout stays false despite successful file delivery',async()=>{
  const r=await runCaller(2);expect(r.thrown).toBeDefined();expect(r.record.passed).toBe(false);
});
test('AF historical bytes without the current attempt marker cannot satisfy the caller',async()=>{
  const r=await runCaller(0,undefined,false);expect(r.thrown).toBeDefined();expect(r.record.passed).toBe(false);
});
test('AF ship caller records missing or foreign read evidence false exactly once',async()=>{
  for(const change of [
    (r:any)=>{r.transcript=r.transcript.filter((e:any)=>e.type!=='user');},
    (r:any)=>{r.transcript[0].cwd='/foreign';},
    (r:any)=>{r.transcript.forEach((e:any)=>{if(e.type==='user')e.session_id='foreign';});},
  ]) {const r=await runCaller(0,change);expect(r.thrown).toBeDefined();expect(r.record.passed).toBe(false);}
});

test('AF ship actual read helper accepts only literal owned delivery before read-only neighbors',()=>{
  for(const row of fixture.rows.slice(0,2))expect((evidence as any).coverageAuditReadEvidence(row.result.transcript,{cwd:row.cwd,source:{path:row.cwd+'/src/billing.ts',content:fixture.files.source},tests:{path:row.cwd+'/test/billing.test.ts',content:fixture.files.tests}})).toEqual({sourceRead:true,testsRead:true});
});

test('AF ship controls and fixture select the one existing owner',()=>{
  for(const name of ['test/ship-coverage-audit-af.test.ts','test/fixtures/ship-coverage-audit-af.json'])expect(Object.entries(E2E_TOUCHFILES).filter(([,files])=>files.includes(name)).map(([owner])=>owner)).toEqual(['ship-coverage-audit']);
});

function commandReads(command:string) {
  const row=fixture.rows[0]!;const session=row.sessionId;
  const transcript=[{type:'system',subtype:'init',session_id:session,cwd:row.cwd},
    {type:'assistant',session_id:session,message:{role:'assistant',content:[{type:'tool_use',id:'pair',name:'Bash',input:{command}}]}},
    {type:'user',session_id:session,message:{role:'user',content:[{type:'tool_result',tool_use_id:'pair',is_error:false,content:fixture.files.source+'\n'+fixture.files.tests}]}}];
  return (evidence as any).coverageAuditReadEvidence(transcript,{cwd:row.cwd,source:{path:row.cwd+'/src/billing.ts',content:fixture.files.source},tests:{path:row.cwd+'/test/billing.test.ts',content:fixture.files.tests}});
}
const plainPair='cat -n src/billing.ts; cat -n test/billing.test.ts';
test('AF ship closed read-only suffixes cannot turn quoting, substitution or mutation into evidence',()=>{
  for(const suffix of [
    "grep -E '\\.test' | tee src/billing.ts", "echo -e 'export\\nfunction'", "grep -E '\\.test'$(touch marker)",
    "grep -E '\\.test'; rm src/billing.ts", "grep -E '\\.test", "git ls-files --error-unmatch", "wc -l > changed.txt",
    "cat CLAUDE.md 2>/dev/null || echo $(touch marker)", "cat CLAUDE.md > changed.txt || echo none", "cat CLAUDE.md 2>/dev/null || bash -c true",
    "git diff '--output=src/billing.ts'", "grep -E '\\.test' | sed -i 's/a/b/' src/billing.ts",
  ]) expect(commandReads(plainPair+'; '+suffix)).toEqual({sourceRead:false,testsRead:false});
  expect(commandReads(`cd ${fixture.rows[0]!.cwd}; ${plainPair}; git ls-files | grep -E '(\\.test\\.|\\.spec\\.)' | wc -l; cat CLAUDE.md 2>/dev/null || echo none`)).toEqual({sourceRead:true,testsRead:true});
});
test('AF ship optional cat fallback and conditional or redirected source segments receive no read credit',()=>{
  expect(commandReads('cat src/billing.ts 2>/dev/null || echo none; cat test/billing.test.ts')).toEqual({sourceRead:false,testsRead:true});
  for(const command of ['false || cat src/billing.ts; cat test/billing.test.ts',
    `cd /foreign; ${plainPair}`, `${plainPair}; cd /foreign`,
    'cat src/billing.ts > hidden; cat test/billing.test.ts'])expect(commandReads(command)).toEqual({sourceRead:false,testsRead:false});
});
