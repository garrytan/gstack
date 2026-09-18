/** The collection endpoint uses the real counting loop, native journal and PTY.
 * These synthetic ACKs test transport only; they establish no review quality. */
import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

type Mode = 'acknowledged' | 'hook-pending' | 'published-pending' | 'default' |
  'exited' | 'failed' | 'foreign' | 'deadline' | 'report-contract';
type Event = { kind: string; at: number; pid?: number; identity?: string; cwd?: string;
  input?: string; event?: string; code?: number; out?: string; err?: string; ids?: string[] };

function identity(pid: number): string | null {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='],
      { encoding: 'utf8', timeout: 5000 }).trim();
  } catch { return null; }
}

async function scenario(mode: Mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'count-collection-'));
  const fake = path.join(dir, 'fake-claude'), worker = path.join(dir, 'worker.ts');
  const eventsPath = path.join(dir, 'events.jsonl'), resultPath = path.join(dir, 'result.json');
  const helper = pathToFileURL(path.join(import.meta.dir, 'helpers/claude-pty-runner.ts')).href;
  fs.writeFileSync(fake, `#!${process.execPath}\n` + String.raw`
import fs from 'node:fs'; import path from 'node:path'; import {execFileSync} from 'node:child_process';
const mode=process.env.COLLECTION_MODE, events=process.env.COLLECTION_EVENTS;
const log=(kind,extra={})=>fs.appendFileSync(events,JSON.stringify({kind,at:Date.now(),...extra})+'\n');
const sid='collection-'+process.pid, cwd=process.cwd();
log('ready',{pid:process.pid,cwd,identity:execFileSync('ps',['-p',String(process.pid),'-o','lstart=','-o','command='],{encoding:'utf8',timeout:5000}).trim()});
const native=path.join(process.env.CLAUDE_CONFIG_DIR,'projects',sid,sid+'.jsonl');
fs.mkdirSync(path.dirname(native),{recursive:true});
const persist=(role,content,extra={})=>fs.appendFileSync(native,JSON.stringify({cwd,sessionId:sid,isSidechain:false,timestamp:new Date().toISOString(),message:{role,content},...extra})+'\n');
const question=n=>({header:'Finding '+n,question:'Keep seeded remedy '+n+'?',multiSelect:false,
  options:[{label:'Keep',description:'Retain the seeded remedy.'},{label:'Discuss',description:'Discuss this remedy.'}]});
const use=(id,n,extra={})=>persist('assistant',[{type:'tool_use',name:'AskUserQuestion',id,input:{questions:[question(n)]}}],extra);
const ack=(id,n,extra={})=>persist('user',[{type:'tool_result',tool_use_id:id,content:'Answered.',...(mode==='failed'?{is_error:true}:{})}],
  {toolUseResult:{answers:{[question(n).question]:'Keep'}},...extra});
persist('assistant',[{type:'text',text:'Owned collection fixture started.'}]);
const at=process.argv.indexOf('--settings'),settings=at<0?null:JSON.parse(process.argv[at+1]);
async function hook(event) {
  const entries=settings?.hooks[event]?.filter(e=>e.matcher==='^AskUserQuestion$')??[];
  if(entries.length!==1||entries[0].hooks.length!==1||entries[0].hooks[0].timeout!==5)throw Error('wrong pending hook scope');
  const payload={hook_event_name:event,tool_name:'AskUserQuestion',session_id:sid,tool_use_id:'second',cwd,
    transcript_path:native,tool_input:{questions:[question(2)]}};
  const child=Bun.spawn(['bash','-c',entries[0].hooks[0].command],{stdin:new Blob([JSON.stringify(payload)]),stdout:'pipe',stderr:'pipe'});
  const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  log('hook',{event,code,out,err});if(code||out||err)throw Error('pending observer changed response');
}
let started=false;
process.stdin.setRawMode?.(true);process.stdin.resume();
process.stdin.on('data',async bytes=>{
  const input=bytes.toString();log('input',{input});
  if(started||input!=='/plan-ceo-review\r')throw Error('unexpected actor input');
  started=true;
  const extra=mode==='foreign'?{cwd:path.join(cwd,'foreign-project')}:{ };
  use('first',1,extra);ack('first',1,extra);log('first-ack');
  if(mode==='exited'){process.exit(19);return;}
  if(mode==='hook-pending'||mode==='published-pending'){
    if(mode==='hook-pending')await hook('PreToolUse');else use('second',2);
    log('pending');
    setTimeout(async()=>{
      if(mode==='hook-pending'){await hook('PostToolUse');use('second',2);}
      ack('second',2);log('second-ack');
      process.stdout.write('\x1b[2J\x1b[HOwned collection data ready.\r\n');
    },4500);
  }else if(['default','failed','foreign'].includes(mode))setTimeout(()=>{process.exitCode=19;process.stdin.pause();process.stdin.destroy();},4500);
  process.stdout.write('\x1b[2J\x1b[HOwned collection fixture is working.\r\n');
});
process.on('SIGINT',()=>{log('sigint');process.exit(0)});
`, { mode: 0o755 });
  fs.writeFileSync(worker, `import fs from 'node:fs';\nimport {runPlanSkillCounting,resolveClaudeBinary} from ${JSON.stringify(helper)};\n` + String.raw`
const mode=process.env.COLLECTION_MODE,events=process.env.COLLECTION_EVENTS;
if(resolveClaudeBinary()!==process.env.BROWSE_TERMINAL_BINARY)throw Error('fake CLI not bound');
const log=(kind,extra={})=>fs.appendFileSync(events,JSON.stringify({kind,at:Date.now(),...extra})+'\n');
const start=Date.now();let callbacks=0;
const options={skillName:'plan-ceo-review',slashCommand:'/plan-ceo-review',followUpPrompt:'Review only the seeded collection fixture.',
  isLastStep0AUQ:()=>false,isFirstReviewAUQ:()=>true,reviewCountCeiling:8,timeoutMs:22000,
  observeSetupQuestions:mode==='hook-pending',env:{COLLECTION_MODE:mode,COLLECTION_EVENTS:events},
  ...(mode==='default'?{}:{isCollectionComplete:(transcript,fingerprints)=>{
    callbacks++;log('callback',{ids:transcript.calls.map(call=>call.toolUseId)});
    if(transcript.status!=='ready'||!transcript.calls.length||transcript.calls.some(call=>!call.answered||call.failed)||
      fingerprints.length!==transcript.calls.length||fingerprints.some(fp=>!fp.nativeCall?.answered))throw Error('callback received unacknowledged inputs');
    if(mode==='deadline'){
      // Deliberately cross the real work deadline inside a synchronous caller.
      // No clock, timer, PTY, transcript or runner function is mocked.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,Math.max(0,start+18200-Date.now()));
      log('callback-return');
    }
    return true;
  }}),
  ...(mode==='report-contract'?{expectedPlanPath:'/tmp/collection-final-report.md'}:{})};
let observation,error;
try{observation=await runPlanSkillCounting(options);}catch(e){error=String(e);}
fs.writeFileSync(process.env.COLLECTION_RESULT,JSON.stringify({observation,error,callbacks,elapsed:Date.now()-start}));
`);
  const child = Bun.spawn([process.execPath, worker], { env: { ...process.env,
    BROWSE_TERMINAL_BINARY: fake, EVALS_HERMETIC: '1', EVALS: '', EVALS_RUN_ID: '',
    COLLECTION_MODE: mode, COLLECTION_EVENTS: eventsPath, COLLECTION_RESULT: resultPath }, stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => child.kill('SIGKILL'), 28000);
  let out = '', err = '', code: number | undefined, rows: Event[] = [];
  try {
    [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, out + err).toBe(0);
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    rows = fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    const ready = rows.find(row => row.kind === 'ready');
    if (mode === 'report-contract') {
      expect(result.error).toContain('Collection-only completion cannot replace the final report contract');
      expect(rows).toEqual([]);
      expect(result.callbacks).toBe(0);
    } else {
      expect(result.error, out + err).toBeUndefined();
      expect(ready).toBeDefined();
      expect(identity(ready!.pid!)).toBeNull();
      expect(fs.existsSync(ready!.cwd!)).toBe(false);
      expect(rows.filter(row => row.kind === 'input').map(row => row.input)).toEqual(['/plan-ceo-review\r']);
    }
    return { ...result, rows };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited; }
    if (fs.existsSync(eventsPath)) rows = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    for (const ready of rows.filter(row => row.kind === 'ready')) {
      if (ready.identity?.includes(fake) && identity(ready.pid!) === ready.identity) process.kill(ready.pid!, 'SIGKILL');
    }
    // Optional owner evidence retains the exact fixture/worker and public events.
    if (process.env.PLAN_COUNT_COLLECTION_PROOF_DIR) {
      const dest = path.join(process.env.PLAN_COUNT_COLLECTION_PROOF_DIR, mode);
      fs.mkdirSync(dest, { recursive: true });
      for (const name of ['fake-claude', 'worker.ts', 'events.jsonl', 'result.json']) {
        if (fs.existsSync(path.join(dir, name))) fs.copyFileSync(path.join(dir, name), path.join(dest, name));
      }
      fs.writeFileSync(path.join(dest, 'worker.log'), out + err);
      fs.writeFileSync(path.join(dest, 'exit.json'), JSON.stringify({ code }) + '\n');
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test.skipIf(process.platform === 'win32')('acknowledged owned collection returns a collection endpoint, without claiming review completion', async () => {
  const result = await scenario('acknowledged');
  expect(result.observation.outcome).toBe('collection_complete');
  expect(result.observation.transcript.status).toBe('ready');
  expect(result.observation.transcript.calls.map((call: any) => call.toolUseId)).toEqual(['first']);
  expect(result.observation.fingerprints[0].nativeCall).toEqual(result.observation.transcript.calls[0]);
  expect(result.callbacks).toBe(1);
}, 30000);

for (const mode of ['hook-pending', 'published-pending'] as const) {
  test.skipIf(process.platform === 'win32')(`${mode} prevents collection until its actual native ACK exists`, async () => {
    const result = await scenario(mode);
    expect(result.observation.outcome).toBe('collection_complete');
    expect(result.observation.transcript.calls.map((call: any) => call.toolUseId)).toEqual(['first', 'second']);
    expect(result.rows.filter((row: Event) => row.kind === 'callback').map((row: Event) => row.ids)).toEqual([['first', 'second']]);
    const ack = result.rows.find((row: Event) => row.kind === 'second-ack')!;
    expect(result.rows.find((row: Event) => row.kind === 'callback')!.at).toBeGreaterThanOrEqual(ack.at);
    if (mode === 'hook-pending') {
      const hooks = result.rows.filter((row: Event) => row.kind === 'hook');
      expect(hooks.map((row: Event) => row.event)).toEqual(['PreToolUse', 'PostToolUse']);
      expect(hooks.every((row: Event) => row.code === 0 && row.out === '' && row.err === '')).toBe(true);
    }
  }, 30000);
}

for (const mode of ['default', 'exited', 'failed', 'foreign'] as const) {
  test.skipIf(process.platform === 'win32')(`${mode} cannot gain collection completion`, async () => {
    const result = await scenario(mode);
    expect(result.observation.outcome).toBe('exited');
    expect(result.callbacks).toBe(0);
    if (mode === 'foreign') expect(result.observation.transcript.calls).toEqual([]);
    else expect(result.observation.transcript.calls).toHaveLength(1);
    if (mode === 'failed') expect(result.observation.transcript.calls[0].failed).toBe(true);
  }, 30000);
}

test.skipIf(process.platform === 'win32')('a synchronous collection callback crossing the work deadline cannot return completion', async () => {
  const result = await scenario('deadline');
  expect(result.callbacks).toBe(1);
  expect(result.rows.some((row: Event) => row.kind === 'callback-return')).toBe(true);
  expect(result.observation.transcript.calls[0].answered).toBe(true);
  expect(result.observation.outcome).toBe('timeout');
}, 30000);

test.skipIf(process.platform === 'win32')('collection callback plus final report contract rejects before fixture or actor startup', async () => {
  await scenario('report-contract');
}, 30000);
