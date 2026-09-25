import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCpuTicks, parseMemory, summarizeCpu } from '../scripts/ci-resource-metrics.ts';

const script = join(import.meta.dir, '../scripts/ci-resource-metrics.ts');
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempOutput(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ci-resource-metrics-'));
  tempDirs.push(dir);
  return join(dir, 'metrics.json');
}

function invoke(args: string[]) {
  const child = Bun.spawn([process.execPath, script, ...args], { stdout: 'pipe', stderr: 'pipe' });
  return child;
}

describe('Linux system resource parsers', () => {
  test('parses aggregate CPU ticks without reading process command lines', () => {
    expect(parseCpuTicks('cpu  100 2 30 400 5 6 7 8 9 10\ncpu0 1 2 3 4\n')).toEqual({ total: 558, idle: 405 });
    expect(() => parseCpuTicks('cpu0 1 2 3 4')).toThrow('aggregate CPU ticks');
    expect(() => parseCpuTicks('cpu 1 nope 3 4')).toThrow('invalid aggregate CPU ticks');
  });

  test('parses required system memory values and rejects missing inputs', () => {
    expect(parseMemory('MemTotal:       1000 kB\nMemAvailable:    250 kB\n')).toEqual({ totalBytes: 1_024_000, availableBytes: 256_000 });
    expect(() => parseMemory('MemTotal: 1000 kB\n')).toThrow('MemTotal or MemAvailable');
    expect(() => parseMemory('MemTotal: 1000 kB\nMemAvailable: 1200 kB\n')).toThrow('MemTotal or MemAvailable');
  });

  test('weights average CPU utilization by total system ticks and marks zero-tick samples unavailable', () => {
    const samples = [
      { at: 0, cpu: { total: 100, idle: 50 }, usedMemoryBytes: 10 },
      { at: 1_000, cpu: { total: 1_100, idle: 550 }, usedMemoryBytes: 10 },
      { at: 1_001, cpu: { total: 1_101, idle: 550 }, usedMemoryBytes: 10 },
    ];
    expect(summarizeCpu(samples)).toEqual({ average: 501 / 1001, peak: 1 });
    expect(summarizeCpu([
      { at: 0, cpu: { total: 100, idle: 50 }, usedMemoryBytes: 10 },
      { at: 1, cpu: { total: 100, idle: 50 }, usedMemoryBytes: 10 },
    ])).toEqual({ average: null, peak: null });
  });
});

describe.skipIf(process.platform !== 'linux')('ci resource metrics CLI', () => {
  test('the actual paid workflow binds the child tier through the measurement wrapper', async () => {
    const root = join(import.meta.dir, '..');
    const workflow = Bun.YAML.parse(await readFile(join(root, '.github/workflows/evals.yml'), 'utf8')) as any;
    const step = workflow.jobs['eval-slices'].steps.find((step: any) => step.name?.startsWith('Run slice'));
    expect(step.run).toContain('-- env EVALS_TIER=gate bun run scripts/test-paid-shards.ts');
    for (const removeBinding of [false, true]) {
      const output = await tempOutput();
      const manifest = `${output}.plan`;
      await writeFile(manifest, JSON.stringify({ version: 1, tier: 'gate', profile: 'full', evalsAll: false,
        sliceCount: 1, selectionReason: 'No-cost workflow binding regression',
        selection: { e2e: [], judges: [] }, entries: [] }));
      let command = step.run.replaceAll('${{ matrix.slice }}', '1')
        .replace('/tmp/paid-resources.json', output).replace('/tmp/paid-plan/manifest.json', manifest);
      if (removeBinding) command = command.replace('env EVALS_TIER=gate ', 'env ');
      const child = Bun.spawn(['bash', '-c', command], { cwd: root, stdout: 'pipe', stderr: 'pipe', env: {
        ...process.env, ANTHROPIC_API_KEY: undefined, EVALS_TIER: 'invalid-ambient-tier', EVALS_PROFILE: 'full',
        GSTACK_EVAL_DIR: `${output}.results`,
      } });
      const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(status, stderr).toBe(removeBinding ? 1 : 0);
      const metrics = JSON.parse(await readFile(output, 'utf8'));
      expect(metrics.child.exitCode).toBe(status);
      if (removeBinding) expect(stderr).toContain('EVALS_TIER must be gate or periodic');
      else {
        const result = JSON.parse(await readFile(`${output}.results/slice-1.json`, 'utf8'));
        expect(result.tier).toBe('gate');
        expect(result.outcomes).toEqual([]);
      }
    }
  }, 10_000);

  test('runs a real successful child and writes versioned system-wide metrics', async () => {
    const output = await tempOutput();
    const child = invoke(['--output', output, '--label', 'success-case', '--', '/usr/bin/sleep', '1.1']);
    expect(await child.exited).toBe(0);
    const metrics = JSON.parse(await readFile(output, 'utf8'));
    expect(metrics.schemaVersion).toBe(1);
    expect(metrics.label).toBe('success-case');
    expect(metrics.cpu.metricScope).toContain('system-wide');
    expect(metrics.cpu.detectedLogicalCpuCount).toBeGreaterThan(0);
    expect(metrics.cpu.availableCpuCount).toBeGreaterThan(0);
    expect(metrics.cpu.averageSampledUtilization).toBeGreaterThanOrEqual(0);
    expect(metrics.cpu.averageSampledUtilization).toBeLessThanOrEqual(1);
    expect(metrics.memory.metricScope).toContain('not child-process RSS');
    expect(metrics.memory.totalBytes).toBeGreaterThan(metrics.memory.baselineUsedBytes);
    expect(metrics.memory.peakSampledUsedBytes).toBeGreaterThanOrEqual(metrics.memory.baselineUsedBytes);
    expect(metrics.sampleCount).toBeGreaterThanOrEqual(2);
    expect(metrics.child).toEqual({ exitCode: 0, signal: null });
  }, 10_000);

  test('writes successful short-command metrics even when no CPU ticks advance', async () => {
    const output = await tempOutput();
    const child = invoke(['--output', output, '--label', 'short-success', '--', '/usr/bin/true']);
    expect(await child.exited).toBe(0);
    const metrics = JSON.parse(await readFile(output, 'utf8'));
    expect(metrics.child).toEqual({ exitCode: 0, signal: null });
    expect(metrics.cpu.averageSampledUtilization === null || typeof metrics.cpu.averageSampledUtilization === 'number').toBe(true);
    expect(metrics.cpu.peakSampledUtilization === null || typeof metrics.cpu.peakSampledUtilization === 'number').toBe(true);
  }, 10_000);

  test('writes metrics and propagates a child nonzero exit status', async () => {
    const output = await tempOutput();
    const child = invoke(['--output', output, '--label', 'failure-case', '--', '/bin/sh', '-c', 'sleep 1.1; exit 7']);
    expect(await child.exited).toBe(7);
    const metrics = JSON.parse(await readFile(output, 'utf8'));
    expect(metrics.child).toEqual({ exitCode: 7, signal: null });
  }, 10_000);

  test('preserves Linux signal status beyond the first fifteen signal numbers', async () => {
    const output = await tempOutput();
    const child = invoke(['--output', output, '--label', 'child-signal', '--', '/bin/sh', '-c', 'kill -VTALRM $$']);
    expect(await child.exited).toBe(154);
    expect(JSON.parse(await readFile(output, 'utf8')).child).toEqual({ exitCode: null, signal: 'SIGVTALRM' });
  }, 10_000);

  test('reports failed executable spawn when the system samples remain measurable', async () => {
    const output = await tempOutput();
    const missingCommand = '/no/such/private-executable-secret';
    const child = invoke(['--output', output, '--label', 'missing-command', '--', missingCommand]);
    expect(await child.exited).toBe(127);
    const json = await readFile(output, 'utf8');
    const metrics = JSON.parse(json);
    expect(metrics.child.exitCode).toBe(null);
    expect(metrics.child.spawnError).toEqual({ code: 'ENOENT', message: 'Unable to spawn child executable' });
    expect(json).not.toContain(missingCommand);
  }, 10_000);

  test('help and module import do not start a child', async () => {
    const help = invoke(['--help']);
    expect(await help.exited).toBe(0);
    expect(await new Response(help.stdout).text()).toContain('--output <json-path>');
    const imported = Bun.spawn([process.execPath, '-e', `import(${JSON.stringify(script)})`], { stdout: 'pipe', stderr: 'pipe' });
    expect(await imported.exited).toBe(0);
  }, 10_000);

  test('rejects malformed arguments before spawning and reports output write failures', async () => {
    const invalid = invoke(['--output', 'ignored.json']);
    expect(await invalid.exited).toBe(1);
    expect(await new Response(invalid.stderr).text()).toContain('Usage:');

    const output = await tempOutput();
    const missingParent = `${output}.missing/metrics.json`;
    const unwritable = invoke(['--output', missingParent, '--label', 'output-error', '--', '/usr/bin/sleep', '1.1']);
    expect(await unwritable.exited).toBe(1);
    expect(await new Response(unwritable.stderr).text()).toContain('ENOENT');
  }, 10_000);

  test('forwards cancellation to only the owned child process group and writes outcome', async () => {
    const output = await tempOutput();
    const cleanupMarker = `${output}.cleanup`;
    const child = invoke([
      '--output', output,
      '--label', 'cancel-case',
      '--',
      '/bin/sh', '-c', "trap 'printf cleaned > \"$1\"; exit 0' TERM; /usr/bin/sleep 30",
      'child', cleanupMarker,
    ]);
    await Bun.sleep(250);
    child.kill('SIGTERM');
    expect(await child.exited).toBe(143);
    expect(await readFile(cleanupMarker, 'utf8')).toBe('cleaned');
    const metrics = JSON.parse(await readFile(output, 'utf8'));
    expect(metrics.child).toEqual({ exitCode: 0, signal: null });
    expect(metrics.cancellation).toEqual({ requestedSignal: 'SIGTERM' });
  }, 10_000);

  test('escalates against an owned stubborn grandchild without signaling an unrelated process', async () => {
    const output = await tempOutput();
    const grandchildPidFile = `${output}.grandchild-pid`;
    const sentinel = Bun.spawn(['/usr/bin/sleep', '30'], { stdout: 'ignore', stderr: 'ignore' });
    try {
      const child = invoke([
        '--output', output,
        '--label', 'stubborn-child',
        '--',
        '/bin/sh', '-c', `/bin/sh -c 'trap "" TERM; exec /usr/bin/sleep 30' & echo $! > "$1"; trap 'exit 0' TERM; wait`,
        'child', grandchildPidFile,
      ]);
      await Bun.sleep(250);
      const pid = Number((await readFile(grandchildPidFile, 'utf8')).trim());
      expect(Number.isSafeInteger(pid)).toBe(true);
      child.kill('SIGTERM');
      expect(await child.exited).toBe(143);
      expect(process.kill(sentinel.pid!, 0)).toBe(true);
      let stubbornProcessRunning = false;
      try {
        process.kill(pid, 0);
        const stat = await Bun.file(`/proc/${pid}/stat`).text();
        stubbornProcessRunning = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      expect(stubbornProcessRunning).toBe(false);
      const metrics = JSON.parse(await readFile(output, 'utf8'));
      expect(metrics.cancellation).toEqual({ requestedSignal: 'SIGTERM' });
    } finally {
      sentinel.kill('SIGKILL');
    }
  }, 15_000);

  test.each(['SIGTERM', 'SIGHUP'] as const)('lets the real shard supervisor reap its detached group on %s', async signal => {
    const output = await tempOutput();
    const pidFile = `${output}.shard-pid`;
    const helper = join(import.meta.dir, '../scripts/test-strict-output.ts');
    const ownedProgram = `import { writeFileSync } from 'node:fs';
      process.on('SIGTERM', () => {});
      writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      setInterval(() => {}, 1000);`;
    const controller = `import { runShardChild } from ${JSON.stringify(helper)};
      await runShardChild({ command: process.execPath, args: ['-e', ${JSON.stringify(ownedProgram)}],
        cwd: process.cwd(), env: process.env, timeoutMs: 30000, hookStreams: () => [] });`;
    const child = invoke(['--output', output, '--label', 'real-supervisor', '--', process.execPath, '-e', controller]);
    try {
      for (let attempts = 0; attempts < 100 && !await Bun.file(pidFile).exists(); attempts++) await Bun.sleep(20);
      const pid = Number(await readFile(pidFile, 'utf8'));
      expect(Number.isSafeInteger(pid)).toBe(true);
      child.kill(signal);
      expect(await child.exited).toBe(signal === 'SIGHUP' ? 129 : 143);
      expect(() => process.kill(pid, 0)).toThrow();
      const metrics = JSON.parse(await readFile(output, 'utf8'));
      expect(metrics.cancellation.requestedSignal).toBe(signal);
      expect(metrics.child.exitCode).toBe(143);
    } finally { child.kill('SIGTERM'); }
  }, 15_000);
});
