#!/usr/bin/env bun
/**
 * eval-pass-rates (alias: eval-flake-rank) — per-case trial pass rates.
 *
 * Reads trial records (one JSONL line per trial: case, kind, trial, outcome,
 * exit_reason, duration, cost, model, CLI version, series identity, run id,
 * sha, policy_version) from the last N completed `evals-periodic.yml` runs on
 * the current branch and `main` (downloading only each run's small
 * `trial-outcomes` artifact through `gh`), plus any local eval dirs, and
 * prints per-case per-trial pass rates with 95% Wilson intervals.
 *
 * A series is one case under one input identity: the case's own touchfiles
 * minus GLOBAL_TOUCHFILES (`caseSeriesIdentities`), grouped by model and CLI
 * version, per policy_version. A new identity starts a new series; earlier
 * series stay visible. Only trials of the current series under the reader's
 * own EVAL_POLICY.version feed the labels and alarms: an older policy's
 * trials are display-only, and a newer policy's trials (written by a later
 * checkout) are ignored with a printed count, so a reader rolled back past a
 * policy bump never pools records it cannot interpret. Legacy eval-store records (`--backfill`, `--dir`) are
 * imported as pre-policy trials (first attempt only; a missing attempt means
 * 1) and are display-only.
 *
 * Labels: INCONCLUSIVE (below the entry rule's minimum trials), BROKEN (latest run 0/n
 * after a prior interval at or above the entry rate), FLAKY (failures and an
 * interval straddling the entry rate), FAILING (interval below the entry
 * rate), PASSING (otherwise).
 *
 * The weekly gate (`--gate`) exits non-zero with ACTION REQUIRED when a
 * non-quarantined case meets the quarantine entry rule, a rule case behaves
 * like a behavior case, a blocking case's current-identity rate is
 * significantly below its previous identity (one-sided Fisher exact,
 * Holm-controlled across cases), or a CASE_QUARANTINE entry has met its exit
 * rule, expired, or pushed its tier over the cap. History that cannot be
 * fetched fails the gate closed.
 *
 * Usage:
 *   bun run eval:pass-rates                       # last 10 weekly runs, this branch + main
 *   bun run eval:pass-rates --case <id> --runs 20
 *   bun run eval:pass-rates --dir <path>          # local eval dirs / downloaded artifacts (repeatable)
 *   bun run eval:pass-rates --backfill            # also import legacy slice artifacts, labeled pre-policy
 *   bun run eval:pass-rates --json | --gate
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isPartialEval, isFinalizedEvalResultFile, evalEntryOutcome, failureClassOf, parseTrialOutcomes, sanitizeTrialError,
  TRIAL_OUTCOME_SCHEMA, type EvalCaseKind, type EvalResult, type TrialOutcomeRecord } from '../test/helpers/eval-store';
import { flakeLedgerPath, type FlakeLedgerEntry } from './test-free-shards';
import { E2E_KINDS, E2E_TIERS, E2E_TOUCHFILES, GLOBAL_TOUCHFILES, LLM_JUDGE_TOUCHFILES } from '../test/helpers/touchfiles-data';
import { CASE_QUARANTINE, EVAL_POLICY } from '../test/helpers/periodic-exclude-data';
import { matchGlob } from '../test/helpers/test-selection';
import { CASE_TEST_NAMES } from './test-paid-shards';
import { resolveStateRoot } from '../lib/state-root';
import { downloadRunArtifacts, gitOutput, listWeeklyRuns, parseFlakeLedger, repoSlug, TRIAL_OUTCOMES_MAX_BYTES } from './lib/ci-history';

interface TestSeries {
  name: string;
  runs: number;
  passes: number;
  fails: number;
  manualAccepted: number;
  retriedPasses: number;
  totalAttempts: number;
  totalCostUsd: number;
  totalDurationMs: number;
  lastSeen: string;
}

export function aggregate(evalFiles: string[]): Map<string, TestSeries> {
  const series = new Map<string, TestSeries>();
  for (const file of evalFiles) {
    let run: EvalResult;
    try {
      run = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch { continue; }
    if (isPartialEval(run, file)) continue; // in-progress accumulators are not runs
    if (!Array.isArray(run.tests)) continue;
    // Group this run's entries by name so N attempts = 1 run of that test.
    const byName = new Map<string, typeof run.tests>();
    for (const t of run.tests) {
      const list = byName.get(t.name) ?? [];
      list.push(t);
      byName.set(t.name, list);
    }
    for (const [name, entries] of byName) {
      const s = series.get(name) ?? {
        name, runs: 0, passes: 0, fails: 0, manualAccepted: 0, retriedPasses: 0,
        totalAttempts: 0, totalCostUsd: 0, totalDurationMs: 0, lastSeen: '',
      };
      const final = entries[entries.length - 1];
      s.totalAttempts += entries.length;
      const outcome = evalEntryOutcome(final);
      if (outcome === 'manual-review') s.manualAccepted += 1;
      else {
        s.runs += 1;
        if (outcome === 'passed') s.passes += 1; else s.fails += 1;
        if (outcome === 'passed' && entries.length > 1) s.retriedPasses += 1;
      }
      for (const e of entries) {
        s.totalCostUsd += e.cost_usd || 0;
        s.totalDurationMs += e.duration_ms || 0;
      }
      if (run.timestamp > s.lastSeen) s.lastSeen = run.timestamp;
      series.set(name, s);
    }
  }
  return series;
}

export function collectEvalFiles(dir: string, sinceDays = 60): string[] {
  if (!fs.existsSync(dir)) return [];
  const cutoff = Date.now() - sinceDays * 86_400_000;
  const out: string[] = [];
  for (const name of fs.readdirSync(dir, { recursive: true }) as string[]) {
    if (!isFinalizedEvalResultFile(name)) continue;
    const full = path.join(dir, name);
    try {
      // Recency bound (review finding): E2E results embed full transcripts
      // (MBs each) and the scan is otherwise unbounded over all-time history.
      if (fs.statSync(full).mtimeMs < cutoff) continue;
    } catch { continue; }
    out.push(full);
  }
  return out;
}

/** The local free-suite flake ledger (CI ledgers are read by test:health through scripts/lib/ci-history.ts). */
function readFreeLedger(): FlakeLedgerEntry[] {
  try {
    return parseFlakeLedger(fs.readFileSync(flakeLedgerPath(), 'utf-8'));
  } catch { return []; }
}

// --- Trial records ---

/**
 * A trial record as pass-rates reads it: eval-store's trial-outcomes schema
 * plus the series identity the report job stamps (caseSeriesIdentities).
 * policy_version 0 marks a pre-policy (backfilled) record.
 */
export type TrialRecord = TrialOutcomeRecord & { series_identity?: string };


/** Every `trial-outcomes*.jsonl` file under a directory, size-capped, schema-validated by eval-store. */
export function readTrialOutcomeDir(dir: string): { records: TrialRecord[]; errors: string[] } {
  const records: TrialRecord[] = [];
  const errors: string[] = [];
  if (!fs.existsSync(dir)) return { records, errors };
  for (const name of fs.readdirSync(dir, { recursive: true }) as string[]) {
    if (!/^trial-outcomes[^/\\]*\.jsonl$/.test(path.basename(name))) continue;
    const full = path.join(dir, name);
    const parsed = parseTrialOutcomes(fs.readFileSync(full, 'utf8'), { maxBytes: TRIAL_OUTCOMES_MAX_BYTES });
    records.push(...parsed.records.map(record => ({
      ...record, series_identity: typeof (record as TrialRecord).series_identity === 'string'
        ? (record as TrialRecord).series_identity!.slice(0, 64) : undefined })));
    errors.push(...parsed.errors.map(error => `${full}: ${error}`));
  }
  return { records, errors };
}

// --- Registry attribution and series identity ---

export interface Registry {
  kinds: Record<string, EvalCaseKind>;
  tiers: Record<string, string>;
  touchfiles: Record<string, string[]>;
  judgeTouchfiles: Record<string, string[]>;
  globals: readonly string[];
  testNames: Record<string, string>;
}

export const LIVE_REGISTRY: Registry = {
  kinds: E2E_KINDS, tiers: E2E_TIERS, touchfiles: E2E_TOUCHFILES, judgeTouchfiles: LLM_JUDGE_TOUCHFILES,
  globals: GLOBAL_TOUCHFILES, testNames: CASE_TEST_NAMES,
};

/** A case's tier: its E2E_TIERS value, or 'judge' for an LLM-judge entry. */
export function caseTier(id: string, registry: Registry = LIVE_REGISTRY): string {
  return registry.tiers[id] ?? (id in registry.judgeTouchfiles ? 'judge' : 'unknown');
}

/**
 * Attribute a legacy eval-store record to a registry id: the case-shard slug
 * suffix (`<file>--<id>`), the recorded name or its exact slug (`/qa b6-static`
 * is `qa-b6-static`), a CASE_TEST_NAMES label, or the only id its shard file
 * registers. Anything else is unattributed (null).
 */
export function attributeLegacyRecord(name: string, shard: string | undefined, registry: Registry = LIVE_REGISTRY): string | null {
  const known = (id: string) => id in registry.kinds;
  const [slugFile, slugCase] = (shard ?? '').split('--');
  if (slugCase && known(slugCase)) return slugCase;
  if (known(name)) return name;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (known(slug)) return slug;
  const labeled = Object.entries(registry.testNames).find(([, label]) => label === name)?.[0];
  if (labeled && known(labeled)) return labeled;
  if (slugFile) {
    const file = `test/${slugFile}.test.ts`;
    const owners = Object.keys(registry.touchfiles).filter(id => registry.touchfiles[id]!.includes(file));
    if (owners.length === 1 && known(owners[0]!)) return owners[0]!;
  }
  return null;
}

/**
 * Series identity per case: a hash of the git blob ids of the files matching
 * the case's own touchfiles, excluding GLOBAL_TOUCHFILES (harness edits are
 * markers, not new series). The report job stamps this on every trial record.
 */
export function caseSeriesIdentities(ids: string[], root: string, registry: Registry = LIVE_REGISTRY): Record<string, string> {
  const listed = spawnSync('git', ['ls-files', '-s'], { cwd: root, encoding: 'utf8', timeout: 20_000, maxBuffer: 64 * 1024 * 1024 });
  if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr}`);
  const blobs = listed.stdout.split('\n').filter(Boolean).map(line => {
    const [meta, file] = line.split('\t');
    return { file: file!, blob: meta!.split(' ')[1]! };
  }).filter(entry => !registry.globals.some(pattern => matchGlob(entry.file, pattern)));
  return Object.fromEntries(ids.map(id => {
    const patterns = registry.touchfiles[id] ?? registry.judgeTouchfiles[id] ?? [];
    const lines = blobs.filter(entry => patterns.some(pattern => matchGlob(entry.file, pattern)))
      .map(entry => `${entry.file} ${entry.blob}`).sort();
    return [id, createHash('sha256').update(`${id}\n${lines.join('\n')}`).digest('hex').slice(0, 16)];
  }));
}

/**
 * Import legacy eval-store result files as pre-policy trials (policy_version
 * 0, source 'backfill'): first attempt only (a missing attempt means 1),
 * attributed by registry id, never guessed. A manual-review acceptance carries
 * no automated verdict: it is counted and shown, never scored. Without a CI
 * run, each local result file is its own run.
 */
export function backfillEvalFiles(files: string[], run?: { run_id: string; sha?: string; timestamp?: string },
  registry: Registry = LIVE_REGISTRY): { records: TrialRecord[]; unattributed: string[]; manualReviews: string[] } {
  const records: TrialRecord[] = [];
  const unattributed = new Set<string>();
  const manualReviews: string[] = [];
  for (const file of files) {
    let result: EvalResult & { shard?: string; claude_cli_version?: string };
    try { result = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (isPartialEval(result, file) || !Array.isArray(result.tests)) continue;
    const seen = new Set<string>();
    for (const entry of result.tests) {
      if ((entry.attempt ?? 1) !== 1 || seen.has(entry.name)) continue;
      seen.add(entry.name);
      const id = attributeLegacyRecord(entry.name, result.shard, registry);
      if (!id) { unattributed.add(entry.name); continue; }
      const outcome = evalEntryOutcome(entry);
      if (outcome === 'manual-review') { manualReviews.push(id); continue; }
      records.push({
        schema: TRIAL_OUTCOME_SCHEMA, case: id,
        file: result.shard ? `test/${result.shard.split('--')[0]}.test.ts` : 'unknown',
        tier: caseTier(id, registry), kind: registry.kinds[id]!, trial: 1, panel: { n: 1, k: 1 }, attempt: 1,
        outcome, ...(outcome === 'failed' ? { failure_class: failureClassOf(entry) } : {}),
        exit_reason: entry.exit_reason, error: sanitizeTrialError(entry.error),
        duration_ms: Math.max(0, entry.duration_ms || 0), cost_usd: Math.max(0, entry.cost_usd || 0),
        model: entry.model, cli_version: result.claude_cli_version, policy_version: 0, quarantined: false,
        execution: entry.execution === 'reused' ? 'reused' : 'executed', source: 'backfill',
        run_id: run?.run_id ?? `local:${file}`, sha: run?.sha ?? result.git_sha, recorded_at: run?.timestamp ?? result.timestamp,
      });
    }
  }
  return { records, unattributed: [...unattributed].sort(), manualReviews };
}

// --- Statistics ---

/** 95% Wilson score interval for k successes in n trials. */
export function wilsonInterval(k: number, n: number, z = 1.96): { lo: number; hi: number } {
  if (n <= 0) return { lo: 0, hi: 1 };
  const p = k / n, z2 = z * z, denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / denom;
  return { lo: Math.max(0, center - half), hi: k === n ? 1 : Math.min(1, center + half) };
}

function logChoose(n: number, k: number): number {
  let sum = 0;
  for (let i = 1; i <= k; i++) sum += Math.log(n - k + i) - Math.log(i);
  return sum;
}

/**
 * One-sided Fisher exact p-value that the CURRENT pass rate is below the
 * PREVIOUS one: P(X <= curPass) under the hypergeometric null with the
 * observed margins.
 */
export function fisherOneSidedLower(curPass: number, curN: number, prevPass: number, prevN: number): number {
  const passes = curPass + prevPass, total = curN + prevN;
  const denom = logChoose(total, passes);
  let p = 0;
  for (let x = Math.max(0, passes - prevN); x <= curPass; x++) p += Math.exp(logChoose(curN, x) + logChoose(prevN, passes - x) - denom);
  return Math.min(1, p);
}

/** Holm step-down: the indices whose p-values are rejected at family-wise alpha. */
export function holmRejections(pValues: number[], alpha: number): Set<number> {
  const order = pValues.map((p, index) => ({ p, index })).sort((a, b) => a.p - b.p);
  const rejected = new Set<number>();
  for (let rank = 0; rank < order.length; rank++) {
    if (order[rank]!.p > alpha / (order.length - rank)) break;
    rejected.add(order[rank]!.index);
  }
  return rejected;
}

// --- Analysis ---

export type PassRateLabel = 'INCONCLUSIVE' | 'BROKEN' | 'FLAKY' | 'FAILING' | 'PASSING';
export type AlarmKind = 'drift' | 'rule-as-behavior' | 'regression' | 'quarantine-exit' | 'quarantine-expired'
  | 'quarantine-cap' | 'quarantine-invalid';

/** The EVAL_POLICY fields pass-rates reads (structural, so tests can vary them). */
export interface PassRatePolicy {
  version: number;
  quarantine: { entry: { rate: number; minTrials: number }; exit: { rate: number; minTrials: number }; capFraction: number; expiryWeeklyRuns: number };
  drift: { fisherAlpha: number; fisherMinPerSide: number };
}

export type QuarantineEntry = (typeof CASE_QUARANTINE)[string];

/** Tiers whose cases block a lane; quarantine applies only to them. */
export const BLOCKING_TIERS: readonly string[] = ['gate', 'periodic'];
const QUARANTINE_FAILURE_CLASSES: readonly string[] = ['detector', 'harness', 'model-latency'];

export interface SeriesStats {
  key: string;
  identity: string;
  model: string;
  cli: string;
  policyVersion: number;
  passes: number;
  /** Scored trials: passed + failed (skipped trials carry no verdict). */
  trials: number;
  infra: number;
  interval: { lo: number; hi: number };
  firstSeen: string;
  lastSeen: string;
  runs: string[];
}

export interface CasePassRate {
  case: string;
  kind: EvalCaseKind;
  tier: string;
  quarantined: boolean;
  label: PassRateLabel;
  /** Manual-review acceptances: visible, never scored. */
  manualReviews: number;
  current: SeriesStats | null;
  previous: SeriesStats | null;
  prePolicy: SeriesStats | null;
  series: SeriesStats[];
  latestRun: { runId: string; passes: number; trials: number } | null;
}

export interface Alarm { kind: AlarmKind; case: string; message: string }

export interface PassRateReport {
  policyVersion: number;
  cases: CasePassRate[];
  alarms: Alarm[];
  /** Trials under this reader's EVAL_POLICY.version: the only ones scored. */
  postPolicyTrials: number;
  /** Backfilled pre-policy trials (policy_version 0): display only. */
  prePolicyTrials: number;
  /** Trials under an earlier policy version: display only, never scored. */
  olderPolicyTrials: number;
  /** Trials under a later policy version than this reader: ignored entirely. */
  newerPolicyTrials: number;
  unattributed: string[];
  errors: string[];
}

export interface AnalyzeOptions {
  registry?: Registry;
  quarantine?: Record<string, QuarantineEntry>;
  policy?: PassRatePolicy;
  /** Completed weekly-run timestamps in the window, for quarantine expiry. */
  weeklyRuns?: string[];
  now?: number;
  unattributed?: string[];
  errors?: string[];
  manualReviews?: string[];
}

const at = (record: TrialRecord) => record.recorded_at ?? '';
const runOf = (record: TrialRecord) => `${record.run_id ?? record.sha ?? 'local'}#${record.attempt}`;

function seriesStats(key: string, records: TrialRecord[]): SeriesStats {
  const scored = records.filter(record => record.outcome !== 'skipped');
  const passes = scored.filter(record => record.outcome === 'passed').length;
  const times = records.map(at).sort();
  const first = records[0]!;
  return {
    key, identity: first.series_identity ?? 'unknown', model: first.model ?? 'unknown', cli: first.cli_version ?? 'unknown',
    policyVersion: first.policy_version, passes, trials: scored.length,
    infra: scored.filter(record => record.outcome === 'failed' && record.failure_class === 'infra').length,
    interval: wilsonInterval(passes, scored.length), firstSeen: times[0] ?? '', lastSeen: times[times.length - 1] ?? '',
    runs: [...new Set(records.map(runOf))],
  };
}

/** Weekly runs completed after an entry's enteredAt; offline, whole weeks elapsed. */
export function quarantineRunsSince(enteredAt: string, weeklyRuns: string[] | undefined, now: number): number {
  const entered = Date.parse(enteredAt);
  if (!Number.isFinite(entered)) return Number.POSITIVE_INFINITY;
  if (weeklyRuns && weeklyRuns.length) return weeklyRuns.filter(time => Date.parse(time) > entered).length;
  return Math.floor((now - entered) / (7 * 86_400_000));
}

/**
 * Static CASE_QUARANTINE problems, shared by the free policy test and the
 * weekly gate: an id that is not a blocking-tier E2E case, a missing field,
 * a failure class outside detector / harness / model-latency (a product
 * defect is fixed or named, never quarantined), a malformed or future date,
 * and a tier over its cap.
 */
export function quarantinePolicyProblems(quarantine: Record<string, QuarantineEntry>,
  registry: Registry = LIVE_REGISTRY, policy: PassRatePolicy = EVAL_POLICY, now = Date.now()): Alarm[] {
  const problems: Alarm[] = [];
  const invalid = (id: string, message: string) => problems.push({ kind: 'quarantine-invalid', case: id, message: `${id}: ${message}` });
  const perTier = new Map<string, number>();
  for (const [id, entry] of Object.entries(quarantine)) {
    const tier = registry.tiers[id];
    if (!tier || !(id in registry.kinds)) { invalid(id, 'CASE_QUARANTINE names no registered E2E case'); continue; }
    if (!BLOCKING_TIERS.includes(tier)) invalid(id, `tier ${tier} is not blocking; only ${BLOCKING_TIERS.join(' and ')} cases are quarantined`);
    for (const field of ['reason', 'failureClass', 'tracking', 'owner', 'enteredAt', 'exit'] as const) {
      if (typeof entry[field] !== 'string' || !entry[field].trim()) invalid(id, `missing ${field}`);
    }
    if (typeof entry.reason === 'string' && entry.reason.trim().length < 40) invalid(id, 'reason must be a written diagnosis (at least 40 characters)');
    if (!QUARANTINE_FAILURE_CLASSES.includes(entry.failureClass)) {
      invalid(id, `failureClass ${JSON.stringify(entry.failureClass)} is not ${QUARANTINE_FAILURE_CLASSES.join(', ')}; a product defect is fixed or named as a red, never quarantined`);
    }
    const entered = Date.parse(entry.enteredAt);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.enteredAt ?? '') || !Number.isFinite(entered)) invalid(id, 'enteredAt must be YYYY-MM-DD');
    else if (entered > now) invalid(id, 'enteredAt is in the future');
    perTier.set(tier, (perTier.get(tier) ?? 0) + 1);
  }
  for (const [tier, count] of perTier) {
    const size = Object.values(registry.tiers).filter(value => value === tier).length;
    const cap = Math.floor(size * policy.quarantine.capFraction);
    if (count > cap) problems.push({ kind: 'quarantine-cap', case: tier,
      message: `${count} quarantined ${tier} cases exceed the ${pct(policy.quarantine.capFraction)} cap (${cap} of ${size})` });
  }
  return problems;
}

export function analyzePassRates(records: TrialRecord[], options: AnalyzeOptions = {}): PassRateReport {
  const registry = options.registry ?? LIVE_REGISTRY;
  const quarantine = options.quarantine ?? CASE_QUARANTINE;
  const policy = options.policy ?? EVAL_POLICY;
  const now = options.now ?? Date.now();
  const newerPolicyTrials = records.filter(record => record.policy_version > policy.version).length;
  const byCase = new Map<string, TrialRecord[]>();
  for (const record of records) {
    if (record.policy_version > policy.version) continue;
    const list = byCase.get(record.case) ?? [];
    list.push(record);
    byCase.set(record.case, list);
  }
  for (const id of options.manualReviews ?? []) if (!byCase.has(id)) byCase.set(id, []);
  const cases: CasePassRate[] = [];
  for (const [id, list] of [...byCase].sort(([a], [b]) => a.localeCompare(b))) {
    list.sort((a, b) => at(a).localeCompare(at(b)) || runOf(a).localeCompare(runOf(b)) || a.trial - b.trial);
    const groups = new Map<string, TrialRecord[]>();
    for (const record of list) {
      const key = record.policy_version === 0 ? 'pre-policy'
        : [record.series_identity ?? 'unknown', record.model ?? 'unknown', record.cli_version ?? 'unknown', `v${record.policy_version}`].join('|');
      const group = groups.get(key) ?? [];
      group.push(record);
      groups.set(key, group);
    }
    const series = [...groups].map(([key, group]) => seriesStats(key, group))
      .sort((a, b) => a.lastSeen.localeCompare(b.lastSeen));
    const post = series.filter(entry => entry.policyVersion === policy.version);
    const current = post[post.length - 1] ?? null;
    const previous = post[post.length - 2] ?? null;
    const scored = current ? groups.get(current.key)!.filter(record => record.outcome !== 'skipped') : [];
    const latestRun = scored.length ? runOf(scored[scored.length - 1]!) : null;
    const latest = scored.filter(record => runOf(record) === latestRun);
    const prior = scored.filter(record => runOf(record) !== latestRun);
    const priorPasses = prior.filter(record => record.outcome === 'passed').length;
    const entryRate = policy.quarantine.entry.rate;
    let label: PassRateLabel;
    if (latest.length > 0 && latest.every(record => record.outcome === 'failed')
      && prior.length > 0 && wilsonInterval(priorPasses, prior.length).lo >= entryRate) label = 'BROKEN';
    else if (!current || current.trials < policy.quarantine.entry.minTrials) label = 'INCONCLUSIVE';
    else if (current.interval.hi < entryRate) label = 'FAILING';
    else if (current.passes < current.trials && current.interval.lo < entryRate) label = 'FLAKY';
    else label = 'PASSING';
    cases.push({
      case: id, kind: registry.kinds[id] ?? list[0]!.kind, tier: caseTier(id, registry),
      quarantined: id in quarantine, label, current, previous,
      manualReviews: (options.manualReviews ?? []).filter(name => name === id).length,
      prePolicy: series.find(entry => entry.policyVersion === 0) ?? null, series,
      latestRun: latestRun ? { runId: latestRun, passes: latest.filter(record => record.outcome === 'passed').length, trials: latest.length } : null,
    });
  }

  const alarms: Alarm[] = [];
  const rate = (stats: SeriesStats) => stats.passes / stats.trials;
  for (const entry of cases) {
    const current = entry.current;
    if (!current) continue;
    const below = current.trials >= policy.quarantine.entry.minTrials && rate(current) < policy.quarantine.entry.rate;
    if (below && !entry.quarantined && BLOCKING_TIERS.includes(entry.tier)) alarms.push({ kind: 'drift', case: entry.case,
      message: `${entry.case} passes ${current.passes}/${current.trials} (below ${pct(policy.quarantine.entry.rate)} over >= ${policy.quarantine.entry.minTrials} trials): fix it, or propose a CASE_QUARANTINE entry with a written diagnosis (product defects are never quarantined)` });
    if (below && entry.kind === 'rule') alarms.push({ kind: 'rule-as-behavior', case: entry.case,
      message: `${entry.case}: rule case behaving like behavior (${current.passes}/${current.trials}): fix or reclassify` });
    if (entry.quarantined && current.trials >= policy.quarantine.exit.minTrials && rate(current) >= policy.quarantine.exit.rate) {
      alarms.push({ kind: 'quarantine-exit', case: entry.case,
        message: `${entry.case} passes ${current.passes}/${current.trials} (>= ${pct(policy.quarantine.exit.rate)}): remove its CASE_QUARANTINE entry` });
    }
  }
  const tested = cases.filter(entry => BLOCKING_TIERS.includes(entry.tier) && entry.current && entry.previous
    && entry.current.trials >= policy.drift.fisherMinPerSide && entry.previous.trials >= policy.drift.fisherMinPerSide);
  const pValues = tested.map(entry => fisherOneSidedLower(entry.current!.passes, entry.current!.trials, entry.previous!.passes, entry.previous!.trials));
  for (const index of holmRejections(pValues, policy.drift.fisherAlpha)) {
    const entry = tested[index]!;
    alarms.push({ kind: 'regression', case: entry.case,
      message: `${entry.case}: current identity ${entry.current!.passes}/${entry.current!.trials} is significantly below the previous ${entry.previous!.passes}/${entry.previous!.trials} (one-sided Fisher p=${pValues[index]!.toFixed(4)}, Holm over ${tested.length} cases)` });
  }
  for (const [id, entry] of Object.entries(quarantine)) {
    const runs = quarantineRunsSince(entry.enteredAt, options.weeklyRuns, now);
    if (runs >= policy.quarantine.expiryWeeklyRuns) alarms.push({ kind: 'quarantine-expired', case: id,
      message: `${id}: entered ${runs} weekly runs ago (limit ${policy.quarantine.expiryWeeklyRuns}): fix it, name it as a red, or re-diagnose with fresh evidence` });
  }
  alarms.push(...quarantinePolicyProblems(quarantine, registry, policy, now));

  const count = (match: (version: number) => boolean) => records.filter(record => match(record.policy_version)).length;
  return { policyVersion: policy.version, cases, alarms, postPolicyTrials: count(version => version === policy.version),
    prePolicyTrials: count(version => version === 0), olderPolicyTrials: count(version => version > 0 && version < policy.version),
    newerPolicyTrials, unattributed: options.unattributed ?? [], errors: options.errors ?? [] };
}

function pct(value: number): string { return `${Math.round(value * 1000) / 10}%`; }

function formatStats(stats: SeriesStats | null): string {
  if (!stats) return '-';
  return `${stats.passes}/${stats.trials} [${pct(stats.interval.lo)}–${pct(stats.interval.hi)}]${stats.infra ? ` (${stats.infra} infra)` : ''}`;
}

export function formatPassRates(report: PassRateReport, options: { caseFilter?: string } = {}): string {
  const lines: string[] = [];
  lines.push(`pass-rates: policy v${report.policyVersion}, ${report.postPolicyTrials} post-policy trial(s), ${report.prePolicyTrials} pre-policy (display only)`
    + (report.olderPolicyTrials ? `, ${report.olderPolicyTrials} under an older policy (display only)` : ''));
  if (report.newerPolicyTrials) {
    lines.push(`  ignored ${report.newerPolicyTrials} trial(s) recorded under a policy newer than v${report.policyVersion}: this checkout predates them. `
      + 'Fix: run pass-rates from a checkout at or after the commit that bumped EVAL_POLICY.version (docs/TESTING_INTERNALS.md#pass-rate-policy-versions).');
  }
  if (report.postPolicyTrials === 0) lines.push('  no post-policy trials yet: every series starts INCONCLUSIVE');
  const cases = report.cases.filter(entry => !options.caseFilter || entry.case === options.caseFilter);
  lines.push('  label         kind      tier      current series                 pre-policy          manual  case');
  for (const entry of cases) {
    const group = entry.current ? `  ${entry.current.model} / ${entry.current.cli}` : '';
    const reset = entry.previous ? '  (baseline reset)' : '';
    lines.push(`  ${entry.label.padEnd(12)}  ${entry.kind.padEnd(8)}  ${entry.tier.padEnd(8)}  ${formatStats(entry.current).padEnd(29)}  `
      + `${formatStats(entry.prePolicy).padEnd(18)}  ${String(entry.manualReviews).padStart(6)}  ${entry.case}${entry.quarantined ? ' [quarantined]' : ''}${group}${reset}`);
  }
  if (report.unattributed.length) lines.push(`  unattributed records (${report.unattributed.length}, never guessed): ${report.unattributed.slice(0, 20).join(', ')}`);
  if (report.errors.length) lines.push(`  rejected ${report.errors.length} invalid trial line(s): ${report.errors.slice(0, 5).join('; ')}`);
  if (report.alarms.length) {
    lines.push(`ACTION REQUIRED (${report.alarms.length}):`);
    for (const alarm of report.alarms) lines.push(`  [${alarm.kind}] ${alarm.message}`);
  }
  return lines.join('\n');
}

// --- GitHub history (shared reader: scripts/lib/ci-history.ts) ---

export { downloadRunArtifacts, GH_HISTORY, listWeeklyRuns, TRIAL_OUTCOMES_MAX_BYTES,
  type HistoryFetcher, type RunArtifact, type WeeklyRun } from './lib/ci-history';

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string) => { const index = argv.indexOf(name); return index === -1 ? undefined : argv[index + 1]; };
  const dirs = argv.flatMap((arg, index) => arg === '--dir' && argv[index + 1] ? [argv[index + 1]!] : []);
  const asJson = argv.includes('--json');
  const gate = argv.includes('--gate');
  const backfill = argv.includes('--backfill');
  const caseFilter = flag('--case');
  const runsLimit = Number(flag('--runs')) || 10;
  const sinceDays = Number(flag('--since-days')) || 60;
  const repo = flag('--repo') ?? repoSlug();
  const workflow = flag('--workflow') ?? 'evals-periodic.yml';
  const branch = flag('--branch') ?? gitOutput(['rev-parse', '--abbrev-ref', 'HEAD']) ?? 'main';

  const records: TrialRecord[] = [];
  const unattributed = new Set<string>();
  const errors: string[] = [];
  let historyError: string | null = null;
  let weeklyRuns: string[] | undefined;

  const manualReviews: string[] = [];
  const importDir = (dir: string, run: { run_id: string; sha?: string; timestamp?: string } | undefined, legacyDays: number) => {
    const trials = readTrialOutcomeDir(dir);
    records.push(...trials.records);
    errors.push(...trials.errors);
    const legacy = backfillEvalFiles(collectEvalFiles(dir, legacyDays), run);
    records.push(...legacy.records);
    manualReviews.push(...legacy.manualReviews);
    legacy.unattributed.forEach(name => unattributed.add(name));
  };

  if (dirs.length) {
    for (const dir of dirs) importDir(dir, undefined, sinceDays);
  } else {
    try {
      const runs = listWeeklyRuns({ repo, workflow, branches: [...new Set([branch, 'main'])], limit: runsLimit });
      weeklyRuns = runs.map(run => run.createdAt);
      const cacheDir = path.join(path.resolve(resolveStateRoot()), 'eval-pass-rates-cache', repo.replace('/', '-'));
      const match = backfill
        ? (name: string) => name.startsWith('trial-outcomes') || /^(paid-slice-\d+|gate-census-\d+)(-a\d+)?$/.test(name)
        : (name: string) => name.startsWith('trial-outcomes');
      for (const run of runs) {
        const dirsForRun = downloadRunArtifacts({ repo, run, match, cacheDir, maxBytes: backfill ? 64 * 1024 * 1024 : undefined });
        for (const dir of dirsForRun) importDir(dir, { run_id: `${run.id}`, sha: run.sha, timestamp: run.createdAt }, 3650);
      }
    } catch (error) {
      historyError = error instanceof Error ? error.message : String(error);
    }
  }

  const report = analyzePassRates(records, { weeklyRuns, unattributed: [...unattributed].sort(), errors, manualReviews });
  const ledger = readFreeLedger();
  if (asJson) {
    console.log(JSON.stringify({ repo, workflow, branch, dirs, historyError, ...report, freeLedger: ledger }, null, 2));
  } else {
    if (historyError) console.log(`pass-rates: history unavailable (${historyError}); every label below is INCONCLUSIVE`);
    console.log(formatPassRates(report, { caseFilter }));
    if (ledger.length > 0) {
      const byFile = new Map<string, number>();
      for (const e of ledger) byFile.set(e.file, (byFile.get(e.file) ?? 0) + 1);
      console.log(`free-suite flaky-passes (${flakeLedgerPath()}):`);
      for (const [file, n] of [...byFile.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${String(n).padStart(3)}x  ${file}`);
      }
    }
  }
  if (gate && (historyError || report.alarms.length)) process.exit(1);
}
