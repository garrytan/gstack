import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  balancePaidSlices, buildRunManifest, isOverlayTestFile, loadPaidTestDurations,
  paidShardWallUpperBoundMs, parseRunManifest, resolvePaidShardBudget,
  type ManifestEntry, type PaidRunManifest,
} from '../scripts/test-paid-shards';
import { AUTOPLAN_CHAIN_BUDGET, FILE_RETRY_BUDGETS } from './helpers/eval-budgets';

const files = ['a', 'b', 'c', 'd', 'e', 'f'].map(name => `test/skill-e2e-duration-${name}.test.ts`);
const durations = Object.fromEntries(files.map((file, index) => [file, [10, 10, 20, 20, 90, 80][index]]));
const fixture = (): PaidRunManifest => ({
  version: 1, tier: 'gate', profile: 'full', evalsAll: true, sliceCount: 2,
  selectionReason: 'fixture', selection: { e2e: null, judges: null },
  entries: files.map((file, index) => ({ file, slice: index % 2 + 1, status: 'planned' })),
});
const wall = (entries: ManifestEntry[]) => Math.max(...[1, 2].map(slice => {
  const workers = [0, 0];
  for (const entry of entries.filter(entry => entry.slice === slice)) {
    workers[workers[0] <= workers[1] ? 0 : 1] += durations[entry.file];
  }
  return Math.max(...workers);
}));
const identity = (entries: ManifestEntry[]) => entries.map(({ slice, ...entry }) => entry)
  .sort((a, b) => a.file.localeCompare(b.file));

test('measured placement starts the long tail early without changing file or case selection', () => {
  const original = fixture();
  const frozen = JSON.stringify(original);
  const balanced = balancePaidSlices(original, durations);
  expect(wall(original.entries)).toBe(100);
  expect(wall(balanced)).toBe(90);
  expect(identity(balanced)).toEqual(identity(original.entries));
  expect(JSON.stringify(original)).toBe(frozen);
  expect(balancePaidSlices(original, durations)).toEqual(balanced);
  expect(parseRunManifest(JSON.stringify({ ...original, entries: balanced })).entries).toEqual(balanced);
});

test('measured placement cannot raise the supervised wall for any worker count', () => {
  const original = fixture();
  for (const timeout of [undefined, 120_000]) {
    const balanced = balancePaidSlices(original, durations, timeout);
    for (let jobs = 1; jobs <= files.length + 1; jobs++) {
      const bound = (entries: ManifestEntry[]) => Math.max(...[1, 2].map(slice =>
        paidShardWallUpperBoundMs(entries.filter(entry => entry.slice === slice).map(entry => entry.file), jobs, timeout)));
      expect(bound(balanced)).toBeLessThanOrEqual(bound(original.entries));
    }
  }
});

test('missing or unusable measurements leave the existing scheduler intact', () => {
  const original = fixture();
  for (const values of [{}, { unrelated: 100 }, { [files[0]]: NaN }, { [files[0]]: -1 }]) {
    expect(balancePaidSlices(original, values)).toBe(original.entries);
  }
  expect(balancePaidSlices({ ...original, sliceCount: 1 }, durations)).toBe(original.entries);
  expect(balancePaidSlices(original, Object.fromEntries(files.map(file => [file, 1])))).toBe(original.entries);
});

test('a partial timing seed never omits an unmeasured file', () => {
  const original = fixture();
  const balanced = balancePaidSlices(original, { [files[4]]: 90 });
  expect(identity(balanced)).toEqual(identity(original.entries));
  expect(new Set(balanced.map(entry => entry.file)).size).toBe(files.length);
});

test('overlay, dedicated Autoplan and skipped entries retain their original ownership and order', () => {
  const original = fixture();
  original.tier = 'periodic';
  original.sliceCount = 4;
  original.autoplanSlice = 4;
  const reserved: ManifestEntry[] = [
    { file: 'test/skill-e2e-overlay-harness-a.test.ts', status: 'planned', slice: 3 },
    { file: 'test/skill-e2e-overlay-harness-b.test.ts', status: 'planned', slice: 3 },
    { file: AUTOPLAN_CHAIN_BUDGET.file, status: 'planned', slice: 4, budget: resolvePaidShardBudget([AUTOPLAN_CHAIN_BUDGET.file]) },
    { file: 'test/skipped.test.ts', status: 'skipped-by-diff', slice: 0, reason: 'unchanged' },
    { file: 'test/excluded.test.ts', status: 'excluded', slice: 0, reason: 'other tier' },
  ];
  original.entries.push(...reserved);
  const balanced = balancePaidSlices(original, durations);
  expect(wall(balanced)).toBeLessThan(wall(original.entries));
  expect(balanced.filter(entry => reserved.some(row => row.file === entry.file))).toEqual(reserved);
  expect(parseRunManifest(JSON.stringify({ ...original, entries: balanced })).entries).toEqual(balanced);
});

test('the complete gate and periodic census retain retries, registered budgets and reserved lanes', () => {
  for (const tier of ['gate', 'periodic'] as const) {
    const original = buildRunManifest({ tier, profile: 'full', sliceCount: tier === 'gate' ? 6 : 8,
      dedicatedAutoplanSlice: tier === 'periodic', evalsAll: true, env: { EVALS_ALL: '1' } });
    const weights = Object.fromEntries(original.entries.map((entry, index) => [entry.file, (index + 1) * 100]));
    const balanced = balancePaidSlices(original, weights);
    expect(identity(balanced)).toEqual(identity(original.entries));
    expect(parseRunManifest(JSON.stringify({ ...original, entries: balanced })).entries).toEqual(balanced);
    const ordinarySlices = original.sliceCount - Number(tier === 'periodic') - Number(original.entries.some(entry =>
      entry.status === 'planned' && isOverlayTestFile(entry.file)));
    expect(balanced.filter(entry => entry.status === 'planned' && FILE_RETRY_BUDGETS.some(budget => budget.file === entry.file))
      .every(entry => entry.slice < ordinarySlices)).toBe(true);
    for (let jobs = 1; jobs <= original.entries.length; jobs++) {
      const bound = (entries: ManifestEntry[]) => Math.max(...Array.from({ length: original.sliceCount }, (_, index) =>
        paidShardWallUpperBoundMs(entries.filter(entry => entry.status === 'planned' && entry.slice === index + 1)
          .map(entry => entry.file), jobs)));
      expect(bound(balanced)).toBeLessThanOrEqual(bound(original.entries));
    }
  }
});

test('the actual planner consumes a matching timing seed and rejects a different input cohort', () => {
  const root = mkdtempSync(join(tmpdir(), 'paid-durations-'));
  try {
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'test'));
    for (const file of files) writeFileSync(join(root, file), 'export {};\n');
    const options = { tier: 'gate' as const, profile: 'full' as const, sliceCount: 2, evalsAll: true,
      discovered: files, rootDir: root, env: { EVALS_ALL: '1' } };
    const original = buildRunManifest(options);
    const seed = { version: 1, tier: original.tier, profile: original.profile, evalsAll: original.evalsAll,
      selection: original.selection, durations };
    const location = join(root, 'scripts/paid-test-durations.json');
    writeFileSync(location, JSON.stringify(seed));
    const balanced = buildRunManifest(options);
    expect(balanced.entries).toEqual(balancePaidSlices(original, durations));
    expect(wall(balanced.entries)).toBeLessThan(wall(original.entries));
    expect({ ...balanced, entries: [] }).toEqual({ ...original, entries: [] });
    for (const change of [{ version: 2 }, { tier: 'periodic' }, { profile: 'pr' }, { evalsAll: false }, { evalsAll: undefined },
      { selection: { e2e: [], judges: null } }, { durations: {} }, { durations: { [files[0]]: -1 } }]) {
      writeFileSync(location, JSON.stringify({ ...seed, ...change }));
      expect(buildRunManifest(options)).toEqual(original);
    }
    writeFileSync(location, '{');
    expect(buildRunManifest(options)).toEqual(original);
    writeFileSync(location, JSON.stringify(seed));
    expect(loadPaidTestDurations(original, root, { GSTACK_PAID_TEST_DURATIONS: join(root, 'missing') })).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('lightweight coordination uses Ubicloud without changing heavy-worker limits or native coverage', () => {
  const workflow = (name: string): any => Bun.YAML.parse(readFileSync(join(import.meta.dir, '../.github/workflows', name), 'utf8'));
  const free = workflow('free-tests.yml').jobs;
  expect(free['free-plan']['runs-on']).toBe('ubicloud-standard-2');
  expect(free['free-tests']['runs-on']).toBe('ubicloud-standard-2');
  expect(free['free-suite']['runs-on']).toBe('ubicloud-standard-8');
  expect(free['free-suite'].strategy['max-parallel']).toBe(20);
  expect(free['cso-macos-launcher']['runs-on']).toBe('macos-latest');
  expect(free['cso-windows-launcher']['runs-on']).toBe('windows-latest');
  for (const name of ['evals.yml', 'evals-periodic.yml']) {
    const jobs = workflow(name).jobs;
    expect(jobs['plan-slices']['runs-on']).toBe('ubicloud-standard-2');
    expect(jobs['eval-slices']['runs-on']).toBe('ubicloud-standard-8');
    const run = jobs['eval-slices'].steps.find((step: any) => step.name?.startsWith('Run slice'));
    expect(run.env.EVALS_JOBS).toBe('2');
    expect(run.env.EVALS_CONCURRENCY).toBe('2');
  }
  for (const [job, prefix] of [[free['free-suite'], 'free'], [workflow('evals.yml').jobs['eval-slices'], 'paid']] as const) {
    expect(job.steps.find((step: any) => step.run?.includes('ci-resource-metrics.ts')).run).toContain(' -- ');
    const metricUploads = job.steps.filter((step: any) => String(step.with?.name).startsWith(`${prefix}-resources-`));
    expect(metricUploads).toHaveLength(1);
    expect(metricUploads[0].if).toBe("always() && steps.measured.outcome != 'skipped' && steps.measured.outcome != ''");
    expect(metricUploads[0].with['if-no-files-found']).toBe('error');
  }
});
