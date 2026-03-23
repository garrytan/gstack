---
name: second-model-review
version: 1.0.0
description: |
  Second model review — three modes. Code review: independent diff review
  with pass/fail gate. Challenge: adversarial mode that tries to break your code.
  Consult: ask another AI model anything with context. Supports Codex (OpenAI),
  Gemini (Google), and Cursor (Composer). Use when asked to
  "second model review", "second opinion", "codex review", "gemini review",
  "challenge my code", or "ask codex/gemini/cursor".
allowed-tools:
  - Bash
  - Read
  - Write
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
_HOST_AGENT="unknown"
[ "${CLAUDECODE:-}" = "1" ] && _HOST_AGENT="claude"
[ "${CODEX:-}" = "1" ] && _HOST_AGENT="codex"
ps -o comm= -p $PPID 2>/dev/null | grep -qi codex && _HOST_AGENT="codex"
ps -o comm= -p $PPID 2>/dev/null | grep -qi gemini && _HOST_AGENT="gemini"
ps -o comm= -p $PPID 2>/dev/null | grep -qi 'agent\|cursor' && _HOST_AGENT="cursor"
echo "HOST_AGENT: $_HOST_AGENT"
_SM_ENABLED=$(~/.claude/skills/gstack/bin/gstack-config get second_model_enabled 2>/dev/null || echo "unset")
_SM_PROVIDER=$(~/.claude/skills/gstack/bin/gstack-config get second_model_provider 2>/dev/null || echo "")
echo "SECOND_MODEL: enabled=$_SM_ENABLED second_model_name=$_SM_PROVIDER"
mkdir -p ~/.gstack/analytics
echo '{"skill":"second-model-review","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","repo":"'$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")'"}'  >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
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

# /second-model-review — Multi-AI Second Opinion

You are running the `/second-model-review` skill. This wraps a second model CLI to get an
independent, brutally honest second opinion from a different AI system.

The second model is direct, terse, technically precise, challenges assumptions, and catches
things you might miss. Present its output faithfully, not summarized.

---

## Step 0: Determine second model

Check the `HOST_AGENT` line from the preamble to know which agent is running this skill.
Check the `SECOND_MODEL` line for `enabled=` and `second_model_name=` values.

**Second model lookup table:**

| ID | Display Name | Binary | Install |
|----|-------------|--------|---------|
| codex | Codex (OpenAI) | `codex` | `npm install -g @openai/codex` |
| gemini | Gemini (Google) | `gemini` | `npm install -g @google/gemini-cli` |
| cursor | Cursor (Composer) | `agent` | Install Cursor: https://cursor.com, then `cursor --install-cli` |

**Self-detection:** If the configured second model matches `HOST_AGENT` (e.g., Codex
running on Codex), skip it — you cannot be your own second opinion. Instead, detect
other available models and offer those. If no other model is available, tell the user:
"The configured second model ({second_model_name}) is the same agent running this session.
Install a different model for cross-model review."

**If `enabled=unset` or `enabled=false`:** Detect binaries on the fly:

```bash
which codex 2>/dev/null && echo "HAS_CODEX" || true
which gemini 2>/dev/null && echo "HAS_GEMINI" || true
which agent 2>/dev/null && echo "HAS_CURSOR" || true
```

Exclude the binary matching `HOST_AGENT` from the options — only offer *different* models.
If at least one different model is detected, ask which to use and persist:
```bash
~/.claude/skills/gstack/bin/gstack-config set second_model_enabled true
~/.claude/skills/gstack/bin/gstack-config set second_model_provider <chosen_id>
```
If no different model detected, stop: "No second model CLI found that differs from the current agent."

**If `enabled=true`:** Look up the binary for the configured second model and verify it exists:

```bash
which <binary> 2>/dev/null && echo "READY" || echo "NOT_FOUND"
```

If `NOT_FOUND`: warn and offer to switch to a detected second model or disable.

---

## Step 1: Detect mode

Parse the user's input to determine which mode to run:

1. `/second-model-review review` or `/second-model-review review <instructions>` — **Review mode** (Step 2A)
2. `/second-model-review challenge` or `/second-model-review challenge <focus>` — **Challenge mode** (Step 2B)
3. `/second-model-review` with no arguments — **Auto-detect:**
   - Check for a diff (with fallback if origin isn't available):
     `git diff origin/<base> --stat 2>/dev/null | tail -1 || git diff <base> --stat 2>/dev/null | tail -1`
   - If a diff exists, use AskUserQuestion:
     ```
     {second-model-name} detected changes against the base branch. What should it do?
     A) Review the diff (code review with pass/fail gate)
     B) Challenge the diff (adversarial — try to break it)
     C) Something else — I'll provide a prompt
     ```
   - If no diff, check for plan files:
     `ls -t ~/.claude/plans/*.md 2>/dev/null | xargs grep -l "$(basename $(pwd))" 2>/dev/null | head -1`
     If no project-scoped match: `ls -t ~/.claude/plans/*.md 2>/dev/null | head -1`
     but warn: "Note: this plan may be from a different project."
   - If a plan file exists, offer to review it
   - Otherwise, ask: "What would you like to ask {second-model-name}?"
4. `/second-model-review <anything else>` — **Consult mode** (Step 2C)

---

## Step 2A: Review Mode

Run second model code review against the current branch diff.

1. Create temp files for output capture:
```bash
TMPERR=$(mktemp /tmp/second-model-err-XXXXXX.txt)
```

2. Run the review (5-minute timeout):

**If second model is `codex`:**
```bash
codex review --base <base> -c 'model_reasoning_effort="high"' --enable web_search_cached 2>"$TMPERR"
```

If custom instructions provided (e.g., `/second-model-review review focus on security`):
```bash
codex review "focus on security" --base <base> -c 'model_reasoning_effort="high"' --enable web_search_cached 2>"$TMPERR"
```

**If second model is `gemini`:**
```bash
PROMPT="You are a brutally honest technical reviewer. Review the changes on this branch against the base branch. Run git diff origin/<base> to see the diff. Look for: logical gaps and unstated assumptions, missing error handling or edge cases, overcomplexity (is there a simpler approach?), feasibility risks (what could go wrong?), and missing dependencies or sequencing issues. Be direct. Be terse. No compliments. Just the problems. Flag critical issues as [P1] and minor ones as [P2]."
gemini --sandbox -p "$PROMPT" 2>"$TMPERR"
```

**If second model is `cursor`:**
```bash
PROMPT="You are a brutally honest technical reviewer. Review the changes on this branch against the base branch. Run git diff origin/<base> to see the diff. Look for: logical gaps and unstated assumptions, missing error handling or edge cases, overcomplexity (is there a simpler approach?), feasibility risks (what could go wrong?), and missing dependencies or sequencing issues. Be direct. Be terse. No compliments. Just the problems. Flag critical issues as [P1] and minor ones as [P2]."
agent --trust -p "$PROMPT" --model composer-2 2>"$TMPERR"
```

3. Determine gate verdict: check the output for `[P1]` markers.
   If `[P1]` found → GATE: FAIL. Otherwise → GATE: PASS.

4. Present the output:

```
{SECOND_MODEL_NAME} SAYS (code review):
════════════════════════════════════════════════════════════
<full output, verbatim — do not truncate or summarize>
════════════════════════════════════════════════════════════
GATE: PASS                    Tokens: N | Est. cost: ~$X.XX
```

5. **Cross-model comparison:** If `/review` (Claude's own review) was already run,
   compare the two sets of findings:

```
CROSS-MODEL ANALYSIS:
  Both found: [findings that overlap]
  Only {second-model-name} found: [unique to external]
  Only Claude found: [unique to Claude's /review]
  Agreement rate: X% (N/M total unique findings overlap)
```

6. Persist the review result:
```bash
~/.claude/skills/gstack/bin/gstack-review-log '{"skill":"second-model-review","second_model_name":"SECOND_MODEL_NAME","timestamp":"TIMESTAMP","status":"STATUS","gate":"GATE","findings":N}'
```

7. Clean up:
```bash
rm -f "$TMPERR"
```

---

## Step 2B: Challenge (Adversarial) Mode

The second model tries to break your code — finding edge cases, race conditions,
security holes, and failure modes that a normal review would miss.

1. Construct the adversarial prompt:

Default (no focus):
"Review the changes on this branch against the base branch. Run `git diff origin/<base>` to see the diff. Your job is to find ways this code will fail in production. Think like an attacker and a chaos engineer. Find edge cases, race conditions, security holes, resource leaks, failure modes. Be adversarial. Be thorough. No compliments — just the problems."

With focus (e.g., "security"):
"Review the changes on this branch against the base branch. Run `git diff origin/<base>` to see the diff. Focus specifically on SECURITY. Your job is to find every way an attacker could exploit this code. Think about injection vectors, auth bypasses, privilege escalation, data exposure, and timing attacks. Be adversarial."

2. Run with the appropriate second model command (5-minute timeout):

**If second model is `codex`:**
```bash
codex exec "<prompt>" -s read-only -c 'model_reasoning_effort="xhigh"' --enable web_search_cached
```

**If second model is `gemini`:**
```bash
gemini --sandbox -p "<prompt>"
```

**If second model is `cursor`:**
```bash
agent --trust -p "<prompt>" --model composer-2
```

3. Present the full output:

```
{SECOND_MODEL_NAME} SAYS (adversarial challenge):
════════════════════════════════════════════════════════════
<full output, verbatim>
════════════════════════════════════════════════════════════
```

---

## Step 2C: Consult Mode

Ask the second model anything about the codebase.

1. **Session continuity (Codex only):**

If second model is `codex`, check for an existing session:
```bash
cat .context/codex-session-id 2>/dev/null || echo "NO_SESSION"
```

If a session exists, use AskUserQuestion:
```
You have an active Codex conversation from earlier. Continue it or start fresh?
A) Continue the conversation (Codex remembers the prior context)
B) Start a new conversation
```

For gemini and cursor: sessions always start fresh.

2. **Plan review auto-detection:** If the user's prompt is about reviewing a plan,
or if plan files exist and the user said `/second-model-review` with no arguments:
```bash
ls -t ~/.claude/plans/*.md 2>/dev/null | xargs grep -l "$(basename $(pwd))" 2>/dev/null | head -1
```
Read the plan file and prepend the review prompt:
"You are a brutally honest technical reviewer. Review the changes on this branch against the base branch. Run git diff origin/<base> to see the diff. Look for: logical gaps and unstated assumptions, missing error handling or edge cases, overcomplexity (is there a simpler approach?), feasibility risks (what could go wrong?), and missing dependencies or sequencing issues. Be direct. Be terse. No compliments. Just the problems.

THE PLAN:
<plan content>"

3. Run with the second model command (5-minute timeout):

**If second model is `codex` (new session):**
```bash
codex exec "<prompt>" -s read-only -c 'model_reasoning_effort="high"' --enable web_search_cached
```

**If second model is `codex` (resumed session):**
```bash
codex exec resume <session-id> "<prompt>" -s read-only -c 'model_reasoning_effort="high"' --enable web_search_cached
```

**If second model is `gemini`:**
```bash
gemini --sandbox -p "<prompt>"
```

**If second model is `cursor`:**
```bash
agent --trust -p "<prompt>" --model composer-2
```

4. **Save session (Codex only):**
```bash
mkdir -p .context
```
Save the session ID to `.context/codex-session-id`.

5. Present the output:

```
{SECOND_MODEL_NAME} SAYS (consult):
════════════════════════════════════════════════════════════
<full output, verbatim>
════════════════════════════════════════════════════════════
Session saved — run /second-model-review again to continue this conversation.
```

(Session line only for Codex — other second models start fresh each time.)

6. Note any points where the second model's analysis differs from your own:
   "Note: Claude Code disagrees on X because Y."

---

## Model & Reasoning

**No model is hardcoded** — each second model uses its default frontier model. This means
as new models ship, /second-model-review automatically uses them. If the user
wants a specific model:
- Codex: pass `-m <model>` through to codex
- Gemini: pass `--model <model>` through to gemini
- Cursor: pass `--model <model>` through to agent

**Reasoning effort** varies by mode:
- **Review mode:** high — thorough but not slow
- **Challenge (adversarial) mode:** maximum — think as hard as possible
- **Consult mode:** high — good balance of depth and speed

---

## Error Handling

- **Binary not found:** Detected in Step 0. Stop with install instructions for the configured second model.
- **Auth error:** Surface the second model's auth error message. Common fixes:
  - Codex: `codex login`
  - Gemini: `gemini auth login`
  - Cursor: check Cursor CLI auth docs
- **Timeout:** If the command times out (5 min):
  "Timed out after 5 minutes. The diff may be too large or the API may be slow."
- **Empty response:** Tell the user and suggest checking stderr.
- **Session resume failure (Codex):** Delete `.context/codex-session-id` and start fresh.

---

## Important Rules

- **Never modify files.** This skill is read-only. Second Models run in read-only mode.
- **Present output verbatim.** Do not truncate, summarize, or editorialize the output.
- **Add synthesis after, not instead of.** Claude commentary comes after the full output.
- **5-minute timeout** on all commands (`timeout: 300000`).
- **No double-reviewing.** If the user already ran `/review`, this provides a second
  independent opinion. Do not re-run Claude Code's own review.
