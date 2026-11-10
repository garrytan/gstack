/**
 * GST-1024: gstack's own .gstack/pregate.json declares remote_gate_runs, so a green Free Tests run at the pregate tree
 * clears pregate.json/remote_gate through `gstack-pregate clear --run`. The declaration's commands run against this
 * checkout (the inventory must be exactly the free suite CI plans, the skipped list exactly the paid files
 * pregate-remote.sh leaves to the paid gate); the clear runs through buildRunCheck in a fixture repository with this
 * repository's real run profile and a fake Actions API shaped like a real Free Tests pull_request run (41484634592).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bunIsolationArgs } from '../lib/bun-isolation';
import { buildContext } from '../lib/pregate/context';
import { clearDecision, runPregate, type RunCheck } from '../lib/pregate/index';
import { buildRunCheck } from '../lib/pregate/run-check';
import { runInventory, runProfileErrors, type ApiRun, type RemoteGateRuns, type RunProfile } from '../lib/run-evidence';
import { isPaidTestFile } from './helpers/paid-test-set';
import { BASE_PREGATE, cleanup, commit, makeFixtureRepo, type FixtureRepo } from './helpers/pregate-fixture';

const ROOT = path.resolve(import.meta.dir, '..');
const REAL = JSON.parse(fs.readFileSync(path.join(ROOT, '.gstack/pregate.json'), 'utf8')) as { run_profiles: Record<string, RunProfile>; remote_gate_runs?: RemoteGateRuns };
const LANE = 'pregate.json/remote_gate';
const PROFILE = 'ci-reuse/free-tests';
const PAID = 'test/skill-e2e-ship-gate.test.ts';

const dirs: string[] = [];
const repos: FixtureRepo[] = [];
afterEach(() => {
  while (repos.length) cleanup(repos.pop()!);
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gst1024-')); dirs.push(d); return d; };
const lines = (text: string) => text.split('\n').filter(Boolean);

describe.skipIf(process.platform === 'win32')('gstack declares remote_gate_runs (GST-1024)', () => {
  test('the declaration names the Free Tests profile; its inventory is exactly the free suite CI plans, and its skipped list is exactly the selected paid files', () => {
    const g = REAL.remote_gate_runs;
    expect(g?.profiles).toEqual([PROFILE]);
    expect(REAL.run_profiles[PROFILE]).toMatchObject({ workflow: 'free-tests.yml', artifact: 'tested-tree', os: 'Linux' });
    expect(runProfileErrors(REAL.run_profiles, g)).toEqual([]);
    const listed = runInventory(g!.inventory, ROOT);
    if ('error' in listed) throw new Error(listed.error);
    const planFile = path.join(tmp(), 'plan.json');
    const plan = spawnSync('bun', [...bunIsolationArgs(), 'run', 'scripts/test-free-shards.ts', '--ci-plan', planFile, '--shards', '11', '--shard-jobs', '2'], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
    expect(plan.status).toBe(0);
    const planned = (JSON.parse(fs.readFileSync(planFile, 'utf8')) as { shards: Array<{ files: string[] }> }).shards.flatMap(s => s.files);
    expect(listed.length).toBeGreaterThan(1000);
    expect([...listed].sort()).toEqual([...new Set(planned)].sort());
    expect(listed.filter(isPaidTestFile)).toEqual([]);
    const selected = path.join(tmp(), 'selected.txt');
    fs.writeFileSync(selected, [listed[0], PAID, 'test/codex-e2e-plan-format.test.ts', listed[1]].join('\n') + '\n');
    const skipped = runInventory(g!.skipped!, ROOT, { PREGATE_FILES_FILE: selected });
    expect(skipped).toEqual([PAID, 'test/codex-e2e-plan-format.test.ts']);
  }, 180_000);
});

const INVENTORY = 'printf "test/tool-cli.test.js\\ntest/other.test.js\\n"';
const SKIPPED = 'grep -E "^test/skill-e2e-" "$PREGATE_FILES_FILE" || true';

function fixture(gateRuns: Record<string, unknown>): FixtureRepo {
  const repo = makeFixtureRepo({ pregate: { ...BASE_PREGATE, remote_gate: 'node scripts/remote-gate.js', run_profiles: REAL.run_profiles, remote_gate_runs: gateRuns } });
  repos.push(repo);
  repo.git('checkout', '-q', 'main');
  commit(repo, { 'scripts/remote-gate.js': "console.log('PREGATE_REMOTE: tree=' + process.env.PREGATE_TREE + ' tests=3 failed=0');\n" }, 'remote gate');
  repo.git('push', '-q', 'origin', 'main');
  repo.git('checkout', '-q', 'feature');
  repo.git('merge', '-q', '--ff-only', 'main');
  commit(repo, { 'lib/util.js': 'exports.add = (a, b) => a + b + 0;\n' }, 'the real change');
  return repo;
}

/** A Free Tests pull_request run as GitHub reports it: the profile's jobs, a tested-tree artifact naming the merge commit. */
interface Run { head: string; files: string[]; conclusion?: string; path?: string; headRepo?: string; mergeTree?: string }
function gateCheck(repo: FixtureRepo, run: Run): RunCheck {
  const built = buildRunCheck(repo.work, LANE, true, 'main');
  if ('error' in built) throw new Error(built.error);
  const profile = REAL.run_profiles[PROFILE]!;
  const merge = 'f'.repeat(40);
  const finished = new Date(Date.now() - 3600_000).toISOString();
  const api: ApiRun = {
    id: 41484634592, run_attempt: 1, status: 'completed', conclusion: run.conclusion ?? 'success', event: 'pull_request', head_sha: run.head,
    path: run.path ?? `.github/workflows/${profile.workflow}`, created_at: finished, updated_at: finished,
    repository: { full_name: 'fx/fx' }, head_repository: { full_name: run.headRepo ?? 'fx/fx' },
  };
  const tree = (sha: string) => repo.git('rev-parse', `${sha}^{tree}`);
  return {
    ...built,
    repo: 'fx/fx',
    deps: {
      run: id => { if (id !== api.id) throw new Error('HTTP 404'); return api; },
      runsForHead: () => [api],
      jobs: () => profile.jobs.map(name => ({ name, conclusion: 'success', completed_at: finished })),
      artifact: () => ({ run_id: api.id, run_attempt: 1, event: 'pull_request', sha: merge, head_sha: run.head, tree: tree(run.head), workflow: profile.workflow, os: ['Linux', 'macOS', 'Windows'], files: run.files, tests: run.files.length * 20 }),
      commitTree: sha => (sha === merge ? run.mergeTree ?? tree(run.head) : tree(sha)),
    },
  };
}

async function gatedFile(repo: FixtureRepo) {
  const loaded = buildContext({ repoRoot: repo.work, base: 'main', policyFrom: 'base', allowRepoCommands: true, env: { ...process.env, ...repo.env }, progress: () => {}, cores: 4, testBackend: 'local' });
  if (!('ctx' in loaded)) throw new Error('fixture context refused');
  const file = await runPregate(loaded.ctx, { stage: 'tests' });
  const gate = file.requires_remote?.find(r => r.lane === LANE);
  if (!gate) throw new Error('no remote gate obligation');
  gate.tests = [...(gate.tests ?? []), PAID];
  repo.git('config', 'remote.origin.url', 'https://github.com/fx/fx.git');
  return { file, selected: gate.tests.filter(f => f !== PAID) };
}

describe.skipIf(process.platform === 'win32')('clear --run with the Free Tests profile (GST-1024)', () => {
  const RUN = 'https://github.com/fx/fx/actions/runs/41484634592';
  const msg = (d: ReturnType<typeof clearDecision>) => ('refused' in d ? `${d.refused}: ${d.message}` : `cleared ${d.receipt}`);

  test('a green Free Tests run at the pregate tree clears the gate; the selected paid file the gate skips is counted, not required', async () => {
    const repo = fixture({ profiles: [PROFILE], inventory: INVENTORY, skipped: SKIPPED });
    const head = repo.git('rev-parse', 'HEAD');
    const { file, selected } = await gatedFile(repo);
    const files = [...new Set([...selected, 'test/tool-cli.test.js', 'test/other.test.js'])];
    const d = clearDecision(file, LANE, { runs: [RUN], evidence: gateCheck(repo, { head, files }) }, repo.work);
    expect(msg(d)).toStartWith(`cleared remote-gate tree=${file.tree.slice(0, 12)} tests=${files.length * 20} skipped=1 runs=41484634592/1 profiles=${PROFILE} heads=${head.slice(0, 12)} verified=`);
  }, 120_000);

  test('refusals: no skipped command, a paid-only selection, the wrong tree, the wrong workflow, a failed or cancelled run, a fork run, a merge behind its base, an uncovered inventory file, a skipped list that names an inventory file', async () => {
    const repo = fixture({ profiles: [PROFILE], inventory: INVENTORY, skipped: SKIPPED });
    const older = repo.git('rev-parse', 'HEAD~1');
    const head = repo.git('rev-parse', 'HEAD');
    const { file, selected } = await gatedFile(repo);
    const files = [...new Set([...selected, 'test/tool-cli.test.js', 'test/other.test.js'])];
    const clear = (run: Run, over: Partial<RunCheck> = {}) => msg(clearDecision(file, LANE, { runs: [RUN], evidence: { ...gateCheck(repo, run), ...over } }, repo.work));
    expect(clear({ head, files }, { gateRuns: { profiles: [PROFILE], inventory: INVENTORY } })).toMatch(new RegExp(`reason=inventory_uncovered — 1 of the \\d+ test file\\(s\\) ${LANE} must cover appear in no run's tree.json \\(${PAID}\\)`));
    expect(clear({ head: older, files })).toMatch(/^PREGATE_RECEIPT_INVALID: REUSE: refused reason=tree_not_stamp_only — .*lib\/util\.js/);
    expect(clear({ head, files, path: '.github/workflows/windows-free-tests.yml' })).toContain('reason=workflow_mismatch run 41484634592 attempt 1 ran .github/workflows/windows-free-tests.yml, not .github/workflows/free-tests.yml');
    expect(clear({ head, files, conclusion: 'failure' })).toContain('reason=run_not_success run 41484634592 attempt 1 concluded failure');
    expect(clear({ head, files, conclusion: 'cancelled' })).toContain('reason=run_not_success run 41484634592 attempt 1 concluded cancelled');
    expect(clear({ head, files, headRepo: 'attacker/fx' })).toContain('reason=fork_run run 41484634592 attempt 1 ran for attacker/fx, not fx/fx');
    expect(clear({ head, files, mergeTree: repo.git('rev-parse', `${older}^{tree}`) })).toContain('reason=tree_mismatch');
    expect(clear({ head, files: files.filter(f => f !== 'test/other.test.js') })).toContain("reason=inventory_uncovered — 1 of the");
    expect(clear({ head, files: files.filter(f => f !== 'test/other.test.js') }, { gateRuns: { profiles: [PROFILE], inventory: INVENTORY, skipped: `${SKIPPED}; echo test/other.test.js` } })).toContain('(test/other.test.js)');
    expect(clear({ head, files }, { gateRuns: { profiles: [PROFILE], inventory: INVENTORY, skipped: 'exit 3' } })).toContain('reason=skipped_failed');
    expect(clear({ head, files }, { gateRuns: { profiles: [PROFILE], inventory: INVENTORY, skipped: 'exit 3' } })).not.toContain('no installed dependencies');
    expect(clear({ head, files }, { gateRuns: { profiles: [PROFILE], inventory: INVENTORY, skipped: "echo 'TypeError: x at /repo/node_modules/zod/index.js:1' >&2; exit 1" } })).not.toContain('no installed dependencies');
    expect(clear({ head, files }, { gateRuns: { profiles: [PROFILE], inventory: INVENTORY, skipped: "echo \"error: Cannot find package 'zod' from '/x/test/helpers/paid-test-set.ts'\" >&2; exit 1" } })).toContain('reason=skipped_failed — the remote gate\'s skipped command failed because this checkout has no installed dependencies (install them, for example with bun install, then clear again): ');
    const paidOnly = structuredClone(file);
    paidOnly.requires_remote!.find(r => r.lane === LANE)!.tests = [PAID];
    expect(msg(clearDecision(paidOnly, LANE, { runs: [RUN], evidence: gateCheck(repo, { head, files }) }, repo.work))).toBe(`PREGATE_RECEIPT_INVALID: REUSE: refused reason=paid_only — the remote gate skips every selected test file (1), so no selected test ran; like the gate's own tests=0 report, that never clears; ${LANE} stays uncleared`);
  }, 120_000);

  test('remote_gate_runs.skipped must be one command line, and an unknown key names it as valid', () => {
    const profiles = { p: { workflow: 'w.yml', events: ['push'], jobs: ['j'], artifact: 'a' } };
    for (const skipped of [3, '', ' ', 'a\nb', 'x'.repeat(513)]) {
      expect(runProfileErrors(profiles, { profiles: ['p'], inventory: 'echo t', skipped }).map(e => e.path)).toEqual(['remote_gate_runs.skipped']);
    }
    expect(runProfileErrors(profiles, { profiles: ['p'], inventory: 'echo t', skipped: 'echo s' })).toEqual([]);
    expect(runProfileErrors(profiles, { profiles: ['p'], inventory: 'echo t', skip: 'echo s' })).toEqual([{ path: 'remote_gate_runs.skip', message: 'unknown key; valid keys: profiles, inventory, skipped' }]);
  });
});
