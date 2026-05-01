/**
 * autoplan AskUserQuestion-blocked regression (gate, paid, real-PTY).
 *
 * v1.21+ regression: Conductor launches Claude Code with
 * `--disallowedTools AskUserQuestion --permission-mode default` (verified
 * by inspecting the parent claude process via `ps`). The native
 * AskUserQuestion tool is removed from the model's tool registry; without
 * fallback guidance the model can't ask the user and silently proceeds.
 *
 * Autoplan auto-decides INTERMEDIATE questions BY DESIGN
 * (autoplan/SKILL.md.tmpl:45), but Phase 1's premise confirmation gate is
 * one of the few non-auto-decided AskUserQuestions and MUST surface to the
 * user. This test asserts that gate still surfaces when AskUserQuestion is
 * disallowed at the tool-registry level — the fix must route the question
 * through a Conductor-side variant (mcp__conductor__AskUserQuestion) or
 * through the plan-file + ExitPlanMode flow.
 *
 * Filename keeps `auto-mode` for branch-history continuity. Auto-mode (the
 * AUTO_DECIDE preamble path when QUESTION_TUNING=true) is a related but
 * distinct silencing mechanism; both share the same fix surface.
 */

import { describe, test, expect } from 'bun:test';
import { runPlanSkillObservation, planFileHasDecisionsSection } from './helpers/claude-pty-runner';

const shouldRun = !!process.env.EVALS && process.env.EVALS_TIER === 'gate';
const describeE2E = shouldRun ? describe : describe.skip;

describeE2E('autoplan AskUserQuestion-blocked smoke (gate)', () => {
  // Pass envelope is ['asked', 'plan_ready']: model either renders the
  // first non-auto-decided gate (Phase 1 premise confirmation) as numbered
  // prose or surfaces it through the plan file + ExitPlanMode flow.
  // Autoplan auto-decides intermediate questions BY DESIGN; the failure
  // signal we care about is the AUTO_DECIDE preamble firing on a gate it
  // shouldn't (caught explicitly via the 'auto_decided' outcome).
  test('a non-auto-decided gate surfaces when AskUserQuestion is --disallowedTools', async () => {
    const obs = await runPlanSkillObservation({
      skillName: 'autoplan',
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
        `autoplan AskUserQuestion-blocked regression: outcome=${obs.outcome}\n` +
          `summary: ${obs.summary}\n` +
          `elapsed: ${obs.elapsedMs}ms\n` +
          `--- evidence (last 2KB visible) ---\n${obs.evidence}`,
      );
    }
    if (obs.outcome === 'plan_ready') {
      if (!obs.planFile || !planFileHasDecisionsSection(obs.planFile)) {
        throw new Error(
          `autoplan AskUserQuestion-blocked regression: plan_ready without a "## Decisions" section in ${obs.planFile ?? '<no plan file detected>'} — Phase 1 premise gate was silently skipped.\n` +
            `--- evidence (last 2KB visible) ---\n${obs.evidence}`,
        );
      }
    }
    expect(['asked', 'plan_ready']).toContain(obs.outcome);
  }, 360_000);
});
