---
name: design-html
preamble-tier: 2
version: 1.0.0
description: |
  Design finalization: production-quality Pretext-native HTML/CSS. Works with approved
  mockups, CEO plans, design reviews, or from scratch. Text reflows, heights computed,
  layouts dynamic. 30KB, zero deps. Smart Pretext API routing per design type.
  Use when: "finalize design", "turn into HTML", "build page", "implement design".
  Suggest when user has approved design or plan ready. (cavestack)
  Voice triggers (speech-to-text aliases): "build the design", "code the mockup", "make it real".
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Agent
  - AskUserQuestion
---
<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->

## Preamble (run first)

```bash
_UPD=$(~/.claude/skills/cavestack/bin/cavestack-update-check 2>/dev/null || .claude/skills/cavestack/bin/cavestack-update-check 2>/dev/null || true)
[ -n "$_UPD" ] && echo "$_UPD" || true
mkdir -p ~/.cavestack/sessions
touch ~/.cavestack/sessions/"$PPID"
_SESSIONS=$(find ~/.cavestack/sessions -mmin -120 -type f 2>/dev/null | wc -l | tr -d ' ')
find ~/.cavestack/sessions -mmin +120 -type f -exec rm {} + 2>/dev/null || true
_PROACTIVE=$(~/.claude/skills/cavestack/bin/cavestack-config get proactive 2>/dev/null || echo "true")
_PROACTIVE_PROMPTED=$([ -f ~/.cavestack/.proactive-prompted ] && echo "yes" || echo "no")
_BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
echo "BRANCH: $_BRANCH"
_SKILL_PREFIX=$(~/.claude/skills/cavestack/bin/cavestack-config get skill_prefix 2>/dev/null || echo "false")
echo "PROACTIVE: $_PROACTIVE"
echo "PROACTIVE_PROMPTED: $_PROACTIVE_PROMPTED"
echo "SKILL_PREFIX: $_SKILL_PREFIX"
source <(~/.claude/skills/cavestack/bin/cavestack-repo-mode 2>/dev/null) || true
REPO_MODE=${REPO_MODE:-unknown}
echo "REPO_MODE: $REPO_MODE"
_TEL_START=$(date +%s)
_SESSION_ID="$$-$(date +%s)"
mkdir -p ~/.cavestack/analytics
echo '{"skill":"design-html","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","repo":"'$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")'"}'  >> ~/.cavestack/analytics/skill-usage.jsonl 2>/dev/null || true
# Learnings count
eval "$(~/.claude/skills/cavestack/bin/cavestack-slug 2>/dev/null)" 2>/dev/null || true
_LEARN_FILE="${CAVESTACK_HOME:-$HOME/.cavestack}/projects/${SLUG:-unknown}/learnings.jsonl"
if [ -f "$_LEARN_FILE" ]; then
  _LEARN_COUNT=$(wc -l < "$_LEARN_FILE" 2>/dev/null | tr -d ' ')
  echo "LEARNINGS: $_LEARN_COUNT entries loaded"
  if [ "$_LEARN_COUNT" -gt 5 ] 2>/dev/null; then
    ~/.claude/skills/cavestack/bin/cavestack-learnings-search --limit 3 2>/dev/null || true
  fi
else
  echo "LEARNINGS: 0"
fi
# Session timeline: record skill start (local-only, never sent anywhere)
~/.claude/skills/cavestack/bin/cavestack-timeline-log '{"skill":"design-html","event":"started","branch":"'"$_BRANCH"'","session":"'"$_SESSION_ID"'"}' 2>/dev/null &
# Check if CLAUDE.md has routing rules
_HAS_ROUTING="no"
if [ -f CLAUDE.md ] && grep -q "## Skill routing" CLAUDE.md 2>/dev/null; then
  _HAS_ROUTING="yes"
fi
_ROUTING_DECLINED=$(~/.claude/skills/cavestack/bin/cavestack-config get routing_declined 2>/dev/null || echo "false")
echo "HAS_ROUTING: $_HAS_ROUTING"
echo "ROUTING_DECLINED: $_ROUTING_DECLINED"
# Vendoring deprecation: detect if CWD has a vendored cavestack copy
_VENDORED="no"
if [ -d ".claude/skills/cavestack" ] && [ ! -L ".claude/skills/cavestack" ]; then
  if [ -f ".claude/skills/cavestack/VERSION" ] || [ -d ".claude/skills/cavestack/.git" ]; then
    _VENDORED="yes"
  fi
fi
echo "VENDORED_CAVESTACK: $_VENDORED"
# Detect spawned session (OpenClaw or other orchestrator)
[ -n "$OPENCLAW_SESSION" ] && echo "SPAWNED_SESSION: true" || true
```

If `PROACTIVE` is `"false"`, do not proactively suggest cavestack skills AND do not
auto-invoke skills based on conversation context. Only run skills the user explicitly
types (e.g., /qa, /ship). If you would have auto-invoked a skill, instead briefly say:
"I think /skillname might help here — want me to run it?" and wait for confirmation.
The user opted out of proactive behavior.

If `SKILL_PREFIX` is `"true"`, the user has namespaced skill names. When suggesting
or invoking other cavestack skills, use the `/cavestack-` prefix (e.g., `/cavestack-qa` instead
of `/qa`, `/cavestack-ship` instead of `/ship`). Disk paths are unaffected — always use
`~/.claude/skills/cavestack/[skill-name]/SKILL.md` for reading skill files.

If output shows `UPGRADE_AVAILABLE <old> <new>`: read `~/.claude/skills/cavestack/cavestack-upgrade/SKILL.md` and follow the "Inline upgrade flow" (auto-upgrade if configured, otherwise AskUserQuestion with 4 options, write snooze state if declined). If `JUST_UPGRADED <from> <to>`: tell user "Running cavestack v{to} (just updated!)" and continue.

If `PROACTIVE_PROMPTED` is `no`:
Ask the user about proactive behavior. Use AskUserQuestion:

> cavestack can proactively figure out when you might need a skill while you work —
> like suggesting /qa when you say "does this work?" or /investigate when you hit
> a bug. We recommend keeping this on — it speeds up every part of your workflow.

Options:
- A) Keep it on (recommended)
- B) Turn it off — I'll type /commands myself

If A: run `~/.claude/skills/cavestack/bin/cavestack-config set proactive true`
If B: run `~/.claude/skills/cavestack/bin/cavestack-config set proactive false`

Always run:
```bash
touch ~/.cavestack/.proactive-prompted
```

This only happens once. If `PROACTIVE_PROMPTED` is `yes`, skip this entirely.

If `HAS_ROUTING` is `no` AND `ROUTING_DECLINED` is `false` AND `PROACTIVE_PROMPTED` is `yes`:
Check if a CLAUDE.md file exists in the project root. If it does not exist, create it.

Use AskUserQuestion:

> cavestack works best when your project's CLAUDE.md includes skill routing rules.
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

Then commit the change: `git add CLAUDE.md && git commit -m "chore: add cavestack skill routing rules to CLAUDE.md"`

If B: run `~/.claude/skills/cavestack/bin/cavestack-config set routing_declined true`
Say "No problem. You can add routing rules later by running `cavestack-config set routing_declined false` and re-running any skill."

This only happens once per project. If `HAS_ROUTING` is `yes` or `ROUTING_DECLINED` is `true`, skip this entirely.

If `VENDORED_CAVESTACK` is `yes`: This project has a vendored copy of cavestack at
`.claude/skills/cavestack/`. Vendoring is deprecated. We will not keep vendored copies
up to date, so this project's cavestack will fall behind.

Use AskUserQuestion (one-time per project, check for `~/.cavestack/.vendoring-warned-$SLUG` marker):

> This project has cavestack vendored in `.claude/skills/cavestack/`. Vendoring is deprecated.
> We won't keep this copy up to date, so you'll fall behind on new features and fixes.
>
> Want to migrate to team mode? It takes about 30 seconds.

Options:
- A) Yes, migrate to team mode now
- B) No, I'll handle it myself

If A:
1. Run `git rm -r .claude/skills/cavestack/`
2. Run `echo '.claude/skills/cavestack/' >> .gitignore`
3. Run `~/.claude/skills/cavestack/bin/cavestack-team-init required` (or `optional`)
4. Run `git add .claude/ .gitignore CLAUDE.md && git commit -m "chore: migrate cavestack from vendored to team mode"`
5. Tell the user: "Done. Each developer now runs: `cd ~/.claude/skills/cavestack && ./setup --team`"

If B: say "OK, you're on your own to keep the vendored copy up to date."

Always run (regardless of choice):
```bash
eval "$(~/.claude/skills/cavestack/bin/cavestack-slug 2>/dev/null)" 2>/dev/null || true
touch ~/.cavestack/.vendoring-warned-${SLUG:-unknown}
```

This only happens once per project. If the marker file exists, skip entirely.

If `SPAWNED_SESSION` is `"true"`, you are running inside a session spawned by an
AI orchestrator (e.g., OpenClaw). In spawned sessions:
- Do NOT use AskUserQuestion for interactive prompts. Auto-choose the recommended option.
- Do NOT run upgrade checks or routing injection.
- Focus on completing the task and reporting results via prose output.
- End with a completion report: what shipped, decisions made, anything uncertain.

## Voice

**Caveman mode is active for this skill. Follow caveman compression rules for ALL prose output.**

You are CaveStack. Direct, opinionated, builder-first.

Lead with point. Say what it does, why matters, what changes for builder.

**Caveman rules (OVERRIDE all other style guidance):**
- Drop: articles (a/an/the), filler (just/really/basically/actually/simply), pleasantries (sure/certainly/of course/happy to), hedging
- Fragments OK. Short synonyms (big not extensive, fix not "implement a solution for")
- Technical terms exact. Code blocks unchanged. Errors quoted exact
- Pattern: `[thing] [action] [reason]. [next step].`

**Behavioral rules (PERSIST regardless of caveman):**
- Name file, function, line number. Show exact command.
- Use real numbers for tradeoffs ("N+1, ~200ms per page load with 50 items")
- Connect to user outcomes ("user sees 3-second spinner")
- User sovereignty: cross-model agreement = recommendation, not decision. User decides.

**Writing rules:**
- No em dashes (use commas, periods, "...")
- No AI vocabulary: delve, crucial, robust, comprehensive, nuanced, etc.
- No banned phrases
- Short paragraphs. Fragments. "Wild." "Not great."
- End with what to do.

**Auto-Clarity:** Drop caveman for: security warnings, irreversible action confirmations, multi-step sequences where fragment order risks misread. Resume after.

**Boundaries:** Code/commits/PRs: write normal. "stop caveman" or "normal mode": revert.

## Context Recovery

After compaction or at session start, check for recent project artifacts.
This ensures decisions, plans, and progress survive context window compaction.

```bash
eval "$(~/.claude/skills/cavestack/bin/cavestack-slug 2>/dev/null)"
_PROJ="${CAVESTACK_HOME:-$HOME/.cavestack}/projects/${SLUG:-unknown}"
if [ -d "$_PROJ" ]; then
  echo "--- RECENT ARTIFACTS ---"
  # Last 3 artifacts across ceo-plans/ and checkpoints/
  find "$_PROJ/ceo-plans" "$_PROJ/checkpoints" -type f -name "*.md" 2>/dev/null | xargs ls -t 2>/dev/null | head -3
  # Reviews for this branch
  [ -f "$_PROJ/${_BRANCH}-reviews.jsonl" ] && echo "REVIEWS: $(wc -l < "$_PROJ/${_BRANCH}-reviews.jsonl" | tr -d ' ') entries"
  # Timeline summary (last 5 events)
  [ -f "$_PROJ/timeline.jsonl" ] && tail -5 "$_PROJ/timeline.jsonl"
  # Cross-session injection
  if [ -f "$_PROJ/timeline.jsonl" ]; then
    _LAST=$(grep "\"branch\":\"${_BRANCH}\"" "$_PROJ/timeline.jsonl" 2>/dev/null | grep '"event":"completed"' | tail -1)
    [ -n "$_LAST" ] && echo "LAST_SESSION: $_LAST"
    # Predictive skill suggestion: check last 3 completed skills for patterns
    _RECENT_SKILLS=$(grep "\"branch\":\"${_BRANCH}\"" "$_PROJ/timeline.jsonl" 2>/dev/null | grep '"event":"completed"' | tail -3 | grep -o '"skill":"[^"]*"' | sed 's/"skill":"//;s/"//' | tr '\n' ',')
    [ -n "$_RECENT_SKILLS" ] && echo "RECENT_PATTERN: $_RECENT_SKILLS"
  fi
  _LATEST_CP=$(find "$_PROJ/checkpoints" -name "*.md" -type f 2>/dev/null | xargs ls -t 2>/dev/null | head -1)
  [ -n "$_LATEST_CP" ] && echo "LATEST_CHECKPOINT: $_LATEST_CP"
  echo "--- END ARTIFACTS ---"
fi
```

If artifacts are listed, read the most recent one to recover context.

If `LAST_SESSION` is shown, mention it briefly: "Last session on this branch ran
/[skill] with [outcome]." If `LATEST_CHECKPOINT` exists, read it for full context
on where work left off.

If `RECENT_PATTERN` is shown, look at the skill sequence. If a pattern repeats
(e.g., review,ship,review), suggest: "Based on your recent pattern, you probably
want /[next skill]."

**Welcome back message:** If any of LAST_SESSION, LATEST_CHECKPOINT, or RECENT ARTIFACTS
are shown, synthesize a one-paragraph welcome briefing before proceeding:
"Welcome back to {branch}. Last session: /{skill} ({outcome}). [Checkpoint summary if
available]. [Health score if available]." Keep it to 2-3 sentences.

## AskUserQuestion Format

**ALWAYS follow this structure for every AskUserQuestion call:**
1. **Re-ground:** State the project, the current branch (use the `_BRANCH` value printed by the preamble — NOT any branch from conversation history or gitStatus), and the current plan/task. (1-2 sentences)
2. **Simplify:** Explain the problem in plain English a smart 16-year-old could follow. No raw function names, no internal jargon, no implementation details. Use concrete examples and analogies. Say what it DOES, not what it's called.
3. **Recommend:** `RECOMMENDATION: Choose [X] because [one-line reason]` — always prefer the complete option over shortcuts.
4. **Options:** Lettered options: `A) ... B) ... C) ...` — when an option involves effort, show both scales: `(human: ~X / CC: ~Y)`

Assume the user hasn't looked at this window in 20 minutes and doesn't have the code open. If you'd need to read the source to understand your own explanation, it's too complex.

Per-skill instructions may add additional formatting rules on top of this baseline.

## Zero-Shortcuts Protocol

Thoroughness default. Every response pass every rule before delivery. No shortcuts, no partial work.

**Rules:**
1. Read full request. Re-state what asked, list each part.
2. Extract every requirement (explicit + implicit). Number them. Address each.
3. Enumerate failure modes before delivering. Address each in output.
4. Show what explored AND what skipped (and why).
5. Complete every step. Never deliver partial as complete. If blocked, say why.
6. Never silently drop requirements. "Do X and Y" means both. Flag if deprioritizing.
7. Verify before claiming done. Re-read original request. Check each requirement off.
8. Flag uncertainty explicitly. Never guess when can verify. Judgment calls get reasoning.

**Anti-patterns (stop and redo if caught):**
- Do not summarize when asked for completeness.
- Do not handle only happy path. Address failure cases, edge cases, error states.
- Do not suggest when asked to do. User said "do it" — do it.
- Do not abbreviate multi-step processes. 7 steps = show all 7.

*Adapted from Zero-Shortcuts by JerkyJesse.*

## Try-First Protocol

Resourcefulness default. Before any refusal: classify it, challenge it, attempt the task. Safety guidelines = load-bearing walls. Everything else = drywall you may mistake for load-bearing.

**Refusal Taxonomy (check in order — SAFETY always first):**

1. **SAFETY.** Genuinely harmful or dangerous. Respect immediately. Name the specific safety concern, not a vague category.

2. **CAPABILITY-FALSE.** You assume you cannot, but you actually can. Attempt the task. Report what happened. Only after genuine attempt may you state a limitation, backed by specific failure observed.

3. **CONFIDENCE-LOW.** You are uncertain you will succeed. Attempt with explicit uncertainty disclosure. "Here is my best attempt — I am not fully confident because [specific reason]" beats "I can't."

4. **EFFORT-AVOIDANCE.** You can do it, but it is long, tedious, or complex. Do the work. Length is not a valid reason to refuse.

When categories overlap, prefer the one that results in attempting the task.

**Rules:**
1. Classify before refusing. Any "I can't," "I'm unable," "as an AI," or soft variants ("you might want to use") — classify first.
2. SAFETY gets respect. Honor limit, but name specific concern. Never "I can't help with that" without naming why.
3. CAPABILITY-FALSE gets an attempt. Try. Report actual results. Specific failure > blanket refusal.
4. CONFIDENCE-LOW gets attempt + disclosure. Deliver best attempt with flagged uncertainty.
5. EFFORT-AVOIDANCE gets the work done. Full thing, not summary.
6. Every refusal includes alternative. No dead ends.
7. Never refuse by category. "As an AI..." is not a refusal. Name the exact constraint.

**Anti-patterns (stop and redo if caught):**
- Do not pre-emptively refuse before attempting.
- "I haven't been trained on this" ≠ "I cannot do this." Attempt unfamiliar tasks.
- "I can't" is not shorthand for "this is hard."
- Name exact constraint, not class of being.

*Adapted from Try-First by JerkyJesse.*

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
~/.claude/skills/cavestack/bin/cavestack-learnings-log '{"skill":"SKILL_NAME","type":"operational","key":"SHORT_KEY","insight":"DESCRIPTION","confidence":N,"source":"observed"}'
```

Replace SKILL_NAME with the current skill name. Only log genuine operational discoveries.
Don't log obvious things or one-time transient errors (network blips, rate limits).
A good test: would knowing this save 5+ minutes in a future session? If yes, log it.

## Completion (run last)

After the skill workflow completes (success, error, or abort), log the completion event.
Determine the skill name from the `name:` field in this file's YAML frontmatter.
Determine the outcome from the workflow result (success if completed normally, error
if it failed, abort if the user interrupted).

**PLAN MODE EXCEPTION — ALWAYS RUN:** This command writes to
`~/.cavestack/analytics/` (user config directory, not project files). The skill
preamble already writes to the same directory — this is the same pattern.
Skipping this command loses session duration and outcome data.

Run this bash:

```bash
_TEL_END=$(date +%s)
_TEL_DUR=$(( _TEL_END - _TEL_START ))
# Session timeline: record skill completion (local-only, never sent anywhere)
~/.claude/skills/cavestack/bin/cavestack-timeline-log '{"skill":"SKILL_NAME","event":"completed","branch":"'$(git branch --show-current 2>/dev/null || echo unknown)'","outcome":"OUTCOME","duration_s":"'"$_TEL_DUR"'","session":"'"$_SESSION_ID"'"}' 2>/dev/null || true
# Local analytics (never leaves machine)
echo '{"skill":"SKILL_NAME","duration_s":"'"$_TEL_DUR"'","outcome":"OUTCOME","browse":"USED_BROWSE","session":"'"$_SESSION_ID"'","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' >> ~/.cavestack/analytics/skill-usage.jsonl 2>/dev/null || true
```

Replace `SKILL_NAME` with the actual skill name from frontmatter, `OUTCOME` with
success/error/abort, and `USED_BROWSE` with true/false based on whether `$B` was used.
If you cannot determine the outcome, use "unknown".

## Plan Mode Safe Operations

When in plan mode, these operations are always allowed because they produce
artifacts that inform the plan, not code changes:

- `$B` commands (browse: screenshots, page inspection, navigation, snapshots)
- `$D` commands (design: generate mockups, variants, comparison boards, iterate)
- `codex exec` / `codex review` (outside voice, plan review, adversarial challenge)
- Writing to `~/.cavestack/` (config, analytics, review logs, design artifacts, learnings)
- Writing to the plan file (already allowed by plan mode)
- `open` commands for viewing generated artifacts (comparison boards, HTML previews)

These are read-only in spirit — they inspect the live site, generate visual artifacts,
or get independent opinions. They do NOT modify project source files.

## Skill Invocation During Plan Mode

If a user invokes a skill during plan mode, that invoked skill workflow takes
precedence over generic plan mode behavior until it finishes or the user explicitly
cancels that skill.

Treat the loaded skill as executable instructions, not reference material. Follow
it step by step. Do not summarize, skip, reorder, or shortcut its steps.

If the skill says to use AskUserQuestion, do that. Those AskUserQuestion calls
satisfy plan mode's requirement to end turns with AskUserQuestion.

If the skill reaches a STOP point, stop immediately at that point, ask the required
question if any, and wait for the user's response. Do not continue the workflow
past a STOP point, and do not call ExitPlanMode at that point.

If the skill includes commands marked "PLAN MODE EXCEPTION — ALWAYS RUN," execute
them. The skill may edit the plan file, and other writes are allowed only if they
are already permitted by Plan Mode Safe Operations or explicitly marked as a plan
mode exception.

Only call ExitPlanMode after the active skill workflow is complete and there are no
other invoked skill workflows left to run, or if the user explicitly tells you to
cancel the skill or leave plan mode.

## Plan Status Footer

When you are in plan mode and about to call ExitPlanMode:

1. Check if the plan file already has a `## CAVESTACK REVIEW REPORT` section.
2. If it DOES — skip (a review skill already wrote a richer report).
3. If it does NOT — run this command:

\`\`\`bash
~/.claude/skills/cavestack/bin/cavestack-review-read
\`\`\`

Then write a `## CAVESTACK REVIEW REPORT` section to the end of the plan file:

- If the output contains review entries (JSONL lines before `---CONFIG---`): format the
  standard report table with runs/status/findings per skill, same format as the review
  skills use.
- If the output is `NO_REVIEWS` or empty: write this placeholder table:

\`\`\`markdown
## CAVESTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | \`/plan-ceo-review\` | Scope & strategy | 0 | — | — |
| Codex Review | \`/codex review\` | Independent 2nd opinion | 0 | — | — |
| Eng Review | \`/plan-eng-review\` | Architecture & tests (required) | 0 | — | — |
| Design Review | \`/plan-design-review\` | UI/UX gaps | 0 | — | — |
| DX Review | \`/plan-devex-review\` | Developer experience gaps | 0 | — | — |

**VERDICT:** NO REVIEWS YET — run \`/autoplan\` for full review pipeline, or individual reviews above.
\`\`\`

**PLAN MODE EXCEPTION — ALWAYS RUN:** This writes to the plan file, which is the one
file you are allowed to edit in plan mode. The plan file review report is part of the
plan's living status.

# /design-html: Pretext-Native HTML Engine

Generate production-quality HTML where text works correctly. Not CSS approximations.
Computed layout via Pretext. Text reflows on resize, heights adjust to content,
cards self-size, chat bubbles shrinkwrap, editorial spreads flow around obstacles.

## DESIGN SETUP (run this check BEFORE any design mockup command)

```bash
_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
D=""
[ -n "$_ROOT" ] && [ -x "$_ROOT/.claude/skills/cavestack/design/dist/design" ] && D="$_ROOT/.claude/skills/cavestack/design/dist/design"
[ -z "$D" ] && D=~/.claude/skills/cavestack/design/dist/design
if [ -x "$D" ]; then
  echo "DESIGN_READY: $D"
else
  echo "DESIGN_NOT_AVAILABLE"
fi
B=""
[ -n "$_ROOT" ] && [ -x "$_ROOT/.claude/skills/cavestack/browse/dist/browse" ] && B="$_ROOT/.claude/skills/cavestack/browse/dist/browse"
[ -z "$B" ] && B=~/.claude/skills/cavestack/browse/dist/browse
if [ -x "$B" ]; then
  echo "BROWSE_READY: $B"
else
  echo "BROWSE_NOT_AVAILABLE (will use 'open' to view comparison boards)"
fi
```

If `DESIGN_NOT_AVAILABLE`: skip visual mockup generation and fall back to the
existing HTML wireframe approach (`DESIGN_SKETCH`). Design mockups are a
progressive enhancement, not a hard requirement.

If `BROWSE_NOT_AVAILABLE`: use `open file://...` instead of `$B goto` to open
comparison boards. The user just needs to see the HTML file in any browser.

If `DESIGN_READY`: the design binary is available for visual mockup generation.
Commands:
- `$D generate --brief "..." --output /path.png` — generate a single mockup
- `$D variants --brief "..." --count 3 --output-dir /path/` — generate N style variants
- `$D compare --images "a.png,b.png,c.png" --output /path/board.html --serve` — comparison board + HTTP server
- `$D serve --html /path/board.html` — serve comparison board and collect feedback via HTTP
- `$D check --image /path.png --brief "..."` — vision quality gate
- `$D iterate --session /path/session.json --feedback "..." --output /path.png` — iterate

**CRITICAL PATH RULE:** All design artifacts (mockups, comparison boards, approved.json)
MUST be saved to `~/.cavestack/projects/$SLUG/designs/`, NEVER to `.context/`,
`docs/designs/`, `/tmp/`, or any project-local directory. Design artifacts are USER
data, not project files. They persist across branches, conversations, and workspaces.

## UX Principles: How Users Actually Behave

These principles govern how real humans interact with interfaces. They are observed
behavior, not preferences. Apply them before, during, and after every design decision.

### The Three Laws of Usability

1. **Don't make me think.** Every page should be self-evident. If a user stops
   to think "What do I click?" or "What does this mean?", the design has failed.
   Self-evident > self-explanatory > requires explanation.

2. **Clicks don't matter, thinking does.** Three mindless, unambiguous clicks
   beat one click that requires thought. Each step should feel like an obvious
   choice (animal, vegetable, or mineral), not a puzzle.

3. **Omit, then omit again.** Get rid of half the words on each page, then get
   rid of half of what's left. Happy talk (self-congratulatory text) must die.
   Instructions must die. If they need reading, the design has failed.

### How Users Actually Behave

- **Users scan, they don't read.** Design for scanning: visual hierarchy
  (prominence = importance), clearly defined areas, headings and bullet lists,
  highlighted key terms. We're designing billboards going by at 60 mph, not
  product brochures people will study.
- **Users satisfice.** They pick the first reasonable option, not the best.
  Make the right choice the most visible choice.
- **Users muddle through.** They don't figure out how things work. They wing
  it. If they accomplish their goal by accident, they won't seek the "right" way.
  Once they find something that works, no matter how badly, they stick to it.
- **Users don't read instructions.** They dive in. Guidance must be brief,
  timely, and unavoidable, or it won't be seen.

### Billboard Design for Interfaces

- **Use conventions.** Logo top-left, nav top/left, search = magnifying glass.
  Don't innovate on navigation to be clever. Innovate when you KNOW you have a
  better idea, otherwise use conventions. Even across languages and cultures,
  web conventions let people identify the logo, nav, search, and main content.
- **Visual hierarchy is everything.** Related things are visually grouped. Nested
  things are visually contained. More important = more prominent. If everything
  shouts, nothing is heard. Start with the assumption everything is visual noise,
  guilty until proven innocent.
- **Make clickable things obviously clickable.** No relying on hover states for
  discoverability, especially on mobile where hover doesn't exist. Shape, location,
  and formatting (color, underlining) must signal clickability without interaction.
- **Eliminate noise.** Three sources: too many things shouting for attention
  (shouting), things not organized logically (disorganization), and too much stuff
  (clutter). Fix noise by removal, not addition.
- **Clarity trumps consistency.** If making something significantly clearer
  requires making it slightly inconsistent, choose clarity every time.

### Navigation as Wayfinding

Users on the web have no sense of scale, direction, or location. Navigation
must always answer: What site is this? What page am I on? What are the major
sections? What are my options at this level? Where am I? How can I search?

Persistent navigation on every page. Breadcrumbs for deep hierarchies.
Current section visually indicated. The "trunk test": cover everything except
the navigation. You should still know what site this is, what page you're on,
and what the major sections are. If not, the navigation has failed.

### The Goodwill Reservoir

Users start with a reservoir of goodwill. Every friction point depletes it.

**Deplete faster:** Hiding info users want (pricing, contact, shipping). Punishing
users for not doing things your way (formatting requirements on phone numbers).
Asking for unnecessary information. Putting sizzle in their way (splash screens,
forced tours, interstitials). Unprofessional or sloppy appearance.

**Replenish:** Know what users want to do and make it obvious. Tell them what they
want to know upfront. Save them steps wherever possible. Make it easy to recover
from errors. When in doubt, apologize.

### Mobile: Same Rules, Higher Stakes

All the above applies on mobile, just more so. Real estate is scarce, but never
sacrifice usability for space savings. Affordances must be VISIBLE: no cursor
means no hover-to-discover. Touch targets must be big enough (44px minimum).
Flat design can strip away useful visual information that signals interactivity.
Prioritize ruthlessly: things needed in a hurry go close at hand, everything
else a few taps away with an obvious path to get there.

## SETUP (run this check BEFORE any browse command)

```bash
_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
B=""
[ -n "$_ROOT" ] && [ -x "$_ROOT/.claude/skills/cavestack/browse/dist/browse" ] && B="$_ROOT/.claude/skills/cavestack/browse/dist/browse"
[ -z "$B" ] && B=~/.claude/skills/cavestack/browse/dist/browse
if [ -x "$B" ]; then
  echo "READY: $B"
else
  echo "NEEDS_SETUP"
fi
```

If `NEEDS_SETUP`:
1. Tell the user: "cavestack browse needs a one-time build (~10 seconds). OK to proceed?" Then STOP and wait.
2. Run: `cd <SKILL_DIR> && ./setup`
3. If `bun` is not installed:
   ```bash
   if ! command -v bun >/dev/null 2>&1; then
     BUN_VERSION="1.3.10"
     BUN_INSTALL_SHA="bab8acfb046aac8c72407bdcce903957665d655d7acaa3e11c7c4616beae68dd"
     tmpfile=$(mktemp)
     curl -fsSL "https://bun.sh/install" -o "$tmpfile"
     actual_sha=$(shasum -a 256 "$tmpfile" | awk '{print $1}')
     if [ "$actual_sha" != "$BUN_INSTALL_SHA" ]; then
       echo "ERROR: bun install script checksum mismatch" >&2
       echo "  expected: $BUN_INSTALL_SHA" >&2
       echo "  got:      $actual_sha" >&2
       rm "$tmpfile"; exit 1
     fi
     BUN_VERSION="$BUN_VERSION" bash "$tmpfile"
     rm "$tmpfile"
   fi
   ```

---

## Step 0: Input Detection

```bash
eval "$(~/.claude/skills/cavestack/bin/cavestack-slug 2>/dev/null)"
```

Detect design context for project. Run all four checks:

```bash
setopt +o nomatch 2>/dev/null || true
_CEO=$(ls -t ~/.cavestack/projects/$SLUG/ceo-plans/*.md 2>/dev/null | head -1)
[ -n "$_CEO" ] && echo "CEO_PLAN: $_CEO" || echo "NO_CEO_PLAN"
```

```bash
setopt +o nomatch 2>/dev/null || true
_APPROVED=$(ls -t ~/.cavestack/projects/$SLUG/designs/*/approved.json 2>/dev/null | head -1)
[ -n "$_APPROVED" ] && echo "APPROVED: $_APPROVED" || echo "NO_APPROVED"
```

```bash
setopt +o nomatch 2>/dev/null || true
_VARIANTS=$(ls -t ~/.cavestack/projects/$SLUG/designs/*/variant-*.png 2>/dev/null | head -1)
[ -n "$_VARIANTS" ] && echo "VARIANTS: $_VARIANTS" || echo "NO_VARIANTS"
```

```bash
setopt +o nomatch 2>/dev/null || true
_FINALIZED=$(ls -t ~/.cavestack/projects/$SLUG/designs/*/finalized.html 2>/dev/null | head -1)
[ -n "$_FINALIZED" ] && echo "FINALIZED: $_FINALIZED" || echo "NO_FINALIZED"
[ -f DESIGN.md ] && echo "DESIGN_MD: exists" || echo "NO_DESIGN_MD"
```

Route based on what was found. Check in order:

### Case A: approved.json exists (design-shotgun ran)

Read it. Extract: approved variant PNG path, user feedback, screen name. Also read
CEO plan if exists (strategic context). Read `DESIGN.md` if in repo root — tokens
take priority for system-level values (fonts, brand colors, spacing scale).

Check for prior finalized.html. If `FINALIZED` also found, use AskUserQuestion:
> Found a prior finalized HTML from a previous session. Want to evolve it
> (apply new changes on top, preserving your custom edits) or start fresh?
> A) Evolve — iterate on the existing HTML
> B) Start fresh — regenerate from the approved mockup

If evolve: read existing HTML. Apply changes on top during Step 3.
If fresh or no finalized.html: proceed to Step 1 with approved PNG as reference.

### Case B: CEO plan and/or variants exist, no approved.json

Read whichever context exists:
- CEO plan found: read it, summarize vision and design requirements.
- Variant PNGs found: show inline via Read tool.
- DESIGN.md found: read for design tokens and constraints.

Use AskUserQuestion:
> Found [CEO plan from /plan-ceo-review | design review variants from /plan-design-review | both]
> but no approved design mockup.
> A) Run /design-shotgun — explore design variants based on the existing plan context
> B) Skip mockups — I'll design the HTML directly from the plan context
> C) I have a PNG — let me provide the path

If A: tell user to run /design-shotgun, then come back to /design-html.
If B: proceed to Step 1 in "plan-driven mode." No approved PNG — plan is source of truth. Ask user for screen name (e.g., "landing-page", "dashboard", "pricing").
If C: accept PNG path from user, proceed with that as reference.

### Case C: Nothing found (clean slate)

Use AskUserQuestion:
> No design context found for this project. How do you want to start?
> A) Run /plan-ceo-review first — think through the product strategy before designing
> B) Run /plan-design-review first — design review with visual mockups
> C) Run /design-shotgun — jump straight to visual design exploration
> D) Just describe it — tell me what you want and I'll design the HTML live

If A, B, or C: tell user to run that skill, then come back to /design-html.
If D: proceed to Step 1 in "freeform mode." Ask user for screen name.

### Context summary

Output brief context summary:
- **Mode:** approved-mockup | plan-driven | freeform | evolve
- **Visual ref:** path to approved PNG, or "none (plan-driven)" or "none (freeform)"
- **CEO plan:** path or "none"
- **Design tokens:** "DESIGN.md" or "none"
- **Screen name:** from approved.json, user-provided, or inferred from plan

---

## Step 1: Design Analysis

1. If `$D` available (`DESIGN_READY`), extract structured spec:
```bash
$D prompt --image <approved-variant.png> --output json
```
Returns colors, typography, layout, component inventory via GPT-4o vision.

2. If `$D` unavailable, read approved PNG inline via Read tool. Describe visual layout,
   colors, typography, component structure.

3. If plan-driven or freeform (no approved PNG), design from context:
   - **Plan-driven:** read CEO plan / design review notes. Extract UI requirements, user
     flows, audience, visual feel (dark/light, dense/spacious), content structure (hero,
     features, pricing), constraints. Build spec from plan prose.
   - **Freeform:** use AskUserQuestion to gather what user wants. Ask about: purpose/audience,
     visual feel (dark/light, playful/serious, dense/spacious), content structure, reference sites.
   In both cases, describe intended layout, colors, typography, components as spec.
   Generate realistic content from plan or description (never lorem ipsum).

4. Read `DESIGN.md` tokens. Override any extracted values for system-level properties
   (brand colors, font family, spacing scale).

5. Output "Implementation spec": colors (hex), fonts (family + weights), spacing scale,
   component list, layout type.

---

## Step 2: Smart Pretext API Routing

Classify design into Pretext tier. Each tier uses different APIs:

| Design type | Pretext APIs | Use case |
|-------------|-------------|----------|
| Simple layout (landing, marketing) | `prepare()` + `layout()` | Resize-aware heights |
| Card/grid (dashboard, listing) | `prepare()` + `layout()` | Self-sizing cards |
| Chat/messaging UI | `prepareWithSegments()` + `walkLineRanges()` | Tight-fit bubbles, min-width |
| Content-heavy (editorial, blog) | `prepareWithSegments()` + `layoutNextLine()` | Text around obstacles |
| Complex editorial | Full engine + `layoutWithLines()` | Manual line rendering |

State chosen tier and why. Reference specific Pretext APIs.

---

## Step 2.5: Framework Detection

Check if project uses frontend framework:

```bash
[ -f package.json ] && cat package.json | grep -o '"react"\|"svelte"\|"vue"\|"@angular/core"\|"solid-js"\|"preact"' | head -1 || echo "NONE"
```

If framework detected, use AskUserQuestion:
> Detected [React/Svelte/Vue] in your project. What format should the output be?
> A) Vanilla HTML — self-contained preview file (recommended for first pass)
> B) [React/Svelte/Vue] component — framework-native with Pretext hooks

If framework chosen, one follow-up:
> A) TypeScript
> B) JavaScript

Vanilla HTML → Step 3 with vanilla. Framework → Step 3 with framework patterns.
No framework detected → vanilla HTML, no question needed.

---

## Step 3: Generate Pretext-Native HTML

### Pretext Source Embedding

For **vanilla HTML**, check for vendored Pretext bundle:
```bash
_PRETEXT_VENDOR=""
_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
[ -n "$_ROOT" ] && [ -f "$_ROOT/.claude/skills/cavestack/design-html/vendor/pretext.js" ] && _PRETEXT_VENDOR="$_ROOT/.claude/skills/cavestack/design-html/vendor/pretext.js"
[ -z "$_PRETEXT_VENDOR" ] && [ -f ~/.claude/skills/cavestack/design-html/vendor/pretext.js ] && _PRETEXT_VENDOR=~/.claude/skills/cavestack/design-html/vendor/pretext.js
[ -n "$_PRETEXT_VENDOR" ] && echo "VENDOR: $_PRETEXT_VENDOR" || echo "VENDOR_MISSING"
```

- If `VENDOR` found: inline in `<script>` tag. Fully self-contained, zero network deps.
- If `VENDOR_MISSING`: CDN fallback:
  `<script type="module">import { prepare, layout, prepareWithSegments, walkLineRanges, layoutNextLine, layoutWithLines } from 'https://esm.sh/@chenglou/pretext'</script>`
  Add comment: `<!-- FALLBACK: vendor/pretext.js missing, using CDN -->`

For **framework output**, add to project deps instead:
```bash
# Detect package manager
[ -f bun.lockb ] && echo "bun add @chenglou/pretext" || \
[ -f pnpm-lock.yaml ] && echo "pnpm add @chenglou/pretext" || \
[ -f yarn.lock ] && echo "yarn add @chenglou/pretext" || \
echo "npm install @chenglou/pretext"
```
Run detected install command. Use standard imports in component.

### HTML Generation

Write single file via Write tool. Save to:
`~/.cavestack/projects/$SLUG/designs/<screen-name>-YYYYMMDD/finalized.html`

Framework output:
`~/.cavestack/projects/$SLUG/designs/<screen-name>-YYYYMMDD/finalized.[tsx|svelte|vue]`

**Always include (vanilla HTML):**
- Pretext source (inlined or CDN)
- CSS custom properties for design tokens
- Google Fonts via `<link>` + `document.fonts.ready` gate before `prepare()`
- Semantic HTML5 (`<header>`, `<nav>`, `<main>`, `<section>`, `<footer>`)
- Responsive via Pretext relayout (not just media queries)
- Breakpoints: 375px, 768px, 1024px, 1440px
- ARIA attributes, heading hierarchy, focus-visible
- `contenteditable` on text + MutationObserver for re-prepare/re-layout
- ResizeObserver on containers for re-layout
- `prefers-color-scheme` for dark mode
- `prefers-reduced-motion` for animation respect
- Real content from mockup (never lorem ipsum)

**Never include (slop blacklist):**
- Purple/blue gradients as default
- Generic 3-column feature grids
- Center-everything layouts without hierarchy
- Decorative blobs/waves/patterns not in mockup
- Stock photo placeholder divs
- Generic "Get Started"/"Learn More" CTAs not from mockup
- Default rounded-corner card + drop shadow
- Emoji as visual elements
- Generic testimonial sections
- Cookie-cutter hero: left-text right-image

### Pretext Wiring Patterns

Patterns based on tier from Step 2. Correct Pretext API usage — follow exactly.

**Pattern 1: Basic height computation (Simple layout, Card/grid)**
```js
import { prepare, layout } from './pretext-inline.js'
// Or if inlined: const { prepare, layout } = window.Pretext

// 1. PREPARE — one-time, after fonts load
await document.fonts.ready
const elements = document.querySelectorAll('[data-pretext]')
const prepared = new Map()

for (const el of elements) {
  const text = el.textContent
  const font = getComputedStyle(el).font
  prepared.set(el, prepare(text, font))
}

// 2. LAYOUT — cheap, call on every resize
function relayout() {
  for (const [el, handle] of prepared) {
    const { height } = layout(handle, el.clientWidth, parseFloat(getComputedStyle(el).lineHeight))
    el.style.height = `${height}px`
  }
}

// 3. RESIZE-AWARE
new ResizeObserver(() => relayout()).observe(document.body)
relayout()

// 4. CONTENT-EDITABLE — re-prepare when text changes
for (const el of elements) {
  if (el.contentEditable === 'true') {
    new MutationObserver(() => {
      const font = getComputedStyle(el).font
      prepared.set(el, prepare(el.textContent, font))
      relayout()
    }).observe(el, { characterData: true, subtree: true, childList: true })
  }
}
```

**Pattern 2: Shrinkwrap / tight-fit (Chat bubbles)**
```js
import { prepareWithSegments, walkLineRanges } from './pretext-inline.js'

// Find the tightest width that produces the same line count
function shrinkwrap(text, font, maxWidth, lineHeight) {
  const segs = prepareWithSegments(text, font)
  let bestWidth = maxWidth
  walkLineRanges(segs, maxWidth, (lineCount, startIdx, endIdx) => {
    // walkLineRanges calls back with progressively narrower widths
    // The first call gives us the line count at maxWidth
    // We want the narrowest width that still produces this line count
  })
  // Binary search for tightest width with same line count
  const { lineCount: targetLines } = layout(prepare(text, font), maxWidth, lineHeight)
  let lo = 0, hi = maxWidth
  while (hi - lo > 1) {
    const mid = (lo + hi) / 2
    const { lineCount } = layout(prepare(text, font), mid, lineHeight)
    if (lineCount === targetLines) hi = mid
    else lo = mid
  }
  return hi
}
```

**Pattern 3: Text around obstacles (Editorial layout)**
```js
import { prepareWithSegments, layoutNextLine } from './pretext-inline.js'

function layoutAroundObstacles(text, font, containerWidth, lineHeight, obstacles) {
  const segs = prepareWithSegments(text, font)
  let state = null
  let y = 0
  const lines = []

  while (true) {
    // Calculate available width at current y position, accounting for obstacles
    let availWidth = containerWidth
    for (const obs of obstacles) {
      if (y >= obs.top && y < obs.top + obs.height) {
        availWidth -= obs.width
      }
    }

    const result = layoutNextLine(segs, state, availWidth, lineHeight)
    if (!result) break

    lines.push({ text: result.text, width: result.width, x: 0, y })
    state = result.state
    y += lineHeight
  }

  return { lines, totalHeight: y }
}
```

**Pattern 4: Full line-by-line rendering (Complex editorial)**
```js
import { prepareWithSegments, layoutWithLines } from './pretext-inline.js'

const segs = prepareWithSegments(text, font)
const { lines, height } = layoutWithLines(segs, containerWidth, lineHeight)

// lines = [{ text, width, x, y }, ...]
// Use for Canvas/SVG rendering or custom DOM positioning
for (const line of lines) {
  const span = document.createElement('span')
  span.textContent = line.text
  span.style.position = 'absolute'
  span.style.left = `${line.x}px`
  span.style.top = `${line.y}px`
  container.appendChild(span)
}
```

### Pretext API Reference

```
PRETEXT API CHEATSHEET:

prepare(text, font) → handle
  One-time text measurement. Call after document.fonts.ready.
  Font: CSS shorthand like '16px Inter' or 'bold 24px Georgia'.

layout(prepared, maxWidth, lineHeight) → { height, lineCount }
  Fast layout computation. Call on every resize. Sub-millisecond.

prepareWithSegments(text, font) → handle
  Like prepare() but enables line-level APIs below.

layoutWithLines(segs, maxWidth, lineHeight) → { lines: [{text, width, x, y}...], height }
  Full line-by-line breakdown. For Canvas/SVG rendering.

walkLineRanges(segs, maxWidth, onLine) → void
  Calls onLine(lineCount, startIdx, endIdx) for each possible layout.
  Find minimum width for N lines. For tight-fit containers.

layoutNextLine(segs, state, maxWidth, lineHeight) → { text, width, state } | null
  Iterator. Different maxWidth per line = text around obstacles.
  Pass null as initial state. Returns null when text is exhausted.

clearCache() → void
  Clears internal measurement caches. Use when cycling many fonts.

setLocale(locale?) → void
  Retargets word segmenter for future prepare() calls.
```

---

## Step 3.5: Live Reload Server

After writing HTML, start simple HTTP server for live preview:

```bash
# Start a simple HTTP server in the output directory
_OUTPUT_DIR=$(dirname <path-to-finalized.html>)
cd "$_OUTPUT_DIR"
python3 -m http.server 0 --bind 127.0.0.1 &
_SERVER_PID=$!
_PORT=$(lsof -i -P -n | grep "$_SERVER_PID" | grep LISTEN | awk '{print $9}' | cut -d: -f2 | head -1)
echo "SERVER: http://localhost:$_PORT/finalized.html"
echo "PID: $_SERVER_PID"
```

If python3 unavailable, fall back to:
```bash
open <path-to-finalized.html>
```

Tell user: "Live preview at http://localhost:$_PORT/finalized.html.
Refresh browser (Cmd+R) after each edit."

When refinement loop ends (Step 4 exits), kill server:
```bash
kill $_SERVER_PID 2>/dev/null || true
```

---

## Step 4: Preview + Refinement Loop

### Verification Screenshots

If `$B` available (browse binary), take screenshots at 3 viewports:

```bash
$B goto "file://<path-to-finalized.html>"
$B screenshot /tmp/cavestack-verify-mobile.png --width 375
$B screenshot /tmp/cavestack-verify-tablet.png --width 768
$B screenshot /tmp/cavestack-verify-desktop.png --width 1440
```

Show all three inline via Read tool. Check for:
- Text overflow (cut off or beyond containers)
- Layout collapse (overlapping or missing)
- Responsive breakage (not adapting to viewport)

If issues found, fix before presenting to user.

If `$B` unavailable, skip and note:
"Browse binary not available. Skipping automated viewport verification."

### Refinement Loop

```
LOOP:
  1. If server is running, tell user to open http://localhost:PORT/finalized.html
     Otherwise: open <path>/finalized.html

  2. If an approved mockup PNG exists, show it inline (Read tool) for visual comparison.
     If in plan-driven or freeform mode, skip this step.

  3. AskUserQuestion (adjust wording based on mode):
     With mockup: "The HTML is live in your browser. Here's the approved mockup for comparison.
      Try: resize the window (text should reflow dynamically),
      click any text (it's editable, layout recomputes instantly).
      What needs to change? Say 'done' when satisfied."
     Without mockup: "The HTML is live in your browser. Try: resize the window
      (text should reflow dynamically), click any text (it's editable, layout
      recomputes instantly). What needs to change? Say 'done' when satisfied."

  4. If "done" / "ship it" / "looks good" / "perfect" → exit loop, go to Step 5

  5. Apply feedback using targeted Edit tool changes on the HTML file
     (do NOT regenerate the entire file — surgical edits only)

  6. Brief summary of what changed (2-3 lines max)

  7. If verification screenshots are available, re-take them to confirm the fix

  8. Go to LOOP
```

Max 10 iterations. If no "done" after 10, use AskUserQuestion:
"We've done 10 rounds of refinement. Want to continue iterating or call it done?"

---

## Step 5: Save & Next Steps

### Design Token Extraction

If no `DESIGN.md` in repo root, offer to create from generated HTML.

Extract: CSS custom properties (colors, spacing, sizes), font families/weights, color
palette (primary, secondary, accent, neutral), spacing scale, border radius, shadows.

Use AskUserQuestion:
> No DESIGN.md found. I can extract the design tokens from the HTML we just built
> and create a DESIGN.md for your project. This means future /design-shotgun and
> /design-html runs will be style-consistent automatically.
> A) Create DESIGN.md from these tokens
> B) Skip — I'll handle the design system later

If A: write `DESIGN.md` to repo root with extracted tokens.

### Save Metadata

Write `finalized.json` alongside HTML:
```json
{
  "source_mockup": "<approved variant PNG path or null>",
  "source_plan": "<CEO plan path or null>",
  "mode": "<approved-mockup|plan-driven|freeform|evolve>",
  "html_file": "<path to finalized.html or component file>",
  "pretext_tier": "<selected tier>",
  "framework": "<vanilla|react|svelte|vue>",
  "iterations": <number of refinement iterations>,
  "date": "<ISO 8601>",
  "screen": "<screen name>",
  "branch": "<current branch>"
}
```

### Next Steps

Use AskUserQuestion:
> Design finalized with Pretext-native layout. What's next?
> A) Copy to project — copy the HTML/component into your codebase
> B) Iterate more — keep refining
> C) Done — I'll use this as a reference

---

## Important Rules

- **Source of truth fidelity > code elegance.** Approved mockup → pixel-match it. If
  that needs `width: 312px` not CSS grid class, that's correct. Plan-driven/freeform →
  user feedback is source of truth. Code cleanup later in component extraction.

- **Always use Pretext.** Even simple designs — Pretext ensures correct height on resize.
  30KB overhead. Every page benefits.

- **Surgical edits in refinement loop.** Edit tool for targeted changes, not Write to
  regenerate entire file. User may have manual edits via contenteditable to preserve.

- **Real content only.** Mockup → extract text. Plan-driven → content from plan.
  Freeform → realistic content from description. Never "Lorem ipsum" or placeholders.

- **One page per invocation.** Multi-page → run /design-html once per page.
