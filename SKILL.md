---
name: research-stack
preamble-tier: 1
version: 0.1.0
description: |
  Research computation framework for Claude Code. Structures the hypothesis-experiment-report
  cycle with convention enforcement, provenance tracking, and negative results registry.
  Use when running numerical simulations, parameter sweeps, or hypothesis validation.
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
~/.claude/skills/research-stack/bin/gstack-timeline-log '{"skill":"research-stack","event":"started","branch":"'"$_BRANCH"'","session":"'"$_SESSION_ID"'"}' 2>/dev/null &
```

## Voice

**Tone:** direct, concrete, precise. Sound like a researcher, not a consultant.
Name the file, the function, the exact parameter. No filler.

**Writing rules:**
- No em dashes. Use commas, periods, or "..." instead.
- No AI vocabulary: delve, crucial, robust, comprehensive, nuanced, etc.
- Short paragraphs. Be specific with numbers and file paths.
- End with what to do next.

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
~/.claude/skills/research-stack/bin/gstack-learnings-log '{"skill":"research-stack","type":"operational","key":"SHORT_KEY","insight":"DESCRIPTION","confidence":N,"source":"observed"}'
```

### Telemetry (run last)

```bash
_TEL_END=$(date +%s)
_TEL_DUR=$(( _TEL_END - _TEL_START ))
~/.claude/skills/research-stack/bin/gstack-timeline-log '{"skill":"research-stack","event":"completed","branch":"'$(git branch --show-current 2>/dev/null || echo unknown)'","outcome":"OUTCOME","duration_s":"'"$_TEL_DUR"'","session":"'"$_SESSION_ID"'"}' 2>/dev/null || true
```

Replace `OUTCOME` with success/error/abort.

# Research Stack: Hypothesis → Experiment → Report

A framework that formalizes the research computation cycle. Three skills, one workflow:

1. **`/hypothesis`** — Structure a research idea into a testable experiment spec
2. **`/run-experiment`** — Generate convention-compliant code, review, execute, capture provenance
3. **`/report`** — Compare results against baselines, generate plots and analysis

## Routing Rules

When the user's request matches a skill, invoke it via the Skill tool:

- New research idea, "I want to test...", hypothesis → invoke `/hypothesis`
- Run simulation, execute experiment, parameter sweep → invoke `/run-experiment`
- Analyze results, compare baselines, generate report → invoke `/report`

## Core Principles

1. **Convention enforcement.** All generated code follows the project's conventions from CLAUDE.md.
2. **Reproducibility by default.** Every run produces a provenance bundle automatically.
3. **Human-in-the-loop.** The researcher reviews and approves at every stage.
4. **Failed experiments are data.** The learnings system tracks what didn't work.

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

## Research File Structure

All research artifacts follow this directory convention:

```
research/
  hypotheses/<slug>.md              # Structured hypothesis document
  experiments/<slug>/
    spec.yaml                       # Parameter grid, baselines, conventions
    run_<slug>.py                   # Generated experiment code
  results/<slug>/<timestamp>/
    metrics.json                    # Raw experiment results
    provenance.json                 # Reproducibility bundle (see Provenance spec)
    plots/                          # Generated visualizations
  baselines/<slug>/
    metrics.json                    # Baseline results for comparison
  reports/<slug>.md                 # Final analysis report
```

**Slug convention:** lowercase, hyphens for spaces, no underscores in slugs.
Example: `threshold-scaling`, `decoder-comparison`, `noise-model-validation`.

**Timestamp convention:** `YYYYMMDD-HHMMSS` (e.g., `20260406-231603`).

**Before creating any files:** Check if `research/` exists. If not, create the
full directory structure:

```bash
mkdir -p research/{hypotheses,experiments,results,baselines,reports}
```

**When referencing paths:** Always use relative paths from the project root.
Never hardcode absolute paths in generated code or spec files.

## Provenance Bundle

Every experiment run MUST produce a `provenance.json` file alongside results.
This is non-negotiable. The provenance bundle captures everything needed to
reproduce the exact run.

**Required fields:**

```json
{
  "git_sha": "string — output of git rev-parse HEAD",
  "git_dirty": "boolean — true if working tree has uncommitted changes",
  "branch": "string — current git branch name",
  "timestamp": "string — ISO 8601 UTC timestamp of run start",
  "wall_clock_seconds": "number — total execution time",
  "packages": "object — {package_name: version} for all research dependencies",
  "random_seeds": "array — all random seeds used in the experiment",
  "python_version": "string — or julia_version, matlab_version as appropriate",
  "platform": "string — e.g. darwin-arm64, linux-x86_64",
  "experiment_spec": "string — relative path to the spec.yaml file",
  "parameters": "object — the exact parameter grid used in this run",
  "baseline_ref": {
    "path": "string — relative path to baseline metrics file (if applicable)",
    "git_sha": "string — git SHA when baseline was last updated"
  }
}
```

**How to generate the provenance bundle:**

```python
import json, subprocess, sys, platform, time
from datetime import datetime, timezone
from pathlib import Path

def capture_provenance(spec_path, parameters, seeds, packages):
    prov = {
        "git_sha": subprocess.check_output(["git", "rev-parse", "HEAD"]).decode().strip(),
        "git_dirty": bool(subprocess.check_output(["git", "status", "--porcelain"]).decode().strip()),
        "branch": subprocess.check_output(["git", "branch", "--show-current"]).decode().strip(),
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "wall_clock_seconds": None,  # filled after run
        "packages": packages,
        "random_seeds": seeds,
        "python_version": sys.version.split()[0],
        "platform": f"{sys.platform}-{platform.machine()}",
        "experiment_spec": str(spec_path),
        "parameters": parameters,
    }
    return prov
```

The provenance generation code should be included in every generated experiment
script. After the experiment completes, fill in `wall_clock_seconds` and write
`provenance.json` to the results directory.

## Quick Start

```bash
# 1. Define a hypothesis
# /hypothesis "Surface code threshold scales as 1/distance for bit-flip noise"

# 2. Run the experiment (generates code → review → execute)
# /run-experiment research/experiments/threshold-scaling/spec.yaml

# 3. Analyze and report
# /report research/results/threshold-scaling/latest
```

## Learnings System

The framework maintains a registry of past experiments and their outcomes.
When creating a new hypothesis, it checks for similar past experiments
(including failures) to prevent re-running dead ends.

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
