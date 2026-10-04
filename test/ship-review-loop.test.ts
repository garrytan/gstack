/**
 * /ship review fix loop stays in one invocation (#2391).
 *
 * The pre-landing review used to commit its fixes, STOP, and tell the user
 * to run /ship again — 5-10 manual invocations on a branch with a few
 * auto-fixable findings, violating the skill's fully-automated contract.
 * The rendered section must instruct a bounded in-invocation loop
 * (re-test, re-review, max 3 fix cycles) and must never terminate an
 * AUTO-FIX result with a rerun request.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { expectMentions } from './helpers/prompt-structure';

const ROOT = path.join(import.meta.dir, '..');

const RENDERED_SITES = [
  path.join(ROOT, 'ship', 'sections', 'review-army.md'),
  path.join(ROOT, 'test', 'fixtures', 'golden', 'claude-ship-SKILL.md'),
  path.join(ROOT, 'test', 'fixtures', 'golden', 'codex-ship-SKILL.md'),
  path.join(ROOT, 'test', 'fixtures', 'golden', 'factory-ship-SKILL.md'),
];

describe('/ship review fix loop (#2391)', () => {
  test('no rendered ship surface instructs a STOP-and-rerun after fixes', () => {
    // The pre-fix instruction: "then **STOP** and tell the user to run
    // `/ship` again". The fixed text mentions the phrase only inside a
    // NEVER-do-this prohibition, so match the imperative STOP shape.
    const rerunRequest = /\*\*STOP\*\*[^\n]*run `\/ship` again/;
    for (const file of RENDERED_SITES) {
      const content = fs.readFileSync(file, 'utf-8');
      expect(rerunRequest.test(content)).toBe(false);
    }
  });

  test('rendered section instructs the bounded in-invocation loop', () => {
    const content = fs.readFileSync(path.join(ROOT, 'ship/SKILL.md'), 'utf-8').replace(/\s+/g, ' ');
    const review = fs.readFileSync(path.join(ROOT, 'ship/sections/review-army.md'), 'utf-8').replace(/\s+/g, ' ');
    expect(review).toContain('**Fixes applied below the cap:** Insert Step 5');
    expectMentions(content, [['without', 'invocation', 'restarting']], 'content');
    expectMentions(review, [['do not', 'fourth', 'fixing']], 'review');
    // The loop re-runs tests AND the review, and only a converged pass continues.
    expectMentions(review, [['before', 'affected', 'pending']], 'review');
    expect(review).toContain('Every repeat starts before the checklist read and captures a fresh REVIEW_START');
    expect(review).toContain('**No edits in this pass:** Resolve the required-probe gate below. Only after it clears may you continue to Step 10');
  });

  test('the non-convergence stop is a blocker report, not a rerun request', () => {
    const content = fs.readFileSync(path.join(ROOT, 'ship/sections/review-army.md'), 'utf-8');
    expect(content).toContain('**Third fixing cycle reached (`CYCLES >= 3`):** STOP and report recurring findings');
  });
});
