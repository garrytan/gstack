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
 * map in test/helpers/touchfiles.ts. Output classification reuses
 * scripts/test-strict-output.ts rather than reimplementing it.
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
import { normalizeRelativePath } from './test-free-shards';
import {
  BunTestOutputClassifier,
  exactTestFileSelectors,
  forwardAndClassify,
  isTerminationRequested,
  runShardChild,
  strictTestExitCode,
} from './test-strict-output';
import { PAID_TEST_GLOBS, isPaidTestFile } from '../test/helpers/paid-test-set';
import { PERIODIC_CI_EXCLUDE } from '../test/helpers/periodic-exclude-data';
import { AUTOPLAN_CHAIN_BUDGET, FILE_RETRY_BUDGETS, STRICT_RETRY_CASE_BUDGETS } from '../test/helpers/eval-budgets';
import { getProjectEvalDir, getClaudeCliVersion, isFinalizedEvalResultFile, evalEntryOutcome } from '../test/helpers/eval-store';
import { manualReviewProblem } from '../test/helpers/cookie-workflow-manual-review';
import { preflightAnthropicApi } from '../test/helpers/anthropic-preflight';
import { OVERLAY_MIN_FILE_WALL_MS } from '../test/helpers/overlay-case-policy';
import { PR_PROFILE_CASE_IDS, PR_PROFILE_FILES, packageChangeOnlyVersion, selectPrProfile, type PrProfileSelection } from './test-pr-profile';
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

const ROOT = path.resolve(import.meta.dir, '..');

export type PaidTier = 'gate' | 'periodic';
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
  const other: PaidTier = tier === 'gate' ? 'periodic' : 'gate';
  const declares = (candidate: PaidTier) =>
    new RegExp(`EVALS_TIER\\s*===\\s*['"\`]${candidate}['"\`]`).test(source) ||
    new RegExp(`\\b(?:describeE2ETier|e2eTierEnabled)\\(\\s*['"\`]${candidate}['"\`]`).test(source);

  if (declares(tier)) return { included: true, reason: `declares tier '${tier}'` };
  if (declares(other)) return { included: false, reason: `declares tier '${other}' only` };
  return { included: true, reason: 'no whole-file tier guard — runtime E2E_TIERS filter decides' };
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
  // Periodic-lane exclusions (documented-red / manual-hardware files): a
  // known-red weekly shard is triage waste locally AND in CI, so the list
  // applies to every periodic run, with the reason surfaced per file.
  const ciExcluded = (file: string): { reason: string; tracking: string } | undefined =>
    tier === 'periodic' ? PERIODIC_CI_EXCLUDE[normalizeRelativePath(file)] : undefined;
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
    if (classification.included) selected.push(file);
    else excluded.push({ file, reason: classification.reason });
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
}): { selection: PaidCaseSelection; reason: string; coverage?: PrProfileSelection } {
  const env = options.env ?? process.env;
  const rootDir = options.rootDir ?? ROOT;
  const baseRef = env.EVALS_BASE || detectBaseBranch(rootDir) || 'main';
  const files = options.changedFiles ?? (env.EVALS_ALL ? [] : getChangedFiles(baseRef, rootDir));
  const all = !!env.EVALS_ALL || files.length === 0;
  const effectiveFiles = files.filter(file => options.profile !== 'pr' || file !== 'package.json' || !packageVersionOnlySinceBase(rootDir, baseRef));
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
export function prProfileFileSelected(file: string, selection: PaidCaseSelection): boolean {
  if (file === 'test/skill-llm-eval.test.ts') return selection.judges === null || selection.judges.length > 0;
  const ids = PR_PROFILE_FILES[normalizeRelativePath(file)];
  return !!ids && (selection.e2e === null || ids.some(id => selection.e2e!.includes(id)));
}

export function expectedPrCaseCount(file: string, selection: PaidCaseSelection): number {
  if (file === 'test/skill-llm-eval.test.ts') return selection.judges?.length ?? Object.keys(LLM_JUDGE_TOUCHFILES).length;
  return (PR_PROFILE_FILES[normalizeRelativePath(file)] ?? []).filter(id => selection.e2e === null || selection.e2e.includes(id)).length;
}

export function prProfileTestNamePattern(file: string, selection: PaidCaseSelection): string {
  const labels: Record<string, string> = {
    'plan-review-report': '/plan-eng-review writes GSTACK REVIEW REPORT to plan file',
    'auq-format-gate': "/plan-ceo-review's first AskUserQuestion is a compliant decision brief (7/7 + substance)",
  };
  const ids = file === 'test/skill-llm-eval.test.ts'
    ? selection.judges ?? Object.keys(LLM_JUDGE_TOUCHFILES)
    : (PR_PROFILE_FILES[file] ?? []).filter(id => selection.e2e === null || selection.e2e.includes(id));
  if (ids.length === 0) throw new Error(`No selected PR cases for ${file}`);
  const escaped = ids.map(id => (labels[id] ?? id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return `(?:^|\\s)(?:${escaped.join('|')})$`;
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
 * (llm-judge / codex-e2e / gemini-e2e / routing, keyed off other maps),
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
  const mapped = [...new Set([...quoted, ...registered])];
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
  options: { maxFilesPerShard?: number } = {},
): string[][] {
  const size = Math.max(1, options.maxFilesPerShard ?? DEFAULT_MAX_FILES_PER_SHARD);
  const unique = [...new Set(files.map(normalizeRelativePath))].sort();
  const shards: string[][] = [];
  let pending: string[] = [];
  for (const file of unique) {
    if (isOverlayTestFile(file) || file === AUTOPLAN_CHAIN_BUDGET.file || FILE_RETRY_BUDGETS.some(budget => budget.file === file)) {
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
  const autoplan = files.map(normalizeRelativePath).includes(AUTOPLAN_CHAIN_BUDGET.file);
  if (autoplan && files.length !== 1) throw new Error('Autoplan budget requires its own shard');
  const finding = FILE_RETRY_BUDGETS.find(budget => files.map(normalizeRelativePath).includes(budget.file));
  if (finding && files.length !== 1) throw new Error('Registered retry budget requires its own shard');
  if (overrideMs !== undefined && (!Number.isSafeInteger(overrideMs) || overrideMs <= 0 || overrideMs > 2_147_483_647)) {
    throw new Error('Shard timeout must be a finite positive timer-safe integer');
  }
  const overlay = files.some(isOverlayTestFile);
  if (overlay && files.length !== 1) throw new Error('Overlay budget requires its own shard');
  if (overlay && overrideMs !== undefined && overrideMs < OVERLAY_MIN_FILE_WALL_MS) {
    throw new Error(`Overlay shard requires at least ${OVERLAY_MIN_FILE_WALL_MS}ms; explicit wall ${overrideMs}ms cannot preserve its work and finalization budget`);
  }
  return {
    timeoutMs: overrideMs ?? (autoplan ? AUTOPLAN_CHAIN_BUDGET.shardMs : finding ? finding.shardMs : overlay ? OVERLAY_MIN_FILE_WALL_MS : DEFAULT_SHARD_TIMEOUT_MS),
    source: overrideMs !== undefined ? 'explicit' : autoplan || finding ? 'registered' : 'default',
    policyId: autoplan ? AUTOPLAN_CHAIN_BUDGET.id : finding?.id ?? null,
  };
}

function sameBudget(actual: PaidShardBudget | undefined, expected: PaidShardBudget): boolean {
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
  // Retries default to 1; RETRY_OVERRIDES membership (old matrix rows'
  // earned `retries: 2`) flows through retriesForFiles at the call site.
  return ['test', ...files, '--retry', String(retries ?? 1), '--concurrent', `--max-concurrency=${maxConcurrency}`, `--timeout=${timeoutMs}`];
}

/**
 * Stable per-shard eval-dir slug: test filename sans extension, sanitized.
 * Stable across runs so each shard baselines against its own prior run.
 */
export function shardSlug(files: string[]): string {
  return files
    .map((file) => path.basename(normalizeRelativePath(file)).replace(/\.test\.(?:[cm]?[jt]s|tsx|jsx)$/, ''))
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
  /** Legacy Autoplan allocation; callers may supply registered per-file allocations. */
  autoplanBudget?: PaidShardBudget;
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
}

let shardLogSequence = 0;

/** Per-shard log path: slug + timestamp; pid + sequence defeat same-ms collisions. */
function nextShardLogPath(files: string[], logDir: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  shardLogSequence += 1;
  return path.join(logDir, `gstack-paid-shard-${shardSlug(files)}-${stamp}-${process.pid}-${shardLogSequence}.log`);
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

export async function runPaidShard(
  files: string[],
  shardNumber: number,
  totalShards: number,
  options: RunShardsOptions = {},
): Promise<ShardOutcome> {
  if (files.length === 0) throw new Error('Cannot run an empty paid-test shard.');
  const rootDir = options.rootDir ?? ROOT;
  const planned = options.registeredBudgets?.[normalizeRelativePath(files[0]!)] ??
    (files.map(normalizeRelativePath).includes(AUTOPLAN_CHAIN_BUDGET.file) ? options.autoplanBudget : undefined);
  const budget = resolvePaidShardBudget(files, options.timeoutMs ??
    (planned?.source === 'explicit' ? planned.timeoutMs : undefined));
  const timeoutMs = budget.timeoutMs;
  const streamLive = (options.jobs ?? DEFAULT_JOBS) === 1;
  const log = options.log ?? ((line: string) => console.log(line));
  const label = `[test:paid] shard ${shardNumber}/${totalShards}`;

  const { command, args } = options.commandFor
    ? options.commandFor(files)
    : {
      command: process.execPath,
      args: [...buildPaidShardArgs(
        exactTestFileSelectors(files, rootDir),
        timeoutMs,
        options.withinShardConcurrency ?? DEFAULT_WITHIN_SHARD_CONCURRENCY,
        retriesForFiles(files),
      ), ...(options.casePatterns ? ['--test-name-pattern', options.casePatterns[files[0]]] : [])],
    };

  const env = { ...(options.env ?? process.env) };
  if (options.evalDirBase) {
    env.GSTACK_EVAL_DIR = path.join(options.evalDirBase, 'shards', shardSlug(files));
  }
  // Resolve `claude --version` ONCE in the parent (cached across shards) and
  // hand it to every child: eval-store's fallback is a synchronous spawn on
  // the same thread that polls PTY sessions, so children must never pay it.
  if (!env.GSTACK_CLAUDE_CLI_VERSION) {
    env.GSTACK_CLAUDE_CLI_VERSION = getClaudeCliVersion();
  }
  // Per-shard temp + Chromium-profile isolation — the free runner treats
  // this as mandatory (test-free-shards.ts: two concurrent shards on one
  // profile dir kill each other's browser; shared tmp cross-contaminates),
  // and the paid lane had NONE of it. Doubly load-bearing here: when a
  // shard hits its 30-min wall the group-SIGKILL means per-test afterAll
  // cleanup never runs — the rmSync backstop below is the only thing
  // stopping wedged runs from accumulating full git-repo workspaces in the
  // shared tmpdir forever. Prerequisite for raising EVALS_JOBS (more
  // concurrency on shared state amplifies exactly the opus-47 race class).
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-paid-shard-'));
  const childTmp = path.join(stateDir, 'tmp');
  fs.mkdirSync(childTmp);
  env.TMPDIR = childTmp;
  env.TEMP = childTmp;
  env.TMP = childTmp;
  env.CHROMIUM_PROFILE = path.join(stateDir, 'chromium-profile');

  const startedAt = Date.now();
  log(`${label} START ${files.join(' ')} (timeout ${Math.round(timeoutMs / 1000)}s, ${budget.source}${budget.policyId ? `: ${budget.policyId}` : ''})`);

  // Full-stream spool: EVERY child byte lands on disk (the free runner's
  // model), never in a whole-run Buffer[] — non-live shards used to hold
  // their entire 30-min stream-json stdout+stderr in RAM, × concurrent jobs.
  // Printed at START so a wedged shard is inspectable live, mid-run.
  const logPath = nextShardLogPath(files, options.logDir ?? os.tmpdir());
  const logStream = fs.createWriteStream(logPath);
  let logWriteFailed = false;
  logStream.on('error', (err) => {
    if (logWriteFailed) return;
    logWriteFailed = true;
    console.error(`${label} could not write the full log at ${logPath}: ${err.message}`);
  });
  log(`${label} full log: ${logPath}`);

  const classifier = new BunTestOutputClassifier();
  // Tee: the spool always gets the chunk; live mode (jobs=1) also forwards to
  // the console. forwardAndClassify feeds the classifier FIRST, so the strict
  // verdict path is unchanged by where the bytes land afterwards.
  const sink = (destination: NodeJS.WriteStream): NodeJS.WriteStream => ({
    write: (chunk: Buffer | string): boolean => {
      if (!logWriteFailed) logStream.write(chunk);
      if (streamLive) destination.write(chunk);
      return true;
    },
  } as unknown as NodeJS.WriteStream);

  let exitCode: number | null = null;
  let timedOut = false;
  let groupPid: number | null = null;
  try {
    // Shared spawn/detached/group-kill/wall-timer/reap lifecycle.
    const result = await runShardChild({
      command,
      args,
      cwd: rootDir,
      env,
      timeoutMs,
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
  } finally {
    // Close the spool even when the spawn itself failed.
    await new Promise<void>((resolve) => logStream.end(() => resolve()));
    try {
      // async rm: a SIGKILLed shard can leave a full git workspace + Chromium
      // profile here; a synchronous recursive delete on the parent's event
      // loop would stall every sibling shard's stream classification and
      // wall timers for seconds (review finding).
      await fs.promises.rm(stateDir, { recursive: true, force: true });
    } catch {
      // Best-effort: a locked file must not turn a real verdict into an
      // exception (same posture as the free runner's cleanup).
    }
  }

  const summary = classifier.end();

  // Pass expectedFiles so a shard whose bun child ran fewer files than planned
  // (or zero, all self-skipped) with exit 0 is NOT recorded 'passed' — the
  // invisible-non-execution class this runner exists to kill. bun prints
  // "Ran N tests across M files" with M = selected files even when every test
  // self-skips, so terminalFileCounts must include files.length. Enforced for
  // injected commandFor (tests) too, matching the free runner — fake passing
  // commands must print a synthetic `Ran N tests across M files. [Xms]` line,
  // so tests can pin the summary-missing => failure backstop.
  const expectedFiles = files.length;
  let status: ShardStatus = timedOut
    ? 'timed-out'
    : strictTestExitCode(exitCode ?? 1, summary, expectedFiles) === 0 ? 'passed' : 'failed';
  if (status === 'passed' && options.expectedCases) {
    const expected = files.reduce((count, file) => count + (options.expectedCases![file] ?? 0), 0);
    const actual = summary.terminalTestCounts.reduce((count, value) => count + value, 0) - summary.skippedTests;
    if (expected < 1 || actual !== expected) {
      status = 'failed';
      log(`${label} expected ${expected} selected cases, executed ${actual}; refusing incomplete PR coverage`);
    }
  }
  const elapsedMs = Date.now() - startedAt;

  // Failure debuggability without the RAM cost: read back only the log's
  // tail. Live mode already streamed everything, so no re-print there.
  if (status !== 'passed' && !streamLive) {
    const tail = readLogTail(logPath);
    if (tail.length > 0) {
      process.stdout.write(`${label} last ${Math.min(tail.length, FAILURE_TAIL_BYTES)} bytes of ${logPath}:\n`);
      process.stdout.write(tail.endsWith('\n') ? tail : `${tail}\n`);
    }
  }
  const logSuffix = status === 'passed' ? '' : ` — full log: ${logPath}`;
  log(`${label} ${status.toUpperCase()} in ${Math.round(elapsedMs / 1000)}s (exit ${exitCode ?? 'signal'})${logSuffix}`);

  const executedTests = summary.terminalTestCounts.length > 0
    ? summary.terminalTestCounts.reduce((a, b) => a + b, 0)
    : null;
  const skippedTests = summary.terminalTestCounts.length > 0 ? summary.skippedTests : null;
  return { shard: shardNumber, files, status, exitCode, elapsedMs, groupPid, executedTests, skippedTests, budget };
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
    if (outcome.status !== 'passed' || outcome.executedTests !== 0) return outcome;
    if (!opts.evalsAll) {
      warn(`[test:paid] WARNING: shard ${outcome.shard} passed with 0 executed tests (${outcome.files.join(' ')}) — legitimate under selection, hollow under EVALS_ALL`);
      return outcome;
    }
    return { ...outcome, status: 'passed-empty' };
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
        outcomes[index] = {
          shard: index + 1,
          files: shards[index],
          status: 'failed',
          exitCode: null,
          elapsedMs: 0,
          groupPid: null,
          executedTests: null,
          skippedTests: null,
        };
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
  /** Required when the registered Autoplan workflow is planned. */
  budget?: PaidShardBudget;
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
  /** Dedicated last slice; preceding slices retain ordinary round-robin work. */
  autoplanSlice?: number;
  entries: ManifestEntry[];
}

/**
 * Files whose old evals.yml matrix rows carried `retries: 2`, with the
 * receipts that earned them (see the deleted rows' comments). The runner
 * default stays --retry 1; membership here is a literals map so retry
 * parity with the matrix is explicit, not folklore.
 */
export const RETRY_OVERRIDES: Record<string, number> = {
  'test/skill-e2e-workflow.test.ts': 2,
  'test/skill-e2e-office-hours-auto-mode.test.ts': 2,
  'test/skill-e2e-plan-mode-no-op.test.ts': 2,
};

export function retriesForFiles(files: string[]): number {
  if (files.some(isOverlayTestFile)) return 0;
  return Math.max(1, ...files.map((f) => RETRY_OVERRIDES[normalizeRelativePath(f)] ?? 1));
}

/** Round-robin the RUNNABLE (sorted) shard plan across K slices — deterministic. */
export function buildRunManifest(opts: {
  tier: PaidTier;
  profile?: PaidProfile;
  sliceCount: number;
  evalsAll: boolean;
  dedicatedAutoplanSlice?: boolean;
  timeoutMs?: number;
  discovered?: string[];
  env?: NodeJS.ProcessEnv;
  rootDir?: string;
  changedFiles?: string[];
}): PaidRunManifest {
  if (!Number.isInteger(opts.sliceCount) || opts.sliceCount <= 0) {
    throw new Error(`--slices needs a positive integer. Received: ${opts.sliceCount}`);
  }
  if (opts.dedicatedAutoplanSlice && (opts.tier !== 'periodic' || opts.sliceCount < 2)) {
    throw new Error('Dedicated Autoplan slice requires periodic tier and at least two total slices');
  }
  const rootDir = opts.rootDir ?? ROOT;
  const env = opts.env ?? process.env;
  const profile = opts.profile ?? validatedProfile(env.EVALS_PROFILE, 'EVALS_PROFILE');
  if (profile === 'pr' && opts.tier !== 'gate') throw new Error('PR profile requires gate tier; use --profile full for periodic coverage');
  const discovered = opts.discovered ?? collectPaidTestFiles(rootDir);
  const { selected, excluded } = selectPaidTestFiles(discovered, opts.tier, rootDir, env);
  const shards = planPaidShards(selected, { maxFilesPerShard: 1 });
  const cases = computePaidCaseSelection({ profile, env, rootDir, changedFiles: opts.changedFiles });
  const fast = cases.coverage?.mode === 'pr';
  const profileShards = fast ? shards.filter(files => prProfileFileSelected(files[0], cases.selection)) : shards;
  const { runnable, skipped } = partitionShardsByDiffSelection(profileShards,
    cases.selection.e2e === null ? null : new Set(cases.selection.e2e), { rootDir });
  if (fast) for (const files of shards) {
    if (!prProfileFileSelected(files[0], cases.selection)) skipped.push({ files, reason: 'Outside the fast PR profile; retained in broad gate/periodic coverage' });
  }

  const entries: ManifestEntry[] = [];
  const overlaySlice = opts.sliceCount - (opts.dedicatedAutoplanSlice ? 1 : 0);
  const reserveOverlaySlice = overlaySlice > 1 && runnable.some(files => files.some(isOverlayTestFile));
  const ordinarySlices = overlaySlice - Number(reserveOverlaySlice);
  // Spread registered long files by supervised load. Keep one ordinary-only
  // lane when possible, so every lane does not inherit a long-workflow tail.
  // Reserved overlay and dedicated Autoplan slices retain their ownership.
  const ordinary = runnable.filter(files => !files.some(isOverlayTestFile) &&
    !(opts.dedicatedAutoplanSlice && files[0] === AUTOPLAN_CHAIN_BUDGET.file));
  const registered = ordinary.filter(files => files[0] === AUTOPLAN_CHAIN_BUDGET.file ||
    FILE_RETRY_BUDGETS.some(budget => budget.file === files[0]));
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
      let lane = 0;
      for (let index = 1; index < lanes; index++) if (loads[index] < loads[lane]) lane = index;
      allocations.set(files[0], lane + 1);
      loads[lane] += resolvePaidShardTimeoutMs(files, opts.timeoutMs);
    }
  }
  let ordinaryIndex = 0;
  runnable.forEach((files) => {
    const autoplan = files[0] === AUTOPLAN_CHAIN_BUDGET.file;
    const slice = opts.dedicatedAutoplanSlice && autoplan ? opts.sliceCount
      : files.some(isOverlayTestFile) ? overlaySlice
        : allocations.get(files[0]) ?? (ordinaryIndex++ % ordinarySlices) + 1;
    entries.push({ file: files[0], slice, status: 'planned',
      ...(autoplan || FILE_RETRY_BUDGETS.some(budget => budget.file === files[0])
        ? { budget: resolvePaidShardBudget(files, opts.timeoutMs) } : {}) });
  });
  for (const s of skipped) entries.push({ file: s.files[0], slice: 0, status: 'skipped-by-diff', reason: s.reason });
  for (const e of excluded) entries.push({ file: e.file, slice: 0, status: 'excluded', reason: e.reason });
  entries.sort((a, b) => (a.file < b.file ? -1 : 1));

  const manifest: PaidRunManifest = {
    version: 1,
    tier: opts.tier,
    evalsAll: opts.evalsAll,
    sliceCount: opts.sliceCount,
    selectionReason: cases.reason,
    profile,
    selection: cases.selection,
    ...(cases.coverage ? { prCoverage: cases.coverage } : {}),
    ...(opts.dedicatedAutoplanSlice ? { autoplanSlice: opts.sliceCount } : {}),
    entries,
  };
  return parseRunManifest(JSON.stringify(manifest));
}

export function parseRunManifest(raw: string): PaidRunManifest {
  const parsed = JSON.parse(raw) as PaidRunManifest;
  if (parsed.version !== 1) throw new Error(`unsupported manifest version: ${(parsed as { version?: unknown }).version}`);
  if (parsed.tier !== 'gate' && parsed.tier !== 'periodic') throw new Error(`manifest tier invalid: ${parsed.tier}`);
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
    if (coverage.mode === 'pr' && coverage.e2e.some(id => !(PR_PROFILE_CASE_IDS as readonly string[]).includes(id))) {
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
    if (entry.status === 'planned' && parsed.prCoverage?.mode === 'pr' && !prProfileFileSelected(entry.file, parsed.selection!)) {
      throw new Error(`manifest file is outside its PR case selection: ${entry.file}`);
    }
  }
  if (parsed.prCoverage?.mode === 'pr') {
    const required = Object.entries(PR_PROFILE_FILES).filter(([, ids]) => ids.some(id => parsed.selection!.e2e!.includes(id))).map(([file]) => file);
    if (parsed.selection!.judges!.length) required.push('test/skill-llm-eval.test.ts');
    for (const file of required) {
      if (parsed.entries.filter(entry => entry.file === file && entry.status === 'planned').length !== 1) {
        throw new Error(`PR selected cases require exactly one planned owning file: ${file}`);
      }
    }
  }
  const overlaySlice = parsed.sliceCount - (parsed.autoplanSlice !== undefined ? 1 : 0);
  const plannedOverlays = parsed.entries.filter(entry => entry.status === 'planned' && isOverlayTestFile(entry.file));
  if (plannedOverlays.some(entry => entry.slice !== overlaySlice)) {
    throw new Error('Overlay manifest entries must share the final ordinary slice to preserve one-process API admission');
  }
  if (plannedOverlays.length && overlaySlice > 1 && parsed.entries.some(entry =>
      entry.status === 'planned' && !isOverlayTestFile(entry.file) && entry.slice === overlaySlice)) {
    throw new Error('The final ordinary manifest slice is reserved for overlay files');
  }
  const autoplan = parsed.entries.filter(entry => normalizeRelativePath(entry.file) === AUTOPLAN_CHAIN_BUDGET.file);
  if (autoplan.length > 1) throw new Error('Duplicate Autoplan manifest entry');
  if (parsed.autoplanSlice !== undefined) {
    if (parsed.tier !== 'periodic' || parsed.autoplanSlice !== parsed.sliceCount || parsed.sliceCount < 2 || autoplan.length !== 1 || autoplan[0].status !== 'planned') {
      throw new Error('Dedicated Autoplan slice is missing or malformed');
    }
    for (const entry of parsed.entries.filter(entry => entry.status === 'planned')) {
      if ((entry.file === AUTOPLAN_CHAIN_BUDGET.file) !== (entry.slice === parsed.autoplanSlice)) {
        throw new Error('Dedicated Autoplan slice contains missing or unrelated work');
      }
    }
  }
  for (const entry of autoplan.filter(entry => entry.status === 'planned')) {
    if (!entry.budget) throw new Error('Autoplan manifest needs an explicit budget record; emit a fresh plan');
    const expected = resolvePaidShardBudget([entry.file], entry.budget.source === 'explicit' ? entry.budget.timeoutMs : undefined);
    if (!sameBudget(entry.budget, expected)) throw new Error('Autoplan manifest budget differs from declared policy');
  }
  for (const budget of FILE_RETRY_BUDGETS) {
    const entries = parsed.entries.filter(entry => normalizeRelativePath(entry.file) === budget.file);
    if (entries.length > 1) throw new Error(`Duplicate registered manifest entry: ${budget.file}`);
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
  outcomes: Array<Pick<ShardOutcome, 'files' | 'status' | 'exitCode' | 'elapsedMs' | 'executedTests' | 'skippedTests' | 'budget'>>;
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

  const reported = new Map<string, { slice: number; status: ShardStatus }>();
  for (const result of results) {
    for (const outcome of result.outcomes) {
      if (outcome.files.map(normalizeRelativePath).includes(AUTOPLAN_CHAIN_BUDGET.file) && outcome.files.length !== 1) {
        problems.push('Autoplan result must report its own shard');
      }
      if (outcome.files.some(file => FILE_RETRY_BUDGETS.some(budget => budget.file === normalizeRelativePath(file))) && outcome.files.length !== 1) {
        problems.push('Registered result must report its own shard');
      }
      const file = normalizeRelativePath(outcome.files[0] ?? '');
      if (manifest.prCoverage?.mode === 'pr') {
        const expected = expectedPrCaseCount(file, manifest.selection!);
        const executed = outcome.executedTests === null || outcome.skippedTests === null
          ? -1 : outcome.executedTests - outcome.skippedTests;
        if (outcome.exitCode !== 0 || expected < 1 || executed !== expected) {
          problems.push(`PR profile expected ${expected} executed cases in ${file}, received ${executed}`);
        }
      }
      if (reported.has(file)) problems.push(`${file} reported by two slices`);
      reported.set(file, { slice: result.sliceIndex, status: outcome.status });
      const registered = FILE_RETRY_BUDGETS.find(budget => budget.file === file);
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
      if (file === AUTOPLAN_CHAIN_BUDGET.file) {
        if (outcome.exitCode !== 0 || outcome.executedTests !== 1 || outcome.skippedTests !== 0) {
          problems.push('Autoplan must execute exactly one unskipped case with exit zero');
        }
        try {
          const planned = manifest.entries.find(entry => entry.file === file)?.budget;
          const expected = resolvePaidShardBudget([file], result.timeoutOverrideMs ??
            (planned?.source === 'explicit' ? planned.timeoutMs : undefined));
          if (!sameBudget(outcome.budget, expected)) problems.push('Autoplan effective result budget differs from its planned/explicit allocation');
        } catch { problems.push('Invalid Autoplan effective result budget'); }
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
    if (got.status !== 'passed') problems.push(`${entry.file}: ${got.status}`);
  }
  return { ok: problems.length === 0, problems };
}

export function formatProfileCoverage(manifest: PaidRunManifest): string[] {
  const coverage = manifest.prCoverage;
  return [
    `[test:paid] coverage: profile=${manifest.profile ?? 'full'} mode=${coverage?.mode ?? 'full'}; selected E2E=${manifest.selection?.e2e?.length ?? 'all'}, judges=${manifest.selection?.judges?.length ?? 'all'}`,
    ...(coverage ? [`[test:paid] deferred: ${coverage.deferred.length} broad behaviors, ${coverage.deferredPromptFiles.length} changed prompts without quick live coverage; these are not PR passes`] : []),
  ];
}

/** Final outcomes use each case's last attempt; the attempt total stays visible. */
export function collectorOutcomeCounts(results: Array<{ tests?: Array<{
  name: string; suite?: string; passed: boolean; execution?: string; manual_review?: unknown;
}> }>): { executed: number; reused: number; passed: number; failed: number; manual_accepted: number; attempts: number } {
  const counts = { executed: 0, reused: 0, passed: 0, failed: 0, manual_accepted: 0, attempts: 0 };
  for (const result of results) {
    const cases = new Map<string, NonNullable<typeof result.tests>[number]>();
    for (const entry of result.tests ?? []) {
      if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string' || typeof entry.passed !== 'boolean') continue;
      counts.attempts++;
      cases.set(`${entry.suite ?? ''}\0${entry.name}`, entry);
    }
    for (const entry of cases.values()) {
      counts[entry.execution === 'reused' ? 'reused' : 'executed']++;
      const outcome = evalEntryOutcome(entry);
      counts[outcome === 'manual-review' ? 'manual_accepted' : outcome]++;
    }
  }
  return counts;
}

type CliOptions = {
  tier: PaidTier;
  profile: PaidProfile;
  profileExplicit: boolean;
  listOnly: boolean;
  timeoutMs: number;
  timeoutExplicit: boolean;
  dedicatedAutoplanSlice: boolean;
  jobs: number;
  withinShardConcurrency: number;
  maxFilesPerShard: number;
  /** Planner mode: write the run manifest here and exit. */
  emitPlanPath: string | null;
  /** Slice count for --emit-plan. */
  slices: number;
  /** Executor mode: consume this manifest... */
  planPath: string | null;
  /** ...running only this 1-based slice. */
  sliceIndex: number | null;
  /** Report mode: reconcile manifest.json + slice-*.json under this dir. */
  reportDir: string | null;
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
  if (value !== 'gate' && value !== 'periodic') {
    throw new Error(`${source} must be gate or periodic. Received: ${value}`);
  }
  return value;
}

function validatedProfile(value: string | undefined, source: string): PaidProfile {
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
    timeoutExplicit: !!env.EVALS_SHARD_TIMEOUT_MS,
    dedicatedAutoplanSlice: false,
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
    planPath: null,
    sliceIndex: null,
    reportDir: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--list') { options.listOnly = true; continue; }
    if (arg === '--tier') {
      const value = argv[index += 1];
      if (value !== 'gate' && value !== 'periodic') throw new Error(`--tier must be gate or periodic. Received: ${value}`);
      options.tier = value;
      continue;
    }
    if (arg === '--profile') {
      const value = argv[index += 1];
      if (!value) throw new Error('--profile needs pr or full');
      options.profile = validatedProfile(value, '--profile'); options.profileExplicit = true; continue;
    }
    if (arg === '--timeout') { options.timeoutMs = parsePositiveInt(argv[index += 1], '--timeout') * 1000; options.timeoutExplicit = true; continue; }
    if (arg === '--autoplan-slice') { options.dedicatedAutoplanSlice = true; continue; }
    if (arg === '--jobs') { options.jobs = parsePositiveInt(argv[index += 1], '--jobs'); continue; }
    if (arg === '--files-per-shard') { options.maxFilesPerShard = parsePositiveInt(argv[index += 1], '--files-per-shard'); continue; }
    if (arg === '--emit-plan') {
      const value = argv[index += 1];
      if (!value) throw new Error('--emit-plan needs a file path');
      options.emitPlanPath = value; continue;
    }
    if (arg === '--slices') { options.slices = parsePositiveInt(argv[index += 1], '--slices'); continue; }
    if (arg === '--plan') {
      const value = argv[index += 1];
      if (!value) throw new Error('--plan needs a manifest path');
      options.planPath = value; continue;
    }
    if (arg === '--slice') { options.sliceIndex = parsePositiveInt(argv[index += 1], '--slice'); continue; }
    if (arg === '--report') {
      const value = argv[index += 1];
      if (!value) throw new Error('--report needs a directory');
      options.reportDir = value; continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.dedicatedAutoplanSlice && !options.emitPlanPath) throw new Error('--autoplan-slice requires --emit-plan');
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
      sliceCount: options.slices,
      dedicatedAutoplanSlice: options.dedicatedAutoplanSlice,
      timeoutMs: options.timeoutExplicit ? options.timeoutMs : undefined,
      evalsAll: process.env.EVALS_ALL === '1',
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
    return 0;
  }

  // ── Report mode: reconcile slice artifacts against the manifest. Fail-closed:
  // a slice whose artifact never landed is a FAILURE, not an absence.
  if (options.reportDir) {
    const summaryPath = path.join(options.reportDir, 'collector-outcomes.json');
    fs.rmSync(summaryPath, { force: true });
    const manifest = parseRunManifest(fs.readFileSync(path.join(options.reportDir, 'manifest.json'), 'utf-8'));
    const results: SliceResult[] = fs.readdirSync(options.reportDir)
      .filter((name) => /^slice-\d+\.json$/.test(name))
      .map((name) => JSON.parse(fs.readFileSync(path.join(options.reportDir, name), 'utf-8')) as SliceResult);
    const verdict = verifySliceResults(manifest, results);
    const planned = manifest.entries.filter((e) => e.status === 'planned').length;
    console.log(`[test:paid] report: ${results.length}/${manifest.sliceCount} slices, ${planned} planned shards, tier=${manifest.tier}`);
    for (const line of formatProfileCoverage(manifest)) console.log(line);
    for (const result of results.sort((a, b) => a.sliceIndex - b.sliceIndex)) {
      for (const outcome of result.outcomes) {
        console.log(`  slice ${result.sliceIndex}  ${outcome.status.padEnd(15)} ${String(Math.round(outcome.elapsedMs / 1000)).padStart(5)}s  ${outcome.files.join(' ')}`);
      }
    }
    // Historical flaky_retries includes every case with multiple attempts,
    // whether its final result passed or failed. Report attempts separately
    // from the shard verdict; reconciliation above still controls gating.
    // Source: the finalized eval-store JSONs inside the slice artifacts.
    const flaky: Array<{ name: string; attempts: number; file: string }> = [];
    const collectors: Parameters<typeof collectorOutcomeCounts>[0] = [];
    const files: Array<{ file: string; tier: string; shard: string | number; cost: number;
      flaky: number; total: number; executed: number; reused: number; passed: number;
      failed: number; manual_accepted: number; attempts: number }> = [];
    const manualProblems: string[] = [];
    const manualClaims = new Map<string, string>();
    for (const name of fs.readdirSync(options.reportDir, { recursive: true }) as string[]) {
      if (!isFinalizedEvalResultFile(name)) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(options.reportDir, name), 'utf-8'));
        if (!Array.isArray(parsed.tests)) {
          if (Object.hasOwn(parsed, 'tests') || parsed.total_tests !== undefined || parsed.manual_review !== undefined) {
            manualProblems.push(`${name}: malformed collector tests[]`);
          }
          continue;
        }
        const seen = new Map<string, number>();
        for (const [index, entry] of parsed.tests.entries()) {
          if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string' || !entry.name
            || typeof entry.passed !== 'boolean') {
            manualProblems.push(`${name}: attempt ${index + 1}: malformed collector entry (name/passed required)`);
            continue;
          }
          const key = `${entry.suite ?? ''}\0${entry.name}`;
          const occurrence = (seen.get(key) ?? 0) + 1;
          seen.set(key, occurrence);
          if (Object.hasOwn(entry, 'manual_review') && occurrence !== 1) {
            manualProblems.push(`${name}: attempt ${index + 1}: manual review is only valid on the first case attempt`);
          }
          if (Object.hasOwn(entry, 'manual_review')) {
            const previous = manualClaims.get(key);
            if (previous && previous !== name) manualProblems.push(`${name}: duplicate manual-review claim for ${entry.name} (also in ${previous})`);
            else manualClaims.set(key, name);
          }
          const problem = manualReviewProblem(entry, ROOT);
          if (problem) manualProblems.push(`${name}: attempt ${index + 1}: ${problem}`);
        }
        collectors.push(parsed);
        const counts = collectorOutcomeCounts([parsed]);
        files.push({ file: name, tier: parsed.tier ?? 'unknown', shard: parsed.shard ?? '-',
          cost: parsed.total_cost_usd ?? 0, flaky: parsed.flaky_retries?.length ?? 0,
          total: counts.passed + counts.failed + counts.manual_accepted, ...counts });
        for (const f of parsed.flaky_retries ?? []) flaky.push({ ...f, file: name });
      } catch (error) {
        manualProblems.push(`${name}: malformed collector JSON (${error instanceof Error ? error.message : String(error)})`);
      }
    }
    const evidence = collectorOutcomeCounts(collectors);
    console.log(`[test:paid] collector final outcomes: ${evidence.executed} executed, ${evidence.reused} reused; ${evidence.passed} passed, ${evidence.failed} failed, ${evidence.manual_accepted} manual accepted (unscored; no score-cache credit) (${evidence.attempts} attempt records from ${collectors.length} collectors)`);
    if (flaky.length > 0) {
      console.log(`[test:paid] report: ⚠ ${flaky.length} cases with multiple attempts this run:`);
      for (const f of flaky) console.log(`  ⚠ ${f.name} (x${f.attempts}) — ${f.file}`);
    }

    // Census honesty: a 'passed' shard whose every test skipped verified
    // nothing (external-service binary absent on the runner). Not a failure —
    // service availability is host state, not a repo regression — but the
    // report must say so, or the weekly lane reads codex/gemini as covered
    // on runners that never install them.
    const allSkipped = results.flatMap((r) => r.outcomes.filter(isAllSkippedPass));
    if (allSkipped.length > 0) {
      console.log(`[test:paid] report: ⚠ ${allSkipped.length} shard(s) passed with EVERY test skipped — they verified nothing:`);
      for (const outcome of allSkipped) {
        console.log(`  ⚠ ${outcome.files.join(' ')} (${outcome.executedTests} skipped — external service missing or tier mismatch)`);
      }
    }
    if (manualProblems.length) verdict.problems.push(...manualProblems);
    if (evidence.failed > 0) verdict.problems.push(`${evidence.failed} unapproved final collector failure(s)`);
    if (files.reduce((sum, file) => sum + file.total, 0) !== evidence.passed + evidence.failed + evidence.manual_accepted
      || files.reduce((sum, file) => sum + file.executed + file.reused, 0) !== evidence.executed + evidence.reused) {
      verdict.problems.push('Collector summary totals are inconsistent');
    }
    if (!manualProblems.length) fs.writeFileSync(summaryPath, JSON.stringify({ version: 1, files, totals: {
      ...evidence, total: evidence.passed + evidence.failed + evidence.manual_accepted,
      flaky: files.reduce((sum, file) => sum + file.flaky, 0),
    } }, null, 2) + '\n');
    if (verdict.problems.length) {
      console.error(`[test:paid] report: ${verdict.problems.length} problem(s):`);
      for (const problem of verdict.problems) console.error(`  ✗ ${problem}`);
      return 1;
    }
    console.log(evidence.manual_accepted
      ? `[test:paid] report: every planned shard accounted; ${evidence.manual_accepted} manual acceptance(s), no automated-score credit`
      : '[test:paid] report: every planned shard accounted and passed');
    return 0;
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
    const mine = manifest.entries.filter((e) => e.status === 'planned' && e.slice === options.sliceIndex);
    const shards = mine.map((e) => [e.file]);
    for (const files of shards) resolvePaidShardTimeoutMs(files, timeoutOverride);
    console.log(`[test:paid] slice ${options.sliceIndex}/${manifest.sliceCount}: ${shards.length} shard(s), tier=${manifest.tier}, evalsAll=${manifest.evalsAll}`);

    const evalDirBase = process.env.GSTACK_EVAL_DIR || getProjectEvalDir();
    let summary: RunSummary;
    if (shards.length === 0) {
      summary = summarize([]);
    } else {
      preflightAnthropicApi(process.env);
      summary = await runPaidShards(shards, {
        timeoutMs: options.timeoutExplicit ? options.timeoutMs : undefined,
        jobs: options.jobs,
        withinShardConcurrency: options.withinShardConcurrency,
        autoplanBudget: mine.find(entry => entry.file === AUTOPLAN_CHAIN_BUDGET.file)?.budget,
        registeredBudgets: Object.fromEntries(mine.filter(entry => entry.budget).map(entry => [normalizeRelativePath(entry.file), entry.budget!])),
        ...(manifest.prCoverage?.mode === 'pr' ? {
          expectedCases: Object.fromEntries(mine.map(entry => [entry.file, expectedPrCaseCount(entry.file, manifest.selection!)])),
          casePatterns: Object.fromEntries(mine.map(entry => [entry.file, prProfileTestNamePattern(entry.file, manifest.selection!)])),
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
    const guarded = applyHollowShardGuard(summary.outcomes, { evalsAll: manifest.evalsAll, requireExecuted: manifest.prCoverage?.mode === 'pr' });
    summary = summarize(guarded);
    const sliceResult: SliceResult = {
      version: 1,
      tier: manifest.tier,
      profile,
      ...(manifest.selection ? { selection: manifest.selection } : {}),
      sliceIndex: options.sliceIndex,
      sliceCount: manifest.sliceCount,
      ...(options.timeoutExplicit ? { timeoutOverrideMs: options.timeoutMs } : {}),
      outcomes: guarded.map(({ files, status, exitCode, elapsedMs, executedTests, skippedTests, budget }) =>
        ({ files, status, exitCode, elapsedMs, executedTests, skippedTests, ...(budget ? { budget } : {}) })),
    };
    fs.mkdirSync(evalDirBase, { recursive: true });
    const sliceResultPath = path.join(evalDirBase, `slice-${options.sliceIndex}.json`);
    fs.writeFileSync(sliceResultPath, `${JSON.stringify(sliceResult, null, 2)}\n`);
    console.log(`[test:paid] slice result: ${sliceResultPath}`);
    for (const line of formatSummary(summary)) console.log(line);
    return summaryExitCode(summary);
  }

  const { selected, excluded } = selectPaidTestFiles(discovered, options.tier);
  const shards = planPaidShards(selected, { maxFilesPerShard: options.maxFilesPerShard });

  // Parent-side diff selection (D9): skip whole shards whose mapped tests are
  // all unselected. Fail-open everywhere — the child's self-skip stays
  // authoritative for anything the mapper can't attribute.
  const cases = computePaidCaseSelection({ profile: options.profile });
  const fast = cases.coverage?.mode === 'pr';
  const profileShards = fast ? shards.filter(files => files.some(file => prProfileFileSelected(file, cases.selection))) : shards;
  const { runnable, skipped } = partitionShardsByDiffSelection(profileShards,
    cases.selection.e2e === null ? null : new Set(cases.selection.e2e));
  if (fast) for (const files of shards) {
    if (!files.some(file => prProfileFileSelected(file, cases.selection))) skipped.push({ files, reason: 'Outside the fast PR profile; retained in broad coverage' });
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
      console.log(`  shard ${index + 1}/${shards.length}: ${key} wall=${budget.timeoutMs}ms source=${budget.source} policy=${budget.policyId ?? 'none'}${note}`);
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
    ...(fast ? {
      expectedCases: Object.fromEntries(runnable.flat().map(file => [file, expectedPrCaseCount(file, cases.selection)])),
      casePatterns: Object.fromEntries(runnable.flat().map(file => [file, prProfileTestNamePattern(file, cases.selection)])),
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
  const guardedOutcomes = applyHollowShardGuard(runSummary.outcomes, {
    evalsAll: process.env.EVALS_ALL === '1',
    requireExecuted: fast,
  });
  const summary = summarize([...guardedOutcomes, ...skippedOutcomes]);
  for (const line of formatSummary(summary)) console.log(line);
  return summaryExitCode(summary);
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(`[test:paid] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
