import type { TemplateContext } from './types';

/**
 * QA_FIX_LOOP_HEAD — Phase 8a/8b/8c framing shared by /qa and /qa-headless.
 *
 * Skill templates inject a re-test step (8d) after this resolver, then follow
 * with QA_FIX_LOOP_TAIL for classify/regression/self-regulate.
 *
 * Args (optional): [skill_name, report_path]
 *   - skill_name defaults to "qa" (used in commit messages: "fix(qa): ...")
 */
export function generateQAFixLoopHead(_ctx: TemplateContext, args?: string[]): string {
  const skillName = args?.[0] ?? 'qa';
  return _generateHead(skillName);
}

function _generateHead(skillName: string): string {
  return `### 8a. Locate source

\`\`\`bash
# Grep for error messages, function names, route definitions, file patterns
# matching the affected behavior
\`\`\`

- Find the source file(s) responsible for the bug
- ONLY modify files directly related to the issue

### 8b. Fix

- Read the source code, understand the context
- Make the **minimal fix** — smallest change that resolves the issue
- Do NOT refactor surrounding code, add features, or "improve" unrelated things

### 8c. Commit

\`\`\`bash
git add <only-changed-files>
git commit -m "fix(${skillName}): ISSUE-NNN — short description"
\`\`\`

- One commit per fix. Never bundle multiple fixes.
- Message format: \`fix(${skillName}): ISSUE-NNN — short description\``;
}

/**
 * QA_FIX_LOOP_TAIL — Phase 8e/8e.5/8f framing shared by /qa and /qa-headless.
 *
 * Comes after the skill-specific re-test step. Covers classification,
 * regression test generation, and the WTF self-regulation heuristic.
 *
 * Args (optional): [skill_name]
 *   - skill_name defaults to "qa". Report-path is hardcoded per skill below
 *     because the {domain}/{date} braces inside the path string would break
 *     the {{NAME:arg}} placeholder parser.
 */
export function generateQAFixLoopTail(_ctx: TemplateContext, args?: string[]): string {
  const skillName = args?.[0] ?? 'qa';
  const reportPath = skillName === 'qa-headless'
    ? '.gstack/qa-headless-reports/qa-headless-report-{feature}-{date}.md'
    : '.gstack/qa-reports/qa-report-{domain}-{date}.md';
  return _generateTail(skillName, reportPath);
}

function _generateTail(skillName: string, reportPath: string): string {
  return `### 8e. Classify

- **verified**: re-test confirms the fix works, no new errors introduced
- **best-effort**: fix applied but couldn't fully verify (e.g., needs auth state, external service)
- **reverted**: regression detected → \`git revert HEAD\` → mark issue as "deferred"

### 8e.5. Regression Test

Skip if: classification is not "verified", OR the fix is purely cosmetic with no behavioral change, OR no test framework was detected AND user declined bootstrap.

**1. Study the project's existing test patterns:**

Read 2-3 test files closest to the fix (same directory, same code type). Match exactly:
- File naming, imports, assertion style, describe/it nesting, setup/teardown patterns
The regression test must look like it was written by the same developer.

**2. Trace the bug's codepath, then write a regression test:**

Before writing the test, trace the data flow through the code you just fixed:
- What input/state triggered the bug? (the exact precondition)
- What codepath did it follow? (which branches, which function calls)
- Where did it break? (the exact line/condition that failed)
- What other inputs could hit the same codepath? (edge cases around the fix)

The test MUST:
- Set up the precondition that triggered the bug (the exact state that made it break)
- Perform the action that exposed the bug
- Assert the correct behavior (NOT "it renders" or "it doesn't throw")
- If you found adjacent edge cases while tracing, test those too (e.g., null input, empty array, boundary value)
- Include full attribution comment:
  \`\`\`
  // Regression: ISSUE-NNN — {what broke}
  // Found by /${skillName} on {YYYY-MM-DD}
  // Report: ${reportPath}
  \`\`\`

Generate unit tests. Mock all external dependencies (DB, API, Redis, file system).

Use auto-incrementing names to avoid collisions: check existing \`{name}.regression-*.test.{ext}\` files, take max number + 1.

**3. Run only the new test file:**

\`\`\`bash
{detected test command} {new-test-file}
\`\`\`

**4. Evaluate:**
- Passes → commit: \`git commit -m "test(${skillName}): regression test for ISSUE-NNN — {desc}"\`
- Fails → fix test once. Still failing → delete test, defer.
- Taking >2 min exploration → skip and defer.

**5. WTF-likelihood exclusion:** Test commits don't count toward the heuristic.

### 8f. Self-Regulation (STOP AND EVALUATE)

Every 5 fixes (or after any revert), compute the WTF-likelihood:

\`\`\`
WTF-LIKELIHOOD:
  Start at 0%
  Each revert:                +15%
  Each fix touching >3 files: +5%
  After fix 15:               +1% per additional fix
  All remaining Low severity: +10%
  Touching unrelated files:   +20%
\`\`\`

**If WTF > 20%:** STOP immediately. Show the user what you've done so far. Ask whether to continue.

**Hard cap: 50 fixes.** After 50 fixes, stop regardless of remaining issues.`;
}
