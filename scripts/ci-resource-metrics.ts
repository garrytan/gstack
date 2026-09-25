import { availableParallelism, constants } from 'node:os';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

type CpuTicks = { total: number; idle: number };
type SystemSample = { at: number; cpu: CpuTicks; usedMemoryBytes: number };

export function parseCpuTicks(contents: string): CpuTicks {
  const line = contents.split('\n').find((entry) => /^cpu\s/.test(entry));
  if (!line) throw new Error('Linux /proc/stat does not contain aggregate CPU ticks');
  const fields = line.trim().split(/\s+/).slice(1).map(Number);
  if (fields.length < 4 || fields.some((field) => !Number.isSafeInteger(field) || field < 0)) {
    throw new Error('Linux /proc/stat contains invalid aggregate CPU ticks');
  }
  const total = fields.slice(0, 8).reduce((sum, field) => sum + field, 0);
  const idle = fields[3] + (fields[4] ?? 0);
  if (!Number.isSafeInteger(total) || total <= 0 || idle > total) {
    throw new Error('Linux /proc/stat contains unusable aggregate CPU ticks');
  }
  return { total, idle };
}

export function parseMemory(contents: string): { totalBytes: number; availableBytes: number } {
  const values = new Map<string, number>();
  for (const line of contents.split('\n')) {
    const match = /^(MemTotal|MemAvailable):\s+(\d+)\s+kB$/.exec(line);
    if (match) values.set(match[1], Number(match[2]) * 1024);
  }
  const totalBytes = values.get('MemTotal');
  const availableBytes = values.get('MemAvailable');
  if (!Number.isSafeInteger(totalBytes) || !Number.isSafeInteger(availableBytes)
    || totalBytes <= 0 || availableBytes < 0 || availableBytes > totalBytes) {
    throw new Error('Linux /proc/meminfo is missing valid MemTotal or MemAvailable values');
  }
  return { totalBytes, availableBytes };
}

export function summarizeCpu(samples: SystemSample[]): { average: number | null; peak: number | null } {
  const first = samples[0]?.cpu;
  const last = samples.at(-1)?.cpu;
  if (!first || !last) throw new Error('No Linux system CPU samples were collected');
  const totalDelta = last.total - first.total;
  const idleDelta = last.idle - first.idle;
  if (totalDelta < 0 || idleDelta < 0 || idleDelta > totalDelta) {
    throw new Error('Linux system CPU ticks did not advance consistently during measurement');
  }
  const intervals: number[] = [];
  for (let index = 1; index < samples.length; index += 1) {
    const intervalTotal = samples[index].cpu.total - samples[index - 1].cpu.total;
    const intervalIdle = samples[index].cpu.idle - samples[index - 1].cpu.idle;
    if (intervalTotal < 0 || intervalIdle < 0 || intervalIdle > intervalTotal) {
      throw new Error('Linux system CPU ticks did not advance consistently during measurement');
    }
    if (intervalTotal > 0) intervals.push((intervalTotal - intervalIdle) / intervalTotal);
  }
  return {
    average: totalDelta > 0 ? (totalDelta - idleDelta) / totalDelta : null,
    peak: intervals.length > 0 ? Math.max(...intervals) : null,
  };
}

function detectedCpuCount(contents: string): number {
  const count = contents.split('\n').filter((line) => /^cpu\d+\s/.test(line)).length;
  if (!Number.isSafeInteger(count) || count <= 0) throw new Error('Linux /proc/stat contains no detected CPU entries');
  return count;
}

async function sample(): Promise<SystemSample & { cpuCount: number; totalMemoryBytes: number }> {
  const [stat, meminfo] = await Promise.all([
    Bun.file('/proc/stat').text(),
    Bun.file('/proc/meminfo').text(),
  ]);
  const cpu = parseCpuTicks(stat);
  const memory = parseMemory(meminfo);
  return {
    at: Date.now(),
    cpu,
    usedMemoryBytes: memory.totalBytes - memory.availableBytes,
    cpuCount: detectedCpuCount(stat),
    totalMemoryBytes: memory.totalBytes,
  };
}

function parseArguments(args: string[]): { output: string; label: string; command: string; commandArgs: string[] } {
  if (args.length < 6 || args[0] !== '--output' || args[2] !== '--label' || args[4] !== '--' || !args[1] || !args[3] || !args[5]) {
    throw new Error('Usage: bun scripts/ci-resource-metrics.ts --output <json-path> --label <short-label> -- <executable> <args...>');
  }
  if (args[3].length > 80 || /[\r\n]/.test(args[3])) throw new Error('Label must be a short single-line string (max 80 characters)');
  return { output: args[1], label: args[3], command: args[5], commandArgs: args.slice(6) };
}

async function run(args: string[]): Promise<number> {
  const options = parseArguments(args);
  if (process.platform !== 'linux') throw new Error('CI resource metrics require Linux procfs');

  const samples: Awaited<ReturnType<typeof sample>>[] = [];
  let measurementIncomplete = false;
  let monitor: ReturnType<typeof setInterval> | undefined;
  const captureSample = async () => {
    if (measurementIncomplete) return;
    try { samples.push(await sample()); }
    catch {
      measurementIncomplete = true;
      if (monitor) clearInterval(monitor);
    }
  };
  await captureSample();
  const startedAt = samples[0]?.at ?? Date.now();

  const child = spawn(options.command, options.commandArgs, {
    stdio: 'inherit',
    env: process.env,
    detached: true,
  });
  let spawnError: Error | undefined;
  let cancellationSignal: NodeJS.Signals | undefined;
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  let cleanupDone: Promise<void> | undefined;
  const killOwnedGroup = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  const ownedGroupIsRunning = async () => {
    if (!child.pid) return false;
    try {
      process.kill(-child.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw error;
    }
    for (const entry of await readdir('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      let stat: string;
      try {
        stat = await readFile(`/proc/${entry}/stat`, 'utf8');
      } catch (error) {
        if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
        throw error;
      }
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      if (Number(fields[2]) === child.pid && fields[0] !== 'Z') return true;
    }
    return false;
  };
  const forwardSignal = (signal: NodeJS.Signals) => {
    if (cancellationSignal) return;
    cancellationSignal = signal;
    killOwnedGroup(signal === 'SIGHUP' ? 'SIGTERM' : signal);
    cleanupDone = new Promise((resolve) => {
      cleanupTimer = setTimeout(() => {
        cleanupTimer = undefined;
        killOwnedGroup('SIGKILL');
        resolve();
      }, 7_000);
    });
  };
  const onInt = () => forwardSignal('SIGINT');
  const onTerm = () => forwardSignal('SIGTERM');
  const onHup = () => forwardSignal('SIGHUP');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  process.on('SIGHUP', onHup);

  let pendingSample = Promise.resolve();
  if (!measurementIncomplete) monitor = setInterval(() => {
    pendingSample = pendingSample.then(captureSample);
  }, 1_000);

  const outcome = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('error', (error) => {
      spawnError = error;
      resolve({ exitCode: null, signal: null });
    });
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
  });
  if (monitor) clearInterval(monitor);
  await pendingSample;
  let cleanupFailure: string | undefined;
  let settledSignal: NodeJS.Signals | undefined;
  const settleCancellation = async () => {
    if (!cancellationSignal || settledSignal) return;
    try {
      if (cleanupTimer) {
        let stopped = false;
        try { stopped = !await ownedGroupIsRunning(); }
        catch { cleanupFailure = 'Unable to confirm owned child process group termination'; }
        if (stopped) {
          clearTimeout(cleanupTimer);
          cleanupTimer = undefined;
        }
      }
      if (cleanupDone && cleanupTimer) await cleanupDone;
      const deadline = performance.now() + 1_000;
      while (await ownedGroupIsRunning()) {
        if (performance.now() >= deadline) {
          cleanupFailure = 'Owned child process group did not stop after SIGKILL';
          break;
        }
        await Bun.sleep(10);
      }
    } catch {
      cleanupFailure ??= 'Unable to confirm owned child process group termination';
    } finally {
      if (cleanupTimer) clearTimeout(cleanupTimer);
      cleanupTimer = undefined;
      settledSignal = cancellationSignal;
    }
  };
  try {
    while (true) {
      await settleCancellation();
      await captureSample();
      if (cancellationSignal !== settledSignal) continue;
      const endedAt = Date.now();
      let cpuSummary = { average: null as number | null, peak: null as number | null };
      if (!measurementIncomplete) {
        try { cpuSummary = summarizeCpu(samples); }
        catch { measurementIncomplete = true; }
      }
      const exitCode = cleanupFailure ? 1 : spawnError ? 127 : cancellationSignal
        ? 128 + osSignalNumber(cancellationSignal)
        : outcome.exitCode ?? (outcome.signal ? 128 + osSignalNumber(outcome.signal) : 1);
      const metrics = {
        schemaVersion: 1,
        label: options.label,
        timing: {
          startedAt: new Date(startedAt).toISOString(),
          endedAt: new Date(endedAt).toISOString(),
          durationMs: endedAt - startedAt,
        },
        measurement: { status: measurementIncomplete ? 'incomplete' : 'complete' },
        cpu: {
          metricScope: 'Linux runner system-wide aggregate CPU utilization, not child-process CPU',
          detectedLogicalCpuCount: samples[0]?.cpuCount ?? null,
          availableCpuCount: availableParallelism(),
          averageSampledUtilization: cpuSummary.average,
          peakSampledUtilization: cpuSummary.peak,
        },
        memory: {
          metricScope: 'Linux runner system-wide used memory, not child-process RSS',
          totalBytes: samples[0]?.totalMemoryBytes ?? null,
          baselineUsedBytes: samples[0]?.usedMemoryBytes ?? null,
          peakSampledUsedBytes: measurementIncomplete ? null : Math.max(...samples.map((entry) => entry.usedMemoryBytes)),
        },
        sampleCount: samples.length,
        ...(cancellationSignal ? { cancellation: { requestedSignal: cancellationSignal } } : {}),
        wrapper: {
          exitCode,
          ...(cleanupFailure ? { cleanupFailure: { scope: 'owned-process-group', message: cleanupFailure } } : {}),
        },
        child: {
          exitCode: outcome.exitCode,
          signal: outcome.signal ?? null,
          ...(spawnError ? {
            spawnError: {
              code: (spawnError as NodeJS.ErrnoException).code ?? null,
              message: 'Unable to spawn child executable',
            },
          } : {}),
        },
      };
      try {
        await writeFile(options.output, `${JSON.stringify(metrics, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      } catch (error) {
        await settleCancellation();
        throw error;
      }
      if (cancellationSignal !== settledSignal) continue;
      if (measurementIncomplete) process.stderr.write('[ci-resource-metrics] Sampling incomplete; child outcome preserved.\n');
      if (cleanupFailure) process.stderr.write(`${cleanupFailure}\n`);
      return exitCode;
    }
  } finally {
    if (cleanupTimer) clearTimeout(cleanupTimer);
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
    process.off('SIGHUP', onHup);
  }
}

function osSignalNumber(signal: NodeJS.Signals): number {
  return constants.signals[signal] ?? 1;
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    process.stdout.write('Usage: bun scripts/ci-resource-metrics.ts --output <json-path> --label <short-label> -- <executable> <args...>\n');
    process.exitCode = 0;
  } else run(args).then((code) => {
    process.exitCode = code;
  }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
