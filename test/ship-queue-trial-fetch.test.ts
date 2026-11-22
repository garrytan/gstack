/**
 * gstack-ship-queue ready's trial merges (rule 14) fetch the PR heads this clone lacks in one git fetch under a time limit
 * (GST-3460). On gbrain #10011 ready printed nothing for minutes: each sibling PR's head came down in its own fetch, one at a
 * time, each allowed 120 s. Real fixture repos (bare origin plus working clone, PR heads under refs/pull/<n>/head) and a
 * logging upload-pack wrapper that counts fetches and can stall.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { CHECK_IDS } from '../lib/pregate/index';
import { trialMergeLines } from '../lib/ship-queue';
import { BASE_POLICY, cleanup, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/restamp-fixture';
import { ghQueueShim } from './helpers/ship-queue-fixture';
import { shippedBody } from './helpers/ship-queue-train-fixture';

const dirs: string[] = [];
const repos: FixtureRepo[] = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  while (repos.length) cleanup(repos.pop()!);
  delete process.env.GSTACK_TRIAL_FETCH_TIMEOUT_MS;
});

const STALLED = 'the trial-merge fetch time limit ran out';
const sh = (cwd: string, ...a: string[]) => {
  const r = spawnSync('git', ['-c', 'user.name=Fx', '-c', 'user.email=fx@example.com', ...a], { cwd, encoding: 'utf8', timeout: 30_000 });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};

/** An upload-pack that logs each fetch and, from fetch number `slowFrom` on, sleeps 30 s first. */
function uploadPack(dir: string, slowFrom = Infinity): { wrapper: string; count: () => number } {
  const log = path.join(dir, 'fetches.log');
  const wrapper = path.join(dir, 'upload-pack.sh');
  fs.writeFileSync(wrapper, `#!/bin/sh\necho x >> '${log}'\nn=$(wc -l < '${log}')\n[ "$n" -ge ${Number.isFinite(slowFrom) ? slowFrom : 999999} ] && sleep 30\nexec git-upload-pack "$@"\n`, { mode: 0o755 });
  return { wrapper, count: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0 };
}

/** A bare origin holding `n` sibling PR heads under refs/pull/<k>/head (k = 2..n+1), and a clone that has none of them. */
function queueOf(n: number, slowFrom?: number, gone?: number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-trial-fetch-'));
  dirs.push(root);
  const origin = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  sh(root, 'init', '-q', '--bare', '-b', 'main', origin);
  sh(root, 'init', '-q', '-b', 'main', seed);
  fs.writeFileSync(path.join(seed, 'a.txt'), 'a\n');
  sh(seed, 'add', '-A'); sh(seed, 'commit', '-q', '-m', 'base'); sh(seed, 'push', '-q', origin, 'main');
  const list: Array<{ number: number; headRefOid: string; files: Array<{ path: string }> }> = [];
  for (let k = 2; k <= n + 1; k++) {
    sh(seed, 'checkout', '-q', '-B', `pr-${k}`, 'main');
    fs.writeFileSync(path.join(seed, `pr-${k}.txt`), `${k}\n`); fs.appendFileSync(path.join(seed, 'a.txt'), `${k}\n`);
    sh(seed, 'add', '-A'); sh(seed, 'commit', '-q', '-m', `pr ${k}`);
    sh(seed, 'push', '-q', origin, `HEAD:refs/pull/${k}/head`);
    list.push({ number: k, headRefOid: sh(seed, 'rev-parse', 'HEAD'), files: [{ path: 'a.txt' }] });
  }
  const work = path.join(root, 'work');
  sh(root, 'clone', '-q', '--no-local', origin, work);
  const pack = uploadPack(root, slowFrom);
  sh(work, 'config', 'remote.origin.uploadpack', pack.wrapper);
  sh(work, 'checkout', '-q', '-b', 'mine', 'origin/main');
  fs.writeFileSync(path.join(work, 'b.txt'), 'b\n'); fs.appendFileSync(path.join(work, 'a.txt'), 'mine\n');
  sh(work, 'add', '-A'); sh(work, 'commit', '-q', '-m', 'mine');
  const head = sh(work, 'rev-parse', 'HEAD');
  const mine = { number: 1, headRefOid: head, files: [{ path: 'a.txt' }] };
  const progress: string[] = [];
  const run = () => trialMergeLines({ repoRoot: work, base: 'main', gh: () => ({ ok: true, out: JSON.stringify([mine, ...list, ...(gone ? [{ number: gone, headRefOid: '1234567890abcdef1234567890abcdef12345678', files: [{ path: 'a.txt' }] }] : [])]) }) }, '1', head, ['a.txt', 'b.txt'], l => progress.push(l));
  return { run, list, progress, fetches: pack.count };
}

describe('trial merges fetch the missing PR heads once, under a time limit (GST-3460)', () => {
  // Value: protects=ready on a long queue fetches every missing sibling head in one git fetch and says so before it starts;
  //   fails_when=each sibling's head is fetched on its own (gbrain #10011: minutes of silence, a 120 s allowance per fetch);
  //   why_new=no trial-merge test had a head missing from the clone; seam=trialMergeLines' fetch; no_claim=gh's own latency
  test('twelve missing sibling heads come down in one fetch, announced first, and every sibling is still trial-merged', () => {
    const q = queueOf(12);
    const lines = q.run();
    expect(q.fetches()).toBe(1);
    expect(q.progress).toHaveLength(1);
    expect(q.progress[0]).toMatch(/^TRIAL_MERGES: fetching 12 PR head\(s\) from origin \(time limit 60 s\): refs\/pull\/2\/head .* \(\+7 more\)$/);
    expect(lines).toHaveLength(12);
    for (const p of q.list) expect(lines).toContainEqual(expect.stringMatching(new RegExp(`^TRIAL_MERGES: #${p.number} ${p.headRefOid.slice(0, 12)} shares a.txt: CONFLICT in a.txt;`)));
  }, 120_000);

  // Value: protects=a combined fetch that fails fast (one sibling's ref is gone from origin) falls back to one fetch per ref
  //   and still trial-merges the rest; fails_when=the fallback loop is dropped or a failed fetch reads as a stall; why_new=no
  //   case had a ref missing from origin; seam=trialMergeLines' fallback; no_claim=the fallback's own time limit
  test('a combined fetch that fails without stalling falls back to one fetch per ref and still trial-merges the rest', () => {
    const q = queueOf(3, undefined, 9);
    const lines = q.run();
    expect(q.fetches()).toBe(5);
    expect(lines.filter(l => l.includes('CONFLICT in a.txt'))).toHaveLength(3);
    expect(lines).toContainEqual('TRIAL_MERGES: #9 1234567890ab shares a.txt: MISSING: its head is not in this clone after git fetch origin refs/pull/9/head, so no trial merge ran');
    expect(lines.join('\n')).not.toContain(STALLED);
  }, 120_000);

  // Value: protects=a fetch that stalls ends at the time limit with a line naming each ref it waited on, instead of a silent
  //   wait; fails_when=the fetch has no limit of its own or the stalled heads read as an ordinary missing head; why_new=the
  //   fixtures never stalled a fetch; seam=trialMergeLines' time limit; no_claim=how ready refuses it (the bin case below)
  test('a stalled fetch stops at the limit and names every ref it was waiting on', () => {
    process.env.GSTACK_TRIAL_FETCH_TIMEOUT_MS = '1500';
    const q = queueOf(2, 1);
    const started = Date.now();
    const lines = q.run();
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(lines).toEqual(q.list.map(p => `TRIAL_MERGES: #${p.number} ${p.headRefOid.slice(0, 12)} shares a.txt: MISSING: ${STALLED} (2 s) waiting on git fetch origin refs/pull/${p.number}/head, so no trial merge ran`));
  }, 60_000);
});

describe('ready refuses when the trial-merge fetch runs out of time (GST-3460)', () => {
  // Value: protects=ready fails closed, with a progress line first, when a sibling's head cannot be fetched in time;
  //   fails_when=ready waits on the fetch silently, or prints READY with the trial merge missing; why_new=no ready test had a
  //   sibling head missing from the clone; seam=ready -> trialMergeLines; no_claim=the train path's own ready
  test('a stalled sibling fetch prints a progress line, then refuses QUEUE_NOT_READY naming the ref', () => {
    const repo = makeFixtureRepo({ prefix: 'gstack-ready-trial-fetch-', policy: BASE_POLICY });
    repos.push(repo);
    repo.git('checkout', '-q', '-b', 'sib', 'origin/main');
    fs.writeFileSync(path.join(repo.work, 'shared.txt'), 'sibling\n');
    repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'sibling');
    const sibling = repo.git('rev-parse', 'HEAD');
    repo.git('push', '-q', 'origin', 'HEAD:refs/pull/3/head');
    repo.git('checkout', '-q', '-b', 'pr-2', 'origin/main');
    repo.git('branch', '-D', 'sib');
    repo.git('reflog', 'expire', '--expire=now', '--all');
    repo.git('gc', '-q', '--prune=now');
    fs.writeFileSync(path.join(repo.work, 'shared.txt'), 'mine\n');
    repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'mine');
    const head = repo.git('rev-parse', 'HEAD');
    expect(spawnSync('git', ['cat-file', '-e', `${sibling}^{commit}`], { cwd: repo.work, timeout: 30_000 }).status).not.toBe(0);
    const pregate = path.join(repo.root, 'pregate.json');
    fs.writeFileSync(pregate, JSON.stringify({ schema_version: 1, tree: runBin(repo, 'gstack-wtree', []).out.trim(), head, verdict: 'pass', checks: CHECK_IDS.map(id => ({ id, status: 'pass' })) }));
    const pr = { headRefOid: head, url: 'https://github.com/o/r/pull/2', headRefName: 'pr-2', isCrossRepository: false, body: shippedBody('2', head) };
    const shim = (list: unknown[]) => ghQueueShim(repo, { prs: { '2': pr }, list, checks: { [head]: { check_runs: [{ status: 'completed', conclusion: 'success' }] } } });
    const pack = uploadPack(repo.root);
    repo.git('config', 'remote.origin.uploadpack', pack.wrapper);
    const quiet = runBin(repo, 'gstack-ship-queue', ['ready', '--pr', '2', '--pregate', pregate, '--base', 'main'], shim([{ number: 2, headRefOid: head, files: [{ path: 'shared.txt' }] }]));
    expect([quiet.status, quiet.err]).toEqual([EXIT.ok, '']);
    fs.mkdirSync(path.join(repo.root, 'slow'));
    repo.git('config', 'remote.origin.uploadpack', uploadPack(path.join(repo.root, 'slow'), pack.count() + 1).wrapper);
    const r = runBin(repo, 'gstack-ship-queue', ['ready', '--pr', '2', '--pregate', pregate, '--base', 'main'], { ...shim([{ number: 2, headRefOid: head, files: [{ path: 'shared.txt' }] }, { number: 3, headRefOid: sibling, files: [{ path: 'shared.txt' }] }]), GSTACK_TRIAL_FETCH_TIMEOUT_MS: '1500' });
    expect(r.status).toBe(EXIT.refused);
    expect(r.err).toMatch(/^gstack-ship-queue ready: TRIAL_MERGES: fetching 1 PR head\(s\) from origin \(time limit 2 s\): refs\/pull\/3\/head$/m);
    expect(r.err).toContain('ran out of time waiting on git fetch origin refs/pull/3/head');
    expect(r.err).toContain('(QUEUE_NOT_READY)');
    expect(r.out).toContain(`TRIAL_MERGES: #3 ${sibling.slice(0, 12)} shares shared.txt: MISSING: ${STALLED}`);
    expect(r.out).not.toMatch(/^READY_RECEIPT:/m);
  }, 180_000);
});
