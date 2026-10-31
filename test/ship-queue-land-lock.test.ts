/**
 * The shared land lock (lib/ship-queue-land-lock.ts, #3599): `land` and `train land` take the same
 * refs/notes/gstack-land lock, so a standalone land and a train slot can never both publish onto one main.
 * Module cases run against a bare origin and two clones (the race, the read states, owner kinds, the
 * --break-lock rules); command cases drive bin/gstack-ship-queue against the train fixture and its gh
 * shims (both directions, the train-scoped between phase, refusal and resume, the freeze-owned lock and the
 * repair train's takeover).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { acquireLandLock, LAND_LOCK_REF, readLock, writeLock, type LandLock, type LockOwner } from '../lib/ship-queue-land-lock';
import { BASE_POLICY, cleanup, makeFixtureRepo, type FixtureRepo } from './helpers/restamp-fixture';
import { coordinatorClone } from './helpers/ship-queue-fixture';
import {
  GREEN_GATE, TRAIN_POLICY, fragmentPr, nonceOf, queue, trainFixture, trainJson, wrapLand, type TrainFixture,
} from './helpers/ship-queue-train-fixture';

const repos: FixtureRepo[] = [];
const fixtures: TrainFixture[] = [];
afterEach(() => {
  while (repos.length) cleanup(repos.pop()!);
  while (fixtures.length) cleanup(fixtures.pop()!.repo);
});

const T0 = Date.parse('2026-10-31T12:00:00Z');
const at = (min: number) => () => new Date(T0 + min * 60_000);

/** Run fn with the fixture's git identity in process.env (the lock writes commits in-process). */
function withRepoEnv<T>(repo: FixtureRepo, fn: () => T): T {
  const saved = Object.fromEntries(Object.keys(repo.env).map(k => [k, process.env[k]]));
  Object.assign(process.env, repo.env);
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
function bareRepo(): FixtureRepo { const r = makeFixtureRepo({ policy: BASE_POLICY, prefix: 'gstack-land-lock-' }); repos.push(r); return r; }
const standalone = (pr: string): LockOwner => ({ pr });
const slotOf = (train: string, slot: number, pr: string): LockOwner => ({ train, slot, pr });
function take(root: string, owner: LockOwner, o: { journal?: string; now?: () => Date; breakLock?: boolean; breakTrainLock?: boolean; liveTrain?: (nonce: string) => boolean; phase?: LandLock['phase'] } = {}) {
  return acquireLandLock({
    root, holder: 'test:1', owner, journal: o.journal ?? ('train' in owner && owner.train ? `train/${owner.train}/slot-${owner.slot}` : `land/${owner.pr}`),
    phase: () => o.phase ?? 'stamping', now: o.now ?? at(0), breakLock: o.breakLock, breakTrainLock: o.breakTrainLock, liveTrain: o.liveTrain,
  });
}
const failureOf = (r: ReturnType<typeof take>) => ('failure' in r ? r.failure : null);

describe('the lock module', () => {
  test('two writers racing the same lock sha leave one winner', () => {
    const repo = bareRepo();
    const other = coordinatorClone(repo);
    withRepoEnv(repo, () => {
      const lock = (pr: string): LandLock => ({ pr, holder: `h${pr}`, started_at: new Date(T0).toISOString(), phase: 'stamping', journal: `land/${pr}` });
      expect(readLock(repo.work).state).toBe('absent');
      const first = writeLock(repo.work, '', lock('1'));
      const second = writeLock(other, '', lock('2'));
      expect([first.ok, second.ok]).toEqual([true, false]);
      const seen = readLock(other);
      expect(seen.state === 'held' && seen.lock.pr).toBe('1');
      const a = writeLock(repo.work, seen.sha, lock('3'));
      const b = writeLock(other, seen.sha, lock('4'));
      expect([a.ok, b.ok]).toEqual([true, false]);
      const final = readLock(other);
      expect(final.state === 'held' && final.lock.pr).toBe('3');
    });
  }, 60_000);

  test('absent, released, held and unreadable are distinct; an unreadable lock refuses, and --break-lock replaces it', () => {
    const repo = bareRepo();
    withRepoEnv(repo, () => {
      const root = repo.work;
      expect(readLock(root)).toMatchObject({ state: 'absent' });
      const got = take(root, standalone('5'));
      expect(failureOf(got)).toBeNull();
      expect(readLock(root)).toMatchObject({ state: 'held', lock: { pr: '5', phase: 'stamping' } });
      if ('held' in got) expect(got.held.release()).toBe(true);
      expect(readLock(root)).toMatchObject({ state: 'released' });
      const junk = repo.git('commit-tree', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', '-m', 'not a lock');
      repo.git('push', '-q', '-f', 'origin', `${junk}:${LAND_LOCK_REF}`);
      expect(readLock(root)).toMatchObject({ state: 'unreadable' });
      const refused = take(root, standalone('6'));
      expect(failureOf(refused)).toMatchObject({ code: 'QUEUE_LAND_LOCKED' });
      expect(failureOf(refused)!.message).toContain('cannot be read');
      const broke = take(root, standalone('6'), { breakLock: true });
      expect(failureOf(broke)).toBeNull();
      expect(broke.lines.join('\n')).toContain(`LOCK: broke an unreadable lock at ${junk.slice(0, 12)}`);
      expect(readLock(root)).toMatchObject({ state: 'held', lock: { pr: '6' } });
    });
  }, 60_000);

  test('ownership compares the owner kind and journal: the same PR across commands and across trains refuses; a resume of the same journal and a sequential acquisition succeed', () => {
    const repo = bareRepo();
    withRepoEnv(repo, () => {
      const root = repo.work;
      const mine = take(root, standalone('7'), { phase: 'waiting' });
      expect(failureOf(mine)).toBeNull();
      const asSlot = take(root, slotOf('trainA', 1, '7'));
      expect(failureOf(asSlot)).toMatchObject({ code: 'QUEUE_LAND_LOCKED' });
      expect(failureOf(asSlot)!.message).toMatch(/^#7 holds the land lock \(test:1, phase waiting, since /);
      const resumed = take(root, standalone('7'), { now: at(3) });
      expect(failureOf(resumed)).toBeNull();
      expect(readLock(root)).toMatchObject({ state: 'held', lock: { pr: '7', started_at: new Date(T0).toISOString() } });
      if ('held' in resumed) resumed.held.release();

      const trainA = take(root, slotOf('trainA', 1, '7'), { phase: 'pushing' });
      expect(failureOf(trainA)).toBeNull();
      expect(readLock(root)).toMatchObject({ state: 'held', lock: { train: 'trainA', slot: 1, pr: '7' } });
      const trainB = take(root, slotOf('trainB', 1, '7'));
      expect(failureOf(trainB)!.message).toMatch(/^train trainA slot 1 \(#7\) holds the land lock/);
      expect(failureOf(take(root, standalone('7')))!.message).toMatch(/^train trainA slot 1 \(#7\) holds the land lock/);
      expect(failureOf(take(root, slotOf('trainA', 2, '8')))!.message).toMatch(/^train trainA slot 1 \(#7\) holds the land lock/);
      const same = take(root, slotOf('trainA', 1, '7'));
      expect(failureOf(same)).toBeNull();
      if ('held' in same) same.held.release();
      expect(failureOf(take(root, standalone('8')))).toBeNull();
    });
  }, 60_000);

  test('--break-lock prints the holder, refuses a live train run\'s lock without --break-train-lock, and keeps the staleness, mid-push, between and freeze rules', () => {
    const repo = bareRepo();
    withRepoEnv(repo, () => {
      const root = repo.work;
      const hold = (owner: LockOwner, phase: LandLock['phase']) => {
        const r = readLock(root);
        if (r.state === 'held') writeLock(root, r.sha, { released: true, by: 'test', at: new Date(T0).toISOString() });
        expect(failureOf(take(root, owner, { phase }))).toBeNull();
      };
      hold(slotOf('trainA', 2, '9'), 'waiting');
      const live = take(root, standalone('3'), { breakLock: true, now: at(1) });
      expect(failureOf(live)).toMatchObject({ code: 'QUEUE_LAND_LOCKED' });
      expect(failureOf(live)!.message).toContain('--break-train-lock');
      expect(live.lines).toContain(`LOCK_HOLDER: train trainA slot 2 (#9) holder=test:1 phase=waiting since=${new Date(T0).toISOString()}`);
      const ended = take(root, standalone('3'), { breakLock: true, now: at(1), liveTrain: () => false });
      expect(failureOf(ended)).toBeNull();
      expect(ended.lines).toContain("LOCK: broke train trainA slot 2 (#9)'s lock (test:1, phase waiting)");

      hold(slotOf('trainA', 2, '9'), 'waiting');
      const forced = take(root, standalone('3'), { breakLock: true, breakTrainLock: true, now: at(1) });
      expect(failureOf(forced)).toBeNull();

      hold(slotOf('trainA', 1, '9'), 'between');
      const young = take(root, standalone('3'), { breakLock: true, breakTrainLock: true, now: at(1) });
      expect(failureOf(young)!.message).toMatch(/train trainA slot 1 \(#9\) is between slots \(60 s ago\); --break-lock refused/);
      expect(failureOf(take(root, standalone('3'), { breakLock: true, breakTrainLock: true, now: at(11) }))).toBeNull();

      hold(slotOf('trainA', 1, '9'), 'pushing');
      expect(failureOf(take(root, standalone('3'), { breakLock: true, breakTrainLock: true, now: at(1) }))!.message).toMatch(/train trainA slot 1 \(#9\)'s holder is mid-push \(60 s ago\); --break-lock refused/);

      hold(slotOf('trainA', 1, '9'), 'freeze');
      const frozen = take(root, standalone('3'), { breakLock: true, breakTrainLock: true, now: at(60) });
      expect(failureOf(frozen)).toMatchObject({ code: 'QUEUE_TRAIN_FROZEN' });
      expect(failureOf(take(root, slotOf('trainB', 1, '4'), { breakLock: true, breakTrainLock: true, now: at(60) }))).toMatchObject({ code: 'QUEUE_TRAIN_FROZEN' });

      hold(standalone('5'), 'waiting');
      const plain = take(root, standalone('3'), { breakLock: true, now: at(1) });
      expect(plain.lines).toContain(`LOCK_HOLDER: #5 holder=test:1 phase=waiting since=${new Date(T0).toISOString()}`);
      expect(plain.lines).toContain("LOCK: broke #5's lock (test:1, phase waiting)");
    });
  }, 60_000);
});

const POLICY = { ...TRAIN_POLICY, release_tool: null, release_outputs: [], changelog_fragments: { dir: 'changelog.d' }, min_gstack_version: '1.91.336.0' };
function stampedTrain(prs = ['1', '2']) {
  const fx = trainFixture(POLICY, 'gstack-land-lock-'); fixtures.push(fx); wrapLand(fx);
  const heads = prs.map(pr => fragmentPr(fx, pr));
  fx.write(d => { d.rules['evals.yml'] = GREEN_GATE; });
  const nonce = nonceOf(queue(fx, ['train', 'build', '--prs', prs.map((pr, i) => `${pr}@${heads[i]}`).join(',')]).out);
  expect(queue(fx, ['train', 'verdict', '--train', nonce]).status).toBe(EXIT.ok);
  return { fx, heads, nonce };
}
const trainLand = (fx: TrainFixture, nonce: string, pr: string, extra: string[] = []) => queue(fx, ['train', 'land', '--train', nonce, '--pr', pr, '--no-wait', ...extra]);
const land = (fx: TrainFixture, pr: string, extra: string[] = []) => queue(fx, ['land', '--pr', pr, '--no-wait', '--allow-repo-commands', ...extra]);
const originRev = (fx: TrainFixture, ref: string) => fx.repo.git('--git-dir', fx.repo.origin, 'rev-parse', '--verify', '-q', ref);
/** The lock as origin holds it: the parsed lock.json, or null when origin has no lock ref. */
function originLock(fx: TrainFixture): any {
  const sha = (() => { try { return originRev(fx, LAND_LOCK_REF); } catch { return ''; } })();
  return sha ? JSON.parse(fx.repo.git('--git-dir', fx.repo.origin, 'show', `${sha}:lock.json`)) : null;
}
const freezeFile = (fx: TrainFixture) => path.join(fx.state, 'ship-queue', 'freeze');

describe('land and train land share the lock', () => {
  test('a train slot holding the lock refuses a standalone land (no takeover, no freeze; --break-lock names the train and wants --break-train-lock); the train keeps it between slots and releases it after the last', () => {
    const { fx, heads, nonce } = stampedTrain();
    const pin3 = fragmentPr(fx, '3');
    const pushed = trainLand(fx, nonce, '1');
    expect(pushed.out, pushed.err).toMatch(/^PUSHED: [0-9a-f]{40}/m);
    expect(originLock(fx)).toMatchObject({ train: nonce, slot: 1, pr: '1', phase: 'waiting' });
    const lockSha = originRev(fx, LAND_LOCK_REF);

    const blocked = land(fx, '3');
    expect(blocked.status).toBe(EXIT.refused);
    expect(blocked.err).toMatch(new RegExp(`train ${nonce} slot 1 \\(#1\\) holds the land lock .*phase waiting.*\\(QUEUE_LAND_LOCKED\\)`));
    const broke = land(fx, '3', ['--break-lock']);
    expect(broke.status).toBe(EXIT.refused);
    expect(broke.err).toContain('--break-train-lock');
    expect(broke.out).toMatch(new RegExp(`^LOCK_HOLDER: train ${nonce} slot 1 \\(#1\\) holder=\\S+ phase=waiting since=`, 'm'));
    expect(originRev(fx, LAND_LOCK_REF)).toBe(lockSha);
    expect(originRev(fx, 'refs/heads/pr-3')).toBe(pin3);
    expect(fs.existsSync(freezeFile(fx))).toBe(false);

    const merged = trainLand(fx, nonce, '1');
    expect(merged.status, merged.err).toBe(EXIT.ok);
    expect(originLock(fx)).toMatchObject({ train: nonce, slot: 1, pr: '1', phase: 'between' });
    expect(land(fx, '3').err).toMatch(new RegExp(`train ${nonce} slot 1 \\(#1\\) holds the land lock .*phase between.*\\(QUEUE_LAND_LOCKED\\)`));
    expect(originRev(fx, 'refs/heads/pr-3')).toBe(pin3);

    const second = trainLand(fx, nonce, '2');
    expect(second.out, second.err).toMatch(/^LOCK: train \S+ slot 2 takes over its train's between-slots lock/m);
    expect(originLock(fx)).toMatchObject({ train: nonce, slot: 2, pr: '2', phase: 'waiting' });
    expect(trainLand(fx, nonce, '2').status).toBe(EXIT.ok);
    expect(originLock(fx)).toMatchObject({ released: true });
    expect(trainJson(fx, nonce).state).toBe('merged');
    expect(land(fx, '3').out).toMatch(/^PUSHED: [0-9a-f]{40}/m);
    void heads;
  }, 300_000);

  test('a standalone land holding the lock refuses train land; a refusal before any push releases the train\'s lock', () => {
    const { fx, heads, nonce } = stampedTrain();
    fragmentPr(fx, '3');
    expect(land(fx, '3').out).toMatch(/^PUSHED: /m);
    const blocked = trainLand(fx, nonce, '1');
    expect(blocked.status).toBe(EXIT.refused);
    expect(blocked.err).toMatch(/#3 holds the land lock .*phase waiting.*\(QUEUE_LAND_LOCKED\)/);
    expect(blocked.out).not.toMatch(/^PUSHED:/m);
    expect(originRev(fx, 'refs/heads/pr-1')).toBe(heads[0]);

    expect(land(fx, '3').out).toContain('LOCK: released');
    const stale = trainLand(fx, nonce, '1');
    expect(stale.err).toMatch(/nothing of train \S+ merged, so the queue is not frozen.*\(QUEUE_TRAIN_TREE_MISMATCH\)/);
    expect(originLock(fx)).toMatchObject({ released: true });
  }, 300_000);

  test('after a push the train keeps its lock through a failed wait and a resume takes it back', () => {
    const { fx, nonce } = stampedTrain(['1']);
    const stamp = /^PUSHED: ([0-9a-f]{40})/m.exec(trainLand(fx, nonce, '1').out)![1]!;
    fx.write(d => { d.ci[stamp] = [{ name: 'free-tests', status: 'completed', conclusion: 'failure' }] as any; });
    const red = trainLand(fx, nonce, '1');
    expect(red.status).not.toBe(EXIT.ok);
    expect(originLock(fx)).toMatchObject({ train: nonce, slot: 1, pr: '1', phase: 'waiting' });
    fx.write(d => { delete d.ci[stamp]; });
    const resumed = trainLand(fx, nonce, '1');
    expect(resumed.status, resumed.err).toBe(EXIT.ok);
    expect(originLock(fx)).toMatchObject({ released: true });
  }, 300_000);

  test('a stop that freezes leaves the lock in a freeze phase that --break-lock never breaks; only the admitted repair train takes it over, and it is released once the freeze clears', () => {
    const { fx, nonce } = stampedTrain();
    trainLand(fx, nonce, '1');
    expect(trainLand(fx, nonce, '1').status).toBe(EXIT.ok);
    trainLand(fx, nonce, '2');
    fx.write(d => { (d as any).outsideOnMerge = true; });
    const drift = trainLand(fx, nonce, '2');
    expect(drift.err).toContain('(QUEUE_TRAIN_TREE_MISMATCH)');
    expect(drift.out).toMatch(/^QUEUE_TRAIN_FROZEN: /m);
    expect(originLock(fx)).toMatchObject({ train: nonce, phase: 'freeze' });
    const lockSha = originRev(fx, LAND_LOCK_REF);

    fragmentPr(fx, '3');
    const refused = land(fx, '3', ['--break-lock', '--break-train-lock']);
    expect(refused.status).toBe(EXIT.refused);
    expect(refused.err).toContain('(QUEUE_TRAIN_FROZEN)');
    expect(originRev(fx, LAND_LOCK_REF)).toBe(lockSha);

    const h4 = fragmentPr(fx, '4');
    const repair = queue(fx, ['train', 'build', '--repair', '--prs', `4@${h4}`]);
    expect(repair.status, repair.err).toBe(EXIT.ok);
    const rn = nonceOf(repair.out);
    expect(queue(fx, ['train', 'verdict', '--train', rn]).status).toBe(EXIT.ok);
    const taken = trainLand(fx, rn, '4');
    expect(taken.out, taken.err).toMatch(new RegExp(`^LOCK: repair train ${rn} takes over the freeze lock of train ${nonce}`, 'm'));
    expect(originLock(fx)).toMatchObject({ train: rn, slot: 1, pr: '4', phase: 'freeze' });
    expect(land(fx, '3', ['--break-lock', '--break-train-lock']).err).toContain('(QUEUE_TRAIN_FROZEN)');
    const cleared = trainLand(fx, rn, '4');
    expect(cleared.status, cleared.err).toBe(EXIT.ok);
    expect(cleared.out).toMatch(/^FREEZE: cleared /m);
    expect(originLock(fx)).toMatchObject({ released: true });
  }, 600_000);
});
