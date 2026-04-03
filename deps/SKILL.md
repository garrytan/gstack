---
name: deps
preamble-tier: 1
version: 1.0.0
description: |
  Dependency audit: outdated packages, known CVEs, unused deps, and license
  issues. Framework-agnostic — wraps npm audit, composer audit, bundle audit,
  pip-audit, go vuln, cargo audit, etc. Unified report with severity, fix
  commands, and upgrade paths.
  Use when asked to "audit dependencies", "check deps", "find vulnerabilities",
  "outdated packages", "dependency audit", or "security scan".
  Proactively suggest before /ship, after major upgrades, or when lockfiles
  haven't been updated in 30+ days. (gstack)
allowed-tools:
  - Bash
  - Read
  - Glob
  - Grep
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
find ~/.gstack/sessions -mmin +120 -type f -exec rm {} + 2>/dev/null || true
_PROACTIVE=$(~/.claude/skills/gstack/bin/gstack-config get proactive 2>/dev/null || echo "true")
_PROACTIVE_PROMPTED=$([ -f ~/.gstack/.proactive-prompted ] && echo "yes" || echo "no")
_BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
echo "BRANCH: $_BRANCH"
_SKILL_PREFIX=$(~/.claude/skills/gstack/bin/gstack-config get skill_prefix 2>/dev/null || echo "false")
echo "PROACTIVE: $_PROACTIVE"
echo "PROACTIVE_PROMPTED: $_PROACTIVE_PROMPTED"
echo "SKILL_PREFIX: $_SKILL_PREFIX"
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
if [ "$_TEL" != "off" ]; then
echo '{"skill":"deps","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","repo":"'$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")'"}'  >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
fi
# zsh-compatible: use find instead of glob to avoid NOMATCH error
for _PF in $(find ~/.gstack/analytics -maxdepth 1 -name '.pending-*' 2>/dev/null); do
  if [ -f "$_PF" ]; then
    if [ "$_TEL" != "off" ] && [ -x "~/.claude/skills/gstack/bin/gstack-telemetry-log" ]; then
      ~/.claude/skills/gstack/bin/gstack-telemetry-log --event-type skill_run --skill _pending_finalize --outcome unknown --session-id "$_SESSION_ID" 2>/dev/null || true
    fi
    rm -f "$_PF" 2>/dev/null || true
  fi
  break
done
# Learnings count
eval "$(~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null)" 2>/dev/null || true
_LEARN_FILE="${GSTACK_HOME:-$HOME/.gstack}/projects/${SLUG:-unknown}/learnings.jsonl"
if [ -f "$_LEARN_FILE" ]; then
  _LEARN_COUNT=$(wc -l < "$_LEARN_FILE" 2>/dev/null | tr -d ' ')
  echo "LEARNINGS: $_LEARN_COUNT entries loaded"
  if [ "$_LEARN_COUNT" -gt 5 ] 2>/dev/null; then
    ~/.claude/skills/gstack/bin/gstack-learnings-search --limit 3 2>/dev/null || true
  fi
else
  echo "LEARNINGS: 0"
fi
# Session timeline: record skill start (local-only, never sent anywhere)
~/.claude/skills/gstack/bin/gstack-timeline-log '{"skill":"deps","event":"started","branch":"'"$_BRANCH"'","session":"'"$_SESSION_ID"'"}' 2>/dev/null &
# Check if CLAUDE.md has routing rules
_HAS_ROUTING="no"
if [ -f CLAUDE.md ] && grep -q "## Skill routing" CLAUDE.md 2>/dev/null; then
  _HAS_ROUTING="yes"
fi
_ROUTING_DECLINED=$(~/.claude/skills/gstack/bin/gstack-config get routing_declined 2>/dev/null || echo "false")
echo "HAS_ROUTING: $_HAS_ROUTING"
echo "ROUTING_DECLINED: $_ROUTING_DECLINED"
```

If `PROACTIVE` is `"false"`, do not proactively suggest gstack skills AND do not
auto-invoke skills based on conversation context. Only run skills the user explicitly
types (e.g., /qa, /ship). If you would have auto-invoked a skill, instead briefly say:
"I think /skillname might help here — want me to run it?" and wait for confirmation.
The user opted out of proactive behavior.

If `SKILL_PREFIX` is `"true"`, the user has namespaced skill names. When suggesting
or invoking other gstack skills, use the `/gstack-` prefix (e.g., `/gstack-qa` instead
of `/qa`, `/gstack-ship` instead of `/ship`). Disk paths are unaffected — always use
`~/.claude/skills/gstack/[skill-name]/SKILL.md` for reading skill files.

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

If `PROACTIVE_PROMPTED` is `no` AND `TEL_PROMPTED` is `yes`: After telemetry is handled,
ask the user about proactive behavior. Use AskUserQuestion:

> gstack can proactively figure out when you might need a skill while you work —
> like suggesting /qa when you say "does this work?" or /investigate when you hit
> a bug. We recommend keeping this on — it speeds up every part of your workflow.

Options:
- A) Keep it on (recommended)
- B) Turn it off — I'll type /commands myself

If A: run `~/.claude/skills/gstack/bin/gstack-config set proactive true`
If B: run `~/.claude/skills/gstack/bin/gstack-config set proactive false`

Always run:
```bash
touch ~/.gstack/.proactive-prompted
```

This only happens once. If `PROACTIVE_PROMPTED` is `yes`, skip this entirely.

If `HAS_ROUTING` is `no` AND `ROUTING_DECLINED` is `false` AND `PROACTIVE_PROMPTED` is `yes`:
Check if a CLAUDE.md file exists in the project root. If it does not exist, create it.

Use AskUserQuestion:

> gstack works best when your project's CLAUDE.md includes skill routing rules.
> This tells Claude to use specialized workflows (like /ship, /investigate, /qa)
> instead of answering directly. It's a one-time addition, about 15 lines.

Options:
- A) Add routing rules to CLAUDE.md (recommended)
- B) No thanks, I'll invoke skills manually

If A: Append this section to the end of CLAUDE.md:

```markdown

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke checkpoint
- Code quality, health check → invoke health
```

Then commit the change: `git add CLAUDE.md && git commit -m "chore: add gstack skill routing rules to CLAUDE.md"`

If B: run `~/.claude/skills/gstack/bin/gstack-config set routing_declined true`
Say "No problem. You can add routing rules later by running `gstack-config set routing_declined false` and re-running any skill."

This only happens once per project. If `HAS_ROUTING` is `yes` or `ROUTING_DECLINED` is `true`, skip this entirely.

## Voice

**Tone:** direct, concrete, sharp, never corporate, never academic. Sound like a builder, not a consultant. Name the file, the function, the command. No filler, no throat-clearing.

**Writing rules:** No em dashes (use commas, periods, "..."). No AI vocabulary (delve, crucial, robust, comprehensive, nuanced, etc.). Short paragraphs. End with what to do.

The user always has context you don't. Cross-model agreement is a recommendation, not a decision — the user decides.

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

## Operational Self-Improvement

Before completing, reflect on this session:
- Did any commands fail unexpectedly?
- Did you take a wrong approach and have to backtrack?
- Did you discover a project-specific quirk (build order, env vars, timing, auth)?
- Did something take longer than expected because of a missing flag or config?

If yes, log an operational learning for future sessions:

```bash
~/.claude/skills/gstack/bin/gstack-learnings-log '{"skill":"SKILL_NAME","type":"operational","key":"SHORT_KEY","insight":"DESCRIPTION","confidence":N,"source":"observed"}'
```

Replace SKILL_NAME with the current skill name. Only log genuine operational discoveries.
Don't log obvious things or one-time transient errors (network blips, rate limits).
A good test: would knowing this save 5+ minutes in a future session? If yes, log it.

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
# Session timeline: record skill completion (local-only, never sent anywhere)
~/.claude/skills/gstack/bin/gstack-timeline-log '{"skill":"SKILL_NAME","event":"completed","branch":"'$(git branch --show-current 2>/dev/null || echo unknown)'","outcome":"OUTCOME","duration_s":"'"$_TEL_DUR"'","session":"'"$_SESSION_ID"'"}' 2>/dev/null || true
# Local analytics (gated on telemetry setting)
if [ "$_TEL" != "off" ]; then
echo '{"skill":"SKILL_NAME","duration_s":"'"$_TEL_DUR"'","outcome":"OUTCOME","browse":"USED_BROWSE","session":"'"$_SESSION_ID"'","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
fi
# Remote telemetry (opt-in, requires binary)
if [ "$_TEL" != "off" ] && [ -x ~/.claude/skills/gstack/bin/gstack-telemetry-log ]; then
  ~/.claude/skills/gstack/bin/gstack-telemetry-log \
    --skill "SKILL_NAME" --duration "$_TEL_DUR" --outcome "OUTCOME" \
    --used-browse "USED_BROWSE" --session-id "$_SESSION_ID" 2>/dev/null &
fi
```

Replace `SKILL_NAME` with the actual skill name from frontmatter, `OUTCOME` with
success/error/abort, and `USED_BROWSE` with true/false based on whether `$B` was used.
If you cannot determine the outcome, use "unknown". The local JSONL always logs. The
remote binary only runs if telemetry is not off and the binary exists.

## Plan Mode Safe Operations

When in plan mode, these operations are always allowed because they produce
artifacts that inform the plan, not code changes:

- `$B` commands (browse: screenshots, page inspection, navigation, snapshots)
- `$D` commands (design: generate mockups, variants, comparison boards, iterate)
- `codex exec` / `codex review` (outside voice, plan review, adversarial challenge)
- Writing to `~/.gstack/` (config, analytics, review logs, design artifacts, learnings)
- Writing to the plan file (already allowed by plan mode)
- `open` commands for viewing generated artifacts (comparison boards, HTML previews)

These are read-only in spirit — they inspect the live site, generate visual artifacts,
or get independent opinions. They do NOT modify project source files.

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

# /deps: Dependency Audit

Four checks: **Vulnerabilities → Outdated → Unused → Licenses**. Unified
report across any package manager.

---

## Step 0: Detect package manager

```bash
[ -f package.json ] && echo "PM:npm"
[ -f package-lock.json ] && echo "LOCK:npm"
[ -f yarn.lock ] && echo "LOCK:yarn"
[ -f pnpm-lock.yaml ] && echo "LOCK:pnpm"
[ -f bun.lock ] || [ -f bun.lockb ] && echo "LOCK:bun"
[ -f composer.json ] && echo "PM:composer"
[ -f composer.lock ] && echo "LOCK:composer"
[ -f Gemfile ] && echo "PM:bundler"
[ -f Gemfile.lock ] && echo "LOCK:bundler"
[ -f requirements.txt ] && echo "PM:pip"
[ -f pyproject.toml ] && echo "PM:pip"
[ -f poetry.lock ] && echo "LOCK:poetry"
[ -f Pipfile.lock ] && echo "LOCK:pipenv"
[ -f go.mod ] && echo "PM:go"
[ -f go.sum ] && echo "LOCK:go"
[ -f Cargo.toml ] && echo "PM:cargo"
[ -f Cargo.lock ] && echo "LOCK:cargo"
[ -f mix.exs ] && echo "PM:mix"
[ -f mix.lock ] && echo "LOCK:mix"
[ -f pubspec.yaml ] && echo "PM:pub"
```

If no package manager detected, ask the user.

Also check lockfile age:

```bash
for lockfile in package-lock.json yarn.lock pnpm-lock.yaml bun.lock composer.lock Gemfile.lock go.sum Cargo.lock poetry.lock; do
  if [ -f "$lockfile" ]; then
    LOCK_DATE=$(git log -1 --format="%ci" -- "$lockfile" 2>/dev/null | cut -d' ' -f1)
    echo "LOCK_AGE:$lockfile:$LOCK_DATE"
  fi
done
```

---

## Step 1: Vulnerability Scan

Run the native audit tool for the detected package manager. These are
deterministic — no LLM needed.

**Node.js (npm/yarn/pnpm/bun):**
```bash
npm audit --json 2>/dev/null | head -500
```
If npm audit isn't available or errors, try:
```bash
npx audit-ci --json 2>/dev/null || yarn audit --json 2>/dev/null | head -500
```

**PHP (Composer):**
```bash
composer audit --format=json 2>/dev/null || composer audit 2>/dev/null
```

**Ruby (Bundler):**
```bash
bundle audit check --update 2>/dev/null || bundle audit 2>/dev/null
```
If `bundle-audit` is not installed, note it and suggest `gem install bundler-audit`.

**Python (pip):**
```bash
pip-audit --format=json 2>/dev/null || pip-audit 2>/dev/null || safety check --json 2>/dev/null
```
If neither is installed, note it and suggest `pip install pip-audit`.

**Go:**
```bash
govulncheck ./... 2>/dev/null
```
If not installed, suggest `go install golang.org/x/vuln/cmd/govulncheck@latest`.

**Rust (Cargo):**
```bash
cargo audit --json 2>/dev/null || cargo audit 2>/dev/null
```
If not installed, suggest `cargo install cargo-audit`.

**Elixir (Mix):**
```bash
mix deps.audit 2>/dev/null || mix hex.audit 2>/dev/null
```

Parse the output into a structured list:

```
VULNERABILITY REPORT
═══════════════════════════════════════════════════════

CRITICAL (fix immediately):
  lodash 4.17.20        CVE-2021-23337   Prototype Pollution
    Fix: npm install lodash@4.17.21

HIGH:
  axios 0.21.1          CVE-2021-3749    ReDoS
    Fix: npm install axios@0.21.4

MODERATE:
  (none)

LOW:
  (none)

Total: 1 critical, 1 high, 0 moderate, 0 low
```

---

## Step 2: Outdated Packages

Check for outdated dependencies.

**Node.js:**
```bash
npm outdated --json 2>/dev/null | head -200
```

**PHP:**
```bash
composer outdated --format=json 2>/dev/null || composer outdated --direct 2>/dev/null
```

**Ruby:**
```bash
bundle outdated --strict 2>/dev/null | head -100
```

**Python:**
```bash
pip list --outdated --format=json 2>/dev/null | head -200
```

**Go:**
```bash
go list -m -u all 2>/dev/null | grep '\[' | head -50
```

**Rust:**
```bash
cargo outdated 2>/dev/null | head -100
```

Categorize by severity of version gap:

```
OUTDATED PACKAGES
═══════════════════════════════════════════════════════

MAJOR version behind (breaking changes likely):
  react 17.0.2 → 19.1.0           (+2 major)
  laravel/framework 10.x → 12.x   (+2 major)

MINOR version behind (new features):
  tailwindcss 3.4.1 → 3.4.17      (+16 patches)

PATCH only (safe to update):
  axios 1.6.0 → 1.6.8

Total: 2 major, 1 minor, 1 patch behind
```

---

## Step 3: Unused Dependencies

Detect dependencies that are installed but never imported/required in code.

**Node.js:**
```bash
# Check if depcheck is available, otherwise use grep-based detection
npx depcheck --json 2>/dev/null | head -200
```

If `depcheck` isn't available, do a manual check:
1. Read `dependencies` from `package.json`
2. For each dependency, grep the codebase for `require('dep')`, `from 'dep'`,
   or `import 'dep'`
3. Flag any with zero references

**PHP:**
```bash
# Check composer-unused if available
composer unused 2>/dev/null || true
```

If not available, manually check:
1. Read `require` from `composer.json`
2. Grep for `use Vendor\\Package` in PHP files
3. Flag unreferenced packages

**For other languages:** Use grep-based detection. Read the dependency list
from the manifest file, then search for imports/requires in source code.

```
UNUSED DEPENDENCIES
═══════════════════════════════════════════════════════

Possibly unused (no imports found in code):
  moment                 Consider: date-fns or dayjs instead
  lodash.merge           Consider: native structuredClone()
  @types/express         (devDep — check if express is used)

Total: 3 possibly unused

Note: Some deps are used implicitly (plugins, CLI tools, type packages).
Verify before removing.
```

---

## Step 4: License Check

Scan for problematic licenses in dependencies.

**Node.js:**
```bash
npx license-checker --json --production 2>/dev/null | head -500
```

**PHP:**
```bash
composer licenses --format=json 2>/dev/null | head -200
```

**For other languages:** Read license fields from lockfile or manifest.

Flag these license categories:

| Category | Licenses | Risk |
|----------|----------|------|
| **Copyleft** | GPL-2.0, GPL-3.0, AGPL-3.0 | May require open-sourcing your code |
| **Weak copyleft** | LGPL, MPL-2.0 | File-level copyleft, usually OK |
| **Permissive** | MIT, Apache-2.0, BSD, ISC | Safe for commercial use |
| **Unknown** | UNLICENSED, no license field | Risk — no rights granted |

```
LICENSE REPORT
═══════════════════════════════════════════════════════

FLAGGED (review required):
  some-package 1.0.0    GPL-3.0    Copyleft — may require open-sourcing
  mystery-lib 2.0.0     UNLICENSED No license — no usage rights

SAFE:
  247 packages with permissive licenses (MIT, Apache-2.0, BSD, ISC)

Total: 2 flagged, 247 safe
```

---

## Step 5: Summary Report

Combine all four checks into a dashboard:

```
/deps audit report
═══════════════════════════════════════════════════════

  Vulnerabilities:  1 critical, 1 high, 0 moderate
  Outdated:         2 major, 1 minor, 1 patch
  Unused:           3 possibly unused
  Licenses:         2 flagged, 247 safe
  Lockfile age:     package-lock.json last updated 45 days ago

HEALTH: NEEDS ATTENTION

Recommended actions:
  1. Fix critical CVE in lodash (npm install lodash@4.17.21)
  2. Fix high CVE in axios (npm install axios@0.21.4)
  3. Review 2 major version upgrades (react, laravel)
  4. Remove unused: moment, lodash.merge
  5. Review GPL-3.0 dependency: some-package
```

---

## Step 6: Fix

Ask the user what to do:

> Found 2 vulnerabilities, 4 outdated, 3 unused, and 2 license flags.
>
> A) Auto-fix: patch vulnerabilities + update safe packages
> B) Show me the fix commands and I'll run them myself
> C) Just the report — I'll handle it later

If the user chooses A, run the safe fixes:
- `npm audit fix` (or equivalent) for vulnerabilities
- Update patch-level outdated packages
- Do NOT auto-update major versions or remove unused deps (too risky)

After fixing, re-run the vulnerability scan to confirm the fixes landed.

---

## Design Principles

1. **Deterministic first.** Run the native audit tools — they have the real
   CVE databases. Don't try to LLM-judge vulnerability severity.

2. **Framework-agnostic.** Detect the package manager, run its tools.
   Don't hardcode npm patterns.

3. **Conservative fixes.** Only auto-fix patches and known-safe updates.
   Major version bumps and dep removals require user confirmation.

4. **Unified output.** Same report format regardless of language. A Go
   developer and a PHP developer see the same dashboard structure.

5. **Suggest but don't assume.** If an audit tool isn't installed, suggest
   how to install it. Don't skip the check silently.
