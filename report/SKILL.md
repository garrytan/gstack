---
name: report
preamble-tier: 2
version: 0.2.0
description: |
  Analyze experiment results, compare against baselines, generate plots,
  and produce a structured research report. Connects results back to the
  original hypothesis and records outcomes to the learnings system.
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
~/.claude/skills/research-stack/bin/gstack-timeline-log '{"skill":"report","event":"started","branch":"'"$_BRANCH"'","session":"'"$_SESSION_ID"'"}' 2>/dev/null &
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
~/.claude/skills/research-stack/bin/gstack-learnings-log '{"skill":"report","type":"operational","key":"SHORT_KEY","insight":"DESCRIPTION","confidence":N,"source":"observed"}'
```

### Telemetry (run last)

```bash
_TEL_END=$(date +%s)
_TEL_DUR=$(( _TEL_END - _TEL_START ))
~/.claude/skills/research-stack/bin/gstack-timeline-log '{"skill":"report","event":"completed","branch":"'$(git branch --show-current 2>/dev/null || echo unknown)'","outcome":"OUTCOME","duration_s":"'"$_TEL_DUR"'","session":"'"$_SESSION_ID"'"}' 2>/dev/null || true
```

Replace `OUTCOME` with success/error/abort.

# /report — Analyze Results & Generate Report

Take experiment results, compare them against baselines, generate visualizations,
and produce a structured report that connects back to the original hypothesis.

## Input

The user provides either:
- A results directory path (e.g., `research/results/threshold-scaling/20260406-231603/`)
- A slug name (finds the latest results automatically)

If only a slug is given:

```bash
ls -t research/results/<slug>/ | head -1
```

Use the most recent timestamp directory.

## Workflow

### Step 1: Load results and provenance

```bash
cat research/results/<slug>/<timestamp>/metrics.json
cat research/results/<slug>/<timestamp>/provenance.json
```

Verify provenance is complete. If any required fields are missing, warn the researcher.

### Step 2: Load the hypothesis

Read the experiment spec to find the hypothesis:

```bash
cat research/experiments/<slug>/spec.yaml
```

Extract the hypothesis path and read it:

```bash
cat research/hypotheses/<slug>.md
```

Pull out the **Prediction** and **Success Criteria** for later comparison.

### Step 3: Load baseline (if available)

Check if a baseline exists in the spec:

```bash
cat research/baselines/<slug>/metrics.json 2>/dev/null || echo "NO_BASELINE"
```

If a baseline exists, load it for comparison. If not, note that this is the
first run and suggest saving current results as the baseline.

### Step 4: Analyze results

Compare the experiment results against:
1. **The hypothesis prediction** — did the data match what was expected?
2. **The success criteria** — does the result meet the quantitative threshold?
3. **The baseline** (if exists) — is this better, worse, or equivalent?

Compute key statistics:
- Mean, std, min, max for each metric
- Relative improvement over baseline (if applicable)
- Whether success criteria are met (pass/fail for each)

### Step 5: Generate plots

Create a plotting script and execute it:

```bash
mkdir -p research/results/<slug>/<timestamp>/plots
```

Generate `research/results/<slug>/<timestamp>/plot_results.py`:

```python
#!/usr/bin/env python3
"""Generate plots for experiment: <slug>"""
import json
import matplotlib
matplotlib.use('Agg')  # Non-interactive backend
import matplotlib.pyplot as plt
import numpy as np
from pathlib import Path

# Load results
results_dir = Path("research/results/<slug>/<timestamp>")
with open(results_dir / "metrics.json") as f:
    data = json.load(f)

# Load baseline if available
baseline_path = Path("research/baselines/<slug>/metrics.json")
baseline = None
if baseline_path.exists():
    with open(baseline_path) as f:
        baseline = json.load(f)

# --- Generate plots ---
# Adapt these to the specific experiment metrics

# Plot 1: Main results
fig, ax = plt.subplots(figsize=(8, 5))
# <plot logic based on actual metrics>
ax.set_xlabel("<x label>")
ax.set_ylabel("<y label>")
ax.set_title("<experiment title>")
if baseline is not None:
    pass  # <overlay baseline>
ax.legend()
fig.tight_layout()
fig.savefig(results_dir / "plots" / "main_results.png", dpi=150)
plt.close(fig)

# Plot 2: Comparison with baseline (if applicable)
if baseline is not None:
    fig, ax = plt.subplots(figsize=(8, 5))
    # <comparison plot>
    fig.tight_layout()
    fig.savefig(results_dir / "plots" / "baseline_comparison.png", dpi=150)
    plt.close(fig)

print(f"Plots saved to: {results_dir / 'plots'}")
```

Execute:

```bash
python research/results/<slug>/<timestamp>/plot_results.py
```

Show the generated plots to the researcher using the Read tool on each PNG file.

### Step 6: Generate report

Write `research/reports/<slug>.md`:

```markdown
# Report: <hypothesis title>

**Date:** <today>
**Experiment:** research/experiments/<slug>/spec.yaml
**Results:** research/results/<slug>/<timestamp>/
**Provenance:** research/results/<slug>/<timestamp>/provenance.json

## Summary

<2-3 sentence summary of what was tested and what was found>

## Hypothesis

> <claim from hypothesis document>

**Prediction:** <expected outcome>
**Result:** <CONFIRMED / REJECTED / INCONCLUSIVE>

## Key Findings

1. <finding 1 with specific numbers>
2. <finding 2 with specific numbers>
3. <finding 3 with specific numbers>

## Results

### Metrics

| Metric | Value | Baseline | Delta |
|--------|-------|----------|-------|
| <metric> | <value> | <baseline_value> | <+/-change> |

### Plots

![Main Results](../results/<slug>/<timestamp>/plots/main_results.png)

<caption and interpretation>

![Baseline Comparison](../results/<slug>/<timestamp>/plots/baseline_comparison.png)

<caption and interpretation>

## Success Criteria

| Criterion | Threshold | Actual | Pass/Fail |
|-----------|-----------|--------|-----------|
| <criterion> | <threshold> | <actual> | <PASS/FAIL> |

## Reproducibility

- **Git SHA:** <from provenance>
- **Branch:** <from provenance>
- **Duration:** <wall_clock_seconds>s
- **Seeds:** <from provenance>
- **Packages:** <from provenance>

To reproduce:
\`\`\`bash
git checkout <git_sha>
python research/experiments/<slug>/run_<slug>.py
\`\`\`

## Next Steps

<recommended follow-up experiments or analyses>
```

### Step 7: Outcome assessment

Print the report path and result summary as text. Then **call the AskUserQuestion tool**:

- question: "Report generated: research/reports/<slug>.md. Result: <CONFIRMED/REJECTED/INCONCLUSIVE>. How would you classify this experiment? RECOMMENDATION: <your assessment based on the data>."
- options: ["Success — save as new baseline", "Partial success — needs more work", "Failure — record as dead end", "Inconclusive — needs different parameters"]

### Step 8: Record to learnings and update baseline

## Capture Learnings

If you discovered a non-obvious pattern, pitfall, or architectural insight during
this session, log it for future sessions:

```bash
~/.claude/skills/research-stack/bin/gstack-learnings-log '{"skill":"report","type":"TYPE","key":"SHORT_KEY","insight":"DESCRIPTION","confidence":N,"source":"SOURCE","files":["path/to/relevant/file"]}'
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

Based on the researcher's assessment:

**If A (Success):**
```bash
# Save as new baseline
cp research/results/<slug>/<timestamp>/metrics.json research/baselines/<slug>/metrics.json
```
Record positive result to learnings.

**If C (Dead end):**
```bash
eval "$(~/.claude/skills/research-stack/bin/gstack-slug 2>/dev/null)"
_LEARN_FILE="${GSTACK_HOME:-$HOME/.gstack}/projects/${SLUG:-unknown}/learnings.jsonl"
echo '{"type":"dead-end","slug":"<slug>","reason":"<why it failed>","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' >> "$_LEARN_FILE"
```

**If B or D:**
Record partial result and suggest next steps.

## Output

After completion:

```
Report complete:
  Report:     research/reports/<slug>.md
  Plots:      research/results/<slug>/<timestamp>/plots/
  Outcome:    <CONFIRMED/REJECTED/INCONCLUSIVE>
  Baseline:   <updated / unchanged>

Previous: /run-experiment research/experiments/<slug>/spec.yaml
```
