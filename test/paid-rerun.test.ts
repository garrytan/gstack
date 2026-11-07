/**
 * Rule-16 flaky reruns (CREW rule 16, Garry 2026-10-19): a red case verdict
 * reruns once at the same head; a pass is GREEN with a flaky annotation and a
 * flake record, a second failure stays red. Every case here goes through the
 * real `--report` and `--rerun-plan` CLI paths the workflow runs, on a trimmed
 * capture of run 39293281037 written below (plan-ceo-finding-floor timed out in
 * attempt 1 and passed on `gh run rerun --failed` attempt 2; slice 6 renumbered
 * to 1, the JUnit failure message cut to its first two lines).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { type CaseObservation, FLAKE_RECORDS_FILE, RERUN_PLAN_ARTIFACT, resolveCases, rerunCandidates, rerunSpend } from '../scripts/lib/paid-rerun';
import { sliceExitCode } from '../scripts/lib/paid-plan';
import { BINDING_FILE, buildBinding, findReusableGate } from '../crew/scripts/gate-reuse';
import type { GhRunner } from '../crew/scripts/recover-receipts';
import { buildTrainRecord } from '../crew/scripts/train-gate';
import { classifyGate } from '../crew/lib/ship-queue-train-verdict';

const ROOT = path.resolve(import.meta.dir, '..');
const CASE = 'plan-ceo-finding-floor';
const SHARD = 'test/skill-e2e-plan-ceo-finding-floor.test.ts';
const FAIL = 'paid-slice-1-a1';
const PASS = 'paid-slice-1-a2';

const selection = { e2e: [CASE], judges: [] };
const budget = { timeoutMs: 1020000, source: 'registered', policyId: 'skill-e2e-plan-ceo-finding-floor-existing-retry-v1' };
const MANIFEST = { version: 1, tier: 'gate', evalsAll: false, sliceCount: 1, selectionReason: 'trimmed replay of run 39293281037 (slice 6 -> 1)', profile: 'pr', selection,
  prCoverage: { mode: 'dependents', e2e: [CASE], judges: [], deferred: [], unknownFiles: [], unknownFileLabels: [], directCases: [], derivedFiles: [], noConsumerFiles: [],
    deferredPromptFiles: [], missingCoverage: [], needsFullValidation: false, reasons: [] },
  plan: { sliceBudgetMs: 420000, jobs: 2, estimatedSliceMs: [418862], ciTimeoutMinutes: 50, sliceCiTimeoutMinutes: [50], codexSlices: [] },
  entries: [{ file: SHARD, slice: 1, status: 'planned', estimatedMs: 248087, budget }] };
const junit = (failure: string | null, seconds: string) => `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="1" assertions="0" failures="${failure ? 1 : 0}" skipped="0" time="${seconds}">
  <testsuite name="${SHARD}" file="${SHARD}" tests="1" assertions="0" failures="${failure ? 1 : 0}" skipped="0" time="${seconds}">
    <testsuite name="/plan-ceo-review AskUserQuestion floor (gate)" file="${SHARD}" line="15" tests="1" assertions="0" failures="${failure ? 1 : 0}" skipped="0" time="${seconds}">
      <testcase name="seeded forcing finding causes the agent to fire at least one AskUserQuestion" classname="/plan-ceo-review AskUserQuestion floor (gate)" time="${seconds}" file="${SHARD}" line="17" assertions="0"${failure
        ? `>\n        <failure type="Error" message="${failure}" />\n      </testcase>` : ' />'}
    </testsuite>
  </testsuite>
</testsuites>
`;
/** The two captured attempts of slice 6: the slice result, the shard's JUnit and its session ledger. */
const CAPTURE: Record<string, { slice: Record<string, unknown>; junit: string; ledger: Record<string, unknown> }> = {
  [FAIL]: {
    slice: { version: 1, tier: 'gate', profile: 'pr', selection, sliceIndex: 1, sliceCount: 1, attempt: 1, startedAt: 1792431197455, finishedAt: 1792431811508,
      outcomes: [{ files: [SHARD], status: 'failed', exitCode: 1, elapsedMs: 610510, executedTests: 1, skippedTests: 0, budget }] },
    junit: junit('floor test FAILED: outcome=timeout elapsed=609738ms&#10;summary: no qualifying finding question within 600000ms', '610.414157'),
    ledger: { key: 'pty:session#1', runner: 'pty', started_at: '2026-10-19T17:33:21.040Z', budget_ms: 600000, elapsed_ms: 609726, end: 'observer_timeout', billed: false },
  },
  [PASS]: {
    slice: { version: 1, tier: 'gate', profile: 'pr', selection, sliceIndex: 1, sliceCount: 1, attempt: 2, startedAt: 1792433125271, finishedAt: 1792433342167,
      outcomes: [{ files: [SHARD], status: 'passed', exitCode: 0, elapsedMs: 117689, executedTests: 1, skippedTests: 0, budget }] },
    junit: junit(null, '117.609903'),
    ledger: { key: 'pty:session#1', runner: 'pty', started_at: '2026-10-19T18:05:41.000Z', budget_ms: 600000, elapsed_ms: 117600, end: 'completed', billed: false },
  },
};

let base: string;
beforeAll(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'paid-rerun-')); });
afterAll(() => { fs.rmSync(base, { recursive: true, force: true }); });

type Placement = { from: string; to: string; attempt: number; edit?: (slice: any) => void };
function place(dir: string, p: Placement, extra: Record<string, unknown> = {}) {
  const capture = CAPTURE[p.from]!;
  const shard = path.join(dir, p.to, 'shards', 'skill-e2e-plan-ceo-finding-floor');
  fs.mkdirSync(shard, { recursive: true });
  fs.writeFileSync(path.join(shard, 'junit.xml'), capture.junit);
  fs.writeFileSync(path.join(shard, 'session-ledger.jsonl'), JSON.stringify(capture.ledger) + '\n');
  const slice = structuredClone({ ...capture.slice, attempt: p.attempt, ...extra }) as any;
  p.edit?.(slice);
  fs.writeFileSync(path.join(dir, p.to, 'slice-1.json'), JSON.stringify(slice));
}
let counter = 0;
/** A report dir holding the fixture manifest and the named first-execution slice artifacts. */
function reportDir(placements: Placement[]): string {
  const dir = path.join(base, `case-${++counter}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(MANIFEST));
  for (const p of placements) place(dir, p);
  return dir;
}

const env = (extra: NodeJS.ProcessEnv = {}) => ({ ...process.env, EVALS_TIER: 'gate', GITHUB_RUN_ID: '39293281037', GITHUB_SHA: '', GSTACK_GATE_PR: '', GSTACK_GATE_HEAD_SHA: '', ...extra });
const cli = (args: string[], extra: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, ['--no-env-file', '--config=/dev/null', path.join(ROOT, 'scripts/test-paid-shards.ts'), '--tier', 'gate', ...args],
  { cwd: ROOT, encoding: 'utf8', timeout: 60_000, env: env(extra) });
function report(dir: string) {
  const r = cli(['--report', dir]);
  const collector = JSON.parse(fs.readFileSync(path.join(dir, 'collector-outcomes.json'), 'utf8'));
  const flakes = fs.existsSync(path.join(dir, FLAKE_RECORDS_FILE))
    ? fs.readFileSync(path.join(dir, FLAKE_RECORDS_FILE), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  return { status: r.status, out: `${r.stdout}\n${r.stderr}`, collector, flakes };
}
/** The rerun-plan job: writes `<dir>/rerun-plan-a<attempt>/manifest.json` when it plans a rerun. */
function planRerun(dir: string, attempt: number) {
  const out = path.join(dir, `${RERUN_PLAN_ARTIFACT}-a${attempt}`);
  const r = cli(['--report', dir, '--rerun-plan', out], { GITHUB_RUN_ATTEMPT: String(attempt) });
  expect(r.status, r.stdout + r.stderr).toBe(0);
  const file = path.join(out, 'manifest.json');
  return { out: r.stdout, manifest: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null };
}
/** Attempt 1 failed, the real planner wrote its rerun manifest, and the eval-rerun job's result is `from` (as paid-rerun-1-a1). */
function withRerun(from: string, edit?: (slice: any) => void): string {
  const dir = reportDir([{ from: FAIL, to: FAIL, attempt: 1 }]);
  const plan = planRerun(dir, 1).manifest;
  expect(plan).not.toBeNull();
  fs.rmSync(path.join(dir, 'collector-outcomes.json'), { force: true });
  place(dir, { from, to: 'paid-rerun-1-a1', attempt: 1, edit }, { rerun: true, sliceCount: plan.sliceCount, selection: plan.selection });
  return dir;
}

describe('replay of run 39293281037 (trimmed capture)', () => {
  test('attempt 1 alone is RED, and the planner reruns exactly the failed case once, fresh', () => {
    const dir = reportDir([{ from: FAIL, to: FAIL, attempt: 1 }]);
    const r = report(dir);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('VERDICT RED');
    expect(r.flakes).toEqual([]);
    const plan = planRerun(dir, 1);
    expect(plan.out).toContain('rule-16 rerun of attempt 1: 1 case(s) once');
    expect(plan.manifest.rerun).toEqual({ attempt: 1, cases: [CASE] });
    expect(plan.manifest.entries.map((e: any) => e.file)).toEqual([SHARD]);
    expect(plan.manifest.selection).toEqual({ e2e: [CASE], judges: [] });
    expect(plan.manifest.tier).toBe('gate');
  });

  test('a manual `gh run rerun --failed` attempt that passes the red: GREEN, flaky-annotated, one flake record', () => {
    const r = report(reportDir([{ from: FAIL, to: FAIL, attempt: 1 }, { from: PASS, to: PASS, attempt: 2 }]));
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('VERDICT GREEN');
    expect(r.out).toContain('FLAKY 1 (failed once, passed on its one rule-16 rerun)');
    expect(r.collector.verdict.verdict).toBe('GREEN');
    expect(r.collector.flakyLines).toHaveLength(1);
    expect(r.collector.flakyLines[0]).toContain(`⚑ ${CASE}  rule  FLAKY: failed in attempt 1 (paid-slice-1-a1), passed on its one rerun in attempt 2 (paid-slice-1-a2); rerun cost unknown (no billing captured); first failure: assertion: floor test FAILED: outcome=timeout`);
    expect(r.flakes).toEqual([expect.objectContaining({ schema: 1, kind: 'gate-flake', case: CASE, case_kind: 'rule', run_id: '39293281037',
      first: { attempt: 1, phase: 'first', where: 'attempt 1 (paid-slice-1-a1)' }, rerun: { attempt: 2, phase: 'first', where: 'attempt 2 (paid-slice-1-a2)' },
      symptom: expect.stringContaining('outcome=timeout elapsed=609738ms'), rerun_cost_usd: null })]);
  });

  test('the in-run rerun that passes: GREEN, flaky-annotated, its record names the rerun, and nothing reruns again', () => {
    const dir = withRerun(PASS);
    const r = report(dir);
    expect(r.status, r.out).toBe(0);
    expect(r.flakes).toEqual([expect.objectContaining({ case: CASE, first: { attempt: 1, phase: 'first', where: 'attempt 1 (paid-slice-1-a1)' },
      rerun: { attempt: 1, phase: 'rerun', where: 'attempt 1 rerun (paid-rerun-1-a1)' } })]);
    expect(planRerun(dir, 2).manifest).toBeNull();
  });
});

describe('negative controls: rule 16 never turns a real red green', () => {
  test('red twice stays RED, is named a real red, and is never rerun again (one rerun per case)', () => {
    const dir = withRerun(FAIL);
    const r = report(dir);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain(`✗ ${CASE}  rule  FAILED TWICE (rule 16: a real red): attempt 1 (paid-slice-1-a1); again in attempt 1 rerun (paid-rerun-1-a1)`);
    expect(r.flakes).toEqual([]);
    expect(r.collector.flakyLines).toEqual([]);
    const again = planRerun(dir, 2);
    expect(again.manifest).toBeNull();
    expect(again.out).toContain(`not rerun: ${CASE} (failed twice`);
  });

  test('red twice is a real red everywhere it is read: the report, the reuse binding and lookup, and the train verdict', () => {
    const dir = withRerun(FAIL);
    const r = report(dir);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('VERDICT RED');
    expect(r.collector.verdict.verdict).toBe('RED');
    // gate-reuse: slices-report binds what the report proved, and find refuses it (evals.yml also fails the run on reconcile exit 1).
    const head = 'a'.repeat(40);
    const { binding } = buildBinding({ repository: 'garrytan/gstack', pr: 42, runId: 300, runAttempt: 1, headSha: head, baseSha: 'b'.repeat(40), profile: 'pr', reconcileExit: r.status!, reportDir: dir });
    expect(binding).toMatchObject({ verdict: 'RED', reconcile_exit: 1 });
    expect(binding!.flaky_cases).toBeUndefined();
    const gh: GhRunner = (args) => {
      const ok = (body: unknown) => ({ status: 0, stdout: JSON.stringify(body), stderr: '' });
      if (args.some(a => a.endsWith('/workflows/evals.yml/runs'))) {
        return ok({ workflow_runs: [{ id: 300, status: 'completed', conclusion: 'failure', event: 'pull_request', head_sha: head, run_attempt: 1,
          head_repository: { full_name: 'garrytan/gstack' }, pull_requests: [{ number: 42 }] }] });
      }
      if (args.some(a => /\/runs\/300\/artifacts$/.test(a))) return ok({ artifacts: [{ name: 'gate-binding-a1', expired: false }, { name: 'paid-slice-1-a1', expired: false }] });
      if (args[0] === 'run' && args[1] === 'download') {
        const out = args[args.indexOf('-D') + 1]!;
        fs.mkdirSync(out, { recursive: true });
        fs.writeFileSync(path.join(out, BINDING_FILE), JSON.stringify(binding));
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}` };
    };
    const found = findReusableGate({ repo: 'garrytan/gstack', pr: 42, headRepo: 'garrytan/gstack', branch: 'feature', selfRunId: 500, headSha: 'c'.repeat(40),
      testedSha: 'd'.repeat(40), repoRoot: dir, out: path.join(dir, 'reuse-out'), gh });
    expect(found.candidate).toBeNull();
    expect(found.lines.join('\n')).toContain('is RED, reconcile exit 1, conclusion failure');
    // The train verdict: its record is RED with the case a VERDICT red, and T1 classifies it RED whatever the run concluded.
    const record = buildTrainRecord({ reportDir: dir, nonce: 'gate.train-x', head, tree: 'e'.repeat(40), reconcileExit: r.status!,
      prefixes: [], run: { id: 300, attempt: 1, url: 'https://example.invalid/runs/300' } });
    expect(record.verdict).toBe('RED');
    expect(record.panels.find(p => p.case === CASE)).toMatchObject({ status: 'FAIL', red_class: 'VERDICT' });
    expect(record.panels.find(p => p.case === CASE)!.flaky).toBeUndefined();
    for (const conclusion of ['failure', 'success']) {
      expect(classifyGate(record, { nonce: 'gate.train-x', head, tree: 'e'.repeat(40) }, { status: 'completed', conclusion }, { status: 'completed', conclusion: 'success' } as never).outcome).toBe('RED');
    }
  });

  test('a manual attempt after a failed rerun never makes it flaky: two failures stay RED', () => {
    const dir = withRerun(FAIL);
    place(dir, { from: PASS, to: PASS, attempt: 2 });
    const r = report(dir);
    expect(r.status, r.out).toBe(1);
    expect(r.flakes).toEqual([]);
  });

  test('a later attempt never hides a new red: attempt 1 passed, attempt 2 failed, RED', () => {
    const r = report(reportDir([{ from: PASS, to: FAIL, attempt: 1 }, { from: FAIL, to: PASS, attempt: 2 }]));
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('VERDICT RED');
    expect(r.flakes).toEqual([]);
  });

  test('a first-attempt pass: GREEN with no flake record and nothing to rerun', () => {
    const dir = reportDir([{ from: PASS, to: PASS, attempt: 1 }]);
    const r = report(dir);
    expect(r.status, r.out).toBe(0);
    expect(r.flakes).toEqual([]);
    expect(r.out).not.toContain('FLAKY');
    expect(fs.existsSync(path.join(dir, FLAKE_RECORDS_FILE))).toBe(false);
    expect(planRerun(dir, 1).manifest).toBeNull();
  });

  for (const [label, edit] of [
    ['a runner error (harness)', (s: any) => { s.outcomes[0].runnerError = 'spawn failed'; }],
    ['a slice-deadline hang (INCOMPLETE)', (s: any) => { Object.assign(s.outcomes[0], { sliceDeadline: 'hung', status: 'timed-out', exitCode: null }); }],
    ['a checkpoint the slice never finalized', (s: any) => { s.checkpoint = true; }],
  ] as const) {
    test(`${label} is never rerun and never flaky, even when a later attempt passes`, () => {
      expect(planRerun(reportDir([{ from: FAIL, to: FAIL, attempt: 1, edit }]), 1).manifest).toBeNull();
      const r = report(reportDir([{ from: FAIL, to: FAIL, attempt: 1, edit }, { from: PASS, to: PASS, attempt: 2 }]));
      expect(r.status, r.out).toBe(1);
      expect(r.flakes).toEqual([]);
    });
  }

  test('rerun results without their rerun manifest are set aside and the red stays', () => {
    const dir = withRerun(PASS);
    fs.rmSync(path.join(dir, `${RERUN_PLAN_ARTIFACT}-a1`), { recursive: true });
    const r = report(dir);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('rule-16 rerun ignored: attempt 1: rerun results without a readable rerun manifest');
    expect(r.flakes).toEqual([]);
  });

  test('the rerun reads the same in both download-artifact layouts: a lone match unpacked into its path, or each in its own directory', () => {
    const lone = withRerun(PASS);
    fs.mkdirSync(path.join(lone, 'reruns'));
    fs.renameSync(path.join(lone, 'paid-rerun-1-a1'), path.join(lone, 'reruns', 'only'));
    const several = withRerun(PASS);
    const planDir = path.join(several, `${RERUN_PLAN_ARTIFACT}-a1`);
    fs.renameSync(planDir, `${planDir}.tmp`);
    fs.mkdirSync(planDir);
    fs.renameSync(`${planDir}.tmp`, path.join(planDir, `${RERUN_PLAN_ARTIFACT}-a1`));
    for (const dir of [lone, several]) {
      const r = report(dir);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain('FLAKY 1');
      expect(r.flakes.map((f: any) => f.case)).toEqual([CASE]);
    }
  });

  test('a rerun result that does not match its manifest is set aside and the red stays', () => {
    const r = report(withRerun(PASS, slice => { slice.sliceCount = 9; }));
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('1 rerun result(s) do not match the rerun manifest');
    expect(r.flakes).toEqual([]);
  });

  test('a rerun counts only for the cases its manifest planned', () => {
    const dir = withRerun(PASS);
    const planFile = path.join(dir, `${RERUN_PLAN_ARTIFACT}-a1`, 'manifest.json');
    fs.writeFileSync(planFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(planFile, 'utf8')), rerun: { attempt: 1, cases: ['some-other-case'] } }));
    const r = report(dir);
    expect(r.status, r.out).toBe(1);
    expect(r.flakes).toEqual([]);
  });
});

describe('case history resolution (pure)', () => {
  const o = (attempt: number, phase: 'first' | 'rerun', outcome: 'passed' | 'failed', extra: Partial<CaseObservation> = {}): CaseObservation => ({
    case: 'c', kind: 'rule', attempt, phase, outcome, eligible: outcome === 'failed', keys: ['test/x.test.ts'], where: `a${attempt} ${phase}`,
    costUsd: 0.5, costKnown: true, ...extra });

  test('flaky only when the one failure is eligible and the very next observation passed', () => {
    expect(resolveCases([o(1, 'first', 'failed'), o(1, 'rerun', 'passed')]).get('c')!.status).toBe('flaky');
    expect(resolveCases([o(1, 'first', 'failed'), o(1, 'rerun', 'failed')]).get('c')!.status).toBe('red');
    expect(resolveCases([o(1, 'first', 'failed', { eligible: false, reason: 'INFRA failure class' }), o(2, 'first', 'passed')]).get('c')!.reason).toBe('never rerun: INFRA failure class');
    expect(resolveCases([o(1, 'first', 'failed')]).get('c')!.reason).toBe('no rerun verdict');
    expect(resolveCases([o(1, 'first', 'passed')]).has('c')).toBe(false);
    expect(resolveCases([o(1, 'first', 'passed'), o(2, 'first', 'failed')]).get('c')!.status).toBe('red');
  });

  test('candidates: only an eligible single failure nothing has re-executed, including an earlier attempt never reached', () => {
    expect(rerunCandidates([o(1, 'first', 'failed')])).toHaveLength(1);
    expect(rerunCandidates([o(1, 'first', 'failed'), o(2, 'first', 'passed')])).toEqual([]);
    expect(rerunCandidates([o(1, 'first', 'failed'), o(1, 'rerun', 'failed')])).toEqual([]);
    expect(rerunCandidates([o(1, 'first', 'failed', { eligible: false, reason: 'runner error' })])).toEqual([]);
    expect(rerunCandidates([o(1, 'first', 'passed')])).toEqual([]);
  });

  test('rerun spend counts every execution after a case first failed', () => {
    expect(rerunSpend([o(1, 'first', 'failed'), o(1, 'rerun', 'passed', { costKnown: false })])).toEqual({ executions: 1, usd: 0.5, unknown: 1 });
    expect(rerunSpend([o(1, 'first', 'passed')])).toEqual({ executions: 0, usd: 0, unknown: 0 });
  });
});

describe('gate slice exit (case verdicts)', () => {
  const ran = { status: 'failed' as const, exitCode: 1, executedTests: 2, skippedTests: 0 };
  test('a completed rule shard red is report input on the gate lane, so the run concludes as the report does', () => {
    expect(sliceExitCode([ran], { caseVerdicts: true })).toBe(0);
    expect(sliceExitCode([ran])).toBe(1);
  });
  test('execution failures still red the slice', () => {
    for (const bad of [{ ...ran, runnerError: 'x' }, { ...ran, sliceDeadline: 'hung' as const }, { ...ran, executedTests: null }, { ...ran, skippedTests: 2 },
      { ...ran, exitCode: null }, { ...ran, status: 'timed-out' as const }, { status: 'never-started' as const, exitCode: null, executedTests: null, skippedTests: null }]) {
      expect(sliceExitCode([bad], { caseVerdicts: true }), JSON.stringify(bad)).toBe(1);
    }
  });
});
