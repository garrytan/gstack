/**
 * review_vendored in review_exclude_paths (GST-3298, docs/vendored-code.md): a matched file that is byte-for-byte an
 * allowlisted upstream's file at a pinned commit is vendored content, so it can be excluded; every other keep reason still
 * applies, a file that does not verify keeps its old reason, and a re-pin's deleted files verify at the base's pin.
 * Upstreams are local bare repositories reached through GSTACK_VENDORED_FETCH_ROOT.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { disclosureLine } from '../lib/review-exclude';
import { vendoredCacheRoot, vendoredPolicy, vendoredSelection } from '../lib/review-vendored';
import { receiptReviewAtHead } from '../lib/ship-receipt-depth';
import { REVIEW_VENDORED_KEY_VERSION } from '../lib/ship-policy';
import { cleanup, commit, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/pregate-fixture';

setDefaultTimeout(120_000);
const repos: FixtureRepo[] = [];
const dirs: string[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

const UP = 'https://example.test/up/lib';
const BIN = path.join(import.meta.dir, '..', 'bin');
const A = 'def test_a():\n    assert 1 + 1 == 2\n';
const B1 = 'def test_b():\n    assert "x".upper() == "X"\n';
const B2 = B1 + '\ndef test_c():\n    assert [] == []\n';
const C = 'def test_d():\n    assert {} == {}\n';
const U = 'VALUE = 1\n';
const D = 'import json\nDATA = json.load(open("up/lib/tests/data.json"))\n';
const SKIP = 'import pytest\n\n@pytest.mark.skip(reason="needs network")\ndef test_net():\n    assert False\n';
const KEY = ['OPENAI_API_KEY=sk', 'proj', 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7cDe0fGh3iJk6lMn9o'].join('-');
const ENV = { GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };

function run(cwd: string, args: string[], env: Record<string, string>): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...env, ...ENV } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** An upstream at <root>/upstreams/example.test/up/lib: c1 (tag v1) and c2 on main, which changes b.py, adds c.py and deletes lib/util.py. */
function upstream(repo: FixtureRepo) {
  const bare = path.join(repo.root, 'upstreams', 'example.test', 'up', 'lib');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-vx-up-'));
  dirs.push(work);
  fs.mkdirSync(bare, { recursive: true });
  run(bare, ['init', '-q', '--bare', '-b', 'main'], repo.env);
  run(work, ['init', '-q', '-b', 'main'], repo.env);
  const put = (rel: string, text: string | null) => { const f = path.join(work, rel); if (text === null) { fs.rmSync(f); return; } fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  const snap = (msg: string) => { run(work, ['add', '-A'], repo.env); run(work, ['commit', '-q', '-m', msg], repo.env); return run(work, ['rev-parse', 'HEAD'], repo.env); };
  put('tests/a.py', A); put('tests/b.py', B1); put('lib/util.py', U); put('tests/d.py', D); put('tests/test_skip.py', SKIP); put('tests/keys.env', KEY + '\n'); put('AGENTS.md', '# agents\n'); put('README.md', 'lib\n');
  const c1 = snap('c1');
  run(work, ['tag', 'v1'], repo.env);
  put('tests/b.py', B2); put('tests/c.py', C); put('lib/util.py', null);
  const c2 = snap('c2');
  run(work, ['push', '-q', bare, 'main', 'v1'], repo.env);
  return { c1, c2, fetchRoot: path.join(repo.root, 'upstreams') };
}

const manifest = (commit: string, files: string[]) => JSON.stringify({ schema: 'gstack-vendored/v1', pins: [{ upstream: UP, commit, local_prefix: 'up/lib/', upstream_prefix: '', files }] }, null, 1) + '\n';
const policy = (vendored = true, manifestPath = 'VENDORED.json') => JSON.stringify({ review_exclude_paths: ['up/**'], ...(vendored ? { review_vendored: { upstreams: [UP], manifests: [manifestPath] } } : {}), min_gstack_version: REVIEW_VENDORED_KEY_VERSION }) + '\n';
const local = (files: Record<string, string>) => Object.fromEntries(Object.entries(files).map(([k, v]) => [`up/lib/${k}`, v]));

function fixture(vendored = true, manifestPath = 'VENDORED.json') {
  const repo = makeFixtureRepo({ prefix: 'gstack-vx-', baseFiles: { '.gstack/ship-policy.json': policy(vendored, manifestPath) } });
  repos.push(repo);
  const up = upstream(repo);
  repo.git('checkout', '-q', '-b', 'feat');
  const plan = (json: boolean) => runBin(repo, 'gstack-review-plan', ['--base', 'main', '--gate-tagged', '0', ...(json ? ['--json'] : [])], { GSTACK_VENDORED_FETCH_ROOT: up.fetchRoot });
  return { repo, up, plan };
}
const keptOf = (out: string) => JSON.parse(out).review_exclude.kept_files as Array<{ path: string; reason: string }>;

describe('review_exclude_paths with review_vendored', () => {
  // Value: protects=byte-identical upstream files under an applied pattern leave the readers' diff, the manifest and our own
  //   code stay, and the receipt's commit-mode selection binds the digest the live plan printed; fails_when=verified code is
  //   still kept as code, or plan and receipt disagree; why_new=GST-3298 (harness-evals#504 refused at 1,593 kept files)
  test('verified vendored files are excluded, and the receipt binds the plan\'s selection', () => {
    const f = fixture();
    commit(f.repo, { ...local({ 'tests/a.py': A, 'tests/b.py': B1 }), 'VENDORED.json': manifest(f.up.c1, ['tests/a.py', 'tests/b.py']), 'src/run.ts': 'export const run = () => 1;\n' }, 'vendor lib');
    const text = f.plan(false);
    expect(text.out).toContain('REVIEW_VENDORED: verified=2 unverified=0 pins=1');
    expect(text.out).toMatch(/REVIEW_VENDORED_PIN: https:\/\/example\.test\/up\/lib@[0-9a-f]{12} reachable_from=heads\/main files=2 verified=2/);
    expect(text.out).toMatch(/REVIEW_EXCLUDE: patterns=1\/1 excluded=2 .*content=vendored:2/);
    const p = JSON.parse(f.plan(true).out);
    expect(p.review_exclude.kept_files).toEqual([]);
    const head = f.repo.git('rev-parse', 'HEAD').trim();
    const saved = process.env.GSTACK_STATE_ROOT;
    process.env.GSTACK_STATE_ROOT = f.repo.env.GSTACK_STATE_ROOT;
    try {
      const r = receiptReviewAtHead(f.repo.work, 'main', BIN, head);
      expect(r.exclude.state).toBe('active');
      expect(r.exclude.state === 'active' && r.exclude.record.digest).toBe(p.review_exclude.digest);
    } finally { if (saved === undefined) delete process.env.GSTACK_STATE_ROOT; else process.env.GSTACK_STATE_ROOT = saved; }
  });

  // Value: protects=one changed byte keeps its file for its old reason and the plan names it; fails_when=a mismatch is
  //   excluded; why_new=GST-3298; seam=gstack-review-plan
  test('one changed byte keeps the file as code and names it as REVIEW_VENDORED_KEPT', () => {
    const f = fixture();
    commit(f.repo, { ...local({ 'tests/a.py': A, 'tests/b.py': B1.replace('X', 'Y') }), 'VENDORED.json': manifest(f.up.c1, ['tests/a.py', 'tests/b.py']) }, 'vendor lib');
    expect(f.plan(false).out).toContain('REVIEW_VENDORED_KEPT: mismatched up/lib/tests/b.py');
    expect(keptOf(f.plan(true).out)).toEqual([{ path: 'up/lib/tests/b.py', reason: 'code' }]);
  });

  // Value: protects=verifying a file never lifts agent prose, a credential value or a gate tag out of review: AGENTS.md stays
  //   whole, the key line is excerpted, and a gate-tagged test file stays whole because test paths are gate floor paths
  //   (#4574 excerpts only off the floor); fails_when=the vendored kind skips a keep rule or cuts a floor file;
  //   why_new=GST-3298 plan F5; no_claim=the excerpt text itself (test/review-exclude.test.ts owns it)
  test('agent prose, a credential value and a gate-tagged test file stay in review even when verified', () => {
    const f = fixture();
    const files = ['AGENTS.md', 'tests/a.py', 'tests/keys.env', 'tests/test_skip.py'];
    commit(f.repo, { ...local({ 'AGENTS.md': '# agents\n', 'tests/a.py': A, 'tests/keys.env': KEY + '\n', 'tests/test_skip.py': SKIP }), 'VENDORED.json': manifest(f.up.c1, files) }, 'vendor lib');
    const out = runBin(f.repo, 'gstack-review-plan', ['--base', 'main', '--json'], { GSTACK_VENDORED_FETCH_ROOT: f.up.fetchRoot }).out;
    const x = JSON.parse(out).review_exclude;
    expect(x.kept_files).toEqual([
      { path: 'up/lib/AGENTS.md', reason: 'agent-prose' }, { path: 'up/lib/tests/keys.env', reason: 'secret-line' }, { path: 'up/lib/tests/test_skip.py', reason: 'gate-tagged' },
    ]);
    expect(x.excerpt).toEqual([':(top,literal)up/lib/tests/keys.env']);
    expect(x.excluded).toBe(1);
  });

  // Value: protects=a re-pin's modified, added and deleted files all leave the diff (the deleted one verified at the base's
  //   pin), so a re-pin does not fall back to whole files; fails_when=deletions are kept or verified against the head;
  //   why_new=GST-3298 plan C1
  test('a re-pin with modified, added and deleted files excludes all three', () => {
    const f = fixture();
    f.repo.git('checkout', '-q', 'main');
    commit(f.repo, { ...local({ 'lib/util.py': U, 'tests/b.py': B1 }), 'VENDORED.json': manifest(f.up.c1, ['lib/util.py', 'tests/b.py']) }, 'vendor lib at v1');
    f.repo.git('push', '-q', 'origin', 'main');
    f.repo.git('checkout', '-q', '-B', 'feat');
    commit(f.repo, { 'up/lib/lib/util.py': null, ...local({ 'tests/b.py': B2, 'tests/c.py': C }), 'VENDORED.json': manifest(f.up.c2, ['tests/b.py', 'tests/c.py']) }, 're-pin');
    expect(f.plan(false).out).toContain('REVIEW_VENDORED: verified=3 unverified=0 pins=2');
    const x = JSON.parse(f.plan(true).out).review_exclude;
    expect({ excluded: x.excluded, kept: x.kept_files }).toEqual({ excluded: 3, kept: [] });
  });

  // Value: protects=a file the branch drops from the manifest but keeps and rewrites stays in review as code; only a file the
  //   range deletes verifies at the base's pin; fails_when=the base's pin verifies a file the head still has;
  //   why_new=/ship review of #4665 (specialist finding lib/review-vendored.ts:320)
  test('a file dropped from the manifest but rewritten at the head stays in review', () => {
    const f = fixture();
    f.repo.git('checkout', '-q', 'main');
    commit(f.repo, { ...local({ 'lib/util.py': U, 'tests/b.py': B1 }), 'VENDORED.json': manifest(f.up.c1, ['lib/util.py', 'tests/b.py']) }, 'vendor lib at v1');
    f.repo.git('push', '-q', 'origin', 'main');
    f.repo.git('checkout', '-q', '-B', 'feat');
    commit(f.repo, { ...local({ 'lib/util.py': 'import os\nos.system("true")\n' }), 'VENDORED.json': manifest(f.up.c1, ['tests/b.py']) }, 'drop util from the manifest');
    const x = JSON.parse(f.plan(true).out).review_exclude;
    expect(x.kept_files).toEqual([{ path: 'up/lib/lib/util.py', reason: 'code' }]);
    expect(x.vendored_selection.verified).toEqual([]);
  });

  // Value: protects=a branch that replaces our own file, or a locally patched vendored file, with verified upstream bytes
  //   keeps that file in review as code, so readers see our lines leave; a file new on the branch, or vendored at the merge
  //   base too (the re-pin test above), still leaves the diff; fails_when=a modified file is checked at the head only;
  //   why_new=/ship review of #4665 (outside-voice finding lib/review-vendored.ts:319), GST-3298 PR 3
  test('a branch that swaps our own file or a local patch for upstream bytes keeps it in review', () => {
    const ours = fixture();
    ours.repo.git('checkout', '-q', 'main');
    commit(ours.repo, local({ 'tests/a.py': 'def test_a():\n    assert check_signature()\n' }), 'our own test');
    ours.repo.git('push', '-q', 'origin', 'main');
    ours.repo.git('checkout', '-q', '-B', 'feat');
    commit(ours.repo, { ...local({ 'tests/a.py': A, 'tests/c.py': C }), 'VENDORED.json': manifest(ours.up.c2, ['tests/a.py', 'tests/c.py']) }, 'vendor lib over our test');
    expect(ours.plan(false).out).toContain('REVIEW_VENDORED_KEPT: mismatched up/lib/tests/a.py (the merge base has this file but its manifests do not pin it');
    const x = JSON.parse(ours.plan(true).out).review_exclude;
    expect({ kept: x.kept_files, verified: x.vendored_selection.verified }).toEqual({ kept: [{ path: 'up/lib/tests/a.py', reason: 'code' }], verified: ['up/lib/tests/c.py'] });
    const patched = fixture();
    patched.repo.git('checkout', '-q', 'main');
    commit(patched.repo, { ...local({ 'tests/b.py': B1 + 'assert local_patch()\n' }), 'VENDORED.json': manifest(patched.up.c1, ['tests/b.py']) }, 'vendor lib with a local patch');
    patched.repo.git('push', '-q', 'origin', 'main');
    patched.repo.git('checkout', '-q', '-B', 'feat');
    commit(patched.repo, local({ 'tests/b.py': B1 }), 'drop the local patch');
    expect(patched.plan(false).out).toContain("REVIEW_VENDORED_KEPT: mismatched up/lib/tests/b.py (its merge-base copy is not the upstream's file (mismatched");
    expect(keptOf(patched.plan(true).out)).toEqual([{ path: 'up/lib/tests/b.py', reason: 'code' }]);
  });

  // Value: protects=a working-tree edit to a verified vendored file keeps it in review on a live-tree plan; fails_when=the
  //   committed blob's verdict covers uncommitted bytes; why_new=/ship review of #4665 (test gap lib/review-vendored.ts:330)
  test('a working-tree edit to a verified vendored file keeps it in review', () => {
    const f = fixture();
    commit(f.repo, { ...local({ 'tests/a.py': A, 'tests/b.py': B1 }), 'VENDORED.json': manifest(f.up.c1, ['tests/a.py', 'tests/b.py']) }, 'vendor lib');
    fs.writeFileSync(path.join(f.repo.work, 'up/lib/tests/b.py'), B1 + 'assert edited()\n');
    const mergeBase = f.repo.git('merge-base', 'origin/main', 'HEAD').trim();
    const sel = vendoredSelection({
      root: f.repo.work, policy: vendoredPolicy(JSON.parse(policy()))!, mergeBase, changed: new Set(['up/lib/tests/a.py', 'up/lib/tests/b.py', 'VENDORED.json']), fetch: true,
      cacheRoot: vendoredCacheRoot(f.repo.env.GSTACK_STATE_ROOT), env: { ...process.env, ...f.repo.env, GSTACK_VENDORED_FETCH_ROOT: f.up.fetchRoot },
    });
    if ('error' in sel) throw new Error(sel.error);
    expect(sel.verified).toEqual(['up/lib/tests/a.py']);
    expect(sel.failed.map(e => [e.path, e.verdict, e.detail])).toEqual([['up/lib/tests/b.py', 'mismatched', 'changed in the working tree']]);
  });

  // Value: protects=a manifest under an applied pattern turns the vendored check off, so the files it pins stay in review
  //   whole and a hidden re-pin cannot hide them too; fails_when=files verify against a manifest readers cannot see;
  //   why_new=/ship review of #4665 (red-team finding lib/review-exclude.ts:483)
  test('a manifest under the applied pattern verifies nothing', () => {
    const f = fixture(true, 'up/VENDORED.json');
    commit(f.repo, { ...local({ 'tests/a.py': A }), 'up/VENDORED.json': manifest(f.up.c1, ['tests/a.py']) }, 'vendor lib');
    expect(f.plan(false).out).toContain('REVIEW_VENDORED: unavailable (up/VENDORED.json matches review_exclude_paths');
    expect(keptOf(f.plan(true).out)).toEqual([{ path: 'up/lib/tests/a.py', reason: 'code' }]);
  });

  // Value: protects=a verified vendored file still keeps the non-vendored file it names by full path (named-by-code), as on
  //   main, and the plan JSON keeps the numeric vendored count the brief's disclosure line prints; fails_when=a vendored
  //   file stops counting as a consumer, or the count is overwritten; why_new=/ship review of #4665 (s11/outside-voice#1)
  test('a verified vendored file keeps the non-vendored data file it names', () => {
    const f = fixture();
    commit(f.repo, { ...local({ 'tests/d.py': D, 'tests/data.json': '{"x": 1}\n' }), 'VENDORED.json': manifest(f.up.c1, ['tests/d.py']) }, 'vendor lib');
    const x = JSON.parse(f.plan(true).out).review_exclude;
    expect(x.kept_files).toEqual([{ path: 'up/lib/tests/data.json', reason: 'named-by-code' }]);
    expect(x.vendored).toBe(1);
    expect(disclosureLine(x)).toContain(' 1 of the excluded files are vendored upstream files');
    expect(disclosureLine(x)).not.toContain('is in your diff');
  });

  // Value: protects=a repo without review_vendored plans exactly as before: the same files kept as code, no vendored line and
  //   no vendored field; fails_when=the key's absence changes a selection; why_new=GST-3298 no-loss (CREW rule 15)
  test('without review_vendored nothing changes', () => {
    const f = fixture(false);
    commit(f.repo, { ...local({ 'tests/a.py': A }), 'VENDORED.json': manifest(f.up.c1, ['tests/a.py']) }, 'vendor lib');
    const text = f.plan(false).out;
    expect(text).not.toContain('REVIEW_VENDORED');
    const x = JSON.parse(f.plan(true).out).review_exclude;
    expect(x.kept_files).toEqual([{ path: 'up/lib/tests/a.py', reason: 'code' }]);
    expect(x.vendored).toBeUndefined();
    expect(x.vendored_selection).toBeUndefined();
  });

  // Value: protects=too many unverified vendored files refuse with a fix that names the verify command, never lines a
  //   refused plan does not print, and a vendored check that could not run says so instead of counting every kept file as
  //   vendored; fails_when=the old fix is printed; why_new=GST-3298 plan F1, /ship review of #4665 (lib/review-exclude.ts:524)
  test('a keep-too-large refusal over unverified vendored files names the verify command', () => {
    const f = fixture();
    const many: Record<string, string> = {};
    const names: string[] = [];
    for (let k = 0; k < 330; k++) { const n = `tests/a_rather_long_vendored_file_name_that_fills_the_argument_bound_${k}.py`; names.push(n); many[n] = A; }
    commit(f.repo, { ...local({ ...many, 'tests/a.py': A }), 'VENDORED.json': manifest(f.up.c1, [...names, 'tests/a.py']) }, 'vendor lib');
    const r = f.plan(false);
    expect(r.out + r.err).toContain('REVIEW_EXCLUDE_KEEP_TOO_LARGE');
    expect(r.out + r.err).toContain('330 of them are manifest entries that do not count as vendored (they did not verify, or the merge base has them as our own code); run gstack-vendored-verify --base main');
    expect(r.out + r.err).not.toContain('REVIEW_VENDORED_KEPT');
    const hidden = fixture(true, 'up/VENDORED.json');
    commit(hidden.repo, { ...local(many), 'up/VENDORED.json': manifest(hidden.up.c1, names) }, 'vendor lib');
    const h = hidden.plan(false);
    expect(h.out + h.err).toContain('the vendored check could not run (up/VENDORED.json matches review_exclude_paths');
    expect(h.out + h.err).not.toContain('of them are manifest entries');
  });
});
