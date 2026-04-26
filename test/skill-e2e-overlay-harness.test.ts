/**
 * Overlay-efficacy harness (periodic tier, paid).
 *
 * Measures whether a model-specific overlay nudge actually changes model
 * behavior when run through the real Claude Agent SDK — the harness
 * Claude Code itself is built on. This complements test/skill-e2e-opus-47.test.ts
 * which measures the same thing via `claude -p` subprocess (a different
 * harness with different prompt composition).
 *
 * For each fixture in test/fixtures/overlay-nudges.ts, runs two arms at
 * `fixture.trials` trials per arm with bounded concurrency:
 *   - overlay-on:  SDK systemPrompt = resolved overlay content
 *   - overlay-off: SDK systemPrompt = "" (empty)
 *
 * Both arms have no CLAUDE.md, no skills directory, no setting-source
 * inheritance (settingSources: []). This is the TRUE bare comparison —
 * the only variable is the overlay text.
 *
 * Budget ~$20 per run at 40 trials (2 fixtures × 2 arms × 10 trials).
 * Gated by EVALS=1 AND EVALS_TIER=periodic. Never runs under test:gate.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  runAgentSdkTest,
  resolveClaudeBinary,
  type AgentSdkResult,
  type SystemPromptOption,
} from './helpers/agent-sdk-runner';
import { EvalCollector, getProjectEvalDir } from './helpers/eval-store';
import {
  OVERLAY_FIXTURES,
  type OverlayFixture,
} from './fixtures/overlay-nudges';
import { readOverlay } from '../scripts/resolvers/model-overlay';

const evalsEnabled = !!process.env.EVALS;
const periodicTier = process.env.EVALS_TIER === 'periodic';
const shouldRun = evalsEnabled && periodicTier;

const describeE2E = shouldRun ? describe : describe.skip;
// EvalCollector's tier must be 'e2e' | 'llm-judge' per its type signature.
// The existing paid evals violate this by passing descriptive names like
// 'e2e-opus-47' — a pre-existing pattern that only works because bun-test
// runs without strict typechecking. We stay conforming here.
const evalCollector = shouldRun ? new EvalCollector('e2e') : null;

const REPO_ROOT = path.resolve(import.meta.dir, '..');
const runId = new Date()
  .toISOString()
  .replace(/[:.]/g, '')
  .replace('T', '-')
  .slice(0, 15);
const TRANSCRIPTS_DIR = path.join(
  path.dirname(getProjectEvalDir()),
  'transcripts',
  `overlay-harness-${runId}`,
);

// ---------------------------------------------------------------------------
// Per-arm helpers
// ---------------------------------------------------------------------------

type Arm = 'overlay-on' | 'overlay-off';

function mkTrialDir(fixtureId: string, arm: Arm, n: number): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), `overlay-harness-${fixtureId}-${arm}-${n}-`),
  );
  return dir;
}

function saveRawTranscript(
  fixtureId: string,
  arm: Arm,
  n: number,
  result: AgentSdkResult,
): void {
  fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
  const out = path.join(TRANSCRIPTS_DIR, `${fixtureId}-${arm}-${n}.jsonl`);
  const lines = result.events.map((e) => JSON.stringify(e));
  fs.writeFileSync(out, lines.join('\n') + '\n');
}

function overlayContentFor(fixture: OverlayFixture): string {
  const family = path.basename(fixture.overlayPath, '.md');
  const resolved = readOverlay(family);
  if (!resolved) {
    throw new Error(
      `fixture ${fixture.id}: resolver returned empty content for ${family}`,
    );
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Per-fixture runner
// ---------------------------------------------------------------------------

interface ArmResult {
  metrics: number[];
  costs: number[];
  durations: number[];
  rateLimitExhausted: number;
  sdkClaudeCodeVersions: Set<string>;
}

async function runArm(
  fixture: OverlayFixture,
  arm: Arm,
  systemPrompt: SystemPromptOption,
  claudeBinary: string | null,
): Promise<ArmResult> {
  const result: ArmResult = {
    metrics: [],
    costs: [],
    durations: [],
    rateLimitExhausted: 0,
    sdkClaudeCodeVersions: new Set(),
  };

  const trials = fixture.trials;
  const concurrency = fixture.concurrency ?? 3;

  // Simple bounded executor: run trials in chunks of `concurrency`.
  // The process-level semaphore in agent-sdk-runner.ts enforces the true cap.
  let nextTrial = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const n = nextTrial++;
      if (n >= trials) return;

      const dir = mkTrialDir(fixture.id, arm, n);
      fixture.setupWorkspace(dir);
      try {
        const sdkResult = await runAgentSdkTest({
          systemPrompt,
          userPrompt: fixture.userPrompt,
          workingDirectory: dir,
          model: fixture.model,
          maxTurns: fixture.maxTurns ?? 5,
          allowedTools: fixture.allowedTools ?? ['Read', 'Glob', 'Grep', 'Bash'],
          permissionMode: 'bypassPermissions',
          settingSources: [],
          env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '' },
          pathToClaudeCodeExecutable: claudeBinary ?? undefined,
          testName: `${fixture.id}-${arm}-${n}`,
          runId,
          fixtureId: fixture.id,
          onRetry: (_) => {
            // Reset the workspace before the retry so partial Bash side effects
            // from the failed attempt don't contaminate.
            fs.rmSync(dir, { recursive: true, force: true });
            fs.mkdirSync(dir, { recursive: true });
            fixture.setupWorkspace(dir);
          },
        });

        saveRawTranscript(fixture.id, arm, n, sdkResult);

        const metric = fixture.metric(sdkResult);
        result.metrics.push(metric);
        result.costs.push(sdkResult.costUsd);
        result.durations.push(sdkResult.durationMs);
        result.sdkClaudeCodeVersions.add(sdkResult.sdkClaudeCodeVersion);

        evalCollector?.addTest({
          name: `${fixture.id}-${arm}-${n}`,
          suite: 'overlay-harness',
          tier: 'e2e',
          passed: true,
          duration_ms: sdkResult.durationMs,
          cost_usd: sdkResult.costUsd,
          transcript: sdkResult.events,
          prompt: fixture.userPrompt,
          output: sdkResult.output,
          turns_used: sdkResult.turnsUsed,
          browse_errors: sdkResult.browseErrors,
          exit_reason: sdkResult.exitReason,
          model: sdkResult.model,
          first_response_ms: sdkResult.firstResponseMs,
          max_inter_turn_ms: sdkResult.maxInterTurnMs,
        });
      } catch (err) {
        if (err instanceof Error && err.name === 'RateLimitExhaustedError') {
          result.rateLimitExhausted++;
          // Record a failed trial so the collector captures the attempt.
          evalCollector?.addTest({
            name: `${fixture.id}-${arm}-${n}`,
            suite: 'overlay-harness',
            tier: 'e2e',
            passed: false,
            duration_ms: 0,
            cost_usd: 0,
            exit_reason: 'rate_limit_exhausted',
            error: err.message,
          });
        } else {
          throw err;
        }
      } finally {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          // best-effort cleanup
        }
      }
    }
  });

  await Promise.all(workers);
  return result;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

// ---------------------------------------------------------------------------
// Test bodies
// ---------------------------------------------------------------------------

describeE2E('overlay efficacy harness (SDK)', () => {
  // Resolve binary once
  const claudeBinary = resolveClaudeBinary();

  if (!claudeBinary) {
    test.skip(
      'no local `claude` binary on PATH — cannot pin for harness parity',
      () => {},
    );
    return;
  }

  for (const fixture of OVERLAY_FIXTURES) {
    test(
      `${fixture.id}: overlay-ON vs overlay-OFF, N=${fixture.trials} per arm`,
      async () => {
        const overlayText = overlayContentFor(fixture);
        expect(overlayText.length).toBeGreaterThan(100);

        // Arm composition: both arms use the real Claude Code default system
        // prompt (preset). Overlay-ON APPENDS the overlay text; overlay-OFF
        // uses the default alone. This measures the overlay's marginal effect
        // ON TOP of Claude Code's normal behavioral scaffolding — which is
        // the only measurement that matches how real Claude Code composes
        // overlays into its system prompt stack.
        const [onArm, offArm] = await Promise.all([
          runArm(
            fixture,
            'overlay-on',
            { type: 'preset', preset: 'claude_code', append: overlayText },
            claudeBinary,
          ),
          runArm(
            fixture,
            'overlay-off',
            { type: 'preset', preset: 'claude_code' },
            claudeBinary,
          ),
        ]);

        const arms = {
          overlay: onArm.metrics,
          off: offArm.metrics,
        };

        const meanOn = mean(arms.overlay);
        const meanOff = mean(arms.off);
        const lift = meanOn - meanOff;
        const floorHits = arms.overlay.filter((n) => n >= 2).length;
        const totalCost = sum(onArm.costs) + sum(offArm.costs);
        const versionSet = new Set([
          ...onArm.sdkClaudeCodeVersions,
          ...offArm.sdkClaudeCodeVersions,
        ]);

        // Loud output for the next person reading the eval JSON:
        // eslint-disable-next-line no-console
        console.log(
          `\n[${fixture.id}]\n` +
            `  binary: ${claudeBinary}\n` +
            `  claude_code_version(s): ${[...versionSet].join(', ')}\n` +
            `  overlay-ON  metrics: [${arms.overlay.join(', ')}]  mean=${meanOn.toFixed(2)}\n` +
            `  overlay-OFF metrics: [${arms.off.join(', ')}]  mean=${meanOff.toFixed(2)}\n` +
            `  lift: ${lift.toFixed(2)}  floor_hits(>=2): ${floorHits}/${fixture.trials}\n` +
            `  rate_limit_exhausted: on=${onArm.rateLimitExhausted} off=${offArm.rateLimitExhausted}\n` +
            `  total_cost_usd: $${totalCost.toFixed(4)}\n` +
            `  transcripts: ${TRANSCRIPTS_DIR}`,
        );

        // Demand enough trials actually completed to make the assertion
        // meaningful. If rate-limit exhaustion took out more than half of an
        // arm, fail loudly rather than pass/fail on a fragment.
        const minTrials = Math.ceil(fixture.trials / 2);
        expect(arms.overlay.length).toBeGreaterThanOrEqual(minTrials);
        expect(arms.off.length).toBeGreaterThanOrEqual(minTrials);

        expect(fixture.pass(arms)).toBe(true);
      },
      30 * 60 * 1000, // 30 minute timeout per fixture
    );
  }
});

afterAll(async () => {
  if (evalCollector) {
    const filepath = await evalCollector.finalize();
    // eslint-disable-next-line no-console
    console.log(`\n[overlay-harness] eval results: ${filepath}`);
  }
});
