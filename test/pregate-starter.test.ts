/**
 * Lane D (GSTA-112, E4): a repository with no pregate policy anywhere (no
 * `.gstack/pregate.json` on the base, no user-owned file) gets a `warn` row
 * with a printed starter policy instead of a hard PREGATE_NO_LANE, so the
 * first /ship pass in a new repo is not blocked before anyone has written the
 * lane policy (FOUN #292, harness-evals #81/#82). Nothing is written by `run`;
 * `gstack-pregate init` is the explicit write. A repository that has a policy
 * keeps the hard failure: missing coverage is never inferred silently.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { validateConfig } from '../lib/pregate/config';
import { CHECK_IDS } from '../lib/pregate/index';
import { nearestTestsFor } from '../lib/pregate/starter';
import { BASE_PREGATE, cleanup, commit, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
const fixture = (opts?: Parameters<typeof makeFixtureRepo>[0]) => { const r = makeFixtureRepo(opts); repos.push(r); return r; };
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });
/** The fixture's Windows workflow replaced by a lint job: with no policy its planner-computed matrix would otherwise make every selected test a requires-remote obligation. */
const NO_PLATFORM_LANE = { '.github/workflows/windows.yml': 'name: Lint\non: [push]\njobs:\n  lint:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo lint\n' };
const lanes = (repo: FixtureRepo, extra: string[] = [], env: Record<string, string> = {}) => runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--only', 'lanes', ...extra], env);
const readOut = (repo: FixtureRepo) => JSON.parse(fs.readFileSync(path.join(repo.work, '.gstack/tmp/pregate.json'), 'utf8'));
const starterJson = (out: string): Record<string, unknown> => {
  const block = /PREGATE_STARTER: begin \.gstack\/pregate\.json\n([\s\S]*?)\n\s*lanes: PREGATE_STARTER: end/.exec(out);
  if (!block) throw new Error(`no starter block in:\n${out}`);
  return JSON.parse(block[1]!.split('\n').map(l => l.replace(/^\s*lanes: /, '')).join('\n'));
};
/** An unmapped source file, a mapped one (its test runs) and a file whose only nearby test shares its stem without importing it. */
const NO_POLICY_DIFF = {
  'lib/orphan.js': 'exports.lonely = () => 2;\n',
  'lib/util.js': 'exports.add = (a, b) => b + a;\n',
  'scripts/report.js': 'module.exports = () => "report";\n',
  'test/report.test.js': "const test = require('node:test');\ntest('report placeholder', () => {});\n",
};

describe('no policy anywhere: warn plus a printed starter (never PREGATE_NO_LANE)', () => {
  // Value: protects=the first /ship in a repo with no .gstack/pregate.json is not blocked by PREGATE_NO_LANE: the unmapped files
  //   are a warn row (PREGATE_NO_POLICY) with a starter policy the owner can commit, and the selected tests still run;
  //   fails_when=the lanes check exits 1 with PREGATE_NO_LANE (the behaviour before this change) or the starter is missing or
  //   invalid; why_new=the no-policy branch is new; seam=none; no_claim=the starter's mappings are right for every repo
  test('unmapped files are a warn row, the mapped test still runs, and the starter validates and maps by nearest test or stem', () => {
    const repo = fixture({ pregate: null, baseFiles: NO_PLATFORM_LANE });
    commit(repo, NO_POLICY_DIFF);
    const r = lanes(repo);
    expect(r.err).not.toContain('PREGATE_NO_LANE');
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toContain('(PREGATE_NO_POLICY)');
    expect(r.err).not.toContain('gstack-pregate: lanes');
    expect(r.out).toContain('no policy: lib/orphan.js scripts/report.js have no test lane');
    const row = readOut(repo).checks.find((c: any) => c.id === 'lanes');
    expect([row.status, row.code]).toEqual(['warn', 'PREGATE_NO_POLICY']);
    expect(row.detail).toMatch(/\d+ tests ran in \d+ file\(s\)/);
    expect(row.fix).toContain('gstack-pregate init');
    const starter = starterJson(r.out);
    expect(validateConfig(starter, CHECK_IDS)).toEqual([]);
    expect(starter.runner).toBe('node --test {files}');
    expect((starter.dependencies as Record<string, string[]>)['scripts/report.js']).toEqual(['test/report.test.js']);
    expect(starter.dependencies).not.toHaveProperty('lib/orphan.js');
    expect(r.out).toContain('TODO lib/orphan.js: no test lane and no nearby test');
    expect(r.out).toContain('PREGATE_STARTER: test directories: test');
    expect(r.out).toContain('PREGATE_STARTER: CI lanes: free-tests.yml/unit (linux)');
    expect(fs.existsSync(path.join(repo.work, '.gstack/pregate.json'))).toBe(false);
    // With the planner-computed Windows lane and no selection manifest, the selected tests are a requires-remote obligation: that status stands, with the no-policy code and the starter beside it.
    const platform = fixture({ pregate: null });
    commit(platform, NO_POLICY_DIFF);
    const p = lanes(platform);
    expect(p.status).toBe(EXIT.ok);
    expect(p.err).not.toContain('PREGATE_NO_LANE');
    const prow = readOut(platform).checks.find((c: any) => c.id === 'lanes');
    expect([prow.status, prow.code]).toEqual(['requires-remote', 'PREGATE_NO_POLICY']);
    expect(p.out).toContain('PREGATE_STARTER: CI lanes: free-tests.yml/unit (linux), windows.yml/windows-shard (windows, matrix computed; declare selection)');
  });

  // Value: protects=warn never hides a failing selected test: a no-policy run whose lane fails is still fail; fails_when=the
  //   starter branch returns warn for a red lane; why_new=new branch; seam=none; no_claim=none
  test('a failing selected test under no policy is still PREGATE_LANE_FAILED', () => {
    const repo = fixture({ pregate: null, baseFiles: NO_PLATFORM_LANE });
    commit(repo, { ...NO_POLICY_DIFF, 'lib/util.js': 'exports.add = (a, b) => a - b;\n' });
    const r = lanes(repo);
    expect(r.status).toBe(EXIT.fail);
    expect(r.err).toContain('(PREGATE_LANE_FAILED)');
    expect(r.out).toContain('no policy: lib/orphan.js scripts/report.js have no test lane');
  });

  // Value: protects=a repository with a policy that declares lanes keeps the hard PREGATE_NO_LANE (base copy, the user-owned file and a
  //   head bootstrap; a runner-only policy declares none since GST-775); fails_when=the warn branch fires whenever an entry is unmapped; why_new=the branch condition is new; seam=none; no_claim=none
  test('a base policy or a user-owned policy keeps PREGATE_NO_LANE as a hard failure', () => {
    const withBase = fixture();
    commit(withBase, { 'lib/orphan.js': 'exports.lonely = () => 2;\n' });
    const b = lanes(withBase);
    expect(b.status).toBe(EXIT.fail);
    expect(b.err).toContain('(PREGATE_NO_LANE)');
    expect(b.out).not.toContain('PREGATE_STARTER');
    const withUser = fixture({ pregate: null });
    commit(withUser, { 'lib/orphan.js': 'exports.lonely = () => 2;\n' });
    const userPolicy = path.join(withUser.home, 'projects', 'starterslug', 'pregate.json');
    fs.mkdirSync(path.dirname(userPolicy), { recursive: true });
    fs.writeFileSync(userPolicy, JSON.stringify({ runner: 'node --test {files}', dependencies: { 'docs/**': [] } }));
    const u = lanes(withUser, [], { GSTACK_PROJECT_SLUG: 'starterslug' });
    expect(u.status).toBe(EXIT.fail);
    expect(u.err).toContain('(PREGATE_NO_LANE)');
    expect(u.out).not.toContain('PREGATE_STARTER');
    // --policy-from head with a head policy (no base copy) is strict too.
    const withHead = fixture({ pregate: null });
    commit(withHead, { 'lib/orphan.js': 'exports.lonely = () => 2;\n', '.gstack/pregate.json': JSON.stringify({ runner: 'node --test {files}', dependencies: { 'docs/**': [] } }) + '\n' });
    const h = lanes(withHead, ['--policy-from', 'head']);
    expect(h.status).toBe(EXIT.fail);
    expect(h.err).toContain('(PREGATE_NO_LANE)');
    expect(h.out).not.toContain('PREGATE_STARTER');
  });

  // Value: protects=`run` never writes the policy; `init` is the explicit write and the starter and the init draft agree on the
  //   runner; fails_when=run creates .gstack/pregate.json or init writes something validate rejects; why_new=the run/init split is
  //   the contract this lane documents; seam=none; no_claim=none
  test('init is the explicit write: it produces a policy validate accepts, and run left none behind', () => {
    const repo = fixture({ pregate: null });
    commit(repo, NO_POLICY_DIFF);
    lanes(repo);
    expect(fs.existsSync(path.join(repo.work, '.gstack/pregate.json'))).toBe(false);
    const init = runBin(repo, 'gstack-pregate', ['init']);
    expect(init.status).toBe(EXIT.ok);
    expect(init.out).toContain('PREGATE_CONFIG_WRITTEN');
    expect(runBin(repo, 'gstack-pregate', ['validate']).out).toContain('PREGATE_CONFIG_VALID');
    expect(BASE_PREGATE.runner).toBe('node --test {files}');
  });
});

describe('nearestTestsFor: the nearest directory with tests, else the tests sharing the stem', () => {
  const tests = ['lib/render/a.test.ts', 'lib/render/b.test.ts', 'test/report.test.js', 'test/report-golden.test.js', 'test/reporter.test.js'];
  test('a file under a directory with tests takes those tests; one with none takes its stem; a stem with no match is empty', () => {
    expect(nearestTestsFor(tests, 'lib/render/draw.ts')).toEqual(['lib/render/a.test.ts', 'lib/render/b.test.ts']);
    expect(nearestTestsFor(tests, 'src/report.js')).toEqual(['test/report.test.js', 'test/report-golden.test.js']);
    expect(nearestTestsFor(tests, 'src/orphan.js')).toEqual([]);
    expect(nearestTestsFor(tests, 'README')).toEqual([]);
  });
});
