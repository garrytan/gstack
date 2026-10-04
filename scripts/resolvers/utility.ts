import type { TemplateContext } from './types';
import { CODEX_MODEL_CONFIG_FLAG, CODEX_REVIEW_MODEL_CONFIG_FLAG, CODEX_WEB_SEARCH_FLAG } from './constants';
import { CLAUDE_FRONTIER_EVAL_MODEL } from '../../lib/eval-model';

/**
 * {{CODEX_WEB_SEARCH_FLAG}} — the non-deprecated codex web-search flag
 * (#2525). Templates with inline codex invocations reference this token so
 * the flag has exactly one source of truth (scripts/resolvers/constants.ts).
 */
export function generateCodexWebSearchFlag(_ctx: TemplateContext): string {
  return CODEX_WEB_SEARCH_FLAG;
}

/**
 * {{CODEX_MODEL_CONFIG_FLAG}} — the default frontier Codex model override.
 * Users can override it with GSTACK_CODEX_MODEL, or replace it with a
 * request-specific `-c model="..."` when the skill input names a model.
 */
export function generateCodexModelConfigFlag(_ctx: TemplateContext): string {
  return CODEX_MODEL_CONFIG_FLAG;
}

export function generateCodexReviewModelConfigFlag(_ctx: TemplateContext): string {
  return CODEX_REVIEW_MODEL_CONFIG_FLAG;
}

export function generateClaudeModelFlag(_ctx: TemplateContext): string {
  return `--model "\${GSTACK_CLAUDE_MODEL:-${CLAUDE_FRONTIER_EVAL_MODEL}}"`;
}

export function generateSlugEval(ctx: TemplateContext): string {
  return `SLUG=$(${ctx.paths.binDir}/gstack-slug --get SLUG 2>/dev/null)`;
}

export function generateSlugSetup(ctx: TemplateContext): string {
  return `GSTACK_STATE_ROOT=$(${ctx.paths.binDir}/gstack-paths --get GSTACK_STATE_ROOT); : "\${GSTACK_STATE_ROOT:?gstack-paths failed; reinstall with ./setup or /gstack-upgrade}"
SLUG=$(${ctx.paths.binDir}/gstack-slug --get SLUG 2>/dev/null) && mkdir -p "$GSTACK_STATE_ROOT/projects/$SLUG" && echo "PROJECT_DIR: $GSTACK_STATE_ROOT/projects/$SLUG"`;
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

export function generateDeployBootstrap(_ctx: TemplateContext): string {
  return `\`\`\`bash
# Check for persisted deploy config in CLAUDE.md
DEPLOY_CONFIG=$(grep -A 20 "## Deploy Configuration" CLAUDE.md 2>/dev/null || echo "NO_CONFIG")
echo "$DEPLOY_CONFIG"

# If config exists, parse it
if [ "$DEPLOY_CONFIG" != "NO_CONFIG" ]; then
  # Cut at the FIRST ": ", not the last. A greedy 's/.*: *//' ate the scheme of
  # any URL: "Production URL: https://x.com" became "//x.com", because the last
  # ":" belongs to "https:".
  PROD_URL=$(echo "$DEPLOY_CONFIG" | grep -i "production.*url" | head -1 | sed 's/^[^:]*: *//')
  PLATFORM=$(echo "$DEPLOY_CONFIG" | grep -i "platform" | head -1 | sed 's/^[^:]*: *//')
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
  return `# Browser QA methodology

Run only for selected browser surfaces. Map diffs with source before probes; discovery stays black-box, diagnosis caller-owned.

The shared exploratory loop owns execution order, not these technique phases. Its
checkpoint rule covers every probe after the baseline, including orientation, links,
exact replay and additional evidence. Never batch across checkpoints.

## Modes

For /qa and /qa-only, choose Full, Quick or Regression. Resolve conflicting depth flags
by asking before probes. /review and /ship keep their caller's smoke and plan bounds.
Diff-aware selects scope, not another pass. Time caps include checkpoints and evidence.
At exhaustion, stop probing and report unfinished coverage, never skip checkpoints.

### Diff-aware (automatic when on a feature branch with no URL)

Substitute the detected base for \`main\`:

\`\`\`bash
git diff main...HEAD --name-only
git log main..HEAD --oneline
\`\`\`

Map changed controllers/routes/views/components/models/services/styles to pages. Check commits/PR intent; add related TODO bugs to the test plan. Open static pages directly. For browser-surface API probes:

\`\`\`bash
aside repl '
const pg = await openTab("<base-url>");
const r = await fetch("<base-url>/api/...", { method: "GET" });
console.log("API_STATUS=" + r.status);
console.log("API_BODY_START"); console.log((await r.text()).slice(0, 4000)); console.log("API_BODY_END");
await closeTab(pg); console.log("GSTACK_STEP_OK");
'
\`\`\`

After selecting and isolating a browser surface, find a local app if its URL is missing:

\`\`\`bash
for p in 3000 4000 8080; do curl -sI --max-time 3 "http://localhost:$p" >/dev/null 2>&1 && echo "Found app on :$p"; done
\`\`\`

Use the supplied URL or first responder/staging/preview; ask if none. Test changed/adjacent pages and flows. Flag new bugs absent from TODOS.md in the Phase 6 report.

**No identifiable pages:** use Quick plus discovered interactions, even for backend/config/infrastructure changes.

### Full (default with a URL)
Visit every reachable page (5-15 minutes). Score health; document 5-10 evidenced issues, never invent any.

### Quick (\`--quick\`)
3 minutes: homepage + top 5 navigation targets. Check loads/console/broken links; score per Health Score Rubric; skip detailed issues/checklist, never the shared loop's gates.

### Regression (\`--regression <baseline>\`)
Run Full; append fixed/new issues and score delta. Preserve the supplied prior baseline.
A missing or unreadable baseline is a missing prerequisite: it blocks the comparison, not the Full run.

## Workflow

### Phase 1: Initialize

Reuse the caller's BROWSER SETUP and owned artifact paths: Aside READY, otherwise \`$B\`
(\`NEEDS_ASIDE\`/\`ASIDE_NOT_RUNNING\`). Complete only missing setup within caller
authority. Clamp the shared loop's deadline guard to the caller's running deadline.

### Phase 2: Authenticate (if needed)

Follow BROWSER SETUP's **Browser access decision** for /setup-browser-cookies or \`$B handoff\`/\`$B resume\`. Rerun after user sign-in/2FA/OTP/CAPTCHA. Never handle credentials or expose cookies/tokens/localStorage.

### Phase 3: Orient

Establish the successful baseline before challenges. Observe the page or interaction's
expected result/state, not merely a successful load.

**Read/flow:** set \`flow = true\` and replace action/wait for interactions. Keep ONE script; tabs close at its end.

\`\`\`bash
aside repl '
const flow = false;
const HOOK = \`(() => { window.__gstackErrs = window.__gstackErrs || []; const oe = console.error; console.error = (...a) => { window.__gstackErrs.push(a.map(String).join(" ")); oe.apply(console, a); }; window.addEventListener("error", e => window.__gstackErrs.push("uncaught: " + e.message)); window.addEventListener("unhandledrejection", e => window.__gstackErrs.push("unhandledrejection: " + (e.reason && e.reason.message || e.reason))); })()\`;
const pg = await openTab("about:blank");
await pg._sendToTarget("Page.addScriptToEvaluateOnNewDocument", { source: HOOK });
await pg.goto("<target-url>");
console.log((await snapshot(pg, { interactive: true })).tree);
await pg.screenshot({ path: flow ? "issue-001-step-1.jpg" : "initial.jpg", type: "jpeg", quality: 60, fullPage: !flow });
if (flow) {
  await pg.locator("e12").click();
  await sleep(500);
  console.log("DIFF_START"); console.log((await snapshot(pg)).diff); console.log("DIFF_END");
  await pg.screenshot({ path: "issue-001-result.jpg", type: "jpeg", quality: 60 });
}
console.log("URL=" + pg.url());
console.log("CONSOLE_ERRORS=" + JSON.stringify(await pg.evaluate(() => window.__gstackErrs)));
console.log("TEXT_START"); console.log((await pg.evaluate(() => document.body.innerText)).slice(0, 20000)); console.log("TEXT_END");
console.log("ASIDE_DIR=" + pwd);
await closeTab(pg); console.log("GSTACK_STEP_OK");
'
\`\`\`

EVERY screenshot: \`cp "<ASIDE_DIR>/initial.jpg" "$REPORT_DIR/screenshots/initial.jpg"\` (substitute names), then Read it. Never delete reports/screenshots.

**Links:** same-origin safe paths; HEAD only locally (requests carry cookies).

\`\`\`bash
aside repl '
const pg = await openTab("<target-url>");
const links = await pg.evaluate(() => [...new Set([...document.querySelectorAll("a[href]")].map(a => a.href))].filter(h => new URL(h).origin === location.origin && !/logout|signout|delete|remove|cancel|unsubscribe/i.test(h)));
const local = await pg.evaluate(() => /^(localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|::1|\\[::1\\])$|\\.(localhost|test)$/.test(location.hostname));
for (const l of links) { if (!local) { console.log("LINK ?", l); continue; } const r = await fetch(l, { method: "HEAD" }).catch(e => ({ status: "ERR " + e.message })); console.log("LINK", r.status, l); }
await closeTab(pg); console.log("GSTACK_STEP_OK");
'
\`\`\`

\`LINK\` 4xx/5xx or \`ERR\` is broken; \`LINK ?\` is unverified. Snapshot SPA buttons/menus missing from links.

Framework: \`__next\`/\`_next/data\` = Next.js; \`csrf-token\` = Rails; \`wp-content\` = WordPress; no-reload navigation = SPA.

### Phase 4: Explore

Select the next candidate from the preceding result. For each page, use the read script with \`page-<name>.jpg\`. Check layout, controls, empty/invalid/edge-case forms, navigation and empty/loading/error/overflow states per \`qa/references/issue-taxonomy.md\`. Prioritize core flows over secondary pages; Quick skips this checklist. For mobile:

\`\`\`bash
aside repl '
const pg = await openTab("<page-url>");
await pg._sendToTarget("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
await sleep(300);
await pg.screenshot({ path: "page-mobile.jpg", type: "jpeg", quality: 60, fullPage: true });
await pg._sendToTarget("Emulation.clearDeviceMetricsOverride", {});
console.log("ASIDE_DIR=" + pwd); await closeTab(pg); console.log("GSTACK_STEP_OK");
'
\`\`\`

### Phase 5: Document

Confirm each issue by retrying once under the shared loop's exact-replay rule, then
minimize and report screenshot evidence immediately. A timeout before replay finishes leaves
confirmation incomplete. Later timeouts leave confirmed defects intact but evidence
or minimization unfinished.

**Interactive:** Phase 3, \`flow = true\`. Alternatives: \`pg.fill("#email", "qa@example.com")\`, \`pg.getByRole("button", { name: "Save" }).click()\`, \`pg.waitForSelector("#done")\`, \`pg.waitForURL(/dashboard/)\`. Link before/after screenshots in repro steps.

**Static** (copy/layout/images): one annotated screenshot and description.

\`\`\`bash
aside repl '
const pg = await openTab("<page-url>");
const a = await annotatedScreenshot(pg);
await fs.writeFile(path.join(pwd, "issue-002.png"), Buffer.from(a.base64Image, "base64"));
console.log("ASIDE_DIR=" + pwd); await closeTab(pg); console.log("GSTACK_STEP_OK");
'
\`\`\`

### Phase 6: Wrap Up

Format retained evidence without new probes, using \`templates/qa-report-template.md\`
from this host's installed QA directory and the caller's artifact/mixed-report rules.

Report score, Top 3 Things to Fix by severity, console health, severity counts, date, duration, page/screenshot counts and framework. Save \`baseline.json\`: \`date\` (YYYY-MM-DD), \`url\`, \`healthScore\`, \`issues\` (\`id\`, \`title\`, \`severity\`, \`category\`), \`categoryScores\`. Regression: fixed = prior only, new = current only.

## Health Score Rubric

Compute each category score (0-100), then take the weighted average.

### Counting
- Deduplicate the same root cause across pages. Use one primary category, first applicable: Links (navigation), Accessibility (access barriers), Functional (behavior), Performance (speed), Visual (layout), Content (copy), UX (friction), Console (remaining errors). No double deductions.
- Exclude **untested** categories; label partial scores **provisional** with coverage. None tested: "not scored". Compare only identical coverage.

### Console (weight: 15%)
Deduplicate reproducible errors/exceptions by message+source across pages. Exclude warnings, info, and defects scored elsewhere.
- 0 errors → 100
- 1-3 errors → 70
- 4-10 errors → 40
- 11+ errors → 10

### Links (weight: 10%)
Count unique broken destinations, including client-side routes: repeatable 4xx/5xx, missing routes/anchors, or timeouts. Exclude expected auth redirects and resource/API requests.
- 0 broken → 100
- Each broken link → -15 (minimum 0)

### Per-Category Scoring (Visual, Functional, UX, Content, Performance, Accessibility)
Start at 100; deduct per finding:
- Critical issue → -25
- High issue → -15
- Medium issue → -8
- Low issue → -3
Floor: 0.

Use the highest applicable severity; record impact/workaround:
- **Critical:** data loss, security/privacy exposure, or core app unusable for all users.
- **High:** core/major task blocked without a workaround.
- **Medium:** task impaired but a workaround exists.
- **Low:** cosmetic/copy/friction issue without lost task completion.
Console/Links use counts instead.

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
Use decimal weights (15% = 0.15): \`score = Σ (category_score × weight) / Σ tested weights\`. Round only the final score to the nearest integer (0.5 rounds up).

---

## Framework-Specific Guidance

- **Next.js:** hydration errors (\`Hydration failed\`, \`Text content did not match\`), \`_next/data\` 404s, link-click routing (not just \`goto\`), dynamic-content CLS.
- **Rails:** dev N+1 warnings, form CSRF, Turbo/Stimulus transitions, flash appearance/dismissal.
- **WordPress:** plugin JS conflicts, signed-in admin bar, \`/wp-json/\`, mixed content.
- **SPA:** snapshot navigation, stale state on return, back/forward history, console signs of leaks after extended use.

## Important Rules

**Never read source code during browser discovery.** Use realistic end-to-end flows; check console after every interaction. For missing click targets, use annotated labels, then ref/CSS clicks.

Use \`[REDACTED]\` for credentials. Follow BROWSER SETUP safety/sentinel rules: one AskUserQuestion listing non-LOCAL mutations per run, BEFORE acting. LOOK is not ACT.

**Never refuse to use the browser for a selected browser surface**, even backend-only app changes. Tests/curl cannot replace it. API/CLI/job/worker/webhook targets do not select it.`;
}

export function generateCoAuthorTrailer(ctx: TemplateContext): string {
  const { getHostConfig } = require('../../hosts/index');
  const hostConfig = getHostConfig(ctx.host);
  return hostConfig.coAuthorTrailer || 'Co-Authored-By: Claude <noreply@anthropic.com>';
}

export function generateSetupCommand(ctx: TemplateContext): string {
  // Every non-claude host must reinstall ITSELF on upgrade — bare `./setup`
  // defaults to the claude host and would leave the invoking host stale.
  return ctx.host === 'claude' ? './setup' : `./setup --host ${ctx.host}`;
}

export function generateChangelogWorkflow(ctx: TemplateContext): string {
  return `## Step 13: CHANGELOG (auto-generate)

1. Read \`CHANGELOG.md\` header to know the format.

2. **First, enumerate every commit on the branch:**
   \`\`\`bash
   git log ${ctx.skillName === 'ship' ? 'origin/<base>' : '<base>'}..HEAD --oneline
   \`\`\`
   Copy the full list. Count the commits. You will use this as a checklist.

3. **Read the full diff** to understand what each commit actually changed:
   \`\`\`bash
   git diff ${ctx.skillName === 'ship' ? 'origin/<base>' : '<base>...HEAD'}
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
   - ${ctx.skillName === 'ship' ? 'Insert after the observed file header, before the first release entry, dated today' : 'Insert after the file header (line 5), dated today'}
   - Format: \`## [X.Y.Z.W] - YYYY-MM-DD\`
   - **Voice:** Lead with what the user can now **do** that they couldn't before. Use plain language, not implementation details. Never mention TODOS.md, internal tracking, or contributor-facing details.

6. **Cross-check:** Compare your CHANGELOG entry against the commit list from step 2.
   Every user-facing change in that list must be represented; add any that is missing.
   Commits with no user-facing effect (merges, version bumps, fixes to work introduced
   earlier on this branch) need no bullet. The entry must reflect every user-facing theme.

**Do NOT ask the user to describe changes.** Infer from the diff and commit history.`;
}
