/**
 * ship-measure sweep — the weekly off-ship qualification sweep on main
 * (approved by Garry 2026-10-06; docs/TESTING_INTERNALS.md#ship-measure-sweep).
 *
 * With ~130 gate verdicts, an all-green gate is unlikely even when every case
 * is healthy, so flaky cases are measured on main before any ship hits them.
 * The sweep reads eval:pass-rates history (evals-periodic.yml on main plus the
 * branch census runs that pool into it), ranks the gate cases with a failed
 * trial by how much each costs the gate's all-green probability Π(1 − p_i)
 * (p_i: its red-verdict rate shrunk toward the pooled rate, as
 * `eval:pass-rates --reds` computes it; ties broken by the lower per-trial
 * pass rate), and measures the top K at their kind's N on the
 * checked-out head with the same runner and measurement bar /ship uses
 * (scripts/ship-measure.ts, scripts/lib/measure-bar.ts).
 *
 * Spend: ship_measure_sweep_budget_usd (default $150) is a weekly cap enforced
 * through the same admission budget as /ship's loop, shared across the
 * sweep's cases and every sweep report of the last 7 days found under --prior
 * (CI downloads the earlier runs' reports there) and the local sweep root.
 * When the cap is exhausted the sweep stops and lists what it skipped.
 *
 * Every trial is diagnostic: it never becomes a verdict and never enters
 * EVAL_POLICY pooling or series history. The sweep never pushes, commits or
 * opens a pull request; an agent fixes from its report.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CASE_QUARANTINE } from '../test/helpers/periodic-exclude-data';
import { E2E_KINDS, E2E_TIERS, LLM_JUDGE_TOUCHFILES } from '../test/helpers/touchfiles-data';
import { parseCliFlags } from './lib/shard-engine';
import { RED_RATE_SHRINK, verdictsOf } from './lib/eval-history';
import { trialPassed } from './lib/measure-bar';
import { repoSlug } from './lib/ci-history';
import { loadPassRateHistory, type TrialRecord as HistoryRecord } from './eval-flake-rank';
import {
  caseSelectionPreflight, caseSlug, commandRunner, gstackRunner, kindPlan, measureCase, measurementIdentity, readMeasureConfig,
  type MeasureConfig, type MeasureKind, type Measurement, type SpendPool, type TrialRunner,
} from './ship-measure';

const ROOT = path.resolve(import.meta.dir, '..');
const WEEK_MS = 7 * 24 * 3600_000;
export const SWEEP_SCHEMA = 'gstack-ship-measure-sweep/1';

export interface SweepCandidate {
  case: string;
  kind: MeasureKind;
  /** Red-verdict rate over gate history, shrunk toward the pooled rate (K = RED_RATE_SHRINK, as eval:pass-rates --reds). */
  redRate: number;
  reds: number;
  verdicts: number;
  /** Per-trial pass rate over the history window, or null without scored trials. */
  passRate: number | null;
  scoredTrials: number;
  /** All-green probability gained if this case never went red: P / (1 − p_i) − P. */
  contribution: number;
  /** Mean known cost per trial from history (else the gate-wide mean), or null. */
  costPerTrialUsd: number | null;
}

export interface SweepPlan {
  candidates: SweepCandidate[];
  picked: SweepCandidate[];
  /** All-green probability over the latest census's gate verdicts, from history. */
  allGreen: number | null;
  censusCases: string[];
  pooledRate: number;
  /** Per-case shrunk red rates for every case in the latest census. */
  rates: Record<string, number>;
}

const liveCase = (id: string) => Object.hasOwn(E2E_TIERS, id) || Object.hasOwn(LLM_JUDGE_TOUCHFILES, id);
export const sweepKind = (id: string): MeasureKind => (E2E_KINDS[id] as MeasureKind | undefined) ?? (Object.hasOwn(E2E_TIERS, id) ? 'rule' : 'judge');

/**
 * Rank the gate cases history flags: every live, non-quarantined case of the
 * latest gate census with a failed trial in the window, by its contribution
 * to the all-green probability, then by the lower per-trial pass rate. A red
 * verdict here is a lane-failing verdict with at least one failed trial (an
 * INCOMPLETE record-count verdict is a reporting fault, not a flake). Picks
 * the top k.
 */
export function planSweep(records: readonly HistoryRecord[], k: number, opts: { quarantine?: Record<string, unknown> } = {}): SweepPlan {
  const quarantine = opts.quarantine ?? CASE_QUARANTINE;
  const gate = records.filter(r => r.tier === 'gate' && r.policy_version >= 1);
  const verdicts = verdictsOf(gate).filter(v => v.status !== 'SKIPPED');
  const red = (v: (typeof verdicts)[number]) => v.failsLane && v.trials.some(t => t.outcome === 'failed');
  const pooledRate = verdicts.length ? verdicts.filter(red).length / verdicts.length : 0;
  const byCase = new Map<string, { verdicts: number; reds: number }>();
  for (const v of verdicts) {
    const e = byCase.get(v.case) ?? { verdicts: 0, reds: 0 };
    e.verdicts++; if (red(v)) e.reds++;
    byCase.set(v.case, e);
  }
  const rates: Record<string, number> = Object.fromEntries([...byCase].map(([id, e]) => [id, (e.reds + RED_RATE_SHRINK * pooledRate) / (e.verdicts + RED_RATE_SHRINK)]));
  const latestRun = verdicts.map(v => v.run).filter(run => run !== 'local').sort().at(-1) ?? 'local';
  const censusCases = [...new Set(verdicts.filter(v => v.run === latestRun).map(v => v.case))].sort();
  const allGreen = censusCases.length ? censusCases.reduce((p, id) => p * (1 - rates[id]!), 1) : null;
  const scored = gate.filter(r => r.execution === 'executed' && (r.outcome === 'passed' || r.outcome === 'failed'));
  const knownCost = (r: HistoryRecord) => r.execution === 'executed' && r.cost_known !== false && r.cost_usd > 0;
  const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  const gateCost = mean(records.filter(r => r.tier === 'gate' && knownCost(r)).map(r => r.cost_usd));
  const candidates: SweepCandidate[] = [];
  for (const id of censusCases) {
    if (!liveCase(id) || Object.hasOwn(quarantine, id)) continue;
    const trials = scored.filter(r => r.case === id);
    const failedTrials = trials.filter(r => r.outcome === 'failed').length;
    const e = byCase.get(id)!;
    if (failedTrials === 0) continue;
    candidates.push({
      case: id, kind: sweepKind(id), redRate: rates[id]!, reds: e.reds, verdicts: e.verdicts,
      passRate: trials.length ? (trials.length - failedTrials) / trials.length : null, scoredTrials: trials.length,
      contribution: allGreen === null ? 0 : allGreen / (1 - rates[id]!) - allGreen,
      costPerTrialUsd: mean(records.filter(r => r.case === id && knownCost(r)).map(r => r.cost_usd)) ?? gateCost,
    });
  }
  candidates.sort((a, b) => b.contribution - a.contribution || b.redRate - a.redRate || (a.passRate ?? 1) - (b.passRate ?? 1) || (a.case < b.case ? -1 : 1));
  return { candidates, picked: candidates.slice(0, k), allGreen, censusCases, pooledRate, rates };
}

/**
 * A measured case's predicted red-verdict rate: its measured per-trial failure
 * fraction shrunk toward the pooled rate with the same K as history, and for a
 * behavior case the 3-trial panel's red risk 1 − P(at least 2 of 3 pass).
 */
export function measuredRedRate(kind: MeasureKind, failures: number, trials: number, pooledRate: number): number {
  const q = (failures + RED_RATE_SHRINK * pooledRate) / (trials + RED_RATE_SHRINK);
  return kind === 'behavior' ? 1 - ((1 - q) ** 3 + 3 * (1 - q) ** 2 * q) : q;
}

/** Π(1 − p_i) over the census cases, with measured cases' rates replacing history's. */
export function predictedAllGreen(plan: SweepPlan, measured: Record<string, number>): number | null {
  if (plan.allGreen === null) return null;
  return plan.censusCases.reduce((p, id) => p * (1 - (measured[id] ?? plan.rates[id] ?? plan.pooledRate)), 1);
}

export interface SweepRow {
  rank: number;
  case: string;
  kind: MeasureKind;
  historyPassRate: number | null;
  historyTrials: number;
  reds: number;
  verdicts: number;
  redRate: number;
  status: 'planned' | 'measured' | 'budget_exhausted' | 'skipped' | 'error';
  decision: string;
  measuredPasses: number | null;
  measuredTrials: number | null;
  estimatedUsd: number | null;
  actualUsd: number;
  costUnknownTrials: number;
  captures: string | null;
  note: string;
}

export interface SweepReport {
  schema: typeof SWEEP_SCHEMA;
  label: 'diagnostic';
  verdict: null;
  sweepId: string;
  startedAt: string;
  finishedAt: string | null;
  ref: string;
  sha: string;
  dryRun: boolean;
  k: number;
  capUsd: number;
  priorWeekUsd: number;
  /** Charged against the weekly cap by this sweep: known costs plus the estimate for trials whose cost is unknown. */
  chargedUsd: number;
  historyScope: string;
  allGreenBefore: number | null;
  allGreenAfter: number | null;
  censusVerdicts: number;
  rows: SweepRow[];
}

/** Spend charged by sweep reports under dirs started within the last 7 days (deduplicated by sweep id). */
export function weeklySpent(dirs: readonly string[], now: number, excludeId?: string): number {
  const seen = new Map<string, number>();
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir, { recursive: true }) as string[]) {
      if (path.basename(name) !== 'sweep-report.json') continue;
      let report: SweepReport;
      try { report = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as SweepReport; } catch { continue; }
      if (report.schema !== SWEEP_SCHEMA || report.sweepId === excludeId || report.dryRun) continue;
      const started = Date.parse(report.startedAt);
      if (!Number.isFinite(started) || now - started > WEEK_MS || started > now) continue;
      seen.set(report.sweepId, Math.max(seen.get(report.sweepId) ?? 0, report.chargedUsd));
    }
  }
  return [...seen.values()].reduce((a, b) => a + b, 0);
}

const pct = (x: number | null) => x === null ? 'n/a' : `${Math.round(x * 1000) / 10}%`;
const prob = (x: number | null) => x === null || x >= 0.001 || x === 0 ? pct(x) : `${(x * 100).toPrecision(2)}%`;
const money = (x: number | null) => x === null ? 'unknown' : `$${x.toFixed(2)}`;
const cell = (text: string) => text.replace(/\|/g, '/').replace(/\n/g, ' ');

export function formatSweepReport(r: SweepReport): string {
  const rows = r.rows.map(row => `| ${row.rank} | ${cell(row.case)} | ${row.kind} | ${pct(row.historyPassRate)} of ${row.historyTrials} trials; ${row.reds}/${row.verdicts} red verdicts (rate ${pct(row.redRate)}) | `
    + `${row.measuredTrials === null ? '—' : `${row.measuredPasses}/${row.measuredTrials}`} | ${cell(row.decision)} | ${money(row.estimatedUsd)} / ${money(row.actualUsd)}${row.costUnknownTrials ? ` (+${row.costUnknownTrials} unknown)` : ''} | ${row.captures ? `\`${cell(row.captures)}\`` : '—'} |`);
  const noted = r.rows.filter(row => row.status !== 'measured');
  return [
    `## ship-measure sweep${r.dryRun ? ' (dry run: nothing ran, $0)' : ''}: diagnostic measurements, not verdicts`,
    '',
    `Ref ${r.ref} at ${r.sha.slice(0, 12)}; K=${r.k}; weekly cap $${r.capUsd} (charged earlier this week $${r.priorWeekUsd.toFixed(2)}, this sweep $${r.chargedUsd.toFixed(2)}). History: ${r.historyScope}.`,
    '',
    `Predicted gate all-green probability (approximation, assumes independent verdicts, over the latest census's ${r.censusVerdicts} gate verdicts): before ${prob(r.allGreenBefore)} → after ${prob(r.allGreenAfter)}${r.dryRun ? ' (no measurements yet)' : ' (measured cases use this sweep\'s rates)'}.`,
    '',
    '| # | Case | Kind | History rate | Measured | Decision | Cost (est / actual) | Captures |',
    '|---|---|---|---|---|---|---|---|',
    ...(rows.length ? rows : ['| — | no case in the latest gate census has a failed trial or red verdict | | | | | | |']),
    ...(noted.length ? ['', r.dryRun ? 'Plan:' : 'Skipped or stopped:', ...noted.map(row => `- ${row.case}: ${row.note}`)] : []),
    '',
    'Every trial is diagnostic: it never becomes a verdict and never enters pass-rate history. The sweep never pushes or opens a pull request. '
      + 'Fix a BELOW case at its cause, classify a needs-classify case (`ship-measure classify --out <captures root> --case <id> --round baseline ...`), and measure again on the fix.',
  ].join('\n');
}

export interface SweepOptions {
  records: readonly HistoryRecord[];
  historyScope: string;
  k: number;
  capUsd: number;
  config: MeasureConfig;
  outDir: string;
  priorDirs: string[];
  dryRun: boolean;
  parallel: number;
  ref: string;
  sha: string;
  now?: number;
  /** One runner for every case (default: gstack's single-case runner after a selection preflight). */
  runner?: TrialRunner;
  runnerId?: string;
  preflight?: (caseId: string) => { ok: boolean; detail: string };
  identity?: (kind: MeasureKind, trials: number) => Record<string, string>;
  evalDir?: string;
  log?: (line: string) => void;
}

/** Plan, measure in rank order under the weekly cap, and write sweep-report.json/.md after every case. */
export async function runSweep(o: SweepOptions): Promise<SweepReport> {
  const log = o.log ?? ((line: string) => console.log(line));
  const now = o.now ?? Date.now();
  const sweepId = new Date(now).toISOString().replace(/[:.]/g, '-');
  const dir = path.join(o.outDir, `sweep-${sweepId}`);
  fs.mkdirSync(dir, { recursive: true });
  const plan = planSweep(o.records, o.k);
  const priorWeekUsd = weeklySpent([...o.priorDirs, o.outDir], now, sweepId);
  const pool: SpendPool = { label: `weekly sweep cap`, capUsd: o.capUsd, spentUsd: priorWeekUsd };
  const report: SweepReport = {
    schema: SWEEP_SCHEMA, label: 'diagnostic', verdict: null, sweepId, startedAt: new Date(now).toISOString(), finishedAt: null, ref: o.ref, sha: o.sha,
    dryRun: o.dryRun, k: o.k, capUsd: o.capUsd, priorWeekUsd, chargedUsd: 0, historyScope: o.historyScope,
    allGreenBefore: plan.allGreen, allGreenAfter: plan.allGreen, censusVerdicts: plan.censusCases.length, rows: [],
  };
  const save = () => {
    report.chargedUsd = Math.max(0, pool.spentUsd - priorWeekUsd);
    fs.writeFileSync(path.join(dir, 'sweep-report.json'), `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(path.join(dir, 'sweep-report.md'), `${formatSweepReport(report)}\n`);
  };
  const measuredRates: Record<string, number> = {};
  for (const [index, c] of plan.picked.entries()) {
    const n = kindPlan(c.kind, o.config).trials;
    const row: SweepRow = {
      rank: index + 1, case: c.case, kind: c.kind, historyPassRate: c.passRate, historyTrials: c.scoredTrials, reds: c.reds, verdicts: c.verdicts, redRate: c.redRate,
      status: 'planned', decision: 'planned', measuredPasses: null, measuredTrials: null,
      estimatedUsd: c.costPerTrialUsd === null ? null : c.costPerTrialUsd * n, actualUsd: 0, costUnknownTrials: 0, captures: null, note: '',
    };
    report.rows.push(row);
    if (o.dryRun) { row.note = `would measure ${n} trials at ${c.costPerTrialUsd === null ? 'an unknown cost (one calibration trial first)' : `${money(c.costPerTrialUsd)}/trial`}`; save(); continue; }
    if (pool.spentUsd >= pool.capUsd) {
      Object.assign(row, { status: 'skipped', decision: 'skipped', note: `weekly cap $${o.capUsd} exhausted ($${pool.spentUsd.toFixed(2)} charged in the last 7 days)` });
      save();
      continue;
    }
    const selected = (o.preflight ?? caseSelectionPreflight)(c.case);
    if (!selected.ok) { Object.assign(row, { status: 'skipped', decision: 'skipped', note: `selection preflight failed (no paid call made): ${selected.detail}` }); save(); continue; }
    let m: Measurement;
    try {
      m = await measureCase({
        caseId: c.case, kind: c.kind, round: 'baseline', config: o.config, outDir: dir, parallel: o.parallel, costPerTrialUsd: c.costPerTrialUsd, approved: true,
        runner: o.runner ?? gstackRunner(), pool, log,
        identity: () => (o.identity ?? ((kind, trials) => measurementIdentity(kind, trials, o.runnerId ?? 'gstack')))(c.kind, n),
        ...(o.evalDir ? { evalDir: o.evalDir } : {}),
      });
    } catch (error) {
      Object.assign(row, { status: 'error', decision: 'error', note: (error as Error).message });
      save();
      continue;
    }
    const captures = path.relative(o.outDir, path.join(dir, caseSlug(c.case), 'baseline'));
    const decided = m.status === 'measured' && m.decision !== 'void' && m.decision !== 'incomplete';
    Object.assign(row, {
      status: m.status === 'measured' ? 'measured' : 'budget_exhausted', decision: m.status === 'measured' ? m.decision : m.status.replace('_', ' '),
      ...(decided ? { measuredPasses: m.passes, measuredTrials: m.counted } : { measuredPasses: m.trials.filter(t => trialPassed(c.kind, t)).length, measuredTrials: m.trials.length }),
      actualUsd: m.actualUsd, costUnknownTrials: m.costUnknownTrials, captures,
      note: m.status === 'measured' ? m.decisionReason : m.reason ?? '',
    });
    if (decided) {
      measuredRates[c.case] = measuredRedRate(c.kind, m.counted - m.passes, m.counted, plan.pooledRate);
      report.allGreenAfter = predictedAllGreen(plan, measuredRates);
    }
    save();
  }
  report.finishedAt = new Date().toISOString();
  save();
  log(formatSweepReport(report));
  log(`[ship-measure] sweep report: ${path.join(dir, 'sweep-report.md')}`);
  return report;
}

function gitText(args: string[]): string {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', timeout: 30_000 });
  return r.status === 0 ? r.stdout.trim() : 'unknown';
}

/** `ship-measure sweep` CLI. Exits 0 when the sweep completed (whatever it measured), 1 when history was unavailable, 4 on usage errors. */
export async function sweepMain(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const flags: Record<string, string> = {};
  const historyDirs: string[] = [];
  const priorDirs: string[] = [];
  const value = (name: string) => (next: () => string | undefined) => { const v = next(); if (v === undefined) throw new Error(`${name} needs a value`); flags[name] = v; };
  const list = (into: string[], name: string) => (next: () => string | undefined) => { const v = next(); if (v === undefined) throw new Error(`${name} needs a value`); into.push(path.resolve(v)); };
  parseCliFlags(argv, {
    ...Object.fromEntries(['--k', '--cap-usd', '--command', '--jobs', '--out', '--runs', '--repo'].map(name => [name, value(name)])),
    '--history-dir': list(historyDirs, '--history-dir'), '--prior': list(priorDirs, '--prior'), '--dry-run': () => { flags['--dry-run'] = '1'; },
  }, 'Usage: ship-measure sweep [--k K] [--cap-usd USD] [--dry-run] [--history-dir DIR]... [--prior DIR]... [--runs N] [--command \'CMD {case}\'] [--jobs N] [--out DIR]');
  const config = readMeasureConfig();
  const int = (raw: string | undefined, flag: string, fallback: number) => {
    if (raw === undefined) return fallback;
    if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`${flag} needs a positive integer. Received: ${raw}`);
    return Number(raw);
  };
  const capUsd = flags['--cap-usd'] === undefined ? config.sweepBudgetUsd : Number(flags['--cap-usd']);
  if (!Number.isFinite(capUsd) || capUsd <= 0) throw new Error(`--cap-usd needs a positive amount in USD. Received: ${flags['--cap-usd']}`);
  const repo = flags['--repo'] ?? repoSlug(ROOT);
  const history = loadPassRateHistory({ repo, workflow: 'evals-periodic.yml', branch: 'main', runsLimit: int(flags['--runs'], '--runs', 10), dirs: historyDirs, sinceDays: 60 });
  if (history.historyError) { console.error(`[ship-measure] sweep: pass-rate history unavailable (${history.historyError}); nothing measured`); return 1; }
  const outDir = path.resolve(flags['--out'] ?? path.join(process.cwd(), '.context', 'ship-measure'));
  const report = await runSweep({
    records: history.records, historyScope: history.scope, k: int(flags['--k'], '--k', config.sweepCases), capUsd, config, outDir, priorDirs,
    dryRun: flags['--dry-run'] === '1', parallel: int(flags['--jobs'], '--jobs', Number(env.EVALS_JOBS) || 4),
    ref: env.GITHUB_REF_NAME ?? gitText(['rev-parse', '--abbrev-ref', 'HEAD']), sha: env.GITHUB_SHA ?? gitText(['rev-parse', 'HEAD']),
    ...(flags['--command'] ? { runner: commandRunner(flags['--command']), runnerId: `command:${flags['--command']}`, preflight: () => ({ ok: true, detail: 'documented command' }) } : {}),
  });
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${formatSweepReport(report)}\n`);
  return 0;
}
