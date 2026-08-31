/**
 * /plan-eng-review AskUserQuestion floor regression (periodic, paid, real-PTY).
 *
 * Catches the May 2026 transcript bug where /plan-eng-review wrote a
 * multi-section review plan to ~/.claude/plans/ and called ExitPlanMode
 * without firing any AskUserQuestion. See
 * `.context/attachments/pasted_text_2026-05-06_10-25-23.txt`.
 *
 * Uses runPlanSkillFloorCheck — a minimal "did the agent fire ANY AUQ?"
 * observer that exits early on the first non-permission numbered-option
 * render. See claude-pty-runner.ts for why this is separate from the
 * runPlanSkillCounting harness used by periodic finding-count tests.
 *
 * Tier: periodic. Budget: 10 min (early exit on success ~30-90s typical).
 * Cost: ~$0.50-$1.50 per run depending on early-exit timing.
 */

import { test } from 'bun:test';
import { CAPTURE_LONG_MS, PTY_MS } from './helpers/eval-budgets';
import { describeE2ETier } from './helpers/e2e-gate';
import { runPlanSkillFloorCheck } from './helpers/claude-pty-runner';
import { FORCING_FLOOR_ENG } from './fixtures/forcing-finding-seeds';

const describeE2E = describeE2ETier('periodic');

describeE2E('/plan-eng-review AskUserQuestion floor (periodic)', () => {
  test(
    'seeded forcing finding causes the agent to fire at least one AskUserQuestion',
    async () => {
      const obs = await runPlanSkillFloorCheck({
        skillName: 'plan-eng-review',
        slashCommand: '/plan-eng-review',
        followUpPrompt: FORCING_FLOOR_ENG,
        // LIVE-REPO CWD: PTY session needs the repo cwd — gstack skill
        // registry + hermetic pre-trusted dir (hermetic-env trustedDirs).
        cwd: process.cwd(),
        timeoutMs: CAPTURE_LONG_MS,
        env: { QUESTION_TUNING: 'false', EXPLAIN_LEVEL: 'default' },
      });

      if (obs.outcome !== 'auq_observed') {
        throw new Error(
          `floor test FAILED: outcome=${obs.outcome} elapsed=${obs.elapsedMs}ms\n` +
            `summary: ${obs.summary}\n` +
            `If outcome is plan_ready or completion_summary, this is the transcript-bug ` +
            `regression — agent reached terminal without firing AskUserQuestion. See ` +
            `.context/attachments/pasted_text_2026-05-06_10-25-23.txt.\n` +
            `If outcome is timeout, agent may just be slow — re-run or increase budget.\n` +
            `--- evidence (last 3KB) ---\n${obs.evidence}`,
        );
      }
    },
    PTY_MS,
  );
});
