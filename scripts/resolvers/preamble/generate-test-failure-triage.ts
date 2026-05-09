

export function generateTestFailureTriage(): string {
  return `## Test Failure Ownership Triage

When tests fail, do NOT immediately stop. First, determine ownership:

### Step T1: Classify each failure

For each failing test:

1. **Get the files changed on this branch:**
   \`\`\`bash
   git diff origin/<base>...HEAD --name-only
   \`\`\`

2. **Classify the failure:**
   - **In-branch** if: the failing test file itself was modified on this branch, OR the test output references code that was changed on this branch, OR you can trace the failure to a change in the branch diff.
   - **Likely pre-existing** if: neither the test file nor the code it tests was modified on this branch, AND the failure is unrelated to any branch change you can identify.
   - **When ambiguous, default to in-branch.** It is safer to stop the developer than to let a broken test ship. Only classify as pre-existing when you are confident.

   This classification is heuristic — use your judgment reading the diff and the test output. You do not have a programmatic dependency graph.

### Step T2: Handle in-branch failures

**STOP.** These are your failures. Show them and do not proceed. The developer must fix their own broken tests before shipping.

### Step T3: Handle pre-existing failures

Check \`REPO_MODE\` from the preamble output.

**If REPO_MODE is \`solo\`:**

Use AskUserQuestion:

> These test failures appear pre-existing (not caused by your branch changes):
>
> [list each failure with file:line and brief error description]
>
> Since this is a solo repo, you're the only one who will fix these.
>
> RECOMMENDATION: Choose A — fix now while the context is fresh. Completeness: 9/10.
> A) Investigate and fix now (human: ~2-4h / CC: ~15min) — Completeness: 10/10
> B) Add as P0 TODO — fix after this branch lands — Completeness: 7/10
> C) Skip — I know about this, ship anyway — Completeness: 3/10

**If REPO_MODE is \`collaborative\` or \`unknown\`:**

Use AskUserQuestion:

> These test failures appear pre-existing (not caused by your branch changes):
>
> [list each failure with file:line and brief error description]
>
> This is a collaborative repo — these may be someone else's responsibility.
>
> RECOMMENDATION: Choose B — assign it to whoever broke it so the right person fixes it. Completeness: 9/10.
> A) Investigate and fix now anyway — Completeness: 10/10
> B) Blame + assign GitHub issue to the author — Completeness: 9/10
> C) Add as P0 TODO — Completeness: 7/10
> D) Skip — ship anyway — Completeness: 3/10

### Step T4: Execute the chosen action

**If "Investigate and fix now":**
- Switch to /investigate mindset: root cause first, then minimal fix.
- Fix the pre-existing failure.
- Commit the fix separately from the branch's changes: \`git commit -m "fix: pre-existing test failure in <test-file>"\`
- Continue with the workflow.

**If "Add as P0 TODO":**
- If \`TODOS.md\` exists, add the entry following the format in \`review/TODOS-format.md\` (or \`.claude/skills/review/TODOS-format.md\`).
- If \`TODOS.md\` does not exist, create it with the standard header and add the entry.
- Entry should include: title, the error output, which branch it was noticed on, and priority P0.
- Continue with the workflow — treat the pre-existing failure as non-blocking.

**If "Blame + assign GitHub issue" (collaborative only):**
- Find who likely broke it. Check BOTH the test file AND the production code it tests:
  \`\`\`bash
  # Who last touched the failing test?
  git log --format="%an (%ae)" -1 -- <failing-test-file>
  # Who last touched the production code the test covers? (often the actual breaker)
  git log --format="%an (%ae)" -1 -- <source-file-under-test>
  \`\`\`
  If these are different people, prefer the production code author — they likely introduced the regression.
- Create an issue assigned to that person (use the platform detected in Step 0):
  - **If GitHub:**
    \`\`\`bash
    gh issue create \\
      --title "Pre-existing test failure: <test-name>" \\
      --body "Found failing on branch <current-branch>. Failure is pre-existing.\\n\\n**Error:**\\n\`\`\`\\n<first 10 lines>\\n\`\`\`\\n\\n**Last modified by:** <author>\\n**Noticed by:** gstack /ship on <date>" \\
      --assignee "<github-username>"
    \`\`\`
  - **If GitLab:**
    \`\`\`bash
    glab issue create \\
      -t "Pre-existing test failure: <test-name>" \\
      -d "Found failing on branch <current-branch>. Failure is pre-existing.\\n\\n**Error:**\\n\`\`\`\\n<first 10 lines>\\n\`\`\`\\n\\n**Last modified by:** <author>\\n**Noticed by:** gstack /ship on <date>" \\
      -a "<gitlab-username>"
    \`\`\`
- If neither CLI is available or \`--assignee\`/\`-a\` fails (user not in org, etc.), create the issue without assignee and note who should look at it in the body.
- Continue with the workflow.

**If "Skip":**
- Continue with the workflow.
- Note in output: "Pre-existing test failure skipped: <test-name>"`;
}

