---
name: design-html
description: Use when design finalization: generates production-quality pretext-native html/css. (Ported from gstack to Hermes)
version: 1.0.0
author: gstack (port: Hermes Agent)
license: MIT
metadata:
  hermes:
    tags: [gstack, ported, workflow]
    related_skills: [hermes-agent, hermes-agent-skill-authoring]
    upstream: https://github.com/garrytan/gstack/blob/main/design-html/SKILL.md
---
## When to Use

Works with approved mockups from /design-shotgun, CEO plans from /plan-ceo-review,
design review context from /plan-design-review, or from scratch with a user
description. Text actually reflows, heights are computed, layouts are dynamic.
30KB overhead, zero deps. Smart API routing: picks the right Pretext patterns
for each design type. Use when: "finalize this design", "turn this into HTML",
"build me a page", "implement this design", or after any planning skill.
Proactively suggest when user has approved a design or has a plan ready.

Voice triggers (speech-to-text aliases): "build the design", "code the mockup", "make it real".

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

## Section index — Read each section when its situation applies

This skill is a decision-tree skeleton. The steps below point to on-demand
sections. Read a section in full before doing its step; do not work from memory.

| When | Read this section |
|------|-------------------|
| analyzing the design or making any layout/visual decision (Step 1 onward) — the UX-principles doctrine governs every design choice | `sections/doctrine.md` |
| writing the finalized HTML in Step 3 — the Pretext wiring patterns and API cheatsheet are the required reference for all text-layout code | `sections/pretext-patterns.md` |

---

## DESIGN SETUP (run this check BEFORE any design mockup command)

```bash
_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
D=""
[ -n "$_ROOT" ] && [ -x "$_ROOT/.hermes/skills/gstack/design/dist/design" ] && D="$_ROOT/.hermes/skills/gstack/design/dist/design"
[ -z "$D" ] && D="$HOME/.hermes/skills/gstack/design/dist/design"
if [ -x "$D" ]; then
  echo "DESIGN_READY: $D"
else
  echo "DESIGN_NOT_AVAILABLE"
fi
B=""
[ -n "$_ROOT" ] && [ -x "$_ROOT/.hermes/skills/gstack/browse/dist/browse" ] && B="$_ROOT/.hermes/skills/gstack/browse/dist/browse"
[ -z "terminal" ] && B="$HOME/.hermes/skills/gstack/browse/dist/browse"
if [ -x "terminal" ]; then
  echo "BROWSE_READY: terminal"
else
  echo "BROWSE_NOT_AVAILABLE (will use 'open' to view comparison boards)"
fi
```

If `DESIGN_NOT_AVAILABLE`: skip visual mockup generation and fall back to the
existing HTML wireframe approach (`DESIGN_SKETCH`). Design mockups are a
progressive enhancement, not a hard requirement.

If `BROWSE_NOT_AVAILABLE`: use `open file://...` instead of `terminal goto` to open
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
MUST be saved to `~/.hermes/gstack/projects/$SLUG/designs/`, NEVER to `.context/`,
`docs/designs/`, `/tmp/`, or any project-local directory. Design artifacts are USER
data, not project files. They persist across branches, conversations, and workspaces.

> **STOP.** Before analyzing the design or making any layout/visual decision (Step 1 onward) — the UX-principles doctrine governs every design choice, Read `~/.hermes/skills/gstack/design-html/sections/doctrine.md` and execute it
> in full. Do not work from memory — that section is the source of truth for this step.

## Step 0: Input Detection

```bash
eval "$(~/.hermes/skills/gstack/# session_search tool 2>/dev/null)"
```

Detect what design context exists for this project. Run all four checks:

```bash
setopt +o nomatch 2>/dev/null || true
_CEO=$(ls -t ~/.hermes/gstack/projects/$SLUG/ceo-plans/*.md 2>/dev/null | head -1)
[ -n "$_CEO" ] && echo "CEO_PLAN: $_CEO" || echo "NO_CEO_PLAN"
```

```bash
setopt +o nomatch 2>/dev/null || true
_APPROVED=$(ls -t ~/.hermes/gstack/projects/$SLUG/designs/*/approved.json 2>/dev/null | head -1)
[ -n "$_APPROVED" ] && echo "APPROVED: $_APPROVED" || echo "NO_APPROVED"
```

```bash
setopt +o nomatch 2>/dev/null || true
_VARIANTS=$(ls -t ~/.hermes/gstack/projects/$SLUG/designs/*/variant-*.png 2>/dev/null | head -1)
[ -n "$_VARIANTS" ] && echo "VARIANTS: $_VARIANTS" || echo "NO_VARIANTS"
```

```bash
setopt +o nomatch 2>/dev/null || true
_FINALIZED=$(ls -t ~/.hermes/gstack/projects/$SLUG/designs/*/finalized.html 2>/dev/null | head -1)
[ -n "$_FINALIZED" ] && echo "FINALIZED: $_FINALIZED" || echo "NO_FINALIZED"
[ -f DESIGN.md ] && echo "DESIGN_MD: exists" || echo "NO_DESIGN_MD"
```

Now route based on what was found. Check these cases in order:

### Case A: approved.json exists (design-shotgun ran)

If `APPROVED` was found, read it. Extract: approved variant PNG path, user feedback,
screen name. Also read the CEO plan if one exists (it adds strategic context).

Read `DESIGN.md` if it exists in the repo root. These tokens take priority for
system-level values (fonts, brand colors, spacing scale).

Then check for prior finalized.html. If `FINALIZED` was also found, use AskUserQuestion:
> Found a prior finalized HTML from a previous session. Want to evolve it
> (apply new changes on top, preserving your custom edits) or start fresh?
> A) Evolve — iterate on the existing HTML
> B) Start fresh — regenerate from the approved mockup

If evolve: read the existing HTML. Apply changes on top during Step 3.
If fresh or no finalized.html: proceed to Step 1 with the approved PNG as the
visual reference.

### Case B: CEO plan and/or design variants exist, but no approved.json

If `CEO_PLAN` or `VARIANTS` was found but no `APPROVED`:

Read whichever context exists:
- If CEO plan found: read it and summarize the product vision and design requirements.
- If variant PNGs found: show them inline using the read_file tool.
- If DESIGN.md found: read it for design tokens and constraints.

Use AskUserQuestion:
> Found [CEO plan from /plan-ceo-review | design review variants from /plan-design-review | both]
> but no approved design mockup.
> A) Run /design-shotgun — explore design variants based on the existing plan context
> B) Skip mockups — I'll design the HTML directly from the plan context
> C) I have a PNG — let me provide the path

If A: tell the user to run /design-shotgun, then come back to /design-html.
If B: proceed to Step 1 in "plan-driven mode." There is no approved PNG, the plan is
the source of truth. Ask the user for a screen name to use for the output directory
(e.g., "landing-page", "dashboard", "pricing").
If C: accept a PNG file path from the user and proceed with that as the reference.

### Case C: Nothing found (clean slate)

If none of the above produced any context:

Use AskUserQuestion:
> No design context found for this project. How do you want to start?
> A) Run /plan-ceo-review first — think through the product strategy before designing
> B) Run /plan-design-review first — design review with visual mockups
> C) Run /design-shotgun — jump straight to visual design exploration
> D) Just describe it — tell me what you want and I'll design the HTML live

If A, B, or C: tell the user to run that skill, then come back to /design-html.
If D: proceed to Step 1 in "freeform mode." Ask the user for a screen name.

### Context summary

After routing, output a brief context summary:
- **Mode:** approved-mockup | plan-driven | freeform | evolve
- **Visual reference:** path to approved PNG, or "none (plan-driven)" or "none (freeform)"
- **CEO plan:** path or "none"
- **Design tokens:** "DESIGN.md" or "none"
- **Screen name:** from approved.json, user-provided, or inferred from CEO plan

---

## Step 1: Design Analysis

1. If `$D` is available (`DESIGN_READY`), extract a structured implementation spec:
```bash
$D prompt --image <approved-variant.png> --output json
```
This returns colors, typography, layout structure, and component inventory via GPT-4o vision.

2. If `$D` is not available, read the approved PNG inline using the read_file tool.
   Describe the visual layout, colors, typography, and component structure yourself.

3. If in plan-driven or freeform mode (no approved PNG), design from context:
   - **Plan-driven:** read the CEO plan and/or design review notes. Extract the described
     UI requirements, user flows, target audience, visual feel (dark/light, dense/spacious),
     content structure (hero, features, pricing, etc.), and design constraints. Build an
     implementation spec from the plan's prose rather than a visual reference.
   - **Freeform:** use AskUserQuestion to gather what the user wants to build. Ask about:
     purpose/audience, visual feel (dark/light, playful/serious, dense/spacious),
     content structure (hero, features, pricing, etc.), and any reference sites they like.
   In both cases, describe the intended visual layout, colors, typography, and
   component structure as your implementation spec. Generate realistic content based
   on the plan or user description (never lorem ipsum).

4. Read `DESIGN.md` tokens. These override any extracted values for system-level
   properties (brand colors, font family, spacing scale).

5. Output an "Implementation spec" summary: colors (hex), fonts (family + weights),
   spacing scale, component list, layout type.

---

## Step 2: Smart Pretext API Routing

Analyze the approved design and classify it into a Pretext tier. Each tier uses
different Pretext APIs for optimal results:

| Design type | Pretext APIs | Use case |
|-------------|-------------|----------|
| Simple layout (landing, marketing) | `prepare()` + `layout()` | Resize-aware heights |
| Card/grid (dashboard, listing) | `prepare()` + `layout()` | Self-sizing cards |
| Chat/messaging UI | `prepareWithSegments()` + `walkLineRanges()` | Tight-fit bubbles, min-width |
| Content-heavy (editorial, blog) | `prepareWithSegments()` + `layoutNextLine()` | Text around obstacles |
| Complex editorial | Full engine + `layoutWithLines()` | Manual line rendering |

State the chosen tier and why. Reference the specific Pretext APIs that will be used.

---

## Step 2.5: Framework Detection

Check if the user's project uses a frontend framework:

```bash
[ -f package.json ] && cat package.json | grep -o '"react"\|"svelte"\|"vue"\|"@angular/core"\|"solid-js"\|"preact"' | head -1 || echo "NONE"
```

If a framework is detected, use AskUserQuestion:
> Detected [React/Svelte/Vue] in your project. What format should the output be?
> A) Vanilla HTML — self-contained preview file (recommended for first pass)
> B) [React/Svelte/Vue] component — framework-native with Pretext hooks

If the user chooses framework output, ask one follow-up:
> A) TypeScript
> B) JavaScript

For vanilla HTML: proceed to Step 3 with vanilla output.
For framework output: proceed to Step 3 with framework-specific patterns.
If no framework detected: default to vanilla HTML, no question needed.

---

## Step 3: Generate Pretext-Native HTML

> **STOP.** Before writing the finalized HTML in Step 3 — the Pretext wiring patterns and API cheatsheet are the required reference for all text-layout code, Read `~/.hermes/skills/gstack/design-html/sections/pretext-patterns.md` and execute it
> in full. Do not work from memory — that section is the source of truth for this step.

### Pretext Source Embedding

For **vanilla HTML output**, check for the vendored Pretext bundle:
```bash
_PRETEXT_VENDOR=""
_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
[ -n "$_ROOT" ] && [ -f "$_ROOT/.hermes/skills/gstack/design-html/vendor/pretext.js" ] && _PRETEXT_VENDOR="$_ROOT/.hermes/skills/gstack/design-html/vendor/pretext.js"
[ -z "$_PRETEXT_VENDOR" ] && [ -f ~/.hermes/skills/gstack/design-html/vendor/pretext.js ] && _PRETEXT_VENDOR=~/.hermes/skills/gstack/design-html/vendor/pretext.js
[ -n "$_PRETEXT_VENDOR" ] && echo "VENDOR: $_PRETEXT_VENDOR" || echo "VENDOR_MISSING"
```

- If `VENDOR` found: read the file and inline it in a `<script>` tag. The HTML file
  is fully self-contained with zero network dependencies.
- If `VENDOR_MISSING`: use CDN import as fallback:
  `<script type="module">import { prepare, layout, prepareWithSegments, walkLineRanges, layoutNextLine, layoutWithLines } from 'https://esm.sh/@chenglou/pretext'</script>`
  Add a comment: `<!-- FALLBACK: vendor/pretext.js missing, using CDN -->`

For **framework output**, add to the project's dependencies instead:
```bash
# Detect package manager
[ -f bun.lockb ] && echo "bun add @chenglou/pretext" || \
[ -f pnpm-lock.yaml ] && echo "pnpm add @chenglou/pretext" || \
[ -f yarn.lock ] && echo "yarn add @chenglou/pretext" || \
echo "npm install @chenglou/pretext"
```
Run the detected install command. Then use standard imports in the component.

### HTML Generation

Write a single file using the write_file tool. Save to:
`~/.hermes/gstack/projects/$SLUG/designs/<screen-name>-YYYYMMDD/finalized.html`

For framework output, save to:
`~/.hermes/gstack/projects/$SLUG/designs/<screen-name>-YYYYMMDD/finalized.[tsx|svelte|vue]`

**Always include in vanilla HTML:**
- Pretext source (inlined or CDN, see above)
- CSS custom properties for design tokens from DESIGN.md / Step 1 extraction
- Google Fonts via `<link>` tags + `document.fonts.ready` gate before first `prepare()`
- Semantic HTML5 (`<header>`, `<nav>`, `<main>`, `<section>`, `<footer>`)
- Responsive behavior via Pretext relayout (not just media queries)
- Breakpoint-specific adjustments at 375px, 768px, 1024px, 1440px
- ARIA attributes, heading hierarchy, focus-visible states
- `contenteditable` on text elements + MutationObserver to re-prepare + re-layout on edit
- ResizeObserver on containers to re-layout on resize
- `prefers-color-scheme` media query for dark mode
- `prefers-reduced-motion` for animation respect
- Real content extracted from the mockup (never lorem ipsum)

**Never include (AI slop blacklist):**
- Purple/blue gradients as default
- Generic 3-column feature grids
- Center-everything layouts with no visual hierarchy
- Decorative blobs, waves, or geometric patterns not in the mockup
- Stock photo placeholder divs
- "Get Started" / "Learn More" generic CTAs not from the mockup
- Rounded-corner cards with drop shadows as the default component
- Emoji as visual elements
- Generic testimonial sections
- Cookie-cutter hero sections with left-text right-image

---

## Step 3.5: Live Reload Server

After writing the HTML file, start a simple HTTP server for live preview:

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

If python3 is not available, fall back to:
```bash
open <path-to-finalized.html>
```

Tell the user: "Live preview running at http://localhost:$_PORT/finalized.html.
After each edit, just refresh the browser (Cmd+R) to see changes."

When the refinement loop ends (Step 4 exits), kill the server:
```bash
kill $_SERVER_PID 2>/dev/null || true
```

---

## Step 4: Preview + Refinement Loop

### Verification Screenshots

If `terminal` is available (browse binary), take verification screenshots at 3 viewports:

```bash
terminal goto "file://<path-to-finalized.html>"
terminal screenshot /tmp/gstack-verify-mobile.png --width 375
terminal screenshot /tmp/gstack-verify-tablet.png --width 768
terminal screenshot /tmp/gstack-verify-desktop.png --width 1440
```

Show all three screenshots inline using the read_file tool. Check for:
- Text overflow (text cut off or extending beyond containers)
- Layout collapse (elements overlapping or missing)
- Responsive breakage (content not adapting to viewport)

If issues are found, note them and fix before presenting to the user.

If `terminal` is not available, skip verification and note:
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

Maximum 10 iterations. If the user hasn't said "done" after 10, use AskUserQuestion:
"We've done 10 rounds of refinement. Want to continue iterating or call it done?"

---

## Step 5: Save & Next Steps

### Design Token Extraction

If no `DESIGN.md` exists in the repo root, offer to create one from the generated HTML:

Extract from the HTML:
- CSS custom properties (colors, spacing, font sizes)
- Font families and weights used
- Color palette (primary, secondary, accent, neutral)
- Spacing scale
- Border radius values
- Shadow values

Use AskUserQuestion:
> No DESIGN.md found. I can extract the design tokens from the HTML we just built
> and create a DESIGN.md for your project. This means future /design-shotgun and
> /design-html runs will be style-consistent automatically.
> A) Create DESIGN.md from these tokens
> B) Skip — I'll handle the design system later

If A: write `DESIGN.md` to the repo root with the extracted tokens.

### Save Metadata

Write `finalized.json` alongside the HTML:
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

- **Source of truth fidelity over code elegance.** When an approved mockup exists,
  pixel-match it. If that requires `width: 312px` instead of a CSS grid class, that's
  correct. When in plan-driven or freeform mode, the user's feedback during the
  refinement loop is the source of truth. Code cleanup happens later during
  component extraction.

- **Always use Pretext for text layout.** Even if the design looks simple, Pretext
  ensures correct height computation on resize. The overhead is 30KB. Every page benefits.

- **Surgical edits in the refinement loop.** Use the patch tool to make targeted changes,
  not the write_file tool to regenerate the entire file. The user may have made manual edits
  via contenteditable that should be preserved.

- **Real content only.** When a mockup exists, extract text from it. In plan-driven mode,
  use content from the plan. In freeform mode, generate realistic content based on the
  user's description. Never use "Lorem ipsum", "Your text here", or placeholder content.

- **One page per invocation.** For multi-page designs, run /design-html once per page.
  Each run produces one HTML file.
