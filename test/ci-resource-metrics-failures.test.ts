import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const roots: string[] = [];
const script = join(import.meta.dir, '../scripts/ci-resource-metrics.ts');

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe.skipIf(process.platform !== 'linux')('resource sampling cannot replace test execution', () => {
  for (const phase of ['final-sampling', 'publication']) {
    for (const signal of [null, 'SIGTERM', 'SIGHUP', 'SIGINT'] as const) {
      test(`${phase} retains the child outcome through ${signal ?? 'no signal'}`, async () => {
        const root = await mkdtemp(join(tmpdir(), 'ci-metrics-final-'));
        roots.push(root);
        const output = join(root, 'metrics.json');
        const ready = join(root, 'ready');
        const signals = join(root, 'signals');
        const preload = join(root, 'preload.ts');
        await writeFile(preload, `import { mock } from 'bun:test';
          import * as fs from 'node:fs/promises';
          import { appendFileSync } from 'node:fs';
          const original = { ...fs };
          const kill = process.kill.bind(process);
          process.kill = ((pid, signal) => {
            if (pid < 0 && signal !== 0) appendFileSync(${JSON.stringify(signals)}, String(signal) + '\\n');
            return kill(pid, signal);
          });
          let delayed = false;
          const pause = async () => {
            if (delayed) return;
            delayed = true;
            await original.writeFile(${JSON.stringify(ready)}, 'ready');
            await Bun.sleep(350);
          };
          if (${phase === 'publication'}) {
            mock.module('node:fs/promises', () => ({ ...original, writeFile: async (...args) => {
              if (args[0] === ${JSON.stringify(output)}) await pause();
              return original.writeFile(...args);
            } }));
          } else {
            const file = Bun.file.bind(Bun);
            let reads = 0;
            Bun.file = ((target, ...args) => {
              const result = file(target, ...args);
              if (String(target) !== '/proc/stat') return result;
              return new Proxy(result, { get(object, key) {
                if (key === 'text') return async () => {
                  if (++reads === 2) await pause();
                  return object.text();
                };
                const value = Reflect.get(object, key);
                return typeof value === 'function' ? value.bind(object) : value;
              } });
            });
          }`);
        const child = Bun.spawn([process.execPath, '--preload', preload, script,
          '--output', output, '--label', 'late-cancel', '--', '/usr/bin/true'],
        { stdout: 'pipe', stderr: 'pipe' });
        try {
          const deadline = performance.now() + 2_000;
          while (!await Bun.file(ready).exists() && performance.now() < deadline) await Bun.sleep(10);
          expect(await readFile(ready, 'utf8')).toBe('ready');
          if (signal) child.kill(signal);
          const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
          expect(status, stderr).toBe(signal === 'SIGTERM' ? 143 : signal === 'SIGHUP' ? 129 : signal === 'SIGINT' ? 130 : 0);
          const metrics = JSON.parse(await readFile(output, 'utf8'));
          expect(metrics.child).toEqual({ exitCode: 0, signal: null });
          expect(metrics.wrapper).toEqual({ exitCode: status });
          expect(metrics.cancellation).toEqual(signal ? { requestedSignal: signal } : undefined);
          expect(await Bun.file(signals).exists() ? await readFile(signals, 'utf8') : '').not.toContain('SIGKILL');
        } finally {
          child.kill('SIGTERM');
          await child.exited;
        }
      }, 10_000);
    }
  }

  for (const failure of ['sampling', 'inspection']) {
    test(`cancellation remains supervised after ${failure} failure`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'ci-metrics-cancel-'));
      roots.push(root);
      const output = join(root, 'metrics.json');
      const ready = join(root, 'ready');
      const preload = join(root, 'preload.ts');
      await writeFile(preload, failure === 'sampling'
        ? `const file = Bun.file.bind(Bun);
          Bun.file = ((target, ...args) => String(target) === '/proc/stat'
            ? { text: async () => { throw new Error('private sample diagnostic'); } }
            : file(target, ...args));`
        : `const kill = process.kill.bind(process);
          process.kill = ((pid, signal) => {
            if (pid < 0 && signal === 0) throw Object.assign(new Error('private inspection diagnostic'), { code: 'EPERM' });
            return kill(pid, signal);
          });`);
      const child = Bun.spawn([process.execPath, '--preload', preload, script,
        '--output', output, '--label', 'cancel-failure', '--', '/bin/sh', '-c',
        'trap "exit 0" TERM; printf ready > "$1"; while :; do sleep 0.02; done', 'child', ready],
      { stdout: 'pipe', stderr: 'pipe' });
      try {
        const deadline = performance.now() + 2_000;
        while (!await Bun.file(ready).exists() && performance.now() < deadline) await Bun.sleep(10);
        expect(await readFile(ready, 'utf8')).toBe('ready');
        child.kill('SIGTERM');
        const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
        expect(status, stderr).toBe(failure === 'sampling' ? 143 : 1);
        const raw = await readFile(output, 'utf8');
        const metrics = JSON.parse(raw);
        expect(metrics.child.exitCode).toBe(0);
        expect(metrics.wrapper.exitCode).toBe(status);
        expect(metrics.cancellation.requestedSignal).toBe('SIGTERM');
        if (failure === 'sampling') expect(metrics.measurement.status).toBe('incomplete');
        else expect(metrics.wrapper.cleanupFailure).toEqual({ scope: 'owned-process-group',
          message: 'Unable to confirm owned child process group termination' });
        expect(raw).not.toContain('private');
        expect(stderr).not.toContain('private');
      } finally {
        child.kill('SIGTERM');
        await child.exited;
      }
    }, 15_000);
  }

  for (const phase of ['initial', 'interval', 'final', 'summary'] as const) {
    for (const exitCode of [0, 7]) {
      test(`${phase} failure preserves child completion and exit ${exitCode}`, async () => {
        const root = await mkdtemp(join(tmpdir(), 'ci-metrics-failure-'));
        roots.push(root);
        const output = join(root, 'metrics.json');
        const marker = join(root, 'completed');
        const preload = join(root, 'preload.ts');
        await writeFile(preload, `const file = Bun.file.bind(Bun);
          let reads = 0;
          Bun.file = ((target, ...args) => {
            const result = file(target, ...args);
            if (String(target) !== '/proc/stat') return result;
            return new Proxy(result, { get(object, key) {
              if (key === 'text') return async () => {
                if (++reads === ${phase === 'initial' ? 1 : 2}) {
                  if (${phase === 'summary'}) return 'cpu 1 0 0 1 0 0 0 0\\ncpu0 1 0 0 1\\n';
                  throw Object.assign(new Error('private sample diagnostic'), { code: 'EMFILE' });
                }
                return object.text();
              };
              const value = Reflect.get(object, key);
              return typeof value === 'function' ? value.bind(object) : value;
            } });
          });`);
        const child = Bun.spawn([process.execPath, '--preload', preload, script,
          '--output', output, '--label', 'sampling-failure', '--', '/bin/sh', '-c',
          `sleep ${phase === 'interval' ? '1.2' : '0.05'}; printf completed > "$1"; exit ${exitCode}`,
          'child', marker], { stdout: 'pipe', stderr: 'pipe' });
        const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
        expect(status, stderr).toBe(exitCode);
        expect(await readFile(marker, 'utf8')).toBe('completed');
        const raw = await readFile(output, 'utf8');
        const metrics = JSON.parse(raw);
        expect(metrics.child).toEqual({ exitCode, signal: null });
        expect(metrics.wrapper.exitCode).toBe(exitCode);
        expect(metrics.measurement.status).toBe('incomplete');
        expect(metrics.cpu.averageSampledUtilization).toBeNull();
        expect(metrics.cpu.peakSampledUtilization).toBeNull();
        expect(metrics.memory.peakSampledUsedBytes).toBeNull();
        expect(metrics.timing.durationMs).toBeGreaterThan(0);
        expect(raw).not.toContain('private sample diagnostic');
        expect(stderr).not.toContain('private sample diagnostic');
      }, 10_000);
    }
  }
});
