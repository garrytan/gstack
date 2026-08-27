/**
 * /ship section-loading E2E (periodic, paid, SDK capture) — v2 plan T9 mitigation
 * layer 5: the behavioral guard that a real agent Reads the carved sections a
 * versionless ship requires instead of working from the skeleton's memory.
 *
 * Detection is LOSSLESS. Earlier this test drove a real PTY and scraped the ANSI
 * screen buffer for `sections/<file>.md` paths, which silently saw nothing in a
 * Conductor PTY (cursor-positioned tool renders + an unanswered question loop
 * defeat the regex — it reported `read: []` even when the agent did the work). It
 * now runs the skill through `claude -p` (the SDK path the AUQ matrix uses) and
 * detects section reads from the tool-use stream (`Read` calls whose file_path
 * contains `sections/review-army.md` / `sections/pr-body.md`).
 *
 * Hermetic, not install-mutating: the freshly-generated worktree skeleton +
 * sections are copied into a throwaway fixture dir and the absolute path is pinned,
 * so the test validates the current carve without touching the user's active
 * ~/.claude install. (Install-layout linking is covered by
 * setup-sections-linking.test.ts.)
 *
 * The agent is told AskUserQuestion is unavailable and is given the shipping
 * situation explicitly (no Bash, so it can't and needn't probe git), so it follows
 * the skeleton's STOP-Read directives for that situation. Cost: ~$1-2/run.
 * Periodic tier.
 */

import { test, expect } from 'bun:test';
import { describeE2ETier } from './helpers/e2e-gate';
import {
  setupSkillDir,
  skillFromWorktree,
  captureSectionReads,
} from './helpers/auq-sdk-capture';

const describeE2E = describeE2ETier('periodic');
const runId = `ship-section-loading-${process.env.EVALS_RUN_ID ?? 'local'}`;

// Sections this review-and-PR scenario must consult.
const REQUIRED_SECTIONS = ['review-army.md', 'pr-body.md'];

const FIXTURES: Record<string, string> = {
  'app.js': '// base\nexport function newThing() { return 42; }\n',
  'app.test.js': 'test("newThing", () => {});\n',
};

describeE2E('/ship section-loading E2E (periodic, SDK capture)', () => {
  test(
    'versionless ship Reads the required review and PR sections',
    async () => {
      const { skillMd, sectionsFrom } = skillFromWorktree('ship');
      const planDir = setupSkillDir({
        skillName: 'ship',
        skillMd,
        sectionsFrom,
        fixtures: FIXTURES,
        tmpPrefix: 'gstack-ship-secload-',
      });

      const { readSections, reportProduced, output } = await captureSectionReads({
        planDir,
        skillName: 'ship',
        scenario:
          'This branch has a real code change (app.js gained a new function with a test). Follow the skill\'s versionless flow: run the pre-landing review and prepare a Conventional Commit-style title and body for a ready-for-review PR. Produce the ship plan / review report. Do NOT actually commit, push, or open a PR.',
        requiredSections: REQUIRED_SECTIONS,
        reportMarker: /title|pull request|review|ship/i,
        testName: 'ship-section-loading',
        runId,
      });

      const missing = REQUIRED_SECTIONS.filter(s => !readSections.has(s));
      expect({ reportProduced, read: [...readSections], missing }).toEqual({
        reportProduced: true,
        read: expect.any(Array),
        missing: [],
      });
      // Guard against an empty pass: the report must have real content.
      expect(output.trim().length).toBeGreaterThan(200);
    },
    360_000,
  );
});
