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
function world(f: ShipFx, over: { run?: Record<string, unknown>; tree?: Record<string, unknown>; others?: Array<Record<string, unknown>>; jobs?: Array<{ name: string; conclusion: string | null }>; attempts?: Record<string, Array<{ name: string; conclusion: string | null }>> } = {}): void {
  const head = f.git('rev-parse', 'HEAD').stdout.trim();
  const tree = f.git('rev-parse', 'HEAD^{tree}').stdout.trim();
  const run = { id: 7, run_attempt: 1, status: 'completed', conclusion: 'success', event: 'workflow_dispatch', head_sha: head, path: '.github/workflows/free.yml', created_at: at(20), run_started_at: at(20), updated_at: at(5), repository: { full_name: 'fx/fx' }, head_repository: { full_name: 'fx/fx' }, ...over.run };
  const w: FakeWorld = {
    runs: [run, ...((over.others ?? []).map(o => ({ ...run, ...o })))] as FakeWorld['runs'],
    jobs: { 7: (over.jobs ?? [{ name: 'suite', conclusion: 'success' }]).map(j => ({ ...j, completed_at: at(5) })), 9: [{ name: 'suite', conclusion: 'failure', completed_at: at(1) }],
      ...Object.fromEntries(Object.entries(over.attempts ?? {}).map(([k, js]) => [k, js.map(j => ({ ...j, completed_at: at(5) }))])) },
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
    expect(lane(first.stdout, 'free')).toBe('LANE: free carried run=7/1 tests_ran=2 (files)');
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
    expect([ok.status, ok.stderr]).toEqual([0, expect.stringContaining('tests_ran=2 unit=files log=- source=ci runs=7/1 policy=origin/main@')]);
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
    expect(lane(ok.stdout, 'free')).toBe('LANE: free carried run=7/1 tests_ran=2 (files)');
    expect(lineOf(ok.stdout, 'EVIDENCE')).toMatch(/^EVIDENCE: FRESH label=free exit=0 tests_ran=2 unit=files .* source=ci runs=7\/1$/);
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

describe('GST-1186: pregate guards carry like lanes (founderstar shape: guards only, no lanes)', () => {
  // Value: protects=a guard whose exact command the base's ship_lanes_from maps is carried from the verified CI run at this tree, and a guard
  //   whose exact command already passed at this tree in the ledger is reused, so guard-only repos stop rerunning suites CI or /ship already ran;
  //   fails_when=check-quick reruns beside a green CI run, play-through reruns after a same-tree ledger pass, or a dirty tree still carries;
  //   why_new=FOUN-74 (founderstar GST-1184): about 6 minutes of guard suites rerun per /ship; seam=gstack-evidence record-ci and passed; no_claim=CI
  const script = (name: string, tests: number) => `printf x >> ../${name}-runs\nprintf ' ${tests} pass\\n 0 fail\\nRan ${tests} tests across 1 file. [1.00ms]\\n' >&2\n`;
  const CHECK = 'bash tests/check.sh --quick';
  const PLAY = 'bash tests/play-through.sh';
  const guard = (id: string, command: string) => ({ id, when: ['src/**'], command, fix: `rerun ${id}` });
  const FOUNDERSTAR = {
    ...BASE,
    '.gstack/pregate.json': JSON.stringify({ run_profiles: { 'ci/free': PROFILE }, ship_lanes_from: { [CHECK]: { profiles: ['ci/free'], inventory: "printf 'test/a.test.ts\\ntest/b.test.ts\\n'" } },
      guards: [guard('check-quick', CHECK), guard('play-through', PLAY), guard('assets', 'bash tests/assets.sh')] }, null, 2) + '\n',
    'tests/check.sh': script('check', 4), 'tests/play-through.sh': script('play', 2), 'tests/assets.sh': script('assets', 1),
  };
  const guards = (f: ShipFx) => f.run(path.join(BIN, 'gstack-pregate'), ['--only', 'guards', '--allow-repo-commands', '--base', 'main']);
  const counts = (f: ShipFx) => [runs(f, 'check-runs'), runs(f, 'play-runs'), runs(f, 'assets-runs')];

  test('check-quick carries from CI, play-through reuses a same-tree ledger pass, assets runs; a dirty tree carries nothing', () => {
    const f = shipFixture(FOUNDERSTAR); fixtures.push(f);
    world(f);
    const first = guards(f);
    expect(first.status, first.stdout + first.stderr).toBe(0);
    expect(first.stdout).toContain('GUARD: check-quick carried runs=7/1');
    expect(first.stdout).toContain('3 guard(s) passed: check-quick, play-through, assets (1 from an earlier pass at this tree)');
    expect(counts(f)).toEqual([0, 1, 1]);
    expect(f.run(path.join(BIN, 'gstack-evidence'), ['run', '--label', 'play', '--', PLAY]).status).toBe(0);
    const second = guards(f);
    expect(second.status).toBe(0);
    expect(second.stdout).toMatch(/GUARD: play-through reused label=play source=local ts=\S+/);
    expect(counts(f)).toEqual([0, 2, 2]);
    f.write({ 'src/b.ts': 'export const b = 3;\n' });
    const dirty = guards(f);
    expect(dirty.stdout).toMatch(/CI_CARRY: none guard=check-quick \(dirty_tree/);
    expect(dirty.stdout).not.toContain('reused');
    expect(counts(f)).toEqual([1, 3, 3]);
  });
});

describe('GST-1189: a lane carries by named CI jobs instead of an inventory', () => {
  // Value: protects=a ship_lanes_from entry that declares { profiles, jobs } carries only when every named job succeeded in the newest attempt
  //   of the verified run at HEAD's tree, and refuses with a named reason otherwise; fails_when=a typecheck-only lane cannot carry (no test
  //   files to inventory), or carries beside a missing, skipped or older-attempt job, or another tree's run;
  //   why_new=gbrain run 41564913688 (tree 13570abc): verify and typecheck passed in CI but no inventory could name their files; seam=fake gh
  const VERIFY = 'bun run verify';
  const pregateJson = (entry: Record<string, unknown>) => JSON.stringify({ run_profiles: { 'ci/free': PROFILE }, ship_lanes_from: { [VERIFY]: { profiles: ['ci/free'], ...entry } } }, null, 2) + '\n';
  const GBRAIN = { ...BASE, '.gstack/pregate.json': pregateJson({ jobs: ['verify', 'typecheck'] }) };
  const ALL = [{ name: 'suite', conclusion: 'success' }, { name: 'verify', conclusion: 'success' }, { name: 'typecheck', conclusion: 'success' }];
  const NO_FILES = { files: [], tests: 0 };
  const gbrain = () => { const f = shipFixture(GBRAIN); fixtures.push(f); return f; };
  const find = (f: ShipFx) => f.run(path.join(BIN, 'gstack-ci-carry'), ['find', '--base', 'main', '--command', VERIFY, '--allow-repo-commands']);

  test('every named job green at the same tree carries, with no test files; record-ci records the jobs', () => {
    const f = gbrain();
    world(f, { jobs: ALL, tree: NO_FILES });
    const ok = find(f);
    expect([ok.status, ok.stdout]).toEqual([0, expect.stringMatching(/^CI_CARRY: accepted ci-carry tree=[0-9a-f]{12} jobs=verify,typecheck runs=7\/1 profiles=ci\/free /m)]);
    const rec = f.run(path.join(BIN, 'gstack-evidence'), ['record-ci', '--label', 'verify', '--base', 'main', '--', VERIFY]);
    expect([rec.status, rec.stderr]).toEqual([0, expect.stringContaining('tests_ran=n/a log=- source=ci runs=7/1')]);
    const row = JSON.parse(fs.readFileSync(findFilesBySuffix(path.join(f.state, 'projects'), '-evidence.jsonl')[0]!, 'utf8').trim().split('\n').at(-1)!);
    expect([row.jobs, row.tests_ran]).toEqual([['verify', 'typecheck'], 'n/a']);
  });

  test('a missing job refuses as job_missing', () => {
    const f = gbrain();
    world(f, { jobs: ALL.filter(j => j.name !== 'typecheck'), tree: NO_FILES });
    expect(find(f).stdout).toContain('CI_CARRY: none (no_verified_run: ci/free: run 7: job_missing)');
  });

  test('a skipped job refuses as job_skipped', () => {
    const f = gbrain();
    world(f, { jobs: ALL.map(j => j.name === 'typecheck' ? { ...j, conclusion: 'skipped' } : j), tree: NO_FILES });
    const r = find(f);
    expect([r.status, r.stdout]).toEqual([1, expect.stringContaining('CI_CARRY: none (no_verified_run: ci/free: run 7: job_skipped)')]);
  });

  test('only the newest attempt counts: a rerun that passed carries, a rerun that skipped the job does not', () => {
    const f = gbrain();
    const failedFirst = ALL.map(j => j.name === 'typecheck' ? { ...j, conclusion: 'failure' } : j);
    world(f, { run: { run_attempt: 2 }, tree: { ...NO_FILES, run_attempt: 2 }, attempts: { '7/1': failedFirst, '7/2': ALL } });
    expect(find(f).stdout).toMatch(/^CI_CARRY: accepted ci-carry tree=[0-9a-f]{12} jobs=verify,typecheck runs=7\/2 /m);
    world(f, { run: { run_attempt: 2 }, tree: { ...NO_FILES, run_attempt: 2 }, attempts: { '7/1': ALL, '7/2': ALL.map(j => j.name === 'typecheck' ? { ...j, conclusion: 'skipped' } : j) } });
    expect(find(f).stdout).toContain('CI_CARRY: none (no_verified_run: ci/free: run 7: job_skipped)');
  });

  test('a run that tested another tree refuses as tree_mismatch', () => {
    const f = gbrain();
    world(f, { jobs: ALL, tree: { ...NO_FILES, tree: '1'.repeat(40) } });
    expect(find(f).stdout).toContain('CI_CARRY: none (no_verified_run: ci/free: run 7: tree_mismatch)');
  });

  test('an entry declares exactly one of inventory or jobs', () => {
    const both = shipFixture({ ...BASE, '.gstack/pregate.json': pregateJson({ jobs: ['verify'], inventory: 'printf x' }) }); fixtures.push(both);
    world(both, { jobs: ALL, tree: NO_FILES });
    expect(find(both).stdout).toContain('CI_CARRY: none (profiles_unavailable');
    const neither = shipFixture({ ...BASE, '.gstack/pregate.json': pregateJson({}) }); fixtures.push(neither);
    world(neither, { jobs: ALL, tree: NO_FILES });
    expect(find(neither).stdout).toContain('CI_CARRY: none (profiles_unavailable');
  });
});

describe('GST-1190: aliases, newer-gstack keys, narrow counts, and proving a mapping without carrying it', () => {
  // Value: protects=a lane carries under an exact alias the base declares (never an implicit env-prefix rewrite); a narrow lane never reports
  //   the whole run's test count; an unknown key under a project floor above this gstack says to upgrade; --simulate proves a head map while
  //   writing and clearing nothing; carried never lists a row another base's policy mapped;
  //   fails_when=an env-prefixed lane reruns beside a green run, a 46-test lane records 9677, a proof run's rows land in the PR's own receipt,
  //   or a branch's own map carries; why_new=HARN-7 (harness-evals #240), ALPH-14 (alphaclaw #310), GEVA-235 (gstack-evals #180), GGST-15; seam=fake gh
  const ev = (f: ShipFx, args: string[]) => f.run(path.join(BIN, 'gstack-evidence'), args);
  const ledger = (f: ShipFx) => fs.existsSync(path.join(f.state, 'projects')) ? findFilesBySuffix(path.join(f.state, 'projects'), '-evidence.jsonl') : [];
  const ALL = [{ name: 'suite', conclusion: 'success' }, { name: 'typecheck', conclusion: 'success' }];

  test('a declared alias carries like its key; an undeclared env prefix does not', () => {
    const TESTS = 'bun test tests/';
    const ALIAS = 'env -u ANTHROPIC_API_KEY bun test tests/';
    const f = shipFixture({ ...BASE, '.gstack/pregate.json': JSON.stringify({ run_profiles: { 'ci/free': PROFILE }, ship_lanes_from: { [TESTS]: { profiles: ['ci/free'], inventory: "printf 'test/a.test.ts\\n'", aliases: [ALIAS] } } }) + '\n' }); fixtures.push(f);
    world(f);
    const rec = ev(f, ['record-ci', '--label', 'tests', '--base', 'main', '--', ALIAS]);
    expect([rec.status, rec.stderr]).toEqual([0, expect.stringContaining('tests_ran=1 unit=files log=- source=ci runs=7/1')]);
    const find = (command: string) => f.run(path.join(BIN, 'gstack-ci-carry'), ['find', '--base', 'main', '--command', command, '--allow-repo-commands']).stdout;
    expect(find(ALIAS)).toMatch(/^CI_CARRY: accepted ci-carry tree=[0-9a-f]{12} files=1 /m);
    expect(find('env -i HOME=/tmp bun test tests/')).toContain('CI_CARRY: none (not_mapped');
  });

  test('an alias that repeats a key is invalid config', () => {
    const f = shipFixture({ ...BASE, '.gstack/pregate.json': JSON.stringify({ run_profiles: { 'ci/free': PROFILE }, ship_lanes_from: { a: { profiles: ['ci/free'], jobs: ['suite'] }, b: { profiles: ['ci/free'], jobs: ['suite'], aliases: ['a'] } } }) + '\n' }); fixtures.push(f);
    world(f);
    expect(f.run(path.join(BIN, 'gstack-ci-carry'), ['find', '--base', 'main']).stdout).toContain('CI_CARRY: none (profiles_unavailable');
  });

  test('a carried narrow lane counts its covered inventory files, never the run total (alphaclaw: 46 tests recorded as 9677)', () => {
    const f = fx();
    world(f, { tree: { files: ['test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts'], tests: 9677 } });
    const rec = ev(f, ['record-ci', '--label', 'guards', '--base', 'main', '--', FREE]);
    expect([rec.status, rec.stderr]).toEqual([0, expect.stringContaining('tests_ran=2 unit=files log=- source=ci')]);
    expect(rec.stderr).not.toContain('9677');
  });

  test('a jobs-mapped guard carries in the guards stage (harness-evals: bunx tsc --noEmit) and reports n/a', () => {
    const TSC = 'bunx tsc --noEmit';
    const f = shipFixture({ ...BASE, '.gstack/pregate.json': JSON.stringify({ run_profiles: { 'ci/free': PROFILE }, ship_lanes_from: { [TSC]: { profiles: ['ci/free'], jobs: ['typecheck'] } }, guards: [{ id: 'typecheck', when: ['src/**'], command: TSC, fix: 'bunx tsc --noEmit' }] }) + '\n' }); fixtures.push(f);
    world(f, { jobs: ALL, tree: { files: [], tests: 0 } });
    const g = f.run(path.join(BIN, 'gstack-pregate'), ['--only', 'guards', '--allow-repo-commands', '--base', 'main']);
    expect([g.status, g.stdout]).toEqual([0, expect.stringContaining('GUARD: typecheck carried runs=7/1')]);
    const row = JSON.parse(fs.readFileSync(ledger(f)[0]!, 'utf8').trim().split('\n').at(-1)!);
    expect([row.tests_ran, row.jobs]).toEqual(['n/a', ['typecheck']]);
  });

  test('an unknown key under a project floor above this gstack says to upgrade; without the floor it stays the generic error', () => {
    const conf = JSON.stringify({ future_lanes: {} }) + '\n';
    const floor = shipFixture({}, { '.gstack/pregate.json': conf, '.gstack/ship-policy.json': JSON.stringify({ min_gstack_version: '99.0.0.0' }) + '\n' }); fixtures.push(floor);
    const newer = floor.run(path.join(BIN, 'gstack-pregate'), ['validate']);
    expect(newer.status).not.toBe(0);
    expect(newer.stderr).toContain('needs gstack >= 99.0.0.0; upgrade');
    expect(newer.stderr).toContain('(PREGATE_GSTACK_TOO_OLD)');
    const plain = shipFixture({}, { '.gstack/pregate.json': conf }); fixtures.push(plain);
    const typo = plain.run(path.join(BIN, 'gstack-pregate'), ['validate']);
    expect([typo.stderr.includes('(PREGATE_CONFIG_INVALID)'), typo.stderr.includes('needs gstack')]).toEqual([true, false]);
  });

  test('--simulate proves the branch map: every line says SIMULATION, nothing is written, nothing clears, and head policy never carries', () => {
    const VERIFY = 'bun run verify';
    const head = JSON.stringify({ run_profiles: { 'ci/free': PROFILE }, ship_lanes_from: { [VERIFY]: { profiles: ['ci/free'], jobs: ['typecheck'] } } }) + '\n';
    const f = shipFixture({ '.github/workflows/free.yml': BASE['.github/workflows/free.yml'] }, { '.gstack/pregate.json': head }); fixtures.push(f);
    world(f, { jobs: ALL, tree: { files: [], tests: 0 } });
    const sim = f.run(PREFLIGHT, ['--tests-only', '--base', 'main', '--policy-from', 'head', '--simulate', '--lane', `verify=${VERIFY}`, '--lane', `unit=${UNIT}`]);
    const lines = sim.stdout.trim().split('\n');
    expect(lines.every(l => l.startsWith('SIMULATION: ')), sim.stdout + sim.stderr).toBe(true);
    expect(sim.stdout).toContain('SIMULATION: LANE: verify would carry run=7/1 tests_ran=n/a');
    expect(sim.stdout).toContain('SIMULATION: LANE: unit not mapped');
    expect([ledger(f), runs(f, 'unit-runs'), fs.existsSync(path.join(f.work, '.gstack', 'tmp', 'pregate.json'))]).toEqual([[], 0, false]);
    expect(JSON.parse(ev(f, ['carried', '--json']).stdout)).toEqual([]);
    const real = ev(f, ['record-ci', '--label', 'verify', '--base', 'main', '--', VERIFY]);
    expect([real.status, real.stderr]).toEqual([1, expect.stringMatching(/^CARRY_NONE: not_mapped: /m)]);
    expect(f.run(PREFLIGHT, ['--tests-only', '--base', 'main', '--simulate', '--lane', `verify=${VERIFY}`]).status).toBe(2);
  });

  test('carried lists only rows the receipt base mapped: a proof run against the PR branch never reaches its receipt', () => {
    const f = fx();
    expect(f.git('push', '-q', 'origin', 'feat').status).toBe(0);
    world(f);
    expect(ev(f, ['record-ci', '--label', 'free', '--base', 'feat', '--', FREE]).status).toBe(0);
    expect(JSON.parse(ev(f, ['carried', '--base', 'main', '--json']).stdout)).toEqual([]);
    expect(JSON.parse(ev(f, ['carried', '--base', 'feat', '--json']).stdout)).toEqual([expect.objectContaining({ lane: 'free', run: 7, attempt: 1 })]);
    expect(JSON.parse(ev(f, ['carried', '--json']).stdout)).toEqual([]);
  });
});

describe('GST-1190: a file whose every test skipped on CI is not carried', () => {
  // Value: protects=a lane never carries a test file that ran nothing on the CI runner (Docker images, drive paths, an installed gstack), so
  //   those tests run here instead of silently dropping; a partly skipped file and an older tree.json without skipped_files carry as before;
  //   fails_when=harness-evals' 75 runner-skipped tests carry as passed; why_new=HARN-7 (harness-evals #240); seam=fake gh
  test('a fully skipped inventory file runs the lane here; a partly skipped one (not listed) and an older tree.json still carry', () => {
    const f = fx();
    world(f, { tree: { skipped_files: ['test/b.test.ts'] } });
    const rec = f.run(path.join(BIN, 'gstack-evidence'), ['record-ci', '--label', 'free', '--base', 'main', '--', FREE]);
    expect([rec.status, rec.stderr]).toEqual([1, expect.stringMatching(/^CARRY_NONE: inventory_uncovered: 1 of 2 inventory file\(s\) are in no run's tree\.json or skipped every test there \(1 skipped_files\): test\/b\.test\.ts$/m)]);
    const out = preflight(f, [`free=${FREE}`]);
    expect(out.stdout).toContain('CI_CARRY: none label=free (inventory_uncovered');
    expect(runs(f, 'free-runs')).toBe(1);
    world(f, { tree: { skipped_files: [] } });
    expect(f.run(path.join(BIN, 'gstack-evidence'), ['record-ci', '--label', 'free', '--base', 'main', '--', FREE]).status).toBe(0);
    world(f, { tree: { skipped_files: 'test/b.test.ts' } });
    expect(f.run(path.join(BIN, 'gstack-ci-carry'), ['find', '--base', 'main', '--command', FREE, '--allow-repo-commands']).stdout).toContain('artifact_mismatch');
  });

  test('the tests stage runs a selected file the run skipped entirely, and accepts the rest', () => {
    const conf = JSON.stringify({ runner: 'bun test {files}', dependencies: { 'src/**': ['test/a.test.ts', 'test/b.test.ts'] }, run_profiles: { 'ci/free': PROFILE } }) + '\n';
    const t = "import { test, expect } from 'bun:test';\ntest('x', () => expect(1).toBe(1));\n";
    const f = shipFixture({ ...BASE, '.gstack/pregate.json': conf, 'test/a.test.ts': t, 'test/b.test.ts': t }); fixtures.push(f);
    const stage = () => f.run(path.join(BIN, 'gstack-pregate'), ['--stage', 'tests', '--allow-repo-commands', '--base', 'main']);
    world(f, { tree: { skipped_files: ['test/b.test.ts'] } });
    const skipped = stage();
    expect(skipped.stdout + skipped.stderr).toMatch(/REUSE: accepted 1 of 2 selected local test file\(s\) from run .*; 1 still run \(1 skipped every test in the run\)/);
    world(f);
    expect(stage().stdout + stage().stderr).toMatch(/REUSE: accepted 2 of 2 selected local test file\(s\) from run .*; 0 still run/);
  });
});
