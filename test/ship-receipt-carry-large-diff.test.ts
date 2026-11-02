/**
 * gstack-ship-receipt carry on a PR whose own diff is large (GST-448, harness-evals#147): a results PR that adds thousands
 * of run-receipt files has a name-only listing and a product diff over the child-process output buffer, so carry refused
 * with "git could not compute HEAD's product patch-id: git diff … failed" after every base move.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { extractReceipt } from '../lib/ship-receipt';
import { cleanup, commit, makeFixtureRepo as makeRepo, runBin, write, type FixtureRepo } from './helpers/pregate-fixture';
const makeFixtureRepo = (): FixtureRepo => { const r = makeRepo(); r.git('config', 'core.longpaths', 'true'); return r; };

setDefaultTimeout(120_000);
const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });
const DIR = `results/${'harness-eval-run-receipts-'.repeat(8)}`;
/** `count` run receipts under a long directory name: about 1.4 MB of paths and 2 MB of diff, past the 1 MB default buffer. */
const receipts = (count: number, tag: string) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`${DIR}/${tag}-run-${String(i).padStart(5, '0')}.json`, `{"run":${i},"tag":"${tag}","score":0.${i % 10}}\n`]));

describe('carry with a large product diff (GST-448)', () => {
  // Value: protects=a results PR keeps its receipt across a base move when its own diff is megabytes of added files
  //   (harness-evals#147 paid ~3h of /ship per base move); fails_when=carry buffers git's name-only listing or the diff in
  //   a bounded child-process buffer and refuses; seam=none; no_claim=gh pr edit (--body stands in)
  test('a base merge carries the receipt of a PR that adds 6000 files', () => {
    const repo = makeFixtureRepo(); repos.push(repo);
    commit(repo, receipts(6000, 'base'), 'results: 6000 run receipts');
    const body = path.join(repo.root, 'body.md');
    const w = runBin(repo, 'gstack-ship-receipt', ['write', '--pr', '9', '--base', 'main', '--version', '1.0.0', '--session-kind', 'unattended', '--body', body]);
    expect(w.status).toBe(EXIT.ok);
    const reviewed = extractReceipt(fs.readFileSync(body, 'utf8')).receipt!.product_patch_id;
    expect(reviewed).toMatch(/^[0-9a-f]{40}$/);
    repo.git('checkout', '-q', 'main');
    write(repo.work, 'docs/README.md', '# docs moved on main\n');
    repo.git('add', '-A'); repo.git('commit', '-qm', 'main moves on'); repo.git('push', '-q', 'origin', 'main');
    repo.git('checkout', '-q', 'feature');
    repo.git('merge', '-q', '--no-edit', 'origin/main');
    const out = runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body, '--base', 'main']);
    expect([out.status, out.out.split('\n').find(l => l.startsWith('CARRY:')), out.err.split('\n').find(l => l.includes('RECEIPT_CARRY'))]).toEqual([EXIT.ok, expect.stringMatching(/^CARRY: carried/), undefined]);
    expect(extractReceipt(fs.readFileSync(body, 'utf8')).receipt!.product_patch_id).toBe(reviewed);
  });

  // Value: protects=negative control: the large-diff path still refuses when the PR's own receipts change after review;
  //   fails_when=the streamed patch-id reads as unchanged for a changed diff; seam=none; no_claim=none
  test('one changed receipt in the large diff still refuses the carry', () => {
    const repo = makeFixtureRepo(); repos.push(repo);
    commit(repo, receipts(6000, 'base'), 'results: 6000 run receipts');
    const body = path.join(repo.root, 'body.md');
    expect(runBin(repo, 'gstack-ship-receipt', ['write', '--pr', '9', '--base', 'main', '--version', '1.0.0', '--session-kind', 'unattended', '--body', body]).status).toBe(EXIT.ok);
    commit(repo, { [`${DIR}/base-run-00042.json`]: '{"run":42,"tag":"base","score":0.9}\n' }, 'results: rescore run 42');
    const out = runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body, '--base', 'main']);
    expect([out.status, out.out.split('\n').find(l => l.startsWith('CARRY:'))]).toEqual([EXIT.refused, 'CARRY: refused (RECEIPT_CARRY_PRODUCT_CHANGED)']);
  });

  // Value: protects=the patch-id diff lives under the git dir (on disk, not a tmpfs TMPDIR), and a spot it cannot write is a
  //   named refusal, never a stack trace preflight reads as 'CARRY: check failed'; fails_when=patchId writes to TMPDIR or
  //   creates its directory outside its error handling; seam=TMPDIR, a file where the directory goes; no_claim=none
  test('patch-id diffs go under the git dir: an unwritable TMPDIR still carries, an unwritable git-dir spot refuses by name', () => {
    const repo = makeFixtureRepo(); repos.push(repo);
    commit(repo, receipts(3, 'base'), 'results: 3 run receipts');
    const body = path.join(repo.root, 'body.md');
    expect(runBin(repo, 'gstack-ship-receipt', ['write', '--pr', '9', '--base', 'main', '--version', '1.0.0', '--session-kind', 'unattended', '--body', body]).status).toBe(EXIT.ok);
    repo.git('checkout', '-q', 'main');
    write(repo.work, 'docs/README.md', '# docs moved on main\n');
    repo.git('add', '-A'); repo.git('commit', '-qm', 'main moves on'); repo.git('push', '-q', 'origin', 'main');
    repo.git('checkout', '-q', 'feature');
    repo.git('merge', '-q', '--no-edit', 'origin/main');
    const dry = runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body, '--base', 'main', '--dry-run'], { TMPDIR: path.join(repo.root, 'no-such-dir') });
    expect([dry.status, dry.out.split('\n').find(l => l.startsWith('CARRY:'))]).toEqual([EXIT.ok, expect.stringMatching(/^CARRY: would carry/)]);
    fs.rmSync(path.join(repo.work, '.git', 'gstack-patch-id'), { recursive: true, force: true });
    fs.writeFileSync(path.join(repo.work, '.git', 'gstack-patch-id'), 'not a directory\n');
    const out = runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body, '--base', 'main', '--dry-run']);
    expect([out.status, out.out.split('\n').find(l => l.startsWith('CARRY:'))]).toEqual([EXIT.refused, 'CARRY: refused (RECEIPT_CARRY_REFUSED)']);
    expect(out.err).toContain('cannot create a temp file under');
  });

  // Value: protects=a carry killed mid patch-id (preflight's 120 s timeout) does not leave product diffs in TMPDIR for good;
  //   fails_when=nothing removes a gstack-patch-id-* directory a killed run left; seam=TMPDIR, an aged directory; no_claim=none
  test('a stale patch-id directory a killed run left is swept; a fresh one is kept', () => {
    const repo = makeFixtureRepo(); repos.push(repo);
    commit(repo, receipts(3, 'base'), 'results: 3 run receipts');
    const tmp = path.join(repo.work, '.git', 'gstack-patch-id'); fs.mkdirSync(tmp, { recursive: true });
    const stale = path.join(tmp, 'run-stale'); const fresh = path.join(tmp, 'run-fresh');
    for (const d of [stale, fresh]) { fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'diff.patch'), 'diff\n'); }
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000); fs.utimesSync(stale, old, old);
    const body = path.join(repo.root, 'body.md');
    expect(runBin(repo, 'gstack-ship-receipt', ['write', '--pr', '9', '--base', 'main', '--version', '1.0.0', '--session-kind', 'unattended', '--body', body]).status).toBe(EXIT.ok);
    expect([fs.existsSync(stale), fs.existsSync(fresh)]).toEqual([false, true]);
  });
});
