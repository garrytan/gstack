/**
 * CI-carried lanes end to end (GSTA-258 pieces 1, 2 and 4; design fixes A1-A4): gstack-ship-preflight, gstack-ship-release
 * finish, push --early and accept, gstack-pregate's automatic --from-run and gstack-ci-carry, against a fixture repository
 * whose gh is a fake serving one Actions world, so nothing reaches GitHub.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fakeGhScript, type FakeWorld } from './helpers/fake-gh-runs';
import { findFilesBySuffix } from './helpers/scratch-repo';
import { lineOf, PREFLIGHT, RELEASE, shipFixture, type ShipFx } from './helpers/ship-bin-fixture';

setDefaultTimeout(120_000);
const BIN = path.dirname(RELEASE);
const fixtures: ShipFx[] = [];
afterEach(() => { while (fixtures.length) fixtures.pop()!.cleanup(); });

const FREE = "printf x >> ../free-runs; printf ' 3 pass\\n 0 fail\\nRan 3 tests across 1 file. [1.00ms]\\n' >&2";
const UNIT = "printf x >> ../unit-runs; printf ' 2 pass\\n 0 fail\\nRan 2 tests across 1 file. [1.00ms]\\n' >&2";
const PROFILE = { workflow: 'free.yml', events: ['pull_request', 'workflow_dispatch'], jobs: ['suite'], artifact: 'tested-tree', os: 'Linux' };
const BASE = {
  '.gstack/pregate.json': JSON.stringify({ run_profiles: { 'ci/free': PROFILE }, ship_lanes_from: { [FREE]: { profiles: ['ci/free'], inventory: "printf 'test/a.test.ts\\ntest/b.test.ts\\n'" } } }, null, 2) + '\n',
  '.github/workflows/free.yml': 'name: Free\non: [pull_request, workflow_dispatch]\njobs:\n  suite:\n    runs-on: ubuntu-latest\n    steps:\n      - run: bun test\n',
};
const fx = () => { const f = shipFixture(BASE); fixtures.push(f); return f; };
const runs = (f: ShipFx, name: string) => { const p = path.join(f.root, name); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').length : 0; };
const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

/** One run of free.yml at HEAD (id 7 unless named), green with a tree.json naming HEAD's tree, unless overridden. */
function world(f: ShipFx, over: { run?: Record<string, unknown>; tree?: Record<string, unknown>; others?: Array<Record<string, unknown>>; jobs?: Array<{ name: string; conclusion: string | null }> } = {}): void {
  const head = f.git('rev-parse', 'HEAD').stdout.trim();
  const tree = f.git('rev-parse', 'HEAD^{tree}').stdout.trim();
  const run = { id: 7, run_attempt: 1, status: 'completed', conclusion: 'success', event: 'workflow_dispatch', head_sha: head, path: '.github/workflows/free.yml', created_at: at(20), run_started_at: at(20), updated_at: at(5), repository: { full_name: 'fx/fx' }, head_repository: { full_name: 'fx/fx' }, ...over.run };
  const w: FakeWorld = {
    runs: [run, ...((over.others ?? []).map(o => ({ ...run, ...o })))] as FakeWorld['runs'],
    jobs: { 7: (over.jobs ?? [{ name: 'suite', conclusion: 'success' }]).map(j => ({ ...j, completed_at: at(5) })), 9: [{ name: 'suite', conclusion: 'failure', completed_at: at(1) }] },
    trees: { 7: { run_id: 7, run_attempt: 1, event: 'workflow_dispatch', sha: head, tree, files: ['test/a.test.ts', 'test/b.test.ts'], tests: 12, os: 'Linux', ...over.tree } },
  };
  const file = path.join(f.root, 'world.json');
  fs.writeFileSync(file, JSON.stringify(w));
  f.gh(fakeGhScript(file));
}
const preflight = (f: ShipFx, lanes = [`free=${FREE}`, `unit=${UNIT}`]) => f.run(PREFLIGHT, ['--tests-only', '--base', 'main', ...lanes.flatMap(l => ['--lane', l])]);
const lane = (out: string, label: string) => out.split('\n').find(l => l.startsWith(`LANE: ${label} `)) ?? '';

describe('Step 5 lanes: CI carry and the tree cache', () => {
  // Value: protects=a lane the base maps is carried from CI at this exact tree and never runs; any other lane runs once and is reused at the same tree;
  //   fails_when=the free suite reruns locally beside a green CI run, or a passed lane reruns at an unchanged tree; why_new=GSTA-258 pieces 1-2; seam=fake gh, gstack-evidence ledger
  test('the mapped lane is carried from the green run; the other lane runs once, then is reused', () => {
    const f = fx();
    world(f);
    const first = preflight(f);
    expect(first.status).toBe(0);
    expect(lane(first.stdout, 'free')).toBe('LANE: free carried run=7/1 tests_ran=12');
    expect(lane(first.stdout, 'unit')).toMatch(/^LANE: unit pass exit=0 tests_ran=2 log=\S+$/);
    expect([runs(f, 'free-runs'), runs(f, 'unit-runs')]).toEqual([0, 1]);
    const again = preflight(f);
    expect(lane(again.stdout, 'unit')).toMatch(/^LANE: unit pass exit=0 tests_ran=2 log=\S+ reused=\S+$/);
    expect([runs(f, 'free-runs'), runs(f, 'unit-runs')]).toEqual([0, 1]);
    const chk = f.run(path.join(BIN, 'gstack-evidence'), ['check', '--label', 'free', '--expect-cmd', FREE]);
    expect(chk.stdout).toContain('source=ci runs=7/1');
  });

  // Value: protects=A2/A3 and verifyRun's refusals: a dirty tree, an uncovered inventory, a fork run and a newer red run never carry, and a label alone never maps;
  //   fails_when=any of them carries; seam=lib/ci-carry.ts findCarry through runLanes
  test('a dirty tree, an uncovered inventory, a fork run, a newer red run or a changed command runs the lane here', () => {
    const f = fx();
    const cases: Array<[string, () => void, string[]?]> = [
      ['dirty_tree', () => { world(f); f.write({ 'src/b.ts': 'export const b = 3;\n' }); }],
      ['inventory_uncovered', () => { f.git('checkout', '--', 'src/b.ts'); world(f, { tree: { files: ['test/a.test.ts'] } }); }],
      ['fork_run', () => world(f, { run: { head_repository: { full_name: 'evil/fx' } } })],
      ['newer_run_vetoes', () => world(f, { others: [{ id: 9, conclusion: 'failure', created_at: at(2), run_started_at: at(2) }] })],
    ];
    let expected = 0;
    for (const [reason, setup] of cases) {
      setup();
      const out = preflight(f, [`free=${FREE}`]).stdout;
      expect([reason, out]).toEqual([reason, expect.stringContaining('CI_CARRY: none label=free (')]);
      expect(out).toContain(reason);
      expect(lane(out, 'free')).toMatch(/^LANE: free pass exit=0 tests_ran=3 /);
      expected += lane(out, 'free').includes('reused=') ? 0 : 1;
      expect(runs(f, 'free-runs')).toBe(expected);
    }
    world(f);
    const other = preflight(f, [`free=${FREE} `]).stdout;
    expect(other).not.toContain('CI_CARRY');
    expect(lane(other, 'free')).not.toContain('carried');
  });

  // Value: protects=a CI-sourced ledger row exists only for a run gstack-evidence record-ci found and verified itself (/ship pass 1 red-team#1);
  //   fails_when=caller-supplied run ids, test counts or a tree make a FRESH carried row, or an unmapped command or a missing run records one; seam=fake gh
  test('record-ci verifies the run itself: forged facts, an unmapped command or no run at HEAD record nothing', () => {
    const f = fx();
    const ev = (args: string[]) => f.run(path.join(BIN, 'gstack-evidence'), args);
    const forged = ev(['record-ci', '--label', 'free', '--runs', '1/1', '--profiles', 'anything', '--tree', f.git('rev-parse', 'HEAD^{tree}').stdout.trim(), '--tests', '999', '--finished', at(1), '--', FREE]);
    expect(forged.status).toBe(2);
    world(f, { run: { head_sha: '0'.repeat(40) } });
    const noRun = ev(['record-ci', '--label', 'free', '--base', 'main', '--', FREE]);
    expect([noRun.status, noRun.stderr]).toEqual([1, expect.stringMatching(/^CARRY_NONE: no_run: /m)]);
    world(f);
    const unmapped = ev(['record-ci', '--label', 'free', '--base', 'main', '--', 'bun run test']);
    expect([unmapped.status, unmapped.stderr]).toEqual([1, expect.stringMatching(/^CARRY_NONE: not_mapped: /m)]);
    expect(ev(['check', '--label', 'free', '--expect-cmd', FREE]).stdout).not.toContain('EVIDENCE: FRESH');
    expect(JSON.parse(ev(['carried', '--json']).stdout)).toEqual([]);
    const ok = ev(['record-ci', '--label', 'free', '--base', 'main', '--', FREE]);
    expect([ok.status, ok.stderr]).toEqual([0, expect.stringContaining('tests_ran=12 log=- source=ci runs=7/1 policy=origin/main@')]);
    const row = JSON.parse(fs.readFileSync(findFilesBySuffix(path.join(f.state, 'projects'), '-evidence.jsonl')[0]!, 'utf8').trim().split('\n').at(-1)!);
    expect(row.policy).toMatch(/^origin\/main@[0-9a-f]{12}:\.gstack\/pregate\.json$/);
  });
});

describe('finish, push --early and accept (A1)', () => {
  const finishArgs = (f: ShipFx, reviewed: string, post: string) => ['finish', '--base', 'main', '--reviewed-tree', reviewed, '--docs-post', post, '--lane', `free=${FREE}`];
  const snapshot = (f: ShipFx) => {
    const out = path.join(f.root, 'post.json');
    expect(f.run(path.join(BIN, 'gstack-docs-candidate'), ['snapshot', '--out', out, '--audit-id', 'a1', '--mode', 'edit', '--base', 'main', '--docs', 'README.md']).status).toBe(0);
    return out;
  };
  const unattended = { GSTACK_SESSION_KIND: 'unattended' };

  // Value: protects=finish never runs a mapped lane locally on the stamped tree: it defers it to accept and runs only pregate's preflight stage; accept carries
  //   it from the green run at the pushed head and reruns the pregate there; fails_when=the stamped tree reruns the suite, or accept trusts a run at another tree;
  //   why_new=design fix A1; seam=fake gh, gstack-evidence, gstack-pregate
  test('finish defers the mapped lane; accept carries it from the green run at the pushed head', () => {
    const f = fx();
    world(f);
    const reviewed = f.run(path.join(BIN, 'gstack-wtree'), []).stdout.trim();
    expect(f.run(RELEASE, ['version', '--base', 'main', '--bump', 'micro']).status).toBe(0);
    const post = snapshot(f);
    const pregateFile = path.join(f.work, '.gstack/tmp/pregate.json');
    const before = fs.existsSync(pregateFile) ? fs.readFileSync(pregateFile, 'utf8') : null;
    const fin = f.run(RELEASE, finishArgs(f, reviewed, post));
    expect(fin.stdout).toMatch(/^EVIDENCE: DEFERRED label=free \(/m);
    expect(lineOf(fin.stdout, 'PREGATE')).toMatch(/^PREGATE: preflight (pass|warn) on the stamped tree/);
    expect(fs.existsSync(pregateFile) ? fs.readFileSync(pregateFile, 'utf8') : null).toBe(before);
    expect(fin.stdout).toContain('gstack-ship-release accept --base main --lane');
    expect(fin.status).toBe(0);
    expect(runs(f, 'free-runs')).toBe(0);
    const notPushed = f.run(RELEASE, ['accept', '--base', 'main', '--lane', `free=${FREE}`, '--wait', '0']);
    expect(notPushed.stdout).toContain('is not origin/feat: run gstack-ship-release push first');
    const push = f.run(RELEASE, ['push', '--branch', 'feat', '--early', '--base', 'main'], unattended);
    expect(lineOf(push.stdout, 'SECRETS')).toMatch(/^SECRETS: (pass|warn) \(early push\)$/);
    expect(lineOf(push.stdout, 'PUSH')).toMatch(/^PUSH: pushed /);
    world(f, { run: { status: 'in_progress', conclusion: null } });
    const running = f.run(RELEASE, ['accept', '--base', 'main', '--lane', `free=${FREE}`, '--wait', '0']);
    expect(running.status).toBe(3);
    expect(running.stdout).toContain('CI_WAIT: running ci/free run=7/1');
    world(f, { run: { conclusion: 'failure' }, jobs: [{ name: 'suite', conclusion: 'failure' }] });
    const red = f.run(RELEASE, ['accept', '--base', 'main', '--lane', `free=${FREE}`, '--wait', '0']);
    expect(red.stdout).toContain('STOP: free.yml run 7 failed (suite)');
    world(f);
    const ok = f.run(RELEASE, ['accept', '--base', 'main', '--lane', `free=${FREE}`, '--wait', '0']);
    expect(ok.stdout).toContain('CI_WAIT: green ci/free run=7/1');
    expect(lane(ok.stdout, 'free')).toBe('LANE: free carried run=7/1 tests_ran=12');
    expect(lineOf(ok.stdout, 'EVIDENCE')).toMatch(/^EVIDENCE: FRESH label=free exit=0 tests_ran=12 .* source=ci runs=7\/1$/);
    expect(ok.stdout).toContain('CI_CARRY: accepted ci-carry tree=');
    expect(ok.stdout).toContain('NEXT: Step 18');
    expect(ok.status).toBe(0);
    expect(runs(f, 'free-runs')).toBe(0);
    const carried = JSON.parse(f.run(path.join(BIN, 'gstack-evidence'), ['carried', '--json']).stdout);
    expect(carried).toEqual([{ lane: 'free', run: 7, attempt: 1, tree: f.git('rev-parse', 'HEAD^{tree}').stdout.trim() }]);
  });
});

describe('gstack-pregate tests stage and gstack-ci-carry', () => {
  // Value: protects=the tests stage carries CI at HEAD's clean tree on its own, and --no-ci-carry or a dirty tree turns it off; fails_when=pregate reruns what CI ran, or carries a dirty tree;
  //   why_new=GSTA-258 piece 1; seam=fake gh; no_claim=a small machine's remote gate obligation (covered by from-run's tests)
  test('the tests stage accepts the run on its own, and --no-ci-carry or a dirty tree does not', () => {
    const f = fx();
    world(f);
    const pregate = (extra: string[] = []) => f.run(path.join(BIN, 'gstack-pregate'), ['--stage', 'tests', '--allow-repo-commands', '--base', 'main', ...extra]);
    expect(pregate().stderr).toMatch(/^CI_CARRY: accepted ci-carry tree=[0-9a-f]{12} tests=12 runs=7\/1 profiles=ci\/free /m);
    expect(pregate(['--no-ci-carry']).stderr).not.toContain('CI_CARRY');
    f.write({ 'scratch.txt': 'x\n' });
    expect(pregate().stderr).toContain('CI_CARRY: none (dirty_tree');
  });

  // Value: protects=the CLI finds and waits on the same evidence; fails_when=find or wait accepts a red run or prints no verdict
  test('gstack-ci-carry find and wait', () => {
    const f = fx();
    world(f);
    const cli = (args: string[]) => f.run(path.join(BIN, 'gstack-ci-carry'), args);
    const found = cli(['find', '--base', 'main']);
    expect([found.status, found.stdout]).toEqual([0, expect.stringMatching(/^CI_CARRY: accepted ci-carry tree=/)]);
    const mapped = cli(['find', '--base', 'main', '--command', FREE, '--allow-repo-commands']);
    expect(mapped.status).toBe(0);
    expect(cli(['find', '--base', 'main', '--command', 'bun run test', '--allow-repo-commands']).stdout).toContain('CI_CARRY: none (not_mapped');
    expect(cli(['wait', '--base', 'main', '--timeout', '0']).stdout).toContain('CI_WAIT: green ci/free run=7/1');
    world(f, { run: { conclusion: 'failure' }, jobs: [{ name: 'suite', conclusion: 'failure' }] });
    const red = cli(['wait', '--base', 'main', '--timeout', '0']);
    expect([red.status, red.stdout.trim()]).toEqual([1, 'CI_WAIT: red ci/free run=7/1 failing=suite']);
    expect(cli(['bogus']).status).toBe(2);
  });
});
