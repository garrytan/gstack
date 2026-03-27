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

export function generateBrowseMobileSetup(ctx: TemplateContext): string {
  return `## MOBILE SETUP (optional — check for browse-mobile binary)

\`\`\`bash
_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
BM=""
# Check 1: project-local build (dev mode in gstack repo itself)
[ -n "$_ROOT" ] && [ -x "$_ROOT/browse-mobile/dist/browse-mobile" ] && BM="$_ROOT/browse-mobile/dist/browse-mobile"
# Check 2: vendored skills in project (e.g., .claude/skills/gstack/browse-mobile)
[ -z "$BM" ] && [ -n "$_ROOT" ] && [ -x "$_ROOT/${ctx.paths.localSkillRoot}/browse-mobile/dist/browse-mobile" ] && BM="$_ROOT/${ctx.paths.localSkillRoot}/browse-mobile/dist/browse-mobile"
# Check 3: global gstack install (works from ANY project directory)
# browseDir is e.g. ~/.claude/skills/gstack/browse/dist — go up 2 levels to gstack root
[ -z "$BM" ] && [ -x ${ctx.paths.browseDir}/../../browse-mobile/dist/browse-mobile ] && BM=${ctx.paths.browseDir}/../../browse-mobile/dist/browse-mobile
if [ -n "$BM" ] && [ -x "$BM" ]; then
  echo "MOBILE_READY: $BM"
else
  echo "MOBILE_NOT_AVAILABLE"
fi
\`\`\`

If \`MOBILE_READY\`: the \`$BM\` variable points to the browse-mobile binary for mobile app automation via Appium.
If \`MOBILE_NOT_AVAILABLE\`: mobile testing is not available — web QA works as usual with \`$B\`.`;
}

export function generateQAMethodology(ctx: TemplateContext): string {
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

3b. **Mobile project detection** (runs regardless of which mobile backend is available):
   \`\`\`bash
   ls app.json app.config.js app.config.ts 2>/dev/null
   \`\`\`
   If \`app.json\` or \`app.config.*\` exists, this is a mobile (Expo/React Native) project.
   **Run the mobile pre-flight check and backend selection below. Do not ask the user — proceed automatically.**

   ---

   #### MOBILE PRE-FLIGHT CHECK

   The pre-flight check validates that a usable standalone build exists before spending time on device setup. This applies to BOTH local and cloud backends.

   **PF-1: Extract bundle ID**
   \`\`\`bash
   cat app.json 2>/dev/null | grep -o '"bundleIdentifier"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | grep -o '"[^"]*"$' | tr -d '"'
   \`\`\`
   If no bundleIdentifier found, check \`app.config.js\` or \`app.config.ts\` for it.

   **PF-2: Check for standalone (non-dev-client) build profile**
   \`\`\`bash
   cat eas.json 2>/dev/null
   \`\`\`
   Parse the \`eas.json\` build profiles. Look for ANY profile where \`developmentClient\` is NOT \`true\` (either \`false\`, absent, or not set). Common standalone profiles: \`preview\`, \`preview-sim\`, \`production\`.

   - If **only** \`developmentClient: true\` profiles exist (e.g., \`development\` profile only), or if no \`eas.json\` exists: **automatically create and build a standalone profile:**

     1. **Add a preview profile to \`eas.json\`:**
        If \`eas.json\` doesn't exist, create it. If it exists, add a \`preview\` profile:
        \`\`\`json
        {
          "build": {
            "preview": {
              "distribution": "internal",
              "ios": { "simulator": true }
            }
          }
        }
        \`\`\`
        If existing profiles have \`developmentClient: true\`, make sure the new \`preview\` profile does NOT include that field (absence = standalone).

     2. **Build the standalone app (local-first for speed):**
        Try local build first — avoids the EAS cloud queue (minutes vs 10-15 min):
        \`\`\`bash
        npx eas-cli build --profile preview --platform ios --local --non-interactive --output /tmp/preview-build.tar.gz 2>&1
        \`\`\`
        If \`--local\` fails (missing Xcode, CocoaPods, or native deps), fall back to cloud build:
        \`\`\`bash
        npx eas-cli build --profile preview --platform ios --non-interactive 2>&1
        \`\`\`
        Cloud builds take 5-15 minutes (queue + compile). Stream the output so the user can see progress. If the build fails (e.g., missing EAS login, missing Apple credentials), show the error and use AskUserQuestion:
        - A) I'll fix the issue and re-run /qa
        - B) Continue with web QA instead — skip mobile testing

     3. **Download the build artifact:**
        For local builds, the artifact is already at \`/tmp/preview-build.tar.gz\`. For cloud builds, EAS prints a download URL — download it:
        \`\`\`bash
        curl -L -o /tmp/preview-build.tar.gz "<eas-build-url>"
        \`\`\`
        Then extract:
        \`\`\`bash
        tar -xzf /tmp/preview-build.tar.gz -C /tmp/
        setopt +o nomatch 2>/dev/null || true; ls /tmp/*.app 2>/dev/null || ls /tmp/**/*.app 2>/dev/null
        \`\`\`

     4. **Upload to Revyl (if cloud mode):**
        If Revyl MCP tools are available, upload the build:
        \`\`\`
        upload_build(file_path="/tmp/<app-name>.app", platform="ios")
        \`\`\`
        Or for local mode, install directly:
        \`\`\`bash
        xcrun simctl install booted /tmp/<app-name>.app
        \`\`\`

     Tell the user: "Created preview build profile, built standalone app, and uploaded it. Continuing with mobile QA."

   - If a standalone profile exists: note the profile name and continue.

   **PF-2b: Fast path for subsequent runs (EAS Update)**
   If a standalone build already exists (from a previous QA run or manual build) but the code has changed since:
   \`\`\`bash
   npx eas-cli update --auto --non-interactive 2>&1
   \`\`\`
   EAS Update pushes JS bundle changes over-the-air to the existing native build — no rebuild needed, takes seconds instead of minutes. This works when only JS/TS code changed (no new native modules). If \`eas update\` fails or the project doesn't have EAS Update configured, skip this step silently — the existing build still works, it just won't have the latest JS changes.

   **PF-3: Verify build artifact exists**

   **For cloud mode (Revyl):** If Revyl MCP tools are available in this session (check if \`start_device_session\`, \`screenshot\`, \`device_tap\` tools exist), call \`list_builds\` to check if an actual build has been uploaded for this app.

   - If no builds found on Revyl: **automatically build and upload.** Run the same EAS build + upload flow from PF-2 above (steps 2-4). Do not bail — fix it and continue.
   - If builds found: note the build ID and continue.

   **For local mode (\`$BM\`):** Check if the app is installed on the simulator:
   \`\`\`bash
   xcrun simctl listapps booted 2>/dev/null | grep -q "<bundleId>"
   \`\`\`
   If not installed, check for a pre-built \`.app\` in the build output directories (\`ios/build/\`, \`~/.expo/\`). If a pre-built \`.app\` exists, install it directly: \`xcrun simctl install booted <path-to-.app>\`. If no pre-built artifact exists, run the EAS build flow from PF-2 (steps 2-3) then install the result. Only fall back to \`npx expo run:ios\` (Metro build) as a last resort.

   ---

   #### MOBILE BACKEND SELECTION (local-first)

   After pre-flight passes, select the mobile backend. **Local is preferred** — it's faster, free, and doesn't depend on network.

   1. If \`$BM\` is available (MOBILE_READY from setup) AND user did NOT pass \`--cloud\`: **LOCAL MODE** (Appium + iOS Simulator)
   2. If Revyl MCP tools are available AND (\`$BM\` is NOT available OR user passed \`--cloud\`): **CLOUD MODE** (Revyl)
   3. If neither is available: fall back to **WEB MODE** and warn: "No mobile testing backend available. Install browse-mobile for local testing or configure Revyl MCP for cloud testing."

   ---

   #### LOCAL MODE SETUP (Appium + iOS Simulator)

   **Step 0: Check permissions for mobile QA commands**
   Mobile QA runs many bash commands (\`$BM\`, \`appium\`, \`xcrun simctl\`, \`curl\`, \`sleep\`). Check if the user's Claude Code settings already allow these:
   \`\`\`bash
   cat ~/${ctx.host === 'codex' ? '.codex' : '.claude'}/settings.json 2>/dev/null | grep -c "browse-mobile"
   \`\`\`
   If the output is 0 (no browse-mobile permissions found), the user will be prompted for every single command — bad experience. Use AskUserQuestion:

   "Mobile QA needs to run many commands automatically (browse-mobile, appium, xcrun simctl, etc.). I can add permissions to your Claude Code settings so these run without prompting. This is a one-time setup."

   Options:
   - A) Yes, add mobile QA permissions (recommended) — adds allow rules to your settings.json
   - B) No, I'll approve each command manually

   If A: Read \`~/${ctx.host === 'codex' ? '.codex' : '.claude'}/settings.json\`, merge these permissions into the existing \`permissions.allow\` array (create it if it doesn't exist):
   \`\`\`
   "Bash(~/.claude/skills/gstack/browse-mobile/dist/browse-mobile:*)"
   "Bash($BM:*)"
   "Bash(BM=:*)"
   "Bash(appium:*)"
   "Bash(xcrun:*)"
   "Bash(curl -s http://127.0.0.1:*)"
   "Bash(curl -X POST http://127.0.0.1:*)"
   "Bash(curl http://127.0.0.1:*)"
   "Bash(lsof:*)"
   "Bash(sleep:*)"
   "Bash(open -a Simulator:*)"
   "Bash(SID=:*)"
   "Bash(JAVA_HOME=:*)"
   "Bash(cat app.json:*)"
   "Bash(cat app.config:*)"
   "Bash(ls app.json:*)"
   "Bash(mkdir -p .gstack:*)"
   "Bash(cat .gstack:*)"
   "Bash(kill:*)"
   \`\`\`
   After writing, tell the user: "Permissions added. These apply globally — you won't be prompted for mobile QA commands in any project."

   If B: Continue — the user will approve each command individually.

   **Step 1: Start Appium if not running**
   \`\`\`bash
   curl -s http://127.0.0.1:4723/status | grep -q '"ready":true' 2>/dev/null
   \`\`\`
   If Appium is NOT running, start it automatically:
   \`\`\`bash
   JAVA_HOME=/opt/homebrew/opt/openjdk@17 appium --relaxed-security > /tmp/appium-qa.log 2>&1 &
   sleep 3
   curl -s http://127.0.0.1:4723/status | grep -q '"ready":true' && echo "Appium started" || echo "Appium failed to start"
   \`\`\`
   If Appium fails to start, run \`$BM setup-check\` to diagnose missing dependencies and show the user what to install. Then continue with web QA as fallback.

   **Step 2: Boot simulator if none running**
   \`\`\`bash
   xcrun simctl list devices booted | grep -q "Booted"
   \`\`\`
   If no simulator is booted:
   \`\`\`bash
   xcrun simctl boot "$(xcrun simctl list devices available | grep iPhone | head -1 | grep -o '[A-F0-9-]\\{36\\}')" 2>/dev/null
   open -a Simulator
   sleep 3
   \`\`\`

   **Step 3: Install app if not already installed**
   The pre-flight check (PF-3) already determined whether the app is installed. If not, it found a pre-built \`.app\` or determined Metro build is needed.
   - If pre-built \`.app\` was found: \`xcrun simctl install booted <path-to-.app>\`
   - If no pre-built \`.app\`: start Metro and build:
     - Check if Metro bundler is running: \`lsof -i :8081 | grep -q LISTEN\`
     - If Metro not running, start it: \`cd <project_root> && npx expo start --ios &\` and wait 10s
     - Run: \`npx expo run:ios\` to build and install the app (this may take 2-5 minutes for first build — let it run)
     - After build completes, verify: \`xcrun simctl listapps booted | grep -q "<bundleId>"\`

   **Step 4: Activate local mobile mode**
   If all steps succeeded: **LOCAL MOBILE MODE ACTIVE** — use \`$BM\` instead of \`$B\` for all subsequent commands.
   Set the environment: \`BROWSE_MOBILE_BUNDLE_ID=<bundleId>\`

   ---

   #### CLOUD MODE SETUP (Revyl)

   **Step 0: Start device session**
   \`\`\`
   start_device_session(platform="ios")
   \`\`\`
   Save the returned \`viewer_url\` and \`session_index\`. Tell the user: "Revyl device provisioned. Viewer: <viewer_url>"

   **Step 1: Install and launch the app**
   If PF-3 found an uploaded build: \`install_app()\` using the build from \`list_builds\`.
   Then: \`launch_app()\` to start the app.

   **Step 2: Verify app launched correctly**
   \`\`\`
   screenshot()
   \`\`\`
   Check the screenshot. If it shows "DEVELOPMENT SERVERS" or the Expo dev launcher, the build is a dev client — the pre-flight should have caught this. Stop and tell the user to create a standalone build.

   **CLOUD MOBILE MODE ACTIVE** — use Revyl MCP tools for all subsequent commands.

   ---

   #### MOBILE COMMAND REFERENCE

   | Action | Local (\`$BM\`) | Cloud (Revyl MCP) |
   |--------|---------------|-------------------|
   | Launch app | \`$BM goto app://<bundleId>\` | \`launch_app()\` or \`device_navigate(url)\` |
   | Tap element | \`$BM click @e3\` or \`$BM click label:Text\` | \`device_tap(target="the 'Text' button")\` |
   | Type text | \`$BM fill @e3 "text"\` | \`device_tap(target="input field")\` then \`device_type(text="text")\` |
   | Screenshot | \`$BM screenshot <path>\` | \`screenshot()\` |
   | Scroll down | \`$BM scroll down\` | \`device_swipe(direction="up")\` (finger UP = content DOWN) |
   | Scroll up | \`$BM scroll up\` | \`device_swipe(direction="down")\` |
   | Go back | \`$BM back\` | \`device_back()\` |
   | Get element tree | \`$BM snapshot -i\` | \`screenshot()\` + describe what's visible |
   | Check orientation | \`$BM viewport landscape\` | Not available — device is fixed orientation |
   | Console errors | SKIP | SKIP |

   **Revyl interaction tips:**
   - \`device_tap(target=...)\` uses AI vision grounding — describe what's visible on screen: "the 'Sign In' button", "input box with placeholder 'Email'"
   - Always call \`screenshot()\` after actions to verify the result
   - Use \`device_swipe\` for scrolling: \`direction="up"\` scrolls content DOWN (reveals content below)
   - For form filling: tap the field first, then type. Two separate calls.
   - \`device_clear_text()\` before typing if the field has existing content

   ---

   #### MOBILE SESSION MANAGEMENT (Cloud mode only)

   **Keep-alive during fix phases:** The Revyl device session has a 5-minute idle timeout. During fix phases (reading code, editing files, committing), the session may expire. **Before resuming any device interaction after a code edit:**

   1. Call \`get_session_info()\` to check session status
   2. If the session is expired or has less than 1 minute remaining:
      - Call \`stop_device_session()\` (clean up the old session)
      - Call \`start_device_session(platform="ios")\` (new session)
      - Call \`install_app()\` and \`launch_app()\` (re-install and relaunch)
      - Navigate back to the screen you were testing
   3. If the session is healthy: continue normally

   **Cleanup:** At the end of QA (or on any error that aborts the run), always call \`stop_device_session()\` to release the cloud device and stop billing.

   ---

   **In mobile mode (both local and cloud), the QA flow adapts:**

   **SPEED IS CRITICAL — minimize round trips:**
   - **Local mode:** Combine multiple commands in a single bash call using \`&&\`: e.g., \`$BM click label:Sign In" && sleep 2 && $BM snapshot -i && $BM screenshot /tmp/screen.png\`
   - **Cloud mode:** Take a screenshot after every action to verify results (Revyl tools are individual MCP calls, not batchable). Keep actions concise — one tap, one screenshot, assess, next action.
   - Take screenshots only at key milestones (after navigation, after finding a bug), not after every single tap

   **Launch and navigate:**
   - **Local:** Launch the app: \`$BM goto app://<bundleId>\`
   - **Cloud:** \`launch_app()\` then \`screenshot()\` to see initial state
   - If the screen shows "DEVELOPMENT SERVERS" or "localhost:8081" — this is the Expo dev launcher. The pre-flight check should have prevented this. If it appears, stop and tell the user to create a standalone build.

   **Interacting with elements:**
   - **Local:** If an element is visible in \`$BM text\` but not detected as interactive (common with RN \`Pressable\` missing \`accessibilityRole\`), use \`$BM click label:Label Text"\` — this is the primary fallback
   - **Cloud:** Use \`device_tap(target="description of element")\` — Revyl's AI grounding handles element detection automatically
   - Skip web-only commands: \`console --errors\`, \`html\`, \`css\`, \`js\`, \`cookies\` — not available in mobile mode
   - For form filling: **Local:** \`$BM fill @e3 "text"\`. **Cloud:** \`device_tap(target="field")\` then \`device_type(text="text")\`
   - Scrolling: **Local:** \`$BM scroll down\`. **Cloud:** \`device_swipe(direction="up")\`
   - Back navigation: **Local:** \`$BM back\`. **Cloud:** \`device_back()\`

   **Findings:**
   - Flag missing \`accessibilityRole\` / \`accessibilityLabel\` as accessibility findings
   - Test portrait and landscape (local only): \`$BM viewport landscape && sleep 1 && $BM screenshot /tmp/landscape.png\`
   - Take screenshots at milestones and use the Read tool to show them to the user

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

### Expo / React Native (mobile mode — local \`$BM\` or cloud Revyl)
- Many \`Pressable\` / \`TouchableOpacity\` components lack \`accessibilityRole="button"\` — they won't appear as interactive. **Local:** Use \`$BM text\` to find visible labels, then \`$BM click label:Label"\`. **Cloud:** Use \`device_tap(target="visible label text")\` — Revyl's AI grounding handles this automatically.
- After tapping navigation elements, wait 1-2s before taking a snapshot — RN transitions are animated. **Cloud:** call \`device_wait(milliseconds=2000)\` or just call \`screenshot()\` after a brief pause.
- Test both portrait and landscape orientation (local only): \`$BM viewport landscape\` / \`$BM viewport portrait\`. Cloud devices have fixed orientation.
- Flag every component without proper accessibility props (\`accessibilityRole\`, \`accessibilityLabel\`) as an accessibility finding — these affect both screen readers and automation.
- If the Expo dev launcher appears (showing "DEVELOPMENT SERVERS"), the pre-flight check missed a dev-client build. Stop and instruct the user to create a standalone build.
- RevenueCat / in-app purchase errors in development are expected — note but don't flag as bugs.
- Scrolling: **Local:** \`$BM scroll down\` uses swipe gestures. **Cloud:** \`device_swipe(direction="up")\` — remember direction is finger direction, not content direction.
- **Cloud session management:** Before resuming device interaction after editing source code, call \`get_session_info()\` to verify the session is still active. Restart if expired (see Mobile Session Management section above).

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
  if (ctx.host === 'codex') {
    return 'Co-Authored-By: OpenAI Codex <noreply@openai.com>';
  }
  return 'Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>';
}
