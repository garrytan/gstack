/**
 * /plan-ceo-review AskUserQuestion floor regression (gate, paid, real-PTY).
 *
 * Contract: a seeded forcing finding must fire at least one AskUserQuestion
 * before the review writes its plan or exits plan mode (the /plan-eng-review
 * floor that first pinned it retired with that skill, GST-1698).
 */

import { test } from 'bun:test';
import { CAPTURE_LONG_MS, PTY_MS } from './helpers/eval-budgets';
import { describeE2ETier } from './helpers/e2e-gate';
import { runPlanSkillFloorCheck } from './helpers/claude-pty-runner';
import { FORCING_FLOOR_CEO } from './fixtures/forcing-finding-seeds';

const describeE2E = describeE2ETier('gate');

describeE2E('/plan-ceo-review AskUserQuestion floor (gate)', () => {
  test(
    'seeded forcing finding causes the agent to fire at least one AskUserQuestion',
    async () => {
      const obs = await runPlanSkillFloorCheck({
        skillName: 'plan-ceo-review',
        slashCommand: '/plan-ceo-review',
        followUpPrompt: FORCING_FLOOR_CEO,
        requestedPlanPath: '/tmp/gstack-test-plan-ceo-floor.md',
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
            `--- evidence (last 3KB) ---\n${obs.evidence}`,
        );
      }
    },
    PTY_MS,
  );
});
