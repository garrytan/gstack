import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildPaidShardArgs, buildRunManifest, parseCliOptions, parseRunManifest,
  planPaidShards, resolvePaidShardBudget, retriesForFiles, runPaidShard,
  verifySliceResults, type PaidRunManifest, type SliceResult,
} from '../scripts/test-paid-shards';
import { AUTOPLAN_CHAIN_BUDGET as budget, assertPaidTestBudget, ALL_TIERS, PTY_LONG_MS } from './helpers/eval-budgets';

test('the one specified exception fits nested supervision and both unchanged retries', () => {
  for (const ms of [budget.workMs, budget.sessionMs, budget.testMs, budget.shardMs]) {
    expect(Number.isSafeInteger(ms) && ms > 0).toBe(true);
  }
  expect(budget.workMs).toBe(4 * PTY_LONG_MS);
  expect(budget.workMs).toBeLessThan(budget.sessionMs);
  expect(budget.sessionMs).toBeLessThan(budget.testMs);
  expect(budget.testMs * (retriesForFiles([budget.file]) + 1) + budget.shardReserveMs).toBe(budget.shardMs);
  expect(budget.shardMs + budget.ciReserveMs).toBe(budget.ciJobMs);
  expect(Math.max(...Object.values(ALL_TIERS))).toBe(PTY_LONG_MS);
  expect(() => assertPaidTestBudget(budget.file, budget.testMs)).not.toThrow();
  for (const [file, ms] of [[budget.file, budget.testMs + 1], ['test/other.test.ts', budget.testMs],
    [budget.file, Infinity], [budget.file, NaN], [budget.file, -1]] as const) {
    expect(() => assertPaidTestBudget(file, ms)).toThrow('Unregistered');
  }
});

test('only Autoplan receives the default exception and it cannot inflate a packed neighbor', () => {
  expect(resolvePaidShardBudget([budget.file])).toEqual({ timeoutMs: budget.shardMs, source: 'registered', policyId: budget.id });
  expect(resolvePaidShardBudget(['test/other.test.ts'])).toEqual({ timeoutMs: 1_800_000, source: 'default', policyId: null });
  expect(() => resolvePaidShardBudget([budget.file, 'test/other.test.ts'])).toThrow('own shard');
  const shards = planPaidShards(['test/a.test.ts', budget.file, 'test/z.test.ts'], { maxFilesPerShard: 3 });
  expect(shards.find(files => files.includes(budget.file))).toEqual([budget.file]);
  expect(shards.flat().sort()).toEqual(['test/a.test.ts', budget.file, 'test/z.test.ts'].sort());
  for (const value of [NaN, Infinity, -1, 0, 1.5, 2_147_483_648]) {
    expect(() => resolvePaidShardBudget([budget.file], value)).toThrow('timer-safe');
  }
});

test('CLI and environment distinguish user limits from the ordinary default', () => {
  const implicit = parseCliOptions([], {});
  expect(implicit.timeoutMs).toBe(1_800_000);
  expect(implicit.timeoutExplicit).toBe(false);
  for (const explicit of [parseCliOptions(['--timeout', '12'], {}), parseCliOptions([], { EVALS_SHARD_TIMEOUT_MS: '12000' })]) {
    expect(explicit.timeoutExplicit).toBe(true);
    expect(resolvePaidShardBudget([budget.file], explicit.timeoutMs).timeoutMs).toBe(12_000);
  }
  expect(buildPaidShardArgs([budget.file], budget.shardMs, 2, retriesForFiles([budget.file])))
    .toContain('--timeout=' + budget.shardMs);
  expect(retriesForFiles([budget.file])).toBe(1);
  expect(() => parseCliOptions(['--autoplan-slice'], {})).toThrow('--emit-plan');
});

function planned(): PaidRunManifest {
  return buildRunManifest({ tier: 'periodic', sliceCount: 7, dedicatedAutoplanSlice: true,
    evalsAll: true, env: { EVALS_ALL: '1' } });
}

function results(manifest: PaidRunManifest): SliceResult[] {
  return Array.from({ length: manifest.sliceCount }, (_, index) => ({ version: 1, tier: manifest.tier,
    sliceIndex: index + 1, sliceCount: manifest.sliceCount,
    outcomes: manifest.entries.filter(e => e.status === 'planned' && e.slice === index + 1).map(e => ({
      files: [e.file], status: 'passed', exitCode: 0, elapsedMs: 1, executedTests: 1, skippedTests: 0,
      ...(e.budget ? { budget: e.budget } : {}),
    })),
  }));
}

test('the seventh periodic slice isolates Autoplan and retains the full ordinary census', () => {
  const manifest = planned();
  const ordinary = buildRunManifest({ tier: 'periodic', sliceCount: 6, evalsAll: true, env: { EVALS_ALL: '1' } });
  expect(manifest.entries.map(e => e.file)).toEqual(ordinary.entries.map(e => e.file));
  expect(manifest.entries.filter(e => e.slice === 7).map(e => e.file)).toEqual([budget.file]);
  expect(manifest.entries.filter(e => e.file !== budget.file && e.status === 'planned').every(e => e.slice <= 6)).toBe(true);
  expect(parseRunManifest(JSON.stringify(manifest))).toEqual(manifest);
  expect(verifySliceResults(manifest, results(manifest))).toEqual({ ok: true, problems: [] });
  for (const mutate of [
    (m: PaidRunManifest) => { m.entries = m.entries.filter(e => e.file !== budget.file); },
    (m: PaidRunManifest) => { m.entries.push(m.entries.find(e => e.file === budget.file)!); },
    (m: PaidRunManifest) => { m.entries.find(e => e.file === budget.file)!.slice = 1; },
    (m: PaidRunManifest) => { delete m.entries.find(e => e.file === budget.file)!.budget; },
    (m: PaidRunManifest) => { m.entries.find(e => e.file === budget.file)!.budget!.timeoutMs = 999; },
  ]) {
    const invalid = structuredClone(manifest); mutate(invalid);
    expect(() => parseRunManifest(JSON.stringify(invalid))).toThrow();
    expect(verifySliceResults(invalid, results(manifest)).ok).toBe(false);
  }
  expect(verifySliceResults(manifest, results(manifest).slice(0, 6)).ok).toBe(false);
  const duplicate = results(manifest); duplicate[0]!.outcomes.push(duplicate[6]!.outcomes[0]!);
  expect(verifySliceResults(manifest, duplicate).ok).toBe(false);
  for (const change of [
    (o: SliceResult['outcomes'][number]) => { o.executedTests = 0; },
    (o: SliceResult['outcomes'][number]) => { o.skippedTests = 1; },
    (o: SliceResult['outcomes'][number]) => { o.exitCode = 1; },
    (o: SliceResult['outcomes'][number]) => { o.files = ['test/other.test.ts', budget.file]; },
  ]) { const bad = results(manifest); change(bad[6]!.outcomes[0]!); expect(verifySliceResults(manifest, bad).ok).toBe(false); }
  const reordered = structuredClone(manifest);
  const entry = reordered.entries.find(e => e.file === budget.file)!;
  entry.budget = { policyId: budget.id, source: 'registered', timeoutMs: budget.shardMs };
  expect(() => parseRunManifest(JSON.stringify(reordered))).not.toThrow();
  const wrongWall = results(manifest); delete wrongWall[6]!.outcomes[0]!.budget;
  expect(verifySliceResults(manifest, wrongWall).ok).toBe(false);
  const lower = results(manifest); lower[6]!.timeoutOverrideMs = 12000;
  lower[6]!.outcomes[0]!.budget = resolvePaidShardBudget([budget.file], 12000);
  expect(verifySliceResults(manifest, lower).ok).toBe(true);
});

test('a real fake subprocess records the chosen wall and obeys an explicit shorter deadline', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-wall-'));
  try {
    const common = { jobs: 1, log: () => {}, logDir: dir,
      env: { ...process.env, GSTACK_CLAUDE_CLI_VERSION: 'fixture-no-cli' } };
    const pass = await runPaidShard([budget.file], 1, 1, { ...common,
      commandFor: () => ({ command: process.execPath, args: ['-e', 'console.log(" 1 pass\\n 0 fail\\nRan 1 tests across 1 files. [1ms]")'] }) });
    expect(pass.status).toBe('passed');
    expect(pass.budget).toEqual(resolvePaidShardBudget([budget.file]));
    const start = Date.now();
    const stopped = await runPaidShard([budget.file], 1, 1, { ...common, timeoutMs: 150,
      commandFor: () => ({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }) });
    expect(stopped.status).toBe('timed-out');
    expect(stopped.budget).toEqual(resolvePaidShardBudget([budget.file], 150));
    expect(Date.now() - start).toBeLessThan(5000);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}, 10_000);

// Wiring is execution policy: a planner-only seventh slice would silently leave
// the long case unexecuted, or a smaller job cap would preempt both attempts.
test('periodic CI allocates and executes the dedicated seventh slice inside its existing cap', () => {
  const yaml = fs.readFileSync(path.resolve(import.meta.dir, '../.github/workflows/evals-periodic.yml'), 'utf8');
  expect(yaml).toMatch(/--emit-plan[^\n]+--slices 7 --autoplan-slice/);
  const slices = yaml.split('  eval-slices:')[1]!.split('\n  report:')[0]!;
  expect(slices).toContain('slice: [1, 2, 3, 4, 5, 6, 7]');
  expect(slices).toContain('timeout-minutes: 200');
  expect(slices).toContain('EVALS_JOBS: "2"');
  expect(slices).toContain('--plan /tmp/paid-plan/manifest.json --slice ${{ matrix.slice }}');
});
