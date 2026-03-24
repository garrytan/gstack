---
name: handoff
version: 1.1.0
description: |
  Structured context transfer between parallel agents. Captures decisions and
  their rationale via targeted questions, surfaces real assumptions and danger
  zones, and records open threads. Produces a handoff artifact the next agent
  loads as context, auto-injected into CLAUDE.md so it is never missed.
  Use when ending a sprint, handing work to another agent, or resuming a branch
  after a break. Proactively suggest after /ship, /retro, or long sessions.
allowed-tools:
  - Bash
  - Read
  - Write
  - Grep
  - Glob
  - AskUserQuestion
---
<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->

## Preamble (run first)

```bash
_UPD=$(~/.claude/skills/gstack/bin/gstack-update-check 2>/dev/null || .claude/skills/gstack/bin/gstack-update-check 2>/dev/null || true)
[ -n "$_UPD" ] && echo "$_UPD" || true
mkdir -p ~/.gstack/sessions
touch ~/.gstack/sessions/"$PPID"
_SESSIONS=$(find ~/.gstack/sessions -mmin -120 -type f 2>/dev/null | wc -l | tr -d ' ')
find ~/.gstack/sessions -mmin +120 -type f -delete 2>/dev/null || true
_CONTRIB=$(~/.claude/skills/gstack/bin/gstack-config get gstack_contributor 2>/dev/null || true)
_PROACTIVE=$(~/.claude/skills/gstack/bin/gstack-config get proactive 2>/dev/null || echo "true")
_BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
echo "BRANCH: $_BRANCH"
echo "PROACTIVE: $_PROACTIVE"
source <(~/.claude/skills/gstack/bin/gstack-repo-mode 2>/dev/null) || true
REPO_MODE=${REPO_MODE:-unknown}
echo "REPO_MODE: $REPO_MODE"
_LAKE_SEEN=$([ -f ~/.gstack/.completeness-intro-seen ] && echo "yes" || echo "no")
echo "LAKE_INTRO: $_LAKE_SEEN"
_TEL=$(~/.claude/skills/gstack/bin/gstack-config get telemetry 2>/dev/null || true)
_TEL_PROMPTED=$([ -f ~/.gstack/.telemetry-prompted ] && echo "yes" || echo "no")
_TEL_START=$(date +%s)
_SESSION_ID="$$-$(date +%s)"
echo "TELEMETRY: ${_TEL:-off}"
echo "TEL_PROMPTED: $_TEL_PROMPTED"
mkdir -p ~/.gstack/analytics
echo '{"skill":"handoff","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","repo":"'$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")'"}'  >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
for _PF in $(find ~/.gstack/analytics -maxdepth 1 -name '.pending-*' 2>/dev/null); do [ -f "$_PF" ] && ~/.claude/skills/gstack/bin/gstack-telemetry-log --event-type skill_run --skill _pending_finalize --outcome unknown --session-id "$_SESSION_ID" 2>/dev/null || true; break; done
```

If `PROACTIVE` is `"false"`, do not proactively suggest gstack skills.

If output shows `UPGRADE_AVAILABLE <old> <new>`: follow the inline upgrade flow. If `JUST_UPGRADED <from> <to>`: tell user "Running gstack v{to} (just updated!)" and continue.

If `LAKE_INTRO` is `no`: introduce the Completeness Principle and offer to open the essay. Touch `~/.gstack/.completeness-intro-seen`.

If `TEL_PROMPTED` is `no` AND `LAKE_INTRO` is `yes`: prompt for telemetry opt-in. Touch `~/.gstack/.telemetry-prompted`.

## AskUserQuestion Format

**ALWAYS follow this structure:**
1. **Re-ground:** State the project, current branch (use `_BRANCH` from preamble), and current task.
2. **Simplify:** Plain English a smart 16-year-old could follow.
3. **Recommend:** `RECOMMENDATION: Choose [X] because [one-line reason]` with `Completeness: X/10` per option.
4. **Options:** Lettered with effort scales: `(human: ~X / CC: ~Y)`

## Completeness Principle -- Boil the Lake

Always recommend the complete option. Show both human and CC+gstack effort estimates. Do not defer edge cases.

## Repo Ownership Mode

Solo: investigate and offer to fix proactively. Collaborative: flag via AskUserQuestion. Unknown: treat as collaborative.

## Contributor Mode

If `_CONTRIB` is `true`: file a field report to `~/.gstack/contributor-logs/{slug}.md` if something was not a 10. Max 3 per session.

## Completion Status Protocol

Report one of: **DONE**, **DONE_WITH_CONCERNS**, **BLOCKED**, **NEEDS_CONTEXT**. Escalate after 3 failed attempts.

---

# /handoff -- Agent Context Transfer

You are producing a structured handoff artifact for the next agent (or future you)
who will work on this branch. Your job is to capture what the code does not say:
decisions made and why, things assumed to be true, code that is fragile, and work
that is unfinished.

**The test:** After reading the handoff artifact, the next agent should be able to
start working in under 60 seconds without re-reading commits, grepping for context,
or asking "why was this done this way?"

---

## Step 0: Detect scope

```bash
BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
REPO=$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")
BASE=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null || echo "main")
COMMIT_COUNT=$(git rev-list --count "$BASE"..HEAD 2>/dev/null || echo "0")
DIFF_LINES=$(git diff "$BASE"..HEAD --stat 2>/dev/null | tail -1)
echo "BRANCH: $BRANCH"
echo "REPO: $REPO"
echo "BASE: $BASE"
echo "COMMITS_AHEAD: $COMMIT_COUNT"
echo "DIFF_SUMMARY: $DIFF_LINES"
git log "$BASE"..HEAD --oneline 2>/dev/null || true
```

If `COMMITS_AHEAD` is 0 and there are no uncommitted changes:

```
nothing to hand off -- no commits or changes ahead of $BASE
make some progress first, then run /handoff
```

Stop.

---

## Step 1: Ask scope

Use AskUserQuestion:

> **Branch:** `{BRANCH}` in `{REPO}` -- {N} commits ahead of {BASE}
>
> I will produce a handoff document for the next agent. How thorough?
>
> RECOMMENDATION: Choose B if you are handing off to another agent session today.
> Choose A for a quick record before a short break.
>
> A) Quick -- decisions + open threads only (Completeness: 5/10)
> (human: ~5 min / CC: ~30 sec)
>
> B) Deep -- decisions, assumptions, danger zones, open threads, and a suggested
> starting point for the next agent (Completeness: 10/10)
> (human: ~20 min / CC: ~2 min)

Store answer as `DEPTH` (quick or deep).

---

## Step 2: Mine explicit decisions from commit history

```bash
BASE=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null || echo "main")
git log "$BASE"..HEAD --format="%H%n%B%n---COMMIT_SEP---" 2>/dev/null
```

Extract only what is explicit in commit messages: stated reasons, rejected
alternatives, references to issues or external constraints. Do not infer decisions
from code structure here -- that happens in Step 3.

---

## Step 3: Read the capped diff and ask targeted questions

Find the most-changed files, skipping generated and lock files:

```bash
BASE=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null || echo "main")
git diff "$BASE"..HEAD \
  -- ':!*.lock' ':!package-lock.json' ':!yarn.lock' ':!*.min.js' ':!*.min.css' \
     ':!*-generated.*' ':!*.generated.*' ':!dist/*' ':!build/*' \
  --stat 2>/dev/null \
  | grep "|" \
  | sort -t'|' -k2 -rn \
  | head -20 \
  | awk '{print $1}'
```

Read the diffs for those files:

```bash
BASE=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null || echo "main")
git diff "$BASE"..HEAD -- {top_files} 2>/dev/null
```

If total diff exceeds 500 lines: read only the top 5 files. Summarize remaining
files by name and line count only -- do not read them.

From the diff, identify the 3 most non-obvious changes: a function that could have
been simpler but was not, a data structure that is not the obvious default, a guard
clause protecting against something specific, a value that looks deliberate.

Use AskUserQuestion to ask about each one directly, grounded in the specific change.
For example:

> You switched the retry logic in `auth.ts` from exponential to linear backoff.
> What drove that?

> You removed the Redis cache layer from `session.ts`. Intentional or temporary?

> `payments/webhook.ts` has a hardcoded 3-second delay at line 47. What is that
> protecting against?

Ask only about what is genuinely non-obvious. Skip anything explained by the commit
message or an existing comment. Maximum 3 questions. If the user skips a question,
record it as "rationale unknown" in the artifact.

---

## Step 4: Surface open threads

```bash
BASE=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null || echo "main")
# TODOs and FIXMEs introduced in this branch only
git diff "$BASE"..HEAD | grep "^+" | grep -iE "TODO|FIXME|HACK|XXX|WIP" | grep -v "^+++" || true
# Skipped or pending tests
git diff "$BASE"..HEAD | grep "^+" | grep -iE "\.skip|\.only|xit\b|xdescribe\b|pending\(" | grep -v "^+++" || true
# Stashed work
git stash list 2>/dev/null || true
```

---

## Step 5 (deep only): Surface real assumptions

Skip if `DEPTH` is quick.

Flag only these three patterns in new code introduced in this branch. Do not flag
every array access or type cast -- that is noise.

**Pattern 1 -- unguarded environment variables** (no fallback on same line):

```bash
BASE=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null || echo "main")
git diff "$BASE"..HEAD | grep "^+" | grep -E "process\.env\.[A-Z_]+" | grep -v "||" | grep -v "??" | grep -v "^+++" || true
```

**Pattern 2 -- explicit assumption comments:**

```bash
BASE=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null || echo "main")
git diff "$BASE"..HEAD | grep "^+" | grep -iE "//.*\b(assume|assumes|should be|always|never|expected to)\b" | grep -v "^+++" || true
```

**Pattern 3 -- external calls with no error handling:**

```bash
BASE=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null || echo "main")
git diff "$BASE"..HEAD | grep "^+" | grep -iE "\.(fetch|query|findOne|execute|request)\(" | grep -v "catch\|try\|await\|\.then" | grep -v "^+++" | head -10 || true
```

For each finding: record file, line, what is assumed, and risk (low/medium/high)
based on whether failure is silent vs. loud and whether it is in a critical path.

---

## Step 6 (deep only): Identify danger zones

Skip if `DEPTH` is quick.

From the diff read in Step 3, look for:
- Timing-sensitive code: setTimeout, setInterval, retry loops, polling, sleep
- Partial error handling: catch blocks that are empty, log-only, or contain TODO
- Layered patches: new code added on top of a recent commit that was itself a fix
- Comments containing "don't touch", "be careful", "fragile", "hacky", "workaround"

For each: record file, line range, why it is fragile, what is safe to do, and
what to avoid.

---

## Step 7 (deep only): Suggested entry point

Skip if `DEPTH` is quick.

Based on open threads and danger zones, produce one concrete recommendation:
- What the next agent should do first (specific file or task, not "review X")
- What the next agent should not touch until a specific condition is met
- The one question that, if answered, unblocks the most remaining work

Generic advice is not acceptable. "Do not touch `payments/webhook.ts` until the
load test in issue #89 completes -- start with the session timeout fix in
`auth/middleware.ts` instead" is the bar.

---

## Step 8: Write the artifact

```bash
BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
REPO=$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")
BASE=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null || echo "main")
TIMESTAMP=$(date +%Y-%m-%dT%H-%M-%S)
COMMIT_COUNT=$(git rev-list --count "$BASE"..HEAD 2>/dev/null || echo "0")
mkdir -p ~/.gstack/handoffs
ARTIFACT="$HOME/.gstack/handoffs/${REPO}-${BRANCH}-${TIMESTAMP}.md"
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
echo "ARTIFACT: $ARTIFACT"
echo "REPO_ROOT: $REPO_ROOT"
```

Write the artifact using the Write tool:

```markdown
# Handoff: {BRANCH}
**Repo:** {REPO} | **Branch:** {BRANCH} | **Created:** {TIMESTAMP}
**Commits ahead of {BASE}:** {N} | **Depth:** {quick|deep}

---

## Decisions

- **{description of change}**
  - Chose: {what}
  - Rejected: {alternatives, if known}
  - Reason: {rationale from commit message or answer to targeted question}

*(If rationale was skipped: "Rationale unknown -- {change description}. Inspect
before modifying.")*

*(If no decisions were surfaced: "Commit messages were terse and no non-obvious
changes were identified. Review the diff manually.")*

---

## Assumptions
*(Quick mode: section omitted)*

- `{file}:{line}` -- {what is assumed} *(risk: low|medium|high)*

*(If none found: "No assumptions detected.")*

---

## Danger Zones
*(Quick mode: section omitted)*

- `{file}:{line_range}` -- {why it is fragile}
  - Safe: {what to do}
  - Avoid: {what not to do}

*(If none found: "No danger zones detected.")*

---

## Open Threads

- [ ] {description} -- stopped because: {reason or "unknown"}

*(If none: "No open threads.")*

---

## For the Next Agent
*(Quick mode: section omitted)*

Start with: {specific file or task}

Do not touch {X} until {condition}.

Answer this first: {the question that unblocks the most work}

---

*Generated by /handoff v{VERSION} -- {TIMESTAMP}*
```

Copy to repo root:

```bash
cp "$ARTIFACT" "$REPO_ROOT/HANDOFF.md"
```

---

## Step 9: Inject into CLAUDE.md

Check for an existing active handoff entry:

```bash
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
grep -n "Active handoff" "$REPO_ROOT/CLAUDE.md" 2>/dev/null | head -1 || echo "NO_ENTRY"
```

If `NO_ENTRY`: append to `{REPO_ROOT}/CLAUDE.md`:

```markdown
## Active handoff

Load `HANDOFF.md` before starting work -- it contains decisions, danger zones,
and open threads from the last session on branch `{BRANCH}`.
```

If the entry exists: replace the branch name in that section with the current
branch. This keeps the entry pointing to the current handoff.

Then ensure `HANDOFF.md` is gitignored:

```bash
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
grep -q "^HANDOFF\.md$" "$REPO_ROOT/.gitignore" 2>/dev/null || echo "HANDOFF.md" >> "$REPO_ROOT/.gitignore"
```

Print:

```
  handoff written
    ~/.gstack/handoffs/{REPO}-{BRANCH}-{TIMESTAMP}.md
    {REPO_ROOT}/HANDOFF.md (gitignored)
    CLAUDE.md updated -- next agent will load this automatically
```

---

## Completion

Report status: **DONE**, **DONE_WITH_CONCERNS**, **BLOCKED**, or **NEEDS_CONTEXT**.

State how many decisions, assumptions, danger zones, and open threads were surfaced.

If `DONE_WITH_CONCERNS`: note if commit messages were terse (decisions sparse), or
if the diff exceeded the cap (list which files were skipped).

If `PROACTIVE` is `true`: suggest `/retro` for velocity metrics or `/review` before
handing off to a reviewer.

## Telemetry (run last)

```bash
_TEL_END=$(date +%s)
_TEL_DUR=$(( _TEL_END - _TEL_START ))
rm -f ~/.gstack/analytics/.pending-"$_SESSION_ID" 2>/dev/null || true
~/.claude/skills/gstack/bin/gstack-telemetry-log \
  --skill "handoff" --duration "$_TEL_DUR" --outcome "OUTCOME" \
  --used-browse "false" --session-id "$_SESSION_ID" 2>/dev/null &
```

Replace `OUTCOME` with success/error/abort.
