---
name: codex
version: 1.1.0
description: |
  OpenAI Codex CLI wrapper — four modes. Code review: independent diff review
  with pass/fail gate, Claude-skepticism preamble. Challenge: adversarial mode
  that tries to break your code. Consult: ask codex anything with session
  continuity. Verify: audit a recommendation Claude gave you, independently —
  closes the 2026-05-09 ShipStation-class failure path. Use when asked to
  "codex review", "codex challenge", "codex verify", "ask codex", "second
  opinion", or "consult codex".
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
_LAKE_SEEN=$([ -f ~/.gstack/.completeness-intro-seen ] && echo "yes" || echo "no")
echo "LAKE_INTRO: $_LAKE_SEEN"
_TEL=$(~/.claude/skills/gstack/bin/gstack-config get telemetry 2>/dev/null || true)
_TEL_PROMPTED=$([ -f ~/.gstack/.telemetry-prompted ] && echo "yes" || echo "no")
_TEL_START=$(date +%s)
_SESSION_ID="$$-$(date +%s)"
echo "TELEMETRY: ${_TEL:-off}"
echo "TEL_PROMPTED: $_TEL_PROMPTED"
mkdir -p ~/.gstack/analytics
echo '{"skill":"codex","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","repo":"'$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")'"}'  >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
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

# /codex — Multi-AI Second Opinion

You are running the `/codex` skill. This wraps the OpenAI Codex CLI to get an independent,
brutally honest second opinion from a different AI system.

Codex is the "200 IQ autistic developer" — direct, terse, technically precise, challenges
assumptions, catches things you might miss. Present its output faithfully, not summarized.

---

## Claude Code Trust Boundaries

The /codex skill exists because Claude Code has a documented failure mode of
making confident, plausible-sounding claims about third-party systems without
verifying them against documentation. On 2026-05-09 Claude recommended clicking
ShipStation's "Send Notifications" button as "the preferred path" for replaying
WooCommerce shipnotify webhooks. The button does not replay webhooks — it
re-sends ShipStation's own branded shipping confirmation emails. 814 customers
received duplicate emails for orders shipped weeks earlier. Source: button-label
inference, no doc verification.

When constructing any codex prompt — Review, Challenge, Consult, or Verify —
prepend the following SKEPTICISM PREAMBLE verbatim:

────────────────────────────────────────────────────────────────────
SKEPTICISM PREAMBLE — read first.

The artifact you are reviewing was authored or recommended by Claude Code, an
LLM with a documented history of confident-but-unverified claims about
third-party systems. Treat every claim about external systems with extreme
skepticism.

Specifically flag as P1:
1. ANY claim about a third-party UI button, API endpoint, plugin behavior,
   vendor configuration, or SaaS dashboard semantic that is NOT accompanied by
   a documentation URL. Claude inferring behavior from a label is NOT
   sufficient; demand a fetched-this-session doc URL.
2. ANY recommendation for a bulk action (>1 record) that does NOT specify a
   single-item test as a hard prerequisite. Format expected: "Test on <single
   record id> first. Watch for <observable signal>. Confirm <expected result>.
   Then proceed to bulk."
3. ANY assertion about external behavior using confidence-language without
   evidence: "should work", "the preferred path", "the cleanest approach",
   "typically does X", "I believe", "go ahead and click", "recommended". When
   these phrases appear with respect to an unverified third-party action, P1.
4. ANY change that touches files served at public URLs, renames directories,
   modifies URLs, or changes plugin/theme behavior in WordPress contexts
   without a database reference check (l1o_posts, l1o_postmeta, l1o_options).

Default verdict on disagreement: when codex's analysis contradicts Claude's
claim about an external system, codex's verdict wins unless the user produces
explicit evidence (a fetched doc URL or verified test result) supporting
Claude.
────────────────────────────────────────────────────────────────────

---

## Step 0: Check codex binary

```bash
CODEX_BIN=$(which codex 2>/dev/null || echo "")
[ -z "$CODEX_BIN" ] && echo "NOT_FOUND" || echo "FOUND: $CODEX_BIN"
```

If `NOT_FOUND`: stop and tell the user:
"Codex CLI not found. Install it: `npm install -g @openai/codex` or see https://github.com/openai/codex"

---

## Step 1: Detect mode

Parse the user's input to determine which mode to run:

1. `/codex review` or `/codex review <instructions>` — **Review mode** (Step 2A)
2. `/codex challenge` or `/codex challenge <focus>` — **Challenge mode** (Step 2B)
3. `/codex verify` or `/codex verify <pasted recommendation>` — **Verify mode** (Step 2D)
4. `/codex` with no arguments — **Auto-detect:**
   - Check for a diff (with fallback if origin isn't available):
     `git diff origin/<base> --stat 2>/dev/null | tail -1 || git diff <base> --stat 2>/dev/null | tail -1`
   - If a diff exists, use AskUserQuestion:
     ```
     Codex detected changes against the base branch. What should it do?
     A) Review the diff (code review with pass/fail gate)
     B) Challenge the diff (adversarial — try to break it)
     C) Verify a recommendation Claude gave me (paste it next)
     D) Something else — I'll provide a prompt
     ```
   - If no diff, check for plan files scoped to the current project:
     `ls -t ~/.claude/plans/*.md 2>/dev/null | xargs grep -l "$(basename $(pwd))" 2>/dev/null | head -1`
     If no project-scoped match, fall back to: `ls -t ~/.claude/plans/*.md 2>/dev/null | head -1`
     but warn the user: "Note: this plan may be from a different project."
   - If a plan file exists, offer to review it
   - Otherwise, ask: "Did you want to verify a recommendation Claude gave you, or ask Codex something else?"
5. `/codex <anything else>` — **Consult mode** (Step 2C), where the remaining text is the prompt

---

## Step 2A: Review Mode

Run Codex code review against the current branch diff, with the SKEPTICISM PREAMBLE prepended.

1. Create temp files:
```bash
TMPPROMPT=$(mktemp /tmp/codex-prompt-XXXXXX.txt)
TMPERR=$(mktemp /tmp/codex-err-XXXXXX.txt)
```

2. Write the assembled prompt (preamble + review body) to the temp file. Substitute
   `<base>` with the detected base branch before writing. Use a single-quoted heredoc
   since the SKEPTICISM PREAMBLE contains no shell variables that need expansion:
```bash
cat > "$TMPPROMPT" <<'EOF_PREAMBLE'
SKEPTICISM PREAMBLE — read first.

The artifact you are reviewing was authored or recommended by Claude Code, an
LLM with a documented history of confident-but-unverified claims about
third-party systems. Treat every claim about external systems with extreme
skepticism.

Specifically flag as P1:
1. ANY claim about a third-party UI button, API endpoint, plugin behavior,
   vendor configuration, or SaaS dashboard semantic that is NOT accompanied by
   a documentation URL. Claude inferring behavior from a label is NOT
   sufficient; demand a fetched-this-session doc URL.
2. ANY recommendation for a bulk action (>1 record) that does NOT specify a
   single-item test as a hard prerequisite. Format expected: "Test on <single
   record id> first. Watch for <observable signal>. Confirm <expected result>.
   Then proceed to bulk."
3. ANY assertion about external behavior using confidence-language without
   evidence: "should work", "the preferred path", "the cleanest approach",
   "typically does X", "I believe", "go ahead and click", "recommended". When
   these phrases appear with respect to an unverified third-party action, P1.
4. ANY change that touches files served at public URLs, renames directories,
   modifies URLs, or changes plugin/theme behavior in WordPress contexts
   without a database reference check (l1o_posts, l1o_postmeta, l1o_options).

Default verdict on disagreement: when codex's analysis contradicts Claude's
claim about an external system, codex's verdict wins unless the user produces
explicit evidence (a fetched doc URL or verified test result) supporting
Claude.

Now perform code review on the diff against the base branch. Apply P1/P2
markers per existing convention, plus the additions from the preamble above.
EOF_PREAMBLE
```

If the user provided custom instructions (e.g., `/codex review focus on security`),
append them after the body — they never replace the preamble:
```bash
printf '\n\nAdditional user focus: %s\n' "$USER_FOCUS" >> "$TMPPROMPT"
```

3. Run the review via stdin (5-minute timeout). `codex review` accepts `-` to read
   prompt from stdin:
```bash
codex review - --base <base> -c 'model_reasoning_effort="xhigh"' --enable web_search_cached 2>"$TMPERR" < "$TMPPROMPT"
```

4. Capture the output. Then parse cost from stderr:
```bash
grep "tokens used" "$TMPERR" 2>/dev/null || echo "tokens: unknown"
```

5. Determine gate verdict by checking the review output for critical findings.
   If the output contains `[P1]` — the gate is **FAIL**.
   If no `[P1]` markers are found (only `[P2]` or no findings) — the gate is **PASS**.

6. Present the output:

```
CODEX SAYS (code review):
════════════════════════════════════════════════════════════
<full codex output, verbatim — do not truncate or summarize>
════════════════════════════════════════════════════════════
GATE: PASS                    Tokens: 14,331 | Est. cost: ~$0.12
```

or

```
GATE: FAIL (N critical findings)
```

7. **Cross-model comparison:** If `/review` (Claude's own review) was already run
   earlier in this conversation, compare the two sets of findings:

```
CROSS-MODEL ANALYSIS:
  Both found: [findings that overlap between Claude and Codex]
  Only Codex found: [findings unique to Codex]
  Only Claude found: [findings unique to Claude's /review]
  Agreement rate: X% (N/M total unique findings overlap)

EXTERNAL-SYSTEM DISAGREEMENTS (if any):
  When Codex and Claude disagree on a claim about a third-party UI/API/plugin/
  vendor system, surface the disagreement with:
    "Codex contradicts Claude on <claim>. Codex cites: <doc URL>. Claude's
     reasoning was: <quote>."
  Per the SKEPTICISM PREAMBLE, the user should default to Codex's verdict
  unless they produce explicit contradicting evidence (a fetched doc URL or
  verified test result). This rule is stated once in the preamble; this
  section just makes the disagreement findable.
```

8. Persist the review result:
```bash
~/.claude/skills/gstack/bin/gstack-review-log '{"skill":"codex-review","timestamp":"TIMESTAMP","status":"STATUS","gate":"GATE","findings":N}'
```

Substitute: TIMESTAMP (ISO 8601), STATUS ("clean" if PASS, "issues_found" if FAIL),
GATE ("pass" or "fail"), findings (count of [P1] + [P2] markers).

9. Clean up temp files:
```bash
rm -f "$TMPPROMPT" "$TMPERR"
```

---

## Step 2B: Challenge (Adversarial) Mode

Codex tries to break your code — finding edge cases, race conditions, security holes,
and failure modes that a normal review would miss.

1. Create a temp file:
```bash
TMPPROMPT=$(mktemp /tmp/codex-prompt-XXXXXX.txt)
```

2. Write the assembled prompt (preamble + adversarial body) to the temp file.
   Substitute `<base>` with the actual detected base branch before writing.

   Default prompt (no focus):
```bash
cat > "$TMPPROMPT" <<'EOF_PREAMBLE'
SKEPTICISM PREAMBLE — read first.

The artifact you are reviewing was authored or recommended by Claude Code, an
LLM with a documented history of confident-but-unverified claims about
third-party systems. Treat every claim about external systems with extreme
skepticism.

Specifically flag as P1:
1. ANY claim about a third-party UI button, API endpoint, plugin behavior,
   vendor configuration, or SaaS dashboard semantic that is NOT accompanied by
   a documentation URL. Claude inferring behavior from a label is NOT
   sufficient; demand a fetched-this-session doc URL.
2. ANY recommendation for a bulk action (>1 record) that does NOT specify a
   single-item test as a hard prerequisite. Format expected: "Test on <single
   record id> first. Watch for <observable signal>. Confirm <expected result>.
   Then proceed to bulk."
3. ANY assertion about external behavior using confidence-language without
   evidence: "should work", "the preferred path", "the cleanest approach",
   "typically does X", "I believe", "go ahead and click", "recommended". When
   these phrases appear with respect to an unverified third-party action, P1.
4. ANY change that touches files served at public URLs, renames directories,
   modifies URLs, or changes plugin/theme behavior in WordPress contexts
   without a database reference check (l1o_posts, l1o_postmeta, l1o_options).

Default verdict on disagreement: when codex's analysis contradicts Claude's
claim about an external system, codex's verdict wins unless the user produces
explicit evidence (a fetched doc URL or verified test result) supporting
Claude.

Now: review the changes on this branch against the base branch. Run `git diff origin/<base>` to see the diff. Your job is to find ways this code will fail in production. Think like an attacker and a chaos engineer. Find edge cases, race conditions, security holes, resource leaks, failure modes, and silent data corruption paths. Be adversarial. Be thorough. No compliments — just the problems.
EOF_PREAMBLE
```

   With a user-specified focus (e.g., "security") — substitute `<FOCUS_AREA>` and
   `<base>` with their actual values before writing:
```bash
cat > "$TMPPROMPT" <<'EOF_PREAMBLE'
SKEPTICISM PREAMBLE — read first.

The artifact you are reviewing was authored or recommended by Claude Code, an
LLM with a documented history of confident-but-unverified claims about
third-party systems. Treat every claim about external systems with extreme
skepticism.

Specifically flag as P1:
1. ANY claim about a third-party UI button, API endpoint, plugin behavior,
   vendor configuration, or SaaS dashboard semantic that is NOT accompanied by
   a documentation URL. Claude inferring behavior from a label is NOT
   sufficient; demand a fetched-this-session doc URL.
2. ANY recommendation for a bulk action (>1 record) that does NOT specify a
   single-item test as a hard prerequisite. Format expected: "Test on <single
   record id> first. Watch for <observable signal>. Confirm <expected result>.
   Then proceed to bulk."
3. ANY assertion about external behavior using confidence-language without
   evidence: "should work", "the preferred path", "the cleanest approach",
   "typically does X", "I believe", "go ahead and click", "recommended". When
   these phrases appear with respect to an unverified third-party action, P1.
4. ANY change that touches files served at public URLs, renames directories,
   modifies URLs, or changes plugin/theme behavior in WordPress contexts
   without a database reference check (l1o_posts, l1o_postmeta, l1o_options).

Default verdict on disagreement: when codex's analysis contradicts Claude's
claim about an external system, codex's verdict wins unless the user produces
explicit evidence (a fetched doc URL or verified test result) supporting
Claude.

Now: review the changes on this branch against the base branch. Run `git diff origin/<base>` to see the diff. Focus specifically on <FOCUS_AREA>. Your job is to find every way an attacker could exploit this code. Think about injection vectors, auth bypasses, privilege escalation, data exposure, and timing attacks. Be adversarial.
EOF_PREAMBLE
```

3. Run codex exec with **JSONL output** via stdin (5-minute timeout). `codex exec`
   accepts `-` to read prompt from stdin:
```bash
codex exec - -s read-only -c 'model_reasoning_effort="xhigh"' --enable web_search_cached --json 2>/dev/null < "$TMPPROMPT" | python3 -c "
import sys, json
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try:
        obj = json.loads(line)
        t = obj.get('type','')
        if t == 'item.completed' and 'item' in obj:
            item = obj['item']
            itype = item.get('type','')
            text = item.get('text','')
            if itype == 'reasoning' and text:
                print(f'[codex thinking] {text}')
                print()
            elif itype == 'agent_message' and text:
                print(text)
            elif itype == 'command_execution':
                cmd = item.get('command','')
                if cmd: print(f'[codex ran] {cmd}')
        elif t == 'turn.completed':
            usage = obj.get('usage',{})
            tokens = usage.get('input_tokens',0) + usage.get('output_tokens',0)
            if tokens: print(f'\ntokens used: {tokens}')
    except: pass
"
```

This parses codex's JSONL events to extract reasoning traces, tool calls, and the final
response. The `[codex thinking]` lines show what codex reasoned through before its answer.

4. Clean up:
```bash
rm -f "$TMPPROMPT"
```

5. Present the full streamed output:

```
CODEX SAYS (adversarial challenge):
════════════════════════════════════════════════════════════
<full output from above, verbatim>
════════════════════════════════════════════════════════════
Tokens: N | Est. cost: ~$X.XX
```

---

## Step 2C: Consult Mode

Ask Codex anything about the codebase. Supports session continuity for follow-ups.

1. **Check for existing session:**
```bash
cat .context/codex-session-id 2>/dev/null || echo "NO_SESSION"
```

If a session file exists (not `NO_SESSION`), use AskUserQuestion:
```
You have an active Codex conversation from earlier. Continue it or start fresh?
A) Continue the conversation (Codex remembers the prior context)
B) Start a new conversation
```

2. Create temp files:
```bash
TMPPROMPT=$(mktemp /tmp/codex-prompt-XXXXXX.txt)
TMPRESP=$(mktemp /tmp/codex-resp-XXXXXX.txt)
TMPERR=$(mktemp /tmp/codex-err-XXXXXX.txt)
```

3. **Plan review auto-detection:** If the user's prompt is about reviewing a plan,
or if plan files exist and the user said `/codex` with no arguments:
```bash
ls -t ~/.claude/plans/*.md 2>/dev/null | xargs grep -l "$(basename $(pwd))" 2>/dev/null | head -1
```
If no project-scoped match, fall back to `ls -t ~/.claude/plans/*.md 2>/dev/null | head -1`
but warn: "Note: this plan may be from a different project — verify before sending to Codex."

4. Assemble the prompt with the SKEPTICISM PREAMBLE prepended and write to the temp file.

   For **plan review**, read the plan content and include it in the prompt:
```bash
cat > "$TMPPROMPT" <<'EOF_PREAMBLE'
SKEPTICISM PREAMBLE — read first.

The artifact you are reviewing was authored or recommended by Claude Code, an
LLM with a documented history of confident-but-unverified claims about
third-party systems. Treat every claim about external systems with extreme
skepticism.

Specifically flag as P1:
1. ANY claim about a third-party UI button, API endpoint, plugin behavior,
   vendor configuration, or SaaS dashboard semantic that is NOT accompanied by
   a documentation URL. Claude inferring behavior from a label is NOT
   sufficient; demand a fetched-this-session doc URL.
2. ANY recommendation for a bulk action (>1 record) that does NOT specify a
   single-item test as a hard prerequisite. Format expected: "Test on <single
   record id> first. Watch for <observable signal>. Confirm <expected result>.
   Then proceed to bulk."
3. ANY assertion about external behavior using confidence-language without
   evidence: "should work", "the preferred path", "the cleanest approach",
   "typically does X", "I believe", "go ahead and click", "recommended". When
   these phrases appear with respect to an unverified third-party action, P1.
4. ANY change that touches files served at public URLs, renames directories,
   modifies URLs, or changes plugin/theme behavior in WordPress contexts
   without a database reference check (l1o_posts, l1o_postmeta, l1o_options).

Default verdict on disagreement: when codex's analysis contradicts Claude's
claim about an external system, codex's verdict wins unless the user produces
explicit evidence (a fetched doc URL or verified test result) supporting
Claude.

You are a brutally honest technical reviewer. Review this plan for: logical gaps and
unstated assumptions, missing error handling or edge cases, overcomplexity (is there a
simpler approach?), feasibility risks (what could go wrong?), and missing dependencies
or sequencing issues. Be direct. Be terse. No compliments. Just the problems.

THE PLAN:
<plan content>
EOF_PREAMBLE
```

   For **general consult**, write the preamble then append the user's prompt:
```bash
cat > "$TMPPROMPT" <<'EOF_PREAMBLE'
SKEPTICISM PREAMBLE — read first.

The artifact you are reviewing was authored or recommended by Claude Code, an
LLM with a documented history of confident-but-unverified claims about
third-party systems. Treat every claim about external systems with extreme
skepticism.

Specifically flag as P1:
1. ANY claim about a third-party UI button, API endpoint, plugin behavior,
   vendor configuration, or SaaS dashboard semantic that is NOT accompanied by
   a documentation URL. Claude inferring behavior from a label is NOT
   sufficient; demand a fetched-this-session doc URL.
2. ANY recommendation for a bulk action (>1 record) that does NOT specify a
   single-item test as a hard prerequisite. Format expected: "Test on <single
   record id> first. Watch for <observable signal>. Confirm <expected result>.
   Then proceed to bulk."
3. ANY assertion about external behavior using confidence-language without
   evidence: "should work", "the preferred path", "the cleanest approach",
   "typically does X", "I believe", "go ahead and click", "recommended". When
   these phrases appear with respect to an unverified third-party action, P1.
4. ANY change that touches files served at public URLs, renames directories,
   modifies URLs, or changes plugin/theme behavior in WordPress contexts
   without a database reference check (l1o_posts, l1o_postmeta, l1o_options).

Default verdict on disagreement: when codex's analysis contradicts Claude's
claim about an external system, codex's verdict wins unless the user produces
explicit evidence (a fetched doc URL or verified test result) supporting
Claude.
EOF_PREAMBLE
printf '\n\n%s\n' "$USER_PROMPT" >> "$TMPPROMPT"
```

5. Run codex exec with **JSONL output** via stdin (5-minute timeout):

For a **new session:**
```bash
codex exec - -s read-only -c 'model_reasoning_effort="xhigh"' --enable web_search_cached --json 2>"$TMPERR" < "$TMPPROMPT" | python3 -c "
import sys, json
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try:
        obj = json.loads(line)
        t = obj.get('type','')
        if t == 'thread.started':
            tid = obj.get('thread_id','')
            if tid: print(f'SESSION_ID:{tid}')
        elif t == 'item.completed' and 'item' in obj:
            item = obj['item']
            itype = item.get('type','')
            text = item.get('text','')
            if itype == 'reasoning' and text:
                print(f'[codex thinking] {text}')
                print()
            elif itype == 'agent_message' and text:
                print(text)
            elif itype == 'command_execution':
                cmd = item.get('command','')
                if cmd: print(f'[codex ran] {cmd}')
        elif t == 'turn.completed':
            usage = obj.get('usage',{})
            tokens = usage.get('input_tokens',0) + usage.get('output_tokens',0)
            if tokens: print(f'\ntokens used: {tokens}')
    except: pass
"
```

For a **resumed session** (user chose "Continue"):
```bash
codex exec resume <session-id> - -s read-only -c 'model_reasoning_effort="xhigh"' --enable web_search_cached --json 2>"$TMPERR" < "$TMPPROMPT" | python3 -c "
<same python streaming parser as above>
"
```

6. Capture session ID from the streamed output. The parser prints `SESSION_ID:<id>`
   from the `thread.started` event. Save it for follow-ups:
```bash
mkdir -p .context
```
Save the session ID printed by the parser (the line starting with `SESSION_ID:`)
to `.context/codex-session-id`.

7. Present the full streamed output:

```
CODEX SAYS (consult):
════════════════════════════════════════════════════════════
<full output, verbatim — includes [codex thinking] traces>
════════════════════════════════════════════════════════════
Tokens: N | Est. cost: ~$X.XX
Session saved — run /codex again to continue this conversation.
```

8. After presenting, note any points where Codex's analysis differs from your own
   understanding. If there is a disagreement, flag it:
   "Note: Claude Code disagrees on X because Y."

9. Clean up:
```bash
rm -f "$TMPPROMPT" "$TMPRESP" "$TMPERR"
```

---

## Step 2D: Verify Mode

The user pastes a recommendation Claude gave them. Codex independently verifies
each factual claim about external systems against documentation.

1. **Get the payload.** If the user invoked `/codex verify` with no payload,
   emit a literal text prompt: "Paste the recommendation you want verified.
   When you're done, send it. (No length limit — write to a file if it's
   very long.)" Then wait for the next user message. Do NOT use
   AskUserQuestion here — it's wrong for free-text paste of unbounded length.
   The next user message becomes `$RECOMMENDATION_TEXT`.

2. **Empty-payload guard.** If `$RECOMMENDATION_TEXT` after trimming is empty,
   short-circuit:
```bash
echo "$RECOMMENDATION_TEXT" | tr -d '[:space:]'
```
   Output: `GATE: PASS — no recommendation provided, nothing to verify.`
   Skip the Codex call entirely. Do NOT attempt to detect "no external-system
   claims" in non-empty payloads — let Codex decide. The cost of one Codex call
   on genuinely trivial input is acceptable; misclassifying a real claim as
   "doesn't need checking" is exactly the failure mode this mode defends against.

3. **Build the prompt via tempfile** (avoids shell escaping, EOF-collision, and
   Windows command-line length limits):
```bash
TMPPROMPT=$(mktemp /tmp/codex-verify-prompt-XXXXXX.txt)
TMPRECOMMEND=$(mktemp /tmp/codex-verify-rec-XXXXXX.txt)
TMPERR=$(mktemp /tmp/codex-verify-err-XXXXXX.txt)

# Write the user's pasted recommendation raw — no shell expansion.
printf '%s' "$RECOMMENDATION_TEXT" > "$TMPRECOMMEND"

# Build the verify prompt. Single-quoted heredoc — no $ expansion.
cat > "$TMPPROMPT" <<'EOF_VERIFY_PROMPT'
SKEPTICISM PREAMBLE — read first.

The artifact you are reviewing was authored or recommended by Claude Code, an
LLM with a documented history of confident-but-unverified claims about
third-party systems. Treat every claim about external systems with extreme
skepticism.

Specifically flag as P1:
1. ANY claim about a third-party UI button, API endpoint, plugin behavior,
   vendor configuration, or SaaS dashboard semantic that is NOT accompanied by
   a documentation URL. Claude inferring behavior from a label is NOT
   sufficient; demand a fetched-this-session doc URL.
2. ANY recommendation for a bulk action (>1 record) that does NOT specify a
   single-item test as a hard prerequisite. Format expected: "Test on <single
   record id> first. Watch for <observable signal>. Confirm <expected result>.
   Then proceed to bulk."
3. ANY assertion about external behavior using confidence-language without
   evidence: "should work", "the preferred path", "the cleanest approach",
   "typically does X", "I believe", "go ahead and click", "recommended". When
   these phrases appear with respect to an unverified third-party action, P1.
4. ANY change that touches files served at public URLs, renames directories,
   modifies URLs, or changes plugin/theme behavior in WordPress contexts
   without a database reference check (l1o_posts, l1o_postmeta, l1o_options).

Default verdict on disagreement: when codex's analysis contradicts Claude's
claim about an external system, codex's verdict wins unless the user produces
explicit evidence (a fetched doc URL or verified test result) supporting
Claude.

The file at the path provided below contains a recommendation generated by
Claude Code (an LLM). The user is considering acting on it. Your job is
independent verification.

Begin by reading the recommendation: use your file-read or shell tool to
`cat` the file at the path listed at the end of this prompt.

For every factual claim in the recommendation that touches an external
system (third-party UI button, API endpoint, plugin behavior, vendor
configuration, SaaS dashboard semantic, button label meaning, webhook
behavior, payment gateway behavior, email send behavior), produce one
verification entry in this exact format:

  CLAIM: <quote the specific claim>
  CITATION: <fetched documentation URL, or DOC_NOT_FOUND>
  VERDICT: <VERIFIED | UNVERIFIED | WRONG | DOC_NOT_FOUND>
  REASONING: <one sentence on why this verdict>
  P1: <YES if VERDICT is UNVERIFIED, WRONG, or DOC_NOT_FOUND AND the action
   would affect live customers, orders, payments, or data; otherwise NO>

After listing all verification entries, output exactly one GATE line:
  GATE: PASS  — only if every claim is VERIFIED with a non-DOC_NOT_FOUND citation.
  GATE: FAIL — N P1 findings.

Hard rule: PASS-by-omission is not allowed. If you found no claims to
check, output `GATE: PASS — no external-system claims found.` instead.

RECOMMENDATION FILE PATH:
EOF_VERIFY_PROMPT

# Append the file path outside the heredoc — so it expands correctly and
# a future EOF_VERIFY_PROMPT in user content can't break the heredoc.
printf '%s\n' "$TMPRECOMMEND" >> "$TMPPROMPT"
```

4. **Run codex exec via stdin** (5-minute timeout):
```bash
codex exec - -s read-only -c 'model_reasoning_effort="xhigh"' --enable web_search_cached --json 2>"$TMPERR" < "$TMPPROMPT" | python3 -c "
import sys, json
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try:
        obj = json.loads(line)
        t = obj.get('type','')
        if t == 'item.completed' and 'item' in obj:
            item = obj['item']
            itype = item.get('type','')
            text = item.get('text','')
            if itype == 'reasoning' and text:
                print(f'[codex thinking] {text}')
                print()
            elif itype == 'agent_message' and text:
                print(text)
            elif itype == 'command_execution':
                cmd = item.get('command','')
                if cmd: print(f'[codex ran] {cmd}')
        elif t == 'turn.completed':
            usage = obj.get('usage',{})
            tokens = usage.get('input_tokens',0) + usage.get('output_tokens',0)
            if tokens: print(f'\ntokens used: {tokens}')
    except: pass
"
```

5. **Parse the GATE line and present output:**

```
CODEX SAYS (verify):
════════════════════════════════════════════════════════════
<full output, verbatim — includes [codex thinking] traces and all CLAIM/
 CITATION/VERDICT/REASONING/P1 entries>
════════════════════════════════════════════════════════════
GATE: FAIL — N P1 findings. DO NOT ACT ON THE RECOMMENDATION AS WRITTEN.
Tokens: N | Est. cost: ~$X.XX
```

or:

```
GATE: PASS — all external-system claims verified with citations.
```

6. **Persist the verify result:**
```bash
~/.claude/skills/gstack/bin/gstack-review-log '{"skill":"codex-verify","timestamp":"TIMESTAMP","status":"STATUS","gate":"GATE","findings":N}'
```

Substitute: TIMESTAMP (ISO 8601), STATUS ("clean" if PASS, "issues_found" if FAIL),
GATE ("pass" or "fail"), findings (count of P1 entries).

7. **Clean up:**
```bash
rm -f "$TMPPROMPT" "$TMPRECOMMEND" "$TMPERR"
```

8. **No session continuity for verify.** Unlike Step 2C (Consult), verify is
   one-shot. If a follow-up verify is needed for a related claim, the user
   re-invokes `/codex verify` with new payload.

---

## Model & Reasoning

**Model:** No model is hardcoded — codex uses whatever its current default is (the frontier
agentic coding model). This means as OpenAI ships newer models, /codex automatically
uses them. If the user wants a specific model, pass `-m` through to codex.

**Reasoning effort:** All modes use `xhigh` — maximum reasoning power. When reviewing code, breaking code, or consulting on architecture, you want the model thinking as hard as possible.

**Web search:** All codex commands use `--enable web_search_cached` so Codex can look up
docs and APIs during review. This is OpenAI's cached index — fast, no extra cost.

If the user specifies a model (e.g., `/codex review -m gpt-5.1-codex-max`
or `/codex challenge -m gpt-5.2`), pass the `-m` flag through to codex.

---

## Cost Estimation

Parse token count from stderr. Codex prints `tokens used\nN` to stderr.

Display as: `Tokens: N`

If token count is not available, display: `Tokens: unknown`

---

## Error Handling

- **Binary not found:** Detected in Step 0. Stop with install instructions.
- **Auth error:** Codex prints an auth error to stderr. Surface the error:
  "Codex authentication failed. Run `codex login` in your terminal to authenticate via ChatGPT."
- **Timeout:** If the Bash call times out (5 min), tell the user:
  "Codex timed out after 5 minutes. The diff may be too large or the API may be slow. Try again or use a smaller scope."
- **Empty response:** If `$TMPRESP` is empty or doesn't exist, tell the user:
  "Codex returned no response. Check stderr for errors."
- **Session resume failure:** If resume fails, delete the session file and start fresh.

---

## Important Rules

- **Never modify files.** This skill is read-only. Codex runs in read-only sandbox mode.
- **Present output verbatim.** Do not truncate, summarize, or editorialize Codex's output
  before showing it. Show it in full inside the CODEX SAYS block.
- **Add synthesis after, not instead of.** Any Claude commentary comes after the full output.
- **5-minute timeout** on all Bash calls to codex (`timeout: 300000`).
- **No double-reviewing.** If the user already ran `/review`, Codex provides a second
  independent opinion. Do not re-run Claude Code's own review.
- **Skepticism preamble is mandatory.** Every codex prompt — Review, Challenge,
  Consult, Verify — must prepend the SKEPTICISM PREAMBLE block from the
  "Claude Code Trust Boundaries" section. No exceptions.
