/**
 * Sub-shards inside one CI job: `--ci-run <plan> --shard i --result r --jobs k`
 * (GSTA-203 PR 2, principle "buy cores, not shards").
 *
 * A CI shard's files split into k disjoint, identity-bound sub-shards that run
 * side by side through the free runner's own process-shard path (one bun child
 * each, serial inside, own sandbox, group kill, log), never Bun's worker
 * `--parallel` (decision V3/D6 in scripts/test-free-shards.ts). The rules:
 *
 *   - k = 1 (the default) is today's single child, unchanged.
 *   - Files in TREE_MUTATING or SLOW_UNDER_LOAD run after the parallel
 *     sub-shards settle, serially, in one trailing sub-shard.
 *   - The parallel phase uses the concurrent-phase home guard; every child
 *     uses the shared guard inside it, exactly as full-suite mode does.
 *   - The whole CI shard keeps its k = 1 wall: the parallel sub-shards get it,
 *     and the serial sub-shard gets what is left of it, so k never extends a
 *     deadline; every launched child settles before the parent goes on.
 *   - The parent merges every sub-shard result before the single retry pass,
 *     so the five-file retry cap stays per CI shard; a missing, duplicate or
 *     incomplete sub-shard result fails the shard.
 *   - Sub-shard runs never write the duration seed (only `--record-durations`
 *     does, from one-file children).
 *
 * Per-file test and expect() counts come from bun's JUnit reporter, which
 * attributes both per file inside a multi-file child on the pinned Bun 1.4.2
 * (the console stream is byte-identical with or without it). Counts are
 * evidence for k > 1 comparisons; they never decide a verdict.
 */
import * as os from 'node:os';
import type { FreeCiPlan, FreeCiResult, FreeShardOutcome } from '../test-free-shards';
import { guardFreeHome, sharedFreeHome, type FreeHomeGuard, type FreeHomeGuardFactory } from './free-home-guard';
import { normalizeRelativePath } from './shard-engine';

/**
 * Files that pass alone but time out as a sub-shard under load. Each entry
 * names the CI run id where it timed out (FREE_SUBSHARD_TIMEOUT prints it).
 * They run in the trailing serial sub-shard under `--jobs`; at k = 1 nothing
 * changes. Keys are pinned against the live file census by
 * test/shard-jobs.test.ts. Never raise a timeout instead of adding an entry.
 */
export const SLOW_UNDER_LOAD: Record<string, { reason: string; runId: string }> = {};

export const FREE_JOBS_INVALID = 'FREE_JOBS_INVALID';
export const FREE_SUBSHARD_TIMEOUT = 'FREE_SUBSHARD_TIMEOUT';
export const FREE_SUBSHARD_REJECTED = 'FREE_SUBSHARD_REJECTED';
const DOCS = 'docs/TESTING_INTERNALS.md#sub-shards-inside-one-ci-job';
const JOBS_FIX = `--jobs applies only to --ci-run and defaults to 1; GSTACK_FREE_JOBS sets the local full-suite process count and never changes --ci-run. See ${DOCS}`;

/** `--jobs <k>` at parse time: digits only, at least 1. */
export function parseJobsFlag(raw: string | undefined): number {
  if (raw === undefined || !/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new Error(`${FREE_JOBS_INVALID}: --jobs needs a positive whole number; got ${JSON.stringify(raw ?? '')}. ${JOBS_FIX}`);
  }
  return Number(raw);
}

export function rejectJobsWithoutCiRun(): never {
  throw new Error(`${FREE_JOBS_INVALID}: --jobs needs --ci-run. ${JOBS_FIX}`);
}

/** `--jobs <k>` against the planned shard: k may not exceed its file count (an empty shard allows 1). */
export function validateJobsForShard(jobs: number, fileCount: number, shard: number): void {
  const max = Math.max(1, fileCount);
  if (jobs > max) {
    throw new Error(`${FREE_JOBS_INVALID}: --jobs ${jobs} is more than CI shard ${shard}'s ${fileCount} file(s); use 1 to ${max}. ${JOBS_FIX}`);
  }
}

export interface FileTestCounts { tests: number; pass: number; fail: number; skip: number; todo: number; expects: number }
export interface ShardTestCounts {
  source: 'bun-junit';
  /** Every reported file was planned and the per-file tests add up to bun's own `Ran N tests` count. */
  complete: boolean;
  problem?: string;
  files: Record<string, FileTestCounts>;
  totals: FileTestCounts;
}

const zeroCounts = (): FileTestCounts => ({ tests: 0, pass: 0, fail: 0, skip: 0, todo: 0, expects: 0 });
const addCounts = (into: FileTestCounts, from: FileTestCounts) => {
  for (const key of Object.keys(into) as Array<keyof FileTestCounts>) into[key] += from[key];
};
const TAG = /<(\/?)(testsuites|testsuite|testcase|failure|error|skipped)\b((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
const ATTR = /([\w:-]+)="([^"]*)"/g;
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (text: string) => text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, entity: string) => entity[0] === '#'
  ? String.fromCodePoint(entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)))
  : ENTITIES[entity] ?? whole);
const attributes = (text: string): Record<string, string> =>
  Object.fromEntries([...text.matchAll(ATTR)].map(([, key, value]) => [key, decode(value)]));

/**
 * Per-file counts from bun's JUnit XML. A testcase is a fail when it holds a
 * failure or error, a todo when skipped with message TODO, a skip when
 * skipped otherwise, else a pass; expects sum each testcase's assertions.
 * Printed paths are matched back to planned files (bun prints them relative
 * to the child's real cwd). Files that never ran a test are absent.
 */
export function parseJunitCounts(xml: string | null, planned: readonly string[], testsRan: number | null): ShardTestCounts {
  const files: Record<string, FileTestCounts> = {};
  const totals = zeroCounts();
  const result = (complete: boolean, problem?: string): ShardTestCounts =>
    ({ source: 'bun-junit', complete, ...(problem ? { problem } : {}), files, totals });
  if (xml === null) return result(false, 'bun wrote no JUnit report');
  const plannedSet = new Set(planned);
  const unknown = new Set<string>();
  const canonical = (printed: string) => {
    const stripped = normalizeRelativePath(printed).replace(/^(?:\.{1,2}\/)+/, '');
    if (plannedSet.has(stripped)) return stripped;
    return planned.find(file => stripped.endsWith(`/${file}`) || file.endsWith(`/${stripped}`)) ?? stripped;
  };
  let current: { file: string; state: 'pass' | 'fail' | 'skip' | 'todo'; expects: number } | null = null;
  const finish = () => {
    if (!current) return;
    const entry = files[current.file] ??= zeroCounts();
    entry.tests += 1;
    entry[current.state] += 1;
    entry.expects += current.expects;
    if (!plannedSet.has(current.file)) unknown.add(current.file);
    current = null;
  };
  for (const [, closing, name, body, selfClosing] of xml.matchAll(TAG)) {
    if (name === 'testcase') {
      if (closing) { finish(); continue; }
      const attrs = attributes(body);
      current = { file: canonical(attrs.file ?? ''), state: 'pass', expects: Number(attrs.assertions ?? 0) || 0 };
      if (selfClosing) finish();
    } else if (current && !closing && (name === 'failure' || name === 'error')) {
      current.state = 'fail';
    } else if (current && !closing && name === 'skipped' && current.state === 'pass') {
      current.state = attributes(body).message === 'TODO' ? 'todo' : 'skip';
    }
  }
  finish();
  for (const entry of Object.values(files)) addCounts(totals, entry);
  if (unknown.size) return result(false, `JUnit named unplanned file(s): ${[...unknown].sort().join(', ')}`);
  if (testsRan === null) return result(false, "bun's summary has no test count");
  if (totals.tests !== testsRan) return result(false, `JUnit counted ${totals.tests} tests, bun's summary ${testsRan}`);
  return result(true);
}

/** One shard's counts from its sub-shards' counts; complete only when every part is and no file repeats. */
export function mergeTestCounts(parts: Array<ShardTestCounts | undefined>): ShardTestCounts | undefined {
  if (parts.every(part => !part)) return undefined;
  const files: Record<string, FileTestCounts> = {};
  const totals = zeroCounts();
  const problems: string[] = [];
  parts.forEach((part, index) => {
    if (!part) { problems.push(`sub-shard ${index + 1} has no counts`); return; }
    if (!part.complete) problems.push(`sub-shard ${index + 1}: ${part.problem ?? 'incomplete'}`);
    for (const [file, counts] of Object.entries(part.files)) {
      if (files[file]) problems.push(`${file} counted twice`);
      files[file] = { ...counts };
    }
    addCounts(totals, part.totals);
  });
  return { source: 'bun-junit', complete: problems.length === 0, ...(problems.length ? { problem: problems.join('; ') } : {}), files, totals };
}

export interface SubShardAssignment {
  /** `<plan id prefix>:<shard>.<index>`: binds a result to one plan, shard and file set. */
  id: string;
  index: number;
  phase: 'parallel' | 'serial';
  files: string[];
}

/**
 * Split one CI shard into disjoint sub-shards: up to k parallel ones packed by
 * `pack`, then one serial sub-shard for the files `isSerial` names. Throws
 * unless the assignments cover the shard's files exactly once.
 */
export function assignSubShards(
  planId: string, shard: { shard: number; files: string[] }, jobs: number,
  isSerial: (file: string) => boolean, pack: (files: string[], count: number) => string[][],
): SubShardAssignment[] {
  const serial = shard.files.filter(isSerial);
  const parallel = shard.files.filter(file => !isSerial(file));
  const groups = parallel.length ? pack(parallel, Math.min(jobs, parallel.length)).filter(files => files.length) : [];
  const assignments: SubShardAssignment[] = [
    ...groups.map(files => ({ phase: 'parallel' as const, files })),
    ...(serial.length ? [{ phase: 'serial' as const, files: serial }] : []),
  ].map((entry, index) => ({ id: `${planId.slice(0, 12)}:${shard.shard}.${index + 1}`, index: index + 1, ...entry }));
  const assigned = assignments.flatMap(entry => entry.files);
  if (new Set(assigned).size !== assigned.length || assigned.length !== shard.files.length
    || !shard.files.every(file => assigned.includes(file))) {
    throw new Error(`${FREE_SUBSHARD_REJECTED}: sub-shard assignment for CI shard ${shard.shard} does not cover its files exactly once`);
  }
  return assignments;
}

export type SubShardSettlement = { assignment: SubShardAssignment } & ({ outcome: FreeShardOutcome } | { error: string });

/** Why one sub-shard's result cannot stand for its assignment; empty when it can. */
export function subShardProblems(settled: SubShardSettlement): string[] {
  const { assignment } = settled;
  if (!('outcome' in settled)) return [`${assignment.id} has no result (${settled.error})`];
  const { outcome } = settled;
  const problems: string[] = [];
  if (JSON.stringify(outcome.files) !== JSON.stringify(assignment.files)) problems.push(`${assignment.id} reported another file set`);
  const summary = outcome.summary;
  if (outcome.status === 'passed' && (!summary || summary.filesRan !== assignment.files.length || summary.sawTerminalSummary !== true
    || outcome.exitCode !== 0 || outcome.failingFiles.length || outcome.unattributedFailures)) {
    problems.push(`${assignment.id} passed without a complete execution summary`);
  }
  return problems;
}

export interface SubShardRecord {
  id: string;
  phase: SubShardAssignment['phase'];
  files: string[];
  status: FreeShardOutcome['status'] | 'missing';
  exitCode: number | null;
  elapsedMs: number;
  summary?: FreeShardOutcome['summary'];
  failingFiles: string[];
  unattributedFailures: number;
}

/**
 * One CI shard outcome from every sub-shard: the planned file order, summed
 * summaries, the union of failing files, and the worst status. Every rejected
 * sub-shard adds unattributed evidence, which also vetoes the retry pass.
 */
export function mergeSubShardOutcomes(
  shard: { shard: number; files: string[] }, settled: SubShardSettlement[], elapsedMs: number, extraProblems: string[] = [],
): { outcome: FreeShardOutcome; records: SubShardRecord[]; problems: string[] } {
  const problems = [...extraProblems];
  const assigned = settled.flatMap(entry => entry.assignment.files);
  if (new Set(assigned).size !== assigned.length) problems.push('a file is assigned to more than one sub-shard');
  if (assigned.length !== shard.files.length || !shard.files.every(file => assigned.includes(file))) problems.push('sub-shards do not cover the CI shard');
  for (const entry of settled) problems.push(...subShardProblems(entry));
  const outcomes = settled.flatMap(entry => ('outcome' in entry ? [entry.outcome] : []));
  const missing = settled.length - outcomes.length;
  const status: FreeShardOutcome['status'] = outcomes.some(outcome => outcome.status === 'timed-out') ? 'timed-out'
    : problems.length || outcomes.some(outcome => outcome.status !== 'passed') ? 'failed' : 'passed';
  const testsRan = outcomes.map(outcome => outcome.summary?.testsRan ?? null);
  const failures = outcomes.flatMap(outcome => outcome.failures ?? []);
  const inFlight = outcomes.flatMap(outcome => outcome.inFlight ?? []);
  const counts = mergeTestCounts(settled.map(entry => ('outcome' in entry ? entry.outcome.counts : undefined)));
  const outcome: FreeShardOutcome = {
    shard: shard.shard,
    files: shard.files,
    status,
    exitCode: status === 'passed' ? 0 : outcomes.find(entry => entry.exitCode)?.exitCode ?? 1,
    elapsedMs,
    groupPid: null,
    failingFiles: status === 'passed' ? [] : [...new Set(outcomes.flatMap(entry => entry.failingFiles))],
    unattributedFailures: status === 'passed' ? 0 : outcomes.reduce((sum, entry) => sum + entry.unattributedFailures, 0) + problems.length,
    ...(failures.length ? { failures } : {}),
    summary: {
      testsRan: missing || testsRan.some(value => value === null) ? null : testsRan.reduce<number>((sum, value) => sum + value!, 0),
      filesRan: outcomes.reduce((sum, entry) => sum + (entry.summary?.filesRan ?? 0), 0),
      sawTerminalSummary: !missing && outcomes.every(entry => entry.files.length === 0 || entry.summary?.sawTerminalSummary === true),
    },
    ...(counts ? { counts } : {}),
    ...(inFlight.length ? { inFlight } : {}),
  };
  const records = settled.map((entry): SubShardRecord => {
    const { id, phase, files } = entry.assignment;
    if (!('outcome' in entry)) return { id, phase, files, status: 'missing', exitCode: null, elapsedMs: 0, failingFiles: [], unattributedFailures: 1 };
    const { status: subStatus, exitCode, elapsedMs: subElapsed, summary, failingFiles, unattributedFailures } = entry.outcome;
    return { id, phase, files, status: subStatus, exitCode, elapsedMs: subElapsed, summary, failingFiles, unattributedFailures };
  });
  return { outcome, records, problems };
}

/** `--ci-verify` re-checks a k > 1 result's sub-shard records; empty means they stand. */
export function subShardRecordProblems(result: FreeCiResult): string[] {
  if (result.jobs === undefined && result.subShards === undefined) return [];
  const records = result.subShards ?? [];
  if (!Number.isInteger(result.jobs) || result.jobs! < 2 || !records.length) return ['sub-shard result without a valid --jobs and records'];
  const files = records.flatMap(record => record.files);
  const problems: string[] = [];
  if (new Set(files).size !== files.length || files.length !== result.outcome.files.length
    || !result.outcome.files.every(file => files.includes(file))) problems.push('sub-shard records do not cover the shard exactly once');
  if (result.outcome.status === 'passed' && records.some(record => record.status !== 'passed' || record.summary?.filesRan !== record.files.length
    || (record.files.length > 0 && record.summary?.sawTerminalSummary !== true))) problems.push('a passing shard holds a failed or incomplete sub-shard');
  return problems;
}

export interface CiRunContext { planPath: string; runId: string; runner: string }

/** Where this run is: the CI run id (with attempt) and runner, else `local` and the host. */
export function ciRunContext(planPath: string, env: NodeJS.ProcessEnv = process.env): CiRunContext {
  const runId = env.GITHUB_RUN_ID ? `${env.GITHUB_RUN_ID}${env.GITHUB_RUN_ATTEMPT ? `/attempt ${env.GITHUB_RUN_ATTEMPT}` : ''}` : 'local';
  const cpus = os.availableParallelism?.() ?? os.cpus().length;
  return { planPath, runId, runner: `${env.RUNNER_NAME || os.hostname()} (${process.platform}, ${cpus} CPUs)` };
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** The FREE_SUBSHARD_TIMEOUT text: the file, k, runner, a serial reproduce command and the fix. */
export function subShardTimeoutText(
  shard: number, jobs: number, record: SubShardRecord, inFlight: string[], wallTimeoutMs: number, context: CiRunContext,
): string[] {
  const suspects = inFlight.filter(file => record.files.includes(file));
  const files = suspects.length ? suspects : record.files;
  return [
    `[test:free] ${FREE_SUBSHARD_TIMEOUT}: CI shard ${shard} sub-shard ${record.id} (${record.files.length} files) hit its ${Math.round(wallTimeoutMs / 1000)}s wall at --jobs ${jobs} on ${context.runner}, run ${context.runId}.`,
    `[test:free]   in flight: ${suspects.length ? suspects.join(', ') : 'unknown (no open file chunk; see the sub-shard log)'}`,
    `[test:free]   reproduce serially: printf '%s\\n' ${files.map(quote).join(' ')} > files.txt && GSTACK_FREE_JOBS=1 bun run scripts/test-free-shards.ts --files-from files.txt`,
    `[test:free]   or the whole CI shard at k=1: bun run scripts/test-free-shards.ts --ci-run ${quote(context.planPath)} --shard ${shard} --result shard-${shard}.json --jobs 1`,
    `[test:free]   if it passes serially, add it to SLOW_UNDER_LOAD in scripts/lib/shard-jobs.ts with run id ${context.runId}; never raise the timeout. See ${DOCS}`,
  ];
}

export interface RunShardOptions { wallTimeoutMs: number; verbose: boolean; testCounts: true; homeGuard?: FreeHomeGuardFactory }

export interface CiShardInput {
  plan: FreeCiPlan;
  shard: FreeCiPlan['shards'][number];
  revision: string;
  /** Sub-shard count; 1 is today's single child. */
  jobs: number;
  wallTimeoutMs: number;
  verbose: boolean;
  context: CiRunContext;
}

export interface CiShardDeps {
  runShard(files: string[], shardNumber: number, totalShards: number, options: RunShardOptions): Promise<FreeShardOutcome>;
  /** The free runner's single flaky-retry pass over every collected outcome. */
  retry(outcomes: FreeShardOutcome[]): Promise<{ exitCode: number; retry: FreeShardOutcome | null }>;
  pack(files: string[], count: number): string[][];
  isSerial(file: string): boolean;
  terminationRequested(): boolean;
  phaseGuard?(files: string[], shards: number): FreeHomeGuard;
  log?(line: string): void;
}

/** Run one planned CI shard at k sub-shards and build its result JSON. */
export async function runCiShard(input: CiShardInput, deps: CiShardDeps): Promise<{ result: FreeCiResult; exitCode: number }> {
  const { plan, shard, revision, jobs, wallTimeoutMs, verbose } = input;
  const log = deps.log ?? ((line: string) => console.log(line));
  if (jobs === 1) {
    const outcome = await deps.runShard(shard.files, shard.shard, plan.shards.length, { wallTimeoutMs, verbose, testCounts: true });
    const retried = await deps.retry([outcome]);
    return { result: { planId: plan.id, revision, outcome, retry: retried.retry }, exitCode: retried.exitCode };
  }
  const startedAt = Date.now();
  const assignments = assignSubShards(plan.id, shard, jobs, deps.isSerial, deps.pack);
  const total = assignments.length;
  log(`[test:free] CI shard ${shard.shard}/${plan.shards.length} at --jobs ${jobs}: ${assignments
    .map(entry => `sub-shard ${entry.id} = runner shard ${entry.index}/${total} (${entry.phase}, ${entry.files.length} files)`).join('; ')}`);
  const run = (entry: SubShardAssignment, homeGuard?: FreeHomeGuardFactory, wall = wallTimeoutMs): Promise<SubShardSettlement> =>
    deps.runShard(entry.files, entry.index, total, { wallTimeoutMs: wall, verbose, testCounts: true, ...(homeGuard ? { homeGuard } : {}) })
      .then(outcome => ({ assignment: entry, outcome }), (error: unknown) => ({ assignment: entry, error: error instanceof Error ? error.message : String(error) }));
  const parallel = assignments.filter(entry => entry.phase === 'parallel');
  const serial = assignments.filter(entry => entry.phase === 'serial');
  const phaseProblems: string[] = [];
  const settled: SubShardSettlement[] = [];
  if (parallel.length) {
    const guard = deps.phaseGuard ?? ((files: string[], shards: number) => guardFreeHome(files, process.env, { kind: 'concurrent', shards }));
    const phaseHome = guard(parallel.flatMap(entry => entry.files), parallel.length);
    settled.push(...await Promise.all(parallel.map(entry => run(entry, sharedFreeHome))));
    const homeChange = phaseHome.verify();
    if (homeChange) phaseProblems.push(homeChange);
  }
  for (const entry of serial) {
    settled.push(deps.terminationRequested() ? { assignment: entry, error: 'cancelled before the serial phase' }
      : await run(entry, undefined, Math.max(1, startedAt + wallTimeoutMs - Date.now())));
  }
  const merged = mergeSubShardOutcomes(shard, settled, Date.now() - startedAt, phaseProblems);
  for (const problem of merged.problems) console.error(`[test:free] ${FREE_SUBSHARD_REJECTED}: CI shard ${shard.shard}: ${problem}`);
  for (const record of merged.records.filter(entry => entry.status === 'timed-out')) {
    for (const line of subShardTimeoutText(shard.shard, jobs, record, merged.outcome.inFlight ?? [], wallTimeoutMs, input.context)) console.error(line);
  }
  log(`[test:free] CI shard ${shard.shard}: ${merged.outcome.status} across ${total} sub-shards in ${Math.round(merged.outcome.elapsedMs / 1000)}s`);
  const retried = await deps.retry([merged.outcome]);
  return {
    result: { planId: plan.id, revision, outcome: merged.outcome, retry: retried.retry, jobs, subShards: merged.records },
    exitCode: retried.exitCode,
  };
}

/** The duration seed takes only one-file children's walls, never a sub-shard's or a shard's. */
export function assertSoloSeedSample(file: string, outcome: Pick<FreeShardOutcome, 'files'>): void {
  if (outcome.files.length !== 1 || outcome.files[0] !== file) {
    throw new Error(`Duration seed sample for ${file} came from a ${outcome.files.length}-file child; seeds are recorded only from one-file serial children.`);
  }
}
