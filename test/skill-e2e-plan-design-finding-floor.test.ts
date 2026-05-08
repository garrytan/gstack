/**
 * /plan-design-review AskUserQuestion floor regression (gate, paid, real-PTY).
 *
 * See test/skill-e2e-plan-eng-finding-floor.test.ts for the contract.
 */

import { describe, test } from 'bun:test';
import { runPlanSkillFloorCheck } from './helpers/claude-pty-runner';
import { FORCING_FLOOR_DESIGN } from './fixtures/forcing-finding-seeds';

const shouldRun = !!process.env.EVALS && process.env.EVALS_TIER === 'gate';
const describeE2E = shouldRun ? describe : describe.skip;

describeE2E('/plan-design-review AskUserQuestion floor (gate)', () => {
  test(
    'seeded forcing finding causes the agent to fire at least one AskUserQuestion',
    async () => {
      const obs = await runPlanSkillFloorCheck({
        skillName: 'plan-design-review',
        slashCommand: '/plan-design-review',
        followUpPrompt: FORCING_FLOOR_DESIGN,
        cwd: process.cwd(),
        timeoutMs: 600_000,
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
    660_000,
  );
});
