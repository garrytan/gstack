# Cybereum QA Issue Taxonomy

## Severity Levels

| Severity | Definition | Examples |
|----------|------------|----------|
| **critical** | Wrong calculation output, data integrity violation, or skill produces incorrect recommendations | EVM CPI formula inverted, P80 < P50, risk score != PxI, Schwerpunkt without Critic |
| **high** | Major skill section missing or broken, cross-skill inconsistency that affects outputs | EVM dashboard missing TCPI, schedule health score uses wrong thresholds |
| **medium** | Skill works but with inconsistencies or gaps, methodology deviation | Terminology drift between skills, threshold defined differently in two places |
| **low** | Minor formatting, documentation gap, or cosmetic issue | Inconsistent header levels, missing reference file path |

## Categories

### 1. Calculation Correctness
- EVM formula errors (CPI, SPI, EAC, TCPI, VAC, CV, SV)
- Risk scoring errors (P x I matrix, contingency calculations)
- Schedule metric errors (float calculations, CPLI, BEI)
- Completion prediction errors (multiplier tables, Monte Carlo parameters)
- Reference class errors (overrun percentages, RCAE calculations)
- Division by zero in metric calculations
- Unit mismatches (working days vs calendar days, $K vs $M)

### 2. Cross-Skill Consistency
- Same metric defined differently across skills
- Threshold values that drift (e.g., "critical" score cutoff)
- JSON snapshot schemas that don't align
- Terminology inconsistency (P80 vs 80th percentile)
- Reference file paths that don't match actual locations

### 3. Methodology Compliance
- DCMA 14-Point thresholds deviating from standard
- ANSI/EIA-748 EVMS guidelines incorrectly stated
- AACE standard references that don't match source
- Flyvbjerg benchmark data that doesn't match published research
- GAO Schedule Assessment Guide criteria incorrectly applied

### 4. Output Completeness
- Missing required sections in skill output templates
- Incomplete tables (missing columns or rows)
- Output format that doesn't match the stated template
- Missing Executive Summary or Recommended Actions
- Decision Brief missing required fields

### 5. Data Flow Integrity
- Schedule data not flowing correctly to Completion Prediction
- EVM metrics not available to Executive Reporting
- Risk register not feeding Decision-AI Schwerpunkt analysis
- Snapshot persistence not saving all required fields
- Trend tracking not loading prior snapshots correctly

### 6. Industry Standard Compliance
- EVM formulas not matching ANSI/EIA-748
- Schedule checks not matching DCMA 14-Point Assessment
- Cost contingency not following AACE RP 40R-08
- Reference class methodology not following Flyvbjerg/UK Treasury
- Reporting format not following AACE RP 11R-88

## Per-Skill Validation Checklist

For each analytical skill during a QA session:

1. **Formula check** -- Plug in known values and verify outputs match expected results
2. **Threshold check** -- Verify all stated thresholds match cited industry standards
3. **Output template check** -- Verify all required output sections are present and complete
4. **Cross-reference check** -- Verify shared concepts are consistent with other skills
5. **Snapshot schema check** -- Verify JSON persistence captures all required fields
6. **Trend tracking check** -- Verify delta calculations produce correct results
7. **Edge case check** -- Test with boundary values (zero, negative, maximum)
