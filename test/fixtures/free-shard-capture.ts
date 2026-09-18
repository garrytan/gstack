/** Isolated capture harness and synthetic child; never imported by the test runner. */
import { spyOn } from 'bun:test';
import * as cp from 'node:child_process';
import * as fs from 'node:fs';

interface CaptureConfig {
  mode: 'clean' | 'destroyed' | 'destroyed-error' | 'delayed-error' | 'partial' | 'absent';
  exitCode: number;
  summary: string;
  partial: string;
  cause: string;
  receipt: string;
  logFilePath: string;
}

function runChild(config: CaptureConfig): void {
  if (config.mode === 'clean' || config.mode === 'partial') console.log(config.partial);
  if (config.mode === 'partial') {
    console.error('test/capture-fixture.test.ts:');
    console.error('(fa' + 'il) fixture failure [0.10ms]');
  }
  console.error(config.summary);
  setTimeout(() => process.exit(config.exitCode), 150);
}

async function runHarness(config: CaptureConfig): Promise<void> {
  const unhandled: string[] = [];
  process.on('unhandledRejection', error => unhandled.push(String(error)));
  let child: cp.ChildProcess | undefined;
  let childTmp: string | undefined;
  // Turn the old end-only hang into a fast deterministic failure. The
  // synthetic child exits on its own after 150ms, even when capture is lost.
  const watchdog = setTimeout(() => {
    fs.writeFileSync(config.receipt, JSON.stringify({
      watchdog: true, childExit: child?.exitCode, childTmp, unhandled,
    }));
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    process.exit(91);
  }, 2000);
  const originalSpawn = cp.spawn;
  const spy = spyOn(cp, 'spawn').mockImplementation((command, args, options) => {
    const spawned = originalSpawn(command, args, options);
    if (!Array.isArray(args) || args[0] !== import.meta.filename || args[1] !== 'child') return spawned;
    child = spawned;
    childTmp = options?.env?.TMPDIR;
    const stdout = spawned.stdout!;
    if (config.mode === 'destroyed') stdout.destroy();
    if (config.mode === 'destroyed-error') stdout.destroy(new Error(config.cause));
    if (config.mode === 'delayed-error') {
      spawned.stderr!.once('data', () => stdout.destroy(new Error(config.cause)));
    }
    if (config.mode === 'partial') stdout.once('data', () => stdout.destroy());
    if (config.mode === 'absent') {
      stdout.destroy();
      Object.defineProperty(spawned, 'stdout', { value: null });
    }
    return spawned;
  });
  try {
    const { runFreeShard } = await import('../../scripts/test-free-shards');
    const outcome = await runFreeShard(['test/capture-fixture.test.ts'], 1, 1, {
      commandFor: () => ({
        command: process.execPath,
        args: [import.meta.filename, 'child', JSON.stringify(config)],
      }),
      quiet: true, log: () => {}, logFilePath: config.logFilePath,
    });
    fs.writeFileSync(config.receipt, JSON.stringify({
      watchdog: false, outcome, childTmp, childPid: child!.pid, unhandled,
    }));
  } finally {
    clearTimeout(watchdog);
    spy.mockRestore();
  }
}

if (import.meta.main) {
  const config: CaptureConfig = JSON.parse(process.argv[3]!);
  if (process.argv[2] === 'child') runChild(config);
  else if (process.argv[2] === 'harness') await runHarness(config);
  else throw new Error('Expected a capture harness or child invocation');
}
