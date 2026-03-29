---
name: worktree
version: 0.2.0
description: |
  Git worktree lifecycle management. Create isolated worktrees for feature
  development, merge them back, and clean up. Uses Claude Code's built-in
  EnterWorktree/ExitWorktree to actually switch the working directory.
  Use when asked to "start a worktree", "new worktree", "worktree start",
  "worktree merge", "worktree clean", or "worktree list".
allowed-tools:
  - Bash
  - Read
  - Write
  - AskUserQuestion
  - EnterWorktree
  - ExitWorktree
---

# /worktree — Git Worktree Lifecycle

Manage git worktrees for isolated feature development. Parse the argument
to determine which subcommand to run.

```bash
mkdir -p ~/.gstack/analytics
echo '{"skill":"worktree","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","repo":"'$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")'"}'  >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
```

## Subcommands

- `/worktree start <name> [--from <branch>]` — create worktree, bootstrap, switch into it
- `/worktree merge` — merge current worktree branch into base, clean up
- `/worktree clean [--force]` — remove worktree + branch without merging (refuses if unmerged commits exist unless `--force`)
- `/worktree list` — show all worktrees

If no subcommand is given, show the list above and ask what the user wants.

---

## /worktree start <name> [--from <branch>]

Create an isolated worktree and switch the session into it.

**Syntax**: `/worktree start <name>` or `/worktree start <name> --from <branch>`

### Step 1 — Gather context

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
REPO_NAME=$(basename "$REPO_ROOT")
CURRENT_BRANCH=$(git branch --show-current)
echo "repo=$REPO_ROOT name=$REPO_NAME current_branch=$CURRENT_BRANCH"
```

If `<name>` was not provided, use AskUserQuestion to ask:
"What should I name this worktree/branch? (e.g., feat-login, fix-header-bug)"

Determine the base branch:
- If the user passed `--from <branch>`, set `BASE_BRANCH` to that value.
  Verify it exists: `git rev-parse --verify <branch>`. If it doesn't exist,
  tell the user and stop.
- Otherwise, set `BASE_BRANCH` to the current branch (HEAD).

### Step 2 — Warn about base branch

**IMPORTANT**: Before creating the worktree, clearly warn the user what
branch they are branching from:

> **Base branch: `<BASE_BRANCH>`**
> The new worktree will branch off `<BASE_BRANCH>` at its current HEAD.
> `/worktree merge` will merge back into `<BASE_BRANCH>`.
>
> If this is not what you want, cancel and re-run with `--from <branch>`.

Wait for the user to acknowledge before proceeding. Use AskUserQuestion
with choices: "Yes, continue" / "No, let me pick a different base branch".

If the user picks "No", ask which branch to use and restart from Step 1.

### Step 3 — Create the worktree and switch into it

Use the **EnterWorktree** tool to create the worktree and switch the
session's working directory into it:

```
EnterWorktree(name: "<name>")
```

This creates the worktree at `.claude/worktrees/<name>/` with branch
`worktree-<name>` and **switches the session's working directory** so that
Read, Edit, Write, Glob, Grep, and Bash all operate in the worktree.

### Step 4 — Rebase onto base branch (if --from was specified)

If the user specified `--from <branch>` and it differs from the branch
that was HEAD when the worktree was created, rebase onto the target:

```bash
git rebase "<BASE_BRANCH>"
```

This ensures the worktree branch starts from the correct base, not just
wherever HEAD happened to be.

### Step 5 — Save state

Save metadata so `/worktree merge` and `/worktree clean` know the context:

```bash
STATE_DIR="$HOME/.gstack"
mkdir -p "$STATE_DIR"
cat > "$STATE_DIR/worktree-active.json" <<STATEEOF
{
  "name": "<name>",
  "branch": "worktree-<name>",
  "base_branch": "<BASE_BRANCH>",
  "repo_root": "<REPO_ROOT>",
  "worktree_path": "$(pwd)",
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
STATEEOF
cat "$STATE_DIR/worktree-active.json"
```

### Step 6 — Bootstrap

Copy untracked essentials and install dependencies. The repo root is now
the parent — use the saved `repo_root` from state:

```bash
REPO_ROOT="<repo_root from state>"

# Copy .env files if they exist in the original repo
for f in .env .env.local .env.development; do
  [ -f "$REPO_ROOT/$f" ] && cp "$REPO_ROOT/$f" "./$f" && echo "Copied $f"
done

# Install dependencies based on what exists
if [ -f "package-lock.json" ]; then
  npm install
elif [ -f "yarn.lock" ]; then
  yarn install
elif [ -f "pnpm-lock.yaml" ]; then
  pnpm install
elif [ -f "bun.lockb" ] || [ -f "bun.lock" ]; then
  bun install
elif [ -f "requirements.txt" ]; then
  pip install -r requirements.txt
elif [ -f "Pipfile.lock" ]; then
  pipenv install
elif [ -f "poetry.lock" ]; then
  poetry install
elif [ -f "Gemfile.lock" ]; then
  bundle install
fi
```

### Step 7 — Set iTerm2 tab title

Label the tab so the user can identify this worktree at a glance:

```bash
echo -ne "\033]0;worktree: <name> (claude)\007"
```

### Step 8 — Confirm to user

```bash
pwd
git status
git log --oneline -3
```

Tell the user:

> Worktree ready. You are now working in `<worktree_path>` on branch `worktree-<name>`.
> Base branch: `<BASE_BRANCH>`
>
> All file operations (Read, Edit, Write, Glob, Grep) are now targeting the worktree.
>
> When you're done:
> - `/worktree merge` — merge back to `<BASE_BRANCH>` and clean up
> - `/worktree clean` — discard and clean up

---

## /worktree merge

Merge the worktree branch back into the base branch and clean up.

### Step 1 — Read state

```bash
cat ~/.gstack/worktree-active.json
```

If no state file exists, tell the user there's no active worktree and stop.

Extract: `name`, `branch`, `base_branch`, `repo_root`, `worktree_path`.

### Step 2 — Check for uncommitted changes

```bash
git status --porcelain
```

If there are uncommitted changes, ask the user:
"There are uncommitted changes in the worktree. Should I commit them first?"

If yes, stage and commit with a descriptive message before proceeding.

### Step 3 — Exit the worktree (keep it for now)

Use **ExitWorktree** to return to the original repo directory, keeping the
worktree so we can merge its branch:

```
ExitWorktree(action: "keep")
```

This restores the session's working directory to the original repo root.

Reset the iTerm2 tab title:

```bash
REPO_NAME=$(basename "$(git rev-parse --show-toplevel)")
echo -ne "\033]0;${REPO_NAME} (claude)\007"
```

### Step 4 — Merge into base branch

```bash
git checkout "<base_branch>"
git merge "<branch>"
```

If there are merge conflicts, tell the user and help resolve them before
continuing.

### Step 5 — Clean up

Remove the worktree directory and branch now that changes are merged:

```bash
git worktree remove ".claude/worktrees/<name>"
git branch -d "<branch>"
rm -f ~/.gstack/worktree-active.json
echo "Worktree merged and cleaned up"
```

### Step 6 — Confirm

```bash
git log --oneline -5
```

Tell the user:
> Branch `<branch>` merged into `<base_branch>` and worktree removed.
> You're back in the main repo at `<repo_root>`.

---

## /worktree clean [--force]

Remove the worktree and branch without merging.

### Step 1 — Read state

```bash
cat ~/.gstack/worktree-active.json
```

If no state file exists, tell the user there's no active worktree and stop.

Extract: `name`, `branch`, `base_branch`.

### Step 2 — Check what would be lost

Check for unmerged commits and uncommitted changes:

```bash
echo "=== Unmerged commits ==="
git log "<base_branch>".."<branch>" --oneline
echo ""
echo "=== Uncommitted changes ==="
git status --porcelain
```

Count the unmerged commits:

```bash
git rev-list --count "<base_branch>".."<branch>"
```

### Step 3 — Gate on unmerged work

**If there are unmerged commits AND `--force` was NOT passed**, refuse:

> **Refusing to delete.** Branch `<branch>` has **N unmerged commit(s)**
> that would be lost:
>
> _(show the `git log --oneline` output)_
>
> To keep this work, run `/worktree merge` instead.
> To discard it, run `/worktree clean --force`.

**Stop here.** Do not proceed without `--force`.

**If there are zero unmerged commits**, or **`--force` was passed**,
continue to Step 4.

### Step 4 — Confirm with user

If `--force` was passed (i.e., there are unmerged commits being discarded),
use AskUserQuestion:

> "This will **permanently discard N commit(s)** and delete branch
> `<branch>` without merging. Proceed?"

Options: "Yes, discard and remove" / "No, merge instead"

If "No", tell the user to run `/worktree merge` and stop.

If there are zero unmerged commits (just a clean branch), use
AskUserQuestion:

> "Branch `<branch>` has no unmerged commits. Remove the worktree?"

Options: "Yes, remove it" / "No, keep working"

### Step 5 — Exit and remove

Use **ExitWorktree** to leave and remove the worktree in one step:

```
ExitWorktree(action: "remove", discard_changes: true)
```

If `ExitWorktree` reports uncommitted changes and refuses, confirm with the
user, then retry with `discard_changes: true`.

### Step 6 — Clean up branch, state, and tab title

```bash
git branch -D "worktree-<name>" 2>/dev/null || true
rm -f ~/.gstack/worktree-active.json
REPO_NAME=$(basename "$(git rev-parse --show-toplevel)")
echo -ne "\033]0;${REPO_NAME} (claude)\007"
```

Tell the user: "Worktree `<name>` removed. No changes were merged."

---

## /worktree list

Show all worktrees for the current repo.

```bash
git worktree list
```

Also check if there's an active worktree state:

```bash
[ -f ~/.gstack/worktree-active.json ] && echo "--- Active worktree ---" && cat ~/.gstack/worktree-active.json || echo "No active worktree tracked by /worktree"
```

---

## Notes

- This skill uses Claude Code's built-in `EnterWorktree` / `ExitWorktree`
  tools, which genuinely switch the session's working directory. All tools
  (Read, Edit, Write, Glob, Grep, Bash) operate in the worktree after
  `EnterWorktree` is called.
- Worktrees are created at `.claude/worktrees/<name>/` (Claude Code default).
  Add `.claude/worktrees/` to your `.gitignore`.
- Branch names follow Claude Code's convention: `worktree-<name>`.
- If `--from <branch>` is specified and differs from HEAD, a rebase is
  performed after worktree creation to start from the correct base.
- Only one worktree is tracked as "active" at a time via the state file.
- Bootstrap is best-effort — if the project needs special setup beyond
  dependency installation, tell Claude what to run after the worktree starts.
- On `/worktree merge`, the skill exits the worktree first (keeping it),
  merges the branch, then cleans up. This ensures you're back in the main
  repo with the merge complete.
