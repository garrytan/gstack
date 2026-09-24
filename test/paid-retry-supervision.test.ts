import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildPaidShardArgs, buildRunManifest, parseRunManifest, planPaidShards,
  DEFAULT_JOBS, parseCliOptions, paidShardWallUpperBoundMs, resolvePaidShardBudget, retriesForFiles, verifySliceResults,
} from '../scripts/test-paid-shards';
import {
  ALL_TIERS, AUQ_CONSISTENCY_RETRY_BUDGET, FILE_RETRY_BUDGETS,
  FINDING_RETRY_BUDGETS, STRICT_RETRY_CASE_BUDGETS,
} from './helpers/eval-budgets';

const read = (file: string) => readFileSync(join(import.meta.dir, '..', file), 'utf8');
const newBudgets = FILE_RETRY_BUDGETS.filter(row => !FINDING_RETRY_BUDGETS.some(old => old.file === row.file));
const expectedWalls = {
  'test/skill-llm-eval.test.ts': 6_660_000,
  'test/skill-e2e-auq-consistency.test.ts': 2_040_000,
  'test/codex-e2e-plan-format.test.ts': 5_000_000,
  'test/skill-e2e-auq-matrix.test.ts': 3_720_000,
  'test/skill-e2e-plan-format.test.ts': 2_600_000,
  'test/skill-e2e-auto-decide-preserved.test.ts': 1_920_000,
  'test/skill-e2e-plan-ceo-finding-floor.test.ts': 1_920_000,
  'test/skill-e2e-plan-eng-finding-floor.test.ts': 1_920_000,
  'test/skill-e2e-plan-design-finding-floor.test.ts': 1_920_000,
  'test/skill-e2e-plan-devex-finding-floor.test.ts': 1_920_000,
  'test/skill-e2e-plan-mode-no-op.test.ts': 9_120_000,
  'test/skill-e2e-plan-ceo-mode-routing.test.ts': 2_520_000,
  'test/skill-e2e-plan-eng-plan-mode.test.ts': 2_520_000,
  'test/skill-e2e-plan-prosons.test.ts': 2_600_000,
  'test/skill-e2e-plan.test.ts': 7_320_000,
};

test('registration covers exactly the fifteen demonstrated full-file retry gaps', () => {
  expect(Object.fromEntries(newBudgets.map(row => [row.file, row.shardMs]))).toEqual(expectedWalls);
  expect(new Set(FILE_RETRY_BUDGETS.map(row => row.file)).size).toBe(21);
  expect(STRICT_RETRY_CASE_BUDGETS.map(row => row.file)).toEqual([
    ...FINDING_RETRY_BUDGETS.map(row => row.file), AUQ_CONSISTENCY_RETRY_BUDGET.file,
  ]);
});

// Read the actual registration expressions without importing paid callbacks.
// This catches changed case allowances/counts, not just duplicated wall formulas.
const timeoutExpressions = (file: string) => [...read(file).matchAll(
  /}\s*,\s*((?:CAPTURE(?:_LONG)?|PTY)_MS(?:\s*\+\s*OFFICE_HOURS_BUN_GRACE_MS)?)\s*,?\s*\);/g,
)].map(match => match[1]!.replace(/\s+/g, ' '));

test('source allowances retain all captures, cases, and finalization grace', () => {
  const auq = read(AUQ_CONSISTENCY_RETRY_BUDGET.file);
  expect(auq).toContain("const N_RUNS = Number(process.env.AUQ_CONSISTENCY_RUNS ?? '3')");
  expect(auq).toContain('for (let i = 0; i < N_RUNS; i++)');
  expect(auq).toContain('N_RUNS * CAPTURE_MS + 60_000');
  expect(AUQ_CONSISTENCY_RETRY_BUDGET.testMs).toBe(960_000);
  expect(timeoutExpressions('test/codex-e2e-plan-format.test.ts')).toEqual(Array(4).fill('CAPTURE_LONG_MS'));
  expect(read('test/codex-e2e-plan-format.test.ts')).toContain('test(name, fn, timeout + CODEX_EVAL_FINALIZE_MS)');
  expect(read('test/helpers/codex-eval.ts')).toContain('CODEX_EVAL_FINALIZE_MS = 2 * CODEX_DRAIN_GRACE_MS');
  expect(read('test/helpers/codex-session-runner.ts')).toMatch(/CODEX_DRAIN_GRACE_MS\s*=\s*5_000/);
  expect(read('test/helpers/office-hours-attempt.ts')).toContain('OFFICE_HOURS_BUN_GRACE_MS = 10_000');
  for (const file of ['auto-decide-preserved', 'plan-ceo-finding-floor', 'plan-eng-finding-floor', 'plan-design-finding-floor', 'plan-devex-finding-floor']) {
    expect(timeoutExpressions(`test/skill-e2e-${file}.test.ts`)).toEqual(['PTY_MS']);
    if (file.endsWith('-finding-floor')) expect(read(`test/skill-e2e-${file}.test.ts`)).toContain('timeoutMs: CAPTURE_LONG_MS');
  }
  const noop = read('test/skill-e2e-plan-mode-no-op.test.ts');
  expect(noop).toContain("['plan-ceo-review', 'plan-eng-review', 'plan-design-review'] as const");
  expect(noop).toContain("['plan-eng-review', 'plan-design-review'] as const");
  expect(timeoutExpressions('test/skill-e2e-plan-mode-no-op.test.ts')).toEqual(Array(2).fill('CAPTURE_LONG_MS'));
  expect(read('test/skill-e2e-plan-ceo-mode-routing.test.ts').match(/^\s*{ mode: '/gm)).toHaveLength(2);
  expect(timeoutExpressions('test/skill-e2e-plan-ceo-mode-routing.test.ts')).toEqual(['CAPTURE_LONG_MS']);
  expect(timeoutExpressions('test/skill-e2e-plan-eng-plan-mode.test.ts')).toEqual(Array(2).fill('CAPTURE_LONG_MS'));
  expect(timeoutExpressions('test/skill-e2e-plan-prosons.test.ts')).toEqual(Array(4).fill('CAPTURE_MS + OFFICE_HOURS_BUN_GRACE_MS'));
  expect(timeoutExpressions('test/skill-e2e-plan-format.test.ts')).toEqual(Array(4).fill('CAPTURE_MS + OFFICE_HOURS_BUN_GRACE_MS'));
  expect(read('test/skill-e2e-auq-matrix.test.ts').match(/^    skill: '/gm)).toHaveLength(6);
  expect(timeoutExpressions('test/skill-e2e-auq-matrix.test.ts')).toEqual(['CAPTURE_MS']);
  expect(timeoutExpressions('test/skill-e2e-plan.test.ts')).toEqual([
    'PTY_MS', 'PTY_MS', 'CAPTURE_LONG_MS', 'CAPTURE_LONG_MS', 'CAPTURE_LONG_MS',
    'CAPTURE_MS', 'CAPTURE_MS', 'CAPTURE_LONG_MS + OFFICE_HOURS_BUN_GRACE_MS',
    'CAPTURE_MS', 'CAPTURE_MS', 'CAPTURE_MS', 'CAPTURE_MS',
  ]);
});

for (const row of newBudgets) {
  const manifest = () => ({ version: 1 as const, tier: 'periodic' as const, evalsAll: false,
    sliceCount: 1, entries: [{ file: row.file, slice: 1, status: 'planned' as const, budget: resolvePaidShardBudget([row.file]) }] });
  const result = (count = 1) => [{ version: 1 as const, tier: 'periodic' as const, sliceIndex: 1, sliceCount: 1,
    outcomes: [{ files: [row.file], status: 'passed' as const, exitCode: 0, elapsedMs: 1, executedTests: count,
      skippedTests: 0, budget: resolvePaidShardBudget([row.file]) }] }];

  test(`${row.file}: full wall and existing retries propagate through planning`, () => {
    expect(retriesForFiles([row.file])).toBe(row.retries);
    expect(resolvePaidShardBudget([row.file])).toEqual({ timeoutMs: expectedWalls[row.file as keyof typeof expectedWalls], source: 'registered', policyId: row.id });
    expect(planPaidShards(['test/a.test.ts', row.file, 'test/z.test.ts'], { maxFilesPerShard: 3 })).toContainEqual([row.file]);
    expect(() => resolvePaidShardBudget([row.file, 'test/neighbor.test.ts'])).toThrow('own shard');
    expect(resolvePaidShardBudget([row.file], 50)).toEqual({ timeoutMs: 50, source: 'explicit', policyId: row.id });
    expect(buildPaidShardArgs([row.file], row.shardMs, 2, retriesForFiles([row.file]))).toEqual([
      'test', row.file, '--retry', String(row.retries), '--concurrent', '--max-concurrency=2', `--timeout=${row.shardMs}`,
    ]);
  });

  test(`${row.file}: manifests and results authenticate the effective wall`, () => {
    const m = manifest();
    expect(parseRunManifest(JSON.stringify(m))).toEqual(m);
    expect(verifySliceResults(m, result())).toEqual({ ok: true, problems: [] });
    for (const mutation of ['missing', 'short', 'foreign', 'duplicate']) {
      const changed: any = structuredClone(m);
      if (mutation === 'missing') delete changed.entries[0].budget;
      if (mutation === 'short') changed.entries[0].budget.timeoutMs = 1_800_000;
      if (mutation === 'foreign') changed.entries[0].budget.policyId = 'foreign';
      if (mutation === 'duplicate') changed.entries.push(structuredClone(changed.entries[0]));
      expect(() => parseRunManifest(JSON.stringify(changed)), mutation).toThrow();
    }
    for (const mutation of ['missing', 'short', 'foreign', 'packed']) {
      const changed: any = result();
      if (mutation === 'missing') delete changed[0].outcomes[0].budget;
      if (mutation === 'short') changed[0].outcomes[0].budget.timeoutMs = 1_800_000;
      if (mutation === 'foreign') changed[0].outcomes[0].budget.policyId = 'foreign';
      if (mutation === 'packed') changed[0].outcomes[0].files.push('test/neighbor.test.ts');
      expect(verifySliceResults(m, changed).ok, mutation).toBe(false);
    }
  });
}

test('fixed AUQ count remains strict while mixed-tier files keep ordinary case handling', () => {
  for (const [file, count, ok] of [
    [AUQ_CONSISTENCY_RETRY_BUDGET.file, 0, false],
    [AUQ_CONSISTENCY_RETRY_BUDGET.file, 1, true],
    [AUQ_CONSISTENCY_RETRY_BUDGET.file, 2, false],
    ['test/skill-e2e-plan.test.ts', 5, true],
    ['test/skill-e2e-plan.test.ts', 7, true],
  ] as const) {
    const budget = resolvePaidShardBudget([file]);
    const manifest: any = { version: 1, tier: 'periodic', evalsAll: true, sliceCount: 1,
      entries: [{ file, slice: 1, status: 'planned', budget }] };
    const result: any = [{ version: 1, tier: 'periodic', sliceIndex: 1, sliceCount: 1,
      outcomes: [{ files: [file], status: 'passed', exitCode: 0, elapsedMs: 1, executedTests: count, skippedTests: 0, budget }] }];
    expect(verifySliceResults(manifest, result).ok, `${file}: ${count}`).toBe(ok);
  }
});

test('quality model work, ordinary tiers and the six existing finding registrations are unchanged', () => {
  expect(ALL_TIERS).toEqual({ JUDGE_MS: 120000, CAPTURE_MS: 300000, CAPTURE_LONG_MS: 600000, PTY_MS: 900000, PTY_LONG_MS: 1200000 });
  const quality = 'test/skill-llm-eval.test.ts';
  const qualityBudget = FILE_RETRY_BUDGETS.find(row => row.file === quality)!;
  expect(resolvePaidShardBudget([quality])).toEqual({ timeoutMs: 6_660_000, source: 'registered', policyId: qualityBudget.id });
  expect(retriesForFiles([quality])).toBe(1);
  const qualitySource = read(quality);
  const judgeTimeouts = [...qualitySource.matchAll(/}\s*,\s*(JUDGE_MS|WORKFLOW_JUDGE_TEST_MS)\s*\);/g)].map(match => match[1]);
  expect(judgeTimeouts.filter(timeout => timeout === 'JUDGE_MS')).toHaveLength(11);
  expect(judgeTimeouts.filter(timeout => timeout === 'WORKFLOW_JUDGE_TEST_MS')).toHaveLength(15);
  expect(qualitySource).toContain('WORKFLOW_JUDGE_TEST_MS = JUDGE_MS + 10_000');
  expect(qualitySource).toContain('const workDeadline = started + JUDGE_MS');
  expect(qualityBudget.shardMs).toBe((11 * ALL_TIERS.JUDGE_MS + 15 * (ALL_TIERS.JUDGE_MS + 10_000)) * 2 + 120_000);
  expect(FINDING_RETRY_BUDGETS.map(row => [row.cases, row.testMs, row.retries, row.shardMs])).toEqual([
    [2, 1500000, 1, 6120000], ...Array(5).fill([1, 1500000, 1, 3120000]),
  ]);
  for (const tier of ['gate', 'periodic'] as const) {
    const m = buildRunManifest({ tier, sliceCount: 1, evalsAll: true, env: { EVALS_ALL: '1' } });
    for (const row of m.entries.filter(entry => entry.status === 'planned' && newBudgets.some(b => b.file === entry.file))) {
      expect(row.budget).toEqual(resolvePaidShardBudget([row.file]));
    }
  }
});

test('detached PR fallback and release commands cover their actual default worker budgets', () => {
  const scripts = JSON.parse(read('package.json')).scripts;
  const prWorkers = Number(scripts['test:pr'].match(/EVALS_JOBS=\$\{EVALS_JOBS:-(\d+)\}/)?.[1]);
  expect(prWorkers).toBe(2);
  expect(scripts['test:pr']).toContain('--tier gate --profile pr');
  expect(scripts['eval:bg:pr']).toContain('-- bun run test:pr');
  const fallback = buildRunManifest({ tier: 'gate', profile: 'pr', sliceCount: 1,
    evalsAll: false, env: {}, changedFiles: ['runtime-not-yet-mapped/worker.ts'] });
  expect(fallback.prCoverage?.mode).toBe('full-fallback');
  const files = fallback.entries.filter(row => row.status === 'planned').map(row => row.file);
  const prWall = Number(scripts['eval:bg:pr'].match(/--timeout (\d+)/)?.[1]) * 1000;
  expect(prWall).toBeGreaterThanOrEqual(paidShardWallUpperBoundMs(files, prWorkers) + 120_000);

  expect(scripts['eval:bg:release']).toContain('-- bun run test:release');
  const releaseCommands = scripts['test:release'].split(' && ');
  expect(releaseCommands).toHaveLength(2);
  let releaseWall = 0;
  for (const [index, tier] of (['gate', 'periodic'] as const).entries()) {
    expect(releaseCommands[index]).toBe(`EVALS_ALL=1 EVALS_FRESH=1 EVALS_CACHE_PURPOSE=release bun run scripts/test-paid-shards.ts --tier ${tier} --profile full`);
    const census = buildRunManifest({ tier, profile: 'full', sliceCount: 1, evalsAll: true, env: { EVALS_ALL: '1' } });
    releaseWall += paidShardWallUpperBoundMs(census.entries.filter(row => row.status === 'planned').map(row => row.file), DEFAULT_JOBS);
  }
  const detachedReleaseWall = Number(scripts['eval:bg:release'].match(/--timeout (\d+)/)?.[1]) * 1000;
  expect(detachedReleaseWall).toBeGreaterThanOrEqual(releaseWall + 120_000);
});

const cliOptions = (step: { run: string; env?: Record<string, string> }) => {
  const prefix = /\bbun(?: --no-install)? run scripts\/test-paid-shards\.ts /.exec(step.run);
  expect(prefix).not.toBeNull();
  const args = step.run.slice(prefix!.index + prefix![0].length)
    .replace(/\$\{\{\s*matrix\.slice\s*\}\}/g, '1').trim().split(/\s+/);
  return parseCliOptions(args, step.env ?? {});
};

test('both gate executors cover the complete census without increasing aggregate workers', () => {
  const periodic: any = Bun.YAML.parse(read('.github/workflows/evals-periodic.yml'));
  const main: any = Bun.YAML.parse(read('.github/workflows/evals.yml'));
  for (const [workflow, jobName, workers] of [[main, 'eval-slices', 2], [periodic, 'gate-census', 1]] as const) {
    const planner = workflow.jobs['plan-slices'];
    const executor = workflow.jobs[jobName];
    const emit = planner.steps.filter((step: any) => step.run?.includes('EVALS_TIER=gate ') && step.run.includes('--emit-plan '));
    const execute = executor.steps.filter((step: any) => step.run?.includes('--plan '));
    expect(emit).toHaveLength(1);
    expect(execute).toHaveLength(1);
    const planned = cliOptions(emit[0]), active = cliOptions(execute[0]);
    expect(planned.tier).toBe('gate');
    expect(active.tier).toBe('gate');
    expect(active.jobs).toBe(workers);
    expect(execute[0].env.EVALS_CONCURRENCY).toBe('2');
    expect(executor.strategy['fail-fast']).toBe(false);
    expect(executor.strategy.matrix.slice).toEqual([1, 2, 3, 4, 5, 6]);
    expect(planned.slices).toBe(6);
    const manifest = buildRunManifest({ tier: 'gate', sliceCount: planned.slices, evalsAll: true, env: { EVALS_ALL: '1' } });
    expect(manifest.entries.filter(row => row.status === 'planned')).toHaveLength(54);
    const walls = executor.strategy.matrix.slice.map((slice: number) => paidShardWallUpperBoundMs(
      manifest.entries.filter(row => row.status === 'planned' && row.slice === slice).map(row => row.file), workers,
    ));
    expect(executor['timeout-minutes'] * 60_000).toBeGreaterThanOrEqual(Math.max(...walls) + 20 * 60_000);
    if (jobName === 'gate-census') {
      expect(emit[0].env.EVALS_ALL).toBe('1');
      expect(executor.strategy['max-parallel']).toBe(4);
      expect(executor.strategy['max-parallel'] * active.jobs).toBe(4);
      expect(emit[0].run).toContain('--emit-plan /tmp/gate-census-plan/manifest.json');
      expect(execute[0].run).toContain('--plan /tmp/gate-census-plan/manifest.json --slice ${{ matrix.slice }}');
      expect(executor.steps.some((step: any) => step.with?.name === 'gate-census-plan')).toBe(true);
      expect(executor.steps.filter((step: any) => step.run?.includes('--emit-plan '))).toHaveLength(0);
    }
  }
});

test('the periodic executor supervises every actual case and retry within its CI wall', () => {
  const workflow: any = Bun.YAML.parse(read('.github/workflows/evals-periodic.yml'));
  const executor = workflow.jobs['eval-slices'];
  const emit = workflow.jobs['plan-slices'].steps.filter((step: any) =>
    step.run?.includes('EVALS_TIER=periodic ') && step.run.includes('--emit-plan '));
  const execute = executor.steps.filter((step: any) => step.run?.includes('--plan '));
  expect(emit).toHaveLength(1);
  expect(execute).toHaveLength(1);
  const planned = cliOptions(emit[0]), active = cliOptions(execute[0]);
  expect(planned.tier).toBe('periodic');
  expect(planned.dedicatedAutoplanSlice).toBe(true);
  expect(planned.slices).toBe(8);
  expect(active.jobs).toBe(2);
  expect(executor.strategy.matrix.slice).toEqual(Array.from({ length: planned.slices }, (_, i) => i + 1));
  const manifest = buildRunManifest({ tier: 'periodic', sliceCount: planned.slices,
    dedicatedAutoplanSlice: planned.dedicatedAutoplanSlice, evalsAll: true, env: { EVALS_ALL: '1' } });
  const census = manifest.entries.filter(row => row.status === 'planned');
  expect(census).toHaveLength(99);
  expect(census.find(row => row.file === 'test/skill-llm-eval.test.ts')?.budget?.timeoutMs).toBe(6_660_000);
  expect(manifest.autoplanSlice).toBe(8);
  const walls = executor.strategy.matrix.slice.map((slice: number) => paidShardWallUpperBoundMs(
    census.filter(row => row.slice === slice).map(row => row.file), active.jobs,
  ));
  expect(executor['timeout-minutes'] * 60_000).toBeGreaterThanOrEqual(Math.max(...walls) + 20 * 60_000);
});

test('gate census requires all six distinct slice results and its own reconciliation', () => {
  const workflow: any = Bun.YAML.parse(read('.github/workflows/evals-periodic.yml'));
  const report = workflow.jobs.report;
  const reconcile = report.steps.find((step: any) => step.id === 'gate-reconcile');
  expect(report.needs).toContain('gate-census');
  expect(reconcile.if).toBe('always()');
  expect(reconcile.run).toContain('EVALS_TIER=gate bun run scripts/test-paid-shards.ts --tier gate --report /tmp/gate-census-report');
  expect(reconcile.run).toContain('exit=${PIPESTATUS[0]}');
  const failureGuards = report.steps.filter((step: any) => /Upsert tracking|Fail the workflow/.test(step.name ?? ''));
  expect(failureGuards).toHaveLength(2);
  for (const step of failureGuards) {
    expect(step.if).toContain("steps.gate-reconcile.outputs.exit != '0'");
    expect(step.if).toContain("needs.gate-census.result != 'success'");
    expect(step.if).toContain("steps.reconcile.outputs.exit != '0'");
    expect(step.if).toContain("needs.eval-slices.result != 'success'");
  }
  const manifest = buildRunManifest({ tier: 'gate', sliceCount: 6, evalsAll: true, env: { EVALS_ALL: '1' } });
  const results = Array.from({ length: 6 }, (_, i) => ({ version: 1 as const, tier: 'gate' as const, sliceIndex: i + 1, sliceCount: 6,
    outcomes: manifest.entries.filter(row => row.status === 'planned' && row.slice === i + 1).map(row => ({
      files: [row.file], status: 'passed' as const, exitCode: 0, elapsedMs: 1, skippedTests: 0,
      executedTests: STRICT_RETRY_CASE_BUDGETS.find(budget => budget.file === row.file)?.cases ?? 1,
      ...(row.budget ? { budget: row.budget } : {}),
    })),
  }));
  expect(verifySliceResults(manifest, results)).toEqual({ ok: true, problems: [] });
  for (let missing = 0; missing < 6; missing++) {
    expect(verifySliceResults(manifest, results.filter((_, i) => i !== missing)).ok).toBe(false);
  }
  expect(verifySliceResults(manifest, [...results, results[0]!]).ok).toBe(false);
});
