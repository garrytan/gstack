/**
 * CI carry and the remote gate (GSTA-258 A): after a verified CI run carries part of the tests stage on a small
 * machine, the files left over can all be ones the remote gate never runs (gstack's paid evals). The gate itself then
 * reports tests=0 (PREGATE_REMOTE_PAID_ONLY) and `clear --run` refuses paid_only, so the obligation could never clear.
 * The carried run clears it instead, through remote_gate_runs and its inventory check. The run API is a fake.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { PregateFile } from '../lib/headless-artifacts';
import { buildContext } from '../lib/pregate/context';
import { clearDecision, runPregate, type RunCheck } from '../lib/pregate/index';
import type { ApiRun, RunProfile } from '../lib/run-evidence';
import { BASE_PREGATE, cleanup, commit, makeFixtureRepo, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

const LANE = 'pregate.json/remote_gate';
const NOW = new Date('2026-11-02T12:00:00Z');
const LOCAL_OS = process.platform === 'darwin' ? 'macOS' : 'Linux';
const PROFILE: RunProfile = { workflow: 'free-tests.yml', events: ['pull_request', 'workflow_dispatch'], jobs: ['unit'], artifact: 'tested-tree', os: LOCAL_OS };
const PAID = 'test/nightly/retry-heavy.test.js';
const FREE = ['test/retry.test.js', 'test/util.test.js'];

function fixture(): FixtureRepo {
  const repo = makeFixtureRepo({ pregate: { ...BASE_PREGATE, remote_gate: 'node scripts/remote-gate.js' } });
  repos.push(repo);
  commit(repo, { 'lib/util.js': 'exports.add = (a, b) => a + b + 0;\n', 'lib/retry.js': 'exports.MAX_RETRIES = 3;\nexports.TIMEOUT_MS = 5000;\nexports.retry = (fn) => fn();\nexports.touched = true;\n' }, 'touch two subjects');
  return repo;
}

/** Run 100 of free-tests.yml at HEAD, green, its tree.json listing `files`; the gate's inventory is FREE and its skipped command names PAID. */
function runCheck(repo: FixtureRepo, files: string[]): RunCheck {
  const head = repo.git('rev-parse', 'HEAD');
  const api: ApiRun = { id: 100, run_attempt: 1, status: 'completed', conclusion: 'success', event: 'workflow_dispatch', head_sha: head, path: '.github/workflows/free-tests.yml', created_at: '2026-11-02T10:00:00Z', updated_at: '2026-11-02T10:30:00Z', repository: { full_name: 'fx/fx' }, head_repository: { full_name: 'fx/fx' } };
  return {
    repo: 'fx/fx', profiles: { 'ci-reuse/free-tests': PROFILE }, now: NOW,
    gateRuns: { profiles: ['ci-reuse/free-tests'], inventory: 'INVENTORY', skipped: 'SKIPPED' },
    inventory: (command, _tree, selected) => (command === 'SKIPPED' ? (selected ?? []).filter(f => f === PAID) : FREE),
    deps: {
      run: () => api, runsForHead: (_wf, sha) => (sha === head ? [api] : []), jobs: () => [{ name: 'unit', conclusion: 'success' }],
      artifact: () => ({ run_id: 100, run_attempt: 1, event: 'workflow_dispatch', sha: head, head_sha: head, tree: repo.git('rev-parse', 'HEAD^{tree}'), os: [LOCAL_OS], files, tests: files.length * 4 }),
      commitTree: sha => repo.git('rev-parse', `${sha}^{tree}`),
    },
  } as RunCheck;
}

async function carried(repo: FixtureRepo, check: RunCheck): Promise<{ file: PregateFile; progress: string[] }> {
  const progress: string[] = [];
  const loaded = buildContext({ repoRoot: repo.work, base: 'main', policyFrom: 'base', allowRepoCommands: true, env: { ...process.env, ...repo.env }, progress: l => progress.push(l), cores: 4, testBackend: 'local' });
  if (!('ctx' in loaded)) throw new Error('fixture context refused');
  loaded.ctx.fromRun = { ref: '100', check };
  return { file: await runPregate(loaded.ctx, { stage: 'tests' }), progress };
}
const gate = (file: PregateFile) => file.requires_remote?.find(r => r.lane === LANE);

describe.skipIf(process.platform === 'win32')('CI carry clears the remote gate on a small machine', () => {
  // Value: protects=a carried run whose remainder is only gate-skipped (paid) files leaves no obligation nothing can clear;
  //   fails_when=the remainder stays a remote_gate obligation that the gate reports tests=0 for and clear --run refuses paid_only;
  //   why_new=GSTA-258 A, the PREGATE_REMOTE_PAID_ONLY dead end seen at 0fba5533 (112 paid files after run 41554380563); seam=runPregate with a fake run API
  test('the carried run clears the gate when only skipped files remain, and the receipt counts them', async () => {
    const repo = fixture();
    const check = runCheck(repo, FREE);
    const { file, progress } = await carried(repo, check);
    const obligation = gate(file)!;
    expect(obligation.tests).toEqual([PAID]);
    expect(clearDecision({ ...file, requires_remote: [{ ...obligation, receipt: null }] }, LANE, { runs: ['100'], evidence: check }, repo.work)).toMatchObject({ refused: 'PREGATE_RECEIPT_INVALID', message: expect.stringContaining('reason=paid_only') });
    expect([obligation.receipt, obligation.cleared_by]).toEqual([expect.stringMatching(new RegExp(`^remote-gate tree=${file.tree.slice(0, 12)} tests=8 skipped=1 runs=100/1 `)), 'ci-carry']);
    expect(progress).toContain(`CI_CARRY: cleared ${LANE} ${obligation.receipt}`);
    expect(file.verdict).toBe('requires-remote cleared');
  }, 120_000);

  // Value: protects=the carry clears the gate only under clear --run's own checks; fails_when=a run that misses an inventory file clears it
  test('a run that misses a gate inventory file leaves the gate uncleared and says why', async () => {
    const repo = fixture();
    const { file, progress } = await carried(repo, runCheck(repo, ['test/util.test.js']));
    expect(gate(file)?.receipt).toBeNull();
    expect(progress).toContainEqual(expect.stringMatching(new RegExp(`^CI_CARRY: ${LANE} stays uncleared \\(REUSE: refused reason=inventory_uncovered`)));
  }, 120_000);

  // Value: protects=when the base declares remote_gate_runs, the uncleared gate names the CI route first and the VM only as an opt-in;
  //   fails_when=the obligation sends an agent to the paid VM while a CI run at the same tree would clear it; why_new=GSTA-258 A, plan choice F1
  test('with remote_gate_runs on the base, an uncleared gate names the CI route first and the VM as the opt-in', async () => {
    const repo = makeFixtureRepo({ pregate: { ...BASE_PREGATE, remote_gate: 'node scripts/remote-gate.js', run_profiles: { 'ci-reuse/free-tests': PROFILE }, remote_gate_runs: { profiles: ['ci-reuse/free-tests'], inventory: 'echo test/retry.test.js' } } });
    repos.push(repo);
    commit(repo, { 'lib/retry.js': 'exports.MAX_RETRIES = 3;\nexports.TIMEOUT_MS = 5000;\nexports.retry = (fn) => fn();\nexports.touched = 2;\n' }, 'touch retry');
    const loaded = buildContext({ repoRoot: repo.work, base: 'main', policyFrom: 'base', allowRepoCommands: true, env: { ...process.env, ...repo.env }, progress: () => {}, cores: 4, testBackend: 'local' });
    if (!('ctx' in loaded)) throw new Error('fixture context refused');
    const file = await runPregate(loaded.ctx, { stage: 'tests' });
    expect(gate(file)?.receipt).toBeNull();
    const detail = file.checks.find(c => c.id === 'lanes')?.detail ?? '';
    expect(detail).toContain(`a verified CI run at this tree clears it: push, then gstack-ci-carry wait --base main and rerun gstack-pregate --allow-repo-commands`);
    expect(detail.indexOf('gstack-ci-carry wait')).toBeLessThan(detail.indexOf('opt in to the VM: gstack-pregate --remote --spend-cap <usd> --allow-repo-commands'));
    loaded.ctx.ciCarry = false;
    const off = (await runPregate(loaded.ctx, { stage: 'tests' })).checks.find(c => c.id === 'lanes')?.detail ?? '';
    expect(off).not.toContain('gstack-ci-carry wait');
    expect(off).toContain('run it, then gstack-pregate clear --remote pregate.json/remote_gate');
  }, 120_000);
});
