/**
 * Sandbox knobs added for syscall-supervised cloud sandboxes (Vercel /
 * Conductor cloud): the GSTACK_FREE_JOBS shard-count override and the
 * failingFiles attribution that feeds the opt-in flaky-retry pass
 * (GSTACK_FREE_RETRY_FLAKY). The retry orchestration itself lives inline in
 * main() — these tests pin its two load-bearing inputs:
 *
 *   1. fullSuiteJobs(): env override wins, is deliberately UNclamped by
 *      MAX_FULL_SUITE_JOBS, and rejects garbage loudly (a silent fallback to
 *      the default would saturate the sandbox's seccomp supervisor — the
 *      exact failure the knob exists to prevent).
 *   2. FreeShardOutcome.failingFiles: empty on pass, attributed files on
 *      failure, crashes included, deduped — and EMPTY when every failure is
 *      unattributed (retrying without knowing what to re-run is meaningless,
 *      so main() must see [] and skip the retry).
 */
import { describe, test, expect, spyOn } from 'bun:test';
import * as os from 'os';
import { readFileSync } from 'node:fs';
import {
  fullSuiteJobs,
  MAX_FULL_SUITE_JOBS,
  runFreeShard,
} from '../scripts/test-free-shards';

/** Run fn with GSTACK_FREE_JOBS set (or deleted for undefined), restoring after. */
function withJobsEnv<T>(value: string | undefined, fn: () => T): T {
  const prior = process.env.GSTACK_FREE_JOBS;
  if (value === undefined) delete process.env.GSTACK_FREE_JOBS;
  else process.env.GSTACK_FREE_JOBS = value;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.GSTACK_FREE_JOBS;
    else process.env.GSTACK_FREE_JOBS = prior;
  }
}

describe('test-free-shards: fullSuiteJobs (GSTACK_FREE_JOBS override)', () => {
  test('unset and empty string both take the computed default — available CPUs, capped, floor 1', () => {
    const expected = Math.max(1, Math.min(MAX_FULL_SUITE_JOBS, os.availableParallelism?.() ?? os.cpus().length));
    expect(withJobsEnv(undefined, fullSuiteJobs)).toBe(expected);
    // A stray `export GSTACK_FREE_JOBS=` must not throw.
    expect(withJobsEnv('', fullSuiteJobs)).toBe(expected);
  });

  test.each([[0, 1], [1, 1], [2, 2], [4, 4], [8, 6]])(
    '%i available CPUs default to %i serial shard processes regardless of host CPU count',
    (availableCpus, expected) => {
      const available = spyOn(os, 'availableParallelism').mockReturnValue(availableCpus);
      const cpus = spyOn(os, 'cpus').mockReturnValue(Array<os.CpuInfo>(16));
      try {
        expect(withJobsEnv(undefined, fullSuiteJobs)).toBe(expected);
        expect(withJobsEnv('', fullSuiteJobs)).toBe(expected);
        expect(cpus).not.toHaveBeenCalled();
      } finally {
        available.mockRestore();
        cpus.mockRestore();
      }
    },
  );

  test('runtimes without availableParallelism fall back to the bounded CPU count', () => {
    const result = Bun.spawnSync([process.execPath, '-e', `
      import { mock } from 'bun:test';
      import * as os from 'os';
      const originalOs = { ...os };
      let cpuCount = 0;
      mock.module('os', () => ({
        ...originalOs,
        availableParallelism: undefined,
        cpus: () => Array(cpuCount),
      }));
      const { fullSuiteJobs } = await import(${JSON.stringify(import.meta.resolve('../scripts/test-free-shards'))});
      delete process.env.GSTACK_FREE_JOBS;
      console.log(JSON.stringify([0, 1, 2, 4, 8].map(count => {
        cpuCount = count;
        return fullSuiteJobs();
      })));
    `], { timeout: 10_000 });
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe('');
    expect(JSON.parse(result.stdout.toString())).toEqual([1, 1, 2, 4, 6]);
  });

  test('a positive integer override is honored exactly (the sandbox recipe sets 2)', () => {
    expect(withJobsEnv('2', fullSuiteJobs)).toBe(2);
    expect(withJobsEnv('1', fullSuiteJobs)).toBe(1);
    expect(withJobsEnv(' 2 ', fullSuiteJobs)).toBe(2);
    expect(withJobsEnv('02', fullSuiteJobs)).toBe(2);
  });

  test('Windows CI pins its two-worker budget independently of local CPU defaults', () => {
    const workflow = Bun.YAML.parse(readFileSync(new URL('../.github/workflows/windows-free-tests.yml', import.meta.url), 'utf8')) as {
      jobs: Record<string, { steps: Array<{ run?: string; env?: Record<string, string> }> }>;
    };
    const step = workflow.jobs['windows-free-tests'].steps.find(step => step.run === 'bun run test:windows');
    expect(step).toBeDefined();
    expect(step?.env?.GSTACK_FREE_JOBS).toBe('2');
    expect(withJobsEnv(step?.env?.GSTACK_FREE_JOBS, fullSuiteJobs)).toBe(2);
  });

  test('an explicit override does not probe the available CPUs', () => {
    const available = spyOn(os, 'availableParallelism').mockImplementation(() => {
      throw new Error('CPU detection must not run for an explicit override');
    });
    const cpus = spyOn(os, 'cpus').mockImplementation(() => {
      throw new Error('CPU detection must not run for an explicit override');
    });
    try {
      expect(withJobsEnv('2', fullSuiteJobs)).toBe(2);
      expect(withJobsEnv('12', fullSuiteJobs)).toBe(12);
      expect(available).not.toHaveBeenCalled();
      expect(cpus).not.toHaveBeenCalled();
    } finally {
      available.mockRestore();
      cpus.mockRestore();
    }
  });

  test('override is deliberately NOT clamped by MAX_FULL_SUITE_JOBS (beefy boxes may raise it)', () => {
    const above = MAX_FULL_SUITE_JOBS + 6;
    expect(withJobsEnv(String(above), fullSuiteJobs)).toBe(above);
  });

  test('zero, negative, and non-numeric values throw loudly instead of silently defaulting', () => {
    // '2abc' and '3.7' pin the strict digits-only check: parseInt would
    // silently truncate them to 2 and 3, defeating the loud-failure contract.
    for (const bad of ['0', '-2', 'abc', 'NaN', '2abc', '3.7', ' ', '+2', '1e2', 'Infinity']) {
      expect(() => withJobsEnv(bad, fullSuiteJobs)).toThrow(/positive integer/);
    }
  });
});

describe('test-free-shards: FreeShardOutcome.failingFiles (flaky-retry feed)', () => {
  // Same fake-command seam and raw-fail-line hygiene as the strict-execution
  // suite in test-free-shards.test.ts: never write a bun fail line verbatim
  // into this source file.
  const FAIL_WORD = '(fa' + 'il)';
  const failLine = (name: string) => `${FAIL_WORD} ${name} [0.10ms]`;
  const summary = (tests: number, files: number) => `Ran ${tests} tests across ${files} files. [12.00ms]`;

  const commandPrinting = (stdoutLines: string[], exitCode = 0) => () => ({
    command: process.execPath,
    args: ['-e',
      stdoutLines.map((l) => `console.log(${JSON.stringify(l)});`).join('')
      + (exitCode !== 0 ? `process.exit(${exitCode});` : ''),
    ],
  });

  test('a passing shard reports no failing files', async () => {
    const commandFor = commandPrinting([summary(3, 1)]);
    const outcome = await runFreeShard(['pass'], 1, 1, { commandFor, quiet: true, log: () => {} });
    expect(outcome.status).toBe('passed');
    expect(outcome.failingFiles).toEqual([]);
  });

  test('an attributed failure names its file-chunk header, once, even with two failing tests', async () => {
    const commandFor = commandPrinting([
      'test/planted.test.ts:',
      failLine('first planted failure'),
      failLine('second planted failure'),
      summary(3, 1),
    ]);
    const outcome = await runFreeShard(['planted'], 1, 1, { commandFor, quiet: true, log: () => {} });
    expect(outcome.status).toBe('failed');
    expect(outcome.failingFiles).toEqual(['test/planted.test.ts']);
    expect(outcome.unattributedFailures).toBe(0); // fully attributed — retry-eligible
  });

  test('a MIXED shard (one attributed + one headerless failure) is flagged unattributable — retry must not mask the headerless one', async () => {
    // The retry gate must not equate "some failure attributed" with "all
    // failures attributed": re-running only test/planted.test.ts and passing
    // would report the suite green over the headerless failure.
    const commandFor = commandPrinting([
      failLine('headerless failure before any file chunk'),
      'test/planted.test.ts:',
      failLine('planted failure'),
      summary(2, 1),
    ]);
    const outcome = await runFreeShard(['mixed'], 1, 1, { commandFor, quiet: true, log: () => {} });
    expect(outcome.status).toBe('failed');
    expect(outcome.failingFiles).toEqual(['test/planted.test.ts']);
    expect(outcome.unattributedFailures).toBeGreaterThan(0);
  });

  test('failures across two files attribute both; a crashed worker file joins the set deduped', async () => {
    const commandFor = commandPrinting([
      'test/alpha.test.ts:',
      failLine('alpha broke'),
      'test/beta.test.ts:',
      failLine('beta broke'),
      '✗ test/beta.test.ts (crashed: exited)',
      summary(2, 2),
    ], 1);
    const outcome = await runFreeShard(['alpha', 'beta'], 1, 1, { commandFor, quiet: true, log: () => {} });
    expect(outcome.status).toBe('failed');
    expect([...outcome.failingFiles].sort()).toEqual(['test/alpha.test.ts', 'test/beta.test.ts']);
  });

  test('an UNattributed failure (no file header) yields an empty list — retry must not fire blind', async () => {
    // Fail line before any file-chunk header: the reporter cannot know which
    // file to re-run, so failingFiles stays empty and main() skips the
    // flaky-retry ("failures not fully attributed").
    const commandFor = commandPrinting([
      failLine('headerless failure'),
      summary(1, 1),
    ]);
    const outcome = await runFreeShard(['mystery'], 1, 1, { commandFor, quiet: true, log: () => {} });
    expect(outcome.status).toBe('failed');
    expect(outcome.failingFiles).toEqual([]);
  });

  test('a missing terminal summary (silent truncation) is a failure with no attributed files', async () => {
    const commandFor = commandPrinting(['ok, no summary printed']);
    const outcome = await runFreeShard(['truncated'], 1, 1, { commandFor, quiet: true, log: () => {} });
    expect(outcome.status).toBe('failed');
    expect(outcome.failingFiles).toEqual([]);
    expect(outcome.unattributedFailures).toBeGreaterThan(0); // truncation counts as unattributable evidence
  });

  test('a truncated run WITH an attributed failure is still unattributable — tests after the cut never ran', async () => {
    const commandFor = commandPrinting([
      'test/planted.test.ts:',
      failLine('planted failure'),
      // no terminal summary: the child died mid-suite
    ]);
    const outcome = await runFreeShard(['planted', 'neverran'], 1, 1, { commandFor, quiet: true, log: () => {} });
    expect(outcome.status).toBe('failed');
    expect(outcome.failingFiles).toEqual(['test/planted.test.ts']);
    expect(outcome.unattributedFailures).toBeGreaterThan(0);
  });
});
