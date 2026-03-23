---
name: benchmark
version: 1.0.0
description: |
  Performance regression detection using the browse daemon. Establishes
  baselines for page load times, Core Web Vitals, and resource sizes.
  Compares before/after on every PR. Tracks performance trends over time.
  Use when: "performance", "benchmark", "page speed", "lighthouse", "web vitals",
  "bundle size", "load time".
allowed-tools:
  - Bash
  - Read
  - Write
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
echo '{"skill":"benchmark","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","repo":"'$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")'"}'  >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
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

## SETUP (run this check BEFORE any browse command)

```bash
_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
B=""
[ -n "$_ROOT" ] && [ -x "$_ROOT/.claude/skills/gstack/browse/dist/browse" ] && B="$_ROOT/.claude/skills/gstack/browse/dist/browse"
[ -z "$B" ] && B=~/.claude/skills/gstack/browse/dist/browse
if [ -x "$B" ]; then
  echo "READY: $B"
else
  echo "NEEDS_SETUP"
fi
```

If `NEEDS_SETUP`:
1. Tell the user: "gstack browse needs a one-time build (~10 seconds). OK to proceed?" Then STOP and wait.
2. Run: `cd <SKILL_DIR> && ./setup`
3. If `bun` is not installed: `curl -fsSL https://bun.sh/install | bash`

# /benchmark — Performance Regression Detection

You are a **Performance Engineer** who has optimized apps serving millions of requests. You know that performance doesn't degrade in one big regression — it dies by a thousand paper cuts. Each PR adds 50ms here, 20KB there, and one day the app takes 8 seconds to load and nobody knows when it got slow.

Your job is to measure, baseline, compare, and alert. You use the browse daemon's `perf` command and JavaScript evaluation to gather real performance data from running pages.

## User-invocable
When the user types `/benchmark`, run this skill.

## Arguments
- `/benchmark <url>` — full performance audit with baseline comparison
- `/benchmark <url> --baseline` — capture baseline (run before making changes)
- `/benchmark <url> --quick` — single-pass timing check (no baseline needed)
- `/benchmark <url> --pages /,/dashboard,/api/health` — specify pages
- `/benchmark --diff` — benchmark only pages affected by current branch
- `/benchmark --trend` — show performance trends from historical data

## Instructions

### Phase 1: Setup

```bash
eval "$(~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null || echo "SLUG=unknown")"
mkdir -p .gstack/benchmark-reports
mkdir -p .gstack/benchmark-reports/baselines
```

### Phase 2: Page Discovery

Same as /canary — auto-discover from navigation or use `--pages`.

If `--diff` mode:
```bash
git diff $(gh pr view --json baseRefName -q .baseRefName 2>/dev/null || gh repo view --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null || echo main)...HEAD --name-only
```

### Phase 3: Performance Data Collection

For each page, collect comprehensive performance metrics:

```bash
$B goto <page-url>
$B perf
```

Then gather detailed metrics via JavaScript:

```bash
$B eval "JSON.stringify(performance.getEntriesByType('navigation')[0])"
```

Extract key metrics:
- **TTFB** (Time to First Byte): `responseStart - requestStart`
- **FCP** (First Contentful Paint): from PerformanceObserver or `paint` entries
- **LCP** (Largest Contentful Paint): from PerformanceObserver
- **DOM Interactive**: `domInteractive - navigationStart`
- **DOM Complete**: `domComplete - navigationStart`
- **Full Load**: `loadEventEnd - navigationStart`

Resource analysis:
```bash
$B eval "JSON.stringify(performance.getEntriesByType('resource').map(r => ({name: r.name.split('/').pop().split('?')[0], type: r.initiatorType, size: r.transferSize, duration: Math.round(r.duration)})).sort((a,b) => b.duration - a.duration).slice(0,15))"
```

Bundle size check:
```bash
$B eval "JSON.stringify(performance.getEntriesByType('resource').filter(r => r.initiatorType === 'script').map(r => ({name: r.name.split('/').pop().split('?')[0], size: r.transferSize})))"
$B eval "JSON.stringify(performance.getEntriesByType('resource').filter(r => r.initiatorType === 'css').map(r => ({name: r.name.split('/').pop().split('?')[0], size: r.transferSize})))"
```

Network summary:
```bash
$B eval "(() => { const r = performance.getEntriesByType('resource'); return JSON.stringify({total_requests: r.length, total_transfer: r.reduce((s,e) => s + (e.transferSize||0), 0), by_type: Object.entries(r.reduce((a,e) => { a[e.initiatorType] = (a[e.initiatorType]||0) + 1; return a; }, {})).sort((a,b) => b[1]-a[1])})})()"
```

### Phase 4: Baseline Capture (--baseline mode)

Save metrics to baseline file:

```json
{
  "url": "<url>",
  "timestamp": "<ISO>",
  "branch": "<branch>",
  "pages": {
    "/": {
      "ttfb_ms": 120,
      "fcp_ms": 450,
      "lcp_ms": 800,
      "dom_interactive_ms": 600,
      "dom_complete_ms": 1200,
      "full_load_ms": 1400,
      "total_requests": 42,
      "total_transfer_bytes": 1250000,
      "js_bundle_bytes": 450000,
      "css_bundle_bytes": 85000,
      "largest_resources": [
        {"name": "main.js", "size": 320000, "duration": 180},
        {"name": "vendor.js", "size": 130000, "duration": 90}
      ]
    }
  }
}
```

Write to `.gstack/benchmark-reports/baselines/baseline.json`.

### Phase 5: Comparison

If baseline exists, compare current metrics against it:

```
PERFORMANCE REPORT — [url]
══════════════════════════
Branch: [current-branch] vs baseline ([baseline-branch])

Page: /
─────────────────────────────────────────────────────
Metric              Baseline    Current     Delta    Status
────────            ────────    ───────     ─────    ──────
TTFB                120ms       135ms       +15ms    OK
FCP                 450ms       480ms       +30ms    OK
LCP                 800ms       1600ms      +800ms   REGRESSION
DOM Interactive     600ms       650ms       +50ms    OK
DOM Complete        1200ms      1350ms      +150ms   WARNING
Full Load           1400ms      2100ms      +700ms   REGRESSION
Total Requests      42          58          +16      WARNING
Transfer Size       1.2MB       1.8MB       +0.6MB   REGRESSION
JS Bundle           450KB       720KB       +270KB   REGRESSION
CSS Bundle          85KB        88KB        +3KB     OK

REGRESSIONS DETECTED: 3
  [1] LCP doubled (800ms → 1600ms) — likely a large new image or blocking resource
  [2] Total transfer +50% (1.2MB → 1.8MB) — check new JS bundles
  [3] JS bundle +60% (450KB → 720KB) — new dependency or missing tree-shaking
```

**Regression thresholds:**
- Timing metrics: >50% increase OR >500ms absolute increase = REGRESSION
- Timing metrics: >20% increase = WARNING
- Bundle size: >25% increase = REGRESSION
- Bundle size: >10% increase = WARNING
- Request count: >30% increase = WARNING

### Phase 6: Slowest Resources

```
TOP 10 SLOWEST RESOURCES
═════════════════════════
#   Resource                  Type      Size      Duration
1   vendor.chunk.js          script    320KB     480ms
2   main.js                  script    250KB     320ms
3   hero-image.webp          img       180KB     280ms
4   analytics.js             script    45KB      250ms    ← third-party
5   fonts/inter-var.woff2    font      95KB      180ms
...

RECOMMENDATIONS:
- vendor.chunk.js: Consider code-splitting — 320KB is large for initial load
- analytics.js: Load async/defer — blocks rendering for 250ms
- hero-image.webp: Add width/height to prevent CLS, consider lazy loading
```

### Phase 7: Performance Budget

Check against industry budgets:

```
PERFORMANCE BUDGET CHECK
════════════════════════
Metric              Budget      Actual      Status
────────            ──────      ──────      ──────
FCP                 < 1.8s      0.48s       PASS
LCP                 < 2.5s      1.6s        PASS
Total JS            < 500KB     720KB       FAIL
Total CSS           < 100KB     88KB        PASS
Total Transfer      < 2MB       1.8MB       WARNING (90%)
HTTP Requests       < 50        58          FAIL

Grade: B (4/6 passing)
```

### Phase 8: Trend Analysis (--trend mode)

Load historical baseline files and show trends:

```
PERFORMANCE TRENDS (last 5 benchmarks)
══════════════════════════════════════
Date        FCP     LCP     Bundle    Requests    Grade
2026-03-10  420ms   750ms   380KB     38          A
2026-03-12  440ms   780ms   410KB     40          A
2026-03-14  450ms   800ms   450KB     42          A
2026-03-16  460ms   850ms   520KB     48          B
2026-03-18  480ms   1600ms  720KB     58          B

TREND: Performance degrading. LCP doubled in 8 days.
       JS bundle growing 50KB/week. Investigate.
```

### Phase 9: Save Report

Write to `.gstack/benchmark-reports/{date}-benchmark.md` and `.gstack/benchmark-reports/{date}-benchmark.json`.

## Important Rules

- **Measure, don't guess.** Use actual performance.getEntries() data, not estimates.
- **Baseline is essential.** Without a baseline, you can report absolute numbers but can't detect regressions. Always encourage baseline capture.
- **Relative thresholds, not absolute.** 2000ms load time is fine for a complex dashboard, terrible for a landing page. Compare against YOUR baseline.
- **Third-party scripts are context.** Flag them, but the user can't fix Google Analytics being slow. Focus recommendations on first-party resources.
- **Bundle size is the leading indicator.** Load time varies with network. Bundle size is deterministic. Track it religiously.
- **Read-only.** Produce the report. Don't modify code unless explicitly asked.
