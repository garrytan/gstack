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

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizeRelativePath } from './test-free-shards';
import {
  BunTestOutputClassifier,
  exactTestFileSelectors,
  forwardAndClassify,
  installChildSignalForwarding,
  isTerminationRequested,
  killProcessGroup,
  strictTestExitCode,
} from './test-strict-output';
import { PAID_TEST_GLOBS, isPaidTestFile } from '../test/helpers/paid-test-set';
import { getProjectEvalDir } from '../test/helpers/eval-store';
import { preflightAnthropicApi } from '../test/helpers/anthropic-preflight';
import {
  detectBaseBranch,
  getChangedFiles,
  selectTests,
  E2E_TOUCHFILES,
  E2E_TIERS,
  GLOBAL_TOUCHFILES,
} from '../test/helpers/touchfiles';

export { PAID_TEST_GLOBS, isPaidTestFile };

const ROOT = path.resolve(import.meta.dir, '..');

export type PaidTier = 'gate' | 'periodic';

export const DEFAULT_TIER: PaidTier = 'gate';
export const DEFAULT_SHARD_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_MAX_FILES_PER_SHARD = 1;
export const DEFAULT_JOBS = 4;
// Within one shard's bun process. 4 jobs × 4 ≈ the legacy single-process
// default of 15, keeping total in-flight `claude` sessions inside known-safe
// API rate headroom.
export const DEFAULT_WITHIN_SHARD_CONCURRENCY = 4;

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

export function selectPaidTestFiles(files: string[], tier: PaidTier, rootDir = ROOT): TierSelection {
  const selected: string[] = [];
  const excluded: Array<{ file: string; reason: string }> = [];
  for (const file of files) {
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
  for (let index = 0; index < unique.length; index += size) shards.push(unique.slice(index, index + size));
  return shards;
}

export function buildPaidShardArgs(
  files: string[],
  timeoutMs: number,
  maxConcurrency: number = DEFAULT_WITHIN_SHARD_CONCURRENCY,
): string[] {
  // Explicit --concurrent/--max-concurrency: the legacy path always set one;
  // omitting it here made within-shard parallelism differ silently between
  // the two runners (observed: 1.6x sumdur/wall sharded vs 8x legacy).
  return ['test', ...files, '--retry', '1', '--concurrent', `--max-concurrency=${maxConcurrency}`, `--timeout=${timeoutMs}`];
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

export type ShardStatus = 'passed' | 'failed' | 'timed-out' | 'never-started' | 'skipped-by-diff';

export interface ShardOutcome {
  shard: number;
  files: string[];
  status: ShardStatus;
  exitCode: number | null;
  elapsedMs: number;
  groupPid: number | null;
}

export interface ShardCommand {
  command: string;
  args: string[];
}

export interface RunShardsOptions {
  timeoutMs?: number;
  jobs?: number;
  /** bun --max-concurrency inside each shard (EVALS_CONCURRENCY). */
  withinShardConcurrency?: number;
  rootDir?: string;
  env?: NodeJS.ProcessEnv;
  /** When set, each shard child gets GSTACK_EVAL_DIR=<evalDirBase>/shards/<slug>/. */
  evalDirBase?: string;
  /** Override the spawned command. Tests inject fake slow/spinning commands. */
  commandFor?: (files: string[]) => ShardCommand;
  log?: (line: string) => void;
}

export async function runPaidShard(
  files: string[],
  shardNumber: number,
  totalShards: number,
  options: RunShardsOptions = {},
): Promise<ShardOutcome> {
  if (files.length === 0) throw new Error('Cannot run an empty paid-test shard.');
  const rootDir = options.rootDir ?? ROOT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SHARD_TIMEOUT_MS;
  const streamLive = (options.jobs ?? DEFAULT_JOBS) === 1;
  const log = options.log ?? ((line: string) => console.log(line));
  const label = `[test:paid] shard ${shardNumber}/${totalShards}`;

  const { command, args } = options.commandFor
    ? options.commandFor(files)
    : {
      command: process.execPath,
      args: buildPaidShardArgs(
        exactTestFileSelectors(files, rootDir),
        timeoutMs,
        options.withinShardConcurrency ?? DEFAULT_WITHIN_SHARD_CONCURRENCY,
      ),
    };

  const env = { ...(options.env ?? process.env) };
  if (options.evalDirBase) {
    env.GSTACK_EVAL_DIR = path.join(options.evalDirBase, 'shards', shardSlug(files));
  }

  const startedAt = Date.now();
  log(`${label} START ${files.join(' ')} (timeout ${Math.round(timeoutMs / 1000)}s)`);

  const child = spawn(command, args, {
    cwd: rootDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  const groupPid = child.pid ?? null;
  // Group-kill on parent SIGINT/SIGTERM too, not just on timeout.
  const forwarding = installChildSignalForwarding({
    kill: (signal?: NodeJS.Signals | number) => {
      killProcessGroup(child, (signal as NodeJS.Signals) ?? 'SIGTERM');
      return true;
    },
  });

  const classifier = new BunTestOutputClassifier();
  const buffered: Buffer[] = [];
  const sink = (destination: NodeJS.WriteStream): NodeJS.WriteStream => (streamLive
    ? destination
    : ({ write: (chunk: Buffer | string) => buffered.push(Buffer.from(chunk)) } as unknown as NodeJS.WriteStream));

  let timedOut = false;
  const killTimer = setTimeout(() => {
    timedOut = true;
    killProcessGroup(child, 'SIGKILL');
  }, timeoutMs);

  let exitCode: number | null = null;
  try {
    const streams: Array<Promise<void>> = [];
    if (child.stdout) streams.push(forwardAndClassify(child.stdout, sink(process.stdout), classifier, 'stdout'));
    if (child.stderr) streams.push(forwardAndClassify(child.stderr, sink(process.stderr), classifier, 'stderr'));
    exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code));
    });
    await Promise.all(streams);
  } finally {
    clearTimeout(killTimer);
    forwarding.dispose();
    // Reap survivors of this shard even on the clean path.
    killProcessGroup(child, 'SIGKILL');
  }

  const summary = classifier.end();
  if (!streamLive && buffered.length > 0) process.stdout.write(Buffer.concat(buffered));

  // Pass expectedFiles so a shard whose bun child ran fewer files than planned
  // (or zero, all self-skipped) with exit 0 is NOT recorded 'passed' — the
  // invisible-non-execution class this runner exists to kill. bun prints
  // "Ran N tests across M files" with M = selected files even when every test
  // self-skips, so terminalFileCounts must include files.length. Only enforced
  // on the real bun path: an injected commandFor (tests) isn't bun and emits no
  // terminal summary, so there's no file count to check against.
  const expectedFiles = options.commandFor ? undefined : files.length;
  const status: ShardStatus = timedOut
    ? 'timed-out'
    : strictTestExitCode(exitCode ?? 1, summary, expectedFiles) === 0 ? 'passed' : 'failed';
  const elapsedMs = Date.now() - startedAt;
  log(`${label} ${status.toUpperCase()} in ${Math.round(elapsedMs / 1000)}s (exit ${exitCode ?? 'signal'})`);

  return { shard: shardNumber, files, status, exitCode, elapsedMs, groupPid };
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
    failed: count('failed'),
    timedOut: count('timed-out'),
    neverStarted: count('never-started'),
    skippedByDiff: count('skipped-by-diff'),
    outcomes,
  };
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
  }));

  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      // Cancellation (SIGINT/SIGTERM) must stop the RUN: the signal
      // forwarders kill in-flight children, and this guard stops the pool
      // from launching replacement shards that would keep burning API spend.
      if (isTerminationRequested()) return;
      const index = next;
      next += 1;
      if (index >= shards.length) return;
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
        };
        console.error(`[test:paid] shard ${index + 1} could not run: ${error instanceof Error ? error.message : String(error)}`);
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
    lines.push(
      `  ${outcome.status.padEnd(15)} ${String(Math.round(outcome.elapsedMs / 1000)).padStart(5)}s  `
      + outcome.files.join(' '),
    );
  }
  return lines;
}

type CliOptions = {
  tier: PaidTier;
  listOnly: boolean;
  timeoutMs: number;
  jobs: number;
  withinShardConcurrency: number;
  maxFilesPerShard: number;
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

export function parseCliOptions(argv: string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  const options: CliOptions = {
    tier: validatedTier(env.EVALS_TIER, 'EVALS_TIER'),
    listOnly: false,
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
    if (arg === '--timeout') { options.timeoutMs = parsePositiveInt(argv[index += 1], '--timeout') * 1000; continue; }
    if (arg === '--jobs') { options.jobs = parsePositiveInt(argv[index += 1], '--jobs'); continue; }
    if (arg === '--files-per-shard') { options.maxFilesPerShard = parsePositiveInt(argv[index += 1], '--files-per-shard'); continue; }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function main(): Promise<number> {
  const options = parseCliOptions(process.argv.slice(2));
  const discovered = collectPaidTestFiles();
  if (discovered.length === 0) throw new Error('No paid test files were discovered.');

  const { selected, excluded } = selectPaidTestFiles(discovered, options.tier);
  const shards = planPaidShards(selected, { maxFilesPerShard: options.maxFilesPerShard });

  // Parent-side diff selection (D9): skip whole shards whose mapped tests are
  // all unselected. Fail-open everywhere — the child's self-skip stays
  // authoritative for anything the mapper can't attribute.
  const diffSelection = computePaidDiffSelection(process.env);
  const { runnable, skipped } = partitionShardsByDiffSelection(shards, diffSelection.selectedNames);
  const selectedCount = diffSelection.selectedNames
    ? diffSelection.selectedNames.size
    : diffSelection.totalTests;
  console.log(
    `[test:paid] selection: selected ${selectedCount} of ${diffSelection.totalTests} tests -> `
    + `running ${runnable.length} of ${shards.length} shards, reason: ${diffSelection.reason}`,
  );
  console.log(
    `[test:paid] tier=${options.tier}: ${selected.length}/${discovered.length} files, `
    + `${shards.length} shards, jobs=${options.jobs}, timeout=${Math.round(options.timeoutMs / 1000)}s`,
  );

  if (options.listOnly) {
    const skipReasons = new Map(skipped.map((s) => [s.files.join(' '), s.reason]));
    for (let index = 0; index < shards.length; index += 1) {
      const key = shards[index].join(' ');
      const note = skipReasons.has(key) ? `  [would skip: ${skipReasons.get(key)}]` : '';
      console.log(`  shard ${index + 1}/${shards.length}: ${key}${note}`);
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
  if (runnable.length > 0) preflightAnthropicApi(process.env);

  const runSummary = await runPaidShards(runnable, {
    // Tier reaches the children only via EVALS_TIER below; the runtime
    // E2E_TIERS filter inside each child is the real selection mechanism.
    timeoutMs: options.timeoutMs,
    jobs: options.jobs,
    withinShardConcurrency: options.withinShardConcurrency,
    env: { ...process.env, EVALS: '1', EVALS_TIER: options.tier, EVALS_PREFLIGHT_OK: '1' },
    evalDirBase: process.env.GSTACK_EVAL_DIR || getProjectEvalDir(),
  });
  const skippedOutcomes: ShardOutcome[] = skipped.map((s, index) => ({
    shard: runnable.length + index + 1,
    files: s.files,
    status: 'skipped-by-diff',
    exitCode: null,
    elapsedMs: 0,
    groupPid: null,
  }));
  const summary = summarize([...runSummary.outcomes, ...skippedOutcomes]);
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
