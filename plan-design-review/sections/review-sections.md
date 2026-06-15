<!-- AUTO-GENERATED from review-sections.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
## Review Sections (7 passes, after scope is agreed)

**Anti-skip rule:** Never condense, abbreviate, or skip any review pass (1-7) regardless of plan type (strategy, spec, code, infra). Every pass in this skill exists for a reason. "This is a strategy doc so design passes don't apply" is always wrong — design gaps are where implementation breaks down. If a pass genuinely has zero findings, say "No issues found" and move on — but you must evaluate it.

**Anti-shortcut clause:** The plan file is the OUTPUT of the interactive review, not a substitute for it. Writing every finding into one plan write and calling ExitPlanMode without firing AskUserQuestion is the precise failure mode of the May 2026 transcript bug — the model explored, found issues, and dumped them into a deliverable rather than walking the user through them. If you have ANY non-trivial finding in any review section, the path from finding to ExitPlanMode goes THROUGH AskUserQuestion. Zero findings in every section is the only path to ExitPlanMode that bypasses AskUserQuestion. If you find yourself wanting to write a plan with findings before asking, stop and call AskUserQuestion now — that's the bug, recognize it.

## Prior Learnings

Search for relevant learnings from previous sessions:

```bash
_CROSS_PROJ=$(~/.claude/skills/gstack/bin/gstack-config get cross_project_learnings 2>/dev/null || echo "unset")
echo "CROSS_PROJECT: $_CROSS_PROJ"
if [ "$_CROSS_PROJ" = "true" ]; then
  ~/.claude/skills/gstack/bin/gstack-learnings-search --limit 10 --cross-project 2>/dev/null || true
else
  ~/.claude/skills/gstack/bin/gstack-learnings-search --limit 10 2>/dev/null || true
fi
```

If `CROSS_PROJECT` is `unset` (first time): Use AskUserQuestion:

> gstack can search learnings from your other projects on this machine to find
> patterns that might apply here. This stays local (no data leaves your machine).
> Recommended for solo developers. Skip if you work on multiple client codebases
> where cross-contamination would be a concern.

Options:
- A) Enable cross-project learnings (recommended)
- B) Keep learnings project-scoped only

If A: run `~/.claude/skills/gstack/bin/gstack-config set cross_project_learnings true`
If B: run `~/.claude/skills/gstack/bin/gstack-config set cross_project_learnings false`

Then re-run the search with the appropriate flag.

If learnings are found, incorporate them into your analysis. When a review finding
matches a past learning, display:

**"Prior learning applied: [key] (confidence N/10, from [date])"**

This makes the compounding visible. The user should see that gstack is getting
smarter on their codebase over time.

### Pass 1: Information Architecture
Rate 0-10: Does the plan define what the user sees first, second, third?
FIX TO 10: Add information hierarchy to the plan. Include ASCII diagram of screen/page structure and navigation flow. Apply "constraint worship" — if you can only show 3 things, which 3?
**STOP.** AskUserQuestion once per issue. Do NOT batch. Recommend + WHY. If no issues, say so and move on. Do NOT proceed until user responds.

### Pass 2: Interaction State Coverage
Rate 0-10: Does the plan specify loading, empty, error, success, partial states?
FIX TO 10: Add interaction state table to the plan:
```
  FEATURE              | LOADING | EMPTY | ERROR | SUCCESS | PARTIAL
  ---------------------|---------|-------|-------|---------|--------
  [each UI feature]    | [spec]  | [spec]| [spec]| [spec]  | [spec]
```
For each state: describe what the user SEES, not backend behavior.
Empty states are features — specify warmth, primary action, context.
**STOP.** AskUserQuestion once per issue. Do NOT batch. Recommend + WHY.

### Pass 3: User Journey & Emotional Arc
Rate 0-10: Does the plan consider the user's emotional experience?
FIX TO 10: Add user journey storyboard:
```
  STEP | USER DOES        | USER FEELS      | PLAN SPECIFIES?
  -----|------------------|-----------------|----------------
  1    | Lands on page    | [what emotion?] | [what supports it?]
  ...
```
Apply time-horizon design: 5-sec visceral, 5-min behavioral, 5-year reflective.
**STOP.** AskUserQuestion once per issue. Do NOT batch. Recommend + WHY.

### Pass 4: AI Slop Risk
Rate 0-10: Does the plan describe specific, intentional UI — or generic patterns?
FIX TO 10: Rewrite vague UI descriptions with specific alternatives.

### Design Hard Rules

**Classifier — determine rule set before evaluating:**
- **MARKETING/LANDING PAGE** (hero-driven, brand-forward, conversion-focused) → apply Landing Page Rules
- **APP UI** (workspace-driven, data-dense, task-focused: dashboards, admin, settings) → apply App UI Rules
- **HYBRID** (marketing shell with app-like sections) → apply Landing Page Rules to hero/marketing sections, App UI Rules to functional sections

**Hard rejection criteria** (instant-fail patterns — flag if ANY apply):
1. Generic SaaS card grid as first impression
2. Beautiful image with weak brand
3. Strong headline with no clear action
4. Busy imagery behind text
5. Sections repeating same mood statement
6. Carousel with no narrative purpose
7. App UI made of stacked cards instead of layout

**Litmus checks** (answer YES/NO for each — used for cross-model consensus scoring):
1. Brand/product unmistakable in first screen?
2. One strong visual anchor present?
3. Page understandable by scanning headlines only?
4. Each section has one job?
5. Are cards actually necessary?
6. Does motion improve hierarchy or atmosphere?
7. Would design feel premium with all decorative shadows removed?

**Landing page rules** (apply when classifier = MARKETING/LANDING):
- First viewport reads as one composition, not a dashboard
- Brand-first hierarchy: brand > headline > body > CTA
- Typography: expressive, purposeful — no default stacks (Inter, Roboto, Arial, system)
- No flat single-color backgrounds — use gradients, images, subtle patterns
- Hero: full-bleed, edge-to-edge, no inset/tiled/rounded variants
- Hero budget: brand, one headline, one supporting sentence, one CTA group, one image
- No cards in hero. Cards only when card IS the interaction
- One job per section: one purpose, one headline, one short supporting sentence
- Motion: 2-3 intentional motions minimum (entrance, scroll-linked, hover/reveal)
- Color: define CSS variables, avoid purple-on-white defaults, one accent color default
- Copy: product language not design commentary. "If deleting 30% improves it, keep deleting"
- Beautiful defaults: composition-first, brand as loudest text, two typefaces max, cardless by default, first viewport as poster not document

**App UI rules** (apply when classifier = APP UI):
- Calm surface hierarchy, strong typography, few colors
- Dense but readable, minimal chrome
- Organize: primary workspace, navigation, secondary context, one accent
- Avoid: dashboard-card mosaics, thick borders, decorative gradients, ornamental icons
- Copy: utility language — orientation, status, action. Not mood/brand/aspiration
- Cards only when card IS the interaction
- Section headings state what area is or what user can do ("Selected KPIs", "Plan status")

**Universal rules** (apply to ALL types):
- Define CSS variables for color system
- No default font stacks (Inter, Roboto, Arial, system)
- One job per section
- "If deleting 30% of the copy improves it, keep deleting"
- Cards earn their existence — no decorative card grids
- NEVER use small, low-contrast type (body text < 16px or contrast ratio < 4.5:1 on body text)
- NEVER put labels inside form fields as the only label (placeholder-as-label pattern — labels must be visible when the field has content)
- ALWAYS preserve visited vs unvisited link distinction (visited links must have a different color)
- NEVER float headings between paragraphs (heading must be visually closer to the section it introduces than to the preceding section)

**AI Slop blacklist** (the 10 patterns that scream "AI-generated"):
1. Purple/violet/indigo gradient backgrounds or blue-to-purple color schemes
2. **The 3-column feature grid:** icon-in-colored-circle + bold title + 2-line description, repeated 3x symmetrically. THE most recognizable AI layout.
3. Icons in colored circles as section decoration (SaaS starter template look)
4. Centered everything (`text-align: center` on all headings, descriptions, cards)
5. Uniform bubbly border-radius on every element (same large radius on everything)
6. Decorative blobs, floating circles, wavy SVG dividers (if a section feels empty, it needs better content, not decoration)
7. Emoji as design elements (rockets in headings, emoji as bullet points)
8. Colored left-border on cards (`border-left: 3px solid <accent>`)
9. Generic hero copy ("Welcome to [X]", "Unlock the power of...", "Your all-in-one solution for...")
10. Cookie-cutter section rhythm (hero → 3 features → testimonials → pricing → CTA, every section same height)
11. system-ui or `-apple-system` as the PRIMARY display/body font — the "I gave up on typography" signal. Pick a real typeface.

Source: [OpenAI "Designing Delightful Frontends with GPT-5.4"](https://developers.openai.com/blog/designing-delightful-frontends-with-gpt-5-4) (Mar 2026) + gstack design methodology.
- "Cards with icons" → what differentiates these from every SaaS template?
- "Hero section" → what makes this hero feel like THIS product?
- "Clean, modern UI" → meaningless. Replace with actual design decisions.
- "Dashboard with widgets" → what makes this NOT every other dashboard?
If visual mockups were generated in Step 0.5, evaluate them against the AI slop blacklist above. Read each mockup image using the Read tool. Does the mockup fall into generic patterns (3-column grid, centered hero, stock-photo feel)? If so, flag it and offer to regenerate with more specific direction via `$D iterate --feedback "..."`.
**STOP.** AskUserQuestion once per issue. Do NOT batch. Recommend + WHY.

### Pass 5: Design System Alignment
Rate 0-10: Does the plan align with DESIGN.md?
FIX TO 10: If DESIGN.md exists, annotate with specific tokens/components. If no DESIGN.md, flag the gap and recommend `/design-consultation`.
Flag any new component — does it fit the existing vocabulary?
**STOP.** AskUserQuestion once per issue. Do NOT batch. Recommend + WHY.

### Pass 6: Responsive & Accessibility
Rate 0-10: Does the plan specify mobile/tablet, keyboard nav, screen readers?
FIX TO 10: Add responsive specs per viewport — not "stacked on mobile" but intentional layout changes. Add a11y: keyboard nav patterns, ARIA landmarks, touch target sizes (44px min), color contrast requirements.
**STOP.** AskUserQuestion once per issue. Do NOT batch. Recommend + WHY.

### Pass 7: Unresolved Design Decisions
Surface ambiguities that will haunt implementation:
```
  DECISION NEEDED              | IF DEFERRED, WHAT HAPPENS
  -----------------------------|---------------------------
  What does empty state look like? | Engineer ships "No items found."
  Mobile nav pattern?          | Desktop nav hides behind hamburger
  ...
```
If visual mockups were generated in Step 0.5, reference them as evidence when surfacing unresolved decisions. A mockup makes decisions concrete — e.g., "Your approved mockup shows a sidebar nav, but the plan doesn't specify mobile behavior. What happens to this sidebar on 375px?"
Each decision = one AskUserQuestion with recommendation + WHY + alternatives. Edit the plan with each decision as it's made.

### Post-Pass: Update Mockups (if generated)

If mockups were generated in Step 0.5 and review passes changed significant design decisions (information architecture restructure, new states, layout changes), offer to regenerate (one-shot, not a loop):

AskUserQuestion: "The review passes changed [list major design changes]. Want me to regenerate mockups to reflect the updated plan? This ensures the visual reference matches what we're actually building."

If yes, use `$D iterate` with feedback summarizing the changes, or `$D variants` with an updated brief. Save to the same `$_DESIGN_DIR` directory.

## CRITICAL RULE — How to ask questions
Follow the AskUserQuestion format from the Preamble above. Additional rules for plan design reviews:
* **One issue = one AskUserQuestion call.** Never combine multiple issues into one question.
* Describe the design gap concretely — what's missing, what the user will experience if it's not specified.
* Present 2-3 options. For each: effort to specify now, risk if deferred.
* **Map to Design Principles above.** One sentence connecting your recommendation to a specific principle.
* Label with issue NUMBER + option LETTER (e.g., "3A", "3B").
* **Zero findings:** if a section has zero findings, state "No issues, moving on" and proceed. Otherwise, use AskUserQuestion for each gap — a gap with an "obvious fix" is still a gap and still needs user approval before any change lands in the plan.
* **NEVER use AskUserQuestion to ask which variant the user prefers.** Always create a comparison board first (`$D compare --serve`) and open it in the browser. The board has rating controls, comments, remix/regenerate buttons, and structured feedback output. Use AskUserQuestion ONLY to notify the user the board is open and wait for them to finish — not to present variants inline and ask "which do you prefer?" That is a degraded experience.

## Required Outputs

### "NOT in scope" section
Design decisions considered and explicitly deferred, with one-line rationale each.

### "What already exists" section
Existing DESIGN.md, UI patterns, and components that the plan should reuse.

### TODOS.md updates
After all review passes are complete, present each potential TODO as its own individual AskUserQuestion. Never batch TODOs — one per question. Never silently skip this step.

For design debt: missing a11y, unresolved responsive behavior, deferred empty states. Each TODO gets:
* **What:** One-line description of the work.
* **Why:** The concrete problem it solves or value it unlocks.
* **Pros:** What you gain by doing this work.
* **Cons:** Cost, complexity, or risks of doing it.
* **Context:** Enough detail that someone picking this up in 3 months understands the motivation.
* **Depends on / blocked by:** Any prerequisites.

Then present options: **A)** Add to TODOS.md **B)** Skip — not valuable enough **C)** Build it now in this PR instead of deferring.

## Implementation Tasks

Before closing this review, synthesize the findings above into a flat list of
build-actionable tasks. Each task derives from a specific finding — no padding.
Emit the markdown section AND write a JSONL artifact that `/autoplan` can
aggregate across phases.

### Markdown section (always emit)

```markdown
## Implementation Tasks
Synthesized from this review's findings. Each task derives from a specific
finding above. Run with Claude Code or Codex; checkbox as you ship.

- [ ] **T1 (P1, human: ~2h / CC: ~15min)** — <component> — <imperative title>
  - Surfaced by: <section name> — <specific finding text or line reference>
  - Files: <paths to touch>
  - Verify: <test command or manual check>
- [ ] **T2 (P2, human: ~30min / CC: ~5min)** — ...
```

Rules:
- P1 blocks ship; P2 should land same branch; P3 is a follow-up TODO.
- If a finding produced no actionable task, do not invent one.
- If a section had zero findings, emit `_No new tasks from <section>._`
- Effort uses the AI-compression table from CLAUDE.md.

### JSONL artifact (always write, even if zero tasks)

`/autoplan` reads this file to aggregate across phases. Build each line with
`jq -nc` so titles and source findings containing quotes, newlines, or
backslashes serialize cleanly — never use hand-rolled `echo` / `printf`.

```bash
eval "$(~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null)"
TASKS_DIR="${HOME}/.gstack/projects/${SLUG:-unknown}"
mkdir -p "$TASKS_DIR"
TASKS_FILE="$TASKS_DIR/tasks-design-review-$(date +%Y%m%d-%H%M%S).jsonl"
COMMIT=$(git rev-parse HEAD 2>/dev/null || echo unknown)
BRANCH=$(git branch --show-current 2>/dev/null || echo unknown)
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"

# Repeat ONE jq invocation per task identified during this review.
# Substitute the placeholders inline with shell variables you set per task:
#   TASK_ID (T1, T2, ...), PRIORITY (P1/P2/P3), COMPONENT, TITLE,
#   SOURCE_FINDING, EFFORT_HUMAN, EFFORT_CC, FILES_JSON (a JSON array literal
#   like '["browse/src/sanitize.ts","browse/src/server.ts"]').
jq -nc \
  --arg phase 'design-review' \
  --arg run_id "$RUN_ID" \
  --arg branch "$BRANCH" \
  --arg commit "$COMMIT" \
  --arg id "$TASK_ID" \
  --arg priority "$PRIORITY" \
  --arg component "$COMPONENT" \
  --arg effort_human "$EFFORT_HUMAN" \
  --arg effort_cc "$EFFORT_CC" \
  --arg title "$TITLE" \
  --arg source_finding "$SOURCE_FINDING" \
  --argjson files "$FILES_JSON" \
  '{phase:$phase, run_id:$run_id, branch:$branch, commit:$commit, id:$id, priority:$priority, component:$component, files:$files, effort_human:$effort_human, effort_cc:$effort_cc, title:$title, source_finding:$source_finding}' \
  >> "$TASKS_FILE"
```

If `jq` is not installed, fall back to skipping the JSONL write and warn
the user to install jq for autoplan aggregation. Never hand-roll JSONL.

If zero tasks were identified in this review, still touch the JSONL file
(`: > "$TASKS_FILE"`) so the aggregator sees that the phase produced output
this run (an empty file means "ran, no findings" — distinct from "didn't run").


### Completion Summary
```
  +====================================================================+
  |         DESIGN PLAN REVIEW — COMPLETION SUMMARY                    |
  +====================================================================+
  | System Audit         | [DESIGN.md status, UI scope]                |
  | Step 0               | [initial rating, focus areas]               |
  | Pass 1  (Info Arch)  | ___/10 → ___/10 after fixes                |
  | Pass 2  (States)     | ___/10 → ___/10 after fixes                |
  | Pass 3  (Journey)    | ___/10 → ___/10 after fixes                |
  | Pass 4  (AI Slop)    | ___/10 → ___/10 after fixes                |
  | Pass 5  (Design Sys) | ___/10 → ___/10 after fixes                |
  | Pass 6  (Responsive) | ___/10 → ___/10 after fixes                |
  | Pass 7  (Decisions)  | ___ resolved, ___ deferred                 |
  +--------------------------------------------------------------------+
  | NOT in scope         | written (___ items)                         |
  | What already exists  | written                                     |
  | TODOS.md updates     | ___ items proposed                          |
  | Approved Mockups     | ___ generated, ___ approved                  |
  | Decisions made       | ___ added to plan                           |
  | Decisions deferred   | ___ (listed below)                          |
  | Overall design score | ___/10 → ___/10                             |
  +====================================================================+
```

If all passes 8+: "Plan is design-complete. Run /design-review after implementation for visual QA."
If any below 8: note what's unresolved and why (user chose to defer).

### Unresolved Decisions
If any AskUserQuestion goes unanswered, note it here. Never silently default to an option.

### Approved Mockups

If visual mockups were generated during this review, add to the plan file:

```
## Approved Mockups

| Screen/Section | Mockup Path | Direction | Notes |
|----------------|-------------|-----------|-------|
| [screen name]  | ~/.gstack/projects/$SLUG/designs/[folder]/[filename].png | [brief description] | [constraints from review] |
```

Include the full path to each approved mockup (the variant the user chose), a one-line description of the direction, and any constraints. The implementer reads this to know exactly which visual to build from. These persist across conversations and workspaces. If no mockups were generated, omit this section.

## Review Log

After producing the Completion Summary above, persist the review result.

**PLAN MODE EXCEPTION — ALWAYS RUN:** This command writes review metadata to
`~/.gstack/` (user config directory, not project files). The skill preamble
already writes to `~/.gstack/sessions/` and `~/.gstack/analytics/` — this is
the same pattern. The review dashboard depends on this data. Skipping this
command breaks the review readiness dashboard in /ship.

```bash
~/.claude/skills/gstack/bin/gstack-review-log '{"skill":"plan-design-review","timestamp":"TIMESTAMP","status":"STATUS","initial_score":N,"overall_score":N,"unresolved":N,"decisions_made":N,"commit":"COMMIT"}'
```

Substitute values from the Completion Summary:
- **TIMESTAMP**: current ISO 8601 datetime
- **STATUS**: "clean" if overall score 8+ AND 0 unresolved; otherwise "issues_open"
- **initial_score**: initial overall design score before fixes (0-10)
- **overall_score**: final overall design score after fixes (0-10)
- **unresolved**: number of unresolved design decisions
- **decisions_made**: number of design decisions added to the plan
- **COMMIT**: output of `git rev-parse --short HEAD`

## Review Readiness Dashboard

After completing the review, read the review log and config to display the dashboard.

```bash
~/.claude/skills/gstack/bin/gstack-review-read
```

Parse the output. Find the most recent entry for each skill (plan-ceo-review, plan-eng-review, review, plan-design-review, design-review-lite, adversarial-review, codex-review, codex-plan-review). Ignore entries with timestamps older than 7 days. For the Eng Review row, show whichever is more recent between `review` (diff-scoped pre-landing review) and `plan-eng-review` (plan-stage architecture review). Append "(DIFF)" or "(PLAN)" to the status to distinguish. For the Adversarial row, show whichever is more recent between `adversarial-review` (new auto-scaled) and `codex-review` (legacy). For Design Review, show whichever is more recent between `plan-design-review` (full visual audit) and `design-review-lite` (code-level check). Append "(FULL)" or "(LITE)" to the status to distinguish. For the Outside Voice row, show the most recent `codex-plan-review` entry — this captures outside voices from both /plan-ceo-review and /plan-eng-review.

**Source attribution:** If the most recent entry for a skill has a \`"via"\` field, append it to the status label in parentheses. Examples: `plan-eng-review` with `via:"autoplan"` shows as "CLEAR (PLAN via /autoplan)". `review` with `via:"ship"` shows as "CLEAR (DIFF via /ship)". Entries without a `via` field show as "CLEAR (PLAN)" or "CLEAR (DIFF)" as before.

Note: `autoplan-voices` and `design-outside-voices` entries are audit-trail-only (forensic data for cross-model consensus analysis). They do not appear in the dashboard and are not checked by any consumer.

Display:

```
+====================================================================+
|                    REVIEW READINESS DASHBOARD                       |
+====================================================================+
| Review          | Runs | Last Run            | Status    | Required |
|-----------------|------|---------------------|-----------|----------|
| Eng Review      |  1   | 2026-03-16 15:00    | CLEAR     | YES      |
| CEO Review      |  0   | —                   | —         | no       |
| Design Review   |  0   | —                   | —         | no       |
| Adversarial     |  0   | —                   | —         | no       |
| Outside Voice   |  0   | —                   | —         | no       |
+--------------------------------------------------------------------+
| VERDICT: CLEARED — Eng Review passed                                |
+====================================================================+
```

**Review tiers:**
- **Eng Review (required by default):** The only review that gates shipping. Covers architecture, code quality, tests, performance. Can be disabled globally with \`gstack-config set skip_eng_review true\` (the "don't bother me" setting).
- **CEO Review (optional):** Use your judgment. Recommend it for big product/business changes, new user-facing features, or scope decisions. Skip for bug fixes, refactors, infra, and cleanup.
- **Design Review (optional):** Use your judgment. Recommend it for UI/UX changes. Skip for backend-only, infra, or prompt-only changes.
- **Adversarial Review (automatic):** Always-on for every review. Every diff gets both Claude adversarial subagent and Codex adversarial challenge. Large diffs (200+ lines) additionally get Codex structured review with P1 gate. No configuration needed.
- **Outside Voice (optional):** Independent plan review from a different AI model. Offered after all review sections complete in /plan-ceo-review and /plan-eng-review. Falls back to Claude subagent if Codex is unavailable. Never gates shipping.

**Verdict logic:**
- **CLEARED**: Eng Review has >= 1 entry within 7 days from either \`review\` or \`plan-eng-review\` with status "clean" (or \`skip_eng_review\` is \`true\`)
- **NOT CLEARED**: Eng Review missing, stale (>7 days), or has open issues
- CEO, Design, and Codex reviews are shown for context but never block shipping
- If \`skip_eng_review\` config is \`true\`, Eng Review shows "SKIPPED (global)" and verdict is CLEARED

**Staleness detection:** After displaying the dashboard, check if any existing reviews may be stale:
- Parse the \`---HEAD---\` section from the bash output to get the current HEAD commit hash
- For each review entry that has a \`commit\` field: compare it against the current HEAD. If different, count elapsed commits: \`git rev-list --count STORED_COMMIT..HEAD\`. Display: "Note: {skill} review from {date} may be stale — {N} commits since review"
- For entries without a \`commit\` field (legacy entries): display "Note: {skill} review from {date} has no commit tracking — consider re-running for accurate staleness detection"
- If all reviews match the current HEAD, do not display any staleness notes

## Plan File Review Report

After displaying the Review Readiness Dashboard in conversation output, also update the
**plan file** itself so review status is visible to anyone reading the plan.

### Detect the plan file

1. Check if there is an active plan file in this conversation (the host provides plan file
   paths in system messages — look for plan file references in the conversation context).
2. If not found, skip this section silently — not every review runs in plan mode.

### Generate the report

Read the review log output you already have from the Review Readiness Dashboard step above.
Parse each JSONL entry. Each skill logs different fields:

- **plan-ceo-review**: \`status\`, \`unresolved\`, \`critical_gaps\`, \`mode\`, \`scope_proposed\`, \`scope_accepted\`, \`scope_deferred\`, \`commit\`
  → Findings: "{scope_proposed} proposals, {scope_accepted} accepted, {scope_deferred} deferred"
  → If scope fields are 0 or missing (HOLD/REDUCTION mode): "mode: {mode}, {critical_gaps} critical gaps"
- **plan-eng-review**: \`status\`, \`unresolved\`, \`critical_gaps\`, \`issues_found\`, \`mode\`, \`commit\`
  → Findings: "{issues_found} issues, {critical_gaps} critical gaps"
- **plan-design-review**: \`status\`, \`initial_score\`, \`overall_score\`, \`unresolved\`, \`decisions_made\`, \`commit\`
  → Findings: "score: {initial_score}/10 → {overall_score}/10, {decisions_made} decisions"
- **plan-devex-review**: \`status\`, \`initial_score\`, \`overall_score\`, \`product_type\`, \`tthw_current\`, \`tthw_target\`, \`mode\`, \`persona\`, \`competitive_tier\`, \`unresolved\`, \`commit\`
  → Findings: "score: {initial_score}/10 → {overall_score}/10, TTHW: {tthw_current} → {tthw_target}"
- **devex-review**: \`status\`, \`overall_score\`, \`product_type\`, \`tthw_measured\`, \`dimensions_tested\`, \`dimensions_inferred\`, \`boomerang\`, \`commit\`
  → Findings: "score: {overall_score}/10, TTHW: {tthw_measured}, {dimensions_tested} tested/{dimensions_inferred} inferred"
- **codex-review**: \`status\`, \`gate\`, \`findings\`, \`findings_fixed\`
  → Findings: "{findings} findings, {findings_fixed}/{findings} fixed"

All fields needed for the Findings column are now present in the JSONL entries.
For the review you just completed, you may use richer details from your own Completion
Summary. For prior reviews, use the JSONL fields directly — they contain all required data.

Produce this markdown table:

\`\`\`markdown
## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | \`/plan-ceo-review\` | Scope & strategy | {runs} | {status} | {findings} |
| Codex Review | \`/codex review\` | Independent 2nd opinion | {runs} | {status} | {findings} |
| Eng Review | \`/plan-eng-review\` | Architecture & tests (required) | {runs} | {status} | {findings} |
| Design Review | \`/plan-design-review\` | UI/UX gaps | {runs} | {status} | {findings} |
| DX Review | \`/plan-devex-review\` | Developer experience gaps | {runs} | {status} | {findings} |
\`\`\`

Below the table, add these lines. **CODEX** and **CROSS-MODEL** are optional (omit when
empty); **VERDICT** is always present:

- **CODEX:** (only if codex-review ran) — one-line summary of codex fixes
- **CROSS-MODEL:** (only if both Claude and Codex reviews exist) — overlap analysis
- **VERDICT:** list reviews that are CLEAR (e.g., "CEO + ENG CLEARED — ready to implement").
  If Eng Review is not CLEAR and not skipped globally, append "eng review required".

**Unresolved-decisions status (MANDATORY — never omitted; the report's final non-whitespace
line).** After VERDICT, end the report (content under the \`## GSTACK REVIEW REPORT\`
heading — a bold label, never a new \`## \` heading; exempt from the "omit when empty"
rule) with exactly one: the exact unbolded line \`NO UNRESOLVED DECISIONS\` (a bolded one
does NOT count), OR a \`**UNRESOLVED DECISIONS:**\` header + one bullet per open item
(last bullet = final line; add \`+ N unresolved from prior reviews\` only when N > 0).
This avoids double-counting: list THIS review's open items from context; for prior reviews
sum \`unresolved\` over the latest fresh row per skill (dashboard 7-day window) after you
DROP the current skill's row; emit the sentinel only when both are zero.

### Write to the plan file

**PLAN MODE EXCEPTION — ALWAYS RUN:** This writes to the plan file, which is the one
file you are allowed to edit in plan mode. The plan file review report is part of the
plan's living status.

The report must always be the LAST section of the plan file — never mid-file.
Use a single delete-then-append flow:

1. Read the plan file (Read tool) to see its full current content. Search the read
   output for a \`## GSTACK REVIEW REPORT\` heading anywhere in the file.
2. If found, use the Edit tool to DELETE the entire existing section. Match from
   \`## GSTACK REVIEW REPORT\` through either the next \`## \` heading or end of
   file, whichever comes first. Replace with the empty string. This applies
   regardless of where the section currently lives — mid-file deletion is
   intentional, not a special case. If the Edit fails (e.g., concurrent edit
   changed the content), re-read the plan file and retry once.
3. After the delete (or skipped, if no section existed), append the new
   \`## GSTACK REVIEW REPORT\` section at the END of the file. Use the Edit
   tool to match the file's current last paragraph and add the section after it,
   or use Write to re-emit the whole file with the section at the end.
4. Verify with the Read tool that \`## GSTACK REVIEW REPORT\` is the last
   \`## \` heading in the file before continuing. If it isn't, repeat steps
   2-3 once.

Do NOT replace the section in place. The "replace mid-file" path is what allowed
prior versions to leave the report mid-file when an older report already lived
there — the user then sees a plan whose review report is not at the bottom and
(correctly) rejects it.

## Capture Learnings

If you discovered a non-obvious pattern, pitfall, or architectural insight during
this session, log it for future sessions:

```bash
~/.claude/skills/gstack/bin/gstack-learnings-log '{"skill":"plan-design-review","type":"TYPE","key":"SHORT_KEY","insight":"DESCRIPTION","confidence":N,"source":"SOURCE","files":["path/to/relevant/file"]}'
```

**Types:** `pattern` (reusable approach), `pitfall` (what NOT to do), `preference`
(user stated), `architecture` (structural decision), `tool` (library/framework insight),
`operational` (project environment/CLI/workflow knowledge).

**Sources:** `observed` (you found this in the code), `user-stated` (user told you),
`inferred` (AI deduction), `cross-model` (both Claude and Codex agree).

**Confidence:** 1-10. Be honest. An observed pattern you verified in the code is 8-9.
An inference you're not sure about is 4-5. A user preference they explicitly stated is 10.

**files:** Include the specific file paths this learning references. This enables
staleness detection: if those files are later deleted, the learning can be flagged.

**Only log genuine discoveries.** Don't log obvious things. Don't log things the user
already knows. A good test: would this insight save time in a future session? If yes, log it.



## Brain Calibration Write-Back (Phase 2 / gated)

When the skill makes a typed prediction worth tracking (scope decision,
TTHW target, architectural bet, wedge commitment), it MAY write a
`kind=bet` take to the brain so a calibration profile builds over time.

**Gated on two things:**
1. Brain trust policy for the active endpoint is `personal` (check via
   `~/.claude/skills/gstack/bin/gstack-config get brain_trust_policy@<endpoint-hash>`).
   Shared brains skip write-back to avoid polluting team calibration.
2. Feature flag `BRAIN_CALIBRATION_WRITEBACK` is set (today: false; flips
   to true when upstream gbrain v0.42+ ships `takes_add` MCP op).

When both gates pass, the write-back path uses `mcp__gbrain__takes_add`
to record a take with weight 0.5 (per SKILL_CALIBRATION_WEIGHTS).
If the MCP op is unavailable, fall back to `mcp__gbrain__put_page` with
a gstack:takes fence block (documented but uglier path).

Mandatory take frontmatter shape:
```yaml
kind: bet
holder: <user identity from whoami>
claim: <one-line prediction the skill is making>
weight: 0.5
since_date: <today's date>
expected_resolution: <date in 1-3 months depending on skill>
source_skill: plan-design-review
```

After write, invalidate the affected digests so the next preflight reflects
the new state:

```bash
eval "$(~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null)" 2>/dev/null || true
  ~/.claude/skills/gstack/bin/gstack-brain-cache invalidate brand --project "$SLUG" 2>/dev/null || true
```


## Brain Cache Background Refresh

After the skill's work completes (and telemetry has logged), kick a
background refresh of any cache digest that's getting close to its TTL.
This is non-blocking — the user doesn't wait. Next invocation benefits
from the warm cache.

```bash
eval "$(~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null)" 2>/dev/null || true
(~/.claude/skills/gstack/bin/gstack-brain-cache refresh --project "$SLUG" 2>/dev/null &) || true
```


## Next Steps — Review Chaining

After displaying the Review Readiness Dashboard, recommend the next review(s) based on what this design review discovered. Read the dashboard output to see which reviews have already been run and whether they are stale.

**Recommend /plan-eng-review if eng review is not skipped globally** — check the dashboard output for `skip_eng_review`. If it is `true`, eng review is opted out — do not recommend it. Otherwise, eng review is the required shipping gate. If this design review added significant interaction specifications, new user flows, or changed the information architecture, emphasize that eng review needs to validate the architectural implications. If an eng review already exists but the commit hash shows it predates this design review, note that it may be stale and should be re-run.

**Consider recommending /plan-ceo-review** — but only if this design review revealed fundamental product direction gaps. Specifically: if the overall design score started below 4/10, if the information architecture had major structural problems, or if the review surfaced questions about whether the right problem is being solved. AND no CEO review exists in the dashboard. This is a selective recommendation — most design reviews should NOT trigger a CEO review.

**If both are needed, recommend eng review first** (required gate).

**Recommend design exploration skills when appropriate** — /design-shotgun and /design-html
produce design artifacts (mockups, HTML previews), not application code. They belong in
plan mode alongside reviews. If this design review found visual issues that would benefit
from exploring new directions, recommend /design-shotgun. If approved mockups exist and
need to be turned into working HTML, recommend /design-html.

Use AskUserQuestion to present the next step. Include only applicable options:
- **A)** Run /plan-eng-review next (required gate)
- **B)** Run /plan-ceo-review (only if fundamental product gaps found)
- **C)** Run /design-shotgun — explore visual design variants for issues found
- **D)** Run /design-html — generate Pretext-native HTML from approved mockups
- **E)** Skip — I'll handle next steps manually

## Formatting Rules
* NUMBER issues (1, 2, 3...) and LETTERS for options (A, B, C...).
* Label with NUMBER + LETTER (e.g., "3A", "3B").
* One sentence max per option.
* After each pass, pause and wait for feedback.
* Rate before and after each pass for scannability.

