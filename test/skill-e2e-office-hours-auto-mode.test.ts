/**
 * office-hours AskUserQuestion-blocked regression (gate, paid, real-PTY).
 *
 * v1.21+ regression: Conductor launches Claude Code with
 * `--disallowedTools AskUserQuestion --permission-mode default` (verified
 * by inspecting the parent claude process via `ps`). office-hours' first
 * step issues a startup-vs-builder mode AskUserQuestion
 * (office-hours/SKILL.md.tmpl:69); when AskUserQuestion is disallowed at
 * the tool-registry level the model cannot ask and silently picks one mode,
 * breaking the whole interactive premise. This test asserts that question
 * still surfaces — through mcp__conductor__AskUserQuestion (when present)
 * or the prose fallback, never a plan-file ## Decisions substitute.
 *
 * Filename keeps `auto-mode` for branch-history continuity. Auto-mode (the
 * AUTO_DECIDE preamble path when QUESTION_TUNING=true) is a related but
 * distinct silencing mechanism; both share the same fix surface.
 */

import { test, expect } from 'bun:test';
import { CAPTURE_MS, CAPTURE_LONG_MS } from './helpers/eval-budgets';
import { describeE2ETier } from './helpers/e2e-gate';
import { runPlanSkillObservation, planFileHasDecisionsSection } from './helpers/claude-pty-runner';
import { assertNoPlanFileDecisions } from './helpers/plan-mode-evidence';

const describeE2E = describeE2ETier('gate');

// The PR lane selects this case by a test name ending in its id.
describeE2E('office-hours AskUserQuestion-blocked smoke (gate): AskUserQuestion surfaces when --disallowedTools AskUserQuestion is set', () => {
  // With AskUserQuestion blocked the mode question must still be asked (the
  // prose fallback, observed as 'asked'); a plan-file ## Decisions section is
  // not a substitute. Failure signals also include 'auto_decided' +
  // silent_write/exited/timeout.
  test('office-hours-auto-mode', async () => {
    const obs = await runPlanSkillObservation({
      skillName: 'office-hours',
      inPlanMode: true,
      extraArgs: ['--disallowedTools', 'AskUserQuestion'],
      timeoutMs: CAPTURE_MS,
    });

    if (
      obs.outcome === 'auto_decided' ||
      obs.outcome === 'silent_write' ||
      obs.outcome === 'exited' ||
      obs.outcome === 'timeout'
    ) {
      throw new Error(
        `office-hours AskUserQuestion-blocked regression: outcome=${obs.outcome}\n` +
          `summary: ${obs.summary}\n` +
          `elapsed: ${obs.elapsedMs}ms\n` +
          `--- evidence (last 2KB visible) ---\n${obs.evidence}`,
      );
    }
    assertNoPlanFileDecisions(obs, planFileHasDecisionsSection);
    if (obs.outcome !== 'asked') {
      throw new Error(
        `office-hours AskUserQuestion-blocked regression: outcome=${obs.outcome} — the startup-vs-builder mode question reached ${obs.planFile ?? 'plan_ready'} without being asked.\n` +
          `--- evidence (last 2KB visible) ---\n${obs.evidence}`,
      );
    }
  }, CAPTURE_LONG_MS);
});
