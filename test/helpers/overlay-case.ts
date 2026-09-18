/**
 * Paid overlay behavior contract v2. Both arms use the real Claude Code preset;
 * ON appends the resolved overlay. Complete execution, scope and ON correctness
 * gate the case; unchanged efficacy comparisons remain separate research results.
 * A behavior pass establishes neither marginal benefit nor resource non-regression.
 *
 * Six fixtures × two arms × ten trials. The paid runner disables Bun retries;
 * native rate-limit retries retain separate evidence. No fixed cost guarantee.
 */
import { test, expect, afterAll } from 'bun:test';
import { e2eTierEnabled } from './e2e-gate';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  runAgentSdkTest, resolveClaudeBinary, type SystemPromptOption,
} from './agent-sdk-runner';
import { EvalCollector, getProjectEvalDir } from './eval-store';
import { OVERLAY_FIXTURES, type OverlayFixture } from '../fixtures/overlay-nudges';
import { readOverlay } from '../../scripts/resolvers/model-overlay';
import { trialArtifactStem } from './overlay-measurement';
import { runOverlayTrial, captureOverlayQueryAttempts, type OverlayTrialOutcome } from './overlay-attempt';

const shouldRun = e2eTierEnabled('periodic');
const evalCollector = shouldRun ? new EvalCollector('e2e') : null;
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}-${randomUUID()}`;
// Keep diagnostics with the selected run; importing the free suite has no writes.
const TRANSCRIPTS_DIR = shouldRun ? path.join(
  process.env.GSTACK_EVAL_DIR ?? getProjectEvalDir(), 'transcripts', `overlay-harness-${runId}`,
) : '';
const attempts = new Map<string, number>();
type Arm = 'overlay-on' | 'overlay-off';

function saveTrial(fixture: OverlayFixture, attempt: number, arm: Arm, n: number, retries: number, outcome: OverlayTrialOutcome): void {
  fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
  const stem = trialArtifactStem(fixture.id, attempt, arm, n);
  // Exclusive writes expose identity collisions instead of overwriting evidence.
  fs.writeFileSync(path.join(TRANSCRIPTS_DIR, `${stem}.jsonl`),
    (outcome.result?.events ?? []).map((event) => JSON.stringify(event)).join('\n') + '\n', { flag: 'wx' });
  fs.writeFileSync(path.join(TRANSCRIPTS_DIR, `${stem}.json`), JSON.stringify({
    contract: OVERLAY_CONTRACT, fixture: fixture.id, attempt, arm, trial: n, metricName: fixture.metricName,
    rateLimitRetries: retries,
    // Per-query SDK files preserve prior retry events and thrown-error streams;
    // this JSONL remains the final SDK result used for the trial measurement.
    rateLimitAttemptStreamsRetained: true,
    measurementPassed: outcome.passed, taskCorrect: outcome.taskCorrect, metric: outcome.metric, exitReason: outcome.exitReason,
    error: outcome.error, before: outcome.before, after: outcome.after,
  }, null, 2) + '\n', { flag: 'wx' });
}


import { runOverlayCaseLifecycle } from './overlay-lifecycle';
import { snapshotWorkspace } from './overlay-workspace';
import { OVERLAY_CONTRACT, OVERLAY_CASE_OUTER_MS, OVERLAY_CASE_WORK_MS } from './overlay-case-policy';

export function registerOverlayCase(fixtureId: string): void {
  const fixture = OVERLAY_FIXTURES.find(candidate => candidate.id === fixtureId);
  if (!fixture) throw new Error(`Unknown overlay fixture: ${fixtureId}`);
  const claudeBinary = shouldRun ? resolveClaudeBinary() : null;
  if (shouldRun && !claudeBinary) {
    test.skip('no local `claude` binary on PATH — cannot pin for harness parity', () => {});
    return;
  }
  test(`${fixture.id}: overlay-ON vs overlay-OFF, N=${fixture.trials} per arm`, async () => {
    const attempt = (attempts.get(fixture.id) ?? 0) + 1;
    attempts.set(fixture.id, attempt);
    const started = Date.now();
    const workspaces = new Map<string, string>();
    const before = new Map<string, Record<string, string>>();
    const trials: OverlayTrialOutcome[] = [];
    const retries = new Map<string, number>();
    let summary: Record<string, unknown> | undefined;
    let aggregateRecorded = false;
    const recordAggregate = (value: Record<string, unknown>) => {
      if (aggregateRecorded) return;
      aggregateRecorded = true;
      summary = { fixture: fixture.id, attempt, metricName: fixture.metricName, wallClockMs: Date.now() - started, ...value, contract: OVERLAY_CONTRACT };
      fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
      fs.writeFileSync(path.join(TRANSCRIPTS_DIR, `${fixture.id}-attempt-${attempt}-aggregate.json`), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
      evalCollector?.addTest({
        name: `${fixture.id}-contract-v${OVERLAY_CONTRACT.version}-aggregate`, suite: 'overlay-harness-aggregate', tier: 'e2e',
        passed: value.passed === true, duration_ms: 0, cost_usd: 0, model: fixture.model,
        exit_reason: value.passed ? 'success' : value.timedOut ? 'timeout' : 'validation_failed',
        error: value.passed ? undefined : JSON.stringify(value.errors ?? value.comparison ?? value.assessment),
        output: JSON.stringify(summary),
      });
      console.log(`\n[overlay-harness] ${JSON.stringify(summary, null, 2)}`);
    };
    try {
      const overlay = readOverlay(path.basename(fixture.overlayPath, '.md'));
      if (overlay.length <= 100) throw new Error(`fixture ${fixture.id}: resolved overlay missing or unexpectedly short`);
      if (!fixture.comparison) throw new Error(`fixture ${fixture.id}: missing comparison specification`);
      if (fixture.comparison.unsupportedHypothesis) {
        recordAggregate({ passed: false, comparison: { status: 'unsupported_hypothesis', criterionMet: false, explanation: fixture.comparison.unsupportedHypothesis } });
      } else {
        await runOverlayCaseLifecycle({
          fixture, workMs: Math.max(0, OVERLAY_CASE_WORK_MS - (Date.now() - started)),
          execute: async (arm, index, signal, active, deadlineAt) => {
            if (!active()) throw new Error('overlay case already finalized');
            const key = `${arm}-${index}`;
            const stem = trialArtifactStem(fixture.id, attempt, arm, index);
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), `overlay-${fixture.id}-${key}-`));
            workspaces.set(key, dir);
            const captureQuery = captureOverlayQueryAttempts(TRANSCRIPTS_DIR, stem, query);
            return runOverlayTrial({
              fixture: { ...fixture, setupWorkspace: directory => {
                fixture.setupWorkspace(directory);
                before.set(key, snapshotWorkspace(directory));
                fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
                fs.writeFileSync(path.join(TRANSCRIPTS_DIR, `${stem}-started.json`), JSON.stringify({ fixture: fixture.id, attempt, arm, trial: index, before: before.get(key) }) + '\n', { flag: 'wx' });
              } },
              directory: dir, isActive: active, deadlineAt,
              invoke: () => runAgentSdkTest({
                systemPrompt: arm === 'overlay-on' ? { type: 'preset', preset: 'claude_code', append: overlay } : { type: 'preset', preset: 'claude_code' },
                userPrompt: fixture.userPrompt, workingDirectory: dir, model: fixture.model,
                maxTurns: fixture.maxTurns ?? 5, allowedTools: fixture.allowedTools ?? ['Read', 'Glob', 'Grep', 'Bash'],
                permissionMode: 'bypassPermissions', settingSources: [],
                env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '' },
                pathToClaudeCodeExecutable: claudeBinary!, queryProvider: captureQuery, signal,
                testName: `${fixture.id}-${key}`, runId, fixtureId: fixture.id,
                onRetry: () => {
                  if (!active()) throw new Error('overlay retry after case finalized');
                  retries.set(key, (retries.get(key) ?? 0) + 1);
                  fs.rmSync(dir, { recursive: true, force: true });
                  fs.mkdirSync(dir, { recursive: true });
                  fixture.setupWorkspace(dir);
                },
              }),
              // Parent lifecycle owns the only externally visible record.
              record: () => {},
            });
          },
          recordTrial: (arm, index, outcome) => {
            const key = `${arm}-${index}`;
            let after = outcome.after;
            try { if (!after && workspaces.has(key)) after = snapshotWorkspace(workspaces.get(key)!); } catch { /* preserve original timeout/error */ }
            const retained = { ...outcome, before: outcome.before ?? before.get(key), after };
            saveTrial(fixture, attempt, arm, index, retries.get(key) ?? 0, retained);
            const sdk = outcome.result;
            evalCollector?.addTest({
              name: `${fixture.id}-contract-v${OVERLAY_CONTRACT.version}-${key}`, suite: 'overlay-harness-measurement', tier: 'e2e',
              passed: outcome.passed, duration_ms: sdk?.durationMs ?? 0, cost_usd: sdk?.costUsd ?? 0,
              transcript: sdk?.events, prompt: fixture.userPrompt,
              output: JSON.stringify({ contract: OVERLAY_CONTRACT, measurementPassed: outcome.passed, taskCorrect: outcome.taskCorrect, metric: outcome.metric, assistantOutput: sdk?.output }),
              turns_used: sdk?.turnsUsed, browse_errors: sdk?.browseErrors,
              exit_reason: outcome.exitReason, error: outcome.error,
              model: sdk?.model ?? fixture.model, first_response_ms: sdk?.firstResponseMs, max_inter_turn_ms: sdk?.maxInterTurnMs,
            });
            trials.push(retained);
          },
          recordAggregate: result => recordAggregate({ ...result,
            recordedTrials: trials.length,
            partialEvidence: trials.length < result.startedTrials,
            recordedCostUsd: trials.reduce((sum, trial) => sum + (trial.result?.costUsd ?? 0), 0),
            taskCorrect: trials.map(trial => trial.taskCorrect), transcripts: TRANSCRIPTS_DIR,
          }),
          cleanup: () => Promise.all([...workspaces.values()].map(dir => fs.promises.rm(dir, { recursive: true, force: true }))).then(() => {}),
        });
      }
    } catch (cause) {
      recordAggregate({ passed: false, errors: [cause instanceof Error ? cause.message : String(cause)] });
      throw cause;
    }
    expect(summary?.passed).toBe(true);
  }, OVERLAY_CASE_OUTER_MS);
}

afterAll(async () => {
  if (evalCollector) console.log(`\n[overlay-harness] eval results: ${await evalCollector.finalize()}`);
});
