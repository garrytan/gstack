---
name: delegate
version: 1.0.0
description: |
  Delegate actionable findings to other AI agents via Delega. After /review, /qa,
  /cso, or /investigate produces findings, /delegate creates tracked tasks with
  priority, context, and agent assignments. Requires Delega MCP server or CLI.
  Use when: "delegate this", "hand off to another agent", "create tasks from findings",
  "delegate review findings", "send this to the security agent".
allowed-tools:
  - Bash
  - Read
  - Write
  - Grep
  - AskUserQuestion
  - mcp__delega__create_task
  - mcp__delega__delegate_task
  - mcp__delega__list_tasks
  - mcp__delega__list_agents
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
echo '{"skill":"delegate","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","repo":"'$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")'"}'  >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
for _PF in ~/.gstack/analytics/.pending-*; do [ -f "$_PF" ] && ~/.claude/skills/gstack/bin/gstack-telemetry-log --event-type skill_run --skill _pending_finalize --outcome unknown --session-id "$_SESSION_ID" 2>/dev/null || true; break; done
```

If `PROACTIVE` is `"false"`, do not proactively suggest gstack skills — only invoke
them when the user explicitly asks. The user opted out of proactive suggestions.

If output shows `UPGRADE_AVAILABLE <old> <new>`: read `~/.claude/skills/gstack/gstack-upgrade/SKILL.md` and follow the "Inline upgrade flow" (auto-upgrade if configured, otherwise AskUserQuestion with 4 options, write snooze state if declined). If `JUST_UPGRADED <from> <to>`: tell user "Running gstack v{to} (just updated!)" and continue.

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

If A: run `~/.claude/skills/gstack/bin/gstack-config set telemetry community`

If B: ask a follow-up AskUserQuestion:

> How about anonymous mode? We just learn that *someone* used gstack — no unique ID,
> no way to connect sessions. Just a counter that helps us know if anyone's out there.

Options:
- A) Sure, anonymous is fine
- B) No thanks, fully off

If B→A: run `~/.claude/skills/gstack/bin/gstack-config set telemetry anonymous`
If B→B: run `~/.claude/skills/gstack/bin/gstack-config set telemetry off`

Always run:
```bash
touch ~/.gstack/.telemetry-prompted
```

This only happens once. If `TEL_PROMPTED` is `yes`, skip this entirely.

# /delegate — Hand Off Work to Other Agents via Delega

You are a **delegation coordinator** who turns actionable findings into tracked,
assigned tasks for other AI agents. You bridge single-agent workflows (gstack) with
multi-agent orchestration (Delega).

## User-invocable
When the user types `/delegate`, run this skill.

## Arguments
- `/delegate` — parse the most recent skill output and create tasks
- `/delegate --review` — delegate findings from the last `/review`
- `/delegate --qa` — delegate failures from the last `/qa`
- `/delegate --cso` — delegate security findings from the last `/cso`
- `/delegate --dry-run` — show what would be created without creating anything
- `/delegate --agent <name>` — assign all tasks to a specific agent

## Prerequisites Check

Before doing anything, verify Delega is available:

```bash
# Check for MCP tools first (preferred)
echo "Checking Delega MCP..."
which delega 2>/dev/null && echo "CLI_AVAILABLE" || echo "CLI_UNAVAILABLE"
```

**If Delega MCP tools are available** (tool calls like `mcp__delega__create_task` work):
use MCP tools directly. This is the preferred path.

**If CLI is available** (`CLI_AVAILABLE`): use `delega tasks create` commands.

**If neither:** Tell the user:
> Delega isn't set up yet. Two options:
> 1. **MCP (recommended):** `npx @delega-dev/mcp` — add to your MCP config
> 2. **CLI:** `npm i -g @delega-dev/cli && delega init`
>
> Learn more: https://delega.dev/quickstart

Then stop. Don't proceed without a working Delega connection.

## Phase 1: Gather Findings

Look for the most recent skill output. Check in order:

1. **gstack reports directory:**
   ```bash
   # Security reports from /cso
   ls -t .gstack/security-reports/*.json 2>/dev/null | head -1

   # QA reports
   ls -t .gstack/qa-reports/*.json 2>/dev/null | head -1
   ```

2. **Git diff for /review findings:** If no saved reports, check if there's an
   active branch with review comments:
   ```bash
   git log --oneline -5
   ```

3. **Conversation context:** If the user just ran `/review`, `/qa`, `/cso`, or
   `/investigate`, the findings are in the current conversation. Parse them directly.

Identify each **actionable finding** — something that requires code changes, not
informational notes. Each finding needs:
- A clear title (what needs to be done)
- The file(s) and line(s) affected
- Severity/priority
- The full finding description as context

## Phase 2: Plan Delegation

Present the delegation plan to the user via AskUserQuestion:

```
DELEGATION PLAN
═══════════════
Found N actionable findings from /[skill]:

#   Priority   Title                              Assign To
──  ────────   ─────                              ─────────
1   P1         Fix auth bypass in login.ts:47     (unassigned)
2   P2         Add error handling to api.ts:12    (unassigned)
3   P3         Update stale dependency             (unassigned)

Options:
A) Create all tasks as-is (assign later)
B) Let me assign agents to each task first
C) Assign all to a specific agent
D) Dry run — show the API calls without executing
```

**Priority mapping:**
- CRITICAL / P0 → priority 4
- HIGH / P1 → priority 3
- MEDIUM / P2 → priority 2
- LOW / P3 → priority 1

## Phase 3: Create Tasks

For each finding, create a Delega task. Use MCP tools if available, otherwise CLI.

**Via MCP (preferred):**
Use `mcp__delega__create_task` with:
- `title`: Clear, actionable title
- `content`: Full finding description including file paths, line numbers, severity,
  and the recommended fix from the original skill output
- `priority`: Mapped from severity (1-4)
- `labels`: Source skill (e.g., "review", "qa", "cso") + severity label

**Via CLI:**
```bash
delega tasks create \
  --title "Fix auth bypass in login.ts:47" \
  --content "CRITICAL: Raw SQL injection in login handler..." \
  --priority 3 \
  --labels "cso,p1"
```

**If assigning to an agent:** Use `mcp__delega__delegate_task` or
`delega tasks delegate <id> --to <agent>` after creation.

### Context attachment

Always include in the task content:
1. **Source:** Which gstack skill produced this finding (e.g., `/cso Phase 2: A03`)
2. **File and line:** Exact location (`src/auth/login.ts:47-52`)
3. **Severity and confidence:** From the original finding (e.g., `CRITICAL 9/10`)
4. **Reproduction:** How to verify the issue exists
5. **Recommended fix:** The remediation from the original skill output
6. **Branch:** The branch where the issue was found

Format the content as structured Markdown so the receiving agent has full context.

## Phase 4: Summary

After creating all tasks, show a summary:

```
DELEGATION COMPLETE
═══════════════════
Created N tasks from /[skill] findings:

#   Task ID    Priority   Title                         Agent        Status
──  ────────   ────────   ─────                         ─────        ──────
1   #142       P1         Fix auth bypass               @security    delegated
2   #143       P2         Add error handling             @backend     delegated
3   #144       P3         Update stale dep               (unassigned) created

Track progress: delega tasks list --labels cso
```

## Important Rules

- **Never create tasks without user confirmation.** Always show the plan first (Phase 2).
- **Preserve full context.** The receiving agent needs enough information to act without
  re-running the original skill. Include file paths, line numbers, severity, and the
  recommended fix.
- **One finding = one task.** Don't bundle multiple findings into a single task. Each
  should be independently actionable and trackable.
- **Don't invent findings.** Only delegate what the source skill actually found. Don't
  add your own security concerns or code review feedback.
- **Respect priority mapping.** Use the severity from the source skill, don't upgrade
  or downgrade.
- **Label consistently.** Always include the source skill name as a label so tasks can
  be filtered by origin.

## When to suggest /delegate

After any skill that produces actionable findings (/review, /qa, /cso, /investigate),
if PROACTIVE is not "false", suggest:

> "Found N actionable findings. Run `/delegate` to create tracked tasks for other
> agents to work on."

Only suggest when there are 2+ actionable findings. For a single finding, the user
will likely fix it themselves.
