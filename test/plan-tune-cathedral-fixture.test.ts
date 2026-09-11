import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { E2E_TOUCHFILES } from './helpers/touchfiles';

const ROOT = path.resolve(import.meta.dir, '..');
const source = fs.readFileSync(path.join(import.meta.dir, 'skill-e2e-plan-tune-cathedral.test.ts'), 'utf8');
const names = ['plan-tune-hook-capture', 'plan-tune-enforcement', 'plan-tune-annotation', 'plan-tune-codex-import', 'plan-tune-dream-cycle'];

async function exercise(selected = names, fault?: 'missing-log-lib' | 'missing-hook-lib' | 'first-hook' | 'setup', hostEnv: Record<string, string> = {}) {
  // Execute the actual selected callbacks with real local bins. Never import
  // E2E initialization, call a provider, or pass ambient auth/host state.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cathedral-contract-'));
  const suites: any[] = [], finalizers: any[] = [], rows: any[] = [], attempts: any[] = [], dirs: string[] = [], removals: any[] = [];
  const invoked: string[] = [];
  let current: any, failedHook = false;
  const owned = (p: string) => { if (!p.startsWith(scratch + path.sep)) throw new Error('Foreign fixture path'); };
  const env = { PATH: process.env.PATH, HOME: path.join(scratch, 'home'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', ...hostEnv };
  fs.mkdirSync(env.HOME);
  const args: Record<string, any> = {
    ROOT, path, os: {tmpdir:()=>scratch}, process: {env}, expect,
    beforeAll: (fn: any) => current.setups.push(fn),
    afterAll: (fn: any) => current ? current.teardowns.push(fn) : finalizers.push(fn),
    describeIfSelected: (_title: string, keys: string[], fn: any) => {
      if (!keys.some(key => selected.includes(key))) return;
      const suite = {setups:[],teardowns:[],tests:[]}; suites.push(suite); current=suite; fn(); current=undefined;
    },
    testConcurrentIfSelected: (name: string, fn: any) => { if(selected.includes(name)) current.tests.push({name,fn}); },
    createEvalCollector: () => ({addTest:(row:any)=>rows.push(row)}), finalizeEvalCollector:()=>{},
    copyDirSync: (a: string, b: string) => { owned(b); fs.cpSync(a,b,{recursive:true}); },
    fs: { ...fs,
      mkdtempSync(prefix: string) { owned(prefix); const dir=fs.mkdtempSync(prefix); dirs.push(dir); return dir; },
      copyFileSync(a: string,b: string) {
        owned(b);
        if(fault==='setup') throw new Error('Synthetic fixture copy failure');
        if((fault==='missing-log-lib' && a.endsWith('/lib/jsonl-store.ts')) || (fault==='missing-hook-lib' && a.endsWith('/lib/is-conductor.ts'))) return;
        fs.copyFileSync(a,b);
      },
      rmSync(p: string,opts: any) {
        owned(p); const memory=path.join(p,'.gstack-state/free-text-memory.json');
        removals.push({path:p,nuggets:fs.existsSync(memory)?JSON.parse(fs.readFileSync(memory,'utf8')).nuggets.length:null});
        fs.rmSync(p,opts);
      },
    },
    spawnSync: (bin: string,argv: string[],opts: any) => {
      if(bin!=='git') {
        owned(bin);
        expect(['question-log-hook','question-preference-hook','gstack-codex-session-import','gstack-distill-apply']).toContain(path.basename(bin));
        owned(opts.env.GSTACK_STATE_ROOT);
      }
      if(opts.cwd) owned(opts.cwd);
      expect(Number.isFinite(opts.timeout) && opts.timeout > 0).toBe(true);
      invoked.push(path.basename(bin));
      if(fault==='first-hook' && path.basename(bin)==='question-preference-hook' && !failedHook) {
        failedHook=true; return {status:1,stdout:'',stderr:'Synthetic transient hook failure'};
      }
      return spawnSync(bin,argv,{...opts,timeout:opts.timeout,env:opts.env??env});
    },
  };
  let body=source; for(const m of source.matchAll(/^import[\s\S]*?;\n/gm)) body=body.replace(m[0],'');
  try {
    new Function(...Object.keys(args),new Bun.Transpiler({loader:'ts'}).transformSync(body))(...Object.values(args));
    for(const suite of suites) {
      for(const setup of suite.setups) await setup();
      for(const callback of suite.tests) for(let attempt=1;attempt<=2;attempt++) {
        let error: unknown; try {await callback.fn();} catch(e) {error=e;}
        attempts.push({name:callback.name,attempt,error,remaining:dirs.filter(p=>fs.existsSync(p))});
      }
      for(const done of suite.teardowns) await done();
    }
    for(const done of finalizers) await done();
    return {rows,attempts,dirs,removals,invoked,allRemoved:dirs.every(p=>!fs.existsSync(p))};
  } finally {fs.rmSync(scratch,{recursive:true,force:true});}
}

test('Cathedral callbacks run all five real local contracts with fresh attempts and truthful rows', async () => {
  const x=await exercise();
  expect(x.attempts).toHaveLength(10); expect(x.rows).toHaveLength(10); expect(x.dirs).toHaveLength(10);
  expect(new Set(x.dirs).size).toBe(10); expect(x.allRemoved).toBe(true);
  for(const attempt of x.attempts) {expect(attempt.error).toBeUndefined();expect(attempt.remaining).toEqual([]);}
  for(const row of x.rows) {expect(row.passed).toBe(true);expect(row.cost_usd).toBe(0);expect(row.output).toContain('no model invocation');}
});

test('Missing installed libraries still fail the actual hook and log contracts', async () => {
  for(const [name,fault] of [['plan-tune-hook-capture','missing-log-lib'],['plan-tune-enforcement','missing-hook-lib']] as const) {
    const x=await exercise([name],fault);
    expect(x.rows).toHaveLength(2); expect(x.allRemoved).toBe(true);
    for(const attempt of x.attempts) expect(attempt.error).toBeDefined();
    expect(x.rows.map(row=>row.passed)).toEqual([false,false]);
  }
});

test('A failed dream hook retries with one fresh nugget and preserves the failed attempt', async () => {
  const x=await exercise(['plan-tune-dream-cycle'],'first-hook');
  expect(x.attempts[0].error).toBeDefined(); expect(x.attempts[1].error).toBeUndefined();
  expect(x.rows.map(row=>row.passed)).toEqual([false,true]);
  expect(x.removals.map(row=>row.nuggets)).toEqual([1,1]);
  expect(new Set(x.dirs).size).toBe(2); expect(x.allRemoved).toBe(true);
});

test('A partial fixture setup failure is recorded once and cleans only its owned directory', async () => {
  const x=await exercise(['plan-tune-hook-capture'],'setup');
  expect(x.rows.map(row=>row.passed)).toEqual([false,false]); expect(x.dirs).toHaveLength(2); expect(x.removals).toHaveLength(2);
  expect(x.invoked.every(bin=>bin==='git')).toBe(true); expect(x.allRemoved).toBe(true);
});

test('Cathedral fixture controls and copied libraries select all five existing owners only', () => {
  for(const file of ['test/plan-tune-cathedral-fixture.test.ts','lib/jsonl-store.ts','lib/is-conductor.ts']) {
    const owners=Object.entries(E2E_TOUCHFILES).filter(([name,paths])=>names.includes(name)&&paths.includes(file)).map(([name])=>name);
    expect(owners).toEqual(names);
  }
  expect(Object.entries(E2E_TOUCHFILES).filter(([,paths])=>paths.includes('test/plan-tune-cathedral-fixture.test.ts')).map(([name])=>name)).toEqual(names);
});


test('Plain Claude cathedral contracts stay isolated from either inherited Conductor marker', async () => {
  for (const hostEnv of [
    { CONDUCTOR_WORKSPACE_PATH: '/synthetic/conductor/workspace' },
    { CONDUCTOR_PORT: '55070', GSTACK_SESSION_KIND: 'spawned', OPENCLAW_SESSION: 'synthetic-session' },
  ]) {
    const x = await exercise(['plan-tune-annotation', 'plan-tune-dream-cycle'], undefined, hostEnv);
    expect(x.attempts).toHaveLength(4);
    expect(x.rows.map(row => row.passed)).toEqual([true, true, true, true]);
    for (const attempt of x.attempts) expect(attempt.error).toBeUndefined();
    expect(x.allRemoved).toBe(true);
  }
});
