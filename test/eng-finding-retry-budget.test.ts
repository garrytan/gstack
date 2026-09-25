import { expect, test } from 'bun:test';
import { resolvePaidShardBudget, retriesForFiles, planPaidShards, parseRunManifest, verifySliceResults, runPaidShard, buildRunManifest, paidShardWallUpperBoundMs, collectPaidTestFiles, selectPaidTestFiles, isOverlayTestFile, OVERLAY_MAX_ACTIVE_SHARDS, DEFAULT_SHARD_TIMEOUT_MS, DEFAULT_JOBS } from '../scripts/test-paid-shards';
import { FINDING_RETRY_BUDGETS, ALL_TIERS, AUTOPLAN_CHAIN_BUDGET } from './helpers/eval-budgets';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

for (const budget of FINDING_RETRY_BUDGETS) {
  test(`${budget.file}: supervision preserves every existing attempt and retry`, () => {
    expect(budget.testMs).toBe(1_500_000);
    expect(budget.retries).toBe(1);
    expect(retriesForFiles([budget.file])).toBe(budget.retries);
    expect(budget.shardReserveMs).toBe(AUTOPLAN_CHAIN_BUDGET.shardReserveMs);
    expect(budget.shardMs).toBe(budget.cases * budget.testMs * (budget.retries + 1) + budget.shardReserveMs);
    expect(resolvePaidShardBudget([budget.file])).toEqual({ timeoutMs: budget.shardMs, source: 'registered', policyId: budget.id });
    const source = fs.readFileSync(path.join(import.meta.dir, '..', budget.file), 'utf8');
    if (budget.file === 'test/skill-e2e-plan-ceo-split-overflow.test.ts') {
      // This case shares its unchanged allowance with final semantic validation.
      // Its actual registration adapter also verifies the elapsed-time routing.
      expect([...source.matchAll(/const deadlineAt = Date\.now\(\) \+ 1_500_000;/g)]).toHaveLength(budget.cases);
      expect([...source.matchAll(/timeoutMs:\s*deadlineAt - Date\.now\(\)/g)]).toHaveLength(budget.cases);
      expect(source).toContain("floor: FLOOR, kind: 'scope', deadlineAt");
    } else if (budget.file === 'test/skill-e2e-plan-eng-finding-count.test.ts') {
      // Its terminal assessment shares the original allowance with the actor.
      expect([...source.matchAll(/const startedAt = Date\.now\(\);/g)]).toHaveLength(budget.cases);
      expect([...source.matchAll(/const deadlineAt = startedAt \+ 1_500_000;/g)]).toHaveLength(budget.cases);
      expect([...source.matchAll(/timeoutMs:\s*deadlineAt - Date\.now\(\)/g)]).toHaveLength(budget.cases);
      expect(source).toContain('deadlineAt: Math.min(input.deadlineAt, deadlineAt)');
    } else {
      expect([...source.matchAll(/timeoutMs:\s*1_500_000\b/g)]).toHaveLength(budget.cases);
    }
    expect([...source.matchAll(/1_500_000\s*\/\* physical ceiling:/g)]).toHaveLength(budget.cases);
    // Current periodic CI already supports this supervision wall.
    const workflow = fs.readFileSync(path.join(import.meta.dir, '../.github/workflows/evals-periodic.yml'), 'utf8');
    expect(workflow).toMatch(/timeout-minutes: 355/);
    expect(budget.shardMs).toBeLessThan(355 * 60_000);
  });

  test(`${budget.file}: own-shard allocation leaves ordinary and explicit limits intact`, () => {
    expect(() => resolvePaidShardBudget([budget.file, 'test/other.test.ts'])).toThrow('own shard');
    const shards = planPaidShards(['test/a.test.ts', budget.file, 'test/z.test.ts'], { maxFilesPerShard: 3 });
    expect(shards).toContainEqual([budget.file]);
    expect(shards.flat().sort()).toEqual(['test/a.test.ts', budget.file, 'test/z.test.ts'].sort());
    expect(resolvePaidShardBudget([budget.file], 123)).toEqual({ timeoutMs: 123, source: 'explicit', policyId: budget.id });
  });

  const planned = () => ({ version: 1 as const, tier: 'periodic' as const, evalsAll: true, sliceCount: 1, selectionReason: 'budget regression',
    entries: [{ file: budget.file, slice: 1, status: 'planned' as const, budget: resolvePaidShardBudget([budget.file]) }] });
  const results = (manifest = planned()) => [{ version: 1 as const, tier: 'periodic' as const, sliceIndex: 1, sliceCount: 1,
    outcomes: [{ files: [budget.file], status: 'passed' as const, exitCode: 0, elapsedMs: 1, executedTests: budget.cases, skippedTests: 0, budget: manifest.entries[0]!.budget }] }];

  test(`${budget.file}: manifest and result retain exact allocation and authenticated subsets`, () => {
    const m = planned(); expect(parseRunManifest(JSON.stringify(m))).toEqual(m);
    expect(verifySliceResults(m, results(m))).toEqual({ ok: true, problems: [] });
    const selected = results(m); selected[0]!.outcomes[0]!.executedTests = 1;
    expect(verifySliceResults(m, selected).ok).toBe(budget.cases === 1);
    expect(verifySliceResults({ ...m, evalsAll: false }, selected)).toEqual({ ok: true, problems: [] });
    expect(verifySliceResults({ ...m, evalsAll: undefined } as any, selected).ok).toBe(budget.cases === 1);
    m.entries[0]!.budget = resolvePaidShardBudget([budget.file], 123);
    expect(verifySliceResults(m, results(m))).toEqual({ ok: true, problems: [] });
  });
  for (const mutation of ['missing', 'wrong-time', 'wrong-policy', 'duplicate'] as const) test(`${budget.file}: rejects ${mutation} manifest budget`, () => {
    const m: any = planned();
    if (mutation === 'missing') delete m.entries[0].budget;
    if (mutation === 'wrong-time') m.entries[0].budget.timeoutMs--;
    if (mutation === 'wrong-policy') m.entries[0].budget.policyId = 'foreign';
    if (mutation === 'duplicate') m.entries.push(structuredClone(m.entries[0]));
    expect(() => parseRunManifest(JSON.stringify(m))).toThrow();
  });
  for (const mutation of ['wrong-time', 'missing', 'skipped', 'no-case', 'extra-case', 'fractional', 'nonzero', 'packed'] as const) test(`${budget.file}: rejects ${mutation} execution evidence`, () => {
    const m = planned(), r: any = results(m), o = r[0].outcomes[0];
    if (mutation === 'wrong-time') o.budget = { ...o.budget, timeoutMs: 1800000 };
    if (mutation === 'missing') delete o.budget;
    if (mutation === 'skipped') o.skippedTests = 1;
    if (mutation === 'no-case') o.executedTests = 0;
    if (mutation === 'extra-case') o.executedTests = budget.cases + 1;
    if (mutation === 'fractional') o.executedTests = 0.5;
    if (mutation === 'nonzero') o.exitCode = 1;
    if (mutation === 'packed') o.files.push('test/other.test.ts');
    expect(verifySliceResults(m, r).ok).toBe(false);
  });
  test(`${budget.file}: packed neighbor cannot also claim the separately reported workflow`, () => {
    const m: any = planned(), r: any = results(m);
    m.entries.push({ file: 'test/other.test.ts', slice: 1, status: 'planned' });
    r[0].outcomes.push({ files: ['test/other.test.ts', budget.file], status: 'passed', exitCode: 0, elapsedMs: 1, executedTests: 1, skippedTests: 0 });
    expect(verifySliceResults(m, r).ok).toBe(false);
  });
}

test('ordinary tiers and Autoplan allocations remain unchanged', () => {
  expect(ALL_TIERS).toEqual({ JUDGE_MS: 120000, CAPTURE_MS: 300000, CAPTURE_LONG_MS: 600000, PTY_MS: 900000, PTY_LONG_MS: 1200000 });
  expect(resolvePaidShardBudget(['test/other.test.ts'])).toEqual({ timeoutMs: 1800000, source: 'default', policyId: null });
  expect(resolvePaidShardBudget([AUTOPLAN_CHAIN_BUDGET.file])).toEqual({ timeoutMs: AUTOPLAN_CHAIN_BUDGET.shardMs, source: 'registered', policyId: AUTOPLAN_CHAIN_BUDGET.id });
  expect(new Set(FINDING_RETRY_BUDGETS.map(b => b.file)).size).toBe(6);
});

test('actual shard launcher honors the explicit saved planner limit without a provider', async () => {
  const budget = FINDING_RETRY_BUDGETS.find(b => b.file.includes('plan-eng-finding-count'))!;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finding-retry-wall-'));
  try {
    const outcome = await runPaidShard([budget.file], 1, 1, { rootDir: dir, logDir: dir, jobs: 2,
      registeredBudgets: { [budget.file]: resolvePaidShardBudget([budget.file], 50) },
      commandFor: () => ({ command: process.execPath, args: ['-e', 'setTimeout(()=>{},10000)'] }),
      log: () => {}, env: { ...process.env, EVALS: '' } });
    expect(outcome.status).toBe('timed-out');
    expect(outcome.budget).toEqual({ timeoutMs: 50, source: 'explicit', policyId: budget.id });
    expect(outcome.elapsedMs).toBeLessThan(5000);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}, 10000);

const periodicWorkflow = Bun.YAML.parse(fs.readFileSync(path.join(import.meta.dir, '../.github/workflows/evals-periodic.yml'), 'utf8')) as any;
const periodicJob = periodicWorkflow.jobs['eval-slices'];
const periodicPlanStep = periodicWorkflow.jobs['plan-slices'].steps.find((step: any) => step.run?.includes('--tier periodic --emit-plan'));
const periodicSliceCount = Number(periodicPlanStep.run.match(/--slices\s+(\d+)/)?.[1]);
const periodicRunStep = periodicJob.steps.find((step: any) => step.run?.includes('--plan /tmp/paid-plan/manifest.json'));
const periodicWorkers = Number(periodicRunStep.env.EVALS_JOBS);
const livePlan = (discovered?: string[]) => buildRunManifest({ tier: 'periodic', sliceCount: periodicSliceCount,
  evalsAll: true, dedicatedAutoplanSlice: true, env: { EVALS_ALL: '1' }, discovered });

test('live periodic census fits the declared CI wall including setup', () => {
  const m = livePlan();
  expect(periodicPlanStep.run).toContain('--autoplan-slice');
  expect(periodicJob.strategy.matrix.slice).toEqual(Array.from({ length: periodicSliceCount }, (_, index) => index + 1));
  expect(periodicWorkers).toBe(2);
  const walls = Array.from({ length: periodicSliceCount }, (_, index) => {
    const files = m.entries.filter(e => e.status === 'planned' && e.slice === index + 1).map(e => e.file);
    const workers = files.some(isOverlayTestFile) ? Math.min(periodicWorkers, OVERLAY_MAX_ACTIVE_SHARDS) : periodicWorkers;
    return paidShardWallUpperBoundMs(files, workers);
  });
  expect(Math.max(...walls) + 20 * 60_000).toBeLessThanOrEqual(periodicJob['timeout-minutes'] * 60_000);
  expect(m.entries.filter(e => e.status === 'planned')).toHaveLength(99);
  const overlays = m.entries.filter(e => e.status === 'planned' && e.slice === periodicSliceCount - 1);
  expect(overlays).toHaveLength(6);
  expect(overlays.every(e => isOverlayTestFile(e.file))).toBe(true);
  expect(m.entries.filter(e => e.status === 'planned' && e.slice === periodicSliceCount).map(e => e.file)).toEqual([AUTOPLAN_CHAIN_BUDGET.file]);
});

test('registered allocation is deterministic and preserves every discovered file', () => {
  const files = collectPaidTestFiles();
  expect(files).toHaveLength(114);
  const m = livePlan(files);
  expect(livePlan([...files].reverse())).toEqual(m);
  expect(m.entries.map(e => e.file).sort()).toEqual([...files].sort());
  expect(new Set(m.entries.map(e => e.file)).size).toBe(files.length);
});

test('ordinary-only manifests retain round-robin allocation', () => {
  const files = ['test/skill-e2e-a.test.ts', 'test/skill-e2e-b.test.ts', 'test/skill-e2e-c.test.ts'];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-shard-plan-'));
  try {
    fs.mkdirSync(path.join(root, 'test'));
    for (const file of files) fs.writeFileSync(path.join(root, file), '// no whole-file tier exclusion');
    const m = buildRunManifest({ tier: 'periodic', sliceCount: 2, evalsAll: true,
      rootDir: root, discovered: files, env: { EVALS_ALL: '1' } });
    expect(m.entries.map(e => e.slice)).toEqual([1, 2, 1]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('explicit allocation keeps its timer across load scheduling', () => {
  const m = buildRunManifest({ tier: 'periodic', sliceCount: 7, evalsAll: true,
    dedicatedAutoplanSlice: true, timeoutMs: 2_000_000, env: { EVALS_ALL: '1' } });
  for (const entry of m.entries.filter(e => e.budget)) {
    expect(entry.budget).toEqual(resolvePaidShardBudget([entry.file], 2_000_000));
  }
});

test('single-slice manifest retains all registered files with one allocation', () => {
  const m = buildRunManifest({ tier: 'periodic', sliceCount: 1, evalsAll: true, env: { EVALS_ALL: '1' } });
  expect(m.entries.filter(e => e.status === 'planned').every(e => e.slice === 1)).toBe(true);
  for (const budget of FINDING_RETRY_BUDGETS) expect(m.entries.find(e => e.file === budget.file)?.budget).toEqual(resolvePaidShardBudget([budget.file]));
});

test('current detach supervision covers the live-census floor', () => {
  const files = selectPaidTestFiles(collectPaidTestFiles(), 'periodic').selected;
  const excess = files.reduce((n, file) => n + Math.max(0, resolvePaidShardBudget([file]).timeoutMs - DEFAULT_SHARD_TIMEOUT_MS), 0);
  const floor = Math.ceil((Math.ceil(files.length / DEFAULT_JOBS) * DEFAULT_SHARD_TIMEOUT_MS + excess) / 1000 * 1.05);
  const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dir, '../package.json'), 'utf8'));
  const configured = Number(pkg.scripts['eval:bg:periodic'].match(/--timeout\s+(\d+)/)[1]);
  expect(floor).toBe(65268);
  expect(configured).toBeGreaterThanOrEqual(floor);
  expect(pkg.scripts['eval:bg:gate']).toContain('--timeout 33800');
});

for (const jobs of [1, 2, 3]) test(`FIFO bound covers partial durations with ${jobs} workers`, () => {
  const long = FINDING_RETRY_BUDGETS.find(b => b.cases === 2)!.file;
  for (const files of [[], ['test/a.test.ts'], [long, 'test/a.test.ts', 'test/b.test.ts'],
    ['test/a.test.ts', 'test/b.test.ts', long, 'test/c.test.ts', 'test/d.test.ts'],
    [long, FINDING_RETRY_BUDGETS[1]!.file, 'test/a.test.ts', 'test/b.test.ts']]) {
    const ceilings = files.map(file => resolvePaidShardBudget([file]).timeoutMs);
    const bound = paidShardWallUpperBoundMs(files, jobs);
    const durationOptions = ceilings.map(ms => [0, Math.floor(ms / 2), ms]);
    const visit = (durations: number[]) => {
      if (durations.length < files.length) {
        for (const duration of durationOptions[durations.length]!) visit([...durations, duration]);
        return;
      }
      const workers = Array<number>(jobs).fill(0);
      for (const duration of durations) {
        const worker = workers.indexOf(Math.min(...workers));
        workers[worker] += duration;
      }
      expect(Math.max(...workers)).toBeLessThanOrEqual(bound);
    };
    visit([]);
  }
});

test('FIFO bound retains exact uniform waves and explicit limits', () => {
  const files = Array.from({ length: 19 }, (_, i) => `test/ordinary-${i}.test.ts`);
  expect(paidShardWallUpperBoundMs(files, 2)).toBe(10 * DEFAULT_SHARD_TIMEOUT_MS);
  expect(paidShardWallUpperBoundMs(files, 2, 100)).toBe(1000);
  expect(() => paidShardWallUpperBoundMs(files, 0)).toThrow('Worker count');
  expect(() => paidShardWallUpperBoundMs(files, 1.5)).toThrow('Worker count');
});
