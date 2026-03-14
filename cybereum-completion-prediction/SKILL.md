---
name: cybereum-completion-prediction
version: 1.0.0
description: |
  Generates probabilistic completion forecasts for capital projects using Monte Carlo simulation,
  S-curve modeling, and Birnbaum-Saunders distributions. Produces P20/P50/P80 completion date
  estimates with confidence intervals and recovery scenario comparisons. Use this skill whenever a
  user asks for completion probability, forecast completion date, S-curve analysis, schedule confidence,
  Monte Carlo simulation, "what is the probability we finish on time," P50 or P80 estimates, or wants
  to compare recovery scenarios on a capital project schedule or portfolio. Always use for probabilistic
  forecasting, completion confidence intervals, and risk-adjusted schedule analysis.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
---

# Cybereum Completion Prediction

Probabilistic forecasting engine for capital project completion. Applies Monte Carlo simulation and statistical modeling to transform deterministic schedule data into confidence-calibrated completion distributions.

> *"Point estimates lie. Distributions tell the truth."*

---

## Theoretical Foundation

### Why Probabilistic Forecasting?

Capital projects are inherently uncertain. A single completion date (point estimate) fails to communicate the risk profile embedded in the schedule. Cybereum's Completion Prediction engine generates:

- **P20**: 20% probability of completing by this date (optimistic scenario)
- **P50**: 50% probability -- most likely outcome (median)
- **P80**: 80% probability -- conservative/defensible commitment date

**Industry standard**: DoE, DoD, and major EPC owners use P80 for budget and schedule commitments. NSF SBIR and government programs often require P80 justification.

### Distribution Selection

- **Birnbaum-Saunders (Fatigue Life)**: Best for construction activities subject to cumulative degradation (erosion, equipment fatigue cycles)
- **Triangular**: Best for duration uncertainty where min/most likely/max can be estimated
- **Lognormal**: Best for activity durations with right-skewed uncertainty (common in EPC)
- **Beta-PERT**: Best for expert-estimated ranges; more peaked than triangular
- **Uniform**: Use only for truly unknown ranges

---

## Step 1: Input Collection

Minimum required for basic forecast:

```
Current project completion date (deterministic)
Baseline completion date
Remaining duration (working days)
Schedule confidence assessment (Low / Medium / High)
CPI (if available)
SPI (if available)
```

For full Monte Carlo:

```
Activity list (ID, Duration, Float, % Complete)
Duration uncertainty ranges (% above/below for each activity or class)
Risk register with schedule impact estimates
Number of simulations: default 10,000
```

---

## Step 2: Uncertainty Quantification

### Default Uncertainty Ranges by Project Phase and Condition

**Engineering Phase:**

```
High design maturity (IFC >80%): +/-10% duration uncertainty
Medium maturity (IFC 50-80%):    +/-20% uncertainty
Low maturity (IFC <50%):         +/-35% uncertainty
```

**Procurement Phase:**

```
Firm POs, confirmed lead times:  +/-5% uncertainty
Orders placed, preliminary leads: +/-15% uncertainty
Pending orders, estimated leads:  +/-30% uncertainty
```

**Construction Phase:**

```
Productivity factor > 0.90:     +/-15% uncertainty
Productivity factor 0.75-0.90:  +/-25% uncertainty
Productivity factor < 0.75:     +/-40% uncertainty
```

**Commissioning Phase:**

```
System completion >90%:          +/-10% uncertainty
System completion 70-90%:        +/-20% uncertainty
System completion <70%:          +/-35% uncertainty
```

---

## Step 3: Monte Carlo Simulation Logic

If running computationally (Python/JS environment available):

```python
import numpy as np

def run_monte_carlo(
    baseline_duration,    # in working days
    uncertainty_range,    # as decimal (e.g., 0.20 for +/-20%)
    risk_events,         # list of {probability, schedule_impact_days}
    n_simulations=10000,
    distribution='lognormal'
):
    results = []

    for _ in range(n_simulations):
        # Sample duration uncertainty
        if distribution == 'lognormal':
            sigma = uncertainty_range / 2
            sampled_duration = np.random.lognormal(
                mean=np.log(baseline_duration),
                sigma=sigma
            )
        elif distribution == 'triangular':
            low = baseline_duration * (1 - uncertainty_range)
            high = baseline_duration * (1 + uncertainty_range)
            sampled_duration = np.random.triangular(low, baseline_duration, high)

        # Add risk event impacts
        risk_delay = sum(
            impact for prob, impact in risk_events
            if np.random.random() < prob
        )

        results.append(sampled_duration + risk_delay)

    return {
        'P20': np.percentile(results, 20),
        'P50': np.percentile(results, 50),
        'P80': np.percentile(results, 80),
        'mean': np.mean(results),
        'std': np.std(results),
        'distribution': results
    }
```

**Without computational environment**: Use the parametric estimation table below.

---

## Step 4: Parametric Estimation (No Computation Required)

When Monte Carlo cannot be run directly, apply the Cybereum parametric table:

### Schedule Confidence Multipliers

Based on project phase, SPI, and uncertainty level:

```
Remaining     Uncertainty  P50 Multiplier  P80 Multiplier  P20 Multiplier
Duration      Level
< 3 months    Low          1.05            1.12            0.97
< 3 months    Medium       1.10            1.22            0.95
< 3 months    High         1.20            1.38            0.90
3-12 months   Low          1.08            1.18            0.96
3-12 months   Medium       1.15            1.30            0.92
3-12 months   High         1.25            1.45            0.88
> 12 months   Low          1.12            1.25            0.95
> 12 months   Medium       1.20            1.40            0.90
> 12 months   High         1.35            1.60            0.85
```

**SPI adjustment**: Multiply P50 multiplier by (1 / SPI) for projects with SPI < 0.90.

**Risk adjustment**: Add (Sum of top 5 risk impacts x probability) directly to P80 estimate.

---

## Step 5: Recovery Scenario Modeling

Generate 3 scenarios:

### Scenario A: Do Nothing (Baseline Trajectory)

Apply current SPI trend to remaining work. Project current completion date.

### Scenario B: Moderate Recovery

Apply a feasible productivity improvement (typically +10-15% from current). Identify fast-track opportunities (2-3 specific activities). Calculate new P50/P80.

### Scenario C: Aggressive Recovery

Apply maximum credible productivity improvement + resource surge + logic compression. Calculate new P50/P80. Note: Aggressive recovery typically increases cost CPI by 10-20%.

**Scenario comparison table:**

```
Scenario    | P20 Finish  | P50 Finish  | P80 Finish  | Cost Premium
Baseline    | [date]      | [date]      | [date]      | $0
Moderate    | [date]      | [date]      | [date]      | +[X]%
Aggressive  | [date]      | [date]      | [date]      | +[X]%
Target Date | N/A         | [date]      | N/A         | --
```

---

## Step 6: S-Curve Generation (Narrative)

Describe the project S-curve for the recommended scenario:

**S-Curve Phases:**

1. **Mobilization (0-15% duration)**: Slow ramp-up. Actual % complete trails plan.
2. **Peak Execution (15-75% duration)**: Steepest slope. Productivity must be maintained.
3. **Punch-out (75-100% duration)**: Deceleration. Long tail risk if commissioning issues emerge.

**Current position on S-curve**: [Describe where the project sits and what the shape implies]

**Inflection point risk**: If project is in punch-out phase, schedule risk is highest -- commissioning issues rarely resolve quickly.

---

## Step 7: Completion Confidence Statement

Produce an executive-ready forecast statement:

```
COMPLETION FORECAST -- [Project Name] -- [Status Date]

BASELINE COMPLETION: [Date]
CURRENT DETERMINISTIC FORECAST: [Date]  ([+/-X] days from baseline)

PROBABILISTIC FORECAST:
  P20 (Optimistic):    [Date]  -- 20% confidence
  P50 (Most Likely):   [Date]  -- 50% confidence <- Recommended reporting date
  P80 (Conservative):  [Date]  -- 80% confidence <- Recommended commitment date

COMPLETION ON OR BEFORE BASELINE: [X]% probability

PRIMARY SCHEDULE DRIVER: [Activity/issue driving the P80]

RECOVERY POTENTIAL: [X] days recoverable with [specific action]

CONFIDENCE BASIS: [Phase, SPI, uncertainty level, risk adjustments applied]
```

---

## Reference Files

- `references/birnbaum-saunders.md` -- BS distribution theory and capital project application
- `references/monte-carlo-methodology.md` -- Full simulation methodology with validation
- `references/recovery-playbook.md` -- Recovery strategy library by project type and phase
- `references/industry-benchmarks.md` -- Typical P50/P80 spreads by project type

---

## Forecast History & Trend Tracking

Persist completion forecasts for tracking prediction accuracy over time:

```bash
mkdir -p .cybereum/forecast-snapshots
```

Save as `.cybereum/forecast-snapshots/{project-slug}-{YYYY-MM-DD}.json`:

```json
{
  "date": "2026-03-14",
  "project": "Project Name",
  "baseline_finish": "2027-03-01",
  "deterministic_finish": "2027-06-15",
  "p20_finish": "2027-05-01",
  "p50_finish": "2027-07-10",
  "p80_finish": "2027-09-22",
  "baseline_probability": 0.08,
  "spi": 0.92,
  "uncertainty_level": "medium",
  "primary_driver": "Civil works productivity",
  "recovery_potential_days": 35,
  "scenario_selected": "moderate"
}
```

### Forecast Accuracy Tracking

When prior snapshots exist, track how predictions evolved:

```
Forecast Date  | P50 Prediction | P80 Prediction | Trend
2026-01-15     | 2027-05-20     | 2027-07-15     | --
2026-02-15     | 2027-06-01     | 2027-08-10     | Slipping (+12d / +25d)
2026-03-14     | 2027-07-10     | 2027-09-22     | Slipping (+39d / +43d)
```

**Automatic alerts:**
- P50 slipping >15 days per month for 2+ months: **SUSTAINED SCHEDULE EROSION**
- P80 exceeding contractual milestone: **CONTRACTUAL RISK -- notify stakeholders**
- Baseline probability < 10%: **BASELINE IS NOT ACHIEVABLE -- recommend rebaseline**

### Scenario Comparison Tracking

Track which recovery scenario was selected and whether the assumed improvements materialized:

```
Period    | Selected Scenario | Assumed SPI Improvement | Actual SPI | On Track?
P1        | Moderate          | +0.05                   | +0.02      | Behind
P2        | Moderate          | +0.05                   | +0.01      | Behind
P3        | Aggressive        | +0.10                   | TBD        | In progress
```

If actual improvements consistently fall short of scenario assumptions, flag as **RECOVERY PLAN NOT WORKING -- reassess strategy**.

---

## Portfolio Mode

For multiple projects, generate a portfolio completion forecast:

1. Run individual P50/P80 for each project
2. Flag projects with P80 > baseline by >30 days
3. Identify portfolio-level resource conflicts (projects competing for same resources in same period)
4. Rank projects by schedule risk severity
5. Recommend portfolio-level intervention priority
