/**
 * Direct pins for runShardChild (scripts/test-strict-output.ts) — the shared
 * spawn/detached/group-kill/wall-timer/reap lifecycle extracted from the paid
 * runner's runPaidShard, designed for scripts/test-free-shards.ts to migrate
 * onto next. test/paid-shards.test.ts pins the paid runner end-to-end; these
 * pin the helper's own contract so the free-runner migration has a floor.
 */

import { describe, test, expect } from 'bun:test';
import * as os from 'os';
import * as path from 'path';
import type { ChildProcess } from 'child_process';
import { runShardChild } from '../scripts/test-strict-output';

/** Collect the child's full stdout+stderr, resolving only when drained. */
function collectingHook(chunks: string[]) {
  return (child: ChildProcess): Array<Promise<void>> => {
    const consume = (stream: NodeJS.ReadableStream | null): Promise<void> =>
      stream
        ? new Promise((resolve, reject) => {
            stream.on('data', (chunk: Buffer | string) => chunks.push(chunk.toString()));
            stream.on('end', resolve);
            stream.on('error', reject);
          })
        : Promise.resolve();
    return [consume(child.stdout), consume(child.stderr)];
  };
}

describe('runShardChild', () => {
  test('clean exit: exitCode 0, not timed out, output drained before resolve', async () => {
    const chunks: string[] = [];
    const result = await runShardChild({
      command: process.execPath,
      args: ['-e', 'console.log("hello-from-child")'],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 30_000,
      hookStreams: collectingHook(chunks),
    });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.groupPid).toBeGreaterThan(0);
    // The hookStreams promises are awaited AFTER close — trailing output is
    // fully drained before callers read their classifier/log state.
    expect(chunks.join('')).toContain('hello-from-child');
  }, 30_000);

  test('non-zero exit code propagates untouched', async () => {
    const result = await runShardChild({
      command: process.execPath,
      args: ['-e', 'process.exit(7)'],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 30_000,
      hookStreams: () => [],
    });
    expect(result.exitCode).toBe(7);
    expect(result.timedOut).toBe(false);
  }, 30_000);

  test('a spinning child is group-SIGKILLed at the wall deadline and reported timedOut', async () => {
    const startedAt = Date.now();
    const result = await runShardChild({
      command: process.execPath,
      // A real busy loop: an in-process timer could never fire in this child.
      args: ['-e', 'const end = Date.now() + 600000; while (Date.now() < end) {}'],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 1_200,
      hookStreams: () => [],
    });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(30_000);
    if (process.platform !== 'win32') {
      // The whole group is gone, not left to burn a core.
      expect(() => process.kill(result.groupPid as number, 0)).toThrow();
    }
  }, 30_000);

  test('a spawn failure THROWS so callers keep their could-not-run handling', async () => {
    await expect(runShardChild({
      command: path.join(os.tmpdir(), 'definitely-not-a-real-binary-8b1f'),
      args: [],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 5_000,
      hookStreams: () => [],
    })).rejects.toThrow();
  }, 30_000);
});
