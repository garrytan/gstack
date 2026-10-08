/**
 * Free contracts for scripts/ship-measure.ts, /ship's measure-then-fix runner:
 * per-kind batches decided by the measurement bar (rule trials, behavior
 * trials in panels of 3, judge outputs scored by 3-sample panels; the pure
 * decision table lives in test/ship-measure-bar.test.ts), unique artifact directories, the
 * diagnostic label, the estimated admission budget, the ask-once rule, the
 * repair-round limit, the unmeasured skip, the PR table and the free-suite
 * reruns with the flaky retry off. Every runner here is a fake; nothing paid.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  MEASURE_DEFAULTS, assertDiagnosticDir, formatKindTable, formatReport, freeParallelism, judgeFile, kindPlan,
  measureCase, measureFreeShard, readMeasureConfig, recordUnmeasured,
  type MeasureConfig, type MeasureKind, type TrialRecord, type TrialRequest, type TrialResult,
} from '../scripts/ship-measure';
import type { FreeShardOutcome, RunFreeShardOptions } from '../scripts/test-free-shards';

const ROOT = path.resolve(import.meta.dir, '..');
const temps: string[] = [];
const tmp = (prefix: string) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); temps.push(dir); return dir; };
afterAll(() => { for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true }); });

interface FakeRun { calls: TrialRequest[]; maxConcurrent: number; runner: (r: TrialRequest) => Promise<TrialResult> }
/** A fake trial runner: `outcome(trial)` decides each result; it records calls and peak concurrency. */
function fake(outcome: (trial: number) => TrialResult): FakeRun {
  const run: FakeRun = { calls: [], maxConcurrent: 0, runner: async () => ({ passed: true }) };
  let active = 0;
  run.runner = async (request) => {
    run.calls.push(request);
    active += 1;
    run.maxConcurrent = Math.max(run.maxConcurrent, active);
    await Bun.sleep(2);
    active -= 1;
    return outcome(request.trial);
  };
  return run;
}

const measure = (kind: MeasureKind, run: FakeRun, extra: Partial<Parameters<typeof measureCase>[0]> = {}) => {
  const outDir = extra.outDir ?? tmp('ship-measure-out-');
  return measureCase({
    caseId: 'seeded-case', kind, round: 'baseline', config: MEASURE_DEFAULTS, runner: run.runner, outDir, parallel: 4,
    costPerTrialUsd: 0.5, approved: false, evalDir: tmp('ship-measure-history-'), log: () => {}, identity: () => ({ tree: 'fixed' }), ...extra,
  });
};

describe('per-kind plans and the printed table (CEO-9, DX-7)', () => {
  test('defaults: rule 10, behavior 4 panels of 3 (12), judge 10 outputs; the table prints the bar per kind', () => {
    expect(kindPlan('rule', MEASURE_DEFAULTS)).toMatchObject({ trials: 10, trialsPerUnit: 1, bar: { strict: 9, qualified: 8, floor: 7 }, pooledBar: { trials: 20, strict: 18, qualified: 16 } });
    expect(kindPlan('behavior', MEASURE_DEFAULTS)).toMatchObject({ trials: 12, trialsPerUnit: 3, bar: { strict: 11, qualified: 10, floor: 9 }, pooledBar: { trials: 24, strict: 22, qualified: 20 } });
    expect(kindPlan('judge', MEASURE_DEFAULTS)).toMatchObject({ trials: 10, trialsPerUnit: 1, bar: { strict: 9, qualified: 8, floor: 7 } });
    const table = formatKindTable(MEASURE_DEFAULTS);
    expect(table).toContain('| rule | 10 | 9 of 10 | 8 of 10, every red qualifying | 7 of 10 (or 8 that does not qualify): 10 more on identical inputs, then 18 of 20, or 16 of 20 qualified |');
    expect(table).toContain('| behavior | 12 (4 panels of 3) | 11 of 12 | 10 of 12, every red qualifying | 9 of 12 (or 10 that does not qualify): 12 more on identical inputs, then 22 of 24, or 20 of 24 qualified |');
    expect(table).toContain('| judge | 10 outputs, each its median 3-sample panel | 9 of 10 outputs |');
    expect(table).toContain('$25 total; asks above $2/trial');
    expect(table).toContain('Repair rounds: at most 3');
    expect(table).toContain('never changes a recorded verdict');
    expect(table).toMatch(/more than 30%[^\n]*void[^\n]*redispatched once/);
  });

  test('config keys override defaults; an empty value is the default; an invalid value throws', () => {
    const values: Record<string, string> = { ship_measure_rule_trials: '20', ship_measure_budget_usd: '7.5', ship_rerun_backend: 'ubicloud', ship_measure_max_rounds: '' };
    const config = readMeasureConfig(key => values[key]);
    expect(config).toEqual({ ...MEASURE_DEFAULTS, ruleTrials: 20, budgetUsd: 7.5, rerunBackend: 'ubicloud' });
    expect(kindPlan('rule', config).bar.strict).toBe(18);
    expect(readMeasureConfig(key => ({ ship_measure_sweep_cases: '2', ship_measure_sweep_budget_usd: '12.5' } as Record<string, string>)[key])).toMatchObject({ sweepCases: 2, sweepBudgetUsd: 12.5 });
    expect(() => readMeasureConfig(key => key === 'ship_measure_sweep_budget_usd' ? '-1' : undefined)).toThrow('ship_measure_sweep_budget_usd');
    expect(() => readMeasureConfig(key => key === 'ship_measure_behavior_panels' ? '0' : undefined)).toThrow('ship_measure_behavior_panels');
    expect(() => readMeasureConfig(key => key === 'ship_rerun_backend' ? 'cloud' : undefined)).toThrow('not local or ubicloud');
  });

  test('bin/gstack-config knows every key with its default and rejects a value that would change spend', () => {
    const state = tmp('ship-measure-config-');
    const env = { PATH: process.env.PATH, HOME: state, GSTACK_STATE_ROOT: state };
    const config = (...args: string[]) => spawnSync('bash', [path.join(ROOT, 'bin/gstack-config'), ...args], { encoding: 'utf8', timeout: 30_000, env });
    const defaults = config('defaults').stdout;
    for (const [key, value] of [['ship_measure_rule_trials', '10'], ['ship_measure_behavior_panels', '4'], ['ship_measure_judge_outputs', '10'],
      ['ship_measure_ask_per_trial_usd', '2'], ['ship_measure_budget_usd', '25'], ['ship_measure_max_rounds', '3'], ['ship_rerun_backend', 'local'],
      ['ship_measure_sweep_cases', '5'], ['ship_measure_sweep_budget_usd', '150']]) {
      expect(defaults).toMatch(new RegExp(`${key}:\\s+${value}\\n`));
      expect(config('get', key!).stdout.trim()).toBe(value!);
    }
    expect(config('set', 'ship_measure_budget_usd', '0').status).toBe(1);
    expect(config('set', 'ship_measure_rule_trials', '2.5').status).toBe(1);
    expect(config('set', 'ship_rerun_backend', 'cloud').status).toBe(1);
    expect(config('set', 'ship_measure_sweep_budget_usd', '0').status).toBe(1);
    expect(config('set', 'ship_measure_sweep_cases', 'two').status).toBe(1);
    expect(config('set', 'ship_measure_budget_usd', '12.5').status).toBe(0);
    expect(readMeasureConfig(key => config('get', key).stdout.trim()).budgetUsd).toBe(12.5);
    expect(config('list').stdout).toMatch(/ship_measure_budget_usd:\s+12\.5 \(set/);
  });
});

describe('per-kind batches decided by the measurement bar, with fake runners (ENG-12)', () => {
  test('rule: 8 of 10 needs its reds classified, 9 of 10 MEETS; every trial gets its own diagnostic directory', async () => {
    const red = fake(trial => ({ passed: ![3, 6].includes(trial), costUsd: 0.5, ...(trial === 3 ? { failureCause: 'assertion', failureDetail: 'unsorted list' } : {}) }));
    const m = await measure('rule', red);
    expect(m).toMatchObject({ status: 'measured', label: 'diagnostic', verdict: null, passes: 8, counted: 10, decision: 'needs-classify', next: 'classify' });
    expect(red.calls).toHaveLength(10);
    const dirs = m.trials.map(t => t.dir);
    expect(new Set(dirs).size).toBe(10);
    for (const dir of dirs) {
      expect(path.basename(path.dirname(dir))).toBe('baseline');
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'trial.json'), 'utf8'))).toMatchObject({ label: 'diagnostic', verdict: null, set: 'initial' });
    }
    const saved = JSON.parse(fs.readFileSync(path.join(path.dirname(dirs[0]!), 'measurement.json'), 'utf8'));
    expect(saved).toMatchObject({ label: 'diagnostic', verdict: null, round: 'baseline', passes: 8, decision: 'needs-classify', identity: { tree: 'fixed' } });
    expect(saved.trials.find((t: TrialRecord) => t.trial === 3)).toMatchObject({ failureCause: 'assertion', failureDetail: 'unsorted list' });
    expect((await measure('rule', fake(trial => ({ passed: trial !== 4, costUsd: 0.5 })))).decision).toBe('MEETS');
  });

  test('behavior: 12 trials in panels of 3, decided on the trial count (11 MEETS, 10 needs classifying); a contract violation is a fix round', async () => {
    const oneMiss = await measure('behavior', fake(trial => ({ passed: trial !== 7 })));
    expect(oneMiss).toMatchObject({ passes: 11, counted: 12, decision: 'MEETS' });
    expect(oneMiss.trials.map(t => t.unit)).toEqual([1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4]);
    expect((await measure('behavior', fake(trial => ({ passed: trial > 2 })))).decision).toBe('needs-classify');
    const contract = await measure('behavior', fake(trial => ({ passed: true, ...(trial === 5 ? { contract: true } : {}) })));
    expect(contract).toMatchObject({ passes: 11, decision: 'BELOW', next: 'fix' });
  });

  test('judge: an output passes at 2 of its 3 samples, whatever the runner claimed; 9 of 10 outputs MEETS', async () => {
    const judged = await measure('judge', fake(trial => ({ passed: true, samples: trial === 2 ? [true, false, false] : [true, false, true] })));
    expect(judged).toMatchObject({ passes: 9, decision: 'MEETS' });
    const red = await measure('judge', fake(trial => ({ passed: true, samples: trial <= 2 ? [false, false, true] : [true, true, true] })));
    expect(red).toMatchObject({ passes: 8, decision: 'needs-classify' });
    const wrongCount = await measure('judge', fake(() => ({ passed: true, samples: [true, true] })));
    expect(wrongCount).toMatchObject({ passes: 0, decision: 'BELOW' });
  });

  test('standalone judge ids resolve to the one paid file that names them', () => {
    expect(judgeFile('review/SKILL.md workflow')).toBe('test/skill-llm-eval.test.ts');
    expect(() => judgeFile('no-such-judge-id')).toThrow('no paid file names it');
  });
});

describe('spend, approval, rounds and artifacts', () => {
  test('admission budget: each batch reserves every concurrent trial and stops before reserved plus spent passes the budget', async () => {
    const run = fake(() => ({ passed: false, costUsd: 3 }));
    const outDir = tmp('ship-measure-budget-');
    const baseline = await measure('rule', run, { outDir, costPerTrialUsd: 3, approved: true });
    // $25 at $3/trial with 4 parallel: 4 (12) + 4 (24), then $1 of headroom admits nothing.
    expect(baseline).toMatchObject({ status: 'budget_exhausted', estimatedUsd: 24, actualUsd: 24 });
    expect(baseline.trials.map(t => t.batch)).toEqual([1, 1, 1, 1, 2, 2, 2, 2]);
    expect(run.maxConcurrent).toBeLessThanOrEqual(4);
    expect(baseline.reason).toContain('8 of 10 initial trials ran');
    // The budget is per red case: a repair round starts from what the baseline spent.
    const round = await measure('rule', fake(() => ({ passed: true, costUsd: 3 })), { outDir, round: 'round-1', costPerTrialUsd: 3 });
    expect(round.status).toBe('budget_exhausted');
    expect(round.trials).toHaveLength(0);
  });

  test('actual costs are reconciled after each batch, so cheaper trials admit more', async () => {
    const m = await measure('rule', fake(() => ({ passed: true, costUsd: 1 })), { costPerTrialUsd: 2.5, approved: true, config: { ...MEASURE_DEFAULTS, budgetUsd: 12 } });
    // Batch 1 reserves 4 x 2.5 = 10 but spends 4; batch 2 then fits 3 (8 / 2.5); batch 3 fits 2 (5 / 2.5); batch 4 one more.
    expect(m.trials.map(t => t.batch)).toEqual([1, 1, 1, 1, 2, 2, 2, 3, 3, 4]);
    expect(m).toMatchObject({ status: 'measured', actualUsd: 10, estimatedUsd: 25, decision: 'MEETS' });
  });

  test('asks once: no estimate or a per-trial estimate above the threshold runs nothing until approved', async () => {
    const outDir = tmp('ship-measure-ask-');
    const run = fake(() => ({ passed: true, costUsd: 0.75 }));
    const unknown = await measure('rule', run, { outDir, costPerTrialUsd: null });
    expect(unknown).toMatchObject({ status: 'needs_approval' });
    expect(unknown.reason).toContain('estimate unknown');
    expect(run.calls).toHaveLength(0);
    expect(fs.existsSync(path.join(outDir, 'seeded-case', 'baseline'))).toBe(false);
    const approved = await measure('rule', run, { outDir, costPerTrialUsd: null, approved: true });
    // No estimate: one calibration trial alone, then batches at its actual cost.
    expect(approved.trials.map(t => t.batch)).toEqual([1, 2, 2, 2, 2, 3, 3, 3, 3, 4]);
    expect(approved).toMatchObject({ status: 'measured', estimatedUsd: null, actualUsd: 7.5 });
    // The answer is recorded: the next round does not ask again.
    const next = await measure('rule', run, { outDir, round: 'round-1', costPerTrialUsd: null });
    expect(next.status).toBe('measured');
    const pricey = await measure('rule', fake(() => ({ passed: true })), { costPerTrialUsd: 2.01 });
    expect(pricey.status).toBe('needs_approval');
    expect(pricey.reason).toContain('above $2/trial');
  });

  test('the repair-round limit stops with a named red and never runs a trial', async () => {
    const run = fake(() => ({ passed: true }));
    const m = await measure('rule', run, { round: 'round-4' });
    expect(m).toMatchObject({ status: 'round_limit' });
    expect(run.calls).toHaveLength(0);
    await expect(measure('rule', run, { round: 'round-x' })).rejects.toThrow('baseline or round-N');
  });

  test('measurements are never overwritten and never land in the eval history dir', async () => {
    const outDir = tmp('ship-measure-unique-');
    await measure('rule', fake(() => ({ passed: true })), { outDir });
    await expect(measure('rule', fake(() => ({ passed: true })), { outDir })).rejects.toThrow('never overwritten');
    const history = tmp('ship-measure-evals-');
    expect(() => assertDiagnosticDir(path.join(history, 'ship-measure'), history)).toThrow('never recorded as verdicts');
    await expect(measure('rule', fake(() => ({ passed: true })), { outDir: path.join(history, 'x'), evalDir: history })).rejects.toThrow('eval history dir');
  });

  test('unmeasured skip is labeled in the report and never counts as a pass; the table shows estimated and actual spend', async () => {
    const outDir = tmp('ship-measure-report-');
    await measure('rule', fake(trial => ({ passed: ![2, 5, 9].includes(trial), costUsd: 0.25 })), { outDir });
    await measure('rule', fake(() => ({ passed: true, costUsd: 0.25 })), { outDir, round: 'round-1', fix: 'sort the shuffled list in src/order.js' });
    recordUnmeasured(outDir, 'browse-basic', 'provider outage before the first turn');
    expect(() => recordUnmeasured(outDir, 'other', ' ')).toThrow('--reason');
    const report = formatReport(outDir);
    expect(report).toContain('| seeded-case | rule | baseline | observed 7/10 | 9/10 strict, 8/10 qualified | needs-classify | $5.00 | $2.50 |');
    expect(report).toContain('| seeded-case | rule | round-1: after fix at sort the shuffled list in src/order.js | observed 10/10 | 9/10 strict, 8/10 qualified | MEETS | $5.00 | $2.50 |');
    expect(report).toContain('| browse-basic | — | — | — | — | unmeasured (provider outage before the first turn); not a pass | — | — |');
    expect(report).toContain('never change a recorded verdict');
  });

  test('a measurement in the older v1 format is listed as not read instead of crashing the report', () => {
    const outDir = tmp('ship-measure-report-v1-');
    const dir = path.join(outDir, 'old-case');
    fs.mkdirSync(path.join(dir, 'round-1'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'ledger.json'), JSON.stringify({ rounds: ['round-1'] }));
    fs.writeFileSync(path.join(dir, 'round-1', 'measurement.json'), JSON.stringify({
      schema: 'gstack-ship-measure/1', label: 'diagnostic', verdict: null, case: 'old-case', kind: 'rule', round: 'round-1',
      status: 'measured', plan: { kind: 'rule', units: 10, trialsPerUnit: 1, trials: 10, unitTarget: 9, trialTarget: 9 }, trials: [],
    }));
    expect(formatReport(outDir)).toContain('| old-case | rule | round-1 | — | — | older measurement format (gstack-ship-measure/1); not read, re-measure on this release | — | — |');
  });
});

describe('ship-measure CLI with a documented single-case command', () => {
  test('runs the command per trial (no shell), reads its cost and cause lines, and exits by target', () => {
    const project = tmp('ship-measure-cli-');
    const state = tmp('ship-measure-cli-state-');
    fs.writeFileSync(path.join(project, 'evals.sh'), `#!/usr/bin/env bash
echo "case=$2 trial=$GSTACK_SHIP_MEASURE_TRIAL label=$GSTACK_SHIP_MEASURE_LABEL"
echo "cost_usd: 0.10"
if [ "$GSTACK_SHIP_MEASURE_TRIAL" = 2 ]; then echo "failure_cause: assertion"; echo "failure_detail: order.js:3 unsorted"; exit 1; fi
`, { mode: 0o755 });
    const cli = (...args: string[]) => spawnSync(process.execPath, ['run', path.join(ROOT, 'scripts/ship-measure.ts'), ...args], {
      cwd: project, encoding: 'utf8', timeout: 60_000, env: { ...process.env, GSTACK_HOME: state, GSTACK_STATE_ROOT: state },
    });
    const out = path.join(project, '.context', 'ship-measure');
    const red = cli('measure', '--case', 'flaky-sort', '--command', './evals.sh case {case}', '--cost-per-trial', '0.1', '--jobs', '3');
    expect(red.stdout).toContain('| rule | 10 | 9 of 10 |');
    expect(red.stdout).toContain('DIAGNOSTIC flaky-sort baseline: observed 9/10 trials (baseline); MEETS');
    expect(red.status).toBe(0);
    const trial2 = JSON.parse(fs.readFileSync(path.join(out, 'flaky-sort', 'baseline', 't02', 'trial.json'), 'utf8'));
    expect(trial2).toMatchObject({ passed: false, costUsd: 0.1, failureCause: 'assertion', failureDetail: 'order.js:3 unsorted', label: 'diagnostic' });
    expect(fs.readFileSync(path.join(out, 'flaky-sort', 'baseline', 't02', 'output.log'), 'utf8')).toContain('case=flaky-sort trial=2 label=diagnostic');
    const ask = cli('measure', '--case', 'flaky-sort', '--round', 'round-1', '--command', './evals.sh case {case}', '--cost-per-trial', '5', '--out', path.join(project, 'other'));
    expect(ask.status).toBe(2);
    expect(ask.stdout).toContain('NEEDS APPROVAL');
    const limit = cli('measure', '--case', 'flaky-sort', '--round', 'round-4', '--command', './evals.sh case {case}', '--cost-per-trial', '0.1');
    expect(limit.status).toBe(3);
    expect(limit.stdout).toContain('NAMED RED');
    const missing = cli('measure', '--case', 'flaky-sort');
    expect(missing.status).toBe(4);
    expect(missing.stderr).toContain('No single-case eval command');
    expect(cli('skip', '--case', 'browse-basic', '--reason', 'runner lost').status).toBe(0);
    expect(cli('report').stdout).toContain('unmeasured (runner lost); not a pass');
  });
});

describe('free-suite shard reruns (CEO-1)', () => {
  const outcome = (files: string[], status: FreeShardOutcome['status'], failing: string[] = []): FreeShardOutcome => ({
    shard: 1, files, status, exitCode: status === 'passed' ? 0 : 1, elapsedMs: 5, groupPid: null, failingFiles: failing, unattributedFailures: 0,
  } as FreeShardOutcome);

  test('reruns the exact file list with the flaky retry off, fresh state per rerun, baseline alone, and records every outcome', async () => {
    const files = ['test/a.test.ts', 'test/b.test.ts'];
    const seen: Array<{ files: string[]; shard: number; options: RunFreeShardOptions; concurrentAtStart: number }> = [];
    let active = 0;
    const runShard = async (shardFiles: string[], shard: number, _total: number, options: RunFreeShardOptions = {}) => {
      seen.push({ files: shardFiles, shard, options, concurrentAtStart: ++active });
      await Bun.sleep(5);
      active -= 1;
      return outcome(shardFiles, [3, 7].includes(shard) ? 'failed' : 'passed', [3, 7].includes(shard) ? ['test/b.test.ts'] : []);
    };
    const m = await measureFreeShard({ files, reruns: 10, concurrency: 1, cores: 3, wallCapMs: 60_000, outDir: tmp('ship-measure-free-'), runShard, log: () => {} });
    expect(m).toMatchObject({ label: 'diagnostic', verdict: null, reruns: 10, completed: 10, passed: 8, parallel: 3, capHit: false });
    expect(m.outcomes.map(o => o.status)).toEqual(['passed', 'passed', 'failed', 'passed', 'passed', 'passed', 'failed', 'passed', 'passed', 'passed']);
    expect(m.outcomes[2]!.failingFiles).toEqual(['test/b.test.ts']);
    expect(m.outcomes[0]!.mode).toBe('baseline');
    expect(m.outcomes.slice(1).every(o => o.mode === 'parallel')).toBe(true);
    const first = seen.find(s => s.shard === 1)!;
    expect(first.concurrentAtStart).toBe(1);
    expect(Math.max(...seen.map(s => s.concurrentAtStart))).toBeLessThanOrEqual(3);
    for (const s of seen) {
      expect(s.files).toEqual(files);
      expect(s.options.env?.GSTACK_FREE_RETRY_FLAKY).toBe('0');
      expect(s.options.homeGuard?.name).toBe('privateFreeHome');
    }
    const roots = new Set(seen.map(s => s.options.env?.GSTACK_STATE_ROOT));
    expect(roots.size).toBe(10);
    expect(new Set(seen.map(s => s.options.logFilePath)).size).toBe(10);
    const saved = JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(m.outcomes[0]!.log)), 'free-measurement.json'), 'utf8'));
    expect(saved).toMatchObject({ label: 'diagnostic', verdict: null, passed: 8, completed: 10 });
  });

  test('the wall cap reports a partial count and never starts a rerun after it', async () => {
    const runShard = async (files: string[], _shard: number, _total: number, options: RunFreeShardOptions = {}) => {
      const wait = Math.min(options.wallTimeoutMs ?? 40, 40);
      await Bun.sleep(wait);
      return outcome(files, wait < 40 ? 'timed-out' : 'passed');
    };
    const lines: string[] = [];
    const m = await measureFreeShard({ files: ['test/a.test.ts'], reruns: 10, concurrency: 1, cores: 1, wallCapMs: 150, outDir: tmp('ship-measure-cap-'), runShard, log: line => lines.push(line) });
    expect(m.capHit).toBe(true);
    expect(m.completed).toBeGreaterThan(0);
    expect(m.completed).toBeLessThan(10);
    expect(m.outcomes.length).toBeLessThan(10);
    expect(lines.join('\n')).toContain(`${m.completed} of 10 completed (wall cap 0s)`);
  });

  test('parallelism is max(1, floor(cores / shard concurrency))', () => {
    expect(freeParallelism(16, 1)).toBe(16);
    expect(freeParallelism(16, 3)).toBe(5);
    expect(freeParallelism(2, 4)).toBe(1);
  });

  test('the Ubicloud diagnostic launcher turns the flaky retry off and runs ship-measure free; the normal lane keeps it on', () => {
    const dir = tmp('ship-measure-ubi-');
    fs.mkdirSync(path.join(dir, 'scripts', 'ubicloud'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'scripts/ubicloud/test-free.sh'), path.join(dir, 'scripts/ubicloud/test-free.sh'));
    fs.writeFileSync(path.join(dir, 'scripts/ubicloud/ubi-runner.sh'), '#!/usr/bin/env bash\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    const launch = (...args: string[]) => spawnSync('bash', [path.join(dir, 'scripts/ubicloud/test-free.sh'), ...args], { encoding: 'utf8', timeout: 10_000 });
    const diagnostic = launch('--diagnostic', '--files', 'test/a.test.ts,test/b.test.ts', '--reruns', '10');
    expect(diagnostic.status).toBe(0);
    const args = diagnostic.stdout.split('\n');
    expect(args).toContain('GSTACK_FREE_RETRY_FLAKY=0');
    expect(args).not.toContain('GSTACK_FREE_RETRY_FLAKY=1');
    expect(args).toContain('xvfb-run -a bun run scripts/ship-measure.ts free --backend local --files test/a.test.ts,test/b.test.ts --reruns 10');
    expect(args.some(a => a.startsWith('work/') && a.includes('/.context/ship-measure:'))).toBe(true);
    const normal = launch().stdout.split('\n');
    expect(normal).toContain('GSTACK_FREE_RETRY_FLAKY=1');
    expect(normal).toContain('xvfb-run -a bun run test:free ');
  });
});

describe('diagnostic trials prove they ran and never touch the judge cache', () => {
  const fs2 = require('node:fs') as typeof import('node:fs');
  const os2 = require('node:os') as typeof import('node:os');
  const path2 = require('node:path') as typeof import('node:path');
  const { junitExecuted, diagnosticBaseEnv } = require('../scripts/ship-measure');
  const junit = (cases: string) => `<?xml version="1.0"?><testsuites><testsuite name="x">${cases}</testsuite></testsuites>`;
  function dirWith(xml: string | null) {
    const d = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'ship-measure-junit-'));
    if (xml !== null) { fs2.mkdirSync(path2.join(d, 't1/shards/a'), { recursive: true }); fs2.writeFileSync(path2.join(d, 't1/shards/a/junit.xml'), xml); }
    return d;
  }
  test('an exit-0 trial with no executed testcase is not a pass', () => {
    expect(junitExecuted(dirWith(null))).toBe(false);
    expect(junitExecuted(dirWith(junit('')))).toBe(false);
    expect(junitExecuted(dirWith(junit('<testcase name="a"><skipped/></testcase>')))).toBe(false);
    expect(junitExecuted(dirWith(junit('<testcase name="a"><failure message="x"/></testcase>')))).toBe(false);
    expect(junitExecuted(dirWith(junit('<testcase name="a" time="1"/>')))).toBe(true);
    expect(junitExecuted(dirWith(junit('<testcase name="a" time="1"></testcase><testcase name="b"><skipped/></testcase>')))).toBe(true);
  });
  test('the judge input cache is never inherited by a diagnostic trial; each trial gets its own run id', () => {
    const env = diagnosticBaseEnv({ EVALS_CACHE_DIR: '/c', EVALS_CACHE_RUNTIME_ID: 'img', KEEP: '1' }, '/e', 'case-baseline-t3');
    expect(env).not.toHaveProperty('EVALS_CACHE_DIR');
    expect(env).not.toHaveProperty('EVALS_CACHE_RUNTIME_ID');
    expect(env).toMatchObject({ KEEP: '1', GSTACK_EVAL_DIR: '/e', GSTACK_SHIP_MEASURE_LABEL: 'diagnostic', EVALS_RUN_ID: 'local-measure-case-baseline-t3' });
    // Every trial has its own run id (evidence-retaining cases refuse to start without one); CI's id is kept as the prefix.
    expect(diagnosticBaseEnv({ EVALS_RUN_ID: 'ci-9-1-eval-sweep' }, '/e', 'x-t1').EVALS_RUN_ID).toBe('ci-9-1-eval-sweep-measure-x-t1');
  });
});

describe('the measure CLI proves --case selection before any paid trial', () => {
  test('a real case plans its own test file, in file mode or name mode; an unknown case is refused', () => {
    const { caseSelectionPreflight } = require('../scripts/ship-measure');
    expect(caseSelectionPreflight('ship-measure-seeded-flake')).toEqual({ ok: true, detail: '--case ship-measure-seeded-flake selects test/skill-e2e-ship-measure-loop.test.ts' });
    expect(caseSelectionPreflight('no-such-case').ok).toBe(false);
    // A name-mode case (one of several in its file) lists its trial shard as <file>#<id>~t1.
    expect(caseSelectionPreflight('ship-exploratory-late-input')).toEqual({ ok: true, detail: '--case ship-exploratory-late-input selects test/skill-e2e-qa-callers.test.ts' });
  });
});
