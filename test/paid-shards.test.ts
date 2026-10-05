/**
 * Pins the paid-tier sharded runner (scripts/test-paid-shards.ts).
 *
 * Two properties matter, and both are why the retired single-process
 * `test:gate` never finished a run:
 *   1. Enumeration + sharding — every file PAID_TEST_GLOBS expands to gets
 *      its own process, and tier exclusion only ever fires on explicit evidence.
 *   2. A spinning shard is killed externally and the run CONTINUES. The fake
 *      command here is a real busy loop, so an in-process timer could not save
 *      it — exactly the failure mode `sample` caught on the wedged run.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { E2E_TIERS, E2E_TOUCHFILES } from './helpers/touchfiles';

const ROOT = path.resolve(import.meta.dir, '..');
import {
  PAID_TEST_GLOBS,
  classifyPaidTestFile,
  collectPaidTestFiles,
  computePaidDiffSelection,
  diffSkipDecisionForFile,
  formatSummary,
  isAllSkippedPass,
  isPaidTestFile,
  knownTestNamesInSource,
  partitionShardsByDiffSelection,
  planPaidShards,
  runPaidShards,
  summarize,
  summaryExitCode,
  tierSkipReason,
  marathonSkipReason,
  CASE_SHARDED_FILES,
  CASE_TEST_NAMES,
  caseTestNamePattern,
  expandCaseShards,
  fileCaseRegistration,
  resolvePaidShardBudget,
  retriesForFiles,
  shardCaseId,
  shardFile,
  shardSlug,
  verifySliceResults,
  selectPaidTestFiles,
  buildRunManifest,
  parseRunManifest,
  classifyTrialShard,
  sliceExitCode,
  guardTrialRecords,
  parseJUnitCases,
  caseIdForTestName,
  shardTrial,
  excludedCasesNamePattern,
  runCaseDiagnosis,
  caseFile,
  caseSelection,
  afterRepairCommand,
  parseCliOptions,
  loadPaidTestDurations,
  shardDurationViolations,
  type CaseTrialPlan,
  type ShardOutcome,
} from '../scripts/test-paid-shards';

describe('paid test enumeration', () => {
  test('matches PAID_TEST_GLOBS', () => {
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
    expect(isPaidTestFile('test/paid-shards.test.ts')).toBe(false);
    // The 2026-08 orphan fix: these four were API-spending files OUTSIDE the
    // globs — self-skipping in the free suite and absent from the paid
    // census, so they could never run in any lane.
    expect(isPaidTestFile('test/codex-e2e-recommendation-substance.test.ts')).toBe(true);
    expect(isPaidTestFile('test/codex-e2e-plan-format.test.ts')).toBe(true);
    expect(isPaidTestFile('test/llm-judge-recommendation.test.ts')).toBe(true);
    expect(isPaidTestFile('test/carve-section-loading.test.ts')).toBe(true);
    expect(isPaidTestFile('test/skill-llm-eval-spec.test.ts')).toBe(true);
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

describe('tier lane skip (B5)', () => {
  const file = 'test/skill-e2e-sample.test.ts';
  const touchfiles = { 'sample-gate': [file, 'sample/**'], 'sample-periodic': [file], other: ['x/**'] };
  const tiers = { 'sample-gate': 'gate', 'sample-periodic': 'periodic', other: 'periodic' };
  const reg = { 'sample-gate': [file] } as Record<string, string[]>;

  test('a fully static file with only other-tier ids is skipped with its reason', () => {
    const source = "describeIfSelected('Sample', ['sample-gate'], () => { testIfSelected('sample-gate', async () => {}); });";
    expect(tierSkipReason(file, source, 'periodic', reg, tiers)).toBe('skipped: no E2E_TIERS id has tier periodic');
    expect(tierSkipReason(file, source, 'gate', reg, tiers)).toBeNull();
  });

  test('a comment or path that quotes another-tier id cannot change the decision', () => {
    const source = "// see 'other' and 'sample-periodic' for context\nconst dir = 'sample-periodic/fixtures';\n" +
      "testIfSelected('sample-gate', async () => {});";
    expect(tierSkipReason(file, source, 'periodic', reg, tiers)).toBe('skipped: no E2E_TIERS id has tier periodic');
    expect(tierSkipReason(file, source, 'gate', reg, tiers)).toBeNull();
  });

  test('computed registrations, unregistered literal ids and id-less files keep today\'s scheduling', () => {
    for (const source of [
      "describeIfSelected(name, keys, () => {});",
      "describeIfSelected('Sample', [...keys], () => {});",
      "testConcurrentIfSelected(`sample-${label}`, async () => {});",
      "runSkillTest({ testName: `sample-${label}` });",
      "testIfSelected(caseName, async () => {});",
    ]) expect(tierSkipReason(file, source, 'periodic', reg, tiers)).toBeNull();
    expect(tierSkipReason(file, "testIfSelected('sample-periodic', async () => {});", 'periodic', reg, tiers)).toBeNull();
    expect(tierSkipReason(file, "testIfSelected('sample-gate', async () => {});", 'periodic', {}, tiers)).toBeNull();
    expect(tierSkipReason(file, "testIfSelected('sample-gate', async () => {});", 'gate', touchfiles, tiers)).toBeNull();
  });

  test('a computed registration is skipped only when every id of the lane tier is registered to another test file', () => {
    const other = 'test/skill-e2e-other.test.ts';
    const owned = { 'sample-periodic': [file], 'gate-elsewhere': [other, 'x/**'] };
    const ownedTiers = { 'sample-periodic': 'periodic', 'gate-elsewhere': 'gate' };
    for (const source of [
      "testConcurrentIfSelected(`sample-${label}`, async () => {});",
      "runSkillTest({ testName: `sample-${label}` });",
      "for (const entry of CASES) describeIfSelected(entry.suite, [entry.id], () => { testIfSelected(entry.id, async () => {}); });",
    ]) {
      expect(tierSkipReason(file, source, 'gate', owned, ownedTiers)).toBe(
        'skipped: no E2E_TIERS id has tier gate (its computed names can only produce gate ids other test files register)');
      expect(tierSkipReason(file, source, 'periodic', owned, ownedTiers)).toBeNull();
      expect(tierSkipReason(file, source, 'gate', owned, { ...ownedTiers, 'gate-orphan': 'gate' })).toBeNull();
      expect(tierSkipReason(file, `${source}\ntestIfSelected('gate-elsewhere', async () => {});`, 'gate', owned, ownedTiers)).toBeNull();
    }
  });

  test('census files whose computed names hold only other-tier cases never take a runner (2026-10-03 census)', () => {
    const lanes = { gate: ['test/skill-e2e-plan-decision-classification.test.ts', 'test/skill-e2e-plan-devex-peer-comparison-classification.test.ts',
      'test/skill-e2e-qa-bugs.test.ts', 'test/skill-routing-e2e.test.ts'], periodic: ['test/skill-e2e-coverage-audit.test.ts', 'test/skill-e2e-test-value.test.ts'] };
    for (const [tier, files] of Object.entries(lanes) as Array<['gate' | 'periodic', string[]]>) {
      const { selected, excluded } = selectPaidTestFiles(collectPaidTestFiles(), tier, ROOT);
      for (const hollow of files) {
        expect(selected, hollow).not.toContain(hollow);
        expect(excluded.find(entry => entry.file === hollow)?.reason, hollow).toStartWith(`skipped: no E2E_TIERS id has tier ${tier}`);
      }
    }
  });

  test('the real constructed-name diagram file stays scheduled in both lanes', () => {
    const source = fs.readFileSync(path.join(ROOT, 'test/skill-e2e-diagram.test.ts'), 'utf8');
    for (const tier of ['gate', 'periodic'] as const) expect(tierSkipReason('test/skill-e2e-diagram.test.ts', source, tier)).toBeNull();
  });

  test('the weekly gate census alone drops the LLM judges, with the reason in the manifest', () => {
    const census = buildRunManifest({ tier: 'gate', sliceCount: 7, evalsAll: true, skipJudges: true, env: { EVALS_ALL: '1' } });
    const judge = census.entries.find(entry => entry.file === 'test/skill-llm-eval.test.ts');
    expect(judge).toMatchObject({ status: 'excluded', reason: 'skipped: LLM judges run in the periodic census and PR gate lanes' });
    for (const tier of ['gate', 'periodic'] as const) {
      const lane = buildRunManifest({ tier, sliceCount: 7, evalsAll: true, env: { EVALS_ALL: '1' } });
      expect(lane.entries.find(entry => entry.file === 'test/skill-llm-eval.test.ts')?.status).toBe('planned');
    }
    const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/evals-periodic.yml'), 'utf8');
    expect(workflow.match(/--skip-judges/g)).toHaveLength(1);
    expect(workflow).toMatch(/--tier gate --emit-plan \/tmp\/gate-census-plan\/manifest\.json --slice-budget 420 --jobs 2 --skip-judges/);
  });
});

describe('marathon tier lane', () => {
  const file = 'test/skill-e2e-sample.test.ts';
  const reg = { 'sample-gate': [file], 'sample-long': [file] } as Record<string, string[]>;
  const tiers = { 'sample-gate': 'gate', 'sample-long': 'marathon' };

  test('a marathon-declared file never enters the gate or periodic lane', () => {
    const source = "const describeE2E = describeE2ETier('marathon');";
    expect(classifyPaidTestFile(source, 'marathon')).toEqual({ included: true, reason: "declares tier 'marathon'" });
    for (const tier of ['gate', 'periodic'] as const) {
      expect(classifyPaidTestFile(source, tier)).toEqual({ included: false, reason: "declares tier 'marathon' only" });
    }
    expect(marathonSkipReason(file, source, {}, {})).toBeNull();
  });

  test('marathon selects positively: only declared files or files registering a marathon case', () => {
    expect(marathonSkipReason(file, "testIfSelected('sample-long', async () => {});", reg, tiers)).toBeNull();
    expect(marathonSkipReason(file, "testIfSelected(name, async () => {});", reg, tiers)).toBeNull();
    const gateOnly = { 'sample-gate': [file] };
    for (const source of ["testIfSelected('sample-gate', async () => {});", "testIfSelected(name, async () => {});", ''])
      expect(marathonSkipReason(file, source, gateOnly, tiers)).toBe('skipped: declares no marathon tier and registers no marathon case');
    const periodic = "const describeE2E = describeE2ETier('periodic');";
    expect(classifyPaidTestFile(periodic, 'marathon')).toEqual({ included: false, reason: "declares tier 'periodic' only" });
  });

  test('a marathon case that only depends on a file does not plan a hollow marathon shard there (W2f)', () => {
    // plan-decision-classification: its own case is periodic; the marathon split-overflow case lists it as a touchfile.
    const dependency = { 'sample-long': [file], 'sample-periodic': [file] };
    const withPeriodic = { ...tiers, 'sample-periodic': 'periodic' };
    const source = "const CASE_ID = 'sample-periodic'; testIfSelected(CASE_ID, async () => {});";
    expect(marathonSkipReason(file, source, dependency, withPeriodic)).toBe('skipped: declares no marathon tier and registers no marathon case');
    expect(selectPaidTestFiles(collectPaidTestFiles(), 'marathon').selected).not.toContain('test/skill-e2e-plan-decision-classification.test.ts');
  });

  test('a registered marathon case keeps its gate sibling scheduled in the gate lane', () => {
    const source = "testIfSelected('sample-gate', async () => {}); testIfSelected('sample-long', async () => {});";
    expect(tierSkipReason(file, source, 'gate', reg, tiers)).toBeNull();
    expect(tierSkipReason(file, source, 'periodic', reg, tiers)).toBe('skipped: no E2E_TIERS id has tier periodic');
  });

  test('the live marathon lane only plans files that carry marathon work, never the LLM judges', () => {
    const { selected, excluded } = selectPaidTestFiles(collectPaidTestFiles(), 'marathon');
    expect(selected).not.toContain('test/skill-llm-eval.test.ts');
    for (const file of selected) {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
      expect(marathonSkipReason(file, source), file).toBeNull();
    }
    expect(selected.length + excluded.length).toBe(collectPaidTestFiles().length);
  });
});

describe('PR-lane shard wall (I5)', () => {
  const census = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/paid-report-census/gate-census-durations.json'), 'utf8')).durations as Record<string, number>;
  const gateKeys = () => buildRunManifest({ tier: 'gate', sliceCount: 1, evalsAll: true, env: { EVALS_ALL: '1' } })
    .entries.filter(entry => entry.status === 'planned').map(entry => entry.file);

  test('no planned gate shard has a recorded wall over 600 s (committed seed and the last gate census)', () => {
    const keys = gateKeys();
    expect(keys.length).toBeGreaterThan(50);
    expect(shardDurationViolations(keys, loadPaidTestDurations(ROOT, 'gate'))).toEqual([]);
    expect(shardDurationViolations(keys, census)).toEqual([]);
  });

  test('the guard names an over-limit shard and its recorded wall; deploy runs one shard per case', () => {
    expect(shardDurationViolations(['test/skill-e2e-deploy.test.ts', 'test/skill-e2e-qa-workflow.test.ts'], census))
      .toEqual(['test/skill-e2e-deploy.test.ts: recorded 668s > 600s']);
    expect(shardDurationViolations(['test/a.test.ts#x~t2'], { 'test/a.test.ts#x': 612_000 })).toEqual(['test/a.test.ts#x~t2: recorded 612s > 600s']);
    expect(CASE_SHARDED_FILES).toContain('test/skill-e2e-deploy.test.ts');
    expect(gateKeys().filter(key => shardFile(key) === 'test/skill-e2e-deploy.test.ts').sort()).toEqual([
      'benchmark-workflow', 'canary-workflow', 'land-and-deploy-first-run', 'land-and-deploy-review-gate', 'land-and-deploy-workflow', 'setup-deploy-workflow',
    ].map(id => `test/skill-e2e-deploy.test.ts#${id}`));
  });
});

describe('case-sharded files', () => {
  // Paid cases only: `if (!evalsEnabled) test(...)` blocks are free checks.
  const caseNames = (source: string) => [...source.matchAll(
    /(?<![.\w])(?<!if \(!evalsEnabled\) )(?:testConcurrentIfSelected|testIfSelected|test(?:\.serial|\.concurrent)?)\(\s*(['"])(.+?)\1/g,
  )].map(match => match[2]!);

  for (const file of CASE_SHARDED_FILES) {
    test(`${file}: every Bun case is a registered E2E case, so every case gets a shard`, () => {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
      const { registered, known } = fileCaseRegistration(file, source);
      expect(known).toBe(true);
      expect(caseNames(source).sort()).toEqual(registered.map(id => CASE_TEST_NAMES[id] ?? id).sort());
      const keys = (['gate', 'periodic', 'marathon'] as const).flatMap(tier => expandCaseShards([file], tier));
      expect(keys.map(key => shardCaseId(key)).sort()).toEqual([...registered].sort());
      for (const key of keys) expect(shardFile(key)).toBe(file);
    });
  }

  test('every case in a case-sharded file has exactly one owner, so --case can select it', () => {
    for (const file of CASE_SHARDED_FILES) {
      const { registered } = fileCaseRegistration(file, fs.readFileSync(path.join(ROOT, file), 'utf8'));
      for (const id of registered) expect(caseFile(id), id).toBe(file);
    }
    expect(caseFile('plan-design-review-plan-mode')).toBe('test/skill-e2e-design.test.ts');
    expect(caseFile('plan-design-review-plan-mode-smoke')).toBe('test/skill-e2e-plan-design-plan-mode.test.ts');
    expect(() => caseFile('carve-section-loading')).toThrow(/no paid file statically registers it/);
    expect(caseFile('carve-section-loading-review')).toBe('test/carve-section-loading.test.ts');
  });

  test('a case key runs exactly its case: exact name pattern, own eval slug, per-case supervision', () => {
    const pattern = new RegExp(caseTestNamePattern(['design-review-detector-shim']));
    expect(pattern.test('Design review detector shim E2E design-review-detector-shim')).toBe(true);
    expect(pattern.test('Design review detector shim E2E design-review-detector-shim-dom')).toBe(false);
    expect(new RegExp(caseTestNamePattern(['plan-review-report'])).test('Plan Review Report E2E /plan-eng-review writes GSTACK REVIEW REPORT to plan file')).toBe(true);
    const key = 'test/skill-e2e-plan.test.ts#plan-ceo-review';
    expect(shardSlug([key])).toBe('skill-e2e-plan--plan-ceo-review');
    expect(shardSlug([key])).not.toBe(shardSlug(['test/skill-e2e-plan.test.ts#plan-eng-review']));
    expect(retriesForFiles([key])).toBe(retriesForFiles(['test/skill-e2e-plan.test.ts']));
    const whole = resolvePaidShardBudget(['test/skill-e2e-plan.test.ts']);
    const one = resolvePaidShardBudget([key]);
    expect(one.policyId).toBe(whole.policyId);
    expect(one.timeoutMs).toBeLessThan(whole.timeoutMs);
    expect(planPaidShards([key, 'test/skill-e2e-plan.test.ts#plan-eng-review', 'test/a.test.ts'], { maxFilesPerShard: 3 }))
      .toEqual([['test/a.test.ts'], [key], ['test/skill-e2e-plan.test.ts#plan-eng-review']]);
  });

  test('manifests plan each case once and results must execute exactly that case', () => {
    const manifest = buildRunManifest({ tier: 'gate', sliceBudgetMs: 540_000, jobs: 2, evalsAll: true, env: { EVALS_ALL: '1' } });
    const planned = manifest.entries.filter(entry => entry.status === 'planned');
    for (const file of CASE_SHARDED_FILES) {
      expect(planned.some(entry => entry.file === file)).toBe(false);
      const gateIds = Object.keys(E2E_TOUCHFILES).filter(id => E2E_TOUCHFILES[id]!.includes(file) && E2E_TIERS[id] === 'gate');
      expect(planned.filter(entry => shardFile(entry.file) === file).map(entry => shardCaseId(entry.file)).sort()).toEqual(gateIds.sort());
    }
    const results = Array.from({ length: manifest.sliceCount }, (_, i) => ({ version: 1 as const, tier: 'gate' as const, sliceIndex: i + 1, sliceCount: manifest.sliceCount,
      outcomes: planned.filter(entry => entry.slice === i + 1).map(entry => ({ files: [entry.file], status: 'passed' as const, exitCode: 0, elapsedMs: 1,
        executedTests: shardCaseId(entry.file) ? 3 : 1, skippedTests: shardCaseId(entry.file) ? 2 : 0, ...(entry.budget ? { budget: entry.budget } : {}) })) }));
    expect(verifySliceResults(manifest, results).problems.filter(problem => problem.includes('Case shard'))).toEqual([]);
    const empty = structuredClone(results);
    const victim = empty.flatMap(result => result.outcomes).find(outcome => shardCaseId(outcome.files[0]!))!;
    victim.skippedTests = victim.executedTests;
    expect(verifySliceResults(manifest, empty).problems).toContain(`Case shard must execute exactly its one case: ${victim.files[0]}`);
    const whole: any = structuredClone(manifest);
    whole.entries.push({ file: CASE_SHARDED_FILES[0], slice: 1, status: 'planned', estimatedMs: 1 });
    expect(() => parseRunManifest(JSON.stringify(whole))).toThrow('one registered case per shard');
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

  // PIN UPDATE (deliberate): the strict expectedFiles check is now enforced
  // for injected fake commands too (drift fix toward the free runner's
  // behavior), so a fake PASSING command must print a synthetic bun terminal
  // summary — a summary-less exit 0 is the truncation class and reads FAILED.
  const PASS_WITH_SUMMARY = 'console.log("ok"); console.log("Ran 1 tests across 1 files. [1ms]")';

  const commandFor = (files: string[]) => {
    if (files[0] === 'spin') return { command: process.execPath, args: ['-e', BUSY_LOOP] };
    if (files[0] === 'fail') return { command: process.execPath, args: ['-e', 'process.exit(3)'] };
    if (files[0] === 'silent-pass') return { command: process.execPath, args: ['-e', 'console.log("ok")'] };
    return { command: process.execPath, args: ['-e', PASS_WITH_SUMMARY] };
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
    // 90s, not the default 30s: this test spawns/kills three real children
    // (one a busy-loop burning a full core) while 5 sibling shard processes
    // compete for 8 vCPUs — observed blowing exactly the 30s ceiling at
    // 30009ms under full-suite load while passing in isolation in 1.4s.
    // Every assertion above is event-based; the only latency claim is the
    // <30s kill-deadline sanity bound, which stays.
  }, 90_000);

  test('exit 0 WITHOUT the terminal summary is FAILED — enforced for injected commands too', async () => {
    // The invisible-non-execution backstop: previously the paid runner
    // exempted injected commandFor from the expectedFiles check, so a fake
    // that exited 0 without bun's terminal summary recorded 'passed'. Now it
    // matches the free runner: enforcement always on.
    const summary = await runPaidShards([['silent-pass']], {
      timeoutMs: 30_000, jobs: 1, commandFor, log: () => {},
    });
    expect(summary.outcomes[0].status).toBe('failed');
  }, 30_000);

  test('shard output spools to a per-shard log file; failures name the path', async () => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paid-shard-logs-'));
    const lines: string[] = [];
    try {
      const summary = await runPaidShards([['fail'], ['pass']], {
        timeoutMs: 30_000, jobs: 2, commandFor, logDir, log: (line) => lines.push(line),
      });
      const byName = (name: string) => summary.outcomes.find((o) => o.files[0] === name) as ShardOutcome;
      expect(byName('fail').status).toBe('failed');
      expect(byName('pass').status).toBe('passed');

      // One log per shard, named by slug, and it holds the child's full stream
      // (nothing buffered in RAM: the file IS the record).
      const logs = fs.readdirSync(logDir).sort();
      expect(logs.length).toBe(2);
      expect(logs.some((f) => f.includes('fail'))).toBe(true);
      const passLog = logs.find((f) => f.includes('pass')) as string;
      expect(fs.readFileSync(path.join(logDir, passLog), 'utf8')).toContain('Ran 1 tests across 1 files.');

      // Every shard announces its log path up front; the FAILED terminal line
      // repeats it, the PASSED one stays clean.
      expect(lines.filter((l) => l.includes('full log:') && !l.includes('FAILED')).length).toBe(2);
      const failLine = lines.find((l) => l.includes('FAILED')) as string;
      expect(failLine).toContain(logDir);
      const passLine = lines.find((l) => l.includes('PASSED')) as string;
      expect(passLine).not.toContain(logDir);
    } finally {
      fs.rmSync(logDir, { recursive: true, force: true });
    }
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

// Green-by-skip census: "Ran N tests" counts skips, so a codex/gemini file
// whose every test self-skipped (binary absent on the runner) exits 0 and
// used to read as coverage in the weekly report. The census label keeps the
// pass (service availability is host state, not a repo regression) but must
// say the shard verified nothing.
describe('all-skipped pass census', () => {
  const base = { shard: 1, files: ['test/codex-e2e.test.ts'], exitCode: 0, elapsedMs: 1200, groupPid: 1 };

  test('isAllSkippedPass: pass with every test skipped → true', () => {
    expect(isAllSkippedPass({ ...base, status: 'passed', executedTests: 8, skippedTests: 8 } as ShardOutcome)).toBe(true);
  });

  test('isAllSkippedPass: real work, a failure, or no data → false', () => {
    // one test actually ran
    expect(isAllSkippedPass({ ...base, status: 'passed', executedTests: 8, skippedTests: 7 } as ShardOutcome)).toBe(false);
    // zero tests: that's the hollow-shard guard's territory, not this label's
    expect(isAllSkippedPass({ ...base, status: 'passed', executedTests: 0, skippedTests: 0 } as ShardOutcome)).toBe(false);
    // non-pass statuses never get the label
    expect(isAllSkippedPass({ ...base, status: 'failed', executedTests: 8, skippedTests: 8 } as ShardOutcome)).toBe(false);
    // stream gave no counts (crash/timeout) — unknown, not all-skipped
    expect(isAllSkippedPass({ ...base, status: 'passed', executedTests: null, skippedTests: null } as ShardOutcome)).toBe(false);
  });

  test('wiring: a real child’s skip recap flows through runPaidShard into skippedTests', async () => {
    // End-to-end through the actual spawn/classify path (not hand-built
    // outcomes): a fake shard child prints bun’s recap shape with every test
    // skipped; the outcome must carry the parsed counts and formatSummary
    // must label it. This is the seam the unit tests above skip.
    const ALL_SKIP = 'console.log(" 0 pass"); console.log(" 3 skip"); console.log(" 0 fail"); console.log("Ran 3 tests across 1 files. [5ms]")';
    const summary = await runPaidShards([['all-skip']], {
      timeoutMs: 30_000,
      jobs: 1,
      commandFor: () => ({ command: process.execPath, args: ['-e', ALL_SKIP] }),
      log: () => {},
    });
    const outcome = summary.outcomes[0];
    expect(outcome.status).toBe('passed');
    expect(outcome.executedTests).toBe(3);
    expect(outcome.skippedTests).toBe(3);
    expect(isAllSkippedPass(outcome)).toBe(true);
    const lines = formatSummary(summary);
    expect(lines.find((l) => l.includes('all-skip'))).toContain('all 3 tests SKIPPED');
  }, 30_000);

  test('formatSummary labels an all-skipped pass and leaves real passes alone', () => {
    const lines = formatSummary(summarize([
      { ...base, status: 'passed', executedTests: 8, skippedTests: 8 } as ShardOutcome,
      { shard: 2, files: ['test/skill-e2e-review.test.ts'], status: 'passed', exitCode: 0, elapsedMs: 900, groupPid: 2, executedTests: 3, skippedTests: 0 } as ShardOutcome,
    ]));
    const codexLine = lines.find((l) => l.includes('codex-e2e'));
    const reviewLine = lines.find((l) => l.includes('skill-e2e-review'));
    expect(codexLine).toContain('all 8 tests SKIPPED');
    expect(codexLine).toContain('verified nothing');
    expect(reviewLine).not.toContain('SKIPPED');
  });
});

describe('isolated trial shards: record, classification and slice exit', () => {
  const plan: CaseTrialPlan = { kind: 'behavior', panel: { n: 3, k: 2 }, quarantined: false };
  const key = (n: number) => `test/skill-e2e-review.test.ts#review-sql-injection~t${n}`;
  const base = { status: 'passed' as const, executedTests: 1, skippedTests: 0, elapsedMs: 5 };
  const none = { records: [], contract: null };

  test('trial keys keep their case id, file and index', () => {
    expect(shardCaseId(key(2))).toBe('review-sql-injection');
    expect(shardFile(key(2))).toBe('test/skill-e2e-review.test.ts');
    expect(shardTrial(key(2))).toBe(2);
    expect(shardTrial('test/skill-e2e-review.test.ts#review-sql-injection')).toBeNull();
    expect(shardSlug([key(2)])).toBe('skill-e2e-review--review-sql-injection.t2');
  });

  test('classification: verdicts versus harness problems', () => {
    const c = (over: Partial<ShardOutcome>, evidence: { records: any[]; contract: string | null } = none) =>
      classifyTrialShard({ ...base, ...over }, 'review-sql-injection', 1, plan, evidence);
    expect(c({}).outcome).toBe('passed');
    expect(c({}, { records: [], contract: 'handoff missing' })).toMatchObject({ outcome: 'failed', failure_class: 'contract', error: 'handoff missing' });
    expect(c({ status: 'failed' }, { records: [{ passed: false, exit_reason: 'timeout', timeout_at_turn: 9, error: 'x' }], contract: null }))
      .toMatchObject({ outcome: 'failed', failure_class: 'timeout', timeout_at_turn: 9 });
    expect(c({ status: 'failed' }, { records: [{ passed: false, error: 'expected 3' }], contract: null })).toMatchObject({ outcome: 'failed', failure_class: 'assertion' });
    expect(c({ status: 'timed-out', executedTests: null, skippedTests: null })).toMatchObject({ outcome: 'failed', failure_class: 'timeout' });
    expect(c({ status: 'failed', executedTests: null, skippedTests: null })).toMatchObject({ outcome: 'failed', failure_class: 'infra' });
    expect(c({ status: 'failed', executedTests: 0, skippedTests: 0 })).toMatchObject({ outcome: 'failed', failure_class: 'infra' });
    expect(c({ executedTests: 1, skippedTests: 1 })).toMatchObject({ outcome: 'skipped' });
    for (const over of [{ status: 'never-started' as const }, { status: 'passed-empty' as const }, { executedTests: 2 },
      { runnerError: 'spawn failed' }, { executedTests: 0, skippedTests: 0 }]) {
      expect(c(over).outcome, JSON.stringify(over)).toBeNull();
    }
  });

  test('classification adds cause, detail and ledger sessions; failure_class and outcome never change', () => {
    const sessions = [{ key: 'claude-p:review-sql-injection#1', runner: 'claude-p' as const, started_at: 't', budget_ms: 300_000, elapsed_ms: 300_100,
      end: 'session_timeout' as const, evidence: 'armed 300000ms session timeout fired', liveness: { partial: true, events: 9, turns: 2, max_request_silence_ms: 150_000 } }];
    const inputs: Array<[Partial<ShardOutcome>, { records: any[]; contract: string | null }]> = [
      [{}, none], [{}, { records: [], contract: 'handoff missing' }],
      [{ status: 'failed' }, { records: [{ passed: false, exit_reason: 'timeout', timeout_at_turn: 9, error: 'x' }], contract: null }],
      [{ status: 'failed' }, { records: [{ passed: false, exit_reason: 'success', error: 'expect(received).toBe(expected)\n\nExpected: 3\nReceived: 2\n' }], contract: null }],
      [{ status: 'timed-out', executedTests: null, skippedTests: null }, none],
      [{ status: 'failed', executedTests: null, skippedTests: null }, none],
    ];
    for (const [over, evidence] of inputs) {
      const before = classifyTrialShard({ ...base, ...over }, 'review-sql-injection', 1, plan, evidence);
      const after = classifyTrialShard({ ...base, ...over }, 'review-sql-injection', 1, plan, { ...evidence, sessions });
      expect([after.outcome, after.failure_class, after.error], JSON.stringify(over)).toEqual([before.outcome, before.failure_class, before.error]);
      expect(after.sessions).toEqual([{ key: 'claude-p:review-sql-injection#1', runner: 'claude-p', elapsed_ms: 300_100, budget_ms: 300_000, end: 'session_timeout' }]);
      expect(after.failure_cause === undefined).toBe(after.outcome !== 'failed');
    }
    const c = (over: Partial<ShardOutcome>, evidence: { records: any[]; contract: string | null; sessions?: any[] }) =>
      classifyTrialShard({ ...base, ...over }, 'review-sql-injection', 1, plan, evidence);
    expect(c({ status: 'failed' }, { records: [{ passed: false, exit_reason: 'success', error: 'expect(received).toBe(expected)\n\nExpected: 3\nReceived: 2\n' }], contract: null }))
      .toMatchObject({ failure_class: 'assertion', error: 'expect(received).toBe(expected)', failure_cause: 'assertion',
        failure_cause_evidence: 'session completed; check failed', failure_detail: { expected: '3', received: '2' } });
    expect(c({ status: 'failed' }, { records: [{ passed: false, exit_reason: 'timeout', error: 'Error: Claude Code process aborted by user' }], contract: null, sessions }))
      .toMatchObject({ failure_class: 'timeout', failure_cause: 'provider_stall' });
    expect(c({}, { records: [], contract: 'handoff missing', sessions })).toMatchObject({ failure_class: 'contract', failure_cause: 'contract', failure_cause_evidence: 'handoff missing' });
  });

  test('slice exit: rule shards stay strict; failed trials never red the runner, missing records do', () => {
    const trial = (outcome: 'passed' | 'failed' | null) => ({ status: outcome === 'failed' ? 'failed' as const : 'passed' as const,
      trial: { case: 'c', trial: 1, ...plan, outcome, cost_usd: 0, duration_ms: 1, ...(outcome === null ? { harness: 'never started' } : {}) } });
    expect(sliceExitCode([{ status: 'passed' }, trial('failed')])).toBe(0);
    expect(sliceExitCode([{ status: 'failed' }, trial('passed')])).toBe(1);
    expect(sliceExitCode([{ status: 'passed' }, trial(null)])).toBe(1);
    expect(sliceExitCode([{ status: 'timed-out' }])).toBe(1);
    const hollow = guardTrialRecords([{ ...trial('passed'), status: 'passed-empty' as const }]);
    expect(hollow[0]!.trial!.outcome).toBeNull();
    expect(sliceExitCode(hollow)).toBe(1);
  });

  test('runPaidShards binds each trial to its case, index and panel and records its outcome', async () => {
    const evalDirBase = fs.mkdtempSync(path.join(os.tmpdir(), 'trial-shards-'));
    try {
      const script = (fail: boolean) => `const fs = require('fs'), path = require('path');
const dir = process.env.GSTACK_EVAL_DIR; fs.mkdirSync(dir, { recursive: true });
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('GSTACK_EVAL_') || k === 'EVALS_SELECTION_JSON'));
fs.writeFileSync(path.join(dir, 'env.json'), JSON.stringify(env));
fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ tests: [{ name: 'review-sql-injection', passed: ${!fail}, cost_usd: 0.5,
  duration_ms: 1, exit_reason: ${fail ? "'timeout'" : "'success'"}, timeout_at_turn: 4, model: 'm' }] }));
console.log("Ran 1 tests across 1 files. [1ms]"); process.exit(${fail ? 1 : 0});`;
      const summary = await runPaidShards([[key(1)], [key(2)], [key(3)]], {
        jobs: 3, evalDirBase, log: () => {}, trials: { [key(1)]: plan, [key(2)]: plan, [key(3)]: plan },
        commandFor: files => ({ command: process.execPath, args: ['-e', script(files[0] === key(2))] }),
      });
      const byKey = (n: number) => summary.outcomes.find(o => o.files[0] === key(n))!;
      expect(byKey(1).trial).toMatchObject({ case: 'review-sql-injection', trial: 1, outcome: 'passed', cost_usd: 0.5, model: 'm' });
      expect(byKey(2).trial).toMatchObject({ trial: 2, outcome: 'failed', failure_class: 'timeout', exit_reason: 'timeout', timeout_at_turn: 4 });
      expect(sliceExitCode(summary.outcomes)).toBe(0);
      const env = JSON.parse(fs.readFileSync(path.join(evalDirBase, 'shards', shardSlug([key(3)]), 'env.json'), 'utf8'));
      expect(env).toMatchObject({ GSTACK_EVAL_CASE_ID: 'review-sql-injection', GSTACK_EVAL_KIND: 'behavior', GSTACK_EVAL_TRIAL: '3',
        GSTACK_EVAL_PANEL_N: '3', GSTACK_EVAL_PANEL_K: '2', GSTACK_EVAL_POLICY_VERSION: '2' });
      expect(JSON.parse(env.EVALS_SELECTION_JSON).selected).toEqual(['review-sql-injection']);
    } finally { fs.rmSync(evalDirBase, { recursive: true, force: true }); }
  });

  test('file shards exclude isolated names; JUnit cases map to registry ids or stay unattributed', () => {
    const pattern = new RegExp(excludedCasesNamePattern(['review-sql-injection']));
    expect(pattern.test('suite > review-sql-injection')).toBe(false);
    expect(pattern.test('suite > review-enum-completeness')).toBe(true);
    const cases = parseJUnitCases(`<testsuites><testsuite name="f">
  <testcase name="review-sql-injection" classname="s" time="1.5" />
  <testcase name="review-enum-completeness" classname="s" time="0.1"><failure type="TimeoutError" message="test &amp; timed out" /></testcase>
  <testcase name="plain helper" classname="" time="0"><skipped /></testcase>
</testsuite></testsuites>`);
    expect(cases).toEqual([
      { name: 'review-sql-injection', classname: 's', outcome: 'passed', timeMs: 1500 },
      { name: 'review-enum-completeness', classname: 's', outcome: 'failed', timeMs: 100, failureType: 'TimeoutError', message: 'test & timed out' },
      { name: 'plain helper', classname: '', outcome: 'skipped', timeMs: 0 },
    ]);
    expect(caseIdForTestName('review-sql-injection')).toBe('review-sql-injection');
    expect(caseIdForTestName(CASE_TEST_NAMES['plan-review-report']!)).toBe('plan-review-report');
    expect(caseIdForTestName('plain helper')).toBeNull();
  });

  test('--case/--trials: local diagnosis flags are validated and never combine with CI modes', () => {
    expect(parseCliOptions(['--case', 'review-sql-injection', '--trials', '5'], {})).toMatchObject({ caseId: 'review-sql-injection', trials: 5 });
    expect(() => parseCliOptions(['--trials', '3'], {})).toThrow('--trials requires --case');
    expect(() => parseCliOptions(['--case', 'no-such-case'], {})).toThrow('live E2E case id');
    expect(() => parseCliOptions(['--case', 'review-sql-injection', '--report', '/tmp/r'], {})).toThrow('local diagnosis');
    expect(caseFile('review-sql-injection')).toBe('test/skill-e2e-review.test.ts');
  });

  test('B4: every registered E2E case resolves to exactly itself, loop-registered cases included', () => {
    const unresolved: string[] = [];
    for (const id of Object.keys(E2E_TIERS)) {
      let selection: ReturnType<typeof caseSelection>;
      try { selection = caseSelection(id); } catch (error) { unresolved.push(`${id}: ${(error as Error).message}`); continue; }
      const { registered, computed } = fileCaseRegistration(selection.file, fs.readFileSync(path.join(ROOT, selection.file), 'utf8'));
      expect(registered, id).toContain(id);
      if (selection.mode === 'file') expect(registered, id).toEqual([id]);
      else expect(computed || fs.readFileSync(path.join(ROOT, selection.file), 'utf8').includes(CASE_TEST_NAMES[id] ?? id), id).toBe(true);
    }
    expect(unresolved).toEqual([]);
    expect(caseSelection('plan-mode-no-op')).toEqual({ file: 'test/skill-e2e-plan-mode-no-op.test.ts', mode: 'file', reason: 'the whole file (it registers no other case)' });
    expect(caseSelection('review-coverage-audit')).toMatchObject({ file: 'test/skill-e2e-coverage-audit.test.ts', mode: 'name' });
    expect(caseSelection('plan-eng-multi-finding-batching').file).toBe('test/skill-e2e-plan-eng-multi-finding-batching.test.ts');
    expect(caseSelection('review-sql-injection')).toMatchObject({ file: 'test/skill-e2e-review.test.ts', mode: 'name' });
    // A single-case file runs whole even when a session option carries the case id (testName: 'office-hours-section-loading').
    expect(caseSelection('office-hours-section-loading')).toMatchObject({ file: 'test/skill-e2e-office-hours-section-loading.test.ts', mode: 'file' });
    // The report's after-a-repair command selects exactly one case: --case when it resolves, else that shard's file.
    expect(afterRepairCommand('gate', 'plan-mode-no-op', 'test/skill-e2e-plan-mode-no-op.test.ts')).toBe('bun run scripts/test-paid-shards.ts --tier gate --case plan-mode-no-op');
    expect(afterRepairCommand('periodic', 'carve-section-loading', 'test/carve-section-loading-qa.test.ts')).toBe('EVALS=1 EVALS_TIER=periodic bun test test/carve-section-loading-qa.test.ts');
  });

  test('B4: --list prints the selection; an unknown id exits non-zero before any process starts', () => {
    const run = (args: string[]) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/test-paid-shards.ts'), ...args], { encoding: 'utf8', timeout: 60_000, cwd: ROOT });
    const listed = run(['--tier', 'gate', '--case', 'plan-mode-no-op', '--list']);
    expect(listed.status, listed.stderr).toBe(0);
    expect(listed.stdout).toContain('--case plan-mode-no-op: 1 trial(s) of test/skill-e2e-plan-mode-no-op.test.ts (kind rule), selects the whole file (it registers no other case), list only');
    const unknown = run(['--tier', 'gate', '--case', 'no-such-case']);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain('--case needs a live E2E case id. Received: no-such-case');
    expect(unknown.stdout).not.toContain('shard');
  });

  test('the --case CLI starts its trial shards (it hands runCaseDiagnosis its own runner)', () => {
    // A dynamic import of scripts/test-paid-shards.ts while it is still in its top-level await never resolves,
    // so the CLI hung after its first line. The trial is killed at its 1 s wall and cannot reach a model.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'case-cli-'));
    try {
      const run = spawnSync(process.execPath, [path.join(ROOT, 'scripts/test-paid-shards.ts'), '--tier', 'gate', '--case', 'review-sql-injection', '--trials', '1', '--timeout', '1'], {
        encoding: 'utf8', timeout: 60_000, cwd: ROOT,
        env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, TMPDIR: home, EVALS_PREFLIGHT_OK: '1', GSTACK_EVAL_DIR: path.join(home, 'evals'), EVALS_RUN_ID: 'case-cli-start' } });
      expect(run.error).toBeUndefined();
      expect(run.stdout).toContain('[test:paid] shard 1/1 START test/skill-e2e-review.test.ts#review-sql-injection~t1');
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }, 70_000);

  test('B4: a whole-file case runs one file shard per trial and judges each by shard status', async () => {
    const evalDirBase = fs.mkdtempSync(path.join(os.tmpdir(), 'case-file-diagnosis-'));
    const lines: string[] = [];
    let call = 0;
    try {
      const verdict = await runCaseDiagnosis('plan-mode-no-op', { trials: 2, evalDirBase, log: line => lines.push(line),
        commandFor: files => { call++; expect(files).toEqual(['test/skill-e2e-plan-mode-no-op.test.ts']);
          return { command: process.execPath, args: ['-e', `console.log("Ran 5 tests across 1 files. [1ms]"); process.exit(${call === 2 ? 1 : 0});`] }; } });
      expect(call).toBe(2);
      expect(verdict).toMatchObject({ case: 'plan-mode-no-op', kind: 'rule', panel: { n: 2, k: 2 }, passed: 1, status: 'FAIL' });
      expect(lines.join('\n')).toContain('FAIL 1/2 (✓✗)');
    } finally { fs.rmSync(evalDirBase, { recursive: true, force: true }); }
  });

  test('--case runs the CI panel runner and prints its panelVerdict', async () => {
    const evalDirBase = fs.mkdtempSync(path.join(os.tmpdir(), 'case-diagnosis-'));
    const lines: string[] = [];
    try {
      const verdict = await runCaseDiagnosis('review-sql-injection', { trials: 3, evalDirBase, log: line => lines.push(line), jobs: 3,
        commandFor: files => ({ command: process.execPath, args: ['-e',
          `console.log("Ran 1 tests across 1 files. [1ms]"); process.exit(${files[0]!.endsWith('~t3') ? 1 : 0});`] }) });
      // A rule case keeps its meaning locally: every trial must pass.
      expect(verdict).toMatchObject({ case: 'review-sql-injection', kind: 'rule', panel: { n: 3, k: 3 }, passed: 2, status: 'FAIL' });
      expect(lines.join('\n')).toContain('--case review-sql-injection: 3 trial(s) of test/skill-e2e-review.test.ts');
      expect(lines.join('\n')).toContain('FAIL 2/3 (✓✓✗)');
    } finally { fs.rmSync(evalDirBase, { recursive: true, force: true }); }
  });
});
