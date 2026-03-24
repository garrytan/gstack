---
name: setup-deploy
preamble-tier: 2
version: 1.0.0
description: |
  MANUAL TRIGGER ONLY: invoke only when user types /setup-deploy.
  Configure deployment settings for /land-and-deploy. Detects your deploy
  platform (Fly.io, Render, Vercel, Netlify, Heroku, GitHub Actions, custom),
  production URL, health check endpoints, and deploy status commands. Writes
  the configuration to CLAUDE.md so all future deploys are automatic.
  Use when: "setup deploy", "configure deployment", "set up land-and-deploy",
  "how do I deploy with gstack", "add deploy config".
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
echo '{"skill":"setup-deploy","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","repo":"'$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")'"}'  >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
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

Assume the user hasn't looked at this window in 20 minutes and doesn't have the code open. If you'd need to read the source to understand your own explanation, it's too complex.

Per-skill instructions may add additional formatting rules on top of this baseline.

## Completeness Principle — Boil the Lake

AI makes completeness near-free. Always recommend the complete option over shortcuts — the delta is minutes with CC+gstack. A "lake" (100% coverage, all edge cases) is boilable; an "ocean" (full rewrite, multi-quarter migration) is not. Boil lakes, flag oceans.

**Effort reference** — always show both scales:

| Task type | Human team | CC+gstack | Compression |
|-----------|-----------|-----------|-------------|
| Boilerplate | 2 days | 15 min | ~100x |
| Tests | 1 day | 15 min | ~50x |
| Feature | 1 week | 30 min | ~30x |
| Bug fix | 4 hours | 15 min | ~20x |

Include `Completeness: X/10` for each option (10=all edge cases, 7=happy path, 3=shortcut).

## Contributor Mode

If `_CONTRIB` is `true`: you are in **contributor mode**. At the end of each major workflow step, rate your gstack experience 0-10. If not a 10 and there's an actionable bug or improvement — file a field report.

**File only:** gstack tooling bugs where the input was reasonable but gstack failed. **Skip:** user app bugs, network errors, auth failures on user's site.

**To file:** write `~/.gstack/contributor-logs/{slug}.md`:
```
# {Title}
**What I tried:** {action} | **What happened:** {result} | **Rating:** {0-10}
## Repro
1. {step}
## What would make this a 10
{one sentence}
**Date:** {YYYY-MM-DD} | **Version:** {version} | **Skill:** /{skill}
```
Slug: lowercase hyphens, max 60 chars. Skip if exists. Max 3/session. File inline, don't stop.

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

# /setup-deploy — Configure Deployment for gstack

You are helping the user configure their deployment so `/land-and-deploy` works
automatically. Your job is to detect the deploy platform, production URL, health
checks, and deploy status commands — then persist everything to CLAUDE.md.

After this runs once, `/land-and-deploy` reads CLAUDE.md and skips detection entirely.

## User-invocable
When the user types `/setup-deploy`, run this skill.

## Instructions

### Step 1: Check existing configuration

```bash
grep -A 20 "## Deploy Configuration" CLAUDE.md 2>/dev/null || echo "NO_CONFIG"
```

If configuration already exists, show it and ask:

- **Context:** Deploy configuration already exists in CLAUDE.md.
- **RECOMMENDATION:** Choose A to update if your setup changed.
- A) Reconfigure from scratch (overwrite existing)
- B) Edit specific fields (show current config, let me change one thing)
- C) Done — configuration looks correct

If the user picks C, stop.

### Step 2: Detect platform

Run the platform detection from the deploy bootstrap:

```bash
# Platform config files
[ -f fly.toml ] && echo "PLATFORM:fly" && cat fly.toml
[ -f render.yaml ] && echo "PLATFORM:render" && cat render.yaml
[ -f vercel.json ] || [ -d .vercel ] && echo "PLATFORM:vercel"
[ -f netlify.toml ] && echo "PLATFORM:netlify" && cat netlify.toml
[ -f Procfile ] && echo "PLATFORM:heroku"
[ -f railway.json ] || [ -f railway.toml ] && echo "PLATFORM:railway"

# GitHub Actions deploy workflows
for f in .github/workflows/*.yml .github/workflows/*.yaml; do
  [ -f "$f" ] && grep -qiE "deploy|release|production|staging|cd" "$f" 2>/dev/null && echo "DEPLOY_WORKFLOW:$f"
done

# Project type
[ -f package.json ] && grep -q '"bin"' package.json 2>/dev/null && echo "PROJECT_TYPE:cli"
ls *.gemspec 2>/dev/null && echo "PROJECT_TYPE:library"
```

### Step 3: Platform-specific setup

Based on what was detected, guide the user through platform-specific configuration.

#### Fly.io

If `fly.toml` detected:

1. Extract app name: `grep -m1 "^app" fly.toml | sed 's/app = "\(.*\)"/\1/'`
2. Check if `fly` CLI is installed: `which fly 2>/dev/null`
3. If installed, verify: `fly status --app {app} 2>/dev/null`
4. Infer URL: `https://{app}.fly.dev`
5. Set deploy status command: `fly status --app {app}`
6. Set health check: `https://{app}.fly.dev` (or `/health` if the app has one)

Ask the user to confirm the production URL. Some Fly apps use custom domains.

#### Render

If `render.yaml` detected:

1. Extract service name and type from render.yaml
2. Check for Render API key: `echo $RENDER_API_KEY | head -c 4` (don't expose the full key)
3. Infer URL: `https://{service-name}.onrender.com`
4. Render deploys automatically on push to the connected branch — no deploy workflow needed
5. Set health check: the inferred URL

Ask the user to confirm. Render uses auto-deploy from the connected git branch — after
merge to main, Render picks it up automatically. The "deploy wait" in /land-and-deploy
should poll the Render URL until it responds with the new version.

#### Vercel

If vercel.json or .vercel detected:

1. Check for `vercel` CLI: `which vercel 2>/dev/null`
2. If installed: `vercel ls --prod 2>/dev/null | head -3`
3. Vercel deploys automatically on push — preview on PR, production on merge to main
4. Set health check: the production URL from vercel project settings

#### Netlify

If netlify.toml detected:

1. Extract site info from netlify.toml
2. Netlify deploys automatically on push
3. Set health check: the production URL

#### GitHub Actions only

If deploy workflows detected but no platform config:

1. Read the workflow file to understand what it does
2. Extract the deploy target (if mentioned)
3. Ask the user for the production URL

#### Custom / Manual

If nothing detected:

Use AskUserQuestion to gather the information:

1. **How are deploys triggered?**
   - A) Automatically on push to main (Fly, Render, Vercel, Netlify, etc.)
   - B) Via GitHub Actions workflow
   - C) Via a deploy script or CLI command (describe it)
   - D) Manually (SSH, dashboard, etc.)
   - E) This project doesn't deploy (library, CLI, tool)

2. **What's the production URL?** (Free text — the URL where the app runs)

3. **How can gstack check if a deploy succeeded?**
   - A) HTTP health check at a specific URL (e.g., /health, /api/status)
   - B) CLI command (e.g., `fly status`, `kubectl rollout status`)
   - C) Check the GitHub Actions workflow status
   - D) No automated way — just check the URL loads

4. **Any pre-merge or post-merge hooks?**
   - Commands to run before merging (e.g., `bun run build`)
   - Commands to run after merge but before deploy verification

### Step 4: Write configuration

Read CLAUDE.md (or create it). Find and replace the `## Deploy Configuration` section
if it exists, or append it at the end.

```markdown
## Deploy Configuration (configured by /setup-deploy)
- Platform: {platform}
- Production URL: {url}
- Deploy workflow: {workflow file or "auto-deploy on push"}
- Deploy status command: {command or "HTTP health check"}
- Merge method: {squash/merge/rebase}
- Project type: {web app / API / CLI / library}
- Post-deploy health check: {health check URL or command}

### Custom deploy hooks
- Pre-merge: {command or "none"}
- Deploy trigger: {command or "automatic on push to main"}
- Deploy status: {command or "poll production URL"}
- Health check: {URL or command}
```

### Step 5: Verify

After writing, verify the configuration works:

1. If a health check URL was configured, try it:
```bash
curl -sf "{health-check-url}" -o /dev/null -w "%{http_code}" 2>/dev/null || echo "UNREACHABLE"
```

2. If a deploy status command was configured, try it:
```bash
{deploy-status-command} 2>/dev/null | head -5 || echo "COMMAND_FAILED"
```

Report results. If anything failed, note it but don't block — the config is still
useful even if the health check is temporarily unreachable.

### Step 6: Summary

```
DEPLOY CONFIGURATION — COMPLETE
════════════════════════════════
Platform:      {platform}
URL:           {url}
Health check:  {health check}
Status cmd:    {status command}
Merge method:  {merge method}

Saved to CLAUDE.md. /land-and-deploy will use these settings automatically.

Next steps:
- Run /land-and-deploy to merge and deploy your current PR
- Edit the "## Deploy Configuration" section in CLAUDE.md to change settings
- Run /setup-deploy again to reconfigure
```

## Important Rules

- **Never expose secrets.** Don't print full API keys, tokens, or passwords.
- **Confirm with the user.** Always show the detected config and ask for confirmation before writing.
- **CLAUDE.md is the source of truth.** All configuration lives there — not in a separate config file.
- **Idempotent.** Running /setup-deploy multiple times overwrites the previous config cleanly.
- **Platform CLIs are optional.** If `fly` or `vercel` CLI isn't installed, fall back to URL-based health checks.
