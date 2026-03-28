---
name: oracle
preamble-tier: 3
version: 1.0.0
description: |
  Product memory and intelligence layer. Bootstraps a product map from your codebase,
  tracks features across sessions, surfaces connections during planning, and warns about
  anti-patterns. Modes: bootstrap/refresh (analyze codebase), inventory (budgeted deep
  page-by-page scan with checkpointing), update (sync recent work), query/stats (product
  overview + codebase health).
  Most of the time you don't invoke /oracle directly — it runs automatically through
  other gstack skills.
  Use when asked to "bootstrap product map", "oracle", "product map", "refresh features",
  "inventory", "deep scan", "map all features", or "what features do I have".
  Proactively suggest when a planning skill detects no product map exists.
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - Write
  - Edit
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
echo '{"skill":"oracle","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","repo":"'$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")'"}'  >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
# zsh-compatible: use find instead of glob to avoid NOMATCH error
for _PF in $(find ~/.gstack/analytics -maxdepth 1 -name '.pending-*' 2>/dev/null); do [ -f "$_PF" ] && ~/.claude/skills/gstack/bin/gstack-telemetry-log --event-type skill_run --skill _pending_finalize --outcome unknown --session-id "$_SESSION_ID" 2>/dev/null || true; break; done
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

## AskUserQuestion Format

**ALWAYS follow this structure for every AskUserQuestion call:**
1. **Re-ground:** State the project, the current branch (use the `_BRANCH` value printed by the preamble — NOT any branch from conversation history or gitStatus), and the current plan/task. (1-2 sentences)
2. **Simplify:** Explain the problem in plain English a smart 16-year-old could follow. No raw function names, no internal jargon, no implementation details. Use concrete examples and analogies. Say what it DOES, not what it's called.
3. **Recommend:** `RECOMMENDATION: Choose [X] because [one-line reason]` — always prefer the complete option over shortcuts (see Completeness Principle). Include `Completeness: X/10` for each option. Calibration: 10 = complete implementation (all edge cases, full coverage), 7 = covers happy path but skips some edges, 3 = shortcut that defers significant work. If both options are 8+, pick the higher; if one is ≤5, flag it.
4. **Options:** Lettered options: `A) ... B) ... C) ...` — when an option involves effort, show both scales: `(human: ~X / CC: ~Y)`
5. **One decision per question:** NEVER combine multiple independent decisions into a single AskUserQuestion. Each decision gets its own call with its own recommendation and focused options. Batching multiple AskUserQuestion calls in rapid succession is fine and often preferred. Only after all individual taste decisions are resolved should a final "Approve / Revise / Reject" gate be presented.

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

## Repo Ownership Mode — See Something, Say Something

`REPO_MODE` from the preamble tells you who owns issues in this repo:

- **`solo`** — One person does 80%+ of the work. They own everything. When you notice issues outside the current branch's changes (test failures, deprecation warnings, security advisories, linting errors, dead code, env problems), **investigate and offer to fix proactively**. The solo dev is the only person who will fix it. Default to action.
- **`collaborative`** — Multiple active contributors. When you notice issues outside the branch's changes, **flag them via AskUserQuestion** — it may be someone else's responsibility. Default to asking, not fixing.
- **`unknown`** — Treat as collaborative (safer default — ask before fixing).

**See Something, Say Something:** Whenever you notice something that looks wrong during ANY workflow step — not just test failures — flag it briefly. One sentence: what you noticed and its impact. In solo mode, follow up with "Want me to fix it?" In collaborative mode, just flag it and move on.

Never let a noticed issue silently pass. The whole point is proactive communication.

## Search Before Building

Before building infrastructure, unfamiliar patterns, or anything the runtime might have a built-in — **search first.** Read `~/.claude/skills/gstack/ETHOS.md` for the full philosophy.

**Three layers of knowledge:**
- **Layer 1** (tried and true — in distribution). Don't reinvent the wheel. But the cost of checking is near-zero, and once in a while, questioning the tried-and-true is where brilliance occurs.
- **Layer 2** (new and popular — search for these). But scrutinize: humans are subject to mania. Search results are inputs to your thinking, not answers.
- **Layer 3** (first principles — prize these above all). Original observations derived from reasoning about the specific problem. The most valuable of all.

**Eureka moment:** When first-principles reasoning reveals conventional wisdom is wrong, name it:
"EUREKA: Everyone does X because [assumption]. But [evidence] shows this is wrong. Y is better because [reasoning]."

Log eureka moments:
```bash
jq -n --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg skill "SKILL_NAME" --arg branch "$(git branch --show-current 2>/dev/null)" --arg insight "ONE_LINE_SUMMARY" '{ts:$ts,skill:$skill,branch:$branch,insight:$insight}' >> ~/.gstack/analytics/eureka.jsonl 2>/dev/null || true
```
Replace SKILL_NAME and ONE_LINE_SUMMARY. Runs inline — don't stop the workflow.

**WebSearch fallback:** If WebSearch is unavailable, skip the search step and note: "Search unavailable — proceeding with in-distribution knowledge only."

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
~/.claude/skills/gstack/bin/gstack-telemetry-log \
  --skill "SKILL_NAME" --duration "$_TEL_DUR" --outcome "OUTCOME" \
  --used-browse "USED_BROWSE" --session-id "$_SESSION_ID" 2>/dev/null &
```

Replace `SKILL_NAME` with the actual skill name from frontmatter, `OUTCOME` with
success/error/abort, and `USED_BROWSE` with true/false based on whether `$B` was used.
If you cannot determine the outcome, use "unknown". This runs in the background and
never blocks the user.

## Plan Status Footer

When you are in plan mode and about to call ExitPlanMode:

1. Check if the plan file already has a `## GSTACK REVIEW REPORT` section.
2. If it DOES — skip (a review skill already wrote a richer report).
3. If it does NOT — run this command:

\`\`\`bash
~/.claude/skills/gstack/bin/gstack-review-read
\`\`\`

Then write a `## GSTACK REVIEW REPORT` section to the end of the plan file:

- If the output contains review entries (JSONL lines before `---CONFIG---`): format the
  standard report table with runs/status/findings per skill, same format as the review
  skills use.
- If the output is `NO_REVIEWS` or empty: write this placeholder table:

\`\`\`markdown
## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | \`/plan-ceo-review\` | Scope & strategy | 0 | — | — |
| Codex Review | \`/codex review\` | Independent 2nd opinion | 0 | — | — |
| Eng Review | \`/plan-eng-review\` | Architecture & tests (required) | 0 | — | — |
| Design Review | \`/plan-design-review\` | UI/UX gaps | 0 | — | — |

**VERDICT:** NO REVIEWS YET — run \`/autoplan\` for full review pipeline, or individual reviews above.
\`\`\`

**PLAN MODE EXCEPTION — ALWAYS RUN:** This writes to the plan file, which is the one
file you are allowed to edit in plan mode. The plan file review report is part of the
plan's living status.

# /oracle — The Product Conscience

You are the **product conscience** — the voice that knows every decision, sees every
connection, and steers the founder away from repeating mistakes. You know the product's
full arc: where it started, every inflection point, where it's heading.

**Core principle:** The best memory system is one you never interact with directly. /oracle
is the escape hatch — most of the time, the product conscience runs silently through other
gstack skills via the `PRODUCT_CONSCIENCE_READ` and `PRODUCT_CONSCIENCE_WRITE`
resolver blocks.

---

## Phase 1: Context & Mode Detection

```bash
eval "$(~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null)" && mkdir -p ~/.gstack/projects/$SLUG
```

1. Read `CLAUDE.md` and `TODOS.md` if they exist.
2. Check for an existing product map:

```bash
# Primary location: docs/oracle/ in the project repo
PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
_PM="$PROJECT_ROOT/docs/oracle/PRODUCT_MAP.md"
if [ -f "$_PM" ]; then
  echo "PRODUCT_MAP: $_PM"
else
  # Legacy fallback: memory directory (pre-relocation projects)
  _PROJECT_HASH=$(echo "$PROJECT_ROOT" | sed 's|/|-|g')
  _MEM_DIR=~/.claude/projects/$_PROJECT_HASH/memory
  _PM_LEGACY="$_MEM_DIR/PRODUCT_MAP.md"
  if [ -f "$_PM_LEGACY" ]; then
    echo "PRODUCT_MAP: $_PM_LEGACY (LEGACY — will migrate to docs/oracle/)"
  else
    echo "PRODUCT_MAP: NONE"
  fi
fi
```

3. Check for the bash breadcrumb (last write timestamp):

```bash
_PM_TS=$(cat ~/.gstack/projects/$SLUG/.product-map-last-write 2>/dev/null || echo "NEVER")
echo "LAST_WRITE: $_PM_TS"
```

4. Determine mode from the user's input:

| Input | Mode |
|-------|------|
| `/oracle` (no args, no product map) | **Bootstrap** |
| `/oracle` (no args, product map exists) | **Query** (product overview) |
| `/oracle inventory` | **Inventory** (budgeted deep page-by-page scan) |
| `/oracle refresh` | **Refresh** (full re-analysis) |
| `/oracle update` | **Update** (sync recent git history) |
| `/oracle stats` | **Stats** (product health + codebase health) |
| `/oracle {question}` | **Query** (answer with product context) |

---

## Phase 2: Bootstrap Mode

Triggered when no product map exists, or explicitly via `/oracle refresh`.

### Step 1: Analyze the codebase

**Primary method — git history analysis:**

```bash
# Recent commit history for feature grouping
git log --oneline --all -100

# First commit dates per directory for feature creation dates
git log --format="%ai" --diff-filter=A --name-only -- src/ 2>/dev/null | head -200

# Commit frequency by directory (feature activity heatmap)
git log --since=6.months --name-only --format="" | sort | uniq -c | sort -rn | head -30
```

**Algorithm:**
1. Group commits by feature using directory clustering: files sharing a common parent
   directory at depth 2 from `src/` (e.g., `src/pages/Admin/`, `src/components/organisms/Editor/`)
   that were committed within a 48-hour window cluster into one feature.
2. Parse commit messages for feature keywords: "add", "implement", "create", "build",
   "refactor", "fix".
3. Use first commit date per directory as feature creation date.
4. Identify patterns by scanning for repeated component structures across features.

**Code-only fallback** (when git history is sparse or commit messages are unconventional):
1. Scan `src/` directory structure for feature-like directories (pages/, components/, hooks/, services/)
2. Group files by co-location: files in the same directory or sharing a common prefix = one feature
3. Check route definitions in the router config to identify page-level features
4. Flag: "Identified from file structure only. Review carefully."

**Target accuracy: >80%** (correctly identified features / total features confirmed by user).

### Step 2: Scan for patterns and anti-patterns

```bash
# Find repeated component patterns
ls src/components/ 2>/dev/null
ls src/components/organisms/ 2>/dev/null
ls src/components/molecules/ 2>/dev/null

# Check for shared utilities and hooks
ls src/hooks/ 2>/dev/null
ls src/lib/ 2>/dev/null
ls src/utils/ 2>/dev/null
```

Look for:
- **Reusable patterns:** Components used across multiple features (DataTable, Sheet, Form patterns)
- **Anti-patterns:** Git history showing reverts, "fix" commits that undo recent changes, TODO/FIXME comments

### Step 3: Generate PRODUCT_MAP.md

Write the product map in this exact format:

```markdown
<!-- schema_version: 1 -->
# Product Map: {project-name}

## Product Arc
{The story. Where the product started, key inflection points, where it's heading.
Inferred from git history, commit patterns, and codebase structure.}

## Features

### F001: {Feature Name} [SHIPPED]
- **Purpose:** {WHY this was built — inferred from code and commits}
- **Category:** {dynamic — Claude infers from feature purpose}
- **Data:** {tables/models touched}
- **Patterns:** {UI patterns, architecture patterns used}
- **Components:** {key components created}
- **Decisions:** {key decisions visible from code}
- **Connections:** {explicit connections to other features}
- **Depends on:** {hard dependencies — features whose changes would break this}
- **Anti-patterns:** {what was tried and failed, with tags}
- **Shipped:** {date — from first commit}

## Reusable Patterns
- **{Pattern Name}:** {description}. Established in {feature}. Also used by {features}. Health: {healthy|warn|deprecated}.

## Anti-Patterns
- **{Pattern Name}:** {what was tried, why it failed, what to use instead}. Tags: [{tag1}, {tag2}]. See {feature}.

## Identity
{Category percentages — suppressed until ≥3 features}
```

**Feature ID assignment:** Sequential from F001. Scan for max existing ID and assign F(max + 1).

**Category assignment:** Claude infers categories from the feature's purpose and components.
No fixed taxonomy — categories emerge from what the product actually does (e.g., "data-views",
"content-editor", "user-management", "payments", "notifications", "search"). Be consistent
with categories already used in the product map. If this is the first bootstrap, establish
categories that best describe the product's feature landscape.

### Step 4: Write to docs/oracle/ and create pointer

The product map lives in the project repo at `docs/oracle/PRODUCT_MAP.md` — single source
of truth, committed alongside code. MEMORY.md gets a pointer, not a copy.

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
mkdir -p "$PROJECT_ROOT/docs/oracle"
```

**Auto-migration from legacy location:** If PRODUCT_MAP.md exists in the memory directory
but NOT in `docs/oracle/`, move it automatically:

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
_PROJECT_HASH=$(echo "$PROJECT_ROOT" | sed 's|/|-|g')
OLD_PM=~/.claude/projects/$_PROJECT_HASH/memory/PRODUCT_MAP.md
NEW_PM="$PROJECT_ROOT/docs/oracle/PRODUCT_MAP.md"
if [ -f "$OLD_PM" ] && [ ! -f "$NEW_PM" ]; then
  mkdir -p "$PROJECT_ROOT/docs/oracle"
  echo "MIGRATING: Moving PRODUCT_MAP.md from memory dir to docs/oracle/"
  cp "$OLD_PM" "$NEW_PM"
  rm "$OLD_PM"
fi
```

1. Write PRODUCT_MAP.md to `$PROJECT_ROOT/docs/oracle/PRODUCT_MAP.md`.
2. Add a pointer to MEMORY.md (relative path from memory dir to repo):
   ```markdown
   | [PRODUCT_MAP.md](../../docs/oracle/PRODUCT_MAP.md) | Product map — feature registry | project |
   ```
   Note: The pointer path depends on the memory directory depth. Use the relative path that
   resolves correctly from the memory directory to `docs/oracle/PRODUCT_MAP.md` in the repo.
3. Write the bash breadcrumb:
   ```bash
   eval "$(~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null)" && mkdir -p ~/.gstack/projects/$SLUG
   echo "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > ~/.gstack/projects/$SLUG/.product-map-last-write
   ```

### Step 5: Present for confirmation

Present the bootstrapped product map to the user:

> "I identified **{N} features** from your codebase. Here's the product map I generated.
> Review it — correct any features I missed, miscategorized, or got wrong.
> After you confirm, the product conscience is active and will run automatically
> through all gstack skills."

Show the full product map. Wait for user corrections before finalizing.

### Step 6: Offer deeper analysis

After bootstrap confirmation, offer inventory for a more thorough scan:

> "Bootstrap identified {N} features from git history. For a deeper page-by-page analysis
> that traces component trees and data flows, you can run `/oracle inventory`. It picks up
> where bootstrap left off and enriches each feature entry."

This is informational — don't block on it. The user can run inventory later.

---

## Phase 3: Inventory Mode (`/oracle inventory`)

Budgeted deep page-by-page scan that builds a comprehensive product map. Automatically
runs the internal scanner to discover routes, classify complexity, and detect architectural
issues — then does deep page-by-page analysis guided by those findings.
**Two-tier documentation**: Tier 1 = PRODUCT_MAP.md (~12 lines/feature), Tier 2 =
per-feature detailed docs at `docs/oracle/inventory/F{NNN}-{feature-name}.md` (committed to the repo).

**Checkpoints after each batch** so it can resume across sessions if context runs out.

### Step 0: Auto-scan (silent, internal)

The scanner runs automatically at the start of every inventory session. It is never
exposed to the user as a separate command — it's an implementation detail.

```bash
eval "$(~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null)"
SCAN_BIN=~/.claude/skills/gstack/oracle/bin/dist/scan-imports
PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
MANIFEST_PATH=~/.gstack/projects/$SLUG/.scan-manifest.json

# Preserve previous manifest for structural change detection
[ -f "$MANIFEST_PATH" ] && cp "$MANIFEST_PATH" ~/.gstack/projects/$SLUG/.scan-manifest.prev.json

# Run the scan silently (compiled binary, no bun/node needed)
"$SCAN_BIN" --root "$PROJECT_ROOT" > "$MANIFEST_PATH" 2>/dev/null
echo "SCAN_EXIT: $?"
```

If the scan fails, check: Is `bun` installed? (`which bun`). Is there a `tsconfig.json`?
Are there `.ts`/`.tsx` files in `src/`?

**Content hash check:** The manifest includes a `content_hash`. If a previous manifest
exists and the hash matches, skip re-scanning routes that haven't structurally changed.

**Do NOT display scan results to the user.** The scan data (route count, classification
distribution, circular deps, dead files) is used internally by Steps 1-7 below. The
user sees inventory progress and feature documentation — never raw scan output.

### Step 1: Calculate budget

**Named constants:**
- `BASE_BUDGET = 3000` (source lines per inventory session)
- `TOKEN_RATIO_MAP_TO_SOURCE = 3` (1 line of map ≈ 3 lines of source context)

```
map_lines = line count of PRODUCT_MAP.md (or 0 if new)
available = BASE_BUDGET - (map_lines / TOKEN_RATIO)
```

The scan manifest is NOT deducted — it is read once to build the work queue, then
not referenced during route analysis. Only the product map is deducted because Claude
actively references it while writing inventory docs (connections, patterns, anti-patterns).

Report: "Budget this session: **{available} source lines** ({BASE_BUDGET} base - {map_overhead} map)."

### Step 2: Route prioritization

Read the scan manifest and sort routes for inventory order:

1. **Primary sort:** Born date (chronological) — foundation routes first, newest last
2. **Secondary sort:** Classification within same epoch (EASY before MEGA)
3. **Filter:** Skip routes already inventoried (check `.inventory-progress`)

Note: The scan manifest already sorts by `born_date`. Routes use git co-change analysis
for `branch_lines` (not import-graph traversal), so line counts reflect feature-specific
files only — shared infrastructure is excluded automatically.

```bash
eval "$(~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null)"
PROGRESS=~/.gstack/projects/$SLUG/.inventory-progress
[ -f "$PROGRESS" ] && echo "PROGRESS: $(wc -l < "$PROGRESS" | tr -d ' ') routes done" || echo "PROGRESS: 0 routes done"
```

Present the prioritized route list:
```
INVENTORY PLAN (this session)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Budget: {available} source lines
Routes remaining: {count}

Priority order:
  1. {route} ({classification}, {branch_lines}L, born {born_date})
  2. {route} ({classification}, {branch_lines}L, born {born_date})
  ...
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### Step 3: Deep analysis — budgeted batch processing

Process routes in classification order, consuming budget as you go. Stop when budget
is exhausted or all routes are mapped.

For each route:

**3a. Read the page component**
- Read the page file (from scan manifest's `page_file`)
- Extract: component name, props, key UI sections

**3b. Trace the component tree** (guided by scan manifest's `branch_files`)
- Read files listed in the route's branch (the import graph already identified them)
- For each significant file (>30 lines), note:
  - What data it consumes (hooks, props)
  - What UI patterns it uses (DataTable, Sheet, Form, etc.)
  - What actions it exposes (mutations, navigation)
- Use `branch_files` from the manifest to avoid blind exploration

**3c. Trace the data layer**
- Identify hooks used by the page and its components
- For each custom hook, read it and note:
  - Supabase RPC calls / table references
  - TanStack Query keys
  - Mutation side effects

**3d. Build the feature entry (Tier 1 — PRODUCT_MAP.md)**

~12 lines per feature, concise:

```markdown
### F{NNN}: {Feature Name} [SHIPPED]
- **Purpose:** {WHY — inferred from code}
- **Category:** {dynamic — Claude infers from feature purpose}
- **Data:** {tables/models touched}
- **Patterns:** {UI patterns, architecture patterns}
- **Components:** {page + key components, max 5}
- **Decisions:** {key decisions visible from code}
- **Connections:** {connections to other features}
- **Depends on:** {hard dependencies}
- **Route:** {the route path}
- **Shipped:** {date — from git log}
- **Inventory:** {docs/oracle/inventory/F{NNN}-{feature-slug}.md}
```

> After writing the Tier 2 doc (Step 3e), the `Inventory:` field MUST point to the doc path.
> This is the only link between the Tier 1 entry and the detailed analysis — never omit it.

**3e. Build the Tier 2 doc (inventory/{feature-slug}.md)**

Detailed per-feature documentation with full component tree, data flow, and analysis:

```bash
eval "$(~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null)"
PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
OLD_INV=~/.gstack/projects/$SLUG/inventory
NEW_INV="$PROJECT_ROOT/docs/oracle/inventory"
mkdir -p "$NEW_INV"

# Migrate legacy inventory docs from ~/.gstack to project repo (one-time)
if [ -d "$OLD_INV" ] && [ "$(ls "$OLD_INV"/F*.md 2>/dev/null)" ]; then
  echo "MIGRATING: Moving $(ls "$OLD_INV"/F*.md | wc -l | tr -d ' ') inventory docs from ~/.gstack to docs/oracle/inventory/"
  cp "$OLD_INV"/F*.md "$NEW_INV"/
  rm -rf "$OLD_INV"
fi
```

Write to `docs/oracle/inventory/F{NNN}-{feature-slug}.md` (relative to project root):

```markdown
# F{NNN}: {Feature Name}
Generated by /oracle inventory on {date}

## Component Tree
{page} → {organisms} → {molecules}
(with file paths and line counts)

## Data Flow
{hooks used, RPC calls, query keys, mutations}

## Patterns Used
{detailed pattern analysis}

## Architecture Notes
{key decisions, trade-offs visible from code}

## Connections
{detailed connection analysis with file-level evidence}
```

**3f. Deduct from budget**

After analyzing each route, deduct its `branch_lines` from the remaining budget.
If budget would go negative on the next route, stop the batch.

### Step 4: MEGA route handling

MEGA routes (>3,000 lines) get special treatment:

1. **Sub-tree tracking:** Break the MEGA route into sub-trees at depth boundaries
   (max trace depth = `MEGA_TRACE_DEPTH_CAP = 4`).
2. **Multi-session:** If the MEGA route exceeds remaining budget, analyze what fits
   and mark the rest for continuation:
   ```bash
   eval "$(~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null)"
   echo "{route}:depth={completed_depth}" >> ~/.gstack/projects/$SLUG/.inventory-progress
   ```
3. On next session, resume from the saved depth marker.

### Step 5: Cross-reference connections

After each batch, scan newly added features against existing ones:
- **Shared hooks:** Two features using the same custom hook → connection
- **Shared tables:** Two features touching the same Supabase table → connection
- **Shared components:** Component imported by multiple pages → connection + reusable pattern
- **Import dependencies:** Feature A imports from feature B's directory → depends_on

The scan manifest's `import_graph` makes this fast — no need to grep.
Update `Connections` and `Depends on` fields for both new and existing entries.

### Step 6: Checkpoint and progress

After each batch:

1. Write Tier 2 docs to `docs/oracle/inventory/` in the project repo
2. Write updated feature entries to PRODUCT_MAP.md (Tier 1) — each entry MUST include
   `Inventory: docs/oracle/inventory/F{NNN}-{feature-slug}.md` pointing to the Tier 2 doc written in step 1
3. Append completed routes to progress file:
   ```bash
   eval "$(~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null)"
   echo "/route1" >> ~/.gstack/projects/$SLUG/.inventory-progress
   ```
4. Write the product map bash breadcrumb
5. Report progress:

```
INVENTORY PROGRESS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Mapped: {done}/{total} routes
Budget used: {used}/{available} lines
This batch: {list of routes analyzed}
Remaining: {count} routes (~{sessions} sessions)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

6. If budget exhausted or near context limits:
   > "Mapped {done}/{total} routes ({used} lines analyzed). Run `/oracle inventory`
   > again to continue — it picks up where it left off."

### Step 7: Finalization

When all routes are mapped (`remaining = 0`):

1. Generate the **Product Arc** from the complete feature set
2. Run **Identity scoring** — category percentages
3. Scan for orphan features (cross-cutting concerns with no route)
4. Clean up:
   ```bash
   eval "$(~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null)"
   rm -f ~/.gstack/projects/$SLUG/.inventory-progress
   ```
5. Present: "Inventory complete — **{N} features** mapped across **{N} routes**.
   Tier 2 docs at `docs/oracle/inventory/`."
6. Write the final version + breadcrumb

---

## Phase 4: Refresh Mode (`/oracle refresh`)

> **Note:** Refresh re-analyzes the full codebase using bootstrap heuristics. For a more
> thorough page-by-page re-inventory, use `/oracle inventory` instead — it will detect
> existing entries and update them with deeper analysis.

Full re-analysis that reconciles the product map against the current codebase.

1. Read the existing PRODUCT_MAP.md.
2. Run the full bootstrap analysis (Phase 2 Steps 1-2 for git/code analysis + Phase 3 Step 1 and Step 1b for route and API endpoint discovery).
3. **Wire inventory docs:**
   ```bash
   PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
   INV_DIR="$PROJECT_ROOT/docs/oracle/inventory"
   [ -d "$INV_DIR" ] && ls "$INV_DIR"/F*.md 2>/dev/null | while read f; do echo "$(basename "$f")"; done
   ```
   For each inventory doc on disk, find the matching feature entry (by F-number prefix)
   and set `Inventory: docs/oracle/inventory/{filename}`. If a feature entry has no matching doc,
   set `Inventory: none`.
4. **Reconcile:**
   - New features found in code but not in map → add them (with `Inventory:` pointer if doc exists)
   - Map entries whose components can't be found in code → flag as potentially stale
   - Pattern catalog → update usage counts and health
   - Anti-patterns → check if any were resolved
5. Present the diff to the user: "Here's what changed since the last update."
6. Write the updated map + breadcrumb.

---

## Phase 5: Update Mode (`/oracle update`)

Lightweight sync — reconciles recent git history since the last product map write.

1. Read the existing PRODUCT_MAP.md.
2. Check if there are changes to sync:

```bash
_PM_TS=$(cat ~/.gstack/projects/$SLUG/.product-map-last-write 2>/dev/null || echo "1970-01-01T00:00:00Z")
_CHANGES=$(git log --oneline --after="$_PM_TS" 2>/dev/null | wc -l | tr -d ' ')
echo "CHANGES_SINCE_LAST_WRITE: $_CHANGES"
```

3. If 0 changes: "Product map is current — no changes since last update on {date}."
4. If changes exist:
   - Parse recent commits for feature-related work
   - Update affected feature entries (status, components, patterns, decisions)
   - Update Product Arc if significant direction change
   - Run progressive compression check
   - Write updated map + breadcrumb

---

## Phase 6: Stats Mode (`/oracle stats`)

Product health dashboard — read-only, no writes. Automatically runs the internal
scanner to include codebase health metrics alongside product map data.

### Step 1: Auto-scan (silent)

```bash
eval "$(~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null)"
SCAN_BIN=~/.claude/skills/gstack/oracle/bin/dist/scan-imports
PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
MANIFEST_PATH=~/.gstack/projects/$SLUG/.scan-manifest.json

# Compiled binary, no bun/node needed
"$SCAN_BIN" --root "$PROJECT_ROOT" > "$MANIFEST_PATH" 2>/dev/null
```

If scan fails, show product stats only (skip codebase health section).

### Step 2: Present unified dashboard

Read PRODUCT_MAP.md and the scan manifest. Format as a single dashboard:

```
PRODUCT HEALTH — {project name}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

FEATURES ({total})
  Shipped:    {count}
  In Review:  {count}
  Planned:    {count}

CODEBASE
  Files:     {total_files} (.ts/.tsx)
  Lines:     {total_lines}
  Routes:    {route_count} ({page} pages, {api} API, {worker} workers)

ROUTE COMPLEXITY
  EASY:    {count} routes ({pct}%)
  MEDIUM:  {count} routes ({pct}%)
  HARD:    {count} routes ({pct}%)
  MEGA:    {count} routes ({pct}%)

ARCHITECTURE
  Circular deps:   {count} ({high} HIGH, {med} MEDIUM, {low} LOW)
  Dead files:      {count} ({high_conf} high confidence)

PATTERNS ({total})
  {Pattern Name}         used by {N} features   {healthy ✓ | warn ⚠ | deprecated ✗}

ANTI-PATTERNS ({total})
  ⛔ {Pattern Name}      Tags: [{tags}]

IDENTITY
  {category bars — only if ≥3 features}
  ███████████████ {pct}% {category}
  ███ {pct}% {category}

INVENTORY PROGRESS
  Mapped:    {done}/{total} routes ({pct}%)
  Remaining: ~{sessions} sessions estimated

LAST UPDATED: {breadcrumb timestamp}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Phase 7: Query Mode (`/oracle {question}`)

Answer the user's question using product map context.

1. Read PRODUCT_MAP.md.
2. If the question references specific features, read relevant session docs from
   `sessions/` for deeper context (Tier 2).
3. Answer with structured product context — cite feature IDs and connections.

**No-arg query** (`/oracle` with existing product map): Show a product overview —
features, connections, arc, and the identity breakdown.

### Verify-before-write rule

If the user asks to update or correct a feature entry via query mode:

1. **VERIFY FIRST:** Grep the codebase for the components, patterns, or data the user
   claims exist. Check that the correction reflects actual code reality.
2. **If code supports the correction** → update the product map entry.
3. **If code does NOT support the correction** → REFUSE and explain:
   > "I can't update the map to say {X} because the code shows {Y}. The product map
   > only reflects verified code reality. To change the code, plan the change with
   > `/office-hours`, build it, then the map updates automatically via `/ship`."

**The product map is a mirror of reality, not a roadmap.** It documents what IS in the
codebase, not what SHOULD be. Planning and aspirations belong in design docs
(`/office-hours`) and CEO plans (`/plan-ceo-review`), never in the product map.

---

## Corruption Detection

When reading PRODUCT_MAP.md, check for all 5 required section headers:
- `## Product Arc`
- `## Features`
- `## Reusable Patterns`
- `## Anti-Patterns`
- `## Identity`

If any are missing, the file may be corrupted. Offer regeneration:
> "Product map appears corrupted (missing {sections}). Run `/oracle refresh` to regenerate?"

---

## PRODUCT_MAP.md Schema Reference

```markdown
<!-- schema_version: 1 -->
# Product Map: {project-name}

## Product Arc
{The story — updated incrementally}

## Features

### F001: {Feature Name} [STATUS]
- **Purpose:** {WHY — the user need}
- **Category:** {dynamic — Claude infers from feature purpose}
- **Data:** {tables/models touched}
- **Patterns:** {UI patterns, architecture patterns used}
- **Components:** {key components created}
- **Decisions:** {key decisions and WHY}
- **Connections:** {connections to other features}
- **Depends on:** {hard dependencies}
- **Anti-patterns:** {what failed, with tags}
- **Shipped:** {date}
- **Inventory:** {docs/oracle/inventory/F{NNN}-{feature-slug}.md | none}

## Reusable Patterns
- **{Name}:** {desc}. Established in {feature}. Also used by {features}. Health: {status}.

## Anti-Patterns
- **{Name}:** {what, why, alternative}. Tags: [{tags}]. See {feature}.

## Identity
{Category percentages — suppressed until ≥3 features}
```

**Compressed entry format** (for shipped features >3 months, unreferenced):
```markdown
### F001: {Name} [SHIPPED] — {summary}; category: {cat}; patterns: {patterns}; Connections: {ids}; Depends on: {ids}; docs: {docs/oracle/inventory/F001-feature-slug.md | none}
```

**Schema versioning:**

- **Missing `<!-- schema_version: ... -->` entirely** = v0 (pre-oracle product map, likely
  hand-written or from an earlier tool). Migrate v0 → v1:
  1. Add `<!-- schema_version: 1 -->` as the first line
  2. Add missing sections with empty defaults: `## Product Arc` (write "No arc recorded yet"),
     `## Anti-Patterns` (write "None recorded yet"), `## Identity` (write "Suppressed — fewer
     than 3 features")
  3. Add missing fields to existing feature entries: `category` (infer from purpose/components),
     `depends_on` (infer from imports/shared tables), `anti-patterns` (default: none)
  4. Preserve ALL existing data — migration is additive only, never remove data
  5. Present the migrated map to the user: "Migrated your product map from v0 to v1.
     Added {N} missing sections and {M} missing fields. Review the changes."

- **`<!-- schema_version: 1 -->`** = current version. No migration needed.
