/**
 * Merge trains through the real bin/gstack-ship-queue (plan GSTA-49 lane T1),
 * headless against fixture repos outside the checkout (bare origin, lane and
 * coordinator clones, a hermetic git identity) with a stateful gh shim:
 * build (happy path, CHANGELOG union, conflict, fork, moved head, READY,
 * fill, free tests red/missing/stale/cancelled, dry run, ordering), dispatch
 * recovery (partial and absent dispatches), status rebuilt from
 * refs/notes/gstack-trains on a clean state root, verdict, bisect
 * (monotone, non-monotone, all green, red on main, capped and resumed
 * without repeats, prefix ancestry), rebuild-once and the INFRA
 * re-dispatch, verify (tree equality, mismatch, freeze, repair and clear),
 * prune, ready's screen choice, and the policy gate.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { mergeChangelogs, parseChangelog } from '../lib/changelog-check';
import { EXIT } from '../lib/headless-artifacts';
import { baseOverlap } from '../lib/ship-queue-train';
import { TRAIN_HELP } from '../lib/ship-queue-train-cli';
import { BASE_POLICY, cleanup, runBin } from './helpers/restamp-fixture';
import { coordinatorClone } from './helpers/ship-queue-fixture';
import {
  COMPLETE, FAIL, GREEN_GATE, PASS, RED_GATE, TRAIN_BLOCK, TRAIN_POLICY, dispatches, githubOrigin, line, mergeRefCommit, nonceOf, openPr, queue, readyReceipt, repoKey, setPrBody, shippedBody, trainFixture, trainJson, urlKey,
  type Rule, type TrainFixture,
} from './helpers/ship-queue-train-fixture';

const fixtures: TrainFixture[] = [];
const make = (policy: Record<string, unknown> = TRAIN_POLICY) => { const f = trainFixture(policy); fixtures.push(f); return f; };
afterEach(() => { while (fixtures.length) cleanup(fixtures.pop()!.repo); });

const result = (out: string) => line(out, 'GSTACK_RESULT:');
const next = (out: string) => line(out, 'NEXT:');
const remoteRefs = (fx: TrainFixture) => fx.repo.git('ls-remote', 'origin');

function twoPrTrain(fx: TrainFixture, gate: Rule = GREEN_GATE) {
  const h1 = openPr(fx, '1');
  const h2 = openPr(fx, '2');
  readyReceipt(fx, '1', h1);
  readyReceipt(fx, '2', h2);
  fx.write(d => { d.rules['evals.yml'] = gate; });
  const r = queue(fx, ['train', 'build', '--prs', `1@${h1},2@${h2}`]);
  return { h1, h2, r, nonce: nonceOf(r.out) };
}

/** A main commit with a prefix's tree plus a VERSION stamp, the way stamp-at-merge publishes it. */
function publishMain(fx: TrainFixture, prefixCommit: string, version: string, extra?: { file: string; text: string }): string {
  const { repo } = fx;
  repo.git('checkout', '-q', '-B', 'mainsim', 'origin/main');
  repo.git('rm', '-rq', '.');
  repo.git('checkout', prefixCommit, '--', '.');
  fs.writeFileSync(path.join(repo.work, 'VERSION'), version + '\n');
  if (extra) fs.writeFileSync(path.join(repo.work, extra.file), extra.text);
  repo.git('add', '-A');
  repo.git('commit', '-q', '-m', `merge to ${version}`);
  repo.git('push', '-q', 'origin', 'HEAD:refs/heads/main');
  repo.git('fetch', '-q', 'origin');
  return repo.git('rev-parse', 'HEAD');
}

// fails_when=coordinatorClone copies origin.git/objects file by file again, so an entry that appears or vanishes there mid-copy (the detached maintenance.lock every push into the fixture origin leaves) fails the clone, as in two Free Tests reds on 2026-10-28 (GSTA-139 ledger); why_new=no other test clones while origin's objects directory changes; seam=a dangling symlink planted under objects/, which a local copy refuses on every run; no_claim=which process removed the loose object those runs named
test('the coordinator clone reads origin through git, never by copying its objects directory (GSTA-139)', () => {
  const fx = make();
  fs.symlinkSync(path.join(fx.repo.root, 'gone'), path.join(fx.repo.origin, 'objects', 'maintenance.lock'));
  const coord = coordinatorClone(fx.repo);
  expect(spawnSync('git', ['-C', coord, 'rev-parse', 'origin/main'], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...fx.repo.env } }).stdout.trim()).toBe(fx.repo.git('rev-parse', 'origin/main'));
  expect(fs.existsSync(path.join(coord, '.git', 'objects', 'maintenance.lock'))).toBe(false);
});

describe('the train command surface', () => {
  test('train with no subcommand (flags only) prints the train help and exits usage; --help exits 0; bad arguments name what is missing', () => {
    const fx = make();
    const bare = queue(fx, ['train']);
    expect([bare.status, bare.out]).toEqual([EXIT.usage, TRAIN_HELP + '\n']);
    expect(queue(fx, ['train', '--help'])).toMatchObject({ status: EXIT.ok, out: TRAIN_HELP + '\n' });
    const noPins = queue(fx, ['train', 'build']);
    expect(noPins.status).toBe(EXIT.usage);
    expect(noPins.err).toContain('train build needs --prs <n>@<sha>[,...] or --train <nonce>');
    expect(queue(fx, ['train', 'build', '--prs', '1@abc', '--urgent', '--repair']).err).toContain('--urgent and --repair are separate one-PR trains; pass one');
    expect(fs.existsSync(path.join(fx.state, 'ship-queue'))).toBe(false);
  }, 60_000);
});

describe('the policy gate', () => {
  test('without a train block the train surface refuses with QUEUE_TRAIN_OFF and ready prints exactly today\'s block', () => {
    const fx = make(BASE_POLICY);
    const status = queue(fx, ['train', 'status']);
    expect(status.status).toBe(EXIT.refused);
    expect(status.err).toContain('declares no train block; the per-PR queue applies');
    expect(status.err).toContain('(QUEUE_TRAIN_OFF)');
    expect(next(status.out)).toBe('NEXT: none');
    expect(result(status.out)).toBe('GSTACK_RESULT: skill=ship-queue status=refused run=none');
    expect(queue(fx, ['verify', '--pr', '1', '--train', 'x']).err).toContain('(QUEUE_TRAIN_OFF)');
    const head = openPr(fx, '1');
    fx.write(d => { d.ci[head] = [{ status: 'completed', conclusion: 'success' }]; });
    const tree = runBin(fx.repo, 'gstack-wtree', []).out.trim();
    const pregate = path.join(fx.repo.root, 'pregate.json');
    fs.writeFileSync(pregate, JSON.stringify({ schema_version: 1, tree, head, verdict: 'pass', checks: [{ id: 'unit', status: 'pass' }] }));
    const today = queue(fx, ['ready', '--pr', '1', '--pregate', pregate]);
    expect(today.status).toBe(EXIT.ok);
    expect(today.out.split('\n')[0]).toBe(`READY #1 ${head} STAMP_VERSION=unstamped`);
    expect(today.out).not.toContain('NEXT:');
    expect(today.out).not.toContain('screen');
    expect(result(today.out)).toBe('GSTACK_RESULT: skill=ship-queue status=complete run=.gstack/tmp/pregate.json');
    const flagged = queue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--no-screen']);
    expect(flagged.out).toBe(today.out);
    expect(flagged.err).toContain('--screen/--no-screen/--broad ignored: the base policy declares no train block');
    expect(fs.existsSync(path.join(fx.state, 'ship-queue'))).toBe(false);
  }, 120_000);
});

describe('ready under a train policy: the screen choice', () => {
  function readyFixture() {
    const fx = make();
    const head = openPr(fx, '1');
    fx.write(d => { d.ci[head] = [{ status: 'completed', conclusion: 'success' }]; });
    const tree = runBin(fx.repo, 'gstack-wtree', []).out.trim();
    const pregate = path.join(fx.repo.root, 'pregate.json');
    fs.writeFileSync(pregate, JSON.stringify({ schema_version: 1, tree, head, verdict: 'pass', checks: [{ id: 'unit', status: 'pass' }] }));
    return { fx, head, pregate };
  }

  test('no choice refuses with the recommendation; --no-screen records a READY receipt in the block, the state root and the notes ref', () => {
    const { fx, head, pregate } = readyFixture();
    const none = queue(fx, ['ready', '--pr', '1', '--pregate', pregate]);
    expect(none.status).toBe(EXIT.refused);
    expect(none.err).toContain('(READY_SCREEN_CHOICE_REQUIRED)');
    expect(none.out).toContain('SCREEN: selection not computed (train.screen_selection is none)');
    expect(none.out).toContain('SCREEN: price pending the T0 cost replay (lib/gate-cost.ts)');
    expect(next(none.out)).toBe('NEXT: gstack-ship-queue ready --pr 1 --no-screen');
    const ok = queue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--no-screen']);
    expect(ok.status).toBe(EXIT.ok);
    expect(ok.out.split('\n').slice(0, 2)).toEqual([`READY #1 ${head} STAMP_VERSION=unstamped`, 'screen: no-screen']);
    const receipt = path.join(fx.state, 'ship-queue', 'ready', repoKey(fx), `1-${head}.json`);
    expect(JSON.parse(fs.readFileSync(receipt, 'utf8'))).toMatchObject({ kind: 'ready', pr: '1', head, ready_at: '2026-10-18T12:00:00.000Z', screen: { choice: 'no-screen' } });
    expect(result(ok.out)).toBe(`GSTACK_RESULT: skill=ship-queue status=complete run=${receipt}`);
    expect(remoteRefs(fx)).toContain('refs/notes/gstack-trains');
    expect(dispatches(fx)).toEqual([]);
  }, 120_000);

  test("GSTA-67: a lane whose origin is another URL form of the repository (#3331's git.capy.ai) writes its receipt under the owner/repo key", () => {
    const { fx, head, pregate } = readyFixture();
    githubOrigin(fx, 'https://git.capy.ai/fixture/repo.git');
    const ok = queue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--no-screen']);
    expect(ok.status).toBe(EXIT.ok);
    const canonical = urlKey('https://github.com/fixture/repo');
    expect(canonical).not.toBe(urlKey('https://git.capy.ai/fixture/repo'));
    expect(line(ok.out, 'READY_RECEIPT:')).toContain(path.join(fx.state, 'ship-queue', 'ready', canonical, `1-${head}.json`));
  }, 120_000);

  test("GSTA-67: ready refuses a head the Version Gate refuses (#3345's CHANGELOG replaced a released heading)", () => {
    const fx = make();
    const head = openPr(fx, '1', { changelog: cl => cl.replace('## [1.2.3.0] - 2026-10-01', '## [Unreleased]\n\n- #1 change') });
    fx.write(d => { d.ci[head] = [{ status: 'completed', conclusion: 'success' }]; });
    const tree = runBin(fx.repo, 'gstack-wtree', []).out.trim();
    const pregate = path.join(fx.repo.root, 'pregate.json');
    fs.writeFileSync(pregate, JSON.stringify({ schema_version: 1, tree, head, verdict: 'pass', checks: [{ id: 'unit', status: 'pass' }] }));
    const r = queue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--no-screen']);
    expect(r.status).toBe(EXIT.refused);
    expect(r.err).toContain(`the Version Gate refuses ${head.slice(0, 12)}: CHANGELOG.md drops released heading 1.2.3.0`);
    expect(r.err).toContain('(QUEUE_NOT_READY)');
    expect(fs.existsSync(path.join(fx.state, 'ship-queue', 'ready'))).toBe(false);
  }, 120_000);

  test('rule 22: READY needs the /ship receipt for this head in the PR body; none or another head refuses before any receipt is written, with no flag around it', () => {
    const { fx, head, pregate } = readyFixture();
    setPrBody(fx, '1', '## What changed\n\nno /ship ran\n');
    const none = queue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--no-screen']);
    expect(none.status).toBe(EXIT.refused);
    expect(none.out).toContain('SHIP_RECEIPT: none in the PR body');
    expect(none.err).toMatch(/PR #1's body carries no ship receipt; fix: run \/ship on the branch .*there is no flag to skip this \(QUEUE_RECEIPT_MISSING\)/);
    expect(next(none.out)).toBe('NEXT: fix the refusal, then gstack-ship-queue ready --pr 1 --screen|--no-screen');
    const other = 'd'.repeat(40);
    setPrBody(fx, '1', shippedBody('1', other));
    const stale = queue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--no-screen']);
    expect(stale.status).toBe(EXIT.refused);
    expect(stale.out).toContain(`SHIP_RECEIPT: pr=1 head=dddddddddddd version=- base=main`);
    expect(stale.err).toMatch(new RegExp(`PR #1's ship receipt is for dddddddddddd, not the head ${head.slice(0, 12)} being merged; fix: rerun /ship .*\\(QUEUE_RECEIPT_STALE\\)`));
    setPrBody(fx, '1', shippedBody('2', head));
    expect(queue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--no-screen']).err).toMatch(/PR #1's ship receipt names pr=2, not this PR.*\(QUEUE_RECEIPT_STALE\)/);
    expect(fs.existsSync(path.join(fx.state, 'ship-queue', 'ready'))).toBe(false);
    setPrBody(fx, '1', shippedBody('1', head, { version: '1.2.4.0', session_kind: 'unattended' }));
    const ok = queue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--no-screen']);
    expect(ok.status).toBe(EXIT.ok);
    expect(line(ok.out, 'SHIP_RECEIPT:')).toBe(`SHIP_RECEIPT: pr=1 head=${head.slice(0, 12)} version=1.2.4.0 base=main session_kind=unattended`);
    expect(fs.existsSync(path.join(fx.state, 'ship-queue', 'ready', repoKey(fx), `1-${head}.json`))).toBe(true);
  }, 120_000);

  test('--screen dispatches one screen with the PR, its merge SHA and the policy; a repeat adopts it; a broad screen never adopts the narrow one', () => {
    const { fx, head, pregate } = readyFixture();
    const mergeSha = fx.repo.git('ls-remote', 'origin', 'refs/pull/1/merge').split(/\s/)[0]!;
    expect(mergeSha).not.toBe(head);
    const dry = queue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--screen', '--dry-run']);
    expect(dry.status).toBe(EXIT.ok);
    expect(line(dry.out, 'SCREEN_DISPATCH:')).toMatch(new RegExp(`^SCREEN_DISPATCH: evals\\.yml --ref main evals_all=false expected_sha=${mergeSha} nonce=pr\\.screen\\.narrow-\\S+ base_ref=main base_sha=[0-9a-f]{40} screen_pr=1 screen_merge_sha=${mergeSha} screen_policy=narrow \\(dry run: not dispatched\\)$`));
    expect(dispatches(fx)).toEqual([]);
    fx.write(d => { d.rules['evals.yml'] = { status: 'in_progress', conclusion: null }; });
    const first = queue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--screen']);
    expect(first.status).toBe(EXIT.ok);
    expect(first.out.split('\n')[1]).toMatch(/^screen: screen policy=narrow nonce=pr\.screen\.narrow-\S+ run=100$/);
    const again = queue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--screen']);
    expect(again.out).toContain('SCREEN_DISPATCH: following run 100 (same merge SHA, base and policy; no duplicate)');
    const broad = queue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--screen', '--broad']);
    expect(broad.status).toBe(EXIT.ok);
    expect(dispatches(fx).map(d => (d.inputs as any).screen_policy)).toEqual(['narrow', 'broad']);
    expect(queue(fx, ['ready', '--pr', '1', '--broad']).status).toBe(EXIT.usage);
  }, 120_000);

  // Value: protects=--screen never dispatches against a merge ref GitHub has not recomputed for the PR head (GSTA-95 on #3431: a stale ref made evals.yml plan 0 cases and report success): a lagging, missing or unfetchable ref is replaced by a scratch merge of the head onto current main (#3465), and an unreachable remote is still refused;
  // fails_when=the merge ref's parents are not compared with the PR head and current main, or the scratch merge is skipped; why_new=the --screen test above only sees a fresh merge ref; seam=none; no_claim=GitHub's real recompute timing (a bare origin stands in)
  test('--screen plans the screen on a scratch merge when refs/pull/<n>/merge lags the PR head, is missing or cannot be fetched; an unreachable remote is POLICY_SOURCE_UNAVAILABLE; a recomputed merge ref is used as is', () => {
    const { fx, head, pregate } = readyFixture();
    const { repo } = fx;
    fs.appendFileSync(path.join(repo.work, 'pr-1.txt'), 'pushed after the merge ref was computed\n');
    repo.git('commit', '-qam', 'more');
    const moved = repo.git('rev-parse', 'HEAD');
    repo.git('push', '-q', '-f', 'origin', 'HEAD:refs/pull/1/head');
    fx.write(d => { (d.prs['1'] as any).headRefOid = moved; (d.prs['1'] as any).body = shippedBody('1', moved); d.ci[moved] = [{ status: 'completed', conclusion: 'success' }]; });
    const pregate2 = path.join(repo.root, 'pregate2.json');
    fs.writeFileSync(pregate2, JSON.stringify({ schema_version: 1, tree: runBin(repo, 'gstack-wtree', []).out.trim(), head: moved, verdict: 'pass', checks: [{ id: 'unit', status: 'pass' }] }));
    const stale = queue(fx, ['ready', '--pr', '1', '--pregate', pregate2, '--screen', '--dry-run']);
    expect([stale.status, stale.err]).toEqual([EXIT.ok, '']);
    expect(line(stale.out, 'SCREEN_MERGE:')).toMatch(new RegExp(`^SCREEN_MERGE: scratch merge [0-9a-f]{12} of #1@${moved.slice(0, 12)} onto main@[0-9a-f]{12} \\(refs/pull/1/merge [0-9a-f]{12} merges ${head.slice(0, 12)}, not ${moved.slice(0, 12)}\\); would push screen/1-${moved.slice(0, 12)} \\(dry run\\)$`));
    repo.git('push', '-q', 'origin', ':refs/pull/1/merge');
    const missing = queue(fx, ['ready', '--pr', '1', '--pregate', pregate2, '--screen', '--dry-run']);
    expect([missing.status, missing.err]).toEqual([EXIT.ok, '']);
    expect(line(missing.out, 'SCREEN_MERGE:')).toContain('(origin has no refs/pull/1/merge); would push');
    const tree = repo.git('rev-parse', `${moved}^{tree}`);
    const main = repo.git('rev-parse', 'origin/main');
    const badMerge = spawnSync('git', ['-C', repo.origin, 'hash-object', '-t', 'commit', '-w', '--stdin', '--literally'], { input: `tree ${tree}\nparent ${main}\nparent ${moved}\nauthor A <a@example.com> 1700000000 +0000\ncommitter B 1700000000 +0000\n\nmerge without a committer email\n`, encoding: 'utf8', timeout: 30_000 }).stdout.trim();
    spawnSync('git', ['-C', repo.origin, 'update-ref', 'refs/pull/1/merge', badMerge], { timeout: 30_000 });
    repo.git('config', 'fetch.fsckObjects', 'true');
    const unfetchable = queue(fx, ['ready', '--pr', '1', '--pregate', pregate2, '--screen', '--dry-run']);
    expect([unfetchable.status, unfetchable.err]).toEqual([EXIT.ok, '']);
    expect(line(unfetchable.out, 'SCREEN_MERGE:')).toMatch(/\(refs\/pull\/1\/merge [0-9a-f]{12} could not be fetched\); would push/);
    repo.git('config', '--unset', 'fetch.fsckObjects');
    const originUrl = repo.git('remote', 'get-url', 'origin');
    repo.git('remote', 'set-url', 'origin', path.join(repo.root, 'no-such-origin.git'));
    const unlisted = queue(fx, ['ready', '--pr', '1', '--pregate', pregate2, '--screen']);
    repo.git('remote', 'set-url', 'origin', originUrl);
    expect(unlisted.status).toBe(EXIT.refused);
    expect(unlisted.err).toMatch(/git fetch origin main failed: .*\(POLICY_SOURCE_UNAVAILABLE\)/);
    expect(unlisted.err.split('\n').filter(Boolean).length).toBe(1);
    expect(dispatches(fx)).toEqual([]);
    expect(fs.existsSync(path.join(fx.state, 'ship-queue', 'ready'))).toBe(false);
    repo.git('push', '-q', '-f', 'origin', `${mergeRefCommit(fx, moved)}:refs/pull/1/merge`);
    const fresh = queue(fx, ['ready', '--pr', '1', '--pregate', pregate2, '--screen', '--dry-run']);
    expect([fresh.status, fresh.err]).toEqual([EXIT.ok, '']);
    expect(line(fresh.out, 'SCREEN_MERGE:')).toMatch(new RegExp(`^SCREEN_MERGE: GitHub's refs/pull/1/merge [0-9a-f]{12} merges the head ${moved.slice(0, 12)} onto main@[0-9a-f]{12}$`));
    expect(line(fresh.out, 'SCREEN_DISPATCH:')).toContain('(dry run: not dispatched)');
    expect(repo.git('ls-remote', 'origin', 'refs/heads/screen/*')).toBe('');
  }, 120_000);

  // Value: protects=a finished screen that planned 0 cases never counts as a screen: ready dispatches a fresh one instead of adopting it and train build seats the slot unscreened with a SCREEN: line;
  // fails_when=the census is not read (a not-run screen is followed, or ORDER says screened); why_new=no test reads a screen run's record; seam=none; no_claim=evals.yml's real artifact (the shim's record stands in)
  test('a screen run that planned 0 cases is not followed by ready and is counted as not-run by train build', () => {
    const { fx, head, pregate } = readyFixture();
    fx.write(d => { d.rules['evals.yml'] = { status: 'completed', conclusion: 'success', plan: null }; });
    const first = queue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--screen']);
    expect(first.status).toBe(EXIT.ok);
    expect(line(first.out, 'SCREEN_DISPATCH:')).toMatch(/^SCREEN_DISPATCH: evals\.yml run 100 /);
    const again = queue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--screen']);
    expect(again.status).toBe(EXIT.ok);
    expect(line(again.out, 'SCREEN_DISPATCH:')).toMatch(/^SCREEN_DISPATCH: evals\.yml run 101 .* \(not following run 100 planned no cases \(no paid-plan artifact; concluded success\): a screen that planned nothing is not a screen\)$/);
    expect(dispatches(fx, 'evals.yml').length).toBe(2);
    const build = queue(fx, ['train', 'build', '--prs', `1@${head}`, '--dry-run']);
    expect(build.status).toBe(EXIT.ok);
    expect(line(build.out, 'SCREEN:')).toBe('SCREEN: #1 run 101 planned no cases (no paid-plan artifact; concluded success); counted as not-run, the slot rides unscreened');
    expect(line(build.out, 'ORDER:')).toBe('ORDER: 1:#1(unscreened)');
    fx.write(d => { d.rules['evals.yml'] = { status: 'completed', conclusion: 'success', plan: { planned: 0 } }; });
    const emptyPlan = queue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--screen']);
    expect(line(emptyPlan.out, 'SCREEN_DISPATCH:')).toMatch(/^SCREEN_DISPATCH: evals\.yml run 102 .*not following run 101 planned no cases/);
    fx.write(d => { d.rules['evals.yml'] = { status: 'completed', conclusion: 'success', plan: { planned: 3 }, binding: { verdict: 'GREEN' } }; });
    const live = queue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--screen']);
    expect(live.status).toBe(EXIT.ok);
    expect(line(live.out, 'SCREEN_DISPATCH:')).toMatch(/^SCREEN_DISPATCH: evals\.yml run 103 .*not following run 102 planned no cases \(an empty plan manifest; concluded success\)/);
    const followed = queue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--screen']);
    expect(followed.status).toBe(EXIT.ok);
    expect(line(followed.out, 'SCREEN_DISPATCH:')).toBe('SCREEN_DISPATCH: following run 103 (same merge SHA, base and policy; no duplicate)');
    expect(dispatches(fx, 'evals.yml').length).toBe(4);
    const liveBuild = queue(fx, ['train', 'build', '--prs', `1@${head}`, '--dry-run']);
    expect([liveBuild.status, line(liveBuild.out, 'ORDER:'), line(liveBuild.out, 'SCREEN:')]).toEqual([EXIT.ok, 'ORDER: 1:#1(screened)', 'SCREEN: #1 run 103 GREEN']);
    fx.write(d => { for (const run of d.runs) if ((run as any).databaseId === 103) Object.assign(run, { status: 'in_progress', conclusion: null }); });
    const runningBuild = queue(fx, ['train', 'build', '--prs', `1@${head}`, '--dry-run']);
    expect([runningBuild.status, line(runningBuild.out, 'ORDER:'), line(runningBuild.out, 'SCREEN:')]).toEqual([EXIT.ok, 'ORDER: 1:#1(screened)', 'SCREEN: #1 run 103 still running; counted as screened']);
    fx.write(d => { for (const run of d.runs) if ((run as any).databaseId === 103) Object.assign(run, { status: 'completed', conclusion: 'success' }); });
    fx.write(d => { d.rules['evals.yml'] = { status: 'completed', conclusion: 'success' }; d.artifacts['103']['paid-plan'] = { reuse: 'confirmed' }; });
    const unreadable = queue(fx, ['train', 'build', '--prs', `1@${head}`, '--dry-run']);
    expect([unreadable.status, line(unreadable.out, 'ORDER:'), line(unreadable.out, 'SCREEN:')]).toEqual([EXIT.ok, 'ORDER: 1:#1(screened)', "SCREEN: #1 run 103's paid-plan manifest.json is unreadable; counted as screened, unverified"]);
    const stillFollowed = queue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--screen']);
    expect(line(stillFollowed.out, 'SCREEN_DISPATCH:')).toBe('SCREEN_DISPATCH: following run 103 (same merge SHA, base and policy; no duplicate)');
    fx.write(d => { (d as any).expired = { '103': true }; });
    const expired = queue(fx, ['train', 'build', '--prs', `1@${head}`, '--dry-run']);
    expect([expired.status, line(expired.out, 'ORDER:'), line(expired.out, 'SCREEN:')]).toEqual([EXIT.ok, 'ORDER: 1:#1(screened)', "SCREEN: #1 run 103's paid-plan artifact has expired; counted as screened, unverified"]);
    fx.write(d => { (d as any).expired = {}; d.runs = d.runs.filter(r => (r as any).databaseId !== 103); });
    const gone = queue(fx, ['train', 'build', '--prs', `1@${head}`, '--dry-run']);
    expect([gone.status, line(gone.out, 'ORDER:'), line(gone.out, 'SCREEN:')]).toEqual([EXIT.ok, 'ORDER: 1:#1(screened)', 'SCREEN: #1 run 103 is unreadable; counted as screened, unverified']);
    fx.write(d => { (d as any).repo = ''; });
    const noSlug = queue(fx, ['train', 'build', '--prs', `1@${head}`, '--dry-run']);
    expect([noSlug.status, line(noSlug.out, 'ORDER:'), line(noSlug.out, 'SCREEN:')]).toEqual([EXIT.ok, 'ORDER: 1:#1(screened)', 'SCREEN: #1 the repository slug is unreadable; counted as screened, unverified']);
  }, 120_000);
});

describe('train build', () => {
  test('happy path: slot order, prefix trees, CHANGELOG union, records before effects, free tests then one paid dispatch by nonce; resume and identical pins never dispatch again', () => {
    const fx = make();
    const { h1, h2, r, nonce } = twoPrTrain(fx);
    expect(r.status).toBe(EXIT.ok);
    expect(nonce).toMatch(/^gate\.train-[0-9a-f]{12}-[0-9a-f]{12}-[0-9a-f]{6}$/);
    const t = trainJson(fx, nonce);
    expect(t).toMatchObject({ schema: 1, kind: 'train', state: 'gate-pending', branch: `train/${nonce}`, slots: [{ pr: '1', head: h1 }, { pr: '2', head: h2 }] });
    expect(t.prefixes.map((p: any) => [p.index, p.pr])).toEqual([[0, null], [1, '1'], [2, '2']]);
    expect(t.prefixes[0].commit).toBe(fx.repo.git('rev-parse', 'origin/main'));
    expect(t.prefixes[2].commit).toBe(t.head);
    expect(r.out).toContain(`PREFIX: T2 ${t.head} tree=${t.tree} (+#2)`);
    expect(remoteRefs(fx)).toContain(`${t.head}\trefs/heads/train/${nonce}`);
    expect(remoteRefs(fx)).toContain('refs/notes/gstack-trains');
    const changelog = fx.repo.git('show', `${t.head}:CHANGELOG.md`);
    expect(changelog).toContain('- #1 change');
    expect(changelog).toContain('- #2 change');
    expect(fx.repo.git('show', `${t.head}:pr-1.txt`)).toBe('change from #1');
    const sent = dispatches(fx);
    expect(sent.map(d => [d.workflow, d.ref])).toEqual([['free-tests.yml', `train/${nonce}`], ['evals.yml', `train/${nonce}`]]);
    expect(sent[1]!.inputs).toEqual({ evals_all: 'true', expected_sha: t.head, nonce });
    expect(t.effects.map((e: any) => e.what)).toEqual(expect.arrayContaining(['train.json written', `branch pushed: train/${nonce} at ${t.head.slice(0, 12)}`]));
    expect(next(r.out)).toBe(`NEXT: gstack-ship-queue train verdict --train ${nonce}`);
    expect(result(r.out)).toBe(`GSTACK_RESULT: skill=ship-queue status=complete run=${path.join(fx.state, 'ship-queue', 'trains', nonce, 'train.json')}`);
    const resume = queue(fx, ['train', 'build', '--train', nonce]);
    expect(resume.status).toBe(EXIT.ok);
    const same = queue(fx, ['train', 'build', '--prs', `1@${h1},2@${h2}`]);
    expect(nonceOf(same.out)).toBe(nonce);
    expect(dispatches(fx).length).toBe(2);
  }, 180_000);

  test('--dry-run prints order, trees and the estimate, and writes, pushes and dispatches nothing', () => {
    const fx = make();
    const h1 = openPr(fx, '1');
    readyReceipt(fx, '1', h1);
    const r = queue(fx, ['train', 'build', '--prs', `1@${h1}`, '--dry-run']);
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toContain('ORDER: 1:#1(unscreened)');
    expect(r.out).toMatch(/^PREFIX: T1 [0-9a-f]{40} tree=[0-9a-f]{40} \(\+#1\)$/m);
    expect(r.out).toContain('ESTIMATE: one evals.yml full gate (evals_all) on T1 plus free-tests.yml; dollar figure pending the T0 cost replay');
    expect(result(r.out)).toBe('GSTACK_RESULT: skill=ship-queue status=complete run=none');
    expect(fs.existsSync(path.join(fx.state, 'ship-queue', 'trains'))).toBe(false);
    expect(remoteRefs(fx)).not.toContain('refs/heads/train/');
    expect(dispatches(fx)).toEqual([]);
  }, 120_000);

  test('a conflict stops the train at that PR with the exact recovery line; nothing pushed or dispatched', () => {
    const fx = make();
    const h1 = openPr(fx, '1', { file: 'same.txt', text: 'one\n', changelog: false });
    const h2 = openPr(fx, '2', { file: 'same.txt', text: 'two\n', changelog: false });
    readyReceipt(fx, '1', h1);
    readyReceipt(fx, '2', h2);
    const r = queue(fx, ['train', 'build', '--prs', `1@${h1},2@${h2}`]);
    expect(r.status).toBe(EXIT.fail);
    expect(line(r.out, 'QUEUE_TRAIN_CONFLICT:')).toMatch(new RegExp(`^QUEUE_TRAIN_CONFLICT: train [0-9a-f]{12} stopped at #2 \\(conflicts: same\\.txt\\) after merging #1; nothing dispatched, no branch pushed; fix: gstack-ship-queue train build --prs 1@${h1}$`));
    expect(r.err).toContain('(QUEUE_TRAIN_CONFLICT)');
    expect(next(r.out)).toBe(`NEXT: gstack-ship-queue train build --prs 1@${h1}`);
    expect(remoteRefs(fx)).not.toContain('refs/heads/train/');
    expect(dispatches(fx)).toEqual([]);
  }, 120_000);

  // Handoff GSTA-119 / #3485: a pooled pin the base moved onto is named with the files, and the conflict is found while the
  // train is still filling instead of at dispatch time; a base move onto files the PR leaves alone is silent.
  test('a pin whose files main moved onto gets the base-overlap line; a conflict with main is QUEUE_TRAIN_CONFLICT at slot 1 even while the train fills', () => {
    const fx = make();
    const h1 = openPr(fx, '1', { file: 'same.txt', text: 'one\n' });
    const h2 = openPr(fx, '2');
    readyReceipt(fx, '1', h1, { at: '2026-10-18T11:00:00.000Z' });
    readyReceipt(fx, '2', h2, { at: '2026-10-18T11:00:00.000Z' });
    const { repo } = fx;
    repo.git('checkout', '-q', '-B', 'mainsim', 'origin/main');
    fs.writeFileSync(path.join(repo.work, 'same.txt'), 'main\n');
    fs.writeFileSync(path.join(repo.work, 'unrelated.txt'), 'main\n');
    repo.git('add', '-A');
    repo.git('commit', '-qm', 'main moves onto same.txt');
    repo.git('push', '-q', 'origin', 'HEAD:refs/heads/main');
    repo.git('checkout', '-q', 'pr-1');
    const main = repo.git('rev-parse', 'origin/main');
    const r = queue(fx, ['train', 'build', '--prs', `2@${h2},1@${h1}`]);
    expect(r.status).toBe(EXIT.fail);
    // At build the line is the files alone: the chain merges each pin onto its prefix, and that merge is the verdict.
    expect(line(r.out, '#1 BASE_OVERLAP:')).toBe(`#1 BASE_OVERLAP: main moved to ${main.slice(0, 7)} and touches files in this PR: same.txt`);
    expect(r.out).not.toContain('#2 BASE');
    expect(line(r.out, 'QUEUE_TRAIN_CONFLICT:')).toMatch(new RegExp(`stopped at #1 \\(conflicts: same\\.txt\\) after merging (\\(none\\)|#2); nothing dispatched, no branch pushed; fix: gstack-ship-queue train build --prs 2@${h2}$`));
    expect(r.out).not.toContain('MERGE_CHECK:');
    expect(remoteRefs(fx)).not.toContain('refs/heads/train/');
    expect(dispatches(fx)).toEqual([]);
    const without = queue(fx, ['train', 'build', '--prs', `2@${h2}`]);
    expect(without.status).toBe(EXIT.refused);
    expect(without.err).toContain('(QUEUE_TRAIN_WAITING)');
    expect(line(without.out, 'MERGE_CHECK:')).toBe(`MERGE_CHECK: T1..T1 merge clean onto main@${main.slice(0, 12)} (dry run in object storage; nothing pushed)`);
    // A git read that fails is never "no overlap" (pre-landing review, pass 1): the comparison is reported as unknown.
    const unknown = baseOverlap(repo.work, 'main', main, 'f'.repeat(40), TRAIN_POLICY as any);
    expect(unknown).toMatchObject({ unknown: true, touched: [], conflicts: null });
    expect(unknown.line).toMatch(new RegExp(`^BASE_OVERLAP: could not compare main@${main.slice(0, 12)} with ffffffffffff \\(.+\\); conflicts unknown$`));
    // At build the overlap line carries the files alone; the verdict is the chain's.
    expect(baseOverlap(repo.work, 'main', main, h1, TRAIN_POLICY as any, false).line).toBe(`BASE_OVERLAP: main moved to ${main.slice(0, 7)} and touches files in this PR: same.txt`);
  }, 120_000);

  test("GSTA-67: a PR whose CHANGELOG drops a released heading (#3345's pin 1eb7092) is a CHANGELOG conflict, never merged with the damage", () => {
    const fx = make();
    const h1 = openPr(fx, '1');
    const h2 = openPr(fx, '2', { changelog: cl => cl.replace('## [1.2.3.0] - 2026-10-01', '## [Unreleased]\n\n- #2 change') });
    readyReceipt(fx, '1', h1);
    readyReceipt(fx, '2', h2);
    const r = queue(fx, ['train', 'build', '--prs', `1@${h1},2@${h2}`, '--dry-run']);
    expect(r.status).toBe(EXIT.fail);
    expect(line(r.out, 'QUEUE_TRAIN_CONFLICT:')).toContain('stopped at #2 (conflicts: CHANGELOG.md (ours drops released heading 1.2.3.0 that the merge base carries)) after merging #1');
    expect(dispatches(fx)).toEqual([]);
  }, 120_000);

  // Value: protects=a stacked child in a slot after the first is gated on the carried CHANGELOG, its released parent's text never duplicated under a second [Unreleased]; fails_when=mergeStep unions the uncarried child when the prefix already holds an earlier slot's [Unreleased] (the two-[Unreleased] guard returns null, so the carry is lost); why_new=the train 24 test below releases the parent after the train is built and the slot-1 chain never reaches the union; seam=none; no_claim=how the post-merge verify reads a two-[Unreleased] prefix
  test("a stacked child behind another slot: the gated tree carries the child past its released parent instead of repeating the parent's text under its own [Unreleased]", () => {
    const fx = make();
    const { repo } = fx;
    const h1 = openPr(fx, '1', { changelog: cl => cl.replace('# Changelog\n', '# Changelog\n\n## [Unreleased]\n\n**Parent entry of #1.**\n\n### Changed\n- #1 change, the first wording\n- #1 second bullet, unchanged\n') });
    const h2 = openPr(fx, '2', { from: 'pr-1', changelog: cl => cl.replace('## [Unreleased]\n\n**Parent entry of #1.**', '## [Unreleased]\n\n**Child entry of #2.**\n\n### Changed\n- #2 change\n\n**Parent entry of #1.**').replace('- #1 change, the first wording', '- #1 change, the better wording') });
    // #1 is released as 1.2.4.0 before the train; #3 forks from that main and takes the first slot, #2 the second.
    const main1 = publishMain(fx, h1, '1.2.4.0', { file: 'CHANGELOG.md', text: repo.git('show', `${h1}:CHANGELOG.md`).replace('## [Unreleased]', '## [1.2.4.0] - 2026-10-18') + '\n' });
    const h3 = openPr(fx, '3');
    readyReceipt(fx, '3', h3);
    readyReceipt(fx, '2', h2);
    fx.write(d => { d.rules['evals.yml'] = GREEN_GATE; });
    const r = queue(fx, ['train', 'build', '--prs', `3@${h3},2@${h2}`, '--order', '3,2']);
    expect([r.status, r.err]).toEqual([EXIT.ok, '']);
    expect(line(r.out, 'ORDER:')).toBe('ORDER: 1:#3(unscreened) 2:#2(unscreened) (explicit --order)');
    const t = trainJson(fx, nonceOf(r.out));
    const gated = parseChangelog(repo.git('show', `${t.prefixes[2].commit}:CHANGELOG.md`) + '\n');
    expect(gated.sections.map(s => s.version ?? 'Unreleased')).toEqual(['Unreleased', 'Unreleased', '1.2.4.0', '1.2.3.0', '1.2.2.0']);
    const own = gated.sections[0]!.lines.join('\n');
    expect(own).toContain('**Child entry of #2.**');
    expect(own).toContain('- Correction to the 1.2.4.0 entry below: "first" should read "better".');
    expect(own).not.toContain('Parent entry of #1');
    expect(gated.sections[1]!.lines.join('\n')).toContain('- #3 change');
    const released = parseChangelog(repo.git('show', `${main1}:CHANGELOG.md`) + '\n').sections[0]!;
    expect(gated.sections[2]!.lines.join('\n').replace(/\n+$/, '')).toBe(released.lines.join('\n').replace(/\n+$/, ''));
  }, 120_000);

  test("GSTA-67: READY receipts under any URL form of the repository admit (#3331's receipt was keyed on git.capy.ai, the coordinator's origin on github.com)", () => {
    const fx = make();
    githubOrigin(fx, 'https://github.com/fixture/repo.git');
    const h1 = openPr(fx, '1');
    const h2 = openPr(fx, '2');
    readyReceipt(fx, '1', h1, { key: urlKey('https://git.capy.ai/fixture/repo') });
    readyReceipt(fx, '2', h2, { key: urlKey('https://github.com/fixture/repo') });
    const r = queue(fx, ['train', 'build', '--prs', `1@${h1},2@${h2}`, '--dry-run']);
    expect(r.status).toBe(EXIT.ok);
    expect(line(r.out, 'ORDER:')).toBe('ORDER: 1:#1(unscreened) 2:#2(unscreened)');
    const h3 = openPr(fx, '3');
    readyReceipt(fx, '3', h3, { key: urlKey('https://gitlab.com/fixture/repo') });
    expect(queue(fx, ['train', 'build', '--prs', `3@${h3}`, '--dry-run']).err).toMatch(/no READY receipt for #3 .*\(QUEUE_NOT_READY\)/);
  }, 120_000);

  test('GSTA-67 --order: an explicit slot order (#3343 catalog before the #3337 docs that describe it) replaces READY order and carries into NEXT; the default is unchanged', () => {
    const fx = make();
    const docs = openPr(fx, '3337');
    const catalog = openPr(fx, '3343');
    readyReceipt(fx, '3337', docs, { at: '2026-10-18T07:00:00.000Z' });
    readyReceipt(fx, '3343', catalog, { at: '2026-10-18T08:00:00.000Z' });
    const pins = `3337@${docs},3343@${catalog}`;
    expect(line(queue(fx, ['train', 'build', '--prs', pins, '--dry-run']).out, 'ORDER:')).toBe('ORDER: 1:#3337(unscreened) 2:#3343(unscreened)');
    const dry = queue(fx, ['train', 'build', '--prs', pins, '--order', '3343,3337', '--dry-run']);
    expect(dry.status).toBe(EXIT.ok);
    expect(line(dry.out, 'ORDER:')).toBe('ORDER: 1:#3343(unscreened) 2:#3337(unscreened) (explicit --order)');
    expect(dry.out).toMatch(new RegExp(`^SLOT: 1 #3343 head=${catalog} `, 'm'));
    expect(next(dry.out)).toBe(`NEXT: gstack-ship-queue train build --prs 3343@${catalog},3337@${docs} --order 3343,3337`);
    const partial = queue(fx, ['train', 'build', '--prs', pins, '--order', '3343']);
    expect(partial.status).toBe(EXIT.refused);
    expect(partial.err).toContain('--order must list every PR in --prs exactly once (--prs has #3337,#3343; got 3343)');
    expect(queue(fx, ['train', 'build', '--train', 'x', '--order', '3343']).status).toBe(EXIT.usage);
    fx.write(d => { d.rules['evals.yml'] = GREEN_GATE; });
    const real = queue(fx, ['train', 'build', '--prs', pins, '--order', '3343,3337']);
    expect(real.status).toBe(EXIT.ok);
    const t = trainJson(fx, nonceOf(real.out));
    expect([t.slots.map((s: any) => s.pr), t.explicit_order, t.prefixes[1].pr]).toEqual([['3343', '3337'], true, '3343']);
  }, 180_000);

  test('refusals: a fork PR, a moved head, a PR without READY, and a train still filling (until --urgent)', () => {
    const fx = make();
    const h1 = openPr(fx, '1');
    const h2 = openPr(fx, '2', { cross: true });
    readyReceipt(fx, '1', h1);
    readyReceipt(fx, '2', h2);
    const fork = queue(fx, ['train', 'build', '--prs', `1@${h1},2@${h2}`]);
    expect(fork.status).toBe(EXIT.refused);
    expect(fork.err).toMatch(/PR #2's head repository is not the base repository.*\(QUEUE_TRAIN_UNTRUSTED\)/);
    expect(next(fork.out)).toBe(`NEXT: gstack-ship-queue train build --prs 1@${h1}`);
    const moved = queue(fx, ['train', 'build', '--prs', `1@${'f'.repeat(40)}`]);
    expect(moved.err).toMatch(/PR #1 moved: pinned ffffffffffff, head is now .*\(QUEUE_TRAIN_MOVED\)/);
    const h3 = openPr(fx, '3');
    const notReady = queue(fx, ['train', 'build', '--prs', `3@${h3}`]);
    expect(notReady.err).toMatch(/no READY receipt for #3 .*\(QUEUE_NOT_READY\)/);
    readyReceipt(fx, '3', h3, { at: '2026-10-18T11:00:00.000Z' });
    const filling = queue(fx, ['train', 'build', '--prs', `3@${h3}`]);
    expect(filling.status).toBe(EXIT.refused);
    expect(filling.err).toMatch(/1 of 5 PRs; the oldest READY dispatches at 2026-10-18T14:00:00\.000Z.*\(QUEUE_TRAIN_WAITING\)/);
    expect(result(filling.out)).toBe('GSTACK_RESULT: skill=ship-queue status=incomplete run=none');
    // #3485: the scratch merges run before the fill rule, so a WAITING result also proves the seated pins merge clean.
    expect(line(filling.out, 'MERGE_CHECK:')).toBe(`MERGE_CHECK: T1..T1 merge clean onto main@${fx.repo.git('rev-parse', 'origin/main').slice(0, 12)} (dry run in object storage; nothing pushed)`);
    fx.write(d => { d.rules['evals.yml'] = GREEN_GATE; });
    const urgent = queue(fx, ['train', 'build', '--prs', `3@${h3}`, '--urgent']);
    expect(urgent.status).toBe(EXIT.ok);
    expect(trainJson(fx, nonceOf(urgent.out)).urgent).toBe(true);
    expect(dispatches(fx, 'evals.yml').length).toBe(1);
  }, 180_000);

  test('rule 22: a pin whose PR body has no current /ship receipt is refused by name before any write, push or dispatch, dry run included; the pinned-head receipt admits it', () => {
    const fx = make();
    const h1 = openPr(fx, '1');
    const h2 = openPr(fx, '2', { shipped: false });
    readyReceipt(fx, '1', h1);
    readyReceipt(fx, '2', h2);
    fx.write(d => { d.rules['evals.yml'] = GREEN_GATE; });
    const refsBefore = remoteRefs(fx);
    for (const args of [['--dry-run'], []]) {
      const r = queue(fx, ['train', 'build', '--prs', `1@${h1},2@${h2}`, ...args]);
      expect(r.status).toBe(EXIT.refused);
      expect(r.err).toMatch(/PR #2's body carries no ship receipt; fix: run \/ship on the branch .*\(QUEUE_RECEIPT_MISSING\)/);
      expect(r.out).toContain('SHIP_RECEIPT: none in the PR body');
      expect(next(r.out)).toBe("NEXT: #2's lane runs /ship, then gstack-ship-queue ready --pr 2 --screen|--no-screen; then gstack-ship-queue train build --prs <pins>");
      expect(result(r.out)).toBe('GSTACK_RESULT: skill=ship-queue status=refused run=none');
    }
    setPrBody(fx, '2', shippedBody('2', 'a'.repeat(40)));
    const stale = queue(fx, ['train', 'build', '--prs', `1@${h1},2@${h2}`, '--dry-run']);
    expect(stale.status).toBe(EXIT.refused);
    expect(stale.err).toMatch(new RegExp(`PR #2's ship receipt is for aaaaaaaaaaaa, not the head ${h2.slice(0, 12)} being merged.*\\(QUEUE_RECEIPT_STALE\\)`));
    setPrBody(fx, '2', '```gstack-ship-receipt\n{"schema_version":1}\n```\n');
    expect(queue(fx, ['train', 'build', '--prs', `1@${h1},2@${h2}`, '--dry-run']).err).toMatch(/PR #2's ship receipt is invalid \(.*\).*\(QUEUE_RECEIPT_MISSING\)/);
    setPrBody(fx, '2', shippedBody('1', h2));
    expect(queue(fx, ['train', 'build', '--prs', `1@${h1},2@${h2}`, '--dry-run']).err).toMatch(/PR #2's ship receipt names pr=1, not this PR.*\(QUEUE_RECEIPT_STALE\)/);
    expect(remoteRefs(fx)).toBe(refsBefore);
    expect(dispatches(fx)).toEqual([]);
    expect(fs.existsSync(path.join(fx.state, 'ship-queue', 'trains'))).toBe(false);
    setPrBody(fx, '2', shippedBody('2', h2));
    const ok = queue(fx, ['train', 'build', '--prs', `1@${h1},2@${h2}`]);
    expect(ok.status).toBe(EXIT.ok);
    expect(dispatches(fx).length).toBe(2);
  }, 180_000);

  test('free tests red, cancelled, missing or on another SHA refuse with QUEUE_TRAIN_FREE_RED before any paid dispatch', () => {
    const fx = make();
    const h1 = openPr(fx, '1');
    readyReceipt(fx, '1', h1);
    fx.write(d => { d.rules['evals.yml'] = GREEN_GATE; });
    const variants: Array<[Rule, RegExp, string[]]> = [
      [{ conclusion: 'failure' }, /free tests red: run \d+ concluded failure/, []],
      [{ conclusion: 'cancelled' }, /free tests cancelled: run \d+ concluded cancelled/, []],
      [{ silent: true }, /free tests missing: no free-tests\.yml dispatch run appeared on train\//, ['--free-timeout', '1']],
      [{ headSha: '0'.repeat(40) }, /free tests stale: run \d+ tested 000000000000 \(workflow_dispatch\), not the train head/, []],
    ];
    for (const [rule, why, extra] of variants) {
      fx.write(d => { d.rules['free-tests.yml'] = rule; });
      const r = queue(fx, ['train', 'build', '--prs', `1@${h1}`, '--urgent', ...extra]);
      expect(r.status).toBe(EXIT.fail);
      expect(r.err).toMatch(why);
      expect(r.err).toContain('(QUEUE_TRAIN_FREE_RED)');
      expect(trainJson(fx, nonceOf(r.out)).state).toBe('free-red');
    }
    expect(dispatches(fx, 'evals.yml')).toEqual([]);
    expect(dispatches(fx, 'free-tests.yml').length).toBe(4);
  }, 180_000);

  test('ordering: screened PRs first in READY order; unscreened PRs fill the remaining seats', () => {
    const fx = make({ ...TRAIN_POLICY, train: { ...TRAIN_BLOCK, max_size: 2 } });
    const h = ['1', '2', '3'].map(pr => openPr(fx, pr));
    readyReceipt(fx, '1', h[0]!, { at: '2026-10-18T08:00:00.000Z' });
    readyReceipt(fx, '2', h[1]!, { at: '2026-10-18T07:00:00.000Z' });
    readyReceipt(fx, '3', h[2]!, { at: '2026-10-18T09:00:00.000Z', screen: true });
    const r = queue(fx, ['train', 'build', '--prs', `1@${h[0]},2@${h[1]},3@${h[2]}`, '--dry-run']);
    expect(r.status).toBe(EXIT.ok);
    expect(line(r.out, 'ORDER:')).toBe('ORDER: 1:#3(screened) 2:#2(unscreened)');
    expect(line(r.out, 'HELD:')).toBe('HELD: #1 (over the train size 2)');
    const wide = make();
    const w = ['1', '2', '3'].map(pr => openPr(wide, pr));
    readyReceipt(wide, '1', w[0]!, { at: '2026-10-18T08:00:00.000Z' });
    readyReceipt(wide, '2', w[1]!, { at: '2026-10-18T07:00:00.000Z' });
    readyReceipt(wide, '3', w[2]!, { at: '2026-10-18T09:00:00.000Z', screen: true });
    const all = queue(wide, ['train', 'build', '--prs', `1@${w[0]},2@${w[1]},3@${w[2]}`, '--dry-run']);
    expect(line(all.out, 'ORDER:')).toBe('ORDER: 1:#3(screened) 2:#2(unscreened) 3:#1(unscreened)');
    expect(all.out).toMatch(/^SLOT: 1 #3 head=[0-9a-f]{40} screened \(narrow\) ready_at=2026-10-18T09:00:00\.000Z$/m);
  }, 180_000);
});

describe('dispatch recovery and status', () => {
  test('a partial dispatch (gh failed after GitHub accepted it) is unknown, never re-dispatched, and train status finds the run by nonce', () => {
    const fx = make();
    const { r, nonce } = twoPrTrain(fx, { ...GREEN_GATE, failButCreate: true });
    expect(r.status).toBe(EXIT.refused);
    expect(r.err).toContain('(QUEUE_TRAIN_DISPATCH_UNKNOWN)');
    expect(next(r.out)).toBe(`NEXT: gstack-ship-queue train status --train ${nonce}`);
    expect(trainJson(fx, nonce).state).toBe('dispatch-unknown');
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).err).toContain('(QUEUE_TRAIN_DISPATCH_UNKNOWN)');
    expect(queue(fx, ['train', 'build', '--train', nonce]).err).toContain('(QUEUE_TRAIN_DISPATCH_UNKNOWN)');
    const status = queue(fx, ['train', 'status', '--train', nonce]);
    expect(status.status).toBe(EXIT.ok);
    expect(status.out).toMatch(new RegExp(`^ATTEMPT: a1 gate state=dispatched nonce=${nonce.replace(/\./g, '\\.')} run=101 `, 'm'));
    expect(trainJson(fx, nonce).state).toBe('gate-pending');
    expect(next(status.out)).toBe(`NEXT: gstack-ship-queue train verdict --train ${nonce}`);
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).status).toBe(EXIT.ok);
    expect(dispatches(fx, 'evals.yml').length).toBe(1);
  }, 180_000);

  test('a dispatch that never started is marked absent by status; only then does build dispatch it again, under the same nonce', () => {
    const fx = make();
    const { r, nonce } = twoPrTrain(fx, { silent: true });
    expect(r.err).toContain('(QUEUE_TRAIN_DISPATCH_UNKNOWN)');
    const status = queue(fx, ['train', 'status', '--train', nonce]);
    expect(status.out).toContain('ATTEMPT: a1 gate state=absent');
    expect(next(status.out)).toBe(`NEXT: gstack-ship-queue train build --train ${nonce}`);
    fx.write(d => { d.rules['evals.yml'] = GREEN_GATE; });
    const again = queue(fx, ['train', 'build', '--train', nonce]);
    expect(again.status).toBe(EXIT.ok);
    expect(dispatches(fx, 'evals.yml').map(d => (d.inputs as any).nonce)).toEqual([nonce, nonce]);
    expect(trainJson(fx, nonce).attempts).toEqual(['a1', 'a2']);
  }, 180_000);

  test('train status on a clean state root rebuilds the records from refs/notes/gstack-trains and spends nothing', () => {
    const fx = make();
    const { nonce } = twoPrTrain(fx);
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).status).toBe(EXIT.ok);
    const before = dispatches(fx).length;
    const clone = coordinatorClone(fx.repo);
    const fresh = path.join(fx.repo.root, 'fresh-state');
    const s = queue(fx, ['train', 'status', '--train', nonce], { GSTACK_STATE_ROOT: fresh }, clone);
    expect(s.status).toBe(EXIT.ok);
    expect(s.out).toMatch(/^NOTES: read 2 record\(s\), restored 2 /m);
    expect(s.out).toContain(`TRAIN: ${nonce} state=green`);
    expect(s.out).toContain('CHECK: gstack/full-gate on');
    expect(trainJson(fx, nonce, fresh)).toEqual(trainJson(fx, nonce));
    expect(dispatches(fx).length).toBe(before);
    const all = queue(fx, ['train', 'status'], { GSTACK_STATE_ROOT: fresh }, clone);
    expect(all.out).toContain(`NEXT(${nonce}): gstack-ship-queue verify --pr 1 --train ${nonce}`);
  }, 180_000);
});

describe('verdict, bisect, rebuild', () => {
  function redTrain(fx: TrainFixture, pattern: string) {
    const t = twoPrTrain(fx, RED_GATE);
    const v = queue(fx, ['train', 'verdict', '--train', t.nonce]);
    const prefixes = trainJson(fx, t.nonce).prefixes.map((p: any) => p.commit);
    fx.write(d => { d.rules['evals.yml'] = { bisect: { prefixes, patterns: { c1: pattern } } }; });
    return { ...t, v, prefixes };
  }

  test('a red train names its cases and a capped bisect; the bisect runs only the red cases on every prefix and attributes a monotone pattern; prune deletes the dropped train\'s branch', () => {
    const fx = make();
    const { h1, nonce, v, prefixes } = redTrain(fx, 'GGR');
    expect(v.status).toBe(EXIT.fail);
    expect(v.err).toContain(`train ${nonce} is red on c1`);
    expect(v.out).toContain('ATTEMPT: a1 gate run 101 RED red=c1 cost=$1.70');
    expect(next(v.out)).toBe(`NEXT: gstack-ship-queue train bisect --train ${nonce} --spend-cap 2.70`);
    const dry = queue(fx, ['train', 'bisect', '--train', nonce, '--spend-cap', '2.70', '--dry-run']);
    expect(dry.out).toContain('BISECT: cases c1 prefixes T0,T1,T2 need results; $0.90 reserved per prefix; spent $0.00, cap $2.70');
    expect(dry.out).toContain('DRY-RUN: nothing dispatched');
    expect(dispatches(fx, 'evals.yml').length).toBe(1);
    const go = queue(fx, ['train', 'bisect', '--train', nonce, '--spend-cap', '2.70']);
    expect(go.status).toBe(EXIT.ok);
    const sent = dispatches(fx, 'evals.yml').at(-1)!.inputs as any;
    expect(sent.cases).toBe('c1');
    expect(sent.prefix_shas).toBe(prefixes.join(','));
    expect(sent.expected_sha).toBe(prefixes[2]);
    expect(sent.nonce).toMatch(/^gate\.bisect-/);
    const done = queue(fx, ['train', 'bisect', '--train', nonce, '--spend-cap', '2.70']);
    expect(done.status).toBe(EXIT.ok);
    expect(done.out).toContain('PATTERN: c1 T0=G T1=G T2=R');
    expect(done.out).toContain('BISECT: ATTRIBUTED #2');
    expect(next(done.out)).toBe(`NEXT: gstack-ship-queue train build --prs 1@${h1}`);
    expect(trainJson(fx, nonce).state).toBe('attributed');
    expect(queue(fx, ['train', 'prune', '--dry-run']).out).toContain(`WOULD-DELETE: train/${nonce} (attributed)`);
    expect(queue(fx, ['train', 'prune']).out).toContain(`DELETED: train/${nonce} (attributed)`);
    expect(remoteRefs(fx)).not.toContain(`refs/heads/train/${nonce}`);
    expect(queue(fx, ['train', 'prune']).out).toContain(`GONE: train/${nonce}`);
  }, 180_000);

  test('red on every prefix, T0 included, is RED_ON_MAIN; a non-monotone pattern is unattributed and earns no rebuild', () => {
    const main = make();
    const m = redTrain(main, 'RRR');
    queue(main, ['train', 'bisect', '--train', m.nonce, '--spend-cap', '5']);
    const onMain = queue(main, ['train', 'bisect', '--train', m.nonce, '--spend-cap', '5']);
    expect(onMain.status).toBe(EXIT.fail);
    expect(onMain.err).toContain('(QUEUE_TRAIN_RED_ON_MAIN)');
    expect(next(onMain.out)).toMatch(/^NEXT: fix forward on main first, then gstack-ship-queue train build --prs /);
    const fx = make();
    const n = redTrain(fx, 'GRG');
    queue(fx, ['train', 'bisect', '--train', n.nonce, '--spend-cap', '5']);
    const mixed = queue(fx, ['train', 'bisect', '--train', n.nonce, '--spend-cap', '5']);
    expect(mixed.status).toBe(EXIT.fail);
    expect(mixed.err).toContain('(QUEUE_TRAIN_UNATTRIBUTED)');
    expect(mixed.out).toContain('BISECT: UNATTRIBUTED (not monotone)');
    expect(next(mixed.out)).toMatch(/^NEXT: route the red cases to a repair lane \(GStack Minder\); once the repair merges: /);
    const refused = queue(fx, ['train', 'rebuild', '--train', n.nonce]);
    expect(refused.status).toBe(EXIT.refused);
    expect(refused.err).toMatch(/rebuild refused: the bisect was not all green \(c1=GRG\).*\(QUEUE_TRAIN_REBUILD_REFUSED\)/);
  }, 240_000);

  test('rebuild-once: refused without a bisect; an all-green bisect earns exactly one unchanged rebuild, both runs reported; a second red stays red', () => {
    const fx = make();
    const { nonce } = redTrain(fx, 'GGG');
    expect(queue(fx, ['train', 'rebuild', '--train', nonce]).err).toMatch(/rebuild refused: no bisect record.*\(QUEUE_TRAIN_REBUILD_REFUSED\)/);
    queue(fx, ['train', 'bisect', '--train', nonce, '--spend-cap', '5']);
    const green = queue(fx, ['train', 'bisect', '--train', nonce, '--spend-cap', '5']);
    expect(green.out).toContain('BISECT: UNATTRIBUTED (all green)');
    expect(next(green.out)).toBe(`NEXT: gstack-ship-queue train rebuild --train ${nonce}`);
    fx.write(d => { d.rules['evals.yml'] = RED_GATE; });
    const rebuild = queue(fx, ['train', 'rebuild', '--train', nonce]);
    expect(rebuild.status).toBe(EXIT.ok);
    expect(dispatches(fx, 'evals.yml').at(-1)!.inputs).toMatchObject({ evals_all: 'true', nonce: `${nonce}.2` });
    const second = queue(fx, ['train', 'verdict', '--train', nonce]);
    expect(second.status).toBe(EXIT.fail);
    expect(second.out).toContain('ATTEMPT: a1 gate run 101 RED red=c1');
    expect(second.out).toMatch(/^ATTEMPT: a2 rebuild run \d+ RED red=c1/m);
    expect(next(second.out)).toMatch(/^NEXT: second red stays red: route c1 to a repair lane/);
    expect(queue(fx, ['train', 'rebuild', '--train', nonce]).err).toMatch(/rebuild refused: already rebuilt once/);
    expect(queue(fx, ['train', 'bisect', '--train', nonce, '--spend-cap', '5']).err).toContain('second red is not bisected again');
  }, 240_000);

  test('a capped bisect launches only what fits, keeps completed prefixes, and resumes without repeating one', () => {
    const fx = make();
    const { nonce, prefixes } = redTrain(fx, 'GGR');
    const none = queue(fx, ['train', 'bisect', '--train', nonce, '--spend-cap', '0.5']);
    expect(none.status).toBe(EXIT.refused);
    expect(none.err).toContain('(QUEUE_TRAIN_BISECT_CAPPED)');
    expect(next(none.out)).toBe(`NEXT: gstack-ship-queue train bisect --train ${nonce} --spend-cap 2.70`);
    expect(dispatches(fx, 'evals.yml').length).toBe(1);
    const part = queue(fx, ['train', 'bisect', '--train', nonce, '--spend-cap', '1.9']);
    expect(part.status).toBe(EXIT.refused);
    expect(part.err).toContain('(QUEUE_TRAIN_BISECT_CAPPED)');
    expect(part.out).toContain('BISECT: launch T0,T1; 1 prefix(es) wait for a higher cap');
    expect((dispatches(fx, 'evals.yml').at(-1)!.inputs as any).prefix_shas).toBe(prefixes.slice(0, 2).join(','));
    const resume = queue(fx, ['train', 'bisect', '--train', nonce, '--spend-cap', '5']);
    expect(resume.status).toBe(EXIT.ok);
    expect((dispatches(fx, 'evals.yml').at(-1)!.inputs as any).prefix_shas).toBe(prefixes[2]);
    const done = queue(fx, ['train', 'bisect', '--train', nonce, '--spend-cap', '5']);
    expect(done.out).toContain('BISECT: ATTRIBUTED #2');
    expect(done.out).toContain('BISECT: spent $1.50 of cap $5.00');
    expect(dispatches(fx, 'evals.yml').length).toBe(3);
  }, 240_000);

  test('a bisect refuses prefixes that are not ancestors of train/<nonce>', () => {
    const fx = make();
    const { nonce } = redTrain(fx, 'GGR');
    fx.repo.git('push', '-q', '-f', 'origin', `origin/main:refs/heads/train/${nonce}`);
    const r = queue(fx, ['train', 'bisect', '--train', nonce, '--spend-cap', '5']);
    expect(r.status).toBe(EXIT.refused);
    expect(r.err).toMatch(/train\/\S+ is at [0-9a-f]{12}, not the recorded train head .*\(QUEUE_TRAIN_PREFIX_INVALID\)/);
    expect(dispatches(fx, 'evals.yml').length).toBe(1);
  }, 180_000);

  test('an INFRA/INCOMPLETE-only census is never green and earns one re-dispatch, reported beside the first run', () => {
    const fx = make();
    const infra: Rule = { conclusion: 'failure', record: { panels: [PASS('c1'), FAIL('c2', 'INFRA'), PASS('j1', 'judge')], census: { ...COMPLETE, killed_before_upload: 1 }, verdict: 'RED' } };
    const { nonce } = twoPrTrain(fx, infra);
    const v = queue(fx, ['train', 'verdict', '--train', nonce]);
    expect(v.status).toBe(EXIT.fail);
    expect(v.err).toMatch(/gate is incomplete: 1 slice killed before upload; c2 FAIL \(INFRA\).*\(QUEUE_TRAIN_INCOMPLETE\)/);
    expect(next(v.out)).toBe(`NEXT: gstack-ship-queue train rebuild --train ${nonce} --infra (the single re-dispatch EVAL_POLICY.infraRedispatch allows; report both runs)`);
    expect(queue(fx, ['train', 'rebuild', '--train', nonce]).err).toContain('rebuild refused: no bisect record');
    const again = queue(fx, ['train', 'rebuild', '--train', nonce, '--infra']);
    expect(again.status).toBe(EXIT.ok);
    const second = queue(fx, ['train', 'verdict', '--train', nonce]);
    expect(second.out).toMatch(/^ATTEMPT: a2 infra-redispatch run \d+ INCOMPLETE/m);
    expect(next(second.out)).toMatch(/^NEXT: diagnose run /);
    expect(queue(fx, ['train', 'rebuild', '--train', nonce, '--infra']).err).toMatch(/already re-dispatched once.*\(QUEUE_TRAIN_REBUILD_REFUSED\)/);
  }, 180_000);
});

describe('verify, freeze, repair and clear', () => {
  test('verify accepts each merge only at prefix equality modulo stamps; an interrupted publication freezes the queue until one repair train lands', () => {
    const fx = make();
    const { h1, h2, nonce } = twoPrTrain(fx);
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).status).toBe(EXIT.ok);
    const t = trainJson(fx, nonce);
    const coord = coordinatorClone(fx.repo);
    const v = (pr: string, train = nonce) => queue(fx, ['verify', '--pr', pr, '--train', train], {}, coord);

    const pre1 = v('1');
    expect(pre1.status).toBe(EXIT.ok);
    expect(pre1.out).toContain(`VERIFY_TRAIN: #1 may merge as slot 1 of train ${nonce}`);
    expect(line(pre1.out, 'MERGE_CONDITION:')).toBe(`MERGE_CONDITION: sha=${h1}`);
    const early = v('2');
    expect(early.status).toBe(EXIT.fail);
    expect(early.err).toMatch(/is neither T1 nor T2 modulo stamps.*nothing of train \S+ merged, so the queue is not frozen.*\(QUEUE_TRAIN_TREE_MISMATCH\)/);

    publishMain(fx, t.prefixes[1].commit, '1.2.4.0');
    const post1 = v('1');
    expect(post1.status).toBe(EXIT.ok);
    expect(post1.out).toMatch(/^main: [0-9a-f]{40} = T1 \(same modulo stamps \(1 stamp file\(s\)\)\)$/m);
    expect(post1.out).toContain(`VERIFY_TRAIN: #1 merged; main's tree is T1 of train ${nonce} (1/2 merged)`);
    expect(next(post1.out)).toBe(`NEXT: gstack-ship-queue verify --pr 2 --train ${nonce}`);
    expect(line(v('2').out, 'MERGE_CONDITION:')).toBe(`MERGE_CONDITION: sha=${h2}`);

    const broken = publishMain(fx, t.prefixes[2].commit, '1.2.5.0', { file: 'stray.txt', text: 'not in the train\n' });
    const mismatch = v('2');
    expect(mismatch.status).toBe(EXIT.fail);
    expect(mismatch.err).toContain('(QUEUE_TRAIN_TREE_MISMATCH)');
    expect(line(mismatch.out, 'QUEUE_TRAIN_FROZEN:')).toMatch(new RegExp(`^QUEUE_TRAIN_FROZEN: train \\S+ merged #1; main ${broken.slice(0, 12)} tree [0-9a-f]{12}; backstop dispatched run \\d+ \\(nonce gate\\.backstop-`));
    const backstop = dispatches(fx, 'evals.yml').at(-1)!;
    expect([backstop.ref, (backstop.inputs as any).expected_sha, (backstop.inputs as any).evals_all]).toEqual(['main', broken, 'true']);
    const freezeFile = path.join(fx.state, 'ship-queue', 'freeze', `${repoKey(fx)}.json`);
    expect(JSON.parse(fs.readFileSync(freezeFile, 'utf8'))).toMatchObject({ kind: 'freeze', merged: ['1'], unmerged: [{ pr: '2', head: h2 }], cleared_at: null });

    const h3 = openPr(fx, '3');
    readyReceipt(fx, '3', h3);
    const ordinary = queue(fx, ['train', 'build', '--prs', `3@${h3}`, '--urgent']);
    expect(ordinary.status).toBe(EXIT.refused);
    expect(ordinary.err).toContain('(QUEUE_TRAIN_FROZEN)');
    expect(next(ordinary.out)).toBe('NEXT: gstack-ship-queue train build --repair --prs <repair-pr>@<sha>');
    const fresh = path.join(fx.repo.root, 'fresh-state');
    expect(queue(fx, ['train', 'status'], { GSTACK_STATE_ROOT: fresh }, coord).out).toMatch(/^QUEUE_TRAIN_FROZEN: train /m);

    const repair = queue(fx, ['train', 'build', '--repair', '--prs', `3@${h3}`]);
    expect(repair.status).toBe(EXIT.ok);
    const rn = nonceOf(repair.out);
    expect(trainJson(fx, rn)).toMatchObject({ repair: true, base: { sha: broken } });
    expect(queue(fx, ['train', 'verdict', '--train', rn]).status).toBe(EXIT.ok);
    expect(v('2').err).toContain('(QUEUE_TRAIN_FROZEN)');
    expect(dispatches(fx, 'evals.yml').filter(d => d.ref === 'main').length).toBe(1);
    expect(line(v('3', rn).out, 'MERGE_CONDITION:')).toBe(`MERGE_CONDITION: sha=${h3}`);
    publishMain(fx, trainJson(fx, rn).prefixes[1].commit, '1.2.6.0');
    const cleared = v('3', rn);
    expect(cleared.status).toBe(EXIT.ok);
    expect(cleared.out).toMatch(/^FREEZE: cleared \(repair #3 via train \S+; main [0-9a-f]{12} carries a green record\)$/m);
    expect(next(cleared.out)).toBe(`NEXT: gstack-ship-queue train build --prs 2@${h2}`);
    expect(JSON.parse(fs.readFileSync(freezeFile, 'utf8')).cleared_at).toBe('2026-10-18T12:00:00.000Z');
    expect(queue(fx, ['train', 'status']).out).not.toContain('QUEUE_TRAIN_FROZEN');
  }, 300_000);
  test("rule 22: verify --train binds the receipt to the pinned head when the current head is its stamp commit; a receipt for another head refuses the slot and merges nothing", () => {
    const fx = make();
    const { h1, nonce } = twoPrTrain(fx);
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).status).toBe(EXIT.ok);
    const coord = coordinatorClone(fx.repo);
    const v = () => queue(fx, ['verify', '--pr', '1', '--train', nonce], {}, coord);
    const { repo } = fx;
    repo.git('checkout', '-q', '-B', 'lane1', h1);
    fs.writeFileSync(path.join(repo.work, 'VERSION'), '1.2.4.0\n');
    repo.git('commit', '-qam', 'v1.2.4.0 stamp');
    const stamped = repo.git('rev-parse', 'HEAD');
    repo.git('push', '-q', '-f', 'origin', `${stamped}:refs/pull/1/head`);
    const ok = v();
    expect(ok.status).toBe(EXIT.ok);
    expect(ok.out).toContain(`head: ${stamped} (same modulo stamps (1 stamp file(s)))`);
    expect(ok.out).toContain(`SHIP_RECEIPT: pr=1 head=${h1.slice(0, 12)} version=- base=main (binds the pinned head)`);
    expect(line(ok.out, 'MERGE_CONDITION:')).toBe(`MERGE_CONDITION: sha=${stamped}`);
    setPrBody(fx, '1', shippedBody('1', 'b'.repeat(40)));
    const stale = v();
    expect(stale.status).toBe(EXIT.refused);
    expect(stale.err).toMatch(new RegExp(`PR #1's ship receipt is for bbbbbbbbbbbb, not the head ${h1.slice(0, 12)} or ${stamped.slice(0, 12)} being merged.*\\(QUEUE_RECEIPT_STALE\\)`));
    expect(stale.out).not.toContain('MERGE_CONDITION:');
    expect(next(stale.out)).toBe("NEXT: #1's lane runs /ship and READYs again; then gstack-ship-queue train build --prs <pins>");
    expect(trainJson(fx, nonce).merged).toEqual([]);
    setPrBody(fx, '1', '');
    expect(v().err).toContain('(QUEUE_RECEIPT_MISSING)');
    setPrBody(fx, '1', '```gstack-ship-receipt\n{"schema_version":1}\n```\n');
    const invalid = v();
    expect(invalid.err).toMatch(/PR #1's ship receipt is invalid \(.*\).*\(QUEUE_RECEIPT_MISSING\)/);
    expect(invalid.out).not.toContain('MERGE_CONDITION:');
    setPrBody(fx, '1', shippedBody('2', h1));
    const otherPr = v();
    expect(otherPr.err).toMatch(/PR #1's ship receipt names pr=2, not this PR.*\(QUEUE_RECEIPT_STALE\)/);
    expect(otherPr.out).not.toContain('MERGE_CONDITION:');
    expect(trainJson(fx, nonce).merged).toEqual([]);
    setPrBody(fx, '1', shippedBody('1', stamped));
    expect(v().out).toContain(`SHIP_RECEIPT: pr=1 head=${stamped.slice(0, 12)} version=- base=main (binds the current head)`);
    const saved = fx.read().prs['1'];
    fx.write(d => { delete d.prs['1']; });
    const unreadable = v();
    expect(unreadable.status).toBe(EXIT.refused);
    expect(unreadable.err).toContain('(QUEUE_PROOF_MISSING)');
    expect(unreadable.out).not.toContain('MERGE_CONDITION:');
    fx.write(d => { d.prs['1'] = saved; });
    expect(trainJson(fx, nonce).merged).toEqual([]);
  }, 300_000);

  test('from slot 2 on, a head that merges main into the pin verifies when its tree is the slot\'s prefix modulo stamps', () => {
    const fx = make();
    const { h2, nonce } = twoPrTrain(fx);
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).status).toBe(EXIT.ok);
    const t = trainJson(fx, nonce);
    const coord = coordinatorClone(fx.repo);
    const v = (pr: string) => queue(fx, ['verify', '--pr', pr, '--train', nonce], {}, coord);
    const main1 = publishMain(fx, t.prefixes[1].commit, '1.2.4.0');
    expect(v('1').status).toBe(EXIT.ok);

    const { repo } = fx;
    const laneHead = (extra?: { file: string; text: string }) => {
      repo.git('reset', '-q', '--hard');
      repo.git('checkout', '-q', '-B', 'lane2', h2);
      repo.git('rm', '-rq', '.');
      repo.git('checkout', t.prefixes[2].commit, '--', '.');
      fs.writeFileSync(path.join(repo.work, 'VERSION'), '1.2.5.0\n');
      if (extra) fs.writeFileSync(path.join(repo.work, extra.file), extra.text);
      repo.git('add', '-A');
      const tree = repo.git('write-tree');
      const head = repo.git('commit-tree', tree, '-p', h2, '-p', main1, '-m', 'merge main into #2, stamp 1.2.5.0');
      repo.git('push', '-q', '-f', 'origin', `${head}:refs/pull/2/head`);
      return head;
    };

    const merged = laneHead();
    const ok = v('2');
    expect(ok.status).toBe(EXIT.ok);
    expect(ok.out).toMatch(new RegExp(`^head: ${merged} \\(T2 with main merged in, same modulo stamps`, 'm'));
    expect(line(ok.out, 'MERGE_CONDITION:')).toBe(`MERGE_CONDITION: sha=${merged}`);

    const stray = laneHead({ file: 'stray.txt', text: 'not in the train\n' });
    const moved = v('2');
    expect(moved.status).toBe(EXIT.fail);
    expect(moved.err).toMatch(new RegExp(`#2 moved past its pinned head ${h2.slice(0, 12)} and is not T2 modulo stamps \\(${stray.slice(0, 12)}: .*\\(QUEUE_TRAIN_MOVED\\)`));
  }, 300_000);

  test("GSTA-67 (#3345 at 593e61c): a merged-in head whose CHANGELOG was resolved by hand verifies even where T<i>'s mechanical CHANGELOG differs; an invented line or a head without main is still refused", () => {
    const fx = make();
    const h1 = openPr(fx, '1', { changelog: false });
    const h2 = openPr(fx, '2', { changelog: cl => cl.replace('# Changelog\n', '# Changelog\n\n## [Unreleased]\n\n- #2 change\n').replace('## [1.2.2.0] - 2026-09-01\n\n', '') });
    readyReceipt(fx, '1', h1);
    readyReceipt(fx, '2', h2);
    fx.write(d => { d.rules['evals.yml'] = GREEN_GATE; });
    const nonce = nonceOf(queue(fx, ['train', 'build', '--prs', `1@${h1},2@${h2}`]).out);
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).status).toBe(EXIT.ok);
    const t = trainJson(fx, nonce);
    expect(fx.repo.git('show', `${t.prefixes[2].commit}:CHANGELOG.md`)).not.toContain('## [1.2.2.0]');
    const coord = coordinatorClone(fx.repo);
    const v = () => queue(fx, ['verify', '--pr', '2', '--train', nonce], {}, coord);
    const main1 = publishMain(fx, t.prefixes[1].commit, '1.2.4.0');
    const { repo } = fx;
    const laneHead = (entry: string, parents: string[]) => {
      repo.git('reset', '-q', '--hard');
      repo.git('checkout', '-q', '-B', 'lane2', h2);
      repo.git('rm', '-rq', '.');
      repo.git('checkout', t.prefixes[2].commit, '--', '.');
      fs.writeFileSync(path.join(repo.work, 'VERSION'), '1.2.5.0\n');
      fs.writeFileSync(path.join(repo.work, 'CHANGELOG.md'), repo.git('show', `${main1}:CHANGELOG.md`).replace('# Changelog\n', `# Changelog\n\n## [1.2.5.0] - 2026-10-18\n\n${entry}\n`) + '\n');
      repo.git('add', '-A');
      const head = repo.git('commit-tree', repo.git('write-tree'), ...parents.flatMap(p => ['-p', p]), '-m', 'merge main into #2 (CHANGELOG by hand), stamp 1.2.5.0');
      repo.git('push', '-q', '-f', 'origin', `${head}:refs/pull/2/head`);
      return head;
    };

    const byHand = laneHead('- #2 change', [h2, main1]);
    const ok = v();
    expect(ok.status).toBe(EXIT.ok);
    expect(ok.out).toContain(`head: ${byHand} (T2 with main merged in, same modulo stamps (1 stamp file(s)) except CHANGELOG.md, resolved as main's CHANGELOG.md plus #2's own entry)`);
    expect(line(ok.out, 'MERGE_CONDITION:')).toBe(`MERGE_CONDITION: sha=${byHand}`);

    const invented = laneHead('- #2 change\n- added after the gate', [h2, main1]);
    const refused = v();
    expect(refused.status).toBe(EXIT.fail);
    expect(refused.err).toContain(`#2 moved past its pinned head ${h2.slice(0, 12)} and is not T2 modulo stamps (${invented.slice(0, 12)}: differs from T2 in CHANGELOG.md, which is not main's plus #2's own entry: the PR's entry holds a line its pin never added: "- added after the gate"; against the pin it differs: `);
    expect(refused.err).toContain('(QUEUE_TRAIN_MOVED)');

    const orphan = laneHead('- #2 change', [h2]);
    const noMain = v();
    expect(noMain.status).toBe(EXIT.fail);
    expect(noMain.err).toContain(`(${orphan.slice(0, 12)}: does not contain main ${main1.slice(0, 12)}; against the pin it differs: `);
  }, 300_000);
  // fails_when=the post-merge verify of a merged-in head the pre-merge verify accepted freezes the queue because T<i>'s single [Unreleased] became two released sections, or the pre-merge verify refuses the correction bullet mergeChangelogs itself wrote; why_new=the GSTA-67 test above never publishes the accepted head and never stacks a child on a released parent; seam=none (real git, the fixture's gh); no_claim=what the squash commit's message says
  test("train 24 (GSTA-96): a stacked child's head the pre-merge verify accepted confirms after its squash merge under the same CHANGELOG rule, corrections to the released parent included", () => {
    const fx = make();
    const { repo } = fx;
    const h1 = openPr(fx, '1', { changelog: cl => cl.replace('# Changelog\n', '# Changelog\n\n## [Unreleased]\n\n**Parent entry of #1.**\n\n### Changed\n- #1 change, the first wording\n- #1 second bullet, unchanged\n') });
    const h2 = openPr(fx, '2', { from: 'pr-1', changelog: cl => cl.replace('## [Unreleased]\n\n**Parent entry of #1.**', '## [Unreleased]\n\n**Child entry of #2.**\n\n### Changed\n- #2 change\n\n**Parent entry of #1.**').replace('- #1 change, the first wording', '- #1 change, the better wording') });
    readyReceipt(fx, '1', h1);
    readyReceipt(fx, '2', h2);
    fx.write(d => { d.rules['evals.yml'] = GREEN_GATE; });
    const nonce = nonceOf(queue(fx, ['train', 'build', '--prs', `1@${h1},2@${h2}`]).out);
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).status).toBe(EXIT.ok);
    const t = trainJson(fx, nonce);
    expect(parseChangelog(repo.git('show', `${t.prefixes[2].commit}:CHANGELOG.md`)).sections.map(s => s.version ?? 'Unreleased')).toEqual(['Unreleased', '1.2.3.0', '1.2.2.0']);
    const coord = coordinatorClone(fx.repo);
    const v = (pr: string) => queue(fx, ['verify', '--pr', pr, '--train', nonce], {}, coord);

    // Slot 1: #1 squash-merges and is released as 1.2.4.0 (its [Unreleased] re-headed).
    expect(line(v('1').out, 'MERGE_CONDITION:')).toBe(`MERGE_CONDITION: sha=${h1}`);
    const main1 = publishMain(fx, t.prefixes[1].commit, '1.2.4.0', { file: 'CHANGELOG.md', text: repo.git('show', `${t.prefixes[1].commit}:CHANGELOG.md`).replace('## [Unreleased]', '## [1.2.4.0] - 2026-10-18') + '\n' });
    expect(v('1').out).toContain(`VERIFY_TRAIN: #1 merged; main's tree is T1 of train ${nonce} (1/2 merged)`);

    // Slot 2: the lane merges main into its pin; mergeChangelogs carries the child past its released parent.
    const merged = mergeChangelogs(repo.git('show', `${h2}:CHANGELOG.md`) + '\n', repo.git('show', `${main1}:CHANGELOG.md`) + '\n', repo.git('show', `${h1}:CHANGELOG.md`) + '\n')!;
    expect(merged).toContain('- Correction to the 1.2.4.0 entry below: "first" should read "better".');
    repo.git('reset', '-q', '--hard');
    repo.git('checkout', '-q', '-B', 'lane2', h2);
    repo.git('rm', '-rq', '.');
    repo.git('checkout', t.prefixes[2].commit, '--', '.');
    fs.writeFileSync(path.join(repo.work, 'VERSION'), '1.2.5.0\n');
    fs.writeFileSync(path.join(repo.work, 'CHANGELOG.md'), merged.replace('## [Unreleased]', '## [1.2.5.0] - 2026-10-18'));
    repo.git('add', '-A');
    const laneHead = repo.git('commit-tree', repo.git('write-tree'), '-p', h2, '-p', main1, '-m', 'merge main into #2, stamp 1.2.5.0');
    repo.git('push', '-q', '-f', 'origin', `${laneHead}:refs/pull/2/head`);
    repo.git('reset', '-q', '--hard');
    const pre = v('2');
    expect([pre.status, pre.err]).toEqual([EXIT.ok, '']);
    expect(pre.out).toContain(`head: ${laneHead} (T2 with main merged in, same modulo stamps (1 stamp file(s)) except CHANGELOG.md, resolved as main's CHANGELOG.md plus #2's own entry)`);
    expect(line(pre.out, 'MERGE_CONDITION:')).toBe(`MERGE_CONDITION: sha=${laneHead}`);

    // The squash merge publishes exactly that tree; the post-merge verify confirms it instead of freezing the queue.
    const main2 = publishMain(fx, laneHead, '1.2.5.0');
    expect(repo.git('rev-parse', `${main2}^{tree}`)).toBe(repo.git('rev-parse', `${laneHead}^{tree}`));
    const post = v('2');
    expect([post.status, post.err]).toEqual([EXIT.ok, '']);
    expect(line(post.out, 'main:')).toBe(`main: ${main2} = T2 (same modulo stamps (1 stamp file(s)) except CHANGELOG.md, main ${main1.slice(0, 12)}'s CHANGELOG.md plus #2's own entry)`);
    expect(post.out).toContain(`VERIFY_TRAIN: #2 merged; main's tree is T2 of train ${nonce} (2/2 merged)`);
    expect(queue(fx, ['train', 'status']).out).not.toContain('QUEUE_TRAIN_FROZEN');
  }, 300_000);

  // fails_when=a freeze lists a PR GitHub reports MERGED as unmerged (train 24's freeze named #3453), or a post-merge CHANGELOG with a line the pin never wrote confirms; why_new=the freeze test above merges nothing of the slot it freezes on; seam=the fixture's gh pr view state; no_claim=the backstop's outcome
  test('a post-merge CHANGELOG beyond the rule still freezes, and the freeze lists the slot GitHub reports MERGED as merged, not unmerged', () => {
    const fx = make();
    const { h2, nonce } = twoPrTrain(fx);
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).status).toBe(EXIT.ok);
    const t = trainJson(fx, nonce);
    const coord = coordinatorClone(fx.repo);
    const v = (pr: string) => queue(fx, ['verify', '--pr', pr, '--train', nonce], {}, coord);
    const released = (prefix: string, version: string) => fx.repo.git('show', `${prefix}:CHANGELOG.md`).replace('## [Unreleased]', `## [${version}] - 2026-10-18`) + '\n';
    const main1 = publishMain(fx, t.prefixes[1].commit, '1.2.4.0', { file: 'CHANGELOG.md', text: released(t.prefixes[1].commit, '1.2.4.0') });
    expect(v('1').status).toBe(EXIT.ok);
    expect(line(v('2').out, 'MERGE_CONDITION:')).toBe(`MERGE_CONDITION: sha=${h2}`);
    // Main's CHANGELOG plus #2's stamped entry, with one line the pin never wrote.
    const smuggled = fx.repo.git('show', `${main1}:CHANGELOG.md`).replace('# Changelog\n', '# Changelog\n\n## [1.2.5.0] - 2026-10-18\n\n- #2 change\n- added after the gate\n') + '\n';
    const broken = publishMain(fx, t.prefixes[2].commit, '1.2.5.0', { file: 'CHANGELOG.md', text: smuggled });
    fx.write(d => { (d.prs['2'] as any).state = 'MERGED'; });
    const frozen = v('2');
    expect(frozen.status).toBe(EXIT.fail);
    expect(frozen.err).toContain(`main ${broken.slice(0, 12)} is neither T1 nor T2 modulo stamps (vs T2: differs: CHANGELOG.md, which is not main ${main1.slice(0, 12)}'s plus #2's own entry: the PR's entry holds a line its pin never added: "- added after the gate")`);
    expect(line(frozen.out, 'QUEUE_TRAIN_FROZEN:')).toMatch(/^QUEUE_TRAIN_FROZEN: train \S+ merged #1,#2; main /);
    expect(line(frozen.out, 'freeze:')).toMatch(/; #2 merged on GitHub without a verified tree; unmerged \(none\); repair none admitted$/);
    const freezeFile = path.join(fx.state, 'ship-queue', 'freeze', `${repoKey(fx)}.json`);
    expect(JSON.parse(fs.readFileSync(freezeFile, 'utf8'))).toMatchObject({ merged: ['1', '2'], unmerged: [] });
  }, 300_000);

  // Value: protects=a first slot GitHub reports MERGED whose squash fails the post-merge check freezes the queue, and a GitHub state that cannot be read refuses instead of reading as not merged; fails_when=stopped() reads an empty merged list, or an unreadable gh answer, as "nothing merged" while main already holds the unverified squash (review of GSTA-129, passes 1 and 2); why_new=the test above freezes on slot 2 with slot 1 verified; seam=the fixture's gh pr view state; no_claim=the backstop's outcome
  test("slot 1 merged on GitHub but not confirmed: an unreadable GitHub state refuses, and a MERGED one freezes with #1 merged and #2 unmerged instead of saying nothing merged", () => {
    const fx = make();
    const { h2, nonce } = twoPrTrain(fx);
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).status).toBe(EXIT.ok);
    const t = trainJson(fx, nonce);
    const coord = coordinatorClone(fx.repo);
    const v = (pr: string) => queue(fx, ['verify', '--pr', pr, '--train', nonce], {}, coord);
    const smuggled = fx.repo.git('show', `${t.prefixes[0].commit}:CHANGELOG.md`).replace('# Changelog\n', '# Changelog\n\n## [1.2.4.0] - 2026-10-18\n\n- #1 change\n- added after the gate\n') + '\n';
    const broken = publishMain(fx, t.prefixes[1].commit, '1.2.4.0', { file: 'CHANGELOG.md', text: smuggled });
    // While GitHub's answer for #1 cannot be read, the verify neither freezes nor says "nothing merged": it refuses and asks to be rerun.
    const row = fx.read().prs['1'] as any;
    fx.write(d => { delete d.prs['1']; });
    const unreadable = v('1');
    expect(unreadable.status).toBe(EXIT.refused);
    expect(unreadable.err).toContain(`main ${broken.slice(0, 12)} is neither T0 nor T1 modulo stamps`);
    expect(unreadable.err).toMatch(/; whether #1 merged on GitHub could not be read, so whether the queue must freeze is unknown; .*\(QUEUE_PROOF_MISSING\)/);
    expect(unreadable.out).toContain(`NEXT: gstack-ship-queue verify --pr 1 --train ${nonce} (once gh pr view answers)`);
    expect(fs.existsSync(path.join(fx.state, 'ship-queue', 'freeze', `${repoKey(fx)}.json`))).toBe(false);
    fx.write(d => { d.prs['1'] = { ...row, state: 'MERGED' }; });
    const frozen = v('1');
    expect(frozen.status).toBe(EXIT.fail);
    expect(frozen.err).toContain(`main ${broken.slice(0, 12)} is neither T0 nor T1 modulo stamps`);
    expect(frozen.err).toContain('"- added after the gate"); the queue is frozen;');
    expect(line(frozen.out, 'QUEUE_TRAIN_FROZEN:')).toMatch(/^QUEUE_TRAIN_FROZEN: train \S+ merged #1; main /);
    expect(line(frozen.out, 'freeze:')).toMatch(/; #1 merged on GitHub without a verified tree; unmerged #2; repair none admitted$/);
    expect(JSON.parse(fs.readFileSync(path.join(fx.state, 'ship-queue', 'freeze', `${repoKey(fx)}.json`), 'utf8'))).toMatchObject({ merged: ['1'], unmerged: [{ pr: '2', head: h2 }] });
  }, 300_000);

  // Value: protects=the freeze record is built from the same GitHub read that decided to freeze, so a slot that read MERGED stays merged even when GitHub stops answering a moment later; fails_when=freezeQueue reads GitHub again and files anything but an exact MERGED under unmerged (the misfile that listed train 24's merged #3453 as unmerged, GSTA-129 defect 1); why_new=the test above holds GitHub's answer fixed across the verify; seam=the fixture's gh pr view vanishing after one answer; no_claim=the backstop's outcome
  test("a slot that read MERGED when the verify decided to freeze is recorded as merged even when GitHub stops answering before the record is written", () => {
    const fx = make();
    const { h2, nonce } = twoPrTrain(fx);
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).status).toBe(EXIT.ok);
    const t = trainJson(fx, nonce);
    const coord = coordinatorClone(fx.repo);
    const smuggled = fx.repo.git('show', `${t.prefixes[0].commit}:CHANGELOG.md`).replace('# Changelog\n', '# Changelog\n\n## [1.2.4.0] - 2026-10-18\n\n- #1 change\n- added after the gate\n') + '\n';
    publishMain(fx, t.prefixes[1].commit, '1.2.4.0', { file: 'CHANGELOG.md', text: smuggled });
    fx.write(d => { (d.prs['1'] as any).state = 'MERGED'; d.vanish = { '1': 1 }; });
    const frozen = queue(fx, ['verify', '--pr', '1', '--train', nonce], {}, coord);
    expect(frozen.status).toBe(EXIT.fail);
    expect(frozen.err).toContain('"- added after the gate"); the queue is frozen;');
    expect(fx.read().vanish).toEqual({ '1': 0 });
    expect(line(frozen.out, 'freeze:')).toMatch(/; #1 merged on GitHub without a verified tree; unmerged #2; repair none admitted$/);
    expect(JSON.parse(fs.readFileSync(path.join(fx.state, 'ship-queue', 'freeze', `${repoKey(fx)}.json`), 'utf8'))).toMatchObject({ merged: ['1'], unmerged: [{ pr: '2', head: h2 }] });
  }, 300_000);

  // Value: protects=a slot unreadable on GitHub beside a merged one is left out of unmerged and named in the reason, so the rebuild after the repair never seats a PR that may already be in; fails_when=freezeQueue files an unreadable slot under unmerged, or drops it without naming it; why_new=the test above keeps slot 2 readable; seam=the fixture's gh pr view vanishing for slot 2; no_claim=the backstop's outcome
  test("a slot unreadable on GitHub beside a merged one is left out of unmerged, recorded as unreadable and named by the NEXT after the repair", () => {
    const fx = make();
    const { h2, nonce } = twoPrTrain(fx);
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).status).toBe(EXIT.ok);
    const t = trainJson(fx, nonce);
    const coord = coordinatorClone(fx.repo);
    const smuggled = fx.repo.git('show', `${t.prefixes[0].commit}:CHANGELOG.md`).replace('# Changelog\n', '# Changelog\n\n## [1.2.4.0] - 2026-10-18\n\n- #1 change\n- added after the gate\n') + '\n';
    publishMain(fx, t.prefixes[1].commit, '1.2.4.0', { file: 'CHANGELOG.md', text: smuggled });
    fx.write(d => { (d.prs['1'] as any).state = 'MERGED'; d.vanish = { '2': 0 }; });
    const frozen = queue(fx, ['verify', '--pr', '1', '--train', nonce], {}, coord);
    expect(frozen.status).toBe(EXIT.fail);
    expect(line(frozen.out, 'freeze:')).toMatch(/; #1 merged on GitHub without a verified tree; #2 unreadable on GitHub, left out of unmerged; seat it in a train by hand once gh pr view answers; unmerged \(none\); repair none admitted$/);
    expect(JSON.parse(fs.readFileSync(path.join(fx.state, 'ship-queue', 'freeze', `${repoKey(fx)}.json`), 'utf8'))).toMatchObject({ merged: ['1'], unmerged: [], unreadable: [{ pr: '2', head: h2 }] });
    expect(line(frozen.out, 'unreadable:')).toBe(`unreadable: #2@${h2.slice(0, 12)} (GitHub did not answer at the freeze; neither merged nor unmerged)`);
    // The repair clears the freeze, and the NEXT names the unreadable slot instead of omitting it (#3519 b).
    const h3 = openPr(fx, '3');
    readyReceipt(fx, '3', h3);
    const rn = nonceOf(queue(fx, ['train', 'build', '--repair', '--prs', `3@${h3}`]).out);
    expect(queue(fx, ['train', 'verdict', '--train', rn]).status).toBe(EXIT.ok);
    publishMain(fx, trainJson(fx, rn).prefixes[1].commit, '1.2.6.0');
    const cleared = queue(fx, ['verify', '--pr', '3', '--train', rn], {}, coord);
    expect(cleared.out).toMatch(/^FREEZE: cleared /m);
    expect(next(cleared.out)).toBe(`NEXT: gh pr view 2 --json state,headRefOid (unreadable at the freeze: #2@${h2.slice(0, 12)}); seat each that is OPEN in a train`);
  }, 300_000);

  // Value: protects=verify on a train whose every slot already merged, against a main another train verified, refuses as stale instead of freezing the queue and dispatching a backstop (#3519 c: train 24's record froze the queue at 9ccb5233, T1 of verified train 28, run 40586582766); fails_when=stopped() freezes when every slot merged and main's sha is another train's verified prefix, or refuses without that proof; why_new=every freeze test above has an unmerged or unverified main; seam=a second train record written into the state root; no_claim=what prune --stale then does (covered by the prune tests)
  test("verify on a train whose every slot merged, against a main another train verified, refuses as stale and freezes nothing", () => {
    const fx = make();
    const { nonce } = twoPrTrain(fx);
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).status).toBe(EXIT.ok);
    const t = trainJson(fx, nonce);
    const coord = coordinatorClone(fx.repo);
    const v = (pr: string) => queue(fx, ['verify', '--pr', pr, '--train', nonce], {}, coord);
    publishMain(fx, t.prefixes[1].commit, '1.2.4.0');
    expect(v('1').status).toBe(EXIT.ok);
    const later = publishMain(fx, t.prefixes[2].commit, '1.2.5.0', { file: 'stray.txt', text: 'a later train\n' });
    fx.write(d => { (d.prs['2'] as any).state = 'MERGED'; });
    const freezeFile = path.join(fx.state, 'ship-queue', 'freeze', `${repoKey(fx)}.json`);
    const tree = fx.repo.git('rev-parse', `${later}^{tree}`);
    const otherNonce = `${nonce}-later`;
    const other = { ...t, nonce: otherNonce, state: 'merging', prefixes: [t.prefixes[0], { index: 1, commit: later, tree, pr: '9' }], merged: [{ pr: '9', sha: later, tree, at: '2026-10-18T13:00:00.000Z' }] };
    fs.mkdirSync(path.join(fx.state, 'ship-queue', 'trains', otherNonce), { recursive: true });
    fs.writeFileSync(path.join(fx.state, 'ship-queue', 'trains', otherNonce, 'train.json'), JSON.stringify(other));
    const stale = v('2');
    expect(stale.status).toBe(EXIT.refused);
    expect(stale.err).toContain(`every slot of train ${nonce} merged on GitHub and main ${later.slice(0, 12)} is T1 of train ${otherNonce} (#9, verified at 2026-10-18T13:00:00.000Z), so this record is stale and the queue is not frozen`);
    expect(stale.err).toContain('(QUEUE_TRAIN_STALE)');
    expect(next(stale.out)).toBe(`NEXT: gstack-ship-queue train prune --stale --train ${nonce}`);
    expect(fs.existsSync(freezeFile)).toBe(false);
    expect(dispatches(fx, 'evals.yml').filter(d => d.ref === 'main').length).toBe(0);
    // Without another train's verified record for this main, the same mismatch still freezes.
    fs.rmSync(path.join(fx.state, 'ship-queue', 'trains', otherNonce), { recursive: true });
    const frozen = v('2');
    expect(frozen.status).toBe(EXIT.fail);
    expect(line(frozen.out, 'QUEUE_TRAIN_FROZEN:')).toMatch(/^QUEUE_TRAIN_FROZEN: train \S+ merged #1,#2; main /);
  }, 300_000);

  // Value: protects=a train with a slot still OPEN on GitHub freezes on a mismatch even when main's sha is another train's verified prefix; fails_when=the every-slot-merged guard before verifiedElsewhere is dropped or weakened, so a live train refuses as stale and skips the freeze; why_new=the test above only covers an all-merged train; seam=none; no_claim=prune behavior
  test("a train with a slot still open freezes on the mismatch even when another train verified main's sha", () => {
    const fx = make();
    const { nonce } = twoPrTrain(fx);
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).status).toBe(EXIT.ok);
    const t = trainJson(fx, nonce);
    const coord = coordinatorClone(fx.repo);
    const v = (pr: string) => queue(fx, ['verify', '--pr', pr, '--train', nonce], {}, coord);
    publishMain(fx, t.prefixes[1].commit, '1.2.4.0');
    expect(v('1').status).toBe(EXIT.ok);
    const later = publishMain(fx, t.prefixes[2].commit, '1.2.5.0', { file: 'stray.txt', text: 'a later train\n' });
    const tree = fx.repo.git('rev-parse', `${later}^{tree}`);
    const otherNonce = `${nonce}-later`;
    const other = { ...t, nonce: otherNonce, state: 'merging', prefixes: [t.prefixes[0], { index: 1, commit: later, tree, pr: '9' }], merged: [{ pr: '9', sha: later, tree, at: '2026-10-18T13:00:00.000Z' }] };
    fs.mkdirSync(path.join(fx.state, 'ship-queue', 'trains', otherNonce), { recursive: true });
    fs.writeFileSync(path.join(fx.state, 'ship-queue', 'trains', otherNonce, 'train.json'), JSON.stringify(other));
    const partial = v('2');
    expect(partial.status).toBe(EXIT.fail);
    expect(partial.err).not.toContain('(QUEUE_TRAIN_STALE)');
    expect(line(partial.out, 'QUEUE_TRAIN_FROZEN:')).toMatch(/^QUEUE_TRAIN_FROZEN: train \S+ merged #1; main /);
    expect(fs.existsSync(path.join(fx.state, 'ship-queue', 'freeze', `${repoKey(fx)}.json`))).toBe(true);
  }, 300_000);

  // Value: protects=a post-merge CHANGELOG difference is excused only when main's parent is T<i-1> modulo stamps, so a foreign commit between the verified head and the squash freezes; fails_when=published() skips or inverts the parent check; why_new=the two tests above reach the CHANGELOG rule only with a parent that is T1 modulo stamps; seam=none; no_claim=a parent differing from T1 in the CHANGELOG alone
  test("a post-merge CHANGELOG difference is not excused when main's parent is not the verified prefix modulo stamps: the queue freezes naming the parent", () => {
    const fx = make();
    const { nonce } = twoPrTrain(fx);
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).status).toBe(EXIT.ok);
    const t = trainJson(fx, nonce);
    const coord = coordinatorClone(fx.repo);
    const v = (pr: string) => queue(fx, ['verify', '--pr', pr, '--train', nonce], {}, coord);
    const released = fx.repo.git('show', `${t.prefixes[1].commit}:CHANGELOG.md`).replace('## [Unreleased]', '## [1.2.4.0] - 2026-10-18') + '\n';
    const main1 = publishMain(fx, t.prefixes[1].commit, '1.2.4.0', { file: 'CHANGELOG.md', text: released });
    expect(v('1').status).toBe(EXIT.ok);
    const foreign = publishMain(fx, t.prefixes[1].commit, '1.2.4.1', { file: 'stray.txt', text: 'landed between the two slots\n' });
    const text = fx.repo.git('show', `${main1}:CHANGELOG.md`).replace('# Changelog\n', '# Changelog\n\n## [1.2.5.0] - 2026-10-18\n\n- #2 change\n- added after the gate\n') + '\n';
    const main2 = publishMain(fx, t.prefixes[2].commit, '1.2.5.0', { file: 'CHANGELOG.md', text });
    expect(fx.repo.git('rev-parse', `${main2}^`)).toBe(foreign);
    const frozen = v('2');
    expect(frozen.status).toBe(EXIT.fail);
    expect(frozen.err).toContain(`main ${main2.slice(0, 12)} is neither T1 nor T2 modulo stamps`);
    expect(frozen.err).toContain(`main's parent ${foreign.slice(0, 12)} is not T1 modulo stamps`);
    expect(line(frozen.out, 'QUEUE_TRAIN_FROZEN:')).toMatch(/^QUEUE_TRAIN_FROZEN: train \S+ merged #1; main /);
  }, 300_000);
});
