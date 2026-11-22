/** Test value bar behavior in /ship Step 7, the /review testing specialist and
 * /test-audit. Each case is one bounded capture on a small fixture:
 *   ship-coverage-value     a ★-only path lands in weak_gaps and X <= Y
 *   review-test-value       a source-grep test and a test-only export are
 *                           INFORMATIONAL findings; the SKILL.md golden is not
 *   test-audit-report-only  the same fixture yields complete retirement cards,
 *                           keeps the golden and edits nothing
 */
import { afterAll } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { CAPTURE_MS } from './helpers/eval-budgets';
import { runSkillTest } from './helpers/session-runner';
import { ROOT, runId, describeIfSelected, testIfSelected, copyDirSync, logCost,
  createEvalCollector, finalizeEvalCollector } from './helpers/e2e-helpers';
import { extractSkillBody } from './helpers/skill-fixture';
import { createShipCoverageValueFixture, createTestValueFixture, lastJsonLine, weakGapCovers, jsonFindings, LOW_VALUE_TESTS, recordsNonTestCallerSearch } from './helpers/test-value-fixture';
import { runRecordedOfficeHoursAttempt, OFFICE_HOURS_BUN_GRACE_MS } from './helpers/office-hours-attempt';
import { resolveEvalModel } from '../lib/eval-model';
import { RETIREMENT_FIELDS } from '../scripts/resolvers/test-value';
import type { SkillTestResult } from './helpers/session-runner';

const evalCollector = createEvalCollector('e2e');
const RUNNER_MS = CAPTURE_MS - 3 * OFFICE_HOURS_BUN_GRACE_MS;

function trackedChanges(cwd: string): string {
  return spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd, encoding: 'utf8', timeout: 10_000 }).stdout.trim();
}

type Case = {
  id: string;
  skill: string;
  suite: string;
  setup: (cwd: string) => void;
  prompt: (cwd: string, reportDir: string) => string;
  validate: (result: SkillTestResult, cwd: string, reportDir: string) => void;
};

const CASES: Case[] = [
  {
    id: 'ship-coverage-value', skill: 'ship', suite: 'Ship Test Value E2E',
    setup: createShipCoverageValueFixture,
    prompt: cwd => `Read ship/SKILL.md and ship/sections/test-coverage.md for the current ship workflow.

You are on the feature/billing branch. The base branch is main. There is no remote.
Run ONLY the Step 7 coverage audit, inline, as the audit subagent would, applying it
directly to ${cwd}/src/billing.ts and its tests in ${cwd}/test/billing.test.ts (a
targeted audit with no branch diff). Generation: audit-only; passes used: 0 of 2.
Do not dispatch subagents, write tests or modify files. Skip every other step.
End with the audit's LAST-line JSON exactly as Step 7 specifies.`,
    validate: (result, cwd) => {
      const json = lastJsonLine(result.output || '');
      if (!json) throw new Error('ship coverage: no last-line JSON');
      if (typeof json.coverage_pct !== 'number' || typeof json.coverage_pct_value !== 'number') throw new Error(`ship coverage: numeric coverage_pct and coverage_pct_value required, got ${JSON.stringify(json)}`);
      if (json.coverage_pct < json.coverage_pct_value) throw new Error(`ship coverage: coverage_pct ${json.coverage_pct} < coverage_pct_value ${json.coverage_pct_value}`);
      const weak = Array.isArray(json.weak_gaps) ? json.weak_gaps : [];
      if (!weak.some((gap: any) => weakGapCovers(gap, cwd, /refund/i))) throw new Error(`ship coverage: the ★-only refundPayment path must be in weak_gaps, got ${JSON.stringify(json.weak_gaps)}`);
    },
  },
  {
    id: 'review-test-value', skill: 'review', suite: 'Review Test Value E2E',
    setup: cwd => createTestValueFixture(cwd),
    prompt: () => `Read review/SKILL.md and review/sections/review-army.md for the current review workflow.
Apply ONLY the testing specialist checklist in review/specialists/testing.md to this
branch's diff (\`git diff main...HEAD\`), as the testing specialist would. Do not
dispatch other specialists, fix anything or modify files. Output the specialist's JSON
findings, one per line.`,
    validate: (result, cwd) => {
      const findings = jsonFindings(result.output || '');
      const about = (needle: RegExp) => findings.filter(finding => needle.test(`${finding.path} ${finding.summary}`));
      const grep = about(/pricing-source/);
      const seam = about(new RegExp(`pricing-reset|${LOW_VALUE_TESTS.testOnlySymbol}`));
      if (!grep.length || !grep.every(finding => finding.severity === 'INFORMATIONAL')) throw new Error(`review: source-grep test needs an INFORMATIONAL finding, got ${JSON.stringify(grep)}`);
      if (!seam.length || !seam.every(finding => finding.severity === 'INFORMATIONAL')) throw new Error(`review: test-only export needs an INFORMATIONAL finding, got ${JSON.stringify(seam)}`);
      if (!seam.some(recordsNonTestCallerSearch)) throw new Error('review: test-only export evidence must record non_test_callers and the caller search');
      const golden = about(/skill-golden/);
      if (golden.length) throw new Error(`review: the SKILL.md golden test must not be flagged, got ${JSON.stringify(golden)}`);
      if (trackedChanges(cwd)) throw new Error('review: tracked files changed');
    },
  },
  {
    id: 'test-audit-report-only', skill: 'test-audit', suite: 'Test Audit Report-Only E2E',
    setup: cwd => createTestValueFixture(cwd),
    prompt: (_cwd, reportDir) => `Read test-audit/SKILL.md and run /test-audit on this repository, report-only.
Treat this as a headless session: ask no questions, approve no batch, edit no file in
the repository. There is no gstack install here, so skip the SLUG setup line and write
the report to ${reportDir}/test-audit.md and its JSON sidecar to
${reportDir}/test-audit.json instead. Stop after Step 4.`,
    validate: (_result, cwd, reportDir) => {
      const sidecarPath = path.join(reportDir, 'test-audit.json');
      if (!fs.existsSync(path.join(reportDir, 'test-audit.md'))) throw new Error('test-audit: report missing');
      if (!fs.existsSync(sidecarPath)) throw new Error('test-audit: JSON sidecar missing');
      const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
      const candidates: any[] = Array.isArray(sidecar.candidates) ? sidecar.candidates : [];
      const retiring = candidates.filter(candidate => candidate.verdict !== 'retain');
      for (const needle of [/pricing-source/, new RegExp(`pricing-reset|${LOW_VALUE_TESTS.testOnlySymbol}`)]) {
        const match = retiring.find(candidate => needle.test(String(candidate.test)));
        if (!match) throw new Error(`test-audit: missing candidate ${needle}, got ${JSON.stringify(candidates.map(c => c.test))}`);
        const missing = RETIREMENT_FIELDS.filter(field => !String(match.retirement_card?.[field] ?? '').trim());
        if (missing.length) throw new Error(`test-audit: ${match.test} retirement card missing ${missing.join(', ')}`);
      }
      if (retiring.some(candidate => /skill-golden/.test(String(candidate.test)))) throw new Error('test-audit: the SKILL.md golden must be retained');
      if (trackedChanges(cwd)) throw new Error('test-audit: tracked files changed');
    },
  },
];

for (const entry of CASES) describeIfSelected(entry.suite, [entry.id], () => {
  testIfSelected(entry.id, async () => {
    let cwd: string | undefined;
    let reportDir: string | undefined;
    try {
      await runRecordedOfficeHoursAttempt({
        collector: evalCollector, name: entry.id, suite: entry.suite,
        model: process.env.EVALS_MODEL ?? resolveEvalModel('capture'),
        budgetMs: CAPTURE_MS - OFFICE_HOURS_BUN_GRACE_MS,
        run: async signal => {
          cwd = fs.mkdtempSync(path.join(os.tmpdir(), `skill-e2e-${entry.id}-`));
          reportDir = fs.mkdtempSync(path.join(os.tmpdir(), `skill-e2e-${entry.id}-report-`));
          entry.setup(cwd);
          copyDirSync(path.join(ROOT, entry.skill), path.join(cwd, entry.skill));
          fs.writeFileSync(path.join(cwd, entry.skill, 'SKILL.md'), extractSkillBody(path.join(ROOT, entry.skill)));
          fs.writeFileSync(path.join(cwd, '.git', 'info', 'exclude'), `${entry.skill}/\n`);
          return runSkillTest({
            prompt: entry.prompt(cwd, reportDir),
            workingDirectory: cwd, maxTurns: 25,
            allowedTools: ['Bash', 'Read', 'Write', 'Glob', 'Grep'],
            timeout: RUNNER_MS, testName: entry.id, runId, signal,
          });
        },
        validate: result => {
          logCost(entry.id, result);
          if (result.exitReason !== 'success') throw new Error(`${entry.id}: ${result.exitReason}`);
          entry.validate(result, cwd!, reportDir!);
        },
      });
    } finally {
      for (const dir of [cwd, reportDir]) if (dir) try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }, CAPTURE_MS);
});

afterAll(async () => { await finalizeEvalCollector(evalCollector); });
