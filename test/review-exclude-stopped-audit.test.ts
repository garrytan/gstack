/**
 * GST-3502 (GBRA-732, gbrain#10036 at 8e0159ab): Step 14.5's first docs audit edited an excluded docs file, then stopped as
 * blocked, so it never saved a post snapshot; the re-audit passed and edited nothing. Its post snapshot could not carry the
 * stopped audit (no `edited`, and the two run ids spelled the same record path two ways), so receipt write read the stopped
 * audit's edit as content the reviewers had read and refused RECEIPT_INVALID on review_exclude. The re-audit's post snapshot now
 * carries a stopped audit's Prepare snapshot (--carry-stopped): its edits are what changed between the two Prepare snapshots at the same HEAD.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { REVIEW_EXCLUDE_KEY_VERSION } from '../lib/ship-policy';
import { cleanup, commit, makeFixtureRepo, runBin, write, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });
const policyText = (patterns: string[]) => JSON.stringify({ review_exclude_paths: patterns, min_gstack_version: REVIEW_EXCLUDE_KEY_VERSION }) + '\n';
const BRANCH = { 'lib/reader.js': "exports.p = 'docs/parity.md';\n", 'docs/parity.md': '# parity\n' };
const RUN_A1 = '/records/ship2/../ship2-record.md';
const RUN_A2 = '/records/ship2-record.md';

/** Reviewed; audit a1 takes its Prepare snapshot, edits docs/key-files.md (so code now names lib/reader.js there) and stops; audit a2 takes its Prepare snapshot, edits nothing, and saves its post snapshot carrying `carry`; all of it is committed. */
function stoppedThenReaudited(opts: { a1Run?: string; moveHead?: boolean; refusals?: boolean } = {}) {
  const repo = makeFixtureRepo({ prefix: 'gst3502-', baseFiles: { '.gstack/ship-policy.json': policyText(['docs/**']), 'docs/key-files.md': '# key files\n', 'lib/index.js': "exports.k = 'docs/key-files.md';\n" } });
  repos.push(repo);
  commit(repo, BRANCH);
  const reviewed = JSON.parse(runBin(repo, 'gstack-review-plan', ['--base', 'main', '--gate-tagged', '0', '--json']).out).review_exclude.digest as string;
  const base = repo.git('rev-parse', 'origin/main');
  const snapshot = (out: string, id: string, run: string, extra: string[] = []) => runBin(repo, 'gstack-docs-candidate', ['snapshot', '--out', out, '--audit-id', id, '--mode', 'edit', '--base', base, '--docs', 'docs', '--run', run, ...extra]);
  const a1 = path.join(repo.root, 'docs-audit-1.json');
  expect(snapshot(a1, 'ship2-docs-1', opts.a1Run ?? RUN_A1).status).toBe(0);
  write(repo.work, 'docs/key-files.md', '# key files\n- lib/reader.js: the parity guard\n');
  if (opts.moveHead) { write(repo.work, 'lib/extra.js', 'exports.x = 1;\n'); repo.git('add', 'lib/extra.js'); repo.git('commit', '-q', '-m', 'a commit between the audits'); }
  const a2 = path.join(repo.root, 'docs-audit-2.json');
  expect(snapshot(a2, 'ship2-docs-2', RUN_A2).status).toBe(0);
  const post = path.join(repo.root, 'ship2-docs-2-post.json');
  const carried = snapshot(post, 'ship2-docs-2', RUN_A2, ['--pre', a2, '--carry-stopped', a1]);
  const plain = path.join(repo.root, 'ship2-docs-2-post-plain.json');
  expect(snapshot(plain, 'ship2-docs-2', RUN_A2, ['--pre', a2]).status).toBe(0);
  const a1Post = path.join(repo.root, 'ship2-docs-1-post.json');
  const refused = !opts.refusals ? undefined : {
    postAsStopped: (expect(snapshot(a1Post, 'ship2-docs-1', RUN_A1, ['--pre', a1]).status).toBe(0), snapshot(path.join(repo.root, 'refused-1.json'), 'ship2-docs-2', RUN_A2, ['--pre', a2, '--carry-stopped', a1Post])),
    itself: snapshot(path.join(repo.root, 'refused-2.json'), 'ship2-docs-2', RUN_A2, ['--pre', a2, '--carry-stopped', a2]),
    noPre: snapshot(path.join(repo.root, 'refused-3.json'), 'ship2-docs-2', RUN_A2, ['--carry-stopped', a1]),
    written: () => ['refused-1.json', 'refused-2.json', 'refused-3.json'].filter(f => fs.existsSync(path.join(repo.root, f))),
  };
  commit(repo, {}, 'docs audit');
  const body = path.join(repo.root, 'body.md');
  const writeWith = (postFile: string) => runBin(repo, 'gstack-ship-receipt', ['write', '--pr', '10036', '--base', 'main', '--version', '1.0.0', '--session-kind', 'unattended', '--body', body,
    '--review-exclude', reviewed, '--docs-post', postFile, '--docs-pre', a2,
    '--review-targeted', JSON.stringify({ classes: ['money', 'gate', 'auth', 'secret'], rules: 'r', brief_sha: 'a'.repeat(64), status: 'done', findings: 0, raised_by: 'targeted', head: repo.git('rev-parse', 'HEAD') })]);
  return { carried, post, plain, writeWith, refused };
}

describe('a re-audit carries the docs audit that stopped before its post snapshot (GST-3502)', () => {
  // Value: protects=a /ship run whose first docs audit stopped as blocked still gets its receipt after the re-audit passes
  //   (gbrain#10036 had no supported path); fails_when=a stopped audit needs its post snapshot to be carried, or the same record path
  //   spelled two ways reads as two runs; seam=gstack-docs-candidate snapshot --carry-stopped, then gstack-ship-receipt write; no_claim=gh
  test('the gbrain#10036 shape: carrying the stopped audit\'s Prepare snapshot binds the reviewed selection', () => {
    const s = stoppedThenReaudited();
    expect({ status: s.carried.status, err: s.carried.err }).toMatchObject({ status: 0 });
    expect(s.carried.out).toContain('earlier: ship2-docs-1');
    const before = s.writeWith(s.plain);
    expect(before.status).toBe(EXIT.fail);
    expect(before.err).toContain('field=review_exclude');
    const w = s.writeWith(s.post);
    expect({ status: w.status, err: w.status === EXIT.ok ? '' : w.err }).toEqual({ status: EXIT.ok, err: '' });
    expect(w.err + w.out).toContain('REVIEW_EXCLUDE_DOCS_AUDIT:');
  }, 240_000);

  // Value: protects=only this run's stopped audit at the same HEAD is carried; fails_when=another run's or an older HEAD's
  //   Prepare snapshot is read as a stopped audit; seam=gstack-docs-candidate snapshot --carry-stopped; no_claim=-
  test('a Prepare snapshot from another run, or at another HEAD, is still refused', () => {
    const other = stoppedThenReaudited({ a1Run: '/records/another-run.md' });
    expect(other.carried.status).not.toBe(0);
    expect(other.carried.err).toContain('another /ship run');
    const moved = stoppedThenReaudited({ moveHead: true });
    expect(moved.carried.status).not.toBe(0);
    expect(moved.carried.err).toContain('HEAD');
  }, 240_000);

  // Value: protects=--carry-stopped takes only an earlier audit's Prepare snapshot of a named run; fails_when=the post-snapshot,
  //   same-audit or --pre/--run guard is dropped; seam=gstack-docs-candidate snapshot --carry-stopped; no_claim=-
  test('a post snapshot, this audit\'s own Prepare snapshot, or a call without --pre is refused', () => {
    const r = stoppedThenReaudited({ refusals: true }).refused!;
    expect({ status: r.postAsStopped.status, err: r.postAsStopped.err }).toMatchObject({ status: 1, err: expect.stringContaining('is a post snapshot') });
    expect({ status: r.itself.status, err: r.itself.err }).toMatchObject({ status: 1, err: expect.stringContaining('is this audit') });
    expect({ status: r.noPre.status, err: r.noPre.err }).toMatchObject({ status: 1, err: expect.stringContaining('needs --pre and --run') });
    expect(r.written()).toEqual([]);
  }, 240_000);
});
