/**
 * Unit pins for the shared shard engine (scripts/lib/shard-engine.ts): the
 * lane-exit consequences of failing, unhandled and module-load output, each
 * lane's injected zero-execution and seed rules, whole-group kill on a wall
 * timeout, the win32 path, log capture, sandbox isolation and the flag loop.
 * run-shard-child and strict-output-* tests pin the moved primitives.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  cliUsage,
  BunTestOutputClassifier,
  createShardSandbox,
  killProcessGroup,
  nextShardLogPath,
  openShardLog,
  parseCliFlags,
  readDurationSeed,
  removeShardSandbox,
  runShardChild,
  strictShardStatus,
  writeDurationSeed,
  zeroExecutionVerdict,
} from '../scripts/lib/shard-engine';
import { FREE_LANE_POLICY, exitCodeFor, runFreeShard } from '../scripts/test-free-shards';
import {
  PAID_LANE_POLICY, applyHollowShardGuard, runPaidShard, summarize, summaryExitCode, type ShardOutcome,
} from '../scripts/test-paid-shards';

const scratch: string[] = [];
const tempDir = (prefix: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(dir);
  return dir;
};
afterEach(() => { for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function summaryOf(output: string) {
  const classifier = new BunTestOutputClassifier();
  classifier.write(output, 'stderr');
  return classifier.end();
}

const PASSING = 'test/a.test.ts:\n(pass) a [1.00ms]\n\n 1 pass\n 0 fail\nRan 1 test across 1 file. [2.00ms]\n';
// Bun 1.3 output shapes observed for these outcomes (fixture corpus).
const FAILING = 'test/a.test.ts:\n(fail) a [1.00ms]\n\n 0 pass\n 1 fail\nRan 1 test across 1 file. [2.00ms]\n';
const MODULE_LOAD = 'test/a.test.ts:\nerror: module load failure\n\n 0 pass\n 1 fail\n 1 error\nRan 1 test across 1 file. [2.00ms]\n';
const UNHANDLED = 'test/a.test.ts:\n# Unhandled error between tests\nerror: boom\n\n 0 pass\n 0 fail\n 1 error\nRan 0 tests across 1 file. [2.00ms]\n';

describe('shard engine: verdicts and lane exits', () => {
  const verdict = (output: string, exitCode: number | null, timedOut = false) => strictShardStatus({
    timedOut, exitCode, summary: summaryOf(output), expectedFiles: 1, evidenceComplete: true,
  });
  const paidExit = (status: ShardOutcome['status']) => summaryExitCode(summarize([{
    shard: 1, files: ['test/a.test.ts'], status, exitCode: 0, elapsedMs: 1, groupPid: null, executedTests: 1, skippedTests: 0,
  }]));

  test('a failing test file makes both lanes exit nonzero, even when bun exits 0', () => {
    for (const exitCode of [0, 1]) {
      const status = verdict(FAILING, exitCode);
      expect(status).toBe('failed');
      expect(exitCodeFor(status)).toBe(1);
      expect(paidExit(status)).toBe(1);
    }
    expect(exitCodeFor(verdict(PASSING, 0))).toBe(0);
    expect(paidExit(verdict(PASSING, 0))).toBe(0);
  });

  test('unhandled between-test errors and module-load errors count as failures', () => {
    expect(summaryOf(UNHANDLED).unhandledBetweenTests).toBe(1);
    expect(verdict(UNHANDLED, 0)).toBe('failed');
    expect(summaryOf(MODULE_LOAD).failedTests).toBe(1);
    expect(verdict(MODULE_LOAD, 0)).toBe('failed');
    expect(verdict(MODULE_LOAD, 1)).toBe('failed');
  });

  test('missing summary, short file count or incomplete evidence never pass; a timeout is its own status', () => {
    expect(verdict('(pass) a [1.00ms]\n', 0)).toBe('failed');
    expect(strictShardStatus({ timedOut: false, exitCode: 0, summary: summaryOf(PASSING), expectedFiles: 2, evidenceComplete: true })).toBe('failed');
    expect(strictShardStatus({ timedOut: false, exitCode: 0, summary: summaryOf(PASSING), expectedFiles: 1, evidenceComplete: false })).toBe('failed');
    expect(verdict(PASSING, 0, true)).toBe('timed-out');
    expect(exitCodeFor('timed-out')).toBe(124);
    expect(paidExit('timed-out')).toBe(1);
  });
});

describe('shard engine: injected lane policy', () => {
  const zero = (executedTests: number | null): ShardOutcome => ({
    shard: 1, files: ['test/a.test.ts'], status: 'passed', exitCode: 0, elapsedMs: 1, groupPid: null, executedTests, skippedTests: 0,
  });

  test('free lane: zero executed tests pass when every planned file was counted', () => {
    for (const promisedAll of [false, true]) {
      expect(zeroExecutionVerdict(0, FREE_LANE_POLICY, { promisedAll })).toBe('passed');
    }
    const zeroTests = 'test/a.test.ts:\n\n 0 pass\n 0 fail\nRan 0 tests across 1 file. [2.00ms]\n';
    expect(strictShardStatus({ timedOut: false, exitCode: 0, summary: summaryOf(zeroTests), expectedFiles: 1, evidenceComplete: true })).toBe('passed');
  });

  test('paid lane: zero executed tests warn under selection and are passed-empty under EVALS_ALL', () => {
    expect(zeroExecutionVerdict(0, PAID_LANE_POLICY, { promisedAll: false })).toBe('passed-with-warning');
    expect(zeroExecutionVerdict(0, PAID_LANE_POLICY, { promisedAll: true })).toBe('passed-empty');
    expect(zeroExecutionVerdict(3, PAID_LANE_POLICY, { promisedAll: true })).toBe('passed');
    const warnings: string[] = [];
    const selective = applyHollowShardGuard([zero(0)], { evalsAll: false, warn: line => warnings.push(line) });
    expect(selective[0].status).toBe('passed');
    expect(warnings).toHaveLength(1);
    expect(summaryExitCode(summarize(selective))).toBe(0);
    const all = applyHollowShardGuard([zero(0)], { evalsAll: true, warn: () => {} });
    expect(all[0].status).toBe('passed-empty');
    expect(summaryExitCode(summarize(all))).toBe(1);
    expect(applyHollowShardGuard([zero(null)], { evalsAll: true, warn: () => {} })[0].status).toBe('passed');
  });

  test('duration seeds: one reader, lane predicate decides (free >= 0, paid > 0)', () => {
    const dir = tempDir('seed-');
    const file = path.join(dir, 'seed.json');
    fs.writeFileSync(file, JSON.stringify({ durations: { 'a.ts': 0, 'b.ts': 5, 'c.ts': -1, 'd.ts': 'x', 'e.ts': Infinity } }));
    expect(readDurationSeed(file, FREE_LANE_POLICY.acceptsSeedDuration)).toEqual({ status: 'ok', durations: { 'a.ts': 0, 'b.ts': 5 } });
    expect(readDurationSeed(file, PAID_LANE_POLICY.acceptsSeedDuration)).toEqual({ status: 'ok', durations: { 'b.ts': 5 } });
    expect(readDurationSeed(path.join(dir, 'missing.json'), () => true).status).toBe('missing');
    for (const corrupt of ['{not json', 'null']) {
      fs.writeFileSync(file, corrupt);
      expect(readDurationSeed(file, () => true).status).toBe('corrupt');
    }
    writeDurationSeed(file, { 'z.ts': 2, 'a.ts': 1 });
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(written.version).toBe(1);
    expect(Object.keys(written.durations)).toEqual(['a.ts', 'z.ts']);
    expect(fs.readdirSync(dir)).toEqual(['seed.json']);
  });
});

describe('shard engine: process lifecycle', () => {
  test.skipIf(process.platform === 'win32')('a timed-out shard\'s whole process group is killed and the lanes report it as not passed', async () => {
    const dir = tempDir('group-kill-');
    const pidFile = path.join(dir, 'grandchild.pid');
    const spinner = `const { spawn } = require('node:child_process');
      const p = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(p.pid));
      const end = Date.now() + 600000; while (Date.now() < end) {}`;
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return !(process.platform === 'linux' && fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].startsWith('Z'));
      } catch { return false; }
    };
    const waitDead = async (pid: number) => {
      const deadline = Date.now() + 2_000;
      while (alive(pid) && Date.now() < deadline) await Bun.sleep(20);
      return !alive(pid);
    };
    const free = await runFreeShard(['spin.test.ts'], 1, 1, {
      rootDir: dir, quiet: true, log: () => {}, wallTimeoutMs: 1_500, logFilePath: path.join(dir, 'free.log'),
      commandFor: () => ({ command: process.execPath, args: ['-e', spinner] }),
    });
    expect(free.status).toBe('timed-out');
    expect(exitCodeFor(free.status)).not.toBe(0);
    expect(await waitDead(Number(fs.readFileSync(pidFile, 'utf8')))).toBe(true);
    expect(await waitDead(free.groupPid!)).toBe(true);

    fs.rmSync(pidFile);
    const paid = await runPaidShard(['spin.test.ts'], 1, 1, {
      rootDir: dir, timeoutMs: 1_500, jobs: 2, logDir: dir, log: () => {},
      env: { ...process.env, GSTACK_CLAUDE_CLI_VERSION: 'fixture' },
      commandFor: () => ({ command: process.execPath, args: ['-e', spinner] }),
    });
    expect(paid.status).toBe('timed-out');
    expect(summaryExitCode(summarize([paid]))).toBe(1);
    expect(await waitDead(Number(fs.readFileSync(pidFile, 'utf8')))).toBe(true);
  }, 30_000);

  test('win32 semantics: no process group and never a negative-pid kill', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const kills = spyOn(process, 'kill');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const signalled: string[] = [];
      killProcessGroup({ pid: 4242, kill: (signal: string) => { signalled.push(signal); return true; } } as unknown as ChildProcess, 'SIGKILL');
      expect(signalled).toEqual(['SIGKILL']);
      const result = await runShardChild({
        command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: process.cwd(), env: process.env, timeoutMs: 500, hookStreams: () => [],
      });
      expect(result.timedOut).toBe(true);
      expect(kills.mock.calls.some(([pid]) => typeof pid === 'number' && pid < 0)).toBe(false);
    } finally {
      Object.defineProperty(process, 'platform', original);
      kills.mockRestore();
    }
  }, 30_000);

  test('an attached companion settles after the final group kill', async () => {
    let settledAfterExit = false;
    let child: ChildProcess | undefined;
    const result = await runShardChild({
      command: process.execPath, args: ['-e', 'console.log("done")'],
      cwd: process.cwd(), env: process.env, timeoutMs: 10_000,
      hookStreams: spawned => [new Promise<void>(resolve => { spawned.stdout!.resume(); spawned.stdout!.once('end', resolve); })],
      attach: spawned => {
        child = spawned;
        return { signal: () => {}, settle: async () => { settledAfterExit = spawned.exitCode !== null || spawned.signalCode !== null; } };
      },
    });
    expect(result.exitCode).toBe(0);
    expect(child).toBeDefined();
    expect(settledAfterExit).toBe(true);
  }, 30_000);
});

describe('shard engine: capture and isolation', () => {
  test('log capture spools every chunk; a write error fails the log once, without throwing', async () => {
    const dir = tempDir('shard-log-');
    const first = nextShardLogPath(dir, 'gstack-free-test');
    const second = nextShardLogPath(dir, 'gstack-free-test');
    expect(first).not.toBe(second);
    expect(path.basename(first)).toMatch(new RegExp(`^gstack-free-test-.+-${process.pid}-\\d+\\.log$`));
    const log = openShardLog(first, '[test:unit]', 0o600);
    log.write('one\n');
    log.write(Buffer.from('two\n'));
    await new Promise<void>(resolve => log.stream.end(() => resolve()));
    expect(fs.readFileSync(first, 'utf8')).toBe('one\ntwo\n');
    if (process.platform !== 'win32') expect(fs.statSync(first).mode & 0o777).toBe(0o600);
    expect(log.failed).toBe(false);

    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const broken = openShardLog(path.join(dir, 'missing', 'x.log'), '[test:unit]');
      await new Promise(resolve => broken.stream.once('error', resolve));
      broken.write('dropped');
      expect(broken.failed).toBe(true);
      expect(errors.mock.calls.filter(([line]) => String(line).includes('could not write the full log'))).toHaveLength(1);
    } finally { errors.mockRestore(); }
  });

  test('each shard gets its own tmp and Chromium profile, removed by the backstop', async () => {
    const base = { KEEP: '1', TMPDIR: '/inherited', CHROMIUM_PROFILE: '/shared-profile' };
    const a = createShardSandbox('gstack-unit-shard-', base);
    const b = createShardSandbox('gstack-unit-shard-', base, { realpath: true });
    try {
      expect(a.stateDir).not.toBe(b.stateDir);
      expect(b.stateDir).toBe(fs.realpathSync(b.stateDir));
      for (const box of [a, b]) {
        expect(box.env.KEEP).toBe('1');
        expect(box.env.GSTACK_HOME).toBeUndefined();
        for (const key of ['TMPDIR', 'TEMP', 'TMP']) expect(box.env[key]).toBe(box.tmp);
        expect(box.env.CHROMIUM_PROFILE).toBe(path.join(box.stateDir, 'chromium-profile'));
        expect(fs.statSync(box.tmp).isDirectory()).toBe(true);
      }
      expect(base.TMPDIR).toBe('/inherited');
      fs.writeFileSync(path.join(a.tmp, 'left-behind'), 'x');
      await removeShardSandbox(a.stateDir);
      expect(fs.existsSync(a.stateDir)).toBe(false);
      await removeShardSandbox(a.stateDir);
    } finally {
      fs.rmSync(a.stateDir, { recursive: true, force: true });
      fs.rmSync(b.stateDir, { recursive: true, force: true });
    }
  });

  test('flag loop: declared handlers consume values; anything else is Unknown argument', () => {
    const seen: Array<[string, string | undefined]> = [];
    parseCliFlags(['--on', '--value', 'x', '--value'], {
      '--on': () => { seen.push(['--on', undefined]); },
      '--value': next => { seen.push(['--value', next()]); },
    });
    expect(seen).toEqual([['--on', undefined], ['--value', 'x'], ['--value', undefined]]);
    expect(() => parseCliFlags(['--nope'], {})).toThrow('Unknown argument: --nope');
    expect(() => parseCliFlags(['constructor'], {})).toThrow('Unknown argument: constructor');
  });

  test('--help prints usage and exits 0 on both runners before any work starts (W8e)', () => {
    expect(cliUsage({ '--b': 0, '--a': 0 }, undefined, path.join(process.cwd(), 'scripts/x.ts')))
      .toBe('Usage: bun run scripts/x.ts [flags]\n\nFlags:\n  --a\n  --b\n\nSee docs/TESTING_INTERNALS.md for what each flag does.');
    expect(cliUsage({}, 'custom')).toBe('custom');
    const root = path.resolve(import.meta.dir, '..');
    for (const [runner, marker] of [['scripts/test-paid-shards.ts', '--emit-plan PATH'], ['scripts/test-free-shards.ts', '  --list']] as const) {
      for (const flag of ['--help', '-h']) {
        const result = Bun.spawnSync([process.execPath, 'run', runner, flag], { cwd: root, timeout: 30_000,
          env: { ...process.env, EVALS: '', EVALS_ALL: '' } });
        const out = result.stdout.toString();
        expect(result.exitCode, `${runner} ${flag}: ${result.stderr.toString()}`).toBe(0);
        expect(out.startsWith(`Usage: bun run ${runner} [flags]`)).toBe(true);
        expect(out).toContain(marker);
        expect(out).not.toContain('[test:');
      }
    }
  }, 60_000);
});
