/**
 * Planner/executor/report contract for the re-platformed paid CI lane.
 *
 * The classes these pin (each was a live CI failure mode of the old
 * hand-enumerated matrix, or a review-identified risk of the migration):
 *  - per-slice selector divergence → ONE planner manifest, executors consume
 *  - hollow lanes → a slice with no artifact is a FAILURE, not an absence
 *  - hollow shards → EVALS_ALL + exit 0 + zero executed tests ≠ pass
 *  - retry policy → a timed-out attempt is a verdict; only short-case files retry
 *  - budget packing → recorded work packs into ~9-minute executors whose count
 *    and CI job timeout come from the plan
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

import {
  applyHollowShardGuard,
  buildPaidShardArgs,
  buildRunManifest,
  loadPaidTestDurations,
  recordedShardMs,
  mergePaidTestDurations,
  packBySliceBudget,
  estimatedSliceMs,
  sliceExecutionOrder,
  sliceSupervisedWallMs,
  writePaidTestDurations,
  CI_SETUP_ALLOWANCE_MINUTES,
  paidShardWallUpperBoundMs,
  parseCliOptions,
  parseRunManifest,
  resolvePaidShardBudget,
  SUPERVISED_WORKER_COUNTS,
  retriesForFiles,
  summarize,
  summaryExitCode,
  verifySliceResults,
  expandTrialShards,
  formatCapacityPreflight,
  panelReports,
  shardSlug,
  sliceCiTimeoutMinutes,
  type PaidRunManifest,
  type ShardOutcome,
  type SliceResult,
} from '../scripts/test-paid-shards';

import { E2E_KINDS } from './helpers/touchfiles-data';

const ROOT = path.resolve(__dirname, '..');

const outcome = (over: Partial<ShardOutcome>): ShardOutcome => ({
  shard: 1,
  files: ['test/skill-e2e-x.test.ts'],
  status: 'passed',
  exitCode: 0,
  elapsedMs: 1000,
  groupPid: null,
  executedTests: 3,
  skippedTests: null,
  ...over,
});

describe('run manifest (planner)', () => {
  test('live build: every paid file appears exactly once; planned slices partition 1..K', () => {
    const manifest = buildRunManifest({ tier: 'gate', sliceCount: 5, evalsAll: true, env: { EVALS_ALL: '1' } });
    const files = manifest.entries.map((e) => e.file);
    expect(new Set(files).size).toBe(files.length);
    const planned = manifest.entries.filter((e) => e.status === 'planned');
    expect(planned.length).toBeGreaterThan(20); // census sanity
    for (const entry of planned) {
      expect(entry.slice).toBeGreaterThanOrEqual(1);
      expect(entry.slice).toBeLessThanOrEqual(5);
    }
    // Live registered files balance supervised time, so file counts can differ.
    expect([...new Set(planned.map(entry => entry.slice))].sort()).toEqual([1, 2, 3, 4, 5]);
    // Uniform, unregistered work retains the original round-robin contract.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-manifest-balance-'));
    try {
      fs.mkdirSync(path.join(dir, 'test'));
      const discovered = Array.from({ length: 12 }, (_, i) => `test/skill-e2e-ordinary-${i}.test.ts`);
      for (const file of discovered) fs.writeFileSync(path.join(dir, file), '// ordinary unregistered fixture');
      const ordinary = buildRunManifest({ tier: 'gate', sliceCount: 5, evalsAll: true,
        env: { EVALS_ALL: '1' }, rootDir: dir, discovered }).entries;
      expect(ordinary).toHaveLength(discovered.length);
      expect(ordinary.every(entry => entry.status === 'planned' && !entry.budget)).toBe(true);
      const sizes = [1, 2, 3, 4, 5].map(i => ordinary.filter(entry => entry.slice === i).length);
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    // Non-runnable entries carry slice 0 and a reason.
    for (const entry of manifest.entries.filter((e) => e.status !== 'planned')) {
      expect(entry.slice).toBe(0);
      expect(entry.reason ?? '').not.toBe('');
    }
  });

  test('deterministic for identical inputs', () => {
    const opts = { tier: 'periodic' as const, sliceCount: 4, evalsAll: true, env: { EVALS_ALL: '1' } };
    expect(buildRunManifest(opts)).toEqual(buildRunManifest(opts));
  });

  test('parse round-trips and rejects malformed manifests', () => {
    // EVALS_ALL short-circuits diff selection BEFORE any git walk: selection
    // is deliberately fail-closed on git errors, and CI's shallow free-tests
    // checkout has no base ref (first CI run failed here with
    // "ambiguous argument 'main...HEAD'").
    const manifest = buildRunManifest({ tier: 'gate', sliceCount: 2, evalsAll: false, env: { EVALS_ALL: '1' } });
    expect(parseRunManifest(JSON.stringify(manifest))).toEqual(manifest);
    expect(() => parseRunManifest('{}')).toThrow(/version/);
    expect(() => parseRunManifest(JSON.stringify({ ...manifest, tier: 'e2e' }))).toThrow(/tier/);
    expect(() => parseRunManifest(JSON.stringify({ ...manifest, sliceCount: 0 }))).toThrow(/sliceCount/);
    const outOfRange = {
      ...manifest,
      entries: [{ file: 'test/skill-e2e-x.test.ts', slice: 9, status: 'planned' }],
    };
    expect(() => parseRunManifest(JSON.stringify(outOfRange))).toThrow(/out-of-range/);
  });
});

describe('recorded-duration slice packing', () => {
  const recorded = loadPaidTestDurations();
  const lanes = (manifest: PaidRunManifest) => {
    const planned = manifest.entries.filter(e => e.status === 'planned');
    return Array.from({ length: manifest.sliceCount }, (_, i) => planned.filter(e => e.slice === i + 1).map(e => e.file));
  };
  const plans = [
    { tier: 'gate' as const, sliceCount: 6 },
    { tier: 'gate' as const, sliceCount: 7 },
    { tier: 'periodic' as const, sliceCount: 7 },
  ];

  test('the committed seed records real wall times for the fast PR profile', () => {
    expect(Object.keys(recorded).length).toBeGreaterThanOrEqual(30);
    expect(Object.values(recorded).every(ms => Number.isInteger(ms) && ms >= 1_000)).toBe(true);
  });

  for (const plan of plans) {
    test(`${plan.tier} x${plan.sliceCount}: no slice's worst-case wall exceeds the supervised baseline's for any worker count`, () => {
      const env = { EVALS_ALL: '1' };
      const packed = lanes(buildRunManifest({ ...plan, evalsAll: true, env }));
      const baseline = lanes(buildRunManifest({ ...plan, evalsAll: true, env, durations: {} }));
      expect(packed.flat().sort()).toEqual(baseline.flat().sort());
      for (const jobs of SUPERVISED_WORKER_COUNTS) {
        const bound = (files: string[]) => paidShardWallUpperBoundMs([...files].sort(), jobs);
        expect(Math.max(...packed.map(bound))).toBeLessThanOrEqual(Math.max(...baseline.map(bound)));
      }
      // Same estimate the planner packs by: this tier's recorded time (a trial uses its case's),
      // else the 75th percentile of recorded files.
      const tierRecorded = loadPaidTestDurations(undefined, plan.tier);
      const known = baseline.flat().map(file => recordedShardMs(tierRecorded, file)).filter((ms): ms is number => ms !== undefined).sort((x, y) => x - y);
      const fallback = known[Math.min(known.length - 1, Math.floor(known.length * 0.75))]!;
      const load = (files: string[]) => files.reduce((sum, file) => sum + (recordedShardMs(tierRecorded, file) ?? fallback), 0);
      expect(Math.max(...packed.map(load))).toBeLessThanOrEqual(Math.max(...baseline.map(load)));
    });
  }

  test('the PR-profile file set spreads recorded time instead of stacking it', () => {
    const env = { EVALS_ALL: '1' };
    // Seed files only: case-shard keys (`<file>#<case>`) come from expansion.
    const discovered = Object.keys(recorded).filter(key => !key.includes('#'));
    const load = (files: string[]) => files.reduce((sum, file) => sum + recorded[file], 0);
    const packed = lanes(buildRunManifest({ tier: 'gate', sliceCount: 6, evalsAll: true, env, discovered })).map(load);
    const baseline = lanes(buildRunManifest({ tier: 'gate', sliceCount: 6, evalsAll: true, env, discovered, durations: {} })).map(load);
    expect(Math.max(...packed)).toBeLessThan(Math.max(...baseline));
    expect(buildRunManifest({ tier: 'gate', sliceCount: 6, evalsAll: true, env, discovered: [...discovered].reverse() }).entries)
      .toEqual(buildRunManifest({ tier: 'gate', sliceCount: 6, evalsAll: true, env, discovered }).entries);
  });

  test('report durations merge only executed single-file outcomes', () => {
    const outcome = (files: string[], elapsedMs: number, over: Partial<ShardOutcome> = {}) =>
      ({ files, status: 'passed', exitCode: 0, elapsedMs, executedTests: 2, skippedTests: 0, ...over }) as SliceResult['outcomes'][number];
    const merged = mergePaidTestDurations({ 'test/b.test.ts': 5_000, 'test/a.test.ts': 9_000 }, [{
      sliceIndex: 1,
      outcomes: [
        outcome(['test/a.test.ts'], 42_000),
        outcome(['test/c.test.ts'], 500),
        outcome(['test/d.test.ts', 'test/e.test.ts'], 60_000),
        outcome(['test/f.test.ts'], 30_000, { executedTests: 2, skippedTests: 2 }),
        outcome(['test/g.test.ts'], 70_000, { status: 'failed', exitCode: 1 }),
      ],
    } as SliceResult]);
    expect(merged).toEqual({ 'test/a.test.ts': 42_000, 'test/b.test.ts': 5_000, 'test/g.test.ts': 70_000 });
    expect(Object.keys(merged)).toEqual(['test/a.test.ts', 'test/b.test.ts', 'test/g.test.ts']);
    expect(() => parseCliOptions(['--write-durations'], {})).toThrow('--write-durations requires --report');
    expect(parseCliOptions(['--report', '/tmp/r', '--write-durations'], {}).writeDurations).toBe(true);
  });
});

describe('budget slice packing', () => {
  const s = (seconds: number) => seconds * 1000;

  test('best-fit packs recorded work under the budget; unknown and over-budget work gets its own runner', () => {
    const recorded = { 'test/a.test.ts': s(500), 'test/b.test.ts': s(300), 'test/c.test.ts': s(240), 'test/d.test.ts': s(100), 'test/long.test.ts': s(900) };
    const files = [...Object.keys(recorded), 'test/unknown.test.ts'];
    const plan = packBySliceBudget(files, s(540), 2, recorded);
    expect(plan.slices.flat().sort()).toEqual([...files].sort());
    expect(plan.estimates['test/unknown.test.ts']).toBe(s(540));
    for (const [index, slice] of plan.slices.entries()) {
      expect(plan.estimatedSliceMs[index]).toBe(estimatedSliceMs(slice, file => plan.estimates[file]!, 2));
      if (slice.length > 1) expect(plan.estimatedSliceMs[index]).toBeLessThanOrEqual(s(540));
    }
    expect(plan.slices).toContainEqual(['test/long.test.ts']);
    expect(plan.slices.find(slice => slice.includes('test/unknown.test.ts'))!.length).toBeLessThanOrEqual(2);
    // Deterministic regardless of discovery order.
    expect(packBySliceBudget([...files].reverse(), s(540), 2, recorded)).toEqual(plan);
    // W2c/ENG-2: per-slice ceilings, not the sum of every shard's worst case; the largest is the single job cap.
    expect(plan.sliceCiTimeoutMinutes).toEqual(plan.slices.map(slice => sliceCiTimeoutMinutes(slice, s(540), 2)));
    expect(plan.ciTimeoutMinutes).toBe(Math.max(...plan.sliceCiTimeoutMinutes));
    expect(Math.max(...plan.slices.map(slice => sliceSupervisedWallMs(slice, 2)))).toBeGreaterThan(plan.ciTimeoutMinutes * 60_000);
    expect(packBySliceBudget([], s(540), 2, recorded)).toMatchObject({ slices: [[]], ciTimeoutMinutes: 18 + CI_SETUP_ALLOWANCE_MINUTES });
  });

  test('overlays keep one final slice at their one-at-a-time admission', () => {
    const overlays = ['test/skill-e2e-overlay-harness-a.test.ts', 'test/skill-e2e-overlay-harness-b.test.ts'];
    const plan = packBySliceBudget(['test/a.test.ts', ...overlays], s(540), 2, { [overlays[0]!]: s(100), [overlays[1]!]: s(200), 'test/a.test.ts': s(10) });
    expect(plan.slices.at(-1)).toEqual([overlays[1], overlays[0]]);
    expect(plan.estimatedSliceMs.at(-1)).toBe(s(300));
  });

  test('live census plans: multi-file slices stay within the budget and the executor runs longest first', () => {
    for (const tier of ['gate', 'periodic'] as const) {
      const manifest = buildRunManifest({ tier, sliceBudgetMs: s(540), jobs: 2, evalsAll: true, env: { EVALS_ALL: '1' } });
      expect(parseRunManifest(JSON.stringify(manifest))).toEqual(manifest);
      for (let slice = 1; slice <= manifest.sliceCount; slice++) {
        const entries = sliceExecutionOrder(manifest.entries.filter(entry => entry.status === 'planned' && entry.slice === slice));
        const estimate = manifest.plan!.estimatedSliceMs[slice - 1]!;
        if (entries.length > 1 && !entries.some(entry => entry.file.includes('overlay-harness'))) expect(estimate, `${tier} slice ${slice}`).toBeLessThanOrEqual(s(540));
        expect(entries.map(entry => entry.estimatedMs)).toEqual([...entries.map(entry => entry.estimatedMs!)].sort((a, b) => b - a));
      }
    }
  });

  test('plans fail closed on malformed metadata, mixed modes, and a worker count the plan did not supervise', () => {
    const manifest = buildRunManifest({ tier: 'gate', sliceBudgetMs: s(540), jobs: 2, evalsAll: true, env: { EVALS_ALL: '1' } });
    for (const broken of [
      { ...manifest, plan: { ...manifest.plan!, estimatedSliceMs: [] } },
      { ...manifest, plan: { ...manifest.plan!, jobs: 0 } },
      { ...manifest, entries: manifest.entries.map(entry => ({ ...entry, estimatedMs: undefined })) },
    ]) expect(() => parseRunManifest(JSON.stringify(broken))).toThrow('slice plan malformed');
    expect(() => buildRunManifest({ tier: 'gate', sliceCount: 2, sliceBudgetMs: s(540), jobs: 2, evalsAll: true })).toThrow('exactly one');
    expect(() => buildRunManifest({ tier: 'gate', sliceBudgetMs: s(540), evalsAll: true })).toThrow('explicit positive --jobs');
    expect(() => parseCliOptions(['--emit-plan', 'x', '--slice-budget', '540'], {})).toThrow('explicit --jobs');
    expect(() => parseCliOptions(['--emit-plan', 'x', '--slice-budget', '540', '--jobs', '2', '--slices', '3'], {})).toThrow('exactly one');
    expect(parseCliOptions(['--emit-plan', 'x', '--slice-budget', '540'], { EVALS_JOBS: '2' }).sliceBudgetMs).toBe(s(540));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paid-plan-jobs-'));
    try {
      const planPath = path.join(dir, 'manifest.json');
      fs.writeFileSync(planPath, JSON.stringify(manifest));
      const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/test-paid-shards.ts'), '--plan', planPath, '--slice', '1', '--list', '--jobs', '1'],
        { cwd: ROOT, encoding: 'utf8', timeout: 10_000, env: { PATH: path.dirname(process.execPath), HOME: dir, EVALS_TIER: 'gate' } });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('manifest was packed for 2 worker(s) per slice');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('the duration seed is per tier and a report rewrite keeps the other tiers', () => {
    const gate = loadPaidTestDurations(ROOT, 'gate');
    const periodic = loadPaidTestDurations(ROOT, 'periodic');
    expect(gate['test/skill-e2e-plan.test.ts']).not.toBe(periodic['test/skill-e2e-plan.test.ts']);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paid-durations-'));
    try {
      fs.mkdirSync(path.join(dir, 'scripts'));
      writePaidTestDurations('periodic', { 'test/p.test.ts': 2_000 }, dir);
      writePaidTestDurations('gate', { 'test/g.test.ts': 3_000 }, dir);
      expect(loadPaidTestDurations(dir, 'gate')).toEqual({ 'test/g.test.ts': 3_000 });
      expect(loadPaidTestDurations(dir, 'periodic')).toEqual({ 'test/p.test.ts': 2_000 });
      fs.writeFileSync(path.join(dir, 'scripts/paid-test-durations.json'), JSON.stringify({ version: 1, durations: { 'test/g.test.ts': 1 } }));
      expect(loadPaidTestDurations(dir, 'gate')).toEqual({});
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('manifest executor scope', () => {
  test('list-only validates and prints the selected manifest slice without launching tests or writing results', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paid-manifest-list-'));
    try {
      const receipt = path.join(dir, 'launched.json');
      const file = path.join(dir, 'skill-e2e-list-probe.test.ts');
      fs.writeFileSync(file, `import { test } from 'bun:test';
import { writeFileSync } from 'node:fs';
test('local launch sentinel', () => writeFileSync(${JSON.stringify(receipt)}, 'true'));`);
      const manifest: PaidRunManifest = {
        version: 1, tier: 'gate', evalsAll: true, sliceCount: 3, selectionReason: 'local list-only fixture',
        entries: [
          { file, slice: 1, status: 'planned' },
          { file: 'test/skill-e2e-plan.test.ts#plan-ceo-review', slice: 2, status: 'planned',
            budget: resolvePaidShardBudget(['test/skill-e2e-plan.test.ts#plan-ceo-review']) },
        ],
      };
      const manifestPath = path.join(dir, 'manifest.json');
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      const evalDir = path.join(dir, 'evals');
      const env = {
        PATH: path.dirname(process.execPath),
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: dir, TMPDIR: dir, TEMP: dir, TMP: dir,
        EVALS_PREFLIGHT_OK: '1', GSTACK_CLAUDE_CLI_VERSION: 'free-fixture', GSTACK_EVAL_DIR: evalDir,
      };
      const run = (args: string[], disablePreflightTools = false) => {
        const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/test-paid-shards.ts'),
          '--plan', manifestPath, '--list', ...args], { cwd: ROOT,
          env: disablePreflightTools ? { ...env, PATH: dir, EVALS_PREFLIGHT_OK: '' } : env,
          encoding: 'utf8', timeout: 10_000 });
        expect(result.error).toBeUndefined();
        expect(fs.existsSync(receipt)).toBe(false);
        expect(fs.existsSync(evalDir)).toBe(false);
        return result;
      };
      const selected = run(['--slice', '1', '--jobs', '1', '--timeout', '5']);
      expect(selected.status, selected.stderr).toBe(0);
      expect(selected.stdout).toContain('slice 1/3: 1 shard(s)');
      expect(selected.stdout).toContain(`${file} wall=5000ms source=explicit policy=none`);
      expect(selected.stdout).not.toContain('skill-e2e-plan.test.ts');
      const noPreflight = run(['--slice', '1'], true);
      expect(noPreflight.status, noPreflight.stderr).toBe(0);
      expect(noPreflight.stdout).toContain(file);
      const registered = run(['--slice', '2']);
      expect(registered.status, registered.stderr).toBe(0);
      expect(registered.stdout).toContain('skill-e2e-plan.test.ts');
      expect(registered.stdout).toContain('source=registered policy=skill-e2e-plan-existing-retry-v1');
      const empty = run(['--slice', '3']);
      expect(empty.status, empty.stderr).toBe(0);
      expect(empty.stdout).toContain('slice 3/3: 0 shard(s)');
      for (const [args, error] of [
        [['--slice', '4'], 'exceeds manifest sliceCount'],
        [['--slice', '1', '--tier', 'periodic'], 'refusing a cross-tier run'],
        [[], '--plan and --slice must be used together'],
      ] as const) {
        const invalid = run([...args]);
        expect(invalid.status).toBe(1);
        expect(invalid.stderr).toContain(error);
      }
      expect(fs.readFileSync(manifestPath, 'utf8')).toBe(JSON.stringify(manifest));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  // Retired (W5a): "an inherited GSTACK_CARVE_SKILL cannot suppress a planned carve case". The variable is gone:
  // each carved skill is its own case shard, so scope is the manifest's case keys (or --case);
  // test/carve-section-sharding.test.ts pins that nothing reads it.
});

describe('slice-result reconciliation (report)', () => {
  const manifest: PaidRunManifest = {
    version: 1,
    tier: 'gate',
    evalsAll: false,
    sliceCount: 2,
    selectionReason: 'test fixture',
    entries: [
      { file: 'test/skill-e2e-a.test.ts', slice: 1, status: 'planned' },
      { file: 'test/skill-e2e-b.test.ts', slice: 2, status: 'planned' },
      { file: 'test/skill-e2e-c.test.ts', slice: 0, status: 'skipped-by-diff', reason: 'unselected' },
    ],
  };
  const slice = (index: number, files: string[], status: ShardOutcome['status'] = 'passed'): SliceResult => ({
    version: 1,
    tier: 'gate',
    sliceIndex: index,
    sliceCount: 2,
    outcomes: files.map((f) => ({ files: [f], status, exitCode: 0, elapsedMs: 5, executedTests: 2, skippedTests: 0 })),
  });

  test('all slices present and passing → ok', () => {
    const verdict = verifySliceResults(manifest, [
      slice(1, ['test/skill-e2e-a.test.ts']),
      slice(2, ['test/skill-e2e-b.test.ts']),
    ]);
    expect(verdict).toEqual({ ok: true, problems: [] });
  });

  test('a missing slice artifact is a FAILURE, not an absence', () => {
    const verdict = verifySliceResults(manifest, [slice(1, ['test/skill-e2e-a.test.ts'])]);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join('\n')).toContain('slice 2/2 reported NO result');
  });

  test('a planned shard nobody reported fails even when its slice reported', () => {
    const verdict = verifySliceResults(manifest, [
      slice(1, []),
      slice(2, ['test/skill-e2e-b.test.ts']),
    ]);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join('\n')).toContain('never reported');
  });

  test('wrong-slice, duplicate, cross-tier, and failing outcomes all surface', () => {
    const wrongSlice = verifySliceResults(manifest, [
      slice(1, ['test/skill-e2e-b.test.ts']),
      slice(2, ['test/skill-e2e-a.test.ts']),
    ]);
    expect(wrongSlice.ok).toBe(false);
    const failing = verifySliceResults(manifest, [
      slice(1, ['test/skill-e2e-a.test.ts'], 'failed'),
      slice(2, ['test/skill-e2e-b.test.ts']),
    ]);
    expect(failing.problems.join('\n')).toContain('test/skill-e2e-a.test.ts: failed');
    const crossTier = verifySliceResults(manifest, [
      { ...slice(1, ['test/skill-e2e-a.test.ts']), tier: 'periodic' },
      slice(2, ['test/skill-e2e-b.test.ts']),
    ]);
    expect(crossTier.problems.join('\n')).toContain('ran tier periodic');
  });
});

describe('hollow-shard guard', () => {
  test('EVALS_ALL: passed with 0 executed tests becomes passed-empty and fails the run', () => {
    const guarded = applyHollowShardGuard([outcome({ executedTests: 0 })], { evalsAll: true, warn: () => {} });
    expect(guarded[0].status).toBe('passed-empty');
    const summary = summarize(guarded);
    expect(summary.failed).toBe(1);
    expect(summaryExitCode(summary)).toBe(1);
  });

  test('selective run: same shape stays passed, warns once', () => {
    const warnings: string[] = [];
    const guarded = applyHollowShardGuard([outcome({ executedTests: 0 })], {
      evalsAll: false, warn: (line) => warnings.push(line),
    });
    expect(guarded[0].status).toBe('passed');
    expect(warnings).toHaveLength(1);
  });

  test('unknown executedTests (null) is never guessed hollow', () => {
    const guarded = applyHollowShardGuard([outcome({ executedTests: null })], { evalsAll: true });
    expect(guarded[0].status).toBe('passed');
  });
});

describe('retry parity', () => {
  test('registered native workflows and overlays run once', () => {
    // Paid evals never retry: a timed-out attempt is the verdict.
    const native = 'test/skill-e2e-plan-ceo-split-overflow.test.ts';
    expect(retriesForFiles([native])).toBe(0);
    expect(retriesForFiles([native.replaceAll('/', '\\')])).toBe(0);
    expect(buildPaidShardArgs([native], 1_800_000, 2, retriesForFiles([native])).join(' ')).toContain('--retry 0');
    const overlay = 'test/skill-e2e-overlay-harness-claude-dedicated-tools-vs-bash.test.ts';
    expect(retriesForFiles([overlay])).toBe(0);
  });
  test('the matrix-era earned retries are retired, and each names a real file', () => {
    // These three old matrix rows earned `retries: 2`; paid evals never retry.
    for (const file of ['test/skill-e2e-office-hours-auto-mode.test.ts', 'test/skill-e2e-plan-mode-no-op.test.ts', 'test/skill-e2e-workflow.test.ts']) {
      expect(fs.existsSync(path.join(ROOT, file)), `stale retry parity entry: ${file}`).toBe(true);
      expect(retriesForFiles([file])).toBe(0);
    }
    expect(retriesForFiles(['test/skill-e2e-retro.test.ts'])).toBe(0);
    expect(retriesForFiles(['test/skill-e2e-review.test.ts'])).toBe(0);
    expect(buildPaidShardArgs(['x'], 1000, 4, 2)).toContain('2');
    expect(buildPaidShardArgs(['x'], 1000, 4).join(' ')).toContain('--retry 0');
  });
});

describe('trial planner (behavior and quarantined panels)', () => {
  const REVIEW = 'test/skill-e2e-review.test.ts';
  const budgetPlan = (tier: 'gate' | 'periodic', kinds: Record<string, 'rule' | 'behavior' | 'judge'>, quarantine: Record<string, unknown> = {}) =>
    buildRunManifest({ tier, sliceBudgetMs: 540_000, jobs: 2, evalsAll: true, env: { EVALS_ALL: '1' },
      kinds: { ...E2E_KINDS, ...kinds }, quarantine });

  test('a behavior case becomes three trial shards on three different slices; its file shard runs the rest', () => {
    const manifest = budgetPlan('gate', { 'review-sql-injection': 'behavior' });
    const trials = manifest.entries.filter(entry => entry.file.startsWith(`${REVIEW}#review-sql-injection~t`));
    expect(trials.map(entry => entry.file)).toEqual([1, 2, 3].map(n => `${REVIEW}#review-sql-injection~t${n}`));
    expect(trials.every(entry => entry.status === 'planned')).toBe(true);
    expect(new Set(trials.map(entry => entry.slice)).size).toBe(3);
    expect(trials[0]!.trial).toEqual({ kind: 'behavior', panel: { n: 3, k: 2 }, quarantined: false });
    const fileShard = manifest.entries.find(entry => entry.file === REVIEW)!;
    expect(fileShard.excludeCases).toEqual(['review-sql-injection']);
    const slugs = manifest.entries.map(entry => shardSlug([entry.file]));
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(parseRunManifest(JSON.stringify(manifest))).toEqual(manifest);
  });

  test('a file whose only tier case is isolated drops its file shard', () => {
    const manifest = budgetPlan('periodic', { 'review-design-lite': 'behavior' });
    expect(manifest.entries.some(entry => entry.file === REVIEW)).toBe(false);
    expect(manifest.entries.filter(entry => entry.file.startsWith(`${REVIEW}#`)).map(entry => entry.file))
      .toEqual([1, 2, 3].map(n => `${REVIEW}#review-design-lite~t${n}`));
  });

  test('a quarantined rule case runs a full panel with k = n', () => {
    const manifest = budgetPlan('gate', {}, { 'review-enum-completeness': { reason: 'r' } });
    const trial = manifest.entries.find(entry => entry.file === `${REVIEW}#review-enum-completeness~t1`)!;
    expect(trial.trial).toEqual({ kind: 'rule', panel: { n: 3, k: 3 }, quarantined: true });
  });

  test('slice-count plans keep trials on different slices too', () => {
    const manifest = buildRunManifest({ tier: 'gate', sliceCount: 5, evalsAll: true, env: { EVALS_ALL: '1' },
      kinds: { ...E2E_KINDS, 'review-sql-injection': 'behavior', 'review-enum-completeness': 'behavior' } });
    for (const id of ['review-sql-injection', 'review-enum-completeness']) {
      const slices = manifest.entries.filter(entry => entry.file.startsWith(`${REVIEW}#${id}~t`)).map(entry => entry.slice);
      expect(new Set(slices).size).toBe(3);
    }
  });

  test('judges and unknown ids cannot be isolated; unknown registrations throw', () => {
    expect(() => budgetPlan('gate', { 'review/SKILL.md workflow': 'behavior' })).toThrow(/Only live E2E cases/);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trial-unknown-'));
    try {
      fs.mkdirSync(path.join(dir, 'test'));
      fs.writeFileSync(path.join(dir, 'test/skill-e2e-x.test.ts'), 'const name = pick(); runSkillTest({ testName: name });');
      expect(() => expandTrialShards(['test/skill-e2e-x.test.ts'], 'gate', dir, {
        kinds: { x: 'behavior' }, touchfiles: { x: ['test/skill-e2e-x.test.ts'] }, tiers: { x: 'gate' },
      })).toThrow(/statically known case registration/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('parse rejects partial panels, shared runners, forged plans and stray exclusions', () => {
    const manifest = budgetPlan('gate', { 'review-sql-injection': 'behavior' });
    const trialFiles = [1, 2, 3].map(n => `${REVIEW}#review-sql-injection~t${n}`);
    const mutate = (fn: (m: PaidRunManifest) => void) => { const m = structuredClone(manifest); fn(m); return JSON.stringify(m); };
    expect(() => parseRunManifest(mutate(m => { m.entries = m.entries.filter(e => e.file !== trialFiles[1]); })))
      .toThrow(/exactly its 3 trials/);
    expect(() => parseRunManifest(mutate(m => {
      const [a, b] = trialFiles.map(f => m.entries.find(e => e.file === f)!);
      b!.slice = a!.slice;
    }))).toThrow(/share a slice/);
    expect(() => parseRunManifest(mutate(m => { m.entries.find(e => e.file === trialFiles[0])!.trial!.panel.k = 1; })))
      .toThrow(/fixed policy panel/);
    expect(() => parseRunManifest(mutate(m => { m.entries.find(e => e.file === trialFiles[0])!.trial = undefined; })))
      .toThrow(/fixed policy panel/);
    expect(() => parseRunManifest(mutate(m => { m.entries.find(e => e.file === REVIEW)!.excludeCases = ['review-design-lite']; })))
      .toThrow(/exclude only cases/);
    expect(() => parseRunManifest(mutate(m => { m.entries.find(e => e.file === REVIEW)!.trial = m.entries.find(e => e.file === trialFiles[0])!.trial; })))
      .toThrow(/Only trial shards/);
  });

  test('capacity preflight names slices, shards, waves and the longest indivisible trial', () => {
    const manifest = budgetPlan('gate', { 'review-sql-injection': 'behavior' });
    const lines = formatCapacityPreflight(manifest, 16).join('\n');
    expect(lines).toContain(`${manifest.sliceCount} slice(s)`);
    expect(lines).toContain('3 trial shard(s)');
    expect(lines).toContain(`wave(s) at max-parallel 16: ${Math.ceil(manifest.sliceCount / 16)}`);
    expect(lines).toMatch(/longest indivisible trial ~\d+\.\dm \(test\/skill-e2e-review\.test\.ts#review-sql-injection~t\d\)/);
  });

  test('durations: trials record their longest wall under the case key and seed their own estimate', () => {
    const key = `${REVIEW}#review-sql-injection`;
    const merged = mergePaidTestDurations({}, [{ version: 1, tier: 'gate', sliceIndex: 1, sliceCount: 1, outcomes: [1, 2, 3].map(n => ({
      files: [`${key}~t${n}`], status: 'passed' as const, exitCode: 0, elapsedMs: n * 60_000, executedTests: 1, skippedTests: 0,
    })) }]);
    expect(merged).toEqual({ [key]: 180_000 });
    const packed = packBySliceBudget([1, 2, 3].map(n => `${key}~t${n}`), 540_000, 2, merged);
    expect(packed.slices).toHaveLength(3);
    expect(Object.values(packed.estimates)).toEqual([180_000, 180_000, 180_000]);
  });

  test('reuse is whole-panel only: a panel mixing reused and fresh trials is INCOMPLETE', () => {
    const manifest = budgetPlan('gate', { 'review-sql-injection': 'behavior' });
    const trials = manifest.entries.filter(entry => entry.trial);
    const reused = { inputKey: 'c'.repeat(64), runId: '1001/1', revision: 'd'.repeat(40), completedAt: 1 };
    const results = (reusedTrials: number[]): SliceResult[] => trials.map(entry => ({ version: 1, tier: 'gate', sliceIndex: entry.slice,
      sliceCount: manifest.sliceCount, outcomes: [{ files: [entry.file], status: 'passed', exitCode: 0, elapsedMs: 1, executedTests: 1, skippedTests: 0,
        trial: { case: 'review-sql-injection', trial: Number(entry.file.slice(-1)), ...entry.trial!, outcome: 'passed', cost_usd: 0, duration_ms: 1 },
        ...(reusedTrials.includes(Number(entry.file.slice(-1))) ? { reused } : {}) }] }));
    expect(panelReports(manifest, results([]), 1)[0]).toMatchObject({ status: 'PASS' });
    expect(panelReports(manifest, results([1, 2, 3]), 1)[0]).toMatchObject({ status: 'PASS' });
    expect(panelReports(manifest, results([2]), 1)[0]).toMatchObject({ status: 'INCOMPLETE', failsLane: true, reason: expect.stringContaining('partial panel reuse') });
  });
});
