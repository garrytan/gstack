/**
 * pr-wait-github — the GitHub read side of gstack-pr-wait: a gh runner that
 * retries transient failures (never a rate limit, GST-1713), the pull
 * request's state, base head and head-commit checks from REST, the one
 * GraphQL read of its conversation (comments, reviews, review threads), the
 * required-check names from rulesets and classic branch protection, and the
 * base-branch comparisons. The event logic is lib/pr-wait.ts; the two are
 * split so each stays under the module-size ratchet.
 *
 * Design ported from tstack's `pr-wait` (t3dotgg/tstack,
 * skills/babysit-pr/scripts/pr-wait at 7de017b, MIT, Copyright (c) 2026 Theo
 * Browne; NOTICE.md and licenses/MIT-tstack.txt), rewritten in TypeScript on
 * gstack's gh runner shape (lib/ci-gate.ts).
 */
import type { GhResult, GhRunner } from './ci-gate';
import { parseHeadChecks, parsePullState, rateLimitKind, type PullState } from './gh-poll';

export class GhError extends Error {
  constructor(message: string, readonly transient: boolean) {
    super(message);
    this.name = 'GhError';
  }
}

export interface GhEnv {
  gh: GhRunner;
  sleep(ms: number): void;
  log(message: string): void;
}

export type BucketClass = 'pass' | 'pending' | 'fail';

export interface Actor { login: string; bot: boolean }
export interface Comment { id: string; url: string; body: string; author: Actor }
export interface Review { id: string; url: string; state: string; body: string; commitOid: string | null; author: Actor }
export interface Thread { isResolved: boolean; path: string; line: number | null; comments: Comment[] }
/** What people said on the PR: the one GraphQL read, which REST cannot answer (review-thread resolution). */
export interface Conversation { viewer: string; comments: Comment[]; reviews: Review[]; threads: Thread[] }
export interface PullRequest extends PullState, Conversation { baseOid: string | null }
export interface Check { name: string; bucket: string; link: string; description: string }

const TRANSIENT = /HTTP 5\d\d|timed? ?out|connection (reset|refused)|EOF|temporar|could not resolve host|TLS handshake|Something went wrong/i;
const RETRIES = 5;
const PASS_BUCKETS = new Set(['pass', 'skipping', 'neutral']);
/** Worst bucket first, for collapsing duplicate check names (push and pull_request runs of one job). */
const RANK: Record<BucketClass, number> = { fail: 2, pending: 1, pass: 0 };

export const PR_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      comments(last: 100) { nodes { id url body author { login __typename } } }
      reviews(last: 100) {
        nodes { id url state body commit { oid } author { login __typename } }
      }
      reviewThreads(last: 100) {
        nodes {
          isResolved path line
          comments(first: 100) { nodes { id url body author { login __typename } } }
        }
      }
    }
  }
}
`;

export function bucketClass(bucket: string): BucketClass {
  if (PASS_BUCKETS.has(bucket)) return 'pass';
  return bucket === 'pending' ? 'pending' : 'fail';
}

function lastLine(text: string): string {
  return text.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';
}

/**
 * Run gh. A transient failure (HTTP 5xx, network) is retried with doubling backoff. A rate limit is never retried
 * here: it throws a transient GhError at once, and the poll loop waits its full interval (the production runner,
 * lib/gh-poll.ts withRateLimit, has already slept until the reset).
 */
export function runGh(env: GhEnv, args: string[], allow: number[] = [0]): GhResult {
  let delay = 2_000;
  for (let attempt = 1; ; attempt++) {
    const result = env.gh(args);
    // gh missing is fatal; any other spawn failure (its 60 s timeout, a signal) is a slow API, so retry.
    if (result.error && /not installed/.test(result.error)) throw new GhError(result.error, false);
    const status = result.status ?? -1;
    if (status !== 0 && rateLimitKind(args, `${result.stderr}\n${result.stdout}`)) throw new GhError(lastLine(result.stderr) || 'GitHub rate limit', true);
    const transient = status !== 0 && (result.error !== undefined || result.status === null || TRANSIENT.test(result.stderr));
    if (!transient && allow.includes(status)) return result;
    const message = result.error ?? (lastLine(result.stderr) || `gh exited ${status}`);
    if (!transient || attempt === RETRIES) throw new GhError(message, transient);
    env.log(`gh ${args.slice(0, 2).join(' ')}: ${message}; retry in ${delay / 1000}s`);
    // gh-poll-exempt: a 5xx or network retry of one read (2, 4, 8, 16 s), never a rate limit (thrown above)
    env.sleep(delay);
    delay *= 2;
  }
}

function ghLines(env: GhEnv, args: string[]): string[] {
  return runGh(env, args).stdout.split(/\r?\n/).filter(Boolean);
}

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => (value && typeof value === 'object' ? (value as Json) : {});
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const nodes = (value: unknown): Json[] => {
  const list = obj(value).nodes;
  return Array.isArray(list) ? list.map(obj) : [];
};
const actor = (node: Json): Actor => {
  const author = obj(node.author);
  return { login: str(author.login) || 'ghost', bot: author.__typename === 'Bot' };
};
const comment = (node: Json): Comment => ({ id: str(node.id), url: str(node.url), body: str(node.body), author: actor(node) });

/** The current owner/name of the checkout's GitHub repository. */
export function currentRepo(env: GhEnv): string {
  return runGh(env, ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).stdout.trim();
}

/** Confirms the PR exists and is readable (REST); throws GhError otherwise. */
export function confirmPullRequest(env: GhEnv, repo: string, pr: number): void {
  runGh(env, ['api', `repos/${repo}/pulls/${pr}`, '--jq', '.number']);
}

/** The PR's state, head, base and merge state from REST `pulls/{n}`: no GraphQL. */
export function fetchPullState(env: GhEnv, repo: string, pr: number): PullState {
  const state = parsePullState(runGh(env, ['api', `repos/${repo}/pulls/${pr}`]).stdout);
  if (!state) throw new GhError(`${repo}#${pr} is not a pull request GitHub returned`, false);
  return state;
}

/** The base branch's current head commit (REST), or null when unreadable. */
export function fetchBaseOid(env: GhEnv, repo: string, base: string): string | null {
  try {
    return runGh(env, ['api', `repos/${repo}/git/ref/heads/${base}`, '--jq', '.object.sha']).stdout.trim() || null;
  } catch (error) {
    if (error instanceof GhError && error.transient) throw error;
    return null;
  }
}

/** The conversation: the one GraphQL read, made only when lib/pr-wait.ts decides it is stale. */
export function fetchConversation(env: GhEnv, repo: string, pr: number): Conversation {
  const [owner, name] = repo.split('/');
  const result = runGh(env, ['api', 'graphql', '-f', `query=${PR_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${pr}`]);
  let parsed: Json;
  try { parsed = obj(JSON.parse(result.stdout)); } catch {
    throw new GhError('gh api graphql printed output that is not JSON', false);
  }
  const pullRequest = obj(obj(parsed.data).repository).pullRequest;
  if (!pullRequest || typeof pullRequest !== 'object') {
    const errors = Array.isArray(parsed.errors) ? parsed.errors.map(e => str(obj(e).message)).filter(Boolean).join('; ') : '';
    throw new GhError(errors || `${repo}#${pr} is not a pull request GitHub returned`, false);
  }
  const node = obj(pullRequest);
  return {
    viewer: str(obj(obj(parsed.data).viewer).login),
    comments: nodes(node.comments).map(comment),
    reviews: nodes(node.reviews).map(r => ({ ...comment(r), state: str(r.state), commitOid: str(obj(r.commit).oid) || null })),
    threads: nodes(node.reviewThreads).map(t => ({
      isResolved: t.isResolved === true,
      path: str(t.path),
      line: typeof t.line === 'number' ? t.line : null,
      comments: nodes(t.comments).map(comment),
    })),
  };
}

/** Every entry of a paginated REST list, read with `--paginate --jq '.<key>[]'` (one JSON value per line). */
function restList(env: GhEnv, path: string, key: string): unknown[] {
  const lines = runGh(env, ['api', '--paginate', path, '--jq', `.${key}[]`]).stdout.split(/\r?\n/).filter(Boolean);
  try { return lines.map(line => JSON.parse(line)); } catch {
    throw new GhError(`gh api ${path} printed output that is not JSON`, false);
  }
}

/**
 * Every check on the head commit by name, from REST check runs and commit
 * statuses (the same rows `gh pr checks` reads through GraphQL), duplicates
 * collapsed to the worst bucket.
 */
export function fetchChecks(env: GhEnv, repo: string, head: string): Map<string, Check> {
  const rows = parseHeadChecks(
    restList(env, `repos/${repo}/commits/${head}/check-runs?per_page=100`, 'check_runs'),
    restList(env, `repos/${repo}/commits/${head}/status?per_page=100`, 'statuses'),
  );
  const checks = new Map<string, Check>();
  for (const row of rows) {
    const current = checks.get(row.name);
    if (!current || RANK[bucketClass(row.bucket)] > RANK[bucketClass(current.bucket)]) checks.set(row.name, row);
  }
  return checks;
}

/**
 * Required check names for the base branch, from rulesets and classic branch
 * protection. Reading them up front means a required check that has not
 * started yet counts as pending instead of green by omission. A 404 means no
 * protection of that kind, which is normal; any other failure is logged, that
 * source contributes nothing, and `known` is false: the set may be short, so a
 * caller that would relax the gate on it (`--exclude`) must not.
 */
export function requiredChecks(env: GhEnv, repo: string, base: string): { names: Set<string>; known: boolean } {
  const sources: Array<[string, string]> = [
    [`repos/${repo}/rules/branches/${base}`, '.[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context'],
    [`repos/${repo}/branches/${base}/protection/required_status_checks`, '.contexts[]?, .checks[]?.context'],
  ];
  const names = new Set<string>();
  let known = true;
  for (const [path, jq] of sources) {
    try {
      for (const name of ghLines(env, ['api', path, '--jq', jq])) names.add(name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/HTTP 404/.test(message)) continue;
      known = false;
      env.log(`could not read required checks from ${path}: ${message}`);
    }
  }
  return { names, known };
}

/** Files the PR changes, from `gh pr diff --name-only`. */
export function pullRequestFiles(env: GhEnv, repo: string, pr: number): Set<string> {
  return new Set(ghLines(env, ['pr', 'diff', String(pr), '-R', repo, '--name-only']));
}

/** Files the commits between two base-branch heads changed. */
export function compareFiles(env: GhEnv, repo: string, from: string, to: string): string[] {
  return ghLines(env, ['api', `repos/${repo}/compare/${from}...${to}`, '--jq', '.files[].filename']);
}

/** How many commits the head is behind the base head, or null when unreadable. */
export function behindBy(env: GhEnv, repo: string, baseOid: string, head: string): string | null {
  try {
    return runGh(env, ['api', `repos/${repo}/compare/${baseOid}...${head}`, '--jq', '.behind_by']).stdout.trim() || null;
  } catch {
    return null;
  }
}
