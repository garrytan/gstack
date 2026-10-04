/**
 * test:health and the shared CI-history reader, driven by recorded fixture
 * data through an injected GitHub client (no network): each metric's counting
 * rule, the "unavailable: <reason>; next: <step>" degrade path (rate limit,
 * 5xx mid-pagination), the W7a 19-vs-20-run boundary, the CEO-10 unseeded
 * check, and the DX-9 tracking-issue decision.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { formatFlakeSummary, listWorkflowRuns, parseFlakeLedger, rankFlakyFiles, readCiFlakeLedgers, unavailableReason,
  type GhClient } from '../scripts/lib/ci-history';
import { censusStats, collectHealth, complexityAt, flakeCheck, formatHealth, issueActionFor, panelRedProbability, percentile, unseededCheck,
  type Check } from '../scripts/test-health-report';
import { TRIAL_OUTCOME_SCHEMA, formatTrialOutcomes, type TrialOutcomeRecord } from './helpers/eval-store';
import { EVAL_POLICY } from './helpers/periodic-exclude-data';
import { storedZip } from './helpers/stored-zip';

const NOW = Date.parse('2026-10-05T12:00:00Z');
const day = (offset: number) => new Date(NOW - offset * 86_400_000).toISOString();

type Route = [RegExp, (apiPath: string) => unknown];
function fakeClient(routes: Route[], zips: Record<number, Record<string, string>> = {}): GhClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getJson: (apiPath) => {
      calls.push(apiPath);
      const route = routes.find(([pattern]) => pattern.test(apiPath));
      if (!route) throw new Error(`unexpected GitHub call ${apiPath}`);
      return route[1](apiPath);
    },
    downloadZip: (_repo, artifactId, destination) => {
      const files = zips[artifactId];
      if (!files) throw new Error(`unexpected download ${artifactId}`);
      fs.writeFileSync(destination, storedZip(files));
    },
  };
}

const run = (id: number, extra: Record<string, unknown> = {}) => ({ id, run_attempt: 1, head_sha: `sha${id}`, head_branch: 'main', event: 'push',
  status: 'completed', conclusion: 'success', created_at: day(1), updated_at: day(1), run_started_at: day(1), pull_requests: [], ...extra });
const ledger = (file: string) => `${JSON.stringify({ ts: day(1), runner: 'free', kind: 'flaky-pass', file, shard: 3, branch: 'main' })}\n`;
const trialRecord = (caseId: string, outcome: 'passed' | 'failed', extra: Partial<TrialOutcomeRecord> = {}): TrialOutcomeRecord => ({
  schema: TRIAL_OUTCOME_SCHEMA, case: caseId, file: 'test/x.test.ts', tier: 'periodic', kind: 'rule', trial: 1, panel: { n: 1, k: 1 },
  attempt: 1, outcome, ...(outcome === 'failed' ? { failure_class: 'assertion' as const } : {}), duration_ms: 1, cost_usd: 1,
  policy_version: EVAL_POLICY.version, quarantined: false, execution: 'executed', source: 'junit', lane: 'periodic/full census', ...extra,
});
const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function freeRoot(seeded: number, unseeded: number): string {
  const root = tmp('health-root-');
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  const durations: Record<string, number> = {};
  for (let i = 0; i < seeded + unseeded; i++) {
    fs.writeFileSync(path.join(root, `test/f${i}.test.ts`), '');
    if (i < seeded) durations[`test/f${i}.test.ts`] = 1000;
  }
  fs.writeFileSync(path.join(root, 'scripts/free-test-durations.json'), JSON.stringify({ version: 1, recordedAt: day(2), durations }));
  return root;
}

describe('arithmetic', () => {
  test('percentile is nearest-rank; panel red probability is P(passes < k)', () => {
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 0.95)).toBe(5);
    expect(percentile([], 0.5)).toBeNull();
    expect(panelRedProbability(0.05, 1, 1)).toBeCloseTo(0.05, 10);
    expect(panelRedProbability(0.05, 3, 2)).toBeCloseTo(3 * 0.05 ** 2 * 0.95 + 0.05 ** 3, 10);
  });

  test('census stats separate raw failure rate, red probability in force and single-trial re-aggregation', () => {
    const records = [
      ...Array.from({ length: 4 }, (_, i) => trialRecord('rule-a', i === 0 ? 'failed' : 'passed')),
      ...Array.from({ length: 12 }, (_, i) => trialRecord('beh-b', i < 3 ? 'failed' : 'passed', { kind: 'behavior', panel: { n: 3, k: 2 },
        trial: (i % 3) + 1, source: 'shard', ...(i < 3 ? { failure_class: 'timeout' as const } : {}) })),
    ];
    const stats = censusStats(records, ['1', '2', '3', '4']);
    expect(stats).toMatchObject({ runs: 4, trials: 16, failed: 4, byKind: { rule: { trials: 4, failed: 1 }, behavior: { trials: 12, failed: 3 } },
      byClass: { assertion: 1, timeout: 3 } });
    expect(stats.redInForce).toBeCloseTo(1 - (1 - 0.25) * (1 - panelRedProbability(0.25, 3, 2)), 10);
    expect(stats.redSingleTrial).toBeCloseTo(1 - 0.75 * 0.75, 10);
    expect(stats.redInForce).toBeLessThan(stats.redSingleTrial);
  });
});

describe('W7a flake ledger reader', () => {
  test('torn ledger lines are dropped, never the file', () => {
    expect(parseFlakeLedger(`${ledger('test/a.test.ts')}{"torn\n${ledger('test/b.test.ts')}`).map(entry => entry.file)).toEqual(['test/a.test.ts', 'test/b.test.ts']);
  });

  test('the 5% rule needs a window of at least 20 runs: 19 runs is report-only, 20 enforces strictly above 5%', () => {
    const entries = new Map([[1, [{ ts: '', runner: 'free' as const, kind: 'flaky-pass' as const, file: 'test/a.test.ts' }]],
      [2, [{ ts: '', runner: 'free' as const, kind: 'flaky-pass' as const, file: 'test/a.test.ts' }]]]);
    const nineteen = rankFlakyFiles(entries, 19, day(7));
    expect(nineteen).toMatchObject({ runs: 19, flakyRuns: 2, enforceable: false, files: [{ file: 'test/a.test.ts', flakyRuns: 2, failing: false }] });
    expect(flakeCheck(nineteen)).toMatchObject({ status: 'pass', detail: expect.stringContaining('report-only: 19 main run(s)') });
    const twenty = rankFlakyFiles(entries, 20, day(7));
    expect(twenty.files[0]).toMatchObject({ rate: 0.1, failing: true });
    const check = flakeCheck(twenty);
    expect(check).toMatchObject({ status: 'fail', detail: 'test/a.test.ts: flaky in 2/20 main runs (10.0% > 5%)' });
    expect(check.fix).toContain('never raise the timeout or add a retry');
    expect(flakeCheck(rankFlakyFiles(new Map([...entries].slice(0, 1)), 20, day(7))).status).toBe('pass');
  });

  test('reads main ledgers, widening a thin window to the newest 20 runs; a run without a ledger had no flakes', () => {
    const runs = Array.from({ length: 25 }, (_, i) => run(100 + i, { created_at: day(i < 5 ? 1 : 10 + i) }));
    runs[3]!.conclusion = 'cancelled';
    const client = fakeClient([
      [/workflows\/free-tests\.yml\/runs/, () => ({ workflow_runs: runs })],
      [/runs\/100\/artifacts/, () => ({ artifacts: [{ id: 1, name: 'flake-ledger-3', size_in_bytes: 10 }, { id: 2, name: 'free-result-3', size_in_bytes: 10 }] })],
      [/runs\/101\/artifacts/, () => ({ artifacts: [{ id: 3, name: 'flake-ledger-7', size_in_bytes: 10, expired: true }] })],
      [/runs\/\d+\/artifacts/, () => ({ artifacts: [] })],
    ], { 1: { 'flake-ledger.jsonl': ledger('test/a.test.ts') + ledger('test/a.test.ts') } });
    const window = readCiFlakeLedgers({ client, repo: 'o/r', sinceDays: 7, now: NOW, cacheDir: tmp('health-cache-') });
    expect(window).toMatchObject({ runs: 20, flakyRuns: 1, enforceable: true, files: [{ file: 'test/a.test.ts', flakyRuns: 1, entries: 2, rate: 0.05, failing: false }] });
    expect(client.calls[0]).toContain('branch=main');
  });

  test('the job-summary table names files, counts and shards', () => {
    expect(formatFlakeSummary([])).toContain('None: every file passed on its first run.');
    const table = formatFlakeSummary(parseFlakeLedger(ledger('test/a.test.ts') + ledger('test/a.test.ts') + ledger('test/b.test.ts')));
    expect(table).toContain('3 flaky pass(es) in 2 file(s)');
    expect(table).toContain('| `test/a.test.ts` | 2 | 3 |');
    expect(table).toContain('bun run test:health --enforce');
  });
});

describe('unavailable reasons carry the next step', () => {
  test('rate limit, 5xx, auth and a missing CLI each name what to do', () => {
    expect(unavailableReason(new Error('gh api failed: HTTP 403: API rate limit exceeded for installation ID 161978188'))).toContain('gh api rate_limit');
    expect(unavailableReason(new Error('gh api failed: HTTP 502: Bad Gateway'))).toContain('rerun later');
    expect(unavailableReason(new Error('gh api failed: HTTP 401: Bad credentials'))).toContain('gh auth status');
    expect(unavailableReason(new Error('spawnSync gh ENOENT'))).toContain('https://cli.github.com');
  });

  test('a 5xx on page 2 fails the whole listing: a partial history is never reported as complete', () => {
    const page = Array.from({ length: 100 }, (_, i) => run(i + 1));
    const client = fakeClient([[/page=1$/, () => ({ workflow_runs: page })], [/page=2$/, () => { throw new Error('gh api failed: HTTP 502: Bad Gateway'); }]]);
    expect(() => listWorkflowRuns(client, 'o/r', 'free-tests.yml', { since: day(30), branch: 'main' })).toThrow('HTTP 502');
  });
});

describe('enforced checks and the tracking issue (DX-9)', () => {
  test('unseeded free files fail above 5 with the refresh command', () => {
    const failing = unseededCheck(freeRoot(2, 6));
    expect(failing).toMatchObject({ status: 'fail', detail: expect.stringContaining('stale seed: 6 unseeded file(s) > 5') });
    expect(failing.fix).toContain('bun run test:ubicloud --record-durations');
    expect(unseededCheck(freeRoot(2, 5))).toMatchObject({ status: 'pass', detail: expect.stringContaining('5 unseeded file(s) (limit 5)') });
  });

  test('failure -> unavailable -> verified recovery: the issue closes only on available, passing evidence', () => {
    const check = (status: Check['status']): Check => ({ id: 'flaky-files', title: 't', status, detail: '', fix: '' });
    const pass = { ...check('pass'), id: 'unseeded-free-files' };
    expect(issueActionFor([check('fail'), pass])).toBe('upsert');
    expect(issueActionFor([check('unavailable'), pass])).toBe('keep-open');
    expect(issueActionFor([check('pass'), pass])).toBe('close');
  });
});

describe('collectHealth over recorded fixture data', () => {
  function fixture() {
    const prTrials = formatTrialOutcomes([trialRecord('gate-a', 'passed', { tier: 'gate', lane: 'gate/pr', cost_usd: 2.5 }),
      trialRecord('gate-b', 'passed', { tier: 'gate', lane: 'gate/pr', execution: 'reused', cost_usd: 0 })]);
    const census = formatTrialOutcomes([
      ...Array.from({ length: 3 }, (_, i) => trialRecord('per-a', i === 0 ? 'failed' : 'passed', { trial: 1 })),
      trialRecord('gate-a', 'passed', { tier: 'gate', lane: 'gate/full census' })]);
    const prRuns = [run(1, { event: 'pull_request', head_branch: 'feature', created_at: day(1), updated_at: new Date(Date.parse(day(1)) + 600_000).toISOString() }),
      run(2, { event: 'pull_request', head_branch: 'feature', conclusion: 'cancelled' })];
    return fakeClient([
      [/workflows\/evals\.yml\/runs/, () => ({ workflow_runs: prRuns })],
      [/runs\/2\/artifacts/, () => ({ artifacts: [] })],
      [/runs\/1\/artifacts/, () => ({ artifacts: [{ id: 11, name: 'paid-plan', size_in_bytes: 10 }, { id: 12, name: 'trial-outcomes-pr-a1', size_in_bytes: 10 }] })],
      [/runs\/2\/attempts\/1\/jobs/, () => ({ jobs: [{ id: 1, name: 'eval-slices (1)', conclusion: 'cancelled', started_at: day(1), completed_at: new Date(Date.parse(day(1)) + 30 * 60_000).toISOString() },
        { id: 2, name: 'plan-slices', conclusion: 'success', started_at: day(1), completed_at: day(0) }] })],
      [/pulls\?state=closed/, () => [{ number: 9, merged_at: day(2), updated_at: day(2) }, { number: 8, merged_at: null, updated_at: day(2) }]],
      [/workflows\/evals-periodic\.yml\/runs/, () => ({ workflow_runs: [run(50, { event: 'workflow_dispatch' }), run(51, { event: 'workflow_dispatch', head_branch: 'feature' })] })],
      [/runs\/50\/artifacts/, () => ({ artifacts: [{ id: 51, name: 'trial-outcomes-periodic-a1', size_in_bytes: 10 }] })],
      [/runs\/50\/attempts\/1\/jobs/, () => ({ jobs: [{ id: 3, name: 'eval-slices (2)', conclusion: 'success', started_at: day(1), completed_at: new Date(Date.parse(day(1)) + 20 * 60_000).toISOString() },
        { id: 4, name: 'redispatch', conclusion: 'skipped', started_at: null, completed_at: null }] })],
      [/workflows\/free-tests\.yml\/runs/, () => ({ workflow_runs: [run(60), run(61, { conclusion: 'failure' })] })],
      [/runs\/60\/artifacts/, () => ({ artifacts: [{ id: 61, name: 'flake-ledger-2', size_in_bytes: 10 }] })],
      [/runs\/61\/artifacts/, () => ({ artifacts: [] })],
      [/workflows\/windows-free-tests\.yml\/runs/, () => ({ workflow_runs: [run(70)] })],
    ], {
      11: { 'manifest.json': JSON.stringify({ prCoverage: { mode: 'full-fallback' } }) },
      12: { 'trial-outcomes.jsonl': prTrials },
      51: { 'trial-outcomes.jsonl': census },
      61: { 'flake-ledger.jsonl': ledger('test/a.test.ts') },
    });
  }

  test('each metric reports its value and counting rule', () => {
    const report = collectHealth({ client: fixture(), repo: 'o/r', now: NOW, sinceDays: 7, cacheDir: tmp('health-cache-'), root: freeRoot(3, 0) });
    const value = (id: string) => report.metrics.find(entry => entry.id === id)!;
    expect(value('pr-fallback-rate').value).toBe('100.0% (1/1 runs)');
    expect(value('net-complexity').unavailable).toContain('git grep HEAD failed');
    expect(value('pr-reused-trials').value).toBe('1 of 2 trial records');
    expect(value('pr-spend')).toMatchObject({ value: '$2.50 recorded', detail: ['per merged PR: $2.50 (1 merged)', 'per validated revision: $2.50 (1 revisions)'] });
    expect(value('cancelled-slice-minutes').value).toBe('30 min/week (1 cancelled run(s))');
    expect(value('push-to-verdict').value).toBe('p50 10.0 min, p95 10.0 min (1 runs)');
    expect(value('census-periodic').value).toBe('1.00 expected failed trials/run (1/3 over 1 run(s)); P(red) 33.3% in force, 33.3% single-trial');
    expect(value('census-gate').value).toStartWith('0.00 expected failed trials/run (0/1 over 1 run(s))');
    expect(value('census-redispatch').value).toBe('0 of 1 census(es) re-dispatched; longest paid slice job 20.0 min');
    expect(value('quarantine-evidence').value).toContain('insufficient evidence (not the same as healthy)');
    expect(value('free-flaky-pass-rate').value).toStartWith('50.0% (1/2 main runs');
    expect(value('free-wall').value).toBe('free-tests 0.0 min (1 runs); windows-free-tests 0.0 min (1 runs)');
    expect(value('free-serial').value).toBe('3 s over 3 files');
    for (const entry of report.metrics.filter(entry => entry.id !== 'net-complexity')) {
      expect(entry.rule.length).toBeGreaterThan(10);
      expect(entry.unavailable, entry.id).toBeUndefined();
    }
    expect(report.checks.map(check => [check.id, check.status])).toEqual([['flaky-files', 'pass'], ['unseeded-free-files', 'pass']]);
    expect(report.issueAction).toBe('close');
    expect(formatHealth(report)).toContain('rule: share of evals.yml pull_request runs');
  });

  test('a rate-limited API degrades every remote metric to a named unavailable reason, never 0, and keeps the issue open', () => {
    const client = fakeClient([[/./, () => { throw new Error('gh api failed: HTTP 403: API rate limit exceeded for installation ID 1'); }]]);
    const report = collectHealth({ client, repo: 'o/r', now: NOW, sinceDays: 7, cacheDir: tmp('health-cache-'), root: freeRoot(3, 0) });
    const remote = report.metrics.filter(entry => !['free-serial', 'net-complexity'].includes(entry.id));
    expect(remote.length).toBeGreaterThan(8);
    for (const entry of remote) {
      expect(entry.value).toBeUndefined();
      expect(entry.unavailable).toContain('gh api rate_limit');
    }
    expect(report.metrics.find(entry => entry.id === 'free-serial')!.value).toBe('3 s over 3 files');
    expect(report.checks[0]).toMatchObject({ id: 'flaky-files', status: 'unavailable' });
    expect(report.issueAction).toBe('keep-open');
    const text = formatHealth(report);
    expect(text).toContain('unavailable: GitHub API rate limit');
    expect(text).toContain('Missing inputs (an unavailable check never fails the run, and keeps a tracking issue open): flaky-files');
  });
});

describe('net complexity (CEO-32)', () => {
  test('counts lines under scripts, test/helpers and workflows plus package scripts at a ref', () => {
    const root = path.resolve(import.meta.dir, '..');
    const head = complexityAt(root, 'HEAD');
    expect(head.loc).toBeGreaterThan(1000);
    expect(head.scripts).toBe(Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts).length);
  });
});

describe('CLI', () => {
  const cli = (args: string[]) => spawnSync(process.execPath, [path.resolve(import.meta.dir, '../scripts/test-health-report.ts'), ...args],
    { encoding: 'utf8', timeout: 20_000 });

  test('--help documents defaults, enforcement and the gh requirement; bad arguments exit 2', () => {
    const help = cli(['--help']);
    expect(help.status).toBe(0);
    for (const text of ['--since-days <n>', 'default 7', 'without it the command always exits 0', 'gh auth status']) expect(help.stdout).toContain(text);
    expect(cli(['--bogus']).status).toBe(2);
    expect(cli(['--since-days', '0']).status).toBe(2);
  });

  test('flake-summary renders downloaded ledgers', () => {
    const dir = tmp('health-ledgers-');
    fs.mkdirSync(path.join(dir, 'flake-ledger-4'));
    fs.writeFileSync(path.join(dir, 'flake-ledger-4', 'flake-ledger.jsonl'), ledger('test/a.test.ts'));
    const result = cli(['flake-summary', dir]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('| `test/a.test.ts` | 1 | 3 |');
  });
});
