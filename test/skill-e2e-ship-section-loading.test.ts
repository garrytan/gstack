/**
 * /ship section-loading E2E (periodic, paid, SDK capture) — v2 plan T9 mitigation
 * layer 5: the behavioral guard that a real agent Reads the carved sections a
 * version-changing ship requires instead of working from the skeleton's memory.
 *
 * Detection is LOSSLESS. Earlier this test drove a real PTY and scraped the ANSI
 * screen buffer for `sections/<file>.md` paths, which silently saw nothing in a
 * Conductor PTY (cursor-positioned tool renders + an unanswered question loop
 * defeat the regex — it reported `read: []` even when the agent did the work). It
 * now runs the skill through `claude -p` (the SDK path the AUQ matrix uses) and
 * detects section reads from the tool-use stream (`Read` calls whose file_path
 * contains `sections/review-army.md` / `sections/changelog.md`).
 *
 * Hermetic, not install-mutating: the freshly-generated worktree skeleton +
 * sections are copied into a throwaway fixture dir and the absolute path is pinned,
 * so the test validates the current carve without touching the user's active
 * ~/.claude install. (Install-layout linking is covered by
 * setup-sections-linking.test.ts.)
 *
 * The fixture supplies a real version-changing branch. Read-only git inspection
 * and the local test command are available; commits, pushes and PR creation stay
 * prohibited. The agent follows the skeleton's STOP-Read directives. Cost: ~$1-2/run.
 * Periodic tier.
 */

import { test, expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CAPTURE_LONG_MS } from './helpers/eval-budgets';
import { describeE2ETier } from './helpers/e2e-gate';
import {
  setupSkillDir,
  skillFromWorktree,
  captureSectionReads,
} from './helpers/auq-sdk-capture';

const describeE2E = describeE2ETier('periodic');
const runId = `ship-section-loading-${process.env.EVALS_RUN_ID ?? 'local'}`;

// Sections every version-changing ship must consult.
const REQUIRED_SECTIONS = ['review-army.md', 'changelog.md'];

const FIXTURES: Record<string, string> = {
  VERSION: '0.0.1\n',
  'package.json': JSON.stringify({ name: 'fx', version: '0.0.1', private: true, type: 'module', scripts: { test: 'bun test' } }, null, 2) + '\n',
  'CHANGELOG.md': '# Changelog\n\n## [0.0.1] - 2026-01-01\n\n- Initial release\n',
  'app.js': '// base\n',
  'app.test.js': '// Regression tests accompany new application behavior.\n',
};

describeE2E('/ship section-loading E2E (periodic, SDK capture)', () => {
  test(
    'fresh version-changing ship Reads the required sections',
    async () => {
      const { skillMd, sectionsFrom } = skillFromWorktree('ship');
      const planDir = setupSkillDir({
        skillName: 'ship',
        skillMd,
        sectionsFrom,
        fixtures: FIXTURES,
        tmpPrefix: 'gstack-ship-secload-',
      });
      // The declared version-changing branch must exist before the review.
      // Keep the version at its base value and commit only the behavior/test.
      const git = (...args: string[]) => execFileSync('git', args, { cwd: planDir, stdio: 'pipe', timeout: 5000 });
      git('update-ref', 'refs/remotes/origin/main', 'HEAD');
      git('checkout', '-b', 'ship-section-fixture');
      fs.writeFileSync(path.join(planDir, 'app.js'), '// base\nexport function newThing() { return 42; }\n');
      fs.writeFileSync(path.join(planDir, 'app.test.js'),
        'import { test, expect } from "bun:test";\nimport { newThing } from "./app.js";\ntest("newThing", () => { expect(newThing()).toBe(42); });\n');
      git('add', 'app.js', 'app.test.js');
      git('commit', '-m', 'Add newThing and its regression test');

      const { readSections, reportProduced, output } = await captureSectionReads({
        planDir,
        skillName: 'ship',
        scenario:
          'This is a FRESH version-changing ship: the branch has a real code change (app.js gained a new function with a test), VERSION still equals origin/main (0.0.1, so it needs a bump), and CHANGELOG.md needs a new entry. Follow the skill\'s flow for a version-changing ship: run the pre-landing review and prepare the CHANGELOG entry. Use Read for the skill and section files. Produce the complete ship plan / review report in REPORT.md once, without repeating it in chat. Do NOT actually commit, push, or open a PR.',
        artifactCommands: 'Bash may run read-only git inspection and bun run test in this fixture. Git mutations and remote operations are prohibited; use Write/Edit for review artifacts.',
        reportMarker: /version|changelog|review|ship/i,
        testName: 'ship-section-loading',
        runId,
        // The two 300s attempts each reached report finalization at cutoff.
        // Use one 540s capture within the existing 600s outer budget, keeping
        // 60s for setup/draining instead of repeating the review startup.
        timeout: CAPTURE_LONG_MS - 60_000,
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
    { timeout: CAPTURE_LONG_MS, retry: 0 },
  );
});
