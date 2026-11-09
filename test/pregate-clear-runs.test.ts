/**
 * gstack-pregate clear --run (GSTA-156): GitHub Actions runs clear the remote gate obligation, or a lane with a run
 * profile, on the identical tree or a stamp-only predecessor, covering the gate's inventory; verify then checks the
 * recorded receipt offline. The run API is a fake; trees come from the fixture repository's git.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT, type PregateFile } from '../lib/headless-artifacts';
import { buildContext } from '../lib/pregate/context';
import { discoverLanes } from '../lib/pregate/workflows';
import { clearDecision, clearObligation, runPregate, verifyPregate, type RunCheck } from '../lib/pregate/index';
import type { ApiJob, ApiRun, RunDeps, RunProfile } from '../lib/run-evidence';
import { BASE_PREGATE, cleanup, commit, makeFixtureRepo, readFile, runBin, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

const LANE = 'pregate.json/remote_gate';
const NOW = new Date('2026-10-29T12:00:00Z');
const POLICY = { bump: 'patch', queue_mode: 'stamp-at-merge', changelog: 'CHANGELOG.md', stamp_files: ['VERSION', 'package.json', 'CHANGELOG.md'] };
const PROFILES: Record<string, RunProfile> = {
  test: { workflow: 'test.yml', events: ['workflow_dispatch'], jobs: ['full-suite'], artifact: 'full-suite-tree' },
  e2e: { workflow: 'e2e.yml', events: ['workflow_dispatch'], jobs: ['e2e-full-suite'], artifact: 'e2e-full-suite-tree' },
};
const GATE_RUNS = { profiles: ['test', 'e2e'], inventory: 'printf "test/a.test.ts\\ntest/b.test.ts\\n"' };

function fixture(extra: Record<string, unknown> = {}): FixtureRepo {
  const repo = makeFixtureRepo({
    pregate: { ...BASE_PREGATE, ...extra, remote_gate: 'node scripts/remote-gate.js', dependencies: { ...BASE_PREGATE.dependencies, 'CHANGELOG.md': [], VERSION: [] } },
    baseFiles: { '.gstack/ship-policy.json': JSON.stringify(POLICY, null, 2) + '\n', VERSION: '1.0.0\n', 'CHANGELOG.md': '# Changelog\n\n## [Unreleased]\n\n- add\n' },
  });
  repos.push(repo);
  repo.git('checkout', '-q', 'main');
  commit(repo, { 'scripts/remote-gate.js': "console.log('PREGATE_REMOTE: tree=' + process.env.PREGATE_TREE + ' tests=3 failed=0');\n" }, 'remote gate');
  repo.git('push', '-q', 'origin', 'main');
  repo.git('checkout', '-q', 'feature');
  repo.git('merge', '-q', '--ff-only', 'main');
  commit(repo, { 'lib/util.js': 'exports.add = (a, b) => a + b + 0;\n' }, 'the real change');
  return repo;
}

function stamp(repo: FixtureRepo): string {
  const pkg = JSON.parse(readFile(repo, 'package.json'));
  pkg.version = '1.0.1';
  return commit(repo, { VERSION: '1.0.1\n', 'package.json': JSON.stringify(pkg, null, 2) + '\n', 'CHANGELOG.md': '# Changelog\n\n## [1.0.1] - 2026-10-29\n\n- add\n' }, 'v1.0.1 stamp');
}

async function pregateAt(repo: FixtureRepo): Promise<PregateFile> {
  const loaded = buildContext({ repoRoot: repo.work, base: 'main', policyFrom: 'base', allowRepoCommands: true, env: { ...process.env, ...repo.env }, progress: () => {}, cores: 4, testBackend: 'local' });
  if (!('ctx' in loaded)) throw new Error('fixture context refused');
  const file = await runPregate(loaded.ctx, { stage: 'all' });
  expect(file.requires_remote).toEqual([expect.objectContaining({ lane: LANE, receipt: null })]);
  return file;
}

/** A run of `profile` on `head` with a tree.json listing `files`, as GitHub would report it. */
interface FakeRun { id: number; profile: string; head: string; files: string[]; conclusion?: string; updated?: string }
function check(repo: FixtureRepo, runs: FakeRun[], over: Partial<RunCheck> = {}): RunCheck {
  const byId = new Map(runs.map(r => [r.id, r]));
  const api = (r: FakeRun): ApiRun => ({
    id: r.id, run_attempt: 1, status: 'completed', conclusion: r.conclusion ?? 'success', event: 'workflow_dispatch', head_sha: r.head,
    path: `.github/workflows/${PROFILES[r.profile]!.workflow}`, created_at: '2026-10-29T10:00:00Z', updated_at: r.updated ?? '2026-10-29T10:30:00Z',
    repository: { full_name: 'fx/fx' }, head_repository: { full_name: 'fx/fx' },
  });
  const deps: RunDeps = {
    run: id => { const r = byId.get(id); if (!r) throw new Error('HTTP 404'); return api(r); },
    runsForHead: (wf, sha) => runs.filter(r => r.head === sha && PROFILES[r.profile]!.workflow === wf).map(api),
    jobs: id => [{ name: PROFILES[byId.get(id)!.profile]!.jobs[0]!, conclusion: 'success' }],
    artifact: id => { const r = byId.get(id)!; return { run_id: id, run_attempt: 1, event: 'workflow_dispatch', sha: r.head, tree: repo.git('rev-parse', `${r.head}^{tree}`), files: r.files, tests: r.files.length * 5 }; },
    commitTree: sha => repo.git('rev-parse', `${sha}^{tree}`),
  };
  return { repo: 'fx/fx', deps, profiles: PROFILES, gateRuns: GATE_RUNS, now: NOW, inventory: () => ['test/a.test.ts', 'test/b.test.ts'], ...over };
}

/** A check whose only readable run is 300, a run of `workflow` on `head` (completed with success unless `state` says otherwise). */
function runOfWorkflow(repo: FixtureRepo, head: string, workflow: string, state: Pick<ApiRun, 'status' | 'conclusion'> & Partial<Pick<ApiRun, 'run_attempt'>> = { status: 'completed', conclusion: 'success' }, jobs: ApiJob[] = [{ name: 'native / job', conclusion: 'success' }]): RunCheck {
  const c = check(repo, []);
  const run = (id: number): ApiRun => {
    if (id !== 300) throw new Error('HTTP 404');
    return { id, run_attempt: 1, ...state, event: 'pull_request', head_sha: head, path: `.github/workflows/${workflow}`, repository: { full_name: 'fx/fx' }, head_repository: { full_name: 'fx/fx' } };
  };
  return { ...c, deps: { ...c.deps, run, jobs: () => jobs } };
}

describe.skipIf(process.platform === 'win32')('clear --run: Actions runs as remote gate evidence', () => {
  test('one verified run per profile on the identical tree clears the gate, and verify accepts the receipt offline', async () => {
    const repo = fixture();
    const head = repo.git('rev-parse', 'HEAD');
    const file = await pregateAt(repo);
    const d = clearDecision(file, LANE, { runs: ['200', '201'], evidence: check(repo, [{ id: 201, profile: 'e2e', head, files: ['test/b.test.ts'] }, { id: 200, profile: 'test', head, files: ['test/a.test.ts', 'test/util.test.js'] }]) }, repo.work);
    if ('refused' in d) throw new Error(d.message);
    expect(d.receipt).toBe(`remote-gate tree=${file.tree.slice(0, 12)} tests=15 runs=200/1,201/1 profiles=test,e2e heads=${head.slice(0, 12)} verified=2026-10-29T12:00:00.000Z`);
    expect(d.substitution).toBeUndefined();
    const cleared = clearObligation(file, LANE, d.receipt, 'test');
    expect(verifyPregate(repo.work, cleared, { tree: file.tree } as any)).toMatchObject({ ok: true });
    const out = path.join(repo.work, '.gstack/tmp/pregate.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(cleared));
    const bound = runBin(repo, 'gstack-ship-receipt', ['write', '--pr', '7', '--base', 'main', '--version', '1.0.0', '--session-kind', 'interactive', '--pregate', out, '--json']);
    expect([bound.status, bound.err]).toEqual([EXIT.ok, expect.any(String)]);
    expect(bound.out).toContain(d.receipt);
  }, 120_000);

  test('runs on a stamp-only predecessor are accepted for the stamped head and recorded as a substitution', async () => {
    const repo = fixture();
    const gated = repo.git('rev-parse', 'HEAD');
    stamp(repo);
    const file = await pregateAt(repo);
    const d = clearDecision(file, LANE, { runs: ['200', '201'], evidence: check(repo, [{ id: 200, profile: 'test', head: gated, files: ['test/a.test.ts', 'test/util.test.js'] }, { id: 201, profile: 'e2e', head: gated, files: ['test/b.test.ts'] }]) }, repo.work);
    if ('refused' in d) throw new Error(d.message);
    expect(d.receipt).toContain(`accepted-for=${file.tree.slice(0, 12)} stamp-only=3 runs=200/1,201/1`);
    expect(d.substitution?.accepted_for).toBe(file.tree);
    expect(verifyPregate(repo.work, clearObligation(file, LANE, d.receipt, 'test', d.substitution), { tree: file.tree } as any)).toMatchObject({ ok: true });
  }, 120_000);

  test('refusals: a non-stamp difference, an uncovered inventory file, a failed run, a missing profile, no remote_gate_runs', async () => {
    const repo = fixture();
    const older = repo.git('rev-parse', 'HEAD~1');
    const head = repo.git('rev-parse', 'HEAD');
    const file = await pregateAt(repo);
    const both = (h: string, files: string[][] = [['test/a.test.ts', 'test/util.test.js'], ['test/b.test.ts']], conclusion?: string): FakeRun[] => [{ id: 200, profile: 'test', head: h, files: files[0]!, conclusion }, { id: 201, profile: 'e2e', head: h, files: files[1]! }];
    const msg = (d: ReturnType<typeof clearDecision>) => ('refused' in d ? `${d.refused}: ${d.message}` : `cleared ${d.receipt}`);
    expect(msg(clearDecision(file, LANE, { runs: ['200', '201'], evidence: check(repo, both(older)) }, repo.work))).toMatch(/^PREGATE_RECEIPT_INVALID: .*lib\/util\.js/);
    expect(msg(clearDecision(file, LANE, { runs: ['200', '201'], evidence: check(repo, both(head, [['test/a.test.ts', 'test/util.test.js'], ['test/c.test.ts']])) }, repo.work))).toContain('1 of the 3 test file(s) pregate.json/remote_gate must cover appear in no run\'s tree.json (test/b.test.ts)');
    expect(msg(clearDecision(file, LANE, { runs: ['200', '201'], evidence: check(repo, both(head, [['test/a.test.ts', 'test/b.test.ts'], ['test/b.test.ts']])) }, repo.work))).toContain('(test/util.test.js)');
    expect(msg(clearDecision(file, LANE, { runs: ['200', '201'], evidence: check(repo, both(head, [['test/a.test.ts', 'test/util.test.js'], []])) }, repo.work))).toContain('reason=no_tests — run 201 (e2e) records no tests');
    expect(msg(clearDecision(file, LANE, { runs: ['200', 'https://github.com/fx/fx/actions/runs/200'], evidence: check(repo, both(head)) }, repo.work))).toBe('usage: pregate.json/remote_gate needs a different run for each profile; got 200, https://github.com/fx/fx/actions/runs/200');
    expect(msg(clearDecision({ ...file, base: 'origin/release@0123456789ab' }, LANE, { runs: ['200', '201'], evidence: check(repo, both(head)) }, repo.work))).toMatch(/^PREGATE_RECEIPT_INVALID: REUSE: refused reason=base_mismatch/);
    expect(msg(clearDecision(file, LANE, { runs: ['200', '201'], evidence: check(repo, both(head, undefined, 'failure')) }, repo.work))).toContain('reason=no_verified_run');
    expect(msg(clearDecision(file, LANE, { runs: ['200'], evidence: check(repo, both(head)) }, repo.work))).toBe('usage: pregate.json/remote_gate clears with exactly 2 run(s), one per profile (test, e2e); got 1');
    expect(msg(clearDecision(file, LANE, { runs: ['200', '201'], evidence: check(repo, both(head), { gateRuns: null }) }, repo.work))).toContain('only when the base branch\'s .gstack/pregate.json declares remote_gate_runs');
    expect(msg(clearDecision(file, LANE, { runs: ['200', '201'], evidence: check(repo, both(head), { inventory: () => ({ error: 'boom' }) }) }, repo.work))).toContain('inventory command failed: boom');
  }, 120_000);

  test('runs that tested different trees, or that record no tests, never clear the gate', async () => {
    const repo = fixture();
    const older = repo.git('rev-parse', 'HEAD~1');
    const head = repo.git('rev-parse', 'HEAD');
    const file = await pregateAt(repo);
    const split = clearDecision(file, LANE, { runs: ['200', '201'], evidence: check(repo, [{ id: 200, profile: 'test', head, files: ['test/a.test.ts', 'test/b.test.ts', 'test/util.test.js'] }, { id: 201, profile: 'e2e', head: older, files: ['test/b.test.ts'] }]) }, repo.work);
    expect('refused' in split && split.message).toContain('the runs tested different trees');
    const empty = clearDecision(file, LANE, { runs: ['200', '201'], evidence: check(repo, [{ id: 200, profile: 'test', head, files: ['test/util.test.js'] }, { id: 201, profile: 'e2e', head, files: ['test/b.test.ts'] }], { inventory: () => [] }) }, repo.work);
    expect('refused' in empty && empty.message).toContain('inventory command listed no test files');
  }, 120_000);

  test('a run valid for two profiles does not starve the other: the profile-to-run assignment is searched, not taken greedily', async () => {
    const repo = fixture();
    const head = repo.git('rev-parse', 'HEAD');
    const file = await pregateAt(repo);
    const profiles = { ...PROFILES, wide: PROFILES.test!, narrow: { ...PROFILES.test!, max_age_hours: 1 } };
    const runs: FakeRun[] = [{ id: 200, profile: 'test', head, files: ['test/a.test.ts', 'test/util.test.js'] }, { id: 201, profile: 'test', head, files: ['test/b.test.ts'], updated: '2026-10-29T11:30:00Z' }];
    const d = clearDecision(file, LANE, { runs: ['201', '200'], evidence: check(repo, runs, { profiles, gateRuns: { profiles: ['wide', 'narrow'], inventory: 'true' } }) }, repo.work);
    if ('refused' in d) throw new Error(d.message);
    expect(d.receipt).toContain('runs=200/1,201/1 profiles=wide,narrow ');
  }, 120_000);

  test('a lane with its own profile clears from --run-url through the verifier; a lane without one keeps the plain run-URL record, and so does a repository whose run profiles cannot be read (a non-GitHub origin), with a warning', async () => {
    const repo = fixture();
    const head = repo.git('rev-parse', 'HEAD');
    const base = await pregateAt(repo);
    const PLATFORM = 'test.yml/full-suite';
    const file: PregateFile = { ...base, requires_remote: [...base.requires_remote!, { lane: PLATFORM, platform: 'macos', workflow: 'test.yml', job: 'full-suite', tests: ['test/a.test.ts'], receipt: null }] };
    const url = 'https://github.com/fx/fx/actions/runs/200';
    const profiled = clearDecision(file, PLATFORM, { runUrl: url, evidence: check(repo, [{ id: 200, profile: 'test', head, files: ['test/a.test.ts'] }], { profiles: { ...PROFILES, [PLATFORM]: PROFILES.test! } }) }, repo.work);
    if ('refused' in profiled) throw new Error(profiled.message);
    expect(profiled).toMatchObject({ attested: false });
    expect(profiled.receipt).toStartWith(`run tree=${file.tree.slice(0, 12)} tests=5 runs=200/1 profiles=${PLATFORM} `);
    const failed = clearDecision(file, PLATFORM, { runUrl: url, evidence: check(repo, [{ id: 200, profile: 'test', head, files: ['test/a.test.ts'], conclusion: 'failure' }], { profiles: { ...PROFILES, [PLATFORM]: PROFILES.test! } }) }, repo.work);
    expect('refused' in failed && failed.refused).toBe('PREGATE_RECEIPT_INVALID');
    expect(clearDecision(file, PLATFORM, { runUrl: url, evidence: check(repo, [{ id: 200, profile: 'test', head, files: ['test/a.test.ts'] }]) }, repo.work)).toEqual({ receipt: `${url}/attempts/1`, attested: false });
    const bundled = clearDecision(file, PLATFORM, { bundleLane: 'macos', evidence: check(repo, [], { profiles: { ...PROFILES, [PLATFORM]: PROFILES.test! } }) }, repo.work);
    expect('refused' in bundled && `${bundled.refused}: ${bundled.message}`).toBe(`usage: ${PLATFORM} has a run profile on the base branch; clear it with --run <id|url>, which verifies the run`);
    expect(clearDecision(file, PLATFORM, { bundleLane: 'macos', evidence: check(repo, []) }, repo.work)).toEqual({ receipt: 'bundle-lane:macos', attested: false });
    const unprofiled = clearDecision(file, PLATFORM, { runs: ['200'], evidence: check(repo, []) }, repo.work);
    expect('refused' in unprofiled && `${unprofiled.refused}: ${unprofiled.message}`).toContain(`usage: --run clears ${PLATFORM} only when the base branch's .gstack/pregate.json declares a run_profiles entry named`);
    const gateFromUrl = clearDecision(file, LANE, { runUrl: url, evidence: check(repo, [{ id: 200, profile: 'test', head, files: ['test/a.test.ts', 'test/b.test.ts', 'test/util.test.js'] }]) }, repo.work);
    expect('refused' in gateFromUrl && `${gateFromUrl.refused}: ${gateFromUrl.message}`).toBe('usage: pregate.json/remote_gate clears with exactly 2 run(s), one per profile (test, e2e); got 1');
    const oneProfile = clearDecision(file, LANE, { runUrl: url, evidence: check(repo, [{ id: 200, profile: 'test', head, files: ['test/a.test.ts', 'test/b.test.ts', 'test/util.test.js'] }], { gateRuns: { profiles: ['test'], inventory: 'true' } }) }, repo.work);
    if ('refused' in oneProfile) throw new Error(oneProfile.message);
    expect(oneProfile.receipt).toStartWith(`remote-gate tree=${file.tree.slice(0, 12)} tests=15 runs=200/1 profiles=test `);
    const uncovered = clearDecision(file, PLATFORM, { runUrl: url, evidence: check(repo, [{ id: 200, profile: 'test', head, files: ['test/smoke.test.ts'] }], { profiles: { ...PROFILES, [PLATFORM]: PROFILES.test! } }) }, repo.work);
    expect('refused' in uncovered && uncovered.message).toContain(`reason=tests_uncovered — 1 of the 1 test file(s) ${PLATFORM} must cover appear in no run's tree.json (test/a.test.ts)`);
    fs.mkdirSync(path.join(repo.work, '.gstack/tmp'), { recursive: true });
    fs.writeFileSync(path.join(repo.work, '.gstack/tmp/pregate.json'), JSON.stringify(file));
    const r = runBin(repo, 'gstack-pregate', ['clear', '--remote', PLATFORM, '--run-url', url]);
    expect([r.status, r.err]).toEqual([EXIT.ok, expect.stringContaining('origin is not a github.com repository')]);
    expect(r.err).toContain(`${PLATFORM} was recorded without run verification`);
    const viaRun = runBin(repo, 'gstack-pregate', ['clear', '--remote', LANE, '--run', '200', '--run', '201', '--allow-repo-commands']);
    expect([viaRun.status, viaRun.err]).toEqual([EXIT.fail, expect.stringContaining('origin is not a github.com repository')]);
  }, 120_000);

  test('a lane with no profile refuses a --run-url run of another workflow, or one that cannot be read, and still clears from a run of its own workflow (GSTA-203)', async () => {
    const repo = fixture();
    const head = repo.git('rev-parse', 'HEAD');
    const base = await pregateAt(repo);
    fs.mkdirSync(path.join(repo.work, '.github/workflows'), { recursive: true });
    fs.writeFileSync(path.join(repo.work, '.github/workflows/a.yml'), 'name: A\non: [pull_request, workflow_dispatch]\njobs:\n  job:\n    runs-on: windows-latest\n    steps:\n      - run: echo a\n');
    repo.git('add', '-A', '.github');
    const PLATFORM = 'a.yml/job';
    const file: PregateFile = { ...base, tree: repo.git('write-tree'), requires_remote: [...base.requires_remote!, { lane: PLATFORM, platform: 'windows', workflow: 'a.yml', job: 'job', tests: ['test/a.test.ts'], receipt: null }] };
    const url = 'https://github.com/fx/fx/actions/runs/300';
    const msg = (d: ReturnType<typeof clearDecision>) => ('refused' in d ? `${d.refused}: ${d.message}; fix: ${d.fix}` : `cleared ${d.receipt}`);
    expect(msg(clearDecision(file, PLATFORM, { runUrl: url, evidence: runOfWorkflow(repo, head, 'b.yml') }, repo.work))).toBe(`PREGATE_RECEIPT_INVALID: REUSE: refused reason=workflow_mismatch — run 300 attempt 1 ran .github/workflows/b.yml, not .github/workflows/a.yml; ${PLATFORM} stays uncleared; fix: clear ${PLATFORM} with a run of its own workflow: gh workflow run a.yml --ref <branch>, then gstack-pregate clear --remote ${PLATFORM} --run-url <that run's URL>`);
    expect(clearDecision(file, PLATFORM, { runUrl: url, evidence: runOfWorkflow(repo, head, 'a.yml') }, repo.work)).toEqual({ receipt: `${url}/attempts/1`, attested: false });
    for (const copied of [`${url}/job/9?pr=3806`, `${url}/job/9#step:3:1`]) expect(clearDecision(file, PLATFORM, { runUrl: copied, evidence: runOfWorkflow(repo, head, 'a.yml') }, repo.work)).toEqual({ receipt: `${url}/attempts/1`, attested: false });
    expect(msg(clearDecision(file, PLATFORM, { runUrl: 'https://github.com/fx/fx/actions/runs/301', evidence: runOfWorkflow(repo, head, 'a.yml') }, repo.work))).toBe(`PREGATE_RECEIPT_INVALID: REUSE: refused reason=api_error — reading run 301 failed: HTTP 404; ${PLATFORM} stays uncleared; fix: check gh auth status and that gh can read fx/fx's Actions runs, then rerun the same clear`);
    expect(msg(clearDecision(file, PLATFORM, { runUrl: 'https://ci.example.com/runs/300', evidence: runOfWorkflow(repo, head, 'a.yml') }, repo.work))).toBe(`PREGATE_RECEIPT_INVALID: REUSE: refused reason=run_ref_invalid — "https://ci.example.com/runs/300" is not a run id or a run URL on fx/fx; ${PLATFORM} stays uncleared; fix: pass the run's numeric id or https://github.com/fx/fx/actions/runs/<id>`);
    expect(clearDecision(file, PLATFORM, { runUrl: url }, repo.work)).toEqual({ receipt: url, attested: false });
  }, 120_000);

  test('a lane with no profile refuses a --run-url run of its own workflow that failed, was cancelled or is still running, and still clears from a green one (GSTA-203 PR 8)', async () => {
    const repo = fixture();
    const head = repo.git('rev-parse', 'HEAD');
    const base = await pregateAt(repo);
    fs.mkdirSync(path.join(repo.work, '.github/workflows'), { recursive: true });
    fs.writeFileSync(path.join(repo.work, '.github/workflows/a.yml'), 'name: A\non: [pull_request, workflow_dispatch]\njobs:\n  job:\n    runs-on: windows-latest\n    steps:\n      - run: echo a\n');
    repo.git('add', '-A', '.github');
    const PLATFORM = 'a.yml/job';
    const file: PregateFile = { ...base, tree: repo.git('write-tree'), requires_remote: [...base.requires_remote!, { lane: PLATFORM, platform: 'windows', workflow: 'a.yml', job: 'job', tests: ['test/a.test.ts'], receipt: null }] };
    const url = 'https://github.com/fx/fx/actions/runs/300';
    const msg = (d: ReturnType<typeof clearDecision>) => ('refused' in d ? `${d.refused}: ${d.message}; fix: ${d.fix}` : `cleared ${d.receipt}`);
    const rerun = `fix: rerun a.yml (gh run rerun 300, or gh workflow run a.yml --ref <branch>), then gstack-pregate clear --remote ${PLATFORM} --run-url <the green run's URL>`;
    for (const conclusion of ['failure', 'cancelled', 'timed_out']) {
      expect(msg(clearDecision(file, PLATFORM, { runUrl: url, evidence: runOfWorkflow(repo, head, 'a.yml', { status: 'completed', conclusion }) }, repo.work))).toBe(`PREGATE_RECEIPT_INVALID: REUSE: refused reason=run_not_success — run 300 attempt 1 concluded ${conclusion}; ${PLATFORM} stays uncleared; ${rerun}`);
    }
    expect(msg(clearDecision(file, PLATFORM, { runUrl: `${url}/job/9?pr=1`, evidence: runOfWorkflow(repo, head, 'a.yml', { status: 'in_progress', conclusion: null }) }, repo.work))).toBe(`PREGATE_RECEIPT_INVALID: REUSE: refused reason=run_in_progress — run 300 attempt 1 is in_progress; ${PLATFORM} stays uncleared; fix: wait for run 300 to finish green (or rerun a.yml if it fails), then gstack-pregate clear --remote ${PLATFORM} --run-url <the green run's URL>`);
    expect(clearDecision(file, PLATFORM, { runUrl: url, evidence: runOfWorkflow(repo, head, 'a.yml') }, repo.work)).toEqual({ receipt: `${url}/attempts/1`, attested: false });
    expect(clearDecision(file, PLATFORM, { runUrl: `${url}/attempts/1?pr=1`, evidence: runOfWorkflow(repo, head, 'a.yml', { status: 'completed', conclusion: 'success', run_attempt: 2 }) }, repo.work)).toEqual({ receipt: `${url}/attempts/2`, attested: false });
  }, 120_000);

  test('a reusable-workflow lane (workflow_call only) clears from a run of a caller whose job uses ./.github/workflows/<lane workflow>; an unrelated workflow still refuses, and no fix line dispatches a workflow without workflow_dispatch (GST-971)', async () => {
    const repo = fixture();
    const head = repo.git('rev-parse', 'HEAD');
    const base = await pregateAt(repo);
    const wf = (name: string, text: string) => { fs.mkdirSync(path.join(repo.work, '.github/workflows'), { recursive: true }); fs.writeFileSync(path.join(repo.work, '.github/workflows', name), text); };
    wf('r.yml', 'name: Reusable\non:\n  workflow_call:\n    inputs:\n      scope:\n        type: string\njobs:\n  job:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo reusable\n');
    wf('c.yml', 'name: Caller\non:\n  pull_request:\n  workflow_dispatch:\njobs:\n  native:\n    uses: ./.github/workflows/r.yml\n    with:\n      scope: full\n');
    wf('u.yml', 'name: Unrelated\non: [push, workflow_dispatch]\njobs:\n  other:\n    uses: ./.github/workflows/other.yml\n');
    const PLATFORM = 'r.yml/job';
    const file: PregateFile = { ...base, requires_remote: [...base.requires_remote!, { lane: PLATFORM, platform: 'windows', workflow: 'r.yml', job: 'job', tests: ['test/a.test.ts'], receipt: null }] };
    const url = 'https://github.com/fx/fx/actions/runs/300';
    const msg = (d: ReturnType<typeof clearDecision>) => ('refused' in d ? `${d.refused}: ${d.message}; fix: ${d.fix}` : `cleared ${d.receipt}`);
    const at = (): PregateFile => { repo.git('add', '-A', '.github'); return { ...file, tree: repo.git('write-tree') }; };
    expect(msg(clearDecision(at(), PLATFORM, { runUrl: url, evidence: runOfWorkflow(repo, head, 'c.yml') }, repo.work))).toBe(`cleared ${url}/attempts/1`);
    expect(msg(clearDecision(at(), PLATFORM, { runUrl: `${url}/job/9`, evidence: runOfWorkflow(repo, head, 'c.yml') }, repo.work))).toBe(`cleared ${url}/attempts/1`);
    expect(msg(clearDecision(at(), PLATFORM, { runUrl: url, evidence: runOfWorkflow(repo, head, 'c.yml', undefined, [{ name: 'native (linux) / job', conclusion: 'success' }]) }, repo.work))).toBe(`cleared ${url}/attempts/1`);
    for (const jobs of [[{ name: 'native', conclusion: 'skipped' }], [{ name: 'native / job', conclusion: 'skipped' }, { name: 'lint', conclusion: 'success' }], [{ name: 'native-other / job', conclusion: 'success' }], [{ name: 'native / lint', conclusion: 'success' }, { name: 'native / job', conclusion: 'skipped' }]]) {
      expect(msg(clearDecision(at(), PLATFORM, { runUrl: url, evidence: runOfWorkflow(repo, head, 'c.yml', undefined, jobs) }, repo.work))).toBe(`PREGATE_RECEIPT_INVALID: REUSE: refused reason=caller_job_skipped — run 300 attempt 1 of c.yml has no successful job named "native / job", so r.yml did not run in it; ${PLATFORM} stays uncleared; fix: clear with a c.yml run in which that job runs (gh workflow run c.yml --ref <branch>), then gstack-pregate clear --remote ${PLATFORM} --run-url <the green run's URL>`);
    }
    expect(msg(clearDecision(at(), PLATFORM, { runUrl: url, evidence: runOfWorkflow(repo, head, 'u.yml') }, repo.work))).toBe(`PREGATE_RECEIPT_INVALID: REUSE: refused reason=workflow_mismatch — run 300 attempt 1 ran .github/workflows/u.yml, not .github/workflows/r.yml or a workflow that calls it (c.yml); ${PLATFORM} stays uncleared; fix: clear ${PLATFORM} with a run of its own workflow or of a workflow that calls it (c.yml): gh workflow run c.yml --ref <branch>, then gstack-pregate clear --remote ${PLATFORM} --run-url <that run's URL>`);
    expect(msg(clearDecision(at(), PLATFORM, { runUrl: url, evidence: runOfWorkflow(repo, head, 'c.yml', { status: 'completed', conclusion: 'failure' }) }, repo.work))).toBe(`PREGATE_RECEIPT_INVALID: REUSE: refused reason=run_not_success — run 300 attempt 1 concluded failure; ${PLATFORM} stays uncleared; fix: rerun c.yml (gh run rerun 300, or gh workflow run c.yml --ref <branch>), then gstack-pregate clear --remote ${PLATFORM} --run-url <the green run's URL>`);
    expect(msg(clearDecision(at(), PLATFORM, { runUrl: url, evidence: runOfWorkflow(repo, head, 'c.yml', { status: 'in_progress', conclusion: null }) }, repo.work))).toBe(`PREGATE_RECEIPT_INVALID: REUSE: refused reason=run_in_progress — run 300 attempt 1 is in_progress; ${PLATFORM} stays uncleared; fix: wait for run 300 to finish green (or rerun c.yml if it fails), then gstack-pregate clear --remote ${PLATFORM} --run-url <the green run's URL>`);
    wf('c.yml', 'name: Caller\non:\n  pull_request:\njobs:\n  native:\n    uses: "./.github/workflows/r.yml" # reusable\n');
    expect(msg(clearDecision(at(), PLATFORM, { runUrl: url, evidence: runOfWorkflow(repo, head, 'u.yml') }, repo.work))).toBe(`PREGATE_RECEIPT_INVALID: REUSE: refused reason=workflow_mismatch — run 300 attempt 1 ran .github/workflows/u.yml, not .github/workflows/r.yml or a workflow that calls it (c.yml); ${PLATFORM} stays uncleared; fix: clear ${PLATFORM} with a run of its own workflow or of a workflow that calls it (c.yml): neither r.yml nor its callers have a workflow_dispatch trigger, so push a commit that starts c.yml, then gstack-pregate clear --remote ${PLATFORM} --run-url <that run's URL>`);
    expect(msg(clearDecision(at(), PLATFORM, { runUrl: url, evidence: runOfWorkflow(repo, head, 'c.yml', { status: 'completed', conclusion: 'failure' }) }, repo.work))).toBe(`PREGATE_RECEIPT_INVALID: REUSE: refused reason=run_not_success — run 300 attempt 1 concluded failure; ${PLATFORM} stays uncleared; fix: rerun c.yml (gh run rerun 300), then gstack-pregate clear --remote ${PLATFORM} --run-url <the green run's URL>`);
    expect(msg(clearDecision(at(), PLATFORM, { runUrl: url, evidence: runOfWorkflow(repo, head, 'c.yml') }, repo.work))).toBe(`cleared ${url}/attempts/1`);
  }, 120_000);

  test('a caller run counts only through a successful <calling job> / <lane job> job; names with comments or expressions match; callers are read at pregate.json\'s tree, not the working tree; a flow-mapping on: with workflow_dispatch counts (GST-971 fix-check)', async () => {
    const repo = fixture();
    const head = repo.git('rev-parse', 'HEAD');
    const base = await pregateAt(repo);
    const PLATFORM = 'r.yml/job';
    const lane: PregateFile = { ...base, requires_remote: [...base.requires_remote!, { lane: PLATFORM, platform: 'windows', workflow: 'r.yml', job: 'job', tests: ['test/a.test.ts'], receipt: null }] };
    const dir = path.join(repo.work, '.github/workflows');
    const write = (files: Record<string, string>) => { fs.mkdirSync(dir, { recursive: true }); for (const [n, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), text); };
    write({
      'r.yml': 'name: Reusable\non:\n  workflow_call:\njobs:\n  job:\n    name: Native tests # the lane\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo r\n  other:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo o\n',
      'c.yml': 'name: Caller\non: { pull_request: {}, workflow_dispatch: {} }\njobs:\n  native:\n    name: Native (${{ inputs.scope }}) # calls r.yml\n    uses: ./.github/workflows/r.yml\n',
    });
    repo.git('add', '-A', '.github');
    const file: PregateFile = { ...lane, tree: repo.git('write-tree') };
    const url = 'https://github.com/fx/fx/actions/runs/300';
    const msg = (d: ReturnType<typeof clearDecision>) => ('refused' in d ? `${d.refused}: ${d.message}; fix: ${d.fix}` : `cleared ${d.receipt}`);
    const caller = (jobs: ApiJob[], state?: Pick<ApiRun, 'status' | 'conclusion'>) => msg(clearDecision(file, PLATFORM, { runUrl: url, evidence: runOfWorkflow(repo, head, 'c.yml', state, jobs) }, repo.work));
    expect(caller([{ name: 'Native (full) / Native tests', conclusion: 'success' }])).toBe(`cleared ${url}/attempts/1`);
    expect(caller([{ name: 'Native (smoke) / Native tests (linux)', conclusion: 'success' }])).toBe(`cleared ${url}/attempts/1`);
    const skipped = `PREGATE_RECEIPT_INVALID: REUSE: refused reason=caller_job_skipped — run 300 attempt 1 of c.yml has no successful job named "Native (\${{ inputs.scope }}) / Native tests", so r.yml did not run in it; ${PLATFORM} stays uncleared; fix: clear with a c.yml run in which that job runs (gh workflow run c.yml --ref <branch>), then gstack-pregate clear --remote ${PLATFORM} --run-url <the green run's URL>`;
    expect(caller([{ name: 'Native (full) / other', conclusion: 'success' }, { name: 'Native (full) / Native tests', conclusion: 'skipped' }])).toBe(skipped);
    expect(caller([{ name: 'Native (full) / lint', conclusion: 'success' }])).toBe(skipped);
    expect(caller([], { status: 'completed', conclusion: 'failure' })).toBe(`PREGATE_RECEIPT_INVALID: REUSE: refused reason=run_not_success — run 300 attempt 1 concluded failure; ${PLATFORM} stays uncleared; fix: rerun c.yml (gh run rerun 300, or gh workflow run c.yml --ref <branch>), then gstack-pregate clear --remote ${PLATFORM} --run-url <the green run's URL>`);
    write({ 'u.yml': 'name: Unrelated\non: [push]\njobs:\n  native:\n    uses: ./.github/workflows/r.yml\n' });
    fs.rmSync(path.join(dir, 'c.yml'));
    expect(msg(clearDecision(file, PLATFORM, { runUrl: url, evidence: runOfWorkflow(repo, head, 'u.yml', undefined, [{ name: 'native / Native tests', conclusion: 'success' }]) }, repo.work))).toBe(`PREGATE_RECEIPT_INVALID: REUSE: refused reason=workflow_mismatch — run 300 attempt 1 ran .github/workflows/u.yml, not .github/workflows/r.yml or a workflow that calls it (c.yml); ${PLATFORM} stays uncleared; fix: clear ${PLATFORM} with a run of its own workflow or of a workflow that calls it (c.yml): gh workflow run c.yml --ref <branch>, then gstack-pregate clear --remote ${PLATFORM} --run-url <that run's URL>`);
    expect(caller([{ name: 'Native (full) / Native tests', conclusion: 'success' }])).toBe(`cleared ${url}/attempts/1`);
  }, 120_000);

  test('on this repository\'s own workflows the Windows obligation is windows-smoke.yml/windows-smoke: a windows-smoke.yml run clears it, a run of any other workflow is refused (GSTA-203)', async () => {
    const lanes = discoverLanes(path.resolve(import.meta.dir, '..'), 'linux');
    const owed = lanes.filter(l => l.tier === 'platform' && l.platform === 'windows' && l.runsTests && !l.manual);
    const smoke = owed.find(l => l.workflow === 'windows-smoke.yml');
    expect(smoke?.id).toBe('windows-smoke.yml/windows-smoke');
    expect(owed.filter(l => l.workflow === 'windows-free-tests.yml').map(l => l.id)).toEqual([]);
    expect(lanes.find(l => l.id === 'windows-free-tests.yml/windows-free-shard')).toMatchObject({ manual: true });
    const repo = fixture();
    const head = repo.git('rev-parse', 'HEAD');
    const base = await pregateAt(repo);
    const file: PregateFile = { ...base, requires_remote: [...base.requires_remote!, { lane: smoke!.id, platform: 'windows', workflow: smoke!.workflow, job: smoke!.job, tests: smoke!.testFiles, receipt: null }] };
    const url = 'https://github.com/fx/fx/actions/runs/300';
    expect(clearDecision(file, smoke!.id, { runUrl: url, evidence: runOfWorkflow(repo, head, 'windows-smoke.yml') }, repo.work)).toEqual({ receipt: `${url}/attempts/1`, attested: false });
    for (const other of ['windows-free-tests.yml', 'free-tests.yml']) {
      const d = clearDecision(file, smoke!.id, { runUrl: url, evidence: runOfWorkflow(repo, head, other) }, repo.work);
      expect('refused' in d && `${d.refused}: ${d.message}`).toBe(`PREGATE_RECEIPT_INVALID: REUSE: refused reason=workflow_mismatch — run 300 attempt 1 ran .github/workflows/${other}, not .github/workflows/windows-smoke.yml; windows-smoke.yml/windows-smoke stays uncleared`);
    }
  }, 120_000);

  test('a lane the base profiles never falls back to an unverified record when the GitHub origin cannot be read', async () => {
    const repo = fixture({ run_profiles: PROFILES, remote_gate_runs: GATE_RUNS });
    const file = await pregateAt(repo);
    fs.mkdirSync(path.join(repo.work, '.gstack/tmp'), { recursive: true });
    fs.writeFileSync(path.join(repo.work, '.gstack/tmp/pregate.json'), JSON.stringify(file));
    const r = runBin(repo, 'gstack-pregate', ['clear', '--remote', LANE, '--run-url', 'https://github.com/fx/fx/actions/runs/200']);
    expect([r.status, r.err]).toEqual([EXIT.fail, expect.stringContaining(`${LANE} may have a run profile on the base branch, so it clears only with a verified --run`)]);
    expect(JSON.parse(fs.readFileSync(path.join(repo.work, '.gstack/tmp/pregate.json'), 'utf8')).requires_remote[0].receipt).toBeNull();
  }, 120_000);

  test('an unreadable base config refuses --run-url even on a lane with no profile, since the base may profile it', async () => {
    const repo = fixture();
    const base = await pregateAt(repo);
    const PLATFORM = 'test.yml/full-suite';
    const file: PregateFile = { ...base, requires_remote: [...base.requires_remote!, { lane: PLATFORM, platform: 'macos', workflow: 'test.yml', job: 'full-suite', tests: ['test/a.test.ts'], receipt: null }] };
    fs.mkdirSync(path.join(repo.work, '.gstack/tmp'), { recursive: true });
    fs.writeFileSync(path.join(repo.work, '.gstack/tmp/pregate.json'), JSON.stringify(file));
    repo.git('update-ref', '-d', 'refs/remotes/origin/main');
    const r = runBin(repo, 'gstack-pregate', ['clear', '--remote', PLATFORM, '--run-url', 'https://github.com/fx/fx/actions/runs/200']);
    expect([r.status, r.err]).toEqual([EXIT.fail, expect.stringContaining(`${PLATFORM} may have a run profile on the base branch, so it clears only with a verified --run`)]);
    expect(JSON.parse(fs.readFileSync(path.join(repo.work, '.gstack/tmp/pregate.json'), 'utf8')).requires_remote.find((o: { lane: string }) => o.lane === PLATFORM).receipt).toBeNull();
  }, 120_000);

  test('offline verify refuses a run receipt recorded for another tree', async () => {
    const repo = fixture();
    const file = await pregateAt(repo);
    const forged = clearObligation(file, LANE, `remote-gate tree=${'0'.repeat(12)} tests=10 runs=200/1 profiles=test heads=${'1'.repeat(12)} verified=2026-10-29T12:00:00.000Z`, 'test');
    expect(verifyPregate(repo.work, forged, { tree: file.tree } as any)).toMatchObject({ ok: false, code: 'PREGATE_REMOTE_UNCLEARED' });
  }, 120_000);

  test('every run is read again once the clear is assembled: a run that turns red while another profile or the inventory is read refuses', async () => {
    const repo = fixture();
    const head = repo.git('rev-parse', 'HEAD');
    const file = await pregateAt(repo);
    const base = check(repo, [{ id: 200, profile: 'test', head, files: ['test/a.test.ts', 'test/util.test.js'] }, { id: 201, profile: 'e2e', head, files: ['test/b.test.ts'] }]);
    let flipped = false;
    const evidence: RunCheck = { ...base, deps: { ...base.deps, run: id => flipped && id === 200 ? { ...base.deps.run(id), run_attempt: 2, conclusion: 'failure' } : base.deps.run(id) }, inventory: () => { flipped = true; return ['test/a.test.ts', 'test/b.test.ts']; } };
    const d = clearDecision(file, LANE, { runs: ['200', '201'], evidence }, repo.work);
    expect('refused' in d && d.message).toContain('REUSE: refused reason=run_changed — run 200 moved to attempt 2 (failure)');
  }, 120_000);

  test('origin is read before url.insteadOf, so a Capy git.capy.ai proxy still names the GitHub repository', async () => {
    const repo = fixture();
    const file = await pregateAt(repo);
    fs.mkdirSync(path.join(repo.work, '.gstack/tmp'), { recursive: true });
    fs.writeFileSync(path.join(repo.work, '.gstack/tmp/pregate.json'), JSON.stringify(file));
    repo.git('remote', 'set-url', 'origin', 'https://github.com/fx/fx.git');
    repo.git('config', 'url.https://git.capy.ai/.insteadOf', 'https://github.com/');
    expect(repo.git('remote', 'get-url', 'origin')).toBe('https://git.capy.ai/fx/fx.git');
    const r = runBin(repo, 'gstack-pregate', ['clear', '--remote', LANE, '--run', '200', '--run', '201', '--allow-repo-commands']);
    expect(r.err).not.toContain('origin is not a github.com repository');
    expect([r.status, r.err]).toEqual([EXIT.usage, expect.stringContaining('declares remote_gate_runs')]);
  }, 120_000);

  test('the bin refuses --run when the base declares no run profiles, and keeps the --receipt route unchanged', async () => {
    const repo = fixture();
    const file = await pregateAt(repo);
    fs.mkdirSync(path.join(repo.work, '.gstack/tmp'), { recursive: true });
    fs.writeFileSync(path.join(repo.work, '.gstack/tmp/pregate.json'), JSON.stringify(file));
    repo.git('remote', 'set-url', 'origin', 'https://github.com/fx/fx.git');
    const r = runBin(repo, 'gstack-pregate', ['clear', '--remote', LANE, '--run', '200', '--run', '201', '--allow-repo-commands']);
    expect(r.status).toBe(EXIT.usage);
    expect(r.err).toContain('--run clears pregate.json/remote_gate only when the base branch\'s .gstack/pregate.json declares remote_gate_runs');
  }, 120_000);
});
