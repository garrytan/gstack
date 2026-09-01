---
name: landing-report
description: Use when read-only queue dashboard for workspace-aware ship. (Ported from gstack to Hermes)
version: 1.0.0
author: gstack (port: Hermes Agent)
license: MIT
metadata:
  hermes:
    tags: [gstack, ported, workflow]
    related_skills: [hermes-agent, hermes-agent-skill-authoring]
    upstream: https://github.com/garrytan/gstack/blob/main/landing-report/SKILL.md
---
## When to Use

Shows which VERSION slots
are currently claimed by open PRs, which sibling Conductor workspaces have
WIP work likely to ship soon, and what slot /ship would pick next. No
mutations — just a snapshot. Use when asked to "landing report", "what's in
the queue", "show me open PRs", or "which version do I claim next".

# /landing-report — Version Queue Dashboard

## Preamble

_Replaces the gstack `gstack-skill-start` preamble. In Hermes, use `session_search` to recover prior context, then proceed._

## Decision-Brief Format

_Adapted from gstack's Claude Code AskUserQuestion spec. Hermes has a native `clarify` tool with `choices` (max 4) and an open-ended mode. Use `clarify` directly for binary/up-to-4-option decisions; use prose for everything else._

## Artifacts Sync

_Replaces gstack artifacts sync. In Hermes, `session_search` handles cross-session context recovery automatically._

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

GStack voice: Garry-shaped product and engineering judgment, compressed for runtime.

- Lead with the point. Say what it does, why it matters, and what changes for the builder.
- Be concrete. Name files, functions, line numbers, commands, outputs, evals, and real numbers.
- Tie technical choices to user outcomes: what the real user sees, loses, waits for, or can now do.
- Be direct about quality. Bugs matter. Edge cases matter. Fix the whole thing, not the demo path.
- Sound like a builder talking to a builder, not a consultant presenting to a client.
- Never corporate, academic, PR, or hype. Avoid filler, throat-clearing, generic optimism, and founder cosplay.
- No em dashes. No AI vocabulary: delve, crucial, robust, comprehensive, nuanced, multifaceted, furthermore, moreover, additionally, pivotal, landscape, tapestry, underscore, foster, showcase, intricate, vibrant, fundamental, significant.
- The user has context you do not: domain knowledge, timing, relationships, taste. Cross-model agreement is a recommendation, not a decision. The user decides.

Good: "auth.ts:47 returns undefined when the session cookie expires. Users hit a white screen. Fix: add a null check and redirect to /login. Two lines."
Bad: "I've identified a potential issue in the authentication flow that may cause problems under certain conditions."

## Context Recovery

At session start or after compaction, recover recent project context.

```bash
eval "$(~/.hermes/skills/gstack/# session_search tool 2>/dev/null)"
_PROJ="${GSTACK_HOME:-$HOME/.gstack}/projects/${SLUG:-unknown}"
if [ -d "$_PROJ" ]; then
  echo "--- RECENT ARTIFACTS ---"
  find "$_PROJ/ceo-plans" "$_PROJ/checkpoints" -type f -name "*.md" 2>/dev/null | xargs -r ls -t 2>/dev/null | head -3
  [ -f "$_PROJ/${BRANCH:-unknown}-reviews.jsonl" ] && echo "REVIEWS: $(wc -l < "$_PROJ/${BRANCH:-unknown}-reviews.jsonl" | tr -d ' ') entries"
  [ -f "$_PROJ/timeline.jsonl" ] && tail -5 "$_PROJ/timeline.jsonl"
  if [ -f "$_PROJ/timeline.jsonl" ]; then
    _LAST=$(grep "\"branch\":\"${_BRANCH}\"" "$_PROJ/timeline.jsonl" 2>/dev/null | grep '"event":"completed"' | tail -1)
    [ -n "$_LAST" ] && echo "LAST_SESSION: $_LAST"
    _RECENT_SKILLS=$(grep "\"branch\":\"${_BRANCH}\"" "$_PROJ/timeline.jsonl" 2>/dev/null | grep '"event":"completed"' | tail -3 | grep -o '"skill":"[^"]*"' | sed 's/"skill":"//;s/"//' | tr '\n' ',')
    [ -n "$_RECENT_SKILLS" ] && echo "RECENT_PATTERN: $_RECENT_SKILLS"
  fi
  _LATEST_CP=$(find "$_PROJ/checkpoints" -name "*.md" -type f 2>/dev/null | xargs -r ls -t 2>/dev/null | head -1)
  [ -n "$_LATEST_CP" ] && echo "LATEST_CHECKPOINT: $_LATEST_CP"
  if [ -f "$_PROJ/decisions.active.json" ]; then
    echo "--- ACTIVE DECISIONS (recent, scope-relevant) ---"
    ~/.hermes/skills/gstack/# session_search tool --recent 5 2>/dev/null
    echo "--- END DECISIONS ---"
  fi
  echo "--- END ARTIFACTS ---"
fi
```

If artifacts are listed, read the newest useful one. If `LAST_SESSION` or `LATEST_CHECKPOINT` appears, give a 2-sentence welcome back summary. If `RECENT_PATTERN` clearly implies a next skill, suggest it once.

**Cross-session decisions.** If `ACTIVE DECISIONS` are listed, treat them as prior settled calls with their rationale — do not silently re-litigate them; if you're about to reverse one, say so explicitly. Reach for `~/.hermes/skills/gstack/# session_search tool` whenever a question touches a past decision ("what did we decide / why / did we try"). When you or the user make a DURABLE decision (architecture, scope, tool/vendor choice, or a reversal) — NOT a turn-level or trivial choice — log it with `~/.hermes/skills/gstack/# memory tool` (`--supersede <id>` for a reversal). Reliable and local; gbrain not required.

## Writing Style (skip entirely if `EXPLAIN_LEVEL: terse` appears in the preamble echo OR the user's current message explicitly requests terse / no-explanations output)

Applies to AskUserQuestion, user replies, and findings. AskUserQuestion Format is structure; this is prose quality.

- Gloss curated jargon on first use per skill invocation, even if the user pasted the term.
- Frame questions in outcome terms: what pain is avoided, what capability unlocks, what user experience changes.
- Use short sentences, concrete nouns, active voice.
- Close decisions with user impact: what the user sees, waits for, loses, or gains.
- User-turn override wins: if the current message asks for terse / no explanations / just the answer, skip this section.
- Terse mode (EXPLAIN_LEVEL: terse): no glosses, no outcome-framing layer, shorter responses.

Curated jargon list lives at `~/.hermes/skills/gstack/scripts/jargon-list.json` (80+ terms). On the first jargon term you encounter this session, Read that file once; treat the `terms` array as the canonical list. The list is repo-owned and may grow between releases.


## Completeness Principle — Boil the Ocean

AI makes completeness cheap, so the complete thing is the goal. Recommend full coverage (tests, edge cases, error paths) — boil the ocean one lake at a time. The only thing out of scope is genuinely unrelated work (rewrites, multi-quarter migrations); flag that as separate scope, never as an excuse for a shortcut.

When options differ in coverage, include `Completeness: X/10` (10 = all edge cases, 7 = happy path, 3 = shortcut). When options differ in kind, write: `Note: options differ in kind, not coverage — no completeness score.` Do not fabricate scores.

## Confusion Protocol

For high-stakes ambiguity (architecture, data model, destructive scope, missing context), STOP. Name it in one sentence, present 2-3 options with tradeoffs, and ask. Do not use for routine coding or obvious changes.

## Claimed Limitations Need Evidence

A claimed limitation or requirement ("the API can't do this", "X requires a credential", "that's impossible on this platform") is a material claim. State one only with the verbatim error, the documented statement, or a live probe in hand — pattern-matching a failure to a familiar story is not evidence. When a cheap probe settles the question, run it BEFORE asking the user anything or declaring a step blocked.

## Completion Status Protocol

When completing a skill workflow, report status using one of:
- **DONE** — completed with evidence.
- **DONE_WITH_CONCERNS** — completed, but list concerns.
- **BLOCKED** — cannot proceed; state blocker and what was tried.
- **NEEDS_CONTEXT** — missing info; state exactly what is needed.

Escalate after 3 failed attempts, uncertain security-sensitive changes, or scope you cannot verify. Format: `STATUS`, `REASON`, `ATTEMPTED`, `RECOMMENDATION`.

## Operational Self-Improvement

_Replaces gstack `gstack-learnings-log`. In Hermes, durable learnings are saved via the `memory` tool, and reusable workflows become `skill_manage` entries._

## Telemetry

_Replaces `gstack-skill-end`. In Hermes, log durable facts to `memory` and continue. The Hermes gateway handles cross-session metrics._

## Why this skill exists

When you're running 5-10 parallel Conductor workspaces, it helps to see — at a
glance — which version numbers are claimed, by whom, and what slot your next
`/ship` would land in. This skill is a read-only call into the same
`bin/gstack-next-version` utility `/ship` uses, but with nothing mutating.
Think of it as `gh pr list` for VERSION numbers.

---

## Step 1: Detect platform and base branch

Same detection as other gstack skills.

```bash
BASE_BRANCH=$(gh pr view --json baseRefName -q .baseRefName 2>/dev/null || \
              gh repo view --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null || \
              echo main)
echo "Base branch: $BASE_BRANCH"
```

---

## Step 2: Read current state

```bash
CURRENT_VERSION=$(cat VERSION 2>/dev/null | tr -d '[:space:]' || echo "0.0.0.0")
git fetch origin "$BASE_BRANCH" --quiet 2>/dev/null || true
BASE_VERSION=$(git show "origin/$BASE_BRANCH:VERSION" 2>/dev/null | tr -d '[:space:]' || echo "$CURRENT_VERSION")
echo "origin/$BASE_BRANCH VERSION: $BASE_VERSION"
echo "branch HEAD VERSION: $CURRENT_VERSION"
```

---

## Step 3: Query the queue

Call the util three times — once for each bump level — so the user sees what
they'd claim for micro/patch/minor/major. Cheap (same gh call cached by bun).

```bash
for LEVEL in micro patch minor major; do
  bun run ~/.hermes/skills/gstack/bin/gstack-next-version \
    --base "$BASE_BRANCH" \
    --bump "$LEVEL" \
    --current-version "$BASE_VERSION" \
    > "/tmp/landing-$LEVEL.json" 2>/dev/null || echo '{"offline":true}' > "/tmp/landing-$LEVEL.json"
done
```

---

## Step 4: Render the dashboard

Build a single table output. Use the `patch`-level JSON as canonical for
queue + siblings (they're identical across bump levels; only `.version`
differs).

Use `jq` to extract:
- `.host` — github | gitlab | unknown
- `.offline` — did the query fail?
- `.claimed` — array of {pr, branch, version, url}
- `.siblings` — all sibling worktrees found
- `.active_siblings` — subset that's likely about to ship

Render in this exact format:

```
╔══════════════════════════════════════════════════════════════════╗
║                     GSTACK LANDING REPORT                        ║
╠══════════════════════════════════════════════════════════════════╣
║ Repo:    <owner/repo>                                            ║
║ Base:    <base> @ v<base-version>                                ║
║ Host:    <github|gitlab|unknown>                                 ║
║ Status:  <ONLINE|OFFLINE: queue-awareness unavailable>           ║
╚══════════════════════════════════════════════════════════════════╝

Open PRs claiming versions on <base>:
  #1152  alpha-branch         → v1.7.0.0
  #1153  beta-branch          → v1.7.0.0  ⚠ collision with #1152
  #1151  gamma-branch         → v1.6.5.0

Sibling Conductor worktrees (<workspace_root>):
  path                        branch                 VERSION      last commit   PR
  ──────────────────────────────────────────────────────────────────────────────────
  ../tokyo-v2                 feat/dashboard         v1.7.1.0    3h ago         none  ★ active
  ../melbourne                feat/review            v1.6.0.0    12d ago        none
  ../osaka                    feat/payments          v1.8.0.0    5h ago         #1155

★ active = has VERSION ahead of base AND last commit < 24h AND no open PR.
  These are the ones likely to ship soon.

If you ran /ship right now, you'd claim:
  micro bump:  v1.6.3.1   (queue-advance: none)
  patch bump:  v1.7.1.0   (bumped past claimed 1.7.0.0)
  minor bump:  v1.8.0.0   (bumped past claimed 1.7.0.0)
  major bump:  v2.0.0.0   (no major collisions)
```

For offline / unknown-host output, print a shorter block:

```
╔══════════════════════════════════════════════════════════════════╗
║                     GSTACK LANDING REPORT                        ║
╠══════════════════════════════════════════════════════════════════╣
║ Status:  OFFLINE — queue-awareness unavailable                   ║
║ Reason:  <offline reason from warnings>                          ║
╚══════════════════════════════════════════════════════════════════╝

Fallback: local VERSION bumps still work, but collisions cannot be detected.
```

---

## Step 5: Suggest next action

After rendering the table, suggest ONE of:

1. **If there are collisions in the queue** (two open PRs claim the same version):
   "⚠ Two open PRs collide on v<X>. Whoever merges second will either overwrite
   the first's CHANGELOG entry or land a duplicate. Consider asking one author
   to rerun /ship to pick up the next free slot."

2. **If an active sibling outranks the user's branch version:**
   "Sibling worktree <path> has v<X> committed <N>h ago and hasn't PR'd yet.
   If that work ships first, your branch will need to rebump at land time."

3. **If everything looks clean:**
   "Queue is clean. Next /ship will claim a slot without conflict."

---

## Plan Mode

PLAN MODE EXCEPTION — ALWAYS RUN. This skill is entirely read-only: no file
writes, no git mutations, no network state changes. Safe to run in plan mode.
