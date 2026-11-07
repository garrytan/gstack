/**
 * /plan-design-review AskUserQuestion floor regression (periodic, paid, real-PTY).
 *
 * Contract: a seeded forcing finding must fire at least one AskUserQuestion
 * before the review writes its plan or exits plan mode (the /plan-eng-review
 * floor that first pinned it retired with that skill, GST-1698).
 */

import { test } from 'bun:test';
import { CAPTURE_LONG_MS, PTY_MS } from './helpers/eval-budgets';
import { describeE2ETier } from './helpers/e2e-gate';
import { runPlanSkillFloorCheck } from './helpers/claude-pty-runner';
import { FORCING_FLOOR_DESIGN } from './fixtures/forcing-finding-seeds';
import { pickDesignFocusAll } from './fixtures/design-floor-focus-picker';
import { seedPlanReviewProject } from './helpers/ceo-finding-fixture';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const describeE2E = describeE2ETier('periodic');

describeE2E('/plan-design-review AskUserQuestion floor (periodic)', () => {
  test(
    'seeded forcing finding causes the agent to fire at least one AskUserQuestion',
    async () => {
      const project = fs.mkdtempSync(path.join(os.tmpdir(), 'design-floor-project-'));
      try {
        // The target must exist before preamble/scope selection, even while
        // the existing follow-up message is queued behind the skill startup.
        seedPlanReviewProject(project, FORCING_FLOOR_DESIGN, 'plan-design-review');
        const obs = await runPlanSkillFloorCheck({
          skillName: 'plan-design-review',
          slashCommand: '/plan-design-review',
          followUpPrompt: FORCING_FLOOR_DESIGN,
        requestedPlanPath: '/tmp/gstack-test-plan-design-floor.md',
          cwd: project,
          timeoutMs: CAPTURE_LONG_MS,
          env: { QUESTION_TUNING: 'false', EXPLAIN_LEVEL: 'default' },
          pickSetupChoice: pickDesignFocusAll,
        });

        if (obs.outcome !== 'auq_observed') {
          throw new Error(
            `floor test FAILED: outcome=${obs.outcome} elapsed=${obs.elapsedMs}ms\n` +
              `summary: ${obs.summary}\n` +
              `--- evidence (last 3KB) ---\n${obs.evidence}`,
          );
        }
      } finally {
        try { fs.rmSync(project, { recursive: true, force: true }); } catch { /* preserve the observation failure */ }
      }
    },
    PTY_MS,
  );
});
