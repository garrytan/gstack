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

  // v1.21+ regression: Conductor launches Claude Code with
  // `--disallowedTools AskUserQuestion --permission-mode default` (verified
  // via `ps` on the live Conductor claude process). Native AskUserQuestion
  // is removed from the model's tool registry; without fallback guidance
  // the model can't ask and silently proceeds.
  //
  // The fix (Tool resolution preamble) accepts two surface paths under
  // --disallowedTools:
  //   - 'asked'      — model emits a numbered-option prompt as prose (with
  //                     the same D<N> + Pros/cons format as a real AUQ)
  //   - 'plan_ready' — model writes the question into the plan file as a
  //                     "## Decisions to confirm" section + ExitPlanMode;
  //                     the native plan-mode "Ready to execute?" surfaces
  //                     it through the TTY confirmation
  //
  // Both let the user see the decision. Failure signals are
  // silent_write/exited/timeout (model never surfaced the question) and
  // 'auto_decided' (the AUTO_DECIDE preamble fired without a /plan-tune
  // opt-in — caught explicitly).
  test('AskUserQuestion surfaces when --disallowedTools AskUserQuestion is set', async () => {
    const obs = await runPlanSkillObservation({
      skillName: 'plan-ceo-review',
      inPlanMode: true,
      extraArgs: ['--disallowedTools', 'AskUserQuestion'],
      timeoutMs: 300_000,
    });

    if (
      obs.outcome === 'auto_decided' ||
      obs.outcome === 'silent_write' ||
      obs.outcome === 'exited' ||
      obs.outcome === 'timeout'
    ) {
      throw new Error(
        `plan-ceo-review AskUserQuestion-blocked regression: outcome=${obs.outcome}\n` +
          `summary: ${obs.summary}\n` +
          `elapsed: ${obs.elapsedMs}ms\n` +
          `--- evidence (last 2KB visible) ---\n${obs.evidence}`,
      );
    }
    expect(['asked', 'plan_ready']).toContain(obs.outcome);
  }, 360_000);
});
