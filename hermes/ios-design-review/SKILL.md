---
name: ios-design-review
description: Use when visual design audit for ios apps on real hardware. (Ported from gstack to Hermes)
version: 1.0.0
author: gstack (port: Hermes Agent)
license: MIT
metadata:
  hermes:
    tags: [gstack, ported, workflow]
    related_skills: [hermes-agent, hermes-agent-skill-authoring]
    upstream: https://github.com/garrytan/gstack/blob/main/ios-design-review/SKILL.md
---
## When to Use

Connects to a real
iPhone via the same StateServer as /ios-qa, screenshots every screen,
evaluates against Apple HIG, DESIGN.md, and design best practices. Scores
each dimension 0-10 with "what would make it a 10" framing — mirrors
/plan-design-review for browser. For plan-stage design review (before
implementation), use /plan-design-review. For live web visual audits, use
/design-review.
Use when asked to "review the iOS design", "audit the iPhone app's
visuals", or "design QA the iOS app".

Voice triggers (speech-to-text aliases): "review the iOS design", "audit the iPhone app's visuals", "design QA the iPhone app".

## Preamble

_Replaces the gstack `gstack-skill-start` preamble. In Hermes, use `session_search` to recover prior context, then proceed._

## Decision-Brief Format

_Adapted from gstack's Claude Code AskUserQuestion spec. Hermes has a native `clarify` tool with `choices` (max 4) and an open-ended mode. Use `clarify` directly for binary/up-to-4-option decisions; use prose for everything else._

## Artifacts Sync

_Replaces gstack artifacts sync. In Hermes, `session_search` handles cross-session context recovery automatically._

## Model-Specific Behavioral Patch (claude)

The following nudges are tuned for the claude model family. They are
**subordinate** to skill workflow, STOP points, AskUserQuestion gates, plan-mode
safety, and /ship review gates. If a nudge below conflicts with skill instructions,
the skill wins. Treat these as preferences, not rules.

**Todo-list discipline.** When working through a multi-step plan, mark each task
complete individually as you finish it. Do not batch-complete at the end. If a task
turns out to be unnecessary, mark it skipped with a one-line reason.

**Think before heavy actions.** For complex operations (refactors, migrations,
non-trivial new features), briefly state your approach before executing. This lets
the user course-correct cheaply instead of mid-flight.

**Dedicated tools over Bash.** Prefer Read, Edit, Write, Glob, Grep over shell
equivalents (cat, sed, find, grep). The dedicated tools are cheaper and clearer.

## Voice

GStack voice: Garry-shaped product and engineering judgment, compressed for runtime.

- Lead with the point. Say what it does, why it matters, and what changes for the builder.
- Be concrete. Name files, functions, line numbers, commands, outputs, evals, and real numbers.
- Tie technical choices to user outcomes: what the real user sees, loses, waits for, or can now do.
- Be direct about quality. Bugs matter. Edge cases matter. Fix the whole thing, not the demo path.
- Sound like a builder talking to a builder, not a consultant presenting to a client.
- Never corporate, academic, PR, or hype. Avoid filler, throat-clearing, generic optimism, and founder cosplay.
- No em dashes. No AI vocabulary: delve, crucial, robust, comprehensive, nuanced, multifaceted, furthermore, moreover, additionally, pivotal, landscape, tapestry, underscore, foster, showcase, intricate, vibrant, fundamental, significant.
- The user has context you do not: domain knowledge, timing, relationships, taste. Cross-model agreement is a recommendation, not a decision. The user decides.

Good: "auth.ts:47 returns undefined when the session cookie expires. Users hit a white screen. Fix: add a null check and redirect to /login. Two lines."
Bad: "I've identified a potential issue in the authentication flow that may cause problems under certain conditions."

## Context Recovery

At session start or after compaction, recover recent project context.

```bash
eval "$(~/.hermes/skills/gstack/# session_search tool 2>/dev/null)"
_PROJ="${GSTACK_HOME:-$HOME/.gstack}/projects/${SLUG:-unknown}"
if [ -d "$_PROJ" ]; then
  echo "--- RECENT ARTIFACTS ---"
  find "$_PROJ/ceo-plans" "$_PROJ/checkpoints" -type f -name "*.md" 2>/dev/null | xargs -r ls -t 2>/dev/null | head -3
  [ -f "$_PROJ/${BRANCH:-unknown}-reviews.jsonl" ] && echo "REVIEWS: $(wc -l < "$_PROJ/${BRANCH:-unknown}-reviews.jsonl" | tr -d ' ') entries"
  [ -f "$_PROJ/timeline.jsonl" ] && tail -5 "$_PROJ/timeline.jsonl"
  if [ -f "$_PROJ/timeline.jsonl" ]; then
    _LAST=$(grep "\"branch\":\"${_BRANCH}\"" "$_PROJ/timeline.jsonl" 2>/dev/null | grep '"event":"completed"' | tail -1)
    [ -n "$_LAST" ] && echo "LAST_SESSION: $_LAST"
    _RECENT_SKILLS=$(grep "\"branch\":\"${_BRANCH}\"" "$_PROJ/timeline.jsonl" 2>/dev/null | grep '"event":"completed"' | tail -3 | grep -o '"skill":"[^"]*"' | sed 's/"skill":"//;s/"//' | tr '\n' ',')
    [ -n "$_RECENT_SKILLS" ] && echo "RECENT_PATTERN: $_RECENT_SKILLS"
  fi
  _LATEST_CP=$(find "$_PROJ/checkpoints" -name "*.md" -type f 2>/dev/null | xargs -r ls -t 2>/dev/null | head -1)
  [ -n "$_LATEST_CP" ] && echo "LATEST_CHECKPOINT: $_LATEST_CP"
  if [ -f "$_PROJ/decisions.active.json" ]; then
    echo "--- ACTIVE DECISIONS (recent, scope-relevant) ---"
    ~/.hermes/skills/gstack/# session_search tool --recent 5 2>/dev/null
    echo "--- END DECISIONS ---"
  fi
  echo "--- END ARTIFACTS ---"
fi
```

If artifacts are listed, read the newest useful one. If `LAST_SESSION` or `LATEST_CHECKPOINT` appears, give a 2-sentence welcome back summary. If `RECENT_PATTERN` clearly implies a next skill, suggest it once.

**Cross-session decisions.** If `ACTIVE DECISIONS` are listed, treat them as prior settled calls with their rationale — do not silently re-litigate them; if you're about to reverse one, say so explicitly. Reach for `~/.hermes/skills/gstack/# session_search tool` whenever a question touches a past decision ("what did we decide / why / did we try"). When you or the user make a DURABLE decision (architecture, scope, tool/vendor choice, or a reversal) — NOT a turn-level or trivial choice — log it with `~/.hermes/skills/gstack/# memory tool` (`--supersede <id>` for a reversal). Reliable and local; gbrain not required.

## Writing Style (skip entirely if `EXPLAIN_LEVEL: terse` appears in the preamble echo OR the user's current message explicitly requests terse / no-explanations output)

Applies to AskUserQuestion, user replies, and findings. AskUserQuestion Format is structure; this is prose quality.

- Gloss curated jargon on first use per skill invocation, even if the user pasted the term.
- Frame questions in outcome terms: what pain is avoided, what capability unlocks, what user experience changes.
- Use short sentences, concrete nouns, active voice.
- Close decisions with user impact: what the user sees, waits for, loses, or gains.
- User-turn override wins: if the current message asks for terse / no explanations / just the answer, skip this section.
- Terse mode (EXPLAIN_LEVEL: terse): no glosses, no outcome-framing layer, shorter responses.

Curated jargon list lives at `~/.hermes/skills/gstack/scripts/jargon-list.json` (80+ terms). On the first jargon term you encounter this session, Read that file once; treat the `terms` array as the canonical list. The list is repo-owned and may grow between releases.


## Completeness Principle — Boil the Ocean

AI makes completeness cheap, so the complete thing is the goal. Recommend full coverage (tests, edge cases, error paths) — boil the ocean one lake at a time. The only thing out of scope is genuinely unrelated work (rewrites, multi-quarter migrations); flag that as separate scope, never as an excuse for a shortcut.

When options differ in coverage, include `Completeness: X/10` (10 = all edge cases, 7 = happy path, 3 = shortcut). When options differ in kind, write: `Note: options differ in kind, not coverage — no completeness score.` Do not fabricate scores.

## Confusion Protocol

For high-stakes ambiguity (architecture, data model, destructive scope, missing context), STOP. Name it in one sentence, present 2-3 options with tradeoffs, and ask. Do not use for routine coding or obvious changes.

## Claimed Limitations Need Evidence

A claimed limitation or requirement ("the API can't do this", "X requires a credential", "that's impossible on this platform") is a material claim. State one only with the verbatim error, the documented statement, or a live probe in hand — pattern-matching a failure to a familiar story is not evidence. When a cheap probe settles the question, run it BEFORE asking the user anything or declaring a step blocked.

## Completion Status Protocol

When completing a skill workflow, report status using one of:
- **DONE** — completed with evidence.
- **DONE_WITH_CONCERNS** — completed, but list concerns.
- **BLOCKED** — cannot proceed; state blocker and what was tried.
- **NEEDS_CONTEXT** — missing info; state exactly what is needed.

Escalate after 3 failed attempts, uncertain security-sensitive changes, or scope you cannot verify. Format: `STATUS`, `REASON`, `ATTEMPTED`, `RECOMMENDATION`.

## Operational Self-Improvement

_Replaces gstack `gstack-learnings-log`. In Hermes, durable learnings are saved via the `memory` tool, and reusable workflows become `skill_manage` entries._

## Telemetry

_Replaces `gstack-skill-end`. In Hermes, log durable facts to `memory` and continue. The Hermes gateway handles cross-session metrics._

## Connection

Uses the running `gstack-ios-qa-daemon`. If no daemon is running, spawn one
via the same flow as `/ios-qa` (Phase 0-2). Read-only by default — no
mutating calls.

## Dimensions + scoring

For each screen in the app, score 0-10 and explain what would push it to 10:

1. **Typography hierarchy.** Display vs body vs caption sizes consistent
   with Apple HIG. SF Pro at correct dynamic-type scale. Line-height matches
   font size. No 12pt body anywhere.
2. **Spacing rhythm.** 4pt or 8pt grid used consistently. No magic
   17/23/31pt paddings. Safe-area insets respected.
3. **Color hierarchy.** Primary action highest contrast; secondary muted;
   destructive distinct. Dark mode renders correctly. Contrast ratios meet
   WCAG AA for body text (4.5:1) and large text (3:1).
4. **Touch targets.** Every interactive element >= 44x44pt. No "tappable
   text" smaller than 24pt.
5. **Loading + empty + error states.** Each present and intentional. No
   blank screens during async work. Empty states explain what to do next.
6. **Accessibility.** VoiceOver labels on every interactive element.
   Dynamic Type cap at XXL doesn't break layouts. Reduce Motion respected.
   Color-blindness palette tested (deuteranopia is most common).
7. **Animation discipline.** No more than 2 simultaneous animations.
   Duration 200-300ms for UI feedback. Spring damping correct (not bouncy
   for serious flows).
8. **iOS idiom alignment.** Uses native components (`NavigationStack`,
   `List`, `Form`, system sheets) where appropriate. No re-invented
   navigation. No web-style hamburger menus on phone.
9. **Information density.** Per-screen content fits without horizontal
   scroll. Long screens have section anchors. Lists use real iOS list
   patterns (swipe-to-delete, contextual menus).
10. **AI-slop check.** Generic stock layouts, "lorem ipsum" data left in,
    cargo-cult Material Design imported from Android, gradients that smell
    AI-generated.

## Loop

1. `POST /session/acquire` with capability `observe` (read-only).
2. For each major screen (driven from a screen list the user provides, or
   auto-discovered via the accessibility tree):
   - `GET /screenshot`
   - `GET /elements`
   - Apply the 10-dimension rubric.
   - Record findings.
3. Produce a markdown report with screenshots, scores per screen, and a
   "biggest leverage fix" suggestion per dimension.
4. Use AskUserQuestion for any score < 7 — present the issue with
   recommended fix + tradeoff so the user can decide whether to address.

## Output

Write a markdown report to
`~/.hermes/gstack/projects/<slug>/ios-design-review-<date>.md`. Include the
screenshots inline. The CEO/eng review skills can reference this report
when planning UI changes.

## Failure modes

| Symptom | Action |
|---|---|
| `403 capability_insufficient` from /screenshot | Daemon is in tailnet mode and token is below `observe` tier — owner must mint with `--capability observe` |
| Screenshot is black/blank | App may be in foreground but not rendering; AskUserQuestion to confirm the app is in the expected state |
| 10 screens, but ground-truth screen list said 12 | AskUserQuestion: were 2 hidden behind state we haven't triggered? |
