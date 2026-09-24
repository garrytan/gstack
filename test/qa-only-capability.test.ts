import {expect, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {spawnSync} from 'node:child_process';
import {E2E_TOUCHFILES, selectTests} from './helpers/touchfiles';

const ROOT = path.resolve(import.meta.dir, '..');

test('QA-only capability regressions select the no-fix case', () => {
  expect(selectTests(['test/qa-only-capability.test.ts'], E2E_TOUCHFILES).selected).toEqual(['qa-only-no-fix']);
});

test.each(['success', 'omitted-tools', 'report-edit', 'source-edit', 'source-write'])
  ('QA-only registered capability and no-fix contract: %s', scenario => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-tools-'));
    const bin = path.join(dir, 'bin');
    const home = path.join(dir, 'home');
    fs.mkdirSync(bin); fs.mkdirSync(home);
    const facts = path.join(dir, 'facts.json');
    fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
await Bun.stdin.text();
const args = process.argv.slice(2), at = args.indexOf('--tools');
fs.writeFileSync(${JSON.stringify(facts)}, JSON.stringify({args}));
const scenario = ${JSON.stringify(scenario)};
const report = path.join(process.cwd(), 'qa-reports/qa-only-report.md');
fs.mkdirSync(path.dirname(report), {recursive:true});
fs.writeFileSync(report, '| **Total** | **7** |');
const emit = (name,input) => console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id:'fixture-'+name,name,input}]}}));
console.log(JSON.stringify({type:'system',subtype:'init',tools:at < 0 ? ['Bash','Read','Write','Glob','Edit'] : args[at+1].split(',')}));
emit('Write',{file_path:report,content:'| **Total** | **7** |'});
if(scenario === 'report-edit' || scenario === 'source-edit') {
  const target = scenario === 'report-edit' ? report : path.join(process.cwd(),'index.html');
  const old_string = fs.readFileSync(target,'utf8');
  const new_string = scenario === 'report-edit' ? '| **Total** | **8** |' : '<h1>changed</h1>\\n';
  fs.writeFileSync(target,new_string);emit('Edit',{file_path:target,old_string,new_string});
}
if(scenario === 'source-write') {
  const target=path.join(process.cwd(),'index.html');fs.writeFileSync(target,'<h1>changed</h1>\\n');
  emit('Write',{file_path:target,content:'<h1>changed</h1>\\n'});
}
console.log(JSON.stringify({type:'result',subtype:'success',result:'No-model fixture only.'}));
`, {mode:0o700});
    const script = path.join(dir, 'callback.test.ts');
    fs.writeFileSync(script, `
import {describe,expect,mock,test} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
const root=${JSON.stringify(ROOT)}, scenario=${JSON.stringify(scenario)}, facts=${JSON.stringify(facts)};
const actual=await import(path.join(root,'test/helpers/session-runner.ts'));
const runActual=actual.runSkillTest;
mock.module(path.join(root,'test/helpers/aside-available.ts'),()=>({asideAvailable:()=>false}));
mock.module(path.join(root,'browse/test/test-server.ts'),()=>({startTestServer:()=>({url:'http://127.0.0.1:1',server:{stop(){}}})}));
mock.module(path.join(root,'test/helpers/e2e-helpers.ts'),()=>({
  ROOT:root,browseBin:process.execPath,runId:'qa-only-free',evalsEnabled:true,selectedTests:['qa-only-no-fix'],
  describeIfSelected:(name,ids,body)=>{if(ids.includes('qa-only-no-fix'))describe(name,body);},
  testConcurrentIfSelected:(id,body)=>{if(id==='qa-only-no-fix')test(id,body,5000);},
  copyDirSync:(a,b)=>fs.cpSync(a,b,{recursive:true}),
  setupBrowseShims:cwd=>fs.mkdirSync(path.join(cwd,'browse/bin'),{recursive:true}),
  logCost(){},createEvalCollector:()=>null,finalizeEvalCollector:async()=>{},
  recordE2E:(_collector,_name,_suite,_result,extra)=>{
    const observed=JSON.parse(fs.readFileSync(facts,'utf8'));
    fs.writeFileSync(facts,JSON.stringify({...observed,recorded:extra}));
  },
}));
mock.module(path.join(root,'test/helpers/session-runner.ts'),()=>({...actual,runSkillTest:async options=>{
  const tools=['Bash','Read','Write','Glob'];
  expect(options.allowedTools).toEqual(tools);expect(options.tools).toEqual(tools);
  expect(options.maxTurns).toBe(40);expect(options.timeout).toBe(300000);
  expect(options.prompt).toContain('Write your report to '+options.workingDirectory+'/qa-reports/qa-only-report.md');
  const launch={...options,timeout:2000,runId:undefined};
  if(scenario==='omitted-tools')delete launch.tools;
  const result=await runActual(launch);
  const observed=JSON.parse(fs.readFileSync(facts,'utf8'));
  fs.writeFileSync(facts,JSON.stringify({...observed,exitReason:result.exitReason,
    calls:result.toolCalls.map(t=>({tool:t.tool,input:t.input})),
    reportExists:fs.existsSync(path.join(options.workingDirectory,'qa-reports/qa-only-report.md'))}));
  expect(result.exitReason).toBe('success');
  const at=observed.args.indexOf('--tools');expect(at).toBeGreaterThanOrEqual(0);
  expect(observed.args[at+1]).toBe(tools.join(','));
  return result;
}}));
await import(path.join(root,'test/skill-e2e-qa-workflow.test.ts'));
`);
    try {
      const child = spawnSync(process.execPath, ['test', script], {
        cwd:dir,encoding:'utf8',timeout:10000,
        env:{PATH:`${bin}${path.delimiter}${process.env.PATH ?? ''}`,HOME:home,TMPDIR:dir,
          GSTACK_EVAL_DIR:path.join(dir,'evals'),EVALS_HERMETIC:'1',NO_COLOR:'1'},
      });
      expect(child.status, child.stdout + child.stderr).toBe(scenario === 'success' ? 0 : 1);
      expect(child.stderr).not.toContain('Unhandled error between tests');
      expect(fs.existsSync(facts), child.stdout + child.stderr).toBe(true);
      const observed = JSON.parse(fs.readFileSync(facts, 'utf8'));
      expect(observed.exitReason).toBe('success');
      expect(observed.reportExists).toBe(true);
      if (scenario === 'omitted-tools') {
        expect(observed.args).not.toContain('--tools');
        expect(observed.recorded).toBeUndefined();
      } else {
        expect(observed.args[observed.args.indexOf('--tools') + 1]).toBe('Bash,Read,Write,Glob');
        const editCount = observed.calls.filter((call: {tool:string}) => call.tool === 'Edit').length;
        expect(editCount).toBe(scenario.endsWith('-edit') ? 1 : 0);
        if (scenario !== 'source-write') expect(observed.recorded.passed).toBe(!scenario.endsWith('-edit'));
        if (scenario !== 'success') expect(child.stderr).toContain('toHaveLength(0)');
      }
    } finally {
      fs.rmSync(dir, {recursive:true,force:true});
    }
  });
