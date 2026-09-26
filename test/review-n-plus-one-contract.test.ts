import {expect, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {spawnSync} from 'node:child_process';
import {E2E_TOUCHFILES, selectTests} from './helpers/touchfiles';

const ROOT = path.resolve(import.meta.dir, '..');

test('N+1 native dispatch regressions select their paid case', () => {
  for (const file of ['test/review-n-plus-one-contract.test.ts', 'test/fixtures/review-n-plus-one-dispatch.json']) {
    expect(selectTests([file], E2E_TOUCHFILES).selected).toEqual(['review-army-perf-n-plus-one']);
  }
});

test.each(['complete-control', 'captured-omission', 'claimed-only', 'background', 'missing-report', 'unrelated-report', 'captured-timeout'])
  ('N+1 registered completion contract: %s', scenario => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n1-contract-'));
    const facts = path.join(dir, 'facts.json');
    const script = path.join(dir, 'callback.test.ts');
    fs.writeFileSync(script, `
import {describe,expect,mock,test} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
const root=${JSON.stringify(ROOT)},scenario=${JSON.stringify(scenario)},facts=${JSON.stringify(facts)};
const actual=await import(path.join(root,'test/helpers/session-runner.ts'));
const fixture=JSON.parse(fs.readFileSync(path.join(root,'test/fixtures/review-n-plus-one-dispatch.json'),'utf8'));
const data=structuredClone(['captured-omission','claimed-only'].includes(scenario)?fixture.omission:fixture.ci);
if(scenario==='background')data.events[1].message.content[0].input.run_in_background=true;
const parsed=actual.parseNDJSON(data.events.map(e=>JSON.stringify(e)));
let prompt='';
mock.module(path.join(root,'test/helpers/e2e-helpers.ts'),()=>({
  ROOT:root,runId:'n1-contract',
  describeIfSelected:(name,ids,body)=>{if(ids.includes('review-army-perf-n-plus-one'))describe(name,body);},
  testConcurrentIfSelected:(id,body,timeout)=>{if(id==='review-army-perf-n-plus-one')test(id,body,timeout);},
  logCost(){},createEvalCollector:()=>null,finalizeEvalCollector:async()=>{},
  recordE2E:(_collector,_name,_suite,result,extra)=>fs.writeFileSync(facts,JSON.stringify({
    passed:extra?.passed??result.exitReason==='success',exitReason:result.exitReason,toolCalls:result.toolCalls,prompt,
  })),
}));
mock.module(path.join(root,'test/helpers/session-runner.ts'),()=>({...actual,runSkillTest:async options=>{
  expect(options.timeout).toBe(300000);expect(options.maxTurns).toBe(20);
  prompt=options.prompt;
  if(scenario!=='missing-report')fs.writeFileSync(path.join(options.workingDirectory,'review-output.md'),
    scenario==='unrelated-report'?'No relevant evidence':'N+1 queries at posts_controller.rb:7 and :9.'+
      (scenario==='claimed-only'?' Red Team completed.':''));
  return {exitReason:scenario==='captured-timeout'?'timeout':'success',browseErrors:[],toolCalls:parsed.toolCalls,
    transcript:parsed.transcript,output:data.publicAcknowledgement??'Synthetic successful completion control.'};
}}));
await import(path.join(root,'test/skill-e2e-review-army.test.ts'));
`);
    try {
      const child = spawnSync(process.execPath, ['test', script], {
        cwd: dir, encoding: 'utf8', timeout: 10_000,
        env: {PATH: process.env.PATH ?? '', HOME: dir, TMPDIR: dir, NO_COLOR: '1'},
      });
      expect(child.status, child.stdout + child.stderr).toBe(scenario === 'complete-control' ? 0 : 1);
      expect(child.stderr).not.toContain('Unhandled error between tests');
      expect(fs.existsSync(facts), child.stdout + child.stderr).toBe(true);
      const observed = JSON.parse(fs.readFileSync(facts, 'utf8'));
      expect(observed.passed).toBe(scenario === 'complete-control');
      expect(observed.exitReason).toBe(scenario === 'captured-timeout' ? 'timeout' : 'success');
      expect(observed.prompt).toContain('conditional Red Team dispatch');
      expect(observed.prompt).toContain('separate foreground Red Team subagent');
      expect(observed.prompt).toContain('brief acknowledgement');
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });
