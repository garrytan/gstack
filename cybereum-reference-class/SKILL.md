---
name: cybereum-reference-class
version: 1.0.0
description: |
  Applies Reference Class Forecasting (RCF) methodology to capital projects using historical
  outside-view benchmarks to correct optimism bias in cost and schedule estimates. Use this skill
  when a user asks about reference class forecasting, outside view, Flyvbjerg methodology, optimism
  bias, base rate, historical project benchmarks, megaproject cost overruns, schedule overrun
  percentages, how this project compares to similar projects, or wants to validate whether a project
  estimate is realistic based on industry history. Also use for nuclear, infrastructure, defense,
  transit, energy, and data center project benchmarking.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
---

# Cybereum Reference Class Forecasting

Outside-view benchmarking engine for capital project estimates. Applies Bent Flyvbjerg's Reference Class Forecasting (RCF) methodology -- now endorsed by the UK Treasury Green Book, APA, and adopted by major project owners -- to correct systematic optimism bias in project cost and schedule estimates.

> *"The inside view is always optimistic. The outside view is always closer to the truth."*
> -- Bent Flyvbjerg, Oxford Said Business School

---

## Theoretical Foundation

### The Planning Fallacy

Kahneman and Tversky identified that people systematically underestimate costs and durations when viewing projects from the "inside view" -- focusing on the specific project's plan while ignoring the base rate of similar projects.

**RCF corrects this by:**

1. Selecting a reference class of similar projects
2. Establishing the historical distribution of outcomes for that class
3. Applying the base rate to the current project
4. Adjusting for project-specific risk factors

### Why This Matters

- Average cost overrun for megaprojects (>$1B): **45%** (Flyvbjerg 2003, updated 2022)
- Average schedule overrun for megaprojects: **52%**
- Nuclear projects: Cost overrun **117%** average; schedule overrun **100%+**
- Rail/transit projects: Cost overrun **44.7%** on average
- IT/software projects: Schedule overrun **27%**; budget overrun **56%**

---

## Step 1: Reference Class Selection

**The most critical step** -- the reference class must be specific enough to be informative but broad enough to have statistical validity.

### Selection criteria:

1. **Project type**: Same type of infrastructure/facility (nuclear, refinery, hospital, transit, etc.)
2. **Delivery method**: EPC, EPCM, DBB, DB, P3
3. **Scale bracket**: Similar TIC range (+/-50% of estimated TIC)
4. **Geography**: Same or similar regulatory environment
5. **Era**: Projects completed within last 15-20 years (older data less relevant)
6. **Owner type**: Government / IOC / NOC / Private

**Reference class selection guidance by sector:**

| Project Type | Recommended Reference Class | Minimum Sample |
|---|---|---|
| Nuclear (SMR) | First-of-a-kind nuclear in Western regulatory environments | N>8 |
| Nuclear (conventional) | Large LWR projects post-2000 | N>12 |
| LNG / Petrochemical | Grassroots LNG or world-scale chemical complex | N>15 |
| Highway / Road | Interstate highway expansion, similar terrain | N>20 |
| Rail / Transit | Urban rail, commuter rail by city typology | N>15 |
| Data Center | Hyperscale data center campus | N>20 |
| Offshore Wind | Offshore wind farm >300 MW | N>12 |
| Defense Platform | DoD Major Defense Acquisition Program (MDAP) | N>15 |
| Building (complex) | Complex institutional building (hospital, lab) | N>20 |

---

## Step 2: Historical Benchmark Database

### Cost Overrun Benchmarks (% of original estimate)

```
Project Type           | Mean Overrun | Median | P80 Overrun | Worst Quartile
Nuclear (post-2010)    | +117%        | +95%   | +180%       | >200%
LNG / Petrochemical    | +35%         | +28%   | +55%        | >80%
Highway/Road           | +20%         | +15%   | +35%        | >50%
Urban Rail/Transit     | +45%         | +38%   | +65%        | >90%
Offshore Wind          | +18%         | +12%   | +32%        | >45%
Defense Acquisition    | +43%         | +32%   | +70%        | >100%
Hospitals (complex)    | +28%         | +22%   | +45%        | >65%
Data Centers (hyper.)  | +12%         | +8%    | +22%        | >35%
```

### Schedule Overrun Benchmarks (% of original schedule)

```
Project Type           | Mean Overrun | Median | P80 Overrun
Nuclear (post-2010)    | +105%        | +85%   | +165%
LNG / Petrochemical    | +30%         | +22%   | +50%
Highway/Road           | +22%         | +16%   | +38%
Urban Rail/Transit     | +52%         | +42%   | +75%
Offshore Wind          | +20%         | +15%   | +35%
Defense Acquisition    | +51%         | +40%   | +82%
Hospitals (complex)    | +32%         | +25%   | +50%
Data Centers (hyper.)  | +15%         | +10%   | +25%
```

---

## Step 3: Outside-View Estimate

Apply the reference class distribution to the current project:

### Calculate the Reference Class Adjusted Estimate (RCAE)

```
RCAE (P50 cost) = Current Estimate x (1 + Mean Reference Class Cost Overrun)
RCAE (P80 cost) = Current Estimate x (1 + P80 Reference Class Cost Overrun)
RCAE (P50 schedule) = Current Duration x (1 + Mean Reference Class Schedule Overrun)
RCAE (P80 schedule) = Current Duration x (1 + P80 Reference Class Schedule Overrun)
```

**Example (Nuclear SMR):**

```
Current Estimate: $1.2B / 72-month construction
P50 RCAE Cost:   $1.2B x 2.17 = $2.60B
P80 RCAE Cost:   $1.2B x 2.80 = $3.36B
P50 RCAE Schedule: 72 x 1.85 = 133 months
P80 RCAE Schedule: 72 x 2.65 = 191 months
```

---

## Step 4: Inside-View Adjustment (Project-Specific Factors)

Adjust the outside-view estimate up or down based on documented project-specific factors:

### Upward Risk Factors (increase estimate):

| Factor | Typical Adjustment |
|--------|-------------------|
| First-of-a-kind technology | +10-25% |
| Novel regulatory environment | +5-15% |
| Remote/difficult site | +5-20% |
| Compressed schedule mandate | +8-15% |
| Multi-contractor complexity | +5-10% |
| Political/stakeholder volatility | +5-15% |
| Emerging market location | +10-25% |

### Downward Risk Factors (decrease estimate):

| Factor | Typical Adjustment |
|--------|-------------------|
| Proven technology, NOAK | -5-15% |
| Experienced owner/PM team | -5-10% |
| Fixed-price contract (verified) | -5-10% (shifts risk, not cost) |
| Modular/prefabricated design | -5-15% |
| Favorable regulatory precedent | -3-8% |

**Final RCAE:**

```
RCAE_adjusted = RCAE_base x (1 + Sum(upward adjustments)) x (1 - Sum(downward adjustments))
```

---

## Step 5: Optimism Bias Report

Generate a structured outside-view assessment:

```
REFERENCE CLASS FORECAST -- [Project Name] -- [Date]

CURRENT ESTIMATE: $[X]M / [X] months
REFERENCE CLASS: [Specific class selected] (N=[sample size])
Source: [Flyvbjerg database / DoD DAES / GAO / RAND / McKinsey Global Institute]

OUTSIDE-VIEW RESULTS:
  P50 Cost:     $[X]M   ([+X]% above current estimate)
  P80 Cost:     $[X]M   ([+X]% above current estimate)
  P50 Schedule: [X] months   ([+X]% above current estimate)
  P80 Schedule: [X] months   ([+X]% above current estimate)

PROJECT-SPECIFIC ADJUSTMENTS:
  Upward factors:   [List] -> +[X]%
  Downward factors: [List] -> -[X]%
  Net adjustment:   [+/-X]%

ADJUSTED RCAE:
  Adjusted P50 Cost:     $[X]M
  Adjusted P80 Cost:     $[X]M
  Adjusted P50 Schedule: [X] months
  Adjusted P80 Schedule: [X] months

OPTIMISM BIAS DETECTED: [Yes/No]
  Current estimate is at the [X]th percentile of reference class outcomes.
  There is only a [X]% probability that this project completes at or below current estimate.

RECOMMENDATION:
  [Specific recommendation on estimate adequacy, contingency, schedule commitment]
```

---

## Step 6: Contingency Adequacy Assessment

Based on the RCAE:

```
Required P80 contingency = RCAE (P80) - Current Estimate
Current contingency = [User-provided]
Contingency gap = Required P80 contingency - Current contingency

Contingency adequacy rating:
  Gap <= 0:       Adequate (current contingency sufficient for P80)
  Gap 1-10%:     Marginal -- monitor closely
  Gap 10-25%:    Insufficient -- additional contingency recommended
  Gap > 25%:     Severely underestimated -- reestimate required
```

---

## Reference Files

- `references/flyvbjerg-database.md` -- Summary of Flyvbjerg's megaproject database (2,062 projects)
- `references/uk-treasury-guidance.md` -- HM Treasury Green Book RCF methodology
- `references/sector-benchmarks-detailed.md` -- Expanded benchmarks by sector, geography, era
- `references/optimism-bias-research.md` -- Academic foundation: Kahneman, Lovallo, Flyvbjerg

---

## Application Notes

**For nuclear programs**: Aalo Atomics, NuScale, and other SMR developers face FOAK risks that push cost and schedule outcomes toward the worst quartile of the nuclear reference class. Reference Class Forecasting is essential for credible investor and regulatory communication.

**For government/DoD programs**: The DoD uses Independent Cost Estimates (ICE) which implicitly apply reference class logic. Cybereum RCF aligns with GAO Schedule Assessment Guide and CAPE ICE methodology.

**Investor communication**: P80 RCAE provides a defensible, intellectually honest cost/schedule range for lender diligence, SBIR/STTR reporting, and board-level governance.
