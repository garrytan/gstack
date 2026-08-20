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
    const content = fs.readFileSync(RENDERED_SITES[0], 'utf-8');
    expect(content).toContain('stay in this invocation and loop');
    expect(content).toContain('3 fix cycles');
    // The loop re-runs tests AND the review, and only a converged pass continues.
    expect(content).toContain('re-run the test suite (Step 5)');
    expect(content).toContain('re-run this review (Step 9 items 2-6)');
  });

  test('the non-convergence stop is a blocker report, not a rerun request', () => {
    const content = fs.readFileSync(RENDERED_SITES[0], 'utf-8');
    expect(content).toContain('report which findings keep reappearing');
  });
});
