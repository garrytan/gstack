import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPendingExitRecorder, isCurrentPlanApprovalScreen, recordPendingExit, withPendingExit } from './helpers/plan-count-pending-exit';
import { hasNativePlanTerminal } from './helpers/claude-pty-runner';
import type { PlanCountTranscript } from './helpers/plan-count-transcript';

const GATE = '────────────────────────────────────────────────────────\n' +
  'Claude has written up a plan and is ready to execute. Would you like to proceed?\n\n' +
  '❯ 1. Yes, and use auto mode\n  2. Yes, manually approve edits\n' +
  '  3. Tell Claude what to change\n     shift+tab to approve with this feedback\n';
const COMPACT_GATE = 'Exit plan mode?\nClaude wants to exit plan mode\n' +
  '❯ 1. Yes, and switch to default (ask each time) for this session\n  2. No\n';
const REPORT = '# Reviewed plan\n\n## GSTACK REVIEW REPORT\n\n' +
  '| Review | Status | Findings |\n|---|---|---|\n| Design Review | clean | resolved |\n\n' +
  'VERDICT: Design review complete\n\nNO UNRESOLVED DECISIONS\n';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-exit-test-'));
  const config = path.join(dir, '.claude');
  const startedAt = Date.now() - 10_000;
  const report = path.join(dir, 'report.md');
  fs.writeFileSync(report, REPORT);
  const transcript: PlanCountTranscript = { status: 'ready', assistantMessages: [], calls: [{
    sessionId: 'main-session', toolUseId: 'finding', answered: true, failed: false,
    questions: [{ header: 'Finding', question: 'Fix this gap?', options: [{ label: 'Fix' }, { label: 'Keep' }] }],
    answers: { 'Fix this gap?': 'Fix' }, unansweredQuestionIndices: [],
    answeredAt: new Date(startedAt + 1000).toISOString(),
  }] };
  const recorder = createPendingExitRecorder(dir, config);
  const event = { hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode',
    session_id: 'main-session', tool_use_id: 'native-exit', cwd: dir,
    transcript_path: path.join(config, 'projects', 'owned-project', 'main-session.jsonl'),
    tool_input: { ignored: 'DO_NOT_PERSIST_INPUT_OR_CONFIG' } };
  const observe = (screen = GATE, value = transcript) => withPendingExit(value, recorder.file, dir, config, startedAt, screen);
  return { dir, config, report, startedAt, transcript, recorder, event, observe,
    cleanup() { recorder.dispose(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

describe('pending native ExitPlanMode identity', () => {
  test('the captured gate can complete only with real pending identity and a fresh report', () => {
    const f = fixture();
    try {
      expect(hasNativePlanTerminal(f.observe(), f.report, f.startedAt, 'plan_ready')).toBe(false);
      recordPendingExit(JSON.stringify(f.event), f.recorder.file, f.dir, f.config);
      const observed = f.observe();
      expect(observed.calls).toBe(f.transcript.calls);
      expect(observed.planReadyRequests?.[0]?.source).toBe('pre_tool_use');
      expect(hasNativePlanTerminal(observed, f.report, f.startedAt, 'plan_ready')).toBe(true);
      expect(fs.readFileSync(f.recorder.file, 'utf8')).not.toContain('DO_NOT_PERSIST');
      expect(hasNativePlanTerminal(f.observe('The report is ready to execute.'), f.report, f.startedAt, 'plan_ready')).toBe(false);
    } finally { f.cleanup(); }
  });

  test('missing, malformed, partial, foreign, stale and future records add no identity', () => {
    const f = fixture();
    try {
      recordPendingExit(JSON.stringify(f.event), f.recorder.file, f.dir, f.config);
      const valid = JSON.parse(fs.readFileSync(f.recorder.file, 'utf8'));
      for (const input of ['{', '{}', 'x'.repeat(4097), ...[
        { ...valid, sessionId: 'foreign' }, { ...valid, cwd: path.join(f.dir, 'other') },
        { ...valid, transcriptPath: '/outside/main-session.jsonl' },
        { ...valid, transcriptPath: path.join(f.config, 'projects', 'owned', 'foreign.jsonl') },
        { ...valid, timestamp: new Date(f.startedAt - 1).toISOString() },
        { ...valid, timestamp: new Date(Date.now() + 60_000).toISOString() },
      ].map(value => JSON.stringify(value))]) {
        fs.writeFileSync(f.recorder.file, input);
        expect(f.observe().planReadyRequests, input).toBeUndefined();
      }
    } finally { f.cleanup(); }
  });

  test('foreign, sidechain and non-Exit hook payloads cannot create records', () => {
    const f = fixture();
    try {
      for (const change of [
        { agent_id: 'subagent' }, { cwd: '/different-fixture' }, { tool_name: 'AskUserQuestion' },
        { hook_event_name: 'PostToolUse' }, { session_id: '../escape' }, { tool_use_id: '' },
      ]) {
        recordPendingExit(JSON.stringify({ ...f.event, ...change }), f.recorder.file, f.dir, f.config);
        expect(fs.existsSync(f.recorder.file)).toBe(false);
      }
      recordPendingExit(JSON.stringify(f.event), f.recorder.file, f.dir, f.config);
      recordPendingExit('{broken', f.recorder.file, f.dir, f.config);
      expect(fs.existsSync(f.recorder.file)).toBe(false);
    } finally { f.cleanup(); }
  });

  test('pending identity cannot bypass missing coverage, failed results, or stale reports', () => {
    const f = fixture();
    try {
      recordPendingExit(JSON.stringify(f.event), f.recorder.file, f.dir, f.config);
      for (const change of [
        (t: any) => { t.status = 'missing'; }, (t: any) => { t.status = 'error'; },
        (t: any) => { t.calls = []; }, (t: any) => { t.calls[0].answered = false; },
        (t: any) => { t.calls[0].failed = true; },
        (t: any) => { t.calls[0].answeredAt = new Date(Date.now() + 1000).toISOString(); },
        (t: any) => { t.assistantMessages.push({ sessionId: 'other', timestamp: new Date().toISOString(), text: 'Done' }); },
        (t: any) => { t.planReadyRequests = [{ sessionId: 'main-session', toolUseId: 'native-exit', timestamp: new Date().toISOString(), failed: true }]; },
      ]) {
        const value = structuredClone(f.transcript); change(value);
        expect(hasNativePlanTerminal(f.observe(GATE, value), f.report, f.startedAt, 'plan_ready')).toBe(false);
      }
      const observed = f.observe();
      fs.utimesSync(f.report, new Date(f.startedAt - 1), new Date(f.startedAt - 1));
      expect(hasNativePlanTerminal(observed, f.report, f.startedAt, 'plan_ready')).toBe(false);
      fs.writeFileSync(f.report, '## GSTACK REVIEW REPORT\n');
      expect(hasNativePlanTerminal(observed, f.report, f.startedAt, 'plan_ready')).toBe(false);
      fs.rmSync(f.report);
      expect(hasNativePlanTerminal(observed, f.report, f.startedAt, 'plan_ready')).toBe(false);
    } finally { f.cleanup(); }
  });

  test('quoted, incomplete, busy and superseded screens never supply the active gate', () => {
    expect(isCurrentPlanApprovalScreen(GATE)).toBe(true);
    expect(isCurrentPlanApprovalScreen(COMPACT_GATE)).toBe(true);
    expect(isCurrentPlanApprovalScreen('```ts\nconst done = true;\n```\n' + GATE)).toBe(true);
    expect(isCurrentPlanApprovalScreen('> An earlier quoted review note.\n' + GATE)).toBe(true);
    for (const screen of [
      '> ' + GATE.replaceAll('\n', '\n> '), '```text\n' + GATE + '```',
      '```text\n' + GATE, 'Example approval menu:\n' + GATE,
      ...[GATE, COMPACT_GATE].map(screen => screen.split('\n').map(line => '    ' + line).join('\n')),
      GATE.replace('  3. Tell Claude what to change', ''),
      GATE + '\nWorking…', GATE + '\n☐ Finding\n❯ 1. Fix\n  2. Keep\nEnter to select',
      'Claude has written up a plan and is ready to execute. Would you like to proceed?',
    ]) expect(isCurrentPlanApprovalScreen(screen), screen).toBe(false);
  });

  test('the executable observer is silent on success and malformed input', async () => {
    const f = fixture();
    try {
      for (const input of [JSON.stringify(f.event), '{broken']) {
        const child = Bun.spawn([process.execPath, path.join(import.meta.dir, 'helpers/plan-count-pending-exit.ts'),
          '--record', f.recorder.file, f.dir, f.config], { stdin: new Blob([input]), stdout: 'pipe', stderr: 'pipe' });
        const [exit, stdout, stderr] = await Promise.all([child.exited,
          new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect([exit, stdout, stderr]).toEqual([0, '', '']);
      }
      expect(fs.existsSync(f.recorder.file)).toBe(false);
    } finally { f.cleanup(); }
  });
});

(process.platform === 'win32' ? test.skip : test)('real fake CLI executes the opt-in hook before the gate and cleans up on close', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-exit-pty-'));
  const fake = path.join(dir, 'fake-claude');
  const worker = path.join(dir, 'worker.ts');
  const result = path.join(dir, 'result.json');
  const helper = (name: string) => pathToFileURL(path.join(import.meta.dir, 'helpers', name)).href;
  fs.writeFileSync(fake, `#!${process.execPath}
import * as fs from 'node:fs';
import * as path from 'node:path';
const cwd = process.cwd();
fs.writeFileSync(path.join(cwd,'pid'),String(process.pid));
const config = process.env.CLAUDE_CONFIG_DIR;
const session = 'fake-main';
const native = path.join(config, 'projects', path.basename(cwd), session + '.jsonl');
fs.mkdirSync(path.dirname(native), {recursive:true});
const question = {header:'Finding',question:'Fix the gap?',options:[{label:'Fix'},{label:'Keep'}]};
const common = {sessionId:session,cwd,isSidechain:false,timestamp:new Date(Date.now()-100).toISOString()};
fs.writeFileSync(native, JSON.stringify({...common,type:'assistant',message:{role:'assistant',content:[{type:'tool_use',name:'AskUserQuestion',id:'q1',input:{questions:[question]}}]}})+'\\n'+
JSON.stringify({...common,type:'user',message:{role:'user',content:[{type:'tool_result',tool_use_id:'q1',content:'User answered'}]},toolUseResult:{answers:{'Fix the gap?':'Fix'}}})+'\\n');
fs.writeFileSync(path.join(cwd,'report.md'), ${JSON.stringify(REPORT)});
const index = process.argv.indexOf('--settings');
if (index >= 0) {
  const hook = JSON.parse(process.argv[index+1]).hooks.PreToolUse[0];
  if (hook.matcher !== '^ExitPlanMode$') throw Error('Wrong hook scope');
  const payload = {hook_event_name:'PreToolUse',tool_name:'ExitPlanMode',session_id:session,tool_use_id:'exit1',cwd,transcript_path:native};
  const child = Bun.spawn(['bash','-c',hook.hooks[0].command],{stdin:new Blob([JSON.stringify(payload)]),stdout:'pipe',stderr:'pipe'});
  const [exit,out,err] = await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  if (exit || out || err) throw Error('Observer changed native response');
}
if (process.env.PENDING_EXIT_CRASH === '1') process.exit(19);
process.stdout.write(${JSON.stringify(GATE)}.replaceAll('\\n','\\r\\n'));
process.stdin.on('data', data => fs.appendFileSync(path.join(cwd,'unexpected-input'),data));
process.stdin.resume();
`);
  fs.chmodSync(fake, 0o755);
  fs.writeFileSync(worker, `
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {launchClaudePty,hasNativePlanTerminal} from ${JSON.stringify(helper('claude-pty-runner.ts'))};
import {readPlanCountTranscript} from ${JSON.stringify(helper('plan-count-transcript.ts'))};
import {withPendingExit} from ${JSON.stringify(helper('plan-count-pending-exit.ts'))};
const results=[];
for (const enabled of [false,true]) {
  const cwd=path.join(${JSON.stringify(dir)},String(enabled)); fs.mkdirSync(cwd);
  const startedAt=Date.now()-1000;
  const session=await launchClaudePty({cwd,observeScreen:true,observePlanReady:enabled,timeoutMs:10000});
  const owned=session.pendingPlanReadyFile;
  try {
    await session.waitFor('shift+tab to approve',{timeoutMs:5000,pollMs:20});
    const native=readPlanCountTranscript(session.hermeticConfigDir,cwd);
    const observed=withPendingExit(native,owned,cwd,session.hermeticConfigDir,startedAt,await session.currentScreen());
    results.push({enabled,hook:owned!==undefined,nativeCalls:native.calls.length,nativeReady:native.planReadyRequests?.length??0,
      ready:hasNativePlanTerminal(observed,path.join(cwd,'report.md'),startedAt,'plan_ready'),input:fs.existsSync(path.join(cwd,'unexpected-input'))});
  } finally {await session.close();}
  if (owned && fs.existsSync(path.dirname(owned))) throw Error('Hook directory leaked');
}
const crashCwd=path.join(${JSON.stringify(dir)},'crash'); fs.mkdirSync(crashCwd);
const crashed=await launchClaudePty({cwd:crashCwd,observeScreen:true,observePlanReady:true,
  timeoutMs:10000,env:{PENDING_EXIT_CRASH:'1'}});
const crashRecord=crashed.pendingPlanReadyFile;
while (!crashed.exited()) await Bun.sleep(20);
if (crashed.exitCode()!==19 || !fs.existsSync(crashRecord)) throw Error('Crash control did not execute hook');
await crashed.close();
if (fs.existsSync(path.dirname(crashRecord))) throw Error('Crashed child leaked hook directory');
const spawn=Bun.spawn;
Bun.spawn=()=>{throw Error('simulated spawn failure');};
let rejected=false;
try {await launchClaudePty({cwd:crashCwd,observeScreen:true,observePlanReady:true});}
catch (error) {rejected=String(error).includes('simulated spawn failure');}
finally {Bun.spawn=spawn;}
if (!rejected || fs.readdirSync(os.tmpdir()).some(name=>name.startsWith('gstack-pending-exit-'))) throw Error('Startup failure leaked recorder');
fs.writeFileSync(${JSON.stringify(result)},JSON.stringify(results));
`);
  const workerTemp = path.join(dir, 'owned-tmp');
  fs.mkdirSync(workerTemp);
  const child = Bun.spawn([process.execPath, worker], {
    env: { ...process.env, TMPDIR: workerTemp, BROWSE_TERMINAL_BINARY: fake, EVALS_HERMETIC: '1' }, stdout: 'pipe', stderr: 'pipe',
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 20_000);
  try {
    const [exit, stdout, stderr] = await Promise.all([child.exited,
      new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exit, stdout + stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(result, 'utf8'))).toEqual([
      { enabled:false,hook:false,nativeCalls:1,nativeReady:0,ready:false,input:false },
      { enabled:true,hook:true,nativeCalls:1,nativeReady:0,ready:true,input:false },
    ]);
  } finally {
    clearTimeout(timeout);
    child.kill('SIGKILL');
    // The outer watchdog may stop the worker before its session finally runs.
    for (const name of ['false', 'true', 'crash']) {
      const pidFile = path.join(dir, name, 'pid');
      if (!fs.existsSync(pidFile)) continue;
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0) continue;
      try {
        if (process.platform === 'linux' && !fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(fake)) continue;
        process.kill(pid, 'SIGKILL');
      } catch { /* the owned fake child already exited */ }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 25_000);
