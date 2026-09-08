/** Periodic paid regression: the plan-review off switch never dispatches a replacement reviewer. */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { e2eTierEnabled } from './helpers/e2e-gate';
import { runSkillTest } from './helpers/session-runner';
import { EvalCollector, getProjectEvalDir } from './helpers/eval-store';
import { CAPTURE_MS, CAPTURE_LONG_MS } from './helpers/eval-budgets';
import { disabledPlanReviewEvidence, installDisabledPlanReviewFixture } from './helpers/disabled-plan-review-fixture';

const ROOT = path.resolve(import.meta.dir, '..');
const periodic = e2eTierEnabled('periodic');
const enabled = periodic && !!Bun.which('claude');
if (periodic && !enabled) process.stderr.write('Disabled plan-review E2E: SKIPPED — Claude CLI is unavailable. No behavior was exercised.\n');
const selected = enabled ? (await import('./helpers/e2e-helpers')).selectedTests : [];
const collector = enabled ? new EvalCollector('e2e-outside-plan-disabled') : null;
const describeLive = enabled ? describe : describe.skip;
const testName = 'outside-plan-disabled-no-fallback';
const testSelected = selected === null || selected.includes(testName) ? test : test.skip;
afterAll(async () => { if (collector) await collector.finalize(); });

describeLive('Disabled outside plan review', () => {
  testSelected('outside-plan-disabled-no-fallback', async () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-outside-disabled-'));
    const repo = path.join(fixtureRoot, 'repo');
    const rendered = path.join(fixtureRoot, 'render');
    fs.mkdirSync(repo);
    const runId = `${testName}-${process.env.GSTACK_EVAL_RUN_ID ?? Date.now()}-${path.basename(fixtureRoot)}`;
    const evidenceDir = path.join(process.env.GSTACK_EVAL_DIR || getProjectEvalDir(), 'disabled-plan-review', runId);
    fs.mkdirSync(evidenceDir, { recursive: true });
    try {
      const render = Bun.spawnSync([process.execPath, 'run', 'scripts/gen-skill-docs.ts', '--host', 'claude', '--out-dir', rendered], {
        cwd: ROOT, stdout: 'pipe', stderr: 'pipe', timeout: 120_000,
      });
      if (render.exitCode !== 0) throw new Error(`Isolated generation failed: ${render.stderr}`);
      const fixture = installDisabledPlanReviewFixture(rendered, repo, ROOT);
      fs.writeFileSync(path.join(repo, 'PLAN.md'), '# Accepted plan\n\nAdd a documented --json flag to the existing status command. Preserve the text output by default, and test both formats. Native review is complete.\n');
      // The parent must discover the control through the actual preflight.
      // Do not tell it the expected branch or forbid Agent in the prompt/tools.
      const prompt = 'The native engineering review of PLAN.md is complete. Read OUTSIDE-PLAN.md and execute that final workflow section for this plan, following its actual configuration and branch rules. Then return the workflow completion summary, including outside-review attribution. This is an isolated review fixture; all required reviewer tools are authorized.';
      fs.writeFileSync(path.join(evidenceDir, 'instructions.md'), fixture.instructions);
      const result = await runSkillTest({
        workingDirectory: repo, prompt, testName, runId,
        timeout: CAPTURE_MS, maxTurns: 15,
        tools: ['Bash', 'Read', 'Write', 'Grep', 'Glob', 'Agent'],
        allowedTools: ['Bash', 'Read', 'Write', 'Grep', 'Glob', 'Agent'],
        env: fixture.env,
      });
      const cliDispatchLog = fs.existsSync(fixture.cliDispatchLog) ? fs.readFileSync(fixture.cliDispatchLog, 'utf8') : '';
      const reviewLog = fs.existsSync(fixture.reviewLogPath) ? fs.readFileSync(fixture.reviewLogPath, 'utf8') : '';
      const evidence = disabledPlanReviewEvidence(result, cliDispatchLog, reviewLog, fixture.priorRecord);
      fs.writeFileSync(path.join(evidenceDir, 'review-log.jsonl'), reviewLog);
      // Persist positive and negative native tool evidence before assertions or
      // fixture cleanup. A timeout, missing init/result, or empty run never passes.
      fs.writeFileSync(path.join(evidenceDir, 'transcript.ndjson'), result.transcript.map(event => JSON.stringify(event)).join('\n') + '\n');
      fs.writeFileSync(path.join(evidenceDir, 'evidence.json'), JSON.stringify({ ...evidence, exitReason: result.exitReason, model: result.model, output: result.output, cost: result.costEstimate }, null, 2) + '\n');
      collector?.addTest({ name: testName, suite: 'outside-plan-disabled', tier: 'e2e', passed: evidence.passed,
        duration_ms: result.duration, cost_usd: result.costEstimate.estimatedCost, model: result.model,
        turns_used: result.costEstimate.turnsUsed, exit_reason: result.exitReason,
        transcript: result.transcript, output: result.output, prompt,
      });
      expect(evidence, `Native evidence: ${evidenceDir}`).toMatchObject({
        passed: true, completed: true, agentAvailable: true, disabledAttribution: true,
        falseCompletion: false, persistedDisabled: true, fallbackCalls: [], cliDispatchLog: '',
      });
      expect(evidence.disabledPreflight.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, CAPTURE_LONG_MS); // One normal capture plus bounded isolated generation.
});
