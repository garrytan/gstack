/**
 * Paid-lane planner: duration seeds, slice packing, the run manifest and its verification. Moved from scripts/test-paid-shards.ts.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createBootstrapRetentionScope } from '../../test/helpers/bootstrap-retention';
import {
  BunTestOutputClassifier,
  createShardSandbox,
  exactTestFileSelectors,
  forwardAndClassify,
  isTerminationRequested,
  nextShardLogPath,
  normalizeRelativePath,
  openShardLog,
  parseCliFlags,
  readDurationSeed,
  removeShardSandbox,
  runShardChild,
  strictShardStatus,
  writeDurationSeed,
  zeroExecutionVerdict,
  type LanePolicy,
  type ShardChildResult,
  type ShardLog,
} from './shard-engine';
import { PAID_TEST_GLOBS, isPaidTestFile } from '../../test/helpers/paid-test-set';
import { CASE_CI_EXCLUDE, CASE_QUARANTINE, EVAL_POLICY, PERIODIC_CI_EXCLUDE } from '../../test/helpers/periodic-exclude-data';
import { FILE_RETRY_BUDGETS, STRICT_RETRY_CASE_BUDGETS } from '../../test/helpers/eval-budgets';
import {
  getProjectEvalDir, getClaudeCliVersion, isFinalizedEvalResultFile, evalEntryOutcome, failureClassOf, panelVerdict,
  sanitizeTrialError, formatTrialOutcomes, CONTRACT_VIOLATIONS_FILE, TRIAL_ENV, TRIAL_OUTCOME_SCHEMA, TRIAL_OUTCOMES_FILE,
  type EvalCaseKind, type PanelShape, type PanelVerdict, type TrialFailureClass, type TrialOutcome, type TrialOutcomeRecord,
} from '../../test/helpers/eval-store';
import { E2E_KINDS } from '../../test/helpers/touchfiles-data';
import { manualReviewProblem } from '../../test/helpers/cookie-workflow-manual-review';
import { preflightAnthropicApi } from '../../test/helpers/anthropic-preflight';
import { OVERLAY_MIN_FILE_WALL_MS } from '../../test/helpers/overlay-case-policy';
import { packageChangeOnlyVersion, prProfileCaseAllowed, prProfileFileMap, selectPrProfile, type PrProfileSelection } from '../test-pr-profile';
import { e2eReuseLaneProblem, prepareE2EShardReuse, selectPlanReceipts, writeNegativeReceipt, writePanelReceipt } from '../e2e-shard-reuse';

import {
  detectBaseBranch,
  getChangedFiles,
  selectTests,
  E2E_TOUCHFILES,
  E2E_TIERS,
  LLM_JUDGE_TOUCHFILES,
  GLOBAL_TOUCHFILES,
} from '../../test/helpers/touchfiles';

export { PAID_TEST_GLOBS, isPaidTestFile };
export { PERIODIC_CI_EXCLUDE };

type E2EShardReuse = NonNullable<ReturnType<typeof prepareE2EShardReuse>>;
import { CASE_KEY_SEPARATOR, CASE_SHARDED_FILES, type CaseTrialPlan, caseTrialPlan, codexShardAccess, expandCaseShards, expandTrialShards, isIsolatedCase, partitionCaseExclusions, sameTrialPlan, shardCaseId, shardFile, shardTrial } from './paid-cases';
import { DEFAULT_JOBS, OVERLAY_MAX_ACTIVE_SHARDS, PAID_TIERS, type PaidCaseSelection, type PaidProfile, type PaidShardBudget, type PaidTier, ROOT, type ShardOutcome, type ShardStatus, type ShardTrialRecord, collectPaidTestFiles, computePaidCaseSelection, expectedPrCaseCount, isAllSkippedPass, isOverlayTestFile, paidShardWallUpperBoundMs, partitionShardsByDiffSelection, planPaidShards, prProfileFileSelected, resolvePaidShardBudget, resolvePaidShardTimeoutMs, sameBudget, selectPaidTestFiles, shardSlug, validatedProfile } from '../test-paid-shards';

// ─── Planner / executor / report (the CI re-platform surface) ──────────────
// One PLANNER computes selection and the slice plan ONCE; K executor jobs
// consume it; a REPORT reconciles results against the plan. This kills two
// classes at the root: per-slice selector divergence (one slice failing
// merge-base resolution and running a different partition than its siblings)
// and hollow lanes (a missing/failed slice that artifact-presence aggregation
// would read as green). CI wiring: evals.yml planner job → K-way matrix of
// `--plan manifest.json --slice i` → report job running `--report <dir>`.

export interface ManifestEntry {
  file: string;
  /** 1-based executor slice for planned entries; 0 for skipped/excluded. */
  slice: number;
  status: 'planned' | 'skipped-by-diff' | 'excluded';
  reason?: string;
  /** Required when a registered retry-budget file is planned. */
  budget?: PaidShardBudget;
  /** Budget-mode packing weight (recorded wall, or the whole budget when unknown). */
  estimatedMs?: number;
  /** Isolated trial shard (`<file>#<id>~t<N>`): the case's kind, fixed panel and quarantine at plan time. */
  trial?: CaseTrialPlan;
  /** File shard whose isolated cases run as trial shards: their ids, excluded by name here. */
  excludeCases?: string[];
}

/** Budget-mode plan: per-executor estimate and the CI job timeout it needs. */
export interface PaidSlicePlan {
  sliceBudgetMs: number;
  jobs: number;
  estimatedSliceMs: number[];
  ciTimeoutMinutes: number;
  /** Slices that run only Codex shards; CI executes them on the host-run Codex job, where bubblewrap can start. */
  codexSlices?: number[];
}

export interface PaidRunManifest {
  version: 1;
  tier: PaidTier;
  evalsAll: boolean;
  sliceCount: number;
  selectionReason: string;
  /** Legacy v1 manifests omit these; new plans bind case-level execution. */
  profile?: PaidProfile;
  selection?: PaidCaseSelection;
  prCoverage?: PrProfileSelection;
  plan?: PaidSlicePlan;
  entries: ManifestEntry[];
}

/**
 * Paid evals never retry (approved 2026-09-29): a failed verdict is final for
 * its run, and trials are fixed by kind before the run (EVAL_POLICY). The
 * function stays the single statement of that policy for the Bun arguments
 * and the reuse identity.
 */
export function retriesForFiles(_files: string[]): number {
  return 0;
}

export const PAID_TEST_DURATIONS_FILE = 'scripts/paid-test-durations.json';

/**
 * Recorded per-file paid-shard wall times (ms) per tier from real CI slice
 * reports (a file's gate and periodic cases differ), refreshed with
 * `--report <dir> --write-durations`. A packing hint only: a missing or
 * corrupt seed keeps the supervision-budget allocation.
 */
export function loadPaidTestDurations(rootDir = ROOT, tier: PaidTier = 'gate'): Record<string, number> {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(rootDir, PAID_TEST_DURATIONS_FILE), 'utf8')) as { version?: unknown; tiers?: Record<string, Record<string, unknown>> };
    if (parsed.version !== 2) return {};
    return Object.fromEntries(Object.entries(parsed.tiers?.[tier] ?? {})
      .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] > 0));
  } catch {
    return {};
  }
}

/** Rewrite one tier of the committed seed, keeping the other tiers. */
export function writePaidTestDurations(tier: PaidTier, durations: Record<string, number>, rootDir = ROOT): void {
  const target = path.join(rootDir, PAID_TEST_DURATIONS_FILE);
  const tiers = Object.fromEntries(PAID_TIERS.map(name => [name, loadPaidTestDurations(rootDir, name)])
    .filter(([name, recorded]) => name === tier || Object.keys(recorded as object).length > 0));
  tiers[tier] = durations;
  const temporary = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify({ version: 2, recordedAt: new Date().toISOString(), tiers }, null, 2)}\n`);
  fs.renameSync(temporary, target);
}

/** Seed key of a shard: trials of one case share their case key (`<file>#<id>`). */
function durationKey(key: string): string {
  const rel = normalizeRelativePath(key);
  return shardTrial(rel) === null ? rel : `${shardFile(rel)}${CASE_KEY_SEPARATOR}${shardCaseId(rel)}`;
}

/** Recorded wall of a shard key; an unrecorded trial falls back to its whole file's wall. */
export function recordedShardMs(recorded: Record<string, number>, key: string): number | undefined {
  const rel = normalizeRelativePath(key);
  return recorded[durationKey(rel)] ?? (shardTrial(rel) === null ? undefined : recorded[shardFile(rel)]);
}

/** Longest recorded wall a PR-lane (gate) shard may have: the lane's ~10-minute case target. */
export const PR_LANE_SHARD_LIMIT_MS = 600_000;

/** One line per planned shard whose recorded wall exceeds `limitMs` (split or shorten it; never raise the limit). */
export function shardDurationViolations(keys: readonly string[], recorded: Record<string, number>, limitMs = PR_LANE_SHARD_LIMIT_MS): string[] {
  return keys.flatMap(key => {
    const ms = recorded[durationKey(key)];
    return ms !== undefined && ms > limitMs ? [`${key}: recorded ${Math.round(ms / 1000)}s > ${limitMs / 1000}s`] : [];
  });
}

/**
 * Merge a report's executed single-file outcomes into the seed; all-skipped
 * shards carry no cost signal. Trials of one case record their longest wall
 * under the case key.
 */
export function mergePaidTestDurations(seed: Record<string, number>, results: SliceResult[]): Record<string, number> {
  const merged = { ...seed };
  const fresh = new Map<string, number>();
  for (const result of results) {
    for (const outcome of result.outcomes) {
      if (outcome.files.length !== 1 || outcome.elapsedMs < 1_000 || isAllSkippedPass(outcome) || outcome.reused) continue;
      const key = durationKey(outcome.files[0]!);
      fresh.set(key, Math.max(fresh.get(key) ?? 0, outcome.elapsedMs));
    }
  }
  for (const [key, ms] of fresh) merged[key] = ms;
  return Object.fromEntries(Object.entries(merged).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** True when a shard key's file sees the CI Codex install in `tier` (scripts/lib/paid-cases.ts codexShardAccess). */
export function isCodexShard(key: string, tier: PaidTier): boolean {
  return codexShardAccess([shardFile(key)], tier) !== 'none';
}

/** Sorted slices holding at least one planned Codex shard. */
export function codexSlicesOf(tier: PaidTier, entries: readonly ManifestEntry[]): number[] {
  return [...new Set(entries.filter(entry => entry.status === 'planned' && isCodexShard(entry.file, tier)).map(entry => entry.slice))].sort((a, b) => a - b);
}

/** Panel identity of a trial shard key (`<file>#<id>`), else null. */
export function trialPanelKey(key: string): string | null {
  return shardTrial(key) === null ? null : durationKey(key);
}

/** True when `key` is a trial whose panel already has a trial in `planned`. */
function sharesPanel(planned: readonly string[], key: string): boolean {
  const panel = trialPanelKey(key);
  return panel !== null && planned.some(other => other !== key && trialPanelKey(other) === panel);
}

/** Setup, image pull and artifact upload allowance on top of a slice's supervised wall. */
export const CI_SETUP_ALLOWANCE_MINUTES = 20;

/** Estimated wall of one executor running `files` in order on `jobs` FIFO workers. */
export function estimatedSliceMs(files: string[], weight: (file: string) => number, jobs: number): number {
  const workers = Array<number>(Math.max(1, jobs)).fill(0);
  for (const file of files) {
    const next = workers.indexOf(Math.min(...workers));
    workers[next] += weight(file);
  }
  return Math.max(...workers);
}

/** Executor order within a slice: longest recorded work first, then by path. */
export function sliceExecutionOrder<T extends { file: string; estimatedMs?: number }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => (b.estimatedMs ?? 0) - (a.estimatedMs ?? 0) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

/** Supervised worst case of one slice in execution order, overlays at their own admission limit. */
export function sliceSupervisedWallMs(files: string[], jobs: number, overrideMs?: number): number {
  return paidShardWallUpperBoundMs(files.filter(file => !isOverlayTestFile(file)), jobs, overrideMs)
    + paidShardWallUpperBoundMs(files.filter(isOverlayTestFile), Math.min(jobs, OVERLAY_MAX_ACTIVE_SHARDS), overrideMs);
}

/**
 * Budget packing: one runner per file or per tightly packed group. Files go
 * longest-recorded-first into the fullest slice whose estimated wall stays
 * within the budget (best fit), else into a new slice. A file with no recorded
 * wall weighs the whole budget, so unknown cost gets a runner of its own. A
 * file longer than the budget runs alone. Overlay wrappers keep one shared
 * final slice (one wrapper at a time). Codex shards never share a slice with
 * other shards. The CI timeout covers every slice's supervised worst case plus
 * the setup allowance.
 */
export function packBySliceBudget(files: string[], budgetMs: number, jobs: number,
  recorded: Record<string, number>, timeoutMs?: number, codexShard: (file: string) => boolean = () => false): {
  slices: string[][]; estimates: Record<string, number>; estimatedSliceMs: number[]; ciTimeoutMinutes: number;
} {
  const estimates = Object.fromEntries(files.map(file => [file, recordedShardMs(recorded, file) ?? budgetMs]));
  const weight = (file: string) => estimates[file]!;
  const slices: string[][] = [];
  for (const file of sliceExecutionOrder(files.filter(file => !isOverlayTestFile(file)).map(file => ({ file, estimatedMs: weight(file) }))).map(entry => entry.file)) {
    let best = -1, bestMs = -1;
    slices.forEach((planned, index) => {
      // Trials of one case never share a runner: independent machines, and
      // the panel's wall stays one trial long.
      if (sharesPanel(planned, file)) return;
      // Codex shards run on the host-run Codex job; other shards keep the default container sandbox.
      if (codexShard(planned[0]!) !== codexShard(file)) return;
      const ms = estimatedSliceMs([...planned, file], weight, jobs);
      if (ms <= budgetMs && ms > bestMs) { best = index; bestMs = ms; }
    });
    if (best < 0) slices.push([file]);
    else slices[best]!.push(file);
  }
  const overlays = files.filter(isOverlayTestFile).sort();
  if (overlays.length) slices.push(sliceExecutionOrder(overlays.map(file => ({ file, estimatedMs: weight(file) }))).map(entry => entry.file));
  if (!slices.length) slices.push([]);
  const estimatedSliceMsList = slices.map(planned => planned.some(isOverlayTestFile)
    ? estimatedSliceMs(planned, weight, Math.min(jobs, OVERLAY_MAX_ACTIVE_SHARDS)) : estimatedSliceMs(planned, weight, jobs));
  const worst = Math.max(0, ...slices.map(planned => sliceSupervisedWallMs(planned, jobs, timeoutMs)));
  return { slices, estimates, estimatedSliceMs: estimatedSliceMsList,
    ciTimeoutMinutes: Math.ceil(worst / 60_000) + CI_SETUP_ALLOWANCE_MINUTES };
}

/** Worker counts whose worst-case slice wall duration packing may never worsen. */
export const SUPERVISED_WORKER_COUNTS = [1, 2, 3, 4] as const;

/**
 * Allocate the RUNNABLE shard plan across K slices — deterministic. Registered
 * long files are spread by supervision budget and the rest round-robin; that
 * baseline fixes each slice's worst-case wall. With a duration seed, files are
 * then re-packed longest-recorded-first onto the lightest slice, accepting a
 * placement only if no slice's worst-case wall exceeds the baseline's maximum
 * for any supervised worker count. If any file cannot be placed, the baseline
 * stands.
 */
export function buildRunManifest(opts: {
  tier: PaidTier;
  profile?: PaidProfile;
  /** Fixed slice count; exclusive with sliceBudgetMs. */
  sliceCount?: number;
  /** Budget mode: pack recorded work so each executor's estimated wall stays
   * within this budget; the slice count follows from the plan. */
  sliceBudgetMs?: number;
  /** Shard workers per executor (EVALS_JOBS) that budget mode plans for. */
  jobs?: number;
  evalsAll: boolean;
  timeoutMs?: number;
  discovered?: string[];
  env?: NodeJS.ProcessEnv;
  rootDir?: string;
  changedFiles?: string[];
  /** Recorded per-file durations; defaults to the committed seed under rootDir. */
  durations?: Record<string, number>;
  /** Weekly gate census only: LLM judges already run in the periodic census and PR gate lanes. */
  skipJudges?: boolean;
  /** Injectable registries (default: E2E_KINDS and CASE_QUARANTINE). */
  kinds?: Record<string, EvalCaseKind>;
  quarantine?: Record<string, unknown>;
}): PaidRunManifest {
  const budgetMode = opts.sliceBudgetMs !== undefined;
  if (budgetMode === (opts.sliceCount !== undefined)) throw new Error('Plan with exactly one of --slices or --slice-budget');
  if (budgetMode && (!Number.isSafeInteger(opts.sliceBudgetMs) || opts.sliceBudgetMs! <= 0 || !Number.isSafeInteger(opts.jobs) || opts.jobs! <= 0)) {
    throw new Error('--slice-budget needs a positive budget and an explicit positive --jobs');
  }
  if (!budgetMode && (!Number.isInteger(opts.sliceCount) || opts.sliceCount! <= 0)) {
    throw new Error(`--slices needs a positive integer. Received: ${opts.sliceCount}`);
  }
  const rootDir = opts.rootDir ?? ROOT;
  const env = opts.env ?? process.env;
  const profile = opts.profile ?? validatedProfile(env.EVALS_PROFILE, 'EVALS_PROFILE');
  if (profile === 'pr' && opts.tier !== 'gate') throw new Error('PR profile requires gate tier; use --profile full for periodic coverage');
  const discovered = opts.discovered ?? collectPaidTestFiles(rootDir);
  const tierSelection = selectPaidTestFiles(discovered, opts.tier, rootDir, env);
  const judge = (file: string) => /^test\/skill-llm-eval[^/]*\.test\.ts$/.test(normalizeRelativePath(file));
  const selected = opts.skipJudges ? tierSelection.selected.filter(file => !judge(file)) : tierSelection.selected;
  const kinds = opts.kinds ?? E2E_KINDS;
  const quarantine = opts.quarantine ?? CASE_QUARANTINE;
  const notLive = [...Object.keys(kinds).filter(id => kinds[id] === 'behavior'), ...Object.keys(quarantine)].filter(id => !Object.hasOwn(E2E_TIERS, id));
  if (notLive.length) throw new Error(`Only live E2E cases can be behavior or quarantined (judges sample their panel inside the case): ${notLive.join(', ')}`);
  const caseKeys = partitionCaseExclusions(expandCaseShards(selected, opts.tier, rootDir));
  const excluded = [...tierSelection.excluded, ...(opts.skipJudges ? tierSelection.selected.filter(judge)
    .map(file => ({ file, reason: 'skipped: LLM judges run in the periodic census and PR gate lanes' })) : []), ...caseKeys.excluded];
  const expansion = expandTrialShards(caseKeys.runnable, opts.tier, rootDir, { kinds, quarantine });
  const excludeOf = (key: string) => expansion.excludeCases[normalizeRelativePath(key)] ?? [];
  const shards = planPaidShards(expansion.keys, { maxFilesPerShard: 1 });
  const cases = computePaidCaseSelection({ profile, env, rootDir, changedFiles: opts.changedFiles });
  const fast = cases.coverage?.mode === 'pr';
  const profileShards = fast ? shards.filter(files => prProfileFileSelected(files[0], cases.selection, excludeOf(files[0]!))) : shards;
  const { runnable, skipped } = partitionShardsByDiffSelection(profileShards,
    cases.selection.e2e === null ? null : new Set(cases.selection.e2e), { rootDir, excludeCases: expansion.excludeCases });
  if (fast) for (const files of shards) {
    if (!prProfileFileSelected(files[0], cases.selection, excludeOf(files[0]!))) skipped.push({ files, reason: 'Outside the fast PR profile; retained in broad gate/periodic coverage' });
  }
  const extras = (key: string): Pick<ManifestEntry, 'trial' | 'excludeCases'> => {
    const trial = expansion.trials[normalizeRelativePath(key)];
    const exclude = expansion.excludeCases[normalizeRelativePath(key)];
    return { ...(trial ? { trial } : {}), ...(exclude ? { excludeCases: exclude } : {}) };
  };

  const entries: ManifestEntry[] = [];
  if (budgetMode) {
    const plan = packBySliceBudget(runnable.map(files => files[0]!), opts.sliceBudgetMs!, opts.jobs!,
      opts.durations ?? loadPaidTestDurations(rootDir, opts.tier), opts.timeoutMs, file => isCodexShard(file, opts.tier));
    plan.slices.forEach((files, index) => files.forEach(file => entries.push({ file, slice: index + 1, status: 'planned',
      estimatedMs: plan.estimates[file]!, ...extras(file),
      ...(FILE_RETRY_BUDGETS.some(budget => budget.file === shardFile(file)) ? { budget: resolvePaidShardBudget([file], opts.timeoutMs) } : {}) })));
    for (const s of skipped) entries.push({ file: s.files[0], slice: 0, status: 'skipped-by-diff', reason: s.reason, ...extras(s.files[0]!) });
    for (const e of excluded) entries.push({ file: e.file, slice: 0, status: 'excluded', reason: e.reason });
    entries.sort((a, b) => (a.file < b.file ? -1 : 1));
    return parseRunManifest(JSON.stringify({
      version: 1, tier: opts.tier, evalsAll: opts.evalsAll, sliceCount: plan.slices.length,
      selectionReason: cases.reason, profile, selection: cases.selection,
      ...(cases.coverage ? { prCoverage: cases.coverage } : {}),
      plan: { sliceBudgetMs: opts.sliceBudgetMs!, jobs: opts.jobs!, estimatedSliceMs: plan.estimatedSliceMs, ciTimeoutMinutes: plan.ciTimeoutMinutes,
        codexSlices: codexSlicesOf(opts.tier, entries) },
      entries,
    } satisfies PaidRunManifest));
  }
  const sliceCount = opts.sliceCount!;
  const overlaySlice = sliceCount;
  const reserveOverlaySlice = overlaySlice > 1 && runnable.some(files => files.some(isOverlayTestFile));
  const ordinarySlices = overlaySlice - Number(reserveOverlaySlice);
  // Spread registered long files by supervised load. Keep one ordinary-only
  // lane when possible, so every lane does not inherit a long-workflow tail.
  // The reserved overlay slice retains its ownership.
  const ordinary = runnable.filter(files => !files.some(isOverlayTestFile));
  const registered = ordinary.filter(files => FILE_RETRY_BUDGETS.some(budget => budget.file === shardFile(files[0]!)));
  const allocations = new Map<string, number>();
  if (registered.length && ordinarySlices > 1) {
    const loads = Array<number>(ordinarySlices).fill(0);
    const longLanes = ordinarySlices - Number(registered.length < ordinary.length);
    const registeredFiles = new Set(registered.map(files => files[0]));
    const byWall = (a: string[], b: string[]) =>
      resolvePaidShardTimeoutMs(b, opts.timeoutMs) - resolvePaidShardTimeoutMs(a, opts.timeoutMs) ||
      (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    for (const files of [...registered].sort(byWall).concat(
      ordinary.filter(files => !registeredFiles.has(files[0])))) {
      const lanes = registeredFiles.has(files[0]) ? longLanes : ordinarySlices;
      const laneKeys = (index: number) => [...allocations].filter(([, lane]) => lane === index + 1).map(([key]) => key);
      // A trial whose siblings already hold every long lane may use any
      // ordinary lane: independent runners outrank long-lane ownership.
      const pick = (limit: number) => {
        let best = -1;
        for (let index = 0; index < limit; index++) {
          if (sharesPanel(laneKeys(index), files[0]!)) continue;
          if (best < 0 || loads[index] < loads[best]) best = index;
        }
        return best;
      };
      let lane = pick(lanes);
      if (lane < 0) lane = pick(ordinarySlices);
      if (lane < 0) lane = loads.slice(0, lanes).indexOf(Math.min(...loads.slice(0, lanes)));
      allocations.set(files[0], lane + 1);
      loads[lane] += resolvePaidShardTimeoutMs(files, opts.timeoutMs);
    }
  }
  let ordinaryIndex = 0;
  for (const files of ordinary) {
    if (allocations.has(files[0])) continue;
    // Round-robin, skipping a lane that already holds a trial of the same panel.
    let lane = ordinaryIndex % ordinarySlices;
    for (let step = 0; step < ordinarySlices; step++) {
      const candidate = (ordinaryIndex + step) % ordinarySlices;
      if (!sharesPanel([...allocations].filter(([, l]) => l === candidate + 1).map(([key]) => key), files[0]!)) { lane = candidate; break; }
    }
    ordinaryIndex++;
    allocations.set(files[0], lane + 1);
  }
  const packed = packByRecordedDuration();
  function packByRecordedDuration(): Map<string, number> | null {
    const recorded = opts.durations ?? loadPaidTestDurations(rootDir, opts.tier);
    if (ordinarySlices < 2 || ordinary.length === 0 || Object.keys(recorded).length === 0) return null;
    const bound = (files: string[], jobs: number) => paidShardWallUpperBoundMs([...files].sort(), jobs, opts.timeoutMs);
    const lanes = Array.from({ length: ordinarySlices }, (_, lane) =>
      ordinary.filter(files => allocations.get(files[0]) === lane + 1).map(files => files[0]));
    const caps = SUPERVISED_WORKER_COUNTS.map(jobs => Math.max(...lanes.map(files => bound(files, jobs))));
    const fits = (files: string[]) => SUPERVISED_WORKER_COUNTS.every((jobs, k) => bound(files, jobs) <= caps[k]);
    const known = ordinary.map(files => recordedShardMs(recorded, files[0]!))
      .filter((ms): ms is number => ms !== undefined).sort((a, b) => a - b);
    const fallback = known.length ? known[Math.min(known.length - 1, Math.floor(known.length * 0.75))] : 1;
    const weight = (file: string) => recordedShardMs(recorded, file) ?? fallback;
    const load = (files: string[]) => files.reduce((sum, file) => sum + weight(file), 0);
    const registeredFiles = new Set(registered.map(files => files[0]));
    // Local search from the supervised baseline: move or swap a file out of
    // the heaviest slice whenever that lowers its recorded load without
    // making the other slice the new maximum or breaching any worst-case cap.
    // Registered files only trade places with registered files, so the long
    // lanes keep their ownership.
    for (let step = 0; step < 10 * ordinary.length; step++) {
      const loads = lanes.map(load);
      const heavy = loads.indexOf(Math.max(...loads));
      let best: { gain: number; apply: () => void } | null = null;
      for (let other = 0; other < lanes.length; other++) {
        if (other === heavy) continue;
        for (const a of lanes[heavy]) {
          const moves: Array<string | null> = registeredFiles.has(a) ? lanes[other].filter(b => registeredFiles.has(b)) : [null, ...lanes[other].filter(b => !registeredFiles.has(b))];
          for (const b of moves) {
            const delta = weight(a) - (b === null ? 0 : weight(b));
            if (delta <= 0 || loads[other] + delta >= loads[heavy]) continue;
            const gain = Math.min(delta, loads[heavy] - loads[other] - delta);
            if (best && gain <= best.gain) continue;
            const heavyAfter = lanes[heavy].filter(file => file !== a).concat(b === null ? [] : [b]);
            const otherAfter = lanes[other].filter(file => file !== b).concat([a]);
            if (!fits(heavyAfter) || !fits(otherAfter)) continue;
            if (sharesPanel(otherAfter, a) || (b !== null && sharesPanel(heavyAfter, b))) continue;
            const [h, o] = [heavy, other];
            best = { gain, apply: () => { lanes[h] = heavyAfter; lanes[o] = otherAfter; } };
          }
        }
      }
      if (!best) break;
      best.apply();
    }
    return new Map(lanes.flatMap((files, lane) => files.map(file => [file, lane + 1] as const)));
  }
  runnable.forEach((files) => {
    const slice = files.some(isOverlayTestFile) ? overlaySlice : (packed ?? allocations).get(files[0])!;
    entries.push({ file: files[0], slice, status: 'planned', ...extras(files[0]!),
      ...(FILE_RETRY_BUDGETS.some(budget => budget.file === shardFile(files[0]!))
        ? { budget: resolvePaidShardBudget(files, opts.timeoutMs) } : {}) });
  });
  for (const s of skipped) entries.push({ file: s.files[0], slice: 0, status: 'skipped-by-diff', reason: s.reason, ...extras(s.files[0]!) });
  for (const e of excluded) entries.push({ file: e.file, slice: 0, status: 'excluded', reason: e.reason });
  entries.sort((a, b) => (a.file < b.file ? -1 : 1));

  const manifest: PaidRunManifest = {
    version: 1,
    tier: opts.tier,
    evalsAll: opts.evalsAll,
    sliceCount,
    selectionReason: cases.reason,
    profile,
    selection: cases.selection,
    ...(cases.coverage ? { prCoverage: cases.coverage } : {}),
    entries,
  };
  return parseRunManifest(JSON.stringify(manifest));
}

/**
 * Narrow a built manifest to a curated case subset (validation phases): the
 * selection binds every child, and a case shard outside it can execute
 * nothing, so it becomes skipped instead of an empty planned shard.
 */
export function restrictManifestSelection(manifest: PaidRunManifest, selection: PaidCaseSelection, reason: string): PaidRunManifest {
  const entries = manifest.entries.map(entry => {
    const caseId = shardCaseId(entry.file);
    if (entry.status !== 'planned' || caseId === null || selection.e2e === null || selection.e2e.includes(caseId)) return entry;
    const { estimatedMs: _estimate, budget: _budget, ...rest } = entry;
    return { ...rest, slice: 0, status: 'skipped-by-diff' as const, reason };
  });
  return parseRunManifest(JSON.stringify({ ...manifest, selection, entries }));
}

export function parseRunManifest(raw: string): PaidRunManifest {
  const parsed = JSON.parse(raw) as PaidRunManifest;
  if (parsed.version !== 1) throw new Error(`unsupported manifest version: ${(parsed as { version?: unknown }).version}`);
  if (!PAID_TIERS.includes(parsed.tier)) throw new Error(`manifest tier invalid: ${parsed.tier}`);
  if (parsed.profile !== undefined && parsed.profile !== 'pr' && parsed.profile !== 'full') throw new Error('manifest profile invalid');
  if (parsed.selection !== undefined) {
    for (const [key, inventory] of [['e2e', E2E_TOUCHFILES], ['judges', LLM_JUDGE_TOUCHFILES]] as const) {
      const ids = parsed.selection?.[key];
      if (ids !== null && (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !Object.hasOwn(inventory, id)) || new Set(ids).size !== ids.length)) {
        throw new Error(`manifest ${key} selection invalid`);
      }
    }
  }
  if (parsed.profile === 'pr') {
    const coverage = parsed.prCoverage;
    if (parsed.tier !== 'gate' || !parsed.selection || !coverage ||
        !['pr', 'full-fallback'].includes(coverage.mode) || !Array.isArray(coverage.deferred) ||
        !Array.isArray(coverage.unknownFiles) || !Array.isArray(coverage.missingCoverage) ||
        !Array.isArray(coverage.deferredPromptFiles) || coverage.deferredPromptFiles.some(file => typeof file !== 'string') ||
        !Array.isArray(coverage.e2e) || !Array.isArray(coverage.judges) ||
        coverage.unknownFiles.some(file => typeof file !== 'string') ||
        coverage.needsFullValidation !== false || coverage.missingCoverage.length !== 0 ||
        JSON.stringify(parsed.selection.e2e) !== JSON.stringify(coverage.e2e) ||
        JSON.stringify(parsed.selection.judges) !== JSON.stringify(coverage.judges)) {
      throw new Error('manifest PR coverage/selection invalid or requires full validation');
    }
    if (coverage.mode === 'pr' && coverage.e2e.some(id => !prProfileCaseAllowed(id, coverage.directCases ?? []))) {
      throw new Error('manifest PR selection contains a broad-only case');
    }
    if (coverage.deferred.some(item => !Object.hasOwn(E2E_TOUCHFILES, item.id) || E2E_TIERS[item.id] !== item.tier || typeof item.reason !== 'string')) {
      throw new Error('manifest deferred case is outside the broad census');
    }
  }
  if (!Number.isInteger(parsed.sliceCount) || parsed.sliceCount <= 0) throw new Error('manifest sliceCount invalid');
  if (!Array.isArray(parsed.entries)) throw new Error('manifest entries missing');
  for (const entry of parsed.entries) {
    if (typeof entry.file !== 'string' || !Number.isInteger(entry.slice)) throw new Error('manifest entry malformed');
    if (!['planned', 'skipped-by-diff', 'excluded'].includes(entry.status)) throw new Error(`manifest entry status invalid: ${entry.status}`);
    if (entry.status === 'planned' && (entry.slice < 1 || entry.slice > parsed.sliceCount)) {
      throw new Error(`planned entry ${entry.file} has out-of-range slice ${entry.slice}`);
    }
    if (entry.estimatedMs !== undefined && (entry.status !== 'planned' || !Number.isSafeInteger(entry.estimatedMs) || entry.estimatedMs < 0)) {
      throw new Error(`manifest entry ${entry.file} has an invalid estimate`);
    }
    if (entry.status === 'planned' && parsed.prCoverage?.mode === 'pr' && !prProfileFileSelected(entry.file, parsed.selection!, entry.excludeCases ?? [])) {
      throw new Error(`manifest file is outside its PR case selection: ${entry.file}`);
    }
  }
  for (const entry of parsed.entries) {
    const caseId = shardCaseId(entry.file);
    const trial = shardTrial(entry.file);
    if (trial !== null) {
      const plan = entry.trial;
      const expected = plan && ['rule', 'behavior', 'judge'].includes(plan.kind) && typeof plan.quarantined === 'boolean'
        ? caseTrialPlan(caseId!, { [caseId!]: plan.kind }, plan.quarantined ? { [caseId!]: true } : {}) : undefined;
      if (!Object.hasOwn(E2E_TOUCHFILES, caseId!) || !E2E_TOUCHFILES[caseId!]!.includes(shardFile(entry.file))
        || !plan || !expected || !isIsolatedCase(expected) || !sameTrialPlan(plan, expected) || trial > plan.panel.n) {
        throw new Error(`Trial shard must name a registered isolated case of its file with its fixed policy panel: ${entry.file}`);
      }
    } else if (entry.trial !== undefined) {
      throw new Error(`Only trial shards carry a trial plan: ${entry.file}`);
    } else if (caseId === null ? entry.status === 'planned' && CASE_SHARDED_FILES.includes(shardFile(entry.file))
      : !CASE_SHARDED_FILES.includes(shardFile(entry.file)) || !(caseId in E2E_TOUCHFILES)) {
      throw new Error(`Case-sharded files plan one registered case per shard: ${entry.file}`);
    }
    if (entry.excludeCases !== undefined && (caseId !== null || !Array.isArray(entry.excludeCases) || entry.excludeCases.length === 0
      || entry.excludeCases.some(id => !parsed.entries.some(other => shardTrial(other.file) !== null
        && shardFile(other.file) === shardFile(entry.file) && shardCaseId(other.file) === id)))) {
      throw new Error(`A file shard may exclude only cases that run as its trial shards: ${entry.file}`);
    }
    if (caseId !== null && entry.status === 'planned' && parsed.selection?.e2e && !parsed.selection.e2e.includes(caseId)) {
      throw new Error(`Planned case shard is outside the manifest selection: ${entry.file}`);
    }
  }
  // Panels are whole: exactly n trial entries per isolated case with one plan
  // and one status, and planned trials on distinct slices when the ordinary
  // slices allow it.
  const panels = new Map<string, ManifestEntry[]>();
  for (const entry of parsed.entries) {
    const panel = trialPanelKey(entry.file);
    if (panel !== null) panels.set(panel, [...(panels.get(panel) ?? []), entry]);
  }
  const reservedOverlay = parsed.sliceCount > 1 && parsed.entries.some(entry => entry.status === 'planned' && isOverlayTestFile(entry.file));
  const ordinarySliceCount = parsed.sliceCount - Number(reservedOverlay);
  for (const [panel, trials] of panels) {
    const n = trials[0]!.trial!.panel.n;
    const indices = trials.map(entry => shardTrial(entry.file)!).sort((a, b) => a - b);
    if (indices.length !== n || indices.some((index, i) => index !== i + 1)
      || trials.some(entry => !sameTrialPlan(entry.trial, trials[0]!.trial) || entry.status !== trials[0]!.status)
      || parsed.entries.some(entry => normalizeRelativePath(entry.file) === panel)) {
      throw new Error(`Isolated case ${panel} must plan exactly its ${n} trials together`);
    }
    const slices = trials.filter(entry => entry.status === 'planned').map(entry => entry.slice);
    if (ordinarySliceCount >= n && new Set(slices).size !== slices.length) {
      throw new Error(`Trials of ${panel} share a slice; each trial needs its own runner`);
    }
  }
  if (parsed.prCoverage?.mode === 'pr') {
    const planned = parsed.entries.filter(entry => entry.status === 'planned').map(entry => normalizeRelativePath(entry.file));
    const required: string[][] = Object.entries(prProfileFileMap(parsed.selection!.e2e)).flatMap(([file, ids]) => {
      const selected = ids.filter(id => parsed.selection!.e2e!.includes(id));
      if (!selected.length) return [];
      const owners = new Set(selected.flatMap(id => {
        const trials = parsed.entries.filter(entry => shardTrial(entry.file) !== null && shardFile(entry.file) === file && shardCaseId(entry.file) === id);
        if (trials.length) return trials.map(entry => normalizeRelativePath(entry.file));
        return [CASE_SHARDED_FILES.includes(file) ? `${file}#${id}` : file];
      }));
      return [[...owners]];
    });
    if (parsed.selection!.judges!.length) required.push(['test/skill-llm-eval.test.ts']);
    for (const owners of required) {
      if (owners.some(owner => planned.filter(key => key === owner).length !== 1)
        || planned.filter(key => shardFile(key) === shardFile(owners[0]!)).length !== owners.length) {
        throw new Error(`PR selected cases require exactly one planned owning file: ${owners.join(', ')}`);
      }
    }
  }
  if (parsed.plan !== undefined) {
    const plan = parsed.plan;
    const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
    if (!plan || typeof plan !== 'object' || !count(plan.sliceBudgetMs) || !count(plan.jobs) || !count(plan.ciTimeoutMinutes)
      || !Array.isArray(plan.estimatedSliceMs) || plan.estimatedSliceMs.length !== parsed.sliceCount
      || !plan.estimatedSliceMs.every(ms => Number.isSafeInteger(ms) && ms >= 0)
      || parsed.entries.some(entry => entry.status === 'planned' && entry.estimatedMs === undefined)) {
      throw new Error('manifest slice plan malformed');
    }
    const codexSlices = codexSlicesOf(parsed.tier, parsed.entries);
    if (JSON.stringify(plan.codexSlices ?? []) !== JSON.stringify(codexSlices)) {
      throw new Error(`manifest Codex slices must be exactly the slices holding Codex shards: ${JSON.stringify(codexSlices)}`);
    }
    const mixed = parsed.entries.find(entry => entry.status === 'planned' && codexSlices.includes(entry.slice) && !isCodexShard(entry.file, parsed.tier));
    if (mixed) throw new Error(`Codex slice ${mixed.slice} also holds ${mixed.file}; only Codex shards run on the host-run Codex job`);
  }
  const keys = parsed.entries.map(entry => normalizeRelativePath(entry.file));
  if (new Set(keys).size !== keys.length) throw new Error('Duplicate manifest entry');
  // Unique result slugs: shard artifacts merge by path, so a shared slug would
  // let one trial's records overwrite another's.
  const slugs = new Map<string, string>();
  for (const entry of parsed.entries) {
    const slug = shardSlug([entry.file]);
    if (slugs.has(slug)) throw new Error(`Shards ${slugs.get(slug)} and ${entry.file} share the result slug ${slug}`);
    slugs.set(slug, entry.file);
  }
  const overlaySlice = parsed.sliceCount;
  const plannedOverlays = parsed.entries.filter(entry => entry.status === 'planned' && isOverlayTestFile(entry.file));
  if (plannedOverlays.some(entry => entry.slice !== overlaySlice)) {
    throw new Error('Overlay manifest entries must share the final ordinary slice to preserve one-process API admission');
  }
  if (plannedOverlays.length && overlaySlice > 1 && parsed.entries.some(entry =>
      entry.status === 'planned' && !isOverlayTestFile(entry.file) && entry.slice === overlaySlice)) {
    throw new Error('The final ordinary manifest slice is reserved for overlay files');
  }
  for (const budget of FILE_RETRY_BUDGETS) {
    const entries = parsed.entries.filter(entry => shardFile(entry.file) === budget.file);
    const fileKeys = entries.filter(entry => shardCaseId(entry.file) === null).length;
    const caseKeys = entries.filter(entry => shardCaseId(entry.file) !== null && shardTrial(entry.file) === null).length;
    if (fileKeys > 1 || (fileKeys === 1 && caseKeys > 0)) throw new Error(`Duplicate registered manifest entry: ${budget.file}`);
    for (const entry of entries.filter(entry => entry.status === 'planned')) {
      if (!entry.budget) throw new Error(`Registered manifest needs an explicit budget record: ${budget.file}`);
      const expected = resolvePaidShardBudget([entry.file], entry.budget.source === 'explicit' ? entry.budget.timeoutMs : undefined);
      if (!sameBudget(entry.budget, expected)) throw new Error(`Registered manifest budget differs from declared policy: ${budget.file}`);
    }
  }
  return parsed;
}

export interface SliceResult {
  version: 1;
  tier: PaidTier;
  profile?: PaidProfile;
  selection?: PaidCaseSelection;
  sliceIndex: number;
  sliceCount: number;
  timeoutOverrideMs?: number;
  /** CI run attempt (github.run_attempt) that produced this slice; absent means 1. */
  attempt?: number;
  /** Epoch ms bounds of the slice's shard execution (lane wall time). */
  startedAt?: number;
  finishedAt?: number;
  outcomes: Array<Pick<ShardOutcome, 'files' | 'status' | 'exitCode' | 'elapsedMs' | 'executedTests' | 'skippedTests' | 'budget' | 'reused' | 'runnerError' | 'trial' | 'inputKey'>>;
}

/**
 * Slice exit = execution completeness, never the semantic verdict. A rule
 * shard that did not pass fails the slice (unchanged fail-closed rule); an
 * isolated trial shard fails it only when the harness produced no trial
 * record. Failed, timed-out or crashed trials are verdict input for the
 * report's panelVerdict(), so a 2/3 PASS panel never reds its runner.
 */
export function sliceExitCode(outcomes: ReadonlyArray<Pick<ShardOutcome, 'status' | 'trial'>>): number {
  return outcomes.every(outcome => outcome.trial !== undefined
    ? outcome.trial.outcome !== null
    : outcome.status === 'passed' || outcome.status === 'skipped-by-diff') ? 0 : 1;
}

/** A hollow-guarded trial shard has no trial record: the guard's verdict is a harness problem. */
export function guardTrialRecords<T extends Pick<ShardOutcome, 'status' | 'trial'>>(outcomes: T[]): T[] {
  return outcomes.map(outcome => outcome.trial && outcome.status === 'passed-empty' && outcome.trial.outcome !== null
    ? { ...outcome, trial: { ...outcome.trial, outcome: null, harness: 'hollow: executed no case' } } : outcome);
}

/**
 * Reconcile slice results against the manifest — the fail-closed aggregation.
 * Problems (any → non-zero): a slice index missing entirely (a cancelled or
 * crashed executor whose artifact never landed), a planned entry no slice
 * reported, an entry reported by the wrong/duplicate slice, or any reported
 * outcome that is not a pass.
 */
export function verifySliceResults(
  manifest: PaidRunManifest,
  results: SliceResult[],
): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  try { parseRunManifest(JSON.stringify(manifest)); }
  catch (error) { problems.push(`Invalid run manifest: ${error instanceof Error ? error.message : String(error)}`); }
  const byIndex = new Map<number, SliceResult>();
  for (const result of results) {
    if (result.version !== 1) { problems.push(`slice result with unsupported version: ${String(result.version)}`); continue; }
    if (result.tier !== manifest.tier) problems.push(`slice ${result.sliceIndex} ran tier ${result.tier}, manifest says ${manifest.tier}`);
    if (manifest.profile === 'pr' && (result.profile !== 'pr' || JSON.stringify(result.selection) !== JSON.stringify(manifest.selection))) {
      problems.push(`slice ${result.sliceIndex} did not bind the manifest PR case selection`);
    }
    if (byIndex.has(result.sliceIndex)) problems.push(`duplicate result for slice ${result.sliceIndex}`);
    byIndex.set(result.sliceIndex, result);
  }
  for (let index = 1; index <= manifest.sliceCount; index += 1) {
    if (!byIndex.has(index)) problems.push(`slice ${index}/${manifest.sliceCount} reported NO result — cancelled/crashed executor, not a pass`);
  }

  const reported = new Map<string, { slice: number; status: ShardStatus; trial?: ShardTrialRecord }>();
  const planned = new Map(manifest.entries.map(entry => [normalizeRelativePath(entry.file), entry]));
  for (const result of results) {
    for (const outcome of result.outcomes) {
      if (outcome.files.some(file => FILE_RETRY_BUDGETS.some(budget => budget.file === shardFile(file)) || shardCaseId(file) !== null) && outcome.files.length !== 1) {
        problems.push('Registered result must report its own shard');
      }
      const file = normalizeRelativePath(outcome.files[0] ?? '');
      const trialPlan = planned.get(file)?.trial;
      if (manifest.prCoverage?.mode === 'pr') {
        const expected = expectedPrCaseCount(file, manifest.selection!, planned.get(file)?.excludeCases);
        const executed = outcome.executedTests === null || outcome.skippedTests === null
          ? -1 : outcome.executedTests - outcome.skippedTests;
        // A trial's exit status is its verdict (panelVerdict decides); its
        // completeness is the trial record checked below.
        if ((!trialPlan && outcome.exitCode !== 0) || expected < 1 || (!trialPlan && executed !== expected)) {
          problems.push(`PR profile expected ${expected} executed cases in ${file}, received ${executed}`);
        }
      }
      if (trialPlan) {
        const t = outcome.trial;
        if (!t || t.case !== shardCaseId(file) || t.trial !== shardTrial(file) || !sameTrialPlan(t, trialPlan)
          || !(t.outcome === null || ['passed', 'failed', 'skipped'].includes(t.outcome))
          || (t.outcome === 'failed') !== (t.failure_class !== undefined)) {
          problems.push(`${file}: trial record missing or does not match its planned trial`);
        }
      } else if (outcome.trial !== undefined) {
        problems.push(`${file}: an unplanned trial record`);
      }
      if (shardCaseId(file) !== null && outcome.status === 'passed'
        && (outcome.executedTests === null || outcome.skippedTests === null || outcome.executedTests - outcome.skippedTests !== 1)) {
        problems.push(`Case shard must execute exactly its one case: ${file}`);
      }
      if (outcome.reused !== undefined) {
        const r = outcome.reused;
        if (manifest.prCoverage?.mode !== 'pr') problems.push(`${file}: only the fast PR profile may reuse results; this lane executes fresh`);
        const reusedVerdictOk = outcome.trial ? outcome.trial.outcome !== null : outcome.status === 'passed' && outcome.exitCode === 0;
        if (!reusedVerdictOk || !/^[a-f0-9]{64}$/.test(r?.inputKey ?? '')
          || !/^[\w./-]{1,160}$/.test(r?.runId ?? '') || !/^[a-f0-9]{40}$/.test(r?.revision ?? '') || !Number.isSafeInteger(r?.completedAt) || r.completedAt <= 0) {
          problems.push(`${file}: malformed reused result`);
        }
      }
      if (outcome.inputKey !== undefined && !/^[a-f0-9]{64}$/.test(outcome.inputKey)) problems.push(`${file}: malformed input identity`);
      if (reported.has(file)) problems.push(`${file} reported by two slices`);
      reported.set(file, { slice: result.sliceIndex, status: outcome.status, ...(outcome.trial ? { trial: outcome.trial } : {}) });
      const registered = FILE_RETRY_BUDGETS.find(budget => budget.file === shardFile(file));
      const finding = STRICT_RETRY_CASE_BUDGETS.find(budget => budget.file === file);
      if (finding) {
        // Full-census runs must account for every registered case. A manifest
        // explicitly marked selective may report its executed subset.
        if (outcome.exitCode !== 0 || !Number.isInteger(outcome.executedTests) ||
            outcome.executedTests! < 1 || outcome.executedTests! > finding.cases ||
            (manifest.evalsAll !== false && outcome.executedTests !== finding.cases) || outcome.skippedTests !== 0) {
          problems.push(`Finding workflow must execute real unskipped cases with exit zero: ${file}`);
        }
      }
      if (registered) {
        try {
          const planned = manifest.entries.find(entry => normalizeRelativePath(entry.file) === file)?.budget;
          const expected = resolvePaidShardBudget([file], result.timeoutOverrideMs ??
            (planned?.source === 'explicit' ? planned.timeoutMs : undefined));
          if (!sameBudget(outcome.budget, expected)) problems.push(`Registered effective result budget differs from its planned/explicit allocation: ${file}`);
        } catch { problems.push(`Invalid registered effective result budget: ${file}`); }
      }
    }
  }
  for (const entry of manifest.entries) {
    if (entry.status !== 'planned') continue;
    const got = reported.get(normalizeRelativePath(entry.file));
    if (!got) {
      if (byIndex.has(entry.slice)) problems.push(`planned ${entry.file} (slice ${entry.slice}) was never reported`);
      continue; // the missing-slice problem above already covers it
    }
    if (got.slice !== entry.slice) problems.push(`${entry.file} planned for slice ${entry.slice} but reported by slice ${got.slice}`);
    // Isolated trial shards: harness health only; the panel verdict gates.
    if (entry.trial) {
      if (got.trial?.outcome === null) problems.push(`${entry.file}: no trial record (${got.trial.harness ?? 'unknown'})`);
    } else if (got.status !== 'passed') problems.push(`${entry.file}: ${got.status}`);
  }
  return { ok: problems.length === 0, problems };
}

/** Budget-mode plan lines: every slice with its estimate, files and retries. */
export function formatSlicePlan(manifest: PaidRunManifest): string[] {
  const plan = manifest.plan;
  if (!plan) return [];
  const minutes = (ms: number) => (ms / 60_000).toFixed(1);
  const lines = [`[test:paid] slice plan: ${manifest.sliceCount} slice(s) x ${plan.jobs} worker(s), budget ${minutes(plan.sliceBudgetMs)}m per slice, `
    + `longest estimate ${minutes(Math.max(0, ...plan.estimatedSliceMs))}m, CI job timeout ${plan.ciTimeoutMinutes}m`];
  for (let slice = 1; slice <= manifest.sliceCount; slice++) {
    const mine = sliceExecutionOrder(manifest.entries.filter(entry => entry.status === 'planned' && entry.slice === slice));
    const over = plan.estimatedSliceMs[slice - 1]! > plan.sliceBudgetMs ? '  [over budget: longer than one runner allows]' : '';
    lines.push(`  slice ${slice}: ~${minutes(plan.estimatedSliceMs[slice - 1]!)}m${over}`);
    for (const entry of mine) lines.push(`    ${entry.file} ~${minutes(entry.estimatedMs ?? 0)}m retries=${retriesForFiles([entry.file])}`);
  }
  return lines;
}

/**
 * Capacity preflight (E-A10): what the plan asks of the runner pool and the
 * API. Sessions are planned shard processes; at most jobs of them run per
 * slice at once. Waves > 1 mean slices queue behind the matrix cap and the
 * lane wall grows by whole slices.
 */
export function formatCapacityPreflight(manifest: PaidRunManifest, maxParallel?: number): string[] {
  const planned = manifest.entries.filter(entry => entry.status === 'planned');
  const trials = planned.filter(entry => entry.trial);
  const jobs = manifest.plan?.jobs ?? DEFAULT_JOBS;
  const longest = [...trials].sort((a, b) => (b.estimatedMs ?? 0) - (a.estimatedMs ?? 0))[0];
  const waves = maxParallel ? Math.ceil(manifest.sliceCount / maxParallel) : null;
  return [
    `[test:paid] capacity: ${manifest.sliceCount} slice(s), ${planned.length} planned shard(s) (${planned.length - trials.length} rule/judge, ${trials.length} trial shard(s) in ${new Set(trials.map(entry => trialPanelKey(entry.file))).size} panel(s)); `
      + `peak ${Math.min(manifest.sliceCount, maxParallel ?? manifest.sliceCount) * jobs} concurrent shard process(es)`
      + (waves !== null ? `; wave(s) at max-parallel ${maxParallel}: ${waves}` : ''),
    ...(longest ? [`[test:paid] capacity: longest indivisible trial ~${((longest.estimatedMs ?? 0) / 60_000).toFixed(1)}m (${longest.file})`] : []),
    ...(waves !== null && waves > 1 ? [`[test:paid] capacity: ⚠ ${manifest.sliceCount} slices exceed max-parallel ${maxParallel}; later slices queue for a second wave`] : []),
  ];
}

export function formatProfileCoverage(manifest: PaidRunManifest): string[] {
  const coverage = manifest.prCoverage;
  return [
    `[test:paid] coverage: profile=${manifest.profile ?? 'full'} mode=${coverage?.mode ?? 'full'}; selected E2E=${manifest.selection?.e2e?.length ?? 'all'}, judges=${manifest.selection?.judges?.length ?? 'all'}`,
    ...(coverage ? [`[test:paid] deferred: ${coverage.deferred.length} broad behaviors, ${coverage.deferredPromptFiles.length} changed prompts without quick live coverage; these are not PR passes`] : []),
  ];
}

/** Every collector record counts: paid evals never retry, so a later record never replaces an earlier one. */
export function collectorOutcomeCounts(results: Array<{ tests?: Array<{
  name: string; suite?: string; passed: boolean; execution?: string; manual_review?: unknown;
}> }>): { executed: number; reused: number; passed: number; failed: number; manual_accepted: number; attempts: number } {
  const counts = { executed: 0, reused: 0, passed: 0, failed: 0, manual_accepted: 0, attempts: 0 };
  for (const result of results) {
    for (const entry of result.tests ?? []) {
      if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string' || typeof entry.passed !== 'boolean') continue;
      counts.attempts++;
      counts[entry.execution === 'reused' ? 'reused' : 'executed']++;
      const outcome = evalEntryOutcome(entry);
      counts[outcome === 'manual-review' ? 'manual_accepted' : outcome]++;
    }
  }
  return counts;
}
