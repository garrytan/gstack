/**
 * gh-poll: the one policy for how gstack reads GitHub repeatedly (GST-1713).
 *
 * The Capy GitHub app installation shares one GraphQL budget across every
 * crew, and `gh pr view|list|checks` spend it. Three rules live here:
 *
 *   pollDelayMs   every wait between two GitHub reads is at least
 *                 MIN_POLL_MS (60 s) plus up to 15 s of jitter, whatever
 *                 interval a caller or flag asks for.
 *   rate limits   a gh call that fails with a rate-limit message (403/429,
 *                 "API rate limit exceeded", "GraphQL: API rate limit",
 *                 a secondary limit) is never retried at once: the helper
 *                 reads `gh api rate_limit` (exempt from the limit), sleeps
 *                 until that resource resets (at least 60 s), and retries at
 *                 most MAX_LIMIT_WAITS times before returning the failure.
 *   REST reads    pull request state and head-commit checks come from REST
 *                 (`repos/{o}/{r}/pulls/{n}`, `commits/{sha}/check-runs`,
 *                 `commits/{sha}/status`), which never touch the GraphQL budget.
 *
 * test/gh-poll-tripwire.test.ts keeps every sleep in a GitHub-reading module
 * on pollDelayMs. GSTACK_GH_POLL_FLOOR_MS is a test seam only (fixtures that
 * drive real binaries with millisecond polls); no shipped file may set it.
 */
import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from 'node:child_process';
import type { GhResult, GhRunner } from './ci-gate';

export const MIN_POLL_MS = 60_000;
export const MAX_LIMIT_WAITS = 2;
/** The longest a rate-limit wait may last: one full hourly window plus slack. */
const MAX_LIMIT_WAIT_MS = 65 * 60_000;
const RESET_SLACK_MS = 5_000;

type Vars = Record<string, string | undefined>;

function floorMs(vars: Vars): number {
  const seam = vars.GSTACK_GH_POLL_FLOOR_MS;
  return seam !== undefined && /^\d+$/.test(seam) ? Number(seam) : MIN_POLL_MS;
}

/** The wait before the next GitHub read: at least the floor (60 s), plus jitter up to a quarter of the floor. */
export function pollDelayMs(requestedMs: number, random: () => number = Math.random, vars: Vars = process.env): number {
  const floor = floorMs(vars);
  return Math.max(Number.isFinite(requestedMs) ? requestedMs : 0, floor) + Math.round(random() * floor / 4);
}

export type RateLimitKind = 'graphql' | 'core' | 'secondary';

const SECONDARY = /secondary rate limit|abuse detection/i;
const GRAPHQL_LIMIT = /GraphQL: API rate limit|"type":\s*"RATE_LIMITED"/i;
const ANY_LIMIT = /API rate limit (?:already )?exceeded|rate limit exceeded|HTTP 429|\(HTTP 403\).*rate limit|rate limit.*\(HTTP 403\)/i;
/** gh subcommands that read through GraphQL; everything else (gh api <path>, gh run, gh workflow, gh release) is REST. */
const GRAPHQL_COMMANDS = new Set(['pr', 'issue', 'repo', 'search', 'project', 'label']);

/** Which budget a failed gh call ran out of, from its output, or null when the failure is not a rate limit. */
export function rateLimitKind(args: readonly string[], output: string): RateLimitKind | null {
  if (SECONDARY.test(output)) return 'secondary';
  if (GRAPHQL_LIMIT.test(output)) return 'graphql';
  if (!ANY_LIMIT.test(output)) return null;
  return (args[0] === 'api' && args[1] === 'graphql') || GRAPHQL_COMMANDS.has(args[0] ?? '') ? 'graphql' : 'core';
}

/**
 * How long to sleep after a rate-limit failure: until the resource in `gh api rate_limit` resets (plus slack) when it
 * reads remaining 0, else (a secondary limit, an unreadable reply) the poll floor. Never less than pollDelayMs(0).
 */
export function rateLimitWaitMs(kind: RateLimitKind, rateLimitJson: string, nowMs: number, random: () => number = Math.random, vars: Vars = process.env): number {
  let untilReset = 0;
  if (kind !== 'secondary') {
    try {
      const resource = (JSON.parse(rateLimitJson) as { resources?: Record<string, { remaining?: unknown; reset?: unknown }> }).resources?.[kind];
      if (resource && resource.remaining === 0 && typeof resource.reset === 'number') untilReset = resource.reset * 1000 - nowMs + RESET_SLACK_MS;
    } catch { /* unreadable: fall back to the floor */ }
  }
  return pollDelayMs(Math.min(Math.max(untilReset, 0), MAX_LIMIT_WAIT_MS), random, vars);
}

export interface LimitEnv { sleep(ms: number): void; now(): number; log(message: string): void; random?: () => number; vars?: Vars }

/**
 * `gh pr merge` runs under the land lock, which another lander may break once the holder is 10 minutes into a merge
 * (PUSH_STALE_MS): a rate-limited merge fails at once, as it did before the wait existed, instead of sleeping through it.
 */
const failsFast = (args: readonly string[]): boolean => args[0] === 'pr' && args[1] === 'merge';

/**
 * Wrap a gh runner: a rate-limited failure sleeps until the reset and reruns the same call, at most MAX_LIMIT_WAITS
 * times; any other result (success or a real failure) and a rate-limited `gh pr merge` return at once. The
 * `gh api rate_limit` read goes through the inner runner, unwrapped.
 */
export function withRateLimit(gh: GhRunner, env: LimitEnv): GhRunner {
  return args => {
    for (let waits = 0; ; waits++) {
      const result = gh(args);
      const kind = result.status === 0 ? null : rateLimitKind(args, `${result.stderr}\n${result.stdout}`);
      if (!kind || waits >= MAX_LIMIT_WAITS || failsFast(args)) return result;
      const limits = gh(['api', 'rate_limit']);
      const ms = rateLimitWaitMs(kind, limits.status === 0 ? limits.stdout : '', env.now(), env.random, env.vars);
      env.log(`GitHub ${kind} rate limit on gh ${args.slice(0, 2).join(' ')}; waiting ${Math.round(ms / 1000)} s for the reset before one retry (${waits + 1}/${MAX_LIMIT_WAITS})`);
      env.sleep(ms);
    }
  };
}

/** The CLI environment: a blocking sleep (gh runners are synchronous) and the wait note on stderr. */
export const syncLimitEnv: LimitEnv = {
  sleep: ms => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); },
  now: () => Date.now(),
  log: message => { process.stderr.write(`gstack-gh: ${message}\n`); },
};

/** Drop-in for `spawnSync('gh', args, options)` with the rate-limit rule; the wait note goes to stderr. */
export function ghSpawnSync(args: string[], options: SpawnSyncOptionsWithStringEncoding): SpawnSyncReturns<string> {
  let last: SpawnSyncReturns<string> | undefined;
  const run = withRateLimit(a => {
    const r = spawnSync('gh', a, options);
    if (a === args) last = r;
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', ...(r.error ? { error: String(r.error.message) } : {}) };
  }, syncLimitEnv);
  run(args);
  return last!;
}

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {});
const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** A pull request's state from REST `repos/{o}/{r}/pulls/{n}`, in GraphQL's spellings (MERGED/CLOSED/OPEN, BEHIND/DIRTY/...). */
export interface PullState { url: string; state: string; headRefOid: string; baseRefName: string; mergeStateStatus: string; author: string; updatedAt: string }

export function parsePullState(json: string): PullState | null {
  let raw: Json;
  try { raw = obj(JSON.parse(json)); } catch { return null; }
  const head = str(obj(raw.head).sha);
  if (!head) return null;
  return {
    url: str(raw.html_url),
    state: raw.merged === true || str(raw.merged_at) ? 'MERGED' : str(raw.state) === 'closed' ? 'CLOSED' : 'OPEN',
    headRefOid: head,
    baseRefName: str(obj(raw.base).ref),
    mergeStateStatus: (str(raw.mergeable_state) || 'unknown').toUpperCase(),
    author: str(obj(raw.user).login).replace(/\[bot\]$/, '') || 'ghost',
    updatedAt: str(raw.updated_at),
  };
}

/** One check on a commit in `gh pr checks` bucket spelling: pass, fail, pending, skipping, neutral, cancel. */
export interface HeadCheck { name: string; bucket: string; link: string; description: string }

const CONCLUSION_BUCKET: Record<string, string> = {
  success: 'pass', failure: 'fail', timed_out: 'fail', action_required: 'fail', startup_failure: 'fail',
  cancelled: 'cancel', skipped: 'skipping', neutral: 'skipping',
};
const STATUS_BUCKET: Record<string, string> = { success: 'pass', failure: 'fail', error: 'fail', pending: 'pending' };

/**
 * Every check on a commit from the REST `check_runs` and combined-status `statuses` entries, in `gh pr checks`
 * buckets: the newest run per check suite and name (a re-run attempt supersedes the run it replaced; two workflow runs
 * of one job, push and pull_request, stay two rows for the caller to collapse) and every status context. An unknown
 * conclusion keeps its own spelling, which every bucket reader counts as failed.
 */
export function parseHeadChecks(runs: readonly unknown[], statuses: readonly unknown[]): HeadCheck[] {
  const newest = new Map<string, Json>();
  const rank = (r: Json) => (str(r.status) !== 'completed' ? Infinity : Date.parse(str(r.completed_at)) || 0);
  for (const r of runs.map(obj)) {
    const key = `${String(obj(r.check_suite).id ?? obj(r.app).id ?? '')}\0${str(r.name)}`;
    const have = newest.get(key);
    if (!have || rank(r) > rank(have) || (rank(r) === rank(have) && Number(r.id) > Number(have.id))) newest.set(key, r);
  }
  const checks: HeadCheck[] = [...newest.values()].filter(r => str(r.name)).map(r => ({
    name: str(r.name),
    bucket: str(r.status) !== 'completed' ? 'pending' : CONCLUSION_BUCKET[str(r.conclusion)] ?? (str(r.conclusion) || 'pending'),
    link: str(r.details_url) || str(r.html_url),
    description: str(obj(r.output).title),
  }));
  for (const s of statuses.map(obj)) {
    if (!str(s.context)) continue;
    checks.push({ name: str(s.context), bucket: STATUS_BUCKET[str(s.state)] ?? str(s.state), link: str(s.target_url), description: str(s.description) });
  }
  return checks;
}
