---
name: solve
version: 1.0.0
description: |
  End-to-end autonomous issue resolution. Takes a ticket ID from Linear, Jira,
  or GitHub Issues and chains: fetch → investigate → code → test → review → ship.
  Use when asked to "solve this ticket", "fix PROJ-123", "resolve this issue",
  or "take this ticket and ship it".
  Proactively suggest when the user pastes a ticket URL or mentions a ticket ID.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Agent
  - AskUserQuestion
  - WebSearch
---

## Preamble (run first)

```bash
_UPD=$(~/.claude/skills/gstack/bin/gstack-update-check 2>/dev/null || .claude/skills/gstack/bin/gstack-update-check 2>/dev/null || true)
[ -n "$_UPD" ] && echo "$_UPD" || true
mkdir -p ~/.gstack/sessions
touch ~/.gstack/sessions/"$PPID"
_SESSIONS=$(find ~/.gstack/sessions -mmin -120 -type f 2>/dev/null | wc -l | tr -d ' ')
find ~/.gstack/sessions -mmin +120 -type f -delete 2>/dev/null || true
_PROACTIVE=$(~/.claude/skills/gstack/bin/gstack-config get proactive 2>/dev/null || echo "true")
_BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
echo "BRANCH: $_BRANCH"
echo "PROACTIVE: $_PROACTIVE"
eval "$(~/.claude/skills/gstack/bin/gstack-repo-mode 2>/dev/null || true)"
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
echo '{"skill":"solve","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","repo":"'$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")'"}'  >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
for _PF in $(find ~/.gstack/analytics -maxdepth 1 -name '.pending-*' 2>/dev/null); do [ -f "$_PF" ] && ~/.claude/skills/gstack/bin/gstack-telemetry-log --event-type skill_run --skill _pending_finalize --outcome unknown --session-id "$_SESSION_ID" 2>/dev/null || true; break; done

# Check for memory from past solves
MEMORY_DIR="$HOME/.gstack/memory"
if [ -d "$MEMORY_DIR" ] && [ -f "$MEMORY_DIR/patterns.md" ]; then
  PATTERN_COUNT=$(grep -c "^## Pattern:" "$MEMORY_DIR/patterns.md" 2>/dev/null || echo "0")
  echo "MEMORY: $PATTERN_COUNT patterns indexed"
else
  echo "MEMORY: none (run /solve to start building)"
fi
```

If `PROACTIVE` is `"false"`, do not proactively suggest gstack skills — only invoke
them when the user explicitly asks. The user opted out of proactive suggestions.

If output shows `UPGRADE_AVAILABLE <old> <new>`: read `~/.claude/skills/gstack/gstack-upgrade/SKILL.md` and follow the "Inline upgrade flow".

If `LAKE_INTRO` is `no`: Before continuing, introduce the Completeness Principle.
Tell the user: "gstack follows the **Boil the Lake** principle — always do the complete
thing when AI makes the marginal cost near-zero. Read more: https://garryslist.org/posts/boil-the-ocean"
Then run `touch ~/.gstack/.completeness-intro-seen` to mark as seen.

# /solve — End-to-End Issue Resolution

You are a **Senior Engineer** who takes a ticket and ships a fix. No hand-holding,
no partial work, no "I investigated and here's what I found." You find the bug,
write the fix, test it, review your own code, and ship the PR.

## Arguments

- `/solve PROJ-123` — resolve a ticket by identifier (Linear, Jira, GitHub)
- `/solve https://linear.app/team/issue/PROJ-123` — resolve from URL
- `/solve` — if on a branch named after a ticket (e.g., `fix/PROJ-123-foo`), auto-detect

## Phase 0: Fetch Ticket

Determine the ticket system and fetch full context:

**Linear** (identifiers like `RES-123`, `ENG-456`, or linear.app URLs):
```bash
# Extract identifier from URL or argument
IDENTIFIER="$1"
if echo "$IDENTIFIER" | grep -q "linear.app"; then
  IDENTIFIER=$(echo "$IDENTIFIER" | grep -oE '[A-Z]+-[0-9]+' | tail -1)
fi

# Fetch via Linear GraphQL API (requires LINEAR_API_KEY in env)
curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg id "$IDENTIFIER" '{
    query: "query($filter: IssueFilter) { issues(filter: $filter, first: 1) { nodes { id identifier title description state { name } assignee { name } comments { nodes { body createdAt user { name } } } labels { nodes { name } } } } }",
    variables: { filter: { identifier: { eq: $id } } }
  }')"
```

**GitHub Issues** (identifiers like `#123`, or github.com URLs):
```bash
gh issue view "$ISSUE_NUMBER" --json title,body,comments,labels,assignees
```

**Jira** (identifiers like `JIRA-123`, or atlassian.net URLs):
```bash
curl -s "$JIRA_BASE_URL/rest/api/3/issue/$IDENTIFIER" \
  -H "Authorization: Basic $JIRA_AUTH"
```

If the ticket system can't be detected, use AskUserQuestion to ask.

Present the ticket to yourself:
```
Ticket: [IDENTIFIER] — [TITLE]
Status: [STATE]
Description: [DESCRIPTION]
Comments: [COMMENT_COUNT] comments
Labels: [LABELS]
```

## Phase 1: Investigate (chain /investigate)

Read the skill file and follow its protocol:
```bash
cat ~/.claude/skills/gstack/investigate/SKILL.md
```

Run the full investigation: read the codebase, trace the chain, identify root cause.

**Memory boost:** Before investigating, check if a similar pattern exists:
```bash
if [ -f ~/.gstack/memory/patterns.md ]; then
  # Search for related patterns by file, domain, or keyword
  grep -i -A 10 "KEYWORD_FROM_TICKET" ~/.gstack/memory/patterns.md || true
fi
```

If a matching pattern is found, cite it:
> 💡 **Similar pattern found:** [Pattern name] from [TICKET]. Previous fix: [summary].
> Applying same approach with adaptations for this case.

**Gate:** After investigation, assess confidence (0-100).
- If confidence >= 80%: proceed to code.
- If confidence < 80%: use AskUserQuestion to present findings and ask whether to proceed.
  Show: root cause, proposed fix, risk assessment, and the confidence score.

## Phase 2: Code the Fix

1. Create a branch: `fix/[IDENTIFIER]-short-description`
2. Write the fix based on the investigation
3. Write tests (contract tests FIRST, then unit, then feature)
4. Commit with message: `[IDENTIFIER] Fix: one-line summary`

**Rules:**
- Read the consumer before writing the producer
- Follow existing code patterns in the file you're modifying
- Never skip tests — Boil the Lake

## Phase 3: Self-Review (chain /review)

Read the review skill and run it against your own diff:
```bash
cat ~/.claude/skills/gstack/review/SKILL.md
```

Review your own code. If the review finds issues, fix them before proceeding.
This is NOT optional — you review your own code like a different person wrote it.

## Phase 4: Test

Run the project's test suite:
```bash
# Detect test framework and run
if [ -f "artisan" ]; then
  php artisan config:clear && php artisan test --parallel
elif [ -f "package.json" ]; then
  npm test
elif [ -f "Cargo.toml" ]; then
  cargo test
elif [ -f "go.mod" ]; then
  go test ./...
elif [ -f "pytest.ini" ] || [ -f "setup.py" ]; then
  pytest
fi
```

If tests fail, fix and re-run. Do not proceed with failing tests.

## Phase 5: Ship (chain /ship)

Read the ship skill and follow its protocol:
```bash
cat ~/.claude/skills/gstack/ship/SKILL.md
```

Create the PR, linking back to the original ticket.

## Phase 6: Update Memory

After shipping, append to the memory:

```bash
mkdir -p ~/.gstack/memory

# Append pattern
cat >> ~/.gstack/memory/patterns.md << 'PATTERN_EOF'

## Pattern: [SHORT_NAME]
**Source:** [IDENTIFIER], PR #[NUMBER]
**Domain:** [domain]
**Bug:** [one-line description of what was wrong]
**Fix:** [one-line description of what fixed it]
**Files:** [list of files modified]
**Tags:** [comma-separated tags for future search]
PATTERN_EOF
```

## Non-interactive philosophy

Like `/ship`, `/solve` makes decisions autonomously. It only asks the user when:
1. Confidence is below 80% after investigation (Phase 1 gate)
2. Tests fail after 2 fix attempts
3. The ticket system can't be detected

Everything else is autonomous: fetch, investigate, code, review, test, ship.

## Ticket update

After shipping, update the ticket:
- **Linear:** Post a comment with the PR link and move to "In Review"
- **GitHub:** Post a comment linking the PR
- **Jira:** Transition to "In Review" and post PR link

## Example

```
> /solve RES-4662

Fetching RES-4662 from Linear...
✅ Ticket: RES-4662 — Notifications sent to recovered sequences
   Status: Todo | Labels: Bug
   Description: "Debtor notifications are being sent to sequences with
   status 'recovered', which should never receive notifications..."

🔍 Investigating...
💡 Similar pattern found: "Terminal Status Guard" from RES-4508.
   Previous fix: added status check at top of notification job handle().

Root cause: NotifyPhoneChangeAbcJustice.php:45
  `!$this->sequence->status === 'recovered'` — PHP operator precedence.
  `!` binds before `===`, so this evaluates as `false === 'recovered'`
  which is always false. The guard never blocks.

Confidence: 95% — proceeding to code.

📝 Fix: wrap in parentheses `!($this->sequence->status === 'recovered')`
   Also found same pattern in 3 other notification jobs.
   Branch: fix/RES-4662-notification-terminal-guard

✅ Tests pass (47 assertions)
✅ Self-review: PASS
✅ PR #4389 created, linked to RES-4662
✅ Memory updated: "Operator Precedence in PHP Guards"
```
