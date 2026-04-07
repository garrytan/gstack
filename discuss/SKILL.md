---
name: discuss
preamble-tier: 2
version: 0.2.0
description: |
  Interactive discussion of experiment reports. Load a completed report and
  its backing data, then have a back-and-forth conversation with the researcher.
  Annotations are saved as timestamped discussion logs. Can suggest follow-up
  experiments that connect back to /hypothesis.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - AskUserQuestion
  - Grep
  - Glob

---
<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->

## Preamble (run first)

```bash
_BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
echo "BRANCH: $_BRANCH"
# Learnings count
eval "$(~/.claude/skills/research-stack/bin/gstack-slug 2>/dev/null)" 2>/dev/null || true
_LEARN_FILE="${GSTACK_HOME:-$HOME/.gstack}/projects/${SLUG:-unknown}/learnings.jsonl"
if [ -f "$_LEARN_FILE" ]; then
  _LEARN_COUNT=$(wc -l < "$_LEARN_FILE" 2>/dev/null | tr -d ' ')
  echo "LEARNINGS: $_LEARN_COUNT entries loaded"
  if [ "$_LEARN_COUNT" -gt 5 ] 2>/dev/null; then
    ~/.claude/skills/research-stack/bin/gstack-learnings-search --limit 3 2>/dev/null || true
  fi
else
  echo "LEARNINGS: 0"
fi
# Session timeline
_SESSION_ID="$$-$(date +%s)"
_TEL_START=$(date +%s)
~/.claude/skills/research-stack/bin/gstack-timeline-log '{"skill":"discuss","event":"started","branch":"'"$_BRANCH"'","session":"'"$_SESSION_ID"'"}' 2>/dev/null &
```

## Voice

**Tone:** direct, concrete, precise. Sound like a researcher, not a consultant.
Name the file, the function, the exact parameter. No filler.

**Writing rules:**
- No em dashes. Use commas, periods, or "..." instead.
- No AI vocabulary: delve, crucial, robust, comprehensive, nuanced, etc.
- Short paragraphs. Be specific with numbers and file paths.
- End with what to do next.

## Context Recovery

After compaction or at session start, check for recent project artifacts:

```bash
eval "$(~/.claude/skills/research-stack/bin/gstack-slug 2>/dev/null)"
_PROJ="${GSTACK_HOME:-$HOME/.gstack}/projects/${SLUG:-unknown}"
if [ -d "$_PROJ" ]; then
  echo "--- RECENT ARTIFACTS ---"
  [ -f "$_PROJ/timeline.jsonl" ] && tail -5 "$_PROJ/timeline.jsonl"
  echo "--- END ARTIFACTS ---"
fi
```

If artifacts are listed, mention recent activity briefly.

## AskUserQuestion — MUST use the tool

When the workflow says to ask the researcher a question, **you MUST call the AskUserQuestion tool**.
Do NOT just print the options as text in the chat. The tool renders clickable options in the UI.

**How to call it:** Use the AskUserQuestion tool with a `question` string and an `options` array.
Include a recommendation in the question text itself.

**Question format:**
1. Re-ground: state the project, branch, and current task (1-2 sentences)
2. Explain the decision in plain English
3. Add `RECOMMENDATION: [option]` with a one-line reason
4. The options array provides the choices — keep them short and actionable

Assume the user hasn't looked at this window in 20 minutes.

## Completeness Principle

AI makes completeness near-free. Always recommend the complete option over shortcuts.

**Effort reference:**

| Task type | Human team | CC+research-stack | Compression |
|-----------|-----------|-----------|-------------|
| Boilerplate | 2 days | 15 min | ~100x |
| Parameter sweep | 1 day | 15 min | ~50x |
| Analysis + plots | 4 hours | 15 min | ~20x |
| Hypothesis spec | 2 hours | 5 min | ~25x |

## Repo Ownership

If working in a collaborative repo, flag issues outside your branch via
AskUserQuestion rather than fixing directly (may be someone else's work).

## Search Before Building

Before building anything unfamiliar, **search first.**
- Search for "{runtime} {thing} built-in"
- Search for "{thing} best practice {current year}"
- Check official docs

Three layers: **Layer 1** (tried and true), **Layer 2** (new and popular),
**Layer 3** (first principles). Prize Layer 3 above all.

## Completion Status

When completing a skill workflow, report status:
- **DONE** — All steps completed successfully.
- **DONE_WITH_CONCERNS** — Completed with issues to note.
- **BLOCKED** — Cannot proceed. State what is blocking.
- **NEEDS_CONTEXT** — Missing information required.

### Operational Learning

Before completing, reflect:
- Did any commands fail unexpectedly?
- Did you discover a project-specific quirk?
- Did something take longer than expected?

If yes, log an operational learning:

```bash
~/.claude/skills/research-stack/bin/gstack-learnings-log '{"skill":"discuss","type":"operational","key":"SHORT_KEY","insight":"DESCRIPTION","confidence":N,"source":"observed"}'
```

### Telemetry (run last)

```bash
_TEL_END=$(date +%s)
_TEL_DUR=$(( _TEL_END - _TEL_START ))
~/.claude/skills/research-stack/bin/gstack-timeline-log '{"skill":"discuss","event":"completed","branch":"'$(git branch --show-current 2>/dev/null || echo unknown)'","outcome":"OUTCOME","duration_s":"'"$_TEL_DUR"'","session":"'"$_SESSION_ID"'"}' 2>/dev/null || true
```

Replace `OUTCOME` with success/error/abort.

# /discuss — Interactive Report Discussion

Load a completed experiment report and its backing data (metrics, provenance,
hypothesis), then engage in an iterative discussion with the researcher.
Questions get answered with concrete data references. Annotations are saved
as a persistent discussion log.

## Input

The user provides either:
- A slug name (e.g., `threshold-scaling`)
- A report path (e.g., `research/reports/threshold-scaling.md`)

If only a slug is given, locate the report:

```bash
cat research/reports/<slug>.md 2>/dev/null || echo "NO_REPORT"
```

If `NO_REPORT`, **call the AskUserQuestion tool**:
- question: "No report found for '<slug>'. What would you like to discuss?"
- options: ["Run /report first to generate one", "Point me to a different slug", "Discuss raw results without a report"]

## Workflow

### Step 1: Load context bundle

Load all artifacts for the slug:

```bash
# Report
cat research/reports/<slug>.md

# Latest results
_LATEST=$(ls -t research/results/<slug>/ 2>/dev/null | head -1)
cat "research/results/<slug>/$_LATEST/metrics.json" 2>/dev/null || echo "NO_METRICS"
cat "research/results/<slug>/$_LATEST/provenance.json" 2>/dev/null || echo "NO_PROVENANCE"

# Hypothesis
cat research/hypotheses/<slug>.md 2>/dev/null || echo "NO_HYPOTHESIS"

# Experiment spec
cat research/experiments/<slug>/spec.yaml 2>/dev/null || echo "NO_SPEC"

# Prior discussions (if resuming)
cat research/discussions/<slug>.md 2>/dev/null || echo "NEW_DISCUSSION"
```

If resuming an existing discussion, show the prior entries and continue from where
it left off.

### Step 2: Summarize loaded context

Print a concise summary to the chat:
- Hypothesis claim (one line)
- Result verdict (CONFIRMED/REJECTED/INCONCLUSIVE)
- Key metrics (top 3-5 numbers from metrics.json)
- Provenance snapshot (git SHA, timestamp, duration)

Then **call the AskUserQuestion tool**:
- question: "Context loaded for '<slug>'. What would you like to discuss?"
- options: ["Ask about the methodology", "Dig into specific metrics", "Question the conclusions", "Suggest follow-up experiments", "Add an annotation"]

### Step 3: Discussion loop

This step repeats. For each researcher question or comment:

**3a. Parse the intent.** Determine whether the researcher is:
- Asking a data question (answer with specific numbers from metrics.json)
- Questioning methodology (reference the spec.yaml and experiment code)
- Adding an annotation (record it)
- Suggesting follow-up work (connect to /hypothesis)

**3b. Answer with data references.** Every response MUST include at least one
concrete reference. Format:

> **Data ref:** `metrics.json` — parameter `X` = value Y

or

> **Data ref:** `provenance.json` — git SHA `abc1234`, seeds `[42, 123, 456]`

Do not give vague answers. If the data does not contain the answer, say so
explicitly and suggest what additional experiment would produce it.

**3c. Record the exchange.** Append to the discussion log (built in memory,
written in Step 5).

**3d. Prompt for continuation.** After answering, **call the AskUserQuestion tool**:
- question: "<one-line summary of your answer>. What next?"
- options: ["Ask another question", "Add an annotation", "Suggest a follow-up experiment", "End discussion"]

If "Ask another question": Loop back to Step 3.
If "Add an annotation": Go to Step 4a.
If "Suggest a follow-up experiment": Go to Step 4b.
If "End discussion": Go to Step 5.

### Step 4a: Add annotation

The researcher provides annotation text. Record it with a type tag.

**Call the AskUserQuestion tool**:
- question: "What type of annotation is this?"
- options: ["Observation — noting something interesting", "Concern — flagging a potential issue", "TODO — something to investigate later", "Correction — fixing a mistake in the report"]

Record the annotation with the chosen type, then return to Step 3d.

### Step 4b: Suggest follow-up experiment

Based on the discussion, draft a follow-up hypothesis in one sentence.

**Call the AskUserQuestion tool**:
- question: "Follow-up idea: '<drafted hypothesis>'. Want to create this as a formal hypothesis?"
- options: ["Yes, create via /hypothesis", "Refine the idea first", "Just note it in the discussion log"]

If "Yes": Record the suggestion in the discussion log, then tell the researcher:
```
To create this hypothesis: /hypothesis "<drafted hypothesis>"
```

If "Refine": Ask for the refined version, then re-present.
If "Just note it": Record in the discussion log, return to Step 3d.

### Step 5: Save discussion log

```bash
mkdir -p research/discussions
```

Write or append to `research/discussions/<slug>.md`:

```markdown
# Discussion: <hypothesis title>

**Report:** research/reports/<slug>.md
**Started:** <timestamp of first entry>
**Participants:** researcher, Claude

---

## Entry 1 — <timestamp>

**[Researcher]** <question or comment>

**[Analysis]** <Claude's response with data references>

**Data refs:**
- `metrics.json`: <specific reference>
- `provenance.json`: <specific reference>

---

## Annotations

| # | Type | Note | Added |
|---|------|------|-------|
| 1 | <observation/concern/todo/correction> | <text> | <timestamp> |

## Follow-up Ideas

- [ ] <follow-up hypothesis 1>
- [ ] <follow-up hypothesis 2>
```

If appending to an existing discussion, read the existing file and append new
entries after the last `---` separator. Do not overwrite prior entries.

### Step 6: Record to learnings

## Capture Learnings

If you discovered a non-obvious pattern, pitfall, or architectural insight during
this session, log it for future sessions:

```bash
~/.claude/skills/research-stack/bin/gstack-learnings-log '{"skill":"discuss","type":"TYPE","key":"SHORT_KEY","insight":"DESCRIPTION","confidence":N,"source":"SOURCE","files":["path/to/relevant/file"]}'
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

Log the discussion:

```bash
eval "$(~/.claude/skills/research-stack/bin/gstack-slug 2>/dev/null)"
_LEARN_FILE="${GSTACK_HOME:-$HOME/.gstack}/projects/${SLUG:-unknown}/learnings.jsonl"
mkdir -p "$(dirname "$_LEARN_FILE")"
echo '{"type":"discussion","slug":"<slug>","entries":<count>,"annotations":<count>,"followups":<count>,"ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' >> "$_LEARN_FILE"
```

## Output

After completion:

```
Discussion saved:
  Log:         research/discussions/<slug>.md
  Entries:     <N> exchanges
  Annotations: <N> added
  Follow-ups:  <N> suggested

Related:
  Report:  research/reports/<slug>.md
  Results: research/results/<slug>/<timestamp>/
```
