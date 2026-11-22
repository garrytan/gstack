/**
 * GST-3360, from several /ship runs on one machine (HARN-120): gstack-ship-preflight's Step 5 bounds each CI carry's
 * record-ci by the base policy's ci_record_timeout_s and says which bound it used, as accept does (harness-evals sets 900 s;
 * preflight kept the 600 s default), and it stops with the install command when a fresh worktree has no node_modules instead of
 * running a pregate and lanes that cannot resolve the repository's own tools.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CI_RECORD_TIMEOUT_KEY_VERSION } from '../lib/ship-policy';
import { fakeGhScript, type FakeWorld } from './helpers/fake-gh-runs';
import { lineOf, PREFLIGHT, RELEASE, shipFixture, type ShipFx } from './helpers/ship-bin-fixture';

setDefaultTimeout(120_000);
const fixtures: ShipFx[] = [];
afterEach(() => { while (fixtures.length) fixtures.pop()!.cleanup(); });

const FREE = "printf x >> ../free-runs; printf ' 3 pass\\n 0 fail\\nRan 3 tests across 1 file. [1.00ms]\\n' >&2";
const HOST_OS = ({ darwin: 'macOS', win32: 'Windows' } as Record<string, string>)[process.platform] ?? 'Linux';
const PROFILE = { workflow: 'free.yml', events: ['pull_request', 'workflow_dispatch'], jobs: ['suite'], artifact: 'tested-tree', os: HOST_OS };
const TESTS = ['test/a.test.ts'];
const BASE = {
  '.gstack/pregate.json': JSON.stringify({ run_profiles: { 'ci/free': PROFILE }, ship_lanes_from: { [FREE]: { profiles: ['ci/free'], inventory: `printf '${TESTS.join('\\n')}\\n'` } }, dependencies: { 'src/a.ts': ['test/a.test.ts'], 'src/b.ts': ['test/a.test.ts'], 'test/**': [], '.gstack/ship-policy.json': [] } }, null, 2) + '\n',
  '.github/workflows/free.yml': 'name: Free\non: [pull_request, workflow_dispatch]\njobs:\n  suite:\n    runs-on: ubuntu-latest\n    steps:\n      - run: bun test\n',
  'test/a.test.ts': "import { expect, test } from 'bun:test';\ntest('ok', () => expect(1).toBe(1));\n",
};
const freeRuns = (f: ShipFx) => { const p = path.join(f.root, 'free-runs'); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').length : 0; };

/** A fixture whose HEAD has one green workflow_dispatch run of free.yml at its pushed tree, so the mapped lane carries. */
function carried(base: Record<string, string>): ShipFx {
  const f = shipFixture({ ...BASE, ...base });
  fixtures.push(f);
  const sha = f.git('rev-parse', 'HEAD').stdout.trim();
  const tree = f.git('rev-parse', 'HEAD^{tree}').stdout.trim();
  const at = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const run = { id: 7, run_attempt: 1, status: 'completed', conclusion: 'success', event: 'workflow_dispatch', head_sha: sha, path: '.github/workflows/free.yml', created_at: at(20), run_started_at: at(20), updated_at: at(5), repository: { full_name: 'fx/fx' }, head_repository: { full_name: 'fx/fx' } };
  const w: FakeWorld = { runs: [run] as FakeWorld['runs'], jobs: { 7: [{ name: 'suite', conclusion: 'success', completed_at: at(5) }] }, trees: { 7: { run_id: 7, run_attempt: 1, event: 'workflow_dispatch', sha, tree, files: TESTS, tests: 1, os: HOST_OS } } };
  fs.writeFileSync(path.join(f.root, 'world.json'), JSON.stringify(w));
  f.gh(fakeGhScript(path.join(f.root, 'world.json')));
  expect(f.run(RELEASE, ['push', '--branch', 'feat', '--early', '--base', 'main'], { GSTACK_SESSION_KIND: 'unattended' }).status).toBe(0);
  return f;
}
const testsOnly = (f: ShipFx) => f.run(PREFLIGHT, ['--tests-only', '--base', 'main', '--lane', `free=${FREE}`]);

describe('preflight Step 5: the record-ci bound comes from the base policy (GST-3360)', () => {
  // Value: protects=a repo that raised ci_record_timeout_s (harness-evals: 900 s, for a per_file rerun of CI-skipped files) gets that
  //   bound in preflight's carry too, and the line says so; fails_when=preflight's carry keeps the 600 s default or prints no bound;
  //   seam=bin/gstack-ship-preflight --tests-only, runLanes, carryLane
  test('the base sets 900 s: preflight carries the lane under it and says so', () => {
    const out = testsOnly(carried({ '.gstack/ship-policy.json': JSON.stringify({ ci_record_timeout_s: 900, min_gstack_version: CI_RECORD_TIMEOUT_KEY_VERSION }) + '\n' }));
    expect([out.status, lineOf(out.stdout, 'CI_RECORD_TIMEOUT')], out.stdout + out.stderr).toEqual([0, 'CI_RECORD_TIMEOUT: 900s (origin/main ci_record_timeout_s)']);
    expect(out.stdout).toMatch(/^LANE: free .*carried/m);
  });

  // Value: protects=with no policy key the bound stays 600 s and is still named; fails_when=the default changes or goes unsaid;
  //   seam=bin/gstack-ship-preflight --tests-only
  test('no key on the base: the 600 s default, named', () => {
    const out = testsOnly(carried({}));
    expect([out.status, lineOf(out.stdout, 'CI_RECORD_TIMEOUT')], out.stdout + out.stderr).toEqual([0, 'CI_RECORD_TIMEOUT: 600s (default)']);
  });
});

describe('preflight Step 5: a worktree with no installed packages stops with the install command (GST-3360)', () => {
  // Value: protects=a fresh worktree (one per /ship run on a shared machine) gets one STOP naming the exact install command before
  //   the pregate and lanes run without the repo's tools (tsc exit 127, unresolved imports); fails_when=Step 5 runs anyway, the stop
  //   names no command, the lockfile's tool is ignored, or a checkout with node_modules or no declared packages is stopped;
  //   seam=bin/gstack-ship-preflight --tests-only, depsInstall
  test('package.json declares packages and node_modules is missing: stop before anything runs; installed, it goes on', () => {
    const f = shipFixture({ 'package.json': '{"name":"fx","version":"1.0.0","devDependencies":{"left-pad":"1.3.0"}}\n', 'bun.lock': '{}\n' });
    fixtures.push(f);
    const held = testsOnly(f);
    expect(held.status, held.stdout + held.stderr).toBe(3);
    expect(lineOf(held.stdout, 'STOP')).toBe(`STOP: DEPS_MISSING: ${f.work}/package.json declares packages but there is no node_modules (a fresh worktree), so Step 5's pregate and lanes cannot run: cd '${f.work}' && bun install --frozen-lockfile, then rerun this command`);
    expect(held.stdout).not.toMatch(/^PREGATE: /m);
    expect(freeRuns(f)).toBe(0);
    fs.mkdirSync(path.join(f.work, 'node_modules'));
    const ran = testsOnly(f);
    expect(ran.stdout).not.toContain('DEPS_MISSING');
    expect(ran.stdout).toMatch(/^PREGATE: /m);
  });

  test('a package-lock.json names npm ci, and a package.json with no packages never stops', () => {
    const f = shipFixture({ 'package.json': '{"name":"fx","version":"1.0.0","dependencies":{"left-pad":"1.3.0"}}\n', 'package-lock.json': '{}\n' });
    fixtures.push(f);
    expect(lineOf(testsOnly(f).stdout, 'STOP')).toContain(`&& npm ci, then rerun this command`);
    const shrink = shipFixture({ 'package.json': '{"name":"fx","version":"1.0.0","dependencies":{"left-pad":"1.3.0"}}\n', 'npm-shrinkwrap.json': '{}\n' });
    fixtures.push(shrink);
    expect(lineOf(testsOnly(shrink).stdout, 'STOP')).toContain(`&& npm ci, then rerun this command`);
    const plain = shipFixture();
    fixtures.push(plain);
    expect(testsOnly(plain).stdout).not.toContain('DEPS_MISSING');
  });

  // Value: protects=an installed Yarn Plug'n'Play checkout, which never has node_modules, runs Step 5 instead of stopping on an
  //   install that cannot clear the stop; fails_when=depsInstall checks node_modules alone; seam=bin/gstack-ship-preflight --tests-only
  test('a Yarn PnP checkout (.pnp.cjs, no node_modules) never stops on DEPS_MISSING', () => {
    const f = shipFixture({ 'package.json': '{"name":"fx","version":"1.0.0","dependencies":{"left-pad":"1.3.0"}}\n', 'yarn.lock': '\n', '.pnp.cjs': '\n' });
    fixtures.push(f);
    const out = testsOnly(f);
    expect(out.stdout).not.toContain('DEPS_MISSING');
    expect(out.stdout).toMatch(/^PREGATE: /m);
    const classic = shipFixture({ 'package.json': '{"name":"fx","version":"1.0.0","dependencies":{"left-pad":"1.3.0"}}\n', 'yarn.lock': '\n', '.pnp.js': '\n' });
    fixtures.push(classic);
    expect(testsOnly(classic).stdout).not.toContain('DEPS_MISSING');
  });
});
