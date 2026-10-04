/**
 * Unit tests for the flake-rank aggregator (WS1's dial). The CLI ranks tests
 * by retried passes (the flake signature) across finalized eval-store runs —
 * these pin the accounting: N attempt records = 1 run of that test, the
 * FINAL attempt decides pass/fail, retried passes count separately, partials
 * and runner artifacts are excluded, shard dirs recurse, and the recency
 * bound drops stale files.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { aggregate, collectEvalFiles } from '../scripts/eval-flake-rank';
import { manualReviewFixture } from './helpers/manual-judge-review-fixture';
import {
  analyzePassRates, attributeLegacyRecord, backfillEvalFiles, caseSeriesIdentities, downloadRunArtifacts, fisherOneSidedLower,
  formatPassRates, holmRejections, listWeeklyRuns, quarantinePolicyProblems, quarantineRunsSince, readTrialOutcomeDir,
  wilsonInterval, type HistoryFetcher, type PassRatePolicy, type QuarantineEntry, type Registry, type TrialRecord,
} from '../scripts/eval-flake-rank';
import { EVAL_POLICY } from './helpers/periodic-exclude-data';
import { TRIAL_OUTCOME_SCHEMA, formatTrialOutcomes } from './helpers/eval-store';
import { storedZip } from './helpers/stored-zip';

const entry = (name: string, passed: boolean, attempt: number) => ({
  name, suite: 's', tier: 'e2e', passed, attempt, duration_ms: 1000, cost_usd: 0.1,
});

const run = (tests: object[], extra: object = {}) => JSON.stringify({
  schema_version: 2, version: '1.0.0', branch: 'b', git_sha: 'x', hostname: 'h',
  timestamp: '2026-08-31T00:00:00Z', tier: 'e2e',
  total_tests: tests.length, passed: 0, failed: 0, total_cost_usd: 0, total_duration_ms: 0,
  tests, ...extra,
});

describe('eval-flake-rank aggregate', () => {
  test('manual acceptance is visible but not a scored failure or retried pass', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flakerank-manual-'));
    const manual = manualReviewFixture();
    const { manual_review: _receipt, ...ordinary } = manual;
    fs.writeFileSync(path.join(dir, 'prior.json'), run([{ ...ordinary, passed: true, exit_reason: 'success',
      judge_scores: { clarity: 4, completeness: 3, actionability: 4 } }]));
    fs.writeFileSync(path.join(dir, 'accepted.json'), run([manual]));
    const series = aggregate(collectEvalFiles(dir)).get(manual.name);
    expect(series).toMatchObject({ runs: 1, passes: 1, fails: 0, manualAccepted: 1,
      retriedPasses: 0, totalAttempts: 2 });
    const display = spawnSync(process.execPath, [path.resolve(import.meta.dir, '../scripts/eval-flake-rank.ts'), '--dir', dir],
      { encoding: 'utf8', timeout: 10_000 });
    expect(display.status, display.stderr).toBe(0);
    // pass-rates view: the prior automated pass is the one scored pre-policy
    // trial; the manual acceptance is counted in its own column, never scored.
    expect(display.stdout).toContain('pre-policy          manual  case');
    expect(display.stdout).toMatch(new RegExp(`1/1 \\[[^\\]]+\\]\\s+1  ${manual.name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`));
    fs.writeFileSync(path.join(dir, 'invalid-retry.json'), run([
      { ...ordinary, attempt: 1 }, { ...manual, attempt: 2 },
    ]));
    expect(aggregate(collectEvalFiles(dir)).get(manual.name)).toMatchObject({ runs: 2, passes: 1,
      fails: 1, manualAccepted: 1, retriedPasses: 0 });
    fs.writeFileSync(path.join(dir, 'invalid-pass.json'), run([{ ...manual, passed: true }]));
    expect(aggregate(collectEvalFiles(dir)).get(manual.name)).toMatchObject({ runs: 3, passes: 1,
      fails: 2, manualAccepted: 1, retriedPasses: 0 });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('final attempt decides; retried pass counts as retriedPass, not a fail', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flakerank-'));
    fs.writeFileSync(path.join(dir, 'run1.json'), run([
      entry('flaky', false, 1), entry('flaky', true, 2),   // pass on retry
      entry('steady', true, 1),
      entry('broken', false, 1), entry('broken', false, 2), // fails even retried
    ]));
    fs.writeFileSync(path.join(dir, 'run2.json'), run([
      entry('flaky', true, 1), entry('steady', true, 1),
    ]));
    const series = aggregate(collectEvalFiles(dir));
    expect(series.get('flaky')).toMatchObject({ runs: 2, passes: 2, fails: 0, retriedPasses: 1, totalAttempts: 3 });
    expect(series.get('steady')).toMatchObject({ runs: 2, passes: 2, fails: 0, retriedPasses: 0 });
    expect(series.get('broken')).toMatchObject({ runs: 1, passes: 0, fails: 1, retriedPasses: 0, totalAttempts: 2 });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('partials and runner artifacts are excluded; shard dirs recurse', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flakerank-'));
    fs.mkdirSync(path.join(dir, 'shards', 'slug-a'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'shards', 'slug-a', 'run.json'), run([entry('sharded', true, 1)]));
    fs.writeFileSync(path.join(dir, '_partial-e2e.json'), run([entry('inflight', false, 1)], { _partial: true }));
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{"version":1}');
    fs.writeFileSync(path.join(dir, 'slice-3.json'), '{"version":1}');
    const files = collectEvalFiles(dir);
    expect(files).toHaveLength(1);
    const series = aggregate(files);
    expect(series.has('sharded')).toBe(true);
    expect(series.has('inflight')).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('recency bound drops files older than sinceDays', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flakerank-'));
    const stale = path.join(dir, 'old.json');
    fs.writeFileSync(stale, run([entry('ancient', true, 1)]));
    const old = new Date(Date.now() - 90 * 86_400_000);
    fs.utimesSync(stale, old, old);
    fs.writeFileSync(path.join(dir, 'new.json'), run([entry('recent', true, 1)]));
    const files = collectEvalFiles(dir, 60);
    expect(files.map((f) => path.basename(f))).toEqual(['new.json']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// --- pass-rates ---

const registry: Registry = {
  kinds: { 'rule-a': 'rule', 'beh-b': 'behavior', 'gate-c': 'rule', 'mar-d': 'rule', 'judge one': 'judge',
    ...Object.fromEntries(Array.from({ length: 18 }, (_, i) => [`filler-${i}`, 'rule'])) },
  tiers: { 'rule-a': 'periodic', 'beh-b': 'periodic', 'gate-c': 'gate', 'mar-d': 'marathon',
    ...Object.fromEntries(Array.from({ length: 18 }, (_, i) => [`filler-${i}`, i < 9 ? 'gate' : 'periodic'])) },
  touchfiles: { 'rule-a': ['test/skill-e2e-a.test.ts', 'a/**'], 'beh-b': ['test/skill-e2e-b.test.ts', 'b/**'],
    'gate-c': ['test/skill-e2e-shared.test.ts'], 'mar-d': ['test/skill-e2e-shared.test.ts'] },
  judgeTouchfiles: { 'judge one': ['j/SKILL.md'] },
  globals: ['harness/**'],
  testNames: { 'gate-c': '/gate c labeled' },
};

let clock = 0;
function trial(id: string, outcome: 'passed' | 'failed' | 'skipped', extra: Partial<TrialRecord> = {}): TrialRecord {
  clock += 1;
  return {
    schema: TRIAL_OUTCOME_SCHEMA, case: id, file: 'test/x.test.ts', tier: registry.tiers[id] ?? 'judge',
    kind: registry.kinds[id]!, trial: 1, panel: { n: 1, k: 1 }, attempt: 1, outcome,
    ...(outcome === 'failed' ? { failure_class: 'assertion' as const } : {}),
    duration_ms: 1, cost_usd: 0, model: 'model-x', cli_version: '2.1.284', policy_version: 1, quarantined: false,
    execution: 'executed', source: 'shard', run_id: `run-${clock}`, recorded_at: new Date(Date.UTC(2026, 9, 1) + clock * 60_000).toISOString(),
    series_identity: 'id-1', ...extra,
  };
}
const many = (id: string, passes: number, fails: number, extra: Partial<TrialRecord> = {}) =>
  [...Array.from({ length: passes }, () => trial(id, 'passed', extra)), ...Array.from({ length: fails }, () => trial(id, 'failed', extra))];
const analyze = (records: TrialRecord[], quarantine: Record<string, QuarantineEntry> = {}, extra = {}) =>
  analyzePassRates(records, { registry, quarantine, now: Date.UTC(2026, 9, 2), ...extra });
const qEntry = (overrides: Partial<QuarantineEntry> = {}): QuarantineEntry => ({
  reason: 'Detector graded the posture wording; 7 of 10 fresh trials failed only the regex, transcripts attached.',
  failureClass: 'detector', tracking: 'TODOS.md "x"', owner: 'garrytan', enteredAt: '2026-09-29',
  exit: '>= 97% over >= 10 trials on the current identity', ...overrides,
});

describe('pass-rates statistics', () => {
  test('Wilson bounds match the documented policy arithmetic', () => {
    expect(wilsonInterval(10, 10).lo).toBeCloseTo(0.7225, 4);
    expect(wilsonInterval(6, 6).lo).toBeCloseTo(0.6097, 4);
    expect(wilsonInterval(125, 125).lo).toBeCloseTo(0.9702, 4);
    expect(wilsonInterval(10, 10).hi).toBe(1);
    expect(wilsonInterval(0, 0)).toEqual({ lo: 0, hi: 1 });
    const mid = wilsonInterval(7, 10);
    expect(mid.lo).toBeGreaterThan(0.39); expect(mid.hi).toBeLessThan(0.9);
  });

  test('one-sided Fisher exact matches a known table and is one-sided', () => {
    expect(fisherOneSidedLower(4, 6, 6, 6)).toBeCloseTo(0.227272727, 8);
    expect(fisherOneSidedLower(6, 6, 4, 6)).toBe(1);
    expect(fisherOneSidedLower(0, 10, 10, 10)).toBeLessThan(1e-4);
  });

  test('Holm rejects step-down and stops at the first non-rejection', () => {
    expect([...holmRejections([0.001, 0.02, 0.04], 0.05)].sort()).toEqual([0, 1, 2]);
    expect([...holmRejections([0.001, 0.03, 0.04], 0.05)]).toEqual([0]);
    expect([...holmRejections([0.03, 0.04], 0.05)]).toEqual([]);
    expect([...holmRejections([], 0.05)]).toEqual([]);
  });
});

describe('pass-rates labels', () => {
  test('thin history is INCONCLUSIVE, and after this PR every series starts there', () => {
    const report = analyze(many('rule-a', 9, 0));
    expect(report.cases[0]).toMatchObject({ case: 'rule-a', label: 'INCONCLUSIVE' });
    expect(formatPassRates(analyze([]))).toContain('every series starts INCONCLUSIVE');
  });

  test('PASSING, FLAKY and FAILING come from the interval against the entry rate', () => {
    expect(analyze(many('rule-a', 12, 0)).cases[0]!.label).toBe('PASSING');
    expect(analyze(many('beh-b', 10, 1)).cases[0]!.label).toBe('FLAKY');
    expect(analyze(many('beh-b', 2, 10)).cases[0]!.label).toBe('FAILING');
  });

  test('BROKEN: the latest run is 0/n after a prior interval at or above the entry rate', () => {
    const prior = many('beh-b', 80, 0, { run_id: 'old' });
    const latest = [1, 2, 3].map(n => trial('beh-b', 'failed', { run_id: 'new', trial: n, panel: { n: 3, k: 2 } }));
    expect(analyze([...prior, ...latest]).cases[0]!.label).toBe('BROKEN');
  });

  test('skipped trials carry no verdict; infra failures count as failed trials', () => {
    const stats = analyze([...many('rule-a', 10, 0), trial('rule-a', 'skipped'),
      trial('rule-a', 'failed', { failure_class: 'infra' })]).cases[0]!.current!;
    expect(stats).toMatchObject({ passes: 10, trials: 11, infra: 1 });
  });

  test('a new identity, model or CLI starts a new series; earlier series stay visible', () => {
    const report = analyze([...many('rule-a', 10, 0), ...many('rule-a', 3, 0, { series_identity: 'id-2' }),
      ...many('rule-a', 2, 0, { series_identity: 'id-2', cli_version: '2.1.285' })]);
    const c = report.cases[0]!;
    expect(c.series).toHaveLength(3);
    expect(c.current).toMatchObject({ identity: 'id-2', cli: '2.1.285', trials: 2 });
    expect(c.previous).toMatchObject({ identity: 'id-2', cli: '2.1.284', trials: 3 });
    expect(c.label).toBe('INCONCLUSIVE');
  });
});

describe('pass-rates alarms count post-policy trials of the current series only', () => {
  test('backfilled pre-policy failures are displayed but never alarm', () => {
    const report = analyze(many('rule-a', 2, 20, { policy_version: 0, source: 'backfill' }));
    expect(report.alarms).toEqual([]);
    expect(report.cases[0]!.prePolicy).toMatchObject({ passes: 2, trials: 22 });
    expect(report.cases[0]!.label).toBe('INCONCLUSIVE');
  });

  test('drift proposes quarantine for a blocking case below the entry rule; a rule case is flagged as behaving like behavior', () => {
    const kinds = analyze([...many('rule-a', 8, 2), ...many('beh-b', 8, 2), ...many('mar-d', 0, 10)]).alarms.map(a => `${a.kind}:${a.case}`);
    expect([...kinds].sort()).toEqual(['drift:beh-b', 'drift:rule-a', 'rule-as-behavior:mar-d', 'rule-as-behavior:rule-a']);
    expect(analyze(many('rule-a', 19, 1)).alarms).toEqual([]);
  });

  test('the Fisher regression alarm needs the minimum trials on both sides', () => {
    const old = many('gate-c', 6, 0, { series_identity: 'old' });
    const fresh = many('gate-c', 0, 6, { series_identity: 'new' });
    expect(analyze([...old, ...fresh]).alarms.map(a => a.kind)).toContain('regression');
    expect(analyze([...old, ...fresh.slice(0, 5)]).alarms.map(a => a.kind)).not.toContain('regression');
  });

  test('quarantine exit, expiry and cap', () => {
    const exit = analyze(many('beh-b', 10, 0), { 'beh-b': qEntry() }).alarms.map(a => a.kind);
    expect(exit).toContain('quarantine-exit');
    expect(exit).not.toContain('drift');
    const weekly = Array.from({ length: 8 }, (_, i) => new Date(Date.UTC(2026, 8, 30) + i * 7 * 86_400_000).toISOString());
    expect(analyze([], { 'beh-b': qEntry() }, { weeklyRuns: weekly }).alarms.map(a => a.kind)).toContain('quarantine-expired');
    expect(analyze([], { 'beh-b': qEntry() }, { weeklyRuns: weekly.slice(0, 7) }).alarms.map(a => a.kind)).not.toContain('quarantine-expired');
    expect(quarantineRunsSince('2026-09-01', undefined, Date.UTC(2026, 9, 27))).toBe(8);
    expect(quarantineRunsSince('not a date', undefined, 0)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('pass-rates reader compatibility across EVAL_POLICY versions (rollback floor)', () => {
  const v1: PassRatePolicy = { ...EVAL_POLICY, version: 1 };
  const v2: PassRatePolicy = { ...EVAL_POLICY, version: 2 };
  const mixed = () => [...many('rule-a', 10, 0, { policy_version: 1, series_identity: 'v1-id' }),
    ...many('rule-a', 0, 12, { policy_version: 2, series_identity: 'v2-id' }),
    ...many('beh-b', 0, 3, { policy_version: 2, series_identity: 'v2-only' })];

  test('a reader meets newer-policy trials: ignored entirely, counted and printed with the fix', () => {
    const report = analyze(mixed(), {}, { policy: v1 });
    expect(report).toMatchObject({ policyVersion: 1, postPolicyTrials: 10, newerPolicyTrials: 15, olderPolicyTrials: 0 });
    expect(report.cases.map(c => c.case)).toEqual(['rule-a']);
    expect(report.cases[0]).toMatchObject({ label: 'PASSING', current: { identity: 'v1-id', policyVersion: 1, passes: 10, trials: 10 }, previous: null });
    expect(report.cases[0]!.series.map(s => s.key)).toEqual(['v1-id|model-x|2.1.284|v1']);
    expect(report.alarms).toEqual([]);
    const text = formatPassRates(report);
    expect(text).toContain('ignored 15 trial(s) recorded under a policy newer than v1');
    expect(text).toContain('Fix: run pass-rates from a checkout at or after the commit that bumped EVAL_POLICY.version');
  });

  test('a reader meets older-policy trials: visible, never scored, never a drift baseline', () => {
    const report = analyze(mixed(), {}, { policy: v2 });
    expect(report).toMatchObject({ policyVersion: 2, postPolicyTrials: 15, olderPolicyTrials: 10, newerPolicyTrials: 0 });
    const ruleA = report.cases.find(c => c.case === 'rule-a')!;
    expect(ruleA.current).toMatchObject({ identity: 'v2-id', policyVersion: 2, passes: 0, trials: 12 });
    expect(ruleA.previous).toBeNull();
    expect(ruleA.series.map(s => s.policyVersion)).toEqual([1, 2]);
    expect(report.alarms.map(a => a.kind)).not.toContain('regression');
    const onlyOld = analyze(many('rule-a', 0, 12, { policy_version: 1 }), {}, { policy: v2 });
    expect(onlyOld.cases[0]).toMatchObject({ label: 'INCONCLUSIVE', current: null });
    expect(onlyOld.alarms).toEqual([]);
    expect(formatPassRates(onlyOld)).toContain('12 under an older policy (display only)');
  });
});

describe('quarantine policy', () => {
  const policy: PassRatePolicy = EVAL_POLICY;
  const now = Date.UTC(2026, 9, 2);
  test('a valid entry has no problems', () => {
    expect(quarantinePolicyProblems({ 'beh-b': qEntry() }, registry, policy, now)).toEqual([]);
  });

  test('a product defect, a missing diagnosis or field, a bad date or a non-blocking case is rejected', () => {
    const problems = (quarantine: Record<string, QuarantineEntry>) => quarantinePolicyProblems(quarantine, registry, policy, now).map(p => p.message);
    expect(problems({ 'beh-b': qEntry({ failureClass: 'product' as QuarantineEntry['failureClass'] }) }).join()).toContain('never quarantined');
    expect(problems({ 'beh-b': qEntry({ reason: 'flaky' }) }).join()).toContain('written diagnosis');
    expect(problems({ 'beh-b': qEntry({ owner: ' ' }) }).join()).toContain('missing owner');
    expect(problems({ 'beh-b': qEntry({ enteredAt: '09/29/2026' }) }).join()).toContain('YYYY-MM-DD');
    expect(problems({ 'beh-b': qEntry({ enteredAt: '2027-01-01' }) }).join()).toContain('future');
    expect(problems({ 'mar-d': qEntry() }).join()).toContain('not blocking');
    expect(problems({ 'judge one': qEntry() }).join()).toContain('no registered E2E case');
    expect(problems({ ghost: qEntry() }).join()).toContain('no registered E2E case');
  });

  test('at most 10% of a tier may be quarantined', () => {
    // 11 periodic cases in the fixture registry: the cap is 1.
    expect(quarantinePolicyProblems({ 'beh-b': qEntry() }, registry, policy, now)).toEqual([]);
    const over = quarantinePolicyProblems({ 'beh-b': qEntry(), 'rule-a': qEntry() }, registry, policy, now);
    expect(over.map(p => p.kind)).toEqual(['quarantine-cap']);
    expect(over[0]!.message).toContain('2 quarantined periodic cases exceed the 10% cap (1 of 11)');
  });
});

describe('pass-rates inputs', () => {
  test('trial-outcomes JSONL is schema-validated; invalid lines are reported, never guessed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'passrates-'));
    const valid = trial('rule-a', 'passed');
    fs.mkdirSync(path.join(dir, 'nested'));
    fs.writeFileSync(path.join(dir, 'nested', 'trial-outcomes.jsonl'), formatTrialOutcomes([valid]) + '{"schema":"other"}\nnot json\n');
    fs.writeFileSync(path.join(dir, 'unrelated.jsonl'), formatTrialOutcomes([valid]));
    const read = readTrialOutcomeDir(dir);
    expect(read.records).toHaveLength(1);
    expect(read.records[0]).toMatchObject({ case: 'rule-a', series_identity: 'id-1' });
    expect(read.errors).toHaveLength(2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('legacy records attribute by shard suffix, id, label or single-owner file, else stay unattributed', () => {
    expect(attributeLegacyRecord('/anything', 'skill-e2e-b--beh-b', registry)).toBe('beh-b');
    expect(attributeLegacyRecord('rule-a', 'skill-e2e-zzz', registry)).toBe('rule-a');
    expect(attributeLegacyRecord('/Rule a', 'skill-e2e-zzz', registry)).toBe('rule-a');
    expect(attributeLegacyRecord('/rule a extra', 'skill-e2e-zzz', registry)).toBeNull();
    expect(attributeLegacyRecord('/gate c labeled', undefined, registry)).toBe('gate-c');
    expect(attributeLegacyRecord('/a display name', 'skill-e2e-a', registry)).toBe('rule-a');
    expect(attributeLegacyRecord('/shared display', 'skill-e2e-shared', registry)).toBeNull();
  });

  test('backfill keeps only first attempts, defaults a missing attempt to 1, and labels records pre-policy', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'passrates-backfill-'));
    fs.writeFileSync(path.join(dir, 'run.json'), run([
      { ...entry_('rule-a', false, 1), exit_reason: 'timeout' }, entry_('rule-a', true, 2),
      { name: 'beh-b', suite: 's', tier: 'e2e', passed: true, duration_ms: 1, cost_usd: 0 },
      entry_('/unknown display', true, 1),
    ], { shard: 'skill-e2e-zzz' }));
    const { records, unattributed } = backfillEvalFiles(collectEvalFiles(dir), { run_id: '42', sha: 'abc' }, registry);
    expect(records.map(r => [r.case, r.outcome, r.failure_class, r.policy_version, r.source, r.run_id]))
      .toEqual([['rule-a', 'failed', 'timeout', 0, 'backfill', '42'], ['beh-b', 'passed', undefined, 0, 'backfill', '42']]);
    expect(formatTrialOutcomes(records)).toContain(TRIAL_OUTCOME_SCHEMA);
    expect(unattributed).toEqual(['/unknown display']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('series identity follows the case\'s own touchfiles, not GLOBAL_TOUCHFILES', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'passrates-series-'));
    const git = (...args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10_000 });
    for (const [file, body] of [['a/x.ts', '1'], ['b/y.ts', '1'], ['harness/run.ts', '1'], ['test/skill-e2e-a.test.ts', '1']] as const) {
      fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), body);
    }
    const snapshot = () => { expect(git('add', '-A').status).toBe(0); return caseSeriesIdentities(['rule-a', 'beh-b'], root, registry); };
    expect(git('init', '-q').status).toBe(0);
    const first = snapshot();
    expect(first['rule-a']).not.toBe(first['beh-b']);
    fs.writeFileSync(path.join(root, 'harness/run.ts'), '2');
    expect(snapshot()).toEqual(first);
    fs.writeFileSync(path.join(root, 'a/x.ts'), '2');
    const next = snapshot();
    expect(next['rule-a']).not.toBe(first['rule-a']);
    expect(next['beh-b']).toBe(first['beh-b']);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('pass-rates history fetch (injected, no network)', () => {
  test('lists runs per branch, deduplicated and newest first', () => {
    const fetcher: HistoryFetcher = {
      listRuns: (_repo, _workflow, branch) => branch === 'main'
        ? [{ id: 1, attempt: 1, sha: 'a', branch, createdAt: '2026-09-01T00:00:00Z' }, { id: 3, attempt: 1, sha: 'c', branch, createdAt: '2026-09-15T00:00:00Z' }]
        : [{ id: 3, attempt: 1, sha: 'c', branch, createdAt: '2026-09-15T00:00:00Z' }, { id: 2, attempt: 2, sha: 'b', branch, createdAt: '2026-09-08T00:00:00Z' }],
      listArtifacts: () => [], downloadZip: () => { throw new Error('unused'); },
    };
    expect(listWeeklyRuns({ repo: 'o/r', workflow: 'evals-periodic.yml', branches: ['feature', 'main'], limit: 10, fetcher }).map(r => r.id)).toEqual([3, 2, 1]);
  });

  test('downloads only matching, bounded artifacts once, and caches them', () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'passrates-cache-'));
    const downloads: number[] = [];
    const fetcher: HistoryFetcher = {
      listRuns: () => [],
      listArtifacts: () => [{ id: 10, name: 'trial-outcomes-gate', size: 100 }, { id: 11, name: 'paid-slice-1', size: 100 },
        { id: 12, name: 'trial-outcomes-huge', size: 10 ** 9 }, { id: 13, name: 'trial-outcomes/../escape', size: 1 }],
      downloadZip: (_repo, id, destination) => { downloads.push(id); fs.writeFileSync(destination, storedZip({ 'trial-outcomes.jsonl': formatTrialOutcomes([trial('rule-a', 'passed')]) })); },
    };
    const options = { repo: 'o/r', run: { id: 7, attempt: 1, sha: 's', branch: 'main', createdAt: '' }, cacheDir, fetcher,
      match: (name: string) => name.startsWith('trial-outcomes') };
    const dirs = downloadRunArtifacts(options);
    expect(downloads).toEqual([10]);
    expect(dirs).toHaveLength(1);
    expect(readTrialOutcomeDir(dirs[0]!).records.map(r => r.case)).toEqual(['rule-a']);
    expect(downloadRunArtifacts(options)).toEqual(dirs);
    expect(downloads).toEqual([10]);
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });
});

describe('pass-rates CLI', () => {
  const cli = (args: string[]) => spawnSync(process.execPath, [path.resolve(import.meta.dir, '../scripts/eval-flake-rank.ts'), ...args],
    { encoding: 'utf8', timeout: 20_000 });

  test('--dir prints per-case pass rates; --gate fails only on ACTION REQUIRED', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'passrates-cli-'));
    const id = 'plan-ceo-review-format-mode';
    const records = Array.from({ length: 12 }, (_, i) => ({ ...trial(id, i < 11 ? 'passed' : 'failed'), kind: 'behavior' as const, tier: 'periodic' }));
    fs.writeFileSync(path.join(dir, 'trial-outcomes.jsonl'), formatTrialOutcomes(records));
    const shown = cli(['--dir', dir, '--case', id]);
    expect(shown.status, shown.stderr).toBe(0);
    expect(shown.stdout).toContain(`11/12 [`);
    expect(shown.stdout).toMatch(new RegExp(`FLAKY\\s+behavior\\s+periodic.*${id}`));
    expect(shown.stdout).toContain('ACTION REQUIRED');
    expect(shown.stdout).toContain(`[drift] ${id} passes 11/12`);
    expect(cli(['--dir', dir, '--gate']).status).toBe(1);
    fs.writeFileSync(path.join(dir, 'trial-outcomes.jsonl'), formatTrialOutcomes(records.slice(0, 11)));
    const clean = cli(['--dir', dir, '--gate', '--json']);
    expect(clean.status, clean.stdout).toBe(0);
    expect(JSON.parse(clean.stdout).cases[0]).toMatchObject({ case: id, label: 'PASSING', current: { passes: 11, trials: 11 } });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

function entry_(name: string, passed: boolean, attempt: number) {
  return { name, suite: 's', tier: 'e2e', passed, attempt, duration_ms: 1000, cost_usd: 0.1 };
}
