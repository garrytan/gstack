/**
 * GST-1688 (GBRA-345, gbrain #8727): gbrain maps every /ship lane through ship_lanes_from, and its inventory command
 * refuses on purpose for a tree that changes CI-reuse files (runs_may_attest, exit 1). accept then stopped with
 * CI_CARRY: none label=unit (inventory_failed: …) although a cleared pregate.json/remote_gate stood for the identical
 * tree (PREGATE_REMOTE: tree=… tests=6482 failed=0, PREGATE_VERIFY: ok). That receipt now satisfies the mapped lane and
 * accept names the substitution; a receipt for any other tree still stops.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { recordCiResult } from '../lib/ci-carry';
import { fakeGhScript, type FakeWorld } from './helpers/fake-gh-runs';
import { lineOf, RELEASE, shipFixture, type ShipFx } from './helpers/ship-bin-fixture';

setDefaultTimeout(180_000);
const fixtures: ShipFx[] = [];
afterEach(() => { while (fixtures.length) fixtures.pop()!.cleanup(); });

const BIN = path.dirname(RELEASE);
const UNIT = "printf ' 3 pass\\n 0 fail\\nRan 3 tests across 1 file. [1.00ms]\\n' >&2";
const HOST_OS = ({ darwin: 'macOS', win32: 'Windows' } as Record<string, string>)[process.platform] ?? 'Linux';
const RUNNER = ({ darwin: 'macos-latest', win32: 'windows-latest' } as Record<string, string>)[process.platform] ?? 'ubuntu-latest';
const TESTS = ['test/a.test.ts'];
const REFUSE = "echo 'runs_may_attest: refused: this tree changes CI-reuse files (.github/workflows/free.yml)' >&2; exit 1";
const BASE = {
  '.gstack/pregate.json': JSON.stringify({
    run_profiles: { 'ci/free': { workflow: 'free.yml', events: ['pull_request', 'workflow_dispatch'], jobs: ['suite'], artifact: 'tested-tree', os: HOST_OS } },
    ship_lanes_from: { [UNIT]: { profiles: ['ci/free'], inventory: REFUSE } },
    remote_gate: 'sh scripts/remote-gate.sh',
    dependencies: { 'src/a.ts': ['test/a.test.ts'], 'src/b.ts': ['test/a.test.ts'], 'test/**': [], 'scripts/**': [], '.gstack/ship-policy.json': [] },
  }, null, 2) + '\n',
  'scripts/remote-gate.sh': 'printf "PREGATE_REMOTE: tree=%s tests=6482 failed=0\\n" "$PREGATE_TREE"\n',
  '.github/workflows/free.yml': `name: Free\non: [pull_request, workflow_dispatch]\njobs:\n  suite:\n    runs-on: ${RUNNER}\n    steps:\n      - run: bun test\n`,
  'test/a.test.ts': "import { expect, test } from 'bun:test';\ntest('ok', () => expect(1).toBe(1));\n",
};

/** A pushed branch whose free.yml run is green at HEAD (CI ran its tests; the lane's inventory refuses this tree). */
function pushed(head: Record<string, string> = { 'src/b.ts': 'export const b = 2;\n' }): ShipFx {
  const f = shipFixture(BASE, head);
  fixtures.push(f);
  world(f);
  expect(f.run(RELEASE, ['push', '--branch', 'feat', '--early', '--base', 'main'], { GSTACK_SESSION_KIND: 'unattended' }).status).toBe(0);
  return f;
}
function world(f: ShipFx, files: string[] = TESTS): void {
  const sha = f.git('rev-parse', 'HEAD').stdout.trim();
  const tree = f.git('rev-parse', 'HEAD^{tree}').stdout.trim();
  const at = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const run = { id: 7, run_attempt: 1, status: 'completed', conclusion: 'success', event: 'workflow_dispatch', head_sha: sha, path: '.github/workflows/free.yml', created_at: at(20), run_started_at: at(20), updated_at: at(5), repository: { full_name: 'fx/fx' }, head_repository: { full_name: 'fx/fx' } };
  const w: FakeWorld = { runs: [run] as FakeWorld['runs'], jobs: { 7: [{ name: 'suite', conclusion: 'success', completed_at: at(5) }] }, trees: { 7: { run_id: 7, run_attempt: 1, event: 'workflow_dispatch', sha, tree, files, tests: files.length ? 1 : 0, os: HOST_OS } } };
  fs.writeFileSync(path.join(f.root, 'world.json'), JSON.stringify(w));
  f.gh(fakeGhScript(path.join(f.root, 'world.json')));
}
/** The remote gate for the checked-out tree, as gbrain ran it: the preflight stage, gstack-pregate --remote, then verify. */
function gate(f: ShipFx): string {
  const pre = f.run(path.join(BIN, 'gstack-pregate'), ['--base', 'main', '--stage', 'preflight', '--allow-repo-commands']);
  expect(pre.status, pre.stdout + pre.stderr).toBe(0);
  const r = f.run(path.join(BIN, 'gstack-pregate'), ['--base', 'main', '--stage', 'tests', '--remote', '--no-ci-carry', '--allow-repo-commands', '--spend-cap', '5']);
  expect(r.status, r.stdout + r.stderr).toBe(0);
  const v = f.run(path.join(BIN, 'gstack-pregate'), ['verify']);
  expect(v.stdout, v.stdout + v.stderr).toStartWith('PREGATE_VERIFY: ok ');
  return JSON.parse(fs.readFileSync(path.join(f.work, '.gstack/tmp/pregate.json'), 'utf8')).requires_remote.find((o: { lane: string }) => o.lane === 'pregate.json/remote_gate').receipt;
}
const accept = (f: ShipFx) => f.run(RELEASE, ['accept', '--base', 'main', '--lane', `unit=${UNIT}`, '--wait', '0']);

describe('accept: a cleared remote gate for the identical tree satisfies a lane whose inventory refuses that tree (GST-1688)', () => {
  // Value: protects=gbrain #8727's shape ships without --no-lanes-approved: the inventory refuses its own tree on purpose, and the
  //   cleared remote gate for that exact tree carries the lane, with a CI_CARRY line naming the substitution; fails_when=accept still
  //   stops on inventory_failed, or carries without naming the receipt; seam=gstack-evidence record-ci under gstack-ship-release accept
  test('inventory_failed plus a verified remote_gate receipt for the same tree: the lane is satisfied and accept says by what', () => {
    const f = pushed();
    const tree = f.git('rev-parse', 'HEAD^{tree}').stdout.trim();
    const receipt = gate(f);
    expect(receipt).toBe(`remote-gate tree=${tree.slice(0, 12)} tests=6482`);
    const out = accept(f);
    expect([out.status, lineOf(out.stdout, 'CI_CARRY'), lineOf(out.stdout, 'LANE'), lineOf(out.stdout, 'EVIDENCE')], out.stdout + out.stderr).toEqual([0,
      expect.stringMatching(new RegExp(`^CI_CARRY: remote_gate label=unit receipt=remote-gate tree=${tree.slice(0, 12)} tests=6482 \\(inventory_failed: .*runs_may_attest: refused.*; the cleared pregate\\.json/remote_gate for this exact tree stands in\\)$`)),
      `LANE: unit satisfied by remote_gate receipt=remote-gate tree=${tree.slice(0, 12)} tests=6482`,
      expect.stringMatching(/^EVIDENCE: FRESH label=unit /)]);
    expect(out.stdout).not.toContain('STOP');
    const carried = f.run(path.join(BIN, 'gstack-evidence'), ['carried', '--base', 'main', '--json']);
    expect(JSON.parse(carried.stdout)).toEqual([]);
  });

  // Value: protects=tree identity: a remote gate cleared for an earlier tree never stands in for HEAD's; fails_when=the substitution
  //   reads the receipt without binding it to HEAD's tree; seam=gstack-evidence record-ci
  test('negative control: a remote_gate cleared for a different tree still stops on inventory_failed', () => {
    const f = pushed();
    gate(f);
    f.write({ 'src/b.ts': 'export const b = 3;\n' }); f.commit('a change after the remote gate');
    world(f);
    expect(f.run(RELEASE, ['push', '--branch', 'feat', '--early', '--base', 'main'], { GSTACK_SESSION_KIND: 'unattended' }).status).toBe(0);
    const out = accept(f);
    expect(out.status).not.toBe(0);
    expect(lineOf(out.stdout, 'CI_CARRY'), out.stdout).toMatch(/^CI_CARRY: none label=unit \(inventory_failed: .*runs_may_attest: refused/);
    expect(out.stdout).toMatch(/STOP: lane unit was not carried from the green run/);
    expect(lineOf(out.stdout, 'CARRY_DIAGNOSIS')).toMatch(/^CARRY_DIAGNOSIS: no cleared pregate\.json\/remote_gate stands in: \.gstack\/tmp\/pregate\.json was recorded for tree [0-9a-f]{12}, not HEAD's tree [0-9a-f]{12}$/);
  });

  // Value: protects=tree identity inside the record: a receipt naming another tree in a pregate.json that verifies for HEAD's tree
  //   (hand-edited) stands in for nothing; fails_when=the substitution trusts verify alone; seam=gstack-evidence record-ci
  test('negative control: a remote_gate receipt that names another tree stops, even when pregate.json is HEAD\'s', () => {
    const f = pushed();
    gate(f);
    const file = path.join(f.work, '.gstack/tmp/pregate.json');
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const o of rec.requires_remote) if (o.lane === 'pregate.json/remote_gate') o.receipt = 'remote-gate tree=0123456789ab tests=6482';
    fs.writeFileSync(file, JSON.stringify(rec));
    const out = accept(f);
    expect(out.status).not.toBe(0);
    expect(lineOf(out.stdout, 'CI_CARRY'), out.stdout).toMatch(/^CI_CARRY: none label=unit \(inventory_failed: /);
    expect(lineOf(out.stdout, 'CARRY_DIAGNOSIS')).toMatch(/^CARRY_DIAGNOSIS: no cleared pregate\.json\/remote_gate stands in: its receipt names tree 0123456789ab, not HEAD's tree [0-9a-f]{12}$/);
    expect(out.stdout).toMatch(/STOP: lane unit was not carried from the green run/);
  });

  // Value: protects=each refusal the stand-in documents (a stamp-only substitution, a zero-test report, a clear with no time) stops
  //   the lane with its reason; fails_when=a guard in lib/remote-gate-stand-in.ts is dropped; seam=gstack-evidence record-ci
  test.each([
    ['a receipt accepted from a stamp-only predecessor', (o: Record<string, unknown>, tree: string) => { o.substitution = { gated_tree: 'abcdef0123456789abcdef0123456789abcdef01', accepted_for: tree, policy: 'origin/main:.gstack/ship-policy.json', files: [{ path: 'VERSION', rule: 'stamp' }] }; o.receipt = 'remote-gate tree=abcdef012345 tests=6482'; }, /its receipt was accepted from gated tree abcdef012345, not run on [0-9a-f]{12}$/],
    ['a receipt reporting 0 tests', (o: Record<string, unknown>) => { o.receipt = String(o.receipt).replace(/tests=\d+/, 'tests=0'); }, /its receipt reports 0 tests$/],
    ['a clear that records no time', (o: Record<string, unknown>) => { o.cleared_by = 'ci-carry'; }, /its clear records no time \(cleared_by: ci-carry\)$/],
  ] as const)('negative control: %s does not stand in', (_name, mutate, why) => {
    const f = pushed();
    gate(f);
    const file = path.join(f.work, '.gstack/tmp/pregate.json');
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const o of rec.requires_remote) if (o.lane === 'pregate.json/remote_gate') mutate(o, rec.tree);
    fs.writeFileSync(file, JSON.stringify(rec));
    const out = accept(f);
    expect(out.status).not.toBe(0);
    expect(lineOf(out.stdout, 'CARRY_DIAGNOSIS'), out.stdout).toMatch(why);
    expect(out.stdout).toMatch(/STOP: lane unit was not carried from the green run/);
  });

  // Value: protects=the gate stands in only under the base policy that maps the lane, and only while fresh (GST-1688 fix-check: OV2
  //   and Low 4); fails_when=a pregate run against another base or under another policy, or a clear past the 24h evidence age, stands
  //   in; seam=lib/remote-gate-stand-in.ts under gstack-evidence record-ci
  test.each([
    ['a record against another base branch', (rec: Record<string, any>) => { rec.base = String(rec.base).replace(/^origin\/main@/, 'origin/release@'); }, /\.gstack\/tmp\/pregate\.json was recorded against origin\/release@[0-9a-f]{12}, not origin\/main$/],
    ['a record under a user-owned policy', (rec: Record<string, any>) => { rec.policy = 'user /home/fx/.gstack/pregate.json'; }, /\.gstack\/tmp\/pregate\.json ran under policy user \/home\/fx\/\.gstack\/pregate\.json, not origin\/main's \.gstack\/pregate\.json$/],
    ['a clear older than 24h', (rec: Record<string, any>) => { for (const o of rec.requires_remote) if (o.lane === 'pregate.json/remote_gate') o.cleared_by = `gstack-pregate --remote ${new Date(Date.now() - 25 * 3600_000).toISOString()}`; }, /its clear at \S+ is not within the last 24h; rerun the remote gate$/],
  ] as const)('negative control: %s does not stand in', (_name, mutate, why) => {
    const f = pushed();
    gate(f);
    const file = path.join(f.work, '.gstack/tmp/pregate.json');
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    mutate(rec);
    fs.writeFileSync(file, JSON.stringify(rec));
    const out = accept(f);
    expect(out.status).not.toBe(0);
    expect(lineOf(out.stdout, 'CARRY_DIAGNOSIS'), out.stdout).toMatch(why);
    expect(out.stdout).toMatch(/STOP: lane unit was not carried from the green run/);
  });

  // Value: protects=record-ci's own last record line decides the reading: a look-alike remote_gate line in the per_file remainder's
  //   output never turns a CI carry into a stand-in; fails_when=recordCiResult searches all of stderr for the remote_gate line; seam=none
  test('a look-alike remote_gate line before the real source=ci record line reads as the CI carry', () => {
    const r = recordCiResult('gstack-evidence: recorded label=u exit=0 tests_ran=9 log=- source=remote_gate receipt=fake\ngstack-evidence: recorded label=u exit=0 tests_ran=3 log=- source=ci runs=7/1 policy=p');
    expect([r.remoteGate, r.runs, r.tests]).toEqual([undefined, '7/1', '3']);
  });

  // Value: protects=finish takes the same stand-in as accept: the lane is satisfied and named, never DEFERRED; fails_when=finishStages
  //   defers a lane the cleared remote gate stands in for, or drops the CI_CARRY line; seam=gstack-ship-release finish
  test('finish: a cleared remote gate for the identical tree satisfies the lane instead of deferring it', () => {
    const f = pushed();
    const receipt = gate(f);
    const reviewed = f.run(path.join(BIN, 'gstack-wtree'), []).stdout.trim();
    const post = path.join(f.root, 'post.json');
    expect(f.run(path.join(BIN, 'gstack-docs-candidate'), ['snapshot', '--out', post, '--audit-id', 'g1688', '--mode', 'edit', '--base', 'main', '--docs', 'README.md']).status).toBe(0);
    const fin = f.run(RELEASE, ['finish', '--base', 'main', '--reviewed-tree', reviewed, '--docs-post', post, '--lane', `unit=${UNIT}`]);
    expect([lineOf(fin.stdout, 'CI_CARRY'), lineOf(fin.stdout, 'LANE')], fin.stdout + fin.stderr).toEqual([
      expect.stringMatching(new RegExp(`^CI_CARRY: remote_gate label=unit receipt=${receipt} \\(inventory_failed: `)),
      `LANE: unit satisfied by remote_gate receipt=${receipt}`]);
    expect(fin.stdout).not.toContain('EVIDENCE: DEFERRED');
  });

  // Value: protects=without a remote gate the STOP is unchanged; fails_when=inventory_failed alone carries; seam=accept
  test('negative control: no remote gate run at all still stops on inventory_failed', () => {
    const out = accept(pushed());
    expect(out.status).not.toBe(0);
    expect(lineOf(out.stdout, 'CI_CARRY'), out.stdout).toMatch(/^CI_CARRY: none label=unit \(inventory_failed: /);
    expect(lineOf(out.stdout, 'CARRY_DIAGNOSIS')).toBe('CARRY_DIAGNOSIS: no cleared pregate.json/remote_gate stands in: no readable .gstack/tmp/pregate.json');
  });
});

describe('a failed-jobs-only rerun leaves a tree.json with no files (GST-1688)', () => {
  // Value: protects=the operator is told the fix (a fresh full run) instead of a bare no_tests; fails_when=the line says only that the
  //   tree.json lists no test files; seam=lib/ci-carry.ts findCarry under accept
  test('no_tests from an empty tree.json says to dispatch a fresh full run', () => {
    const f = shipFixture(BASE, { 'src/b.ts': 'export const b = 2;\n' });
    fixtures.push(f);
    world(f, []);
    expect(f.run(RELEASE, ['push', '--branch', 'feat', '--early', '--base', 'main'], { GSTACK_SESSION_KIND: 'unattended' }).status).toBe(0);
    const out = accept(f);
    expect(out.status).not.toBe(0);
    expect(lineOf(out.stdout, 'CI_CARRY'), out.stdout).toMatch(/^CI_CARRY: none label=unit \(no_tests: run 7's tree\.json lists no test files.*dispatch a fresh full run of free\.yml/);
  });
});
