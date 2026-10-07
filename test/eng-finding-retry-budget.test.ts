import { expect, test } from 'bun:test';
import { resolvePaidShardBudget, retriesForFiles, planPaidShards, parseRunManifest, verifySliceResults, runPaidShard, buildRunManifest, paidShardWallUpperBoundMs, collectPaidTestFiles, selectPaidTestFiles, isOverlayTestFile, DEFAULT_SHARD_TIMEOUT_MS, DEFAULT_JOBS, parseCliOptions, expandCaseShards, expandTrialShards, shardFile, sliceExecutionOrder, sliceSupervisedWallMs, resolvePaidShardTimeoutMs } from '../scripts/test-paid-shards';
import { FINDING_RETRY_BUDGETS, ALL_TIERS, SHARD_RESERVE_MS } from './helpers/eval-budgets';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

for (const budget of FINDING_RETRY_BUDGETS) {
  test(`${budget.file}: supervision covers its one run of every case`, () => {
    expect(budget.testMs).toBe(1_500_000);
    // Paid evals never retry: a timed-out case is its verdict.
    expect(retriesForFiles([budget.file])).toBe(0);
    expect(budget.shardReserveMs).toBe(SHARD_RESERVE_MS);
    expect(budget.shardMs).toBe(budget.cases * budget.testMs + budget.shardReserveMs);
    expect(resolvePaidShardBudget([budget.file])).toEqual({ timeoutMs: budget.shardMs, source: 'registered', policyId: budget.id });
    const source = fs.readFileSync(path.join(import.meta.dir, '..', budget.file), 'utf8');
    if (budget.file === 'test/skill-e2e-plan-ceo-split-overflow.test.ts') {
      // This case shares its unchanged allowance with final semantic validation.
      // Its actual registration adapter also verifies the elapsed-time routing.
      expect([...source.matchAll(/const deadlineAt = Date\.now\(\) \+ 1_500_000;/g)]).toHaveLength(budget.cases);
      expect([...source.matchAll(/timeoutMs:\s*deadlineAt - Date\.now\(\)/g)]).toHaveLength(budget.cases);
      expect(source).toContain("floor: FLOOR, kind: 'scope', deadlineAt");
    } else {
      expect([...source.matchAll(/timeoutMs:\s*1_500_000\b/g)]).toHaveLength(budget.cases);
    }
    expect([...source.matchAll(/1_500_000\s*\/\* physical ceiling:/g)]).toHaveLength(budget.cases);
    // The planned periodic CI job cap supports this supervision wall.
    expect(budget.shardMs).toBeLessThan(livePlan().plan!.ciTimeoutMinutes * 60_000);
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

test('ordinary tiers and registered allocations remain unchanged', () => {
  expect(ALL_TIERS).toEqual({ JUDGE_MS: 120000, CAPTURE_MS: 300000, CAPTURE_LONG_MS: 600000, PTY_MS: 900000, PTY_LONG_MS: 1200000 });
  expect(resolvePaidShardBudget(['test/other.test.ts'])).toEqual({ timeoutMs: 1800000, source: 'default', policyId: null });
  expect(resolvePaidShardBudget(['test/other.test.ts'], 12_000)).toEqual({ timeoutMs: 12_000, source: 'explicit', policyId: null });
  for (const value of [NaN, Infinity, -1, 0, 1.5, 2_147_483_648]) {
    expect(() => resolvePaidShardBudget(['test/other.test.ts'], value)).toThrow('timer-safe');
  }
  expect(new Set(FINDING_RETRY_BUDGETS.map(b => b.file)).size).toBe(2);
});

test('actual shard launcher honors the explicit saved planner limit without a provider', async () => {
  const budget = FINDING_RETRY_BUDGETS.find(b => b.file.includes('plan-eng-multi-finding-batching'))!;
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

function periodicLane() {
  const workflow = Bun.YAML.parse(fs.readFileSync(path.join(import.meta.dir, '../.github/workflows/evals-periodic.yml'), 'utf8')) as any;
  const job = workflow.jobs['eval-slices'];
  const planStep = workflow.jobs['plan-slices'].steps.find((step: any) => step.run?.includes('--tier periodic --emit-plan'));
  const planned = parseCliOptions(planStep.run.slice(planStep.run.indexOf('scripts/test-paid-shards.ts') + 'scripts/test-paid-shards.ts'.length).trim().split(/\s+/), {});
  const runStep = job.steps.find((step: any) => step.run?.includes('--plan /tmp/paid-plan/manifest.json'));
  return { job, planStep, planned, workers: Number(runStep.env.EVALS_JOBS) };
}
function livePlan(discovered?: string[]) {
  const { planned } = periodicLane();
  return buildRunManifest({ tier: 'periodic', sliceBudgetMs: planned.sliceBudgetMs!, jobs: planned.jobs,
    evalsAll: true, env: { EVALS_ALL: '1' }, discovered });
}

test('live periodic census fits the declared CI wall including setup', () => {
  const { job, planStep, planned, workers } = periodicLane();
  const m = livePlan();
  expect(planStep.run).not.toContain('--autoplan-slice');
  expect(job.strategy.matrix.slice).toBe('${{ fromJSON(needs.plan-slices.outputs.periodic_slices) }}');
  expect(job['timeout-minutes']).toBe('${{ fromJSON(needs.plan-slices.outputs.periodic_slice_timeouts)[matrix.slice] }}');
  expect(workers).toBe(2);
  expect(planned.jobs).toBe(workers);
  // W2c/ENG-2: every slice's own ceiling covers its longest shard wall plus setup.
  const sliceFiles = Array.from({ length: m.sliceCount }, (_, index) => sliceExecutionOrder(
    m.entries.filter(e => e.status === 'planned' && e.slice === index + 1)).map(e => e.file));
  sliceFiles.forEach((files, index) => expect(Math.max(...files.map(file => resolvePaidShardTimeoutMs([file]))) + 20 * 60_000)
    .toBeLessThanOrEqual(m.plan!.sliceCiTimeoutMinutes![index]! * 60_000));
  expect(m.plan!.ciTimeoutMinutes).toBeLessThanOrEqual(360);
  expect(m.sliceCount).toBeLessThanOrEqual(job.strategy['max-parallel']);
  const plannedFiles = new Set(m.entries.filter(e => e.status === 'planned').map(e => shardFile(e.file)));
  expect(plannedFiles).toEqual(new Set(selectPaidTestFiles(collectPaidTestFiles(), 'periodic').selected));
  const overlays = m.entries.filter(e => e.status === 'planned' && e.slice === m.sliceCount);
  expect(overlays).toHaveLength(5);
  expect(overlays.every(e => isOverlayTestFile(e.file))).toBe(true);
});

test('registered allocation is deterministic and preserves every discovered file', () => {
  const files = collectPaidTestFiles();
  expect(files).toHaveLength(106); // + skill-e2e-autoplan-schema-canary and skill-e2e-autoplan-guard-pty (Oct 7 wave, CEO-13, ENG-18); + skill-e2e-ship-measure-seeded-flake (v1.91.32.0); W5a: 15 carve wrappers became one case-sharded file; + codex-e2e-multiblock-live and skill-e2e-design-model-smoke (v1.91.30.0);
  expect(files).toContain('test/skill-e2e-ship-skip.test.ts');
  const m = livePlan(files);
  expect(livePlan([...files].reverse())).toEqual(m);
  expect([...new Set(m.entries.map(e => shardFile(e.file)))].sort()).toEqual([...files].sort());
  expect(new Set(m.entries.map(e => e.file)).size).toBe(m.entries.length);
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
    timeoutMs: 2_000_000, env: { EVALS_ALL: '1' } });
  for (const entry of m.entries.filter(e => e.budget)) {
    expect(entry.budget).toEqual(resolvePaidShardBudget([entry.file], 2_000_000));
  }
});

test('single-slice manifest retains all registered files with one allocation', () => {
  // A registered file runs in exactly one scheduled lane: periodic, or the marathon lane for full flows.
  const manifests = (['periodic', 'marathon'] as const).map(tier => buildRunManifest({ tier, sliceCount: 1, evalsAll: true, env: { EVALS_ALL: '1' } }));
  for (const m of manifests) expect(m.entries.filter(e => e.status === 'planned').every(e => e.slice === 1)).toBe(true);
  for (const budget of FINDING_RETRY_BUDGETS) {
    const entries = manifests.flatMap(m => m.entries.filter(e => e.file === budget.file && e.status === 'planned'));
    expect(entries, budget.file).toHaveLength(1);
    expect(entries[0]!.budget).toEqual(resolvePaidShardBudget([budget.file]));
  }
});

// The local detach cap is ceil(1.5 x planned serial / jobs) + 20 min, at most 4 h
// (scripts/eval-bg.ts); test/eval-detach-timeout-floor.test.ts pins it against the
// live census. The worst-case-floor contract this file used to pin is withdrawn (W5d).

for (const jobs of [1, 2, 3]) test(`FIFO bound covers partial durations with ${jobs} workers`, () => {
  const long = FINDING_RETRY_BUDGETS[0]!.file;
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
