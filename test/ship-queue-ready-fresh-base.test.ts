/**
 * gstack-ship-queue ready refreshes origin/<base> before it compares any receipt field (GST-2232): a lane clone whose
 * origin/main is behind the real remote must not turn a good receipt into RECEIPT_INVALID. The review_exclude
 * selection is the PR's own files, measured from the merge base with the fresh base, never a two-dot diff against
 * the base tip. Real fixture repos (bare origin plus working clone) and an offline gh.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { CHECK_IDS } from '../lib/pregate/index';
import { REVIEW_EXCLUDE_KEY_VERSION } from '../lib/ship-policy';
import { BASE_POLICY, cleanup, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/restamp-fixture';
import { ghQueueShim } from './helpers/ship-queue-fixture';
import { openPr, queue as trainQueue, shippedBody, trainFixture } from './helpers/ship-queue-train-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

const green = { check_runs: [{ status: 'completed', conclusion: 'success' }] };
const FULL_CHECKS = CHECK_IDS.map(id => ({ id, status: 'pass' }));
const queue = (repo: FixtureRepo, args: string[], env: Record<string, string>) => runBin(repo, 'gstack-ship-queue', [...args, '--base', 'main'], env);

function write(repo: FixtureRepo, files: Record<string, string>, message: string): string {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo.work, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo.work, rel), text);
  }
  repo.git('add', '-A');
  repo.git('commit', '-q', '-m', message);
  return repo.git('rev-parse', 'HEAD');
}

/** Lands `branch` on the remote main as a merge commit (merge: direct), then fetches, as another lane's landing does. */
function land(repo: FixtureRepo, branch: string): string {
  const back = repo.git('rev-parse', '--abbrev-ref', 'HEAD');
  repo.git('checkout', '-q', '-B', 'landing', 'origin/main');
  repo.git('merge', '-q', '--no-ff', '-m', `Merge ${branch}`, branch);
  repo.git('push', '-q', 'origin', 'HEAD:main');
  repo.git('fetch', '-q', 'origin');
  repo.git('checkout', '-q', back);
  return repo.git('rev-parse', 'origin/main');
}

/**
 * GBRA-108's shape: #2 is stacked on #1, both add a file under review_exclude_paths, and #1 landed. Against the fresh base the
 * merge base is #1's head, so the selection holds #2's file alone; against the pre-landing base it also holds #1's.
 */
function stackedAfterParentLanded() {
  const repo = makeFixtureRepo({ prefix: 'gstack-ready-base-', policy: { ...BASE_POLICY, review_exclude_paths: ['fixtures/goldens/**'], min_gstack_version: REVIEW_EXCLUDE_KEY_VERSION } });
  repos.push(repo);
  const before = repo.git('rev-parse', 'origin/main');
  repo.git('checkout', '-q', '-b', 'parent', 'origin/main');
  write(repo, { 'fixtures/goldens/parent.json': '{"parent": 1}\n', 'parent.txt': 'parent\n' }, 'parent');
  repo.git('checkout', '-q', '-b', 'child');
  const head = write(repo, { 'fixtures/goldens/child.json': '{"child": 2}\n', 'child.txt': 'child\n' }, 'child');
  const landed = land(repo, 'parent');
  const tree = runBin(repo, 'gstack-wtree', []).out.trim();
  const pregate = path.join(repo.root, 'pregate.json');
  fs.writeFileSync(pregate, JSON.stringify({ schema_version: 1, tree, head, verdict: 'pass', checks: FULL_CHECKS }));
  const ready = (digest: string) => queue(repo, ['ready', '--pr', '2', '--pregate', pregate], ghQueueShim(repo, { prs: { '2': { headRefOid: head, url: 'https://github.com/o/r/pull/2', body: shippedBody('2', head, { review_exclude: { source: 'origin/main', patterns: ['fixtures/goldens/**'], applied: ['fixtures/goldens/**'], excluded: 1, excluded_bytes: 0, kept: 0, gate_tagged: [], patterns_sha256: 'b'.repeat(64), list_sha256: 'c'.repeat(64), digest } }) } }, checks: { [head]: green } }));
  const probe = ready('a'.repeat(64));
  expect(probe.status, probe.out + probe.err).toBe(EXIT.refused);
  const digest = /field=review_exclude expected=([0-9a-f]{64}) recorded=a{64} source=origin\/main@([0-9a-f]{12})/.exec(probe.err);
  expect(digest?.[2], probe.out + probe.err).toBe(landed.slice(0, 12));
  return { repo, before, landed, head, digest: digest![1]!, ready };
}

describe('ready refreshes origin/<base> before comparing receipt fields (GST-2232)', () => {
  // Value: protects=a lane whose origin/main is three landings old READYs a receipt /ship wrote against the real base instead
  //   of refusing RECEIPT_INVALID (GBRA-108, gbrain #8991); fails_when=ready reads the local origin/<base> without fetching, or
  //   compares against a ref it could not refresh; why_new=every earlier ready test pushes and fetches before it runs, so the
  //   local ref was never behind; seam=ready -> bindShippedReceipt -> excludeMismatch; no_claim=land's own fetch (it refetches)
  test('a stale local origin/main is fetched, so the receipt binds; an unfetchable base refuses QUEUE_BASE_UNFETCHED before any field is compared', () => {
    const { repo, before, landed, digest, ready } = stackedAfterParentLanded();
    expect(ready(digest).status).toBe(EXIT.ok);
    repo.git('update-ref', 'refs/remotes/origin/main', before);
    const stale = ready(digest);
    expect([stale.status, stale.err]).toEqual([EXIT.ok, '']);
    expect(stale.out).toContain(`base: origin/main@${landed}`);
    expect(repo.git('rev-parse', 'origin/main')).toBe(landed);
    repo.git('update-ref', 'refs/remotes/origin/main', before);
    repo.git('remote', 'set-url', 'origin', path.join(repo.root, 'gone.git'));
    const offline = ready(digest);
    expect(offline.status).toBe(EXIT.refused);
    expect(offline.err).toMatch(/cannot fetch origin\/main.*\(QUEUE_BASE_UNFETCHED\)/);
    expect(offline.err).not.toContain('field=review_exclude');
  }, 180_000);

  // Value: protects=the queue's review_exclude selection is the PR's own files (merge-base diff), so a file another PR landed
  //   on the base after this one forked never enters it; fails_when=the selection is a two-dot diff against the base tip (the
  //   landed file reads as this PR deleting it) and every PR behind a landing refuses RECEIPT_INVALID; why_new=no ready test
  //   moved the base under an exclusion; seam=reviewExclude's range via bindShippedReceipt; no_claim=a squash-landed stacked
  //   parent, whose files the merge-base diff still holds on both the review and the queue side (GSTA-475's class)
  test('a file under review_exclude_paths that landed on the base after the PR forked does not change the selection', () => {
    const { repo, digest, ready } = stackedAfterParentLanded();
    const back = repo.git('rev-parse', '--abbrev-ref', 'HEAD');
    repo.git('checkout', '-q', '-b', 'other', 'origin/main');
    write(repo, { 'fixtures/goldens/other.json': '{"other": 3}\n', 'other.txt': 'other\n' }, 'other');
    repo.git('checkout', '-q', back);
    const moved = land(repo, 'other');
    const after = ready(digest);
    expect([after.status, after.err]).toEqual([EXIT.ok, '']);
    expect(after.out).toContain(`base: origin/main@${moved}`);
  }, 180_000);

  // Value: protects=ready chooses the train or plain path from the policy on a freshly fetched base, so a clone with no origin/main
  //   ref never runs plain ready under a train policy (which skips the screen, conflict and READY-receipt steps);
  //   fails_when=the bin reads the base policy before ready fetches it, finds none, prints that the policy declares no train block
  //   and exits 0 with no READY_RECEIPT; why_new=#4256's fetch sits inside ready(), after the routing; seam=bin/gstack-ship-queue's
  //   ready routing; no_claim=a base whose fetch fails (the case above refuses it)
  test('a clone with no origin/main ref routes ready by the fetched base policy: the train path, never plain ready', () => {
    const fx = trainFixture();
    repos.push(fx.repo);
    const head = openPr(fx, '1');
    fx.write(d => { d.ci[head] = [{ status: 'completed', conclusion: 'success' }]; });
    const pregate = path.join(fx.repo.root, 'pregate.json');
    fs.writeFileSync(pregate, JSON.stringify({ schema_version: 1, tree: runBin(fx.repo, 'gstack-wtree', []).out.trim(), head, verdict: 'pass', checks: FULL_CHECKS }));
    fx.repo.git('update-ref', '-d', 'refs/remotes/origin/main');
    const r = trainQueue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--no-screen']);
    expect(r.err).not.toContain('declares no train block');
    expect([r.status, r.err]).toEqual([EXIT.ok, '']);
    expect(r.out).toMatch(/^READY_RECEIPT: .* \(notes pushed to origin refs\/notes\/gstack-trains\)$/m);
  }, 180_000);
});
