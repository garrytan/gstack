import { afterAll, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const CLI = path.resolve(import.meta.dir, '../bin/gstack-qa-deadline');
const ROOT = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qa-deadline-'));
const LEAF = path.join(ROOT, 'leaf.ts');
const DRIVER = path.join(ROOT, 'driver.ts');
fs.writeFileSync(LEAF, `
import { writeFileSync } from 'node:fs';
setInterval(() => {}, 1000);
await new Promise(resolve => process.stdout.write('leaf ready\\n', resolve));
writeFileSync(process.argv[2], String(process.pid));
`);
fs.writeFileSync(DRIVER, `
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
writeFileSync(process.argv[5], String(process.pid));
const leaf = spawn(process.execPath, [process.argv[3], process.argv[4]], {
  stdio: 'inherit', detached: process.platform === 'win32',
});
leaf.unref();
const readyBy = Date.now() + 3000;
while (!existsSync(process.argv[4])) {
  if (Date.now() > readyBy) process.exit(11);
  await Bun.sleep(10);
}
if (process.argv[2] === 'early') process.exit(7);
setInterval(() => {}, 1000);
`);
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function fixture() {
  const dir = fs.mkdtempSync(path.join(ROOT, 'case-'));
  return { dir, receipt: path.join(dir, 'deadline.json'), marker: path.join(dir, 'effect'),
    leaf: path.join(dir, 'leaf.pid'), direct: path.join(dir, 'direct.pid') };
}

function cli(args: string[], preload?: string) {
  return spawnSync(process.execPath, [...(preload ? ['--preload', preload] : []), CLI, ...args], {
    encoding: 'utf8', timeout: 10_000,
  });
}

function receipt(output: string) {
  const line = output.trim();
  expect(line.startsWith('QA_DEADLINE ')).toBe(true);
  const value = JSON.parse(line.slice('QA_DEADLINE '.length));
  expect(value.guard).toBe('qa-deadline');
  return value;
}

function background(args: string[], preload?: string) {
  const child = spawn(process.execPath, [...(preload ? ['--preload', preload] : []), CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout!.on('data', chunk => { stdout += chunk; });
  child.stderr!.on('data', chunk => { stderr += chunk; });
  const result = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, result };
}

// POSIX: the held stream is a FIFO the test reads only after resume(), so the
// kernel pipe buffer (not Bun's socketpair sizing or reader) keeps the 2 MB
// write blocked. Windows keeps the paused child pipe.
function heldOutput(dir: string, args: string[], preload: string, held: 1 | 2) {
  if (process.platform === 'win32') {
    const runner = background(args, preload);
    const stream = held === 1 ? runner.child.stdout! : runner.child.stderr!;
    stream.pause();
    return { child: runner.child, resume: () => { stream.resume(); }, result: runner.result };
  }
  const fifo = path.join(dir, 'held-output.fifo');
  expect(spawnSync('mkfifo', [fifo], { timeout: 5000 }).status).toBe(0);
  const readFd = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  const writeFd = fs.openSync(fifo, 'w');
  const stdio: Array<'ignore' | 'pipe' | number> = ['ignore', 'pipe', 'pipe'];
  stdio[held] = writeFd;
  const child = spawn(process.execPath, ['--preload', preload, CLI, ...args], { stdio });
  fs.closeSync(writeFd);
  let heldText = '', pipedText = '';
  (held === 1 ? child.stderr : child.stdout)!.on('data', chunk => { pipedText += chunk; });
  let ended!: () => void;
  const eof = new Promise<void>(resolve => { ended = resolve; });
  let draining: ReturnType<typeof setInterval> | undefined;
  const drain = () => {
    const buffer = Buffer.alloc(65536);
    for (;;) {
      let read = 0;
      try { read = fs.readSync(readFd, buffer, 0, buffer.length, null); } catch (error: any) { if (error.code === 'EAGAIN') return; throw error; }
      if (read === 0) { clearInterval(draining); fs.closeSync(readFd); ended(); return; }
      heldText += buffer.subarray(0, read).toString();
    }
  };
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const result = Promise.all([closed, eof]).then(([{ code, signal }]) => ({ code, signal,
    stdout: held === 1 ? heldText : pipedText, stderr: held === 2 ? heldText : pipedText }));
  return { child, resume: () => { draining ??= setInterval(drain, 5); }, result };
}

function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function ready(file: string) {
  // Fixtures write their pid with writeFileSync: the file exists before its digits do.
  const written = () => { try { return Number(fs.readFileSync(file, 'utf8')) || 0; } catch { return 0; } };
  for (let i = 0; i < 300 && written() <= 0; i++) await Bun.sleep(10);
  expect(fs.existsSync(file)).toBe(true);
  const pid = written();
  expect(pid).toBeGreaterThan(0);
  return pid;
}

async function dead(pid: number) {
  for (let i = 0; i < 100 && alive(pid); i++) await Bun.sleep(20);
  expect(alive(pid)).toBe(false);
}

function cleanup(files: string[]) {
  for (const file of files) {
    try {
      const pid = Number(fs.readFileSync(file, 'utf8'));
      if (Number.isSafeInteger(pid) && pid > 0 && alive(pid)) process.kill(pid, 'SIGKILL');
    } catch {}
  }
}

test('start publishes a validated immutable receipt and status reports real remaining time', () => {
  const f = fixture();
  const start = cli(['start', f.receipt, '30']);
  expect(start.status, start.stderr).toBe(0);
  expect(start.stdout.startsWith('\nQA_DEADLINE ')).toBe(true);
  expect(start.stdout.endsWith('\n')).toBe(true);
  const state = JSON.parse(fs.readFileSync(f.receipt, 'utf8'));
  expect(state.version).toBe(1);
  expect(Date.parse(state.deadlineAt) - Date.parse(state.startedAt)).toBe(30_000);
  expect(state.budgetMs).toBe(30_000);
  const status = cli(['status', f.receipt]);
  expect(status.status).toBe(0);
  const observed = receipt(status.stdout);
  expect(observed.remainingMs).toBeGreaterThan(0);
  expect(observed.remainingMs).toBeLessThanOrEqual(30_000);
  expect(observed.expired).toBe(false);
  expect(observed.remainingMs).toBe(Date.parse(observed.deadlineAt) - Date.parse(observed.observedAt));
  const before = fs.readFileSync(f.receipt, 'utf8');
  expect(cli(['start', f.receipt, '300']).status).toBe(2);
  expect(fs.readFileSync(f.receipt, 'utf8')).toBe(before);
  if (process.platform !== 'win32') expect(fs.statSync(f.receipt).mode & 0o777).toBe(0o400);
});

test('concurrent start cannot reset or publish partial state', async () => {
  const f = fixture();
  const results = await Promise.all([background(['start', f.receipt, '30']).result, background(['start', f.receipt, '60']).result]);
  expect(results.map(result => result.code).sort()).toEqual([0, 2]);
  expect(cli(['status', f.receipt]).status).toBe(0);
  expect(fs.readdirSync(f.dir)).toEqual(['deadline.json']);
});

test('caller deadline clamps the receipt and a later caller deadline cannot extend it', () => {
  const f = fixture();
  const earlier = new Date(Date.now() + 10_000).toISOString();
  const first = cli(['start', f.receipt, '30', earlier]);
  expect(first.status, first.stderr).toBe(0);
  expect(receipt(first.stdout).deadlineAt).toBe(earlier);
  const second = cli(['start', path.join(f.dir, 'later.json'), '1', new Date(Date.now() + 60_000).toISOString()]);
  const state = receipt(second.stdout);
  expect(Date.parse(state.deadlineAt) - Date.parse(state.startedAt)).toBe(1000);
  const fractional = cli(['start', path.join(f.dir, 'fractional.json'), '1.001']);
  expect(receipt(fractional.stdout).budgetMs).toBe(1001);
});

test('R66 expired-before-probe refuses dispatch without any side effect', () => {
  const f = fixture();
  expect(cli(['start', f.receipt, '30', '2026-09-27T14:33:01Z']).status).toBe(124);
  const result = cli(['run', f.receipt, '--', process.execPath, '-e', 'require("fs").writeFileSync(process.argv[1], "probed")', f.marker]);
  expect(result.status).toBe(124);
  expect(result.stdout).toBe('');
  expect(receipt(result.stderr).event).toBe('expired');
  expect(fs.existsSync(f.marker)).toBe(false);
  const status = cli(['status', f.receipt]);
  expect(status.status).toBe(124);
  expect(receipt(status.stdout)).toMatchObject({ expired: true, remainingMs: 0 });
});

test('expiry during dispatch preparation is rechecked before creating a child', () => {
  const f = fixture();
  expect(cli(['start', f.receipt, '30']).status).toBe(0);
  const preload = path.join(f.dir, 'clock-jump.ts');
  fs.writeFileSync(preload, `const now = Date.now(); let reads = 0; Date.now = () => now + (reads++ ? 60000 : 0);`);
  const result = cli(['run', f.receipt, '--', process.execPath, '-e', 'require("fs").writeFileSync(process.argv[1], "probed")', f.marker], preload);
  expect(result.status).toBe(124);
  expect(receipt(result.stderr).event).toBe('expired');
  expect(fs.existsSync(f.marker)).toBe(false);
});

test.each(['0', '-1', 'NaN', 'Infinity', '2147484', '1e3', '0.0001', ''])('invalid duration fails closed: %s', seconds => {
  const f = fixture();
  expect(cli(['start', f.receipt, seconds]).status).toBe(2);
  expect(fs.existsSync(f.receipt)).toBe(false);
});

test.each(['not a date', '2026-02-30T00:00:00Z', '2026-09-27T14:33:01+00:00'])('invalid caller UTC fails closed: %s', earlier => {
  const f = fixture();
  expect(cli(['start', f.receipt, '30', earlier]).status).toBe(2);
  expect(fs.existsSync(f.receipt)).toBe(false);
});

test.each(['missing', 'json', 'version', 'extended', 'future-start', 'directory'])('invalid guard state cannot dispatch: %s', mode => {
  const f = fixture();
  if (mode === 'directory') fs.mkdirSync(f.receipt);
  else if (mode !== 'missing') {
    const state = { version: mode === 'version' ? 2 : 1, startedAt: new Date(Date.now() + (mode === 'future-start' ? 60_000 : 0)).toISOString(),
      deadlineAt: new Date(Date.now() + 120_000).toISOString(), budgetMs: mode === 'extended' ? 1000 : 120_000 };
    fs.writeFileSync(f.receipt, mode === 'json' ? '{' : JSON.stringify(state));
  }
  const result = cli(['run', f.receipt, '--', process.execPath, '-e', 'require("fs").writeFileSync(process.argv[1], "probed")', f.marker]);
  expect(result.status).toBe(2);
  expect(fs.existsSync(f.marker)).toBe(false);
  expect(cli(['status', f.receipt]).status).toBe(2);
  if (!['missing', 'directory'].includes(mode)) {
    const before = fs.readFileSync(f.receipt, 'utf8');
    expect(cli(['start', f.receipt, '30']).status).toBe(2);
    expect(fs.readFileSync(f.receipt, 'utf8')).toBe(before);
  }
});

test('symlinked receipt or parent and malformed paths are refused', () => {
  const f = fixture();
  const parent = path.join(f.dir, 'linked-parent');
  fs.symlinkSync(f.dir, parent, process.platform === 'win32' ? 'junction' : 'dir');
  expect(cli(['start', path.join(parent, 'guard.json'), '30']).status).toBe(2);
  expect(fs.existsSync(path.join(f.dir, 'guard.json'))).toBe(false);
  if (process.platform !== 'win32') {
    fs.symlinkSync(f.marker, f.receipt);
    expect(cli(['start', f.receipt, '30']).status).toBe(2);
    expect(cli(['run', f.receipt, '--', process.execPath, '-e', 'process.exit(0)']).status).toBe(2);
    expect(fs.existsSync(f.marker)).toBe(false);
  }
  expect(cli(['start', f.dir + path.sep + '..' + path.sep + 'escaped.json', '30']).status).toBe(2);
  expect(cli(['start', path.join(f.dir, 'missing', 'guard.json'), '30']).status).toBe(2);
});

test('argv with spaces and shell metacharacters is literal; stdout and nonzero child status are preserved', () => {
  const f = fixture();
  expect(cli(['start', f.receipt, '30']).status).toBe(0);
  const argument = `spaces ; $(echo not-evaluated) & ${f.marker}`;
  const result = cli(['run', f.receipt, '--', process.execPath, '-e', 'process.stdout.write(process.argv[1]); process.exit(17)', argument]);
  expect(result.status).toBe(17);
  expect(result.stdout).toBe(argument);
  expect(result.stderr).not.toContain(argument);
  expect(fs.existsSync(f.marker)).toBe(false);
  expect(cli(['run', f.receipt, '--', path.join(f.dir, 'missing-command')]).status).toBe(127);
  expect(cli(['run', f.receipt, process.execPath]).status).toBe(2);
});

test('Windows containment initialization failure refuses dispatch', () => {
  const f = fixture();
  expect(cli(['start', f.receipt, '30']).status).toBe(0);
  const preload = path.join(f.dir, 'failed-job.ts');
  fs.writeFileSync(preload, `Object.defineProperty(process, 'platform', { value: 'win32' }); Object.defineProperty(process, 'pid', { value: 0 });`);
  const result = cli(['run', f.receipt, '--', process.execPath, '-e', 'require("fs").writeFileSync(process.argv[1], "probed")', f.marker], preload);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('Windows process containment is unavailable');
  expect(fs.existsSync(f.marker)).toBe(false);
});

test('guard receipts cannot masquerade as extra native JSON in merged Bash output', () => {
  const f = fixture();
  expect(receipt(cli(['start', f.receipt, '30']).stdout).event).toBe('start');
  const result = cli(['run', f.receipt, '--', process.execPath, '-e', 'console.log(JSON.stringify({native:true}))']);
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('{"native":true}\n');
  const events = result.stderr.split('\n').filter(line => line.startsWith('QA_DEADLINE ')).map(receipt);
  expect(events.map(event => event.event)).toEqual(['started', 'finished']);
  for (const event of events) {
    expect(Number.isFinite(Date.parse(event.observedAt))).toBe(true);
    expect(Number.isFinite(Date.parse(event.deadlineAt))).toBe(true);
  }
  expect((result.stdout + result.stderr).trim().split('\n').filter(line => line.startsWith('{'))).toHaveLength(1);
  expect(receipt(cli(['run', f.receipt]).stderr).event).toBe('error');
});

test.each(['stdout', 'stderr', 'both'])('receipt framing survives newline-free child %s on one shared capture descriptor', stream => {
  const f = fixture();
  expect(cli(['start', f.receipt, '30']).status).toBe(0);
  const capture = path.join(f.dir, 'merged-output');
  const fd = fs.openSync(capture, 'w');
  const payload = stream === 'both' ? 'stdout textstderr text' : '{"native":true}';
  const command = stream === 'both'
    ? 'require("fs").writeSync(1, "stdout text"); require("fs").writeSync(2, "stderr text")'
    : `require("fs").writeSync(${stream === 'stdout' ? 1 : 2}, ${JSON.stringify(payload)})`;
  try {
    const result = spawnSync(process.execPath, [CLI, 'run', f.receipt, '--', process.execPath, '-e', command], {
      stdio: ['ignore', fd, fd], timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  } finally {
    fs.closeSync(fd);
  }
  const merged = fs.readFileSync(capture, 'utf8');
  const lines = merged.split('\n');
  const events = lines.filter(line => line.startsWith('QA_DEADLINE ')).map(receipt);
  expect(events.map(event => event.event)).toEqual(['started', 'finished']);
  expect(merged.replace(/\nQA_DEADLINE [^\n]*\n/g, '')).toBe(payload);
  expect(merged.endsWith('\n')).toBe(true);
  if (stream !== 'both') expect(JSON.parse(lines.find(line => line === payload)!)).toEqual({ native: true });
});

test.each(['start', 'expired', 'finished', 'timeout', 'blocked-forever'])('guard %s receipts survive a blocked output pipe without extending command execution', async mode => {
  const f = fixture();
  const timedOut = mode === 'timeout' || mode === 'blocked-forever';
  if (mode !== 'start') expect(cli(['start', f.receipt, timedOut ? '2' : '30',
    ...(mode === 'expired' ? ['2000-01-01T00:00:00Z'] : [])]).status).toBe(mode === 'expired' ? 124 : 0);
  const preload = path.join(f.dir, 'blocked-output.ts');
  const queued = path.join(f.dir, 'queued');
  fs.writeFileSync(preload, `
import * as fs from 'node:fs';
import { spyOn } from 'bun:test';
const createWriteStream = fs.createWriteStream;
spyOn(fs, 'createWriteStream').mockImplementation((...args) => {
  const stream = createWriteStream(...args);
  if (args[1]?.fd !== ${mode === 'start' ? 1 : 2}) return stream;
  const write = stream.write.bind(stream);
  let filled = false;
  stream.write = (chunk, ...rest) => {
    if (typeof chunk === 'string' && chunk.startsWith('\\nQA_DEADLINE ')) {
      if (!filled) { filled = true; write(Buffer.alloc(2 * 1024 * 1024, 32)); write('\\n'); }
      const result = write(chunk, ...rest);
      fs.writeFileSync(${JSON.stringify(queued)}, 'queued');
      return result;
    }
    return write(chunk, ...rest);
  };
  return stream;
});
`);
  const args = mode === 'start' ? ['start', f.receipt, '30'] : mode === 'expired'
    ? ['run', f.receipt, '--', process.execPath, '-e', 'require("fs").writeFileSync(process.argv[1], "probed")', f.marker]
    : ['run', f.receipt, '--', process.execPath, DRIVER, timedOut ? 'timeout' : 'early', LEAF, f.leaf, f.direct];
  const runner = heldOutput(f.dir, args, preload, mode === 'start' ? 1 : 2);
  try {
    for (let i = 0; i < 300 && !fs.existsSync(queued); i++) await Bun.sleep(10);
    expect(fs.existsSync(queued)).toBe(true);
    if (mode === 'finished' || timedOut) {
      await dead(await ready(f.leaf));
      await dead(await ready(f.direct));
    }
    expect(runner.child.exitCode).toBeNull();
    if (mode === 'blocked-forever') {
      const code = await new Promise<number | null>(resolve => runner.child.once('exit', resolve));
      expect(code).toBe(2);
      runner.resume();
      await runner.result;
      return;
    }
    runner.resume();
    const result = await runner.result;
    expect(result.code).toBe(mode === 'start' ? 0 : mode === 'finished' ? 7 : 124);
    const output = mode === 'start' ? result.stdout : result.stderr;
    const events = output.trim().split('\n').filter(line => line.startsWith('QA_DEADLINE ')).map(receipt);
    expect(events.map(event => event.event)).toEqual(mode === 'start' ? ['start'] : mode === 'expired' ? ['expired'] : ['started', 'finished']);
    if (mode === 'expired') expect(fs.existsSync(f.marker)).toBe(false);
    if (mode === 'timeout') expect(events.at(-1).timedOut).toBe(true);
  } finally {
    runner.resume();
    runner.child.kill('SIGKILL');
    cleanup([f.leaf, f.direct]);
    await runner.result;
  }
}, 15_000);

test('native receipt writes cannot block the output-settlement deadline on a full pipe', async () => {
  const f = fixture();
  const preload = path.join(f.dir, 'full-pipe.ts');
  const writing = path.join(f.dir, 'stdout-writing');
  // POSIX: stdout is a FIFO this test never reads, so the kernel holds the 2 MB
  // write. A paused Bun child stream can still be drained under load (CI run
  // 36761671811 exited 0 after 128 ms). Windows keeps the paused child pipe.
  const fifo = process.platform === 'win32' ? null : path.join(f.dir, 'stdout.fifo');
  if (fifo) expect(spawnSync('mkfifo', [fifo], { timeout: 5000 }).status).toBe(0);
  const readFd = fifo ? fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK) : -1;
  const writeFd = fifo ? fs.openSync(fifo, 'w') : -1;
  fs.writeFileSync(preload, `
import { write, writeFileSync } from 'node:fs';
write(1, Buffer.alloc(2 * 1024 * 1024, 32), () => {});
writeFileSync(${JSON.stringify(writing)}, '');
await Bun.sleep(100);
`);
  const child = spawn(process.execPath, ['--preload', preload, CLI, 'start', f.receipt, '30'], { stdio: ['ignore', fifo ? writeFd : 'pipe', 'pipe'] });
  if (fifo) fs.closeSync(writeFd);
  let stderr = '';
  child.stderr!.on('data', chunk => { stderr += chunk; });
  child.stdout?.pause();
  const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    for (let index = 0; index < 500 && !fs.existsSync(writing) && child.exitCode === null; index++) await Bun.sleep(10);
    expect(fs.existsSync(writing), stderr).toBe(true);
    const code = await Promise.race([exited, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 7000); })]);
    expect(fs.existsSync(f.receipt)).toBe(true);
    expect(code, stderr).toBe(2);
  } finally {
    clearTimeout(timer);
    child.stdout?.resume();
    child.kill('SIGKILL');
    await closed;
    if (fifo) fs.closeSync(readFd);
  }
}, 15_000);

test('internal worker relays every guard receipt before its containment process exits', async () => {
  const f = fixture();
  expect(cli(['start', f.receipt, '30']).status).toBe(0);
  const worker = spawn(process.execPath, [CLI, '--receipt-worker', 'run', f.receipt, '--', process.execPath, '-e', 'process.exit(17)'], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const messages: any[] = [];
  worker.on('message', message => messages.push(message));
  const code = await new Promise<number | null>(resolve => worker.once('close', resolve));
  expect(code).toBe(17);
  expect(messages.map(message => message.type)).toEqual(['qa-deadline-receipt', 'qa-deadline-receipt']);
  expect(messages.map(message => message.receipt.event)).toEqual(['started', 'finished']);
  expect(messages.at(-1).receipt).toMatchObject({ timedOut: false, exitCode: 17 });
  expect(cli(['--receipt-worker', 'status', f.receipt]).status).toBe(2);
});

test('completion classification and observedAt use the same pre-cleanup instant', () => {
  const f = fixture();
  expect(cli(['start', f.receipt, '30']).status).toBe(0);
  const preload = path.join(f.dir, 'cleanup-clock.ts');
  fs.writeFileSync(preload, `
import { readFileSync, writeFileSync } from 'node:fs';
import { ChildProcess } from 'node:child_process';
const NativeDate = Date;
const deadline = NativeDate.parse(JSON.parse(readFileSync(${JSON.stringify(f.receipt)}, 'utf8')).deadlineAt);
let now = NativeDate.now();
globalThis.Date = class extends NativeDate {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
};
const advance = () => { now = deadline + 1000; writeFileSync(${JSON.stringify(f.marker)}, String(now)); };
const kill = process.kill.bind(process);
process.kill = (...args) => { advance(); return kill(...args); };
const childKill = ChildProcess.prototype.kill;
ChildProcess.prototype.kill = function(...args) { advance(); return childKill.apply(this, args); };
`);
  const result = cli(['run', f.receipt, '--', process.execPath, '-e', 'process.exit(0)'], preload);
  expect(result.status, result.stderr).toBe(0);
  const finished = receipt(result.stderr.trim().split('\n').at(-1)!);
  expect(finished.timedOut).toBe(false);
  expect(Number(fs.readFileSync(f.marker, 'utf8'))).toBeGreaterThan(Date.parse(finished.deadlineAt));
  expect(Date.parse(finished.observedAt)).toBeLessThan(Date.parse(finished.deadlineAt));
});

test('unsupported platform refuses dispatch rather than weakening containment', () => {
  const f = fixture();
  expect(cli(['start', f.receipt, '30']).status).toBe(0);
  const preload = path.join(f.dir, 'unsupported.ts');
  fs.writeFileSync(preload, `Object.defineProperty(process, 'platform', { value: 'freebsd' });`);
  const result = cli(['run', f.receipt, '--', process.execPath, '-e', 'require("fs").writeFileSync(process.argv[1], "probed")', f.marker], preload);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('Process containment is unavailable');
  expect(fs.existsSync(f.marker)).toBe(false);
});

test.each(['timeout', 'early'])('owned process tree closes without pipe hangs after %s', async mode => {
  const f = fixture();
  const sibling = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const siblingClosed = new Promise<void>(resolve => sibling.once('close', () => resolve()));
  try {
    expect(cli(['start', f.receipt, mode === 'timeout' ? '3' : '10']).status).toBe(0);
    const result = cli(['run', f.receipt, '--', process.execPath, DRIVER, mode, LEAF, f.leaf, f.direct]);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(mode === 'timeout' ? 124 : 7);
    expect(result.stdout).toContain('leaf ready');
    const finished = receipt(result.stderr.trim().split('\n').at(-1)!);
    expect(finished.timedOut).toBe(mode === 'timeout');
    expect(Number.isFinite(Date.parse(finished.observedAt))).toBe(true);
    await dead(await ready(f.leaf));
    await dead(await ready(f.direct));
    expect(alive(sibling.pid!)).toBe(true);
  } finally {
    cleanup([f.leaf, f.direct]);
    sibling.kill('SIGKILL');
    await siblingClosed;
  }
}, 15_000);

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  test.skipIf(process.platform === 'win32')(`interruption ${signal} closes the owned process tree`, async () => {
    const f = fixture();
    expect(cli(['start', f.receipt, '10']).status).toBe(0);
    const runner = background(['run', f.receipt, '--', process.execPath, DRIVER, 'timeout', LEAF, f.leaf, f.direct]);
    try {
      const leaf = await ready(f.leaf);
      runner.child.kill(signal);
      expect((await runner.result).code).toBe(signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 129);
      await dead(leaf);
      await dead(await ready(f.direct));
    } finally {
      runner.child.kill('SIGKILL');
      cleanup([f.leaf, f.direct]);
      await runner.result;
    }
  }, 15_000);
}

test.skipIf(process.platform !== 'win32')('abrupt Windows wrapper exit closes the job', async () => {
  const f = fixture();
  expect(cli(['start', f.receipt, '10']).status).toBe(0);
  const runner = background(['run', f.receipt, '--', process.execPath, DRIVER, 'timeout', LEAF, f.leaf, f.direct]);
  try {
    const leaf = await ready(f.leaf);
    runner.child.kill('SIGKILL');
    await runner.result;
    await dead(leaf);
    await dead(await ready(f.direct));
  } finally {
    runner.child.kill('SIGKILL');
    cleanup([f.leaf, f.direct]);
    await runner.result;
  }
}, 15_000);
