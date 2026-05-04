import type { TemplateContext } from './types';

export function generateSlugEval(ctx: TemplateContext): string {
  return `eval "$(${ctx.paths.binDir}/gstack-slug 2>/dev/null)"`;
}

export function generateSlugSetup(ctx: TemplateContext): string {
  return `eval "$(${ctx.paths.binDir}/gstack-slug 2>/dev/null)" && mkdir -p ~/.gstack/projects/$SLUG`;
}

export function generateBaseBranchDetect(_ctx: TemplateContext): string {
  return `## Step 0: Detect platform and base branch

First, detect the git hosting platform from the remote URL:

\`\`\`bash
git remote get-url origin 2>/dev/null
\`\`\`

- If the URL contains "github.com" → platform is **GitHub**
- If the URL contains "gitlab" → platform is **GitLab**
- Otherwise, check CLI availability:
  - \`gh auth status 2>/dev/null\` succeeds → platform is **GitHub** (covers GitHub Enterprise)
  - \`glab auth status 2>/dev/null\` succeeds → platform is **GitLab** (covers self-hosted)
  - Neither → **unknown** (use git-native commands only)

Determine which branch this PR/MR targets, or the repo's default branch if no
PR/MR exists. Use the result as "the base branch" in all subsequent steps.

**If GitHub:**
1. \`gh pr view --json baseRefName -q .baseRefName\` — if succeeds, use it
2. \`gh repo view --json defaultBranchRef -q .defaultBranchRef.name\` — if succeeds, use it

**If GitLab:**
1. \`glab mr view -F json 2>/dev/null\` and extract the \`target_branch\` field — if succeeds, use it
2. \`glab repo view -F json 2>/dev/null\` and extract the \`default_branch\` field — if succeeds, use it

**Git-native fallback (if unknown platform, or CLI commands fail):**
1. \`git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||'\`
2. If that fails: \`git rev-parse --verify origin/main 2>/dev/null\` → use \`main\`
3. If that fails: \`git rev-parse --verify origin/master 2>/dev/null\` → use \`master\`

If all fail, fall back to \`main\`.

Print the detected base branch name. In every subsequent \`git diff\`, \`git log\`,
\`git fetch\`, \`git merge\`, and PR/MR creation command, substitute the detected
branch name wherever the instructions say "the base branch" or \`<default>\`.

---`;
}

export function generatePrDiffPin(_ctx: TemplateContext): string {
  return `## Step 0.5: Pin diff context to immutable SHAs (anti-branch-flip)

A long-running review skill is **not safe** to read git state through symbolic
refs like \`HEAD\`, \`origin/<base>\`, or \`origin/HEAD\`. Inside an Agent SDK
session — and especially across nested subagents that share a worktree — the
working tree, the symbolic-ref \`HEAD\`, and even the checked-out branch can
flip mid-skill (e.g., another tool runs \`git checkout\` to inspect a file,
then forgets to switch back). When that happens, every later \`git diff\`
command silently re-renders against the new branch, and the review reports
findings on the wrong code.

The fix is to **resolve diff endpoints to immutable commit SHAs at the very
start of the skill**, then use those SHAs in every subsequent \`git diff\`,
\`git log\`, and \`git show\` invocation. SHAs do not move when the working
tree flips.

Run this **once, before any other diff/log step**:

\`\`\`bash
# Resolve the PR (or branch) we're reviewing. Prefer explicit PR context.
PR_NUMBER=$(gh pr view --json number -q .number 2>/dev/null || echo "")

# REVIEW_DIRTY governs whether uncommitted local changes count as part of the
# review. Default OFF in PR context (review committed work only); default ON
# for local /review pre-PR (preserves the pre-fix behavior where dirty edits
# were included in the diff). Override by exporting REVIEW_DIRTY=1 / 0 before
# invoking the skill.
if [ -z "\${REVIEW_DIRTY+x}" ]; then
  if [ -n "$PR_NUMBER" ]; then REVIEW_DIRTY=0; else REVIEW_DIRTY=1; fi
fi

if [ -n "$PR_NUMBER" ]; then
  # In-PR review: prefer the PR's *own* recorded base/head SHAs over the
  # local origin/<base> tracking ref. baseRefOid and headRefOid are
  # immutable for the PR's current state — they are the SHAs GitHub renders
  # against, regardless of local fetch staleness.
  PR_META=$(gh pr view "$PR_NUMBER" --json baseRefName,headRefName,headRefOid,baseRefOid 2>/dev/null)
  BASE_BRANCH=$(echo "$PR_META" | jq -r '.baseRefName // empty')
  HEAD_BRANCH=$(echo "$PR_META" | jq -r '.headRefName // empty')
  HEAD_SHA=$(echo "$PR_META" | jq -r '.headRefOid // empty')
  BASE_SHA=$(echo "$PR_META" | jq -r '.baseRefOid // empty')
  # Fetch BOTH SHAs so they are present in the local object store. \\
  # Without this, \`git diff "$BASE_SHA" "$HEAD_SHA"\` errors out.
  if [ -n "$HEAD_SHA" ]; then
    git fetch origin "$HEAD_SHA" --quiet 2>/dev/null || \\
      git fetch origin "pull/$PR_NUMBER/head" --quiet 2>/dev/null || \\
      git fetch origin "$HEAD_BRANCH" --quiet 2>/dev/null || true
  fi
  if [ -n "$BASE_SHA" ]; then
    git fetch origin "$BASE_SHA" --quiet 2>/dev/null || \\
      git fetch origin "$BASE_BRANCH" --quiet 2>/dev/null || true
  fi
else
  # No PR context: fall back to local-branch review against detected base branch.
  # Reuse \"the base branch\" detected in Step 0; pin to its current origin SHA + local HEAD SHA.
  HEAD_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
  HEAD_SHA=$(git rev-parse HEAD 2>/dev/null || echo "")
  if ! git fetch origin "$BASE_BRANCH" --quiet 2>/dev/null; then
    echo "WARNING: could not fetch origin/$BASE_BRANCH. Pinning to whatever local origin/$BASE_BRANCH points at — may be stale." >&2
  fi
  BASE_SHA=$(git rev-parse "origin/$BASE_BRANCH" 2>/dev/null || echo "")
fi

# Soft-validate the SHAs. If a skill REQUIRES a diff context (\`/review\`, \`/cso --diff\`),
# it should add an explicit \`[ -n "$BASE_SHA" ] && [ -n "$HEAD_SHA" ]\` assertion before
# its first diff/log step. Skills that operate without a diff (\`/cso --infra\`,
# \`/cso --supply-chain\`, etc.) can proceed with empty SHAs and simply skip diff-mode
# substeps. Returning early via \`exit 1\` here would break those scope-flag modes.
if [ -z "$BASE_SHA" ] || [ -z "$HEAD_SHA" ]; then
  echo "WARNING: could not resolve BASE_SHA / HEAD_SHA — diff-dependent steps will be skipped." >&2
  echo "  PR_NUMBER=$PR_NUMBER  BASE_BRANCH=$BASE_BRANCH  HEAD_BRANCH=$HEAD_BRANCH" >&2
fi

# If we DID resolve SHAs, verify both actually exist in the local object store.
# (cat-file probe is a no-op when SHA is empty.)
for _SHA in "$BASE_SHA" "$HEAD_SHA"; do
  if [ -n "$_SHA" ] && ! git cat-file -e "$_SHA" 2>/dev/null; then
    echo "WARNING: SHA $_SHA is not present in the local repo — re-run after \`git fetch origin\` if review covers committed changes." >&2
  fi
done

echo "Pinned review context:"
echo "  PR:           \${PR_NUMBER:-<none — local-branch review>}"
echo "  Base branch:  $BASE_BRANCH @ $BASE_SHA"
echo "  Head branch:  $HEAD_BRANCH @ $HEAD_SHA"
echo "  Dirty edits:  \${REVIEW_DIRTY:-0} (1 = include uncommitted working-tree changes in diff)"
\`\`\`

**For the rest of this skill, use these pinned SHAs** in every diff/log
command. Concretely:

| Don't (working-tree dependent — bug) | Do (SHA-pinned — correct)                |
|--------------------------------------|------------------------------------------|
| \`git diff origin/<base>\`           | \`git diff "$BASE_SHA" "$HEAD_SHA"\`     |
| \`git diff origin/<base>...HEAD\`    | \`git diff "$BASE_SHA" "$HEAD_SHA"\`     |
| \`git diff <base>..HEAD\`            | \`git diff "$BASE_SHA" "$HEAD_SHA"\`     |
| \`git log origin/<base>..HEAD\`      | \`git log "$BASE_SHA..$HEAD_SHA"\`       |
| \`git diff --name-only origin/HEAD...\` | \`git diff --name-only "$BASE_SHA" "$HEAD_SHA"\` |
| \`git show HEAD:VERSION\`            | \`git show "$HEAD_SHA:VERSION"\`         |

**Avoid \`gh pr diff "$PR_NUMBER"\`** even in PR-review context: that endpoint
re-resolves \`HEAD\` and \`BASE\` server-side at every call, so a force-push of
the PR head or a fast-forward of the PR base mid-review will silently change
its output. Use the SHA-pinned local \`git diff "$BASE_SHA" "$HEAD_SHA"\`
instead — it is immutable both against worktree flips AND against PR-state
drift on the remote.

If you genuinely need the PR-rendered diff (e.g., to compare against
GitHub's UI), append \`--patch\` and a SHA boundary explicitly:
\`gh api "/repos/<owner>/<repo>/compare/$BASE_SHA...$HEAD_SHA"\`.

**Do not** use bare \`HEAD\`, \`origin/HEAD\`, or \`origin/<base>\` (without
\`...$HEAD_SHA\`) anywhere else in this skill. Even if those refs are correct
right now, a later subagent may flip the worktree underneath you.

This step is named \`shared-checkout-branch-flip-during-review\` in
\`CLAUDE.md\` failure-mode tracking.

---`;
}

export function generateDeployBootstrap(_ctx: TemplateContext): string {
  return `\`\`\`bash
# Check for persisted deploy config in CLAUDE.md
DEPLOY_CONFIG=$(grep -A 20 "## Deploy Configuration" CLAUDE.md 2>/dev/null || echo "NO_CONFIG")
echo "$DEPLOY_CONFIG"

# If config exists, parse it
if [ "$DEPLOY_CONFIG" != "NO_CONFIG" ]; then
  PROD_URL=$(echo "$DEPLOY_CONFIG" | grep -i "production.*url" | head -1 | sed 's/.*: *//')
  PLATFORM=$(echo "$DEPLOY_CONFIG" | grep -i "platform" | head -1 | sed 's/.*: *//')
  echo "PERSISTED_PLATFORM:$PLATFORM"
  echo "PERSISTED_URL:$PROD_URL"
fi

# Auto-detect platform from config files
[ -f fly.toml ] && echo "PLATFORM:fly"
[ -f render.yaml ] && echo "PLATFORM:render"
([ -f vercel.json ] || [ -d .vercel ]) && echo "PLATFORM:vercel"
[ -f netlify.toml ] && echo "PLATFORM:netlify"
[ -f Procfile ] && echo "PLATFORM:heroku"
([ -f railway.json ] || [ -f railway.toml ]) && echo "PLATFORM:railway"

# Detect deploy workflows
for f in $(find .github/workflows -maxdepth 1 \\( -name '*.yml' -o -name '*.yaml' \\) 2>/dev/null); do
  [ -f "$f" ] && grep -qiE "deploy|release|production|cd" "$f" 2>/dev/null && echo "DEPLOY_WORKFLOW:$f"
  [ -f "$f" ] && grep -qiE "staging" "$f" 2>/dev/null && echo "STAGING_WORKFLOW:$f"
done
\`\`\`

If \`PERSISTED_PLATFORM\` and \`PERSISTED_URL\` were found in CLAUDE.md, use them directly
and skip manual detection. If no persisted config exists, use the auto-detected platform
to guide deploy verification. If nothing is detected, ask the user via AskUserQuestion
in the decision tree below.

If you want to persist deploy settings for future runs, suggest the user run \`/setup-deploy\`.`;
}

export function generateQAMethodology(_ctx: TemplateContext): string {
  return `## Modes

### Diff-aware (automatic when on a feature branch with no URL)

This is the **primary mode** for developers verifying their work. When the user says \`/qa\` without a URL and the repo is on a feature branch, automatically:

1. **Analyze the branch diff** to understand what changed:
   \`\`\`bash
   git diff main...HEAD --name-only
   git log main..HEAD --oneline
   \`\`\`

2. **Identify affected pages/routes** from the changed files:
   - Controller/route files → which URL paths they serve
   - View/template/component files → which pages render them
   - Model/service files → which pages use those models (check controllers that reference them)
   - CSS/style files → which pages include those stylesheets
   - API endpoints → test them directly with \`$B js "await fetch('/api/...')"\`
   - Static pages (markdown, HTML) → navigate to them directly

   **If no obvious pages/routes are identified from the diff:** Do not skip browser testing. The user invoked /qa because they want browser-based verification. Fall back to Quick mode — navigate to the homepage, follow the top 5 navigation targets, check console for errors, and test any interactive elements found. Backend, config, and infrastructure changes affect app behavior — always verify the app still works.

3. **Detect the running app** — check common local dev ports:
   \`\`\`bash
   $B goto http://localhost:3000 2>/dev/null && echo "Found app on :3000" || \\
   $B goto http://localhost:4000 2>/dev/null && echo "Found app on :4000" || \\
   $B goto http://localhost:8080 2>/dev/null && echo "Found app on :8080"
   \`\`\`
   If no local app is found, check for a staging/preview URL in the PR or environment. If nothing works, ask the user for the URL.

4. **Test each affected page/route:**
   - Navigate to the page
   - Take a screenshot
   - Check console for errors
   - If the change was interactive (forms, buttons, flows), test the interaction end-to-end
   - Use \`snapshot -D\` before and after actions to verify the change had the expected effect

5. **Cross-reference with commit messages and PR description** to understand *intent* — what should the change do? Verify it actually does that.

6. **Check TODOS.md** (if it exists) for known bugs or issues related to the changed files. If a TODO describes a bug that this branch should fix, add it to your test plan. If you find a new bug during QA that isn't in TODOS.md, note it in the report.

7. **Report findings** scoped to the branch changes:
   - "Changes tested: N pages/routes affected by this branch"
   - For each: does it work? Screenshot evidence.
   - Any regressions on adjacent pages?

**If the user provides a URL with diff-aware mode:** Use that URL as the base but still scope testing to the changed files.

### Full (default when URL is provided)
Systematic exploration. Visit every reachable page. Document 5-10 well-evidenced issues. Produce health score. Takes 5-15 minutes depending on app size.

### Quick (\`--quick\`)
30-second smoke test. Visit homepage + top 5 navigation targets. Check: page loads? Console errors? Broken links? Produce health score. No detailed issue documentation.

### Regression (\`--regression <baseline>\`)
Run full mode, then load \`baseline.json\` from a previous run. Diff: which issues are fixed? Which are new? What's the score delta? Append regression section to report.

---

## Workflow

### Phase 1: Initialize

1. Find browse binary (see Setup above)
2. Create output directories
3. Copy report template from \`qa/templates/qa-report-template.md\` to output dir
4. Start timer for duration tracking

### Phase 2: Authenticate (if needed)

**If the user specified auth credentials:**

\`\`\`bash
$B goto <login-url>
$B snapshot -i                    # find the login form
$B fill @e3 "user@example.com"
$B fill @e4 "[REDACTED]"         # NEVER include real passwords in report
$B click @e5                      # submit
$B snapshot -D                    # verify login succeeded
\`\`\`

**If the user provided a cookie file:**

\`\`\`bash
$B cookie-import cookies.json
$B goto <target-url>
\`\`\`

**If 2FA/OTP is required:** Ask the user for the code and wait.

**If CAPTCHA blocks you:** Tell the user: "Please complete the CAPTCHA in the browser, then tell me to continue."

### Phase 3: Orient

Get a map of the application:

\`\`\`bash
$B goto <target-url>
$B snapshot -i -a -o "$REPORT_DIR/screenshots/initial.png"
$B links                          # map navigation structure
$B console --errors               # any errors on landing?
\`\`\`

**Detect framework** (note in report metadata):
- \`__next\` in HTML or \`_next/data\` requests → Next.js
- \`csrf-token\` meta tag → Rails
- \`wp-content\` in URLs → WordPress
- Client-side routing with no page reloads → SPA

**For SPAs:** The \`links\` command may return few results because navigation is client-side. Use \`snapshot -i\` to find nav elements (buttons, menu items) instead.

### Phase 4: Explore

Visit pages systematically. At each page:

\`\`\`bash
$B goto <page-url>
$B snapshot -i -a -o "$REPORT_DIR/screenshots/page-name.png"
$B console --errors
\`\`\`

Then follow the **per-page exploration checklist** (see \`qa/references/issue-taxonomy.md\`):

1. **Visual scan** — Look at the annotated screenshot for layout issues
2. **Interactive elements** — Click buttons, links, controls. Do they work?
3. **Forms** — Fill and submit. Test empty, invalid, edge cases
4. **Navigation** — Check all paths in and out
5. **States** — Empty state, loading, error, overflow
6. **Console** — Any new JS errors after interactions?
7. **Responsiveness** — Check mobile viewport if relevant:
   \`\`\`bash
   $B viewport 375x812
   $B screenshot "$REPORT_DIR/screenshots/page-mobile.png"
   $B viewport 1280x720
   \`\`\`

**Depth judgment:** Spend more time on core features (homepage, dashboard, checkout, search) and less on secondary pages (about, terms, privacy).

**Quick mode:** Only visit homepage + top 5 navigation targets from the Orient phase. Skip the per-page checklist — just check: loads? Console errors? Broken links visible?

### Phase 5: Document

Document each issue **immediately when found** — don't batch them.

**Two evidence tiers:**

**Interactive bugs** (broken flows, dead buttons, form failures):
1. Take a screenshot before the action
2. Perform the action
3. Take a screenshot showing the result
4. Use \`snapshot -D\` to show what changed
5. Write repro steps referencing screenshots

\`\`\`bash
$B screenshot "$REPORT_DIR/screenshots/issue-001-step-1.png"
$B click @e5
$B screenshot "$REPORT_DIR/screenshots/issue-001-result.png"
$B snapshot -D
\`\`\`

**Static bugs** (typos, layout issues, missing images):
1. Take a single annotated screenshot showing the problem
2. Describe what's wrong

\`\`\`bash
$B snapshot -i -a -o "$REPORT_DIR/screenshots/issue-002.png"
\`\`\`

**Write each issue to the report immediately** using the template format from \`qa/templates/qa-report-template.md\`.

### Phase 6: Wrap Up

1. **Compute health score** using the rubric below
2. **Write "Top 3 Things to Fix"** — the 3 highest-severity issues
3. **Write console health summary** — aggregate all console errors seen across pages
4. **Update severity counts** in the summary table
5. **Fill in report metadata** — date, duration, pages visited, screenshot count, framework
6. **Save baseline** — write \`baseline.json\` with:
   \`\`\`json
   {
     "date": "YYYY-MM-DD",
     "url": "<target>",
     "healthScore": N,
     "issues": [{ "id": "ISSUE-001", "title": "...", "severity": "...", "category": "..." }],
     "categoryScores": { "console": N, "links": N, ... }
   }
   \`\`\`

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
\`score = Σ (category_score × weight)\`

---

## Framework-Specific Guidance

### Next.js
- Check console for hydration errors (\`Hydration failed\`, \`Text content did not match\`)
- Monitor \`_next/data\` requests in network — 404s indicate broken data fetching
- Test client-side navigation (click links, don't just \`goto\`) — catches routing issues
- Check for CLS (Cumulative Layout Shift) on pages with dynamic content

### Rails
- Check for N+1 query warnings in console (if development mode)
- Verify CSRF token presence in forms
- Test Turbo/Stimulus integration — do page transitions work smoothly?
- Check for flash messages appearing and dismissing correctly

### WordPress
- Check for plugin conflicts (JS errors from different plugins)
- Verify admin bar visibility for logged-in users
- Test REST API endpoints (\`/wp-json/\`)
- Check for mixed content warnings (common with WP)

### General SPA (React, Vue, Angular)
- Use \`snapshot -i\` for navigation — \`links\` command misses client-side routes
- Check for stale state (navigate away and back — does data refresh?)
- Test browser back/forward — does the app handle history correctly?
- Check for memory leaks (monitor console after extended use)

---

## Important Rules

1. **Repro is everything.** Every issue needs at least one screenshot. No exceptions.
2. **Verify before documenting.** Retry the issue once to confirm it's reproducible, not a fluke.
3. **Never include credentials.** Write \`[REDACTED]\` for passwords in repro steps.
4. **Write incrementally.** Append each issue to the report as you find it. Don't batch.
5. **Never read source code.** Test as a user, not a developer.
6. **Check console after every interaction.** JS errors that don't surface visually are still bugs.
7. **Test like a user.** Use realistic data. Walk through complete workflows end-to-end.
8. **Depth over breadth.** 5-10 well-documented issues with evidence > 20 vague descriptions.
9. **Never delete output files.** Screenshots and reports accumulate — that's intentional.
10. **Use \`snapshot -C\` for tricky UIs.** Finds clickable divs that the accessibility tree misses.
11. **Show screenshots to the user.** After every \`$B screenshot\`, \`$B snapshot -a -o\`, or \`$B responsive\` command, use the Read tool on the output file(s) so the user can see them inline. For \`responsive\` (3 files), Read all three. This is critical — without it, screenshots are invisible to the user.
12. **Never refuse to use the browser.** When the user invokes /qa or /qa-only, they are requesting browser-based testing. Never suggest evals, unit tests, or other alternatives as a substitute. Even if the diff appears to have no UI changes, backend changes affect app behavior — always open the browser and test.`;
}

export function generateCoAuthorTrailer(ctx: TemplateContext): string {
  const { getHostConfig } = require('../../hosts/index');
  const hostConfig = getHostConfig(ctx.host);
  return hostConfig.coAuthorTrailer || 'Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>';
}

export function generateChangelogWorkflow(_ctx: TemplateContext): string {
  return `## Step 13: CHANGELOG (auto-generate)

1. Read \`CHANGELOG.md\` header to know the format.

2. **First, enumerate every commit on the branch:**
   \`\`\`bash
   git log <base>..HEAD --oneline
   \`\`\`
   Copy the full list. Count the commits. You will use this as a checklist.

3. **Read the full diff** to understand what each commit actually changed:
   \`\`\`bash
   git diff <base>...HEAD
   \`\`\`

4. **Group commits by theme** before writing anything. Common themes:
   - New features / capabilities
   - Performance improvements
   - Bug fixes
   - Dead code removal / cleanup
   - Infrastructure / tooling / tests
   - Refactoring

5. **Write the CHANGELOG entry** covering ALL groups:
   - If existing CHANGELOG entries on the branch already cover some commits, replace them with one unified entry for the new version
   - Categorize changes into applicable sections:
     - \`### Added\` — new features
     - \`### Changed\` — changes to existing functionality
     - \`### Fixed\` — bug fixes
     - \`### Removed\` — removed features
   - Write concise, descriptive bullet points
   - Insert after the file header (line 5), dated today
   - Format: \`## [X.Y.Z.W] - YYYY-MM-DD\`
   - **Voice:** Lead with what the user can now **do** that they couldn't before. Use plain language, not implementation details. Never mention TODOS.md, internal tracking, or contributor-facing details.

6. **Cross-check:** Compare your CHANGELOG entry against the commit list from step 2.
   Every commit must map to at least one bullet point. If any commit is unrepresented,
   add it now. If the branch has N commits spanning K themes, the CHANGELOG must
   reflect all K themes.

**Do NOT ask the user to describe changes.** Infer from the diff and commit history.`;
}
