/**
 * /plan-devex-review AskUserQuestion floor regression (gate, paid, real-PTY).
 *
 * See test/skill-e2e-plan-eng-finding-floor.test.ts for the contract.
 */

import { test } from 'bun:test';
import { CAPTURE_LONG_MS, PTY_MS } from './helpers/eval-budgets';
import { describeE2ETier } from './helpers/e2e-gate';
import { runPlanSkillFloorCheck } from './helpers/claude-pty-runner';
import { FORCING_FLOOR_DEVEX } from './fixtures/forcing-finding-seeds';

const describeE2E = describeE2ETier('gate');

describeE2E('/plan-devex-review AskUserQuestion floor (gate)', () => {
  test(
    'seeded forcing finding causes the agent to fire at least one AskUserQuestion',
    async () => {
      const obs = await runPlanSkillFloorCheck({
        skillName: 'plan-devex-review',
        slashCommand: '/plan-devex-review',
        followUpPrompt: FORCING_FLOOR_DEVEX,
        productType: 'sdk-documentation',
        devexSetupContext: [
          'Confirmed persona: a hands-on developer making a first SDK call.',
          'The declared onboarding facts are:',
          FORCING_FLOOR_DEVEX.split('## Onboarding flow\n')[1]!,
          'No measured turnaround, outputs, or runtime behavior were supplied. Keep predictions and unknowns labeled.',
          'This supplies persona and empathy context only; proposed fixes and scope changes remain undecided.',
        ].join(' ').replace(/\s+/g, ' '),
        requestedPlanPath: '/tmp/gstack-test-plan-devex-floor.md',
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
