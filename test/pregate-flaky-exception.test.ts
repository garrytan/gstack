/**
 * gstack-pregate clear --flaky-exception (GST-1096): a red GitHub Actions run clears a requires-remote obligation only
 * when every failure is named from the run's own shard results and logs, each named file is outside the PR's diff and
 * its import closure, at most three cases, none paid or a security scan, and an owner's gstack-approvals row binds the
 * repository, PR, head, tree, lane, run, attempt and cases. verify prints pass-with-exception, ready prints
 * FLAKY_EXCEPTION and still needs green CI (pregate only), and the receipt records it. The run API is a fake; trees
 * come from the fixture repository's git.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT, type PregateFile } from '../lib/headless-artifacts';
import { buildContext } from '../lib/pregate/context';
import { clearDecision, clearObligation, runPregate, verifyPregate, type ClearDecision, type RunCheck } from '../lib/pregate/index';
import { exceptionBinding, type FailureDeps, type GrantRow } from '../lib/pregate/flaky-exception';
import type { ApiJob, ApiRun, RunDeps, RunProfile } from '../lib/run-evidence';
import { BASE_PREGATE, cleanup, commit, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/pregate-fixture';
import { cleanup as cleanupQueue, makeFixtureRepo as makeQueueRepo, makePr, runBin as runQueueBin } from './helpers/restamp-fixture';
import { ghQueueShim } from './helpers/ship-queue-fixture';
import { shippedBody } from './helpers/ship-queue-train-fixture';

const repos: FixtureRepo[] = [];
const queueRepos: Array<ReturnType<typeof makeQueueRepo>> = [];
afterEach(() => {
  while (repos.length) cleanup(repos.pop()!);
  while (queueRepos.length) cleanupQueue(queueRepos.pop()!);
});

const LANE = 'pregate.json/remote_gate';
const NOW = new Date('2026-10-29T12:00:00Z');
const PROFILE_NAME = 'ci-reuse/free-tests';
const PROFILE: RunProfile = { workflow: 'free-tests.yml', events: ['pull_request', 'workflow_dispatch'], jobs: ['free-plan', 'typecheck', 'free-tests'], artifact: 'tested-tree' };
const GATE_RUNS = { profiles: [PROFILE_NAME], inventory: 'true' };
const FLAKE = 'test/retry.test.js::retries three times';
const WORDS = 'yes, accept the retry timing flake for this head';

function fixture(): FixtureRepo {
  const repo = makeFixtureRepo({ pregate: { ...BASE_PREGATE, remote_gate: 'node scripts/remote-gate.js' } });
  repos.push(repo);
  commit(repo, { 'lib/util.js': 'exports.add = (a, b) => a + b + 0;\n' }, 'the real change');
  return repo;
}

async function pregateAt(repo: FixtureRepo): Promise<PregateFile> {
  const loaded = buildContext({ repoRoot: repo.work, base: 'main', policyFrom: 'base', allowRepoCommands: true, env: { ...process.env, ...repo.env }, progress: () => {}, cores: 4, testBackend: 'local' });
  if (!('ctx' in loaded)) throw new Error('fixture context refused');
  const file = await runPregate(loaded.ctx, { stage: 'tests' });
  expect(file.requires_remote).toEqual([expect.objectContaining({ lane: LANE, receipt: null })]);
  return file;
}

interface Shard { files: string[]; failures?: Array<[string | null, string]>; status?: 'passed' | 'failed' | 'timed-out'; unattributed?: number; retry?: { files: string[]; failures: Array<[string, string]> }; log?: string | null }
interface RunOver { conclusion?: string; jobs?: (jobs: ApiJob[]) => ApiJob[]; missing?: string[]; pull?: { head_sha: string; state: string; head_repo: string | null }; newer?: boolean; attemptAfter?: number; api?: Partial<ApiRun> }

const DEFAULT_SHARDS: Shard[] = [
  { files: ['test/retry.test.js', 'test/a.test.ts'], failures: [['test/retry.test.js', 'retries three times']] },
  { files: ['test/b.test.ts', 'test/util.test.js', 'test/config-read.test.js', 'test/tool-cli.test.js'] },
];

function logFor(s: Shard, names: Array<[string | null, string]>): string {
  const lines: string[] = [];
  for (const f of s.files) {
    lines.push(`${f}:`);
    for (const [file, name] of names) if (file === f) lines.push(`(fail) ${name} [5005.00ms]`);
  }
  lines.push(`Ran ${s.files.length * 3} tests across ${s.files.length} files. [12.00s]`);
  return lines.join('\n') + '\n';
}

/** Run 400: a red workflow_dispatch Free Tests run on `head` whose shard artifacts and logs say what failed. */
function redRun(repo: FixtureRepo, head: string, shards: Shard[] = DEFAULT_SHARDS, over: RunOver = {}): RunCheck & { failures: FailureDeps } {
  const plan = { version: 1, revision: head, id: 'plan-1', shards: shards.map((s, i) => ({ shard: i + 1, files: s.files, predictedMs: 1000 })) };
  const statusOf = (s: Shard) => s.status ?? (s.failures?.length || s.unattributed ? 'failed' : 'passed');
  const finalFailed = (s: Shard) => statusOf(s) !== 'passed' && !(s.retry && s.retry.failures.length === 0);
  const outcome = (s: Shard, i: number, files: string[], failures: Array<[string | null, string]>, status: string) => ({
    shard: i + 1, files, status, exitCode: status === 'passed' ? 0 : 1, elapsedMs: 1000, groupPid: null,
    summary: { testsRan: files.length * 3, filesRan: files.length, sawTerminalSummary: status !== 'timed-out' },
    failingFiles: [...new Set(failures.map(([f]) => f).filter((f): f is string => !!f))], unattributedFailures: s.unattributed ?? 0,
    failures: failures.map(([file, testName]) => ({ file, testName })),
  });
  const artifacts: Record<string, Record<string, string>> = { 'free-plan': { 'free-plan.json': JSON.stringify(plan) } };
  shards.forEach((s, i) => {
    const retry = s.retry ? outcome({ files: s.retry.files }, i, s.retry.files, s.retry.failures, s.retry.failures.length ? 'failed' : 'passed') : null;
    artifacts[`free-result-${i + 1}`] = { [`shard-${i + 1}.json`]: JSON.stringify({ planId: 'plan-1', revision: head, outcome: outcome(s, i, s.files, s.failures ?? [], statusOf(s)), retry }) };
    if (statusOf(s) !== 'passed' && s.log !== null) artifacts[`free-test-shard-logs-${i + 1}`] = { [`gstack-free-test-${i + 1}.log`]: s.log ?? logFor(s, [...(s.failures ?? []), ...(s.retry?.failures ?? [])]) };
  });
  for (const m of over.missing ?? []) delete artifacts[m];
  const anyFailed = shards.some(finalFailed);
  const at = '2026-10-29T10:30:00Z';
  const baseJobs: ApiJob[] = [
    { name: 'reuse', conclusion: 'skipped', completed_at: at },
    { name: 'free-plan', conclusion: 'success', completed_at: at },
    { name: 'typecheck', conclusion: 'success', completed_at: at },
    ...shards.map((s, i) => ({ name: `free-suite (${i + 1})`, conclusion: finalFailed(s) ? 'failure' : 'success', completed_at: at })),
    { name: 'free-tests', conclusion: anyFailed ? 'failure' : 'success', completed_at: at },
  ];
  const jobs = over.jobs ? over.jobs(baseJobs) : baseJobs;
  let reads = 0;
  const api = (): ApiRun => ({
    id: 400, run_attempt: reads++ > 0 && over.attemptAfter ? over.attemptAfter : 1, status: 'completed', conclusion: over.conclusion ?? (anyFailed ? 'failure' : 'success'), event: 'workflow_dispatch', head_sha: head,
    path: '.github/workflows/free-tests.yml', created_at: '2026-10-29T10:00:00Z', updated_at: at, repository: { full_name: 'fx/fx' }, head_repository: { full_name: 'fx/fx' }, ...over.api,
  });
  const deps: RunDeps = {
    run: id => { if (id !== 400) throw new Error('HTTP 404'); return api(); },
    runsForHead: () => [{ ...api(), run_attempt: 1 }, ...(over.newer ? [{ ...api(), id: 401, run_attempt: 1, created_at: '2026-10-29T11:00:00Z', run_started_at: '2026-10-29T11:00:00Z' }] : [])],
    jobs: () => jobs,
    artifact: () => { throw new Error('run 400 has 0 unexpired artifacts named tested-tree'); },
    commitTree: sha => repo.git('rev-parse', `${sha}^{tree}`),
  };
  const failures: FailureDeps = {
    artifactFiles: (_id, name) => { const a = artifacts[name]; if (!a) throw new Error(`run 400 has 0 unexpired artifacts named ${name}`); return a; },
    pull: () => over.pull ?? { head_sha: head, state: 'open', head_repo: 'fx/fx' },
  };
  return { repo: 'fx/fx', deps, profiles: { [PROFILE_NAME]: PROFILE }, gateRuns: GATE_RUNS, now: NOW, inventory: () => ['test/a.test.ts', 'test/b.test.ts'], failures };
}

const msg = (d: ClearDecision) => ('refused' in d ? `${d.refused}: ${d.message}${d.fix ? `; fix: ${d.fix}` : ''}` : `cleared ${d.receipt}`);

/** The scope the grant-needed refusal names, as an approvals row the owner granted. */
function grantFor(d: ClearDecision, over: Partial<GrantRow> = {}): (id: string) => GrantRow | null {
  const scope = /--scope "(flaky-exception:[0-9a-f]{64})"/.exec(msg(d))?.[1];
  if (!scope) throw new Error(`no grant scope in: ${msg(d)}`);
  return id => (id === 'a-1' ? { id, outcome: 'approved', scope, words: WORDS, by: 'Garry', ...over } : null);
}

describe.skipIf(process.platform === 'win32')('clear --flaky-exception: an owner-granted exception for named flaky cases', () => {
  test('a red run whose only failure is the named case clears the gate once the bound grant exists; verify reports pass-with-exception', async () => {
    const repo = fixture();
    const head = repo.git('rev-parse', 'HEAD');
    const file = await pregateAt(repo);
    const check = redRun(repo, head);
    const asked = clearDecision(file, LANE, { runs: ['400'], evidence: check, flaky: { cases: [FLAKE], pr: 7 } }, repo.work);
    expect(msg(asked)).toMatch(/^PREGATE_RECEIPT_INVALID: FLAKY_EXCEPTION: refused reason=grant_needed — .*test\/retry\.test\.js::retries three times.*; fix: .*gstack-approvals add --ask '.*' --words "<the owner's exact words>" --by "<owner>" --scope "flaky-exception:[0-9a-f]{64}" --source pregate-flaky-exception/);
    const d = clearDecision(file, LANE, { runs: ['400'], evidence: check, flaky: { cases: [FLAKE], pr: 7, grant: 'a-1', grantRow: grantFor(asked) } }, repo.work);
    if ('refused' in d) throw new Error(d.message);
    expect(d.receipt).toBe(`remote-gate tree=${file.tree.slice(0, 12)} tests=18 exception=a-1 cases=1 runs=400/1 profiles=${PROFILE_NAME} heads=${head.slice(0, 12)} verified=2026-10-29T12:00:00.000Z`);
    expect(d.exception).toMatchObject({ lane: LANE, repo: 'fx/fx', pr: 7, head, tree: file.tree, runs: ['400/1'], cases: [FLAKE], grant: 'a-1', by: 'Garry', words: WORDS });
    const cleared = clearObligation(file, LANE, d.receipt, 'test', d.substitution, d.exception);
    expect(cleared.verdict).toBe('pass-with-exception');
    expect(cleared.exceptions).toEqual([d.exception!]);
    const v = verifyPregate(repo.work, cleared, { tree: file.tree } as any);
    expect(v).toMatchObject({ ok: true });
    expect(v.message).toContain(`flaky exception ${FLAKE} (grant a-1, by Garry, run 400/1)`);
    const tampered = (e: Partial<NonNullable<PregateFile['exceptions']>[number]>) => verifyPregate(repo.work, { ...cleared, exceptions: [{ ...cleared.exceptions![0]!, ...e }] }, { tree: file.tree } as any);
    expect(tampered({ head: 'f'.repeat(40) })).toMatchObject({ ok: false, code: 'PREGATE_REMOTE_UNCLEARED' });
    expect(tampered({ cases: [FLAKE, 'test/b.test.ts::other'] }).message).toContain('binding does not match');
    expect(verifyPregate(repo.work, { ...cleared, exceptions: [] }, { tree: file.tree } as any).message).toContain('no exceptions entry');
    const plain = clearObligation(structuredClone(cleared), LANE, `remote-gate tree=${file.tree.slice(0, 12)} tests=18 runs=401/1 profiles=${PROFILE_NAME} heads=${head.slice(0, 12)} verified=2026-10-29T12:00:00.000Z`, 'test');
    expect([plain.exceptions, plain.verdict]).toEqual([undefined, 'requires-remote cleared']);
  }, 120_000);

  test('the grant binds the head, PR, run and cases: another scope, an unapproved row, an agent\'s words or an unknown id refuse', async () => {
    const repo = fixture();
    const head = repo.git('rev-parse', 'HEAD');
    const file = await pregateAt(repo);
    const check = redRun(repo, head);
    const asked = clearDecision(file, LANE, { runs: ['400'], evidence: check, flaky: { cases: [FLAKE], pr: 7 } }, repo.work);
    const run = (grantRow: (id: string) => GrantRow | null, grant = 'a-1') => msg(clearDecision(file, LANE, { runs: ['400'], evidence: check, flaky: { cases: [FLAKE], pr: 7, grant, grantRow } }, repo.work));
    const otherHead = exceptionBinding({ lane: LANE, repo: 'fx/fx', pr: 7, head: 'e'.repeat(40), tree: file.tree, runs: ['400/1'], cases: [FLAKE] });
    expect(run(grantFor(asked, { scope: otherHead }))).toContain('reason=grant_mismatch');
    expect(run(grantFor(asked, { outcome: 'pending' }))).toContain('reason=grant_not_approved');
    expect(run(grantFor(asked, { by: 'agent:jam_123' }))).toContain('reason=grant_not_owner');
    expect(run(grantFor(asked), 'a-2')).toContain('reason=grant_missing');
  }, 120_000);

  test('every failure must be named: an extra failure, a case that did not fail, more than three cases, an unattributed failure refuse', async () => {
    const repo = fixture();
    const head = repo.git('rev-parse', 'HEAD');
    const file = await pregateAt(repo);
    const clear = (check: RunCheck, cases = [FLAKE]) => msg(clearDecision(file, LANE, { runs: ['400'], evidence: check, flaky: { cases, pr: 7 } }, repo.work));
    const two: Shard[] = [{ files: ['test/retry.test.js', 'test/a.test.ts'], failures: [['test/retry.test.js', 'retries three times'], ['test/a.test.ts', 'other']] }, DEFAULT_SHARDS[1]!];
    expect(clear(redRun(repo, head, two))).toContain('reason=unnamed_failure — run 400 attempt 1 failed test/a.test.ts::other, which no --flaky-exception names');
    expect(clear(redRun(repo, head), [FLAKE, 'test/a.test.ts::passed fine'])).toContain('reason=case_not_failed — test/a.test.ts::passed fine did not fail in run 400');
    expect(clear(redRun(repo, head), ['a.ts::1', 'b.ts::2', 'c.ts::3', 'd.ts::4'])).toBe('usage: --flaky-exception names at most 3 cases; got 4');
    expect(clear(redRun(repo, head), ['no-separator'])).toContain('usage: --flaky-exception takes "<test file>::<case>"');
    expect(clear(redRun(repo, head, [{ ...DEFAULT_SHARDS[0]!, unattributed: 1 }, DEFAULT_SHARDS[1]!]))).toContain('reason=unnamed_failure — shard 1: 1 failure(s) the runner could not attribute to a test');
    expect(clear(redRun(repo, head, [{ ...DEFAULT_SHARDS[0]!, failures: [[null, 'retries three times']] }, DEFAULT_SHARDS[1]!]))).toContain('reason=unnamed_failure');
    expect(clear(redRun(repo, head, [{ files: DEFAULT_SHARDS[0]!.files }, DEFAULT_SHARDS[1]!]))).toContain('reason=run_green');
  }, 120_000);

  test('every job, shard and log is reconciled: a failed non-shard job, a missing result or log, a timed-out shard, a log failure the result omits refuse', async () => {
    const repo = fixture();
    const head = repo.git('rev-parse', 'HEAD');
    const file = await pregateAt(repo);
    const clear = (check: RunCheck) => msg(clearDecision(file, LANE, { runs: ['400'], evidence: check, flaky: { cases: [FLAKE], pr: 7 } }, repo.work));
    expect(clear(redRun(repo, head, DEFAULT_SHARDS, { jobs: js => js.map(j => j.name === 'typecheck' ? { ...j, conclusion: 'failure' } : j) }))).toContain('reason=unnamed_failure — run 400 attempt 1\'s typecheck job concluded failure; only test-shard failures can be named');
    expect(clear(redRun(repo, head, DEFAULT_SHARDS, { jobs: js => js.map(j => j.name === 'reuse' ? { ...j, conclusion: 'cancelled' } : j) }))).toContain('reason=unnamed_failure — run 400 attempt 1\'s reuse job concluded cancelled');
    expect(clear(redRun(repo, head, DEFAULT_SHARDS, { jobs: js => js.filter(j => j.name !== 'free-suite (2)') }))).toContain('reason=shard_mismatch');
    expect(clear(redRun(repo, head, DEFAULT_SHARDS, { missing: ['free-result-2'] }))).toContain('reason=shard_incomplete — shard 2 has no readable free-result-2');
    expect(clear(redRun(repo, head, [{ ...DEFAULT_SHARDS[0]!, log: null }, DEFAULT_SHARDS[1]!]))).toContain('reason=logs_missing — shard 1 failed and has no readable free-test-shard-logs-1');
    expect(clear(redRun(repo, head, [{ ...DEFAULT_SHARDS[0]!, status: 'timed-out' }, DEFAULT_SHARDS[1]!]))).toContain('reason=shard_incomplete — shard 1 timed out');
    const extraInLog = logFor(DEFAULT_SHARDS[0]!, [['test/retry.test.js', 'retries three times'], ['test/a.test.ts', 'hidden']]);
    expect(clear(redRun(repo, head, [{ ...DEFAULT_SHARDS[0]!, log: extraInLog }, DEFAULT_SHARDS[1]!]))).toContain('reason=unnamed_failure — shard 1\'s log names test/a.test.ts::hidden, which its result does not');
    expect(clear(redRun(repo, head, [{ ...DEFAULT_SHARDS[0]!, log: logFor(DEFAULT_SHARDS[0]!, [['test/retry.test.js', 'retries three times']]) + '# Unhandled error between tests\n' }, DEFAULT_SHARDS[1]!]))).toContain('reason=unnamed_failure — shard 1\'s log shows 1 unhandled error(s) between tests');
    expect(clear(redRun(repo, head, DEFAULT_SHARDS, { conclusion: 'cancelled' }))).toContain('reason=run_not_failure');
    expect(clear(redRun(repo, head, DEFAULT_SHARDS, { newer: true }))).toContain('reason=newer_run');
    expect(clear(redRun(repo, head, DEFAULT_SHARDS, { attemptAfter: 2 }))).toContain('reason=run_changed');
    expect(clear(redRun(repo, head, DEFAULT_SHARDS, { api: { repository: { full_name: 'other/fx' } } }))).toContain('reason=other_repository');
    expect(clear(redRun(repo, head, DEFAULT_SHARDS, { api: { head_repository: { full_name: 'fork/fx' } } }))).toContain('reason=fork_run');
    expect(clear(redRun(repo, head, DEFAULT_SHARDS, { api: { path: '.github/workflows/evals.yml' } }))).toContain('reason=workflow_mismatch');
    expect(clear(redRun(repo, head, DEFAULT_SHARDS, { api: { event: 'push' } }))).toContain('reason=event_mismatch');
    expect(clear(redRun(repo, head, DEFAULT_SHARDS, { api: { status: 'in_progress' } }))).toContain('reason=run_in_progress');
    expect(clear(redRun(repo, head, DEFAULT_SHARDS, { jobs: js => js.map(j => ({ ...j, completed_at: '2026-10-27T10:30:00Z' })) }))).toContain('reason=run_stale');
  }, 120_000);

  test('a red run that moves while the clear is assembled refuses, and the printed grant command quotes case names for the shell', async () => {
    const repo = fixture();
    const head = repo.git('rev-parse', 'HEAD');
    const file = await pregateAt(repo);
    const check = redRun(repo, head);
    const asked = clearDecision(file, LANE, { runs: ['400'], evidence: check, flaky: { cases: [FLAKE], pr: 7 } }, repo.work);
    let rerun = false;
    const run = check.deps.run;
    const moving: RunCheck = { ...check, deps: { ...check.deps, run: id => (rerun ? { ...run(id), run_attempt: 2, status: 'in_progress' } : run(id)) }, inventory: () => { rerun = true; return ['test/a.test.ts', 'test/b.test.ts'] } };
    expect(msg(clearDecision(file, LANE, { runs: ['400'], evidence: moving, flaky: { cases: [FLAKE], pr: 7, grant: 'a-1', grantRow: grantFor(asked) } }, repo.work))).toContain('reason=run_changed — run 400 moved to attempt 2 (in_progress)');
    const name = "times out $(touch pwned) `id` it's";
    const shard: Shard[] = [{ files: ['test/retry.test.js', 'test/a.test.ts'], failures: [['test/retry.test.js', name]] }, DEFAULT_SHARDS[1]!];
    const fix = msg(clearDecision(file, LANE, { runs: ['400'], evidence: redRun(repo, head, shard), flaky: { cases: [`test/retry.test.js::${name}`], pr: 7 } }, repo.work));
    const ask = /--ask ('(?:[^']|'\\'')*') --words/.exec(fix)?.[1];
    expect(ask).toBeDefined();
    const echoed = Bun.spawnSync(['bash', '-c', `printf %s ${ask}`], { cwd: repo.work, timeout: 10_000 });
    expect(echoed.stdout.toString()).toContain(`test/retry.test.js::${name}`);
    expect(fs.existsSync(path.join(repo.work, 'pwned'))).toBe(false);
  }, 120_000);

  test('a retry that passed is a recovered flake; a retry that failed again keeps only its own failures', async () => {
    const repo = fixture();
    const head = repo.git('rev-parse', 'HEAD');
    const file = await pregateAt(repo);
    const shard1: Shard = { files: ['test/retry.test.js', 'test/a.test.ts'], failures: [['test/retry.test.js', 'retries three times'], ['test/a.test.ts', 'recovered']], retry: { files: ['test/retry.test.js', 'test/a.test.ts'], failures: [['test/retry.test.js', 'retries three times']] } };
    expect(msg(clearDecision(file, LANE, { runs: ['400'], evidence: redRun(repo, head, [shard1, DEFAULT_SHARDS[1]!]), flaky: { cases: [FLAKE], pr: 7 } }, repo.work))).toContain('reason=grant_needed');
  }, 120_000);

  test('a named file inside the PR diff or its import closure, a paid file or a security scan test refuses', async () => {
    const repo = fixture();
    const head = repo.git('rev-parse', 'HEAD');
    const file = await pregateAt(repo);
    const one = (fileName: string, name: string) => {
      const check = redRun(repo, head, [{ files: [fileName, 'test/retry.test.js', 'test/a.test.ts'].filter((f, i, a) => a.indexOf(f) === i), failures: [[fileName, name]] }, { files: DEFAULT_SHARDS[1]!.files.filter(f => f !== fileName) }]);
      return msg(clearDecision(file, LANE, { runs: ['400'], evidence: check, flaky: { cases: [`${fileName}::${name}`], pr: 7 } }, repo.work));
    };
    expect(one('test/util.test.js', 'adds')).toContain('reason=case_in_closure — test/util.test.js depends on a file the PR changes (lib/util.js)');
    expect(one('test/skill-e2e-flaky.test.ts', 'judge')).toContain('reason=case_paid — test/skill-e2e-flaky.test.ts is a paid test file');
    expect(one('test/cso-docker-policy.test.ts', 'times out')).toContain('reason=case_security — test/cso-docker-policy.test.ts tests a security scan');
    expect(one('test/ship-template-redaction.test.ts', 'blocks')).toContain('reason=case_security');
    expect(one('browse/test/content-security.test.ts', 'blocks')).toContain('reason=case_security');

    const touched = fixture();
    commit(touched, { 'test/retry.test.js': "const test = require('node:test');\ntest('retries three times', () => {});\n" }, 'touch the flaky test');
    const touchedHead = touched.git('rev-parse', 'HEAD');
    const touchedFile = await pregateAt(touched);
    expect(msg(clearDecision(touchedFile, LANE, { runs: ['400'], evidence: redRun(touched, touchedHead), flaky: { cases: [FLAKE], pr: 7 } }, touched.work))).toContain('reason=case_in_diff — test/retry.test.js is in the PR\'s diff');
  }, 120_000);

  test('the run must be at pregate.json\'s own head and tree, and the PR head must be that head: no rebinding', async () => {
    const repo = fixture();
    const older = repo.git('rev-parse', 'HEAD~1');
    const head = repo.git('rev-parse', 'HEAD');
    const file = await pregateAt(repo);
    const clear = (check: RunCheck) => msg(clearDecision(file, LANE, { runs: ['400'], evidence: check, flaky: { cases: [FLAKE], pr: 7 } }, repo.work));
    expect(clear(redRun(repo, older))).toContain('reason=head_mismatch');
    expect(clear(redRun(repo, head, DEFAULT_SHARDS, { pull: { head_sha: older, state: 'open', head_repo: 'fx/fx' } }))).toContain('reason=pr_mismatch — PR #7\'s head is');
    expect(clear(redRun(repo, head, DEFAULT_SHARDS, { pull: { head_sha: head, state: 'closed', head_repo: 'fx/fx' } }))).toContain('reason=pr_mismatch — PR #7 is closed');
  }, 120_000);

  test('the bins: clear refuses --flaky-exception without --run or --pr; verify prints the PREGATE pass-with-exception line; the receipt records it', async () => {
    const repo = fixture();
    const head = repo.git('rev-parse', 'HEAD');
    const file = await pregateAt(repo);
    const out = path.join(repo.work, '.gstack/tmp/pregate.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(file));
    const noRun = runBin(repo, 'gstack-pregate', ['clear', '--remote', LANE, '--flaky-exception', FLAKE, '--pr', '7', '--out', out]);
    expect([noRun.status, noRun.err]).toEqual([EXIT.usage, expect.stringContaining('--flaky-exception needs --run <id|url>')]);
    const noPr = runBin(repo, 'gstack-pregate', ['clear', '--remote', LANE, '--run', '400', '--flaky-exception', FLAKE, '--out', out]);
    expect([noPr.status, noPr.err]).toEqual([EXIT.usage, expect.stringContaining('--flaky-exception needs --pr <n>')]);
    const exception = { lane: LANE, repo: 'fx/fx', pr: 7, head, tree: file.tree, runs: ['400/1'], cases: [FLAKE] };
    const recorded = { ...exception, grant: 'a-1', by: 'Garry', words: WORDS, binding: exceptionBinding(exception) };
    const cleared = clearObligation(file, LANE, `remote-gate tree=${file.tree.slice(0, 12)} tests=18 exception=a-1 cases=1 runs=400/1 profiles=${PROFILE_NAME} heads=${head.slice(0, 12)} verified=2026-10-29T12:00:00.000Z`, 'test', undefined, recorded);
    fs.writeFileSync(out, JSON.stringify(cleared));
    const v = runBin(repo, 'gstack-pregate', ['verify', '--out', out]);
    expect([v.status, v.err]).toEqual([EXIT.ok, '']);
    expect(v.out).toContain(`PREGATE: pass-with-exception (${FLAKE}; grant a-1)\n`);
    const bound = runBin(repo, 'gstack-ship-receipt', ['write', '--pr', '7', '--base', 'main', '--version', '1.0.0', '--session-kind', 'interactive', '--pregate', out, '--json']);
    expect([bound.status, bound.err]).toEqual([EXIT.ok, expect.any(String)]);
    expect(bound.out).toContain('"flaky_exception":[{"lane":"pregate.json/remote_gate","runs":["400/1"],"cases":["test/retry.test.js::retries three times"],"grant":"a-1","by":"Garry"}]');
  }, 180_000);
});

describe.skipIf(process.platform === 'win32')('ready with a flaky exception', () => {
  test('ready accepts pass-with-exception, prints FLAKY_EXCEPTION, and still refuses a red required check (pregate only)', () => {
    const repo = makeQueueRepo();
    queueRepos.push(repo);
    const head = makePr(repo, 'pr-a');
    const tree = runQueueBin(repo, 'gstack-wtree', []).out.trim();
    const exception = { lane: LANE, repo: 'o/r', pr: 1, head, tree, runs: ['400/1'], cases: [FLAKE] };
    const pregate = path.join(repo.root, 'pregate.json');
    fs.writeFileSync(pregate, JSON.stringify({
      schema_version: 1, tree, head, verdict: 'pass-with-exception', checks: [{ id: 'lanes', status: 'requires-remote' }],
      requires_remote: [{ lane: LANE, platform: 'remote', workflow: 'pregate.json', job: 'remote_gate', tests: ['test/a.test.ts'], receipt: `remote-gate tree=${tree.slice(0, 12)} tests=18 exception=a-1 cases=1 runs=400/1 profiles=${PROFILE_NAME} heads=${head.slice(0, 12)} verified=2026-10-29T12:00:00.000Z` }],
      exceptions: [{ ...exception, grant: 'a-1', by: 'Garry', words: WORDS, binding: exceptionBinding(exception) }],
    }));
    const queue = (checks: unknown) => runQueueBin(repo, 'gstack-ship-queue', ['ready', '--pr', '1', '--pregate', pregate, '--base', 'main'], ghQueueShim(repo, { prs: { '1': { headRefOid: head, url: 'https://github.com/o/r/pull/1', body: shippedBody('1', head) } }, checks: { [head]: checks } }));
    const ok = queue({ check_runs: [{ status: 'completed', conclusion: 'success' }] });
    expect([ok.status, ok.err]).toEqual([EXIT.ok, '']);
    expect(ok.out).toMatch(/^PREGATE: pass-with-exception tree=[0-9a-f]{12} /m);
    expect(ok.out).toContain(`FLAKY_EXCEPTION: ${LANE} cases=${FLAKE} run=400/1 grant=a-1 by=Garry (pregate only; every required CI check still needs its own green run at this head)\n`);
    const red = queue({ check_runs: [{ status: 'completed', conclusion: 'failure' }] });
    expect(red.status).toBe(EXIT.refused);
    expect(red.err).toMatch(/CI is not green at .*\(QUEUE_NOT_READY\)/);
    const other = { ...exception, pr: 2 };
    fs.writeFileSync(pregate, JSON.stringify({ ...JSON.parse(fs.readFileSync(pregate, 'utf8')), exceptions: [{ ...other, grant: 'a-1', by: 'Garry', words: WORDS, binding: exceptionBinding(other) }] }));
    const moved = queue({ check_runs: [{ status: 'completed', conclusion: 'success' }] });
    expect(moved.status).toBe(EXIT.refused);
    expect(moved.err).toContain('flaky exception grant a-1 is bound to PR #2');
  }, 120_000);
});
