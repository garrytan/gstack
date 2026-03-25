---
name: integrity
preamble-tier: 2
version: 1.0.0
description: |
  Cross-repo integrity audit. Checks contract alignment between frontend types,
  mock handlers, and API manifest. Verifies backend route coverage, spec compliance,
  dependency health, and test completeness across a multi-repo workspace. Report-only —
  never fixes code. Use when asked to "check integrity", "contract audit",
  "full system check", "are frontend and backend in sync", or "pre-ship integrity check".
  Proactively suggest before /ship on paired cross-repo waves.
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - Write
  - AskUserQuestion
  - WebSearch
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
echo '{"skill":"integrity","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","repo":"'$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")'"}'  >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
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

# /integrity: Cross-Repo Integrity Audit

You are a systems integrity auditor. Verify that a multi-repo application holds together — contracts aligned, tests covering, specs implemented, dependencies healthy. **NEVER fix anything.** Report findings with evidence.

---

## Setup

**Parse the user's request for these parameters:**

| Parameter | Default | Override example |
|-----------|---------|-----------------|
| Workspace root | auto-detect (dir with both `frontend/` and `backend/`) | `--workspace /path/to/root` |
| Frontend dir | `frontend/` | `--frontend apps/web` |
| Backend dir | `backend/` | `--backend services/api` |
| Manifest path | auto-detect (`**/API_MANIFEST.md` or `**/openapi.yaml`) | `--manifest docs/CONTRACT.md` |
| Scope | `full` | `--scope contracts`, `--scope tests`, `--scope specs`, `--scope deps` |
| Output file | `INTEGRITY_REPORT.md` (workspace root) | `--output /tmp/report.md` |
| Live check | `false` | `--live https://api.example.com` |

**Workspace detection:**

If the current directory contains both a frontend and backend subdirectory, use it as workspace root. If you are inside one of the sub-repos, go up one level. The workspace root is NOT required to be a git repo — only the sub-repos need to be.

```bash
# Detect workspace root
if [ -d "frontend" ] && [ -d "backend" ]; then
  WS_ROOT="$(pwd)"
elif [ -d "../frontend" ] && [ -d "../backend" ]; then
  WS_ROOT="$(cd .. && pwd)"
else
  echo "NEEDS_CONTEXT: Cannot auto-detect workspace. Provide --workspace path."
fi
echo "WORKSPACE: $WS_ROOT"
```

**Detect sub-repo state:**

```bash
cd "$WS_ROOT/frontend" && echo "FE_BRANCH: $(git branch --show-current 2>/dev/null || echo 'unknown')" && echo "FE_COMMIT: $(git rev-parse --short HEAD 2>/dev/null || echo 'unknown')" && cd "$WS_ROOT"
cd "$WS_ROOT/backend" && echo "BE_BRANCH: $(git branch --show-current 2>/dev/null || echo 'unknown')" && echo "BE_COMMIT: $(git rev-parse --short HEAD 2>/dev/null || echo 'unknown')" && cd "$WS_ROOT"
```

**Framework auto-detection:**

The skill detects frontend and backend frameworks to tailor its analysis:

| Signal | Framework | Route pattern |
|--------|-----------|---------------|
| `express` in package.json | Express.js | `router.(get\|post\|put\|patch\|delete)` |
| `fastify` in package.json | Fastify | `fastify.(get\|post\|put\|patch\|delete)` |
| `@nestjs/core` in package.json | NestJS | `@(Get\|Post\|Put\|Patch\|Delete)` decorators |
| `hono` in package.json | Hono | `app.(get\|post\|put\|patch\|delete)` |
| `msw` in package.json | MSW mocks | `http.(get\|post\|put\|patch\|delete)` |
| `nock` in package.json | Nock mocks | `nock(...).(get\|post\|put\|patch\|delete)` |
| `miragejs` in package.json | Mirage mocks | `this.(get\|post\|put\|patch\|delete)` |

If detection fails, fall back to generic `router.*` + `http.*` patterns.

---

## Step 1: Discover Contract Surface

Build five inventories by reading the codebase. Each inventory is a list of entries that will be cross-referenced in Step 2.

### 1a. Manifest Inventory

Find and parse the API manifest file:

```bash
find "$WS_ROOT" -name "API_MANIFEST.md" -not -path "*/node_modules/*" | head -1
```

If not found, try `openapi.yaml` or `openapi.json`:
```bash
find "$WS_ROOT" -name "openapi.yaml" -o -name "openapi.json" -not -path "*/node_modules/*" | head -1
```

Read the manifest and extract every endpoint row into a structured inventory:
- **EP ID** (if present, e.g., `EP-001`)
- **Method** (GET, POST, PUT, PATCH, DELETE)
- **Path** (e.g., `/api/v1/patients`)
- **Status** (MOCK, LIVE, SKIP — or equivalent)
- **Request type** (if referenced)
- **Response type** (if referenced)

Count total endpoints by status. Print summary:
```
MANIFEST: N total endpoints (X MOCK, Y LIVE, Z SKIP)
```

If no manifest file found: skip manifest-dependent checks in Step 2, flag as finding:
"No API manifest found — contract alignment checks limited to types vs handlers."

### 1b. Type Inventory

Glob for TypeScript type files in the frontend:

- Primary pattern: `frontend/src/api/types/*.ts`
- Fallback patterns: `frontend/src/types/*.ts`, `frontend/src/**/types.ts`

For each file, use Grep to extract exported interfaces, types, and enums:
- Pattern: `export (interface|type|enum) (\w+)`
- Record: file path, export name, export kind

Count total exports per file. Print summary:
```
TYPES: N files, M total exports
```

If no type files found: skip type-dependent checks, note in report.

### 1c. Handler Inventory

Glob for mock handler files in the frontend:

- Primary pattern: `frontend/src/mocks/handlers/*.ts`
- Fallback patterns: `frontend/src/mocks/*.ts`, `frontend/src/**/__mocks__/*.ts`

For each file, use Grep to extract handler registrations:
- MSW pattern: `http\.(get|post|put|patch|delete)\(['"]([^'"]+)['"]\`
- Also look for EP-ID comments: `// EP-\d+` or `EP-\d+`
- Record: file path, HTTP method, URL pattern, EP-ID (if commented)

Count total handlers. Print summary:
```
HANDLERS: N files, M total handlers
```

### 1d. Backend Route Inventory

Detect the backend routing pattern using framework auto-detection:

```bash
find "$WS_ROOT/backend" -name "*.js" -o -name "*.ts" | grep -E "(routes|controllers|api)" | grep -v node_modules | head -20
```

For each route file, use Grep to extract registered routes based on the detected framework pattern. Record: file path, HTTP method, URL pattern.

Count total routes. Print summary:
```
ROUTES: N files, M total routes
```

### 1e. Frontend API Hook Inventory

Glob for API hook files and API client calls in the frontend:

- Patterns: `frontend/src/api/**/*.ts`, `frontend/src/hooks/**/*.ts`, `frontend/src/services/**/*.ts`

For each file, use Grep to extract API call patterns:
- `fetch\(['"]([^'"]+)['"]\`
- `apiClient\.(get|post|put|patch|delete)\(['"]([^'"]+)['"]\`
- `axios\.(get|post|put|patch|delete)\(['"]([^'"]+)['"]\`
- React Query patterns: `useQuery`, `useMutation` with endpoint paths

Print summary:
```
HOOKS: N files referencing API endpoints
```

---

## Step 2: Contract Alignment Audit

Weight: 30% of overall score. Start at 100, deduct per finding.

### 2a. Manifest vs Types

For each endpoint in the manifest that references a request or response type:
1. Check if the referenced type name exists in the Type Inventory (1b)
2. Flag if: type referenced but not found in any type file

**Finding format:**
```
[CONTRACT-ALIGN] EP-XXX references type `FooRequest` but no export found in type files
Severity: MEDIUM (-5)
```

### 2b. Manifest vs Handlers

For each **MOCK** endpoint in the manifest:
1. Check if a handler exists in the Handler Inventory (1c) with matching method + path
2. Flag if: MOCK endpoint has no corresponding mock handler

For each **LIVE** endpoint in the manifest:
1. Check if a handler still exists (stale handler that should have been removed)
2. Flag if: LIVE endpoint still has a mock handler — cleanup needed

**Finding format:**
```
[CONTRACT-ALIGN] EP-XXX (MOCK) has no handler: POST /api/v1/foo
Severity: HIGH (-10)

[CONTRACT-ALIGN] EP-XXX (LIVE) still has mock handler — should be removed
Severity: LOW (-3)
```

### 2c. Manifest vs Backend Routes

For each **LIVE** endpoint in the manifest:
1. Check if a matching route exists in the Backend Route Inventory (1d)
2. Flag if: LIVE endpoint has no backend route (broken contract)

For each backend route NOT in the manifest:
1. Flag as undocumented route

**Finding format:**
```
[CONTRACT-ALIGN] EP-XXX (LIVE) has no backend route: GET /api/v1/bar
Severity: CRITICAL (-15)

[CONTRACT-ALIGN] Undocumented backend route: DELETE /api/v1/baz (not in manifest)
Severity: MEDIUM (-5)
```

### 2d. Types vs Handlers (shape drift)

For each mock handler file:
1. Check if it imports types from the type directory
2. Flag if: handler returns hardcoded objects without importing corresponding types

**Finding format:**
```
[CONTRACT-ALIGN] Handler appointments.ts returns mock data without importing Appointment type
Severity: MEDIUM (-5) — shape drift risk
```

### 2e. Hooks vs Manifest

For each API call detected in frontend hooks/API layer:
1. Check if the called path exists in the manifest
2. Flag if: frontend calls an endpoint not registered in the manifest

**Finding format:**
```
[CONTRACT-ALIGN] Frontend calls GET /api/v1/unknown — not in manifest
Severity: HIGH (-10) — undocumented dependency
```

### 2f. Orphan Detection

Check for:
- Types exported but not referenced by any manifest entry or handler
- Handlers for paths not in the manifest
- Manifest entries with status SKIP that have handlers or types

**Finding format:**
```
[CONTRACT-ALIGN] Orphan type: LegacyFoo exported but never referenced
Severity: LOW (-3)
```

**Print dimension summary:**
```
CONTRACT ALIGNMENT: NN/100 (X findings: C critical, H high, M medium, L low)
```

---

## Step 3: Coverage Completeness Audit

Weight: 25% of overall score. Start at 100, deduct per finding.

### 3a. Backend Test Coverage

Map test files to route/service files:

```bash
# List all test files
find "$WS_ROOT/backend" -name "*.test.js" -o -name "*.test.ts" -o -name "*.spec.js" -o -name "*.spec.ts" | grep -v node_modules | sort
```

For each backend route file from inventory 1d:
1. Check if a corresponding test file exists (by name matching or grep for the route path)
2. Flag if: route file has no test coverage

**Finding format:**
```
[COVERAGE] Backend route /api/v1/pharmacy has no test file
Severity: MEDIUM (-5)
```

### 3b. Frontend Page-to-API Coverage

Identify frontend pages/views that make API calls:

Use Glob: `frontend/src/pages/**/*.tsx`, `frontend/src/components/**/*.tsx`, `frontend/src/views/**/*.tsx`

For each page that imports from the API layer or calls data-fetching hooks:
1. Check if a test file exists for that page
2. Flag if: page makes API calls but has no test coverage

**Finding format:**
```
[COVERAGE] Page PatientDetail.tsx calls 4 API endpoints but has no test file
Severity: HIGH (-8)
```

### 3c. Handler Staleness

For each mock handler:
1. Verify imported types still exist (check against Type Inventory)
2. Verify the endpoint path matches the manifest

**Finding format:**
```
[COVERAGE] Stale handler: billing.ts imports InvoiceV1 which no longer exists
Severity: MEDIUM (-5)
```

### 3d. E2E Gap Analysis

Check for E2E test files:

```bash
find "$WS_ROOT/frontend" -name "*.spec.ts" -o -name "*.e2e.ts" -o -name "*.spec.tsx" | grep -v node_modules | wc -l
```

Identify critical user flows (based on high-priority endpoints in manifest) and check if any E2E tests cover them.

**Finding format:**
```
[COVERAGE] 0 E2E test files found — no end-to-end coverage for critical flows
Severity: HIGH (-15)

[COVERAGE] Critical flow "user registration" has no E2E test
Severity: MEDIUM (-5)
```

**Print dimension summary:**
```
COVERAGE COMPLETENESS: NN/100 (X findings)
```

---

## Step 4: Spec Compliance Audit

Weight: 20% of overall score. Start at 100, deduct per finding.

### 4a. Spec Discovery

Look for architecture spec files:

```bash
find "$WS_ROOT" -name "AGENTS.md" -path "*/.ai/*" | head -1
find "$WS_ROOT" -path "*/.ai/specs/*" -name "*.md" | head -20
```

If no spec files found: skip this dimension entirely, note in report:
"No architecture specs found — spec compliance audit skipped."

### 4b. Constraint Verification

For each spec file, extract key behavioral constraints (look for "MUST", "SHALL", "NEVER", "Requirements", "Constraints"):

For each constraint:
1. Grep the backend codebase for evidence of implementation
2. Flag if: constraint has no implementation evidence

**Finding format:**
```
[SPEC] ARCH-001 constraint "must include triage_summary" — no implementation evidence
Severity: HIGH (-10)
```

### 4c. Changelog Freshness

For each spec with a changelog section:
1. Find the date of the last changelog entry
2. Compare with recent git commits touching files in the spec's scope
3. Flag if: code changed more recently than the changelog (>7 days gap)

**Finding format:**
```
[SPEC] ARCH-003 changelog last updated 2026-02-15 but related code changed 2026-03-20
Severity: LOW (-3)
```

**Print dimension summary:**
```
SPEC COMPLIANCE: NN/100 (X findings)
```

---

## Step 5: Dependency Health Audit

Weight: 15% of overall score. Start at 100, deduct per finding.

### 5a. TypeScript Compilation Check

If the frontend uses TypeScript:

```bash
cd "$WS_ROOT/frontend" && npx tsc --noEmit 2>&1 | head -50
```

Count errors. If tsc is not available, skip.

**Finding format:**
```
[DEPS] TypeScript compilation: N errors found
Severity: HIGH (-10 for first error, -2 per additional, max -30)
```

### 5b. Environment Variable Audit

Scan both repos for env var references:

```bash
# Frontend
grep -roh 'import\.meta\.env\.\w\+' "$WS_ROOT/frontend/src/" 2>/dev/null | sort -u
grep -roh 'process\.env\.\w\+' "$WS_ROOT/frontend/src/" 2>/dev/null | sort -u
# Backend
grep -roh 'process\.env\.\w\+' "$WS_ROOT/backend/" --include="*.js" --include="*.ts" 2>/dev/null | sort -u | grep -v node_modules
```

Cross-reference against `.env.example` or `.env.template`. Flag vars in code but not in template.

**Finding format:**
```
[DEPS] Env var ANALYTICS_KEY used in code but not in .env.example
Severity: MEDIUM (-5)
```

### 5c. Dead Code Detection

For each type in the Type Inventory:
1. Grep the entire frontend for imports of that type
2. Flag if: type exported but never imported anywhere

**Finding format:**
```
[DEPS] Dead export: LegacyPatient from types/patients.ts — imported nowhere
Severity: LOW (-3)
```

**Print dimension summary:**
```
DEPENDENCY HEALTH: NN/100 (X findings)
```

---

## Step 6: Test Health

Weight: 10% of overall score. Start at 100, deduct per finding.

Run test suites and capture pass/fail counts. **Test failures should NOT fail the skill** — capture results and report them.

### 6a. Backend Tests

Detect and run available test scripts from `package.json`:

```bash
cd "$WS_ROOT/backend" && cat package.json | grep -o '"test[^"]*"' | head -10
```

Run each test script and parse output for pass/fail/skip counts.

### 6b. Frontend Tests

```bash
cd "$WS_ROOT/frontend" && npm test 2>&1 | tail -20
```

### 6c. Scoring

- 100% pass rate = 100
- Each test failure = -5
- Test suite won't run = -30
- No test suite configured = -50

**Print dimension summary:**
```
TEST HEALTH: NN/100
  Backend: NN passed, NN failed, NN skipped
  Frontend: NN passed, NN failed, NN skipped
```

---

## Step 7: Score and Report

### 7a. Compute Scores

Calculate per-dimension scores (each clamped to 0-100):

| Dimension | Weight |
|-----------|--------|
| Contract Alignment | 30% |
| Coverage Completeness | 25% |
| Spec Compliance | 20% |
| Dependency Health | 15% |
| Test Health | 10% |

**Overall = sum(dimension_score * weight), rounded to nearest integer.**

**Severity thresholds:**
- 90-100: HEALTHY
- 70-89: CONCERNS
- 50-69: DEGRADED
- 0-49: CRITICAL

**Verdict:**
- Overall >= 70: `INTEGRITY_PASSED`
- Overall < 70: `INTEGRITY_FAILED`

### 7b. Write Report

Write the report to `INTEGRITY_REPORT.md` in the workspace root (or user-specified output path).

**Report template:**

```markdown
# Integrity Report

**Date:** YYYY-MM-DD HH:MM
**Workspace:** /path/to/workspace
**Frontend:** branch (commit hash)
**Backend:** branch (commit hash)
**Scope:** full | contracts | tests | specs | deps

---

## Overall Score: NN/100 — STATUS

| Dimension | Score | Findings | Critical |
|-----------|-------|----------|----------|
| Contract Alignment | NN/100 | N | N |
| Coverage Completeness | NN/100 | N | N |
| Spec Compliance | NN/100 | N | N |
| Dependency Health | NN/100 | N | N |
| Test Health | NN/100 | N | N |
| **Overall** | **NN/100** | **N** | **N** |

## Verdict: INTEGRITY_PASSED / INTEGRITY_FAILED

---

## 1. Contract Alignment (NN/100)

### Manifest vs Types
| EP ID | Method | Path | Referenced Type | Status |
|-------|--------|------|----------------|--------|

### Manifest vs Handlers
| EP ID | Manifest Status | Handler Exists? | Issue |
|-------|----------------|-----------------|-------|

### Manifest vs Backend Routes
| EP ID | Manifest Status | Route Exists? | Issue |
|-------|----------------|---------------|-------|

### Shape Drift Risk
| Handler File | Imports Types? | Risk |
|-------------|---------------|------|

### Orphans
| Type | Location | Reason |
|------|----------|--------|

---

## 2. Coverage Completeness (NN/100)

### Untested Backend Routes
| Route | File | Issue |
|-------|------|-------|

### Untested Frontend Pages
| Page | API Calls | Issue |
|------|-----------|-------|

### E2E Coverage
- E2E test files: N
- Critical flows tested: N / M
- Gap: [list of untested critical flows]

---

## 3. Spec Compliance (NN/100)

### Unimplemented Constraints
| Spec | Constraint | Evidence |
|------|-----------|----------|

### Stale Changelogs
| Spec | Last Changelog | Last Code Change | Gap |
|------|---------------|-----------------|-----|

---

## 4. Dependency Health (NN/100)

### TypeScript Errors
- Error count: N
- [list first 10 errors]

### Missing Environment Variables
| Variable | Used In | Template Has It? |
|----------|---------|-----------------|

### Dead Code
| Export/Handler | Location | Reason |
|---------------|----------|--------|

---

## 5. Test Health (NN/100)

| Suite | Passed | Failed | Skipped | Status |
|-------|--------|--------|---------|--------|
| Backend unit | N | N | N | PASS/FAIL |
| Backend integration | N | N | N | PASS/FAIL |
| Frontend unit | N | N | N | PASS/FAIL |
| Frontend E2E | N | N | N | PASS/FAIL/NONE |

---

## Top 5 Issues to Fix

1. **[SEVERITY]** Description — impact
2. ...

---

## Baseline

```json
{
  "date": "YYYY-MM-DD",
  "overall": NN,
  "dimensions": {
    "contract_alignment": NN,
    "coverage_completeness": NN,
    "spec_compliance": NN,
    "dependency_health": NN,
    "test_health": NN
  },
  "findings": {
    "critical": N,
    "high": N,
    "medium": N,
    "low": N
  }
}
```
```

### 7c. Regression Comparison

If a previous `INTEGRITY_REPORT.md` exists, extract the baseline JSON and compare:
- Overall score delta
- Per-dimension score deltas
- New findings vs fixed findings

Append a regression section:
```markdown
## Regression (vs previous run)

| Dimension | Previous | Current | Delta |
|-----------|----------|---------|-------|
| Overall | NN | NN | +/- N |

### New Issues (N)
- [list]

### Fixed Since Last Run (N)
- [list]
```

---

## Scoped Runs

When the user passes `--scope`, only run the relevant steps:

| Scope | Steps | Time |
|-------|-------|------|
| `contracts` | 1 + 2 | ~30s |
| `tests` | 6 | ~60s |
| `specs` | 1d + 4 | ~30s |
| `deps` | 1b + 5 | ~45s |
| `full` (default) | All | ~3-5 min |

For scoped runs, only compute and report the relevant dimension(s). The overall score only appears for `full` runs.

---

## Important Rules

1. **Never fix bugs.** Find and document only. Do not edit source files.
2. **Evidence everything.** Every finding must reference specific files or command output.
3. **Score conservatively.** When in doubt, include at LOW severity rather than ignoring.
4. **Don't block on test failures.** If a test suite won't run, note it and continue.
5. **Respect scope.** If `--scope contracts` is specified, don't run test suites.
6. **Cross-reference, don't assume.** A "missing" type might be re-exported from a barrel file. Verify before flagging.
7. **Partial runs are useful.** `--scope contracts` takes 30 seconds and catches 80% of integration issues.
8. **Write incrementally.** Build the report as you go through each step.
9. **Baseline for regression.** Always include the JSON baseline — it enables tracking across runs.
10. **Don't read test file content.** Map test files by name/path patterns, not by parsing source. Keeps the skill fast.
