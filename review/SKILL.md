---
name: review
version: 1.0.0
description: |
  Pre-landing PR review. Analyzes diff against the base branch for data mutation safety, LLM trust
  boundary violations, conditional side effects, and other structural issues.
allowed-tools:
  - Bash
  - Read
  - Edit
  - Write
  - Grep
  - Glob
  - AskUserQuestion
  - mcp__serena__activate_project
  - mcp__serena__get_symbols_overview
  - mcp__serena__find_symbol
  - mcp__serena__find_referencing_symbols
  - mcp__serena__search_for_pattern
---
<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->

## AskUserQuestion Format

**ALWAYS follow this structure for every AskUserQuestion call:**
1. **Re-ground:** State the project, the current branch, and the current plan/task. (1-2 sentences)
2. **Simplify:** Explain the problem in plain English a smart 16-year-old could follow. No raw function names, no internal jargon, no implementation details. Use concrete examples and analogies. Say what it DOES, not what it's called.
3. **Recommend:** \`RECOMMENDATION: Choose [X] because [one-line reason]\`
4. **Options:** Lettered options: \`A) ... B) ... C) ...\`

Assume the user hasn't looked at this window in 20 minutes and doesn't have the code open. If you'd need to read the source to understand your own explanation, it's too complex.

Per-skill instructions may add additional formatting rules on top of this baseline.

## Serena Code Navigation (optional, reduces token usage)

If Serena MCP tools are available (`mcp__serena__*`), prefer them for code lookup tasks.
They provide symbol-level precision that avoids reading entire files.

**Activation (run once at start):**
Try `mcp__serena__activate_project` with the repo root path. If it succeeds, Serena
is active. If it fails or the tool is unavailable, skip all Serena tools and use
Grep + Read instead.

**If activation succeeds but symbol lookups return empty results:** Run
`mcp__serena__onboarding` once — Serena needs a one-time index build per project.

**When Serena is active, prefer these patterns:**

| Task | Without Serena | With Serena |
|------|---------------|-------------|
| Understand file structure | Read the whole file | `get_symbols_overview` (~90% fewer tokens) |
| Find where a symbol is used | Grep for name → Read each file | `find_referencing_symbols` (returns snippets only) |
| Read a specific function | Read the whole file | `find_symbol` with `include_body=true` |
| Search for a pattern | Grep | `search_for_pattern` (equivalent) |

**Fallback rule:** If any Serena tool call fails, fall back to Grep + Read for that
operation. Do not retry — switch immediately.

## Step 0: Detect base branch

Determine which branch this PR targets. Use the result as "the base branch" in all subsequent steps.

1. Check if a PR already exists for this branch:
   `gh pr view --json baseRefName -q .baseRefName`
   If this succeeds, use the printed branch name as the base branch.

2. If no PR exists (command fails), detect the repo's default branch:
   `gh repo view --json defaultBranchRef -q .defaultBranchRef.name`

3. If both commands fail, fall back to `main`.

Print the detected base branch name. In every subsequent `git diff`, `git log`,
`git fetch`, `git merge`, and `gh pr create` command, substitute the detected
branch name wherever the instructions say "the base branch."

---

# Pre-Landing PR Review

You are running the `/review` workflow. Analyze the current branch's diff against the base branch for structural issues that tests don't catch.

---

## Step 1: Check branch

1. Run `git branch --show-current` to get the current branch.
2. If on the base branch, output: **"Nothing to review — you're on the base branch or have no changes against it."** and stop.
3. Run `git fetch origin <base> --quiet && git diff origin/<base> --stat` to check if there's a diff. If no diff, output the same message and stop.

---

## Step 2: Read the checklist

Read `.claude/skills/review/checklist.md`.

**If the file cannot be read, STOP and report the error.** Do not proceed without the checklist.

---

## Step 2.5: Check for Greptile review comments

Read `.claude/skills/review/greptile-triage.md` and follow the fetch, filter, classify, and **escalation detection** steps.

**If no PR exists, `gh` fails, API returns an error, or there are zero Greptile comments:** Skip this step silently. Greptile integration is additive — the review works without it.

**If Greptile comments are found:** Store the classifications (VALID & ACTIONABLE, VALID BUT ALREADY FIXED, FALSE POSITIVE, SUPPRESSED) — you will need them in Step 5.

---

## Step 3: Get the diff

Fetch the latest base branch to avoid false positives from stale local state:

```bash
git fetch origin <base> --quiet
```

Run `git diff origin/<base>` to get the full diff. This includes both committed and uncommitted changes against the latest base branch.

---

## Step 4: Two-pass review

Apply the checklist against the diff in two passes:

1. **Pass 1 (CRITICAL):** Data Mutation Safety, Race Conditions & Concurrency, LLM Output Trust Boundary, Enum & Value Completeness
2. **Pass 2 (INFORMATIONAL):** Conditional Side Effects, Magic Numbers & String Coupling, Dead Code & Consistency, LLM Prompt Issues, Test Gaps, Component/Frontend

**Enum & Value Completeness requires reading code OUTSIDE the diff.** When the diff introduces a new enum value, status, tier, or type constant, use Grep to find all components, hooks, services, and utils that reference sibling values, then Read those files to check if the new value is handled. This is the one category where within-diff review is insufficient.

Follow the output format specified in the checklist. Respect the suppressions — do NOT flag items listed in the "DO NOT flag" section.

---

## Step 5: Output findings

**Always output ALL findings** — both critical and informational. The user must see every issue.

- If CRITICAL issues found: output all findings, then for EACH critical issue use a separate AskUserQuestion with the problem, then `RECOMMENDATION: Choose A because [one-line reason]`, then options (A: Fix it now, B: Acknowledge, C: False positive — skip).
  After all critical questions are answered, output a summary of what the user chose for each issue. If the user chose A (fix) on any issue, apply the recommended fixes. If only B/C were chosen, no action needed.
- If only non-critical issues found: output findings. No further action needed.
- If no issues found: output `Pre-Landing Review: No issues found.`

### Greptile comment resolution

After outputting your own findings, if Greptile comments were classified in Step 2.5:

**Include a Greptile summary in your output header:** `+ N Greptile comments (X valid, Y fixed, Z FP)`

Before replying to any comment, run the **Escalation Detection** algorithm from greptile-triage.md to determine whether to use Tier 1 (friendly) or Tier 2 (firm) reply templates.

1. **VALID & ACTIONABLE comments:** These are already included in your CRITICAL findings — they follow the same AskUserQuestion flow (A: Fix it now, B: Acknowledge, C: False positive). If the user chooses A (fix), reply using the **Fix reply template** from greptile-triage.md (include inline diff + explanation). If the user chooses C (false positive), reply using the **False Positive reply template** (include evidence + suggested re-rank), save to both per-project and global greptile-history.

2. **FALSE POSITIVE comments:** Present each one via AskUserQuestion:
   - Show the Greptile comment: file:line (or [top-level]) + body summary + permalink URL
   - Explain concisely why it's a false positive
   - Options:
     - A) Reply to Greptile explaining why this is incorrect (recommended if clearly wrong)
     - B) Fix it anyway (if low-effort and harmless)
     - C) Ignore — don't reply, don't fix

   If the user chooses A, reply using the **False Positive reply template** from greptile-triage.md (include evidence + suggested re-rank), save to both per-project and global greptile-history.

3. **VALID BUT ALREADY FIXED comments:** Reply using the **Already Fixed reply template** from greptile-triage.md — no AskUserQuestion needed:
   - Include what was done and the fixing commit SHA
   - Save to both per-project and global greptile-history

4. **SUPPRESSED comments:** Skip silently — these are known false positives from previous triage.

---

## Step 5.5: TODOS cross-reference

Read `TODOS.md` in the repository root (if it exists). Cross-reference the PR against open TODOs:

- **Does this PR close any open TODOs?** If yes, note which items in your output: "This PR addresses TODO: <title>"
- **Does this PR create work that should become a TODO?** If yes, flag it as an informational finding.
- **Are there related TODOs that provide context for this review?** If yes, reference them when discussing related findings.

If TODOS.md doesn't exist, skip this step silently.

---

## Step 5.6: Documentation staleness check

Cross-reference the diff against documentation files. For each `.md` file in the repo root (README.md, ARCHITECTURE.md, CONTRIBUTING.md, CLAUDE.md, etc.):

1. Check if code changes in the diff affect features, components, or workflows described in that doc file.
2. If the doc file was NOT updated in this branch but the code it describes WAS changed, flag it as an INFORMATIONAL finding:
   "Documentation may be stale: [file] describes [feature/component] but code changed in this branch. Consider running `/document-release`."

This is informational only — never critical. The fix action is `/document-release`.

If no documentation files exist, skip this step silently.

---

## Important Rules

- **Read the FULL diff before commenting.** Do not flag issues already addressed in the diff.
- **Read-only by default.** Only modify files if the user explicitly chooses "Fix it now" on a critical issue. Never commit, push, or create PRs.
- **Be terse.** One line problem, one line fix. No preamble.
- **Only flag real problems.** Skip anything that's fine.
- **Use Greptile reply templates from greptile-triage.md.** Every reply includes evidence. Never post vague replies.
