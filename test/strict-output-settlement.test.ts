import { expect, test } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BunTestOutputClassifier, forwardAndClassify, runShardChild, strictTestExitCode } from '../scripts/test-strict-output';

const passingOutput = 'retained prefix\n 1 pass\n 0 fail\nRan 1 tests across 1 files. [1ms]\n';
const options = {
  command: process.execPath,
  args: ['-e', `process.stdout.write(${JSON.stringify(passingOutput)})`],
  cwd: process.cwd(),
  env: { ...process.env, EVALS: '' },
  timeoutMs: 150,
};

function capture(child: ChildProcess, chunks: Buffer[], classifier: BunTestOutputClassifier) {
  const sink = { write: (chunk: Buffer | string) => { chunks.push(Buffer.from(chunk)); return true; } } as NodeJS.WriteStream;
  return [
    forwardAndClassify(child.stdout!, sink, classifier, 'stdout'),
    forwardAndClassify(child.stderr!, sink, classifier, 'stderr'),
  ];
}

async function expectStopped(pid: number) {
  const alive = () => {
    try {
      process.kill(pid, 0);
      if (process.platform === 'linux' && readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].startsWith('Z')) return false;
      return true;
    } catch (error) {
      if (['ESRCH', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
      throw error;
    }
  };
  const deadline = Date.now() + 1000;
  while (alive() && Date.now() < deadline) await Bun.sleep(10);
  expect(alive()).toBe(false);
}

test('closed child with a stalled registered drain fails within the settlement bound', async () => {
  const chunks: Buffer[] = [];
  const classifier = new BunTestOutputClassifier();
  let release!: () => void;
  let closed = false;
  const started = Date.now();
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const pending = runShardChild({ ...options, hookStreams: child => {
      child.once('close', () => { closed = true; });
      return [...capture(child, chunks, classifier), new Promise<void>(resolve => { release = resolve; })];
    } });
    const result = await Promise.race([
      pending.then(value => ({ state: 'resolved', value }), error => ({ state: 'rejected', error })),
      new Promise<{ state: string }>(resolve => { watchdog = setTimeout(() => resolve({ state: 'pending' }), 800); }),
    ]);
    expect(closed).toBe(true);
    expect(Buffer.concat(chunks).toString()).toBe(passingOutput);
    expect(result.state).toBe('resolved');
    if ('value' in result) {
      expect(result.value.timedOut).toBe(true);
      expect(result.value.exitCode).toBe(0);
      expect(result.value.incompleteCapture?.childClosed).toBe(true);
      expect(result.value.incompleteCapture?.pendingStreams).toBe(1);
    }
    expect(Date.now() - started).toBeLessThan(700);
    const exitCode = 'value' in result && !result.value.timedOut ? result.value.exitCode ?? 1 : 1;
    expect(strictTestExitCode(exitCode, classifier.end(), 1)).toBe(1);
  } finally {
    clearTimeout(watchdog);
    release();
  }
}, 30_000);

test('a missing child close cannot bypass wall kill or bounded cleanup', async () => {
  let child!: ChildProcess;
  const chunks: Buffer[] = [];
  const classifier = new BunTestOutputClassifier();
  const signals = ['SIGINT', 'SIGTERM', 'exit'] as const;
  const counts = signals.map(signal => process.listenerCount(signal));
  const started = Date.now();
  try {
    const result = await runShardChild({ ...options,
      args: ['-e', `process.stdout.write(${JSON.stringify(passingOutput)}); setInterval(() => {}, 1000)`],
      hookStreams: processChild => {
        child = processChild;
        const emit = child.emit.bind(child);
        child.emit = ((event: string | symbol, ...args: unknown[]) => event === 'close' ? true : emit(event, ...args)) as typeof child.emit;
        return capture(child, chunks, classifier);
      },
    });
    expect(result.timedOut).toBe(true);
    expect(result.incompleteCapture?.childClosed).toBe(false);
    expect(Date.now() - started).toBeLessThan(700);
    expect(Buffer.concat(chunks).toString()).toBe(passingOutput);
    await expectStopped(child.pid!);
    expect(signals.map(signal => process.listenerCount(signal))).toEqual(counts);
  } finally { child?.kill('SIGKILL'); }
}, 30_000);

test('normal exit drains a late registered promise and preserves the exit code', async () => {
  const chunks: Buffer[] = [];
  const classifier = new BunTestOutputClassifier();
  let drained = false;
  const result = await runShardChild({ ...options, timeoutMs: 1000,
    args: ['-e', `process.stdout.write(${JSON.stringify(passingOutput)}); process.exitCode = 7`],
    hookStreams: child => [...capture(child, chunks, classifier), new Promise<void>(resolve => {
      child.once('close', () => setTimeout(() => { drained = true; resolve(); }, 20));
    })],
  });
  expect(result.exitCode).toBe(7);
  expect(result.timedOut).toBe(false);
  expect(drained).toBe(true);
  expect(Buffer.concat(chunks).toString()).toBe(passingOutput);
  expect(strictTestExitCode(result.exitCode!, classifier.end(), 1)).toBe(7);
}, 30_000);

test('a stream rejection retains its original identity when another drain stalls', async () => {
  const cause = new Error('original capture failure');
  let release!: () => void;
  const started = Date.now();
  try {
    await expect(runShardChild({ ...options, hookStreams: child => {
      child.stdout!.resume(); child.stderr!.resume();
      return [Promise.reject(cause), new Promise<void>(resolve => { release = resolve; })];
    } })).rejects.toBe(cause);
    expect(Date.now() - started).toBeLessThan(700);
  } finally { release(); }
}, 30_000);

test.skipIf(process.platform === 'win32')('a surviving grandchild is actually stopped after controller cleanup', async () => {
  const chunks: Buffer[] = [];
  const classifier = new BunTestOutputClassifier();
  let child!: ChildProcess;
  let grandchildPid = 0;
  try {
    const result = await runShardChild({ ...options, timeoutMs: 1000,
      args: ['-e', `const { spawn } = require('node:child_process'); const p = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); console.log(p.pid); p.unref();`],
      hookStreams: processChild => { child = processChild; return capture(child, chunks, classifier); },
    });
    grandchildPid = Number(Buffer.concat(chunks).toString().trim());
    expect(grandchildPid).toBeGreaterThan(0);
    expect(result.timedOut).toBe(false);
    await expectStopped(grandchildPid);
    await expectStopped(child.pid!);
    expect(strictTestExitCode(result.exitCode ?? 1, classifier.end(), 1)).toBe(1);
  } finally {
    child?.kill('SIGKILL');
    if (grandchildPid) try { process.kill(grandchildPid, 'SIGKILL'); } catch {}
  }
}, 30_000);

test('the owner absolute deadline shortens settlement but cannot extend the wall', async () => {
  for (const ownerRemainingMs of [90, 10_000]) {
    const started = Date.now();
    let release!: () => void;
    try {
      const result = await runShardChild({ ...options, timeoutMs: 180, deadlineMs: started + ownerRemainingMs,
        hookStreams: child => {
          child.stdout!.resume(); child.stderr!.resume();
          return [new Promise<void>(resolve => { release = resolve; })];
        },
      });
      expect(result.timedOut).toBe(true);
      expect(result.incompleteCapture?.deadlineMs).toBeLessThanOrEqual(started + Math.min(ownerRemainingMs, 180) + 5);
      expect(Date.now() - started).toBeLessThan(Math.min(ownerRemainingMs, 180) + 250);
    } finally { release(); }
  }
}, 30_000);

test('an exhausted owner deadline never launches another child', async () => {
  let hooked = false;
  const result = await runShardChild({ ...options, deadlineMs: Date.now() - 1,
    hookStreams: () => { hooked = true; return []; },
  });
  expect(hooked).toBe(false);
  expect(result).toMatchObject({ exitCode: null, timedOut: true, groupPid: null, incompleteCapture: { childClosed: false } });
}, 30_000);

// The exit must land before the wall for its code to survive. In Windows Free Tests 41164892775 the child took over
// 150 ms to start and exit, so the wall won (exitCode null). The same child exits in 45-102 ms across 39 lane runs of the
// normal-exit case and in up to 371 ms on a CPU-saturated runner (GSTA-199 scratch run 41205291567). This case asserts no
// elapsed bound, so its wall only has to come after the exit.
test('missing close preserves a nonzero exit while explicitly refusing completeness', async () => {
  const result = await runShardChild({ ...options, timeoutMs: 2_000, args: ['-e', 'process.exit(7)'],
    hookStreams: child => {
      const emit = child.emit.bind(child);
      child.emit = ((event: string | symbol, ...args: unknown[]) => event === 'close' ? true : emit(event, ...args)) as typeof child.emit;
      child.stdout!.resume(); child.stderr!.resume();
      return [];
    },
  });
  expect(result).toMatchObject({ exitCode: 7, timedOut: true, incompleteCapture: { childClosed: false, pendingStreams: 0 } });
  expect(strictTestExitCode(result.exitCode!, new BunTestOutputClassifier().end(), 1)).toBe(7);
}, 30_000);

test.skipIf(process.platform === 'win32')('a grandchild holding the output pipe cannot stall wall settlement', async () => {
  const chunks: Buffer[] = [];
  let grandchildPid = 0;
  let child!: ChildProcess;
  const started = Date.now();
  try {
    const result = await runShardChild({ ...options,
      args: ['-e', `const { spawn } = require('node:child_process'); const p = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' }); console.log(p.pid); p.unref();`],
      hookStreams: processChild => { child = processChild; return capture(child, chunks, new BunTestOutputClassifier()); },
    });
    expect(result.timedOut).toBe(true);
    expect(result.incompleteCapture).toBeDefined();
    expect(Date.now() - started).toBeLessThan(700);
    grandchildPid = Number(Buffer.concat(chunks).toString().trim());
    expect(grandchildPid).toBeGreaterThan(0);
    await expectStopped(grandchildPid);
    await expectStopped(child.pid!);
  } finally {
    child?.kill('SIGKILL');
    if (grandchildPid) try { process.kill(grandchildPid, 'SIGKILL'); } catch {}
  }
}, 30_000);

test('a timed-out registered spool retains the complete byte prefix, never a passing shard', async () => {
  const root = mkdtempSync(join(tmpdir(), 'strict-prefix-'));
  const spool = join(root, 'shard.log');
  const source = join(root, 'payload.ts');
  const fd = openSync(spool, 'wx', 0o600);
  const payload = 'évidence '.repeat(8192) + '\n' + passingOutput;
  const classifier = new BunTestOutputClassifier();
  let release: (() => void) | undefined;
  try {
    writeFileSync(source, `process.stdout.write(${JSON.stringify(payload)})`);
    const result = await runShardChild({ ...options, timeoutMs: 3000,
      args: [source],
      hookStreams: child => {
        const sink = { write: (chunk: Buffer | string) => { writeSync(fd, Buffer.from(chunk)); return true; } } as NodeJS.WriteStream;
        return [
          forwardAndClassify(child.stdout!, sink, classifier, 'stdout'),
          forwardAndClassify(child.stderr!, sink, classifier, 'stderr'),
          new Promise<void>(resolve => { release = resolve; }),
        ];
      },
    });
    expect(readFileSync(spool).equals(Buffer.from(payload))).toBe(true);
    expect(result).toMatchObject({ exitCode: 0, timedOut: true, incompleteCapture: { childClosed: true, pendingStreams: 1, failedStreams: 0 } });
    const summary = classifier.end();
    expect(strictTestExitCode(0, summary, 1)).toBe(0);
    expect(result.timedOut ? 'timed-out' : strictTestExitCode(result.exitCode ?? 1, summary, 1) === 0 ? 'passed' : 'failed').toBe('timed-out');
  } finally { release?.(); closeSync(fd); rmSync(root, { recursive: true, force: true }); }
}, 30_000);

test('spawn errors preserve their identity and metadata even when output never settles', async () => {
  let release!: () => void;
  let originalError: Error | undefined;
  let error: unknown;
  const started = Date.now();
  try {
    await runShardChild({ ...options, command: join(tmpdir(), 'strict-missing-command-c6ef6'), args: [],
      hookStreams: child => {
        child.on('error', cause => { originalError = cause; });
        return [new Promise<void>(resolve => { release = resolve; })];
      },
    });
  } catch (cause) { error = cause; }
  finally { release(); }
  expect(originalError).toBeDefined();
  expect(error).toBe(originalError);
  expect((error as Error & { shardResult: unknown }).shardResult).toMatchObject({ timedOut: true, incompleteCapture: { pendingStreams: 1 } });
  expect(Date.now() - started).toBeLessThan(700);
}, 30_000);

test('a rejected stream stays failed after a passing footer and reports incomplete capture', async () => {
  const cause = new Error('footer cannot erase capture failure');
  const chunks: Buffer[] = [];
  const classifier = new BunTestOutputClassifier();
  let error: unknown;
  try {
    await runShardChild({ ...options, hookStreams: child => [...capture(child, chunks, classifier), Promise.reject(cause)] });
  } catch (failure) { error = failure; }
  expect(error).toBe(cause);
  expect(Buffer.concat(chunks).toString()).toBe(passingOutput);
  expect((error as Error & { shardResult: unknown }).shardResult).toMatchObject({ exitCode: 0, timedOut: false, incompleteCapture: { failedStreams: 1 } });
  expect(strictTestExitCode(0, classifier.end(), 1)).toBe(0);
}, 30_000);

test('hook exceptions still reap the owned child and remove signal forwarding', async () => {
  const cause = new Error('original hook failure');
  let child!: ChildProcess;
  const counts = ['SIGINT', 'SIGTERM', 'exit'].map(signal => process.listenerCount(signal));
  await expect(runShardChild({ ...options,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    hookStreams: processChild => { child = processChild; throw cause; },
  })).rejects.toBe(cause);
  await expectStopped(child.pid!);
  expect(['SIGINT', 'SIGTERM', 'exit'].map(signal => process.listenerCount(signal))).toEqual(counts);
}, 30_000);
