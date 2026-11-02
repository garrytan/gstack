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
import { parseChangelog } from '../lib/changelog-check';
import { EXIT } from '../lib/headless-artifacts';
import { baseOverlap } from '../lib/ship-queue-train';
import { TRAIN_HELP } from '../lib/ship-queue-train-cli';
import { BASE_POLICY, cleanup, runBin } from './helpers/restamp-fixture';
import { coordinatorClone } from './helpers/ship-queue-fixture';
import { publishMain, twoPrTrain } from './helpers/ship-queue-train-cases';
import {
  GREEN_GATE, TRAIN_BLOCK, TRAIN_POLICY, dispatches, githubOrigin, line, mergeRefCommit, nonceOf, openPr, queue, readyReceipt, repoKey, setPrBody, shippedBody, trainFixture, trainJson, urlKey,
  type Rule, type TrainFixture,
} from './helpers/ship-queue-train-fixture';

const fixtures: TrainFixture[] = [];
const make = (policy: Record<string, unknown> = TRAIN_POLICY) => { const f = trainFixture(policy); fixtures.push(f); return f; };
afterEach(() => { while (fixtures.length) cleanup(fixtures.pop()!.repo); });

const result = (out: string) => line(out, 'GSTACK_RESULT:');
const next = (out: string) => line(out, 'NEXT:');
const remoteRefs = (fx: TrainFixture) => fx.repo.git('ls-remote', 'origin');

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

  // Value: protects=under changelog_fragments ready records the READY receipt land checks, only after every ready check passed; fails_when=land has no proof of the pregate; why_new=the case above covers the key off; seam=none; no_claim=the notes push to a real GitHub remote
  test('under changelog_fragments ready records a READY receipt; a failed pregate records none', () => {
    const fx = make({ ...BASE_POLICY, changelog_fragments: { dir: 'changelog.d' }, min_gstack_version: '1.91.336.0' });
    const head = openPr(fx, '1');
    fx.write(d => { d.ci[head] = [{ status: 'completed', conclusion: 'success' }]; });
    const tree = runBin(fx.repo, 'gstack-wtree', []).out.trim();
    const pregate = path.join(fx.repo.root, 'pregate.json');
    fs.writeFileSync(pregate, JSON.stringify({ schema_version: 1, tree, head, verdict: 'fail', checks: [{ id: 'unit', status: 'fail' }] }));
    expect(queue(fx, ['ready', '--pr', '1', '--pregate', pregate]).status).toBe(EXIT.refused);
    expect(fs.existsSync(path.join(fx.state, 'ship-queue'))).toBe(false);
    fs.writeFileSync(pregate, JSON.stringify({ schema_version: 1, tree, head, verdict: 'pass', checks: [{ id: 'unit', status: 'pass' }] }));
    const ok = queue(fx, ['ready', '--pr', '1', '--pregate', pregate]);
    expect(ok.status).toBe(EXIT.ok);
    expect(ok.out).toMatch(new RegExp(`^READY_RECEIPT: .*ship-queue/ready/[^/]+/1-${head}\\.json \\(notes pushed to origin refs/notes/gstack-trains\\)$`, 'm'));
    expect(fx.repo.git('ls-remote', 'origin', 'refs/notes/gstack-trains')).not.toBe('');
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
