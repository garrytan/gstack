/**
 * GST-419 and GST-420 (GSTA-195): `--policy-from head` may only add test lanes over the
 * trusted policy (the base branch's copy, or the user-owned file when the base has none),
 * and the base policy's `timeout_s` is gstack-pregate's per-process timeout when
 * `--timeout` is not passed.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { BASE_PREGATE, cleanup, commit, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

const SLUG = 'headpolicy';
const pregate = (repo: FixtureRepo, args: string[]) => runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--stage', 'tests', ...args], { GSTACK_PROJECT_SLUG: SLUG });
const lanes = (repo: FixtureRepo) => JSON.parse(fs.readFileSync(path.join(repo.work, '.gstack/tmp/pregate.json'), 'utf8')).checks.find((c: any) => c.id === 'lanes');
const policy = (deps: Record<string, string[]>, extra: Record<string, unknown> = {}) => JSON.stringify({ ...BASE_PREGATE, dependencies: deps, ...extra }, null, 2) + '\n';
const NEW_LANE = { ...BASE_PREGATE.dependencies, 'lib/orphan.js': ['test/util.test.js'] };

function branchWithOrphanEdit(base?: Record<string, unknown> | null): FixtureRepo {
  const repo = makeFixtureRepo(base === undefined ? {} : { pregate: base });
  repos.push(repo);
  commit(repo, { 'lib/orphan.js': 'exports.lonely = () => 2;\n' });
  return repo;
}

describe('gstack-pregate --policy-from head: additive only (GST-419)', () => {
  // Value: protects=a branch that adds the lane for a file it touches can gate under its own policy; fails_when=the head lane is ignored or refused;
  //   why_new=GEVA-2 (gstack-evals#93) hit PREGATE_NO_LANE and had to call runLanes by hand; seam=import graph; no_claim=queue treatment of head records
  test('a head policy that only adds a lane gates the touched file; the base policy still reports no lane', () => {
    const repo = branchWithOrphanEdit();
    commit(repo, { '.gstack/pregate.json': policy(NEW_LANE) });
    const viaBase = pregate(repo, []);
    expect(viaBase.status).toBe(EXIT.fail);
    expect(viaBase.out).toContain('FAIL lanes — lib/orphan.js has no test lane');
    const viaHead = pregate(repo, ['--policy-from', 'head']);
    expect(viaHead.err).not.toContain('PREGATE_HEAD_POLICY_LOOSENS');
    expect(viaHead.status).toBe(EXIT.ok);
    expect(lanes(repo).status).toBe('pass');
    expect(viaHead.out).toMatch(/^pregate: policy head \(unreviewed\) .*adds 1 lane/m);
  }, 60_000);

  // Value: protects=the trust boundary: a head policy cannot remove, shrink or loosen anything the base declares; fails_when=any of these runs under head;
  //   why_new=--policy-from head took the whole head file; seam=none; no_claim=generated.json, which head mode still reads from the branch
  test.each([
    ['removes a lane', policy({ 'docs/**': [], 'README.md': [] }), 'dependencies["bin/tool"]'],
    ['swaps a lane for another test', policy({ ...BASE_PREGATE.dependencies, 'bin/tool': ['test/util.test.js'] }), 'dependencies["bin/tool"]'],
    ['adds a [] declaration', policy({ ...BASE_PREGATE.dependencies, 'lib/orphan.js': [] }), 'dependencies["lib/orphan.js"]'],
    ['changes the runner', policy(NEW_LANE, { runner: 'node --test --test-only {files}' }), 'runner'],
    ['downgrades a check', policy(NEW_LANE, { warn: ['strays', 'literals'] }), 'warn'],
    ['allowlists a finding', policy(NEW_LANE, { allowlist: [{ finding: 'pii', paths: ['lib/**'], reason: 'x' }] }), 'allowlist'],
    ['deletes the file', null, '.gstack/pregate.json'],
  ])('a head policy that %s is refused', (_what, head, names) => {
    const repo = branchWithOrphanEdit();
    commit(repo, { '.gstack/pregate.json': head });
    const r = pregate(repo, ['--policy-from', 'head']);
    expect(r.status).toBe(EXIT.refused);
    expect(r.err).toContain('(PREGATE_HEAD_POLICY_LOOSENS');
    expect(r.err).toContain(names);
    expect(fs.existsSync(path.join(repo.work, '.gstack/tmp/pregate.json'))).toBe(false);
  }, 60_000);

  // Value: protects=a reordered list is not a change; fails_when=key or list order counts as loosening; why_new=set equality; seam=none; no_claim=none
  test('reordering lists and adding a test to an existing lane is additive', () => {
    const repo = branchWithOrphanEdit();
    commit(repo, { '.gstack/pregate.json': JSON.stringify({ ...BASE_PREGATE, strays: { allow: ['Makefile'] }, warn: ['strays'], dependencies: { 'README.md': [], 'docs/**': [], 'bin/tool': ['test/util.test.js', 'test/tool-cli.test.js'], 'lib/orphan.js': ['test/util.test.js'] } }) });
    expect(pregate(repo, ['--policy-from', 'head']).status).toBe(EXIT.ok);
  }, 60_000);

  // Value: protects=a branch behind the base is compared with the policy it forked from and runs the base tip plus its additions; fails_when=a lane the base added later reads as a removal;
  //   why_new=stamp-at-merge preflight skips the base merge; seam=merge-base; no_claim=none
  test('a stale branch keeps the lanes the base added after it forked', () => {
    const repo = branchWithOrphanEdit();
    commit(repo, { '.gstack/pregate.json': policy(NEW_LANE) });
    repo.git('checkout', '-q', 'main');
    commit(repo, { '.gstack/pregate.json': policy({ ...BASE_PREGATE.dependencies, 'lib/util.js': ['test/util.test.js'] }) }, 'base adds a lane');
    repo.git('push', '-q', 'origin', 'main');
    repo.git('checkout', '-q', 'feature');
    repo.git('fetch', '-q', 'origin');
    const r = pregate(repo, ['--policy-from', 'head', '--explain']);
    expect(r.err).not.toContain('PREGATE_HEAD_POLICY_LOOSENS');
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toContain('head policy adds: dependencies["lib/orphan.js"]');
  }, 60_000);

  // Value: protects=with no base copy, the user-owned policy is the trusted one a head policy is compared with; fails_when=head mode drops the user guard;
  //   why_new=head mode never read the user file; seam=state root; no_claim=none
  test('with no base copy, a head policy that drops the user-owned guard is refused; one that adds a lane runs', () => {
    const repo = branchWithOrphanEdit(null);
    const user = { ...BASE_PREGATE, guards: [{ id: 'always', when: ['lib/**'], command: 'true' }] };
    const userPolicy = path.join(repo.home, 'projects', SLUG, 'pregate.json');
    fs.mkdirSync(path.dirname(userPolicy), { recursive: true });
    fs.writeFileSync(userPolicy, JSON.stringify(user));
    commit(repo, { '.gstack/pregate.json': policy(NEW_LANE) });
    const dropped = pregate(repo, ['--policy-from', 'head']);
    expect(dropped.status).toBe(EXIT.refused);
    expect(dropped.err).toContain('guards');
    commit(repo, { '.gstack/pregate.json': JSON.stringify({ ...user, dependencies: NEW_LANE }) });
    expect(pregate(repo, ['--policy-from', 'head']).status).toBe(EXIT.ok);
    const verify = () => runBin(repo, 'gstack-pregate', ['verify'], { GSTACK_PROJECT_SLUG: SLUG });
    expect(verify().status).toBe(EXIT.ok);
    fs.writeFileSync(userPolicy, JSON.stringify({ ...user, guards: [] }));
    const stale = verify();
    expect(stale.status).not.toBe(EXIT.ok);
    expect(stale.err + stale.out).toContain('changed after pregate.json was recorded');
  }, 60_000);

  // Value: protects=a PR that introduces the first policy still bootstraps under head; fails_when=the bootstrap path is refused; why_new=rule scope; seam=none; no_claim=none
  test('with no base copy and no user-owned file, a head policy is a bootstrap and runs as written', () => {
    const repo = branchWithOrphanEdit(null);
    commit(repo, { '.gstack/pregate.json': policy({ 'lib/orphan.js': ['test/util.test.js'], 'docs/**': [] }) });
    expect(pregate(repo, ['--policy-from', 'head']).status).toBe(EXIT.ok);
  }, 60_000);
});

describe('timeout_s in the base policy (GST-420)', () => {
  const SLOW = "const test = require('node:test');\ntest('slow', async () => { await new Promise(r => setTimeout(r, 4000)); });\n";
  // Value: protects=the repo's per-process timeout reaches every caller that does not pass --timeout (preflight, finish); fails_when=pregate keeps its 600 s default;
  //   why_new=HARN-1 (HARN-12) lanes of ~780 s were always incomplete under preflight; seam=supervise; no_claim=remote wall clock
  test('timeout_s bounds each runner process when --timeout is absent, and --timeout still overrides it', () => {
    const repo = makeFixtureRepo({ pregate: { ...BASE_PREGATE, timeout_s: 2 } }); repos.push(repo);
    commit(repo, { 'test/slow.serial.test.js': SLOW });
    expect(pregate(repo, []).status).toBe(EXIT.fail);
    expect(lanes(repo)).toMatchObject({ status: 'incomplete', code: 'PREGATE_INCOMPLETE' });
    expect(lanes(repo).detail).toContain('a runner process timed out after 2000 ms (timeout_s from origin/main');
    expect(pregate(repo, ['--timeout', '30']).status).toBe(EXIT.ok);
  }, 90_000);

  // Value: protects=timeout_s stays inside the one-hour wrapper deadline preflight and finish use; fails_when=values over 3600 or under 1 validate;
  //   why_new=new key; seam=none; no_claim=none
  test.each([[0], [3601], [1.5], ['600']])('timeout_s %p is invalid', (value) => {
    const repo = makeFixtureRepo({ pregate: { ...BASE_PREGATE, timeout_s: value } }); repos.push(repo);
    const r = pregate(repo, []);
    expect(r.status).toBe(EXIT.refused);
    expect(r.err).toContain('timeout_s');
  }, 60_000);
});
