/**
 * lib/run-evidence.ts: a GitHub Actions run as evidence for one tree (GSTA-156). Every refusal reason has a fixture;
 * the dependencies are fakes, so nothing here reaches GitHub.
 */
import { describe, expect, test } from 'bun:test';
import { parseRunReceipt, parseRunRef, runInventory, runProfileErrors, runReceiptFields, uncoveredFiles, verifyFromRun, verifyRun, type ApiJob, type ApiRun, type RunDeps, type RunProfile, type TreeRecord } from '../lib/run-evidence';

const REPO = 'garrytan/gbrain';
const HEAD = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const NOW = new Date('2026-10-29T12:00:00Z');
const PROFILE: RunProfile = { workflow: 'test.yml', events: ['workflow_dispatch', 'push'], jobs: ['full-suite'], artifact: 'full-suite-tree' };

interface World { run: ApiRun; others: ApiRun[]; jobs: ApiJob[]; artifact: TreeRecord | Error; trees: Record<string, string | null>; throwOn?: 'run'; later?: ApiRun }
function world(over: Partial<World> = {}): World {
  const run: ApiRun = {
    id: 100, run_attempt: 1, status: 'completed', conclusion: 'success', event: 'workflow_dispatch', head_sha: HEAD,
    path: '.github/workflows/test.yml', created_at: '2026-10-29T10:00:00Z', updated_at: '2026-10-29T10:20:00Z',
    repository: { full_name: REPO }, head_repository: { full_name: REPO },
  };
  return {
    run, others: [], jobs: [{ name: 'full-suite', conclusion: 'success' }, { name: 'lint', conclusion: 'success' }],
    artifact: { run_id: 100, run_attempt: 1, event: 'workflow_dispatch', sha: HEAD, tree: TREE, files: ['test/a.test.ts', 'test/b.test.ts'], tests: 12 },
    trees: { [HEAD]: TREE }, ...over,
  };
}
function deps(w: World): RunDeps {
  let reads = 0;
  return {
    run: id => { if (w.throwOn === 'run') throw new Error('HTTP 502'); if (id !== w.run.id) throw new Error('HTTP 404'); return reads++ && w.later ? w.later : w.run; },
    runsForHead: (_wf, sha) => [w.run, ...w.others].filter(r => r.head_sha === sha),
    jobs: () => w.jobs,
    artifact: () => { if (w.artifact instanceof Error) throw w.artifact; return w.artifact; },
    commitTree: sha => w.trees[sha] ?? null,
  };
}
const check = (w: World, extra: { runRef?: string; profile?: RunProfile; vetoHeads?: string[] } = {}) =>
  verifyRun(deps(w), { repo: REPO, runRef: extra.runRef ?? '100', profileName: 'test', profile: extra.profile ?? PROFILE, vetoHeads: extra.vetoHeads, now: NOW });
const reason = (w: World, extra: Parameters<typeof check>[1] = {}) => { const v = check(w, extra); return v.ok ? 'ok' : v.reason; };

describe('verifyRun', () => {
  test('a completed same-repository run with its job, artifact and head tree agreeing is evidence for that tree', () => {
    const v = check(world());
    expect(v).toEqual({ ok: true, evidence: { run_id: 100, run_attempt: 1, head_sha: HEAD, tree: TREE, profile: 'test', event: 'workflow_dispatch', finished_at: '2026-10-29T10:20:00Z', files: ['test/a.test.ts', 'test/b.test.ts'], tests: 12 } });
  });

  test('a run URL on this repository is accepted; another repository, a malformed ref and an unknown host are not', () => {
    expect(reason(world(), { runRef: `https://github.com/${REPO}/actions/runs/100/attempts/1` })).toBe('ok');
    expect(reason(world(), { runRef: 'https://github.com/someone/else/actions/runs/100' })).toBe('run_ref_invalid');
    expect(reason(world(), { runRef: 'https://example.com/garrytan/gbrain/actions/runs/100' })).toBe('run_ref_invalid');
    expect(reason(world(), { runRef: '100; rm -rf /' })).toBe('run_ref_invalid');
  });

  test('each refusal names its reason', () => {
    const base = world();
    const cases: Array<[string, World]> = [
      ['other_repository', world({ run: { ...base.run, repository: { full_name: 'x/y' } } })],
      ['fork_run', world({ run: { ...base.run, head_repository: { full_name: 'fork/gbrain' } } })],
      ['workflow_mismatch', world({ run: { ...base.run, path: '.github/workflows/e2e.yml' } })],
      ['event_mismatch', world({ run: { ...base.run, event: 'pull_request' } })],
      ['run_in_progress', world({ run: { ...base.run, status: 'in_progress', conclusion: null } })],
      ['run_not_success', world({ run: { ...base.run, conclusion: 'failure' } })],
      ['run_not_success', world({ run: { ...base.run, conclusion: 'cancelled' } })],
      ['run_stale', world({ run: { ...base.run, updated_at: '2026-10-28T10:00:00Z' } })],
      ['job_missing', world({ jobs: [{ name: 'lint', conclusion: 'success' }] })],
      ['job_ambiguous', world({ jobs: [{ name: 'full-suite', conclusion: 'success' }, { name: 'full-suite', conclusion: 'success' }] })],
      ['job_not_success', world({ jobs: [{ name: 'full-suite', conclusion: 'skipped' }] })],
      ['artifact_missing', world({ artifact: new Error('no artifact named full-suite-tree') })],
      ['artifact_mismatch', world({ artifact: { ...(base.artifact as TreeRecord), run_id: 99 } })],
      ['artifact_mismatch', world({ artifact: { ...(base.artifact as TreeRecord), run_attempt: 2 } })],
      ['artifact_mismatch', world({ artifact: { ...(base.artifact as TreeRecord), sha: 'c'.repeat(40) } })],
      ['artifact_mismatch', world({ artifact: { ...(base.artifact as TreeRecord), head_sha: 'c'.repeat(40) } })],
      ['artifact_mismatch', world({ artifact: { ...(base.artifact as TreeRecord), sha: undefined } })],
      ['artifact_reused', world({ artifact: { ...(base.artifact as TreeRecord), reused: true } })],
      ['tree_mismatch', world({ artifact: { ...(base.artifact as TreeRecord), tree: 'd'.repeat(40) } })],
      ['api_error', world({ trees: {} })],
      ['api_error', world({ throwOn: 'run' })],
    ];
    for (const [want, w] of cases) expect([want, reason(w)]).toEqual([want, want]);
  });

  test('the newest attempt decides: a run whose latest attempt failed is refused even if an earlier attempt passed', () => {
    const w = world();
    expect(reason(world({ run: { ...w.run, run_attempt: 2, conclusion: 'failure' }, artifact: { ...(w.artifact as TreeRecord), run_attempt: 2 } }))).toBe('run_not_success');
  });

  test('a newer failed, cancelled or running run of the workflow on the head vetoes; an older one or a newer green does not', () => {
    const w = world();
    const newer = (status: string, conclusion: string | null): ApiRun => ({ ...w.run, id: 101, created_at: '2026-10-29T11:00:00Z', status, conclusion });
    expect(reason(world({ others: [newer('completed', 'failure')] }))).toBe('newer_run_vetoes');
    expect(reason(world({ others: [newer('completed', 'cancelled')] }))).toBe('newer_run_vetoes');
    expect(reason(world({ others: [newer('in_progress', null)] }))).toBe('newer_run_vetoes');
    expect(reason(world({ others: [newer('completed', 'success')] }))).toBe('ok');
    expect(reason(world({ others: [{ ...newer('completed', 'failure'), created_at: '2026-10-29T09:00:00Z' }] }))).toBe('ok');
    // A re-run keeps its run's created_at; its newest attempt started after the candidate, so its red result still vetoes.
    expect(reason(world({ others: [{ ...newer('completed', 'failure'), created_at: '2026-10-29T09:00:00Z', run_started_at: '2026-10-29T11:00:00Z' }] }))).toBe('newer_run_vetoes');
    // Re-running the candidate itself does not hide a failure that started after it was first created.
    expect(reason(world({ run: { ...w.run, run_started_at: '2026-10-29T12:00:00Z' }, others: [newer('completed', 'failure')] }))).toBe('newer_run_vetoes');
  });

  test('a newer failure on another head the consumer names (same tree, the lane\'s own head) vetoes too', () => {
    const w = world();
    const other = 'e'.repeat(40);
    const red: ApiRun = { ...w.run, id: 102, head_sha: other, created_at: '2026-10-29T11:30:00Z', conclusion: 'failure' };
    expect(reason(world({ others: [red] }))).toBe('ok');
    expect(reason(world({ others: [red] }), { vetoHeads: [other] })).toBe('newer_run_vetoes');
  });

  test('the run is read again after the evidence: a newer attempt of the same run, seen or started meanwhile, refuses', () => {
    const w = world();
    expect(reason(world({ later: { ...w.run, run_attempt: 2, status: 'in_progress', conclusion: null } }))).toBe('run_changed');
    expect(reason(world({ others: [{ ...w.run, run_attempt: 2, run_started_at: '2026-10-29T11:00:00Z', status: 'completed', conclusion: 'failure' }] }))).toBe('newer_run_vetoes');
  });

  test('tree.json counts and file lists must be well formed', () => {
    const art = world().artifact as TreeRecord;
    expect(reason(world({ artifact: { ...art, tests: -1 } }))).toBe('artifact_mismatch');
    expect(reason(world({ artifact: { ...art, tests: 1.5 } }))).toBe('artifact_mismatch');
    expect(reason(world({ artifact: { ...art, files: 'test/a.test.ts' } }))).toBe('artifact_mismatch');
    const v = check(world({ artifact: { ...art, files: ['./test/a.test.ts'], tests: undefined } }));
    expect(v.ok && [v.evidence.files, v.evidence.tests]).toEqual([['test/a.test.ts'], null]);
  });

  test('a profile that names an OS needs the artifact to record it', () => {
    const w = world();
    expect(reason(w, { profile: { ...PROFILE, os: 'Linux' } })).toBe('os_mismatch');
    expect(reason(world({ artifact: { ...(w.artifact as TreeRecord), os: 'Linux' } }), { profile: { ...PROFILE, os: 'Linux' } })).toBe('ok');
  });

  test('a failed run created in the same second as the candidate vetoes it: ties count as newer', () => {
    const w = world();
    expect(reason(world({ others: [{ ...w.run, id: 101, status: 'completed', conclusion: 'failure' }] }))).toBe('newer_run_vetoes');
  });

  test('freshness reads the jobs\' latest completed_at when the API gives it, not a later updated_at', () => {
    const w = world();
    const jobs: ApiJob[] = [{ name: 'full-suite', conclusion: 'success', completed_at: '2026-10-28T10:00:00Z' }, { name: 'lint', conclusion: 'success', completed_at: '2026-10-28T09:00:00Z' }];
    expect(reason(world({ jobs }))).toBe('run_stale');
    const v = check(world({ jobs: jobs.map(j => ({ ...j, completed_at: '2026-10-29T10:10:00Z' })) }));
    expect(v.ok && v.evidence.finished_at).toBe('2026-10-29T10:10:00Z');
    expect(w.run.updated_at).toBe('2026-10-29T10:20:00Z');
  });

  test('max_age_hours widens the freshness window', () => {
    const stale = world({ run: { ...world().run, updated_at: '2026-10-28T10:00:00Z' } });
    expect(reason(stale)).toBe('run_stale');
    expect(reason(stale, { profile: { ...PROFILE, max_age_hours: 48 } })).toBe('ok');
  });
});

describe('runInventory', () => {
  test('lists unique non-empty lines, and a pipeline whose producer fails refuses instead of listing part of the gate', () => {
    const cwd = process.cwd();
    expect(runInventory("printf 'test/b.test.ts\\n\\ntest/a.test.ts\\ntest/b.test.ts\\n'", cwd)).toEqual(['test/b.test.ts', 'test/a.test.ts']);
    expect(runInventory("{ printf 'test/a.test.ts\\n'; exit 17; } | sort", cwd)).toMatchObject({ error: expect.stringContaining('exited 17') });
  });
});

describe('profiles, coverage and receipts', () => {
  test('runProfileErrors accepts a well-formed pair and names every malformed field', () => {
    expect(runProfileErrors({ test: PROFILE, e2e: { ...PROFILE, workflow: 'e2e.yml', jobs: ['e2e-full-suite'], artifact: 'e2e-full-suite-tree', os: 'Linux', max_age_hours: 12 } }, { profiles: ['test', 'e2e'], inventory: 'bash scripts/pregate-remote-gate.sh --list' })).toEqual([]);
    const errors = runProfileErrors({ bad: { workflow: '../x.yml', events: ['pull_request_target'], jobs: [], artifact: '', max_age_hours: 0, os: 'BeOS', extra: 1 } }, { profiles: ['missing'], inventory: 'a\nb' }).map(e => e.path);
    expect(errors).toEqual(expect.arrayContaining(['run_profiles["bad"].extra', 'run_profiles["bad"].workflow', 'run_profiles["bad"].events', 'run_profiles["bad"].jobs', 'run_profiles["bad"].artifact', 'run_profiles["bad"].max_age_hours', 'run_profiles["bad"].os', 'remote_gate_runs.profiles', 'remote_gate_runs.inventory']));
    expect(runProfileErrors({ test: PROFILE }, { profiles: ['test', 'test'], inventory: 'true' })).toEqual([{ path: 'remote_gate_runs.profiles', message: 'names each profile once' }]);
  });

  test('uncoveredFiles lists the inventory files no run recorded', () => {
    const ev = (files: string[]) => ({ run_id: 1, run_attempt: 1, head_sha: HEAD, tree: TREE, profile: 'p', event: 'push', finished_at: '', files, tests: null });
    expect(uncoveredFiles(['a', 'b', 'c'], [ev(['a']), ev(['b'])])).toEqual(['c']);
    expect(uncoveredFiles(['a'], [ev(['a', 'z'])])).toEqual([]);
    expect(uncoveredFiles(['./test/x.test.ts'], [ev(['test/x.test.ts'])])).toEqual([]);
  });

  test('the receipt fields round-trip and keep the tree prefix verify reads', () => {
    const v = check(world());
    if (!v.ok) throw new Error(v.detail);
    const receipt = `remote-gate tree=${TREE.slice(0, 12)} tests=12 ${runReceiptFields([v.evidence], NOW)}`;
    expect(receipt).toBe(`remote-gate tree=${TREE.slice(0, 12)} tests=12 runs=100/1 profiles=test heads=${HEAD.slice(0, 12)} verified=2026-10-29T12:00:00.000Z`);
    expect(parseRunReceipt(receipt)).toEqual({ runs: ['100/1'], profiles: ['test'], tree: TREE.slice(0, 12) });
    expect(parseRunReceipt(`remote-gate tree=${TREE.slice(0, 12)} tests=3 receipt=/x sha256=abc`)).toBeNull();
    expect(parseRunRef('123', REPO)).toBe(123);
  });
});

describe('pull_request runs (P3b)', () => {
  const MERGE = 'e'.repeat(40);
  const PR_PROFILE: RunProfile = { ...PROFILE, events: ['pull_request', 'workflow_dispatch'] };
  const pr = (over: Partial<TreeRecord> = {}, trees: Record<string, string | null> = { [HEAD]: TREE, [MERGE]: TREE }) => {
    const base = world();
    return world({ run: { ...base.run, event: 'pull_request' }, artifact: { ...(base.artifact as TreeRecord), event: 'pull_request', sha: MERGE, head_sha: HEAD, ...over }, trees });
  };
  const prReason = (w: World) => reason(w, { profile: PR_PROFILE });

  test('a pull_request run counts when its merge commit tested its head tree', () => {
    const v = check(pr(), { profile: PR_PROFILE });
    expect(v).toMatchObject({ ok: true, evidence: { event: 'pull_request', head_sha: HEAD, tree: TREE } });
  });

  test('a pull_request run is refused when the merge tree is not the head tree, or the record names no merge commit or another head', () => {
    expect(prReason(pr({}, { [HEAD]: TREE, [MERGE]: 'f'.repeat(40) }))).toBe('tree_mismatch');
    const behind = check(pr({}, { [HEAD]: TREE, [MERGE]: 'f'.repeat(40) }), { profile: PR_PROFILE });
    expect(!behind.ok && behind.detail).toContain('the pull request was behind its base');
    expect(prReason(pr({ sha: undefined }))).toBe('artifact_mismatch');
    expect(prReason(pr({ sha: 'not-a-sha' }))).toBe('artifact_mismatch');
    expect(prReason(pr({ head_sha: undefined }))).toBe('artifact_mismatch');
    expect(prReason(pr({ head_sha: MERGE }))).toBe('artifact_mismatch');
    expect(prReason(pr({}, { [HEAD]: TREE }))).toBe('api_error');
    expect(prReason(pr({ tree: 'f'.repeat(40) }))).toBe('tree_mismatch');
  });

  test('a profile without pull_request still refuses a pull_request run, and validation accepts pull_request but nothing else new', () => {
    expect(reason(pr())).toBe('event_mismatch');
    expect(runProfileErrors({ p: PR_PROFILE }, undefined)).toEqual([]);
    expect(runProfileErrors({ p: { ...PR_PROFILE, events: ['pull_request_target'] } }, undefined).map(e => e.path)).toEqual(['run_profiles["p"].events']);
  });

  test('a record may name every OS its test jobs ran on; the profile OS must be one of them', () => {
    const base = world();
    const multi = (os: unknown) => world({ artifact: { ...(base.artifact as TreeRecord), os } });
    expect(reason(multi(['Linux', 'macOS', 'Windows']), { profile: { ...PROFILE, os: 'macOS' } })).toBe('ok');
    expect(reason(multi(['Linux']), { profile: { ...PROFILE, os: 'macOS' } })).toBe('os_mismatch');
    expect(reason(multi('Windows'), { profile: { ...PROFILE, os: 'Windows' } })).toBe('ok');
  });
});

describe('verifyFromRun (P3b --from-run)', () => {
  const src = (w: World, profiles: Record<string, RunProfile> = { 'test.yml/unit': PROFILE }) => ({ repo: REPO, deps: deps(w), profiles, now: NOW });
  test('a run on exactly this tree is evidence with a run receipt naming its files', () => {
    const v = verifyFromRun(src(world()), '100', ['test.yml/unit'], TREE, HEAD);
    expect(v).toEqual({ ok: true, evidence: expect.objectContaining({ run_id: 100, files: ['test/a.test.ts', 'test/b.test.ts'] }), receipt: `run tree=${TREE.slice(0, 12)} tests=12 runs=100/1 profiles=test.yml/unit heads=${HEAD.slice(0, 12)} verified=2026-10-29T12:00:00.000Z` });
  });
  test('another tree, no profile, an empty file list, zero tests and a failed run each refuse with their reason', () => {
    const why = (v: ReturnType<typeof verifyFromRun>) => (v.ok ? 'ok' : v.reason);
    const base = world();
    expect(why(verifyFromRun(src(world()), '100', ['test.yml/unit'], 'c'.repeat(40), HEAD))).toBe('tree_mismatch');
    expect(why(verifyFromRun(src(world()), '100', [], TREE, HEAD))).toBe('no_profile');
    expect(why(verifyFromRun(src(world({ artifact: { ...(base.artifact as TreeRecord), files: [] } })), '100', ['test.yml/unit'], TREE, HEAD))).toBe('no_tests');
    expect(why(verifyFromRun(src(world({ artifact: { ...(base.artifact as TreeRecord), tests: 0 } })), '100', ['test.yml/unit'], TREE, HEAD))).toBe('no_tests');
    expect(why(verifyFromRun(src(world({ run: { ...base.run, conclusion: 'failure' } })), '100', ['test.yml/unit'], TREE, HEAD))).toBe('run_not_success');
    const two = verifyFromRun(src(world({ run: { ...base.run, conclusion: 'failure' } }), { a: PROFILE, b: PROFILE }), '100', ['a', 'b'], TREE, HEAD);
    expect(two).toMatchObject({ ok: false, reason: 'no_verified_run', detail: expect.stringContaining('a: run 100') });
  });
  test('a newer red run on the consumer\'s own head vetoes', () => {
    const base = world();
    const OWN = 'c'.repeat(40);
    const red: ApiRun = { ...base.run, id: 101, head_sha: OWN, conclusion: 'failure', created_at: '2026-10-29T11:00:00Z' };
    expect(verifyFromRun(src(world({ others: [red] })), '100', ['test.yml/unit'], TREE, OWN)).toMatchObject({ ok: false, reason: 'newer_run_vetoes' });
  });
});
