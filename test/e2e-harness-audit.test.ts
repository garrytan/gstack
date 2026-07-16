/**
 * E2E harness audit — every skill with `interactive: true` in its frontmatter
 * must have at least one test file that drives a real interactive session.
 * Two valid coverage paths:
 *   1. `canUseTool` via the agent-sdk-runner (legacy SDK-based path)
 *   2. `runPlanSkillObservation` via the claude-pty-runner (real-PTY path
 *      added when the SDK harness was found unable to observe plan mode's
 *      native confirmation UI — see test/helpers/claude-pty-runner.ts)
 *
 * Runs as a free unit test (no API calls). Pure filesystem scan.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const SKILL_GLOBS = [
  'plan-ceo-review',
  'plan-eng-review',
  'plan-design-review',
  'plan-devex-review',
  'office-hours',
  'codex',
  'investigate',
  'qa',
  'retro',
  'cso',
  'review',
  'ship',
  'design-review',
  'devex-review',
  'qa-only',
  'design-consultation',
  'design-shotgun',
  'autoplan',
  'land-and-deploy',
  'plan-tune',
  'document-release',
  'context-save',
  'context-restore',
  'health',
  'setup-deploy',
  'setup-browser-cookies',
  'canary',
  'learn',
  'benchmark',
  'benchmark-models',
  'make-pdf',
  'open-gstack-browser',
  'gstack-upgrade',
  'pair-agent',
  'design-html',
  'freeze',
  'unfreeze',
  'careful',
  'guard',
];

/**
 * Load .tmpl files for each skill and return the names of those that have
 * `interactive: true` in frontmatter.
 */
function findInteractiveSkills(): string[] {
  const interactive: string[] = [];
  for (const skill of SKILL_GLOBS) {
    const tmplPath = path.join(ROOT, skill, 'SKILL.md.tmpl');
    if (!fs.existsSync(tmplPath)) continue;
    const content = fs.readFileSync(tmplPath, 'utf-8');
    // Frontmatter lives between the first '---' and the next '---'.
    const fmEnd = content.indexOf('\n---', 4);
    if (fmEnd < 0) continue;
    const frontmatter = content.slice(0, fmEnd);
    if (/^interactive:\s*true\s*$/m.test(frontmatter)) {
      interactive.push(skill);
    }
  }
  return interactive;
}

/**
 * Scan a test file's contents for any of the supported real-interactive
 * coverage patterns. Either: direct canUseTool usage in runAgentSdkTest,
 * the legacy plan-mode-helpers wrapper, or the new real-PTY observation
 * helper.
 */
function hasCanUseToolCoverage(testFile: string): boolean {
  const content = fs.readFileSync(testFile, 'utf-8');
  if (content.includes('canUseTool')) return true;
  if (content.includes('runPlanModeSkillTest')) return true;
  if (content.includes('runPlanSkillObservation')) return true;
  return false;
}

describe('E2E harness audit — interactive skills must have canUseTool coverage', () => {
  test('every interactive: true skill has at least one canUseTool test', () => {
    const interactive = findInteractiveSkills();
    expect(interactive.length).toBeGreaterThan(0);

    const testFiles = fs
      .readdirSync(path.join(ROOT, 'test'))
      .filter((f) => f.startsWith('skill-e2e-') && f.endsWith('.test.ts'))
      .map((f) => path.join(ROOT, 'test', f));

    const filesWithCoverage = testFiles.filter(hasCanUseToolCoverage);

    for (const skill of interactive) {
      // Match the skill name in any test file that uses canUseTool. File
      // naming convention is `skill-e2e-<skill>-*.test.ts` — either the full
      // name (plan-ceo-review) or a subset token.
      const hasDedicatedTest = filesWithCoverage.some((f) => {
        const base = path.basename(f, '.test.ts');
        return base.includes(skill) || base.includes(skill.replace(/-review$/, ''));
      });
      expect(hasDedicatedTest, `skill "${skill}" has interactive:true but no canUseTool-based E2E test`).toBe(true);
    }
  });
});
