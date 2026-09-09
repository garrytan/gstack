/** Free real-Bun/PTY regression: the counting body must settle before its equal outer timeout. */
import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dir, '..');
type Event = { event: string; at: number; invocation: number; pid?: number; start?: string; cwd?: string; data?: string; elapsed?: number; outcome?: string; fixtureGone?: boolean };

function ownedFake(event: Event, fake: string): boolean {
  if (!event.pid) return false;
  try {
    if (process.platform === 'linux') {
      const args = fs.readFileSync(`/proc/${event.pid}/cmdline`, 'utf8').split('\0');
      const start = fs.readFileSync(`/proc/${event.pid}/stat`, 'utf8').split(') ')[1]!.split(' ')[19];
      return args.includes(fake) && start === event.start;
    }
    return execFileSync('ps', ['-p', String(event.pid), '-o', 'command='], { encoding: 'utf8', timeout: 5000 }).includes(fake);
  } catch { return false; }
}

test.skipIf(process.platform === 'win32')('count timeout settles and cleans its real PTY before Bun retries the equal outer limit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-count-timeout-'));
  const fake = path.join(dir, 'fake-claude');
  const worker = path.join(dir, 'worker.test.ts');
  const eventsPath = path.join(dir, 'events.jsonl');
  const fixtureTmp = path.join(dir, 'tmp');
  fs.mkdirSync(fixtureTmp);
  const helper = pathToFileURL(path.join(ROOT, 'test/helpers/claude-pty-runner.ts')).href;
  fs.writeFileSync(fake, `#!${process.execPath}\n` + String.raw`
import * as fs from 'node:fs';
const invocation = Number(process.env.TIMEOUT_INVOCATION);
const log = (event, extra = {}) => fs.appendFileSync(process.env.TIMEOUT_EVENTS, JSON.stringify({event, at:Date.now(), invocation, ...extra})+'\n');
const start = process.platform === 'linux' ? fs.readFileSync('/proc/self/stat','utf8').split(') ')[1].split(' ')[19] : '';
log('ready', {pid:process.pid, start, cwd:process.cwd()});
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', bytes => log('input', {data:bytes.toString()}));
process.on('SIGINT', () => log('sigint')); // exercise the owned forced-exit fallback
process.stdout.write('Counting lifecycle fixture is ready.\n');
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  fs.writeFileSync(worker, `import {test} from 'bun:test';\nimport * as fs from 'node:fs';\nimport {runPlanSkillCounting} from ${JSON.stringify(helper)};\n` + String.raw`
let starts = 0;
const log = (event, invocation, extra={}) => fs.appendFileSync(process.env.TIMEOUT_EVENTS, JSON.stringify({event,at:Date.now(),invocation,...extra})+'\n');
test('owned counting timeout', async () => {
  const invocation = ++starts;
  const start = Date.now();
  log('body', invocation);
  try {
    const observation = await runPlanSkillCounting({skillName:'plan-design-review', slashCommand:'/plan-design-review',
      followUpPrompt:'# Timeout lifecycle fixture\nReview this plan.', isLastStep0AUQ:()=>false,
      reviewCountCeiling:8, timeoutMs:18000, env:{TIMEOUT_INVOCATION:String(invocation),TIMEOUT_EVENTS:process.env.TIMEOUT_EVENTS}});
    const ready = fs.readFileSync(process.env.TIMEOUT_EVENTS,'utf8').trim().split('\n').map(line=>JSON.parse(line)).find(e=>e.event==='ready'&&e.invocation===invocation);
    log('returned', invocation, {elapsed:Date.now()-start,outcome:observation.outcome,fixtureGone:!fs.existsSync(ready.cwd)});
    throw new Error('HELPER_TIMEOUT_'+invocation);
  } finally { log('finally', invocation); }
}, 18000);
`);
  let rows: Event[] = [];
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let output = '', error = '';
  let status: number | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    child = Bun.spawn([process.execPath, 'test', '--retry', '1', worker], {
      cwd: ROOT, env: { ...process.env, BROWSE_TERMINAL_BINARY: fake, EVALS_HERMETIC: '1', EVALS_RUN_ID: '',
        EVALS: '', GSTACK_EVAL_DIR: path.join(dir, 'evals'), TIMEOUT_EVENTS: eventsPath, TMPDIR: fixtureTmp },
      stdout: 'pipe', stderr: 'pipe',
    });
    watchdog = setTimeout(() => child?.kill('SIGKILL'), 42000);
    [status, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    rows = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(status, output + error).toBe(1); // each retry retains its explicit timeout failure
    expect(error).toContain('HELPER_TIMEOUT_1');
    expect(error).toContain('HELPER_TIMEOUT_2');
    const starts = rows.filter(e => e.event === 'body');
    const ready = rows.filter(e => e.event === 'ready');
    const returned = rows.filter(e => e.event === 'returned');
    const finished = rows.filter(e => e.event === 'finally');
    expect(starts).toHaveLength(2);
    expect(ready).toHaveLength(2);
    expect(returned).toHaveLength(2);
    expect(finished).toHaveLength(2);
    expect(ready[0]!.pid).not.toBe(ready[1]!.pid);
    expect(ready[0]!.cwd).not.toBe(ready[1]!.cwd);
    expect(finished[0]!.at).toBeLessThanOrEqual(starts[1]!.at);
    for (const event of returned) {
      expect(event.outcome).toBe('timeout');
      expect(event.elapsed).toBeLessThan(18000);
      expect(event.fixtureGone).toBe(true);
    }
    for (const event of ready) {
      expect(ownedFake(event, fake)).toBe(false);
      const body = starts.find(e => e.invocation === event.invocation)!;
      const inputs = rows.filter(e => e.event === 'input' && e.invocation === event.invocation);
      expect(inputs.map(e => e.data).join('')).toBe('/plan-design-review\r');
      expect(inputs.every(e => e.at - body.at < 13000)).toBe(true);
    }
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (child && child.exitCode === null) { child.kill('SIGKILL'); await child.exited; }
    if (fs.existsSync(eventsPath)) rows = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const cleanup: object[] = [];
    for (const event of rows.filter(e => e.event === 'ready')) {
      const owned = ownedFake(event, fake);
      if (owned) { process.kill(event.pid!, 'SIGKILL'); }
      cleanup.push({pid:event.pid, start:event.start, wasOwned:owned, signal:owned?'SIGKILL':null});
    }
    // Optional immutable owner proof; it never changes the test's assertions.
    if (process.env.PLAN_COUNT_TIMEOUT_PROOF_DIR) {
      const dest = process.env.PLAN_COUNT_TIMEOUT_PROOF_DIR;
      fs.mkdirSync(dest, { recursive: false });
      for (const name of ['events.jsonl','worker.test.ts','fake-claude']) if (fs.existsSync(path.join(dir,name))) fs.copyFileSync(path.join(dir,name),path.join(dest,name));
      fs.writeFileSync(path.join(dest,'worker.log'), output + error);
      fs.writeFileSync(path.join(dest,'result.json'), JSON.stringify({status,cleanup,rows},null,2)+'\n');
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 48000);

test.skipIf(process.platform === 'win32')('deadline boundaries stop boot, late screen results and delayed Enter without abandoning cleanup', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-count-deadline-'));
  const fake = path.join(dir, 'fake-claude');
  const worker = path.join(dir, 'worker.ts');
  const helper = pathToFileURL(path.join(ROOT, 'test/helpers/claude-pty-runner.ts')).href;
  const screenModule = pathToFileURL(path.join(ROOT, 'test/helpers/pty-screen.ts')).href;
  fs.writeFileSync(fake, `#!${process.execPath}\n` + String.raw`
import * as fs from 'node:fs';
const log = (event, extra={}) => fs.appendFileSync(process.env.BOUNDARY_EVENTS,JSON.stringify({event,at:Date.now(),invocation:1,...extra})+'\n');
const start = process.platform === 'linux' ? fs.readFileSync('/proc/self/stat','utf8').split(') ')[1].split(' ')[19] : '';
log('ready',{pid:process.pid,start,cwd:process.cwd()});
process.stdin.setRawMode(true); process.stdin.resume();
process.stdin.on('data',data=>{
  log('input',{data:data.toString()});
  process.stdout.write('\x1b[2J\x1b[HWhich remedy should be used?\r\n❯1.First remedy\r\n2.Second remedy\r\n');
});
process.on('SIGINT',()=>{log('sigint');process.exit(0)});
setInterval(()=>{},1000);
`, { mode: 0o755 });
  fs.writeFileSync(worker, `import {mock} from 'bun:test';\nimport * as fs from 'node:fs';\n` +
    `const screenModule=${JSON.stringify(screenModule)};\nconst originalScreen=(await import(screenModule)).createPtyScreen;\n` + String.raw`
const mode=process.env.BOUNDARY_MODE;
let start=0, reads=0;
const log=(event,extra={})=>fs.appendFileSync(process.env.BOUNDARY_EVENTS,JSON.stringify({event,at:Date.now(),invocation:1,...extra})+'\n');
if(mode==='screen') mock.module(screenModule,()=>({createPtyScreen:async(...args)=>{
  const screen=await originalScreen(...args);
  return {...screen,read:async()=>{reads++; await Bun.sleep(Math.max(0,start+13200-Date.now()));return screen.read();}};
}}));
` + `const {runPlanSkillCounting}=await import(${JSON.stringify(helper)});\n` + String.raw`
start=Date.now();log('body');
const observation=await runPlanSkillCounting({skillName:'plan-design-review',slashCommand:'/plan-design-review',
  followUpPrompt:'Review the deadline fixture.',isLastStep0AUQ:()=>false,reviewCountCeiling:8,timeoutMs:mode==='boot'?12000:18000,
  pickAUQ:()=>{log('picker');while(Date.now()-start<12800){};return 2;},
  env:{BOUNDARY_EVENTS:process.env.BOUNDARY_EVENTS}});
const events=fs.readFileSync(process.env.BOUNDARY_EVENTS,'utf8').trim().split('\n').map(line=>JSON.parse(line));
log('returned',{outcome:observation.outcome,elapsed:Date.now()-start,reads,fixtureGone:!fs.existsSync(events.find(e=>e.event==='ready').cwd)});
`);
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const timers: ReturnType<typeof setTimeout>[] = [];
  try {
    const results = await Promise.allSettled(['boot','screen','enter'].map(async mode => {
      const eventPath=path.join(dir,mode+'.jsonl');
      const fixtureTmp=path.join(dir,mode); fs.mkdirSync(fixtureTmp);
      const child=Bun.spawn([process.execPath,worker], {cwd:ROOT,
        env:{...process.env,BROWSE_TERMINAL_BINARY:fake,EVALS_HERMETIC:'1',EVALS:'',EVALS_RUN_ID:'',
          GSTACK_EVAL_DIR:path.join(dir,'evals-'+mode),TMPDIR:fixtureTmp,BOUNDARY_MODE:mode,BOUNDARY_EVENTS:eventPath},stdout:'pipe',stderr:'pipe'});
      children.push(child);timers.push(setTimeout(()=>child.kill('SIGKILL'),25000));
      const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
      expect(code,out+err).toBe(0);
      const events=fs.readFileSync(eventPath,'utf8').trim().split('\n').map(line=>JSON.parse(line));
      const returned=events.find(e=>e.event==='returned');
      expect(returned.outcome).toBe('timeout'); expect(returned.fixtureGone).toBe(true);
      expect(returned.elapsed).toBeLessThan(mode==='boot'?12000:18000);
      const input=events.filter(e=>e.event==='input').map(e=>e.data).join('');
      expect(input).toBe(mode==='boot'?'':mode==='screen'?'/plan-design-review\r':'/plan-design-review\r2');
      if(mode==='screen') { expect(returned.reads).toBe(1);expect(events.some(e=>e.event==='picker')).toBe(false); }
      expect(ownedFake(events.find(e=>e.event==='ready'),fake)).toBe(false);
    }));
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  } finally {
    timers.forEach(clearTimeout);
    for(const child of children) if(child.exitCode===null){child.kill('SIGKILL');await child.exited;}
    for(const mode of ['boot','screen','enter']) {
      const eventPath=path.join(dir,mode+'.jsonl');
      if(!fs.existsSync(eventPath))continue;
      for(const event of fs.readFileSync(eventPath,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))) {
        if(event.event==='ready'&&ownedFake(event,fake))process.kill(event.pid,'SIGKILL');
      }
    }
    if(process.env.PLAN_COUNT_TIMEOUT_PROOF_DIR) {
      const dest=process.env.PLAN_COUNT_TIMEOUT_PROOF_DIR+'-boundaries';fs.mkdirSync(dest,{recursive:false});
      for(const name of ['worker.ts','fake-claude','boot.jsonl','screen.jsonl','enter.jsonl'])if(fs.existsSync(path.join(dir,name)))fs.copyFileSync(path.join(dir,name),path.join(dest,name));
    }
    fs.rmSync(dir,{recursive:true,force:true});
  }
},30000);
