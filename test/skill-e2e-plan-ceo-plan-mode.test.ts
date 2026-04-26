/**
 * plan-ceo-review plan-mode smoke (gate, paid, real-PTY).
 *
 * Asserts: when /plan-ceo-review is invoked in plan mode, the skill reaches
 * a terminal outcome that is either:
 *   - 'asked'      — skill emitted its Step 0 numbered prompt (scope mode
 *                    selection, or the routing-injection prompt that runs
 *                    before Step 0)
 *   - 'plan_ready' — skill ran end-to-end and surfaced claude's native
 *                    "Ready to execute" confirmation
 *
 * FAIL conditions: silent Write/Edit before any prompt, claude crash,
 * timeout.
 *
 * Replaces the SDK-based test that never worked: the SDK's canUseTool
 * interceptor on AskUserQuestion never fires in plan mode because plan
 * mode renders its native confirmation as TTY UI, not via the
 * AskUserQuestion tool. The real PTY harness observes the rendered
 * terminal output directly.
 *
 * See test/helpers/claude-pty-runner.ts for runner internals.
 */

import { describe, test, expect } from 'bun:test';
import { runPlanSkillObservation } from './helpers/claude-pty-runner';

const shouldRun = !!process.env.EVALS && process.env.EVALS_TIER === 'gate';
const describeE2E = shouldRun ? describe : describe.skip;

describeE2E('plan-ceo-review plan-mode smoke (gate)', () => {
  test('reaches a terminal outcome (asked or plan_ready) without silent writes', async () => {
    const obs = await runPlanSkillObservation({
      skillName: 'plan-ceo-review',
      inPlanMode: true,
      timeoutMs: 300_000,
    });

    if (obs.outcome === 'silent_write' || obs.outcome === 'exited' || obs.outcome === 'timeout') {
      throw new Error(
        `plan-ceo-review plan-mode smoke FAILED: outcome=${obs.outcome}\n` +
          `summary: ${obs.summary}\n` +
          `elapsed: ${obs.elapsedMs}ms\n` +
          `--- evidence (last 2KB visible) ---\n${obs.evidence}`,
      );
    }
    expect(['asked', 'plan_ready']).toContain(obs.outcome);
  }, 360_000);
});
