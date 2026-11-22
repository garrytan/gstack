/**
 * review_vendored and gstack-vendored-verify (GST-3298, docs/vendored-code.md): a vendored file counts only when it is
 * byte-for-byte an allowlisted upstream's file at a commit that upstream's default branch, tags or named branches hold.
 * Upstreams are local bare repositories reached through GSTACK_VENDORED_FETCH_ROOT; every consumer repo's global git
 * config rewrites that root to a missing directory, so a fetch that read ambient git configuration would fail.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bunIsolationArgs } from '../lib/bun-isolation';
import { REVIEW_VENDORED_KEY_VERSION, finish } from '../lib/ship-policy';
import { parseManifest, pathProblem, vendoredCacheRoot, vendoredErrors, vendoredPolicy, vendoredSelection } from '../lib/review-vendored';
import { cleanup, commit, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/pregate-fixture';

setDefaultTimeout(60_000);
const repos: FixtureRepo[] = [];
const dirs: string[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

const UP = 'https://example.test/up/lib';
const A = 'def test_a():\n    assert 1 + 1 == 2\n';
const B1 = 'def test_b():\n    assert "x".upper() == "X"\n';
const B2 = B1 + '\ndef test_c():\n    assert [] == []\n';
const ENV = { GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };

function run(cwd: string, args: string[], env: Record<string, string>): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...env, ...ENV } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** An upstream at <fetchRoot>/example.test/up/lib: c1 (tag v1), c2 on main, and commits held only by a pull ref, a merge-queue branch and release/2. */
function upstream(fetchRoot: string, env: Record<string, string>) {
  const bare = path.join(fetchRoot, 'example.test', 'up', 'lib');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-vendored-up-'));
  dirs.push(work);
  fs.mkdirSync(bare, { recursive: true });
  run(bare, ['init', '-q', '--bare', '-b', 'main'], env);
  run(work, ['init', '-q', '-b', 'main'], env);
  const put = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true }); fs.writeFileSync(path.join(work, rel), text); };
  const snap = (msg: string) => { run(work, ['add', '-A'], env); run(work, ['commit', '-q', '-m', msg], env); return run(work, ['rev-parse', 'HEAD'], env); };
  put('tests/a.py', A); put('tests/b.py', B1); put('README.md', 'lib\n');
  const c1 = snap('c1');
  run(work, ['tag', 'v1'], env);
  put('tests/b.py', B2);
  const c2 = snap('c2');
  const side = (name: string) => { run(work, ['checkout', '-q', '-b', name, c1], env); put('tests/a.py', A + '# ' + name + '\n'); const c = snap(name); run(work, ['checkout', '-q', 'main'], env); return c; };
  const pull = side('pr'); const queue = side('queue'); const release = side('rel');
  run(work, ['push', '-q', bare, 'main', 'v1', `${pull}:refs/pull/1/head`, `${queue}:refs/heads/gh-readonly-queue/main/pr-1`, `${release}:refs/heads/release/2`], env);
  return { bare, work, c1, c2, pull, queue, release };
}

interface Pin { upstream?: string; commit: string; local_prefix?: string; upstream_prefix?: string; files: string[] }
const manifest = (pins: Pin[]) => JSON.stringify({ schema: 'gstack-vendored/v1', pins: pins.map(p => ({ upstream: UP, local_prefix: 'vendor/lib/', upstream_prefix: '', ...p })) }, null, 1) + '\n';
const policy = (upstreams: unknown[] = [UP]) => JSON.stringify({ review_vendored: { upstreams, manifests: ['vendor/MANIFEST.json'] }, min_gstack_version: REVIEW_VENDORED_KEY_VERSION }) + '\n';

/** A consumer repo whose base declares review_vendored; the branch adds vendor/lib/tests/*.py and the manifest. */
function consumer(opts: { policy?: string; files?: Record<string, string | null>; pins?: Pin[] } = {}) {
  const repo = makeFixtureRepo({ prefix: 'gstack-vendored-', baseFiles: { '.gstack/ship-policy.json': opts.policy ?? policy() } });
  repos.push(repo);
  const fetchRoot = path.join(repo.root, 'upstreams');
  const up = upstream(fetchRoot, repo.env);
  const upEnv = { ...repo.env, GIT_CONFIG_GLOBAL: path.join(repo.root, 'upstream.gitconfig') };
  fs.copyFileSync(repo.env.GIT_CONFIG_GLOBAL, upEnv.GIT_CONFIG_GLOBAL);
  fs.appendFileSync(repo.env.GIT_CONFIG_GLOBAL, `[url "/nonexistent/"]\n\tinsteadOf = "${fetchRoot.replace(/\\/g, '\\\\')}/"\n`);
  repo.git('checkout', '-q', '-b', 'feat');
  commit(repo, { 'vendor/lib/tests/a.py': A, 'vendor/lib/tests/b.py': B1, 'vendor/MANIFEST.json': manifest(opts.pins ?? [{ commit: up.c1, files: ['tests/a.py', 'tests/b.py'] }]), ...(opts.files ?? {}) }, 'vendor lib');
  const verify = (args: string[] = ['--base', 'main'], env: Record<string, string> = {}) => runBin(repo, 'gstack-vendored-verify', args, { GSTACK_VENDORED_FETCH_ROOT: fetchRoot, ...env });
  return { repo, up, upEnv, fetchRoot, verify };
}
const outOf = (r: { out: string; err: string }) => `${r.out}${r.err}`;

describe('manifest and policy shapes', () => {
  test('path problems refuse .., absolute, backslash and empty segments', () => {
    for (const p of ['../x', 'a/../b', '/abs', 'a\\b', 'a//b', './a', '']) expect(pathProblem(p)).not.toBeNull();
    expect(pathProblem('tests/test_x.py')).toBeNull();
  });
  test('a manifest refuses short commits, prefixes without a slash, case collisions and duplicates', () => {
    const c = 'a'.repeat(40);
    const bad = parseManifest(JSON.stringify({ schema: 'gstack-vendored/v1', pins: [
      { upstream: UP, commit: 'abc123', local_prefix: 'v/', upstream_prefix: '', files: ['x.py'] },
      { upstream: UP, commit: c, local_prefix: 'v', upstream_prefix: '', files: ['x.py'] },
      { upstream: UP, commit: c, local_prefix: 'w/', upstream_prefix: '', files: ['A.py', 'a.py', '../b.py'] },
    ] }), 'm.json');
    expect(bad.errors.join('\n')).toMatch(/40-character/);
    expect(bad.errors.join('\n')).toMatch(/local_prefix/);
    expect(bad.errors.join('\n')).toMatch(/\.\. segment/);
    const dup = parseManifest(JSON.stringify({ schema: 'gstack-vendored/v1', pins: [{ upstream: UP, commit: c, local_prefix: 'w/', upstream_prefix: 'src/', files: ['A.py', 'a.py'] }] }), 'm.json');
    expect(dup.errors.join('\n')).toMatch(/collides/);
    const ok = parseManifest(JSON.stringify({ schema: 'gstack-vendored/v1', pins: [{ upstream: UP, commit: c, local_prefix: 'w/', upstream_prefix: 'src/', files: ['a.py'] }] }), 'm.json');
    expect(ok.errors).toEqual([]);
    expect(ok.entries).toEqual([{ path: 'w/a.py', upstream: UP, commit: c, upstream_path: 'src/a.py' }]);
  });
  test('the policy key validates through the ship policy and refuses pull and merge-queue branch globs', () => {
    const errs = (v: unknown) => { const out: Array<{ path: string; message: string }> = []; vendoredErrors(v, out, () => null); return out.map(e => `${e.path}: ${e.message}`).join('\n'); };
    expect(errs({ upstreams: [UP], manifests: ['vendor/MANIFEST.json'] })).toBe('');
    expect(errs({ upstreams: [{ url: UP, branches: ['release/*'] }], manifests: ['m.json'] })).toBe('');
    for (const b of ['pull/*', 'gh-readonly-queue/*', 'refs/heads/x']) expect(errs({ upstreams: [{ url: UP, branches: [b] }], manifests: ['m.json'] })).toMatch(/branches/);
    expect(errs({ upstreams: ['http://example.test/up/lib'], manifests: ['m.json'] })).toMatch(/https URL/);
    expect(errs({ upstreams: [['https://user', 'pw@example.test/up/lib'].join(':')], manifests: ['m.json'] })).toMatch(/https URL/);
    expect(errs({ upstreams: [UP], manifests: ['vendor/*.json'] })).toMatch(/not a glob/);
    const loaded = finish(JSON.stringify({ review_vendored: { upstreams: [UP], manifests: ['m.json'] } }), { kind: 'head', label: 'x', ref: 'x', sha: 'x' } as never) as { errors: Array<{ path: string; message: string }> };
    expect(loaded.errors.map(e => e.message).join('\n')).toContain(REVIEW_VENDORED_KEY_VERSION);
  });
});

describe('gstack-vendored-verify', () => {
  test('files byte-identical to a tagged upstream commit verify, through no ambient git configuration', () => {
    const { verify } = consumer();
    const r = verify();
    expect(outOf(r)).toMatch(/VENDORED_PIN: https:\/\/example\.test\/up\/lib@[0-9a-f]{12} reachable_from=(heads\/main|tags\/v1) files=2 verified=2/);
    expect(outOf(r)).toMatch(/VENDORED_VERIFY: checked=2 verified=2 failed=0 pins=1 manifests=1 scope=changed digest=[0-9a-f]{64}/);
    expect(r.status).toBe(0);
  });
  test('one changed byte fails as a mismatch with its fix', () => {
    const { verify } = consumer({ files: { 'vendor/lib/tests/b.py': B1.replace('X', 'Y') } });
    const r = verify();
    expect(outOf(r)).toMatch(/vendor\/lib\/tests\/b\.py <- .*tests\/b\.py.*fix: restore the upstream bytes.*\(VENDORED_MISMATCH\)/);
    expect(r.status).toBe(1);
  });
  test('commits only a pull ref or a merge-queue branch hold are unreachable; a base-named branch glob admits release/2', () => {
    for (const which of ['pull', 'queue'] as const) {
      const c = consumer();
      const pin = which === 'pull' ? c.up.pull : c.up.queue;
      commit(c.repo, { 'vendor/lib/tests/a.py': A + '# ' + (which === 'pull' ? 'pr' : 'queue') + '\n', 'vendor/MANIFEST.json': manifest([{ commit: pin, files: ['tests/a.py'] }]) }, 'pin');
      const r = c.verify();
      expect(outOf(r)).toContain('(VENDORED_UNREACHABLE)');
      expect(r.status).toBe(1);
    }
    const plain = consumer();
    commit(plain.repo, { 'vendor/lib/tests/a.py': A + '# rel\n', 'vendor/MANIFEST.json': manifest([{ commit: plain.up.release, files: ['tests/a.py'] }]) }, 'pin');
    expect(outOf(plain.verify())).toContain('(VENDORED_UNREACHABLE)');
    const named = consumer({ policy: policy([{ url: UP, branches: ['release/*'] }]) });
    commit(named.repo, { 'vendor/lib/tests/a.py': A + '# rel\n', 'vendor/MANIFEST.json': manifest([{ commit: named.up.release, files: ['tests/a.py'] }]) }, 'pin');
    const r = named.verify();
    expect(outOf(r)).toContain('reachable_from=heads/release/2');
    expect(r.status).toBe(0);
  });
  test('a branch glob the base drops stops admitting its commits on a warm cache, online and offline', () => {
    const c = consumer({ policy: policy([{ url: UP, branches: ['release/*'] }]) });
    commit(c.repo, { 'vendor/lib/tests/a.py': A + '# rel\n', 'vendor/MANIFEST.json': manifest([{ commit: c.up.release, files: ['tests/a.py'] }]) }, 'pin');
    expect(c.verify().status).toBe(0);
    c.repo.git('checkout', '-q', 'main');
    commit(c.repo, { '.gstack/ship-policy.json': policy() }, 'narrow');
    c.repo.git('push', '-q', 'origin', 'main');
    c.repo.git('checkout', '-q', 'feat');
    for (const args of [['--base', 'main', '--all', '--offline'], ['--base', 'main', '--all']]) {
      const r = c.verify(args);
      expect(outOf(r)).toContain('(VENDORED_UNREACHABLE)');
      expect(r.status).toBe(1);
    }
  });
  test('deleting a vendored file the base already holds fails the default scope', () => {
    const c = consumer();
    c.repo.git('checkout', '-q', 'main');
    c.repo.git('merge', '-q', '--ff-only', 'feat');
    c.repo.git('push', '-q', 'origin', 'main');
    c.repo.git('checkout', '-q', 'feat');
    c.repo.git('rm', '-q', 'vendor/lib/tests/a.py');
    c.repo.git('commit', '-q', '-m', 'rm');
    const r = c.verify();
    expect(outOf(r)).toContain('(VENDORED_ABSENT_LOCAL)');
    expect(r.status).toBe(1);
  });
  test('a force-pushed pin and a deleted upstream fail closed', () => {
    const c = consumer();
    commit(c.repo, { 'vendor/lib/tests/b.py': B2, 'vendor/MANIFEST.json': manifest([{ commit: c.up.c2, files: ['tests/a.py', 'tests/b.py'] }]) }, 'repin');
    expect(c.verify().status).toBe(0);
    run(c.up.work, ['push', '-q', '--force', c.up.bare, `${c.up.c1}:refs/heads/main`], c.upEnv);
    const gone = c.verify();
    expect(outOf(gone)).toContain('(VENDORED_UNREACHABLE)');
    fs.rmSync(c.up.bare, { recursive: true, force: true });
    const deleted = c.verify();
    expect(outOf(deleted)).toContain('(VENDORED_FETCH_FAILED)');
    expect(deleted.status).toBe(1);
  });
  test('an upstream the base does not list fails, and a head cannot add one for itself', () => {
    const other = 'https://example.test/up/other';
    const c = consumer();
    commit(c.repo, { 'vendor/MANIFEST.json': manifest([{ upstream: other, commit: c.up.c1, files: ['tests/a.py', 'tests/b.py'] }]), '.gstack/ship-policy.json': policy([UP, other]) }, 'trust other');
    const r = c.verify();
    expect(outOf(r)).toContain('(VENDORED_NOT_ALLOWLISTED)');
    expect(r.status).toBe(1);
  });
  test('executables, symlinks and a file renamed under its prefix are not vendored', () => {
    const c = consumer();
    c.repo.git('update-index', '--chmod=+x', 'vendor/lib/tests/a.py');
    c.repo.git('commit', '-q', '-m', 'exec');
    expect(outOf(c.verify())).toContain('(VENDORED_MODE)');
    const d = consumer();
    commit(d.repo, { 'vendor/lib/tests/conftest.py': A, 'vendor/MANIFEST.json': manifest([{ commit: d.up.c1, files: ['tests/a.py', 'tests/b.py', 'tests/conftest.py'] }]) }, 'rename');
    expect(outOf(d.verify())).toContain('(VENDORED_ABSENT_UPSTREAM)');
  });
  test('an invalid or missing manifest fails without checking anything', () => {
    const c = consumer();
    commit(c.repo, { 'vendor/MANIFEST.json': manifest([{ commit: c.up.c1, files: ['../escape.py'] }]) }, 'bad');
    const r = c.verify();
    expect(outOf(r)).toContain('(VENDORED_MANIFEST_INVALID)');
    expect(r.status).toBe(1);
    commit(c.repo, { 'vendor/MANIFEST.json': null }, 'gone');
    expect(outOf(c.verify())).toMatch(/vendor\/MANIFEST\.json is not in HEAD.*\(VENDORED_MANIFEST_INVALID\)/);
  });
  test('the default scope checks only what the branch changes; --all checks every entry; --offline reuses the cache', () => {
    const c = consumer();
    expect(c.verify().status).toBe(0);
    c.repo.git('push', '-q', 'origin', 'feat:main');
    c.repo.git('fetch', '-q', 'origin');
    commit(c.repo, { 'vendor/lib/tests/b.py': B1 + '# local\n' }, 'edit b');
    const changed = c.verify();
    expect(outOf(changed)).toMatch(/checked=1 verified=0 failed=1/);
    const all = c.verify(['--base', 'main', '--all']);
    expect(outOf(all)).toMatch(/checked=2 verified=1 failed=1 .* scope=all/);
    const offline = c.verify(['--base', 'main', '--all', '--offline']);
    expect(outOf(offline).match(/digest=([0-9a-f]{64})/)?.[1]).toBe(outOf(all).match(/digest=([0-9a-f]{64})/)?.[1]);
    const cold = c.verify(['--base', 'main', '--all', '--offline'], { GSTACK_STATE_ROOT: path.join(c.repo.root, 'cold'), GSTACK_HOME: path.join(c.repo.root, 'cold'), GSTACK_STATE_DIR: path.join(c.repo.root, 'cold') });
    expect(outOf(cold)).toContain('(VENDORED_FETCH_FAILED)');
  });
  test('a base with no review_vendored prints none and exits 0', () => {
    const repo = makeFixtureRepo({ prefix: 'gstack-vendored-none-' });
    repos.push(repo);
    const r = runBin(repo, 'gstack-vendored-verify', ['--base', 'main']);
    expect(outOf(r)).toContain('VENDORED_VERIFY: none');
    expect(r.status).toBe(0);
  });
});

describe.skipIf(process.platform === 'win32')('gstack-vendored-verify against a misbehaving server', () => {
  function server(mode: '401' | 'hang') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-vendored-srv-'));
    dirs.push(dir);
    const script = path.join(dir, 'srv.ts');
    fs.writeFileSync(script, mode === '401'
      ? "const s = Bun.serve({ port: 0, fetch: () => new Response('no', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm=x' } }) }); console.log(s.port);\n"
      : "const s = Bun.serve({ port: 0, idleTimeout: 0, fetch: () => new Promise<Response>(() => {}) }); console.log(s.port);\n");
    const proc = Bun.spawn(['bun', ...bunIsolationArgs(), script], { stdout: 'pipe', stderr: 'ignore' });
    return { proc, port: async () => Number((await new Response(proc.stdout).text().catch(() => '')).trim() || 0) };
  }
  for (const mode of ['401', 'hang'] as const) {
    test(`a ${mode} remote fails as fetch-failed without prompting or hanging`, async () => {
      const { proc } = server(mode);
      const reader = proc.stdout.getReader();
      const { value } = await reader.read();
      const port = Number(new TextDecoder().decode(value).trim());
      try {
        const c = consumer();
        const started = Date.now();
        const r = c.verify(['--base', 'main'], { GSTACK_VENDORED_FETCH_ROOT: `http://127.0.0.1:${port}`, GSTACK_VENDORED_FETCH_TIMEOUT_MS: '3000' });
        expect(outOf(r)).toContain('(VENDORED_FETCH_FAILED)');
        expect(r.status).toBe(1);
        expect(Date.now() - started).toBeLessThan(25_000);
      } finally { proc.kill(); }
    }, 60_000);
  }
});

describe('branch globs, missing branches, gitlinks and --json', () => {
  test('a * glob still refuses a commit only a merge-queue branch holds, and a named branch the upstream lacks fails nothing else', () => {
    const star = consumer({ policy: policy([{ url: UP, branches: ['*'] }]) });
    commit(star.repo, { 'vendor/lib/tests/a.py': A + '# queue\n', 'vendor/MANIFEST.json': manifest([{ commit: star.up.queue, files: ['tests/a.py'] }]) }, 'pin');
    const r = star.verify();
    expect(outOf(r)).toContain('(VENDORED_UNREACHABLE)');
    expect(r.status).toBe(1);
    const missing = consumer({ policy: policy([{ url: UP, branches: ['release/2', 'gone'] }]) });
    commit(missing.repo, { 'vendor/lib/tests/a.py': A + '# rel\n', 'vendor/MANIFEST.json': manifest([{ commit: missing.up.release, files: ['tests/a.py'] }]) }, 'pin');
    const m = missing.verify();
    expect(outOf(m)).toContain('reachable_from=heads/release/2');
    expect(m.status).toBe(0);
  });
  // Value: protects=a branch the upstream deletes stops vouching for its commits: the cached ref goes, online and then
  //   offline; fails_when=a stale cached branch keeps a commit reachable; why_new=/ship review of #4665 (test gap
  //   lib/review-vendored.ts:207 for the update-ref -d cleanup)
  test('a named branch the upstream deletes drops its cached ref, online and offline', () => {
    const c = consumer({ policy: policy([{ url: UP, branches: ['release/2'] }]) });
    commit(c.repo, { 'vendor/lib/tests/a.py': A + '# rel\n', 'vendor/MANIFEST.json': manifest([{ commit: c.up.release, files: ['tests/a.py'] }]) }, 'pin');
    expect(outOf(c.verify())).toContain('reachable_from=heads/release/2');
    run(c.up.work, ['push', '-q', c.up.bare, ':refs/heads/release/2'], c.upEnv);
    for (const args of [['--base', 'main'], ['--base', 'main', '--offline']]) {
      const r = c.verify(args);
      expect(outOf(r)).toContain('(VENDORED_UNREACHABLE)');
      expect(r.status).toBe(1);
    }
  });
  // Value: protects=a fetch that fails after a good one fails this run but leaves the good cached pins, so a later offline
  //   check still answers; fails_when=the failure overwrites the cache; why_new=/ship review of #4665 (deferred finding
  //   lib/review-vendored.ts:201)
  test('a failed fetch fails its own run and keeps the good cached pins', () => {
    const c = consumer();
    expect(c.verify().status).toBe(0);
    fs.renameSync(c.up.bare, `${c.up.bare}.away`);
    const down = c.verify();
    expect(outOf(down)).toContain('(VENDORED_FETCH_FAILED)');
    expect(down.status).toBe(1);
    const offline = c.verify(['--base', 'main', '--offline']);
    expect(outOf(offline)).toMatch(/checked=2 verified=2 failed=0/);
    expect(offline.status).toBe(0);
  });
  // Value: protects=after a failed fetch the review plan and every later offline step select the same files, so the
  //   receipt's offline recompute matches the plan's digest, while gstack-vendored-verify --offline still answers from the
  //   good pins; fails_when=the offline selection counts a file the plan kept; why_new=/ship review of #4690
  //   (lib/review-vendored.ts:278)
  test('after a failed fetch the online and offline selections agree until a fetch succeeds', () => {
    const c = consumer();
    expect(c.verify().status).toBe(0);
    const both = ['vendor/lib/tests/a.py', 'vendor/lib/tests/b.py'];
    const select = (fetch: boolean) => {
      const sel = vendoredSelection({ root: c.repo.work, policy: vendoredPolicy(JSON.parse(policy()))!, head: c.repo.git('rev-parse', 'HEAD').trim(), mergeBase: c.repo.git('merge-base', 'origin/main', 'HEAD').trim(), changed: new Set(both), fetch, cacheRoot: vendoredCacheRoot(c.repo.env.GSTACK_STATE_ROOT), env: { ...process.env, ...c.repo.env, GSTACK_VENDORED_FETCH_ROOT: c.fetchRoot } });
      return 'error' in sel ? sel.error : sel.verified;
    };
    fs.renameSync(c.up.bare, `${c.up.bare}.away`);
    expect(select(true)).toEqual([]);
    expect(select(false)).toEqual([]);
    expect(c.verify(['--base', 'main', '--offline']).status).toBe(0);
    fs.renameSync(`${c.up.bare}.away`, c.up.bare);
    expect(select(true)).toEqual(both);
    expect(select(false)).toEqual(both);
  });
  // Value: protects=the merge-base pin check never fails verify, even when it throws: a deletion-only re-pin whose old pin
  //   cannot be cached still passes on its head result; fails_when=the base check's error exits nonzero; why_new=/ship review
  //   of #4690 (bin/gstack-vendored-verify:88)
  test('a merge-base check that cannot run reports itself and leaves the head verdict alone', () => {
    const c = consumer();
    c.repo.git('checkout', '-q', 'main');
    c.repo.git('merge', '-q', '--ff-only', 'feat');
    c.repo.git('push', '-q', 'origin', 'main');
    c.repo.git('checkout', '-q', 'feat');
    commit(c.repo, { 'vendor/lib/tests/b.py': null, 'vendor/MANIFEST.json': manifest([{ commit: c.up.c1, files: ['tests/a.py'] }]) }, 'drop b');
    const blocked = path.join(c.repo.root, 'blocked');
    fs.mkdirSync(blocked);
    fs.writeFileSync(path.join(blocked, 'vendored-cache'), 'not a directory\n');
    const r = c.verify(['--base', 'main'], { GSTACK_STATE_ROOT: blocked, GSTACK_HOME: blocked, GSTACK_STATE_DIR: blocked });
    expect(outOf(r)).toContain('VENDORED_BASE: unavailable (');
    expect(outOf(r)).toContain('VENDORED_VERIFY: checked=0 verified=0 failed=0');
    expect(r.status).toBe(0);
  });
  // Value: protects=verify also caches the merge base's pin for a re-pinned file, so the review plan answers offline on a
  //   clean machine and keeps treating the file as vendored; fails_when=the old pin stays cold and the offline selection
  //   keeps the file; why_new=GST-3298 PR 3 (a modified file counts only when its base copy verified)
  test('verify caches the merge base pins a re-pin needs for an offline selection', () => {
    const c = consumer();
    c.repo.git('checkout', '-q', 'main');
    c.repo.git('merge', '-q', '--ff-only', 'feat');
    c.repo.git('push', '-q', 'origin', 'main');
    c.repo.git('checkout', '-q', 'feat');
    commit(c.repo, { 'vendor/lib/tests/b.py': B2, 'vendor/MANIFEST.json': manifest([{ commit: c.up.c2, files: ['tests/a.py', 'tests/b.py'] }]) }, 'repin');
    const cold = path.join(c.repo.root, 'cold');
    const coldEnv = { GSTACK_STATE_ROOT: cold, GSTACK_HOME: cold, GSTACK_STATE_DIR: cold };
    const r = c.verify(['--base', 'main'], coldEnv);
    expect(outOf(r)).toContain('VENDORED_BASE: checked=1 verified=1');
    expect(r.status).toBe(0);
    const mergeBase = c.repo.git('merge-base', 'origin/main', 'HEAD').trim();
    const sel = vendoredSelection({ root: c.repo.work, policy: vendoredPolicy(JSON.parse(policy()))!, head: c.repo.git('rev-parse', 'HEAD').trim(), mergeBase, changed: new Set(['vendor/lib/tests/b.py']), fetch: false, cacheRoot: vendoredCacheRoot(cold) });
    expect('error' in sel ? sel.error : sel.verified).toEqual(['vendor/lib/tests/b.py']);
  });
  test('an upstream gitlink is VENDORED_MODE, and --json keeps the pin count beside the pin rows', () => {
    const c = consumer();
    run(c.up.work, ['update-index', '--add', '--cacheinfo', `160000,${c.up.c1},tests/sub`], c.upEnv);
    run(c.up.work, ['commit', '-q', '-m', 'gitlink'], c.upEnv);
    const g = run(c.up.work, ['rev-parse', 'HEAD'], c.upEnv);
    run(c.up.work, ['push', '-q', c.up.bare, 'main'], c.upEnv);
    commit(c.repo, { 'vendor/lib/tests/sub': A, 'vendor/MANIFEST.json': manifest([{ commit: g, files: ['tests/sub'] }]) }, 'gitlink');
    expect(outOf(c.verify())).toContain('(VENDORED_MODE)');
    const j = c.verify(['--base', 'main', '--json']);
    const out = JSON.parse(j.out) as { pins: number; pin_results: unknown[] };
    expect(out.pins).toBe(1);
    expect(out.pin_results).toHaveLength(1);
  });
});
