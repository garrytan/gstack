/**
 * HARN-118 / GST-3231: a private repository whose artifact storage is full runs green but uploads no tree.json, so a run
 * profile that opts in with `tree_log_step` reads tree.json from one `GSTACK_TREE_JSON <artifact> <base64>` line in the
 * log of its job instead. The line counts only when it is the one such line across the profile's jobs at the attempt that
 * ran, the runner stamped it inside the named step at least a second after every earlier step ended, and that step
 * succeeded. An artifact always wins, a profile without the key never reads a log, and every tree.json check still runs.
 * The dependencies are fakes; nothing reaches GitHub.
 */
import { describe, expect, test } from 'bun:test';
import { findCarry, recordCiResult } from '../lib/ci-carry';
import { RESULT_CODES } from '../lib/result-codes';
import { laneLine } from '../lib/ship-bin-common';
import { receiptSummaryLine, validateReceipt } from '../lib/ship-receipt';
import { NoArtifactError, runProfileErrors, runReceiptFields, verifyRun, type ApiJob, type ApiRun, type ApiStep, type RunDeps, type RunProfile, type TreeRecord } from '../lib/run-evidence';

const REPO = 'garrytan/harness-evals';
const HEAD = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const NOW = new Date('2026-11-19T12:00:00Z');
const RUN_ID = 44577938128;
const JOB_ID = 135750428163;
const STEP = 'Print tree.json for gstack';
const PROFILE: RunProfile = { workflow: 'ci.yml', events: ['push'], jobs: ['checks'], artifact: 'checks-tree', os: 'Linux', tree_log_step: STEP };
const REC: TreeRecord = { run_id: RUN_ID, run_attempt: 1, event: 'push', sha: HEAD, tree: TREE, os: 'Linux', files: ['tests/a.test.ts', 'tests/b.test.ts'], tests: 9 };
const b64 = (rec: unknown) => Buffer.from(JSON.stringify(rec)).toString('base64');
/** One log line as the runner writes it: its own timestamp, then what the step printed. */
const line = (at: string, printed: string) => `${at} ${printed}`;
const treeLine = (at: string, rec: unknown = REC, name = 'checks-tree') => line(at, `GSTACK_TREE_JSON ${name} ${b64(rec)}`);
/** The step prints the line 1.5 s after the test step ended (it sleeps a second first). */
const GOOD_AT = '2026-11-19T11:20:01.5000000Z';
/** A test inside the test step printing a well-formed line with a real-looking tree.json. */
const FORGED_AT = '2026-11-19T11:10:00.1234567Z';
const log = (...lines: string[]) => ['\uFEFF2026-11-19T11:00:00.0082632Z Current runner version: 2.338.2', ...lines, '2026-11-19T11:20:04.1000000Z Cleaning up orphan processes'].join('\n');

function steps(over: Record<string, Partial<ApiStep> | null> = {}, extra: ApiStep[] = []): ApiStep[] {
  const list: ApiStep[] = [
    { number: 1, name: 'Set up job', conclusion: 'success', started_at: '2026-11-19T11:00:00Z', completed_at: '2026-11-19T11:00:02Z' },
    { number: 2, name: 'Run tests', conclusion: 'success', started_at: '2026-11-19T11:00:02Z', completed_at: '2026-11-19T11:20:00Z' },
    { number: 3, name: STEP, conclusion: 'success', started_at: '2026-11-19T11:20:00Z', completed_at: '2026-11-19T11:20:03Z' },
    { number: 4, name: 'Complete job', conclusion: 'success', started_at: '2026-11-19T11:20:03Z', completed_at: '2026-11-19T11:20:04Z' },
  ];
  return [...list.filter(s => over[s.name] !== null).map(s => ({ ...s, ...over[s.name] })), ...extra];
}
const job = (over: Partial<ApiJob> = {}): ApiJob => ({ id: JOB_ID, name: 'checks', conclusion: 'success', started_at: '2026-11-19T11:00:00Z', completed_at: '2026-11-19T11:20:04Z', steps: steps(), ...over });

interface World { artifact?: TreeRecord | Error; logs: Record<number, string>; jobs?: ApiJob[]; jobsByAttempt?: Record<number, ApiJob[]>; attempt?: number }
function deps(w: World): RunDeps & { logReads: number[] } {
  const run: ApiRun = { id: RUN_ID, run_attempt: w.attempt ?? 1, status: 'completed', conclusion: 'success', event: 'push', head_sha: HEAD, path: '.github/workflows/ci.yml',
    created_at: '2026-11-19T11:00:00Z', updated_at: '2026-11-19T11:20:10Z', repository: { full_name: REPO }, head_repository: { full_name: REPO } };
  const logReads: number[] = [];
  return {
    logReads,
    run: () => run,
    runsForHead: (_wf, sha) => (sha === HEAD ? [run] : []),
    jobs: (_id, attempt) => w.jobsByAttempt?.[attempt] ?? w.jobs ?? [job()],
    artifact: (_id, name) => { if (!w.artifact) throw new NoArtifactError(`run ${RUN_ID} has 0 unexpired artifacts named ${name}`); if (w.artifact instanceof Error) throw w.artifact; return w.artifact; },
    jobLog: id => { logReads.push(id); const text = w.logs[id]; if (text === undefined) throw new Error('HTTP 404'); return text; },
    commitTree: sha => (sha === HEAD ? TREE : null),
  };
}
const check = (w: World, profile: RunProfile = PROFILE) => verifyRun(deps(w), { repo: REPO, runRef: String(RUN_ID), profileName: 'ci/checks', profile, now: NOW });
const refusal = (w: World, profile?: RunProfile) => { const v = check(w, profile); return v.ok ? ['ok', ''] : [v.reason, v.detail]; };

describe('tree.json from the job log when the run has no artifact (HARN-118)', () => {
  // Value: protects=a green run whose artifact upload hit the storage quota still carries; fails_when=the fallback is missing and artifact_missing refuses it
  test('one line in the named step, with no artifact, is the run\'s tree.json, and every carry line says where it came from', () => {
    const w: World = { logs: { [JOB_ID]: log(treeLine(GOOD_AT)) } };
    const d = deps(w);
    const v = verifyRun(d, { repo: REPO, runRef: String(RUN_ID), profileName: 'ci/checks', profile: PROFILE, now: NOW });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.evidence).toMatchObject({ run_id: RUN_ID, run_attempt: 1, tree: TREE, files: ['tests/a.test.ts', 'tests/b.test.ts'], tests: 9, tree_source: 'job-log' });
    expect(d.logReads).toEqual([JOB_ID]);
    expect(runReceiptFields([v.evidence], NOW)).toContain(`runs=${RUN_ID}/1 profiles=ci/checks heads=${HEAD.slice(0, 12)} tree_source=job-log verified=`);
    const carry = findCarry({ repo: REPO, deps: deps(w), profiles: { 'ci/checks': PROFILE }, now: NOW }, { profiles: ['ci/checks'], head: HEAD, tree: TREE, wtree: () => TREE, inventory: () => ['tests/a.test.ts', 'tests/b.test.ts'] });
    expect(carry.ok ? carry.receipt : carry.detail).toContain(' tree_source=job-log ');
    expect(log(treeLine(GOOD_AT)).replace(/\n/g, '\r\n')).toContain('\r\n');
    expect(check({ logs: { [JOB_ID]: log(treeLine(GOOD_AT)).replace(/\n/g, '\r\n') } }).ok).toBe(true);
  });

  // Value: protects=an artifact always wins and the log is never read beside it; fails_when=a log line overrides or is consulted next to an uploaded tree.json
  test('an artifact wins: the log is not read, and the evidence names no tree_source', () => {
    const w: World = { artifact: REC, logs: { [JOB_ID]: log(treeLine(GOOD_AT, { ...REC, tree: 'c'.repeat(40) }), treeLine(GOOD_AT)) } };
    const d = deps(w);
    const v = verifyRun(d, { repo: REPO, runRef: String(RUN_ID), profileName: 'ci/checks', profile: PROFILE, now: NOW });
    expect(v.ok).toBe(true);
    expect(v.ok && v.evidence.tree_source).toBeUndefined();
    expect(d.logReads).toEqual([]);
    expect(v.ok ? runReceiptFields([v.evidence], NOW) : '').not.toContain('tree_source');
  });

  // Value: protects=rule 3: only "no artifact at all" opens the log; fails_when=an unreadable, oversized or ambiguous artifact falls back to a log line
  test('an artifact that exists but cannot be read refuses as artifact_missing and never reads the log', () => {
    for (const e of [new Error('run 1 has 2 unexpired artifacts named checks-tree and 0 of them record run_attempt 1'), new Error('artifact checks-tree is 9000000 bytes, over 8388608')]) {
      const d = deps({ artifact: e, logs: { [JOB_ID]: log(treeLine(GOOD_AT)) } });
      const v = verifyRun(d, { repo: REPO, runRef: String(RUN_ID), profileName: 'ci/checks', profile: PROFILE, now: NOW });
      expect(v.ok ? 'ok' : v.reason).toBe('artifact_missing');
      expect(d.logReads).toEqual([]);
    }
  });

  // Value: protects=the log of the attempt that ran (ranIn), not the newest attempt's relisted job; fails_when=a rerun of another job makes gstack read the new attempt's job id
  test('after a rerun of another job, the log read is the profile job\'s own attempt', () => {
    const first = job({ id: 501 });
    const relisted = job({ id: 502 });
    const d = deps({ attempt: 2, jobsByAttempt: { 1: [first], 2: [relisted, { name: 'lint', conclusion: 'success', started_at: '2026-11-19T11:30:00Z', completed_at: '2026-11-19T11:31:00Z' }] }, logs: { 501: log(treeLine(GOOD_AT)), 502: log(treeLine(GOOD_AT, { ...REC, run_attempt: 2 })) } });
    const v = verifyRun(d, { repo: REPO, runRef: String(RUN_ID), profileName: 'ci/checks', profile: PROFILE, now: NOW });
    expect(v.ok ? [v.evidence.run_attempt, v.evidence.tree_source] : v.detail).toEqual([2, 'job-log']);
    expect(d.logReads).toEqual([501]);
  });

  // Value: protects=rule 1 fails closed on ambiguity, across every profile job; fails_when=the first or last of several lines is taken
  test('two lines refuse as artifact_missing with the count, in one job or across the profile\'s jobs', () => {
    expect(refusal({ logs: { [JOB_ID]: log(treeLine(GOOD_AT), treeLine('2026-11-19T11:20:02.0000000Z')) } })).toEqual(['artifact_missing', expect.stringContaining('2 GSTACK_TREE_JSON lines')]);
    const two: ApiJob[] = [job(), job({ id: JOB_ID + 1, name: 'docker-e2e' })];
    const both = { ...PROFILE, jobs: ['checks', 'docker-e2e'] };
    expect(refusal({ jobs: two, logs: { [JOB_ID]: log(treeLine(GOOD_AT)), [JOB_ID + 1]: log(treeLine(GOOD_AT)) } }, both)).toEqual(['artifact_missing', expect.stringContaining('2 GSTACK_TREE_JSON lines')]);
    expect(check({ jobs: two, logs: { [JOB_ID]: log(treeLine(GOOD_AT)), [JOB_ID + 1]: log() } }, both).ok).toBe(true);
  });

  // Value: protects=rule 1's zero case; fails_when=a run with no artifact and no line, or a line for another artifact, carries or errors as anything else
  test('no line refuses as artifact_missing with the count; a line naming another artifact is not this profile\'s', () => {
    expect(refusal({ logs: { [JOB_ID]: log() } })).toEqual(['artifact_missing', expect.stringContaining('0 GSTACK_TREE_JSON lines')]);
    expect(refusal({ logs: { [JOB_ID]: log(treeLine(GOOD_AT, REC, 'other-tree')) } })).toEqual(['artifact_missing', expect.stringContaining('0 GSTACK_TREE_JSON lines')]);
    expect(refusal({ logs: {} })[0]).toBe('artifact_missing');
  });

  // Value: protects=the opt-in key: a repository that never prints the line can't be fooled by a test that prints one; fails_when=a profile without tree_log_step reads the log
  test('a profile without tree_log_step never reads the log: no artifact stays artifact_missing', () => {
    const { tree_log_step: _, ...plain } = PROFILE;
    const d = deps({ logs: { [JOB_ID]: log(treeLine(GOOD_AT)) } });
    const v = verifyRun(d, { repo: REPO, runRef: String(RUN_ID), profileName: 'ci/checks', profile: plain, now: NOW });
    expect(v.ok ? 'ok' : v.reason).toBe('artifact_missing');
    expect(d.logReads).toEqual([]);
  });
});

describe('a forged line never stands in for the named step (HARN-118 design calls)', () => {
  // Value: protects=a test that prints a well-formed line in an opted-in repository; fails_when=the only line, printed during the test step, is accepted
  test('a well-formed line a test printed during the test step refuses as tree_log_unbound, alone or beside the real one', () => {
    expect(refusal({ logs: { [JOB_ID]: log(treeLine(FORGED_AT)) } })).toEqual(['tree_log_unbound', expect.stringContaining(`not inside step "${STEP}"`)]);
    expect(refusal({ logs: { [JOB_ID]: log(treeLine(FORGED_AT), treeLine(GOOD_AT)) } })).toEqual(['artifact_missing', expect.stringContaining('2 GSTACK_TREE_JSON lines')]);
  });

  // Value: protects=the runner's timestamp is the only one read; fails_when=a test that prints its own timestamp before the marker moves the line into the named step
  test('a test that prints its own timestamp gets the runner\'s in front of it, so the line does not match', () => {
    expect(refusal({ logs: { [JOB_ID]: log(line(FORGED_AT, `${GOOD_AT} GSTACK_TREE_JSON checks-tree ${b64(REC)}`)) } })).toEqual(['artifact_missing', expect.stringContaining('0 GSTACK_TREE_JSON lines')]);
    expect(refusal({ logs: { [JOB_ID]: log(line(FORGED_AT, `x\r${GOOD_AT} GSTACK_TREE_JSON checks-tree ${b64(REC)}`)) } })).toEqual(['artifact_missing', expect.stringContaining('0 GSTACK_TREE_JSON lines')]);
  });

  // Value: protects=step binding at the API's one-second resolution; fails_when=a line in the second the test step ended, after the step, or from a failed, missing, repeated or untimed step counts
  test('the line binds to the named step only: same second as the test step, after the step, or a step that is not one clean success all refuse', () => {
    const at = (t: string) => refusal({ logs: { [JOB_ID]: log(treeLine(t)) } })[0];
    expect(at('2026-11-19T11:20:00.4000000Z')).toBe('tree_log_unbound');
    expect(at('2026-11-19T11:20:01.0000000Z')).toBe('ok');
    expect(at('2026-11-19T11:20:01.9990000Z')).toBe('ok');
    expect(at('2026-11-19T11:20:02.0000000Z')).toBe('tree_log_unbound');
    expect(at('2026-11-19T11:20:03.9000000Z')).toBe('tree_log_unbound');
    expect(at('2026-11-19T11:20:04.5000000Z')).toBe('tree_log_unbound');
    expect(refusal({ jobs: [job({ steps: steps({ 'Complete job': { started_at: '2026-11-19T11:20:05Z', completed_at: '2026-11-19T11:20:06Z' } }) })], logs: { [JOB_ID]: log(treeLine('2026-11-19T11:20:03.9000000Z')) } })[0]).toBe('ok');
    expect(at('not-a-timeZ')).toBe('tree_log_unbound');
    const withSteps = (s: ApiStep[]) => refusal({ jobs: [job({ steps: s })], logs: { [JOB_ID]: log(treeLine(GOOD_AT)) } });
    expect(withSteps(steps({ [STEP]: { conclusion: 'failure' } }))).toEqual(['tree_log_unbound', expect.stringContaining('concluded failure')]);
    expect(withSteps(steps({ [STEP]: null }))).toEqual(['tree_log_unbound', expect.stringContaining(`no step named "${STEP}"`)]);
    expect(withSteps(steps({}, [{ number: 5, name: STEP, conclusion: 'success', started_at: '2026-11-19T11:20:04Z', completed_at: '2026-11-19T11:20:05Z' }]))).toEqual(['tree_log_unbound', expect.stringContaining('2 steps named')]);
    expect(withSteps(steps({ 'Run tests': { completed_at: null } }))).toEqual(['tree_log_unbound', expect.stringContaining('no start and finish time')]);
    expect(withSteps(steps({ [STEP]: { started_at: null } }))[0]).toBe('tree_log_unbound');
    expect(withSteps(steps({ 'Complete job': { started_at: null } }))).toEqual(['tree_log_unbound', expect.stringContaining('"Complete job" has no start and finish time')]);
    expect(withSteps(steps({}, [{ number: 5, name: 'Run more tests', conclusion: 'success', started_at: '2026-11-19T11:20:02Z', completed_at: '2026-11-19T11:25:00Z' }]))).toEqual(['tree_log_unbound', expect.stringContaining('before every later step started')]);
    expect(refusal({ jobs: [job({ conclusion: 'failure' })], logs: { [JOB_ID]: log(treeLine(GOOD_AT)) } })[0]).toBe('job_not_success');
    expect(refusal({ jobs: [job({ id: undefined })], logs: { [JOB_ID]: log(treeLine(GOOD_AT)) } })[0]).toBe('artifact_missing');
  });
});

describe('a log tree.json gets every check an artifact does', () => {
  // Value: protects=rule 2's size cap before decoding or parsing; fails_when=an oversized line is decoded and accepted
  test('a line whose tree.json is over 8 MiB refuses as artifact_missing', () => {
    const big = Buffer.alloc(8 * 1024 * 1024 + 1, 0x20).toString('base64');
    expect(refusal({ logs: { [JOB_ID]: log(line(GOOD_AT, `GSTACK_TREE_JSON checks-tree ${big}`)) } })).toEqual(['artifact_missing', expect.stringContaining('over 8388608 bytes')]);
  });

  // Value: protects=rule 2's unchanged verifyRun checks; fails_when=a decoded record skips the run, attempt, tree, os or shape checks
  test('a record naming another attempt, tree or OS, or a line that is not base64 JSON, refuses as an artifact would', () => {
    const with_ = (rec: unknown) => refusal({ logs: { [JOB_ID]: log(treeLine(GOOD_AT, rec)) } })[0];
    expect(with_({ ...REC, run_attempt: 2 })).toBe('artifact_mismatch');
    expect(with_({ ...REC, run_id: 1 })).toBe('artifact_mismatch');
    expect(with_({ ...REC, tree: 'c'.repeat(40) })).toBe('tree_mismatch');
    expect(with_({ ...REC, os: 'macOS' })).toBe('os_mismatch');
    expect(with_({ ...REC, reused: true })).toBe('artifact_reused');
    expect(with_({ ...REC, files: 'tests/a.test.ts' })).toBe('artifact_mismatch');
    expect(refusal({ logs: { [JOB_ID]: log(line(GOOD_AT, `GSTACK_TREE_JSON checks-tree ${Buffer.from('{not json').toString('base64')}`)) } })[0]).toBe('artifact_mismatch');
    expect(refusal({ logs: { [JOB_ID]: log(line(GOOD_AT, 'GSTACK_TREE_JSON checks-tree eyJ')) } })[0]).toBe('artifact_mismatch');
  });

  // Value: protects=the opt-in key's shape; fails_when=an empty, multi-line or non-string step name is accepted
  test('tree_log_step must be one step name', () => {
    const errs = (v: unknown) => runProfileErrors({ p: { ...PROFILE, tree_log_step: v } }, undefined).map(e => e.path);
    expect(errs(STEP)).toEqual([]);
    for (const bad of ['', ' ', 'a\nb', 7, 'x'.repeat(201)]) expect(errs(bad)).toEqual(['run_profiles["p"].tree_log_step']);
    expect(RESULT_CODES.CI_CARRY_TREE_LOG_UNBOUND.anchor).toBe('ci-carry-tree-log-unbound');
  });
});

describe('the receipt and the lane line say a tree.json came from a job log (rule 4)', () => {
  const receipt = (ci_carried: unknown) => ({ schema_version: 1 as const, head: HEAD, base: 'main', ci_carried } as Parameters<typeof receiptSummaryLine>[0]);
  // Value: protects=the receipt's ci_carried entry and SHIP_RECEIPT line record the source; fails_when=the field is dropped, unprinted or accepts another value
  test('a ci_carried entry records tree_source job-log, and SHIP_RECEIPT prints it after ci_carried', () => {
    const r = receipt([{ lane: 'tests', run: RUN_ID, attempt: 1, tree: TREE, tree_source: 'job-log' }]);
    expect(validateReceipt(r)).toEqual([]);
    expect(receiptSummaryLine(r)).toContain(`ci_carried=tests:${RUN_ID}/1 tree_source=job-log`);
    expect(receiptSummaryLine(receipt([{ lane: 'tests', run: RUN_ID, attempt: 1, tree: TREE }]))).not.toContain('tree_source');
    expect(validateReceipt(receipt([{ lane: 'tests', run: RUN_ID, attempt: 1, tree: TREE, tree_source: 'artifact' }])).length).toBeGreaterThan(0);
  });

  // Value: protects=the LANE line /ship prints; fails_when=record-ci's marker is not parsed into the lane result
  test('record-ci\'s recorded line carries tree_source into the LANE line', () => {
    const got = recordCiResult(`gstack-evidence: recorded label=tests exit=0 tests_ran=2 unit=files log=- source=ci runs=${RUN_ID}/1 tree_source=job-log policy=origin/main@abc`);
    expect(got).toMatchObject({ runs: `${RUN_ID}/1`, tests: '2', files: true, treeSource: 'job-log' });
    expect(laneLine({ label: 'tests', exit: 0, testsRan: '2 (files)', log: '-', carried: got.runs, treeSource: got.treeSource }).line).toBe(`LANE: tests carried run=${RUN_ID}/1 tests_ran=2 (files) tree_source=job-log`);
    expect(recordCiResult(`gstack-evidence: recorded label=tests exit=0 tests_ran=2 log=- source=ci runs=${RUN_ID}/1 policy=p`).treeSource).toBeUndefined();
  });
});

describe('the documented print step binds on a real runner, whose output stamps trail the echo (GST-3339)', () => {
  const RUN_STEP = 'Tested tree record in the log';
  const real = { ...PROFILE, tree_log_step: RUN_STEP };
  const at = (ms: number) => new Date(ms).toISOString();
  const sec = (ms: number) => at(Math.floor(ms / 1000) * 1000).replace('.000Z', 'Z');
  const shaped = (s: Array<[string, string, string]>): ApiStep[] => s.map(([name, started_at, completed_at], i) => ({ number: i + 1, name, conclusion: 'success', started_at, completed_at }));
  const bind = (stamp: string, s: ApiStep[], profile: RunProfile = real) => refusal({ jobs: [job({ steps: s })], logs: { [JOB_ID]: log(treeLine(stamp)) } }, profile)[0];

  // Value: protects=the regression record: the API times steps by flooring the runner's own clock, and run 44845717681's line (sleep 1 / sleep 2) refused as tree_log_unbound only because the step ended 1.65 s after its stamp; fails_when=the fixture drifts from the run it records
  test('run 44845717681 (sleep 1 / sleep 2) refuses and run 44857547577 (sleep 3 / sleep 5) binds, exactly as they did on GitHub', () => {
    expect(bind('2026-11-19T11:19:39.3384245Z', shaped([['Set up job', '2026-11-19T11:00:00Z', '2026-11-19T11:00:02Z'], ['Run tests', '2026-11-19T11:00:02Z', '2026-11-19T11:19:37Z'], ['Tested tree record (tree.json)', '2026-11-19T11:19:37Z', '2026-11-19T11:19:37Z'], [RUN_STEP, '2026-11-19T11:19:37Z', '2026-11-19T11:19:40Z'], ['Upload the tested tree', '2026-11-19T11:19:40Z', '2026-11-19T11:19:42Z'], ['Complete job', '2026-11-19T11:19:44Z', '2026-11-19T11:19:44Z']]))).toBe('tree_log_unbound');
    expect(bind('2026-11-19T11:19:41.4347497Z', shaped([['Set up job', '2026-11-19T11:00:00Z', '2026-11-19T11:00:02Z'], ['Run tests', '2026-11-19T11:00:02Z', '2026-11-19T11:19:37Z'], ['Tested tree record (tree.json)', '2026-11-19T11:19:37Z', '2026-11-19T11:19:38Z'], [RUN_STEP, '2026-11-19T11:19:38Z', '2026-11-19T11:19:46Z'], ['Upload the tested tree', '2026-11-19T11:19:46Z', '2026-11-19T11:19:47Z'], ['Complete job', '2026-11-19T11:19:49Z', '2026-11-19T11:19:49Z']]))).toBe('ok');
  });

  // Value: protects=the sleeps docs/pregate.md recommends bind whatever fraction of a second the test step ends on, with up to 2.5 s between the echo and the runner's stamp; fails_when=the docs recommend sleeps a stamping delay or the API's whole-second times can push outside the binding window
  test('the sleeps in docs/pregate.md bind at every sub-second offset and stamping delay up to 2.5 s', () => {
    const doc = require('fs').readFileSync(require('path').join(import.meta.dir, '..', 'docs', 'pregate.md'), 'utf8') as string;
    const m = /run: sleep (\d+) && echo "GSTACK_TREE_JSON checks-tree \$\(base64 -w0 tree\.json\)" && sleep (\d+)/.exec(doc);
    expect(m).not.toBeNull();
    const [before, after] = [Number(m![1]) * 1000, Number(m![2]) * 1000];
    const base = Date.parse('2026-11-19T11:19:37Z');
    for (const frac of [0, 1, 250, 500, 750, 999]) for (const delay of [0, 400, 1500, 2500]) {
      const ended = base + frac;
      const echoed = ended + before + 10;
      const closed = echoed + after + 10;
      const s = shaped([['Set up job', '2026-11-19T11:00:00Z', '2026-11-19T11:00:02Z'], ['Run tests', '2026-11-19T11:00:02Z', sec(ended)], [RUN_STEP, sec(ended), sec(closed)], ['Complete job', sec(closed + 5), sec(closed + 900)]]);
      expect([frac, delay, bind(at(echoed + delay), s)]).toEqual([frac, delay, 'ok']);
    }
  });
});
