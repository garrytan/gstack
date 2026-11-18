import { afterEach, expect, test } from 'bun:test';
import * as path from 'node:path';
import type { ShipReceipt } from '../lib/headless-artifacts';
import { receiptReviewAtHead, receiptTargetedAtHead } from '../lib/ship-receipt-depth';
import { cleanup, commit, makeFixtureRepo, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });
const bin = path.resolve(import.meta.dir, '../bin');

// Value: protects=the targeted refusal remains identical when write/carry reuse committed review inputs, and moving either
//   end invalidates that reuse; fails_when=a stale docs range hides new auth code or an advanced base keeps stale classes
test('receipt range reuse preserves the targeted verdict and refreshes after head or base moves', () => {
  const repo = makeFixtureRepo(); repos.push(repo);
  const prior = new Map(Object.keys(repo.env).map(key => [key, process.env[key]]));
  Object.assign(process.env, repo.env);
  try {
    const docs = commit(repo, { 'docs/range.md': '# range\n' });
    const review = receiptReviewAtHead(repo.work, 'main', bin, docs);
    const receipt = (head: string): ShipReceipt => ({ schema_version: 1, base: 'main', head,
      review_depth: { ...review.depth, gate_scan: { tagged: 0, head } } });
    const verdict = (head: string, reuse = true) => receiptTargetedAtHead(repo.work, 'origin/main', receipt(head), head, reuse ? review.range : undefined);
    expect(verdict(docs)).toEqual(verdict(docs, false));
    expect(verdict(docs).ok).toBe(true);

    const auth = commit(repo, { 'src/auth.ts': 'export const authenticate = () => true;\n' });
    expect(verdict(auth)).toEqual(verdict(auth, false));
    expect(verdict(auth).ok).toBe(false);
    expect(verdict(auth).line).toContain('auth');

    const authReview = receiptReviewAtHead(repo.work, 'main', bin, auth);
    repo.git('update-ref', 'refs/remotes/origin/main', auth);
    const moved = receiptTargetedAtHead(repo.work, 'origin/main', receipt(auth), auth, authReview.range);
    expect(moved).toEqual(verdict(auth, false));
    expect(moved.ok).toBe(true);
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}, 30_000);
