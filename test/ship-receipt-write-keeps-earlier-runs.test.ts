/**
 * gstack-ship-receipt write keeps the PR's earlier /ship runs when Step 19 hands it a freshly composed body (GST-3463 item 4):
 * Step 19 builds the body file from parts, so it holds no receipt and no runs block, and write placed only the new receipt
 * there; publishing it dropped every earlier run from the PR, so the next run's history counted fewer review rounds than the
 * PR had. With --pr, write now reads the live body's receipt and runs into a fresh body before placing the new receipt.
 * Control: an unreadable live body keeps today's output and says the earlier runs were not read.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { extractReceipt, receiptRuns } from '../lib/ship-receipt';
import { cleanup, commit, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

/** A feature branch with one /ship receipt already on the PR; the second head's write gets a fresh body file. */
function secondRun(live: (firstBody: string) => string | null): { repo: FixtureRepo; first: string; out: ReturnType<typeof runBin>; body: string } {
  const repo = makeFixtureRepo(); repos.push(repo);
  repo.git('checkout', '-q', 'feature');
  const write = (body: string, env: Record<string, string> = {}) => runBin(repo, 'gstack-ship-receipt', ['write', '--pr', '4700', '--base', 'main', '--version', '1.0.0', '--session-kind', 'unattended', '--body', body], env);
  const firstBody = path.join(repo.root, 'first.md');
  expect(write(firstBody).status).toBe(EXIT.ok);
  const first = repo.git('rev-parse', 'HEAD');
  commit(repo, { 'src/second.js': 'module.exports = 2;\n' }, 'feat: second head');
  const stub = path.join(repo.root, 'stub');
  fs.mkdirSync(stub);
  const text = live(fs.readFileSync(firstBody, 'utf8'));
  const json = path.join(repo.root, 'live.json');
  if (text !== null) fs.writeFileSync(json, JSON.stringify({ body: text }));
  fs.writeFileSync(path.join(stub, 'gh'), text === null ? '#!/bin/sh\necho "gh: not authenticated" >&2\nexit 1\n' : `#!/bin/sh\ncat '${json}'\n`, { mode: 0o755 });
  const body = path.join(repo.root, 'second.md');
  fs.writeFileSync(body, 'The second head fixes the rest.\n');
  const out = write(body, { PATH: `${stub}${path.delimiter}${process.env.PATH}` });
  return { repo, first, out, body };
}

describe('receipt write keeps the PR\'s earlier runs in a freshly composed body (GST-3463 item 4)', () => {
  // Value: protects=R51's per-PR round count, which reads the runs the PR body records; fails_when=a Step 19 body rewrite
  //   publishes only the newest receipt; seam=gstack-ship-receipt write --pr --body; no_claim=gh pr edit
  test('a fresh body gets the live body\'s receipt as an earlier run', () => {
    const { repo, first, out, body } = secondRun(t => t);
    expect(out.status, out.err).toBe(EXIT.ok);
    const text = fs.readFileSync(body, 'utf8');
    expect(text).toContain('The second head fixes the rest.');
    expect(extractReceipt(text).receipt?.head).toBe(repo.git('rev-parse', 'HEAD'));
    expect(receiptRuns(text).map(r => r.head)).toEqual([first]);
  }, 120_000);

  // Value: protects=a failed read is visible instead of a silent undercount (negative control); fails_when=write hides that it
  //   could not read the earlier runs; seam=gstack-ship-receipt write --pr; no_claim=gh pr edit
  test('an unreadable live body leaves only this run and says why', () => {
    const { out, body } = secondRun(() => null);
    expect(out.status, out.err).toBe(EXIT.ok);
    expect(out.err).toContain("RECEIPT_RUNS: PR #4700's earlier runs were not read");
    expect(receiptRuns(fs.readFileSync(body, 'utf8'))).toEqual([]);
  }, 120_000);
});
