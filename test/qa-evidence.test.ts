import { afterAll, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';

import { qaCommandAllowed } from './helpers/qa-functional-observer';
import { qaCallerCommandAllowed } from './helpers/qa-callers-fixture';

const CLI = path.resolve(import.meta.dir, '../bin/gstack-qa-evidence');
const ROOT = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qa-evidence-'));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function fixture() {
  const root = fs.mkdtempSync(path.join(ROOT, 'case-'));
  const run = (...args: string[]) => {
    expect(JSON.stringify([process.execPath, CLI, ...args]).length, 'Fixture argv must stay short for Windows process launch').toBeLessThan(8192);
    const result = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', timeout: 10_000 });
    expect(result.error, result.error?.message).toBeUndefined();
    return result;
  };
  const json = (name: string, value: unknown) => fs.writeFileSync(path.join(root, name), JSON.stringify(value), { mode: 0o600 });
  const capture = (id: string, program: string, timeout = '4000') => run('capture', root, id, '--timeout-ms', timeout, '--', process.execPath, '-e', program);
  return { root, run, json, capture };
}

function receipt(text: string) {
  expect(text.trim().startsWith('QA_EVIDENCE ')).toBe(true);
  return JSON.parse(text.trim().slice('QA_EVIDENCE '.length));
}

test('native capture executes once, preserves exact JSON and stderr, and materializes without transcription', () => {
  const f = fixture();
  const observed = { stateRoot: '/home/runner/.cache/owned', windows: 'C:\\owned\\a.json', text: '雪\n\t"\\', rows: ['abc'.repeat(20000)], value: 7, absent: null };
  f.json('payload.json', observed);
  const result = f.capture('001', `const fs = require('node:fs'); fs.appendFileSync('effects', 'once'); process.stderr.write('diagnostic\\n'); console.log(fs.readFileSync('payload.json', 'utf8'));`);
  expect(result.status, result.stderr).toBe(0);
  const captured = receipt(result.stdout);
  expect(captured).toMatchObject({ action: 'capture', status: 'complete', id: '001', exitCode: 0 });
  expect(captured.durationMs).toBe(Date.parse(captured.completedAt) - Date.parse(captured.startedAt));
  expect(captured.remainingMs).toBeUndefined();
  expect(result.stdout).not.toContain('stateRoot');
  expect(result.stderr).toBe('');
  expect(fs.readFileSync(path.join(f.root, 'effects'), 'utf8')).toBe('once');
  expect(fs.readFileSync(path.join(f.root, '.qa-evidence/001/stdout'), 'utf8')).toBe(JSON.stringify(observed) + '\n');
  expect(fs.readFileSync(path.join(f.root, '.qa-evidence/001/stderr'), 'utf8')).toBe('diagnostic\n');
  f.json('intent.json', { capture: '001', observationCommand: 'first native command', hypothesis: 'The successful boundary suggests testing the rejected input next.', nextCommand: 'second native command' });
  const checkpoint = f.run('checkpoint', f.root, '001', 'intent.json');
  expect(checkpoint.status, checkpoint.stderr).toBe(0);
  expect(receipt(checkpoint.stdout)).toMatchObject({ action: 'checkpoint', status: 'complete', id: '001', link: '[checkpoint 001](exploration-001.json)' });
  expect(JSON.parse(fs.readFileSync(path.join(f.root, 'exploration-001.json'), 'utf8'))).toEqual({
    observationCommand: 'first native command', observed, hypothesis: 'The successful boundary suggests testing the rejected input next.', nextCommand: 'second native command',
  });
  f.json('annotations.json', { revision: 'revision', evidence: [], learning: [] });
  const rejected = f.run('materialize', f.root, 'annotations.json');
  expect(rejected.status).toBe(2);
  expect(receipt(rejected.stderr).message).toContain('need limits (non-empty string array)');
  f.json('annotations.json', { revision: 'revision', limits: ['Only the declared contract was checked.'], evidence: [{ capture: '001', command: 'first native command', contract: 'README.md', expected: 'Declared exact result', classification: 'pass' }], learning: ['001'] });
  const report = f.run('materialize', f.root, 'annotations.json');
  expect(report.status, report.stderr).toBe(0);
  const final = JSON.parse(fs.readFileSync(path.join(f.root, 'evidence.json'), 'utf8'));
  expect(final.evidence).toEqual([{ command: 'first native command', contract: 'README.md', expected: 'Declared exact result', classification: 'pass', observed }]);
  expect(final.learning).toEqual([{ observationCommand: 'first native command', hypothesis: 'The successful boundary suggests testing the rejected input next.', nextCommand: 'second native command' }]);
  expect(fs.readFileSync(path.join(f.root, 'effects'), 'utf8')).toBe('once');
  expect(f.capture('001', `require('node:fs').appendFileSync('effects', 'twice')`).status).toBe(2);
  expect(fs.readFileSync(path.join(f.root, 'effects'), 'utf8')).toBe('once');
  expect(f.run('checkpoint', f.root, '001', 'intent.json').status).toBe(2);
  expect(f.run('materialize', f.root, 'annotations.json').status).toBe(2);
  if (process.platform !== 'win32') {
    for (const name of ['exploration-001.json', 'evidence.json', '.qa-evidence/001/stdout', '.qa-evidence/001/stderr', '.qa-evidence/001/receipt.json']) expect(fs.statSync(path.join(f.root, name)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(f.root, '.qa-evidence')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(f.root, '.qa-evidence/001')).mode & 0o777).toBe(0o700);
  }
});

test('complete nonzero commands retain their actual exit, and non-JSON observations retain all bytes', () => {
  const f = fixture();
  const result = f.capture('001', `process.stdout.write('  exact\\ntext\\n'); process.stderr.write('separate warning\\n'); process.exitCode = 69;`);
  expect(result.status).toBe(69);
  expect(receipt(result.stdout)).toMatchObject({ status: 'complete', exitCode: 69 });
  f.json('intent.json', { capture: '001', observationCommand: 'dependency check', hypothesis: 'The unavailable dependency leaves an independent valid contract to check.', nextCommand: 'adjacent check' });
  expect(f.run('checkpoint', f.root, '001', 'intent.json').status).toBe(0);
  expect(JSON.parse(fs.readFileSync(path.join(f.root, 'exploration-001.json'), 'utf8')).observed).toBe('  exact\ntext\n');
});

test('expired and timed-out captures cannot produce checkpoint observations', () => {
  const f = fixture();
  const result = f.capture('001', `console.log('{}'); setInterval(() => {}, 1000);`, '100');
  expect(result.status).toBe(124);
  expect(receipt(result.stdout)).toMatchObject({ status: 'incomplete', exitCode: 124 });
  f.json('intent.json', { capture: '001', observationCommand: 'timed-out check', hypothesis: 'An incomplete capture must never be promoted to passing evidence.', nextCommand: 'next check' });
  expect(f.run('checkpoint', f.root, '001', 'intent.json').status).toBe(2);
  expect(fs.existsSync(path.join(f.root, 'exploration-001.json'))).toBe(false);
});

test('capture shares a working-directory-relative deadline without resetting or relocating it', () => {
  const f = fixture();
  fs.mkdirSync(path.join(f.root, 'reports'));
  const guard = spawnSync(process.execPath, [path.resolve(import.meta.dir, '../bin/gstack-qa-deadline'), 'start', 'reports/deadline.json', '5'],
    { cwd: f.root, encoding: 'utf8', timeout: 10000 });
  expect(guard.status, guard.stderr).toBe(0);
  const before = fs.readFileSync(path.join(f.root, 'reports/deadline.json'));
  const result = f.run('capture', 'reports', '001', '--deadline', 'reports/deadline.json', '--', process.execPath, '-e', 'console.log("{}")');
  expect(result.status, result.stderr).toBe(0);
  const captured = receipt(result.stdout);
  expect(captured).toMatchObject({ status: 'complete', exitCode: 0 });
  expect(captured.remainingMs).toBeGreaterThan(0);
  expect(captured.remainingMs).toBeLessThanOrEqual(5000);
  expect(fs.readFileSync(path.join(f.root, 'reports/deadline.json'))).toEqual(before);
  expect(fs.existsSync(path.join(f.root, 'reports/.qa-evidence/001/deadline.json'))).toBe(false);
});

test.each(['stdout', 'stderr', 'receipt.json'])('changed captured %s fails closed', name => {
  const f = fixture();
  expect(f.capture('001', `console.log(JSON.stringify({ value: 7 }));`).status).toBe(0);
  fs.appendFileSync(path.join(f.root, '.qa-evidence/001', name), 'changed');
  f.json('intent.json', { capture: '001', observationCommand: 'first command', hypothesis: 'The next command checks an adjacent boundary with retained evidence.', nextCommand: 'next command' });
  expect(f.run('checkpoint', f.root, '001', 'intent.json').status).toBe(2);
  expect(fs.existsSync(path.join(f.root, 'exploration-001.json'))).toBe(false);
});

test.each(['intent-link', 'capture-link', 'hard-link', 'outside-root', 'extra-observed', 'missing-capture'])('unowned or fabricated source fails closed: %s', mode => {
  const f = fixture();
  expect(f.capture('001', `console.log('{}');`).status).toBe(0);
  const intent: Record<string, unknown> = { capture: mode === 'missing-capture' ? '002' : '001', observationCommand: 'first command', hypothesis: 'The next command tests a different boundary without rewriting observations.', nextCommand: 'next command' };
  if (mode === 'extra-observed') intent.observed = { invented: true };
  f.json('intent.json', intent);
  let source = 'intent.json';
  if (mode === 'intent-link') { fs.symlinkSync(path.join(f.root, source), path.join(f.root, 'linked.json')); source = 'linked.json'; }
  if (mode === 'hard-link') fs.linkSync(path.join(f.root, source), path.join(f.root, 'linked.json'));
  if (mode === 'capture-link') { fs.renameSync(path.join(f.root, '.qa-evidence/001/stdout'), path.join(f.root, 'original')); fs.symlinkSync(path.join(f.root, 'original'), path.join(f.root, '.qa-evidence/001/stdout')); }
  if (mode === 'outside-root') source = '../outside.json';
  expect(f.run('checkpoint', f.root, '001', source).status).toBe(2);
  expect(fs.existsSync(path.join(f.root, 'exploration-001.json'))).toBe(false);
});

test('explicit public capture returns exact safe observations and inline intent preserves the four-field checkpoint', () => {
  const f = fixture();
  const observed = { stateRoot: '/owned/.cache/project', value: '雪\\path\n' };
  const captured = f.run('capture', f.root, '001', '--public', '--timeout-ms', '4000', '--', process.execPath, '-e', `console.log(${JSON.stringify(JSON.stringify(observed))})`);
  expect(captured.status, captured.stderr).toBe(0);
  expect(JSON.parse(captured.stdout.split('\n')[0])).toEqual(observed);
  expect(receipt(captured.stdout.split('\n').find(line => line.startsWith('QA_EVIDENCE '))!)).toMatchObject({ publicOutput: true, status: 'complete' });
  expect(f.run('checkpoint', f.root, '001', '001', 'observed command', 'The completed public result suggests checking another boundary.', 'next command').status).toBe(0);
  const note = JSON.parse(fs.readFileSync(path.join(f.root, 'exploration-001.json'), 'utf8'));
  expect(Object.keys(note).sort()).toEqual(['hypothesis', 'nextCommand', 'observationCommand', 'observed']);
  expect(note.observed).toEqual(observed);
});

test('public permission never exposes detected credentials in output or receipts', () => {
  const f = fixture();
  const credential = ['gh', 'p_'].join('') + randomBytes(18).toString('hex');
  const result = f.run('capture', f.root, '001', '--public', '--timeout-ms', '4000', '--', process.execPath, '-e', `console.log(JSON.stringify({ credential: ${JSON.stringify(credential)} }));`);
  expect(result.status).toBe(2);
  expect(receipt(result.stdout)).toMatchObject({ status: 'sensitive', publicOutput: true });
  expect(result.stdout + result.stderr).not.toContain(credential);
  expect(fs.existsSync(path.join(f.root, '.qa-evidence/001/observation.json'))).toBe(false);
  expect(f.run('checkpoint', f.root, '001', '001', 'sensitive command', 'This cannot be promoted into a safe observation or passing checkpoint.', 'next command').status).toBe(2);
});

test.each(['resumed', 'blocked-forever'])('evidence receipts survive a genuinely %s stdout pipe without extending command execution', async mode => {
  const f = fixture();
  const preload = path.join(f.root, 'full-pipe.ts');
  const writing = path.join(f.root, 'stdout-writing');
  const saturated = path.join(f.root, 'stdout-saturated');
  // POSIX: stdout is a FIFO this test never reads until it chooses to, so the
  // 2 MB write is held by the kernel, not by how the runtime buffers a paused
  // child stream (under load Bun could drain a paused pipe and let the child
  // finish early). Windows keeps the paused child pipe.
  const fifo = process.platform === 'win32' ? null : path.join(f.root, 'stdout.fifo');
  if (fifo) expect(spawnSync('mkfifo', [fifo], { timeout: 5000 }).status).toBe(0);
  const readFd = fifo ? fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK) : -1;
  const writeFd = fifo ? fs.openSync(fifo, 'w') : -1;
  fs.writeFileSync(preload, `import { existsSync, write, writeFileSync } from 'node:fs'; if (process.argv[1] === ${JSON.stringify(CLI)}) { write(1, Buffer.alloc(2 * 1024 * 1024, 32), () => {}); writeFileSync(${JSON.stringify(writing)}, ''); while (!existsSync(${JSON.stringify(saturated)})) await Bun.sleep(10); }`);
  const child = spawn(process.execPath, ['--preload', preload, CLI, 'capture', f.root, '001', '--timeout-ms', '1000', '--', process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(path.join(f.root, 'effect'))}, 'once'); process.exit(69);`], { cwd: f.root, stdio: ['ignore', fifo ? writeFd : 'pipe', 'pipe'] });
  if (fifo) fs.closeSync(writeFd);
  let stdout = '', stderr = '';
  const drain = () => {
    if (!fifo) return;
    const buffer = Buffer.alloc(65536);
    for (;;) {
      let read = 0;
      try { read = fs.readSync(readFd, buffer, 0, buffer.length, null); } catch (error: any) { if (error.code === 'EAGAIN') return; throw error; }
      if (read === 0) return;
      stdout += buffer.subarray(0, read).toString();
    }
  };
  child.stdout?.on('data', bytes => { stdout += bytes; });
  child.stderr!.on('data', bytes => { stderr += bytes; });
  child.stdout?.pause();
  const finished = new Promise<number | null>(resolve => child.once('exit', resolve));
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let draining: ReturnType<typeof setInterval> | undefined;
  try {
    if (fifo) {
      for (let index = 0; index < 300 && !fs.existsSync(writing); index++) await Bun.sleep(10);
      expect(fs.existsSync(writing)).toBe(true);
    } else {
      for (let index = 0; index < 300 && child.stdout!.readableLength < child.stdout!.readableHighWaterMark; index++) await Bun.sleep(10);
      expect(child.stdout!.readableLength).toBeGreaterThanOrEqual(child.stdout!.readableHighWaterMark);
    }
    fs.writeFileSync(saturated, '');
    const file = path.join(f.root, '.qa-evidence/001/receipt.json');
    for (let index = 0; index < 300 && !fs.existsSync(file); index++) await Bun.sleep(10);
    expect(fs.existsSync(file)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ status: 'complete', exitCode: 69 });
    expect(fs.readFileSync(path.join(f.root, 'effect'), 'utf8')).toBe('once');
    expect(child.exitCode).toBeNull();
    if (mode === 'resumed') {
      child.stdout?.resume();
      if (fifo) draining = setInterval(drain, 5);
    }
    const exit = await Promise.race([finished, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 7000); })]);
    expect(exit, stderr).toBe(mode === 'resumed' ? 69 : 2);
    clearInterval(draining);
    drain();
    child.stdout?.resume();
    await closed;
    if (mode === 'resumed') expect(receipt(stdout.split('\n').find(line => line.startsWith('QA_EVIDENCE '))!)).toMatchObject({ status: 'complete', exitCode: 69 });
  } finally {
    clearTimeout(timer);
    clearInterval(draining);
    child.stdout?.resume();
    child.kill('SIGKILL');
    await closed;
    if (fifo) fs.closeSync(readFd);
  }
}, 15_000);

test.each(['early', 'timeout'])('capture closes owned descendants and their output handles after %s completion', async mode => {
  const f = fixture();
  const leaf = path.join(f.root, 'leaf.ts');
  const driver = path.join(f.root, 'driver.ts');
  const pidFile = path.join(f.root, 'leaf.pid');
  fs.writeFileSync(leaf, `require('node:fs').writeFileSync(process.argv[2], String(process.pid)); console.log('leaf ready'); setInterval(() => {}, 1000);`);
  fs.writeFileSync(driver, `import { spawn } from 'node:child_process'; import { existsSync } from 'node:fs'; const child = spawn(process.execPath, [${JSON.stringify(leaf)}, ${JSON.stringify(pidFile)}], { stdio: 'inherit' }); child.unref(); const until = Date.now() + 3000; while (!existsSync(${JSON.stringify(pidFile)})) { if (Date.now() > until) process.exit(11); await Bun.sleep(10); } ${mode === 'early' ? 'process.exit(7);' : 'setInterval(() => {}, 1000);'}`);
  let pid = 0;
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    const result = f.run('capture', f.root, '001', '--timeout-ms', '1000', '--', process.execPath, driver);
    expect(result.status, result.stderr).toBe(mode === 'early' ? 7 : 124);
    expect(receipt(result.stdout)).toMatchObject({ status: mode === 'early' ? 'complete' : 'incomplete' });
    pid = Number(fs.readFileSync(pidFile, 'utf8'));
    for (let index = 0; index < 100 && alive(); index++) await Bun.sleep(20);
    expect(alive()).toBe(false);
  } finally { if (pid && alive()) process.kill(pid, 'SIGKILL'); }
});

test('UTF-8 capture retains a BOM and control bytes rather than silently changing non-JSON output', () => {
  const f = fixture();
  const value = '\ufeffnative\u0000text\r\n';
  expect(f.capture('001', `process.stdout.write(${JSON.stringify(value)});`).status).toBe(0);
  expect(f.run('checkpoint', f.root, '001', '001', 'native command', 'The exact text suggests checking the next declared input boundary.', 'next command').status).toBe(0);
  expect(JSON.parse(fs.readFileSync(path.join(f.root, 'exploration-001.json'), 'utf8')).observed).toBe(value);
});

test('invalid UTF-8 is retained privately as incomplete, never reconstructed as text', () => {
  const f = fixture();
  const result = f.capture('001', 'process.stdout.write(Buffer.from([0xff, 0x80]));');
  expect(result.status).toBe(2);
  expect(receipt(result.stdout)).toMatchObject({ status: 'incomplete', exitCode: 0 });
  expect([...fs.readFileSync(path.join(f.root, '.qa-evidence/001/stdout'))]).toEqual([255, 128]);
  expect(f.run('checkpoint', f.root, '001', '001', 'native command', 'An incomplete text capture cannot qualify as an observed result.', 'next command').status).toBe(2);
});

test.skipIf(process.platform === 'win32')('unavailable Windows containment refuses the command before dispatch', () => {
  const f = fixture();
  const preload = path.join(f.root, 'unavailable.ts');
  const marker = path.join(f.root, 'effect');
  fs.writeFileSync(preload, `Object.defineProperty(process, 'platform', { value: 'win32' });`);
  const result = spawnSync(process.execPath, ['--preload', preload, CLI, 'capture', f.root, '001', '--timeout-ms', '1000', '--', process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected')`], { cwd: f.root, encoding: 'utf8', timeout: 10000 });
  expect(result.status).toBe(2);
  expect(fs.existsSync(marker)).toBe(false);
});

test.skipIf(process.platform !== 'win32')('abrupt Windows evidence-wrapper exit closes the inherited job', async () => {
  const f = fixture();
  const marker = path.join(f.root, 'native.pid');
  const child = spawn(process.execPath, [CLI, 'capture', f.root, '001', '--timeout-ms', '10000', '--', process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`], { cwd: f.root, stdio: 'ignore' });
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  let pid = 0;
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    for (let index = 0; index < 300 && !fs.existsSync(marker); index++) await Bun.sleep(10);
    expect(fs.existsSync(marker)).toBe(true);
    pid = Number(fs.readFileSync(marker, 'utf8'));
    child.kill('SIGKILL');
    await closed;
    for (let index = 0; index < 100 && alive(); index++) await Bun.sleep(20);
    expect(alive()).toBe(false);
  } finally { child.kill('SIGKILL'); if (pid && alive()) process.kill(pid, 'SIGKILL'); await closed; }
});

test('a later capture requires a checkpoint anchored on the latest complete capture, and materialize fills metadata, learning and report links', () => {
  const f = fixture();
  expect(f.capture('001', 'console.log(JSON.stringify({ step: 1 }))').status).toBe(0);
  const second = (id: string) => `bun gstack-qa-evidence capture ${f.root} ${id} --timeout-ms 4000 -- probe two`;
  const refused = f.capture('002', 'console.log(JSON.stringify({ step: 2 }))');
  expect(refused.status).toBe(2);
  expect(receipt(refused.stderr).message).toContain('Checkpoint required before capture 002');
  expect(fs.existsSync(path.join(f.root, '.qa-evidence/002'))).toBe(false);
  const first = `bun gstack-qa-evidence capture ${f.root} 001 --timeout-ms 4000 -- probe one`;
  expect(f.run('checkpoint', f.root, '001', '001', first, 'The first observation makes the second input the riskiest next probe.', second('002')).status).toBe(0);
  const allowed = f.capture('002', 'console.log(JSON.stringify({ step: 2 }))');
  expect(allowed.status, allowed.stderr).toBe(0);
  expect(receipt(allowed.stdout).next).toContain('anchored on capture 002');
  const firstRow = { capture: '001', command: first, contract: 'README.md', expected: 'step 1', classification: 'pass' };
  f.json('annotations.json', { revision: 'fixture-revision', limits: ['Only two probes ran.'], evidence: [firstRow] });
  const omitted = f.run('materialize', f.root, 'annotations.json');
  expect(omitted.status).toBe(2);
  expect(receipt(omitted.stderr).message).toContain('add an evidence row for capture 002');
  f.json('annotations.json', { revision: 'fixture-revision', limits: ['Only two probes ran.'], evidence: [firstRow, { capture: '002', command: second('002'), contract: 'README.md', expected: 'step 2', classification: 'pass' }] });
  const report = f.run('materialize', f.root, 'annotations.json');
  expect(report.status, report.stderr).toBe(0);
  expect(receipt(report.stdout).reportLinks).toEqual(['[checkpoint 001](exploration-001.json)']);
  const final = JSON.parse(fs.readFileSync(path.join(f.root, 'evidence.json'), 'utf8'));
  expect(final).toMatchObject({ runtime: `bun ${Bun.version}`, cwd: f.root });
  expect(final.learning).toEqual([{ observationCommand: first, hypothesis: 'The first observation makes the second input the riskiest next probe.', nextCommand: second('002') }]);
});

test('a merged capture publishes the causal note for the latest complete capture before running, and satisfies the guard by construction', () => {
  const f = fixture();
  const hypothesis = 'The first observation makes the second input the riskiest next probe.';
  const merged = (id: string, after: string, program: string, text = hypothesis) =>
    f.run('capture', f.root, id, '--timeout-ms', '4000', '--after', after, '--hypothesis', text, '--', process.execPath, '-e', program);
  const first = merged('001', '000', 'console.log(1)');
  expect(first.status).toBe(2);
  expect(receipt(first.stderr).message).toContain('The first capture takes no --after');
  expect(f.capture('001', 'console.log(JSON.stringify({ step: 1 }))').status).toBe(0);
  for (const [after, text, message] of [['002', hypothesis, '--after must name capture 001'], ['001', 'too short', 'Invalid --hypothesis']]) {
    const refused = merged('002', after, `require('node:fs').appendFileSync('effects', 'ran')`, text);
    expect(refused.status).toBe(2);
    expect(receipt(refused.stderr).message).toContain(message);
  }
  expect(fs.existsSync(path.join(f.root, 'effects'))).toBe(false);
  expect(fs.existsSync(path.join(f.root, 'exploration-002.json'))).toBe(false);
  expect(fs.existsSync(path.join(f.root, '.qa-evidence/002'))).toBe(false);
  const program = `const fs = require('node:fs'); console.log(JSON.stringify({ step: 2, noteBeforeRun: fs.existsSync('exploration-002.json') }))`;
  const second = merged('002', '001', program);
  expect(second.status, second.stderr).toBe(0);
  const captured = receipt(second.stdout);
  expect(captured).toMatchObject({ action: 'capture', status: 'complete', id: '002', checkpoint: '002', link: '[checkpoint 002](exploration-002.json)' });
  const noteBytes = fs.readFileSync(path.join(f.root, 'exploration-002.json'), 'utf8');
  expect(captured.checkpointSha256).toBe(createHash('sha256').update(noteBytes).digest('hex'));
  expect(JSON.parse(noteBytes)).toEqual({ observationCapture: '001', observationArgv: [process.execPath, '-e', 'console.log(JSON.stringify({ step: 1 }))'],
    observed: { step: 1 }, hypothesis, nextCapture: '002', nextArgv: [process.execPath, '-e', program] });
  expect(JSON.parse(fs.readFileSync(path.join(f.root, '.qa-evidence/002/stdout'), 'utf8'))).toEqual({ step: 2, noteBeforeRun: true });
  if (process.platform !== 'win32') expect(fs.statSync(path.join(f.root, 'exploration-002.json')).mode & 0o777).toBe(0o600);
  const stale = merged('003', '001', 'console.log(3)');
  expect(stale.status).toBe(2);
  expect(receipt(stale.stderr).message).toContain('--after must name capture 002');
  fs.writeFileSync(path.join(f.root, 'exploration-003.json'), '{}', { mode: 0o600 });
  const reused = merged('003', '002', `require('node:fs').appendFileSync('effects', 'ran')`);
  expect(reused.status).toBe(2);
  expect(receipt(reused.stderr).message).toContain('Checkpoint 003 already exists');
  expect(fs.existsSync(path.join(f.root, 'effects'))).toBe(false);
  const unguarded = f.capture('004', 'console.log(4)');
  expect(unguarded.status).toBe(2);
  expect(receipt(unguarded.stderr).message).toContain('--after 002 --hypothesis');
  const replay = merged('004', '002', program);
  expect(replay.status, replay.stderr).toBe(0);
  const rows = ['001', '002', '004'].map(capture => ({ capture, command: `capture ${capture}`, contract: 'README.md', expected: 'declared', classification: 'pass' }));
  f.json('annotations.json', { revision: 'fixture-revision', limits: ['Only three probes ran.'], evidence: rows });
  const report = f.run('materialize', f.root, 'annotations.json');
  expect(report.status, report.stderr).toBe(0);
  expect(receipt(report.stdout).reportLinks).toEqual(['[checkpoint 002](exploration-002.json)', '[checkpoint 003](exploration-003.json)', '[checkpoint 004](exploration-004.json)']);
  const learning = JSON.parse(fs.readFileSync(path.join(f.root, 'evidence.json'), 'utf8')).learning;
  expect(learning).toEqual([{ observationCapture: '001', observationArgv: [process.execPath, '-e', 'console.log(JSON.stringify({ step: 1 }))'], hypothesis, nextCapture: '002', nextArgv: [process.execPath, '-e', program] }]);
  f.json('annotations.json', { revision: 'fixture-revision', limits: ['Only three probes ran.'], evidence: rows, learning: ['004'] });
  fs.rmSync(path.join(f.root, 'evidence.json'));
  const sameProbe = f.run('materialize', f.root, 'annotations.json');
  expect(sameProbe.status).toBe(2);
  expect(receipt(sameProbe.stderr).message).toContain('checkpoint 004 replays the same probe');
});

test('a merged capture refuses to publish a note naming a credential, and the separate checkpoint form keeps satisfying the guard', () => {
  const f = fixture();
  expect(f.capture('001', 'console.log(JSON.stringify({ step: 1 }))').status).toBe(0);
  const secret = 'AKIA' + 'Q'.repeat(16);
  const leaked = f.run('capture', f.root, '002', '--timeout-ms', '4000', '--after', '001', '--hypothesis', `The key ${secret} should be rejected by the next request.`, '--', process.execPath, '-e', 'console.log(2)');
  expect(leaked.status).toBe(2);
  expect(receipt(leaked.stderr).message).toBe('Sensitive intent cannot be published');
  expect(fs.existsSync(path.join(f.root, 'exploration-002.json'))).toBe(false);
  expect(f.run('checkpoint', f.root, '009', '001', `bun Q capture R 001 --timeout-ms 4000 -- one`, 'The first observation makes the second input the riskiest next probe.', `bun Q capture R 002 --timeout-ms 4000 -- two`).status).toBe(0);
  const separate = f.capture('002', 'console.log(2)');
  expect(separate.status, separate.stderr).toBe(0);
  expect(receipt(separate.stdout).checkpoint).toBeUndefined();
});

test('materialize rejects placeholder metadata and same-probe learning with the fix in the message', () => {
  const f = fixture();
  expect(f.capture('001', 'console.log(JSON.stringify({ step: 1 }))').status).toBe(0);
  const command = (id: string) => `bun gstack-qa-evidence capture ${f.root} ${id} --timeout-ms 4000 -- probe same`;
  expect(f.run('checkpoint', f.root, '001', '001', command('001'), 'Replaying the identical probe checks whether the first result is deterministic.', command('002')).status).toBe(0);
  const row = { capture: '001', command: command('001'), contract: 'README.md', expected: 'step 1', classification: 'pass' };
  f.json('annotations.json', { revision: 'fixture-revision', runtime: 'bun', limits: ['One probe.'], evidence: [row] });
  const placeholder = f.run('materialize', f.root, 'annotations.json');
  expect(placeholder.status).toBe(2);
  expect(receipt(placeholder.stderr).message).toContain(`runtime must be "bun ${Bun.version}"`);
  f.json('annotations.json', { revision: 'fixture-revision', limits: ['One probe.'], evidence: [row], learning: ['001'] });
  const replay = f.run('materialize', f.root, 'annotations.json');
  expect(replay.status).toBe(2);
  expect(receipt(replay.stderr).message).toContain('checkpoint 001 replays the same probe');
  f.json('annotations.json', { revision: 'fixture-revision', limits: ['One probe.'], evidence: [row] });
  const selected = f.run('materialize', f.root, 'annotations.json');
  expect(selected.status, selected.stderr).toBe(0);
  expect(JSON.parse(fs.readFileSync(path.join(f.root, 'evidence.json'), 'utf8')).learning).toEqual([]);
});

test('both QA helpers answer --help with usage and exit 0, and the declared interfaces allow it', () => {
  for (const [cli, needle] of [[CLI, 'materialize ROOT ANNOTATIONS'], [path.resolve(import.meta.dir, '../bin/gstack-qa-deadline'), 'status FILE']] as const) {
    const result = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8', timeout: 10_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(needle);
  }
  expect(qaCommandAllowed('bun bin/gstack-qa-evidence --help')).toBe(true);
  expect(qaCommandAllowed('bun /abs/runtime/bin/gstack-qa-deadline --help')).toBe(true);
  expect(qaCommandAllowed('bun bin/gstack-qa-evidence --help; rm -rf x')).toBe(false);
  expect(qaCommandAllowed('bun bin/gstack-qa-evidence --version')).toBe(false);
  expect(qaCallerCommandAllowed('bun /abs/host/runtime/bin/gstack-qa-evidence --help')).toBe(true);
});

test('materialize refuses evidence whose declared input snapshot predates the latest capture', () => {
  const f = fixture();
  const command = (id: string, input: string) => `bun gstack-qa-evidence capture ${f.root} ${id} --timeout-ms 4000 -- probe ${input}`;
  expect(f.capture('001', `console.log(JSON.stringify({ snapshot: 'before', charter: 'adverse' }))`).status).toBe(0);
  expect(f.run('checkpoint', f.root, '001', '001', command('001', 'adverse'), 'The input changed, so the happy path must be rechecked on current inputs next.', command('002', 'happy')).status).toBe(0);
  expect(f.capture('002', `console.log(JSON.stringify({ snapshot: 'after', charter: 'happy' }))`).status).toBe(0);
  const rows = [
    { capture: '001', command: command('001', 'adverse'), contract: 'README.md', expected: 'rejects', classification: 'pass' },
    { capture: '002', command: command('002', 'happy'), contract: 'README.md', expected: 'doubles', classification: 'pass' },
  ];
  f.json('annotations.json', { revision: 'fixture-revision', limits: ['Adverse coverage predates the input change.'], evidence: rows });
  const stale = f.run('materialize', f.root, 'annotations.json');
  expect(stale.status).toBe(2);
  expect(receipt(stale.stderr).message).toContain('capture 001 observed an older input snapshot than the latest capture 002');
  f.json('annotations.json', { revision: 'fixture-revision', limits: ['Adverse coverage predates the input change.'], evidence: [{ ...rows[0], classification: 'superseded' }, rows[1]] });
  const materialized = f.run('materialize', f.root, 'annotations.json');
  expect(materialized.status).toBe(0);
  expect(receipt(materialized.stdout).verdict).toEqual({ status: 'inconclusive', open: ['capture 001 superseded'] });
  expect(JSON.parse(fs.readFileSync(path.join(f.root, 'evidence.json'), 'utf8')).verdict.status).toBe('inconclusive');
});

test('a superseded row closes only when the same native probe was rerun on the current input snapshot', () => {
  const f = fixture();
  const hypothesis = 'The input snapshot changed, so the earlier probe must be rerun on current inputs next.';
  const program = (charter: string) => `console.log(JSON.stringify({ snapshot: require('node:fs').readFileSync('snap', 'utf8'), charter: '${charter}' }))`;
  const probe = (id: string, after: string, charter: string) => f.run('capture', f.root, id, '--timeout-ms', '4000', '--after', after, '--hypothesis', hypothesis, '--', process.execPath, '-e', program(charter));
  const row = (capture: string, classification: string) => ({ capture, command: `capture ${capture}`, contract: 'README.md', expected: 'declared', classification });
  const materialize = (...rows: ReturnType<typeof row>[]) => {
    fs.rmSync(path.join(f.root, 'evidence.json'), { force: true });
    f.json('annotations.json', { revision: 'fixture-revision', limits: ['Snapshot changed mid-run.'], evidence: rows });
    const result = f.run('materialize', f.root, 'annotations.json');
    expect(result.status, result.stderr).toBe(0);
    return receipt(result.stdout).verdict;
  };
  fs.writeFileSync(path.join(f.root, 'snap'), 'before');
  expect(f.capture('001', program('happy')).status).toBe(0);
  fs.writeFileSync(path.join(f.root, 'snap'), 'after');
  expect(probe('002', '001', 'adverse').status).toBe(0);
  expect(materialize(row('001', 'superseded'), row('002', 'pass'))).toEqual({ status: 'inconclusive', open: ['capture 001 superseded'] });
  const again = f.run('materialize', f.root, 'annotations.json');
  expect(again.status).toBe(2);
  expect(receipt(again.stderr).message).toContain('evidence.json is already published');
  expect(probe('003', '002', 'happy').status).toBe(0);
  expect(materialize(row('001', 'superseded'), row('002', 'pass'), row('003', 'superseded'))).toEqual({ status: 'inconclusive', open: ['capture 001 superseded', 'capture 003 superseded'] });
  expect(materialize(row('001', 'superseded'), row('002', 'pass'), row('003', 'pass'))).toEqual({ status: 'pass', open: [] });
});

test('every capture after an input change names the commands still to rerun, until each has run on current inputs', () => {
  // gate-census-6 of run 37158847998: the fixture locale changed after captures 001 and 002; the agent reran
  // only input 9, materialized once with capture 001 still open, and the published verdict stayed inconclusive.
  const f = fixture();
  const hypothesis = 'The input snapshot changed, so the earlier probes must be rerun on current inputs next.';
  const program = (input: string) => `console.log(JSON.stringify({ snapshot: require('node:fs').readFileSync('snap', 'utf8'), input: '${input}' }))`;
  const probe = (id: string, after: string, input: string) => receipt(f.run('capture', f.root, id, '--timeout-ms', '4000', '--after', after, '--hypothesis', hypothesis, '--', process.execPath, '-e', program(input)).stdout);
  const command = (input: string) => [process.execPath, '-e', program(input)].join(' ');
  fs.writeFileSync(path.join(f.root, 'snap'), 'C');
  expect(receipt(f.capture('001', program('3')).stdout).revalidate).toBeUndefined();
  expect(probe('002', '001', '9').revalidate).toBeUndefined();
  fs.writeFileSync(path.join(f.root, 'snap'), 'POSIX');
  const changed = probe('003', '002', '10');
  expect(changed.revalidate).toEqual([command('3'), command('9')]);
  expect(changed.next).toContain('materialize runs once and keeps each one open (the verdict cannot pass) until it is rerun on current inputs');
  expect(probe('004', '003', '9').revalidate).toEqual([command('3')]);
  const current = probe('005', '004', '3');
  expect(current.revalidate).toBeUndefined();
  expect(current.next).not.toContain('Inputs changed');
  const row = (capture: string, classification: string) => ({ capture, command: `capture ${capture}`, contract: 'README.md', expected: 'declared', classification });
  f.json('annotations.json', { revision: 'fixture-revision', limits: ['Locale changed after capture 002.'],
    evidence: [row('001', 'superseded'), row('002', 'superseded'), row('003', 'pass'), row('004', 'pass'), row('005', 'pass')] });
  const materialized = f.run('materialize', f.root, 'annotations.json');
  expect(materialized.status, materialized.stderr).toBe(0);
  expect(receipt(materialized.stdout).verdict).toEqual({ status: 'pass', open: [] });
  expect(receipt(materialized.stdout).next).toContain('this verdict is final for this report root');
});

test('a descriptive classification is rejected before publication, so the corrected label can still materialize', () => {
  // gate-census-6 of run 36920606897: "pass (current snapshot)" left the one-shot verdict inconclusive.
  const f = fixture();
  expect(f.capture('001', 'console.log(JSON.stringify({ step: 1 }))').status).toBe(0);
  const row = (classification: string) => ({ capture: '001', command: 'capture 001', contract: 'README.md', expected: 'declared', classification });
  f.json('annotations.json', { revision: 'fixture-revision', limits: ['One probe ran.'], evidence: [row('pass (current snapshot)')] });
  const rejected = f.run('materialize', f.root, 'annotations.json');
  expect(rejected.status).toBe(2);
  expect(receipt(rejected.stderr).message).toContain('classification must be one of pass, superseded');
  expect(fs.existsSync(path.join(f.root, 'evidence.json'))).toBe(false);
  f.json('annotations.json', { revision: 'fixture-revision', limits: ['One probe ran.'], evidence: [row('pass')] });
  const accepted = f.run('materialize', f.root, 'annotations.json');
  expect(accepted.status, accepted.stderr).toBe(0);
  expect(receipt(accepted.stdout).verdict).toEqual({ status: 'pass', open: [] });
});

test('captures list declared-but-unrun required probes without judging them', () => {
  const f = fixture();
  const required = [`${process.execPath} -e console.log(JSON.stringify({step:1}))`, 'bun run probe -- reject'];
  const result = spawnSync(process.execPath, [CLI, 'capture', f.root, '001', '--timeout-ms', '4000', '--', process.execPath, '-e', 'console.log(JSON.stringify({step:1}))'],
    { cwd: f.root, encoding: 'utf8', timeout: 10_000, env: { ...process.env, GSTACK_QA_REQUIRED_PROBES: JSON.stringify(required) } });
  expect(result.status, result.stderr).toBe(0);
  expect(receipt(result.stdout).requiredRemaining).toEqual(['bun run probe -- reject']);
});

test('materialize accepts a single limits string as a one-item list', () => {
  const f = fixture();
  expect(f.capture('001', 'console.log(JSON.stringify({ step: 1 }))').status).toBe(0);
  f.json('annotations.json', { revision: 'fixture-revision', limits: 'One probe only.', evidence: [{ capture: '001', command: 'probe', contract: 'README.md', expected: 'step 1', classification: 'pass' }] });
  const report = f.run('materialize', f.root, 'annotations.json');
  expect(report.status, report.stderr).toBe(0);
  expect(JSON.parse(fs.readFileSync(path.join(f.root, 'evidence.json'), 'utf8')).limits).toEqual(['One probe only.']);
});
