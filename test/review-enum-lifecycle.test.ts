import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { JUDGE_MS, CAPTURE_MS } from './helpers/eval-budgets';
import { SESSION_DRAIN_GRACE_MS } from './helpers/session-runner';
const source=fs.readFileSync(path.join(import.meta.dir,'skill-e2e-review.test.ts'),'utf8');
async function exercise(scenarios: Array<'success'|'timeout'|'wrong-report'|'browse-error'|'no-report'>) {
  const setups:any[]=[],done:any[]=[],callbacks:any[]=[],rows:any[]=[],calls:any[]=[],outputs:string[]=[],preRunReports:string[][]=[];
  const files=new Map<string,string>(); let outer=0,index=0;
  const reportKeys=()=>[...files.keys()].filter(k=>/review-output-\d+\.md$/.test(k)).map(k=>k.split('/').pop()!).sort();
  const args: Record<string,any>={
    expect,JUDGE_MS,CAPTURE_MS,SESSION_DRAIN_GRACE_MS,ROOT:'/source',runId:'synthetic-run',process:{pid:123,env:{EVALS_RUN_ID:'synthetic-controller'}},
    beforeAll:(fn:any)=>setups.push(fn),afterAll:(fn:any)=>done.push(fn),
    describeIfSelected:(_title:string,names:string[],fn:any)=>{if(names.includes('review-enum-completeness'))fn();},
    testConcurrentIfSelected:(name:string,fn:any,timeout:number)=>{expect(name).toBe('review-enum-completeness');callbacks.push(fn);outer=timeout;},
    createEvalCollector:()=>({}),finalizeEvalCollector:()=>{},logCost:()=>{},spawnSync:()=>({status:0}),path:path.posix,os:{tmpdir:()=>'/tmp'},
    fs:{mkdtempSync:(p:string)=>p+'owned',writeFileSync:(p:string,s:string)=>files.set(p,s),copyFileSync:()=>{},rmSync:(p:string)=>{files.delete(p);},
      readdirSync:(p:string)=>[...files.keys()].filter(k=>k.startsWith(p+'/')).map(k=>k.slice(p.length+1)),
      existsSync:(p:string)=>files.has(p),readFileSync:(p:string)=>p.startsWith('/source/')?'synthetic fixture bytes':files.get(p)},
    extractSkillSections:()=> 'Review instructions',REVIEW_E2E_SECTIONS:[],
    runSkillTest:async(opts:any)=>{
      calls.push(opts);const scenario=scenarios[index++];
      expect(opts.timeout).toBe(JUDGE_MS);expect(opts.maxTurns).toBe(15);expect(opts.model).toBeUndefined();
      expect(opts.prompt).toContain('check if all consumers handle it');expect(opts.prompt).toContain('git diff main...HEAD');
      expect(opts.prompt).toContain('focused, read-only core review');
      expect(opts.prompt).toContain('Do not run the full /review lifecycle, QA or exploratory probes');
      expect(opts.prompt).toContain('only static Ruby source with no configured runnable application, dependencies or runtime/test harness');
      expect(opts.prompt).toContain('grep the sibling status values through the actual authored source and read every match in full, including unchanged consumers');
      expect(opts.prompt).toContain('Do not re-run the review, reuse a prior report, or invent runtime checks');
      preRunReports.push(reportKeys());
      const out=opts.prompt.match(/Write your review findings once to (\S+)/)[1];outputs.push(out);
      if(scenario!=='no-report')files.set(out,scenario==='wrong-report'?'Nothing to discuss.':'The returned status is missing enum handlers.');
      return {exitReason:scenario==='timeout'?'timeout':'success',browseErrors:scenario==='browse-error'?['existing browser failure']:[],output:'public response'};
    },
    recordE2E:(_collector:any,name:string,title:string,result:any,extra:any)=>rows.push({name,title,passed:result.exitReason==='success'&&result.browseErrors.length===0,...extra,result}),
  };
  let body=source;for(const m of source.matchAll(/^import[\s\S]*?;\n/gm))body=body.replace(m[0],'');
  new Function(...Object.keys(args),new Bun.Transpiler({loader:'ts'}).transformSync(body))(...Object.values(args));
  expect(callbacks).toHaveLength(1);for(const setup of setups)await setup();
  const errors:any[]=[];for(const _ of scenarios){try{await callbacks[0]();errors.push(undefined);}catch(error){errors.push(error);}}
  for(const finalizer of done)await finalizer();
  return {rows,calls,errors,outer,outputs,preRunReports,reportKeys:reportKeys()};
}

test('Enum caller reserves cleanup time without extending the model execution budget', async()=>{
  const x=await exercise(['success']);expect(x.outer).toBe(JUDGE_MS+SESSION_DRAIN_GRACE_MS+5000);expect(x.errors).toEqual([undefined]);expect(x.rows.map(r=>r.passed)).toEqual([true]);
  expect(x.reportKeys).toEqual(['review-output-1.md']);
});

test('Enum retries keep distinct capture identities and public diagnostics',async()=>{
  const x=await exercise(['timeout','success']);expect(x.errors[0]).toBeDefined();expect(x.errors[1]).toBeUndefined();
  expect(x.rows.map(r=>r.passed)).toEqual([false,true]);expect(new Set(x.calls.map(c=>c.runId)).size).toBe(2);
  for(const c of x.calls){expect(c.runId).toStartWith('synthetic-controller-review-enum-123-');expect(c.testName).toBe('review-enum-completeness');expect(c.publicStreamDiagnostics).toBe(true);}
  expect(new Set(x.outputs).size).toBe(2);
  for(const out of x.outputs)expect(out).toMatch(/review-output-\d+\.md$/);
});

test('Enum retry starts with the prior report removed while its write stays captured',async()=>{
  const x=await exercise(['success','success']);
  expect(x.preRunReports).toEqual([[],[]]);
  expect(x.reportKeys).toEqual(['review-output-2.md']);
  expect(new Set(x.outputs).size).toBe(2);
});

test('Enum missing current report fails the mandatory existence assertion',async()=>{
  const x=await exercise(['no-report']);expect(x.errors[0]).toBeDefined();expect(x.rows).toHaveLength(1);expect(x.rows[0].passed).toBe(false);
});

test('Enum prompt scopes a focused read-only core enum review with real fixture boundaries and a clean finish',async()=>{
  const x=await exercise(['success']);const prompt=x.calls[0].prompt;
  expect(prompt).toContain('focused, read-only core review');
  expect(prompt).toContain('run only the checklist');
  expect(prompt).toContain('Enum & Value Completeness');
  expect(prompt).toContain('Do not run the full /review lifecycle, QA or exploratory probes (for example Step 4.7), Greptile, hosting/PR/review-log setup');
  expect(prompt).toContain('only static Ruby source with no configured runnable application, dependencies or runtime/test harness; base main is local and there is no remote or PR');
  expect(prompt).toContain('any tools that happen to be installed on the host do not expand this scope');
  expect(prompt).toContain('grep the sibling status values through the actual authored source and read every match in full, including unchanged consumers');
  expect(prompt).toContain('stop with a brief final response');
  expect(prompt).toContain('Do not re-run the review, reuse a prior report, or invent runtime checks');
});

test('Enum semantic failure records false exactly once after the existing assertion',async()=>{
  const x=await exercise(['wrong-report']);expect(x.errors[0]).toBeDefined();expect(x.rows).toHaveLength(1);expect(x.rows[0].passed).toBe(false);
});

test('Enum verdict retains the existing browser-error guard',async()=>{
  const x=await exercise(['browse-error']);expect(x.rows).toHaveLength(1);expect(x.rows[0].passed).toBe(false);
});
