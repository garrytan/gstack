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
import { getProjectEvalDir, getClaudeCliVersion, isFinalizedEvalResultFile } from '../test/helpers/eval-store';
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
export { PERIODIC_CI_EXCLUDE };

const ROOT = path.resolve(import.meta.dir, '..');

export type PaidTier = 'gate' | 'periodic';

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
  // Periodic-lane exclusions (documented-red / manual-hardware files): a
  // known-red weekly shard is triage waste locally AND in CI, so the list
  // applies to every periodic run, with the reason surfaced per file.
  const ciExcluded = (file: string): { reason: string; tracking: string } | undefined =>
    tier === 'periodic' ? PERIODIC_CI_EXCLUDE[normalizeRelativePath(file)] : undefined;
  for (const file of files) {
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

export interface RunShardsOptions {
  timeoutMs?: number;
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
        retriesForFiles(files),
      ),
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
  log(`${label} START ${files.join(' ')} (timeout ${Math.round(timeoutMs / 1000)}s)`);

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
  const status: ShardStatus = timedOut
    ? 'timed-out'
    : strictTestExitCode(exitCode ?? 1, summary, expectedFiles) === 0 ? 'passed' : 'failed';
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
  return { shard: shardNumber, files, status, exitCode, elapsedMs, groupPid, executedTests, skippedTests };
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
  opts: { evalsAll: boolean; warn?: (line: string) => void },
): ShardOutcome[] {
  const warn = opts.warn ?? ((line: string) => console.error(line));
  return outcomes.map((outcome) => {
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
          executedTests: null,
          skippedTests: null,
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
}

export interface PaidRunManifest {
  version: 1;
  tier: PaidTier;
  evalsAll: boolean;
  sliceCount: number;
  selectionReason: string;
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
  return Math.max(1, ...files.map((f) => RETRY_OVERRIDES[normalizeRelativePath(f)] ?? 1));
}

/** Round-robin the RUNNABLE (sorted) shard plan across K slices — deterministic. */
export function buildRunManifest(opts: {
  tier: PaidTier;
  sliceCount: number;
  evalsAll: boolean;
  discovered?: string[];
  env?: NodeJS.ProcessEnv;
  rootDir?: string;
}): PaidRunManifest {
  if (!Number.isInteger(opts.sliceCount) || opts.sliceCount <= 0) {
    throw new Error(`--slices needs a positive integer. Received: ${opts.sliceCount}`);
  }
  const rootDir = opts.rootDir ?? ROOT;
  const discovered = opts.discovered ?? collectPaidTestFiles(rootDir);
  const { selected, excluded } = selectPaidTestFiles(discovered, opts.tier, rootDir);
  const shards = planPaidShards(selected, { maxFilesPerShard: 1 });
  const diffSelection = computePaidDiffSelection(opts.env ?? process.env);
  const { runnable, skipped } = partitionShardsByDiffSelection(shards, diffSelection.selectedNames);

  const entries: ManifestEntry[] = [];
  runnable.forEach((files, index) => {
    entries.push({ file: files[0], slice: (index % opts.sliceCount) + 1, status: 'planned' });
  });
  for (const s of skipped) entries.push({ file: s.files[0], slice: 0, status: 'skipped-by-diff', reason: s.reason });
  for (const e of excluded) entries.push({ file: e.file, slice: 0, status: 'excluded', reason: e.reason });
  entries.sort((a, b) => (a.file < b.file ? -1 : 1));

  return {
    version: 1,
    tier: opts.tier,
    evalsAll: opts.evalsAll,
    sliceCount: opts.sliceCount,
    selectionReason: diffSelection.reason,
    entries,
  };
}

export function parseRunManifest(raw: string): PaidRunManifest {
  const parsed = JSON.parse(raw) as PaidRunManifest;
  if (parsed.version !== 1) throw new Error(`unsupported manifest version: ${(parsed as { version?: unknown }).version}`);
  if (parsed.tier !== 'gate' && parsed.tier !== 'periodic') throw new Error(`manifest tier invalid: ${parsed.tier}`);
  if (!Number.isInteger(parsed.sliceCount) || parsed.sliceCount <= 0) throw new Error('manifest sliceCount invalid');
  if (!Array.isArray(parsed.entries)) throw new Error('manifest entries missing');
  for (const entry of parsed.entries) {
    if (typeof entry.file !== 'string' || !Number.isInteger(entry.slice)) throw new Error('manifest entry malformed');
    if (!['planned', 'skipped-by-diff', 'excluded'].includes(entry.status)) throw new Error(`manifest entry status invalid: ${entry.status}`);
    if (entry.status === 'planned' && (entry.slice < 1 || entry.slice > parsed.sliceCount)) {
      throw new Error(`planned entry ${entry.file} has out-of-range slice ${entry.slice}`);
    }
  }
  return parsed;
}

export interface SliceResult {
  version: 1;
  tier: PaidTier;
  sliceIndex: number;
  sliceCount: number;
  outcomes: Array<Pick<ShardOutcome, 'files' | 'status' | 'exitCode' | 'elapsedMs' | 'executedTests' | 'skippedTests'>>;
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
  const byIndex = new Map<number, SliceResult>();
  for (const result of results) {
    if (result.version !== 1) { problems.push(`slice result with unsupported version: ${String(result.version)}`); continue; }
    if (result.tier !== manifest.tier) problems.push(`slice ${result.sliceIndex} ran tier ${result.tier}, manifest says ${manifest.tier}`);
    if (byIndex.has(result.sliceIndex)) problems.push(`duplicate result for slice ${result.sliceIndex}`);
    byIndex.set(result.sliceIndex, result);
  }
  for (let index = 1; index <= manifest.sliceCount; index += 1) {
    if (!byIndex.has(index)) problems.push(`slice ${index}/${manifest.sliceCount} reported NO result — cancelled/crashed executor, not a pass`);
  }

  const reported = new Map<string, { slice: number; status: ShardStatus }>();
  for (const result of results) {
    for (const outcome of result.outcomes) {
      const file = normalizeRelativePath(outcome.files[0] ?? '');
      if (reported.has(file)) problems.push(`${file} reported by two slices`);
      reported.set(file, { slice: result.sliceIndex, status: outcome.status });
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

type CliOptions = {
  tier: PaidTier;
  listOnly: boolean;
  timeoutMs: number;
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
    if (arg === '--timeout') { options.timeoutMs = parsePositiveInt(argv[index += 1], '--timeout') * 1000; continue; }
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
  return options;
}

async function main(): Promise<number> {
  const options = parseCliOptions(process.argv.slice(2));

  // ── Planner mode: compute selection + the slice plan ONCE, write it, exit.
  if (options.emitPlanPath) {
    const manifest = buildRunManifest({
      tier: options.tier,
      sliceCount: options.slices,
      evalsAll: process.env.EVALS_ALL === '1',
    });
    fs.mkdirSync(path.dirname(path.resolve(options.emitPlanPath)), { recursive: true });
    fs.writeFileSync(options.emitPlanPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const planned = manifest.entries.filter((e) => e.status === 'planned').length;
    const skipped = manifest.entries.filter((e) => e.status === 'skipped-by-diff').length;
    const excludedCount = manifest.entries.filter((e) => e.status === 'excluded').length;
    console.log(
      `[test:paid] plan: tier=${manifest.tier} evalsAll=${manifest.evalsAll} — `
      + `${planned} planned across ${manifest.sliceCount} slice(s), ${skipped} skipped by diff, `
      + `${excludedCount} excluded (${manifest.selectionReason})`,
    );
    return 0;
  }

  // ── Report mode: reconcile slice artifacts against the manifest. Fail-closed:
  // a slice whose artifact never landed is a FAILURE, not an absence.
  if (options.reportDir) {
    const manifest = parseRunManifest(fs.readFileSync(path.join(options.reportDir, 'manifest.json'), 'utf-8'));
    const results: SliceResult[] = fs.readdirSync(options.reportDir)
      .filter((name) => /^slice-\d+\.json$/.test(name))
      .map((name) => JSON.parse(fs.readFileSync(path.join(options.reportDir, name), 'utf-8')) as SliceResult);
    const verdict = verifySliceResults(manifest, results);
    const planned = manifest.entries.filter((e) => e.status === 'planned').length;
    console.log(`[test:paid] report: ${results.length}/${manifest.sliceCount} slices, ${planned} planned shards, tier=${manifest.tier}`);
    for (const result of results.sort((a, b) => a.sliceIndex - b.sliceIndex)) {
      for (const outcome of result.outcomes) {
        console.log(`  slice ${result.sliceIndex}  ${outcome.status.padEnd(15)} ${String(Math.round(outcome.elapsedMs / 1000)).padStart(5)}s  ${outcome.files.join(' ')}`);
      }
    }
    if (!verdict.ok) {
      console.error(`[test:paid] report: ${verdict.problems.length} problem(s):`);
      for (const problem of verdict.problems) console.error(`  ✗ ${problem}`);
      return 1;
    }
    // Flake honesty (WS1): surface every test that needed a retry to pass.
    // WARNS, never fails — a flaky pass must not block merges; it must also
    // never be invisible (bun's own output hides retried passes entirely).
    // Source: the finalized eval-store JSONs inside the slice artifacts.
    const flaky: Array<{ name: string; attempts: number; file: string }> = [];
    for (const name of fs.readdirSync(options.reportDir, { recursive: true }) as string[]) {
      if (!isFinalizedEvalResultFile(name)) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(options.reportDir, name), 'utf-8')) as { flaky_retries?: Array<{ name: string; attempts: number }> };
        for (const f of parsed.flaky_retries ?? []) flaky.push({ ...f, file: name });
      } catch { /* non-eval JSON — not this report's business */ }
    }
    if (flaky.length > 0) {
      console.log(`[test:paid] report: ⚠ ${flaky.length} test(s) passed only on retry this run (recorded, not blocking):`);
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
    console.log('[test:paid] report: every planned shard accounted and passed');
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
    if (options.sliceIndex > manifest.sliceCount) {
      throw new Error(`--slice ${options.sliceIndex} exceeds manifest sliceCount ${manifest.sliceCount}`);
    }
    const mine = manifest.entries.filter((e) => e.status === 'planned' && e.slice === options.sliceIndex);
    const shards = mine.map((e) => [e.file]);
    console.log(`[test:paid] slice ${options.sliceIndex}/${manifest.sliceCount}: ${shards.length} shard(s), tier=${manifest.tier}, evalsAll=${manifest.evalsAll}`);

    const evalDirBase = process.env.GSTACK_EVAL_DIR || getProjectEvalDir();
    let summary: RunSummary;
    if (shards.length === 0) {
      summary = summarize([]);
    } else {
      preflightAnthropicApi(process.env);
      summary = await runPaidShards(shards, {
        timeoutMs: options.timeoutMs,
        jobs: options.jobs,
        withinShardConcurrency: options.withinShardConcurrency,
        env: {
          ...process.env,
          EVALS: '1',
          EVALS_TIER: options.tier,
          ...(manifest.evalsAll ? { EVALS_ALL: '1' } : {}),
          EVALS_PREFLIGHT_OK: '1',
          // The manifest IS the selection: children must not re-derive a
          // possibly-different one from their own git view.
          EVALS_SELECTION_JSON: JSON.stringify({ version: 1, selected: null, reason: `manifest slice ${options.sliceIndex}: ${manifest.selectionReason}` }),
        },
        evalDirBase,
      });
    }
    const guarded = applyHollowShardGuard(summary.outcomes, { evalsAll: manifest.evalsAll });
    summary = summarize(guarded);
    const sliceResult: SliceResult = {
      version: 1,
      tier: manifest.tier,
      sliceIndex: options.sliceIndex,
      sliceCount: manifest.sliceCount,
      outcomes: guarded.map(({ files, status, exitCode, elapsedMs, executedTests, skippedTests }) =>
        ({ files, status, exitCode, elapsedMs, executedTests, skippedTests })),
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
    env: {
      ...process.env,
      EVALS: '1',
      EVALS_TIER: options.tier,
      EVALS_PREFLIGHT_OK: '1',
      // The parent's selection, computed once above — children's e2e-helpers
      // module load adopts it instead of re-deriving per shard (which spawned
      // a bun subprocess per child on the touchfiles-data map-diff path).
      // Children fall back to local derivation on any parse failure.
      EVALS_SELECTION_JSON: serializePaidDiffSelection(diffSelection),
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
