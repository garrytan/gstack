import type { TemplateContext } from './types';

export function generateResearchConventions(_ctx: TemplateContext): string {
  return `## Read Project Conventions

Before generating any code, read the project's CLAUDE.md and look for a \`## Research conventions\` section.

\`\`\`bash
grep -A 50 "## Research conventions" CLAUDE.md 2>/dev/null || echo "NO_CONVENTIONS"
\`\`\`

If conventions ARE found, parse them and use them to guide all code generation.
Every generated file must follow these conventions exactly. Convention compliance
is more important than code elegance.

---

If \`NO_CONVENTIONS\` is printed, the project has no research conventions yet.
**Auto-detect the project and write conventions to CLAUDE.md before continuing.**

**Step 1: Auto-detect project characteristics.**

\`\`\`bash
echo "=== LANGUAGE DETECTION ==="
if ls *.py **/*.py 2>/dev/null | head -1 >/dev/null 2>&1; then echo "DETECTED: python"; fi
if ls *.jl **/*.jl 2>/dev/null | head -1 >/dev/null 2>&1; then echo "DETECTED: julia"; fi
if ls *.m **/*.m 2>/dev/null | head -1 >/dev/null 2>&1; then echo "DETECTED: matlab"; fi
if ls *.rs **/*.rs 2>/dev/null | head -1 >/dev/null 2>&1; then echo "DETECTED: rust"; fi
if ls *.cpp **/*.cpp 2>/dev/null | head -1 >/dev/null 2>&1; then echo "DETECTED: cpp"; fi

echo "=== DEPENDENCIES ==="
cat requirements.txt 2>/dev/null || cat pyproject.toml 2>/dev/null | head -30 || cat Project.toml 2>/dev/null | head -20 || echo "NO_DEPS_FILE"

echo "=== TEST COMMAND ==="
if [ -f pyproject.toml ] && grep -q pytest pyproject.toml 2>/dev/null; then echo "DETECTED: pytest"; fi
if [ -f Makefile ] && grep -q "test:" Makefile 2>/dev/null; then grep "test:" Makefile | head -1; fi

echo "=== EXISTING RESEARCH ==="
ls research/ 2>/dev/null || echo "NO_RESEARCH_DIR"
\`\`\`

**Step 2: Build a conventions draft from the detection results.**

Based on what was detected, draft a \`## Research conventions\` section. Fill in what was detected, leave reasonable defaults for the rest. Use this format:

\`\`\`
## Research conventions

language: <detected language, e.g. "python 3.11+">
test_command: <detected or "pytest -x">
compute_backend: local
random_seed_strategy: explicit

preferred_libraries:
  - <libraries from requirements.txt/pyproject.toml>

naming:
  experiments: snake_case
  hypotheses: snake_case

imports:
  - <detected import conventions, e.g. "numpy as np">
\`\`\`

**Step 3: Present the draft to the researcher for confirmation.**

**You MUST call the AskUserQuestion tool** with these options (do NOT just print the options as text):
- question: Show the drafted conventions and ask "Does this look right? I'll append this to CLAUDE.md."
- options: ["Looks good, save it", "Let me edit it first"]

**Step 4: Append to CLAUDE.md.**

If the researcher approves, append the conventions section to CLAUDE.md using the Edit tool. If CLAUDE.md doesn't exist, create it with the Write tool.

Then continue with the original skill workflow using the newly written conventions.`;
}

export function generateResearchLogSpec(_ctx: TemplateContext): string {
  return `## Research Log

Every experiment run MUST produce a \`research-log.json\` file alongside results.
This is non-negotiable. The research log captures everything needed to
reproduce the exact run — the trace of code, environment, and parameters that
produced these results.

**Required fields:**

\`\`\`json
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
\`\`\`

**How to generate the research log:**

\`\`\`python
import json, subprocess, sys, platform, time
from datetime import datetime, timezone
from pathlib import Path

def capture_research_log(spec_path, parameters, seeds, packages):
    log = {
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
    return log
\`\`\`

The research log generation code should be included in every generated experiment
script. After the experiment completes, fill in \`wall_clock_seconds\` and write
\`research-log.json\` to the results directory.

**Legacy compatibility:** Older experiments (pre-rename) wrote \`provenance.json\`
instead. When *reading*, fall back to \`provenance.json\` if \`research-log.json\`
does not exist. Always *write* the new name. Run \`bin/rstack-migrate-provenance\`
to rename existing files in bulk.`;
}

export function generateExperimentStructure(_ctx: TemplateContext): string {
  return `## Research File Structure

All research artifacts follow this directory convention:

\`\`\`
research/
  hypotheses/<slug>.md              # Structured hypothesis document
  experiments/<slug>/
    spec.yaml                       # Parameter grid, baselines, conventions
    run_<slug>.py                   # Generated experiment code
  results/<slug>/<timestamp>/
    metrics.json                    # Raw experiment results
    research-log.json               # Reproducibility record (see Research Log spec)
    plots/                          # Generated visualizations
  baselines/<slug>/
    metrics.json                    # Baseline results for comparison
  reports/<slug>.md                 # Final analysis report
  discussions/<slug>.md             # Timestamped discussion logs
  reviews/<slug>.md                 # Peer review documents with severity ratings
\`\`\`

**Slug convention:** lowercase, hyphens for spaces, no underscores in slugs.
Example: \`threshold-scaling\`, \`decoder-comparison\`, \`noise-model-validation\`.

**Timestamp convention:** \`YYYYMMDD-HHMMSS\` (e.g., \`20260406-231603\`).

**Before creating any files:** Check if \`research/\` exists. If not, create the
full directory structure:

\`\`\`bash
mkdir -p research/{hypotheses,experiments,results,baselines,reports,discussions,reviews}
\`\`\`

**When referencing paths:** Always use relative paths from the project root.
Never hardcode absolute paths in generated code or spec files.`;
}
