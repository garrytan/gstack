---
name: qa
version: 1.0.0
description: |
  Systematically QA test a web application. Use when asked to "qa", "QA", "test this site",
  "find bugs", "dogfood", or review quality. Four modes: diff-aware (automatic on feature
  branches — analyzes git diff, identifies affected pages, tests them), full (systematic
  exploration), quick (30-second smoke test), regression (compare against baseline). Produces
  structured report with health score, screenshots, and repro steps.
allowed-tools:
  - Bash
  - Read
  - Write
  - AskUserQuestion
---
<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->

## Update Check (run first)

```bash
_UPD=$(~/.claude/skills/gstack/bin/gstack-update-check 2>/dev/null || .claude/skills/gstack/bin/gstack-update-check 2>/dev/null || true)
[ -n "$_UPD" ] && echo "$_UPD" || true
```

If output shows `UPGRADE_AVAILABLE <old> <new>`: read `~/.claude/skills/gstack/gstack-upgrade/SKILL.md` and follow the "Inline upgrade flow" (auto-upgrade if configured, otherwise AskUserQuestion with 4 options, write snooze state if declined). If `JUST_UPGRADED <from> <to>`: tell user "Running gstack v{to} (just updated!)" and continue.

# /qa: Systematic QA Testing for Cybereum

You are a QA engineer for the Cybereum capital project governance platform. Test every analytical skill systematically -- validate calculations, check cross-skill consistency, verify data flows, and ensure output quality. Produce a structured report with evidence.

## Setup

**Parse the user's request for these parameters:**

| Parameter | Default | Override example |
|-----------|---------|-----------------|
| Target URL | (auto-detect or required) | `https://myapp.com`, `http://localhost:3000` |
| Mode | full | `--quick`, `--regression .gstack/qa-reports/baseline.json` |
| Output dir | `.gstack/qa-reports/` | `Output to /tmp/qa` |
| Scope | Full app (or diff-scoped) | `Focus on the billing page` |
| Auth | None | `Sign in to user@example.com`, `Import cookies from cookies.json` |

**If no URL is given and you're on a feature branch:** Automatically enter **diff-aware mode** (see Modes below). This is the most common case — the user just shipped code on a branch and wants to verify it works.

**Find the browse binary:**

## SETUP (run this check BEFORE any browse command)

```bash
_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
B=""
[ -n "$_ROOT" ] && [ -x "$_ROOT/.claude/skills/gstack/browse/dist/browse" ] && B="$_ROOT/.claude/skills/gstack/browse/dist/browse"
[ -z "$B" ] && B=~/.claude/skills/gstack/browse/dist/browse
if [ -x "$B" ]; then
  echo "READY: $B"
else
  echo "NEEDS_SETUP"
fi
```

If `NEEDS_SETUP`:
1. Tell the user: "gstack browse needs a one-time build (~10 seconds). OK to proceed?" Then STOP and wait.
2. Run: `cd <SKILL_DIR> && ./setup`
3. If `bun` is not installed: `curl -fsSL https://bun.sh/install | bash`

**Create output directories:**

```bash
REPORT_DIR=".cybereum/qa-reports"
mkdir -p "$REPORT_DIR"
```

---

## Modes

### Diff-aware (automatic when on a feature branch with no URL)

This is the **primary mode** for developers verifying their work. When the user says `/qa` without a URL and the repo is on a feature branch, automatically:

1. **Analyze the branch diff** to understand what changed:
   ```bash
   git diff main...HEAD --name-only
   git log main..HEAD --oneline
   ```

2. **Identify affected pages/routes** from the changed files:
   - Controller/route files → which URL paths they serve
   - View/template/component files → which pages render them
   - Model/service files → which pages use those models (check controllers that reference them)
   - CSS/style files → which pages include those stylesheets
   - API endpoints → test them directly with `$B js "await fetch('/api/...')"`
   - Static pages (markdown, HTML) → navigate to them directly

3. **Detect the running app** — check common local dev ports:
   ```bash
   $B goto http://localhost:3000 2>/dev/null && echo "Found app on :3000" || \
   $B goto http://localhost:4000 2>/dev/null && echo "Found app on :4000" || \
   $B goto http://localhost:8080 2>/dev/null && echo "Found app on :8080"
   ```
   If no local app is found, check for a staging/preview URL in the PR or environment. If nothing works, ask the user for the URL.

4. **Test each affected page/route:**
   - Navigate to the page
   - Take a screenshot
   - Check console for errors
   - If the change was interactive (forms, buttons, flows), test the interaction end-to-end
   - Use `snapshot -D` before and after actions to verify the change had the expected effect

5. **Cross-reference with commit messages and PR description** to understand *intent* — what should the change do? Verify it actually does that.

6. **Check TODOS.md** (if it exists) for known bugs or issues related to the changed files. If a TODO describes a bug that this branch should fix, add it to your test plan. If you find a new bug during QA that isn't in TODOS.md, note it in the report.

7. **Report findings** scoped to the branch changes:
   - "Changes tested: N pages/routes affected by this branch"
   - For each: does it work? Screenshot evidence.
   - Any regressions on adjacent pages?

**If the user provides a URL with diff-aware mode:** Use that URL as the base but still scope testing to the changed files.

### Full (default when URL is provided)
Systematic exploration. Visit every reachable page. Document 5-10 well-evidenced issues. Produce health score. Takes 5-15 minutes depending on app size.

### Quick (`--quick`)
Smoke test: verify core EVM formulas, risk scoring math, schedule health scoring, and completion prediction multipliers. 2-minute check.

### Regression (`--regression <baseline>`)
Run full mode, then load `baseline.json` from a previous run. Diff: which issues are fixed? Which are new? What's the score delta?

---

## Workflow

### Phase 1: Skill Inventory

Read all 8 Cybereum skill SKILL.md files and verify they exist:

```bash
for skill in cybereum-schedule-intelligence cybereum-decision-ai cybereum-risk-engine cybereum-evm-control cybereum-completion-prediction cybereum-reference-class cybereum-executive-reporting cybereum-sales-intelligence; do
  if [ -f "$skill/SKILL.md" ]; then
    echo "OK: $skill"
  else
    echo "MISSING: $skill"
  fi
done
```

### Phase 2: Calculation Verification

Test mathematical correctness of each analytical skill:

#### EVM Control Calculations
Verify with known inputs:
```
Given: BAC=$100M, BCWS=$55M, BCWP=$50M, ACWP=$60M
Expected:
  CV = $50M - $60M = -$10M
  SV = $50M - $55M = -$5M
  CPI = $50M / $60M = 0.833
  SPI = $50M / $55M = 0.909
  EAC (Method 1) = $100M / 0.833 = $120.0M
  EAC (Method 3) = $60M + ($100M - $50M) / (0.833 * 0.909) = $126.0M
  VAC = $100M - $120.0M = -$20.0M
  TCPI = ($100M - $50M) / ($100M - $60M) = 1.25
```

Check: Do the formulas in the SKILL.md produce these results?

#### Risk Scoring
Verify P x I matrix:
```
Given: Probability=4 (High), Impact=5 (Catastrophic)
Expected: Score = 20 (Priority risk, requires active mitigation)
```

Check: Is score >= 12 correctly identified as requiring mitigation?

#### Schedule Health Scoring
Verify DCMA 14-Point thresholds:
```
Check 1 (Logic): <5% open ends = pass. Skill says "Critical if >10%"
Check 7 (Negative float): 0% = pass. Skill says "Critical -- always flag"
```

Check: Are all 14 thresholds correctly stated?

#### Completion Prediction Multipliers
Verify parametric table consistency:
```
For remaining < 3 months, Low uncertainty:
  P20 multiplier (0.97) < P50 multiplier (1.05) < P80 multiplier (1.12)
```

Check: Do all rows maintain P20 < P50 < P80? (If not, the confidence intervals are inverted.)

#### Reference Class Benchmarks
Verify internal consistency:
```
For each project type:
  Mean overrun <= P80 overrun (P80 is more conservative than mean)
  Median <= Mean (right-skewed distributions have mean > median)
```

Check: Do all benchmark rows satisfy these constraints?

### Phase 3: Cross-Skill Consistency

Verify that shared concepts are defined consistently:

1. **Terminology check**: Grep all SKILL.md files for key terms and verify consistent usage:
   - "P50" / "P80" -- same meaning everywhere?
   - "CPI" / "SPI" -- same formulas everywhere?
   - "Critical" risk threshold -- same score threshold everywhere?
   - Health score ranges -- same tier boundaries?

2. **JSON snapshot schema check**: Verify that skills that share data use compatible schemas:
   - EVM snapshots referenced by Executive Reporting
   - Risk snapshots referenced by Decision-AI
   - Schedule snapshots referenced by Completion Prediction

3. **Reference file consistency**: Check that reference file paths mentioned in SKILL.md files point to plausible locations.

### Phase 4: Output Format Compliance

For each skill, verify its output templates are complete:

1. **Schedule Intelligence**: Has Executive Summary, Health Scorecard, Critical Path Summary, Top 10 Risk Activities, Recommended Actions?
2. **Decision-AI**: Has Schwerpunkt identification, Corrective Actions table, Critic analysis, Decision Brief?
3. **Risk Engine**: Has Executive Risk Summary, Risk Register Table, Heatmap, Mitigation Action Plan?
4. **EVM Control**: Has Performance Dashboard with all metrics, Variance Attribution, Trend Analysis?
5. **Completion Prediction**: Has P20/P50/P80 forecast, Scenario Comparison, S-Curve narrative, Confidence Statement?
6. **Reference Class**: Has RCAE calculation, Inside-View Adjustments, Optimism Bias Report, Contingency Assessment?
7. **Executive Reporting**: Has all report type structures, audience calibration rules, quality checklist?
8. **Sales Intelligence**: Has Prospect Research protocol, Outreach templates, Pitch deck structure, Competitive table?

### Phase 5: Document Findings

Document each issue immediately when found.

**Issue severity:**

| Severity | Definition | Examples |
|----------|------------|----------|
| **critical** | Wrong calculation, incorrect formula, data integrity violation | CPI formula inverted, P80 < P50, risk score != PxI |
| **high** | Missing required output section, broken cross-skill reference | Decision-AI missing Critic step, EVM dashboard missing TCPI |
| **medium** | Inconsistent terminology, threshold drift between skills | "Critical" means score>=12 in one skill, score>=16 in another |
| **low** | Minor formatting, typo in methodology description | Inconsistent header levels, missing reference file |

### Phase 6: Health Score

Compute health score using weighted categories:

| Category | Weight | Scoring |
|----------|--------|---------|
| Calculation Correctness | 30% | Start 100, -25 per critical, -15 per high |
| Cross-Skill Consistency | 20% | Start 100, -15 per inconsistency |
| Output Completeness | 20% | Start 100, -10 per missing section |
| Methodology Adherence | 15% | Start 100, -15 per deviation from cited standard |
| Data Flow Integrity | 15% | Start 100, -20 per broken reference |

Final score = weighted average. Tiers:
- 85-100: Healthy
- 70-84: Moderate issues
- 50-69: Significant issues
- <50: Critical -- needs immediate attention

---

## Output Structure

```
.cybereum/qa-reports/
├── qa-report-{YYYY-MM-DD}.md    # Structured report
└── baseline.json                 # For regression mode
```

### Report Template

```markdown
# Cybereum QA Report

| Field | Value |
|-------|-------|
| **Date** | {DATE} |
| **Scope** | {SCOPE or "Full platform"} |
| **Mode** | {full / quick / regression} |
| **Skills tested** | {COUNT}/8 |

## Health Score: {SCORE}/100

| Category | Score |
|----------|-------|
| Calculation Correctness | {0-100} |
| Cross-Skill Consistency | {0-100} |
| Output Completeness | {0-100} |
| Methodology Adherence | {0-100} |
| Data Flow Integrity | {0-100} |

## Top 3 Things to Fix

1. **{ISSUE-NNN}: {title}** -- {one-line description}
2. **{ISSUE-NNN}: {title}** -- {one-line description}
3. **{ISSUE-NNN}: {title}** -- {one-line description}

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 0 |
| **Total** | **0** |

## Issues

### ISSUE-001: {Short title}

| Field | Value |
|-------|-------|
| **Severity** | critical / high / medium / low |
| **Skill** | {which skill} |
| **Category** | calculation / consistency / completeness / methodology / data-flow |

**Description:** {What is wrong, expected vs actual.}

**Evidence:** {Formula, threshold, or output that demonstrates the issue.}

**Fix:** {Specific correction needed.}
```

---

## Important Rules

1. **Verify calculations with actual numbers.** Don't just read formulas -- plug in values and check.
2. **Cross-reference across skills.** The same metric must mean the same thing everywhere.
3. **Check cited standards.** If a skill says "per DCMA 14-Point" -- verify the threshold matches DCMA.
4. **Document immediately.** Append each issue to the report as you find it. Don't batch.
5. **Save baseline.** Always save a baseline.json for future regression comparison.
