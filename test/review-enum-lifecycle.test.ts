import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { JUDGE_MS, CAPTURE_MS } from './helpers/eval-budgets';
import { E2E_TOUCHFILES } from './helpers/touchfiles';

const source=fs.readFileSync(path.join(import.meta.dir,'skill-e2e-review.test.ts'),'utf8');
async function exercise(scenarios: Array<'success'|'timeout'|'wrong-report'|'browse-error'>) {
  const setups:any[]=[],done:any[]=[],callbacks:any[]=[],rows:any[]=[],calls:any[]=[];
  const files=new Map<string,string>(); let outer=0,index=0;
  const args: Record<string,any>={
    expect,JUDGE_MS,CAPTURE_MS,ROOT:'/source',runId:'synthetic-run',process:{pid:123,env:{EVALS_RUN_ID:'synthetic-controller'}},
    beforeAll:(fn:any)=>setups.push(fn),afterAll:(fn:any)=>done.push(fn),
    describeIfSelected:(_title:string,names:string[],fn:any)=>{if(names.includes('review-enum-completeness'))fn();},
    testConcurrentIfSelected:(name:string,fn:any,timeout:number)=>{expect(name).toBe('review-enum-completeness');callbacks.push(fn);outer=timeout;},
    createEvalCollector:()=>({}),finalizeEvalCollector:()=>{},logCost:()=>{},spawnSync:()=>({status:0}),path,os:{tmpdir:()=>'/tmp'},
    fs:{mkdtempSync:(p:string)=>p+'owned',writeFileSync:(p:string,s:string)=>files.set(p,s),copyFileSync:()=>{},rmSync:()=>{},
      existsSync:(p:string)=>files.has(p),readFileSync:(p:string)=>p.startsWith('/source/')?'synthetic fixture bytes':files.get(p)},
    extractSkillSections:()=> 'Review instructions',REVIEW_E2E_SECTIONS:[],
    runSkillTest:async(opts:any)=>{
      calls.push(opts);const scenario=scenarios[index++];
      expect(opts.timeout).toBe(JUDGE_MS);expect(opts.maxTurns).toBe(15);expect(opts.model).toBeUndefined();
      expect(opts.prompt).toContain('check if all consumers handle it');expect(opts.prompt).toContain('git diff main...HEAD');
      files.set(path.join(opts.workingDirectory,'review-output.md'),scenario==='wrong-report'?'Nothing to discuss.':'The returned status is missing enum handlers.');
      return {exitReason:scenario==='timeout'?'timeout':'success',browseErrors:scenario==='browse-error'?['existing browser failure']:[],output:'public response'};
    },
    recordE2E:(_collector:any,name:string,title:string,result:any,extra:any)=>rows.push({name,title,passed:result.exitReason==='success'&&result.browseErrors.length===0,...extra,result}),
  };
  let body=source;for(const m of source.matchAll(/^import[\s\S]*?;\n/gm))body=body.replace(m[0],'');
  new Function(...Object.keys(args),new Bun.Transpiler({loader:'ts'}).transformSync(body))(...Object.values(args));
  expect(callbacks).toHaveLength(1);for(const setup of setups)await setup();
  const errors:any[]=[];for(const _ of scenarios){try{await callbacks[0]();errors.push(undefined);}catch(error){errors.push(error);}}
  for(const finalizer of done)await finalizer();
  return {rows,calls,errors,outer};
}

test('Enum caller reserves cleanup time without extending the model execution budget', async()=>{
  const x=await exercise(['success']);expect(x.outer).toBe(JUDGE_MS+6000);expect(x.errors).toEqual([undefined]);expect(x.rows.map(r=>r.passed)).toEqual([true]);
});

test('Enum retries keep distinct capture identities and public diagnostics',async()=>{
  const x=await exercise(['timeout','success']);expect(x.errors[0]).toBeDefined();expect(x.errors[1]).toBeUndefined();
  expect(x.rows.map(r=>r.passed)).toEqual([false,true]);expect(new Set(x.calls.map(c=>c.runId)).size).toBe(2);
  for(const c of x.calls){expect(c.runId).toStartWith('synthetic-controller-review-enum-123-');expect(c.testName).toBe('review-enum-completeness');expect(c.publicStreamDiagnostics).toBe(true);}
});

test('Enum semantic failure records false exactly once after the existing assertion',async()=>{
  const x=await exercise(['wrong-report']);expect(x.errors[0]).toBeDefined();expect(x.rows).toHaveLength(1);expect(x.rows[0].passed).toBe(false);
});

test('Enum verdict retains the existing browser-error guard',async()=>{
  const x=await exercise(['browse-error']);expect(x.rows).toHaveLength(1);expect(x.rows[0].passed).toBe(false);
});

test('Enum lifecycle controls select the existing enum owner only',()=>{
  expect(Object.entries(E2E_TOUCHFILES).filter(([,paths])=>paths.includes('test/review-enum-lifecycle.test.ts')).map(([name])=>name)).toEqual(['review-enum-completeness']);
});
