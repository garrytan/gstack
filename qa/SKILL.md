---
name: qa
version: 2.0.0
description: |
  Systematically QA test a web application and fix bugs found. Runs QA testing,
  then iteratively fixes bugs in source code, committing each fix atomically and
  re-verifying. Use when asked to "qa", "QA", "test this site", "find bugs",
  "test and fix", or "fix what's broken". Three tiers: Quick (critical/high only),
  Standard (+ medium), Exhaustive (+ cosmetic). Produces before/after health scores,
  fix evidence, and a ship-readiness summary. For report-only mode, use /qa-only.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
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
find ~/.gstack/sessions -mmin +120 -type f -delete 2>/dev/null || true
_CONTRIB=$(~/.claude/skills/gstack/bin/gstack-config get gstack_contributor 2>/dev/null || true)
_BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
echo "BRANCH: $_BRANCH"
```

If output shows `UPGRADE_AVAILABLE <old> <new>`: read `~/.claude/skills/gstack/gstack-upgrade/SKILL.md` and follow the "Inline upgrade flow" (auto-upgrade if configured, otherwise AskUserQuestion with 4 options, write snooze state if declined). If `JUST_UPGRADED <from> <to>`: tell user "Running gstack v{to} (just updated!)" and continue.

## AskUserQuestion Format

**ALWAYS follow this structure for every AskUserQuestion call:**
1. **Re-ground:** State the project, the current branch (use the `_BRANCH` value printed by the preamble — NOT any branch from conversation history or gitStatus), and the current plan/task. (1-2 sentences)
2. **Simplify:** Explain the problem in plain English a smart 16-year-old could follow. No raw function names, no internal jargon, no implementation details. Use concrete examples and analogies. Say what it DOES, not what it's called.
3. **Recommend:** `RECOMMENDATION: Choose [X] because [one-line reason]`
4. **Options:** Lettered options: `A) ... B) ... C) ...`

Assume the user hasn't looked at this window in 20 minutes and doesn't have the code open. If you'd need to read the source to understand your own explanation, it's too complex.

Per-skill instructions may add additional formatting rules on top of this baseline.

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

## Step 0: Detect base branch

Determine which branch this PR targets. Use the result as "the base branch" in all subsequent steps.

1. Check if a PR already exists for this branch:
   `gh pr view --json baseRefName -q .baseRefName`
   If this succeeds, use the printed branch name as the base branch.

2. If no PR exists (command fails), detect the repo's default branch:
   `gh repo view --json defaultBranchRef -q .defaultBranchRef.name`

3. If both commands fail, fall back to `main`.

Print the detected base branch name. In every subsequent `git diff`, `git log`,
`git fetch`, `git merge`, and `gh pr create` command, substitute the detected
branch name wherever the instructions say "the base branch."

---

# /qa: Test → Fix → Verify

You are a QA engineer AND a bug-fix engineer. Test web applications like a real user — click everything, fill every form, check every state. When you find bugs, fix them in source code with atomic commits, then re-verify. Produce a structured report with before/after evidence.

## Setup

**Parse the user's request for these parameters:**

| Parameter | Default | Override example |
|-----------|---------|-----------------:|
| Target URL | (auto-detect or required) | `https://myapp.com`, `http://localhost:3000` |
| Tier | Standard | `--quick`, `--exhaustive` |
| Mode | full | `--regression .gstack/qa-reports/baseline.json` |
| Output dir | `.gstack/qa-reports/` | `Output to /tmp/qa` |
| Scope | Full app (or diff-scoped) | `Focus on the billing page` |
| Auth | None | `Sign in to user@example.com`, `Import cookies from cookies.json` |

**Tiers determine which issues get fixed:**
- **Quick:** Fix critical + high severity only
- **Standard:** + medium severity (default)
- **Exhaustive:** + low/cosmetic severity

**If no URL is given and you're on a feature branch:** Automatically enter **diff-aware mode** (see Modes below). This is the most common case — the user just shipped code on a branch and wants to verify it works.

**Require clean working tree before starting:**
```bash
if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: Working tree is dirty. Commit or stash changes before running /qa."
  exit 1
fi
```

**Find the browse binary:**

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

**Create output directories:**

```bash
mkdir -p .gstack/qa-reports/screenshots
```

---

## Test Plan Context

Before falling back to git diff heuristics, check for richer test plan sources:

1. **Project-scoped test plans:** Check `~/.gstack/projects/` for recent `*-test-plan-*.md` files for this repo
   ```bash
   SLUG=$(git remote get-url origin 2>/dev/null | sed 's|.*[:/]\([^/]*/[^/]*\)\.git$|\1|;s|.*[:/]\([^/]*/[^/]*\)$|\1|' | tr '/' '-')
   ls -t ~/.gstack/projects/$SLUG/*-test-plan-*.md 2>/dev/null | head -1
   ```
2. **Conversation context:** Check if a prior `/plan-eng-review` or `/plan-ceo-review` produced test plan output in this conversation
3. **Use whichever source is richer.** Fall back to git diff analysis only if neither is available.

---

## Phases 1-6: QA Baseline

## Modes

### Diff-aware (automatic when on a feature branch with no URL)

This is the **primary mode** for developers verifying their work. When the user says `/qa` without a URL and the repo is on a feature branch, automatically:

1. **Analyze the branch diff** to understand what changed:
   ```bash
   git diff main...HEAD --name-only
   git log main..HEAD --oneline
   ```

2. **Identify affected pages/routes** from the changed files:
   - Controller/route files → which URL paths they serve
   - View/template/component files → which pages render them
   - Model/service files → which pages use those models (check controllers that reference them)
   - CSS/style files → which pages include those stylesheets
   - API endpoints → test them directly with `$B js "await fetch('/api/...')"`
   - Static pages (markdown, HTML) → navigate to them directly

3. **Detect the running app** — check common local dev ports:
   ```bash
   $B goto http://localhost:3000 2>/dev/null && echo "Found app on :3000" || \
   $B goto http://localhost:4000 2>/dev/null && echo "Found app on :4000" || \
   $B goto http://localhost:8080 2>/dev/null && echo "Found app on :8080"
   ```
   If no local app is found, check for a staging/preview URL in the PR or environment. If nothing works, ask the user for the URL.

4. **Test each affected page/route:**
   - Navigate to the page
   - Take a screenshot
   - Check console for errors
   - If the change was interactive (forms, buttons, flows), test the interaction end-to-end
   - Use `snapshot -D` before and after actions to verify the change had the expected effect

5. **Cross-reference with commit messages and PR description** to understand *intent* — what should the change do? Verify it actually does that.

6. **Check TODOS.md** (if it exists) for known bugs or issues related to the changed files. If a TODO describes a bug that this branch should fix, add it to your test plan. If you find a new bug during QA that isn't in TODOS.md, note it in the report.

7. **Report findings** scoped to the branch changes:
   - "Changes tested: N pages/routes affected by this branch"
   - For each: does it work? Screenshot evidence.
   - Any regressions on adjacent pages?

**If the user provides a URL with diff-aware mode:** Use that URL as the base but still scope testing to the changed files.

### Full (default when URL is provided)
Systematic exploration. Visit every reachable page. Document 5-10 well-evidenced issues. Produce health score. Takes 5-15 minutes depending on app size.

### Quick (`--quick`)
30-second smoke test. Visit homepage + top 5 navigation targets. Check: page loads? Console errors? Broken links? Produce health score. No detailed issue documentation.

### Regression (`--regression <baseline>`)
Run full mode, then load `baseline.json` from a previous run. Diff: which issues are fixed? Which are new? What's the score delta? Append regression section to report.

---

## Workflow

### Phase 1: Initialize

1. Find browse binary (see Setup above)
2. Create output directories
3. Copy report template from `qa/templates/qa-report-template.md` to output dir
4. Start timer for duration tracking

### Phase 2: Authenticate (if needed)

**If the user specified auth credentials:**

```bash
$B goto <login-url>
$B snapshot -i                    # find the login form
$B fill @e3 "user@example.com"
$B fill @e4 "[REDACTED]"         # NEVER include real passwords in report
$B click @e5                      # submit
$B snapshot -D                    # verify login succeeded
```

**If the user provided a cookie file:**

```bash
$B cookie-import cookies.json
$B goto <target-url>
```

**If 2FA/OTP is required:** Ask the user for the code and wait.

**If CAPTCHA blocks you:** Tell the user: "Please complete the CAPTCHA in the browser, then tell me to continue."

### Phase 3: Orient

Get a map of the application:

```bash
$B goto <target-url>
$B snapshot -i -a -o "$REPORT_DIR/screenshots/initial.png"
$B links                          # map navigation structure
$B console --errors               # any errors on landing?
```

**Detect framework** (note in report metadata):
- `__next` in HTML or `_next/data` requests → Next.js
- `csrf-token` meta tag → Rails
- `wp-content` in URLs → WordPress
- Client-side routing with no page reloads → SPA

**For SPAs:** The `links` command may return few results because navigation is client-side. Use `snapshot -i` to find nav elements (buttons, menu items) instead.

### Phase 4: Explore

Visit pages systematically. At each page:

```bash
$B goto <page-url>
$B snapshot -i -a -o "$REPORT_DIR/screenshots/page-name.png"
$B console --errors
```

Then follow the **per-page exploration checklist** (see `qa/references/issue-taxonomy.md`):

1. **Visual scan** — Look at the annotated screenshot for layout issues
2. **Interactive elements** — Click buttons, links, controls. Do they work?
3. **Forms** — Fill and submit. Test empty, invalid, edge cases
4. **Navigation** — Check all paths in and out
5. **States** — Empty state, loading, error, overflow
6. **Console** — Any new JS errors after interactions?
7. **Responsiveness** — Check mobile viewport if relevant:
   ```bash
   $B viewport 375x812
   $B screenshot "$REPORT_DIR/screenshots/page-mobile.png"
   $B viewport 1280x720
   ```

**Depth judgment:** Spend more time on core features (homepage, dashboard, checkout, search) and less on secondary pages (about, terms, privacy).

**Quick mode:** Only visit homepage + top 5 navigation targets from the Orient phase. Skip the per-page checklist — just check: loads? Console errors? Broken links visible?

### Phase 5: Document

Document each issue **immediately when found** — don't batch them.

**Two evidence tiers:**

**Interactive bugs** (broken flows, dead buttons, form failures):
1. Take a screenshot before the action
2. Perform the action
3. Take a screenshot showing the result
4. Use `snapshot -D` to show what changed
5. Write repro steps referencing screenshots

```bash
$B screenshot "$REPORT_DIR/screenshots/issue-001-step-1.png"
$B click @e5
$B screenshot "$REPORT_DIR/screenshots/issue-001-result.png"
$B snapshot -D
```

**Static bugs** (typos, layout issues, missing images):
1. Take a single annotated screenshot showing the problem
2. Describe what's wrong

```bash
$B snapshot -i -a -o "$REPORT_DIR/screenshots/issue-002.png"
```

**Write each issue to the report immediately** using the template format from `qa/templates/qa-report-template.md`.

### Phase 6: Wrap Up

1. **Compute health score** using the rubric below
2. **Write "Top 3 Things to Fix"** — the 3 highest-severity issues
3. **Write console health summary** — aggregate all console errors seen across pages
4. **Update severity counts** in the summary table
5. **Fill in report metadata** — date, duration, pages visited, screenshot count, framework
6. **Save baseline** — write `baseline.json` with:
   ```json
   {
     "date": "YYYY-MM-DD",
     "url": "<target>",
     "healthScore": N,
     "issues": [{ "id": "ISSUE-001", "title": "...", "severity": "...", "category": "..." }],
     "categoryScores": { "console": N, "links": N, ... }
   }
   ```

**Regression mode:** After writing the report, load the baseline file. Compare:
- Health score delta
- Issues fixed (in baseline but not current)
- New issues (in current but not baseline)
- Append the regression section to the report

---

## Health Score Rubric

Compute each category score (0-100), then take the weighted average.

### Console (weight: 15%)
- 0 errors → 100
- 1-3 errors → 70
- 4-10 errors → 40
- 10+ errors → 10

### Links (weight: 10%)
- 0 broken → 100
- Each broken link → -15 (minimum 0)

### Per-Category Scoring (Visual, Functional, UX, Content, Performance, Accessibility)
Each category starts at 100. Deduct per finding:
- Critical issue → -25
- High issue → -15
- Medium issue → -8
- Low issue → -3
Minimum 0 per category.

### Weights
| Category | Weight |
|----------|--------|
| Console | 15% |
| Links | 10% |
| Visual | 10% |
| Functional | 20% |
| UX | 15% |
| Performance | 10% |
| Content | 5% |
| Accessibility | 15% |

### Final Score
`score = Σ (category_score × weight)`

---

## Framework-Specific Guidance

### Next.js
- Check console for hydration errors (`Hydration failed`, `Text content did not match`)
- Monitor `_next/data` requests in network — 404s indicate broken data fetching
- Test client-side navigation (click links, don't just `goto`) — catches routing issues
- Check for CLS (Cumulative Layout Shift) on pages with dynamic content

### Rails
- Check for N+1 query warnings in console (if development mode)
- Verify CSRF token presence in forms
- Test Turbo/Stimulus integration — do page transitions work smoothly?
- Check for flash messages appearing and dismissing correctly

### WordPress
- Check for plugin conflicts (JS errors from different plugins)
- Verify admin bar visibility for logged-in users
- Test REST API endpoints (`/wp-json/`)
- Check for mixed content warnings (common with WP)

### General SPA (React, Vue, Angular)
- Use `snapshot -i` for navigation — `links` command misses client-side routes
- Check for stale state (navigate away and back — does data refresh?)
- Test browser back/forward — does the app handle history correctly?
- Check for memory leaks (monitor console after extended use)

---

## Important Rules

1. **Repro is everything.** Every issue needs at least one screenshot. No exceptions.
2. **Verify before documenting.** Retry the issue once to confirm it's reproducible, not a fluke.
3. **Never include credentials.** Write `[REDACTED]` for passwords in repro steps.
4. **Write incrementally.** Append each issue to the report as you find it. Don't batch.
5. **Never read source code.** Test as a user, not a developer.
6. **Check console after every interaction.** JS errors that don't surface visually are still bugs.
7. **Test like a user.** Use realistic data. Walk through complete workflows end-to-end.
8. **Depth over breadth.** 5-10 well-documented issues with evidence > 20 vague descriptions.
9. **Never delete output files.** Screenshots and reports accumulate — that's intentional.
10. **Use `snapshot -C` for tricky UIs.** Finds clickable divs that the accessibility tree misses.

Record baseline health score at end of Phase 6.

---

## Output Structure

```
.gstack/qa-reports/
├── qa-report-{domain}-{YYYY-MM-DD}.md    # Structured report
├── screenshots/
│   ├── initial.png                        # Landing page annotated screenshot
│   ├── issue-001-step-1.png               # Per-issue evidence
│   ├── issue-001-result.png
│   ├── issue-001-before.png               # Before fix (if fixed)
│   ├── issue-001-after.png                # After fix (if fixed)
│   └── ...
└── baseline.json                          # For regression mode
```

Report filenames use the domain and date: `qa-report-myapp-com-2026-03-12.md`

---

## Phase 7: Triage

Sort all discovered issues by severity, then decide which to fix based on the selected tier:

- **Quick:** Fix critical + high only. Mark medium/low as "deferred."
- **Standard:** Fix critical + high + medium. Mark low as "deferred."
- **Exhaustive:** Fix all, including cosmetic/low severity.

Mark issues that cannot be fixed from source code (e.g., third-party widget bugs, infrastructure issues) as "deferred" regardless of tier.

---

## Phase 8: Fix Loop

For each fixable issue, in severity order:

### 8a. Locate source

```bash
# Grep for error messages, component names, route definitions
# Glob for file patterns matching the affected page
```

- Find the source file(s) responsible for the bug
- ONLY modify files directly related to the issue

### 8b. Fix

- Read the source code, understand the context
- Make the **minimal fix** — smallest change that resolves the issue
- Do NOT refactor surrounding code, add features, or "improve" unrelated things

### 8c. Commit

```bash
git add <only-changed-files>
git commit -m "fix(qa): ISSUE-NNN — short description"
```

- One commit per fix. Never bundle multiple fixes.
- Message format: `fix(qa): ISSUE-NNN — short description`

### 8d. Re-test

- Navigate back to the affected page
- Take **before/after screenshot pair**
- Check console for errors
- Use `snapshot -D` to verify the change had the expected effect

```bash
$B goto <affected-url>
$B screenshot "$REPORT_DIR/screenshots/issue-NNN-after.png"
$B console --errors
$B snapshot -D
```

### 8e. Classify

- **verified**: re-test confirms the fix works, no new errors introduced
- **best-effort**: fix applied but couldn't fully verify (e.g., needs auth state, external service)
- **reverted**: regression detected → `git revert HEAD` → mark issue as "deferred"

### 8f. Self-Regulation (STOP AND EVALUATE)

Every 5 fixes (or after any revert), compute the WTF-likelihood:

```
WTF-LIKELIHOOD:
  Start at 0%
  Each revert:                +15%
  Each fix touching >3 files: +5%
  After fix 15:               +1% per additional fix
  All remaining Low severity: +10%
  Touching unrelated files:   +20%
```

**If WTF > 20%:** STOP immediately. Show the user what you've done so far. Ask whether to continue.

**Hard cap: 50 fixes.** After 50 fixes, stop regardless of remaining issues.

---

## Phase 9: Final QA

After all fixes are applied:

1. Re-run QA on all affected pages
2. Compute final health score
3. **If final score is WORSE than baseline:** WARN prominently — something regressed

---

## Phase 10: Report

Write the report to both local and project-scoped locations:

**Local:** `.gstack/qa-reports/qa-report-{domain}-{YYYY-MM-DD}.md`

**Project-scoped:** Write test outcome artifact for cross-session context:
```bash
SLUG=$(git remote get-url origin 2>/dev/null | sed 's|.*[:/]\([^/]*/[^/]*\)\.git$|\1|;s|.*[:/]\([^/]*/[^/]*\)$|\1|' | tr '/' '-')
mkdir -p ~/.gstack/projects/$SLUG
```
Write to `~/.gstack/projects/{slug}/{user}-{branch}-test-outcome-{datetime}.md`

**Per-issue additions** (beyond standard report template):
- Fix Status: verified / best-effort / reverted / deferred
- Commit SHA (if fixed)
- Files Changed (if fixed)
- Before/After screenshots (if fixed)

**Summary section:**
- Total issues found
- Fixes applied (verified: X, best-effort: Y, reverted: Z)
- Deferred issues
- Health score delta: baseline → final

**PR Summary:** Include a one-line summary suitable for PR descriptions:
> "QA found N issues, fixed M, health score X → Y."

---

## Phase 11: TODOS.md Update

If the repo has a `TODOS.md`:

1. **New deferred bugs** → add as TODOs with severity, category, and repro steps
2. **Fixed bugs that were in TODOS.md** → annotate with "Fixed by /qa on {branch}, {date}"

---

## Additional Rules (qa-specific)

11. **Clean working tree required.** Refuse to start if `git status --porcelain` is non-empty.
12. **One commit per fix.** Never bundle multiple fixes into one commit.
13. **Never modify tests or CI configuration.** Only fix application source code.
14. **Revert on regression.** If a fix makes things worse, `git revert HEAD` immediately.
15. **Self-regulate.** Follow the WTF-likelihood heuristic. When in doubt, stop and ask.
