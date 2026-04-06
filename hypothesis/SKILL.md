---
name: hypothesis
preamble-tier: 2
version: 0.1.0
description: |
  Structure a research idea into a testable hypothesis and experiment specification.
  Takes a natural language description and produces a structured hypothesis document
  plus a parameter sweep spec. Checks past learnings to prevent re-running dead ends.
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
~/.claude/skills/research-stack/bin/gstack-timeline-log '{"skill":"hypothesis","event":"started","branch":"'"$_BRANCH"'","session":"'"$_SESSION_ID"'"}' 2>/dev/null &
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

## AskUserQuestion Format

**ALWAYS follow this structure for every AskUserQuestion call:**
1. **Re-ground:** State the project, the current branch, and the current task. (1-2 sentences)
2. **Simplify:** Explain the problem in plain English. No jargon.
3. **Recommend:** `RECOMMENDATION: Choose [X] because [one-line reason]`
4. **Options:** Lettered options: `A) ... B) ... C) ...`

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
~/.claude/skills/research-stack/bin/gstack-learnings-log '{"skill":"hypothesis","type":"operational","key":"SHORT_KEY","insight":"DESCRIPTION","confidence":N,"source":"observed"}'
```

### Telemetry (run last)

```bash
_TEL_END=$(date +%s)
_TEL_DUR=$(( _TEL_END - _TEL_START ))
~/.claude/skills/research-stack/bin/gstack-timeline-log '{"skill":"hypothesis","event":"completed","branch":"'$(git branch --show-current 2>/dev/null || echo unknown)'","outcome":"OUTCOME","duration_s":"'"$_TEL_DUR"'","session":"'"$_SESSION_ID"'"}' 2>/dev/null || true
```

Replace `OUTCOME` with success/error/abort.

# /hypothesis — Structure Research Ideas

Transform a natural language research idea into a structured, testable hypothesis
with an experiment specification ready for `/run-experiment`.

## Workflow

### Step 1: Capture the idea

The user provides a research idea in natural language. Examples:
- "Surface code threshold scales as 1/distance for bit-flip noise"
- "MWPM decoder outperforms Union-Find at low noise rates for rotated surface codes"
- "Increasing batch size beyond 1024 shows diminishing returns for this model"

If the idea is vague, use AskUserQuestion to clarify:
- What specific quantity are you measuring?
- What do you expect to observe?
- What would prove the hypothesis wrong?

### Step 2: Check past learnings

## Prior Learnings

Search for relevant learnings from previous sessions:

```bash
_CROSS_PROJ=$(~/.claude/skills/research-stack/bin/gstack-config get cross_project_learnings 2>/dev/null || echo "unset")
echo "CROSS_PROJECT: $_CROSS_PROJ"
if [ "$_CROSS_PROJ" = "true" ]; then
  ~/.claude/skills/research-stack/bin/gstack-learnings-search --limit 10 --cross-project 2>/dev/null || true
else
  ~/.claude/skills/research-stack/bin/gstack-learnings-search --limit 10 2>/dev/null || true
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

If A: run `~/.claude/skills/research-stack/bin/gstack-config set cross_project_learnings true`
If B: run `~/.claude/skills/research-stack/bin/gstack-config set cross_project_learnings false`

Then re-run the search with the appropriate flag.

If learnings are found, incorporate them into your analysis. When a review finding
matches a past learning, display:

**"Prior learning applied: [key] (confidence N/10, from [date])"**

This makes the compounding visible. The user should see that gstack is getting
smarter on their codebase over time.

Search for related hypotheses and experiments. If similar work was done before:
- **If it succeeded:** Note it and suggest building on those results
- **If it failed (dead-end):** Warn the researcher with the reason

```bash
eval "$(~/.claude/skills/research-stack/bin/gstack-slug 2>/dev/null)"
_LEARN_FILE="${GSTACK_HOME:-$HOME/.gstack}/projects/${SLUG:-unknown}/learnings.jsonl"
if [ -f "$_LEARN_FILE" ]; then
  grep -i "<relevant_keyword>" "$_LEARN_FILE" | tail -5
fi
```

### Step 3: Read project conventions

## Read Project Conventions

Before generating any code, read the project's CLAUDE.md and look for a `## Research conventions` section.

```bash
grep -A 50 "## Research conventions" CLAUDE.md 2>/dev/null || echo "NO_CONVENTIONS"
```

If `NO_CONVENTIONS` is printed, the project has no research conventions configured yet.
Use AskUserQuestion to ask the researcher to define their conventions:

> This project doesn't have research conventions configured yet.
> I need to know your project's coding conventions to generate code that
> matches your style. I'll ask a few questions and save them to CLAUDE.md.

Questions to ask (via AskUserQuestion):
1. **Language:** What language do you use? (Python, Julia, MATLAB, etc.)
2. **Import style:** Any specific import conventions? (e.g., "import numpy as np")
3. **Naming:** How do you name experiment files and result directories?
4. **Compute backend:** Where do you run experiments? (local, SLURM, cloud)
5. **Baseline location:** Where are baseline results stored?
6. **Test command:** How do you run tests?

After gathering answers, write a `## Research conventions` section to CLAUDE.md with the
answers formatted as key-value pairs. Example:

```markdown
## Research conventions

### Language
python 3.11+

### Imports
- Always use `import stim` not `from stim import *`
- Use `pathlib.Path` not `os.path`
- Numpy as `np`, matplotlib.pyplot as `plt`

### Naming
- Experiment files: `run_<slug>.py`
- Result directories: `results/<slug>/<YYYYMMDD-HHMMSS>/`

### Compute backend
local

### Baseline location
research/baselines/

### Test command
pytest tests/ -x
```

If conventions ARE found, parse them and use them to guide all code generation.
Every generated file must follow these conventions exactly. Convention compliance
is more important than code elegance.

### Step 4: Generate hypothesis document

Create a slug from the idea (e.g., "threshold-scaling", "decoder-comparison").

Write `research/hypotheses/<slug>.md`:

```markdown
# Hypothesis: <title>

**Date:** <today>
**Author:** <from git config>
**Status:** proposed

## Claim
<one clear sentence stating the hypothesis>

## Prediction
<what specific outcome would confirm or deny this>

## Method
<how to test it — simulation approach, analysis method>

## Parameters
<key experimental parameters and their ranges>

## Success Criteria
<quantitative threshold for accepting/rejecting the hypothesis>

## Estimated Compute
<rough estimate: seconds/minutes/hours, local/cluster>

## Related Work
<links to past experiments, learnings, or papers>
```

### Step 5: Generate experiment spec

Write `research/experiments/<slug>/spec.yaml`:

```yaml
hypothesis: research/hypotheses/<slug>.md
created: <today>
status: pending

parameters:
  # Key experimental parameters with ranges
  # Example for QEC:
  # distances: [3, 5, 7, 9]
  # noise_rates: [0.001, 0.003, 0.005, 0.008, 0.01]
  # num_shots: 100000

baseline:
  path: research/baselines/<slug>/metrics.json  # or null if no baseline
  description: <what to compare against>

conventions:
  language: <from CLAUDE.md>
  imports: <from CLAUDE.md>
  naming: <from CLAUDE.md>

seeds: [42, 123, 456]  # default seeds for reproducibility
```

### Step 6: Create directory structure

```bash
mkdir -p research/hypotheses
mkdir -p research/experiments/<slug>
mkdir -p research/baselines/<slug>
mkdir -p research/results/<slug>
mkdir -p research/reports
```

### Step 7: Review with researcher

Show the generated hypothesis and spec to the researcher via AskUserQuestion:

> **Hypothesis:** <claim>
>
> **Parameters:** <summary of parameter grid>
>
> **Success criteria:** <threshold>
>
> Ready to proceed?

Options:
- A) Looks good, save it
- B) Modify the hypothesis
- C) Modify the parameters
- D) Discard

If A: Write files and record to learnings.
If B/C: Iterate on the specific part.
If D: Do not create files.

### Step 8: Record to learnings

## Capture Learnings

If you discovered a non-obvious pattern, pitfall, or architectural insight during
this session, log it for future sessions:

```bash
~/.claude/skills/research-stack/bin/gstack-learnings-log '{"skill":"hypothesis","type":"TYPE","key":"SHORT_KEY","insight":"DESCRIPTION","confidence":N,"source":"SOURCE","files":["path/to/relevant/file"]}'
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

Log the hypothesis creation:

```bash
eval "$(~/.claude/skills/research-stack/bin/gstack-slug 2>/dev/null)"
_LEARN_FILE="${GSTACK_HOME:-$HOME/.gstack}/projects/${SLUG:-unknown}/learnings.jsonl"
mkdir -p "$(dirname "$_LEARN_FILE")"
echo '{"type":"hypothesis","slug":"<slug>","claim":"<claim>","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' >> "$_LEARN_FILE"
```

## Output

After completion, tell the researcher:

```
Hypothesis created:
  research/hypotheses/<slug>.md
  research/experiments/<slug>/spec.yaml

Next step: /run-experiment research/experiments/<slug>/spec.yaml
```
