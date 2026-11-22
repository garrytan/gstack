/**
 * gstack-ship-queue ready takes the base from the PR it is given (GST-3445): a PR into a branch other than the
 * repository's default branch binds its /ship receipt against that branch, not origin/HEAD. Founderstar #1024 targets
 * garrytan/v0.2-plan-wip and ready refused its correct receipt with QUEUE_RECEIPT_BASE_MISMATCH against main.
 * Real fixture repos (bare origin plus working clone) and an offline gh.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { CHECK_IDS } from '../lib/pregate/index';
import { BASE_POLICY, cleanup, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/restamp-fixture';
import { ghQueueShim } from './helpers/ship-queue-fixture';
import { shippedBody } from './helpers/ship-queue-train-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

const green = { check_runs: [{ status: 'completed', conclusion: 'success' }] };
const FULL_CHECKS = CHECK_IDS.map(id => ({ id, status: 'pass' }));
const WIP = 'garrytan/v0.2-plan-wip';

function commit(repo: FixtureRepo, rel: string, text: string): string {
  fs.mkdirSync(path.dirname(path.join(repo.work, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo.work, rel), text);
  repo.git('add', '-A');
  repo.git('commit', '-q', '-m', rel);
  return repo.git('rev-parse', 'HEAD');
}

/**
 * origin/HEAD names main; PR #2 is a branch off `branch` (default ${WIP}), which has a commit main lacks. GitHub reports the PR's
 * base as `baseRefName` (default the branch). With failBaseLookup, gh fails the bin's own `pr view --json baseRefName` lookup and
 * answers every other call.
 */
function prIntoWip(o: { branch?: string; baseRefName?: string; failBaseLookup?: boolean; recordBase?: string } = {}) {
  const branch = o.branch ?? WIP;
  const repo = makeFixtureRepo({ prefix: 'gstack-ready-pr-base-', policy: BASE_POLICY });
  repos.push(repo);
  repo.git('checkout', '-q', '-b', 'wip', 'origin/main');
  commit(repo, 'plan.txt', 'wip plan\n');
  repo.git('push', '-q', 'origin', `HEAD:refs/heads/${branch}`);
  repo.git('fetch', '-q', 'origin');
  repo.git('checkout', '-q', '-b', 'pr-2', `origin/${branch}`);
  const head = commit(repo, 'feature.txt', 'feature\n');
  const pregate = path.join(repo.root, 'pregate.json');
  const recorded = o.recordBase ? { base: `origin/${o.recordBase}@${repo.git('rev-parse', `origin/${o.recordBase}`).slice(0, 12)}` } : {};
  fs.writeFileSync(pregate, JSON.stringify({ schema_version: 1, tree: runBin(repo, 'gstack-wtree', []).out.trim(), head, verdict: 'pass', checks: FULL_CHECKS, ...recorded }));
  const ready = (receiptBase: string, extra: string[] = []) => {
    const shim = ghQueueShim(repo, { prs: { '2': { headRefOid: head, url: 'https://github.com/o/r/pull/2', baseRefName: o.baseRefName ?? branch, isCrossRepository: false, headRefName: 'pr-2', body: shippedBody('2', head, { base: receiptBase }) } }, checks: { [head]: green } });
    if (!o.failBaseLookup) return runBin(repo, 'gstack-ship-queue', ['ready', '--pr', '2', '--pregate', pregate, ...extra], shim);
    const dir = path.join(repo.root, 'gh-flaky-base');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'gh'), `#!/bin/sh\nif [ "$1" = pr ] && [ "$2" = view ] && [ "$4" = --json ] && [ "$5" = baseRefName ]; then echo 'HTTP 502: Bad Gateway' >&2; exit 1; fi\nexec "${path.join(repo.root, 'gh-queue-shim', 'gh')}" "$@"\n`, { mode: 0o755 });
    return runBin(repo, 'gstack-ship-queue', ['ready', '--pr', '2', '--pregate', pregate, ...extra], { PATH: `${dir}:${shim.PATH}` });
  };
  return { repo, ready };
}

describe('ready binds the receipt to the PR base, not the default branch (GST-3445)', () => {
  // Value: protects=a PR into a non-default branch READYs with the receipt /ship wrote against that branch (Founderstar #1024);
  //   fails_when=ready without --base resolves origin/HEAD (main) and refuses QUEUE_RECEIPT_BASE_MISMATCH; why_new=every ready
  //   test passes --base main or opens its PR into main; seam=bin/gstack-ship-queue's base resolution -> bindShippedReceipt;
  //   no_claim=a PR from a fork into a branch origin does not hold
  test('with no --base, a receipt for the PR base binds; a receipt for the default branch is still refused', () => {
    const { ready } = prIntoWip();
    const ok = ready(WIP);
    expect([ok.status, ok.err]).toEqual([EXIT.ok, '']);
    expect(ok.out).toMatch(new RegExp(`^base: origin/${WIP}@[0-9a-f]{40}$`, 'm'));
    const wrong = ready('main');
    expect(wrong.status).toBe(EXIT.refused);
    expect(wrong.err).toContain('QUEUE_RECEIPT_BASE_MISMATCH');
  }, 180_000);

  // Value: protects=an explicit --base that is not the PR's base never binds a receipt reviewed against the wrong branch;
  //   fails_when=ready trusts --base over the PR and READYs a main receipt for a PR into another branch; why_new=ready never
  //   read the PR's base; seam=bin/gstack-ship-queue ready; no_claim=land, which already refuses a PR on another base
  test('an explicit --base other than the PR base refuses before any receipt is read', () => {
    const { ready } = prIntoWip();
    const r = ready('main', ['--base', 'main']);
    expect(r.status).toBe(EXIT.refused);
    expect(r.err).toContain(`#2 targets ${WIP}, not main`);
    expect(r.err).toContain('QUEUE_NOT_READY');
    expect(r.err).not.toContain('QUEUE_RECEIPT_BASE_MISMATCH');
  }, 180_000);

  // Value: protects=ready never prints READY for a PR whose GitHub base is not the base ready checked the receipt against;
  //   fails_when=ready trusts the bin's base lookup, so a failed lookup (falls back to main) or a base named origin/foo (stripped
  //   to foo) binds the wrong receipt; why_new=the cases above only cover a lookup that succeeds with a plain name;
  //   seam=lib/ship-queue.ts ready()'s own pr view; no_claim=land, which refuses a PR on another base by itself
  test("ready refuses when the PR's base differs from the checked base: a failed base lookup, or a base named origin/<branch>", () => {
    const lookupFailed = prIntoWip({ failBaseLookup: true }).ready('main');
    expect(lookupFailed.status).toBe(EXIT.refused);
    expect(lookupFailed.err).toContain(`#2 targets ${WIP}, not main`);
    expect(lookupFailed.err).toContain('QUEUE_NOT_READY');
    const stripped = prIntoWip({ branch: 'foo', baseRefName: 'origin/foo' }).ready('foo');
    expect(stripped.status).toBe(EXIT.refused);
    expect(stripped.err).toContain('#2 targets origin/foo, not foo');
    expect(stripped.err).toContain('QUEUE_NOT_READY');
  }, 180_000);

  // Value: protects=ready and land accept a pregate.json only for the base the PR targets (GST-3493);
  //   fails_when=ready verifies the checkout's own record without the base, so a record taken against main READYs a PR into another
  //   branch (or one retargeted after finish); why_new=the by-tree mirror already checked its base, the local record did not;
  //   seam=lib/ship-queue.ts ready()'s verifyPregate; no_claim=a record with no base field, which has nothing to compare
  test('a pregate.json taken against another base is not current for the PR; one taken against its base is', () => {
    const other = prIntoWip({ recordBase: 'main' }).ready(WIP);
    expect(other.status).toBe(EXIT.refused);
    expect(other.out).toMatch(new RegExp(`^PREGATE: pass .* pregate\\.json was recorded against origin/main, but this ships against origin/${WIP}; .*\\(PREGATE_STALE\\)$`, 'm'));
    const same = prIntoWip({ recordBase: WIP }).ready(WIP);
    expect([same.status, same.err]).toEqual([EXIT.ok, '']);
  }, 180_000);
});
