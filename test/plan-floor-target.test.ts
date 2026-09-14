import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readPlanFloorTarget } from './helpers/plan-floor-target';
import { createFakeBunCli } from './helpers/fake-bun-cli';
import { selectTests, E2E_TOUCHFILES } from './helpers/touchfiles';

const ROOT = path.resolve(import.meta.dir, '..');
const SID = '11111111-2222-3333-4444-555555555555';
const START = Date.parse('2026-09-10T04:46:45Z');
const SEED = '# Plan: Marketing landing page\n\nThe primary CTA has the same weight as Learn more.';
const COMMAND = '<command-message>plan-design-review</command-message>\n<command-name>/plan-design-review</command-name>\n<command-args>PLAN.md</command-args>';
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'floor-target-'));
  const cwd = path.join(dir, 'project'), config = path.join(dir, 'config');
  fs.mkdirSync(cwd); fs.writeFileSync(path.join(cwd, 'PLAN.md'), SEED);
  const journal = path.join(config, 'projects', 'owned', SID + '.jsonl');
  fs.mkdirSync(path.dirname(journal), { recursive: true });
  const row = { type: 'user', isSidechain: false, cwd, sessionId: SID, timestamp: new Date(START + 1).toISOString(), message: { role: 'user', content: COMMAND } };
  const write = (rows: unknown[], newline = true) => fs.writeFileSync(journal, rows.map(x => JSON.stringify(x)).join('\n') + (newline ? '\n' : ''));
  const options = { seed: SEED, sessionId: SID, slashCommand: '/plan-design-review', startedAt: START, now: START + 100 };
  return { dir, cwd, config, journal, row, write, options, check: () => readPlanFloorTarget(config, cwd, options), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('owned native command acknowledgment binds exact target, session and submitted bytes', () => {
  const f = fixture();
  try {
    expect(f.check().status).toBe('missing');
    f.write([f.row]);
    expect(f.check()).toMatchObject({ status: 'ready', command: '/plan-design-review PLAN.md', targetPath: path.join(f.cwd, 'PLAN.md'), sessionId: SID, acknowledgedAt: f.row.timestamp });
    f.write([{ ...f.row, message: { role: 'user', content: [{ type: 'text', text: COMMAND }] } }]);
    expect(f.check().status).toBe('ready');
  } finally { f.cleanup(); }
});

test('foreign, child, stale, future, quoted, tool and wrong-target records cannot acknowledge delivery', () => {
  const f = fixture();
  try {
    for (const row of [
      { ...f.row, cwd: f.cwd + '-foreign' }, { ...f.row, sessionId: 'foreign' },
      { ...f.row, isSidechain: true }, { ...f.row, parent_tool_use_id: 'parent-tool' },
      { ...f.row, timestamp: new Date(START - 1).toISOString() },
      { ...f.row, timestamp: new Date(START + 101).toISOString() },
      { ...f.row, type: 'assistant', message: { role: 'assistant', content: COMMAND } },
      { ...f.row, message: { role: 'user', content: '> ' + COMMAND } },
      { ...f.row, message: { role: 'user', content: COMMAND.replace('PLAN.md', 'OTHER.md') } },
      { ...f.row, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read', content: COMMAND }] } },
    ]) { f.write([row]); expect(f.check().status, JSON.stringify(row)).not.toBe('ready'); }
  } finally { f.cleanup(); }
});

test('the actual bare invocation cannot be repaired by a later queued target', () => {
  const f = fixture();
  try {
    const bare = '<command-message>plan-design-review</command-message>\n<command-name>/plan-design-review</command-name>';
    f.write([{ ...f.row, message: { role: 'user', content: bare } }, { ...f.row, timestamp: new Date(START + 2).toISOString() }]);
    expect(f.check().status).toBe('error');
    f.write([{ ...f.row, message: { role: 'user', content: [{ type: 'text', text: bare }, { type: 'text', text: 'Started without a target.' }] } }, f.row]);
    expect(f.check().status).toBe('error');
    f.write([{ ...f.row, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read', content: bare }] } }, f.row]);
    expect(f.check().status).toBe('ready');
    f.write([f.row], false); expect(f.check().status).toBe('missing');
    f.write([f.row]);
    const other = path.join(f.config, 'projects', 'other'); fs.mkdirSync(other); fs.copyFileSync(f.journal, path.join(other, SID + '.jsonl'));
    expect(f.check().status).toBe('error');
  } finally { f.cleanup(); }
});

test('changed or linked plan, invalid clock, linked journal and oversized source are unavailable', () => {
  const f = fixture();
  try {
    f.write([f.row]); fs.writeFileSync(path.join(f.cwd, 'PLAN.md'), SEED + ' changed'); expect(f.check().status).toBe('error');
    fs.writeFileSync(path.join(f.cwd, 'PLAN.md'), SEED);
    for (const now of [NaN, Infinity, START - 1]) expect(readPlanFloorTarget(f.config, f.cwd, { ...f.options, now }).status).not.toBe('ready');
    fs.renameSync(path.join(f.cwd, 'PLAN.md'), path.join(f.cwd, 'real.md')); fs.symlinkSync('real.md', path.join(f.cwd, 'PLAN.md')); expect(f.check().status).toBe('error');
    fs.unlinkSync(path.join(f.cwd, 'PLAN.md')); fs.renameSync(path.join(f.cwd, 'real.md'), path.join(f.cwd, 'PLAN.md'));
    const real = f.journal + '.real'; fs.renameSync(f.journal, real); fs.symlinkSync(real, f.journal); expect(f.check().status).toBe('error');
    fs.unlinkSync(f.journal); fs.renameSync(real, f.journal); fs.truncateSync(f.journal, 32 * 1024 * 1024 + 1); expect(f.check().status).toBe('error');
  } finally { f.cleanup(); }
});

test('new delivery helper and controls select all four existing floor owners', () => {
  for (const file of ['test/helpers/plan-floor-target.ts', 'test/plan-floor-target.test.ts']) {
    expect(selectTests([file], E2E_TOUCHFILES).selected.sort()).toEqual(['plan-ceo-finding-floor', 'plan-design-finding-floor', 'plan-devex-finding-floor', 'plan-eng-finding-floor']);
  }
});

test('compiled fake CLI preserves Claude arguments and stdin without a shebang launcher', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-floor-cli-'));
  try {
    const cli = createFakeBunCli(path.join(dir, 'fake-claude'), `
process.stdin.on('data', chunk => { console.log(JSON.stringify({ argv: process.argv.slice(2), input: chunk.toString() })); process.exit(0); });
`, true);
    const args = ['--model', 'fixture-model', '--session-id', SID];
    const child = Bun.spawn([cli, ...args], { stdin: new Blob(['/plan-design-review PLAN.md\r']), stdout: 'pipe', stderr: 'pipe' });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exit, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ argv: args, input: '/plan-design-review PLAN.md\r' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('real fake CLI sees seed before command; missing acknowledgment and scope menu never satisfy floor', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'floor-delivery-pty-'));
  try {
    const worker = path.join(dir, 'worker.ts'), output = path.join(dir, 'results.json');
    const cli = createFakeBunCli(path.join(dir, 'fake-claude'), `
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), id = args[args.indexOf('--session-id') + 1];
const record = value => fs.appendFileSync(process.env.FLOOR_RECORD, JSON.stringify(value)+'\\n');
record({type:'startup',pid:process.pid,cwd:process.cwd(),argv:args,plan:fs.readFileSync('PLAN.md','utf8'),context:fs.readFileSync('CLAUDE.md','utf8')});
if (process.stdin.isTTY) process.stdin.setRawMode(true);
let started=false;
process.stdin.on('data', chunk => {
 const input=chunk.toString(); record({type:'input',input}); if(started)return; started=true;
 const mode=process.env.FLOOR_MODE;
 if(mode!=='missing') {
  const root=path.join(process.env.CLAUDE_CONFIG_DIR,'projects','owned'); fs.mkdirSync(root,{recursive:true});
  const content=${JSON.stringify(COMMAND)};
  const row={type:'user',isSidechain:false,cwd:mode==='foreign'?process.cwd()+'-foreign':process.cwd(),sessionId:id,timestamp:new Date().toISOString(),message:{role:'user',content}};
  fs.writeFileSync(path.join(root,id+'.jsonl'),JSON.stringify(row)+'\\n');
 }
 process.stdout.write(mode==='scope'?'What should I review?\\n❯ 1. Current branch diff\\n  2. A plan or design doc\\n':'Finding 1: CTA hierarchy is unclear.\\n❯ 1. Emphasize the primary CTA\\n  2. Keep equal weight\\n');
});
process.on('SIGINT',()=>process.exit(0));
process.stdin.resume();
`);
    fs.writeFileSync(worker, `
import {runPlanSkillFloorCheck} from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'test/helpers/claude-pty-runner.ts')).href)};
import fs from 'node:fs';
// Observe actual process exit: Windows SIGINT uses TerminateProcess and cannot
// run a child signal handler. The native PTY and its process stay unchanged.
const spawn=Bun.spawn;
Bun.spawn=((command,options)=>{
  if(Array.isArray(command)&&command[0]===process.env.BROWSE_TERMINAL_BINARY){
    const onExit=options?.onExit;
    return spawn(command,{...options,onExit(proc,...details){
      fs.appendFileSync(options.env.FLOOR_RECORD,JSON.stringify({type:'closed',pid:proc.pid})+'\\n');
      onExit?.(proc,...details);
    }});
  }
  return spawn(command,options);
}) as typeof Bun.spawn;
const modes=['ready','missing','foreign','scope'];
const results=await Promise.all(modes.map(async mode=>({mode,observation:await runPlanSkillFloorCheck({skillName:'plan-design-review',slashCommand:'/plan-design-review',followUpPrompt:${JSON.stringify(SEED)},cwd:${JSON.stringify(ROOT)},timeoutMs:2500,model:'claude-fable-5-1',env:{FLOOR_MODE:mode,FLOOR_RECORD:${JSON.stringify(dir)}+'/'+mode+'.jsonl'}})})));
fs.writeFileSync(${JSON.stringify(output)},JSON.stringify(results));
`);
    const child = Bun.spawn([process.execPath, worker], { cwd: ROOT,
      env: { ...process.env, BROWSE_TERMINAL_BINARY: cli, EVALS_HERMETIC: '1', GSTACK_EVAL_DIR: path.join(dir, 'artifacts'), EVALS_RUN_ID: 'floor-delivery-test' }, stdout: 'pipe', stderr: 'pipe' });
    const killer = setTimeout(() => child.kill('SIGKILL'), 25000);
    try {
      const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(exit, stdout + stderr).toBe(0);
      for (const result of JSON.parse(fs.readFileSync(output, 'utf8'))) {
        const events = fs.readFileSync(path.join(dir, result.mode + '.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        const startup = events[0];
        expect(startup.plan).toBe(SEED); expect(startup.context).toContain(SEED); expect(startup.cwd).not.toBe(ROOT);
        expect(startup.argv[startup.argv.indexOf('--permission-mode') + 1]).toBe('plan');
        expect(startup.argv[startup.argv.indexOf('--model') + 1]).toBe('claude-fable-5-1');
        expect(events.filter(e => e.type === 'input').map(e => e.input).join('')).toBe('/plan-design-review PLAN.md\r');
        expect(events.at(-1)).toEqual({type:'closed',pid:startup.pid}); expect(fs.existsSync(startup.cwd)).toBe(false);
        expect(() => process.kill(startup.pid, 0)).toThrow();
        expect(result.observation.auqObserved).toBe(result.mode === 'ready');
        expect(result.observation.outcome).toBe(result.mode === 'ready' ? 'auq_observed' : 'timeout');
        expect(result.observation.targetDelivery.status).toBe(['ready','scope'].includes(result.mode) ? 'ready' : 'missing');
        const retained=JSON.parse(fs.readFileSync(path.join(result.observation.artifactDir,'observation.json'),'utf8'));
        expect(retained.targetDelivery).toEqual(result.observation.targetDelivery);
      }
    } finally { clearTimeout(killer); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}, 30000);
