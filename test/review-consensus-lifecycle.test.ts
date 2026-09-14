import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { JUDGE_MS, CAPTURE_MS } from './helpers/eval-budgets';
import { E2E_TOUCHFILES } from './helpers/touchfiles';

const source=fs.readFileSync(path.join(import.meta.dir,'skill-e2e-review-army.test.ts'),'utf8');
async function exercise(scenarios: Array<'success'|'timeout'|'wrong-report'|'browse-error'>, fixturePath = path) {
  const setups:any[]=[],done:any[]=[],callbacks:any[]=[],rows:any[]=[],calls:any[]=[];
  const files=new Map<string,string>(); let outer=0,index=0;
  const sourceRoot = fixturePath.join(fixturePath.sep, 'source');
  const args: Record<string,any>={
    expect,JUDGE_MS,CAPTURE_MS,ROOT:sourceRoot,runId:'synthetic-run',process:{pid:123,env:{EVALS_RUN_ID:'synthetic-controller'}},
    beforeAll:(fn:any)=>setups.push(fn),afterAll:(fn:any)=>done.push(fn),
    describeIfSelected:(_title:string,names:string[],fn:any)=>{if(names.includes('review-army-consensus'))fn();},
    testConcurrentIfSelected:(name:string,fn:any,timeout:number)=>{expect(name).toBe('review-army-consensus');callbacks.push(fn);outer=timeout;},
    createEvalCollector:()=>({}),finalizeEvalCollector:()=>{},logCost:()=>{},spawnSync:()=>({status:0}),path:fixturePath,os:{tmpdir:()=>'/tmp'},
    fs:{mkdirSync:()=>{},readdirSync:()=>[],mkdtempSync:(p:string)=>p+'owned',writeFileSync:(p:string,s:string)=>files.set(p,s),copyFileSync:()=>{},rmSync:()=>{},
      existsSync:(p:string)=>files.has(p),readFileSync:(p:string)=>p.startsWith(sourceRoot+fixturePath.sep)?'synthetic fixture bytes '.repeat(30):files.get(p)},
    extractSkillSections:()=> 'Review instructions',REVIEW_ARMY_E2E_SECTIONS:[],
    runSkillTest:async(opts:any)=>{
      calls.push(opts);const scenario=scenarios[index++];
      expect(opts.timeout).toBe(CAPTURE_MS);expect(opts.maxTurns).toBe(20);expect(opts.model).toBeUndefined();
      expect(opts.prompt).toContain('MULTI-SPECIALIST CONFIRMED');expect(opts.prompt).toContain('SQL injection in an auth controller');
      files.set(fixturePath.join(opts.workingDirectory,'review-output.md'),scenario==='wrong-report'?'Nothing to discuss.':'The SQL injection permits auth bypass.');
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

test('Consensus caller reserves cleanup time without extending the model execution budget', async()=>{
  const x=await exercise(['success']);expect(x.outer).toBe(CAPTURE_MS+6000);expect(x.errors).toEqual([undefined]);expect(x.rows.map(r=>r.passed)).toEqual([true]);
});

test('Consensus retries keep distinct capture identities and public diagnostics',async()=>{
  const x=await exercise(['timeout','success']);expect(x.errors[0]).toBeDefined();expect(x.errors[1]).toBeUndefined();
  expect(x.rows.map(r=>r.passed)).toEqual([false,true]);expect(new Set(x.calls.map(c=>c.runId)).size).toBe(2);
  for(const c of x.calls){expect(c.runId).toStartWith('synthetic-controller-review-consensus-123-');expect(c.testName).toBe('review-army-consensus');expect(c.publicStreamDiagnostics).toBe(true);}
});

test('Consensus semantic failure records false exactly once after the existing assertion',async()=>{
  const x=await exercise(['wrong-report']);expect(x.errors[0]).toBeDefined();expect(x.rows).toHaveLength(1);expect(x.rows[0].passed).toBe(false);
});

test('Consensus verdict retains the existing browser-error guard',async()=>{
  const x=await exercise(['browse-error']);expect(x.rows).toHaveLength(1);expect(x.rows[0].passed).toBe(false);
});

test('Consensus caller fixture preserves success and semantic failure under either path convention', async()=>{
  for (const fixturePath of [path.posix, path.win32]) {
    const x=await exercise(['success','wrong-report'], fixturePath);
    expect(x.errors[0]).toBeUndefined(); expect(x.errors[1]).toBeDefined();
    expect(x.rows.map(r=>r.passed)).toEqual([true,false]);
  }
});

test('Consensus lifecycle controls select the existing consensus owner only',()=>{
  expect(Object.entries(E2E_TOUCHFILES).filter(([,paths])=>paths.includes('test/review-consensus-lifecycle.test.ts')).map(([name])=>name)).toEqual(['review-army-consensus']);
});
