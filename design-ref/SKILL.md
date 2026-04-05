---
name: design-ref
preamble-tier: 1
version: 1.0.0
description: |
  Load brand design systems from 55+ companies (Stripe, Airbnb, Apple, Linear,
  Figma, Notion, etc.) as DESIGN.md references. Fetch, cache, preview, and
  apply professional design tokens — colors, typography, spacing, components —
  to your project. Works with /design-consultation, /design-html, /design-shotgun.
  Use when: "use stripe's design", "design like airbnb", "brand reference",
  "design system", "design tokens", "load design", "design-ref".
  Proactively suggest when /design-consultation starts and no DESIGN.md exists,
  or when /design-shotgun could benefit from brand-accurate tokens. (gstack)
allowed-tools:
  - Bash
  - Read
  - Write
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
echo '{"skill":"design-ref","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","repo":"'$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")'"}'  >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
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
~/.claude/skills/gstack/bin/gstack-timeline-log '{"skill":"design-ref","event":"started","branch":"'"$_BRANCH"'","session":"'"$_SESSION_ID"'"}' 2>/dev/null &
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

# /design-ref: Brand Design System Reference Library

Load professional design systems from 55+ companies and apply them to your project.
Every DESIGN.md is sourced from [awesome-design-md](https://github.com/VoltAgent/awesome-design-md),
a curated collection of brand design specifications.

---

## Step 0: Check for Cached Design Systems

```bash
ls ~/.gstack/design-refs/*.md 2>/dev/null | head -20 || echo "NO_CACHED_REFS"
```

If cached files exist, list them: "You have these brand references cached: [list]. Want to use one of these, or fetch a new one?"

If no cached files, continue to Step 1.

---

## Step 1: Choose a Brand

If the user invoked `/design-ref <brand>` with a brand name, skip this step and use that brand directly.

If no brand was specified, present the catalog organized by category:

**AskUserQuestion:**

> Which brand's design system do you want to reference?
>
> **AI & ML:** claude, cohere, elevenlabs, mistral-ai, ollama, opencode-ai, replicate, together-ai, xai
>
> **Developer Tools:** cursor, expo, hashicorp, linear, lovable, mintlify, posthog, raycast, resend, sentry, supabase, vercel, voltagent, warp
>
> **Design & Productivity:** airtable, cal-com, figma, framer, miro, notion, sanity, webflow, zapier
>
> **Fintech:** coinbase, kraken, revolut, stripe, wise
>
> **Enterprise & Consumer:** airbnb, apple, bmw, clickhouse, clay, composio, ibm, intercom, mongodb, nvidia, pinterest, runwayml, spacex, spotify, superhuman, uber
>
> Type a brand name, or pick from any category above.

Accept any of the 55 known brands. If the user types something not in the list, say which brands are available and ask again.

---

## Step 2: Fetch the DESIGN.md

Using the brand selected in Step 1:

```bash
BRAND="<selected-brand>"
mkdir -p ~/.gstack/design-refs
CACHE="$HOME/.gstack/design-refs/$BRAND-DESIGN.md"
if [ ! -f "$CACHE" ]; then
  curl -sL "https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/design-md/$BRAND/DESIGN.md" -o "$CACHE"
fi
wc -l "$CACHE"
head -50 "$CACHE"
```

Replace `<selected-brand>` with the actual brand name from Step 1 (lowercase, hyphenated — e.g., `mistral-ai`, `cal-com`).

If curl returns an empty file or a 404 page, tell the user: "Could not fetch the design system for [brand]. The brand may not be in the repository. Pick another?"

If the file was already cached, say: "Using cached version. Delete `~/.gstack/design-refs/<brand>-DESIGN.md` to re-fetch."

---

## Step 3: Read and Summarize the Design System

Read the full cached DESIGN.md file for the selected brand:

```bash
cat "$HOME/.gstack/design-refs/<selected-brand>-DESIGN.md"
```

After reading the full file, present a concise summary covering:

- **Color palette** — primary, accent, semantic colors (with hex values)
- **Typography** — font families, key sizes, scale
- **Component style** — border radius, shadows, spacing base unit
- **Overall vibe** — warm/cold, minimal/rich, playful/serious, etc.

Keep the summary to 15-25 lines. The user should get the essence without scrolling through the full spec.

---

## Step 4: Apply or Reference

**AskUserQuestion:**

> How would you like to use this design system?
>
> **A) Copy to this project as DESIGN.md** — standard location that /design-consultation, /design-html, /design-shotgun, and /design-review all read automatically.
>
> **B) Use as reference only** — keep it in cache, I'll tell you when to apply specific elements.
>
> **C) Mix with another brand** — pick a second design system to blend elements from both.

### If A: Copy to project

```bash
cp "$HOME/.gstack/design-refs/<selected-brand>-DESIGN.md" DESIGN.md
```

Then proceed to Step 5 (integration message).

### If B: Reference only

Tell the user: "The design system is cached at `~/.gstack/design-refs/<brand>-DESIGN.md`. Reference it anytime. When you're ready to apply it, run `/design-ref` again or just ask me to copy it."

Done — no further steps needed.

### If C: Mix with another brand

Ask which second brand to fetch. Fetch and cache the second brand using the same curl pattern from Step 2, then read both files.

Present a side-by-side comparison:

```
[Brand A] vs [Brand B]:

COLORS:
  A: primary [hex], accent [hex] — [vibe]
  B: primary [hex], accent [hex] — [vibe]

TYPOGRAPHY:
  A: [font families] — [character]
  B: [font families] — [character]

SPACING & COMPONENTS:
  A: [base unit], [border radius], [density]
  B: [base unit], [border radius], [density]

OVERALL FEEL:
  A: [2-3 word description]
  B: [2-3 word description]
```

Then AskUserQuestion:

> "Which elements from each? For example: 'colors from Stripe, typography from Linear, spacing from Notion.' Or describe the blend you want."

After the user picks, write a merged DESIGN.md to the project root combining the selected elements. Attribute each choice: "Colors: from Stripe. Typography: from Linear." in a comment at the top.

Then proceed to Step 5.

---

## Step 5: Integration with Other Skills

After copying DESIGN.md to the project, tell the user:

"Your project now has a DESIGN.md based on **[brand name]**'s design system. Other gstack skills will automatically use it:

- `/design-consultation` reads it as your design system baseline
- `/design-html` uses it for color, typography, and spacing tokens
- `/design-shotgun` uses it to generate on-brand variants
- `/design-review` audits your UI against it

To update later, run `/design-ref` again with a different brand."

---

## Available Brands (full list)

For reference, these 55 brands are available:

airbnb, airtable, apple, bmw, cal-com, clay, clickhouse, claude, cohere,
coinbase, composio, cursor, elevenlabs, expo, figma, framer, hashicorp, ibm,
intercom, kraken, linear, lovable, mintlify, miro, mistral-ai, mongodb,
notion, nvidia, ollama, opencode-ai, pinterest, posthog, raycast, replicate,
resend, revolut, runwayml, sanity, sentry, spacex, spotify, stripe, superhuman,
supabase, together-ai, uber, vercel, voltagent, warp, webflow, wise, xai, zapier

---

## Important Rules

1. **Every bash block is self-contained.** No variable persistence between blocks. Substitute the brand name directly into each block.
2. **Cache by default.** Never re-fetch a brand that's already cached unless the user explicitly asks.
3. **Respect existing DESIGN.md.** If the project already has a DESIGN.md, warn before overwriting: "This will replace your existing DESIGN.md. Continue? (The current file will be backed up to DESIGN.md.bak.)"
4. **Back up before overwriting.** If a DESIGN.md exists, copy it to DESIGN.md.bak first.
5. **Brand names are exact.** Use the hyphenated lowercase form (e.g., `mistral-ai`, `cal-com`, `opencode-ai`). Do not guess or transform the name.
6. **Attribution.** When copying a brand's DESIGN.md, keep any attribution or license notices from the original file intact.
