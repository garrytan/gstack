import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

// Model transport is replaced in one isolated Bun process; the actual runner
// and real Readable streams retain their normal EOF/error/close behavior.
const scenarios = [
  ['valid-eof', 'success'],
  ['stderr-premature-zero', 'error_output_stream'],
  ['stderr-premature-nonzero', 'exit_code_2'],
  ['stderr-error-zero', 'error_output_stream'],
  ['stdout-premature-zero', 'error_output_stream'],
  ['stderr-close-work-timeout', 'timeout'],
  ['stderr-close-startup-timeout', 'timeout_startup'],
  ['max-turns-valid-eof', 'error_max_turns'],
  ['max-turns-stderr-premature', 'exit_code_1'],
] as const;
let fixture: string;
let observations: any[];
beforeAll(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'session-eof-'));
  for (const name of ['home', 'tmp', 'state', 'codex']) fs.mkdirSync(path.join(fixture, name));
  const childScript = path.join(fixture, 'stream-events.test.ts');
  fs.writeFileSync(childScript, SCRIPT);
  const child = spawnSync(process.execPath, ['test', childScript], {
    cwd: fixture, encoding: 'utf8', timeout: 10_000,
    env: {
      PATH: process.env.PATH ?? '', LANG: 'C.UTF-8', NO_COLOR: '1',
      HOME: path.join(fixture, 'home'), TMPDIR: path.join(fixture, 'tmp'),
      GSTACK_HOME: path.join(fixture, 'state'), CODEX_HOME: path.join(fixture, 'codex'),
      EVALS_HERMETIC: '0', EOF_FIXTURE_ROOT: fixture,
      EOF_RUNNER_SOURCE: path.join(import.meta.dir, 'helpers/session-runner.ts'),
      EOF_CLEANUP_SOURCE: path.join(import.meta.dir, '../scripts/test-strict-output.ts'),
    },
  });
  expect(child.status, child.stderr || child.stdout).toBe(0);
  observations = JSON.parse(fs.readFileSync(path.join(fixture, 'observations.json'), 'utf8'));
  expect(observations.map(row => row.scenario.id)).toEqual(scenarios.map(row => row[0]));
}, 15_000);
afterAll(() => { if (fixture) fs.rmSync(fixture, { recursive: true, force: true }); });

describe('session runner stream completion', () => {
  for (const [id, expected] of scenarios) test(id, () => {
    const row = observations.find(row => row.scenario.id === id);
    expect(row.spawns).toBe(1);
    expect(row.streamsDestroyed).toBe(true);
    expect(row.elapsedMs).toBeLessThan(1000);
    expect(row.result.exitReason).toBe(expected);
    if (['valid-eof', 'max-turns-valid-eof'].includes(id)) {
      expect(row.eof).toEqual({ stdout: true, stderr: true });
      expect(row.result.output).toBe('fixture result');
    } else if (id !== 'stdout-premature-zero') {
      expect(row.eof.stderr).toBe(false);
      expect(row.events).not.toContain('stderr:end');
    }
    if (id.startsWith('stderr-premature') || id === 'max-turns-stderr-premature') {
      expect(row.events).toContain('stderr:close');
      expect(row.events).not.toContain('stderr:error');
      expect(row.result.output).toBe('fixture result');
    }
    if (expected === 'success') expect(row.diagnostic).toBeNull();
    else {
      expect(row.diagnostic.exitReason).toBe(expected);
      expect(row.diagnostic.stderr).toContain('retained fixture stderr');
      if (id === 'stderr-premature-zero') expect(row.diagnostic.stderr).toContain('stderr closed before EOF');
      if (id === 'stderr-error-zero') expect(row.diagnostic.stderr).toContain('primary fixture stderr failure');
    }
  });
});

const SCRIPT = String.raw`import { mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
const dir = process.env.EOF_FIXTURE_ROOT!;
const runnerPath = process.env.EOF_RUNNER_SOURCE!;
const cleanupPath = process.env.EOF_CLEANUP_SOURCE!;
const observations: any[] = [];
let active: any;
const cases = [
 {id:'valid-eof',fault:'none',exit:0,want:'success'},
 {id:'stderr-premature-zero',fault:'stderr-close',exit:0,want:'error_output_stream'},
 {id:'stderr-premature-nonzero',fault:'stderr-close',exit:2,want:'exit_code_2'},
 {id:'stderr-error-zero',fault:'stderr-error',exit:0,want:'error_output_stream'},
 {id:'stdout-premature-zero',fault:'stdout-close',exit:0,want:'error_output_stream'},
 {id:'stderr-close-work-timeout',fault:'timeout',exit:null,want:'timeout'},
 {id:'stderr-close-startup-timeout',fault:'startup',exit:null,want:'timeout_startup'},
 {id:'max-turns-valid-eof',fault:'none',exit:1,maxTurns:true,want:'error_max_turns'},
 {id:'max-turns-stderr-premature',fault:'stderr-close',exit:1,maxTurns:true,want:'exit_code_1'},
];
mock.module('child_process', () => ({
 spawn(command: string,args: string[],options: any) {
  if(command!=='claude') throw Error('Unexpected executable');
  const x=active; x.spawns++; x.args=args; x.childCwd=options.cwd;
  queueMicrotask(()=>{
   const c=x.child,s=x.scenario;
   c.stderr.write('retained fixture stderr\n');
   if(s.fault==='startup'){c.stderr.destroy();return;}
   c.stdout.write(JSON.stringify({type:'result',subtype:s.maxTurns?'error_max_turns':'success',is_error:!!s.maxTurns,result:'fixture result',num_turns:1,total_cost_usd:0})+'\n');
   if(s.fault==='timeout'){c.stderr.destroy();return;}
   if(s.fault==='stdout-close') c.stdout.destroy(); else c.stdout.end();
   if(s.fault==='stderr-close')c.stderr.destroy();
   else if(s.fault==='stderr-error')c.stderr.destroy(new Error('primary fixture stderr failure'));
   else c.stderr.end();
   c.exitCode=s.exit;c.emit('exit',s.exit,null);
  });
  return x.child;
 },
 spawnSync(){return {status:1,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)};},
 execFileSync(){throw Error('Unexpected synchronous executable');},
}));
mock.module(cleanupPath,()=>({
 killProcessGroup(child: any,signal: string){
  if(child!==active.child)throw Error('Unknown owned child');
  active.kills.push(signal);
  if(child.exitCode===null){child.exitCode=137;queueMicrotask(()=>child.emit('exit',null,'SIGKILL'));}
 },
}));
const {runSkillTest}=await import(runnerPath);

test('observe actual runner with controlled stream lifecycles', async () => {
for(const scenario of cases) {
 const child=Object.assign(new EventEmitter(),{pid:undefined,stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),exitCode:null});
 const events: string[]=[];
 for(const n of ['stdout','stderr']as const)for(const e of ['end','close','error'])child[n].on(e,()=>events.push(n+':'+e));
 const x=active={scenario,child,spawns:0,kills:[],args:[]};
 const cwd=path.join(dir,scenario.id);fs.mkdirSync(cwd,{mode:0o700});
 const started=Date.now();
 const result=await runSkillTest({prompt:'controlled local stream fixture',workingDirectory:cwd,timeout:120,startupGraceMs:80,testName:scenario.id,model:'fixture-no-provider'});
 await new Promise(resolve=>setTimeout(resolve,0));
 const observation={scenario,result,events,eof:{stdout:child.stdout.readableEnded,stderr:child.stderr.readableEnded},spawns:x.spawns,kills:x.kills,elapsedMs:Date.now()-started,streamsDestroyed:child.stdout.destroyed&&child.stderr.destroyed,childCwd:x.childCwd,actualFunction:'runSkillTest',source:runnerPath,providers:0};
 const diagnosticPath = path.join(cwd, '.gstack/test-transcripts', scenario.id + '-failure.json');
 observations.push({...observation, diagnostic: fs.existsSync(diagnosticPath) ? JSON.parse(fs.readFileSync(diagnosticPath, 'utf8')) : null});
}
fs.writeFileSync(path.join(dir,'observations.json'), JSON.stringify(observations,null,2)+'\n', {mode:0o600});
}, 5000);
`;
