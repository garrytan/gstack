/**
 * Mobile QA resolvers — Revyl cloud devices + browse-mobile Appium fallback.
 */

import type { TemplateContext } from './types';

export function generateBrowseMobileSetup(ctx: TemplateContext): string {
  return `## MOBILE SETUP (optional — check for browse-mobile binary and Revyl)

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

**Check for Revyl cloud device platform (preferred — much faster than Appium):**

\`\`\`bash
if command -v revyl &>/dev/null; then
  echo "REVYL_READY"
  if revyl auth status 2>&1 | grep -qiE "authenticated|logged in|valid"; then
    echo "REVYL_AUTH_OK"
  else
    echo "REVYL_AUTH_NEEDED"
  fi
else
  echo "REVYL_NOT_AVAILABLE"
fi
\`\`\`

If the output contains \`REVYL_READY\`, the CLI is installed. Then check auth:
- If \`REVYL_AUTH_OK\`: proceed — Revyl is fully ready.
- If \`REVYL_AUTH_NEEDED\`: **automatically run \`revyl auth login\`** to authenticate. This opens a browser for OAuth. After the user completes login, re-run \`revyl auth status\` to verify. If auth still fails (e.g., headless environment with no browser), use AskUserQuestion: "Revyl auth failed — this usually means no browser is available. You can authenticate manually by running \`revyl auth login\` in a terminal with browser access, or provide a Revyl API token via \`revyl auth token <TOKEN>\`." Options: A) I'll authenticate now — wait for me. B) Skip Revyl — use local Appium instead.

**Mobile backend priority — Revyl is preferred for AI-grounded interaction:**
1. If \`REVYL_READY\` (revyl CLI found): **always use Revyl** for mobile QA. Revyl's AI-grounded element targeting (\`--target "description"\`) is far superior to Appium's element refs (\`@e3\`). No need to take snapshots to find refs — just describe what you see. The fast-fail tunnel check and Debug builds keep setup under 3 minutes.
2. If \`REVYL_NOT_AVAILABLE\` AND \`MOBILE_READY\` (browse-mobile binary available): fall back to local Appium + simulator. Slower interaction (requires snapshots for element refs) but works offline with zero cloud dependencies.
3. If \`REVYL_NOT_AVAILABLE\` AND not \`MOBILE_READY\` AND this is a mobile project (\`app.json\` exists): **tell the user to install Revyl.** Use AskUserQuestion:

   "This is a mobile project but the Revyl CLI isn't installed. Revyl provides cloud-hosted devices for mobile QA — much faster than local Appium/Simulator setup. Install it with: \`npm install -g @anthropic-ai/revyl\` (or check https://docs.revyl.dev for setup instructions)."

   Options:
   - A) I'll install it now — wait for me (then re-run the revyl check after user confirms)
   - B) Skip Revyl — use local Appium/Simulator instead
   - C) Skip mobile QA entirely — test as web only

   If A: after user confirms, re-run \`command -v revyl\` to verify. If still not found, fall through to B.
   If B and \`MOBILE_READY\`: use browse-mobile (Appium + local simulator).
   If B and not \`MOBILE_READY\`, or C: fall back to web QA with \`$B\`.`;
}

/**
 * Generates the mobile-specific sections that get injected into QA_METHODOLOGY.
 * Called from utility.ts generateQAMethodology.
 */
export function generateMobileQASections(ctx: TemplateContext): string {
  return `
3b. **Mobile project detection** — if \`$BM\` is available (MOBILE_READY from setup):
   \`\`\`bash
   ls app.json app.config.js app.config.ts 2>/dev/null
   \`\`\`
   If \`app.json\` or \`app.config.*\` exists, this is a mobile (Expo/React Native) project.
   **Automatically set up the entire mobile environment — do not ask the user:**

   **Step 0: Auto-configure permissions for mobile QA commands**
   Mobile QA runs many bash commands that need pre-approval. Check and auto-add missing permissions:
   \`\`\`bash
   SETTINGS_FILE=~/${ctx.host === 'codex' ? '.codex' : '.claude'}/settings.json
   APPIUM_COUNT=$(cat "$SETTINGS_FILE" 2>/dev/null | grep -c "browse-mobile")
   echo "APPIUM_PERMISSIONS=$APPIUM_COUNT"
   \`\`\`
   If \`APPIUM_PERMISSIONS\` is 0: **automatically** read \`$SETTINGS_FILE\`, merge these permissions into the existing \`permissions.allow\` array (create it if it doesn't exist), and write it back. Do not ask — just add them:
   \`\`\`
   "Bash(${ctx.paths.skillRoot}/browse-mobile/dist/browse-mobile:*)"
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
   "Bash(ls app.config:*)"
   "Bash(mkdir -p .gstack:*)"
   "Bash(cat .gstack:*)"
   "Bash(kill:*)"
   \`\`\`
   Tell the user: "Added Appium mobile QA permissions to settings.json — commands will run without prompting."

   **Step 1: Extract bundle ID**
   \`\`\`bash
   cat app.json 2>/dev/null | grep -o '"bundleIdentifier"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | grep -o '"[^"]*"$' | tr -d '"'
   \`\`\`
   If no bundleIdentifier found, check \`app.config.js\` or \`app.config.ts\` for it.

   **Step 2: Start Appium if not running**
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

   **Step 3: Boot simulator if none running**
   \`\`\`bash
   xcrun simctl list devices booted | grep -q "Booted"
   \`\`\`
   If no simulator is booted:
   \`\`\`bash
   xcrun simctl boot "$(xcrun simctl list devices available | grep iPhone | head -1 | grep -o '[A-F0-9-]\\{36\\}')" 2>/dev/null
   open -a Simulator
   sleep 3
   \`\`\`

   **Step 4: Check if app is installed, build if not**
   \`\`\`bash
   xcrun simctl listapps booted 2>/dev/null | grep -q "<bundleId>"
   \`\`\`
   If the app is NOT installed on the simulator:
   - Check if Metro bundler is running: \`lsof -i :8081 | grep -q LISTEN\`
   - If Metro not running, start it: \`cd <project_root> && npx expo start --ios &\` and wait 10s
   - Run: \`npx expo run:ios\` to build and install the app (this may take 2-5 minutes for first build — let it run)
   - After build completes, verify: \`xcrun simctl listapps booted | grep -q "<bundleId>"\`

   **Step 5: Activate mobile mode**
   If all steps succeeded: **MOBILE MODE ACTIVE** — use \`$BM\` instead of \`$B\` for all subsequent commands.
   Set the environment: \`BROWSE_MOBILE_BUNDLE_ID=<bundleId>\`

   **In mobile mode, the QA flow adapts:**

   **SPEED IS CRITICAL — batch commands to minimize round trips:**
   - Combine multiple commands in a single bash call using \`&&\`: e.g., \`$BM click label:Sign In" && sleep 2 && $BM snapshot -i && $BM screenshot /tmp/screen.png\`
   - Do NOT run each command as a separate Bash call — that adds permission prompts and overhead
   - Use \`sleep 1\` or \`sleep 2\` between commands (not separate tool calls)
   - Take screenshots only at key milestones (after navigation, after finding a bug), not after every single tap

   **Launch and navigate:**
   - Launch the app: \`$BM goto app://<bundleId>\`
   - If the first snapshot shows "DEVELOPMENT SERVERS" or "localhost:8081" — this is the Expo dev launcher. Automatically click the localhost URL: \`$BM click label:http://localhost:8081" && sleep 8 && $BM snapshot -i\`
   - Use \`$BM snapshot -i\` to get the accessibility tree with @e refs

   **Interacting with elements:**
   - If an element is visible in \`$BM text\` but not detected as interactive (common with RN \`Pressable\` missing \`accessibilityRole\`), use \`$BM click label:Label Text"\` — this is the primary fallback
   - Skip web-only commands: \`console --errors\`, \`html\`, \`css\`, \`js\`, \`cookies\` — not available in mobile mode
   - For form filling: \`$BM fill @e3 "text"\` works — coordinate tap + keyboard if needed
   - Use \`$BM scroll down\` for content below the fold, \`$BM back\` for navigation

   **Findings:**
   - Flag missing \`accessibilityRole\` / \`accessibilityLabel\` as accessibility findings
   - Test portrait and landscape: \`$BM viewport landscape && sleep 1 && $BM screenshot /tmp/landscape.png\`
   - Take screenshots at milestones and use the Read tool to show them to the user

3c. **Revyl cloud device mobile QA** — if \`REVYL_READY\` from setup (the \`revyl\` CLI is installed), **always use Revyl** for mobile QA. Revyl is much faster than Appium — skip the browse-mobile path entirely:

   \`\`\`bash
   ls app.json app.config.js app.config.ts 2>/dev/null
   \`\`\`
   If \`app.json\` or \`app.config.*\` exists AND \`REVYL_READY\`, use Revyl cloud devices instead of local Appium.

   **Mobile QA timing expectations:**
   - First run (no build cached): ~3-5 min (Debug build + upload + provision)
   - First run (Debug .app already in DerivedData): ~1-2 min (upload + provision)
   - Subsequent runs (build cached on Revyl): ~1-2 min (provision + test)
   - Fix verification cycle: ~2 min per batch (Debug rebuild + re-upload)
   - **Note:** Revyl cloud devices are billed per session. Check your Revyl dashboard for pricing details.

   **Revyl Step 0: Auto-configure permissions for Revyl commands**
   Revyl mobile QA runs many CLI commands that need pre-approval. Check and auto-add missing permissions:
   \`\`\`bash
   SETTINGS_FILE=~/${ctx.host === 'codex' ? '.codex' : '.claude'}/settings.json
   REVYL_COUNT=$(cat "$SETTINGS_FILE" 2>/dev/null | grep -c "Bash(revyl:")
   echo "REVYL_PERMISSIONS=$REVYL_COUNT"
   \`\`\`
   If \`REVYL_PERMISSIONS\` is 0 or less than 1: **automatically** read \`$SETTINGS_FILE\`, merge these permissions into the existing \`permissions.allow\` array (create it if it doesn't exist), and write it back. Do not ask — just add them:
   \`\`\`
   "Bash(revyl:*)"
   "Bash(lsof:*)"
   "Bash(sleep:*)"
   "Bash(kill:*)"
   "Bash(cat app.json:*)"
   "Bash(cat app.config:*)"
   "Bash(ls app.json:*)"
   "Bash(ls app.config:*)"
   "Bash(mkdir -p .gstack:*)"
   "Bash(cat .gstack:*)"
   "Bash(curl -s:*)"
   "Bash(curl:*)"
   "Bash(npx expo:*)"
   "Bash(npx eas:*)"
   "Bash(python3 -c:*)"
   "Bash(find ~/Library:*)"
   "Bash(grep:*)"
   "Bash(jq:*)"
   "Bash(nslookup:*)"
   "Bash(xcode-select:*)"
   "Bash(git rev-parse:*)"
   "Bash(cat ~/${ctx.host === 'codex' ? '.codex' : '.claude'}:*)"
   "Bash(rm -f /tmp/revyl:*)"
   "Bash(echo:*)"
   "Bash(ps:*)"
   "Bash(head:*)"
   "Bash(tail:*)"
   "Bash(sed:*)"
   "Bash(awk:*)"
   "Bash(tr:*)"
   "Bash(cut:*)"
   "Bash(wc:*)"
   "Bash(sort:*)"
   "Bash(diff:*)"
   "Bash(tee:*)"
   "Bash(test:*)"
   "Bash([:*)"
   "Bash(for:*)"
   "Bash(if:*)"
   "Bash(while:*)"
   "Bash(METRO_PID:*)"
   "Bash(METRO_CMD:*)"
   "Bash(TUNNEL_URL:*)"
   "Bash(TUNNEL_HOST:*)"
   "Bash(REVYL_DEV_PID:*)"
   "Bash(REVYL_COUNT:*)"
   "Bash(REVYL_APP_ID:*)"
   "Bash(EXISTING_APP:*)"
   "Bash(PROJECT_NAME:*)"
   "Bash(STATUS:*)"
   "Bash(APP_PATH:*)"
   "Bash(BUNDLE_ID:*)"
   "Bash(SETTINGS_FILE:*)"
   "Bash(npm:*)"
   "Bash(xcodebuild:*)"
   "Bash(cd:*)"
   "Bash(cp:*)"
   "Bash(mv:*)"
   "Bash(touch:*)"
   "Bash(chmod:*)"
   "Bash(which:*)"
   "Bash(command:*)"
   "Bash(type:*)"
   "Bash(source:*)"
   "Bash(export:*)"
   "Bash(date:*)"
   "Bash(mktemp:*)"
   "Bash(stat:*)"
   "Bash(basename:*)"
   "Bash(dirname:*)"
   "Bash(readlink:*)"
   "Bash(open:*)"
   \`\`\`
   Tell the user: "Added Revyl mobile QA permissions to settings.json — commands will run without prompting."

   **Revyl Step 1: Initialize Revyl config if needed**
   \`\`\`bash
   [ -f .revyl/config.yaml ] && echo "REVYL_CONFIG_EXISTS" || echo "REVYL_NEEDS_INIT"
   \`\`\`
   If \`REVYL_NEEDS_INIT\`:
   \`\`\`bash
   revyl init -y
   \`\`\`
   After \`revyl init -y\`, **validate the generated YAML** (known Revyl CLI bug produces broken indentation):
   \`\`\`bash
   python3 -c "import yaml; yaml.safe_load(open('.revyl/config.yaml'))" 2>&1 && echo "YAML_VALID" || echo "YAML_INVALID"
   \`\`\`
   If \`YAML_INVALID\`: Read \`.revyl/config.yaml\`, identify indentation issues in the \`hotreload.providers\` section (fields like \`port\`, \`app_scheme\`, \`platform_keys\` may be at the wrong indent level), fix them so nested fields are properly indented under their parent, and write the corrected file back.

   **Revyl Step 2: Detect or select Revyl app**
   \`\`\`bash
   grep -q 'app_id' .revyl/config.yaml 2>/dev/null && echo "APP_LINKED" || echo "APP_NOT_LINKED"
   \`\`\`
   If \`APP_NOT_LINKED\`, auto-detect the app:
   \`\`\`bash
   PROJECT_NAME=$(jq -r '.expo.name // .name' app.json 2>/dev/null)
   revyl app list --json 2>/dev/null | jq -r '.apps[] | "\\(.id) \\(.name)"'
   \`\`\`
   - If exactly one app matches the project name: use its ID automatically.
   - If multiple apps exist: use AskUserQuestion to let the user pick which Revyl app to use. Show the app names and IDs.
   - If no apps exist: use AskUserQuestion to ask whether to create one (\`revyl app create --name "$PROJECT_NAME"\`).
   Store the selected app ID as \`REVYL_APP_ID\`.

   **Revyl Step 3: Try dev loop first, fall back to static Debug build**

   Attempt the dev loop (Metro + tunnel) first. If it fails, fall back to a static Debug build (faster than Release, fine for QA).

   **Before starting the dev loop, check if Metro is already running on port 8081.** Revyl starts its own Metro bundler, so an existing one causes a port conflict (Revyl gets :8082, can't serve the project, times out after ~65s).
   \`\`\`bash
   METRO_PID=$(lsof -ti :8081 2>/dev/null)
   if [ -n "$METRO_PID" ]; then
     METRO_CMD=$(ps -p "$METRO_PID" -o comm= 2>/dev/null)
     if echo "$METRO_CMD" | grep -qiE "node|metro"; then
       echo "Metro already running on :8081 (PID $METRO_PID, $METRO_CMD) — killing to avoid port conflict with Revyl dev loop"
       kill "$METRO_PID" 2>/dev/null || true
       sleep 2
     else
       echo "WARNING: Port 8081 in use by $METRO_CMD (PID $METRO_PID) — not Metro, skipping kill. Revyl dev loop may fail."
     fi
   fi
   \`\`\`

   **Dev loop startup — fail fast (15s DNS check, no retry).** Cloudflare tunnel DNS is flaky. Rather than burning 4+ minutes on retries, check DNS once and fall back immediately if it fails.

   Start in background and poll for readiness:
   \`\`\`bash
   revyl dev start --platform ios --open \${REVYL_APP_ID:+--app-id "$REVYL_APP_ID"} > /tmp/revyl-dev-output.log 2>&1 &
   REVYL_DEV_PID=$!
   echo "REVYL_DEV_PID=$REVYL_DEV_PID"
   \`\`\`

   Poll every 5 seconds for up to 60 seconds. **Only treat fatal process errors as failures — NOT HMR diagnostic warnings.** The HMR diagnostics (lines like "[hmr] Metro health: FAILED" or "[hmr] Tunnel HTTP: FAILED") are warnings, not crashes. The dev loop continues provisioning the device even when HMR checks fail.
   \`\`\`bash
   for i in $(seq 1 12); do
     if grep -q "Dev loop ready" /tmp/revyl-dev-output.log 2>/dev/null; then
       echo "DEV_LOOP_STARTED"
       break
     fi
     if grep -qiE "fatal|panic|exited with|process died|ENOSPC|ENOMEM" /tmp/revyl-dev-output.log 2>/dev/null; then
       echo "DEV_LOOP_FAILED"
       break
     fi
     sleep 5
   done
   # Check for HMR warnings (not failures — dev loop is still running)
   if grep -q "Hot reload may not work" /tmp/revyl-dev-output.log 2>/dev/null; then
     echo "DEV_LOOP_HMR_WARNING"
   fi
   cat /tmp/revyl-dev-output.log
   \`\`\`

   **If \`DEV_LOOP_HMR_WARNING\`:** The dev loop is running but hot reload is degraded — the app will load from a cached build. Code changes won't appear live. Note this and continue — the device is still provisioning and will be usable for QA testing of the existing build. You can still do a static rebuild later if code changes need verification.

   **Verify the tunnel (only if \`DEV_LOOP_STARTED\` without HMR warning).** If HMR already warned, skip tunnel verification — the tunnel is known-broken but the device is still usable. Check DNS resolution directly (15s max):
   \`\`\`bash
   TUNNEL_URL=$(grep -oE "https://[a-z0-9-]+\\.trycloudflare\\.com" /tmp/revyl-dev-output.log 2>/dev/null | head -1)
   TUNNEL_HOST=$(echo "$TUNNEL_URL" | sed 's|https://||')
   if [ -n "$TUNNEL_HOST" ]; then
     for i in $(seq 1 3); do
       nslookup "$TUNNEL_HOST" 2>/dev/null | grep -q "Address" && echo "DNS_RESOLVED" && break
       sleep 5
     done
   else
     echo "NO_TUNNEL_URL"
   fi
   \`\`\`

   **Evaluate the result:**

   1. If \`DNS_RESOLVED\`: verify with a quick HTTP health check (15s max):
      \`\`\`bash
      for i in $(seq 1 5); do
        STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$TUNNEL_URL/status" 2>/dev/null)
        [ "$STATUS" = "200" ] && echo "TUNNEL_OK" && break
        sleep 3
      done
      \`\`\`
      If \`TUNNEL_OK\`: **dev loop is healthy.** Take a screenshot to confirm the app loaded.
      - **iOS deep link dialogs:** iOS may show "Open in [AppName]?" — tap "Open" if it appears.
      - If the app is on the home screen: re-open via \`revyl device navigate --url "$DEEP_LINK"\`.

   2. If \`DEV_LOOP_HMR_WARNING\` (tunnel broken but device provisioning): **let the device finish provisioning.** Wait for the device to be ready (poll \`revyl device list --json\` for an active session, up to 60s). Once the device is up, take a screenshot — the app loaded from a cached build. Tell the user: "Dev loop is running but hot reload is broken — testing against the cached build. If you need to verify code changes, I'll do a static rebuild after the QA pass." **Do NOT kill the dev loop or fall back to static mode** — the device is usable.

   3. If \`DNS_FAILED\`, \`NO_TUNNEL_URL\`, or HTTP never returned 200 (and no HMR warning — process actually failed): **tunnel is dead. Fall back to static mode immediately — do not retry.** Before falling back, run stale build detection (below).

   **Stale build detection (run before falling back to static mode):** If the tunnel failed but the app still launched on-device, it's running from a previously uploaded build — not your current code:
   \`\`\`bash
   revyl build list --app "$REVYL_APP_ID" --json 2>/dev/null | jq -r '.versions[0] | "BUILD_SHA=\\(.git_sha // "unknown") BUILD_DATE=\\(.created_at // "unknown")"'
   echo "CURRENT_SHA=$(git rev-parse --short HEAD)"
   \`\`\`
   - If \`BUILD_SHA\` != \`CURRENT_SHA\`: warn "App on-device is from commit \`BUILD_SHA\` but you're on \`CURRENT_SHA\`. Code changes are NOT visible. Building a fresh version."
   - If no previous build exists: the dev loop would have failed visibly (nothing to load). This is the clearer failure mode.

   After falling back, kill the dev loop process before proceeding to static build.

   **Stopping the dev loop:** \`revyl dev stop\` does not exist. Kill the background process:
   \`\`\`bash
   kill $REVYL_DEV_PID 2>/dev/null || true
   METRO_PID=$(lsof -ti :8081 2>/dev/null)
   [ -n "$METRO_PID" ] && kill "$METRO_PID" 2>/dev/null || true
   \`\`\`

   **Revyl Step 3b: Static mode fallback (Debug build)**

   If the dev loop failed, or if you fell through to this step:

   First, check for an existing recent build to avoid rebuilding:
   \`\`\`bash
   revyl build list --app "$REVYL_APP_ID" --json 2>/dev/null | jq -r '.versions[0]'
   \`\`\`
   If the latest build was uploaded recently AND the git SHA matches (check \`git rev-parse --short HEAD\` against the build metadata), reuse it — skip to Step 4.

   Next, check if a recent Debug build already exists in DerivedData (from normal dev work — avoids building entirely):
   \`\`\`bash
   EXISTING_APP=$(find ~/Library/Developer/Xcode/DerivedData -name "*.app" -path "*Debug-iphonesimulator*" \\
     -not -path "*/Intermediates/*" -newer package.json -maxdepth 6 2>/dev/null | \\
     xargs ls -dt 2>/dev/null | head -1)
   [ -n "$EXISTING_APP" ] && echo "EXISTING_DEBUG_BUILD: $EXISTING_APP" || echo "NO_EXISTING_BUILD"
   \`\`\`
   If \`EXISTING_DEBUG_BUILD\`: use it as APP_PATH — skip to Upload step below.

   If no existing build, check what build tools are available:
   \`\`\`bash
   xcode-select -p 2>/dev/null && echo "XCODE_AVAILABLE" || echo "XCODE_NOT_AVAILABLE"
   [ -f eas.json ] && echo "EAS_CONFIG_EXISTS" || echo "EAS_NO_CONFIG"
   \`\`\`

   **Build strategy (try in order):**
   1. **If \`XCODE_AVAILABLE\`:** Local Debug build is fastest (much faster than Release, fine for QA):
      \`\`\`bash
      npx expo run:ios --configuration Debug --no-install
      \`\`\`
      Then find the built .app:
      \`\`\`bash
      find ~/Library/Developer/Xcode/DerivedData -name "*.app" -path "*Debug-iphonesimulator*" \\
        -not -path "*/Intermediates/*" -newer package.json -maxdepth 6 2>/dev/null | \\
        xargs ls -dt 2>/dev/null | head -1
      \`\`\`
   2. **If \`XCODE_NOT_AVAILABLE\` AND \`EAS_CONFIG_EXISTS\`:** Use EAS cloud build:
      \`\`\`bash
      npx eas build --platform ios --profile preview --non-interactive
      \`\`\`
      Download the build artifact when complete and use it as the APP_PATH.
   3. **If neither Xcode nor EAS is available:** Use AskUserQuestion:
      "Cannot build the app — no Xcode installed and no EAS (Expo Application Services) configuration found. To proceed with mobile QA, you need one of: (1) Install Xcode from the App Store, (2) Set up EAS with \`npx eas init\` and \`npx eas build:configure\`, or (3) Provide a pre-built .app file path."
      Options: A) I'll install Xcode — wait for me. B) I'll set up EAS — wait for me. C) Skip mobile QA — test as web only.

   Upload to Revyl:
   \`\`\`bash
   revyl build upload --file "$APP_PATH" --app "$REVYL_APP_ID" --skip-build -y
   \`\`\`

   **Revyl Step 4: Provision device and launch app**
   \`\`\`bash
   revyl device start --platform ios --json
   revyl device install --app-id "$REVYL_APP_ID"
   revyl device launch --bundle-id "$BUNDLE_ID"
   \`\`\`

   **Revyl Step 5: Activate Revyl mobile mode**
   If all steps succeeded: **REVYL MOBILE MODE ACTIVE**.

   In Revyl mode, use these commands instead of \`$B\` or \`$BM\`:
   | Web (\`$B\`)  | Appium (\`$BM\`) | Revyl |
   |---|---|---|
   | \`$B goto <url>\` | \`$BM goto app://<id>\` | \`revyl device launch --bundle-id <id>\` |
   | \`$B click @e3\` | \`$BM click @e3\` | \`revyl device tap --target "description of element"\` |
   | \`$B fill @e3 "text"\` | \`$BM fill @e3 "text"\` | \`revyl device type --target "description of field" --text "text"\` |
   | \`$B screenshot\` | \`$BM screenshot\` | \`revyl device screenshot --out <path>\` (then Read the image) |
   | \`$B scroll down\` | \`$BM scroll down\` | \`revyl device swipe --direction up --x 220 --y 500\` (up moves finger UP, scrolls DOWN) |
   | \`$B back\` | \`$BM back\` | \`revyl device back\` |

   **Revyl interaction loop:**
   1. \`revyl device screenshot --out screenshot.png\` — see the current screen (then Read the image)
   2. Briefly describe what is visible
   3. Take one action (tap, type, swipe)
   4. \`revyl device screenshot --out screenshot.png\` — verify the result (then Read the image)
   5. Repeat

   **Swipe direction semantics:** \`direction='up'\` moves the finger UP (scrolls content DOWN to reveal content below). \`direction='down'\` moves the finger DOWN (scrolls content UP).

   **Session idle timeout:** Revyl sessions auto-terminate after 5 minutes of inactivity. The timer resets on every tool call. Use \`revyl device info\` to check remaining time if needed.

   **Keepalive during fix phases:** When you switch to reading/editing source code (fix phase), the Revyl session will timeout silently if no device calls are made for 5 minutes. To prevent this, run \`revyl device screenshot --out /tmp/keepalive.png\` every 3-4 minutes during extended fix phases. If the session has already expired when you return to verify, re-provision with \`revyl device start --platform ios --json\` and re-install the app.

   **iOS deep link dialogs:** When a deep link is opened, iOS may show a system dialog "Open in [AppName]?" with Cancel and Open buttons. After any deep link navigation, take a screenshot. If this dialog appears, tap the "Open" button before proceeding.

   ## Mobile Authentication

   If the app requires sign-in and no credentials are provided:
   1. Check if sign-up is available — attempt to create a test account using a disposable email pattern: \`qa-test-{timestamp}@example.com\`
      - If sign-up requires email verification -> STOP, ask user for credentials via AskUserQuestion
      - If sign-up works -> proceed with the new account through onboarding
   2. If no sign-up flow -> ask user via AskUserQuestion: "This app requires authentication. Please provide test credentials or sign in on the device viewer."
   3. For apps with Apple Sign-In only -> cannot test authenticated flows on cloud simulator (no Apple ID). Note as scope limitation in the report.`;
}
