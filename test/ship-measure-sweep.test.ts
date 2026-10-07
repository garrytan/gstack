/**
 * Free contracts for the weekly off-ship qualification sweep
 * (scripts/ship-measure-sweep.ts): which gate cases it picks from pass-rate
 * history, the predicted all-green probability before and after, the weekly
 * spend cap enforced through the admission budget across earlier sweep
 * reports, the report it writes after every case, and a $0 CLI run (dry run,
 * and a fake single-case command). Nothing here makes a paid call.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EVAL_POLICY } from '../test/helpers/periodic-exclude-data';
import { TRIAL_OUTCOME_SCHEMA, type TrialOutcomeRecord } from '../test/helpers/eval-store';
import { MEASURE_DEFAULTS, type TrialRequest, type TrialResult } from '../scripts/ship-measure';
import { SWEEP_SCHEMA, measuredRedRate, planSweep, predictedAllGreen, runSweep, weeklySpent, type SweepReport } from '../scripts/ship-measure-sweep';

const ROOT = path.resolve(import.meta.dir, '..');
const temps: string[] = [];
const tmp = (prefix: string) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); temps.push(dir); return dir; };
afterAll(() => { for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true }); });

const A = 'ship-skipped-queued-finding';
const B = 'investigate-owned-completion';
const C = 'investigate-owned-abort';
const Q = 'investigate-owned-ending-error';

function record(id: string, run: number, failed: boolean, extra: Partial<TrialOutcomeRecord> = {}): TrialOutcomeRecord {
  return {
    schema: TRIAL_OUTCOME_SCHEMA, case: id, file: `test/${id}.test.ts`, tier: 'gate', kind: 'rule', trial: 1, panel: { n: 1, k: 1 }, attempt: 1,
    outcome: failed ? 'failed' : 'passed', ...(failed ? { failure_class: 'assertion' as const } : {}), duration_ms: 1000, cost_usd: 1,
    policy_version: EVAL_POLICY.version, quarantined: false, execution: 'executed', source: 'shard', run_id: String(run), lane: 'gate',
    series_identity: 's1', model: 'm', cli_version: 'c', recorded_at: `2026-09-${10 + run}T00:00:00Z`, ...extra,
  } as TrialOutcomeRecord;
}

/** Three weekly runs: A red twice, B red once, C never, a periodic case red (not gate), a retired id red. */
function history(): TrialOutcomeRecord[] {
  const out: TrialOutcomeRecord[] = [];
  for (const run of [1, 2, 3]) {
    out.push(record(A, run, run !== 3), record(B, run, run === 2), record(C, run, false));
    out.push(record('retired-case-id', run, true), record('some-periodic-case', run, true, { tier: 'periodic', lane: 'periodic' }));
  }
  return out;
}

describe('picking cases from gate history', () => {
  test('ranks live, non-quarantined gate cases with a red by their cost to the all-green probability, and picks K', () => {
    const withQuarantined = [...history(), ...[1, 2, 3].map(run => record(Q, run, true))];
    expect(planSweep(withQuarantined, 3, { quarantine: {} }).picked.map(c => c.case)).toEqual([Q, A, B]);
    const plan = planSweep(withQuarantined, 2, { quarantine: { [Q]: {} } });
    expect(plan.candidates.map(c => c.case)).toEqual([A, B]);
    expect(plan.picked.map(c => c.case)).toEqual([A, B]);
    const [a, b] = plan.candidates;
    expect(a).toMatchObject({ reds: 2, verdicts: 3, scoredTrials: 3, costPerTrialUsd: 1, kind: 'rule' });
    expect(a!.passRate).toBeCloseTo(1 / 3, 5);
    expect(a!.redRate).toBeGreaterThan(b!.redRate);
    expect(a!.contribution).toBeGreaterThan(b!.contribution);
    expect(plan.censusCases).toEqual([A, B, C, Q, 'retired-case-id'].sort());
    const product = plan.censusCases.reduce((p, id) => p * (1 - plan.rates[id]!), 1);
    expect(plan.allGreen).toBeCloseTo(product, 10);
    expect(planSweep(history(), 1).picked.map(c => c.case)).toEqual([A]);
  });

  test('a measured case replaces its history rate; a behavior rate converts to the 3-trial panel red risk', () => {
    expect(measuredRedRate('rule', 0, 10, 0)).toBe(0);
    expect(measuredRedRate('rule', 1, 10, 0.05)).toBeCloseTo((1 + 4 * 0.05) / 14, 10);
    const q = 2 / 16;
    expect(measuredRedRate('behavior', 2, 12, 0)).toBeCloseTo(1 - ((1 - q) ** 3 + 3 * (1 - q) ** 2 * q), 10);
    const plan = planSweep(history(), 2);
    const after = predictedAllGreen(plan, { [A]: 0 })!;
    expect(after).toBeCloseTo(plan.allGreen! / (1 - plan.rates[A]!), 10);
  });
});

describe('the weekly cap', () => {
  const report = (dir: string, id: string, startedAt: string, chargedUsd: number, dryRun = false) => {
    fs.mkdirSync(path.join(dir, id), { recursive: true });
    fs.writeFileSync(path.join(dir, id, 'sweep-report.json'), JSON.stringify({ schema: SWEEP_SCHEMA, sweepId: id, startedAt, chargedUsd, dryRun }));
  };
  test('sums the last 7 days of sweep reports once each, skipping dry runs, older reports and this sweep', () => {
    const dir = tmp('sweep-prior-');
    const now = Date.parse('2026-10-12T12:00:00Z');
    report(dir, 'a', '2026-10-10T00:00:00Z', 40);
    report(path.join(dir, 'copy'), 'a', '2026-10-10T00:00:00Z', 40);
    report(dir, 'b', '2026-10-06T00:00:00Z', 25);
    report(dir, 'old', '2026-10-01T00:00:00Z', 100);
    report(dir, 'dry', '2026-10-11T00:00:00Z', 0, true);
    report(dir, 'self', '2026-10-12T11:00:00Z', 9);
    expect(weeklySpent([dir], now, 'self')).toBe(65);
    expect(weeklySpent([path.join(dir, 'missing')], now)).toBe(0);
  });
});

describe('running the sweep with a fake runner', () => {
  const fake = (fail: (r: TrialRequest) => boolean) => {
    const calls: TrialRequest[] = [];
    const runner = async (r: TrialRequest): Promise<TrialResult> => { calls.push(r); return fail(r) ? { passed: false, costUsd: 1, failureCause: 'assertion' } : { passed: true, costUsd: 1 }; };
    return { calls, runner };
  };
  const base = (outDir: string, runner: (r: TrialRequest) => Promise<TrialResult>, extra: Partial<Parameters<typeof runSweep>[0]> = {}) => runSweep({
    records: history(), historyScope: 'fixture history', k: 2, capUsd: 150, config: MEASURE_DEFAULTS, outDir, priorDirs: [], dryRun: false, parallel: 5,
    ref: 'main', sha: 'a'.repeat(40), runner, runnerId: 'fake', preflight: () => ({ ok: true, detail: 'fake' }), identity: () => ({ tree: 'fixed' }),
    evalDir: tmp('sweep-history-'), log: () => {}, now: Date.parse('2026-10-12T12:00:00Z'), ...extra,
  });

  test('measures each picked case at its kind\'s N with the bar, writes the report, and predicts the all-green probability after', async () => {
    const outDir = tmp('sweep-out-');
    const run = fake(r => r.caseId === A && r.trial <= 4);
    const report = await base(outDir, run.runner);
    expect(run.calls.filter(c => c.caseId === A)).toHaveLength(10);
    expect(run.calls.filter(c => c.caseId === B)).toHaveLength(10);
    expect(report.rows.map(r => [r.case, r.status, r.decision, `${r.measuredPasses}/${r.measuredTrials}`])).toEqual([[A, 'measured', 'BELOW', '6/10'], [B, 'measured', 'MEETS', '10/10']]);
    expect(report).toMatchObject({ label: 'diagnostic', verdict: null, chargedUsd: 20, priorWeekUsd: 0, k: 2 });
    expect(report.allGreenAfter).not.toBe(report.allGreenBefore);
    const dir = path.join(outDir, `sweep-${report.sweepId}`);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'sweep-report.json'), 'utf8')) as SweepReport;
    expect(saved.rows[0]!.captures).toBe(path.join(`sweep-${report.sweepId}`, A, 'baseline'));
    expect(fs.existsSync(path.join(outDir, saved.rows[0]!.captures!, 't01', 'trial.json'))).toBe(true);
    const md = fs.readFileSync(path.join(dir, 'sweep-report.md'), 'utf8');
    expect(md).toContain('| # | Case | Kind | History rate | Measured | Decision | Cost (est / actual) | Captures |');
    expect(md).toMatch(/Predicted gate all-green probability .*before \d+(\.\d)?% → after \d+(\.\d)?%/);
    expect(md).toContain(`| 1 | ${A} | rule | 33.3% of 3 trials; 2/3 red verdicts`);
    expect(md).toContain('never pushes or opens a pull request');
  });

  test('stops at the weekly cap: a partly funded case stops at the budget, the rest are skipped and listed', async () => {
    const outDir = tmp('sweep-cap-');
    const prior = tmp('sweep-cap-prior-');
    fs.writeFileSync(path.join(prior, 'sweep-report.json'), JSON.stringify({ schema: SWEEP_SCHEMA, sweepId: 'earlier', startedAt: '2026-10-08T00:00:00Z', chargedUsd: 136, dryRun: false }));
    const run = fake(() => false);
    const report = await base(outDir, run.runner, { priorDirs: [prior], capUsd: 150, k: 3, records: history().map(r => r.case === C && r.run_id === '1' ? record(C, 1, true) : r) });
    expect(report.priorWeekUsd).toBe(136);
    // B and C tie (one red in three); ties fall to the case id, so C ranks before B.
    expect(report.rows.map(r => [r.case, r.status])).toEqual([[A, 'measured'], [C, 'budget_exhausted'], [B, 'skipped']]);
    // A partly funded case reports the trials that ran, not the planned N.
    expect([report.rows[1]!.measuredPasses, report.rows[1]!.measuredTrials]).toEqual([4, 4]);
    expect(run.calls).toHaveLength(14);
    expect(report.chargedUsd).toBe(14);
    expect(report.rows[2]!.note).toContain('weekly cap $150 exhausted');
    expect(fs.readFileSync(path.join(outDir, `sweep-${report.sweepId}`, 'sweep-report.md'), 'utf8')).toContain(`- ${B}: weekly cap $150 exhausted`);
  });

  test('a dry run plans and estimates without running anything or charging the cap', async () => {
    const outDir = tmp('sweep-dry-');
    const run = fake(() => false);
    const report = await base(outDir, run.runner, { dryRun: true });
    expect(run.calls).toHaveLength(0);
    expect(report.rows.map(r => [r.case, r.status, r.estimatedUsd])).toEqual([[A, 'planned', 10], [B, 'planned', 10]]);
    expect(report.chargedUsd).toBe(0);
    expect(weeklySpent([outDir], Date.parse('2026-10-12T13:00:00Z'))).toBe(0);
  });

  test('a case whose selection preflight fails is skipped before any paid call', async () => {
    const run = fake(() => false);
    const report = await base(tmp('sweep-preflight-'), run.runner, { k: 1, preflight: () => ({ ok: false, detail: '--list planned nothing' }) });
    expect(report.rows[0]).toMatchObject({ status: 'skipped', note: 'selection preflight failed (no paid call made): --list planned nothing' });
    expect(run.calls).toHaveLength(0);
  });
});

describe('ship-measure sweep CLI ($0)', () => {
  const historyDir = () => {
    const dir = tmp('sweep-cli-history-');
    fs.writeFileSync(path.join(dir, 'trial-outcomes.jsonl'), `${history().map(r => JSON.stringify(r)).join('\n')}\n`);
    return dir;
  };
  const cli = (cwd: string, ...args: string[]) => spawnSync(process.execPath, ['run', path.join(ROOT, 'scripts/ship-measure.ts'), 'sweep', ...args], {
    cwd, encoding: 'utf8', timeout: 120_000, env: { ...process.env, GSTACK_STATE_ROOT: tmp('sweep-cli-state-'), GITHUB_STEP_SUMMARY: '' },
  });

  test('--dry-run reads local history, prints the plan and the before probability, and spends nothing', () => {
    const cwd = tmp('sweep-cli-');
    const r = cli(cwd, '--history-dir', historyDir(), '--k', '2', '--dry-run', '--out', path.join(cwd, 'out'));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('(dry run: nothing ran, $0)');
    expect(r.stdout).toContain(`| 1 | ${A} | rule |`);
    expect(r.stdout).toContain('would measure 10 trials');
  });

  test('a fake single-case command runs the whole sweep end to end at $0', () => {
    const cwd = tmp('sweep-cli-fake-');
    // A Bun script, not a shell stub, so the fake runner also executes on Windows.
    const script = path.join(cwd, 'fake-trial.ts');
    fs.writeFileSync(script, 'console.log("cost_usd: 0");\nif (process.env.GSTACK_SHIP_MEASURE_TRIAL === "3") { console.log("failure_cause: assertion"); process.exit(1); }\nconsole.log(`PASS ${process.argv[2]}`);\n');
    const bun = /\s/.test(process.execPath) ? 'bun' : process.execPath;
    const r = cli(cwd, '--history-dir', historyDir(), '--k', '1', '--cap-usd', '1', '--command', `${bun} ${script} {case}`, '--jobs', '5', '--out', path.join(cwd, 'out'));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`DIAGNOSTIC ${A} baseline: observed 9/10 trials (baseline); MEETS`);
    expect(r.stdout).toMatch(new RegExp(`\\| 1 \\| ${A} \\| rule \\| [^|]+ \\| 9/10 \\| MEETS \\|`));
  });

  test('history that cannot be read fails closed with nothing measured', () => {
    const cwd = tmp('sweep-cli-nohistory-');
    const r = spawnSync(process.execPath, ['run', path.join(ROOT, 'scripts/ship-measure.ts'), 'sweep', '--dry-run', '--repo', 'garrytan/no-such-repo-xyz', '--out', path.join(cwd, 'out')], {
      cwd, encoding: 'utf8', timeout: 120_000, env: { ...process.env, PATH: path.dirname(process.execPath), GSTACK_STATE_ROOT: tmp('sweep-cli-state-') },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('pass-rate history unavailable');
  });
});
