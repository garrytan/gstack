import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { CAPTURE_MS, CAPTURE_LONG_MS } from './helpers/eval-budgets';
import { runSkillTest } from './helpers/session-runner';
import { outcomeJudge } from './helpers/llm-judge';
import { judgePassed } from './helpers/eval-store';
import {
  ROOT, browseBin, runId, evalsEnabled, selectedTests, hasApiKey,
  describeIfSelected, describeE2E, testConcurrentIfSelected,
  copyDirSync, setupBrowseShims, logCost, recordE2E, dumpOutcomeDiagnostic,
  createEvalCollector, finalizeEvalCollector,
} from './helpers/e2e-helpers';
import { asideAvailable } from './helpers/aside-available';
import { startTestServer } from '../browse/test/test-server';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const evalCollector = createEvalCollector('e2e-qa-bugs');

// --- B6/B7/B8: Planted-bug outcome evals ---

// Outcome evals also need ANTHROPIC_API_KEY for the LLM judge
// ...and a browser: a live Aside (primary) or a built browse/dist/browse
// (fallback). Neither → skip, never fail.
const describeOutcome = (evalsEnabled && hasApiKey && (asideAvailable() || fs.existsSync(browseBin))) ? describe : describe.skip;

/**
 * The BROWSER SETUP section qa/SKILL.md renders (Aside probe + browse fallback
 * + driving rules). The agent gets just this, not the 1500-line skill, so the
 * driver decision is the skill's own text, not the prompt's.
 */
function browserSetupSection(): string {
  const skill = fs.readFileSync(path.join(ROOT, 'qa', 'SKILL.md'), 'utf-8');
  const start = skill.indexOf('## BROWSER SETUP');
  // The Aside contract is followed by its own H2, '## Browser fallback: ...' — the
  // fixture must carry both so a run without Aside can take the $B path.
  const fallback = skill.indexOf('\n## Browser fallback', start + 3);
  const end = skill.indexOf('\n## ', (fallback > 0 ? fallback : start) + 3);
  if (start < 0 || end < 0) throw new Error('qa/SKILL.md: BROWSER SETUP section not found — regenerate with: bun run gen:skill-docs');
  return skill.slice(start, end);
}

// Wrap describeOutcome with selection — skip if no planted-bug tests are selected
const outcomeTestNames = ['qa-b6-static', 'qa-b7-spa', 'qa-b8-checkout'];
const anyOutcomeSelected = selectedTests === null || outcomeTestNames.some(t => selectedTests!.includes(t));

let testServer: ReturnType<typeof startTestServer>;

(anyOutcomeSelected ? describeOutcome : describe.skip)('Planted-bug outcome evals', () => {
  let outcomeDir: string;

  beforeAll(() => {
    testServer = startTestServer();
    outcomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-outcome-'));
    setupBrowseShims(outcomeDir);

    // Copy qa skill files
    copyDirSync(path.join(ROOT, 'qa'), path.join(outcomeDir, 'qa'));
  });

  afterAll(() => {
    testServer?.server?.stop();
    try { fs.rmSync(outcomeDir, { recursive: true, force: true }); } catch {}
  });

  /**
   * Shared planted-bug eval runner.
   * Gives the agent concise bug-finding instructions (not the full QA workflow),
   * then scores the report with an LLM outcome judge.
   */
  async function runPlantedBugEval(fixture: string, groundTruthFile: string, label: string) {
    // Each test gets its own isolated working directory to prevent cross-contamination
    // (agents reading previous tests' reports and hallucinating those bugs)
    const testWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), `skill-e2e-${label}-`));
    setupBrowseShims(testWorkDir);
    const reportDir = path.join(testWorkDir, 'reports');
    fs.mkdirSync(path.join(reportDir, 'screenshots'), { recursive: true });
    const reportPath = path.join(reportDir, 'qa-report.md');

    fs.writeFileSync(path.join(testWorkDir, 'BROWSER-SETUP.md'), browserSetupSection());

    // Direct bug-finding. Keep prompt concise — no reading long SKILL.md docs.
    // "Write early, update later" pattern ensures report exists even if agent hits max turns.
    const targetUrl = `${testServer.url}/${fixture}`;
    const result = await runSkillTest({
      prompt: `Find bugs on this page: ${targetUrl}

Browser: read BROWSER-SETUP.md in this directory and follow it exactly — it probes for Aside first and falls back to the gstack browse binary. If it falls back, the binary is at ${browseBin} (B="${browseBin}"). Do not look for any other browser. The target is LOCAL, so submitting its forms needs no consent question.

PHASE 1 — Quick scan (5 browser steps max):
- Load ${targetUrl} and capture the console errors
- Take an interactive snapshot (clickable/fillable elements) and read the page text
- Accessibility pass: img elements without alt text, form controls without a label or aria-label

PHASE 2 — Write initial report to ${reportPath}:
Write every bug you found so far. Format each as:
- Category: functional / visual / accessibility / console
- Severity: high / medium / low
- Evidence: what you observed

PHASE 3 — Interactive testing (targeted — max 15 browser steps):
- Test email: fill "user@" (no domain) and blur — does it validate?
- Test quantity: clear the field entirely — check the total display
- Test credit card: fill a 25-character string — check for overflow
- Submit the form with zip code empty — does it require zip?
- Submit a valid form and capture the console errors again
- After finding more bugs, UPDATE ${reportPath} with new findings

PHASE 4 — Finalize report:
- UPDATE ${reportPath} with ALL bugs found across all phases
- Include console errors, form validation issues, visual overflow, missing attributes

CRITICAL RULES:
- ONLY test the page at ${targetUrl} — do not navigate to other sites
- Write the report file in PHASE 2 before doing interactive testing
- The report MUST exist at ${reportPath} when you finish`,
      workingDirectory: testWorkDir,
      maxTurns: 50,
      timeout: CAPTURE_MS,
      testName: `qa-${label}`,
      runId,
      model: 'claude-opus-4-7',
    });

    logCost(`/qa ${label}`, result);

    // Phase 1: browse mechanics. Accept error_max_turns — agent may have written
    // a partial report before running out of turns. What matters is detection rate.
    if (result.browseErrors.length > 0) {
      console.warn(`${label} browse errors:`, result.browseErrors);
    }
    if (result.exitReason !== 'success' && result.exitReason !== 'error_max_turns') {
      throw new Error(`${label}: unexpected exit reason: ${result.exitReason}`);
    }

    // Phase 2: Outcome evaluation via LLM judge
    const groundTruth = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'test', 'fixtures', groundTruthFile), 'utf-8'),
    );

    // Read the generated report (try expected path, then glob for any .md in reportDir or workDir)
    let report: string | null = null;
    if (fs.existsSync(reportPath)) {
      report = fs.readFileSync(reportPath, 'utf-8');
    } else {
      // Agent may have named it differently — find any .md in reportDir or testWorkDir
      for (const searchDir of [reportDir, testWorkDir]) {
        try {
          const mdFiles = fs.readdirSync(searchDir).filter(f => f.endsWith('.md') && f !== 'BROWSER-SETUP.md');
          if (mdFiles.length > 0) {
            report = fs.readFileSync(path.join(searchDir, mdFiles[0]), 'utf-8');
            break;
          }
        } catch { /* dir may not exist if agent hit max_turns early */ }
      }

      // Also check the agent's final output for inline report content
      if (!report && result.output && result.output.length > 100) {
        report = result.output;
      }
    }

    if (!report) {
      dumpOutcomeDiagnostic(testWorkDir, label, '(no report file found)', { error: 'missing report' });
      recordE2E(evalCollector, `/qa ${label}`, 'Planted-bug outcome evals', result, { error: 'no report generated' } as any);
      throw new Error(`No report file found in ${reportDir}`);
    }

    const judgeResult = await outcomeJudge(groundTruth, report);
    console.log(`${label} outcome:`, JSON.stringify(judgeResult, null, 2));

    // Record to eval collector with outcome judge results
    recordE2E(evalCollector, `/qa ${label}`, 'Planted-bug outcome evals', result, {
      passed: judgePassed(judgeResult, groundTruth),
      detection_rate: judgeResult.detection_rate,
      false_positives: judgeResult.false_positives,
      evidence_quality: judgeResult.evidence_quality,
      detected_bugs: judgeResult.detected,
      missed_bugs: judgeResult.missed,
    } as any);

    // Diagnostic dump on failure (decision 1C)
    if (judgeResult.detection_rate < groundTruth.minimum_detection || judgeResult.false_positives > groundTruth.max_false_positives) {
      dumpOutcomeDiagnostic(testWorkDir, label, report, judgeResult);
    }

    // Phase 2 assertions
    expect(judgeResult.detection_rate).toBeGreaterThanOrEqual(groundTruth.minimum_detection);
    expect(judgeResult.false_positives).toBeLessThanOrEqual(groundTruth.max_false_positives);
    expect(judgeResult.evidence_quality).toBeGreaterThanOrEqual(2);
  }

  // B6: Static dashboard — broken link, disabled submit, overflow, missing alt, console error
  testConcurrentIfSelected('qa-b6-static', async () => {
    await runPlantedBugEval('qa-eval.html', 'qa-eval-ground-truth.json', 'b6-static');
  }, CAPTURE_LONG_MS);

  // B7: SPA — broken route, stale state, async race, missing aria, console warning
  testConcurrentIfSelected('qa-b7-spa', async () => {
    await runPlantedBugEval('qa-eval-spa.html', 'qa-eval-spa-ground-truth.json', 'b7-spa');
  }, CAPTURE_LONG_MS);

  // B8: Checkout — email regex, NaN total, CC overflow, missing required, stripe error
  testConcurrentIfSelected('qa-b8-checkout', async () => {
    await runPlantedBugEval('qa-eval-checkout.html', 'qa-eval-checkout-ground-truth.json', 'b8-checkout');
  }, CAPTURE_LONG_MS);

});

// Module-level afterAll — finalize eval collector after all tests complete
afterAll(async () => {
  await finalizeEvalCollector(evalCollector);
});
