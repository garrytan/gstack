---
name: cybereum-evm-control
version: 1.0.0
description: |
  Calculates, interprets, and reports Earned Value Management (EVM) metrics for capital projects
  including CPI, SPI, TCPI, VAC, EAC, ETC, BCWS, BCWP, ACWP, and Earned Schedule. Use this skill
  for any EVM analysis, cost performance reporting, budget forecasting, AACE cost control, cost
  variance attribution, to-complete performance index analysis, or when a user mentions earned value,
  cost performance index, schedule performance index, budget at completion, estimate at completion,
  or asks about project financial health, cost burn rate, or whether a project will come in on budget.
  Also use for EVMS compliance assessment and DCAA/DoD EVMS surveillance.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
---

# Cybereum EVM Control

Earned Value Management intelligence engine for capital projects. Supports ANSI/EIA-748 EVMS compliance, AACE Cost Engineering standards, and DoD EVMS requirements. Transforms cost and schedule data into actionable performance intelligence.

---

## EVM Fundamentals -- Quick Reference

| Metric | Formula | Meaning |
|--------|---------|---------|
| **BCWS** (PV) | Budget x Planned % | What we planned to spend by now |
| **BCWP** (EV) | Budget x Earned % | Budgeted value of work actually done |
| **ACWP** (AC) | Actual cost incurred | What we actually spent |
| **CV** | BCWP - ACWP | Cost variance (positive = under budget) |
| **SV** | BCWP - BCWS | Schedule variance in $ (positive = ahead) |
| **CPI** | BCWP / ACWP | Cost efficiency (>1.0 = under budget) |
| **SPI** | BCWP / BCWS | Schedule efficiency (>1.0 = ahead of plan) |
| **EAC** | BAC / CPI | Estimate at Completion (most common) |
| **ETC** | EAC - ACWP | Estimate to Complete |
| **VAC** | BAC - EAC | Variance at Completion |
| **TCPI** | (BAC - BCWP) / (BAC - ACWP) | Required future efficiency to meet BAC |

### EAC Calculation Methods

```
Method 1 (CPI trend): EAC = BAC / CPI
Method 2 (Replan remaining): EAC = ACWP + ETC (bottom-up)
Method 3 (CPI x SPI): EAC = ACWP + [(BAC - BCWP) / (CPI x SPI)]
Method 4 (To-complete at plan): EAC = ACWP + (BAC - BCWP)
```

**Default**: Use Method 1 for stable CPI; Method 3 for schedule-constrained, cost-sensitive programs.

---

## Step 1: Data Intake

Request or accept the following inputs:

**Required:**

- BAC (Budget at Completion)
- BCWS (Planned Value at status date)
- BCWP (Earned Value at status date)
- ACWP (Actual Cost at status date)
- Status Date (data date)
- Project planned finish date

**Optional (for deeper analysis):**

- Prior period BCWP and ACWP (trend calculation)
- WBS breakdown (cost account level data)
- Contract type (CPFF, FFP, T&M, CPAF)
- Management Reserve and Contingency remaining
- Change order backlog

---

## Step 2: Performance Calculation

Compute all standard metrics. Present in a Performance Dashboard:

```
===================================================================
CYBEREUM EVM DASHBOARD -- [Project Name] -- [Status Date]
===================================================================

BUDGET BASELINE
  BAC:              $[X]M
  Management Reserve: $[X]M
  Contract Budget Base: $[X]M

CURRENT PERFORMANCE
  BCWS (PV):        $[X]M     (Plan: [X]% complete)
  BCWP (EV):        $[X]M     (Earned: [X]% complete)
  ACWP (AC):        $[X]M     (Spent to date)

VARIANCES
  Cost Variance:    $[+/-X]M    ([+/-X]%)
  Schedule Variance: $[+/-X]M   ([+/-X]%)

INDICES
  CPI:   [X.XX]    [On track / Watch / Critical]
  SPI:   [X.XX]    [On track / Watch / Critical]
  SPI(t): [X.XX]   (Earned Schedule method)

FORECAST
  EAC:   $[X]M     (Method 1: BAC/CPI)
  EAC:   $[X]M     (Method 3: CPI x SPI)
  VAC:   $[+/-X]M  ([+/-X]% of BAC)
  TCPI:  [X.XX]    [Achievable / Aggressive / Unrealistic]
===================================================================
```

---

## Step 3: Performance Interpretation

### CPI Interpretation

```
CPI > 1.10: Under budget -- verify earned value methodology
CPI 1.00-1.10: Healthy -- monitor for sustainability
CPI 0.90-1.00: Watch zone -- investigate top cost accounts
CPI 0.80-0.90: Critical -- corrective action required
CPI < 0.80: Emergency -- rebaseline likely needed
```

### TCPI Interpretation

```
TCPI < 1.00: Remaining work is easier than average to date -- realistic
TCPI 1.00-1.10: Achievable with improved efficiency
TCPI 1.10-1.20: Aggressive -- requires specific corrective actions
TCPI > 1.20: Unrealistic -- budget recovery unlikely without scope reduction or BAC revision
```

**If TCPI > 1.10:** Automatically flag and recommend Estimate at Completion revision with PMO notification.

### Earned Schedule Analysis

```
ES = Month of plan where BCWP line intersects BCWS curve
SPI(t) = ES / AT (Actual Time elapsed)
SV(t) = ES - AT (in months -- more meaningful than $ SV late in project)
IEAC(t) = PD / SPI(t) (Independent EAC in time)
```

---

## Step 4: Variance Attribution

When WBS/cost account data is available:

1. **Pareto Analysis**: Rank cost accounts by absolute cost variance. Top 20% of accounts typically drive 80% of variance.
2. **Variance root cause categories:**
   - Productivity (hours/unit above estimate)
   - Labor rate (wages above estimate)
   - Scope growth (more work than planned)
   - Quantity variance (more material than estimated)
   - Schedule-driven costs (acceleration premium, standby time)
3. **Format:**

```
WBS | Account | BAC | BCWP | ACWP | CPI | Variance $ | Root Cause
```

---

## Step 5: Trend Analysis

If multiple reporting periods are available:

**CPI Trend Chart (text-based):**

```
Period | CPI | Trend
P1     | 0.95 | --
P2     | 0.93 | down (-0.02)
P3     | 0.91 | down (-0.02)
P4     | 0.90 | stable
```

**CPI Stability Rule**: If CPI has been stable (+/-0.02) for 3+ periods, it is highly predictive of final CPI. EAC = BAC / CPI is reliable in this case.

**CPI Declining Rule**: If CPI declining >0.02/period, escalate immediately. EAC is worsening; corrective action must precede next report.

---

## Step 6: EVMS Compliance Check

For DoD/government programs requiring ANSI/EIA-748 compliance:

Assess across 5 criteria groups:

1. **Organization** (Guidelines 1-5): WBS integration, control accounts, OBS
2. **Planning & Scheduling** (Guidelines 6-14): PMB, time-phasing, undistributed budget
3. **Accounting** (Guidelines 15-22): Actual cost recording, unit of measure
4. **Analysis** (Guidelines 23-27): Variance analysis threshold, corrective actions
5. **Revisions** (Guidelines 28-32): IBR, EAC methodology, MR management

Flag any guideline with non-compliance as a surveillance finding.

---

## Standard Reporting Formats

### Monthly EVM Report Sections

1. Executive Summary (CPI, SPI, EAC vs. BAC)
2. Performance Dashboard table
3. Top 5 Cost Variance accounts with root cause
4. Trend chart (last 6 periods)
5. Corrective action status (from prior report)
6. New corrective actions this period
7. Risk-adjusted EAC range (P50/P80)

### Format Flags

- **Report for Owner**: Emphasis on EAC, VAC, milestone forecast dates
- **Report for PMO**: Full EVM metrics, variance attribution, corrective actions
- **Report for DoD/Contracting Officer**: EVMS compliance, IBR status, CAM signatures
- **Report for Board/Lenders**: Budget health summary, contingency adequacy, completion confidence

---

## Reference Files

- `references/aace-rp10s-90.md` -- AACE Total Cost Management Framework
- `references/ansi-eia-748.md` -- 32 EVMS guidelines summary
- `references/eac-methods-comparison.md` -- When to use each EAC formula
- `references/evm-sector-benchmarks.md` -- Typical CPI/SPI ranges by project type and phase

---

## EVM History & Trend Tracking

Persist EVM snapshots for automated trend analysis (adapted from retro pattern):

```bash
mkdir -p .cybereum/evm-snapshots
```

Save as `.cybereum/evm-snapshots/{project-slug}-{YYYY-MM-DD}.json`:

```json
{
  "date": "2026-03-14",
  "project": "Project Name",
  "status_date": "2026-03-10",
  "bac": 150000000,
  "bcws": 82500000,
  "bcwp": 76200000,
  "acwp": 84700000,
  "cpi": 0.90,
  "spi": 0.92,
  "spi_t": 0.89,
  "eac_method1": 166700000,
  "eac_method3": 181200000,
  "vac": -16700000,
  "tcpi": 1.13,
  "contingency_remaining": 8500000,
  "mr_remaining": 3200000,
  "top_variance_accounts": [
    { "wbs": "03.02", "name": "Civil Works", "cv": -4200000, "cpi": 0.82 },
    { "wbs": "04.01", "name": "Mechanical", "cv": -2800000, "cpi": 0.87 }
  ]
}
```

### Automated Trend Analysis

When prior snapshots exist, compute and display:

```
                    P1      P2      P3      P4 (Now)   Trend
CPI:               0.95    0.93    0.91    0.90       Declining (-0.02/period)
SPI:               0.98    0.96    0.94    0.92       Declining (-0.02/period)
EAC (M1):         $157.9  $161.3  $164.8  $166.7     Rising (+$2.9M/period)
TCPI:              1.05    1.08    1.10    1.13       Rising (approaching unrealistic)
Contingency:      $12.1M  $10.8M  $9.6M   $8.5M      Declining (-$1.2M/period)
```

**Automatic alerts:**
- CPI declining >0.02/period for 3+ periods: **SUSTAINED DECLINE -- escalate**
- TCPI > 1.10 and rising: **BUDGET RECOVERY UNLIKELY -- recommend EAC revision**
- Contingency burn rate exceeds risk-adjusted plan: **CONTINGENCY EXHAUSTION RISK**

### Compare Mode

When user requests comparison: load two snapshots and produce side-by-side delta analysis with narrative highlighting the biggest improvements and regressions.

---

## Troubleshooting

**BCWP > BCWS but CPI < 1.0**: Project is ahead of schedule but over budget. Acceleration costs are driving cost overrun despite earned value.

**CPI improving late in project**: May indicate gaming (inflating earned value) or genuine efficiency gain. Verify with physical percent complete independently.

**EAC < BAC with CPI < 1.0**: Check if replan or scope reduction occurred. Low CPI + EAC < BAC is mathematically inconsistent without a change.

**SPI approaches 1.0 near project end**: Normal -- SPI always converges to 1.0 at completion regardless of schedule overrun. Use SPI(t) for late-project schedule assessment instead.
