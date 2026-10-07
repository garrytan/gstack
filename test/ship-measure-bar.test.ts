/**
 * The measurement bar's decision table (scripts/lib/measure-bar.ts), free and
 * deterministic, plus the runner paths that apply it (void redispatch, EXTEND
 * on identical inputs, classification records) with fake trial runners.
 * Rules (approved 2026-10-06): MEETS >= 9/10; MEETS-qualified 8/10 with every
 * red qualifying (provider on affirmative evidence, judge noise, a cited model
 * miss); EXTEND 7/10 or an unqualified 8/10, then one pooled decision on 20
 * (18 strict, 16 qualified); BELOW otherwise. Behavior uses 12 (11, 10, 9;
 * pooled 22 and 20 of 24); a judge trial is one output scored by its median
 * 3-sample panel. More than 30% provider-evidence failures voids a batch, which
 * may be redispatched once.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  barThresholds, classificationProblem, decide, identityMismatch, machineClass, providerEvidence,
  type BarKind, type BarTrial, type Classification, type FailureClass, type TrialSet,
} from '../scripts/lib/measure-bar';
import { MEASURE_DEFAULTS, classifyTrials, decideRound, extendCase, measureCase, type TrialRequest, type TrialResult } from '../scripts/ship-measure';

const temps: string[] = [];
const tmp = (prefix: string) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); temps.push(dir); return dir; };
afterAll(() => { for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true }); });

const ASSERTION = { failureCause: 'assertion', failureDetail: 'expected sorted' };
const API = { failureCause: 'api_error', failureEvidence: 'API Error: 529 overloaded' };
const TIMEOUT = { failureCause: 'session_timeout', failureEvidence: 'armed 300s timeout fired' };

/** A batch of n trials in one set; `fails` maps a 1-based slot to that trial's failure fields. */
function batch(set: TrialSet, n: number, fails: Record<number, Partial<BarTrial>> = {}, start = 0): BarTrial[] {
  return Array.from({ length: n }, (_, i) => {
    const failure = fails[i + 1];
    return { trial: start + i + 1, set, passed: !failure, ...(failure ?? {}) };
  });
}
const agent = (trial: number, cls: FailureClass, evidence = 'test/x.test.ts:12 read the capture'): Classification => ({ trial, class: cls, evidence, by: 'agent', at: '2026-10-06T00:00:00Z' });
const fails = (slots: number[], fields: Partial<BarTrial> = ASSERTION) => Object.fromEntries(slots.map(s => [s, fields]));

describe('thresholds round up from 9/10, 8/10 and 7/10', () => {
  test('N = 10, 12, 20 and 24', () => {
    expect(barThresholds(10)).toEqual({ trials: 10, strict: 9, qualified: 8, floor: 7 });
    expect(barThresholds(12)).toEqual({ trials: 12, strict: 11, qualified: 10, floor: 9 });
    expect(barThresholds(20)).toMatchObject({ strict: 18, qualified: 16 });
    expect(barThresholds(24)).toMatchObject({ strict: 22, qualified: 20 });
  });
});

describe('one batch of 10 (rule)', () => {
  const d = (trials: BarTrial[], records: Classification[] = [], kind: BarKind = 'rule') => decide(kind, kind === 'behavior' ? 12 : 10, trials, records);

  test('9/10 and 10/10 MEETS with no classification', () => {
    expect(d(batch('initial', 10, fails([4])))).toMatchObject({ decision: 'MEETS', next: 'none', passes: 9 });
    expect(d(batch('initial', 10))).toMatchObject({ decision: 'MEETS', passes: 10 });
  });

  test('a contract violation is never MEETS, even at 10/10 assertions passed', () => {
    const trials = batch('initial', 10).map(t => t.trial === 3 ? { ...t, contract: true } : t);
    expect(d(trials)).toMatchObject({ decision: 'BELOW', next: 'fix' });
  });

  test('8/10 with only qualifying reds is MEETS-qualified: machine provider, judge noise, a cited model miss', () => {
    expect(d(batch('initial', 10, fails([2, 5], API)))).toMatchObject({ decision: 'MEETS-qualified', needsClassify: [] });
    const trials = batch('initial', 10, fails([2, 5]));
    expect(d(trials, [agent(2, 'judge-noise', 'median 3 at threshold 4'), agent(5, 'model-miss', 'transcript.jsonl:88 skipped the sort step')]).decision).toBe('MEETS-qualified');
  });

  test('a sub-strict batch with unreviewed reds is needs-classify, listing exactly those trials', () => {
    const out = d(batch('initial', 10, fails([2, 5])), [agent(2, 'judge-noise', 'at threshold')]);
    expect(out).toMatchObject({ decision: 'needs-classify', next: 'classify', needsClassify: [5] });
    expect(d(batch('initial', 10, fails([1, 2, 3]))).decision).toBe('needs-classify');
  });

  test('8/10 with a timeout, a hang, a regression or a known fixable cause is a fix round', () => {
    expect(d(batch('initial', 10, { 2: TIMEOUT, 5: API })).decision).toBe('BELOW');
    expect(d(batch('initial', 10, { 2: { failureCause: 'provider_stall' }, 5: API })).decision).toBe('BELOW');
    for (const cls of ['regression', 'fixable', 'timeout', 'hang'] as const) {
      expect(d(batch('initial', 10, fails([2, 5])), [agent(2, cls), agent(5, 'judge-noise')])).toMatchObject({ decision: 'BELOW', next: 'fix' });
    }
  });

  test('8/10 with a red reviewed as unclassified, or a model miss without a citation, is EXTEND', () => {
    expect(d(batch('initial', 10, fails([2, 5])), [agent(2, 'unclassified', 'reviewed: no evidence for any route'), agent(5, 'judge-noise')]))
      .toMatchObject({ decision: 'EXTEND', next: 'extend' });
    expect(d(batch('initial', 10, fails([2, 5])), [agent(2, 'model-miss', 'the model went off script'), agent(5, 'judge-noise')]).decision).toBe('EXTEND');
  });

  test('7/10 EXTEND when every red qualifies or is reviewed; 7/10 with a fixable red is a fix round; 6/10 BELOW without classification', () => {
    expect(d(batch('initial', 10, fails([1, 2, 3], API))).decision).toBe('EXTEND');
    expect(d(batch('initial', 10, fails([1, 2, 3])), [agent(1, 'judge-noise'), agent(2, 'judge-noise'), agent(3, 'fixable')]).decision).toBe('BELOW');
    expect(d(batch('initial', 10, fails([1, 2, 3, 4])))).toMatchObject({ decision: 'BELOW', needsClassify: [] });
  });

  test('a later classification record supersedes an earlier one for the same trial', () => {
    const trials = batch('initial', 10, fails([2, 5]));
    expect(d(trials, [agent(2, 'judge-noise'), agent(5, 'judge-noise'), agent(5, 'fixable')]).decision).toBe('BELOW');
    expect(d(trials, [agent(2, 'judge-noise'), agent(5, 'fixable'), agent(5, 'judge-noise')]).decision).toBe('MEETS-qualified');
  });
});

describe('behavior (12) and judge (outputs as median panels)', () => {
  test('behavior: 11/12 MEETS, 10/12 qualified, 9/12 EXTEND, 8/12 BELOW', () => {
    expect(decide('behavior', 12, batch('initial', 12, fails([7]))).decision).toBe('MEETS');
    expect(decide('behavior', 12, batch('initial', 12, fails([1, 2], API))).decision).toBe('MEETS-qualified');
    expect(decide('behavior', 12, batch('initial', 12, fails([1, 2, 3], API))).decision).toBe('EXTEND');
    expect(decide('behavior', 12, batch('initial', 12, fails([1, 2, 3, 4]))).decision).toBe('BELOW');
  });

  test('behavior pooled over 24: 22 MEETS, 20 qualified, 19 BELOW', () => {
    const base = batch('initial', 12, fails([1, 2, 3], API));
    expect(decide('behavior', 12, [...base, ...batch('extend', 12, {}, 12)]).decision).toBe('MEETS-qualified');
    expect(decide('behavior', 12, [...batch('initial', 12, fails([1])), ...batch('extend', 12, fails([5]), 12)]).decision).toBe('MEETS');
    expect(decide('behavior', 12, [...base, ...batch('extend', 12, fails([1, 2]), 12)], [agent(16, 'unclassified'), agent(17, 'unclassified')]).decision).toBe('BELOW');
  });

  test('judge: each trial is one output, passing at 2 of its 3 samples whatever the runner claimed', () => {
    const outputs = batch('initial', 10).map(t => ({ ...t, samples: t.trial === 2 ? [true, false, false] : [true, false, true] }));
    expect(decide('judge', 10, outputs)).toMatchObject({ decision: 'MEETS', passes: 9 });
    const short = batch('initial', 10).map(t => ({ ...t, samples: [true, true] }));
    expect(decide('judge', 10, short).passes).toBe(0);
  });
});

describe('the pooled decision after EXTEND (once, never a third batch)', () => {
  const base = batch('initial', 10, fails([1, 2, 3], API));
  test('pooled 18/20 strict and 16/20 qualified MEET; 17/20 with an unqualified red is BELOW, never EXTEND', () => {
    expect(decide('rule', 10, [...batch('initial', 10, fails([1, 2])), ...batch('extend', 10, {}, 10)], [agent(1, 'unclassified'), agent(2, 'unclassified')]).decision).toBe('MEETS');
    expect(decide('rule', 10, [...base, ...batch('extend', 10, { 1: API }, 10)])).toMatchObject({ decision: 'MEETS-qualified', pooled: true, passes: 16 });
    expect(decide('rule', 10, [...base, ...batch('extend', 10, { 1: API, 2: API, 3: API, 4: ASSERTION }, 10)]).decision).toBe('BELOW');
    const unqualified = decide('rule', 10, [...batch('initial', 10, fails([1, 2])), ...batch('extend', 10, { 1: ASSERTION }, 10)], [agent(1, 'unclassified'), agent(2, 'judge-noise'), agent(11, 'unclassified')]);
    expect(unqualified).toMatchObject({ decision: 'BELOW', pooled: true, passes: 17 });
  });

  test('an extension red nobody classified is needs-classify; one with a fixable cause cancels the extension into a fix round', () => {
    expect(decide('rule', 10, [...base, ...batch('extend', 10, fails([1]), 10)])).toMatchObject({ decision: 'needs-classify', needsClassify: [11] });
    expect(decide('rule', 10, [...base, ...batch('extend', 10, fails([1]), 10)], [agent(11, 'fixable')]).decision).toBe('BELOW');
  });
});

describe('provider evidence is mechanical; void batches', () => {
  test('provider needs affirmative evidence: api_error, or pre_turn_infra naming a 429/5xx or reset; a refusal or crash never qualifies', () => {
    expect(providerEvidence({ trial: 1, set: 'initial', passed: false, ...API })).toContain('529');
    expect(providerEvidence({ trial: 1, set: 'initial', passed: false, failureCause: 'pre_turn_infra', failureEvidence: 'HTTP 429 rate limit' })).toContain('429');
    expect(providerEvidence({ trial: 1, set: 'initial', passed: false, failureCause: 'pre_turn_infra', failureEvidence: 'ECONNRESET while streaming' })).not.toBeNull();
    expect(providerEvidence({ trial: 1, set: 'initial', passed: false, failureCause: 'pre_turn_infra', failureEvidence: 'Cannot find module ./entry' })).toBeNull();
    expect(providerEvidence({ trial: 1, set: 'initial', passed: false, failureCause: 'refusal', failureEvidence: 'stop_reason refusal' })).toBeNull();
    expect(machineClass({ trial: 1, set: 'initial', passed: false, failureCause: 'refusal' })).toBeNull();
    expect(machineClass({ trial: 1, set: 'initial', passed: false, ...TIMEOUT })).toBe('timeout');
  });

  test('provider cannot be set by hand when failure_cause disagrees; a timeout never takes a qualifying class; evidence is required', () => {
    const assertion: BarTrial = { trial: 3, set: 'initial', passed: false, ...ASSERTION };
    expect(classificationProblem(assertion, 'rule', 'provider', 'I think the API flaked')).toContain('affirmative provider or transport evidence');
    expect(classificationProblem({ trial: 3, set: 'initial', passed: false, failureCause: 'pre_turn_infra', failureEvidence: 'module load failed' }, 'rule', 'provider', 'x')).toContain('pre_turn_infra');
    expect(classificationProblem({ trial: 3, set: 'initial', passed: false, ...TIMEOUT }, 'rule', 'model-miss', 'a.ts:1')).toContain('never qualifies');
    expect(classificationProblem(assertion, 'rule', 'fixable', '  ')).toContain('--evidence');
    expect(classificationProblem(assertion, 'rule', 'flaky', 'x')).toContain('class must be one of');
    expect(classificationProblem({ trial: 3, set: 'initial', passed: true }, 'rule', 'fixable', 'x')).toContain('passed');
    expect(classificationProblem({ trial: 3, set: 'initial', passed: false, ...API }, 'rule', 'provider', 'api 529')).toBeNull();
  });

  test('more than 30% provider-evidence failures voids the batch: one redispatch, then decided on it; void twice stops', () => {
    expect(decide('rule', 10, batch('initial', 10, fails([1, 2, 3, 4], API)))).toMatchObject({ decision: 'void', next: 'redispatch' });
    const redispatched = decide('rule', 10, [...batch('initial', 10, fails([1, 2, 3, 4], API)), ...batch('redispatch', 10, fails([5]), 10)]);
    expect(redispatched).toMatchObject({ decision: 'MEETS', passes: 9 });
    expect(redispatched.sets.map(s => [s.set, s.void])).toEqual([['initial', true], ['redispatch', false]]);
    expect(decide('rule', 10, [...batch('initial', 10, fails([1, 2, 3, 4], API)), ...batch('redispatch', 10, fails([1, 2, 3, 4], API), 10)]))
      .toMatchObject({ decision: 'void', next: 'stop' });
    expect(decide('rule', 10, batch('initial', 10, fails([1, 2, 3], API))).decision).not.toBe('void');
  });

  test('module-load failures (pre_turn_infra without provider evidence) never void a batch', () => {
    const crash = { failureCause: 'pre_turn_infra', failureEvidence: 'SyntaxError: Export named x not found' };
    expect(decide('rule', 10, batch('initial', 10, fails([1, 2, 3, 4, 5, 6], crash)))).toMatchObject({ decision: 'BELOW' });
  });

  test('a void extension gets its own one redispatch', () => {
    const base = batch('initial', 10, fails([1, 2, 3], API));
    expect(decide('rule', 10, [...base, ...batch('extend', 10, fails([1, 2, 3, 4], API), 10)])).toMatchObject({ decision: 'void', next: 'redispatch', pooled: true });
    expect(decide('rule', 10, [...base, ...batch('extend', 10, fails([1, 2, 3, 4], API), 10), ...batch('extend-redispatch', 10, {}, 20)]).decision).toBe('MEETS-qualified');
  });
});

describe('pooling identity', () => {
  test('a changed field is named, including the CI image digest', () => {
    const a = { tree: 't1', image: 'ghcr.io/x/ci@sha256:aaa', model: 'm' };
    expect(identityMismatch(a, { ...a })).toBeNull();
    expect(identityMismatch(a, { ...a, image: 'ghcr.io/x/ci@sha256:bbb' })).toContain('image changed');
    expect(identityMismatch(a, { ...a, tree: 't2' })).toContain('tree changed');
  });
});

describe('the runner applies the bar: redispatch, EXTEND, classify', () => {
  /** A fake runner; outcomes are keyed by trial number across every set. */
  const runner = (outcome: (trial: number) => TrialResult) => {
    const calls: TrialRequest[] = [];
    return { calls, run: async (r: TrialRequest) => { calls.push(r); return outcome(r.trial); } };
  };
  const opts = (outDir: string, run: (r: TrialRequest) => Promise<TrialResult>, identity = { tree: 't1', image: 'img-a' }) => ({
    caseId: 'bar-case', round: 'baseline', config: MEASURE_DEFAULTS, runner: run, outDir, parallel: 5, costPerTrialUsd: 0.1,
    evalDir: tmp('bar-history-'), log: () => {}, identity: () => identity,
  });

  test('a void batch is redispatched once by measure, and both batches are reported', async () => {
    const outDir = tmp('bar-void-');
    const r = runner(trial => trial <= 4 ? { passed: false, costUsd: 0.1, ...API } : { passed: true, costUsd: 0.1 });
    const m = await measureCase({ ...opts(outDir, r.run), kind: 'rule', approved: true });
    expect(r.calls).toHaveLength(20);
    expect(m).toMatchObject({ decision: 'MEETS', passes: 10, counted: 10 });
    expect(m.sets.map(s => `${s.set}:${s.passes}/${s.trials}${s.void ? ':void' : ''}`)).toEqual(['initial:6/10:void', 'redispatch:10/10']);
  });

  test('classify records reds, refuses a hand-set provider, and EXTEND pools once on identical inputs', async () => {
    const outDir = tmp('bar-extend-');
    const r = runner(trial => [2, 5, 9].includes(trial) ? { passed: false, costUsd: 0.1, ...ASSERTION } : { passed: true, costUsd: 0.1 });
    const m = await measureCase({ ...opts(outDir, r.run), kind: 'rule', approved: true });
    expect(m.decision).toBe('needs-classify');
    expect(() => classifyTrials(outDir, 'bar-case', 'baseline', [2], 'provider', 'looked like an outage', () => {})).toThrow('affirmative provider');
    expect(classifyTrials(outDir, 'bar-case', 'baseline', [2, 5, 9], 'unclassified', 'reviewed captures t02 t05 t09: no route', () => {}).decision).toBe('EXTEND');
    const records = fs.readFileSync(path.join(outDir, 'bar-case', 'baseline', 'classifications.jsonl'), 'utf8').trim().split('\n');
    expect(records).toHaveLength(3);
    await expect(extendCase({ ...opts(outDir, r.run, { tree: 't1', image: 'img-b' }) })).rejects.toThrow('image changed');
    const pooled = await extendCase({ ...opts(outDir, r.run) });
    expect(r.calls.map(c => c.trial).slice(10)).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    // 7/10 + 10/10 = 17/20: under the pooled strict bar, and its reds are not in a qualifying class.
    expect(pooled).toMatchObject({ decision: 'BELOW', counted: 20, passes: 17 });
    expect(decideRound(outDir, 'bar-case', 'baseline', () => {}).decision).toBe('BELOW');
    await expect(extendCase({ ...opts(outDir, r.run) })).rejects.toThrow('never a third batch');
  });

  test('EXTEND is refused unless the round decided EXTEND', async () => {
    const outDir = tmp('bar-noextend-');
    const r = runner(() => ({ passed: true, costUsd: 0.1 }));
    await measureCase({ ...opts(outDir, r.run), kind: 'rule', approved: true });
    await expect(extendCase({ ...opts(outDir, r.run) })).rejects.toThrow('is MEETS, not EXTEND');
  });
});
