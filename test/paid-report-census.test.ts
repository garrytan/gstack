/**
 * Census attribution in the paid report (I4): every JUnit testcase of a
 * non-trial shard is a case result, a zero-credit deselection with its
 * reason, or listed by name as unattributed. Fixtures are trimmed from the
 * 2026-10-03 periodic and gate census artifacts (run 37151477069, commit
 * ac20ef1), whose report counted deselections as SKIPPED 82/282 and left
 * 72/24 testcases unattributed. Budget records follow the current declared
 * policy (plan-mode-no-op: 3,720,000 ms since v1.91.18.0 added its devex member).
 * The periodic fixture is re-shaped to the current case shards: qa-workflow runs
 * as its qa-fix-loop case shard (its three gate-tier siblings become sibling
 * deselections) and the review carve runs as a case of the consolidated
 * test/carve-section-loading.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DESELECTION_REASONS, RUNTIME_SKIP_REASON, attributeJUnitCase, formatPanelLine, resolvePaidShardBudget, runPaidReport, type JUnitCase } from '../scripts/test-paid-shards';
import { panelVerdict } from './helpers/eval-store';
import { trialRecordProblems as trialRecordProblemsV1 } from './fixtures/trial-record-v1-reader';

const FIXTURES = path.join(import.meta.dir, 'fixtures', 'paid-report-census');

let base: string;
beforeAll(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'paid-report-census-')); });
afterAll(() => { fs.rmSync(base, { recursive: true, force: true }); });

let runs = 0;
function report(lane: 'periodic' | 'gate', edit: (dir: string) => void = () => {}, env: NodeJS.ProcessEnv = {}) {
  const dir = path.join(base, `${lane}-${++runs}`);
  fs.cpSync(path.join(FIXTURES, lane), dir, { recursive: true });
  edit(dir);
  const lines: string[] = [];
  const { log, error } = console;
  console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
  console.error = console.log;
  let status: number;
  try { status = runPaidReport(dir, { env }); } finally { console.log = log; console.error = error; }
  const history = fs.readFileSync(path.join(dir, 'trial-outcomes.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { status, out: lines.join('\n'), dir, history };
}

const junit = (dir: string, slug: string) => path.join(dir, 'paid-slice-1-a1', 'shards', slug, 'junit.xml');

describe('census attribution from the 2026-10-03 artifacts', () => {
  test('periodic: deselections and hook placeholders are zero-credit, every executed testcase maps to one case', () => {
    const r = report('periodic');
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('  rule 7/7 · behavior 0/0 · judge 0/0 · quarantined 0 (0 failing the lane)');
    expect(r.out).toContain('  SKIPPED 0 · INFRA 0 · INCOMPLETE 0 · unattributed 0 · ACTION REQUIRED 0');
    expect(r.out).toContain(`deselected testcases, zero credit (21):`);
    expect(r.out).toContain(`    13  ${DESELECTION_REASONS.sibling}`);
    expect(r.out).toContain('     4  gate-tier case (this lane runs periodic)');
    expect(r.out).toContain(`     4  ${DESELECTION_REASONS.hook}`);
    expect(r.out).toContain('  ⚠ test/skill-e2e-test-value.test.ts (3 skipped — 3 gate-tier case (this lane runs periodic))');
    expect(r.out).not.toContain('UNATTRIBUTED');
    expect(r.history.map(record => `${record.case}:${record.outcome}`).sort()).toEqual([
      'benchmark-providers-live:passed', 'carve-section-loading-review:passed', 'codex-recommendation-substance:passed',
      'cso-full-audit:passed', 'cso-infra-scope:passed', 'design-consultation-core:passed', 'qa-fix-loop:passed',
    ]);
    expect(r.history.find(record => record.case === 'benchmark-providers-live')).toMatchObject({ file: 'test/skill-e2e-benchmark-providers.test.ts', source: 'junit' });
    expect(r.history.filter(record => record.file === 'test/skill-e2e-design.test.ts'))
      .toEqual([expect.objectContaining({ case: 'design-consultation-core', outcome: 'passed', source: 'junit' })]);
    expect(r.history.some(record => record.outcome === 'skipped')).toBe(false);
  });

  test('gate: other-tier cases and hook placeholders are deselected; a multi-test case is one result', () => {
    const r = report('gate');
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('  rule 2/2 · behavior 0/0 · judge 0/0 · quarantined 0 (0 failing the lane)');
    expect(r.out).toContain('  SKIPPED 0 · INFRA 0 · INCOMPLETE 0 · unattributed 0 · ACTION REQUIRED 0');
    expect(r.out).toContain('    16  periodic-tier case (this lane runs gate)');
    expect(r.out).toContain(`     2  ${DESELECTION_REASONS.hook}`);
    expect(r.out).toContain(`  ⚠ test/skill-e2e-qa-bugs.test.ts (5 skipped — 2 ${DESELECTION_REASONS.hook}; 3 periodic-tier case (this lane runs gate))`);
    expect(r.history.map(record => `${record.case}:${record.outcome}`).sort()).toEqual(['cso-diff-mode:passed', 'plan-mode-no-op:passed']);
  });

  test('a selected in-lane case that skipped is SKIPPED with its reason; an unattributable testcase is listed by name', () => {
    const r = report('periodic', dir => {
      const qa = junit(dir, 'skill-e2e-qa-workflow--qa-fix-loop');
      fs.writeFileSync(qa, fs.readFileSync(qa, 'utf8').replace(/(<testcase name="qa-fix-loop"[^>]*?) \/>/, '$1><skipped /></testcase>'));
      const cso = junit(dir, 'skill-e2e-cso');
      fs.writeFileSync(cso, fs.readFileSync(cso, 'utf8').replace(/<\/testsuite>(\r?\n)<\/testsuites>/,
        '<testcase name="an unlabeled helper" classname="CSO v3" time="1" file="test/skill-e2e-cso.test.ts" line="9" />$1</testsuite>$1</testsuites>'));
    });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('  SKIPPED 1 · INFRA 0 · INCOMPLETE 0 · unattributed 1 · ACTION REQUIRED 0');
    expect(r.out).toContain(`[test:paid]   ◌ qa-fix-loop  test/skill-e2e-qa-workflow.test.ts#qa-fix-loop (qa-fix-loop): ${RUNTIME_SKIP_REASON}`);
    expect(r.out).toContain('[test:paid]   ? test/skill-e2e-cso.test.ts :: an unlabeled helper (passed)');
    const summary = fs.readFileSync(path.join(r.dir, 'report-summary.md'), 'utf8');
    expect(summary).toContain('**Skipped, deselected and unattributed testcases**');
    expect(summary).toContain('? test/skill-e2e-cso.test.ts :: an unlabeled helper (passed)');
    const collector = JSON.parse(fs.readFileSync(path.join(r.dir, 'collector-outcomes.json'), 'utf8'));
    expect(collector.census.unattributed).toEqual(['test/skill-e2e-cso.test.ts :: an unlabeled helper (passed)']);
    expect(collector.census.skipped).toHaveLength(1);
    expect(collector.verdict.counts).toMatchObject({ skipped: 1, unattributed: 1 });
  });
});

describe('record builders attach ledger sessions and failure causes (plan 0.1/0.2)', () => {
  const noOp = (dir: string) => path.join(dir, 'paid-slice-1-a1', 'shards', 'skill-e2e-plan-mode-no-op');
  const failNoOp = (dir: string) => {
    const file = path.join(noOp(dir), 'junit.xml');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8')
      .replace('failures="0"', 'failures="1"')
      .replace(/(<testcase name="plan-ceo-review reaches a terminal outcome outside plan mode"[^>]*?) \/>/,
        '$1><failure type="AssertionError" message="plan-ceo-review: outcome=timeout (no terminal outcome within 180000ms)" /></testcase>'));
    fs.writeFileSync(path.join(noOp(dir), 'session-ledger.jsonl'), [
      { key: 'pty:session#1', runner: 'pty', started_at: 't', budget_ms: 180_000, elapsed_ms: 16_800, end: 'completed' },
      { key: 'pty:session#2', runner: 'pty', started_at: 't', budget_ms: 180_000, elapsed_ms: 180_050, end: 'observer_timeout' },
    ].map(row => JSON.stringify(row)).join('\n') + '\nnot json\n');
  };

  test('a JUnit-only PTY case gets failure_cause and sessions from its ledger; failure_class is unchanged', () => {
    const r = report('gate', failNoOp);
    const noOpRecord = r.history.find(record => record.case === 'plan-mode-no-op');
    expect(noOpRecord).toMatchObject({ outcome: 'failed', failure_class: 'assertion', failure_cause: 'observer_timeout',
      failure_cause_evidence: 'plan-ceo-review: outcome=timeout (no terminal outcome within 180000ms)',
      sessions: [{ key: 'pty:session#1', runner: 'pty', elapsed_ms: 16_800, budget_ms: 180_000, end: 'completed' },
        { key: 'pty:session#2', runner: 'pty', elapsed_ms: 180_050, budget_ms: 180_000, end: 'observer_timeout' }] });
    for (const record of r.history) expect(trialRecordProblemsV1(record), record.case).toEqual([]);
    // Its five tests run concurrently: JUnit times sum to 346 s, the shard's wall is 176.5 s (lane S A2).
    expect(noOpRecord.duration_ms).toBe(176_495);
    const plain = report('gate', dir => { failNoOp(dir); fs.rmSync(path.join(noOp(dir), 'session-ledger.jsonl')); });
    const without = plain.history.find(record => record.case === 'plan-mode-no-op');
    expect(without.failure_class).toBe(noOpRecord.failure_class);
    expect(without.sessions).toBeUndefined();
    const collector = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'collector-outcomes.json'), 'utf8'));
    expect(collector(plain.dir).verdict).toEqual(collector(r.dir).verdict);
  });
});

describe('red lines carry their values, evidence and a one-case command (plan 0.3)', () => {
  const QA_ONLY = 'qa-only/SKILL.md workflow';
  const addJudgeRed = (dir: string) => {
    const shard = path.join(dir, 'paid-slice-1-a1', 'shards', 'skill-llm-eval');
    fs.mkdirSync(shard, { recursive: true });
    const message = 'expect(received).toBeGreaterThanOrEqual(expected)\n\nExpected: &gt;= 4\nReceived: 3.6666666666666665\n';
    fs.writeFileSync(path.join(shard, 'junit.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites><testsuite name="test/skill-llm-eval.test.ts">`
      + `<testcase name="${QA_ONLY}" classname="Other skill evals" time="34.8" file="test/skill-llm-eval.test.ts" line="9">`
      + `<failure type="AssertionError" message="${message.replace(/\n/g, '&#10;')}" /></testcase></testsuite></testsuites>\n`);
    // Trimmed from census 37198445662's paid-slice-5-a1 qa-only record.
    fs.writeFileSync(path.join(shard, '1.91.19-x-llm-judge-2026-10-04-1129.json'), JSON.stringify({ tier: 'llm-judge', total_cost_usd: 0.06, tests: [{
      name: QA_ONLY, suite: 'Other skill evals', tier: 'llm-judge', passed: false, duration_ms: 34829, cost_usd: 0.06, execution: 'executed',
      judge_scores: { clarity: 3.6666666666666665, completeness: 4.333333333333333, actionability: 3.6666666666666665 },
      judge_reasoning: '[sample 1] The bundle is thorough. Clarity suffers from extreme density and cross-file indirection. Two actionability concerns: Browser Quick allots 30 seconds.\n[sample 2] Deliverables are concrete.\n[sample 3] Execution is feasible.',
      exit_reason: 'validation_failed', error: message.replace('&gt;', '>') }] }));
    const manifestPath = path.join(dir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const budget = resolvePaidShardBudget(['test/skill-llm-eval.test.ts']);
    manifest.entries.push({ file: 'test/skill-llm-eval.test.ts', slice: 1, status: 'planned', estimatedMs: 35_000, budget });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const slicePath = path.join(dir, 'paid-slice-1-a1', 'slice-1.json');
    const slice = JSON.parse(fs.readFileSync(slicePath, 'utf8'));
    slice.outcomes.push({ files: ['test/skill-llm-eval.test.ts'], status: 'failed', exitCode: 1, elapsedMs: 35_000, executedTests: 1, skippedTests: 0, budget });
    fs.writeFileSync(slicePath, JSON.stringify(slice));
  };

  test('a judge red names each failing dimension, its mean, samples and rationale, its artifact and an exact one-case command', () => {
    const r = report('gate', addJudgeRed, { GITHUB_RUN_ID: '37198445662' });
    const line = r.out.split('\n').find(l => l.includes(`✗ ${QA_ONLY}`))!;
    expect(line).toContain('FAIL  assertion — expect(received).toBeGreaterThanOrEqual(expected)');
    expect(line).toContain('· cause assertion  clarity 3.67 < 4 (3 samples) "Clarity suffers from extreme density and cross-file indirection."; '
      + 'actionability 3.67 < 4 (3 samples) "Two actionability concerns: Browser Quick allots 30 seconds."');
    expect(line).toContain('evidence: paid-slice-1-a1/shards/skill-llm-eval (fetch: bun run eval:pass-rates --run 37198445662 --case \'qa-only/SKILL.md workflow\')');
    expect(line).toContain(`after a repair: EVALS=1 EVALS_TIER=gate EVALS_JUDGE_SELECTION_JSON='{"version":1,"selected":["${QA_ONLY}"],"reason":"after a repair"}' `
      + `bun test test/skill-llm-eval.test.ts -t '(?:^|\\s)(?:qa-only/SKILL\\.md workflow)$'`);
    expect(line).not.toContain('rerun:');
    const record = r.history.find(x => x.case === QA_ONLY);
    expect(record).toMatchObject({ failure_class: 'assertion', error: 'expect(received).toBeGreaterThanOrEqual(expected)', failure_cause: 'assertion',
      failure_detail: { judge: [expect.objectContaining({ dimension: 'clarity', mean: 3.67 }), expect.objectContaining({ dimension: 'actionability', mean: 3.67 })] } });
    expect(trialRecordProblemsV1(record)).toEqual([]);
  });

  test('a behavior panel line names the failed trial\'s cause, values, slice artifact and an n-trial one-case command', () => {
    const verdict = panelVerdict({ case: 'plan-review-prosons-neutral-neg', kind: 'behavior', panel: { n: 3, k: 2 }, quarantined: false, trials: [
      { trial: 1, outcome: 'failed', failure_class: 'assertion', exit_reason: 'success', error: 'expect(received).not.toMatch(expected)',
        failure_cause: 'assertion', failure_cause_evidence: 'session completed; check failed',
        failure_detail: { expected: 'not /taste call/i', received: '"a taste call"' } } as any,
      { trial: 2, outcome: 'failed', failure_class: 'assertion' }, { trial: 3, outcome: 'passed' }] });
    const line = formatPanelLine({ ...verdict, file: 'test/skill-e2e-plan-prosons.test.ts', slices: { 1: 7, 2: 9, 3: 9 } }, 'periodic',
      { artifacts: new Map([[7, 'paid-slice-7-a1']]), runId: '37193478719' });
    expect(line).toContain('t1: assertion (session completed; check failed) — expect(received).not.toMatch(expected)  · cause assertion: session completed; check failed  Expected: not /taste call/i · Received: "a taste call"');
    expect(line).toContain('evidence: paid-slice-7-a1/shards/skill-e2e-plan-prosons--plan-review-prosons-neutral-neg.t1 (fetch: bun run eval:pass-rates --run 37193478719 --case plan-review-prosons-neutral-neg)');
    expect(line).toContain('after a repair: bun run scripts/test-paid-shards.ts --tier periodic --case plan-review-prosons-neutral-neg --trials 3');
  });

  test('a rule red shows Expected/Received and selects only its case; the summary fence cannot be broken', () => {
    const r = report('gate', dir => {
      const file = path.join(dir, 'paid-slice-1-a1', 'shards', 'skill-e2e-plan-mode-no-op', 'junit.xml');
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/(<testcase name="plan-ceo-review reaches a terminal outcome outside plan mode"[^>]*?) \/>/,
        '$1><failure type="AssertionError" message="expect(received).toBe(expected)&#10;&#10;Expected: &quot;asked&quot;&#10;Received: &quot;```@team&lt;/details&gt;&quot;" /></testcase>'));
      addJudgeRed(dir);
    });
    const line = r.out.split('\n').find(l => l.includes('✗ plan-mode-no-op'))!;
    expect(line).toContain('Expected: "asked" · Received: "```@\u200bteam</details>"');
    expect(line).toContain('evidence: paid-slice-1-a1/shards/skill-e2e-plan-mode-no-op');
    expect(line).not.toContain('(fetch:');
    expect(line).toContain('after a repair: bun run scripts/test-paid-shards.ts --tier gate --case plan-mode-no-op');
    const summary = fs.readFileSync(path.join(r.dir, 'report-summary.md'), 'utf8');
    const lines = summary.split('\n');
    const at = lines.findIndex(l => l.includes('✗ plan-mode-no-op'));
    const open = lines.slice(0, at).findLast(l => /^`{3,}$/.test(l))!;
    expect(open.length).toBeGreaterThan(3);
    expect(lines.slice(at).find(l => /^`{3,}$/.test(l))).toBe(open);
    expect(summary).not.toMatch(/@team/);
    if (summary.includes('**ACTION REQUIRED')) expect(summary.trimEnd().endsWith('Guide: docs/evals/census-red.md')).toBe(true);
    const collector = JSON.parse(fs.readFileSync(path.join(r.dir, 'collector-outcomes.json'), 'utf8'));
    expect(collector.failures.join('\n')).not.toContain('`');
  });
});

describe('attributeJUnitCase', () => {
  const tc = (name: string, outcome: JUnitCase['outcome'], line: number | null = 1): JUnitCase =>
    ({ name, classname: 's', outcome, timeMs: 0, ...(line === null ? {} : { line }) });
  const file = 'test/skill-e2e-review.test.ts';

  test('isolated and unselected in-lane cases are deselected; a selected skip is a case', () => {
    expect(attributeJUnitCase(tc('review-design-lite', 'skipped'), { key: file, tier: 'periodic', excludeCases: ['review-design-lite'] }))
      .toEqual({ kind: 'deselected', reason: DESELECTION_REASONS.isolated });
    expect(attributeJUnitCase(tc('review-sql-injection', 'skipped'), { key: file, tier: 'gate', selection: { e2e: ['review-enum-completeness'], judges: null } }))
      .toEqual({ kind: 'deselected', reason: DESELECTION_REASONS.selection });
    expect(attributeJUnitCase(tc('review-sql-injection', 'skipped'), { key: file, tier: 'gate', selection: { e2e: ['review-sql-injection'], judges: null } }))
      .toEqual({ kind: 'case', id: 'review-sql-injection' });
  });

  test('only a skipped, line-less "(unnamed)" is a hook placeholder; a failing hook or a stray case-shard result is never deselected', () => {
    expect(attributeJUnitCase(tc('(unnamed)', 'skipped', null), { key: file, tier: 'gate' })).toEqual({ kind: 'deselected', reason: DESELECTION_REASONS.hook });
    expect(attributeJUnitCase(tc('(unnamed)', 'failed', null), { key: file, tier: 'gate' })).toEqual({ kind: 'unattributed' });
    expect(attributeJUnitCase(tc('(unnamed)', 'skipped'), { key: file, tier: 'gate' })).toEqual({ kind: 'unattributed' });
    const shard = 'test/skill-e2e-design.test.ts#design-consultation-core';
    expect(attributeJUnitCase(tc('design-consultation-core', 'passed'), { key: shard, tier: 'periodic' })).toEqual({ kind: 'case', id: 'design-consultation-core' });
    expect(attributeJUnitCase(tc('needs Aside', 'skipped'), { key: shard, tier: 'periodic' })).toEqual({ kind: 'deselected', reason: DESELECTION_REASONS.sibling });
    expect(attributeJUnitCase(tc('needs Aside', 'passed'), { key: shard, tier: 'periodic' })).toEqual({ kind: 'unattributed' });
  });

  test('a SKIPPED panel line names its reason and never calls a skipped trial an assertion', () => {
    const verdict = panelVerdict({ case: 'review-design-lite', kind: 'behavior', panel: { n: 3, k: 2 },
      trials: [1, 2, 3].map(trial => ({ trial, outcome: 'skipped' as const })), quarantined: false });
    const line = formatPanelLine({ ...verdict, file: 'test/skill-e2e-review.test.ts', slices: {} }, 'periodic');
    expect(line).toContain('t1: skipped; t2: skipped; t3: skipped  [every trial skipped (no verdict credit)]');
    expect(line).not.toContain('assertion');
  });
});
