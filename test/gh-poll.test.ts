/**
 * lib/gh-poll.ts (GST-1713): the 60 s poll floor with jitter, rate-limit
 * classification and the sleep-until-reset rule, and the REST response
 * parsers. test/fixtures/gh-poll/*.json are trimmed recordings of real
 * GitHub REST replies (garrytan/gstack#4101 merged, #4108 open, the check runs
 * and combined status of #4101's head, and `gh api rate_limit`, recorded
 * 2026-11-06). The rate-limit messages are the ones gh prints for the Capy app
 * installation (FOUN-32 report on GST-1713) and GitHub's secondary-limit text.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GhResult } from '../lib/ci-gate';
import { MAX_LIMIT_WAITS, MIN_POLL_MS, parseHeadChecks, parsePullState, pollDelayMs, rateLimitKind, rateLimitWaitMs, withRateLimit } from '../lib/gh-poll';
import { GhError, fetchChecks, runGh } from '../lib/pr-wait-github';
import { waitForRun } from '../lib/ci-carry';

const fixture = (name: string): string => readFileSync(join(import.meta.dir, 'fixtures', 'gh-poll', name), 'utf8');
const ok = (stdout: string): GhResult => ({ status: 0, stdout, stderr: '' });
const err = (stderr: string, status = 1): GhResult => ({ status, stdout: '', stderr: `${stderr}\n` });
const NO_SEAM = {};

const GRAPHQL_LIMIT = 'GraphQL: API rate limit exceeded for installation ID 161978188.';
const CORE_LIMIT = 'gh: API rate limit exceeded for installation ID 161978188. If you reach out to GitHub Support for help, please include the request ID 1234:5678. (HTTP 403)';
const SECONDARY_LIMIT = 'gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)';
const RATE_LIMIT_JSON = fixture('rate-limit.json');
const exhausted = (resource: 'graphql' | 'core', reset: number) => {
  const parsed = JSON.parse(RATE_LIMIT_JSON);
  parsed.resources[resource] = { ...parsed.resources[resource], remaining: 0, reset };
  return JSON.stringify(parsed);
};

describe('the poll floor', () => {
  // Value: protects=no gstack wait polls GitHub faster than once a minute; fails_when=a caller's 5, 15, 20 or 30 s interval reaches GitHub unchanged
  test('every delay is at least 60 s plus up to 15 s of jitter; a longer request is kept', () => {
    expect(MIN_POLL_MS).toBe(60_000);
    for (const requested of [0, 5_000, 20_000, 30_000, 59_999]) {
      expect(pollDelayMs(requested, () => 0, NO_SEAM)).toBe(60_000);
      expect(pollDelayMs(requested, () => 1, NO_SEAM)).toBe(75_000);
    }
    expect(pollDelayMs(Number.NaN, () => 0, NO_SEAM)).toBe(60_000);
    expect(pollDelayMs(300_000, () => 0.5, NO_SEAM)).toBe(307_500);
  });

  test('GSTACK_GH_POLL_FLOOR_MS lowers the floor for fixtures only', () => {
    expect(pollDelayMs(20, () => 1, { GSTACK_GH_POLL_FLOOR_MS: '0' })).toBe(20);
    expect(pollDelayMs(20, () => 0, { GSTACK_GH_POLL_FLOOR_MS: 'soon' })).toBe(60_000);
  });
});

describe('rate limits are classified, never mistaken for other failures', () => {
  // Value: protects=a rate-limited call is recognized whichever budget ran out; fails_when=a GraphQL limit reads as core, or a permission 403 reads as a rate limit
  test('GraphQL, REST core and secondary limits; permission and server errors are not rate limits', () => {
    expect(rateLimitKind(['pr', 'view', '42'], GRAPHQL_LIMIT)).toBe('graphql');
    expect(rateLimitKind(['api', 'repos/o/r/pulls/42'], GRAPHQL_LIMIT)).toBe('graphql');
    expect(rateLimitKind(['api', 'graphql'], '{"errors":[{"type":"RATE_LIMITED","message":"API rate limit exceeded"}]}')).toBe('graphql');
    expect(rateLimitKind(['api', 'repos/o/r/commits/abc/check-runs'], CORE_LIMIT)).toBe('core');
    expect(rateLimitKind(['run', 'view', '9'], CORE_LIMIT)).toBe('core');
    expect(rateLimitKind(['pr', 'checks', '42'], 'gh: HTTP 429: too many requests')).toBe('graphql');
    expect(rateLimitKind(['api', 'repos/o/r/pulls/42'], SECONDARY_LIMIT)).toBe('secondary');
    expect(rateLimitKind(['api', 'repos/o/r/branches/main/protection'], 'gh: Resource not accessible by integration (HTTP 403)')).toBeNull();
    expect(rateLimitKind(['api', 'repos/o/r/pulls/42'], 'gh: Something went wrong (HTTP 502)')).toBeNull();
  });

  test('the wait runs to the exhausted resource\'s reset (plus slack); a secondary limit or an unreadable reply waits the floor', () => {
    const now = 1_794_020_000_000;
    expect(rateLimitWaitMs('graphql', exhausted('graphql', now / 1000 + 600), now, () => 0, NO_SEAM)).toBe(605_000);
    expect(rateLimitWaitMs('core', exhausted('core', now / 1000 + 30), now, () => 0, NO_SEAM)).toBe(60_000);
    expect(rateLimitWaitMs('graphql', RATE_LIMIT_JSON, now, () => 0, NO_SEAM)).toBe(60_000);
    expect(rateLimitWaitMs('secondary', exhausted('graphql', now / 1000 + 600), now, () => 0, NO_SEAM)).toBe(60_000);
    expect(rateLimitWaitMs('graphql', 'not json', now, () => 0, NO_SEAM)).toBe(60_000);
    expect(rateLimitWaitMs('graphql', exhausted('graphql', now / 1000 + 86_400), now, () => 0, NO_SEAM)).toBe(65 * 60_000);
  });
});

describe('a rate-limited call backs off until the reset, never retries at once', () => {
  const harness = (replies: GhResult[], limits = exhausted('graphql', 1_794_020_600)) => {
    const calls: string[][] = [];
    const sleeps: number[] = [];
    let clock = 1_794_020_000_000;
    const gh = withRateLimit(args => {
      calls.push(args);
      if (args[0] === 'api' && args[1] === 'rate_limit') return ok(limits);
      return replies.length > 1 ? replies.shift()! : replies[0]!;
    }, { sleep: ms => { sleeps.push(ms); clock += ms; }, now: () => clock, log: () => {}, random: () => 0, vars: NO_SEAM });
    return { gh, calls, sleeps };
  };

  // Value: protects=GraphQL quota recovery; fails_when=a rate-limited gh call is rerun immediately or in a short loop
  test('one rate limit: read rate_limit, sleep until the reset, rerun once', () => {
    const h = harness([err(GRAPHQL_LIMIT), ok('{"number":42}')]);
    expect(h.gh(['pr', 'view', '42']).stdout).toBe('{"number":42}');
    expect(h.calls).toEqual([['pr', 'view', '42'], ['api', 'rate_limit'], ['pr', 'view', '42']]);
    expect(h.sleeps).toEqual([605_000]);
  });

  test('a limit that persists gives up after MAX_LIMIT_WAITS waits, each at least the floor, and returns the failure', () => {
    const h = harness([err(SECONDARY_LIMIT)]);
    const result = h.gh(['api', 'repos/o/r/pulls/42']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('secondary rate limit');
    expect(h.calls.filter(c => c[1] !== 'rate_limit')).toHaveLength(MAX_LIMIT_WAITS + 1);
    expect(h.sleeps).toHaveLength(MAX_LIMIT_WAITS);
    for (const ms of h.sleeps) expect(ms).toBeGreaterThanOrEqual(MIN_POLL_MS);
  });

  // Value: protects=the land lock; fails_when=a rate-limited gh pr merge sleeps past PUSH_STALE_MS while another lander may break the lock
  test('a rate-limited gh pr merge fails at once: no rate_limit read, no sleep, no rerun', () => {
    const h = harness([err(GRAPHQL_LIMIT)]);
    expect(h.gh(['pr', 'merge', '42', '--squash', '--match-head-commit', 'abc']).status).toBe(1);
    expect(h.calls).toEqual([['pr', 'merge', '42', '--squash', '--match-head-commit', 'abc']]);
    expect(h.sleeps).toEqual([]);
  });

  test('success and real failures return at once: no rate_limit read, no sleep', () => {
    const h = harness([err('gh: Not Found (HTTP 404)')]);
    expect(h.gh(['api', 'repos/o/r/pulls/42']).status).toBe(1);
    expect(h.calls).toEqual([['api', 'repos/o/r/pulls/42']]);
    expect(h.sleeps).toEqual([]);
  });

  test("gstack-pr-wait's runGh throws a rate limit at once (transient, no 2 s retry), while a 502 still retries", () => {
    const sleeps: number[] = [];
    let calls = 0;
    const limited = { gh: () => { calls += 1; return err(GRAPHQL_LIMIT); }, sleep: (ms: number) => sleeps.push(ms), log: () => {} };
    let thrown: unknown;
    try { runGh(limited, ['api', 'graphql']); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(GhError);
    expect((thrown as GhError).transient).toBe(true);
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
    const flaky = [err('gh: Something went wrong (HTTP 502)'), ok('fine')];
    expect(runGh({ gh: () => flaky.shift()!, sleep: (ms: number) => sleeps.push(ms), log: () => {} }, ['api', 'x']).stdout).toBe('fine');
    expect(sleeps).toEqual([2_000]);
  });
});

describe('REST replies parse from recorded fixtures', () => {
  // Value: protects=the REST reads that replaced gh pr view and gh pr checks read GitHub's real shapes; fails_when=a merged PR reads OPEN, the head or base is lost, or a skipped check counts as failed
  test('pulls/{n}: merged and open pull requests in GraphQL spellings', () => {
    expect(parsePullState(fixture('pull-merged.json'))).toEqual({
      url: 'https://github.com/garrytan/gstack/pull/4101', state: 'MERGED', headRefOid: 'ff050059a9ebeeaa41618287f0f9687612174bbc',
      baseRefName: 'main', mergeStateStatus: 'UNKNOWN', author: 'garrytan', updatedAt: '2026-11-07T02:28:33Z',
    });
    const open = parsePullState(fixture('pull-open.json'))!;
    expect(open).toMatchObject({ state: 'OPEN', baseRefName: 'main', headRefOid: '8cadbdc985a6259842722f58c82f370f985fd39b' });
    expect(parsePullState(JSON.stringify({ ...JSON.parse(fixture('pull-open.json')), mergeable_state: 'behind' }))!.mergeStateStatus).toBe('BEHIND');
    expect(parsePullState(JSON.stringify({ ...JSON.parse(fixture('pull-open.json')), state: 'closed' }))!.state).toBe('CLOSED');
    expect(parsePullState(JSON.stringify({ ...JSON.parse(fixture('pull-open.json')), user: { login: 'capy-ai[bot]' } }))!.author).toBe('capy-ai');
    expect(parsePullState('{"message":"Not Found"}')).toBeNull();
    expect(parsePullState('not json')).toBeNull();
  });

  test('check-runs and status: 64 recorded runs become pass and skipping rows; re-runs supersede, contexts join, unknown conclusions fail closed', () => {
    const runs = JSON.parse(fixture('check-runs.json')).check_runs as Array<Record<string, unknown>>;
    const statuses = JSON.parse(fixture('status.json')).statuses as unknown[];
    const rows = parseHeadChecks(runs, statuses);
    expect(rows).toHaveLength(64);
    expect(rows.filter(r => r.bucket === 'pass')).toHaveLength(51);
    expect(rows.filter(r => r.bucket === 'skipping')).toHaveLength(13);
    expect(rows.find(r => r.name === 'free-tests')).toMatchObject({ bucket: 'pass', link: expect.stringContaining('https://github.com/garrytan/gstack/actions/runs/') });
    const first = runs.find(r => r.name === 'free-tests')!;
    const rerun = { ...first, id: Number(first.id) + 1, status: 'in_progress', conclusion: null, completed_at: null };
    const stale = { ...first, id: Number(first.id) + 2, name: 'old-check', conclusion: 'stale' };
    const synthetic = parseHeadChecks([first, rerun, stale], [{ context: 'ci/legacy', state: 'failure', target_url: 'https://ci.example/1', description: 'red' }, { context: 'ci/wait', state: 'pending' }]);
    expect(synthetic.map(r => [r.name, r.bucket])).toEqual([['free-tests', 'pending'], ['old-check', 'stale'], ['ci/legacy', 'fail'], ['ci/wait', 'pending']]);
  });

  test("gstack-pr-wait's fetchChecks reads the paginated lines and collapses one job's two workflow runs to the worst bucket", () => {
    const runs = JSON.parse(fixture('check-runs.json')).check_runs as Array<Record<string, unknown>>;
    const pushRun = { ...runs.find(r => r.name === 'free-tests')!, id: 1, conclusion: 'failure', check_suite: { id: 7 } };
    const calls: string[][] = [];
    const gh = (args: string[]): GhResult => {
      calls.push(args);
      if (args[2]!.includes('/check-runs')) return ok([...runs, pushRun].map(r => JSON.stringify(r)).join('\n'));
      return ok('');
    };
    const checks = fetchChecks({ gh, sleep: () => {}, log: () => {} }, 'garrytan/gstack', 'f'.repeat(40));
    expect(checks.size).toBe(new Set(runs.map(r => r.name)).size);
    expect(checks.get('free-tests')!.bucket).toBe('fail');
    expect(calls.map(c => c.slice(0, 3))).toEqual([
      ['api', '--paginate', `repos/garrytan/gstack/commits/${'f'.repeat(40)}/check-runs?per_page=100`],
      ['api', '--paginate', `repos/garrytan/gstack/commits/${'f'.repeat(40)}/status?per_page=100`],
    ]);
    expect(calls.some(c => c[0] === 'pr' || c[1] === 'graphql')).toBe(false);
  });
});

describe('waits sleep at least the floor', () => {
  // Value: protects=gstack-ci-carry wait and ship-release accept poll at most once a minute; fails_when=waitForRun sleeps its 15 or 20 s interval
  test('waitForRun sleeps pollDelayMs between reads, whatever intervalMs asks', async () => {
    const sleeps: number[] = [];
    let t = 0;
    let reads = 0;
    const deps = { runsForHead: () => { reads += 1; return [{ id: 1, run_attempt: 1, event: 'pull_request', status: 'in_progress', conclusion: null, created_at: '2026-11-06T00:00:00Z' }]; } } as never;
    const verdict = await waitForRun(deps, { workflow: 'free-tests.yml', events: ['pull_request'], head: 'a'.repeat(40), timeoutMs: 300_000, intervalMs: 15_000, sleep: async ms => { sleeps.push(ms); t += ms; }, clock: () => t, random: () => 0 });
    expect(verdict.state).toBe('running');
    expect(sleeps.length).toBeGreaterThan(0);
    for (const ms of sleeps) expect(ms).toBeGreaterThanOrEqual(MIN_POLL_MS);
    expect(reads).toBe(sleeps.length + 1);
  });
});
