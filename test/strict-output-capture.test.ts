import { test, expect } from 'bun:test';
import { PassThrough } from 'node:stream';
import { forwardAndClassify, BunTestOutputClassifier, runShardChild, strictTestExitCode } from '../scripts/test-strict-output';
const sink = (chunks: string[]) => ({ write: (chunk: Buffer|string) => { chunks.push(chunk.toString()); return true; } }) as unknown as NodeJS.WriteStream;
const observe = async (promise: Promise<unknown>) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(value => ({ state: 'resolved' as const, value }), error => ({ state: 'rejected' as const, error })),
      new Promise<{ state: 'pending' }>(resolve => { timer = setTimeout(() => resolve({ state: 'pending' }), 2000); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
};

test('normal end keeps every byte and the strict terminal verdict', async () => {
  const stream = new PassThrough(); const chunks: string[] = []; const classifier = new BunTestOutputClassifier();
  const pending = forwardAndClassify(stream, sink(chunks), classifier, 'stdout');
  stream.end('payload\nRan 1 tests across 1 files. [1ms]\n');
  await pending;
  expect(chunks.join('')).toBe('payload\nRan 1 tests across 1 files. [1ms]\n');
  expect(strictTestExitCode(0, classifier.end(), 1)).toBe(0);
});

test('close without end rejects capture even after a success-shaped summary', async () => {
  const stream = new PassThrough(); const chunks: string[] = []; const classifier = new BunTestOutputClassifier();
  const pending = observe(forwardAndClassify(stream, sink(chunks), classifier, 'stdout'));
  stream.write('retained partial\nRan 1 tests across 1 files. [1ms]\n'); stream.destroy();
  const result = await pending;
  expect(result.state).toBe('rejected');
  if (result.state === 'rejected') expect((result.error as Error).message).toContain('incomplete stdout capture');
  expect(chunks.join('')).toContain('retained partial');
});

test('an already destroyed stream rejects without waiting for another close event', async () => {
  const stream = new PassThrough(); stream.destroy(); await Bun.sleep(0);
  const result = await observe(forwardAndClassify(stream, sink([]), new BunTestOutputClassifier(), 'stderr'));
  expect(result.state).toBe('rejected');
  if (result.state === 'rejected') expect((result.error as Error).message).toContain('incomplete stderr capture');
});

test('a stream error keeps its original identity through later close', async () => {
  const stream = new PassThrough(); const cause = new Error('owned original stream failure');
  const pending = observe(forwardAndClassify(stream, sink([]), new BunTestOutputClassifier(), 'stdout'));
  stream.destroy(cause);
  const result = await pending;
  expect(result.state).toBe('rejected');
  if (result.state === 'rejected') expect(result.error).toBe(cause);
  // Keep observing late errors, preserving the already selected first cause.
  expect(() => stream.emit('error', new Error('owned later stream failure'))).not.toThrow();
});

test('real child exit plus incomplete stdout rejects and reaches the finally reap', async () => {
  let pid: number | undefined; let childClosed = false;
  const pending = runShardChild({ command: process.execPath, args: ['-e', ''], cwd: process.cwd(), env: { ...process.env, EVALS: '' }, timeoutMs: 100,
    hookStreams: child => {
      pid = child.pid; child.once('close', () => { childClosed = true; });
      child.stdout!.destroy();
      return [forwardAndClassify(child.stdout!, sink([]), new BunTestOutputClassifier(), 'stdout'), forwardAndClassify(child.stderr!, sink([]), new BunTestOutputClassifier(), 'stderr')];
    },
  });
  const result = await observe(pending);
  expect(childClosed).toBe(true);
  expect(result.state).toBe('rejected');
  if (result.state === 'rejected') expect((result.error as Error).message).toContain('incomplete stdout capture');
  if (process.platform !== 'win32') expect(() => process.kill(pid!, 0)).toThrow();
});


test('an early capture rejection is observed immediately but rethrown only after child close', async () => {
  const cause = new Error('owned early capture failure'); let closed = false;
  const seen: unknown[] = []; const unhandled = (error: unknown) => { seen.push(error); };
  process.on('unhandledRejection', unhandled);
  try {
    const pending = runShardChild({ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 50)'], cwd: process.cwd(), env: { ...process.env, EVALS: '' }, timeoutMs: 1000,
      hookStreams: child => {
        child.once('close', () => { closed = true; });
        child.stdout!.resume(); child.stderr!.resume();
        return [Promise.reject(cause)];
      },
    });
    const result = await observe(pending);
    expect(closed).toBe(true);
    expect(result.state).toBe('rejected');
    if (result.state === 'rejected') expect(result.error).toBe(cause);
    expect(seen).toEqual([]);
  } finally { process.off('unhandledRejection', unhandled); }
});
