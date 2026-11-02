/**
 * Sub-shards inside one CI job (`--ci-run … --jobs k`, scripts/lib/shard-jobs.ts):
 * the k = 1 golden path, identity-bound assignment, rejection of missing,
 * duplicate and incomplete sub-shard results, one retry pass per CI shard,
 * serial TREE_MUTATING and SLOW_UNDER_LOAD files, the timeout text, and per-file
 * test and expect() counts from real bun children at k = 1 and k > 1.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  collectFreeTestFiles, createFreeCiPlan, eligibleFreeRetryFiles, parseCliOptions, runFreeShard, TREE_MUTATING, validateFreeCiPlan, verifyFreeCiResults,
  type FreeCiResult, type FreeShardOutcome,
} from '../scripts/test-free-shards';
import {
  assertSoloSeedSample, assignSubShards, ciRunContext, FREE_JOBS_INVALID, mergeSubShardOutcomes, parseJobsFlag, parseJunitCounts, plannedShardJobs, plannedShardJobsProblem,
  readJunitReport, runCiShard, SLOW_UNDER_LOAD, subShardRecordProblems, subShardTimeoutText, validateJobsForShard, type CiShardDeps, type RunShardOptions,
} from '../scripts/lib/shard-jobs';

const ROOT = path.resolve(import.meta.dir, '..');
const EXCLUSIVE = Object.keys(TREE_MUTATING)[0];
const files = Array.from({ length: 7 }, (_, i) => `test/sample-${i}.test.ts`);
const durations = Object.fromEntries(files.map((file, i) => [file, (i + 1) * 1_000]));
const context = { planPath: 'plan.json', runId: '123/attempt 2', runner: 'runner-7 (linux, 8 CPUs)' };

const passed = (shardFiles: string[], shard = 1): FreeShardOutcome => ({
  shard, files: shardFiles, status: 'passed', exitCode: 0, elapsedMs: 5, groupPid: null, failingFiles: [], unattributedFailures: 0,
  summary: { testsRan: shardFiles.length * 2, filesRan: shardFiles.length, sawTerminalSummary: true },
});
const failed = (shardFiles: string[], failing: string[], shard = 1): FreeShardOutcome => ({
  ...passed(shardFiles, shard), status: 'failed', exitCode: 1, failingFiles: failing,
});

function harness(shardFiles: string[], respond: (files: string[]) => FreeShardOutcome | Promise<FreeShardOutcome> = passed) {
  const calls: Array<{ files: string[]; shardNumber: number; totalShards: number; options: RunShardOptions; startedAt: number; endedAt?: number }> = [];
  const retries: FreeShardOutcome[][] = [];
  const guards: Array<{ files: string[]; shards: number }> = [];
  let homeChange: string | null = null;
  let terminate = false;
  const deps: CiShardDeps = {
    async runShard(runFiles, shardNumber, totalShards, options) {
      const call: (typeof calls)[number] = { files: runFiles, shardNumber, totalShards, options, startedAt: performance.now() };
      calls.push(call);
      await new Promise(resolve => setTimeout(resolve, 20));
      try { return await respond(runFiles); } finally { call.endedAt = performance.now(); }
    },
    async retry(outcomes) {
      retries.push(outcomes);
      return { exitCode: outcomes.every(outcome => outcome.status === 'passed') ? 0 : 1, retry: null };
    },
    pack: (packFiles, count) => Array.from({ length: count }, (_, i) => packFiles.filter((_, j) => j % count === i)),
    isSerial: file => file in TREE_MUTATING || file in SLOW_UNDER_LOAD,
    terminationRequested: () => terminate,
    phaseGuard: (guarded, shards) => { guards.push({ files: guarded, shards }); return { verify: () => homeChange }; },
    log: () => {},
  };
  const plan = { version: 1 as const, revision: 'revision-a', id: 'plan-id-for-tests', shards: [{ shard: 1, files: shardFiles, predictedMs: 0 }] };
  const shard = plan.shards[0];
  const run = (jobs: number) => runCiShard({ plan, shard, revision: 'revision-a', jobs, wallTimeoutMs: 360_000, verbose: false, context }, deps);
  return { calls, retries, guards, deps, plan, shard, run, setHomeChange: (value: string) => { homeChange = value; }, cancel: () => { terminate = true; } };
}

describe('--jobs validation (FREE_JOBS_INVALID)', () => {
  test('accepts positive whole numbers and rejects everything else with the code and the precedence note', () => {
    expect(parseJobsFlag('1')).toBe(1);
    expect(parseJobsFlag('4')).toBe(4);
    for (const raw of ['0', '-1', '2.5', 'abc', '', ' 2', undefined]) {
      expect(() => parseJobsFlag(raw)).toThrow(FREE_JOBS_INVALID);
      expect(() => parseJobsFlag(raw)).toThrow(/GSTACK_FREE_JOBS sets the local full-suite process count and never changes --ci-run/);
    }
  });

  test('--jobs belongs to --ci-run only, and an absent --jobs leaves the parsed options unchanged', () => {
    const base = ['--ci-run', 'plan.json', '--shard', '1', '--result', 'r.json'];
    expect(parseCliOptions([...base, '--jobs', '4']).jobs).toBe(4);
    expect('jobs' in parseCliOptions(base)).toBe(false);
    expect(() => parseCliOptions([...base, '--jobs', '0'])).toThrow(FREE_JOBS_INVALID);
    expect(() => parseCliOptions([...base, '--jobs'])).toThrow(FREE_JOBS_INVALID);
    expect(() => parseCliOptions(['--jobs', '2'])).toThrow(`${FREE_JOBS_INVALID}: --jobs needs --ci-run`);
    expect(() => parseCliOptions(['--ci-plan', 'p.json', '--jobs', '2'])).toThrow(FREE_JOBS_INVALID);
  });

  test('k may not exceed the shard file count; an empty shard still takes 1', () => {
    expect(() => validateJobsForShard(4, 4, 3)).not.toThrow();
    expect(() => validateJobsForShard(1, 0, 21)).not.toThrow();
    expect(() => validateJobsForShard(5, 4, 3)).toThrow(`${FREE_JOBS_INVALID}: --jobs 5 is more than CI shard 3's 4 file(s); use 1 to 4.`);
    expect(() => validateJobsForShard(2, 0, 21)).toThrow(FREE_JOBS_INVALID);
  });
});

describe('per-shard k in the plan (--ci-plan --shard-jobs)', () => {
  test('--shard-jobs belongs to --ci-plan only and takes the same positive whole numbers', () => {
    const base = ['--ci-plan', 'plan.json', '--shards', '4'];
    expect(parseCliOptions([...base, '--shard-jobs', '2']).shardJobs).toBe(2);
    expect('shardJobs' in parseCliOptions(base)).toBe(false);
    for (const raw of ['0', '2.5', 'x']) expect(() => parseCliOptions([...base, '--shard-jobs', raw])).toThrow(`${FREE_JOBS_INVALID}: --shard-jobs needs a positive whole number`);
    expect(() => parseCliOptions(['--shard-jobs', '2'])).toThrow(`${FREE_JOBS_INVALID}: --shard-jobs needs --ci-plan`);
    expect(() => parseCliOptions(['--ci-run', 'p.json', '--shard', '1', '--result', 'r.json', '--shard-jobs', '2'])).toThrow(FREE_JOBS_INVALID);
  });

  test('each shard plans min(k, its parallel files); the exclusive shard and one-file shards stay one child, and k = 1 keeps the plan id', () => {
    const withExclusive = [...files, EXCLUSIVE];
    const plain = createFreeCiPlan(withExclusive, 3, durations, 'revision-a');
    expect(createFreeCiPlan(withExclusive, 3, durations, 'revision-a', 1)).toEqual(plain);
    expect(plain.shards.every(shard => !('jobs' in shard))).toBe(true);
    const planned = createFreeCiPlan(withExclusive, 3, durations, 'revision-a', 4);
    expect(planned.id).not.toBe(plain.id);
    expect(planned.shards.map(shard => shard.files)).toEqual(plain.shards.map(shard => shard.files));
    const exclusiveShard = planned.shards.at(-1)!;
    expect(exclusiveShard.files).toEqual([EXCLUSIVE]);
    expect('jobs' in exclusiveShard).toBe(false);
    for (const shard of planned.shards.slice(0, -1)) expect(shard.jobs).toBe(Math.min(4, shard.files.length) > 1 ? Math.min(4, shard.files.length) : undefined);
    expect(() => validateFreeCiPlan(planned, withExclusive, 'revision-a')).not.toThrow();
    expect(plannedShardJobs(['a', 'b', 'c'], 2, file => file === 'a')).toBe(2);
    expect(plannedShardJobs(['a', 'b'], 4, file => file === 'a')).toBeUndefined();
    expect(plannedShardJobs([], 4, () => false)).toBeUndefined();
  });

  test('a plan whose per-shard k is out of range is invalid, and every shard result must have run at its planned k', () => {
    const isSerial = (file: string) => file === EXCLUSIVE;
    expect(plannedShardJobsProblem({ shard: 1, files }, isSerial)).toBeNull();
    expect(plannedShardJobsProblem({ shard: 1, files, jobs: 7 }, isSerial)).toBeNull();
    for (const jobs of [1, 0, 8, 2.5, '2']) expect(plannedShardJobsProblem({ shard: 1, files, jobs }, isSerial)).toContain('CI shard 1 plans --jobs');
    expect(plannedShardJobsProblem({ shard: 2, files: [EXCLUSIVE, files[0]], jobs: 2 }, isSerial)).toContain('for 1 parallel file(s)');
    const plan = createFreeCiPlan(files, 1, durations, 'revision-a', 2);
    expect(plan.shards[0].jobs).toBe(2);
    const tampered = structuredClone(plan);
    tampered.shards[0].jobs = 99;
    expect(() => validateFreeCiPlan(tampered, files, 'revision-a')).toThrow();
    const k1: FreeCiResult = { planId: plan.id, revision: 'revision-a', outcome: passed(plan.shards[0].files), retry: null };
    expect(() => verifyFreeCiResults(plan, [k1])).toThrow('CI shard 1 ran at --jobs 1; the plan says 2');
    const plainPlan = createFreeCiPlan(files, 1, durations, 'revision-a');
    expect(() => verifyFreeCiResults(plainPlan, [{ ...k1, planId: plainPlan.id }])).not.toThrow();
  });
});

describe('k = 1 golden: PR 2 changes nothing in CI', () => {
  test('one child over the whole planned shard with the same wall, one retry pass, and the same result keys', async () => {
    const h = harness(files);
    const { result, exitCode } = await h.run(1);
    expect(h.calls.map(({ files: f, shardNumber, totalShards, options }) => ({ f, shardNumber, totalShards, options }))).toEqual([
      { f: h.shard.files, shardNumber: 1, totalShards: 1, options: { wallTimeoutMs: 360_000, verbose: false, testCounts: true } },
    ]);
    expect(h.guards).toEqual([]);
    expect(h.retries).toEqual([[passed(h.shard.files)]]);
    expect(h.calls[0].options.wallTimeoutMs).toBe(360_000);
    expect(Object.keys(result)).toEqual(['planId', 'revision', 'outcome', 'retry']);
    expect(result).toEqual({ planId: h.plan.id, revision: 'revision-a', outcome: passed(h.shard.files), retry: null });
    expect(exitCode).toBe(0);
  });

  test('a k = 1 failure reaches the retry pass as the child reported it', async () => {
    const h = harness(files, runFiles => failed(runFiles, [runFiles[0]]));
    const { result, exitCode } = await h.run(1);
    expect(h.retries).toEqual([[failed(h.shard.files, [h.shard.files[0]])]]);
    expect(result.outcome).toBe(h.retries[0][0]);
    expect(exitCode).toBe(1);
  });
});

describe('sub-shard assignment', () => {
  const pack = (packFiles: string[], count: number) => Array.from({ length: count }, (_, i) => packFiles.filter((_, j) => j % count === i));

  test('disjoint, identity-bound, covering the shard once, with exclusive files in one trailing serial sub-shard', () => {
    const shardFiles = [...files, EXCLUSIVE];
    const assignments = assignSubShards('plan-id-for-tests', { shard: 4, files: shardFiles }, 3, file => file in TREE_MUTATING, pack);
    expect(assignments.map(entry => [entry.id, entry.phase, entry.files.length])).toEqual([
      ['plan-id-for-:4.1', 'parallel', 3], ['plan-id-for-:4.2', 'parallel', 2], ['plan-id-for-:4.3', 'parallel', 2], ['plan-id-for-:4.4', 'serial', 1],
    ]);
    expect(assignments.at(-1)!.files).toEqual([EXCLUSIVE]);
    expect(assignments.flatMap(entry => entry.files).sort()).toEqual([...shardFiles].sort());
  });

  test('k is clamped to the parallel file count and a shard of only exclusive files stays one serial child', () => {
    expect(assignSubShards('p', { shard: 1, files: files.slice(0, 2) }, 4, () => false, pack).length).toBe(2);
    expect(assignSubShards('p', { shard: 1, files: [EXCLUSIVE] }, 1, file => file in TREE_MUTATING, pack)
      .map(entry => entry.phase)).toEqual(['serial']);
  });

  test('a packer that drops or repeats a file is rejected before any child starts', () => {
    expect(() => assignSubShards('p', { shard: 2, files }, 2, () => false, packFiles => [packFiles, [packFiles[0]]])).toThrow(/FREE_SUBSHARD_REJECTED/);
    expect(() => assignSubShards('p', { shard: 2, files }, 2, () => false, packFiles => [packFiles.slice(1)])).toThrow(/exactly once/);
  });
});

describe('k > 1: merge, rejection and one retry pass per CI shard', () => {
  test('parallel sub-shards share the concurrent home guard, then exclusive files run alone after they settle', async () => {
    const h = harness([...files, EXCLUSIVE]);
    const { result, exitCode } = await h.run(3);
    expect(exitCode).toBe(0);
    const parallel = h.calls.filter(call => !call.files.includes(EXCLUSIVE));
    const serial = h.calls.find(call => call.files.includes(EXCLUSIVE))!;
    expect(parallel).toHaveLength(3);
    expect(parallel.every(call => typeof call.options.homeGuard === 'function')).toBe(true);
    expect(serial.options.homeGuard).toBeUndefined();
    expect(serial.files).toEqual([EXCLUSIVE]);
    expect(serial.startedAt).toBeGreaterThanOrEqual(Math.max(...parallel.map(call => call.endedAt!)));
    expect(h.guards).toEqual([{ files: parallel.flatMap(call => call.files), shards: 3 }]);
    expect(h.calls.every(call => call.totalShards === 4)).toBe(true);
    expect(parallel.every(call => call.options.wallTimeoutMs === 360_000)).toBe(true);
    expect(serial.options.wallTimeoutMs).toBeLessThan(360_000);
    expect(serial.options.wallTimeoutMs).toBeGreaterThan(350_000);
    expect(result.jobs).toBe(3);
    expect(result.outcome).toMatchObject({ shard: 1, files: h.shard.files, status: 'passed', exitCode: 0, failingFiles: [], unattributedFailures: 0,
      summary: { testsRan: 16, filesRan: 8, sawTerminalSummary: true } });
    expect(result.subShards!.map(record => record.status)).toEqual(['passed', 'passed', 'passed', 'passed']);
    expect(h.retries).toHaveLength(1);
    expect(() => verifyFreeCiResults({ ...h.plan, shards: [{ ...h.shard, jobs: 3 }] }, [result])).not.toThrow();
    expect(() => verifyFreeCiResults(h.plan, [result])).toThrow('CI shard 1 ran at --jobs 3; the plan says 1');
  });

  test('failures from every sub-shard are collected first, so k never multiplies the five-file retry cap', async () => {
    const h = harness(files, runFiles => failed(runFiles, runFiles.slice(0, 2)));
    const { result, exitCode } = await h.run(3);
    expect(h.retries).toHaveLength(1);
    expect(h.retries[0]).toHaveLength(1);
    expect(result.outcome.failingFiles).toHaveLength(6);
    expect(eligibleFreeRetryFiles(h.retries[0])).toBeNull();
    expect(exitCode).toBe(1);
    const spread = harness(files, runFiles => failed(runFiles, runFiles.slice(0, 1)));
    await spread.run(3);
    expect(eligibleFreeRetryFiles(spread.retries[0])!.sort()).toEqual(spread.calls.map(call => call.files[0]).sort());
  });

  test('a missing, duplicate or incomplete sub-shard result fails the CI shard and vetoes the retry', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const cases: Array<(runFiles: string[]) => FreeShardOutcome | Promise<FreeShardOutcome>> = [
        runFiles => runFiles.includes(files[0]) ? Promise.reject(new Error('spawn failed')) : passed(runFiles),
        runFiles => passed(runFiles.includes(files[0]) ? [...runFiles, files[1]] : runFiles),
        runFiles => runFiles.includes(files[0]) ? { ...passed(runFiles), summary: { testsRan: 1, filesRan: runFiles.length - 1, sawTerminalSummary: true } } : passed(runFiles),
        runFiles => runFiles.includes(files[0]) ? { ...passed(runFiles), summary: undefined } : passed(runFiles),
      ];
      for (const respond of cases) {
        errors.mockClear();
        const h = harness(files, respond);
        const { result, exitCode } = await h.run(3);
        expect(h.calls).toHaveLength(3);
        expect(result.outcome.status).toBe('failed');
        expect(result.outcome.unattributedFailures).toBeGreaterThan(0);
        expect(eligibleFreeRetryFiles([result.outcome])).toBeNull();
        expect(exitCode).toBe(1);
        expect(errors.mock.calls.map(call => String(call[0])).some(line => line.startsWith('[test:free] FREE_SUBSHARD_REJECTED: CI shard 1: plan-id-for-:1.'))).toBe(true);
      }
    } finally { errors.mockRestore(); }
  });

  test('a failed sub-shard that ran too few or too many files is rejected, so counts cannot cancel and no retry repairs it', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const h = harness(files.slice(0, 4), runFiles => ({ ...failed(runFiles, [runFiles[0]]),
        summary: { testsRan: 2, filesRan: runFiles.includes(files[0]) ? 1 : 3, sawTerminalSummary: true } }));
      const { result } = await h.run(2);
      expect(result.outcome.summary!.filesRan).toBe(4);
      expect(result.outcome.unattributedFailures).toBeGreaterThanOrEqual(2);
      expect(eligibleFreeRetryFiles([result.outcome])).toBeNull();
      const forged: FreeCiResult = { ...result, outcome: { ...result.outcome, unattributedFailures: 0 },
        retry: { ...passed([files[0], files[1]]), shard: 2 } };
      expect(() => verifyFreeCiResults({ ...h.plan, revision: 'revision-a' } as never, [forged])).toThrow(/did not run every assigned file|identity/);
      expect(subShardRecordProblems(forged)).toContain('a sub-shard did not run every assigned file');
    } finally { errors.mockRestore(); }
  });

  test('the serial sub-shard gets only what is left of the wall, and none left means it is not launched', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const h = harness([...files, EXCLUSIVE], async runFiles => {
        if (!runFiles.includes(EXCLUSIVE)) await new Promise(resolve => setTimeout(resolve, 60));
        return passed(runFiles);
      });
      const { result } = await runCiShard({ plan: h.plan, shard: h.shard, revision: 'revision-a', jobs: 2, wallTimeoutMs: 50, verbose: false, context }, h.deps);
      expect(h.calls.some(call => call.files.includes(EXCLUSIVE))).toBe(false);
      expect(result.subShards!.at(-1)).toMatchObject({ status: 'missing', phase: 'serial' });
      expect(result.outcome.status).toBe('failed');
    } finally { errors.mockRestore(); }
  });

  test('a real-home change in the concurrent phase and a cancelled serial phase both fail the shard', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const home = harness(files);
      home.setHomeChange('real home changed while 3 shards ran concurrently');
      expect((await home.run(3)).result.outcome.status).toBe('failed');
      const cancelled = harness([...files, EXCLUSIVE]);
      cancelled.cancel();
      const { result } = await cancelled.run(2);
      expect(cancelled.calls.some(call => call.files.includes(EXCLUSIVE))).toBe(false);
      expect(result.subShards!.at(-1)).toMatchObject({ status: 'missing', files: [EXCLUSIVE] });
      expect(result.outcome.status).toBe('failed');
    } finally { errors.mockRestore(); }
  });

  test('a sub-shard timeout prints FREE_SUBSHARD_TIMEOUT with the file, k, runner, run id and a serial reproduce', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const h = harness(files, runFiles => runFiles.includes(files[3])
        ? { ...failed(runFiles, []), status: 'timed-out', exitCode: null, inFlight: [files[3]] } : passed(runFiles));
      const { result, exitCode } = await h.run(3);
      expect(result.outcome.status).toBe('timed-out');
      expect(exitCode).toBe(1);
      const text = errors.mock.calls.map(call => String(call[0])).join('\n');
      expect(text).toContain('FREE_SUBSHARD_TIMEOUT: CI shard 1 sub-shard plan-id-for-:1.1 (3 files)');
      expect(text).toContain('hit its 360s wall at --jobs 3 on runner-7 (linux, 8 CPUs), run 123/attempt 2.');
      expect(text).toContain(`in flight: ${files[3]}`);
      expect(text).toContain(`printf '%s\\n' '${files[3]}' > files.txt && GSTACK_FREE_JOBS=1 bun run scripts/test-free-shards.ts --files-from files.txt`);
      expect(text).toContain("--ci-run 'plan.json' --shard 1 --result shard-1.json --jobs 1");
      expect(text).toContain('add it to SLOW_UNDER_LOAD in scripts/lib/shard-jobs.ts with run id 123/attempt 2; never raise the timeout.');
    } finally { errors.mockRestore(); }
  });

  test('--ci-verify rejects tampered sub-shard records', () => {
    const plan = createFreeCiPlan(files, 1, durations, 'revision-a', 2);
    const shard = plan.shards[0];
    const assignments = assignSubShards(plan.id, shard, 2, () => false, packFiles => [packFiles.slice(0, 3), packFiles.slice(3)]);
    const merged = mergeSubShardOutcomes(shard, assignments.map(assignment => ({ assignment, outcome: passed(assignment.files) })), 10);
    const result: FreeCiResult = { planId: plan.id, revision: 'revision-a', outcome: merged.outcome, retry: null, jobs: 2, subShards: merged.records };
    expect(() => verifyFreeCiResults(plan, [result])).not.toThrow();
    const renamed = structuredClone(result);
    renamed.subShards![0].id = 'other:1.1';
    expect(() => verifyFreeCiResults(plan, [renamed])).toThrow(/ids or phases/);
    const tooMany = structuredClone(result);
    tooMany.jobs = 1;
    expect(subShardRecordProblems({ ...tooMany, jobs: 2, subShards: [...tooMany.subShards!, { ...tooMany.subShards![0], id: `${plan.id.slice(0, 12)}:1.3`, files: [] }] }))
      .toContain('sub-shard ids or phases do not match the plan and --jobs');
    const overlap = structuredClone(result);
    overlap.subShards![1].files = [...overlap.subShards![1].files, overlap.subShards![0].files[0]];
    expect(() => verifyFreeCiResults(plan, [overlap])).toThrow(/sub-shards rejected/);
    const hidden = structuredClone(result);
    hidden.subShards![0].status = 'failed';
    expect(() => verifyFreeCiResults(plan, [hidden])).toThrow(/a passing shard holds a failed sub-shard/);
    expect(() => verifyFreeCiResults(plan, [{ ...result, jobs: 1 }])).toThrow(/valid --jobs/);
  });
});

describe('per-file test and expect() counts from bun JUnit', () => {
  const xml = (file: string) => `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="6" assertions="9" failures="1" skipped="2">
  <testsuite name="${file}" file="${file}" tests="3" assertions="9" failures="1" skipped="2">
    <testsuite name="grp" file="${file}" tests="1" assertions="5">
      <testcase name="x &gt; y &quot;q&quot;" classname="grp" file="${file}" line="2" assertions="5" />
    </testsuite>
    <testcase name="todo" classname="" file="${file}" line="3" assertions="0"><skipped message="TODO" /></testcase>
    <testcase name="skip" classname="" file="${file}" line="4" assertions="0"><skipped /></testcase>
    <testcase name="fails" classname="" file="${file}" line="5" assertions="4"><failure type="AssertionError" message="a &lt;b&gt;">x</failure></testcase>
  </testsuite>
</testsuites>`;

  test('classifies every testcase and sums assertions per file; matches cwd-relative paths back to planned files', () => {
    const counts = parseJunitCounts(xml('../../test/a&amp;b.test.ts'), ['test/a&b.test.ts'], 4);
    expect(counts).toEqual({ source: 'bun-junit', complete: true, files: { 'test/a&b.test.ts': { tests: 4, pass: 1, fail: 1, skip: 1, todo: 1, expects: 9 } },
      totals: { tests: 4, pass: 1, fail: 1, skip: 1, todo: 1, expects: 9 } });
  });

  test('an ambiguous short path is never credited to one of two planned files that share it', () => {
    const counts = parseJunitCounts(xml('a.test.ts'), ['test/a.test.ts', 'browse/test/a.test.ts'], 4);
    expect(counts.complete).toBe(false);
    expect(counts.problem).toContain('unplanned');
  });

  test('an absolute path is credited to the planned file under the root; an unplanned file never borrows a shorter planned path', () => {
    const planned = ['test/telemetry.test.ts', 'browse/test/telemetry.test.ts'];
    expect(Object.keys(parseJunitCounts(xml('/repo/browse/test/telemetry.test.ts'), planned, 4, '/repo').files)).toEqual(['browse/test/telemetry.test.ts']);
    expect(Object.keys(parseJunitCounts(xml('../../repo/test/telemetry.test.ts'), planned, 4, '/repo').files)).toEqual(['test/telemetry.test.ts']);
    const borrowed = parseJunitCounts(xml('browse/test/x.test.ts'), ['test/x.test.ts'], 4, '/repo');
    expect(borrowed).toMatchObject({ complete: false, problem: expect.stringContaining('browse/test/x.test.ts') });
    expect(parseJunitCounts(xml('/elsewhere/test/x.test.ts'), ['test/x.test.ts'], 4, '/repo').complete).toBe(false);
  });

  test('the report is read only as a bounded regular file, never through a link or a FIFO', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-junit-'));
    try {
      fs.writeFileSync(path.join(dir, 'real.xml'), '<testsuites/>');
      expect(readJunitReport(path.join(dir, 'real.xml'))).toBe('<testsuites/>');
      expect(readJunitReport(path.join(dir, 'absent.xml'))).toBeNull();
      if (process.platform !== 'win32') {
        fs.symlinkSync(path.join(dir, 'real.xml'), path.join(dir, 'link.xml'));
        expect(readJunitReport(path.join(dir, 'link.xml'))).toBeNull();
        const fifo = Bun.spawnSync(['mkfifo', path.join(dir, 'fifo.xml')], { timeout: 5_000 });
        if (fifo.exitCode === 0) expect(readJunitReport(path.join(dir, 'fifo.xml'))).toBeNull();
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('a missing report, an unplanned file or a count that disagrees with bun summary is incomplete, never silently complete', () => {
    expect(parseJunitCounts(null, ['test/a.test.ts'], 4)).toMatchObject({ complete: false, problem: 'bun wrote no JUnit report' });
    expect(parseJunitCounts(xml('test/z.test.ts'), ['test/a.test.ts'], 4)).toMatchObject({ complete: false, problem: expect.stringContaining('unplanned') });
    expect(parseJunitCounts(xml('test/a.test.ts'), ['test/a.test.ts'], 5)).toMatchObject({ complete: false, problem: "JUnit counted 4 tests, bun's summary 5" });
    expect(parseJunitCounts(xml('test/a.test.ts'), ['test/a.test.ts'], null).complete).toBe(false);
  });

  test('real bun children: counts are identical per file at k = 1 and k = 2, add up to bun summary, and leave the stream unchanged', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-shard-jobs-')));
    try {
      const fixtures: Record<string, string> = {
        't/a.test.ts': "import { test, expect } from 'bun:test';\ntest('a1', () => { expect(1).toBe(1); expect(2).toBe(2); });\ntest('a2', () => { expect(3).toBe(3); });\ntest.skip('a3', () => {});\n",
        't/b.test.ts': "import { test, expect, describe } from 'bun:test';\ndescribe('g', () => { test('b1', () => { for (let i = 0; i < 5; i++) expect(i).toBe(i); }); });\ntest.todo('b2');\n",
        't/c.test.ts': "import { test, expect } from 'bun:test';\ntest('c1', () => { expect([1]).toEqual([1]); });\n",
        't/d.test.ts': "import { test, expect } from 'bun:test';\ntest.each([1, 2, 3])('d%p', n => { expect(n).toBeGreaterThan(0); expect(n).toBeLessThan(4); });\n",
      };
      for (const [file, body] of Object.entries(fixtures)) {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), body);
      }
      const planned = Object.keys(fixtures);
      const plan = createFreeCiPlan(planned, 1, {}, 'rev');
      const pids: number[] = [];
      const deps = (logs: string[]): CiShardDeps => ({
        runShard: async (runFiles, n, total, options) => {
          const logFilePath = path.join(root, `stream-${logs.length}-${runFiles.length}-${n}-${total}.log`);
          logs.push(logFilePath);
          const outcome = await runFreeShard(runFiles, n, total, { ...options, rootDir: root, quiet: true, log: () => {}, logFilePath });
          if (outcome.groupPid) pids.push(outcome.groupPid);
          return outcome;
        },
        retry: async outcomes => ({ exitCode: outcomes[0].status === 'passed' ? 0 : 1, retry: null }),
        pack: (packFiles, count) => Array.from({ length: count }, (_, i) => packFiles.filter((_, j) => j % count === i)),
        isSerial: () => false,
        terminationRequested: () => false,
        log: () => {},
      });
      const input = { plan, shard: plan.shards[0], revision: 'rev', wallTimeoutMs: 60_000, verbose: false, context };
      const serialLogs: string[] = [];
      const one = await runCiShard({ ...input, jobs: 1 }, deps(serialLogs));
      const two = await runCiShard({ ...input, jobs: 2 }, deps([]));
      expect([one.exitCode, two.exitCode]).toEqual([0, 0]);
      const expected = {
        't/a.test.ts': { tests: 3, pass: 2, fail: 0, skip: 1, todo: 0, expects: 3 },
        't/b.test.ts': { tests: 2, pass: 1, fail: 0, skip: 0, todo: 1, expects: 5 },
        't/c.test.ts': { tests: 1, pass: 1, fail: 0, skip: 0, todo: 0, expects: 1 },
        't/d.test.ts': { tests: 3, pass: 3, fail: 0, skip: 0, todo: 0, expects: 6 },
      };
      expect(one.result.outcome.counts).toMatchObject({ complete: true, files: expected, totals: { tests: 9, expects: 15 } });
      expect(two.result.outcome.counts).toEqual(one.result.outcome.counts);
      expect(two.result.subShards).toHaveLength(2);
      expect(one.result.outcome.summary).toEqual(two.result.outcome.summary);
      const bare = await runFreeShard(planned, 1, 1, { rootDir: root, quiet: true, log: () => {}, logFilePath: path.join(root, 'bare.log') });
      expect(bare.counts).toBeUndefined();
      const stream = (file: string) => fs.readFileSync(file, 'utf8').replace(/ \[[\d.]+m?s\]/g, '').split('\n').filter(line => !line.startsWith('[test:free]'));
      expect(stream(serialLogs[0])).toEqual(stream(path.join(root, 'bare.log')));
      for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }, 60_000);

  test('a hung sub-shard is killed at its wall while its sibling finishes, and no child outlives the parent', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-shard-jobs-')));
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const planned = ['t/ok.test.ts', 't/hang.test.ts'];
      for (const file of planned) {
        fs.mkdirSync(path.join(root, 't'), { recursive: true });
        fs.writeFileSync(path.join(root, file), "import { test, expect } from 'bun:test';\ntest('ok', () => { expect(1).toBe(1); });\n");
      }
      const plan = createFreeCiPlan(planned, 1, {}, 'rev');
      const outcomes: FreeShardOutcome[] = [];
      const startedAt = performance.now();
      const { result } = await runCiShard({ plan, shard: plan.shards[0], revision: 'rev', jobs: 2, wallTimeoutMs: 2_000, verbose: false, context }, {
        runShard: async (runFiles, n, total, options) => {
          const outcome = await runFreeShard(runFiles, n, total, { ...options, rootDir: root, quiet: true, log: () => {},
            ...(runFiles.includes('t/hang.test.ts') ? { commandFor: () => ({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] }) } : {}) });
          outcomes.push(outcome);
          return outcome;
        },
        retry: async () => ({ exitCode: 1, retry: null }),
        pack: packFiles => packFiles.map(file => [file]),
        isSerial: () => false,
        terminationRequested: () => false,
        log: () => {},
      });
      expect(performance.now() - startedAt).toBeLessThan(20_000);
      expect(result.outcome.status).toBe('timed-out');
      expect(result.subShards!.map(record => [record.files[0], record.status]).sort()).toEqual([['t/hang.test.ts', 'timed-out'], ['t/ok.test.ts', 'passed']]);
      for (const outcome of outcomes) expect(() => process.kill(outcome.groupPid!, 0)).toThrow();
      expect(errors.mock.calls.some(call => String(call[0]).includes('FREE_SUBSHARD_TIMEOUT'))).toBe(true);
    } finally { errors.mockRestore(); fs.rmSync(root, { recursive: true, force: true }); }
  }, 60_000);
});

describe('serial lists and the duration seed', () => {
  test('SLOW_UNDER_LOAD entries name live free files, a reason and a CI run id, and never overlap TREE_MUTATING', () => {
    const census = new Set(collectFreeTestFiles());
    for (const [file, entry] of Object.entries(SLOW_UNDER_LOAD)) {
      expect(census.has(file), `SLOW_UNDER_LOAD names ${file}, which is not a free test file`).toBe(true);
      expect(file in TREE_MUTATING).toBe(false);
      expect(entry.reason.trim()).not.toBe('');
      expect(entry.runId).toMatch(/^\d+(\/attempt \d+)?$/);
    }
  });

  test('seeds take only one-file children; sub-shard runs have no path to the seed writer', () => {
    expect(() => assertSoloSeedSample('test/a.test.ts', { files: ['test/a.test.ts'] })).not.toThrow();
    expect(() => assertSoloSeedSample('test/a.test.ts', { files: ['test/a.test.ts', 'test/b.test.ts'] })).toThrow(/one-file serial children/);
    expect(() => assertSoloSeedSample('test/a.test.ts', { files: ['test/a.test.ts'], summary: { testsRan: 9, filesRan: 2, sawTerminalSummary: true } })).toThrow(/one-file serial children/);
    expect(fs.readFileSync(path.join(ROOT, 'scripts/lib/shard-jobs.ts'), 'utf8')).not.toContain('writeDurationSeed');
    const runner = fs.readFileSync(path.join(ROOT, 'scripts/test-free-shards.ts'), 'utf8');
    const recorder = runner.slice(runner.indexOf('async function recordFreeTestDurations('), runner.indexOf('async function retryFailedFreeFiles('));
    expect(runner.split('writeDurationSeed(').length - 1).toBe(recorder.split('writeDurationSeed(').length - 1);
    expect(recorder).toContain('assertSoloSeedSample(file, outcome)');
  });

  test('the run context names the CI run and attempt, else local', () => {
    expect(ciRunContext('p.json', { GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '3', RUNNER_NAME: 'ubi-1' })).toMatchObject({ runId: '42/attempt 3', runner: expect.stringMatching(/^ubi-1 \(/) });
    expect(ciRunContext('p.json', {}).runId).toBe('local');
    expect(subShardTimeoutText(2, 4, { id: 'x:2.1', phase: 'parallel', files: ['test/a.test.ts'], status: 'timed-out', exitCode: null, elapsedMs: 1, failingFiles: [], unattributedFailures: 0 },
      [], 10_000, context)[1]).toContain('in flight: unknown');
    const serial = { id: 'x:2.5', phase: 'serial' as const, files: ['test/s.test.ts'], status: 'timed-out' as const, exitCode: null, elapsedMs: 1, failingFiles: [], unattributedFailures: 0 };
    const squeezed = subShardTimeoutText(2, 4, serial, [], 4_000, context, 360_000);
    expect(squeezed[0]).toContain('hit its 4s wall');
    expect(squeezed[4]).toContain('left this serial sub-shard 4s of the 360s shard wall');
    expect(subShardTimeoutText(2, 4, serial, [], 360_000, context, 360_000)[4]).toContain('already runs alone');
  });
});
