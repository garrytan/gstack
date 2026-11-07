/**
 * gstack-pr-wait (lib/pr-wait.ts, lib/pr-wait-github.ts): one stdout line per
 * real event, state under the gstack state root, required checks from rulesets
 * so an unstarted one is pending, two identical polls before green, the
 * base-moved-and-touches-this-PR event, BEHIND and DIRTY, the per-PR lock, the
 * 6-hour baseline staleness and the configurable bot lists. Every GitHub read
 * goes through a fake gh runner, as test/gstack-ci-gate.test.ts does.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import type { GhResult } from '../lib/ci-gate';
import { DEFAULT_ADVISORY_BOTS, DEFAULT_GATING_BOTS, DEFAULT_TIMEOUT_MINUTES, PR_WAIT_EXIT, Watcher, botLists, parsePrTarget, parsePrWaitArgs, prWaitMain, stateDir, type PrWaitEnv, type PrWaitOptions } from '../lib/pr-wait';
import { GhError, runGh } from '../lib/pr-wait-github';
import { RESULT_CODES } from '../lib/result-codes';

const ROOT = join(import.meta.dir, '..');
const HEAD = 'a'.repeat(40);
const BASE_A = 'b'.repeat(40);
const BASE_B = 'c'.repeat(40);
const REPO = 'owner/project';

const ok = (stdout: string): GhResult => ({ status: 0, stdout, stderr: '' });
const err = (stderr: string, status = 1): GhResult => ({ status, stdout: '', stderr: `${stderr}\n` });
const NOT_FOUND = err('gh: Not Found (HTTP 404)');

interface Author { login: string; bot?: boolean }
const actor = ({ login, bot }: Author) => ({ login, __typename: bot ? 'Bot' : 'User' });
const comment = (id: string, author: Author, body: string) => ({ id, url: `https://github.com/${REPO}/pull/42#issuecomment-${id}`, body, author: actor(author) });
const review = (id: string, author: Author, state: string, body = '', commit: string | null = HEAD) =>
  ({ id, url: `https://github.com/${REPO}/pull/42#pullrequestreview-${id}`, state, body, commit: commit ? { oid: commit } : null, author: actor(author) });
const thread = (path: string, line: number | null, resolved: boolean, ...comments: ReturnType<typeof comment>[]) => ({ isResolved: resolved, path, line, comments: { nodes: comments } });

interface PrShape {
  state?: string; head?: string; base?: string; baseOid?: string | null; mergeState?: string;
  comments?: ReturnType<typeof comment>[]; reviews?: ReturnType<typeof review>[]; threads?: ReturnType<typeof thread>[];
}
const prJson = (shape: PrShape = {}) => JSON.stringify({
  data: {
    viewer: { login: 'me' },
    repository: {
      pullRequest: {
        url: `https://github.com/${REPO}/pull/42`, state: shape.state ?? 'OPEN', headRefOid: shape.head ?? HEAD,
        baseRefName: shape.base ?? 'main', mergeStateStatus: shape.mergeState ?? 'CLEAN', author: { login: 'author' },
        baseRef: shape.baseOid === null ? null : { target: { oid: shape.baseOid ?? BASE_A } },
        comments: { nodes: shape.comments ?? [] }, reviews: { nodes: shape.reviews ?? [] }, reviewThreads: { nodes: shape.threads ?? [] },
      },
    },
  },
});
const checksJson = (...rows: Array<[string, string] | [string, string, string]>) =>
  JSON.stringify(rows.map(([name, bucket, description]) => ({ name, bucket, link: `https://ci.example/${name}`, description: description ?? '' })));

/** The REST `pulls/{n}` reply for a scripted GraphQL PR reply: same facts, REST spellings; updated_at moves when the reply does. */
function restPull(graphql: string): string {
  const node = JSON.parse(graphql).data.repository.pullRequest;
  return JSON.stringify({
    html_url: node.url, state: node.state === 'OPEN' ? 'open' : 'closed', merged: node.state === 'MERGED', head: { sha: node.headRefOid },
    base: { ref: node.baseRefName }, mergeable_state: String(node.mergeStateStatus).toLowerCase(), user: { login: node.author.login },
    updated_at: `u-${graphql.length}-${[...graphql].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 0)}`,
  });
}
const CONCLUSION: Record<string, string> = { pass: 'success', fail: 'failure', skipping: 'skipped', cancel: 'cancelled' };
/** `gh pr checks`-shaped rows as the REST check-runs lines `gh api --paginate --jq '.check_runs[]'` prints, one suite per row. */
function restCheckRuns(result: GhResult): GhResult {
  if (result.status !== 0) return result;
  const rows = JSON.parse(result.stdout || '[]') as Array<{ name: string; bucket: string; link: string; description: string }>;
  return ok(rows.map((row, i) => JSON.stringify({
    id: i + 1, name: row.name, status: row.bucket === 'pending' ? 'in_progress' : 'completed', conclusion: row.bucket === 'pending' ? null : CONCLUSION[row.bucket] ?? row.bucket,
    completed_at: row.bucket === 'pending' ? null : '2026-11-06T00:00:00Z', details_url: row.link, output: { title: row.description }, app: { id: 15368 }, check_suite: { id: 100 + i },
  })).join('\n'));
}

/**
 * Scripted replies per gh command shape; a list is consumed one poll at a time, the last reply repeating. `pr` is the
 * GraphQL reply; each REST `pulls/{n}` read takes the next one and the GraphQL conversation read returns that same reply.
 * `checks` is `gh pr checks`-shaped and served as REST check runs.
 */
interface Script {
  pr?: string | string[];
  checks?: GhResult | GhResult[];
  rulesets?: GhResult;
  protection?: GhResult;
  prFiles?: GhResult;
  compare?: Record<string, GhResult>;
  behind?: GhResult;
}
function fakeGh(script: Script) {
  // Function declarations, not generic arrows: pregate's import scanner reads tests as TSX, where `<T>(x) =>` is a tag.
  function queue<T>(value: T | T[] | undefined): T[] { return value === undefined ? [] : Array.isArray(value) ? [...value] : [value]; }
  function next<T>(q: T[]): T | undefined { return q.length > 1 ? q.shift() : q[0]; }
  const prs = queue(script.pr);
  const checks = queue(script.checks);
  const calls: string[][] = [];
  let current = prJson();
  const gh = (args: string[]): GhResult => {
    calls.push(args);
    const a = args[0];
    const b = args[1] === '--paginate' ? args[2] : args[1];
    if (a === 'api' && b === 'graphql') return ok(current);
    if (a === 'api' && b === `repos/${REPO}/pulls/42`) {
      if (args.includes('.number')) return ok('42\n');
      current = next(prs) ?? prJson();
      return ok(restPull(current));
    }
    if (a === 'api' && b.includes('/check-runs')) return restCheckRuns(next(checks) ?? ok(checksJson()));
    if (a === 'api' && b.includes('/status')) return ok('');
    if (a === 'api' && b.includes('/git/ref/heads/')) {
      const oid = JSON.parse(current).data.repository.pullRequest.baseRef?.target.oid;
      return oid ? ok(`${oid}\n`) : NOT_FOUND;
    }
    if (a === 'pr' && b === 'diff') return script.prFiles ?? ok('');
    if (a === 'repo' && b === 'view') return ok(`${REPO}\n`);
    if (a === 'api' && b.includes('/rules/branches/')) return script.rulesets ?? NOT_FOUND;
    if (a === 'api' && b.includes('/protection/')) return script.protection ?? NOT_FOUND;
    if (a === 'api' && b.includes('/compare/')) {
      if (args.includes('.behind_by')) return script.behind ?? ok('0\n');
      return script.compare?.[b.split('/compare/')[1]] ?? ok('');
    }
    throw new Error(`fake gh: unexpected ${args.join(' ')}`);
  };
  return Object.assign(gh, { calls });
}

let dir: string;
let stdout: string[];
let stderr: string[];
let clock: number;
let alive: Set<number>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pr-wait-'));
  stdout = [];
  stderr = [];
  clock = 1_700_000_000_000;
  alive = new Set([4242]);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function env(gh: PrWaitEnv['gh'], pid = 4242, vars: Record<string, string> = {}): PrWaitEnv {
  return {
    gh, vars: { HOME: dir, GSTACK_STATE_ROOT: join(dir, 'state'), ...vars }, pid,
    now: () => clock, sleep: () => {}, out: t => stdout.push(t), err: t => stderr.push(t), pidAlive: p => alive.has(p),
  };
}
const watcher = (script: Script, until: PrWaitOptions['until'] = 'ready', vars: Record<string, string> = {}) => {
  const e = env(fakeGh(script), 4242, vars);
  return new Watcher(e, REPO, 42, until, 20, botLists(e.vars));
};
/** Run polls until one returns a code or the budget is spent; the first poll is the baseline. */
function pollUntilDone(w: Watcher, budget = 6): number | null {
  for (let i = 0; i < budget; i++) {
    const code = w.poll();
    if (code !== null) return code;
    w.save();
    w.baseline = false;
  }
  return null;
}
const lines = () => stdout.join('').split('\n').filter(Boolean);
const RULESETS = ok('free-tests\nwindows-free-tests\n');

describe('state lives under the gstack state root', () => {
  test('state file and lock are <root>/pr-wait/<owner>__<name>__<pr>, never ~/.local/state', () => {
    const w = watcher({});
    expect(w.stateFile).toBe(join(dir, 'state', 'pr-wait', 'owner__project__42.json'));
    expect(w.lockFile).toBe(join(dir, 'state', 'pr-wait', 'owner__project__42.lock'));
    expect(stateDir({ HOME: dir })).toBe(join(dir, '.gstack', 'pr-wait'));
    pollUntilDone(w, 1);
    expect(existsSync(w.stateFile)).toBe(true);
    expect(existsSync(join(dir, '.local'))).toBe(false);
  });

  test('a state file older than six hours is a fresh baseline: nothing from it is replayed and nothing new is reported on that poll', () => {
    const file = join(dir, 'state', 'pr-wait', 'owner__project__42.json');
    mkdirSync(join(dir, 'state', 'pr-wait'), { recursive: true });
    writeFileSync(file, JSON.stringify({ reported: [], summaries: {}, base_oid: BASE_A, merge_state: 'CLEAN' }));
    const old = new Date(clock - 7 * 3600 * 1000);
    utimesSync(file, old, old);
    const w = watcher({ pr: prJson({ comments: [comment('c1', { login: 'reviewer' }, 'looks wrong')] }) });
    expect(w.baseline).toBe(true);
    expect(w.poll()).toBeNull();
    expect(lines()).toEqual([]);
    const fresh = watcher({ pr: prJson({ comments: [comment('c1', { login: 'reviewer' }, 'looks wrong')] }) });
    expect(fresh.baseline).toBe(true);
  });

  test('a state file within six hours carries the baseline across a restart, so only what arrived meanwhile prints', () => {
    const first = watcher({ pr: prJson({ comments: [comment('c1', { login: 'reviewer' }, 'first')] }) });
    pollUntilDone(first, 1);
    expect(lines()).toEqual([]);
    clock += 60 * 60 * 1000;
    const restarted = watcher({ pr: prJson({ comments: [comment('c1', { login: 'reviewer' }, 'first'), comment('c2', { login: 'reviewer' }, 'second thought')] }) });
    expect(restarted.baseline).toBe(false);
    restarted.poll();
    expect(lines()).toEqual([expect.stringMatching(/^#42 comment from reviewer: second thought https:/)]);
  });
});

describe('events: one stdout line each, progress on stderr', () => {
  test('the baseline poll records what exists and prints nothing; the next poll prints only new comments, reviews and thread replies, never the author, the gh user, or edits', () => {
    const before = prJson({ comments: [comment('c1', { login: 'reviewer' }, 'old')] });
    const after = prJson({
      comments: [comment('c1', { login: 'reviewer' }, 'old, edited'), comment('c2', { login: 'author' }, 'mine'), comment('c3', { login: 'me' }, 'also mine'),
        comment('c4', { login: 'github-actions', bot: true }, 'deploy preview ready'), comment('c5', { login: 'reviewer' }, '<b>Please</b> &amp; fix &lt;this&gt;')],
      reviews: [review('r1', { login: 'reviewer' }, 'CHANGES_REQUESTED', 'nope'), review('r2', { login: 'lurker' }, 'COMMENTED', '')],
      threads: [thread('lib/x.ts', 12, false, comment('t1', { login: 'reviewer' }, 'rename this'), comment('t2', { login: 'author' }, 'done'))],
    });
    const w = watcher({ pr: [before, after] }, 'any-change');
    expect(w.run()).toBe(PR_WAIT_EXIT.met);
    expect(lines()).toEqual([
      '#42 comment from reviewer: Please & fix <this> https://github.com/owner/project/pull/42#issuecomment-c5',
      '#42 review from reviewer (changes requested): nope https://github.com/owner/project/pull/42#pullrequestreview-r1',
      '#42 new thread from reviewer on lib/x.ts:12: rename this https://github.com/owner/project/pull/42#issuecomment-t1',
    ]);
    expect(stderr.join('')).toContain('watching owner/project#42 until any-change; required checks: none set; every check on the head gates');
    expect(stderr.join('')).toContain('baseline recorded for owner/project#42');
  });

  test('merged ends with exit 0; closed without merging is PR_WAIT_BLOCKED', () => {
    expect(pollUntilDone(watcher({ pr: prJson({ state: 'MERGED' }) }))).toBe(0);
    expect(lines()).toEqual(['#42 merged: https://github.com/owner/project/pull/42']);
    stdout = [];
    expect(pollUntilDone(watcher({ pr: prJson({ state: 'CLOSED' }) }))).toBe(1);
    expect(lines()).toEqual(['#42 closed without merging: https://github.com/owner/project/pull/42', expect.stringContaining('stopped: action needed (PR_WAIT_BLOCKED; https://github.com/garrytan/gstack/blob/main/docs/troubleshooting.md#pr-wait-blocked)')]);
  });
});

describe('required checks and the green condition', () => {
  test('a required check named by the ruleset that has not started is pending, not green by omission', () => {
    const w = watcher({ rulesets: RULESETS, checks: ok(checksJson(['free-tests', 'pass'])) }, 'green');
    expect(pollUntilDone(w, 4)).toBeNull();
    expect(lines()).toEqual([]);
    expect(stderr.join('')).toContain('required checks: free-tests, windows-free-tests');
  });

  test('a required check that failed ends the watch at once, naming it with its link, even on the baseline poll', () => {
    const w = watcher({ rulesets: RULESETS, checks: ok(checksJson(['free-tests', 'fail'], ['windows-free-tests', 'pending'])) }, 'green');
    expect(w.poll()).toBe(PR_WAIT_EXIT.blocked);
    expect(lines()).toEqual(['#42 required check failed: free-tests https://ci.example/free-tests', expect.stringContaining('(PR_WAIT_BLOCKED;')]);
  });

  test('an unknown bucket counts as failed, as gstack-ci-gate counts it', () => {
    const w = watcher({ rulesets: RULESETS, checks: ok(checksJson(['free-tests', 'stale'], ['windows-free-tests', 'pass'])) }, 'green');
    expect(w.poll()).toBe(PR_WAIT_EXIT.blocked);
    expect(lines()[0]).toBe('#42 required check failed: free-tests https://ci.example/free-tests');
  });

  test('green needs two identical polls: a check set seen once is not stable', () => {
    const w = watcher({ rulesets: RULESETS, checks: [ok(checksJson(['free-tests', 'pass'], ['windows-free-tests', 'pass'])), ok(checksJson(['free-tests', 'pass'], ['windows-free-tests', 'pass'], ['late-check', 'pass']))], behind: ok('2\n') }, 'green');
    expect(w.poll()).toBeNull();
    w.baseline = false;
    expect(w.poll()).toBeNull();
    expect(w.poll()).toBe(PR_WAIT_EXIT.met);
    expect(lines()).toEqual(['#42 green on aaaaaaa: 3 pass; required 2/2 green; no greptile or macroscope yet; 0 unresolved threads; merge state CLEAN; 2 commits behind main']);
  });

  test('every check on the head gates, advisory bots\' own included, and a gating bot\'s review on the head makes it ready', () => {
    const pr = prJson({ reviews: [review('g1', { login: 'greptile-apps', bot: true }, 'COMMENTED', 'Confidence score: 4/5')] });
    const held = watcher({ pr, checks: ok(checksJson(['build', 'pass'], ['greptile-review', 'pass'], ['coderabbit', 'pending', 'Review in progress'])) });
    expect(pollUntilDone(held, 4)).toBeNull();
    expect(lines()).toEqual([]);
    const w = watcher({ pr, checks: ok(checksJson(['build', 'pass'], ['greptile-review', 'pass'], ['coderabbit', 'pass', 'Reviewed'])) });
    expect(pollUntilDone(w)).toBe(PR_WAIT_EXIT.met);
    expect(lines()).toEqual(['#42 coderabbit finished on aaaaaaa (advisory, not waited on)', '#42 ready on aaaaaaa: 3 pass; greptile done, coderabbit Reviewed (advisory); 0 unresolved threads; merge state CLEAN; 0 commits behind main']);
  });

  test('ready is blocked by unresolved threads and by BEHIND, in that order', () => {
    const base = { checks: ok(checksJson(['build', 'pass'])), rulesets: NOT_FOUND };
    const reviewed = review('g1', { login: 'greptile-apps', bot: true }, 'COMMENTED', '');
    expect(pollUntilDone(watcher({ ...base, pr: prJson({ reviews: [reviewed], threads: [thread('a.ts', 1, false, comment('t1', { login: 'reviewer' }, 'hm'))] }) }))).toBe(1);
    expect(lines()[0]).toBe('#42 blocked by 1 unresolved threads on aaaaaaa: https://github.com/owner/project/pull/42#issuecomment-t1');
    stdout = [];
    expect(pollUntilDone(watcher({ ...base, pr: prJson({ reviews: [reviewed], mergeState: 'BEHIND' }) }))).toBe(1);
    expect(lines()).toContain('#42 merge state is BEHIND on aaaaaaa: update the branch from main before merging');
  });
});

describe('base branch and merge state', () => {
  const compareKey = `${BASE_A}...${BASE_B}`;

  test('the base moved and its new commits touch files in this PR → one event naming the overlap', () => {
    const w = watcher({
      pr: [prJson({ baseOid: BASE_A }), prJson({ baseOid: BASE_B })],
      prFiles: ok('lib/pr-wait.ts\nREADME.md\n'),
      compare: { [compareKey]: ok('lib/pr-wait.ts\nCHANGELOG.md\n') },
    }, 'any-change');
    expect(pollUntilDone(w)).toBe(PR_WAIT_EXIT.met);
    expect(lines()).toEqual(['#42 main moved to ccccccc and touches files in this PR: lib/pr-wait.ts']);
  });

  test('the base moved without touching this PR → silence, and the new base oid is remembered', () => {
    const w = watcher({
      pr: [prJson({ baseOid: BASE_A }), prJson({ baseOid: BASE_B })],
      prFiles: ok('lib/pr-wait.ts\n'),
      compare: { [compareKey]: ok('CHANGELOG.md\n') },
    }, 'any-change');
    expect(pollUntilDone(w, 3)).toBeNull();
    expect(lines()).toEqual([]);
    expect(JSON.parse(readFileSync(w.stateFile, 'utf8')).base_oid).toBe(BASE_B);
  });

  test('a restarted watcher reports a base move that happened while no watcher ran', () => {
    const first = watcher({ pr: prJson({ baseOid: BASE_A }) });
    first.poll();
    first.save();
    const restarted = watcher({ pr: prJson({ baseOid: BASE_B }), prFiles: ok('x\n'), compare: { [compareKey]: ok('x\n') } }, 'any-change');
    expect(restarted.baseline).toBe(false);
    expect(restarted.poll()).toBe(PR_WAIT_EXIT.met);
    expect(lines()).toEqual(['#42 main moved to ccccccc and touches files in this PR: x']);
  });

  test('BEHIND is an event once per head, again after a push that stays BEHIND; DIRTY ends the watch as blocked', () => {
    const D = 'd'.repeat(40);
    const behind = watcher({ pr: [prJson({ mergeState: 'CLEAN' }), prJson({ mergeState: 'BEHIND' }), prJson({ mergeState: 'BEHIND' }), prJson({ mergeState: 'UNKNOWN', head: D }), prJson({ mergeState: 'BEHIND', head: D })], checks: ok(checksJson(['build', 'pending'])) }, 'green');
    expect(pollUntilDone(behind, 5)).toBeNull();
    expect(lines()).toEqual([
      '#42 merge state is BEHIND on aaaaaaa: update the branch from main before merging',
      '#42 merge state is BEHIND on ddddddd: update the branch from main before merging',
    ]);
    stdout = [];
    const dirty = watcher({ pr: prJson({ mergeState: 'DIRTY' }) }, 'green');
    expect(dirty.poll()).toBe(PR_WAIT_EXIT.blocked);
    expect(lines()[0]).toBe('#42 merge state is DIRTY on aaaaaaa: the branch conflicts with main, rebase it');
  });
});

describe('review bots are configuration', () => {
  const withConfig = (yaml: string) => {
    mkdirSync(join(dir, 'state'), { recursive: true });
    writeFileSync(join(dir, 'state', 'config.yaml'), yaml);
  };

  test('defaults are tstack\'s: greptile and macroscope gate, coderabbit is advisory', () => {
    expect(botLists({ HOME: dir, GSTACK_STATE_ROOT: join(dir, 'state') })).toEqual({ gating: ['greptile', 'macroscope'], advisory: ['coderabbit'] });
  });

  test('pr_wait_gating_bots decides which bot\'s review makes the PR ready', () => {
    withConfig('pr_wait_gating_bots: macroscope\n');
    const pr = prJson({ reviews: [review('g1', { login: 'greptile-apps', bot: true }, 'COMMENTED', '')] });
    const w = watcher({ pr, checks: [ok(checksJson(['build', 'pending'])), ok(checksJson(['build', 'pass']))] });
    expect(w.bots).toEqual({ gating: ['macroscope'], advisory: ['coderabbit'] });
    expect(pollUntilDone(w, 4)).toBeNull();
    expect(lines()).toEqual([expect.stringMatching(/^#42 checks finished on aaaaaaa: 1 pass; no macroscope yet; 0 unresolved threads; merge state CLEAN$/)]);
  });

  test('none empties a list', () => {
    withConfig('pr_wait_advisory_bots: none\n');
    expect(botLists({ HOME: dir, GSTACK_STATE_ROOT: join(dir, 'state') })).toEqual({ gating: ['greptile', 'macroscope'], advisory: [] });
  });

  test('pr_wait_advisory_bots: its review is reported but never waited on, while its check gates like any other', () => {
    withConfig('pr_wait_gating_bots: greptile\npr_wait_advisory_bots: coderabbit, Sourcery\n');
    const pr = prJson({ reviews: [review('g1', { login: 'greptile-apps', bot: true }, 'COMMENTED', '')] });
    const w = watcher({ pr, checks: ok(checksJson(['build', 'pass'], ['sourcery-ai', 'pass', 'Reviewed'])) });
    expect(w.bots.advisory).toEqual(['coderabbit', 'sourcery']);
    expect(pollUntilDone(w)).toBe(PR_WAIT_EXIT.met);
    expect(lines()[0]).toContain('ready on aaaaaaa: 2 pass; greptile done, sourcery Reviewed (advisory)');
  });
});

describe('the per-PR lock', () => {
  test('a live holder refuses the second watcher with PR_WAIT_REFUSED; a dead holder is taken over and released on exit', () => {
    const first = watcher({});
    expect(first.lock()).toBeNull();
    const second = new Watcher(env(fakeGh({}), 4343), REPO, 42, 'ready', 20, botLists({}));
    expect(second.lock()).toEqual({ held: '4242' });
    alive.clear();
    expect(second.lock()).toBeNull();
    expect(readFileSync(second.lockFile, 'utf8')).toBe('4343');
    first.unlock();
    expect(existsSync(second.lockFile)).toBe(true);
    second.unlock();
    expect(existsSync(second.lockFile)).toBe(false);
  });

  test('prWaitMain refuses a duplicate watcher before any poll', () => {
    const w = watcher({});
    expect(w.lock()).toBeNull();
    const gh = fakeGh({});
    const code = prWaitMain(['42', '--repo', REPO], env(gh, 9999));
    expect(code).toBe(PR_WAIT_EXIT.refused);
    expect(lines()).toEqual([expect.stringMatching(/^gstack-pr-wait: the watcher did not start, or a local error stopped it before a verdict — pid 4242 already watches owner\/project#42.*\(PR_WAIT_REFUSED; https:\/\/github\.com\/garrytan\/gstack\/blob\/main\/docs\/troubleshooting\.md#pr-wait-refused\)$/)]);
    expect(gh.calls.some(c => c[1] === 'graphql')).toBe(false);
  });
});

describe('arguments and the gh layer', () => {
  test('targets: number, #number, URL (repo from the URL), --repo override; bad input is refused', () => {
    expect(parsePrTarget('42')).toEqual({ repo: undefined, pr: 42 });
    expect(parsePrTarget('#42', REPO)).toEqual({ repo: REPO, pr: 42 });
    expect(parsePrTarget('https://github.com/garrytan/gstack/pull/3481/files')).toEqual({ repo: 'garrytan/gstack', pr: 3481 });
    expect(parsePrTarget('')).toMatchObject({ error: expect.stringContaining('missing PR number') });
    expect(parsePrTarget('abc')).toMatchObject({ error: "'abc' is not a PR number or PR URL" });
    expect(parsePrTarget('0')).toMatchObject({ error: "'0' is not a valid PR number" });
    expect(parsePrTarget('42', 'nope')).toMatchObject({ error: "'nope' is not owner/name" });
    expect(parsePrWaitArgs(['42', '--until', 'green', '--interval', '2'])).toEqual({ target: '42', until: 'green', interval: 60, timeout: 60, excludes: [] });
    expect(parsePrWaitArgs(['42', '--exclude', 'quality-gate, canary', '--exclude', 'canary'])).toMatchObject({ excludes: ['quality-gate', 'canary'] });
    expect(parsePrWaitArgs(['42', '--exclude', ' , '])).toMatchObject({ error: expect.stringContaining('--exclude needs') });
    expect(parsePrWaitArgs(['42', '--timeout', '0'])).toMatchObject({ timeout: 0 });
    expect(parsePrWaitArgs(['42', '--timeout', 'soon'])).toMatchObject({ error: expect.stringContaining('--timeout needs') });
    expect(parsePrWaitArgs(['--until', 'soon'])).toMatchObject({ error: expect.stringContaining('--until needs') });
    expect(parsePrWaitArgs(['--bogus'])).toMatchObject({ error: 'unknown argument --bogus' });
    expect(parsePrWaitArgs(['--help'])).toEqual({ help: true });
  });

  test('main: --help exits 0, bad input exits 2 with the code and anchor, an unreadable PR exits 2', () => {
    expect(prWaitMain(['--help'], env(fakeGh({})))).toBe(0);
    expect(stdout.join('')).toContain('--until');
    stdout = [];
    expect(prWaitMain([], env(fakeGh({})))).toBe(2);
    expect(lines()[0]).toMatch(/missing PR number.*\(PR_WAIT_REFUSED; .*#pr-wait-refused\)$/);
    stdout = [];
    const gone = (args: string[]): GhResult => (args[1] === `repos/${REPO}/pulls/42` ? err('gh: Not Found (HTTP 404)') : ok(''));
    expect(prWaitMain(['42', '--repo', REPO], env(gone))).toBe(2);
    expect(lines()[0]).toContain('cannot read owner/project#42: gh: Not Found (HTTP 404)');
    expect(RESULT_CODES.PR_WAIT_REFUSED.anchor).toBe('pr-wait-refused');
    expect(RESULT_CODES.PR_WAIT_BLOCKED.anchor).toBe('pr-wait-blocked');
  });

  test('a transient gh failure is retried with backoff and never ends the watch; a 403 on classic protection is logged, not fatal', () => {
    let graphqlCalls = 0;
    const base = fakeGh({ checks: ok(checksJson(['build', 'pass'])), protection: err('gh: Resource not accessible by integration (HTTP 403)') });
    const flaky = (args: string[]): GhResult => {
      if (args[1] === 'graphql' && graphqlCalls++ === 0) return err('gh: Something went wrong (HTTP 502)');
      return base(args);
    };
    const e = env(flaky);
    const w = new Watcher(e, REPO, 42, 'green', 20, botLists(e.vars));
    expect(w.poll()).toBeNull();
    expect(graphqlCalls).toBe(2);
    expect(stderr.join('')).toContain('gh api graphql: gh: Something went wrong (HTTP 502); retry in 2s');
    expect(stderr.join('')).toContain('could not read required checks from repos/owner/project/branches/main/protection/required_status_checks: gh: Resource not accessible by integration (HTTP 403)');
  });

  test('the bin runs on the isolated bun shebang and prints the usage', () => {
    const result = spawnSync(join(ROOT, 'bin', 'gstack-pr-wait'), ['--help'], { encoding: 'utf8', cwd: ROOT, timeout: 30_000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('gstack-config set pr_wait_gating_bots greptile,macroscope');
    expect(readFileSync(join(ROOT, 'bin', 'gstack-pr-wait'), 'utf8').startsWith('#!/usr/bin/env -S bun --no-env-file --config=/dev/null\n')).toBe(true);
  });
});

describe('pass-1 review fixes: gates agree, bounded waits, bot identity, local faults', () => {
  function withConfig(yaml: string) {
    mkdirSync(join(dir, 'state'), { recursive: true });
    writeFileSync(join(dir, 'state', 'config.yaml'), yaml);
  }
  const GREPTILE = review('g1', { login: 'greptile-apps', bot: true }, 'COMMENTED', '');

  test('green gates on every check on the head, as gstack-ci-gate does: a pending non-required check holds it and a red one blocks it', () => {
    const pending = watcher({ rulesets: RULESETS, checks: ok(checksJson(['free-tests', 'pass'], ['windows-free-tests', 'pass'], ['quality-gate', 'pending'])) }, 'green');
    expect(pollUntilDone(pending, 4)).toBeNull();
    expect(lines()).toEqual([]);
    const red = watcher({ rulesets: RULESETS, checks: ok(checksJson(['free-tests', 'pass'], ['windows-free-tests', 'pass'], ['quality-gate', 'fail'])) }, 'green');
    expect(red.poll()).toBe(PR_WAIT_EXIT.blocked);
    expect(lines()).toEqual(['#42 check failed: quality-gate https://ci.example/quality-gate', expect.stringContaining('(PR_WAIT_BLOCKED;')]);
  });

  // #3495 follow-up (ruled by GStack Minder, 2026-10-26): gstack-ci-gate --exclude has a watcher equivalent, so a non-required
  // check stuck in pending (a canary, a deploy preview) no longer holds --until green for the whole timeout.
  test('--exclude leaves a named non-required check out of the verdict: pending does not hold green, failed does not block; a required name is refused and gates', () => {
    const excluded = (script: Script, ...names: string[]) => {
      const e = env(fakeGh(script));
      return new Watcher(e, REPO, 42, 'green', 20, botLists(e.vars), DEFAULT_TIMEOUT_MINUTES, names);
    };
    const checks = ok(checksJson(['free-tests', 'pass'], ['windows-free-tests', 'pass'], ['quality-gate', 'pending']));
    const held = excluded({ rulesets: RULESETS, checks }, 'other-check');
    expect(pollUntilDone(held, 4)).toBeNull();
    expect(lines()).toEqual([]);
    const w = excluded({ rulesets: RULESETS, checks }, 'quality-gate');
    expect(pollUntilDone(w)).toBe(PR_WAIT_EXIT.met);
    expect(lines()).toEqual(['#42 green on aaaaaaa: 2 pass; required 2/2 green; no greptile or macroscope yet; 0 unresolved threads; merge state CLEAN; 0 commits behind main']);
    expect(stderr.join('')).toContain('excluded from the verdict: quality-gate');
    stdout = []; stderr = [];
    const red = excluded({ rulesets: RULESETS, checks: ok(checksJson(['free-tests', 'pass'], ['windows-free-tests', 'pass'], ['quality-gate', 'fail'])) }, 'quality-gate');
    expect(pollUntilDone(red)).toBe(PR_WAIT_EXIT.met);
    expect(lines()).toEqual([expect.stringMatching(/^#42 green on aaaaaaa: 2 pass;/)]);
    stdout = []; stderr = [];
    const refused = excluded({ rulesets: RULESETS, checks: ok(checksJson(['free-tests', 'fail'], ['windows-free-tests', 'pass'])) }, 'free-tests');
    expect(refused.poll()).toBe(PR_WAIT_EXIT.blocked);
    expect(lines()[0]).toBe('#42 required check failed: free-tests https://ci.example/free-tests');
    expect(stderr.join('')).toContain('exclude refused for required check free-tests: a required check gates');
    stdout = []; stderr = [];
    // When a required-check source cannot be read the set may be short, so nothing is excluded (gstack-ci-gate refuses its
    // overrides the same way): the excluded failure gates and the first poll says why.
    const unknown = excluded({ rulesets: err('gh: HTTP 403: rate limited', 1), checks: ok(checksJson(['free-tests', 'pass'], ['windows-free-tests', 'pass'], ['quality-gate', 'fail'])) }, 'quality-gate');
    expect(unknown.poll()).toBe(PR_WAIT_EXIT.blocked);
    expect(lines()[0]).toBe('#42 check failed: quality-gate https://ci.example/quality-gate');
    expect(stderr.join('')).toContain('exclude refused for quality-gate: the required checks could not be read, so every check gates');
    stdout = []; stderr = [];
    // Through main: the flag reaches the watcher.
    const e = env(fakeGh({ rulesets: RULESETS, checks }));
    expect(prWaitMain(['42', '--repo', REPO, '--until', 'green', '--exclude', 'quality-gate'], e)).toBe(PR_WAIT_EXIT.met);
    expect(lines()).toEqual([expect.stringMatching(/^#42 green on aaaaaaa: 2 pass;/)]);
  });

  test('a failed bot check is a failed check, gating or advisory, as gstack-ci-gate counts it; never a completed review', () => {
    const gating = watcher({ pr: prJson({ reviews: [] }), checks: ok(checksJson(['build', 'pass'], ['greptile-review', 'fail'])) });
    expect(pollUntilDone(gating)).toBe(PR_WAIT_EXIT.blocked);
    expect(lines()[0]).toBe('#42 check failed: greptile-review https://ci.example/greptile-review');
    stdout = [];
    const advisory = watcher({ pr: prJson({ reviews: [GREPTILE] }), checks: ok(checksJson(['build', 'pass'], ['coderabbit', 'fail'])) });
    expect(pollUntilDone(advisory)).toBe(PR_WAIT_EXIT.blocked);
    expect(lines()).toEqual([
      '#42 check failed: coderabbit https://ci.example/coderabbit',
      '#42 greptile finished on aaaaaaa',
      '#42 coderabbit finished on aaaaaaa: failed: coderabbit (advisory, not waited on)',
      expect.stringContaining('(PR_WAIT_BLOCKED;'),
    ]);
  });

  test('BEHIND is keyed on the head alone: a base that keeps moving does not repeat the line, even across restarts', () => {
    const first = watcher({ pr: [prJson({ mergeState: 'BEHIND', baseOid: BASE_A }), prJson({ mergeState: 'BEHIND', baseOid: BASE_B })], checks: ok(checksJson(['build', 'pending'])), prFiles: ok('x\n'), compare: { [`${BASE_A}...${BASE_B}`]: ok('') } }, 'any-change');
    expect(pollUntilDone(first, 3)).toBeNull();
    expect(lines()).toEqual([]);
    const restarted = watcher({ pr: prJson({ mergeState: 'BEHIND', baseOid: 'e'.repeat(40) }), checks: ok(checksJson(['build', 'pending'])), prFiles: ok('x\n'), compare: {} }, 'any-change');
    expect(restarted.baseline).toBe(false);
    expect(pollUntilDone(restarted, 3)).toBeNull();
    expect(lines()).toEqual([]);
  });

  test('a verdict keeps its exit code when the state file cannot be written; the save error goes to stderr', () => {
    const w = watcher({ pr: prJson({ state: 'MERGED' }) }, 'green');
    rmSync(join(dir, 'state'), { recursive: true, force: true });
    writeFileSync(join(dir, 'state'), '');
    expect(w.poll()).toBe(PR_WAIT_EXIT.met);
    expect(lines()).toEqual(['#42 merged: https://github.com/owner/project/pull/42']);
    expect(stderr.join('')).toContain('could not save state');
  });

  test('a bot owns logins that start with its name, so a person called notgreptile is a reviewer, not the gating bot', () => {
    const human = review('h1', { login: 'notgreptile' }, 'COMMENTED', 'looks fine');
    const w = watcher({ pr: [prJson({}), prJson({ reviews: [human] })], checks: ok(checksJson(['build', 'pass'])) });
    expect(pollUntilDone(w, 4)).toBeNull();
    expect(lines()).toEqual(['#42 review from notgreptile (commented): looks fine https://github.com/owner/project/pull/42#pullrequestreview-h1']);
  });

  test('ready with no gating bot configured is green plus the thread and merge-state checks', () => {
    withConfig('pr_wait_gating_bots: none\n');
    const w = watcher({ checks: ok(checksJson(['build', 'pass'])) });
    expect(w.bots.gating).toEqual([]);
    expect(pollUntilDone(w, 4)).toBe(PR_WAIT_EXIT.met);
    expect(lines()[0]).toContain('ready on aaaaaaa: 1 pass; no review bot yet');
  });

  test('ready waits while the merge state is UNKNOWN and is met once GitHub knows it', () => {
    const w = watcher({ pr: [prJson({ mergeState: 'UNKNOWN', reviews: [GREPTILE] }), prJson({ mergeState: 'UNKNOWN', reviews: [GREPTILE] }), prJson({ mergeState: 'UNKNOWN', reviews: [GREPTILE] }), prJson({ mergeState: 'CLEAN', reviews: [GREPTILE] })], checks: ok(checksJson(['build', 'pass'])) });
    expect(w.poll()).toBeNull();
    w.baseline = false;
    expect(w.poll()).toBeNull();
    expect(w.poll()).toBeNull();
    expect(lines()).toEqual([]);
    expect(w.poll()).toBe(PR_WAIT_EXIT.met);
    expect(lines()[0]).toContain('merge state CLEAN');
  });

  test('--timeout ends a watch that met nothing as PR_WAIT_BLOCKED, naming what is still pending; 0 waits without limit', () => {
    function timed(timeout: number) {
      const e = env(fakeGh({ checks: ok(checksJson(['build', 'pending'], ['docs', 'pass'])) }));
      e.sleep = ms => { clock += ms; };
      return new Watcher(e, REPO, 42, 'green', 20, botLists(e.vars), timeout);
    }
    expect(timed(1).run()).toBe(PR_WAIT_EXIT.blocked);
    expect(lines()).toEqual(['#42 gstack-pr-wait stopped: no green after 1 minutes; still pending: build', expect.stringContaining('(PR_WAIT_BLOCKED;')]);
    stdout = [];
    const forever = timed(0);
    let polls = 0;
    const poll = forever.poll.bind(forever);
    forever.poll = () => { polls += 1; return polls < 50 ? poll() : PR_WAIT_EXIT.met; };
    expect(forever.run()).toBe(PR_WAIT_EXIT.met);
    expect(polls).toBe(50);
  });

  test('run() ends as blocked after ten transient failures, and at once on a non-transient gh error', () => {
    const down = (): GhResult => err('gh: Something went wrong (HTTP 502)');
    const e = env(down);
    expect(new Watcher(e, REPO, 42, 'green', 20, botLists(e.vars)).run()).toBe(PR_WAIT_EXIT.blocked);
    expect(stderr.join('').match(/poll failed \(\d+\/10\)/g)).toHaveLength(10);
    expect(lines()[0]).toBe('#42 gstack-pr-wait stopped: GitHub unreachable for 10 polls: gh: Something went wrong (HTTP 502)');
    stdout = [];
    const gone = (args: string[]): GhResult => (args[1] === `repos/${REPO}/pulls/42` ? err('gh: Not Found (HTTP 404)') : ok(''));
    const e2 = env(gone);
    expect(new Watcher(e2, REPO, 42, 'green', 20, botLists(e2.vars)).run()).toBe(PR_WAIT_EXIT.blocked);
    expect(lines()[0]).toBe('#42 gstack-pr-wait stopped: gh: Not Found (HTTP 404)');
  });

  test('a gh spawn timeout is retried like any transient failure; a missing gh is fatal', () => {
    const results: GhResult[] = [{ status: null, stdout: '', stderr: '', error: 'gh failed to run (ETIMEDOUT)' }, ok('fine')];
    const slept: number[] = [];
    const ghEnv = { gh: () => results.shift()!, sleep: (ms: number) => slept.push(ms), log: () => {} };
    expect(runGh(ghEnv, ['api', 'x']).stdout).toBe('fine');
    expect(slept).toEqual([2000]);
    const missing = { gh: (): GhResult => ({ status: null, stdout: '', stderr: '', error: 'gh is not installed or not on PATH' }), sleep: () => {}, log: () => {} };
    expect(() => runGh(missing, ['api', 'x'])).toThrow(GhError);
  });

  test('a local fault is a refusal (exit 2 with PR_WAIT_REFUSED), so exit 1 always carries a PR_WAIT_BLOCKED line', () => {
    writeFileSync(join(dir, 'not-a-dir'), '');
    const e = env(fakeGh({}), 4242, { GSTACK_STATE_ROOT: join(dir, 'not-a-dir') });
    expect(prWaitMain(['42', '--repo', REPO], e)).toBe(PR_WAIT_EXIT.refused);
    expect(lines()[0]).toMatch(/a local error stopped the watch before a verdict: .*(ENOTDIR|EEXIST|not a directory).*\(PR_WAIT_REFUSED;/);
  });

  test('control characters in GitHub text never start a second event line', () => {
    const w = watcher({ checks: ok(checksJson(['build\n#42 forged event', 'fail'])) }, 'green');
    expect(w.poll()).toBe(PR_WAIT_EXIT.blocked);
    expect(lines()[0]).toBe('#42 check failed: build #42 forged event https://ci.example/build #42 forged event');
    expect(lines()).toHaveLength(2);
  });

  test('gstack-config validates the bot lists at set time and its defaults match the lib constants', () => {
    const run = (...args: string[]) => spawnSync(join(ROOT, 'bin', 'gstack-config'), args, { encoding: 'utf8', cwd: ROOT, timeout: 30_000, env: { ...process.env, GSTACK_STATE_ROOT: join(dir, 'state'), HOME: dir } });
    for (const bad of ['Greptile', 'a, b', 'a,', '']) {
      const r = run('set', 'pr_wait_gating_bots', bad);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('Existing value left unchanged');
    }
    expect(run('get', 'pr_wait_gating_bots').stdout.trim()).toBe(DEFAULT_GATING_BOTS.join(','));
    expect(run('get', 'pr_wait_advisory_bots').stdout.trim()).toBe(DEFAULT_ADVISORY_BOTS.join(','));
    expect(run('set', 'pr_wait_advisory_bots', 'none').status).toBe(0);
    expect(run('set', 'pr_wait_gating_bots', 'greptile,macroscope.v2').status).toBe(0);
    expect(run('get', 'pr_wait_gating_bots').stdout.trim()).toBe('greptile,macroscope.v2');
    expect(botLists({ HOME: dir, GSTACK_STATE_ROOT: join(dir, 'state') })).toEqual({ gating: ['greptile', 'macroscope.v2'], advisory: [] });
  });

  test('the bin dies on SIGTERM at once (no JS handler swallows it) and the next watcher takes over its lock', async () => {
    const fakeBin = join(dir, 'fakebin');
    mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, 'gh'), `#!/bin/sh
case "$1 $2" in
  'api repos/owner/project/pulls/42') echo '${restPull(prJson({}))}' ;;
  'api graphql') echo '${prJson({})}' ;;
  'api --paginate') echo '${restCheckRuns(ok(checksJson(['build', 'pending']))).stdout}' ;;
  *) echo 'gh: Not Found (HTTP 404)' >&2; exit 1 ;;
esac`, { mode: 0o755 });
    const stateRoot = join(dir, 'state');
    const child = spawn(join(ROOT, 'bin', 'gstack-pr-wait'), ['42', '--repo', REPO, '--interval', '5'], { cwd: ROOT, env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, GSTACK_STATE_ROOT: stateRoot, HOME: dir } });
    const lockFile = join(stateRoot, 'pr-wait', 'owner__project__42.lock');
    const started = Date.now();
    while (!existsSync(lockFile) && Date.now() - started < 15_000) await Bun.sleep(100);
    expect(existsSync(lockFile)).toBe(true);
    child.kill('SIGTERM');
    const ended = await Promise.race([
      new Promise<string>(resolve => child.on('exit', (code, signal) => resolve(`exit ${code} ${signal}`))),
      Bun.sleep(5_000).then(() => 'alive'),
    ]);
    expect(ended).toBe('exit null SIGTERM');
    expect(readFileSync(lockFile, 'utf8')).toBe(String(child.pid));
    const next = watcher({});
    expect(next.lock()).toBeNull();
    expect(readFileSync(lockFile, 'utf8')).toBe('4242');
  }, 30_000);
});

describe('GitHub budget (GST-1713): REST every poll, the GraphQL conversation read only when it can have changed', () => {
  const graphqlReads = (gh: ReturnType<typeof fakeGh>) => gh.calls.filter(c => c[1] === 'graphql').length;
  const run = (script: Script, until: PrWaitOptions['until'], polls: number, between: () => void = () => {}) => {
    const gh = fakeGh(script);
    const e = env(gh);
    const w = new Watcher(e, REPO, 42, until, 60, botLists(e.vars));
    for (let i = 0; i < polls; i++) { expect(w.poll()).toBeNull(); w.save(); w.baseline = false; between(); }
    return gh;
  };

  // Value: protects=the shared GraphQL quota; fails_when=gstack-pr-wait spends a GraphQL read (or gh pr checks) on every poll again
  test('an unchanged PR is read through GraphQL once across polls; checks and state never touch GraphQL', () => {
    const gh = run({ checks: ok(checksJson(['build', 'pending'])) }, 'green', 4);
    expect(graphqlReads(gh)).toBe(1);
    expect(gh.calls.some(c => c[0] === 'pr')).toBe(false);
    expect(gh.calls.filter(c => c.includes(`repos/${REPO}/pulls/42`))).toHaveLength(4);
  });

  test('a new comment (updated_at moves) or ten minutes reread the conversation; a ready watch rereads it once green', () => {
    const talk = comment('c9', { login: 'reviewer' }, 'please rename');
    const changed = run({ pr: [prJson(), prJson(), prJson({ comments: [talk] })], checks: ok(checksJson(['build', 'pending'])) }, 'green', 4);
    expect(graphqlReads(changed)).toBe(2);
    expect(lines()).toEqual([`#42 comment from reviewer: please rename https://github.com/${REPO}/pull/42#issuecomment-c9`]);
    expect(graphqlReads(run({ checks: ok(checksJson(['build', 'pending'])) }, 'green', 3, () => { clock += 10 * 60_000; }))).toBe(3);
    expect(graphqlReads(run({ checks: ok(checksJson(['build', 'pass'])) }, 'ready', 3))).toBe(3);
  });

  test('run() sleeps at least 60 s between polls, even when asked for 5', () => {
    const sleeps: number[] = [];
    const e = { ...env(fakeGh({ checks: ok(checksJson(['build', 'pending'])) })), sleep: (ms: number) => { sleeps.push(ms); clock += ms; } };
    expect(new Watcher(e, REPO, 42, 'green', 5, botLists(e.vars), 5).run()).toBe(PR_WAIT_EXIT.blocked);
    expect(sleeps.length).toBeGreaterThan(0);
    for (const ms of sleeps) expect(ms).toBeGreaterThanOrEqual(60_000);
  });
});

describe('state matrix cells (gstack-state-matrix: --until × bucket, merge state × --until, lock, baseline × event)', () => {
  const GREPTILE = review('g1', { login: 'greptile-apps', bot: true }, 'COMMENTED', '');

  test('ready × fail: exit 1 with the failed-check line and PR_WAIT_BLOCKED', () => {
    const w = watcher({ rulesets: RULESETS, checks: ok(checksJson(['free-tests', 'fail'], ['windows-free-tests', 'pass'])) });
    expect(w.poll()).toBe(PR_WAIT_EXIT.blocked);
    expect(lines()).toEqual(['#42 required check failed: free-tests https://ci.example/free-tests', expect.stringContaining('(PR_WAIT_BLOCKED;')]);
  });

  test('any-change × pass: silent while nothing is new; one "checks finished" line once the set turns stable, then exit 0', () => {
    const w = watcher({ checks: [ok(checksJson(['build', 'pending'])), ok(checksJson(['build', 'pass']))] }, 'any-change');
    expect(w.poll()).toBeNull();
    w.baseline = false;
    expect(w.poll()).toBeNull();
    expect(lines()).toEqual([]);
    expect(w.poll()).toBe(PR_WAIT_EXIT.met);
    expect(lines()).toEqual([expect.stringMatching(/^#42 checks finished on aaaaaaa: 1 pass; no greptile or macroscope yet; 0 unresolved threads; merge state CLEAN$/)]);
  });

  test('any-change × pending: silent, keeps polling', () => {
    expect(pollUntilDone(watcher({ checks: ok(checksJson(['build', 'pending'])) }, 'any-change'), 4)).toBeNull();
    expect(lines()).toEqual([]);
  });

  test('any-change × fail: the failed check is an event and the watch ends with exit 0, not blocked', () => {
    const w = watcher({ checks: [ok(checksJson(['build', 'pending'])), ok(checksJson(['build', 'fail']))] }, 'any-change');
    expect(pollUntilDone(w)).toBe(PR_WAIT_EXIT.met);
    expect(lines()).toEqual(['#42 check failed: build https://ci.example/build']);
  });

  test('BEHIND × any-change and DIRTY × any-change: one merge-state line each, exit 0, no PR_WAIT_BLOCKED', () => {
    const behind = watcher({ pr: [prJson({ mergeState: 'CLEAN' }), prJson({ mergeState: 'BEHIND' })], checks: ok(checksJson(['build', 'pending'])) }, 'any-change');
    expect(pollUntilDone(behind)).toBe(PR_WAIT_EXIT.met);
    expect(lines()).toEqual(['#42 merge state is BEHIND on aaaaaaa: update the branch from main before merging']);
    stdout = [];
    const dirty = watcher({ pr: [prJson({ mergeState: 'CLEAN' }), prJson({ mergeState: 'DIRTY' })], checks: ok(checksJson(['build', 'pending'])) }, 'any-change');
    expect(pollUntilDone(dirty)).toBe(PR_WAIT_EXIT.met);
    expect(lines()).toEqual(['#42 merge state is DIRTY on aaaaaaa: the branch conflicts with main, rebase it']);
  });

  test('DIRTY × ready: exit 1 with the DIRTY line and PR_WAIT_BLOCKED', () => {
    const w = watcher({ pr: prJson({ mergeState: 'DIRTY', reviews: [GREPTILE] }), checks: ok(checksJson(['build', 'pass'])) });
    expect(w.poll()).toBe(PR_WAIT_EXIT.blocked);
    expect(lines()).toEqual(['#42 merge state is DIRTY on aaaaaaa: the branch conflicts with main, rebase it', expect.stringContaining('(PR_WAIT_BLOCKED;')]);
  });

  test('UNKNOWN × green, UNKNOWN × any-change: no merge-state event; green is decided by the checks alone', () => {
    const green = watcher({ pr: prJson({ mergeState: 'UNKNOWN' }), checks: ok(checksJson(['build', 'pass'])) }, 'green');
    expect(pollUntilDone(green)).toBe(PR_WAIT_EXIT.met);
    expect(lines()).toEqual([expect.stringMatching(/^#42 green on aaaaaaa: 1 pass; no greptile or macroscope yet; 0 unresolved threads; merge state UNKNOWN; 0 commits behind main$/)]);
    expect(JSON.parse(readFileSync(green.stateFile, 'utf8')).merge_state).toBeNull();
    stdout = [];
    expect(pollUntilDone(watcher({ pr: prJson({ mergeState: 'UNKNOWN' }), checks: ok(checksJson(['build', 'pending'])) }, 'any-change'), 4)).toBeNull();
    expect(lines()).toEqual([]);
  });

  test('lock: free × unlock is a no-op; dead-pid × unlock leaves the stale file for the next lock() to take over', () => {
    const w = watcher({});
    expect(() => w.unlock()).not.toThrow();
    expect(existsSync(w.lockFile)).toBe(false);
    mkdirSync(join(w.lockFile, '..'), { recursive: true });
    writeFileSync(w.lockFile, '999999');
    w.unlock();
    expect(readFileSync(w.lockFile, 'utf8')).toBe('999999');
    expect(w.lock()).toBeNull();
    expect(readFileSync(w.lockFile, 'utf8')).toBe('4242');
  });

  test('restarted × required-check-failed and restarted × merged: the verdict line is printed again by the new process', () => {
    const first = watcher({ rulesets: RULESETS, checks: ok(checksJson(['free-tests', 'fail'], ['windows-free-tests', 'pass'])) }, 'green');
    expect(first.poll()).toBe(PR_WAIT_EXIT.blocked);
    stdout = [];
    const again = watcher({ rulesets: RULESETS, checks: ok(checksJson(['free-tests', 'fail'], ['windows-free-tests', 'pass'])) }, 'green');
    expect(again.baseline).toBe(false);
    expect(again.poll()).toBe(PR_WAIT_EXIT.blocked);
    expect(lines()[0]).toBe('#42 required check failed: free-tests https://ci.example/free-tests');
    stdout = [];
    const merged = watcher({ pr: prJson({ state: 'MERGED' }) }, 'green');
    expect(merged.baseline).toBe(false);
    expect(merged.poll()).toBe(PR_WAIT_EXIT.met);
    expect(lines()).toEqual(['#42 merged: https://github.com/owner/project/pull/42']);
  });
});

