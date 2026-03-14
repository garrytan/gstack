---
name: cybereum-schedule-intelligence
version: 1.0.0
description: |
  Analyzes capital project schedules including P6 XER/XML files, Primavera exports, and schedule data
  for critical path analysis, float erosion, logic gaps, near-critical activity detection, and schedule
  health scoring. Use this skill whenever a user uploads or references a schedule file, mentions XER, P6,
  Primavera, CPM, critical path, activity IDs, WBS, float, or asks to review/audit/analyze a project
  schedule. Always use this skill for schedule risk, delay analysis, recovery planning, or any question
  about project timeline performance.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
---

# Cybereum Schedule Intelligence

Advanced capital project schedule analytics engine for EPC, energy, infrastructure, and defense programs. Applies temporal knowledge graph principles and construction industry best practices (DCMA 14-Point, AACE RP 49R-06, GAO Schedule Assessment Guide).

## Core Capabilities

- **Critical Path Analysis**: Identify true critical and near-critical paths (total float <= 10 days)
- **Schedule Health Scoring**: DCMA 14-Point assessment with numeric scoring
- **Float Erosion Detection**: Track float consumption trends over schedule updates
- **Logic Gap Identification**: Missing predecessors, successors, open ends, dangling activities
- **Compression Analytics**: Detect schedule compression, unrealistic durations, resource overloads
- **Milestone Variance**: Planned vs. actual milestone slippage with recovery trajectory
- **WBS Integrity Check**: Hierarchy completeness, orphaned activities, level-of-detail gaps

---

## Step 1: Ingest and Parse Schedule

When a user provides a schedule file:

- **XER files**: Parse using the xer_analyzer library pattern -- split by `%T` table delimiters, extract `TASK`, `TASKPRED`, `PROJECT`, `PROJWBS`, `RSRC` tables
- **XML/P6XML**: Navigate `<Project>`, `<Activity>`, `<Relationship>` nodes
- **CSV/Excel exports**: Map columns to standard fields (Activity ID, Name, Start, Finish, Duration, Total Float, Free Float, Predecessors, Successors)

**Key fields to extract:**

```
Activity ID | WBS Code | Activity Name | Type | Duration (OD/RD) |
ES | EF | LS | LF | Total Float | Free Float | % Complete |
Predecessor List | Successor List | Constraint Type | Constraint Date |
Calendar | Resource | Cost Account
```

**Before analysis, confirm:**

1. Data date (status date) -- required for variance calculations
2. Project planned finish vs. current forecast finish
3. Number of activities, milestones, and WBS levels

---

## Step 2: Schedule Health Assessment (DCMA 14-Point)

Run all 14 checks and score each. Report percentage failing each check.

| # | Check | Threshold | Cybereum Scoring |
|---|-------|-----------|-----------------|
| 1 | Logic (missing predecessors) | <5% open ends | Critical if >10% |
| 2 | Leads (negative lags) | 0% | Flag any |
| 3 | Lags | <5% | Review if >10% |
| 4 | Relationship types | >90% FS | Note SS/FF patterns |
| 5 | Hard constraints | <5% | Critical if >10% |
| 6 | High float (>44 days) | <5% | Review outliers |
| 7 | Negative float | 0% | Critical -- always flag |
| 8 | High duration (>44 days) | <5% | Review level of detail |
| 9 | Invalid dates | 0% | Critical |
| 10 | Resources | >90% loaded | Note unloaded critical activities |
| 11 | Missed logic | Project-specific | Review hard-constrained activities |
| 12 | Critical path length index (CPLI) | >0.95 | Flag if <0.80 |
| 13 | BEI (Baseline Execution Index) | >0.95 | Flag if <0.80 |
| 14 | Incomplete activities with actual start | N/A | Flag any |

**Output: Schedule Health Score** (0-100) with severity tier:

- 85-100: Healthy
- 70-84: Moderate Risk
- 50-69: High Risk
- <50: Critical -- Immediate Intervention Required

---

## Step 3: Critical Path and Near-Critical Analysis

1. **Identify critical path**: Activities with Total Float = 0 (or <= threshold)
2. **Near-critical band**: Activities with Float 1-10 days -- list top 20 by lowest float
3. **Critical path narrative**: Describe the end-to-end logic chain in plain language
4. **Longest path check**: Compare CPM critical path vs. longest path algorithm result
5. **Parallel critical paths**: Flag if >1 path has 0 float -- indicates schedule fragility

**Format the critical path as:**

```
[Start Milestone] -> [Engineering Phase] -> [Procurement Lead Item] ->
[Fabrication] -> [Civil/Structural] -> [Mechanical Install] ->
[Systems Completion] -> [Project Completion]
```

---

## Step 4: Risk and Anomaly Detection

Automatically flag:

- **Logic gaps**: Open-start or open-finish activities (except project start/end)
- **Constraint overuse**: Hard-constrained activities masking float
- **Resource overloads**: >100% allocation on any resource in any period
- **Spec-driven durations**: Activities with exact round-number durations (30, 60, 90 days) -- may be placeholder
- **Backward logic**: Finish-to-Start relationships with negative lag
- **Out-of-sequence progress**: Activities with % complete but no actual start date
- **Milestone logic**: Key milestones with no driving predecessor

---

## Step 5: Variance and Delay Attribution

For schedule updates (two snapshots):

1. **Slippage calculation**: Current forecast finish - Baseline finish (in working days and calendar days)
2. **Variance contributors**: Activities that slipped most -- sort by Finish Variance (days)
3. **Float erosion**: Activities where float has decreased >10 days since last update
4. **Earned Schedule**: Calculate SPI(t) = ES / AT where ES = earned schedule, AT = actual time
5. **Delay attribution categories**: Owner-caused / Contractor-caused / Force Majeure / Procurement / Design

---

## Step 6: Recovery Scenario Analysis

When asked for recovery options:

1. **Compression opportunities**: Fast-tracking candidates (FS -> SS), crashing candidates (add resources)
2. **Logic re-sequencing**: Activities that can be parallelized without technical risk
3. **Scope reduction**: Activities that could be deferred to scope relief
4. **Recovery timeline**: Model compressed duration to estimate recovery weeks
5. **Risk trade-offs**: Each recovery option rated by Cost Impact / Schedule Risk / Execution Risk

---

## Output Format

Always produce:

### Executive Summary (3-5 sentences)

- Current forecast vs. baseline finish
- Health score and primary risk
- Top recommendation

### Schedule Health Scorecard

Table of all 14 DCMA checks with pass/fail and count

### Critical Path Summary

Narrative + activity list with float values

### Top 10 Risk Activities

Ranked by float, with flags for logic issues

### Recommended Actions

Numbered list, prioritized by schedule impact

---

## Reference Files

- `references/dcma-14-point.md` -- Detailed DCMA check methodology and thresholds
- `references/aace-rp49r06.md` -- AACE schedule quality metrics
- `references/xer-parsing-guide.md` -- XER table structure and field mapping
- `references/industry-benchmarks.md` -- EPC, energy, defense schedule norms

---

## Schedule History & Trend Tracking

Persist schedule analysis results for trend comparison across updates (adapted from retro pattern):

### Save Schedule Snapshot

After each analysis, save a JSON snapshot:

```bash
mkdir -p .cybereum/schedule-snapshots
```

Save as `.cybereum/schedule-snapshots/{project-slug}-{YYYY-MM-DD}.json`:

```json
{
  "date": "2026-03-14",
  "project": "Project Name",
  "data_date": "2026-03-10",
  "health_score": 72,
  "dcma_checks": {
    "logic": { "pass": true, "pct": 3.2 },
    "leads": { "pass": true, "pct": 0 },
    "lags": { "pass": true, "pct": 2.1 }
  },
  "critical_path_length": 245,
  "near_critical_count": 18,
  "total_float_avg": 12.4,
  "negative_float_count": 0,
  "forecast_finish": "2027-06-15",
  "baseline_finish": "2027-03-01",
  "slippage_days": 76,
  "activity_count": 2400,
  "open_ends_pct": 4.1
}
```

### Trend Comparison

If prior snapshots exist, load the most recent and show deltas:

```
                    Last        Now         Delta
Health Score:       78     ->    72         -6 (declining)
Slippage:           45d    ->    76d        +31d (worsening)
Open Ends:          2.8%   ->    4.1%       +1.3pp
Near-Critical:      12     ->    18         +6 activities
Neg Float:          0      ->    0          stable
```

Flag any metric that has worsened for 3+ consecutive snapshots as a **sustained negative trend**.

---

## Two-Pass Review Protocol

Apply findings in two severity tiers (adapted from review checklist pattern):

**Pass 1 -- CRITICAL (requires immediate action):**
- Negative float on any activity
- Missing logic on critical path activities
- CPLI < 0.80
- BEI < 0.80
- Invalid dates or out-of-sequence progress

**Pass 2 -- INFORMATIONAL (monitor and address):**
- High float outliers (>44 days)
- High duration activities (>44 days)
- Lag overuse (>10%)
- Resource unloaded critical activities
- Round-number placeholder durations

Output format:
```
Schedule Review: N issues (X critical, Y informational)

**CRITICAL** (requires action):
- [Activity ID] Problem description
  Fix: suggested corrective action

**Issues** (monitoring):
- [WBS/Activity] Problem description
  Fix: suggested corrective action
```

---

## Troubleshooting

**XER won't parse**: Check file encoding (UTF-8 vs. Latin-1). Look for `%T TASK` delimiter. Some P6 exports use `\r\n` line endings.

**Float calculation mismatch**: Verify calendar assignments. Night/weekend calendars change float significantly.

**Critical path doesn't reach project end**: Check for missing successor on last activity before project finish milestone.

**Negative float with no hard constraints**: Look for out-of-sequence actual progress forcing backward calculation.
