import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  PyRandom, SCREEN_LABEL, caseCostTable, changedLinesByFile, gateCostBreakdown, heuristicPreambleOnly, parseEvalReport,
  prSelectionCost, simulateTrains, summarizeGates, summarizeSelector, type GateRecord, type PrDiff, type SelectionDeps,
} from '../lib/gate-cost';
import {
  DIAGNOSED_REDS, SCREEN_CANARY_CASES, classifyReds, headGreenAt, parseReportVerdict, percentile, pickTrain, prForRun, readyTimes, screenHit,
  simulateArrivalTrains, stampFreeSignature, summarizeRedHeads, type GatedRun, type HeadDiff, type RedHeadRow,
} from '../lib/gate-cost-history';
import {
  buildReport, checkoutSelectionDeps, formatHistory, formatReport, parseArgs, parseMergeLog, parseWindowDate, readGateRecord, type HistoryReport, type ReplayReport,
} from '../scripts/gate-cost-replay';

/**
 * A one-run artifact tree, written to a temporary directory: tracked files
 * under test/fixtures would need a FREE_FIXTURES entry, and that registry is
 * a paid-runner input that selects every PR-profile case.
 */
const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-cost-run-'));
afterAll(() => fs.rmSync(RUN_DIR, { recursive: true, force: true }));
const usage = (inputTokens: number, outputTokens: number, cacheReadInputTokens: number, cacheCreationInputTokens: number, thinkingTokens: number, costUSD: number) =>
  ({ inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, thinkingTokens, costUSD });
const FIXTURE_FILES: Record<string, unknown> = {
  'paid-slice-1-a1/shards/skill-e2e-demo--case-a/1.0.0-HEAD-e2e-demo.json': { tests: [{
    name: '/case a', tier: 'e2e', duration_ms: 40_500, cost_usd: 0.253, model: 'claude-fable-5-1', transcript: [
      { type: 'assistant' },
      { type: 'result', modelUsage: { 'claude-fable-5-1': usage(100, 2000, 100_000, 10_000, 500, 0.251), 'claude-haiku-4-5-20251001': usage(1000, 100, 0, 0, 0, 0.0015) } },
      { type: 'result', modelUsage: { 'claude-fable-5-1': usage(50, 0, 0, 0, 0, 0.0005) } },
    ] }] },
  'paid-slice-1-a1/shards/skill-e2e-demo--case-a/_partial-e2e.json': { tests: [{ name: '/case a', duration_ms: 40_500, cost_usd: 99 }] },
  'paid-slice-2-a1/shards/skill-llm-eval/1.0.0-HEAD-llm-judge.json': { tests: [{ name: 'demo/SKILL.md judge', tier: 'llm-judge', duration_ms: 20_000, cost_usd: 0.06 }] },
};
for (const [file, body] of Object.entries(FIXTURE_FILES)) {
  fs.mkdirSync(path.dirname(path.join(RUN_DIR, file)), { recursive: true });
  fs.writeFileSync(path.join(RUN_DIR, file), JSON.stringify(body));
}
const trial = (caseId: string, file: string, kind: string, durationMs: number, runner?: string) =>
  JSON.stringify({ schema: 'gstack-trial-outcome/v1', case: caseId, file, kind, duration_ms: durationMs, cost_usd: 0, ...(runner ? { sessions: [{ runner }] } : {}) });
fs.mkdirSync(path.join(RUN_DIR, 'trial-outcomes-pr-a1'));
fs.writeFileSync(path.join(RUN_DIR, 'trial-outcomes-pr-a1', 'trial-outcomes.jsonl'), [
  trial('case-a', 'test/skill-e2e-demo.test.ts', 'rule', 40_000, 'claude-p'),
  trial('case-pty', 'test/skill-e2e-pty-demo.test.ts', 'rule', 100_000, 'pty'),
  'not json',
  trial('demo/SKILL.md judge', 'test/skill-llm-eval.test.ts', 'judge', 20_000),
].join('\n') + '\n');
const run1 = () => readGateRecord(RUN_DIR, '1');

/** GSTA-49's l3.json: 92 merged PRs of 2026-10-03..18, [today's selection cost > 0 ? 1 : 0, screen cost on the 106.0259 full-gate scale]. */
const L3_ROWS: Array<[number, number]> = [
  [0,14.3731], [1,14.0509], [1,14.0509], [1,106.0259], [1,106.0259], [1,106.0259], [1,102.6497], [1,14.0509], [0,14.0509], [1,15.5642],
  [0,15.5642], [0,0], [1,14.2545], [0,14.0509], [0,14.0509], [1,14.0509], [0,14.0509], [1,53.2204], [1,80.5128], [1,48.761],
  [1,47.2944], [1,46.47], [0,15.5642], [1,86.2435], [1,14.0509], [1,50.8781], [1,27.4209], [1,57.6069], [1,106.0259], [1,14.0509],
  [1,106.0259], [1,14.0509], [1,14.0509], [1,14.3731], [1,76.3276], [1,106.0259], [1,14.0509], [1,16.2643], [0,14.0509], [1,92.6175],
  [1,78.0744], [1,14.6998], [1,31.99], [1,14.0509], [1,14.0509], [1,19.9311], [1,59.4491], [1,14.0509], [1,106.0259], [1,22.1538],
  [1,14.0509], [1,78.4857], [1,62.5585], [1,106.0259], [1,14.0509], [1,50.6055], [1,79.9843], [1,79.5795], [1,67.6899], [0,0],
  [1,106.0259], [1,14.0509], [1,14.0509], [1,14.6998], [1,95.9865], [1,14.6998], [0,15.5642], [1,20.58], [0,15.2423], [1,106.0259],
  [1,33.2109], [1,106.0259], [1,106.0259], [0,15.5642], [0,14.0509], [0,15.5642], [1,106.0259], [1,106.0259], [1,106.0259], [0,15.5642],
  [1,106.0259], [0,15.5642], [0,1.5133], [0,15.5642], [1,19.7931], [1,106.0259], [0,15.5642], [1,106.0259], [1,106.0259], [1,21.6093],
  [1,106.0259], [1,106.0259],
];

describe('paid report artifacts', () => {
  test('reads eval reports and trial outcomes, skipping partial reports', () => {
    const gate = run1();
    expect(gate.tests.map(t => [t.name, t.file, t.costUsd])).toEqual([
      ['/case a', 'test/skill-e2e-demo.test.ts', 0.253],
      ['demo/SKILL.md judge', 'test/skill-llm-eval.test.ts', 0.06],
    ]);
    expect(gate.tests[0]!.modelUsage['claude-fable-5-1']).toMatchObject({ inputTokens: 150, outputTokens: 2000, thinkingTokens: 500, costUSD: 0.2515 });
    expect(gate.trials.map(t => [t.caseId, t.kind, t.runner])).toEqual([['case-a', 'rule', 'claude-p'], ['case-pty', 'rule', 'pty'], ['demo/SKILL.md judge', 'judge', null]]);
    expect(parseEvalReport('x', { notTests: [] })).toEqual([]);
  });

  test('aggregates cost by model and token class through lib/pricing.ts', () => {
    const b = gateCostBreakdown(run1());
    expect(b.recordedUsd).toBeCloseTo(0.313, 9);
    expect(b.byModel['claude-fable-5-1']).toBeCloseTo(0.2515, 9);
    expect(b.byModel['claude-haiku-4-5-20251001']).toBeCloseTo(0.0015, 9);
    expect(b.byModel['llm-judge']).toBeCloseTo(0.06, 9);
    const fable = b.tokenClasses['claude-fable-5-1']!;
    expect(fable.cacheWrite.usd).toBeCloseTo(0.125, 9);
    expect(fable.output.usd).toBeCloseTo(0.1, 9);
    expect(fable.output.thinkingTokens).toBe(500);
    expect(fable.cacheRead.usd).toBeCloseTo(0.025, 9);
    expect(fable.uncachedInput.usd).toBeCloseTo(0.0015, 9);
    expect(fable.pricedUsd).toBeCloseTo(fable.recordedUsd, 9);
    expect(b.tokenClasses['claude-haiku-4-5-20251001']!.pricedUsd).toBeCloseTo(0.0015, 9);
    const twice = summarizeGates([run1(), { tests: run1().tests.map(t => ({ ...t, costUsd: t.costUsd * 3 })) }]);
    expect(twice.recordedUsd.min).toBeCloseTo(0.313, 9);
    expect(twice.recordedUsd.mean).toBeCloseTo(0.626, 9);
  });

  test('per-case mean across gates; a case with no recorded cost is estimated from duration and marked', () => {
    const second: GateRecord = { ...run1(), tests: run1().tests.map(t => (t.name === '/case a' ? { ...t, costUsd: 0.453 } : t)) };
    const table = caseCostTable([run1(), second]);
    expect(table.cases['case-a']).toMatchObject({ estimated: false, recordedGates: 2 });
    expect(table.cases['case-a']!.costUsd).toBeCloseTo(0.353, 9);
    expect(table.usdPerSecond).toBeCloseTo((0.253 + 0.453 + 0.12) / 120, 9);
    expect(table.cases['case-pty']).toMatchObject({ estimated: true, recordedGates: 0, runner: 'pty' });
    expect(table.cases['case-pty']!.costUsd).toBeCloseTo(100 * table.usdPerSecond, 9);
    expect(caseCostTable([run1()], { usdPerSecond: 0.01 }).cases['case-pty']!.costUsd).toBeCloseTo(1, 9);
  });
});

const COSTS = { cases: Object.fromEntries([['a', 10], ['b', 5], ['c', 1], ['j1', 0.5], ['j2', 0.5]].map(([id, usd]) => [id, { caseId: id as string, costUsd: usd as number }])), usdPerSecond: 0 } as never;
function fakeDeps(touched: string[][] = []): SelectionDeps {
  return {
    gateCases: ['a', 'b', 'c'], judgeCases: ['j1', 'j2'],
    today: files => ({ e2e: files.some(f => f.endsWith('.tmpl')) ? ['a', 'b'] : [], judges: [], shadowE2e: null, mode: 'pr' }),
    touchfiles: files => { touched.push(files); return { e2e: files.some(f => f.endsWith('.tmpl')) ? ['b'] : [], global: false }; },
  };
}
const diff = (files: string[], extra: Partial<PrDiff> = {}): PrDiff => ({ pr: 1, sha: 'abc', files, packageVersionOnly: false, skillMdChangedLines: {}, ...extra });

describe('selection cost of a merged PR', () => {
  test('a package.json version stamp is neither selected nor a canary trigger; every judge is always in the screen', () => {
    const touched: string[][] = [];
    const stamp = prSelectionCost(diff(['package.json', 'VERSION', 'CHANGELOG.md'], { packageVersionOnly: true }), fakeDeps(touched), COSTS);
    expect(stamp.screenProvisional).toMatchObject({ canary: false, canaryReasons: [], cases: 0, judges: 2, usd: 1 });
    expect(touched).toEqual([['VERSION', 'CHANGELOG.md']]);
    const real = prSelectionCost(diff(['package.json']), fakeDeps(), COSTS);
    expect(real.screenProvisional.canaryReasons).toEqual(['full-gate file package.json']);
    expect(real.screenProvisional.usd).toBe(13);
    expect(prSelectionCost(diff([]), fakeDeps(), COSTS).screenProvisional.usd).toBe(1);
  });

  test('the version stamp also adds no canary through the checkout selectors', () => {
    const row = prSelectionCost(diff(['package.json', 'VERSION', 'CHANGELOG.md'], { packageVersionOnly: true }), checkoutSelectionDeps(), COSTS);
    expect(row.today.cases).toBe(0);
    expect(row.screenProvisional.canary).toBe(false);
  });

  test('transitive-only files and heuristic preamble-only SKILL.md changes add the canary set, capped at the full gate', () => {
    const row = prSelectionCost(diff(['review/SKILL.md.tmpl']), fakeDeps(), COSTS);
    expect(row.today).toEqual({ cases: 2, judges: 0, usd: 15 });
    expect(row.shadow.usd).toBe(15);
    expect(row.screenProvisional).toMatchObject({ cases: 1, usd: 17, canary: true });
    const skills = Array.from({ length: 10 }, (_, i) => `s${i}/SKILL.md`);
    const lines = Object.fromEntries(skills.map((file, i) => [file, ['+shared preamble line', ...(i === 0 ? ['+only here'] : [])]]));
    expect(heuristicPreambleOnly(lines)).toEqual(skills.slice(1));
    expect(heuristicPreambleOnly(Object.fromEntries(Object.entries(lines).slice(0, 9)))).toEqual([]);
    const preamble = prSelectionCost(diff(skills, { skillMdChangedLines: lines }), fakeDeps(), COSTS);
    expect(preamble.screenProvisional.preambleOnly).toHaveLength(9);
    expect(preamble.screenProvisional.canaryReasons[0]).toContain('preamble-only');
    expect(prSelectionCost(diff(['setup', 'scripts/resolvers/x.ts']), { ...fakeDeps(), touchfiles: () => ({ e2e: ['a', 'b', 'c'], global: false }) }, COSTS).screenProvisional.usd).toBe(17);
  });

  test('git -U0 diffs parse into distinct changed lines per file', () => {
    const text = ['diff --git a/x/SKILL.md b/x/SKILL.md', '--- a/x/SKILL.md', '+++ b/x/SKILL.md', '@@ -1 +1 @@', '-old line', '+new line ', '+new line', 'diff --git a/y/SKILL.md b/y/SKILL.md', '+other'].join('\n');
    expect(changedLinesByFile(text)).toEqual({ 'x/SKILL.md': ['-old line', '+new line'], 'y/SKILL.md': ['+other'] });
  });

  test('selector summaries average over every merged PR, zeros included', () => {
    expect(summarizeSelector([{ cases: 0, judges: 0, usd: 0 }, { cases: 2, judges: 0, usd: 10 }, { cases: 4, judges: 0, usd: 20 }], 20))
      .toEqual({ meanUsd: 10, medianUsd: 10, meanCases: 2, nearFull: 1 });
  });
});

describe('merge-train model', () => {
  test('PyRandom reproduces CPython random.Random', () => {
    const r = new PyRandom(1);
    expect([r.random(), r.random()]).toEqual([0.13436424411240122, 0.8474337369372327]);
    const items = Array.from({ length: 10 }, (_, i) => i);
    new PyRandom(1).shuffle(items);
    expect(items).toEqual([6, 8, 9, 7, 5, 3, 0, 4, 1, 2]);
    const s = new PyRandom(1);
    expect(s.sample(Array.from({ length: 100 }, (_, i) => i), 3)).toEqual([17, 72, 97]);
    expect(s.sample(Array.from({ length: 20 }, (_, i) => i), 10)).toEqual([2, 8, 3, 15, 14, 7, 10, 6, 17, 1]);
    expect(new PyRandom(2 ** 40 + 7).random()).toBe(0.6137037779936511);
  });

  const prs = L3_ROWS.map(([relevant, cost]) => ({ paidRelevant: relevant === 1, screenUsd: cost * 93.14 / 106.0259 }));
  const model = (policy: Parameters<typeof simulateTrains>[0]['policy']) => simulateTrains({ prs, policy, windowDays: 15.1, trainSize: 5, outsideRed: 0.15 });

  test('reproduces the measurement sim (trains of 5, o=0.15, 6%/25% red, 400 reps, seed 1)', () => {
    expect(prs).toHaveLength(92);
    const all = model({ kind: 'all' }), half = model({ kind: 'random', fraction: 0.5 }), none = model({ kind: 'none' });
    expect([all, half, none].map(r => Math.round(r.weeklyUsd))).toEqual([3403, 2672, 1986]);
    expect(Math.round(all.screenWeeklyUsd)).toBe(2196);
    expect(none.screenWeeklyUsd).toBe(0);
    expect(all.gateAttemptsWeekly).toBeCloseTo(12.73, 2);
    expect(none.bisectsWeekly).toBeCloseTo(10.27, 2);
    expect(half.rebuildOnceWeekly).toBeCloseTo(1.44, 2);
    expect(half.stallsWeekly).toBeCloseTo(0.22, 2);
    expect(all.firstCandidateRedShare).toBeCloseTo(0.32, 2);
    expect(none.attemptRedShare).toBeCloseTo(0.50, 2);
    expect(all.multipleVsToday).toBeCloseTo(9950 / all.weeklyUsd, 9);
    expect(all.multipleVsAfterGsta48).toBeCloseTo(8400 / all.weeklyUsd, 9);
    expect(all.perMergedPrUsd).toBeCloseTo(all.weeklyUsd / (92 * 7 / 15.1), 9);
  });

  test('cheapest-half screens the cheaper half and is deterministic for a seed', () => {
    const cheap = model({ kind: 'cheapest-half' }), expensive = model({ kind: 'expensive-half' });
    expect(Math.round(cheap.weeklyUsd)).toBe(1996);
    expect(cheap.screenWeeklyUsd).toBeLessThan(expensive.screenWeeklyUsd);
    expect(model({ kind: 'random', fraction: 0.8 })).toEqual(model({ kind: 'random', fraction: 0.8 }));
  });
});

describe('gate-cost-replay CLI', () => {
  test('parses window dates as UTC days with an inclusive end, and merge subjects', () => {
    expect(parseWindowDate('2026-10-03', false).toISOString()).toBe('2026-10-03T00:00:00.000Z');
    expect(parseWindowDate('2026-10-17', true).toISOString()).toBe('2026-10-18T00:00:00.000Z');
    expect(parseMergeLog('a1\t2026-10-17T00:00:00Z\tv1.0 fix: x (#3261)\nb2\t2026-10-17T00:00:00Z\tno pr here\n')).toEqual([{ pr: 3261, sha: 'a1', committedAt: '2026-10-17T00:00:00Z' }]);
    expect(() => parseArgs(['--since', '2026-10-03', '--until', '2026-10-17'])).toThrow('--runs');
    expect(() => parseArgs(['--runs', '1', '--prs', '2', '--since', '2026-10-03', '--until', '2026-10-04'])).toThrow('either');
  });

  test('every printed screening figure is labelled screen-provisional', () => {
    const args = parseArgs(['--runs', '1', '--reps', '5']);
    const merges = { prs: [{ pr: 7, sha: 'abcdef12', committedAt: '' }, { pr: 8, sha: 'bcdef123', committedAt: '' }], windowDays: 7 };
    const deps: SelectionDeps = { ...fakeDeps(), gateCases: ['case-a', 'case-pty'], judgeCases: ['demo/SKILL.md judge'] };
    const files: Record<number, string[]> = { 7: ['x/SKILL.md.tmpl'], 8: ['docs/x.md'] };
    const body = buildReport(args, [run1()], merges, deps, m => diff(files[m.pr]!, { pr: m.pr, sha: m.sha }));
    const report: ReplayReport = { repo: 'o/r', ref: 'origin/main', head: '0123456789', ...body };
    const text = formatReport(report);
    const screenLines = text.split('\n').filter(line => /\bscreen\b/i.test(line));
    expect(screenLines.length).toBeGreaterThan(3);
    for (const line of screenLines) expect(line).toContain(SCREEN_LABEL);
    expect(text).toContain(`${SCREEN_LABEL}: its preamble detector is a line-commonality heuristic`);
    expect(body.model!.rows).toHaveLength(12);
    expect(JSON.stringify(body.prs[0])).toContain('"screenProvisional"');
  });
});

describe('red attribution (GSTA-47 rule)', () => {
  test('report verdicts: rule, judge (spaced id) and unbound-shard failure lines', () => {
    const text = ['[test:paid] VERDICT RED — lane gate/pr, attempt 1', '[test:paid] failures and split verdicts:',
      '  ✗ tpa-absent-darwin  rule  FAIL  assertion — expected  [slice 14, attempt 1]',
      '  ✗ canary/SKILL.md monitoring loop  judge  FAIL  score 2 < 3',
      '  ✗ test/skill-e2e-demo.test.ts  rule shard NOT REPORTED  [slice 3, attempt 1]'].join('\n');
    expect(parseReportVerdict(text)).toEqual({ verdict: 'RED', failures: [
      { caseId: 'tpa-absent-darwin', kind: 'rule' }, { caseId: 'canary/SKILL.md monitoring loop', kind: 'judge' }, { caseId: 'test/skill-e2e-demo.test.ts', kind: 'rule' }] });
    expect(parseReportVerdict('[test:paid] VERDICT GREEN — lane gate/pr').verdict).toBe('GREEN');
    expect(parseReportVerdict('no report').verdict).toBe('NONE');
  });

  test('the own-diff signature ignores hunk positions, index lines and the package.json version', () => {
    const diff = (hunk: string, index: string, version: string, body: string) => ['diff --git a/x.ts b/x.ts', `index ${index}`, '--- a/x.ts', '+++ b/x.ts', hunk, body,
      'diff --git a/package.json b/package.json', '--- a/package.json', '+++ b/package.json', '@@ -3 +3 @@', `-  "version": "1.0.0",`, `+  "version": "${version}",`].join('\n');
    const base = stampFreeSignature(diff('@@ -1 +1 @@', 'aaa..bbb', '1.0.1', '+x'));
    expect(stampFreeSignature(diff('@@ -9 +9 @@', 'ccc..ddd', '1.0.2', '+x'))).toBe(base);
    expect(stampFreeSignature(diff('@@ -1 +1 @@', 'aaa..bbb', '1.0.1', '+y'))).not.toBe(base);
    expect(stampFreeSignature(diff('@@ -1 +1 @@', 'aaa..bbb', '1.0.1', '+x').split('\n').slice(0, 6).join('\n'))).toBe(base);
  });

  const H = (sha: string) => `${sha}000000000000000000000000000000000000000`.slice(0, 40);
  const run = (id: number, pr: number | null, head: string, hour: number, failures: string[] = []): GatedRun =>
    ({ id, pr, head: H(head), createdAt: new Date(Date.UTC(2026, 9, 5, hour)).toISOString(), green: failures.length === 0, failures: failures.map(caseId => ({ caseId, kind: 'rule' })) });
  const heads = new Map<string, HeadDiff>([
    [H('a1'), { ownSig: 's1', files: ['x/SKILL.md.tmpl'] }], [H('a2'), { ownSig: 's2', files: ['x/SKILL.md.tmpl', 'test/helpers/case-a.ts'] }],
    [H('b1'), { ownSig: 't1', files: ['docs/b.md'] }], [H('b2'), { ownSig: 't1', files: ['docs/b.md'] }],
    [H('c1'), { ownSig: 'u1', files: ['docs/c.md'] }], [H('c2'), { ownSig: 'u2', files: ['docs/c.md', 'docs/d.md'] }],
  ]);
  const deps = {
    heads,
    delta: (from: string, to: string) => (from === H('a1') && to === H('a2') ? ['test/helpers/case-a.ts', 'lib/from-main.ts'] : ['docs/d.md']),
    touches: (caseId: string, files: string[]) => files.filter(file => file === `test/helpers/${caseId}.ts`),
  };

  test('own push touching the case inputs is PR-caused; red elsewhere, same own diff, unrelated pushes and no later run are not', () => {
    const runs = [
      run(1, 10, 'a1', 0, ['case-a', 'case-shared']), run(2, 10, 'a2', 2),
      run(3, 11, 'b1', 1, ['case-b']), run(4, 11, 'b2', 3, ['case-b']),
      run(5, 12, 'c1', 4, ['case-shared', 'case-c']), run(6, 12, 'c2', 5),
      run(7, 13, 'zz', 6, ['case-z']), run(8, 14, 'zz', 7),
    ];
    const reds = classifyReds(runs, deps, { prCaused: [], outside: [] });
    const byRun = Object.fromEntries(reds.map(r => [r.runId, r]));
    expect(byRun[1]!.cause).toBe('pr');
    expect(byRun[1]!.cases.map(c => [c.caseId, c.cause, c.reason])).toEqual([
      ['case-a', 'pr', 'fixed by own push: test/helpers/case-a.ts'], ['case-shared', 'outside', 'also red in #12']]);
    expect(byRun[3]!.cases[0]).toMatchObject({ cause: 'outside', reason: 'still red with the same own diff' });
    expect(byRun[4]!.cases[0]).toMatchObject({ cause: 'unknown', reason: 'no later gated run' });
    expect(byRun[5]!.cases.map(c => c.reason)).toEqual(['also red in #10', 'passed next after an unrelated push']);
    expect(byRun[5]!.cause).toBe('outside');
    expect(byRun[7]!.cause).toBe('unknown');
    expect(classifyReds([run(9, 15, 'q1', 0, [])].map(r => ({ ...r, green: false })), deps)[0]).toMatchObject({ cause: 'outside', cases: [] });
  });

  test('transcript diagnoses win, and the 72-hour window bounds "red elsewhere"', () => {
    const own = DIAGNOSED_REDS.prCaused[0], outside = DIAGNOSED_REDS.outside[0];
    const reds = classifyReds([run(own, 20, 'a1', 0, ['case-x']), run(outside, 21, 'a1', 0, ['case-y']), run(30, 22, 'b1', 1, ['case-x'])], deps);
    expect(reds.find(r => r.runId === own)!.cases[0]!.reason).toBe('diagnosed own edit (GSTA-45)');
    expect(reds.find(r => r.runId === outside)!.cases[0]!.reason).toBe('diagnosed main defect (fix wave 3)');
    const far = classifyReds([run(40, 30, 'a1', 0, ['case-a']), run(41, 30, 'a2', 1), run(42, 31, 'b1', 80, ['case-a'])], deps, { prCaused: [], outside: [] });
    expect(far.find(r => r.runId === 40)!.cause).toBe('pr');
  });
});

describe('red-head replay', () => {
  const selection = (e2e: string[], canary: boolean, global = false) => ({ e2e, global, canary, canaryReasons: canary ? ['resolver x'] : [], preambleOnly: [] });
  const files: Record<string, string> = { 'case-a': 'test/skill-e2e-demo.test.ts', 'case-b': 'test/skill-e2e-other.test.ts', 'auq-format-gate': 'test/auq.test.ts', 'judge x': 'test/skill-llm-eval.test.ts' };
  const caseFile = (id: string) => files[id] ?? null;

  test('judges always count; touchfiles, unbound shards by file, and canary cases only when the canary set is added', () => {
    expect(screenHit({ caseId: 'qa/SKILL.md workflow', kind: 'judge' }, selection([], false), caseFile)).toBe('judge');
    expect(screenHit({ caseId: 'judge x', kind: 'rule' }, selection([], false), caseFile)).toBe('judge');
    expect(screenHit({ caseId: 'case-a', kind: 'rule' }, selection(['case-a'], false), caseFile)).toBe('touchfiles');
    expect(screenHit({ caseId: 'test/skill-e2e-demo.test.ts', kind: 'rule' }, selection(['case-a'], false), caseFile)).toBe('touchfiles');
    expect(screenHit({ caseId: 'case-b', kind: 'rule' }, selection(['case-a'], false), caseFile)).toBeNull();
    expect(screenHit({ caseId: 'case-b', kind: 'rule' }, selection([], false, true), caseFile)).toBe('global');
    expect(screenHit({ caseId: 'auq-format-gate', kind: 'rule' }, selection([], true), caseFile)).toBe('canary');
    expect(screenHit({ caseId: 'auq-format-gate', kind: 'rule' }, selection([], false), caseFile)).toBeNull();
    expect(Object.values(SCREEN_CANARY_CASES)).toContain('auq-format-gate');
    const gate = checkoutSelectionDeps().gateCases;
    for (const id of Object.values(SCREEN_CANARY_CASES)) expect(gate).toContain(id);
  });

  test('summaries count merged PRs only: P-k numerator, screened misses, and misses without the canary set', () => {
    const row = (pr: number, hit: RedHeadRow['hit']): RedHeadRow => ({ pr, runId: pr, head: 'h', base: 'b', baseSource: 'tested-merge', files: 1, caseId: 'c', kind: 'rule', hit, canaryReasons: [] });
    const redRuns = [10, 11, 12, 99].map(pr => ({ runId: pr, pr, head: 'h', createdAt: '', nextRunId: null, cause: 'pr' as const, cases: [] }));
    const s = summarizeRedHeads([row(10, null), row(10, 'touchfiles'), row(11, 'canary'), row(12, 'judge'), row(99, null)], redRuns,
      [10, 11, 12, 13].map(pr => ({ pr, paidRelevant: pr !== 13 })));
    expect(s).toMatchObject({ mergedPrs: 4, paidRelevantPrs: 3, prsWithPrRed: [10, 11, 12], prCausedRuns: 3, prCausedCases: 4, missedPrs: [10], missedCases: 1,
      missedPrsWithoutCanary: [10, 11], otherPrCausedRuns: 1, byHit: { missed: 1, touchfiles: 1, canary: 1, judge: 1 } });
  });
});

describe('READY arrivals and trains', () => {
  const at = (hour: number) => new Date(Date.UTC(2026, 9, 10, hour)).toISOString();

  test('READY is the first green head with the merged own diff before the merge; fallback the final head', () => {
    const green = headGreenAt([
      { head: 'h1', workflow: 'free', createdAt: at(0), completedAt: at(1), conclusion: 'success' },
      { head: 'h1', workflow: 'evals', createdAt: at(0), completedAt: at(2), conclusion: 'success' },
      { head: 'h2', workflow: 'free', createdAt: at(3), completedAt: at(4), conclusion: 'success' },
      { head: 'h2', workflow: 'evals', createdAt: at(3), completedAt: at(4), conclusion: 'failure' },
      { head: 'h2', workflow: 'evals', createdAt: at(5), completedAt: at(6), conclusion: 'success' },
      { head: 'h3', workflow: 'free', createdAt: at(7), completedAt: at(8), conclusion: 'success' },
      { head: 'h4', workflow: 'free', createdAt: at(7), completedAt: at(8), conclusion: 'failure' },
    ]);
    expect([...green]).toEqual([['h1', at(2)], ['h2', at(6)], ['h3', at(8)], ['h4', null]]);
    const rows = readyTimes([
      { pr: 1, mergedAt: at(10), finalHead: 'h3', heads: [{ sha: 'h1', ownSig: 'old' }, { sha: 'h2', ownSig: 's' }, { sha: 'h3', ownSig: 's' }], gatedRuns: [at(0), at(3), at(5), at(7)] },
      { pr: 2, mergedAt: at(10), finalHead: 'h1', heads: [{ sha: 'h1', ownSig: null }], gatedRuns: [] },
      { pr: 3, mergedAt: at(7), finalHead: 'h3', heads: [{ sha: 'h3', ownSig: 's' }], gatedRuns: [] },
    ], green);
    expect(rows.map(r => [r.pr, r.ready, r.source, r.readyToMergeHours, r.gatesAfterReady])).toEqual([
      [1, at(6), 'final-own-diff', 4, 1], [2, at(2), 'final-head', 8, 0], [3, null, 'none', null, 0]]);
    expect([percentile([5, 1, 3, 2, 4], 0.5), percentile([5, 1, 3, 2, 4], 0.9), percentile([], 0.5)]).toEqual([3, 5, 0]);
  });

  test('train composition: screened first, unscreened fill the remaining seats, else the fill limit', () => {
    const item = (enqueuedMs: number, screened: boolean) => ({ enqueuedMs, screened });
    const pool = [item(0, true), item(1, true), ...[2, 3, 4, 5, 6].map(t => item(t, false))];
    expect(pickTrain(pool, 10, 5, 100)).toEqual(pool.slice(0, 5));
    const mixed = [item(5, false), item(0, true), item(1, false), item(2, true), item(3, true)];
    expect(pickTrain(mixed, 10, 5, 100)?.map(x => x.screened)).toEqual([true, true, true, false, false]);
    expect(pickTrain([item(0, false), item(1, true)], 99, 5, 100)).toBeNull();
    expect(pickTrain([item(0, false), item(1, true)], 100, 5, 100)?.map(x => x.enqueuedMs)).toEqual([1, 0]);
  });

  test('deterministic controls: a fill-limit train, a full train, and a repeated defect red', () => {
    const arrivals = (n: number, paidRelevant: boolean) => Array.from({ length: n }, (_, i) => ({ pr: i + 1, readyMs: 0, paidRelevant, screenUsd: 1 }));
    const base = { policy: { kind: 'all' } as const, windowDays: 7, outsideRed: 0, redScreened: 0, redUnscreened: 0, reps: 3 };
    const full = simulateArrivalTrains({ ...base, arrivals: arrivals(5, true) });
    expect(full).toMatchObject({ trainsWeekly: 1, meanOccupancy: 5, fullTrainShare: 1, gateAttemptsWeekly: 1, bisectsWeekly: 0, occupancy: [0, 0, 0, 0, 1] });
    expect(full.readyToMerge).toMatchObject({ prs: 15, p50Hours: 0.75, p90Hours: 0.75 });
    const short = simulateArrivalTrains({ ...base, arrivals: arrivals(2, false) });
    expect(short.readyToMerge.p90Hours).toBe(3.75);
    const red = simulateArrivalTrains({ ...base, arrivals: arrivals(2, true), redScreened: 1 });
    expect(red).toMatchObject({ trainsWeekly: 2, gateAttemptsWeekly: 3, bisectsWeekly: 2, attributedRebuildsWeekly: 1, rebuildOnceWeekly: 0, occupancy: [0, 2, 0, 0, 0] });
    expect(red.readyToMerge.p50Hours).toBe(8.25);
    const unscreened = simulateArrivalTrains({ ...base, policy: { kind: 'none' }, arrivals: arrivals(2, true), redUnscreened: 1 });
    expect(unscreened.bisectsWeekly).toBe(2);
    expect(simulateArrivalTrains({ ...base, arrivals: arrivals(7, true), outsideRed: 0.15, redUnscreened: 0.25, seed: 4 }))
      .toEqual(simulateArrivalTrains({ ...base, arrivals: arrivals(7, true), outsideRed: 0.15, redUnscreened: 0.25, seed: 4 }));
  });

  test('runs map to PRs by pull_requests, else by head branch while the PR was open', () => {
    const pulls = [{ number: 5, ref: 'feat', createdAt: at(0), mergedAt: at(5), closedAt: at(5) }, { number: 6, ref: 'feat', createdAt: at(8), mergedAt: null, closedAt: null }];
    expect(prForRun({ branch: 'x', createdAt: at(1), prNumbers: [9] }, pulls)).toBe(9);
    expect(prForRun({ branch: 'feat', createdAt: at(2), prNumbers: [] }, pulls)).toBe(5);
    expect(prForRun({ branch: 'feat', createdAt: at(9), prNumbers: [] }, pulls)).toBe(6);
    expect(prForRun({ branch: 'feat', createdAt: at(7), prNumbers: [] }, pulls)).toBeNull();
  });

  test('--history needs a window, and every history line naming the screen carries the screen-provisional label', () => {
    expect(() => parseArgs(['--runs', '1', '--history'])).toThrow('--history needs a window');
    expect(parseArgs(['--runs', '1', '--history', '--since', '2026-10-03', '--until', '2026-10-04']).history).toBe(true);
    const history: HistoryReport = {
      window: { since: at(0), until: at(24) }, runs: { evals: 3, gated: 2, red: 1, free: 4, unmapped: 0 },
      redRuns: [{ runId: 1, pr: 10, head: 'h', createdAt: at(0), nextRunId: 2, cause: 'pr', cases: [{ caseId: 'case-a', kind: 'rule', cause: 'pr', reason: 'fixed by own push: x' }] }],
      redHeads: [{ pr: 10, runId: 1, head: 'h', base: 'b', baseSource: 'tested-merge', files: 2, caseId: 'case-a', kind: 'rule', hit: null, canaryReasons: [] }],
      redSummary: summarizeRedHeads([{ pr: 10, runId: 1, head: 'h', base: 'b', baseSource: 'tested-merge', files: 2, caseId: 'case-a', kind: 'rule', hit: null, canaryReasons: [] }],
        [{ runId: 1, pr: 10, head: 'h', createdAt: at(0), nextRunId: 2, cause: 'pr', cases: [] }], [{ pr: 10, paidRelevant: true }, { pr: 11, paidRelevant: false }]),
      perPr: [{ pr: 10, paidRelevant: true, prCausedRed: true, screenedMiss: true }, { pr: 11, paidRelevant: false, prCausedRed: false, screenedMiss: false }],
      ready: [], baseline: { prs: 2, p50Hours: 1, p90Hours: 2, meanHours: 1.5, gatesAfterReady: 1, sources: { 'final-own-diff': 2 } },
      trainParams: { trainSize: 5, fillLimitHours: 3, gateMinutes: 45, bisectMinutes: 45, redScreened: 0.06, redUnscreened: 0.25, reps: 3, seed: 1 },
      trains: [simulateArrivalTrains({ arrivals: [{ pr: 10, readyMs: 0, paidRelevant: true, screenUsd: 1 }], policy: { kind: 'all' }, windowDays: 7, reps: 3 })],
    };
    const text = formatHistory(history);
    expect(text).toContain('P-k (merged PRs with any PR-caused red run): 1 of 2 (50.0%): #10');
    expect(text).toContain('misses: 1 of 1 (100.0%) merged PRs with a PR-caused red (1 of 1 case results): #10');
    const screenLines = text.split('\n').filter(line => /\bscreen\b/i.test(line));
    expect(screenLines.length).toBeGreaterThan(2);
    for (const line of screenLines) expect(line).toContain(SCREEN_LABEL);
  });
});
