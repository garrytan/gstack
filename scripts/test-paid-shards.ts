#!/usr/bin/env bun
/**
 * test-paid-shards — enumerate, shard, and run the paid (gate/periodic) tier.
 *
 * The single-process `test:gate` fan-out has never completed a run: one wedged
 * or spinning file takes the whole tier down, and an in-process `--timeout`
 * cannot save it because a spinning main thread never fires a timer. This
 * runner applies the free tier's proven fix — one Bun process per shard — plus
 * the two things the paid tier additionally needs:
 *
 *   - an EXTERNAL wall-clock timeout that kills the shard's process GROUP, and
 *   - an aggregate that distinguishes failed from timed-out from never-started,
 *     so 26% execution can never again look like a pass.
 *
 * Why not Bun 1.3.13's native `--shard` / isolated runs? Three gaps, each one
 * fatal for this tier:
 *   1. No detached-process-group SIGKILL. Paid tests spawn `claude` / `codex`
 *      PTY grandchildren; when a shard hangs, in-process isolation kills the
 *      Bun worker but the grandchildren survive and burn cores for hours.
 *   2. No never-started taxonomy. A run that aborts partway reports only what
 *      executed — the shards that never ran are invisible, which is exactly
 *      the 26%-execution-looks-like-a-pass bug.
 *   3. No per-shard env / eval dir. Each shard needs its own GSTACK_EVAL_DIR
 *      so eval baselines are per-test-file instead of last-flush-wins.
 *
 * Worst-case wall clock = ceil(shards / jobs) × shard timeout. Shard counts
 * drift as test files land, so treat any number written here as stale.
 * Do NOT hand-derive the eval:bg:* detach timeouts from a snapshot of
 * these counts — test/eval-detach-timeout-floor.test.ts recomputes the bound
 * from the live shard census every run and fails CI if package.json's numbers
 * dip below it (undersized detach timeouts recreate never-started truncation).
 *
 * Env contract: EVALS_JOBS = how many shard PROCESSES run at once (this
 * runner). EVALS_CONCURRENCY = bun's --max-concurrency WITHIN a shard (and the
 * legacy single-process scripts). They were previously conflated: exporting
 * the legacy value 15 gave you 15 concurrent Bun processes each spawning
 * claude — the 429 storm.
 *
 * Enumeration matches package.json's `test:gate` globs (via the shared
 * test/helpers/paid-test-set.ts) and honors EVALS_TIER against the E2E_TIERS
 * map in test/helpers/touchfiles.ts. Spawn, kill, sandbox, logs, seeds and
 * output classification come from the shared shard engine
 * (scripts/lib/shard-engine.ts); this file keeps only paid-lane policy.
 *
 * Parallelism now lives ACROSS shards (--jobs), not inside one Bun process, so
 * each shard runs its own file sequentially and can be killed independently.
 *
 * Usage:
 *   bun run scripts/test-paid-shards.ts --list                # shard plan only
 *   bun run scripts/test-paid-shards.ts --tier gate           # run gate tier
 *   bun run scripts/test-paid-shards.ts --timeout 600 --jobs 2
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createBootstrapRetentionScope } from '../test/helpers/bootstrap-retention';
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
} from './lib/shard-engine';
import { PAID_TEST_GLOBS, isPaidTestFile } from '../test/helpers/paid-test-set';
import { CASE_CI_EXCLUDE, CASE_QUARANTINE, EVAL_POLICY, PERIODIC_CI_EXCLUDE } from '../test/helpers/periodic-exclude-data';
import { FILE_RETRY_BUDGETS, STRICT_RETRY_CASE_BUDGETS } from '../test/helpers/eval-budgets';
import {
  getProjectEvalDir, getClaudeCliVersion, isFinalizedEvalResultFile, evalEntryOutcome, failureClassOf, panelVerdict,
  sanitizeTrialError, formatTrialOutcomes, CONTRACT_VIOLATIONS_FILE, TRIAL_ENV, TRIAL_OUTCOME_SCHEMA, TRIAL_OUTCOMES_FILE,
  type EvalCaseKind, type PanelShape, type PanelVerdict, type TrialFailureClass, type TrialOutcome, type TrialOutcomeRecord,
} from '../test/helpers/eval-store';
import { E2E_KINDS } from '../test/helpers/touchfiles-data';
import { manualReviewProblem } from '../test/helpers/cookie-workflow-manual-review';
import { preflightAnthropicApi } from '../test/helpers/anthropic-preflight';
import { OVERLAY_MIN_FILE_WALL_MS } from '../test/helpers/overlay-case-policy';
import { PR_PROFILE_CASE_IDS, PR_PROFILE_FILES, packageChangeOnlyVersion, selectPrProfile, type PrProfileSelection } from './test-pr-profile';
import { e2eReuseLaneProblem, prepareE2EShardReuse, selectPlanReceipts, writeNegativeReceipt, writePanelReceipt } from './e2e-shard-reuse';

type E2EShardReuse = NonNullable<ReturnType<typeof prepareE2EShardReuse>>;
import {
  detectBaseBranch,
  getChangedFiles,
  selectTests,
  E2E_TOUCHFILES,
  E2E_TIERS,
  LLM_JUDGE_TOUCHFILES,
  GLOBAL_TOUCHFILES,
} from '../test/helpers/touchfiles';

export { PAID_TEST_GLOBS, isPaidTestFile };
export { PERIODIC_CI_EXCLUDE };

import { scopeCodexAccess, shardFile, shardCaseId, shardTrial, trialShardKey, type CaseTrialPlan, caseTrialPlan, excludedCasesNamePattern, caseTestNamePattern, expandCaseShards, expandTrialShards, partitionCaseExclusions } from './lib/paid-cases';
import { retriesForFiles, trialPanelKey, sliceExecutionOrder, buildRunManifest, parseRunManifest, type SliceResult, sliceExitCode, guardTrialRecords, formatSlicePlan, formatCapacityPreflight } from './lib/paid-plan';
import { caseFile, runCaseDiagnosis, formatPanelLine, runPaidReport } from './lib/paid-report';
export * from './lib/paid-cases';
export * from './lib/paid-plan';
export * from './lib/paid-report';

export const ROOT = path.resolve(import.meta.dir, '..');

export type PaidTier = 'gate' | 'periodic' | 'marathon';
export const PAID_TIERS: readonly PaidTier[] = ['gate', 'periodic', 'marathon'];
export type PaidProfile = 'pr' | 'full';

export interface PaidCaseSelection {
  e2e: string[] | null;
  judges: string[] | null;
}

export const DEFAULT_TIER: PaidTier = 'gate';
export const DEFAULT_SHARD_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_MAX_FILES_PER_SHARD = 1;
// 8 jobs × 2 within-shard ≈ 10-13 real in-flight sessions (39 of 75
// skill-e2e files hold exactly ONE test, so within-shard concurrency is
// dead weight for most shards) — under the documented-safe ~15 the legacy
// 40-way runner established. The old 4×4 yielded only ~4-6 in-flight and a
// 13-wave local gate worst case (~6.5h); 8×2 halves it. Watch the WS1
// flake telemetry for sustained 429 storms across 2 PR cycles — that is
// the rollback trigger. Prerequisite (landed): per-shard TMPDIR/
// CHROMIUM_PROFILE isolation in runPaidShard.
export const DEFAULT_JOBS = 8;
export const DEFAULT_WITHIN_SHARD_CONCURRENCY = 2;

/**
 * Paid-lane classification policy. Seeds keep only positive walls (a zero
 * is not a real paid-shard measurement). A shard that passed with zero
 * executed tests is legitimate under selection (in-file diff/tier
 * self-skips) and only warns; under EVALS_ALL it is hollow: 'passed-empty'.
 */
export const PAID_LANE_POLICY: LanePolicy = {
  acceptsSeedDuration: (ms) => ms > 0,
  zeroExecution: ({ promisedAll }) => (promisedAll ? 'passed-empty' : 'passed-with-warning'),
};

/** One overlay process preserves the original process-wide SDK semaphore. */
export const OVERLAY_MAX_ACTIVE_SHARDS = 1;

export function isOverlayTestFile(file: string): boolean {
  return /^skill-e2e-overlay-harness-.+\.test\.ts$/.test(path.basename(normalizeRelativePath(file)));
}

/** Compatibility helper for callers that only need the effective wall. */
export function resolvePaidShardTimeoutMs(files: string[], explicitTimeoutMs?: number): number {
  return resolvePaidShardBudget(files, explicitTimeoutMs).timeoutMs;
}

export function collectPaidTestFiles(rootDir = ROOT): string[] {
  const testDir = path.join(rootDir, 'test');
  if (!fs.existsSync(testDir)) return [];
  return fs.readdirSync(testDir)
    .map((name) => `test/${name}`)
    .filter(isPaidTestFile)
    .sort();
}

export interface TierClassification {
  included: boolean;
  reason: string;
}

/**
 * Decide whether a paid test file has anything to run in `tier`.
 *
 * Per-TEST tier filtering already happens at runtime: test/helpers/e2e-helpers.ts
 * intersects the selected tests with E2E_TIERS whenever EVALS_TIER is set, and
 * this runner passes EVALS_TIER down to every shard. So this file-level pass is
 * only an optimization — skipping a file merely saves one near-instant shard.
 *
 * Exclusion is the dangerous direction (a wrongly-skipped gate test is exactly
 * the invisible-non-execution bug this runner exists to kill), so the only
 * exclusion evidence accepted is an explicit whole-file tier guard: either the
 * raw `EVALS_TIER === '<other>'` predicate or the consolidated helper form
 * `describeE2ETier('<other>')` / `e2eTierEnabled('<other>')` from
 * test/helpers/e2e-gate.ts (same semantics, read from env at module load).
 * Inferring a file's tier from which E2E_TIERS names appear in its source
 * is guesswork that silently drops real work: short keys like 'retro' match
 * unrelated strings, and LLM-judge tests are keyed off LLM_JUDGE_TOUCHFILES and
 * carry no E2E_TIERS name at all. Everything without an explicit other-tier
 * guard runs and self-skips.
 */
export function classifyPaidTestFile(source: string, tier: PaidTier): TierClassification {
  const declares = (candidate: PaidTier) =>
    new RegExp(`EVALS_TIER\\s*===\\s*['"\`]${candidate}['"\`]`).test(source) ||
    new RegExp(`\\b(?:describeE2ETier|e2eTierEnabled)\\(\\s*['"\`]${candidate}['"\`]`).test(source);

  if (declares(tier)) return { included: true, reason: `declares tier '${tier}'` };
  const others = PAID_TIERS.filter(candidate => candidate !== tier && declares(candidate));
  if (others.length) return { included: false, reason: `declares tier ${others.map(other => `'${other}'`).join(' and ')} only` };
  return { included: true, reason: 'no whole-file tier guard — runtime E2E_TIERS filter decides' };
}

/**
 * The E2E ids a paid file registers: the touchfile registrations that list the
 * file. `known` is true only when those ids are complete: no computed
 * registration (testName, *IfSelected, describeIfSelected with a non-literal
 * argument) and every literal registration argument is among them
 * (`unregistered` lists the literal ids that are not). Quoted strings
 * elsewhere (comments, skill paths) never count.
 */
export function fileCaseRegistration(
  file: string, source: string,
  touchfiles: Record<string, string[]> = E2E_TOUCHFILES,
  tiers: Record<string, string> = E2E_TIERS,
): { registered: string[]; known: boolean; computed: boolean; unregistered: string[] } {
  const rel = normalizeRelativePath(file);
  const registered = Object.keys(touchfiles).filter(key => touchfiles[key]!.includes(rel));
  const computed = /testName\s*:\s*(?!string\b)(?:`[^`]*\$\{|[A-Za-z_$])/.test(source)
    || /\btest(?:Concurrent)?IfSelected\s*\(\s*(?:`[^`]*\$\{|[A-Za-z_$])/.test(source)
    || /\bdescribeIfSelected\s*\([^,]*,(?!\s*\[)/.test(source)
    || [...source.matchAll(/\bdescribeIfSelected\s*\([^,]*,\s*\[([^\]]*)\]/g)].some(m => m[1]!.split(',')
      .map(item => item.trim()).some(item => item && !/^(['"`])[^'"`$]*\1$/.test(item)));
  const literal = [
    ...[...source.matchAll(/testName\s*:\s*(['"`])([^'"`]+)\1/g)].map(m => m[2]!),
    ...[...source.matchAll(/\btest(?:Concurrent)?IfSelected\s*\(\s*(['"`])([^'"`]+)\1/g)].map(m => m[2]!),
    ...[...source.matchAll(/\bdescribeIfSelected\s*\([^,]*,\s*\[([^\]]*)\]/g)]
      .flatMap(m => [...m[1]!.matchAll(/(['"`])([^'"`]+)\1/g)].map(n => n[2]!)),
  ].filter(id => id in tiers);
  const unregistered = [...new Set(literal.filter(id => !registered.includes(id)))];
  return { registered, known: registered.length > 0 && !computed && unregistered.length === 0, computed, unregistered };
}

/**
 * A file is skipped for a tier lane only when it registers E2E ids, none of
 * them has that tier, and no literal registration names an id outside its
 * touchfile registration. A computed registration (a name built at runtime)
 * can only run in this lane by producing an id of this tier (the child's
 * EVALS_TIER filter drops every other), so it is skipped too when every id of
 * the tier is registered to a test file (its touchfile list names one), which
 * is not this file. An id of the tier that no test file registers, or no id
 * at all, keeps today's scheduling (the child's runtime filter decides).
 */
export function tierSkipReason(
  file: string, source: string, tier: PaidTier,
  touchfiles: Record<string, string[]> = E2E_TOUCHFILES,
  tiers: Record<string, string> = E2E_TIERS,
): string | null {
  const { registered, computed, unregistered } = fileCaseRegistration(file, source, touchfiles, tiers);
  if (registered.length === 0 || unregistered.length > 0 || registered.some(id => tiers[id] === tier)) return null;
  if (!computed) return `skipped: no E2E_TIERS id has tier ${tier}`;
  const unowned = Object.keys(tiers).some(id => tiers[id] === tier && !(touchfiles[id] ?? []).some(dep => /^test\/[^/]+\.test\.ts$/.test(dep)));
  return unowned ? null : `skipped: no E2E_TIERS id has tier ${tier} (its computed names can only produce ${tier} ids other test files register)`;
}

/**
 * The marathon lane selects positively: a file runs there only when it
 * declares the marathon tier or registers a marathon-tier case. Files without
 * marathon work never cost a marathon runner, and gate/periodic files never
 * gain a third execution.
 */
export function marathonSkipReason(
  file: string, source: string,
  touchfiles: Record<string, string[]> = E2E_TOUCHFILES,
  tiers: Record<string, string> = E2E_TIERS,
): string | null {
  if (classifyPaidTestFile(source, 'marathon').reason === "declares tier 'marathon'") return null;
  const { registered } = fileCaseRegistration(file, source, touchfiles, tiers);
  return registered.some(id => tiers[id] === 'marathon') ? null : 'skipped: declares no marathon tier and registers no marathon case';
}

export interface TierSelection {
  selected: string[];
  excluded: Array<{ file: string; reason: string }>;
}

export function selectPaidTestFiles(files: string[], tier: PaidTier, rootDir = ROOT, env: NodeJS.ProcessEnv = process.env): TierSelection {
  const selected: string[] = [];
  const excluded: Array<{ file: string; reason: string }> = [];
  const carveSkill = tier === 'periodic' ? env.GSTACK_CARVE_SKILL?.trim() : undefined;
  const carveWrapper = (file: string) => /^test\/carve-section-loading-(.+)\.test\.ts$/.exec(normalizeRelativePath(file))?.[1];
  if (carveSkill && files.some(file => carveWrapper(file)) && !files.some(file => carveWrapper(file) === carveSkill)) {
    throw new Error(`GSTACK_CARVE_SKILL=${carveSkill} has no generic section-loading wrapper`);
  }
  // Scheduled-lane exclusions (documented-red / manual-hardware files): a
  // known-red weekly shard is triage waste locally AND in CI, so the list
  // applies to every periodic and marathon run, with the reason surfaced per file.
  const ciExcluded = (file: string): { reason: string; tracking: string } | undefined =>
    tier !== 'gate' ? PERIODIC_CI_EXCLUDE[normalizeRelativePath(file)] : undefined;
  for (const file of files) {
    // One wrapper per process means a child-side return now creates an empty
    // shard. Apply the existing explicit cost scope before planning processes.
    const skill = carveWrapper(file);
    if (carveSkill && skill && skill !== carveSkill) {
      excluded.push({ file, reason: `GSTACK_CARVE_SKILL=${carveSkill} selects another section-loading case` });
      continue;
    }
    const exclusion = ciExcluded(file);
    if (exclusion) {
      excluded.push({ file, reason: `excluded: ${exclusion.reason} [${exclusion.tracking}]` });
      continue;
    }
    const source = fs.readFileSync(path.join(rootDir, file), 'utf8');
    const classification = classifyPaidTestFile(source, tier);
    const skip = !classification.included ? null
      : tier === 'marathon' ? marathonSkipReason(file, source) : tierSkipReason(file, source, tier);
    if (classification.included && !skip) selected.push(file);
    else excluded.push({ file, reason: skip ?? classification.reason });
  }
  return { selected, excluded };
}

// --- Parent-side diff selection (shard skipping) ---

/**
 * The test names the parent mapper recognizes: every E2E map key. LLM-judge
 * keys are deliberately excluded — skill-llm-eval.test.ts is not a
 * skill-e2e-* file, so it is always kept (child self-skip authoritative).
 */
export const PARENT_MAPPER_TEST_NAMES: string[] = [
  ...new Set([...Object.keys(E2E_TOUCHFILES), ...Object.keys(E2E_TIERS)]),
];

/**
 * Which of `names` appear in `source` as a quoted string ('x', "x", or `x`).
 * Same class of detection test/e2e-tier-alignment.test.ts uses: exact
 * quote-delimited match, raw source (comments count — a false hit can only
 * KEEP a shard, and the registration union below covers constructed names).
 */
export function knownTestNamesInSource(source: string, names: Iterable<string>): string[] {
  const hits: string[] = [];
  for (const name of names) {
    if (
      source.includes(`'${name}'`)
      || source.includes(`"${name}"`)
      || source.includes(`\`${name}\``)
    ) hits.push(name);
  }
  return hits;
}

export interface PaidDiffSelection {
  /** null = run everything (EVALS_ALL, or no changes vs base). */
  selectedNames: Set<string> | null;
  reason: string;
  totalTests: number;
}

/**
 * Compute diff selection in the PARENT, mirroring the module-scope selection
 * block in test/helpers/e2e-helpers.ts exactly: EVALS_ALL → run all;
 * base = EVALS_BASE || detectBaseBranch || 'main'; empty changed-file union →
 * run all. (e2e-helpers additionally gates on EVALS=1, which this runner sets
 * for every child unconditionally, so the parent mirror omits it.)
 *
 * getChangedFiles THROWS on git errors (fail-closed) — the children would hit
 * the same throw at module load, so the parent surfaces it before any shard
 * spawns.
 */
export function computePaidDiffSelection(
  env: NodeJS.ProcessEnv = process.env,
  rootDir = ROOT,
): PaidDiffSelection {
  const totalTests = Object.keys(E2E_TOUCHFILES).length;
  if (env.EVALS_ALL) {
    return { selectedNames: null, reason: 'run-all (EVALS_ALL=1)', totalTests };
  }
  const baseBranch = env.EVALS_BASE || detectBaseBranch(rootDir) || 'main';
  const changedFiles = getChangedFiles(baseBranch, rootDir);
  if (changedFiles.length === 0) {
    return { selectedNames: null, reason: `run-all (no changes vs ${baseBranch})`, totalTests };
  }
  const selection = selectTests(changedFiles, E2E_TOUCHFILES, GLOBAL_TOUCHFILES, {
    baseRef: baseBranch, cwd: rootDir,
  });
  return { selectedNames: new Set(selection.selected), reason: selection.reason, totalTests };
}

/**
 * Serialize the parent's diff selection for shard children (EVALS_SELECTION_JSON).
 *
 * Children's e2e-helpers module-load path adopts this instead of re-deriving
 * the selection per shard — which, when touchfiles-data.ts is in the diff,
 * spawned one bun subprocess PER CHILD to evaluate the old data file (the
 * map-diff path in test/helpers/test-selection.ts, 20s timeout each; 46-68
 * redundant children per full run). `selected: null` means run-all, mirroring
 * PaidDiffSelection.selectedNames. The child-side parser lives in
 * test/helpers/e2e-helpers.ts (parseEvalsSelectionJson); round-trip parity is
 * pinned by test/paid-selection-propagation.test.ts.
 */
export function serializePaidDiffSelection(selection: PaidDiffSelection): string {
  return JSON.stringify({
    version: 1,
    selected: selection.selectedNames === null ? null : [...selection.selectedNames].sort(),
    reason: selection.reason,
  });
}

/** Both selectors are computed once; execution consumes the exact persisted IDs. */
export function computePaidCaseSelection(options: {
  profile: PaidProfile;
  env?: NodeJS.ProcessEnv;
  rootDir?: string;
  changedFiles?: string[];
  /** Whether package.json differs from the base only in `version`; computed from git when omitted. */
  packageVersionOnly?: boolean;
}): { selection: PaidCaseSelection; reason: string; coverage?: PrProfileSelection } {
  const env = options.env ?? process.env;
  const rootDir = options.rootDir ?? ROOT;
  const baseRef = env.EVALS_BASE || detectBaseBranch(rootDir) || 'main';
  const files = options.changedFiles ?? (env.EVALS_ALL ? [] : getChangedFiles(baseRef, rootDir));
  const all = !!env.EVALS_ALL || files.length === 0;
  const effectiveFiles = files.filter(file => options.profile !== 'pr' || file !== 'package.json' ||
    !(options.packageVersionOnly ?? packageVersionOnlySinceBase(rootDir, baseRef)));
  const sourceAliases = options.profile === 'pr' ? existingPromptSourceAliases(effectiveFiles, rootDir) : {};
  const selectionFiles = [...new Set([...effectiveFiles, ...Object.values(sourceAliases)])];
  const select = (table: Record<string, string[]>) => all ? null
    : selectTests(selectionFiles, table, GLOBAL_TOUCHFILES, { baseRef, cwd: rootDir }).selected;
  const selection = { e2e: select(E2E_TOUCHFILES), judges: select(LLM_JUDGE_TOUCHFILES) };
  if (options.profile === 'full') return { selection, reason: all ? 'run-all' : 'diff' };
  const coverage = selectPrProfile({ selectedE2E: selection.e2e, selectedJudges: selection.judges, changedFiles: effectiveFiles, sourceAliases });
  if (coverage.needsFullValidation) {
    throw new Error(`PR profile requires full validation: ${coverage.missingCoverage.join(', ')}. Use --profile full and the relevant periodic cases.`);
  }
  return { selection: { e2e: coverage.e2e, judges: coverage.judges }, reason: coverage.reasons.join('; '), coverage };
}

export function existingPromptSourceAliases(files: readonly string[], rootDir = ROOT): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const template = `${file}.tmpl`;
    try { if (fs.statSync(path.join(rootDir, template)).isFile()) aliases[file] = template; }
    catch { /* Unknown/generated-only content must keep its own dependency identity. */ }
  }
  return aliases;
}

function packageVersionOnlySinceBase(rootDir: string, baseRef: string): boolean {
  try {
    const options = { cwd: rootDir, encoding: 'utf8' as const, timeout: 10_000, maxBuffer: 1024 * 1024 };
    const base = spawnSync('git', ['merge-base', baseRef, 'HEAD'], options);
    const sha = base.stdout?.trim() ?? '';
    if (base.status !== 0 || !/^[a-f0-9]{40,64}$/.test(sha)) return false;
    const old = spawnSync('git', ['show', `${sha}:package.json`], options);
    return old.status === 0 && packageChangeOnlyVersion(old.stdout, fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  } catch { return false; }
}

/** Only audited per-case files, plus the separately selected judge, enter the fast profile. */
/** The selected PR-profile case ids a shard key owns (a case key owns at most its own case). */
/** `exclude`: isolated case ids a file shard leaves to their trial shards. */
function prProfileShardIds(key: string, selection: PaidCaseSelection, exclude: readonly string[] = []): string[] {
  const caseId = shardCaseId(key);
  return (PR_PROFILE_FILES[shardFile(key)] ?? [])
    .filter(id => (caseId === null || id === caseId) && (selection.e2e === null || selection.e2e.includes(id)) && !exclude.includes(id));
}

export function prProfileFileSelected(file: string, selection: PaidCaseSelection, exclude: readonly string[] = []): boolean {
  if (file === 'test/skill-llm-eval.test.ts') return selection.judges === null || selection.judges.length > 0;
  return prProfileShardIds(file, selection, exclude).length > 0;
}

export function expectedPrCaseCount(file: string, selection: PaidCaseSelection, exclude: readonly string[] = []): number {
  if (file === 'test/skill-llm-eval.test.ts') return selection.judges?.length ?? Object.keys(LLM_JUDGE_TOUCHFILES).length;
  return prProfileShardIds(file, selection, exclude).length;
}

export function prProfileTestNamePattern(file: string, selection: PaidCaseSelection, exclude: readonly string[] = []): string {
  const ids = file === 'test/skill-llm-eval.test.ts'
    ? selection.judges ?? Object.keys(LLM_JUDGE_TOUCHFILES)
    : prProfileShardIds(file, selection, exclude);
  if (ids.length === 0) throw new Error(`No selected PR cases for ${file}`);
  return caseTestNamePattern(ids);
}

export function paidSelectionEnv(profile: PaidProfile, selection: PaidCaseSelection, reason: string): NodeJS.ProcessEnv {
  const encode = (selected: string[] | null) => JSON.stringify({ version: 1, selected, reason });
  return { EVALS_PROFILE: profile, EVALS_SELECTION_JSON: encode(selection.e2e), EVALS_JUDGE_SELECTION_JSON: encode(selection.judges) };
}

export interface ShardSkipDecision {
  file: string;
  kept: boolean;
  reason: string;
}

export interface DiffSkipOptions {
  rootDir?: string;
  /** Injectable for tests. Throwing reads fail OPEN (shard kept). */
  readSource?: (file: string) => string;
  /** Injectable name census (default: PARENT_MAPPER_TEST_NAMES). */
  allNames?: string[];
  /** Injectable registration map (default: E2E_TOUCHFILES). */
  e2eTouchfiles?: Record<string, string[]>;
  /** File shard -> isolated case ids its trial shards run instead. */
  excludeCases?: Record<string, string[]>;
}

/**
 * Decide whether a paid test file can be skipped under the current diff
 * selection. A file's MAPPED names are the union of:
 *   - E2E map keys quoted in its source, and
 *   - E2E map keys whose dep list registers the file (the tier-alignment
 *     mapping) — this covers files whose testNames are constructed rather
 *     than literal.
 *
 * FAIL-OPEN by construction: run-all selection, non-skill-e2e paid files
 * (llm-judge / codex-e2e / routing, keyed off other maps),
 * unreadable sources, and files with zero mapped names all KEEP their shard —
 * the child's self-skip stays authoritative. A parent bug may only run
 * extra work, never drop it.
 */
export function diffSkipDecisionForFile(
  file: string,
  selectedNames: Set<string> | null,
  options: DiffSkipOptions = {},
): ShardSkipDecision {
  if (selectedNames === null) return { file, kept: true, reason: 'run-all selection' };
  const caseId = shardCaseId(file);
  if (caseId !== null) {
    return selectedNames.has(caseId) ? { file, kept: true, reason: `selected: ${caseId}` } : { file, kept: false, reason: `case ${caseId} not selected` };
  }
  const rel = normalizeRelativePath(file);
  if (!/^test\/skill-e2e-.*\.test\.ts$/.test(rel)) {
    return { file, kept: true, reason: 'non-skill-e2e paid file — child self-skip authoritative' };
  }
  let source: string;
  try {
    const read = options.readSource
      ?? ((f: string) => fs.readFileSync(path.join(options.rootDir ?? ROOT, f), 'utf8'));
    source = read(file);
  } catch {
    return { file, kept: true, reason: 'source unreadable — fail-open' };
  }
  const allNames = options.allNames ?? PARENT_MAPPER_TEST_NAMES;
  const touchfiles = options.e2eTouchfiles ?? E2E_TOUCHFILES;
  const quoted = knownTestNamesInSource(source, allNames);
  const registered = Object.keys(touchfiles).filter((k) => touchfiles[k].includes(rel));
  const isolated = options.excludeCases?.[rel] ?? [];
  const mapped = [...new Set([...quoted, ...registered])].filter(name => !isolated.includes(name));
  if (mapped.length === 0) {
    return { file, kept: true, reason: 'no mappable test names — fail-open, child self-skip authoritative' };
  }
  const selectedHere = mapped.filter((n) => selectedNames.has(n));
  if (selectedHere.length > 0) {
    const shown = selectedHere.slice(0, 3).join(', ') + (selectedHere.length > 3 ? ', …' : '');
    return { file, kept: true, reason: `selected: ${shown}` };
  }
  return { file, kept: false, reason: `none of its ${mapped.length} mapped test(s) selected` };
}

/**
 * Partition planned shards into runnable vs skipped-by-diff. A shard is
 * skipped only when EVERY file in it is skippable.
 */
export function partitionShardsByDiffSelection(
  shards: string[][],
  selectedNames: Set<string> | null,
  options: DiffSkipOptions = {},
): { runnable: string[][]; skipped: Array<{ files: string[]; reason: string }> } {
  if (selectedNames === null) return { runnable: shards, skipped: [] };
  const runnable: string[][] = [];
  const skipped: Array<{ files: string[]; reason: string }> = [];
  for (const shard of shards) {
    const decisions = shard.map((file) => diffSkipDecisionForFile(file, selectedNames, options));
    if (decisions.every((d) => !d.kept)) {
      skipped.push({ files: shard, reason: [...new Set(decisions.map((d) => d.reason))].join('; ') });
    } else {
      runnable.push(shard);
    }
  }
  return { runnable, skipped };
}

export function planPaidShards(
  files: string[],
  options: { maxFilesPerShard?: number; ownShard?: ReadonlySet<string> } = {},
): string[][] {
  const size = Math.max(1, options.maxFilesPerShard ?? DEFAULT_MAX_FILES_PER_SHARD);
  const unique = [...new Set(files.map(normalizeRelativePath))].sort();
  const shards: string[][] = [];
  let pending: string[] = [];
  for (const file of unique) {
    if (isOverlayTestFile(file) || shardCaseId(file) !== null || FILE_RETRY_BUDGETS.some(budget => budget.file === shardFile(file))
      || options.ownShard?.has(file)) {
      if (pending.length) shards.push(pending);
      pending = [];
      shards.push([file]);
    } else {
      pending.push(file);
      if (pending.length === size) { shards.push(pending); pending = []; }
    }
  }
  if (pending.length) shards.push(pending);
  return shards;
}

export interface PaidShardBudget {
  timeoutMs: number;
  source: 'explicit' | 'registered' | 'default';
  policyId: string | null;
}

/** Explicit caller limits win; registered supervision preserves existing attempts. */
export function resolvePaidShardBudget(files: string[], overrideMs?: number): PaidShardBudget {
  const finding = FILE_RETRY_BUDGETS.find(budget => files.map(shardFile).includes(budget.file));
  if (finding && files.length !== 1) throw new Error('Registered retry budget requires its own shard');
  if (overrideMs !== undefined && (!Number.isSafeInteger(overrideMs) || overrideMs <= 0 || overrideMs > 2_147_483_647)) {
    throw new Error('Shard timeout must be a finite positive timer-safe integer');
  }
  const overlay = files.some(isOverlayTestFile);
  if (overlay && files.length !== 1) throw new Error('Overlay budget requires its own shard');
  if (overlay && overrideMs !== undefined && overrideMs < OVERLAY_MIN_FILE_WALL_MS) {
    throw new Error(`Overlay shard requires at least ${OVERLAY_MIN_FILE_WALL_MS}ms; explicit wall ${overrideMs}ms cannot preserve its work and finalization budget`);
  }
  // A registered file's case shard supervises its one case.
  const registeredMs = finding && shardCaseId(files[0]!) !== null
    ? finding.caseMs + finding.shardReserveMs : finding?.shardMs;
  return {
    timeoutMs: overrideMs ?? (registeredMs ?? (overlay ? OVERLAY_MIN_FILE_WALL_MS : DEFAULT_SHARD_TIMEOUT_MS)),
    source: overrideMs !== undefined ? 'explicit' : finding ? 'registered' : 'default',
    policyId: finding?.id ?? null,
  };
}

export function sameBudget(actual: PaidShardBudget | undefined, expected: PaidShardBudget): boolean {
  return actual?.timeoutMs === expected.timeoutMs && actual.source === expected.source && actual.policyId === expected.policyId;
}

export function buildPaidShardArgs(
  files: string[],
  timeoutMs: number,
  maxConcurrency: number = DEFAULT_WITHIN_SHARD_CONCURRENCY,
  retries?: number,
): string[] {
  // Explicit --concurrent/--max-concurrency: the legacy path always set one;
  // omitting it here made within-shard parallelism differ silently between
  // the two runners (observed: 1.6x sumdur/wall sharded vs 8x legacy).
  // Paid evals never retry (retriesForFiles); `--retry 0` is explicit so a
  // bunfig default can never reintroduce one.
  return ['test', ...files, '--retry', String(retries ?? 0), '--concurrent', `--max-concurrency=${maxConcurrency}`, `--timeout=${timeoutMs}`];
}

/**
 * Stable per-shard eval-dir slug: test filename sans extension, sanitized.
 * Stable across runs so each shard baselines against its own prior run.
 */
export function shardSlug(files: string[]): string {
  return files
    .map((file) => path.basename(shardFile(file)).replace(/\.test\.(?:[cm]?[jt]s|tsx|jsx)$/, '')
      + (shardCaseId(file) === null ? '' : `--${shardCaseId(file)}`)
      + (shardTrial(file) === null ? '' : `.t${shardTrial(file)}`))
    .join('+')
    .replace(/[^a-zA-Z0-9._+-]/g, '-');
}

export type ShardStatus =
  | 'passed'
  | 'failed'
  | 'timed-out'
  | 'never-started'
  | 'skipped-by-diff'
  // exit 0 with ZERO executed tests on a run that promised everything
  // (EVALS_ALL): the hollow-file green the census backstop exists to catch.
  // Under selective runs, 0-executed passed shards stay 'passed' (in-file
  // diff/tier self-skips are legitimate there) and get a WARNING line only.
  | 'passed-empty';

export interface ShardOutcome {
  shard: number;
  files: string[];
  status: ShardStatus;
  exitCode: number | null;
  elapsedMs: number;
  groupPid: number | null;
  /** Tests bun reported executing ("Ran N tests ..."), null when unknown. */
  executedTests: number | null;
  /** Tests bun reported skipping (" N skip" count line), null when unknown.
   *  "Ran N tests" COUNTS skips, so executedTests alone cannot distinguish a
   *  shard that verified work from one whose every test self-skipped —
   *  codex/gemini files green-by-skip on every CI runner (no binary) and the
   *  weekly census read them as covered. */
  skippedTests: number | null;
  /** Effective supervised wall; absent only for unstarted or legacy outcomes. */
  budget?: PaidShardBudget;
  /** Present when a verified receipt replaced execution (PR lane only). */
  reused?: { inputKey: string; runId: string; revision: string; completedAt: number };
  /** The parent could not run the shard at all (a runner error, never a trial verdict). */
  runnerError?: string;
  /** PR lane: the reuse input identity of a freshly executed shard whose inputs stayed unchanged. */
  inputKey?: string;
  /** Isolated trial shards only: the trial record this shard produced. */
  trial?: ShardTrialRecord;
}

/**
 * One isolated trial's record, derived from its shard status and the records
 * in its own eval dir. `outcome` null means the harness produced no trial
 * (never started, hollow, isolation broken, runner error): the panel is then
 * INCOMPLETE and the slice exits non-zero. A failed, timed-out or crashed
 * trial is a trial verdict; the slice still exits zero and the report decides.
 */
export interface ShardTrialRecord {
  case: string;
  trial: number;
  kind: EvalCaseKind;
  panel: PanelShape;
  quarantined: boolean;
  outcome: TrialOutcome | null;
  harness?: string;
  failure_class?: TrialFailureClass;
  exit_reason?: string;
  error?: string;
  timeout_at_turn?: number;
  cost_usd: number;
  duration_ms: number;
  model?: string;
}

/** Records and contract evidence an isolated shard left in its eval dir. */
export function readTrialEvidence(evalDir: string | undefined): { records: any[]; contract: string | null } {
  if (!evalDir || !fs.existsSync(evalDir)) return { records: [], contract: null };
  const names = fs.readdirSync(evalDir);
  const parse = (name: string) => { try { return JSON.parse(fs.readFileSync(path.join(evalDir, name), 'utf8')); } catch { return null; } };
  const finalized = names.filter(name => isFinalizedEvalResultFile(name) && !name.startsWith('e2e-reused-')).map(parse).filter(Boolean);
  const source = finalized.length ? finalized : names.filter(name => name.startsWith('_partial') && name.endsWith('.json')).map(parse).filter(Boolean);
  const records = source.flatMap((result: any) => Array.isArray(result?.tests) ? result.tests.filter((t: any) => t && typeof t === 'object') : []);
  let contract: string | null = records.find((t: any) => t.failure_class === 'contract')?.error ?? null;
  if (records.some((t: any) => t.failure_class === 'contract') && contract === null) contract = 'contract violation';
  try {
    const line = fs.readFileSync(path.join(evalDir, CONTRACT_VIOLATIONS_FILE), 'utf8').split('\n').find(l => l.trim());
    if (line) contract = String(JSON.parse(line).message ?? 'contract violation');
  } catch { /* no sidecar */ }
  return { records, contract };
}

/** Classify one isolated trial shard. Contract evidence always fails the trial. */
export function classifyTrialShard(
  outcome: Pick<ShardOutcome, 'status' | 'executedTests' | 'skippedTests' | 'elapsedMs' | 'runnerError'>,
  caseId: string, trial: number, plan: CaseTrialPlan,
  evidence: { records: any[]; contract: string | null },
): ShardTrialRecord {
  const failedRecord = evidence.records.find(record => record.passed === false) ?? evidence.records[0];
  const base: ShardTrialRecord = {
    case: caseId, trial, kind: plan.kind, panel: plan.panel, quarantined: plan.quarantined, outcome: null,
    cost_usd: Math.round(evidence.records.reduce((sum, record) => sum + (Number(record.cost_usd) || 0), 0) * 100) / 100,
    duration_ms: outcome.elapsedMs,
    ...(typeof failedRecord?.model === 'string' ? { model: failedRecord.model } : {}),
  };
  const failed = (failureClass: TrialFailureClass, error?: string): ShardTrialRecord => ({
    ...base, outcome: 'failed', failure_class: evidence.contract !== null ? 'contract' : failureClass,
    ...(failedRecord?.exit_reason ? { exit_reason: String(failedRecord.exit_reason) } : {}),
    ...(Number.isInteger(failedRecord?.timeout_at_turn) ? { timeout_at_turn: failedRecord.timeout_at_turn } : {}),
    ...(sanitizeTrialError(evidence.contract ?? failedRecord?.error ?? error) ? { error: sanitizeTrialError(evidence.contract ?? failedRecord?.error ?? error) } : {}),
  });
  if (outcome.runnerError !== undefined) return { ...base, harness: `runner error: ${sanitizeTrialError(outcome.runnerError) ?? 'unknown'}` };
  if (outcome.status === 'never-started') return { ...base, harness: 'never started' };
  if (outcome.status === 'passed-empty') return { ...base, harness: 'hollow: executed no case' };
  if (outcome.status === 'skipped-by-diff') return { ...base, harness: 'skipped by diff' };
  const known = outcome.executedTests !== null && outcome.skippedTests !== null;
  const ran = known ? outcome.executedTests! - outcome.skippedTests! : null;
  if (outcome.status === 'timed-out') {
    if (ran !== null && ran > 1) return { ...base, harness: `isolation broken: ${ran} cases ran` };
    return failed('timeout', 'shard wall reached');
  }
  if (ran === null) return outcome.status === 'failed' ? failed('infra', 'crashed without a test summary') : { ...base, harness: 'no test summary' };
  if (ran > 1) return { ...base, harness: `isolation broken: ${ran} cases ran` };
  if (ran === 0) {
    if (outcome.status === 'passed' && outcome.skippedTests! > 0 && evidence.contract === null) return { ...base, outcome: 'skipped' };
    if (outcome.status === 'failed') return failed('infra', 'the case never ran (load or setup failure)');
    return { ...base, harness: 'hollow: executed no case' };
  }
  if (outcome.status === 'passed') return evidence.contract !== null ? failed('contract') : { ...base, outcome: 'passed' };
  return failed(failedRecord ? failureClassOf(failedRecord) : 'assertion');
}

/**
 * True when a shard "passed" without verifying anything: every test bun ran
 * was a skip. Legitimate for external-service files on hosts without the
 * binary, but it must surface as a census warning, never read as coverage.
 */
export function isAllSkippedPass(outcome: Pick<ShardOutcome, 'status' | 'executedTests' | 'skippedTests'>): boolean {
  return outcome.status === 'passed'
    && outcome.executedTests !== null
    && outcome.executedTests > 0
    && outcome.skippedTests === outcome.executedTests;
}

export interface ShardCommand {
  command: string;
  args: string[];
}

/** Upper bound for one ordered FIFO group with the same admission limit.
 * At each launch the least-loaded worker has at most total prior work / jobs,
 * and at most floor(prior files / jobs) files of the largest prior wall.
 * Both bounds hold when earlier files finish below their ceilings. Overlay
 * groups must use their separate admission limit, as the runner does.
 */
export function paidShardWallUpperBoundMs(files: string[], jobs: number, overrideMs?: number): number {
  if (!Number.isSafeInteger(jobs) || jobs < 1) throw new Error('Worker count must be a positive integer');
  let priorWork = 0, priorLargest = 0, bound = 0;
  files.forEach((file, index) => {
    const wall = resolvePaidShardTimeoutMs([file], overrideMs);
    const start = Math.min(priorWork / jobs, Math.floor(index / jobs) * priorLargest);
    bound = Math.max(bound, start + wall);
    priorWork += wall;
    priorLargest = Math.max(priorLargest, wall);
  });
  return Math.ceil(bound);
}

export interface RunShardsOptions {
  timeoutMs?: number;
  registeredBudgets?: Record<string, PaidShardBudget>;
  jobs?: number;
  /** bun --max-concurrency inside each shard (EVALS_CONCURRENCY). */
  withinShardConcurrency?: number;
  rootDir?: string;
  env?: NodeJS.ProcessEnv;
  /** When set, each shard child gets GSTACK_EVAL_DIR=<evalDirBase>/shards/<slug>/. */
  evalDirBase?: string;
  /** Directory for the per-shard full-stream log files (default os.tmpdir()). Tests inject. */
  logDir?: string;
  /** Override the spawned command. Tests inject fake slow/spinning commands. */
  commandFor?: (files: string[]) => ShardCommand;
  log?: (line: string) => void;
  /** Fast-profile census: selected real cases per file, excluding Bun skips. */
  expectedCases?: Record<string, number>;
  casePatterns?: Record<string, string>;
  /** The selected case ids per shard key (reported for reused shards). */
  expectedCaseIds?: Record<string, string[]>;
  /** PR lane only: verified reuse for one shard's exact child environment and wall. */
  reuseFor?: (files: string[], env: NodeJS.ProcessEnv, budget: PaidShardBudget) => E2EShardReuse | null;
  /** Isolated trial shards: key -> the case's fixed trial plan. */
  trials?: Record<string, CaseTrialPlan>;
}

/** On-failure console excerpt budget: the last N bytes of the shard's log. */
export const FAILURE_TAIL_BYTES = 64 * 1024;

/** Read back only the tail of a shard log (never the whole 30-min stream). */
function readLogTail(logPath: string, maxBytes = FAILURE_TAIL_BYTES): string {
  try {
    const size = fs.statSync(logPath).size;
    const start = Math.max(0, size - maxBytes);
    const fd = fs.openSync(logPath, 'r');
    try {
      const buffer = Buffer.alloc(size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return ''; // a lost tail must never turn a real verdict into an exception
  }
}

function paidShardCommand(files: string[], rootDir: string, timeoutMs: number, options: RunShardsOptions,
  casePattern: string | undefined, evalDir: string | undefined): ShardCommand {
  return {
    command: process.execPath,
    args: [...buildPaidShardArgs(
      exactTestFileSelectors(files.map(shardFile), rootDir),
      timeoutMs,
      options.withinShardConcurrency ?? DEFAULT_WITHIN_SHARD_CONCURRENCY,
      retriesForFiles(files),
    ), ...(casePattern !== undefined ? ['--test-name-pattern', casePattern] : []),
    // Per-test outcomes for pass-rate history, keyed by Bun test name.
    ...(evalDir ? ['--reporter=junit', '--reporter-outfile', path.join(evalDir, 'junit.xml')] : [])],
  };
}

/** Print the last FAILURE_TAIL_BYTES of a failed shard's log to stdout. */
function printLogTail(label: string, logPath: string): void {
  const tail = readLogTail(logPath);
  if (tail.length === 0) return;
  process.stdout.write(`${label} last ${Math.min(tail.length, FAILURE_TAIL_BYTES)} bytes of ${logPath}:\n`);
  process.stdout.write(tail.endsWith('\n') ? tail : `${tail}\n`);
}

/** Acknowledge bootstrap dependency retention; an unconfirmed scope keeps the shard state. */
async function settleBootstrapRetention(
  scope: NonNullable<ReturnType<typeof createBootstrapRetentionScope>>,
  deadlineMs: number,
  label: string,
  log: (line: string) => void,
): Promise<{ failed: boolean; removable: boolean }> {
  try {
    const retained = await scope.cleanup(deadlineMs);
    if (!retained.complete) log(`${label} bootstrap retention incomplete; qualification failed`);
    return { failed: !retained.complete, removable: retained.removable };
  } catch {
    log(`${label} bootstrap retention acknowledgment failed; preserving shard state`);
    return { failed: true, removable: false };
  }
}

/**
 * End the shard's log spool within the shard's own deadline. An error, a
 * premature close or the deadline marks the spool failed (and logs once);
 * returns true when the deadline expired first.
 */
function settleShardSpool(spool: ShardLog, deadlineMs: number, onIncomplete: () => void): Promise<boolean> {
  const logStream = spool.stream;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (complete: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      logStream.off('error', onError);
      logStream.off('close', onClose);
      if (!complete) {
        spool.failed = true;
        logStream.destroy();
        onIncomplete();
      }
      resolve(expired);
    };
    const onError = () => finish(false);
    const onClose = () => finish(logStream.writableFinished && !spool.failed);
    const expire = () => { expired = true; finish(false); };
    logStream.once('error', onError);
    logStream.once('close', onClose);
    if (Date.now() >= deadlineMs) { expire(); return; }
    if (spool.failed || logStream.destroyed) { finish(false); return; }
    timer = setTimeout(expire, deadlineMs - Date.now());
    try { logStream.end(() => finish(logStream.writableFinished && !spool.failed)); }
    catch { finish(false); }
  });
}

export async function runPaidShard(
  files: string[],
  shardNumber: number,
  totalShards: number,
  options: RunShardsOptions = {},
): Promise<ShardOutcome> {
  if (files.length === 0) throw new Error('Cannot run an empty paid-test shard.');
  const rootDir = options.rootDir ?? ROOT;
  const planned = options.registeredBudgets?.[normalizeRelativePath(files[0]!)];
  const budget = resolvePaidShardBudget(files, options.timeoutMs ??
    (planned?.source === 'explicit' ? planned.timeoutMs : undefined));
  const timeoutMs = budget.timeoutMs;
  const streamLive = (options.jobs ?? DEFAULT_JOBS) === 1;
  const log = options.log ?? ((line: string) => console.log(line));
  const label = `[test:paid] shard ${shardNumber}/${totalShards}`;

  // A case shard runs exactly its one case; PR patterns narrow further.
  const caseId = files.length === 1 ? shardCaseId(files[0]!) : null;
  const casePattern = options.casePatterns?.[files[0]!] ?? (caseId !== null ? caseTestNamePattern([caseId]) : undefined);
  const expectedCases = options.expectedCases ?? (caseId !== null ? { [files[0]!]: 1 } : undefined);

  const baseEnv = { ...(options.env ?? process.env) };
  scopeCodexAccess(baseEnv, files.map(shardFile));
  if (options.evalDirBase) {
    baseEnv.GSTACK_EVAL_DIR = path.join(options.evalDirBase, 'shards', shardSlug(files));
  }
  const trialPlan = files.length === 1 ? options.trials?.[normalizeRelativePath(files[0]!)] : undefined;
  const trialIndex = files.length === 1 ? shardTrial(files[0]!) : null;
  if (trialPlan && trialIndex !== null && caseId !== null) {
    // One case, one trial: the selection binds the child to exactly this id,
    // and eval-store stamps every record with the trial identity.
    Object.assign(baseEnv, {
      [TRIAL_ENV.caseId]: caseId, [TRIAL_ENV.kind]: trialPlan.kind, [TRIAL_ENV.trial]: String(trialIndex),
      [TRIAL_ENV.panelN]: String(trialPlan.panel.n), [TRIAL_ENV.panelK]: String(trialPlan.panel.k),
      [TRIAL_ENV.policyVersion]: String(EVAL_POLICY.version),
      EVALS_SELECTION_JSON: JSON.stringify({ version: 1, selected: [caseId], reason: `trial ${trialIndex}/${trialPlan.panel.n} of ${caseId}` }),
    });
  } else {
    for (const name of Object.values(TRIAL_ENV)) delete baseEnv[name];
  }
  const withTrial = (outcome: ShardOutcome): ShardOutcome => trialPlan && trialIndex !== null && caseId !== null
    ? { ...outcome, trial: classifyTrialShard(outcome, caseId, trialIndex, trialPlan, readTrialEvidence(baseEnv.GSTACK_EVAL_DIR)) }
    : outcome;
  // Resolve `claude --version` ONCE in the parent (cached across shards) and
  // hand it to every child: eval-store's fallback is a synchronous spawn on
  // the same thread that polls PTY sessions, so children must never pay it.
  if (!baseEnv.GSTACK_CLAUDE_CLI_VERSION) {
    baseEnv.GSTACK_CLAUDE_CLI_VERSION = getClaudeCliVersion();
  }
  // Verified first-attempt reuse (PR lane only; scripts/e2e-shard-reuse.ts):
  // identical consumed inputs to a fresh pass in this PR replace execution
  // with an explicitly reported reused result.
  // Bootstrap-retention qualification binds per-run state, so that shard stays fresh.
  const reuse = files.some(file => normalizeRelativePath(file) === 'test/skill-e2e-qa-workflow.test.ts')
    ? null : options.reuseFor?.(files, baseEnv, budget) ?? null;
  // A trial reuses only its record from a whole PASS panel receipt the
  // planner shipped; a single trial never has a pass receipt of its own.
  const panelHit = trialPlan && trialIndex !== null ? reuse?.lookupPanelTrial(trialIndex) ?? null : null;
  if (panelHit && trialPlan && trialIndex !== null && caseId !== null) {
    const reusedFrom = { inputKey: panelHit.hit.key, runId: panelHit.hit.source.runId, revision: panelHit.hit.source.revision, completedAt: panelHit.hit.source.completedAt };
    const passedTrial = panelHit.trial.outcome === 'passed';
    log(`${label} REUSED trial ${trialIndex}/${trialPlan.panel.n} of ${caseId} (${panelHit.trial.outcome}) from the whole PASS panel of run ${reusedFrom.runId}`);
    return { shard: shardNumber, files, status: passedTrial ? 'passed' : 'failed', exitCode: passedTrial ? 0 : 1, elapsedMs: 0, groupPid: null,
      executedTests: 1, skippedTests: 0, budget, reused: reusedFrom,
      trial: { case: caseId, trial: trialIndex, kind: trialPlan.kind, panel: trialPlan.panel, quarantined: trialPlan.quarantined,
        outcome: panelHit.trial.outcome, cost_usd: 0, duration_ms: 0,
        ...(panelHit.trial.failure_class ? { failure_class: panelHit.trial.failure_class } : {}),
        ...(panelHit.trial.exit_reason ? { exit_reason: panelHit.trial.exit_reason } : {}),
        ...(panelHit.trial.error ? { error: panelHit.trial.error } : {}) } };
  }
  const reused = trialPlan ? null : reuse?.lookup() ?? null;
  if (reused) {
    const reusedFrom = { input_key: reused.key, run_id: reused.source.runId, revision: reused.source.revision,
      completed_at: new Date(reused.source.completedAt).toISOString() };
    const caseIds = options.expectedCaseIds?.[files[0]!] ?? [];
    if (baseEnv.GSTACK_EVAL_DIR) {
      fs.mkdirSync(baseEnv.GSTACK_EVAL_DIR, { recursive: true });
      fs.writeFileSync(path.join(baseEnv.GSTACK_EVAL_DIR, `e2e-reused-${shardSlug(files)}.json`), `${JSON.stringify({
        schema_version: 1, tier: 'e2e', shard: shardSlug(files), total_tests: caseIds.length, executed_tests: 0,
        reused_tests: caseIds.length, passed: caseIds.length, failed: 0, total_cost_usd: 0, total_duration_ms: 0,
        tests: caseIds.map(name => ({ name, suite: shardSlug(files), tier: 'e2e', passed: true, duration_ms: 0, cost_usd: 0,
          execution: 'reused', reused_from: reusedFrom, attempt: 1 })),
      }, null, 2)}\n`);
    }
    log(`${label} REUSED ${files.join(' ')} — identical inputs passed in run ${reused.source.runId} at ${reusedFrom.completed_at}`);
    return withTrial({ shard: shardNumber, files, status: 'passed', exitCode: 0, elapsedMs: 0, groupPid: null,
      executedTests: caseIds.length, skippedTests: 0, budget,
      reused: { inputKey: reused.key, runId: reused.source.runId, revision: reused.source.revision, completedAt: reused.source.completedAt } });
  }
  const { command, args } = options.commandFor ? options.commandFor(files)
    : paidShardCommand(files, rootDir, timeoutMs, options, casePattern, baseEnv.GSTACK_EVAL_DIR);
  if (baseEnv.GSTACK_EVAL_DIR) fs.mkdirSync(baseEnv.GSTACK_EVAL_DIR, { recursive: true });
  // Per-shard temp + Chromium-profile isolation — the free runner treats
  // this as mandatory (test-free-shards.ts: two concurrent shards on one
  // profile dir kill each other's browser; shared tmp cross-contaminates),
  // and the paid lane had NONE of it. Doubly load-bearing here: when a
  // shard hits its 30-min wall the group-SIGKILL means per-test afterAll
  // cleanup never runs — the rmSync backstop below is the only thing
  // stopping wedged runs from accumulating full git-repo workspaces in the
  // shared tmpdir forever. Prerequisite for raising EVALS_JOBS (more
  // concurrency on shared state amplifies exactly the opus-47 race class).
  const sandbox = createShardSandbox('gstack-paid-shard-', baseEnv);
  const { stateDir, tmp: childTmp, env } = sandbox;
  const bootstrapFile = files.some(file => normalizeRelativePath(file) === 'test/skill-e2e-qa-workflow.test.ts');
  delete env.GSTACK_BOOTSTRAP_RETENTION;
  if (bootstrapFile && process.platform !== 'linux') log(`${label} bootstrap dependency retention unavailable on ${process.platform}; native behavior still runs without retained-dependency qualification`);
  const bootstrapRetention = bootstrapFile && process.platform === 'linux'
    ? createBootstrapRetentionScope(childTmp, path.join(env.GSTACK_EVAL_DIR || getProjectEvalDir(), 'bootstrap-retention'), env.EVALS_RUN_ID ||= `bootstrap-${Date.now()}-${process.pid}`)
    : undefined;
  if (bootstrapRetention) Object.assign(env, bootstrapRetention.env);
  let retentionFailed = false;

  const startedAt = Date.now();
  log(`${label} START ${files.join(' ')} (timeout ${Math.round(timeoutMs / 1000)}s, ${budget.source}${budget.policyId ? `: ${budget.policyId}` : ''})`);

  // Full-stream spool: EVERY child byte lands on disk (the free runner's
  // model), never in a whole-run Buffer[] — non-live shards used to hold
  // their entire 30-min stream-json stdout+stderr in RAM, × concurrent jobs.
  // Printed at START so a wedged shard is inspectable live, mid-run.
  const logPath = nextShardLogPath(options.logDir ?? os.tmpdir(), `gstack-paid-shard-${shardSlug(files)}`);
  const spool = openShardLog(logPath, label);
  log(`${label} full log: ${logPath}`);

  const classifier = new BunTestOutputClassifier();
  // Tee: the spool always gets the chunk; live mode (jobs=1) also forwards to
  // the console. forwardAndClassify feeds the classifier FIRST, so the strict
  // verdict path is unchanged by where the bytes land afterwards.
  const sink = (destination: NodeJS.WriteStream): NodeJS.WriteStream => ({
    write: (chunk: Buffer | string): boolean => {
      spool.write(chunk);
      if (streamLive) destination.write(chunk);
      return true;
    },
  } as unknown as NodeJS.WriteStream);

  let exitCode: number | null = null;
  let timedOut = false;
  let groupPid: number | null = null;
  let incompleteCapture: ShardChildResult['incompleteCapture'];
  const shardDeadline = Date.now() + timeoutMs;
  try {
    // Shared spawn/detached/group-kill/wall-timer/reap lifecycle.
    const result = await runShardChild({
      command,
      args,
      cwd: rootDir,
      env,
      timeoutMs,
      deadlineMs: shardDeadline,
      hookStreams: (child) => {
        const streams: Array<Promise<void>> = [];
        if (child.stdout) streams.push(forwardAndClassify(child.stdout, sink(process.stdout), classifier, 'stdout'));
        if (child.stderr) streams.push(forwardAndClassify(child.stderr, sink(process.stderr), classifier, 'stderr'));
        return streams;
      },
    });
    exitCode = result.exitCode;
    timedOut = result.timedOut;
    groupPid = result.groupPid;
    incompleteCapture = result.incompleteCapture;
  } catch (error) {
    const result = (error as { shardResult?: ShardChildResult } | null)?.shardResult;
    if (result) {
      exitCode = result.exitCode;
      timedOut = result.timedOut;
      groupPid = result.groupPid;
      incompleteCapture = result.incompleteCapture;
    }
    throw error;
  } finally {
    if (incompleteCapture) log(`${label} incomplete child capture: ${JSON.stringify(incompleteCapture)}; retained log prefix: ${logPath}`);
    if (await settleShardSpool(spool, shardDeadline, () => log(`${label} incomplete log capture; retained prefix: ${logPath}`))) timedOut = true;
    let retentionRemovable = true;
    if (bootstrapRetention) {
      ({ failed: retentionFailed, removable: retentionRemovable } = await settleBootstrapRetention(bootstrapRetention, shardDeadline, label, log));
    }
    // Async, best-effort backstop: group-SIGKILLed tests never clean up.
    if (retentionRemovable) await removeShardSandbox(stateDir);
  }

  const summary = classifier.end();

  // expectedFiles: a shard whose bun child ran fewer files than planned with
  // exit 0 is NOT 'passed' (bun counts self-skipped files, so M = planned).
  // Fake commandFor children must print a synthetic `Ran N tests across M files`.
  const expectedFiles = files.length;
  let status: ShardStatus = strictShardStatus({
    timedOut, exitCode, summary, expectedFiles,
    evidenceComplete: !retentionFailed && !spool.failed && !incompleteCapture,
  });
  if (status === 'passed' && expectedCases) {
    const expected = files.reduce((count, file) => count + (expectedCases[file] ?? 0), 0);
    const actual = summary.terminalTestCounts.reduce((count, value) => count + value, 0) - summary.skippedTests;
    if (expected < 1 || actual !== expected) {
      status = 'failed';
      log(`${label} expected ${expected} selected cases, executed ${actual}; refusing incomplete case coverage`);
    }
  }
  const elapsedMs = Date.now() - startedAt;
  if (reuse && !trialPlan && !isTerminationRequested()) { if (status === 'passed') reuse.publish(); else reuse.publishFailure(); }
  const inputKey = reuse?.unchanged() ? reuse.inputKey : undefined;

  // Failure debuggability without the RAM cost: read back only the log's
  // tail. Live mode already streamed everything, so no re-print there.
  if (status !== 'passed' && !streamLive) printLogTail(label, logPath);
  const logSuffix = status === 'passed' ? '' : ` — full log: ${logPath}`;
  log(`${label} ${status.toUpperCase()} in ${Math.round(elapsedMs / 1000)}s (exit ${exitCode ?? 'signal'})${logSuffix}`);

  const executedTests = summary.terminalTestCounts.length > 0
    ? summary.terminalTestCounts.reduce((a, b) => a + b, 0)
    : null;
  const skippedTests = summary.terminalTestCounts.length > 0 ? summary.skippedTests : null;
  return withTrial({ shard: shardNumber, files, status, exitCode, elapsedMs, groupPid, executedTests, skippedTests, budget,
    ...(inputKey ? { inputKey } : {}) });
}

export interface RunSummary {
  total: number;
  executed: number;
  passed: number;
  failed: number;
  timedOut: number;
  neverStarted: number;
  /** Shards the parent skipped via diff selection — successes, never conflated with never-started. */
  skippedByDiff: number;
  outcomes: ShardOutcome[];
}

export function summarize(outcomes: ShardOutcome[]): RunSummary {
  const count = (status: ShardStatus) => outcomes.filter((o) => o.status === status).length;
  return {
    total: outcomes.length,
    executed: outcomes.length - count('never-started') - count('skipped-by-diff'),
    passed: count('passed'),
    failed: count('failed') + count('passed-empty'),
    timedOut: count('timed-out'),
    neverStarted: count('never-started'),
    skippedByDiff: count('skipped-by-diff'),
    outcomes,
  };
}

/**
 * Hollow-shard guard. Under EVALS_ALL (the run promised EVERY test), a
 * passed shard whose bun summary reported 0 executed tests is not a pass —
 * it is the zero-execution class one layer down (file selected, every test
 * inside self-skipped, exit 0). Selective runs keep those shards 'passed'
 * (in-file diff/tier self-skips are legitimate) and only warn.
 */
export function applyHollowShardGuard(
  outcomes: ShardOutcome[],
  opts: { evalsAll: boolean; requireExecuted?: boolean; warn?: (line: string) => void },
): ShardOutcome[] {
  const warn = opts.warn ?? ((line: string) => console.error(line));
  return outcomes.map((outcome) => {
    if (opts.requireExecuted && outcome.status === 'passed' &&
        (outcome.executedTests === null || outcome.executedTests === 0 || isAllSkippedPass(outcome))) {
      return { ...outcome, status: 'passed-empty' };
    }
    if (outcome.status !== 'passed') return outcome;
    const verdict = zeroExecutionVerdict(outcome.executedTests, PAID_LANE_POLICY, { promisedAll: opts.evalsAll });
    if (verdict === 'passed-with-warning') {
      warn(`[test:paid] WARNING: shard ${outcome.shard} passed with 0 executed tests (${outcome.files.join(' ')}) — legitimate under selection, hollow under EVALS_ALL`);
      return outcome;
    }
    return verdict === 'passed-empty' ? { ...outcome, status: 'passed-empty' } : outcome;
  });
}

/**
 * Exit code for a finished run: skipped-by-diff shards are successes (the
 * parent proved none of their tests were selected); everything else must
 * have passed.
 */
export function summaryExitCode(summary: RunSummary): number {
  return summary.passed + summary.skippedByDiff === summary.total ? 0 : 1;
}

/** Run every shard in its own process. A timeout or failure never aborts the run. */
export async function runPaidShards(
  shards: string[][],
  options: RunShardsOptions = {},
): Promise<RunSummary> {
  const jobs = Math.max(1, options.jobs ?? DEFAULT_JOBS);
  const outcomes: ShardOutcome[] = shards.map((files, index) => ({
    shard: index + 1,
    files,
    status: 'never-started',
    exitCode: null,
    elapsedMs: 0,
    groupPid: null,
    executedTests: null,
    skippedTests: null,
  }));

  // Validate the whole batch before any child can spend or create artifacts.
  for (const files of shards) resolvePaidShardTimeoutMs(files, options.timeoutMs);
  const pending = shards.map((_, index) => index);
  let activeOverlayShards = 0;
  const waiters = new Set<() => void>();
  const wakeWorkers = () => {
    for (const resolve of waiters) resolve();
    waiters.clear();
  };
  const worker = async (): Promise<void> => {
    while (true) {
      // Cancellation (SIGINT/SIGTERM) must stop the RUN: the signal
      // forwarders kill in-flight children, and this guard stops the pool
      // from launching replacement shards that would keep burning API spend.
      if (isTerminationRequested()) return;
      if (pending.length === 0) return;
      const position = pending.findIndex(index => !shards[index].some(isOverlayTestFile)
        || activeOverlayShards < OVERLAY_MAX_ACTIVE_SHARDS);
      if (position < 0) {
        await new Promise<void>(resolve => waiters.add(resolve));
        continue;
      }
      const [index] = pending.splice(position, 1);
      const overlay = shards[index].some(isOverlayTestFile);
      if (overlay) activeOverlayShards++;
      try {
        outcomes[index] = await runPaidShard(shards[index], index + 1, shards.length, { ...options, jobs });
      } catch (error) {
        const runnerError = error instanceof Error ? error.message : String(error);
        const failed: ShardOutcome = {
          shard: index + 1,
          files: shards[index],
          status: 'failed',
          exitCode: null,
          elapsedMs: 0,
          groupPid: null,
          executedTests: null,
          skippedTests: null,
          runnerError,
        };
        const key = shards[index].length === 1 ? normalizeRelativePath(shards[index][0]!) : '';
        const plan = options.trials?.[key];
        outcomes[index] = plan && shardCaseId(key) !== null && shardTrial(key) !== null
          ? { ...failed, trial: classifyTrialShard(failed, shardCaseId(key)!, shardTrial(key)!, plan, { records: [], contract: null }) }
          : failed;
        console.error(`[test:paid] shard ${index + 1} could not run: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        if (overlay) activeOverlayShards--;
        wakeWorkers();
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(jobs, shards.length) }, worker));
  return summarize(outcomes);
}

export function formatSummary(summary: RunSummary): string[] {
  const lines = [
    '',
    `[test:paid] ${summary.executed}/${summary.total} shards executed — `
    + `${summary.passed} passed, ${summary.failed} failed, `
    + `${summary.timedOut} timed out, ${summary.neverStarted} never started, `
    + `${summary.skippedByDiff} skipped by diff`,
  ];
  for (const outcome of summary.outcomes) {
    // A pass whose every test skipped is labeled distinctly: it exited 0 but
    // verified NOTHING (codex/gemini files on hosts without the binary).
    // Status stays 'passed' — availability of an external service is not a
    // repo regression — but the census must never read it as coverage.
    const allSkipped = isAllSkippedPass(outcome) ? ` ⚠ all ${outcome.executedTests} tests SKIPPED — verified nothing` : '';
    lines.push(
      `  ${outcome.status.padEnd(15)} ${String(Math.round(outcome.elapsedMs / 1000)).padStart(5)}s  `
      + outcome.files.join(' ') + allSkipped,
    );
  }
  return lines;
}

type CliOptions = {
  tier: PaidTier;
  profile: PaidProfile;
  profileExplicit: boolean;
  listOnly: boolean;
  skipJudges: boolean;
  timeoutMs: number;
  timeoutExplicit: boolean;
  jobs: number;
  withinShardConcurrency: number;
  maxFilesPerShard: number;
  /** Planner mode: write the run manifest here and exit. */
  emitPlanPath: string | null;
  /** Slice count for --emit-plan. */
  slices: number;
  /** Budget mode for --emit-plan / --list: per-executor estimated wall. */
  sliceBudgetMs: number | null;
  jobsExplicit: boolean;
  /** Executor mode: consume this manifest... */
  planPath: string | null;
  /** ...running only this 1-based slice. */
  sliceIndex: number | null;
  /** Report mode: reconcile manifest.json + slice-*.json under this dir. */
  reportDir: string | null;
  /** Report mode: merge executed shard wall times into the duration seed. */
  writeDurations: boolean;
  /** Planner: the workflow matrix cap, for the capacity preflight's wave count. */
  maxParallel: number | null;
  /** Local diagnosis: run one case through the panel runner CI uses (never read by CI). */
  caseId: string | null;
  trials: number | null;
};

function parsePositiveInt(value: string | undefined, flag: string): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} needs a positive integer. Received: ${value}`);
  return parsed;
}

function validatedTier(value: string | undefined, source: string): PaidTier {
  if (value === undefined || value === '') return DEFAULT_TIER;
  // A typo'd EVALS_TIER (e.g. 'e2e', the tier string eval-store uses) would
  // otherwise cast through unchecked, match nothing in the runtime E2E_TIERS
  // filter, self-skip every test, and exit 0 with all shards 'passed' — the
  // exact 0%-execution-looks-like-a-pass class this runner exists to kill.
  if (!PAID_TIERS.includes(value as PaidTier)) {
    throw new Error(`${source} must be gate, periodic or marathon. Received: ${value}`);
  }
  return value as PaidTier;
}

export function validatedProfile(value: string | undefined, source: string): PaidProfile {
  if (value === undefined || value === '') return 'full';
  if (value !== 'pr' && value !== 'full') throw new Error(`${source} must be pr or full. Received: ${value}`);
  return value;
}

export function parseCliOptions(argv: string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  const options: CliOptions = {
    tier: validatedTier(env.EVALS_TIER, 'EVALS_TIER'),
    profile: validatedProfile(env.EVALS_PROFILE, 'EVALS_PROFILE'),
    profileExplicit: !!env.EVALS_PROFILE,
    listOnly: false,
    skipJudges: false,
    timeoutExplicit: !!env.EVALS_SHARD_TIMEOUT_MS,
    timeoutMs: env.EVALS_SHARD_TIMEOUT_MS
      ? parsePositiveInt(env.EVALS_SHARD_TIMEOUT_MS, 'EVALS_SHARD_TIMEOUT_MS')
      : DEFAULT_SHARD_TIMEOUT_MS,
    // EVALS_JOBS = shard process count. EVALS_CONCURRENCY deliberately does
    // NOT set jobs anymore — it's bun's within-shard --max-concurrency (its
    // legacy meaning). Conflating them turned "EVALS_CONCURRENCY=15" into 15
    // parallel Bun processes each spawning claude.
    jobs: env.EVALS_JOBS ? parsePositiveInt(env.EVALS_JOBS, 'EVALS_JOBS') : DEFAULT_JOBS,
    withinShardConcurrency: env.EVALS_CONCURRENCY
      ? parsePositiveInt(env.EVALS_CONCURRENCY, 'EVALS_CONCURRENCY')
      : DEFAULT_WITHIN_SHARD_CONCURRENCY,
    maxFilesPerShard: DEFAULT_MAX_FILES_PER_SHARD,
    emitPlanPath: null,
    slices: 1,
    sliceBudgetMs: null,
    jobsExplicit: !!env.EVALS_JOBS,
    planPath: null,
    sliceIndex: null,
    reportDir: null,
    writeDurations: false,
    maxParallel: null,
    caseId: null,
    trials: null,
  };

  const pathValue = (message: string, assign: (value: string) => void) => (next: () => string | undefined) => {
    const value = next();
    if (!value) throw new Error(message);
    assign(value);
  };
  parseCliFlags(argv, {
    '--list': () => { options.listOnly = true; },
    '--tier': (next) => { options.tier = validatedTier(next() ?? '-', '--tier'); },
    '--profile': pathValue('--profile needs pr or full', (value) => {
      options.profile = validatedProfile(value, '--profile'); options.profileExplicit = true;
    }),
    '--timeout': (next) => { options.timeoutMs = parsePositiveInt(next(), '--timeout') * 1000; options.timeoutExplicit = true; },
    '--jobs': (next) => { options.jobs = parsePositiveInt(next(), '--jobs'); options.jobsExplicit = true; },
    '--slice-budget': (next) => { options.sliceBudgetMs = parsePositiveInt(next(), '--slice-budget') * 1000; },
    '--files-per-shard': (next) => { options.maxFilesPerShard = parsePositiveInt(next(), '--files-per-shard'); },
    '--emit-plan': pathValue('--emit-plan needs a file path', (value) => { options.emitPlanPath = value; }),
    '--skip-judges': () => { options.skipJudges = true; },
    '--slices': (next) => { options.slices = parsePositiveInt(next(), '--slices'); },
    '--plan': pathValue('--plan needs a manifest path', (value) => { options.planPath = value; }),
    '--slice': (next) => { options.sliceIndex = parsePositiveInt(next(), '--slice'); },
    '--report': pathValue('--report needs a directory', (value) => { options.reportDir = value; }),
    '--write-durations': () => { options.writeDurations = true; },
    '--max-parallel': (next) => { options.maxParallel = parsePositiveInt(next(), '--max-parallel'); },
    '--case': (next) => {
      const value = next();
      if (!value || !Object.hasOwn(E2E_TIERS, value)) throw new Error(`--case needs a live E2E case id. Received: ${value}`);
      options.caseId = value;
    },
    '--trials': (next) => { options.trials = parsePositiveInt(next(), '--trials'); },
  });
  if (options.writeDurations && !options.reportDir) throw new Error('--write-durations requires --report');
  if (options.trials !== null && options.caseId === null) throw new Error('--trials requires --case');
  if (options.caseId !== null && (options.emitPlanPath || options.planPath || options.reportDir || options.sliceIndex !== null)) {
    throw new Error('--case is local diagnosis; it cannot combine with --emit-plan, --plan/--slice or --report');
  }
  if (options.sliceBudgetMs !== null && argv.includes('--slices')) throw new Error('Plan with exactly one of --slices or --slice-budget');
  if (options.sliceBudgetMs !== null && !options.jobsExplicit) throw new Error('--slice-budget needs explicit --jobs (or EVALS_JOBS): the plan packs and supervises for that worker count');
  if (options.skipJudges && (!options.emitPlanPath || options.tier !== 'gate')) throw new Error('--skip-judges applies only to an emitted gate census plan');
  if (options.profile === 'pr' && options.tier !== 'gate') throw new Error('PR profile requires gate tier');
  if (options.profile === 'pr' && options.maxFilesPerShard !== 1) throw new Error('PR profile requires one file per shard to preserve case accounting');
  return options;
}

async function main(): Promise<number> {
  const options = parseCliOptions(process.argv.slice(2));
  const timeoutOverride = options.timeoutExplicit ? options.timeoutMs : undefined;

  // ── Planner mode: compute selection + the slice plan ONCE, write it, exit.
  if (options.emitPlanPath) {
    const manifest = buildRunManifest({
      tier: options.tier,
      profile: options.profile,
      ...(options.sliceBudgetMs !== null ? { sliceBudgetMs: options.sliceBudgetMs, jobs: options.jobs } : { sliceCount: options.slices }),
      timeoutMs: options.timeoutExplicit ? options.timeoutMs : undefined,
      evalsAll: process.env.EVALS_ALL === '1',
      skipJudges: options.skipJudges,
    });
    fs.mkdirSync(path.dirname(path.resolve(options.emitPlanPath)), { recursive: true });
    fs.writeFileSync(options.emitPlanPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const planned = manifest.entries.filter((e) => e.status === 'planned').length;
    const skipped = manifest.entries.filter((e) => e.status === 'skipped-by-diff').length;
    const excludedCount = manifest.entries.filter((e) => e.status === 'excluded').length;
    console.log(
      `[test:paid] plan: tier=${manifest.tier} profile=${manifest.profile ?? 'full'} evalsAll=${manifest.evalsAll} — `
      + `${planned} planned across ${manifest.sliceCount} slice(s), ${skipped} skipped by diff, `
      + `${excludedCount} excluded (${manifest.selectionReason})`,
    );
    for (const line of formatSlicePlan(manifest)) console.log(line);
    for (const line of formatCapacityPreflight(manifest, options.maxParallel ?? undefined)) console.log(line);
    // Planner-side reuse: ship ONE filtered receipt set with the plan, so
    // every trial of a panel (on any slice) sees the same receipts.
    if (manifest.profile === 'pr' && process.env.EVALS_CACHE_DIR) {
      const shipped = selectPlanReceipts(process.env.EVALS_CACHE_DIR, path.join(path.dirname(path.resolve(options.emitPlanPath)), 'receipts'));
      console.log(`[test:paid] reuse: shipped ${shipped.shipped} receipt(s) with the plan; blocked ${shipped.blocked.length} (newer FAIL or partial panel)`);
    }
    return 0;
  }

  // ── Report mode: reconcile slice artifacts against the manifest. Fail-closed:
  // a slice whose artifact never landed is a FAILURE, not an absence.
  if (options.reportDir) return runPaidReport(options.reportDir, { writeDurations: options.writeDurations });

  if (options.caseId && options.listOnly) {
    const file = caseFile(options.caseId);
    const plan = caseTrialPlan(options.caseId);
    const n = options.trials ?? plan.panel.n;
    console.log(`[test:paid] --case ${options.caseId}: ${n} trial(s) of ${file} (kind ${plan.kind}), list only`);
    for (let trial = 1; trial <= n; trial++) console.log(`  ${trialShardKey(file, options.caseId, trial)}`);
    return 0;
  }
  if (options.caseId) {
    preflightAnthropicApi(process.env);
    const verdict = await runCaseDiagnosis(options.caseId, { trials: options.trials ?? undefined, jobs: options.jobs,
      withinShardConcurrency: options.withinShardConcurrency, timeoutMs: timeoutOverride,
      evalDirBase: process.env.GSTACK_EVAL_DIR || getProjectEvalDir() });
    return verdict.status === 'PASS' ? 0 : 1;
  }

  const discovered = collectPaidTestFiles();
  if (discovered.length === 0) throw new Error('No paid test files were discovered.');

  // ── Executor mode: consume the planner's manifest; never self-select.
  if (options.planPath || options.sliceIndex !== null) {
    if (!options.planPath || options.sliceIndex === null) {
      throw new Error('--plan and --slice must be used together');
    }
    const manifest = parseRunManifest(fs.readFileSync(options.planPath, 'utf-8'));
    if (manifest.tier !== options.tier) {
      throw new Error(`manifest tier ${manifest.tier} != requested tier ${options.tier} — refusing a cross-tier run`);
    }
    const profile = manifest.profile ?? 'full';
    if (options.profileExplicit && options.profile !== profile) throw new Error(`manifest profile ${profile} != requested profile ${options.profile}`);
    if (options.sliceIndex > manifest.sliceCount) {
      throw new Error(`--slice ${options.sliceIndex} exceeds manifest sliceCount ${manifest.sliceCount}`);
    }
    if (manifest.plan && options.jobs !== manifest.plan.jobs) {
      throw new Error(`manifest was packed for ${manifest.plan.jobs} worker(s) per slice; EVALS_JOBS=${options.jobs} would break its supervision bound`);
    }
    const mine = sliceExecutionOrder(manifest.entries.filter((e) => e.status === 'planned' && e.slice === options.sliceIndex));
    const shards = mine.map((e) => [e.file]);
    for (const files of shards) resolvePaidShardTimeoutMs(files, timeoutOverride);
    console.log(`[test:paid] slice ${options.sliceIndex}/${manifest.sliceCount}: ${shards.length} shard(s), tier=${manifest.tier}, evalsAll=${manifest.evalsAll}`);

    if (options.listOnly) {
      for (const [index, files] of shards.entries()) {
        const budget = resolvePaidShardBudget(files, timeoutOverride);
        console.log(`  shard ${index + 1}/${shards.length}: ${files.join(' ')} wall=${budget.timeoutMs}ms source=${budget.source} policy=${budget.policyId ?? 'none'} retries=${retriesForFiles(files)}`);
      }
      return 0;
    }

    const evalDirBase = process.env.GSTACK_EVAL_DIR || getProjectEvalDir();
    const trials = Object.fromEntries(mine.filter(entry => entry.trial).map(entry => [normalizeRelativePath(entry.file), entry.trial!]));
    const exclusionPatterns = Object.fromEntries(mine.filter(entry => entry.excludeCases).map(entry => [entry.file,
      manifest.prCoverage?.mode === 'pr' ? prProfileTestNamePattern(entry.file, manifest.selection!, entry.excludeCases)
        : excludedCasesNamePattern(entry.excludeCases!)]));
    const startedAt = Date.now();
    let summary: RunSummary;
    if (shards.length === 0) {
      summary = summarize([]);
    } else {
      preflightAnthropicApi(process.env);
      summary = await runPaidShards(shards, {
        trials,
        casePatterns: exclusionPatterns,
        timeoutMs: options.timeoutExplicit ? options.timeoutMs : undefined,
        jobs: options.jobs,
        withinShardConcurrency: options.withinShardConcurrency,
        registeredBudgets: Object.fromEntries(mine.filter(entry => entry.budget).map(entry => [normalizeRelativePath(entry.file), entry.budget!])),
        ...(manifest.prCoverage?.mode === 'pr' ? {
          expectedCases: Object.fromEntries(mine.map(entry => [entry.file, expectedPrCaseCount(entry.file, manifest.selection!, entry.excludeCases)])),
          casePatterns: Object.fromEntries(mine.map(entry => [entry.file, prProfileTestNamePattern(entry.file, manifest.selection!, entry.excludeCases)])),
          expectedCaseIds: Object.fromEntries(mine.map(entry => [entry.file, prProfileShardIds(entry.file, manifest.selection!, entry.excludeCases)])),
          reuseFor: e2eReuseLaneProblem(process.env, manifest.prCoverage.mode) !== null ? undefined : (files, env, budget) => {
            const key = files[0]!;
            const file = shardFile(key);
            if (files.length !== 1 || !/^test\/skill-e2e-/.test(file)) return null;
            const { registered, known } = fileCaseRegistration(file, fs.readFileSync(path.join(ROOT, file), 'utf8'));
            const exclude = mine.find(entry => entry.file === key)?.excludeCases;
            return prepareE2EShardReuse({ root: ROOT, key, file, caseIds: prProfileShardIds(key, manifest.selection!, exclude),
              ...(trials[normalizeRelativePath(key)] ? { panel: trials[normalizeRelativePath(key)] } : {}),
              registeredIds: registered, registrationKnown: known,
              casePattern: prProfileTestNamePattern(key, manifest.selection!, exclude), expectedCases: expectedPrCaseCount(key, manifest.selection!, exclude),
              retries: retriesForFiles(files), timeoutMs: budget.timeoutMs, withinShardConcurrency: options.withinShardConcurrency,
              tier: manifest.tier, profile, env });
          },
        } : {}),
        env: {
          ...process.env,
          // Manifest filenames already encode carve selection. Ambient scope
          // must not suppress a planned wrapper when this slice executes.
          GSTACK_CARVE_SKILL: '',
          EVALS: '1',
          EVALS_TIER: options.tier,
          EVALS_ALL: manifest.evalsAll ? '1' : '',
          EVALS_PREFLIGHT_OK: '1',
          // The manifest IS the selection: children must not re-derive a
          // possibly-different one from their own git view.
          ...paidSelectionEnv(profile, manifest.selection ?? { e2e: null, judges: null }, `manifest slice ${options.sliceIndex}: ${manifest.selectionReason}`),
        },
        evalDirBase,
      });
    }
    const guarded = guardTrialRecords(applyHollowShardGuard(summary.outcomes, { evalsAll: manifest.evalsAll, requireExecuted: manifest.prCoverage?.mode === 'pr' }));
    summary = summarize(guarded);
    const attempt = Number(process.env.GITHUB_RUN_ATTEMPT);
    const sliceResult: SliceResult = {
      version: 1,
      tier: manifest.tier,
      profile,
      ...(manifest.selection ? { selection: manifest.selection } : {}),
      sliceIndex: options.sliceIndex,
      sliceCount: manifest.sliceCount,
      ...(options.timeoutExplicit ? { timeoutOverrideMs: options.timeoutMs } : {}),
      attempt: Number.isSafeInteger(attempt) && attempt > 0 ? attempt : 1,
      startedAt,
      finishedAt: Date.now(),
      outcomes: guarded.map(({ files, status, exitCode, elapsedMs, executedTests, skippedTests, budget, reused, runnerError, trial, inputKey }) =>
        ({ files, status, exitCode, elapsedMs, executedTests, skippedTests, ...(budget ? { budget } : {}), ...(reused ? { reused } : {}),
          ...(runnerError !== undefined ? { runnerError } : {}), ...(trial ? { trial } : {}), ...(inputKey ? { inputKey } : {}) })),
    };
    fs.mkdirSync(evalDirBase, { recursive: true });
    const sliceResultPath = path.join(evalDirBase, `slice-${options.sliceIndex}.json`);
    fs.writeFileSync(sliceResultPath, `${JSON.stringify(sliceResult, null, 2)}\n`);
    console.log(`[test:paid] slice result: ${sliceResultPath}`);
    for (const line of formatSummary(summary)) console.log(line);
    for (const outcome of guarded.filter(outcome => outcome.trial)) {
      const t = outcome.trial!;
      console.log(`  trial ${t.case} t${t.trial}/${t.panel.n}: ${t.outcome ?? `NO RECORD (${t.harness})`}${t.failure_class ? ` [${t.failure_class}]` : ''}`);
    }
    return sliceExitCode(guarded);
  }

  if (options.listOnly && options.sliceBudgetMs !== null) {
    const manifest = buildRunManifest({ tier: options.tier, profile: options.profile, sliceBudgetMs: options.sliceBudgetMs,
      jobs: options.jobs, evalsAll: process.env.EVALS_ALL === '1', timeoutMs: timeoutOverride });
    console.log(`[test:paid] slice plan preview: tier=${manifest.tier} profile=${manifest.profile ?? 'full'} (${manifest.selectionReason})`);
    for (const line of formatSlicePlan(manifest)) console.log(line);
    return 0;
  }

  const tierSelection = selectPaidTestFiles(discovered, options.tier);
  const caseKeys = partitionCaseExclusions(expandCaseShards(tierSelection.selected, options.tier));
  const selected = tierSelection.selected;
  const excluded = [...tierSelection.excluded, ...caseKeys.excluded];
  // Same panels as CI: isolated cases run as trial shards, their file shard excludes them.
  const expansion = expandTrialShards(caseKeys.runnable, options.tier);
  const shards = planPaidShards(expansion.keys, { maxFilesPerShard: options.maxFilesPerShard,
    ownShard: new Set(Object.keys(expansion.excludeCases)) });

  // Parent-side diff selection (D9): skip whole shards whose mapped tests are
  // all unselected. Fail-open everywhere — the child's self-skip stays
  // authoritative for anything the mapper can't attribute.
  const cases = computePaidCaseSelection({ profile: options.profile });
  const fast = cases.coverage?.mode === 'pr';
  const excludeOf = (file: string) => expansion.excludeCases[normalizeRelativePath(file)] ?? [];
  const profileShards = fast ? shards.filter(files => files.some(file => prProfileFileSelected(file, cases.selection, excludeOf(file)))) : shards;
  const { runnable, skipped } = partitionShardsByDiffSelection(profileShards,
    cases.selection.e2e === null ? null : new Set(cases.selection.e2e), { excludeCases: expansion.excludeCases });
  if (fast) for (const files of shards) {
    if (!files.some(file => prProfileFileSelected(file, cases.selection, excludeOf(file)))) skipped.push({ files, reason: 'Outside the fast PR profile; retained in broad coverage' });
  }
  const selectedCount = cases.selection.e2e?.length ?? Object.keys(E2E_TOUCHFILES).length;
  console.log(
    `[test:paid] selection: profile=${options.profile} selected ${selectedCount} of ${Object.keys(E2E_TOUCHFILES).length} tests -> `
    + `running ${runnable.length} of ${shards.length} shards, reason: ${cases.reason}`,
  );
  console.log(
    `[test:paid] tier=${options.tier}: ${selected.length}/${discovered.length} files, `
    + `${shards.length} shards, jobs=${options.jobs}, ${options.timeoutExplicit ? 'explicit' : 'ordinary default'} wall=${Math.round(options.timeoutMs / 1000)}s; per-shard policies below`,
  );

  if (options.listOnly) {
    const skipReasons = new Map(skipped.map((s) => [s.files.join(' '), s.reason]));
    for (let index = 0; index < shards.length; index += 1) {
      const key = shards[index].join(' ');
      const note = skipReasons.has(key) ? `  [would skip: ${skipReasons.get(key)}]` : '';
      const budget = resolvePaidShardBudget(shards[index], options.timeoutExplicit ? options.timeoutMs : undefined);
      console.log(`  shard ${index + 1}/${shards.length}: ${key} wall=${budget.timeoutMs}ms source=${budget.source} policy=${budget.policyId ?? 'none'} retries=${retriesForFiles(shards[index])}${note}`);
    }
    if (excluded.length > 0) {
      console.log(`\nExcluded (${excluded.length}):`);
      for (const { file, reason } of excluded) console.log(`  - ${file}  [${reason}]`);
    }
    return 0;
  }

  // One preflight ping in the parent; children skip theirs via the env flag.
  // Before this, every shard's e2e-helpers module load re-pinged the API —
  // ~30 paid claude -p calls (30s timeout each) per full run for one bit of
  // information. A dead API now fails here, before any shard spawns.
  // Nothing runnable → nothing to ping.
  for (const files of runnable) resolvePaidShardTimeoutMs(files, timeoutOverride);
  if (runnable.length > 0) preflightAnthropicApi(process.env);

  const runSummary = await runPaidShards(runnable, {
    // Tier reaches the children only via EVALS_TIER below; the runtime
    // E2E_TIERS filter inside each child is the real selection mechanism.
    timeoutMs: options.timeoutExplicit ? options.timeoutMs : undefined,
    jobs: options.jobs,
    withinShardConcurrency: options.withinShardConcurrency,
    trials: expansion.trials,
    casePatterns: Object.fromEntries(Object.entries(expansion.excludeCases).map(([file, ids]) => [file, excludedCasesNamePattern(ids)])),
    ...(fast ? {
      expectedCases: Object.fromEntries(runnable.flat().map(file => [file, expectedPrCaseCount(file, cases.selection, excludeOf(file))])),
      casePatterns: Object.fromEntries(runnable.flat().map(file => [file, prProfileTestNamePattern(file, cases.selection, excludeOf(file))])),
    } : {}),
    env: {
      ...process.env,
      EVALS: '1',
      EVALS_TIER: options.tier,
      EVALS_PREFLIGHT_OK: '1',
      // The parent's selection, computed once above — children's e2e-helpers
      // module load adopts it instead of re-deriving per shard (which spawned
      // a bun subprocess per child on the touchfiles-data map-diff path).
      // Children fall back to local derivation on any parse failure.
      ...paidSelectionEnv(options.profile, cases.selection, cases.reason),
    },
    evalDirBase: process.env.GSTACK_EVAL_DIR || getProjectEvalDir(),
  });
  const skippedOutcomes: ShardOutcome[] = skipped.map((s, index) => ({
    shard: runnable.length + index + 1,
    files: s.files,
    status: 'skipped-by-diff',
    exitCode: null,
    elapsedMs: 0,
    groupPid: null,
    executedTests: null,
    skippedTests: null,
  }));
  const guardedOutcomes = guardTrialRecords(applyHollowShardGuard(runSummary.outcomes, {
    evalsAll: process.env.EVALS_ALL === '1',
    requireExecuted: fast,
  }));
  const summary = summarize([...guardedOutcomes, ...skippedOutcomes]);
  for (const line of formatSummary(summary)) console.log(line);
  // The same verdict rule as the CI report: one panelVerdict() per isolated case.
  const panels = new Map<string, ShardTrialRecord[]>();
  for (const outcome of guardedOutcomes) {
    const panel = outcome.trial ? trialPanelKey(outcome.files[0]!) : null;
    if (panel) panels.set(panel, [...(panels.get(panel) ?? []), outcome.trial!]);
  }
  let panelRed = false;
  for (const [key, records] of panels) {
    const plan = expansion.trials[`${key}~t1`]!;
    const verdict = panelVerdict({ case: shardCaseId(key)!, kind: plan.kind, panel: plan.panel, quarantined: plan.quarantined,
      trials: records.filter(r => r.outcome !== null).map(r => ({ trial: r.trial, outcome: r.outcome!,
        ...(r.failure_class ? { failure_class: r.failure_class } : {}), ...(r.exit_reason ? { exit_reason: r.exit_reason } : {}),
        ...(r.error ? { error: r.error } : {}) })) });
    if (verdict.status !== 'PASS' || verdict.split) console.log(`  ${formatPanelLine({ ...verdict, file: shardFile(key), slices: {} }, options.tier)}`);
    panelRed ||= verdict.failsLane;
  }
  return sliceExitCode([...guardedOutcomes, ...skippedOutcomes]) || (panelRed ? 1 : 0);
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(`[test:paid] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
