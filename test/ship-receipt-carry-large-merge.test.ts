/**
 * gstack-ship-receipt carry across a base merge whose path listing passes 1 MiB (GST-552, harness-evals#147:
 * about 8,300 added files, a 1.37 MB `git diff --name-only`). spawnSync's default 1 MiB maxBuffer made that
 * listing fail with ENOBUFS, so every carry across the merge was refused as "git diff ... failed".
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { extractReceipt } from '../lib/ship-receipt';
import { GitRunError, receiptGit } from '../lib/ship-receipt-depth';
import { cleanup, commit, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

/** 4,600 empty files under long paths: about 1.15 MB of `git diff --name-only`, one shared blob. */
function addManyFiles(work: string): void {
  const dir = path.join(work, 'vendor', 'x'.repeat(200));
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 4600; i++) fs.writeFileSync(path.join(dir, `${'f'.repeat(30)}-${i}.txt`), '');
}

describe('carry across a base merge with a listing over 1 MiB (GST-552)', () => {
  // Value: protects=a receipt carries across a huge base merge (harness-evals#147 refused every carry with ENOBUFS);
  // fails_when=the carry's git listings run with the 1 MiB default buffer; seam=none; no_claim=gh pr edit (--body stands in)
  test('the product-unchanged branch carries, and a listing past the buffer is a named error, never a false', () => {
    const repo = makeFixtureRepo(); repos.push(repo);
    const reviewed = commit(repo, { 'lib/util.js': "exports.add = (a, b) => a + b + 0;\n" });
    const body = path.join(repo.root, 'body.md');
    const w = runBin(repo, 'gstack-ship-receipt', ['write', '--pr', '7', '--base', 'main', '--version', '1.0.0', '--session-kind', 'unattended', '--body', body]);
    expect(w.status).toBe(EXIT.ok);
    repo.git('checkout', '-q', 'main');
    addManyFiles(repo.work);
    repo.git('add', '-A'); repo.git('commit', '-qm', 'main: vendor drop'); repo.git('push', '-q', 'origin', 'main');
    repo.git('checkout', '-q', 'feature');
    repo.git('merge', '-q', '--no-edit', 'origin/main');
    const head = repo.git('rev-parse', 'HEAD');
    const listing = spawnSync('git', ['diff', '--name-only', reviewed, head], { cwd: repo.work, env: { ...process.env, ...repo.env }, encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
    expect(listing.stdout.length).toBeGreaterThan(1024 * 1024);
    expect(() => receiptGit(repo.work, ['diff', '--name-only', reviewed, head], 30_000, 1024 * 1024)).toThrow(GitRunError);
    expect(() => receiptGit(repo.work, ['diff', '--name-only', reviewed, head], 30_000, 1024 * 1024)).toThrow('git diff --name-only could not be read: its output exceeded the 1 MiB buffer');
    expect(receiptGit(repo.work, ['merge-base', '--is-ancestor', head, reviewed]).ok).toBe(false);

    const out = runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body, '--base', 'main']);
    expect(out.err).not.toContain('failed');
    expect(out.status).toBe(EXIT.ok);
    expect(out.out).toContain(`CARRY: carried from ${reviewed.slice(0, 12)} to ${head.slice(0, 12)}`);
    expect(extractReceipt(fs.readFileSync(body, 'utf8')).receipt!.head).toBe(head);
  }, 90_000);
});
