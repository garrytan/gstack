---
name: spill-check
preamble-tier: 3
version: 0.1.0
description: |
  Detect scope creep mid-implementation. Compares the current diff against
  the declared PR unit in decomposition.md (from /plan-rollout). Flags
  undeclared files as spills. Adaptive: strict for code, soft for infra/meta
  files (CLAUDE.md, package.json, bun.lock, CI configs). Triggers: "check for
  spills", "am I in scope", "verify my diff", "spill check". Can also run as
  a pre-ship gate; /ship calls this automatically when a decomposition.md
  exists. (gstack)
allowed-tools:
  - Bash
  - Read
  - Edit
  - Grep
  - Glob
  - AskUserQuestion
triggers:
  - check for spills
  - spill check
  - am i in scope
  - verify my diff
  - scope check
---

<!-- PREAMBLE: auto-generated from SKILL.md.tmpl -->

## Step 0: Detect platform and base branch

Same as /ship.

## Overview

`/spill-check` answers: "am I still in scope for the PR unit I'm currently
implementing?" It reads the active `decomposition.md`, infers which PR unit the
user is working on, compares files touched vs declared, and reports spills.

Spills fall into three adaptive categories:

| Category | Example | Default action |
|----------|---------|----------------|
| Hard spill (code) | `src/billing/stripe.ts` touched, not declared | **Block** — prompt user to resolve |
| Soft spill (infra/meta) | `CLAUDE.md`, `package.json`, `bun.lock` touched | **Warn** — allow, note in output |
| Declared but untouched | Expected file not modified yet | **Info** — maybe unfinished; not a spill |

## Step 1: Discover state

```bash
_BRANCH=$(git branch --show-current)
eval "$(~/.claude/skills/gstack/bin/gstack-slug)"
_ARTIFACTS_DIR="${GSTACK_HOME:-$HOME/.gstack}/projects/$SLUG"
_DECOMP="$_ARTIFACTS_DIR/decomposition.md"

if [ ! -f "$_DECOMP" ]; then
  echo "No decomposition.md found. Run /plan-rollout first or invoke without scope enforcement."
  exit 0
fi

# Which PR unit is the user working on?
# Heuristic 1: branch name contains a unit ID (e.g., feat/auth-pr1, feat/pr2-middleware)
# Heuristic 2: ask the user explicitly
# Heuristic 3: match diff against declared files for each unit, pick best
_CURRENT_UNIT_ID=$(~/.claude/skills/gstack/lib/plan-rollout/infer-current-unit \
  --decomposition "$_DECOMP" --branch "$_BRANCH" --diff-base "origin/main")
```

If `_CURRENT_UNIT_ID` is ambiguous, use AskUserQuestion:

> "Which PR unit are you currently working on? /spill-check needs to know to
> compare your diff against the right declared scope."

Options listed from the decomposition.md (one per unit, labels with
`[unit-id] title`).

## Step 2: Compute the diff and classify

```bash
_DIFF_FILES=$(git diff --name-only \
  "$(git merge-base HEAD origin/main)" HEAD --diff-filter=ACMR)

~/.claude/skills/gstack/lib/plan-rollout/spill-classifier \
  --decomposition "$_DECOMP" \
  --current-unit "$_CURRENT_UNIT_ID" \
  --files "$_DIFF_FILES" \
  --format json > /tmp/spill-$$.json
```

Classifier output (JSON):

```json
{
  "in-scope": ["src/auth/session.ts", "src/auth/jwt.ts"],
  "hard-spills": ["src/billing/stripe.ts"],
  "soft-spills": ["CLAUDE.md", "package.json"],
  "declared-untouched": ["src/auth/tests/session.test.ts"]
}
```

## Step 3: The infra-file allowlist

Soft-spill allowlist (touchable without declaration):

- Root: `CLAUDE.md`, `.gitignore`, `.editorconfig`, `.prettierrc*`, `.eslintrc*`,
  `README.md`, `CHANGELOG.md`, `LICENSE`, `.env.example`, `VERSION`
- Package: `package.json`, `bun.lock`, `yarn.lock`, `package-lock.json`,
  `Cargo.toml`, `Cargo.lock`, `go.mod`, `go.sum`, `requirements.txt`,
  `poetry.lock`, `Gemfile`, `Gemfile.lock`
- CI: `.github/**`, `.gitlab-ci.yml`, `.circleci/**`, `azure-pipelines.yml`
- Docs: `docs/**/*.md`
- gstack artifacts: `.gstack/**`, `.claude/skills/**` (if vendored)

Anything not matching the allowlist is a hard spill.

Users can extend the allowlist per-project in
`.gstack/spill-check.yml`:

```yaml
soft-spill-allowlist:
  - "scripts/generate-*.sh"
  - "migrations/timestamps-only/*.txt"
```

## Step 4: Report and resolve

If no spills: print success, exit 0.

If soft spills only: print a one-line note per file, exit 0 (advisory).

If hard spills present: use AskUserQuestion per spill (batch up to 4):

> "Hard spill detected: `<file>` was modified but is not declared for PR unit
> `<unit-id>` (<unit title>). This is out-of-scope code that will confuse the
> reviewer and may belong in a different PR unit."
>
> RECOMMENDATION: Choose A (carve) if the change is unrelated to the current
> unit's purpose. Choose B (extend) if it's actually part of this unit and
> decomposition.md needs updating. Choose C (revert) if the change isn't
> needed at all.

Options:
- A) Carve this file to a separate branch (I'll stash the diff and leave a
     TODO) — recommended when the change is genuinely unrelated
- B) Extend decomposition.md to add this file to the current PR unit — only if
     the file genuinely belongs to this unit
- C) Revert the change to this file — if it shouldn't be in any PR
- D) Add a project-level soft-spill rule for this path (never flag again)

For A (carve):

```bash
# Stash just this file's diff into a named branch
~/.claude/skills/gstack/lib/plan-rollout/carve-spill \
  --file "<path>" \
  --source-branch "$_BRANCH" \
  --target-branch "spill/<file-slug>-$(date +%s)"
```

The `carve-spill` helper:
1. Stashes the file's uncommitted changes
2. Resets the file to its base-branch state in the current branch
3. Creates a new branch from base, applies the stash, commits
4. Prints the new branch name for the user to ship later

For B (extend):

```bash
~/.claude/skills/gstack/lib/plan-rollout/decomposition-extend \
  --decomposition "$_DECOMP" \
  --unit "$_CURRENT_UNIT_ID" \
  --add-file "<path>" \
  --reason "<user-provided>"
```

Rewrites decomposition.md adding the file to the declared unit with a note
in the `extended-on:` field for audit.

## Step 5: Optional — run as a pre-ship gate

When called by `/ship` in stack mode (automatic, not user-invoked):

- Exit 0: no hard spills, allow /ship to proceed
- Exit 1: hard spills unresolved — /ship halts, user must re-run /spill-check
  interactively

In gate mode, no AskUserQuestion; just report and exit with the right code.

## Completion Summary

```
+=============================================================+
|             /spill-check — COMPLETION SUMMARY                |
+=============================================================+
| PR unit inferred      | <unit-id> (<title>)                  |
| Files in scope        | N                                    |
| Hard spills           | N (N carved, N extended, N reverted) |
| Soft spills (warned)  | N                                    |
| Declared untouched    | N (may be incomplete work)           |
| Status                | CLEAN / RESOLVED / UNRESOLVED        |
+=============================================================+
```

## Learnings

Log any soft-spill allowlist additions the user accepts — these are
project-specific knowledge that future sessions benefit from knowing.

<!-- TELEMETRY FOOTER: auto-generated -->
