/**
 * Paid-lane selection and shard planning: tier classification, diff/PR case selection, shard keys, budgets and
 * supervision bounds. Moved from scripts/test-paid-shards.ts; imports only leaf modules (no import cycle).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalizeRelativePath } from './shard-engine';
import { isPaidTestFile } from '../../test/helpers/paid-test-set';
import { PERIODIC_CI_EXCLUDE } from '../../test/helpers/periodic-exclude-data';
import { FILE_RETRY_BUDGETS } from '../../test/helpers/eval-budgets';
import { OVERLAY_MIN_FILE_WALL_MS } from '../../test/helpers/overlay-case-policy';
import { PR_PROFILE_FILES, packageChangeOnlyVersion, selectPrProfile, type PrProfileSelection } from '../test-pr-profile';
import { detectBaseBranch, getChangedFiles, selectTests, E2E_TOUCHFILES, E2E_TIERS, LLM_JUDGE_TOUCHFILES, GLOBAL_TOUCHFILES } from '../../test/helpers/touchfiles';
import { caseTestNamePattern, fileCaseRegistration, shardCaseId, shardFile, shardTrial } from './paid-cases';
import { DEFAULT_MAX_FILES_PER_SHARD, DEFAULT_SHARD_TIMEOUT_MS, DEFAULT_WITHIN_SHARD_CONCURRENCY, PAID_TIERS, ROOT, isOverlayTestFile,
  type PaidCaseSelection, type PaidProfile, type PaidShardBudget, type PaidTier, type ShardOutcome } from './paid-types';

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
 * declares the marathon tier or registers a marathon-tier case. When its source
 * names some registered ids, only those count: another case's touchfile entry
 * is a dependency, not a registration (W2f:
 * plan-decision-classification is a dependency of the marathon
 * plan-ceo-split-overflow case and planned a hollow marathon shard). Files
 * without marathon work never cost a marathon runner, and gate/periodic files
 * never gain a third execution.
 */
export function marathonSkipReason(
  file: string, source: string,
  touchfiles: Record<string, string[]> = E2E_TOUCHFILES,
  tiers: Record<string, string> = E2E_TIERS,
): string | null {
  if (classifyPaidTestFile(source, 'marathon').reason === "declares tier 'marathon'") return null;
  const { registered } = fileCaseRegistration(file, source, touchfiles, tiers);
  // When the source names some of its registered ids, those are its own cases; the rest are cases that merely depend on it.
  const named = registered.filter(id => knownTestNamesInSource(source, [id]).length > 0);
  return (named.length ? named : registered).some(id => tiers[id] === 'marathon')
    ? null : 'skipped: declares no marathon tier and registers no marathon case';
}

export interface TierSelection {
  selected: string[];
  excluded: Array<{ file: string; reason: string }>;
}

export function selectPaidTestFiles(files: string[], tier: PaidTier, rootDir = ROOT): TierSelection {
  const selected: string[] = [];
  const excluded: Array<{ file: string; reason: string }> = [];
  // Scheduled-lane exclusions (documented-red / manual-hardware files): a
  // known-red weekly shard is triage waste locally AND in CI, so the list
  // applies to every periodic and marathon run, with the reason surfaced per file.
  const ciExcluded = (file: string): { reason: string; tracking: string } | undefined =>
    tier !== 'gate' ? PERIODIC_CI_EXCLUDE[normalizeRelativePath(file)] : undefined;
  for (const file of files) {
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
export function prProfileShardIds(key: string, selection: PaidCaseSelection, exclude: readonly string[] = []): string[] {
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

export function validatedProfile(value: string | undefined, source: string): PaidProfile {
  if (value === undefined || value === '') return 'full';
  if (value !== 'pr' && value !== 'full') throw new Error(`${source} must be pr or full. Received: ${value}`);
  return value;
}
