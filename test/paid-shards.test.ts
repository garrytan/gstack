/**
 * Pins the paid-tier sharded runner (scripts/test-paid-shards.ts).
 *
 * Two properties matter, and both are why `test:gate` has never finished a run:
 *   1. Enumeration + sharding — every file `test:gate`'s globs expand to gets
 *      its own process, and tier exclusion only ever fires on explicit evidence.
 *   2. A spinning shard is killed externally and the run CONTINUES. The fake
 *      command here is a real busy loop, so an in-process timer could not save
 *      it — exactly the failure mode `sample` caught on the wedged run.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
import {
  PAID_TEST_GLOBS,
  classifyPaidTestFile,
  collectPaidTestFiles,
  computePaidDiffSelection,
  diffSkipDecisionForFile,
  formatSummary,
  isPaidTestFile,
  knownTestNamesInSource,
  partitionShardsByDiffSelection,
  planPaidShards,
  runPaidShards,
  summarize,
  summaryExitCode,
  type ShardOutcome,
} from '../scripts/test-paid-shards';

describe('paid test enumeration', () => {
  test('matches the globs package.json test:gate expands', () => {
    expect(isPaidTestFile('test/skill-e2e-qa-workflow.test.ts')).toBe(true);
    expect(isPaidTestFile('test/skill-llm-eval.test.ts')).toBe(true);
    expect(isPaidTestFile('test/codex-e2e.test.ts')).toBe(true);
    expect(isPaidTestFile('test/codex-e2e-sol-scope.test.ts')).toBe(true);
    expect(isPaidTestFile('test/skill-e2e-triage-audit.test.ts')).toBe(true);
    // Outside the globs: no dash, extra suffix, or a free test.
    // 'test/skill-e2e.test.ts' is the DELETED pre-split monolith's name,
    // kept here as a regression pin: its glob-invisibility is exactly how
    // two gate tests went unexecuted for ~8 releases before the rehoming.
    expect(isPaidTestFile('test/skill-e2e.test.ts')).toBe(false);
    expect(isPaidTestFile('test/codex-e2e-recommendation-substance.test.ts')).toBe(false);
    expect(isPaidTestFile('test/paid-shards.test.ts')).toBe(false);
  });

  test('discovers files and gives each one its own shard', () => {
    const files = collectPaidTestFiles();
    expect(files.length).toBeGreaterThan(0);
    expect(files.every(isPaidTestFile)).toBe(true);
    expect(PAID_TEST_GLOBS.length).toBe(6);

    const shards = planPaidShards(files);
    expect(shards.flat().sort()).toEqual([...files].sort());
    expect(shards.every((shard) => shard.length === 1)).toBe(true);
  });
});

describe('tier classification', () => {
  test('excludes only on an explicit other-tier guard', () => {
    const gateGuard = "const shouldRun = !!process.env.EVALS && process.env.EVALS_TIER === 'gate';";
    const periodicGuard = "const shouldRun = !!process.env.EVALS && process.env.EVALS_TIER === 'periodic';";

    expect(classifyPaidTestFile(gateGuard, 'gate').included).toBe(true);
    expect(classifyPaidTestFile(periodicGuard, 'gate').included).toBe(false);
    expect(classifyPaidTestFile(gateGuard, 'periodic').included).toBe(false);
    expect(classifyPaidTestFile(periodicGuard, 'periodic').included).toBe(true);
  });

  test('recognizes the consolidated e2e-gate helper guard (both forms)', () => {
    // The shape test/helpers/e2e-gate.ts consumers use after consolidation.
    const helperGate = "const describeE2E = describeE2ETier('gate');";
    const helperPeriodic = "const describeE2E = describeE2ETier('periodic');";
    const boolPeriodic = "const shouldRun = CODEX_AVAILABLE && e2eTierEnabled('periodic');";

    expect(classifyPaidTestFile(helperGate, 'gate').included).toBe(true);
    expect(classifyPaidTestFile(helperGate, 'periodic').included).toBe(false);
    expect(classifyPaidTestFile(helperPeriodic, 'periodic').included).toBe(true);
    expect(classifyPaidTestFile(helperPeriodic, 'gate').included).toBe(false);
    expect(classifyPaidTestFile(boolPeriodic, 'gate').included).toBe(false);
    expect(classifyPaidTestFile(boolPeriodic, 'periodic').included).toBe(true);
  });

  test('keeps files whose tier is decided per-test at runtime', () => {
    // Naming an E2E_TIERS key is not evidence — 'retro' appears in the
    // LLM-judge file, which test:gate does run.
    const noGuard = "runSkillTest('retro', async () => {});";
    expect(classifyPaidTestFile(noGuard, 'gate').included).toBe(true);
    expect(classifyPaidTestFile(noGuard, 'periodic').included).toBe(true);
    expect(classifyPaidTestFile('', 'gate').included).toBe(true);
  });

  test('the REAL external-CLI test files classify as periodic-only', () => {
    // Synthetic guard shapes above can drift from the actual files — the
    // inert-demotion defect class. Pin the real sources: a guard-shape edit
    // in either file that silently runs it in gate fails here.
    for (const file of ['test/codex-e2e.test.ts', 'test/codex-e2e-sol-scope.test.ts']) {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
      expect(classifyPaidTestFile(source, 'gate').included, `${file} leaked into gate tier`).toBe(false);
      expect(classifyPaidTestFile(source, 'periodic').included, `${file} dropped from periodic tier`).toBe(true);
    }
  });
});

describe('shard execution', () => {
  const BUSY_LOOP = 'const end = Date.now() + 600000; while (Date.now() < end) {}';

  const commandFor = (files: string[]) => {
    if (files[0] === 'spin') return { command: process.execPath, args: ['-e', BUSY_LOOP] };
    if (files[0] === 'fail') return { command: process.execPath, args: ['-e', 'process.exit(3)'] };
    return { command: process.execPath, args: ['-e', 'console.log("ok")'] };
  };

  test('a spinning shard times out, is killed, and the run continues', async () => {
    const lines: string[] = [];
    const summary = await runPaidShards([['spin'], ['fail'], ['pass']], {
      timeoutMs: 1_200,
      jobs: 1,
      commandFor,
      log: (line) => lines.push(line),
    });

    const byName = (name: string) => summary.outcomes.find((o) => o.files[0] === name) as ShardOutcome;
    expect(byName('spin').status).toBe('timed-out');
    expect(byName('fail').status).toBe('failed');
    expect(byName('pass').status).toBe('passed');

    // The run never aborted: every shard reports, none is 'never-started'.
    expect(summary).toMatchObject({
      total: 3, executed: 3, passed: 1, failed: 1, timedOut: 1, neverStarted: 0,
    });

    // The spinner was killed at the deadline, not left to burn a core.
    expect(byName('spin').elapsedMs).toBeLessThan(30_000);
    expect(byName('spin').groupPid).toBeGreaterThan(0);
    if (process.platform !== 'win32') {
      expect(() => process.kill(byName('spin').groupPid as number, 0)).toThrow();
    }

    // Heartbeat: a START and a terminal line per shard, with elapsed seconds.
    expect(lines.filter((l) => l.includes(' START ')).length).toBe(3);
    expect(lines.some((l) => /TIMED-OUT in \d+s/.test(l))).toBe(true);
    expect(lines.some((l) => /PASSED in \d+s/.test(l))).toBe(true);
  }, 30_000);

  test('summarize reports shards that never ran', () => {
    const summary = summarize([
      { shard: 1, files: ['a'], status: 'passed', exitCode: 0, elapsedMs: 1, groupPid: 1 },
      { shard: 2, files: ['b'], status: 'never-started', exitCode: null, elapsedMs: 0, groupPid: null },
    ]);
    expect(summary).toMatchObject({ total: 2, executed: 1, passed: 1, neverStarted: 1 });
  });
});

describe('parent-side diff shard skipping', () => {
  const ALL_NAMES = ['alpha-test', 'beta-test', 'gamma-registered'];
  const TOUCHFILES: Record<string, string[]> = {
    'alpha-test': ['a/**'],
    'beta-test': ['b/**'],
    'gamma-registered': ['g/**', 'test/skill-e2e-gamma.test.ts'],
  };
  const SOURCES: Record<string, string> = {
    'test/skill-e2e-alpha.test.ts': "runSkillTest('alpha-test', async () => {});",
    'test/skill-e2e-beta.test.ts': 'describeIfSelected("beta", ["beta-test"], () => {});',
    // Constructed testName — invisible by quotes, mapped only via registration.
    'test/skill-e2e-gamma.test.ts': 'const name = buildName(); test(name, async () => {});',
    // No recognizable names, no registration — the fail-open class.
    'test/skill-e2e-opaque.test.ts': "const shouldRun = process.env.EVALS_TIER === 'periodic';",
    'test/codex-e2e.test.ts': 'codex tests keyed off CODEX_E2E_TOUCHFILES',
  };
  const opts = {
    readSource: (file: string) => {
      if (!(file in SOURCES)) throw new Error(`unreadable: ${file}`);
      return SOURCES[file];
    },
    allNames: ALL_NAMES,
    e2eTouchfiles: TOUCHFILES,
  };

  test('knownTestNamesInSource matches only exact quoted strings', () => {
    expect(knownTestNamesInSource("x 'alpha-test' y", ['alpha-test', 'beta-test'])).toEqual(['alpha-test']);
    expect(knownTestNamesInSource('x "beta-test" y', ['alpha-test', 'beta-test'])).toEqual(['beta-test']);
    expect(knownTestNamesInSource('`alpha-test`', ['alpha-test'])).toEqual(['alpha-test']);
    // Substring inside a longer quoted string is not a hit.
    expect(knownTestNamesInSource("'alpha-test-extended'", ['alpha-test'])).toEqual([]);
  });

  test('selected name in file → shard kept', () => {
    const d = diffSkipDecisionForFile('test/skill-e2e-alpha.test.ts', new Set(['alpha-test']), opts);
    expect(d.kept).toBe(true);
    expect(d.reason).toContain('alpha-test');
  });

  test('no selected names in file → skipped-by-diff', () => {
    const d = diffSkipDecisionForFile('test/skill-e2e-beta.test.ts', new Set(['alpha-test']), opts);
    expect(d.kept).toBe(false);
    expect(d.reason).toContain('mapped test(s)');
  });

  test('dep-list registration maps files with constructed test names', () => {
    const selected = diffSkipDecisionForFile('test/skill-e2e-gamma.test.ts', new Set(['gamma-registered']), opts);
    expect(selected.kept).toBe(true);
    const unselected = diffSkipDecisionForFile('test/skill-e2e-gamma.test.ts', new Set(['alpha-test']), opts);
    expect(unselected.kept).toBe(false);
  });

  test('FAIL-OPEN: unmapped file kept, child self-skip authoritative', () => {
    const d = diffSkipDecisionForFile('test/skill-e2e-opaque.test.ts', new Set(['alpha-test']), opts);
    expect(d.kept).toBe(true);
    expect(d.reason).toContain('fail-open');
  });

  test('FAIL-OPEN: unreadable source kept', () => {
    const d = diffSkipDecisionForFile('test/skill-e2e-missing.test.ts', new Set(['alpha-test']), opts);
    expect(d.kept).toBe(true);
    expect(d.reason).toContain('fail-open');
  });

  test('FAIL-OPEN: non-skill-e2e paid files always kept', () => {
    const d = diffSkipDecisionForFile('test/codex-e2e.test.ts', new Set(['alpha-test']), opts);
    expect(d.kept).toBe(true);
    expect(d.reason).toContain('non-skill-e2e');
  });

  test('run-all selection (null) bypasses skipping entirely', () => {
    const shards = [['test/skill-e2e-alpha.test.ts'], ['test/skill-e2e-beta.test.ts']];
    const { runnable, skipped } = partitionShardsByDiffSelection(shards, null, opts);
    expect(runnable).toEqual(shards);
    expect(skipped).toEqual([]);
  });

  test('EVALS_ALL=1 yields run-all selection (no git consulted)', () => {
    const selection = computePaidDiffSelection({ EVALS_ALL: '1' } as NodeJS.ProcessEnv);
    expect(selection.selectedNames).toBeNull();
    expect(selection.reason).toContain('EVALS_ALL=1');
    expect(selection.totalTests).toBeGreaterThan(0);
  });

  test('partition drops only all-skippable shards', () => {
    const shards = [
      ['test/skill-e2e-alpha.test.ts'],
      ['test/skill-e2e-beta.test.ts'],
      ['test/skill-e2e-opaque.test.ts'],
      ['test/codex-e2e.test.ts'],
    ];
    const { runnable, skipped } = partitionShardsByDiffSelection(shards, new Set(['alpha-test']), opts);
    expect(runnable).toEqual([
      ['test/skill-e2e-alpha.test.ts'],
      ['test/skill-e2e-opaque.test.ts'],
      ['test/codex-e2e.test.ts'],
    ]);
    expect(skipped.length).toBe(1);
    expect(skipped[0].files).toEqual(['test/skill-e2e-beta.test.ts']);
  });

  test('taxonomy: skipped-by-diff counted separately, never conflated with never-started', () => {
    const summary = summarize([
      { shard: 1, files: ['a'], status: 'passed', exitCode: 0, elapsedMs: 1, groupPid: 1 },
      { shard: 2, files: ['b'], status: 'skipped-by-diff', exitCode: null, elapsedMs: 0, groupPid: null },
      { shard: 3, files: ['c'], status: 'never-started', exitCode: null, elapsedMs: 0, groupPid: null },
    ]);
    expect(summary).toMatchObject({
      total: 3, executed: 1, passed: 1, skippedByDiff: 1, neverStarted: 1,
    });
    const lines = formatSummary(summary);
    expect(lines[1]).toContain('1 skipped by diff');
    expect(lines[1]).toContain('1 never started');
    expect(lines.some((l) => l.includes('skipped-by-diff') && l.includes('b'))).toBe(true);
  });

  test('exit code ignores skipped-by-diff shards (they are successes)', () => {
    const allGood = summarize([
      { shard: 1, files: ['a'], status: 'passed', exitCode: 0, elapsedMs: 1, groupPid: 1 },
      { shard: 2, files: ['b'], status: 'skipped-by-diff', exitCode: null, elapsedMs: 0, groupPid: null },
    ]);
    expect(summaryExitCode(allGood)).toBe(0);

    const withFailure = summarize([
      { shard: 1, files: ['a'], status: 'failed', exitCode: 1, elapsedMs: 1, groupPid: 1 },
      { shard: 2, files: ['b'], status: 'skipped-by-diff', exitCode: null, elapsedMs: 0, groupPid: null },
    ]);
    expect(summaryExitCode(withFailure)).toBe(1);

    const withNeverStarted = summarize([
      { shard: 1, files: ['a'], status: 'never-started', exitCode: null, elapsedMs: 0, groupPid: null },
      { shard: 2, files: ['b'], status: 'skipped-by-diff', exitCode: null, elapsedMs: 0, groupPid: null },
    ]);
    expect(summaryExitCode(withNeverStarted)).toBe(1);
  });
});
