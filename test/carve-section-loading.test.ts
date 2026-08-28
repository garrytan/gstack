/**
 * T2 — data-driven behavioral section-loading guard (PERIODIC tier, paid, SDK capture).
 *
 * The behavioral proof that a REAL agent actually Reads each carved skill's
 * required sections at runtime — not just that the skeleton structure looks right
 * (that's E2, free, per-PR). One file iterating the canonical CARVE_GUARDS
 * registry (EQ2): registry membership IS the test, so "registered ⇒ asserted" is
 * structural — a carve can't be registered yet behaviorally unguarded.
 *
 * Per codex refined-plan pass:
 *   #2 — ONE test() per skill, each with its own timeout + named failure output;
 *        a hung claude -p fails only its skill, not the whole file.
 *   #3 / D-CODEX(A) — GSTACK_CARVE_SKILL=<name> runs only that skill's case, so
 *        the touchfile selector can scope cost to the changed skill; unset runs all.
 *   #7 — each case drives the run with the registry's `scenario` (built to force
 *        the STOP-Read path) and asserts the required sections were Read.
 *
 * 'external' skills (ship, plan-ceo-review) have bespoke fixtures (git state,
 * Step-0 mode loop) and keep their dedicated tests; E1 asserts those exist.
 */

import { test, expect } from 'bun:test';
import { describeE2ETier } from './helpers/e2e-gate';
import { setupSkillDir, skillFromWorktree, captureSectionReads } from './helpers/auq-sdk-capture';
import { CARVE_GUARDS } from './helpers/carve-guards';

const describeE2E = describeE2ETier('periodic');
const runId = `carve-section-loading-${process.env.EVALS_RUN_ID ?? 'local'}`;
const only = process.env.GSTACK_CARVE_SKILL?.trim();

// A generic plan fixture for 'plan' behavioral skills (the review family).
const PLAN_MD = [
  '# Plan: add an in-memory cache layer',
  '',
  '## Context',
  'Reads hit the DB on every request. Add a process-local LRU cache in front of the',
  'read path to cut DB load.',
  '',
  '## Approach',
  '- Wrap the read repository in a cache that stores the last 1000 keys.',
  '- Invalidate on write.',
  '',
  '## Out of scope',
  'Distributed cache, cross-process coherence.',
  '',
].join('\n');

describeE2E('carve behavioral section-loading (periodic, SDK capture)', () => {
  for (const guard of Object.values(CARVE_GUARDS)) {
    // 'external' carves keep their dedicated bespoke tests (E1 verifies those exist).
    if (guard.behavioral === 'external') continue;
    // Cost-scoped selection: when GSTACK_CARVE_SKILL is set, run only that skill.
    if (only && only !== guard.skill) continue;

    test(
      `${guard.skill}: a real run Reads ${guard.requiredReads.join(', ')}`,
      async () => {
        const { skillMd, sectionsFrom } = skillFromWorktree(guard.skill);
        const fixtures = guard.behavioral === 'plan' ? { 'PLAN.md': PLAN_MD } : {};
        const planDir = setupSkillDir({
          skillName: guard.skill,
          skillMd,
          sectionsFrom,
          fixtures,
          tmpPrefix: `gstack-${guard.skill}-secload-`,
        });

        const { readSections, reportProduced, output } = await captureSectionReads({
          planDir,
          skillName: guard.skill,
          scenario: guard.scenario,
          reportMarker: /report|review|summary|design doc|handoff/i,
          testName: `${guard.skill} section-loading`,
          runId,
          // 480s, not the helper's 300s default: the heavy full-workflow
          // scenarios (plan-eng-review, office-hours, design-html) satisfy
          // their required section reads inside 60s but need 300-450s of
          // wall clock to finish the report on slower sandboxes — a timeout
          // there reads as a loading failure when the carve invariant held.
          timeout: 480_000,
        });

        const missing = guard.requiredReads.filter((s) => !readSections.has(s));
        // Named failure output (codex #2): skill + expected + observed.
        expect({
          skill: guard.skill,
          reportProduced,
          expected: guard.requiredReads,
          observed: [...readSections],
          missing,
        }).toEqual({
          skill: guard.skill,
          reportProduced: true,
          expected: guard.requiredReads,
          observed: expect.any(Array),
          missing: [],
        });
        expect(output.trim().length).toBeGreaterThan(200);
      },
      540_000,
    );
  }
});
