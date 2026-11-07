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
    trees: { 7: { run_id: 7, run_attempt: 1, event: run.event, sha: head, ...(run.event === 'pull_request' ? { head_sha: head } : {}), tree, files: ['test/a.test.ts', 'test/b.test.ts'], tests: 12, os: 'Linux', ...over.tree } },
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
  test('accept checks a carried lane under the label it was recorded with: spaces and colons (TRUT-7)', () => {
    const f = fx();
    world(f);
    expect(f.run(RELEASE, ['push', '--branch', 'feat', '--early', '--base', 'main'], unattended).status).toBe(0);
    for (const label of ['pnpm lint', 'db:test']) {
      const ok = f.run(RELEASE, ['accept', '--base', 'main', '--lane', `${label}=${FREE}`, '--wait', '0']);
      expect([ok.status, ok.stdout], label).toEqual([0, expect.not.stringContaining('not FRESH')]);
      expect(ok.stdout).toMatch(/^EVIDENCE: FRESH /m);
    }
    for (const label of ['pnpm lint', 'db:test']) expect(f.run(path.join(BIN, 'gstack-evidence'), ['check', '--label', label]).stdout).toMatch(/^EVIDENCE: FRESH /m);
  });

  test('a carried row that no longer grades FRESH leaves no ci_carried entry (TRUT-7: pnpm lint)', () => {
    const f = fx();
    world(f);
    expect(f.run(RELEASE, ['push', '--branch', 'feat', '--early', '--base', 'main'], unattended).status).toBe(0);
    expect(f.run(RELEASE, ['accept', '--base', 'main', '--lane', `pnpm lint=${FREE}`, '--wait', '0']).status).toBe(0);
    const carried = () => JSON.parse(f.run(path.join(BIN, 'gstack-evidence'), ['carried', '--base', 'main', '--json']).stdout);
    expect(carried()).toEqual([expect.objectContaining({ lane: 'pnpm_lint', run: 7, attempt: 1 })]);
    const [ledger] = findFilesBySuffix(path.join(f.state, 'projects'), '-evidence.jsonl');
    const rows = fs.readFileSync(ledger!, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    fs.writeFileSync(ledger!, rows.map(r => JSON.stringify(r.source === 'ci' ? { ...r, ts: at(30 * 60) } : r)).join('\n') + '\n');
    expect(f.run(path.join(BIN, 'gstack-evidence'), ['check', '--label', 'pnpm lint', '--max-age', '24']).stdout).toMatch(/^EVIDENCE: STALE .* reason=older than 24h/m);
    expect(carried()).toEqual([]);
  });

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

  test('a pull_request run whose base moved names the one-command fix (TRUT-7)', () => {
    const f = gbrain();
    const mergeTree = f.git('rev-parse', 'origin/main^{tree}').stdout.trim();
    const merge = f.git('commit-tree', mergeTree, '-p', 'HEAD', '-p', 'origin/main', '-m', 'Merge origin/main into feat').stdout.trim();
    world(f, { jobs: ALL, run: { event: 'pull_request', head_branch: 'feat' }, tree: { ...NO_FILES, tree: mergeTree, sha: merge } });
    expect(find(f).stdout).toContain("CI_CARRY: none (no_verified_run: ci/free: run 7: tree_mismatch (the pull request's base moved after the run; fix: gh workflow run free.yml --ref feat, then gstack-ci-carry wait))");
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
    expect([rec.status, rec.stderr]).toEqual([1, expect.stringMatching(/^CARRY_NONE: inventory_skipped: 1 of 2 inventory file\(s\) skipped every test in CI and the lane declares no per_file runner: test\/b\.test\.ts$/m)]);
    const out = preflight(f, [`free=${FREE}`]);
    expect(out.stdout).toContain('CI_CARRY: none label=free (inventory_skipped');
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

describe('GST-1190: a path-skipped CI job counts only under an unchanged gate', () => {
  // Value: protects=a lane whose CI job the workflow skipped by path is not owed only when the gate job that decided the skip succeeded and the
  //   workflow and the gate's scripts are byte-identical to origin/<base>; otherwise the branch controlled the skip and the lane runs here;
  //   fails_when=a branch edits the workflow or the gate script to skip its own typecheck and the lane still passes; why_new=TRUT-7 (truther #1169); seam=fake gh
  const TSC = 'bunx tsc --noEmit';
  const SKIP_PROFILE = { ...PROFILE, jobs: ['suite'], skippable: { jobs: ['typecheck'], gate: 'changes', scripts: ['scripts/changes.sh'] } };
  const WORKFLOW = 'name: Free\non: [pull_request, workflow_dispatch]\njobs:\n  changes:\n    runs-on: ubuntu-latest\n    steps:\n      - run: bash scripts/changes.sh\n  suite:\n    runs-on: ubuntu-latest\n    steps:\n      - run: bun test\n  typecheck:\n    needs: changes\n    runs-on: ubuntu-latest\n    steps:\n      - run: bunx tsc --noEmit\n';
  const SKIP_BASE = {
    '.gstack/pregate.json': JSON.stringify({ run_profiles: { 'ci/free': SKIP_PROFILE }, ship_lanes_from: { [TSC]: { profiles: ['ci/free'], jobs: ['typecheck'] } } }) + '\n',
    '.github/workflows/free.yml': WORKFLOW,
    'scripts/changes.sh': 'echo "typecheck=false" >> "$GITHUB_OUTPUT"\n',
  };
  const JOBS = (gate: string) => [{ name: 'changes', conclusion: gate }, { name: 'suite', conclusion: 'success' }, { name: 'typecheck', conclusion: 'skipped' }];
  const setup = (feat: Record<string, string> = { 'src/b.ts': 'export const b = 2;\n' }, gate = 'success', event = 'pull_request') => {
    const f = shipFixture(SKIP_BASE, feat); fixtures.push(f);
    world(f, { jobs: JOBS(gate), run: { event }, tree: { files: [], tests: 0, event } });
    return f;
  };
  const lane = (f: ShipFx) => preflight(f, [`tsc=${TSC}`]);

  test('a skip the unchanged gate decided is not owed', () => {
    const f = setup();
    const out = lane(f);
    expect(out.stdout).toContain('LANE: tsc not owed: CI skipped at this tree (gate job changes, workflow unchanged) run=7/1');
    const row = JSON.parse(fs.readFileSync(findFilesBySuffix(path.join(f.state, 'projects'), '-evidence.jsonl')[0]!, 'utf8').trim().split('\n').at(-1)!);
    expect([row.tests_ran, row.not_owed]).toEqual(['n/a', 'CI skipped at this tree (gate job changes, workflow unchanged)']);
  });

  test('a branch that changed the workflow decided its own skip: the lane runs here', () => {
    const f = setup({ '.github/workflows/free.yml': WORKFLOW + '# skip more\n' });
    expect(lane(f).stdout).toContain('CI_CARRY: none label=tsc (no_verified_run: ci/free: run 7: job_skipped)');
  });

  test('a branch that changed the gate script decided its own skip: the lane runs here', () => {
    const f = setup({ 'scripts/changes.sh': 'echo "typecheck=false" >> "$GITHUB_OUTPUT" # always\n' });
    expect(lane(f).stdout).toContain('CI_CARRY: none label=tsc (no_verified_run: ci/free: run 7: job_skipped)');
  });

  test('a gate job that failed decided nothing: the lane runs here', () => {
    const f = setup(undefined, 'failure');
    expect(lane(f).stdout).toContain('CI_CARRY: none label=tsc (no_verified_run: ci/free: run 7: job_skipped)');
  });

  test('only a pull_request run\'s skip counts: a push or dispatch gate diffs against the last push, not the PR base', () => {
    const f = setup(undefined, 'success', 'workflow_dispatch');
    expect(lane(f).stdout).toContain('CI_CARRY: none label=tsc (no_verified_run: ci/free: run 7: job_skipped)');
  });

  test('gstack-ci-carry find --policy-from head --simulate checks the branch map, says SIMULATION on every line and writes nothing', () => {
    const VERIFY = 'bun run verify';
    const head = JSON.stringify({ run_profiles: { 'ci/free': PROFILE }, ship_lanes_from: { [VERIFY]: { profiles: ['ci/free'], jobs: ['suite'] } } }) + '\n';
    const f = shipFixture({ '.github/workflows/free.yml': BASE['.github/workflows/free.yml'] }, { '.gstack/pregate.json': head }); fixtures.push(f);
    world(f, { tree: { files: [], tests: 0 } });
    const cli = (args: string[]) => f.run(path.join(BIN, 'gstack-ci-carry'), args);
    const sim = cli(['find', '--base', 'main', '--policy-from', 'head', '--simulate', '--command', VERIFY, '--allow-repo-commands']);
    expect(sim.status).toBe(0);
    expect(sim.stdout.trim().split('\n').every(l => l.startsWith('SIMULATION: '))).toBe(true);
    expect(sim.stdout).toMatch(/^SIMULATION: CI_CARRY: accepted ci-carry tree=[0-9a-f]{12} jobs=suite /m);
    expect(fs.existsSync(path.join(f.state, 'projects')) ? findFilesBySuffix(path.join(f.state, 'projects'), '-evidence.jsonl') : []).toEqual([]);
    expect(cli(['find', '--base', 'main', '--command', VERIFY, '--allow-repo-commands']).stdout).toContain('CI_CARRY: none (not_mapped');
    expect(cli(['find', '--base', 'main', '--simulate']).status).toBe(2);
    expect(cli(['wait', '--base', 'main', '--policy-from', 'head', '--simulate']).status).toBe(2);
  });
});

describe('GST-1190: a lane carries the covered files and runs only the skipped remainder with its per_file runner', () => {
  // Value: protects=a fully skipped CI file runs here through the lane's declared per_file runner while the rest carries, a failing remainder
  //   carries nothing, and a lane with no runner fails closed by name; fails_when=gstack's 6 runner-skipped files make the whole free suite rerun,
  //   or a remainder failure still records a carried pass; why_new=HARN-7 decision (GSTA-258, per-file lane carry); seam=fake gh, gstack-evidence record-ci
  const PER = (exit: number) => `printf '%s\\n' {files} >> ../perfile-args; printf ' 1 pass\\n 0 fail\\nRan 1 tests across 1 file. [1.00ms]\\n' >&2; exit ${exit}`;
  const withRunner = (exit: number) => ({ ...BASE, '.gstack/pregate.json': JSON.stringify({ run_profiles: { 'ci/free': PROFILE }, ship_lanes_from: { [FREE]: { profiles: ['ci/free'], inventory: "printf 'test/a.test.ts\\ntest/b.test.ts\\n'", per_file: PER(exit) } } }, null, 2) + '\n' });
  const args = (f: ShipFx) => { const p = path.join(f.root, 'perfile-args'); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; };
  const rows = (f: ShipFx) => findFilesBySuffix(path.join(f.state, 'projects'), '-evidence.jsonl').flatMap(p => fs.readFileSync(p, 'utf8').trim().split('\n').map(l => JSON.parse(l)));

  test('the covered file carries; only the skipped file runs here, and both rows are recorded', () => {
    const f = shipFixture(withRunner(0)); fixtures.push(f);
    world(f, { tree: { skipped_files: ['test/b.test.ts'] } });
    const out = preflight(f, [`free=${FREE}`]);
    expect(out.status, out.stdout + out.stderr).toBe(0);
    expect(lane(out.stdout, 'free')).toBe('LANE: free carried run=7/1 tests_ran=1 (files) skipped_here=1 file(s) tests_ran_here=1');
    expect([args(f), runs(f, 'free-runs')]).toEqual(['./test/b.test.ts\n', 0]);
    const all = rows(f);
    expect(all.find(r => r.source === 'ci')).toMatchObject({ label: 'free', tests_ran: 1, tests_unit: 'files', skipped_here: { label: 'free.skipped', files: ['test/b.test.ts'], tests_ran: 1 } });
    expect(all.find(r => r.label === 'free.skipped')).toMatchObject({ exit: 0, tests_ran: 1 });
  });

  test('a failing remainder carries nothing: no CI row, and the whole lane runs here', () => {
    const f = shipFixture(withRunner(1)); fixtures.push(f);
    world(f, { tree: { skipped_files: ['test/b.test.ts'] } });
    const rec = f.run(path.join(BIN, 'gstack-evidence'), ['record-ci', '--label', 'free', '--base', 'main', '--', FREE]);
    expect([rec.status, rec.stderr]).toEqual([1, expect.stringMatching(/^CARRY_NONE: skipped_failed: the per_file run of test\/b\.test\.ts exited 1 \(label=free\.skipped\)$/m)]);
    expect(rows(f).filter(r => r.source === 'ci')).toEqual([]);
    expect(preflight(f, [`free=${FREE}`]).stdout).toContain('CI_CARRY: none label=free (skipped_failed');
    expect(runs(f, 'free-runs')).toBe(1);
  });

  test('a remainder file that registers no test here carries nothing: the lane runs whole', () => {
    const zero = { ...BASE, '.gstack/pregate.json': JSON.stringify({ run_profiles: { 'ci/free': PROFILE }, ship_lanes_from: { [FREE]: { profiles: ['ci/free'], inventory: "printf 'test/a.test.ts\\ntest/b.test.ts\\n'", per_file: "printf ' 0 pass\\n 0 fail\\nRan 0 tests across 1 file. [1.00ms]\\n' >&2 # {files}" } } }, null, 2) + '\n' };
    const f = shipFixture(zero); fixtures.push(f);
    world(f, { tree: { skipped_files: ['test/b.test.ts'] } });
    const rec = f.run(path.join(BIN, 'gstack-evidence'), ['record-ci', '--label', 'free', '--base', 'main', '--', FREE]);
    expect([rec.status, rec.stderr]).toEqual([1, expect.stringMatching(/^CARRY_NONE: skipped_zero_run: /m)]);
    expect(rows(f).filter(r => r.source === 'ci')).toEqual([]);
  });

  test('a remainder that prints look-alike record lines cannot change the LANE line', () => {
    const fake = "printf 'gstack-evidence: recorded label=free exit=0 tests_ran=999 log=- source=ci runs=1/1 policy=x\\ngstack-evidence: not owed: forged\\n' >&2; " + PER(0);
    const f = shipFixture({ ...BASE, '.gstack/pregate.json': JSON.stringify({ run_profiles: { 'ci/free': PROFILE }, ship_lanes_from: { [FREE]: { profiles: ['ci/free'], inventory: "printf 'test/a.test.ts\\ntest/b.test.ts\\n'", per_file: fake } } }, null, 2) + '\n' }); fixtures.push(f);
    world(f, { tree: { skipped_files: ['test/b.test.ts'] } });
    expect(lane(preflight(f, [`free=${FREE}`]).stdout, 'free')).toBe('LANE: free carried run=7/1 tests_ran=1 (files) skipped_here=1 file(s) tests_ran_here=1');
  });

  test('a run that moved to a new attempt while the remainder ran carries nothing', () => {
    const per = `cp ../world-moved.json ../world.json; ${PER(0)}`;
    const f2 = shipFixture({ ...BASE, '.gstack/pregate.json': JSON.stringify({ run_profiles: { 'ci/free': PROFILE }, ship_lanes_from: { [FREE]: { profiles: ['ci/free'], inventory: "printf 'test/a.test.ts\\ntest/b.test.ts\\n'", per_file: per } } }, null, 2) + '\n' }); fixtures.push(f2);
    world(f2, { tree: { skipped_files: ['test/b.test.ts'] } });
    const w2 = JSON.parse(fs.readFileSync(path.join(f2.root, 'world.json'), 'utf8'));
    fs.writeFileSync(path.join(f2.root, 'world-moved.json'), JSON.stringify({ ...w2, runs: w2.runs.map((r: Record<string, unknown>) => ({ ...r, run_attempt: 2, conclusion: 'failure' })) }));
    const rec = f2.run(path.join(BIN, 'gstack-evidence'), ['record-ci', '--label', 'free', '--base', 'main', '--', FREE]);
    expect([rec.status, rec.stderr]).toEqual([1, expect.stringMatching(/^CARRY_NONE: run_changed: /m)]);
    expect(rows(f2).filter(r => r.source === 'ci')).toEqual([]);
  });

  test('a working-tree edit during the post-remainder run recheck carries nothing', () => {
    const per = `touch ../armed; ${PER(0)}`;
    const f = shipFixture({ ...BASE, '.gstack/pregate.json': JSON.stringify({ run_profiles: { 'ci/free': PROFILE }, ship_lanes_from: { [FREE]: { profiles: ['ci/free'], inventory: "printf 'test/a.test.ts\\ntest/b.test.ts\\n'", per_file: per } } }, null, 2) + '\n' }); fixtures.push(f);
    world(f, { tree: { skipped_files: ['test/b.test.ts'] } });
    const w = JSON.parse(fs.readFileSync(path.join(f.root, 'world.json'), 'utf8'));
    fs.writeFileSync(path.join(f.root, 'world.json'), JSON.stringify({ ...w, editWhenArmed: { marker: path.join(f.root, 'armed'), file: path.join(f.work, 'src/b.ts'), content: 'export const b = 3;\n' } }));
    const rec = f.run(path.join(BIN, 'gstack-evidence'), ['record-ci', '--label', 'free', '--base', 'main', '--', FREE]);
    expect([rec.status, rec.stderr]).toEqual([1, expect.stringMatching(/^CARRY_NONE: tree_changed: /m)]);
    expect(rows(f).filter(r => r.source === 'ci')).toEqual([]);
  });

  // Value: protects=GST-1314: a remainder file that skips every test here too (env-gated or tool-gated by design) is recorded as not owed
  //   instead of refusing the whole carry, while a file that registers no test, or a mixed remainder hiding one, still refuses;
  //   fails_when=run 41754278952's six skipped files (0 pass, 20 skip locally) make every gstack carry end in skipped_zero_run again;
  //   why_new=GST-1314 replay (L6, #3979); seam=fake gh, gstack-evidence record-ci, per_file runner printing bun's per-file summary
  const SIX: Array<[string, number]> = [["browse/test/security-bench.test.ts",3],["test/codex-resume-flag-semantics.test.ts",2],["test/cso-docker-integration.test.ts",5],["test/cso-node-lifecycle-integration.test.ts",1],["test/cso-stack-cold-integration.test.ts",1],["test/motion-pipeline.test.ts",8]];
  const bunSummary = (f: ShipFx, cases: Array<[string, string]>) => fs.writeFileSync(path.join(f.root, 'perfile.sh'), `printf '%s\\n' "$@" >> ../perfile-args\ncase "$1" in\n${cases.map(([pat, out]) => `  *${pat}*) printf '${out}' >&2;;\n`).join('')}esac\n`);
  const skipsOnly = (n: number) => ` 0 pass\\n ${n} skip\\n 0 fail\\nRan ${n} test${n === 1 ? '' : 's'} across 1 file. [1.00ms]\\n`;
  const policy = (files: string[]) => ({ ...BASE, '.gstack/pregate.json': JSON.stringify({ run_profiles: { 'ci/free': PROFILE }, ship_lanes_from: { [FREE]: { profiles: ['ci/free'], inventory: `printf '${['test/a.test.ts', ...files].join('\\n')}\\n'`, per_file: 'sh ../perfile.sh {files}' } } }, null, 2) + '\n' });

  test('GST-1314: run 41754278952\'s six remainder files skip every test here too, so they are not owed and the lane carries', () => {
    const f = shipFixture(policy(SIX.map(([p]) => p))); fixtures.push(f);
    bunSummary(f, SIX.map(([p, n]) => [p, skipsOnly(n)]));
    world(f, { tree: { files: ['test/a.test.ts', ...SIX.map(([p]) => p)], skipped_files: SIX.map(([p]) => p) } });
    const rec = f.run(path.join(BIN, 'gstack-evidence'), ['record-ci', '--label', 'free', '--base', 'main', '--', FREE]);
    expect(rec.status, rec.stderr).toBe(0);
    expect(rec.stderr).toContain('not owed here: 6 remainder file(s) skipped every test on CI and here too');
    expect(args(f).trim().split('\n')).toEqual(SIX.map(([p]) => './' + p));
    const ci = rows(f).find(r => r.source === 'ci');
    expect(ci).toMatchObject({ label: 'free', tests_ran: 1, tests_unit: 'files', skipped_here: { label: 'free.skipped', files: SIX.map(([p]) => p), tests_ran: 0, not_owed: SIX.map(([p]) => p) } });
    expect(lane(preflight(f, [`free=${FREE}`]).stdout, 'free')).toMatch(/^LANE: free carried run=7\/1 tests_ran=1 \(files\) skipped_here=6 file\(s\) tests_ran_here=0 not_owed_here=6 \(reused the CI record at tree [0-9a-f]{12}\)$/);
    expect(args(f).trim().split('\n')).toHaveLength(SIX.length);
  });

  test('GST-1314: a remainder that mixes a file that ran here with one that registers no test still refuses', () => {
    const f = shipFixture(policy(['test/b.test.ts', 'test/c.test.ts'])); fixtures.push(f);
    bunSummary(f, [['b.test', ' 2 pass\\n 0 fail\\nRan 2 tests across 1 file. [1.00ms]\\n'], ['c.test', ' 0 pass\\n 0 fail\\nRan 0 tests across 1 file. [1.00ms]\\n']]);
    world(f, { tree: { files: ['test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts'], skipped_files: ['test/b.test.ts', 'test/c.test.ts'] } });
    const rec = f.run(path.join(BIN, 'gstack-evidence'), ['record-ci', '--label', 'free', '--base', 'main', '--', FREE]);
    expect([rec.status, rec.stderr]).toEqual([1, expect.stringMatching(/^CARRY_NONE: skipped_zero_run: the per_file run of test\/c\.test\.ts /m)]);
    expect(rows(f).filter(r => r.source === 'ci')).toEqual([]);
  });

  test('GST-1314: a remainder file whose log hit the 2MB cap is never counted not owed from the truncated log', () => {
    const f = shipFixture(policy(['test/b.test.ts'])); fixtures.push(f);
    fs.writeFileSync(path.join(f.root, 'perfile.sh'), `printf '%s\\n' "$@" >> ../perfile-args\nprintf ' 0 pass\\n 5 skip\\n 0 fail\\nRan 5 tests across 1 file. [1.00ms]\\n' >&2\nhead -c 2200000 /dev/zero | tr '\\0' x >&2\nprintf '\\n 0 pass\\n 0 fail\\nRan 0 tests across 1 file. [1.00ms]\\n' >&2\n`);
    world(f, { tree: { files: ['test/a.test.ts', 'test/b.test.ts'], skipped_files: ['test/b.test.ts'] } });
    const rec = f.run('sh', ['-c', '"$0" "$@" 2>../record-ci.err', path.join(BIN, 'gstack-evidence'), 'record-ci', '--label', 'free', '--base', 'main', '--', FREE]);
    expect([rec.status, fs.readFileSync(path.join(f.root, 'record-ci.err'), 'utf-8')]).toEqual([1, expect.stringMatching(/^CARRY_NONE: skipped_zero_run: the per_file run of test\/b\.test\.ts ran 0 tests here /m)]);
    expect(fs.readFileSync(rows(f).findLast(r => r.label === 'free.skipped').log_path, 'utf-8')).toContain('log truncated at 2MB');
    expect(rows(f).filter(r => r.source === 'ci')).toEqual([]);
  });

  test('per_file is validated: it needs {files} and an inventory entry', async () => {
    const { shipLanesErrors } = await import('../lib/ci-carry');
    expect(shipLanesErrors({ x: { profiles: ['p'], inventory: 'ls', per_file: 'bun test {files}' } }, ['p'])).toEqual([]);
    expect(shipLanesErrors({ x: { profiles: ['p'], inventory: 'ls', per_file: 'bun test' } }, ['p'])).toEqual([expect.objectContaining({ path: 'ship_lanes_from["x"].per_file' })]);
    expect(shipLanesErrors({ x: { profiles: ['p'], jobs: ['j'], per_file: 'bun test {files}' } }, ['p'])).toEqual([expect.objectContaining({ path: 'ship_lanes_from["x"].per_file' })]);
  });
});

describe('GSTA-258 L6 review fixes: gate inputs, ledger CI rows, simulate consent', () => {
  // Value: protects=a branch cannot move a path skip through a gate file gstack failed to compare, a stale CI ledger row never passes a guard
  //   after record-ci refused, and --simulate runs a branch's inventory only with --allow-repo-commands; fails_when=the l6c-p1 reproductions pass
  //   again; why_new=l6c-p1 findings (readers 15 and 16); seam=fake gh, gstack-evidence
  const TSC = 'bunx tsc --noEmit';
  const flow = (gateJob: string, before = '') => `name: Free\non: [pull_request, workflow_dispatch]\njobs:\n${before}  changes:\n    runs-on: ubuntu-latest\n${gateJob}  suite:\n    runs-on: ubuntu-latest\n    steps:\n      - run: bun test\n  typecheck:\n    needs: changes\n    runs-on: ubuntu-latest\n    steps:\n      - run: bunx tsc --noEmit\n`;
  const profile = (scripts: string[] | undefined) => ({ ...PROFILE, jobs: ['suite'], skippable: { jobs: ['typecheck'], gate: 'changes', ...(scripts ? { scripts } : {}) } });
  const base = (workflow: string, extra: Record<string, string>, scripts: string[] | undefined = ['scripts/changes.sh']) => ({
    '.gstack/pregate.json': JSON.stringify({ run_profiles: { 'ci/free': profile(scripts) }, ship_lanes_from: { [TSC]: { profiles: ['ci/free'], jobs: ['typecheck'] } } }) + '\n',
    '.github/workflows/free.yml': workflow, 'scripts/changes.sh': 'echo typecheck=false >> "$GITHUB_OUTPUT"\n', ...extra,
  });
  const JOBS = [{ name: 'changes', conclusion: 'success' }, { name: 'suite', conclusion: 'success' }, { name: 'typecheck', conclusion: 'skipped' }];
  const tsc = (b: Record<string, string>, feat: Record<string, string>) => { const f = shipFixture(b, feat); fixtures.push(f); world(f, { jobs: JOBS, run: { event: 'pull_request' }, tree: { files: [], tests: 0, event: 'pull_request' } }); return preflight(f, [`tsc=${TSC}`]).stdout; };
  const REFUSED = 'CI_CARRY: none label=tsc (no_verified_run: ci/free: run 7: job_skipped)';

  test('a gate script reached through ${{ github.workspace }} is compared', () => {
    const b = base(flow('    steps:\n      - run: bash scripts/changes.sh && bash ${{ github.workspace }}/scripts/gate.sh\n'), { 'scripts/gate.sh': 'exit 0\n' });
    expect(tsc(b, { 'scripts/gate.sh': 'exit 0 # moved\n' })).toContain(REFUSED);
  });

  test('a gate script under the job\'s working-directory is compared', () => {
    const b = base(flow('    defaults:\n      run:\n        working-directory: tools\n    steps:\n      - run: bash ../scripts/changes.sh && bash gate2.sh\n'), { 'tools/gate2.sh': 'exit 0\n' });
    expect(tsc(b, { 'tools/gate2.sh': 'exit 0 # moved\n' })).toContain(REFUSED);
  });

  test('a gate that runs a package script compares package.json', () => {
    const b = base(flow('    steps:\n      - run: bash scripts/changes.sh && bun run detect\n'), { 'package.json': '{"scripts":{"detect":"true"}}\n' });
    expect(tsc(b, { 'package.json': '{"scripts":{"detect":"echo typecheck=false"}}\n' })).toContain(REFUSED);
  });

  test('the gate is the job, not a same-named step in an earlier job', () => {
    const b = base(flow('    steps:\n      - run: bash scripts/changes.sh && bash scripts/extra.sh\n', '  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo lint\n        name: changes\n'), { 'scripts/extra.sh': 'exit 0\n' });
    expect(tsc(b, { 'scripts/extra.sh': 'exit 0 # moved\n' })).toContain(REFUSED);
  });

  test('a guard whose CI job the unchanged gate skipped says not owed, never carried', () => {
    const b = base(flow('    steps:\n      - run: bash scripts/changes.sh\n'), {});
    const conf = JSON.parse(b['.gstack/pregate.json']);
    b['.gstack/pregate.json'] = JSON.stringify({ ...conf, guards: [{ id: 'tsc', when: ['src/**'], command: TSC }] }) + '\n';
    const f = shipFixture(b, { 'src/b.ts': 'export const b = 2;\n' }); fixtures.push(f);
    world(f, { jobs: JOBS, run: { event: 'pull_request' }, tree: { files: [], tests: 0, event: 'pull_request' } });
    const out = f.run(path.join(BIN, 'gstack-pregate'), ['--only', 'guards', '--allow-repo-commands', '--base', 'main']);
    expect(out.stdout, out.stdout + out.stderr).toContain('GUARD: tsc not owed: CI skipped at this tree (gate job changes, workflow unchanged) runs=7/1');
  });

  test('a skippable profile must declare its gate scripts', async () => {
    const { runProfileErrors } = await import('../lib/run-evidence');
    expect(runProfileErrors({ p: profile(undefined) }, undefined)).toEqual([expect.objectContaining({ path: 'run_profiles["p"].skippable' })]);
    expect(runProfileErrors({ p: profile(['scripts/changes.sh']) }, undefined)).toEqual([]);
  });

  test('passed never counts a CI row: a carry under another base or after a refusal does not pass a guard', () => {
    const f = fx();
    expect(f.git('push', '-q', 'origin', 'feat').status).toBe(0);
    world(f);
    const ev = (a: string[]) => f.run(path.join(BIN, 'gstack-evidence'), a);
    expect(ev(['record-ci', '--label', 'free', '--base', 'feat', '--', FREE]).status).toBe(0);
    const p = ev(['passed', '--', FREE]);
    expect([p.status, p.stdout]).toEqual([1, expect.stringMatching(/^NOT_PASSED: /m)]);
  });

  test('passed: a newer failure of the same command at this tree vetoes the older pass', () => {
    const f = fx();
    const CMD = "test -e ../fail-flag && exit 1; printf ' 1 pass\\n 0 fail\\nRan 1 tests across 1 file. [1.00ms]\\n' >&2";
    const ev = (a: string[]) => f.run(path.join(BIN, 'gstack-evidence'), a);
    expect(ev(['run', '--label', 'g', '--', CMD]).status).toBe(0);
    expect(ev(['passed', '--', CMD]).stdout).toMatch(/^PASSED: label=g source=local /m);
    fs.writeFileSync(path.join(f.root, 'fail-flag'), '');
    expect(ev(['run', '--label', 'g', '--', CMD]).status).toBe(1);
    expect(ev(['passed', '--', CMD]).stdout).toMatch(/^NOT_PASSED: /m);
  });

  test('--simulate runs a branch inventory only with --allow-repo-commands', () => {
    const INV = "printf x >> ../inv-runs; printf 'test/a.test.ts\\ntest/b.test.ts\\n'";
    const head = JSON.stringify({ run_profiles: { 'ci/free': PROFILE }, ship_lanes_from: { [FREE]: { profiles: ['ci/free'], inventory: INV } } }) + '\n';
    const f = shipFixture({ '.github/workflows/free.yml': BASE['.github/workflows/free.yml'] }, { '.gstack/pregate.json': head }); fixtures.push(f);
    world(f);
    const sim = (extra: string[]) => f.run(PREFLIGHT, ['--tests-only', '--base', 'main', '--policy-from', 'head', '--simulate', '--lane', `free=${FREE}`, ...extra]);
    const no = sim([]);
    expect([no.status, runs(f, 'inv-runs')]).toEqual([1, 0]);
    expect(no.stdout).toContain('pass --allow-repo-commands');
    const yes = sim(['--allow-repo-commands']);
    expect([yes.status, runs(f, 'inv-runs')], yes.stdout).toEqual([0, 1]);
    expect(yes.stdout).toContain('SIMULATION: LANE: free would carry run=7/1 tests_ran=2 unit=files');
  });
});
