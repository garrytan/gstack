
import { FREE_TEXT_WRITE_RULE, freeTextFileBash, freeTextFileUse } from '../free-text-file';

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

Ask with AskUserQuestion in the AskUserQuestion Format. List each failure with file:line and a brief error description, say the failures appear pre-existing (not caused by this branch), and say that in a solo repo nobody else will fix them. Options, with A recommended because the context is fresh:
- A) Investigate and fix now (human: ~2-4h / CC: ~15min) — Completeness 10/10
- B) Add as P0 TODO — fix after this branch lands — Completeness 7/10
- C) Skip — I know about this, ship anyway — Completeness 3/10

**If REPO_MODE is \`collaborative\` or \`unknown\`:**

Ask with AskUserQuestion in the AskUserQuestion Format. List each failure the same way, and say that in a collaborative repo these may be someone else's responsibility. Options, with B recommended so the person who broke it fixes it:
- A) Investigate and fix now anyway — Completeness 10/10
- B) Blame + assign GitHub issue to the author — Completeness 9/10
- C) Add as P0 TODO — Completeness 7/10
- D) Skip — ship anyway — Completeness 3/10

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
  git log --format="%an (%ae)" -1 -- "<failing-test-file>"
  # Who last touched the production code the test covers? (often the actual breaker)
  git log --format="%an (%ae)" -1 -- "<source-file-under-test>"
  \`\`\`
  If these are different people, prefer the production code author — they likely introduced the regression.
- Create an issue assigned to that person. Its title and body carry test names and error output, so they travel as files, never inside a command:

\`\`\`bash
${freeTextFileBash([{ variable: 'TITLE_FILE', stem: 'issue-title' }, { variable: 'BODY_FILE', stem: 'issue-body' }])}
\`\`\`

${FREE_TEXT_WRITE_RULE} Title file: \`Pre-existing test failure: <test name>\`. Body file (Markdown; the error goes in a \`~~~\` fence so backticks in it stay literal):

\`\`\`text
Failing on <current branch>; pre-existing.

**Error:**
~~~
<first 10 lines of the failure>
~~~

**Last modified by:** <author>
**Noticed by:** gstack /ship on <date>
\`\`\`

Then post with your platform from Step 0 (\`github\` or \`gitlab\`). Substitute the two printed names, and an assignee only when it is a valid login for that platform (GitHub: letters, digits and single hyphens, at most 39 characters); otherwise drop the assignee flag and name the person in the body.

\`\`\`bash
${freeTextFileUse([{ variable: 'TITLE_FILE', placeholder: '<title-file-name>' }, { variable: 'BODY_FILE', placeholder: '<body-file-name>' }], 'gh issue create --title \\"\\$(cat $TITLE_FILE)\\" --body-file $BODY_FILE')}
case "<platform>" in
  github) gh issue create --title "$(cat "$TITLE_FILE")" --body-file "$BODY_FILE" --assignee "<github-username>" ;;
  gitlab) glab issue create -t "$(cat "$TITLE_FILE")" -d "$(cat "$BODY_FILE")" -a "<gitlab-username>" ;;
  *) echo "Not sent: no GitHub or GitLab remote. Files: $TITLE_FILE $BODY_FILE" >&2; false ;;
esac && rm -f "$TITLE_FILE" "$BODY_FILE"
\`\`\`

- If neither CLI is available or \`--assignee\`/\`-a\` fails (user not in org, etc.), create the issue without assignee and note who should look at it in the body.
- Continue with the workflow.

**If "Skip":**
- Continue with the workflow.
- Note in output: "Pre-existing test failure skipped: <test-name>"`;
}

