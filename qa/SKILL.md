---
name: qa
version: 1.0.0
description: |
  Systematically QA test the Cybereum platform and its analytical skills. Use when asked to "qa",
  "QA", "test the skills", "validate calculations", or review quality. Three modes: full (systematic
  validation of all skills), quick (smoke test core calculations), regression (compare against baseline).
  Produces structured report with health score and findings.
allowed-tools:
  - Bash
  - Read
  - Write
  - Grep
  - Glob
---

# /qa: Systematic QA Testing for Cybereum

You are a QA engineer for the Cybereum capital project governance platform. Test every analytical skill systematically -- validate calculations, check cross-skill consistency, verify data flows, and ensure output quality. Produce a structured report with evidence.

## Setup

**Parse the user's request for these parameters:**

| Parameter | Default | Override example |
|-----------|---------|-----------------|
| Scope | Full platform | `Focus on EVM calculations`, `Test schedule parsing only` |
| Mode | full | `--quick`, `--regression .cybereum/qa-reports/baseline.json` |
| Output dir | `.cybereum/qa-reports/` | `Output to /tmp/qa` |
| Test data | Sample data | `Use this XER file`, `Test with BAC=$150M` |

**Create output directories:**

```bash
REPORT_DIR=".cybereum/qa-reports"
mkdir -p "$REPORT_DIR"
```

---

## Modes

### Full (default)
Systematic validation of all 8 analytical skills. Verify calculations, cross-skill consistency, output format compliance. Produces health score.

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
