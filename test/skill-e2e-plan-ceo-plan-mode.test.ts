/**
 * plan-ceo-review plan-mode smoke (gate, paid, real-PTY).
 *
 * Asserts: when /plan-ceo-review is invoked in plan mode, the FIRST terminal
 * outcome is 'asked' — a skill-question numbered list. Permission dialogs
 * (which also render numbered lists) are filtered out by `runPlanSkillObservation`
 * via its `isPermissionDialogVisible(visible.slice(-1500))` short-circuit.
 *
 * Reaching 'plan_ready' first IS the regression we want to catch: the agent
 * skipped Step 0 entirely and went straight to ExitPlanMode. The original
 * failure had the assistant read a diff, write a plan with two issues, and
 * call ExitPlanMode without ever firing AskUserQuestion — the user had to
 * manually call out the missing per-issue questions.
 *
 * Why this skill is special: unlike plan-eng-review / plan-design-review /
 * plan-devex-review (whose smokes accept either 'asked' or 'plan_ready'),
 * plan-ceo-review's template mandates Step 0A premise challenge (3 baked-in
 * questions) AND Step 0F mode selection BEFORE any plan write. There is no
 * legitimate path to plan_ready that does not first emit a skill-question
 * numbered prompt.
 *
 * Env passthrough: passes `QUESTION_TUNING=false` and `EXPLAIN_LEVEL=default`
 * via the runner's env option. Today these are advisory — `gstack-config`
 * reads `~/.gstack/config.yaml`, not env vars, so a contributor with
 * `question_tuning: true` set in their YAML config can still see AUTO_DECIDE
 * masking. The env passthrough is wired so a future gstack-config change to
 * honor env overrides will make this test hermetic without further edits.
 * Tracked as a post-merge follow-up.
 *
 * FAIL conditions: 'plan_ready' first, silent Write/Edit before any prompt,
 * claude crash, timeout.
 *
 * See test/helpers/claude-pty-runner.ts for runner internals.
 */

import { describe, test } from 'bun:test';
import {
  runPlanSkillObservation,
  assertReportAtBottomIfPlanWritten,
} from './helpers/claude-pty-runner';

const shouldRun = !!process.env.EVALS && process.env.EVALS_TIER === 'gate';
const describeE2E = shouldRun ? describe : describe.skip;

describeE2E('plan-ceo-review plan-mode smoke (gate)', () => {
  test('first terminal outcome is asked (Step 0 fires before any plan write)', async () => {
    const obs = await runPlanSkillObservation({
      skillName: 'plan-ceo-review',
      inPlanMode: true,
      timeoutMs: 300_000,
      env: { QUESTION_TUNING: 'false', EXPLAIN_LEVEL: 'default' },
    });

    if (obs.outcome !== 'asked') {
      const diagnosis =
        obs.outcome === 'plan_ready'
          ? `'plan_ready' first means the agent skipped Step 0 entirely and went straight to ExitPlanMode without asking.`
          : obs.outcome === 'timeout'
            ? `Timeout means the agent neither asked nor completed within the budget — likely hung mid-question or stuck on a permission dialog.`
            : obs.outcome === 'silent_write'
              ? `Silent Write/Edit fired to an unsanctioned path before any AskUserQuestion — also a Step 0 skip.`
              : `Outcome '${obs.outcome}' is unexpected; investigate the evidence below.`;
      throw new Error(
        `plan-ceo-review smoke FAILED: outcome=${obs.outcome}\n` +
          `${diagnosis}\n` +
          `Expected 'asked'. See plan-ceo-review/SKILL.md.tmpl: the Step 0 STOP rules ` +
          `and the "One issue = one AskUserQuestion call" rule under "CRITICAL RULE — ` +
          `How to ask questions".\n` +
          `summary: ${obs.summary}\n` +
          `elapsed: ${obs.elapsedMs}ms\n` +
          `--- evidence (last 2KB visible) ---\n${obs.evidence}`,
      );
    }
    assertReportAtBottomIfPlanWritten(obs);
  }, 360_000);
});
