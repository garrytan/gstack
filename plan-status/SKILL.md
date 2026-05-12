---
name: plan-status
preamble-tier: 1
version: 1.0.0
description: |
  Check progress of a gstack plan against the current codebase and git log.
  Reads a plan file (CEO plan, eng plan, or any gstack plan doc), extracts
  phases and success-criteria checkboxes, cross-references git commits and
  filesystem state, and produces a done/in-progress/remaining status report.
  Use when: "plan status", "how far along is the plan", "what's done",
  "what's left", "check plan progress", "where are we on the plan". (gstack)
triggers:
  - plan status
  - how far along
  - what's done on the plan
  - what's left on the plan
  - check plan progress
  - where are we on the plan
allowed-tools:
  - Bash
  - Read
  - Glob
  - Grep
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
find ~/.gstack/sessions -mmin +120 -type f -exec rm {} + 2>/dev/null || true
_PROACTIVE=$(~/.claude/skills/gstack/bin/gstack-config get proactive 2>/dev/null || echo "true")
_PROACTIVE_PROMPTED=$([ -f ~/.gstack/.proactive-prompted ] && echo "yes" || echo "no")
_BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
echo "BRANCH: $_BRANCH"
_SKILL_PREFIX=$(~/.claude/skills/gstack/bin/gstack-config get skill_prefix 2>/dev/null || echo "false")
echo "PROACTIVE: $_PROACTIVE"
echo "PROACTIVE_PROMPTED: $_PROACTIVE_PROMPTED"
echo "SKILL_PREFIX: $_SKILL_PREFIX"
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
_EXPLAIN_LEVEL=$(~/.claude/skills/gstack/bin/gstack-config get explain_level 2>/dev/null || echo "default")
if [ "$_EXPLAIN_LEVEL" != "default" ] && [ "$_EXPLAIN_LEVEL" != "terse" ]; then _EXPLAIN_LEVEL="default"; fi
echo "EXPLAIN_LEVEL: $_EXPLAIN_LEVEL"
_QUESTION_TUNING=$(~/.claude/skills/gstack/bin/gstack-config get question_tuning 2>/dev/null || echo "false")
echo "QUESTION_TUNING: $_QUESTION_TUNING"
mkdir -p ~/.gstack/analytics
if [ "$_TEL" != "off" ]; then
echo '{"skill":"plan-status","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","repo":"'$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")'"}'  >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
fi
for _PF in $(find ~/.gstack/analytics -maxdepth 1 -name '.pending-*' 2>/dev/null); do
  if [ -f "$_PF" ]; then
    if [ "$_TEL" != "off" ] && [ -x "~/.claude/skills/gstack/bin/gstack-telemetry-log" ]; then
      ~/.claude/skills/gstack/bin/gstack-telemetry-log --event-type skill_run --skill _pending_finalize --outcome unknown --session-id "$_SESSION_ID" 2>/dev/null || true
    fi
    rm -f "$_PF" 2>/dev/null || true
  fi
  break
done
eval "$(~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null)" 2>/dev/null || true
_LEARN_FILE="${GSTACK_HOME:-$HOME/.gstack}/projects/${SLUG:-unknown}/learnings.jsonl"
if [ -f "$_LEARN_FILE" ]; then
  _LEARN_COUNT=$(wc -l < "$_LEARN_FILE" 2>/dev/null | tr -d ' ')
  echo "LEARNINGS: $_LEARN_COUNT entries loaded"
  if [ "$_LEARN_COUNT" -gt 5 ] 2>/dev/null; then
    ~/.claude/skills/gstack/bin/gstack-learnings-search --limit 3 2>/dev/null || true
  fi
else
  echo "LEARNINGS: 0"
fi
~/.claude/skills/gstack/bin/gstack-timeline-log '{"skill":"plan-status","event":"started","branch":"'"$_BRANCH"'","session":"'"$_SESSION_ID"'"}' 2>/dev/null &
_HAS_ROUTING="no"
if [ -f CLAUDE.md ] && grep -q "## Skill routing" CLAUDE.md 2>/dev/null; then
  _HAS_ROUTING="yes"
fi
_ROUTING_DECLINED=$(~/.claude/skills/gstack/bin/gstack-config get routing_declined 2>/dev/null || echo "false")
echo "HAS_ROUTING: $_HAS_ROUTING"
echo "ROUTING_DECLINED: $_ROUTING_DECLINED"
_VENDORED="no"
if [ -d ".claude/skills/gstack" ] && [ ! -L ".claude/skills/gstack" ]; then
  if [ -f ".claude/skills/gstack/VERSION" ] || [ -d ".claude/skills/gstack/.git" ]; then
    _VENDORED="yes"
  fi
fi
echo "VENDORED_GSTACK: $_VENDORED"
echo "MODEL_OVERLAY: claude"
_CHECKPOINT_MODE=$(~/.claude/skills/gstack/bin/gstack-config get checkpoint_mode 2>/dev/null || echo "explicit")
_CHECKPOINT_PUSH=$(~/.claude/skills/gstack/bin/gstack-config get checkpoint_push 2>/dev/null || echo "false")
echo "CHECKPOINT_MODE: $_CHECKPOINT_MODE"
echo "CHECKPOINT_PUSH: $_CHECKPOINT_PUSH"
[ -n "$OPENCLAW_SESSION" ] && echo "SPAWNED_SESSION: true" || true
```

## Plan Mode Safe Operations

In plan mode, allowed because they inform the plan: `$B`, `$D`, `codex exec`/`codex review`, writes to `~/.gstack/`, writes to the plan file, and `open` for generated artifacts.

## Skill Invocation During Plan Mode

If the user invokes a skill in plan mode, the skill takes precedence over generic plan mode behavior. **Treat the skill file as executable instructions, not reference.** Follow it step by step starting from Step 0; the first AskUserQuestion is the workflow entering plan mode, not a violation of it. AskUserQuestion (any variant — `mcp__*__AskUserQuestion` or native; see "AskUserQuestion Format → Tool resolution") satisfies plan mode's end-of-turn requirement. If no variant is callable, the skill is BLOCKED — stop and report `BLOCKED — AskUserQuestion unavailable` per the AskUserQuestion Format rule. At a STOP point, stop immediately. Do not continue the workflow or call ExitPlanMode there. Commands marked "PLAN MODE EXCEPTION — ALWAYS RUN" execute. Call ExitPlanMode only after the skill workflow completes, or if the user tells you to cancel the skill or leave plan mode.

If `PROACTIVE` is `"false"`, do not auto-invoke or proactively suggest skills. If a skill seems useful, ask: "I think /skillname might help here — want me to run it?"

If `SKILL_PREFIX` is `"true"`, suggest/invoke `/gstack-*` names. Disk paths stay `~/.claude/skills/gstack/[skill-name]/SKILL.md`.

If output shows `UPGRADE_AVAILABLE <old> <new>`: read `~/.claude/skills/gstack/gstack-upgrade/SKILL.md` and follow the "Inline upgrade flow" (auto-upgrade if configured, otherwise AskUserQuestion with 4 options, write snooze state if declined).

If output shows `JUST_UPGRADED <from> <to>`: print "Running gstack v{to} (just updated!)". If `SPAWNED_SESSION` is true, skip feature discovery.

Feature discovery, max one prompt per session:
- Missing `~/.claude/skills/gstack/.feature-prompted-continuous-checkpoint`: AskUserQuestion for Continuous checkpoint auto-commits. If accepted, run `~/.claude/skills/gstack/bin/gstack-config set checkpoint_mode continuous`. Always touch marker.
- Missing `~/.claude/skills/gstack/.feature-prompted-model-overlay`: inform "Model overlays are active. MODEL_OVERLAY shows the patch." Always touch marker.

After upgrade prompts, continue workflow.

If `WRITING_STYLE_PENDING` is `yes`: ask once about writing style:

> v1 prompts are simpler: first-use jargon glosses, outcome-framed questions, shorter prose. Keep default or restore terse?

Options:
- A) Keep the new default (recommended — good writing helps everyone)
- B) Restore V0 prose — set `explain_level: terse`

If A: leave `explain_level` unset (defaults to `default`).
If B: run `~/.claude/skills/gstack/bin/gstack-config set explain_level terse`.

Always run (regardless of choice):
```bash
rm -f ~/.gstack/.writing-style-prompt-pending
touch ~/.gstack/.writing-style-prompted
```

Skip if `WRITING_STYLE_PENDING` is `no`.

If `LAKE_INTRO` is `no`: say "gstack follows the **Boil the Lake** principle — do the complete thing when AI makes marginal cost near-zero. Read more: https://garryslist.org/posts/boil-the-ocean" Offer to open:

```bash
open https://garryslist.org/posts/boil-the-ocean
touch ~/.gstack/.completeness-intro-seen
```

Only run `open` if yes. Always run `touch`.

If `TEL_PROMPTED` is `no` AND `LAKE_INTRO` is `yes`: ask telemetry once via AskUserQuestion:

> Help gstack get better. Share usage data only: skill, duration, crashes, stable device ID. No code, file paths, or repo names.

Options:
- A) Help gstack get better! (recommended)
- B) No thanks

If A: run `~/.claude/skills/gstack/bin/gstack-config set telemetry community`

If B: ask follow-up:

> Anonymous mode sends only aggregate usage, no unique ID.

Options:
- A) Sure, anonymous is fine
- B) No thanks, fully off

If B→A: run `~/.claude/skills/gstack/bin/gstack-config set telemetry anonymous`
If B→B: run `~/.claude/skills/gstack/bin/gstack-config set telemetry off`

Always run:
```bash
touch ~/.gstack/.telemetry-prompted
```

Skip if `TEL_PROMPTED` is `yes`.

If `PROACTIVE_PROMPTED` is `no` AND `TEL_PROMPTED` is `yes`: ask once:

> Let gstack proactively suggest skills, like /qa for "does this work?" or /investigate for bugs?

Options:
- A) Keep it on (recommended)
- B) Turn it off — I'll type /commands myself

If A: run `~/.claude/skills/gstack/bin/gstack-config set proactive true`
If B: run `~/.claude/skills/gstack/bin/gstack-config set proactive false`

Always run:
```bash
touch ~/.gstack/.proactive-prompted
```

Skip if `PROACTIVE_PROMPTED` is `yes`.

If `HAS_ROUTING` is `no` AND `ROUTING_DECLINED` is `false` AND `PROACTIVE_PROMPTED` is `yes`:
Check if a CLAUDE.md file exists in the project root. If it does not exist, create it.

Use AskUserQuestion:

> gstack works best when your project's CLAUDE.md includes skill routing rules.

Options:
- A) Add routing rules to CLAUDE.md (recommended)
- B) No thanks, I'll invoke skills manually

If A: Append this section to the end of CLAUDE.md:

```markdown

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
```

Then commit the change: `git add CLAUDE.md && git commit -m "chore: add gstack skill routing rules to CLAUDE.md"`

If B: run `~/.claude/skills/gstack/bin/gstack-config set routing_declined true` and say they can re-enable with `gstack-config set routing_declined false`.

This only happens once per project. Skip if `HAS_ROUTING` is `yes` or `ROUTING_DECLINED` is `true`.

If `VENDORED_GSTACK` is `yes`, warn once via AskUserQuestion unless `~/.gstack/.vendoring-warned-$SLUG` exists:

> This project has gstack vendored in `.claude/skills/gstack/`. Vendoring is deprecated.
> Migrate to team mode?

Options:
- A) Yes, migrate to team mode now
- B) No, I'll handle it myself

If A:
1. Run `git rm -r .claude/skills/gstack/`
2. Run `echo '.claude/skills/gstack/' >> .gitignore`
3. Run `~/.claude/skills/gstack/bin/gstack-team-init required` (or `optional`)
4. Run `git add .claude/ .gitignore CLAUDE.md && git commit -m "chore: migrate gstack from vendored to team mode"`
5. Tell the user: "Done. Each developer now runs: `cd ~/.claude/skills/gstack && ./setup --team`"

If B: say "OK, you're on your own to keep the vendored copy up to date."

Always run (regardless of choice):
```bash
eval "$(~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null)" 2>/dev/null || true
touch ~/.gstack/.vendoring-warned-${SLUG:-unknown}
```

If marker exists, skip.

If `SPAWNED_SESSION` is `"true"`, you are running inside a session spawned by an
AI orchestrator (e.g., OpenClaw). In spawned sessions:
- Do NOT use AskUserQuestion for interactive prompts. Auto-choose the recommended option.
- Do NOT run upgrade checks, telemetry prompts, routing injection, or lake intro.
- Focus on completing the task and reporting results via prose output.
- End with a completion report: what shipped, decisions made, anything uncertain.

## Artifacts Sync (skill start)

```bash
_GSTACK_HOME="${GSTACK_HOME:-$HOME/.gstack}"
# Prefer the v1.27.0.0 artifacts file; fall back to brain file for users
# upgrading mid-stream before the migration script runs.
if [ -f "$HOME/.gstack-artifacts-remote.txt" ]; then
  _BRAIN_REMOTE_FILE="$HOME/.gstack-artifacts-remote.txt"
else
  _BRAIN_REMOTE_FILE="$HOME/.gstack-brain-remote.txt"
fi
_BRAIN_SYNC_BIN="~/.claude/skills/gstack/bin/gstack-brain-sync"
_BRAIN_CONFIG_BIN="~/.claude/skills/gstack/bin/gstack-config"

# /sync-gbrain context-load: teach the agent to use gbrain when it's available.
# Per-worktree pin: post-spike redesign uses kubectl-style `.gbrain-source` in the
# git toplevel to scope queries. Look for the pin in the worktree (not a global
# state file) so that opening worktree B without a pin doesn't claim "indexed"
# just because worktree A was synced. Empty string when gbrain is not
# configured (zero context cost for non-gbrain users).
_GBRAIN_CONFIG="$HOME/.gbrain/config.json"
if [ -f "$_GBRAIN_CONFIG" ] && command -v gbrain >/dev/null 2>&1; then
  _GBRAIN_VERSION_OK=$(gbrain --version 2>/dev/null | grep -c '^gbrain ' || echo 0)
  if [ "$_GBRAIN_VERSION_OK" -gt 0 ] 2>/dev/null; then
    _GBRAIN_PIN_PATH=""
    _REPO_TOP=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
    if [ -n "$_REPO_TOP" ] && [ -f "$_REPO_TOP/.gbrain-source" ]; then
      _GBRAIN_PIN_PATH="$_REPO_TOP/.gbrain-source"
    fi
    if [ -n "$_GBRAIN_PIN_PATH" ]; then
      echo "GBrain configured. Prefer \`gbrain search\`/\`gbrain query\` over Grep for"
      echo "semantic questions; use \`gbrain code-def\`/\`code-refs\`/\`code-callers\` for"
      echo "symbol-aware code lookup. See \"## GBrain Search Guidance\" in CLAUDE.md."
      echo "Run /sync-gbrain to refresh."
    else
      echo "GBrain configured but this worktree isn't pinned yet. Run \`/sync-gbrain --full\`"
      echo "before relying on \`gbrain search\` for code questions in this worktree."
      echo "Falls back to Grep until pinned."
    fi
  fi
fi

_BRAIN_SYNC_MODE=$("$_BRAIN_CONFIG_BIN" get artifacts_sync_mode 2>/dev/null || echo off)

# Detect remote-MCP mode (Path 4 of /setup-gbrain). Local artifacts sync is
# a no-op in remote mode; the brain server pulls from GitHub/GitLab on its
# own cadence. Read claude.json directly to keep this preamble fast (no
# subprocess to claude CLI on every skill start).
_GBRAIN_MCP_MODE="none"
if command -v jq >/dev/null 2>&1 && [ -f "$HOME/.claude.json" ]; then
  _GBRAIN_MCP_TYPE=$(jq -r '.mcpServers.gbrain.type // .mcpServers.gbrain.transport // empty' "$HOME/.claude.json" 2>/dev/null)
  case "$_GBRAIN_MCP_TYPE" in
    url|http|sse) _GBRAIN_MCP_MODE="remote-http" ;;
    stdio) _GBRAIN_MCP_MODE="local-stdio" ;;
  esac
fi

if [ -f "$_BRAIN_REMOTE_FILE" ] && [ ! -d "$_GSTACK_HOME/.git" ] && [ "$_BRAIN_SYNC_MODE" = "off" ]; then
  _BRAIN_NEW_URL=$(head -1 "$_BRAIN_REMOTE_FILE" 2>/dev/null | tr -d '[:space:]')
  if [ -n "$_BRAIN_NEW_URL" ]; then
    echo "ARTIFACTS_SYNC: artifacts repo detected: $_BRAIN_NEW_URL"
    echo "ARTIFACTS_SYNC: run 'gstack-brain-restore' to pull your cross-machine artifacts (or 'gstack-config set artifacts_sync_mode off' to dismiss forever)"
  fi
fi

if [ -d "$_GSTACK_HOME/.git" ] && [ "$_BRAIN_SYNC_MODE" != "off" ]; then
  _BRAIN_LAST_PULL_FILE="$_GSTACK_HOME/.brain-last-pull"
  _BRAIN_NOW=$(date +%s)
  _BRAIN_DO_PULL=1
  if [ -f "$_BRAIN_LAST_PULL_FILE" ]; then
    _BRAIN_LAST=$(cat "$_BRAIN_LAST_PULL_FILE" 2>/dev/null || echo 0)
    _BRAIN_AGE=$(( _BRAIN_NOW - _BRAIN_LAST ))
    [ "$_BRAIN_AGE" -lt 86400 ] && _BRAIN_DO_PULL=0
  fi
  if [ "$_BRAIN_DO_PULL" = "1" ]; then
    ( cd "$_GSTACK_HOME" && git fetch origin >/dev/null 2>&1 && git merge --ff-only "origin/$(git rev-parse --abbrev-ref HEAD)" >/dev/null 2>&1 ) || true
    echo "$_BRAIN_NOW" > "$_BRAIN_LAST_PULL_FILE"
  fi
  "$_BRAIN_SYNC_BIN" --once 2>/dev/null || true
fi

if [ "$_GBRAIN_MCP_MODE" = "remote-http" ]; then
  # Remote-MCP mode: local artifacts sync is a no-op (brain admin's server
  # pulls from GitHub/GitLab). Show the user this is by design, not broken.
  _GBRAIN_HOST=$(jq -r '.mcpServers.gbrain.url // empty' "$HOME/.claude.json" 2>/dev/null | sed -E 's|^https?://([^/:]+).*|\1|')
  echo "ARTIFACTS_SYNC: remote-mode (managed by brain server ${_GBRAIN_HOST:-remote})"
elif [ -d "$_GSTACK_HOME/.git" ] && [ "$_BRAIN_SYNC_MODE" != "off" ]; then
  _BRAIN_QUEUE_DEPTH=0
  [ -f "$_GSTACK_HOME/.brain-queue.jsonl" ] && _BRAIN_QUEUE_DEPTH=$(wc -l < "$_GSTACK_HOME/.brain-queue.jsonl" | tr -d ' ')
  _BRAIN_LAST_PUSH="never"
  [ -f "$_GSTACK_HOME/.brain-last-push" ] && _BRAIN_LAST_PUSH=$(cat "$_GSTACK_HOME/.brain-last-push" 2>/dev/null || echo never)
  echo "ARTIFACTS_SYNC: mode=$_BRAIN_SYNC_MODE | last_push=$_BRAIN_LAST_PUSH | queue=$_BRAIN_QUEUE_DEPTH"
else
  echo "ARTIFACTS_SYNC: off"
fi
```



Privacy stop-gate: if output shows `ARTIFACTS_SYNC: off`, `artifacts_sync_mode_prompted` is `false`, and gbrain is on PATH or `gbrain doctor --fast --json` works, ask once:

> gstack can publish your artifacts (CEO plans, designs, reports) to a private GitHub repo that GBrain indexes across machines. How much should sync?

Options:
- A) Everything allowlisted (recommended)
- B) Only artifacts
- C) Decline, keep everything local

After answer:

```bash
# Chosen mode: full | artifacts-only | off
"$_BRAIN_CONFIG_BIN" set artifacts_sync_mode <choice>
"$_BRAIN_CONFIG_BIN" set artifacts_sync_mode_prompted true
```

If A/B and `~/.gstack/.git` is missing, ask whether to run `gstack-artifacts-init`. Do not block the skill.

At skill END before telemetry:

```bash
"~/.claude/skills/gstack/bin/gstack-brain-sync" --discover-new 2>/dev/null || true
"~/.claude/skills/gstack/bin/gstack-brain-sync" --once 2>/dev/null || true
```


## Model-Specific Behavioral Patch (claude)

The following nudges are tuned for the claude model family. They are
**subordinate** to skill workflow, STOP points, AskUserQuestion gates, plan-mode
safety, and /ship review gates. If a nudge below conflicts with skill instructions,
the skill wins. Treat these as preferences, not rules.

**Todo-list discipline.** When working through a multi-step plan, mark each task
complete individually as you finish it. Do not batch-complete at the end. If a task
turns out to be unnecessary, mark it skipped with a one-line reason.

**Think before heavy actions.** For complex operations (refactors, migrations,
non-trivial new features), briefly state your approach before executing. This lets
the user course-correct cheaply instead of mid-flight.

**Dedicated tools over Bash.** Prefer Read, Edit, Write, Glob, Grep over shell
equivalents (cat, sed, find, grep). The dedicated tools are cheaper and clearer.

## Voice

Direct, concrete, builder-to-builder. Name the file, function, command, and user-visible impact. No filler.

No em dashes. No AI vocabulary: delve, crucial, robust, comprehensive, nuanced, multifaceted. Never corporate or academic. Short paragraphs. End with what to do.

The user has context you do not. Cross-model agreement is a recommendation, not a decision. The user decides.

## Completion Status Protocol

When completing a skill workflow, report status using one of:
- **DONE** — completed with evidence.
- **DONE_WITH_CONCERNS** — completed, but list concerns.
- **BLOCKED** — cannot proceed; state blocker and what was tried.
- **NEEDS_CONTEXT** — missing info; state exactly what is needed.

Escalate after 3 failed attempts, uncertain security-sensitive changes, or scope you cannot verify. Format: `STATUS`, `REASON`, `ATTEMPTED`, `RECOMMENDATION`.

## Operational Self-Improvement

Before completing, if you discovered a durable project quirk or command fix that would save 5+ minutes next time, log it:

```bash
~/.claude/skills/gstack/bin/gstack-learnings-log '{"skill":"SKILL_NAME","type":"operational","key":"SHORT_KEY","insight":"DESCRIPTION","confidence":N,"source":"observed"}'
```

Do not log obvious facts or one-time transient errors.

## Telemetry (run last)

After workflow completion, log telemetry. Use skill `name:` from frontmatter. OUTCOME is success/error/abort/unknown.

**PLAN MODE EXCEPTION — ALWAYS RUN:** This command writes telemetry to
`~/.gstack/analytics/`, matching preamble analytics writes.

Run this bash:

```bash
_TEL_END=$(date +%s)
_TEL_DUR=$(( _TEL_END - _TEL_START ))
rm -f ~/.gstack/analytics/.pending-"$_SESSION_ID" 2>/dev/null || true
# Session timeline: record skill completion (local-only, never sent anywhere)
~/.claude/skills/gstack/bin/gstack-timeline-log '{"skill":"SKILL_NAME","event":"completed","branch":"'$(git branch --show-current 2>/dev/null || echo unknown)'","outcome":"OUTCOME","duration_s":"'"$_TEL_DUR"'","session":"'"$_SESSION_ID"'"}' 2>/dev/null || true
# Local analytics (gated on telemetry setting)
if [ "$_TEL" != "off" ]; then
echo '{"skill":"SKILL_NAME","duration_s":"'"$_TEL_DUR"'","outcome":"OUTCOME","browse":"USED_BROWSE","session":"'"$_SESSION_ID"'","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
fi
# Remote telemetry (opt-in, requires binary)
if [ "$_TEL" != "off" ] && [ -x ~/.claude/skills/gstack/bin/gstack-telemetry-log ]; then
  ~/.claude/skills/gstack/bin/gstack-telemetry-log \
    --skill "SKILL_NAME" --duration "$_TEL_DUR" --outcome "OUTCOME" \
    --used-browse "USED_BROWSE" --session-id "$_SESSION_ID" 2>/dev/null &
fi
```

Replace `SKILL_NAME`, `OUTCOME`, and `USED_BROWSE` before running.

## Plan Status Footer

In plan mode before ExitPlanMode: if the plan file lacks `## GSTACK REVIEW REPORT`, run `~/.claude/skills/gstack/bin/gstack-review-read` and append the standard runs/status/findings table. With `NO_REVIEWS` or empty, append a 5-row placeholder with verdict "NO REVIEWS YET — run `/autoplan`". If a richer report exists, skip.

PLAN MODE EXCEPTION — always allowed (it's the plan file).

## Plan-status Setup

```bash
eval "$(~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null)" && mkdir -p ~/.gstack/projects/$SLUG
_REPO=$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")
_PLAN_GLOB=$(~/.claude/skills/gstack/bin/gstack-config get plan_glob 2>/dev/null || echo "")
_PLAN_DIR="${GSTACK_HOME:-$HOME/.gstack}/projects/${SLUG:-unknown}"
echo "SLUG_RESOLVED: ${SLUG:-unknown}"
echo "PLAN_DIR: $_PLAN_DIR"
if [ -n "$_PLAN_GLOB" ]; then
  _PLANS=$(ls -t $_PLAN_GLOB 2>/dev/null | head -10)
else
  _PLANS=$(find "$_PLAN_DIR" -name "*.md" 2>/dev/null | grep -E "ceo-plans|eng-plans" | sort -r | head -10)
fi
echo "AVAILABLE_PLANS:"
if [ -z "$_PLANS" ]; then
  echo "No plans found in $_PLAN_DIR. Run /office-hours or /plan-ceo-review to create one."
else
  echo "$_PLANS"
fi
_GIT_LOG=$(git log --oneline $(git merge-base HEAD main 2>/dev/null || git merge-base HEAD master 2>/dev/null)..HEAD 2>/dev/null | head -30)
echo "BRANCH_COMMITS:"
echo "$_GIT_LOG"
_ANALYTICS="$HOME/.gstack/analytics/skill-usage.jsonl"
echo "SKILL_ANALYTICS:"
if [ -f "$_ANALYTICS" ] && [ -n "$_REPO" ] && [ "$_REPO" != "unknown" ]; then
  grep "\"repo\":\"$_REPO\"" "$_ANALYTICS" 2>/dev/null | tail -200
else
  echo "none"
fi
```

Note: `plan_glob` is read from `~/.gstack/config.yaml` via `gstack-config` — not from environment variables or user input. Configure it with: `~/.claude/skills/gstack/bin/gstack-config set plan_glob "~/board-plans/*.md"`. Paths with spaces in directory names are not supported in v1.

## Plan Mode Safe Operations

In plan mode, allowed because they inform the plan: reads from `~/.gstack/`, reads from the codebase, `git log`, `git diff`, `find`, `ls`.

## Skill Invocation During Plan Mode

If the user invokes this skill in plan mode, follow it step by step. This skill is read-only — it never edits files. AskUserQuestion satisfies plan mode's end-of-turn requirement if no plan file is auto-resolved.

---

## Step 0 — Resolve the plan file

If the user named a specific plan file in their message, use that path directly.

Otherwise, use the `AVAILABLE_PLANS` list from the Setup block to pick the most relevant plan:
- If only one plan exists for this project, use it.
- If the current branch name appears in a plan filename, prefer that one.
- If multiple plans exist with no clear match, use AskUserQuestion to let the user pick. Present a numbered list of the plan filenames and ask which one to check. This is the only case where AskUserQuestion is needed in this skill — keep the prompt simple (no D<N> format required).
- If `AVAILABLE_PLANS` is empty, stop and display the empty-state message from Setup.

Read the resolved plan file in full before proceeding.

## Step 1 — Extract structure

From the plan file, identify:

1. **Phases** — sections headed `### Phase N` or `## Phase N` or similar. Note the name and summary of each.
2. **Success criteria checkboxes** — lines matching `- [ ]` (incomplete) or `- [x]` (complete). These are ground truth from the plan author.
3. **File/directory references** — any `app/`, `config/`, `db/`, `test/` paths mentioned in the plan that we can verify exist or not.
4. **Gem/dependency references** — any gem names mentioned as "add" or "remove" that we can verify in Gemfile.
5. **Pre-migration checklist items** — if present, extract as a separate list.

## Step 2 — Gather evidence

Run these checks. Do them in parallel where possible.

**Git evidence:**
```bash
# Commits on this branch since diverging from main
git log --oneline $(git merge-base HEAD main 2>/dev/null || git merge-base HEAD master 2>/dev/null)..HEAD 2>/dev/null

# Files changed on this branch
git diff --name-only $(git merge-base HEAD main 2>/dev/null || git merge-base HEAD master 2>/dev/null)..HEAD 2>/dev/null
```

**Filesystem evidence** — for each file/directory the plan says should exist or be deleted, check:
```bash
# Check existence of files the plan says should exist
ls <path> 2>/dev/null || echo "MISSING: <path>"

# Check deletion of files the plan says should be gone
ls <path> 2>/dev/null && echo "STILL EXISTS: <path>" || echo "DELETED: <path>"
```

**Gemfile evidence** — for each gem the plan says to add or remove:
```bash
grep -E "gem .\"<gemname>\"" Gemfile 2>/dev/null && echo "PRESENT" || echo "ABSENT"
```

**Config/initializer evidence** — for any initializers or config the plan says to create:
```bash
ls config/initializers/<name>.rb 2>/dev/null && echo "EXISTS" || echo "MISSING"
```

## Step 3 — Classify each item

For each phase and each success-criteria checkbox, assign one of:

- **DONE** — evidence confirms it: file exists/deleted as expected, gem added/removed, commit message matches, checkbox already `[x]`
- **PARTIAL** — some evidence but not complete (e.g. file exists but a required method is missing)
- **REMAINING** — no evidence; checkbox still `[ ]` and no corroborating git/filesystem signal
- **DROPPED** — plan explicitly marks it dropped/removed/n/a

**Classification rules:**
- Use the evidence conservatively. If you're uncertain, mark REMAINING rather than DONE — a false positive is worse than a false negative.
- File existence alone is not sufficient to mark a planning artifact DONE. Require a content signal: a named section heading matching the plan's description, a completion marker, or a matching `[x]` checkbox within the file.
- Commit message matching is a strong positive signal. If the commit message explicitly names the deliverable, weight it heavily.
- A `[x]` checkbox in the plan file is ground truth from the plan author — mark DONE regardless of other evidence.

## Step 4 — Produce the status report

Output a structured report in three sections.

### Section A: gstack Lifecycle Dashboard

Parse the `SKILL_ANALYTICS` output from the Setup block. Each line is a JSON object:
`{"skill":"...","ts":"2026-05-11T22:00:00Z","repo":"..."}`.

For each canonical skill in the table below, count occurrences and find the most recent `ts` (format as `YYYY-MM-DD HH:MM`). For the `(commits)` row, use the `BRANCH_COMMITS` count from the Setup block.

**Status per row:**
- 0 runs: Status = `—`, Last Run = `—`
- > 0 runs: Status = `DONE`, Last Run = most recent timestamp
- `(commits)` row: Status = `DONE` if commits > 0, `—` if 0; Last Run = `—` always

**Required column:**
- `YES` for: `/plan-eng-review`, `(commits)`, `/review`, `/ship`
- `no` for all others

**VERDICT logic:**
- Count required YES rows where Status = `—` (not yet run), including `(commits)` if 0 commits
- 0 REMAINING: `CLEARED — all required lifecycle steps complete`
- All required REMAINING (nothing run): `NOT STARTED`
- Otherwise: `IN PROGRESS — N required skill(s) REMAINING: [names]`

Display:

```
+====================================================================================+
|                         GSTACK LIFECYCLE DASHBOARD                                 |
+====================================================================================+
| Phase    | Skill               | Runs | Last Run         | Status   | Required    |
|----------|---------------------|------|------------------|----------|-------------|
| Think    | /office-hours       |  0   | —                | —        | no          |
| Plan     | /plan-ceo-review    |  0   | —                | —        | no          |
|          | /plan-eng-review    |  0   | —                | —        | YES         |
|          | /plan-design-review |  0   | —                | —        | no          |
|          | /plan-devex-review  |  0   | —                | —        | no          |
|          | /autoplan           |  0   | —                | —        | no          |
| Build    | (commits)           |  0   | —                | —        | YES         |
| Review   | /review             |  0   | —                | —        | YES         |
|          | /design-review      |  0   | —                | —        | no          |
| Test     | /qa                 |  0   | —                | —        | no          |
|          | /qa-only            |  0   | —                | —        | no          |
|          | /benchmark          |  0   | —                | —        | no          |
| Ship     | /ship               |  0   | —                | —        | YES         |
|          | /land-and-deploy    |  0   | —                | —        | no          |
| Reflect  | /retro              |  0   | —                | —        | no          |
|          | /document-release   |  0   | —                | —        | no          |
+------------------------------------------------------------------------------------+
| VERDICT: NOT STARTED                                                                |
+====================================================================================+
```

Fill in real values from the analytics data; the table above shows the all-zero baseline shape.

### Section B: Other Observed Skills

After building the lifecycle dashboard, collect any skill names from `SKILL_ANALYTICS` that are NOT in the canonical skill list above and NOT `plan-status` itself. Display a companion table:

```
+================================================+
|          OTHER OBSERVED SKILLS                 |
|  (not yet mapped to lifecycle dashboard)       |
+================================================+
| Skill              | Runs | Last Run           |
|--------------------+------+--------------------|
| /investigate       |  2   | 2026-05-10 14:00   |
| /codex             |  1   | 2026-05-09 11:00   |
+------------------------------------------------+
| 2 skills observed                              |
+================================================+
```

If no unlisted skills appear:
```
Other observed skills: none — all analytics entries are covered by the lifecycle dashboard above.
```

This table is self-maintaining: any new gstack skill that gets invoked on the project surfaces here automatically.

### Section C: Plan Detail

```
## Plan Status: <plan filename>
Branch: <branch> | As of: <today's date>

### Phase Summary
| Phase | Status | Notes |
|-------|--------|-------|
| Phase 0: Foundation | DONE | All gems added, initializers present |
| Phase 1: Schema | DONE | Migrations in db/migrate/ |
| Phase 7: RAG migration | REMAINING | NotImplementedError stubs; no RubyLLM.embed calls |

### Success Criteria
| Item | Status |
|------|--------|
| [ ] ruby_llm install generator accepted | DONE |
| [ ] langchainrb removed from Gemfile | REMAINING |
| [ ] Cross-tenant scoping test passes | REMAINING |
| [ ] ActsAsTenant require_tenant = true | PARTIAL — dev only, not production |

### Branch Commits
| Hash    | Message                                  | In Scope |
|---------|------------------------------------------|----------|
| a1b2c3d | feat: add ruby_llm gem and initializer   | YES      |
| e4f5g6h | chore: remove langchainrb from Gemfile   | YES      |
| i7j8k9l | fix: unrelated bug in user controller    | NO       |

### Pre-Migration Checklist (if present)
List any checklist items from the plan and their resolved status.

### Summary
X of Y phases complete. Z of W success criteria met.
Key blockers: <list the REMAINING items that appear most critical>
Suggested next action: <one concrete next step>
```

**Notes column:** one phrase, not a sentence. Goal is a scannable dashboard, not a prose report.

**Branch Commits:** For each commit in `BRANCH_COMMITS`, classify `In Scope` as YES if the commit message or changed files directly correspond to a plan deliverable (phase name, file reference, or gem reference from Step 1). Mark NO for commits unrelated to the plan.

## Step 5 — Offer next action

After the report, offer one of:
- "Want me to start on [top REMAINING item]?"
- "Want me to update the plan file's checkboxes to reflect what's done?"
- Nothing, if the plan is 100% complete — just say so.

Do not auto-start work. User decides.
