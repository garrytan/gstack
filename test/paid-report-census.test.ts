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
import { DESELECTION_REASONS, RUNTIME_SKIP_REASON, attributeJUnitCase, formatPanelLine, runPaidReport, type JUnitCase } from '../scripts/test-paid-shards';
import { panelVerdict } from './helpers/eval-store';

const FIXTURES = path.join(import.meta.dir, 'fixtures', 'paid-report-census');

let base: string;
beforeAll(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'paid-report-census-')); });
afterAll(() => { fs.rmSync(base, { recursive: true, force: true }); });

let runs = 0;
function report(lane: 'periodic' | 'gate', edit: (dir: string) => void = () => {}) {
  const dir = path.join(base, `${lane}-${++runs}`);
  fs.cpSync(path.join(FIXTURES, lane), dir, { recursive: true });
  edit(dir);
  const lines: string[] = [];
  const { log, error } = console;
  console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
  console.error = console.log;
  let status: number;
  try { status = runPaidReport(dir, { env: {} }); } finally { console.log = log; console.error = error; }
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
      'benchmark-providers-live:passed', 'carve-section-loading-review:passed', 'cso-full-audit:passed', 'cso-infra-scope:passed',
      'codex-recommendation-substance:passed', 'design-consultation-core:passed', 'qa-fix-loop:passed',
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
