---
name: run-experiment
preamble-tier: 2
version: 0.1.0
description: |
  Generate convention-compliant experiment code from a spec, get researcher approval,
  then execute with full provenance tracking. Two-phase workflow: generate → approve → run.
  Supports parameter sweeps with automatic result capture and provenance bundles.
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
~/.claude/skills/research-stack/bin/gstack-timeline-log '{"skill":"run-experiment","event":"started","branch":"'"$_BRANCH"'","session":"'"$_SESSION_ID"'"}' 2>/dev/null &
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
~/.claude/skills/research-stack/bin/gstack-learnings-log '{"skill":"run-experiment","type":"operational","key":"SHORT_KEY","insight":"DESCRIPTION","confidence":N,"source":"observed"}'
```

### Telemetry (run last)

```bash
_TEL_END=$(date +%s)
_TEL_DUR=$(( _TEL_END - _TEL_START ))
~/.claude/skills/research-stack/bin/gstack-timeline-log '{"skill":"run-experiment","event":"completed","branch":"'$(git branch --show-current 2>/dev/null || echo unknown)'","outcome":"OUTCOME","duration_s":"'"$_TEL_DUR"'","session":"'"$_SESSION_ID"'"}' 2>/dev/null || true
```

Replace `OUTCOME` with success/error/abort.

# /run-experiment — Generate, Review, Execute

Two-phase workflow: first generate the experiment code per project conventions,
then execute after researcher approval. Never run generated code without approval.

## Input

The user provides either:
- A path to a spec.yaml file (from `/hypothesis`)
- A natural language description (generate a minimal spec inline)

If a spec.yaml path is given:

```bash
cat research/experiments/<slug>/spec.yaml
```

If natural language, extract: parameters, language, what to measure. Then proceed
as if a spec existed.

## Phase A: Code Generation

### Step A1: Read conventions

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

### Step A2: Read the experiment spec

Parse the spec.yaml to extract:
- Parameter grid (what combinations to sweep)
- Baseline reference (what to compare against)
- Random seeds
- Language and conventions

### Step A3: Generate experiment code

Create `research/experiments/<slug>/run_<slug>.py` (or appropriate extension).

The generated code MUST:

1. **Follow all project conventions** from CLAUDE.md (imports, naming, structure)
2. **Accept parameters from command line or config** — not hardcoded
3. **Include provenance capture** (see spec below)
4. **Write results to a timestamped directory**
5. **Be self-contained** — one file that can be run independently

**Code structure template:**

```python
#!/usr/bin/env python3
"""
Experiment: <title from hypothesis>
Spec: research/experiments/<slug>/spec.yaml
Generated by /run-experiment
"""

# --- Imports (per project conventions) ---
import json
import subprocess
import sys
import time
import platform
from datetime import datetime, timezone
from pathlib import Path

# <project-specific imports per CLAUDE.md conventions>

# --- Provenance ---
def capture_provenance(spec_path, parameters, seeds, packages):
    return {
        "git_sha": subprocess.check_output(["git", "rev-parse", "HEAD"]).decode().strip(),
        "git_dirty": bool(subprocess.check_output(["git", "status", "--porcelain"]).decode().strip()),
        "branch": subprocess.check_output(["git", "branch", "--show-current"]).decode().strip(),
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "wall_clock_seconds": None,
        "packages": packages,
        "random_seeds": seeds,
        "python_version": sys.version.split()[0],
        "platform": f"{sys.platform}-{platform.machine()}",
        "experiment_spec": str(spec_path),
        "parameters": parameters,
    }

# --- Parameters ---
PARAMETERS = {
    # <from spec.yaml>
}
SEEDS = [42, 123, 456]  # <from spec.yaml>

# --- Main experiment ---
def run_experiment(params, seed):
    """Run a single experiment configuration."""
    # <generated experiment logic>
    pass

def main():
    start_time = time.time()
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    results_dir = Path(f"research/results/<slug>/{timestamp}")
    results_dir.mkdir(parents=True, exist_ok=True)

    # Capture provenance
    packages = {}  # <detect installed packages>
    prov = capture_provenance(
        "research/experiments/<slug>/spec.yaml",
        PARAMETERS, SEEDS, packages
    )

    # Run parameter sweep
    all_results = []
    for seed in SEEDS:
        for <param_combo> in <param_grid>:
            result = run_experiment(<param_combo>, seed)
            all_results.append(result)

    # Save results
    with open(results_dir / "metrics.json", "w") as f:
        json.dump(all_results, f, indent=2)

    # Finalize provenance
    prov["wall_clock_seconds"] = round(time.time() - start_time, 2)
    with open(results_dir / "provenance.json", "w") as f:
        json.dump(prov, f, indent=2)

    print(f"Results saved to: {results_dir}")

if __name__ == "__main__":
    main()
```

Adapt this template to the specific experiment. Replace placeholders with actual
logic based on the spec and conventions.

### Step A4: APPROVAL GATE

**This step is mandatory. Never skip it.**

Show the generated code to the researcher and ask for approval via AskUserQuestion:

> **Generated experiment code:** `research/experiments/<slug>/run_<slug>.py`
>
> **What it does:**
> - <1-2 sentence summary of the experiment>
> - Sweeps <N> parameter combinations across <M> seeds
> - Estimated runtime: <estimate>
>
> **Parameters:** <summary>
>
> Ready to execute?

Options:
- A) Run it
- B) I want to modify the code first
- C) Abort

If A: Proceed to Phase B.
If B: Wait for the researcher to make edits, then re-read the file and proceed.
If C: Stop. Do not execute.

## Phase B: Execution

### Step B1: Check compute backend

Read the `compute_backend` field from CLAUDE.md Research conventions.

- **`local`** (default): Execute via subprocess
- **`slurm`** (future): Generate SLURM job script and submit
- **`cloud`** (future): Generate cloud job config

For local execution:

```bash
cd <project_root>
python research/experiments/<slug>/run_<slug>.py
```

### Step B2: Monitor execution

For long-running experiments, report progress periodically.
If the experiment fails, capture the error and show it to the researcher.

### Step B3: Verify results

After execution completes:

```bash
ls research/results/<slug>/
# Should contain:
# <timestamp>/metrics.json
# <timestamp>/provenance.json
```

Verify:
1. metrics.json exists and is valid JSON
2. provenance.json exists and has all required fields
3. git_sha matches current HEAD

### Step B4: Record to learnings

## Capture Learnings

If you discovered a non-obvious pattern, pitfall, or architectural insight during
this session, log it for future sessions:

```bash
~/.claude/skills/research-stack/bin/gstack-learnings-log '{"skill":"run-experiment","type":"TYPE","key":"SHORT_KEY","insight":"DESCRIPTION","confidence":N,"source":"SOURCE","files":["path/to/relevant/file"]}'
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

```bash
eval "$(~/.claude/skills/research-stack/bin/gstack-slug 2>/dev/null)"
_LEARN_FILE="${GSTACK_HOME:-$HOME/.gstack}/projects/${SLUG:-unknown}/learnings.jsonl"
mkdir -p "$(dirname "$_LEARN_FILE")"
echo '{"type":"result","slug":"<slug>","success":true,"summary":"<brief_summary>","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' >> "$_LEARN_FILE"
```

## Output

After completion, tell the researcher:

```
Experiment complete:
  Code:       research/experiments/<slug>/run_<slug>.py
  Results:    research/results/<slug>/<timestamp>/metrics.json
  Provenance: research/results/<slug>/<timestamp>/provenance.json
  Duration:   <N> seconds

Next step: /report research/results/<slug>/<timestamp>
```

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
