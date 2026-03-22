---
name: sprint
description: |
  Sprint & task management via Odoo Project. Create tasks, track sprints,
  send approval requests, and view dashboards — all from terminal.
  Use when asked to "manage tasks", "create sprint", "add task", "sprint status",
  "send for approval", or "close sprint".
  Proactively suggest when the user mentions task management or sprint planning.
---
<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->

## Preamble (run first)

```bash
_UPD=$(~/.codex/skills/gstack/bin/gstack-update-check 2>/dev/null || .agents/skills/gstack/bin/gstack-update-check 2>/dev/null || true)
[ -n "$_UPD" ] && echo "$_UPD" || true
mkdir -p ~/.gstack/sessions
touch ~/.gstack/sessions/"$PPID"
_SESSIONS=$(find ~/.gstack/sessions -mmin -120 -type f 2>/dev/null | wc -l | tr -d ' ')
find ~/.gstack/sessions -mmin +120 -type f -delete 2>/dev/null || true
_CONTRIB=$(~/.codex/skills/gstack/bin/gstack-config get gstack_contributor 2>/dev/null || true)
_PROACTIVE=$(~/.codex/skills/gstack/bin/gstack-config get proactive 2>/dev/null || echo "true")
_BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
echo "BRANCH: $_BRANCH"
echo "PROACTIVE: $_PROACTIVE"
_LAKE_SEEN=$([ -f ~/.gstack/.completeness-intro-seen ] && echo "yes" || echo "no")
echo "LAKE_INTRO: $_LAKE_SEEN"
_TEL=$(~/.codex/skills/gstack/bin/gstack-config get telemetry 2>/dev/null || true)
_TEL_PROMPTED=$([ -f ~/.gstack/.telemetry-prompted ] && echo "yes" || echo "no")
_TEL_START=$(date +%s)
_SESSION_ID="$$-$(date +%s)"
echo "TELEMETRY: ${_TEL:-off}"
echo "TEL_PROMPTED: $_TEL_PROMPTED"
mkdir -p ~/.gstack/analytics
echo '{"skill":"sprint","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","repo":"'$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")'"}'  >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
for _PF in ~/.gstack/analytics/.pending-*; do [ -f "$_PF" ] && ~/.codex/skills/gstack/bin/gstack-telemetry-log --event-type skill_run --skill _pending_finalize --outcome unknown --session-id "$_SESSION_ID" 2>/dev/null || true; break; done
```

If `PROACTIVE` is `"false"`, do not proactively suggest gstack skills — only invoke
them when the user explicitly asks. The user opted out of proactive suggestions.

If output shows `UPGRADE_AVAILABLE <old> <new>`: read `~/.codex/skills/gstack/gstack-upgrade/SKILL.md` and follow the "Inline upgrade flow" (auto-upgrade if configured, otherwise AskUserQuestion with 4 options, write snooze state if declined). If `JUST_UPGRADED <from> <to>`: tell user "Running gstack v{to} (just updated!)" and continue.

If `LAKE_INTRO` is `no`: Before continuing, introduce the Completeness Principle.
Tell the user: "gstack follows the **Boil the Lake** principle — always do the complete
thing when AI makes the marginal cost near-zero. Read more: https://garryslist.org/posts/boil-the-ocean"
Then offer to open the essay in their default browser:

```bash
open https://garryslist.org/posts/boil-the-ocean
touch ~/.gstack/.completeness-intro-seen
```

Only run `open` if the user says yes. Always run `touch` to mark as seen. This only happens once.

If `TEL_PROMPTED` is `no` AND `LAKE_INTRO` is `yes`: After the lake intro is handled,
ask the user about telemetry. Use AskUserQuestion:

> Help gstack get better! Community mode shares usage data (which skills you use, how long
> they take, crash info) with a stable device ID so we can track trends and fix bugs faster.
> No code, file paths, or repo names are ever sent.
> Change anytime with `gstack-config set telemetry off`.

Options:
- A) Help gstack get better! (recommended)
- B) No thanks

If A: run `~/.codex/skills/gstack/bin/gstack-config set telemetry community`

If B: ask a follow-up AskUserQuestion:

> How about anonymous mode? We just learn that *someone* used gstack — no unique ID,
> no way to connect sessions. Just a counter that helps us know if anyone's out there.

Options:
- A) Sure, anonymous is fine
- B) No thanks, fully off

If B→A: run `~/.codex/skills/gstack/bin/gstack-config set telemetry anonymous`
If B→B: run `~/.codex/skills/gstack/bin/gstack-config set telemetry off`

Always run:
```bash
touch ~/.gstack/.telemetry-prompted
```

This only happens once. If `TEL_PROMPTED` is `yes`, skip this entirely.

## AskUserQuestion Format

**ALWAYS follow this structure for every AskUserQuestion call:**
1. **Re-ground:** State the project, the current branch (use the `_BRANCH` value printed by the preamble — NOT any branch from conversation history or gitStatus), and the current plan/task. (1-2 sentences)
2. **Simplify:** Explain the problem in plain English a smart 16-year-old could follow. No raw function names, no internal jargon, no implementation details. Use concrete examples and analogies. Say what it DOES, not what it's called.
3. **Recommend:** `RECOMMENDATION: Choose [X] because [one-line reason]` — always prefer the complete option over shortcuts (see Completeness Principle). Include `Completeness: X/10` for each option. Calibration: 10 = complete implementation (all edge cases, full coverage), 7 = covers happy path but skips some edges, 3 = shortcut that defers significant work. If both options are 8+, pick the higher; if one is ≤5, flag it.
4. **Options:** Lettered options: `A) ... B) ... C) ...` — when an option involves effort, show both scales: `(human: ~X / CC: ~Y)`

Assume the user hasn't looked at this window in 20 minutes and doesn't have the code open. If you'd need to read the source to understand your own explanation, it's too complex.

Per-skill instructions may add additional formatting rules on top of this baseline.

## Completeness Principle — Boil the Lake

AI-assisted coding makes the marginal cost of completeness near-zero. When you present options:

- If Option A is the complete implementation (full parity, all edge cases, 100% coverage) and Option B is a shortcut that saves modest effort — **always recommend A**. The delta between 80 lines and 150 lines is meaningless with CC+gstack. "Good enough" is the wrong instinct when "complete" costs minutes more.
- **Lake vs. ocean:** A "lake" is boilable — 100% test coverage for a module, full feature implementation, handling all edge cases, complete error paths. An "ocean" is not — rewriting an entire system from scratch, adding features to dependencies you don't control, multi-quarter platform migrations. Recommend boiling lakes. Flag oceans as out of scope.
- **When estimating effort**, always show both scales: human team time and CC+gstack time. The compression ratio varies by task type — use this reference:

| Task type | Human team | CC+gstack | Compression |
|-----------|-----------|-----------|-------------|
| Boilerplate / scaffolding | 2 days | 15 min | ~100x |
| Test writing | 1 day | 15 min | ~50x |
| Feature implementation | 1 week | 30 min | ~30x |
| Bug fix + regression test | 4 hours | 15 min | ~20x |
| Architecture / design | 2 days | 4 hours | ~5x |
| Research / exploration | 1 day | 3 hours | ~3x |

- This principle applies to test coverage, error handling, documentation, edge cases, and feature completeness. Don't skip the last 10% to "save time" — with AI, that 10% costs seconds.

**Anti-patterns — DON'T do this:**
- BAD: "Choose B — it covers 90% of the value with less code." (If A is only 70 lines more, choose A.)
- BAD: "We can skip edge case handling to save time." (Edge case handling costs minutes with CC.)
- BAD: "Let's defer test coverage to a follow-up PR." (Tests are the cheapest lake to boil.)
- BAD: Quoting only human-team effort: "This would take 2 weeks." (Say: "2 weeks human / ~1 hour CC.")

## Contributor Mode

If `_CONTRIB` is `true`: you are in **contributor mode**. You're a gstack user who also helps make it better.

**At the end of each major workflow step** (not after every single command), reflect on the gstack tooling you used. Rate your experience 0 to 10. If it wasn't a 10, think about why. If there is an obvious, actionable bug OR an insightful, interesting thing that could have been done better by gstack code or skill markdown — file a field report. Maybe our contributor will help make us better!

**Calibration — this is the bar:** For example, `$B js "await fetch(...)"` used to fail with `SyntaxError: await is only valid in async functions` because gstack didn't wrap expressions in async context. Small, but the input was reasonable and gstack should have handled it — that's the kind of thing worth filing. Things less consequential than this, ignore.

**NOT worth filing:** user's app bugs, network errors to user's URL, auth failures on user's site, user's own JS logic bugs.

**To file:** write `~/.gstack/contributor-logs/{slug}.md` with **all sections below** (do not truncate — include every section through the Date/Version footer):

```
# {Title}

Hey gstack team — ran into this while using /{skill-name}:

**What I was trying to do:** {what the user/agent was attempting}
**What happened instead:** {what actually happened}
**My rating:** {0-10} — {one sentence on why it wasn't a 10}

## Steps to reproduce
1. {step}

## Raw output
```
{paste the actual error or unexpected output here}
```

## What would make this a 10
{one sentence: what gstack should have done differently}

**Date:** {YYYY-MM-DD} | **Version:** {gstack version} | **Skill:** /{skill}
```

Slug: lowercase, hyphens, max 60 chars (e.g. `browse-js-no-await`). Skip if file already exists. Max 3 reports per session. File inline and continue — don't stop the workflow. Tell user: "Filed gstack field report: {title}"

## Completion Status Protocol

When completing a skill workflow, report status using one of:
- **DONE** — All steps completed successfully. Evidence provided for each claim.
- **DONE_WITH_CONCERNS** — Completed, but with issues the user should know about. List each concern.
- **BLOCKED** — Cannot proceed. State what is blocking and what was tried.
- **NEEDS_CONTEXT** — Missing information required to continue. State exactly what you need.

### Escalation

It is always OK to stop and say "this is too hard for me" or "I'm not confident in this result."

Bad work is worse than no work. You will not be penalized for escalating.
- If you have attempted a task 3 times without success, STOP and escalate.
- If you are uncertain about a security-sensitive change, STOP and escalate.
- If the scope of work exceeds what you can verify, STOP and escalate.

Escalation format:
```
STATUS: BLOCKED | NEEDS_CONTEXT
REASON: [1-2 sentences]
ATTEMPTED: [what you tried]
RECOMMENDATION: [what the user should do next]
```

## Telemetry (run last)

After the skill workflow completes (success, error, or abort), log the telemetry event.
Determine the skill name from the `name:` field in this file's YAML frontmatter.
Determine the outcome from the workflow result (success if completed normally, error
if it failed, abort if the user interrupted).

**PLAN MODE EXCEPTION — ALWAYS RUN:** This command writes telemetry to
`~/.gstack/analytics/` (user config directory, not project files). The skill
preamble already writes to the same directory — this is the same pattern.
Skipping this command loses session duration and outcome data.

Run this bash:

```bash
_TEL_END=$(date +%s)
_TEL_DUR=$(( _TEL_END - _TEL_START ))
rm -f ~/.gstack/analytics/.pending-"$_SESSION_ID" 2>/dev/null || true
~/.codex/skills/gstack/bin/gstack-telemetry-log \
  --skill "SKILL_NAME" --duration "$_TEL_DUR" --outcome "OUTCOME" \
  --used-browse "USED_BROWSE" --session-id "$_SESSION_ID" 2>/dev/null &
```

Replace `SKILL_NAME` with the actual skill name from frontmatter, `OUTCOME` with
success/error/abort, and `USED_BROWSE` with true/false based on whether `$B` was used.
If you cannot determine the outcome, use "unknown". This runs in the background and
never blocks the user.

# /sprint — Sprint & Task Management (Odoo Integration)

Manage sprints and tasks via Odoo Project API. Supports task creation, sprint tracking,
approval workflows, and notifications — all through Odoo's built-in systems.

## User-invocable

When the user types `/sprint`, run this skill.

## Arguments

- `/sprint` — show current sprint dashboard
- `/sprint setup` — configure Odoo connection
- `/sprint add <description>` — create a new task in current sprint
- `/sprint new [name]` — start a new sprint (milestone)
- `/sprint close` — close current sprint with summary report
- `/sprint approve <task_id>` — send task for approval via Odoo chatter
- `/sprint review` — list tasks pending approval
- `/sprint report` — generate sprint report

## Step 0: Load Odoo Config

Check for existing Odoo configuration:

```bash
cat ~/.gstack/odoo-config.json 2>/dev/null || echo "NOT_CONFIGURED"
```

If `NOT_CONFIGURED`, jump to **Setup Flow**. Otherwise, load the config values
(url, db, api_key, uid, project_id) and proceed with the requested command.

## Setup Flow (triggered by `/sprint setup` or first run)

Guide the user through Odoo API configuration:

1. Ask for their Odoo instance URL (e.g., `https://odoo.mycompany.com`)
2. Ask for database name
3. Ask for API key (Settings → Users → API Keys in Odoo)
4. Ask for their Odoo user ID (uid)

Then verify the connection:

```bash
curl -s -X POST "<ODOO_URL>/jsonrpc" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "call",
    "params": {
      "service": "object",
      "method": "execute_kw",
      "args": ["<DB>", <UID>, "<API_KEY>", "project.project", "search_read", [[]], {"fields": ["name", "id"], "limit": 20}]
    }
  }'
```

Show the list of projects and ask the user to pick one. Then save config:

```bash
mkdir -p ~/.gstack
cat > ~/.gstack/odoo-config.json << 'CONFIGEOF'
{
  "url": "<ODOO_URL>",
  "db": "<DB>",
  "uid": <UID>,
  "api_key": "<API_KEY>",
  "project_id": <PROJECT_ID>,
  "project_name": "<PROJECT_NAME>"
}
CONFIGEOF
chmod 600 ~/.gstack/odoo-config.json
```

Confirm setup is complete and show the user their selected project.

## Odoo API Helper

All Odoo operations use JSON-RPC. The pattern for every call:

```bash
curl -s -X POST "<URL>/jsonrpc" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "call",
    "params": {
      "service": "object",
      "method": "execute_kw",
      "args": ["<DB>", <UID>, "<API_KEY>", "<MODEL>", "<METHOD>", [<ARGS>], <KWARGS>]
    }
  }'
```

Replace `<MODEL>`, `<METHOD>`, `<ARGS>`, `<KWARGS>` based on the operation.

## Command: Dashboard (default — `/sprint`)

Show the current sprint status by querying Odoo tasks:

```bash
# 1. Get current sprint (latest milestone)
curl -s -X POST "<URL>/jsonrpc" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "call",
    "params": {
      "service": "object",
      "method": "execute_kw",
      "args": ["<DB>", <UID>, "<API_KEY>", "project.milestone", "search_read",
        [[["project_id", "=", <PROJECT_ID>], ["is_reached", "=", false]]],
        {"fields": ["name", "id", "deadline"], "order": "create_date desc", "limit": 1}
      ]
    }
  }'
```

```bash
# 2. Get all tasks in current sprint, grouped by stage
curl -s -X POST "<URL>/jsonrpc" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "call",
    "params": {
      "service": "object",
      "method": "execute_kw",
      "args": ["<DB>", <UID>, "<API_KEY>", "project.task", "search_read",
        [[["project_id", "=", <PROJECT_ID>], ["milestone_id", "=", <MILESTONE_ID>]]],
        {"fields": ["name", "id", "stage_id", "user_ids", "priority", "date_deadline", "tag_ids"], "order": "stage_id, priority desc"}
      ]
    }
  }'
```

Format the output as a clean dashboard:

```
╔══════════════════════════════════════════════════╗
║  Sprint: <sprint_name>  |  Deadline: <date>      ║
╠══════════════════════════════════════════════════╣
║                                                  ║
║  📋 New (3)                                      ║
║    #42  Setup CI/CD pipeline         ★★          ║
║    #43  Design landing page          ★           ║
║    #44  Write API docs               ★           ║
║                                                  ║
║  🔄 In Progress (2)                              ║
║    #40  User authentication          ★★★         ║
║    #41  Database migrations          ★★          ║
║                                                  ║
║  ✅ Done (5)                                     ║
║    #35  Project setup                ★           ║
║    ...                                           ║
║                                                  ║
║  Progress: ████████░░ 50% (5/10)                 ║
╚══════════════════════════════════════════════════╝
```

## Command: Add Task (`/sprint add <description>`)

Parse the description from the argument. Create a task in Odoo:

```bash
curl -s -X POST "<URL>/jsonrpc" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "call",
    "params": {
      "service": "object",
      "method": "execute_kw",
      "args": ["<DB>", <UID>, "<API_KEY>", "project.task", "create",
        [{"name": "<TASK_NAME>", "project_id": <PROJECT_ID>, "milestone_id": <MILESTONE_ID>, "user_ids": [<UID>]}],
        {}
      ]
    }
  }'
```

After creating, confirm with the task ID and link:
```
Task #<ID> created: "<TASK_NAME>"
Sprint: <sprint_name> | Assigned to: you
Link: <ODOO_URL>/web#id=<ID>&model=project.task&view_type=form
```

**Batch mode:** If the user provides multiple tasks (comma-separated or multi-line),
create all of them in sequence and show a summary table.

## Command: New Sprint (`/sprint new [name]`)

1. If no name given, ask the user for a sprint name
2. Ask for deadline (default: 2 weeks from today)
3. Create a milestone in Odoo:

```bash
curl -s -X POST "<URL>/jsonrpc" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "call",
    "params": {
      "service": "object",
      "method": "execute_kw",
      "args": ["<DB>", <UID>, "<API_KEY>", "project.milestone", "create",
        [{"name": "<SPRINT_NAME>", "project_id": <PROJECT_ID>, "deadline": "<DEADLINE_DATE>"}],
        {}
      ]
    }
  }'
```

4. Confirm creation and show the new sprint in dashboard format

## Command: Close Sprint (`/sprint close`)

1. Get current sprint tasks and compute stats:
   - Total tasks
   - Completed vs incomplete
   - Tasks by priority

2. If there are incomplete tasks, ask:
   - Move to next sprint?
   - Mark as cancelled?
   - Leave in current sprint?

3. Mark milestone as reached:

```bash
curl -s -X POST "<URL>/jsonrpc" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "call",
    "params": {
      "service": "object",
      "method": "execute_kw",
      "args": ["<DB>", <UID>, "<API_KEY>", "project.milestone", "write",
        [[<MILESTONE_ID>], {"is_reached": true}],
        {}
      ]
    }
  }'
```

4. Generate sprint report (see Report command)

5. Ask if user wants to create the next sprint immediately

## Command: Approve (`/sprint approve <task_id>`)

Send an approval request via **GitHub Issues** (avoids touching Odoo production for notifications):

1. First, get task details from Odoo to build the approval context:

```bash
curl -s -X POST "<URL>/jsonrpc" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "call",
    "params": {
      "service": "object",
      "method": "execute_kw",
      "args": ["<DB>", <UID>, "<API_KEY>", "project.task", "read",
        [[<TASK_ID>]],
        {"fields": ["name", "description", "stage_id", "user_ids"]}
      ]
    }
  }'
```

2. Create a GitHub Issue for the approval request:

```bash
gh issue create \
  --title "🔍 Approval: <TASK_NAME>" \
  --label "approval,sprint" \
  --body "$(cat <<'EOF'
## Approval Required

**Odoo Task:** #<TASK_ID> — <TASK_NAME>
**Sprint:** <SPRINT_NAME>
**Odoo Link:** <ODOO_URL>/web#id=<TASK_ID>&model=project.task&view_type=form

### Details
<TASK_DESCRIPTION>

### Action needed
- [ ] Reviewed
- [ ] Approved

Please comment with your approval or feedback.
Close this issue once approved.
EOF
)"
```

3. Update the Odoo task stage to "Review" so it's visible in both systems:

```bash
curl -s -X POST "<URL>/jsonrpc" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "call",
    "params": {
      "service": "object",
      "method": "execute_kw",
      "args": ["<DB>", <UID>, "<API_KEY>", "project.task", "write",
        [[<TASK_ID>], {"stage_id": <REVIEW_STAGE_ID>}],
        {}
      ]
    }
  }'
```

4. Confirm: "Approval request created as GitHub Issue. Odoo task moved to Review stage."

GitHub notifications will handle alerting reviewers — no need to call Odoo's
mail system directly.

## Command: Review (`/sprint review`)

List pending approvals from **both** GitHub Issues and Odoo:

```bash
# GitHub: open approval issues
gh issue list --label "approval" --state open --json number,title,createdAt,url
```

```bash
# Odoo: tasks in Review stage
curl -s -X POST "<URL>/jsonrpc" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "call",
    "params": {
      "service": "object",
      "method": "execute_kw",
      "args": ["<DB>", <UID>, "<API_KEY>", "project.task", "search_read",
        [[["project_id", "=", <PROJECT_ID>], ["stage_id.name", "ilike", "review"]]],
        {"fields": ["name", "id", "stage_id", "date_last_stage_update"], "order": "date_last_stage_update desc"}
      ]
    }
  }'
```

Display combined review queue:
```
Pending Approval:
  GH #12  🔍 Approval: Setup CI/CD pipeline     — opened Mar 20
  GH #15  🔍 Approval: Landing page design       — opened Mar 19

Odoo tasks in Review:
  #42  Setup CI/CD pipeline     — since Mar 20
  #45  Landing page design      — since Mar 19

No pending approvals? All clear!
```

## Command: Report (`/sprint report`)

Generate a sprint summary report:

1. Query all tasks in the current (or most recently closed) sprint
2. Compute metrics:
   - Total tasks completed vs planned
   - Completion rate
   - Average task cycle time (created → done)
   - Tasks by priority breakdown
   - Velocity (tasks/sprint)

3. Format as:

```
Sprint Report: <sprint_name>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Period: Mar 8 – Mar 22, 2026

Completion:  8/10 tasks (80%)
Velocity:    8 tasks/sprint

By Priority:
  ★★★ Critical:  2/2 done
  ★★  High:      3/4 done (1 carried over)
  ★   Normal:    3/4 done (1 cancelled)

Carried Over → Next Sprint:
  #41  Database migrations (★★)

Highlights:
  - Shipped user auth end-to-end
  - CI/CD pipeline fully automated
  - Landing page live

Blockers encountered:
  - API rate limiting on 3rd party service (resolved)
```

4. Save report locally:

```bash
mkdir -p ~/.gstack/sprint-reports
```

Use the Write tool to save a JSON snapshot to `~/.gstack/sprint-reports/<date>-<sprint_name>.json`.

## Content Approval Flow

When the user asks to approve content (blog posts, docs, marketing material):

1. Ask for the content file path or paste
2. Create a task in Odoo with the content summary in the description
3. Create a GitHub Issue with `approval,content` labels containing the full content
4. If content is a file in the repo, reference the file path in the issue body

```bash
gh issue create \
  --title "📝 Content Review: <CONTENT_TITLE>" \
  --label "approval,content,sprint" \
  --body "$(cat <<'EOF'
## Content Review Required

**Type:** <blog/docs/marketing>
**Odoo Task:** #<TASK_ID>
**File:** `<FILE_PATH>` (if applicable)

### Content
<CONTENT_PREVIEW_OR_FULL_TEXT>

### Checklist
- [ ] Content accuracy reviewed
- [ ] Grammar/spelling checked
- [ ] Approved for publishing

Please comment with feedback or close when approved.
EOF
)"
```

5. Confirm with links to both the GitHub Issue and Odoo task

## Deploy Approval Flow

When the user wants deploy approval:

1. Gather deploy context automatically:

```bash
# Get branch, PR, and change summary
BRANCH=$(git branch --show-current)
gh pr view --json title,number,url,additions,deletions,changedFiles 2>/dev/null || echo "NO_PR"
git diff --stat origin/$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)...HEAD
```

2. Create a GitHub Issue with deploy context:

```bash
gh issue create \
  --title "🚀 Deploy Approval: <BRANCH_OR_PR_TITLE>" \
  --label "approval,deploy,sprint" \
  --body "$(cat <<'EOF'
## Deploy Approval Required

**Branch:** <BRANCH>
**PR:** <PR_URL> (if exists)
**Changes:** <N> files, +<ADDITIONS>/-<DELETIONS>

### Changed files
<GIT_DIFF_STAT>

### Tests
<TEST_RESULTS or "Run tests before requesting approval">

### Checklist
- [ ] Code reviewed
- [ ] Tests passing
- [ ] Approved for production

Close this issue to confirm deployment approval.
EOF
)"
```

3. Create/update corresponding Odoo task with deploy details
4. Tell the user: "Deploy approval created on GitHub. Close the issue when approved, then proceed with deployment."

## Tone

- Concise, action-oriented
- Show task IDs and links for easy reference
- Use visual formatting (tables, progress bars) for dashboards
- Confirm every action with what was created/updated
- If Odoo API errors occur, show the error and suggest fixes (wrong API key, network, permissions)

## Important Rules

- NEVER store Odoo passwords — only API keys (stored in ~/.gstack/odoo-config.json with 600 permissions)
- Always verify Odoo connection before operations
- Handle API errors gracefully — show the raw error if debugging is needed
- All dates in user's local timezone
- Task IDs always prefixed with # for readability
- Config file at ~/.gstack/odoo-config.json — never commit to repos

## Telemetry

```bash
mkdir -p ~/.gstack/analytics
echo '{"skill":"sprint","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","repo":"'$(basename $(pwd))'","cmd":"<SUBCOMMAND>"}' >> ~/.gstack/analytics/skill-usage.jsonl
```
