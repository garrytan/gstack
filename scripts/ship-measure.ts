#!/usr/bin/env bun
/**
 * ship-measure — /ship's measure-then-fix runner for a red eval case or a red
 * free-suite shard, and the weekly off-ship qualification sweep. Every trial
 * it runs is DIAGNOSTIC: it never changes a recorded verdict, its artifacts
 * are labeled `diagnostic` with `verdict: null`, and they live under
 * `.context/ship-measure/`, never in the project eval dir that pass-rate
 * history and CI uploads read. The lane verdict still comes from the one full
 * gate run /ship makes after the case measures at or above the bar
 * (docs/TESTING_INTERNALS.md#ship-measure).
 *
 * Trials per batch (config keys in bin/gstack-config): rule
 * ship_measure_rule_trials (10); behavior ship_measure_behavior_panels panels
 * of 3 (4, so 12 trials); judge ship_measure_judge_outputs outputs (10), each
 * scored by its median 3-sample panel. The decision is the measurement bar in
 * scripts/lib/measure-bar.ts: MEETS at 9/10, MEETS-qualified at 8/10 with
 * every red in a qualifying class, EXTEND at 7/10 (N more trials on identical
 * inputs, decided once on the pooled 2N), else BELOW (a fix round). A batch
 * with more than 30% provider-evidence failures is void and is redispatched
 * once.
 *
 * Spend: ship_measure_budget_usd is an estimated ADMISSION budget per red case
 * across the baseline, extension, redispatch and every repair round. Before
 * each batch the runner reserves the estimated cost of every concurrent trial
 * and admits only what fits beside what was already spent; actual costs are
 * reconciled after the batch. With no per-trial estimate it asks once
 * ("estimate unknown"), then runs one calibration trial alone.
 * ship_measure_ask_per_trial_usd asks first above that per-trial estimate.
 * ship_measure_max_rounds caps repair rounds.
 *
 * Usage:
 *   bun run scripts/ship-measure.ts table
 *   bun run scripts/ship-measure.ts measure --case ID --round baseline|round-N
 *       [--kind rule|behavior|judge] [--command 'CMD {case}'] [--cost-per-trial USD]
 *       [--approved] [--fix TEXT] [--jobs N] [--out DIR]
 *   bun run scripts/ship-measure.ts classify --case ID --round R --trials 2,5 --class C --evidence TEXT [--out DIR]
 *   bun run scripts/ship-measure.ts decide --case ID --round R [--out DIR]
 *   bun run scripts/ship-measure.ts extend --case ID --round R [--command ..] [--cost-per-trial USD] [--jobs N] [--out DIR]
 *   bun run scripts/ship-measure.ts skip --case ID --reason TEXT [--out DIR]
 *   bun run scripts/ship-measure.ts report [--out DIR]
 *   bun run scripts/ship-measure.ts free (--files a,b,... | --shard I) [--reruns N]
 *       [--concurrency C] [--backend local|ubicloud] [--wall-cap SECS] [--out DIR]
 *   bun run scripts/ship-measure.ts sweep [--k K] [--cap-usd USD] [--dry-run] [--history-dir DIR]...
 *       [--prior DIR] [--command 'CMD {case}'] [--jobs N] [--out DIR]   (scripts/ship-measure-sweep.ts)
 *
 * measure, extend, classify and decide exit 0 at MEETS or MEETS-qualified, 1
 * at BELOW (a fix round), 2 when it needs the user's approval (nothing ran), 3
 * on a named-red stop (budget exhausted, round limit, a void batch twice), 4 on
 * a usage, setup or refused-classification error, 5 at needs-classify, 6 at
 * EXTEND. free exits 0 when every completed rerun passed, else 1.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { EVAL_POLICY } from '../test/helpers/periodic-exclude-data';
import { E2E_KINDS, E2E_TIERS, LLM_JUDGE_TOUCHFILES } from '../test/helpers/touchfiles-data';
import { getClaudeCliVersion, getProjectEvalDir, isFinalizedEvalResultFile } from '../test/helpers/eval-store';
import { parseCliFlags } from './lib/shard-engine';
import { collectPaidTestFiles, paidSelectionEnv } from './lib/paid-select';
import { DEFAULT_JOBS } from './lib/paid-types';
import { privateFreeHome } from './lib/free-home-guard';
import {
  FAILURE_CLASSES, barThresholds, classificationProblem, decide, identityMismatch,
  type BarDecision, type BarNext, type BarThresholds, type Classification, type FailureClass, type SetSummary, type TrialSet,
} from './lib/measure-bar';
import harnessManifest from './harness-version.json';
import {
  TREE_MUTATING, assignFilesToShards, collectFreeTestFiles, fullSuiteJobs, loadFreeTestDurations, packShardsByDuration,
  runFreeShard, wallTimeoutForShard, type FreeShardOutcome,
} from './test-free-shards';

const ROOT = path.resolve(import.meta.dir, '..');

export type MeasureKind = 'rule' | 'behavior' | 'judge';
export type RerunBackend = 'local' | 'ubicloud';
export const PANEL = EVAL_POLICY.panel;
export const JUDGE_SAMPLES = EVAL_POLICY.judge.samples;

export interface MeasureConfig {
  ruleTrials: number; behaviorPanels: number; judgeOutputs: number;
  askPerTrialUsd: number; budgetUsd: number; maxRounds: number; rerunBackend: RerunBackend;
  sweepCases: number; sweepBudgetUsd: number;
}

export const MEASURE_DEFAULTS: MeasureConfig = {
  ruleTrials: 10, behaviorPanels: 4, judgeOutputs: 10, askPerTrialUsd: 2, budgetUsd: 25, maxRounds: 3, rerunBackend: 'local',
  sweepCases: 5, sweepBudgetUsd: 150,
};

const USD_FIELDS = new Set<keyof MeasureConfig>(['askPerTrialUsd', 'budgetUsd', 'sweepBudgetUsd']);

function gstackConfigGet(key: string): string | undefined {
  const r = spawnSync(path.join(ROOT, 'bin', 'gstack-config'), ['get', key], { encoding: 'utf8', timeout: 10_000 });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

/** The measure controls from gstack config; an empty value takes the default, an invalid one throws. */
export function readMeasureConfig(configGet: (key: string) => string | undefined = gstackConfigGet): MeasureConfig {
  const raw: Array<[keyof MeasureConfig, string, string | undefined]> = [
    ['ruleTrials', 'ship_measure_rule_trials', configGet('ship_measure_rule_trials')],
    ['behaviorPanels', 'ship_measure_behavior_panels', configGet('ship_measure_behavior_panels')],
    ['judgeOutputs', 'ship_measure_judge_outputs', configGet('ship_measure_judge_outputs')],
    ['askPerTrialUsd', 'ship_measure_ask_per_trial_usd', configGet('ship_measure_ask_per_trial_usd')],
    ['budgetUsd', 'ship_measure_budget_usd', configGet('ship_measure_budget_usd')],
    ['maxRounds', 'ship_measure_max_rounds', configGet('ship_measure_max_rounds')],
    ['rerunBackend', 'ship_rerun_backend', configGet('ship_rerun_backend')],
    ['sweepCases', 'ship_measure_sweep_cases', configGet('ship_measure_sweep_cases')],
    ['sweepBudgetUsd', 'ship_measure_sweep_budget_usd', configGet('ship_measure_sweep_budget_usd')],
  ];
  const config = { ...MEASURE_DEFAULTS };
  for (const [field, key, rawValue] of raw) {
    const value = rawValue?.trim();
    if (!value) continue;
    if (field === 'rerunBackend') {
      if (value !== 'local' && value !== 'ubicloud') throw new Error(`${key} '${value}' is not local or ubicloud. Fix: gstack-config set ${key} local`);
      config.rerunBackend = value;
      continue;
    }
    const usd = USD_FIELDS.has(field);
    if (!(usd ? Number.isFinite(Number(value)) && Number(value) > 0 : /^[1-9][0-9]*$/.test(value))) {
      throw new Error(`${key} '${value}' is not a ${usd ? 'positive amount in USD' : 'positive integer'}. Fix: gstack-config set ${key} ${MEASURE_DEFAULTS[field]}`);
    }
    (config as Record<string, unknown>)[field] = Number(value);
  }
  return config;
}

export interface KindPlan {
  kind: MeasureKind;
  /** Behavior trials launch in panels of 3; rule and judge trials one at a time. */
  trialsPerUnit: number;
  /** Trials per batch (outputs for judge). */
  trials: number;
  bar: BarThresholds;
  pooledBar: BarThresholds;
}

export function kindPlan(kind: MeasureKind, config: MeasureConfig): KindPlan {
  const trials = kind === 'behavior' ? config.behaviorPanels * PANEL.n : kind === 'judge' ? config.judgeOutputs : config.ruleTrials;
  return { kind, trialsPerUnit: kind === 'behavior' ? PANEL.n : 1, trials, bar: barThresholds(trials), pooledBar: barThresholds(2 * trials) };
}

/** The per-kind table /ship prints before it runs anything. */
export function formatKindTable(config: MeasureConfig): string {
  const budget = `$${config.budgetUsd} total; asks above $${config.askPerTrialUsd}/trial or with no estimate`;
  const row = (kind: MeasureKind, label: string) => {
    const { trials: n, bar, pooledBar } = kindPlan(kind, config);
    const unit = kind === 'judge' ? ' outputs' : '';
    return `| ${kind} | ${label} | ${bar.strict} of ${n}${unit} | ${bar.qualified} of ${n}, every red qualifying | ${bar.floor} of ${n} (or ${bar.qualified} that does not qualify): ${n} more on identical inputs, then ${pooledBar.strict} of ${2 * n}, or ${pooledBar.qualified} of ${2 * n} qualified | ${budget} |`;
  };
  return [
    '| Kind | Trials per batch | MEETS | MEETS-qualified | EXTEND, then the pooled decision | Budget per red case |',
    '|---|---|---|---|---|---|',
    row('rule', String(config.ruleTrials)),
    row('behavior', `${config.behaviorPanels * PANEL.n} (${config.behaviorPanels} panels of ${PANEL.n})`),
    row('judge', `${config.judgeOutputs} outputs, each its median ${JUDGE_SAMPLES}-sample panel`),
    '',
    'Qualifying reds: provider (affirmative provider or transport evidence only), judge noise at the threshold, a model miss citing its evidence.',
    'Never qualifying (a fix round): a timeout, a hang, a regression, a contract violation, any known fixable cause. Below the EXTEND floor: BELOW, a fix round.',
    'A batch with more than 30% of trials failing on provider evidence is void and is redispatched once; both batches are reported. There is never a third batch.',
    `Repair rounds: at most ${config.maxRounds}. Free-suite rerun backend: ${config.rerunBackend}. Every trial is diagnostic and never changes a recorded verdict.`,
  ].join('\n');
}

// ─── Trials ────────────────────────────────────────────────────────────────

export interface TrialResult {
  passed: boolean;
  /** A contract violation fails the measurement at any count. */
  contract?: boolean;
  /** Billed cost; absent means unknown. */
  costUsd?: number;
  /** Judge outputs: each sample's pass. */
  samples?: boolean[];
  failureCause?: string;
  failureDetail?: string;
  /** The eval store's one-line failure_cause_evidence. */
  failureEvidence?: string;
}

export interface TrialRequest { caseId: string; kind: MeasureKind; round: string; trial: number; dir: string }
export type TrialRunner = (request: TrialRequest) => Promise<TrialResult>;

export interface TrialRecord extends TrialResult { trial: number; set: TrialSet; unit: number; batch: number; dir: string }

// ─── One measurement: baseline or a repair round ───────────────────────────

export type MeasureStatus = 'measured' | 'needs_approval' | 'budget_exhausted' | 'round_limit';

export interface Measurement {
  schema: 'gstack-ship-measure/2';
  label: 'diagnostic';
  verdict: null;
  case: string;
  kind: MeasureKind;
  round: string;
  fix?: string;
  status: MeasureStatus;
  reason?: string;
  plan: KindPlan;
  /** Inputs every pooled batch must share: tree, runner, CLI, model, image, policy and harness versions. */
  identity: Record<string, string>;
  trials: TrialRecord[];
  decision: BarDecision;
  next: BarNext;
  decisionReason: string;
  passes: number;
  counted: number;
  sets: SetSummary[];
  /** The per-trial estimate later batches reserve; null until known. */
  costPerTrialUsd: number | null;
  /** Reserved before admission; null when a batch ran without an estimate. */
  estimatedUsd: number | null;
  actualUsd: number;
  costUnknownTrials: number;
  parallel: number;
}

interface Ledger { case: string; kind: MeasureKind; approved: boolean; spentUsd: number; rounds: string[] }

/** A spend cap shared across cases (the sweep's weekly cap), checked beside each case's own budget. */
export interface SpendPool { label: string; capUsd: number; spentUsd: number }

export interface MeasureOptions {
  caseId: string;
  kind: MeasureKind;
  round: string;
  config: MeasureConfig;
  runner: TrialRunner;
  outDir: string;
  parallel: number;
  costPerTrialUsd: number | null;
  approved: boolean;
  fix?: string;
  /** Pass-rate history directory diagnostic artifacts must stay out of (default: the project eval dir). */
  evalDir?: string;
  /** The batch identity (default: measurementIdentity of the working tree). */
  identity?: () => Record<string, string>;
  pool?: SpendPool;
  log?: (line: string) => void;
}

export const caseSlug = (id: string) => id.replace(/[^A-Za-z0-9._-]+/g, '_');
const readJson = <T>(file: string): T | null => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return null; } };
const writeJson = (file: string, value: unknown) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); };
const inside = (child: string, parent: string) => { const rel = path.relative(path.resolve(parent), path.resolve(child)); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };

/** Throws when diagnostic artifacts would land where verdict history is read. */
export function assertDiagnosticDir(outDir: string, evalDir: string): void {
  if (inside(outDir, evalDir)) throw new Error(`ship-measure: ${outDir} is inside the eval history dir ${evalDir}; diagnostic trials are never recorded as verdicts. Use the default .context/ship-measure.`);
}

function roundNumber(round: string): number {
  if (round === 'baseline') return 0;
  const match = /^round-([1-9][0-9]*)$/.exec(round);
  if (!match) throw new Error(`--round must be baseline or round-N. Received: ${round}`);
  return Number(match[1]);
}

/** The git tree of the working tree as it would be committed now (tracked and unignored files), without touching the real index. */
export function frozenTree(cwd: string): string {
  const git = (args: string[], env: NodeJS.ProcessEnv = process.env) => spawnSync('git', args, { cwd, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  const top = git(['rev-parse', '--show-toplevel']);
  if (top.status !== 0) return 'no-git';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-measure-index-'));
  try {
    const index = path.resolve(cwd, git(['rev-parse', '--git-path', 'index']).stdout.trim());
    if (fs.existsSync(index)) fs.copyFileSync(index, path.join(tmp, 'index'));
    const env = { ...process.env, GIT_INDEX_FILE: path.join(tmp, 'index') };
    const add = git(['-C', top.stdout.trim(), 'add', '-A'], env);
    const tree = add.status === 0 ? git(['write-tree'], env) : add;
    if (tree.status !== 0) throw new Error(`ship-measure: could not snapshot the working tree: ${tree.stderr.trim()}`);
    return tree.stdout.trim();
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

/** Everything a pooled batch must share with the batch it extends. */
export function measurementIdentity(kind: MeasureKind, trials: number, runner: string, cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return {
    tree: frozenTree(cwd), kind, trials: String(trials), runner, policy: String(EVAL_POLICY.version), harness: String(harnessManifest.version),
    claude_cli: getClaudeCliVersion(), model: env.EVALS_MODEL ?? 'default', image: env.GSTACK_CI_IMAGE ?? 'local', bun: Bun.version,
  };
}

const roundDirOf = (outDir: string, caseId: string, round: string) => path.join(outDir, caseSlug(caseId), round);
const classificationsPath = (roundDir: string) => path.join(roundDir, 'classifications.jsonl');

export function readClassifications(roundDir: string): Classification[] {
  if (!fs.existsSync(classificationsPath(roundDir))) return [];
  return fs.readFileSync(classificationsPath(roundDir), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Classification);
}

/** Apply the bar to the measurement's trials and its classification records. */
function withDecision(m: Measurement, roundDir: string): Measurement {
  const outcome = decide(m.kind, m.plan.trials, m.trials, readClassifications(roundDir));
  return { ...m, decision: outcome.decision, next: outcome.next, decisionReason: outcome.reason, passes: outcome.passes, counted: outcome.thresholds.trials, sets: outcome.sets };
}

function loadMeasurement(outDir: string, caseId: string, round: string): { m: Measurement; roundDir: string } {
  const roundDir = roundDirOf(outDir, caseId, round);
  const m = readJson<Measurement>(path.join(roundDir, 'measurement.json'));
  if (!m) throw new Error(`ship-measure: no measurement at ${roundDir}; run measure --case ${caseId} --round ${round} first`);
  return { m, roundDir };
}

function saveMeasurement(m: Measurement, roundDir: string, log: (line: string) => void): Measurement {
  const decided = withDecision(m, roundDir);
  writeJson(path.join(roundDir, 'measurement.json'), decided);
  log(formatMeasurementLine(decided));
  return decided;
}

export async function measureCase(o: MeasureOptions): Promise<Measurement> {
  const log = o.log ?? ((line: string) => console.log(line));
  const plan = kindPlan(o.kind, o.config);
  assertDiagnosticDir(o.outDir, o.evalDir ?? getProjectEvalDir());
  const caseDir = path.join(o.outDir, caseSlug(o.caseId));
  const ledgerPath = path.join(caseDir, 'ledger.json');
  const ledger: Ledger = readJson<Ledger>(ledgerPath) ?? { case: o.caseId, kind: o.kind, approved: false, spentUsd: 0, rounds: [] };
  const base: Measurement = {
    schema: 'gstack-ship-measure/2', label: 'diagnostic', verdict: null, case: o.caseId, kind: o.kind, round: o.round,
    ...(o.fix ? { fix: o.fix } : {}), status: 'measured', plan, identity: {}, trials: [], decision: 'incomplete', next: 'stop', decisionReason: '',
    passes: 0, counted: 0, sets: [], costPerTrialUsd: o.costPerTrialUsd, estimatedUsd: 0, actualUsd: 0, costUnknownTrials: 0, parallel: Math.max(1, o.parallel),
  };
  if (roundNumber(o.round) > o.config.maxRounds) {
    return { ...base, status: 'round_limit', reason: `repair-round limit ${o.config.maxRounds} reached; stop with the named-red report` };
  }
  const estimate = o.costPerTrialUsd;
  const ask = estimate === null ? 'estimate unknown' : estimate > o.config.askPerTrialUsd
    ? `estimated $${estimate.toFixed(2)}/trial is above $${o.config.askPerTrialUsd}/trial` : null;
  if (ask && !o.approved && !ledger.approved) {
    return { ...base, status: 'needs_approval', reason: `${ask}; ${plan.trials} trials, budget $${o.config.budgetUsd} per red case. Ask once, then rerun with --approved.` };
  }
  if (ask) ledger.approved = true;
  const roundDir = path.join(caseDir, o.round);
  if (fs.existsSync(roundDir)) throw new Error(`ship-measure: ${roundDir} already exists; measurements are never overwritten. Use the next round.`);
  fs.mkdirSync(roundDir, { recursive: true });
  let m: Measurement = { ...base, identity: (o.identity ?? (() => measurementIdentity(o.kind, plan.trials, 'gstack')))() };
  m = withDecision(await runSet(o, m, 'initial', roundDir, ledger, log), roundDir);
  if (m.status === 'measured' && m.next === 'redispatch') {
    log(`[ship-measure] ${o.caseId} ${o.round}: ${m.decisionReason}`);
    m = await runSet(o, m, 'redispatch', roundDir, ledger, log);
  }
  ledger.rounds.push(o.round);
  writeJson(ledgerPath, ledger);
  return saveMeasurement(m, roundDir, log);
}

export interface ExtendOptions extends Omit<MeasureOptions, 'kind' | 'fix' | 'approved' | 'costPerTrialUsd'> { costPerTrialUsd?: number | null }

/** EXTEND: N more trials on identical inputs (the identity must match field for field), decided once on the pooled 2N. */
export async function extendCase(o: ExtendOptions): Promise<Measurement> {
  const log = o.log ?? ((line: string) => console.log(line));
  assertDiagnosticDir(o.outDir, o.evalDir ?? getProjectEvalDir());
  let { m, roundDir } = loadMeasurement(o.outDir, o.caseId, o.round);
  m = withDecision(m, roundDir);
  if (m.trials.some(t => t.set === 'extend')) throw new Error(`ship-measure: ${o.caseId} ${o.round} was already extended; there is never a third batch`);
  if (m.decision !== 'EXTEND') throw new Error(`ship-measure: ${o.caseId} ${o.round} is ${m.decision}, not EXTEND (${m.decisionReason})`);
  const now = (o.identity ?? (() => measurementIdentity(m.kind, m.plan.trials, m.identity.runner ?? 'gstack')))();
  const changed = identityMismatch(m.identity, now);
  if (changed) throw new Error(`ship-measure: refusing to pool ${o.caseId} ${o.round}: ${changed}. EXTEND needs identical inputs; measure the changed tree as a new round.`);
  const ledgerPath = path.join(o.outDir, caseSlug(o.caseId), 'ledger.json');
  const ledger = readJson<Ledger>(ledgerPath) ?? { case: o.caseId, kind: m.kind, approved: true, spentUsd: m.actualUsd, rounds: [o.round] };
  const opts: MeasureOptions = { ...o, kind: m.kind, approved: true, costPerTrialUsd: o.costPerTrialUsd ?? m.costPerTrialUsd };
  m = withDecision(await runSet(opts, { ...m, status: 'measured' }, 'extend', roundDir, ledger, log), roundDir);
  if (m.status === 'measured' && m.next === 'redispatch') {
    log(`[ship-measure] ${o.caseId} ${o.round}: ${m.decisionReason}`);
    m = await runSet(opts, m, 'extend-redispatch', roundDir, ledger, log);
  }
  writeJson(ledgerPath, ledger);
  return saveMeasurement(m, roundDir, log);
}

/** Append one immutable classification record per trial (a later record supersedes, never edits), then re-decide. */
export function classifyTrials(outDir: string, caseId: string, round: string, trials: number[], cls: string, evidence: string, log = (line: string) => console.log(line)): Measurement {
  const { m, roundDir } = loadMeasurement(outDir, caseId, round);
  for (const trial of trials) {
    const problem = classificationProblem(m.trials.find(t => t.trial === trial), m.kind, cls, evidence);
    if (problem) throw new Error(`ship-measure: classify t${trial} refused: ${problem}`);
  }
  const at = new Date().toISOString();
  fs.appendFileSync(classificationsPath(roundDir), trials.map(trial => `${JSON.stringify({ trial, class: cls as FailureClass, evidence: evidence.trim(), by: 'agent', at } satisfies Classification)}\n`).join(''));
  return saveMeasurement(m, roundDir, log);
}

export function decideRound(outDir: string, caseId: string, round: string, log = (line: string) => console.log(line)): Measurement {
  const { m, roundDir } = loadMeasurement(outDir, caseId, round);
  return saveMeasurement(m, roundDir, log);
}

/** Run one set of N trials (initial, redispatch, extend or extend-redispatch) under the admission budget. */
async function runSet(o: MeasureOptions, m: Measurement, set: TrialSet, roundDir: string, ledger: Ledger, log: (line: string) => void): Promise<Measurement> {
  const plan = m.plan;
  const first = m.trials.length;
  const trials: TrialRecord[] = [];
  const initialEstimate = m.costPerTrialUsd;
  let estimate = initialEstimate;
  let estimatedUsd = m.estimatedUsd;
  let actualUsd = m.actualUsd;
  let costUnknownTrials = m.costUnknownTrials;
  let knownCosts = m.trials.filter(t => typeof t.costUsd === 'number').length;
  let batch = 0;
  const parallel = Math.max(1, o.parallel);
  const done = (status: MeasureStatus, reason?: string): Measurement => ({
    ...m, status, ...(reason ? { reason } : {}), trials: [...m.trials, ...trials], estimatedUsd, actualUsd, costUnknownTrials, parallel,
    costPerTrialUsd: estimate,
  });
  while (trials.length < plan.trials) {
    const remaining = plan.trials - trials.length;
    const headroom = Math.min(o.config.budgetUsd - ledger.spentUsd, o.pool ? o.pool.capUsd - o.pool.spentUsd : Infinity);
    let size = Math.min(parallel, remaining);
    if (estimate === null) size = knownCosts === 0 && trials.length === 0 ? 1 : size;
    else size = Math.min(size, Math.floor((headroom + 1e-9) / estimate));
    if (size < 1 || headroom <= 0) {
      const cap = o.pool && o.pool.capUsd - o.pool.spentUsd <= o.config.budgetUsd - ledger.spentUsd
        ? `${o.pool.label} $${o.pool.capUsd}: spent $${o.pool.spentUsd.toFixed(2)}`
        : `budget $${o.config.budgetUsd} per red case: spent $${ledger.spentUsd.toFixed(2)}`;
      return done('budget_exhausted', `${cap}, next trial reserves $${(estimate ?? 0).toFixed(2)}; ${trials.length} of ${plan.trials} ${set} trials ran`);
    }
    batch += 1;
    estimatedUsd = estimate === null || estimatedUsd === null ? null : estimatedUsd + size * estimate;
    log(`[ship-measure] ${o.caseId} ${o.round} ${set}: batch ${batch} admits ${size} trial(s)${estimate === null ? ' (calibration, no estimate)' : `, reserves $${(size * estimate).toFixed(2)}`}; spent $${ledger.spentUsd.toFixed(2)} of $${o.config.budgetUsd}`);
    const start = first + trials.length;
    const results = await Promise.all(Array.from({ length: size }, async (_, i) => {
      const trial = start + i + 1;
      const dir = path.join(roundDir, `t${String(trial).padStart(2, '0')}`);
      fs.mkdirSync(dir, { recursive: false });
      let result: TrialResult;
      try { result = await o.runner({ caseId: o.caseId, kind: m.kind, round: o.round, trial, dir }); }
      catch (error) { result = { passed: false, failureCause: 'unknown', failureDetail: `runner error: ${(error as Error).message}` }; }
      return { ...result, trial, set, unit: Math.ceil((trial - first) / plan.trialsPerUnit), batch, dir } satisfies TrialRecord;
    }));
    for (const record of results) {
      writeJson(path.join(record.dir, 'trial.json'), { label: 'diagnostic', verdict: null, ...record });
      trials.push(record);
      const charge = typeof record.costUsd === 'number' && Number.isFinite(record.costUsd) ? record.costUsd : estimate;
      if (typeof record.costUsd === 'number' && Number.isFinite(record.costUsd)) { actualUsd += record.costUsd; knownCosts += 1; }
      else costUnknownTrials += 1;
      if (charge !== null) { ledger.spentUsd += charge; if (o.pool) o.pool.spentUsd += charge; }
    }
    if (initialEstimate === null && knownCosts > 0) estimate = actualUsd / knownCosts;
  }
  return done('measured');
}

const DECISION_WORDS: Record<BarDecision, string> = {
  MEETS: 'MEETS', 'MEETS-qualified': 'MEETS-qualified', EXTEND: 'EXTEND', BELOW: 'BELOW (fix round)',
  'needs-classify': 'needs-classify', void: 'void', incomplete: 'incomplete',
};

export function formatMeasurementLine(m: Measurement): string {
  const when = m.fix ? ` after fix at ${m.fix}` : m.round === 'baseline' ? ' (baseline)' : '';
  const verdict = m.status === 'measured' ? DECISION_WORDS[m.decision] : m.status.replace('_', ' ');
  const sets = m.sets.length > 1 ? `; batches ${m.sets.map(s => `${s.set} ${s.passes}/${s.trials}${s.void ? ' void' : ''}`).join(', ')}` : '';
  return `[ship-measure] DIAGNOSTIC ${m.case} ${m.round}: observed ${m.passes}/${m.counted} ${m.kind === 'judge' ? 'outputs' : 'trials'}${when}; ${verdict}${m.status === 'measured' ? ` — ${m.decisionReason}` : m.reason ? ` — ${m.reason}` : ''}${sets}; est ${usd(m.estimatedUsd)}, actual ${usd(m.actualUsd)}${m.costUnknownTrials ? ` (+${m.costUnknownTrials} trial(s) cost unknown)` : ''}`;
}

const usd = (value: number | null) => value === null ? 'unknown' : `$${value.toFixed(2)}`;

/** measure/extend/classify/decide exit code for a measurement (see the header). */
export function measurementExit(m: Measurement): number {
  if (m.status === 'needs_approval') return 2;
  if (m.status !== 'measured') return 3;
  return ({ MEETS: 0, 'MEETS-qualified': 0, BELOW: 1, 'needs-classify': 5, EXTEND: 6, void: 3, incomplete: 3 } as const)[m.decision];
}

// ─── Unmeasured skip and the PR-body report ────────────────────────────────

export function recordUnmeasured(outDir: string, caseId: string, reason: string): string {
  if (!reason.trim()) throw new Error('skip needs --reason: why this red is infrastructure and is not measured');
  const file = path.join(outDir, caseSlug(caseId), 'unmeasured.json');
  writeJson(file, { schema: 'gstack-ship-measure/2', label: 'diagnostic', verdict: null, case: caseId, status: 'unmeasured', reason: reason.trim() });
  return file;
}

/** The per-case table for the PR body: every measurement, estimated and actual spend, never a pass for an unmeasured case. */
export function formatReport(outDir: string): string {
  const rows = ['| Case | Kind | Measurement | Observed | Bar | Decision | Est. spend | Actual spend |', '|---|---|---|---|---|---|---|---|'];
  const cases = fs.existsSync(outDir) ? fs.readdirSync(outDir).filter(name => fs.statSync(path.join(outDir, name)).isDirectory()).sort() : [];
  const qualified: string[] = [];
  for (const name of cases) {
    const dir = path.join(outDir, name);
    const skip = readJson<{ case: string; reason: string }>(path.join(dir, 'unmeasured.json'));
    if (skip) { rows.push(`| ${skip.case} | — | — | — | — | unmeasured (${skip.reason.replace(/\|/g, '/')}); not a pass | — | — |`); continue; }
    const ledger = readJson<Ledger>(path.join(dir, 'ledger.json'));
    for (const round of ledger?.rounds ?? []) {
      const m = readJson<Measurement>(path.join(dir, round, 'measurement.json'));
      if (!m) continue;
      const bar = m.counted > m.plan.trials ? m.plan.pooledBar : m.plan.bar;
      const what = m.fix ? `${m.round}: after fix at ${m.fix.replace(/\|/g, '/')}` : m.round;
      const batches = m.sets.length > 1 ? ` (${m.sets.map(s => `${s.set} ${s.passes}/${s.trials}${s.void ? ' void' : ''}`).join(', ')})` : '';
      const decision = m.status === 'measured' ? DECISION_WORDS[m.decision] : m.status.replace('_', ' ');
      rows.push(`| ${m.case} | ${m.kind} | ${what} | observed ${m.passes}/${m.counted}${batches} | ${bar.strict}/${bar.trials} strict, ${bar.qualified}/${bar.trials} qualified | ${decision} | ${usd(m.estimatedUsd)} | ${usd(m.actualUsd)}${m.costUnknownTrials ? ` (${m.costUnknownTrials} unknown)` : ''} |`);
      if (m.status === 'measured' && m.decision === 'MEETS-qualified') qualified.push(`- ${m.case} ${m.round}: ${m.decisionReason.replace(/\|/g, '/')}`);
    }
  }
  return [...rows, ...(qualified.length ? ['', 'Qualified MEETS (every red classified into a qualifying class):', ...qualified] : []),
    '', 'Diagnostic measurements: they never change a recorded verdict; the lane verdict is the full gate run.'].join('\n');
}

// ─── Trial runners ─────────────────────────────────────────────────────────

const TRIAL_TIMEOUT_MS = 60 * 60_000;

/** Cost, failure fields and judge records a trial's eval dir holds (any finalized eval-store result under it). */
export function readTrialRecords(evalDir: string): Array<Record<string, any>> {
  if (!fs.existsSync(evalDir)) return [];
  return (fs.readdirSync(evalDir, { recursive: true }) as string[]).filter(isFinalizedEvalResultFile)
    .flatMap(name => readJson<{ tests?: unknown[] }>(path.join(evalDir, name))?.tests ?? [])
    .filter((t): t is Record<string, any> => !!t && typeof t === 'object');
}

/**
 * No-cost proof that gstack's runner selects the case before any paid trial:
 * `--list` must name the case's own test file. A selection bug otherwise
 * shows up only after money is spent (two such bugs were found in #3033).
 */
export function caseSelectionPreflight(caseId: string, rootDir = ROOT): { ok: boolean; detail: string } {
  const isJudge = !Object.hasOwn(E2E_TIERS, caseId);
  if (isJudge) {
    if (!Object.hasOwn(LLM_JUDGE_TOUCHFILES, caseId)) return { ok: false, detail: `${caseId} is neither an E2E case nor a standalone judge` };
    const file = judgeFile(caseId, rootDir);
    return fs.existsSync(path.join(rootDir, file)) ? { ok: true, detail: `judge ${caseId} runs from ${file}` } : { ok: false, detail: `judge file ${file} is missing` };
  }
  const r = spawnSync(process.execPath, ['run', path.join(rootDir, 'scripts/test-paid-shards.ts'), '--tier', E2E_TIERS[caseId]!, '--case', caseId, '--trials', '1', '--list'],
    { cwd: rootDir, encoding: 'utf8', timeout: 60_000 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.status !== 0) return { ok: false, detail: `--list exited ${r.status}: ${out.trim().split('\n').slice(-1)[0] ?? ''}` };
  const file = new RegExp(`--case ${caseId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: \\d+ trial\\(s\\) of (\\S+)`).exec(out)?.[1];
  const esc = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A file-mode case lists `<file> (trial 1)`; a name-mode case lists its trial shard `<file>#<id>~t1`.
  const listed = file && new RegExp(`^\\s+${esc(file)}(?: \\(trial 1\\)|#${esc(caseId)}~t1)$`, 'm').test(out);
  if (!file || !listed || !fs.existsSync(path.join(rootDir, file))) return { ok: false, detail: `--list did not plan a trial of ${caseId}'s test file` };
  return { ok: true, detail: `--case ${caseId} selects ${file}` };
}

/**
 * The environment every diagnostic trial starts from. Trials always run fresh
 * and never publish: with the judge input cache enabled, a trial could reuse a
 * stored pass, and its own passes would flow into the gate's reuse.
 */
export function diagnosticBaseEnv(base: NodeJS.ProcessEnv, evalDir: string): NodeJS.ProcessEnv {
  const { EVALS_CACHE_DIR: _cacheDir, EVALS_CACHE_RUNTIME_ID: _cacheRuntime, ...inherited } = base;
  return { ...inherited, GSTACK_EVAL_DIR: evalDir, GSTACK_SHIP_MEASURE_LABEL: 'diagnostic', EVALS_JOBS: '1' };
}

/** True when some junit.xml under evalDir holds an executed, passing testcase and no failed or errored one. */
export function junitExecuted(evalDir: string): boolean {
  if (!fs.existsSync(evalDir)) return false;
  let executed = 0;
  for (const name of fs.readdirSync(evalDir, { recursive: true }) as string[]) {
    if (path.basename(name) !== 'junit.xml') continue;
    const xml = fs.readFileSync(path.join(evalDir, name), 'utf8');
    for (const m of xml.matchAll(/<testcase\b[^>]*?(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
      const body = m[1] ?? '';
      if (/<(?:failure|error)\b/.test(body)) return false;
      if (!/<skipped\b/.test(body)) executed++;
    }
  }
  return executed > 0;
}

function costOf(records: Array<Record<string, any>>): number | undefined {
  if (!records.length || records.some(r => r.cost_known === false || typeof r.cost_usd !== 'number')) return undefined;
  return records.reduce((sum, r) => sum + r.cost_usd, 0);
}

/** Runs argv as one trial in its own process group, logging to <dir>/output.log; returns exit code and text. */
async function runTrialProcess(argv: string[], cwd: string, env: NodeJS.ProcessEnv, dir: string, timeoutMs = TRIAL_TIMEOUT_MS): Promise<{ code: number | null; output: string }> {
  const logFile = fs.createWriteStream(path.join(dir, 'output.log'));
  const chunks: string[] = [];
  const child = spawn(argv[0]!, argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', (chunk: Buffer) => { chunks.push(chunk.toString('utf8')); logFile.write(chunk); });
  const timer = setTimeout(() => { try { process.kill(-(child.pid ?? 0), 'SIGKILL'); } catch { child.kill('SIGKILL'); } }, timeoutMs);
  const code = await new Promise<number | null>(resolve => { child.on('error', () => resolve(null)); child.on('close', resolve); });
  clearTimeout(timer);
  await new Promise<void>(resolve => logFile.end(resolve));
  return { code, output: chunks.join('') };
}

function parseTrialOutput(output: string): Partial<TrialResult> {
  const field = (name: string) => new RegExp(`^\\s*${name}\\s*[:=]\\s*(.+?)\\s*$`, 'm').exec(output)?.[1];
  const cost = field('cost_usd');
  const samples = field('samples');
  return {
    ...(field('failure_cause') ? { failureCause: field('failure_cause') } : {}),
    ...(field('failure_detail') ? { failureDetail: field('failure_detail') } : {}),
    ...(field('failure_evidence') ? { failureEvidence: field('failure_evidence') } : {}),
    ...(cost !== undefined && Number.isFinite(Number(cost)) ? { costUsd: Number(cost) } : {}),
    ...(samples ? { samples: samples.split(/[,\s]+/).filter(Boolean).map(s => s === '1' || s === 'pass' || s === 'true') } : {}),
    ...(/^\s*contract_violation\b/m.test(output) ? { contract: true } : {}),
  };
}

/**
 * The project's documented single-case command, split on whitespace (no
 * shell), with {case} replaced by the case id. Exit 0 is a pass; the trial's
 * own lines `cost_usd:`, `failure_cause:`, `failure_detail:`, `samples:` and
 * `contract_violation` are read, and so are eval-store records it writes to
 * GSTACK_EVAL_DIR.
 */
export function commandRunner(template: string, cwd = process.cwd()): TrialRunner {
  const words = template.trim().split(/\s+/).filter(Boolean);
  if (!words.length) throw new Error('--command is empty');
  return async ({ caseId, trial, dir }) => {
    const env = { ...process.env, GSTACK_EVAL_DIR: path.join(dir, 'eval'), GSTACK_SHIP_MEASURE_DIR: dir, GSTACK_SHIP_MEASURE_LABEL: 'diagnostic', GSTACK_SHIP_MEASURE_TRIAL: String(trial) };
    const { code, output } = await runTrialProcess(words.map(w => w.replaceAll('{case}', caseId)), cwd, env, dir);
    const parsed = parseTrialOutput(output);
    const records = readTrialRecords(path.join(dir, 'eval'));
    const failed = records.find(r => r.passed !== true);
    return {
      passed: code === 0, ...parsed,
      ...(parsed.costUsd === undefined && costOf(records) !== undefined ? { costUsd: costOf(records) } : {}),
      ...(code !== 0 && !parsed.failureCause && failed?.failure_cause ? { failureCause: String(failed.failure_cause) } : {}),
      ...(code !== 0 && !parsed.failureDetail && failed?.failure_detail ? { failureDetail: JSON.stringify(failed.failure_detail).slice(0, 300) } : {}),
      ...(code !== 0 && !parsed.failureEvidence && failed?.failure_cause_evidence ? { failureEvidence: String(failed.failure_cause_evidence).slice(0, 300) } : {}),
    };
  };
}

/** The one paid file that names a standalone judge id, else a thrown reason. */
export function judgeFile(id: string, rootDir = ROOT): string {
  const owners = collectPaidTestFiles(rootDir).filter(file => {
    const source = fs.readFileSync(path.join(rootDir, file), 'utf8');
    return source.includes(`'${id}'`) || source.includes(`"${id}"`);
  });
  if (owners.length !== 1) throw new Error(`judge ${id}: ${owners.length ? `named by ${owners.join(', ')}` : 'no paid file names it'}; it needs exactly one`);
  return owners[0]!;
}

/**
 * gstack's default runner. An E2E case runs one trial through
 * `scripts/test-paid-shards.ts --case <id> --trials 1` (the CI panel runner,
 * whose exit code is that trial's verdict); a standalone judge runs its file
 * with the judge selected alone and passes only on its own passing record.
 */
export function gstackRunner(rootDir = ROOT): TrialRunner {
  return async ({ caseId, dir }) => {
    const evalDir = path.join(dir, 'eval');
    const isJudge = !Object.hasOwn(E2E_TIERS, caseId);
    if (isJudge && !Object.hasOwn(LLM_JUDGE_TOUCHFILES, caseId)) throw new Error(`${caseId} is neither an E2E case nor a standalone judge`);
    const argv = isJudge
      ? [process.execPath, 'test', path.join(rootDir, judgeFile(caseId, rootDir))]
      : [process.execPath, 'run', path.join(rootDir, 'scripts/test-paid-shards.ts'), '--tier', E2E_TIERS[caseId]!, '--case', caseId, '--trials', '1'];
    const env = {
      ...diagnosticBaseEnv(process.env, evalDir),
      ...(isJudge ? { EVALS: '1', EVALS_TIER: 'gate', EVALS_ALL: '1', ...paidSelectionEnv('full', { e2e: [], judges: [caseId] }, 'ship-measure judge') } : {}),
    };
    const { code, output } = await runTrialProcess(argv, rootDir, env, dir);
    const records = readTrialRecords(evalDir);
    const own = isJudge ? records.filter(r => r.name === caseId || r.case_id === caseId) : records;
    const failed = own.find(r => r.passed !== true);
    // An E2E trial passes only with proof the case ran: a JUnit testcase that
    // executed and passed (a --case that selected nothing also exits 0).
    const passed = code === 0 && (isJudge ? own.length > 0 && !failed : junitExecuted(evalDir));
    const cost = costOf(own);
    return {
      passed, ...(cost !== undefined ? { costUsd: cost } : {}),
      ...(own.some(r => r.failure_class === 'contract') ? { contract: true } : {}),
      ...(passed ? {} : {
        failureCause: failed?.failure_cause ? String(failed.failure_cause) : own.length ? 'assertion' : 'unknown',
        ...(failed?.failure_cause_evidence ? { failureEvidence: String(failed.failure_cause_evidence).slice(0, 300) } : {}),
        failureDetail: failed?.failure_detail ? JSON.stringify(failed.failure_detail).slice(0, 300)
          : own.length ? String(failed?.error ?? '').slice(0, 300) : `no trial record; exit ${code}; ${output.trim().split('\n').slice(-1)[0] ?? ''}`.slice(0, 300),
      }),
    };
  };
}

// ─── Free-suite shard reruns (CEO-1) ───────────────────────────────────────

export interface FreeRerunOutcome { rerun: number; mode: 'baseline' | 'parallel'; status: string; completed: boolean; failingFiles: string[]; elapsedMs: number; log: string }

export interface FreeMeasurement {
  schema: 'gstack-ship-measure/1'; label: 'diagnostic'; verdict: null;
  files: string[]; reruns: number; completed: number; passed: number; parallel: number; concurrency: number;
  backend: 'local'; wallCapMs: number; capHit: boolean; outcomes: FreeRerunOutcome[];
}

export interface FreeRerunOptions {
  files: string[];
  reruns: number;
  /** Within-shard concurrency of the original run (the free lane runs each shard at 1). */
  concurrency: number;
  wallCapMs: number;
  outDir: string;
  cores?: number;
  runShard?: typeof runFreeShard;
  log?: (line: string) => void;
}

/** Local parallelism for free reruns: max(1, floor(cores / shard concurrency)). */
export const freeParallelism = (cores: number, concurrency: number) => Math.max(1, Math.floor(cores / Math.max(1, concurrency)));

/**
 * Rerun one shard's exact file list N times with the flaky retry off: rerun 1
 * alone as the baseline, the rest in parallel up to the cap, each with its own
 * HOME, state root and flake ledger. No rerun starts after the wall cap, and
 * one the cap cuts short is not counted as completed.
 */
export async function measureFreeShard(o: FreeRerunOptions): Promise<FreeMeasurement> {
  const log = o.log ?? ((line: string) => console.log(line));
  const runShard = o.runShard ?? runFreeShard;
  const parallel = freeParallelism(o.cores ?? os.availableParallelism(), o.concurrency);
  fs.mkdirSync(path.join(o.outDir, 'free'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(o.outDir, 'free', 'rerun-'));
  const deadline = Date.now() + o.wallCapMs;
  const shardWall = wallTimeoutForShard(o.files.length);
  const outcomes: FreeRerunOutcome[] = [];
  const runOne = async (rerun: number, mode: FreeRerunOutcome['mode']) => {
    const runDir = path.join(dir, `r${String(rerun).padStart(2, '0')}`);
    const state = path.join(runDir, 'state');
    fs.mkdirSync(state, { recursive: true });
    const remaining = deadline - Date.now();
    const wallTimeoutMs = Math.max(1, Math.min(shardWall, remaining));
    const env = { ...process.env, GSTACK_HOME: state, GSTACK_STATE_ROOT: state, GSTACK_FREE_RETRY_FLAKY: '0', GSTACK_FLAKE_LEDGER: path.join(runDir, 'flake-ledger.jsonl') };
    const logPath = path.join(runDir, 'shard.log');
    const outcome: FreeShardOutcome = await runShard(o.files, rerun, o.reruns, { env, wallTimeoutMs, quiet: true, log: () => {}, logFilePath: logPath, homeGuard: privateFreeHome });
    const cut = outcome.status === 'timed-out' && wallTimeoutMs < shardWall;
    outcomes.push({ rerun, mode, status: cut ? 'cut by wall cap' : outcome.status, completed: !cut, failingFiles: outcome.failingFiles, elapsedMs: outcome.elapsedMs, log: logPath });
  };
  if (o.reruns > 0) await runOne(1, 'baseline');
  let next = 2;
  const worker = async () => {
    while (next <= o.reruns && Date.now() < deadline) await runOne(next++, 'parallel');
  };
  await Promise.all(Array.from({ length: Math.min(parallel, Math.max(0, o.reruns - 1)) }, worker));
  outcomes.sort((a, b) => a.rerun - b.rerun);
  const done = outcomes.filter(r => r.completed);
  const measurement: FreeMeasurement = {
    schema: 'gstack-ship-measure/1', label: 'diagnostic', verdict: null, files: o.files, reruns: o.reruns,
    completed: done.length, passed: done.filter(r => r.status === 'passed').length, parallel, concurrency: o.concurrency,
    backend: 'local', wallCapMs: o.wallCapMs, capHit: done.length < o.reruns, outcomes,
  };
  writeJson(path.join(dir, 'free-measurement.json'), measurement);
  log(`[ship-measure] DIAGNOSTIC free shard (${o.files.length} files): observed ${measurement.passed}/${measurement.completed} passed; ${measurement.completed} of ${o.reruns} completed${measurement.capHit ? ` (wall cap ${Math.round(o.wallCapMs / 1000)}s)` : ''}; rerun 1 alone as baseline, the rest at parallelism ${parallel}; flaky retry off. Captures: ${dir}`);
  return measurement;
}

/** The exact file list of local free-suite shard I, as `bun run test` packs it. */
export function localFreeShardFiles(index: number, rootDir = ROOT): string[] {
  const files = collectFreeTestFiles(rootDir);
  const exclusive = files.filter(f => f in TREE_MUTATING);
  const readers = files.filter(f => !(f in TREE_MUTATING));
  const jobs = fullSuiteJobs();
  const durations = loadFreeTestDurations(rootDir);
  const shards = durations ? packShardsByDuration(readers, jobs, durations).shards : assignFilesToShards(readers, jobs);
  if (exclusive.length) shards.push(exclusive);
  const shard = shards[index - 1];
  if (!shard) throw new Error(`--shard ${index}: the local free suite has ${shards.length} shards`);
  return shard;
}

// ─── CLI ───────────────────────────────────────────────────────────────────

function positive(raw: string | undefined, flag: string, integer = true): number {
  const value = Number(raw);
  if (raw === undefined || !(integer ? /^[1-9][0-9]*$/.test(raw) : Number.isFinite(value) && value >= 0)) throw new Error(`${flag} needs a ${integer ? 'positive integer' : 'non-negative number'}. Received: ${raw}`);
  return value;
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'sweep') return (await import('./ship-measure-sweep')).sweepMain(rest, env);
  const flags: Record<string, string> = {};
  const value = (name: string) => (next: () => string | undefined) => { const v = next(); if (v === undefined) throw new Error(`${name} needs a value`); flags[name] = v; };
  const handlers = Object.fromEntries(['--case', '--round', '--kind', '--command', '--cost-per-trial', '--fix', '--jobs', '--out', '--reason',
    '--files', '--shard', '--reruns', '--concurrency', '--backend', '--wall-cap', '--trials', '--class', '--evidence'].map(name => [name, value(name)]));
  parseCliFlags(rest, { ...handlers, '--approved': () => { flags['--approved'] = '1'; } }, 'Usage: see the header of scripts/ship-measure.ts');
  const config = readMeasureConfig();
  const outDir = path.resolve(flags['--out'] ?? path.join(process.cwd(), '.context', 'ship-measure'));
  if (command === 'table') { console.log(formatKindTable(config)); return 0; }
  if (command === 'report') { console.log(formatReport(outDir)); return 0; }
  if (command === 'skip') { console.log(`[ship-measure] ${flags['--case']} labeled unmeasured: ${recordUnmeasured(outDir, flags['--case'] ?? '', flags['--reason'] ?? '')}`); return 0; }
  if (command === 'free') return runFreeCli(flags, config, outDir, env);
  if (command !== 'measure' && command !== 'classify' && command !== 'decide' && command !== 'extend') {
    throw new Error(`Unknown command: ${command ?? '(none)'}. Use table, measure, classify, decide, extend, skip, report, free or sweep.`);
  }
  const caseId = flags['--case'];
  if (!caseId) throw new Error(`${command} needs --case`);
  const round = flags['--round'] ?? 'baseline';
  if (command === 'classify') {
    const trials = (flags['--trials'] ?? '').split(',').map(t => t.trim().replace(/^t/, '')).filter(Boolean).map(t => positive(t, '--trials'));
    if (!trials.length || !flags['--class']) throw new Error(`classify needs --trials 2,5 and --class (${FAILURE_CLASSES.join(', ')})`);
    return measurementExit(classifyTrials(outDir, caseId, round, trials, flags['--class'], flags['--evidence'] ?? ''));
  }
  if (command === 'decide') return measurementExit(decideRound(outDir, caseId, round));
  const isGstack = path.resolve(process.cwd()) === ROOT;
  if (!flags['--command'] && !isGstack) throw new Error('No single-case eval command: pass --command \'<documented command> {case}\' (ask the user once and record the answer).');
  const runner = flags['--command'] ? commandRunner(flags['--command']) : gstackRunner();
  const runnerId = flags['--command'] ? `command:${flags['--command']}` : 'gstack';
  const parallel = flags['--jobs'] ? positive(flags['--jobs'], '--jobs') : Number(env.EVALS_JOBS) || DEFAULT_JOBS;
  const costPerTrialUsd = flags['--cost-per-trial'] !== undefined ? positive(flags['--cost-per-trial'], '--cost-per-trial', false) : null;
  if (command === 'extend') {
    return measurementExit(await extendCase({ caseId, round, config, outDir, runner, parallel, ...(costPerTrialUsd !== null ? { costPerTrialUsd } : {}) }));
  }
  const kind = (flags['--kind'] ?? E2E_KINDS[caseId] ?? 'rule') as MeasureKind;
  if (!['rule', 'behavior', 'judge'].includes(kind)) throw new Error(`--kind must be rule, behavior or judge. Received: ${kind}`);
  console.log(formatKindTable(config));
  if (!flags['--command']) {
    const selected = caseSelectionPreflight(caseId);
    if (!selected.ok) throw new Error(`--case ${caseId} does not select its test (no paid call made): ${selected.detail}`);
    console.log(`[ship-measure] preflight: ${selected.detail}`);
  }
  const plan = kindPlan(kind, config);
  const m = await measureCase({
    caseId, kind, round, config, outDir, fix: flags['--fix'], runner, parallel, costPerTrialUsd, approved: flags['--approved'] === '1',
    identity: () => measurementIdentity(kind, plan.trials, runnerId),
  });
  if (m.status === 'needs_approval') console.log(`[ship-measure] NEEDS APPROVAL ${caseId}: ${m.reason}`);
  else if (m.status !== 'measured' || m.next === 'stop') console.log(`[ship-measure] NAMED RED ${caseId}: ${m.reason ?? m.decisionReason}`);
  return measurementExit(m);
}

async function runFreeCli(flags: Record<string, string>, config: MeasureConfig, outDir: string, env: NodeJS.ProcessEnv): Promise<number> {
  const files = flags['--files'] ? flags['--files'].split(',').map(f => f.trim()).filter(Boolean)
    : flags['--shard'] ? localFreeShardFiles(positive(flags['--shard'], '--shard')) : [];
  if (!files.length) throw new Error('free needs --files a,b,... (the failing shard\'s exact file list) or --shard I');
  const reruns = flags['--reruns'] ? positive(flags['--reruns'], '--reruns') : config.ruleTrials;
  const backend = (flags['--backend'] ?? config.rerunBackend) as RerunBackend;
  if (backend === 'ubicloud') {
    if (!env.UBICLOUD_API_KEY) throw new Error('ship_rerun_backend is ubicloud but UBICLOUD_API_KEY is not set; set it or use --backend local');
    const r = spawnSync('bash', [path.join(ROOT, 'scripts/ubicloud/test-free.sh'), '--diagnostic', '--files', files.join(','), '--reruns', String(reruns)],
      { stdio: 'inherit', env, timeout: 30 * 60_000 });
    return r.status ?? 1;
  }
  if (backend !== 'local') throw new Error(`--backend must be local or ubicloud. Received: ${backend}`);
  const m = await measureFreeShard({ files, reruns, outDir, concurrency: flags['--concurrency'] ? positive(flags['--concurrency'], '--concurrency') : 1,
    wallCapMs: (flags['--wall-cap'] ? positive(flags['--wall-cap'], '--wall-cap') : 600) * 1000 });
  return m.completed > 0 && m.passed === m.completed ? 0 : 1;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(code => process.exit(code), (error: Error) => { console.error(`[ship-measure] ${error.message}`); process.exit(4); });
}
