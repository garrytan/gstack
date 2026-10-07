<!-- AUTO-GENERATED from greptile-early.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
## Step 6.5: Early Greptile PR (after the free tests pass)

When the repo uses Greptile, push and open the PR now so Greptile reviews while
Steps 7–9 run; Step 10 collects its comments. Without Greptile nothing changes.

```bash
~/.claude/skills/gstack/bin/gstack-greptile-early detect
```

- **`GREPTILE_EARLY: off`** — print the reason (and any turn-back-on line) and continue to Step 7.
- **`GREPTILE_EARLY: ask`** (a public repo, or unknown visibility, the first time) — AskUserQuestion:
  > This repo is public. Early Greptile review pushes this branch and opens a draft PR
  > before /ship's own review, so the code is visible before that review finishes. If
  > /ship stops later, the draft stays up with a comment saying why.

  A) Push early for this repo (remembered) · B) Keep today's order for this repo (remembered).
  Run `~/.claude/skills/gstack/bin/gstack-greptile-early consent yes` (A) or `consent no` (B).
  B continues to Step 7.
- **`GREPTILE_EARLY: on`**, or after A — show the user the printed `Greptile: found …` line, then follow 1-3 below.

**1.** Push: `git push -u origin <branch-name>`. If it fails, record
"Greptile early review: not run (push failed)" and continue to Step 7; Step 17 pushes later.

**2.** Write a provisional `<type>: <summary>` title (Step 18 replaces it) into a private file:

```bash
_GT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)/.gstack/tmp"
mkdir -p "$_GT" && chmod 700 "$_GT" || { echo "Not sent: cannot create $_GT for the text file." >&2; exit 1; }
_EX=$(git rev-parse --git-path info/exclude 2>/dev/null) && mkdir -p "$(dirname "$_EX")" && { grep -qxF '/.gstack/tmp/' "$_EX" 2>/dev/null || echo '/.gstack/tmp/' >> "$_EX"; }
TITLE_FILE=$(mktemp "${_GT:?}/early-title.XXXXXX") || { echo "Not sent: mktemp failed in $_GT." >&2; exit 1; }; echo "TITLE_FILE: $TITLE_FILE (name: ${TITLE_FILE##*/})"
```

Write the text into each printed file with your file-write tool (Claude Code's Write tool needs a Read of the empty file first), exactly as it should appear. The text never goes into a shell command, heredoc or quoted argument. If a write fails or is refused, do not send: print the cause, the file path and the command below for sending by hand.

**3.** Open the draft, substituting the printed name. Add `--ready` only when the user asked
for a non-draft PR:

```bash
TITLE_FILE="$(git rev-parse --show-toplevel 2>/dev/null || pwd)/.gstack/tmp/<title-file-name>"
~/.claude/skills/gstack/bin/gstack-greptile-early open --base <base> --title-file "$TITLE_FILE"
```

It opens the PR through `gstack-post` with a body saying /ship opened it early, and
posts one `@greptileai` comment when Greptile skips drafts. Save the printed
`EARLY_PR` and `EARLY_PR_OPENED_AT` in the invocation record. `EARLY_PR: none` means a
PR was already open: Step 10 triages it as before. Exit 1 or 2 means `gstack-post`
flagged the provisional title: write a plainer one and rerun. Exit 3: record the error
and continue without early review.

**If /ship stops after the early PR opened and before Step 19 publishes**, leave the
draft open (never close or force-push it) and post one comment saying /ship stopped
and why: write the reason into a private file with your file-write tool, then run
`~/.claude/skills/gstack/bin/gstack-post pr-comment <pr-number> --body-file <that file>`.

---
